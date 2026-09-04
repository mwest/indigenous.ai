// Rebuild the document full-text index from the authoritative blocks
// (spec §34): the FTS index is derived and disposable.
// Usage: npm run documents:reindex
import db from '../src/db.js';

db.exec(`INSERT INTO document_blocks_fts(document_blocks_fts) VALUES ('rebuild')`);
const n = db.prepare('SELECT COUNT(*) n FROM document_blocks').get().n;
console.log(`Document search index rebuilt over ${n} blocks.`);
