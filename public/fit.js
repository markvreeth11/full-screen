// Fits any image onto a 1920x1080 canvas (in the browser, no server needed).
// Exact 1920x1080 -> untouched. Otherwise scaled up OR down to the largest size that fits and
// centred on the background template. Upscaling is done in <=2x steps + a light sharpen.
(function (g) {
  const W = 1920, H = 1080;
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const size = (s) => ({ w: s.width || s.naturalWidth, h: s.height || s.naturalHeight });
  const toBlob = (c, type, q) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode image'))), type, q));

  async function toBitmap(blob) {
    if (g.createImageBitmap) {
      try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) {}
      try { return await createImageBitmap(blob); } catch (e) {}
    }
    return new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("This image format can't be read by your browser. Try a JPG or PNG."));
      i.src = URL.createObjectURL(blob);
    });
  }

  function scaleTo(src, tw, th) {
    let { w } = size(src), cur = src;
    for (;;) {
      const r = tw / w, last = r >= 0.5 && r <= 2;
      const f = r > 1 ? 2 : 0.5;
      const nw = last ? tw : Math.round(w * f);
      const nh = last ? th : Math.max(1, Math.round(size(cur).h * f));
      const c = canvas(nw, nh), x = c.getContext('2d');
      x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
      x.drawImage(cur, 0, 0, nw, nh);
      cur = c; w = nw;
      if (last) return c;
    }
  }

  function sharpen(c, a) {
    const { width: w, height: h } = c, x = c.getContext('2d');
    const img = x.getImageData(0, 0, w, h), s = img.data, d = new Uint8ClampedArray(s), row = w * 4;
    for (let y = 1; y < h - 1; y++) for (let px = 1; px < w - 1; px++) {
      const i = y * row + px * 4;
      for (let k = 0; k < 3; k++) d[i + k] = s[i + k] * (1 + 4 * a) - a * (s[i + k - 4] + s[i + k + 4] + s[i + k - row] + s[i + k + row]);
    }
    img.data.set(d); x.putImageData(img, 0, 0);
  }

  async function loadBg(url) { return toBitmap(await (await fetch(url)).blob()); }

  async function fitImage(file, bg) {
    const bmp = await toBitmap(file), { w, h } = size(bmp);
    if (!w || !h) throw new Error('Could not read this image');
    const png = file.type === 'image/png';
    if (w === W && h === H) {
      const c = canvas(W, H); c.getContext('2d').drawImage(bmp, 0, 0);
      return { blob: await toBlob(c, png ? 'image/png' : 'image/jpeg', 0.97), ext: png ? 'png' : 'jpg', fullFrame: true, srcW: w, srcH: h };
    }
    const sc = Math.min(W / w, H / h);
    const tw = Math.min(W, Math.max(1, Math.round(w * sc))), th = Math.min(H, Math.max(1, Math.round(h * sc)));
    const fg = scaleTo(bmp, tw, th);
    if (sc > 1.2) sharpen(fg, 0.2);
    const c = canvas(W, H), x = c.getContext('2d');
    x.drawImage(bg, 0, 0, W, H);
    x.drawImage(fg, Math.floor((W - tw) / 2), Math.floor((H - th) / 2));
    return { blob: await toBlob(c, 'image/jpeg', 0.95), ext: 'jpg', fullFrame: false, srcW: w, srcH: h };
  }

  // Background template: cover-fit any image to 1920x1080.
  async function makeBackground(file) {
    const bmp = await toBitmap(file), { w, h } = size(bmp);
    const sc = Math.max(W / w, H / h), tw = Math.round(w * sc), th = Math.round(h * sc);
    const big = scaleTo(bmp, tw, th), c = canvas(W, H);
    c.getContext('2d').drawImage(big, Math.floor((W - tw) / 2), Math.floor((H - th) / 2));
    return toBlob(c, 'image/jpeg', 0.95);
  }

  g.Fit = { W, H, fitImage, loadBg, makeBackground };
})(window);
