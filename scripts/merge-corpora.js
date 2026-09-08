// Deliberate corpus consolidation (flat-collection spec §26): moves ALL of an
// organization's language content into its default collection, then removes
// the emptied corpus rows. The migration never merges automatically — this
// script is the manual resolution for organizations that accumulated one
// corpus per legacy project. Content is only reparented, never deleted or
// deduplicated; campaign provenance (entries.project_id, origin_project_id)
// is untouched, so "which dictionary did this come from" remains answerable
// through each entry's origin campaign.
//
//   node scripts/merge-corpora.js --org <id>            # dry run
//   node scripts/merge-corpora.js --org <id> --apply    # write
//
// Production: scripts/prod-ssh.sh "cd /app && node scripts/merge-corpora.js --org 1 --apply"
import db from '../src/db.js';
import { defaultCorpusFor } from '../src/apps/language/corpus.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const orgIdx = args.indexOf('--org');
const orgId = orgIdx >= 0 ? Number(args[orgIdx + 1]) : NaN;
if (!Number.isInteger(orgId)) {
  console.error('Usage: node scripts/merge-corpora.js --org <organizationId> [--apply]');
  process.exit(2);
}
const org = db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(orgId);
if (!org) { console.error(`No organization with id ${orgId}`); process.exit(2); }

const target = defaultCorpusFor(db, orgId);
const sources = db.prepare(
  'SELECT * FROM corpora WHERE organization_id = ? AND id <> ?'
).all(orgId, target.id);
console.log(`Organization ${org.id} (${org.name}) — default collection: corpus ${target.id} "${target.name}"`);
if (!sources.length) { console.log('Nothing to merge — the default collection is the only corpus.'); process.exit(0); }

let totals = { entries: 0, documents: 0, projects: 0, sessions: 0 };
for (const c of sources) {
  const n = {
    entries: db.prepare('SELECT COUNT(*) n FROM entries WHERE corpus_id = ?').get(c.id).n,
    documents: db.prepare('SELECT COUNT(*) n FROM documents WHERE corpus_id = ?').get(c.id).n,
    projects: db.prepare('SELECT COUNT(*) n FROM projects WHERE corpus_id = ?').get(c.id).n,
    sessions: db.prepare('SELECT COUNT(*) n FROM recording_sessions WHERE corpus_id = ?').get(c.id).n,
  };
  console.log(`${APPLY ? 'merging' : 'would merge'} corpus ${c.id} "${c.name}": ` +
    `${n.entries} entries, ${n.documents} documents, ${n.projects} campaigns, ${n.sessions} sessions`);
  for (const k of Object.keys(totals)) totals[k] += n[k];
}

if (APPLY) {
  db.transaction(() => {
    for (const c of sources) {
      db.prepare('UPDATE entries SET corpus_id = ? WHERE corpus_id = ?').run(target.id, c.id);
      db.prepare('UPDATE documents SET corpus_id = ? WHERE corpus_id = ?').run(target.id, c.id);
      db.prepare('UPDATE projects SET corpus_id = ? WHERE corpus_id = ?').run(target.id, c.id);
      db.prepare('UPDATE recording_sessions SET corpus_id = ? WHERE corpus_id = ?').run(target.id, c.id);
      db.prepare('DELETE FROM corpora WHERE id = ?').run(c.id);
    }
    // The consolidated collection sheds its legacy per-project name — it is
    // THE Language collection now (spec §31); the UI shows the org name.
    db.prepare(`UPDATE corpora SET name = 'Language Collection' WHERE id = ?`).run(target.id);
  })();
  const leftovers = db.pragma('foreign_key_check');
  if (leftovers.length) {
    console.error('foreign_key_check reported issues:', JSON.stringify(leftovers));
    process.exit(1);
  }
  console.log(`Merged ${sources.length} corpora into "${target.name}": ` +
    `${totals.entries} entries, ${totals.documents} documents, ${totals.projects} campaigns, ${totals.sessions} sessions moved.`);
} else {
  console.log(`Dry run only — re-run with --apply to merge ${sources.length} corpora ` +
    `(${totals.entries} entries, ${totals.documents} documents, ${totals.projects} campaigns, ${totals.sessions} sessions).`);
}
