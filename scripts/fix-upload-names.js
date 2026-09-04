// One-time repair for upload names mangled by the busboy latin1 bug: multipart
// filenames arrived as latin1-decoded UTF-8 (Dene diacritics -> mojibake)
// until utf8UploadName() landed in src/api.js. Re-decodes every affected
// column when the byte round-trip is lossless, so correct names are never
// touched and re-running is a no-op.
//
//   node scripts/fix-upload-names.js          # dry run: report what would change
//   node scripts/fix-upload-names.js --apply  # write the repairs
import db from '../src/db.js';

const APPLY = process.argv.includes('--apply');

function recover(name) {
  if (!name || !/[-ÿ]/.test(name)) return null;
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  if (decoded === name) return null;
  return Buffer.from(decoded, 'utf8').toString('latin1') === name ? decoded : null;
}

let changes = 0;
const report = (table, id, col, oldV, newV) => {
  changes++;
  console.log(`${APPLY ? 'fixed' : 'would fix'} ${table}.${col} #${id}: ${JSON.stringify(oldV)} -> ${JSON.stringify(newV)}`);
};

const fixColumn = (table, col) => {
  for (const row of db.prepare(`SELECT id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL`).all()) {
    const fixed = recover(row.v);
    if (!fixed) continue;
    report(table, row.id, col, row.v, fixed);
    if (APPLY) db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`).run(fixed, row.id);
  }
};

db.transaction(() => {
  // Documents: repair title + original_filename, remembering title changes so
  // the provenance strings that embed the title can follow.
  const titleFixes = [];
  for (const d of db.prepare('SELECT id, title, original_filename FROM documents').all()) {
    const t = recover(d.title);
    const f = recover(d.original_filename);
    if (t) { report('documents', d.id, 'title', d.title, t); titleFixes.push([d.title, t]); }
    if (f) report('documents', d.id, 'original_filename', d.original_filename, f);
    if (APPLY && (t || f)) {
      db.prepare('UPDATE documents SET title = ?, original_filename = ? WHERE id = ?')
        .run(t ?? d.title, f ?? d.original_filename, d.id);
    }
  }

  fixColumn('audio_files', 'original_name');
  fixColumn('request_files', 'original_name');

  // entries.source_doc: "CSV import: <name>" rows repair whole-string; the
  // "<title> — <sheet>, row N" form contains a genuine em dash (outside
  // latin1), so those follow their document's title fix instead.
  fixColumn('entries', 'source_doc');
  for (const [oldT, newT] of titleFixes) {
    const hits = db.prepare(`SELECT id, source_doc FROM entries WHERE source_doc LIKE ? || '%'`).all(oldT);
    for (const e of hits) {
      const fixed = newT + e.source_doc.slice(oldT.length);
      report('entries', e.id, 'source_doc', e.source_doc, fixed);
      if (APPLY) db.prepare('UPDATE entries SET source_doc = ? WHERE id = ?').run(fixed, e.id);
    }
  }
})();

console.log(changes === 0
  ? 'Nothing to repair — all upload names are clean.'
  : `${changes} value${changes === 1 ? '' : 's'} ${APPLY ? 'repaired.' : 'would be repaired — re-run with --apply to write.'}`);
