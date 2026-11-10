const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { weekKey, weekRange, sundayOf } = require('./week');

let _sb;
const sb = () => (_sb ||= createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
}));

const DEFAULTS = {
  churchName: 'Our Church',
  timezone: 'America/New_York',
  rolloverDay: 1,        // week starts Monday…
  rolloverHour: 0,       // …at midnight
  imageDuration: 10,
  showCaptions: true,
  transition: 'fade',
  uploadCode: '',
  notifyEmail: '',       // email address(es) to alert when a file is uploaded (blank = off)
  uploadsOpen: true,
  keepPastWeeks: 0,      // 0 = files are deleted as soon as the week is over
  maxVideoMB: 50,        // Supabase free plan limit; raise on Pro
  bgPath: null,
  bgVersion: 1,
};
const MAX_IMAGE_MB = 40;
const MAX_NOTIFY = 20; // email addresses that can be alerted per upload

async function getSettings() {
  const { data, error } = await sb().from('settings').select('data').eq('id', 1).maybeSingle();
  if (error) throw error;
  return { ...DEFAULTS, ...((data && data.data) || {}) };
}
async function saveSettings(s) {
  const { error } = await sb().from('settings').upsert({ id: 1, data: s });
  if (error) throw error;
}
const currentWeek = (s, d = new Date()) => weekKey(d, s);
const publicUrl = (p) => `${process.env.SUPABASE_URL}/storage/v1/object/public/media/${p}`;
const bgUrl = (s) => (s.bgPath ? `${publicUrl(s.bgPath)}?v=${s.bgVersion}` : '/default-background.webp');
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// ---------- signed cookies / tickets ----------
const secret = () => process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('sess:' + (process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev')).digest('hex');
const sign = (v) => crypto.createHmac('sha256', secret()).update(v).digest('hex');
const safeEq = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((c) => {
    const i = c.indexOf('='); return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
  }));
}
const mkToken = (role, days) => { const v = `${role}.${Date.now() + days * 864e5}`; return `${v}.${sign(v)}`; };
function validToken(tok, role) {
  const [r, exp, sig] = String(tok || '').split('.');
  if (r !== role || !exp || !sig) return false;
  return safeEq(sig, sign(`${r}.${exp}`)) && +exp > Date.now();
}
function setCookie(req, res, name, val, days) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const prev = res.getHeader('Set-Cookie');
  const c = `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${secure}`;
  res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : c);
}
const isAdmin = (req) => validToken(cookies(req).adm, 'admin');
const canUpload = (req, s) => !s.uploadCode || isAdmin(req) || validToken(cookies(req).upl, 'upload');

const mkTicket = (obj) => { const b = Buffer.from(JSON.stringify(obj)).toString('base64url'); return `${b}.${sign(b)}`; };
function readTicket(t) {
  const [b, sig] = String(t || '').split('.');
  if (!b || !sig || !safeEq(sig, sign(b))) return null;
  try { const o = JSON.parse(Buffer.from(b, 'base64url').toString()); return o.exp > Date.now() ? o : null; } catch { return null; }
}

const wrap = (fn) => async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try { await fn(req, res); } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
  }
};

// ---------- storage helpers ----------
async function exists(bucket, p) {
  const i = p.lastIndexOf('/');
  const { data } = await sb().storage.from(bucket).list(p.slice(0, i), { search: p.slice(i + 1), limit: 5 });
  return !!(data || []).some((f) => f.name === p.slice(i + 1));
}
async function removeObjects(bucket, paths) {
  paths = paths.filter(Boolean);
  if (paths.length) await sb().storage.from(bucket).remove(paths);
}

// ---------- email alerts (Resend: https://resend.com) ----------
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const parseEmails = (v) => String(v || '').split(/[,;\s]+/).filter(Boolean);
const oneLine = (v) => String(v || '').replace(/[\r\n\u2028\u2029]+/g, ' ').trim();

async function sendEmail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: 'RESEND_API_KEY is not set in Vercel yet' };
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.NOTIFY_FROM || 'Weekly Uploads <onboarding@resend.dev>', to, subject, html, text }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => ''); console.error('email failed', r.status, body);
      let msg = ''; try { msg = JSON.parse(body).message; } catch {}
      return { ok: false, error: msg || `Email service returned ${r.status}` };
    }
    return { ok: true };
  } catch (e) {
    console.error('email error', e.message);
    return { ok: false, error: e.name === 'AbortError' ? 'Email service timed out' : e.message };
  } finally { clearTimeout(timer); }
}
const siteUrl = (req) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  return host ? `${req.headers['x-forwarded-proto'] || 'https'}://${host}` : '';
};
// Never throws and never blocks an upload from succeeding.
async function notifyUpload(s, req, it) {
  try {
    const to = parseEmails(s.notifyEmail).filter((e) => EMAIL_RE.test(e)).slice(0, MAX_NOTIFY);
    if (!to.length) return;
    const sunday = sundayOf(it.week_key), when = new Date(sunday + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
    const label = oneLine(it.title) || oneLine(it.original_name) || `a ${it.kind}`;
    const admin = siteUrl(req) + '/admin';
    const rows = [['Type', it.kind === 'video' ? 'Video' : 'Image'], ['Title', it.title], ['Description', it.description], ['File', it.original_name], ['For', `Sunday, ${when}`]].filter((r) => r[1]);
    await sendEmail({
      to, subject: `New ${it.kind} uploaded: ${label}`.slice(0, 150),
      text: rows.map((r) => `${r[0]}: ${r[1]}`).join('\n') + `\n\nView and download: ${admin}`,
      html: `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#0b2136;max-width:520px"><h2 style="margin:0 0 12px">New ${it.kind} uploaded</h2>` +
        rows.map((r) => `<p style="margin:4px 0"><b>${esc(r[0])}:</b> ${esc(r[1])}</p>`).join('') +
        `<p style="margin:18px 0"><a href="${esc(admin)}" style="background:#17436b;color:#fff;padding:10px 18px;border-radius:12px;text-decoration:none;font-weight:600">View in admin</a></p></div>`,
    });
  } catch (e) { console.error('notifyUpload', e.message); }
}

// Delete everything for weeks that are older than the retention window.
async function purgeOld(s) {
  const keep = Math.max(0, Math.round(+s.keepPastWeeks || 0));
  const cur = currentWeek(s);
  const cutoff = new Date(Date.parse(cur + 'T00:00:00Z') - keep * 7 * 864e5).toISOString().slice(0, 10);
  let files = 0;
  for (const bucket of ['media', 'originals']) {
    const { data: top } = await sb().storage.from(bucket).list('', { limit: 1000 });
    for (const f of top || []) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.name) || f.name >= cutoff) continue;
      for (;;) {
        const { data: inner } = await sb().storage.from(bucket).list(f.name, { limit: 100 });
        if (!inner || !inner.length) break;
        await removeObjects(bucket, inner.map((o) => `${f.name}/${o.name}`));
        files += inner.length;
      }
    }
  }
  const { error } = await sb().from('items').delete().lt('week_key', cutoff);
  if (error) throw error;
  return { cutoff, files };
}

module.exports = {
  sb, DEFAULTS, MAX_IMAGE_MB, MAX_NOTIFY, getSettings, saveSettings, currentWeek, weekRange, sundayOf, publicUrl, bgUrl, clip,
  cookies, mkToken, validToken, setCookie, isAdmin, canUpload, mkTicket, readTicket, safeEq,
  wrap, exists, removeObjects, purgeOld, EMAIL_RE, parseEmails, oneLine, sendEmail, notifyUpload,
};
