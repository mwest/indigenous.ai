import express from 'express';
import crypto from 'node:crypto';

import db from './db.js';
import { APP_URL, inviteEmail, resetEmail, sendMail, verifyEmailChangeEmail } from './mail.js';
import {
  COOKIE_NAME,
  cookieOptions,
  createSession,
  destroySession,
  hashPassword,
  requireAuth,
  requireSuperadmin,
  verifyPassword,
} from './auth.js';

const api = express.Router();
api.use(express.json());

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

api.post('/login', (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return bad(res, 'Email and password are required');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    return bad(res, 'Invalid email or password', 401);
  }
  if (user.deactivated_at) return bad(res, 'This account has been deactivated', 403);
  const token = createSession(user.id);
  res.cookie(COOKIE_NAME, token, cookieOptions());
  res.json({ ok: true });
});

api.post('/logout', (req, res) => {
  if (req.cookies[COOKIE_NAME]) destroySession(req.cookies[COOKIE_NAME]);
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Password tokens (invites + resets) — public endpoints, token-authenticated
// ---------------------------------------------------------------------------

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

/** Create a single-use token for a user; replaces any prior one of the same purpose. */
function createPasswordToken(userId, purpose, hours) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM password_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose);
  db.prepare(
    `INSERT INTO password_tokens (token_hash, user_id, purpose, expires_at)
     VALUES (?, ?, ?, datetime('now', '+${Number(hours)} hours'))`
  ).run(hashToken(token), userId, purpose);
  return token;
}

function lookupPasswordToken(token) {
  db.prepare(`DELETE FROM password_tokens WHERE expires_at < datetime('now')`).run();
  return db
    .prepare(
      `SELECT t.*, u.name, u.email FROM password_tokens t
       JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`
    )
    .get(hashToken(token));
}

const setPasswordLink = (token) => `${APP_URL}/#/set-password/${token}`;

// Invitations never expire, so the invite token is given a far-future lifetime
// (the reset flow still uses a short window). This keeps the single expiry
// mechanism while satisfying "no time limit to accept".
const INVITE_TTL_HOURS = 100 * 365 * 24;

/** Generate an invite token + send the email. Returns {invite_sent, invite_link}. */
async function sendInvite(user, invitedBy) {
  const link = setPasswordLink(createPasswordToken(user.id, 'invite', INVITE_TTL_HOURS));
  const { sent } = await sendMail({ to: user.email, ...inviteEmail({ email: user.email, link, invitedBy }) });
  // The link is returned so the inviter can copy it when mail is not configured.
  return { invite_sent: sent, invite_link: sent ? null : link };
}

// Request a reset link. Always answers ok so addresses can't be probed.
api.post('/password/forgot', async (req, res) => {
  const email = String(req.body?.email ?? '').trim();
  if (!email) return bad(res, 'Email is required');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const out = { ok: true };
  if (user) {
    const link = setPasswordLink(createPasswordToken(user.id, 'reset', 2));
    const { sent } = await sendMail({ to: user.email, ...resetEmail({ name: user.name, link }) });
    // Dev/test convenience: expose the link when mail isn't actually sent.
    if (!sent && process.env.NODE_ENV !== 'production') out.reset_link = link;
  }
  res.json(out);
});

// Token preview so the set-password page can greet the user and pick its mode.
api.get('/password/token/:token', (req, res) => {
  const t = lookupPasswordToken(req.params.token);
  if (!t) return bad(res, 'This link is invalid or has expired', 404);
  res.json({ valid: true, name: t.name, email: t.email, purpose: t.purpose });
});

