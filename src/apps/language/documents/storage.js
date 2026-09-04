// Document storage (spec §20, §38): originals are immutable archival files,
// checksummed server-side, stored under a path built ONLY from server-generated
// identifiers — never from the user-supplied filename.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../db.js';

export const DOCUMENTS_DIR = process.env.DOCUMENTS_DIR || path.join(DATA_DIR, 'documents');
const ORIGINALS_DIR = path.join(DOCUMENTS_DIR, 'originals');

export const MAX_UPLOAD_BYTES =
  (Number(process.env.DOCUMENT_MAX_UPLOAD_MB) || 100) * 1024 * 1024;

// Supported formats (spec §27). Legacy binary Office (.doc/.xls) and
// macro-enabled containers (.docm/.xlsm) are rejected with a clear message.
export const SUPPORTED = {
  '.pdf':  { mime: 'application/pdf', kind: 'pdf' },
  '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'docx' },
  '.xlsx': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'xlsx' },
  '.csv':  { mime: 'text/csv', kind: 'csv' },
  '.txt':  { mime: 'text/plain', kind: 'txt' },
};

/** Display-safe filename: strip path separators/control chars; never used to
 *  build filesystem paths (storage keys use the document uid). */
export function safeDisplayName(name) {
  const base = String(name ?? 'document').split(/[\\/]/).pop();
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean.slice(0, 200) || 'document';
}

/** Validate the file's signature against its claimed extension — extensions
 *  and browser MIME types are not trusted alone (spec §38). */
export function validateSignature(ext, buf) {
  if (ext === '.pdf') return buf.subarray(0, 5).toString('latin1').startsWith('%PDF');
  if (ext === '.docx' || ext === '.xlsx') return buf[0] === 0x50 && buf[1] === 0x4b; // ZIP "PK"
  if (ext === '.csv' || ext === '.txt') return !buf.subarray(0, 4096).includes(0); // no NUL bytes
  return false;
}

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

/** Move an uploaded temp file into immutable original storage.
 *  Key shape: originals/<document-uid>/original<ext> */
export function storeOriginal(tmpPath, documentUid, ext) {
  const dir = path.join(ORIGINALS_DIR, documentUid);
  fs.mkdirSync(dir, { recursive: true });
  const storageKey = path.posix.join('originals', documentUid, `original${ext}`);
  fs.renameSync(tmpPath, path.join(DOCUMENTS_DIR, storageKey));
  return storageKey;
}

/** Absolute path for a stored key — refuses anything outside DOCUMENTS_DIR. */
export function absolutePath(storageKey) {
  const abs = path.resolve(DOCUMENTS_DIR, storageKey);
  if (!abs.startsWith(path.resolve(DOCUMENTS_DIR))) throw new Error('Bad storage key');
  return abs;
}

export function removeOriginal(storageKey) {
  fs.rmSync(path.dirname(absolutePath(storageKey)), { recursive: true, force: true });
}
