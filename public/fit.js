// Fits any image onto a 1920x1080 canvas (in the browser, no server needed).
// Exact 1920x1080 -> untouched. Otherwise scaled up OR down to the largest size that fits and
// centred on the background template. Upscaling is done in <=2x steps + a light sharpen.
(function (g) {
  const W = 1920, H = 1080;
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const size = (s) => ({ w: s.width || s.naturalWidth, h: s.height || s.naturalHeight });
  const toBlob = (c, type, q) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode image'))), type, q));

  // ---- iPhone photos (HEIC/HEIF) ----
  // Chrome/Firefox/Edge can't open HEIC (Safari can), so those are converted in the browser by libheif.
  // The converter (~3 MB) is only downloaded when a HEIC file actually needs it.
  const HEIC_LIB = 'https://cdn.jsdelivr.net/npm/heic-to@1.6.6/dist/iife/heic-to.js';
  const HEIC_HELP = "This iPhone photo couldn't be converted. Try sharing it as a JPEG instead, or on the iPhone set Settings → Camera → Formats → Most Compatible.";
  const HEIC_EXT = /\.(heic|heif)$/i;
  // Some systems give HEIC files no type at all, so recognise them by extension too.
  const isImageFile = (f) => /^image\//.test(f.type) || HEIC_EXT.test(f.name || '');
  async function isHeicBlob(blob) { // sniff the file's "ftyp" header: heic/heix/hevc/mif1… but not AVIF
    try {
      const b = new Uint8Array(await blob.slice(0, 40).arrayBuffer());
      if (String.fromCharCode(...b.slice(4, 8)) !== 'ftyp') return false;
      const brands = String.fromCharCode(...b.slice(8, 40));
      return /heic|heix|hevc|hevx|heim|heis|mif1|msf1/.test(brands) && !/avif|avis/.test(brands);
    } catch (e) { return false; }
  }
  let heicLib;
  function loadHeicLib() {
    if (g.HeicTo) return Promise.resolve(g.HeicTo);
    return (heicLib = heicLib || new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = HEIC_LIB;
      s.onload = () => (g.HeicTo ? res(g.HeicTo) : rej(new Error(HEIC_HELP)));
      s.onerror = () => { heicLib = null; rej(new Error("Couldn't load the iPhone photo converter. Check your internet connection and try again.")); };
      document.head.append(s);
    }));
  }
  const heicCache = new WeakMap(); // one conversion per file (preview + upload share it)
  function heicToPng(blob) {
    if (!heicCache.has(blob)) {
      heicCache.set(blob, loadHeicLib().then((HeicTo) => HeicTo({ blob, type: 'image/png' })).catch((e) => {
        heicCache.delete(blob);
        throw (e && /load the iPhone/.test(e.message) ? e : new Error(HEIC_HELP));
      }));
    }
    return heicCache.get(blob);
  }

  async function nativeBitmap(blob) {
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

  async function toBitmap(blob) {
    try { return await nativeBitmap(blob); }
    catch (e) {
      if (await isHeicBlob(blob)) return nativeBitmap(await heicToPng(blob)); // browser can't open HEIC: convert it
      throw e;
    }
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

  // Screen-ready files are lossless PNG. fmt='jpg' is only used to re-fit older .jpg files in place.
  const encode = (c, fmt) => (fmt === 'jpg' ? toBlob(c, 'image/jpeg', 0.95) : toBlob(c, 'image/png'));

  async function fitImage(file, bg, fmt = 'png') {
    const bmp = await toBitmap(file), { w, h } = size(bmp);
    if (!w || !h) throw new Error('Could not read this image');
    const ext = fmt === 'jpg' ? 'jpg' : 'png';
    if (w === W && h === H) {
      const c = canvas(W, H); c.getContext('2d').drawImage(bmp, 0, 0);
      return { blob: await encode(c, ext), ext, fullFrame: true, srcW: w, srcH: h };
    }
    const sc = Math.min(W / w, H / h);
    const tw = Math.min(W, Math.max(1, Math.round(w * sc))), th = Math.min(H, Math.max(1, Math.round(h * sc)));
    const fg = scaleTo(bmp, tw, th);
    if (sc > 1.2) sharpen(fg, 0.2);
    const c = canvas(W, H), x = c.getContext('2d');
    x.drawImage(bg, 0, 0, W, H);
    x.drawImage(fg, Math.floor((W - tw) / 2), Math.floor((H - th) / 2));
    return { blob: await encode(c, ext), ext, fullFrame: false, srcW: w, srcH: h };
  }

  // ---- PDFs: every page becomes a slide ----
  // Pages are drawn by PDF.js (loaded only when a PDF is chosen) straight at the final size, so text and
  // graphics stay sharp: the largest size that fits 1920x1080. 16:9 pages (slide decks) fill the frame;
  // other shapes sit centred on the background template, like any other image.
  const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174';
  const MAX_PDF_PAGES = 60;
  const isPdfFile = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
  let pdfLib;
  function loadPdfLib() {
    if (g.pdfjsLib) return Promise.resolve(g.pdfjsLib);
    return (pdfLib = pdfLib || new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = PDFJS + '/build/pdf.min.js';
      s.onload = () => { g.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + '/build/pdf.worker.min.js'; res(g.pdfjsLib); };
      s.onerror = () => { pdfLib = null; rej(new Error("Couldn't load the PDF reader. Check your internet connection and try again.")); };
      document.head.append(s);
    }));
  }
  const pdfCache = new WeakMap(); // one open document per file (preview + upload share it)
  function openPdf(file) {
    if (!pdfCache.has(file)) {
      pdfCache.set(file, (async () => {
        const lib = await loadPdfLib();
        let doc;
        try {
          doc = await lib.getDocument({
            data: new Uint8Array(await file.arrayBuffer()),
            isEvalSupported: false, // PDF.js's own recommended hardening (CVE-2024-4367) for this version
            cMapUrl: PDFJS + '/cmaps/', cMapPacked: true, standardFontDataUrl: PDFJS + '/standard_fonts/',
          }).promise;
        } catch (e) {
          throw new Error(e && e.name === 'PasswordException'
            ? 'This PDF is password-protected. Remove the password and try again.'
            : "This PDF couldn't be read. Try saving or exporting it as a PDF again.");
        }
        if (doc.numPages > MAX_PDF_PAGES) throw new Error(`This PDF has ${doc.numPages} pages. The limit is ${MAX_PDF_PAGES} pages, so please split it into smaller PDFs.`);
        return doc;
      })().catch((e) => { pdfCache.delete(file); throw e; }));
    }
    return pdfCache.get(file);
  }
  // Small preview (first page) for the upload list.
  async function pdfThumb(doc, max = 480) {
    const page = await doc.getPage(1), v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(max / v1.width, max / v1.height) });
    const c = canvas(Math.max(1, Math.round(vp.width)), Math.max(1, Math.round(vp.height))), x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: x, viewport: vp }).promise; page.cleanup();
    return toBlob(c, 'image/jpeg', 0.85);
  }
  // One page -> { blob: finished 1920x1080 PNG, page: the page alone (null when it fills the frame), fullFrame, srcW, srcH }
  async function renderPdfPage(doc, n, bg) {
    const page = await doc.getPage(n), v1 = page.getViewport({ scale: 1 });
    const exact = Math.abs(v1.width / v1.height - W / H) < 0.006; // 16:9 slides fill the frame
    let viewport, pw, ph, transform;
    if (exact) { viewport = page.getViewport({ scale: W / v1.width }); pw = W; ph = H; transform = [1, 0, 0, H / viewport.height, 0, 0]; }
    else {
      viewport = page.getViewport({ scale: Math.min(W / v1.width, H / v1.height) });
      pw = Math.max(1, Math.min(W, Math.round(viewport.width))); ph = Math.max(1, Math.min(H, Math.round(viewport.height)));
    }
    const pc = canvas(pw, ph), px = pc.getContext('2d');
    px.fillStyle = '#fff'; px.fillRect(0, 0, pw, ph);
    await page.render({ canvasContext: px, viewport, ...(transform ? { transform } : {}) }).promise; page.cleanup();
    const out = canvas(W, H), ox = out.getContext('2d');
    if (exact) ox.drawImage(pc, 0, 0);
    else { ox.drawImage(bg, 0, 0, W, H); ox.drawImage(pc, Math.floor((W - pw) / 2), Math.floor((H - ph) / 2)); }
    return { blob: await toBlob(out, 'image/png'), page: exact ? null : await toBlob(pc, 'image/png'), fullFrame: exact, srcW: pw, srcH: ph };
  }

  // Small JPEG preview of any image the page might not be able to show itself (e.g. HEIC in Chrome).
  async function previewBlob(file, max = 480) {
    const bmp = await toBitmap(file), { w, h } = size(bmp), k = Math.min(1, max / Math.max(w, h));
    return toBlob(scaleTo(bmp, Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))), 'image/jpeg', 0.85);
  }

  // Background template: cover-fit any image to 1920x1080.
  async function makeBackground(file) {
    const bmp = await toBitmap(file), { w, h } = size(bmp);
    const sc = Math.max(W / w, H / h), tw = Math.round(w * sc), th = Math.round(h * sc);
    const big = scaleTo(bmp, tw, th), c = canvas(W, H);
    c.getContext('2d').drawImage(big, Math.floor((W - tw) / 2), Math.floor((H - th) / 2));
    return toBlob(c, 'image/png');
  }

  g.Fit = { W, H, fitImage, loadBg, makeBackground, isImageFile, previewBlob, HEIC_EXT, isPdfFile, openPdf, pdfThumb, renderPdfPage, MAX_PDF_PAGES };
})(window);
