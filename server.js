import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';

import db from './src/db.js';
import { platform, language } from './src/api.js';
import { APP_URL } from './src/mail.js';
import { backfillEmbeddings } from './scripts/embed-backfill.js';
import { backfillAudio } from './scripts/audio-backfill.js';

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(import.meta.dirname, 'public');
const PRIMARY_HOST = new URL(APP_URL).hostname;

// Hostnames that should bounce to the primary origin (the old Dene Voice
// Library host, kept as a redirect only — it is not part of the architecture).
const LEGACY_HOSTS = new Set(
  // ?? not ||: an explicitly empty LEGACY_HOSTS disables the redirect (used
  // while indigenous.ai DNS is not live yet, so app.dene.ca keeps serving).
  (process.env.LEGACY_HOSTS ?? 'app.dene.ca').split(',').map((h) => h.trim()).filter(Boolean)
);

const app = express();
app.disable('x-powered-by');
// In production the app sits behind Fly.io's TLS-terminating proxy
app.set('trust proxy', 1);
app.use(cookieParser());

// Legacy hosts redirect to the Language app on the primary origin. Old
// SPA bookmarks keep working: the #/route fragment is reattached client-side.
app.use((req, res, next) => {
  if (LEGACY_HOSTS.has(req.hostname) && req.hostname !== PRIMARY_HOST && req.method === 'GET') {
    return res.redirect(301, `${APP_URL}/language`);
  }
  next();
});

// APIs: Indigenous.ai platform (identity/tenancy) vs the Language application.
app.use('/api/platform', platform);
app.use('/api/language', language);

// Product root: brand home / sign-in entry / route into Language.
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'landing.html'), {
    headers: { 'Cache-Control': 'no-cache' },
  });
});

// The Language application (SPA) lives at /language.
// no-cache (revalidate every load) for code and markup so deploys show up
// immediately; other static assets can be cached for a day.
app.use('/language', express.static(PUBLIC_DIR, {
  setHeaders: (res, filePath) => {
    if (/\.(js|css|html)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  },
}));
// SPA fallback: any non-API /language path serves the app shell.
app.get('/language/{*splat}', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), {
    headers: { 'Cache-Control': 'no-cache' },
  });
});
// Anything else on the primary origin goes to the landing page.
app.get('/{*splat}', (req, res) => res.redirect('/'));

const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

app.listen(PORT, () => {
  console.log(`Indigenous.ai running at http://localhost:${PORT} (Language at /language)`);
  if (userCount === 0) {
    console.log('');
    console.log('No accounts exist yet. Create the superadmin with:');
    console.log('  npm run create-superadmin -- <email> <name> <password>');
  }
  // Embed any entries missing an English embedding, in the background. Runs in
  // the web process (baked model, NODE_ENV=production) so semantic search has
  // data without a separate/SSH step; idempotent, so it no-ops once caught up.
  backfillEmbeddings((m) => console.log(`[embed] ${m}`))
    .catch((e) => console.error('[embed] backfill failed:', e.message));
  // Hash any recordings missing a checksum and generate missing playback
  // derivatives (idempotent; no-ops once caught up). Best-effort, non-blocking.
  backfillAudio((m) => console.log(`[audio] ${m}`))
    .catch((e) => console.error('[audio] backfill failed:', e.message));
});
