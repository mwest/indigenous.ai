// Semantic-index backfill for documents (master-search spec §18): builds and
// embeds document_search_chunks for every current version of a ready,
// non-archived document that is missing chunks, has stale-model embeddings,
// or previously failed. Idempotent and interrupt-safe — unchanged chunk text
// re-uses its committed embedding by content hash, so a rerun only pays for
// what's missing. Prints counts, never document content.
//
//   node scripts/document-embed-backfill.js
//
// Production (Fly): scripts/prod-ssh.sh "cd /app && node scripts/document-embed-backfill.js"
import db from '../src/db.js';
import { MODEL } from '../src/embed.js';
import { semanticIndexVersion } from '../src/apps/language/documents/semantic.js';

const targets = db.prepare(
  `SELECT d.uid, d.extension, v.id AS version_id, v.semantic_status, v.semantic_model
   FROM documents d
   JOIN document_versions v ON v.document_id = d.id
   WHERE d.status = 'ready'
     AND v.version_number = (SELECT MAX(v2.version_number) FROM document_versions v2
                             WHERE v2.document_id = d.id)
   ORDER BY d.id`
).all();

const needsWork = (t) => {
  if (t.semantic_status !== 'ready' || t.semantic_model !== MODEL) return true;
  // Ready with the current model — but verify no chunk is missing or stale.
  const stale = db.prepare(
    `SELECT COUNT(*) n FROM document_search_chunks
     WHERE document_version_id = ? AND (embedding IS NULL OR embedding_model IS NOT ?)`
  ).get(t.version_id, MODEL).n;
  return stale > 0;
};

let done = 0, skipped = 0, failed = 0;
for (const t of targets) {
  if (!needsWork(t)) { skipped++; continue; }
  try {
    const { chunks, embedded, reused } = await semanticIndexVersion(t.version_id);
    console.log(`[backfill] ${t.uid} (${t.extension}): ${chunks} chunks, ${embedded} embedded, ${reused} reused`);
    done++;
  } catch (e) {
    const { markSemanticFailed } = await import('../src/apps/language/documents/semantic.js');
    markSemanticFailed(t.version_id, e.message);
    console.error(`[backfill] ${t.uid} FAILED: ${e.message}`);
    failed++;
  }
}
console.log(`[backfill] ${targets.length} ready documents: ${done} indexed, ${skipped} already current, ${failed} failed`);
process.exit(failed ? 1 : 0);
