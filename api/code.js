const c = require('./_lib/common');
module.exports = c.wrap(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const s = await c.getSettings();
  if (!s.uploadCode || c.safeEq(c.clip((req.body || {}).code, 100), s.uploadCode)) {
    c.setCookie(req, res, 'upl', c.mkToken('upload', 30), 30);
    return res.json({ ok: true });
  }
  await new Promise((r) => setTimeout(r, 500));
  res.status(401).json({ error: 'That code is not right.' });
});
