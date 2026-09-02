// Language-app text model (plan §6): entries are language-neutral objects;
// entry_texts hold their textual realizations in explicit language varieties.
// During the compatibility window the legacy entries.dene_text/english_text
// columns remain and every write is mirrored into entry_texts via
// syncEntryTexts(); reads prefer entry_texts (see entrySelect in api.js).
//
// Functions take `db` explicitly so migrations can use them without importing
// the app's database singleton (whose module is still mid-initialization while
// migrations run).
import { uuidv7 } from '../../platform/uid.js';

export const ENGLISH = { code: 'en', iso639_3: 'eng', name: 'English' };
export const DENE = { name: 'Dene' };
export const ROLE_TRANSLATION = 'translation';

/** Ensure the seed languages exist; returns { englishVarietyId, deneLanguageId }. */
export function ensureLanguageSeeds(db) {
  const getLang = db.prepare('SELECT id FROM languages WHERE name = ?');
  let en = getLang.get(ENGLISH.name);
  if (!en) {
    en = { id: db.prepare('INSERT INTO languages (uid, code, iso639_3, name) VALUES (?, ?, ?, ?)')
      .run(uuidv7(), ENGLISH.code, ENGLISH.iso639_3, ENGLISH.name).lastInsertRowid };
  }
  let enVar = db.prepare('SELECT id FROM language_varieties WHERE language_id = ? AND name = ?')
    .get(en.id, ENGLISH.name);
  if (!enVar) {
    enVar = { id: db.prepare('INSERT INTO language_varieties (uid, language_id, code, name) VALUES (?, ?, ?, ?)')
      .run(uuidv7(), en.id, ENGLISH.code, ENGLISH.name).lastInsertRowid };
  }
  let dene = getLang.get(DENE.name);
  if (!dene) {
    dene = { id: db.prepare('INSERT INTO languages (uid, name) VALUES (?, ?)')
      .run(uuidv7(), DENE.name).lastInsertRowid };
  }
  return { englishVarietyId: enVar.id, deneLanguageId: dene.id };
}

/** Get-or-create the Dene variety for a project's free-text dialect.
 *  NULL/empty dialect maps to the generic 'Dene' variety. */
export function varietyForDialect(db, dialect) {
  const { deneLanguageId } = ensureLanguageSeeds(db);
  const name = String(dialect ?? '').trim() || DENE.name;
  const existing = db.prepare('SELECT id FROM language_varieties WHERE language_id = ? AND name = ?')
    .get(deneLanguageId, name);
  if (existing) return existing.id;
  return db.prepare('INSERT INTO language_varieties (uid, language_id, name) VALUES (?, ?, ?)')
    .run(uuidv7(), deneLanguageId, name).lastInsertRowid;
}

/**
 * Reconcile an entry's entry_texts rows with its legacy bilingual columns
 * (the compatibility mirror): the Dene side is the entry's single primary
 * text in the project's dialect variety; the English side is one
 * role='translation' text in the English variety. A blanked side removes its
 * mirrored row. Rows outside the mirror (alternate orthographies, other
 * languages, extra roles) are never touched.
 */
export function syncEntryTexts(db, entryId, userId) {
  const entry = db.prepare(
    `SELECT e.id, e.dene_text, e.english_text, p.dialect
     FROM entries e JOIN projects p ON p.id = e.project_id WHERE e.id = ?`
  ).get(entryId);
  if (!entry) return;
  const { englishVarietyId } = ensureLanguageSeeds(db);

  // Dene side -> the primary text (at most one per entry, enforced by index).
  const primary = db.prepare(
    'SELECT id, text, variety_id FROM entry_texts WHERE entry_id = ? AND is_primary = 1'
  ).get(entryId);
  if (entry.dene_text) {
    const varietyId = varietyForDialect(db, entry.dialect);
    if (!primary) {
      db.prepare(
        `INSERT INTO entry_texts (uid, entry_id, variety_id, text, is_primary, created_by)
         VALUES (?, ?, ?, ?, 1, ?)`
      ).run(uuidv7(), entryId, varietyId, entry.dene_text, userId ?? null);
    } else if (primary.text !== entry.dene_text || primary.variety_id !== varietyId) {
      db.prepare(`UPDATE entry_texts SET text = ?, variety_id = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(entry.dene_text, varietyId, primary.id);
    }
  } else if (primary) {
    db.prepare('DELETE FROM entry_texts WHERE id = ?').run(primary.id);
  }

  // English side -> one role='translation' text in the English variety.
  const english = db.prepare(
    `SELECT id, text FROM entry_texts
     WHERE entry_id = ? AND variety_id = ? AND role = ? ORDER BY id LIMIT 1`
  ).get(entryId, englishVarietyId, ROLE_TRANSLATION);
  if (entry.english_text) {
    if (!english) {
      db.prepare(
        `INSERT INTO entry_texts (uid, entry_id, variety_id, text, role, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(uuidv7(), entryId, englishVarietyId, entry.english_text, ROLE_TRANSLATION, userId ?? null);
    } else if (english.text !== entry.english_text) {
      db.prepare(`UPDATE entry_texts SET text = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(entry.english_text, english.id);
    }
  } else if (english) {
    db.prepare('DELETE FROM entry_texts WHERE id = ?').run(english.id);
  }
}
