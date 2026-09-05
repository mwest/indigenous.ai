// Documents service (spec §36, §46, §47): creation, listing, detail, blocks,
// search, reprocess, archive/restore, delete. Routes in api.js do the
// authorization (corpus -> organization -> entitlement + role) and call in
// here; this module owns the data behavior.
import db from '../../../db.js';
import { uuidv7 } from '../../../platform/uid.js';
import {
  MAX_UPLOAD_BYTES, SUPPORTED, safeDisplayName, sha256File, storeOriginal,
  validateSignature, absolutePath, removeOriginal,
} from './storage.js';
import fs from 'node:fs';
import path from 'node:path';

export { MAX_UPLOAD_BYTES, SUPPORTED, absolutePath };

export function documentById(id) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
}

export function currentVersion(documentId) {
  return db
    .prepare('SELECT * FROM document_versions WHERE document_id = ? ORDER BY version_number DESC LIMIT 1')
    .get(documentId);
}

/** Create a document from an uploaded temp file. Validates format/signature,
 *  checksums server-side, stores the immutable original, and queues
 *  extraction. Returns { document } or { error, status?, existing? }. */
export async function createDocument({ tmpPath, originalName, corpusId, originProjectId, title, userId }) {
  const ext = path.extname(originalName ?? '').toLowerCase();
  const format = SUPPORTED[ext];
  if (!format) {
    fs.rmSync(tmpPath, { force: true });
    return { error: `Unsupported format "${ext || 'unknown'}" — supported: PDF, Word (.docx), Excel (.xlsx), CSV, TXT` };
  }
  const stat = fs.statSync(tmpPath);
  if (stat.size > MAX_UPLOAD_BYTES) {
    fs.rmSync(tmpPath, { force: true });
    return { error: `File too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB)` };
  }
  const head = Buffer.alloc(Math.min(8192, stat.size));
  const fd = fs.openSync(tmpPath, 'r');
  fs.readSync(fd, head, 0, head.length, 0);
  fs.closeSync(fd);
  if (!validateSignature(ext, head)) {
    fs.rmSync(tmpPath, { force: true });
    return { error: 'The file does not look like its extension claims — upload the original file' };
  }
  const sha256 = await sha256File(tmpPath);
  // Duplicate behavior (spec §19): the same bytes in the same corpus are not
  // silently duplicated (uniqueness is per-corpus, never cross-organization).
  const dup = db
    .prepare(`SELECT id, uid, title, status FROM documents WHERE corpus_id = ? AND sha256 = ? AND status <> 'archived'`)
    .get(corpusId, sha256);
  if (dup) {
    fs.rmSync(tmpPath, { force: true });
    return { error: 'This exact file is already in the collection', status: 409, existing: dup };
  }

  const docUid = uuidv7();
  const displayName = safeDisplayName(originalName);
  const storageKey = storeOriginal(tmpPath, docUid, ext);
  const document = db.transaction(() => {
    const docId = db.prepare(
      `INSERT INTO documents (uid, corpus_id, origin_project_id, title, original_filename,
         mime_type, extension, size_bytes, sha256, status, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', ?)`
    ).run(docUid, corpusId, originProjectId ?? null,
          (title ?? '').trim() || displayName, displayName,
          format.mime, ext, stat.size, sha256, userId).lastInsertRowid;
    const versionId = db.prepare(
      `INSERT INTO document_versions (uid, document_id, version_number, original_filename,
         storage_key, mime_type, size_bytes, sha256, uploaded_by)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`
    ).run(uuidv7(), docId, displayName, storageKey, format.mime, stat.size, sha256, userId).lastInsertRowid;
    db.prepare(`INSERT INTO ingestion_jobs (document_version_id, job_type) VALUES (?, 'extract')`).run(versionId);
    return db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
  })();
  console.log(`[documents] uploaded ${document.uid} (${ext}, ${stat.size} bytes) into corpus ${corpusId}`);
  return { document };
}

export const TYPE_LABEL = { '.pdf': 'PDF', '.docx': 'Word', '.xlsx': 'Excel', '.csv': 'CSV', '.txt': 'Text' };

export function listDocuments({ corpusId, q, status, type, limit = 50, offset = 0 }) {
  const where = ['d.corpus_id = ?'];
  const params = [corpusId];
  if (status) { where.push('d.status = ?'); params.push(status); }
  else { where.push(`d.status <> 'archived'`); }
  if (type) { where.push('d.extension = ?'); params.push(type.startsWith('.') ? type : `.${type}`); }
  let matchJoin = '';
  if (q) {
    // Keyword match against extracted blocks OR the title/filename.
    where.push(`(d.title LIKE ? OR d.original_filename LIKE ? OR EXISTS (
      SELECT 1 FROM document_versions v JOIN document_blocks b ON b.document_version_id = v.id
      JOIN document_blocks_fts f ON f.rowid = b.id
      WHERE v.document_id = d.id AND document_blocks_fts MATCH ?))`);
    params.push(`%${q}%`, `%${q}%`, ftsQuery(q));
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) n FROM documents d ${whereSql}`).get(...params).n;
  const documents = db.prepare(
    `SELECT d.*, u.name AS uploaded_by_name,
            (SELECT COUNT(*) FROM document_versions v JOIN document_blocks b ON b.document_version_id = v.id
              WHERE v.document_id = d.id) AS block_count
     FROM documents d JOIN users u ON u.id = d.uploaded_by
     ${whereSql} ORDER BY d.created_at DESC, d.id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset)
    .map((d) => ({ ...d, type_label: TYPE_LABEL[d.extension] ?? d.extension }));
  // With a query, attach one best excerpt per document (spec §39).
  if (q) {
    for (const d of documents) {
      const hit = searchBlocks({ q, documentId: d.id, limit: 1 })[0];
      if (hit) d.excerpt = { snippet: hit.snippet, page_number: hit.page_number, sheet_name: hit.sheet_name, row_number: hit.row_number };
    }
  }
  return { documents, total, limit, offset };
}

