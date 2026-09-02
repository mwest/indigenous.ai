# Indigenous.ai

**Indigenous.ai is the platform — a product for Indigenous governments. Language is its
first application.** This repository is the Indigenous.ai platform codebase: one modular
monolith serving the product root at `https://indigenous.ai` and the Language application
at `https://indigenous.ai/language`.

The Language application is a members-only database of translation pairs with audio
recordings (originally built for the Dene Voice Project; see
`dene-translation-db-prd.md` for the original PRD): projects (dialects/communities),
role-based access, translation entries with full Unicode orthography support, audio
attachments with automatic duration tracking, search and filtering, per-project
dashboards, and CSV/JSON export for STT/TTS training pipelines.

## Architecture: platform vs. application

Module ownership for new code (a direction, not a mandate to move working code):

- **Platform (Indigenous.ai)** — users, authentication/sessions, organizations,
  organization memberships, application entitlements (`organization_apps`), payments
  primitives. API under `/api/platform/...` (the `platform` router in `src/api.js`).
- **Language application** — projects, entries, recordings, consent, work items,
  compensation views, search, exports, public translation-request intake. API under
  `/api/language/...` (the `language` router in `src/api.js`). Routes are gated by the
  org-level `language` app entitlement.

Within Language, the **corpus** is the permanent home of the language data (entries,
recordings, sessions belong to it); a **project is a campaign** of funded work on a
corpus. Multiple campaigns may contribute to one corpus (`POST /projects` with
`corpus_id`), import dedup is corpus-wide, closing a campaign (`status: 'closed'`)
stops new work claims without touching the corpus, and a campaign sharing its corpus
cannot be deleted — only a corpus's sole campaign may delete both, name-confirmed.

Organization identity is platform-wide; operational permissions are application-scoped.
Do not treat a Language role (e.g. `translator`) as a platform role, and do not
generalize Language domain concepts (speakers, corpora, orthographies) into platform
concepts until a second real application proves the abstraction. `app.dene.ca` is a
redirect only — it is not part of the architecture.

## Stack

- **Node.js 20+** (tested on 22), Express 5
- **SQLite** (better-sqlite3) — single file at `data/dene.db`, WAL mode
- Audio files stored on disk at `data/audio/<userID>/`, duration extracted with `music-metadata`
- In-browser recording: microphone PCM is saved as a lossless 16-bit WAV master;
  the server generates a mono MP3 playback derivative with ffmpeg (#8b)
- No-build vanilla JS frontend in `public/`
- Everything self-hostable — no cloud services required (relevant to the OCAP / data
  sovereignty open question in the PRD)

## Getting started

```powershell
npm install
npm run create-superadmin -- you@example.com "Your Name" "a-strong-password"
npm start          # http://localhost:3000  (set PORT to change)
```

Sign in as the superadmin, create a project from the **Dashboard**, then add members from
the project card → **Members** (existing accounts are added by email; new accounts need a
name and temporary password). Organization admins create projects and assign project
admins; project admins manage their own project's members. There is no public signup.

## Roles

| Role | Powers |
|---|---|
| Superadmin | Platform only: accounts, translation-service requests, provisioning organizations. **No corpus access** without an org/project role |
| Org owner / org admin | Full authority over their organization's projects: create/edit/delete projects, assign project admins, compensation, exports |
| Project admin | Manage members, review/verify entries, export, edit any entry — in their project only |
| Member | Create entries, edit/delete their own entries, upload audio, search within their projects |
| Translator | Recording and translating through claimed work sessions, plus read-only browsing of the Dictionary and Phrases. Can complete an entry's missing side via the translation session but cannot otherwise create or edit entries |

Translators land on a dashboard with a **Start recording session** button and, whenever
phrases are awaiting translation, a count and a **Start translations session** button.
The recording session shows the Dene text large, the English below it, a record/playback
control, and the entry's metadata. The translation session shows two text boxes (the Dene
phrase/word and the English translation) plus the same metadata, so the translator fills
the missing side. Both sessions use **Save & next** / **Save & exit** / **Skip** to move
through the queue. Project admins assign the role from the project's **Members** page.

Removing a member takes effect immediately (membership is checked on every request);
their past contributions remain attributed to them.

## Dictionary & Phrases

Entries come in two kinds, distinguished by a `kind` column (`word` | `phrase`)
on the shared `entries` table — they share all the same machinery (recording,
review status, search, audio, export). The **Dictionary** tab lists words; the
**Phrases** tab lists phrases.

The one behavioural difference: a **dictionary word requires both the Dene and
English sides**, while a **phrase may be saved with only one side** (the other
left blank). A one-sided phrase is flagged **"Needs translation"** and is
completed either from its normal edit screen or through a translator's
**translation session**. Once both sides are present, the phrase behaves like
any entry and flows into the **same recording queue** as words (an incomplete phrase is held
out of the queue and can't be recorded until it's translated). Filter the
Phrases list by translation state with the "Needs translation / Complete"
selector.

