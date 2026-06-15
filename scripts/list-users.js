// List all accounts with their derived status. Read-only diagnostic.
// Usage: node scripts/list-users.js
import db from '../src/db.js';

const rows = db
  .prepare(
    `SELECT id, email, name,
            (password_hash IS NOT NULL) AS has_password,
            is_superadmin, inviter_id, deactivated_at,
            CASE
              WHEN deactivated_at IS NOT NULL THEN 'deactivated'
              WHEN password_hash IS NOT NULL THEN 'member'
              ELSE 'invited'
            END AS status
     FROM users ORDER BY id`
  )
  .all();

console.table(rows);
console.log('JSON: ' + JSON.stringify(rows));
