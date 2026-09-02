// 004_stable_uids (plan §9): globally stable IDs on the remaining transferable
// objects. languages/varieties/orthographies/entry_texts (002) and
// speakers/recording_sessions (003) were born with uids; this adds them to
// organizations, projects, entries and audio_files (today's recordings +
// versions table). Integer ids stay the fast internal keys; the uid is the
// EXTERNAL identity — exports, re-imports, merged installations and backups
// must never depend on a local row number.
//
// SQLite's ALTER can't add a column with UNIQUE/NOT NULL, so: add plain
// column, backfill UUIDv7 per row, then enforce with a unique index. The API
// stamps uids on every new row; NULL is impossible outside a manual insert.
import { uuidv7 } from '../src/platform/uid.js';

export function up(db) {
  for (const table of ['organizations', 'projects', 'entries', 'audio_files']) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN uid TEXT`);
    const stamp = db.prepare(`UPDATE ${table} SET uid = ? WHERE id = ?`);
    const rows = db.prepare(`SELECT id FROM ${table}`).all();
    for (const { id } of rows) stamp.run(uuidv7(), id);
    db.exec(`CREATE UNIQUE INDEX idx_${table}_uid ON ${table}(uid)`);
    if (rows.length) console.log(`[migrate]   ${table}: ${rows.length} uids assigned`);
  }
}
