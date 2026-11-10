// End-to-end test against the fake Supabase backend, driving real pages in Chromium.
//   FIXTURES=<dir with small.png exact.png vid.mp4 newbg.png> npm test
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { start, fake } = require('./devserver');

const FX = process.env.FIXTURES;
if (!FX) { console.error('Set FIXTURES to a folder containing small.png, exact.png, vid.mp4, newbg.png'); process.exit(2); }
const OUT = process.env.OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'screen-test-'));
const PORT = 3079, B = `http://localhost:${PORT}`;
const SUPA = path.join(__dirname, '..', 'node_modules/@supabase/supabase-js/dist/umd/supabase.js');
const probe = (buf) => {
  const f = path.join(OUT, 'probe.bin'); fs.writeFileSync(f, buf);
  return execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString().trim();
};
// capture outgoing emails (no real network); a recipient containing "fail" simulates Resend rejecting the request
const emails = [], realFetch = global.fetch;
global.fetch = (u, o) => {
  if (String(u).startsWith('https://api.resend.com/')) {
    const body = JSON.parse(o.body); emails.push(body);
    return Promise.resolve(/fail/.test(body.to.join()) ? { ok: false, status: 403, text: async () => JSON.stringify({ message: 'domain not verified' }) } : { ok: true, status: 200, text: async () => '{}' });
  }
  return realFetch(u, o);
};
process.env.RESEND_API_KEY = 're_test';
const post = (u, b, h = {}) => fetch(B + u, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b) });

