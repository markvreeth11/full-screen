const c = require('./_lib/common');
module.exports = c.wrap(async (req, res) => {
  const s = await c.getSettings();
  const week = c.currentWeek(s);
  const { data, error } = await c.inUploadOrder(c.sb().from('items').select('*').eq('week_key', week).eq('hidden', false));
  if (error) throw error;
  res.json({
    weekKey: week, bg: c.bgUrl(s),
    items: (data || []).map((i) => ({
      id: i.id, kind: i.kind, title: i.title, // (the 'when to show' note is for the presenter, so it is not sent to the screen)
      url: `${c.publicUrl(i.media_path)}?v=${i.version}`, duration: i.custom_duration || null,
    })),
    settings: { imageDuration: s.imageDuration, showCaptions: s.showCaptions, transition: s.transition },
  });
});
