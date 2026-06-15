/* indigenous.ai — single-page app (no build step) */
'use strict';

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== '/login') {
    // Session expired or not signed in — but a 401 from the login attempt
    // itself must fall through so the form can show "Invalid email or password".
    state.me = null;
    location.hash = '#/login';
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status);
  return data;
}

// ---------------------------------------------------------------------------
// State & utilities
// ---------------------------------------------------------------------------

const state = {
  me: null, // { user }
};

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(sqlite) {
  if (!sqlite) return '';
  // SQLite datetime('now') is UTC
  const d = new Date(sqlite.replace(' ', 'T') + 'Z');
  return d.toLocaleString(undefined, { dateStyle: 'medium' });
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

// ---------------------------------------------------------------------------
// Top bar / chrome
// ---------------------------------------------------------------------------

function renderChrome() {
  const topbar = $('#topbar');
  if (!state.me) { topbar.hidden = true; return; }
  topbar.hidden = false;
  const { user } = state.me;
  $('#nav-members').hidden = false; // the members list is visible to everyone
  $('#user-menu-btn').textContent = user.email;
  // mark active nav link
  for (const a of topbar.querySelectorAll('nav a')) {
    a.classList.toggle('active', location.hash.startsWith('#/' + a.dataset.nav));
  }
}

$('#user-menu-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#user-menu-dropdown').hidden = !$('#user-menu-dropdown').hidden;
});
document.addEventListener('click', () => { $('#user-menu-dropdown').hidden = true; });
$('#edit-profile-btn').addEventListener('click', () => { location.hash = '#/profile'; });
$('#change-password-btn').addEventListener('click', () => { location.hash = '#/account'; });
$('#logout-btn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  state.me = null;
  location.hash = '#/login';
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function loadMe() {
  try {
    state.me = await api('/me');
  } catch {
    state.me = null;
  }
}

const PUBLIC_ROUTES = ['login', 'forgot', 'set-password', 'verify-email'];

async function router() {
  const hash = location.hash || '#/';
  const [, seg = '', arg = ''] = hash.split('/');

  // Make sure we know who we are (once) before deciding what to show.
  if (state.me === null && !PUBLIC_ROUTES.includes(seg)) {
    await loadMe();
  }

  // Public (signed-out) routes
  if (seg === 'login') return renderLogin();
  if (seg === 'forgot') return renderForgot();
  if (seg === 'set-password') return renderSetPassword(arg);
  if (seg === 'verify-email') return renderVerifyEmail(arg);

  // Everything else requires a session
  if (!state.me) { location.hash = '#/login'; return; }

  renderChrome();
  if (seg === 'members') return renderMembers();
  if (seg === 'account') return renderAccount();
  if (seg === 'profile') return renderProfile();

  // Home: the members list is the main page for everyone now.
  location.hash = '#/members';
}

window.addEventListener('hashchange', router);

// ---------------------------------------------------------------------------
// Auth screens (signed out)
// ---------------------------------------------------------------------------

function authShell(inner) {
  $('#topbar').hidden = true;
  view.innerHTML = `<div class="auth-wrap"><div class="card auth-card">
    <div class="brand">indigenous.ai</div>${inner}</div></div>`;
}

function renderLogin() {
  state.me = null;
  authShell(`
    <p class="subtitle">Sign in to your account</p>
    <form id="login-form">
      <label class="field"><span>Email</span>
        <input type="email" name="email" autocomplete="username" required autofocus></label>
      <label class="field"><span>Password</span>
        <input type="password" name="password" autocomplete="current-password" required></label>
      <p class="error-msg" id="login-error"></p>
      <button class="primary full" type="submit">Sign in</button>
    </form>
    <p class="btn-row" style="margin-top:1rem">
      <button class="link" id="forgot-link">Forgot your password?</button>
    </p>`);

  $('#forgot-link').addEventListener('click', () => { location.hash = '#/forgot'; });
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api('/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } });
      await loadMe();
      location.hash = '#/';
      router();
    } catch (err) {
      $('#login-error').textContent = err.message;
      btn.disabled = false;
    }
  });
}

