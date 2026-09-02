// 002_languages (plan §6): explicit languages, varieties, orthographies and
// entry_texts. Entries become language-neutral objects whose texts are
// realizations in a specific variety/orthography — English and Dene stop being
// special at the database level. The legacy entries.dene_text/english_text
// columns REMAIN for the compatibility window (reads prefer entry_texts;
// writes mirror into entry_texts); they are removed only by a later migration
// once proven unused.
//
// Seeds English (+ its variety) and a 'Dene' language; each distinct project
// dialect string becomes a Dene variety. Backfills every existing entry:
// dene_text -> the entry's primary text in its project's dialect variety,
// english_text -> a role='translation' text in the English variety. Runs in
// one transaction (rolls back whole on failure).
import { ensureLanguageSeeds, varietyForDialect, ROLE_TRANSLATION } from '../src/apps/language/texts.js';
import { uuidv7 } from '../src/platform/uid.js';

export function up(db) {
  db.exec(`
    CREATE TABLE languages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      uid         TEXT NOT NULL UNIQUE,
      code        TEXT,
      iso639_3    TEXT,
      name        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE language_varieties (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      uid                TEXT NOT NULL UNIQUE,
      language_id        INTEGER NOT NULL REFERENCES languages(id),
      parent_variety_id  INTEGER REFERENCES language_varieties(id),
      code               TEXT,
      name               TEXT NOT NULL,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE orthographies (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      uid         TEXT NOT NULL UNIQUE,
      variety_id  INTEGER NOT NULL REFERENCES language_varieties(id),
      name        TEXT NOT NULL,
      code        TEXT,
      is_default  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE entry_texts (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      uid              TEXT NOT NULL UNIQUE,
      entry_id         INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      variety_id       INTEGER NOT NULL REFERENCES language_varieties(id),
      orthography_id   INTEGER REFERENCES orthographies(id),
      text             TEXT NOT NULL,
      normalized_text  TEXT,
      role             TEXT,
      is_primary       INTEGER NOT NULL DEFAULT 0,
      created_by       INTEGER REFERENCES users(id),
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_entry_texts_entry ON entry_texts(entry_id);
    CREATE INDEX idx_entry_texts_variety ON entry_texts(variety_id);
    -- An entry has at most ONE primary text (its headword realization).
    CREATE UNIQUE INDEX idx_entry_texts_primary ON entry_texts(entry_id) WHERE is_primary = 1;
  `);

  const { englishVarietyId } = ensureLanguageSeeds(db);

  // Backfill: one pass over all entries, resolving each project's dialect to
  // its Dene variety (created on first use).
  const varietyCache = new Map();
  const varietyFor = (dialect) => {
    const key = String(dialect ?? '').trim();
    if (!varietyCache.has(key)) varietyCache.set(key, varietyForDialect(db, key));
    return varietyCache.get(key);
  };

  const insertText = db.prepare(
    `INSERT INTO entry_texts (uid, entry_id, variety_id, text, role, is_primary, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const entries = db.prepare(
    `SELECT e.id, e.dene_text, e.english_text, e.created_by, p.dialect
     FROM entries e JOIN projects p ON p.id = e.project_id`
  ).all();
  let texts = 0;
  for (const e of entries) {
    if (e.dene_text) {
      insertText.run(uuidv7(), e.id, varietyFor(e.dialect), e.dene_text, null, 1, e.created_by);
      texts++;
    }
    if (e.english_text) {
      insertText.run(uuidv7(), e.id, englishVarietyId, e.english_text, ROLE_TRANSLATION, 0, e.created_by);
      texts++;
    }
  }
  if (entries.length) {
    console.log(`[migrate]   backfilled ${texts} entry_texts for ${entries.length} entries (${varietyCache.size} Dene varieties)`);
  }
}
