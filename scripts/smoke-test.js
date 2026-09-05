// End-to-end smoke test against a running server.
// Usage: node scripts/smoke-test.js [baseUrl] [superadminEmail] [superadminPassword]
const BASE = process.argv[2] || 'http://localhost:3000';
const SA_EMAIL = process.argv[3] || 'mike@dene.ca';
const SA_PASS = process.argv[4] || 'dene-admin-2026';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + detail}`);
  if (!cond) failures++;
}

// Test paths are written as '/api/<route>'; the server splits routes across
// the Indigenous.ai platform API and the Language application API. Same rules
// as the SPA's helper (consent-profiles are Language despite the /orgs prefix).
const PLATFORM_API =
  /^\/(login$|logout$|password\/|me$|me\/(password|name)$|orgs$|orgs\/|users$|users\/|admin\/)/;
function apiPath(path) {
  if (!path.startsWith('/api/')) return path;
  const rest = path.slice(4);
  const prefix =
    !rest.includes('/consent-profiles') && PLATFORM_API.test(rest) ? '/api/platform' : '/api/language';
  return prefix + rest;
}

function client() {
  let cookie = '';
  return {
    async req(method, path, body, isForm = false) {
      const res = await fetch(BASE + apiPath(path), {
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
    // Binary GET — for the export ZIP, where text decoding would corrupt bytes/length.
    async raw(method, path) {
      const res = await fetch(BASE + apiPath(path), { method, headers: cookie ? { Cookie: cookie } : {} });
      return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
    },
  };
}

// Minimal valid PCM WAV: 1 second of silence at 8 kHz, 16-bit mono.
function makeWav(seconds = 1, rate = 8000) {
  const samples = seconds * rate;
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  return buf;
}

// Minimal valid MP3: MPEG-1 Layer III CBR frames (128 kbps / 44.1 kHz), ~1s.
function makeMp3(frames = 40) {
  const size = 417; // 144 * 128000 / 44100, no padding
  const buf = Buffer.alloc(size * frames);
  for (let i = 0; i < frames; i++) {
    const o = i * size;
    buf[o] = 0xff; buf[o + 1] = 0xfb; buf[o + 2] = 0x90; buf[o + 3] = 0x00;
  }
  return buf;
}


// Minimal DOCX (OOXML zip) fixture — heading + two paragraphs, with diacritics.
async function makeDocx() {
  const { createRequire } = await import('node:module');
  const archiver = createRequire(import.meta.url)('archiver');
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Traditional Foods</w:t></w:r></w:p>
<w:p><w:r><w:t>Dene people harvest łue from the lake.</w:t></w:r></w:p>
<w:p><w:r><w:t>Second paragraph with sǫǫ̀mbaà.</w:t></w:r></w:p>
</w:body></w:document>`;
  const chunks = [];
  const zip = archiver('zip');
  zip.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { zip.on('end', res); zip.on('error', rej); });
  zip.append(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`, { name: '[Content_Types].xml' });
  zip.append(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`, { name: '_rels/.rels' });
  zip.append(docXml, { name: 'word/document.xml' });
  zip.finalize();
  await done;
  return Buffer.concat(chunks);
}

