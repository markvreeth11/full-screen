const crypto = require('crypto');
const c = require('./_lib/common');

// Two-step upload. The browser never gets database access; it only receives
// short-lived signed URLs for the exact files this ticket allows.
module.exports = c.wrap(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const s = await c.getSettings();
  if (!c.canUpload(req, s)) return res.status(401).json({ error: 'Upload code required' });
  if (!s.uploadsOpen && !c.isAdmin(req)) return res.status(403).json({ error: 'Uploads are currently closed' });
  const b = req.body || {};
  const sb = c.sb();

  if (b.action === 'sign') {
    const kind = b.kind === 'video' ? 'video' : b.kind === 'image' ? 'image' : null;
    if (!kind) return res.status(400).json({ error: 'Only images and videos can be uploaded' });
    const limit = kind === 'video' ? s.maxVideoMB : c.MAX_IMAGE_MB;
    if (!(+b.size > 0)) return res.status(400).json({ error: 'Empty file' });
    if (+b.size > limit * 1048576) return res.status(400).json({ error: `${kind === 'video' ? 'Videos' : 'Images'} can be at most ${limit} MB` });
    const ext = /^[a-z0-9]{1,5}$/.test(String(b.ext || '').toLowerCase()) ? String(b.ext).toLowerCase() : kind === 'video' ? 'mp4' : 'jpg';
    const outExt = b.outExt === 'png' ? 'png' : 'jpg';
    const id = crypto.randomUUID(), week = c.currentWeek(s);
    const targets = kind === 'image'
      ? [{ bucket: 'originals', path: `${week}/${id}.${ext}` }, { bucket: 'media', path: `${week}/${id}.${outExt}` }]
      : [{ bucket: 'media', path: `${week}/${id}.${ext}` }];
    const uploads = [];
    for (const t of targets) {
      const { data, error } = await sb.storage.from(t.bucket).createSignedUploadUrl(t.path);
      if (error) throw error;
      uploads.push({ ...t, token: data.token });
    }
    const ticket = c.mkTicket({
      id, kind, exp: Date.now() + 2 * 3600e3,
      media: targets[targets.length - 1].path, original: kind === 'image' ? targets[0].path : null,
    });
    return res.json({ ticket, uploads });
  }

  if (b.action === 'done') {
    const t = c.readTicket(b.ticket);
    if (!t) return res.status(400).json({ error: 'Upload expired — please try again' });
    if (!(await c.exists('media', t.media)) || (t.original && !(await c.exists('originals', t.original)))) {
      return res.status(400).json({ error: 'The file did not finish uploading' });
    }
    const week = c.currentWeek(s);
    const { data: last } = await sb.from('items').select('sort_order').eq('week_key', week).order('sort_order', { ascending: false }).limit(1);
    const num = (v) => (Number.isFinite(+v) && +v > 0 ? Math.round(+v) : null);
    const { error } = await sb.from('items').insert({
      id: t.id, week_key: week, kind: t.kind, title: c.clip(b.title, 120), description: c.clip(b.description, 400),
      uploader: c.clip(b.uploader, 80), original_name: c.clip(b.originalName, 200),
      original_path: t.original, media_path: t.media, src_w: num(b.srcW), src_h: num(b.srcH),
      full_frame: t.kind === 'image' ? !!b.fullFrame : null, duration: +b.duration > 0 ? +b.duration : null,
      sort_order: ((last && last[0] && last[0].sort_order) || 0) + 1, version: Date.now(),
    });
    if (error) throw error;
    return res.json({ id: t.id });
  }
  res.status(400).json({ error: 'Bad request' });
});
