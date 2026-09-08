// 009_default_collection: one default Language collection per organization
// (flat-collection spec §5/§6/§26). The corpora table and all existing
// relationships stay — the default flag makes the corpus an implementation
// detail the UI derives from the active organization.
//
// Backfill, conservatively:
//   exactly one corpus  -> it becomes default (no data changes)
//   zero corpora        -> create a default for Language-enabled orgs
//   multiple corpora    -> flag the one with the most content (ties: oldest);
//                          the others are NEVER merged or deleted here —
//                          consolidation is a deliberate admin act
//                          (scripts/merge-corpora.js), and each ambiguous org
//                          is surfaced in the migration log.

export function up(db) {
  db.exec(`ALTER TABLE corpora ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0`);
  db.exec(`CREATE UNIQUE INDEX idx_corpora_one_default_per_org
           ON corpora(organization_id) WHERE is_default = 1`);

  const orgs = db.prepare('SELECT id, name FROM organizations').all();
  const uid = () => {
    // Inline UUIDv7 (migrations must not import app code that may drift).
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    const ms = BigInt(Date.now());
    b[0] = Number((ms >> 40n) & 0xffn); b[1] = Number((ms >> 32n) & 0xffn);
    b[2] = Number((ms >> 24n) & 0xffn); b[3] = Number((ms >> 16n) & 0xffn);
    b[4] = Number((ms >> 8n) & 0xffn); b[5] = Number(ms & 0xffn);
    b[6] = (b[6] & 0x0f) | 0x70; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };

  for (const org of orgs) {
    const corpora = db.prepare(
      `SELECT c.id,
              (SELECT COUNT(*) FROM entries e WHERE e.corpus_id = c.id) +
              (SELECT COUNT(*) FROM documents d WHERE d.corpus_id = c.id) AS content
       FROM corpora c WHERE c.organization_id = ?
       ORDER BY content DESC, c.id ASC`
    ).all(org.id);
    if (corpora.length === 0) {
      const enabled = db.prepare(
        `SELECT 1 FROM organization_apps WHERE organization_id = ? AND app_code = 'language' AND status = 'enabled'`
      ).get(org.id);
      if (enabled) {
        db.prepare(`INSERT INTO corpora (uid, organization_id, name, is_default) VALUES (?, ?, 'Language Collection', 1)`)
          .run(uid(), org.id);
        console.log(`[migrate:009] created default collection for organization ${org.id} (${org.name})`);
      }
      continue;
    }
    db.prepare('UPDATE corpora SET is_default = 1 WHERE id = ?').run(corpora[0].id);
    if (corpora.length > 1) {
      console.log(`[migrate:009] organization ${org.id} (${org.name}) has ${corpora.length} corpora — ` +
        `corpus ${corpora[0].id} (most content) is now default; the rest are untouched. ` +
        `Consolidate deliberately with scripts/merge-corpora.js.`);
    }
  }
}
