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
  // plain Download = screen-ready
  const sd = await (await post('/api/admin', { a: 'download', id: fake.tables.items.find((i) => i.kind === 'image').id }, { cookie: await ctx.cookies().then((c) => c.map((x) => `${x.name}=${x.value}`).join('; ')) })).json();
  assert.ok(/object\/sign\/media\//.test(sd.url), 'default download is the screen-ready (media) file');
  // Download all (screen-ready, then originals)
  for (const [pick, expect, firstExt] of [[null, 3, '.jpg'], ['Originals', 3, '.png']]) {
    const [dl] = await Promise.all([ad.waitForEvent('download'), pick ? (async () => { await ad.click('#dlall .caret'); await ad.click(`#dlall .menu >> text=${pick}`); })() : ad.click('#dlall .main')]);
    const zf = path.join(OUT, 'dl.zip'); await dl.saveAs(zf);
    const names = execFileSync('unzip', ['-Z1', zf]).toString().trim().split('\n');
    assert.equal(names.length, expect, `zip has ${expect} files: ${names}`);
    assert.ok(names[0].endsWith(firstExt), `first file is ${firstExt}: ${names[0]}`);
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
  assert.ok(/bg\/bg-\d+\.jpg/.test((await (await fetch(B + '/api/display')).json()).bg));
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
