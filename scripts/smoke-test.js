// End-to-end smoke test against a running server.
// Usage: node scripts/smoke-test.js [baseUrl] [superadminEmail] [superadminPassword]
//
// Requires the superadmin to exist first:
//   npm run create-superadmin -- mike@indigenous.ai Mike change-me-now-2026
// Run the server with NODE_ENV unset (not 'production') so invite/reset links
// are returned in API responses for the test to follow.
const BASE = process.argv[2] || 'http://localhost:3000';
const SA_EMAIL = process.argv[3] || 'mike@indigenous.ai';
const SA_PASS = process.argv[4] || 'change-me-now-2026';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + detail}`);
  if (!cond) failures++;
}

function client() {
  let cookie = '';
  return {
    async req(method, path, body, isForm = false) {
      const res = await fetch(BASE + path, {
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
        redirect: 'manual',
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let data = null;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('json')) data = await res.json();
      else data = await res.text();
      return { status: res.status, data, headers: res.headers };
    },
  };
}

const tokenFromLink = (link) => String(link).split('/').pop();

const sa = client();
const member = client();
const stranger = client();

// --- auth ---
let r = await sa.req('GET', '/api/me');
check('unauthenticated /api/me is 401', r.status === 401);

r = await sa.req('POST', '/api/login', { email: SA_EMAIL, password: 'wrong-password' });
check('wrong password rejected', r.status === 401);

r = await sa.req('POST', '/api/login', { email: SA_EMAIL, password: SA_PASS });
check('superadmin login', r.status === 200, JSON.stringify(r.data));

r = await sa.req('GET', '/api/me');
check('superadmin /api/me is superadmin', r.status === 200 && r.data.user.is_superadmin === 1,
  JSON.stringify(r.data));

// --- superadmin-only guard (before member exists, use the stranger client) ---
r = await stranger.req('GET', '/api/members');
check('unauthenticated cannot list members', r.status === 401);

// --- invite a member by email ---
const memberEmail = `member${Date.now()}@example.com`;
r = await sa.req('POST', '/api/members', { email: 'not-an-email' });
check('invite rejects invalid email', r.status === 400);

r = await sa.req('POST', '/api/members', { email: memberEmail });
check('superadmin invites member (locked account + link)', r.status === 201 &&
  typeof r.data.invite_link === 'string', JSON.stringify(r.data));
const memberId = r.data.member_id;
let inviteToken = tokenFromLink(r.data.invite_link);

r = await sa.req('POST', '/api/members', { email: memberEmail });
check('duplicate invite rejected', r.status === 400);

// --- member appears as invited, cannot log in yet ---
r = await sa.req('GET', '/api/members');
let row = r.data.members.find((m) => m.id === memberId);
check('member listed with status "invited"', r.status === 200 && row && row.status === 'invited',
  JSON.stringify(row));

r = await member.req('POST', '/api/login', { email: memberEmail, password: 'change-me-now-2026' });
check('locked account cannot log in', r.status === 401);

// --- token preview + accept invite (set name + password) ---
r = await member.req('GET', `/api/password/token/${inviteToken}`);
check('invite token previews email + purpose', r.status === 200 &&
  r.data.purpose === 'invite' && r.data.email === memberEmail, JSON.stringify(r.data));

r = await member.req('POST', '/api/password/reset', { token: inviteToken, password: 'short' });
check('invite rejects short password', r.status === 400);

r = await member.req('POST', '/api/password/reset', { token: inviteToken, password: 'member-pass-123' });
check('invite requires a name', r.status === 400);

r = await member.req('POST', '/api/password/reset',
  { token: inviteToken, name: 'Test Member', password: 'member-pass-123' });
check('member sets name + password via invite', r.status === 200, JSON.stringify(r.data));

r = await member.req('POST', '/api/password/reset',
  { token: inviteToken, name: 'X', password: 'member-pass-123' });
check('invite token is single-use', r.status === 404);

// --- member can now log in ---
r = await member.req('POST', '/api/login', { email: memberEmail, password: 'member-pass-123' });
check('member login after accepting invite', r.status === 200);

r = await member.req('GET', '/api/me');
check('member /api/me shows name, not superadmin', r.status === 200 &&
  r.data.user.name === 'Test Member' && r.data.user.is_superadmin === 0, JSON.stringify(r.data));

r = await sa.req('GET', '/api/members');
row = r.data.members.find((m) => m.id === memberId);
check('member now has status "member"', row && row.status === 'member', JSON.stringify(row));

// --- members list is visible to everyone; invites are quota-limited ---
r = await member.req('GET', '/api/members');
check('member can list members', r.status === 200 && Array.isArray(r.data.members),
  JSON.stringify(r.data).slice(0, 120));
check('member has an invite quota of 5 (5 remaining)',
  r.data.invite_limit === 5 && r.data.invites_remaining === 5,
  JSON.stringify({ limit: r.data.invite_limit, rem: r.data.invites_remaining }));
check('superadmin is hidden from the members list',
  !r.data.members.some((m) => m.email.toLowerCase() === SA_EMAIL.toLowerCase()));
check('members list does not expose roles',
  r.data.members.every((m) => m.is_superadmin === undefined));
check('members list does not expose status to members',
  r.data.members.every((m) => m.status === undefined));

r = await sa.req('GET', '/api/members');
check('superadmin invites are unlimited (limit null)', r.status === 200 && r.data.invite_limit === null,
  JSON.stringify({ limit: r.data.invite_limit }));
check('superadmin account is hidden from its own management view too',
  !r.data.members.some((m) => m.email.toLowerCase() === SA_EMAIL.toLowerCase()));

const invited = [];
for (let i = 0; i < 5; i++) {
  r = await member.req('POST', '/api/members', { email: `invitee${i}-${Date.now()}@example.com` });
  if (r.status === 201) invited.push(r.data.member_id);
}
check('member can send exactly 5 invites', invited.length === 5);

r = await member.req('GET', '/api/members');
check('quota now shows 0 remaining', r.data.invites_remaining === 0, JSON.stringify(r.data.invites_remaining));
check('member list hides not-yet-registered invitees',
  !r.data.members.some((m) => String(m.email).startsWith('invitee')), JSON.stringify(r.data.members));

r = await sa.req('GET', '/api/members');
check('superadmin sees invited accounts (with status)', r.data.members.some((m) => m.status === 'invited'));

r = await member.req('POST', '/api/members', { email: `over-${Date.now()}@example.com` });
check('6th invite rejected with quota message',
  r.status === 403 && /all your invitations/i.test(r.data.error), JSON.stringify(r.data));

// invite-management actions stay superadmin-only
r = await member.req('POST', `/api/members/${invited[1]}/invite`);
check('member cannot resend invites', r.status === 403);
r = await member.req('POST', `/api/members/${invited[1]}/deactivate`);
check('member cannot deactivate accounts', r.status === 403);

// deactivating an invitee frees the slot back up
r = await sa.req('POST', `/api/members/${invited[0]}/deactivate`);
check('superadmin deactivates a member invited by someone else', r.status === 200, JSON.stringify(r.data));

r = await member.req('GET', '/api/members');
check('deactivating an invitee frees a slot (1 remaining)', r.data.invites_remaining === 1,
  JSON.stringify(r.data.invites_remaining));

r = await member.req('POST', '/api/members', { email: `refill-${Date.now()}@example.com` });
check('member can invite again after a slot frees', r.status === 201, JSON.stringify(r.data));

// --- change password ---
r = await member.req('POST', '/api/me/password',
  { current_password: 'wrong', new_password: 'newpass-123' });
check('change password needs correct current', r.status === 403);

r = await member.req('POST', '/api/me/password',
  { current_password: 'member-pass-123', new_password: 'newpass-123' });
check('member changes password', r.status === 200);

r = await member.req('POST', '/api/login', { email: memberEmail, password: 'newpass-123' });
check('login works with changed password', r.status === 200);

// --- forgot / reset password ---
r = await member.req('POST', '/api/password/forgot', { email: 'nobody@example.com' });
check('forgot for unknown email still returns ok (no probing)', r.status === 200 &&
  r.data.reset_link === undefined, JSON.stringify(r.data));

r = await member.req('POST', '/api/password/forgot', { email: memberEmail });
check('forgot issues reset link (dev exposes it)', r.status === 200 &&
  typeof r.data.reset_link === 'string', JSON.stringify(r.data));
const resetToken = tokenFromLink(r.data.reset_link);

r = await member.req('GET', `/api/password/token/${resetToken}`);
check('reset token previews purpose "reset"', r.status === 200 && r.data.purpose === 'reset',
  JSON.stringify(r.data));

r = await member.req('POST', '/api/password/reset', { token: resetToken, password: 'reset-pass-123' });
check('reset sets a new password', r.status === 200);

r = await member.req('POST', '/api/login', { email: memberEmail, password: 'reset-pass-123' });
check('login works with reset password', r.status === 200);

// --- edit profile: name + verified email change ---
const profEmail = `profile${Date.now()}@example.com`;
r = await sa.req('POST', '/api/members', { email: profEmail });
const prof = client();
await prof.req('POST', '/api/password/reset',
  { token: tokenFromLink(r.data.invite_link), name: 'Prof One', password: 'prof-pass-123' });
r = await prof.req('POST', '/api/login', { email: profEmail, password: 'prof-pass-123' });
check('profile user login', r.status === 200);

r = await prof.req('POST', '/api/me/name', { name: 'Prof Renamed' });
check('update name', r.status === 200, JSON.stringify(r.data));
r = await prof.req('GET', '/api/me');
check('name change reflected in /me', r.data.user.name === 'Prof Renamed', JSON.stringify(r.data.user));

r = await prof.req('POST', '/api/me/email', { new_email: 'not-an-email' });
check('email change rejects invalid address', r.status === 400);
r = await prof.req('POST', '/api/me/email', { new_email: SA_EMAIL });
check('email change rejects an address already in use', r.status === 400, JSON.stringify(r.data));

const newProfEmail = `profile-new${Date.now()}@example.com`;
r = await prof.req('POST', '/api/me/email', { new_email: newProfEmail });
check('email change request returns a verify link (dev)',
  r.status === 200 && typeof r.data.verify_link === 'string', JSON.stringify(r.data));
const emailToken = tokenFromLink(r.data.verify_link);

r = await prof.req('GET', '/api/me');
check('email unchanged until verification', r.data.user.email.toLowerCase() === profEmail,
  JSON.stringify(r.data.user.email));

let probe = client();
r = await probe.req('POST', '/api/login', { email: newProfEmail, password: 'prof-pass-123' });
check('new email cannot log in before verification', r.status === 401);

r = await prof.req('GET', `/api/email/token/${emailToken}`);
check('verify token previews the new email',
  r.status === 200 && r.data.new_email.toLowerCase() === newProfEmail, JSON.stringify(r.data));

const verifier = client(); // a fresh, logged-out browser, like clicking the link
r = await verifier.req('POST', '/api/email/verify', { token: emailToken });
check('email change verifies via token (public)',
  r.status === 200 && r.data.email.toLowerCase() === newProfEmail, JSON.stringify(r.data));

probe = client();
r = await probe.req('POST', '/api/login', { email: newProfEmail, password: 'prof-pass-123' });
check('new email logs in after verification', r.status === 200);
r = await probe.req('POST', '/api/login', { email: profEmail, password: 'prof-pass-123' });
check('old email no longer logs in', r.status === 401);

r = await verifier.req('POST', '/api/email/verify', { token: emailToken });
check('verify token is single-use', r.status === 404);

// --- opt-in public profile (username, picture, about, visibility) ---
r = await prof.req('POST', '/api/me/profile', { username: 'ab' });
check('username too short rejected', r.status === 400);
r = await prof.req('POST', '/api/me/profile', { username: 'bad name!' });
check('username with invalid chars rejected', r.status === 400);

const handle = `prof_${Date.now()}`;
r = await prof.req('POST', '/api/me/profile', { username: handle, about: 'Hi, I am Prof.' });
check('set username + about', r.status === 200 && r.data.username === handle, JSON.stringify(r.data));

r = await member.req('GET', `/api/profiles/${handle}`);
check('hidden profile is 404 to other members', r.status === 404);
r = await prof.req('GET', `/api/profiles/${handle}`);
check('owner can view their own hidden profile',
  r.status === 200 && r.data.is_self === true && r.data.visible === false, JSON.stringify(r.data));

r = await prof.req('POST', '/api/me/profile', { visible: true });
check('make profile visible', r.status === 200 && r.data.visible === true, JSON.stringify(r.data));
r = await member.req('GET', `/api/profiles/${handle}`);
check('visible profile readable by another member',
  r.status === 200 && r.data.username === handle && r.data.about === 'Hi, I am Prof.', JSON.stringify(r.data));

r = await member.req('POST', '/api/me/profile', { username: handle });
check('duplicate username rejected', r.status === 400, JSON.stringify(r.data));

const noNameEmail = `noname${Date.now()}@example.com`;
r = await sa.req('POST', '/api/members', { email: noNameEmail });
const noName = client();
await noName.req('POST', '/api/password/reset',
  { token: tokenFromLink(r.data.invite_link), name: 'No Name', password: 'noname-pass-1' });
await noName.req('POST', '/api/login', { email: noNameEmail, password: 'noname-pass-1' });
r = await noName.req('POST', '/api/me/profile', { visible: true });
check('cannot become visible without a username',
  r.status === 400 && /username/i.test(r.data.error), JSON.stringify(r.data));

// avatar upload + access control
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const fd = new FormData();
fd.append('avatar', new Blob([png], { type: 'image/png' }), 'a.png');
r = await prof.req('POST', '/api/me/avatar', fd, true);
check('avatar upload (PNG)', r.status === 200, JSON.stringify(r.data));
r = await prof.req('GET', '/api/me/avatar');
check('owner fetches own avatar', r.status === 200);
r = await member.req('GET', `/api/profiles/${handle}/avatar`);
check('member fetches a visible avatar', r.status === 200);
r = await prof.req('GET', `/api/profiles/${handle}`);
check('profile reports has_avatar', r.data.has_avatar === true, JSON.stringify(r.data));
const loggedOut = client();
r = await loggedOut.req('GET', `/api/profiles/${handle}/avatar`);
check('logged-out cannot fetch avatar', r.status === 401);

// opt out keeps the data but hides it from others
r = await prof.req('POST', '/api/me/profile', { visible: false });
check('opt out of visibility', r.status === 200 && r.data.visible === false, JSON.stringify(r.data));
r = await prof.req('GET', '/api/me');
check('opt-out keeps username + about + avatar', r.data.user.username === handle &&
  r.data.user.about === 'Hi, I am Prof.' && r.data.user.has_avatar === true, JSON.stringify(r.data.user));
r = await member.req('GET', `/api/profiles/${handle}`);
check('opted-out profile hidden from others again', r.status === 404);
r = await member.req('GET', `/api/profiles/${handle}/avatar`);
check('opted-out avatar hidden from others', r.status === 404);

// --- resend invite (new invited member) ---
const pendingEmail = `pending${Date.now()}@example.com`;
r = await sa.req('POST', '/api/members', { email: pendingEmail });
const pendingId = r.data.member_id;
const firstToken = tokenFromLink(r.data.invite_link);

r = await sa.req('POST', `/api/members/${pendingId}/invite`);
check('resend invite returns a fresh link', r.status === 200 && typeof r.data.invite_link === 'string',
  JSON.stringify(r.data));
const secondToken = tokenFromLink(r.data.invite_link);
check('resend invalidates the old invite token', firstToken !== secondToken);

r = await member.req('GET', `/api/password/token/${firstToken}`);
check('old invite token no longer works', r.status === 404);

r = await sa.req('POST', `/api/members/${memberId}/invite`);
check('cannot resend invite to a registered member', r.status === 400);

// --- deactivate / reactivate ---
r = await sa.req('POST', `/api/members/${memberId}/deactivate`);
check('superadmin deactivates a member', r.status === 200, JSON.stringify(r.data));

r = await member.req('GET', '/api/me');
check('deactivated member is signed out (session gone)', r.status === 401);

r = await member.req('POST', '/api/login', { email: memberEmail, password: 'reset-pass-123' });
check('deactivated member cannot log in', r.status === 403 && /deactivat/i.test(r.data.error || ''),
  JSON.stringify(r.data));

r = await sa.req('GET', '/api/members');
check('deactivated member shows as deactivated to superadmin',
  r.data.members.find((m) => m.id === memberId)?.status === 'deactivated');

r = await sa.req('POST', `/api/members/${memberId}/reactivate`);
check('superadmin reactivates the member', r.status === 200);

r = await member.req('POST', '/api/login', { email: memberEmail, password: 'reset-pass-123' });
check('reactivated member can log in again', r.status === 200);

// --- self-protection ---
// The superadmin no longer appears in the list, so get their id from /api/me.
const meInfo = await sa.req('GET', '/api/me');
r = await sa.req('POST', `/api/members/${meInfo.data.user.id}/deactivate`);
check('superadmin cannot deactivate their own account', r.status === 400, JSON.stringify(r.data));

// --- email templates (superadmin editor) ---
r = await member.req('GET', '/api/email-templates');
check('member cannot read email templates', r.status === 403);
r = await sa.req('GET', '/api/email-templates');
check('superadmin lists email templates', r.status === 200 && r.data.templates.length === 3,
  JSON.stringify(r.data?.templates?.length));
let invTmpl = r.data.templates.find((t) => t.key === 'invite');
check('invite template starts as default', invTmpl && invTmpl.is_custom === false,
  JSON.stringify(invTmpl?.is_custom));

r = await sa.req('POST', '/api/email-templates/invite/preview',
  { subject: 'Hi {{invitedBy}}', button: 'Go', body: 'Welcome aboard\n\n{{link}}' });
check('preview renders text + html', r.status === 200 &&
  /Welcome aboard/.test(r.data.text) && /<a /.test(r.data.html), JSON.stringify(r.data).slice(0, 100));

r = await sa.req('PUT', '/api/email-templates/invite', { subject: 'x', button: 'y', body: 'no link' });
check('template body without {{link}} rejected', r.status === 400, JSON.stringify(r.data));

r = await sa.req('PUT', '/api/email-templates/invite',
  { subject: 'Welcome to the club', button: 'Join', body: 'Hello\n\n{{link}}\n\nBye' });
check('superadmin saves a template override', r.status === 200);
r = await sa.req('GET', '/api/email-templates');
invTmpl = r.data.templates.find((t) => t.key === 'invite');
check('override shows as custom with the new subject',
  invTmpl.is_custom === true && invTmpl.subject === 'Welcome to the club', JSON.stringify(invTmpl));

r = await member.req('PUT', '/api/email-templates/invite', { subject: 'x', button: 'y', body: '{{link}}' });
check('member cannot edit templates', r.status === 403);

r = await sa.req('POST', '/api/email-templates/invite/test', { subject: 's', button: 'b', body: '{{link}}' });
check('test send returns gracefully when mail is off', r.status === 200 && r.data.sent === false,
  JSON.stringify(r.data));

r = await sa.req('DELETE', '/api/email-templates/invite');
check('reset template to default', r.status === 200);
r = await sa.req('GET', '/api/email-templates');
invTmpl = r.data.templates.find((t) => t.key === 'invite');
check('template is default again after reset', invTmpl.is_custom === false);

// --- logout ---
r = await sa.req('POST', '/api/logout');
check('logout', r.status === 200);
r = await sa.req('GET', '/api/me');
check('after logout /api/me is 401', r.status === 401);

// Tidy up test accounts (local dev only; never touches a remote database).
if (/localhost|127\.0\.0\.1/.test(BASE)) {
  try {
    const { default: Database } = await import('better-sqlite3');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const dbPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'indigenous.db');
    const tdb = new Database(dbPath);
    const n = tdb.prepare(`DELETE FROM users WHERE email LIKE '%@example.com'`).run().changes;
    tdb.close();
    console.log(`cleaned up ${n} test account(s)`);
  } catch (e) {
    console.log('cleanup skipped:', e.message);
  }
}

console.log(failures ? `\n${failures} FAILURES` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
