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
  uploadsOpen: true,
  keepPastWeeks: 0,      // 0 = files are deleted as soon as the week is over
  maxVideoMB: 50,        // Supabase free plan limit; raise on Pro
  bgPath: null,
  bgVersion: 1,
};
const MAX_IMAGE_MB = 40;

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

// ---------- video conversion (done by .github/workflows/convert-videos.yml) ----------
// Converted file lives next to the upload: <week>/<id>-1080p5994.mp4 ; a failure leaves <week>/<id>.convert-error.txt
// (scripts/convert-videos.js uses the same names).
const convName = (it) => `${it.id}-1080p5994.mp4`;
const errName = (it) => `${it.id}.convert-error.txt`;
const convPath = (it) => `${it.week_key}/${convName(it)}`;
const errPath = (it) => `${it.week_key}/${errName(it)}`;
async function weekNames(week) {
  const { data } = await sb().storage.from('media').list(week, { limit: 1000 });
  return new Set((data || []).map((f) => f.name));
}
const convState = (it, names) => (names.has(convName(it)) ? 'ready' : names.has(errName(it)) ? 'failed' : 'working');

// Ask GitHub Actions to convert right away. Optional: without GH_DISPATCH_TOKEN the hourly schedule picks it up.
async function dispatchConvert() {
  const tok = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_REPO ||
    (process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG ? `${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}` : '');
  if (!tok || !repo) return false;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/convert-videos.yml/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'weekly-uploads' },
      body: JSON.stringify({ ref: process.env.CONVERT_REF || 'main' }),
    });
    if (!r.ok) console.error('convert dispatch failed', r.status, await r.text());
    return r.ok;
  } catch (e) { console.error('convert dispatch error', e.message); return false; }
}
// The background is baked into converted videos, so a new background means converting this week's videos again.
async function resetConversions(week) {
  const { data } = await sb().from('items').select('id,week_key').eq('week_key', week).eq('kind', 'video');
  const paths = (data || []).flatMap((it) => [convPath(it), errPath(it)]);
  if (!paths.length) return;
  await removeObjects('media', paths);
  await dispatchConvert();
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
  sb, DEFAULTS, MAX_IMAGE_MB, getSettings, saveSettings, currentWeek, weekRange, sundayOf, publicUrl, bgUrl, clip,
  cookies, mkToken, validToken, setCookie, isAdmin, canUpload, mkTicket, readTicket, safeEq,
  wrap, exists, removeObjects, purgeOld, convPath, errPath, weekNames, convState, dispatchConvert, resetConversions,
};
