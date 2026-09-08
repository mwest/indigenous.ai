// 010_optional_entry_campaign: entries.project_id becomes NULLABLE
// (flat-collection spec §14/§18). An entry permanently belongs to its
// organization's Language collection (corpus_id); the campaign is optional
// provenance — manual/admin creation needs no campaign, while paid work
// items keep their NOT NULL campaign (compensation invariants untouched).
//
// transaction=false: dropping NOT NULL needs the table-rebuild dance with
// PRAGMA foreign_keys OFF. The copy is by COLUMN NAME (never SELECT *):
// fresh databases created entries with kind/category inline while legacy
// databases appended them via ALTER, so positional order differs. Child
// tables (entry_texts, audio_files, entry_document_sources, work_items)
// keep referencing entries(id) by name; rowids are preserved.

export const transaction = false;

const COLS = `id, project_id, kind, dene_text, english_text, source_doc, notes, category,
  status, created_by, updated_by, created_at, updated_at, embedding, embedding_model, uid, corpus_id`;

export function up(db) {
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entries'`).get().sql;
  if (!/project_id\s+INTEGER\s+NOT NULL/.test(sql)) return; // already nullable

  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE entries_new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id   INTEGER REFERENCES projects(id),
        kind         TEXT NOT NULL DEFAULT 'word' CHECK (kind IN ('word', 'phrase')),
        dene_text    TEXT NOT NULL,
        english_text TEXT NOT NULL,
        source_doc   TEXT,
        notes        TEXT,
        category     TEXT,
        status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'reviewed', 'verified')),
        created_by   INTEGER NOT NULL REFERENCES users(id),
        updated_by   INTEGER NOT NULL REFERENCES users(id),
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
        embedding        BLOB,
        embedding_model  TEXT,
        uid              TEXT,
        corpus_id        INTEGER REFERENCES corpora(id) ON DELETE SET NULL
      );
      INSERT INTO entries_new (${COLS}) SELECT ${COLS} FROM entries;
      DROP TABLE entries;
      ALTER TABLE entries_new RENAME TO entries;
      CREATE INDEX idx_entries_project ON entries(project_id);
      CREATE INDEX idx_entries_creator ON entries(created_by);
      CREATE UNIQUE INDEX idx_entries_uid ON entries(uid);
      CREATE INDEX idx_entries_corpus ON entries(corpus_id);
    `);
  })();
  db.pragma('foreign_keys = ON');

  const bad = db.pragma('foreign_key_check');
  if (bad.length) throw new Error(`foreign_key_check failed after entries rebuild: ${JSON.stringify(bad.slice(0, 3))}`);
}
