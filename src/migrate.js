// Versioned migration framework (Indigenous.ai plan §5).
//
// Migrations live in migrations/ as NNN_name.sql or NNN_name.js, applied in
// numeric order, each exactly once, recorded in schema_migrations. SQL files
// run inside a transaction; JS files export up(db) and run in a transaction
// unless they export `transaction = false` (needed when a migration must
// toggle PRAGMA foreign_keys for a table rebuild — a no-op inside a
// transaction — in which case the migration manages its own atomicity).
//
// Safety behavior:
// - a failed transactional migration rolls back completely and nothing is
//   recorded, so the DB stays at its prior version;
// - the app refuses to start if the DB records a migration version newer than
//   the code knows (downgrade protection);
// - an edited already-applied migration file logs a loud checksum warning
//   (history must stay frozen); reruns of applied versions are skipped.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Discover migration files: [{version, name, file, ext}] sorted by version. */
function discover(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const m = /^(\d+)_(.+)\.(sql|js)$/.exec(f);
    if (!m) continue;
    out.push({ version: Number(m[1]), name: `${m[1]}_${m[2]}`, file: path.join(dir, f), ext: m[3] });
  }
  out.sort((a, b) => a.version - b.version);
  for (let i = 1; i < out.length; i++) {
    if (out[i].version === out[i - 1].version) {
      throw new Error(`[migrate] duplicate migration version ${out[i].version} (${out[i - 1].name}, ${out[i].name})`);
    }
  }
  return out;
}

export async function runMigrations(db, dir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const files = discover(dir);
  const applied = new Map(
    db.prepare('SELECT version, name, checksum FROM schema_migrations').all().map((r) => [r.version, r])
  );

  // Downgrade protection: refuse to run against a database from newer code.
  const maxKnown = files.length ? files[files.length - 1].version : 0;
  for (const [version, row] of applied) {
    if (version > maxKnown) {
      throw new Error(
        `[migrate] database schema is NEWER than this code: migration ${row.name} (version ${version}) ` +
        `is applied but unknown here (latest known: ${maxKnown}). Refusing to start — update the code.`
      );
    }
  }

  const record = db.prepare('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)');
  let ran = 0;

  for (const mig of files) {
    const content = fs.readFileSync(mig.file);
    const checksum = sha256(content);
    const prior = applied.get(mig.version);
    if (prior) {
      if (prior.checksum && prior.checksum !== checksum) {
        console.warn(
          `[migrate] WARNING: applied migration ${mig.name} no longer matches its recorded checksum — ` +
          `migration history must stay frozen; put new changes in a new migration.`
        );
      }
      continue; // already applied, exactly-once
    }

    console.log(`[migrate] applying ${mig.name}`);
    if (mig.ext === 'sql') {
      db.transaction(() => {
        db.exec(content.toString('utf8'));
        record.run(mig.version, mig.name, checksum);
      })();
    } else {
      const mod = await import(pathToFileURL(mig.file).href);
      if (typeof mod.up !== 'function') {
        throw new Error(`[migrate] ${mig.name} does not export an up(db) function`);
      }
      if (mod.transaction === false) {
        mod.up(db); // migration manages its own transactions/pragmas
        record.run(mig.version, mig.name, checksum);
      } else {
        db.transaction(() => {
          mod.up(db);
          record.run(mig.version, mig.name, checksum);
        })();
      }
    }
    ran++;
  }
  return { applied: ran, total: files.length };
}
