// 008_document_search_chunks: semantic search over documents (master-search
// spec §13–§16). Adds the chunk table (disposable, rebuildable search
// derivatives — the original file and document_blocks stay authoritative),
// semantic-index state on document_versions (independent of the document's
// own ready/failed lifecycle), and the 'semantic_index' ingestion job type.
//
// transaction=false: the ingestion_jobs job_type CHECK must gain
// 'semantic_index', which needs the rebuild dance with PRAGMA foreign_keys
// OFF (the applied 007 migration is frozen — never edited).

export const transaction = false;

export function up(db) {
  // 1. Rebuild ingestion_jobs so job_type may be 'semantic_index'.
  const jobsSql = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ingestion_jobs'`)
    .get().sql;
  if (!jobsSql.includes('semantic_index')) {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`
        CREATE TABLE ingestion_jobs_new (
          id                   INTEGER PRIMARY KEY AUTOINCREMENT,
          document_version_id  INTEGER NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,

          job_type             TEXT NOT NULL,
          status               TEXT NOT NULL DEFAULT 'queued',

          attempts             INTEGER NOT NULL DEFAULT 0,
          error_message        TEXT,

          queued_at            TEXT NOT NULL DEFAULT (datetime('now')),
          started_at           TEXT,
          completed_at         TEXT,

          CHECK(job_type IN ('extract', 'index', 'semantic_index')),
          CHECK(status IN ('queued', 'running', 'completed', 'failed'))
        );
        INSERT INTO ingestion_jobs_new
          SELECT id, document_version_id, job_type, status, attempts, error_message,
                 queued_at, started_at, completed_at
          FROM ingestion_jobs;
        DROP TABLE ingestion_jobs;
        ALTER TABLE ingestion_jobs_new RENAME TO ingestion_jobs;
        CREATE INDEX idx_ingestion_jobs_queue ON ingestion_jobs(status, queued_at);
      `);
    })();
    db.pragma('foreign_keys = ON');
  }

  db.transaction(() => {
    // 2. Chunk table (spec §13). Chunks resolve back to source locations;
    //    embeddings are per-chunk, never one vector per whole file.
    db.exec(`
      CREATE TABLE document_search_chunks (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        uid                  TEXT NOT NULL UNIQUE,
        document_version_id  INTEGER NOT NULL
                               REFERENCES document_versions(id) ON DELETE CASCADE,
        ordinal              INTEGER NOT NULL,
        first_block_id       INTEGER REFERENCES document_blocks(id) ON DELETE SET NULL,
        last_block_id        INTEGER REFERENCES document_blocks(id) ON DELETE SET NULL,
        text                 TEXT NOT NULL,
        content_hash         TEXT NOT NULL,
        page_number          INTEGER,
        sheet_name           TEXT,
        row_number           INTEGER,
        location_json        TEXT,
        embedding            BLOB,
        embedding_model      TEXT,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(document_version_id, ordinal)
      );

      CREATE INDEX idx_document_search_chunks_version
      ON document_search_chunks(document_version_id);
    `);

    // 3. Semantic-index state (spec §15) — separate from document status:
    //    a document is ready when extraction + FTS are done; semantic
    //    indexing follows and its failure never fails the document.
    db.exec(`
      ALTER TABLE document_versions ADD COLUMN semantic_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(semantic_status IN ('pending', 'indexing', 'ready', 'failed'));
      ALTER TABLE document_versions ADD COLUMN semantic_model TEXT;
      ALTER TABLE document_versions ADD COLUMN semantic_indexed_at TEXT;
      ALTER TABLE document_versions ADD COLUMN semantic_error TEXT;
    `);
  })();
}
