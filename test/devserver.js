// Local stand-in for Vercel: static files + /api/* handlers + fake Supabase (db + storage HTTP).
const http = require('http'), fs = require('fs'), path = require('path');
const fake = require('./fake-supabase');
require.cache[require.resolve('@supabase/supabase-js')] = { exports: { createClient: () => fake.client } };

const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4' };

function start(port) {
  process.env.SUPABASE_URL = `http://localhost:${port}`;
  process.env.SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.ADMIN_PASSWORD = 'pw-test';
  process.env.CRON_SECRET = 'cronsecret';
  const handlers = {};
  for (const n of ['info', 'code', 'upload', 'display', 'admin', 'cron']) handlers[n] = require(`../api/${n}.js`);
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      let m;
      if ((m = url.pathname.match(/^\/api\/(\w+)$/)) && handlers[m[1]]) {
        req.query = Object.fromEntries(url.searchParams);
        try { req.body = body.length ? JSON.parse(body) : undefined; } catch { req.body = undefined; }
        res.status = (n) => { res.statusCode = n; return res; };
        res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
        return handlers[m[1]](req, res);
      }
      if ((m = url.pathname.match(/^\/storage\/v1\/object\/upload\/sign\/(\w+)\/(.+)$/)) && req.method === 'PUT') {
        const ct = req.headers['content-type'] || '', bnd = '--' + ct.split('boundary=')[1];
        // pull the unnamed file part out of the multipart body
        const s = body.toString('latin1'); const parts = s.split(bnd).filter((p) => p.includes('filename') || p.includes('name=""'));
        const part = parts[parts.length - 1]; const hdrEnd = part.indexOf('\r\n\r\n');
        const type = (part.match(/Content-Type: ([^\r\n]+)/i) || [])[1] || 'application/octet-stream';
        const data = Buffer.from(part.slice(hdrEnd + 4, part.lastIndexOf('\r\n')), 'latin1');
        fake.buckets[m[1]].set(decodeURIComponent(m[2]), { data, type });
        res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ Key: `${m[1]}/${m[2]}` }));
      }
      if ((m = url.pathname.match(/^\/storage\/v1\/object\/(?:public|sign)\/(\w+)\/(.+)$/))) {
        const f = fake.buckets[m[1]].get(decodeURIComponent(m[2]));
        if (!f) { res.statusCode = 404; return res.end(); }
        res.setHeader('Content-Type', f.type); res.setHeader('Access-Control-Allow-Origin', '*'); return res.end(f.data);
      }
      let p = url.pathname === '/' ? '/index.html' : url.pathname;
      if (!path.extname(p)) p += '.html';
      const file = path.join(ROOT, 'public', p);
      if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('nf'); }
      res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
    });
    srv.listen(port, () => resolve(srv));
  });
}
module.exports = { start, fake };
if (require.main === module) start(3077).then(() => console.log('http://localhost:3077'));
