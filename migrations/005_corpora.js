// 005_corpora (plan §10): separate the PERMANENT corpus from the funded
// campaign. A corpus owns the language data (entries, recordings, sessions);
// a project — evolving toward campaign semantics, not renamed yet per the
// plan — organizes funded work performed on that corpus. Multiple campaigns
// may contribute to one corpus; closing a campaign never touches the corpus.
//
// Backfill: one corpus per existing project (same name/org; primary variety
// from the project dialect; the project's default consent profile carried
// over), with projects/entries/recording_sessions stamped. New campaign
// columns (status, dates, funding, budget, currency) are added on projects.
import { uuidv7 } from '../src/platform/uid.js';
import { varietyForDialect } from '../src/apps/language/texts.js';

export function up(db) {
  db.exec(`
    CREATE TABLE corpora (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      uid                         TEXT NOT NULL UNIQUE,
      organization_id             INTEGER NOT NULL REFERENCES organizations(id),
      name                        TEXT NOT NULL,
      primary_variety_id          INTEGER REFERENCES language_varieties(id),
      default_consent_profile_id  INTEGER REFERENCES consent_profiles(id),
      visibility                  TEXT,
      created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (organization_id, name)
    );

    ALTER TABLE projects ADD COLUMN corpus_id INTEGER REFERENCES corpora(id);
    ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
    ALTER TABLE projects ADD COLUMN start_date TEXT;
    ALTER TABLE projects ADD COLUMN end_date TEXT;
    ALTER TABLE projects ADD COLUMN funding_reference TEXT;
    ALTER TABLE projects ADD COLUMN budget_cents INTEGER;
    ALTER TABLE projects ADD COLUMN currency TEXT NOT NULL DEFAULT 'CAD';

    ALTER TABLE entries ADD COLUMN corpus_id INTEGER REFERENCES corpora(id) ON DELETE SET NULL;
    ALTER TABLE recording_sessions ADD COLUMN corpus_id INTEGER REFERENCES corpora(id) ON DELETE SET NULL;
  `);

  const projects = db.prepare(
    `SELECT id, name, dialect, organization_id, default_consent_profile_id
     FROM projects WHERE organization_id IS NOT NULL`
  ).all();
  const insertCorpus = db.prepare(
    `INSERT INTO corpora (uid, organization_id, name, primary_variety_id, default_consent_profile_id)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const p of projects) {
    const corpusId = insertCorpus.run(
      uuidv7(), p.organization_id, p.name, varietyForDialect(db, p.dialect), p.default_consent_profile_id
    ).lastInsertRowid;
    db.prepare('UPDATE projects SET corpus_id = ? WHERE id = ?').run(corpusId, p.id);
    db.prepare('UPDATE entries SET corpus_id = ? WHERE project_id = ?').run(corpusId, p.id);
    db.prepare('UPDATE recording_sessions SET corpus_id = ? WHERE project_id = ?').run(corpusId, p.id);
  }
  db.exec(`CREATE INDEX idx_entries_corpus ON entries(corpus_id)`);
  if (projects.length) console.log(`[migrate]   created ${projects.length} corpora from existing projects`);
}