// Minimal valid one-page text PDF with computed xref offsets.
function makePdfFixture(text) {
  const escd = text.replace(/([()\\\\])/g, '\\$1');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 12 Tf 72 720 Td (${escd}) Tj ET`;
  objs[3] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}

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

// Fresh-install bootstrap (documented flow): a brand-new deployment has no
// organization yet — provision one, making this superadmin its owner. No-op on
// an already-migrated database.
r = await sa.req('GET', '/api/me');
if ((r.data.orgs ?? []).length === 0) {
  r = await sa.req('POST', '/api/orgs', { name: 'Dene Voice Project' });
  check('fresh install: superadmin provisions the first organization', r.status === 201, JSON.stringify(r.data));
  r = await sa.req('GET', '/api/me');
}
// Snapshot the main org's roster: the flat model means people added during
// the run stay org members, so the end-of-suite cleanup removes exactly the
// members this run introduced.
const mainOrgId = r.data.orgs[0].id;
const preexistingMembers = new Set(
  ((await sa.req('GET', `/api/orgs/${mainOrgId}/members`)).data.members ?? []).map((mb) => mb.id)
);

// --- projects ---
const pname = `Smoke Test ${Date.now()}`;
r = await sa.req('POST', '/api/projects', { name: pname, dialect: 'Dëne Sųłıné' });
check('superadmin creates project', r.status === 201, JSON.stringify(r.data));
const projectId = r.data.id;

r = await sa.req('POST', '/api/projects', { name: pname });
check('duplicate project name rejected', r.status === 400);

// --- members ---
const memberEmail = `member${Date.now()}@test.ca`;
r = await sa.req('POST', `/api/projects/${projectId}/members`, {
  email: memberEmail, name: 'Test Member', password: 'member-pass-123',
});
check('admin creates member account', r.status === 201, JSON.stringify(r.data));
const memberId = r.data.user_id;

r = await member.req('POST', '/api/login', { email: memberEmail, password: 'member-pass-123' });
check('member login', r.status === 200);

r = await member.req('GET', '/api/projects');
// FLAT MODEL: an org member sees every project the organization runs.
check('member sees their org’s projects (flat model)', r.status === 200 &&
  r.data.projects.some((p) => p.id === projectId) &&
  r.data.projects.every((p) => p.organization_id === r.data.projects[0].organization_id),
  r.status);

r = await member.req('POST', '/api/projects', { name: 'Should fail' });
check('member cannot create projects', r.status === 403);

r = await member.req('GET', `/api/projects/${projectId}/members`);
check('member cannot list members (not admin)', r.status === 403);

r = await member.req('POST', `/api/projects/${projectId}/members`,
  { email: 'x@y.ca', name: 'X', password: 'password123', role: 'admin' });
check('member cannot add members', r.status === 403);

// stranger: a user in no projects
const strangerEmail = `stranger${Date.now()}@test.ca`;
// create a second project + user to test isolation
r = await sa.req('POST', '/api/projects', { name: pname + ' B' });
const projectB = r.data.id;
r = await sa.req('POST', `/api/projects/${projectB}/members`,
  { email: strangerEmail, name: 'Stranger', password: 'stranger-pass-1' });
const strangerId = r.data.user_id;
await stranger.req('POST', '/api/login', { email: strangerEmail, password: 'stranger-pass-1' });

// --- entries ---
r = await member.req('POST', '/api/entries', {
  project_id: projectId,
  dene_text: 'Sı̨ Mike sʔǫlye, ʔedlánet\'e?',
  english_text: 'My name is Mike, how are you?',
  source_doc: 'Phrase book p.1',
  notes: 'greeting',
});
check('member creates entry with Dene diacritics', r.status === 201, JSON.stringify(r.data));
const entryId = r.data?.id;
check('entry preserves Unicode text', r.data?.dene_text === 'Sı̨ Mike sʔǫlye, ʔedlánet\'e?');

// FLAT MODEL: the "stranger" holds a role in the same ORGANIZATION (via
// project B), so the whole org's corpora are theirs to read and build.
// True isolation is cross-organization — covered by the entitlement block.
r = await stranger.req('GET', `/api/entries/${entryId}`);
check('an org member can read any org project entry (flat model)', r.status === 200, r.status);

r = await stranger.req('POST', '/api/entries',
  { project_id: projectId, dene_text: 'x', english_text: 'y' });
check('an org member can contribute to any org project (flat model)', r.status === 201, r.status);
await stranger.req('DELETE', `/api/entries/${r.data.id}`); // keep downstream counts stable

r = await member.req('PATCH', `/api/entries/${entryId}`, { english_text: 'My name is Mike. How are you?' });
check('member edits own entry', r.status === 200 && r.data.english_text.includes('How are you?'));

r = await member.req('POST', '/api/entries',
  { project_id: projectId, dene_text: 'tu', english_text: 'water', category: 'nature' });
check('entry created with category', r.status === 201 && r.data.category === 'nature',
  JSON.stringify(r.data?.category));
const catEntryId = r.data?.id;

r = await member.req('PATCH', `/api/entries/${catEntryId}`, { category: 'environment' });
check('category editable', r.status === 200 && r.data.category === 'environment');

r = await member.req('GET', `/api/entries?q=environment`);
check('search matches category', r.status === 200 &&
  r.data.entries.some((e) => e.id === catEntryId), JSON.stringify(r.data.total));

r = await member.req('PATCH', `/api/entries/${entryId}`, { status: 'verified' });
check('member cannot change review status', r.status === 403);

r = await sa.req('PATCH', `/api/entries/${entryId}`, { status: 'verified' });
check('admin sets review status', r.status === 200 && r.data.status === 'verified');

// --- search ---
r = await member.req('GET', `/api/entries?q=${encodeURIComponent('sʔǫlye')}`);
check('search by Dene text', r.status === 200 && r.data.total >= 1, JSON.stringify(r.data));

r = await member.req('GET', '/api/entries?q=zzz-no-match-zzz');
check('search with no results', r.status === 200 && r.data.total === 0);

r = await stranger.req('GET', '/api/entries?q=Mike');
check('org-wide search reaches sibling projects (flat model)', r.status === 200 && r.data.total >= 1, JSON.stringify(r.data.total));

r = await member.req('GET', `/api/entries?project_id=${projectB}`);
check('org members may filter by any org project (flat model)', r.status === 200, r.status);

// --- audio ---
const wav = makeWav(2);
let fd = new FormData();
fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'greeting.wav');
fd.append('speaker', 'Elder Test');
fd.append('language', 'dene');
r = await member.req('POST', `/api/entries/${entryId}/audio`, fd, true);
check('audio upload (WAV)', r.status === 201, JSON.stringify(r.data));
const audioId = r.data?.id;
check('duration auto-captured (~2s)', Math.abs((r.data?.duration_seconds ?? 0) - 2) < 0.1,
  `got ${r.data?.duration_seconds}`);
check('language tagged', r.data?.language === 'dene', JSON.stringify(r.data));
check('master stored under audio/masters/<userID>/', r.data?.stored_name?.startsWith(`masters/${memberId}/`),
  `stored_name=${r.data?.stored_name}`);
check('recording marked lossless master', r.data?.archive_class === 'lossless_master', JSON.stringify(r.data?.archive_class));

fd = new FormData();
fd.append('file', new Blob([Buffer.from('this is not audio at all')], { type: 'audio/wav' }), 'corrupt.wav');
r = await member.req('POST', `/api/entries/${entryId}/audio`, fd, true);
check('corrupt audio rejected gracefully', r.status === 400 && /corrupt|read/i.test(r.data.error), JSON.stringify(r.data));

fd = new FormData();
fd.append('file', new Blob([wav]), 'notes.txt');
r = await member.req('POST', `/api/entries/${entryId}/audio`, fd, true);
check('unsupported extension rejected', r.status === 400);

r = await member.req('GET', `/api/entries/${entryId}`);
check('entry intact after failed uploads, 1 audio attached',
  r.status === 200 && r.data.audio.length === 1, JSON.stringify(r.data?.audio));

r = await member.req('GET', `/api/audio/${audioId}/stream`);
check('member streams audio', r.status === 200);

r = await stranger.req('GET', `/api/audio/${audioId}/stream`);
check('org members can stream any org recording (flat model)', r.status === 200, r.status);

// Re-record: a same-language upload creates a NEW version and supersedes the old
// one (the old master is preserved, not destroyed) — #8b.
fd = new FormData();
fd.append('file', new Blob([makeWav(3)], { type: 'audio/wav' }), 'greeting-v2.wav');
fd.append('language', 'dene');
r = await member.req('POST', `/api/entries/${entryId}/audio`, fd, true);
check('re-record creates a new version (supersedes, not replace)', r.status === 200 &&
  r.data.replaced === true && r.data.id !== audioId && r.data.supersedes_audio_id === audioId &&
  r.data.is_current === 1 && Math.abs(r.data.duration_seconds - 3) < 0.1, JSON.stringify(r.data));
const audioIdV2 = r.data.id;
r = await member.req('GET', `/api/audio/${audioIdV2}/history`);
check('old version preserved in history', r.status === 200 && r.data.versions.some((v) => v.id === audioId), JSON.stringify(r.data));
r = await member.req('GET', `/api/audio/${audioId}/master`);
check('superseded master still downloadable', r.status === 200);

fd = new FormData();
fd.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'english.wav');
fd.append('language', 'english');
r = await member.req('POST', `/api/entries/${entryId}/audio`, fd, true);
check('second language adds a slot', r.status === 201 && r.data.language === 'english');
const englishAudioId = r.data?.id;

r = await member.req('GET', `/api/entries/${entryId}`);
check('member has one dene + one english', r.status === 200 && r.data.audio.length === 2 &&
  new Set(r.data.audio.map((a) => a.language)).size === 2, JSON.stringify(r.data?.audio));

// every project member sees and can stream all recordings on the project's entries
const member2Email = `member2-${Date.now()}@test.ca`;
await sa.req('POST', `/api/projects/${projectId}/members`,
  { email: member2Email, name: 'Second Member', password: 'member2-pass-1' });
const member2Id = r.data.user_id;
const member2 = client();
await member2.req('POST', '/api/login', { email: member2Email, password: 'member2-pass-1' });

fd = new FormData();
fd.append('file', new Blob([makeWav(2)], { type: 'audio/wav' }), 'm2-dene.wav');
fd.append('language', 'dene');
r = await member2.req('POST', `/api/entries/${entryId}/audio`, fd, true);
check('second member records own dene clip', r.status === 201, JSON.stringify(r.data));
const member2AudioId = r.data?.id;

r = await member2.req('GET', `/api/entries/${entryId}`);
check('member2 sees all recordings on the entry', r.status === 200 && r.data.audio.length === 3 &&
  r.data.audio.some((a) => a.id === member2AudioId), JSON.stringify(r.data?.audio));

r = await member.req('GET', `/api/entries/${entryId}`);
check("member1 sees member2's recording too", r.status === 200 && r.data.audio.length === 3 &&
  r.data.audio.some((a) => a.id === member2AudioId), JSON.stringify(r.data?.audio));

r = await member2.req('GET', `/api/audio/${audioId}/stream`);
check("member streams another member's recording", r.status === 200);

r = await sa.req('GET', `/api/entries/${entryId}`);
check('admin sees all recordings', r.status === 200 && r.data.audio.length === 3,
  JSON.stringify(r.data?.audio?.length));

r = await sa.req('GET', `/api/audio/${member2AudioId}/stream`);
check("admin can stream members' recordings", r.status === 200);

// #8b: the stream serves the MP3 derivative when ffmpeg has produced one (CI)
// or falls back to the WAV master (dev without ffmpeg) — either way it must be
// a whitelisted audio type with nosniff, never a client-supplied MIME.
r = await member.req('GET', `/api/audio/${audioIdV2}/stream`);
check('stream serves whitelisted audio (master or derivative) with nosniff',
  r.status === 200 && /audio\/(wav|mpeg)/.test(r.headers.get('content-type') || '') &&
  r.headers.get('x-content-type-options') === 'nosniff', r.headers.get('content-type'));
r = await member2.req('GET', `/api/audio/${audioIdV2}/master`);
check('non-uploader project member cannot download the master', r.status === 403);
r = await sa.req('GET', `/api/audio/${audioIdV2}/master`);
check('admin can download the master', r.status === 200);

// Promote-on-delete, on a throwaway entry so the counts above are untouched.
r = await member.req('POST', '/api/entries', { project_id: projectId, dene_text: 'kǫ̀', english_text: 'fire (v)' });
const verEntry = r.data.id;
let vfd = new FormData(); vfd.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'v1.wav'); vfd.append('language', 'dene');
const ver1 = (await member.req('POST', `/api/entries/${verEntry}/audio`, vfd, true)).data;
vfd = new FormData(); vfd.append('file', new Blob([makeWav(2)], { type: 'audio/wav' }), 'v2.wav'); vfd.append('language', 'dene');
const ver2 = (await member.req('POST', `/api/entries/${verEntry}/audio`, vfd, true)).data;
await member.req('DELETE', `/api/audio/${ver2.id}`); // delete current → v1 promoted
r = await member.req('GET', `/api/entries/${verEntry}`);
check('deleting the current version promotes the previous one',
  r.data.audio.length === 1 && r.data.audio[0].id === ver1.id && r.data.audio[0].is_current === 1, JSON.stringify(r.data.audio));
await member.req('DELETE', `/api/audio/${ver1.id}`); // delete last version → slot empty
r = await member.req('GET', `/api/entries/${verEntry}`);
check('deleting the last version empties the slot', r.data.audio.length === 0);
await member.req('DELETE', `/api/entries/${verEntry}`);

// --- translator role: records audio, cannot touch entries ---
const translatorEmail = `translator${Date.now()}@test.ca`;
r = await sa.req('POST', `/api/projects/${projectId}/members`,
  { email: translatorEmail, name: 'Test Translator', password: 'translator-pass-1', role: 'translator' });
check('admin creates translator account', r.status === 201, JSON.stringify(r.data));
const translatorId = r.data.user_id;

const translator = client();
r = await translator.req('POST', '/api/login', { email: translatorEmail, password: 'translator-pass-1' });
check('translator login', r.status === 200);

r = await translator.req('GET', '/api/projects');
check('translator sees project with translator role', r.status === 200 &&
  r.data.projects[0]?.role === 'translator', JSON.stringify(r.data));

r = await translator.req('POST', '/api/entries',
  { project_id: projectId, dene_text: 'x', english_text: 'y' });
check('translator cannot create entries', r.status === 403);

r = await translator.req('PATCH', `/api/entries/${entryId}`, { english_text: 'nope' });
check('translator cannot edit entries', r.status === 403);

r = await translator.req('DELETE', `/api/entries/${entryId}`);
check('translator cannot delete entries', r.status === 403);

r = await translator.req('GET', `/api/entries?project_id=${projectId}&has_audio=no`);
check('translator lists entries without audio (recording queue)', r.status === 200 &&
  r.data.entries.every((e) => e.audio_count === 0), JSON.stringify(r.data.total));

// Hardening #5: paid work flows only through work items — the generic upload and
// translate endpoints reject translators outright.
fd = new FormData();
fd.append('file', new Blob([makeWav(2)], { type: 'audio/wav' }), 'translator-dene.wav');
fd.append('language', 'dene');
r = await translator.req('POST', `/api/entries/${entryId}/audio`, fd, true);
check('translator cannot use the generic audio upload', r.status === 403, JSON.stringify(r.data));

// --- per-speaker recording queue (#1): needs_my_audio is scoped to the caller ---
r = await member.req('POST', '/api/entries', { project_id: projectId, dene_text: 'kǫ́', english_text: 'fire' });
const queueEntryId = r.data?.id;
const queue = async (c, lang = 'dene') =>
  (await c.req('GET', `/api/entries?project_id=${projectId}&needs_my_audio=${lang}&complete=yes&limit=200`)).data;

let qa = await queue(member), qb = await queue(member2);
check('speaker A sees an unrecorded entry in their queue', qa.entries.some((e) => e.id === queueEntryId));
check('speaker B sees the same entry in their queue', qb.entries.some((e) => e.id === queueEntryId));

fd = new FormData();
fd.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'a-dene.wav');
fd.append('language', 'dene');
await member.req('POST', `/api/entries/${queueEntryId}/audio`, fd, true);

qa = await queue(member); qb = await queue(member2);
check("after A records, entry leaves A's queue", !qa.entries.some((e) => e.id === queueEntryId));
check("after A records, entry still in B's queue (per-speaker, not global)", qb.entries.some((e) => e.id === queueEntryId));
check('Dene and English queues are independent for a speaker',
  (await queue(member, 'english')).entries.some((e) => e.id === queueEntryId));

fd = new FormData();
fd.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'b-dene.wav');
fd.append('language', 'dene');
await member2.req('POST', `/api/entries/${queueEntryId}/audio`, fd, true);
check("after B records, entry leaves B's queue too", !(await queue(member2)).entries.some((e) => e.id === queueEntryId));

await member.req('DELETE', `/api/entries/${queueEntryId}`); // cascades audio; keeps stats below simple

// clean up the extra clips so the stats checks below stay simple
await member.req('DELETE', `/api/audio/${englishAudioId}`);
await member2.req('DELETE', `/api/audio/${member2AudioId}`);

// --- work items: claiming, leases, transactional billing (#3/#4) ---
// Dedicated project so the candidate sets are controlled and stats above are untouched.
r = await sa.req('POST', '/api/projects', { name: pname + ' WI', dialect: 'x' });
const wiProj = r.data.id;
const aEmail = `wi-a-${Date.now()}@test.ca`;
const bEmail = `wi-b-${Date.now()}@test.ca`;
r = await sa.req('POST', `/api/projects/${wiProj}/members`, { email: aEmail, name: 'WI A', password: 'wi-a-pass-1', role: 'translator' });
const aId = r.data.user_id;
r = await sa.req('POST', `/api/projects/${wiProj}/members`, { email: bEmail, name: 'WI B', password: 'wi-b-pass-1', role: 'translator' });
const bId = r.data.user_id;
const A = client(), B = client();
await A.req('POST', '/api/login', { email: aEmail, password: 'wi-a-pass-1' });
await B.req('POST', '/api/login', { email: bEmail, password: 'wi-b-pass-1' });
// rates so accepted work bills a known, testable amount
await sa.req('PUT', `/api/compensation/${aId}/rates`, { project_id: wiProj, type: 'translation', rate_cents: 500 });
await sa.req('PUT', `/api/compensation/${aId}/rates`, { project_id: wiProj, type: 'recording', rate_cents: 300 });
const claim = (c, body) => c.req('POST', `/api/projects/${wiProj}/work/claim`, body);
const itemFor = (resp, entryId) => resp.data.items.find((i) => i.entry.id === entryId);

// (1) atomic single-claim: one incomplete phrase, two translators claim, exactly one wins
r = await sa.req('POST', '/api/entries', { project_id: wiProj, kind: 'phrase', dene_text: 'sǫ́ba', english_text: '' });
const onePhrase = r.data.id;
const ca = await claim(A, { type: 'translation', limit: 20 });
const cb = await claim(B, { type: 'translation', limit: 20 });
const aGot = !!itemFor(ca, onePhrase), bGot = !!itemFor(cb, onePhrase);
check('atomic claim: exactly one translator gets the sole phrase', aGot !== bGot, JSON.stringify([aGot, bGot]));
const holder = aGot ? A : B, holderId = aGot ? aId : bId;
const oneWi = itemFor(aGot ? ca : cb, onePhrase).work_item_id;

// Submitting is assignee-only: an admin cannot submit a contributor's claimed
// item (acceptance would bill the contributor for the admin's work).
let s = await sa.req('POST', `/api/work/${oneWi}/submit`, { english_text: 'hijack' });
check('admin cannot submit a contributor\'s claimed work item', s.status === 403, JSON.stringify(s.data));

// (3) idempotent double-submit + (bill exactly once)
s = await holder.req('POST', `/api/work/${oneWi}/submit`, { english_text: 'money' });
check('translation submit accepted + applied', s.status === 200 && s.data.entry.english_text === 'money', JSON.stringify(s.data));
s = await holder.req('POST', `/api/work/${oneWi}/submit`, { english_text: 'money-again' });
check('idempotent re-submit: no re-apply', s.status === 200 && s.data.entry.english_text === 'money');
r = await sa.req('GET', `/api/compensation/${holderId}`);
let trans = r.data.work.filter((w) => w.type === 'translation' && w.entry_id === onePhrase);
check('translation billed exactly once at the snapshot rate', trans.length === 1 && trans[0].amount_cents === 500, JSON.stringify(trans));

// (5) applied on accept + no longer offered
r = await sa.req('GET', `/api/entries/${onePhrase}`);
check('accepted translation is on the entry', r.data.english_text === 'money' && r.data.dene_text === 'sǫ́ba');
check('completed phrase no longer offered', !itemFor(await claim(holder, { type: 'translation', limit: 20 }), onePhrase));

// (2) expired-claim reclaim + (8) stale-claim submit is safe
r = await sa.req('POST', '/api/entries', { project_id: wiProj, kind: 'phrase', dene_text: "k'ǫ", english_text: '' });
const expPhrase = r.data.id;
const aExp = await claim(A, { type: 'translation', limit: 20, _test_lease_seconds: -1 });
const aExpWi = itemFor(aExp, expPhrase).work_item_id;
const bExp = await claim(B, { type: 'translation', limit: 20 });
check('expired claim is reclaimable by another user', !!itemFor(bExp, expPhrase), JSON.stringify(bExp.data.items.map((i) => i.entry.id)));
await B.req('POST', `/api/work/${itemFor(bExp, expPhrase).work_item_id}/submit`, { english_text: 'fire' });
const stale = await A.req('POST', `/api/work/${aExpWi}/submit`, { english_text: 'STOLEN' });
check('stale-claim submit rejected (409), not applied', stale.status === 409);
r = await sa.req('GET', `/api/entries/${expPhrase}`);
check('stale submit did not overwrite the entry', r.data.english_text === 'fire');
r = await sa.req('GET', `/api/compensation/${aId}`);
check('stale submit did not bill A', r.data.work.filter((w) => w.type === 'translation' && w.entry_id === expPhrase).length === 0);

// (7) release re-opens immediately
r = await sa.req('POST', '/api/entries', { project_id: wiProj, kind: 'phrase', dene_text: 'tsá', english_text: '' });
const relPhrase = r.data.id;
const relWi = itemFor(await claim(A, { type: 'translation', limit: 20 }), relPhrase).work_item_id;
// Admins CAN release someone else's stuck claim (unlike submit).
r = await sa.req('POST', `/api/work/${relWi}/release`);
check('admin can release a contributor\'s stuck claim', r.status === 200);
check('released item is immediately re-claimable', !!itemFor(await claim(B, { type: 'translation', limit: 20 }), relPhrase));

// (6) per-speaker recording + (4) no double-bill on legacy re-record
r = await sa.req('POST', '/api/entries', { project_id: wiProj, dene_text: 'dlǫ', english_text: 'squirrel' });
const recEntry = r.data.id;
const aRecWi = itemFor(await claim(A, { type: 'recording', language: 'dene', limit: 20 }), recEntry).work_item_id;
const bRecWi = itemFor(await claim(B, { type: 'recording', language: 'dene', limit: 20 }), recEntry).work_item_id;
check('both speakers get their own recording item for the same entry', !!aRecWi && !!bRecWi && aRecWi !== bRecWi);
let fd2 = new FormData(); fd2.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'a-rec.wav');
const ra = await A.req('POST', `/api/work/${aRecWi}/submit`, fd2, true);
fd2 = new FormData(); fd2.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'b-rec.wav');
const rb = await B.req('POST', `/api/work/${bRecWi}/submit`, fd2, true);
check('both recording submits accepted', ra.status === 200 && rb.status === 200, JSON.stringify([ra.status, rb.status]));
r = await sa.req('GET', `/api/entries/${recEntry}`);
check('two recordings on the entry (per-speaker)', r.data.audio.length === 2, JSON.stringify(r.data.audio.length));
r = await sa.req('GET', `/api/compensation/${aId}`);
check('A billed exactly one recording at the snapshot rate',
  r.data.work.filter((w) => w.type === 'recording').length === 1 &&
  r.data.work.find((w) => w.type === 'recording').amount_cents === 300);
// Hardening #2: an accepted (billed) slot is a satisfied obligation — a fresh
// claim must NOT re-offer it, and needs_my_audio agrees.
r = await A.req('POST', `/api/projects/${wiProj}/work/claim`, { type: 'recording', language: 'dene', limit: 20 });
check('billed slot not re-offered on a fresh claim', !r.data.items.some((i) => i.entry.id === recEntry), JSON.stringify(r.data.items.map((i) => i.entry.id)));
for (const i of r.data.items) await A.req('POST', `/api/work/${i.work_item_id}/release`); // tidy up stray claims

// Hardening #2 delete policy: billed recordings are org-admin-only to delete.
r = await sa.req('GET', `/api/entries/${recEntry}`);
const aBilledAudio = r.data.audio.find((x) => x.uploaded_by_name === 'WI A');
r = await A.req('DELETE', `/api/audio/${aBilledAudio.id}`);
check('uploader cannot delete their billed recording', r.status === 403, JSON.stringify(r.data));
r = await sa.req('DELETE', `/api/audio/${aBilledAudio.id}`);
check('org admin can delete a billed recording', r.status === 200);
r = await A.req('POST', `/api/projects/${wiProj}/work/claim`, { type: 'recording', language: 'dene', limit: 20 });
check('slot still not claimable after admin deletion (obligation satisfied)',
  !r.data.items.some((i) => i.entry.id === recEntry), JSON.stringify(r.data.items.map((i) => i.entry.id)));
for (const i of r.data.items) await A.req('POST', `/api/work/${i.work_item_id}/release`);
r = await A.req('GET', `/api/entries?project_id=${wiProj}&needs_my_audio=dene&complete=yes&limit=200`);
check('needs_my_audio agrees the billed slot is done', !r.data.entries.some((e) => e.id === recEntry));

// Hardening #2 paid rework: only an explicit admin authorization reopens payment.
r = await A.req('POST', `/api/entries/${recEntry}/audio-rework`, { user_id: aId, language: 'dene' });
check('non-admin cannot authorize rework', r.status === 403);
r = await sa.req('POST', `/api/entries/${recEntry}/audio-rework`, { user_id: aId, language: 'dene' });
check('org admin authorizes paid rework', r.status === 201 && !!r.data.work_item_id, JSON.stringify(r.data));
const reworkWi = r.data.work_item_id;
r = await sa.req('POST', `/api/entries/${recEntry}/audio-rework`, { user_id: aId, language: 'dene' });
check('duplicate rework authorization rejected', r.status === 409, JSON.stringify(r.data));
r = await A.req('POST', `/api/projects/${wiProj}/work/claim`, { type: 'recording', language: 'dene', limit: 20 });
let adopted = r.data.items.find((i) => i.work_item_id === reworkWi);
check('claim adopts the authorized rework item', !!adopted, JSON.stringify(r.data.items));
// releasing rework re-queues it (authorization survives a skipped session)
await A.req('POST', `/api/work/${reworkWi}/release`);
r = await A.req('POST', `/api/projects/${wiProj}/work/claim`, { type: 'recording', language: 'dene', limit: 20, _test_lease_seconds: -1 });
check('released rework is re-adoptable', r.data.items.some((i) => i.work_item_id === reworkWi));
// expired lease also re-queues rework (claimed with an already-past lease above)
r = await A.req('POST', `/api/projects/${wiProj}/work/claim`, { type: 'recording', language: 'dene', limit: 20 });
check('expired rework lease re-queues (not cancelled)', r.data.items.some((i) => i.work_item_id === reworkWi), JSON.stringify(r.data.items));
fd2 = new FormData(); fd2.append('file', new Blob([makeWav(2)], { type: 'audio/wav' }), 'a-rework.wav');
r = await A.req('POST', `/api/work/${reworkWi}/submit`, fd2, true);
check('rework submit accepted', r.status === 200, JSON.stringify(r.data));
r = await sa.req('GET', `/api/compensation/${aId}`);
check('rework billed a second recording ledger row',
  r.data.work.filter((w) => w.type === 'recording').length === 2, JSON.stringify(r.data.work.map((w) => w.type)));
r = await A.req('POST', `/api/projects/${wiProj}/work/claim`, { type: 'recording', language: 'dene', limit: 20 });
check('slot excluded again after rework accepted', !r.data.items.some((i) => i.entry.id === recEntry));
for (const i of r.data.items) await A.req('POST', `/api/work/${i.work_item_id}/release`);

// Hardening #3/#1 invariant: an accepted work item ALWAYS has its ledger row —
// even when the audio already exists (recorded via the entry page mid-session).
r = await sa.req('POST', '/api/entries', { project_id: wiProj, dene_text: 'ts’u', english_text: 'spruce' });
const midEntry = r.data.id;
r = await sa.req('POST', `/api/projects/${wiProj}/work/claim`, { type: 'recording', language: 'dene', limit: 20 });
const midItem = r.data.items.find((i) => i.entry.id === midEntry);
for (const i of r.data.items.filter((x) => x.entry.id !== midEntry)) await sa.req('POST', `/api/work/${i.work_item_id}/release`);
check('org admin can claim recording work', !!midItem);
fd2 = new FormData(); fd2.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'mid.wav'); fd2.append('language', 'dene');
r = await sa.req('POST', `/api/entries/${midEntry}/audio`, fd2, true);   // entry-page upload mid-session (unbilled)
const midAudioId = r.data.id;
fd2 = new FormData(); fd2.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'mid-dup.wav');
r = await sa.req('POST', `/api/work/${midItem.work_item_id}/submit`, fd2, true);
check('submit with existing audio accepts against it', r.status === 200 && r.data.audio?.id === midAudioId, JSON.stringify(r.data));
r = await sa.req('GET', `/api/compensation/${(await sa.req('GET', '/api/me')).data.user.id}`);
check('accepted-against-existing still writes exactly one ledger row',
  r.data.work.filter((w) => w.type === 'recording' && w.entry_id === midEntry).length === 1, JSON.stringify(r.data.work));

// Documented policy: re-blanking a billed phrase's side (an authorized edit by a
// different actor) makes it genuinely new translation work — claimable + payable.
await sa.req('PATCH', `/api/entries/${expPhrase}`, { english_text: '' });
r = await B.req('POST', `/api/projects/${wiProj}/work/claim`, { type: 'translation', limit: 20 });
const reblank = r.data.items.find((i) => i.entry.id === expPhrase);
check('re-blanked billed phrase is claimable again', !!reblank, JSON.stringify(r.data.items));
r = await B.req('POST', `/api/work/${reblank.work_item_id}/submit`, { english_text: 'fire (redone)' });
check('re-blank retranslation accepted', r.status === 200);
r = await sa.req('GET', `/api/compensation/${bId}`);
check('re-blank yields a second translation ledger row (documented policy)',
  r.data.work.filter((w) => w.type === 'translation' && w.entry_id === expPhrase).length === 2,
  JSON.stringify(r.data.work.map((w) => w.type)));

await sa.req('DELETE', `/api/projects/${wiProj}`, { confirm_name: pname + ' WI' });

// --- stats & export ---
r = await sa.req('GET', `/api/projects/${projectId}/stats`);
check('project stats: entries + audio seconds', r.status === 200 &&
  r.data.entry_count === 2 && Math.abs(r.data.audio_seconds - 3) < 0.1, JSON.stringify(r.data));

r = await sa.req('GET', `/api/projects/${projectId}/export?format=csv`);
check('CSV export', r.status === 200 && String(r.data).includes('dene_text'), String(r.data).slice(0, 100));

r = await sa.req('GET', `/api/projects/${projectId}/export?format=json`);
check('JSON export includes audio refs (current master path)', r.status === 200 &&
  r.data.entries[0].audio.length === 1 &&
  r.data.entries[0].audio[0].file === `audio/masters/${memberId}/` + r.data.entries[0].audio[0].file.split('/').pop() &&
  r.data.entries[0].audio[0].language === 'dene',
  JSON.stringify(r.data).slice(0, 300));

r = await member.req('GET', `/api/projects/${projectId}/export?format=json`);
check('member cannot export (admin only)', r.status === 403);

// --- full archive ZIP (#7) ---
let z = await sa.raw('GET', `/api/projects/${projectId}/export-bundle`);
check('export-bundle is a zip attachment', z.status === 200 &&
  (z.headers.get('content-type') || '').includes('application/zip') &&
  (z.headers.get('content-disposition') || '').includes('attachment'),
  `${z.status} ${z.headers.get('content-type')}`);
check('zip has PK magic', z.buf.length > 500 && z.buf[0] === 0x50 && z.buf[1] === 0x4b && z.buf[2] === 0x03 && z.buf[3] === 0x04, `len=${z.buf.length}`);
// The bundle embeds the actual master (~48 KB WAV from makeWav(3)), so it dwarfs a metadata-only archive.
check('archive embeds the audio bytes', z.buf.length > 40000, `len=${z.buf.length}`);
z = await member.raw('GET', `/api/projects/${projectId}/export-bundle`);
check('member cannot download the archive bundle', z.status === 403);
z = await sa.raw('GET', `/api/projects/${projectId}/export-bundle?kind=word`);
check('kind-filtered archive is a valid zip', z.status === 200 && z.buf[0] === 0x50 && z.buf[1] === 0x4b);

// --- bulk CSV import (superadmin only) ---
const csvBody = [
  '"Dene Text","English Text"',
  '"sı̨ne, sǫba","my money, with a comma"',
  'ʔedlánetʼe?,How are you?',
  'ʔedlánetʼe?,How are you?',                       // duplicate within file
  '"Sı̨ Mike sʔǫlye, ʔedlánetʼe?",ignored-not-dup', // same dene but different english = not a dup
  ',missing dene',
  'missing english,',
  '',
].join('\r\n');

fd = new FormData();
fd.append('file', new Blob(['﻿' + csvBody], { type: 'text/csv' }), 'phrasebook.csv');
r = await sa.req('POST', `/api/projects/${projectId}/import`, fd, true);
// One-sided rows now import (queued for translation) — only fully-empty rows are invalid.
check('CSV import (header, quotes, BOM, CRLF; one-sided rows import)', r.status === 200 &&
  r.data.imported === 5 && r.data.skipped_duplicates === 1 && r.data.skipped_invalid === 0,
  JSON.stringify(r.data));
r = await sa.req('GET', `/api/entries?project_id=${projectId}&q=${encodeURIComponent('missing dene')}`);
check('one-sided imported row is queued for translation', r.status === 200 &&
  r.data.entries[0]?.dene_text === '' && r.data.entries[0]?.english_text === 'missing dene',
  JSON.stringify(r.data.entries?.[0]));

r = await sa.req('GET', `/api/entries?project_id=${projectId}&q=${encodeURIComponent('sǫba')}`);
check('imported entry searchable with diacritics intact', r.status === 200 && r.data.total === 1 &&
  r.data.entries[0].dene_text === 'sı̨ne, sǫba', JSON.stringify(r.data.entries?.[0]?.dene_text));
check('import sets source document', r.data.entries?.[0]?.source_doc === 'CSV import: phrasebook.csv',
  JSON.stringify(r.data.entries?.[0]?.source_doc));

fd = new FormData();
fd.append('file', new Blob([csvBody], { type: 'text/csv' }), 'phrasebook.csv');
r = await sa.req('POST', `/api/projects/${projectId}/import`, fd, true);
check('re-import is idempotent (all duplicates)', r.status === 200 &&
  r.data.imported === 0 && r.data.skipped_duplicates === 6, JSON.stringify(r.data));

// headerless two-column file
fd = new FormData();
fd.append('file', new Blob(['łue,fish\n'], { type: 'text/csv' }), 'no-header.csv');
r = await sa.req('POST', `/api/projects/${projectId}/import`, fd, true);
check('headerless CSV assumes dene,english', r.status === 200 && r.data.imported === 1,
  JSON.stringify(r.data));

// optional third category column
const catCsv = 'dene_text,english_text,category\nbesı̨ı̨́,knife,tools\nkǫ́,fire,"household, heat"\nsah,bear\n';
fd = new FormData();
fd.append('file', new Blob([catCsv], { type: 'text/csv' }), 'categories.csv');
r = await sa.req('POST', `/api/projects/${projectId}/import`, fd, true);
check('CSV import with optional category column', r.status === 200 && r.data.imported === 3,
  JSON.stringify(r.data));

r = await sa.req('GET', `/api/entries?project_id=${projectId}&q=besı̨ı̨́`);
check('imported category stored', r.status === 200 && r.data.entries[0]?.category === 'tools',
  JSON.stringify(r.data.entries?.[0]?.category));

r = await sa.req('GET', `/api/entries?project_id=${projectId}&q=sah`);
check('row without category imports with empty category', r.status === 200 &&
  r.data.entries[0]?.category === null, JSON.stringify(r.data.entries?.[0]?.category));

r = await sa.req('GET', `/api/projects/${projectId}/export?format=csv`);
check('CSV export includes category column', r.status === 200 &&
  String(r.data).includes(',category,') && String(r.data).includes('tools'),
  String(r.data).slice(0, 140));

fd = new FormData();
fd.append('file', new Blob(['a,b\n'], { type: 'text/csv' }), 'x.csv');
r = await member.req('POST', `/api/projects/${projectId}/import`, fd, true);
check('member cannot import', r.status === 403);

fd = new FormData();
fd.append('file', new Blob(['not,a,csv'], { type: 'text/plain' }), 'data.json');
r = await sa.req('POST', `/api/projects/${projectId}/import`, fd, true);
check('non-CSV file rejected', r.status === 400);

// --- import/export by kind (isolated project so other counts are unaffected) ---
r = await sa.req('POST', '/api/projects', { name: pname + ' Imp' });
const impProj = r.data.id;

let impCsv = 'dene_text,english_text\nkų,house\nłı,dog\n';
fd = new FormData();
fd.append('kind', 'word');
fd.append('file', new Blob([impCsv], { type: 'text/csv' }), 'words.csv');
r = await sa.req('POST', `/api/projects/${impProj}/import`, fd, true);
check('import as words', r.status === 200 && r.data.imported === 2, JSON.stringify(r.data));

impCsv = 'dene_text,english_text\nedǝ honı̨dǝ,how are you\n,sit down please\nması̨ cho,\n';
fd = new FormData();
fd.append('kind', 'phrase');
fd.append('file', new Blob([impCsv], { type: 'text/csv' }), 'phrases.csv');
r = await sa.req('POST', `/api/projects/${impProj}/import`, fd, true);
check('import as phrases allows one-sided rows', r.status === 200 && r.data.imported === 3, JSON.stringify(r.data));

impCsv = 'dene_text,english_text\nkų,house\n';
fd = new FormData();
fd.append('kind', 'phrase');
fd.append('file', new Blob([impCsv], { type: 'text/csv' }), 'dup.csv');
r = await sa.req('POST', `/api/projects/${impProj}/import`, fd, true);
check('dedup is scoped by kind', r.status === 200 && r.data.imported === 1, JSON.stringify(r.data));

r = await sa.req('GET', `/api/entries?project_id=${impProj}&kind=word`);
check('imported words tagged kind=word', r.status === 200 && r.data.total === 2 &&
  r.data.entries.every((e) => e.kind === 'word'), JSON.stringify(r.data.total));
r = await sa.req('GET', `/api/entries?project_id=${impProj}&kind=phrase`);
check('imported phrases tagged kind=phrase', r.status === 200 && r.data.total === 4 &&
  r.data.entries.every((e) => e.kind === 'phrase'), JSON.stringify(r.data.total));

r = await sa.req('GET', `/api/projects/${impProj}/export?format=json&kind=word`);
check('export kind=word returns only words', r.status === 200 && r.data.entries.length === 2 &&
  r.data.entries.every((e) => e.kind === 'word'), JSON.stringify(r.data.entries.length));
r = await sa.req('GET', `/api/projects/${impProj}/export?format=json&kind=phrase`);
check('export kind=phrase returns only phrases', r.status === 200 && r.data.entries.length === 4 &&
  r.data.entries.every((e) => e.kind === 'phrase'), JSON.stringify(r.data.entries.length));
r = await sa.req('GET', `/api/projects/${impProj}/export?format=csv`);
check('combined CSV export has a kind column', r.status === 200 &&
  String(r.data).split('\n')[0].includes('kind'), String(r.data).split('\n')[0]);

await sa.req('DELETE', `/api/projects/${impProj}`, { confirm_name: pname + ' Imp' });

// --- phrases (entries with kind='phrase'; one side may be blank → incomplete) ---
// Created and cleaned up here so the project's entry/recording counts are
// unchanged for the deletion assertions below.
r = await member.req('POST', '/api/entries', { project_id: projectId, kind: 'phrase', dene_text: 'sǫǫ', english_text: '' });
check('phrase with only Dene (incomplete)', r.status === 201 && r.data.kind === 'phrase' && r.data.english_text === '', JSON.stringify(r.data));
const phraseDeneOnly = r.data?.id;

r = await member.req('POST', '/api/entries', { project_id: projectId, kind: 'phrase', dene_text: '', english_text: 'hello there' });
check('phrase with only English (incomplete)', r.status === 201 && r.data.dene_text === '', JSON.stringify(r.data));
const phraseEngOnly = r.data?.id;

r = await member.req('POST', '/api/entries', { project_id: projectId, kind: 'phrase', dene_text: 'edǝ', english_text: 'good morning' });
check('phrase with both sides (complete)', r.status === 201 && r.data.kind === 'phrase', JSON.stringify(r.data));
const phraseBoth = r.data?.id;

r = await member.req('POST', '/api/entries', { project_id: projectId, kind: 'phrase' });
check('phrase with neither side rejected', r.status === 400);

// UI fix: a one-sided WORD is now valid too — queued for translation, held out
// of recording, offered by the translation claim, and completable.
r = await member.req('POST', '/api/entries', { project_id: projectId, english_text: 'lonely' });
check('one-sided word accepted (English only)', r.status === 201 && r.data.dene_text === '', JSON.stringify(r.data));
const oneSidedWord = r.data.id;
r = await member.req('GET', `/api/entries?project_id=${projectId}&complete=no`);
check('one-sided word appears in the needs-translation filter', r.data.entries.some((e) => e.id === oneSidedWord));
fd = new FormData();
fd.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'w.wav');
fd.append('language', 'dene');
r = await member.req('POST', `/api/entries/${oneSidedWord}/audio`, fd, true);
check('one-sided word cannot be recorded yet', r.status === 400, JSON.stringify(r.data));
const wordClaim = (await translator.req('POST', `/api/projects/${projectId}/work/claim`, { type: 'translation', limit: 20 })).data;
const wordItem = wordClaim.items.find((i) => i.entry.id === oneSidedWord);
check('one-sided WORD is offered by the translation claim', !!wordItem, JSON.stringify(wordClaim.items.map((i) => i.entry.id)));
r = await translator.req('POST', `/api/work/${wordItem.work_item_id}/submit`, { dene_text: 'ı̨łaghe', english_text: 'lonely' });
check('translator completes the word via work item', r.status === 200, JSON.stringify(r.data));
for (const i of wordClaim.items.filter((x) => x.work_item_id !== wordItem.work_item_id)) {
  await translator.req('POST', `/api/work/${i.work_item_id}/release`);
}
await member.req('DELETE', `/api/entries/${oneSidedWord}`);
r = await member.req('POST', '/api/entries', { project_id: projectId });
check('an entry with neither side is still rejected', r.status === 400);

r = await member.req('GET', `/api/entries?project_id=${projectId}&kind=phrase`);
check('kind=phrase returns only phrases', r.status === 200 && r.data.total >= 3 &&
  r.data.entries.every((e) => e.kind === 'phrase'), JSON.stringify(r.data.total));

r = await member.req('GET', `/api/entries?project_id=${projectId}&kind=word`);
check('kind=word excludes phrases', r.status === 200 && r.data.entries.every((e) => e.kind === 'word'));

r = await member.req('GET', `/api/entries?project_id=${projectId}&kind=phrase&has_audio=no&complete=yes`);
check('recordable queue includes complete phrase, excludes incomplete', r.status === 200 &&
  r.data.entries.some((e) => e.id === phraseBoth) && !r.data.entries.some((e) => e.id === phraseDeneOnly),
  JSON.stringify(r.data.entries.map((e) => e.id)));

fd = new FormData();
fd.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'p.wav');
fd.append('language', 'dene');
r = await member.req('POST', `/api/entries/${phraseEngOnly}/audio`, fd, true);
check('audio rejected on incomplete phrase', r.status === 400, JSON.stringify(r.data));

r = await member.req('PATCH', `/api/entries/${phraseEngOnly}`, { dene_text: 'sası̨ı̨' });
check('completing a phrase via edit', r.status === 200 && r.data.dene_text === 'sası̨ı̨');

fd = new FormData();
fd.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'p2.wav');
fd.append('language', 'dene');
r = await member.req('POST', `/api/entries/${phraseEngOnly}/audio`, fd, true);
check('audio accepted once phrase is complete', r.status === 201, JSON.stringify(r.data));

r = await member.req('PATCH', `/api/entries/${phraseBoth}`, { dene_text: '', english_text: '' });
check('cannot blank both sides of a phrase', r.status === 400);

r = await translator.req('POST', '/api/entries', { project_id: projectId, kind: 'phrase', english_text: 'nope' });
check('translator cannot create phrases', r.status === 403);

// Hardening #5: /translate is a member/admin direct-edit tool now (unbilled) —
// translators are rejected and must use the work-item translation session.
r = await translator.req('POST', `/api/entries/${phraseDeneOnly}/translate`, { dene_text: 'sǫǫ', english_text: 'nope' });
check('translator cannot use the generic translate endpoint', r.status === 403, JSON.stringify(r.data));

r = await member.req('POST', `/api/entries/${phraseDeneOnly}/translate`, { dene_text: '', english_text: '' });
check('translate rejects blanking both sides', r.status === 400);

r = await member.req('POST', `/api/entries/${phraseDeneOnly}/translate`, { dene_text: 'sǫǫ', english_text: 'water (clean)' });
check('member completes a phrase via translate (unbilled)', r.status === 200 &&
  r.data.dene_text === 'sǫǫ' && r.data.english_text === 'water (clean)', JSON.stringify(r.data));

// Words are translatable now, but a COMPLETE entry still can't be rewritten via
// /translate by someone without edit rights (member2 doesn't own entryId).
r = await member2.req('POST', `/api/entries/${entryId}/translate`, { english_text: 'x' });
check('translate still rejects rewriting a complete entry', r.status === 403, JSON.stringify(r.data));

// clean up the phrases (and their cascade-deleted audio) to keep counts stable
for (const pid of [phraseDeneOnly, phraseEngOnly, phraseBoth]) {
  await member.req('DELETE', `/api/entries/${pid}`);
}

// --- compensation (self-contained in its own project) ---
r = await sa.req('POST', '/api/projects', { name: pname + ' Comp' });
const compProj = r.data.id;
await sa.req('POST', `/api/projects/${compProj}/members`, { email: translatorEmail, role: 'translator' });

r = await sa.req('PUT', `/api/compensation/${translatorId}/rates`, { project_id: compProj, type: 'translation', rate_cents: 200 });
check('superadmin sets translation rate', r.status === 200, JSON.stringify(r.data));
await sa.req('PUT', `/api/compensation/${translatorId}/rates`, { project_id: compProj, type: 'recording', rate_cents: 150 });
r = await sa.req('PUT', `/api/compensation/${translatorId}/rates`, { project_id: compProj, type: 'recording', rate_cents: 175 });
check('superadmin can change a rate', r.status === 200);

r = await sa.req('POST', '/api/entries', { project_id: compProj, dene_text: 'kǫ', english_text: 'fire' });
const compWord = r.data.id;
r = await sa.req('POST', '/api/entries', { project_id: compProj, kind: 'phrase', english_text: 'good morning' });
const compPhrase = r.data.id;

// Paid work happens through work items only (hardening #5).
const compClaim = async (type) =>
  (await translator.req('POST', `/api/projects/${compProj}/work/claim`, { type, ...(type === 'recording' ? { language: 'dene' } : {}), limit: 20 })).data;
let cw = (await compClaim('recording')).items.find((i) => i.entry.id === compWord);
check('translator claims recording work in comp project', !!cw, 'no item for compWord');
fd = new FormData();
fd.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'comp.wav');
r = await translator.req('POST', `/api/work/${cw.work_item_id}/submit`, fd, true);
check('translator records via work item', r.status === 200, JSON.stringify(r.data));

// The billed slot is a satisfied obligation: no second recording claim for it.
cw = (await compClaim('recording')).items.find((i) => i.entry.id === compWord);
check('re-claim of the billed slot is not offered (no double-billing)', !cw);

let ct = (await compClaim('translation')).items.find((i) => i.entry.id === compPhrase);
check('translator claims translation work in comp project', !!ct, 'no item for compPhrase');
r = await translator.req('POST', `/api/work/${ct.work_item_id}/submit`, { dene_text: 'edǝ', english_text: 'good morning' });
check('translator translates via work item', r.status === 200, JSON.stringify(r.data));

r = await sa.req('GET', `/api/compensation/${translatorId}`);
check('ledger uses snapshotted rates (175 recording + 200 translation)', r.status === 200 &&
  r.data.work.filter((w) => w.type === 'recording' && w.amount_cents === 175).length === 1 &&
  r.data.work.filter((w) => w.type === 'translation' && w.amount_cents === 200).length === 1,
  JSON.stringify(r.data.work.map((w) => `${w.type}:${w.amount_cents}`)));
const earnedBefore = r.data.earned_cents;
check('balance equals earned before any payment', r.data.balance_cents === earnedBefore && r.data.paid_cents === 0);

r = await sa.req('POST', `/api/compensation/${translatorId}/payments`, { amount_cents: 300, method: 'e-transfer' });
check('recording a payment lowers the balance', r.status === 201 &&
  r.data.paid_cents === 300 && r.data.balance_cents === earnedBefore - 300, JSON.stringify(r.data));

r = await sa.req('POST', `/api/compensation/${translatorId}/adjustments`, { amount_cents: 25, note: 'rounding bonus', project_id: compProj });
check('a positive adjustment raises the balance', r.status === 201 &&
  r.data.balance_cents === earnedBefore - 300 + 25, JSON.stringify(r.data));
r = await sa.req('POST', `/api/compensation/${translatorId}/adjustments`, { amount_cents: 25, project_id: compProj });
check('adjustment requires a note', r.status === 400);
r = await sa.req('POST', `/api/compensation/${translatorId}/adjustments`, { amount_cents: 25, note: 'no project' });
check('adjustment requires a project (org attribution)', r.status === 400);

r = await translator.req('GET', '/api/me/compensation');
check('translator sees their own totals', r.status === 200 &&
  r.data.balance_cents === earnedBefore - 300 + 25, JSON.stringify(r.data));

r = await member.req('GET', '/api/compensation');
check('non-superadmin cannot list compensation', r.status === 403);
r = await member.req('PUT', `/api/compensation/${translatorId}/rates`,
  { project_id: compProj, type: 'recording', rate_cents: 999 });
check('non-superadmin cannot set rates', r.status === 403);
r = await member.req('POST', `/api/compensation/${translatorId}/payments`, { amount_cents: 100 });
check('non-superadmin cannot record payments', r.status === 403);

// work logged before any rate is set is recorded at amount 0
const tr2Email = `rateless-${Date.now()}@test.ca`;
r = await sa.req('POST', `/api/projects/${compProj}/members`,
  { email: tr2Email, name: 'Rateless', password: 'rateless-pass-1', role: 'translator' });
const tr2Id = r.data.user_id;
const tr2 = client();
await tr2.req('POST', '/api/login', { email: tr2Email, password: 'rateless-pass-1' });
r = await sa.req('POST', '/api/entries', { project_id: compProj, kind: 'phrase', english_text: 'goodbye' });
const goodbyeId = r.data.id;
r = await tr2.req('POST', `/api/projects/${compProj}/work/claim`, { type: 'translation', limit: 20 });
const tr2Item = r.data.items.find((i) => i.entry.id === goodbyeId);
check('unrated translator can still claim work', !!tr2Item, JSON.stringify(r.data.items));
r = await tr2.req('POST', `/api/work/${tr2Item.work_item_id}/submit`, { dene_text: 'mahsi', english_text: 'goodbye' });
check('unrated translator can still work', r.status === 200, JSON.stringify(r.data));
r = await sa.req('GET', `/api/compensation/${tr2Id}`);
check('unrated work is logged at amount 0', r.status === 200 &&
  r.data.earned_cents === 0 && r.data.work.length === 1, JSON.stringify(r.data));

// Hardening #8: the rate is LOCKED at claim time. A change after a claim
// affects only future claims, never work already in someone's hands.
r = await sa.req('POST', '/api/entries', { project_id: compProj, kind: 'phrase', english_text: 'rate lock' });
const rateLockPhrase = r.data.id;
r = await translator.req('POST', `/api/projects/${compProj}/work/claim`, { type: 'translation', limit: 20 });
const lockedItem = r.data.items.find((i) => i.entry.id === rateLockPhrase);
await sa.req('PUT', `/api/compensation/${translatorId}/rates`, { project_id: compProj, type: 'translation', rate_cents: 50 });
r = await translator.req('POST', `/api/work/${lockedItem.work_item_id}/submit`, { dene_text: 'x', english_text: 'rate lock' });
check('claimed work still submits after a rate change', r.status === 200);
r = await sa.req('GET', `/api/compensation/${translatorId}`);
check('ledger shows the CLAIM-time rate (200), not the new rate (50)',
  r.data.work.some((w) => w.type === 'translation' && w.entry_id === rateLockPhrase && w.amount_cents === 200),
  JSON.stringify(r.data.work.map((w) => `${w.type}:${w.amount_cents}`)));
r = await sa.req('POST', '/api/entries', { project_id: compProj, kind: 'phrase', english_text: 'post-change' });
const postChangePhrase = r.data.id;
r = await translator.req('POST', `/api/projects/${compProj}/work/claim`, { type: 'translation', limit: 20 });
const postItem = r.data.items.find((i) => i.entry.id === postChangePhrase);
await translator.req('POST', `/api/work/${postItem.work_item_id}/submit`, { dene_text: 'y', english_text: 'post-change' });
r = await sa.req('GET', `/api/compensation/${translatorId}`);
check('a claim made after the change bills the new rate (50)',
  r.data.work.some((w) => w.type === 'translation' && w.entry_id === postChangePhrase && w.amount_cents === 50),
  JSON.stringify(r.data.work.map((w) => `${w.type}:${w.amount_cents}`)));

await sa.req('DELETE', `/api/projects/${compProj}`, { confirm_name: pname + ' Comp' });

// --- removal: immediate access loss, attribution kept ---
r = await sa.req('DELETE', `/api/projects/${projectId}/members/${memberId}`);
check('admin removes member', r.status === 200);

r = await member.req('GET', `/api/entries/${entryId}`);
check('removed member immediately loses access', r.status === 403, JSON.stringify(r.data));

r = await sa.req('GET', `/api/entries/${entryId}`);
check('past contribution still attributed', r.status === 200 && r.data.created_by_name === 'Test Member');

// --- user management (superadmin) ---
r = await member.req('GET', '/api/users');
check('member cannot list users', r.status === 403);

const mgmtEmail = `mgmt${Date.now()}@test.ca`;
r = await sa.req('POST', '/api/users', { email: mgmtEmail, name: 'Mgmt Test', password: 'first-pass-123' });
check('superadmin creates standalone account', r.status === 201, JSON.stringify(r.data));
const mgmtId = r.data?.user_id;

r = await sa.req('PATCH', `/api/users/${mgmtId}`, { password: 'second-pass-456' });
check('superadmin resets password', r.status === 200);

const mgmt = client();
r = await mgmt.req('POST', '/api/login', { email: mgmtEmail, password: 'second-pass-456' });
check('login works with reset password', r.status === 200);

r = await sa.req('PATCH', `/api/users/${mgmtId}`, { is_superadmin: true });
check('grant superadmin', r.status === 200);
r = await mgmt.req('GET', '/api/users');
check('promoted user can list users', r.status === 200);
r = await sa.req('PATCH', `/api/users/${mgmtId}`, { is_superadmin: false });
check('revoke superadmin', r.status === 200);

r = await sa.req('DELETE', `/api/users/${mgmtId}`);
check('delete account without contributions', r.status === 200);

r = await sa.req('DELETE', `/api/users/${memberId}`);
check('account with contributions cannot be deleted', r.status === 400, JSON.stringify(r.data));

// --- public translation requests ---
const requesterEmail = `requester${Date.now()}@test.ca`;
const anon = client();

r = await anon.req('POST', '/api/requests/start', { email: 'not-an-email' });
check('request start rejects invalid email', r.status === 400);

r = await anon.req('POST', '/api/requests/start', { email: requesterEmail });
check('request start issues form link (dev exposes it)', r.status === 200 &&
  typeof r.data.form_link === 'string', JSON.stringify(r.data));
const requestToken = r.data.form_link.split('/').pop();

r = await anon.req('GET', `/api/requests/form/${'0'.repeat(64)}`);
check('bogus form token rejected', r.status === 404);

r = await anon.req('GET', `/api/requests/form/${requestToken}`);
check('form preloads with fixed email', r.status === 200 &&
  r.data.email === requesterEmail && r.data.status === 'invited', JSON.stringify(r.data));

fd = new FormData();
fd.append('name', 'Pat Requester');
r = await anon.req('POST', `/api/requests/form/${requestToken}`, fd, true);
check('form requires name, dialect, details', r.status === 400);

fd = new FormData();
fd.append('name', 'Pat Requester');
fd.append('dialect', 'Tłı̨chǫ');
fd.append('details', 'Please translate the attached ceremony program.');
for (let i = 0; i < 6; i++) {
  fd.append('files', new Blob(['x'], { type: 'text/plain' }), `f${i}.txt`);
}
r = await anon.req('POST', `/api/requests/form/${requestToken}`, fd, true);
check('more than 5 files rejected', r.status === 400 && /at most 5/.test(r.data.error),
  JSON.stringify(r.data));

fd = new FormData();
fd.append('name', 'Pat Requester');
fd.append('dialect', 'Tłı̨chǫ');
fd.append('details', 'Please translate the attached ceremony program.');
fd.append('files', new Blob([makeWav(1)], { type: 'audio/wav' }), 'sample.wav');
fd.append('files', new Blob(['program text'], { type: 'text/plain' }), 'program.txt');
r = await anon.req('POST', `/api/requests/form/${requestToken}`, fd, true);
check('request form submits with 2 files', r.status === 200, JSON.stringify(r.data));

r = await anon.req('GET', `/api/requests/form/${requestToken}`);
check('form reports submitted', r.status === 200 && r.data.status === 'submitted');

fd = new FormData();
fd.append('name', 'Pat Again');
fd.append('dialect', 'x');
fd.append('details', 'y');
r = await anon.req('POST', `/api/requests/form/${requestToken}`, fd, true);
check('resubmission rejected', r.status === 400);

r = await member.req('GET', '/api/requests');
check('non-superadmin cannot list translation jobs', r.status === 403);

r = await sa.req('GET', '/api/requests');
const job = r.data?.requests?.find((x) => x.email === requesterEmail);
check('superadmin lists translation jobs', r.status === 200 && job &&
  job.status === 'submitted' && job.file_count === 2, JSON.stringify(r.data?.requests?.[0]));

r = await sa.req('GET', `/api/requests/${job.id}`);
check('job detail has fields and files', r.status === 200 && r.data.name === 'Pat Requester' &&
  r.data.dialect === 'Tłı̨chǫ' && r.data.files.length === 2, JSON.stringify(r.data));
const txtFile = r.data.files.find((f) => f.original_name === 'program.txt');

r = await sa.req('GET', `/api/requests/files/${txtFile.id}/download`);
check('superadmin downloads request file (forced attachment)', r.status === 200 &&
  /attachment/.test(r.headers.get('content-disposition') ?? ''),
  r.headers.get('content-disposition'));

r = await anon.req('GET', `/api/requests/files/${txtFile.id}/download`);
check('public cannot download request files', r.status === 401);

r = await sa.req('DELETE', `/api/requests/${job.id}`);
check('superadmin deletes translation job', r.status === 200);
r = await sa.req('GET', `/api/requests/${job.id}`);
check('deleted job is gone', r.status === 404);

// --- project editing (superadmin) ---
r = await member.req('PATCH', `/api/projects/${projectId}`, { name: 'Hacked' });
check('member cannot edit a project', r.status === 403);

r = await sa.req('PATCH', `/api/projects/${projectId}`,
  { name: pname + ' Renamed', dialect: 'Tłı̨chǫ', description: 'updated desc' });
check('superadmin edits name/dialect/description', r.status === 200 &&
  r.data.name === pname + ' Renamed' && r.data.dialect === 'Tłı̨chǫ' &&
  r.data.description === 'updated desc', JSON.stringify(r.data));

r = await sa.req('PATCH', `/api/projects/${projectId}`, { name: pname + ' B' });
check('rename to an existing project name rejected', r.status === 400, JSON.stringify(r.data));

r = await sa.req('PATCH', `/api/projects/${projectId}`, { name: pname });
check('rename back', r.status === 200 && r.data.name === pname);

// --- project deletion (superadmin, doubles as cleanup) ---
r = await member.req('DELETE', `/api/projects/${projectId}`, { confirm_name: pname });
check('member cannot delete a project', r.status === 403);

r = await sa.req('DELETE', `/api/projects/${projectId}`, { confirm_name: 'Wrong Name' });
check('wrong confirmation name rejected', r.status === 400, JSON.stringify(r.data));

r = await sa.req('DELETE', `/api/projects/${projectId}`, { confirm_name: pname });
// deleted_recordings counts ALL versions (current + superseded), so the member's
// dene v1 + v2 both count here (#8b keeps superseded masters until project delete).
check('superadmin deletes project (entries + all recording versions)', r.status === 200 &&
  r.data.deleted_entries === 11 && r.data.deleted_recordings === 2, JSON.stringify(r.data));

r = await sa.req('GET', `/api/entries/${entryId}`);
check('entries gone after project deletion', r.status === 404);

r = await sa.req('DELETE', `/api/projects/${projectB}`, { confirm_name: pname + ' B' });
check('second project deleted', r.status === 200);

r = await stranger.req('GET', '/api/projects');
// FLAT MODEL: the org membership survives project deletion — only the deleted
// projects disappear from the list.
check('deleted projects gone from the list (flat model)', r.status === 200 &&
  !r.data.projects.some((p) => p.id === projectId || p.id === projectB),
  JSON.stringify(r.data.projects?.map?.((p) => p.id)));



// --- organizations & platform/data separation (#5) ---
// (Placed last: creating a second org makes sa multi-org, so earlier
// organization_id-less project creations must already have run.)
r = await sa.req('GET', '/api/me');
check('superadmin holds an explicit owner_admin org grant',
  (r.data.orgs ?? []).some((o) => o.role === 'owner_admin'), JSON.stringify(r.data.orgs));

// A brand-new PLATFORM superadmin with no org grant has no corpus access.
const psEmail = `platform-${Date.now()}@test.ca`;
r = await sa.req('POST', '/api/users', { email: psEmail, name: 'Platform Only', password: 'platform-pass-1' });
const psId = r.data.user_id;
await sa.req('PATCH', `/api/users/${psId}`, { is_superadmin: true });
const ps = client();
await ps.req('POST', '/api/login', { email: psEmail, password: 'platform-pass-1' });
r = await ps.req('GET', '/api/projects');
check('platform admin without org grant sees no projects', r.status === 200 && r.data.projects.length === 0,
  JSON.stringify(r.data.projects?.length));
// a dedicated corpus project for the 403 probes (fresh installs have none left)
const sepProbeName = `Sep Probe ${Date.now()}`;
const anyProj = (await sa.req('POST', '/api/projects', { name: sepProbeName })).data;
// With zero visible projects, /entries short-circuits to an empty 200 — either
// way, no corpus content comes back.
r = await ps.req('GET', `/api/entries?project_id=${anyProj.id}`);
check('platform admin gets no entry content', r.status === 403 ||
  (r.status === 200 && r.data.total === 0 && r.data.entries.length === 0), JSON.stringify(r.data));
r = await ps.req('GET', `/api/projects/${anyProj.id}/stats`);
check('platform admin cannot read stats', r.status === 403);
r = await ps.raw('GET', `/api/projects/${anyProj.id}/export-bundle`);
check('platform admin cannot export the corpus', r.status === 403);
await sa.req('DELETE', `/api/projects/${anyProj.id}`, { confirm_name: sepProbeName });
r = await ps.req('GET', '/api/compensation');
check('platform admin cannot read compensation', r.status === 403);
r = await ps.req('POST', '/api/projects', { name: `No Org ${Date.now()}` });
check('platform admin cannot create projects without an org', r.status === 403);
r = await ps.req('GET', '/api/users');
check('platform admin CAN manage accounts', r.status === 200);
r = await ps.req('GET', '/api/requests');
check('platform admin CAN see translation-service requests', r.status === 200);

// Org lifecycle: provision a fresh org, delegate an org admin, revoke.
r = await sa.req('POST', '/api/orgs', { name: `Test Nation ${Date.now()}` });
check('superadmin provisions an organization (becoming its owner)', r.status === 201, JSON.stringify(r.data));
const orgId = r.data.id;
r = await sa.req('DELETE', `/api/orgs/${orgId}/members/${(await sa.req('GET', '/api/me')).data.user.id}`);
check('the last owner cannot be removed', r.status === 400);

const oaEmail = `orgadmin-${Date.now()}@test.ca`;
r = await sa.req('POST', '/api/users', { email: oaEmail, name: 'Org Admin', password: 'orgadmin-pass-1' });
const oaId = r.data.user_id;
r = await sa.req('POST', `/api/orgs/${orgId}/members`, { email: oaEmail, role: 'admin' });
check('owner adds an org admin', r.status === 201);
const oa = client();
await oa.req('POST', '/api/login', { email: oaEmail, password: 'orgadmin-pass-1' });
const orgProjName = `Org Project ${Date.now()}`;
r = await oa.req('POST', '/api/projects', { name: orgProjName });
check('org admin creates a project (sole-org default)', r.status === 201, JSON.stringify(r.data));
const orgProjId = r.data?.id;
check('project belongs to the org', r.data?.organization_id === orgId, JSON.stringify(r.data?.organization_id));
// FLAT MODEL: 'admin' is an org-level role and owner-only to grant; org
// admins delegate by managing members and translators.
const paEmail = `projadmin-${Date.now()}@test.ca`;
r = await oa.req('POST', `/api/projects/${orgProjId}/members`, { email: paEmail, name: 'Proj Admin', password: 'projadmin-pass-1', role: 'admin' });
check('a non-owner cannot grant the admin role (flat model)', r.status === 403, JSON.stringify(r.data));
r = await oa.req('POST', `/api/projects/${orgProjId}/members`, { email: paEmail, name: 'Proj Admin', password: 'projadmin-pass-1', role: 'member' });
check('an org admin can add a member (flat model)', r.status === 201, JSON.stringify(r.data));
r = await oa.req('POST', `/api/orgs/${orgId}/members`, { email: paEmail, role: 'translator' });
check('an org admin can manage member/translator roles', r.status === 201, JSON.stringify(r.data));
r = await oa.req('POST', `/api/orgs/${orgId}/members`, { email: paEmail, role: 'admin' });
check('an org admin cannot grant admin/owner roles (owner-only)', r.status === 403, r.status);
r = await member.req('GET', `/api/orgs/${orgId}/members`);
check('ordinary member cannot read org membership', r.status === 403);

// Multi-org ambiguity: sa now administers two orgs.
r = await sa.req('POST', '/api/projects', { name: `Ambiguous ${Date.now()}` });
check('multi-org admin must specify organization_id', r.status === 400);

// --- multi-org COMPENSATION isolation (hardening #1) ---
// The main-org translator earns in Org2 too; each org's admin must see only
// their own slice. sa administers both orgs, so a dedicated org1-only admin is
// the isolated viewer for Org1.
const o1aEmail = `org1admin-${Date.now()}@test.ca`;
r = await sa.req('POST', '/api/users', { email: o1aEmail, name: 'Org1 Admin', password: 'org1admin-pass-1' });
const o1aId = r.data.user_id;
const mainOrg = (await sa.req('GET', '/api/me')).data.orgs.find((o) => o.id !== orgId);
await sa.req('POST', `/api/orgs/${mainOrg.id}/members`, { email: o1aEmail, role: 'admin' });
const o1a = client();
await o1a.req('POST', '/api/login', { email: o1aEmail, password: 'org1admin-pass-1' });

// translator (main-org history from the comp block) now works in Org2.
await oa.req('POST', `/api/projects/${orgProjId}/members`, { email: translatorEmail, role: 'translator' });
r = await oa.req('PUT', `/api/compensation/${translatorId}/rates`, { project_id: orgProjId, type: 'translation', rate_cents: 700 });
check('org2 admin sets an org2 rate', r.status === 200, JSON.stringify(r.data));
r = await oa.req('POST', '/api/entries', { project_id: orgProjId, kind: 'phrase', english_text: 'org2 phrase' });
const org2Phrase = r.data.id;
r = await translator.req('POST', `/api/projects/${orgProjId}/work/claim`, { type: 'translation', limit: 20 });
const org2Item = r.data.items.find((i) => i.entry.id === org2Phrase);
r = await translator.req('POST', `/api/work/${org2Item.work_item_id}/submit`, { dene_text: 'x2', english_text: 'org2 phrase' });
check('translator completes org2 work', r.status === 200);
r = await oa.req('POST', `/api/compensation/${translatorId}/payments`, { amount_cents: 100 });
check('org2 admin records an org2 payment', r.status === 201, JSON.stringify(r.data));

// Project names are unique PER ORGANIZATION — two orgs can both have "Winter Words".
const crossName = `Cross Name ${Date.now()}`;
r = await sa.req('POST', '/api/projects', { name: crossName, organization_id: mainOrg.id });
check('org1 creates the shared-name project', r.status === 201, JSON.stringify(r.data));
const crossOrg1 = r.data.id;
r = await oa.req('POST', '/api/projects', { name: crossName });
check('a different org can reuse the same project name', r.status === 201, JSON.stringify(r.data));
const crossOrg2 = r.data.id;
r = await oa.req('POST', '/api/projects', { name: crossName });
check('duplicate name within the SAME org still rejected', r.status === 400, JSON.stringify(r.data));
await sa.req('DELETE', `/api/projects/${crossOrg1}`, { confirm_name: crossName });
await sa.req('DELETE', `/api/projects/${crossOrg2}`, { confirm_name: crossName });

r = await oa.req('GET', `/api/compensation/${translatorId}`);
check('org2 admin sees ONLY org2 work', r.status === 200 &&
  r.data.work.length === 1 && r.data.work[0].amount_cents === 700, JSON.stringify(r.data.work));
check('org2 admin sees ONLY org2 totals/payments/rates/projects',
  r.data.earned_cents === 700 && r.data.paid_cents === 100 &&
  r.data.payments.length === 1 && r.data.rates.length === 1 &&
  r.data.projects.every((p) => p.id === orgProjId), JSON.stringify({ e: r.data.earned_cents, p: r.data.paid_cents }));

r = await o1a.req('GET', `/api/compensation/${translatorId}`);
check('org1 admin sees NO org2 rows', r.status === 200 &&
  r.data.work.every((w) => w.amount_cents !== 700) && r.data.payments.every((p) => p.amount_cents !== 100),
  JSON.stringify({ work: r.data.work.length, pay: r.data.payments.length }));
check('org1 admin totals exclude org2', r.data.earned_cents !== 700 && r.data.paid_cents === 300,
  JSON.stringify({ e: r.data.earned_cents, p: r.data.paid_cents }));

r = await translator.req('GET', '/api/me/compensation');
check('contributor /me stays GLOBAL across orgs',
  r.data.work.some((w) => w.amount_cents === 700) && r.data.paid_cents === 400,
  JSON.stringify({ e: r.data.earned_cents, p: r.data.paid_cents }));

r = await oa.req('GET', `/api/compensation/${tr2Id}`);
check('org2 admin gets 403 on an org1-only contributor', r.status === 403, JSON.stringify(r.data));
r = await oa.req('GET', '/api/compensation');
check('org2 compensation list excludes org1-only people', r.status === 200 &&
  !r.data.translators.some((t) => t.id === tr2Id) && r.data.translators.some((t) => t.id === translatorId),
  JSON.stringify(r.data.translators.map((t) => t.id)));

// isolation cleanup: drop the org1 admin grant (org2 teardown happens below)
await sa.req('DELETE', `/api/orgs/${mainOrg.id}/members/${o1aId}`);

// Revoking the org grant ends corpus authority immediately.
await sa.req('DELETE', `/api/orgs/${orgId}/members/${oaId}`);
r = await oa.req('GET', `/api/entries?project_id=${orgProjId}`);
check('removed org admin loses corpus access immediately', r.status === 403 ||
  (r.status === 200 && r.data.total === 0 && r.data.entries.length === 0), JSON.stringify(r.data));
r = await oa.req('GET', `/api/projects/${orgProjId}/stats`);
check('removed org admin gets 403 on scoped reads', r.status === 403);
r = await oa.req('POST', '/api/projects', { name: `After Removal ${Date.now()}` });
check('removed org admin cannot create projects', r.status === 403);

// clean up: sa owns the fresh org, so it can delete the org project, then the
// (now empty) org itself — restoring sa to a single admin org so the suite is
// repeatable without organization_id everywhere.
r = await sa.req('DELETE', `/api/orgs/${orgId}`);
check('an org owning projects cannot be deleted', r.status === 400);
r = await sa.req('DELETE', `/api/projects/${orgProjId}`, { confirm_name: orgProjName });
check('org owner deletes the org project (cleanup)', r.status === 200, JSON.stringify(r.data));
r = await sa.req('DELETE', `/api/orgs/${orgId}`);
check('empty org deleted (cleanup restores single-org state)', r.status === 200, JSON.stringify(r.data));

// --- consent & permitted use (#6) ---
// STORE-mode zips carry text files uncompressed, so manifest fields are directly
// searchable in the response buffer — deep assertions without unzipping.
const zipHas = (z, s) => z.buf.toString('latin1').includes(s);
r = await sa.req('POST', `/api/orgs/${mainOrgId}/consent-profiles`, {
  name: `Edu+ASR ${Date.now()}`, allow_language_learning: true, allow_asr_training: true, allow_research: true,
});
check('org admin creates a consent profile', r.status === 201 && r.data.allow_asr_training === 1 &&
  r.data.allow_tts_training === 0, JSON.stringify(r.data));
const profId = r.data.id;
const profName = r.data.name;

const cpName = `Consent Test ${Date.now()}`;
r = await sa.req('POST', '/api/projects', { name: cpName });
const cpId = r.data.id;
r = await sa.req('POST', '/api/entries', { project_id: cpId, dene_text: 'tł’ok’ale', english_text: 'grass' });
const cpEntry = r.data.id;

// (2)+(5) consent-unknown: in the owner archive, excluded from purpose exports —
// permission is never inferred from access or visibility.
fd = new FormData(); fd.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'unknown.wav'); fd.append('language', 'dene');
const r1 = (await sa.req('POST', `/api/entries/${cpEntry}/audio`, fd, true)).data;
check('recording without a default profile is consent-unknown', r1.consent_profile_name === null, JSON.stringify(r1.consent_profile_name));
let zFull = await sa.raw('GET', `/api/projects/${cpId}/export-bundle`);
check('owner archive includes the consent-unknown recording', zipHas(zFull, '"recording_count": 1') && zipHas(zFull, '"consent_unknown": 1'));
let zAsr = await sa.raw('GET', `/api/projects/${cpId}/export-bundle?purpose=asr`);
check('purpose export excludes consent-unknown (no inference)', zipHas(zAsr, '"recording_count": 0') && zipHas(zAsr, '"permission_filter": "asr"'), zAsr.status);
r = await sa.raw('GET', `/api/projects/${cpId}/export-bundle?purpose=nonsense`);
check('unknown purpose rejected', r.status === 400);

// (1) default profile stamps a snapshot on new recordings; later profile edits
// don't rewrite it.
r = await sa.req('PUT', `/api/projects/${cpId}/consent-default`, { profile_id: profId });
check('project default consent profile set', r.status === 200);
r = await sa.req('POST', '/api/entries', { project_id: cpId, dene_text: 'sas', english_text: 'bear' });
const cpEntry2 = r.data.id;
fd = new FormData(); fd.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'stamped.wav'); fd.append('language', 'dene');
const r2 = (await sa.req('POST', `/api/entries/${cpEntry2}/audio`, fd, true)).data;
check('new recording carries the consent snapshot', r2.consent_profile_name === profName &&
  r2.allow_asr_training === 1 && r2.allow_tts_training === 0 && r2.consent_method === 'project_default_profile',
  JSON.stringify({ p: r2.consent_profile_name, asr: r2.allow_asr_training }));
await sa.req('PATCH', `/api/consent-profiles/${profId}`, { allow_asr_training: false, allow_tts_training: true });
r = await sa.req('GET', `/api/entries/${cpEntry2}`);
const snap = r.data.audio.find((a) => a.id === r2.id);
check('editing the profile does not rewrite the snapshot', snap.allow_asr_training === 1 && snap.allow_tts_training === 0,
  JSON.stringify({ asr: snap.allow_asr_training, tts: snap.allow_tts_training }));
await sa.req('PATCH', `/api/consent-profiles/${profId}`, { allow_asr_training: true, allow_tts_training: false });

// (3) bulk-assign stamps only consent-unknown rows, audited; purpose export
// then includes them.
r = await sa.req('POST', `/api/projects/${cpId}/consent/assign`, { profile_id: profId });
check('bulk assign stamps the consent-unknown recording only', r.status === 200 && r.data.assigned === 1, JSON.stringify(r.data));
zAsr = await sa.raw('GET', `/api/projects/${cpId}/export-bundle?purpose=asr`);
check('purpose export now includes both consented recordings', zipHas(zAsr, '"recording_count": 2'));
check('audit trail is in permissions.json', zipHas(zAsr, '"action": "assign"'));

// (4) revocation: org-admin only, audited; drops from purpose exports, stays in
// the owner archive flagged.
await sa.req('POST', `/api/projects/${cpId}/members`, { email: memberEmail, role: 'member' });
r = await member.req('POST', `/api/audio/${r1.id}/revoke`, { note: 'nope' });
check('project member cannot revoke consent', r.status === 403);
r = await sa.req('POST', `/api/audio/${r1.id}/revoke`, { note: 'speaker withdrew consent' });
check('org admin revokes a recording', r.status === 200 && !!r.data.revoked_at, JSON.stringify(r.data.revoked_at));
r = await sa.req('POST', `/api/audio/${r1.id}/revoke`, {});
check('double revoke rejected', r.status === 400);
zAsr = await sa.raw('GET', `/api/projects/${cpId}/export-bundle?purpose=asr`);
check('revoked recording drops out of purpose exports', zipHas(zAsr, '"recording_count": 1') && zipHas(zAsr, '"revoked": 1'));
zFull = await sa.raw('GET', `/api/projects/${cpId}/export-bundle`);
check('owner archive keeps the revoked recording, flagged + audited',
  zipHas(zFull, '"recording_count": 2') && zipHas(zFull, '"action": "revoke"'));

// --- archival correctness (hardening 4, 9, 6) ---
// #9: sha256 exists at INGESTION and matches the actual bytes.
r = await sa.req('GET', `/api/entries/${cpEntry2}`);
const shaRec = r.data.audio[0];
check('sha256 present at ingestion', /^[0-9a-f]{64}$/.test(shaRec.sha256 ?? ''), JSON.stringify(shaRec.sha256));
{
  const m = await sa.raw('GET', `/api/audio/${shaRec.id}/master`);
  const crypto = await import('node:crypto');
  const rehash = crypto.createHash('sha256').update(m.buf).digest('hex');
  check('stored sha256 matches the master bytes', rehash === shaRec.sha256, `${rehash} vs ${shaRec.sha256}`);
}

// #4: archive_class comes from the probed codec, not the filename/route.
check('WAV upload classified lossless_master', shaRec.archive_class === 'lossless_master', shaRec.archive_class);
r = await sa.req('POST', '/api/entries', { project_id: cpId, dene_text: 'łue', english_text: 'fish' });
const lossyEntry = r.data.id;
fd = new FormData();
fd.append('file', new Blob([makeMp3()], { type: 'audio/mpeg' }), 'historical.mp3');
fd.append('language', 'dene');
r = await sa.req('POST', `/api/entries/${lossyEntry}/audio`, fd, true);
check('MP3 upload accepted but classified lossy_source', r.status === 201 && r.data.archive_class === 'lossy_source',
  JSON.stringify({ s: r.status, c: r.data.archive_class, codec: r.data.codec }));
check('lossy upload still gets an ingestion sha256', /^[0-9a-f]{64}$/.test(r.data.sha256 ?? ''));
const lossyStored = r.data.stored_name;

// #6: the OWNER archive contains every retained version with lineage; purpose
// exports stay current-only.
const v1Stored = r2.stored_name; // cpEntry2's first (superseded soon) version
fd = new FormData();
fd.append('file', new Blob([makeWav(2)], { type: 'audio/wav' }), 'v2.wav');
fd.append('language', 'dene');
const v2 = (await sa.req('POST', `/api/entries/${cpEntry2}/audio`, fd, true)).data;
check('re-record supersedes for the version test', v2.replaced === true && v2.supersedes_audio_id === shaRec.id);
zFull = await sa.raw('GET', `/api/projects/${cpId}/export-bundle`);
check('owner archive contains the superseded master', zipHas(zFull, v1Stored), v1Stored);
check('owner archive contains the current master', zipHas(zFull, v2.stored_name));
check('owner archive carries version lineage', zipHas(zFull, '"is_current": false') && zipHas(zFull, '"supersedes_audio_id": ' + shaRec.id));
check('owner archive labels the lossy source', zipHas(zFull, lossyStored) && zipHas(zFull, '"lossy_source"'));
check('owner archive counts superseded versions', zipHas(zFull, '"superseded_version_count": 1'));
zAsr = await sa.raw('GET', `/api/projects/${cpId}/export-bundle?purpose=asr`);
check('purpose export excludes superseded versions', !zipHas(zAsr, v1Stored));

// --- consent inheritance on re-record (hardening #7) ---
// A new take is NOT a new consent event: v2 above must carry v1's snapshot as
// 'inherited', and a changed project default must not silently expand it.
r = await sa.req('GET', `/api/entries/${cpEntry2}`);
let curTake = r.data.audio[0];
check('re-record inherited the prior consent snapshot', curTake.consent_profile_name === profName &&
  curTake.consent_method === 'inherited', JSON.stringify({ p: curTake.consent_profile_name, m: curTake.consent_method }));
r = await sa.req('POST', `/api/orgs/${mainOrgId}/consent-profiles`, { name: `TTS-OK ${Date.now()}`, allow_tts_training: true });
const ttsProfId = r.data.id;
await sa.req('PUT', `/api/projects/${cpId}/consent-default`, { profile_id: ttsProfId });
fd = new FormData(); fd.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'v3.wav'); fd.append('language', 'dene');
await sa.req('POST', `/api/entries/${cpEntry2}/audio`, fd, true);
r = await sa.req('GET', `/api/entries/${cpEntry2}`);
curTake = r.data.audio[0];
check('re-record under a new TTS-allowing default stays NOT TTS-approved',
  curTake.allow_tts_training === 0 && curTake.consent_profile_name === profName && curTake.consent_method === 'inherited',
  JSON.stringify({ tts: curTake.allow_tts_training, p: curTake.consent_profile_name }));
r = await sa.req('POST', '/api/entries', { project_id: cpId, dene_text: 'sah', english_text: 'bear (black)' });
const firstTakeEntry = r.data.id;
fd = new FormData(); fd.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'first.wav'); fd.append('language', 'dene');
r = await sa.req('POST', `/api/entries/${firstTakeEntry}/audio`, fd, true);
check('a FIRST take under the new default gets the new consent (explicit basis)',
  r.data.allow_tts_training === 1 && r.data.consent_method === 'project_default_profile', JSON.stringify(r.data.consent_profile_name));
// consent-unknown also inherits: first take with no default stays unknown even
// after a default is set and the slot is re-recorded.
await sa.req('PUT', `/api/projects/${cpId}/consent-default`, { profile_id: null });
r = await sa.req('POST', '/api/entries', { project_id: cpId, dene_text: 'tthę', english_text: 'star' });
const unknownEntry = r.data.id;
fd = new FormData(); fd.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'u1.wav'); fd.append('language', 'dene');
r = await sa.req('POST', `/api/entries/${unknownEntry}/audio`, fd, true);
check('first take with no default is consent-unknown', r.data.consent_profile_name === null);
await sa.req('PUT', `/api/projects/${cpId}/consent-default`, { profile_id: ttsProfId });
fd = new FormData(); fd.append('file', new Blob([makeWav(2)], { type: 'audio/wav' }), 'u2.wav'); fd.append('language', 'dene');
r = await sa.req('POST', `/api/entries/${unknownEntry}/audio`, fd, true);
check('re-record of a consent-unknown slot STAYS consent-unknown (no silent expansion)',
  r.data.consent_profile_name === null && r.data.allow_tts_training === null, JSON.stringify(r.data.consent_profile_name));
r = await sa.req('DELETE', `/api/consent-profiles/${ttsProfId}`);
check('tts test profile deleted (cleanup)', r.status === 200);

// cleanup: project then profile (suite stays repeatable; snapshots die with the project)
await sa.req('DELETE', `/api/projects/${cpId}`, { confirm_name: cpName });
r = await sa.req('DELETE', `/api/consent-profiles/${profId}`);
check('consent profile deleted (cleanup)', r.status === 200);

// --- hashed session tokens (hardening #10) ---
// Local-only: inspect the same SQLite file the server uses (dev DB, or the
// runner's DENE_DATA_DIR temp DB) to prove the raw cookie token is never at rest.
if (BASE.includes('localhost')) {
  try {
    const { default: db } = await import('../src/db.js');
    const res = await fetch(BASE + '/api/platform/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SA_EMAIL, password: SA_PASS }),
    });
    const rawToken = /dene_session=([a-f0-9]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
    check('login sets a raw session token cookie', !!rawToken && rawToken.length === 64);
    check('raw token is NOT stored in the database',
      !db.prepare('SELECT 1 FROM sessions WHERE token = ?').get(rawToken));
    const cryptoMod = await import('node:crypto');
    const hashed = cryptoMod.createHash('sha256').update(rawToken).digest('hex');
    check('hashed token IS stored and resolves the session',
      !!db.prepare('SELECT 1 FROM sessions WHERE token = ?').get(hashed));
    const me = await fetch(BASE + '/api/platform/me', { headers: { Cookie: `dene_session=${rawToken}` } });
    check('cookie with the raw token authenticates via hashed lookup', me.status === 200);
    const bogus = await fetch(BASE + '/api/platform/me', { headers: { Cookie: `dene_session=${'0'.repeat(64)}` } });
    check('a random token fails', bogus.status === 401);
    await fetch(BASE + '/api/platform/logout', { method: 'POST', headers: { Cookie: `dene_session=${rawToken}` } });
    check('logout deletes the hashed session row',
      !db.prepare('SELECT 1 FROM sessions WHERE token = ?').get(hashed));
  } catch (e) {
    check('hashed-session DB inspection ran', false, e.message);
  }
}

// --- password change terminates other sessions ---
{
  const pwEmail = `pwsess-${Date.now()}@test.ca`;
  r = await sa.req('POST', '/api/users', { email: pwEmail, name: 'Pw Sess', password: 'pwsess-pass-1' });
  const s1 = client(), s2 = client();
  await s1.req('POST', '/api/login', { email: pwEmail, password: 'pwsess-pass-1' });
  await s2.req('POST', '/api/login', { email: pwEmail, password: 'pwsess-pass-1' });
  check('both sessions live before the change', (await s2.req('GET', '/api/me')).status === 200);
  r = await s1.req('POST', '/api/me/password', { current_password: 'pwsess-pass-1', new_password: 'pwsess-pass-2' });
  check('password change succeeds', r.status === 200, JSON.stringify(r.data));
  check('the session that changed the password stays signed in', (await s1.req('GET', '/api/me')).status === 200);
  check('other sessions are terminated by the password change', (await s2.req('GET', '/api/me')).status === 401);
  r = await s2.req('POST', '/api/login', { email: pwEmail, password: 'pwsess-pass-2' });
  check('other device signs back in with the NEW password', r.status === 200);
}

// --- Indigenous.ai application entitlement (organization_apps) ---
{
  const entEmail = `ent-${Date.now()}@test.ca`;
  r = await sa.req('POST', '/api/users', { email: entEmail, name: 'Ent User', password: 'ent-pass-1234' });
  check('entitlement test user created', r.status === 201 || r.status === 200, JSON.stringify(r.data));
  const entOrgName = `Ent Org ${Date.now()}`;
  r = await sa.req('POST', '/api/orgs', { name: entOrgName });
  check('entitlement test org created (language auto-enabled)', r.status === 201, JSON.stringify(r.data));
  const entOrgId = r.data.id;
  r = await sa.req('POST', `/api/orgs/${entOrgId}/members`, { email: entEmail, role: 'member' });
  const entUserId = r.data.user_id;
  const ent = client();
  await ent.req('POST', '/api/login', { email: entEmail, password: 'ent-pass-1234' });
  r = await ent.req('GET', '/api/projects');
  check('language routes work while the app is enabled', r.status === 200, r.status);
  r = await sa.req('GET', '/api/admin/orgs');
  check('superadmin org roster lists every org with counts and entitlement status',
    r.status === 200 && r.data.orgs.some((o) => o.id === entOrgId && o.language_status === 'enabled'
      && o.member_count === 2), JSON.stringify(r.data.orgs?.find?.((o) => o.id === entOrgId)));
  r = await ent.req('GET', '/api/admin/orgs');
  check('the org roster is superadmin-only', r.status === 403, r.status);
  r = await sa.req('PUT', `/api/orgs/${entOrgId}/apps/language`, { status: 'disabled' });
  check('superadmin can disable an app for an org', r.status === 200 && r.data.status === 'disabled', JSON.stringify(r.data));
  r = await ent.req('GET', '/api/projects');
  check('language routes 403 once the org has the app disabled', r.status === 403, r.status);
  r = await ent.req('GET', '/api/me');
  check('platform routes still work with the app disabled', r.status === 200, r.status);
  r = await sa.req('GET', '/api/projects');
  check('superadmin passes the entitlement gate (platform operation)', r.status === 200, r.status);
  r = await sa.req('PUT', `/api/orgs/${entOrgId}/apps/language`, { status: 'enabled' });
  check('re-enabling the app restores access', r.status === 200 && r.data.status === 'enabled');
  r = await ent.req('GET', '/api/projects');
  check('language routes work again after re-enable', r.status === 200, r.status);
  // cleanup: org (sa is its owner_admin), then the user
  r = await sa.req('DELETE', `/api/orgs/${entOrgId}`);
  check('entitlement test org deleted (cleanup)', r.status === 200, JSON.stringify(r.data));
  r = await sa.req('DELETE', `/api/users/${entUserId}`);
  check('entitlement test user deleted (cleanup)', r.status === 200, JSON.stringify(r.data));
}

// --- speakers & recording sessions (plan §7/§8) ---
// Local-only (cleans up org-wide speaker rows directly in SQLite).
if (BASE.includes('localhost')) {
  try {
    const { default: db } = await import('../src/db.js');
    const spkProjName = `Spk ${Date.now()}`;
    r = await sa.req('POST', '/api/projects', { name: spkProjName, dialect: 'Dëne Sųłıné' });
    const spkProj = r.data.id;
    r = await sa.req('POST', '/api/entries', {
      project_id: spkProj, kind: 'word', dene_text: 'setsıé', english_text: 'my grandfather',
    });
    const spkEntry = r.data.id;

    // A speaker who has NO user account.
    r = await sa.req('POST', `/api/projects/${spkProj}/speakers`, { display_name: 'Elder Mary' });
    check('a speaker can be registered without any user account', r.status === 201 && r.data.user_id === null);
    const mary = r.data.id;
    r = await sa.req('GET', `/api/projects/${spkProj}/speakers`);
    check('speakers list shows the new speaker', r.data.speakers.some((s) => s.id === mary));

    // Facilitator (sa) records Elder Mary through a session.
    r = await sa.req('POST', `/api/projects/${spkProj}/recording-sessions`,
      { speaker_id: mary, capture_device: 'Test Mic' });
    check('recording session starts with the chosen speaker', r.status === 201 && r.data.speaker_name === 'Elder Mary');
    const spkSession = r.data.id;
    let fd = new FormData();
    fd.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'mary.wav');
    fd.append('language', 'dene');
    fd.append('recording_session_id', String(spkSession));
    r = await sa.req('POST', `/api/entries/${spkEntry}/audio`, fd, true);
    check('recording saved through the session carries speaker + session + device',
      r.data.speaker_id === mary && r.data.recording_session_id === spkSession &&
      r.data.capture_device === 'Test Mic', JSON.stringify(r.data.speaker_id));
    r = await sa.req('GET', `/api/entries/${spkEntry}`);
    const maryAudio = r.data.audio.find((a) => a.language === 'dene');
    check('provenance keeps BOTH the speaker and the uploader/facilitator',
      maryAudio.speaker_name === 'Elder Mary' && maryAudio.uploaded_by_name !== 'Elder Mary');

    // Without a session the voice defaults to the uploader's own self-speaker.
    fd = new FormData();
    fd.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'self.wav');
    fd.append('language', 'english');
    r = await sa.req('POST', `/api/entries/${spkEntry}/audio`, fd, true);
    const selfSpeaker = db.prepare('SELECT user_id FROM speakers WHERE id = ?').get(r.data.speaker_id);
    check('a sessionless upload is attributed to the uploader\'s self-speaker',
      r.data.speaker_id && selfSpeaker?.user_id !== null && r.data.recording_session_id === null);

    // Ending the session closes the metadata window.
    r = await sa.req('POST', `/api/recording-sessions/${spkSession}/end`);
    check('ending a session stamps ended_at', r.status === 200 && !!r.data.ended_at);
    fd = new FormData();
    fd.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'late.wav');
    fd.append('language', 'dene');
    fd.append('recording_session_id', String(spkSession));
    r = await sa.req('POST', `/api/entries/${spkEntry}/audio`, fd, true);
    check('uploads against an ended session are rejected', r.status === 400, r.status);

    // Linking a speaker to an account later (org admin), and the one-self-
    // speaker-per-org guard.
    const linkEmail = `spk-link-${Date.now()}@test.ca`;
    await sa.req('POST', '/api/users', { email: linkEmail, name: 'Linked Speaker', password: 'spk-pass-1234' });
    r = await sa.req('PATCH', `/api/speakers/${mary}`, { user_email: linkEmail });
    check('a speaker can later be linked to a user account', r.status === 200 && r.data.user_id !== null);
    r = await sa.req('POST', `/api/projects/${spkProj}/speakers`, { display_name: 'Duplicate Link' });
    const dup = r.data.id;
    r = await sa.req('PATCH', `/api/speakers/${dup}`, { user_email: linkEmail });
    check('an account cannot back two speakers in one organization', r.status === 400, r.status);

    // Sweep: every recording in the whole suite (migrated + new) has a speaker.
    check('invariant: no recording is missing its speaker',
      db.prepare('SELECT COUNT(*) n FROM audio_files WHERE speaker_id IS NULL').get().n === 0);

    // cleanup: project (audio cascades), then the speaker/user rows.
    await sa.req('DELETE', `/api/projects/${spkProj}`, { confirm_name: spkProjName });
    const linkedUser = db.prepare('SELECT id FROM users WHERE email = ?').get(linkEmail);
    db.prepare('DELETE FROM speakers WHERE id IN (?, ?)').run(mary, dup);
    await sa.req('DELETE', `/api/users/${linkedUser.id}`);
    check('speakers cleanup complete',
      !db.prepare('SELECT 1 FROM speakers WHERE id IN (?, ?)').get(mary, dup));
  } catch (e) {
    check('speakers block ran', false, e.stack || e.message);
  }
}

// --- resource-level entitlement isolation (two-fixes §1) ---
// A user in Org A (Language enabled) AND Org B (disabled) must reach A's
// resources and be shut out of B's — an entitlement anywhere never authorizes
// another org's data. Local-only (missing-row case pokes SQLite directly).
if (BASE.includes('localhost')) {
  try {
    const { default: db } = await import('../src/db.js');
    const ts = Date.now();
    r = await sa.req('POST', '/api/orgs', { name: `EntIso A ${ts}` });
    const orgA = r.data.id;
    r = await sa.req('POST', '/api/orgs', { name: `EntIso B ${ts}` });
    const orgB = r.data.id;
    r = await sa.req('POST', '/api/projects', { name: `EntIso ProjA ${ts}`, organization_id: orgA });
    const projA = r.data.id;
    r = await sa.req('POST', '/api/projects', { name: `EntIso ProjB ${ts}`, organization_id: orgB });
    const projB = r.data.id;
    r = await sa.req('POST', '/api/entries', { project_id: projA, kind: 'phrase', dene_text: 'A-side' });
    const entryA = r.data.id;
    r = await sa.req('POST', '/api/entries', { project_id: projB, kind: 'phrase', dene_text: 'B-side' });
    const entryB = r.data.id;
    const isoEmail = `iso-${ts}@test.ca`;
    await sa.req('POST', `/api/projects/${projA}/members`, { email: isoEmail, name: 'Iso User', password: 'iso-pass-1234' });
    await sa.req('POST', `/api/projects/${projB}/members`, { email: isoEmail });
    const iso = client();
    await iso.req('POST', '/api/login', { email: isoEmail, password: 'iso-pass-1234' });

    r = await sa.req('PUT', `/api/orgs/${orgB}/apps/language`, { status: 'disabled' });
    check('iso: Org B Language disabled', r.status === 200);

    r = await iso.req('GET', '/api/projects');
    check('iso: project list keeps Org A, excludes disabled Org B',
      r.data.projects.some((p) => p.id === projA) && !r.data.projects.some((p) => p.id === projB));
    r = await iso.req('GET', '/api/entries');
    check('iso: entry list excludes the disabled org\'s entries',
      r.data.entries.some((e) => e.id === entryA) && !r.data.entries.some((e) => e.id === entryB));
    r = await iso.req('GET', `/api/entries/${entryB}`);
    check('iso: disabled-org entry detail is 403', r.status === 403, r.status);
    r = await iso.req('GET', `/api/entries/${entryA}`);
    check('iso: enabled-org entry detail stays accessible', r.status === 200, r.status);
    r = await iso.req('GET', `/api/entries?project_id=${projB}`);
    check('iso: disabled-org project filter is rejected', r.status === 403, r.status);
    r = await iso.req('GET', '/api/corpora');
    check('iso: the collection list excludes disabled orgs',
      r.data.corpora.every((c) => c.organization_id !== orgB), JSON.stringify(r.data.corpora?.map?.((c) => c.organization_id)));
    r = await iso.req('POST', `/api/projects/${projB}/work/claim`, { type: 'translation', limit: 5 });
    check('iso: disabled-org work claim is 403', r.status === 403, r.status);
    r = await iso.req('POST', `/api/projects/${projA}/work/claim`, { type: 'translation', limit: 5 });
    check('iso: enabled-org work claim still works', r.status === 200, r.status);
    for (const it of r.data.items ?? []) await iso.req('POST', `/api/work/${it.work_item_id}/release`, {});
    r = await iso.req('GET', `/api/projects/${projB}/stats`);
    check('iso: disabled-org stats are 403', r.status === 403, r.status);
    r = await sa.raw('GET', `/api/projects/${projB}/export-bundle`);
    check('iso: disabled-org export is forbidden even for a superadmin org-admin', r.status === 403, r.status);
    r = await iso.req('GET', '/api/me');
    check('iso: platform routes are untouched by app entitlement', r.status === 200);

    // Re-enable B: normal roles resume. Then disable A: isolation flips.
    await sa.req('PUT', `/api/orgs/${orgB}/apps/language`, { status: 'enabled' });
    r = await iso.req('GET', `/api/entries/${entryB}`);
    check('iso: re-enabling Org B restores access', r.status === 200, r.status);
    await sa.req('PUT', `/api/orgs/${orgA}/apps/language`, { status: 'disabled' });
    r = await iso.req('GET', `/api/entries/${entryA}`);
    check('iso: disabling Org A cuts A while B stays accessible',
      r.status === 403 && (await iso.req('GET', `/api/entries/${entryB}`)).status === 200);
    await sa.req('PUT', `/api/orgs/${orgA}/apps/language`, { status: 'enabled' });

    // A MISSING organization_apps row means disabled.
    db.prepare(`DELETE FROM organization_apps WHERE organization_id = ? AND app_code = 'language'`).run(orgB);
    r = await iso.req('GET', `/api/entries/${entryB}`);
    check('iso: a missing entitlement row means disabled', r.status === 403, r.status);
    await sa.req('PUT', `/api/orgs/${orgB}/apps/language`, { status: 'enabled' });

    // cleanup (both orgs enabled again so lifecycle routes work)
    await sa.req('DELETE', `/api/projects/${projA}`, { confirm_name: `EntIso ProjA ${ts}` });
    await sa.req('DELETE', `/api/projects/${projB}`, { confirm_name: `EntIso ProjB ${ts}` });
    await sa.req('DELETE', `/api/orgs/${orgA}`);
    await sa.req('DELETE', `/api/orgs/${orgB}`);
    const isoUser = db.prepare('SELECT id FROM users WHERE email = ?').get(isoEmail);
    r = await sa.req('DELETE', `/api/users/${isoUser.id}`);
    check('iso: cleanup complete', r.status === 200, JSON.stringify(r.data));
  } catch (e) {
    check('entitlement-isolation block ran', false, e.stack || e.message);
  }
}

// --- documents (documents spec phases B+C) ---
{
  const ts = Date.now();
  const docProjName = `Docs ${ts}`;
  r = await sa.req('POST', '/api/projects', { name: docProjName, dialect: 'Dëne Sųłıné' });
  const docProj = r.data;
  const corpusId = docProj.corpus_id;

  const upload = async (name, buf, extra = {}) => {
    const fd = new FormData();
    fd.append('file', new Blob([buf]), name);
    fd.append('corpus_id', String(corpusId));
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return sa.req('POST', '/api/documents', fd, true);
  };
  const waitReady = async (id) => {
    for (let i = 0; i < 80; i++) {
      const d = (await sa.req('GET', `/api/documents/${id}`)).data;
      if (['ready', 'failed'].includes(d.status)) return d;
      await new Promise((res) => setTimeout(res, 500));
    }
    return (await sa.req('GET', `/api/documents/${id}`)).data;
  };

  // TXT with Indigenous orthography.
  const txtBytes = Buffer.from('ʔerıhtł’é means paper.\n\nsǫǫ̀mbaà means money.\n');
  r = await upload('field-notes.txt', txtBytes);
  check('doc: TXT upload accepted (returns before extraction)', r.status === 201 && r.data.status === 'uploaded', JSON.stringify(r.data));
  const txtDoc = await waitReady(r.data.id);
  check('doc: TXT reaches ready through extract/index', txtDoc.status === 'ready', `${txtDoc.status} ${txtDoc.error_message ?? ''}`);
  r = await sa.req('GET', `/api/documents/${txtDoc.id}/blocks`);
  check('doc: TXT paragraphs preserved with line locators',
    r.data.total === 2 && r.data.blocks[0].block_type === 'paragraph' && r.data.blocks[0].text.includes('ʔerıhtł’é'),
    JSON.stringify(r.data.total));

  r = await sa.req('GET', `/api/documents/search?corpus_id=${corpusId}&q=${encodeURIComponent('sǫǫ̀mbaà')}`);
  check('doc: search finds the exact Indigenous orthography',
    r.data.results.length >= 1 && r.data.results[0].document_id === txtDoc.id, JSON.stringify(r.data.results?.length));
  r = await sa.req('GET', `/api/documents/search?corpus_id=${corpusId}&q=soombaa`);
  check('doc: diacritics are never silently stripped from the index', r.data.results.length === 0, r.data.results?.length);

  // CSV with quoted fields.
  r = await upload('wordlist.csv', Buffer.from('English,Dene,Category\nfish,"łue",animals\n"has, comma","ʔah",tools\n'));
  const csvDoc = await waitReady(r.data.id);
  check('doc: CSV reaches ready', csvDoc.status === 'ready', csvDoc.error_message ?? csvDoc.status);
  r = await sa.req('GET', `/api/documents/${csvDoc.id}/blocks`);
  check('doc: CSV rows keep row numbers and header-keyed cells',
    r.data.blocks[0]?.row_number === 2 && JSON.parse(r.data.blocks[0].metadata_json).cells.Dene === 'łue',
    JSON.stringify(r.data.blocks[0]));

  // XLSX with two sheets.
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const s1 = wb.addWorksheet('Dictionary'); s1.addRow(['English', 'Dene']); s1.addRow(['water', 'tu']);
  const s2 = wb.addWorksheet('Phrases'); s2.addRow(['English', 'Dene']); s2.addRow(['thank you', 'mahsi cho']);
  r = await upload('workbook.xlsx', Buffer.from(await wb.xlsx.writeBuffer()));
  const xlsxDoc = await waitReady(r.data.id);
  check('doc: XLSX reaches ready', xlsxDoc.status === 'ready', xlsxDoc.error_message ?? xlsxDoc.status);
  r = await sa.req('GET', `/api/documents/${xlsxDoc.id}/blocks?sheet=Phrases`);
  check('doc: XLSX sheet filter with sheet/row provenance',
    r.data.total === 1 && r.data.blocks[0].sheet_name === 'Phrases' && r.data.blocks[0].row_number === 2,
    JSON.stringify(r.data.blocks?.[0]));

  // DOCX: heading + paragraphs, order preserved.
  r = await upload('story.docx', await makeDocx());
  const docxDoc = await waitReady(r.data.id);
  check('doc: DOCX reaches ready with ordered blocks',
    docxDoc.status === 'ready' && docxDoc.block_count === 3, `${docxDoc.status} blocks=${docxDoc.block_count}`);
  r = await sa.req('GET', `/api/documents/${docxDoc.id}/blocks`);
  check('doc: DOCX heading detected first', r.data.blocks[0]?.block_type === 'heading');

  // PDF: native text with page provenance.
  r = await upload('report.pdf', makePdfFixture('The lake holds many fish for the people.'));
  const pdfDoc = await waitReady(r.data.id);
  check('doc: PDF reaches ready', pdfDoc.status === 'ready', pdfDoc.error_message ?? pdfDoc.status);
  r = await sa.req('GET', `/api/documents/${pdfDoc.id}/search?q=lake`);
  check('doc: in-document search returns page provenance', r.data.results[0]?.page_number === 1, JSON.stringify(r.data.results?.[0]));

  // Duplicate bytes in the same collection -> 409 with a pointer.
  r = await upload('field-notes-copy.txt', txtBytes);
  check('doc: exact duplicate rejected with the existing document', r.status === 409 && r.data.existing?.id === txtDoc.id, r.status);

  // Format security.
  r = await upload('macro.docm', Buffer.from('PK fake'));
  check('doc: unsupported/macro-enabled formats rejected', r.status === 400, r.status);
  r = await upload('fake.pdf', Buffer.from('this is not a pdf'));
  check('doc: extension/signature mismatch rejected', r.status === 400, r.status);
  r = await upload('..\\..\\evil.txt', Buffer.from('plain text content here'));
  check('doc: path-traversal filename sanitized', r.status === 201 && !/[\\/]/.test(r.data.original_filename), JSON.stringify(r.data.original_filename));
  const evilDoc = r.data;
  await waitReady(evilDoc.id);

  // UTF-8 filenames survive multipart (busboy decodes them as latin1).
  r = await upload('sǫǫ̀mbaà-notes.txt', Buffer.from('notes about money words\n'));
  check('doc: Dene diacritics in filenames survive upload',
    r.status === 201 && r.data.original_filename === 'sǫǫ̀mbaà-notes.txt' && r.data.title === 'sǫǫ̀mbaà-notes.txt',
    JSON.stringify(r.data.original_filename));
  const deneDoc = r.data;
  await waitReady(deneDoc.id);

  // Original bytes served only through the authorized endpoint.
  const orig = await sa.raw('GET', `/api/documents/${txtDoc.id}/original`);
  check('doc: original downloads as an attachment with exact bytes',
    orig.status === 200 && orig.buf.equals(txtBytes) && /attachment/.test(orig.headers.get('content-disposition') ?? ''),
    orig.status);

  // Authorization: translators and outsiders have no document access.
  const trEmail = `doctr-${ts}@test.ca`;
  await sa.req('POST', `/api/projects/${docProj.id}/members`, { email: trEmail, name: 'Doc Translator', password: 'doctr-pass-1', role: 'translator' });
  const dtr = client();
  await dtr.req('POST', '/api/login', { email: trEmail, password: 'doctr-pass-1' });
  r = await dtr.req('GET', `/api/documents?corpus_id=${corpusId}`);
  check('doc: translators cannot browse documents (v1 policy)', r.status === 403, r.status);
  r = await dtr.req('GET', `/api/documents/${txtDoc.id}/original`);
  check('doc: translators cannot download originals', r.status === 403, r.status);
  const outEmail = `docout-${ts}@test.ca`;
  r = await sa.req('POST', '/api/users', { email: outEmail, name: 'Doc Outsider', password: 'docout-pass-1' });
  const outId = r.data.user_id ?? r.data.id;
  const dout = client();
  await dout.req('POST', '/api/login', { email: outEmail, password: 'docout-pass-1' });
  r = await dout.req('GET', `/api/documents/${txtDoc.id}`);
  check('doc: a guessed document id never crosses org boundaries', r.status === 403, r.status);
  r = await dtr.req('POST', `/api/documents/${txtDoc.id}/reprocess`);
  check('doc: management endpoints are admin-only', r.status === 403, r.status);

  // Reprocess: derived data rebuilt, original untouched.
  const shaBefore = txtDoc.sha256;
  r = await sa.req('POST', `/api/documents/${txtDoc.id}/reprocess`);
  check('doc: admin can reprocess', r.status === 200, r.status);
  const reDoc = await waitReady(txtDoc.id);
  check('doc: reprocess keeps the checksum and rebuilds blocks',
    reDoc.status === 'ready' && reDoc.sha256 === shaBefore && reDoc.block_count === 2,
    JSON.stringify({ s: reDoc.status, b: reDoc.block_count }));
  r = await sa.req('GET', `/api/documents/search?corpus_id=${corpusId}&q=${encodeURIComponent('sǫǫ̀mbaà')}`);
  check('doc: search works after reprocess (index rebuilt)', r.data.results.length >= 1, r.data.results?.length);

  // Archive hides from default browse; restore brings it back.
  await sa.req('POST', `/api/documents/${csvDoc.id}/archive`);
  r = await sa.req('GET', `/api/documents?corpus_id=${corpusId}`);
  check('doc: archived documents leave default browse', !r.data.documents.some((d) => d.id === csvDoc.id));
  r = await sa.req('GET', `/api/documents/search?corpus_id=${corpusId}&q=${encodeURIComponent('łue')}`);
  check('doc: archived documents leave search too', !r.data.results.some((x) => x.document_id === csvDoc.id));
  await sa.req('POST', `/api/documents/${csvDoc.id}/restore`);
  r = await sa.req('GET', `/api/documents?corpus_id=${corpusId}`);
  check('doc: restore returns the document', r.data.documents.some((d) => d.id === csvDoc.id));

  // Delete: exact-title confirmation, admin-only.
  r = await sa.req('DELETE', `/api/documents/${evilDoc.id}`, { confirm_title: 'wrong' });
  check('doc: delete requires the exact title', r.status === 400, r.status);
  r = await sa.req('DELETE', `/api/documents/${evilDoc.id}`, { confirm_title: evilDoc.title });
  check('doc: confirmed delete removes the document', r.status === 200 &&
    (await sa.req('GET', `/api/documents/${evilDoc.id}`)).status === 404);

  // cleanup: delete documents then the project (sole campaign takes the corpus).
  for (const d of [txtDoc, csvDoc, xlsxDoc, docxDoc, pdfDoc, deneDoc]) {
    await sa.req('DELETE', `/api/documents/${d.id}`, { confirm_title: d.title });
  }
  await sa.req('DELETE', `/api/projects/${docProj.id}`, { confirm_name: docProjName });
  r = await sa.req('DELETE', `/api/users/${outId}`);
  check('doc: cleanup complete', r.status === 200, JSON.stringify(r.data));
}

// --- structured import: spreadsheet -> Entries (documents spec phase E, §43–45) ---
{
  const { default: db } = await import('../src/db.js');
  const ts = Date.now();
  const impProjName = `Import ${ts}`;
  r = await sa.req('POST', '/api/projects', { name: impProjName, dialect: 'Dëne Sųłıné' });
  const impProj = r.data;
  const impCorpus = impProj.corpus_id;

  const upload = async (name, buf, extra = {}) => {
    const fd = new FormData();
    fd.append('file', new Blob([buf]), name);
    fd.append('corpus_id', String(impCorpus));
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return sa.req('POST', '/api/documents', fd, true);
  };
  const waitReady = async (id) => {
    for (let i = 0; i < 80; i++) {
      const d = (await sa.req('GET', `/api/documents/${id}`)).data;
      if (['ready', 'failed'].includes(d.status)) return d;
      await new Promise((res) => setTimeout(res, 500));
    }
    return (await sa.req('GET', `/api/documents/${id}`)).data;
  };

  // Pre-existing corpus entry: the spreadsheet row that matches it must dedup.
  r = await sa.req('POST', '/api/entries', { project_id: impProj.id, kind: 'word', dene_text: 'tu', english_text: 'water' });
  const preexistingId = r.data.id;

  // Workbook: dup-of-existing, fresh rows, a one-sided row, an in-sheet
  // duplicate, and a second sheet that must NOT be touched.
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Words');
  ws.addRow(['English', 'Dene', 'Category']);
  ws.addRow(['water', 'tu', 'nature']);           // dup of existing corpus entry
  ws.addRow(['fish', 'łue', 'animals']);          // fresh
  ws.addRow(['money', 'sǫǫ̀mbaà', '']);            // fresh, diacritics
  ws.addRow(['bear', '', 'animals']);             // one-sided -> queued for translation
  ws.addRow(['fish', 'łue', 'animals']);          // in-sheet duplicate
  const ws2 = wb.addWorksheet('Other');
  ws2.addRow(['English', 'Dene']);
  ws2.addRow(['do not import', 'xxx']);
  r = await upload('import.xlsx', Buffer.from(await wb.xlsx.writeBuffer()));
  const impDoc = await waitReady(r.data.id);
  check('import: workbook ready', impDoc.status === 'ready', impDoc.error_message ?? impDoc.status);

  const mapping = { English: 'english', Dene: 'dene', Category: 'category' };

  // Guards first: bad mapping, wrong format, wrong role.
  r = await sa.req('POST', `/api/documents/${impDoc.id}/create-entries`, { kind: 'word', mapping: { Category: 'category' } });
  check('import: mapping must include dene or english', r.status === 400, r.status);
  r = await upload('notes.txt', Buffer.from('plain notes\n'));
  const impTxt = await waitReady(r.data.id);
  r = await sa.req('POST', `/api/documents/${impTxt.id}/create-entries`, { kind: 'word', mapping });
  check('import: only spreadsheets can create entries', r.status === 400, r.status);
  const itrEmail = `imptr-${ts}@test.ca`;
  await sa.req('POST', `/api/projects/${impProj.id}/members`, { email: itrEmail, name: 'Imp Translator', password: 'imptr-pass-1', role: 'translator' });
  const itr = client();
  await itr.req('POST', '/api/login', { email: itrEmail, password: 'imptr-pass-1' });
  r = await itr.req('POST', `/api/documents/${impDoc.id}/create-entries`, { sheet: 'Words', kind: 'word', mapping });
  check('import: translators cannot create entries from documents', r.status === 403, r.status);

  // The real import: only the chosen sheet, corpus dedup, one-sided rows kept.
  r = await sa.req('POST', `/api/documents/${impDoc.id}/create-entries`,
    { sheet: 'Words', kind: 'word', mapping, origin_project_id: impProj.id });
  check('import: created 3, skipped 1 corpus dup + 1 in-sheet dup',
    r.status === 200 && r.data.created === 3 && r.data.skipped_duplicates === 2 && r.data.project_id === impProj.id,
    JSON.stringify(r.data));
  const entries = db.prepare('SELECT * FROM entries WHERE corpus_id = ? ORDER BY id').all(impCorpus);
  check('import: corpus now holds preexisting + 3 imported', entries.length === 4, entries.length);
  check('import: entries carry corpus + origin-project provenance',
    entries.every((e) => e.corpus_id === impCorpus && e.project_id === impProj.id));
  const bear = entries.find((e) => e.english_text === 'bear');
  check('import: one-sided row imported queued for translation', bear && bear.dene_text === '', JSON.stringify(bear?.dene_text));
  check('import: the untouched sheet stayed untouched', !entries.some((e) => e.english_text === 'do not import'));
  const money = entries.find((e) => e.english_text === 'money');
  check('import: diacritics preserved exactly', money?.dene_text === 'sǫǫ̀mbaà', JSON.stringify(money?.dene_text));

  // Entry -> Document provenance with sheet/row locator, retrievable via API.
  const fish = entries.find((e) => e.english_text === 'fish');
  r = await sa.req('GET', `/api/entries/${fish.id}`);
  const src = r.data.sources?.[0];
  check('import: entry cites its source document with sheet and row',
    src && src.document_id === impDoc.id && src.location?.sheet === 'Words' && src.location?.row === 3,
    JSON.stringify(src));

  // Re-confirming the same import must be a no-op (block-level idempotency).
  r = await sa.req('POST', `/api/documents/${impDoc.id}/create-entries`,
    { sheet: 'Words', kind: 'word', mapping, origin_project_id: impProj.id });
  check('import: re-running creates nothing new',
    r.data.created === 0 && r.data.skipped_already_imported === 3,
    JSON.stringify(r.data));
  check('import: still 4 entries after re-run',
    db.prepare('SELECT COUNT(*) n FROM entries WHERE corpus_id = ?').get(impCorpus).n === 4);

  // Hard delete refused while entries cite the document; archive is the path.
  r = await sa.req('DELETE', `/api/documents/${impDoc.id}`, { confirm_title: impDoc.title });
  check('import: delete refused while entries cite the document', r.status === 409, r.status);
  r = await sa.req('POST', `/api/documents/${impDoc.id}/archive`);
  check('import: archive works instead', r.status === 200, r.status);
  r = await sa.req('GET', `/api/entries/${fish.id}`);
  check('import: provenance survives archiving', r.data.sources?.[0]?.document_id === impDoc.id);

  // cleanup: entries first (releases the citation), then documents, project, translator.
  for (const e of entries.filter((x) => x.id !== preexistingId)) {
    await sa.req('DELETE', `/api/entries/${e.id}`);
  }
  await sa.req('DELETE', `/api/entries/${preexistingId}`);
  await sa.req('POST', `/api/documents/${impDoc.id}/restore`);
  r = await sa.req('DELETE', `/api/documents/${impDoc.id}`, { confirm_title: impDoc.title });
  check('import: delete allowed once no entries cite it', r.status === 200, r.status);
  await sa.req('DELETE', `/api/documents/${impTxt.id}`, { confirm_title: impTxt.title });
  await sa.req('DELETE', `/api/projects/${impProj.id}`, { confirm_name: impProjName });
  const itrUser = db.prepare('SELECT id FROM users WHERE email = ?').get(itrEmail);
  r = await sa.req('DELETE', `/api/users/${itrUser.id}`);
  check('import: cleanup complete', r.status === 200, JSON.stringify(r.data));
}

// --- master search + home feed (master-search spec §38–§42) ---
{
  const { default: db } = await import('../src/db.js');
  const ts = Date.now();
  const projAName = `SearchA ${ts}`;
  const projBName = `SearchB ${ts}`;
  r = await sa.req('POST', '/api/projects', { name: projAName, dialect: 'Dëne Sųłıné' });
  const projA = r.data;
  const corpusA = projA.corpus_id;
  r = await sa.req('POST', '/api/projects', { name: projBName, dialect: 'Dëne Sųłıné' });
  const projB = r.data;
  const corpusB = projB.corpus_id;

  // Entries: a semantic target, an exact-Dene word, a keyword-only entry with
  // no embedding (blank English side), and the SAME word in corpus B.
  r = await sa.req('POST', '/api/entries', { project_id: projA.id, kind: 'phrase', dene_text: 'dánet’é', english_text: 'how are you' });
  const greetId = r.data.id;
  r = await sa.req('POST', '/api/entries', { project_id: projA.id, kind: 'word', dene_text: 'łue', english_text: 'fish' });
  const fishId = r.data.id;
  r = await sa.req('POST', '/api/entries', { project_id: projA.id, kind: 'phrase', dene_text: 'sǫǫ̀mbaà', english_text: '' });
  const noEmbedId = r.data.id;
  r = await sa.req('POST', '/api/entries', { project_id: projB.id, kind: 'word', dene_text: 'łue', english_text: 'fish' });
  const fishBId = r.data.id;

  // Recording on the greeting entry, speaker Jane.
  let sfd = new FormData();
  sfd.append('file', new Blob([makeWav(2)], { type: 'audio/wav' }), 'greet.wav');
  sfd.append('speaker', 'Jane Semantic');
  sfd.append('language', 'dene');
  r = await sa.req('POST', `/api/entries/${greetId}/audio`, sfd, true);
  check('msearch: recording uploaded', r.status === 201, JSON.stringify(r.data));
  const greetAudio1 = r.data.id;

  // Background embeddings must land before semantic assertions.
  const waitEmbed = async (ids) => {
    for (let i = 0; i < 120; i++) {
      const n = db.prepare(`SELECT COUNT(*) n FROM entries WHERE id IN (${ids.join(',')}) AND embedding IS NOT NULL`).get().n;
      if (n === ids.length) return true;
      await new Promise((res) => setTimeout(res, 500));
    }
    return false;
  };
  check('msearch: entry embeddings computed in the background', await waitEmbed([greetId, fishId, fishBId]));

  // Semantic discovery: "greeting" -> "how are you", entry AND its recording.
  r = await sa.req('GET', `/api/search?corpus_id=${corpusA}&q=greeting`);
  check('msearch: semantic entry hit ("greeting" finds "how are you")',
    r.status === 200 && r.data.entries.results.some((e) => e.id === greetId),
    JSON.stringify(r.data.entries?.results?.map((e) => e.english_text)));
  check('msearch: semantic reported available with model',
    r.data.semantic?.available === true && !!r.data.semantic.model);
  check('msearch: recording inherits parent-entry semantics',
    r.data.recordings.results.some((x) => x.id === greetAudio1),
    JSON.stringify(r.data.recordings?.results?.map((x) => x.id)));

  // Exact Dene orthography ranks first and never crosses corpora.
  r = await sa.req('GET', `/api/search?corpus_id=${corpusA}&q=${encodeURIComponent('łue')}`);
  check('msearch: exact Dene match ranks first', r.data.entries.results[0]?.id === fishId,
    JSON.stringify(r.data.entries.results?.[0]));
  check('msearch: corpus isolation — no corpus-B entries', !r.data.entries.results.some((e) => e.id === fishBId));
  r = await sa.req('GET', `/api/search?corpus_id=${corpusB}&q=${encodeURIComponent('łue')}`);
  check('msearch: corpus B sees only its own copy',
    r.data.entries.results.length === 1 && r.data.entries.results[0].id === fishBId,
    JSON.stringify(r.data.entries.results?.map((e) => e.id)));

  // No embedding -> still keyword-discoverable (diacritics exact).
  r = await sa.req('GET', `/api/search?corpus_id=${corpusA}&q=${encodeURIComponent('sǫǫ̀mbaà')}`);
  check('msearch: entry without embedding found by keyword',
    r.data.entries.results.some((e) => e.id === noEmbedId));

  // Speaker keyword finds the recording; superseding hides the old version.
  r = await sa.req('GET', `/api/search?corpus_id=${corpusA}&q=${encodeURIComponent('Jane Semantic')}`);
  check('msearch: speaker name finds the recording',
    r.data.recordings.results.some((x) => x.id === greetAudio1),
    JSON.stringify(r.data.recordings?.results));
  sfd = new FormData();
  sfd.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'greet-v2.wav');
  sfd.append('speaker', 'Jane Semantic');
  sfd.append('language', 'dene');
  r = await sa.req('POST', `/api/entries/${greetId}/audio`, sfd, true);
  const greetAudio2 = r.data.id;
  r = await sa.req('GET', `/api/search?corpus_id=${corpusA}&q=${encodeURIComponent('Jane Semantic')}`);
  check('msearch: superseded recordings never returned',
    r.data.recordings.results.some((x) => x.id === greetAudio2) &&
    !r.data.recordings.results.some((x) => x.id === greetAudio1),
    JSON.stringify(r.data.recordings.results?.map((x) => x.id)));

  // Documents inside master search (keyword/FTS path).
  const dfd = new FormData();
  dfd.append('file', new Blob([Buffer.from('Whitefish were dried and stored for use during the winter.\n')]), 'winter-fish-notes.txt');
  dfd.append('corpus_id', String(corpusA));
  r = await sa.req('POST', '/api/documents', dfd, true);
  const searchDocId = r.data.id;
  for (let i = 0; i < 80; i++) {
    const d = (await sa.req('GET', `/api/documents/${searchDocId}`)).data;
    if (['ready', 'failed'].includes(d.status)) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  r = await sa.req('GET', `/api/search?corpus_id=${corpusA}&q=whitefish`);
  check('msearch: document found through FTS with snippet',
    r.data.documents.results[0]?.document_id === searchDocId && /hitefish/.test(r.data.documents.results[0]?.snippet ?? ''),
    JSON.stringify(r.data.documents?.results?.[0]));
  r = await sa.req('GET', `/api/search?corpus_id=${corpusA}&q=winter-fish-notes`);
  check('msearch: document found by title/filename', r.data.documents.results.some((d) => d.document_id === searchDocId));

  // Home latest feed (spec §24/§25).
  r = await sa.req('GET', `/api/home?corpus_id=${corpusA}`);
  check('msearch: home feed lists latest entries/documents/recordings',
    r.status === 200 && r.data.entries.length === 3 &&
    r.data.documents.some((d) => d.document_id === searchDocId) &&
    r.data.recordings.length === 1 && r.data.recordings[0].id === greetAudio2,
    JSON.stringify({ e: r.data.entries?.length, d: r.data.documents?.length, r: r.data.recordings?.length }));
  await sa.req('POST', `/api/documents/${searchDocId}/archive`);
  r = await sa.req('GET', `/api/home?corpus_id=${corpusA}`);
  check('msearch: archived documents leave the home feed', !r.data.documents.some((d) => d.document_id === searchDocId));
  r = await sa.req('GET', `/api/search?corpus_id=${corpusA}&q=whitefish`);
  check('msearch: archived documents leave master search', !r.data.documents.results.some((d) => d.document_id === searchDocId));
  await sa.req('POST', `/api/documents/${searchDocId}/restore`);

  // Translator privacy (spec §33): no documents key — not even a count.
  const strEmail = `searchtr-${ts}@test.ca`;
  await sa.req('POST', `/api/projects/${projA.id}/members`, { email: strEmail, name: 'Search Translator', password: 'searchtr-pass-1', role: 'translator' });
  const str = client();
  await str.req('POST', '/api/login', { email: strEmail, password: 'searchtr-pass-1' });
  r = await str.req('GET', `/api/search?corpus_id=${corpusA}&q=whitefish`);
  check('msearch: translators get no documents section at all',
    r.status === 200 && !('documents' in r.data) && Array.isArray(r.data.entries.results), JSON.stringify(Object.keys(r.data ?? {})));
  r = await str.req('GET', `/api/home?corpus_id=${corpusA}`);
  check('msearch: translator home feed has no documents key', r.status === 200 && !('documents' in r.data));

  // Entitlement isolation (spec §38): disabling Language forbids search.
  const orgId = db.prepare('SELECT organization_id FROM corpora WHERE id = ?').get(corpusA).organization_id;
  await sa.req('PUT', `/api/orgs/${orgId}/apps/language`, { status: 'disabled' });
  const forbidden = await sa.req('GET', `/api/search?corpus_id=${corpusA}&q=fish`);
  const forbiddenHome = await sa.req('GET', `/api/home?corpus_id=${corpusA}`);
  await sa.req('PUT', `/api/orgs/${orgId}/apps/language`, { status: 'enabled' });
  check('msearch: disabled entitlement forbids search and home', forbidden.status === 403 && forbiddenHome.status === 403,
    `${forbidden.status}/${forbiddenHome.status}`);
  r = await sa.req('GET', `/api/search?corpus_id=${corpusA}&q=fish`);
  check('msearch: re-enabled entitlement restores search', r.status === 200, r.status);

  // cleanup: document, translator, then projects (sole campaigns sweep corpora).
  await sa.req('DELETE', `/api/documents/${searchDocId}`, { confirm_title: 'winter-fish-notes.txt' });
  await sa.req('DELETE', `/api/projects/${projA.id}`, { confirm_name: projAName });
  await sa.req('DELETE', `/api/projects/${projB.id}`, { confirm_name: projBName });
  const strUser = db.prepare('SELECT id FROM users WHERE email = ?').get(strEmail);
  r = await sa.req('DELETE', `/api/users/${strUser.id}`);
  check('msearch: cleanup complete', r.status === 200, JSON.stringify(r.data));
}

// --- root sign-in page ---
{
  const anon = client();
  r = await anon.req('GET', '/');
  check('signed-out root serves the sign-in page (no forward)',
    r.status === 200 && String(r.data).includes('Sign in'), r.status);
  r = await sa.req('GET', '/');
  check('signed-in root forwards to /language',
    r.status === 302 && (r.headers.get('location') || '').includes('/language'), r.status);
}

// --- library APIs (nav spec §7/§11): corpora, recordings, speakers ---
{
  r = await sa.req('GET', '/api/corpora');
  check('corpora endpoint lists visible collections with counts',
    r.status === 200 && Array.isArray(r.data.corpora) &&
    r.data.corpora.every((c) => 'entry_count' in c && 'recording_count' in c && 'organization_id' in c),
    r.status);
  const c0 = r.data.corpora[0];
  if (c0) {
    r = await sa.req('GET', `/api/entries?corpus_id=${c0.id}&limit=5`);
    check('entries list accepts a corpus scope', r.status === 200, r.status);
    r = await sa.req('GET', `/api/recordings?corpus_id=${c0.id}&limit=5`);
    check('corpus recordings browser lists current recordings',
      r.status === 200 && Array.isArray(r.data.recordings), r.status);
    r = await sa.req('GET', `/api/speakers?corpus_id=${c0.id}`);
    check('corpus speakers page lists org speakers with rollups',
      r.status === 200 && Array.isArray(r.data.speakers), r.status);
  }
  r = await sa.req('GET', '/api/recordings?corpus_id=99999999');
  check('corpus scoping rejects unknown collections', r.status === 403, r.status);
}

// --- corpus / campaign separation (plan §10) ---
// Local-only (shared-corpus cleanup needs direct SQLite access).
if (BASE.includes('localhost')) {
  try {
    const { default: db } = await import('../src/db.js');
    const ts = Date.now();
    const nameA = `Corpus A ${ts}`;
    r = await sa.req('POST', '/api/projects', { name: nameA, dialect: 'Dëne Sųłıné' });
    const projA = r.data;
    check('a new project is born with its own corpus (active campaign)',
      !!projA.corpus_id && projA.status === 'active', JSON.stringify({ c: projA.corpus_id, s: projA.status }));
    r = await sa.req('POST', '/api/entries', { project_id: projA.id, kind: 'word', dene_text: 'łue', english_text: 'fish' });
    check('entries carry their corpus', r.data.corpus_id === projA.corpus_id);

    // A second funding campaign contributes to the SAME permanent corpus.
    r = await sa.req('POST', '/api/projects', { name: `Corpus B ${ts}`, dialect: 'Dëne Sųłıné', corpus_id: projA.corpus_id });
    const projB = r.data;
    check('a second campaign can join an existing corpus', projB.corpus_id === projA.corpus_id);
    r = await sa.req('POST', '/api/entries', { project_id: projB.id, kind: 'word', dene_text: 'deh', english_text: 'river' });
    check('the second campaign\'s entries land in the shared corpus', r.data.corpus_id === projA.corpus_id);

    // Corpus-wide import dedup: campaign B must not re-import what A already holds.
    const dupCsv = 'dene_text,english_text\nłue,fish\nk’i,birch\n';
    const fdC = new FormData();
    fdC.append('file', new Blob([dupCsv], { type: 'text/csv' }), 'campaignB.csv');
    fdC.append('kind', 'word');
    r = await sa.req('POST', `/api/projects/${projB.id}/import`, fdC, true);
    check('import dedup is corpus-wide, not campaign-wide',
      r.data.imported === 1 && r.data.skipped_duplicates === 1, JSON.stringify(r.data));

    // Closing a campaign ends funded work but never touches the corpus.
    r = await sa.req('PATCH', `/api/projects/${projA.id}`, { status: 'closed' });
    check('a campaign can be closed', r.data.status === 'closed');
    r = await sa.req('POST', `/api/projects/${projA.id}/work/claim`, { type: 'recording', language: 'dene', limit: 5 });
    check('a closed campaign takes no new work claims', r.status === 400, r.status);
    r = await sa.req('GET', `/api/entries?project_id=${projA.id}`);
    check('the corpus data stays readable after campaign closure',
      r.status === 200 && r.data.total >= 1, r.status);
    check('the corpus row survives campaign closure',
      !!db.prepare('SELECT 1 FROM corpora WHERE id = ?').get(projA.corpus_id));

    // A campaign sharing its corpus cannot be deleted (corpus property).
    r = await sa.req('DELETE', `/api/projects/${projA.id}`, { confirm_name: nameA });
    check('deleting a campaign that shares its corpus is refused', r.status === 400, r.status);

    // cleanup: retire campaign B surgically, then A (now sole) via the API —
    // which takes the whole corpus with it, name-confirmed.
    db.prepare('DELETE FROM entries WHERE project_id = ?').run(projB.id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(projB.id);
    r = await sa.req('DELETE', `/api/projects/${projA.id}`, { confirm_name: nameA });
    check('the corpus\'s only campaign can delete corpus and campaign together',
      r.status === 200 && !db.prepare('SELECT 1 FROM corpora WHERE id = ?').get(projA.corpus_id));
  } catch (e) {
    check('corpus/campaign block ran', false, e.stack || e.message);
  }
}

// --- corpus ownership: shared-corpus campaigns (two-fixes #2/#4/§12) ---
// The corpus owns the entries; campaigns discover and fund work on the whole
// corpus; provenance and money stay campaign-attributed. Local-only (db
// provenance assertions + surgical cleanup of the shared corpus pair).
if (BASE.includes('localhost')) {
  try {
    const { default: db } = await import('../src/db.js');
    const ts = Date.now();
    r = await sa.req('POST', '/api/projects', { name: `Own A ${ts}`, dialect: 'Dëne Sųłıné' });
    const projCA = r.data;
    r = await sa.req('POST', '/api/projects', { name: `Own B ${ts}`, corpus_id: projCA.corpus_id });
    const projCB = r.data;
    // Campaign A creates a one-sided entry (translation work for the corpus).
    r = await sa.req('POST', '/api/entries', { project_id: projCA.id, kind: 'phrase', dene_text: 'ɂerıhtł’é' });
    const entry1 = r.data.id;

    r = await sa.req('GET', `/api/entries?project_id=${projCB.id}`);
    check('own: campaign B\'s dictionary shows the corpus entry created by campaign A',
      r.data.entries.some((e) => e.id === entry1), JSON.stringify(r.data.total));
    r = await sa.req('GET', `/api/projects/${projCB.id}/stats`);
    check('own: campaign stats report the corpus, not just own-created entries',
      r.data.entry_count >= 1, r.data.entry_count);

    // A translator hired by campaign B works on A's entry; the work item and
    // money belong to B, the entry stays corpus-owned with A as origin.
    const trEmail = `own-tr-${ts}@test.ca`;
    await sa.req('POST', `/api/projects/${projCB.id}/members`,
      { email: trEmail, name: 'Own Translator', password: 'own-tr-pass-1', role: 'translator' });
    const tr = client();
    await tr.req('POST', '/api/login', { email: trEmail, password: 'own-tr-pass-1' });
    r = await tr.req('POST', `/api/projects/${projCB.id}/work/claim`, { type: 'translation', limit: 5 });
    check('own: campaign B\'s work queue offers campaign A\'s corpus entry',
      r.data.items.some((i) => i.entry.id === entry1), JSON.stringify(r.data.items?.map((i) => i.entry.id)));
    const wi = r.data.items.find((i) => i.entry.id === entry1).work_item_id;
    check('own: the work item belongs to campaign B',
      db.prepare('SELECT project_id FROM work_items WHERE id = ?').get(wi).project_id === projCB.id);
    r = await tr.req('POST', `/api/work/${wi}/submit`, { dene_text: 'ɂerıhtł’é', english_text: 'paper' });
    check('own: translation submits and bills through campaign B', r.status === 200, JSON.stringify(r.data));
    const ledger = db.prepare('SELECT project_id, organization_id FROM work_log WHERE work_item_id = ?').get(wi);
    check('own: the ledger row is campaign-B-attributed with the org stamped',
      ledger?.project_id === projCB.id && !!ledger?.organization_id, JSON.stringify(ledger));
    const e1 = db.prepare('SELECT project_id, corpus_id FROM entries WHERE id = ?').get(entry1);
    check('own: the entry stays corpus-owned with campaign A as origin/provenance',
      e1.corpus_id === projCA.corpus_id && e1.project_id === projCA.id, JSON.stringify(e1));

    // Recording discovery is corpus-wide too.
    r = await tr.req('POST', `/api/projects/${projCB.id}/work/claim`, { type: 'recording', language: 'dene', limit: 5 });
    check('own: campaign B\'s recording queue offers the (now complete) corpus entry',
      r.data.items.some((i) => i.entry.id === entry1));
    for (const it of r.data.items) await tr.req('POST', `/api/work/${it.work_item_id}/release`, {});

    // Closing campaign A changes nothing for the corpus or campaign B.
    await sa.req('PATCH', `/api/projects/${projCA.id}`, { status: 'closed' });
    r = await tr.req('GET', `/api/entries/${entry1}`);
    check('own: entry stays accessible after its origin campaign closes', r.status === 200, r.status);
    r = await tr.req('POST', `/api/projects/${projCB.id}/work/claim`, { type: 'recording', language: 'dene', limit: 5 });
    check('own: campaign B still discovers work after A closes',
      r.data.items.some((i) => i.entry.id === entry1));
    for (const it of r.data.items) await tr.req('POST', `/api/work/${it.work_item_id}/release`, {});

    // The corpus owner archive contains A's entry when exported via B.
    const bundle = (await sa.raw('GET', `/api/projects/${projCB.id}/export-bundle`)).buf.toString('latin1');
    const e1uid = db.prepare('SELECT uid FROM entries WHERE id = ?').get(entry1).uid;
    check('own: corpus export via campaign B contains campaign A\'s entry', bundle.includes(e1uid));

    // Integrity: a project cannot adopt a corpus from another organization.
    r = await sa.req('POST', '/api/orgs', { name: `Own X ${ts}` });
    const orgX = r.data.id;
    r = await sa.req('POST', '/api/projects', { name: `Own XProj ${ts}`, organization_id: orgX, corpus_id: projCA.corpus_id });
    check('own: a project cannot reference a corpus from another organization', r.status === 400, r.status);
    await sa.req('DELETE', `/api/orgs/${orgX}`);

    // cleanup: retire campaign B surgically, then A (sole) takes the corpus.
    db.prepare('DELETE FROM projects WHERE id = ?').run(projCB.id);
    await sa.req('PATCH', `/api/projects/${projCA.id}`, { status: 'active' });
    r = await sa.req('DELETE', `/api/projects/${projCA.id}`, { confirm_name: `Own A ${ts}` });
    check('own: sole-campaign delete sweeps the whole corpus', r.status === 200 &&
      !db.prepare('SELECT 1 FROM entries WHERE id = ?').get(entry1));
    const trUser = db.prepare('SELECT id FROM users WHERE email = ?').get(trEmail);
    db.prepare('DELETE FROM work_log WHERE user_id = ?').run(trUser.id);
    r = await sa.req('DELETE', `/api/users/${trUser.id}`);
    check('own: cleanup complete', r.status === 200, JSON.stringify(r.data));
  } catch (e) {
    check('corpus-ownership block ran', false, e.stack || e.message);
  }
}

// --- stable uids (plan §9) ---
{
  const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const uidName = `Uid ${Date.now()}`;
  r = await sa.req('POST', '/api/projects', { name: uidName, dialect: 'Dëne Sųłıné' });
  const uidProj = r.data;
  check('new projects are born with a UUIDv7 uid', UUID7.test(uidProj.uid ?? ''), uidProj.uid);
  r = await sa.req('POST', '/api/entries', { project_id: uidProj.id, kind: 'word', dene_text: 'tu', english_text: 'water' });
  check('new entries are born with a UUIDv7 uid', UUID7.test(r.data.uid ?? ''), r.data.uid);
  const uidEntry = r.data.id;
  const fdU = new FormData();
  fdU.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'uid.wav');
  fdU.append('language', 'dene');
  r = await sa.req('POST', `/api/entries/${uidEntry}/audio`, fdU, true);
  check('new recordings are born with a UUIDv7 uid', UUID7.test(r.data.uid ?? ''), r.data.uid);
  // The owner archive carries uids so exported identity survives re-import.
  const bundleTxt = (await sa.raw('GET', `/api/projects/${uidProj.id}/export-bundle`)).buf.toString('latin1');
  check('export bundle embeds the entry and recording uids',
    bundleTxt.includes('"schema_version": "1.3"') && bundleTxt.includes(uidProj.uid), 'uids not found in bundle');
  await sa.req('DELETE', `/api/projects/${uidProj.id}`, { confirm_name: uidName });
  if (BASE.includes('localhost')) {
    const { default: db } = await import('../src/db.js');
    const missing = ['organizations', 'projects', 'entries', 'audio_files']
      .map((t) => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE uid IS NULL`).get().n)
      .reduce((a, b) => a + b, 0);
    check('invariant: no org/project/entry/recording lacks a uid', missing === 0, missing);
  }
}

