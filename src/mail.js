// Outbound email via Resend (https://resend.com) — plain fetch, no SDK needed.
// Degrades gracefully: if RESEND_API_KEY is not set, sendMail() reports
// {sent:false} and callers fall back to showing the action link to the admin.

const FROM = process.env.MAIL_FROM || 'indigenous.ai <noreply@send.indigenous.ai>';
export const APP_URL = (process.env.APP_URL || 'https://indigenous.ai').replace(/\/$/, '');

export const mailEnabled = () => !!process.env.RESEND_API_KEY;

export async function sendMail({ to, subject, text, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn(`[mail] RESEND_API_KEY not set — not sending "${subject}" to ${to}`);
    return { sent: false, reason: 'mail not configured' };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to, subject, text, html }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error(`[mail] Resend ${r.status} sending "${subject}" to ${to}: ${detail}`);
      return { sent: false, reason: `Resend error ${r.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error(`[mail] network error sending to ${to}:`, err);
    return { sent: false, reason: 'network error' };
  }
}

const wrap = (body) => `
  <div style="font-family:sans-serif;max-width:480px;margin:0 auto;color:#222">
    <h2 style="color:#1f2933">indigenous.ai</h2>
    ${body}
    <p style="color:#888;font-size:12px;margin-top:24px">
      indigenous.ai — if you weren't expecting this email you can ignore it.</p>
  </div>`;

// User-provided values (names, emails) rendered into HTML email bodies must be
// escaped — a member controls their own display name.
const escHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function inviteEmail({ email, link, invitedBy }) {
  const intro = `${invitedBy} invited you to join indigenous.ai.`;
  return {
    subject: `${invitedBy} invited you to indigenous.ai`,
    text: `Hi,\n\n${intro}\n\nFollow this link to register — your email (${email}) is already filled in, so just choose a name and password:\n${link}\n\nThis invitation does not expire.\n`,
    html: wrap(`<p>Hi,</p><p>${escHtml(intro)}</p>
      <p>Follow the link below to register. Your email (<b>${escHtml(email)}</b>) is already filled in — just choose a name and password.</p>
      <p><a href="${link}" style="background:#1f2933;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Register your account</a></p>
      <p style="color:#666;font-size:13px">This invitation does not expire. Or paste this URL into your browser:<br>${link}</p>`),
  };
}

export function verifyEmailChangeEmail({ name, newEmail, link }) {
  const who = name ? `Hi ${name},` : 'Hi,';
  return {
    subject: 'Confirm your new indigenous.ai email address',
    text: `${who}\n\nA request was made to change your indigenous.ai email address to ${newEmail}.\n\nConfirm it here (link valid for 2 hours) — your address won't change until you do:\n${link}\n\nIf you didn't request this, you can ignore this email and nothing will change.\n`,
    html: wrap(`<p>${escHtml(who)}</p>
      <p>A request was made to change your indigenous.ai email address to <b>${escHtml(newEmail)}</b>.</p>
      <p><a href="${link}" style="background:#1f2933;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Confirm new email</a></p>
      <p style="color:#666;font-size:13px">This link is valid for 2 hours, and your address won't change until you open it. If you didn't request this, ignore this email.</p>`),
  };
}

export function resetEmail({ name, link }) {
  const who = name ? `Hi ${name},` : 'Hi,';
  return {
    subject: 'Reset your indigenous.ai password',
    text: `${who}\n\nSomeone (hopefully you) asked to reset your password.\n\nReset it here (link valid for 2 hours):\n${link}\n\nIf this wasn't you, you can ignore this email.\n`,
    html: wrap(`<p>${escHtml(who)}</p><p>Someone (hopefully you) asked to reset your password.</p>
      <p><a href="${link}" style="background:#1f2933;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Reset password</a></p>
      <p style="color:#666;font-size:13px">This link is valid for 2 hours. If this wasn't you, ignore this email.</p>`),
  };
}
