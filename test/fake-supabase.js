// In-memory stand-in for the few Supabase calls the app uses (database + storage).
const crypto = require('crypto');
const tables = { settings: [], items: [] };
const buckets = { media: new Map(), originals: new Map() };

class Q {
  constructor(t) { this.t = t; this.f = []; }
  select() { this.op = this.op || 'select'; return this; }
  insert(r) { this.op = 'insert'; this.row = r; return this; }
  update(p) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  upsert(r) { this.op = 'upsert'; this.row = r; return this; }
  eq(c, v) { this.f.push((r) => r[c] === v); return this; }
  lt(c, v) { this.f.push((r) => r[c] < v); return this; }
  order(c, o = {}) { this.ord = [c, o.ascending !== false]; return this; }
  limit(n) { this.lim = n; return this; }
  maybeSingle() { this.single = true; return this; }
  then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }
  run() {
    const rows = tables[this.t], m = (r) => this.f.every((f) => f(r));
    if (this.op === 'insert') {
      const r = { hidden: false, version: 0, custom_duration: null, created_at: new Date().toISOString(), ...this.row };
      if (this.t === 'items' && rows.some((x) => x.id === r.id)) return { error: { message: 'dup' } };
      rows.push(r); return { data: null, error: null };
    }
    if (this.op === 'upsert') {
      const i = rows.findIndex((x) => x.id === this.row.id);
      if (i >= 0) rows[i] = this.row; else rows.push(this.row); return { error: null };
    }
    if (this.op === 'update') { rows.filter(m).forEach((r) => Object.assign(r, this.patch)); return { error: null }; }
    if (this.op === 'delete') { tables[this.t] = rows.filter((r) => !m(r)); return { error: null }; }
    let out = rows.filter(m).map((r) => ({ ...r }));
    if (this.ord) { const [c, asc] = this.ord; out.sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1)); }
    if (this.lim) out = out.slice(0, this.lim);
    return { data: this.single ? out[0] || null : out, error: null };
  }
}
const base = () => process.env.SUPABASE_URL + '/storage/v1';
const storage = {
  from: (b) => ({
    createSignedUploadUrl: async (p) => ({ data: { token: 'tok', path: p, signedUrl: `${base()}/object/upload/sign/${b}/${p}?token=tok` }, error: null }),
    createSignedUrl: async (p, exp, o = {}) => ({ data: { signedUrl: `${base()}/object/sign/${b}/${p}?token=tok${o.download ? '&download=' + encodeURIComponent(o.download) : ''}` }, error: null }),
    list: async (prefix = '', o = {}) => {
      const names = new Map();
      for (const k of buckets[b].keys()) {
        if (prefix && !k.startsWith(prefix + '/')) continue;
        const rest = prefix ? k.slice(prefix.length + 1) : k;
        const n = rest.split('/')[0];
        if (!n || (o.search && !n.includes(o.search))) continue;
        names.set(n, { name: n, id: rest.includes('/') ? null : 'x' });
      }
      return { data: [...names.values()].slice(0, o.limit || 100), error: null };
    },
    download: async (p) => (buckets[b].has(p) ? { data: new Blob([buckets[b].get(p).data]), error: null } : { data: null, error: { message: 'not found' } }),
    upload: async (p, body, o = {}) => { buckets[b].set(p, { data: Buffer.from(body), type: o.contentType }); return { data: { path: p }, error: null }; },
    remove: async (paths) => { paths.forEach((p) => buckets[b].delete(p)); return { error: null }; },
  }),
};
module.exports = { tables, buckets, client: { from: (t) => new Q(t), storage }, reset() { tables.settings.length = 0; tables.items.length = 0; Object.values(buckets).forEach((m) => m.clear()); } };