**Import/export by kind.** CSV import (org admins) has an *Import as* selector —
**Dictionary words** or **Phrases**. Every row with text in either column imports
(one-sided rows are queued for translation); it recognises a
`dene_text`/`english_text` header and accepts just one of them. Dedup is scoped
per kind, so the same text can exist as both a word and a phrase. Each list tab has its own **Export CSV/JSON** (admins) that exports just
that kind (`?kind=word|phrase`); the project card's export still produces the
full project, with a `kind` column distinguishing words from phrases.

## Recording audio

Each entry shows two recording slots per user: **Dene** and **English**. Click record,
speak, click **Stop & save** — the clip is captured as a lossless WAV master, tagged with
its language and the speaker, and attached automatically. Each user has at most **one
current recording per language per entry**; re-recording or re-uploading the same
language creates a **new version** and keeps the previous master in version history
(never destroyed). Recordings are **visible to the whole project** — every member can
see and play all recordings on entries in their projects; editing or deleting a
recording is restricted to its uploader and project admins.
Uploading existing files (WAV/MP3/M4A) is still available under
"Upload an audio file instead". Microphone access requires a secure context:
`localhost` works out of the box; a LAN/production deployment needs HTTPS.

## Public translation requests

People outside the app can ask for a translation: the sign-in page links to a public
form (`#/request`) where they enter their email and receive a unique, single-use form
link (valid 7 days). The form fixes the email server-side and collects name, required
Dene dialect, details, and up to 5 files (100 MB each; documents, images, audio, video,
zip). On submission every superadmin gets an email with the details and a link into the
app, where requests appear under the **Translation Jobs** tab (superadmin-only) with
the uploaded files viewable/downloadable. Public endpoints are rate-limited; uploaded
files are always served as attachments (audio may stream inline) so untrusted content
never executes on the app origin.

## Compensation

