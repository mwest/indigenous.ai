// Inspect migration history without applying anything.
// Usage: node scripts/migration-status.js [path/to/dene.db]
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const dbPath = process.argv[2]
  || path.join(process.env.DENE_DATA_DIR || path.join(ROOT, 'data'), 'dene.db');

if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const hasTable = db
  .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`)
  .get();
const applied = hasTable
  ? db.prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version').all()
  : [];

const files = fs.readdirSync(path.join(ROOT, 'migrations'))
  .filter((f) => /^\d+_.+\.(sql|js)$/.test(f))
  .sort((a, b) => Number(a.split('_')[0]) - Number(b.split('_')[0]));

console.log(`Database: ${dbPath}\n`);
console.log('Applied:');
for (const m of applied) {
  console.log(`  ${String(m.version).padStart(3, '0')}  ${m.name}  at ${m.applied_at}`);
}
if (!applied.length) console.log('  (none — schema_migrations ' + (hasTable ? 'is empty' : 'does not exist yet') + ')');

const appliedVersions = new Set(applied.map((m) => m.version));
const pending = files.filter((f) => !appliedVersions.has(Number(f.split('_')[0])));
console.log('\nPending:');
for (const f of pending) console.log(`  ${f}`);
if (!pending.length) console.log('  (none — up to date)');
