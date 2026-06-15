import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
// Round profile pictures live at data/avatars/<user id>.<ext>.
export const AVATAR_DIR = path.join(DATA_DIR, 'avatars');

fs.mkdirSync(AVATAR_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'indigenous.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- name is set by the member when they accept their invite, so it starts NULL.
  name          TEXT,
  -- NULL password_hash means the account is locked (invited but never set).
  password_hash TEXT,
  is_superadmin INTEGER NOT NULL DEFAULT 0,
  -- Soft reference to the user who invited this one (NULL for the seeded
  -- superadmin). Used for per-user invite quotas and the "invited by" line in
  -- invite emails. Intentionally not a FK: a dangling id after an inviter is
  -- removed is harmless, since we only ever count live matches.
  inviter_id    INTEGER,
  -- When set, the account is deactivated: it cannot log in and is hidden from
  -- the member-facing list. Accounts are never deleted, only deactivated.
  deactivated_at TEXT,
  -- Opt-in public profile (shown to other signed-in members when visible). The
  -- username is unique (enforced by idx_users_username below); the other fields
  -- are kept even when profile_visible is toggled off.
  username        TEXT,
  profile_visible INTEGER NOT NULL DEFAULT 0,
  avatar_ext      TEXT,
  about           TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS password_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('invite', 'reset')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A pending email change: the new address is held here until the owner of that
-- address confirms it via the emailed link (proves ownership + guards typos).
CREATE TABLE IF NOT EXISTS email_change_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  new_email  TEXT NOT NULL COLLATE NOCASE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---- Self-applying migrations ---------------------------------------------
// New columns are added idempotently here so an existing database upgrades in
// place on boot. (v1 schema above is the baseline; this scaffold is where
// future ALTERs go — guarded by a PRAGMA table_info check, like the reference.)
const userCols = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
// Track who invited each member (soft reference — see the column comment above).
if (!userCols.includes('inviter_id')) {
  db.exec(`ALTER TABLE users ADD COLUMN inviter_id INTEGER`);
}
// Deactivation timestamp (accounts are deactivated, never deleted).
if (!userCols.includes('deactivated_at')) {
  db.exec(`ALTER TABLE users ADD COLUMN deactivated_at TEXT`);
}
// Opt-in public profile fields. (A UNIQUE column can't be added via ALTER TABLE,
// so the username column is plain and uniqueness is a separate index below.)
if (!userCols.includes('username')) db.exec(`ALTER TABLE users ADD COLUMN username TEXT`);
if (!userCols.includes('profile_visible')) {
  db.exec(`ALTER TABLE users ADD COLUMN profile_visible INTEGER NOT NULL DEFAULT 0`);
}
if (!userCols.includes('avatar_ext')) db.exec(`ALTER TABLE users ADD COLUMN avatar_ext TEXT`);
if (!userCols.includes('about')) db.exec(`ALTER TABLE users ADD COLUMN about TEXT`);
// Case-insensitive unique usernames; multiple NULLs are allowed (users without
// a profile), since SQLite treats NULLs as distinct in a unique index.
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username COLLATE NOCASE)`);

export default db;
