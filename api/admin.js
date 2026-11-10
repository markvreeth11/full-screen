const c = require('./_lib/common');
const F = require('./_lib/files');

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
      const w = await F.weeksAndItems(s, b.week);
      return res.json({ current: w.current, week: w.week, range: w.range, sunday: w.sunday, weeks: w.weeks, items: w.rows.map(pub) });
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
      const { data: list } = await c.inUploadOrder(sb.from('items').select('id,sort_order').eq('week_key', it.week_key));
      const ids = list.map((x) => x.id), i = ids.indexOf(it.id), j = b.dir === 'up' ? i - 1 : i + 1;
      if (ids[j]) {
        [ids[i], ids[j]] = [ids[j], ids[i]];
        // give every item in the week a clean, unique position so ties can never block a move
        await Promise.all(ids.map((id, n) => sb.from('items').update({ sort_order: n + 1 }).eq('id', id)));
      }
      return res.json({ ok: true });
    }
    case 'delete': {
      const it = await one(b.id); if (!it) return res.status(404).json({ error: 'Not found' });
      await c.removeObjects('media', [it.media_path, `${it.week_key}/${it.id}-thumb.jpg`] /* (-thumb.jpg: leftovers from a removed feature) */); await c.removeObjects('originals', [it.original_path, `${it.week_key}/${it.id}.notified`]);
      const { error } = await sb.from('items').delete().eq('id', it.id);
      if (error) throw error;
      return res.json({ ok: true });
    }
    case 'download': {
      const it = await one(b.id); if (!it) return res.status(404).json({ error: 'Not found' });
      return res.json({ url: await F.downloadUrl(it, b.which) });
    }
    case 'download-all': return res.json(await F.downloadAllFiles(s, b.week, b.which));
    case 'notify-test': {
      const to = c.parseEmails(b.email).filter((e) => c.EMAIL_RE.test(e));
      if (!to.length) return res.status(400).json({ error: 'Type a valid email address first.' });
      // Preview with whatever is typed in the form (even if not saved yet), using sample upload details.
      const preview = { ...s };
      if (typeof b.emailSubject === 'string') preview.emailSubject = c.oneLine(c.clip(b.emailSubject, 150)) || c.DEFAULTS.emailSubject;
      if (typeof b.emailIntro === 'string') preview.emailIntro = c.clip(b.emailIntro, 1000);
      // two sample files, so the preview shows how a multi-file email looks
      const wk = c.currentWeek(s);
      const msg = c.buildNotification(preview, req, [
        { week_key: wk, kind: 'image', title: 'Sample photo', description: 'A sample description', original_name: 'sample.jpg' },
        { week_key: wk, kind: 'image', title: 'Another photo', description: '', original_name: 'another.jpg' },
      ]);
      const r = await c.sendEmail({ to: to.slice(0, c.MAX_NOTIFY), ...msg, subject: 'TEST: ' + msg.subject });
      return r.ok ? res.json({ ok: true }) : res.status(502).json({ error: `${r.error}\n${c.emailDiagnostics()}` });
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
      if ('viewerPassword' in b) s.viewerPassword = c.clip(b.viewerPassword, 100);
      if ('emailSubject' in b) s.emailSubject = c.upperPlaceholders(c.oneLine(c.clip(b.emailSubject, 150))) || c.DEFAULTS.emailSubject;
      if ('emailIntro' in b) s.emailIntro = c.upperPlaceholders(c.clip(b.emailIntro, 1000)) || c.DEFAULTS.emailIntro;
      if ('notifyEmail' in b) {
        const list = c.parseEmails(b.notifyEmail);
        if (list.length > c.MAX_NOTIFY || list.some((e) => !c.EMAIL_RE.test(e))) return res.status(400).json({ error: 'Please enter a valid email address (up to ' + c.MAX_NOTIFY + ', separated by commas).' });
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