// Set a new password using a valid token (single use, signs out everywhere).
// On an invite, the member also supplies their display name.
api.post('/password/reset', (req, res) => {
  const { token, password, name } = req.body ?? {};
  const t = token && lookupPasswordToken(token);
  if (!t) return bad(res, 'This link is invalid or has expired', 404);
  if (!password || String(password).length < 8) {
    return bad(res, 'Password must be at least 8 characters');
  }
  if (t.purpose === 'invite' && (!name || !String(name).trim())) {
    return bad(res, 'Please enter your name');
  }
  if (t.purpose === 'invite') {
    db.prepare('UPDATE users SET name = ?, password_hash = ? WHERE id = ?').run(
      String(name).trim(), hashPassword(password), t.user_id
    );
  } else {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), t.user_id);
  }
  db.prepare('DELETE FROM password_tokens WHERE user_id = ?').run(t.user_id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(t.user_id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Email change verification — confirm the new address before it takes effect
// ---------------------------------------------------------------------------

const EMAIL_CHANGE_TTL_HOURS = 2;
const verifyEmailLink = (token) => `${APP_URL}/#/verify-email/${token}`;
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function lookupEmailChangeToken(token) {
  db.prepare(`DELETE FROM email_change_tokens WHERE expires_at < datetime('now')`).run();
  return db
    .prepare(
      `SELECT t.*, u.name, u.email AS current_email FROM email_change_tokens t
       JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`
    )
    .get(hashToken(token));
}

// Preview so the verify page can show which address is being confirmed.
api.get('/email/token/:token', (req, res) => {
  const t = lookupEmailChangeToken(req.params.token);
  if (!t) return bad(res, 'This link is invalid or has expired', 404);
  res.json({ valid: true, new_email: t.new_email, current_email: t.current_email });
});

// Apply a pending email change (single use). Token-authenticated: opening the
// link proves the user controls the new address.
api.post('/email/verify', (req, res) => {
  const t = req.body?.token && lookupEmailChangeToken(req.body.token);
  if (!t) return bad(res, 'This link is invalid or has expired', 404);
  // The address may have been claimed by someone else since the request.
  if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(t.new_email, t.user_id)) {
    db.prepare('DELETE FROM email_change_tokens WHERE token_hash = ?').run(t.token_hash);
    return bad(res, 'That email address is no longer available');
  }
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(t.new_email, t.user_id);
  db.prepare('DELETE FROM email_change_tokens WHERE user_id = ?').run(t.user_id);
  res.json({ ok: true, email: t.new_email });
});

api.use(requireAuth); // everything below requires a session

api.get('/me', (req, res) => {
  res.json({ user: req.user });
});

api.post('/me/password', (req, res) => {
  const { current_password, new_password } = req.body ?? {};
  if (!current_password || !new_password) return bad(res, 'Both passwords are required');
  if (String(new_password).length < 8) return bad(res, 'New password must be at least 8 characters');
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(current_password, row.password_hash)) {
    return bad(res, 'Current password is incorrect', 403);
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
    hashPassword(new_password),
    req.user.id
  );
  res.json({ ok: true });
});

api.post('/me/name', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return bad(res, 'Name cannot be empty');
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  res.json({ ok: true, name });
});

