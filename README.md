# indigenous.ai

A minimal user system: superadmin-managed accounts with email invites,
password reset, and change-password — built to test the whole stack end to end
before layering on real features.

- **Node.js 22 + Express 5**, ES modules, no build step
- **SQLite** via `better-sqlite3` (one file in `data/`, WAL mode; schema is
  created idempotently in `src/db.js`)
- **No-build vanilla-JS SPA** in `public/` (hash routing, SPA fallback,
  no-cache on js/css/html)
- **Cookie sessions** + `bcryptjs`, `crypto` random tokens for invites/resets,
  `requireAuth` / `requireSuperadmin` middleware
- **Email via Resend** (plain `fetch`, no SDK), degrading gracefully when
  `RESEND_API_KEY` is unset (the invite/reset link is shown to copy instead)

## Run locally (Windows / PowerShell)

```powershell
npm install
npm run create-superadmin -- mike@indigenous.ai Mike change-me-now-2026
npm start
```

Open http://localhost:3000 and sign in. Without `RESEND_API_KEY` set, invite and
reset links are shown in the UI (and returned by the API in non-production) so
you can copy them.

## Smoke test

With the server running (and the superadmin seeded above) in a second terminal:

```powershell
npm run smoke-test
```

It exercises login/logout, invite → accept (set name + password), forgot/reset,
change-password, the superadmin-only Members guards, resend invite, and remove.

## Environment variables

| Variable          | Purpose                                              | Default                                   |
| ----------------- | ---------------------------------------------------- | ----------------------------------------- |
| `PORT`            | HTTP port                                            | `3000` (`8080` in Docker/Fly)             |
| `NODE_ENV`        | `production` hardens cookies; hides dev links        | unset                                     |
| `APP_URL`         | Base URL used in emailed links                       | `https://indigenous.ai`                   |
| `RESEND_API_KEY`  | Enables outbound email via Resend                    | unset (links shown instead)               |
| `MAIL_FROM`       | From address (must be a verified Resend identity)    | `indigenous.ai <noreply@send.indigenous.ai>` |

Secrets are only ever set as environment variables / Fly secrets — never
committed.

## Deploy

Fly.io, region `yyz` (Toronto), a single always-on machine with SQLite on a
volume mounted at `/app/data`. See `fly.toml` and `Dockerfile`.