Optional tracking of translator pay (organization admins, under the **Compensation**
tab). Each translator has flat **per-project rates** — one for recording, one for
translation — that can change at any time. As translators record clips and complete
phrase translations, each billable action is logged once into an **append-only ledger**
with the amount **snapshotted at that moment**, so a later rate change only affects
future work (and re-recording a clip doesn't double-bill). Work logged before a rate is
set is recorded at $0 and can be re-priced with a manual **adjustment** (positive or
negative, with a note).

Balances **aggregate per translator** across all their projects:
`balance = sum(work) − sum(payments)`. **Payments are recorded, not moved** — the app
never touches money; an org admin logs payments made offline (e-transfer, cheque, …)
for bookkeeping. Translators see their own running *earned / paid / balance* on their
dashboard. All amounts are stored as integer cents (CAD). Rate changes are kept in an
audit table.

## Semantic search

The Dictionary and Phrases lists have a **Smart search** toggle. With it on, the
query is matched by *meaning* against the English side — so "greeting" surfaces
"how are you" — rather than by substring; exact keyword matches are boosted to
the top (hybrid). Plain substring search is the default and is unchanged.

Embeddings are produced by a **local** sentence-transformer
(`Xenova/all-MiniLM-L6-v2`, 384-dim) run on-device with `transformers.js` —
the text never leaves the server. Each entry's English embedding is stored as a
`BLOB` on the `entries` row (with the model name, so a model change can be
detected); ranking is a brute-force cosine in memory, which is ample at this
corpus size. The model weights (~90 MB) download once to `data/models` on the
volume and persist across deploys. After deploying, run a one-time backfill for
existing rows:

```powershell
node scripts/embed-backfill.js          # local
bash scripts/prod-ssh.sh "node scripts/embed-backfill.js"   # production
```

Semantic search covers the **English** side only (the Dene side is low-resource
with no good embedding model). The production VM runs with 1 GB memory to fit
the model alongside Node + SQLite.

## Data layout

- `data/dene.db` — SQLite database (users, sessions, projects, memberships, entries,
  audio_files, translation_requests, request_files)
- `data/audio/<userID>/<file>` — audio files, organized per uploader (random file names;
  original filenames kept in the DB)
- `data/requests/<requestID>/<file>` — files uploaded with public translation requests
- Exports reference audio as `audio/<userID>/<file>`, so an export plus a copy of
  `data/audio/` is a complete training bundle. Recordings carry a `language` tag
  (`dene` or `english`); the CSV export has separate `dene_audio_files` and
  `english_audio_files` columns.

Back up by copying the `data/` directory.

## Database migrations

Schema changes are versioned migrations in `migrations/` (`NNN_name.sql` or
`NNN_name.js` exporting `up(db)`), applied in numeric order at boot and recorded
(with checksums) in `schema_migrations`. Each migration runs exactly once, inside
a transaction (a `.js` migration may export `transaction = false` to manage its
own — required when toggling `PRAGMA foreign_keys` for a table rebuild). A failed
migration rolls back and the app refuses to start; the app also refuses to run
against a database whose recorded schema is newer than the code knows.

`001_baseline` builds the full current schema on fresh databases and upgrades any
historical database (back to day one) in place — restored old backups are safe.
Applied migration files are frozen; put changes in a new numbered file.

```powershell
npm run migrations:status     # applied + pending, without applying anything
npm run test:migrations       # fresh/legacy/rollback/rerun/downgrade tests
```

`npm test` runs the migration tests first, then the full smoke suite; CI runs
both on every change.

## API

JSON API with cookie sessions, split by module. Highlights:

Platform (`/api/platform`):
- `POST /login`, `POST /logout`, `GET /me`, `POST /me/password`, `POST /me/name`
- `GET/POST /orgs`, `GET/POST /orgs/:id/members`, `PUT /orgs/:id/apps/:code` (superadmin:
  enable/disable an application for an organization)
- Superadmin user management: `GET/POST /users`, `PATCH/DELETE /users/:id`

Language (`/api/language`, gated by the org's `language` entitlement):
- `GET/POST /projects`, `GET /projects/:id/stats`, `GET /projects/:id/export?format=csv|json`
- `GET/POST /projects/:id/members`, `DELETE /projects/:id/members/:userId`
- `GET/POST /entries` (filters: `q`, `project_id`, `has_audio`, `contributor`, `status`),
  `GET/PATCH/DELETE /entries/:id`
- `POST /entries/:id/audio` (multipart; fields: `file`, `language` (`dene`|`english`),
  `speaker`, `recording_notes`), `GET /audio/:id/stream`, `PATCH/DELETE /audio/:id`
- Public (no session): `POST /requests/start` (emails a form link),
  `GET/POST /requests/form/:token` (the form; POST is multipart with up to 5 `files`)
- Superadmin: `GET /requests`, `GET/DELETE /requests/:id`, `GET /requests/files/:id/download`

Audio uploads accept WAV, MP3, and M4A up to 500 MB; corrupt or unreadable files are
rejected with a clear message and the entry is left unchanged.

## Deployment (Fly.io, Toronto)

The app runs at https://indigenous.ai on Fly.io in the `yyz` (Toronto) region — data
stays in Canada. Config is in `fly.toml`; the SQLite DB and all audio live on a 10 GB
encrypted volume (`dene_data`) mounted at `/app/data`, with automatic daily snapshots
(5-day retention). The Fly app keeps its historical internal name
(`dene-translation-db` — Fly apps can't be renamed); the product origin is set by DNS +
certs. `app.dene.ca` remains only as a 301 redirect to `https://indigenous.ai/language`
(hosts listed in `LEGACY_HOSTS`); set `APP_URL` to change the primary origin.

Common operations (flyctl):

```powershell
fly deploy --remote-only --ha=false   # ship the current working tree
fly logs                              # tail production logs
fly status                            # machine state
fly ssh console                       # shell on the production machine
fly certs check indigenous.ai         # TLS certificate status (also: app.dene.ca redirect cert)
fly ssh console -C "node scripts/create-superadmin.js <email> <name> <password>"
```

Offsite backup (pulls the SQLite DB; run after `fly ssh console -C "sqlite3 ..."` or
just grab the whole data dir via sftp):

```powershell
fly ssh sftp get /app/data/dene.db ./backup/dene.db
```

## Production notes

- Run behind HTTPS (the session cookie is marked `Secure` when `NODE_ENV=production`).
- The `projects.is_public` column exists for a future public corpus face but nothing
  reads it yet.

## Platform administration vs. data ownership

Corpus authority belongs to **organizations**, not the platform operator. A
superadmin (`is_superadmin`) handles platform concerns — accounts, translation
service requests, provisioning orgs — and has **no implicit access** to any
project's entries, recordings, compensation, or exports. All corpus authority
flows from `organization_memberships` (`owner_admin`/`admin`) or per-project
`memberships`. A one-time migration attached existing projects to the
"Dene Voice Project" organization and granted `owner_admin` to the superadmins
that existed at that moment — explicit and revocable, managed on the
Organization page.

Bootstrap on a fresh install: `npm run create-superadmin -- <email> <name> <pw>`,
sign in, `POST /api/orgs` (the creator becomes owner_admin), then create
projects. If operator support access to a corpus is ever needed, grant a
temporary org membership (visible on the Organization page) rather than adding
any invisible bypass; a formal audited "break glass" flow is future work.
