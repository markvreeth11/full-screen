const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');

const W = 1920, H = 1080;
sharp.cache(false);

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(err.slice(-600) || `${cmd} exited ${c}`))));
  });
}
const open = (src) => sharp(src, { limitInputPixels: false, failOn: 'none' });

// Build the 1920x1080 background from any uploaded image (cover-fit).
async function makeBackground(src, out) {
  await open(src).rotate().resize(W, H, { fit: 'cover', kernel: 'lanczos3' }).png().toFile(out);
}

// Fit an image into 1920x1080. Exact-size images pass through untouched;
// everything else is scaled (up or down) to fit and centred on the background.
async function processImage(src, outBase, bg) {
  const meta = await open(src).metadata();
  const swap = (meta.orientation || 1) >= 5;
  const w = swap ? meta.height : meta.width, h = swap ? meta.width : meta.height;
  if (!w || !h) throw new Error('Could not read image dimensions');

  if (w === W && h === H) {
    const png = meta.format === 'png';
    const out = outBase + (png ? '.png' : '.jpg');
    const img = open(src).rotate();
    await (png ? img.png() : img.jpeg({ quality: 97, chromaSubsampling: '4:4:4' })).toFile(out);
    return { file: path.basename(out), fullFrame: true, srcW: w, srcH: h };
  }

  const scale = Math.min(W / w, H / h);
  const tw = Math.max(1, Math.min(W, Math.round(w * scale)));
  const th = Math.max(1, Math.min(H, Math.round(h * scale)));
  let buf = await open(src).rotate().png().toBuffer();
  let cw = w, ch = h;
  // Upscale in <=2x Lanczos steps (cleaner than one huge jump), then a light sharpen.
  while (cw < tw || ch < th) {
    const nw = Math.min(tw, cw * 2), nh = Math.min(th, ch * 2);
    const rw = Math.round(nw), rh = Math.round(nh);
    buf = await sharp(buf).resize(rw, rh, { kernel: 'lanczos3' }).png().toBuffer();
    cw = rw; ch = rh;
    if (cw >= tw && ch >= th) break;
  }
  let fg = sharp(buf).resize(tw, th, { kernel: 'lanczos3' });
  if (scale > 1.2) fg = fg.sharpen({ sigma: 0.7, m1: 0.8, m2: 2 });
  const fgBuf = await fg.png().toBuffer();
  const out = outBase + '.jpg';
  await sharp(bg)
    .composite([{ input: fgBuf, left: Math.floor((W - tw) / 2), top: Math.floor((H - th) / 2) }])
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toFile(out);
  return { file: path.basename(out), fullFrame: false, srcW: w, srcH: h };
}

async function probe(src) {
  const j = JSON.parse(await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name,pix_fmt,avg_frame_rate:stream_side_data=rotation:format=duration',
    '-of', 'json', src]));
  const s = (j.streams || [])[0];
  if (!s) throw new Error('No video stream found');
  const rot = Math.abs(((s.side_data_list || []).find((d) => 'rotation' in d) || {}).rotation || 0);
  const swap = rot === 90 || rot === 270;
  let fps = 30;
  const [n, d] = String(s.avg_frame_rate || '').split('/').map(Number);
  if (n && d) fps = Math.min(60, Math.max(10, n / d));
  return {
    w: swap ? s.height : s.width, h: swap ? s.width : s.height,
    codec: s.codec_name, pix: s.pix_fmt, rot, fps,
    duration: parseFloat(j.format && j.format.duration) || 0,
  };
}

// Videos: exact 1920x1080 H.264 is remuxed losslessly; anything else is scaled
// to fit and centred over the background, then encoded to web-friendly H.264.
async function processVideo(src, outBase, bg) {
  const p = await probe(src);
  const out = outBase + '.mp4';
  const exact = p.w === W && p.h === H;
  const common = ['-movflags', '+faststart', '-c:a', 'aac', '-b:a', '192k'];
  let args;
  if (exact && p.codec === 'h264' && p.pix === 'yuv420p' && !p.rot) {
    args = ['-y', '-i', src, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'copy', ...common, out];
  } else {
    const enc = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', ...common];
    if (exact) {
      args = ['-y', '-i', src, '-map', '0:v:0', '-map', '0:a?', '-vf', 'setsar=1', ...enc, out];
    } else {
      const fc = `[1:v]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1[fg];` +
        `[0:v][fg]overlay=(W-w)/2:(H-h)/2:shortest=1,format=yuv420p[v]`;
      args = ['-y', '-loop', '1', '-framerate', String(p.fps), '-i', bg, '-i', src,
        '-filter_complex', fc, '-map', '[v]', '-map', '1:a?', '-r', String(p.fps), ...enc, out];
    }
  }
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
  return { file: path.basename(out), fullFrame: exact, srcW: p.w, srcH: p.h, duration: p.duration };
}

async function makeThumb(kind, processedPath, thumbPath) {
  if (kind === 'image') {
    await open(processedPath).resize(480, 270, { fit: 'cover' }).jpeg({ quality: 80 }).toFile(thumbPath);
  } else {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', processedPath,
      '-frames:v', '1', '-vf', 'scale=480:270', thumbPath]).catch(() =>
      run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', processedPath,
        '-frames:v', '1', '-vf', 'scale=480:270', thumbPath]));
  }
}

module.exports = { W, H, makeBackground, processImage, processVideo, makeThumb };
