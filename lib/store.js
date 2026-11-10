const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DIRS = {
  root: DATA,
  originals: path.join(DATA, 'originals'),
  processed: path.join(DATA, 'processed'),
  thumbs: path.join(DATA, 'thumbs'),
  tmp: path.join(DATA, 'tmp'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
const DB_FILE = path.join(DATA, 'db.json');

const DEFAULTS = {
  churchName: 'Our Church',
  timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  rolloverDay: 1,      // 0=Sun … 1=Mon (week starts Monday)
  rolloverHour: 0,     // hour of day the new week starts
  imageDuration: 10,   // seconds each image is shown
  showCaptions: true,  // show title/description on the display
  transition: 'fade',  // fade | none
  uploadCode: '',      // optional shared code for the upload page
  uploadsOpen: true,
  keepWeeks: 8,        // old weeks are deleted after this many weeks
  maxUploadMB: 2048,
  bgVersion: 1,
};

let db;
function load() {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = {}; }
  db.settings = { ...DEFAULTS, ...(db.settings || {}) };
  db.items = db.items || [];
  db.auth = db.auth || {};
  if (!db.auth.secret) db.auth.secret = crypto.randomBytes(32).toString('hex');
  if (!db.auth.hash) {
    const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('hex');
    db.auth.hash = hashPassword(pw);
    if (!process.env.ADMIN_PASSWORD) {
      console.log(`\n  No ADMIN_PASSWORD set. Initial admin password: ${pw}\n  (change it under Admin → Settings)\n`);
    }
  }
  save();
}

let saving = false, dirty = false;
function save() {
  // Atomic write; coalesce rapid calls.
  if (saving) { dirty = true; return; }
  saving = true;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
  saving = false;
  if (dirty) { dirty = false; save(); }
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(String(pw), salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

load();
module.exports = {
  DIRS, DEFAULTS,
  get db() { return db; },
  save, hashPassword, checkPassword,
  bgPath: () => path.join(DATA, 'background.png'),
};