// Request an email change: emails a confirmation link to the NEW address. The
// change only takes effect once that link is opened (security + typo guard).
api.post('/me/email', async (req, res) => {
  const newEmail = String(req.body?.new_email ?? '').trim();
  if (!emailRe.test(newEmail)) return bad(res, 'A valid email is required');
  const me = db.prepare('SELECT email, name FROM users WHERE id = ?').get(req.user.id);
  if (newEmail.toLowerCase() === me.email.toLowerCase()) {
    return bad(res, 'That is already your email address');
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(newEmail, req.user.id)) {
    return bad(res, 'That email address is already in use');
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM email_change_tokens WHERE user_id = ?').run(req.user.id);
  db.prepare(
    `INSERT INTO email_change_tokens (token_hash, user_id, new_email, expires_at)
     VALUES (?, ?, ?, datetime('now', '+${EMAIL_CHANGE_TTL_HOURS} hours'))`
  ).run(hashToken(token), req.user.id, newEmail);
  const link = verifyEmailLink(token);
  const { sent } = await sendMail({ to: newEmail, ...verifyEmailChangeEmail({ name: me.name, newEmail, link }) });
  const out = { ok: true, sent };
  // Dev/test convenience: expose the link when mail isn't actually sent.
  if (!sent && process.env.NODE_ENV !== 'production') out.verify_link = link;
  res.json(out);
});

// ---------------------------------------------------------------------------
// Members — every signed-in user can see the list and invite (quota-limited)
// ---------------------------------------------------------------------------

// Each regular member may invite this many people; the superadmin is unlimited.
// "Used" is counted live and excludes deactivated invitees, so deactivating one
// frees the inviter's slot back up.
const INVITE_LIMIT = 5;
const invitesUsed = (userId) =>
  db.prepare('SELECT COUNT(*) AS n FROM users WHERE inviter_id = ? AND deactivated_at IS NULL')
    .get(userId).n;

// Roles are not exposed. A user is in one of three states, derived here:
//   'invited'     — account created, password not yet set
//   'member'      — registered and active
//   'deactivated' — turned off by a superadmin (never deleted)
const memberSelect = `
  SELECT u.id, u.email, u.name, u.created_at,
         CASE
           WHEN u.deactivated_at IS NOT NULL THEN 'deactivated'
           WHEN u.password_hash IS NOT NULL THEN 'member'
           ELSE 'invited'
         END AS status
  FROM users u
`;

/** Display label for whoever invited a member, falling back to a given user. */
function inviterLabel(member, fallbackUser) {
  if (member.inviter_id) {
    const inv = db.prepare('SELECT name, email FROM users WHERE id = ?').get(member.inviter_id);
    if (inv) return inv.name || inv.email;
  }
  return fallbackUser.name || fallbackUser.email;
}

api.get('/members', (req, res) => {
  const isSuper = !!req.user.is_superadmin;
  // The superadmin sees everyone (with status) so they can manage accounts;
  // regular members see only active, registered members and no status.
  const members = isSuper
    ? db.prepare(`${memberSelect}
         ORDER BY (u.deactivated_at IS NOT NULL), u.name IS NULL, u.name, u.email`).all()
    : db.prepare(`SELECT id, name, email FROM users
         WHERE password_hash IS NOT NULL AND deactivated_at IS NULL
         ORDER BY name IS NULL, name, email`).all();
  const used = invitesUsed(req.user.id);
  res.json({
    members,
    invite_limit: isSuper ? null : INVITE_LIMIT,
    invites_used: used,
    invites_remaining: isSuper ? null : Math.max(0, INVITE_LIMIT - used),
  });
});

// Invite a member by email: creates a locked account and emails a register
// link. If mail isn't configured, the link comes back for the inviter to copy.
api.post('/members', async (req, res) => {
  const email = String(req.body?.email ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(res, 'A valid email is required');
  if (!req.user.is_superadmin && invitesUsed(req.user.id) >= INVITE_LIMIT) {
    return bad(res, 'You have used all your invitations', 403);
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return bad(res, 'An account with that email already exists');
  }
  // Locked account: password_hash stays NULL until the register link is used.
  const info = db.prepare('INSERT INTO users (email, inviter_id) VALUES (?, ?)').run(email, req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  const invite = await sendInvite(user, req.user.name || req.user.email);
  res.status(201).json({ ok: true, member_id: user.id, ...invite });
});

// Resend (regenerate) an invite link for a member who hasn't registered yet.
// Superadmin only; the email still names the original inviter.
api.post('/members/:id/invite', requireSuperadmin, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return bad(res, 'Member not found', 404);
  if (user.deactivated_at) return bad(res, 'That account is deactivated');
  if (user.password_hash) return bad(res, 'That member has already registered');
  const invite = await sendInvite(user, inviterLabel(user, req.user));
  res.json({ ok: true, ...invite });
});

// Deactivate an account: it can no longer log in and is signed out everywhere.
// Accounts are never deleted, so this is reversible via /reactivate.
api.post('/members/:id/deactivate', requireSuperadmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return bad(res, 'Member not found', 404);
  if (user.id === req.user.id) return bad(res, 'You cannot deactivate your own account');
  if (user.deactivated_at) return bad(res, 'That account is already deactivated');
  db.prepare(`UPDATE users SET deactivated_at = datetime('now') WHERE id = ?`).run(user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id); // sign out immediately
  res.json({ ok: true });
});

api.post('/members/:id/reactivate', requireSuperadmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return bad(res, 'Member not found', 404);
  if (!user.deactivated_at) return bad(res, 'That account is not deactivated');
  db.prepare('UPDATE users SET deactivated_at = NULL WHERE id = ?').run(user.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------

api.use((req, res) => bad(res, 'Not found', 404));

// JSON error handler so API errors never return HTML.
api.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  bad(res, 'Internal server error', 500);
});

export default api;
