// Read-only file listing/downloading shared by the admin API and the volunteer viewer API.
const c = require('./common');

const fileLabel = (it) => (it.title || (it.original_name || 'file').replace(/\.[^.]+$/, '')).replace(/[^\w\- ]+/g, '').trim() || 'file';

async function weeksAndItems(s, weekParam) {
  const cur = c.currentWeek(s);
  const { data: all } = await c.sb().from('items').select('week_key');
  const counts = {}; (all || []).forEach((r) => { counts[r.week_key] = (counts[r.week_key] || 0) + 1; });
  counts[cur] = counts[cur] || 0;
  const weeks = Object.keys(counts).sort().reverse().map((k) => ({ key: k, count: counts[k], sunday: c.sundayOf(k) }));
  const key = counts[weekParam] !== undefined ? weekParam : cur;
  const { data } = await c.sb().from('items').select('*').eq('week_key', key).order('sort_order', { ascending: true });
  return { current: cur, week: key, range: c.weekRange(key), sunday: c.sundayOf(key), weeks, rows: data || [] };
}

async function itemById(id) {
  const { data } = await c.sb().from('items').select('*').eq('id', String(id || '')).maybeSingle();
  return data;
}

// Signed, short-lived download link. which='original' gives the untouched upload when one exists.
async function downloadUrl(it, which) {
  const orig = which === 'original' && it.original_path;
  const bucket = orig ? 'originals' : 'media', p = orig ? it.original_path : it.media_path;
  const { data, error } = await c.sb().storage.from(bucket).createSignedUrl(p, 600, { download: `${fileLabel(it)}.${p.split('.').pop()}` });
  if (error) throw error;
  return data.signedUrl;
}

// Everything in one week as a list of signed links; the browser zips them.
async function downloadAllFiles(s, weekParam, which) {
  const wk = /^\d{4}-\d{2}-\d{2}$/.test(weekParam || '') ? weekParam : c.currentWeek(s);
  const { data } = await c.sb().from('items').select('*').eq('week_key', wk).order('sort_order', { ascending: true });
  const files = [];
  for (const [n, it] of (data || []).entries()) {
    const orig = which === 'original' && it.original_path;
    const bucket = orig ? 'originals' : 'media', p = orig ? it.original_path : it.media_path;
    const { data: g, error } = await c.sb().storage.from(bucket).createSignedUrl(p, 1800);
    if (error) throw error;
    files.push({ url: g.signedUrl, name: `${String(n + 1).padStart(2, '0')} ${fileLabel(it)}.${p.split('.').pop()}` });
  }
  return { zipName: `Weekly Uploads - ${c.sundayOf(wk)}${which === 'original' ? ' (originals)' : ''}.zip`, files };
}

module.exports = { weeksAndItems, itemById, downloadUrl, downloadAllFiles };