(async () => {
  const srv = await start(PORT);
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.route('**/cdn.jsdelivr.net/**', (r) => r.fulfill({ path: SUPA, contentType: 'text/javascript' }));
  await ctx.route('**/cdnjs.cloudflare.com/**', (r) => r.fulfill({ path: path.join(__dirname, '..', 'node_modules/jszip/dist/jszip.min.js'), contentType: 'text/javascript' }));
  await ctx.route('**/fonts.g*apis.com/**', (r) => r.abort());
  const errs = [];
  ctx.on('page', (p) => { p.on('pageerror', (e) => errs.push(e.message)); p.on('dialog', (d) => d.accept()); });

  // --- uploader ---
  const up = await ctx.newPage();
  await up.goto(B + '/'); await up.waitForSelector('#drop');
  await up.setInputFiles('#pick', [`${FX}/small.png`, `${FX}/exact.png`, `${FX}/vid.mp4`]);
  const titles = await up.$$('.file input[type=text]');
  await titles[0].fill('Youth Night'); await up.fill('.file textarea', 'Fri 7pm');
  await up.click('#send');
  await up.waitForFunction(() => {
    const s = [...document.querySelectorAll('.file .small')];
    return s.length === 3 && s.every((e) => /Uploaded/.test(e.textContent));
  }, null, { timeout: 30000 });
  assert.match(await up.textContent('#done'), /Thank you! 3 files uploaded\. You can upload more as needed\./);
  assert.ok(await up.$('a[href="/admin"]'), 'admin icon on upload page');
  await up.screenshot({ path: `${OUT}/up-done.png` });
  console.log('✓ uploaded 3 files through the real upload page');

  // --- public display feed ---
  const d = await (await fetch(B + '/api/display')).json();
  assert.equal(d.items.length, 3, 'three items on display');
  assert.equal(d.items[0].title, 'Youth Night');
  for (const it of d.items.slice(0, 2)) {
    assert.equal(probe(Buffer.from(await (await fetch(it.url)).arrayBuffer())), '1920,1080', 'processed image is 1920x1080');
  }
  console.log('✓ display feed ok; fitted images are 1920x1080');
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  for (const it of fake.tables.items.filter((i) => i.kind === 'image')) {
    assert.ok(it.media_path.endsWith('.png'), 'screen-ready file is .png: ' + it.media_path);
    assert.ok(fake.buckets.media.get(it.media_path).data.subarray(0, 4).equals(PNG), 'bytes really are PNG');
  }
  console.log('✓ screen-ready images are lossless PNG');
  // older .jpg files can still be re-fitted as JPEG
  const fmts = await up.evaluate(async () => { const c = document.createElement('canvas'); c.width = 300; c.height = 200; c.getContext('2d').fillRect(0, 0, 300, 200);
    const f = await new Promise((r) => c.toBlob(r, 'image/png')), bg = await Fit.loadBg('/default-background.webp');
    return [(await Fit.fitImage(f, bg)).blob.type, (await Fit.fitImage(f, bg, 'jpg')).blob.type]; });
  assert.deepEqual(fmts, ['image/png', 'image/jpeg']);
  assert.equal(fake.tables.items.filter((i) => i.original_path).length, 2);
  assert.equal(fake.buckets.originals.size, 2);
  console.log('✓ originals kept privately for the 2 images; video stored once');

  const disp = await ctx.newPage(); await disp.goto(B + '/display'); await disp.waitForTimeout(2500);
  await disp.screenshot({ path: `${OUT}/display.png` });

  // --- admin ---
  const ad = await ctx.newPage(); await ad.goto(B + '/admin');
  assert.equal((await post('/api/admin', { a: 'items' })).status, 401);
  await ad.fill('#pw', 'wrong'); await ad.click('#lf button'); await ad.waitForSelector('#lerr:not([hidden])');
  await ad.fill('#pw', 'pw-test'); await ad.click('#lf button'); await ad.waitForSelector('.item');
  assert.equal((await ad.$$('.item')).length, 3);
  console.log('✓ admin login (bad password rejected) + file list');
  await ad.screenshot({ path: `${OUT}/admin.png` });
  const html = await ad.content();
  assert.ok(!/Open screen/.test(html) && !(await ad.$('button:has-text("Hide")')), 'no Open screen / Hide');
  assert.ok(await ad.$('a[href="/"][aria-label="Upload page"]'), 'upload page icon');
  // split Download button: arrow reveals Screen-ready / Original
  await ad.click('.item .caret'); await ad.waitForSelector('.menu:not([hidden]) >> text=Original');
  assert.ok(await ad.$('.menu:not([hidden]) >> text=Screen-ready')); await ad.keyboard.press('Escape');
  // regression: the menu must sit ON TOP of the card below it (narrow layout stacks the cards)
  await ad.setViewportSize({ width: 600, height: 900 });
  await ad.click('.item .caret'); await ad.waitForSelector('.menu:not([hidden])');
  const onTop = await ad.evaluate(() => {
    const m = [...document.querySelectorAll('.menu')].find((x) => !x.hidden), r = m.querySelector('button:last-child').getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!el.closest('.menu') && m.getBoundingClientRect().bottom > document.querySelectorAll('.item')[1].getBoundingClientRect().top;
  });
  assert.ok(onTop, 'menu overlaps the next card AND is on top of it');
  await ad.keyboard.press('Escape'); await ad.setViewportSize({ width: 1280, height: 720 });
  console.log('✓ Download menu pops over the card below');
  // regression: an unchanged refresh must not rebuild (= flash) the cards
  await ad.evaluate(() => { document.querySelector('.item').__keep = 1; });
  await ad.evaluate(async () => { await loadItems(); await loadItems(); });
  assert.ok(await ad.evaluate(() => document.querySelector('.item').__keep === 1), 'cards untouched on refresh');
  console.log('✓ refresh leaves unchanged cards alone (no flashing)');
  // plain Download = screen-ready
  const sd = await (await post('/api/admin', { a: 'download', id: fake.tables.items.find((i) => i.kind === 'image').id }, { cookie: await ctx.cookies().then((c) => c.map((x) => `${x.name}=${x.value}`).join('; ')) })).json();
  assert.ok(/object\/sign\/media\//.test(sd.url), 'default download is the screen-ready (media) file');
  // Download all (screen-ready, then originals)
  for (const [pick, expect, firstDims] of [[null, 3, '1920,1080'], ['Originals', 3, '400,300']]) {
    const [dl] = await Promise.all([ad.waitForEvent('download'), pick ? (async () => { await ad.click('#dlall .caret'); await ad.click(`#dlall .menu >> text=${pick}`); })() : ad.click('#dlall .main')]);
    const zf = path.join(OUT, 'dl.zip'); await dl.saveAs(zf);
    const names = execFileSync('unzip', ['-Z1', zf]).toString().trim().split('\n');
    assert.equal(names.length, expect, `zip has ${expect} files: ${names}`);
    assert.ok(names[0].endsWith('.png'), 'downloaded image is a .png: ' + names[0]);
    assert.equal(probe(execFileSync('unzip', ['-p', zf, names[0]], { maxBuffer: 1 << 26 })), firstDims, `first file in zip is ${firstDims}`);
    console.log(`✓ Download all (${pick || 'screen-ready'}) → ${dl.suggestedFilename()} with ${names.length} files`);
  }
  console.log('✓ no Open screen/Hide; Download split button + Download all work');

  const before = fake.tables.items.find((i) => i.kind === 'image' && !i.full_frame);
  const v0 = before.version;
  const beforeBytes = fake.buckets.media.get(before.media_path).data.length;
  await ad.click('[data-t=bg]'); await ad.setInputFiles('#bgf', `${FX}/newbg.png`);
  await ad.waitForFunction(() => /Done/.test(document.querySelector('#bgs').textContent), null, { timeout: 30000 });
  const after = fake.tables.items.find((i) => i.id === before.id);
  assert.ok(after.version > v0, 'image re-fitted after background change');
  assert.ok(/bg\/bg-\d+\.png/.test((await (await fetch(B + '/api/display')).json()).bg));
  const refit = fake.buckets.media.get(before.media_path).data;
  fs.writeFileSync(`${OUT}/refit.jpg`, refit);
  console.log(`✓ background changed and existing photo re-fitted (${beforeBytes} → ${refit.length} bytes)`);

  // --- settings + upload code ---
  await ad.click('[data-t=set]'); await ad.fill('#uploadCode', 'grace'); await ad.click('#save');
  await ad.waitForFunction(() => /Saved/.test(document.querySelector('#saved').textContent));
  assert.equal((await (await fetch(B + '/api/info')).json()).needsCode, true);
  assert.equal((await post('/api/upload', { action: 'sign', kind: 'image', size: 10 })).status, 401);
  console.log('✓ upload code enforced server-side');
  assert.equal((await ctx.request.post(B + '/api/code', { data: { code: 'grace' } })).status(), 200);
  const tooBig = await ctx.request.post(B + '/api/upload', { data: { action: 'sign', kind: 'video', ext: 'mp4', size: 80 * 1048576 } });
  assert.equal(tooBig.status(), 400);
  console.log('✓ oversize video rejected (50 MB limit)');

  // --- email alerts ---
  const aapi2 = (a, b = {}) => ad.evaluate(async ([a, b]) => { const r = await fetch('/api/admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a, ...b }) }); return { status: r.status, body: await r.json() }; }, [a, b]);
  const baseIds = fake.tables.items.map((i) => i.id);
  const notifyApi = (receipts) => ctx.request.post(B + '/api/upload', { data: { action: 'notify', receipts } });
  // uploads one file; unless notify:false, also sends the alert for it (a batch of one). Returns the "done" response.
  const uploadViaApi = async (title, { notify = true } = {}) => {
    const sg = await (await ctx.request.post(B + '/api/upload', { data: { action: 'sign', kind: 'image', ext: 'png', outExt: 'png', size: 1234 } })).json();
    for (const u of sg.uploads) fake.buckets[u.bucket].set(u.path, { data: Buffer.from('x') });
    const done = await ctx.request.post(B + '/api/upload', { data: { action: 'done', ticket: sg.ticket, title, description: 'desc <b>bold</b>', originalName: 'pic.png', srcW: 10, srcH: 10, fullFrame: false } });
    if (notify && done.ok()) await notifyApi([(await done.json()).receipt]);
    return done;
  };
  const receiptOf = async (res) => (await res.json()).receipt;
  assert.equal((await aapi2('settings-put', { notifyEmail: 'not-an-email' })).status, 400);
  const six = Array.from({ length: 6 }, (_, i) => `person${i + 1}@example.com`).join(', ');
  assert.equal((await aapi2('settings-put', { notifyEmail: Array.from({ length: 21 }, (_, i) => `p${i}@example.com`).join(',') })).status, 400, 'more than 20 rejected');
  assert.equal((await aapi2('settings-put', { notifyEmail: six })).status, 200, '6 addresses accepted');
  assert.equal((await aapi2('settings-get')).body.notifyEmail, six);
  const nSix = emails.length; assert.equal((await uploadViaApi('Six')).status(), 200);
  assert.equal(emails.length, nSix + 1); assert.deepEqual(emails.at(-1).to, six.split(', '), 'all 6 are alerted');
  console.log('✓ six recipients all get the alert');
  for (const it of fake.tables.items.filter((i) => i.title === 'Six')) await aapi2('delete', { id: it.id });
  assert.equal((await aapi2('settings-put', { notifyEmail: 'me@example.com' })).status, 200);
  assert.equal((await aapi2('notify-test', { email: 'you@example.com' })).status, 200);
  assert.deepEqual(emails.at(-1).to, ['you@example.com']);
  assert.match((await aapi2('notify-test', { email: 'fail@example.com' })).body.error, /^domain not verified\n/);
  const n0 = emails.length, xssTitle = '<script>alert(1)</script> Hello\nWorld';
  const r1 = await uploadViaApi(xssTitle); assert.equal(r1.status(), 200);
  assert.equal(emails.length, n0 + 1, 'one email per upload');
  const em = emails.at(-1);
  assert.deepEqual(em.to, ['me@example.com']); assert.match(em.subject, /^New image uploaded: /); assert.ok(!/[\r\n]/.test(em.subject), 'subject is one line');
  assert.ok(em.html.includes('&lt;script&gt;') && !em.html.includes('<script>'), 'HTML is escaped');
  assert.ok(em.html.includes('desc &lt;b&gt;bold&lt;/b&gt;') && /Download: http\S*\/view$/.test(em.text.trim()) && !/\/admin/.test(em.text + em.html) && />Download<\/a>/.test(em.html) && /Sunday, November 15/.test(em.text), 'email has details + a Download button to /view (no admin link)');
  console.log('✓ upload sends one email (escaped, one-line subject, Download button to /view)');
  // editable subject + intro with placeholders
  assert.equal((await aapi2('settings-put', { emailSubject: '[Church] {Title} ({type}) for {sunday} {nope}', emailIntro: 'Hi team,\n<b>New</b> for {sunday}: {file}' })).status, 200);
  const nTpl = emails.length; assert.equal((await uploadViaApi('Youth Night')).status(), 200);
  const tp = emails.at(-1); assert.equal(emails.length, nTpl + 1);
  assert.equal(tp.subject, '[Church] Youth Night (image) for November 15 {nope}', 'subject placeholders filled');
  assert.ok(tp.html.includes('Hi team,<br>&lt;b&gt;New&lt;/b&gt; for November 15: pic.png'), 'intro filled, escaped, newline kept');
  assert.ok(tp.text.startsWith('Hi team,\n<b>New</b> for November 15: pic.png\n\n'), 'intro in plain text too');
  const pv = await aapi2('notify-test', { email: 'you@example.com', emailSubject: 'Preview {title}', emailIntro: 'unsaved intro' });
  assert.equal(pv.status, 200); assert.equal(emails.at(-1).subject, 'TEST: Preview Sample photo, Another photo'); assert.ok(emails.at(-1).html.includes('unsaved intro'), 'test uses unsaved form values');
  assert.equal((await aapi2('settings-get')).body.emailSubject, '[Church] {TITLE} ({TYPE}) for {SUNDAY} {nope}', 'preview did not save; placeholders stored in CAPITALS (unknown ones untouched)');
  assert.equal((await aapi2('settings-get')).body.emailIntro, 'Hi team,\n<b>New</b> for {SUNDAY}: {FILE}');
  await aapi2('settings-put', { emailSubject: '   ', emailIntro: '' });
  assert.equal((await aapi2('settings-get')).body.emailSubject, 'New {TYPE} uploaded: {TITLE}', 'blank subject resets to the (uppercase) default');
  console.log('✓ email subject + intro are editable with placeholders; test previews unsaved edits');
  for (const it of fake.tables.items.filter((i) => i.title === 'Youth Night' && i.original_name === 'pic.png')) await aapi2('delete', { id: it.id });
  await aapi2('settings-put', { notifyEmail: 'fail@example.com' });
  const r2 = await uploadViaApi('Second'); assert.equal(r2.status(), 200, 'upload succeeds even if the email service rejects the email');
  await aapi2('settings-put', { notifyEmail: '' });
  const n1 = emails.length; const r3 = await uploadViaApi('Third'); assert.equal(r3.status(), 200); assert.equal(emails.length, n1, 'no email when blank');
  console.log('✓ email failures never block uploads; blank = no emails');

  // --- ONE email per batch ---
  assert.equal((await aapi2('settings-put', { notifyEmail: 'me@example.com', emailSubject: '', emailIntro: '' })).status, 200);
  const rA = await receiptOf(await uploadViaApi('Alpha', { notify: false })), rB = await receiptOf(await uploadViaApi('Beta', { notify: false })), rC = await receiptOf(await uploadViaApi('Gamma', { notify: false }));
  const nB = emails.length; assert.equal(emails.length, nB, 'uploading alone sends nothing yet');
  const n1b = await (await notifyApi([rA, rB, rC])).json(); assert.equal(n1b.sent, 3);
  assert.equal(emails.length, nB + 1, 'three files -> ONE email');
  const be = emails.at(-1);
  assert.equal(be.subject, 'New images uploaded: Alpha, Beta, Gamma'); assert.match(be.html, /New images uploaded \(3\)/);
  assert.ok(/1\. Alpha[\s\S]*2\. Beta[\s\S]*3\. Gamma/.test(be.text) && /\/view/.test(be.text), 'lists all three, in order, with the Download link');
  assert.equal((await (await notifyApi([rA, rB, rC])).json()).sent, 0); assert.equal(emails.length, nB + 1, 'replaying the same receipts sends nothing');
  assert.equal((await (await notifyApi(['garbage', 'a.b'])).json()).sent, 0); assert.equal(emails.length, nB + 1, 'forged receipts are ignored');
  const rD = await receiptOf(await uploadViaApi('Delta', { notify: false }));
  assert.equal((await (await notifyApi([rA, rD])).json()).sent, 1, 'only the not-yet-announced file is included');
  assert.equal(emails.length, nB + 2); assert.equal(emails.at(-1).subject, 'New image uploaded: Delta');
  const rE = await receiptOf(await uploadViaApi('Echo', { notify: false }));
  await Promise.all([notifyApi([rE]), notifyApi([rE])]); assert.equal(emails.length, nB + 3, 'two simultaneous requests -> still one email');
  const rF = await receiptOf(await uploadViaApi('Foxtrot', { notify: false }));
  await aapi2('delete', { id: fake.tables.items.find((i) => i.title === 'Foxtrot').id });
  assert.equal((await (await notifyApi([rF])).json()).sent, 0); assert.equal(emails.length, nB + 3, 'deleted files are not announced');
  await aapi2('settings-put', { emailSubject: 'New {COUNT} uploads: {TITLE}' });
  const rG = await receiptOf(await uploadViaApi('Golf', { notify: false })), rH = await receiptOf(await uploadViaApi('Hotel', { notify: false }));
  await notifyApi([rG, rH]); assert.equal(emails.at(-1).subject, 'New 2 uploads: Golf, Hotel', '{COUNT} works');
  await aapi2('settings-put', { emailSubject: '' });
  console.log('✓ one email per batch; each file announced at most once (replays, races, forged + deleted ignored)');
  // the real upload page: two files -> one email
  await aapi2('settings-put', { notifyEmail: 'me@example.com' });
  const nUi = emails.length, up2 = await ctx.newPage();
  await up2.goto(B + '/'); await up2.waitForSelector('#drop');
  await up2.setInputFiles('#pick', [`${FX}/small.png`, `${FX}/exact.png`]); await up2.click('#send');
  await up2.waitForFunction(() => { const s = [...document.querySelectorAll('.file .small')]; return s.length === 2 && s.every((e) => /Uploaded/.test(e.textContent)); }, null, { timeout: 30000 });
  for (let i = 0; i < 40 && emails.length === nUi; i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(emails.length, nUi + 1, 'upload page sends ONE email for two files');
  assert.equal(emails.at(-1).subject, 'New images uploaded: small.png, exact.png');
  await up2.close();
  console.log('✓ upload page: 2 files -> 1 email');
  for (const it of fake.tables.items.filter((i) => i.week_key === d.weekKey && !baseIds.includes(i.id))) await aapi2('delete', { id: it.id });
  for (const it of fake.tables.items.filter((i) => ['Second', 'Third', xssTitle].includes(i.title))) await aapi2('delete', { id: it.id });

  // --- email alerts via SMTP (Gmail-style): one message, recipients on BCC ---
  const { SMTPServer } = require('smtp-server');
  const got = { rcpt: [], raw: '' };
  const smtp = new SMTPServer({
    authOptional: false, allowInsecureAuth: true, disabledCommands: ['STARTTLS'],
    onAuth: (a, sess, cb) => (['app-pass', 'abcdefghijklmnop'].includes(a.password) ? cb(null, { user: a.username }) : cb(new Error('Invalid login'))),
    onRcptTo: (addr, sess, cb) => { got.rcpt.push(addr.address); cb(); },
    onData: (stream, sess, cb) => { let d = ''; stream.on('data', (c) => (d += c)); stream.on('end', () => { got.raw = d; cb(); }); },
  });
  await new Promise((r) => smtp.listen(2525, '127.0.0.1', r));
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_USER: 'church@example.com', SMTP_PASS: 'app-pass' });
  assert.equal((await aapi2('settings-put', { notifyEmail: six })).status, 200);
  const resendBefore = emails.length;
  assert.equal((await uploadViaApi('ViaSmtp')).status(), 200);
  assert.equal(emails.length, resendBefore, 'Resend not used when SMTP is configured');
  assert.deepEqual([...got.rcpt].sort(), [...six.split(', '), 'church@example.com'].sort(), 'all six + the sender are SMTP recipients');
  assert.match(got.raw, /Subject: New image uploaded: ViaSmtp/); assert.match(got.raw, /To: church@example\.com/);
  assert.ok(!got.raw.includes('person3@example.com'), 'BCC recipients are not visible in the message');
  console.log('✓ SMTP (Gmail-style): all 6 recipients alerted on BCC, none visible to the others');
  process.env.SMTP_PASS = 'wrong-password';
  const bad = await aapi2('notify-test', { email: 'you@example.com' });
  assert.equal(bad.status, 502); assert.match(bad.body.error, /App Password/);
  assert.equal((await uploadViaApi('StillWorks')).status(), 200, 'bad email login never blocks an upload');
  console.log('✓ wrong app password gives a clear message and never blocks uploads');
  process.env.SMTP_PASS = 'abcd efgh ijkl mnop'; // pasted the way Google displays it (with spaces)
  assert.equal((await aapi2('notify-test', { email: 'you@example.com' })).status, 200, 'spaces in a Google app password are ignored');
  console.log('✓ app password pasted with spaces still works');
  const keepPass = process.env.SMTP_PASS; delete process.env.SMTP_PASS;
  assert.match((await aapi2('notify-test', { email: 'you@example.com' })).body.error, /SMTP_PASS is missing/, 'names the missing variable');
  assert.match((await aapi2('notify-test', { email: 'you@example.com' })).body.error, /Detected: SMTP_USER ✓, SMTP_PASS ✗.*version:/s, 'shows what the server can see');
  process.env.SMTP_PASS = keepPass; delete process.env.SMTP_USER;
  assert.match((await aapi2('notify-test', { email: 'you@example.com' })).body.error, /SMTP_USER is missing/);
  delete process.env.SMTP_PASS; await new Promise((r) => smtp.close(r));
  for (const it of fake.tables.items.filter((i) => ['ViaSmtp', 'StillWorks'].includes(i.title))) await aapi2('delete', { id: it.id });

  // --- order: first uploaded -> last uploaded ---
  const uploadOrder = fake.tables.items.filter((i) => i.week_key === d.weekKey).map((i) => i.id); // insertion order = upload order
  assert.deepEqual((await (await fetch(B + '/api/display')).json()).items.map((i) => i.id), uploadOrder, 'screen: first uploaded first');
  assert.deepEqual((await aapi2('items')).body.items.map((i) => i.id), uploadOrder, 'admin: first uploaded first');
  // a new upload always lands last, even after an admin moved things around
  assert.equal((await aapi2('move', { id: uploadOrder[0], dir: 'down' })).status, 200);
  assert.deepEqual((await aapi2('items')).body.items.map((i) => i.id), [uploadOrder[1], uploadOrder[0], uploadOrder[2]], 'manual move still works');
  assert.equal((await uploadViaApi('Late', { notify: false })).status(), 200);
  const afterLate = (await aapi2('items')).body.items;
  assert.equal(afterLate.at(-1).title, 'Late', 'new upload goes to the end');
  await aapi2('delete', { id: afterLate.at(-1).id });
  assert.equal((await aapi2('move', { id: uploadOrder[0], dir: 'up' })).status, 200);
  assert.deepEqual((await aapi2('items')).body.items.map((i) => i.id), uploadOrder, 'moved back');
  // items with the SAME sort position are ordered by upload time, and can still be moved
  const tw = '2026-10-26';
  for (const [id, at] of [['t2', '2026-10-26T10:00:05Z'], ['t1', '2026-10-26T10:00:01Z']]) {
    fake.tables.items.push({ id, week_key: tw, kind: 'image', media_path: `${tw}/${id}.jpg`, hidden: false, version: 1, sort_order: 5, created_at: at });
  }
  assert.deepEqual((await aapi2('items', { week: tw })).body.items.map((i) => i.id), ['t1', 't2'], 'ties: earlier upload first');
  assert.equal((await aapi2('move', { id: 't1', dir: 'down' })).status, 200);
  assert.deepEqual((await aapi2('items', { week: tw })).body.items.map((i) => i.id), ['t2', 't1'], 'a move works even when positions tied');
  assert.deepEqual(fake.tables.items.filter((i) => i.week_key === tw).map((i) => i.sort_order).sort(), [1, 2], 'positions renumbered uniquely');
  console.log('✓ default order is first uploaded → last uploaded (screen, admin); new uploads go last; ties handled');

  // --- volunteer viewer (read-only login) ---
  const vcall = (a, b = {}, cookie = '') => fetch(B + '/api/view', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ a, ...b }) });
  const acall = (a, b = {}, cookie = '') => fetch(B + '/api/admin', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ a, ...b }) });
  const itemsBefore = fake.tables.items.length;
  const off = await vcall('login', { password: 'anything' }); assert.equal(off.status, 401); assert.match((await off.json()).error, /not been turned on/);
  assert.equal((await aapi2('settings-put', { viewerPassword: 'volunteer1' })).status, 200);
  assert.equal((await vcall('items')).status, 401, 'not signed in');
  assert.equal((await vcall('login', { password: 'nope' })).status, 401);
  const vl = await vcall('login', { password: 'volunteer1' }); assert.equal(vl.status, 200);
  const vck = vl.headers.get('set-cookie').split(';')[0]; assert.match(vck, /^vwr=/);
  const vi = await (await vcall('items', {}, vck)).json();
  assert.equal(vi.items.length, 3);
  assert.deepEqual(vi.items.map((i) => i.id), uploadOrder, 'volunteer page: first uploaded first');
  for (const it of vi.items) { for (const k of ['uploader', 'hidden', 'order', 'customDuration', 'createdAt']) assert.ok(!(k in it), `viewer items hide ${k}`); }
  const vdl = await (await vcall('download', { id: vi.items[0].id, which: 'original' }, vck)).json(); assert.match(vdl.url, /\/object\/sign\/originals\//);
  assert.equal((await (await vcall('download-all', { week: vi.week, which: 'media' }, vck)).json()).files.length, 3);
  // the viewer cookie must not unlock ANY admin action
  for (const [a, extra] of [['items', {}], ['settings-get', {}], ['settings-put', { uploadCode: 'x' }], ['delete', { id: vi.items[0].id }], ['update', { id: vi.items[0].id, title: 'hacked' }], ['move', { id: vi.items[0].id, dir: 'up' }], ['bg-reset', {}], ['purge', {}], ['notify-test', { email: 'a@b.co' }]]) {
    assert.equal((await acall(a, extra, vck)).status, 401, `viewer cannot ${a}`);
  }
  assert.equal((await vcall('delete', { id: vi.items[0].id }, vck)).status, 400, 'no write actions exist on the viewer API');
  assert.equal(fake.tables.items.length, itemsBefore, 'nothing changed');
  assert.ok(!fake.tables.items.some((i) => i.title === 'hacked'));
  console.log('✓ viewer: can list + download, cannot change anything; hides admin-only fields');
  // admin may also use the viewer API; switching the password off locks viewers out at once
  const admCookie = (await ctx.cookies()).map((x) => `${x.name}=${x.value}`).join('; ');
  assert.equal((await vcall('items', {}, admCookie)).status, 200, 'admin can view too');
  assert.equal((await aapi2('settings-put', { viewerPassword: '' })).status, 200);
  assert.equal((await vcall('items', {}, vck)).status, 401, 'blank password locks existing viewer sessions out');
  assert.equal((await aapi2('settings-put', { viewerPassword: 'volunteer1' })).status, 200);
  console.log('✓ viewer password can be turned off instantly');

  // the real page, in a fresh browser (no admin cookie)
  const vctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await vctx.route('**/cdnjs.cloudflare.com/**', (r) => r.fulfill({ path: path.join(__dirname, '..', 'node_modules/jszip/dist/jszip.min.js'), contentType: 'text/javascript' }));
  await vctx.route('**/fonts.g*apis.com/**', (r) => r.abort());
  const vp = await vctx.newPage(); vp.on('pageerror', (e) => errs.push(e.message));
  await vp.goto(B + '/view'); await vp.waitForSelector('#lf');
  await vp.fill('#pw', 'wrong'); await vp.click('#lf button'); await vp.waitForSelector('#lerr:not([hidden])');
  await vp.fill('#pw', 'volunteer1'); await vp.click('#lf button'); await vp.waitForSelector('.item');
  assert.equal((await vp.$$('.item')).length, 3);
  assert.equal(await vp.locator('#items input, #items textarea, #items button:has-text("Delete"), #items button:has-text("Hide")').count(), 0, 'no editing controls');
  assert.equal(await vp.locator('a[href="/admin"]').count(), 0, 'no link to admin');
  await vp.screenshot({ path: `${OUT}/view.png` });
  await vp.click('.item .caret'); await vp.waitForSelector('.menu:not([hidden]) >> text=Original'); await vp.keyboard.press('Escape');
  const [vdlz] = await Promise.all([vp.waitForEvent('download'), vp.click('#dlall .main')]);
  const vzf = path.join(OUT, 'view.zip'); await vdlz.saveAs(vzf);
  assert.equal(execFileSync('unzip', ['-Z1', vzf]).toString().trim().split('\n').length, 3);
  await vp.evaluate(() => loadItems()); assert.equal((await vp.$$('.item')).length, 3);
  await vp.click('#out'); await vp.waitForSelector('#lf:visible');
  await vctx.close();
  console.log('✓ /view page: sign in, view, preview, Download / Download all, sign out — no editing controls');

  // --- weekly auto-delete ---
  const old = '2026-11-02';
  fake.tables.items.push({ id: 'old1', week_key: old, kind: 'image', media_path: `${old}/old1.jpg`, original_path: `${old}/old1.png`, hidden: false, version: 1, sort_order: 1 });
  fake.buckets.media.set(`${old}/old1.jpg`, { data: Buffer.from('x') });
  fake.buckets.originals.set(`${old}/old1.png`, { data: Buffer.from('x') });
  assert.equal((await fetch(B + '/api/cron')).status, 401);
  assert.equal((await fetch(B + '/api/cron', { headers: { authorization: 'Bearer cronsecret' } })).status, 200);
  assert.ok(!fake.tables.items.some((i) => i.id === 'old1'));
  assert.ok(!fake.buckets.media.has(`${old}/old1.jpg`) && !fake.buckets.originals.has(`${old}/old1.png`));
  assert.equal(fake.tables.items.filter((i) => i.week_key === d.weekKey).length, 3, 'current week untouched');
  console.log('✓ cron deletes last week (db rows + files) and keeps this week');

  console.log('page errors:', errs);
  assert.deepEqual(errs, []);
  await browser.close(); srv.close();
  console.log('ALL PASSED  (screenshots in ' + OUT + ')');
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
