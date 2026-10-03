// Minimal signaling server: serves the static client, keeps a registry of who is
// online on which ship and at which station, and relays call setup (call /
// accept / decline / hangup) and WebRTC offers/answers/ICE candidates between
// users over WebSocket. Media and data never touch this server; peers connect
// to each other directly.
//
// Crew only see and call crew on their own ship. Each ship's operator
// (operator.html, the ops station) is also aboard as crew at the Operations
// station: crew can call ops, and ops can make, take and transfer calls. The
// operator also manages their crew: force-connect two people, patch someone
// into a call, disconnect someone. Only operators know about other ships: to
// reach another ship, an operator hails it on behalf of someone (or transfers
// a call there), and that ship's operator routes the hail to someone aboard
// (themselves included), which connects the two directly.
// Two operators can agree to open a data link between their ships. Linked
// ships form a data network: everyone on it sees and can call everyone on
// every ship in it. A ship's computer keeps its links open with nobody aboard
// (it can't start one); links close when an operator closes them or a ship
// has neither ops nor a ship's computer.
// A ship comes into existence when its ops station first signs on, and crew
// pick their ship from that list. If ops drops out, calls in progress carry on
// (including calls with other ships) and crew can still call each other aboard,
// but no new off-ship communication can start until ops is back.
// Each ship has a library: files uploaded by its crew, kept by the ship's
// computers (tools/shipcore.js), never on this relay. Crew can download from
// their own ship's library and from every library on their data network.
// Crew can move to another station aboard their ship. The Transporter station
// can beam crew to another ship, unless shields are up on either ship; the
// Tactical station raises and lowers the ship's shields.
// The pages can also be hosted elsewhere (e.g. GitHub Pages) and point at
// this server as their relay, so the library endpoints allow cross-origin use.
// Ops can open an all-hands broadcast for someone aboard, to the whole ship
// or the whole data network: one way, their voice to everyone, no return.
// Communications and ops can also put a radio station on the ship's radio,
// played by every console aboard (or across the data network).
// Set OPERATOR_KEY to require a key for operator consoles.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// Where it listens: data/settings.json (the admin page's Settings), under PORT and HOST in the environment.
const SETTINGS = require('./tools/settings');
const { port: PORT, host: HOST } = SETTINGS.effective();
// Accounts (a username, not a character's name): once the first is registered, every
// page, API and console connection needs a logged-in session (tools/accounts.js).
const ACCOUNTS = require('./tools/accounts');
const SESSION_COOKIE = 'stchat_session';
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter(([k, v]) => k && v).map(([k, v]) => [k, decodeURIComponent(v)]));
const sessionToken = (req) => cookies(req)[SESSION_COOKIE] || null;
const secure = (req) => !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
const sessionCookie = (req, token) => `${SESSION_COOKIE}=${token ? encodeURIComponent(token) : ''}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${token ? 30 * 24 * 3600 : 0}${secure(req) ? '; Secure' : ''}`;
// (Needed: an account exists. Allowed: logged in with one that's active.)
const needLogin = () => ACCOUNTS.any();
const OPERATOR_KEY = process.env.OPERATOR_KEY || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const RELAY_NAME = process.env.RELAY_NAME || 'Subspace Relay Station 47';
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 200) * 1024 * 1024;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const NAME_RE = /^[\w][\w .'-]{0,31}$/;  // names and ships: K'Vatch, Jean-Luc, ...
// The designs (config/ships/<class>.json; see tools/config.js).
const CONFIG = require('./tools/config');
const LAYOUTS = require('./tools/layouts');
const { classes: CLASSES, starbase: BASE_DESIGN, relay: RELAY_FILE } = CONFIG.loadShips((line) => console.warn(line));
// The subspace relays' design (config/ships/<id>.json, kind "relay"): a pure-solar platform.
const RELAY_DESIGN = RELAY_FILE || { id: 'subspace-relay', kind: 'relay', name: 'Subspace Relay', bus: 100, eps: 0, core: 0, maxWarp: 0, shields: 0, arrays: 0, warpCore: false, transporter: false, ports: 0, bay: 0, refit: false, spore: false, torpedoes: 0, stations: [], ties: {}, places: [], seats: {}, solar: { output: 80 }, fusion: false };
const ALL_DESIGNS = [...Object.values(CLASSES), BASE_DESIGN, RELAY_DESIGN];
if (!Object.keys(CLASSES).length || !BASE_DESIGN) { console.error(`config: ${!BASE_DESIGN ? 'no starbase design (config/ships/starbase.json)' : 'no ship classes'} in ${CONFIG.DIR}: the relay can't start`); process.exit(1); }
const DEFAULT_CLASS = CLASSES.galaxy ? 'galaxy' : Object.keys(CLASSES)[0];
const OPS_STATION = 'Operations';   // operators only
const STATIONS = ['Captain', 'First Officer', 'Helm', 'Tactical', 'Security', 'Engineering', 'Medical', 'Science', 'Communications', 'Transporter', 'Crew', 'Shuttle Bay', 'Brig', 'Spore Lab', 'Bridge 1', 'Bridge 2', 'Bridge 3', 'Bridge 4', 'Bridge 5'];
// The bridge: five dedicated stations, and five consoles whose top buttons pick
// what they run (one of CONSOLE_MODES). At a bridge console someone's station is
// what it runs (their controls, notices, orders, readiness) and their console is
// where they are (its power, ODN link, life support, force fields).
// A station's department, where it isn't its own (the Spore Lab is Engineering's).
const DEPT_OF = { 'Spore Lab': 'Engineering' };
const BRIDGE_CONSOLES = ['Bridge 1', 'Bridge 2', 'Bridge 3', 'Bridge 4', 'Bridge 5'];
const CONSOLE_MODES = ['Science', 'Engineering', 'Communications', 'Security', 'Medical'];
const placeOf = (u) => (u.operator ? 'Operations' : u.console || u.station);
const modeOf = (k, c) => (CONSOLE_MODES.includes(eng.get(k)?.bridgeModes?.[c]) ? eng.get(k).bridgeModes[c] : CONSOLE_MODES[BRIDGE_CONSOLES.indexOf(c)]);
// Put someone at a station (a bridge console: running what it's set to).
function seat(u, station) {
  if (BRIDGE_CONSOLES.includes(station)) { u.console = station; u.station = modeOf(u.shipKey, station); } else { u.console = null; u.station = station; }
}
// Operator commands (everything else from an operator is handled as crew).
const OP_COMMANDS = new Set(['connect', 'add', 'end', 'hail', 'route', 'decline-hail', 'cancel-hail', 'transfer',
  'link-request', 'link-accept', 'link-decline', 'link-cancel', 'link-close', 'all-hands', 'all-hands-end', 'remote-block', 'drydock', 'prefix', 'automation']);
// Message types one user may send to another; the server adds `from` and forwards.
const RELAYED = new Set(['call', 'accept', 'decline', 'hangup', 'signal']);
const STATES = new Set(['idle', 'calling', 'ringing', 'in-call']);

// The admin page and its requests: from this machine (or the LAN, if Settings say so), and
// once there are accounts, only for an admin's session.
const isLocal = (addr) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);
const isLan = (addr) => isLocal(addr) || /^(::ffff:)?(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(addr || '') || /^f[cd]|^fe80:/i.test(addr || '');
const adminReach = (addr) => (SETTINGS.read().adminAccess === 'lan' ? isLan(addr) : isLocal(addr));
const server = http.createServer((req, res) => {
  let urlPath = new URL(req.url, 'http://x').pathname;
  if (urlPath.startsWith('/api/account/')) return accountRequest(req, res, urlPath.slice(13));
  if (urlPath.startsWith('/api/poll/')) return pollRequest(req, res, urlPath.slice(10));
  const account = needLogin() ? ACCOUNTS.session(sessionToken(req)) : null;
  if (urlPath === '/api/layouts' || urlPath.startsWith('/api/layouts/') || urlPath.startsWith('/layouts/assets/')) return layoutRequest(req, res, urlPath, account);
  // The admin pages: the admin page and the layout designer.
  const adminPage = urlPath.match(/^\/(admin|designer)(\.html|\.js|\/)?$/);
  if (adminPage) {
    if (!adminReach(req.socket.remoteAddress)) { res.writeHead(403, { 'Content-Type': 'text/plain' }).end(`Admin: ${SETTINGS.read().adminAccess === 'lan' ? 'this network' : 'this machine'} only (Settings, Admin reachable from)`); return; }
    if (needLogin() && account?.role !== 'admin') {
      if (urlPath.endsWith('.js')) { res.writeHead(403).end(); return; }
      res.writeHead(302, { Location: `/login.html?next=${encodeURIComponent(`/${adminPage[1]}`)}${account ? '&admin=1' : ''}` }).end(); return;
    }
    if (!adminPage[2] || adminPage[2] === '/') urlPath = `/${adminPage[1]}.html`;
  }
  // The consoles: logged in first, once there are accounts.
  if ((urlPath === '/' || urlPath === '/index.html') && needLogin() && !account) { res.writeHead(302, { Location: '/login.html' }).end(); return; }
  if (urlPath.startsWith('/api/library')) {
    // Pages hosted on another origin use this server as their relay. Auth is
    // the X-Token header (no cookies), so any origin may call.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'X-Token, X-Filename, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    libraryRequest(req, res, urlPath).catch((err) => {
      console.error('library:', err.message);
      if (!res.headersSent) res.writeHead(500).end('Library error');
    });
    return;
  }
  // d3 for the network map, served from node_modules (no CDN: it works offline and on the LAN).
  const VENDOR = { 'd3-dispatch.js': 'd3-dispatch', 'd3-quadtree.js': 'd3-quadtree', 'd3-timer.js': 'd3-timer', 'd3-force.js': 'd3-force', 'd3-selection.js': 'd3-selection', 'd3-drag.js': 'd3-drag' };
  if (urlPath.startsWith('/vendor/') && VENDOR[urlPath.slice(8)]) {
    const mod = VENDOR[urlPath.slice(8)];
    fs.readFile(path.join(__dirname, 'node_modules', mod, 'dist', `${mod}.min.js`), (err, data) => {
      if (err) return res.writeHead(404).end('Not found');
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' }).end(data);
    });
    return;
  }
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    // no-cache: browsers revalidate on every load, so an updated client.js is
    // never mixed with an outdated one from cache.
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// LCARS layouts (the layout designer; tools/layouts.js): GET /api/layouts lists them and the
// images; GET /api/layouts/<name> is one; PUT saves one, POST /api/layouts/assets adds an image
// (X-Filename), both an admin's (as the admin page is); /layouts/assets/<file> serves an image.
// Reading them is anyone's who may use the consoles (a screen may show one).
function layoutRequest(req, res, urlPath, account) {
  const json = (code, v) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(v));
  const reader = !needLogin() || !!account;
  const admin = adminReach(req.socket.remoteAddress) && (!needLogin() || account?.role === 'admin');
  if (urlPath.startsWith('/layouts/assets/')) {
    if (!reader) return res.writeHead(401).end();
    const a = LAYOUTS.assetPath(decodeURIComponent(urlPath.slice(16)));
    if (!a || req.method !== 'GET') return res.writeHead(404).end('Not found');
    return fs.readFile(a.path, (err, data) => (err ? res.writeHead(404).end() : res.writeHead(200, { 'Content-Type': a.type, 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' }).end(data)));
  }
  if (!reader) return json(401, { error: 'log in first' });
  const what = decodeURIComponent(urlPath.slice(12).replace(/^\//, ''));
  const body = (max, done) => {
    const parts = []; let size = 0, over = false;
    req.on('data', (c) => { size += c.length; if (size > max) { over = true; req.destroy(); } else parts.push(c); });
    req.on('end', () => (over ? null : done(Buffer.concat(parts))));
    req.on('close', () => { if (over && !res.headersSent) json(413, { error: 'too big' }); });
  };
  if (!what && req.method === 'GET') return json(200, { layouts: LAYOUTS.list(), assets: LAYOUTS.assets() });
  if (what === 'assets' && req.method === 'POST') {
    if (!admin) return json(403, { error: 'adding images is for an admin' });
    return body(LAYOUTS.MAX_ASSET, (data) => {
      let name = ''; try { name = decodeURIComponent(String(req.headers['x-filename'] || '')); } catch { /* (a bad name: refused below) */ }
      const r = LAYOUTS.addAsset(name, data);
      if (r.error) return json(400, r);
      console.log(`layouts: image ${r.file} added`);
      json(200, r);
    });
  }
  if (!LAYOUTS.NAME_RE.test(what)) return json(404, { error: 'no such layout' });
  if (req.method === 'GET') { const v = LAYOUTS.read(what); return v ? json(200, { layout: v }) : json(404, { error: 'no such layout' }); }
  if (req.method === 'PUT') {
    if (!admin) return json(403, { error: 'saving layouts is for an admin' });
    return body(LAYOUTS.MAX_LAYOUT, (data) => {
      let v; try { v = JSON.parse(data.toString('utf8')); } catch { return json(400, { error: 'not JSON' }); }
      const err = LAYOUTS.save(what, v);
      if (err) return json(400, { error: err });
      console.log(`layouts: ${what} saved`);
      json(200, { saved: what });
    });
  }
  json(405, { error: 'GET, PUT' });
}

const wss = new WebSocketServer({ server, perMessageDeflate: false }); // (no compression: Safari drops connections that use it)

// The HTTP fallback, for a browser whose WebSocket can't connect (a proxy that won't pass it):
// a connection made of plain HTTP calls. POST /api/poll/open starts one (the same session cookie
// and account rules: 401 without one, once there are accounts); POST /api/poll/send?id= takes a
// list of messages; GET /api/poll/recv?id= returns what's waiting, held open up to 25 s for more.
// To the relay it's a socket like any other (the same connection handler), dropped after 30 s
// with no call. Calls' audio and video stay peer to peer; only signaling and state go this way.
const EventEmitter = require('events');
const POLL = { holdMs: 25000, idleMs: 30000 };
const polls = new Map(); // id -> PollSocket
class PollSocket extends EventEmitter {
  constructor(pollId) { super(); Object.assign(this, { pollId, OPEN: 1, readyState: 1, bufferedAmount: 0, queue: [], waiter: null, seen: Date.now(), closeCode: null }); }
  send(data) { if (this.readyState !== 1) return; this.queue.push(String(data)); this.flush(); }
  flush() { if (this.waiter && (this.queue.length || this.readyState !== 1)) { const w = this.waiter; this.waiter = null; w(); } }
  close(code = 1000, reason = '') {
    if (this.readyState !== 1) return;
    this.readyState = 3; this.closeCode = code;
    this.flush();
    this.emit('close', code, reason);
    setTimeout(() => polls.delete(this.pollId), POLL.holdMs + 5000); // (its last poll still hears why)
  }
}
setInterval(() => { for (const p of polls.values()) if (p.readyState === 1 && Date.now() - p.seen > POLL.idleMs) p.close(1001, 'no polls'); }, 5000).unref();
function pollRequest(req, res, what) {
  const json = (code, v) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(v));
  const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
  if (what === 'open' && req.method === 'POST') {
    if (needLogin() && !ACCOUNTS.session(sessionToken(req))) return json(401, { error: 'log in first' });
    const p = new PollSocket(crypto.randomBytes(16).toString('hex'));
    polls.set(p.pollId, p);
    wss.emit('connection', p, req);
    return json(200, { id: p.pollId }); // (its own id: ws.id is the person's)
  }
  const p = polls.get(id);
  if (!p) return json(410, { closed: 1001, reason: 'no such connection' });
  p.seen = Date.now();
  if (what === 'recv' && req.method === 'GET') {
    const reply = () => { if (res.writableEnded) return; const out = p.queue.splice(0); json(200, { messages: out, ...(p.readyState !== 1 && !out.length ? { closed: p.closeCode } : {}) }); };
    if (p.queue.length || p.readyState !== 1) return reply();
    const t = setTimeout(() => { if (p.waiter === done) p.waiter = null; reply(); }, POLL.holdMs);
    const done = () => { clearTimeout(t); reply(); };
    if (p.waiter) p.waiter(); // (a newer poll replaces an older one)
    p.waiter = done;
    req.on('close', () => { if (p.waiter === done) { p.waiter = null; clearTimeout(t); } });
    return;
  }
  if (what === 'send' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      let list;
      try { list = JSON.parse(body || '[]'); } catch { return json(400, { error: 'bad request' }); }
      if (p.readyState !== 1) return json(410, { closed: p.closeCode });
      for (const m of Array.isArray(list) ? list : []) p.emit('message', Buffer.from(typeof m === 'string' ? m : JSON.stringify(m)), false);
      json(200, { ok: true });
    });
    return;
  }
  if (what === 'close' && req.method === 'POST') { p.close(1000, 'closed'); return json(200, { ok: true }); }
  json(404, { error: 'no such call' });
}
const users = new Map();     // user id ("name@ship", lowercased) -> ws
const operators = new Set(); // operator sockets; each has .ship and .shipKey
const ships = new Map();     // ship key -> display name (first spelling seen)
const sockets = new Set();   // every connection, for the ship list
const shields = new Set();   // ship keys with shields up
const hails = new Map();     // hail id -> { id, fromShip, toShip, caller (user id) }
const links = new Set();     // data links: "shipKeyA|shipKeyB", sorted
const linkSince = new Map(); // link -> when it was made (for the network map)
const addLink = (l) => { if (!links.has(l)) linkSince.set(l, Date.now()); links.add(l); };
const hardLinks = new Set(); // those that are a docked ship's hard link to its starbase (ODN tied through the docking port)
const pendingLinks = new Map(); // link key -> when it was saved: links waiting to be restored after a relay restart
const LINK_WAIT_MS = 60000;
const linkRequests = new Map(); // request id -> { id, fromShip, toShip }

const clean = (s) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '');
const shipKey = (ship) => ship.toLowerCase();
const userId = (name, ship) => `${name.toLowerCase()}@${shipKey(ship)}`;
// Players' rank, species and gender (set at sign-in, changed later). Rank
// shows wherever the name does (rosters, calls, messages, orders: "Lt. Cmdr.
// Brandy"); species and gender only to people in the same place (same ship, same station).
// (A rank comes with a position on the vessel's org chart, picked at sign-in.)
const RANKS = ['Ensign', 'Lt. JG', 'Lieutenant', 'Lt. Cmdr.', 'Commander', 'Captain', 'Admiral', 'Chief Petty Officer', 'Crewman', 'Civilian'];
const RANK_TITLE = { Ensign: 'Ens.', 'Lt. JG': 'Lt. JG', Lieutenant: 'Lt.', 'Lt. Cmdr.': 'Lt. Cmdr.', Commander: 'Cmdr.', Captain: 'Capt.', Admiral: 'Adm.', 'Chief Petty Officer': 'Chief', Crewman: 'Crewman', Civilian: '' };
const SPECIES = ['Human', 'Vulcan', 'Klingon', 'Betazoid', 'Andorian', 'Bajoran', 'Trill', 'Ferengi', 'Romulan', 'Cardassian', 'Android', 'Hologram', 'Other'];
const GENDERS = ['Male', 'Female', 'Non-binary', 'Other'];
const profileFrom = (msg) => ({ species: SPECIES.includes(msg?.species) ? msg.species : null, gender: GENDERS.includes(msg?.gender) ? msg.gender : null });
const titled = (ws) => (ws.rank && RANK_TITLE[ws.rank] ? `${RANK_TITLE[ws.rank]} ${ws.name}` : ws.name);
const samePlace = (a, b) => a.shipKey === b.shipKey && placeOf(a) === placeOf(b);
// What others see of someone: in person adds species and gender.
const seenBy = (viewer, u) => ({ ...info(u), ...(viewer && samePlace(viewer, u) ? { species: u.species || null, gender: u.gender || null } : {}) });
const info = (ws) => ({ id: ws.id, name: ws.name, ship: ws.ship, station: ws.station, ...(ws.rank ? { rank: ws.rank } : {}), title: titled(ws), ...(ws.position ? { position: ws.position, post: ws.post } : {}), ...(ws.shield?.on ? { shielded: true } : {}),
  ...(ws.console ? { console: ws.console } : {}), ...(ws.fielded ? { fielded: true } : {}), ...(ws.sickbay ? { sickbay: true } : {}), ...(ws.confined ? { confined: true } : {}) });
// The sign-in reply: who you are, all of it.
const selfInfo = (ws) => ({ ...info(ws), profile: { species: ws.species || null, gender: ws.gender || null }, equipment: equipmentOf(ws) });
// Crew personal equipment. The personal environmental shield: on, it keeps its wearer
// safe where there's no atmosphere, no heat or no gravity (and sensors read them
// "shielded"); it drains its cell (EQUIP.drain a second) and switches off when that's
// empty; off, it recharges (EQUIP.recharge a second), but only somewhere with power:
// a place whose console or life support has it.
const EQUIP = { drain: Number(process.env.SHIELD_DRAIN) || 0.5, recharge: Number(process.env.SHIELD_RECHARGE) || 1 };
const shieldOf = (ws) => (ws.shield ||= { on: false, charge: 100 });
const equipmentOf = (ws) => ({ shield: { on: shieldOf(ws).on, charge: Math.floor(shieldOf(ws).charge) } });
const poweredAt = (u) => {
  try {
    const k = u.shipKey, f = flow(k), at = placeOf(u), on = engOf(k).ls?.[at];
    return f.consoleOk?.[at] === true || (!!on && ['atmosphere', 'thermal'].some((x) => on[x] !== false && (f.delivered[x] || 0) > 0.5));
  } catch { return false; }
};
function equipmentTick() {
  for (const u of new Set(users.values())) {
    if (!u.shield) continue;
    const s = u.shield, was = [s.on, Math.floor(s.charge)];
    if (s.on) s.charge = Math.max(0, s.charge - EQUIP.drain);
    else if (s.charge < 100 && poweredAt(u)) s.charge = Math.min(100, s.charge + EQUIP.recharge);
    if (s.on && s.charge <= 0) {
      s.on = false;
      send(u, { type: 'notice', text: 'Environmental shield: its power cell is exhausted' });
      broadcastCrew(u.shipKey);
    }
    if (was[0] !== s.on || was[1] !== Math.floor(s.charge)) send(u, { type: 'equipment', ...equipmentOf(u) });
  }
}
setInterval(equipmentTick, 1000);
const crewOf = (key) => [...users.values()].filter((u) => u.shipKey === key);
const opsOf = (key) => [...operators].filter((op) => op.shipKey === key);
const shipName = (key) => ships.get(key) || key;
const newId = (prefix) => prefix + Math.random().toString(36).slice(2, 10);

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function registerShip(name) {
  const key = shipKey(name);
  if (!ships.has(key)) ships.set(key, name);
  return key;
}

// --- broadcasts --------------------------------------------------------------

// Crew see only their own ship's crew list.
// --- data links ---------------------------------------------------------------

const linkKey = (a, b) => [a, b].sort().join('|');
// A link whose path is down (a subspace relay, or out of the system): it stays, signal lost, until it's back.
// (Both ends there and its path down, as linkTick last found it.)
const lostLinks = new Set();
const linkLost = (l) => links.has(l) && lostLinks.has(l);
const linkedTo = (key) => [...links].map((l) => l.split('|')).filter((l) => l.includes(key)).map((l) => (l[0] === key ? l[1] : l[0]));
// Every ship reachable over data links from `key`, including itself.
function network(key) {
  const seen = new Set([key]);
  const todo = [key];
  // (Over live links only: a link whose path is down carries nothing until it's back.)
  while (todo.length) { const x = todo.pop(); for (const k of linkedTo(x)) if (!seen.has(k) && !linkLost(linkKey(x, k))) { seen.add(k); todo.push(k); } }
  return seen;
}
const sameNetwork = (a, b) => network(a).has(b);

// Crew see everyone aboard ships on their data network (just their own ship
// when unlinked). `ops` says whether their own ship has ops on duty.
// The network map's crew counts and ops flags: every ops and Communications console,
// aboard any ship, gets the picture again when anyone comes or goes (once, shortly after).
let presenceTimer = null;
const schedulePresence = () => { presenceTimer ||= setTimeout(() => { presenceTimer = null; new Set([...users.values()].filter((u) => u.operator || u.station === 'Communications').map((u) => u.shipKey)).forEach(broadcastOps); }, 250); };
function broadcastCrew(key) {
  syncRooms();
  schedulePresence();
  scheduleTraffic();
  scheduleNav();
  const net = network(key);
  const everyone = [...net].flatMap(crewOf).sort((a, b) => a.ship.localeCompare(b.ship) || a.name.localeCompare(b.name));
  // (The holographic doctor, where one is active: in rosters and the directory, not to be called.)
  const doctors = [...net].filter(emhActive).map((k) => ({ id: `emh@${k}`, name: 'The Doctor', ship: shipName(k), station: 'Medical', title: 'The Doctor', species: 'Hologram', hologram: true }));
  for (const k of net) {
    const ops = opsOf(k).length > 0;
    for (const u of crewOf(k)) {
      send(u, { type: 'users', users: [...everyone.map((x) => seenBy(u, x)), ...doctors], ops, network: [...net].map(shipName).sort(), hardLinks: linkedTo(k).filter((o) => hardLinks.has(linkKey(k, o))).map(shipName) });
      sendLibrary(u);
    }
    broadcastOps(k);
  }
}

// Refresh crew lists for every ship in any of the given (possibly old) networks.
const refreshNetworks = (keys) => new Set(keys.flatMap((k) => [...network(k)])).forEach(broadcastCrew);

// Each operator sees their own crew with call status, the other ships that
// have an operator on duty, and the hails to and from their ship.
function broadcastOps(key) {
  scheduleTraffic();
  const ops = opsOf(key);
  const comms = crewOf(key).filter((u) => u.station === 'Communications' && !u.operator);
  if (!ops.length && !comms.length && ![...users.values()].some((u) => u.operator && u.controlling === key)) return;
  const roster = crewOf(key)
    .map((u) => ({ ...info(u), state: u.state, peers: u.peers.map(peerInfo) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Ships in range: ops or Communications on duty, within subspace (comms) range.
  // (crewless ships too: a data link can be forced onto them)
  const crewless = [...cores.keys()].filter((k2) => !isBase(k2) && !crewOf(k2).length);
  const commsShips = [...users.values()].filter((u) => u.station === 'Communications').map((u) => u.shipKey);
  const otherShips = [...new Set([...[...operators].map((op) => op.shipKey), ...commsShips, ...BASE_KEYS, ...crewless])]
    .filter((k) => k !== key && (commsOk(key, k) || hardLine(key, k))).map(shipName).sort();
  // Ships a data link could reach: the whole system over subspace (both relays up), or a hard line.
  const linkShips = [...new Set([...[...operators].map((op) => op.shipKey), ...commsShips, ...BASE_KEYS, ...crewless])]
    .filter((k) => k !== key && linkReach(key, k)).map(shipName).sort();
  const describe = (h) => ({ id: h.id, fromShip: shipName(h.fromShip), toShip: shipName(h.toShip), caller: peerInfo(h.caller) });
  const all = [...hails.values()];
  const requests = [...linkRequests.values()].map((r) => ({ id: r.id, fromShip: shipName(r.fromShip), toShip: shipName(r.toShip), from: r.fromShip, to: r.toShip }));
  const msg = {
    type: 'roster',
    ship: shipName(key),
    users: roster,
    ships: otherShips, linkShips,
    incoming: all.filter((h) => h.toShip === key).map(describe),
    outgoing: all.filter((h) => h.fromShip === key).map(describe),
    links: linkedTo(key).map(shipName).sort(),
    hardLinks: linkedTo(key).filter((o) => hardLinks.has(linkKey(key, o))).map(shipName).sort(),
    network: [...network(key)].filter((k) => k !== key).map(shipName).sort(),
    linkIncoming: requests.filter((r) => r.to === key).map(({ id, fromShip }) => ({ id, fromShip })),
    linkOutgoing: requests.filter((r) => r.from === key).map(({ id, toShip }) => ({ id, toShip })),
    graph: networkGraph(),
    remoteBlock: !!engOf(key).remoteBlock,
    automation: AUTO_PANELS.map((p) => ({ panel: p, name: AUTO_NAMES[p], station: AUTO_STATION[p], on: engOf(key).auto?.[p] || false, status: engOf(key).autoStatus?.[p] || '', built: AUTO_BUILT.has(p) })),
    // The shipyard's drydock: the ships in it, any release under way, and holds.
    ...(isShipyard(shipName(key)) ? { drydock: drydocked().filter((o) => shipKey(engOf(o).docked || '') === key).map((o) => ({ ship: shipName(o), hold: !!engOf(o).hold, release: engOf(o).release ? Math.max(0, Math.ceil((engOf(o).release - Date.now()) / 1000)) : null, repair: combatOf(o).repair || null })), berths: DRYDOCK.berths } : {}),
    broadcasts: [...broadcasts.values()].filter((b) => b.ships.has(key) || users.get(b.speaker)?.shipKey === key)
      .map((b) => ({ id: b.bid, speaker: peerInfo(b.speaker), label: b.label, since: b.since })),
  };
  for (const op of ops) if (!op.controlling) send(op, { ...msg, prefix: engOf(key).prefix }); // (one running another vessel's ops sees that one's; only our own ops see our prefix)
  // An ops console remote-controlling this vessel's ops gets its picture too.
  for (const u of users.values()) if (u.operator && u.controlling === key) send(u, msg);
  // Communications runs data links too: it gets the link picture.
  const links = { type: 'comm-links', ships: linkShips, links: msg.links, hardLinks: msg.hardLinks, network: msg.network, linkIncoming: msg.linkIncoming, linkOutgoing: msg.linkOutgoing, graph: msg.graph };
  for (const u of comms) send(u, links);
}

// The whole picture for the ops data link map: every ship, its crew count and
// shields, every open data link and every pending link request.
function networkGraph() {
  return {
    // (Each with what the map's details show: where it is, remote control, crewless.)
    ships: [...RELAYS.map((r) => ({ name: r.name, relay: true, active: true, computer: true, ops: false, crew: 0, x: r.x, y: r.y, off: relayOff.has(shipKey(r.name)), system: r.system, remoteBlock: true, automated: true })), ...shipList().filter((sh) => sh.active).map((sh) => { const k = shipKey(sh.name), n = navState.get(k); return { ...sh, crew: crewOf(k).length, ...(n ? { x: Math.round(n.x), y: Math.round(n.y) } : {}), remoteBlock: !!engOf(k).remoteBlock, automated: isBase(k) || !crewOf(k).length }; })],
    since: Object.fromEntries([...links].map((l) => [l.split('|').map((k) => shipName(k).toLowerCase()).sort().join('|'), linkSince.get(l) || null])),
    // (Links whose path is down: they stay, carrying nothing, until it's back; either end can still close them.)
    lost: [...links].filter(linkLost).map((l) => l.split('|').map(shipName)),
    links: [...links].map((l) => l.split('|').map(shipName)),
    hard: [...hardLinks].filter((l) => links.has(l)).map((l) => l.split('|').map(shipName)), // (docking-port hard links)
    requests: [...linkRequests.values()].map((r) => [shipName(r.fromShip), shipName(r.toShip)]),
  };
}

// Every ship in existence. No ship's computer, no ship: only ships with a
// computer online are offered for sign-in (ops included) or as transporter
// targets. People already aboard when its computer goes offline stay on, so
// the ship is still listed (computer: false) until they leave.
function shipList() {
  const live = new Set([...[...operators].map((op) => op.shipKey), ...[...users.values()].map((u) => u.shipKey), ...cores.keys(), ...BASE_KEYS, ...[...RELAY_KEYS].filter((k) => relayOf(k)?.system === SYSTEM_ID)]);
  return [...live].map((k) => ({
    name: shipName(k), ops: opsOf(k).length > 0, shields: shields.has(k), computer: present(k), active: true, system: SYSTEM_ID, ...(isBase(k) ? { starbase: true, classId: 'starbase' } : { ...(isRelay(k) ? { relay: true } : {}), ...(classGuessed.has(k) ? { classUnknown: true } : {}), class: classOf(k).name, classId: classId(k), stations: stationsOf(k) }), org: orgOf(k), filled: filledOf(k),
  })).sort((a, b) => a.name.localeCompare(b.name));
}
// Starbases run themselves (no ship's computer needed), so they're always there.
const hasComputer = (name) => present(shipKey(name));
// Everyone gets the ship list: the sign-in pull-down, transporter targets,
// and shield status.
function broadcastShips() {
  const list = shipList();
  for (const ws of sockets) if (ws.greeted) send(ws, { type: 'ships', ships: list });
  broadcastAllOps(); // the data link map shows every ship
}

const broadcastAllOps = () => new Set([...operators].map((op) => op.shipKey)).forEach(broadcastOps);

function peerInfo(id) {
  const u = users.get(id);
  return u ? info(u) : { id, name: id.split('@')[0], ship: '', station: '' };
}

function opLog(key, text) {
  for (const op of opsOf(key)) send(op, { type: 'op-log', text });
}

// --- connecting people ------------------------------------------------------

// Force-connect two users (any ships), ending whatever calls they were in.
// The answering side is told first so it is ready before the offer arrives.
// How each call between ships is carried: over a data link (private) or by
// radio (other ships' Communications in range can see it's on). Calls within
// one ship are local (local RF).
const carriers = new Map(); // cid -> 'link' | 'radio'
const carrierFor = (a, b, want) => (a.shipKey === b.shipKey ? 'local' : want === 'radio' || !sameNetwork(a.shipKey, b.shipKey) ? 'radio' : 'link');

function forceConnect(a, b, carrier) {
  const cid = newId('op-');
  carriers.set(cid, carrierFor(a, b, carrier));
  send(b, { type: 'connect', peers: [info(a)], role: 'callee', cid });
  send(a, { type: 'connect', peers: [info(b)], role: 'caller', cid });
}

const inCallTogether = (x, y) => x.state === 'in-call' && x.peers.includes(y.id);

function operatorMessage(op, msg) {
  const ok = (text) => { send(op, { type: 'op-ok', text }); console.log(`[${op.ship} ops] ${text}`); };
  const fail = (reason) => send(op, { type: 'op-error', reason });
  // Operators act only on their own crew, looked up by id.
  const mine = (id) => {
    const u = typeof id === 'string' && users.get(id);
    return u && u.shipKey === op.shipKey ? u : null;
  };

  switch (msg.type) {
    case 'connect': {
      const a = mine(msg.a), b = mine(msg.b);
      if (!a || !b) return fail('both crew members must be aboard and online');
      if (a === b) return fail('pick two different crew members');
      if (inCallTogether(a, b)) return fail(`${a.name} and ${b.name} are already in a call together`);
      forceConnect(a, b);
      return ok(`connected ${a.name} with ${b.name}`);
    }
    case 'add': {
      // Patch `name` into the call `into` is in (which may include other ships).
      const newcomer = mine(msg.name), host = mine(msg.into);
      if (!newcomer || !host) return fail('both crew members must be aboard and online');
      if (host.state !== 'in-call' || !host.cid) return fail(`${host.name} is not in a call`);
      if (newcomer === host || inCallTogether(host, newcomer)) return fail(`${newcomer.name} is already in that call`);
      const members = [host, ...host.peers.map((id) => users.get(id)).filter(Boolean)];
      for (const m of members) send(m, { type: 'add-peer', peer: info(newcomer), cid: host.cid });
      send(newcomer, { type: 'connect', peers: members.map(info), role: 'caller', cid: host.cid });
      for (const k of new Set(members.map((m) => m.shipKey))) {
        if (k !== op.shipKey) opLog(k, `${shipName(op.shipKey)} patched ${newcomer.name} into the call with ${host.name}`);
      }
      return ok(`patched ${newcomer.name} into the call with ${members.map((m) => m.name).join(', ')}`);
    }
    case 'end': {
      const u = mine(msg.name);
      if (!u) return fail('that crew member is not aboard');
      send(u, { type: 'force-hangup' });
      return ok(`disconnected ${u.name}`);
    }
    case 'transfer': {
      // Hand the call the operator is in to someone aboard, or to another ship,
      // and drop out of it. Others in the call stay connected.
      const others = op.peers.map((id) => users.get(id)).filter(Boolean);
      if (op.state !== 'in-call' || !others.length) return fail('you are not in a call');
      const who = others.map((u) => u.name).join(', ');
      if (msg.ship) {
        // Off ship: hail the other ship for the person on the line.
        const target = shipKey(clean(msg.ship));
        if (others.length !== 1) return fail('only a one-to-one call can be transferred to another ship');
        const caller = others[0];
        if (target === op.shipKey) return fail('that is this ship');
        if (target === caller.shipKey) return fail(`${caller.name} is from the ${shipName(target)}`);
        if (!opsOf(target).length) return fail(`no response from ${clean(msg.ship)}: no operator on duty`);
        if (!commsOk(op.shipKey, target)) return fail(`the ${shipName(target)} is out of radio range (${rangeText(op.shipKey, target)})`);
        if ([...hails.values()].some((h) => h.caller === caller.id)) return fail(`${caller.name} already has a hail pending`);
        const h = { id: newId('h-'), fromShip: op.shipKey, toShip: target, caller: caller.id, since: Date.now() };
        hails.set(h.id, h);
        send(op, { type: 'force-hangup', reason: `transferred ${caller.name} to the ${shipName(target)}` });
        send(caller, { type: 'notice', text: `Ops is transferring you to the ${shipName(target)}: hailing now` });
        opLog(target, `incoming hail from the ${shipName(op.shipKey)}: ${caller.name}, ${caller.station} (transferred by ops)`);
        broadcastOps(target);
        broadcastOps(op.shipKey);
        return ok(`transferring ${caller.name} to the ${shipName(target)}: hailing`);
      }
      const target = typeof msg.to === 'string' && users.get(msg.to);
      if (!target || !sameNetwork(op.shipKey, target.shipKey)) return fail('pick someone aboard or on the data network to transfer to');
      if (target === op || others.includes(target)) return fail(`${target.name} is already in that call`);
      if (target.state !== 'idle') return fail(`${target.name} is busy`);
      if (others.length === 1) {
        forceConnect(others[0], target);
        send(op, { type: 'force-hangup', reason: `transferred ${others[0].name} to ${target.name}` });
      } else {
        for (const m of others) send(m, { type: 'add-peer', peer: info(target), cid: op.cid });
        send(target, { type: 'connect', peers: others.map(info), role: 'caller', cid: op.cid });
        send(op, { type: 'force-hangup', reason: `transferred the call to ${target.name}` });
      }
      return ok(`transferred ${who} to ${target.name}`);
    }
    case 'hail': {
      // Hail another ship on behalf of one of our crew.
      const caller = mine(msg.crew);
      const target = shipKey(clean(msg.ship));
      if (!caller) return fail('pick a crew member to put the hail through for');
      if (target === op.shipKey) return fail('that is this ship');
      const automated = isBase(target) && !opsOf(target).length;
      if (automated && !crewOf(target).length) return fail(`${shipName(target)} (automated): nobody aboard to take the call. Docking is open, and data links are accepted automatically`);
      if (!automated && !opsOf(target).length) return fail(`no response from ${clean(msg.ship) || 'that ship'}: no operator on duty`);
      if (!commsOk(op.shipKey, target)) return fail(`the ${shipName(target)} is out of radio range (${rangeText(op.shipKey, target)})`);
      if (!commsUp(op.shipKey, 'radio')) return fail('our radio has no power: hails go out by radio');
      if (!commsUp(target, 'radio')) return fail(`no answer: the ${shipName(target)}'s radio is down`);
      if ([...hails.values()].some((h) => h.caller === caller.id)) return fail(`${caller.name} already has a hail pending`);
      const h = { id: newId('h-'), fromShip: op.shipKey, toShip: target, caller: caller.id, since: Date.now() };
      hails.set(h.id, h);
      send(caller, { type: 'notice', text: `Ops is hailing the ${shipName(target)} for you` });
      opLog(target, `incoming hail from the ${shipName(op.shipKey)}: ${caller.name}, ${caller.station}`);
      broadcastOps(target);
      broadcastOps(op.shipKey);
      if (automated) setTimeout(() => autoAnswerHail(h.id), BASE_DELAY.hail);
      return ok(`hailing the ${shipName(target)} for ${caller.name}`);
    }
    case 'route': {
      // Answer an incoming hail by connecting it to someone aboard.
      const h = hails.get(msg.hail);
      if (!h || h.toShip !== op.shipKey) return fail('that hail is no longer open');
      const callee = mine(msg.to), caller = users.get(h.caller);
      if (!callee) return fail('pick a crew member to route the hail to');
      hails.delete(h.id);
      if (!caller) { broadcastOps(op.shipKey); return fail('the hailing party is no longer on the line'); }
      // Radio, or a data link when there's a link path between the ships.
      const via = msg.via === 'link' && sameNetwork(caller.shipKey, callee.shipKey) ? 'link' : 'radio';
      if (via === 'link' && (!commsUp(caller.shipKey, 'subspace') || !commsUp(callee.shipKey, 'subspace'))) return fail('a subspace relay is down: route it by radio');
      forceConnect(caller, callee, via);
      opLog(h.fromShip, `the ${shipName(op.shipKey)} answered: ${caller.name} is connected to ${callee.name}, ${callee.station} (${via === 'link' ? 'data link' : 'radio'})`);
      broadcastOps(h.fromShip);
      broadcastOps(op.shipKey);
      return ok(`routed the hail from the ${shipName(h.fromShip)} (${caller.name}) to ${callee.name} by ${via === 'link' ? 'data link' : 'radio'}`);
    }
    case 'all-hands': {
      // Open an all-hands broadcast for someone aboard (yourself included).
      const speaker = mine(msg.speaker);
      if (!speaker) return fail('pick someone aboard to speak');
      if ([...broadcasts.values()].some((b) => b.speaker === speaker.id)) return fail(`${speaker.name} is already broadcasting`);
      const b = startAllHands(speaker, msg.scope === 'network' ? 'network' : 'ship');
      return ok(`${speaker.name}: ${b.label}`);
    }
    case 'all-hands-end': {
      const b = broadcasts.get(msg.id);
      if (!b || !(b.ships.has(op.shipKey) || users.get(b.speaker)?.shipKey === op.shipKey)) return fail('that broadcast has already ended');
      endBroadcast(b, `ended by ${op.name}`);
      return ok('all-hands broadcast ended');
    }
    case 'link-request': {
      const target = shipKey(clean(msg.ship));
      if (target === op.shipKey) return fail('that is this ship');
      // Nobody aboard at all (only its computer): the link is forced, nobody's there to refuse it.
      const crewless = present(target) && !isBase(target) && !crewOf(target).length;
      const answers = opsOf(target).length || crewOf(target).some((u) => u.station === 'Communications');
      if (!answers && !isBase(target) && !crewless) return fail(`no response from ${clean(msg.ship) || 'that ship'}: no ops or Communications on duty`);
      if (!hardLine(op.shipKey, target)) {
        if (!subspaceOk(op.shipKey, target)) return fail(`the ${shipName(target)} is not in this star system`);
        if (!commsUp(op.shipKey, 'subspace')) return fail('our subspace relay has no power: data links need it');
        if (!commsUp(target, 'subspace')) return fail(`the ${shipName(target)}'s subspace relay is down`);
      }
      if (links.has(linkKey(op.shipKey, target))) return fail(`a data link with the ${shipName(target)} is already open`);
      if ([...linkRequests.values()].some((r) => linkKey(r.fromShip, r.toShip) === linkKey(op.shipKey, target))) return fail(`a data link with the ${shipName(target)} is already being negotiated`);
      if (crewless && !answers) {
        addLink(linkKey(op.shipKey, target));
        opLog(target, `the ${shipName(op.shipKey)} forced a data link (nobody aboard)`);
        opLog(op.shipKey, `data link with the ${shipName(target)} forced: nobody aboard to refuse it`);
        refreshNetworks([op.shipKey]);
        broadcastAllOps();
        return ok(`data link with the ${shipName(target)} forced (nobody aboard)`);
      }
      const req = { id: newId('l-'), fromShip: op.shipKey, toShip: target };
      linkRequests.set(req.id, req);
      opLog(target, `the ${shipName(op.shipKey)} requests a data link`);
      broadcastAllOps();
      // Starbases accept by themselves after a moment: sooner with someone
      // aboard (but not on ops) to expedite it; their ops can answer first.
      if (isBase(target)) setTimeout(() => autoAcceptLink(req.id), crewOf(target).length && !opsOf(target).length ? BASE_DELAY.linkCrewed : BASE_DELAY.link);
      return ok(`requesting a data link with the ${shipName(target)}`);
    }
    case 'link-accept':
    case 'link-decline':
    case 'link-cancel': {
      const req = linkRequests.get(msg.request);
      const side = msg.type === 'link-cancel' ? req?.fromShip : req?.toShip;
      if (!req || side !== op.shipKey) return fail('that data link request is no longer open');
      linkRequests.delete(req.id);
      const other = msg.type === 'link-cancel' ? req.toShip : req.fromShip;
      if (msg.type === 'link-accept') {
        if (!opsOf(other).length && !crewOf(other).some((u) => u.station === 'Communications')) { broadcastOps(op.shipKey); return fail(`no ops or Communications on duty aboard the ${shipName(other)}`); }
        if (!hardLine(op.shipKey, other) && !subspaceOk(op.shipKey, other)) { broadcastOps(op.shipKey); return fail(`the ${shipName(other)} is not in this star system`); }
        if (!hardLine(op.shipKey, other) && (!commsUp(op.shipKey, 'subspace') || !commsUp(other, 'subspace'))) { broadcastOps(op.shipKey); return fail('a subspace relay is down: no data link'); }
        addLink(linkKey(req.fromShip, req.toShip));
        opLog(other, `the ${shipName(op.shipKey)} accepted: data link open`);
        refreshNetworks([op.shipKey]);
        broadcastAllOps();
        console.log(`data link open: ${shipName(req.fromShip)} - ${shipName(req.toShip)}`);
        return ok(`data link with the ${shipName(other)} open`);
      }
      opLog(other, msg.type === 'link-decline' ? `the ${shipName(op.shipKey)} declined the data link` : `the ${shipName(op.shipKey)} withdrew its data link request`);
      broadcastAllOps();
      return ok(msg.type === 'link-decline' ? `declined the data link from the ${shipName(other)}` : `withdrew the data link request to the ${shipName(other)}`);
    }
    case 'automation': {
      // Ops picks which panels run themselves: { panel, on } (Engineering: { panel, mode: 'startup' | 'shutdown' | null }).
      if (!AUTO_PANELS.includes(msg.panel)) return fail('no such panel to automate (Ops itself never is)');
      if (!AUTO_BUILT.has(msg.panel)) return fail(`${AUTO_NAMES[msg.panel]} automation isn't built yet`);
      const v = msg.panel === 'engineering' ? (['startup', 'shutdown'].includes(msg.mode) ? msg.mode : null) : !!msg.on;
      setAuto(op.shipKey, msg.panel, v);
      return ok(`${AUTO_NAMES[msg.panel]} automation ${v ? `on${typeof v === 'string' ? ` (${v})` : ''}` : 'off'}`);
    }
    case 'prefix': {
      // Ops sets the vessel's command prefix (5 digits, tapped in on a keypad).
      const code = String(msg.code ?? '');
      if (!/^\d{5}$/.test(code)) return fail('a command prefix is 5 digits');
      const e = engOf(op.shipKey);
      e.prefix = code; e.dirty = true;
      if (isBase(op.shipKey)) saveBaseSettings();
      opLog(op.shipKey, `${op.name}: command prefix changed`);
      checkRemotes(); // (sessions on the old one end)
      broadcastOps(op.shipKey);
      return ok('command prefix set');
    }
    case 'drydock': {
      // The shipyard's ops: release a drydocked ship now, or hold it (or stop holding it).
      if (!isShipyard(shipName(op.shipKey))) return fail('only the shipyard has a drydock');
      const t = shipKey(clean(msg.ship)), te = eng.get(t);
      if (!te?.drydock || shipKey(te.docked || '') !== op.shipKey) return fail(`the ${clean(msg.ship)} is not in our drydock`);
      if (msg.action === 'release') { releaseDrydock(t, `released by ${op.name}`); return ok(`released the ${shipName(t)} from drydock`); }
      te.hold = msg.action === 'hold'; te.dirty = true;
      opLog(t, te.hold ? `${shipName(op.shipKey)} is holding us in drydock` : `${shipName(op.shipKey)} no longer holds us in drydock`);
      broadcastOps(op.shipKey); scheduleNav();
      return ok(te.hold ? `holding the ${shipName(t)} in drydock` : `no longer holding the ${shipName(t)}`);
    }
    case 'remote-block': {
      // Ops can refuse remote control of this vessel's stations from other ships.
      engOf(op.shipKey).remoteBlock = !!msg.on;
      engOf(op.shipKey).dirty = true;
      if (isBase(op.shipKey)) saveBaseSettings();
      opLog(op.shipKey, `${op.name}: remote control by other vessels ${msg.on ? 'blocked' : 'allowed'}`);
      scheduleNav();
      broadcastOps(op.shipKey);
      return ok(`remote control by other vessels ${msg.on ? 'blocked' : 'allowed'}`);
    }
    case 'link-close': {
      const other = shipKey(clean(msg.ship));
      if (isRelay(other) || isRelay(op.shipKey)) return fail(`a subspace relay's link: it stays (only the admin page disables a relay)`);
      if (hardLinks.has(linkKey(op.shipKey, other))) return fail(`hard link: docking port. The ${shipName(other)} link ends only when its ODN tie is cut on the Engineering grid, or on undocking`);
      if (!links.delete(linkKey(op.shipKey, other))) return fail(`no data link with the ${clean(msg.ship)}`);
      opLog(other, `the ${shipName(op.shipKey)} closed the data link`);
      refreshNetworks([op.shipKey, other]);
      broadcastAllOps();
      return ok(`closed the data link with the ${shipName(other)}`);
    }
    case 'decline-hail':
    case 'cancel-hail': {
      const h = hails.get(msg.hail);
      const mineToClose = h && (msg.type === 'decline-hail' ? h.toShip : h.fromShip) === op.shipKey;
      if (!mineToClose) return fail('that hail is no longer open');
      hails.delete(h.id);
      const caller = users.get(h.caller);
      if (msg.type === 'decline-hail') {
        if (caller) send(caller, { type: 'notice', text: `The ${shipName(h.toShip)} did not answer the hail` });
        opLog(h.fromShip, `the ${shipName(h.toShip)} declined the hail for ${caller?.name || 'crew'}`);
      } else {
        if (caller) send(caller, { type: 'notice', text: `Ops cancelled the hail to the ${shipName(h.toShip)}` });
        opLog(h.toShip, `the ${shipName(h.fromShip)} cancelled their hail`);
      }
      broadcastOps(h.fromShip);
      broadcastOps(h.toShip);
      return ok(msg.type === 'decline-hail' ? `declined the hail from the ${shipName(h.fromShip)}` : `cancelled the hail to the ${shipName(h.toShip)}`);
    }
  }
}

// Drop hails that can no longer be completed and tell the other side.
function dropHails(test, reason) {
  for (const h of [...hails.values()]) {
    if (!test(h)) continue;
    hails.delete(h.id);
    const caller = users.get(h.caller);
    if (caller) send(caller, { type: 'notice', text: `Hail to the ${shipName(h.toShip)} ended: ${reason}` });
    opLog(h.fromShip, `hail to the ${shipName(h.toShip)} ended: ${reason}`);
    opLog(h.toShip, `hail from the ${shipName(h.fromShip)} ended: ${reason}`);
    broadcastOps(h.fromShip);
    broadcastOps(h.toShip);
  }
}

// A crew member left the comm net (closed the tab, lost network).
// Calls with them end on every ship.
function signOut(ws) {
  users.delete(ws.id);
  leaveBroadcasts(ws);
  leaveRoom(ws);
  dropHails((h) => h.caller === ws.id, `${ws.name} left the comm net`);
  for (const u of users.values()) send(u, { type: 'gone', id: ws.id });
  broadcastCrew(ws.shipKey);
  for (const id of ws.peers) { const p = users.get(id); if (p && p.shipKey !== ws.shipKey) broadcastOps(p.shipKey); }
  console.log(`${ws.name} left the ${ws.ship}`);
  broadcastShips(); // the ship may no longer exist
}

// Beam a crew member to another ship: their call ends, they leave this ship's
// comm net and report aboard the other one, keeping their name and station.
function beam(u, toKey, station, how = 'beamed') {
  const from = u.ship;
  // Site to site: within the ship, to another station's console.
  // Beaming drops you out of any call you're in (the others stay connected).
  if (toKey === u.shipKey) {
    const was = placeOf(u);
    if (u.state !== 'idle') send(u, { type: 'force-hangup', reason: `beamed to ${station}` });
    seat(u, station); u.fielded = false;
    send(u, { type: 'registered', ...selfInfo(u), token: u.token });
    send(u, { type: 'notice', text: `Transporter: beamed from ${was} to ${station}` });
    broadcastCrew(toKey);
    opLog(toKey, `${u.name} beamed from ${was} to ${station}`);
    return;
  }
  const to = station || u.console || u.station;
  send(u, { type: 'force-hangup', reason: `${how} to the ${shipName(toKey)}` });
  signOut(u);
  Object.assign(u, { id: userId(u.name, shipName(toKey)), shipKey: toKey, ship: shipName(toKey), state: 'idle', peers: [], cid: null, fielded: false });
  seat(u, hasStation(toKey, to) ? to : 'Crew');
  users.set(u.id, u);
  send(u, { type: 'registered', ...selfInfo(u), token: u.token, [how === 'walked' ? 'walkedFrom' : how === 'beamed' ? 'beamedFrom' : how === 'returned' ? 'returnedFrom' : 'remoteVia']: from });
  sendShipRadio(u);
  joinBroadcasts(u);
  broadcastCrew(toKey);
  broadcastShips();
  opLog(toKey, `${u.name} (${u.station}) ${{ walked: 'came aboard across the dock', beamed: 'beamed aboard', remote: 'took remote control', returned: 'came back from remote control' }[how]} from the ${from}`);
  // Security is told whenever someone beams aboard (walking in across the dock is expected).
  if (how === 'beamed') for (const s of crewOf(toKey)) if (s.station === 'Security' && s !== u) send(s, { type: 'security-alert', text: `${u.name} (${u.station}) beamed aboard from the ${from}`, at: Date.now() });
  console.log(`${u.name} ${how} from the ${from} to the ${u.ship}`);
}

// --- ship's computers and the library ----------------------------------------------
//
// A ship's computer (tools/shipcore.js) connects as one or more ships rather
// than as a person. While one is connected the ship exists, even with nobody
// aboard. Each ship's library lives on its computers, not on this relay: the
// relay only passes files through. Computers running the same ship keep each
// other in sync: every file change carries a time, the newest wins, and
// deletions are remembered so they don't come back.
//
// Relay <-> computer messages (JSON), plus binary frames for file data, each
// prefixed with a 12-byte transfer id:
//   computer -> relay  shipcore {ships, key}, core-index {ship, files}
//                      core-put-ok {tid} / core-put-error {tid, reason}
//                      core-data (binary) / core-get-end {tid} / core-get-error {tid, reason}
//   relay -> computer  shipcore-ok {relay, ships} / shipcore-failed {reason}
//                      core-put {tid, ship, name, modified} + binary frames + core-put-end {tid}
//                      core-get {tid, ship, name}
//                      core-delete {ship, name, at}

// Session tokens let the browser prove who it is on plain HTTP requests.
const tokens = new Map(); // token -> ws

const cores = new Map();  // ship key -> Set of computer sockets
const TID_LEN = 12;
const newTid = () => crypto.randomBytes(6).toString('hex');

const coresOf = (key) => [...(cores.get(key) || [])];

// Everything the computers of a ship hold, merged: name -> newest entry.
function mergedIndex(key) {
  const merged = new Map();
  for (const c of coresOf(key)) {
    for (const e of (c.index.get(key) || new Map()).values()) {
      const cur = merged.get(e.name);
      if (!cur || e.modified > cur.modified) merged.set(e.name, e);
    }
  }
  return merged;
}

function listLibrary(key) {
  return [...mergedIndex(key).values()].filter((e) => !e.deleted)
    .map(({ name, size, modified }) => ({ name, size, modified }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Every library on this person's data network, their own ship first. A ship
// whose computers are all offline shows its library as offline.
function sendLibrary(ws) {
  const keys = [...network(ws.shipKey)].sort((a, b) => (b === ws.shipKey) - (a === ws.shipKey) || shipName(a).localeCompare(shipName(b)));
  send(ws, { type: 'library', ships: keys.map((k) => ({ name: shipName(k), own: k === ws.shipKey, online: coresOf(k).length > 0, files: listLibrary(k) })) });
}

const refreshLibraries = (key) => { for (const k of network(key)) for (const u of crewOf(k)) sendLibrary(u); };

// A safe file name: no folders, control characters or leading dots.
function safeName(raw) {
  const name = String(raw || '').normalize('NFC').replace(/[\x00-\x1f\x7f]/g, '').replace(/[/\\]/g, '_').trim().replace(/^\.+/, '').slice(0, 120);
  return name || null;
}

function uniqueName(key, name) {
  const taken = (n) => { const e = mergedIndex(key).get(n); return e && !e.deleted; };
  if (!taken(name)) return name;
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) if (!taken(`${base} (${i})${ext}`)) return `${base} (${i})${ext}`;
}

// Transfers in flight, by transfer id.
//  'up'   HTTP upload  -> a computer             { kind, core, res }
//  'down' a computer   -> HTTP download          { kind, core, res }
//  'copy' a computer   -> another computer (sync) { kind, core (source), dest, destTid, key, name }
const transfers = new Map();

const frame = (tid, chunk) => Buffer.concat([Buffer.from(tid, 'ascii'), chunk]);

// Wait for a computer's socket to drain a bit before sending more file data.
async function drain(c) {
  while (c.readyState === c.OPEN && c.bufferedAmount > 4 * 1024 * 1024) await new Promise((r) => setTimeout(r, 20));
}

// Make every computer of a ship hold the newest version of every file (or
// know it was deleted). Called whenever an index changes; safe to repeat.
const copying = new Set(); // `${dest id}|${name}|${modified}` in flight
function syncShip(key) {
  const merged = mergedIndex(key);
  for (const c of coresOf(key)) {
    const mine = c.index.get(key) || new Map();
    for (const w of merged.values()) {
      const have = mine.get(w.name);
      if (have && have.modified >= w.modified) continue;
      if (w.deleted) { send(c, { type: 'core-delete', ship: shipName(key), name: w.name, at: w.modified }); continue; }
      const job = `${c.coreId}|${w.name}|${w.modified}`;
      if (copying.has(job)) continue;
      const src = coresOf(key).find((o) => o !== c && o.index.get(key)?.get(w.name)?.modified === w.modified && !o.index.get(key).get(w.name).deleted);
      if (!src) continue;
      copying.add(job);
      const tid = newTid(), destTid = newTid();
      transfers.set(tid, { kind: 'copy', core: src, dest: c, destTid, job });
      send(c, { type: 'core-put', tid: destTid, ship: shipName(key), name: w.name, modified: w.modified });
      send(src, { type: 'core-get', tid, ship: shipName(key), name: w.name });
    }
  }
}

function endTransfer(tid, error) {
  const t = transfers.get(tid);
  if (!t) return;
  transfers.delete(tid);
  if (t.kind === 'copy') {
    copying.delete(t.job);
    send(t.dest, error ? { type: 'core-put-abort', tid: t.destTid } : { type: 'core-put-end', tid: t.destTid });
  } else if (t.kind === 'down') {
    if (error && !t.res.headersSent) t.res.writeHead(502).end(error);
    else t.res.end();
  } else if (t.kind === 'up') {
    if (!t.res.headersSent) t.res.writeHead(error ? 502 : 200, { 'Content-Type': 'application/json' }).end(error ? error : JSON.stringify(t.result));
  }
}

// Messages from a ship's computer.
function coreMessage(c, msg, isBinary) {
  if (isBinary) {
    const tid = msg.subarray(0, TID_LEN).toString('ascii');
    const t = transfers.get(tid);
    if (!t || t.core !== c) return;
    const chunk = msg.subarray(TID_LEN);
    if (t.kind === 'down') t.res.write(chunk);
    else if (t.kind === 'copy') t.dest.send(frame(t.destTid, chunk));
    return;
  }
  switch (msg.type) {
    case 'core-index': {
      const key = shipKey(clean(msg.ship));
      if (!c.coreShips.has(key) || !Array.isArray(msg.files)) return;
      const idx = new Map();
      for (const f of msg.files.slice(0, 10000)) {
        const name = safeName(f?.name);
        if (!name || typeof f.modified !== 'number') continue;
        idx.set(name, { name, size: Number(f.size) || 0, modified: f.modified, deleted: !!f.deleted });
      }
      c.index.set(key, idx);
      syncShip(key);
      refreshLibraries(key);
      return;
    }
    case 'core-nav': {
      const key = shipKey(clean(msg.ship));
      if (c.coreShips.has(key)) coreNav(c, key, msg.nav);
      return;
    }
    case 'core-get-end': return endTransfer(msg.tid);
    case 'core-get-error': return endTransfer(msg.tid, msg.reason || 'transfer failed');
    case 'core-put-ok': {
      // The computer stored an upload; its new index follows separately.
      for (const [tid, t] of transfers) if (t.kind === 'up' && t.core === c && t.coreTid === msg.tid) { t.result = { name: t.name, size: t.size }; endTransfer(tid); }
      return;
    }
    case 'core-put-error': {
      for (const [tid, t] of transfers) if (t.kind === 'up' && t.core === c && t.coreTid === msg.tid) endTransfer(tid, msg.reason || 'the ship\'s computer could not store the file');
      return;
    }
  }
}

function coreSignIn(ws, msg) {
  if (OPERATOR_KEY && msg.key !== OPERATOR_KEY) return send(ws, { type: 'shipcore-failed', reason: 'wrong operator key' });
  const names = (Array.isArray(msg.ships) ? msg.ships : []).map(clean).filter((n) => NAME_RE.test(n)).slice(0, 20);
  if (!names.length) return send(ws, { type: 'shipcore-failed', reason: 'name at least one ship' });
  ws.shipcore = true;
  ws.coreId = newTid();
  ws.coreShips = new Set(names.map(registerShip));
  ws.index = new Map();
  for (const k of ws.coreShips) { if (!cores.has(k)) cores.set(k, new Set()); cores.get(k).add(ws); }
  send(ws, { type: 'shipcore-ok', relay: RELAY_NAME, ships: [...ws.coreShips].map(shipName) });
  console.log(`ship's computer online for ${[...ws.coreShips].map(shipName).join(', ')}`);
  broadcastShips();
  for (const k of ws.coreShips) { opLog(k, 'ship\'s computer online'); refreshLibraries(k); }
}

function coreSignOff(ws) {
  for (const [tid, t] of transfers) {
    if (t.core === ws) endTransfer(tid, 'the ship\'s computer went offline');
    else if (t.kind === 'copy' && t.dest === ws) { transfers.delete(tid); copying.delete(t.job); }
  }
  for (const k of ws.coreShips) {
    cores.get(k)?.delete(ws);
    if (!cores.get(k)?.size) cores.delete(k);
    opLog(k, cores.has(k) ? 'a ship\'s computer went offline' : 'ship\'s computer offline: the library is unavailable');
    refreshLibraries(k);
    syncShip(k);
    reassignPrimary(k, ws);
    dropLinksIfUnmaintained(k);
  }
  broadcastAllOps();
  console.log(`ship's computer offline for ${[...ws.coreShips].map(shipName).join(', ')}`);
  broadcastShips();
}

// --- navigation: where ships are, and what's in range ------------------------------
//
// Each ship's position is simulated by one of its ship's computers (the
// primary, picked here); the others keep a copy and take over if it goes.
// Helm sets course and speed; Science scans and plots courses. Distance
// matters: hails, data links and transfers off ship need subspace (comms)
// range, sensors only see so far, and beaming needs transporter range.

// Ranges at full sensor power; sensor power scales all three (Engineering).
const COMMS_RANGE = 400, SENSOR_RANGE = 600, TRANSPORTER_RANGE = 20;
const SYSTEMS = ['engines', 'injectors', 'deflector', 'bussard', 'amBus', 'shields', 'sensors', 'lateral', 'transporter', 'weapons', 'sif', 'idf', 'atmosphere', 'thermal', 'gravity', 'lights', 'lighting', 'replicators', 'recreation', 'drydock1', 'drydock2', 'drydock3', 'industrial', 'phaser1', 'phaser2', 'phaser3', 'phaser4', 'spore', 'sporeGrow'];
// Starbases only (EPS loads under Engineering): three drydock connections (one
// per berth: the shipyard's drydocked ships need theirs powered for work to go
// on) and the industrial replicators. Ships never draw them; starbases have no
// warp drive (engines, plasma injectors, Bussard collectors, plasma conduits).
const BASE_ONLY = ['drydock1', 'drydock2', 'drydock3', 'industrial', 'phaser3', 'phaser4'];
// Phaser arrays (EPS, under Tactical, each with its own light bar): a ship has one, a starbase four.
const PHASER_ARRAYS = ['phaser1', 'phaser2', 'phaser3', 'phaser4'];
const arraysOf = (k) => Math.min(4, designOf(k).arrays);
// Tactical's locks (shared by the phasers and the tractor beam): a ship up to 6, a starbase 24.
const lockMax = (k) => 6 * arraysOf(k);
const WARP_DRIVE = ['engines', 'injectors', 'bussard'];
// Sensors: the long-range sensors (EPS) set sensor and radio range; the
// lateral arrays (a low bus) see close in and give the transporter its range.
// The navigational deflector (EPS) needs the long-range sensors; warp needs it.
// The structural integrity field and inertial dampers (EPS) hold the ship
// together: the dampers need the SIF at 50%, the warp core needs the SIF at 50%
// to start, impulse needs SIF 60% and dampers 80%, and warp both at 90%.
const HULL = { idfNeedsSif: 50, coreSif: 50, impulse: { sif: 60, idf: 80 }, warp: { sif: 90, idf: 90 }, deflector: 90 };
// Life support is three systems: atmospheric processors, thermal regulation
// and gravity generators. Small ones: solar (25) runs the first two, with a
// little over to charge batteries, but not gravity as well.
const LIFE_SUPPORT = ['atmosphere', 'thermal', 'gravity', 'lights', 'lighting'];
// Life support location by location (Engineering's Life support panel): every
// station is a place aboard, and each has its atmosphere, heat, gravity and
// lights switched on or off. A system draws for the places it's on in (so
// switching areas off saves power), and serves them only while it has its
// power. Emergency lighting lights any place whose lights are on but unpowered.
// Places with life support: every station, and the designs' places without one
// (a nacelle, the computer core...); a vessel has its own (locationsOf), in deck order.
const LOCATIONS = [...STATIONS, OPS_STATION, ...new Set(ALL_DESIGNS.flatMap((c) => (c.places || []).filter((p) => !p.stations.length).map((p) => p.name)))];
const locationsOf = (k) => {
  const places = [...placesOf(k)].sort((a, b) => a.deck - b.deck), has = (st) => hasStation(k, st) || st === OPS_STATION;
  const listed = places.flatMap((p) => (p.stations.length ? p.stations.filter(has) : [p.name]));
  // (Only places life support knows: a design naming a station this relay doesn't have is skipped.)
  return [...new Set([...listed, ...[...STATIONS, OPS_STATION].filter((st) => has(st) && !listed.includes(st))])].filter((l) => LOCATIONS.includes(l));
};
const LS_SYSTEMS = ['atmosphere', 'thermal', 'gravity', 'lights'];
const lsShare = (k, sys) => { const ls = engOf(k).ls, here = locationsOf(k); return here.filter((l) => ls[l]?.[sys] !== false).length / here.length; };
// What a system draws at 100% (most: 100).
// The Bussard collectors (EPS, under Helm) gather interstellar deuterium at
// warp: up to 5 a second at warp 9, less slower or with less power.
const BUSSARD = { perSecond: 5 };
const RATING = { sporeGrow: 20, spore: 200, phaser1: 100, phaser2: 100, phaser3: 100, phaser4: 100, drydock1: 50, drydock2: 50, drydock3: 50, industrial: 100, amBus: 10, bussard: 20, engines: 300, atmosphere: 10, thermal: 8, gravity: 20, lights: 6, lighting: 1, sensors: 22, lateral: 10, deflector: 80, sif: 35, idf: 22 };
const ratingOf = (s) => RATING[s] ?? 100;
// Each system's power setting is a limit, 0-150: past 100 (its rating) is
// emergency overdrive, which slowly damages it, faster the further over it runs.
const POWER_MAX = 150;
const OVERDRIVE_DAMAGE = 0.02; // damage per second for each point drawn over 100
const REACTOR = 360; // power drawn for a full sensor signature (a warm ship idling draws a little less)
const MIN_SHIELD_POWER = 20;
const DEFAULT_POWER = { sporeGrow: 100, spore: 100, phaser1: 100, phaser2: 100, phaser3: 100, phaser4: 100, drydock1: 100, drydock2: 100, drydock3: 100, industrial: 50, engines: 80, injectors: 80, shields: 60, sensors: 100, transporter: 100, weapons: 50, atmosphere: 100, thermal: 100, gravity: 100, lights: 100, lighting: 100, lateral: 100, deflector: 100, bussard: 100, amBus: 100, sif: 100, idf: 100, replicators: 40, recreation: 10 };
// Power as Engineering set it (each system's demand), and what each system
// actually gets from the power grid (see "the power grid" below): damage caps
// a system, unarmed weapons draw nothing, and a bus short of power browns out.
// (Older saves had one life support setting: it goes to all three.)
const allocOf = (k) => { const p = navState.get(k)?.power || {}; return { ...DEFAULT_POWER, ...(p.lifeSupport != null ? Object.fromEntries(LIFE_SUPPORT.map((x) => [x, p.lifeSupport])) : {}), ...p }; };
function powerOf(k) {
  const f = flow(k);
  const p = Object.fromEntries(SYSTEMS.map((s) => [s, Math.floor(f.delivered[s] + 1e-9)]));
  // What keeps the crew alive (gravity is a comfort): how fully atmosphere and heat are served where they're on.
  const served = (x) => { const u = 100 * lsShare(k, x); return u > 0 ? Math.min(100, Math.floor((f.delivered[x] / u) * 100 + 1e-9)) : 100; };
  p.lifeSupport = Math.min(served('atmosphere'), served('thermal'));
  if (p.sif < HULL.idfNeedsSif) p.idf = 0; // the dampers work inside the SIF
  if (p.sensors <= 0) p.deflector = 0; // the deflector aims by the long-range sensors
  return p;
}
// How visible a ship is to other ships' sensors: the more power it uses (all
// of it: systems, consoles, the warp core's containment), the further off it
// shows up. 360 units drawn or more: seen at full sensor range; power down to run quiet.
const signatureOf = (k) => (isBase(k) ? 1 : Math.max(0.1, Math.min(1, flow(k).drawn / REACTOR)));
// The lateral arrays alone see a quarter as far as the long-range sensors.
function rangesOf(k) {
  const p = powerOf(k), pct = (x) => Math.max(0, Math.min(POWER_MAX, x)) / 100;
  const f = Math.max(pct(p.sensors), pct(p.lateral) / 4);
  return { comms: COMMS_RANGE * f, sensors: SENSOR_RANGE * f, transporter: TRANSPORTER_RANGE * pct(p.lateral) };
}
// Top speeds: warp (1-9) needs the warp core online and engine power; impulse
// (below 1) comes from the running impulse drives, half impulse (0.125) each. maxWarp: the top of whichever the ship has.
function speedLimits(k) {
  const e = eng.get(k);
  // Warp needs both the engines and their plasma injectors: the weaker sets the
  // top speed, by what they may draw; at warp, by what they actually get (a bus short browns them out).
  const cap = capacityOf(k), now = navState.get(k)?.warp || 0, got = powerOf(k);
  const short = now >= 1 && ['engines', 'injectors'].some((x) => got[x] < flow(k).demand[x] - 1);
  const warpPower = Math.min(100, cap.engines, cap.injectors, ...(short ? [got.engines, got.injectors].map((x) => Math.max(x, 0)) : []));
  // The top warp also follows the core's output (650 or more: all of it).
  const eCore = eng.get(k);
  const coreF = !eCore || isBase(k) ? 1 : Math.min(1, coreOutput(eCore) / GRID.core);
  const eng9 = warpPower <= 0 ? 0 : Math.round((Math.min(warpPower / 100, coreF) * 9) * 10) / 10;
  if (!e) return { warp: eng9 >= 1 ? eng9 : 0, impulse: 0.25 };
  const p = powerOf(k);
  // Why not (for Helm): the hull fields and the deflector gate warp and impulse.
  const why = {
    warp: e.core !== 'online' ? 'the warp core is offline' : !e.wc.plasma ? 'the plasma transfer conduits to the nacelles are closed (Engineering)' : eng9 < 1 ? (coreF * 9 < 1 ? `the warp core's output is too low (${Math.round(coreOutput(e))}): raise its reaction rate` : 'no power to the engines')
      : p.sif < HULL.warp.sif || p.idf < HULL.warp.idf ? `warp needs the structural integrity field and inertial dampers at ${HULL.warp.sif}% (SIF ${p.sif}%, dampers ${p.idf}%)`
      : p.sensors <= 0 ? 'the navigational deflector needs the long-range sensors' : cap.deflector < HULL.deflector ? `warp needs the navigational deflector at ${HULL.deflector}% (its limit is ${Math.floor(cap.deflector)}%)` : '',
    impulse: !DRIVES.some((d) => e.drives[d].state === 'running') ? 'start an impulse drive (Engineering)' : !flow(k).thrusting ? 'the impulse drives\' accelerators are at 0 (Engineering)'
      : p.sif < HULL.impulse.sif || p.idf < HULL.impulse.idf ? `impulse needs the SIF at ${HULL.impulse.sif}% and dampers at ${HULL.impulse.idf}% (SIF ${p.sif}%, dampers ${p.idf}%)` : '',
  };
  if (isBase(k)) why.warp = 'a starbase has no warp drive';
  else if (!classOf(k).maxWarp) why.warp = `a ${classOf(k).name.toLowerCase()} has no warp drive`;
  let warp = why.warp ? 0 : Math.min(eng9, classOf(k).maxWarp || 9);
  if (e.towing) warp = Math.min(warp, TRACTOR.maxWarp); // towing holds a ship back
  return { warp, impulse: why.impulse ? 0 : flow(k).thrusting, why };
}
const maxWarp = (k) => { const l = speedLimits(k); return l.warp || l.impulse; };
// How fast impulse builds, per second: the quickest gear among the running drives.
const impulseRate = (k) => Math.max(0, ...DRIVES.filter((d) => engOf(k).drives[d].state === 'running').map((d) => FUSION.gears[engOf(k).drives[d].gear].rate));
// Is this speed within what the ship has? (impulse and warp are separate)
const speedOk = (k, w) => { const l = speedLimits(k); return w <= 0 || (w < 1 ? w <= l.impulse + 1e-9 : w <= l.warp); };
// Both ships' sensors have to reach for radio (hails, calls between ships).
const commsOk = (a, b) => a === b || distance(a, b) <= Math.min(rangesOf(a).comms, rangesOf(b).comms);
// Subspace (data links) reaches the whole star system while both ends' subspace
// relays work (checked with commsUp). The map is one star system for now:
// vessels carry a system id so more can come later.
const HOME_SYSTEM = 'home';
const systemOf = (k) => navState.get(k)?.system || HOME_SYSTEM;
const subspaceOk = (a, b) => a === b || (present(a) && present(b) && navState.has(a) && navState.has(b) && systemOf(a) === systemOf(b));
// Can these two hold a data link right now: a hard line, or subspace with both relays up?
const linkReach = (a, b) => (isRelay(a) || isRelay(b) ? relayReach(a, b) : false) || hardLine(a, b) || (subspaceOk(a, b) && commsUp(a, 'subspace') && commsUp(b, 'subspace'));
const sensorOk = (a, b) => a === b || distance(a, b) <= rangesOf(a).sensors * signatureOf(b);
const transporterOk = (a, b) => a === b || distance(a, b) <= rangesOf(a).transporter;
const navState = new Map();   // ship key -> { x, y, heading, warp, dest }
const primaryCore = new Map(); // ship key -> computer socket flying it
const navTargets = new Map();  // ship key -> ship key it's heading for (intercept)
// Known contacts: where each ship last saw every other ship on its sensors.
const known = new Map();       // ship key -> Map(other ship key -> { x, y, at })
// Autopilot: Helm picks a known contact or a starbase and the ship's computer
// flies there (no one needs to stay at Helm): it intercepts a ship it can see,
// heads for its last known position if not, and docks at a starbase on arrival.
const autopilots = new Map();  // ship key -> { target (name), key, base, mode: go | follow | match, range, warp }
const FOLLOW_RANGES = [10, 25, 50, 100, 200];

function distance(a, b) {
  const p = navState.get(a), q = navState.get(b);
  if (!p || !q || !present(a) || !present(b)) return Infinity;
  return Math.hypot(p.x - q.x, p.y - q.y);
}
const rangeText = (a, b) => (Number.isFinite(distance(a, b)) ? `${Math.round(distance(a, b))} units away` : 'position unknown');

function navMessage(key) {
  const own = navState.get(key);
  // Ships only: a starbase (even one a ship's computer holds the library for) is in `bases`.
  const seen = [...navState.keys()].filter((k) => cores.has(k) && !isBase(k) && sensorOk(key, k));
  return {
    type: 'nav',
    own: own ? { name: shipName(key), ...own, class: isBase(key) ? null : classOf(key).name, power: powerOf(key), capacity: Object.fromEntries(Object.entries(capacityOf(key)).map(([x, v]) => [x, Math.floor(v)])), allocated: allocOf(key), reactor: REACTOR, signature: signatureOf(key), combat: combatView(key), grid: gridView(key),
      autopilot: autopilots.get(key)?.target || null, transporter: transporterView(key), readiness: readinessView(key),
      automation: Object.fromEntries(AUTO_PANELS.filter((p) => engOf(key).auto?.[p]).map((p) => [p, { mode: engOf(key).auto[p], station: AUTO_STATION[p], name: AUTO_NAMES[p], status: engOf(key).autoStatus?.[p] || '' }])), orders: engOf(key).orderLog,
      autopilotMode: autopilots.get(key) ? { mode: autopilots.get(key).mode, range: autopilots.get(key).range || null } : null, followRanges: FOLLOW_RANGES,
      known: [...(known.get(key) || [])].filter(([o]) => present(o)).map(([o, p]) => ({ name: shipName(o), x: Math.round(p.x), y: Math.round(p.y), age: Math.round((Date.now() - p.at) / 1000), visible: sensorOk(key, o) })) } : null,
    bases: STARBASES.map((b) => ({ ...b, distance: own ? Math.round(Math.hypot(own.x - b.x, own.y - b.y)) : null })),
    relays: RELAYS.filter((r) => r.system === SYSTEM_ID).map((r) => ({ name: r.name, x: r.x, y: r.y, off: relayOff.has(shipKey(r.name)) })),
    ships: seen.map((k) => ({ name: shipName(k), ...navState.get(k), class: classOf(k).name, ops: opsOf(k).length > 0, shields: shields.has(k), distance: k === key ? 0 : distance(key, k) })),
    ranges: rangesOf(key),
    maxWarp: maxWarp(key),
    speed: speedLimits(key),
  };
}

// Send positions to everyone (at most twice a second), keep intercept courses
// pointed at moving ships, and drop data links that fall out of range.
let navTimer = null;
let lastRangeSig = '';
function scheduleNav() {
  if (navTimer) return;
  navTimer = setTimeout(() => {
    navTimer = null;
    tow();
    relinkCalls();
    // Contacts seen now become known contacts; autopilots follow them, and dock on arrival.
    const now = Date.now();
    for (const k of cores.keys()) {
      if (isBase(k) || !navState.has(k)) continue;
      if (!known.has(k)) known.set(k, new Map());
      for (const o of cores.keys()) if (o !== k && !isBase(o) && navState.has(o) && sensorOk(k, o)) known.get(k).set(o, { x: navState.get(o).x, y: navState.get(o).y, at: now });
    }
    for (const [k, ap] of autopilots) {
      const nav = navState.get(k), core = primaryCore.get(k);
      if (!nav || !core) continue;
      // Follow (at a range) and match (heading and speed) need the contact on sensors.
      if (ap.mode === 'follow' || ap.mode === 'match') {
        const t = navState.get(ap.key);
        if (!t || !present(ap.key) || !sensorOk(k, ap.key)) {
          opLog(k, `autopilot: lost the ${ap.target} from sensors, ${ap.mode} ended`);
          for (const u of crewOf(k)) if (u.station === 'Helm') send(u, { type: 'notice', text: `Helm: the ${ap.target} left sensor range, ${ap.mode === 'follow' ? 'follow' : 'match'} ended` });
          autopilots.delete(k);
          continue;
        }
        if (ap.mode === 'match') {
          const warp = Math.min(t.warp, speedLimits(k).warp || speedLimits(k).impulse);
          if (Math.abs(nav.heading - t.heading) > 1 || Math.abs(nav.warp - warp) > 0.01 || nav.dest) send(core, { type: 'core-helm', ship: shipName(k), heading: t.heading, warp });
        } else {
          // A point at the chosen range from the contact, on our side of it.
          const dx = nav.x - t.x, dy = nav.y - t.y, d = Math.hypot(dx, dy) || 1;
          const px = t.x + (dx / d) * ap.range, py = t.y + (dy / d) * ap.range;
          const off = Math.hypot(nav.x - px, nav.y - py);
          if (off > Math.max(2, ap.range * 0.1)) {
            if (!nav.dest || Math.hypot(nav.dest.x - px, nav.dest.y - py) > 2 || nav.warp === 0) send(core, { type: 'core-helm', ship: shipName(k), dest: { x: px, y: py }, warp: ap.warp });
          } else if (nav.warp > 0 && t.warp === 0) send(core, { type: 'core-helm', ship: shipName(k), warp: 0 });
        }
        continue;
      }
      if (!ap.base && !navTargets.has(k) && navState.has(ap.key) && sensorOk(k, ap.key) && nav.warp > 0) {
        navTargets.set(k, ap.key); // back on sensors: intercept again
        opLog(k, `autopilot: the ${ap.target} is back on sensors, intercepting`);
      }
      if (nav.warp === 0 && !nav.dest && now - ap.since > 2000) { // (the computer has had time to set off)
        const base = ap.base && STARBASES.find((b) => b.name === ap.target);
        if (base && Math.hypot(nav.x - base.x, nav.y - base.y) <= DOCK_RANGE && !engOf(k).docked) {
          engOf(k).docked = base.name; engOf(k).dockedPort = freePort(k) || 'port'; engOf(k).dirty = true; untieDock(engOf(k)); flowCache.delete(k);
          opLog(k, `autopilot: docked at ${base.name}`);
          for (const u of crewOf(k)) send(u, { type: 'notice', text: `Helm: autopilot docked us at ${base.name}` });
        } else if (!base) for (const u of crewOf(k)) if (u.station === 'Helm') send(u, { type: 'notice', text: `Helm: autopilot arrived at the ${ap.target}${navState.has(ap.key) && sensorOk(k, ap.key) ? '' : "'s last known position"}` });
        autopilots.delete(k);
      }
    }
    for (const [k, t] of navTargets) {
      const nav = navState.get(k), tgt = navState.get(t), core = primaryCore.get(k);
      if (!nav?.dest || !tgt || !core || !sensorOk(k, t)) { navTargets.delete(k); continue; } // lost: carry on to where it was
      if (Math.hypot(nav.dest.x - tgt.x, nav.dest.y - tgt.y) > 2) send(core, { type: 'core-helm', ship: shipName(k), dest: { x: tgt.x, y: tgt.y, name: shipName(t) } });
    }
    linkTick();
    // Ops consoles list the ships in hailing range: refresh them when that changes.
    const keys = [...new Set([...cores.keys(), ...BASE_KEYS])].sort();
    const sig = keys.flatMap((a, i) => keys.slice(i + 1).filter((b) => commsOk(a, b)).map((b) => `${a}|${b}`)).join(',') + keys.map((a) => (commsUp(a, 'subspace') ? 1 : 0)).join('');
    if (sig !== lastRangeSig) { lastRangeSig = sig; broadcastAllOps(); }
    checkRemotes();
    const byShip = new Map();
    for (const u of users.values()) {
      const k = u.controlling || u.shipKey;
      if (!byShip.has(k)) byShip.set(k, navMessage(k));
      send(u, { ...byShip.get(k), remote: { vessels: remoteVessels(u).map(shipName), controlling: u.controlling ? shipName(u.controlling) : null, home: u.ship } });
    }
  }, 500);
}

// A computer reports a ship's position (or its saved one, when it signs on).
function coreNav(c, key, nav) {
  if (!nav || typeof nav.x !== 'number' || typeof nav.y !== 'number') return;
  if (isBase(key)) return; // a computer for a starbase only holds its library: the station runs itself
  const clean = { x: nav.x, y: nav.y, heading: Number(nav.heading) || 0, warp: Number(nav.warp) || 0, dest: nav.dest || null };
  const was = shipClasses.get(key);
  // (No class in its save: a Galaxy for now, marked unknown, and never saved as if it were known.)
  if (CLASSES[nav.class]) { shipClasses.set(key, nav.class); classGuessed.delete(key); } else if (!shipClasses.has(key)) { shipClasses.set(key, DEFAULT_CLASS); classGuessed.add(key); }
  if (was !== shipClasses.get(key)) broadcastShips(); // (the sign-in list shows each ship's class and stations)
  if (ALERTS.includes(nav.alert)) clean.alert = nav.alert;
  if (nav.lockout) clean.lockout = true;
  if (nav.power && typeof nav.power === 'object') clean.power = Object.fromEntries(SYSTEMS.map((s) => [s, Math.max(0, Math.min(POWER_MAX, Number(nav.power[s] ?? DEFAULT_POWER[s]) || 0))]));
  // Hull, shields and damage: the relay runs combat, so it only takes the
  // computer's saved copy when it has none of its own.
  // A new ship (nothing saved) starts cold, docked at a starbase, unless its
  // computer says --warm or --position.
  let spawnAt = null;
  if (!combat.get(key)?.loaded) {
    combat.set(key, { ...freshCombat(nav.combat, torpedoesOf(key)), loaded: true });
    eng.set(key, freshEng(nav.eng, { cold: !nav.eng && !nav.warm, k: key }));
    for (const c of CONDUITS) engOf(key).ties[c] ||= [];
    if (!engOf(key).conduits) deriveConduits(key); // (a cold ship's are untied: its loads are)
    reconcileConduits(key);
    pruneLoads(key);
    restoreLinks(key, nav.eng?.links);
    if (!classOf(key).warpCore) Object.assign(engOf(key), { core: 'ejected', antimatter: 0 }); // (a shuttle has no warp core: impulse and batteries)
    // A small craft brought up ready to go: wiring that fits its buses, and EPS taps no wider than they are.
    if (!nav.eng && nav.warm) {
      const e = engOf(key), b = busMaxOf(key);
      Object.assign(e.ties, classOf(key).ties || {});
      for (const X of BUSES) e.taps[X] = Math.min(e.taps[X], b[X]);
      deriveConduits(key); // (its conduits where its design's ties are)
    }
    if (!nav.eng && nav.spawn) { spawnAt = STARBASES.find((b) => b.name === pendingSpawn.get(key)) || SPAWN_BASES[Math.floor(Math.random() * SPAWN_BASES.length)]; pendingSpawn.delete(key); engOf(key).docked = spawnAt.name; }
    flowCache.delete(key);
  }
  const current = primaryCore.get(key);
  if (!current) {
    primaryCore.set(key, c);
    if (!navState.has(key)) navState.set(key, clean); // a fresher copy here wins
    send(c, { type: 'core-primary', ship: shipName(key), primary: true, nav: coreCopy(key) });
  } else if (current === c) {
    navState.set(key, clean);
    // Shields can't stay up without enough power.
    if (shields.has(key) && powerOf(key).shields < MIN_SHIELD_POWER) {
      shields.delete(key);
      opLog(key, 'shields down: not enough power');
      broadcastShips();
    }
    for (const o of coresOf(key)) if (o !== c) send(o, { type: 'core-nav-sync', ship: shipName(key), nav: coreCopy(key) });
  } else {
    send(c, { type: 'core-primary', ship: shipName(key), primary: false, nav: coreCopy(key) });
  }
  if (spawnAt && navState.has(key)) {
    Object.assign(navState.get(key), { x: spawnAt.x, y: spawnAt.y + 5, warp: 0, dest: null });
    send(primaryCore.get(key), { type: 'core-set', ship: shipName(key), set: { respawn: { x: spawnAt.x, y: spawnAt.y + 5 }, eng: savedEng(key) } });
    opLog(key, `new ship, cold and docked at ${spawnAt.name}`);
  }
  scheduleNav();
}

// A primary computer went away: another one for the ship takes over.
function reassignPrimary(key, gone) {
  if (primaryCore.get(key) !== gone) return;
  primaryCore.delete(key);
  const next = coresOf(key)[0];
  if (next) {
    primaryCore.set(key, next);
    send(next, { type: 'core-primary', ship: shipName(key), primary: true, nav: coreCopy(key) });
  }
  scheduleNav();
}

// Messages from crew about navigation: Helm flies, Science scans and plots.
// "the Enterprise", but "Starbase 47".
const d0 = (name) => (STARBASES.some((b) => b.name === name) ? name : `the ${name}`);

function navCommand(ws, msg) {
  const note = (text) => send(ws, { type: 'notice', text });
  const key = ws.shipKey;
  // Resolve a destination: another ship (in sensor range) or a point.
  const resolve = (dest) => {
    if (!dest) return null;
    if (typeof dest.base === 'string') {
      const b = STARBASES.find((sb) => sb.name.toLowerCase() === dest.base.toLowerCase());
      return b ? { x: b.x, y: b.y, name: b.name } : { error: 'no such starbase' };
    }
    if (typeof dest.ship === 'string') {
      const t = shipKey(clean(dest.ship));
      if (t === key || !navState.has(t) || !sensorOk(key, t)) return { error: `the ${clean(dest.ship)} is not on sensors` };
      return { x: navState.get(t).x, y: navState.get(t).y, name: shipName(t), key: t };
    }
    if (Number.isFinite(dest.x) && Number.isFinite(dest.y)) return { x: Math.min(1000, Math.max(0, dest.x)), y: Math.min(1000, Math.max(0, dest.y)) };
    return { error: 'no such destination' };
  };

  if ((msg.type === 'autopilot' || msg.type === 'helm') && engOf(key).drydock && ws.station === 'Helm') return note(`Helm: in drydock at ${engOf(key).docked}: request release first`);
  if ((msg.type === 'autopilot' || msg.type === 'helm') && engOf(key).landed && ws.station === 'Helm') return note(`Helm: landed in the ${shipName(engOf(key).landed)}'s shuttle bay: take off first`);
  if (msg.type === 'spore-jump') {
    if (ws.station !== 'Helm') return note('Only Helm jumps the spore drive');
    const e = engOf(key);
    if (msg.cancel) { if (e.spore?.charging) { e.spore.charging = false; e.spore.t = 0; gridChanged(key); } return note('Helm: spore jump stood down'); }
    const why = sporeFault(key);
    if (why) return note(`Helm: no spore jump: ${why}`);
    const d = msg.dest && resolve(msg.dest);
    if (!d || d.error) return note(`Helm: ${d?.error || 'pick where to jump to (a waypoint, a ship or a starbase)'}`);
    e.spore = { ...e.spore, charging: true, t: 0, dest: { x: d.x, y: d.y, ...(d.name ? { name: d.name } : {}) } };
    opLog(key, `Helm (${ws.name}): spore drive charging for a jump to ${d.name ? d0(d.name) : `${Math.round(d.x)}, ${Math.round(d.y)}`}`);
    tellStations(key, ['Helm', 'Captain', 'Engineering'], `Helm: spore drive charging (${SPORE.chargeSecs} s)`);
    gridChanged(key);
    return;
  }
  if (msg.type === 'autopilot') {
    if (ws.station !== 'Helm') return note('Only Helm sets the autopilot');
    if (!msg.target) { autopilots.delete(key); return note('Helm: autopilot off (the ship keeps its course and speed)'); }
    const name = clean(msg.target);
    const base = STARBASES.find((b) => b.name.toLowerCase() === name.toLowerCase());
    const t = shipKey(name);
    let dest;
    if (base) dest = { base: base.name };
    else if (navState.has(t) && present(t) && sensorOk(key, t)) dest = { ship: shipName(t) };
    else {
      const k2 = known.get(key)?.get(t);
      if (!k2) return note(`Helm: no known position for the ${name}`);
      dest = { x: k2.x, y: k2.y };
    }
    const mode = ['follow', 'match'].includes(msg.mode) ? msg.mode : 'go';
    if (mode !== 'go') {
      // Follow at a range, or match heading and speed: a ship on sensors.
      if (base) return note('Helm: starbases don\'t move: use go to');
      if (!navState.has(t) || !present(t) || !sensorOk(key, t)) return note(`Helm: the ${name} is not on sensors`);
      const range = FOLLOW_RANGES.includes(Number(msg.range)) ? Number(msg.range) : 25;
      autopilots.set(key, { target: shipName(t), key: t, base: false, mode, range, warp: Number(msg.warp) || 5, since: Date.now() });
      navTargets.delete(key);
      opLog(key, `Helm (${ws.name}): autopilot ${mode === 'follow' ? `following the ${shipName(t)} at ${range}` : `matching the ${shipName(t)}'s heading and speed`}`);
      return note(`Helm: autopilot ${mode === 'follow' ? `following the ${shipName(t)} at ${range} units` : `matching the ${shipName(t)}`}`);
    }
    autopilots.set(key, { target: base ? base.name : shipName(t), key: base ? null : t, base: !!base, mode, since: Date.now() });
    opLog(key, `Helm (${ws.name}): autopilot to ${base ? base.name : `the ${shipName(t)}`}`);
    return navCommand(ws, { type: 'helm', dest, warp: Number(msg.warp) || 5, autopilot: true });
  }

  if (msg.type === 'helm') {
    if (ws.station !== 'Helm') return note('Only Helm can set course and speed');
    if (!msg.autopilot && autopilots.delete(key)) note('Helm: autopilot off, you have the helm');
    // (A starbase has no ship's computer flying it: the relay does, at impulse.)
    const core = isBase(key) ? { base: true } : primaryCore.get(key);
    if (!core) return note("No ship's computer is flying the ship");
    if (isBase(key) && typeof msg.warp === 'number' && msg.warp >= 1) return note(`Helm: ${shipName(key)} is a starbase: no warp drive, impulse only`);
    if (towedBy(key)) return note(`Helm: held in the ${shipName(towedBy(key))}'s tractor beam`);
    const order = { type: 'core-helm', ship: ws.ship };
    if (msg.dest) {
      const d = resolve(msg.dest);
      if (d.error) return note(`Helm: ${d.error}`);
      order.dest = { x: d.x, y: d.y, ...(d.name ? { name: d.name } : {}) };
      if (d.key) navTargets.set(key, d.key); else navTargets.delete(key);
    } else if (typeof msg.heading === 'number') {
      order.heading = msg.heading;
      navTargets.delete(key);
    }
    if (typeof msg.warp === 'number') {
      order.warp = Math.max(0, Math.min(9, msg.warp));
      const lim = speedLimits(key);
      if (order.warp > 0 && order.warp < 1) {
        if (!lim.impulse) return note(`Helm: no impulse: ${lim.why?.impulse || 'start an impulse drive (Engineering)'}`);
        // Impulse: what there is, built up at the driver coils' rate (Low gear quicker than High).
        const eg = engOf(key), now = navState.get(key)?.warp || 0;
        eg.impulseWant = Math.min(order.warp, lim.impulse);
        order.warp = Math.min(eg.impulseWant, (now < 1 ? now : 0) + impulseRate(key));
      } else if (order.warp >= 1 && order.warp > lim.warp) {
        return note(lim.warp ? `Helm: engines only give warp ${lim.warp} at this power` : lim.why?.warp === 'the warp core is offline' ? 'Helm: no warp: the warp core is offline' : lim.why?.warp === 'no power to the engines' ? 'Helm: no power to the engines' : `Helm: no warp: ${lim.why?.warp}`);
      }
    }
    if (order.warp === 0) navTargets.delete(key);
    if (!(order.warp > 0 && order.warp < 1)) engOf(key).impulseWant = 0;
    if (core.base) baseHelm(key, order); else send(core, order);
    const what = order.warp === 0 ? 'all stop' : `${order.dest ? `course for ${order.dest.name ? `${d0(order.dest.name)}` : `${Math.round(order.dest.x)}, ${Math.round(order.dest.y)}`}` : typeof order.heading === 'number' ? `heading ${Math.round(order.heading)}` : 'speed'}${order.warp ? `, ${order.warp < 1 ? 'impulse' : `warp ${order.warp}`}` : ''}`;
    opLog(key, `Helm (${ws.name}): ${what}`);
    return;
  }

  if (msg.type === 'power') {
    if (ws.station !== 'Engineering') return note('Only Engineering can route power');
    const core = primaryCore.get(key);
    if (!core && !isBase(key)) return note("Engineering: no ship's computer is running the ship");
    const p = allocOf(key);
    for (const s of SYSTEMS) if (msg.power && Number.isFinite(msg.power[s])) p[s] = Math.max(0, Math.min(POWER_MAX, Math.round(msg.power[s])));
    // (A starbase keeps its own limiters, in the relay's starbase file.)
    if (isBase(key)) { navState.get(key).power = p; gridChanged(key); saveBaseSettings(); } else send(core, { type: 'core-power', ship: ws.ship, power: p });
    opLog(key, `Engineering (${ws.name}): power ${SYSTEMS.map((s) => `${s} ${p[s]}%`).join(', ')}`);
    return;
  }

  if (msg.type === 'scan') {
    if (ws.station !== 'Science') return note('Only Science can run sensor scans');
    const t = shipKey(clean(msg.ship));
    if (!navState.has(t) || !sensorOk(key, t)) return note(`Sensors: the ${clean(msg.ship)} is out of sensor range`);
    return send(ws, { type: 'scan-result', ship: shipName(t), at: Date.now(), data: scanData(key, t) });
  }

  // Science's target lock: the scan, tracked (again each second) until it's released or lost.
  if (msg.type === 'sci-lock') {
    if (ws.station !== 'Science') return note('Only Science can lock sensors on a target');
    const t = msg.ship ? shipKey(clean(msg.ship)) : null;
    if (!t) {
      if (sciLocks.has(key)) { opLog(key, `Science (${ws.name}): sensor lock on the ${shipName(sciLocks.get(key))} released`); sciLocks.delete(key); }
      tellScience(key, { type: 'sci-lock', ship: null });
      return note('Sensor lock released');
    }
    if (t === key) return note('Sensors: that is this ship');
    if (!navState.has(t) || !sensorOk(key, t)) return note(`Sensors: the ${clean(msg.ship)} is out of sensor range`);
    sciLocks.set(key, t);
    opLog(key, `Science (${ws.name}): sensors locked on the ${shipName(t)}`);
    tellScience(key, { type: 'sci-lock', ship: shipName(t) });
    tellScience(key, { type: 'scan-result', ship: shipName(t), at: Date.now(), tracking: true, data: scanData(key, t) });
    return note(`Sensors locked on the ${shipName(t)}: tracking`);
  }

  if (msg.type === 'plot-course') {
    if (ws.station !== 'Science') return note('Only Science plots courses');
    const d = resolve(msg.dest);
    if (!d || d.error) return note(`Science: ${d?.error || 'no destination'}`);
    const dest = d.key ? { ship: d.name } : d.name ? { base: d.name } : { x: d.x, y: d.y };
    const helm = crewOf(key).filter((u) => u.station === 'Helm');
    for (const u of helm) send(u, { type: 'course-plotted', by: info(ws), dest, label: d.name ? d0(d.name) : `${Math.round(d.x)}, ${Math.round(d.y)}` });
    return note(helm.length ? `Course plotted for Helm: ${d.name ? d0(d.name) : `${Math.round(d.x)}, ${Math.round(d.y)}`}` : 'Course plotted, but nobody is at Helm');
  }
}

// A sensor scan of a vessel. Lifeforms: who is aboard, by name and species
// (each person's profile, "unknown" without one), with counts per species.
// Exact locations (ship and station) only resolve with its shields down, or
// our long-range sensors (delivered %, overdrive included) above its shields' strength.
// Also its health (hull, damage) and its power: what it draws, and on what.
const sensorPct = (k) => (isBase(k) ? 100 : Math.round(flow(k).delivered.sensors || 0));
function locatable(from, t) {
  const up = shields.has(t), sensors = sensorPct(from), shield = up ? Math.round(combatOf(t).shield) : 0;
  return { up, sensors, shield, resolved: !up || sensors > shield };
}
function scanData(key, t) {
  const crew = crewOf(t), n = navState.get(t);
  const stations = {};
  for (const u of crew) stations[u.station] = (stations[u.station] || 0) + 1;
  const loc = locatable(key, t);
  const lifeforms = crew.map((u) => ({ name: titled(u), species: u.species || 'unknown', ...(u.shield?.on ? { shielded: true } : {}), ...(loc.resolved ? { where: `${u.sickbay ? 'sickbay' : u.confined ? `${u.station} (confined)` : u.station}, the ${u.ship}` } : {}) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const species = {};
  for (const l of lifeforms) species[l.species] = (species[l.species] || 0) + 1;
  // Its power: what each system draws now (as the power distribution table counts it).
  const f = present(t) && !isBase(t) ? flow(t) : null;
  const power = f ? SYSTEMS.map((x) => [SYSTEM_NAMES[x], Math.round(((f.delivered[x] || 0) * ratingOf(x)) / 100)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]) : [];
  return {
    distance: t === key ? 0 : Math.round(distance(key, t)), x: n.x, y: n.y, heading: n.heading, warp: n.warp, class: isBase(t) ? 'Starbase' : classOf(t).name,
    shields: shields.has(t), ops: opsOf(t).length > 0, crew: crew.length, stations, lifeforms, species,
    sensors: loc.sensors, shieldLevel: loc.shield, resolved: loc.resolved, shieldFreq: loc.resolved && shields.has(t) ? combatOf(t).shieldFreq : null,
    inCommsRange: commsOk(key, t), inTransporterRange: transporterOk(key, t),
    hull: Math.round(combatOf(t).hull), shieldStrength: Math.round(combatOf(t).shield), signature: Math.round(signatureOf(t) * 100),
    damaged: DAMAGEABLE.filter((s) => combatOf(t).damage[s] >= 1).map((s) => damageName(s)), core: engOf(t).core, docked: engOf(t).docked,
    power, powerTotal: power.reduce((a, [, v]) => a + v, 0),
  };
}
// Science's sensor locks: ship key -> the target it tracks.
const sciLocks = new Map();
const tellScience = (k, data) => { for (const u of crewOf(k)) if (u.station === 'Science') send(u, data); };
// Each second: a locked target's scan again; a lock drops when the target leaves sensor range.
function scienceTick() {
  for (const [k, t] of [...sciLocks]) {
    if (!present(k) || !navState.has(t) || !present(t) || !sensorOk(k, t)) {
      sciLocks.delete(k);
      opLog(k, `Science: sensor lock on the ${shipName(t)} lost`);
      tellScience(k, { type: 'sci-lock', ship: null });
      tellScience(k, { type: 'notice', text: `Science: sensor lock on the ${shipName(t)} lost (out of sensor range)` });
      continue;
    }
    tellScience(k, { type: 'scan-result', ship: shipName(t), at: Date.now(), tracking: true, data: scanData(k, t) });
  }
}

// --- command, security, medical (phase 3) ----------------------------------------
//
// Captain: alert status (green / yellow / red; red raises shields if they have
// power) and orders shown on every console aboard. First Officer: reassign
// crew to stations. Security: alerts when anyone beams aboard, a transporter
// lockout (force field) refusing beam-ins, and confining crew to quarters
// (they can only call Security, Medical or ops). Medical: sickbay, which takes
// crew off duty. Alert status and lockout are kept by the ship's computer.

const ALERTS = ['green', 'yellow', 'red', 'black'];
// Black alert: only aboard a ship with a spore drive (a jump needs it); it powers
// the nonessential systems down (restored after), as red alert raises shields.
const BLACK_OFF = ['replicators', 'recreation'];
const CONFINED_MAY_CALL = new Set(['Security', 'Medical', 'Operations']);
const alertOf = (k) => navState.get(k)?.alert || 'green';
const lockoutOf = (k) => !!navState.get(k)?.lockout;

// Department readiness: the Captain or First Officer calls a department (or
// all of them) to report ready; the crew at those stations each tap Ready (the
// orders' way). A department is ready (green) once all its crew have checked
// in, pending (amber) until then, "no crew" when nobody's there. A new call
// resets that department's answers. The caller isn't asked; on the First
// Officer's call neither is the Captain (they're not departments anyway).
const DEPARTMENTS = ['Operations', 'Helm', 'Tactical', 'Security', 'Engineering', 'Medical', 'Science', 'Communications', 'Transporter'];
const readiness = new Map(); // ship key -> { dept -> { id, pending: Set, ready: Set, at } }
function readinessView(k) {
  const r = readiness.get(k) || {};
  const names = (ids) => [...ids].map((id) => (id === EMH_ID ? 'The Doctor' : users.get(id)?.name)).filter(Boolean);
  return Object.fromEntries(DEPARTMENTS.filter((d) => hasStation(k, d)).map((d) => {
    const c = r[d];
    if (!c) return [d, { state: 'idle' }];
    const pending = names(c.pending), ready = names(c.ready);
    return [d, { state: !pending.length && !ready.length ? 'nocrew' : pending.length ? 'pending' : 'ready', pending, ready, at: c.at }];
  }));
}
// The ship's order history: each order with when it was given and who has acknowledged it.
const ORDER_LOG = 20;
function logOrder(k, o, to) {
  const e = engOf(k);
  e.orderLog.unshift({ id: o.id, text: o.text, at: o.at, from: { name: o.from.name, title: o.from.title, station: o.from.station }, to: to.map((u) => ({ id: u.id, name: u.name, station: u.station })), acked: [] });
  e.orderLog.splice(ORDER_LOG);
  e.dirty = true;
  scheduleNav();
}
function ackOrder(k, id, who, declined = false) {
  const entry = engOf(k).orderLog.find((x) => x.id === id);
  if (!entry) return;
  if (declined) entry.declined = who.name; else if (!entry.acked.includes(who.id)) entry.acked.push(who.id);
  engOf(k).dirty = true;
  scheduleNav();
}
// Orders and who has acknowledged them, for whoever gave them.
const orders = new Map(); // id -> { id, ship, by, from, text, at, pending, acked }
function orderStatus(o) {
  const by = users.get(o.by);
  const names = (ids) => [...ids].map((id) => users.get(id)?.name).filter(Boolean);
  if (by) send(by, { type: 'order-status', id: o.id, text: o.text, at: o.at, acked: names(o.acked), pending: names(o.pending), ...(o.declined ? { declined: o.declined } : {}) });
}

function crewCommand(ws, msg) {
  const note = (text) => send(ws, { type: 'notice', text });
  const key = ws.shipKey;
  const aboard = (id) => { const u = typeof id === 'string' && users.get(id); return u && u.shipKey === key ? u : null; };
  const setShip = (set) => {
    const core = primaryCore.get(key);
    if (!core) { note("No ship's computer is running the ship"); return false; }
    send(core, { type: 'core-set', ship: ws.ship, set });
    return true;
  };

  switch (msg.type) {
    case 'alert': {
      if (ws.station !== 'Captain') return note('Only the Captain sets alert status');
      const level = ALERTS.includes(msg.level) ? msg.level : 'green';
      if (level === 'black' && !classOf(key).spore) return note('Black alert is for a ship with a spore drive');
      const wasBlack = alertOf(key) === 'black';
      if (!setShip({ alert: level })) return;
      // Black alert: nonessential systems down (their limits kept, to put back after).
      const core = primaryCore.get(key), e = engOf(key);
      if (level === 'black' && !wasBlack && core) { const p = allocOf(key); e.blackSaved = Object.fromEntries(BLACK_OFF.map((x) => [x, p[x]])); for (const x of BLACK_OFF) p[x] = 0; send(core, { type: 'core-power', ship: ws.ship, power: p }); }
      if (level !== 'black' && wasBlack && core && e.blackSaved) { const p = { ...allocOf(key), ...e.blackSaved }; e.blackSaved = null; send(core, { type: 'core-power', ship: ws.ship, power: p }); }
      if (level !== 'black' && e.spore?.charging) { e.spore.charging = false; e.spore.t = 0; tellStations(key, ['Helm'], 'Helm: spore jump aborted: the ship left black alert'); }
      // Red alert: shields up, if there's the power for them.
      if (level === 'red' && !shields.has(key) && capacityOf(key).shields >= MIN_SHIELD_POWER && combatOf(key).shield >= MIN_SHIELD_STRENGTH) { shields.add(key); flowCache.delete(key); broadcastShips(); }
      opLog(key, `${ws.name}: ${level} alert`);
      for (const u of crewOf(key)) send(u, { type: 'notice', text: `${level === 'green' ? 'Condition green' : `${level[0].toUpperCase()}${level.slice(1)} alert`}: ${ws.name}` });
      return;
    }
    case 'order': {
      // The Captain's or the First Officer's orders, to acknowledge. Whoever
      // gives them isn't asked; nor is the Captain for the First Officer's.
      if (ws.station !== 'Captain' && ws.station !== 'First Officer') return note("Only the Captain or the First Officer gives the ship's orders");
      const text = clean(msg.text).slice(0, 200);
      if (!text) return;
      const skip = ws.station === 'First Officer' ? ['Captain', 'First Officer'] : ['Captain'];
      // To the crew picked (by department or by name), or nobody picked: all hands.
      const picked = Array.isArray(msg.to) ? new Set(msg.to.filter((x) => typeof x === 'string')) : null;
      const to = crewOf(key).filter((u) => u !== ws && !skip.includes(u.station) && !u.operator && (!picked?.size || picked.has(u.id)));
      const o = { id: newId('o-'), ship: key, by: ws.id, from: info(ws), text, at: Date.now(), pending: new Set(to.map((u) => u.id)), acked: new Set() };
      orders.set(o.id, o);
      for (const u of to) send(u, { type: 'order', id: o.id, from: o.from, text, at: o.at });
      orderStatus(o);
      logOrder(key, o, to);
      opLog(key, `${ws.station === 'Captain' ? "Captain's" : "First Officer's"} orders: ${text}`);
      return;
    }
    case 'readiness': {
      // A readiness check: one department, or all of them.
      if (ws.station !== 'Captain' && ws.station !== 'First Officer') return note('Only the Captain or the First Officer calls for department readiness');
      const depts = msg.dept === 'all' ? DEPARTMENTS.filter((d) => hasStation(key, d)) : DEPARTMENTS.includes(msg.dept) ? [msg.dept] : [];
      if (!depts.length) return note('No such department');
      const r = readiness.get(key) || {};
      readiness.set(key, r);
      for (const d of depts) {
        // (Its crew at the station, not in sickbay; never the caller.)
        const crew = crewOf(key).filter((u) => (DEPT_OF[u.station] || u.station) === d && u !== ws && !u.sickbay);
        const id = newId('r-');
        r[d] = { id, pending: new Set(crew.map((u) => u.id)), ready: new Set(), at: Date.now() };
        for (const u of crew) send(u, { type: 'order', id, from: info(ws), text: `${d}: report when ready`, at: Date.now(), readiness: d });
      }
      opLog(key, `${ws.name}: readiness check, ${msg.dept === 'all' ? 'all departments' : depts[0]}`);
      scheduleNav();
      return note(`Readiness check: ${msg.dept === 'all' ? 'all departments' : depts[0]}`);
    }
    case 'order-ack': {
      // A readiness check answered: Ready.
      const rc = Object.values(readiness.get(key) || {}).find((c) => c.id === msg.id);
      if (rc) { if (rc.pending.delete(ws.id)) rc.ready.add(ws.id); scheduleNav(); return; }
      const o = orders.get(msg.id);
      if (!o || !o.pending.has(ws.id)) return;
      // A reassignment: move now, as walking would (force fields hold).
      if (o.reassign) {
        const to = o.reassign.station;
        if (sealed(key, placeOf(ws))) return note(`A Security force field isolates ${placeOf(ws)}: you can't leave to report to ${to}`);
        if (held(ws)) return note(`A Security force field holds you at ${placeOf(ws)}: you can't leave to report to ${to}`);
        if (sealed(key, to)) return note(`A Security force field isolates ${to}: you can't report there`);
        const was = placeOf(ws);
        seat(ws, to);
        send(ws, { type: 'registered', ...selfInfo(ws), token: ws.token });
        broadcastCrew(key);
        opLog(key, `${ws.name} reported to ${to} (from ${was}), as ordered`);
      }
      o.pending.delete(ws.id);
      o.acked.add(ws.id);
      orderStatus(o);
      ackOrder(key, o.id, ws);
      return;
    }
    case 'reassign': {
      if (ws.station !== 'First Officer') return note('Only the First Officer reassigns crew');
      const u = aboard(msg.who);
      if (!u) return note('That crew member is not aboard');
      if (u.operator) return note('The ops station can only be left by the operator');
      if (!STATIONS.includes(msg.station) || !hasStation(key, msg.station)) return note('No such station');
      if (placeOf(u) === msg.station) return;
      // An order to the crewman: they move when they acknowledge (or decline it).
      const o = { id: newId('o-'), ship: key, by: ws.id, from: info(ws), text: `${u.name}: report to ${msg.station}`, at: Date.now(), pending: new Set([u.id]), acked: new Set(), reassign: { who: u.id, station: msg.station } };
      orders.set(o.id, o);
      logOrder(key, o, [u]);
      send(u, { type: 'order', id: o.id, from: o.from, text: `Report to ${msg.station}`, at: o.at, reassign: msg.station });
      orderStatus(o);
      opLog(key, `${ws.name} ordered ${u.name} to report to ${msg.station}`);
      return note(`${u.name} ordered to ${msg.station}: waiting for them to acknowledge`);
    }
    case 'order-decline': {
      const o = orders.get(msg.id);
      if (!o || !o.reassign || !o.pending.delete(ws.id)) return;
      o.declined = ws.name;
      orderStatus(o);
      ackOrder(key, o.id, ws, true);
      const by = users.get(o.by);
      if (by) send(by, { type: 'notice', text: `${ws.name} declined the order to report to ${o.reassign.station}` });
      opLog(key, `${ws.name} declined the order to report to ${o.reassign.station}`);
      return;
    }
    case 'lockout': {
      if (ws.station !== 'Security') return note('Only Security controls the transporter lockout');
      if (!setShip({ lockout: !!msg.on })) return;
      opLog(key, `${ws.name}: transporter lockout ${msg.on ? 'on' : 'off'}`);
      return;
    }
    case 'bay-doors': {
      // Hangar control (at the Shuttle Bay) opens or closes the bay doors: they
      // need power to move, and the containment field holds the air in.
      if (ws.station !== 'Shuttle Bay') return note('Only hangar control (in the Shuttle Bay) works the bay doors');
      const e = engOf(key);
      if (!bayCapacity(key)) return note('this vessel has no shuttle bay');
      const open = !!msg.open;
      if (open && !e.bayOpen) {
        e.bayOpen = true; flowCache.delete(key);
        if (flow(key).subOk.bayDoors === false) { e.bayOpen = false; flowCache.delete(key); return note('Hangar control: the shuttle bay doors have no power (Engineering: tie them in)'); }
      } else e.bayOpen = open;
      e.dirty = true;
      opLog(key, `Hangar control (${ws.name}): shuttle bay doors ${open ? 'open' : 'closed'}`);
      gridChanged(key); broadcastOps(key);
      return note(`Hangar control: shuttle bay doors ${open ? 'open' : 'closed'}`);
    }
    case 'person-field': {
      // Security puts a force field around someone on the bridge (or takes it down): they can't walk off.
      if (ws.station !== 'Security') return note('Only Security puts force fields around people');
      const u = aboard(msg.who);
      if (!u) return note('That crew member is not aboard');
      if (msg.on && roomOf(u) !== roomOfStation(key, 'Helm')) return note(`${u.name} is not on the bridge`);
      u.fielded = !!msg.on;
      opLog(key, `Security (${ws.name}): force field ${msg.on ? 'around' : 'down from'} ${u.name}`);
      send(u, { type: 'notice', text: msg.on ? `Security: a force field holds you at ${placeOf(u)}` : 'Security: the force field around you is down' });
      gridChanged(key); broadcastCrew(key);
      return note(`Security: force field ${msg.on ? 'around' : 'down from'} ${u.name}`);
    }
    case 'brig-field': {
      // Security raises or drops the brig's force field.
      if (ws.station !== 'Security') return note('Only Security controls the brig force field');
      if (!hasStation(key, 'Brig')) return note('this vessel has no brig');
      engOf(key).brigField = !!msg.on; engOf(key).dirty = true;
      opLog(key, `Security (${ws.name}): brig force field ${msg.on ? 'up' : 'down'}`);
      gridChanged(key); broadcastCrew(key);
      return note(`Security: brig force field ${msg.on ? 'up' : 'down'}`);
    }
    case 'forcefield': {
      // Seal a console (or release it): nobody can use it while the field holds.
      if (ws.station !== 'Security') return note('Only Security controls the force fields');
      if (!STATIONS.includes(msg.station)) return note('No such station');
      const e = engOf(key);
      e.forcefields = msg.on ? [...new Set([...e.forcefields, msg.station])] : e.forcefields.filter((st) => st !== msg.station);
      e.dirty = true;
      flowCache.delete(key);
      for (const u of crewOf(key)) if (u.station === msg.station) send(u, { type: 'notice', text: msg.on ? `Security: a force field isolates ${msg.station} (nobody walks in or out)` : `Security: the force field around ${msg.station} is down` });
      opLog(key, `${ws.name}: force field ${msg.on ? 'up around' : 'down from'} ${msg.station}`);
      scheduleNav();
      return note(`Force field ${msg.on ? 'up around' : 'down from'} ${msg.station}`);
    }
    case 'confine': {
      if (ws.station !== 'Security') return note('Only Security confines crew to quarters');
      const u = aboard(msg.who);
      if (!u || u === ws) return note('Pick someone else aboard');
      if (u.operator) return note('The ops station cannot be confined');
      u.confined = !!msg.on;
      send(u, { type: 'notice', text: u.confined ? `Security: you are confined to quarters (you can only call Security, Medical or ops)` : 'Security: you are released from quarters' });
      broadcastCrew(key);
      opLog(key, `${ws.name} ${u.confined ? 'confined' : 'released'} ${u.name}`);
      return note(`${u.name} ${u.confined ? 'confined to quarters' : 'released'}`);
    }
    case 'emh': {
      // Medical activates or deactivates the holographic doctor (as Ops can, from its automation list).
      if (ws.station !== 'Medical') return note('Only Medical activates the holographic doctor');
      if (isBase(key)) return note('a starbase has no holographic doctor');
      setAuto(key, 'medical', !!msg.on);
      return note(msg.on ? 'Computer: activate the emergency medical hologram' : 'Computer: deactivate the EMH');
    }
    case 'sickbay': {
      if (ws.station !== 'Medical') return note('Only Medical admits crew to sickbay');
      const u = aboard(msg.who);
      if (!u) return note('That crew member is not aboard');
      u.sickbay = !!msg.on;
      send(u, { type: 'notice', text: u.sickbay ? `${ws.name}: you are in sickbay (off duty)` : `${ws.name}: you are discharged from sickbay` });
      broadcastCrew(key);
      opLog(key, `${ws.name} ${u.sickbay ? 'admitted' : 'discharged'} ${u.name} ${u.sickbay ? 'to' : 'from'} sickbay`);
      return note(`${u.name} ${u.sickbay ? 'admitted to' : 'discharged from'} sickbay`);
    }
  }
}

// --- the power grid (Engineering) ----------------------------------------------------
//
// Two buses (A, B) and the EPS grid carry power; the EPS reaches a bus through
// a tap Engineering opens or closes. Each source is tied (checkboxes) to the
// nodes it may feed:
//  - solar collectors: a trickle (A, B or EPS)
//  - dock power: plenty, while docked at a starbase (A or B)
//  - power sent by a ship docked with us (A or B)
//  - batteries: supply only when nothing else will, recharge from a tied
//    bus's surplus (A or B)
//  - the impulse drives, port and starboard: each its own reactor, started on
//    bus power (its deuterium pump) and then self-sustaining. Each gives half
//    impulse; with its maneuvering thrusters tied in to the EPS, whatever
//    share isn't thrusting feeds the EPS (untied: thrust only)
//  - the warp core (M/ARC): to the EPS only. It needs its magnetic constriction,
//    deuterium pump and antimatter injector powered (Bus A or B) to start and
//    to keep running; warp needs it
// Antimatter containment always draws power while there's antimatter aboard,
// from any of its feeds; it can only be switched off by self-destruct. With no
// power for a few seconds the core breaches and the ship is destroyed.
// Loads are tied too: each station's console (A or B) and the systems it
// controls by power class (A/B, or EPS only for the high-power ones), the
// warp core's and impulse drives' subsystems, and Communications' local RF,
// radio and subspace relay. Each node carries at most BUS_MAX: tie more load
// than that to it and its breaker trips loads off at random until it fits
// (containment and constriction never trip). Short of supply, power goes to
// containment, the reactors' subsystems, consoles, Communications, a docked
// ship, then systems a bus at a time in priority order.

const GRID = { forcefield: 5, core: 650, coreStartSecs: 10, containment: 20, constriction: { start: 60, run: 20 }, injector: 10, solar: 25, dock: 700, impulse: 75, impulseStartSecs: 5, impulsePump: 10, comms: 10, batteryOut: 100, batteryCap: 1000, batteryCharge: 50, epsOut: 300, epsCap: 1000, epsCharge: 100, console: 2, breachSecs: 5 };
const BUS_MAX = { A: 300, B: 300, C: 300, EPS: 1000 };
// Ship classes: set when a ship's computer first creates the ship (--class;
// kept in its .nav.json), Galaxy for ships from before classes. The class sets
// the buses' and the EPS's limits, the warp core's output and the top warp,
// the shields' strength, the phaser arrays, whether there's a warp core and a
// transporter, which stations it has, and its docking ports.
// (The classes' designs are in config/ships/<class>.json, the starbases' in
// config/ships/starbase.json: see tools/config.js. Ships of a class not there
// are the default class.)
const shipClasses = new Map(); // ship key -> class id
const classOf = (k) => (isRelay(k) ? RELAY_DESIGN : CLASSES[shipClasses.get(k)] || CLASSES[DEFAULT_CLASS]);
const classId = (k) => (isRelay(k) ? RELAY_DESIGN.id : CLASSES[shipClasses.get(k)] ? shipClasses.get(k) : DEFAULT_CLASS);
// A vessel's design: its class's, or the starbases' own.
const designOf = (k) => (isBase(k) ? BASE_DESIGN : classOf(k));
// The vessel's org chart (its design's "org"): the command, then each department,
// each position { id, title, rank, station } (n of one: ids id-1 .. id-n), only
// those whose station is aboard. [{ name, positions }]
const orgOf = (k) => {
  const o = designOf(k).org;
  if (!o) return [];
  const pos = (list) => (list || []).flatMap((p) => (p.n ? Array.from({ length: p.n }, (_, i) => ({ ...p, id: `${p.id}-${i + 1}`, n: undefined })) : [p]))
    .filter((p) => hasStation(k, p.station)).map(({ id, title, rank, station }) => ({ id, title, rank: RANKS.includes(rank) ? rank : null, station }));
  return [{ name: 'Command', positions: pos(o.command) }, ...(o.departments || []).map((d) => ({ name: d.name, positions: pos(d.positions) }))].filter((d) => d.positions.length);
};
const positionOf = (k, id) => orgOf(k).flatMap((d) => d.positions).find((p) => p.id === id) || null;
// Who has each position: { id: name } (theirs while they're away on another vessel, too).
const filledOf = (k) => Object.fromEntries([...users.values()].filter((u) => u.postShip === k && u.position).map((u) => [u.position, u.name]));
// A position asked for at sign-in: null (none asked), the position, or { why }.
function takePosition(k, msg, id) {
  if (msg.position == null || msg.position === '') return null;
  const p = positionOf(k, msg.position);
  if (!p) return { why: `the ${shipName(k)} has no such position` };
  const by = [...users.values()].find((u) => u.postShip === k && u.position === p.id && u.id !== id);
  if (by) return { why: `${p.title}: filled by ${by.name}` };
  return p;
}
// Where its stations are: its places (in deck order) and the room a station is in.
const placesOf = (k) => designOf(k).places || [];
const roomOfStation = (k, st) => placesOf(k).find((p) => p.stations.includes(st))?.name || st;
// The stations aboard (ops always: a runabout's cockpit and a shuttle have Ops too).
// (The Spore Lab: only aboard a ship with a spore drive.)
// (A design's stations: its list (none: all of them), and any its places name.)
const designStations = (k) => { const d = designOf(k); return d.stations == null ? null : [...d.stations, ...(d.places || []).flatMap((p) => p.stations)]; };
const hasStation = (k, st) => st === 'Operations' || (st === 'Spore Lab' ? !isBase(k) && !!classOf(k).spore : isBase(k) || !designStations(k) || designStations(k).includes(st));
const stationsOf = (k) => STATIONS.filter((st) => hasStation(k, st));
// A starbase's EPS carries three times a ship's; a ship's follow its class.
const busMaxOf = (k) => { const c = designOf(k); return { A: c.bus, B: c.bus, C: c.bus, EPS: c.eps }; };
// Supplies: the warp core burns antimatter and deuterium (per second, at full
// output; less as it gives less), each impulse drive deuterium while it runs.
// Refuel or offload at a starbase, or pass them between ships docked together.
const FUEL = { antimatter: 1000, deuterium: 2000, coreBurn: 0.5, impulseBurn: 0.1, transferRate: 50 };
const RESOURCES = ['antimatter', 'deuterium'];
// Low-power buses A, B and C; the EPS is the high-power bus. EPS taps feed
// EPS power down into each low bus (up to a level Engineering sets), and
// the bus crosslink joins the low buses checked on it into one pool.
const BUSES = ['A', 'B', 'C'];
const NODES = ['A', 'B', 'C', 'EPS'];
const AB = BUSES; // what a low-power tie may pick (one of them)
const DRIVES = ['port', 'starboard'];
const driveSource = (d) => `impulse${d[0].toUpperCase()}${d.slice(1)}`; // impulsePort, impulseStarboard
// Sources, in the order they're drawn on: power a docked ship sends us first, batteries last.
const SOURCES = ['ship', 'shipEps', 'solar', 'dock', 'dockEps', 'impulsePort', 'impulseStarboard', 'aux1', 'aux2', 'core', 'emergA', 'emergB', 'emergC', 'batteryA', 'batteryB', 'batteryC', 'pressure'];
// Emergency batteries: one per low bus, each tied only to its own (or not),
// holding EMERG_SIZE bus batteries' worth. They only give power while tied,
// last of all with the stores, and never recharge: a starbase replaces one
// with a full one.
const EMERG_SIZE = 5; // × a bus battery's capacity
const EMERG = { names: ['emergA', 'emergB', 'emergC'], bus: { emergA: 'A', emergB: 'B', emergC: 'C' }, cap: GRID.batteryCap * EMERG_SIZE, out: GRID.batteryOut };
// Sources that are used up (they never recharge): tied only by hand, never by All on.
const CONSUMABLE = new Set(EMERG.names);
// Drawn on only when nothing else will do: the stores and the emergency batteries.
const lastResort = (name) => isStore(name) || EMERG.names.includes(name);
// Stores: a battery on each low bus, and the EPS manifold's plasma pressure.
// Each is fixed to its own node (no ties to set): it covers that node's
// shortfall (last, when nothing else will) and charges from its surplus.
const STORES = { batteryA: 'A', batteryB: 'B', batteryC: 'C', pressure: 'EPS' };
const isStore = (name) => name in STORES;
// Power as shown: rounded up, away from zero (float dust aside).
const ceilUp = (v) => (v < 0 ? -Math.ceil(-v - 1e-9) : Math.ceil(v - 1e-9));
// The computer cores: three, each on a low bus (2), booting by themselves in
// stages (about 14 s) once tied and powered, crashing if their power fails
// (and booting again when it returns). The EPS flow
// regulators (the taps) need at least one online; text messages need one at
// each end; the warp core's dilithium auto-trim needs all three.
// The optical data network: each console's link to the ship's computers. A
// console off the ODN can't run its station (comms, the console log, the
// library and the Station screen still work); Engineering's link can't be
// cut. The links need no power of their own. odnLinked() is the one check
// (automation and remote control will use it too).
const odnLinked = (k, station) => station === 'Engineering' || !eng.has(k) || engOf(k).odn?.[station] !== false;
const COMPUTERS = ['computer1', 'computer2', 'computer3'];
// Fusion reactors: the two impulse drives and two auxiliary fusion reactors.
// Each burns deuterium from its own tank (on the deuterium bus). Its fusion
// reaction chamber (a low bus: 10 to light, then 5 to keep running) lights
// with the tank at 30% and flames out when it's dry, or without its power.
// With its EPS tap on, a running reactor powers its chamber from the
// (energized) EPS instead. The impulse drives' accelerators (a 0-100 throttle) and
// driver coils (Low gear: quick, a quarter impulse at most; High: slower, full
// impulse) drive the ship; an aux reactor's output (75) goes to the EPS.
const AUX = ['aux1', 'aux2'];
const FUSION = { chamberStart: 10, chamberRun: 5, aux: 75, gears: { low: { top: 0.25, rate: 0.03 }, high: { top: 1, rate: 0.015 } } };
const reactorsOf = (e) => [...DRIVES.map((d) => [d, e.drives[d]]), ...AUX.map((a) => [a, e.aux[a]])];
const reactorLabel = (r) => (r.startsWith('aux') ? `aux fusion reactor ${r.slice(3)}` : `${r} impulse drive`);
// A drive's share of impulse: half impulse (0.125) at full throttle in High gear.
const driveTop = (dr) => (0.125 * (dr.accel / 100) * FUSION.gears[dr.gear].top);
// Fuel: a deuterium bus and an antimatter bus. On each, the ship's main
// storage (the deuterium tank, the antimatter pods) and the small tanks of the
// systems that burn it (each impulse drive's and aux reactor's deuterium, the
// warp core's deuterium and antimatter, and the torpedo bay's antimatter).
// A tank tied to its bus with Fill on takes from the tanks with Drain on (50 a
// second at most per bus). A reactor (or the core) lights with its own tank at
// 30% and flames out when it runs dry. The antimatter bus moves nothing
// without its magnetic containment (EPS); the tanks keep their own.
const TANKS = {
  deu: { main: { label: 'Deuterium tank' }, core: { cap: 100, label: 'Warp core (matter)' }, port: { cap: 50, label: 'Port impulse drive' }, starboard: { cap: 50, label: 'Starboard impulse drive' }, aux1: { cap: 50, label: 'Aux fusion reactor 1' }, aux2: { cap: 50, label: 'Aux fusion reactor 2' } },
  am: { main: { label: 'Antimatter pods' }, core: { cap: 50, label: 'Warp core (antimatter)' }, torpedo: { cap: 100, label: 'Torpedo bay' } },
};
// Each bus's transfer draws 5: the deuterium bus's only while deuterium
// moves, the antimatter bus's all the time it's tied (as does its magnetic containment).
const FUELBUS = { flow: 50, light: 30, transfer: 5 };
const BUS_RESOURCE = { deu: 'deuterium', am: 'antimatter' };
// (The main storage holds what the vessel's design says: its file's "fuel"; e: its grid.)
const tankCap = (bus, name, e) => (name === 'main' ? (e?.fuelCaps || FUEL)[BUS_RESOURCE[bus]] : e?.tankCaps?.[`${bus}:${name}`] ?? TANKS[bus][name].cap);
// A design's fuel storage: its file's "fuel" ({ antimatter, deuterium }); none of what it doesn't carry.
const fuelCapsOf = (k) => { const d = designOf(k); return { antimatter: d.antimatter === false ? 0 : d.fuel?.antimatter ?? FUEL.antimatter, deuterium: d.fuel?.deuterium ?? FUEL.deuterium }; };
// Its systems' own tanks (the warp core's, the impulse drives', the torpedo bay's...): the design's
// "fuel.tanks" ({ "deu:core": 100, ... }), else the usual sizes; no antimatter in a design without it.
const tankCapsOf = (k) => { const d = designOf(k); return Object.fromEntries(Object.entries(TANKS).flatMap(([bus, ts]) => Object.entries(ts).filter(([n]) => n !== 'main').map(([n, t]) => [`${bus}:${n}`, bus === 'am' && d.antimatter === false ? 0 : d.fuel?.tanks?.[`${bus}:${n}`] ?? t.cap]))); };
const tankLevel = (e, bus, name) => (name === 'main' ? e[BUS_RESOURCE[bus]] : e.tanks[bus][name]);
const setTank = (e, bus, name, v) => { const x = Math.max(0, Math.min(tankCap(bus, name, e), v)); if (name === 'main') e[BUS_RESOURCE[bus]] = x; else e.tanks[bus][name] = x; };
const tankPct = (e, bus, name) => (100 * tankLevel(e, bus, name)) / (tankCap(bus, name, e) || 1);
// All the antimatter aboard, wherever it is.
const amAboard = (e) => e.antimatter + Object.values(e.tanks?.am || {}).reduce((a, b) => a + b, 0);
// Every antimatter tank keeps its own containment: the pods (the ship's main
// antimatter containment, 20), and the warp core's and the torpedo bay's
// tanks, each tied to the low buses with a draw scaled to its size, served
// ahead of everything and never tripped, on the same field rules. An empty
// tank draws nothing and can't breach.
const AM_CONTAIN = { core: 'contain:amCore', torpedo: 'contain:amTorpedo' };
const tankContainDraw = (name) => (GRID.containment * TANKS.am[name].cap) / FUEL.antimatter;
// The EPS manifold must be pressurized before the EPS carries anything: it
// charges from 100 or more of EPS generation (about 10 s), and collapses
// when the pressure runs out.
const EPS_CHARGE_GEN = 100;
// Antimatter containment is a field: held at strength (rising back to 100%)
// while it has its 20, from its feeds or, when they fail, from its own
// internal reserve (about 9 minutes; recharged from the feeds, 5 a second).
// With neither it falls, 5% a second; below 20% the pods breach. The warp
// core's injectors open (it lights) only with the field at 95%.
const CONTAIN = { reserveSecs: Number(process.env.RESERVE_SECS) || 540, recharge: 5, rise: 10, fall: 5, breach: 20, conduit: 95 };
const reserveCap = () => GRID.containment * CONTAIN.reserveSecs;
// The warp core's reaction (the Warp core panel). The injectors open only
// with the containment field at 95%, the deuterium feed at 80% and the
// antimatter transfer conduit up; cold ignition runs the reaction at 10% or
// less on a deuterium-rich mixture (15:1 or richer) and is self-sustaining
// after 6 s, then the rate climbs to the light bar's setting (5% a second).
// Output: up to 1000 × rate × efficiency, the efficiency from the mixture
// (best near 12:1), the dilithium's alignment (it drifts while running:
// trim it, or let auto-trim keep it, which needs all three computer cores)
// and the crystal's integrity (it wears above 80%). A hot core (over 90%)
// wears down the containment field; a live reaction with the field under
// 35% starts a 45 s breach countdown (cancelled above 60%, or if the reaction
// stops). Under 50% feed pressure, or with the conduit down, it flames out.
// SCRAM stops it at once. Warp needs the plasma transfer conduits to the
// nacelles open, and the top warp follows the core's output.
const CORE = { max: 1000, ignitionRate: 10, ignitionMix: 15, sustainSecs: 6, ramp: 5, feedMin: 80, flameout: 50, hot: 90, heat: 2, breachField: 35, breachSecs: 45, cancelField: 60, bestMix: 12 };
const coreEff = (w) => Math.max(0.3, 1 - Math.abs(w.mix - CORE.bestMix) * 0.03) * Math.max(0.3, w.align / 100) * (0.5 + (0.5 * w.crystal) / 100);
const coreOutput = (e) => (e.core === 'online' ? (CORE.max * e.wc.actual * coreEff(e.wc)) / 100 : 0);
const COMPUTER = { draw: 2, bootSecs: 14, stages: ['POST', 'LCARS kernel', 'ODN handshake', 'isolinear verification', 'subprocessor sync'] };
const coresOnline = (k) => (isBase(k) || !eng.has(k) ? COMPUTERS.length : engOf(k).computers.filter((c) => c.state === 'online').length);
// The crosslink is a chain, A–B–C: it joins A+B, B+C or all three (A and C only through B).
const chainOk = (list) => list.length < 2 || list.includes('B');
// Each crosslink tie can be one way: e.xlBlock lists the directions blocked ('A>B': no power from
// A into B). A closed tie with nothing blocked carries both ways; an open one, neither.
const XL_DIRS = ['A>B', 'B>A', 'B>C', 'C>B'];
const storeOf = (node) => (node === 'EPS' ? 'pressure' : `battery${node}`);
// Every tie is one class: Bus A/B, or the EPS only (the warp core's and
// impulse drives' outputs). The warp core itself spans both: its
// subsystems on A/B, its output on the EPS.
// Solar comes in on Bus B only; each emergency battery on its own bus. Each connection's
// power comes in on two rows: Power (Bus B) and EPS (the EPS).
const SOURCE_NODES = { ship: ['B'], shipEps: ['EPS'], solar: ['B'], dock: ['B'], dockEps: ['EPS'], emergA: ['A'], emergB: ['B'], emergC: ['C'], impulsePort: ['EPS'], impulseStarboard: ['EPS'], aux1: ['EPS'], aux2: ['EPS'], thrustersPort: ['EPS'], thrustersStarboard: ['EPS'], core: ['EPS'], containment: AB, crosslink: AB };
// Low-power loads and sources may tie to several of Bus A, B and C (a load
// split evenly over them, a source's output shared evenly); so may the
// crosslink (the buses checked are one pool). EPS ties are one.
const isMulti = (k) => k === 'crosslink' || CONDUITS.includes(k) || ((['containment', 'solar'].includes(k) || /^(console|system|sub|contain):/.test(k)) && !tieNodes(k).includes('EPS'));
const SHIP_FEED_MAX = 100; // the power that goes across a ship-to-ship connection, per row (export to an importing ship)
// Connections: everything we're docked with (the starbase; the ships at our
// ports). Per connection: Deuterium, Antimatter and Power, each with Import
// and Export. Import only keeps ours full, Export only keeps ours empty; both
// hold a set point (half the main storage for fuel, full for power). Fuel goes
// to and from the main storage (antimatter only with the pods' containment
// powered and the antimatter bus up), 50 a second; a starbase always has it to
// give and room to take; a ship moves fuel only to a side that wants it. Power
// comes in (and goes out) on two rows: Power, on Bus B (its set point Battery
// B full), and EPS, on the EPS (its set point the manifold full); a starbase
// gives 700 on each, a ship 100.
const CONN_RES = ['deu', 'am', 'power', 'eps'];
const CONN_POINT = { deu: 50, am: 50, power: 100, eps: 100 };
// The spore drive (a Crossfield's, run from the Spore Propulsion Laboratory):
// spores are grown aboard only, a unit every SPORE.growSecs while the
// cultivation chambers have their power (up to SPORE.cap; nothing dies off
// without it). A charge (SPORE.jump) is loaded into the drive by hand at the
// Spore Lab console (never by automation, remote control or Engineering); a
// jump spends it, charges for SPORE.chargeSecs with the drive getting
// SPORE.need% of its power, needs black alert, then the ship is there;
// SPORE.cooldownSecs between jumps.
const SPORE = { cap: 100, jump: 20, growSecs: Number(process.env.SPORE_GROW_SECS) || 30, chargeSecs: Number(process.env.SPORE_CHARGE_SECS) || 10, need: 90, cooldownSecs: Number(process.env.SPORE_COOLDOWN_SECS) || 60 };
const connOf = (e, key) => { const c = (e.conn[key] ||= {}); for (const r of CONN_RES) c[r] ||= { imp: false, exp: false }; return c; };
// Does this side want to take (in) or give (out) a resource, at its level (%)?
const wants = (c, level) => ({ in: c.imp && (!c.exp || level < CONN_POINT.deu) && level < 100, out: c.exp && (!c.imp || level > CONN_POINT.deu) && level > 0 });
const PORTS = ['port', 'starboard']; // docking ports (starbases take any number)
// The port a ship is docked to us at (or null), and the ships docked with us (both sides agreeing).
const portFor = (k, other) => PORTS.find((p) => engOf(k).shipDocks[p] === other) || null;
const shipsDocked = (k) => PORTS.map((p) => [p, engOf(k).shipDocks[p]]).filter(([, o]) => o && portFor(o, k));
// The shuttle bay: a craft landed in a ship's bay is connected to it like a
// docked ship (its own slot each side: 'bay' aboard the craft, 'bay:<craft>'
// aboard the mothership). In a starbase's bay, it's docked at the starbase.
const BAY = { doors: 3, field: 5 };
const bayCapacity = (k) => designOf(k).bay || 0;
const landedIn = (k) => [...eng].filter(([o, oe]) => oe.landed === k && present(o)).map(([o]) => o);
const bayLinks = (k) => {
  const e = engOf(k);
  if (e.landed && !isBase(e.landed)) return [['bay', e.landed]];
  return isBase(k) ? [] : landedIn(k).map((o) => [`bay:${o}`, o]);
};
// Every ship we're connected to: at a docking port, or by the bay.
const partners = (k) => [...shipsDocked(k), ...bayLinks(k)];
const slotFor = (o, k) => portFor(o, k) || (engOf(o).landed === k ? 'bay' : engOf(k).landed === o ? `bay:${k}` : null);
const SYSTEM_BUS = { sporeGrow: 'B', spore: 'EPS', phaser1: 'EPS', phaser2: 'EPS', phaser3: 'EPS', phaser4: 'EPS', drydock1: 'EPS', drydock2: 'EPS', drydock3: 'EPS', industrial: 'EPS', atmosphere: 'A', thermal: 'A', gravity: 'A', lights: 'A', lighting: 'A', lateral: 'A', sensors: 'EPS', deflector: 'EPS', bussard: 'EPS', amBus: 'EPS', sif: 'EPS', idf: 'EPS', replicators: 'B', recreation: 'B', engines: 'B', injectors: 'B', shields: 'B', weapons: 'B', transporter: 'B' };
const CONSOLE_BUS = { Captain: 'A', 'First Officer': 'A', Helm: 'A', Science: 'A', Engineering: 'A', Communications: 'A', Operations: 'A', Tactical: 'B', Security: 'B', Medical: 'B', Transporter: 'B', Crew: 'B', 'Shuttle Bay': 'B', Brig: 'B', 'Spore Lab': 'B', 'Bridge 1': 'A', 'Bridge 2': 'A', 'Bridge 3': 'A', 'Bridge 4': 'A', 'Bridge 5': 'A' };
// Why this ship can't spore-jump now (null: it can).
function sporeFault(k) {
  const e = engOf(k);
  if (isBase(k) || !classOf(k).spore) return 'no spore drive aboard';
  if (alertOf(k) !== 'black') return 'black alert first (the Captain)';
  if (e.docked || shipsDocked(k).length) return 'undock first';
  if (e.drydock) return 'in drydock';
  if (e.landed) return 'landed in a shuttle bay';
  if (e.towing || towedBy(k)) return e.towing ? 'towing a ship' : 'held in a tractor beam';
  if (e.spore?.ready > Date.now()) return `the drive is cooling down (${Math.ceil((e.spore.ready - Date.now()) / 1000)} s)`;
  if ((e.spore?.loaded || 0) < SPORE.jump) return 'spores not loaded (Spore Lab)';
  if (!(e.ties['system:spore'] || []).length) return 'the spore drive is untied (Engineering)';
  return null;
}
const STATION_SYSTEMS = { Helm: ['engines', 'deflector', 'bussard'], Tactical: ['shields', 'phaser1', 'weapons', 'tractor'], Science: ['sensors', 'lateral'], Engineering: ['sif', 'idf', 'amBus', 'lifeSupport'] /* a parent row: its systems carry the ties */, Transporter: ['transporter'], Crew: ['replicators', 'recreation'], 'Spore Lab': ['sporeGrow', 'spore'] };
const LOAD_NODES = {
  atmosphere: AB, thermal: AB, gravity: AB, lights: AB, lighting: AB, lateral: AB, replicators: AB, recreation: AB, // low power
  transporter: AB, sporeGrow: AB,
  engines: ['EPS'], injectors: ['EPS'], shields: ['EPS'], weapons: ['EPS'], tractor: ['EPS'], sensors: ['EPS'], deflector: ['EPS'], bussard: ['EPS'], amBus: ['EPS'], sif: ['EPS'], idf: ['EPS'], drydock1: ['EPS'], drydock2: ['EPS'], drydock3: ['EPS'], industrial: ['EPS'], phaser1: ['EPS'], phaser2: ['EPS'], phaser3: ['EPS'], phaser4: ['EPS'], spore: ['EPS'], // high power: EPS only
};
// Starbases are flown by the relay (they have no ship's computer): Helm's
// orders go straight to their position, and they move at impulse each second.
function setBasePos(k, x, y, heading) {
  const n = navState.get(k), b = STARBASES.find((sb) => shipKey(sb.name) === k);
  if (!n) return;
  n.x = Math.min(1000, Math.max(0, x)); n.y = Math.min(1000, Math.max(0, y));
  if (Number.isFinite(heading)) n.heading = heading;
  if (b) { b.x = n.x; b.y = n.y; } // (docking and the map use the starbase list)
}
function baseHelm(k, order) {
  const n = navState.get(k);
  if (!n) return;
  if (order.dest !== undefined) n.dest = order.dest;
  if (typeof order.heading === 'number') { n.heading = ((order.heading % 360) + 360) % 360; n.dest = order.dest ?? null; }
  if (typeof order.warp === 'number') n.warp = Math.max(0, Math.min(0.999, order.warp)); // impulse only
  if (n.warp === 0) n.dest = null;
  engOf(k).dirty = true;
  scheduleNav();
}
function baseMove(k) {
  const n = navState.get(k);
  const step = 2 * n.warp; // impulse: as a ship's computer flies it (0.25: 0.5 a second)
  if (n.dest) {
    const dx = n.dest.x - n.x, dy = n.dest.y - n.y, d = Math.hypot(dx, dy);
    n.heading = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
    if (d <= step) { setBasePos(k, n.dest.x, n.dest.y); opLog(k, `Helm: arrived at ${Math.round(n.x)}, ${Math.round(n.y)}`); n.warp = 0; n.dest = null; engOf(k).impulseWant = 0; return; }
    setBasePos(k, n.x + (dx / d) * step, n.y + (dy / d) * step);
  } else {
    const a = (n.heading * Math.PI) / 180;
    setBasePos(k, n.x + Math.sin(a) * step, n.y - Math.cos(a) * step);
  }
  engOf(k).dirty = true;
}
// A ship's grid rows follow its class: a second phaser array, no transporter, no warp drive, its stations.
function classSystems(k) {
  const c = classOf(k), out = {};
  for (const [st, list] of Object.entries(STATION_SYSTEMS)) {
    if (!hasStation(k, st) && st !== 'Engineering') continue;
    out[st] = list.flatMap((x) => (x === 'phaser1' ? PHASER_ARRAYS.slice(0, arraysOf(k)) : [x])).filter((x) => (x !== 'transporter' || c.transporter) && (!WARP_DRIVE.includes(x) || c.maxWarp) && ((x !== 'spore' && x !== 'sporeGrow') || c.spore));
  }
  return out;
}
// A grid row aboard this vessel (by its design): a console of one of its stations, one of its
// places, a system its design has (one a station of its lists, or no station's), a subsystem
// under something aboard. (Sources, conduits and the rest: always.)
const sysGone = (k, x) => (BASE_ONLY.includes(x) && !isBase(k)) || PHASER_ARRAYS.indexOf(x) >= arraysOf(k) || (x === 'transporter' && !isBase(k) && !classOf(k).transporter)
  || (WARP_DRIVE.includes(x) && (isBase(k) || !classOf(k).maxWarp)) || (x === 'spore' && (isBase(k) || !classOf(k).spore));
function aboardKey(k, key) {
  // (Sources, by the design: solar arrays with an output, emergency batteries it lists (all three
  // unless it says), fusion reactors unless "fusion": false, a warp core (and what holds its
  // antimatter) unless "warpCore": false or "antimatter": false, docking power with docking ports.)
  const dz = designOf(k), noCore = dz.warpCore === false || dz.antimatter === false;
  if (key === 'solar') return (dz.solar?.output || 0) > 0;
  if (EMERG.names.includes(key)) return (dz.emergency || ['A', 'B', 'C']).includes(EMERG.bus[key]);
  if (['impulsePort', 'impulseStarboard', 'aux1', 'aux2'].includes(key)) return dz.fusion !== false;
  if (['core', 'containment', 'sub:constriction', 'sub:amConduit', 'sub:injector', ...Object.values(AM_CONTAIN)].includes(key)) return !noCore || (key === 'contain:amTorpedo' && dz.antimatter !== false && (dz.torpedoes || 0) > 0);
  if (['dock', 'dockEps', 'ship', 'shipEps'].includes(key)) return isBase(k) || dz.ports !== 0;
  if (key.startsWith('console:')) return hasStation(k, key.slice(8));
  if (key.startsWith('place:')) return placesOf(k).some((pl) => `place:${pl.name}` === key);
  // (a row the design names itself: in one of its places, or its ties with nodes)
  const d = designOf(k);
  if (/^(system|sub):/.test(key) && ((d.places || []).some((pl) => (pl.rows || []).includes(key)) || (d.ties?.[key] || []).length)) return true;
  if (key.startsWith('system:')) {
    const x = key.slice(7);
    if (CONDUITS.includes(key) || sysGone(k, x)) return CONDUITS.includes(key);
    const owners = Object.entries(STATION_SYSTEMS).filter(([, list]) => list.includes(x) || (x.startsWith('phaser') && list.includes('phaser1'))).map(([st]) => st);
    return !owners.length || owners.some((st) => st === 'Engineering' || hasStation(k, st));
  }
  if (key.startsWith('sub:')) {
    const p = SUBSYSTEMS[key.slice(4)]?.parent;
    return !p || (STATIONS.includes(p) ? hasStation(k, p) : !SYSTEMS.includes(p) || aboardKey(k, `system:${p}`));
  }
  return true;
}
// Loads a vessel's design doesn't have (a save from when it was another class, say): untied.
function pruneLoads(k) {
  const e = eng.get(k);
  if (!e) return;
  for (const x of Object.keys(e.ties)) if (!CONDUITS.includes(x) && x !== 'crosslink' && e.ties[x].length && !aboardKey(k, x)) e.ties[x] = [];
  flowCache.delete(k);
}
// What each console's grid rows list: a starbase has no warp drive, and has its drydock connections and industrial replicators.
const stationSystemsOf = (k) => (!isBase(k) ? classSystems(k) : isBase(k) ? { ...STATION_SYSTEMS, Helm: STATION_SYSTEMS.Helm.filter((x) => !WARP_DRIVE.includes(x)), Tactical: ['shields', ...PHASER_ARRAYS, 'weapons', 'tractor'], Engineering: [...STATION_SYSTEMS.Engineering, ...BASE_ONLY.filter((x) => !PHASER_ARRAYS.includes(x))], 'Spore Lab': [] } : STATION_SYSTEMS);
const SYSTEM_PRIORITY = ['amBus', 'sif', 'idf', 'atmosphere', 'thermal', 'lighting', 'lights', 'gravity', 'sensors', 'lateral', 'deflector', 'bussard', 'shields', 'engines', 'injectors', 'phaser1', 'phaser2', 'phaser3', 'phaser4', 'spore', 'sporeGrow', 'weapons', 'tractor', 'drydock1', 'drydock2', 'drydock3', 'transporter', 'replicators', 'recreation', 'industrial'];
// Systems shown under another system in the grid table (Helm > Engines > Plasma injectors).
const SYSTEM_CHILDREN = { engines: ['injectors'], lifeSupport: LIFE_SUPPORT };
// Rows with no ties of their own, only their systems' (Engineering > Life support > ...).
const SYSTEM_PARENTS = { lifeSupport: 'Life support' };
// Subsystems: low-power loads (A or B) that their parent needs to work.
const SUBSYSTEMS = {
  constriction: { parent: 'core', ties: ['A'], name: 'magnetic constriction' },
  amConduit: { parent: 'core', ties: ['A'], name: 'antimatter transfer conduit' },
  injector: { parent: 'core', ties: ['A'], name: 'antimatter injector' },
  portChamber: { parent: 'impulsePort', ties: ['B'], name: 'fusion reaction chamber' },
  starboardChamber: { parent: 'impulseStarboard', ties: ['B'], name: 'fusion reaction chamber' },
  aux1Chamber: { parent: 'aux1', ties: ['A'], name: 'fusion reaction chamber' },
  aux2Chamber: { parent: 'aux2', ties: ['B'], name: 'fusion reaction chamber' },
  forcefields: { parent: 'Security', ties: ['B'], name: 'force field emitters' },
  patternBuffers: { parent: 'Transporter', ties: ['B'], name: 'pattern buffers' },
  targetingScanners: { parent: 'Transporter', ties: ['B'], name: 'targeting scanners' },
  energizingCoils: { parent: 'Transporter', ties: ['B'], name: 'energizing coils' },
  heisenberg: { parent: 'Transporter', ties: ['B'], name: 'Heisenberg compensators' },
  biofilter: { parent: 'Transporter', ties: ['B'], name: 'biofilter' },
  // The fuel buses' transfer power (low buses): nothing moves on a bus without it.
  deuTransfer: { parent: 'fuel', ties: ['B'], name: 'Deu. bus transfer' },
  amTransfer: { parent: 'fuel', ties: ['B'], name: 'AM bus transfer' },
  // The brig's force field (Security): while it's up, nobody walks into or out of the Brig.
  brigField: { parent: 'Security', ties: ['B'], name: 'brig force field' },
  // Sickbay's holo-emitters (Medical): the holographic doctor, 10 while it's active.
  holoEmitters: { parent: 'Medical', ties: ['B'], name: 'holo-emitters' },
  // The shuttle bay: its doors and the containment field that holds the air in while they're open.
  bayDoors: { parent: 'Shuttle Bay', ties: ['B'], name: 'shuttle bay doors' },
  bayField: { parent: 'Shuttle Bay', ties: ['B'], name: 'shuttle bay containment field' },
  computer1: { parent: 'computer', ties: ['A'], name: 'computer core 1' },
  computer2: { parent: 'computer', ties: ['B'], name: 'computer core 2' },
  computer3: { parent: 'computer', ties: ['C'], name: 'computer core 3' },
  rf: { parent: 'Communications', ties: ['B'], name: 'local RF (calls aboard)' },
  radio: { parent: 'Communications', ties: ['B'], name: 'radio (hails, ship-to-ship calls)' },
  subspace: { parent: 'Communications', ties: ['B'], name: 'subspace relay (data links)' },
};
const DEFAULT_LOAD_TIES = {
  ...Object.fromEntries(Object.entries(CONSOLE_BUS).map(([st, b]) => [`console:${st}`, [b]])),
  ...Object.fromEntries(Object.entries(SYSTEM_BUS).map(([sys, b]) => [`system:${sys}`, LOAD_NODES[sys].includes(b) ? [b] : ['EPS']])),
  'system:tractor': ['EPS'],
  ...Object.fromEntries(Object.entries(SUBSYSTEMS).map(([k, v]) => [`sub:${k}`, v.ties])),
  ...Object.fromEntries(Object.values(AM_CONTAIN).map((k) => [k, ['A']])),
};
const loadNodes = (key) => (key.startsWith('console:') || key.startsWith('sub:') || key.startsWith('contain:') ? AB : LOAD_NODES[key.slice(7)] || []);
const tieNodes = (key) => SOURCE_NODES[key] || (key.startsWith('place:') ? NODES : key === 'system:lifeSupport' ? AB : loadNodes(key));
// --- power paths ------------------------------------------------------------------------
// On each bus, power runs source → location → system → subsystem: a load's tie
// carries power only if every conduit on its way is tied to that bus too: its
// place (and any place it's reached through, its "via"), and its parent system
// (life support for its systems, the warp coils for the plasma injectors). Untie
// one and everything past it is cut off from that bus (its demand doesn't count).
// Conduits draw nothing. Antimatter containment is never cut off this way.
const PLACE_NAMES = [...new Set(ALL_DESIGNS.flatMap((c) => (c.places || []).map((pl) => pl.name)))];
const CONDUITS = [...PLACE_NAMES.map((n) => `place:${n}`), 'system:lifeSupport'];
const PARENT_SYSTEM = { injectors: 'system:engines', ...Object.fromEntries(LIFE_SUPPORT.map((x) => [x, 'system:lifeSupport'])) };
const conduitMemo = new Map();
function conduitsOf(k, key) {
  const design = isBase(k) ? 'starbase' : classId(k), memo = `${design}|${key}`;
  if (conduitMemo.has(memo)) return conduitMemo.get(memo);
  let out = [];
  const places = placesOf(k);
  if (places.length && (/^(console|system|sub):/.test(key) || key.startsWith('place:'))) {
    const named = (n) => places.find((pl) => pl.name === n);
    const parent = key.startsWith('system:') ? PARENT_SYSTEM[key.slice(7)] : null;
    const at = key.startsWith('place:') ? named(key.slice(6))
      : key.startsWith('console:') ? places.find((pl) => pl.stations.includes(key.slice(8)))
      : places.find((pl) => (pl.rows || []).includes(parent || key)) || places.find((pl) => pl.default);
    const chain = [];
    for (let q = at, n = 0; q && n < 8; q = q.via && named(q.via), n++) chain.push(`place:${q.name}`);
    out = [...chain.filter((c) => c !== key), ...(parent ? [parent] : [])];
  }
  conduitMemo.set(memo, out);
  return out;
}
// A load's ties that carry power: those its conduits are all tied to as well.
const effTies = (k, e, key) => { const t = e.ties[key] || [], via = conduitsOf(k, key); return via.length ? t.filter((X) => via.every((c) => (e.ties[c] || []).includes(X))) : t; };
// A vessel from before power paths (or a warm start): each conduit tied wherever its loads are.
function deriveConduits(k) {
  const e = engOf(k);
  for (const c of CONDUITS) e.ties[c] = [];
  const loads = Object.keys(e.ties).filter((x) => /^(console|system|sub):/.test(x) && !CONDUITS.includes(x));
  for (const key of loads) for (const c of conduitsOf(k, key)) e.ties[c] = NODES.filter((n) => e.ties[c].includes(n) || (e.ties[key] || []).includes(n));
  // (a place reached through another: that one carries what it carries)
  for (const c of CONDUITS.filter((x) => x.startsWith('place:'))) for (const up of conduitsOf(k, c)) e.ties[up] = NODES.filter((n) => e.ties[up].includes(n) || e.ties[c].includes(n));
  e.conduits = true; e.dirty = true; flowCache.delete(k);
}
// A saved ship under a changed design: a load whose power path changed (a row moved to another
// place, a place reached through another now), or that runs through a place new to the design,
// gets the conduits on its path tied where it is. Everything else stays as the crew left it.
function reconcileConduits(k) {
  const e = engOf(k), r = e.restore;
  delete e.restore;
  if (!r || !e.conduits) return;
  const loads = Object.keys(e.ties).filter((x) => /^(console|system|sub):/.test(x) && !CONDUITS.includes(x));
  const touched = new Set();
  for (const key of loads) {
    const chain = conduitsOf(k, key);
    if (!(r.paths && r.paths[key] !== undefined && r.paths[key] !== chain.join('>')) && !chain.some((c) => r.newConduits.includes(c))) continue;
    for (const c of chain) { e.ties[c] = NODES.filter((n) => (e.ties[c] || []).includes(n) || ((e.ties[key] || []).includes(n) && tieNodes(c).includes(n))); touched.add(c); }
  }
  // (a place reached through another: that one carries what it carries)
  for (const c of [...touched].filter((x) => x.startsWith('place:'))) for (const up of conduitsOf(k, c)) e.ties[up] = NODES.filter((n) => e.ties[up].includes(n) || e.ties[c].includes(n));
  if (touched.size) { e.dirty = true; flowCache.delete(k); console.log(`${shipName(k)}: its design's power paths changed; ${[...touched].join(', ')} tied where their loads are`); }
}
const NEVER_TRIP = new Set(['containment', 'sub:constriction', ...Object.values(AM_CONTAIN)]);
// Starbases: dock to restock torpedoes, take dock power, repair faster and
// refit a warp core. A destroyed ship comes back docked at one of them.
// (The star chart, its starbases and the shipyard among them, is config/starsystem/<system>.json;
// there's one system for now, and every ship and starbase is in it.)
const SYSTEMS_CONFIG = CONFIG.loadSystems((line) => console.warn(line));
const SYSTEM_ID = SYSTEMS_CONFIG.sol ? 'sol' : Object.keys(SYSTEMS_CONFIG)[0];
if (!SYSTEM_ID) { console.error(`config: no star chart in ${CONFIG.DIR}/starsystem: the relay can't start`); process.exit(1); }
const STAR_SYSTEM = SYSTEMS_CONFIG[SYSTEM_ID];
const STARBASES = STAR_SYSTEM.starbases.map((b) => ({ name: b.name, x: b.x, y: b.y, system: SYSTEM_ID, ...(b.shipyard ? { shipyard: true, berths: b.berths || 3 } : {}) }));
// --- subspace relays -------------------------------------------------------------------------
const RELAYS = Object.entries(SYSTEMS_CONFIG).filter(([, sys]) => sys.relay).map(([id, sys]) => ({ name: sys.relay.name, x: sys.relay.x, y: sys.relay.y, system: id }));
const relayOff = new Set();
const relayOf = (k) => RELAYS.find((r) => shipKey(r.name) === k);
// A relay's transceiver has power (its grid's subspace subsystem).
const relayLive = (r) => { try { return flow(r).subOk.subspace !== false; } catch { return true; } };
// A relay links its own system's stations, and the other systems' relays (while it's on).
function relayReach(a, b) {
  const r = isRelay(a) ? a : b, o = r === a ? b : a;
  if (relayOff.has(r)) return false;
  if (isRelay(o)) return !relayOff.has(o);
  const sys = relayOf(r)?.system;
  return isBase(o) && (sys === SYSTEM_ID ? HOME_SYSTEM : sys) === systemOf(o) && commsUp(o, 'subspace'); // (the main chart's vessels are in its home system)
}
// Its links, kept: made with every station of its system and every other relay; gone while it's off.
function relayTick() {
  let changed = false;
  for (const r of RELAY_KEYS) {
    const want = relayOff.has(r) ? [] : [...BASE_KEYS, ...RELAY_KEYS].filter((o) => o !== r && relayReach(r, o));
    for (const o of linkedTo(r)) if (!want.includes(o)) { links.delete(linkKey(r, o)); changed = true; }
    for (const o of want) if (!links.has(linkKey(r, o))) { addLink(linkKey(r, o)); changed = true; }
    // (Its transceiver, the subspace subsystem, without power: its links stay, signal lost.)
    const dark = !relayLive(r);
    for (const o of linkedTo(r)) {
      const l = linkKey(r, o), lost = dark || (isRelay(o) && !relayLive(o));
      if (lost !== lostLinks.has(l)) { if (lost) lostLinks.add(l); else lostLinks.delete(l); changed = true; }
    }
  }
  if (changed) { refreshNetworks([...RELAY_KEYS, ...BASE_KEYS]); broadcastAllOps(); schedulePresence(); }
}
// The shipyard: an automated station like the others (dock for supplies and
// power), which can also drydock a ship. A drydocked ship can't move or
// undock until it's released; warp core and pod replacement and fast repairs
// need drydock. Helm requests release: 30 s later, with no repair job under
// way, unless the shipyard's ops hold it (or release it sooner). Three at a time.
const SHIPYARD = STARBASES.find((b) => b.shipyard);
const isShipyard = (name) => !!STARBASES.find((b) => b.name === name)?.shipyard;
const DRYDOCK = { releaseSecs: Number(process.env.DRYDOCK_RELEASE_SECS) || 30, berths: SHIPYARD?.berths || 3 };
// New and rebuilt ships come up at an ordinary starbase.
const SPAWN_BASES = STARBASES.filter((b) => !b.shipyard);
const drydocked = () => [...eng].filter(([k, e]) => e.drydock && !isBase(k)).map(([k]) => k);
const DOCK_RANGE = 10;
// Starbases are on the comm net by themselves: anyone can report aboard,
// ops included. Automated, they accept data links after a short delay
// (sooner with crew aboard to expedite it) and put hails through to whoever
// is aboard; an operator aboard can answer first.
const BASE_DELAY = { link: 5000, linkCrewed: 2000, hail: 2000 };
const BASE_KEYS = new Set();
// Subspace relays: one a star system (its file's "relay"), there to join every station in
// the system into one data network, and the systems to each other. Unmanned and
// self-powered: never signed into, docked with, boarded or towed, and not a sensor
// contact. Its links can't be closed by the stations; only the admin page disables it.
const RELAY_KEYS = new Set();
const isRelay = (k) => RELAY_KEYS.has(k);
const isBase = (k) => BASE_KEYS.has(k);
const present = (k) => cores.has(k) || BASE_KEYS.has(k) || RELAY_KEYS.has(k);
for (const b of STARBASES) { const k = registerShip(b.name); BASE_KEYS.add(k); navState.set(k, { x: b.x, y: b.y, heading: 0, warp: 0, dest: null }); }
for (const r of RELAYS) { const k = registerShip(r.name); RELAY_KEYS.add(k); navState.set(k, { x: r.x, y: r.y, heading: 0, warp: 0, dest: null }); }

function autoAcceptLink(id) {
  const req = linkRequests.get(id);
  if (!req) return; // answered already
  linkRequests.delete(id);
  const base = shipName(req.toShip);
  if ((!opsOf(req.fromShip).length && !crewOf(req.fromShip).some((u) => u.station === 'Communications')) || !linkReach(req.fromShip, req.toShip)) { opLog(req.fromShip, `${base} could not open the data link`); broadcastAllOps(); return; }
  addLink(linkKey(req.fromShip, req.toShip));
  opLog(req.fromShip, `${base} (automated) accepted: data link open`);
  opLog(req.toShip, `data link with the ${shipName(req.fromShip)} open (automated)`);
  refreshNetworks([req.fromShip]);
  broadcastAllOps();
  console.log(`data link open: ${shipName(req.fromShip)} - ${base} (automated)`);
}

// Put a hail through to someone aboard a starbase with no operator: the
// Captain or Communications if aboard, else whoever is free.
function autoAnswerHail(id) {
  const h = hails.get(id);
  if (!h) return;
  const caller = users.get(h.caller);
  const order = ['Captain', 'Communications', 'First Officer'];
  const aboard = crewOf(h.toShip).filter((u) => u.state === 'idle').sort((a, b) => (order.indexOf(a.station) + 1 || 9) - (order.indexOf(b.station) + 1 || 9));
  if (opsOf(h.toShip).length) return; // an operator came on duty: theirs to answer
  hails.delete(id);
  if (!caller || !aboard.length) {
    if (caller) send(caller, { type: 'notice', text: `${shipName(h.toShip)} (automated): nobody free to take the call` });
  } else {
    forceConnect(caller, aboard[0]);
    opLog(h.fromShip, `${shipName(h.toShip)} (automated) put ${caller.name} through to ${aboard[0].name}, ${aboard[0].station}`);
  }
  broadcastOps(h.fromShip);
  broadcastOps(h.toShip);
}
const SELF_DESTRUCT_SECS = Number(process.env.SELF_DESTRUCT_SECONDS) || 30;
const BLAST = { range: 30, damage: 30 }; // a ship blowing up hurts ships close by
// Tractor beam (Tactical): holds a ship whose shields are down and tows it.
const TRACTOR = { range: 20, draw: 30, maxWarp: 3, behind: 3 };
const eng = new Map(); // ship key -> { core, antimatter, start, taps, ties, battery, docked, breach, selfDestruct, towing, dirty }

// thrustersPort / thrustersStarboard: a drive's maneuvering thrusters tied in
// to the EPS (the drive's unused thrust feeds it) or not (thrust only).
const DEFAULT_TIES = { solar: ['B'], dock: ['B'], dockEps: [], ship: [], shipEps: [], emergA: [], emergB: [], emergC: [], impulsePort: ['EPS'], impulseStarboard: ['EPS'], aux1: ['EPS'], aux2: ['EPS'], thrustersPort: ['EPS'], thrustersStarboard: ['EPS'], core: ['EPS'], containment: ['A'], crosslink: [] };
// New ships (unless their computer says --warm) and rebuilt ones start cold:
// docked at a starbase, reactors offline, no power source tied in (consoles
// and systems keep their wiring), taps closed, no antimatter or deuterium.
// Engineering brings them up on dock power.
// Cold iron: nothing tied in anywhere, sources or loads (the drives feed the EPS only through their thrusters' ties).
const COLD = { ties: { ...Object.fromEntries([...Object.keys(DEFAULT_TIES), ...Object.keys(DEFAULT_LOAD_TIES)].map((k) => [k, []])), impulsePort: ['EPS'], impulseStarboard: ['EPS'] }, taps: { A: 0, B: 0, C: 0 }, breakers: { A: false, B: false, C: false }, computers: ['off', 'off', 'off'], core: 'offline', drives: { port: { state: 'off', epsTap: false, accel: 0, gear: 'low' }, starboard: { state: 'off', epsTap: false, accel: 0, gear: 'low' } }, aux: {}, epsLive: false, antimatter: 0, deuterium: 0 };
// (k: the vessel, when it's known: its design's ties are the defaults for anything a save lacks,
// and its buses' limits cap the EPS taps.)
function freshEng(saved, { cold = false, k = null } = {}) {
  cold = cold || saved === COLD;
  const designTies = k ? designOf(k).ties || {} : {}, tapMax = k ? busMaxOf(k) : BUS_MAX;
  const s = saved && typeof saved === 'object' ? saved : cold ? COLD : {};
  // Ties: a list of nodes (older saves had one bus, or null for off), only those allowed.
  // A saved tie that's no longer allowed (an EPS tie on an A/B load, say) moves to the default bus.
  const tiesOf = (k, v, d) => {
    const list = Array.isArray(v) ? v : typeof v === 'string' ? [v] : v === null ? [] : null;
    if (!list) return d;
    const ok = NODES.filter((n) => list.includes(n) && tieNodes(k).includes(n)).slice(0, isMulti(k) ? 4 : 1); // sources and EPS loads: one tie
    return !ok.length && list.length ? d : ok;
  };
  // Older saves: crosslinks per pair, thrusters on/off.
  const oldXl = s.crosslinks ? [...new Set(Object.entries(s.crosslinks).filter(([, on]) => on).flatMap(([x]) => x.split('')))] : s.crosslink ? ['A', 'B'] : undefined;
  // Thrusters were once a load (sub:portThrusters) or on/off (thrusters.port): tied there means tied in.
  const oldThr = (d) => (Array.isArray(s.ties?.[`sub:${d}Thrusters`]) ? (s.ties[`sub:${d}Thrusters`].length ? ['EPS'] : []) : s.thrusters?.[d] === false ? [] : undefined);
  const ties = Object.fromEntries(Object.entries(DEFAULT_TIES).map(([k, d]) => [k, tiesOf(k, s.ties?.[k] ?? (k === 'crosslink' ? oldXl : k === 'thrustersPort' ? oldThr('port') : k === 'thrustersStarboard' ? oldThr('starboard') : s[k]), designTies[k] ?? d)]));
  if (!chainOk(ties.crosslink)) ties.crosslink = []; // (A and C without B: older saves lose the crosslink)
  for (const c of CONDUITS) ties[c] = Array.isArray(s.ties?.[c]) ? NODES.filter((n) => s.ties[c].includes(n) && tieNodes(c).includes(n)) : []; // (the power paths' conduits)
  // (Conduits a save with power paths doesn't have: places new to the design since.)
  const newConduits = s.conduits ? CONDUITS.filter((c) => !Array.isArray(s.ties?.[c])) : [];
  // Older saves: antimatter was true/false (false: core ejected); tanks full.
  const amount = (v, cap) => (Number.isFinite(v) ? Math.max(0, Math.min(cap, v)) : v === false ? 0 : cap);
  const fuelCaps = k ? fuelCapsOf(k) : { antimatter: FUEL.antimatter, deuterium: FUEL.deuterium };
  const tankCaps = k ? tankCapsOf(k) : null, tcap = (bus, n) => tankCaps?.[`${bus}:${n}`] ?? TANKS[bus][n].cap;
  const antimatter = amount(s.antimatter, fuelCaps.antimatter), deuterium = amount(s.deuterium, fuelCaps.deuterium);
  if (!ties.containment.length && antimatter > 0) ties.containment = DEFAULT_TIES.containment; // never no feed with antimatter aboard
  // (Older saves: life support was one load; its ties go to all three of its systems.)
  for (const [k, d] of Object.entries(DEFAULT_LOAD_TIES)) ties[k] = tiesOf(k, s.ties?.[k] ?? (LIFE_SUPPORT.includes(k.slice(7)) ? s.ties?.['system:lifeSupport'] : undefined), designTies[k] ?? d);
  const core = s.core === 'ejected' || s.antimatter === false ? 'ejected' : s.core === 'offline' || !antimatter || !deuterium ? 'offline' : 'online';
  // The EPS manifold: energized if anything was feeding it (older saves); then it starts at full pressure.
  const epsLive = s.epsLive ?? (!cold && (s.core === 'online' || s.core === undefined || Object.values(s.drives || {}).some((x) => (typeof x === 'object' ? x?.state : x ?? 'running') === 'running')));
  const out = {
    core, antimatter, deuterium, start: 0, // a startup in progress starts over
    // Fusion reactors (older saves: drives running, throttle open, High gear, EPS taps on; aux reactors off).
    drives: Object.fromEntries(DRIVES.map((d) => {
      const v = typeof s.drives?.[d] === 'object' && s.drives[d] ? s.drives[d] : { state: s.drives?.[d] };
      const on = (v.state ?? 'running') === 'running' && deuterium > 0;
      return [d, { state: on ? 'running' : 'off', start: 0, pressure: on ? 100 : 0, epsTap: v.epsTap ?? !cold, accel: Number.isFinite(v.accel) ? Math.max(0, Math.min(100, v.accel)) : cold ? 0 : 100, gear: v.gear === 'low' || v.gear === 'high' ? v.gear : cold ? 'low' : 'high' }];
    })),
    aux: Object.fromEntries(AUX.map((a) => { const v = s.aux?.[a] || {}; const on = v.state === 'running' && deuterium > 0; return [a, { state: on ? 'running' : 'off', start: 0, pressure: on ? 100 : 0, epsTap: v.epsTap ?? false }]; })),
    // The systems' own fuel tanks (older saves: full) and each tank's tie and Fill/Drain
    // (older saves: all tied in, the main storage draining into the systems' tanks, which fill).
    tanks: Object.fromEntries(Object.entries(TANKS).map(([bus, ts]) => [bus, Object.fromEntries(Object.entries(ts).filter(([n]) => n !== 'main').map(([n]) => [n, Number.isFinite(s.tanks?.[bus]?.[n]) ? Math.min(tcap(bus, n), s.tanks[bus][n]) : cold ? 0 : tcap(bus, n)]))])),
    tankCfg: Object.fromEntries(Object.entries(TANKS).flatMap(([bus, ts]) => Object.keys(ts).map((n) => { const v = s.tankCfg?.[`${bus}:${n}`]; return [`${bus}:${n}`, v ? { tied: !!v.tied, fill: !!v.fill, drain: !!v.drain && !v.fill } : { tied: !cold, fill: !cold && n !== 'main', drain: !cold && n === 'main' }]; }))),
    busFlow: { deu: 0, am: 0 }, busDown: { deu: '', am: '' }, // what moved on each fuel bus, and why it can't (or '')
    // The other antimatter tanks' containment: field and reserve (older saves: full).
    tankContain: Object.fromEntries(Object.keys(AM_CONTAIN).map((n) => [n, { field: Number.isFinite(s.tankContain?.[n]?.field) ? s.tankContain[n].field : 100, reserve: Number.isFinite(s.tankContain?.[n]?.reserve) ? s.tankContain[n].reserve : tankContainDraw(n) * CONTAIN.reserveSecs }])),
    // The EPS manifold (energized if anything was feeding it).
    epsLive,
    // Computer cores (older saves: online; a boot in progress starts over).
    computers: COMPUTERS.map((x, i) => ({ state: (s.computers?.[i] ?? 'online') === 'online' ? 'online' : 'off', t: 0 })),
    // EPS taps: how much EPS power may flow down into each low bus (older saves: open/closed).
    taps: Object.fromEntries(BUSES.map((X) => { const t = s.taps?.[X]; return [X, typeof t === 'number' ? Math.max(0, Math.min(tapMax[X], t)) : t === false ? 0 : t === true || X !== 'C' ? tapMax[X] : 0]; })), ties,
    // (Restoring: the power paths each load had when saved, and conduits new since: see reconcileConduits.)
    restore: { paths: s.paths && typeof s.paths === 'object' ? s.paths : null, newConduits },
    fuelCaps, tankCaps, // (its design's fuel storage, and its systems' own tanks)

    transfer: null, feed: { port: 0, starboard: 0 }, fed: { port: 0, starboard: 0 }, // power offered to a ship docked at each port, and what actually went (Power row: Bus B)
    feedEps: { port: 0, starboard: 0 }, fedEps: { port: 0, starboard: 0 }, // (and the EPS row's)
    // The spore drive: its reserve, and a jump charging (lost on restart) and the cooldown.
    spores: Number.isFinite(s.spores) ? Math.max(0, Math.min(SPORE.cap, s.spores)) : cold ? 0 : SPORE.cap, spore: { charging: false, t: 0, dest: null, ready: 0, loaded: s.sporeLoaded === SPORE.jump ? SPORE.jump : 0 },
    // The shuttle bay: its doors (Ops opens them), and the bay this craft has landed in (kept across restarts).
    brigField: s.brigField ?? true, // the brig's force field (up to start)
    conduits: !!s.conduits, // (a save from before power paths: its conduits are tied where its loads are, on load)
    bridgeModes: s.bridgeModes && typeof s.bridgeModes === 'object' ? Object.fromEntries(BRIDGE_CONSOLES.filter((c) => CONSOLE_MODES.includes(s.bridgeModes[c])).map((c) => [c, s.bridgeModes[c]])) : {}, // what each bridge console runs
    bayOpen: !!s.bayOpen, landed: typeof s.landed === 'string' && s.landed ? shipKey(s.landed) : null,
    remoteBlock: !!s.remoteBlock, // ops refuse remote control by other vessels
    prefix: /^\d{5}$/.test(s.prefix) ? s.prefix : PREFIX.factory, // the command prefix (kept in .nav.json)
    // Per-panel automation (Ops picks the panels): Engineering's mode ('startup' or 'shutdown'), the others on or off.
    auto: Object.fromEntries(AUTO_PANELS.map((p) => [p, p === 'engineering' ? (['startup', 'shutdown'].includes(s.auto?.[p]) ? s.auto[p] : null) : !!s.auto?.[p]])), autoStatus: {},
    // The orders given aboard (newest first, the last ORDER_LOG): text, when, by whom, to whom, who has acknowledged.
    orderLog: Array.isArray(s.orderLog) ? s.orderLog.slice(0, ORDER_LOG).filter((o) => o && typeof o.text === 'string') : [],
    forcefields: Array.isArray(s.forcefields) ? s.forcefields.filter((st) => STATIONS.includes(st)) : [], // stations Security has isolated
    // Docked with another ship: kept across restarts (it's checked once both are back).
    // Two docking ports. A starbase takes one (docked, dockedPort); ships dock
    // to a port each side (shipDocks), each connection with its own power offer.
    shipDocks: Object.fromEntries(PORTS.map((p) => { const v = s.shipDocks?.[p] ?? (p === 'starboard' && typeof s.dockedShip === 'string' ? s.dockedShip : null); return [p, typeof v === 'string' ? shipKey(v) : null]; })),
    partnerGoneAt: { port: Date.now(), starboard: Date.now() },
    dockedPort: PORTS.includes(s.dockedPort) ? s.dockedPort : 'port',
    // Connections' Import / Export (older saves: dock power imported if it was tied in; auto refuel became import).
    conn: s.conn && typeof s.conn === 'object' ? JSON.parse(JSON.stringify(s.conn)) : { station: {
      deu: { imp: !!(typeof s.autoRefuel === 'object' ? s.autoRefuel?.deuterium : s.autoRefuel), exp: false },
      am: { imp: !!(typeof s.autoRefuel === 'object' ? s.autoRefuel?.antimatter : s.autoRefuel), exp: false },
      power: { imp: !cold, exp: false } } },
    connFlow: {},
    // The starbase connection's ties: its Import / Export reach the deuterium and antimatter buses
    // only when tied, and the ODN tie is a hard data link. Docking starts untied; a new ship
    // (cold) has only the ODN tied; older saves (and warm starts) had everything tied.
    connTies: s.connTies && typeof s.connTies === 'object' ? { deu: !!s.connTies.deu, am: !!s.connTies.am, odn: !!s.connTies.odn } : !s.conn && cold ? { deu: false, am: false, odn: true } : { deu: true, am: true, odn: true },
    // Each battery's main breaker (closed: in service). Older saves: closed if the old battery was tied in.
    breakers: Object.fromEntries(BUSES.map((X) => [X, typeof s.breakers?.[X] === 'boolean' ? s.breakers[X] : Array.isArray(s.ties?.battery) ? s.ties.battery.length > 0 : true])),
    xlBlock: Array.isArray(s.xlBlock) ? s.xlBlock.filter((d) => XL_DIRS.includes(d)) : [],
    // Each store's charge (older saves: one battery, shared out across A, B and C; the EPS starts unpressurized;
    // a new ship's bus batteries start empty, to be charged from dock power).
    stores: Object.fromEntries(Object.entries(STORES).map(([name, node]) => {
      const cap = node === 'EPS' ? GRID.epsCap : GRID.batteryCap;
      const v = s.stores?.[name] ?? (node === 'EPS' ? (epsLive ? cap : 0) : Number.isFinite(s.battery?.charge) ? s.battery.charge / 3 : cold ? 0 : cap);
      return [name, Math.max(0, Math.min(cap, Number(v) || 0))];
    })),
    docked: STARBASES.some((b) => b.name === s.docked) ? s.docked : null,
    drydock: !!s.drydock && isShipyard(s.docked), berth: [1, 2, 3].includes(s.berth) ? s.berth : 1, release: null, hold: false, // in the shipyard's drydock (kept across restarts)
    breach: 0, selfDestruct: null, towing: null, dirty: false,
    // The warp core's reaction (older saves: running at 70%, 15:1, aligned, conduits open, auto-trim on).
    wc: { rate: Number.isFinite(s.wc?.rate) ? s.wc.rate : 70, actual: s.core === 'online' || (s.core === undefined && !cold) ? (Number.isFinite(s.wc?.actual) ? s.wc.actual : 70) : 0, mix: Number.isFinite(s.wc?.mix) ? s.wc.mix : 15, align: Number.isFinite(s.wc?.align) ? s.wc.align : 100, crystal: Number.isFinite(s.wc?.crystal) ? s.wc.crystal : 100, temp: Number.isFinite(s.wc?.temp) ? s.wc.temp : 0, plasma: s.wc?.plasma ?? !cold, autoTrim: s.wc?.autoTrim ?? !cold, breachT: null },
    // Each console's ODN link (all linked to start).
    odn: Object.fromEntries([...STATIONS, OPS_STATION].map((st) => [st, st === 'Engineering' || s.odn?.[st] !== false])),
    // Life support, place by place (all on to start).
    ls: Object.fromEntries(LOCATIONS.map((l) => [l, Object.fromEntries(LS_SYSTEMS.map((x) => [x, s.ls?.[l]?.[x] !== false]))])),
    // The transporter's level-3 diagnostic (older saves: passed).
    trDiag: { state: s.trDiag === 'passed' || (s.trDiag === undefined && !cold) ? 'passed' : 'none', t: 0 },
    // Antimatter containment: the field's strength (%) and its internal reserve.
    contain: { field: Number.isFinite(s.contain?.field) ? s.contain.field : 100, reserve: Number.isFinite(s.contain?.reserve) ? Math.min(reserveCap(), s.contain.reserve) : reserveCap() },
    // The emergency batteries' charge (new ships: full; the three earlier Bus B ones, 500 each, became A, B and C at the same %).
    emerg: Object.fromEntries(EMERG.names.map((n, i) => { const v = s.emerg?.[n], old = s.emerg?.[`emerg${i + 1}`]; return [n, Number.isFinite(v) ? Math.max(0, Math.min(EMERG.cap, v)) : Number.isFinite(old) ? Math.max(0, Math.min(1, old / 500)) * EMERG.cap : EMERG.cap]; })),
  };
  // The three earlier Bus B emergency batteries: tied, they're tied to their own bus now.
  EMERG.names.forEach((n, i) => { if (!s.ties?.[n] && s.ties?.[`emerg${i + 1}`]?.length) ties[n] = [EMERG.bus[n]]; });
  // Older saves: one connection power row, on Bus B and/or the EPS. Its EPS tie
  // is now the EPS row, tied, with the same Import / Export.
  for (const [src, eps] of [['dock', 'dockEps'], ['ship', 'shipEps']]) {
    const old = s.ties?.[src];
    if (!Array.isArray(old) || !old.includes('EPS') || s.ties?.[eps]) continue;
    ties[eps] = ['EPS'];
    ties[src] = old.includes('B') ? ['B'] : [];
    for (const [key, c] of Object.entries(out.conn)) if ((key === 'station') === (src === 'dock') && c.power && !c.eps) c.eps = { ...c.power };
  }
  return out;
}
const engOf = (k) => {
  if (!eng.has(k)) {
    const kept = isBase(k) || isRelay(k) ? baseSettings[shipName(k)]?.eng : undefined; // (the relay keeps the starbases' and the relays')
    eng.set(k, { ...freshEng(kept, { k }), ...(isBase(k) ? { remoteBlock: baseSettings[shipName(k)]?.remoteBlock ?? true } : {}) });
    for (const c of CONDUITS) eng.get(k).ties[c] ||= [];
    designReactors(k, !kept); // (what its design has: its reactors, its antimatter, its wiring)
    pruneLoads(k); // (and nothing it doesn't)
    if ((isBase(k) || isRelay(k)) && !eng.get(k).conduits) deriveConduits(k);
    reconcileConduits(k);
  }
  return eng.get(k);
};
// Starbases have no ship's computer to keep their settings: the relay keeps
// them (remote control starts blocked at a starbase).
const BASE_SETTINGS_FILE = process.env.STARBASES_FILE || path.join(__dirname, 'data', 'starbases.json');
let baseSettings = {};
try { baseSettings = JSON.parse(fs.readFileSync(BASE_SETTINGS_FILE, 'utf8')); } catch {}
// (A relay the admin page disabled stays disabled.)
for (const r of RELAYS) if (baseSettings[r.name]?.relayOff) relayOff.add(shipKey(r.name));
// Starbases created from the admin panel come back.
for (const [name, sv] of Object.entries(baseSettings)) if (sv?.created && Number.isFinite(sv.nav?.x) && !STARBASES.some((b) => b.name === name)) {
  STARBASES.push({ name, x: sv.nav.x, y: sv.nav.y, created: true });
  const k = registerShip(name); BASE_KEYS.add(k); navState.set(k, { x: sv.nav.x, y: sv.nav.y, heading: 0, warp: 0, dest: null });
}
// (Their data links come back too, once the other ends are here.)
// Where each starbase was left (it can move: impulse, or a tow), and its limiters.
for (const b of STARBASES) {
  const sv = baseSettings[b.name], k = shipKey(b.name);
  if (Number.isFinite(sv?.nav?.x) && Number.isFinite(sv?.nav?.y)) setBasePos(k, sv.nav.x, sv.nav.y, sv.nav.heading);
  if (sv?.power && typeof sv.power === 'object') navState.get(k).power = { ...sv.power };
  restoreLinks(k, sv?.eng?.links);
}
function saveBaseSettings() {
  // Each starbase: its settings, its grid, its condition, where it is and its limiters.
  // Each relay: its grid (and whether it's off).
  for (const k of RELAY_KEYS) if (eng.has(k)) baseSettings[shipName(k)] = { ...baseSettings[shipName(k)], eng: savedEng(k), combat: savedCombat(k) };
  for (const k of BASE_KEYS) { const n = navState.get(k); baseSettings[shipName(k)] = { ...(STARBASES.find((b) => shipKey(b.name) === k)?.created ? { created: true } : {}), remoteBlock: !!engOf(k).remoteBlock, eng: savedEng(k), combat: savedCombat(k), nav: n ? { x: n.x, y: n.y, heading: n.heading } : undefined, power: n?.power }; }
  try { fs.mkdirSync(path.dirname(BASE_SETTINGS_FILE), { recursive: true }); fs.writeFileSync(BASE_SETTINGS_FILE, JSON.stringify(baseSettings, null, 2)); } catch (err) { console.warn(`could not save starbase settings: ${err.message}`); }
}
// A design without a warp core, or without fusion reactors (a pure-solar one): none aboard.
// (fresh: a new grid, its reactor ties cleared too.)
function designReactors(k, fresh = false) {
  const d = designOf(k), e = eng.get(k);
  if (!e) return;
  if (d.warpCore === false) Object.assign(e, { core: 'ejected', antimatter: 0 });
  if (d.fusion === false) {
    for (const x of DRIVES) Object.assign(e.drives[x], { state: 'off', pressure: 0, epsTap: false });
    for (const x of AUX) Object.assign(e.aux[x], { state: 'off', pressure: 0, epsTap: false });
    if (fresh) for (const x of ['impulsePort', 'impulseStarboard', 'aux1', 'aux2', 'core']) if (e.ties[x]) e.ties[x] = [];
  }
  // (A design that carries no antimatter (its file's "antimatter": false): nothing to contain, nothing to breach.)
  if (d.antimatter === false) { for (const n of Object.keys(e.tanks.am)) e.tanks.am[n] = 0; e.antimatter = 0; e.breach = 0; }
  // (A design wired by its places ("wiring": "places", the relay's): a new grid ties only what its
  // places hold, and its own consoles.)
  if (fresh && d.wiring === 'places') {
    const rows = new Set((d.places || []).flatMap((p) => p.rows || [])), here = new Set(designStations(k) || []);
    for (const x of Object.keys(e.ties)) if ((/^(system|sub):/.test(x) && !CONDUITS.includes(x) && !rows.has(x)) || (x.startsWith('console:') && !here.has(x.slice(8)))) e.ties[x] = [];
  }
}
const savedEng = (k) => {
  const e = engOf(k);
  return {
    core: e.core === 'starting' ? 'offline' : e.core,
    drives: Object.fromEntries(DRIVES.map((d) => { const dr = e.drives[d]; return [d, { state: dr.state === 'running' ? 'running' : 'off', epsTap: dr.epsTap, accel: dr.accel, gear: dr.gear }]; })),
    aux: Object.fromEntries(AUX.map((a) => [a, { state: e.aux[a].state === 'running' ? 'running' : 'off', epsTap: e.aux[a].epsTap }])),
    tanks: e.tanks, tankCfg: e.tankCfg, tankContain: e.tankContain, epsLive: e.epsLive, ls: e.ls, odn: e.odn, trDiag: e.trDiag.state === 'passed' ? 'passed' : 'none', contain: { field: Math.round(e.contain.field), reserve: Math.round(e.contain.reserve) },
    wc: { rate: e.wc.rate, actual: Math.round(e.wc.actual), mix: e.wc.mix, align: Math.round(e.wc.align * 10) / 10, crystal: Math.round(e.wc.crystal * 10) / 10, temp: Math.round(e.wc.temp), plasma: e.wc.plasma, autoTrim: e.wc.autoTrim },
    antimatter: round1(e.antimatter), deuterium: round1(e.deuterium), taps: e.taps, ties: e.ties, forcefields: e.forcefields, remoteBlock: !!e.remoteBlock, stores: Object.fromEntries(Object.entries(e.stores).map(([x, v]) => [x, Math.round(v)])), breakers: e.breakers, xlBlock: e.xlBlock || [], computers: e.computers.map((x) => (x.state === 'online' ? 'online' : 'off')), docked: e.docked,
    // (Each load's power path, as the design had it: a design change is noticed on the next load.)
    paths: Object.fromEntries(Object.keys(e.ties).filter((x) => /^(console|system|sub):/.test(x) && !CONDUITS.includes(x)).map((x) => [x, conduitsOf(k, x).join('>')])),
    dockedPort: e.dockedPort, conn: e.conn, connTies: e.connTies, spores: Math.round(e.spores * 100) / 100, sporeLoaded: e.spore?.loaded || 0, brigField: !!e.brigField, conduits: !!e.conduits, bridgeModes: e.bridgeModes, prefix: e.prefix, auto: e.auto, orderLog: e.orderLog,
    // Its open data links over subspace (hard links come back by themselves while docked and tied).
    links: linkedTo(k).filter((o) => !hardLinks.has(linkKey(k, o))).map(shipName), drydock: !!e.drydock, berth: e.berth, bayOpen: !!e.bayOpen, landed: e.landed ? shipName(e.landed) : null, emerg: Object.fromEntries(EMERG.names.map((n) => [n, Math.round(e.emerg[n])])),
    shipDocks: Object.fromEntries(PORTS.map((p) => [p, e.shipDocks[p] ? shipName(e.shipDocks[p]) : null])),
  };
};
const towedBy = (k) => [...eng].find(([, e]) => e.towing === k)?.[0] || null;
// A subsystem works when it has its power and isn't badly damaged.
const SUB_FAIL_DAMAGE = 50;

// Where each ship's power goes, worked out fresh (cached briefly: it's asked a lot).
// What a system is using right now, in % of its rating (the limiter caps it):
// the transporter by what it's doing; weapons while armed (all they're allowed
// while the banks charge, a trickle to hold them full); shields while up or
// recharging; the warp drive and its injectors by the warp they're making;
// the deflector while moving; sensors sweep as far as they're allowed; the
// rest (life support, hull fields, replicators, recreation) run steadily at their rating.
function usageOf(k, s, c) {
  const w = navState.get(k)?.warp || 0;
  if (isBase(k) ? WARP_DRIVE.includes(s) : BASE_ONLY.includes(s)) return 0;
  if (s === 'spore') return !isBase(k) && classOf(k).spore && engOf(k).spore?.charging ? POWER_MAX : 0; // (only while it charges for a jump)
  if (s === 'sporeGrow') return !isBase(k) && classOf(k).spore && engOf(k).spores < SPORE.cap ? POWER_MAX : 0; // (while there's room to grow)
  if (!isBase(k) && ((s === 'phaser2' && arraysOf(k) < 2) || (s === 'transporter' && !classOf(k).transporter) || (WARP_DRIVE.includes(s) && !classOf(k).maxWarp))) return 0; // (not aboard this class)
  switch (s) {
    case 'drydock1': case 'drydock2': case 'drydock3': return berthShip(k, Number(s.slice(7))) ? 100 : 0; // while a ship is in that berth
    case 'industrial': return 100; // at its limiter (the light bar)
    case 'transporter': return transporterDraw(k);
    case 'weapons': return c.armed ? 10 : 0; // the torpedo tubes, ready while armed
    case 'phaser1': case 'phaser2': case 'phaser3': case 'phaser4': { const i = Number(s.slice(6)) - 1; return !c.armed || i >= arraysOf(k) ? 0 : (c.arrays?.[i] ?? 0) < 100 ? POWER_MAX : 10; } // charging: all it may; charged: a trickle
    case 'shields': return shields.has(k) || c.shield < 100 ? POWER_MAX : 0;
    case 'engines': case 'injectors': return w >= 1 ? (w / 9) * 100 : 0;
    case 'deflector': return w >= 1 ? 100 : w > 0 ? 50 : 0;
    case 'bussard': return w >= 1 ? 100 : 0; // collecting only at warp
    case 'amBus': return 100; // all the time it's tied, antimatter moving or not
    case 'sensors': case 'lateral': return POWER_MAX;
    case 'atmosphere': case 'thermal': case 'gravity': case 'lights': return 100 * lsShare(k, s); // for the places it's on in
    default: return 100;
  }
}
// What a system could draw if it needed to (its limiter, less damage), for
// the checks made before it's in use: raising shields, going to warp.
const capacityOf = (k) => flow(k).capacity;
const flowCache = new Map();
function flow(k) {
  const cached = flowCache.get(k);
  if (cached && Date.now() - cached.at < 200) return cached.f;
  const e = engOf(k), c = combatOf(k), a = allocOf(k);
  const demand = {};
  // Damage takes the same share off what a system can draw, overdrive included.
  // A system draws what it's using right now (usageOf), capped by its limiter
  // and by damage: at 0 it draws nothing, idle it draws little or nothing.
  const capacity = {};
  for (const s of SYSTEMS) { capacity[s] = Math.min(a[s], Math.max(0, (POWER_MAX * (100 - (c.damage[s] || 0))) / 100)); demand[s] = Math.min(capacity[s], usageOf(k, s, c)); }
  // A ship docked with us: each side offers power (feed); whoever offers more
  // sends the difference, drawn from (or, received, fed into) the docked-ship ties.
  // Each connection on its own: per port, whoever offers more sends the difference.
  // Each ship connection: power goes from the side exporting to the side importing.
  // (Two rows each: Power, Bus B to Bus B, and EPS, EPS to EPS.)
  const conns = partners(k).map(([p, o]) => {
    const theirs = slotFor(o, k);
    const row = (res) => { const me = connOf(e, o)[res], them = connOf(engOf(o), k)[res]; return (me.exp && them.imp ? SHIP_FEED_MAX : 0) - (them.exp && me.imp ? SHIP_FEED_MAX : 0); };
    const net = row('power'), netEps = row('eps');
    e.feed[p] = Math.max(0, net); e.feedEps[p] = Math.max(0, netEps);
    return { p, o, net, netEps, theirFed: engOf(o).fed[theirs] || 0, theirFedEps: engOf(o).fedEps?.[theirs] || 0 };
  });
  // Each running drive gives half impulse. With its thrusters tied in to the
  // EPS, whatever share of it isn't thrusting feeds the EPS; untied, it only thrusts.
  const nv = navState.get(k);
  const running = DRIVES.filter((d) => e.drives[d].state === 'running' && e.deuterium > 0);
  const impulseNow = nv && nv.warp > 0 && nv.warp < 1 ? nv.warp : 0;
  const thrustTop = running.reduce((n, d) => n + driveTop(e.drives[d]), 0);
  const share = thrustTop > 0 ? Math.min(1, impulseNow / thrustTop) : 0;
  const driveGen = (d) => (running.includes(d) && (e.ties[`thrusters${d[0].toUpperCase()}${d.slice(1)}`] || []).length ? GRID.impulse * (1 - share) : 0);
  const cap = { ship: conns.reduce((n, cn) => n + (cn.net < 0 ? Math.min(-cn.net, cn.theirFed) : 0), 0), shipEps: conns.reduce((n, cn) => n + (cn.netEps < 0 ? Math.min(-cn.netEps, cn.theirFedEps) : 0), 0), solar: designOf(k).solar?.output ?? 0,
    dock: e.docked && connOf(e, 'station').power.imp ? GRID.dock : 0, dockEps: e.docked && connOf(e, 'station').eps.imp ? GRID.dock : 0,
    ...Object.fromEntries(EMERG.names.map((n) => [n, Math.min(EMERG.out, e.emerg[n])])), impulsePort: driveGen('port'), impulseStarboard: driveGen('starboard'), ...Object.fromEntries(AUX.map((a) => [a, e.aux[a].state === 'running' && e.deuterium > 0 ? FUSION.aux : 0])), core: (c.damage.conduits || 0) < SUB_FAIL_DAMAGE ? coreOutput(e) * (isBase(k) ? 1 : classOf(k).core) : 0, ...Object.fromEntries(Object.entries(STORES).map(([name, node]) => [name, Math.min(node === 'EPS' ? GRID.epsOut : GRID.batteryOut, e.stores[name])])) };
  // A source tied to several buses shares its output evenly between them.
  const srcs = SOURCES.map((name) => {
    const t = isStore(name) ? (STORES[name] === 'EPS' || e.breakers[STORES[name]] ? [STORES[name]] : []) : e.ties[name], full = t.length ? cap[name] : 0;
    return { name, ties: t, left: full, share: t.length > 1 ? Object.fromEntries(t.map((n) => [n, full / t.length])) : null };
  });
  const buses = Object.fromEntries(BUSES.map((X) => [X, { need: 0, have: 0, src: {}, tapUsed: 0 }]));
  let viaEps = 0;
  const blank = () => Object.fromEntries(NODES.map((n) => [n, 0]));
  const cells = Object.fromEntries([...SOURCES, 'containment', 'feed'].map((n) => [n, blank()]));
  // Draw up to amt for a node: from sources tied straight to it, then (for a
  // bus with its tap open) from sources tied to the EPS. Batteries go last.
  // A node never carries more than its BUS_MAX.
  // Crosslinked buses are one pool: each draws on what's tied to the others,
  // through their taps too, and they share one max (the sum of theirs).
  // The EPS taps are worked by the flow regulators: no computer core online, no taps.
  const coresUp = e.computers.some((x) => x.state === 'online');
  const taps = Object.fromEntries(BUSES.map((X) => [X, coresUp ? e.taps[X] : 0]));
  const poolOf = Object.fromEntries(BUSES.map((X) => [X, new Set([X])]));
  if (e.ties.crosslink.length >= 2) { const m = new Set(e.ties.crosslink); for (const y of m) poolOf[y] = m; }
  const pool = (X) => [...poolOf[X]];
  // (A one-way tie: power only crosses the way it's open. A to C goes through B, both legs.)
  const xlBlocked = new Set(e.xlBlock || []);
  const xlOk = (f, t) => f === t || ([f, t].sort().join('') === 'AC' ? !xlBlocked.has(`${f}>B`) && !xlBlocked.has(`B>${t}`) : !xlBlocked.has(`${f}>${t}`));
  // A damaged bus carries less: its max scales with its condition.
  const busMax = busMaxOf(k);
  const maxOf = (X) => busMax[X] * Math.max(0, 1 - (c.damage[`bus${X}`] || 0) / 100);
  const busRoom = (node) => pool(node).reduce((n, X) => n + maxOf(X) - buses[X].have, 0);
  const tapRoom = (node) => pool(node).reduce((n, X) => n + Math.max(0, taps[X] - buses[X].tapUsed), 0);
  // Power moving between crosslinked buses, per pair: 'AB' > 0 is A to B, < 0 is B to A.
  const crossflow = {};
  const xflow = (from, to, t) => {
    if (from === to || t <= 0) return;
    if ([from, to].sort().join('') === 'AC') { xflow(from, 'B', t); xflow('B', to, t); return; } // A to C goes through B
    const k = [from, to].sort().join(''); crossflow[k] = (crossflow[k] || 0) + (from < to ? t : -t);
  };
  let storesOk = false; // the stores (batteries, EPS pressure) only once every other source has been shared out
  const take = (node, amt, topUp = false) => {
    let got = 0;
    const bus = buses[node];
    const pull = (s, eps, side = node) => {
      if (eps && !e.epsLive) return; // the EPS manifold isn't pressurized: it carries nothing yet
      if (bus && !eps && side !== node && !xlOk(side, node)) return; // (the crosslink one way, the other)
      const room = Math.min(bus ? busRoom(node) - got : Infinity, eps ? maxOf('EPS') - viaEps : Infinity, bus && eps ? tapRoom(node) : Infinity);
      const t = Math.min(s.left, amt - got, room, s.share && !eps ? s.share[side] : Infinity);
      if (t <= 0) return;
      s.left -= t; got += t;
      if (s.share && !eps) s.share[side] -= t;
      cells[s.name][eps ? 'EPS' : side] += t;
      if (eps) viaEps += t;
      if (bus && !eps) xflow(side, node, t); // from a crosslinked bus's source
      if (bus && eps) { let rest = t; for (const X of [node, ...pool(node).filter((y) => y !== node && xlOk(y, node))]) { const u = Math.min(rest, Math.max(0, taps[X] - buses[X].tapUsed)); buses[X].tapUsed += u; rest -= u; xflow(X, node, u); } }
      if (bus) bus.src[s.name] = (bus.src[s.name] || 0) + t;
    };
    const sides = bus ? pool(node) : [node];
    for (const last of storesOk ? [false, true] : [false]) { // batteries only when nothing else will do
      for (const side of sides) for (const s of srcs) if (lastResort(s.name) === last && s.ties.includes(side)) pull(s, node === 'EPS', side);
      if (bus) for (const s of srcs) if (lastResort(s.name) === last && s.ties.includes('EPS')) pull(s, true);
    }
    if (bus) { if (!topUp) bus.need += amt; bus.have += got; }
    return got;
  };
  // What's tied to each node, for the breakers (a split load counts its share on each).
  const tied = blank();
  const trippable = [];
  // Breakers watch sustained load: startup surges don't count.
  const reactorStarting = (key) => { const m = /^sub:(port|starboard|aux\d)(Chamber)$/.exec(key); return m && reactorsOf(e).find(([r]) => r === m[1])[1].state === 'starting'; };
  const sustained = (key, amt) => (key === 'sub:constriction' && e.core === 'starting' ? GRID.constriction.run : reactorStarting(key) ? 0 : amt);
  // Power for a docked ship goes out the way it comes in.
  const tiesFor = (key) => effTies(k, e, feedTie(key));
  // A load tied to several buses is split evenly across them (each bus
  // serves its share); its cell row records where its power came from.
  // topUp: a second go at what a load is still short, once each source's even
  // split is lifted (its share a tied bus didn't use goes to the others).
  const serve = (key, amt, topUp = false) => {
    const row = cells[key] || (cells[key] = blank());
    const ties = tiesFor(key);
    if (!ties.length || amt <= 0) return 0;
    let got = 0;
    if (topUp) { for (const n of ties) { const t = take(n, amt - got, true); row[n] += t; got += t; } return got; }
    const part = amt / ties.length, counted = sustained(key, amt) / ties.length;
    for (const n of ties) {
      if (counted > 0) { tied[n] += counted; if (!NEVER_TRIP.has(key)) trippable.push({ key, node: n, amt: counted }); }
      const t = take(n, part); row[n] += t; got += t;
    }
    return got;
  };
  // Antimatter containment first, ahead of everything: from its feeds in turn.
  let contained = 0;
  if (e.antimatter > 0) {
    const row = cells.containment;
    // Its 20, and recharging its internal reserve when that's down.
    const want = GRID.containment + (e.contain.reserve < reserveCap() ? CONTAIN.recharge : 0);
    for (const n of e.ties.containment) { tied[n] += want / e.ties.containment.length; if (contained < want) { const t = take(n, want - contained); row[n] += t; contained += t; } }
    // Short: the stores hold it (containment comes ahead of everything).
    storesOk = true;
    for (const n of e.ties.containment) if (contained < want) { const t = take(n, want - contained, true); row[n] += t; contained += t; }
    storesOk = false;
  }
  const containmentOk = e.antimatter <= 0 || contained >= GRID.containment;
  const containFeed = contained; // (the tick shares it between the field and the reserve)
  // The other antimatter tanks' containment, next: from their own ties (the stores if short).
  const tankFeed = {};
  for (const [name, key] of Object.entries(AM_CONTAIN)) {
    tankFeed[name] = 0;
    if (!(e.tanks.am[name] > 0)) continue;
    const draw = tankContainDraw(name), want = draw * (e.tankContain[name].reserve < draw * CONTAIN.reserveSecs ? 1.25 : 1);
    const row = cells[key] || (cells[key] = blank()), ts = e.ties[key] || [];
    for (const n of ts) { tied[n] += want / ts.length; if (tankFeed[name] < want) { const t = take(n, want - tankFeed[name]); row[n] += t; tankFeed[name] += t; } }
    storesOk = true;
    for (const n of ts) if (tankFeed[name] < want) { const t = take(n, want - tankFeed[name], true); row[n] += t; tankFeed[name] += t; }
    storesOk = false;
  }
  // Every other load, in priority order: the reactors' subsystems, consoles,
  // Communications, power for a docked ship, then the systems.
  const coreOn = e.core === 'online' || e.core === 'starting';
  const crew = crewOf(k);
  const loads = [
    ['sub:constriction', !coreOn ? 0 : e.core === 'starting' ? GRID.constriction.start : GRID.constriction.run],
    ['sub:injector', coreOn ? GRID.injector : 0], ['sub:amConduit', coreOn ? 5 : 0],
    // A reactor's chamber: on the buses while it lights, and while it runs
    // unless its EPS tap has it powering itself from the (energized) EPS.
    ...reactorsOf(e).map(([r, x]) => [`sub:${r}Chamber`, x.state === 'starting' ? FUSION.chamberStart : x.state === 'running' && !(x.epsTap && e.epsLive) ? FUSION.chamberRun : 0]),
    ...Object.keys(CONSOLE_BUS).map((st) => [`console:${st}`, crew.filter((u) => placeOf(u) === st).length * GRID.console]),
    ...['rf', 'radio', 'subspace'].map((x) => [`sub:${x}`, GRID.comms]),
    ['sub:forcefields', (e.forcefields.length + crew.filter((u) => u.fielded).length) * GRID.forcefield],
    ['sub:brigField', e.brigField && hasStation(k, 'Brig') ? GRID.forcefield : 0],
    ['sub:holoEmitters', !isBase(k) && e.auto?.medical ? EMH.draw : 0],
    ['sub:bayDoors', e.bayOpen ? BAY.doors : 0], ['sub:bayField', e.bayOpen ? BAY.field : 0],
    ['sub:patternBuffers', TR.buffers], ['sub:targetingScanners', TR.small], ['sub:heisenberg', TR.small], ['sub:biofilter', TR.small],
    ['sub:energizingCoils', transporters.get(k)?.energizing ? TR.coils : 0],
    ...COMPUTERS.map((x, i) => [`sub:${x}`, ['booting', 'online'].includes(e.computers[i].state) ? COMPUTER.draw : 0]),
    ...conns.flatMap((cn) => [[`feed:${cn.p}`, Math.max(0, cn.net)], [`feedEps:${cn.p}`, Math.max(0, cn.netEps)]]),
    // The fuel buses' transfer power: the deuterium bus's while it moves deuterium, the antimatter bus's always.
    ['sub:deuTransfer', e.busFlow.deu > 0 ? FUELBUS.transfer : 0], ['sub:amTransfer', FUELBUS.transfer],
    // Power exported to the starbase (it takes all it's given): last of all, below.
    ...SYSTEM_PRIORITY.map((sys) => [`system:${sys}`, sys === 'tractor' ? (e.towing ? TRACTOR.draw : 0) : (demand[sys] * ratingOf(sys)) / 100]),
    ['feed:station', e.docked && connOf(e, 'station').power.exp && !connOf(e, 'station').power.imp ? 100 : 0],
    ['feedEps:station', e.docked && connOf(e, 'station').eps.exp && !connOf(e, 'station').eps.imp ? 100 : 0],
  ];
  // Each bus serves the loads tied to it alone first (priority order), then
  // its batteries charge, then loads split over two buses, then over three.
  const got = {};
  const usedOf = (name) => { const src = srcs.find((x) => x.name === name); return src.ties.length ? cap[name] - src.left : 0; };
  const charging = blank();
  // split: whether sources tied to several buses may charge it yet (only
  // once their unused shares have gone to the buses still short).
  const chargeFrom = (X, split) => {
    const store = storeOf(X);
    if (!e.breakers[X] || usedOf(store) > 0) return; // breaker open, or covering a shortfall: not charging
    const room = Math.min(GRID.batteryCharge, GRID.batteryCap - e.stores[store]);
    for (const x of srcs) {
      if (lastResort(x.name) || charging[X] >= room || (!split && x.ties.length > 1) || (!e.epsLive && x.ties.includes('EPS'))) continue;
      const sides = pool(X);
      const direct = sides.some((y) => x.ties.includes(y));
      if (!(direct || (tapRoom(X) > 0 && x.ties.includes('EPS')))) continue;
      const via = sides.find((y) => x.ties.includes(y));
      const t = Math.min(x.left, room - charging[X], busRoom(X), direct ? (x.share ? x.share[via] : Infinity) : tapRoom(X));
      if (t <= 0) continue;
      x.left -= t; charging[X] += t;
      if (direct && x.share) x.share[via] -= t;
      buses[X].need += t; buses[X].have += t;
      if (direct) xflow(via, X, t);
      if (!direct) { viaEps += t; let rest = t; for (const y of sides) { const u = Math.min(rest, Math.max(0, taps[y] - buses[y].tapUsed)); buses[y].tapUsed += u; rest -= u; xflow(y, X, u); } }
      cells[store][X] -= t; // shown as a draw on the store's row
      cells[x.name][direct ? via : 'EPS'] += t; // and as what the source gave
    }
  };
  const order = [];
  for (const X of NODES) {
    for (const l of loads) if (tiesFor(l[0]).length === 1 && tiesFor(l[0])[0] === X) { order.push(l); got[l[0]] = serve(...l); }
    if (X !== 'EPS') chargeFrom(X, false);
  }
  for (const n of [2, 3]) for (const l of loads) if (tiesFor(l[0]).length === n) { order.push(l); got[l[0]] = serve(...l); }
  // A source tied to several buses splits evenly, but a share one bus can't
  // use goes to the others that are still short; only then is it surplus,
  // and charges the batteries.
  for (const x of srcs) x.share = null;
  for (const [key, amt] of order) if ((got[key] || 0) < amt - 1e-9) got[key] += serve(key, amt - (got[key] || 0), true);
  // Then the stores cover what's still short, last of all.
  storesOk = true;
  for (const [key, amt] of order) if ((got[key] || 0) < amt - 1e-9) got[key] += serve(key, amt - (got[key] || 0), true);
  for (const X of BUSES) chargeFrom(X, true);
  // The EPS manifold's pressure: what's left of the EPS sources' output builds it up.
  const epsGen = srcs.filter((x) => !lastResort(x.name) && x.ties.includes('EPS')).reduce((n, x) => n + (cap[x.name] || 0), 0);
  if (usedOf('pressure') <= 0 && (e.epsLive || epsGen >= EPS_CHARGE_GEN)) {
    const room = Math.min(GRID.epsCharge, GRID.epsCap - e.stores.pressure, maxOf('EPS') - viaEps);
    for (const x of srcs) {
      if (lastResort(x.name) || !x.ties.includes('EPS') || charging.EPS >= room) continue;
      const t = Math.min(x.left, room - charging.EPS);
      if (t <= 0) continue;
      x.left -= t; charging.EPS += t; viaEps += t;
      cells.pressure.EPS -= t; cells[x.name].EPS += t;
    }
  }
  // The stores as one row: + covering a shortfall, − charging.
  cells.stores = blank();
  for (const [name, node] of Object.entries(STORES)) { cells.stores[node] += cells[name][node]; delete cells[name]; }
  const amtOf = Object.fromEntries(loads);
  const full = (key) => (got[key] || 0) >= amtOf[key] - 1e-9;
  const subOk = {};
  for (const name of Object.keys(SUBSYSTEMS)) subOk[name] = full(`sub:${name}`) && (c.damage[name] || 0) < SUB_FAIL_DAMAGE;
  const coreSubsOk = ['constriction', 'injector', 'amConduit'].every((x) => subOk[x]);
  const consoleOk = Object.fromEntries(Object.keys(CONSOLE_BUS).map((st) => [st, full(`console:${st}`)]));
  const slots = [...new Set([...PORTS, ...conns.map((cn) => cn.p)])];
  const fed = slots.reduce((n, p) => n + (got[`feed:${p}`] || 0) + (got[`feedEps:${p}`] || 0), 0);
  for (const p of slots) { e.fed[p] = got[`feed:${p}`] || 0; e.fedEps[p] = got[`feedEps:${p}`] || 0; }
  // Power down the EPS taps: out of the EPS column, into each bus's (so every column balances).
  cells.taps = blank();
  for (const X of BUSES) { cells.taps[X] = buses[X].tapUsed; cells.taps.EPS -= buses[X].tapUsed; }
  cells.feed = blank();
  for (const p of slots) for (const n of NODES) cells.feed[n] += (cells[`feed:${p}`]?.[n] || 0) + (cells[`feedEps:${p}`]?.[n] || 0);
  const delivered = Object.fromEntries(SYSTEMS.map((sys) => [sys, ((got[`system:${sys}`] || 0) * 100) / ratingOf(sys)]));
  const tractorOk = !e.towing || full('system:tractor');
  for (const X of BUSES) {
    const sys = SYSTEMS.filter((x) => effTies(k, e, `system:${x}`).includes(X));
    const want = sys.reduce((n, x) => n + demand[x], 0);
    Object.assign(buses[X], { consolesOk: Object.keys(CONSOLE_BUS).every((st) => !effTies(k, e, `console:${st}`).includes(X) || consoleOk[st]), fraction: want ? Math.min(1, sys.reduce((n, x) => n + delivered[x], 0) / want) : 1 });
  }
  const used = Object.fromEntries(Object.entries(STORES).map(([name, node]) => [node, usedOf(name)]));
  const drawn = SOURCES.reduce((n, name, i) => n + ((srcs[i].ties.length ? cap[name] : 0) - srcs[i].left), 0); // charging included
  // Impulse: half impulse for each running drive.
  const thrusting = thrustTop; // the impulse the running drives can give, by throttle and gear
  // The grid table's footer: per bus (and the EPS), power used, available and the most it carries.
  const epsLeft = srcs.filter((x) => x.ties.includes('EPS')).reduce((m, x) => m + x.left, 0);
  const totals = Object.fromEntries(NODES.map((n) => {
    const cond = Math.round(100 - (c.damage[`bus${n}`] || 0));
    if (n === 'EPS') return [n, { used: ceilUp(viaEps), available: ceilUp(Math.min(maxOf('EPS'), viaEps + epsLeft)), max: Math.round(maxOf('EPS')), fullMax: busMax.EPS, condition: cond, tied: Math.round(tied.EPS) }];
    const direct = srcs.filter((x) => pool(n).some((y) => x.ties.includes(y))).reduce((m, x) => m + x.left, 0);
    const have = buses[n].have;
    return [n, { used: ceilUp(have), available: ceilUp(Math.min(maxOf(n), have + direct + Math.min(epsLeft, tapRoom(n)))), max: Math.round(maxOf(n)), fullMax: busMax[n], condition: cond, tied: Math.round(tied[n]), tap: e.taps[n], pool: pool(n).join('') }];
  }));
  // The fuel buses' transfer power: the antimatter bus's when it's getting its 5; the
  // deuterium bus's (which draws only while moving) when it is, or there's room for it on a tied bus.
  const xt = (name) => e.ties[`sub:${name}`] || [];
  const xferOk = {
    deu: xt('deuTransfer').length > 0 && subOk.deuTransfer && (amtOf['sub:deuTransfer'] > 0 || xt('deuTransfer').some((n) => totals[n].available - totals[n].used >= FUELBUS.transfer)),
    am: xt('amTransfer').length > 0 && subOk.amTransfer,
  };
  const emergUsed = Object.fromEntries(EMERG.names.map((n) => [n, usedOf(n)]));
  const f = {
    cells, totals, buses, xferOk, emergUsed, consoleOk, demand, capacity, delivered, containmentOk, containFeed, tankFeed, coreSubsOk, subOk, tractorOk, tied, trippable, thrusting,
    crossflow, storeUsed: used, coreUsed: usedOf('core'), impulseUsed: usedOf('impulsePort') + usedOf('impulseStarboard'), charging, drawn, viaEps, epsGen, srcCap: cap,
  };
  flowCache.set(k, { at: Date.now(), f });
  return f;
}
const gridChanged = (k) => { flowCache.delete(k); scheduleNav(); };
// Power out to the starbase or a docked ship goes the way it comes in: its tie is that connection row's.
const feedTie = (key) => ({ 'feed:station': 'dock', 'feedEps:station': 'dockEps' })[key] || (key.startsWith('feedEps:') ? 'shipEps' : key.startsWith('feed:') ? 'ship' : key);
// A console with no power on its bus is dark (ops and Engineering's grid controls aside).
// A station Security has isolated with a force field (while the emitters have
// power): nobody walks in or out (the Station menu, across a dock); whoever
// is inside keeps using its console. Transporters get through.
const sealed = (k, station) => (engOf(k).forcefields.includes(station) && flow(k).subOk.forcefields !== false) || (station === 'Brig' && brigSealed(k));
// The brig: sealed while its force field is up and powered.
// Someone held by a personal force field (it needs the emitters' power).
const held = (u) => !!u.fielded && !u.operator && flow(u.shipKey).subOk.forcefields !== false;
const brigSealed = (k) => !!engOf(k).brigField && hasStation(k, 'Brig') && flow(k).subOk.brigField !== false;
const consoleDark = (ws) => { flowCache.delete(ws.shipKey); return flow(ws.shipKey).consoleOk[placeOf(ws)] === false; }; // fresh: who's aboard may have just changed
const darkNote = (ws) => send(ws, { type: 'notice', text: `${ws.station}: console offline, no power on its bus` });
// Communications' subsystems: local RF (calls aboard), radio (hails, calls
// between ships), subspace relay (data links). Starbases always have them.
const commsUp = (k, name) => isBase(k) || !present(k) || flow(k).subOk[name] !== false;

// A node's breaker: more load tied to it than it carries trips loads off it
// at random (untied) until it fits. Engineering re-ties them.
function tripBreakers(k) {
  const e = engOf(k);
  for (let i = 0; i < 20; i++) {
    flowCache.delete(k);
    const f = flow(k);
    // A crosslinked pool trips as one: its load against the sum of its maxes.
    const poolOf = (n) => (n === 'EPS' ? ['EPS'] : (f.totals[n].pool || n).split(''));
    const over = NODES.find((n) => { const p = poolOf(n); return p.reduce((m, x) => m + f.tied[x], 0) > p.reduce((m, x) => m + f.totals[x].max, 0) && f.trippable.some((t) => p.includes(t.node)); });
    if (!over) return;
    const pick = f.trippable.filter((t) => poolOf(over).includes(t.node));
    const t = pick[Math.floor(Math.random() * pick.length)];
    // (Power going out to the starbase or a docked ship is untied at its own tie: dock, or ship.)
    const tieKey = feedTie(t.key);
    e.ties[tieKey] = (e.ties[tieKey] || []).filter((n) => n !== over);
    (e.tripped ||= {})[tieKey] = true; // shown as Tripped until Engineering re-ties it
    e.dirty = true;
    const name = t.key.startsWith('console:') ? `${t.key.slice(8)} console` : t.key.startsWith('sub:') ? SUBSYSTEMS[t.key.slice(4)].name : /^feed(Eps)?:/.test(t.key) ? `${t.key.startsWith('feedEps') ? 'EPS power' : 'power'} out to ${t.key.endsWith(':station') ? 'the starbase' : 'a docked ship'}` : t.key.startsWith('contain:') ? 'antimatter tank containment' : SYSTEM_NAMES[t.key.slice(7)] || t.key;
    const p = poolOf(over);
    const where = over === 'EPS' ? 'the EPS' : `Bus ${p.join('+')}`;
    const load = Math.round(p.reduce((m, x) => m + f.tied[x], 0)), max = p.reduce((m, x) => m + f.totals[x].max, 0);
    opLog(k, `breaker tripped on ${where} (${load} tied, ${max} max): ${name} untied`);
    for (const u of crewOf(k)) if (u.station === 'Engineering' || u.station === 'Captain') send(u, { type: 'notice', text: `Engineering: breaker tripped on ${where} (${load} of ${max}): ${name} untied` });
  }
}

// Another ship close enough to dock with (both stopped).
function nearShip(k) {
  const n = navState.get(k);
  if (!n || isBase(k)) return null;
  const o = [...cores.keys()].find((o) => o !== k && !isBase(o) && navState.has(o) && distance(k, o) <= DOCK_RANGE);
  return o ? shipName(o) : null;
}

// What each power source is made of, as damage counts (combat, overdrive): Distribution shows a
// source DAMAGED while any of it is. The EPS tap into a bus: the EPS; a bus's battery: its bus.
const SRC_DAMAGE = { core: ['conduits', 'constriction', 'injector', 'amConduit'], impulsePort: ['portChamber'], impulseStarboard: ['starboardChamber'], aux1: ['aux1Chamber'], aux2: ['aux2Chamber'],
  'tap:A': ['busEPS'], 'tap:B': ['busEPS'], 'tap:C': ['busEPS'], 'battery:A': ['busA'], 'battery:B': ['busB'], 'battery:C': ['busC'], 'battery:EPS': ['busEPS'] };
function gridView(k) {
  const e = engOf(k), f = flow(k);
  const near = isBase(k) ? null : STARBASES.find((b) => navState.has(k) && Math.hypot(navState.get(k).x - b.x, navState.get(k).y - b.y) <= DOCK_RANGE);
  const tower = towedBy(k);
  // Shown rounded up (a split load, 8.33..., shows as 9); the sums behind them aren't.
  const r = (o) => Object.fromEntries(Object.entries(o).map(([x, v]) => [x, ceilUp(v)]));
  return {
    core: e.core, antimatter: Math.floor(e.antimatter), deuterium: Math.floor(e.deuterium), fuelCaps: e.fuelCaps || { antimatter: FUEL.antimatter, deuterium: FUEL.deuterium },
    drives: Object.fromEntries(DRIVES.map((d) => { const dr = e.drives[d]; return [d, { state: dr.state, start: dr.start, thrusters: !!(e.ties[`thrusters${d[0].toUpperCase()}${d.slice(1)}`] || []).length, epsTap: dr.epsTap, accel: dr.accel, gear: dr.gear, top: Math.round(driveTop(dr) * 1000) / 1000 }]; })),
    aux: Object.fromEntries(AUX.map((a) => [a, { state: e.aux[a].state, start: e.aux[a].start, epsTap: e.aux[a].epsTap }])), auxOutput: FUSION.aux,
    // Each place: what's switched on, what it's actually getting, and whether it's lit.
    ls: (() => {
      // Served: the system has power (at less than full, it serves them less well: life support's level shows that).
      const servedAll = Object.fromEntries(LS_SYSTEMS.map((x) => { const u = 100 * lsShare(k, x); return [x, u > 0 && f.delivered[x] > 0.5]; }));
      const emergency = (f.delivered.lighting || 0) >= 99;
      return Object.fromEntries(locationsOf(k).map((l) => { const on = e.ls[l]; const got = Object.fromEntries(LS_SYSTEMS.map((x) => [x, on[x] && servedAll[x]])); return [l, { on, got, lit: got.lights || (on.lights && emergency), emergency: on.lights && !got.lights && emergency }]; }));
    })(),
    // The fuel buses: each tank's level, tie and Fill/Drain; what moved; the antimatter bus's containment.
    fuel: Object.fromEntries(Object.entries(TANKS).map(([bus, ts]) => [bus, { flow: Math.round(e.busFlow[bus]), down: !!e.busDown[bus], why: e.busDown[bus], light: FUELBUS.light,
      tanks: Object.entries(ts).map(([n, t]) => ({ name: n, label: t.label, level: Math.floor(tankLevel(e, bus, n)), cap: tankCap(bus, n, e), pct: Math.floor(tankPct(e, bus, n)), ...e.tankCfg[`${bus}:${n}`],
        // An antimatter tank's own containment (the pods': the ship's main containment).
        ...(bus !== 'am' ? {} : n === 'main' ? { field: Math.round(e.contain.field), containKey: 'containment' } : { field: Math.round(e.tankContain[n].field), containKey: AM_CONTAIN[n], reserve: Math.round((100 * e.tankContain[n].reserve) / (tankContainDraw(n) * CONTAIN.reserveSecs)) }) })) }])),
    epsLive: e.epsLive, epsGen: Math.round(f.epsGen), epsChargeGen: EPS_CHARGE_GEN, impulseStartSecs: GRID.impulseStartSecs, impulseOutput: GRID.impulse,
    // Connections: the starbase and each ship docked with us, with each resource's Import / Export and what moved.
    connections: [...(e.docked ? [{ key: 'station', name: e.docked, kind: 'station', port: e.dockedPort, ties: e.connTies, hardLink: hardLinks.has(linkKey(k, shipKey(e.docked))) }] : []), ...partners(k).map(([p, o]) => ({ key: o, name: shipName(o), kind: 'ship', port: p.startsWith('bay') ? 'shuttle bay' : p }))]
      .map((x) => ({ ...x, ...Object.fromEntries(CONN_RES.map((r) => [r, { ...connOf(e, x.key)[r], ...(e.connFlow[`${x.key}:${r}`] || {}) }])), powerIn: x.kind === 'station' ? Math.round(Object.values(f.cells.dock || {}).reduce((a, b) => a + b, 0)) : Math.round(e.fed[x.port] ? -e.fed[x.port] : Object.values(f.cells.ship || {}).reduce((a, b) => a + b, 0)),
        epsIn: x.kind === 'station' ? Math.round(Object.values(f.cells.dockEps || {}).reduce((a, b) => a + b, 0)) : Math.round(e.fedEps[x.port] ? -e.fedEps[x.port] : Object.values(f.cells.shipEps || {}).reduce((a, b) => a + b, 0)) })),
    // The emergency batteries: charge, and a starbase can swap in a full one.
    emerg: EMERG.names.map((n) => ({ name: n, bus: EMERG.bus[n], level: Math.floor(e.emerg[n]), pct: Math.floor((100 * e.emerg[n]) / EMERG.cap), out: EMERG.out, supplying: Math.round(f.emergUsed[n] || 0) })), canReplace: !!e.docked,
    // The shuttle bay: doors, room, who's landed; and for a craft, the bays in range to land in.
    bay: { capacity: bayCapacity(k), open: !!e.bayOpen, doorsOk: f.subOk.bayDoors !== false, fieldOk: f.subOk.bayField !== false, landed: landedIn(k).map(shipName) },
    landed: e.landed ? shipName(e.landed) : null, bays: baysNear(k),
    spore: classOf(k).spore && !isBase(k) ? { spores: Math.floor(e.spores), cap: SPORE.cap, jump: SPORE.jump, loaded: e.spore.loaded || 0, growSecs: SPORE.growSecs, growing: e.spores < SPORE.cap && flow(k).delivered.sporeGrow >= 0.9 * (flow(k).demand.sporeGrow || 1), charging: e.spore.charging, t: e.spore.t, secs: SPORE.chargeSecs, dest: e.spore.dest?.name || (e.spore.dest ? `${Math.round(e.spore.dest.x)}, ${Math.round(e.spore.dest.y)}` : null), cooldown: Math.max(0, Math.ceil((e.spore.ready - Date.now()) / 1000)), why: sporeFault(k) } : null,
    // The shipyard's drydock: whether we're docked there, in it, and any release under way.
    drydock: { shipyard: isShipyard(e.docked), in: !!e.drydock, berth: e.drydock ? e.berth : null, powered: e.drydock ? berthPowered(k) : null, release: e.release ? Math.max(0, Math.ceil((e.release - Date.now()) / 1000)) : null, hold: !!e.hold },
    dockedPort: e.docked ? e.dockedPort : null, nearShip: nearShip(k), dockedWith: dockedWith(k).map(shipName),
    // What each port holds: a starbase, a ship (with its power offers), or nothing.
    ports: Object.fromEntries(portsOf(k).map((p) => {
      const o = e.shipDocks[p] && portFor(e.shipDocks[p], k) ? e.shipDocks[p] : null;
      return [p, e.docked && e.dockedPort === p ? { base: e.docked } : o ? { ship: shipName(o), feed: e.feed[p], fed: Math.round(e.fed[p]), theirFeed: engOf(o).feed[portFor(o, k)] } : null];
    })),
    dockedShip: shipsDocked(k)[0] ? shipName(shipsDocked(k)[0][1]) : null, // (first, for older pages)
    shipIn: Math.round(Object.values(f.cells.ship).reduce((a, b) => a + b, 0)), feedMax: SHIP_FEED_MAX,
    dockRequest: dockRequests.get(k) ? { from: shipName(dockRequests.get(k).from), port: dockRequests.get(k).port, seconds: Math.max(0, Math.ceil((dockRequests.get(k).until - Date.now()) / 1000)) } : null,
    thrustersOk: thrustersOk(k),
    cells: Object.fromEntries(Object.entries(f.cells).map(([n, c]) => [n, r(c)])), totals: f.totals,
    coreUsed: Math.round(f.coreUsed), impulseUsed: Math.round(f.impulseUsed), coreSubsOk: f.coreSubsOk, subOk: f.subOk,
    start: e.start, startSecs: CORE.sustainSecs, coreOutput: Math.round(coreOutput(e)), coreMax: CORE.max,
    warpCore: { ...e.wc, actual: Math.round(e.wc.actual), align: Math.round(e.wc.align * 10) / 10, crystal: Math.round(e.wc.crystal * 10) / 10, eff: Math.round(coreEff(e.wc) * 100), output: Math.round(coreOutput(e)), cores: coresOnline(k), need: { field: CONTAIN.conduit, light: FUELBUS.light, mix: CORE.ignitionMix, rate: CORE.ignitionRate, hot: CORE.hot, flameout: CORE.flameout, bestMix: CORE.bestMix } },
    odn: e.odn,
    computers: e.computers.map((cc) => ({ state: cc.state, stage: cc.state === 'booting' ? COMPUTER.stages[Math.min(COMPUTER.stages.length - 1, Math.floor((cc.t * COMPUTER.stages.length) / COMPUTER.bootSecs))] : null, t: cc.t })), computerBootSecs: COMPUTER.bootSecs,
    crossflow: Object.fromEntries(Object.entries(f.crossflow).map(([x, v]) => [x, Math.round(v)]).filter(([, v]) => v)), xlBlock: e.xlBlock || [], taps: e.taps, ties: e.ties, tripped: Object.keys(e.tripped || {}), containmentOk: f.containmentOk, eps: Math.round(f.viaEps),
    // Failing: seconds left before the field drops below 20% (the breach).
    breach: e.breach && e.antimatter > 0 ? Math.max(0, Math.ceil((e.contain.field - CONTAIN.breach) / CONTAIN.fall)) : null,
    contain: { field: Math.round(e.contain.field), reserve: Math.round((e.contain.reserve / reserveCap()) * 100), onReserve: !!e.onReserve, reserveSecs: Math.round(e.contain.reserve / GRID.containment) },
    // Each store: how full (%), charging, covering a shortfall.
    stores: Object.fromEntries(Object.entries(STORES).map(([name, node]) => [node, { name, breaker: node === 'EPS' ? null : e.breakers[node], level: Math.round((e.stores[name] / (node === 'EPS' ? GRID.epsCap : GRID.batteryCap)) * 100), charging: Math.round(f.charging[node]), supplying: Math.round(f.storeUsed[node]) }])),
    docked: e.docked, near: near?.name || null,
    towing: e.towing ? shipName(e.towing) : null, towedBy: tower ? shipName(tower) : null,
    selfDestruct: e.selfDestruct ? { seconds: Math.max(0, Math.ceil((e.selfDestruct.at - Date.now()) / 1000)), by: e.selfDestruct.by } : null,
    buses: Object.fromEntries(BUSES.map((X) => { const b = f.buses[X]; return [X, { need: Math.round(b.need), have: Math.round(b.have), src: r(b.src), consolesOk: b.consolesOk, fraction: Math.round(b.fraction * 100) }]; })),
    consoleOk: f.consoleOk, sysNames: SYSTEM_NAMES,
    // Ties that carry nothing: a conduit on their way untied from that bus (key -> the buses cut off).
    cutOff: Object.fromEntries(Object.keys(e.ties).map((x) => [x, (e.ties[x] || []).filter((X) => !effTies(k, e, x).includes(X))]).filter(([, v]) => v.length)),
    conduits: CONDUITS.filter((c) => c === 'system:lifeSupport' || placesOf(k).some((pl) => `place:${pl.name}` === c)), systemChildren: SYSTEM_CHILDREN, systemParents: SYSTEM_PARENTS, ratings: Object.fromEntries(SYSTEMS.map((x) => [x, ratingOf(x)])), powerMax: POWER_MAX, forcefields: e.forcefields, fieldsUp: e.forcefields.length > 0 && f.subOk.forcefields !== false, brigField: !!e.brigField, brigSealed: brigSealed(k), stationSystems: stationSystemsOf(k), starbase: isBase(k), subsystems: Object.fromEntries(Object.entries(SUBSYSTEMS).map(([x, v]) => [x, { parent: v.parent, name: v.name }])),
    tieNodes: Object.fromEntries(Object.keys(e.ties).filter((key) => aboardKey(k, key)).map((key) => [key, tieNodes(key)])), multi: Object.keys(e.ties).filter((key) => isMulti(key) && aboardKey(k, key)), busMax: busMaxOf(k), solarOut: designOf(k).solar?.output ?? 0,
    delivered: r(f.delivered), demand: f.demand, drawn: Math.round(f.drawn),
    // What each source could give now (MW): tied and giving nothing, it's either not needed (ready) or has nothing to give.
    srcCap: Object.fromEntries(Object.entries(f.srcCap || {}).map(([x, v]) => [x, Math.round(v)])),
    // Each source's damage (%: the worst of what it's made of), shown on Distribution even when it's off.
    srcDamage: (() => { const d = combatOf(k).damage || {}, worst = (xs) => Math.round(Math.max(0, ...xs.map((x) => d[x] || 0))); return Object.fromEntries(Object.entries(SRC_DAMAGE).map(([x, xs]) => [x, worst(xs)]).filter(([, v]) => v >= 1)); })(),
  };
}

// Engineering's grid controls: the warp core and impulse drives, EPS taps,
// ties, ejecting and replacing the core, docked-ship power, supplies.
function gridCommand(ws, msg) {
  const key = ws.shipKey, e = engOf(key);
  const note = (text) => send(ws, { type: 'notice', text: `Engineering: ${text}` });
  if (ws.station !== 'Engineering') return send(ws, { type: 'notice', text: 'Only Engineering runs the power grid' });
  const said = [];
  const NAME = { core: 'power transfer conduits', thrustersPort: 'port maneuvering thrusters', thrustersStarboard: 'starboard maneuvering thrusters', crosslink: 'bus crosslink', solar: 'solar', dock: 'starbase power (Bus B)', dockEps: 'starbase EPS power', ship: 'docked-ship power (Bus B)', shipEps: 'docked-ship EPS power', emergA: 'emergency battery A', emergB: 'emergency battery B', emergC: 'emergency battery C', core: 'warp core', battery: 'batteries', containment: 'antimatter containment', impulsePort: 'port impulse drive', impulseStarboard: 'starboard impulse drive' };
  const feeds = (list) => (list.length ? list.map((n) => (n === 'EPS' ? 'EPS' : `Bus ${n}`)).join(' + ') : 'off');
  if (msg.eject) {
    if (e.core === 'ejected') return note('the warp core is already gone');
    Object.assign(e, { core: 'ejected', antimatter: 0, start: 0, breach: 0, contain: { field: 100, reserve: reserveCap() } });
    e.tanks.am.core = 0; e.tanks.deu.core = 0; // (the core's own tanks go with it)
    said.push('WARP CORE AND ANTIMATTER PODS EJECTED');
    for (const u of crewOf(key)) if (u !== ws) send(u, { type: 'notice', text: `Engineering: the warp core has been ejected (${ws.name})` });
  }
  if (msg.refit) {
    // A new warp core and antimatter pods, from the starbase. Full pods need a
    // containment feed set to go into; without one they come empty.
    if (classOf(key).refit === false) return note(`a ${classOf(key).name.toLowerCase()}'s warp core can't be replaced`);
    if (!e.drydock) return note(`a warp core and antimatter pods can only be replaced in drydock at the shipyard (${SHIPYARD.name})`);
    if (!berthPowered(key)) return note(`${e.docked}'s drydock connection ${e.berth} has no power: the work waits for it`);
    if (e.core === 'online' || e.core === 'starting') return note('shut the warp core down before replacing it');
    const fill = e.ties.containment.length > 0;
    Object.assign(e, { core: 'offline', start: 0, breach: 0, antimatter: fill ? (e.fuelCaps?.antimatter ?? FUEL.antimatter) : 0, contain: { field: 100, reserve: reserveCap() } });
    said.push(`new warp core and ${fill ? 'full' : 'empty'} antimatter pods installed in drydock at ${e.docked} (offline: start it up${fill ? '' : '; set a containment feed and refuel first'})`);
  }
  // The reaction's settings: rate (the light bar's target), mixture, plasma conduits, trim.
  if (Number.isFinite(msg.coreRate)) { e.wc.rate = Math.max(0, Math.min(100, Math.round(msg.coreRate))); said.push(`warp core reaction rate set to ${e.wc.rate}%`); }
  if (Number.isFinite(msg.coreMix)) { e.wc.mix = Math.max(5, Math.min(25, Math.round(msg.coreMix))); said.push(`warp core mixture ${e.wc.mix}:1 (deuterium to antimatter)`); }
  if (typeof msg.plasma === 'boolean') { e.wc.plasma = msg.plasma; said.push(`plasma transfer conduits to the nacelles ${msg.plasma ? 'open' : 'closed'}`); }
  if (msg.trim) { e.wc.align = Math.min(100, e.wc.align + 5); said.push(`dilithium articulation frame trimmed: alignment ${Math.round(e.wc.align)}%`); }
  if (typeof msg.autoTrim === 'boolean') {
    if (msg.autoTrim && coresOnline(key) < COMPUTERS.length) return note(`auto-trim needs all ${COMPUTERS.length} computer cores online (${coresOnline(key)} are)`);
    e.wc.autoTrim = msg.autoTrim; said.push(`dilithium auto-trim ${msg.autoTrim ? 'on' : 'off'}`);
  }
  if (msg.core === 'scram' && (e.core === 'online' || e.core === 'starting')) {
    e.core = 'offline'; e.start = 0; e.wc.actual = 0; e.wc.breachT = null;
    said.push('WARP CORE SCRAM: reaction stopped');
  }
  if (msg.core === 'start' && e.core === 'offline') {
    if (tankPct(e, 'am', 'core') < FUELBUS.light || tankPct(e, 'deu', 'core') < FUELBUS.light) return note(`the warp core needs antimatter and deuterium in its tanks, ${FUELBUS.light}% or more (antimatter ${Math.round(tankPct(e, 'am', 'core'))}%, deuterium ${Math.round(tankPct(e, 'deu', 'core'))}%: fill them from the buses)`);
    if (powerOf(key).sif < HULL.coreSif) return note(`the warp core needs the structural integrity field at ${HULL.coreSif}% to start (it's at ${powerOf(key).sif}%)`);
    if (e.contain.field < CONTAIN.conduit) return note(`the injectors won't open: containment field ${Math.round(e.contain.field)}% (they need ${CONTAIN.conduit}%)`);
    if (e.wc.mix < CORE.ignitionMix) return note(`cold ignition needs a deuterium-rich mixture, ${CORE.ignitionMix}:1 or richer (it's ${e.wc.mix}:1)`);
    if (!e.wc.rate) return note('set a reaction rate first (the warp core panel\'s light bar)');
    e.core = 'starting'; e.start = 0; e.wc.actual = Math.min(e.wc.rate, CORE.ignitionRate); flowCache.delete(key);
    if (!flow(key).coreSubsOk) { e.core = 'offline'; flowCache.delete(key); return note(`the warp core's constriction (${GRID.constriction.start} to start), antimatter injector and antimatter transfer conduit need power: tie them to a bus that has it`); }
    said.push(`warp core cold ignition at ${e.wc.actual}%`);
  } else if (msg.core === 'start' && e.core === 'ejected') return note('there is no warp core: install a new one at a starbase');
  else if (msg.core === 'stop' && (e.core === 'online' || e.core === 'starting')) {
    e.core = 'offline'; e.start = 0; e.wc.actual = 0;
    said.push('warp core shut down');
  }
  // Impulse drives: start (on bus power for their pumps) or stop; thrusters in or out.
  // A fusion reactor (an impulse drive, or aux1/aux2): light its chamber or
  // shut it down; its EPS tap; a drive's accelerators (0-100) and gear.
  const rx = msg.impulse || msg.reactor;
  if (rx && designOf(key).fusion === false) return note('there are no fusion reactors aboard (a pure-solar design)');
  const rName = rx && (msg.impulse ? rx.drive : rx.name);
  const r = rName && (DRIVES.includes(rName) ? e.drives[rName] : AUX.includes(rName) ? e.aux[rName] : null);
  if (r) {
    const label = reactorLabel(rName);
    if (rx.on === true && r.state === 'off') {
      if (tankPct(e, 'deu', rName) < FUELBUS.light) return note(`the ${label} won't light: its deuterium tank is at ${Math.round(tankPct(e, 'deu', rName))}% (it needs ${FUELBUS.light}%: fill it from the deuterium bus)`);
      r.state = 'starting'; r.start = 0; flowCache.delete(key);
      if (!flow(key).subOk[`${rName}Chamber`]) { r.state = 'off'; flowCache.delete(key); return note(`the ${label}'s reaction chamber needs ${FUSION.chamberStart} to light: tie it to a bus that has it`); }
      said.push(`${label}: chamber lighting`);
    } else if (rx.on === false && r.state !== 'off') { r.state = 'off'; r.start = 0; said.push(`${label} shut down`); }
    if (typeof rx.epsTap === 'boolean') { r.epsTap = rx.epsTap; said.push(`${label}'s EPS tap ${r.epsTap ? 'on: it powers itself from the EPS while running' : 'off: it runs on its bus ties'}`); }
    if (DRIVES.includes(rName) && Number.isFinite(rx.accel)) { r.accel = Math.max(0, Math.min(100, Math.round(rx.accel))); said.push(`${label}'s accelerators at ${r.accel}%`); }
    if (DRIVES.includes(rName) && (rx.gear === 'low' || rx.gear === 'high')) { r.gear = rx.gear; said.push(`${label}'s driver coils in ${rx.gear === 'low' ? 'Low gear (quick, a quarter impulse at most)' : 'High gear (full impulse)'}`); }
  }
  // A fuel tank: tie it to its bus, or Fill / Drain (one at a time): { tank: { bus, name, tied?, fill?, drain? } }.
  if (msg.tank && TANKS[msg.tank.bus]?.[msg.tank.name]) {
    const t = msg.tank, cfg = e.tankCfg[`${t.bus}:${t.name}`], label = TANKS[t.bus][t.name].label;
    if (typeof t.tied === 'boolean') { cfg.tied = t.tied; said.push(`${label} ${t.tied ? 'tied to' : 'untied from'} the ${t.bus === 'am' ? 'antimatter' : 'deuterium'} bus`); }
    if (typeof t.fill === 'boolean') { cfg.fill = t.fill; if (t.fill) cfg.drain = false; said.push(`${label}: fill ${t.fill ? 'on' : 'off'}`); }
    if (typeof t.drain === 'boolean') { cfg.drain = t.drain; if (t.drain) cfg.fill = false; said.push(`${label}: drain ${t.drain ? 'on' : 'off'}`); }
  }
  // A console's ODN link: { odn: { station, on } } (Engineering's stays on).
  if (msg.odn && (STATIONS.includes(msg.odn.station) || msg.odn.station === OPS_STATION)) {
    if (msg.odn.station === 'Engineering') return note("Engineering's ODN link can't be cut");
    e.odn[msg.odn.station] = !!msg.odn.on;
    said.push(`${msg.odn.station} console ${msg.odn.on ? 'linked to' : 'cut off from'} the optical data network`);
  }
  // Life support in a place (or 'all'): { ls: { loc, sys, on } }.
  if (msg.ls && LS_SYSTEMS.includes(msg.ls.sys) && (msg.ls.loc === 'all' || LOCATIONS.includes(msg.ls.loc))) {
    for (const l of msg.ls.loc === 'all' ? locationsOf(key) : [msg.ls.loc]) e.ls[l][msg.ls.sys] = !!msg.ls.on;
    said.push(`${SYSTEM_NAMES[msg.ls.sys]} ${msg.ls.on ? 'on' : 'off'} ${msg.ls.loc === 'all' ? 'everywhere' : `at ${msg.ls.loc}`}`);
  }

  // EPS taps: how much EPS power may flow into a bus ({bus, amount}, or {bus, on} for all or nothing).
  if (msg.tap && BUSES.includes(msg.tap.bus)) {
    const X = msg.tap.bus;
    e.taps[X] = Math.max(0, Math.min(busMaxOf(key)[X], Math.round(Number.isFinite(msg.tap.amount) ? msg.tap.amount : msg.tap.on ? busMaxOf(key)[X] : 0)));
    said.push(`EPS tap to Bus ${X}: ${e.taps[X] ? `up to ${e.taps[X]}` : 'closed'}`);
  }
  // All on / All off for a bus column (A, B, C, EPS, Deu, AM) or every one ('all'): { busAll: { bus, on } }.
  // On ties every row that may go on it (one-bus rows only if untied); off unties them, but for what keeps
  // antimatter contained: a tank's containment while that tank holds antimatter, the AM bus's magnetic
  // containment while there's antimatter on the AM bus, the warp core's constriction while it runs, and
  // the Engineering console. Breakers, the crosslink and the EPS taps aren't touched.
  // (The ODN too: every console linked, or cut off but Engineering's and your own.)
  if (msg.busAll && (msg.busAll.bus === 'all' || [...NODES, 'Deu', 'AM', 'ODN'].includes(msg.busAll.bus))) {
    const on = !!msg.busAll.on, cols = msg.busAll.bus === 'all' ? ['ODN', ...NODES, 'Deu', 'AM'] : [msg.busAll.bus];
    // (Only what this vessel has: its stations' consoles, its class's systems.)
    const aboard = (k2) => aboardKey(key, k2);
    const amOnBus = Object.keys(TANKS.am).some((n) => e.tankCfg[`am:${n}`]?.tied && tankLevel(e, 'am', n) > 0);
    const keep = (k2) => (k2 === 'console:Engineering' ? 'the Engineering console' : k2 === `console:${placeOf(ws)}` ? 'your own console'
      : k2 === 'containment' && tankLevel(e, 'am', 'main') > 0 ? 'antimatter containment (antimatter in the pods)'
      : Object.entries(AM_CONTAIN).find(([n, c]) => c === k2 && tankLevel(e, 'am', n) > 0) ? `${TANKS.am[Object.entries(AM_CONTAIN).find(([, c]) => c === k2)[0]].label} containment (antimatter in it)`
      : k2 === 'sub:constriction' && e.core !== 'offline' && e.core !== 'ejected' ? 'the warp core\'s constriction (the core is running)'
      : k2 === 'system:amBus' && amOnBus ? 'the AM bus\'s magnetic containment (antimatter on the AM bus)' : null);
    const kept = new Set(), changed = [];
    // (What's kept tied keeps its way to the bus too: the conduits above it.)
    const keptPaths = new Set(Object.keys(e.ties).filter((k2) => keep(k2)).flatMap((k2) => conduitsOf(key, k2)));
    for (const X of cols) {
      if (X === 'ODN') {
        for (const st of [...STATIONS, OPS_STATION].filter((s2) => s2 === OPS_STATION || hasStation(key, s2))) {
          if (!on && (st === 'Engineering' || st === placeOf(ws))) { if (e.odn[st] !== false) kept.add(st === 'Engineering' ? "Engineering's ODN link" : 'your own ODN link'); continue; }
          if ((e.odn[st] !== false) !== on) { e.odn[st] = on; changed.push(X); }
        }
        continue;
      }
      if (X === 'Deu' || X === 'AM') {
        const bus = X === 'Deu' ? 'deu' : 'am';
        for (const n of Object.keys(TANKS[bus])) { const cfg = e.tankCfg[`${bus}:${n}`]; if (cfg && cfg.tied !== on) { cfg.tied = on; changed.push(X); } }
        if (e.docked && e.connTies[bus] !== on) { e.connTies[bus] = on; changed.push(X); }
        continue;
      }
      for (const k2 of Object.keys(e.ties)) {
        if (k2 === 'crosslink' || k2 === 'impulsePort' || k2 === 'impulseStarboard' || !aboard(k2) || !tieNodes(k2).includes(X)) continue;
        const cur = e.ties[k2];
        if (on) {
          if (CONSUMABLE.has(k2)) continue; // (the emergency batteries: by hand only)
          if (cur.includes(X) || (!isMulti(k2) && cur.length)) continue;
          e.ties[k2] = NODES.filter((n) => n === X || cur.includes(n));
        } else {
          if (!cur.includes(X)) continue;
          const why = keep(k2) || (keptPaths.has(k2) ? null : null);
          if (!why && keptPaths.has(k2)) continue; // (a conduit on the way to something kept)
          if (why) { kept.add(why); continue; }
          e.ties[k2] = cur.filter((n) => n !== X);
        }
        if (e.tripped) delete e.tripped[k2];
        changed.push(X);
      }
    }
    const what = msg.busAll.bus === 'all' ? 'All buses' : `${{ Deu: 'Deu. bus', AM: 'AM bus', EPS: 'EPS' }[msg.busAll.bus] || `Bus ${msg.busAll.bus}`}`;
    said.push(`${what}: all ${on ? 'on' : 'off'}${changed.length ? '' : ' (nothing to change)'}${kept.size ? `; kept tied: ${[...kept].join(', ')}` : ''}`);
    linkTick();
  }
  for (const [k, v] of Object.entries(msg.ties && typeof msg.ties === 'object' ? msg.ties : {})) {
    if (!(k in e.ties) || !Array.isArray(v) || k === 'impulsePort' || k === 'impulseStarboard') continue; // a drive feeds the EPS through its thrusters' tie
    const allowed = tieNodes(k);
    if (v.some((n) => !allowed.includes(n))) return note(`${NAME[k] || k.split(':')[1]} can only be tied to ${feeds(allowed)}`);
    const list = NODES.filter((n) => v.includes(n));
    if (k === 'crosslink' && !chainOk(list)) return note('A and C link only through B: the crosslink runs A–B–C');
    if (list.length > 1 && !isMulti(k)) return note(`${NAME[k] || k.split(':')[1]} ties to one: Bus A, B or C (the crosslink joins buses)`);
    if (k === 'containment' && !list.length && e.antimatter > 0) return note('antimatter containment can\'t be switched off with antimatter aboard (only self-destruct does that): leave it at least one feed');
    // (A tie closed or opened by the crosslink carries both ways again.)
    if (k === 'crosslink') for (const [a, b] of [['A', 'B'], ['B', 'C']]) if (!(list.includes(a) && list.includes(b) && e.ties.crosslink.includes(a) && e.ties.crosslink.includes(b))) e.xlBlock = (e.xlBlock || []).filter((d) => d !== `${a}>${b}` && d !== `${b}>${a}`);
    e.ties[k] = list;
    if (e.tripped) delete e.tripped[k];
    said.push(`${NAME[k] || (k.startsWith('console:') ? `${k.slice(8)} console` : k.startsWith('sub:') ? SUBSYSTEMS[k.slice(4)].name : SYSTEM_NAMES[k.slice(7)] || k.slice(7))} ${k === 'containment' ? 'fed from' : 'tied to'} ${feeds(list)}`);
  }
  // A connection's Import / Export: { conn: { with: 'station' | ship, res: 'deu' | 'am' | 'power', imp?, exp? } }.
  if (msg.conn && CONN_RES.includes(msg.conn.res)) {
    const other = msg.conn.with === 'station' ? 'station' : shipKey(clean(msg.conn.with));
    const name = other === 'station' ? (e.docked || 'the starbase') : `the ${shipName(other)}`;
    const c = connOf(e, other)[msg.conn.res], what = { deu: 'deuterium', am: 'antimatter', power: 'power (Bus B)', eps: 'EPS power' }[msg.conn.res];
    if (typeof msg.conn.imp === 'boolean') { c.imp = msg.conn.imp; said.push(`${what} import from ${name} ${c.imp ? 'on' : 'off'}`); }
    if (typeof msg.conn.exp === 'boolean') { c.exp = msg.conn.exp; said.push(`${what} export to ${name} ${c.exp ? 'on' : 'off'}`); }
  }
  // A starbase swaps in a full emergency battery: { emergReplace: 'emergA' }.
  if (EMERG.names.includes(msg.emergReplace)) {
    if (!e.docked) return note('emergency batteries are replaced at a starbase: dock first');
    e.emerg[msg.emergReplace] = EMERG.cap;
    said.push(`emergency battery ${EMERG.bus[msg.emergReplace]} replaced with a full one from ${e.docked}`);
  }
  // The starbase connection's Deu. / AM / ODN ties: { connTie: { res: 'deu' | 'am' | 'odn', on } }.
  if (msg.connTie && ['deu', 'am', 'odn'].includes(msg.connTie.res)) {
    if (!e.docked) return note('not docked at a starbase');
    const res = msg.connTie.res;
    e.connTies[res] = !!msg.connTie.on;
    const on = e.connTies[res], bus = { deu: 'the Deu. bus', am: 'the AM bus', odn: 'the ODN' }[res];
    said.push(`${e.docked} connection ${on ? 'tied to' : 'untied from'} ${bus}${res === 'odn' && on ? ': hard data link through the docking port' : ''}`);
    linkTick();
  }
  // One way of a crosslink tie, on or off (or toggled): { xlDir: { from, to, on? } }. On with the tie
  // open closes it that way only; off with the other way off too opens it.
  if (msg.xlDir && XL_DIRS.includes(`${msg.xlDir.from}>${msg.xlDir.to}`)) {
    const { from, to } = msg.xlDir, d = `${from}>${to}`, r = `${to}>${from}`, xl = e.ties.crosslink;
    e.xlBlock = (e.xlBlock || []).filter((x) => XL_DIRS.includes(x));
    const linked = xl.includes(from) && xl.includes(to), on = typeof msg.xlDir.on === 'boolean' ? msg.xlDir.on : !(linked && !e.xlBlock.includes(d));
    if (on && !linked) {
      e.ties.crosslink = ['A', 'B', 'C'].filter((n) => xl.includes(n) || n === from || n === to);
      e.xlBlock = [...e.xlBlock.filter((x) => x !== d && x !== r), r];
      said.push(`bus crosslink ${from}–${to} closed one way: Bus ${from} → Bus ${to} only`);
    } else if (on) {
      e.xlBlock = e.xlBlock.filter((x) => x !== d);
      said.push(`bus crosslink: Bus ${from} → Bus ${to} open${e.xlBlock.includes(r) ? ' (one way)' : ' (both ways)'}`);
    } else if (linked) {
      if (e.xlBlock.includes(r)) {
        // (Both ways off: the tie opens. Opening A–B drops A; B–C drops C; a lone bus is no crosslink.)
        const drop = [from, to].includes('A') ? 'A' : 'C', next = xl.filter((n) => n !== drop);
        e.ties.crosslink = next.length < 2 ? [] : next;
        e.xlBlock = e.xlBlock.filter((x) => x !== d && x !== r);
        said.push(`bus crosslink ${from}–${to} open`);
      } else {
        e.xlBlock = [...e.xlBlock.filter((x) => x !== d), d];
        said.push(`bus crosslink one way: Bus ${to} → Bus ${from} only`);
      }
    }
  }
  if (msg.breaker && BUSES.includes(msg.breaker.bus)) {
    e.breakers[msg.breaker.bus] = !!msg.breaker.on;
    said.push(`Battery ${msg.breaker.bus} main breaker ${e.breakers[msg.breaker.bus] ? 'closed: in service' : 'open'}`);
  }
  if (!said.length) return;
  e.dirty = true;
  opLog(key, `Engineering (${ws.name}): ${said.join(', ')}`);
  note(said.join(', '));
  gridChanged(key);
}

// Docking. Two ports, port and starboard: a starbase takes one, ships one
// each. Helm picks the port. Docking with a crewed ship whose maneuvering
// thrusters work is a request its Helm accepts or declines (30 s); a ship
// with nobody aboard, or no working thrusters, is docked with regardless
// (its shields down, within range, all stop). A ship without working
// thrusters of its own can't dock at all. Starbases always accept.
const DOCK_REQUEST_MS = 30000;
const dockRequests = new Map(); // target ship key -> { from, port, until }
// Maneuvering thrusters work while an impulse drive runs.
const thrustersOk = (k) => DRIVES.some((d) => engOf(k).drives[d].state === 'running') && engOf(k).deuterium > 0;
// (A runabout or a shuttle has one docking port.)
const portsOf = (k) => (designOf(k).ports == null ? PORTS : PORTS.slice(0, designOf(k).ports));
const freePort = (k, want) => (portsOf(k).includes(want) && !portTaken(k, want) ? want : portsOf(k).find((p) => !portTaken(k, p)) || null);
const portTaken = (k, p) => !!(engOf(k).shipDocks[p] || (engOf(k).docked && engOf(k).dockedPort === p));

function joinShips(k, p, t, tp) {
  engOf(k).shipDocks[p] = t; engOf(t).shipDocks[tp] = k;
  for (const x of [k, t]) { Object.assign(engOf(x).feed, { [x === k ? p : tp]: 0 }); engOf(x).dirty = true; flowCache.delete(x); }
  opLog(k, `docked with the ${shipName(t)} (${p} dock)`);
  opLog(t, `the ${shipName(k)} docked with us (${tp} dock)`);
  for (const u of [...crewOf(k), ...crewOf(t)]) send(u, { type: 'notice', text: `Helm: the ${shipName(k)} and the ${shipName(t)} are docked together` });
  scheduleNav();
}

function dockCommand(ws, msg) {
  const key = ws.shipKey, e = engOf(key), nav = navState.get(key);
  const note = (text) => send(ws, { type: 'notice', text: `Helm: ${text}` });
  if (ws.station !== 'Helm') return send(ws, { type: 'notice', text: 'Only Helm docks the ship' });
  if (isBase(key)) return note(`${shipName(key)} is a starbase: ships dock with it`);
  // Answering a docking request from another ship.
  if (msg.answer) {
    const r = dockRequests.get(key);
    if (!r) return note('no docking request to answer');
    dockRequests.delete(key);
    const from = users.get(r.by) || null;
    if (msg.answer !== 'accept') {
      opLog(r.from, `the ${shipName(key)} declined to dock`);
      for (const u of crewOf(r.from)) if (u.station === 'Helm') send(u, { type: 'notice', text: `Helm: the ${shipName(key)} declined to dock` });
      scheduleNav();
      return note(`declined the ${shipName(r.from)}'s docking request`);
    }
    const tp = freePort(key, msg.port);
    if (!tp || portTaken(r.from, r.port)) return note('no free docking port');
    if (distance(key, r.from) > DOCK_RANGE || nav.warp > 0 || navState.get(r.from)?.warp > 0) return note('the ships have to be within docking range and at all stop');
    joinShips(r.from, r.port, key, tp);
    return;
  }
  // The shuttle bay: land in a ship's (or starbase's) bay, or take off.
  if (msg.land) {
    const m = shipKey(clean(msg.land));
    const why = landFault(key, m);
    // (An automated hangar opens its doors for a craft asking to land: ask, then land when they're open.)
    if (why && /doors are closed/.test(why) && autoOn(m, 'hangar')) { bayRequests.set(key, { m, kind: 'land', at: Date.now() }); return note(`asked the ${shipName(m)}'s hangar control for clearance: the doors are opening`); }
    if (why) return note(why);
    e.landed = m; e.dirty = true;
    if (isBase(m)) { e.docked = shipName(m); e.dockedPort = 'port'; untieDock(e); } // (in a starbase's bay: docked at it)
    else { connOf(e, m); connOf(engOf(m), key); for (const r of CONN_RES) { e.conn[m][r] = { imp: false, exp: false }; engOf(m).conn[key][r] = { imp: false, exp: false }; } } // (a new connection: nothing tied)
    opLog(key, `Helm (${ws.name}): landed in the ${shipName(m)}'s shuttle bay`);
    opLog(m, `the ${shipName(key)} landed in our shuttle bay`);
    for (const u of crewOf(key)) send(u, { type: 'notice', text: `Helm: landed in the ${shipName(m)}'s shuttle bay` });
    broadcastCrew(key); broadcastOps(m);
    return gridChanged(key);
  }
  if (msg.takeoff) {
    if (!e.landed) return note('not landed in a shuttle bay');
    const m = e.landed;
    if (present(m) && !engOf(m).bayOpen && autoOn(m, 'hangar')) { bayRequests.set(key, { m, kind: 'takeoff', at: Date.now() }); return note(`asked the ${shipName(m)}'s hangar control for clearance: the doors are opening`); }
    if (present(m) && !engOf(m).bayOpen) return note(`the ${shipName(m)}'s shuttle bay doors are closed: ask their hangar control to open them`);
    e.landed = null; e.dirty = true;
    if (isBase(m) && e.docked === shipName(m)) e.docked = null;
    for (const slot of ['bay']) { e.feed[slot] = 0; e.fed[slot] = 0; e.feedEps[slot] = 0; e.fedEps[slot] = 0; }
    opLog(key, `Helm (${ws.name}): took off from the ${shipName(m)}'s shuttle bay`);
    opLog(m, `the ${shipName(key)} took off from our shuttle bay`);
    for (const u of crewOf(key)) send(u, { type: 'notice', text: `Helm: took off from the ${shipName(m)}'s shuttle bay` });
    broadcastCrew(key); broadcastOps(m);
    return gridChanged(key);
  }
  // The shipyard's drydock: enter it (docked there), or ask to be released.
  if (msg.drydock) {
    if (!isShipyard(e.docked)) return note(`drydock is only at the shipyard (${SHIPYARD.name}): dock there first`);
    if (e.drydock) return note(`already in drydock at ${e.docked}`);
    if (drydocked().length >= DRYDOCK.berths) return note(`${e.docked}'s ${DRYDOCK.berths} drydock berths are all in use`);
    const yard = shipKey(e.docked), taken = drydocked().filter((o) => shipKey(engOf(o).docked || '') === yard).map((o) => engOf(o).berth);
    Object.assign(e, { drydock: true, berth: [1, 2, 3].find((n) => !taken.includes(n)), release: null, hold: false, dirty: true });
    if (primaryCore.get(key) && nav?.warp > 0) send(primaryCore.get(key), { type: 'core-helm', ship: shipName(key), warp: 0 });
    autopilots.delete(key);
    opLog(key, `Helm (${ws.name}): entered drydock at ${e.docked}`);
    opLog(shipKey(e.docked), `the ${shipName(key)} entered drydock`);
    for (const u of crewOf(key)) send(u, { type: 'notice', text: `Helm: in drydock at ${e.docked}` });
    broadcastOps(shipKey(e.docked));
    return gridChanged(key);
  }
  if (msg.release) {
    if (!e.drydock) return note('not in drydock');
    if (e.release) return note(`release already requested: ${Math.max(0, Math.ceil((e.release - Date.now()) / 1000))} s`);
    e.release = Date.now() + DRYDOCK.releaseSecs * 1000;
    opLog(shipKey(e.docked), `the ${shipName(key)} requests release from drydock`);
    broadcastOps(shipKey(e.docked));
    note(`release from drydock requested: ${DRYDOCK.releaseSecs} s (once no repair job is under way)`);
    return gridChanged(key);
  }
  if (msg.undock) {
    if (e.landed && isBase(e.landed)) return note(`landed in ${shipName(e.landed)}'s shuttle bay: take off instead`);
    if (e.drydock && (!PORTS.includes(msg.port) || msg.port === e.dockedPort)) return note(`in drydock at ${e.docked}: request release first`);
    // One port (or all of them).
    const ports = PORTS.includes(msg.port) ? [msg.port] : PORTS;
    for (const p of ports) {
      if (e.docked && e.dockedPort === p) { opLog(key, `undocked from ${e.docked}`); note(`undocked from ${e.docked}`); e.docked = null; }
      if (e.shipDocks[p]) undockPort(key, p, `undocked by ${ws.name}`);
    }
    e.dirty = true;
    return gridChanged(key);
  }
  if (!thrustersOk(key)) return note('no maneuvering thrusters: start an impulse drive to dock');
  if (nav.warp > 0) return note('come to all stop before docking');
  const port = freePort(key, msg.port);
  if (!port) return note('both docking ports are in use');
  if (msg.ship) {
    const t = shipKey(clean(msg.ship));
    if (t === key || isBase(t) || !cores.has(t) || !navState.has(t)) return note(`can't dock with the ${clean(msg.ship)}`);
    if (portFor(key, t)) return note(`already docked with the ${shipName(t)}`);
    if (distance(key, t) > DOCK_RANGE) return note(`the ${shipName(t)} is out of docking range (${Math.round(distance(key, t))} units; get within ${DOCK_RANGE})`);
    if (navState.get(t).warp > 0) return note('both ships must be at all stop to dock');
    if (shields.has(t)) return note(`the ${shipName(t)} has its shields up`);
    const tp = freePort(t);
    if (!tp) return note(`the ${shipName(t)} has no free docking port`);
    // Crewed, with working thrusters: a request for its Helm to answer.
    if (crewOf(t).length && thrustersOk(t)) {
      if (dockRequests.has(t)) return note(`the ${shipName(t)} is already answering a docking request`);
      dockRequests.set(t, { from: key, port, by: ws.id, until: Date.now() + DOCK_REQUEST_MS });
      for (const u of crewOf(t)) if (u.station === 'Helm') send(u, { type: 'notice', text: `Helm: the ${shipName(key)} requests to dock (accept or decline on the Helm console)` });
      opLog(t, `the ${shipName(key)} requests to dock`);
      scheduleNav();
      return note(`docking request sent to the ${shipName(t)}`);
    }
    joinShips(key, port, t, tp);
    return;
  }
  const base = nav && STARBASES.find((b) => Math.hypot(nav.x - b.x, nav.y - b.y) <= DOCK_RANGE);
  if (!base) return note(`no starbase within docking range (${DOCK_RANGE} units)`);
  if (e.docked) return note(`already docked at ${e.docked}`);
  e.docked = base.name; e.dockedPort = port; e.dirty = true;
  untieDock(e);
  opLog(key, `Helm (${ws.name}): docked at ${base.name} (${port} dock)`);
  for (const u of crewOf(key)) send(u, { type: 'notice', text: `Helm: docked at ${base.name}` });
  gridChanged(key);
}

// Why this craft can't land in m's bay now (null: it can). Shuttles and
// runabouts land (runabouts only in a starbase's bay); within docking range,
// both at all stop, the bay doors open, and room in the bay.
function landFault(k, m) {
  const c = classOf(k), e = engOf(k);
  // (Its design says where it may land: "lands": "any" (any shuttle bay) or "starbase" (a starbase's); not at all without it.)
  if (isBase(k) || !c.lands) return 'only a shuttle or a runabout lands in a shuttle bay';
  if (e.landed) return `already landed in the ${shipName(e.landed)}'s shuttle bay`;
  if (!present(m) || m === k || !navState.has(m)) return `the ${shipName(m)} isn't here`;
  if (!bayCapacity(m)) return `the ${shipName(m)} has no shuttle bay`;
  if (c.lands === 'starbase' && !isBase(m)) return `a ${c.name.toLowerCase()} only lands in a starbase's shuttle bay`;
  if (distance(k, m) > DOCK_RANGE) return `the ${shipName(m)} is out of range (${Math.round(distance(k, m))} units; get within ${DOCK_RANGE})`;
  if ((navState.get(k)?.warp || 0) > 0 || (navState.get(m)?.warp || 0) > 0) return 'come to all stop first (both of you)';
  if (!engOf(m).bayOpen) return `the ${shipName(m)}'s shuttle bay doors are closed: ask their hangar control to open them`;
  if (landedIn(m).length >= bayCapacity(m)) return `the ${shipName(m)}'s shuttle bay is full (${bayCapacity(m)})`;
  if (e.docked || shipsDocked(k).length) return 'undock first';
  return null;
}
// The bays a craft could land in from here (for Helm's taps), with why not.
const baysNear = (k) => (isBase(k) || !classOf(k).lands || engOf(k).landed ? [] : [...new Set([...cores.keys(), ...BASE_KEYS])]
  .filter((m) => m !== k && navState.has(m) && bayCapacity(m) && distance(k, m) <= DOCK_RANGE * 3).map((m) => ({ name: shipName(m), why: landFault(k, m) })));
// The ship in a shipyard's berth (1-3), and whether a drydocked ship's connection has its power.
const berthShip = (yard, n) => drydocked().find((o) => shipKey(engOf(o).docked || '') === yard && engOf(o).berth === n) || null;
function berthPowered(k) {
  const e = engOf(k);
  if (!e.drydock) return false;
  const f = flow(shipKey(e.docked)), sys = `drydock${e.berth}`;
  return f.demand[sys] > 0 && f.delivered[sys] >= f.demand[sys] - 0.5;
}
function releaseDrydock(k, how) {
  const e = engOf(k);
  if (!e.drydock) return;
  Object.assign(e, { drydock: false, release: null, hold: false, dirty: true });
  opLog(k, `${how} from drydock at ${e.docked}: free to undock`);
  opLog(shipKey(e.docked), `the ${shipName(k)} was ${how} from drydock`);
  for (const u of crewOf(k)) if (u.station === 'Helm' || u.station === 'Captain' || u.station === 'Engineering') send(u, { type: 'notice', text: `Helm: ${how} from drydock at ${e.docked}: free to undock` });
  broadcastOps(shipKey(e.docked));
  gridChanged(k);
}

// Docked vessels are joined by a hard line through the dock: always in data
// link reach of each other, whatever their sensors or subspace relays.
// With a starbase, only while the ship's starbase connection has its ODN tied.
const hardLine = (a, b) => present(a) && present(b) && dockedWith(a).includes(b) && (isBase(b) ? engOf(a).connTies.odn : isBase(a) ? engOf(b).connTies.odn : true);
// Data links, kept up to date: a docked ship with its starbase connection's
// ODN tied has a hard link to it (up whatever its relays, and Ops can't close
// it); that ends only when the tie is cut or the ship undocks. Other links
// drop when a vessel leaves the star system or a subspace relay is down.
// Data links saved with each vessel come back when the relay restarts: once
// both ends are here, if the link still holds (else dropped, saying why).
function restoreLinks(k, names) {
  if (!Array.isArray(names)) return;
  for (const n of names) if (typeof n === 'string' && n) { const l = linkKey(k, shipKey(n)); if (!links.has(l)) pendingLinks.set(l, Date.now()); }
}
// (Links losing or getting back their path are noticed within a second.)
setInterval(() => { relayTick(); lostTick(); }, 1000);
// A link's path down: signal lost (it stays, and either end can close it); back: it carries again.
function lostTick(only) {
  for (const l of only ? [only] : [...links]) {
    if (hardLinks.has(l) || l.split('|').some(isRelay)) continue; // (a relay's links: relayTick keeps them)
    const [a, b] = l.split('|');
    const relayDown = !commsUp(a, 'subspace') || !commsUp(b, 'subspace');
    const lost = !hardLine(a, b) && (!subspaceOk(a, b) || relayDown) && present(a) && present(b);
    if (lost === lostLinks.has(l)) continue;
    if (lost) lostLinks.add(l); else lostLinks.delete(l);
    for (const k of [a, b]) opLog(k, lost ? `data link with the ${shipName(k === a ? b : a)}: signal lost: ${relayDown ? 'a subspace relay is down' : 'left the star system'}` : `data link with the ${shipName(k === a ? b : a)}: signal restored`);
    refreshNetworks([a, b]);
    broadcastAllOps();
    schedulePresence();
  }
}
function linkTick() {
  for (const [l, at] of [...pendingLinks]) {
    const [a, b] = l.split('|');
    if (links.has(l)) { pendingLinks.delete(l); continue; }
    if (!present(a) || !present(b) || !navState.has(a) || !navState.has(b)) {
      if (Date.now() - at > LINK_WAIT_MS) { pendingLinks.delete(l); for (const k of [a, b]) opLog(k, `the data link with the ${shipName(k === a ? b : a)} wasn't restored: it didn't come back`); }
      continue;
    }
    pendingLinks.delete(l);
    if (linkReach(a, b)) {
      addLink(l);
      for (const k of [a, b]) opLog(k, `data link with the ${shipName(k === a ? b : a)} restored`);
      refreshNetworks([a, b]); broadcastAllOps();
    } else {
      const why = !subspaceOk(a, b) ? 'not in the same star system' : 'a subspace relay is down';
      for (const k of [a, b]) opLog(k, `the data link with the ${shipName(k === a ? b : a)} wasn't restored: ${why}`);
      console.log(`data link ${shipName(a)} - ${shipName(b)} not restored: ${why}`);
    }
  }
  for (const [k, e] of eng) {
    const b = e.docked && shipKey(e.docked), l = b && linkKey(k, b);
    if (!b || !hardLine(k, b) || hardLinks.has(l)) continue;
    hardLinks.add(l);
    if (!links.has(l)) {
      addLink(l);
      for (const x of [k, b]) opLog(x, `data link with the ${shipName(x === k ? b : k)} open: hard link: docking port`);
      refreshNetworks([k, b]);
    }
    broadcastAllOps();
  }
  for (const l of [...links]) {
    const [a, b] = l.split('|');
    if (hardLinks.has(l)) {
      if (hardLine(a, b)) continue;
      hardLinks.delete(l);
      const s = isBase(a) ? b : a, base = s === a ? b : a;
      links.delete(l);
      const why = engOf(s).docked && shipKey(engOf(s).docked) === base ? 'its ODN tie was cut' : 'undocked';
      for (const k of [a, b]) opLog(k, `hard link with the ${shipName(k === a ? b : a)} closed: ${why}`);
      refreshNetworks([a, b]);
      broadcastAllOps();
      continue;
    }
    lostTick(l);
  }
}
// A fresh starbase connection: nothing tied (no power, Deu., AM or ODN) until Engineering ties it.
function untieDock(e) {
  e.ties.dock = []; e.ties.dockEps = [];
  e.connTies = { deu: false, am: false, odn: false };
}

// The vessels docked with this one: its starbase and the ship docked with it
// (for a starbase, every ship docked there).
function dockedWith(k) {
  const e = engOf(k), out = [];
  if (e.docked) out.push(shipKey(e.docked));
  for (const [, o] of partners(k)) out.push(o);
  if (isBase(k)) for (const [o, oe] of eng) if (oe.docked && shipKey(oe.docked) === k && cores.has(o)) out.push(o);
  return [...new Set(out)];
}

// Undock the ship at one of our ports (both sides let go).
function undockPort(k, p, why) {
  const t = engOf(k).shipDocks[p];
  if (!t) return;
  engOf(k).shipDocks[p] = null;
  const tp = portFor(t, k);
  if (tp) engOf(t).shipDocks[tp] = null;
  engOf(k).feed[p] = 0; engOf(k).fed[p] = 0; engOf(k).feedEps[p] = 0; engOf(k).fedEps[p] = 0;
  if (tp) { engOf(t).feed[tp] = 0; engOf(t).fed[tp] = 0; engOf(t).feedEps[tp] = 0; engOf(t).fedEps[tp] = 0; } // ships start offering nothing
  for (const [a2, b2] of [[k, t], [t, k]]) { const e2 = engOf(a2); if (e2.transfer && e2.transfer.with === b2) e2.transfer = null; e2.dirty = true; opLog(a2, `undocked from the ${shipName(b2)}: ${why}`); }
  flowCache.delete(k); flowCache.delete(t);
  scheduleNav();
}
// Undock every ship docked with us.
function undockShips(k, why) { for (const p of PORTS) undockPort(k, p, why); }

// The Captain sets (or aborts) the self-destruct.
function selfDestructCommand(ws, msg) {
  const key = ws.shipKey, e = engOf(key);
  if (ws.station !== 'Captain') return send(ws, { type: 'notice', text: 'Only the Captain can order the self-destruct' });
  if (msg.on && !e.selfDestruct) {
    e.selfDestruct = { at: Date.now() + SELF_DESTRUCT_SECS * 1000, by: ws.name };
    opLog(key, `${ws.name}: self-destruct in ${SELF_DESTRUCT_SECS} seconds`);
    for (const u of crewOf(key)) send(u, { type: 'notice', text: `Self-destruct in ${SELF_DESTRUCT_SECS} seconds, by order of ${ws.name}` });
  } else if (!msg.on && e.selfDestruct) {
    e.selfDestruct = null;
    opLog(key, `${ws.name}: self-destruct aborted`);
    for (const u of crewOf(key)) send(u, { type: 'notice', text: `Self-destruct aborted by ${ws.name}` });
  }
  scheduleNav();
}

// Tactical locks a tractor beam on a ship close by with its shields down (or lets go).
function tractorCommand(ws, msg) {
  const key = ws.shipKey, e = engOf(key);
  const note = (text) => send(ws, { type: 'notice', text: `Tactical: ${text}` });
  if (ws.station !== 'Tactical') return send(ws, { type: 'notice', text: 'Only Tactical runs the tractor beam' });
  if (!msg.ship) return e.towing ? releaseTractor(key, `released by ${ws.name}`) : undefined;
  const t = shipKey(clean(msg.ship));
  if (t === key) return note('cannot put a tractor beam on our own ship');
  if (!combatOf(key).locks.includes(t)) return note(`no Tactical lock on the ${shipName(t)}: lock on it first`);
  if (!present(t) || !navState.has(t) || !sensorOk(key, t)) return note(`the ${clean(msg.ship)} is not on sensors`);
  if (distance(key, t) > TRACTOR.range) return note(`the ${shipName(t)} is out of tractor range (${Math.round(distance(key, t))} units; get within ${TRACTOR.range})`);
  if (shields.has(t)) return note(`the ${shipName(t)} has its shields up: the tractor beam can't hold it`);
  if (engOf(t).drydock) return note(`the ${shipName(t)} is in drydock at ${engOf(t).docked}`);
  if (e.drydock) return note(`we are in drydock at ${e.docked}`);
  if (towedBy(key)) return note('we are held in a tractor beam ourselves');
  if (towedBy(t) && towedBy(t) !== key) return note(`the ${shipName(t)} is already in the ${shipName(towedBy(t))}'s tractor beam`);
  if (engOf(t).towing === key) return note(`the ${shipName(t)} has us in its tractor beam`);
  if (e.towing && e.towing !== t) releaseTractor(key, 'switching target');
  e.towing = t;
  flowCache.delete(key);
  if (!flow(key).tractorOk) { e.towing = null; flowCache.delete(key); return note(`not enough power on the EPS for the tractor beam (needs ${TRACTOR.draw})`); }
  if (engOf(t).docked) { opLog(t, `undocked from ${engOf(t).docked} by a tractor beam`); engOf(t).docked = null; engOf(t).dirty = true; flowCache.delete(t); }
  navTargets.delete(t);
  const core = primaryCore.get(t);
  if (core && navState.get(t).warp > 0) send(core, { type: 'core-helm', ship: shipName(t), warp: 0 });
  opLog(key, `${ws.name}: tractor beam on the ${shipName(t)}`);
  opLog(t, `held in the ${shipName(key)}'s tractor beam`);
  for (const u of crewOf(t)) send(u, { type: 'notice', text: `The ${shipName(key)} has us in a tractor beam (raise shields to break free)` });
  note(`tractor beam locked on the ${shipName(t)}: Helm is limited to warp ${TRACTOR.maxWarp} while towing`);
  enforcePower(key);
  scheduleNav();
}

function releaseTractor(k, why) {
  const e = engOf(k), t = e.towing;
  if (!t) return;
  e.towing = null;
  flowCache.delete(k);
  opLog(k, `tractor beam on the ${shipName(t)} released: ${why}`);
  opLog(t, `released from the ${shipName(k)}'s tractor beam: ${why}`);
  tellStations(k, ['Tactical', 'Helm'], `Tactical: tractor beam on the ${shipName(t)} released (${why})`);
  for (const u of crewOf(t)) send(u, { type: 'notice', text: `Released from the ${shipName(k)}'s tractor beam (${why})` });
  scheduleNav();
}

// A call carried by a data link that no longer joins its ships drops to
// radio if they're in range and both radios work; otherwise it ends.
function relinkCalls() {
  const byCid = new Map();
  for (const u of users.values()) if (u.cid && u.state !== 'idle') { if (!byCid.has(u.cid)) byCid.set(u.cid, []); byCid.get(u.cid).push(u); }
  for (const [cid, members] of byCid) {
    if (carriers.get(cid) !== 'link') continue;
    const ships = [...new Set(members.map((u) => u.shipKey))];
    if (ships.length < 2 || ships.every((a) => ships.every((b) => sameNetwork(a, b)))) continue;
    const radio = ships.every((a) => commsUp(a, 'radio') && ships.every((b) => commsOk(a, b)));
    if (radio) { carriers.set(cid, 'radio'); for (const u of members) send(u, { type: 'notice', text: 'Data link lost: the call carries on by radio' }); }
    else { carriers.delete(cid); for (const u of members) send(u, { type: 'force-hangup', reason: 'data link lost, out of radio range' }); }
    scheduleTraffic();
  }
}

// A call in progress needs its carrier's power the whole way: local RF for a
// call aboard, the subspace relays for one over a data link (relinkCalls drops
// a lost link to radio), both radios for one by radio. Without it, it drops.
function dropPowerlessCalls() {
  const byCid = new Map();
  for (const u of users.values()) if (u.cid && u.state !== 'idle') { if (!byCid.has(u.cid)) byCid.set(u.cid, []); byCid.get(u.cid).push(u); }
  for (const [cid, members] of byCid) {
    const ships = [...new Set(members.map((u) => u.shipKey))];
    const via = ships.length < 2 ? 'local' : carriers.get(cid) || 'link';
    const sub = { local: 'rf', link: 'subspace', radio: 'radio' }[via];
    const down = ships.find((k) => !commsUp(k, sub));
    const cutOff = members.find((u) => !commsReach(u));
    if (cutOff && !down) {
      // Someone's console and local RF are both down: they drop out.
      carriers.delete(cid);
      for (const u of members) send(u, { type: 'force-hangup', reason: u === cutOff ? `${COMMS_OFFLINE}` : `${cutOff.name}'s comms went offline` });
      scheduleTraffic();
      continue;
    }
    if (!down) continue;
    carriers.delete(cid);
    const what = { rf: 'local RF', subspace: 'subspace relay', radio: 'radio' }[sub];
    for (const u of members) send(u, { type: 'force-hangup', reason: `the ${shipName(down)}'s ${what} lost power` });
    scheduleTraffic();
  }
}

// The fuel buses, once a second: each moves up to 50 from its tanks with
// Drain on to its tanks with Fill on (all tied in), the systems' tanks first.
// The antimatter bus needs its magnetic containment powered.
function moveFuel(k, e, f) {
  for (const bus of Object.keys(TANKS)) {
    e.busFlow[bus] = 0;
    // Nothing moves on a bus without its transfer power; the antimatter bus also needs its magnetic containment.
    e.busDown[bus] = busDownWhy(e, f, bus);
    if (bus === 'am') e.amBusDown = !!e.busDown.am;
    if (e.busDown[bus]) continue;
    const names = Object.keys(TANKS[bus]).filter((n) => e.tankCfg[`${bus}:${n}`].tied);
    const from = names.filter((n) => e.tankCfg[`${bus}:${n}`].drain && tankLevel(e, bus, n) > 0);
    // An antimatter tank takes antimatter only with its containment powered (the pods: theirs).
    const contained = (n) => bus !== 'am' || (n === 'main' ? e.ties.containment : e.ties[AM_CONTAIN[n]] || []).some((x) => f.totals[x]?.available >= (n === 'main' ? GRID.containment : tankContainDraw(n)));
    const to = names.filter((n) => e.tankCfg[`${bus}:${n}`].fill && tankLevel(e, bus, n) < tankCap(bus, n, e) && contained(n)).sort((a, b) => (a === 'main') - (b === 'main'));
    let budget = FUELBUS.flow;
    for (const n of to) {
      let want = Math.min(budget, tankCap(bus, n, e) - tankLevel(e, bus, n));
      for (const m of from) {
        if (want <= 0) break;
        const t = Math.min(want, tankLevel(e, bus, m));
        setTank(e, bus, m, tankLevel(e, bus, m) - t); setTank(e, bus, n, tankLevel(e, bus, n) + t);
        want -= t; budget -= t; e.busFlow[bus] += t;
      }
      if (budget <= 0) break;
    }
  }
}

// Why a fuel bus can't move anything (or '').
function busDownWhy(e, f, bus) {
  if (!f.xferOk[bus]) return `${bus === 'am' ? 'AM' : 'Deu.'} bus: no transfer power`;
  if (bus === 'am' && !(f.demand.amBus > 0 && f.delivered.amBus >= f.demand.amBus - 0.5)) return 'AM bus: containment offline';
  return '';
}

// Connections, once a second: fuel to and from the starbase and the ships
// docked with us, by each side's Import / Export.
function moveConnections(k, e, f) {
  e.connFlow = {};
  const pct = (x, res) => (100 * x[BUS_RESOURCE[res]]) / ((x.fuelCaps || FUEL)[BUS_RESOURCE[res]] || 1);
  // Antimatter needs the pods' containment powered on the taking side, and the antimatter bus up on ours.
  const amOk = (x, kk) => (x.ties.containment || []).some((n) => flow(kk).totals[n]?.available >= GRID.containment) && !x.amBusDown && x.core !== 'ejected';
  const others = [...(e.docked ? [['station', null]] : []), ...partners(k).map(([, o]) => [o, engOf(o)])];
  for (const [key, them] of others) {
    for (const res of ['deu', 'am']) {
      const r = BUS_RESOURCE[res], mine = wants(connOf(e, key)[res], pct(e, res));
      let moved = 0, why = '';
      if (mine.in) {
        // Taking: from the starbase always; from a ship that's giving.
        const theirs = them ? wants(connOf(them, k)[res], pct(them, res)) : { out: true };
        const room = (e.fuelCaps || FUEL)[r] - e[r], have = them ? them[r] : Infinity;
        if (!them && !e.connTies[res]) why = `not tied to the ${res === 'am' ? 'AM' : 'Deu.'} bus`;
        else if (e.busDown?.[res]) why = e.busDown[res];
        else if (res === 'am' && !amOk(e, k)) why = 'antimatter containment or the antimatter bus is down';
        else if (them?.busDown?.[res]) why = `theirs: ${them.busDown[res]}`;
        else if (!theirs.out) why = 'they aren\'t giving';
        else moved = Math.min(FUEL.transferRate, room, have);
        if (moved > 0) { e[r] += moved; if (them) { them[r] -= moved; them.dirty = true; } }
      } else if (mine.out && !them) {
        // Giving to the starbase: it takes all it's given.
        if (!e.connTies[res]) why = `not tied to the ${res === 'am' ? 'AM' : 'Deu.'} bus`;
        else if (e.busDown?.[res]) why = e.busDown[res];
        else { moved = -Math.min(FUEL.transferRate, e[r]); e[r] += moved; }
      }
      // (Giving to a ship happens when that ship takes it: its own turn.)
      if (moved) { e.dirty = true; e.busFlow[res] += Math.abs(moved); }
      e.connFlow[`${key}:${res}`] = { flow: Math.round(moved), why };
    }
  }
}

// Towed ships follow just behind the ship towing them.
function tow() {
  for (const [k, e] of eng) {
    const t = e.towing;
    if (!t) continue;
    const why = !cores.has(k) || !present(t) ? 'lost contact' : shields.has(t) ? `the ${shipName(t)} raised shields` : !flow(k).tractorOk ? 'not enough power on the EPS' : consoleDarkFor(k, 'Tactical') ? 'no power to Tactical' : null;
    if (why) { releaseTractor(k, why); continue; }
    const n = navState.get(k), m = navState.get(t);
    if (!n || !m) continue;
    const a = (n.heading * Math.PI) / 180;
    const x = Math.min(1000, Math.max(0, n.x - Math.sin(a) * TRACTOR.behind)), y = Math.min(1000, Math.max(0, n.y + Math.cos(a) * TRACTOR.behind));
    if (Math.hypot(m.x - x, m.y - y) < 0.3 && !m.warp) continue;
    Object.assign(m, { x, y, heading: n.heading, warp: 0, dest: null });
    if (isBase(t)) setBasePos(t, x, y); // (a towed starbase: the relay keeps where it is)
    const core = primaryCore.get(t);
    if (core) send(core, { type: 'core-set', ship: shipName(t), set: { moveTo: { x, y, heading: n.heading } } });
  }
}
const consoleDarkFor = (k, station) => flow(k).consoleOk[station] === false;
// Comms and the library need this console powered or the ship's local RF up
// (without either, only proximity chat, which isn't built yet).
const COMMS_OFFLINE = 'Comms offline: no console power or local RF';
const commsReach = (u) => !present(u.shipKey) || isBase(u.shipKey) || !consoleDarkFor(u.shipKey, placeOf(u)) || commsUp(u.shipKey, 'rf');


// A ship is destroyed: it takes ships close by with it (some), and comes back
// docked at a starbase picked at random, good as new.
function destroy(k, cause) {
  // An indestructible design (a starbase's, a relay's: its file says) isn't lost: its safety systems eject the core and the antimatter first.
  if (designOf(k).indestructible) {
    const e = engOf(k);
    Object.assign(e, { core: 'ejected', start: 0, breach: 0, antimatter: 0, contain: { field: 100, reserve: reserveCap() }, dirty: true });
    e.tanks.am.core = 0; e.tanks.deu.core = 0; e.wc.breachT = null; e.wc.actual = 0;
    for (const n of Object.keys(e.tanks.am)) e.tanks.am[n] = 0;
    opLog(k, `${cause}: the safety systems ejected the warp core and antimatter`);
    for (const u of crewOf(k)) send(u, { type: 'notice', text: `Warning: ${cause}. The safety systems ejected the warp core and antimatter.` });
    return;
  }
  const c = combatOf(k);
  if (c.destroying) return;
  c.destroying = true;
  const name = shipName(k);
  for (const o of [...combat.keys()]) if (o !== k && cores.has(o) && distance(k, o) <= BLAST.range) hit(o, BLAST.damage, k, 'the blast');
  const base = SPAWN_BASES[Math.floor(Math.random() * SPAWN_BASES.length)];
  console.log(`the ${name} was destroyed (${cause}); back at ${base.name}`);
  opLog(k, `the ${name} was destroyed: ${cause}. Rebuilt and docked at ${base.name}`);
  for (const u of crewOf(k)) send(u, { type: 'destroyed', ship: name, cause, base: base.name, at: Date.now() });
  for (const [o, oc] of combat) if (oc.locks?.includes(k)) { dropWeaponLock(o, k, 'lost'); tellStations(o, ['Tactical'], `Tactical: the ${name} was destroyed`); }
  releaseTractor(k, `the ${name} was destroyed`);
  const tower = towedBy(k);
  if (tower) releaseTractor(tower, `the ${name} was destroyed`);
  combat.set(k, { ...freshCombat(undefined, torpedoesOf(k)), loaded: true });
  transporters.delete(k);
  for (const [o, t] of transporters) if (t.lock === k && !t.energizing) dropLock(o, `the ${name} was destroyed`);
  undockShips(k, `the ${name} was destroyed`);
  eng.set(k, { ...freshEng(null, { cold: true, k }), docked: base.name }); // rebuilt cold: Engineering brings it up on dock power
  delete engOf(k).restore;
  if (!classOf(k).warpCore) Object.assign(engOf(k), { core: 'ejected', antimatter: 0 }); // (a design without a warp core: none)
  shields.delete(k);
  navTargets.delete(k);
  const nav = navState.get(k);
  if (nav) Object.assign(nav, { x: base.x, y: base.y + 5, warp: 0, dest: null });
  const core = primaryCore.get(k);
  if (core) send(core, { type: 'core-set', ship: name, set: { respawn: { x: base.x, y: base.y + 5 }, combat: savedCombat(k), eng: savedEng(k) } });
  flowCache.delete(k);
  broadcastShips();
  scheduleNav();
}

// --- combat: Tactical's weapons ----------------------------------------------------
//
// Tactical locks onto a ship on sensors (its Tactical and Captain are warned).
// Phasers: arm them and the banks charge (faster with more weapons power;
// armed weapons draw power, unarmed they draw none); a full bank fires.
// Photon torpedoes: a limited supply, restocked only while docked at a
// starbase. Raised shields take the hits, draining their strength (less with
// more shield power) until they fail. Then the hull takes them, and each hit
// damages a system: damage caps that system's power, so damaged sensors see
// less, damaged engines go slower, and so on. With the hull gone the ship is
// destroyed. Everything repairs slowly by itself (faster docked); Engineering
// can direct repairs to one system (or the hull). Shields recharge with
// shield power. The ship's computer keeps the hull, shields and damage.

const PHASER = { range: 150, damage: 15, chargeRate: 20 }; // charge in % a second at full weapons power
const TORPEDO = { range: 300, reload: 5000, damage: 25, carried: 10, restock: 5000 }; // restock: one every 5 s, docked
// Torpedo yield (1-10, a light bar; 5 to start): damage 5 a step, loading 2 s
// plus 0.6 s a step, and 2 antimatter a step from the torpedo bay's tank at
// launch (no antimatter, no launch). A shielded target takes a tenth of it (all
// on its shields); an unshielded one takes it all, and from yield 8 it's
// crippled: a third of the yield in systems, each yield x 10% damaged.
const YIELD = { start: 5, damage: 5, loadBase: 2000, loadStep: 600, antimatter: 2, shielded: 0.1, cripple: 8 };
const torpedoLoad = (y) => YIELD.loadBase + YIELD.loadStep * y;
// Frequencies (1-10): the shields' and the weapons'. A hit on the frequency of
// the target's shields goes straight through them.
const FREQS = 10;
const MIN_SHIELD_STRENGTH = 10;  // shield generators hold from here
const REPAIR = { auto: 0.5, directed: 3, hull: 0.1, hullDirected: 1, docked: 4 }; // per second (docked: times faster)
const UNDER_FIRE_MS = 10000;      // "taking fire" lasts this long after a hit
const SYSTEM_NAMES = { sporeGrow: 'spore cultivation', spore: 'spore drive', phaser1: 'phaser array 1', phaser2: 'phaser array 2', phaser3: 'phaser array 3', phaser4: 'phaser array 4', drydock1: 'drydock connection 1', drydock2: 'drydock connection 2', drydock3: 'drydock connection 3', industrial: 'industrial replicators', engines: 'warp field coils', shields: 'shield generators', sensors: 'long-range sensors', lateral: 'lateral sensor arrays', deflector: 'navigational deflector', bussard: 'Bussard collectors', amBus: 'antimatter bus magnetic containment', sif: 'structural integrity field', idf: 'inertial dampers', lighting: 'emergency lighting', transporter: 'transporter', weapons: 'weapons', atmosphere: 'atmospheric processors', thermal: 'thermal regulation', gravity: 'gravity generators', lights: 'lighting', replicators: 'replicators', recreation: 'recreation (holodecks)', tractor: 'tractor beam', injectors: 'plasma injectors',
  injector: 'antimatter injector',
  conduits: 'power transfer conduits', rf: 'local RF', radio: 'radio', subspace: 'subspace relay', busA: 'Bus A', busB: 'Bus B', busC: 'Bus C', busEPS: 'EPS grid' };
// What a hit can damage: the systems, and the subsystems that fail when badly damaged.
// (Every system and subsystem can be damaged, and phasers can be aimed at any of them.)
const DAMAGEABLE = [...new Set([...SYSTEMS.filter((x) => !BASE_ONLY.includes(x)), ...Object.keys(SUBSYSTEMS), 'conduits', 'injector', 'rf', 'radio', 'subspace', 'busA', 'busB', 'busC', 'busEPS'])];
// What a phaser hit can be aimed at: any system or subsystem (not the buses, batteries or crosslink).
const AIMABLE = DAMAGEABLE.filter((x) => !/^bus/.test(x));
const damageName = (x) => SYSTEM_NAMES[x] || SUBSYSTEMS[x]?.name || x;
const combat = new Map(); // ship key -> { hull, shield, damage, torpedoes, repair, lock, armed, phaserCharge, torpedoAt, restockAt, hitAt, hitBy, dirty }

function freshCombat(saved, carried = TORPEDO.carried) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const num = (v, d, max = 100) => (Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : d);
  return {
    hull: num(s.hull, 100) || 100, shield: num(s.shield, 100),
    damage: Object.fromEntries(DAMAGEABLE.map((k) => [k, num(s.damage?.[k] ?? (LIFE_SUPPORT.includes(k) ? s.damage?.lifeSupport : undefined), 0)])),
    torpedoes: num(s.torpedoes, carried, carried),
    repair: s.repair === 'hull' || DAMAGEABLE.includes(s.repair) ? s.repair : null,
    lock: null, locks: [], aim: {}, arrays: [0, 0, 0, 0], yield: num(s.yield, YIELD.start, 10) || YIELD.start, shieldFreq: num(s.shieldFreq, 1 + Math.floor(Math.random() * FREQS), FREQS) || 1, weaponFreq: num(s.weaponFreq, 1 + Math.floor(Math.random() * FREQS), FREQS) || 1, armed: false, phaserCharge: 0, torpedoAt: 0, restockAt: Date.now(), hitAt: 0, hitBy: null, dirty: false,
  };
}
const torpedoesOf = (k) => designOf(k).torpedoes ?? TORPEDO.carried;
const combatOf = (k) => { if (!combat.has(k)) combat.set(k, freshCombat(isBase(k) || isRelay(k) ? baseSettings[shipName(k)]?.combat : undefined, torpedoesOf(k))); return combat.get(k); };
const round1 = (v) => Math.round(v * 10) / 10;
const savedCombat = (k) => {
  const c = combatOf(k);
  return { hull: round1(c.hull), shield: round1(c.shield), damage: Object.fromEntries(DAMAGEABLE.map((s) => [s, round1(c.damage[s])])), torpedoes: c.torpedoes, repair: c.repair, yield: c.yield, shieldFreq: c.shieldFreq, weaponFreq: c.weaponFreq };
};
// What a ship's computer keeps: its position and settings, plus combat and grid state.
const classGuessed = new Set(); // ships whose class their save never had (shown as the default)
const coreCopy = (k) => (navState.has(k) ? { ...navState.get(k), ...(isBase(k) || classGuessed.has(k) ? {} : { class: classId(k) }), combat: savedCombat(k), eng: savedEng(k) } : undefined);

// The ship's own combat state, for its consoles.
const lockInfo = (k, t) => ({ name: shipName(t), distance: Math.round(distance(k, t)), shields: shields.has(t), shield: Math.round(combatOf(t).shield), hull: Math.round(combatOf(t).hull), aim: combatOf(k).aim[t] || null, aimName: combatOf(k).aim[t] ? damageName(combatOf(k).aim[t]) : null });
// Let go of a lock (and any tow on that target: the tractor beam uses Tactical's targeting).
function dropWeaponLock(k, t, why) {
  const c = combatOf(k);
  if (!c.locks.includes(t)) return;
  c.locks = c.locks.filter((x) => x !== t);
  delete c.aim[t];
  if (c.lock === t) c.lock = c.locks[c.locks.length - 1] || null;
  if (engOf(k).towing === t) releaseTractor(k, `the Tactical lock was ${why}`);
}
function combatView(k) {
  const c = combatOf(k), now = Date.now();
  const t = c.lock && navState.has(c.lock) ? c.lock : null;
  return {
    hull: Math.round(c.hull), shield: Math.round(c.shield),
    damage: Object.fromEntries(DAMAGEABLE.map((s) => [s, Math.ceil(c.damage[s])])),
    repair: c.repair, torpedoes: c.torpedoes, carried: torpedoesOf(k),
    phaser: { range: PHASER.range, armed: c.armed, charge: Math.floor(Math.max(...c.arrays.slice(0, arraysOf(k)))), arrays: c.arrays.slice(0, arraysOf(k)).map(Math.floor) },
    torpedo: { range: TORPEDO.range, ready: Math.max(0, c.torpedoAt - now), reload: torpedoLoad(c.yield), yield: c.yield, antimatter: YIELD.antimatter * c.yield, bay: Math.floor(engOf(k).tanks?.am?.torpedo || 0) },
    freq: { shields: c.shieldFreq, weapons: c.weaponFreq, max: FREQS },
    lock: t ? lockInfo(k, t) : null,
    // Every lock (the phasers' and the tractor beam's targets), each with what its phasers are aimed at.
    locks: c.locks.filter((x) => navState.has(x)).map((x) => lockInfo(k, x)), lockMax: lockMax(k), aimable: AIMABLE.map((x) => [x, damageName(x)]),
    lockedBy: [...combat].filter(([o, oc]) => oc.locks?.includes(k) && present(o)).map(([o]) => shipName(o)),
    underFire: now - c.hitAt < UNDER_FIRE_MS ? c.hitBy : null,
  };
}

const tellStations = (k, stations, text) => { for (const u of crewOf(k)) if (stations.includes(u.station)) send(u, { type: 'notice', text }); };

// A ship's systems changed (damage, repair, the grid): keep it within what it has.
function enforcePower(k) {
  flowCache.delete(k);
  const p = powerOf(k);
  if (shields.has(k) && p.shields < MIN_SHIELD_POWER) { shields.delete(k); opLog(k, 'shields down: not enough power to the shield generators'); broadcastShips(); }
  const nav = navState.get(k), core = primaryCore.get(k);
  if (nav && core && !speedOk(k, nav.warp)) {
    const l = speedLimits(k);
    const warp = nav.warp >= 1 ? l.warp || l.impulse : l.impulse;
    if (!warp) navTargets.delete(k);
    send(core, { type: 'core-helm', ship: shipName(k), warp });
  }
}

// A hit on ship t from ship `from`. Returns what happened, for the firing ship.
function hit(t, dmg, from, what = '', aim = null, { torpedo = false, yield: y = 0, freq = null } = {}) {
  const c = combatOf(t);
  c.hitAt = Date.now();
  c.hitBy = shipName(from);
  c.dirty = true;
  // On the frequency of its shields: straight through them.
  const through = freq != null && freq === c.shieldFreq && shields.has(t);
  if (torpedo && shields.has(t) && !through) dmg *= YIELD.shielded; // (a shielded target takes a tenth of a torpedo)
  let rest = dmg;
  const said = through ? ['on their shield frequency: straight through'] : [];
  if (shields.has(t) && !through) {
    // Shield strength drained per point of damage: less with more shield power.
    const drain = (dmg * 60) / Math.max(MIN_SHIELD_POWER, powerOf(t).shields) / designOf(t).shields; // (by its design: a starbase's hold three times a Galaxy's)
    if (c.shield > drain || torpedo) { c.shield = Math.max(0, c.shield - drain); rest = 0; } else { rest = dmg * (1 - c.shield / drain); c.shield = 0; } // (a torpedo's tenth all goes on the shields)
    said.push(`their shields at ${Math.round(c.shield)}%`);
    if (c.shield <= 0) {
      shields.delete(t);
      opLog(t, `shields failed under fire from the ${shipName(from)}`);
      tellStations(t, ['Tactical', 'Captain'], 'Tactical: shields have failed');
      broadcastShips();
      said.push('shields down');
    }
  }
  if (rest > 0) {
    c.hull = Math.max(0, c.hull - rest);
    const sys = aim && AIMABLE.includes(aim) ? aim : DAMAGEABLE[Math.floor(Math.random() * DAMAGEABLE.length)]; // (phasers can be aimed)
    c.damage[sys] = Math.min(100, c.damage[sys] + rest * 2);
    // A high-yield torpedo on an unshielded target cripples it: more systems, badly damaged.
    if (torpedo && y >= YIELD.cripple && !shields.has(t)) {
      const more = DAMAGEABLE.filter((x) => x !== sys).sort(() => Math.random() - 0.5).slice(0, Math.max(1, Math.floor(y / 3)));
      for (const x of more) c.damage[x] = Math.min(100, (c.damage[x] || 0) + y * 10);
      said.push(`crippled: ${more.map(damageName).join(', ')}`);
      tellStations(t, ['Engineering', 'Captain'], `Engineering: crippled by a torpedo: ${more.map(damageName).join(', ')} badly damaged`);
    }
    said.push(`hull ${Math.round(c.hull)}%`, `${damageName(sys)} damaged`);
    opLog(t, `hit by the ${shipName(from)}${what ? ` (${what})` : ''}: hull ${Math.round(c.hull)}%, ${damageName(sys)} damaged`);
    tellStations(t, ['Engineering'], `Engineering: ${damageName(sys)} damaged (${Math.ceil(c.damage[sys])}%)`);
    if (c.hull <= 0) {
      said.push('destroyed');
      opLog(from, `the ${shipName(t)} was destroyed`);
      destroy(t, `destroyed by the ${shipName(from)}`);
      return said.join(', ');
    }
    enforcePower(t);
  }
  return said.join(', ');
}

function combatCommand(ws, msg) {
  const key = ws.shipKey, c = combatOf(key);
  const note = (text) => send(ws, { type: 'notice', text: `Tactical: ${text}` });

  if (msg.type === 'repair') {
    if (ws.station !== 'Engineering') return send(ws, { type: 'notice', text: 'Only Engineering directs repairs' });
    c.repair = msg.system === 'hull' || DAMAGEABLE.includes(msg.system) ? msg.system : null;
    c.dirty = true;
    const what = c.repair ? `repair crews to the ${c.repair === 'hull' ? 'hull' : damageName(c.repair)}` : 'repair crews spread across the ship';
    opLog(key, `Engineering (${ws.name}): ${what}`);
    send(ws, { type: 'notice', text: `Engineering: ${what}` });
    scheduleNav();
    return;
  }

  if (ws.station !== 'Tactical') return send(ws, { type: 'notice', text: 'Only Tactical controls the weapons' });

  if (msg.type === 'arm') {
    c.armed = !!msg.on;
    if (!c.armed) c.arrays = [0, 0, 0, 0]; // the arrays bleed off
    opLog(key, `${ws.name}: phasers ${c.armed ? 'armed' : 'stood down'}`);
    gridChanged(key);
    return note(c.armed ? 'phasers armed, banks charging' : 'phasers stood down');
  }

  // Locks: tap a contact to lock on (or let go); { ship: null } lets go of them all.
  // { type: 'aim', ship, system } aims the phasers at one of its systems (null: anywhere).
  if (msg.type === 'lock') {
    if (!msg.ship) {
      for (const t of [...c.locks]) dropWeaponLock(key, t, 'released');
      if (c.lock) opLog(key, `${ws.name}: weapons locks released`);
      c.lock = null;
      scheduleNav();
      return note('weapons locks released');
    }
    const t = shipKey(clean(msg.ship));
    if (c.locks.includes(t) && msg.on !== true) {
      dropWeaponLock(key, t, 'released');
      opLog(key, `${ws.name}: weapons lock on the ${shipName(t)} released`);
      scheduleNav();
      return note(`weapons lock on the ${shipName(t)} released`);
    }
    if (t === key) return note('cannot target our own ship');
    // (A starbase can be locked, for the tractor beam: the weapons won't fire on one.)
    if (!present(t) || !navState.has(t) || !(isBase(t) || sensorOk(key, t))) return note(`the ${clean(msg.ship)} is not on sensors`);
    if (c.locks.includes(t)) { c.lock = t; scheduleNav(); return; }
    if (c.locks.length >= lockMax(key)) return note(`all ${lockMax(key)} locks in use: release one first`);
    c.locks.push(t);
    c.lock = t;
    opLog(key, `${ws.name}: weapons locked on the ${shipName(t)}`);
    opLog(t, `the ${shipName(key)} has locked weapons on us`);
    tellStations(t, ['Tactical', 'Captain'], `Tactical: the ${shipName(key)} has locked weapons on us`);
    scheduleNav();
    return note(`weapons locked on the ${shipName(t)}`);
  }
  // Torpedo yield (1-10) and the frequencies (1-10) of our weapons and shields.
  if (msg.type === 'yield') {
    c.yield = Math.max(1, Math.min(10, Math.round(Number(msg.value) || YIELD.start))); c.dirty = true; scheduleNav();
    return note(`torpedo yield ${c.yield}: ${YIELD.antimatter * c.yield} antimatter a torpedo, ${torpedoLoad(c.yield) / 1000} s to load`);
  }
  if (msg.type === 'frequency') {
    const f = (v) => Math.max(1, Math.min(FREQS, Math.round(Number(v))));
    if (Number.isFinite(Number(msg.weapons))) c.weaponFreq = f(msg.weapons);
    if (Number.isFinite(Number(msg.shields))) c.shieldFreq = f(msg.shields);
    c.dirty = true; scheduleNav();
    return note(`weapon frequency ${c.weaponFreq}, shield frequency ${c.shieldFreq}`);
  }
  if (msg.type === 'aim') {
    const t = shipKey(clean(msg.ship || ''));
    if (!c.locks.includes(t)) return note(`no lock on the ${clean(msg.ship)}`);
    if (msg.system == null) delete c.aim[t];
    else if (AIMABLE.includes(msg.system)) c.aim[t] = msg.system;
    else return note('no such system to aim at');
    scheduleNav();
    return note(`phasers aimed at the ${shipName(t)}'s ${c.aim[t] ? damageName(c.aim[t]) : 'hull (anywhere)'}`);
  }

  if (msg.type === 'fire') {
    const torpedo = msg.weapon === 'torpedo';
    const w = torpedo ? TORPEDO : PHASER, what = torpedo ? 'torpedo' : 'phaser';
    const t = msg.ship ? shipKey(clean(msg.ship)) : c.lock;
    if (!t) return note('no target: lock weapons first');
    if (!c.locks.includes(t)) return note(`no lock on the ${clean(msg.ship)}: lock on it first`);
    if (isBase(t)) return note(`${shipName(t)} is a Federation starbase: the weapons won't fire on it`);
    if (!cores.has(t) || !sensorOk(key, t)) { dropWeaponLock(key, t, 'lost'); scheduleNav(); return note('target lost'); }
    const d = distance(key, t);
    if (d > w.range) return note(`the ${shipName(t)} is out of ${what} range (${Math.round(d)} units; get within ${w.range})`);
    const now = Date.now();
    if (torpedo) {
      if (c.torpedoes <= 0) return note('no torpedoes left: restock at a starbase');
      if (now < c.torpedoAt) return note('torpedo tubes reloading');
      // Loaded with antimatter just before launch, from the torpedo bay's tank.
      const am = YIELD.antimatter * c.yield, e = engOf(key);
      if ((e.tanks.am.torpedo || 0) < am) return note(`not enough antimatter in the torpedo bay for yield ${c.yield} (needs ${am}, has ${Math.floor(e.tanks.am.torpedo || 0)})`);
      e.tanks.am.torpedo -= am; e.dirty = true;
      c.torpedoes--;
      c.torpedoAt = now + torpedoLoad(c.yield);
      c.dirty = true;
    } else {
      if (!c.armed) return note('phasers are not armed');
      // A charged array fires (a starbase has four).
      const i = c.arrays.slice(0, arraysOf(key)).findIndex((x) => x >= 100);
      if (i < 0) return note(`phaser ${arraysOf(key) > 1 ? 'arrays' : 'array'} charging (${Math.floor(Math.max(...c.arrays.slice(0, arraysOf(key))))}%)`);
      c.arrays[i] = 0;
    }
    const result = hit(t, torpedo ? YIELD.damage * c.yield : w.damage, key, torpedo ? `torpedo, yield ${c.yield}` : 'phasers', torpedo ? null : c.aim[t], { torpedo, yield: c.yield, freq: c.weaponFreq });
    opLog(key, `${ws.name} fired ${torpedo ? 'a torpedo' : 'phasers'} at the ${shipName(t)}: ${result}`);
    note(`${torpedo ? 'torpedo' : 'phaser'} hit on the ${shipName(t)}: ${result}`);
    scheduleNav();
  }
}

// Once a second: the grid (batteries, the core starting, containment, the
// self-destruct countdown, docking), shields recharge, repairs, phaser banks
// charge, torpedoes restock while docked, locks lost when the target leaves
// sensor range. The ship's computers get a copy every few seconds.
let combatTick = 0;
setInterval(() => {
  combatTick++;
  checkTransporterLocks();
  scienceTick();
  automationTick();
  dropPowerlessCalls();
  const now = Date.now();
  let changed = false;
  for (const k of new Set([...cores.keys(), ...BASE_KEYS, ...RELAY_KEYS])) {
    if (!navState.has(k)) continue;
    const c = combatOf(k), e = engOf(k);
    const state = () => JSON.stringify([c.hull, c.shield, c.damage, c.torpedoes, c.repair, c.arrays.map(Math.floor), c.locks, e.core, e.start, e.breach, Math.round(Object.values(e.stores).reduce((a, b) => a + b, 0) / 30), e.docked, e.shipDocks, Math.floor(e.antimatter), Math.floor(e.deuterium), e.transfer?.left, e.drives]);
    const before = state();
    flowCache.delete(k);
    const f = flow(k);

    // Self-destruct: containment off, and the core goes.
    if (e.selfDestruct && now >= e.selfDestruct.at) { destroy(k, `self-destruct, by order of ${e.selfDestruct.by}`); changed = true; continue; }
    // Containment: the feeds hold the field (and recharge the reserve); short
    // of them, the reserve; with neither the field falls, and below 20% it breaches.
    // The other antimatter tanks: the same, each on its own (no countdown: below 20% it breaches).
    let gone = false;
    for (const name of Object.keys(AM_CONTAIN)) {
      const ct = e.tankContain[name], draw = tankContainDraw(name), cap = draw * CONTAIN.reserveSecs;
      if (!(e.tanks.am[name] > 0)) { ct.field = 100; continue; }
      const fromFeed = Math.min(draw, f.tankFeed[name]), fromReserve = Math.min(ct.reserve, draw - fromFeed);
      ct.reserve = Math.min(cap, ct.reserve - fromReserve + Math.max(0, f.tankFeed[name] - draw));
      const held = fromFeed + fromReserve >= draw - 1e-6;
      if (!held && ct.field >= 100 - 1e-6) tellStations(k, ['Engineering', 'Captain'], `Engineering: containment failing on the ${TANKS.am[name].label.toLowerCase()}'s antimatter (no power, reserve exhausted)`);
      ct.field = Math.max(0, Math.min(100, ct.field + (held ? CONTAIN.rise : -CONTAIN.fall)));
      if (ct.field < CONTAIN.breach) { destroy(k, `antimatter containment lost: the ${TANKS.am[name].label.toLowerCase()}`); changed = true; gone = true; break; }
    }
    if (gone) continue;
    if (e.antimatter > 0) {
      const ct = e.contain, wasReserve = e.onReserve;
      const fromFeed = Math.min(GRID.containment, f.containFeed);
      const fromReserve = Math.min(ct.reserve, GRID.containment - fromFeed);
      ct.reserve = Math.min(reserveCap(), ct.reserve - fromReserve + Math.max(0, f.containFeed - GRID.containment));
      e.onReserve = fromReserve > 0;
      if (e.onReserve && !wasReserve) { opLog(k, 'antimatter containment on its internal reserve'); tellStations(k, ['Engineering', 'Captain'], `Engineering: antimatter containment on its internal reserve (${Math.round(ct.reserve / GRID.containment)} s): restore its feed`); }
      const held = fromFeed + fromReserve >= GRID.containment - 1e-6;
      const before = ct.field;
      const hot = e.core === 'online' && e.wc.temp > CORE.hot; // a hot core wears the field down
      ct.field = Math.max(0, Math.min(100, ct.field + (hot ? -CORE.heat : held ? CONTAIN.rise : -CONTAIN.fall)));
      if (!held && before >= 100 - 1e-6) { e.breach = 1; opLog(k, 'antimatter containment failing: no power, reserve exhausted'); for (const u of crewOf(k)) send(u, { type: 'notice', text: 'Warning: antimatter containment failing (no power, reserve exhausted): restore power or eject the core' }); }
      // A live reaction: under 35% a 45 s breach countdown (cancelled over 60%, or
      // if the reaction stops); otherwise the pods go below 20%.
      const live = e.core === 'online' || e.core === 'starting';
      if (live && ct.field < CORE.breachField && e.wc.breachT == null) { e.wc.breachT = CORE.breachSecs; opLog(k, `WARP CORE BREACH IN ${CORE.breachSecs} s`); for (const u of crewOf(k)) send(u, { type: 'notice', text: `Warning: warp core breach in ${CORE.breachSecs} seconds: restore containment, SCRAM the core, or eject it` }); }
      if (e.wc.breachT != null && (!live || ct.field > CORE.cancelField)) { e.wc.breachT = null; opLog(k, 'warp core breach averted'); tellStations(k, ['Engineering', 'Captain'], 'Engineering: warp core breach averted'); }
      if (e.wc.breachT != null && --e.wc.breachT <= 0) { destroy(k, 'warp core breach'); changed = true; continue; }
      if (!live && ct.field < CONTAIN.breach) { destroy(k, 'warp core breach: antimatter containment lost'); changed = true; continue; }
      if (held && e.breach && ct.field >= 100) { e.breach = 0; opLog(k, 'antimatter containment restored'); tellStations(k, ['Engineering', 'Captain'], 'Engineering: antimatter containment restored'); }
      if (!held) e.breach = 1;
    } else { e.contain.field = 100; e.breach = 0; e.onReserve = false; e.wc.breachT = null; }
    // The warp core: starting up, and running, need its constriction, pump and injector.
    const coreWhy = () => ['constriction', 'injector', 'amConduit'].filter((x) => !f.subOk[x]).map((x) => SUBSYSTEMS[x].name).join(', ');
    const coreDown = (why) => { e.core = 'offline'; e.start = 0; e.wc.actual = 0; e.dirty = true; opLog(k, `warp core shut down: ${why}`); tellStations(k, ['Engineering', 'Captain'], `Engineering: warp core shut down (${why})`); };
    if ((e.core === 'starting' || e.core === 'online') && (e.tanks.deu.core <= 0 || e.tanks.am.core <= 0)) coreDown(`flameout: its ${e.tanks.deu.core <= 0 ? 'deuterium' : 'antimatter'} tank ran dry`);
    else if (e.core === 'starting') {
      if (!f.coreSubsOk) { e.core = 'offline'; e.start = 0; e.wc.actual = 0; opLog(k, `warp core ignition failed: no power to its ${coreWhy()}`); tellStations(k, ['Engineering'], `Engineering: warp core ignition failed, no power to its ${coreWhy()}`); }
      else if (++e.start >= CORE.sustainSecs) { e.core = 'online'; e.start = 0; e.dirty = true; opLog(k, 'warp core online: the reaction is self-sustaining'); tellStations(k, ['Engineering', 'Captain'], 'Engineering: warp core online, the reaction is self-sustaining'); }
    } else if (e.core === 'online' && !f.coreSubsOk) coreDown(`no power to its ${coreWhy()}`);
    // The reaction: rate toward its setting; heat, the dilithium's alignment and the crystal's wear.
    { const w = e.wc;
      if (e.core === 'online') {
        w.actual = w.actual < w.rate ? Math.min(w.rate, w.actual + CORE.ramp) : Math.max(w.rate, w.actual - CORE.ramp);
        if (w.actual <= 0) coreDown('reaction rate brought to 0');
        w.align = w.autoTrim && coresOnline(k) === COMPUTERS.length ? 100 : Math.max(0, w.align - (w.actual / 100) * 0.5);
        if (w.actual > 80) w.crystal = Math.max(0, w.crystal - ((w.actual - 80) / 20) * 0.02);
      }
      w.temp = Math.round((w.temp + ((e.core === 'online' ? w.actual : e.core === 'starting' ? 5 : 0) - w.temp) * 0.2) * 10) / 10;
      if (w.autoTrim && coresOnline(k) < COMPUTERS.length) { w.autoTrim = false; tellStations(k, ['Engineering'], 'Engineering: dilithium auto-trim off: it needs all three computer cores'); }
    }
    // Overdrive: a system drawing past its rating wears itself out.
    for (const sys of SYSTEMS) if (f.delivered[sys] > 100 && !BASE_ONLY.includes(sys)) {
      const was = c.damage[sys];
      c.damage[sys] = Math.min(100, c.damage[sys] + (f.delivered[sys] - 100) * OVERDRIVE_DAMAGE);
      if (Math.floor(was / 10) !== Math.floor(c.damage[sys] / 10)) tellStations(k, ['Engineering'], `Engineering: ${SYSTEM_NAMES[sys]} overdriven (${Math.round(f.delivered[sys])}%), damage ${Math.ceil(c.damage[sys])}%`);
    }
    // Computer cores: boot by themselves (in stages) once tied and getting
    // power; lose power and they crash, booting again when it's back.
    e.computers.forEach((cc, i) => {
      if (cc.state !== 'booting' && cc.state !== 'online') {
        const ts = e.ties[`sub:${COMPUTERS[i]}`] || [];
        if (!ts.some((n) => f.totals[n].available - f.totals[n].used >= COMPUTER.draw)) return;
        // (Try it: only boot if it would actually get its power, so a marginal bus doesn't boot and crash it over and over.)
        const was = cc.state;
        cc.state = 'booting'; cc.t = 0; flowCache.delete(k);
        if (!flow(k).subOk[COMPUTERS[i]]) { cc.state = was; flowCache.delete(k); return; }
        e.dirty = true; opLog(k, `computer core ${i + 1} booting`);
        return;
      }
      if (!f.subOk[COMPUTERS[i]]) { cc.state = 'crashed'; cc.t = 0; e.dirty = true; opLog(k, `computer core ${i + 1} crashed: power lost`); tellStations(k, ['Engineering'], `Engineering: computer core ${i + 1} crashed (power lost): it boots again when power returns`); return; }
      if (cc.state === 'booting' && ++cc.t >= COMPUTER.bootSecs) { cc.state = 'online'; cc.t = 0; e.dirty = true; opLog(k, `computer core ${i + 1} online`); tellStations(k, ['Engineering'], `Engineering: computer core ${i + 1} online`); }
    });
    // The fuel buses: tanks with Fill on take from tanks with Drain on (the
    // antimatter bus only with its magnetic containment powered).
    moveFuel(k, e, f);
    // Fusion reactors: lit on bus power, then running on it (or on the EPS,
    // tap on); a dry tank or no power and they flame out.
    for (const [rn, rr] of reactorsOf(e)) {
      const label = reactorLabel(rn);
      const out = (why) => { rr.state = 'off'; rr.start = 0; e.dirty = true; opLog(k, `${label} shut down: ${why}`); tellStations(k, ['Engineering'], `Engineering: ${label} shut down (${why})`); };
      if (rr.state === 'off') continue;
      if (tankLevel(e, 'deu', rn) <= 0) { out('flameout: its deuterium tank ran dry'); continue; }
      if (rr.state === 'starting') {
        if (!f.subOk[`${rn}Chamber`]) { out('the chamber has no power to light'); continue; }
        if (++rr.start >= GRID.impulseStartSecs) { rr.state = 'running'; rr.start = 0; e.dirty = true; opLog(k, `${label} running`); tellStations(k, ['Engineering'], `Engineering: ${label} running`); }
      } else if (!(rr.epsTap && e.epsLive) && !f.subOk[`${rn}Chamber`]) { out('no power to its chamber: tie it in, or turn its EPS tap on'); continue; }
      setTank(e, 'deu', rn, tankLevel(e, 'deu', rn) - FUEL.impulseBurn);
    }
    // The EPS manifold: energized once pressurized, collapsed when the pressure's gone.
    if (!e.epsLive && e.stores.pressure + f.charging.EPS >= GRID.epsCap - 1e-6) { e.epsLive = true; e.dirty = true; opLog(k, 'EPS manifold pressurized: the EPS is energized'); tellStations(k, ['Engineering'], 'Engineering: EPS manifold pressurized: the EPS is energized'); }
    else if (e.epsLive && e.stores.pressure - f.storeUsed.EPS + f.charging.EPS <= 0) { e.epsLive = false; e.dirty = true; opLog(k, 'EPS collapsed: manifold pressure lost'); tellStations(k, ['Engineering'], 'Engineering: EPS collapsed (manifold pressure lost): it has to be pressurized again'); }
    // Impulse builds toward what Helm asked for, at the driver coils' rate.
    { const nv = navState.get(k), want = e.impulseWant || 0, core = primaryCore.get(k);
      if (want > 0 && nv && nv.warp < 1 && nv.warp < want - 1e-6 && (core || isBase(k))) {
        const lim = speedLimits(k), next = Math.min(want, lim.impulse, nv.warp + impulseRate(k));
        if (next > nv.warp + 1e-6) { if (isBase(k)) baseHelm(k, { warp: Math.round(next * 1000) / 1000 }); else send(core, { type: 'core-helm', ship: shipName(k), warp: Math.round(next * 1000) / 1000 }); }
      }
      // A starbase under way: the relay flies it (impulse only), and drops to all stop without impulse.
      if (isBase(k) && nv && nv.warp > 0) { if (!speedLimits(k).impulse) baseHelm(k, { warp: 0 }); baseMove(k); }
    }
    tripBreakers(k);
    // Batteries.
    for (const [name, node] of Object.entries(STORES)) e.stores[name] = Math.max(0, Math.min(node === 'EPS' ? GRID.epsCap : GRID.batteryCap, e.stores[name] - f.storeUsed[node] + f.charging[node]));
    for (const n of EMERG.names) if (f.emergUsed[n] > 0) { e.emerg[n] = Math.max(0, e.emerg[n] - f.emergUsed[n]); e.dirty = true; }
    // The Bussard collectors, at warp: deuterium from space.
    { const w = navState.get(k)?.warp || 0;
      if (w >= 1 && f.delivered.bussard > 0) e.deuterium = Math.min(e.fuelCaps?.deuterium ?? FUEL.deuterium, e.deuterium + BUSSARD.perSecond * (Math.min(9, w) / 9) * Math.min(1, f.delivered.bussard / 100)); }
    // Fuel: the core burns antimatter and deuterium for what it gives, the impulse reactor deuterium.
    // The core burns from its own tanks.
    if (f.coreUsed > 0) { const burn = (f.coreUsed / GRID.core) * FUEL.coreBurn; setTank(e, 'am', 'core', e.tanks.am.core - burn); setTank(e, 'deu', 'core', e.tanks.deu.core - burn); }
    // Connections: fuel to and from what we're docked with.
    moveConnections(k, e, f);
    // Docking ends when the ship moves off.
    const nav = navState.get(k);
    // Docked with ships: a computer restarting on either side doesn't undock
    // them (30 s grace); moving apart breaks only that connection.
    for (const p of PORTS) {
      const o = e.shipDocks[p];
      if (!o) continue;
      if (!cores.has(o) || !navState.has(o)) { if (!e.partnerGoneAt[p]) e.partnerGoneAt[p] = now; if (now - e.partnerGoneAt[p] > 30000) undockPort(k, p, 'lost contact'); continue; }
      e.partnerGoneAt[p] = 0;
      if (nav.warp > 0 || navState.get(o).warp > 0 || distance(k, o) > DOCK_RANGE) undockPort(k, p, 'moved apart');
    }
    // Spore cultivation: a unit every SPORE.growSecs while the chambers have their power.
    if (classOf(k).spore && !isBase(k) && e.spores < SPORE.cap && f.demand.sporeGrow > 0 && f.delivered.sporeGrow >= 0.9 * f.demand.sporeGrow) {
      e.spores = Math.min(SPORE.cap, e.spores + 1 / SPORE.growSecs); e.dirty = true;
    }
    // The spore drive: a jump charging, while the drive has its power; then the ship is there.
    if (e.spore?.charging) {
      const why = sporeFault(k);
      if (why && !/cooling down/.test(why)) { e.spore.charging = false; e.spore.t = 0; tellStations(k, ['Helm', 'Engineering'], `Helm: spore jump aborted: ${why}`); }
      else if (f.demand.spore > 0 && f.delivered.spore >= (SPORE.need * f.demand.spore) / 100) {
        if (++e.spore.t >= SPORE.chargeSecs) {
          const d = e.spore.dest, n = navState.get(k);
          Object.assign(n, { x: d.x, y: d.y, warp: 0, dest: null });
          engOf(k).impulseWant = 0; autopilots.delete(k); navTargets.delete(k);
          const core = primaryCore.get(k);
          if (core) send(core, { type: 'core-set', ship: shipName(k), set: { moveTo: { x: d.x, y: d.y, heading: n.heading } } });
          e.spore = { charging: false, t: 0, dest: null, ready: now + SPORE.cooldownSecs * 1000, loaded: 0 }; e.dirty = true;
          opLog(k, `spore jump: arrived at ${d.name ? d0(d.name) : `${Math.round(d.x)}, ${Math.round(d.y)}`}`);
          for (const u of crewOf(k)) send(u, { type: 'notice', text: `Spore jump complete: at ${d.name ? d0(d.name) : `${Math.round(d.x)}, ${Math.round(d.y)}`}` });
          changed = true;
        }
      } // (short of power: it waits, charging no further)
    }
    // Landed in a bay: the craft rides along with its mothership.
    if (e.landed && navState.has(e.landed) && navState.has(k)) {
      const mn = navState.get(e.landed), n0 = navState.get(k);
      if (Math.hypot(mn.x - n0.x, mn.y - n0.y) > 0.01 || n0.warp) {
        Object.assign(n0, { x: mn.x, y: mn.y, heading: mn.heading, warp: 0, dest: null });
        const core = primaryCore.get(k);
        if (core) send(core, { type: 'core-set', ship: shipName(k), set: { moveTo: { x: mn.x, y: mn.y, heading: mn.heading } } });
      }
    }
    // A docking request not answered in time lapses.
    const req = dockRequests.get(k);
    if (req && now > req.until) { dockRequests.delete(k); for (const u of crewOf(req.from)) if (u.station === 'Helm') send(u, { type: 'notice', text: `Helm: the ${shipName(k)} didn't answer the docking request` }); }
    if (e.docked) {
      const base = STARBASES.find((b) => b.name === e.docked);
      if (!base || nav.warp > 0 || Math.hypot(nav.x - base.x, nav.y - base.y) > DOCK_RANGE) { opLog(k, `departed ${e.docked}`); e.docked = null; e.dirty = true; }
    }

    const p = powerOf(k);
    if (c.shield < 100 && p.shields > 0) c.shield = Math.min(100, c.shield + (2 * p.shields) / 100);
    const fast = e.drydock && berthPowered(k) ? REPAIR.docked : 1; // (fast repairs only in drydock, its connection powered)
    // Release from drydock: once the time's up, with no repair job under way, unless the shipyard holds it.
    if (e.drydock && e.release && now >= e.release && !e.hold && !c.repair) releaseDrydock(k, 'released');
    for (const s of DAMAGEABLE) if (c.damage[s] > 0 && !(f.delivered[s] > 100)) c.damage[s] = Math.max(0, c.damage[s] - (c.repair === s ? REPAIR.directed : REPAIR.auto) * fast);
    if (c.hull < 100) c.hull = Math.min(100, c.hull + (c.repair === 'hull' ? REPAIR.hullDirected : REPAIR.hull) * fast);
    if (c.repair && (c.repair === 'hull' ? c.hull >= 100 : c.damage[c.repair] <= 0)) {
      tellStations(k, ['Engineering'], `Engineering: ${c.repair === 'hull' ? 'hull' : damageName(c.repair)} repaired`);
      c.repair = null;
    }
    if (c.armed) for (let i = 0; i < arraysOf(k); i++) if (c.arrays[i] < 100) c.arrays[i] = Math.min(100, c.arrays[i] + (PHASER.chargeRate * (f.delivered[PHASER_ARRAYS[i]] || 0)) / 100);
    if (!e.docked || c.torpedoes >= torpedoesOf(k)) c.restockAt = now;
    else if (now - c.restockAt >= TORPEDO.restock) { c.torpedoes++; c.restockAt = now; }
    for (const t of [...c.locks]) if (!present(t) || !(isBase(t) || sensorOk(k, t))) {
      opLog(k, `weapons lock on the ${shipName(t)} lost`);
      tellStations(k, ['Tactical'], `Tactical: weapons lock on the ${shipName(t)} lost (out of sensor range)`);
      dropWeaponLock(k, t, 'lost');
      changed = true;
    }
    if (state() !== before || e.selfDestruct) { c.dirty = true; changed = true; enforcePower(k); }
    { const sig = linkedTo(k).join(','); if (sig !== e.linkSig) { if (e.linkSig !== undefined) e.dirty = true; e.linkSig = sig; } } // (saved when its links change)
    if ((c.dirty || e.dirty) && combatTick % 5 === 0 && isBase(k)) { c.dirty = e.dirty = false; saveBaseSettings(); }
    if ((c.dirty || e.dirty) && combatTick % 5 === 0 && primaryCore.has(k)) {
      send(primaryCore.get(k), { type: 'core-set', ship: shipName(k), set: { combat: savedCombat(k), eng: savedEng(k) } });
      c.dirty = e.dirty = false;
    }
  }
  if (changed) scheduleNav();
}, 1000).unref();


// Station commands, from a console (or a console remote-controlling another vessel).
// --- per-panel automation ----------------------------------------------------------
//
// Ops picks which panels run themselves (never Ops itself). An automated panel
// works through its list, a step a second, while a computer core is online and
// its console is on the ODN; it never repairs anything, can't be run by remote
// control, and any tap on it by hand hands it back (Auto off). Each step goes
// through the same commands a crewman's taps do, so the same rules hold.
const AUTO_PANELS = ['engineering', 'lifeSupport', 'tactical', 'science', 'transporter', 'comms', 'hangar', 'medical'];
const AUTO_STATION = { engineering: 'Engineering', lifeSupport: 'Engineering', tactical: 'Tactical', science: 'Science', transporter: 'Transporter', comms: 'Communications', hangar: 'Shuttle Bay', medical: 'Medical' };
const AUTO_BUILT = new Set(AUTO_PANELS);
const AUTO_NAMES = { engineering: 'Engineering', lifeSupport: 'Life support', tactical: 'Tactical', science: 'Science', transporter: 'Transporter', comms: 'Communications', hangar: 'Hangar control', medical: 'Medical: holographic doctor' };
// The holographic doctor (Medical's automation): it runs while a computer core is
// online, Medical is on the ODN and the sickbay holo-emitters have power (10 while
// it's active; without them it goes offline). Every 2 s it greets, answers
// Medical's readiness checks, treats sickbay's patients (one at a time,
// discharged after EMH.treatSecs) and warns of crew at risk from life support.
const EMH_ID = 'emh';
const EMH = { draw: 10, treatSecs: Number(process.env.EMH_TREAT_SECS) || 60 };
const emhActive = (k) => !isBase(k) && autoOn(k, 'medical') && hasStation(k, 'Medical') && coresOnline(k) && odnLinked(k, 'Medical') && flow(k).subOk.holoEmitters !== false;
// The panel a crewman's command works (to hand it back when they tap it).
function panelOfCommand(station, msg) {
  const t = msg.type;
  if (station === 'Engineering' && t === 'grid') return msg.ls ? 'lifeSupport' : 'engineering';
  if (station === 'Tactical' && ['shields', 'lock', 'aim', 'yield', 'frequency', 'fire', 'arm', 'tractor'].includes(t)) return 'tactical';
  if (station === 'Science' && ['scan', 'sci-lock', 'plot-course'].includes(t)) return 'science';
  if (station === 'Transporter' && ['transporter-lock', 'beam', 'transporter-diagnostic'].includes(t)) return 'transporter';
  if (station === 'Communications' && /^link-/.test(t)) return 'comms';
  if (station === 'Shuttle Bay' && t === 'bay-doors') return 'hangar';
  return null;
}
const autoOn = (k, p) => !!engOf(k).auto?.[p];
function setAuto(k, p, v, why) {
  const e = engOf(k);
  if (!!e.auto[p] === !!v && e.auto[p] === v) return;
  e.auto[p] = p === 'engineering' ? v || null : !!v;
  e.autoStatus[p] = v ? 'starting' : '';
  (e.autoStep ||= {})[p] = 0;
  e.dirty = true;
  opLog(k, `automation: ${AUTO_NAMES[p]}${p === 'engineering' && v ? ` (${v})` : ''} ${v ? 'on' : `off${why ? `: ${why}` : ''}`}`);
  if (p === 'medical') { e.emh = { greeted: false, tick: 0, treating: null, warned: '' }; flowCache.delete(k); broadcastCrew(k); }
  if (!v) tellStations(k, [AUTO_STATION[p]], `Automation: ${AUTO_NAMES[p]} off${why ? ` (${why})` : ''}`);
  broadcastOps(k); scheduleNav();
}
// A stand-in for a console, for an automated panel: its commands go the usual way.
function automaton(k, station) {
  const a = { shipKey: k, ship: shipName(k), station, name: 'Automation', automaton: true, readyState: 1, OPEN: 1, last: '' };
  a.send = (data) => { try { const m = JSON.parse(data); if (m.type === 'notice') a.last = m.text; } catch {} };
  return a;
}
// Engineering's lists: a step is { what, done(), act() } (act may only wait).
function engineeringSteps(k, mode) {
  const e = engOf(k), a = automaton(k, 'Engineering'), g = (m) => gridCommand(a, m);
  const docked = !!e.docked, tied = (key) => (e.ties[key] || []).length > 0;
  const defaults = { ...DEFAULT_LOAD_TIES, ...(isBase(k) ? {} : classOf(k).ties || {}) };
  // (What this vessel has: its class's systems and stations; a starbase's own.)
  const has = (x) => {
    if (!aboardKey(k, x)) return false; // (only what its design has)
    if (x.startsWith('console:')) return hasStation(k, x.slice(8));
    if (!x.startsWith('system:')) return true;
    const sys = x.slice(7);
    if (isBase(k)) return !WARP_DRIVE.includes(sys);
    return (!BASE_ONLY.includes(sys) || (sys === 'phaser2' && arraysOf(k) >= 2)) && (sys !== 'transporter' || classOf(k).transporter) && (!WARP_DRIVE.includes(sys) || classOf(k).maxWarp);
  };
  // What each conduit carries once the ship's loads are tied as usual (its places reached through too).
  const conduitWant = () => {
    const want = {};
    const add = (c, nodes) => { want[c] = NODES.filter((n) => (want[c] || []).includes(n) || nodes.includes(n)); };
    for (const [x, d] of Object.entries({ ...defaults, containment: [] })) if (has(x)) for (const c of conduitsOf(k, x)) add(c, d || []);
    for (const c of Object.keys(want).filter((x) => x.startsWith('place:'))) for (const up of conduitsOf(k, c)) add(up, want[c]);
    return want;
  };
  const loadKeys = Object.keys(DEFAULT_LOAD_TIES).filter((x) => x !== 'console:Engineering' && !/^sub:computer/.test(x) && (defaults[x] || []).length && has(x));
  const startup = [
    { what: 'dock power on Bus B, imported', done: () => !docked || e.core === 'online' || (e.ties.dock.includes('B') && connOf(e, 'station').power.imp), /* (with the warp core running, the ship doesn't need it) */ act: () => g({ ties: { dock: ['B'] }, conn: { with: 'station', res: 'power', imp: true } }) },
    { what: "the batteries' breakers closed", done: () => BUSES.every((X) => e.breakers[X]), act: () => g({ breaker: { bus: BUSES.find((X) => !e.breakers[X]), on: true } }) },
    { what: 'the A-B crosslink', done: () => ['A', 'B'].every((X) => e.ties.crosslink.includes(X)), act: () => g({ ties: { crosslink: [...new Set([...e.ties.crosslink, 'A', 'B'])] } }) },
    // (The power paths first: each location and parent system tied to the buses its loads will use.)
    { what: 'the power paths: each location and parent system tied in', done: () => Object.entries(conduitWant()).every(([c, w]) => w.every((n) => (e.ties[c] || []).includes(n))),
      act: () => g({ ties: Object.fromEntries(Object.entries(conduitWant()).map(([c, w]) => [c, NODES.filter((n) => w.includes(n) || (e.ties[c] || []).includes(n))])) }) },
    { what: 'the Engineering console and the computer cores tied in', done: () => tied('console:Engineering') && COMPUTERS.every((x) => tied(`sub:${x}`)), act: () => g({ ties: { 'console:Engineering': ['A'], 'sub:computer1': ['A'], 'sub:computer2': ['B'], 'sub:computer3': ['C'] } }) },
    { what: 'antimatter containment fed', done: () => tied('containment'), act: () => g({ ties: { containment: ['A'] } }) },
    { what: 'the fuel buses up, and supplies coming aboard', done: () => tied('sub:deuTransfer') && tied('sub:amTransfer') && tied('system:amBus') && Object.values(AM_CONTAIN).every((x) => tied(x)) && Object.entries(e.tankCfg).every(([n, c]) => c.tied && (n.endsWith(':main') ? c.drain : c.fill)) && (!docked || (e.connTies.deu && e.connTies.am && connOf(e, 'station').deu.imp && connOf(e, 'station').am.imp)),
      act: () => {
        // (The antimatter bus's containment works once the EPS is energized; each antimatter tank keeps its own.)
        g({ ties: { 'sub:deuTransfer': ['B'], 'sub:amTransfer': ['B'], 'system:amBus': ['EPS'], ...Object.fromEntries(Object.values(AM_CONTAIN).map((x) => [x, ['A']])) } });
        for (const n of Object.keys(e.tankCfg)) { const [bus, name] = n.split(':'); g({ tank: { bus, name, tied: true, ...(name === 'main' ? { drain: true } : { fill: true }) } }); }
        if (docked) { g({ connTie: { res: 'deu', on: true } }); g({ connTie: { res: 'am', on: true } }); g({ conn: { with: 'station', res: 'deu', imp: true } }); g({ conn: { with: 'station', res: 'am', imp: true } }); }
      } },
    ...DRIVES.map((d) => ({ what: `the ${d} impulse drive running, feeding the EPS`, done: () => e.drives[d].state === 'running' && tied(driveSource(d)) && tied(`thrusters${d[0].toUpperCase()}${d.slice(1)}`), act: () => {
      if (!tied(`sub:${d}Chamber`)) return g({ ties: { [`sub:${d}Chamber`]: ['B'] } });
      // (Its output reaches the EPS through its maneuvering thrusters' tie.)
      if (!tied(driveSource(d)) || !tied(`thrusters${d[0].toUpperCase()}${d.slice(1)}`)) return g({ ties: { [driveSource(d)]: ['EPS'], [`thrusters${d[0].toUpperCase()}${d.slice(1)}`]: ['EPS'] } });
      if (e.drives[d].state === 'off' && tankPct(e, 'deu', d) >= FUELBUS.light) g({ reactor: { name: d, on: true } });
      else if (e.drives[d].state === 'off') a.last = `waiting for its deuterium tank (${Math.round(tankPct(e, 'deu', d))}%)`;
    } })),
    { what: 'the EPS energized', done: () => e.epsLive, act: () => { a.last = 'waiting for the manifold to pressurize'; } },
    ...AUX.map((x, i) => ({ what: `aux fusion reactor ${i + 1} running`, done: () => e.aux[x].state === 'running' && tied(x), act: () => {
      if (!tied(`sub:${x}Chamber`)) return g({ ties: { [`sub:${x}Chamber`]: [i ? 'B' : 'A'] } });
      if (!tied(x)) return g({ ties: { [x]: ['EPS'] } }); // (its output to the EPS)
      if (e.aux[x].state === 'off' && tankPct(e, 'deu', x) >= FUELBUS.light) g({ reactor: { name: x, on: true } });
      else if (e.aux[x].state === 'off') a.last = `waiting for its deuterium tank (${Math.round(tankPct(e, 'deu', x))}%)`;
    } })),
    { what: 'the EPS taps open', done: () => BUSES.filter((X) => X !== 'C').every((X) => e.taps[X] >= busMaxOf(k)[X]), act: () => { const X = BUSES.filter((x) => x !== 'C').find((x) => e.taps[x] < busMaxOf(k)[x]); g({ tap: { bus: X, amount: busMaxOf(k)[X] } }); } },
    { what: 'the consoles and systems tied in (the warp core needs the structural integrity field)', done: () => loadKeys.every((x) => tied(x)), act: () => g({ ties: Object.fromEntries(loadKeys.filter((x) => !tied(x)).map((x) => [x, defaults[x]])) }) },
    { what: 'the warp core online', done: () => e.core === 'online' || e.core === 'ejected' || !classOf(k).warpCore, act: () => {
      if (['constriction', 'injector', 'amConduit'].some((x) => !tied(`sub:${x}`))) return g({ ties: { 'sub:constriction': ['A'], 'sub:injector': ['A'], 'sub:amConduit': ['A'] } });
      if (e.core !== 'offline') return;
      if (tankPct(e, 'am', 'core') < FUELBUS.light || tankPct(e, 'deu', 'core') < FUELBUS.light) { a.last = `waiting for its tanks (antimatter ${Math.round(tankPct(e, 'am', 'core'))}%, deuterium ${Math.round(tankPct(e, 'deu', 'core'))}%)`; return; }
      g({ core: 'start' });
    } },
    { what: 'off dock power', done: () => !docked || e.core !== 'online' || (!e.ties.dock.length && !connOf(e, 'station').power.imp), act: () => g({ ties: { dock: [] }, conn: { with: 'station', res: 'power', imp: false } }) },
  ];
  const systemTanks = Object.keys(e.tankCfg).filter((n) => !n.endsWith(':main'));
  const shutdown = [
    // (Dock power on the buses and the EPS first: it keeps the fuel buses working while everything else comes down.)
    { what: 'dock power on Bus B and the EPS, imported', done: () => !docked || (e.ties.dock.includes('B') && e.ties.dockEps.includes('EPS') && connOf(e, 'station').power.imp && connOf(e, 'station').eps.imp),
      act: () => g({ ties: { dock: ['B'], dockEps: ['EPS'] }, conn: { with: 'station', res: 'power', imp: true } }) || g({ conn: { with: 'station', res: 'eps', imp: true } }) },
    { what: 'the warp core shut down', done: () => e.core !== 'online' && e.core !== 'starting', act: () => g({ core: 'stop' }) },
    ...[...AUX, ...DRIVES].map((x) => ({ what: `the ${reactorLabel(x)} shut down`, done: () => (DRIVES.includes(x) ? e.drives[x] : e.aux[x]).state === 'off', act: () => g({ reactor: { name: x, on: false } }) })),
    // (Every tank drains into the main storage, which is offloaded to the starbase as it fills.)
    { what: 'antimatter and deuterium offloaded to the starbase', done: () => amAboard(e) <= 0 && e.deuterium <= 0 && systemTanks.every((n) => { const [bus, name] = n.split(':'); return bus !== 'deu' || tankLevel(e, bus, name) <= 0; }), act: () => {
      if (!docked) { a.last = 'dock at a starbase to offload the antimatter and deuterium'; return; }
      for (const n of Object.keys(e.tankCfg)) { const [bus, name] = n.split(':'), c = e.tankCfg[n]; if (!c.tied || (name === 'main' ? !c.fill : !c.drain)) g({ tank: { bus, name, tied: true, ...(name === 'main' ? { fill: true } : { drain: true }) } }); }
      if (!e.connTies.deu || !e.connTies.am) { g({ connTie: { res: 'deu', on: true } }); g({ connTie: { res: 'am', on: true } }); }
      if (!connOf(e, 'station').deu.exp || !connOf(e, 'station').am.exp) { g({ conn: { with: 'station', res: 'deu', imp: false, exp: true } }); g({ conn: { with: 'station', res: 'am', imp: false, exp: true } }); }
      a.last = `offloading (antimatter ${Math.round(amAboard(e))}, deuterium ${Math.round(e.deuterium + systemTanks.filter((n) => n.startsWith('deu:')).reduce((t, n) => t + tankLevel(e, 'deu', n.slice(4)), 0))})`;
    } },
    { what: 'the EPS taps closed', done: () => BUSES.every((X) => !e.taps[X]), act: () => g({ tap: { bus: BUSES.find((X) => e.taps[X]), amount: 0 } }) },
    { what: 'the consoles and systems untied', done: () => loadKeys.every((x) => !tied(x)), act: () => g({ ties: Object.fromEntries(loadKeys.filter((x) => tied(x)).map((x) => [x, []])) }) },
    { what: 'containment off (no antimatter aboard)', done: () => !tied('containment'), act: () => { if (amAboard(e) > 0) { a.last = 'antimatter still aboard'; return; } g({ ties: { containment: [] } }); } },
    { what: "the batteries' breakers open, crosslink off", done: () => BUSES.every((X) => !e.breakers[X]) && !e.ties.crosslink.length, act: () => { const X = BUSES.find((x) => e.breakers[x]); if (X) g({ breaker: { bus: X, on: false } }); else g({ ties: { crosslink: [] } }); } },
    // (Last, dock power off: cold iron, nothing tied but the ODN. The computer cores go down with it, and with them this list.)
    { what: 'dock power off: cold iron', done: () => !e.ties.dock.length && !e.ties.dockEps.length && !connOf(e, 'station').power.imp && !connOf(e, 'station').eps.imp,
      act: () => { g({ ties: { 'console:Engineering': [], 'sub:computer1': [], 'sub:computer2': [], 'sub:computer3': [], dock: [], dockEps: [] }, conn: { with: 'station', res: 'power', imp: false } }); g({ conn: { with: 'station', res: 'eps', imp: false } }); for (const r of ['deu', 'am']) g({ conn: { with: 'station', res: r, imp: false, exp: false } }); } },
  ];
  return { steps: mode === 'shutdown' ? shutdown : startup, a };
}
// The other panels' routines: each looks at what should be so and, a step at
// a time, makes it so; they keep going (they don't finish). Each returns its status.
const bayRequests = new Map(); // craft key -> { m: mothership key, kind: 'land' | 'takeoff', at }
function panelRoutine(k, p) {
  const e = engOf(k), c = combatOf(k);
  if (p === 'medical') return doctorRoutine(k, e);
  if (p === 'lifeSupport') {
    // Atmosphere, heat, gravity and lights on where there are people, off where there aren't.
    const a = automaton(k, 'Engineering');
    const here = new Set(crewOf(k).map(placeOf));
    for (const l of locationsOf(k)) for (const x of LS_SYSTEMS) {
      const want = here.has(l);
      if (!!e.ls[l]?.[x] !== want) { gridCommand(a, { ls: { sys: x, loc: l, on: want } }); return `${SYSTEM_NAMES[x]} ${want ? 'on' : 'off'} at ${l}`; }
    }
    return `holding: life support on in ${here.size} occupied place${here.size === 1 ? '' : 's'}, off elsewhere`;
  }
  if (p === 'tactical') {
    // Red alert: shields up, phasers armed, the weapons on a locked target's (scanned) shield frequency. Yellow: shields up, phasers safe.
    const level = alertOf(k), a = automaton(k, 'Tactical');
    if (level === 'green') return 'condition green: standing by';
    if (!shields.has(k)) { shieldsCommand(a, { up: true }); return a.last ? `raising shields (${a.last.replace(/^Tactical: /, '')})` : 'shields up'; }
    if (level === 'red' && !c.armed) { combatCommand(a, { type: 'arm', on: true }); return 'phasers armed'; }
    if (level === 'yellow' && c.armed) { combatCommand(a, { type: 'arm', on: false }); return 'phasers stood down'; }
    const t = c.lock;
    if (level === 'red' && t && shields.has(t) && locatable(k, t).resolved && c.weaponFreq !== combatOf(t).shieldFreq) { combatCommand(a, { type: 'frequency', weapons: combatOf(t).shieldFreq }); return `weapons on the ${shipName(t)}'s shield frequency (${combatOf(t).shieldFreq})`; }
    return `${level} alert: shields up${level === 'red' ? ', phasers armed' : ''}`;
  }
  if (p === 'science') {
    // A sensor lock on the nearest contact that isn't on our data network.
    const net = network(k);
    const near = [...cores.keys()].filter((o) => o !== k && !isBase(o) && navState.has(o) && sensorOk(k, o) && !net.has(o)).sort((x, y) => distance(k, x) - distance(k, y))[0];
    if (!near) { if (sciLocks.has(k)) { sciLocks.delete(k); tellScience(k, { type: 'sci-lock', ship: null }); } return 'no unknown contacts on sensors'; }
    if (sciLocks.get(k) !== near) { sciLocks.set(k, near); opLog(k, `Science (automation): sensors locked on the ${shipName(near)}`); tellScience(k, { type: 'sci-lock', ship: shipName(near) }); }
    return `tracking the ${shipName(near)} (${Math.round(distance(k, near))} units)`;
  }
  if (p === 'transporter') {
    // The level-3 diagnostic kept passed: run again whenever it's been invalidated.
    const d = e.trDiag;
    if (d.state === 'passed') return 'level-3 diagnostic passed: ready';
    if (d.state === 'running') return `level-3 diagnostic running (${d.t} of ${TR.diagSecs} s)`;
    const fault = transporterFault(k) || (flow(k).subOk.energizingCoils === false ? 'no power to its energizing coils' : null);
    if (fault) return `waiting: ${fault}`;
    transporterDiagnostic(automaton(k, 'Transporter'));
    return 'running the level-3 diagnostic';
  }
  if (p === 'comms') {
    // Data link requests from ships already on our network: accepted.
    const net = network(k);
    const req = [...linkRequests.values()].find((r) => r.toShip === k && net.has(r.fromShip));
    if (req) {
      linkRequests.delete(req.id);
      if (linkReach(k, req.fromShip)) {
        addLink(linkKey(req.fromShip, k));
        opLog(req.fromShip, `the ${shipName(k)} accepted: data link open`);
        opLog(k, `Communications (automation): accepted the data link from the ${shipName(req.fromShip)}`);
        refreshNetworks([k]); broadcastAllOps();
        return `accepted the data link from the ${shipName(req.fromShip)}`;
      }
    }
    return 'accepting data links from ships already on our network';
  }
  if (p === 'hangar') {
    // Doors open for a craft asking to land or take off (room, and the containment field powered); closed after.
    const now = Date.now(), a = automaton(k, 'Shuttle Bay');
    for (const [o, r] of [...bayRequests]) if (now - r.at > 60000 || (r.kind === 'land' ? engOf(o).landed === k : engOf(o).landed !== k)) bayRequests.delete(o);
    const asking = [...bayRequests].filter(([, r]) => r.m === k);
    const room = landedIn(k).length < bayCapacity(k);
    if (asking.length && !e.bayOpen) {
      if (asking.every(([, r]) => r.kind === 'land') && !room) return 'a landing request, but the bay is full';
      flowCache.delete(k);
      crewCommand(a, { type: 'bay-doors', open: true });
      if (e.bayOpen && flow(k).subOk.bayField === false) { crewCommand(a, { type: 'bay-doors', open: false }); return 'waiting: the containment field has no power'; }
      e.bayActive = now;
      return `doors opening for the ${asking.map(([o]) => shipName(o)).join(', ')}`;
    }
    if (asking.length) { e.bayActive = now; return `doors open for the ${asking.map(([o]) => shipName(o)).join(', ')}`; }
    if (e.bayOpen && now - (e.bayActive || 0) > 10000) { crewCommand(a, { type: 'bay-doors', open: false }); return 'doors closed'; }
    return e.bayOpen ? 'doors open' : 'doors closed: standing by';
  }
  return '';
}
// The holographic doctor's list, a step every 2 s (the first that has something to do).
function doctorRoutine(k, e) {
  const d = (e.emh ||= { greeted: false, tick: 0, treating: null, warned: '' });
  if (!d.shown) { d.shown = true; broadcastCrew(k); }
  if (d.tick++ % 2) return e.autoStatus.medical || 'standing by in sickbay';
  const say = (stations, text) => tellStations(k, stations, `The Doctor: ${text}`);
  // 1. Activated: the greeting.
  if (!d.greeted) { d.greeted = true; say(['Medical'], 'Please state the nature of the medical emergency.'); opLog(k, 'the holographic doctor activated'); return 'activated'; }
  // 2. A readiness check for Medical: Ready.
  const rc = readiness.get(k)?.Medical;
  if (rc && !rc.ready.has(EMH_ID)) { rc.ready.add(EMH_ID); scheduleNav(); return 'readiness: Medical ready'; }
  // 3. Sickbay's patients, one at a time: treated, then discharged fit for duty.
  const patients = crewOf(k).filter((u) => u.sickbay);
  if (d.treating && !patients.some((u) => u.id === d.treating.id)) d.treating = null;
  if (!d.treating && patients.length) d.treating = { id: patients[0].id, since: Date.now() };
  if (d.treating) {
    const u = users.get(d.treating.id), left = Math.ceil(EMH.treatSecs - (Date.now() - d.treating.since) / 1000);
    if (left > 0) return `treating ${u.name} (${left} s)`;
    u.sickbay = false; d.treating = null;
    send(u, { type: 'notice', text: 'The Doctor: you are discharged from sickbay, fit for duty' });
    say(['Medical', 'Captain'], `${u.name} discharged from sickbay, fit for duty`);
    opLog(k, `the holographic doctor discharged ${u.name} from sickbay`);
    broadcastCrew(k);
    return `discharged ${u.name}`;
  }
  // 4. Life support: crew at risk (warned once a problem).
  const g = gridView(k), p = powerOf(k), here = new Set(crewOf(k).map(placeOf));
  const airless = Object.entries(g.ls || {}).filter(([l, x]) => here.has(l) && !x.got.atmosphere).map(([l]) => l);
  const risk = airless.length ? `no atmosphere at ${airless.join(', ')}` : p.lifeSupport < 50 ? `life support at ${p.lifeSupport}%` : '';
  if (risk !== d.warned) { d.warned = risk; if (risk) { say(['Captain', 'Medical'], `crew at risk: ${risk}`); return `warned: crew at risk (${risk})`; } }
  return 'standing by in sickbay';
}
// Once a second: every automated panel takes its next step.
function automationTick() {
  for (const [k, e] of eng) {
    if (!e.auto || !present(k) || !navState.has(k)) continue;
    const was = JSON.stringify(e.autoStatus);
    automateVessel(k, e);
    if (JSON.stringify(e.autoStatus) !== was) { broadcastOps(k); scheduleNav(); } // (ops and the station see what it's doing)
  }
}
function automateVessel(k, e) {
  {
    for (const p of AUTO_PANELS) {
      if (!e.auto[p]) continue;
      const station = AUTO_STATION[p];
      // (A list that's all done ends, cores or no cores: Shutdown ends with them down.)
      const finish = () => { const doneMsg = e.auto.engineering === 'startup' ? 'Ready for departure' : 'Cold ship'; setAuto(k, p, null, doneMsg); e.autoStatus[p] = doneMsg; tellStations(k, ['Engineering', 'Captain'], `Engineering (automation): ${doneMsg}`); };
      // (A list goes forward: a step it has passed isn't gone back to. Shutdown undoes its first step at the end.)
      const from = e.autoStep?.[p] || 0;
      const next = p === 'engineering' ? engineeringSteps(k, e.auto.engineering).steps.slice(from).find((st) => !st.done()) : null;
      if (p === 'engineering' && !next) { finish(); continue; }
      if (!coresOnline(k)) { e.autoStatus[p] = `waiting: no computer core online${next ? ` (next: ${next.what})` : ''}`; continue; }
      if (!odnLinked(k, station)) { e.autoStatus[p] = `waiting: the ${station} console is off the ODN`; continue; }
      if (p === 'medical' && flow(k).subOk.holoEmitters === false) { setAuto(k, p, false, 'EMH offline: no power to the holo-emitters'); tellStations(k, ['Medical', 'Captain'], 'Medical: EMH offline (no power to the holo-emitters)'); continue; }
      if (p !== 'engineering') { try { e.autoStatus[p] = panelRoutine(k, p); } catch (err) { e.autoStatus[p] = `stopped: ${err.message}`; console.warn(`automation ${p}: ${err.stack}`); } continue; }
      if (p === 'engineering') {
        flowCache.delete(k);
        const { steps, a } = engineeringSteps(k, e.auto.engineering);
        const i = steps.findIndex((st, n) => n >= from && !st.done());
        if (i < 0) { finish(); continue; }
        (e.autoStep ||= {})[p] = i;
        steps[i].act();
        if (steps.slice(i).every((st) => st.done())) { finish(); continue; }
        e.autoStatus[p] = `step ${i + 1} of ${steps.length}: ${steps[i].what}${a.last ? ` (${a.last.replace(/^Engineering: /, '')})` : ''}`;
      }
    }
  }
}

function stationCommand(ws, msg) {
  const t = msg.type;
  // A tap by hand on an automated panel hands it back.
  { const p = !ws.automaton && panelOfCommand(ws.station, msg); if (p && autoOn(ws.shipKey, p)) setAuto(ws.shipKey, p, null, `${ws.name} took over`); }
  // Off the ODN, the station's controls do nothing (answering an order needs no console).
  const odnOff = !odnLinked(ws.shipKey, placeOf(ws)) && !['order-ack', 'order-decline'].includes(t);
  if (odnOff && ['shields', 'beam', 'transporter-lock', 'transporter-diagnostic', 'helm', 'autopilot', 'spore-jump', 'scan', 'sci-lock', 'plot-course', 'power', 'alert', 'order', 'reassign', 'lockout', 'confine', 'sickbay', 'emh', 'forcefield', 'brig-field', 'person-field', 'bay-doors', 'readiness', 'lock', 'aim', 'yield', 'frequency', 'fire', 'repair', 'arm', 'grid', 'tractor', 'dock', 'self-destruct'].includes(t)) {
    send(ws, { type: 'notice', text: 'Disconnected from the optical data network' });
    return true;
  }
  const gate = (fn) => { if (consoleDark(ws)) darkNote(ws); else fn(ws, msg); return true; };
  if (t === 'shields') return shieldsCommand(ws, msg), true;
  if (t === 'beam') return beamCommand(ws, msg), true;
  if (t === 'transporter-lock') return transporterLock(ws, msg), true;
  if (t === 'transporter-diagnostic') return transporterDiagnostic(ws), true;
  if (['helm', 'autopilot', 'spore-jump', 'scan', 'sci-lock', 'plot-course'].includes(t)) return gate(navCommand);
  if (t === 'power') return navCommand(ws, msg), true;
  if (t === 'order-ack' || t === 'order-decline') return crewCommand(ws, msg), true; // answering an order needs no console
  if (['alert', 'order', 'reassign', 'lockout', 'confine', 'sickbay', 'emh', 'forcefield', 'brig-field', 'person-field', 'bay-doors', 'readiness'].includes(t)) return gate(crewCommand);
  if (['lock', 'aim', 'yield', 'frequency', 'fire', 'repair', 'arm'].includes(t)) return gate(combatCommand);
  if (t === 'grid') return gridCommand(ws, msg), true; // emergency power: works with the console dark
  if (t === 'tractor') return gate(tractorCommand);
  if (t === 'dock') return gate(dockCommand);
  if (t === 'self-destruct') return gate(selfDestructCommand);
  return false;
}

// Remote control. Like controls like: a console can run the same station
// aboard another vessel over a working data link while that station there is
// unmanned (whoever else is aboard), unless that vessel's ops have blocked it.
// Command prefixes: each vessel's 5-digit code (Ops sets it; 00000 from the
// factory), needed to take over one of its stations by remote control, manned
// or not. Three wrong tries lock that vessel out for 60 s (its Ops are told).
// A new prefix ends every remote session that used the old one.
const PREFIX = { tries: 3, lockMs: (Number(process.env.PREFIX_LOCK_SECS) || 60) * 1000, factory: '00000' };
const prefixFails = new Map(); // "fromKey|toKey" -> { n, until }
function remoteOk(ws, t) {
  if (!t || t === ws.shipKey || !present(t) || !links.has(linkKey(ws.shipKey, t)) || linkLost(linkKey(ws.shipKey, t))) return false;
  if (ws.station === 'Crew') return false;
  if ([...users.values()].some((u) => u !== ws && u.controlling === t && u.station === ws.station)) return false; // someone else has it
  if (AUTO_PANELS.some((p) => AUTO_STATION[p] === ws.station && autoOn(t, p))) return false; // (an automated station runs itself)
  // Blocked by that vessel's ops; a starbase's block holds even with nobody at its ops.
  return !(engOf(t).remoteBlock && (opsOf(t).length || isBase(t)));
}
const remoteVessels = (ws) => linkedTo(ws.shipKey).filter((t) => remoteOk(ws, t) || ws.controlling === t);
// A stand-in for the console, aboard the vessel it controls.
function actorFor(ws) {
  const a = Object.create(ws);
  a.shipKey = ws.controlling;
  a.ship = shipName(ws.controlling);
  a.send = (data) => ws.send(data);
  return a;
}
// The crew at a station someone's overriding from another vessel are told (and when it ends).
const tellOverride = (ws, t, on) => { for (const u of crewOf(t)) if (u.station === ws.station && u !== ws) send(u, { type: 'override', by: on ? ws.ship : null, station: ws.station }); };
function endRemote(ws, why) {
  const t = ws.controlling;
  if (!t) return;
  tellOverride(ws, t, false);
  ws.controlling = null; ws.remotePrefix = null;
  send(ws, { type: 'notice', text: `Remote control of the ${shipName(t)} ended${why ? `: ${why}` : ''}` });
  if (ws.operator) broadcastOps(ws.shipKey);
}
function controlCommand(ws, msg) {
  const t = msg.ship ? shipKey(clean(msg.ship)) : null;
  if (!t || t === ws.shipKey) {
    if (ws.controlling) opLog(ws.controlling, `${ws.name} (${ws.ship}) released remote control of ${ws.station}`);
    endRemote(ws);
  } else {
    if (!remoteOk(ws, t)) return send(ws, { type: 'notice', text: `Remote control: can't run the ${shipName(t)}'s ${ws.station} (needs a data link, and its ops not blocking)` });
    // The command prefix, entered on the keypad.
    const fk = `${ws.shipKey}|${t}`, fails = prefixFails.get(fk);
    if (fails?.until > Date.now()) return send(ws, { type: 'notice', text: `Remote control: locked out of the ${shipName(t)} for ${Math.ceil((fails.until - Date.now()) / 1000)} s (wrong command prefix)` });
    if (String(msg.prefix ?? '') !== engOf(t).prefix) {
      const n = (fails && !(fails.until > 0) ? fails.n : 0) + 1;
      prefixFails.set(fk, { n: n >= PREFIX.tries ? 0 : n, until: n >= PREFIX.tries ? Date.now() + PREFIX.lockMs : 0 });
      if (n >= PREFIX.tries) {
        opLog(t, `the ${ws.ship} entered a wrong command prefix ${PREFIX.tries} times: locked out for ${PREFIX.lockMs / 1000} s`);
        tellStations(t, ['Captain', 'Communications'], `Security: the ${ws.ship} tried our command prefix ${PREFIX.tries} times: locked out`);
        return send(ws, { type: 'notice', text: `Remote control: wrong command prefix (${PREFIX.tries} tries): locked out of the ${shipName(t)} for ${PREFIX.lockMs / 1000} s` });
      }
      return send(ws, { type: 'notice', text: `Remote control: wrong command prefix for the ${shipName(t)} (${PREFIX.tries - n} ${PREFIX.tries - n === 1 ? 'try' : 'tries'} left)` });
    }
    prefixFails.delete(fk);
    if (ws.controlling && ws.controlling !== t) endRemote(ws);
    ws.controlling = t; ws.remotePrefix = engOf(t).prefix;
    if (ws.operator) broadcastOps(t);
    const manned = crewOf(t).some((u) => u.station === ws.station);
    opLog(t, `${ws.name} of the ${ws.ship} took remote control of ${ws.station} over the data link${manned ? ' (override)' : ''}`);
    if (manned) tellOverride(ws, t, true);
    send(ws, { type: 'notice', text: `Remote control: running the ${shipName(t)}'s ${ws.station}${manned ? ' (override: it was manned)' : ''}` });
  }
  scheduleNav();
}
// Consoles whose remote control no longer holds go back to their own ship.
function checkRemotes() {
  for (const u of users.values()) {
    const t = u.controlling;
    if (!t) continue;
    const prefixChanged = u.remotePrefix !== engOf(t).prefix;
    if (remoteOk(u, t) && !prefixChanged) continue;
    endRemote(u, !links.has(linkKey(u.shipKey, t)) ? 'the data link dropped' : prefixChanged ? 'its command prefix changed' : engOf(t).remoteBlock ? 'its ops blocked remote control' : 'it is no longer available');
  }
}

// Tactical raises or lowers the ship's shields.
function shieldsCommand(ws, msg) {
  if (ws.station !== 'Tactical') return send(ws, { type: 'notice', text: 'Only Tactical can raise or lower shields' });
  if (consoleDark(ws)) return darkNote(ws);
  if (msg.up && capacityOf(ws.shipKey).shields < MIN_SHIELD_POWER) return send(ws, { type: 'notice', text: `Tactical: not enough power to raise shields (needs ${MIN_SHIELD_POWER}%; ask Engineering)` });
  if (msg.up && combatOf(ws.shipKey).shield < MIN_SHIELD_STRENGTH) return send(ws, { type: 'notice', text: `Tactical: the shield generators are recharging (${Math.floor(combatOf(ws.shipKey).shield)}%; they hold from ${MIN_SHIELD_STRENGTH}%)` });
  if (msg.up) shields.add(ws.shipKey); else shields.delete(ws.shipKey);
  flowCache.delete(ws.shipKey); // they draw while up
  opLog(ws.shipKey, `${ws.name}: shields ${msg.up ? 'up' : 'down'}`);
  broadcastShips();
  return;
}

// The transporter: it locks onto a destination (this ship too, site to
// site), then energizes for BEAM_SECS and the person moves at the end. Its
// power follows what it's doing: nothing with no lock, half while it holds
// one, all of it while it energizes. It needs that 100%: short of it (the
// limiter below 100, damage, or the bus can't supply it), the beam won't
// start, or fails at the end.
const BEAM_SECS = Number(process.env.BEAM_SECS) || 5;
const transporters = new Map(); // ship key -> { lock: ship key, person?: user id, energizing: { who, station, at } }
// Beaming people from another vessel: only those Science could place (the
// scan's rule: on our sensors, their location resolved, its shields down or
// our sensors above its shields), in transporter range.
function personFault(k, u) {
  if (!u || users.get(u.id) !== u) return 'they are no longer there';
  if (u.operator) return 'the ops station cannot be beamed';
  const t = u.shipKey;
  if (t === k) return null;
  if (!present(t) || !navState.has(t) || !sensorOk(k, t)) return 'not on sensors';
  const loc = locatable(k, t);
  if (!loc.resolved) return `location unresolved (sensors ${loc.sensors}% vs shields ${loc.shield}%)`;
  if (!transporterOk(k, t)) return `out of range (${rangeText(k, t)})`;
  return null;
}
// Where the transporter can beam people from: this vessel, and the vessels it
// can place people aboard; each with its manned stations and who's at them.
function beamSources(k) {
  const vessels = [k, ...[...new Set([...users.values()].map((u) => u.shipKey))].filter((t) => t !== k && present(t) && navState.has(t) && sensorOk(k, t) && locatable(k, t).resolved && transporterOk(k, t)).sort()];
  return vessels.map((t) => {
    const stations = {};
    for (const u of crewOf(t)) if (!u.operator) (stations[placeOf(u)] ||= []).push({ id: u.id, name: titled(u) });
    return { ship: shipName(t), here: t === k, stations: Object.entries(stations).sort(([a], [b]) => STATIONS.indexOf(a) - STATIONS.indexOf(b)).map(([station, people]) => ({ station, people: people.sort((x, y) => x.name.localeCompare(y.name)) })) };
  }).filter((v) => v.here || v.stations.length);
}
// The transporter's subsystems (Transporter's console, low bus): pattern
// buffers (15, they need the lateral sensors), targeting scanners (2, for a
// lock), Heisenberg compensators and the biofilter (2 each), and the
// energizing coils (5, while energizing). A level-3 diagnostic (16 s, all of
// them powered) must pass before anyone is beamed; the buffers losing power
// invalidates it.
const TR = { buffers: 15, small: 2, coils: 5, diagSecs: Number(process.env.DIAG_SECS) || 16 };
const TR_SUBS = ['patternBuffers', 'targetingScanners', 'energizingCoils', 'heisenberg', 'biofilter'];
// What's missing for the transporter to work (null: nothing), and whether the lock part works.
function transporterFault(k, { lock = false } = {}) {
  if (!isBase(k) && !classOf(k).transporter) return `a ${classOf(k).name.toLowerCase()} has no transporter`;
  const f = flow(k), p = powerOf(k);
  if (p.lateral <= 0) return 'the pattern buffers need the lateral sensors';
  const need = lock ? ['patternBuffers', 'targetingScanners'] : ['patternBuffers', 'targetingScanners', 'heisenberg', 'biofilter'];
  const down = need.filter((x) => f.subOk[x] === false);
  return down.length ? `no power to its ${down.map((x) => SUBSYSTEMS[x].name).join(', ')}` : null;
}
const transporterDraw = (k) => { const t = transporters.get(k); return t?.energizing ? 100 : t?.lock ? 50 : 0; };
const transporterView = (k) => { const t = transporters.get(k), d = engOf(k).trDiag; return { lock: t?.lock ? shipName(t.lock) : null,
  from: isBase(k) ? [] : beamSources(k), energizing: t?.energizing ? { who: t.energizing.who, until: t.energizing.at + BEAM_SECS * 1000 } : null, secs: BEAM_SECS, diag: { state: d.state, t: d.t, secs: TR.diagSecs }, fault: transporterFault(k) }; };
const transporterPower = (k) => { flowCache.delete(k); return powerOf(k).transporter; };
function dropLock(k, why) {
  const t = transporters.get(k);
  if (!t?.lock) return;
  transporters.delete(k);
  gridChanged(k);
  tellStations(k, ['Transporter'], `Transporter: lock on the ${shipName(t.lock)} lost (${why})`);
}
// Every tick: a lock on another ship holds only while it's there and in range.
function checkTransporterLocks() {
  for (const k of cores.keys()) {
    if (isBase(k) || !eng.has(k)) continue;
    const d = engOf(k).trDiag;
    if (d.state === 'none') continue;
    const f = flow(k);
    // The buffers losing power (or the diagnostic's subsystems) undoes it.
    if (f.subOk.patternBuffers === false || powerOf(k).lateral <= 0 || (d.state === 'running' && transporterFault(k))) {
      const was = d.state; Object.assign(d, { state: 'none', t: 0 }); engOf(k).dirty = true;
      tellStations(k, ['Transporter'], `Transporter: level-3 diagnostic ${was === 'running' ? 'aborted' : 'invalidated'}: the pattern buffers lost power`);
      continue;
    }
    if (d.state === 'running' && ++d.t >= TR.diagSecs) { Object.assign(d, { state: 'passed', t: 0 }); engOf(k).dirty = true; tellStations(k, ['Transporter'], 'Transporter: level-3 diagnostic passed: ready to energize'); }
  }
  for (const [k, t] of [...transporters]) {
    if (t.energizing || !t.lock || t.lock === k) continue;
    if (!present(t.lock)) dropLock(k, `the ${shipName(t.lock)} has no ship's computer online`);
    else if (!transporterOk(k, t.lock)) dropLock(k, 'out of transporter range');
  }
}

// A level-3 diagnostic: 16 s with every subsystem powered.
function transporterDiagnostic(ws) {
  const fail = (text) => send(ws, { type: 'notice', text: `Transporter: ${text}` });
  if (ws.station !== 'Transporter') return fail('only the transporter room runs its diagnostics');
  if (consoleDark(ws)) return fail('console offline, no power on its bus');
  const d = engOf(ws.shipKey).trDiag;
  if (d.state === 'running') return fail('the diagnostic is already running');
  const fault = transporterFault(ws.shipKey) || (flow(ws.shipKey).subOk.energizingCoils === false ? 'no power to its energizing coils' : null);
  if (fault) return fail(`can't run the diagnostic: ${fault}`);
  Object.assign(d, { state: 'running', t: 0 });
  tellStations(ws.shipKey, ['Transporter'], `Transporter: level-3 diagnostic running (${TR.diagSecs} s)`);
  broadcastShips();
}
function transporterLock(ws, msg) {
  const fail = (text) => send(ws, { type: 'notice', text: `Transporter: ${text}` });
  if (ws.station !== 'Transporter') return fail('only the transporter room can lock on');
  if (consoleDark(ws)) return fail('console offline, no power on its bus');
  const k = ws.shipKey, t = transporters.get(k);
  if (t?.energizing) return fail('energizing: wait for the beam to finish');
  if (msg.ship == null) {
    if (t?.lock) { transporters.delete(k); gridChanged(k); }
    return broadcastShips();
  }
  const toKey = shipKey(clean(msg.ship));
  const lockFault = transporterFault(k, { lock: true });
  if (lockFault) return fail(`can't lock on: ${lockFault}`);
  if (toKey !== k) {
    if (!present(toKey)) return fail(`the ${clean(msg.ship)} has no ship's computer online`);
    if (!transporterOk(k, toKey)) return fail(`the ${shipName(toKey)} is out of transporter range (${rangeText(k, toKey)}; get within ${Math.round(rangesOf(k).transporter)})`);
  }
  transporters.set(k, { lock: toKey });
  gridChanged(k);
  broadcastShips();
}

// Why someone can't be beamed to toKey right now (null: they can). They may
// be aboard this vessel, or aboard another that the transporter can place them on.
function beamBlocked(k, u, toKey, station) {
  if (!u || users.get(u.id) !== u) return 'that person is no longer there';
  const why = personFault(k, u);
  if (why) return `${u.name}: ${why}`;
  const from = u.shipKey;
  if (toKey === from) return !station || station === u.station ? `${u.name} is already at ${u.station}: pick another station` : null;
  if (!present(toKey)) return `the ${shipName(toKey)} has no ship's computer online`;
  if (!transporterOk(k, toKey)) return `the ${shipName(toKey)} is out of transporter range (${rangeText(k, toKey)}; get within ${Math.round(rangesOf(k).transporter)})`;
  for (const x of new Set([k, from, toKey])) if (shields.has(x)) return `cannot beam through the shields of the ${shipName(x)}`;
  if (lockoutOf(toKey)) return `the ${shipName(toKey)} has a transporter lockout: Security's force field is up`;
  if (from !== k && lockoutOf(from)) return `the ${shipName(from)} has a transporter lockout: Security's force field is up`;
  if (users.has(userId(u.name, shipName(toKey)))) return `someone called ${u.name} is already aboard the ${shipName(toKey)}`;
  return null;
}

// Beam one or more people, all from one place (this vessel or another the
// transporter can place them on), to the destination it's locked on:
// { who: [user ids] (or one), station? } (no station: they keep theirs).
function beamCommand(ws, msg) {
  const fail = (text) => send(ws, { type: 'notice', text: `Transporter: ${text}` });
  if (ws.station !== 'Transporter') return fail('only the transporter room can beam people');
  if (consoleDark(ws)) return fail('console offline, no power on its bus');
  const k = ws.shipKey, t = transporters.get(k);
  const people = [...new Set((Array.isArray(msg.who) ? msg.who : [msg.who]).filter((x) => typeof x === 'string'))].map((x) => users.get(x));
  const station = msg.station == null ? null : STATIONS.includes(msg.station) && msg.station !== 'Operations' ? msg.station : undefined;
  if (station === undefined) return fail('no such station to beam to');
  if (t?.energizing) return fail('already energizing');
  if (!people.length) return fail('pick who to beam (From)');
  if (people.some((u) => !u)) return fail('someone picked is no longer there');
  if (new Set(people.map((u) => u.shipKey)).size > 1) return fail('beam people from one vessel at a time');
  if (!t?.lock) return fail('no lock: pick where to beam them to (To) first');
  const toKey = t.lock;
  if (msg.ship != null && shipKey(clean(msg.ship)) !== toKey) return fail(`locked onto the ${shipName(toKey)}, not the ${clean(msg.ship)}: lock onto it first`);
  for (const u of people) { const why = beamBlocked(k, u, toKey, station); if (why) return fail(why); }
  if (allocOf(k).transporter < 100) return fail(`the transporter's limiter is at ${allocOf(k).transporter}%: it needs 100% to energize (ask Engineering)`);
  const fault = transporterFault(k);
  if (fault) return fail(`can't energize: ${fault}`);
  if (engOf(k).trDiag.state !== 'passed') return fail(`run a level-3 diagnostic first (${TR.diagSecs} s)${engOf(k).trDiag.state === 'running' ? ': it\'s running' : ''}`);
  t.energizing = { who: people.map((u) => u.id), station, at: Date.now() };
  const have = transporterPower(k);
  if (have < 100 - 1e-6) { t.energizing = null; gridChanged(k); return fail(`not enough power to energize: ${have}% of 100% (ask Engineering)`); }
  scheduleNav();
  const where = (u) => (toKey === u.shipKey ? station : `the ${shipName(toKey)}${station ? `'s ${station}` : ''}`);
  for (const u of people) if (u !== ws) send(u, { type: 'notice', text: `You are being beamed to ${where(u)}` });
  send(ws, { type: 'notice', text: `Transporter: energizing (${BEAM_SECS} s)` });
  setTimeout(() => {
    if (transporters.get(k) !== t) return; // destroyed meanwhile
    const have = transporterPower(k);
    const all = (have < 100 - 1e-6 ? `power fell to ${have}% while energizing` : null) || transporterFault(k) || (flow(k).subOk.energizingCoils === false ? 'no power to its energizing coils' : null);
    t.energizing = null;
    gridChanged(k);
    const done = [], failed = [];
    for (const u of people) {
      const lost = all || beamBlocked(k, u, toKey, station);
      if (lost) { failed.push(`${u.name} (${lost})`); if (users.get(u.id) === u) send(u, { type: 'notice', text: 'The transporter beam failed: you are still here' }); continue; }
      const w = where(u);
      beam(u, toKey, station);
      if (u !== ws) done.push(`${u.name} to ${w}`);
    }
    if (failed.length) tellStations(k, ['Transporter'], `Transporter: beam failed: ${failed.join('; ')}`);
    if (done.length) tellStations(k, ['Transporter'], `Transporter: beamed ${done.join(', ')}`);
    broadcastShips();
  }, BEAM_SECS * 1000);
}

// POST   /api/library            upload to your own ship (X-Token, X-Filename)
// GET    /api/library/<ship>/<f> download, from any ship on your data network
// DELETE /api/library/<ship>/<f> ops or Communications, own ship only
async function libraryRequest(req, res, urlPath) {
  const ws = tokens.get(req.headers['x-token']);
  if (!ws?.id) return res.writeHead(401).end('Sign in first');
  if (!commsReach(ws)) return res.writeHead(403).end('Library offline: no console power or local RF');

  if (req.method === 'POST' && urlPath === '/api/library') {
    let name;
    try { name = safeName(decodeURIComponent(req.headers['x-filename'] || '')); } catch { name = null; }
    if (!name) return res.writeHead(400).end('Missing file name');
    if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD) return res.writeHead(413).end('File too large');
    const core = coresOf(ws.shipKey)[0];
    if (!core) return res.writeHead(503).end('The ship\'s computer is offline');
    // Stream straight through to one of the ship's computers; the others
    // pick it up when they sync.
    const finalName = uniqueName(ws.shipKey, name);
    const tid = newTid(), coreTid = newTid();
    const t = { kind: 'up', core, res, coreTid, name: finalName, size: 0 };
    transfers.set(tid, t);
    send(core, { type: 'core-put', tid: coreTid, ship: ws.ship, name: finalName, modified: Date.now() });
    try {
      for await (const chunk of req) {
        t.size += chunk.length;
        if (t.size > MAX_UPLOAD) throw new Error('too large');
        if (!transfers.has(tid)) return; // the computer went away
        core.send(frame(coreTid, chunk));
        await drain(core);
      }
      send(core, { type: 'core-put-end', tid: coreTid });
      console.log(`${ws.name} uploaded ${finalName} (${t.size} bytes) to the ${ws.ship} library`);
    } catch (err) {
      send(core, { type: 'core-put-abort', tid: coreTid });
      transfers.delete(tid);
      if (!res.headersSent) res.writeHead(err.message === 'too large' ? 413 : 400).end(err.message === 'too large' ? 'File too large' : 'Upload failed');
    }
    return;
  }

  const m = (req.method === 'GET' || req.method === 'DELETE') && urlPath.match(/^\/api\/library\/([^/]+)\/([^/]+)$/);
  if (!m) return res.writeHead(404).end('Not found');
  let key, name;
  try { key = shipKey(decodeURIComponent(m[1])); name = safeName(decodeURIComponent(m[2])); } catch { return res.writeHead(400).end('Bad request'); }

  if (req.method === 'DELETE') {
    if (!ws.operator && ws.station !== 'Communications') return res.writeHead(403).end('Only ops or Communications can delete library files');
    if (key !== ws.shipKey) return res.writeHead(403).end("Library files can only be deleted from your own ship's library");
    const entry = name && mergedIndex(key).get(name);
    if (!entry || entry.deleted) return res.writeHead(404).end('No such file');
    if (!coresOf(key).length) return res.writeHead(503).end('The ship\'s computer is offline');
    const at = Math.max(Date.now(), entry.modified + 1);
    for (const c of coresOf(key)) send(c, { type: 'core-delete', ship: shipName(key), name, at });
    console.log(`${ws.name} deleted ${name} from the ${ws.ship} library`);
    opLog(ws.shipKey, `${ws.name} deleted ${name} from the library`);
    return res.writeHead(204).end();
  }

  if (!sameNetwork(ws.shipKey, key)) return res.writeHead(403).end('That library is not on your data network');
  const entry = name && mergedIndex(key).get(name);
  if (!entry || entry.deleted) return res.writeHead(404).end('No such file');
  const core = coresOf(key).find((c) => c.index.get(key)?.get(name)?.modified === entry.modified);
  if (!core) return res.writeHead(503).end('The ship\'s computer is offline');
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': entry.size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  });
  const tid = newTid();
  transfers.set(tid, { kind: 'down', core, res });
  res.on('close', () => { if (transfers.has(tid)) transfers.delete(tid); });
  send(core, { type: 'core-get', tid, ship: shipName(key), name });
}

// --- ops station on and off duty --------------------------------------------------

// Someone takes (or moves to) a ship's ops station (the ship needs a computer). Several can be on duty;
// any of them can route hails, manage links and so on.
function joinOps(ws) {
  ws.operator = true;
  ws.station = OPS_STATION; ws.console = null;
  syncRooms();
  operators.add(ws);
  send(ws, { type: 'operator-ok', ...info(ws), token: ws.token });
  broadcastAllOps();          // other ships now see this one
  broadcastShips();           // crew can report aboard
  broadcastCrew(ws.shipKey);  // crew aboard: ops is on duty and callable
}

// An operator leaves the ops station (signs off or moves to another station).
// If they were the last one, the ship loses off-ship comms: pending hails and
// link requests are dropped and its data links close. Calls in progress go on.
function leaveOps(ws) {
  operators.delete(ws);
  ws.operator = false;
  console.log(`${ws.name} left the ops station on the ${ws.ship}`);
  if (!opsOf(ws.shipKey).length) {
    // Hails and link requests need ops to answer them.
    dropHails((h) => h.toShip === ws.shipKey || h.fromShip === ws.shipKey, `no operator on duty aboard the ${ws.ship}`);
    for (const req of [...linkRequests.values()]) if (req.fromShip === ws.shipKey || req.toShip === ws.shipKey) linkRequests.delete(req.id);
    dropLinksIfUnmaintained(ws.shipKey);
  }
  broadcastAllOps();
  broadcastShips();
}

// Open data links are kept up by the ship's ops or its ship's computer (which
// can keep a link going with nobody aboard, but can't start one). With
// neither, the ship's links close; calls already going over them carry on.
function dropLinksIfUnmaintained(key) {
  if (opsOf(key).length || present(key) || !linkedTo(key).length) return;
  const formerNet = [...network(key)];
  for (const k of linkedTo(key)) { links.delete(linkKey(key, k)); opLog(k, `data link with the ${shipName(key)} lost: no operator or ship's computer`); }
  refreshNetworks(formerNet);
}

// --- comm traffic (Communications station) ------------------------------------

// Every call in progress (or ringing) that involves someone on this ship's data
// network: who is in it and since when. Metadata only; nobody listens in.
// What this ship's Communications can see: its own local calls in full;
// radio calls (and hails, which are radio) between vessels as ship-to-ship
// only, when one end is within our radio range and our radio has power;
// nothing internal to another ship, and nothing carried over a data link.
function trafficFor(key) {
  const net = network(key);
  const radioUp = commsUp(key, 'radio');
  const heard = (ships) => radioUp && ships.some((s) => s === key || commsOk(key, s));
  const involved = [...users.values()].filter((u) => u.state !== 'idle' && u.cid);
  const calls = new Map();
  for (const u of involved) {
    const others = u.peers.map((id) => users.get(id)).filter(Boolean);
    const c = calls.get(u.cid) || { cid: u.cid, state: u.state === 'in-call' ? 'in-call' : 'ringing', since: u.callSince || Date.now(), members: new Map(), ships: new Set() };
    for (const m of [u, ...others]) { c.members.set(m.id, m); c.ships.add(m.shipKey); }
    if (u.state === 'in-call') c.state = 'in-call';
    c.since = Math.min(c.since, u.callSince || Date.now());
    calls.set(u.cid, c);
  }
  const out = [];
  for (const c of calls.values()) {
    const ships = [...c.ships];
    if (ships.length === 1) { if (ships[0] === key) out.push({ state: c.state, since: c.since, members: [...c.members.values()].map(info) }); continue; }
    if ((carriers.get(c.cid) || 'link') !== 'radio' || !heard(ships)) continue;
    out.push({ state: c.state, since: c.since, via: 'radio', ships: ships.map(shipName), members: [...c.members.values()].filter((m) => m.shipKey === key).map(info) });
  }
  // Hails (by radio) waiting for the other ship's ops to answer.
  for (const h of hails.values()) {
    const caller = users.get(h.caller);
    if (!caller) continue;
    if (h.fromShip === key) out.push({ state: 'hailing', since: h.since, members: [info(caller)], to: shipName(h.toShip) });
    else if (heard([h.fromShip, h.toShip])) out.push({ state: 'hailing', since: h.since, via: 'radio', ships: [shipName(h.fromShip), shipName(h.toShip)], members: [], to: shipName(h.toShip) });
  }
  // All-hands broadcasts heard on this network.
  for (const b of broadcasts.values()) {
    if (![...b.ships].some((k) => net.has(k))) continue;
    const sp = users.get(b.speaker);
    if (sp) out.push({ state: 'broadcast', since: b.since, members: [info(sp)], to: b.label });
  }
  return out.sort((a, b) => a.since - b.since);
}

// Traffic changes with calls, hails and broadcasts; send it once per tick.
let trafficQueued = false;
function scheduleTraffic() {
  if (trafficQueued) return;
  trafficQueued = true;
  queueMicrotask(() => { trafficQueued = false; broadcastTraffic(); });
}

function broadcastTraffic() {
  for (const u of users.values()) if (u.station === 'Communications') send(u, { type: 'traffic', calls: trafficFor(u.shipKey) });
}

// --- all hands: one-way broadcasts --------------------------------------------------

// bid -> { bid, speaker (user id), ships (keys), audience (user ids), label, since }
const broadcasts = new Map();

// The speaker's browser sends their mic to each listener over its own
// one-way connection; listeners only receive. The server relays the setup.
function startAllHands(speaker, scope) {
  const ships = scope === 'network' ? network(speaker.shipKey) : new Set([speaker.shipKey]);
  const label = scope === 'network' && ships.size > 1 ? `all hands, data network (${[...ships].map(shipName).join(', ')})` : `all hands aboard the ${speaker.ship}`;
  const b = { bid: newId('b-'), speaker: speaker.id, ships, audience: new Set(), label, since: Date.now() };
  broadcasts.set(b.bid, b);
  send(speaker, { type: 'bcast-speak', bid: b.bid, label });
  for (const k of ships) for (const u of crewOf(k)) if (u !== speaker) addListener(b, u);
  for (const k of new Set([...ships, speaker.shipKey])) { opLog(k, `${speaker.name} (${speaker.station}): ${label}`); broadcastOps(k); }
  return b;
}

function addListener(b, u) {
  if (u.id === b.speaker || b.audience.has(u.id)) return;
  const speaker = users.get(b.speaker);
  if (!speaker) return;
  b.audience.add(u.id);
  // Listener first, so it's ready before the speaker's offer arrives.
  send(u, { type: 'bcast-listen', bid: b.bid, from: info(speaker), label: b.label });
  send(speaker, { type: 'bcast-add', bid: b.bid, listener: info(u) });
}

function endBroadcast(b, reason) {
  if (!broadcasts.delete(b.bid)) return;
  for (const id of [b.speaker, ...b.audience]) { const u = users.get(id); if (u) send(u, { type: 'bcast-ended', bid: b.bid, reason }); }
  const sp = users.get(b.speaker);
  for (const k of new Set([...b.ships, ...(sp ? [sp.shipKey] : [])])) { opLog(k, `all-hands broadcast ended${reason ? `: ${reason}` : ''}`); broadcastOps(k); }
}

// Someone arrives aboard (signs in, beams over): they hear broadcasts to their ship.
function joinBroadcasts(u) {
  for (const b of broadcasts.values()) if (b.ships.has(u.shipKey)) addListener(b, u);
}

// Someone leaves (signs out, beams away): drop them, or end what they were saying.
function leaveBroadcasts(u, oldId = u.id) {
  for (const b of [...broadcasts.values()]) {
    if (b.speaker === oldId) endBroadcast(b, `${u.name} left`);
    else b.audience.delete(oldId);
  }
}

// --- the room you're in: proximity chat ----------------------------------------------

// The bridge is one room (its stations and consoles); every other place is its
// own. Someone with their room mic on sends it to everyone else in the room
// over one-way connections, as for all hands; the relay keeps who hears whom
// as people come and go, and relays the setup.
const roomOf = (u) => roomOfStation(u.shipKey, placeOf(u));
const inRoom = (a, b) => a !== b && a.shipKey === b.shipKey && roomOf(a) === roomOf(b);
function syncRooms() {
  for (const sp of users.values()) {
    const aud = (sp.roomAudience ||= new Map()); // listener id -> listener
    for (const [id, u] of aud) {
      if (sp.roomMic && users.get(id) === u && inRoom(sp, u)) continue;
      aud.delete(id);
      send(u, { type: 'room-drop', from: sp.id });
      send(sp, { type: 'room-drop', listener: id });
    }
    if (!sp.roomMic) continue;
    for (const u of users.values()) {
      if (!inRoom(sp, u) || aud.has(u.id)) continue;
      aud.set(u.id, u);
      // Listener first, so it's ready before the speaker's offer arrives.
      send(u, { type: 'room-listen', from: info(sp) });
      send(sp, { type: 'room-add', listener: info(u) });
    }
  }
}
// Someone leaves the comm net (signs out, beams away): nobody hears them, nor they anyone, until they're back.
function leaveRoom(ws) {
  for (const [, u] of ws.roomAudience || []) send(u, { type: 'room-drop', from: ws.id });
  ws.roomAudience = new Map();
  for (const sp of users.values()) if (sp.roomAudience?.get(ws.id) === ws) { sp.roomAudience.delete(ws.id); send(sp, { type: 'room-drop', listener: ws.id }); }
  send(ws, { type: 'room-reset' });
}

// --- ship's radio ----------------------------------------------------------------

const shipRadio = new Map(); // ship key -> { name, url, by: info }

function sendShipRadio(u) {
  send(u, { type: 'ship-radio', radio: shipRadio.get(u.shipKey) || null });
}

// --- connections -------------------------------------------------------------

wss.on('connection', (ws, req) => {
  sockets.add(ws);
  ws.local = isLocal(req?.socket?.remoteAddress); // (admin requests: from this machine, or the LAN by Settings)
  ws.addr = req?.socket?.remoteAddress;
  ws.session = req ? sessionToken(req) : null;
  ws.account = needLogin() ? ACCOUNTS.session(ws.session) : null;
  ws.id = null;
  ws.state = 'idle';
  ws.peers = [];
  ws.cid = null;
  ws.operator = false;

  ws.on('message', (raw, isBinary) => {
    // Ship's computers send file data as binary frames.
    if (ws.shipcore) {
      if (isBinary) return coreMessage(ws, raw, true);
      try { return coreMessage(ws, JSON.parse(raw), false); } catch { return; }
    }
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'shipcore' && !ws.id && !ws.operator) return coreSignIn(ws, msg);
    // A page from another origin (no cookie): its session token, once, by message.
    if (msg.type === 'session' && !ws.account) {
      ws.session = typeof msg.token === 'string' ? msg.token : null;
      ws.account = ACCOUNTS.session(ws.session);
      if (!ws.account) { send(ws, { type: 'auth-required', reason: 'log in first' }); return ws.close(4401, 'log in first'); }
      return greet(ws);
    }
    if (needLogin() && !ws.account) { send(ws, { type: 'auth-required', reason: 'log in first' }); return ws.close(4401, 'log in first'); }
    if (msg.type === 'admin') return adminRequest(ws, msg);

    if (msg.type === 'operator' && !ws.id && !ws.operator) {
      // The ops station is aboard as crew at the Operations station.
      const ship = clean(msg.ship), name = clean(msg.name);
      if (OPERATOR_KEY && msg.key !== OPERATOR_KEY) return send(ws, { type: 'operator-failed', reason: 'wrong operator key' });
      if (!NAME_RE.test(name)) return send(ws, { type: 'operator-failed', reason: 'enter your name (letters, digits, spaces, \' . -)' });
      if (!NAME_RE.test(ship)) return send(ws, { type: 'operator-failed', reason: 'enter your ship name (letters, digits, spaces, \' . -)' });
      if (!hasComputer(ship)) return send(ws, { type: 'operator-failed', reason: `the ${ship} has no ship's computer online` });
      const id = userId(name, ship);
      if (users.has(id)) return send(ws, { type: 'operator-failed', reason: `${name} is already aboard the ${shipName(shipKey(ship))}` });
      const post = takePosition(shipKey(ship), msg, id);
      if (post?.why || (post && post.station !== OPS_STATION)) return send(ws, { type: 'operator-failed', reason: post.why || `${post.title} isn't an Operations position` });
      ws.id = id;
      ws.name = name;
      Object.assign(ws, profileFrom(msg));
      if (post) Object.assign(ws, { position: post.id, post: post.title, rank: post.rank, postShip: shipKey(ship) });
      if (ws.account) ACCOUNTS.usedCharacter(ws.account.username, name); // ("last used by")
      ws.shipKey = registerShip(ship);
      ws.ship = shipName(ws.shipKey);
      users.set(id, ws);
      ws.token = crypto.randomBytes(16).toString('hex');
      tokens.set(ws.token, ws);
      console.log(`${name} took the ops station on the ${ws.ship}`);
      joinOps(ws);
      sendShipRadio(ws);
      joinBroadcasts(ws);
      return;
    }
    // Ops commands act on the vessel this ops console is controlling (else its own ship).
    if (ws.operator && OP_COMMANDS.has(msg.type)) return operatorMessage(ws.controlling ? actorFor(ws) : ws, msg);
    // Communications sets up and closes data links, as ops do.
    if (ws.id && ws.station === 'Communications' && ['link-request', 'link-accept', 'link-decline', 'link-cancel', 'link-close'].includes(msg.type)) return consoleDark(ws) ? darkNote(ws) : operatorMessage(ws, msg);

    if (msg.type === 'status' && ws.id && STATES.has(msg.state)) {
      const cid = typeof msg.cid === 'string' ? msg.cid : null;
      if (cid !== ws.cid) ws.callSince = cid ? Date.now() : null;
      ws.state = msg.state;
      ws.peers = Array.isArray(msg.peers) ? msg.peers.filter((n) => typeof n === 'string').slice(0, 50) : [];
      ws.cid = cid;
      broadcastTraffic();
      // Everyone this person is talking to may be on other ships' rosters too.
      new Set([ws.shipKey, ...ws.peers.map((id) => users.get(id)?.shipKey).filter(Boolean)]).forEach(broadcastOps);
      return;
    }

    if (msg.type === 'register') {
      if (ws.id) return send(ws, { type: 'register-failed', reason: 'already registered' });
      const name = clean(msg.name), ship = clean(msg.ship);
      if (!NAME_RE.test(name)) return send(ws, { type: 'register-failed', reason: 'name: use 1-32 letters, digits, spaces, \' . -' });
      if (!NAME_RE.test(ship)) return send(ws, { type: 'register-failed', reason: 'ship: use 1-32 letters, digits, spaces, \' . -' });
      const post = hasComputer(ship) ? takePosition(shipKey(ship), msg, userId(name, ship)) : null;
      if (post?.why) return send(ws, { type: 'register-failed', reason: post.why });
      if (post && !STATIONS.includes(msg.station)) msg.station = post.station;
      if (!STATIONS.includes(msg.station)) return send(ws, { type: 'register-failed', reason: 'pick a station' });
      if (!hasComputer(ship)) return send(ws, { type: 'register-failed', reason: `the ${ship} has no ship's computer online` });
      if (!hasStation(shipKey(ship), msg.station)) return send(ws, { type: 'register-failed', reason: `a ${classOf(shipKey(ship)).name.toLowerCase()} has no ${msg.station} station (it has ${stationsOf(shipKey(ship)).join(', ')})` });
      const id = userId(name, ship);
      if (users.has(id)) return send(ws, { type: 'register-failed', reason: `${name} is already aboard the ${shipName(shipKey(ship))}` });
      ws.id = id;
      ws.name = name;
      Object.assign(ws, profileFrom(msg));
      if (post) Object.assign(ws, { position: post.id, post: post.title, rank: post.rank, postShip: shipKey(ship) });
      if (ws.account) ACCOUNTS.usedCharacter(ws.account.username, name); // ("last used by")
      ws.shipKey = registerShip(ship);
      ws.ship = shipName(ws.shipKey);
      seat(ws, msg.station);
      users.set(id, ws);
      ws.token = crypto.randomBytes(16).toString('hex');
      tokens.set(ws.token, ws);
      send(ws, { type: 'registered', ...selfInfo(ws), token: ws.token });
      broadcastCrew(ws.shipKey);
      broadcastShips();
      console.log(`${name} (${ws.station}) reported aboard the ${ws.ship}`);
      sendShipRadio(ws);
      joinBroadcasts(ws);
      return;
    }

    // Personal equipment: the environmental shield on or off.
    if (msg.type === 'equipment' && ws.id) {
      const s = shieldOf(ws);
      if (typeof msg.shield === 'boolean' && msg.shield !== s.on) {
        if (msg.shield && s.charge < 1) return send(ws, { type: 'notice', text: 'Environmental shield: no charge left (it recharges somewhere with power)' });
        s.on = msg.shield;
        broadcastCrew(ws.shipKey);
        broadcastOps(ws.shipKey);
      }
      return send(ws, { type: 'equipment', ...equipmentOf(ws) });
    }

    // Species and gender, changed after sign-in (rank comes with a position).
    if (msg.type === 'profile' && ws.id) {
      Object.assign(ws, profileFrom(msg));
      send(ws, { type: 'profile', ...selfInfo(ws) });
      broadcastCrew(ws.shipKey);
      broadcastOps(ws.shipKey);
      return;
    }

    // Move to another station aboard the same ship.
    // Moving to Operations takes an ops station (with the key, if one is set);
    // an operator moving elsewhere leaves it.
    if (msg.type === 'change-station' && ws.id) {
      if (msg.station !== OPS_STATION && !STATIONS.includes(msg.station)) return send(ws, { type: 'notice', text: 'No such station' });
      { const where = msg.ship ? shipKey(clean(msg.ship)) : ws.shipKey; if (present(where) && !hasStation(where, msg.station)) return send(ws, { type: 'station-failed', reason: `the ${shipName(where)} (${classOf(where).name} class) has no ${msg.station} station` }); }
      // Force fields: nobody walks out of an isolated station, or into one (aboard here or across a dock).
      const target = msg.ship ? shipKey(clean(msg.ship)) : ws.shipKey;
      if (!ws.operator && sealed(ws.shipKey, placeOf(ws))) return send(ws, { type: 'station-failed', reason: `a Security force field isolates ${placeOf(ws)}: nobody walks out (the transporter can beam you)` });
      if (held(ws)) return send(ws, { type: 'station-failed', reason: `a Security force field holds you at ${placeOf(ws)} (the transporter can beam you)` });
      if (msg.station !== OPS_STATION && present(target) && sealed(target, msg.station)) return send(ws, { type: 'station-failed', reason: `a Security force field isolates ${msg.station}${target !== ws.shipKey ? ` aboard the ${shipName(target)}` : ''}: nobody walks in` });
      // Across the dock: walk over to a station aboard a vessel docked with this one.
      const there = msg.ship ? shipKey(clean(msg.ship)) : ws.shipKey;
      if (there !== ws.shipKey) {
        if (!dockedWith(ws.shipKey).includes(there)) return send(ws, { type: 'station-failed', reason: `not docked with the ${clean(msg.ship)}` });
        if (msg.station === OPS_STATION && OPERATOR_KEY && msg.key !== OPERATOR_KEY) return send(ws, { type: 'station-failed', reason: 'wrong operator key' });
        if (users.has(userId(ws.name, shipName(there)))) return send(ws, { type: 'station-failed', reason: `someone called ${ws.name} is already aboard the ${shipName(there)}` });
        if (ws.operator) leaveOps(ws);
        opLog(ws.shipKey, `${ws.name} (${ws.station}) went across the dock to the ${shipName(there)}`);
        beam(ws, there, msg.station === OPS_STATION ? 'Crew' : msg.station, 'walked');
        if (msg.station === OPS_STATION) { opLog(there, `${ws.name} took the ops station`); joinOps(ws); }
        return;
      }
      if (msg.station === placeOf(ws)) return;
      const was = placeOf(ws);
      if (msg.station === OPS_STATION) {
        if (OPERATOR_KEY && msg.key !== OPERATOR_KEY) return send(ws, { type: 'station-failed', reason: 'wrong operator key' });
        opLog(ws.shipKey, `${ws.name} moved from ${was} to the ops station`);
        joinOps(ws);
        broadcastTraffic();
        return;
      }
      if (ws.operator) leaveOps(ws);
      seat(ws, msg.station);
      send(ws, { type: 'registered', ...selfInfo(ws), token: ws.token });
      broadcastCrew(ws.shipKey);
      broadcastTraffic();
      opLog(ws.shipKey, `${ws.name} moved from ${was} to ${placeOf(ws)}`);
      return;
    }

    // Spores loaded into the drive (or unloaded back into the reserve): by hand, by someone at the
    // Spore Lab console aboard; never by automation, remote control, a data link or Engineering.
    if (msg.type === 'spore-load' && ws.id) {
      const k = ws.shipKey, e = engOf(k), note = (text) => send(ws, { type: 'notice', text: `Spore Lab: ${text}` });
      if (placeOf(ws) !== 'Spore Lab' || ws.automaton || ws.controlling) return note('spores are loaded by hand, at the Spore Lab console');
      if (!classOf(k).spore || isBase(k)) return note('no spore drive aboard');
      if (consoleDark(ws)) return note('console offline, no power on its bus');
      if (e.spore.charging) return note('the drive is charging a jump');
      if (msg.on) {
        if (e.spore.loaded >= SPORE.jump) return note('the drive is already loaded');
        if (e.spores < SPORE.jump) return note(`not enough spores in the reserve (${Math.floor(e.spores)} of ${SPORE.jump})`);
        e.spores -= SPORE.jump; e.spore.loaded = SPORE.jump;
      } else {
        if (!e.spore.loaded) return note('the drive is empty');
        e.spores = Math.min(SPORE.cap, e.spores + e.spore.loaded); e.spore.loaded = 0;
      }
      e.dirty = true; gridChanged(k);
      opLog(k, `Spore Lab (${ws.name}): spores ${msg.on ? 'loaded into' : 'unloaded from'} the drive`);
      tellStations(k, ['Helm', 'Spore Lab'], msg.on ? 'Spore Lab: the drive is loaded (one jump)' : 'Spore Lab: the drive is unloaded');
      return;
    }

    // A bridge console reconfigured (its top buttons): whoever is at it now runs that
    // station, staying where they are (their calls and comms carry on).
    if (msg.type === 'console-mode' && ws.id) {
      if (!ws.console) return send(ws, { type: 'notice', text: 'Only a bridge console is reconfigured' });
      if (!CONSOLE_MODES.includes(msg.mode)) return send(ws, { type: 'notice', text: 'No such console mode' });
      if (consoleDark(ws)) return send(ws, { type: 'notice', text: 'console offline, no power on its bus' });
      const e = engOf(ws.shipKey);
      e.bridgeModes = { ...e.bridgeModes, [ws.console]: msg.mode }; e.dirty = true;
      for (const u of crewOf(ws.shipKey)) if (u.console === ws.console && u.station !== msg.mode) { u.station = msg.mode; send(u, { type: 'registered', ...selfInfo(u), token: u.token }); }
      broadcastCrew(ws.shipKey);
      broadcastTraffic();
      opLog(ws.shipKey, `${ws.name}: ${ws.console} set to ${msg.mode}`);
      return;
    }

    // The room mic, and the setup between a speaker and each listener in the room.
    if (msg.type === 'room-mic' && ws.id) {
      ws.roomMic = !!msg.on;
      syncRooms();
      return;
    }
    if (msg.type === 'rsignal' && ws.id) {
      const to = typeof msg.to === 'string' && users.get(msg.to);
      if (!to) return;
      const ok = msg.dir === 'listener' ? ws.roomAudience?.get(to.id) === to : to.roomAudience?.get(ws.id) === ws;
      if (ok) send(to, { type: 'rsignal', from: ws.id, dir: msg.dir === 'listener' ? 'listener' : 'speaker', data: msg.data });
      return;
    }

    // All hands: setup between the speaker and each listener, and the speaker ending it.
    if (msg.type === 'bsignal' && ws.id) {
      const b = broadcasts.get(msg.bid);
      const to = typeof msg.to === 'string' && users.get(msg.to);
      if (!b || !to) return;
      const ok = (b.speaker === ws.id && b.audience.has(to.id)) || (b.speaker === to.id && b.audience.has(ws.id));
      if (ok) send(to, { type: 'bsignal', bid: b.bid, from: ws.id, data: msg.data });
      return;
    }
    if (msg.type === 'bcast-end' && ws.id) {
      const b = broadcasts.get(msg.bid);
      if (b && b.speaker === ws.id) endBroadcast(b, `${ws.name} ended it`);
      return;
    }

    // The ship's radio: Communications or ops plays a station on every console
    // aboard, or across the data network.
    if (msg.type === 'ship-radio' && ws.id) {
      if (ws.station !== 'Communications' && !ws.operator) return send(ws, { type: 'notice', text: 'Only Communications or ops can set the ship\'s radio' });
      const ships = msg.scope === 'network' ? network(ws.shipKey) : new Set([ws.shipKey]);
      let radio = null;
      if (msg.url) {
        if (typeof msg.url !== 'string' || !/^https?:\/\/\S+$/i.test(msg.url) || msg.url.length > 500) return send(ws, { type: 'notice', text: 'Not a radio stream address' });
        radio = { name: clean(msg.name).slice(0, 80) || 'Radio', url: msg.url, by: info(ws) };
      }
      for (const k of ships) {
        if (radio) shipRadio.set(k, radio); else shipRadio.delete(k);
        for (const u of crewOf(k)) sendShipRadio(u);
        opLog(k, radio ? `${ws.name} put ${radio.name} on the ship's radio` : `${ws.name} switched off the ship's radio`);
      }
      return;
    }

    // Remote control: this console runs the same station aboard another vessel.
    if (msg.type === 'control' && ws.id) return controlCommand(ws, msg);
    // Station commands act on the vessel this console is controlling (else its own ship).
    if (ws.id && stationCommand(ws.controlling && msg.type !== 'order-ack' && msg.type !== 'order-decline' ? actorFor(ws) : ws, msg)) return;

    // Text messages, no call needed: to one person or several, anyone the
    // sender could call (aboard, or on the data network). Local RF carries
    // them aboard, radio between ships.
    if (msg.type === 'text' && ws.id) {
      const text = clean(msg.text).slice(0, 500);
      const to = [...new Set(Array.isArray(msg.to) ? msg.to : [])].map((id) => typeof id === 'string' && users.get(id)).filter((u) => u && u !== ws);
      if (!text || !to.length) return;
      if (!commsReach(ws)) return send(ws, { type: 'notice', text: `${COMMS_OFFLINE}: no messages` });
      // Messages are handled by the computer cores: at least one online at each end.
      if (!coresOnline(ws.shipKey)) return send(ws, { type: 'notice', text: 'Communications: no message: computer core offline' });
      const reach = to.filter((u) => sameNetwork(ws.shipKey, u.shipKey) && coresOnline(u.shipKey));
      const down = (u) => (u.shipKey === ws.shipKey ? !commsUp(ws.shipKey, 'rf') : !commsUp(ws.shipKey, 'radio') || !commsUp(u.shipKey, 'radio'));
      const sent = reach.filter((u) => !down(u));
      const failed = to.filter((u) => !sent.includes(u));
      if (failed.length) send(ws, { type: 'notice', text: `Communications: no message to ${failed.map((u) => u.name).join(', ')} (${failed.some((u) => !sameNetwork(ws.shipKey, u.shipKey)) ? 'not on our comm net' : failed.some((u) => !coresOnline(u.shipKey)) ? `the ${shipName(failed.find((u) => !coresOnline(u.shipKey)).shipKey)}'s computer core is offline` : 'no power to local RF or radio'})` });
      if (!sent.length) return;
      const m = { type: 'text', from: info(ws), to: sent.map(info), text, at: Date.now() };
      for (const u of [ws, ...sent]) send(u, m);
      return;
    }

    // Call waiting, "join": bring the person calling us into the call we're in.
    // Everyone in it is told, and the caller connects to each of them.
    if (msg.type === 'merge' && ws.id) {
      const caller = typeof msg.caller === 'string' && users.get(msg.caller);
      if (!caller || ws.state !== 'in-call' || !ws.cid || caller.state !== 'calling' || !caller.peers.includes(ws.id)) {
        if (caller) send(caller, { type: 'decline', reason: 'busy', from: ws.id, fromInfo: info(ws), cid: caller.cid });
        return send(ws, { type: 'notice', text: 'Could not join them into the call' });
      }
      const members = [ws, ...ws.peers.map((id) => users.get(id)).filter(Boolean)];
      for (const m of members) send(m, { type: 'add-peer', peer: info(caller), cid: ws.cid, via: 'join' });
      send(caller, { type: 'connect', peers: members.map(info), role: 'caller', cid: ws.cid, via: 'join' });
      console.log(`${ws.name} joined ${caller.name} into the call with ${ws.peers.length} other(s)`);
      return;
    }

    if (RELAYED.has(msg.type) && ws.id && typeof msg.to === 'string') {
      const target = users.get(msg.to);
      // Crew can only place calls on their data network (their own ship when
      // unlinked); other ships go through ops.
      if (!target || (msg.type === 'call' && !sameNetwork(ws.shipKey, target.shipKey))) return send(ws, { type: 'unavailable', id: msg.to });
      // Communications' subsystems: local RF for calls aboard, radio between ships.
      if (msg.type === 'call' && !commsReach(ws)) {
        send(ws, { type: 'notice', text: `${COMMS_OFFLINE}: the call can't go through` });
        return send(ws, { type: 'unavailable', id: msg.to });
      }
      if (msg.type === 'call') {
        // Calls aboard go by local RF; calls to another ship on the data network by the link (subspace relays).
        const same = ws.shipKey === target.shipKey;
        const down = same ? (!commsUp(ws.shipKey, 'rf') && 'local RF') : !commsUp(ws.shipKey, 'subspace') ? 'our subspace relay' : !commsUp(target.shipKey, 'subspace') ? `the ${shipName(target.shipKey)}'s subspace relay` : null;
        if (down) {
          send(ws, { type: 'notice', text: `Communications: ${down} has no power, the call can't go through` });
          return send(ws, { type: 'unavailable', id: msg.to });
        }
      }
      // Confined to quarters: only Security, Medical or ops can be called.
      if (msg.type === 'call' && ws.confined && !CONFINED_MAY_CALL.has(target.station)) {
        send(ws, { type: 'notice', text: 'You are confined to quarters: you can only call Security, Medical or ops' });
        return send(ws, { type: 'unavailable', id: msg.to });
      }
      if (msg.type === 'call' && typeof msg.cid === 'string' && ws.shipKey !== target.shipKey && !carriers.has(msg.cid)) carriers.set(msg.cid, 'link');
      send(target, { ...msg, to: undefined, from: ws.id, fromInfo: info(ws) });
    }
  });

  ws.on('close', () => {
    sockets.delete(ws);
    tokens.delete(ws.token);
    if (ws.shipcore) return coreSignOff(ws);
    if (ws.operator) leaveOps(ws);
    if (ws.id) signOut(ws);
  });

  if (!needLogin() || ws.account) greet(ws);
});
// The relay's own station list, so pages only offer stations it accepts
// (and can tell when the relay is older than the pages); and the ships.
// (Not before a session, once there are accounts.)
function greet(ws) {
  ws.greeted = true;
  send(ws, { type: 'hello', accounts: needLogin(), ...(ws.account ? { account: { username: ws.account.username, role: ws.account.role } } : {}), relay: RELAY_NAME, stations: STATIONS, opsKey: !!OPERATOR_KEY, version: require('./package.json').version,
    // The star chart, and each design's places and bridge seats (for listing consoles by where they are, and the room mic).
    system: { id: SYSTEM_ID, name: STAR_SYSTEM.name, size: STAR_SYSTEM.size, bodies: STAR_SYSTEM.bodies, waypoints: STAR_SYSTEM.waypoints },
    designs: Object.fromEntries([...Object.entries(CLASSES), ['starbase', BASE_DESIGN], [RELAY_DESIGN.id, RELAY_DESIGN]].map(([id, c]) => [id, { name: c.name, kind: id === 'starbase' ? 'starbase' : c.kind || 'ship', places: c.places, seats: c.seats }])) });
  send(ws, { type: 'ships', ships: shipList() });
}

server.listen(PORT, HOST || undefined, () => console.log(`${RELAY_NAME} on http://${HOST && HOST !== '0.0.0.0' && HOST !== '::' ? (HOST.includes(':') ? `[${HOST}]` : HOST) : 'localhost'}:${PORT}${HOST ? ` (listening on ${HOST})` : ''}`));

// Run by tools/supervisor.js: before a restart (or after the pages change)
// every console is told to reload; they rejoin as who and where they were.
// The admin panel (shift-click the relay's name at the foot of a console): it
// asks the supervisor (npm start) what it runs, and to restart things.
// TODO: no access control yet (fine on localhost): add it before this goes live.
const adminWaiting = new Map(); // request id -> socket
let adminSeq = 0;
// The vessels as the admin page shows them: class, crew, ops, where.
// (The classes this relay has loaded, for the admin page: did a reload apply a design?)
const adminClasses = () => Object.fromEntries(Object.entries(CLASSES).map(([id, c]) => [id, { name: c.name, bus: c.bus, eps: c.eps }]));
// (The relays have their own rows: Fleet's ships and starbases are the rest.)
const adminFleet = () => networkGraph().ships.filter((v) => !isRelay(shipKey(v.name))).map((v) => ({ name: v.name, class: v.class, classId: navState.has(shipKey(v.name)) && !v.starbase ? classId(shipKey(v.name)) : null, classUnknown: classGuessed.has(shipKey(v.name)), starbase: !!v.starbase, crew: v.crew, ops: v.ops, computer: v.computer, x: v.x, y: v.y }));
// The account API: GET me; POST register, login, logout (JSON). A login sets the session
// cookie (HttpOnly, SameSite=Lax); a page from another origin gets the token to send by message.
function accountRequest(req, res, what) {
  const json = (code, v, headers = {}) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }).end(JSON.stringify(v));
  if (what === 'me' && req.method === 'GET') return json(200, { accounts: ACCOUNTS.any(), user: ACCOUNTS.session(sessionToken(req)), registration: SETTINGS.read().registration });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => {
    let m;
    try { m = JSON.parse(body || '{}'); } catch { return json(400, { error: 'bad request' }); }
    let cross = false;
    try { cross = !!req.headers.origin && new URL(req.headers.origin).host !== req.headers.host; } catch {}
    const loggedIn = (l) => json(200, { user: l.user, ...(cross ? { token: l.token } : {}) }, { 'Set-Cookie': sessionCookie(req, l.token) });
    const addr = req.socket.remoteAddress;
    if (what === 'register') {
      if (m.confirm !== undefined && m.password !== m.confirm) return json(400, { error: "the passwords don't match" });
      const r = ACCOUNTS.register(m.username, m.password, SETTINGS.read().registration);
      if (r.error) return json(400, r);
      console.log(`accounts: ${r.user.username} registered (${r.user.role}, ${r.user.status})`);
      if (r.user.status !== 'active') return json(200, { pending: true, user: r.user });
      const l = ACCOUNTS.login(m.username, m.password, addr);
      return l.error ? json(400, { error: l.error }) : loggedIn(l);
    }
    if (what === 'login') {
      const l = ACCOUNTS.login(m.username, m.password, addr);
      if (l.error) return json(/^too many/.test(l.error) ? 429 : 401, { error: l.error });
      console.log(`accounts: ${l.user.username} logged in`);
      return loggedIn(l);
    }
    if (what === 'logout') {
      const t = sessionToken(req) || (typeof m.token === 'string' ? m.token : null);
      ACCOUNTS.logout(t);
      dropSockets((ws) => t && ws.session === t, 'logged out');
      return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(req, null) });
    }
    return json(404, { error: 'no such call' });
  });
}
// Consoles whose session ended (logged out, disabled, deleted, a new password): told, then closed.
function dropSockets(which, reason) {
  for (const ws of [...sockets]) if (!ws.shipcore && which(ws)) { send(ws, { type: 'logged-out', reason }); ws.close(4401, reason); }
}

function adminRequest(ws, msg) {
  if (!adminReach(ws.addr)) return send(ws, { type: 'admin-status', error: `refused: the admin page is for ${SETTINGS.read().adminAccess === 'lan' ? 'this network' : 'this machine (localhost)'} only` });
  if (needLogin()) {
    ws.account = ACCOUNTS.session(ws.session);
    if (ws.account?.role !== 'admin') return send(ws, { type: 'admin-status', error: 'refused: the admin page needs an admin login' });
  }
  if (msg.action === 'settings' || msg.action === 'settings-save') return adminSettings(ws, msg);
  if (msg.action === 'set-class') return adminSetClass(ws, msg);
  if (['users', 'user', 'user-create'].includes(msg.action)) return adminUsers(ws, msg);
  if (msg.action === 'create') return adminCreate(ws, msg);
  if (msg.action === 'designs' || msg.action === 'design-save') return adminDesigns(ws, msg);
  if (msg.action === 'relay') {
    const k = shipKey(clean(msg.name || ''));
    if (!isRelay(k)) return send(ws, { type: 'admin-created', ok: false, text: 'no such relay' });
    if (msg.on) relayOff.delete(k); else relayOff.add(k);
    baseSettings[shipName(k)] = { ...baseSettings[shipName(k)], relayOff: !msg.on };
    saveBaseSettings();
    relayTick();
    console.log(`admin: ${shipName(k)} ${msg.on ? 'enabled' : 'disabled'}`);
    return send(ws, { type: 'admin-created', ok: true, text: `${shipName(k)} ${msg.on ? 'enabled: its links are back' : 'disabled: its links are down'}` });
  }
  if (!process.send) return send(ws, { type: 'admin-status', error: 'no supervisor: the relay was started on its own (npm start runs the supervisor)', relayName: RELAY_NAME, fleet: adminFleet(), classes: adminClasses(), consoles: [...users.values()].map((u) => ({ name: u.name, ship: shipName(u.shipKey), station: u.station })), bases: STARBASES.map((b) => ({ name: b.name, x: b.x, y: b.y })), relays: RELAYS.map((r) => ({ name: r.name, x: r.x, y: r.y, system: r.system, on: !relayOff.has(shipKey(r.name)) })) });
  const reqId = ++adminSeq;
  adminWaiting.set(reqId, ws);
  setTimeout(() => adminWaiting.delete(reqId), 10000);
  process.send({ type: 'admin', reqId, action: ['status', 'restart-ship', 'restart-ships', 'restart-relay'].includes(msg.action) ? msg.action : 'status', ship: typeof msg.ship === 'string' ? msg.ship : undefined });
}
// Settings (data/settings.json): the address the relay listens on, registration, where the
// admin page answers. Checked first (an address this machine has, a port that's free and not
// 8080); saved, the supervisor restarts the relay on it (its watch on data/).
async function adminSettings(ws, msg) {
  const reply = (m) => send(ws, { type: 'admin-settings', ...m, settings: SETTINGS.read(), effective: SETTINGS.effective(), listening: { host: HOST || '', port: PORT }, supervised: !!process.send, accounts: ACCOUNTS.any() });
  if (msg.action === 'settings') return reply({});
  const change = {};
  for (const k of ['host', 'port', 'registration', 'adminAccess']) if (msg.settings?.[k] !== undefined) change[k] = k === 'port' ? Number(msg.settings[k]) : String(msg.settings[k]).trim();
  const bad = SETTINGS.check(change);
  if (bad) return reply({ saved: false, error: bad });
  const port = change.port ?? PORT, host = change.host ?? (HOST || '');
  const moving = port !== PORT || host !== (HOST || '');
  // (A new port must be free there; a new address must be one this machine has.)
  const tried = port !== PORT ? await SETTINGS.portFree(port, host) : host !== (HOST || '') && host ? await SETTINGS.portFree(0, host) : true;
  if (tried !== true) return reply({ saved: false, error: tried === 'EADDRNOTAVAIL' ? { field: 'host', message: 'this machine has no such address' } : { field: 'port', message: `port ${port} is in use` } });
  SETTINGS.save(change);
  console.log(`admin: settings saved (${Object.keys(change).join(', ')})`);
  reply({ saved: true, moving });
}
// A ship's class changed from the admin page (one whose save lost it, say): its design from now
// on, its power paths reconciled as on a design change, and its computer saves it.
function adminSetClass(ws, msg) {
  const k = shipKey(clean(msg.name || '')), cls = String(msg.cls || '');
  const note = (ok, text) => send(ws, { type: 'admin-created', ok, text });
  if (!navState.has(k) || isBase(k) || isRelay(k)) return note(false, 'no such ship');
  if (!CLASSES[cls]) return note(false, `no class ${cls}`);
  shipClasses.set(k, cls);
  classGuessed.delete(k);
  // A new class: its engineering rebuilt from the design, as a ship of that class comes up ready
  // (its systems, ties, limiters, batteries, conduits, automation; damage repaired), keeping where
  // it is and what it's docked with, and its fuel (no more than the tanks hold).
  if (eng.has(k)) {
    const old = eng.get(k), fresh = freshEng(undefined, { k });
    delete fresh.restore;
    Object.assign(fresh.ties, classOf(k).ties || {});
    for (const f of ['docked', 'dockedPort', 'shipDocks', 'landed', 'drydock', 'berth', 'conn', 'connTies', 'bayOpen', 'remoteBlock', 'prefix', 'orderLog', 'towing']) if (old[f] !== undefined) fresh[f] = old[f];
    fresh.antimatter = Math.min(old.antimatter, fresh.fuelCaps.antimatter); fresh.deuterium = Math.min(old.deuterium, fresh.fuelCaps.deuterium);
    eng.set(k, fresh);
    deriveConduits(k);
    designReactors(k, true);
    pruneLoads(k);
    const c = combatOf(k);
    for (const x of Object.keys(c.damage || {})) c.damage[x] = 0;
    fresh.dirty = true;
  }
  flowCache.delete(k);
  const core = primaryCore.get(k);
  if (core) send(core, { type: 'core-primary', ship: shipName(k), primary: true, nav: coreCopy(k) });
  broadcastShips();
  console.log(`admin: the ${shipName(k)} is ${CLASSES[cls].name} class now`);
  note(true, `the ${shipName(k)} is ${CLASSES[cls].name} class now`);
}
// The user manager: every account (role, status, created, last login, characters it has used
// and those aboard now); approve or reject, promote or demote, disable or enable, a new
// password (shown once), log out everywhere, delete; add one. Never leaves no admin.
function adminUsers(ws, msg) {
  const online = (name) => [...users.values()].filter((u) => u.account?.username === name).map((u) => `${u.name} (${u.ship})`);
  const reply = (m = {}) => send(ws, { type: 'admin-users', ...m, users: ACCOUNTS.list().map((u) => ({ ...u, online: online(u.username) })), registration: SETTINGS.read().registration, me: ws.account?.username || null });
  if (msg.action === 'users') return reply();
  if (msg.action === 'user-create') {
    const r = ACCOUNTS.register(msg.username, msg.password, 'open', { byAdmin: true, role: msg.role });
    if (!r.error) console.log(`admin: added the account ${r.user.username} (${r.user.role})`);
    return reply(r.error ? { error: r.error } : { note: `${r.user.username} added (${r.user.role})` });
  }
  const name = ACCOUNTS.norm(msg.username), change = String(msg.change || '');
  const r = ACCOUNTS.update(name, { action: change });
  if (r.error) return reply({ error: `${name}: ${r.error}` });
  console.log(`admin: ${change} ${name}`);
  if (['disable', 'delete', 'logout', 'reset-password', 'reject'].includes(change)) dropSockets((s) => s.account?.username === name, { disable: 'your account was disabled', delete: 'your account was deleted', logout: 'an admin logged you out', 'reset-password': 'your password was reset: log in again', reject: 'your account was not approved' }[change]);
  for (const s of sockets) if (s.account?.username === name) s.account = ACCOUNTS.session(s.session);
  const done = { approve: 'approved', reject: 'rejected', promote: 'is an admin now', demote: 'is a player now', disable: 'disabled', enable: 'enabled', delete: 'deleted', logout: `logged out everywhere (${r.ended} session${r.ended === 1 ? '' : 's'})`, 'reset-password': 'has a new password' }[change];
  return reply({ note: `${name} ${done}`, ...(r.temp ? { temp: { username: name, password: r.temp } } : {}) });
}
// The ship design editor: the designs as their files say, and saving one (checked as the
// loader checks it; a backup kept). Removing a place or system a live ship of that class
// uses asks first (confirm). The supervisor's config watch reloads the relay to apply it.
function adminDesigns(ws, msg) {
  const reply = (m) => send(ws, { type: 'admin-designs', ...m });
  const files = CONFIG.readShips();
  if (msg.action === 'designs') return reply({ designs: files, loaded: Object.keys(CLASSES), stations: STATIONS, systems: SYSTEMS, subsystems: Object.keys(SUBSYSTEMS) });
  const id = String(msg.id || '').toLowerCase(), design = msg.design;
  if (!msg.asNew && !files[id]) return reply({ saved: false, error: { field: 'id', message: 'no such class' } });
  if (msg.asNew && files[id]) return reply({ saved: false, error: { field: 'id', message: `there's already a class ${id}` } });
  // (What a live ship of this class would lose: its places, its systems.)
  const was = files[id];
  if (was && !msg.confirm) {
    const lostPlaces = (was.places || []).map((p) => p.name).filter((n) => !(design?.places || []).some((p) => p.name === n));
    const lostRows = (was.places || []).flatMap((p) => p.rows || []).filter((r) => !(design?.places || []).some((p) => (p.rows || []).includes(r)));
    const live = [...shipClasses].filter(([k, c]) => c === id && present(k)).map(([k]) => shipName(k));
    if ((lostPlaces.length || lostRows.length) && live.length) return reply({ saved: false, confirm: { ships: live, places: lostPlaces, rows: lostRows } });
  }
  const err = CONFIG.saveShip(id, design);
  if (err) return reply({ saved: false, error: err });
  console.log(`admin: design ${id} saved${msg.asNew ? ' (a new class)' : ''}`);
  reply({ saved: true, id, note: process.send ? 'saved: the supervisor reloads the relay and the ship\'s computers to apply it' : 'saved (no supervisor here: restart the relay to apply it)' });
}
// Create a ship (the supervisor starts its computer: --class, docked cold at
// the starbase picked) or a starbase (here, at the spot picked on the map; kept
// in the starbase file). Names must be new.
const pendingSpawn = new Map(); // ship key -> the starbase a new ship comes up docked at
const createWaiting = new Map(); // admin request id -> { ws, name, text }: a ship being created
function adminCreate(ws, msg) {
  const reply = (ok, text) => send(ws, { type: 'admin-created', ok, text });
  const name = clean(msg.name), cls = String(msg.cls || '').toLowerCase();
  if (!NAME_RE.test(name)) return reply(false, 'name: use 1-32 letters, digits, spaces, \' . -');
  if (ships.has(shipKey(name))) return reply(false, `there's already a vessel called ${shipName(shipKey(name))}`);
  if (cls === 'starbase') {
    const x = Number(msg.x), y = Number(msg.y);
    if (!(x >= 0 && x <= 1000 && y >= 0 && y <= 1000)) return reply(false, 'pick a spot on the map');
    createStarbase(name, Math.round(x), Math.round(y));
    saveBaseSettings();
    console.log(`admin: starbase ${name} created at ${Math.round(x)}, ${Math.round(y)}`);
    return reply(true, `${name} created at ${Math.round(x)}, ${Math.round(y)}`);
  }
  if (!CLASSES[cls]) return reply(false, 'pick a class');
  const at = STARBASES.find((b) => b.name === msg.at);
  if (!at) return reply(false, 'pick where it is parked');
  if (!process.send) return reply(false, "no supervisor: the relay was started on its own (npm start runs the supervisor, which starts the new ship's computer)");
  pendingSpawn.set(shipKey(name), at.name);
  // (A supervisor started before ship creation existed answers without starting its computer.)
  const reqId = ++adminSeq;
  createWaiting.set(reqId, { ws, name, text: `the ${name} (${CLASSES[cls].name} class) is being created, parked at ${at.name}: its computer is starting` });
  setTimeout(() => { if (createWaiting.delete(reqId)) { pendingSpawn.delete(shipKey(name)); reply(false, 'no answer from the supervisor'); } }, 10000);
  process.send({ type: 'admin', reqId, action: 'create-ship', ship: name, cls });
  console.log(`admin: creating the ${name} (${CLASSES[cls].name} class), parked at ${at.name}`);
}
function createStarbase(name, x, y) {
  STARBASES.push({ name, x, y, created: true });
  const k = registerShip(name);
  BASE_KEYS.add(k);
  navState.set(k, { x, y, heading: 0, warp: 0, dest: null });
  engOf(k);
  broadcastShips();
  broadcastAllOps();
}
process.on('message', (m) => {
  if (m?.type !== 'admin-reply') return;
  const made = createWaiting.get(m.reqId);
  if (made) {
    createWaiting.delete(m.reqId);
    if (m.status?.ships?.some((x) => x.ship === made.name)) send(made.ws, { type: 'admin-created', ok: true, text: made.text }); // (its computer is running now)
    else { pendingSpawn.delete(shipKey(made.name)); send(made.ws, { type: 'admin-created', ok: false, text: 'the supervisor running now predates ship creation: restart npm start to enable ship creation' }); }
  }
  const ws = adminWaiting.get(m.reqId);
  adminWaiting.delete(m.reqId);
  if (!ws) return;
  const consoles = [...users.values()].map((u) => ({ name: u.name, ship: shipName(u.shipKey), station: u.station }));
  send(ws, { type: 'admin-status', ...m.status, note: m.note, consoles, relayName: RELAY_NAME, fleet: adminFleet(), classes: adminClasses(), bases: STARBASES.map((b) => ({ name: b.name, x: b.x, y: b.y })), relays: RELAYS.map((r) => ({ name: r.name, x: r.x, y: r.y, system: r.system, on: !relayOff.has(shipKey(r.name)) })) });
});
process.on('message', (m) => {
  if (m?.type !== 'reload') return;
  for (const ws of sockets) if (!ws.shipcore) send(ws, { type: 'reload', restart: !!m.restart });
});
module.exports = server;
