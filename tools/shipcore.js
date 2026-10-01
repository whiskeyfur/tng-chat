#!/usr/bin/env node
// A ship's computer: keeps one or more ships alive on a comm relay, holds
// their libraries and flies them: it simulates each ship's position, heading
// and speed in the sector as Helm commands, and saves it. Run as many as you
// like; computers running the same ship keep each other's libraries in sync
// through the relay, and one of them (the relay picks) flies the ship while
// the others keep a copy of its position, ready to take over.
//
//   node tools/shipcore.js Enterprise Defiant
//   node tools/shipcore.js --relay wss://relay.example.com --data ./ship-data --key secret Enterprise
//   node tools/shipcore.js --position 500,480 Enterprise   (where a new ship starts)
//
// Files live in <data>/<ship>/ (default ./shipcore-data, next to where you run
// it), with an index (.index.json) that also remembers deletions, so a file
// deleted elsewhere isn't brought back by this computer. Reconnects by itself.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const TID_LEN = 12;
const CHUNK = 64 * 1024;

function parseArgs(argv) {
  const opts = { relay: process.env.RELAY || 'ws://localhost:8080', data: process.env.SHIPCORE_DATA || path.resolve('shipcore-data'), key: process.env.OPERATOR_KEY || '', ships: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--relay') opts.relay = argv[++i];
    else if (a === '--data') opts.data = path.resolve(argv[++i]);
    else if (a === '--key') opts.key = argv[++i];
    else if (a === '--position') { const [x, y] = argv[++i].split(',').map(Number); opts.position = { x, y }; }
    else if (a === '-h' || a === '--help') opts.help = true;
    else opts.ships.push(a);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.ships.length) {
  console.log('usage: node tools/shipcore.js [--relay ws://host:port] [--data folder] [--key operator-key] [--position x,y] <ship> [ship...]');
  process.exit(opts.help ? 0 : 1);
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// --- storage: <data>/<ship>/<file> plus .index.json ------------------------------

const safeName = (raw) => {
  const name = String(raw || '').normalize('NFC').replace(/[\x00-\x1f\x7f]/g, '').replace(/[/\\]/g, '_').trim().replace(/^\.+/, '').slice(0, 120);
  return name || null;
};

class ShipStore {
  constructor(ship) {
    this.ship = ship;
    this.dir = path.join(opts.data, ship);
    fs.mkdirSync(this.dir, { recursive: true });
    this.indexFile = path.join(this.dir, '.index.json');
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); } catch {}
    this.index = new Map(Object.entries(saved));
    // Reconcile with what's actually on disk: new files are added, missing
    // ones dropped (deletion records are kept).
    for (const f of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!f.isFile() || f.name.startsWith('.')) continue;
      const st = fs.statSync(path.join(this.dir, f.name));
      const e = this.index.get(f.name);
      if (!e || e.deleted || e.size !== st.size) this.index.set(f.name, { name: f.name, size: st.size, modified: e && !e.deleted ? e.modified : st.mtimeMs });
    }
    for (const [name, e] of this.index) if (!e.deleted && !fs.existsSync(path.join(this.dir, name))) this.index.delete(name);
    this.save();
  }
  save() { fs.writeFileSync(this.indexFile, JSON.stringify(Object.fromEntries(this.index))); }
  file(name) { return path.join(this.dir, name); }
  files() { return [...this.index.values()]; }
}

const stores = new Map(opts.ships.map((s) => [s.toLowerCase(), new ShipStore(s)]));

// --- navigation: the ship's position in the sector ------------------------------
//
// Sector coordinates run 0..1000. Speeds in units per second: impulse 0.5,
// warp w = 2 * w^1.8 (warp 9 crosses the sector in about ten seconds).
// state: { x, y, heading (degrees, 0 = up/north, clockwise), warp (0 = all stop,
//          0.25 = impulse, 1..9), dest: { x, y, name? } | null }

