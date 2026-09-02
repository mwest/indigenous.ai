// Speakers (plan §7): the person whose voice is on a recording, separate from
// the application user who operated the device. A speaker belongs to an
// organization, may exist without any user account (an Elder recorded by a
// facilitator), and may later be linked to one. db-parameterized so
// migrations can share the logic.
import { uuidv7 } from '../../platform/uid.js';

/** Get-or-create the speaker record representing a user speaking for
 *  themselves in an organization (the default for every recording made
 *  without an explicit session speaker). */
export function selfSpeakerFor(db, orgId, userId) {
  const existing = db
    .prepare('SELECT id FROM speakers WHERE organization_id = ? AND user_id = ?')
    .get(orgId, userId);
  if (existing) return existing.id;
  const name = db.prepare('SELECT name FROM users WHERE id = ?').get(userId)?.name ?? `User ${userId}`;
  return db
    .prepare('INSERT INTO speakers (uid, organization_id, user_id, display_name) VALUES (?, ?, ?, ?)')
    .run(uuidv7(), orgId, userId, name).lastInsertRowid;
}

/** The organization that owns a project (recordings inherit it). */
export function orgOfProject(db, projectId) {
  return db.prepare('SELECT organization_id FROM projects WHERE id = ?').get(projectId)?.organization_id ?? null;
}
