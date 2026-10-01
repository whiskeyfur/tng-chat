#!/usr/bin/env node
// A ship's computer: keeps one or more ships alive on a comm relay and holds
// their libraries. Run as many as you like; computers running the same ship
// keep each other's libraries in sync through the relay.
//
//   node tools/shipcore.js Enterprise Defiant
//   node tools/shipcore.js --relay wss://relay.example.com --data ./ship-data --key secret Enterprise
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
    else if (a === '-h' || a === '--help') opts.help = true;
    else opts.ships.push(a);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.ships.length) {
  console.log('usage: node tools/shipcore.js [--relay ws://host:port] [--data folder] [--key operator-key] <ship> [ship...]');
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
      for (const s of stores.values()) sendIndex(s);
      break;
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
process.on('SIGINT', () => { log('shutting down'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