/** Escape an FTS5 query: quote each term so user input is never FTS syntax. */
function ftsQuery(q) {
  return String(q).split(/\s+/).filter(Boolean).slice(0, 12)
    .map((t) => `"${t.replaceAll('"', '""')}"`).join(' ');
}

export function searchBlocks({ q, corpusId, documentId, limit = 25, offset = 0 }) {
  const params = [ftsQuery(q)];
  let scope = '';
  if (documentId) { scope = 'AND v.document_id = ?'; params.push(documentId); }
  else if (corpusId) { scope = `AND d.corpus_id = ? AND d.status <> 'archived'`; params.push(corpusId); }
  return db.prepare(
    `SELECT d.id AS document_id, d.uid AS document_uid, d.title, d.extension,
            b.id AS block_id, b.block_type, b.page_number, b.sheet_name, b.row_number, b.ordinal,
            snippet(document_blocks_fts, 0, '[', ']', ' … ', 12) AS snippet,
            rank
     FROM document_blocks_fts f
     JOIN document_blocks b ON b.id = f.rowid
     JOIN document_versions v ON v.id = b.document_version_id
     JOIN documents d ON d.id = v.document_id
     WHERE document_blocks_fts MATCH ? ${scope}
     ORDER BY rank LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
}

export function listBlocks({ documentId, page, sheet, limit = 100, offset = 0 }) {
  const version = currentVersion(documentId);
  if (!version) return { blocks: [], total: 0, limit, offset };
  const where = ['document_version_id = ?'];
  const params = [version.id];
  if (page) { where.push('page_number = ?'); params.push(Number(page)); }
  if (sheet) { where.push('sheet_name = ?'); params.push(String(sheet)); }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) n FROM document_blocks ${whereSql}`).get(...params).n;
  const blocks = db.prepare(
    `SELECT id, ordinal, block_type, text, page_number, sheet_name, row_number, location_json, metadata_json
     FROM document_blocks ${whereSql} ORDER BY ordinal LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  return { blocks, total, limit, offset };
}

/** Reprocess (spec §47): rebuild derived data for the current version.
 *  Original bytes, sha256, uploader and created_at are untouched. */
export function reprocessDocument(documentId) {
  const version = currentVersion(documentId);
  if (!version) return false;
  db.transaction(() => {
    db.prepare('DELETE FROM document_blocks WHERE document_version_id = ?').run(version.id);
    db.prepare(`DELETE FROM ingestion_jobs WHERE document_version_id = ? AND status IN ('queued', 'running')`).run(version.id);
    db.prepare(`INSERT INTO ingestion_jobs (document_version_id, job_type) VALUES (?, 'extract')`).run(version.id);
    db.prepare(`UPDATE documents SET status = 'uploaded', error_message = NULL, updated_at = datetime('now') WHERE id = ?`)
      .run(documentId);
  })();
  console.log(`[documents] reprocess requested for document ${documentId}`);
  return true;
}

export function setArchived(documentId, archived) {
  db.prepare(`UPDATE documents SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(archived ? 'archived' : 'ready', documentId);
}

/** Hard delete (spec §46): refused while entries reference the document —
 *  provenance survives through archive, not deletion. */
export function deleteDocument(documentId) {
  const links = db.prepare('SELECT COUNT(*) n FROM entry_document_sources WHERE document_id = ?').get(documentId).n;
  if (links > 0) {
    return { error: `${links} entr${links === 1 ? 'y' : 'ies'} cite this document as their source — archive it instead of deleting` };
  }
  const versions = db.prepare('SELECT storage_key FROM document_versions WHERE document_id = ?').all(documentId);
  db.prepare('DELETE FROM documents WHERE id = ?').run(documentId);
  for (const v of versions) {
    try { removeOriginal(v.storage_key); } catch { /* best effort */ }
  }
  console.log(`[documents] deleted document ${documentId}`);
  return { ok: true };
}

/** Detail payload (spec §36). */
export function documentDetail(doc, canManage) {
  const version = currentVersion(doc.id);
  const extraction = version?.extraction_json ? JSON.parse(version.extraction_json) : null;
  const blockCount = version
    ? db.prepare('SELECT COUNT(*) n FROM document_blocks WHERE document_version_id = ?').get(version.id).n
    : 0;
  return {
    ...doc,
    type_label: TYPE_LABEL[doc.extension] ?? doc.extension,
    version: version && {
      id: version.id, uid: version.uid, version_number: version.version_number,
      size_bytes: version.size_bytes, sha256: version.sha256, created_at: version.created_at,
    },
    extraction,
    block_count: blockCount,
    linked_entry_count: db.prepare('SELECT COUNT(*) n FROM entry_document_sources WHERE document_id = ?').get(doc.id).n,
    can_manage: !!canManage,
  };
}
