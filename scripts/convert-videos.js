#!/usr/bin/env node
// Converts uploaded videos to 1920x1080 @ 59.94 fps H.264/AAC .mp4 (placed over the background
// template when the video isn't 16:9). Run by .github/workflows/convert-videos.yml.
//
//   node scripts/convert-videos.js           convert everything that is waiting
//   node scripts/convert-videos.js --check   just print how many are waiting (pending=N)
//
// Output names must match api/_lib/common.js: <week>/<id>-1080p5994.mp4  (failure: <week>/<id>.convert-error.txt)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const W = 1920, H = 1080, FPS = '60000/1001';
const convName = (id) => `${id}-1080p5994.mp4`;
const errName = (id) => `${id}.convert-error.txt`;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(err.slice(-600) || `${cmd} exited ${c}`))));
  });
}

async function pending(sb) {
  const { data: rows, error } = await sb.from('items').select('id,week_key,media_path').eq('kind', 'video');
  if (error) throw error;
  const names = {}, out = [];
  for (const r of rows || []) {
    if (!names[r.week_key]) {
      const { data } = await sb.storage.from('media').list(r.week_key, { limit: 1000 });
      names[r.week_key] = new Set((data || []).map((f) => f.name));
    }
    const n = names[r.week_key];
    if (!n.has(convName(r.id)) && !n.has(errName(r.id))) out.push(r);
  }
  return out;
}

async function getBackground(sb, dir) {
  const { data: s } = await sb.from('settings').select('data').eq('id', 1).maybeSingle();
  const bg = s && s.data && s.data.bgPath;
  if (bg) {
    const { data, error } = await sb.storage.from('media').download(bg);
    if (!error && data) {
      const f = path.join(dir, 'bg' + path.extname(bg));
      fs.writeFileSync(f, Buffer.from(await data.arrayBuffer()));
      return f;
    }
  }
  return path.join(__dirname, '..', 'public', 'default-background.webp');
}

async function convertOne(sb, row, bg, dir) {
  const { data, error } = await sb.storage.from('media').download(row.media_path);
  if (error || !data) throw new Error('could not download the upload');
  const src = path.join(dir, 'src' + (path.extname(row.media_path) || '.mp4'));
  const out = path.join(dir, 'out.mp4');
  fs.writeFileSync(src, Buffer.from(await data.arrayBuffer()));
  const fc =
    `[0:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[bgv];` +
    `[1:v]fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos:out_color_matrix=bt709:out_range=tv,setsar=1[fg];` +
    `[bgv][fg]overlay=(W-w)/2:(H-h)/2:shortest=1,format=yuv420p[v]`;
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-loop', '1', '-framerate', FPS, '-i', bg, '-i', src,
    '-filter_complex', fc, '-map', '[v]', '-map', '1:a?', '-r', FPS,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', out]);
  const up = await sb.storage.from('media').upload(`${row.week_key}/${convName(row.id)}`, fs.readFileSync(out), { contentType: 'video/mp4', upsert: true });
  if (up.error) throw new Error('upload failed: ' + up.error.message);
}

async function main(sb, { check = false } = {}) {
  const todo = await pending(sb);
  if (check) return { pending: todo.length };
  let done = 0, failed = 0;
  if (!todo.length) return { pending: 0, done, failed };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-'));
  try {
    const bg = await getBackground(sb, dir);
    for (const row of todo) {
      console.log(`Converting ${row.week_key}/${row.id} …`);
      try { await convertOne(sb, row, bg, dir); done++; console.log('  done'); }
      catch (e) {
        failed++; console.error('  failed:', e.message);
        await sb.storage.from('media').upload(`${row.week_key}/${errName(row.id)}`, Buffer.from(String(e.message).slice(0, 500)), { contentType: 'text/plain', upsert: true });
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return { pending: todo.length, done, failed };
}

module.exports = { main, pending, convName, errName };

if (require.main === module) {
  const { createClient } = require('@supabase/supabase-js');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required'); process.exit(1); }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const check = process.argv.includes('--check');
  main(sb, { check }).then((r) => {
    console.log(JSON.stringify(r));
    if (check && process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `pending=${r.pending}\n`);
    process.exit(r.failed ? 1 : 0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
