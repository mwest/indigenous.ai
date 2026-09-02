// Migration framework tests (plan §5 acceptance criteria):
//   1. fresh DB reaches current schema from zero;
//   2. a representative legacy DB (the day-one schema, with data) upgrades
//      without data loss;
//   3. reruns are no-ops (each migration applies exactly once);
//   4. a failed migration rolls back, leaving the DB at its prior version;
//   5. the framework refuses a DB whose schema is newer than the code.
// Standalone: creates throwaway temp dirs, spawns child processes to apply
// (fresh module state per run, like a real server boot), exits non-zero on
// any failure. Wired into `npm test` via scripts/run-tests.js and CI.
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../src/migrate.js';

const ROOT = path.join(import.meta.dirname, '..');
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + detail}`);
  if (!cond) failures++;
};

const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `dene-mig-${label}-`));
const apply = (dataDir) =>
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'apply-migrations.js')], {
    env: { ...process.env, DENE_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
const open = (dataDir) => new Database(path.join(dataDir, 'dene.db'), { readonly: true });
const tableSql = (db, name) =>
  db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name)?.sql ?? '';

// --- 1. fresh database from zero -------------------------------------------
const freshDir = tmp('fresh');
let r = apply(freshDir);
check('fresh: apply exits 0', r.status === 0, r.stderr);
{
  const db = open(freshDir);
  const applied = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  check('fresh: migrations recorded in schema_migrations',
    applied.length === 4 && applied[0].name === '001_baseline' && applied[1].name === '002_languages' &&
    applied[2].name === '003_speakers_sessions' && applied[3].name === '004_stable_uids',
    JSON.stringify(applied));
  check('fresh: uid unique indexes exist on transferable tables',
    ['organizations', 'projects', 'entries', 'audio_files'].every((t) =>
      db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'idx_${t}_uid'`).get()));
  check('fresh: checksums recorded', applied.every((m) => m.checksum?.length === 64));
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((t) => t.name);
  for (const t of ['users', 'organizations', 'organization_apps', 'work_items', 'work_log', 'audio_files',
                   'languages', 'language_varieties', 'orthographies', 'entry_texts',
                   'speakers', 'recording_sessions']) {
    check(`fresh: table ${t} exists`, tables.includes(t));
  }
  check('fresh: English and Dene languages seeded',
    db.prepare(`SELECT COUNT(*) n FROM languages WHERE name IN ('English','Dene')`).get().n === 2);
  check('fresh: English variety seeded with a uid',
    !!db.prepare(`SELECT 1 FROM language_varieties v JOIN languages l ON l.id=v.language_id
                  WHERE l.code='en' AND v.uid IS NOT NULL`).get());
  check('fresh: foreign_key_check clean', db.pragma('foreign_key_check').length === 0);
  db.close();
}

