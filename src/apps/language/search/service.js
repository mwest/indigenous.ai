// Master search (master-search spec): ONE hybrid search over the active
// corpus — Entries, Documents, Recordings — plus the Home "latest" feed.
// Users search the Collection, not tables.
//
// Ranking model: within each section, Reciprocal Rank Fusion of a keyword
// candidate list and a semantic candidate list (spec §8). Keyword matches are
// always eligible; semantic-only matches must clear a relevance floor
// (spec §9) so nearest-neighbour noise never surfaces. Exact orthography
// carries a deterministic boost that outweighs any RRF contribution, so an
// exact Dene match can never be displaced by a meaning-only match.
//
// Semantic meaning is English-side MiniLM (the existing entry embeddings);
// Recordings inherit their parent Entry's embedding until transcription
// exists (spec §21). Embedding failure degrades to keyword-only — the
// request still succeeds (spec §7).
import db from '../../../db.js';
import { embed, cosine, fromBlob, MODEL } from '../../../embed.js';
import { searchBlocks, TYPE_LABEL } from '../documents/service.js';

const RRF_K = 60;
const POOL = 50; // internal candidate pool per list, fused down to the page
// Floor for semantic-only results (spec §9). Tunable per deploy; keyword
// matches bypass it entirely.
const MIN_SEMANTIC = Number(process.env.SEMANTIC_SEARCH_MIN_SCORE) || 0.25;
// RRF contributions are at most 1/(K+1) ≈ 0.016, so these boosts dominate.
const BOOST_EXACT = 0.05;
const BOOST_PREFIX = 0.015;

/** RRF (spec §8): 1/(60+rank) per list, 1-based ranks, plus deterministic
 *  keyword boosts. Semantic-only candidates below the floor are dropped;
 *  anything with a keyword rank is always eligible. */
