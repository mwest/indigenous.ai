# Document API (v1)

All routes live under `/api/language`, are cookie-authenticated, corpus-scoped
and entitlement-aware. Policy: browse/search/download for **members and
admins** of the corpus's organization; upload for members+; reprocess /
archive / restore / delete for **admins**. Translators have no document access
in v1. Statuses: `uploaded → extracting → indexing → ready` (`failed`,
`archived`).

## `GET /documents?corpus_id&q&status&type&limit&offset`
```json
{ "documents": [ { "id": 1, "uid": "…", "title": "Dene Dictionary 1993",
    "original_filename": "dictionary.pdf", "extension": ".pdf", "type_label": "PDF",
    "status": "ready", "size_bytes": 31457280, "uploaded_by_name": "Mary",
    "created_at": "…", "block_count": 412,
    "excerpt": { "snippet": "… [łue] …", "page_number": 47 } } ],
  "total": 1, "limit": 50, "offset": 0 }
```
`excerpt` only when `q` is given. Archived documents are excluded unless
`status=archived`.

## `POST /documents` (multipart)
Fields: `file` (required), `corpus_id` (required), `title`, `origin_project_id`.
Returns `201` with the document row (`status: "uploaded"` — extraction runs in
the background). `409 { error, existing: {id, uid, title, status} }` for the
same bytes already in the corpus. `400` for unsupported formats, signature
mismatches, oversize (`DOCUMENT_MAX_UPLOAD_MB`, default 100).

## `GET /documents/:id`
Document row plus `type_label`, `version {id, uid, version_number, size_bytes,
sha256, created_at}`, `extraction` (extractor metadata: page/sheet/row counts,
`requires_ocr`, `sheets: [{name, rows, headers}]`…), `block_count`,
`linked_entry_count`, `can_manage`.

## `GET /documents/:id/blocks?page&sheet&limit&offset`
```json
{ "blocks": [ { "id": 9, "ordinal": 1, "block_type": "sheet_row",
    "text": "fish | łue | animals", "page_number": null, "sheet_name": "Dictionary",
    "row_number": 2, "location_json": null,
    "metadata_json": "{\"cells\":{\"English\":\"fish\",\"Dene\":\"łue\"}}" } ],
  "total": 4281, "limit": 100, "offset": 0 }
```

## `GET /documents/search?corpus_id&q&limit&offset` · `GET /documents/:id/search?q`
```json
{ "results": [ { "document_id": 12, "document_uid": "…", "title": "…",
    "extension": ".pdf", "block_id": 800, "block_type": "page_text",
    "page_number": 47, "sheet_name": null, "row_number": null, "ordinal": 46,
    "snippet": "… [matching] passage …", "rank": -3.18 } ] }
```
FTS5, `unicode61 remove_diacritics 0` — exact orthography is authoritative.

## `GET /documents/:id/original`
The immutable original bytes as an attachment (auth-gated; storage paths are
never exposed).

## `POST /documents/:id/reprocess` → `{ ok, status: "uploaded" }`
Rebuilds blocks + index for the current version; never touches the original
bytes, sha256, uploader, or created_at.

## `POST /documents/:id/archive` / `POST /documents/:id/restore`
Archive hides from browse/search, keeps the original and provenance; restore
returns it.

## `DELETE /documents/:id` — body `{ "confirm_title": "<exact title>" }`
Admin-only. Refused (409) while entries cite the document
(`entry_document_sources`) — archive instead.
