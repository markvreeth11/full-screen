# Sunday Screen

Weekly photo/video uploads for the church screen. Static pages + a few serverless functions on **Vercel**, data and files in **Supabase**.

| URL | Who | What |
|---|---|---|
| `/` | Volunteers / congregation | Drag & drop photos and videos, optional title + description |
| `/display` | The screen | Fullscreen slideshow of **this week's** uploads — one permanent link |
| `/admin` | You | See/download every file, edit titles, reorder, hide, delete, change background, settings |

## How it works

- **Weekly reset & auto-delete.** Every upload is stamped with its week (Mon 00:00 → Sun 23:59 in your time zone; configurable). The screen and upload page only ever use the current week, so nothing stale shows on Monday. A daily Vercel Cron job (`/api/cron`) then deletes finished weeks (database rows *and* files). Admin → Settings → "Keep finished weeks for" = `0` by default; raise it if you want past weeks to stay downloadable for a while.
- **1920×1080 fitting happens in the uploader's browser** (`public/fit.js`). Screen-ready images are saved as lossless **PNG**. Exact 1920×1080 images keep their pixels untouched; anything else is scaled up or down to the largest size that fits (in ≤2× steps with a light sharpen when enlarging) and centred on the background template. The untouched original is kept privately for you to download.
- **Videos:** the screen starts playing an upload immediately. In the background a GitHub Action (`.github/workflows/convert-videos.yml`, using `ffmpeg`) converts it to a **1920×1080, 59.94 fps H.264/AAC `.mp4`** (placed over the background template if it isn't 16:9). Admin → **Download** gives that file once it's ready (about 1–3 minutes); the arrow still offers the **Original**. The screen switches to the converted file automatically. A new background re-converts this week's videos.
- **Background:** Admin → Background. Changing it re-fits this week's photos (keep the admin page open until it says *Done*).
- **Upload code:** optional shared code (Settings) so only your people can upload.
- Browsers never get database access. They receive short-lived signed upload URLs from `/api/upload`, which checks the upload code, size limits and open/closed status.

## Set it up

### 1. Supabase
1. Create a project at supabase.com.
2. **SQL Editor** → paste and run `supabase/schema.sql` (creates the tables and the `media` + `originals` storage buckets).
3. **Project Settings → API**: copy the *Project URL*, the *anon* key and the *service_role* key.

Free plan limits: **50 MB per file**, 1 GB storage. Fine for photos; compress longer videos, or upgrade to Pro and raise *Largest video allowed* in Admin → Settings.

### 2. Vercel
1. Import this GitHub repo as a new project (Framework preset: *Other*; no build command).
2. Add these environment variables:

| Name | Value |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | anon key (public) |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key — **secret** |
| `ADMIN_PASSWORD` | the admin password you choose |
| `CRON_SECRET` | any long random string (lets only Vercel trigger the cleanup) |
| `SESSION_SECRET` | optional long random string (signs login cookies) |

3. Deploy. Add your domain under *Settings → Domains* (HTTPS is automatic).

### 3. Video conversion (GitHub)
Vercel can't run `ffmpeg`, so a free GitHub Action converts videos. One-time setup:
1. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (same values as in Vercel).
2. Make it start instantly after an upload (otherwise it runs within the hour): GitHub → profile → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**. Repository access: *Only select repositories* → this repo. Permissions → Repository → **Actions: Read and write**. Copy the token into Vercel as `GH_DISPATCH_TOKEN`, then redeploy.
3. Open the repo's **Actions** tab and enable workflows if GitHub asks. You can run *Convert videos* by hand there at any time.

### 4. Share
- Bookmark/send `https://your-domain/` to uploaders.
- Open `https://your-domain/display` on the screen PC. For sound: launch Chrome with `--kiosk --autoplay-policy=no-user-gesture-required`, or click the page once.
- First thing: open `/admin` → Settings and set church name, time zone and (recommended) an upload code.

## Develop / test

```bash
npm install
npm test        # needs FIXTURES=<folder with small.png exact.png vid.mp4 newbg.png>, Playwright, ffprobe
vercel dev      # run the real thing locally with a .env.local containing the variables above
```

`npm test` runs the real pages in Chromium against an in-memory fake of Supabase (`test/`).
