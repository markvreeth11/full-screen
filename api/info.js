const c = require('./_lib/common');
module.exports = c.wrap(async (req, res) => {
  const s = await c.getSettings();
  const key = c.currentWeek(s);
  res.json({
    churchName: s.churchName, weekKey: key, range: c.weekRange(key), sunday: c.sundayOf(key), uploadsOpen: s.uploadsOpen,
    needsCode: !c.canUpload(req, s), bg: c.bgUrl(s), maxVideoMB: s.maxVideoMB, maxImageMB: c.MAX_IMAGE_MB,
    supabaseUrl: process.env.SUPABASE_URL, supabaseKey: process.env.SUPABASE_ANON_KEY,
  });
});
