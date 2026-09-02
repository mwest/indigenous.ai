// 003_speakers_sessions (plan §7 + §8): speaker identity separate from user
// accounts, and recording sessions that carry shared speaker/facilitator/
// device metadata across many takes.
//
// - speakers: org-owned; user_id NULLABLE (a person can be recorded without an
//   application account) with at most one self-speaker per (org, user).
// - recording_sessions: references project_id for now — corpora arrive in a
//   later step (§10) and sessions will move to corpus_id with that migration,
//   exactly as the plan's step ordering implies. consent_grant_id is likewise
//   deferred (§8 allows it) until consent grants exist.
// - audio_files gains speaker_id + recording_session_id. Existing recordings
//   are backfilled with a self-speaker for their uploader (speaker == uploader
//   was the old implicit model); uploaded_by remains as facilitator/provenance.
import { uuidv7 } from '../src/platform/uid.js';

export function up(db) {
  db.exec(`
    CREATE TABLE speakers (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      uid              TEXT NOT NULL UNIQUE,
      organization_id  INTEGER NOT NULL REFERENCES organizations(id),
      user_id          INTEGER REFERENCES users(id),
      display_name     TEXT NOT NULL,
      external_ref     TEXT,
      notes            TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_speakers_org ON speakers(organization_id);
    CREATE UNIQUE INDEX idx_speakers_self ON speakers(organization_id, user_id) WHERE user_id IS NOT NULL;

    CREATE TABLE recording_sessions (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      uid                  TEXT NOT NULL UNIQUE,
      project_id           INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      speaker_id           INTEGER NOT NULL REFERENCES speakers(id),
      facilitator_user_id  INTEGER REFERENCES users(id),
      started_at           TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at             TEXT,
      capture_device       TEXT,
      capture_method       TEXT,
      notes                TEXT
    );
    CREATE INDEX idx_recording_sessions_project ON recording_sessions(project_id);

    ALTER TABLE audio_files ADD COLUMN speaker_id INTEGER REFERENCES speakers(id);
    ALTER TABLE audio_files ADD COLUMN recording_session_id INTEGER REFERENCES recording_sessions(id);
    CREATE INDEX idx_audio_speaker ON audio_files(speaker_id);
  `);

  // Backfill: every existing recording's voice is its uploader — create one
  // self-speaker per (organization, uploader) and stamp the rows.
  const pairs = db.prepare(`
    SELECT DISTINCT a.uploaded_by AS user_id, p.organization_id AS org_id, u.name
    FROM audio_files a
    JOIN entries e ON e.id = a.entry_id
    JOIN projects p ON p.id = e.project_id
    JOIN users u ON u.id = a.uploaded_by
    WHERE p.organization_id IS NOT NULL
  `).all();
  const insert = db.prepare(
    'INSERT INTO speakers (uid, organization_id, user_id, display_name) VALUES (?, ?, ?, ?)'
  );
  const stamp = db.prepare(`
    UPDATE audio_files SET speaker_id = ?
    WHERE speaker_id IS NULL AND uploaded_by = ? AND entry_id IN (
      SELECT e.id FROM entries e JOIN projects p ON p.id = e.project_id WHERE p.organization_id = ?)
  `);
  for (const { user_id, org_id, name } of pairs) {
    const speakerId = insert.run(uuidv7(), org_id, user_id, name).lastInsertRowid;
    stamp.run(speakerId, user_id, org_id);
  }
  if (pairs.length) {
    const stamped = db.prepare('SELECT COUNT(*) n FROM audio_files WHERE speaker_id IS NOT NULL').get().n;
    console.log(`[migrate]   created ${pairs.length} self-speakers; stamped ${stamped} recordings`);
  }
}
