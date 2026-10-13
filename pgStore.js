// pgStore.js — keeps SellHub's data in a real PostgreSQL database.
//
// How it works (phase 1, deliberately low-risk):
//   * The app still reads/writes its JSON files exactly as before (fast, no code changes elsewhere).
//   * Every save is ALSO copied to PostgreSQL (table "kv"), and every uploaded photo to table "blobs".
//   * On boot, the database copy is loaded back BEFORE the site starts, so a wiped disk, a redeploy
//     or a restart can never lose accounts, orders or wallet balances.
//   * The first time it connects to an empty database, it uploads whatever the server currently has.
//
// Turn it on by setting the DATABASE_URL environment variable. Without it, this module does nothing.

const URL_ = process.env.DATABASE_URL || '';
const enabled = !!URL_;
let pool = null;
let ready = false;
let lastOkAt = null;
let lastError = '';
const pendingDocs = new Map();   // name -> latest JSON text
const pendingBlobs = new Map();  // name -> { buf, mime }
const pendingDeletes = new Set();
const ROW_TABLES = ['products', 'orders'];   // one database row per product / per order
const rowState = {};                         // table -> { known: Map(id -> {seq, text}), maxSeq }
const pendingRows = {};                      // table -> Map(id -> {seq, text} | null(delete))
ROW_TABLES.forEach(t => { rowState[t] = { known: new Map(), maxSeq: 0 }; pendingRows[t] = new Map(); });
function pendingRowCount() { return ROW_TABLES.reduce((n, t) => n + pendingRows[t].size, 0); }
let flushing = false;
let timer = null;

function log(...a) { console.log('🗄️ ', ...a); }

