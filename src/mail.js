// Outbound email via Resend (https://resend.com) — plain fetch, no SDK needed.
// Degrades gracefully: if RESEND_API_KEY is not set, sendMail() reports
// {sent:false} and callers fall back to showing the action link to the admin.
//
// The email *copy* lives in ./email-templates.js (plain text, editable). This
// file just renders those templates to {subject, text, html} and sends them.

import templates from './email-templates.js';
import db from './db.js';

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

// ---- Template rendering ---------------------------------------------------
// Variable values are HTML-escaped in the HTML body (a member controls their
// own display name); the surrounding template prose is authored by us.

const escHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escAttr = (s) =>
  String(s ?? '').replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]));

const fillText = (str, vars) => str.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));

// Turn a plain-text body into minimal HTML: blank-line-separated paragraphs,
// and a {{link}} line becomes a button + a plain fallback URL.
function bodyToHtml(body, vars, button, link) {
  const blocks = body.split(/\n\s*\n/).map((block) => {
    if (block.trim() === '{{link}}') {
      return `<p style="margin:24px 0 8px">` +
        `<a href="${escAttr(link)}" style="display:inline-block;background:#1f2933;color:#fff;` +
        `padding:11px 20px;border-radius:6px;text-decoration:none">${escHtml(button)}</a></p>` +
        `<p style="margin:0;color:#777;font-size:13px">Or paste this link into your browser:<br>${escHtml(link)}</p>`;
    }
    const filled = block.replace(/\{\{(\w+)\}\}/g, (_, k) => escHtml(vars[k] ?? '')).replace(/\n/g, '<br>');
    return `<p style="margin:0 0 16px">${filled}</p>`;
  });
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;` +
    `line-height:1.55;color:#222;max-width:480px">\n${blocks.join('\n')}\n</div>`;
}

// Render an arbitrary template object {subject, button, body} with `vars`.
// Exported so the editor can preview/test unsaved copy.
export function renderTemplateObject(t, vars) {
  return {
    subject: fillText(t.subject, vars),
    text: fillText(t.body, vars),
    html: bodyToHtml(t.body, vars, t.button, vars.link),
  };
}

// Display label + the placeholders each template understands (for the editor).
export const TEMPLATE_META = {
  invite:      { label: 'Invitation',                placeholders: ['invitedBy', 'email', 'link'] },
  reset:       { label: 'Password reset',            placeholders: ['greeting', 'link'] },
  emailChange: { label: 'Email change confirmation', placeholders: ['greeting', 'newEmail', 'link'] },
};

// The built-in default copy for a template (from email-templates.js).
export const defaultTemplate = (key) => {
  const { subject, button, body } = templates[key];
  return { subject, button, body };
};

// Sample values for previews / test sends.
export function sampleVars(key) {
  const path = key === 'emailChange' ? 'verify-email' : 'set-password';
  const link = `${APP_URL}/#/${path}/SAMPLE-TOKEN-1234`;
  if (key === 'invite') return { invitedBy: 'Mike', email: 'new.member@example.com', link };
  if (key === 'reset') return { greeting: 'Hi Sam,', link };
  return { greeting: 'Hi Sam,', newEmail: 'new.address@example.com', link };
}

// Effective copy = superadmin override (DB) if present, else the file default.
function effectiveTemplate(key) {
  return db.prepare('SELECT subject, button, body FROM email_templates WHERE key = ?').get(key)
    || templates[key];
}

const render = (name, vars) => renderTemplateObject(effectiveTemplate(name), vars);

const greetingFor = (name) => (name ? `Hi ${name},` : 'Hi,');

export const inviteEmail = ({ email, link, invitedBy }) =>
  render('invite', { email, link, invitedBy });

export const resetEmail = ({ name, link }) =>
  render('reset', { greeting: greetingFor(name), link });

export const verifyEmailChangeEmail = ({ name, newEmail, link }) =>
  render('emailChange', { greeting: greetingFor(name), newEmail, link });
