/* Indigenous.ai — Language: single-page app (no build step) */
'use strict';

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

// Identity/tenancy routes live on the Indigenous.ai platform API; everything
// else is the Language application API. (/me/compensation is Language, and so
// are the org-scoped consent-profile routes — consent is a Language concern.)
const PLATFORM_API =
  /^\/(login$|logout$|password\/|me$|me\/(password|name)$|orgs$|orgs\/|users$|users\/|admin\/)/;
const apiUrl = (path) =>
  (path.includes('/consent-profiles') || PLATFORM_API.test(path) === false
    ? '/api/language'
    : '/api/platform') + path;

async function api(path, opts = {}) {
  const res = await fetch(apiUrl(path), {
    headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body instanceof FormData ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== '/login') {
    // Session expired or not signed in — but a 401 from the login attempt
    // itself must fall through so the form can show "Invalid email or password".
    state.me = null;
    renderLogin();
    throw new ApiError('Not signed in', 401);
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status);
  return data;
}

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// ---------------------------------------------------------------------------
// State & utilities
// ---------------------------------------------------------------------------

const state = {
  me: null,          // { user, projects, orgs }
  corpora: [],       // visible collections (GET /corpora)
  activeOrgId: Number(localStorage.getItem('activeOrgId')) || null,
  activeCorpusId: Number(localStorage.getItem('activeCorpusId')) || null,
  activeProjectId: Number(localStorage.getItem('activeProjectId')) || null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDuration(seconds) {
  seconds = Math.round(seconds || 0);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtHours(seconds) {
  return ((seconds || 0) / 3600).toFixed(2);
}

// Integer cents -> "$1,234.56" (negative shown as "-$1.00").
function fmtMoney(cents) {
  const n = (cents || 0) / 100;
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtBytes(bytes) {
  bytes = bytes || 0;
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

function fmtDate(sqlite) {
  if (!sqlite) return '';
  // SQLite datetime('now') is UTC
  const d = new Date(sqlite.replace(' ', 'T') + 'Z');
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isError ? 'error' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// The active ORGANIZATION scopes the whole top bar: its name is the brand,
// and the project switcher offers only its projects.
function activeOrg() {
  const orgs = state.me?.orgs ?? [];
  return orgs.find((o) => o.id === state.activeOrgId) || orgs[0] || null;
}

/** Projects belonging to the active organization. */
function orgProjects() {
  const projects = state.me?.projects ?? [];
  const org = activeOrg();
  return org ? projects.filter((p) => p.organization_id === org.id) : projects;
}

// The active CORPUS ("Collection" in the UI) is the content context for the
// Library (nav spec §7): Entries, Recordings, Speakers browse the corpus.
// Projects/campaigns scope only funded WORK.
function orgCorpora() {
  const org = activeOrg();
  return org ? state.corpora.filter((c) => c.organization_id === org.id) : [];
}

function activeCorpus() {
  const corpora = orgCorpora();
  return corpora.find((c) => c.id === state.activeCorpusId) || corpora[0] || null;
}

function setActiveCorpus(id) {
  state.activeCorpusId = Number(id);
  localStorage.setItem('activeCorpusId', state.activeCorpusId);
  // Keep the active campaign on this corpus where possible.
  const inCorpus = corpusProjects();
  if (!inCorpus.some((p) => p.id === state.activeProjectId)) {
    state.activeProjectId = inCorpus[0]?.id ?? orgProjects()[0]?.id ?? null;
    localStorage.setItem('activeProjectId', state.activeProjectId ?? '');
  }
}

/** Campaigns operating on the active corpus. */
function corpusProjects() {
  const corpus = activeCorpus();
  return corpus ? orgProjects().filter((p) => p.corpus_id === corpus.id) : orgProjects();
}

function setActiveOrg(id) {
  state.activeOrgId = Number(id);
  localStorage.setItem('activeOrgId', state.activeOrgId);
  // Reset corpus + campaign into the new organization.
  const corpora = orgCorpora();
  if (!corpora.some((c) => c.id === state.activeCorpusId)) {
    setActiveCorpus(corpora[0]?.id ?? null);
  } else {
    setActiveCorpus(state.activeCorpusId);
  }
}

function activeProject() {
  const projects = orgProjects();
  return projects.find((p) => p.id === state.activeProjectId) || corpusProjects()[0] || projects[0] || null;
}

function setActiveProject(id) {
  state.activeProjectId = Number(id);
  localStorage.setItem('activeProjectId', state.activeProjectId);
}

// Project authority comes from the role the server computed (org admins get
// role 'admin' on their org's projects) — being platform superadmin grants none.
function isAdminOf(projectId) {
  const p = (state.me?.projects ?? []).find((x) => x.id === Number(projectId));
  return p?.role === 'admin';
}

// Org admin of at least one organization (drives compensation + org pages).
function isOrgAdmin() {
  return (state.me?.orgs ?? []).some((o) => o.role === 'owner_admin' || o.role === 'admin');
}
function isOrgOwner() {
  return (state.me?.orgs ?? []).some((o) => o.role === 'owner_admin');
}

// Translators get a focused work-first view of the app. Flat model: the role
// is organization-wide.
function isTranslator() {
  return activeOrg()?.role === 'translator';
}

// Admin of the ACTIVE organization (drives the Manage section).
function isActiveOrgAdmin() {
  return ['owner_admin', 'admin'].includes(activeOrg()?.role);
}

// ---------------------------------------------------------------------------
// Microphone recorder — captures raw PCM and saves a lossless 16-bit PCM WAV
// master. The WAV is the source of truth; lossy playback/training derivatives
// are generated server-side from it (see change #8). We deliberately do NOT
// encode to MP3 in the browser: that permanently discards source quality.
// ---------------------------------------------------------------------------

// Build a mono 16-bit PCM WAV Blob (RIFF/WAVE) from Int16 samples.
function encodeWavPcm16(int16, sampleRate) {
  const dataSize = int16.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true);                    // mono
  dv.setUint32(24, sampleRate, true);           // sample rate
  dv.setUint32(28, sampleRate * 2, true);       // byte rate = rate * blockAlign
  dv.setUint16(32, 2, true);                    // block align (mono * 16-bit)
  dv.setUint16(34, 16, true);                   // bits per sample
  writeStr(36, 'data'); dv.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < int16.length; i++) { dv.setInt16(off, int16[i], true); off += 2; }
  return new Blob([buf], { type: 'audio/wav' });
}

const Recorder = {
  session: null,

  async start() {
    // Ask for unprocessed capture; browsers may ignore some constraints, so we
    // record the sample rate the capture chain actually used (from the context).
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: { ideal: 48000 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    // Prefer a 48 kHz context where supported; fall back to the device default.
    let ctx;
    try { ctx = new AudioContext({ sampleRate: 48000 }); }
    catch { ctx = new AudioContext(); }
    const source = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    source.connect(proc);
    proc.connect(ctx.destination);
    this.session = { stream, ctx, source, proc, chunks };
  },

  async teardown() {
    const s = this.session;
    this.session = null;
    if (!s) return null;
    s.proc.disconnect();
    s.source.disconnect();
    s.stream.getTracks().forEach((t) => t.stop());
    const sampleRate = s.ctx.sampleRate;
    await s.ctx.close();
    return { chunks: s.chunks, sampleRate };
  },

  /** Stop and return a lossless mono 16-bit PCM WAV Blob. */
  async stop() {
    const rec = await this.teardown();
    if (!rec) return null;
    const total = rec.chunks.reduce((n, c) => n + c.length, 0);
    const samples = new Int16Array(total);
    let off = 0;
    for (const c of rec.chunks) {
      for (let i = 0; i < c.length; i++) {
        const v = Math.max(-1, Math.min(1, c[i]));
        samples[off++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
    }
    return encodeWavPcm16(samples, rec.sampleRate);
  },

  async cancel() {
    await this.teardown();
  },
};

// Label of the mic chosen during preflight, attached to recordings as provenance.
let micDeviceLabel = null;

// Quick microphone check before a recording session: confirms audio is arriving,
// shows the selected mic, and warns about clipping or a very low signal — enough
// to avoid a whole session of unusable takes without turning into a mixing desk.
// Renders into `container`; resolves true to proceed, false to cancel. Holds its
// OWN mic stream and tears it down before returning, so the real Recorder opens a
// fresh one (never two streams at once).
function micPreflight(container) {
  return new Promise((resolve) => {
    container.innerHTML = `
      <div class="card preflight">
        <h2 style="margin-top:0">🎙️ Microphone check</h2>
        <p class="preflight-device" id="pf-device">Requesting microphone…</p>
        <div class="preflight-meter"><div class="preflight-level" id="pf-level"></div></div>
        <p class="preflight-hint" id="pf-hint">Say a few words at your normal volume.</p>
        <div class="rec-actions">
          <button class="secondary" id="pf-cancel">Cancel</button>
          <button id="pf-start" disabled>Start recording</button>
        </div>
      </div>`;
    let stream = null, ctx = null, raf = 0;
    const cleanup = () => {
      cancelAnimationFrame(raf);
      if (ctx) ctx.close().catch(() => {});
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null; ctx = null;
    };
    const finish = (ok) => { cleanup(); resolve(ok); };
    $('#pf-cancel', container).addEventListener('click', () => finish(false));

    navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    }).then(async (s) => {
      stream = s;
      const track = s.getAudioTracks()[0];
      micDeviceLabel = track?.label || null;
      $('#pf-device', container).textContent = micDeviceLabel ? `Using: ${micDeviceLabel}` : 'Microphone ready';
      $('#pf-start', container).disabled = false;
      $('#pf-start', container).addEventListener('click', () => finish(true));

      ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(s).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const level = $('#pf-level', container);
      const hint = $('#pf-hint', container);
      let clipped = false, sawSignal = false;
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let peak = 0, sum = 0;
        for (const v of buf) { const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        level.style.width = `${Math.min(100, Math.round(peak * 100))}%`;
        if (peak >= 0.99) { clipped = true; level.style.background = 'var(--danger, #c0392b)'; }
        if (rms > 0.02) sawSignal = true;
        hint.textContent = clipped
          ? '⚠️ Too loud — move back or lower the input level to avoid clipping.'
          : sawSignal ? '✓ Sounds good.' : 'Say a few words at your normal volume.';
        raf = requestAnimationFrame(tick);
      };
      tick();
    }).catch(() => {
      $('#pf-device', container).textContent = 'Could not access the microphone — check browser permissions.';
    });
  });
}

// ---------------------------------------------------------------------------
// Modal helper
// ---------------------------------------------------------------------------

function openModal(innerHtml) {
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal">${innerHtml}</div>`;
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
  document.body.appendChild(backdrop);
  return backdrop;
}
function closeModal() {
  $('.modal-backdrop')?.remove();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// App shell: compact header + role-aware sidebar (nav spec §4/§5). The
// sidebar carries the Organization and Collection context; navigation is
// grouped into Library / Work / Manage / Platform admin.
// ---------------------------------------------------------------------------

function navLink(href, label) {
  return `<a href="${href}" data-nav="${href}">${label}</a>`;
}

function renderShell() {
  const bar = $('#appbar');
  const shell = $('#shell');
  const sidebar = $('#sidebar');
  if (!state.me) {
    bar.hidden = true;
    sidebar.hidden = true;
    shell.classList.add('no-nav');
    return;
  }
  bar.hidden = false;
  sidebar.hidden = false;
  shell.classList.remove('no-nav');
  $('#user-menu-btn').textContent = `${state.me.user.name} ▾`;

  const orgs = state.me.orgs;
  const org = activeOrg();
  const corpora = orgCorpora();
  const corpus = activeCorpus();
  const translator = isTranslator();
  const admin = isActiveOrgAdmin();

  const contextHtml = `
    <div class="nav-context">
      <label>Organization
        ${orgs.length > 1
          ? `<select id="org-switcher">${orgs.map((o) =>
              `<option value="${o.id}" ${o.id === org?.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>`
          : `<span class="context-fixed">${esc(org?.name ?? 'indigenous.ai')}</span>`}
      </label>
      ${corpora.length ? `
      <label>Collection
        ${corpora.length > 1
          ? `<select id="corpus-switcher">${corpora.map((c) =>
              `<option value="${c.id}" ${c.id === corpus?.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`
          : `<span class="context-fixed">${esc(corpus?.name ?? '')}</span>`}
      </label>` : ''}
    </div>`;

  const sections = [];
  sections.push(`<div class="nav-section">${navLink('#/home', 'Home')}</div>`);
  if (translator) {
    sections.push(`<div class="nav-section"><h3>Work</h3>
      ${navLink('#/record', 'Record')}
      ${navLink('#/translate', 'Translate')}</div>`);
    sections.push(`<div class="nav-section"><h3>Library</h3>
      ${navLink('#/entries', 'Entries')}</div>`);
    sections.push(`<div class="nav-section"><h3>Account</h3>
      ${navLink('#/earnings', 'Earnings')}</div>`);
  } else {
    sections.push(`<div class="nav-section"><h3>Library</h3>
      ${navLink('#/entries', 'Entries')}
      ${navLink('#/recordings', 'Recordings')}
      ${navLink('#/speakers', 'Speakers')}
      ${navLink('#/documents', 'Documents')}</div>`);
    sections.push(`<div class="nav-section"><h3>Work</h3>
      ${navLink('#/record', 'Record')}
      ${navLink('#/translate', 'Translate')}
      ${admin ? navLink('#/projects', 'Projects') : ''}</div>`);
    if (admin) {
      sections.push(`<div class="nav-section"><h3>Manage</h3>
        ${navLink('#/people', 'People')}
        ${navLink('#/compensation', 'Compensation')}
        ${navLink('#/consent', 'Consent')}</div>`);
    }
  }
  if (state.me.user.is_superadmin) {
    sections.push(`<div class="nav-section"><h3>Platform admin</h3>
      ${navLink('#/orgs', 'Organizations')}
      ${navLink('#/users', 'Users')}
      ${navLink('#/jobs', 'Service Requests')}</div>`);
  }
  sidebar.innerHTML = contextHtml + sections.join('');

  $('#org-switcher')?.addEventListener('change', (e) => {
    setActiveOrg(e.target.value);
    listState.contributor = '';
    listState.offset = 0;
    renderShell();
    route();
  });
  $('#corpus-switcher')?.addEventListener('change', (e) => {
    setActiveCorpus(e.target.value);
    listState.contributor = '';
    listState.offset = 0;
    renderShell();
    route();
  });
  setActiveNav(location.hash || '#/home');
}

// Legacy alias: many views call renderTopbar() after role/context changes.
const renderTopbar = renderShell;

/** Mark the sidebar link for the current route (aria-current for a11y).
 *  Accepts a #/hash or a legacy section name from older call sites. */
function setActiveNav(navHash) {
  let hash = String(navHash ?? '');
  if (!hash.startsWith('#')) {
    const alias = { dashboard: 'home', phrases: 'entries', org: 'people' };
    hash = '#/' + (alias[hash] || hash);
  }
  // Detail routes highlight their section (e.g. #/entries/123 -> #/entries).
  const base = hash.replace(/^(#\/[a-z-]+).*/, '$1');
  document.querySelectorAll('#sidebar a').forEach((a) => {
    if (a.dataset.nav === base || a.dataset.nav === hash) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

// Mobile drawer: toggle button + backdrop + Escape all close it.
function closeDrawer() {
  $('#shell').classList.remove('nav-open');
  $('#sidebar-backdrop').hidden = true;
  $('#nav-toggle').setAttribute('aria-expanded', 'false');
}
$('#nav-toggle').addEventListener('click', () => {
  const open = !$('#shell').classList.contains('nav-open');
  $('#shell').classList.toggle('nav-open', open);
  $('#sidebar-backdrop').hidden = !open;
  $('#nav-toggle').setAttribute('aria-expanded', String(open));
});
$('#sidebar-backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#shell').classList.contains('nav-open')) closeDrawer();
});
$('#sidebar').addEventListener('click', (e) => {
  if (e.target.closest('a')) closeDrawer(); // navigating dismisses the drawer
});

$('#user-menu-btn').addEventListener('click', () => {
  const dd = $('#user-menu-dropdown');
  dd.hidden = !dd.hidden;
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.user-menu')) $('#user-menu-dropdown').hidden = true;
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  state.me = null;
  location.hash = '';
  renderLogin();
});

$('#change-password-btn').addEventListener('click', () => {
  $('#user-menu-dropdown').hidden = true;
  const m = openModal(`
    <h2>Change password</h2>
    <form id="pw-form">
      <label class="field"><span>Current password</span>
        <input type="password" name="current" required autocomplete="current-password"></label>
      <label class="field"><span>New password (min 8 characters)</span>
        <input type="password" name="next" required minlength="8" autocomplete="new-password"></label>
      <p class="error-msg" hidden></p>
      <div class="form-actions">
        <button type="submit">Save</button>
        <button type="button" class="ghost" onclick="document.querySelector('.modal-backdrop').remove()">Cancel</button>
      </div>
    </form>`);
  $('#pw-form', m).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/me/password', {
        method: 'POST',
        body: { current_password: f.current.value, new_password: f.next.value },
      });
      closeModal();
      toast('Password updated');
    } catch (err) { showFormError(f, err.message); }
  });
});

$('#change-name-btn').addEventListener('click', () => {
  $('#user-menu-dropdown').hidden = true;
  const m = openModal(`
    <h2>Change name</h2>
    <form id="name-form">
      <label class="field"><span>Your name</span>
        <input type="text" name="name" required value="${esc(state.me.user.name)}" autocomplete="name" autofocus></label>
      <p class="error-msg" hidden></p>
      <div class="form-actions">
        <button type="submit">Save</button>
        <button type="button" class="ghost" onclick="document.querySelector('.modal-backdrop').remove()">Cancel</button>
      </div>
    </form>`);
  $('#name-form', m).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api('/me/name', { method: 'POST', body: { name: f.name.value } });
      state.me.user.name = r.name;
      closeModal();
      renderTopbar();
      toast('Name updated');
    } catch (err) { showFormError(f, err.message); }
  });
});

function showFormError(form, msg) {
  const p = $('.error-msg', form);
  if (p) { p.textContent = msg; p.hidden = false; }
  else toast(msg, true);
}

// ---------------------------------------------------------------------------
// Login view
// ---------------------------------------------------------------------------

function renderLogin() {
  renderTopbar();
  view.innerHTML = `
    <div class="login-wrap">
      <div class="brand-big">indigenous.ai</div>
      <div class="card">
        <form id="login-form">
          <label class="field"><span>Email</span>
            <input type="email" name="email" required autocomplete="email" autofocus></label>
          <label class="field"><span>Password</span>
            <input type="password" name="password" required autocomplete="current-password"></label>
          <p class="error-msg" hidden></p>
          <button type="submit" style="width:100%">Sign in</button>
          <p style="text-align:center;margin:12px 0 0">
            <a href="#/forgot" style="font-size:0.9rem">Forgot your password?</a></p>
        </form>
      </div>
      <p class="login-note">Accounts are created by your organization’s administrator.</p>
    </div>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } });
      await loadMe();
      location.hash = '#/entries';
      route();
    } catch (err) { showFormError(f, err.message); }
  });
}

// ---------------------------------------------------------------------------
// Forgot / set password views (work without a session)
// ---------------------------------------------------------------------------

function renderForgot() {
  renderTopbar();
  view.innerHTML = `
    <div class="login-wrap">
      <div class="brand-big">indigenous.ai</div>
      <div class="card">
        <form id="forgot-form">
          <p>Enter your account email and we’ll send you a link to reset your password.</p>
          <label class="field"><span>Email</span>
            <input type="email" name="email" required autocomplete="email" autofocus></label>
          <p class="error-msg" hidden></p>
          <button type="submit" style="width:100%">Send reset link</button>
          <p style="text-align:center;margin:12px 0 0"><a href="#/" style="font-size:0.9rem">Back to sign in</a></p>
        </form>
      </div>
    </div>`;
  $('#forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/password/forgot', { method: 'POST', body: { email: f.email.value } });
      f.innerHTML = `<p>If <b>${esc(f.email.value)}</b> has an account, a reset link is on its way.
        The link is valid for 2 hours — check your spam folder if you don’t see it.</p>
        <p style="text-align:center;margin:12px 0 0"><a href="#/">Back to sign in</a></p>`;
    } catch (err) { showFormError(f, err.message); }
  });
}

function renderSetPassword(token) {
  renderTopbar();
  view.innerHTML = `
    <div class="login-wrap">
      <div class="brand-big">indigenous.ai</div>
      <div class="card" id="setpw-card"><p>Checking your link…</p></div>
    </div>`;
  (async () => {
    let info;
    try { info = await api('/password/token/' + token); }
    catch (err) {
      $('#setpw-card').innerHTML = `<p>${esc(err.message)}</p>
        <p>Ask your administrator for a new invite, or
        <a href="#/forgot">request a fresh reset link</a>.</p>`;
      return;
    }
    $('#setpw-card').innerHTML = `
      <form id="setpw-form">
        <p>${info.purpose === 'invite' ? 'Welcome' : 'Hi'}, <b>${esc(info.name)}</b> —
          choose a password for <b>${esc(info.email)}</b>.</p>
        <label class="field"><span>New password (min 8 characters)</span>
          <input type="password" name="pw1" required minlength="8" autocomplete="new-password" autofocus></label>
        <label class="field"><span>Repeat password</span>
          <input type="password" name="pw2" required minlength="8" autocomplete="new-password"></label>
        <p class="error-msg" hidden></p>
        <button type="submit" style="width:100%">Set password</button>
      </form>`;
    $('#setpw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.pw1.value !== f.pw2.value) { showFormError(f, 'Passwords do not match'); return; }
      try {
        await api('/password/reset', { method: 'POST', body: { token, password: f.pw1.value } });
        location.hash = '#/';
        renderLogin();
        toast('Password set — you can sign in now');
      } catch (err) { showFormError(f, err.message); }
    });
  })();
}

// ---------------------------------------------------------------------------
// Public translation request views (work without a session)
// ---------------------------------------------------------------------------

function renderRequestStart() {
  renderTopbar();
  view.innerHTML = `
    <div class="login-wrap">
      <div class="brand-big">indigenous.ai</div>
      <div class="card">
        <form id="request-start-form">
          <p>Looking for a Dene translation? Enter your email and we’ll send you a
            link to a short request form.</p>
          <label class="field"><span>Email</span>
            <input type="email" name="email" required autocomplete="email" autofocus></label>
          <p class="error-msg" hidden></p>
          <button type="submit" style="width:100%">Send me the form</button>
          <p style="text-align:center;margin:12px 0 0"><a href="#/" style="font-size:0.9rem">Back to sign in</a></p>
        </form>
      </div>
    </div>`;
  $('#request-start-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api('/requests/start', { method: 'POST', body: { email: f.email.value } });
      f.innerHTML = r.sent
        ? `<p>We sent a link to <b>${esc(f.email.value)}</b> — it’s valid for 7 days.
            Check your spam folder if you don’t see it.</p>
           <p style="text-align:center;margin:12px 0 0"><a href="#/">Back to sign in</a></p>`
        : `<p>We couldn’t send the email right now — please try again later.</p>
           <p style="text-align:center;margin:12px 0 0"><a href="#/">Back to sign in</a></p>`;
    } catch (err) { showFormError(f, err.message); }
  });
}

function renderRequestForm(token) {
  renderTopbar();
  view.innerHTML = `
    <div class="request-wrap">
      <div class="brand-big">indigenous.ai</div>
      <div class="card" id="request-card"><p>Checking your link…</p></div>
    </div>`;
  (async () => {
    let info;
    try { info = await api('/requests/form/' + token); }
    catch (err) {
      $('#request-card').innerHTML = `<p>${esc(err.message)}</p>
        <p><a href="#/request">Request a fresh link</a>.</p>`;
      return;
    }
    if (info.status === 'submitted') {
      $('#request-card').innerHTML = `<p>This request has already been submitted —
        thank you! We’ll be in touch at <b>${esc(info.email)}</b>.</p>`;
      return;
    }
    $('#request-card').innerHTML = `
      <form id="request-form">
        <h2 style="margin-top:0">Translation request</h2>
        <label class="field"><span>Name</span>
          <input type="text" name="name" required value="${esc(info.name ?? '')}" autofocus></label>
        <label class="field"><span>Email</span>
          <input type="email" name="email" value="${esc(info.email)}" readonly
            style="background:var(--bg);color:var(--muted)"></label>
        <label class="field"><span>Dene dialect required</span>
          <input type="text" name="dialect" required value="${esc(info.dialect ?? '')}"
            placeholder="e.g. Dëne Sųłıné, Tłı̨chǫ, North Slavey"></label>
        <label class="field"><span>Details of your request</span>
          <textarea name="details" required rows="6"
            placeholder="What do you need translated? Include any deadlines or context.">${esc(info.details ?? '')}</textarea></label>
        <label class="field"><span>Files (optional — up to 5, max 100 MB each)</span>
          <input type="file" name="files" multiple
            accept=".pdf,.doc,.docx,.txt,.rtf,.csv,.xlsx,.jpg,.jpeg,.png,.heic,.mp3,.wav,.m4a,.mp4,.mov,.zip"></label>
        <p class="error-msg" hidden></p>
        <button type="submit" id="request-submit" style="width:100%">Submit request</button>
      </form>`;
    $('#request-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.files.files.length > 5) {
        showFormError(f, 'You can attach at most 5 files');
        return;
      }
      const fd = new FormData();
      fd.append('name', f.name.value);
      fd.append('dialect', f.dialect.value);
      fd.append('details', f.details.value);
      for (const file of f.files.files) fd.append('files', file);
      const btn = $('#request-submit');
      btn.disabled = true;
      btn.textContent = 'Submitting…';
      try {
        await api('/requests/form/' + token, { method: 'POST', body: fd });
        $('#request-card').innerHTML = `<p><b>Request submitted — mahsi cho!</b></p>
          <p>We’ll review it and get back to you at <b>${esc(info.email)}</b>.</p>`;
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Submit request';
        showFormError(f, err.message);
      }
    });
  })();
}

// ---------------------------------------------------------------------------
// Translation jobs (superadmin)
// ---------------------------------------------------------------------------

const jobStatusBadge = (s) =>
  s === 'submitted' ? '<span class="badge audio">Submitted</span>'
                    : '<span class="badge">Awaiting form</span>';

async function renderJobs() {
  view.innerHTML = `<div class="empty">Loading…</div>`;
  let data;
  try { data = await api('/requests'); }
  catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }

  view.innerHTML = `
    <div class="page-head"><h1>Service Requests</h1></div>
    <div class="card">
      ${data.requests.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Received</th><th>Name</th><th>Email</th><th>Dialect</th><th>Files</th><th>Status</th></tr></thead>
        <tbody>
          ${data.requests.map((r) => `
            <tr class="job-row" data-id="${r.id}">
              <td>${fmtDate(r.submitted_at ?? r.created_at)}</td>
              <td>${esc(r.name ?? '—')}</td>
              <td>${esc(r.email)}</td>
              <td>${esc(r.dialect ?? '—')}</td>
              <td>${r.file_count}</td>
              <td>${jobStatusBadge(r.status)}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>` : `<div class="empty">No translation requests yet.<br>
        The public request form is linked from the sign-in page.</div>`}
    </div>`;

  view.onclick = (e) => {
    const row = e.target.closest('tr.job-row');
    if (row) location.hash = `#/jobs/${row.dataset.id}`;
  };
}

async function renderJobDetail(id) {
  view.innerHTML = `<div class="empty">Loading…</div>`;
  let job;
  try { job = await api(`/requests/${id}`); }
  catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }

  const field = (label, value) =>
    `<div class="job-field"><div class="job-label">${label}</div><div>${value}</div></div>`;

  view.innerHTML = `
    <div class="page-head">
      <h1>Translation job #${job.id}</h1>
      <a class="btn secondary" href="#/jobs">‹ Back to jobs</a>
    </div>
    <div class="card">
      <div class="entry-meta" style="margin-bottom:0.8rem">
        ${jobStatusBadge(job.status)}
        <span>requested ${fmtDate(job.created_at)}</span>
        ${job.submitted_at ? `<span>submitted ${fmtDate(job.submitted_at)}</span>` : ''}
      </div>
      ${field('Name', esc(job.name ?? '—'))}
      ${field('Email', `<a href="mailto:${esc(job.email)}">${esc(job.email)}</a>`)}
      ${field('Dene dialect required', esc(job.dialect ?? '—'))}
      ${field('Details of the request', `<div class="job-details">${esc(job.details ?? '—')}</div>`)}
    </div>
    <div class="card">
      <h2 style="margin-top:0">Files (${job.files.length})</h2>
      ${job.files.length ? job.files.map((f) => `
        <div class="audio-item">
          <div class="audio-item-head">
            <span class="fname">${esc(f.original_name)}</span>
            <span style="color:var(--muted);font-size:0.85rem">
              ${fmtBytes(f.size_bytes)} ·
              <a href="/api/language/requests/files/${f.id}/download?dl=1">Download</a></span>
          </div>
          ${f.mime_type.startsWith('audio/')
            ? `<audio controls preload="none" src="/api/language/requests/files/${f.id}/download"></audio>` : ''}
        </div>`).join('') : '<p style="color:var(--muted)">No files attached.</p>'}
    </div>
    <div class="form-actions">
      <button class="danger" id="delete-job">Delete request</button>
    </div>`;

  $('#delete-job').addEventListener('click', async () => {
    if (!confirm('Delete this translation request and its files? This cannot be undone.')) return;
    try {
      await api(`/requests/${job.id}`, { method: 'DELETE' });
      toast('Request deleted');
      location.hash = '#/jobs';
    } catch (err) { toast(err.message, true); }
  });
}

// ---------------------------------------------------------------------------
// Compensation (superadmin) — work ledger, per-project rates, payments
// ---------------------------------------------------------------------------

async function renderCompensation() {
  view.innerHTML = `<div class="empty">Loading…</div>`;
  let data;
  try { data = await api('/compensation'); }
  catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }

  view.innerHTML = `
    <div class="page-head"><h1>Compensation</h1></div>
    <div class="card">
      <p style="color:var(--muted);font-size:0.9rem;margin-top:0">
        Work is logged automatically as translators record and translate. Payments
        are recorded here for your own bookkeeping — the app doesn't move money.</p>
      ${data.translators.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Earned</th><th>Paid</th><th>Balance</th></tr></thead>
        <tbody>
          ${data.translators.map((t) => `
            <tr class="job-row" data-id="${t.id}">
              <td>${esc(t.name)}</td>
              <td>${esc(t.email)}</td>
              <td>${fmtMoney(t.earned_cents)}</td>
              <td>${fmtMoney(t.paid_cents)}</td>
              <td><b>${fmtMoney(t.balance_cents)}</b></td>
            </tr>`).join('')}
        </tbody>
      </table></div>` : `<div class="empty">No translators yet.</div>`}
    </div>`;

  view.onclick = (e) => {
    const row = e.target.closest('tr.job-row');
    if (row) location.hash = `#/compensation/${row.dataset.id}`;
  };
}

