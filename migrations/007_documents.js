// 007_documents (documents spec §19–§24, §33, §44): first-class corpus
// documents — immutable originals, versions, durable extracted blocks with
// source locators, a DB-backed ingestion job queue, entry↔document
// provenance, and FTS5 keyword search that PRESERVES Indigenous-language
// diacritics (remove_diacritics 0 — the exact orthography is authoritative).
//
// FTS is an external-content index over document_blocks kept in sync by
// triggers; it is derived and rebuildable (npm run documents:reindex).

export function up(db) {
  db.exec(`
    CREATE TABLE documents (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      uid                TEXT NOT NULL UNIQUE,
      corpus_id          INTEGER NOT NULL REFERENCES corpora(id) ON DELETE CASCADE,
      origin_project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,

      title              TEXT NOT NULL,
      original_filename  TEXT NOT NULL,
      mime_type          TEXT NOT NULL,
      extension          TEXT,
      size_bytes         INTEGER NOT NULL,
      sha256             TEXT NOT NULL,

      status             TEXT NOT NULL DEFAULT 'uploaded',
      error_message      TEXT,

      uploaded_by        INTEGER NOT NULL REFERENCES users(id),
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now')),

      CHECK(status IN ('uploaded', 'extracting', 'indexing', 'ready', 'failed', 'archived'))
    );
    CREATE INDEX idx_documents_corpus ON documents(corpus_id, created_at);
    CREATE INDEX idx_documents_status ON documents(status);

    CREATE TABLE document_versions (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      uid                TEXT NOT NULL UNIQUE,
      document_id        INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      version_number     INTEGER NOT NULL,
      original_filename  TEXT NOT NULL,
      storage_key        TEXT NOT NULL,
      mime_type          TEXT NOT NULL,
      size_bytes         INTEGER NOT NULL,
      sha256             TEXT NOT NULL,
      -- extractor summary (page/sheet/block counts, requires_ocr, ...)
      extraction_json    TEXT,
      uploaded_by        INTEGER NOT NULL REFERENCES users(id),
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(document_id, version_number)
    );

    CREATE TABLE document_blocks (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      uid                  TEXT NOT NULL UNIQUE,
      document_version_id  INTEGER NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,

      ordinal              INTEGER NOT NULL,
      block_type           TEXT NOT NULL,
      text                 TEXT,

      page_number          INTEGER,
      sheet_name           TEXT,
      row_number           INTEGER,
      column_name          TEXT,

      location_json        TEXT,
      metadata_json        TEXT,

      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(document_version_id, ordinal)
    );
    CREATE INDEX idx_document_blocks_version ON document_blocks(document_version_id, ordinal);

    CREATE TABLE ingestion_jobs (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      document_version_id  INTEGER NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,

      job_type             TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'queued',

      attempts             INTEGER NOT NULL DEFAULT 0,
      error_message        TEXT,

      queued_at            TEXT NOT NULL DEFAULT (datetime('now')),
      started_at           TEXT,
      completed_at         TEXT,

      CHECK(job_type IN ('extract', 'index')),
      CHECK(status IN ('queued', 'running', 'completed', 'failed'))
    );
    CREATE INDEX idx_ingestion_jobs_queue ON ingestion_jobs(status, queued_at);

    -- Entry provenance (spec §44): entries created from a document keep a
    -- durable structured link to it. document_id is NOT cascaded on document
    -- delete via the app (hard delete is refused while links exist).
    CREATE TABLE entry_document_sources (
      entry_id           INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      document_id        INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      document_block_id  INTEGER REFERENCES document_blocks(id) ON DELETE SET NULL,
      location_json      TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(entry_id, document_id)
    );

    -- Keyword search over blocks; diacritics preserved (spec §33).
    CREATE VIRTUAL TABLE document_blocks_fts USING fts5(
      text,
      content='document_blocks',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 0'
    );
    CREATE TRIGGER document_blocks_ai AFTER INSERT ON document_blocks BEGIN
      INSERT INTO document_blocks_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER document_blocks_ad AFTER DELETE ON document_blocks BEGIN
      INSERT INTO document_blocks_fts(document_blocks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
    CREATE TRIGGER document_blocks_au AFTER UPDATE OF text ON document_blocks BEGIN
      INSERT INTO document_blocks_fts(document_blocks_fts, rowid, text) VALUES ('delete', old.id, old.text);
      INSERT INTO document_blocks_fts(rowid, text) VALUES (new.id, new.text);
    END;
  `);
}
