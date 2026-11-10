const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { ZipArchive } = require('archiver');
const store = require('./lib/store');
const media = require('./lib/media');
const { weekKey, weekRange } = require('./lib/week');

const { DIRS } = store;
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

const S = () => store.db.settings;
const currentWeek = (d = new Date()) => weekKey(d, S());
const uid = () => crypto.randomBytes(9).toString('hex');

// ---------- auth (signed cookies) ----------
const sign = (v) => crypto.createHmac('sha256', store.db.auth.secret).update(v).digest('hex');
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((c) => {
    const i = c.indexOf('='); return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
  }));
}
const mk = (role, days) => { const v = `${role}.${Date.now() + days * 864e5}`; return `${v}.${sign(v)}`; };
function valid(tok, role) {
  const [r, exp, sig] = String(tok || '').split('.');
  if (r !== role || !exp || !sig) return false;
  const good = sign(`${r}.${exp}`);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)) && +exp > Date.now();
}
const setCookie = (res, name, val, days) =>
  res.append('Set-Cookie', `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}`);
const isAdmin = (req) => valid(cookies(req).adm, 'admin');
const canUpload = (req) => !S().uploadCode || isAdmin(req) || valid(cookies(req).upl, 'upload');
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(401).json({ error: 'Not signed in' }));

// crude login throttle
const fails = new Map();
function throttled(req) {
  const e = fails.get(req.ip); return e && e.n >= 8 && Date.now() - e.t < 15 * 60e3;
}
function noteFail(req) { const e = fails.get(req.ip) || { n: 0 }; fails.set(req.ip, { n: e.n + 1, t: Date.now() }); }

// ---------- processing queue ----------
const queue = [];
let working = false;
const find = (id) => store.db.items.find((i) => i.id === id);
function enqueue(id) { if (!queue.includes(id)) queue.push(id); pump(); }
async function pump() {
  if (working) return;
  working = true;
  while (queue.length) {
    const it = find(queue.shift());
    if (!it) continue;
    it.status = 'processing'; it.error = null; store.save();
    try {
      const src = path.join(DIRS.originals, it.original);
      const base = path.join(DIRS.processed, it.id);
      for (const f of fs.readdirSync(DIRS.processed)) if (f.startsWith(it.id + '.')) fs.unlinkSync(path.join(DIRS.processed, f));
      const r = it.kind === 'image'
        ? await media.processImage(src, base, store.bgPath())
        : await media.processVideo(src, base, store.bgPath());
      it.output = r.file; it.fullFrame = r.fullFrame; it.srcW = r.srcW; it.srcH = r.srcH;
      if (r.duration) it.duration = r.duration;
      await media.makeThumb(it.kind, path.join(DIRS.processed, r.file), path.join(DIRS.thumbs, it.id + '.jpg')).catch(() => {});
      it.status = 'ready'; it.version = Date.now();
    } catch (e) {
      it.status = 'error'; it.error = String(e.message || e).slice(0, 300);
      console.error('process failed', it.id, e.message);
    }
    store.save();
  }
  working = false;
}

// ---------- helpers ----------
function removeFiles(it) {
  const rm = (dir, pre) => { try { for (const f of fs.readdirSync(dir)) if (f.startsWith(pre)) fs.unlinkSync(path.join(dir, f)); } catch {} };
  rm(DIRS.originals, it.id + '.'); rm(DIRS.processed, it.id + '.'); rm(DIRS.thumbs, it.id + '.');
}
const clip = (s, n) => String(s || '').trim().slice(0, n);
const weekItems = (key) => store.db.items.filter((i) => i.weekKey === key).sort((a, b) => a.order - b.order);
const nextOrder = (key) => weekItems(key).reduce((m, i) => Math.max(m, i.order), 0) + 1;
function pub(it) {
  return {
    id: it.id, kind: it.kind, title: it.title, description: it.description, uploader: it.uploader,
    status: it.status, error: it.error, weekKey: it.weekKey, order: it.order, hidden: !!it.hidden,
    duration: it.duration || null, customDuration: it.customDuration || null, fullFrame: it.fullFrame,
    srcW: it.srcW, srcH: it.srcH, originalName: it.originalName, createdAt: it.createdAt, version: it.version || 0,
  };
}
function purgeOld() {
  const keep = Math.max(1, +S().keepWeeks || 8);
  const cutoff = Date.parse(currentWeek() + 'T00:00:00Z') - (keep - 1) * 7 * 864e5;
  const old = store.db.items.filter((i) => Date.parse(i.weekKey + 'T00:00:00Z') < cutoff);
  old.forEach(removeFiles);
  if (old.length) { store.db.items = store.db.items.filter((i) => !old.includes(i)); store.save(); }
}