// Work-log "Detail" cell: the entry's Dene word (or English if it's blank),
// linking to the entry's edit form; falls back to the note for adjustments.
function workEntryCell(w) {
  // No entry reference (orphaned legacy row or a project-less adjustment):
  // show the note, or a placeholder — never a blank cell.
  if (!w.entry_id) return esc(w.note || '') || '<span style="color:var(--muted)">—</span>';
  const label = w.dene_text || w.english_text || `entry #${w.entry_id}`;
  return `<a href="#/entries/${w.entry_id}">${esc(label)}</a>${w.note ? ` <span style="color:var(--muted)">· ${esc(w.note)}</span>` : ''}`;
}

async function renderCompensationDetail(id) {
  view.innerHTML = `<div class="empty">Loading…</div>`;
  let d;
  try { d = await api(`/compensation/${id}`); }
  catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }

  const rateOf = (projectId, type) =>
    d.rates.find((r) => r.project_id === projectId && r.type === type)?.rate_cents;
  const rateVal = (c) => (c === undefined ? '' : (c / 100).toFixed(2));

  const workLabel = { translation: 'Translation', recording: 'Recording', adjustment: 'Adjustment' };

  view.innerHTML = `
    <div class="page-head">
      <h1>${esc(d.user.name)}</h1>
      <a class="btn secondary" href="#/compensation">‹ Back to compensation</a>
    </div>
    <div class="card">
      <div class="stat-numbers">
        <div><div class="num">${fmtMoney(d.earned_cents)}</div><div class="lbl">Earned</div></div>
        <div><div class="num">${fmtMoney(d.paid_cents)}</div><div class="lbl">Paid</div></div>
        <div><div class="num">${fmtMoney(d.balance_cents)}</div><div class="lbl">Balance</div></div>
      </div>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Rates per project</h2>
      ${d.projects.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Project</th><th>Translation (each)</th><th>Recording (each)</th></tr></thead>
        <tbody>
          ${d.projects.map((p) => `
            <tr>
              <td>${esc(p.name)}</td>
              ${['translation', 'recording'].map((type) => `
                <td><span class="rate-field">$<input type="number" min="0" step="0.01"
                    data-project="${p.id}" data-type="${type}"
                    value="${rateVal(rateOf(p.id, type))}" placeholder="0.00"></span></td>`).join('')}
            </tr>`).join('')}
        </tbody>
      </table></div>
      <p class="palette-hint">Changing a rate only affects work logged from then on; past earnings keep the rate they were logged at.</p>
      ` : '<p style="color:var(--muted)">This person isn\'t a member of any project yet.</p>'}
    </div>

    <div class="card">
      <h2 style="margin-top:0">Record a payment</h2>
      <form id="payment-form">
        <div class="form-row">
          <label class="field"><span>Amount</span>
            <input type="number" name="amount" min="0.01" step="0.01" required placeholder="0.00"></label>
          <label class="field"><span>Date paid</span>
            <input type="date" name="paid_on"></label>
          <label class="field"><span>Method</span>
            <input type="text" name="method" placeholder="e.g. e-transfer, cheque"></label>
          <label class="field"><span>Note</span>
            <input type="text" name="note" placeholder="optional"></label>
        </div>
        <p class="error-msg" hidden></p>
        <button type="submit">Record payment</button>
      </form>
      <details style="margin-top:1rem">
        <summary style="cursor:pointer;color:var(--muted)">Add a manual adjustment (bonus / correction)</summary>
        <form id="adjust-form" style="margin-top:0.8rem">
          <div class="form-row">
            <label class="field"><span>Amount (use a minus sign to deduct)</span>
              <input type="number" name="amount" step="0.01" required placeholder="0.00"></label>
            <label class="field"><span>Reason (required)</span>
              <input type="text" name="note" required placeholder="e.g. bonus, correction"></label>
          </div>
          <p class="error-msg" hidden></p>
          <button type="submit" class="secondary">Add adjustment</button>
        </form>
      </details>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Work log</h2>
      ${d.work.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Type</th><th>Project</th><th>Detail</th><th>Amount</th></tr></thead>
        <tbody>
          ${d.work.map((w) => `
            <tr>
              <td>${fmtDate(w.created_at)}</td>
              <td>${workLabel[w.type] ?? w.type}</td>
              <td>${esc(w.project_name ?? '—')}</td>
              <td>${workEntryCell(w)}</td>
              <td>${fmtMoney(w.amount_cents)}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>` : '<p style="color:var(--muted)">No work logged yet.</p>'}
    </div>

    <div class="card">
      <h2 style="margin-top:0">Payments</h2>
      ${d.payments.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Date paid</th><th>Amount</th><th>Method</th><th>Note</th></tr></thead>
        <tbody>
          ${d.payments.map((p) => `
            <tr>
              <td>${esc(p.paid_on ?? fmtDate(p.created_at))}</td>
              <td>${fmtMoney(p.amount_cents)}</td>
              <td>${esc(p.method ?? '—')}</td>
              <td>${esc(p.note ?? '')}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>` : '<p style="color:var(--muted)">No payments recorded yet.</p>'}
    </div>`;

  // --- rate edits (save on change) ---
  view.querySelectorAll('input[data-project]').forEach((input) => {
    input.addEventListener('change', async () => {
      const cents = Math.round(parseFloat(input.value || '0') * 100);
      if (!Number.isFinite(cents) || cents < 0) { toast('Rate must be zero or more', true); return; }
      try {
        await api(`/compensation/${id}/rates`, {
          method: 'PUT',
          body: { project_id: Number(input.dataset.project), type: input.dataset.type, rate_cents: cents },
        });
        toast('Rate saved');
      } catch (err) { toast(err.message, true); }
    });
  });

  // --- record payment ---
  $('#payment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api(`/compensation/${id}/payments`, {
        method: 'POST',
        body: {
          amount_cents: Math.round(parseFloat(f.amount.value) * 100),
          paid_on: f.paid_on.value || undefined,
          method: f.method.value,
          note: f.note.value,
        },
      });
      toast('Payment recorded');
      renderCompensationDetail(id);
    } catch (err) { showFormError(f, err.message); }
  });

  // --- adjustment ---
  $('#adjust-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api(`/compensation/${id}/adjustments`, {
        method: 'POST',
        body: { amount_cents: Math.round(parseFloat(f.amount.value) * 100), note: f.note.value },
      });
      toast('Adjustment added');
      renderCompensationDetail(id);
    } catch (err) { showFormError(f, err.message); }
  });
}

// ---------------------------------------------------------------------------
// Entries list view
// ---------------------------------------------------------------------------

const listState = { kind: 'word', q: '', semantic: false, has_audio: '', contributor: '', status: '', incomplete: '', offset: 0 };

async function renderEntries(kind = '') {
  // Unified Entries view (nav spec §10): one destination, local tabs
  // All | Words | Phrases. The content scope is the active COLLECTION.
  if (listState.kind !== kind) {
    Object.assign(listState, { q: '', has_audio: '', contributor: '', status: '', incomplete: '', offset: 0 });
  }
  listState.kind = kind;
  const isPhrase = kind === 'phrase';

  const corpus = activeCorpus();
  if (!corpus) {
    view.innerHTML = `<div class="empty">You are not part of a collection yet.<br>
      Ask your organization’s administrator to add you.</div>`;
    return;
  }
  const ap = corpusProjects()[0] ?? activeProject();

  view.innerHTML = `
    <div class="page-head">
      <h1>Entries</h1>
      <div class="head-actions">
        ${ap && isAdminOf(ap.id) ? `
          <a class="btn secondary small" href="/api/language/projects/${ap.id}/export?format=csv${kind ? `&kind=${kind}` : ''}">Export CSV</a>
          <a class="btn secondary small" href="/api/language/projects/${ap.id}/export?format=json${kind ? `&kind=${kind}` : ''}">Export JSON</a>
          <a class="btn secondary small" href="/api/language/projects/${ap.id}/export-bundle${kind ? `?kind=${kind}` : ''}" title="Complete archive: entries + master audio + checksums">⬇ Full archive (ZIP)</a>` : ''}
        ${isTranslator() ? '' : `<a class="btn" href="#/entries/new?kind=${isPhrase ? 'phrase' : 'word'}">＋ New ${isPhrase ? 'phrase' : 'entry'}</a>`}
      </div>
    </div>
    <div style="margin-bottom:0.8rem">
      <div class="seg-tabs" role="tablist" aria-label="Entry kind">
        ${[['', 'All'], ['word', 'Words'], ['phrase', 'Phrases']].map(([k, label]) =>
          `<button role="tab" data-kind="${k}" aria-selected="${k === kind}" class="${k === kind ? 'active' : ''}">${label}</button>`).join('')}
      </div>
    </div>
    <div class="filters">
      <input type="search" id="f-q" placeholder="Search Dene or English text…" value="${esc(listState.q)}">
      <label class="smart-toggle" title="Rank by meaning, not just matching words">
        <input type="checkbox" id="f-semantic" ${listState.semantic ? 'checked' : ''}> Smart search</label>
      <select id="f-audio">
        <option value="">Audio: any</option>
        <option value="yes" ${listState.has_audio === 'yes' ? 'selected' : ''}>Has audio</option>
        <option value="no" ${listState.has_audio === 'no' ? 'selected' : ''}>No audio</option>
      </select>
      <select id="f-incomplete">
        <option value="">Translation: any</option>
        <option value="yes" ${listState.incomplete === 'yes' ? 'selected' : ''}>Needs translation</option>
        <option value="done" ${listState.incomplete === 'done' ? 'selected' : ''}>Complete</option>
      </select>
      <select id="f-contributor"><option value="">All contributors</option></select>
      <select id="f-status">
        <option value="">Status: any</option>
        ${['draft', 'reviewed', 'verified'].map((s) =>
          `<option value="${s}" ${listState.status === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </div>
    <div class="entry-list" id="entry-list"><div class="empty">Loading…</div></div>
    <div class="pager" id="pager"></div>`;

  // contributor options come from the corpus-scoped stats
  populateContributors();

  document.querySelectorAll('.seg-tabs button').forEach((b) =>
    b.addEventListener('click', () => renderEntries(b.dataset.kind)));

  let searchTimer;
  $('#f-q').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { listState.q = e.target.value; listState.offset = 0; loadEntryList(); }, 250);
  });
  for (const [id, key] of [['#f-audio', 'has_audio'], ['#f-contributor', 'contributor'], ['#f-status', 'status'], ['#f-incomplete', 'incomplete']]) {
    $(id)?.addEventListener('change', (e) => { listState[key] = e.target.value; listState.offset = 0; loadEntryList(); });
  }
  $('#f-semantic')?.addEventListener('change', (e) => { listState.semantic = e.target.checked; listState.offset = 0; loadEntryList(); });

  await loadEntryList();
}

async function populateContributors() {
  const sel = $('#f-contributor');
  if (!sel) return;
  const pid = (corpusProjects()[0] ?? activeProject())?.id;
  if (!pid) return;
  try {
    const stats = await api(`/projects/${pid}/stats${listState.kind ? `?kind=${listState.kind}` : ''}`);
    sel.innerHTML = '<option value="">All contributors</option>' +
      stats.contributors.map((c) =>
        `<option value="${c.id}" ${String(c.id) === String(listState.contributor) ? 'selected' : ''}>${esc(c.name)} (${c.entry_count})</option>`).join('');
  } catch { /* keep default */ }
}

async function loadEntryList() {
  const listEl = $('#entry-list');
  if (!listEl) return;
  const params = new URLSearchParams();
  // The Library browses the COLLECTION (corpus), not a campaign.
  const corpus = activeCorpus();
  if (corpus) params.set('corpus_id', String(corpus.id));
  else if (activeProject()) params.set('project_id', String(activeProject().id));
  if (listState.kind) params.set('kind', listState.kind);
  if (listState.q) params.set('q', listState.q);
  if (listState.semantic && listState.q) params.set('semantic', '1');
  if (listState.has_audio) params.set('has_audio', listState.has_audio);
  if (listState.contributor) params.set('contributor', listState.contributor);
  if (listState.status) params.set('status', listState.status);
  if (listState.incomplete === 'yes') params.set('complete', 'no');
  else if (listState.incomplete === 'done') params.set('complete', 'yes');
  params.set('limit', '50');
  params.set('offset', String(listState.offset));

  let data;
  try { data = await api('/entries?' + params); }
  catch (err) { listEl.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }

  if (!data.entries.length) {
    listEl.innerHTML = `<div class="empty">No ${listState.kind === 'phrase' ? 'phrases' : 'entries'} found.</div>`;
    $('#pager').innerHTML = '';
    return;
  }

  listEl.innerHTML = data.entries.map((e) => {
    const incomplete = !e.dene_text || !e.english_text;
    return `
    <a class="entry-row" href="#/entries/${e.id}">
      <div class="dene">${esc(e.dene_text) || '<span class="placeholder">— no Dene yet —</span>'}</div>
      <div class="english">${esc(e.english_text) || '<span class="placeholder">— no English yet —</span>'}</div>
      <div class="entry-meta">
        <span class="badge">${esc(e.project_name)}</span>
        ${incomplete ? '<span class="badge incomplete">Needs translation</span>' : ''}
        ${e.category ? `<span class="badge">${esc(e.category)}</span>` : ''}
        ${e.audio_count ? `<span class="badge audio">♪ ${e.audio_count} · ${fmtDuration(e.audio_seconds)}</span>` : ''}
        ${e.status !== 'draft' ? `<span class="badge status-${e.status}">${e.status}</span>` : ''}
        <span>by ${esc(e.created_by_name)}</span>
        <span>updated ${fmtDate(e.updated_at)}</span>
      </div>
    </a>`;
  }).join('');

  const pager = $('#pager');
  const page = Math.floor(listState.offset / 50) + 1;
  const pages = Math.max(1, Math.ceil(data.total / 50));
  pager.innerHTML = pages > 1 ? `
    <button class="ghost small" id="pg-prev" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button>
    <span>Page ${page} of ${pages} · ${data.total} entries</span>
    <button class="ghost small" id="pg-next" ${page >= pages ? 'disabled' : ''}>Next ›</button>`
    : `<span style="color:var(--muted);font-size:0.85rem">${data.total} entries</span>`;
  $('#pg-prev')?.addEventListener('click', () => { listState.offset -= 50; loadEntryList(); });
  $('#pg-next')?.addEventListener('click', () => { listState.offset += 50; loadEntryList(); });
}

// ---------------------------------------------------------------------------
// New entry view
// ---------------------------------------------------------------------------

function renderNewEntry(kind = 'word') {
  const isPhrase = kind === 'phrase';
  const backHref = '#/entries';
  // Content belongs to the collection; the campaign is only origin/provenance.
  const campaigns = corpusProjects().filter((p) => p.status !== 'closed');
  const ap = campaigns.find((p) => p.id === state.activeProjectId) ?? campaigns[0];
  if (!ap) { location.hash = backHref; return; }
  const corpus = activeCorpus();

  // Every entry — word or phrase — needs at least one side; the other can be
  // filled in later (the entry is flagged as needing translation).
  view.innerHTML = `
    <div class="page-head">
      <h1>New ${isPhrase ? 'phrase' : 'entry'}</h1>
      <span class="page-context">${esc(corpus?.name ?? ap.name)}</span>
    </div>
    <div class="card">
      <form id="entry-form">
        ${campaigns.length > 1 ? `
        <label class="field" style="max-width:340px"><span>Project (which campaign this work belongs to)</span>
          <select name="project_id">${campaigns.map((p) =>
            `<option value="${p.id}" ${p.id === ap.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>` : ''}
        <p class="form-hint">Enter the Dene ${isPhrase ? 'phrase' : 'word'}, the English, or both. If you enter only one, it will be queued for translation.</p>
        <label class="field"><span>${isPhrase ? 'Dene phrase' : 'Dene text'}</span>
          <input type="text" name="dene_text" id="dene-input" class="dene" lang="den" spellcheck="false"></label>
        <label class="field"><span>${isPhrase ? 'English meaning' : 'English text'}</span>
          <input type="text" name="english_text"></label>
        <div class="form-row">
          <label class="field"><span>Category (optional)</span>
            <input type="text" name="category" placeholder="e.g. greetings, animals, weather"></label>
          <label class="field"><span>Source document (optional)</span>
            <input type="text" name="source_doc" placeholder="e.g. Elder interview 2026-05, phrase book p.12"></label>
          <label class="field"><span>Notes (optional)</span>
            <input type="text" name="notes" placeholder="Context, register, regional usage…"></label>
        </div>
        <p class="error-msg" hidden></p>
        <div class="form-actions">
          <button type="submit">Create ${isPhrase ? 'phrase' : 'entry'}</button>
          <a class="btn secondary" href="${backHref}">Cancel</a>
        </div>
      </form>
    </div>`;

  $('#entry-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (isPhrase && !f.dene_text.value.trim() && !f.english_text.value.trim()) {
      showFormError(f, 'Enter a Dene phrase, an English meaning, or both');
      return;
    }
    try {
      const entry = await api('/entries', {
        method: 'POST',
        body: {
          project_id: Number(f.project_id?.value ?? ap.id),
          kind,
          dene_text: f.dene_text.value,
          english_text: f.english_text.value,
          category: f.category.value,
          source_doc: f.source_doc.value,
          notes: f.notes.value,
        },
      });
      toast(`${isPhrase ? 'Phrase' : 'Entry'} created${!entry.dene_text || !entry.english_text ? ' — queued for translation' : ' — you can add audio now'}`);
      location.hash = `#/entries/${entry.id}`;
    } catch (err) { showFormError(f, err.message); }
  });
}

