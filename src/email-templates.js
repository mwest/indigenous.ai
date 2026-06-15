// Email copy — edit these freely. Each template is plain text; the matching
// HTML email is generated automatically by src/mail.js (minimal styling: plain
// paragraphs + one button), so you never have to touch HTML here.
//
// Placeholders use {{name}} syntax. Put {{link}} on its own line where the
// action button should go — in the plain-text email it becomes the URL, and in
// the HTML email it becomes a button (labelled by the template's `button`)
// with the URL shown beneath as a fallback.
//
// Available placeholders per template:
//   invite       {{invitedBy}}, {{email}}, {{link}}
//   reset        {{greeting}}, {{link}}
//   emailChange  {{greeting}}, {{newEmail}}, {{link}}
//
// Note: the brand is written "Indigenous AI" (not the bare domain) on purpose —
// mail apps auto-link anything that looks like "indigenous.ai", which is what
// made older emails look so link-heavy.

export default {
  invite: {
    subject: '{{invitedBy}} invited you to Indigenous AI',
    button: 'Set up your account',
    body: `Hi,

{{invitedBy}} invited you to join Indigenous AI. Set up your account — your email ({{email}}) is already filled in, so you just pick a name and password.

{{link}}

This invitation doesn't expire. If you weren't expecting it, you can ignore this email.`,
  },

  reset: {
    subject: 'Reset your Indigenous AI password',
    button: 'Reset your password',
    body: `{{greeting}}

Someone (hopefully you) asked to reset your password. Use the link below — it's valid for 2 hours.

{{link}}

If this wasn't you, you can ignore this email and nothing will change.`,
  },

  emailChange: {
    subject: 'Confirm your new Indigenous AI email address',
    button: 'Confirm new email',
    body: `{{greeting}}

A request was made to change your Indigenous AI email address to {{newEmail}}. Confirm it with the link below — it's valid for 2 hours, and your address won't change until you do.

{{link}}

If you didn't request this, you can ignore this email and nothing will change.`,
  },
};