// --- 2. legacy (day-one schema + data) upgrades without data loss -----------
const legacyDir = tmp('legacy');
fs.mkdirSync(legacyDir, { recursive: true });
{
  const db = new Database(path.join(legacyDir, 'dene.db'));
  db.pragma('journal_mode = WAL');
  // The schema exactly as shipped in the initial commit.
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL, password_hash TEXT NOT NULL, is_superadmin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE sessions (
      token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE password_tokens (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK (purpose IN ('invite','reset')), expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, dialect TEXT,
      description TEXT, is_public INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE memberships (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('admin','member')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_id, project_id));
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id),
      dene_text TEXT NOT NULL, english_text TEXT NOT NULL, source_doc TEXT, notes TEXT, category TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed','verified')),
      created_by INTEGER NOT NULL REFERENCES users(id), updated_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE INDEX idx_entries_project ON entries(project_id);
    CREATE TABLE audio_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      stored_name TEXT NOT NULL, original_name TEXT NOT NULL, mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL, duration_seconds REAL NOT NULL,
      language TEXT NOT NULL DEFAULT 'dene' CHECK (language IN ('dene','english')),
      speaker TEXT, recording_notes TEXT, uploaded_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE UNIQUE INDEX idx_audio_one_per_lang ON audio_files(entry_id, uploaded_by, language);
  `);
  db.prepare(`INSERT INTO users (email, name, password_hash, is_superadmin) VALUES (?,?,?,1)`)
    .run('legacy-admin@test.ca', 'Legacy Admin', 'x');
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?,1,datetime('now','+1 day'))`)
    .run('raw-legacy-token');
  db.prepare(`INSERT INTO projects (name, dialect) VALUES ('Legacy Project', 'Dëne Sųłıné')`).run();
  db.prepare(`INSERT INTO memberships (user_id, project_id, role) VALUES (1,1,'admin')`).run();
  const addEntry = db.prepare(
    `INSERT INTO entries (project_id, dene_text, english_text, created_by, updated_by) VALUES (1,?,?,1,1)`);
  addEntry.run('ʔedlánet’é', 'how are you');
  addEntry.run('masi', 'thank you');
  db.prepare(`INSERT INTO audio_files (entry_id, stored_name, original_name, mime_type, size_bytes,
              duration_seconds, uploaded_by) VALUES (1,'1/a.mp3','a.mp3','audio/mpeg',100,1.5,1)`).run();
  db.close();
}
r = apply(legacyDir);
check('legacy: apply exits 0', r.status === 0, r.stderr);
{
  const db = open(legacyDir);
  check('legacy: all migrations recorded',
    db.prepare(`SELECT COUNT(*) n FROM schema_migrations`).get().n === 4);
  check('legacy: every org/project/entry/recording received a stable uid',
    ['organizations', 'projects', 'entries', 'audio_files'].every((t) =>
      db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE uid IS NULL`).get().n === 0));
  check('legacy: backfilled uids are well-formed UUIDv7',
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(db.prepare(`SELECT uid FROM entries WHERE id = 1`).get().uid));
  check('legacy: users preserved', db.prepare(`SELECT COUNT(*) n FROM users`).get().n === 1);
  check('legacy: entries preserved with text intact',
    db.prepare(`SELECT COUNT(*) n FROM entries`).get().n === 2 &&
    db.prepare(`SELECT english_text FROM entries WHERE id=1`).get().english_text === 'how are you');
  check('legacy: audio row preserved and classified legacy_lossy',
    db.prepare(`SELECT archive_class, is_current FROM audio_files WHERE id=1`).get()?.archive_class === 'legacy_lossy');
  check('legacy: project attached to the default organization',
    db.prepare(`SELECT p.organization_id, o.slug FROM projects p JOIN organizations o
                ON o.id=p.organization_id WHERE p.id=1`).get()?.slug === 'dene-voice-project');
  check('legacy: superadmin granted explicit owner_admin',
    db.prepare(`SELECT role FROM organization_memberships WHERE user_id=1`).get()?.role === 'owner_admin');
  check('legacy: language app entitlement seeded enabled',
    db.prepare(`SELECT status FROM organization_apps WHERE app_code='language'`).get()?.status === 'enabled');
  check('legacy: memberships rebuilt to allow translator role',
    tableSql(db, 'memberships').includes('translator'));
  check('legacy: projects rebuilt to per-org name uniqueness',
    /UNIQUE\s*\(\s*organization_id\s*,\s*name\s*\)/i.test(tableSql(db, 'projects')));
  check('legacy: raw session tokens cleared (hashed-token migration)',
    db.prepare(`SELECT COUNT(*) n FROM sessions`).get().n === 0);
  check('legacy: old unconditional audio index dropped, current-only index present',
    !db.prepare(`SELECT 1 FROM sqlite_master WHERE name='idx_audio_one_per_lang'`).get() &&
    !!db.prepare(`SELECT 1 FROM sqlite_master WHERE name='idx_audio_current_one_per_lang'`).get());
  check('legacy: work_items/work_log tables created',
    !!tableSql(db, 'work_items') && !!tableSql(db, 'work_log'));
  // 002: entry_texts backfill — both fixture entries have both sides.
  check('legacy: entry_texts backfilled (2 entries -> 4 texts, all with uids)',
    db.prepare(`SELECT COUNT(*) n FROM entry_texts WHERE uid IS NOT NULL`).get().n === 4);
  check('legacy: primary text equals the Dene column, in the project-dialect variety',
    db.prepare(`SELECT et.text, v.name AS variety, l.name AS language FROM entry_texts et
                JOIN language_varieties v ON v.id = et.variety_id
                JOIN languages l ON l.id = v.language_id
                WHERE et.entry_id = 1 AND et.is_primary = 1`).get()?.text === 'ʔedlánet’é' &&
    db.prepare(`SELECT v.name FROM entry_texts et JOIN language_varieties v ON v.id = et.variety_id
                WHERE et.entry_id = 1 AND et.is_primary = 1`).get()?.name === 'Dëne Sųłıné');
  check('legacy: English side stored as a role=translation text in the English variety',
    db.prepare(`SELECT et.text FROM entry_texts et
                JOIN language_varieties v ON v.id = et.variety_id
                JOIN languages l ON l.id = v.language_id
                WHERE et.entry_id = 1 AND l.code = 'en' AND et.role = 'translation'`).get()?.text === 'how are you');
  // 003: speaker backfill — the fixture recording's voice is its uploader.
  check('legacy: a self-speaker was created for the uploader and stamped on the recording',
    db.prepare(`SELECT s.user_id, s.display_name FROM audio_files a JOIN speakers s ON s.id = a.speaker_id
                WHERE a.id = 1`).get()?.user_id === 1 &&
    db.prepare(`SELECT COUNT(*) n FROM speakers`).get().n === 1);
  check('legacy: foreign_key_check clean', db.pragma('foreign_key_check').length === 0);
  db.close();
}

// --- 3. reruns are exactly-once ---------------------------------------------
for (const [label, dir] of [['fresh', freshDir], ['legacy', legacyDir]]) {
  const before = open(dir).prepare(`SELECT version, applied_at FROM schema_migrations`).all();
  r = apply(dir);
  const db = open(dir);
  const after = db.prepare(`SELECT version, applied_at FROM schema_migrations`).all();
  check(`rerun (${label}): exits 0 and does not re-apply`,
    r.status === 0 && JSON.stringify(before) === JSON.stringify(after) && !r.stdout.includes('applying'),
    r.stdout + r.stderr);
  db.close();
}

// --- 4. failed migration rolls back to the prior version --------------------
{
  const dir = tmp('fail');
  const migDir = path.join(dir, 'migrations');
  fs.mkdirSync(migDir, { recursive: true });
  fs.writeFileSync(path.join(migDir, '001_good.sql'),
    `CREATE TABLE t1 (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t1 (v) VALUES ('one');`);
  fs.writeFileSync(path.join(migDir, '002_bad.sql'),
    `CREATE TABLE t2 (id INTEGER PRIMARY KEY); INSERT INTO no_such_table VALUES (1);`);
  const db = new Database(path.join(dir, 'scratch.db'));
  let threw = null;
  try { await runMigrations(db, migDir); } catch (e) { threw = e; }
  check('failure: bad migration throws', !!threw, String(threw));
  check('failure: prior migration stays applied',
    db.prepare(`SELECT COUNT(*) n FROM schema_migrations`).get().n === 1 &&
    db.prepare(`SELECT COUNT(*) n FROM t1`).get().n === 1);
  check('failure: partial DDL from the failed migration rolled back',
    !db.prepare(`SELECT 1 FROM sqlite_master WHERE name='t2'`).get());
  // Fix 002 and rerun: only the fixed migration applies; 001 is not re-run.
  fs.writeFileSync(path.join(migDir, '002_bad.sql'), `CREATE TABLE t2 (id INTEGER PRIMARY KEY);`);
  await runMigrations(db, migDir);
  check('failure: fixed migration applies on rerun without re-running 001',
    db.prepare(`SELECT COUNT(*) n FROM schema_migrations`).get().n === 2 &&
    db.prepare(`SELECT COUNT(*) n FROM t1`).get().n === 1 &&
    !!db.prepare(`SELECT 1 FROM sqlite_master WHERE name='t2'`).get());

  // --- 5. refuse to run when the DB is newer than the code ------------------
  db.prepare(`INSERT INTO schema_migrations (version, name) VALUES (999, '999_from_the_future')`).run();
  let refuse = null;
  try { await runMigrations(db, migDir); } catch (e) { refuse = e; }
  check('newer-schema: refuses to run against a future database',
    !!refuse && String(refuse.message).includes('NEWER'), String(refuse));
  db.close();
}

console.log(failures ? `\n${failures} MIGRATION TEST FAILURES` : '\nAll migration tests passed.');
process.exit(failures ? 1 : 0);