// ---------------------------------------------------------------------------
// Entry detail view
// ---------------------------------------------------------------------------

async function renderEntryDetail(id) {
  view.innerHTML = `<div class="empty">Loading…</div>`;
  let entry;
  try { entry = await api(`/entries/${id}`); }
  catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }

  const isPhrase = entry.kind === 'phrase';
  const incomplete = !entry.dene_text || !entry.english_text;
  const backHref = '#/entries';
  const backLabel = 'entries';
  setActiveNav('#/entries');
  const ro = !entry.can_edit;
  const isAdmin = entry.role === 'admin';
  const myId = state.me.user.id;
  const mine = {
    dene: entry.audio.find((a) => a.uploaded_by === myId && a.language === 'dene'),
    english: entry.audio.find((a) => a.uploaded_by === myId && a.language === 'english'),
  };
  const others = entry.audio.filter((a) => a.uploaded_by !== myId);

  // Translators record only through their sessions (paid work needs a claimed
  // work item — hardening #5): show their recordings read-only, no slots/upload.
  const translatorHere = entry.role === 'translator';
  // An incomplete phrase can't be recorded yet — show a prompt instead of slots.
  const recordingsCard = translatorHere ? `
    <div class="card">
      <div id="audio-list">
        <h2 style="margin-top:0">Recordings</h2>
        ${entry.audio.length ? entry.audio.map((a) => audioItemHtml(a, entry)).join('')
          : '<p class="form-hint">No recordings yet.</p>'}
      </div>
      <p class="form-hint" style="margin-top:0.6rem">Recording happens in your
        <a href="#/home">recording session</a> — paid work is claimed there.</p>
    </div>` : incomplete ? `
    <div class="card">
      <h2 style="margin-top:0">Recordings</h2>
      <p class="form-hint">Add the translation above before recording this phrase.</p>
    </div>` : `
    <div class="card">
      ${others.length ? `
      <div id="audio-list">
        <h2 style="margin-top:0">All recordings${isAdmin ? ' (admin view)' : ''}</h2>
        ${others.map((a) => audioItemHtml(a, entry)).join('')}
      </div>` : '<div id="audio-list"></div>'}
      <div style="${others.length ? 'border-top:1px solid var(--line);margin-top:1rem;padding-top:0.8rem' : ''}">
        <h2 style="margin-top:0">Your recordings</h2>
        <div class="audio-slots" id="audio-slots">
          ${slotHtml('dene', mine.dene)}
          ${mine.english ? slotHtml('english', mine.english) : '' /* legacy English recordings stay manageable; no new ones */}
        </div>
      </div>
      <details style="border-top:1px solid var(--line);padding-top:0.8rem;margin-top:1rem">
        <summary style="cursor:pointer;color:var(--muted)">Upload an audio file instead (WAV / MP3 / M4A)</summary>
        <p style="color:var(--muted);font-size:0.85rem">Uploading adds a new version for that language; the previous master is kept in version history.</p>
        <form id="audio-form" style="margin-top:0.8rem">
          <div class="form-row">
            <label class="field"><span>Audio file</span>
              <input type="file" name="file" accept=".wav,.flac,.mp3,.m4a,audio/*" required></label>
            <label class="field"><span>Speaker name / ID</span>
              <input type="text" name="speaker" placeholder="e.g. Elder Mary T."></label>
            <label class="field"><span>Recording notes</span>
              <input type="text" name="recording_notes" placeholder="e.g. recorded 2026-06, studio"></label>
          </div>
          <p class="error-msg" hidden></p>
          <button type="submit" id="audio-submit">Upload audio</button>
        </form>
      </details>
    </div>`;

  view.innerHTML = `
    <div class="page-head">
      <h1>${isPhrase ? 'Phrase' : 'Entry'} #${entry.id}</h1>
      <a class="btn secondary" href="${backHref}">‹ Back to ${backLabel}</a>
    </div>
    <div class="card">
      <form id="entry-form">
        <div class="entry-meta" style="margin-bottom:0.8rem">
          <span class="badge">${esc(entry.project_name)}${entry.dialect ? ` — ${esc(entry.dialect)}` : ''}</span>
          ${incomplete ? '<span class="badge incomplete">Needs translation</span>' : ''}
          <span>created by ${esc(entry.created_by_name)} on ${fmtDate(entry.created_at)}</span>
          <span>last edited by ${esc(entry.updated_by_name)} on ${fmtDate(entry.updated_at)}</span>
          ${(entry.sources ?? []).map((s) => `
            <span>source: ${entry.role === 'translator' ? esc(s.title) : `<a href="#/documents/${s.document_id}">${esc(s.title)}</a>`}${
              s.location?.sheet ? ` — ${esc(s.location.sheet)}, row ${s.location.row}`
              : s.location?.row ? ` — row ${s.location.row}` : ''}</span>`).join('')}
        </div>
        <div class="entry-texts">
          <label class="field"><span>${isPhrase ? 'Dene phrase' : 'Dene text'}</span>
            <textarea name="dene_text" id="dene-input" class="dene" lang="den" spellcheck="false" ${ro ? 'readonly' : ''}>${esc(entry.dene_text)}</textarea></label>
          <label class="field"><span>${isPhrase ? 'English meaning' : 'English text'}</span>
            <textarea name="english_text" ${ro ? 'readonly' : ''}>${esc(entry.english_text)}</textarea></label>
        </div>
        <div class="form-row">
          <label class="field"><span>Category</span>
            <input type="text" name="category" value="${esc(entry.category ?? '')}" ${ro ? 'readonly' : ''} placeholder="e.g. greetings, animals"></label>
          <label class="field"><span>Source document</span>
            <input type="text" name="source_doc" value="${esc(entry.source_doc ?? '')}" ${ro ? 'readonly' : ''}></label>
          <label class="field"><span>Notes</span>
            <input type="text" name="notes" value="${esc(entry.notes ?? '')}" ${ro ? 'readonly' : ''}></label>
          <label class="field"><span>Review status</span>
            <select name="status" ${isAdmin ? '' : 'disabled'}>
              ${['draft', 'reviewed', 'verified'].map((s) =>
                `<option value="${s}" ${entry.status === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select></label>
        </div>
        <p class="error-msg" hidden></p>
        ${ro ? '' : `
        <div class="form-actions">
          <button type="submit">Save changes</button>
          <button type="button" class="danger" id="delete-entry">Delete ${isPhrase ? 'phrase' : 'entry'}</button>
        </div>`}
      </form>
    </div>

    ${recordingsCard}`;

  // --- entry save/delete ---
  $('#entry-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ro) return;
    const f = e.target;
    try {
      const body = {
        dene_text: f.dene_text.value,
        english_text: f.english_text.value,
        category: f.category.value,
        source_doc: f.source_doc.value,
        notes: f.notes.value,
      };
      if (isAdmin) body.status = f.status.value;
      await api(`/entries/${entry.id}`, { method: 'PATCH', body });
      toast(isPhrase ? 'Phrase saved' : 'Entry saved');
      renderEntryDetail(entry.id);
    } catch (err) { showFormError(f, err.message); }
  });

  $('#delete-entry')?.addEventListener('click', async () => {
    if (!confirm(`Delete this ${isPhrase ? 'phrase' : 'entry'} and all its audio recordings? This cannot be undone.`)) return;
    try {
      await api(`/entries/${entry.id}`, { method: 'DELETE' });
      toast(isPhrase ? 'Phrase deleted' : 'Entry deleted');
      location.hash = backHref;
    } catch (err) { toast(err.message, true); }
  });

  // --- microphone recording (only when the recording slots are present) ---
  if (!incomplete && !translatorHere) setupRecorder(entry);

  // --- audio upload ---
  $('#audio-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const fd = new FormData();
    fd.append('file', f.file.files[0]);
    fd.append('language', 'dene');
    fd.append('speaker', f.speaker.value);
    fd.append('recording_notes', f.recording_notes.value);
    const btn = $('#audio-submit');
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    try {
      await api(`/entries/${entry.id}/audio`, { method: 'POST', body: fd });
      toast('Audio uploaded');
      renderEntryDetail(entry.id);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Upload audio';
      showFormError(f, err.message);
    }
  });

  // --- per-audio actions (event delegation) ---
  $('#audio-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const audioId = btn.dataset.id;
    const action = btn.dataset.action;
    if (action === 'delete') {
      if (!confirm('Delete this recording?')) return;
      try {
        await api(`/audio/${audioId}`, { method: 'DELETE' });
        toast('Recording deleted');
        renderEntryDetail(entry.id);
      } catch (err) { toast(err.message, true); }
    } else if (action === 'history') {
      const box = $(`#versions-${audioId}`);
      if (!box) return;
      if (!box.hidden) { box.hidden = true; box.innerHTML = ''; return; }
      box.hidden = false;
      box.innerHTML = '<div class="empty small">Loading…</div>';
      try {
        const { versions } = await api(`/audio/${audioId}/history`);
        box.innerHTML = versions.length
          ? `<div class="versions-head">Previous versions (superseded masters, kept for the archive)</div>` +
            versions.map((v) => `
              <div class="version-row">
                <span>${fmtDuration(v.duration_seconds)} · ${(v.size_bytes / 1024 / 1024).toFixed(1)} MB · ${{ legacy_lossy: 'legacy', lossy_source: 'lossy source' }[v.archive_class] ?? 'master'}${v.sample_rate_hz ? ` · ${(v.sample_rate_hz / 1000).toFixed(1)} kHz` : ''} · ${fmtDate(v.created_at)}</span>
                <a class="btn ghost small" href="/api/language/audio/${v.id}/master">⬇ Master</a>
              </div>`).join('')
          : '<div class="empty small">No previous versions — this is the first recording.</div>';
      } catch (err) { box.innerHTML = `<div class="empty small">${esc(err.message)}</div>`; }
    } else if (action === 'rework') {
      if (!confirm('Authorize a PAID re-record of this slot? The speaker\'s next recording session will offer it, and the new take will be billed as a second payment.')) return;
      try {
        await api(`/entries/${btn.dataset.entry}/audio-rework`, {
          method: 'POST',
          body: { user_id: Number(btn.dataset.user), language: btn.dataset.lang },
        });
        toast('Paid re-record authorized — it will appear in the speaker\'s next session');
      } catch (err) { toast(err.message, true); }
    } else if (action === 'revoke') {
      const note = prompt('Revoke consent on this recording? It stays in the archive but is excluded from purpose-filtered exports and public use. Optional note (e.g. who withdrew consent):');
      if (note === null) return;
      try {
        await api(`/audio/${audioId}/revoke`, { method: 'POST', body: { note } });
        toast('Consent revoked');
        renderEntryDetail(entry.id);
      } catch (err) { toast(err.message, true); }
    } else if (action === 'edit-meta') {
      const item = btn.closest('.audio-item');
      const speaker = prompt('Speaker name / ID:', item.dataset.speaker || '');
      if (speaker === null) return;
      const notes = prompt('Recording notes:', item.dataset.notes || '');
      if (notes === null) return;
      try {
        await api(`/audio/${audioId}`, { method: 'PATCH', body: { speaker, recording_notes: notes } });
        toast('Recording details saved');
        renderEntryDetail(entry.id);
      } catch (err) { toast(err.message, true); }
    }
  });
}

