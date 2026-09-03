// 006_flat_roles: flatten the people model. Organization membership becomes
// the ONLY membership — org roles are owner_admin | admin | member |
// translator, and a person's role applies to every campaign in the org.
// The legacy per-project `memberships` table stays in place as historical
// provenance (who was assigned to which campaign) but is no longer consulted
// for authorization or shown in the UI.
//
// Backfill: each user's STRONGEST project role per organization becomes their
// org role (project admin -> org admin, member -> member, translator ->
// translator); existing org roles are never downgraded.
//
// transaction=false: the organization_memberships CHECK must gain
// 'translator', which needs the rebuild dance with PRAGMA foreign_keys OFF.

const RANK = { owner_admin: 4, admin: 3, member: 2, translator: 1 };

export const transaction = false;

export function up(db) {
  // 1. Rebuild organization_memberships to allow the translator role.
  const omSql = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'organization_memberships'`)
    .get().sql;
  if (!omSql.includes('translator')) {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`
        CREATE TABLE organization_memberships_new (
          organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role            TEXT NOT NULL CHECK (role IN ('owner_admin', 'admin', 'member', 'translator')),
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (organization_id, user_id)
        );
        INSERT INTO organization_memberships_new
          SELECT organization_id, user_id, role, created_at FROM organization_memberships;
        DROP TABLE organization_memberships;
        ALTER TABLE organization_memberships_new RENAME TO organization_memberships;
      `);
    })();
    db.pragma('foreign_keys = ON');
  }

  // 2. Backfill: strongest project role per (user, organization) -> org role.
  const projectRoles = db
    .prepare(
      `SELECT m.user_id, p.organization_id AS org_id, m.role
       FROM memberships m JOIN projects p ON p.id = m.project_id
       WHERE p.organization_id IS NOT NULL`
    )
    .all();
  const best = new Map(); // "user/org" -> role
  for (const r of projectRoles) {
    const key = `${r.user_id}/${r.org_id}`;
    if ((RANK[r.role] ?? 0) > (RANK[best.get(key)] ?? 0)) best.set(key, r.role);
  }
  const getOrg = db.prepare(
    'SELECT role FROM organization_memberships WHERE user_id = ? AND organization_id = ?'
  );
  const insert = db.prepare(
    'INSERT INTO organization_memberships (organization_id, user_id, role) VALUES (?, ?, ?)'
  );
  const update = db.prepare(
    'UPDATE organization_memberships SET role = ? WHERE user_id = ? AND organization_id = ?'
  );
  let created = 0, upgraded = 0;
  for (const [key, role] of best) {
    const [userId, orgId] = key.split('/').map(Number);
    const existing = getOrg.get(userId, orgId);
    if (!existing) {
      insert.run(orgId, userId, role);
      created++;
    } else if ((RANK[role] ?? 0) > (RANK[existing.role] ?? 0)) {
      update.run(role, userId, orgId); // upgrade only, never downgrade
      upgraded++;
    }
  }
  if (created || upgraded) {
    console.log(`[migrate]   flat roles: ${created} org memberships created, ${upgraded} upgraded from project roles`);
  }
}
