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
 * Effective role of a user in a project: 'admin', 'member', 'translator', or null.
 * Org owner_admins/admins are admins of every project their organization owns;
 * otherwise the project membership row decides.
 */
export function roleIn(user, projectId) {
  const viaOrg = db
    .prepare(
      `SELECT 1 FROM projects p
       JOIN organization_memberships om ON om.organization_id = p.organization_id
       WHERE p.id = ? AND om.user_id = ? AND om.role IN ('owner_admin', 'admin')`
    )
    .get(projectId, user.id);
  if (viaOrg) return 'admin';
  const row = db
    .prepare('SELECT role FROM memberships WHERE user_id = ? AND project_id = ?')
    .get(user.id, projectId);
  return row ? row.role : null;
}

/** Projects visible to a user, with role. Org-admin authority wins over a plain
 *  project membership when both exist. */
export function projectsFor(user) {
  return db
    .prepare(
      `SELECT p.*, MIN(src.rank) AS rank,
              CASE MIN(src.rank) WHEN 1 THEN 'admin' ELSE MAX(src.role) END AS role
       FROM (
         SELECT p2.id AS pid, 1 AS rank, 'admin' AS role
           FROM projects p2
           JOIN organization_memberships om ON om.organization_id = p2.organization_id
          WHERE om.user_id = ? AND om.role IN ('owner_admin', 'admin')
         UNION ALL
         SELECT m.project_id AS pid, 2 AS rank, m.role AS role
           FROM memberships m WHERE m.user_id = ?
       ) src
       JOIN projects p ON p.id = src.pid
       GROUP BY p.id ORDER BY p.name`
    )
    .all(user.id, user.id)
    .map(({ rank, ...p }) => p);
}

/** IDs of projects the user may read. */
export function projectIdsFor(user) {
  return projectsFor(user).map((p) => p.id);
}
