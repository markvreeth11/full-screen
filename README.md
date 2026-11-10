# Sunday Screen

Weekly photo/video uploads for the church screen. Static pages + a few serverless functions on **Vercel**, data and files in **Supabase**.

| URL | Who | What |
|---|---|---|
| `/` | Volunteers / congregation | Drag & drop photos and videos, optional title + description |
| `/display` | The screen | Fullscreen slideshow of **this week's** uploads — one permanent link |
| `/admin` | You | See/download every file, edit titles, reorder, hide, delete, change background, settings |
| `/view` | Volunteers | Read-only: sign in with the viewer password, preview and download this week's uploads |

## How it works

- **Weekly reset & auto-delete.** Every upload is stamped with its week (Mon 00:00 → Sun 23:59 in your time zone; configurable). The screen and upload page only ever use the current week, so nothing stale shows on Monday. A daily Vercel Cron job (`/api/cron`) then deletes finished weeks (database rows *and* files). Admin → Settings → "Keep finished weeks for" = `0` by default; raise it if you want past weeks to stay downloadable for a while.
- **1920×1080 fitting happens in the uploader's browser** (`public/fit.js`). Screen-ready images are saved as lossless **PNG**. Exact 1920×1080 images keep their pixels untouched; anything else is scaled up or down to the largest size that fits (in ≤2× steps with a light sharpen when enlarging) and centred on the background template. The untouched original is kept privately for you to download.
- **Videos are not converted.** The player shows them over the background template, scaled to fit. Ask people to upload **MP4 (H.264)** — iPhone "HEVC" `.mov` files may not play on every screen PC.
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

### 3. Email alerts (optional)
Alerts go to up to 20 addresses (**Admin → Settings → Email me when a file is uploaded**, comma-separated). Use **one** of these ways to send:

**A. A Gmail account (no domain needed — easiest for several recipients)**
1. In the Google account that will send the alerts, turn on **2-Step Verification** (myaccount.google.com → Security).
2. Open **myaccount.google.com/apppasswords**, create an app password named `Weekly Uploads`, and copy the 16-character code.
3. In Vercel add `SMTP_USER` (the Gmail address) and `SMTP_PASS` (the app password), then redeploy.
4. In Admin → Settings enter the addresses, click **Send test email**, then **Save settings**.

The alert email says *"New media has been uploaded! To access your downloads use password - …"* (the volunteer viewer password), and ends with a **Download** button that opens `/view`. Alerts come from that Gmail address, and **each person gets their own email addressed to them** (nobody sees anyone else's address). In Settings, **Send test email** lists exactly who it reached and names any address the mail server refused. Other mail providers work too: also set `SMTP_HOST` (and `SMTP_PORT`, default 465). Some Google Workspace accounts block app passwords — use a regular Gmail account if so.

**B. Resend (needs your own domain for more than one recipient)**
1. Create an account at [resend.com](https://resend.com) → **API Keys → Create API Key**.
2. Add it in Vercel as `RESEND_API_KEY` and redeploy.
3. To alert anyone besides the address you signed up with, verify a domain in Resend (Domains → Add Domain → add the DNS records) and set `NOTIFY_FROM`, e.g. `Weekly Uploads <alerts@yourchurch.org>`.

If both are configured, SMTP (A) is used.

**One email per upload session:** when someone uploads several files at once, the upload page sends a single alert listing all of them. Each file is announced at most once.

You can change the email's **subject** and **message** in Admin → Settings. Placeholders: `{TITLE}` `{TYPE}` `{FILE}` `{SUNDAY}` `{DESCRIPTION}` `{COUNT}` `{PASSWORD}`. *Send test email* previews unsaved edits.

### 4. Volunteer viewer login (optional)
In **Admin → Settings → Volunteer viewer password**, set a password and save. Volunteers sign in at `/view` to see and download the **screen-ready** version of uploads (single files with **Download**, or everything as a .zip with **Download all**) — never the originals. They can't edit, delete, reorder or change settings, and their login doesn't work on `/admin`. Clear the password to switch the page off — existing volunteer sessions are locked out immediately.

### 5. Share
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
