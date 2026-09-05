// Document semantic indexing (master-search spec §13–§18): builds
// document_search_chunks from extracted blocks and embeds them with the
// existing local model. Chunks are disposable derivatives — the original
// bytes and document_blocks remain authoritative — and every chunk resolves
// back to a source location (page / sheet+row / block range).
//
// Chunking (spec §14): spreadsheets get one chunk per logical row WITH
// column context ("English: fish\nDene: łue"), PDFs one chunk per page
// (long pages split), DOCX/TXT group a heading with its nearby paragraphs
// up to a target size. Target ≈ 100–200 words.
import crypto from 'node:crypto';
import db from '../../../db.js';
import { embed, toBlob, MODEL } from '../../../embed.js';
import { uuidv7 } from '../../../platform/uid.js';

const TARGET_WORDS = 150;
const MAX_WORDS = 220;

const hash = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const wordCount = (t) => t.split(/\s+/).filter(Boolean).length;

/** Split an oversized text into ~TARGET_WORDS pieces on word boundaries. */
function splitLong(text) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= MAX_WORDS) return [text.trim()].filter(Boolean);
  const parts = [];
  for (let i = 0; i < words.length; i += TARGET_WORDS) {
    parts.push(words.slice(i, i + TARGET_WORDS).join(' '));
  }
  return parts;
}

/** Pure: ordered document_blocks rows -> chunk descriptors. */
export function buildChunks(blocks) {
  const chunks = [];
  const add = (text, first, last, { pageNumber = null, sheetName = null, rowNumber = null } = {}) => {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return;
    chunks.push({
      ordinal: chunks.length + 1,
      firstBlockId: first?.id ?? null,
      lastBlockId: last?.id ?? null,
      text: trimmed,
      contentHash: hash(trimmed),
      pageNumber,
      sheetName,
      rowNumber,
      location: { page: pageNumber, sheet: sheetName, row: rowNumber },
    });
  };

  // Running group for prose blocks (DOCX heading+paragraphs, TXT paragraphs).
  let group = null;
  const flush = () => {
    if (!group) return;
    const text = group.texts.join('\n\n');
    for (const part of splitLong(text)) add(part, group.first, group.last, { pageNumber: group.page });
    group = null;
  };

  for (const b of blocks) {
    if (b.block_type === 'sheet_row') {
      flush();
      // One logical row per chunk, with column context (spec §14).
      const cells = b.metadata_json ? (JSON.parse(b.metadata_json).cells ?? {}) : {};
      const text = Object.entries(cells)
        .filter(([, v]) => String(v ?? '').trim())
        .map(([k, v]) => `${k}: ${String(v).trim()}`)
        .join('\n') || b.text;
      add(text, b, b, { sheetName: b.sheet_name, rowNumber: b.row_number });
    } else if (b.block_type === 'page_text') {
      flush();
      for (const part of splitLong(b.text)) add(part, b, b, { pageNumber: b.page_number });
    } else {
      // heading | paragraph: a heading starts a fresh chunk group and stays
      // with the paragraphs that follow it.
      if (b.block_type === 'heading') flush();
      if (!group) group = { texts: [], first: b, last: b, page: b.page_number ?? null };
      group.texts.push(b.text);
      group.last = b;
      if (wordCount(group.texts.join(' ')) >= TARGET_WORDS) flush();
    }
  }
  flush();
  return chunks;
}

const setState = (versionId, fields) => {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE document_versions SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...cols.map((c) => fields[c]), versionId);
};

/** Rebuild + embed the chunks for one document version. Idempotent:
 *  unchanged text re-uses its existing current-model embedding by
 *  content_hash, so reprocess/backfill only pays for what changed.
 *  Returns { chunks, embedded, reused }. Throws on embed failure — the
 *  caller records semantic_status='failed' WITHOUT touching the document's
 *  own status (spec §15). */
export async function semanticIndexVersion(versionId) {
  const version = db.prepare('SELECT * FROM document_versions WHERE id = ?').get(versionId);
  if (!version) throw new Error('document version disappeared');
  setState(versionId, { semantic_status: 'indexing', semantic_error: null });

  const blocks = db.prepare(
    'SELECT * FROM document_blocks WHERE document_version_id = ? ORDER BY ordinal'
  ).all(versionId);
  const chunks = buildChunks(blocks);

  // Salvage current-model embeddings for unchanged text before the rebuild.
  const existing = new Map(
    db.prepare(
      `SELECT content_hash, embedding FROM document_search_chunks
       WHERE document_version_id = ? AND embedding IS NOT NULL AND embedding_model = ?`
    ).all(versionId, MODEL).map((r) => [r.content_hash, r.embedding])
  );

  const insert = db.prepare(
    `INSERT INTO document_search_chunks (uid, document_version_id, ordinal, first_block_id,
       last_block_id, text, content_hash, page_number, sheet_name, row_number, location_json,
       embedding, embedding_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let reused = 0;
  db.transaction(() => {
    db.prepare('DELETE FROM document_search_chunks WHERE document_version_id = ?').run(versionId);
    for (const c of chunks) {
      const prior = existing.get(c.contentHash);
      if (prior) reused++;
      insert.run(uuidv7(), versionId, c.ordinal, c.firstBlockId, c.lastBlockId,
        c.text, c.contentHash, c.pageNumber, c.sheetName, c.rowNumber,
        JSON.stringify(c.location), prior ?? null, prior ? MODEL : null);
    }
  })();

  // Embed what's missing, one row at a time (interrupt-safe: committed rows
  // keep their vectors; a rerun picks up the remainder).
  const pending = db.prepare(
    `SELECT id, text FROM document_search_chunks
     WHERE document_version_id = ? AND embedding IS NULL ORDER BY ordinal`
  ).all(versionId);
  const store = db.prepare(
    `UPDATE document_search_chunks SET embedding = ?, embedding_model = ?, updated_at = datetime('now') WHERE id = ?`
  );
  for (const c of pending) {
    const vec = await embed(c.text);
    store.run(toBlob(vec), MODEL, c.id);
  }

  setState(versionId, {
    semantic_status: 'ready',
    semantic_model: MODEL,
    semantic_indexed_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    semantic_error: null,
  });
  return { chunks: chunks.length, embedded: pending.length, reused };
}

/** Record a semantic failure on the version — never on the document. */
export function markSemanticFailed(versionId, message) {
  setState(versionId, { semantic_status: 'failed', semantic_error: String(message).slice(0, 500) });
}