function slotHtml(lang, a) {
  const label = lang === 'english' ? 'English' : 'Dene';
  return `
    <div class="audio-slot" data-lang="${lang}">
      <div class="slot-head">${label}</div>
      ${a ? `
        <audio controls preload="none" src="/api/language/audio/${a.id}/stream"></audio>
        <div class="slot-meta">${fmtDuration(a.duration_seconds)} · ${fmtDate(a.created_at)}${
          a.speaker_name && a.speaker_name !== state.me.user.name
            ? ` · spoken by <b>${esc(a.speaker_name)}</b>` : ''}</div>
        <div class="slot-controls">
          <button type="button" class="rec-btn small" data-lang="${lang}">⏺ Re-record</button>
          <button type="button" class="danger small" data-action="delete" data-id="${a.id}">Delete</button>
          <a class="btn ghost small" href="/api/language/audio/${a.id}/master" title="Download the lossless archival master">⬇ Master</a>
          <button type="button" class="ghost small" data-slot-history="${a.id}">Versions</button>
        </div>
        <div class="audio-versions" id="slotver-${a.id}" hidden></div>` : `
        <div class="slot-empty">No recording yet</div>
        <div class="slot-controls">
          <button type="button" class="rec-btn" data-lang="${lang}">⏺ Record ${label}</button>
        </div>`}
    </div>`;
}

function setupRecorder(entry) {
  const box = $('#audio-slots');
  let timer = null;

  box.onclick = async (e) => {
    const startBtn = e.target.closest('.rec-btn');
    const stopBtn = e.target.closest('[data-rec=stop]');
    const cancelBtn = e.target.closest('[data-rec=cancel]');
    const deleteBtn = e.target.closest('button[data-action=delete]');
    const histBtn = e.target.closest('button[data-slot-history]');

    if (histBtn) {
      const id = histBtn.dataset.slotHistory;
      const box2 = $(`#slotver-${id}`);
      if (!box2) return;
      if (!box2.hidden) { box2.hidden = true; box2.innerHTML = ''; return; }
      box2.hidden = false;
      box2.innerHTML = '<div class="empty small">Loading…</div>';
      try {
        const { versions } = await api(`/audio/${id}/history`);
        box2.innerHTML = versions.length
          ? `<div class="versions-head">Previous versions (superseded masters, kept for the archive)</div>` +
            versions.map((v) => `
              <div class="version-row">
                <span>${fmtDuration(v.duration_seconds)} · ${(v.size_bytes / 1024 / 1024).toFixed(1)} MB${v.sample_rate_hz ? ` · ${(v.sample_rate_hz / 1000).toFixed(1)} kHz` : ''} · ${fmtDate(v.created_at)}</span>
                <a class="btn ghost small" href="/api/language/audio/${v.id}/master">⬇ Master</a>
              </div>`).join('')
          : '<div class="empty small">No previous versions — this is the first recording.</div>';
      } catch (err) { box2.innerHTML = `<div class="empty small">${esc(err.message)}</div>`; }
      return;
    }

    if (deleteBtn) {
      if (!confirm('Delete this recording?')) return;
      try {
        await api(`/audio/${deleteBtn.dataset.id}`, { method: 'DELETE' });
        toast('Recording deleted');
        renderEntryDetail(entry.id);
      } catch (err) { toast(err.message, true); }
      return;
    }

    if (startBtn) {
      if (Recorder.session) return; // one recording at a time
      const lang = startBtn.dataset.lang;
      const langLabel = lang === 'english' ? 'English' : 'Dene';
      try {
        await Recorder.start();
      } catch {
        toast('Could not access the microphone — check browser permissions', true);
        return;
      }
      const slot = startBtn.closest('.audio-slot');
      const controls = $('.slot-controls', slot);
      const started = Date.now();
      box.querySelectorAll('.rec-btn').forEach((b) => { b.disabled = true; });
      controls.innerHTML = `
        <span class="rec-live"><span class="rec-dot"></span> Recording ${langLabel} — <span id="rec-time">0:00</span></span>
        <button type="button" data-rec="stop" data-lang="${lang}">■ Stop &amp; save</button>
        <button type="button" class="ghost" data-rec="cancel">Cancel</button>`;
      timer = setInterval(() => {
        const s = Math.floor((Date.now() - started) / 1000);
        const t = $('#rec-time');
        if (t) t.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      }, 250);
      return;
    }

    if (cancelBtn) {
      clearInterval(timer);
      await Recorder.cancel();
      renderEntryDetail(entry.id);
      return;
    }

    if (stopBtn) {
      clearInterval(timer);
      const lang = stopBtn.dataset.lang;
      stopBtn.closest('.slot-controls').innerHTML = `<span class="rec-live">Saving recording…</span>`;
      try {
        const blob = await Recorder.stop();
        if (!blob || blob.size === 0) throw new Error('Nothing was recorded');
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
        const fd = new FormData();
        fd.append('file', blob, `${lang}-entry${entry.id}-${stamp}.wav`);
        fd.append('language', lang);
        fd.append('speaker', state.me.user.name);
        fd.append('recording_notes', 'recorded in browser');
        fd.append('capture_method', 'browser_recording');
        if (micDeviceLabel) fd.append('capture_device', micDeviceLabel);
        await api(`/entries/${entry.id}/audio`, { method: 'POST', body: fd });
        toast(`${lang === 'english' ? 'English' : 'Dene'} recording saved`);
      } catch (err) {
        toast(err.message, true);
      }
      renderEntryDetail(entry.id);
    }
  };
}

// Consent badge for a recording (#6): revoked > profile name > consent-unknown.
function consentBadge(a) {
  if (a.revoked_at) return '<span class="badge" style="background:var(--danger);color:#fff" title="Consent revoked — excluded from purpose exports and public use">Revoked</span>';
  if (a.consent_profile_name) return `<span class="badge" title="Consent profile snapshot">${esc(a.consent_profile_name)}</span>`;
  return '<span class="badge" style="opacity:0.65" title="No consent recorded — excluded from purpose-filtered exports until assigned">Consent unknown</span>';
}

function audioItemHtml(a, entry) {
  const mine = a.uploaded_by === state.me.user.id;
  const canManage = mine || entry.role === 'admin';
  return `
    <div class="audio-item" data-speaker="${esc(a.speaker ?? '')}" data-notes="${esc(a.recording_notes ?? '')}">
      <div class="audio-item-head">
        <span class="fname"><span class="badge ${a.language === 'english' ? '' : 'audio'}">${a.language === 'english' ? 'English' : 'Dene'}</span> ${esc(a.original_name)} ${consentBadge(a)}</span>
        <span style="color:var(--muted);font-size:0.85rem">
          ${fmtDuration(a.duration_seconds)} · ${(a.size_bytes / 1024 / 1024).toFixed(1)} MB
          · uploaded by ${esc(a.uploaded_by_name)} on ${fmtDate(a.created_at)}
        </span>
      </div>
      ${a.speaker_name || a.speaker || a.recording_notes ? `
        <div style="font-size:0.9rem;color:var(--muted)">
          ${a.speaker_name
            ? `Spoken by <b>${esc(a.speaker_name)}</b>${a.speaker_name !== a.uploaded_by_name ? ` · recorded by ${esc(a.uploaded_by_name)}` : ''}`
            : a.speaker ? `Speaker: <b>${esc(a.speaker)}</b>` : ''}
          ${(a.speaker_name || a.speaker) && a.recording_notes ? ' · ' : ''}${esc(a.recording_notes ?? '')}
        </div>` : ''}
      <audio controls preload="none" src="/api/language/audio/${a.id}/stream"></audio>
      ${canManage ? `
      <div class="audio-actions">
        <a class="btn ghost small" href="/api/language/audio/${a.id}/master" title="Download the lossless archival master">⬇ Master</a>
        <button type="button" class="ghost small" data-action="history" data-id="${a.id}">Previous versions</button>
        <button type="button" class="ghost small" data-action="edit-meta" data-id="${a.id}">Edit details</button>
        ${isOrgAdmin() && !a.revoked_at ? `<button type="button" class="danger small" data-action="revoke" data-id="${a.id}">Revoke consent</button>` : ''}
        ${isOrgAdmin() ? `<button type="button" class="ghost small" data-action="rework" data-id="${a.id}" data-user="${a.uploaded_by}" data-lang="${a.language}" data-entry="${a.entry_id}" title="Authorize a PAID re-record of this billed slot">Authorize re-record</button>` : ''}
        <button type="button" class="danger small" data-action="delete" data-id="${a.id}">Delete</button>
      </div>
      <div class="audio-versions" id="versions-${a.id}" hidden></div>` : ''}
    </div>`;
}

// ---------------------------------------------------------------------------
// Translator dashboard — one big button, more to come later
// ---------------------------------------------------------------------------

async function renderTranslatorDashboard() {
  const p = activeProject();
  if (!p) {
    view.innerHTML = `<div class="empty">You are not a member of any project yet.<br>
      Ask your organization’s administrator to add you.</div>`;
    return;
  }
  view.innerHTML = `<div class="empty">Loading…</div>`;

  let recTotal = 0;
  let transTotal = 0;
  let comp = null;
  try {
    const [rec, trans, c] = await Promise.all([
      api(`/entries?project_id=${p.id}&needs_my_audio=dene&complete=yes&limit=1`),
      api(`/entries?project_id=${p.id}&complete=no&limit=1`),
      api('/me/compensation'),
    ]);
    recTotal = rec.total;
    transTotal = trans.total;
    comp = c;
  } catch { /* counts are decorative — the session views report errors themselves */ }

  view.innerHTML = `
    <div class="translator-home">
      <h1>Welcome, ${esc(state.me.user.name)}</h1>
      <p class="translator-project">${esc(p.name)}${p.dialect ? ` — ${esc(p.dialect)}` : ''}</p>
      ${transTotal > 0 ? `
        <p class="queue-count">${transTotal} ${transTotal === 1 ? 'entry needs' : 'entries need'} translation.</p>
        <button class="big-action" id="start-translate">✎ Start translations session</button>` : ''}
      <p class="queue-count">${recTotal === 0
        ? 'Every entry has a recording — check back later.'
        : `${recTotal} ${recTotal === 1 ? 'entry needs' : 'entries need'} a recording.`}</p>
      <button class="big-action" id="start-record" ${recTotal === 0 ? 'disabled' : ''}>⏺ Start recording session</button>
      ${comp ? `
        <p class="earnings-line">Earned ${fmtMoney(comp.earned_cents)} · Paid ${fmtMoney(comp.paid_cents)} ·
          <b>Balance ${fmtMoney(comp.balance_cents)}</b></p>
        <p><a href="#/earnings">View my work log ›</a></p>` : ''}
    </div>`;
  $('#start-record').addEventListener('click', () => { location.hash = '#/record'; });
  $('#start-translate')?.addEventListener('click', () => { location.hash = '#/translate'; });
}

// A translator's own read-only work log + payments (same data the superadmin sees).
async function renderMyEarnings() {
  view.innerHTML = `<div class="empty">Loading…</div>`;
  let d;
  try { d = await api('/me/compensation'); }
  catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
  const workLabel = { translation: 'Translation', recording: 'Recording', adjustment: 'Adjustment' };

  view.innerHTML = `
    <div class="page-head">
      <h1>My work &amp; earnings</h1>
      <a class="btn secondary" href="#/home">‹ Back to dashboard</a>
    </div>
    <div class="card">
      <div class="stat-numbers">
        <div><div class="num">${fmtMoney(d.earned_cents)}</div><div class="lbl">Earned</div></div>
        <div><div class="num">${fmtMoney(d.paid_cents)}</div><div class="lbl">Paid</div></div>
        <div><div class="num">${fmtMoney(d.balance_cents)}</div><div class="lbl">Balance</div></div>
      </div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Work log</h2>
      ${d.work.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Type</th><th>Project</th><th>Detail</th><th>Amount</th></tr></thead>
        <tbody>
          ${d.work.map((w) => `
            <tr>
              <td>${fmtDate(w.created_at)}</td>
              <td>${workLabel[w.type] ?? w.type}</td>
              <td>${esc(w.project_name ?? '—')}</td>
              <td>${workEntryCell(w)}</td>
              <td>${fmtMoney(w.amount_cents)}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>` : '<p style="color:var(--muted)">No work logged yet.</p>'}
    </div>
    <div class="card">
      <h2 style="margin-top:0">Payments</h2>
      ${d.payments.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Date paid</th><th>Amount</th><th>Method</th><th>Note</th></tr></thead>
        <tbody>
          ${d.payments.map((p) => `
            <tr>
              <td>${esc(p.paid_on ?? fmtDate(p.created_at))}</td>
              <td>${fmtMoney(p.amount_cents)}</td>
              <td>${esc(p.method ?? '—')}</td>
              <td>${esc(p.note ?? '')}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>` : '<p style="color:var(--muted)">No payments recorded yet.</p>'}
    </div>`;
}

// ---------------------------------------------------------------------------
// Recording session — cycle through entries that have no audio yet
// ---------------------------------------------------------------------------

const recSession = { queue: [], pos: 0, total: 0, claimed: [], sessionId: null, speakerName: null };

// Close the server-side recording session (fire-and-forget) so its metadata
// window ends when the contributor leaves the flow.
function endRecSession() {
  if (!recSession.sessionId) return;
  const id = recSession.sessionId;
  recSession.sessionId = null;
  recSession.speakerName = null;
  api(`/recording-sessions/${id}/end`, { method: 'POST' }).catch(() => {});
}

// One-time per session: who is speaking? Defaults to the signed-in user; a
// facilitator picks (or registers) the person they are recording — an Elder
// does not need an account. Resolves {sessionId, speakerName} or null.
function chooseSpeaker(container, project) {
  return new Promise((resolve) => {
    (async () => {
      let speakers = [];
      try { speakers = (await api(`/projects/${project.id}/speakers`)).speakers; } catch { /* list is optional */ }
      const others = speakers.filter((s) => s.user_id !== state.me.user.id);
      container.innerHTML = `
        <div class="card preflight">
          <h2 style="margin-top:0">🗣️ Who is speaking?</h2>
          <label class="field"><span>Speaker</span>
            <select id="spk-select">
              <option value="">Myself (${esc(state.me.user.name)})</option>
              ${others.map((s) => `<option value="${s.id}">${esc(s.display_name)}</option>`).join('')}
              <option value="__new">＋ New speaker…</option>
            </select></label>
          <label class="field" id="spk-new-wrap" hidden><span>Speaker's name</span>
            <input id="spk-new-name" placeholder="e.g. an Elder's name"></label>
          <p class="preflight-hint">You are the facilitator — the recording stays attributed to you as its uploader.</p>
          <div class="rec-actions">
            <button class="secondary" id="spk-cancel">Cancel</button>
            <button id="spk-start">Start</button>
          </div>
        </div>`;
      const select = $('#spk-select', container);
      select.addEventListener('change', () => {
        $('#spk-new-wrap', container).hidden = select.value !== '__new';
      });
      $('#spk-cancel', container).addEventListener('click', () => resolve(null));
      $('#spk-start', container).addEventListener('click', async () => {
        try {
          let speakerId = null;
          let speakerName = state.me.user.name;
          if (select.value === '__new') {
            const name = $('#spk-new-name', container).value.trim();
            if (!name) { toast('Enter the speaker’s name', true); return; }
            const created = await api(`/projects/${project.id}/speakers`, { method: 'POST', body: { display_name: name } });
            speakerId = created.id;
            speakerName = created.display_name;
          } else if (select.value) {
            speakerId = Number(select.value);
            speakerName = others.find((s) => s.id === speakerId)?.display_name || speakerName;
          }
          const session = await api(`/projects/${project.id}/recording-sessions`, {
            method: 'POST',
            body: { speaker_id: speakerId, capture_device: micDeviceLabel || undefined },
          });
          resolve({ sessionId: session.id, speakerName });
        } catch (err) {
          toast(err.message, true);
        }
      });
    })();
  });
}

// Fire-and-forget release of any work items still claimed in a session (on Skip,
// Exit, or navigating away) so a partly-finished batch doesn't stay locked for
// the whole lease window.
function releaseClaims(session) {
  const ids = session.claimed;
  session.claimed = [];
  for (const wi of ids) api(`/work/${wi}/release`, { method: 'POST' }).catch(() => {});
}

/** Work setup (nav spec §12): the campaign funding a session is chosen
 *  explicitly when the collection has more than one open one. */
