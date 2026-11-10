const c = require('./_lib/common');
// Vercel Cron calls this daily (see vercel.json) with "Authorization: Bearer $CRON_SECRET".
module.exports = c.wrap(async (req, res) => {
  const sec = process.env.CRON_SECRET;
  if (!sec || !c.safeEq(req.headers.authorization || '', `Bearer ${sec}`)) return res.status(401).json({ error: 'Unauthorized' });
  res.json(await c.purgeOld(await c.getSettings()));
});