function renderForgot() {
  authShell(`
    <p class="subtitle">Reset your password</p>
    <form id="forgot-form">
      <label class="field"><span>Email</span>
        <input type="email" name="email" autocomplete="username" required autofocus></label>
      <p class="error-msg" id="forgot-error"></p>
      <button class="primary full" type="submit">Send reset link</button>
    </form>
    <div id="forgot-done" hidden>
      <p>If an account exists for that email, a reset link is on its way.</p>
      <div id="forgot-devlink"></div>
    </div>
    <p class="btn-row" style="margin-top:1rem">
      <button class="link" id="back-login">Back to sign in</button>
    </p>`);

  $('#back-login').addEventListener('click', () => { location.hash = '#/login'; });
  $('#forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const out = await api('/password/forgot', { method: 'POST', body: { email: e.target.email.value } });
      $('#forgot-form').hidden = true;
      $('#forgot-done').hidden = false;
      if (out.reset_link) {
        // Mail isn't configured (dev) — surface the link to copy.
        $('#forgot-devlink').innerHTML = linkBox('Reset link', out.reset_link);
      }
    } catch (err) {
      $('#forgot-error').textContent = err.message;
      btn.disabled = false;
    }
  });
}

async function renderSetPassword(token) {
  authShell(`<p class="subtitle">Checking your link…</p>`);
  let info;
  try {
    info = await api('/password/token/' + encodeURIComponent(token));
  } catch (err) {
    authShell(`
      <p class="subtitle">Link problem</p>
      <p class="error-msg">${esc(err.message)}</p>
      <p class="btn-row" style="margin-top:1rem">
        <button class="link" id="back-login">Back to sign in</button></p>`);
    $('#back-login').addEventListener('click', () => { location.hash = '#/login'; });
    return;
  }

  const isInvite = info.purpose === 'invite';
  authShell(`
    <p class="subtitle">${isInvite ? 'Welcome — set up your account' : 'Choose a new password'}</p>
    <p class="muted" style="margin-top:-0.5rem;font-size:0.9rem">${esc(info.email)}</p>
    <form id="set-form" style="margin-top:1rem">
      ${isInvite ? `<label class="field"><span>Your name</span>
        <input type="text" name="name" autocomplete="name" required autofocus></label>` : ''}
      <label class="field"><span>${isInvite ? 'Password' : 'New password'}</span>
        <input type="password" name="password" autocomplete="new-password" required
          ${isInvite ? '' : 'autofocus'}></label>
      <p class="help">At least 8 characters.</p>
      <p class="error-msg" id="set-error"></p>
      <button class="primary full" type="submit">${isInvite ? 'Create account' : 'Set new password'}</button>
    </form>`);

  $('#set-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const body = { token, password: f.password.value };
      if (isInvite) body.name = f.name.value;
      await api('/password/reset', { method: 'POST', body });
      toast(isInvite ? 'Account created — please sign in' : 'Password updated — please sign in');
      location.hash = '#/login';
    } catch (err) {
      $('#set-error').textContent = err.message;
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Signed-in screens
// ---------------------------------------------------------------------------

function renderAccount() {
  view.innerHTML = `<div class="card auth-card" style="margin:0 auto">
    <h1>Change password</h1>
    <form id="pw-form" style="margin-top:1rem">
      <label class="field"><span>Current password</span>
        <input type="password" name="current" autocomplete="current-password" required autofocus></label>
      <label class="field"><span>New password</span>
        <input type="password" name="next" autocomplete="new-password" required></label>
      <p class="help">At least 8 characters.</p>
      <p class="error-msg" id="pw-error"></p>
      <div class="btn-row">
        <button class="primary" type="submit">Update password</button>
        <button class="ghost" type="button" id="pw-cancel">Cancel</button>
      </div>
    </form>
  </div>`;

  $('#pw-cancel').addEventListener('click', () => { location.hash = '#/'; });
  $('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api('/me/password', {
        method: 'POST',
        body: { current_password: f.current.value, new_password: f.next.value },
      });
      toast('Password updated');
      location.hash = '#/';
    } catch (err) {
      $('#pw-error').textContent = err.message;
      btn.disabled = false;
    }
  });
}

function linkBox(label, link) {
  return `<div class="linkbox">${esc(label)} (email isn't configured, so copy it):
    <code>${esc(link)}</code></div>`;
}