function chooseCampaign(container, expectedHash) {
  return new Promise((resolve) => {
    const campaigns = corpusProjects().filter((p) => p.status !== 'closed');
    if (!campaigns.length) { resolve(null); return; }
    if (campaigns.length === 1) { setActiveProject(campaigns[0].id); resolve(campaigns[0]); return; }
    const current = campaigns.find((p) => p.id === state.activeProjectId) ?? campaigns[0];
    container.innerHTML = `
      <div class="card preflight">
        <h2 style="margin-top:0">Project</h2>
        <p class="preflight-hint">Which project (campaign) is this work session for?</p>
        <label class="field"><span>Project / campaign</span>
          <select id="wk-campaign">${campaigns.map((p) =>
            `<option value="${p.id}" ${p.id === current.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <div class="rec-actions">
          <button class="secondary" id="wk-cancel">Cancel</button>
          <button id="wk-start">Continue</button>
        </div>
      </div>`;
    $('#wk-cancel', container).addEventListener('click', () => resolve(null));
    $('#wk-start', container).addEventListener('click', () => {
      if (location.hash !== expectedHash) { resolve(null); return; }
      const id = Number($('#wk-campaign', container).value);
      setActiveProject(id);
      resolve(campaigns.find((p) => p.id === id));
    });
  });
}

async function renderRecordSession() {
  endRecSession(); // "Check for more" restarts: close any prior session first
  const p = await chooseCampaign(view, '#/record');
  if (location.hash !== '#/record') return;
  if (!p) { location.hash = '#/home'; return; }
  // Quick mic check before we start claiming and cycling entries.
  const ok = await micPreflight(view);
  if (location.hash !== '#/record') return; // user navigated away during preflight
  if (!ok) { location.hash = '#/home'; return; }
  // Session setup (§8): choose the speaker once; every take inherits it.
  const spk = await chooseSpeaker(view, p);
  if (location.hash !== '#/record') return;
  if (!spk) { location.hash = '#/home'; return; }
  recSession.sessionId = spk.sessionId;
  recSession.speakerName = spk.speakerName;
  view.innerHTML = `<div class="empty">Loading…</div>`;
  let data;
  try {
    data = await api(`/projects/${p.id}/work/claim`, { method: 'POST', body: { type: 'recording', language: 'dene', limit: 20 } });
  } catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
  recSession.queue = data.items.map((i) => ({ ...i.entry, _wi: i.work_item_id }));
  recSession.pos = 0;
  recSession.total = recSession.queue.length;
  recSession.claimed = recSession.queue.map((e) => e._wi);
  renderRecordCard();
}

function renderRecordCard() {
  const entry = recSession.queue[recSession.pos];
  if (!entry) { renderRecordDone(); return; }

  const badges = [
    entry.category ? `<span class="badge">${esc(entry.category)}</span>` : '',
    entry.status !== 'draft' ? `<span class="badge status-${entry.status}">${entry.status}</span>` : '',
  ].filter(Boolean).join(' ');

  view.innerHTML = `
    <div class="rec-session">
      <div class="rec-progress">
        <a href="#/home">‹ Exit</a>
        <span>${recSession.pos + 1} of ${recSession.queue.length}${recSession.total > recSession.queue.length ? ` (${recSession.total} waiting in total)` : ''}</span>
        <span>${esc(entry.project_name)}</span>
      </div>
      <div class="card rec-card">
        <div class="rec-dene dene" lang="den">${esc(entry.dene_text)}</div>
        <div class="rec-english">${esc(entry.english_text)}</div>
        <div class="rec-stage" id="rec-stage"></div>
        <div class="rec-meta">
          ${badges ? `<div>${badges}</div>` : ''}
          ${entry.source_doc ? `<div>Source: ${esc(entry.source_doc)}</div>` : ''}
          ${entry.notes ? `<div>Notes: ${esc(entry.notes)}</div>` : ''}
          <div>Added by ${esc(entry.created_by_name)} · ${fmtDate(entry.created_at)}</div>
        </div>
      </div>
      <div class="rec-actions">
        <button class="secondary" id="save-exit" disabled>Save &amp; exit</button>
        <button id="save-next" disabled>Save &amp; next</button>
        <button class="ghost" id="skip-btn">Skip ›</button>
      </div>
    </div>`;

  setupSessionRecorder(entry);
}

function renderRecordDone() {
  view.innerHTML = `
    <div class="translator-home">
      <h1>All done 🎉</h1>
      <p class="queue-count">You went through every entry in this list. Mahsi cho!</p>
      <div class="rec-actions">
        <button class="secondary" id="back-dash">Back to dashboard</button>
        <button id="check-more">Check for more</button>
      </div>
    </div>`;
  $('#back-dash').addEventListener('click', () => { location.hash = '#/home'; });
  $('#check-more').addEventListener('click', renderRecordSession);
}

/** Record → preview → save flow for one entry card. */
function setupSessionRecorder(entry) {
  const stage = $('#rec-stage');
  const saveExit = $('#save-exit');
  const saveNext = $('#save-next');
  const skipBtn = $('#skip-btn');
  let blob = null;
  let blobUrl = null;
  let timer = null;

  function showIdle() {
    stage.innerHTML = `<button type="button" class="rec-btn big-action" id="rec-start">⏺ Record</button>`;
    $('#rec-start').addEventListener('click', startRec);
  }

  function showPreview() {
    stage.innerHTML = `
      <audio controls src="${blobUrl}"></audio>
      <button type="button" class="ghost" id="rec-again">⏺ Re-record</button>`;
    $('#rec-again').addEventListener('click', () => {
      URL.revokeObjectURL(blobUrl);
      blob = null;
      blobUrl = null;
      saveExit.disabled = saveNext.disabled = true;
      startRec();
    });
  }

  async function startRec() {
    if (Recorder.session) return;
    try {
      await Recorder.start();
    } catch {
      toast('Could not access the microphone — check browser permissions', true);
      return;
    }
    const started = Date.now();
    stage.innerHTML = `
      <span class="rec-live"><span class="rec-dot"></span> Recording — <span id="rec-time">0:00</span></span>
      <button type="button" id="rec-stop">■ Stop</button>
      <button type="button" class="ghost" id="rec-cancel">Cancel</button>`;
    timer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      const t = $('#rec-time');
      if (t) t.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 250);
    $('#rec-stop').addEventListener('click', async () => {
      clearInterval(timer);
      try {
        blob = await Recorder.stop();
        if (!blob || blob.size === 0) throw new Error('Nothing was recorded');
      } catch (err) {
        toast(err.message, true);
        showIdle();
        return;
      }
      blobUrl = URL.createObjectURL(blob);
      saveExit.disabled = saveNext.disabled = false;
      showPreview();
    });
    $('#rec-cancel').addEventListener('click', async () => {
      clearInterval(timer);
      await Recorder.cancel();
      showIdle();
    });
  }

  async function save() {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const fd = new FormData();
    fd.append('file', blob, `dene-entry${entry.id}-${stamp}.wav`);
    fd.append('language', 'dene');
    fd.append('speaker', recSession.speakerName || state.me.user.name);
    fd.append('recording_notes', 'recorded in browser');
    fd.append('capture_method', 'browser_recording');
    if (micDeviceLabel) fd.append('capture_device', micDeviceLabel);
    if (recSession.sessionId) fd.append('recording_session_id', recSession.sessionId);
    await api(`/work/${entry._wi}/submit`, { method: 'POST', body: fd });
    recSession.claimed = recSession.claimed.filter((wi) => wi !== entry._wi);
    URL.revokeObjectURL(blobUrl);
  }

  async function saveThen(after) {
    saveExit.disabled = saveNext.disabled = skipBtn.disabled = true;
    try {
      await save();
    } catch (err) {
      toast(err.message, true);
      saveExit.disabled = saveNext.disabled = skipBtn.disabled = false;
      return;
    }
    toast('Recording saved');
    after();
  }

  saveExit.addEventListener('click', () => saveThen(() => { location.hash = '#/home'; }));
  saveNext.addEventListener('click', () => saveThen(() => { recSession.pos++; renderRecordCard(); }));
  skipBtn.addEventListener('click', async () => {
    clearInterval(timer);
    if (Recorder.session) await Recorder.cancel();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    api(`/work/${entry._wi}/release`, { method: 'POST' }).catch(() => {});
    recSession.claimed = recSession.claimed.filter((wi) => wi !== entry._wi);
    recSession.pos++;
    renderRecordCard();
  });

  showIdle();
}

// ---------------------------------------------------------------------------
// Translation session — cycle through incomplete phrases and fill them in
// ---------------------------------------------------------------------------

const transSession = { queue: [], pos: 0, total: 0, claimed: [] };

async function renderTranslateSession() {
  const p = await chooseCampaign(view, '#/translate');
  if (location.hash !== '#/translate') return;
  if (!p) { location.hash = '#/home'; return; }
  view.innerHTML = `<div class="empty">Loading…</div>`;
  let data;
  try {
    data = await api(`/projects/${p.id}/work/claim`, { method: 'POST', body: { type: 'translation', limit: 20 } });
  } catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
  transSession.queue = data.items.map((i) => ({ ...i.entry, _wi: i.work_item_id }));
  transSession.pos = 0;
  transSession.total = transSession.queue.length;
  transSession.claimed = transSession.queue.map((e) => e._wi);
  renderTranslateCard();
}

function renderTranslateCard() {
  const entry = transSession.queue[transSession.pos];
  if (!entry) { renderTranslateDone(); return; }

  const badges = [
    entry.category ? `<span class="badge">${esc(entry.category)}</span>` : '',
    entry.status !== 'draft' ? `<span class="badge status-${entry.status}">${entry.status}</span>` : '',
  ].filter(Boolean).join(' ');

  view.innerHTML = `
    <div class="rec-session">
      <div class="rec-progress">
        <a href="#/home">‹ Exit</a>
        <span>${transSession.pos + 1} of ${transSession.queue.length}${transSession.total > transSession.queue.length ? ` (${transSession.total} waiting in total)` : ''}</span>
        <span>${esc(entry.project_name)}</span>
      </div>
      <div class="card">
        <form id="translate-form">
          <label class="field"><span>Dene phrase or word</span>
            <input type="text" name="dene_text" id="dene-input" class="dene" lang="den" spellcheck="false" value="${esc(entry.dene_text)}"></label>
          <label class="field"><span>English translation</span>
            <input type="text" name="english_text" value="${esc(entry.english_text)}"></label>
          <p class="error-msg" hidden></p>
          <div class="rec-meta" style="border-top:1px solid var(--line);padding-top:0.8rem;align-items:flex-start">
            ${badges ? `<div>${badges}</div>` : ''}
            ${entry.source_doc ? `<div>Source: ${esc(entry.source_doc)}</div>` : ''}
            ${entry.notes ? `<div>Notes: ${esc(entry.notes)}</div>` : ''}
            <div>Added by ${esc(entry.created_by_name)} · ${fmtDate(entry.created_at)}</div>
          </div>
        </form>
      </div>
      <div class="rec-actions">
        <button class="secondary" id="save-exit">Save &amp; exit</button>
        <button id="save-next">Save &amp; next</button>
        <button class="ghost" id="skip-btn">Skip ›</button>
      </div>
    </div>`;

  setupTranslateCard(entry);
}

function renderTranslateDone() {
  view.innerHTML = `
    <div class="translator-home">
      <h1>All done 🎉</h1>
      <p class="queue-count">Every entry in this list has a translation. Mahsi cho!</p>
      <div class="rec-actions">
        <button class="secondary" id="back-dash">Back to dashboard</button>
        <button id="check-more">Check for more</button>
      </div>
    </div>`;
  $('#back-dash').addEventListener('click', () => { location.hash = '#/home'; });
  $('#check-more').addEventListener('click', renderTranslateSession);
}

/** Fill in → save flow for one phrase card. */
function setupTranslateCard(entry) {
  const form = $('#translate-form');
  const saveExit = $('#save-exit');
  const saveNext = $('#save-next');
  const skipBtn = $('#skip-btn');

  async function save() {
    const dene = form.dene_text.value.trim();
    const english = form.english_text.value.trim();
    if (!dene && !english) throw new Error('Enter a Dene phrase or an English meaning');
    await api(`/work/${entry._wi}/submit`, {
      method: 'POST',
      body: { dene_text: dene, english_text: english },
    });
    transSession.claimed = transSession.claimed.filter((wi) => wi !== entry._wi);
  }

  async function saveThen(after) {
    saveExit.disabled = saveNext.disabled = skipBtn.disabled = true;
    try {
      await save();
    } catch (err) {
      showFormError(form, err.message);
      saveExit.disabled = saveNext.disabled = skipBtn.disabled = false;
      return;
    }
    toast('Translation saved');
    after();
  }

  saveExit.addEventListener('click', () => saveThen(() => { location.hash = '#/home'; }));
  saveNext.addEventListener('click', () => saveThen(() => { transSession.pos++; renderTranslateCard(); }));
  skipBtn.addEventListener('click', () => {
    api(`/work/${entry._wi}/release`, { method: 'POST' }).catch(() => {});
    transSession.claimed = transSession.claimed.filter((wi) => wi !== entry._wi);
    transSession.pos++;
    renderTranslateCard();
  });
}

// ---------------------------------------------------------------------------
// Dashboard view
// ---------------------------------------------------------------------------

const TARGET_HOURS = 10; // hours of transcribed audio per dialect

// Home (nav spec §9): a collection-oriented overview — counts, recent
// activity, quick actions. Campaign cards live on the Projects page.
async function renderHome() {
  const corpus = activeCorpus();
  if (!corpus) {
    view.innerHTML = `<div class="empty">
      ${isOrgAdmin()
        ? 'No collection yet — create your first project to start one.<br><br><a class="btn" href="#/projects">Go to Projects</a>'
        : 'You are not part of a collection yet.<br>Ask your organization’s administrator to add you.'}
    </div>`;
    return;
  }
  await refreshCorpora();
  const c = activeCorpus() ?? corpus;
  view.innerHTML = `
    <div class="page-head">
      <h1>${esc(c.name)}</h1>
      <div class="head-actions">
        ${isTranslator() ? '' : `<a class="btn secondary small" href="#/entries/new?kind=word">＋ Add entry</a>`}
        <a class="btn small" href="#/record">⏺ Start recording</a>
      </div>
    </div>
    <div class="stat-tiles">
      <a href="#/entries"><div class="stat-tile"><div class="num">${c.entry_count}</div><div class="lbl">Entries</div></div></a>
      <a href="#/recordings"><div class="stat-tile"><div class="num">${c.recording_count}</div><div class="lbl">Recordings</div></div></a>
      <a href="#/recordings"><div class="stat-tile"><div class="num">${fmtHours(c.audio_seconds)}</div><div class="lbl">Audio hours</div></div></a>
      <a href="#/speakers"><div class="stat-tile"><div class="num">${c.speaker_count}</div><div class="lbl">Speakers</div></div></a>
      ${isTranslator() ? '' : `<a href="#/documents"><div class="stat-tile"><div class="num">${c.document_count ?? 0}</div><div class="lbl">Documents</div></div></a>`}
    </div>
    ${isActiveOrgAdmin() ? `
      <p style="color:var(--muted)">${c.active_project_count} active project${c.active_project_count === 1 ? '' : 's'}
        · <a href="#/projects">manage projects</a></p>` : ''}
    <div class="card" id="home-recent"><h2 style="margin-top:0">Recent activity</h2>
      <div class="empty">Loading…</div></div>`;

  // Recent entries via any campaign on the corpus (stats are corpus-scoped).
  const anyCampaign = corpusProjects()[0];
  if (!anyCampaign) { $('#home-recent .empty').textContent = 'No activity yet.'; return; }
  try {
    const stats = await api(`/projects/${anyCampaign.id}/stats`);
    $('#home-recent .empty').outerHTML = stats.recent.length
      ? `<table style="width:100%"><tbody>${stats.recent.map((r) => `
          <tr><td><a href="#/entries/${r.id}" class="dene" lang="den">${esc(r.dene_text || '—')}</a></td>
              <td>${esc(r.english_text || '')}</td>
              <td style="color:var(--muted);white-space:nowrap">${esc(r.updated_by_name)} · ${fmtDate(r.updated_at)}</td></tr>`).join('')}
        </tbody></table>`
      : '<p class="empty">No activity yet.</p>';
  } catch { $('#home-recent .empty').textContent = 'No activity yet.'; }
}

// Library: corpus-level recordings browser (nav spec §11).
async function renderRecordingsLibrary(offset = 0) {
  const corpus = activeCorpus();
  if (!corpus) { view.innerHTML = '<div class="empty">No collection selected.</div>'; return; }
  view.innerHTML = `
    <div class="page-head"><h1>Recordings</h1>
      <div class="head-actions"><a class="btn small" href="#/record">⏺ Start recording</a></div></div>
    <div class="filters">
      <input type="search" id="rl-q" placeholder="Search entries or speakers…">
      <select id="rl-lang">
        <option value="">Language: any</option>
        <option value="dene">Dene</option>
        <option value="english">English</option>
      </select>
    </div>
    <div id="rl-list"><div class="empty">Loading…</div></div>
    <div class="pager" id="rl-pager"></div>`;
  const load = async (off = 0) => {
    const q = $('#rl-q').value.trim();
    const lang = $('#rl-lang').value;
    let data;
    try {
      data = await api(`/recordings?corpus_id=${corpus.id}&limit=50&offset=${off}`
        + (q ? `&q=${encodeURIComponent(q)}` : '') + (lang ? `&language=${lang}` : ''));
    } catch (err) { $('#rl-list').innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
    $('#rl-list').innerHTML = data.recordings.length ? `
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Entry</th><th>Language</th><th>Speaker</th><th>Length</th><th>Added</th><th>Project</th><th></th></tr></thead>
        <tbody>${data.recordings.map((r) => `
          <tr>
            <td><a href="#/entries/${r.entry_id}" class="dene" lang="den">${esc(r.dene_text || r.english_text || '—')}</a></td>
            <td>${r.language === 'english' ? 'English' : 'Dene'}</td>
            <td>${esc(r.speaker_name ?? '—')}</td>
            <td>${fmtDuration(r.duration_seconds)}</td>
            <td style="white-space:nowrap">${fmtDate(r.created_at)}</td>
            <td style="color:var(--muted)">${esc(r.origin_project_name ?? '—')}</td>
            <td><audio controls preload="none" src="/api/language/audio/${r.id}/stream" style="max-width:220px"></audio></td>
          </tr>`).join('')}
        </tbody></table></div></div>`
      : `<div class="empty">No recordings yet.<br><br><a class="btn" href="#/record">Start recording</a></div>`;
    const pager = $('#rl-pager');
    pager.innerHTML = data.total > data.limit ? `
      <button class="ghost small" id="rl-prev" ${off === 0 ? 'disabled' : ''}>‹ Prev</button>
      <span>${off + 1}–${Math.min(off + data.limit, data.total)} of ${data.total}</span>
      <button class="ghost small" id="rl-next" ${off + data.limit >= data.total ? 'disabled' : ''}>Next ›</button>` : '';
    $('#rl-prev')?.addEventListener('click', () => load(Math.max(0, off - data.limit)));
    $('#rl-next')?.addEventListener('click', () => load(off + data.limit));
  };
  let t;
  $('#rl-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load(0), 250); });
  $('#rl-lang').addEventListener('change', () => load(0));
  load(offset);
}

// Library: speakers (nav spec §11) — first-class page for speaker identity.
async function renderSpeakersLibrary() {
  const corpus = activeCorpus();
  if (!corpus) { view.innerHTML = '<div class="empty">No collection selected.</div>'; return; }
  view.innerHTML = `<div class="page-head"><h1>Speakers</h1></div><div id="sp-list"><div class="empty">Loading…</div></div>`;
  let data;
  try { data = await api(`/speakers?corpus_id=${corpus.id}`); }
  catch (err) { $('#sp-list').innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
  $('#sp-list').innerHTML = data.speakers.length ? `
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Speaker</th><th>Account</th><th>Recordings</th><th>Last recording</th><th>Notes</th></tr></thead>
      <tbody>${data.speakers.map((s) => `
        <tr>
          <td><b>${esc(s.display_name)}</b></td>
          <td>${s.user_id ? esc(s.user_name ?? '') : '<span style="color:var(--muted)">no account</span>'}</td>
          <td>${s.recording_count}</td>
          <td style="white-space:nowrap">${s.last_recording_at ? fmtDate(s.last_recording_at) : '—'}</td>
          <td style="color:var(--muted)">${esc(s.notes ?? '')}</td>
        </tr>`).join('')}
      </tbody></table></div></div>
    <p style="color:var(--muted);font-size:0.9rem">Speakers are registered during recording
      sessions — a person can be recorded without an account, and linked to one later.</p>`
    : `<div class="empty">No speakers yet.<br><br>Speakers are registered when a recording
        session starts — <a href="#/record">start one</a>.</div>`;
}

// ---------------------------------------------------------------------------
// Documents (documents spec, phases D+E): corpus library of source materials.
// Upload stores + indexes a source; creating Entries from a spreadsheet is a
// separate, explicit, reviewed workflow. All extracted content is escaped —
// never rendered as HTML.
// ---------------------------------------------------------------------------

let docPollTimer = null;
function stopDocPolling() {
  if (docPollTimer) { clearInterval(docPollTimer); docPollTimer = null; }
}

const DOC_STATUS_LABEL = {
  uploaded: 'Waiting…', extracting: 'Extracting text…', indexing: 'Indexing…',
  ready: 'Ready', failed: 'Failed', archived: 'Archived',
};
const docStatusBadge = (s) =>
  `<span class="badge ${s === 'ready' ? 'status-verified' : s === 'failed' ? 'incomplete' : ''}">${DOC_STATUS_LABEL[s] ?? s}</span>`;
const docLocator = (x) =>
  x.page_number ? `Page ${x.page_number}`
  : x.sheet_name ? `${x.sheet_name}${x.row_number ? ` — row ${x.row_number}` : ''}`
  : x.row_number ? `Row ${x.row_number}` : `¶ ${x.ordinal ?? ''}`;

async function renderDocumentsLibrary() {
  const corpus = activeCorpus();
  if (!corpus) { view.innerHTML = '<div class="empty">No collection selected.</div>'; return; }
  const canUpload = !isTranslator();
  view.innerHTML = `
    <div class="page-head"><h1>Documents</h1>
      <div class="head-actions">${canUpload ? '<button id="doc-upload-btn">⬆ Upload document</button>' : ''}</div></div>
    <div class="filters">
      <input type="search" id="doc-q" placeholder="Search inside documents…">
      <select id="doc-status">
        <option value="">Status: any</option>
        ${['ready', 'extracting', 'indexing', 'failed', 'archived'].map((s) => `<option value="${s}">${DOC_STATUS_LABEL[s]}</option>`).join('')}
      </select>
      <select id="doc-type">
        <option value="">Type: any</option>
        ${[['.pdf', 'PDF'], ['.docx', 'Word'], ['.xlsx', 'Excel'], ['.csv', 'CSV'], ['.txt', 'Text']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
      </select>
    </div>
    <div id="doc-list"><div class="empty">Loading…</div></div>
    <div class="pager" id="doc-pager"></div>`;

  const load = async (offset = 0) => {
    const q = $('#doc-q').value.trim();
    const params = new URLSearchParams({ corpus_id: corpus.id, limit: 50, offset });
    if (q) params.set('q', q);
    if ($('#doc-status').value) params.set('status', $('#doc-status').value);
    if ($('#doc-type').value) params.set('type', $('#doc-type').value);
    let data;
    try { data = await api('/documents?' + params); }
    catch (err) { $('#doc-list').innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
    if (!data.documents.length) {
      $('#doc-list').innerHTML = q
        ? '<div class="empty">No documents match.</div>'
        : `<div class="empty">No documents yet.<br><br>
            Upload dictionaries, Word files, spreadsheets, phrasebooks and other
            language materials to make them searchable.<br><br>
            ${canUpload ? '<button class="btn" id="doc-upload-empty">⬆ Upload document</button>' : ''}</div>`;
      $('#doc-upload-empty')?.addEventListener('click', showDocumentUploadModal);
      $('#doc-pager').innerHTML = '';
      return;
    }
    $('#doc-list').innerHTML = `
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Size</th><th>Uploaded by</th><th>Added</th></tr></thead>
        <tbody>${data.documents.map((d) => `
          <tr style="cursor:pointer" data-doc="${d.id}">
            <td><b>${esc(d.title)}</b>
              ${d.excerpt ? `<div style="color:var(--muted);font-size:0.85rem">${esc(docLocator(d.excerpt))} · “${esc(d.excerpt.snippet)}”</div>` : ''}</td>
            <td>${esc(d.type_label)}</td>
            <td>${docStatusBadge(d.status)}</td>
            <td>${fmtBytes(d.size_bytes)}</td>
            <td>${esc(d.uploaded_by_name)}</td>
            <td style="white-space:nowrap">${fmtDate(d.created_at)}</td>
          </tr>`).join('')}
        </tbody></table></div></div>`;
    $('#doc-pager').innerHTML = data.total > data.limit ? `
      <button class="ghost small" id="doc-prev" ${offset === 0 ? 'disabled' : ''}>‹ Prev</button>
      <span>${offset + 1}–${Math.min(offset + data.limit, data.total)} of ${data.total}</span>
      <button class="ghost small" id="doc-next" ${offset + data.limit >= data.total ? 'disabled' : ''}>Next ›</button>` : '';
    $('#doc-prev')?.addEventListener('click', () => load(Math.max(0, offset - data.limit)));
    $('#doc-next')?.addEventListener('click', () => load(offset + data.limit));
    view.querySelectorAll('tr[data-doc]').forEach((tr) =>
      tr.addEventListener('click', () => { location.hash = `#/documents/${tr.dataset.doc}`; }));
  };
  let t;
  $('#doc-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load(0), 300); });
  $('#doc-status').addEventListener('change', () => load(0));
  $('#doc-type').addEventListener('change', () => load(0));
  $('#doc-upload-btn')?.addEventListener('click', showDocumentUploadModal);
  load(0);
}

function showDocumentUploadModal() {
  const corpus = activeCorpus();
  const campaigns = corpusProjects().filter((p) => p.status !== 'closed');
  const m = openModal(`
    <h2>Upload document</h2>
    <p style="color:var(--muted);font-size:0.9rem;max-width:52ch">The original file is stored
      permanently and its text made searchable. Supported: PDF, Word (.docx),
      Excel (.xlsx), CSV, TXT.</p>
    <form id="doc-upload-form">
      <label class="field"><span>File</span>
        <input type="file" name="file" required accept=".pdf,.docx,.xlsx,.csv,.txt"></label>
      <label class="field"><span>Title (optional)</span>
        <input type="text" name="title" placeholder="defaults to the file name"></label>
      ${campaigns.length > 1 ? `
      <label class="field"><span>Project source (optional)</span>
        <select name="origin_project_id"><option value="">— none —</option>
          ${campaigns.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>` : ''}
      <p class="error-msg" hidden></p>
      <div class="form-actions">
        <button type="submit" id="doc-upload-submit">Upload</button>
        <button type="button" class="ghost" onclick="document.querySelector('.modal-backdrop').remove()">Cancel</button>
      </div>
    </form>`);
  $('#doc-upload-form', m).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!f.file.files[0]) return;
    $('#doc-upload-submit').disabled = true;
    const fd = new FormData();
    fd.append('file', f.file.files[0]);
    fd.append('corpus_id', String(activeCorpus().id));
    if (f.title.value.trim()) fd.append('title', f.title.value.trim());
    if (f.origin_project_id?.value) fd.append('origin_project_id', f.origin_project_id.value);
    try {
      const doc = await api('/documents', { method: 'POST', body: fd });
      closeModal();
      toast('Document uploaded. Processing has started.');
      refreshCorpora();
      location.hash = `#/documents/${doc.id}`; // hashchange routes to the detail view
    } catch (err) {
      $('#doc-upload-submit').disabled = false;
      showFormError(f, err.message);
    }
  });
}

async function renderDocumentDetail(id) {
  stopDocPolling();
  view.innerHTML = '<div class="empty">Loading…</div>';
  let d;
  try { d = await api(`/documents/${id}`); }
  catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }

  const processing = ['uploaded', 'extracting', 'indexing'].includes(d.status);
  const isSheet = ['.xlsx', '.csv'].includes(d.extension);
  const sheets = d.extraction?.sheets ?? (d.extension === '.csv' && d.block_count
    ? [{ name: null, rows: d.extraction?.row_count ?? d.block_count, headers: d.extraction?.headers ?? [] }] : null);

  view.innerHTML = `
    <div class="page-head">
      <h1>${esc(d.title)}</h1>
      <a class="btn secondary" href="#/documents">‹ Back to documents</a>
    </div>
    <p style="color:var(--muted)">${esc(d.type_label)} · ${fmtBytes(d.size_bytes)} · ${docStatusBadge(d.status)}<br>
      Uploaded ${fmtDate(d.created_at)}${d.uploaded_by_name ? ` by ${esc(d.uploaded_by_name)}` : ''}
      ${d.linked_entry_count ? ` · ${d.linked_entry_count} linked entr${d.linked_entry_count === 1 ? 'y' : 'ies'}` : ''}</p>
    <div class="rec-actions" style="justify-content:flex-start;margin-bottom:1rem">
      <a class="btn secondary small" href="/api/language/documents/${d.id}/original">⬇ Download original</a>
      ${isSheet && d.status === 'ready' && !isTranslator() ? `<button class="small" id="doc-create-entries">Create entries…</button>` : ''}
      ${d.can_manage ? `
        <button class="ghost small" id="doc-reprocess">Reprocess</button>
        ${d.status === 'archived'
          ? '<button class="ghost small" id="doc-restore">Restore</button>'
          : '<button class="ghost small" id="doc-archive">Archive</button>'}
        <button class="danger small" id="doc-delete">Delete</button>` : ''}
    </div>
    ${d.status === 'failed' ? `
      <div class="card"><b>Processing failed.</b>
        <p style="color:var(--muted)">${esc(d.error_message ?? 'Unknown error')}</p>
        ${d.can_manage ? '<button id="doc-retry">Try again</button>' : ''}</div>` : ''}
    ${processing ? `<div class="card" id="doc-processing">${DOC_STATUS_LABEL[d.status]}</div>` : ''}
    ${d.extraction?.requires_ocr ? `
      <div class="card" style="color:var(--muted)">No searchable text was found — this PDF may be scanned.
        The original is stored safely; a future OCR pass can process it.</div>` : ''}
    ${d.status === 'ready' ? `
      <div class="card">
        <label class="field" style="max-width:420px"><span>Search this document</span>
          <input type="search" id="doc-search" placeholder="e.g. a word or phrase"></label>
        <div id="doc-search-results"></div>
      </div>
      <div class="card" id="doc-content"><div class="empty">Loading content…</div></div>` : ''}`;

  $('#doc-reprocess')?.addEventListener('click', async () => {
    if (!confirm('Re-run extraction and indexing? The original file is untouched.')) return;
    try { await api(`/documents/${d.id}/reprocess`, { method: 'POST' }); renderDocumentDetail(id); }
    catch (err) { toast(err.message, true); }
  });
  $('#doc-retry')?.addEventListener('click', async () => {
    try { await api(`/documents/${d.id}/reprocess`, { method: 'POST' }); renderDocumentDetail(id); }
    catch (err) { toast(err.message, true); }
  });
  $('#doc-archive')?.addEventListener('click', async () => {
    if (!confirm('Archive this document? It leaves browse and search but is kept, with its provenance, and can be restored.')) return;
    try { await api(`/documents/${d.id}/archive`, { method: 'POST' }); toast('Document archived'); renderDocumentDetail(id); }
    catch (err) { toast(err.message, true); }
  });
  $('#doc-restore')?.addEventListener('click', async () => {
    try { await api(`/documents/${d.id}/restore`, { method: 'POST' }); toast('Document restored'); renderDocumentDetail(id); }
    catch (err) { toast(err.message, true); }
  });
  $('#doc-delete')?.addEventListener('click', async () => {
    const t = prompt('Permanently delete this document and its extracted text?\nType the exact title to confirm:');
    if (t === null) return;
    try {
      await api(`/documents/${d.id}`, { method: 'DELETE', body: { confirm_title: t } });
      toast('Document deleted');
      refreshCorpora();
      location.hash = '#/documents';
    } catch (err) { toast(err.message, true); }
  });
  $('#doc-create-entries')?.addEventListener('click', () => showCreateEntriesWizard(d));

  // Poll while ingestion runs; stop on terminal states or navigation.
  if (processing) {
    docPollTimer = setInterval(async () => {
      try {
        const fresh = await api(`/documents/${id}`);
        if (fresh.status !== d.status) { stopDocPolling(); renderDocumentDetail(id); }
      } catch { stopDocPolling(); }
    }, 1500);
    return;
  }
  if (d.status !== 'ready') return;

  // In-document search.
  let st;
  $('#doc-search').addEventListener('input', () => {
    clearTimeout(st);
    st = setTimeout(async () => {
      const q = $('#doc-search').value.trim();
      const box = $('#doc-search-results');
      if (!q) { box.innerHTML = ''; return; }
      try {
        const { results } = await api(`/documents/${d.id}/search?q=${encodeURIComponent(q)}`);
        box.innerHTML = results.length
          ? results.map((x) => `
              <div class="version-row" style="cursor:pointer" data-page="${x.page_number ?? ''}" data-sheet="${esc(x.sheet_name ?? '')}">
                <span><span class="badge">${esc(docLocator(x))}</span> ${esc(x.snippet)}</span>
              </div>`).join('')
          : '<p class="empty">No matches in this document.</p>';
        box.querySelectorAll('[data-page],[data-sheet]').forEach((el) =>
          el.addEventListener('click', () => loadDocContent(d, { page: el.dataset.page, sheet: el.dataset.sheet })));
      } catch (err) { box.innerHTML = `<p class="empty">${esc(err.message)}</p>`; }
    }, 300);
  });

  // Content: sheet chooser for spreadsheets, paged blocks otherwise.
  async function loadDocContent(doc, { page = '', sheet = '', offset = 0 } = {}) {
    const box = $('#doc-content');
    if (!box) return;
    const params = new URLSearchParams({ limit: 100, offset });
    if (page) params.set('page', page);
    if (sheet) params.set('sheet', sheet);
    let data;
    try { data = await api(`/documents/${doc.id}/blocks?` + params); }
    catch (err) { box.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
    const sheetPicker = sheets?.length && sheets[0].name ? `
      <div style="margin-bottom:0.7rem">Sheets: ${sheets.map((s) =>
        `<button class="ghost small" data-open-sheet="${esc(s.name)}">${esc(s.name)} (${s.rows} rows)</button>`).join(' ')}</div>` : '';
    let body;
    if (!data.blocks.length) {
      body = '<p class="empty">No extracted content.</p>';
    } else if (data.blocks[0].block_type === 'sheet_row') {
      const headers = Object.keys(JSON.parse(data.blocks[0].metadata_json ?? '{}').cells ?? {});
      body = `<div class="table-wrap"><table>
        <thead><tr><th>Row</th>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${data.blocks.map((b) => {
          const cells = JSON.parse(b.metadata_json ?? '{}').cells ?? {};
          return `<tr><td style="color:var(--muted)">${b.row_number ?? b.ordinal}</td>
            ${headers.map((h) => `<td>${esc(String(cells[h] ?? ''))}</td>`).join('')}</tr>`;
        }).join('')}</tbody></table></div>`;
    } else {
      let lastPage = null;
      body = data.blocks.map((b) => {
        const pageHead = b.page_number && b.page_number !== lastPage
          ? `<h3 style="margin:1rem 0 0.3rem;color:var(--muted)">Page ${b.page_number}</h3>` : '';
        lastPage = b.page_number ?? lastPage;
        const tag = b.block_type === 'heading' ? 'h3' : 'p';
        return `${pageHead}<${tag} style="white-space:pre-wrap">${esc(b.text)}</${tag}>`;
      }).join('');
    }
    const pager = data.total > data.limit ? `
      <div class="pager">
        <button class="ghost small" id="db-prev" ${offset === 0 ? 'disabled' : ''}>‹ Prev</button>
        <span>${offset + 1}–${Math.min(offset + data.limit, data.total)} of ${data.total}</span>
        <button class="ghost small" id="db-next" ${offset + data.limit >= data.total ? 'disabled' : ''}>Next ›</button>
      </div>` : '';
    box.innerHTML = `<h2 style="margin-top:0">Content${sheet ? ` — ${esc(sheet)}` : page ? ` — page ${page}` : ''}</h2>${sheetPicker}${body}${pager}`;
    box.querySelectorAll('[data-open-sheet]').forEach((btn) =>
      btn.addEventListener('click', () => loadDocContent(doc, { sheet: btn.dataset.openSheet })));
    $('#db-prev')?.addEventListener('click', () => loadDocContent(doc, { page, sheet, offset: Math.max(0, offset - data.limit) }));
    $('#db-next')?.addEventListener('click', () => loadDocContent(doc, { page, sheet, offset: offset + data.limit }));
  }
  loadDocContent(d, sheets?.length && sheets[0].name ? { sheet: sheets[0].name } : {});
}

// Structured import wizard (documents spec §43): sheet -> column mapping ->
// kind -> preview -> confirm. Entry creation happens server-side with the
// corpus dedup rules; every entry keeps sheet/row provenance.
async function showCreateEntriesWizard(d) {
  const sheets = (d.extraction?.sheets ?? []).filter((s) => s.rows > 0);
  const singleSheet = !sheets.length || !sheets[0]?.name;
  const campaigns = corpusProjects().filter((p) => p.status !== 'closed');
  const state_ = { sheet: singleSheet ? null : sheets[0].name, kind: 'word' };

  const headersFor = async () => {
    if (!singleSheet) return sheets.find((s) => s.name === state_.sheet)?.headers ?? [];
    if (d.extraction?.headers) return d.extraction.headers;
    const { blocks } = await api(`/documents/${d.id}/blocks?limit=1`);
    return Object.keys(JSON.parse(blocks[0]?.metadata_json ?? '{}').cells ?? {});
  };
  const guess = (h) => {
    const s = h.toLowerCase();
    if (/dene|slavey|tł|indigenous|word|phrase/.test(s) && !/english/.test(s)) return 'dene';
    if (/english|meaning|translation|gloss/.test(s)) return 'english';
    if (/categor|topic|tag/.test(s)) return 'category';
    if (/note|comment/.test(s)) return 'notes';
    return '';
  };

  const headers = await headersFor();
  const m = openModal(`
    <h2>Create entries from ${esc(d.title)}</h2>
    <form id="wizard-form">
      ${!singleSheet ? `
      <label class="field"><span>Sheet</span>
        <select name="sheet">${sheets.map((s) => `<option value="${esc(s.name)}">${esc(s.name)} (${s.rows} rows)</option>`).join('')}</select></label>` : ''}
      <label class="field"><span>Create as</span>
        <select name="kind"><option value="word">Dictionary words</option><option value="phrase">Phrases</option></select></label>
      ${campaigns.length > 1 ? `
      <label class="field"><span>Project (campaign the work belongs to)</span>
        <select name="origin_project_id">${campaigns.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>` : ''}
      <div id="wizard-mapping"></div>
      <div id="wizard-preview" style="margin-top:0.6rem"></div>
      <p class="error-msg" hidden></p>
      <div class="form-actions">
        <button type="button" class="secondary" id="wizard-preview-btn">Preview</button>
        <button type="submit" id="wizard-confirm" disabled>Create entries</button>
        <button type="button" class="ghost" onclick="document.querySelector('.modal-backdrop').remove()">Cancel</button>
      </div>
    </form>`);

  const renderMapping = (hs) => {
    $('#wizard-mapping', m).innerHTML = `
      <p style="margin:0.6rem 0 0.2rem;font-weight:600">Column mapping</p>
      ${hs.map((h) => `
        <label class="field" style="flex-direction:row;align-items:center;gap:0.6rem;max-width:420px">
          <span style="flex:1">${esc(h)}</span>
          <select data-map="${esc(h)}">
            <option value="">Ignore</option>
            <option value="dene" ${guess(h) === 'dene' ? 'selected' : ''}>Dene text</option>
            <option value="english" ${guess(h) === 'english' ? 'selected' : ''}>English text</option>
            <option value="category" ${guess(h) === 'category' ? 'selected' : ''}>Category</option>
            <option value="notes" ${guess(h) === 'notes' ? 'selected' : ''}>Notes</option>
          </select>
        </label>`).join('')}`;
  };
  renderMapping(headers);
  m.querySelector('[name=sheet]')?.addEventListener('change', async (e) => {
    state_.sheet = e.target.value;
    renderMapping(await headersFor());
    $('#wizard-preview', m).innerHTML = '';
    $('#wizard-confirm', m).disabled = true;
  });

  const currentMapping = () => {
    const map = {};
    m.querySelectorAll('[data-map]').forEach((sel) => { if (sel.value) map[sel.dataset.map] = sel.value; });
    return map;
  };

  $('#wizard-preview-btn', m).addEventListener('click', async () => {
    const mapping = currentMapping();
    if (!Object.values(mapping).some((v) => v === 'dene' || v === 'english')) {
      showFormError($('#wizard-form', m), 'Map at least one column to Dene text or English text');
      return;
    }
    const params = new URLSearchParams({ limit: 200 });
    if (state_.sheet) params.set('sheet', state_.sheet);
    const { blocks, total } = await api(`/documents/${d.id}/blocks?` + params);
    const mapped = blocks.map((b) => {
      const cells = JSON.parse(b.metadata_json ?? '{}').cells ?? {};
      const get = (f) => Object.entries(mapping).filter(([, v]) => v === f).map(([h]) => String(cells[h] ?? '').trim()).find(Boolean) ?? '';
      return { row: b.row_number ?? b.ordinal, dene: get('dene'), english: get('english') };
    });
    const valid = mapped.filter((r) => r.dene || r.english);
    $('#wizard-preview', m).innerHTML = `
      <p style="font-weight:600;margin:0.4rem 0 0.2rem">Preview (first ${Math.min(20, valid.length)} of ~${total} rows · ${valid.length} usable in sample, ${mapped.length - valid.length} empty)</p>
      <div class="table-wrap" style="max-height:220px;overflow:auto"><table>
        <thead><tr><th>Row</th><th>Dene</th><th>English</th></tr></thead>
        <tbody>${valid.slice(0, 20).map((r) => `
          <tr><td style="color:var(--muted)">${r.row}</td>
              <td class="dene" lang="den">${esc(r.dene) || '<i style="color:var(--muted)">— queued for translation —</i>'}</td>
              <td>${esc(r.english) || '<i style="color:var(--muted)">— queued for translation —</i>'}</td></tr>`).join('')}
        </tbody></table></div>`;
    $('#wizard-confirm', m).disabled = valid.length === 0;
  });

  $('#wizard-form', m).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    $('#wizard-confirm', m).disabled = true;
    try {
      const r = await api(`/documents/${d.id}/create-entries`, {
        method: 'POST',
        body: {
          sheet: state_.sheet ?? undefined,
          kind: f.kind.value,
          mapping: currentMapping(),
          origin_project_id: f.origin_project_id?.value ? Number(f.origin_project_id.value) : undefined,
        },
      });
      closeModal();
      toast(`Created ${r.created} entr${r.created === 1 ? 'y' : 'ies'}`
        + (r.skipped_duplicates ? ` · ${r.skipped_duplicates} duplicates skipped` : '')
        + (r.skipped_already_imported ? ` · ${r.skipped_already_imported} already imported` : ''));
      refreshCorpora();
      renderDocumentDetail(d.id);
    } catch (err) {
      $('#wizard-confirm', m).disabled = false;
      showFormError(f, err.message);
    }
  });
}

async function renderProjects() {
  const isSuper = isOrgAdmin(); // org admins get the rollup + project lifecycle
  view.innerHTML = `<div class="empty">Loading…</div>`;

  let data;
  try { data = await api('/projects'); }
  catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
  // Work context (nav spec §12): campaigns operating on the ACTIVE collection.
  const corpus = activeCorpus();
  const projects = corpus
    ? data.projects.filter((p) => p.corpus_id === corpus.id)
    : data.projects.filter((p) => p.organization_id === activeOrg()?.id);

  view.innerHTML = `
    <div class="page-head">
      <h1>Projects</h1>
      ${isSuper ? '<button id="new-project-btn">＋ New project</button>' : ''}
    </div>
    <p style="color:var(--muted);max-width:62ch;margin-top:-0.5rem">Projects are funded
      campaigns of work on <b>${esc(corpus?.name ?? 'this collection')}</b> — the collection
      keeps the entries and recordings permanently, whichever campaign contributed them.</p>
    <div class="stat-grid">
      ${projects.map((p) => projectCardHtml(p)).join('') ||
        '<div class="empty">No projects yet.</div>'}
    </div>
    <div id="project-detail"></div>`;

  $('#new-project-btn')?.addEventListener('click', showNewProjectModal);

  view.onclick = async (e) => {
    const btn = e.target.closest('button[data-proj-action]');
    if (!btn) return;
    const pid = btn.dataset.id;
    const action = btn.dataset.projAction;
    if (action === 'activity') await showProjectActivity(pid);
    if (action === 'edit') showEditProjectModal(pid);
    if (action === 'import') showImportModal(pid, btn.dataset.name);
    if (action === 'consent') showConsentModal(pid);
    if (action === 'delete') showDeleteProjectModal(pid, btn.dataset.name);
  };
}

// Consent controls for a project (#6): pick the default profile stamped onto new
// recordings, and bulk-assign a profile to existing consent-unknown recordings.
async function showConsentModal(projectId) {
  const p = state.me.projects.find((x) => x.id === Number(projectId));
  if (!p) return;
  let profiles = [];
  try { profiles = (await api(`/orgs/${p.organization_id}/consent-profiles`)).profiles; }
  catch (err) { toast(err.message, true); return; }
  const opts = profiles.map((pr) =>
    `<option value="${pr.id}" ${p.default_consent_profile_id === pr.id ? 'selected' : ''}>${esc(pr.name)}</option>`).join('');
  openModal(`
    <h2>Consent — ${esc(p.name)}</h2>
    <p style="color:var(--muted);font-size:0.9rem;max-width:52ch">New recordings are stamped with the
      default profile below. Existing recordings without consent stay
      <b>consent-unknown</b> (excluded from purpose-filtered exports) until assigned.</p>
    ${profiles.length ? `
    <form id="consent-default-form">
      <label class="field"><span>Default profile for new recordings</span>
        <select name="profile_id"><option value="">— none (consent-unknown) —</option>${opts}</select></label>
      <div class="rec-actions">
        <button type="submit">Save default</button>
        <button type="button" class="secondary" id="bulk-assign-btn">Assign to existing consent-unknown recordings</button>
      </div>
    </form>` : `<p>No consent profiles yet — create one on the <a href="#/org">Organization</a> page first.</p>`}
  `);
  $('#consent-default-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = e.target.profile_id.value;
    try {
      await api(`/projects/${projectId}/consent-default`, { method: 'PUT', body: { profile_id: v ? Number(v) : null } });
      toast('Default consent profile saved');
      closeModal();
      loadMe().then(renderProjects);
    } catch (err) { toast(err.message, true); }
  });
  $('#bulk-assign-btn')?.addEventListener('click', async (e) => {
    const sel = $('#consent-default-form').profile_id.value;
    if (!sel) { toast('Pick a profile to assign', true); return; }
    const prof = profiles.find((x) => x.id === Number(sel));
    if (!confirm(`Stamp "${prof.name}" onto every consent-unknown recording in ${p.name}? Recordings that already have consent are untouched. This is recorded in the audit trail.`)) return;
    try {
      const r = await api(`/projects/${projectId}/consent/assign`, { method: 'POST', body: { profile_id: prof.id } });
      toast(`Assigned to ${r.assigned} recording${r.assigned === 1 ? '' : 's'}`);
    } catch (err) { toast(err.message, true); }
  });
}

function showEditProjectModal(projectId) {
  const p = state.me.projects.find((x) => x.id === Number(projectId));
  if (!p) return;
  const m = openModal(`
    <h2>Edit project</h2>
    <form id="edit-project-form">
      <label class="field"><span>Project name</span>
        <input type="text" name="name" required value="${esc(p.name)}"></label>
      <label class="field"><span>Dialect / community</span>
        <input type="text" name="dialect" value="${esc(p.dialect ?? '')}"></label>
      <label class="field"><span>Description</span>
        <input type="text" name="description" value="${esc(p.description ?? '')}"></label>
      <p class="error-msg" hidden></p>
      <div class="form-actions">
        <button type="submit">Save changes</button>
        <button type="button" class="ghost" onclick="document.querySelector('.modal-backdrop').remove()">Cancel</button>
      </div>
    </form>`);
  $('#edit-project-form', m).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api(`/projects/${projectId}`, {
        method: 'PATCH',
        body: { name: f.name.value, dialect: f.dialect.value, description: f.description.value },
      });
      closeModal();
      toast('Project updated');
      await loadMe();
      renderProjects();
    } catch (err) { showFormError(f, err.message); }
  });
}