// ---------- public API ----------
const bgUrl = () => `/media/background?v=${S().bgVersion}`;
app.get('/api/public/info', (req, res) => {
  const key = currentWeek();
  res.json({
    churchName: S().churchName, weekKey: key, range: weekRange(key), uploadsOpen: S().uploadsOpen,
    needsCode: !!S().uploadCode && !canUpload(req), bg: bgUrl(), maxUploadMB: S().maxUploadMB,
  });
});
app.post('/api/public/login', (req, res) => {
  if (throttled(req)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  if (!S().uploadCode || clip(req.body.code, 100) === S().uploadCode) {
    setCookie(res, 'upl', mk('upload', 30), 30); return res.json({ ok: true });
  }
  noteFail(req); res.status(401).json({ error: 'That code is not right.' });
});

app.post('/api/upload', (req, res) => {
  if (!canUpload(req)) return res.status(401).json({ error: 'Upload code required' });
  if (!S().uploadsOpen && !isAdmin(req)) return res.status(403).json({ error: 'Uploads are currently closed' });
  const up = multer({
    storage: multer.diskStorage({
      destination: DIRS.tmp,
      filename: (r, f, cb) => cb(null, uid() + path.extname(f.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')),
    }),
    limits: { fileSize: (+S().maxUploadMB || 2048) * 1048576, files: 1 },
  }).single('file');
  up(req, res, (err) => {
    const f = req.file;
    const fail = (code, msg) => { if (f) fs.unlink(f.path, () => {}); res.status(code).json({ error: msg }); };
    if (err) return fail(400, err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${S().maxUploadMB} MB` : err.message);
    if (!f) return fail(400, 'No file received');
    const kind = f.mimetype.startsWith('image/') ? 'image' : f.mimetype.startsWith('video/') ? 'video' : null;
    if (!kind) return fail(400, 'Only images and videos can be uploaded');
    const id = uid();
    const original = id + (path.extname(f.filename) || '');
    fs.renameSync(f.path, path.join(DIRS.originals, original));
    const key = currentWeek();
    const it = {
      id, weekKey: key, kind, original, originalName: clip(f.originalname, 200),
      title: clip(req.body.title, 120), description: clip(req.body.description, 400),
      uploader: clip(req.body.uploader, 80), status: 'queued', order: nextOrder(key), createdAt: Date.now(),
    };
    store.db.items.push(it); store.save(); enqueue(id);
    res.json({ id });
  });
});

// Lets an uploader see whether their files finished processing.
app.get('/api/public/status', (req, res) => {
  const ids = String(req.query.ids || '').split(',').slice(0, 100);
  res.json(ids.map(find).filter(Boolean).map((i) => ({ id: i.id, status: i.status, error: i.error })));
});

// Playlist for the on-screen player.
app.get('/api/display', (req, res) => {
  const key = currentWeek();
  const items = weekItems(key).filter((i) => i.status === 'ready' && !i.hidden).map((i) => ({
    id: i.id, kind: i.kind, title: i.title, description: i.description,
    url: `/media/${i.id}?v=${i.version}`, duration: i.customDuration || null,
  }));
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    weekKey: key, bg: bgUrl(), items,
    settings: { imageDuration: S().imageDuration, showCaptions: S().showCaptions, transition: S().transition },
  });
});

app.get('/media/background', (req, res) => res.sendFile(store.bgPath(), { maxAge: '1d' }));
app.get('/media/:id', (req, res) => {
  const it = find(req.params.id);
  if (!it || !it.output) return res.sendStatus(404);
  res.sendFile(path.join(DIRS.processed, it.output), { maxAge: '7d', immutable: true });
});
app.get('/thumb/:id', (req, res) => {
  const f = path.join(DIRS.thumbs, path.basename(req.params.id) + '.jpg');
  fs.existsSync(f) ? res.sendFile(f, { maxAge: '1d' }) : res.sendStatus(404);
});

// ---------- admin API ----------
app.post('/api/admin/login', (req, res) => {
  if (throttled(req)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  if (store.checkPassword(req.body.password || '', store.db.auth.hash)) {
    setCookie(res, 'adm', mk('admin', 14), 14); return res.json({ ok: true });
  }
  noteFail(req); res.status(401).json({ error: 'Wrong password' });
});
app.post('/api/admin/logout', (req, res) => { setCookie(res, 'adm', '', 0); res.json({ ok: true }); });
app.get('/api/admin/me', (req, res) => res.json({ admin: isAdmin(req) }));

const admin = express.Router();
admin.use(adminOnly);

admin.get('/items', (req, res) => {
  const cur = currentWeek();
  const weeks = [...new Set([cur, ...store.db.items.map((i) => i.weekKey)])].sort().reverse();
  const key = weeks.includes(req.query.week) ? req.query.week : cur;
  res.json({
    current: cur, week: key, range: weekRange(key),
    weeks: weeks.map((k) => ({ key: k, count: store.db.items.filter((i) => i.weekKey === k).length })),
    items: weekItems(key).map(pub),
  });
});
admin.patch('/items/:id', (req, res) => {
  const it = find(req.params.id); if (!it) return res.sendStatus(404);
  const b = req.body;
  if ('title' in b) it.title = clip(b.title, 120);
  if ('description' in b) it.description = clip(b.description, 400);
  if ('hidden' in b) it.hidden = !!b.hidden;
  if ('customDuration' in b) it.customDuration = +b.customDuration > 0 ? Math.min(600, +b.customDuration) : null;
  store.save(); res.json(pub(it));
});
admin.post('/items/:id/move', (req, res) => {
  const it = find(req.params.id); if (!it) return res.sendStatus(404);
  const list = weekItems(it.weekKey); const i = list.indexOf(it);
  const j = req.body.dir === 'up' ? i - 1 : i + 1;
  if (list[j]) { [list[i].order, list[j].order] = [list[j].order, list[i].order]; store.save(); }
  res.json({ ok: true });
});
admin.post('/items/:id/reprocess', (req, res) => {
  const it = find(req.params.id); if (!it) return res.sendStatus(404);
  it.status = 'queued'; store.save(); enqueue(it.id); res.json({ ok: true });
});
admin.delete('/items/:id', (req, res) => {
  const it = find(req.params.id); if (!it) return res.sendStatus(404);
  removeFiles(it); store.db.items = store.db.items.filter((i) => i !== it); store.save(); res.json({ ok: true });
});
admin.get('/items/:id/download', (req, res) => {
  const it = find(req.params.id); if (!it) return res.sendStatus(404);
  const orig = req.query.which === 'original';
  const file = path.join(orig ? DIRS.originals : DIRS.processed, orig ? it.original : it.output || '');
  const base = (it.title || path.parse(it.originalName).name).replace(/[^\w\- ]+/g, '').trim() || it.id;
  res.download(file, orig ? it.originalName : `${base}${path.extname(file)}`);
});
admin.get('/weeks/:key/zip', (req, res) => {
  const items = weekItems(req.params.key); if (!items.length) return res.sendStatus(404);
  const orig = req.query.which === 'original';
  res.attachment(`${orig ? 'originals' : 'screen-ready'}-week-${req.params.key}.zip`);
  const z = new ZipArchive({ store: true });
  z.on('error', () => res.end());
  z.pipe(res);
  items.forEach((it, n) => {
    const name = (it.title || path.parse(it.originalName).name).replace(/[^\w\- ]+/g, '').trim() || it.id;
    const file = orig ? path.join(DIRS.originals, it.original) : it.output && path.join(DIRS.processed, it.output);
    if (file && fs.existsSync(file)) z.file(file, { name: `${String(n + 1).padStart(2, '0')} ${name}${path.extname(file)}` });
  });
  z.finalize();
});

admin.get('/settings', (req, res) => res.json({ ...S(), bg: bgUrl(), currentWeek: currentWeek() }));
admin.put('/settings', (req, res) => {
  const b = req.body, s = S();
  const num = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
  if ('churchName' in b) s.churchName = clip(b.churchName, 80) || s.churchName;
  if ('timezone' in b) {
    try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); s.timezone = b.timezone; }
    catch { return res.status(400).json({ error: 'Unknown time zone' }); }
  }
  if ('rolloverDay' in b) s.rolloverDay = Math.round(num(b.rolloverDay, 0, 6, s.rolloverDay));
  if ('rolloverHour' in b) s.rolloverHour = Math.round(num(b.rolloverHour, 0, 23, s.rolloverHour));
  if ('imageDuration' in b) s.imageDuration = num(b.imageDuration, 2, 600, s.imageDuration);
  if ('showCaptions' in b) s.showCaptions = !!b.showCaptions;
  if ('transition' in b) s.transition = b.transition === 'none' ? 'none' : 'fade';
  if ('uploadCode' in b) s.uploadCode = clip(b.uploadCode, 100);
  if ('uploadsOpen' in b) s.uploadsOpen = !!b.uploadsOpen;
  if ('keepWeeks' in b) s.keepWeeks = Math.round(num(b.keepWeeks, 1, 104, s.keepWeeks));
  if ('maxUploadMB' in b) s.maxUploadMB = Math.round(num(b.maxUploadMB, 10, 20000, s.maxUploadMB));
  store.save(); res.json({ ...s, bg: bgUrl(), currentWeek: currentWeek() });
});
admin.post('/password', (req, res) => {
  const { current, next } = req.body;
  if (!store.checkPassword(current || '', store.db.auth.hash)) return res.status(400).json({ error: 'Current password is wrong' });
  if (String(next || '').length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  store.db.auth.hash = store.hashPassword(next);
  store.db.auth.secret = crypto.randomBytes(32).toString('hex'); // signs everyone else out
  store.save(); setCookie(res, 'adm', mk('admin', 14), 14); res.json({ ok: true });
});

// Background: change it, then re-render every non-exact-size item that is still on screen.
function rerenderAll() {
  store.db.items.filter((i) => i.fullFrame === false && i.status !== 'queued')
    .forEach((i) => { i.status = 'queued'; enqueue(i.id); });
  store.save();
}
admin.post('/background', multer({ dest: DIRS.tmp, limits: { fileSize: 50 * 1048576 } }).single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  try {
    await media.makeBackground(req.file.path, store.bgPath());
    S().bgVersion++; store.save(); rerenderAll();
    res.json({ bg: bgUrl() });
  } catch (e) { res.status(400).json({ error: 'That file is not a usable image' }); }
  finally { fs.unlink(req.file.path, () => {}); }
});
admin.post('/background/reset', async (req, res) => {
  await media.makeBackground(path.join(__dirname, 'assets', 'default-background.webp'), store.bgPath());
  S().bgVersion++; store.save(); rerenderAll(); res.json({ bg: bgUrl() });
});
app.use('/api/admin', admin);

// ---------- pages ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'upload.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], index: false }));

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });

(async () => {
  if (!fs.existsSync(store.bgPath())) {
    await media.makeBackground(path.join(__dirname, 'assets', 'default-background.webp'), store.bgPath());
  }
  for (const f of fs.readdirSync(DIRS.tmp)) fs.unlink(path.join(DIRS.tmp, f), () => {});
  store.db.items.filter((i) => i.status === 'queued' || i.status === 'processing').forEach((i) => enqueue(i.id));
  purgeOld(); setInterval(purgeOld, 3600e3);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Upload page: http://localhost:${port}/\nAdmin:       http://localhost:${port}/admin\nScreen:      http://localhost:${port}/display`));
})();