// ---------------------------------------------------------------------------
// Edit profile: update name, and change email (verified via emailed link)
// ---------------------------------------------------------------------------

function renderProfile() {
  const u = state.me.user;
  view.innerHTML = `
    <div class="page-head"><h1>Edit profile</h1></div>
    <div class="card auth-card" style="margin:0 0 1.25rem">
      <h2>Your name</h2>
      <form id="name-form">
        <label class="field"><span>Name</span>
          <input type="text" id="profile-name" value="${esc(u.name || '')}" autocomplete="name" required></label>
        <p class="error-msg" id="name-error"></p>
        <button class="primary" type="submit">Save name</button>
      </form>
    </div>
    <div class="card auth-card" style="margin:0">
      <h2>Your email</h2>
      <p class="muted" style="margin-top:-0.4rem">Current: <b>${esc(u.email)}</b></p>
      <form id="email-form">
        <label class="field"><span>New email address</span>
          <input type="email" id="profile-email" autocomplete="email" required></label>
        <p class="help">We'll send a confirmation link to the new address. Your email won't change until you open it.</p>
        <p class="error-msg" id="email-error"></p>
        <button class="primary" type="submit">Change email</button>
      </form>
      <div id="email-pending"></div>
    </div>`;

  $('#name-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    $('#name-error').textContent = '';
    try {
      const out = await api('/me/name', { method: 'POST', body: { name: $('#profile-name').value } });
      state.me.user.name = out.name;
      toast('Name updated');
    } catch (err) {
      $('#name-error').textContent = err.message;
    }
    btn.disabled = false;
  });

  $('#email-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const newEmail = $('#profile-email').value.trim();
    // Confirmation popup — also lets the user catch a typo before sending.
    if (!confirm(`Send a confirmation link to "${newEmail}"?\n\nYour sign-in email won't change until you open that link.`)) return;
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    $('#email-error').textContent = '';
    $('#email-pending').innerHTML = '';
    try {
      const out = await api('/me/email', { method: 'POST', body: { new_email: newEmail } });
      $('#profile-email').value = '';
      if (out.verify_link) {
        $('#email-pending').innerHTML = linkBox(`Confirmation link for ${newEmail}`, out.verify_link);
      } else {
        $('#email-pending').innerHTML = `<div class="linkbox">A confirmation link was sent to <b>${esc(newEmail)}</b>. Open it to finish the change — until then you keep signing in with <b>${esc(u.email)}</b>.</div>`;
      }
      toast('Confirmation email sent');
    } catch (err) {
      $('#email-error').textContent = err.message;
    }
    btn.disabled = false;
  });
}

async function renderVerifyEmail(token) {
  authShell(`<p class="subtitle">Confirming your email…</p>`);
  let result;
  try {
    const out = await api('/email/verify', { method: 'POST', body: { token } });
    result = `<p class="subtitle">Email confirmed</p>
      <p>Your email address is now <b>${esc(out.email)}</b>. You can use it to sign in.</p>`;
  } catch (err) {
    result = `<p class="subtitle">Couldn't confirm email</p>
      <p class="error-msg">${esc(err.message)}</p>`;
  }
  authShell(`${result}
    <button class="primary full" id="continue-btn" style="margin-top:0.75rem">Continue</button>`);
  $('#continue-btn').addEventListener('click', async () => {
    await loadMe(); // refresh, in case this is the signed-in user's own change
    location.hash = '#/';
    router();
  });
}

const STATUS_LABEL = { invited: 'Invited', member: 'Member', deactivated: 'Deactivated' };

function inviteFormHtml(hint) {
  return `
    <form id="invite-form" class="toolbar">
      <label class="field"><span>Email address</span>
        <input type="email" name="email" placeholder="person@example.com" required></label>
      <button class="primary" type="submit">Send invite</button>
    </form>
    <p class="help">${esc(hint)}</p>
    <p class="error-msg" id="invite-error"></p>
    <div id="invite-link"></div>`;
}