function showDeleteProjectModal(projectId, projectName) {
  const m = openModal(`
    <h2 style="color:var(--danger)">Delete project</h2>
    <p>This permanently deletes <b>${esc(projectName)}</b> — every entry, every audio
      recording, and all member access. <b>This cannot be undone.</b></p>
    <form id="delete-project-form">
      <label class="field"><span>Type the project name to confirm</span>
        <input type="text" name="confirm_name" required autocomplete="off"
          placeholder="${esc(projectName)}"></label>
      <p class="error-msg" hidden></p>
      <div class="form-actions">
        <button type="submit" class="danger">Delete project forever</button>
        <button type="button" class="ghost" onclick="document.querySelector('.modal-backdrop').remove()">Cancel</button>
      </div>
    </form>`);
  $('#delete-project-form', m).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api(`/projects/${projectId}`, {
        method: 'DELETE',
        body: { confirm_name: f.confirm_name.value },
      });
      closeModal();
      toast(`Project deleted (${r.deleted_entries} entries, ${r.deleted_recordings} recordings removed)`);
      await loadMe();
      renderProjects();
    } catch (err) { showFormError(f, err.message); }
  });
}

function showImportModal(projectId, projectName) {
  const m = openModal(`
    <h2>Import CSV — ${esc(projectName)}</h2>
    <p style="color:var(--muted);font-size:0.9rem">
      A CSV with two text columns: Dene and English, plus an optional third
      <b>Category</b> column. A header row like <code>dene_text,english_text,category</code>
      (or "Dene Text","English Text","Category") is used if present; otherwise the
      columns are taken in that order. Every row with text in <b>either</b> column is
      imported — one-sided rows are queued for translation. Rows already in the
      project and duplicates within the file are skipped, so re-importing the same
      file is safe. Max 10,000 rows per file.</p>
    <form id="import-form">
      <label class="field"><span>Import as</span>
        <select name="kind">
          <option value="word">Dictionary words</option>
          <option value="phrase">Phrases</option>
        </select></label>
      <label class="field"><span>CSV file</span>
        <input type="file" name="file" accept=".csv,.txt,text/csv" required></label>
      <p class="error-msg" hidden></p>
      <div class="form-actions">
        <button type="submit" id="import-submit">Import</button>
        <button type="button" class="ghost" onclick="document.querySelector('.modal-backdrop').remove()">Cancel</button>
      </div>
    </form>`);
  $('#import-form', m).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const fd = new FormData();
    fd.append('kind', f.kind.value); // before the file so multer parses it
    fd.append('file', f.file.files[0]);
    const btn = $('#import-submit', m);
    btn.disabled = true;
    btn.textContent = 'Importing…';
    try {
      const r = await api(`/projects/${projectId}/import`, { method: 'POST', body: fd });
      closeModal();
      const parts = [`Imported ${r.imported} entries`];
      if (r.skipped_duplicates) parts.push(`${r.skipped_duplicates} duplicates skipped`);
      if (r.skipped_invalid) parts.push(`${r.skipped_invalid} incomplete rows skipped`);
      toast(parts.join(' · '));
      renderProjects();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Import';
      showFormError(f, err.message);
    }
  });
}

