import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { runMigrations } from './migrate.js';

const ROOT = path.join(import.meta.dirname, '..');
// DENE_DATA_DIR overrides the data location (used by the test runner to give
// each `npm test` an isolated throwaway database + audio store).
export const DATA_DIR = process.env.DENE_DATA_DIR || path.join(ROOT, 'data');
// Audio lives at data/audio/<uploader user id>/<file>; stored_name in the DB
// is the path relative to AUDIO_DIR (e.g. "3/a1b2c3.mp3").
export const AUDIO_DIR = path.join(DATA_DIR, 'audio');
// Public translation-request uploads: data/requests/<request id>/<file>.
export const REQUESTS_DIR = path.join(DATA_DIR, 'requests');

fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(REQUESTS_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'dene.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema is managed by versioned migrations (migrations/NNN_*.sql|js) recorded
// in schema_migrations — see src/migrate.js. 001_baseline builds the full
// schema on fresh databases and upgrades any historical database in place.
await runMigrations(db, path.join(ROOT, 'migrations'));

export default db;

// ---- Role helpers -------------------------------------------------------
// Platform administration (is_superadmin) grants NO corpus access: every project
// role flows from an organization role or a project membership. The baseline
// migration ensures the people who previously relied on the implicit superadmin
// rule hold an explicit (and revocable) owner_admin grant instead.

/** Role of a user in an organization: 'owner_admin', 'admin', 'member', or null. */
export function orgRole(user, orgId) {
  const row = db
    .prepare('SELECT role FROM organization_memberships WHERE user_id = ? AND organization_id = ?')
    .get(user.id, orgId);
  return row ? row.role : null;
}

/** Organizations the user belongs to, with role. */
export function orgsFor(user) {
  return db
    .prepare(
      `SELECT o.id, o.name, o.slug, om.role FROM organizations o
       JOIN organization_memberships om ON om.organization_id = o.id
       WHERE om.user_id = ? ORDER BY o.name`
    )
    .all(user.id);
}

/**
 * Effective role of a user in a project: 'admin', 'member', 'translator', or
 * null. FLAT MODEL (006): the org membership is the only membership — a
 * person's org role applies to every campaign the organization runs
 * (owner_admin and admin both act as 'admin'; member and translator carry
 * through). The legacy per-project memberships table is provenance only.
 */
export function roleIn(user, projectId) {
  const row = db
    .prepare(
      `SELECT om.role FROM projects p
       JOIN organization_memberships om ON om.organization_id = p.organization_id
       WHERE p.id = ? AND om.user_id = ?`
    )
    .get(projectId, user.id);
  if (!row) return null;
  return row.role === 'owner_admin' || row.role === 'admin' ? 'admin' : row.role;
}

/** Projects visible to a user, with role: every project of every organization
 *  the user belongs to (flat model — see roleIn). */
export function projectsFor(user) {
  return db
    .prepare(
      `SELECT p.*, CASE WHEN om.role IN ('owner_admin', 'admin') THEN 'admin' ELSE om.role END AS role
       FROM projects p
       JOIN organization_memberships om ON om.organization_id = p.organization_id
       WHERE om.user_id = ? ORDER BY p.name`
    )
    .all(user.id);
}

/** IDs of projects the user may read. */
export function projectIdsFor(user) {
  return projectsFor(user).map((p) => p.id);
}
