// Ingestion worker (spec §24–§26, §75): a lightweight in-process loop over the
// DB-backed job queue. Claims are atomic (single UPDATE…RETURNING), a job
// never runs twice concurrently, failures record their error with bounded
// retries, and stale 'running' jobs (crashed process) are requeued after a
// timeout. Uploads never wait on this.
import db from '../../../db.js';
import { uuidv7 } from '../../../platform/uid.js';
import { extractDocument } from './extractors/index.js';
import { semanticIndexVersion, markSemanticFailed } from './semantic.js';
import { absolutePath, SUPPORTED } from './storage.js';

const MAX_ATTEMPTS = Number(process.env.DOCUMENT_JOB_MAX_ATTEMPTS) || 3;
const STALE_MINUTES = Number(process.env.DOCUMENT_JOB_STALE_MINUTES) || 15;
const POLL_MS = 2000;

const setDocStatus = (docId, status, error = null) =>
  db.prepare(`UPDATE documents SET status = ?, error_message = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, error, docId);

function claimJob() {
  return db.prepare(
    `UPDATE ingestion_jobs
     SET status = 'running', started_at = datetime('now'), attempts = attempts + 1
     WHERE id = (SELECT id FROM ingestion_jobs WHERE status = 'queued' ORDER BY queued_at, id LIMIT 1)
     RETURNING *`
  ).get();
}

function recoverStaleJobs() {
  // Crashed mid-run: requeue (bounded), or fail permanently past the limit.
  db.prepare(
    `UPDATE ingestion_jobs SET status = 'queued'
     WHERE status = 'running' AND attempts < ? AND started_at < datetime('now', ?)`
  ).run(MAX_ATTEMPTS, `-${STALE_MINUTES} minutes`);
  const dead = db.prepare(
    `UPDATE ingestion_jobs SET status = 'failed', completed_at = datetime('now'),
       error_message = COALESCE(error_message, 'abandoned after crash')
     WHERE status = 'running' AND attempts >= ? AND started_at < datetime('now', ?)
     RETURNING document_version_id, job_type`
  ).all(MAX_ATTEMPTS, `-${STALE_MINUTES} minutes`);
  for (const j of dead) {
    if (j.job_type === 'semantic_index') {
      markSemanticFailed(j.document_version_id, 'Semantic indexing was interrupted too many times');
      continue; // the document itself stays ready (spec §15)
    }
    const v = db.prepare('SELECT document_id FROM document_versions WHERE id = ?').get(j.document_version_id);
    if (v) setDocStatus(v.document_id, 'failed', 'Processing was interrupted too many times');
  }
}

async function runJob(job) {
  const version = db.prepare('SELECT * FROM document_versions WHERE id = ?').get(job.document_version_id);
  if (!version) throw new Error('document version disappeared');
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(version.document_id);
  if (!doc || doc.status === 'archived') return; // archived mid-flight: drop silently

  if (job.job_type === 'extract') {
    setDocStatus(doc.id, 'extracting');
    const kind = SUPPORTED[doc.extension]?.kind;
    const started = Date.now();
    const { metadata, blocks } = await extractDocument({
      filePath: absolutePath(version.storage_key),
      kind,
    });
    const insert = db.prepare(
      `INSERT INTO document_blocks (uid, document_version_id, ordinal, block_type, text,
         page_number, sheet_name, row_number, column_name, location_json, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.transaction(() => {
      db.prepare('DELETE FROM document_blocks WHERE document_version_id = ?').run(version.id);
      for (const b of blocks) {
        insert.run(uuidv7(), version.id, b.ordinal, b.blockType, b.text,
          b.pageNumber ?? null, b.sheetName ?? null, b.rowNumber ?? null, b.columnName ?? null,
          b.location ? JSON.stringify(b.location) : null,
          b.metadata ? JSON.stringify(b.metadata) : null);
      }
      db.prepare('UPDATE document_versions SET extraction_json = ? WHERE id = ?')
        .run(JSON.stringify(metadata), version.id);
      db.prepare(`INSERT INTO ingestion_jobs (document_version_id, job_type) VALUES (?, 'index')`).run(version.id);
    })();
    setDocStatus(doc.id, 'indexing');
    console.log(`[documents] extracted ${doc.uid} (${doc.extension}): ${blocks.length} blocks in ${Date.now() - started}ms`);
  } else if (job.job_type === 'index') {
    // FTS rows are kept in sync by triggers as blocks are written; this stage
    // merges the index so first searches are fast, then flips to ready.
    // Semantic indexing runs AFTER ready and never gates it (spec §15/§16).
    db.exec(`INSERT INTO document_blocks_fts(document_blocks_fts) VALUES ('optimize')`);
    db.transaction(() => {
      setDocStatus(doc.id, 'ready');
      db.prepare(`INSERT INTO ingestion_jobs (document_version_id, job_type) VALUES (?, 'semantic_index')`)
        .run(version.id);
    })();
    console.log(`[documents] indexed ${doc.uid} — ready`);
  } else if (job.job_type === 'semantic_index') {
    const { chunks, embedded, reused } = await semanticIndexVersion(version.id);
    console.log(`[documents] semantic-indexed ${doc.uid}: ${chunks} chunks (${embedded} embedded, ${reused} reused)`);
  }
}

async function tick() {
  recoverStaleJobs();
  for (;;) {
    const job = claimJob();
    if (!job) return;
    try {
      await runJob(job);
      db.prepare(`UPDATE ingestion_jobs SET status = 'completed', completed_at = datetime('now') WHERE id = ?`)
        .run(job.id);
    } catch (err) {
      const retriable = job.attempts < MAX_ATTEMPTS;
      db.prepare(
        `UPDATE ingestion_jobs SET status = ?, error_message = ?, completed_at = datetime('now') WHERE id = ?`
      ).run(retriable ? 'queued' : 'failed', String(err.message).slice(0, 500), job.id);
      if (!retriable) {
        // Semantic failure marks only the VERSION's semantic state — the
        // document itself stays ready/searchable by keyword (spec §15).
        if (job.job_type === 'semantic_index') {
          markSemanticFailed(job.document_version_id, err.message);
        } else {
          const v = db.prepare('SELECT document_id FROM document_versions WHERE id = ?').get(job.document_version_id);
          if (v) setDocStatus(v.document_id, 'failed', String(err.message).slice(0, 500));
        }
      }
      console.error(`[documents] job ${job.id} (${job.job_type}) failed (attempt ${job.attempts}):`, err.message);
      if (retriable) return; // back off until the next tick
    }
  }
}

let timer = null;
export function startDocumentWorker() {
  if (timer) return;
  timer = setInterval(() => { tick().catch((e) => console.error('[documents] worker tick failed:', e.message)); }, POLL_MS);
  timer.unref?.(); // never keep the process alive just for the poller
  console.log('[documents] ingestion worker started');
}
