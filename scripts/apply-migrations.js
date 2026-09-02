// Apply pending migrations to the database in DENE_DATA_DIR (or ./data) by
// importing src/db.js, exactly as the server does at boot. Used by the
// migration tests to run each scenario in a clean process.
import '../src/db.js';
console.log('[apply] migrations up to date');
