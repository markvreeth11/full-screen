// Week logic. A "week" runs from the rollover moment (default Monday 00:00)
// to the next rollover, evaluated in the church's own time zone.
function localParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour };
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// Returns the key (YYYY-MM-DD of the first day) of the week containing `date`.
function weekKey(date, { timezone, rolloverDay, rolloverHour }) {
  let tz = timezone;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { tz = 'UTC'; }
  const { y, m, d, h } = localParts(date, tz);
  // Treat local wall-clock as UTC so we can do calendar maths safely.
  const shifted = Date.UTC(y, m - 1, d, h) - rolloverHour * 3600e3;
  const dow = new Date(shifted).getUTCDay();
  const back = (dow - rolloverDay + 7) % 7;
  return iso(shifted - back * 86400e3);
}

function weekRange(key) {
  const start = Date.parse(key + 'T00:00:00Z');
  return { start: key, end: iso(start + 6 * 86400e3) };
}

// The Sunday that ends/belongs to a week (first Sunday on or after its start).
function sundayOf(key) {
  const start = Date.parse(key + 'T00:00:00Z');
  return iso(start + ((7 - new Date(start).getUTCDay()) % 7) * 86400e3);
}

module.exports = { weekKey, weekRange, sundayOf };
