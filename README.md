# Sunday Screen

Weekly photo/video uploads for the church screen.

| URL | Who | What |
|---|---|---|
| `/` | Congregation / volunteers | Drag & drop photos and videos, add an optional title + description |
| `/display` | The screen/projector | Fullscreen slideshow of **this week's** uploads; one permanent link |
| `/admin` | You | See/download every file, edit titles, reorder, hide, delete, change the background, settings |

## Run it

Requires Node 20+ and `ffmpeg`/`ffprobe` on the PATH.

```bash
npm install
ADMIN_PASSWORD='choose-something' npm start   # PORT=3000 by default
```

If `ADMIN_PASSWORD` isn't set, a random one is printed on first start. Change it under Admin → Settings.
Data (database, originals, screen-ready files) lives in `./data` (override with `DATA_DIR`) — back it up / mount it as a volume.
Put it behind HTTPS (Caddy, nginx, Cloudflare Tunnel…) when exposing it to the internet.

## How it works

- **Weekly reset:** every upload is stamped with its week (Mon 00:00 → Sun 23:59 in your time zone; day/hour/zone are configurable). `/display` and `/` only ever use the current week, and the display reloads itself the moment the week changes — no cron needed. Past weeks stay in Admin for download, then are deleted after "keep past weeks" (default 8).
- **1920×1080 fitting:** a file that is exactly 1920×1080 is used as-is (videos that are already H.264 are remuxed, not re-encoded). Anything else is scaled up *or* down (Lanczos, with a light sharpen when enlarging) to the largest size that fits, centred on the background template. Photos' EXIF rotation is respected.
- **Background:** Admin → Background. Changing it re-renders everything already uploaded.
- **Captions:** titles/descriptions are overlaid by the player (toggle in Settings), not burned into the files.
- **Upload code:** optional shared code (Settings) so only your people can upload; leave blank for an open page.

## Screen setup tip

Browsers block autoplaying sound. For a kiosk PC, launch Chrome with
`--kiosk --autoplay-policy=no-user-gesture-required http://your-server/display`;
otherwise click once on the screen page to unmute/fullscreen.

Note: upscaling is classical interpolation — it makes low-res photos fill the screen cleanly but can't invent detail. HEIC photos depend on the server's libvips build; if one fails, Admin shows the error and the original can still be downloaded.