function projectCardHtml(p) {
  const hours = (p.audio_seconds || 0) / 3600;
  const pct = Math.min(100, (hours / TARGET_HOURS) * 100);
  const admin = isAdminOf(p.id);
  return `
    <div class="card project-card">
      <h2>${esc(p.name)}</h2>
      <div class="dialect">${esc(p.dialect ?? '')}${p.description ? ` · ${esc(p.description)}` : ''}</div>
      <div class="stat-numbers">
        <div><div class="num">${p.entry_count}</div><div class="lbl">Entries</div></div>
        <div><div class="num">${p.audio_count}</div><div class="lbl">Recordings</div></div>
        <div><div class="num">${fmtHours(p.audio_seconds)}</div><div class="lbl">Audio hrs</div></div>
      </div>
      <div class="progress"><div style="width:${pct.toFixed(1)}%"></div></div>
      <div class="progress-label">${hours.toFixed(2)} / ${TARGET_HOURS} hrs toward transcription goal</div>
      <div class="card-actions">
        <button class="ghost small" data-proj-action="activity" data-id="${p.id}">Recent activity</button>
        ${admin ? `
          <a class="btn secondary small" style="padding:0.25rem 0.6rem;font-size:0.85rem" href="/api/language/projects/${p.id}/export?format=csv">Export CSV</a>
          <a class="btn secondary small" style="padding:0.25rem 0.6rem;font-size:0.85rem" href="/api/language/projects/${p.id}/export?format=json">Export JSON</a>
          <a class="btn secondary small" style="padding:0.25rem 0.6rem;font-size:0.85rem" href="/api/language/projects/${p.id}/export-bundle" title="Complete archive: entries + master audio + checksums">⬇ Full archive (ZIP)</a>` : ''}
        ${isOrgAdmin() ? `
          <button class="ghost small" data-proj-action="edit" data-id="${p.id}">Edit</button>
          <button class="ghost small" data-proj-action="import" data-id="${p.id}" data-name="${esc(p.name)}">Import CSV</button>
          <button class="ghost small" data-proj-action="consent" data-id="${p.id}">Consent</button>
          <button class="danger small" data-proj-action="delete" data-id="${p.id}" data-name="${esc(p.name)}">Delete</button>` : ''}
      </div>
    </div>`;
}

async function showProjectActivity(projectId) {
  const target = $('#project-detail');
  target.innerHTML = '<div class="card">Loading…</div>';
  try {
    const s = await api(`/projects/${projectId}/stats`);
    const pname = esc(state.me.projects.find((p) => p.id === Number(projectId))?.name ?? 'Project');
    target.innerHTML = `
      <div class="card">
        <h2 style="margin-top:0">${pname} — recent activity</h2>
        ${s.recent.length ? `<ul class="recent-list">
          ${s.recent.map((r) => `
            <li><a href="#/entries/${r.id}"><b>${esc(r.dene_text)}</b></a> — ${esc(r.english_text)}
              <div class="when">edited by ${esc(r.updated_by_name)} · ${fmtDate(r.updated_at)}</div></li>`).join('')}
        </ul>` : '<p style="color:var(--muted)">No entries yet.</p>'}
        ${s.contributors.length ? `
          <h3>Contributors</h3>
          <ul class="recent-list">
            ${s.contributors.map((c) => `<li>${esc(c.name)} — ${c.entry_count} entries</li>`).join('')}
          </ul>` : ''}
      </div>`;
    target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) { target.innerHTML = `<div class="card error-msg">${esc(err.message)}</div>`; }
}

function showNewProjectModal() {
  const m = openModal(`
    <h2>New project</h2>
    <form id="proj-form">
      <label class="field"><span>Project name</span>
        <input type="text" name="name" required placeholder="e.g. Sahtú Got'ı̨nę Yatı̨́"></label>
      <label class="field"><span>Dialect / community</span>
        <input type="text" name="dialect" placeholder="e.g. North Slavey — Délı̨nę"></label>
      <label class="field"><span>Description</span>
        <input type="text" name="description"></label>
      <p class="error-msg" hidden></p>
      <div class="form-actions">
        <button type="submit">Create project</button>
        <button type="button" class="ghost" onclick="document.querySelector('.modal-backdrop').remove()">Cancel</button>
      </div>
    </form>`);
  $('#proj-form', m).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/projects', {
        method: 'POST',
        body: {
          name: f.name.value, dialect: f.dialect.value, description: f.description.value,
          // create inside the organization the top bar is showing
          ...(activeOrg() ? { organization_id: activeOrg().id } : {}),
        },
      });
      closeModal();
      await loadMe();
      toast('Project created');
      renderProjects();
    } catch (err) { showFormError(f, err.message); }
  });
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Organizations view (superadmin) — platform provisioning: create tenants,
// appoint their owner, toggle application entitlements. No corpus access.
// ---------------------------------------------------------------------------

