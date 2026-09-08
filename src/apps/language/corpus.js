// Default Language collection (flat-collection spec §5/§29): every
// Language-enabled organization has exactly one default corpus, derived — not
// user-selected. This is the ONE canonical resolver; nothing else may guess
// with `LIMIT 1`. The corpora table stays: the default flag is the escape
// hatch for real multi-collection needs later.
import { uuidv7 } from '../../platform/uid.js';

export const DEFAULT_COLLECTION_NAME = 'Language Collection';

/** Pick which of an org's existing corpora should be default: the one with
 *  the most content, ties broken by age (lowest id). Deterministic — the
 *  migration backfill and the runtime self-heal must always agree. */
export function pickDefaultCorpus(db, organizationId) {
  return db.prepare(
    `SELECT c.id,
            (SELECT COUNT(*) FROM entries e WHERE e.corpus_id = c.id) +
            (SELECT COUNT(*) FROM documents d WHERE d.corpus_id = c.id) AS content
     FROM corpora c WHERE c.organization_id = ?
     ORDER BY content DESC, c.id ASC LIMIT 1`
  ).get(organizationId) ?? null;
}

/** The organization's default Language corpus — creating or marking one when
 *  missing, so the invariant holds even for orgs that predate the flag. */
export function defaultCorpusFor(db, organizationId) {
  const existing = db.prepare(
    'SELECT * FROM corpora WHERE organization_id = ? AND is_default = 1'
  ).get(organizationId);
  if (existing) return existing;

  const pick = pickDefaultCorpus(db, organizationId);
  if (pick) {
    // Corpora exist but none is flagged (pre-migration org, or flag lost):
    // self-heal with the same deterministic rule the migration used.
    db.prepare('UPDATE corpora SET is_default = 1 WHERE id = ?').run(pick.id);
    console.log(`[corpus] marked corpus ${pick.id} default for organization ${organizationId}`);
    return db.prepare('SELECT * FROM corpora WHERE id = ?').get(pick.id);
  }

  const id = db.prepare(
    `INSERT INTO corpora (uid, organization_id, name, is_default) VALUES (?, ?, ?, 1)`
  ).run(uuidv7(), organizationId, DEFAULT_COLLECTION_NAME).lastInsertRowid;
  console.log(`[corpus] created default collection for organization ${organizationId}`);
  return db.prepare('SELECT * FROM corpora WHERE id = ?').get(id);
}