// --- language abstraction: entry_texts mirror + read preference (plan §6) ---
// Local-only: inspects the server's SQLite directly, like the hashed-session block.
if (BASE.includes('localhost')) {
  try {
    const { default: db } = await import('../src/db.js');
    const laName = `LangAbs ${Date.now()}`;
    r = await sa.req('POST', '/api/projects', { name: laName, dialect: 'Tłı̨chǫ' });
    const laProj = r.data.id;
    r = await sa.req('POST', '/api/entries', {
      project_id: laProj, kind: 'word', dene_text: 'sombak’è', english_text: 'money place',
    });
    const laEntry = r.data.id;
    const texts = () => db.prepare(
      `SELECT et.*, v.name AS variety, l.name AS language, l.code AS lang_code
       FROM entry_texts et JOIN language_varieties v ON v.id = et.variety_id
       JOIN languages l ON l.id = v.language_id WHERE et.entry_id = ? ORDER BY et.id`
    ).all(laEntry);
    let t = texts();
    check('creating an entry mirrors both sides into entry_texts',
      t.length === 2 && t.every((x) => x.uid), JSON.stringify(t.map((x) => x.text)));
    check('the Dene side is the single primary text in the project-dialect variety',
      t.find((x) => x.is_primary === 1)?.variety === 'Tłı̨chǫ' &&
      t.find((x) => x.is_primary === 1)?.language === 'Dene');
    check('the English side is a role=translation text in the English variety',
      t.find((x) => x.role === 'translation')?.lang_code === 'en');

    r = await sa.req('PATCH', `/api/entries/${laEntry}`, { english_text: '' });
    check('blanking a side removes its mirrored entry_text', texts().length === 1);
    r = await sa.req('PATCH', `/api/entries/${laEntry}`, { english_text: 'money place' });
    check('restoring the side recreates the mirrored entry_text', texts().length === 2);

    // Reads PREFER entry_texts: edit the primary text directly (bypassing the
    // legacy columns) and the API must serve the entry_texts value.
    db.prepare(`UPDATE entry_texts SET text = 'sǫǫ̀mbak’è' WHERE entry_id = ? AND is_primary = 1`).run(laEntry);
    r = await sa.req('GET', `/api/entries/${laEntry}`);
    check('reads prefer entry_texts over the legacy column', r.data.dene_text === 'sǫǫ̀mbak’è', r.data.dene_text);
    // A write through the API re-syncs the mirror from the submitted values.
    await sa.req('PATCH', `/api/entries/${laEntry}`, { dene_text: 'sombak’è' });
    check('an API write re-syncs the mirrored text',
      texts().find((x) => x.is_primary === 1)?.text === 'sombak’è');

    // Coexistence: a third language and an alternate Dene realization can sit
    // beside the mirrored pair without disturbing the bilingual API.
    const { uuidv7 } = await import('../src/platform/uid.js');
    const frLang = db.prepare(`INSERT INTO languages (uid, code, iso639_3, name) VALUES (?, 'fr', 'fra', 'French')`)
      .run(uuidv7()).lastInsertRowid;
    const frVar = db.prepare(`INSERT INTO language_varieties (uid, language_id, name) VALUES (?, ?, 'French')`)
      .run(uuidv7(), frLang).lastInsertRowid;
    const deneVar = texts().find((x) => x.is_primary === 1).variety_id;
    db.prepare(`INSERT INTO entry_texts (uid, entry_id, variety_id, text, role) VALUES (?, ?, ?, 'place d’argent', 'translation')`)
      .run(uuidv7(), laEntry, frVar);
    db.prepare(`INSERT INTO entry_texts (uid, entry_id, variety_id, text, role) VALUES (?, ?, ?, 'sǫǫ̀mbak’è', 'alternate')`)
      .run(uuidv7(), laEntry, deneVar);
    check('an entry can hold texts in >2 languages and alternate realizations', texts().length === 4);
    r = await sa.req('GET', `/api/entries/${laEntry}`);
    check('extra texts do not disturb the bilingual API surface',
      r.data.dene_text === 'sombak’è' && r.data.english_text === 'money place');

    // Import mirrors too (one two-sided row + one one-sided row = 3 texts).
    const csv = 'dene_text,english_text\nłue,fish\n,paddle\n';
    const fd = new FormData();
    fd.append('file', new Blob([csv], { type: 'text/csv' }), 'langabs.csv');
    fd.append('kind', 'word');
    r = await sa.req('POST', `/api/projects/${laProj}/import`, fd, true);
    check('import creates entries', r.data.imported === 2, JSON.stringify(r.data));
    const imported = db.prepare(
      `SELECT COUNT(*) n FROM entry_texts et JOIN entries e ON e.id = et.entry_id
       WHERE e.project_id = ? AND e.id <> ?`).get(laProj, laEntry).n;
    check('import mirrors texts into entry_texts (3 texts for 2 rows)', imported === 3, imported);

    // Global invariant sweep: across EVERY entry the suite created (direct
    // edits, translate flow, work-item submits, imports), a non-empty legacy
    // column always has an equal mirrored text.
    const broken = db.prepare(`
      SELECT COUNT(*) n FROM entries e
      WHERE (e.dene_text <> '' AND NOT EXISTS (
              SELECT 1 FROM entry_texts et WHERE et.entry_id = e.id AND et.is_primary = 1 AND et.text = e.dene_text))
         OR (e.english_text <> '' AND NOT EXISTS (
              SELECT 1 FROM entry_texts et JOIN language_varieties v ON v.id = et.variety_id
              JOIN languages l ON l.id = v.language_id
              WHERE et.entry_id = e.id AND l.code = 'en' AND et.role = 'translation' AND et.text = e.english_text))
    `).get().n;
    check('invariant: every non-empty legacy column is mirrored by an equal entry_text', broken === 0, broken);

    // cleanup (entry_texts cascade with entries/projects)
    await sa.req('DELETE', `/api/projects/${laProj}`, { confirm_name: laName });
    db.prepare(`DELETE FROM language_varieties WHERE id = ?`).run(frVar);
    db.prepare(`DELETE FROM languages WHERE id = ?`).run(frLang);
    check('language-abstraction cleanup complete',
      db.prepare(`SELECT COUNT(*) n FROM entry_texts WHERE entry_id = ?`).get(laEntry).n === 0);
  } catch (e) {
    check('language-abstraction block ran', false, e.stack || e.message);
  }
}

// Flat-model cleanup: project deletion no longer cascades people, so remove
// every org member this run introduced (roster snapshot taken at suite start).
{
  r = await sa.req('GET', `/api/orgs/${mainOrgId}/members`);
  for (const mb of (r.data.members ?? []).filter((m) => !preexistingMembers.has(m.id))) {
    await sa.req('DELETE', `/api/orgs/${mainOrgId}/members/${mb.id}`);
  }
  r = await sa.req('GET', `/api/orgs/${mainOrgId}/members`);
  check('org roster restored to its pre-suite state (cleanup)',
    (r.data.members ?? []).every((mb) => preexistingMembers.has(mb.id)),
    JSON.stringify(r.data.members?.map?.((mb) => mb.email)));
}

console.log(failures ? `\n${failures} FAILURES` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