const SECTOR = 1000;
const unitsPerSecond = (warp) => (warp <= 0 ? 0 : warp < 1 ? 0.5 : 2 * warp ** 1.8);

// Power: the reactor's output (450%) split across systems, each 0..100%.
// Engineering sets it; engines set the top speed.
const DEFAULT_POWER = { engines: 80, shields: 60, sensors: 100, transporter: 60, weapons: 50, lifeSupport: 100, replicators: 40, recreation: 10 };
const maxWarp = (power) => (power.engines <= 0 ? 0 : Math.max(0.25, Math.round((power.engines / 100) * 9 * 10) / 10));

for (const store of stores.values()) {
  store.navFile = path.join(store.dir, '.nav.json');
  try { store.nav = JSON.parse(fs.readFileSync(store.navFile, 'utf8')); } catch {}
  if (!store.nav || typeof store.nav.x !== 'number') {
    // New ships start near the middle of the sector, within comms range of each other.
    const p = opts.position || { x: 400 + Math.random() * 200, y: 400 + Math.random() * 200 };
    store.nav = { x: p.x, y: p.y, heading: Math.floor(Math.random() * 360), warp: 0, dest: null };
  }
  store.nav.power = { ...DEFAULT_POWER, ...(store.nav.power || {}) };
  store.primary = false;
  store.saveNav = () => fs.writeFileSync(store.navFile, JSON.stringify(store.nav));
  store.saveNav();
}

const sendNav = (store) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'core-nav', ship: store.ship, nav: store.nav }));

// Fly the ships this computer is primary for: 4 times a second, report once a second.
let tick = 0;
setInterval(() => {
  tick++;
  for (const store of stores.values()) {
    if (!store.primary) continue;
    const n = store.nav;
    const step = unitsPerSecond(n.warp) / 4;
    if (step > 0) {
      if (n.dest) {
        const dx = n.dest.x - n.x, dy = n.dest.y - n.y, d = Math.hypot(dx, dy);
        n.heading = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
        // Arrive: stop on the spot (a few units short of a ship, so it's in transporter range).
        const stopAt = n.dest.name ? 5 : 0;
        if (d - stopAt <= step) {
          const k = d > 0 ? Math.max(0, d - stopAt) / d : 0;
          n.x += dx * k; n.y += dy * k;
          log(`${store.ship}: arrived at ${n.dest.name ? `the ${n.dest.name}` : `${Math.round(n.dest.x)}, ${Math.round(n.dest.y)}`}`);
          n.warp = 0; n.dest = null; n.arrived = Date.now();
        } else { n.x += (dx / d) * step; n.y += (dy / d) * step; }
      } else {
        const a = n.heading * Math.PI / 180;
        n.x += Math.sin(a) * step; n.y -= Math.cos(a) * step;
      }
      // The sector has edges: stop there.
      const cx = Math.min(SECTOR, Math.max(0, n.x)), cy = Math.min(SECTOR, Math.max(0, n.y));
      if (cx !== n.x || cy !== n.y) { n.x = cx; n.y = cy; n.warp = 0; n.dest = null; log(`${store.ship}: all stop at the edge of the sector`); }
    }
    if (tick % 4 === 0 || step === 0 && n.arrived && Date.now() - n.arrived < 300) sendNav(store);
    if (tick % 20 === 0) store.saveNav();
  }
}, 250);
const storeFor = (ship) => stores.get(String(ship || '').toLowerCase());

// --- relay connection ---------------------------------------------------------------

let ws = null;
const puts = new Map(); // tid -> { store, name, modified, tmp, out, size }

function sendIndex(store) {
  ws?.send(JSON.stringify({ type: 'core-index', ship: store.ship, files: store.files() }));
}

