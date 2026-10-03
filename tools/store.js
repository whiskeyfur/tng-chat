// The database as the game's store (docs/database.md), when data/settings.json has "database"
// ({ host, port, user, password, database }; never in git): the designs, the star charts and the
// system library come from it, and the ships' saves, the starbases' and the accounts go to it.
// Without "database", the game keeps to its files (config/, data/, shipcore-data/), as before.
//
// Reads are made at start, and the relay and the ship's computers start in order, so they're
// synchronous: a child process (tools/db.js) answers each. Writes go in the background, in order,
// each cycle of them (what's waiting) one transaction, the latest of each kind kept if the database
// is away (retried every 5 s); flushSync() writes what's waiting before a process stops.
const path = require('path');
const { execFileSync } = require('child_process');
const SETTINGS = require('./settings');

const DB_JS = path.join(__dirname, 'db.js');
const conf = () => SETTINGS.read().database || null;
let off = false;
const enabled = () => !off && !!conf()?.user;
// (tools/db.js itself works from config/ when it loads it: the game's reads here are off in its process.)
const filesOnly = () => { off = true; };
const where = () => { const c = conf() || {}; return `${c.user}@${c.host || '127.0.0.1'}:${c.port || 3306}/${c.database || 'startrek'}`; };

// tools/db.js <args>, given input (JSON on its stdin): what it prints, parsed. Throws, saying why.
function call(args, input) {
  try {
    const out = execFileSync(process.execPath, [DB_JS, ...args], { input: input === undefined ? '' : JSON.stringify(input), maxBuffer: 256 << 20, stdio: ['pipe', 'pipe', 'pipe'] });
    return JSON.parse(out.toString() || 'null');
  } catch (err) {
    const why = err.stderr?.toString().trim().split('\n').filter(Boolean).pop() || err.message;
    throw Object.assign(new Error(`the database (${where()}): ${why}`), { why });
  }
}

// The designs, the star charts and the system library: { designs, charts, types, differs }, read once.
let snap = null;
const snapshot = () => (snap ||= call(['snapshot']));
// The same, waited for: a database that can't be reached is said, and tried every 10 s (the relay
// can't start without its designs, and mustn't quietly fall back to files).
function snapshotWaiting(log = console.error) {
  for (let tries = 0; ; tries++) {
    try { const s = snapshot(); if (tries) log(`database: reached ${where()}`); return s; } catch (err) {
      log(`database: ${where()} can't be reached (${err.why || err.message}): the game can't start without it. Waiting for it (trying again every 10 s).`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
    }
  }
}
// The relay's state: { bases (as data/starbases.json), users, sessions }. On the first start with the
// database, what the files hold is brought in (they stay as they are).
const relayState = (files) => call(['relay-state'], files);
// A ship's save (its .nav.json, as its computer keeps it), or null for a new ship; a ship the
// database hasn't seen yet brings in its file's.
const nav = (ship, file) => call(['nav', ship, file]);
// A design saved (the admin page's editor): its systems and links, worked out again.
const saveDesign = (id, design) => call(['save-design', id], design);

// --- writes, in the background ---------------------------------------------------------------
let conn = null, busy = false, timer = null, lastErr = 0, seq = 0;
const pending = new Map(); // key -> { op, v }
const latest = new Map(); // key -> the newest v asked for
// op: { kind: 'nav' | 'bases' | 'users' | 'sessions', ... } (tools/db.js apply). The newest of a key wins.
function write(key, op) {
  const v = ++seq;
  latest.set(key, v);
  pending.set(key, { op, v });
  if (!timer && !busy) timer = setTimeout(drain, 0);
}
async function drain() {
  timer = null;
  if (!pending.size) return;
  busy = true;
  const batch = [...pending];
  pending.clear();
  try {
    const DB = require('./db');
    if (!conn) { conn = await DB.connect(); conn.on('error', () => { conn = null; }); }
    await DB.applyAll(conn, batch.map(([, p]) => p.op)); // (one transaction: all of the cycle or none)
  } catch (err) {
    // (Kept to try again, ahead of what came since, unless something newer of the same key did.)
    const since = [...pending];
    pending.clear();
    for (const [k, p] of batch) if (latest.get(k) === p.v) pending.set(k, p);
    for (const [k, p] of since) pending.set(k, p);
    try { conn?.destroy(); } catch {}
    conn = null;
    if (Date.now() - lastErr > 60000) { lastErr = Date.now(); console.warn(`database: saving to ${where()} failed (${err.message}): trying again every 5 s`); }
    busy = false;
    timer = setTimeout(drain, 5000);
    return;
  }
  busy = false;
  if (pending.size && !timer) timer = setTimeout(drain, 0);
}
// What's waiting, written now (before a process stops). true, or false (said).
function flushSync(log = console.warn) {
  clearTimeout(timer); timer = null;
  const ops = [...pending.values()].map((p) => p.op);
  pending.clear();
  if (!ops.length) return true;
  try { call(['write'], ops); return true; } catch (err) { log(`database: saving before stopping failed: ${err.message}`); return false; }
}
function close() { if (conn && !busy && !pending.size) { try { conn.end(); } catch {} conn = null; } }

module.exports = { enabled, filesOnly, where, snapshot, snapshotWaiting, relayState, nav, saveDesign, write, flushSync, close };
