const c = require('./_lib/common');
module.exports = c.wrap(async (req, res) => {
  const s = await c.getSettings();
  const week = c.currentWeek(s);
  const { data, error } = await c.sb().from('items').select('*').eq('week_key', week).eq('hidden', false).order('sort_order', { ascending: true });
  if (error) throw error;
  // Prefer the converted 1080p/59.94 MP4 once it exists; until then play the upload as-is.
  const names = (data || []).some((i) => i.kind === 'video') ? await c.weekNames(week) : new Set();
  const src = (i) => (i.kind === 'video' && c.convState(i, names) === 'ready' ? c.convPath(i) : i.media_path);
  res.json({
    weekKey: week, bg: c.bgUrl(s),
    items: (data || []).map((i) => ({
      id: i.id, kind: i.kind, title: i.title, description: i.description,
      url: `${c.publicUrl(src(i))}?v=${i.version}`, duration: i.custom_duration || null,
    })),
    settings: { imageDuration: s.imageDuration, showCaptions: s.showCaptions, transition: s.transition },
  });
});