async function sendFile(tid, store, name) {
  const e = store.index.get(name);
  if (!e || e.deleted) return ws.send(JSON.stringify({ type: 'core-get-error', tid, reason: 'no such file' }));
  const prefix = Buffer.from(tid, 'ascii');
  try {
    for await (const chunk of fs.createReadStream(store.file(name), { highWaterMark: CHUNK })) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(Buffer.concat([prefix, chunk]));
      while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > 4 * 1024 * 1024) await new Promise((r) => setTimeout(r, 20));
    }
    ws.send(JSON.stringify({ type: 'core-get-end', tid }));
  } catch (err) {
    ws.send(JSON.stringify({ type: 'core-get-error', tid, reason: err.message }));
  }
}

function onMessage(raw, isBinary) {
  if (isBinary) {
    const p = puts.get(raw.subarray(0, TID_LEN).toString('ascii'));
    if (p) { p.out.write(raw.subarray(TID_LEN)); p.size += raw.length - TID_LEN; }
    return;
  }
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  switch (msg.type) {
    case 'shipcore-ok':
      log(`online at ${msg.relay}: ${msg.ships.join(', ')}`);
      for (const s of stores.values()) { sendIndex(s); sendNav(s); }
      break;
    case 'core-primary': {
      // The relay picks one computer per ship to fly it; the others keep a copy.
      const store = storeFor(msg.ship);
      if (!store) return;
      if (msg.nav) store.nav = msg.nav;
      if (store.primary !== !!msg.primary) log(`${store.ship}: ${msg.primary ? 'flying the ship' : 'standing by (another computer is flying)'}`);
      store.primary = !!msg.primary;
      store.saveNav();
      if (store.primary) sendNav(store);
      break;
    }
    case 'core-power': {
      // Engineering's power distribution (the relay has checked it).
      const store = storeFor(msg.ship);
      if (!store || !store.primary || !msg.power) return;
      const n = store.nav;
      n.power = { ...n.power, ...msg.power };
      if (n.warp > maxWarp(n.power)) n.warp = maxWarp(n.power); // less power to engines: slow down
      log(`${store.ship}: power ${Object.entries(n.power).map(([k, v]) => `${k} ${v}%`).join(', ')}`);
      store.saveNav();
      sendNav(store);
      break;
    }
    case 'core-set': {
      // Ship settings the relay has checked: alert status, transporter lockout,
      // and the hull, shields and damage (the relay runs combat).
      const store = storeFor(msg.ship);
      if (!store || !store.primary || !msg.set) return;
      for (const k of ['alert', 'lockout', 'combat', 'eng']) if (k in msg.set) store.nav[k] = msg.set[k];
      // Destroyed: rebuilt at a starbase.
      if (msg.set.respawn) { Object.assign(store.nav, { x: msg.set.respawn.x, y: msg.set.respawn.y, warp: 0, dest: null }); delete store.nav.arrived; log(`${store.ship}: destroyed, rebuilt at ${msg.set.respawn.x}, ${msg.set.respawn.y}`); }
      // Towed by another ship's tractor beam: moved along behind it.
      if (msg.set.moveTo) { Object.assign(store.nav, { x: msg.set.moveTo.x, y: msg.set.moveTo.y, heading: msg.set.moveTo.heading ?? store.nav.heading, warp: 0, dest: null }); delete store.nav.arrived; }
      const said = Object.entries(msg.set).filter(([k]) => !['combat', 'eng', 'respawn', 'moveTo'].includes(k));
      if (said.length) log(`${store.ship}: ${said.map(([k, v]) => `${k} ${v}`).join(', ')}`);
      store.saveNav();
      sendNav(store);
      break;
    }
    case 'core-nav-sync': {
      // A copy of the ship's position from the computer that's flying it.
      const store = storeFor(msg.ship);
      if (store && !store.primary && msg.nav) { store.nav = msg.nav; if (Math.random() < 0.2) store.saveNav(); }
      break;
    }
    case 'core-helm': {
      // Helm's orders: a destination (a point or a ship), or a heading, and a speed.
      const store = storeFor(msg.ship);
      if (!store || !store.primary) return;
      const n = store.nav;
      if (msg.dest !== undefined) n.dest = msg.dest;
      if (typeof msg.heading === 'number') { n.heading = ((msg.heading % 360) + 360) % 360; n.dest = msg.dest ?? null; }
      if (typeof msg.warp === 'number') n.warp = Math.max(0, Math.min(maxWarp(n.power), msg.warp));
      delete n.arrived;
      store.saveNav();
      sendNav(store);
      break;
    }
    case 'shipcore-failed':
      log(`refused: ${msg.reason}`);
      process.exit(1);
      break;
    case 'core-put': {
      // A file is arriving (an upload, or a copy from another computer).
      const store = storeFor(msg.ship), name = safeName(msg.name);
      if (!store || !name) return ws.send(JSON.stringify({ type: 'core-put-error', tid: msg.tid, reason: 'unknown ship or bad name' }));
      const tmp = path.join(store.dir, `.incoming-${crypto.randomBytes(6).toString('hex')}`);
      puts.set(msg.tid, { store, name, modified: msg.modified, tmp, out: fs.createWriteStream(tmp), size: 0 });
      break;
    }
    case 'core-put-end': {
      const p = puts.get(msg.tid);
      if (!p) return;
      puts.delete(msg.tid);
      p.out.end(() => {
        const cur = p.store.index.get(p.name);
        if (cur && cur.modified > p.modified) { fs.rmSync(p.tmp, { force: true }); return sendIndex(p.store); } // already have newer
        fs.renameSync(p.tmp, p.store.file(p.name));
        p.store.index.set(p.name, { name: p.name, size: p.size, modified: p.modified });
        p.store.save();
        log(`${p.store.ship}: stored ${p.name} (${p.size} bytes)`);
        ws.send(JSON.stringify({ type: 'core-put-ok', tid: msg.tid, name: p.name }));
        sendIndex(p.store);
      });
      break;
    }
    case 'core-put-abort': {
      const p = puts.get(msg.tid);
      if (!p) return;
      puts.delete(msg.tid);
      p.out.destroy();
      fs.rmSync(p.tmp, { force: true });
      break;
    }
    case 'core-get': {
      const store = storeFor(msg.ship), name = safeName(msg.name);
      if (!store || !name) return ws.send(JSON.stringify({ type: 'core-get-error', tid: msg.tid, reason: 'no such file' }));
      sendFile(msg.tid, store, name);
      break;
    }
    case 'core-delete': {
      const store = storeFor(msg.ship), name = safeName(msg.name);
      if (!store || !name) return;
      const cur = store.index.get(name);
      if (cur && cur.modified >= msg.at) return sendIndex(store);
      fs.rmSync(store.file(name), { force: true });
      store.index.set(name, { name, size: 0, modified: msg.at, deleted: true });
      store.save();
      log(`${store.ship}: deleted ${name}`);
      sendIndex(store);
      break;
    }
  }
}

let delay = 1000;
function connect() {
  ws = new WebSocket(opts.relay);
  ws.on('open', () => {
    delay = 1000;
    ws.send(JSON.stringify({ type: 'shipcore', ships: opts.ships, key: opts.key }));
  });
  ws.on('message', onMessage);
  ws.on('close', () => {
    for (const p of puts.values()) { p.out.destroy(); fs.rmSync(p.tmp, { force: true }); }
    puts.clear();
    log(`relay connection lost; retrying in ${Math.round(delay / 1000)}s`);
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 30000);
  });
  ws.on('error', () => {}); // 'close' follows
}

log(`ship's computer for ${opts.ships.join(', ')}; library in ${opts.data}; relay ${opts.relay}`);
connect();
// Save where the ships are before stopping.
const shutdown = () => { for (const s of stores.values()) s.saveNav(); process.exit(0); };
process.on('SIGINT', () => { log('shutting down'); shutdown(); });
process.on('SIGTERM', shutdown);
