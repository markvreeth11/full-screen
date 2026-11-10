const c = require('./_lib/common');
const F = require('./_lib/files');

// Volunteer viewer: sign in with the viewer password (set by the admin) to see and download uploads.
// Strictly read-only — there is no edit/delete/reorder/settings action here, and the viewer cookie is
// not accepted by the admin API.
const pubViewer = (i) => ({
  id: i.id, kind: i.kind, title: i.title, description: i.description, originalName: i.original_name,
  srcW: i.src_w, srcH: i.src_h, fullFrame: i.full_frame,
  url: `${c.publicUrl(i.media_path)}?v=${i.version}`, hasOriginal: !!i.original_path,
});

module.exports = c.wrap(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const b = req.body || {};
  const s = await c.getSettings();
  const allowed = c.isAdmin(req) || c.validToken(c.cookies(req).vwr, 'viewer');

  if (b.a === 'login') {
    if (s.viewerPassword && c.safeEq(c.clip(b.password, 100), s.viewerPassword)) {
      c.setCookie(req, res, 'vwr', c.mkToken('viewer', 14), 14);
      return res.json({ ok: true });
    }
    await new Promise((r) => setTimeout(r, 600));
    return res.status(401).json({ error: s.viewerPassword ? 'Wrong password' : 'The volunteer page has not been turned on yet. Ask an admin.' });
  }
  if (b.a === 'logout') { c.setCookie(req, res, 'vwr', '', 0); return res.json({ ok: true }); }
  if (b.a === 'me') return res.json({ viewer: allowed && !!(s.viewerPassword || c.isAdmin(req)) });
  // Turning the password off (blank) locks every existing viewer session out immediately.
  if (!allowed || (!s.viewerPassword && !c.isAdmin(req))) return res.status(401).json({ error: 'Not signed in' });

  switch (b.a) {
    case 'items': {
      const w = await F.weeksAndItems(s, b.week);
      return res.json({ current: w.current, week: w.week, sunday: w.sunday, weeks: w.weeks, items: w.rows.map(pubViewer) });
    }
    case 'download': {
      const it = await F.itemById(b.id); if (!it) return res.status(404).json({ error: 'Not found' });
      return res.json({ url: await F.downloadUrl(it, b.which) });
    }
    case 'download-all': return res.json(await F.downloadAllFiles(s, b.week, b.which));
    default: return res.status(400).json({ error: 'Unknown action' });
  }
});