async function renderMembers() {
  view.innerHTML = `<div class="card"><p class="muted">Loading…</p></div>`;
  let data;
  try {
    data = await api('/members');
  } catch (err) {
    view.innerHTML = `<div class="card"><p class="error-msg">${esc(err.message)}</p></div>`;
    return;
  }
  const { members, invite_limit, invites_remaining } = data;
  const meId = state.me.user.id;
  const isSuper = !!state.me.user.is_superadmin;

  // For the superadmin, the available action conveys the account's state, so no
  // status column is shown: invited -> Resend, member -> Deactivate,
  // deactivated -> Reactivate (and the row is greyed).
  const rowActions = (m) => {
    if (m.id === meId) return '';
    if (m.status === 'invited') return `<button class="link" data-resend="${m.id}">Resend</button>`;
    if (m.status === 'deactivated') return `<button class="ghost" data-reactivate="${m.id}" data-email="${esc(m.email)}">Reactivate</button>`;
    return `<button class="danger" data-deactivate="${m.id}" data-email="${esc(m.email)}">Deactivate</button>`;
  };
  const rows = members.map((m) => `
    <tr${m.status === 'deactivated' ? ' class="muted-row"' : ''}>
      <td>${m.name ? esc(m.name) : '<span class="muted">—</span>'}${m.id === meId ? '<span class="badge you">you</span>' : ''}</td>
      <td>${esc(m.email)}</td>
      ${isSuper ? `<td><span class="badge ${m.status}">${STATUS_LABEL[m.status] ?? esc(m.status)}</span></td>
      <td><div class="row-actions">${rowActions(m)}</div></td>` : ''}
    </tr>`).join('');

  // Invite section below the list. Unlimited for the superadmin; otherwise the
  // form shows the remaining quota and is replaced once it is used up.
  let inviteSection;
  if (invite_limit === null) {
    inviteSection = inviteFormHtml('You can invite new members.');
  } else if (invites_remaining > 0) {
    const n = invites_remaining;
    inviteSection = inviteFormHtml(`You have ${n} invitation${n === 1 ? '' : 's'} left.`);
  } else {
    inviteSection = `<p class="muted">You have used all your invitations.</p>`;
  }

  view.innerHTML = `
    <div class="page-head">
      <h1>Members</h1>
      <p>Everyone who has joined indigenous.ai.</p>
    </div>
    <div class="card" style="margin-bottom:1.25rem">
      <table>
        <thead><tr><th>Name</th><th>Email</th>${isSuper ? '<th>Status</th><th></th>' : ''}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="card">
      <h2>Invite a member</h2>
      ${inviteSection}
    </div>`;

  const form = $('#invite-form');
  if (form) form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    $('#invite-error').textContent = '';
    try {
      const out = await api('/members', { method: 'POST', body: { email: e.target.email.value } });
      if (out.invite_sent) toast('Invitation sent');
      else toast('Member invited');
      await renderMembers();
      // Mail not configured (dev): surface the link to copy, if the box survives.
      if (out.invite_link) {
        const box = $('#invite-link');
        if (box) box.innerHTML = linkBox('Invite link', out.invite_link);
      }
    } catch (err) {
      $('#invite-error').textContent = err.message;
      btn.disabled = false;
    }
  });

  if (isSuper) {
    view.querySelectorAll('[data-resend]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const out = await api(`/members/${b.dataset.resend}/invite`, { method: 'POST' });
        if (out.invite_sent) toast('Invitation resent');
        else if (out.invite_link) {
          const box = $('#invite-link');
          if (box) box.innerHTML = linkBox('Invite link', out.invite_link);
          toast('New invite link generated');
        }
      } catch (err) { toast(err.message, true); }
    }));

    view.querySelectorAll('[data-deactivate]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`Deactivate ${b.dataset.email}? They'll be signed out and unable to log in until reactivated.`)) return;
      try {
        await api(`/members/${b.dataset.deactivate}/deactivate`, { method: 'POST' });
        toast('Account deactivated');
        renderMembers();
      } catch (err) { toast(err.message, true); }
    }));

    view.querySelectorAll('[data-reactivate]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await api(`/members/${b.dataset.reactivate}/reactivate`, { method: 'POST' });
        toast('Account reactivated');
        renderMembers();
      } catch (err) { toast(err.message, true); }
    }));
  }
}

// ---------------------------------------------------------------------------

router();