async function init() {
  if (!enabled) return false;
  try {
    if (!pool) {
      const { Pool } = require('pg');
      const local = /@(localhost|127\.0\.0\.1)[:/]/.test(URL_);
      const internal = !/\./.test((URL_.split('@')[1] || '').split(/[:/]/)[0] || '');   // Render internal hosts have no dots
      pool = new Pool({
        connectionString: URL_,
        ssl: (local || internal) ? false : { rejectUnauthorized: false },
        max: 4,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000
      });
      pool.on('error', e => { lastError = e.message; });
    }
    await pool.query('CREATE TABLE IF NOT EXISTS kv (name text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
    await pool.query('CREATE TABLE IF NOT EXISTS blobs (name text PRIMARY KEY, mime text, data bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now())');
    for (const t of ROW_TABLES) {
      await pool.query('CREATE TABLE IF NOT EXISTS ' + t + ' (id text PRIMARY KEY, seq bigint NOT NULL, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
    }
    ready = true; lastOkAt = new Date().toISOString(); lastError = '';
    log('PostgreSQL connected — your data is now saved in the database too.');
    schedule();
    return true;
  } catch (e) {
    lastError = e.message;
    ready = false;
    console.error('❌ Could not connect to the database (' + e.message + '). The site will keep running on its local files; fix DATABASE_URL and redeploy.');
    return false;
  }
}

async function loadAll() {
  const r = await pool.query('SELECT name, data FROM kv');
  return r.rows;
}

// Reads every row of a table (oldest first) and remembers what is stored, so later saves send only the changes.
async function loadRows(table) {
  if (!ROW_TABLES.includes(table)) throw new Error('bad table');
  const r = await pool.query('SELECT id, seq, data FROM ' + table + ' ORDER BY seq');
  const st = rowState[table]; st.known = new Map(); st.maxSeq = 0;
  const out = [];
  for (const row of r.rows) {
    const seq = Number(row.seq);
    st.known.set(String(row.id), { seq, text: JSON.stringify(row.data) });
    if (seq > st.maxSeq) st.maxSeq = seq;
    out.push(row.data);
  }
  return out;
}

// Called whenever the full list is saved. Works out which products/orders are new, changed or removed
// and queues only those. Returns false if the list can't be stored row-by-row (missing/duplicate ids).
function saveRows(table, arr) {
  if (!enabled || !ROW_TABLES.includes(table) || !Array.isArray(arr)) return false;
  const st = rowState[table], pend = pendingRows[table];
  const seen = new Set(), texts = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object' || item.id === undefined || item.id === null || item.id === '') return false;
    const id = String(item.id);
    if (seen.has(id)) return false;
    seen.add(id);
    texts.push([id, JSON.stringify(item)]);
  }
  for (const [id, text] of texts) {
    const k = st.known.get(id);
    if (k && k.text === text) continue;
    const seq = k ? k.seq : ++st.maxSeq;
    st.known.set(id, { seq, text });
    pend.set(id, { seq, text });
  }
  for (const id of Array.from(st.known.keys())) {
    if (!seen.has(id)) { st.known.delete(id); pend.set(id, null); }
  }
  schedule();
  return true;
}

async function getBlob(name) {
  if (!ready) return null;
  try {
    const r = await pool.query('SELECT mime, data FROM blobs WHERE name = $1', [name]);
    return r.rows[0] || null;
  } catch (e) { return null; }
}

function save(name, text) {
  if (!enabled) return;
  pendingDocs.set(name, text);
  schedule();
}
function saveBlob(name, buf, mime) {
  if (!enabled) return;
  pendingBlobs.set(name, { buf, mime });
  schedule();
}
function deleteBlob(name) {
  if (!enabled) return;
  pendingBlobs.delete(name);
  pendingDeletes.add(name);
  schedule();
}

function schedule(delay) {
  if (!enabled || !ready || timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, delay === undefined ? 1000 : delay);
  if (timer.unref) timer.unref();
}

// Sends everything waiting to the database. Anything that fails stays queued and is retried.
async function flush() {
  if (!enabled || !ready || flushing) return;
  flushing = true;
  try {
    while (pendingDocs.size || pendingBlobs.size || pendingDeletes.size || pendingRowCount()) {
      for (const t of ROW_TABLES) {
        const pend = pendingRows[t];
        if (!pend.size) continue;
        const batch = Array.from(pend.entries());
        const ups = batch.filter(([, v]) => v), dels = batch.filter(([, v]) => !v).map(([id]) => id);
        for (let i = 0; i < ups.length; i += 300) {
          const part = ups.slice(i, i + 300);
          await pool.query('INSERT INTO ' + t + ' (id, seq, data, updated_at) SELECT a, b, c::jsonb, now() FROM unnest($1::text[], $2::bigint[], $3::text[]) AS x(a, b, c) ON CONFLICT (id) DO UPDATE SET seq = EXCLUDED.seq, data = EXCLUDED.data, updated_at = now()',
            [part.map(([id]) => id), part.map(([, v]) => v.seq), part.map(([, v]) => v.text)]);
        }
        if (dels.length) await pool.query('DELETE FROM ' + t + ' WHERE id = ANY($1::text[])', [dels]);
        // only forget what was actually sent (newer changes to the same id stay queued)
        for (const [id, v] of batch) { if (pend.get(id) === v) pend.delete(id); }
      }
      for (const [name, text] of Array.from(pendingDocs.entries())) {
        await pool.query(
          'INSERT INTO kv (name, data, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()',
          [name, text]);
        if (pendingDocs.get(name) === text) pendingDocs.delete(name);
      }
      for (const [name, b] of Array.from(pendingBlobs.entries())) {
        await pool.query(
          'INSERT INTO blobs (name, mime, data) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING',
          [name, b.mime || 'application/octet-stream', b.buf]);
        pendingBlobs.delete(name);
      }
      for (const name of Array.from(pendingDeletes)) {
        await pool.query('DELETE FROM blobs WHERE name = $1', [name]);
        pendingDeletes.delete(name);
      }
    }
    lastOkAt = new Date().toISOString(); lastError = '';
  } catch (e) {
    lastError = e.message;
    console.error('Database save failed, will retry:', e.message);
    flushing = false;
    schedule(5000);
    return;
  }
  flushing = false;
}

// Called on shutdown/redeploy so the last changes are not lost.
async function flushNow(maxMs) {
  if (!enabled || !ready) return;
  const stop = Date.now() + (maxMs || 6000);
  if (timer) { clearTimeout(timer); timer = null; }
  while ((pendingDocs.size || pendingBlobs.size || pendingDeletes.size || pendingRowCount() || flushing) && Date.now() < stop) {
    if (!flushing) await flush();
    else await new Promise(r => setTimeout(r, 100));
  }
}

// Uploads any photo files that exist on disk but not yet in the database (first run / after outages).
async function syncBlobsFromDisk(dir, fs, path, mimeOf) {
  if (!enabled || !ready) return 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return 0; }
  if (!names.length) return 0;
  const have = new Set((await pool.query('SELECT name FROM blobs')).rows.map(r => r.name));
  let n = 0;
  for (const name of names) {
    if (have.has(name) || !/^[a-f0-9]{48}\.(jpg|png|webp|gif|pdf)$/.test(name)) continue;
    try {
      await pool.query('INSERT INTO blobs (name, mime, data) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING',
        [name, mimeOf(name), fs.readFileSync(path.join(dir, name))]);
      n++;
    } catch (e) { lastError = e.message; }
  }
  if (n) log('Copied', n, 'photo files into the database.');
  return n;
}

function status() {
  return {
    enabled, connected: ready, waiting: pendingDocs.size + pendingBlobs.size + pendingDeletes.size + pendingRowCount(),
    lastOkAt, lastError
  };
}

module.exports = { enabled, init, loadAll, loadRows, saveRows, getBlob, save, saveBlob, deleteBlob, flush, flushNow, syncBlobsFromDisk, status, _setPool: p => { pool = p; } };