async function renderOrgsAdmin() {
  view.innerHTML = `<div class="empty">Loading…</div>`;
  let data;
  try { data = await api('/admin/orgs'); }
  catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }

  view.innerHTML = `
    <div class="page-head">
      <h1>Organizations</h1>
      <button id="new-org-btn">＋ New organization</button>
    </div>
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Owners</th><th>Members</th><th>Projects</th><th>Language app</th><th>Created</th><th></th></tr></thead>
        <tbody>
          ${data.orgs.map((o) => `
            <tr>
              <td>${esc(o.name)}</td>
              <td>${esc(o.owners ?? '—')}</td>
              <td>${o.member_count}</td>
              <td>${o.project_count}</td>
              <td><span class="badge ${o.language_status === 'enabled' ? 'status-verified' : 'incomplete'}">${o.language_status}</span></td>
              <td>${fmtDate(o.created_at)}</td>
              <td style="white-space:nowrap">
                <button class="ghost small" data-app-toggle="${o.id}" data-status="${o.language_status}" data-name="${esc(o.name)}">
                  ${o.language_status === 'enabled' ? 'Disable Language' : 'Enable Language'}</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table></div>
      <p style="color:var(--muted);font-size:0.85rem;margin-bottom:0">
        Organizations own their corpus — platform administration grants no access to any
        organization's data. Each organization's owner manages its projects, members,
        consent profiles, and exports from their own <b>Organization</b> page.</p>
    </div>`;

  $('#new-org-btn').addEventListener('click', () => {
    const m = openModal(`
      <h2>New organization</h2>
      <p style="color:var(--muted);font-size:0.9rem">The owner becomes the organization's
        <b>owner admin</b>. If no account exists for that email, one is created and an
        invite (set-password) email is sent. Language is enabled automatically.</p>
      <form id="org-form">
        <label class="field"><span>Organization name</span>
          <input type="text" name="name" required placeholder="e.g. Tłı̨chǫ Government"></label>
        <label class="field"><span>Owner email</span>
          <input type="email" name="owner_email" placeholder="blank = you are the owner"></label>
        <label class="field"><span>Owner name (for a new account)</span>
          <input type="text" name="owner_name" placeholder="only needed if the account doesn't exist yet"></label>
        <p class="error-msg" hidden></p>
        <div class="form-actions">
          <button type="submit">Create organization</button>
          <button type="button" class="ghost" onclick="document.querySelector('.modal-backdrop').remove()">Cancel</button>
        </div>
      </form>`);
    $('#org-form', m).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const ownerEmail = f.owner_email.value.trim();
      const createOrg = () => api('/orgs', {
        method: 'POST',
        body: { name: f.name.value, ...(ownerEmail ? { owner_email: ownerEmail } : {}) },
      });
      try {
        let invite = null;
        try {
          await createOrg();
        } catch (err) {
          // Owner account doesn't exist yet: create it (invite flow) and retry.
          if (!/no account/i.test(err.message) || !ownerEmail) throw err;
          if (!f.owner_name.value.trim()) {
            throw new Error('No account with that email — fill in the owner name to create one');
          }
          invite = await api('/users', {
            method: 'POST',
            body: { email: ownerEmail, name: f.owner_name.value.trim() },
          });
          await createOrg();
        }
        closeModal();
        if (invite?.invite_link && !invite.invite_sent) {
          prompt('Organization created, but the owner’s invite email could not be sent.\nCopy this set-password link and share it with them:', invite.invite_link);
        } else {
          toast(invite ? 'Organization created — owner invited by email' : 'Organization created');
        }
        await loadMe(); // the topbar org switcher may now have a new entry
        renderTopbar();
        renderOrgsAdmin();
      } catch (err) { showFormError(f, err.message); }
    });
  });

  view.onclick = async (e) => {
    const btn = e.target.closest('button[data-app-toggle]');
    if (!btn) return;
    const enabled = btn.dataset.status === 'enabled';
    if (enabled && !confirm(`Disable the Language application for "${btn.dataset.name}"?\nIts members lose access to the Language app until it is re-enabled; no data is touched.`)) return;
    try {
      await api(`/orgs/${btn.dataset.appToggle}/apps/language`, {
        method: 'PUT',
        body: { status: enabled ? 'disabled' : 'enabled' },
      });
      toast(enabled ? 'Language disabled for the organization' : 'Language enabled for the organization');
      renderOrgsAdmin();
    } catch (err) { toast(err.message, true); }
  };
}

// ---------------------------------------------------------------------------
// Users view (superadmin)
// ---------------------------------------------------------------------------

async function renderUsers() {
  view.innerHTML = `<div class="empty">Loading…</div>`;
  let data;
  try { data = await api('/users'); }
  catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }

  view.innerHTML = `
    <div class="page-head">
      <h1>Users</h1>
      <button id="new-user-btn">＋ New account</button>
    </div>
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Projects</th><th>Entries</th><th>Recordings</th><th>Created</th><th></th></tr></thead>
        <tbody>
          ${data.users.map((u) => `
            <tr>
              <td>${esc(u.name)} ${u.is_superadmin ? '<span class="badge">Superadmin</span>' : ''}</td>
              <td>${esc(u.email)}</td>
              <td>${esc(u.memberships ?? '—')}</td>
              <td>${u.entry_count}</td>
              <td>${u.audio_count}</td>
              <td>${fmtDate(u.created_at)}</td>
              <td style="white-space:nowrap">
                <button class="ghost small" data-act="reset" data-id="${u.id}" data-name="${esc(u.name)}">Reset password</button>
                ${u.id === state.me.user.id ? '' : `
                  <button class="ghost small" data-act="super" data-id="${u.id}" data-super="${u.is_superadmin}">
                    ${u.is_superadmin ? 'Revoke superadmin' : 'Make superadmin'}</button>
                  <button class="danger small" data-act="delete" data-id="${u.id}" data-name="${esc(u.name)}">Delete</button>`}
              </td>
            </tr>`).join('')}
        </tbody>
      </table></div>
      <p style="color:var(--muted);font-size:0.85rem;margin-bottom:0">
        Accounts with contributions can't be deleted (attribution is preserved) — remove them
        from their organization instead, which revokes all access. Membership is managed
        on the <a href="#/org">Organization</a> page: one list, and a role applies to every
        project the organization runs.</p>
    </div>`;

  $('#new-user-btn').addEventListener('click', () => {
    const m = openModal(`
      <h2>New account</h2>
      <p style="color:var(--muted);font-size:0.9rem">The account starts with no project access —
        add it to a project from the Dashboard → Members.</p>
      <form id="user-form">
        <label class="field"><span>Name</span><input type="text" name="name" required></label>
        <label class="field"><span>Email</span><input type="email" name="email" required></label>
        <label class="field"><span>Temporary password (optional)</span>
          <input type="text" name="password" minlength="8" autocomplete="off"
            placeholder="blank = email an invite link"></label>
        <p class="error-msg" hidden></p>
        <div class="form-actions">
          <button type="submit">Create account</button>
          <button type="button" class="ghost" onclick="document.querySelector('.modal-backdrop').remove()">Cancel</button>
        </div>
      </form>`);
    $('#user-form', m).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        const r = await api('/users', {
          method: 'POST',
          body: { name: f.name.value, email: f.email.value, password: f.password.value || undefined },
        });
        closeModal();
        if (r.invite_link && !r.invite_sent) {
          prompt('Account created, but the invite email could not be sent.\nCopy this set-password link and share it with them:', r.invite_link);
        } else {
          toast(r.invite_sent ? 'Account created — invite email sent' : 'Account created');
        }
        renderUsers();
      } catch (err) { showFormError(f, err.message); }
    });
  });

  view.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;

    if (btn.dataset.act === 'reset') {
      const pw = prompt(`New temporary password for ${btn.dataset.name} (min 8 characters):`);
      if (pw === null) return;
      try {
        await api(`/users/${id}`, { method: 'PATCH', body: { password: pw } });
        toast('Password reset — they are signed out everywhere');
      } catch (err) { toast(err.message, true); }
    } else if (btn.dataset.act === 'super') {
      const makeSuper = btn.dataset.super !== '1';
      if (!confirm(makeSuper
        ? 'Grant superadmin? They will have full access to every project and all user management.'
        : 'Revoke superadmin access for this user?')) return;
      try {
        await api(`/users/${id}`, { method: 'PATCH', body: { is_superadmin: makeSuper } });
        toast(makeSuper ? 'Superadmin granted' : 'Superadmin revoked');
        renderUsers();
      } catch (err) { toast(err.message, true); }
    } else if (btn.dataset.act === 'delete') {
      if (!confirm(`Delete the account for ${btn.dataset.name}? This cannot be undone.`)) return;
      try {
        await api(`/users/${id}`, { method: 'DELETE' });
        toast('Account deleted');
        renderUsers();
      } catch (err) { toast(err.message, true); }
    }
  };
}

// ---------------------------------------------------------------------------
// Organization view (#5) — owner_admins manage who holds organization authority
// over the corpus. Platform superadmins have no implicit presence here.
// ---------------------------------------------------------------------------

// Manage → People (nav spec §13): the active organization's one list.
async function renderOrganization() {
  const org = activeOrg();
  if (!org || !isActiveOrgAdmin()) { location.hash = '#/home'; return; }
  view.innerHTML = `<div class="empty">Loading…</div>`;
  let members;
  try { members = (await api(`/orgs/${org.id}/members`)).members; }
  catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }

  const roleLabel = { owner_admin: 'Owner', admin: 'Admin', member: 'Member', translator: 'Translator' };
  view.innerHTML = `
    <div class="page-head"><h1>People</h1></div>
    <p style="color:var(--muted);max-width:60ch">One list, four roles — a person's role
      applies to everything <b>${esc(org.name)}</b> runs. <b>Owners</b> and <b>admins</b>
      manage people, projects, consent, compensation, and exports; <b>members</b> build the
      collection; <b>translators</b> work paid recording/translation sessions.</p>
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead>
        <tbody>
          ${members.map((mb) => `
            <tr>
              <td>${esc(mb.name)}</td>
              <td>${esc(mb.email)}</td>
              <td>${roleLabel[mb.role] ?? mb.role}</td>
              <td>${mb.id === state.me.user.id ? '' :
                `<button class="danger small" data-org-remove="${org.id}" data-user="${mb.id}">Remove</button>`}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>
      <form class="org-add" data-org="${org.id}" style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.8rem">
        <input type="email" name="email" required placeholder="email" style="flex:1;min-width:200px" aria-label="Email">
        <input type="text" name="name" placeholder="name (new accounts get an invite email)" style="flex:1;min-width:220px" aria-label="Name">
        <select name="role" aria-label="Role">
          <option value="member">Member</option>
          <option value="translator">Translator</option>
          ${org.role === 'owner_admin' ? `
          <option value="admin">Admin</option>
          <option value="owner_admin">Owner</option>` : ''}
        </select>
        <button type="submit">Add / set role</button>
      </form>
    </div>`;

  view.onclick = async (e) => {
    const rm = e.target.closest('button[data-org-remove]');
    if (!rm) return;
    if (!confirm('Remove this person from the organization? Their access to all of its projects ends immediately; past contributions keep their attribution.')) return;
    try {
      await api(`/orgs/${rm.dataset.orgRemove}/members/${rm.dataset.user}`, { method: 'DELETE' });
      toast('Removed from organization');
      renderOrganization();
    } catch (err) { toast(err.message, true); }
  };
  $('form.org-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api(`/orgs/${f.dataset.org}/members`, {
        method: 'POST',
        body: { email: f.email.value.trim(), name: f.name.value.trim() || undefined, role: f.role.value },
      });
      if (r.invite_link && !r.invite_sent) {
        prompt('Added, but the invite email could not be sent.\nCopy this set-password link and share it with them:', r.invite_link);
      } else {
        toast(r.invite_sent ? 'Added — invite email sent' : 'Organization role saved');
      }
      renderOrganization();
    } catch (err) { toast(err.message, true); }
  });
}

// Manage → Consent (nav spec §13): consent-profile administration for the
// active organization; per-project defaults stay on the Projects page.
async function renderConsent() {
  const org = activeOrg();
  if (!org || !isActiveOrgAdmin()) { location.hash = '#/home'; return; }
  view.innerHTML = `<div class="empty">Loading…</div>`;
  let profiles;
  try { profiles = (await api(`/orgs/${org.id}/consent-profiles`)).profiles; }
  catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }

  const FLAG_LABELS = {
    allow_language_learning: 'Learning', allow_asr_training: 'ASR', allow_tts_training: 'TTS',
    allow_translation_model_training: 'Translation AI', allow_research: 'Research',
    allow_commercial_use: 'Commercial', allow_redistribution: 'Redistribution',
  };
  view.innerHTML = `
    <div class="page-head"><h1>Consent</h1></div>
    <p style="color:var(--muted);max-width:60ch">Reusable bundles of permitted uses for
      <b>${esc(org.name)}</b>. Recordings keep a snapshot of the profile at assignment
      time — editing or deleting a profile never changes past consent. Set each project's
      default profile from <a href="#/projects">Projects</a> → Consent.</p>
    <div class="card">
      ${profiles.map((p) => `
        <div class="version-row">
          <span><b>${esc(p.name)}</b> — ${Object.entries(FLAG_LABELS).filter(([f]) => p[f]).map(([, l]) => l).join(', ') || 'no uses permitted'}</span>
          <button class="danger small" data-profile-delete="${p.id}">Delete</button>
        </div>`).join('') || '<p style="color:var(--muted);font-size:0.9rem">No profiles yet.</p>'}
      <form class="profile-add" data-org="${org.id}" style="margin-top:0.8rem">
        <input type="text" name="name" required placeholder="profile name, e.g. Education + ASR" style="min-width:240px" aria-label="Profile name">
        <div style="display:flex;gap:0.8rem;flex-wrap:wrap;margin:0.5rem 0">
          ${Object.entries(FLAG_LABELS).map(([f, l]) =>
            `<label style="font-size:0.85rem"><input type="checkbox" name="${f}"> ${l}</label>`).join('')}
        </div>
        <button type="submit">Create profile</button>
      </form>
    </div>`;

  view.onclick = async (e) => {
    const pd = e.target.closest('button[data-profile-delete]');
    if (!pd) return;
    if (!confirm('Delete this consent profile? Recordings keep their snapshots; projects using it as a default fall back to consent-unknown.')) return;
    try {
      await api(`/consent-profiles/${pd.dataset.profileDelete}`, { method: 'DELETE' });
      toast('Profile deleted');
      renderConsent();
    } catch (err) { toast(err.message, true); }
  };
  $('form.profile-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { name: f.name.value.trim() };
    for (const cb of f.querySelectorAll('input[type=checkbox]')) body[cb.name] = cb.checked;
    try {
      await api(`/orgs/${f.dataset.org}/consent-profiles`, { method: 'POST', body });
      toast('Consent profile created');
      renderConsent();
    } catch (err) { toast(err.message, true); }
  });
}

// ---------------------------------------------------------------------------
// Router & boot
// ---------------------------------------------------------------------------

async function loadMe() {
  state.me = await api('/me');
  if (!state.me.orgs.some((o) => o.id === state.activeOrgId)) {
    state.activeOrgId = state.me.orgs[0]?.id ?? null;
  }
  // Collections (corpora) are the Library's content context (nav spec §7).
  try { state.corpora = (await api('/corpora')).corpora; }
  catch { state.corpora = []; }
  if (!orgCorpora().some((c) => c.id === state.activeCorpusId)) {
    state.activeCorpusId = orgCorpora()[0]?.id ?? null;
  }
  if (!orgProjects().some((p) => p.id === state.activeProjectId)) {
    state.activeProjectId = corpusProjects()[0]?.id ?? orgProjects()[0]?.id ?? null;
  }
  renderShell();
}

/** Refresh corpora counts (after entry/recording changes) without a full reload. */
async function refreshCorpora() {
  try {
    state.corpora = (await api('/corpora')).corpora;
  } catch { /* keep stale counts */ }
}

function route() {
  view.onclick = null; // clear any per-view delegated handler
  stopDocPolling(); // navigating away ends document status polling
  if (Recorder.session) Recorder.cancel(); // navigating away releases the mic
  releaseClaims(recSession); // return any unfinished claimed work to the queue
  releaseClaims(transSession);
  endRecSession(); // leaving the flow closes the recording session
  let hash = location.hash || '#/home';
  let m;
  // Views that work without a session:
  if ((m = hash.match(/^#\/set-password\/([a-f0-9]{64})$/))) { renderSetPassword(m[1]); return; }
  if (hash === '#/forgot') { renderForgot(); return; }
  if (hash === '#/request') { renderRequestStart(); return; }
  if ((m = hash.match(/^#\/request\/([a-f0-9]{64})$/))) { renderRequestForm(m[1]); return; }
  if (!state.me) { renderLogin(); return; }

  // Legacy deep links (nav spec §65): keep old bookmarks working.
  if (hash === '#/dashboard') { location.hash = '#/home'; return; }
  if (hash === '#/org') { location.hash = isTranslator() ? '#/home' : '#/people'; return; }
  if (hash === '#/phrases') { listState.kind = 'phrase'; location.hash = '#/entries'; return; }
  if (hash === '#/phrases/new') { location.hash = '#/entries/new?kind=phrase'; return; }

  setActiveNav(hash);
  if (isTranslator()) {
    // Translators keep the focused experience: work sessions, entries
    // browsing (read-only; server-enforced), and their earnings.
    if (hash === '#/home') renderTranslatorDashboard();
    else if (hash === '#/record') renderRecordSession();
    else if (hash === '#/translate') renderTranslateSession();
    else if (hash === '#/earnings') renderMyEarnings();
    else if (hash === '#/entries') renderEntries(listState.kind ?? '');
    else if ((m = hash.match(/^#\/entries\/(\d+)$/))) renderEntryDetail(m[1]);
    else location.hash = '#/home';
    return;
  }
  if (hash === '#/home') renderHome();
  else if (hash === '#/entries') renderEntries(listState.kind ?? '');
  else if ((m = hash.match(/^#\/entries\/new(\?kind=(word|phrase))?$/))) renderNewEntry(m[2] || 'word');
  else if ((m = hash.match(/^#\/entries\/(\d+)$/))) renderEntryDetail(m[1]);
  else if (hash === '#/recordings') renderRecordingsLibrary();
  else if (hash === '#/speakers') renderSpeakersLibrary();
  else if (hash === '#/documents') renderDocumentsLibrary();
  else if ((m = hash.match(/^#\/documents\/(\d+)$/))) renderDocumentDetail(m[1]);
  else if (hash === '#/record') renderRecordSession();
  else if (hash === '#/translate') renderTranslateSession();
  else if (hash === '#/earnings') renderMyEarnings();
  else if (hash === '#/projects' && isActiveOrgAdmin()) renderProjects();
  else if (hash === '#/users' && state.me.user.is_superadmin) renderUsers();
  else if (hash === '#/orgs' && state.me.user.is_superadmin) renderOrgsAdmin();
  else if (hash === '#/jobs' && state.me.user.is_superadmin) renderJobs();
  else if ((m = hash.match(/^#\/jobs\/(\d+)$/)) && state.me.user.is_superadmin) renderJobDetail(m[1]);
  else if (hash === '#/compensation' && isOrgAdmin()) renderCompensation();
  else if ((m = hash.match(/^#\/compensation\/(\d+)$/)) && isOrgAdmin()) renderCompensationDetail(m[1]);
  else if (hash === '#/people' && isOrgAdmin()) renderOrganization();
  else if (hash === '#/consent' && isOrgAdmin()) renderConsent();
  else { location.hash = '#/home'; }
}

window.addEventListener('hashchange', route);

(async function boot() {
  // Public views (set-password, forgot, request) must render even with no session.
  const publicView = /^#\/(set-password\/|forgot$|request)/.test(location.hash);
  try {
    await loadMe();
    route();
  } catch {
    if (publicView) route();
    // otherwise: not signed in — renderLogin already shown by api()
  }
})();
