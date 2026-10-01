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
// every ship in it. Links close when either operator closes them or a ship's
// last ops station signs off.
// A ship comes into existence when its ops station first signs on, and crew
// pick their ship from that list. If ops drops out, calls in progress carry on
// (including calls with other ships) and crew can still call each other aboard,
// but no new off-ship communication can start until ops is back.
// Each ship has a library (the ship's computer): files uploaded by its crew,
// stored on disk as data/<ship>/<file>. Crew can download from their own
// ship's library and from every library on their data network.
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
const { pipeline } = require('stream/promises');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const OPERATOR_KEY = process.env.OPERATOR_KEY || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 200) * 1024 * 1024;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const NAME_RE = /^[\w][\w .'-]{0,31}$/;  // names and ships: K'Vatch, Jean-Luc, ...
const OPS_STATION = 'Operations';   // operators only
const STATIONS = ['Captain', 'First Officer', 'Helm', 'Tactical', 'Security', 'Engineering', 'Medical', 'Science', 'Communications', 'Transporter', 'Crew'];
// Operator commands (everything else from an operator is handled as crew).
const OP_COMMANDS = new Set(['connect', 'add', 'end', 'hail', 'route', 'decline-hail', 'cancel-hail', 'transfer',
  'link-request', 'link-accept', 'link-decline', 'link-cancel', 'link-close', 'all-hands', 'all-hands-end']);
// Message types one user may send to another; the server adds `from` and forwards.
const RELAYED = new Set(['call', 'accept', 'decline', 'hangup', 'signal']);
const STATES = new Set(['idle', 'calling', 'ringing', 'in-call']);

const server = http.createServer((req, res) => {
  const urlPath = new URL(req.url, 'http://x').pathname;
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

const wss = new WebSocketServer({ server });
const users = new Map();     // user id ("name@ship", lowercased) -> ws
const operators = new Set(); // operator sockets; each has .ship and .shipKey
const ships = new Map();     // ship key -> display name (first spelling seen)
const sockets = new Set();   // every connection, for the ship list
const shields = new Set();   // ship keys with shields up
const hails = new Map();     // hail id -> { id, fromShip, toShip, caller (user id) }
const links = new Set();     // data links: "shipKeyA|shipKeyB", sorted
const linkRequests = new Map(); // request id -> { id, fromShip, toShip }

const clean = (s) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '');
const shipKey = (ship) => ship.toLowerCase();
const userId = (name, ship) => `${name.toLowerCase()}@${shipKey(ship)}`;
const info = (ws) => ({ id: ws.id, name: ws.name, ship: ws.ship, station: ws.station });
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
const linkedTo = (key) => [...links].map((l) => l.split('|')).filter((l) => l.includes(key)).map((l) => (l[0] === key ? l[1] : l[0]));
// Every ship reachable over data links from `key`, including itself.
function network(key) {
  const seen = new Set([key]);
  const todo = [key];
  while (todo.length) for (const k of linkedTo(todo.pop())) if (!seen.has(k)) { seen.add(k); todo.push(k); }
  return seen;
}
const sameNetwork = (a, b) => network(a).has(b);

// Crew see everyone aboard ships on their data network (just their own ship
// when unlinked). `ops` says whether their own ship has ops on duty.
function broadcastCrew(key) {
  scheduleTraffic();
  const net = network(key);
  const list = [...net].flatMap(crewOf).map(info)
    .sort((a, b) => a.ship.localeCompare(b.ship) || a.name.localeCompare(b.name));
  for (const k of net) {
    const ops = opsOf(k).length > 0;
    for (const u of crewOf(k)) {
      send(u, { type: 'users', users: list, ops, network: [...net].map(shipName).sort() });
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
  if (!ops.length) return;
  const roster = crewOf(key)
    .map((u) => ({ ...info(u), state: u.state, peers: u.peers.map(peerInfo) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const otherShips = [...new Set([...operators].map((op) => op.shipKey))]
    .filter((k) => k !== key).map(shipName).sort();
  const describe = (h) => ({ id: h.id, fromShip: shipName(h.fromShip), toShip: shipName(h.toShip), caller: peerInfo(h.caller) });
  const all = [...hails.values()];
  const requests = [...linkRequests.values()].map((r) => ({ id: r.id, fromShip: shipName(r.fromShip), toShip: shipName(r.toShip), from: r.fromShip, to: r.toShip }));
  const msg = {
    type: 'roster',
    ship: shipName(key),
    users: roster,
    ships: otherShips,
    incoming: all.filter((h) => h.toShip === key).map(describe),
    outgoing: all.filter((h) => h.fromShip === key).map(describe),
    links: linkedTo(key).map(shipName).sort(),
    network: [...network(key)].filter((k) => k !== key).map(shipName).sort(),
    linkIncoming: requests.filter((r) => r.to === key).map(({ id, fromShip }) => ({ id, fromShip })),
    linkOutgoing: requests.filter((r) => r.from === key).map(({ id, toShip }) => ({ id, toShip })),
    graph: networkGraph(),
    broadcasts: [...broadcasts.values()].filter((b) => b.ships.has(key) || users.get(b.speaker)?.shipKey === key)
      .map((b) => ({ id: b.bid, speaker: peerInfo(b.speaker), label: b.label, since: b.since })),
  };
  for (const op of ops) send(op, msg);
}

// The whole picture for the ops data link map: every ship, its crew count and
// shields, every open data link and every pending link request.
function networkGraph() {
  return {
    ships: shipList().map((sh) => ({ ...sh, crew: crewOf(shipKey(sh.name)).length })),
    links: [...links].map((l) => l.split('|').map(shipName)),
    requests: [...linkRequests.values()].map((r) => [shipName(r.fromShip), shipName(r.toShip)]),
  };
}

// Ships crew can report aboard: those with an ops station on duty, plus those
// whose ops dropped out while crew are still aboard (no off-ship comms there).
function shipList() {
  const keys = new Set([...[...operators].map((op) => op.shipKey), ...[...users.values()].map((u) => u.shipKey)]);
  return [...keys].map((k) => ({ name: shipName(k), ops: opsOf(k).length > 0, shields: shields.has(k) })).sort((a, b) => a.name.localeCompare(b.name));
}
// Everyone gets the ship list: the sign-in pull-down, transporter targets,
// and shield status.
function broadcastShips() {
  const list = shipList();
  for (const ws of sockets) send(ws, { type: 'ships', ships: list });
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
function forceConnect(a, b) {
  const cid = newId('op-');
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
      if (!opsOf(target).length) return fail(`no response from ${clean(msg.ship) || 'that ship'}: no operator on duty`);
      if ([...hails.values()].some((h) => h.caller === caller.id)) return fail(`${caller.name} already has a hail pending`);
      const h = { id: newId('h-'), fromShip: op.shipKey, toShip: target, caller: caller.id, since: Date.now() };
      hails.set(h.id, h);
      send(caller, { type: 'notice', text: `Ops is hailing the ${shipName(target)} for you` });
      opLog(target, `incoming hail from the ${shipName(op.shipKey)}: ${caller.name}, ${caller.station}`);
      broadcastOps(target);
      broadcastOps(op.shipKey);
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
      forceConnect(caller, callee);
      opLog(h.fromShip, `the ${shipName(op.shipKey)} answered: ${caller.name} is connected to ${callee.name}, ${callee.station}`);
      broadcastOps(h.fromShip);
      broadcastOps(op.shipKey);
      return ok(`routed the hail from the ${shipName(h.fromShip)} (${caller.name}) to ${callee.name}`);
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
      if (!opsOf(target).length) return fail(`no response from ${clean(msg.ship) || 'that ship'}: no operator on duty`);
      if (links.has(linkKey(op.shipKey, target))) return fail(`a data link with the ${shipName(target)} is already open`);
      if ([...linkRequests.values()].some((r) => linkKey(r.fromShip, r.toShip) === linkKey(op.shipKey, target))) return fail(`a data link with the ${shipName(target)} is already being negotiated`);
      const req = { id: newId('l-'), fromShip: op.shipKey, toShip: target };
      linkRequests.set(req.id, req);
      opLog(target, `the ${shipName(op.shipKey)} requests a data link`);
      broadcastAllOps();
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
        if (!opsOf(other).length) { broadcastOps(op.shipKey); return fail(`no operator on duty aboard the ${shipName(other)}`); }
        links.add(linkKey(req.fromShip, req.toShip));
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
    case 'link-close': {
      const other = shipKey(clean(msg.ship));
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
  dropHails((h) => h.caller === ws.id, `${ws.name} left the comm net`);
  for (const u of users.values()) send(u, { type: 'gone', id: ws.id });
  broadcastCrew(ws.shipKey);
  for (const id of ws.peers) { const p = users.get(id); if (p && p.shipKey !== ws.shipKey) broadcastOps(p.shipKey); }
  console.log(`${ws.name} left the ${ws.ship}`);
  broadcastShips(); // the ship may no longer exist
}

// Beam a crew member to another ship: their call ends, they leave this ship's
// comm net and report aboard the other one, keeping their name and station.
function beam(u, toKey) {
  const from = u.ship;
  send(u, { type: 'force-hangup', reason: `beamed to the ${shipName(toKey)}` });
  signOut(u);
  Object.assign(u, { id: userId(u.name, shipName(toKey)), shipKey: toKey, ship: shipName(toKey), state: 'idle', peers: [], cid: null });
  users.set(u.id, u);
  send(u, { type: 'registered', ...info(u), token: u.token, beamedFrom: from });
  sendShipRadio(u);
  joinBroadcasts(u);
  broadcastCrew(toKey);
  broadcastShips();
  opLog(toKey, `${u.name} (${u.station}) beamed aboard from the ${from}`);
  console.log(`${u.name} beamed from the ${from} to the ${u.ship}`);
}

// --- library ----------------------------------------------------------------------

// Session tokens let the browser prove who it is on plain HTTP requests.
const tokens = new Map(); // token -> ws

// A ship's library folder: data/<ship>, matched case-insensitively so the
// folder survives restarts even if the ship name is typed differently.
function libraryDir(key, create) {
  let dirs = [];
  try { dirs = fs.readdirSync(DATA_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  const found = dirs.find((d) => d.toLowerCase() === key);
  if (found) return path.join(DATA_DIR, found);
  if (!create) return null;
  const dir = path.join(DATA_DIR, shipName(key));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listLibrary(key) {
  const dir = libraryDir(key, false);
  if (!dir) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('.'))
    .map((d) => { const st = fs.statSync(path.join(dir, d.name)); return { name: d.name, size: st.size, modified: st.mtimeMs }; })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Every library on this person's data network, their own ship first.
function sendLibrary(ws) {
  const keys = [...network(ws.shipKey)].sort((a, b) => (b === ws.shipKey) - (a === ws.shipKey) || shipName(a).localeCompare(shipName(b)));
  send(ws, { type: 'library', ships: keys.map((k) => ({ name: shipName(k), own: k === ws.shipKey, files: listLibrary(k) })) });
}

// A safe file name: no folders, control characters or leading dots.
function safeName(raw) {
  const name = String(raw || '').normalize('NFC').replace(/[\x00-\x1f\x7f]/g, '').replace(/[/\\]/g, '_').trim().replace(/^\.+/, '').slice(0, 120);
  return name || null;
}

function uniqueName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

// POST   /api/library            upload to your own ship (X-Token, X-Filename)
// GET    /api/library/<ship>/<f> download, from any ship on your data network
// DELETE /api/library/<ship>/<f> ops only, own ship only
async function libraryRequest(req, res, urlPath) {
  const ws = tokens.get(req.headers['x-token']);
  if (!ws?.id) return res.writeHead(401).end('Sign in first');

  if (req.method === 'POST' && urlPath === '/api/library') {
    let name;
    try { name = safeName(decodeURIComponent(req.headers['x-filename'] || '')); } catch { name = null; }
    if (!name) return res.writeHead(400).end('Missing file name');
    if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD) return res.writeHead(413).end('File too large');
    const dir = libraryDir(ws.shipKey, true);
    const tmp = path.join(dir, `.upload-${crypto.randomBytes(6).toString('hex')}`);
    let size = 0;
    try {
      await pipeline(req, async function* (chunks) {
        for await (const chunk of chunks) {
          size += chunk.length;
          if (size > MAX_UPLOAD) throw new Error('too large');
          yield chunk;
        }
      }, fs.createWriteStream(tmp));
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      return res.writeHead(err.message === 'too large' ? 413 : 400).end(err.message === 'too large' ? 'File too large' : 'Upload failed');
    }
    const finalName = uniqueName(dir, name);
    fs.renameSync(tmp, path.join(dir, finalName));
    console.log(`${ws.name} uploaded ${finalName} (${size} bytes) to the ${ws.ship} library`);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ name: finalName, size }));
    for (const k of network(ws.shipKey)) for (const u of crewOf(k)) sendLibrary(u);
    return;
  }

  const m = (req.method === 'GET' || req.method === 'DELETE') && urlPath.match(/^\/api\/library\/([^/]+)\/([^/]+)$/);
  if (!m) return res.writeHead(404).end('Not found');
  let key, name;
  try { key = shipKey(decodeURIComponent(m[1])); name = safeName(decodeURIComponent(m[2])); } catch { return res.writeHead(400).end('Bad request'); }

  if (req.method === 'DELETE') {
    if (!ws.operator) return res.writeHead(403).end('Only ops can delete library files');
    if (key !== ws.shipKey) return res.writeHead(403).end("Ops can only delete from their own ship's library");
    const dir = libraryDir(key, false);
    const file = dir && name && path.join(dir, name);
    if (!file || path.dirname(file) !== dir || !fs.existsSync(file)) return res.writeHead(404).end('No such file');
    fs.rmSync(file);
    console.log(`${ws.name} deleted ${name} from the ${ws.ship} library`);
    opLog(ws.shipKey, `${ws.name} deleted ${name} from the library`);
    res.writeHead(204).end();
    for (const k of network(ws.shipKey)) for (const u of crewOf(k)) sendLibrary(u);
    return;
  }
  if (!sameNetwork(ws.shipKey, key)) return res.writeHead(403).end('That library is not on your data network');
  const dir = libraryDir(key, false);
  const file = dir && name && path.join(dir, name);
  if (!file || path.dirname(file) !== dir || !fs.existsSync(file)) return res.writeHead(404).end('No such file');
  const st = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': st.size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  });
  await pipeline(fs.createReadStream(file), res);
}

// --- ops station on and off duty --------------------------------------------------

// Someone takes (or moves to) a ship's ops station. Several can be on duty;
// any of them can route hails, manage links and so on.
function joinOps(ws) {
  ws.operator = true;
  ws.station = OPS_STATION;
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
    dropHails((h) => h.toShip === ws.shipKey || h.fromShip === ws.shipKey, `no operator on duty aboard the ${ws.ship}`);
    const formerNet = [...network(ws.shipKey)];
    for (const k of linkedTo(ws.shipKey)) { links.delete(linkKey(ws.shipKey, k)); opLog(k, `data link with the ${ws.ship} lost: no operator on duty`); }
    for (const req of [...linkRequests.values()]) if (req.fromShip === ws.shipKey || req.toShip === ws.shipKey) linkRequests.delete(req.id);
    refreshNetworks(formerNet);
  }
  broadcastAllOps();
  broadcastShips();
}

// --- comm traffic (Communications station) ------------------------------------

// Every call in progress (or ringing) that involves someone on this ship's data
// network: who is in it and since when. Metadata only; nobody listens in.
function trafficFor(key) {
  const net = network(key);
  const involved = [...users.values()].filter((u) => u.state !== 'idle' && u.cid);
  const calls = new Map();
  for (const u of involved) {
    const others = u.peers.map((id) => users.get(id)).filter(Boolean);
    if (![u, ...others].some((m) => net.has(m.shipKey))) continue;
    const c = calls.get(u.cid) || { state: u.state === 'in-call' ? 'in-call' : 'ringing', since: u.callSince || Date.now(), members: new Map() };
    for (const m of [u, ...others]) c.members.set(m.id, info(m));
    if (u.state === 'in-call') c.state = 'in-call';
    c.since = Math.min(c.since, u.callSince || Date.now());
    calls.set(u.cid, c);
  }
  const out = [...calls.values()].map((c) => ({ state: c.state, since: c.since, members: [...c.members.values()] }));
  // Hails waiting for the other ship's ops to answer.
  for (const h of hails.values()) {
    if (!net.has(h.fromShip) && !net.has(h.toShip)) continue;
    const caller = users.get(h.caller);
    if (caller) out.push({ state: 'hailing', since: h.since, members: [info(caller)], to: shipName(h.toShip) });
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

// --- ship's radio ----------------------------------------------------------------

const shipRadio = new Map(); // ship key -> { name, url, by: info }

function sendShipRadio(u) {
  send(u, { type: 'ship-radio', radio: shipRadio.get(u.shipKey) || null });
}

// --- connections -------------------------------------------------------------

wss.on('connection', (ws) => {
  sockets.add(ws);
  ws.id = null;
  ws.state = 'idle';
  ws.peers = [];
  ws.cid = null;
  ws.operator = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'operator' && !ws.id && !ws.operator) {
      // The ops station is aboard as crew at the Operations station.
      const ship = clean(msg.ship), name = clean(msg.name);
      if (OPERATOR_KEY && msg.key !== OPERATOR_KEY) return send(ws, { type: 'operator-failed', reason: 'wrong operator key' });
      if (!NAME_RE.test(name)) return send(ws, { type: 'operator-failed', reason: 'enter your name (letters, digits, spaces, \' . -)' });
      if (!NAME_RE.test(ship)) return send(ws, { type: 'operator-failed', reason: 'enter your ship name (letters, digits, spaces, \' . -)' });
      const id = userId(name, ship);
      if (users.has(id)) return send(ws, { type: 'operator-failed', reason: `${name} is already aboard the ${shipName(shipKey(ship))}` });
      ws.id = id;
      ws.name = name;
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
    if (ws.operator && OP_COMMANDS.has(msg.type)) return operatorMessage(ws, msg);

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
      if (!STATIONS.includes(msg.station)) return send(ws, { type: 'register-failed', reason: 'pick a station' });
      if (!shipList().some((s) => s.name.toLowerCase() === ship.toLowerCase())) return send(ws, { type: 'register-failed', reason: `there is no ship called the ${ship}` });
      const id = userId(name, ship);
      if (users.has(id)) return send(ws, { type: 'register-failed', reason: `${name} is already aboard the ${shipName(shipKey(ship))}` });
      ws.id = id;
      ws.name = name;
      ws.shipKey = registerShip(ship);
      ws.ship = shipName(ws.shipKey);
      ws.station = msg.station;
      users.set(id, ws);
      ws.token = crypto.randomBytes(16).toString('hex');
      tokens.set(ws.token, ws);
      send(ws, { type: 'registered', ...info(ws), token: ws.token });
      broadcastCrew(ws.shipKey);
      broadcastShips();
      console.log(`${name} (${ws.station}) reported aboard the ${ws.ship}`);
      sendShipRadio(ws);
      joinBroadcasts(ws);
      return;
    }

    // Move to another station aboard the same ship.
    // Moving to Operations takes an ops station (with the key, if one is set);
    // an operator moving elsewhere leaves it.
    if (msg.type === 'change-station' && ws.id) {
      if (msg.station !== OPS_STATION && !STATIONS.includes(msg.station)) return send(ws, { type: 'notice', text: 'No such station' });
      if (msg.station === ws.station) return;
      const was = ws.station;
      if (msg.station === OPS_STATION) {
        if (OPERATOR_KEY && msg.key !== OPERATOR_KEY) return send(ws, { type: 'station-failed', reason: 'wrong operator key' });
        opLog(ws.shipKey, `${ws.name} moved from ${was} to the ops station`);
        joinOps(ws);
        broadcastTraffic();
        return;
      }
      if (ws.operator) leaveOps(ws);
      ws.station = msg.station;
      send(ws, { type: 'registered', ...info(ws), token: ws.token });
      broadcastCrew(ws.shipKey);
      broadcastTraffic();
      opLog(ws.shipKey, `${ws.name} moved from ${was} to ${ws.station}`);
      return;
    }

    // Tactical raises or lowers the ship's shields.
    if (msg.type === 'shields' && ws.id) {
      if (ws.station !== 'Tactical') return send(ws, { type: 'notice', text: 'Only Tactical can raise or lower shields' });
      if (msg.up) shields.add(ws.shipKey); else shields.delete(ws.shipKey);
      opLog(ws.shipKey, `${ws.name}: shields ${msg.up ? 'up' : 'down'}`);
      broadcastShips();
      return;
    }

    // The transporter beams someone aboard this ship to another ship.
    if (msg.type === 'beam' && ws.id) {
      const fail = (text) => send(ws, { type: 'notice', text: `Transporter: ${text}` });
      if (ws.station !== 'Transporter') return fail('only the transporter room can beam people');
      const u = typeof msg.who === 'string' && users.get(msg.who);
      const toKey = shipKey(clean(msg.ship));
      if (!u || u.shipKey !== ws.shipKey) return fail('that person is not aboard');
      if (u.operator) return fail('the ops station cannot be beamed');
      if (!shipList().some((sh) => shipKey(sh.name) === toKey)) return fail(`no ship called the ${clean(msg.ship)}`);
      if (toKey === ws.shipKey) return fail(`${u.name} is already aboard`);
      for (const k of [ws.shipKey, toKey]) if (shields.has(k)) return fail(`cannot beam through the shields of the ${shipName(k)}`);
      if (users.has(userId(u.name, shipName(toKey)))) return fail(`someone called ${u.name} is already aboard the ${shipName(toKey)}`);
      if (u !== ws) send(u, { type: 'notice', text: `You are being beamed to the ${shipName(toKey)}` });
      beam(u, toKey);
      if (u !== ws) send(ws, { type: 'notice', text: `Transporter: ${u.name} beamed to the ${shipName(toKey)}` });
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
      send(target, { ...msg, to: undefined, from: ws.id, fromInfo: info(ws) });
    }
  });

  ws.on('close', () => {
    sockets.delete(ws);
    tokens.delete(ws.token);
    if (ws.operator) leaveOps(ws);
    if (ws.id) signOut(ws);
  });

  // The relay's own station list, so pages only offer stations it accepts
  // (and can tell when the relay is older than the pages).
  send(ws, { type: 'hello', stations: STATIONS, version: require('./package.json').version });
  send(ws, { type: 'ships', ships: shipList() });
});

server.listen(PORT, () => console.log(`Voice chat on http://localhost:${PORT}`));
module.exports = server;