function rrfFuse(keyword, semantic) {
  const scores = new Map();
  keyword.forEach((k, i) => {
    scores.set(k.id, (scores.get(k.id) ?? 0) + 1 / (RRF_K + i + 1) + (k.boost ?? 0));
  });
  semantic.forEach((s, i) => {
    if (!scores.has(s.id) && s.score < MIN_SEMANTIC) return;
    scores.set(s.id, (scores.get(s.id) ?? 0) + 1 / (RRF_K + i + 1));
  });
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** Hydrate ids in fused order with one IN query. */
function inOrder(ids, sql, params = []) {
  if (!ids.length) return [];
  const rows = db.prepare(`${sql} (${ids.map(() => '?').join(',')})`).all(...params, ...ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

const ENTRY_SELECT = `
  SELECT e.id, e.kind, e.dene_text, e.english_text, e.category, e.updated_at,
         (SELECT COUNT(*) FROM audio_files a WHERE a.entry_id = e.id AND a.is_current = 1) AS recording_count
  FROM entries e`;

function searchEntries({ corpusId, q, qvec, limit }) {
  const like = `%${q}%`;
  // Lexical tiers (spec §10): exact > prefix > substring > metadata-only.
  // lower() folds ASCII case only — Dene diacritics stay byte-exact.
  const keyword = db.prepare(
    `SELECT e.id,
            CASE WHEN lower(e.dene_text) = lower(?) OR lower(e.english_text) = lower(?) THEN 0
                 WHEN e.dene_text LIKE ? OR e.english_text LIKE ? THEN 1
                 WHEN e.dene_text LIKE ? OR e.english_text LIKE ? THEN 2
                 ELSE 3 END AS tier
     FROM entries e
     WHERE e.corpus_id = ?
       AND (e.dene_text LIKE ? OR e.english_text LIKE ? OR e.category LIKE ?
            OR e.notes LIKE ? OR e.source_doc LIKE ?)
     ORDER BY tier, e.updated_at DESC LIMIT ?`
  ).all(q, q, `${q}%`, `${q}%`, like, like, corpusId, like, like, like, like, like, POOL)
    .map((r) => ({ id: r.id, boost: r.tier === 0 ? BOOST_EXACT : r.tier === 1 ? BOOST_PREFIX : 0 }));

  let semantic = [];
  if (qvec) {
    // Brute-force cosine over the corpus's current-model vectors (spec §36).
    // A vector from an older model is stale and sits out semantic ranking.
    semantic = db.prepare(
      `SELECT id, embedding FROM entries
       WHERE corpus_id = ? AND embedding IS NOT NULL AND embedding_model = ?`
    ).all(corpusId, MODEL)
      .map((r) => ({ id: r.id, score: cosine(qvec, fromBlob(r.embedding)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, POOL);
  }

  const ids = rrfFuse(keyword, semantic);
  return {
    results: inOrder(ids.slice(0, limit), `${ENTRY_SELECT} WHERE e.id IN`),
    has_more: ids.length > limit,
  };
}

function searchRecordings({ corpusId, q, qvec, limit }) {
  const like = `%${q}%`;
  // Keyword surface (spec §22): parent entry text, speaker, notes, language.
  // Speaker identity lives in two places: the registered speaker row and the
  // legacy free-text field on the recording — search (and rank) both.
  const keyword = db.prepare(
    `SELECT a.id, a.entry_id,
            CASE WHEN lower(e.dene_text) = lower(?) OR lower(e.english_text) = lower(?)
                      OR lower(s.display_name) = lower(?) OR lower(a.speaker) = lower(?) THEN 0
                 WHEN e.dene_text LIKE ? OR e.english_text LIKE ? OR s.display_name LIKE ? OR a.speaker LIKE ? THEN 1
                 ELSE 2 END AS tier
     FROM audio_files a
     JOIN entries e ON e.id = a.entry_id
     LEFT JOIN speakers s ON s.id = a.speaker_id
     WHERE e.corpus_id = ? AND a.is_current = 1
       AND (e.dene_text LIKE ? OR e.english_text LIKE ? OR s.display_name LIKE ?
            OR a.speaker LIKE ? OR a.recording_notes LIKE ? OR a.language = lower(?))
     ORDER BY tier, a.created_at DESC LIMIT ?`
  ).all(q, q, q, q, `${q}%`, `${q}%`, `${q}%`, `${q}%`, corpusId, like, like, like, like, like, q, POOL)
    .map((r) => ({ id: r.id, boost: r.tier === 0 ? BOOST_EXACT : r.tier === 1 ? BOOST_PREFIX : 0 }));

  let semantic = [];
  if (qvec) {
    // A recording inherits semantics from its parent Entry (spec §21).
    semantic = db.prepare(
      `SELECT a.id, e.embedding FROM audio_files a
       JOIN entries e ON e.id = a.entry_id
       WHERE e.corpus_id = ? AND a.is_current = 1
         AND e.embedding IS NOT NULL AND e.embedding_model = ?`
    ).all(corpusId, MODEL)
      .map((r) => ({ id: r.id, score: cosine(qvec, fromBlob(r.embedding)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, POOL);
  }

  // Diversity (spec §22): one matching Entry may not consume the section —
  // at most 2 recordings per Entry make the page.
  const entryOf = new Map(db.prepare(
    `SELECT a.id, a.entry_id FROM audio_files a JOIN entries e ON e.id = a.entry_id
     WHERE e.corpus_id = ? AND a.is_current = 1`
  ).all(corpusId).map((r) => [r.id, r.entry_id]));
  const fused = rrfFuse(keyword, semantic);
  const perEntry = new Map();
  const ids = [];
  let overflow = 0;
  for (const id of fused) {
    const eid = entryOf.get(id);
    const n = perEntry.get(eid) ?? 0;
    if (n >= 2) { overflow++; continue; }
    perEntry.set(eid, n + 1);
    ids.push(id);
  }
  return {
    results: inOrder(ids.slice(0, limit),
      `SELECT a.id, a.entry_id, a.language, a.duration_seconds, a.created_at,
              COALESCE(NULLIF(a.speaker, ''), s.display_name) AS speaker_name, e.dene_text, e.english_text
       FROM audio_files a JOIN entries e ON e.id = a.entry_id
       LEFT JOIN speakers s ON s.id = a.speaker_id WHERE a.id IN`)
      .map((r) => ({ ...r, stream_url: `/api/language/audio/${r.id}/stream` })),
    has_more: ids.length + overflow > limit,
  };
}

function searchDocuments({ corpusId, q, qvec, limit }) {
  // Keyword candidates (spec §19): FTS over extracted blocks, plus
  // title/filename matches. Semantic candidates: current-version
  // document_search_chunks, brute-force cosine. Both fuse at chunk/document
  // level and dedupe to one result per document with its best passage
  // (spec §20).
  const bestBlock = new Map();
  const keyword = [];
  for (const b of searchBlocks({ q, corpusId, limit: POOL })) {
    if (bestBlock.has(b.document_id)) continue;
    bestBlock.set(b.document_id, b);
    keyword.push({ id: b.document_id, boost: 0 });
  }
  const titleRows = db.prepare(
    `SELECT id, title, original_filename FROM documents
     WHERE corpus_id = ? AND status <> 'archived'
       AND (title LIKE ? OR original_filename LIKE ?)
     ORDER BY created_at DESC LIMIT ?`
  ).all(corpusId, `%${q}%`, `%${q}%`, POOL);
  const byId = new Map(keyword.map((k) => [k.id, k]));
  for (const d of titleRows) {
    const boost = d.title.toLowerCase() === q.toLowerCase() ? BOOST_EXACT
      : d.title.toLowerCase().startsWith(q.toLowerCase()) ? BOOST_PREFIX : 0;
    const existing = byId.get(d.id);
    if (existing) existing.boost = Math.max(existing.boost, boost);
    else { const k = { id: d.id, boost }; byId.set(d.id, k); keyword.push(k); }
  }

  // Semantic candidates: best chunk per document, current versions of
  // non-archived documents, current model only (spec §19).
  const semantic = [];
  const bestChunk = new Map();
  let chunkCount = 0;
  if (qvec) {
    const rows = db.prepare(
      `SELECT c.embedding, c.text, c.page_number, c.sheet_name, c.row_number,
              v.document_id
       FROM document_search_chunks c
       JOIN document_versions v ON v.id = c.document_version_id
       JOIN documents d ON d.id = v.document_id
       WHERE d.corpus_id = ? AND d.status <> 'archived'
         AND c.embedding IS NOT NULL AND c.embedding_model = ?
         AND v.version_number = (SELECT MAX(v2.version_number) FROM document_versions v2
                                 WHERE v2.document_id = v.document_id)`
    ).all(corpusId, MODEL);
    chunkCount = rows.length;
    rows.forEach((r) => { r.score = cosine(qvec, fromBlob(r.embedding)); });
    rows.sort((a, b) => b.score - a.score);
    for (const r of rows.slice(0, POOL)) {
      if (bestChunk.has(r.document_id)) continue;
      bestChunk.set(r.document_id, r);
      semantic.push({ id: r.document_id, score: r.score });
    }
  }

  const ids = rrfFuse(keyword, semantic);
  return {
    chunkCount,
    results: inOrder(ids.slice(0, limit),
      `SELECT d.id, d.title, d.extension, d.status, d.created_at FROM documents d WHERE d.id IN`)
      .map((d) => {
        // Prefer the FTS passage (real keyword highlighting); a semantic-only
        // hit shows its best chunk as plain text — no fabricated highlights.
        const hit = bestBlock.get(d.id);
        const chunk = bestChunk.get(d.id);
        return {
          document_id: d.id,
          title: d.title,
          type_label: TYPE_LABEL[d.extension] ?? d.extension,
          status: d.status,
          created_at: d.created_at,
          snippet: hit?.snippet ?? (chunk ? excerpt(chunk.text) : null),
          page_number: hit?.page_number ?? chunk?.page_number ?? null,
          sheet_name: hit?.sheet_name ?? chunk?.sheet_name ?? null,
          row_number: hit?.row_number ?? chunk?.row_number ?? null,
        };
      }),
    has_more: ids.length > limit,
  };
}

/** Plain-text excerpt for semantic-only passages (~160 chars on a word edge). */
function excerpt(text, max = 160) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 60 ? cut.lastIndexOf(' ') : max)} …`;
}

/** One request, one query embedding, three grouped sections (spec §5/§6).
 *  includeDocuments=false (translators, spec §33) omits the documents key
 *  entirely — not even a count leaks. */
export async function masterSearch({ corpusId, q, limit = 5, includeDocuments = true }) {
  const t0 = Date.now();
  let qvec = null;
  let embedMs = 0;
  if (process.env.SEMANTIC_SEARCH_DISABLED !== '1') {
    try {
      const t = Date.now();
      qvec = await embed(q);
      embedMs = Date.now() - t;
    } catch (e) {
      console.error('[search] embed failed — keyword-only fallback:', e.message);
    }
  }
  const timed = (fn) => { const t = Date.now(); const out = fn(); return [out, Date.now() - t]; };
  const [entries, entriesMs] = timed(() => searchEntries({ corpusId, q, qvec, limit }));
  const [documents, documentsMs] = includeDocuments
    ? timed(() => searchDocuments({ corpusId, q, qvec, limit }))
    : [null, 0];
  const [recordings, recordingsMs] = timed(() => searchRecordings({ corpusId, q, qvec, limit }));
  const chunkCount = documents?.chunkCount ?? 0;
  if (documents) delete documents.chunkCount; // instrumentation, not payload
  // Timing only — never the query text (spec §35). document_chunks tracks
  // when brute-force cosine needs replacing (spec §36).
  console.log(`[search] corpus=${corpusId} q_len=${q.length} embed_ms=${embedMs} ` +
    `entries_ms=${entriesMs} documents_ms=${documentsMs} recordings_ms=${recordingsMs} ` +
    `total_ms=${Date.now() - t0} document_chunks=${chunkCount}`);
  return {
    query: q,
    corpus_id: corpusId,
    entries,
    ...(includeDocuments ? { documents } : {}),
    recordings,
    semantic: qvec ? { available: true, model: MODEL } : { available: false },
  };
}

/** Home "latest" feed (spec §24/§25) — recency, not search. Same shapes as
 *  the search sections so the Home UI renders both with one component set. */
export function homeFeed({ corpusId, limit = 5, includeDocuments = true }) {
  const entries = db.prepare(
    `${ENTRY_SELECT} WHERE e.corpus_id = ?
     ORDER BY e.updated_at DESC, e.id DESC LIMIT ?`
  ).all(corpusId, limit);
  const documents = includeDocuments ? db.prepare(
    `SELECT d.id AS document_id, d.title, d.extension, d.status, d.created_at
     FROM documents d WHERE d.corpus_id = ? AND d.status <> 'archived'
     ORDER BY d.created_at DESC, d.id DESC LIMIT ?`
  ).all(corpusId, limit)
    .map((d) => ({ ...d, type_label: TYPE_LABEL[d.extension] ?? d.extension })) : null;
  const recordings = db.prepare(
    `SELECT a.id, a.entry_id, a.language, a.duration_seconds, a.created_at,
            COALESCE(NULLIF(a.speaker, ''), s.display_name) AS speaker_name, e.dene_text, e.english_text
     FROM audio_files a JOIN entries e ON e.id = a.entry_id
     LEFT JOIN speakers s ON s.id = a.speaker_id
     WHERE e.corpus_id = ? AND a.is_current = 1
     ORDER BY a.created_at DESC, a.id DESC LIMIT ?`
  ).all(corpusId, limit)
    .map((r) => ({ ...r, stream_url: `/api/language/audio/${r.id}/stream` }));
  return {
    corpus_id: corpusId,
    entries,
    ...(includeDocuments ? { documents } : {}),
    recordings,
  };
}
