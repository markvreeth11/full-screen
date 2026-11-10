const c = require('./_lib/common');

const pub = (i) => ({
  id: i.id, kind: i.kind, title: i.title, description: i.description, uploader: i.uploader,
  hidden: i.hidden, customDuration: i.custom_duration, fullFrame: i.full_frame, srcW: i.src_w, srcH: i.src_h,
  originalName: i.original_name, createdAt: i.created_at, order: i.sort_order,
  url: `${c.publicUrl(i.media_path)}?v=${i.version}`, hasOriginal: !!i.original_path,
});

module.exports = c.wrap(async (req, res) => {
  const b = req.body || {};
  const a = b.a || req.query.a;
  const sb = c.sb();

  if (a === 'login') {
    const pw = process.env.ADMIN_PASSWORD;
    if (pw && c.safeEq(b.password || '', pw)) { c.setCookie(req, res, 'adm', c.mkToken('admin', 14), 14); return res.json({ ok: true }); }
    await new Promise((r) => setTimeout(r, 600));
    return res.status(401).json({ error: pw ? 'Wrong password' : 'ADMIN_PASSWORD is not set on the server' });
  }
  if (a === 'logout') { c.setCookie(req, res, 'adm', '', 0); return res.json({ ok: true }); }
  if (a === 'me') return res.json({ admin: c.isAdmin(req) });
  if (!c.isAdmin(req)) return res.status(401).json({ error: 'Not signed in' });

  const s = await c.getSettings();
  const one = async (id) => {
    const { data } = await sb.from('items').select('*').eq('id', id).maybeSingle();
    return data;
  };

  switch (a) {
    case 'items': {
      const cur = c.currentWeek(s);
      const { data: all } = await sb.from('items').select('week_key');
      const counts = {}; (all || []).forEach((r) => { counts[r.week_key] = (counts[r.week_key] || 0) + 1; });
      counts[cur] = counts[cur] || 0;
      const weeks = Object.keys(counts).sort().reverse().map((k) => ({ key: k, count: counts[k], sunday: c.sundayOf(k) }));
      const key = counts[b.week] !== undefined ? b.week : cur;
      const { data } = await sb.from('items').select('*').eq('week_key', key).order('sort_order', { ascending: true });
      return res.json({ current: cur, week: key, range: c.weekRange(key), sunday: c.sundayOf(key), weeks, items: (data || []).map(pub) });
    }
    case 'update': {
      const patch = {};
      if ('title' in b) patch.title = c.clip(b.title, 120);
      if ('description' in b) patch.description = c.clip(b.description, 400);
      if ('hidden' in b) patch.hidden = !!b.hidden;
      if ('customDuration' in b) patch.custom_duration = +b.customDuration > 0 ? Math.min(600, Math.round(+b.customDuration)) : null;
      const { error } = await sb.from('items').update(patch).eq('id', b.id);
      if (error) throw error;
      return res.json({ ok: true });
    }
    case 'move': {
      const it = await one(b.id); if (!it) return res.status(404).json({ error: 'Not found' });
      const { data: list } = await sb.from('items').select('id,sort_order').eq('week_key', it.week_key).order('sort_order', { ascending: true });
      const i = list.findIndex((x) => x.id === it.id), j = b.dir === 'up' ? i - 1 : i + 1;
      if (list[j]) {
        await sb.from('items').update({ sort_order: list[j].sort_order }).eq('id', list[i].id);
        await sb.from('items').update({ sort_order: list[i].sort_order }).eq('id', list[j].id);
      }
      return res.json({ ok: true });
    }
    case 'delete': {
      const it = await one(b.id); if (!it) return res.status(404).json({ error: 'Not found' });
      await c.removeObjects('media', [it.media_path]); await c.removeObjects('originals', [it.original_path]);
      const { error } = await sb.from('items').delete().eq('id', it.id);
      if (error) throw error;
      return res.json({ ok: true });
    }
    case 'download': {
      const it = await one(b.id); if (!it) return res.status(404).json({ error: 'Not found' });
      const orig = b.which === 'original' && it.original_path;
      const bucket = orig ? 'originals' : 'media', p = orig ? it.original_path : it.media_path;
      const ext = p.split('.').pop();
      const name = ((it.title || (it.original_name || 'file').replace(/\.[^.]+$/, '')).replace(/[^\w\- ]+/g, '').trim() || 'file') + '.' + ext;
      const { data, error } = await sb.storage.from(bucket).createSignedUrl(p, 600, { download: name });
      if (error) throw error;
      return res.json({ url: data.signedUrl });
    }
    case 'download-all': {
      const wk = /^\d{4}-\d{2}-\d{2}$/.test(b.week || '') ? b.week : c.currentWeek(s);
      const { data } = await sb.from('items').select('*').eq('week_key', wk).order('sort_order', { ascending: true });
      const files = [];
      for (const [n, it] of (data || []).entries()) {
        const orig = b.which === 'original' && it.original_path;
        const bucket = orig ? 'originals' : 'media', p = orig ? it.original_path : it.media_path;
        const base = (it.title || (it.original_name || 'file').replace(/\.[^.]+$/, '')).replace(/[^\w\- ]+/g, '').trim() || 'file';
        const { data: g, error } = await sb.storage.from(bucket).createSignedUrl(p, 1800);
        if (error) throw error;
        files.push({ url: g.signedUrl, name: `${String(n + 1).padStart(2, '0')} ${base}.${p.split('.').pop()}` });
      }
      return res.json({ zipName: `Weekly Uploads - ${c.sundayOf(wk)}${b.which === 'original' ? ' (originals)' : ''}.zip`, files });
    }
    case 'notify-test': {
      const to = c.parseEmails(b.email).filter((e) => c.EMAIL_RE.test(e));
      if (!to.length) return res.status(400).json({ error: 'Type a valid email address first.' });
      const r = await c.sendEmail({ to: to.slice(0, 5), subject: 'Weekly Uploads: test email',
        text: 'This is a test. You will get an email like this whenever a file is uploaded.',
        html: '<p style="font-family:-apple-system,Segoe UI,Arial,sans-serif">This is a test. You will get an email like this whenever a file is uploaded.</p>' });
      return r.ok ? res.json({ ok: true }) : res.status(502).json({ error: r.error });
    }
    case 'settings-get': return res.json({ ...s, bg: c.bgUrl(s), currentWeek: c.currentWeek(s), sunday: c.sundayOf(c.currentWeek(s)) });
    case 'settings-put': {
      const n = (v, lo, hi, d) => (Number.isFinite(+v) && v !== '' ? Math.min(hi, Math.max(lo, +v)) : d);
      if ('churchName' in b) s.churchName = c.clip(b.churchName, 80) || s.churchName;
      if ('timezone' in b) {
        try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); s.timezone = b.timezone; }
        catch { return res.status(400).json({ error: 'Unknown time zone' }); }
      }
      if ('rolloverDay' in b) s.rolloverDay = Math.round(n(b.rolloverDay, 0, 6, s.rolloverDay));
      if ('rolloverHour' in b) s.rolloverHour = Math.round(n(b.rolloverHour, 0, 23, s.rolloverHour));
      if ('imageDuration' in b) s.imageDuration = n(b.imageDuration, 2, 600, s.imageDuration);
      if ('showCaptions' in b) s.showCaptions = !!b.showCaptions;
      if ('transition' in b) s.transition = b.transition === 'none' ? 'none' : 'fade';
      if ('uploadCode' in b) s.uploadCode = c.clip(b.uploadCode, 100);
      if ('uploadsOpen' in b) s.uploadsOpen = !!b.uploadsOpen;
      if ('notifyEmail' in b) {
        const list = c.parseEmails(b.notifyEmail);
        if (list.length > 5 || list.some((e) => !c.EMAIL_RE.test(e))) return res.status(400).json({ error: 'Please enter a valid email address (up to 5, separated by commas).' });
        s.notifyEmail = list.join(', ');
      }
      if ('keepPastWeeks' in b) s.keepPastWeeks = Math.round(n(b.keepPastWeeks, 0, 104, s.keepPastWeeks));
      if ('maxVideoMB' in b) s.maxVideoMB = Math.round(n(b.maxVideoMB, 5, 5000, s.maxVideoMB));
      await c.saveSettings(s);
      return res.json({ ...s, bg: c.bgUrl(s), currentWeek: c.currentWeek(s), sunday: c.sundayOf(c.currentWeek(s)) });
    }

    // Background: the browser renders the 1920x1080 file, we just store it.
    case 'bg-sign': {
      const path = `bg/bg-${Date.now()}.png`;
      const { data, error } = await sb.storage.from('media').createSignedUploadUrl(path);
      if (error) throw error;
      return res.json({ bucket: 'media', path, token: data.token });
    }
    case 'bg-commit': {
      if (!/^bg\/bg-\d+\.(png|jpg)$/.test(b.path || '') || !(await c.exists('media', b.path))) return res.status(400).json({ error: 'Upload missing' });
      const old = s.bgPath; s.bgPath = b.path; s.bgVersion++; await c.saveSettings(s);
      if (old) await c.removeObjects('media', [old]);
      return res.json({ bg: c.bgUrl(s) });
    }
    case 'bg-reset': {
      const old = s.bgPath; s.bgPath = null; s.bgVersion++; await c.saveSettings(s);
      if (old) await c.removeObjects('media', [old]);
      return res.json({ bg: c.bgUrl(s) });
    }
    // Re-fit this week's already-uploaded images onto the new background.
    case 'rerender-list': {
      const { data } = await sb.from('items').select('id').eq('week_key', c.currentWeek(s)).eq('kind', 'image').eq('full_frame', false);
      return res.json({ ids: (data || []).map((r) => r.id) });
    }
    case 'rerender-start': {
      const it = await one(b.id); if (!it || !it.original_path) return res.status(404).json({ error: 'Not found' });
      const g = await sb.storage.from('originals').createSignedUrl(it.original_path, 600);
      const u = await sb.storage.from('media').createSignedUploadUrl(it.media_path, { upsert: true });
      if (g.error || u.error) throw g.error || u.error;
      return res.json({ original: g.data.signedUrl, upload: { bucket: 'media', path: it.media_path, token: u.data.token } });
    }
    case 'rerender-done': {
      await sb.from('items').update({ version: Date.now() }).eq('id', b.id);
      return res.json({ ok: true });
    }
    case 'purge': return res.json(await c.purgeOld(s));
    default: return res.status(400).json({ error: 'Unknown action' });
  }
});
