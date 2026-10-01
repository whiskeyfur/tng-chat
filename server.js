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

const PORT = process.env.PORT || 8080;
const OPERATOR_KEY = process.env.OPERATOR_KEY || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const RELAY_NAME = process.env.RELAY_NAME || 'Subspace Relay Station 47';
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
const info = (ws) => ({ id: ws.id, name: ws.name, ship: ws.ship, station: ws.station,
  ...(ws.sickbay ? { sickbay: true } : {}), ...(ws.confined ? { confined: true } : {}) });
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
  scheduleNav();
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
  // Ships in range: ops on duty, within subspace (comms) range.
  const otherShips = [...new Set([...operators].map((op) => op.shipKey))]
    .filter((k) => k !== key && commsOk(key, k)).map(shipName).sort();
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
    ships: shipList().filter((sh) => sh.active).map((sh) => ({ ...sh, crew: crewOf(shipKey(sh.name)).length })),
    links: [...links].map((l) => l.split('|').map(shipName)),
    requests: [...linkRequests.values()].map((r) => [shipName(r.fromShip), shipName(r.toShip)]),
  };
}

// Every ship in existence. No ship's computer, no ship: only ships with a
// computer online are offered for sign-in (ops included) or as transporter
// targets. People already aboard when its computer goes offline stay on, so
// the ship is still listed (computer: false) until they leave.
function shipList() {
  const live = new Set([...[...operators].map((op) => op.shipKey), ...[...users.values()].map((u) => u.shipKey), ...cores.keys()]);
  return [...live].map((k) => ({
    name: shipName(k), ops: opsOf(k).length > 0, shields: shields.has(k), computer: cores.has(k), active: true,
  })).sort((a, b) => a.name.localeCompare(b.name));
}
const hasComputer = (name) => cores.has(shipKey(name));
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
        if (!commsOk(op.shipKey, target)) return fail(`the ${shipName(target)} is out of subspace range (${rangeText(op.shipKey, target)})`);
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
      if (!commsOk(op.shipKey, target)) return fail(`the ${shipName(target)} is out of subspace range (${rangeText(op.shipKey, target)})`);
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
      if (!commsOk(op.shipKey, target)) return fail(`the ${shipName(target)} is out of subspace range (${rangeText(op.shipKey, target)})`);
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
        if (!commsOk(op.shipKey, other)) { broadcastOps(op.shipKey); return fail(`the ${shipName(other)} is out of subspace range (${rangeText(op.shipKey, other)})`); }
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
  // Security is told whenever someone beams aboard.
  for (const s of crewOf(toKey)) if (s.station === 'Security' && s !== u) send(s, { type: 'security-alert', text: `${u.name} (${u.station}) beamed aboard from the ${from}`, at: Date.now() });
  console.log(`${u.name} beamed from the ${from} to the ${u.ship}`);
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
const SYSTEMS = ['engines', 'shields', 'sensors', 'transporter', 'weapons', 'lifeSupport'];
const REACTOR = 450; // total power to share, in percent of one system at full
const MIN_SHIELD_POWER = 20;
const DEFAULT_POWER = { engines: 80, shields: 60, sensors: 100, transporter: 60, weapons: 50, lifeSupport: 100 };
// Power as Engineering set it (each system's demand), and what each system
// actually gets from the power grid (see "the power grid" below): damage caps
// a system, unarmed weapons draw nothing, and a bus short of power browns out.
const allocOf = (k) => ({ ...DEFAULT_POWER, ...(navState.get(k)?.power || {}) });
function powerOf(k) {
  const f = flow(k);
  return Object.fromEntries(SYSTEMS.map((s) => [s, Math.floor(f.delivered[s] + 1e-9)]));
}
// How visible a ship is to other ships' sensors: the more power it uses (all
// of it: systems, consoles, the warp core's containment), the further off it
// shows up. 450 units drawn or more: seen at full sensor range; power down to run quiet.
const signatureOf = (k) => Math.max(0.1, Math.min(1, flow(k).drawn / REACTOR));
function rangesOf(k) {
  const f = Math.max(0, Math.min(100, powerOf(k).sensors)) / 100;
  return { comms: COMMS_RANGE * f, sensors: SENSOR_RANGE * f, transporter: TRANSPORTER_RANGE * f };
}
const maxWarp = (k) => (powerOf(k).engines <= 0 ? 0 : Math.max(0.25, Math.round((powerOf(k).engines / 100) * 9 * 10) / 10));
// Both ships' sensors have to reach for subspace comms (hails, data links).
const commsOk = (a, b) => a === b || distance(a, b) <= Math.min(rangesOf(a).comms, rangesOf(b).comms);
const sensorOk = (a, b) => a === b || distance(a, b) <= rangesOf(a).sensors * signatureOf(b);
const transporterOk = (a, b) => a === b || distance(a, b) <= rangesOf(a).transporter;
const navState = new Map();   // ship key -> { x, y, heading, warp, dest }
const primaryCore = new Map(); // ship key -> computer socket flying it
const navTargets = new Map();  // ship key -> ship key it's heading for (intercept)

function distance(a, b) {
  const p = navState.get(a), q = navState.get(b);
  if (!p || !q || !cores.has(a) || !cores.has(b)) return Infinity;
  return Math.hypot(p.x - q.x, p.y - q.y);
}
const rangeText = (a, b) => (Number.isFinite(distance(a, b)) ? `${Math.round(distance(a, b))} units away` : 'position unknown');

function navMessage(key) {
  const own = navState.get(key);
  const seen = [...navState.keys()].filter((k) => cores.has(k) && sensorOk(key, k));
  return {
    type: 'nav',
    own: own ? { name: shipName(key), ...own, power: powerOf(key), allocated: allocOf(key), reactor: REACTOR, signature: signatureOf(key), combat: combatView(key), grid: gridView(key) } : null,
    bases: STARBASES.map((b) => ({ ...b, distance: own ? Math.round(Math.hypot(own.x - b.x, own.y - b.y)) : null })),
    ships: seen.map((k) => ({ name: shipName(k), ...navState.get(k), ops: opsOf(k).length > 0, shields: shields.has(k), distance: k === key ? 0 : distance(key, k) })),
    ranges: rangesOf(key),
    maxWarp: maxWarp(key),
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
    for (const [k, t] of navTargets) {
      const nav = navState.get(k), tgt = navState.get(t), core = primaryCore.get(k);
      if (!nav?.dest || !tgt || !core || !sensorOk(k, t)) { navTargets.delete(k); continue; } // lost: carry on to where it was
      if (Math.hypot(nav.dest.x - tgt.x, nav.dest.y - tgt.y) > 2) send(core, { type: 'core-helm', ship: shipName(k), dest: { x: tgt.x, y: tgt.y, name: shipName(t) } });
    }
    for (const l of [...links]) {
      const [a, b] = l.split('|');
      if (!commsOk(a, b) && cores.has(a) && cores.has(b)) {
        links.delete(l);
        for (const k of [a, b]) opLog(k, `data link with the ${shipName(k === a ? b : a)} lost: out of subspace range`);
        refreshNetworks([a, b]);
        broadcastAllOps();
      }
    }
    // Ops consoles list the ships in hailing range: refresh them when that changes.
    const keys = [...cores.keys()].sort();
    const sig = keys.flatMap((a, i) => keys.slice(i + 1).filter((b) => commsOk(a, b)).map((b) => `${a}|${b}`)).join(',');
    if (sig !== lastRangeSig) { lastRangeSig = sig; broadcastAllOps(); }
    const byShip = new Map();
    for (const u of users.values()) {
      if (!byShip.has(u.shipKey)) byShip.set(u.shipKey, navMessage(u.shipKey));
      send(u, byShip.get(u.shipKey));
    }
  }, 500);
}

// A computer reports a ship's position (or its saved one, when it signs on).
function coreNav(c, key, nav) {
  if (!nav || typeof nav.x !== 'number' || typeof nav.y !== 'number') return;
  const clean = { x: nav.x, y: nav.y, heading: Number(nav.heading) || 0, warp: Number(nav.warp) || 0, dest: nav.dest || null };
  if (ALERTS.includes(nav.alert)) clean.alert = nav.alert;
  if (nav.lockout) clean.lockout = true;
  if (nav.power && typeof nav.power === 'object') clean.power = Object.fromEntries(SYSTEMS.map((s) => [s, Math.max(0, Math.min(100, Number(nav.power[s]) || 0))]));
  // Hull, shields and damage: the relay runs combat, so it only takes the
  // computer's saved copy when it has none of its own.
  if (!combat.get(key)?.loaded) { combat.set(key, { ...freshCombat(nav.combat), loaded: true }); eng.set(key, freshEng(nav.eng)); flowCache.delete(key); }
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

  if (msg.type === 'helm') {
    if (ws.station !== 'Helm') return note('Only Helm can set course and speed');
    const core = primaryCore.get(key);
    if (!core) return note("No ship's computer is flying the ship");
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
      if (order.warp > maxWarp(key)) return note(maxWarp(key) ? `Helm: engines only give ${maxWarp(key) < 1 ? 'impulse' : `warp ${maxWarp(key)}`} at this power` : 'Helm: no power to the engines');
    }
    if (order.warp === 0) navTargets.delete(key);
    send(core, order);
    const what = order.warp === 0 ? 'all stop' : `${order.dest ? `course for ${order.dest.name ? `${d0(order.dest.name)}` : `${Math.round(order.dest.x)}, ${Math.round(order.dest.y)}`}` : typeof order.heading === 'number' ? `heading ${Math.round(order.heading)}` : 'speed'}${order.warp ? `, ${order.warp < 1 ? 'impulse' : `warp ${order.warp}`}` : ''}`;
    opLog(key, `Helm (${ws.name}): ${what}`);
    return;
  }

  if (msg.type === 'power') {
    if (ws.station !== 'Engineering') return note('Only Engineering can route power');
    const core = primaryCore.get(key);
    if (!core) return note("Engineering: no ship's computer is running the ship");
    const p = allocOf(key);
    for (const s of SYSTEMS) if (msg.power && Number.isFinite(msg.power[s])) p[s] = Math.max(0, Math.min(100, Math.round(msg.power[s])));
    send(core, { type: 'core-power', ship: ws.ship, power: p });
    opLog(key, `Engineering (${ws.name}): power ${SYSTEMS.map((s) => `${s} ${p[s]}%`).join(', ')}`);
    return;
  }

  if (msg.type === 'scan') {
    if (ws.station !== 'Science') return note('Only Science can run sensor scans');
    const t = shipKey(clean(msg.ship));
    if (!navState.has(t) || !sensorOk(key, t)) return note(`Sensors: the ${clean(msg.ship)} is out of sensor range`);
    const crew = crewOf(t);
    const stations = {};
    for (const u of crew) stations[u.station] = (stations[u.station] || 0) + 1;
    const n = navState.get(t);
    return send(ws, { type: 'scan-result', ship: shipName(t), at: Date.now(), data: {
      distance: t === key ? 0 : Math.round(distance(key, t)), x: n.x, y: n.y, heading: n.heading, warp: n.warp,
      shields: shields.has(t), ops: opsOf(t).length > 0, crew: crew.length, stations,
      inCommsRange: commsOk(key, t), inTransporterRange: transporterOk(key, t),
      hull: Math.round(combatOf(t).hull), shieldStrength: Math.round(combatOf(t).shield), signature: Math.round(signatureOf(t) * 100),
      damaged: SYSTEMS.filter((s) => combatOf(t).damage[s] >= 1).map((s) => SYSTEM_NAMES[s]), core: engOf(t).core, docked: engOf(t).docked,
    } });
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

// --- command, security, medical (phase 3) ----------------------------------------
//
// Captain: alert status (green / yellow / red; red raises shields if they have
// power) and orders shown on every console aboard. First Officer: reassign
// crew to stations. Security: alerts when anyone beams aboard, a transporter
// lockout (force field) refusing beam-ins, and confining crew to quarters
// (they can only call Security, Medical or ops). Medical: sickbay, which takes
// crew off duty. Alert status and lockout are kept by the ship's computer.

const ALERTS = ['green', 'yellow', 'red'];
const CONFINED_MAY_CALL = new Set(['Security', 'Medical', 'Operations']);
const alertOf = (k) => navState.get(k)?.alert || 'green';
const lockoutOf = (k) => !!navState.get(k)?.lockout;

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
      if (!setShip({ alert: level })) return;
      // Red alert: shields up, if there's the power for them.
      if (level === 'red' && !shields.has(key) && powerOf(key).shields >= MIN_SHIELD_POWER && combatOf(key).shield >= MIN_SHIELD_STRENGTH) { shields.add(key); broadcastShips(); }
      opLog(key, `${ws.name}: ${level} alert`);
      for (const u of crewOf(key)) send(u, { type: 'notice', text: `${level === 'green' ? 'Condition green' : `${level[0].toUpperCase()}${level.slice(1)} alert`}: ${ws.name}` });
      return;
    }
    case 'order': {
      if (ws.station !== 'Captain') return note("Only the Captain gives the ship's orders");
      const text = clean(msg.text).slice(0, 200);
      if (!text) return;
      for (const u of crewOf(key)) send(u, { type: 'order', from: info(ws), text, at: Date.now() });
      opLog(key, `Captain's orders: ${text}`);
      return;
    }
    case 'reassign': {
      if (ws.station !== 'First Officer') return note('Only the First Officer reassigns crew');
      const u = aboard(msg.who);
      if (!u) return note('That crew member is not aboard');
      if (u.operator) return note('The ops station can only be left by the operator');
      if (!STATIONS.includes(msg.station)) return note('No such station');
      if (u.station === msg.station) return;
      const was = u.station;
      u.station = msg.station;
      send(u, { type: 'registered', ...info(u), token: u.token });
      send(u, { type: 'notice', text: `${ws.name} (First Officer) reassigned you from ${was} to ${u.station}` });
      broadcastCrew(key);
      opLog(key, `${ws.name} reassigned ${u.name} from ${was} to ${u.station}`);
      return note(`${u.name} reassigned to ${u.station}`);
    }
    case 'lockout': {
      if (ws.station !== 'Security') return note('Only Security controls the transporter lockout');
      if (!setShip({ lockout: !!msg.on })) return;
      opLog(key, `${ws.name}: transporter lockout ${msg.on ? 'on' : 'off'}`);
      return;
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
// Power comes from four sources, each tied by Engineering to a bus:
//  - solar collectors: a trickle, Bus A or off
//  - dock power: plenty, Bus A or off, only while docked at a starbase
//  - batteries: Bus A, Bus B or off; they run down while they supply power and
//    recharge from spare power on their bus
//  - the warp core (M/ARC): starts on Bus A power (a startup draw for a few
//    seconds); once online it feeds the EPS grid, with taps to Bus A and Bus B
//    that Engineering switches on or off
// Antimatter containment always draws power, from Bus A, Bus B or straight
// from the EPS (Engineering picks). It can only be switched off by
// self-destruct: if it loses power for a few seconds, the core breaches and
// the ship is destroyed.
// Systems and consoles hang off the buses (SYSTEM_BUS, CONSOLE_BUS). A bus
// short of power feeds containment and the core's startup first, then the
// consoles (a console without power goes dark), then shares what's left
// between its systems.

const GRID = { core: 500, coreStartDraw: 60, coreStartSecs: 10, containment: 20, solar: 25, dock: 300, batteryOut: 150, batteryCap: 3000, batteryCharge: 50, console: 2, breachSecs: 5 };
const BUSES = ['A', 'B'];
const SYSTEM_BUS = { lifeSupport: 'A', sensors: 'A', engines: 'B', shields: 'B', weapons: 'B', transporter: 'B' };
const CONSOLE_BUS = { Captain: 'A', 'First Officer': 'A', Helm: 'A', Science: 'A', Engineering: 'A', Communications: 'A', Operations: 'A', Tactical: 'B', Security: 'B', Medical: 'B', Transporter: 'B', Crew: 'B' };
const busOf = (station) => CONSOLE_BUS[station] || 'B';
// Starbases: dock to restock torpedoes, take dock power and repair faster.
// A destroyed ship comes back docked at one of them.
const STARBASES = [{ name: 'Starbase 47', x: 500, y: 120 }, { name: 'Starbase 12', x: 120, y: 860 }, { name: 'Starbase 74', x: 880, y: 820 }, { name: 'Deep Space 4', x: 860, y: 160 }];
const DOCK_RANGE = 10;
const SELF_DESTRUCT_SECS = Number(process.env.SELF_DESTRUCT_SECONDS) || 30;
const BLAST = { range: 30, damage: 30 }; // a ship blowing up hurts ships close by
const eng = new Map(); // ship key -> { core, start, taps, battery, solar, dock, containment, docked, breach, selfDestruct, dirty }

function freshEng(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const pick = (v, ok, d) => (ok.includes(v) ? v : d);
  return {
    core: pick(s.core, ['online', 'offline'], 'online'), start: 0, // a startup in progress starts over
    taps: { A: s.taps?.A !== false, B: s.taps?.B !== false },
    battery: { bus: pick(s.battery?.bus, ['A', 'B', null], 'B'), charge: Number.isFinite(s.battery?.charge) ? Math.max(0, Math.min(GRID.batteryCap, s.battery.charge)) : GRID.batteryCap },
    solar: pick(s.solar, ['A', null], 'A'), dock: pick(s.dock, ['A', null], 'A'),
    containment: pick(s.containment, ['A', 'B', 'EPS'], 'A'),
    docked: STARBASES.some((b) => b.name === s.docked) ? s.docked : null,
    breach: 0, selfDestruct: null, dirty: false,
  };
}
const engOf = (k) => { if (!eng.has(k)) eng.set(k, freshEng()); return eng.get(k); };
const savedEng = (k) => { const e = engOf(k); return { core: e.core === 'starting' ? 'offline' : e.core, taps: e.taps, battery: { bus: e.battery.bus, charge: Math.round(e.battery.charge) }, solar: e.solar, dock: e.dock, containment: e.containment, docked: e.docked }; };

// Where each ship's power goes, worked out fresh (cached briefly: it's asked a lot).
const flowCache = new Map();
function flow(k) {
  const hit = flowCache.get(k);
  if (hit && Date.now() - hit.at < 200) return hit.f;
  const e = engOf(k), c = combatOf(k), a = allocOf(k);
  const demand = {};
  for (const s of SYSTEMS) demand[s] = s === 'weapons' && !c.armed ? 0 : Math.min(a[s], Math.max(0, 100 - c.damage[s]));
  let eps = e.core === 'online' ? GRID.core : 0;
  let containmentOk = false, drawn = 0;
  if (e.containment === 'EPS') { containmentOk = eps >= GRID.containment; eps = Math.max(0, eps - GRID.containment); if (containmentOk) drawn += GRID.containment; }
  const crew = crewOf(k);
  const buses = {};
  for (const X of BUSES) {
    const core = (e.containment === X ? GRID.containment : 0) + (X === 'A' && e.core === 'starting' ? GRID.coreStartDraw : 0);
    const consoles = crew.filter((u) => busOf(u.station) === X).length * GRID.console;
    const systems = SYSTEMS.filter((s) => SYSTEM_BUS[s] === X).reduce((n, s) => n + demand[s], 0);
    const need = core + consoles + systems;
    const src = { solar: e.solar === X ? GRID.solar : 0, dock: e.dock === X && e.docked ? GRID.dock : 0, eps: 0, battery: 0 };
    let have = src.solar + src.dock;
    if (e.taps[X]) { src.eps = Math.min(eps, Math.max(0, need - have)); eps -= src.eps; have += src.eps; }
    if (e.battery.bus === X && e.battery.charge > 0) { src.battery = Math.min(GRID.batteryOut, e.battery.charge, Math.max(0, need - have)); have += src.battery; }
    if (e.containment === X) containmentOk = have >= GRID.containment;
    drawn += Math.min(have, need);
    buses[X] = {
      need: Math.round(need), have: Math.round(have), src, core, consoles, systems,
      coreOk: have >= core, consolesOk: have >= core + consoles,
      fraction: systems ? Math.max(0, Math.min(1, (have - core - consoles) / systems)) : 1,
    };
  }
  // Batteries recharge from what their bus has spare (its own sources, or the EPS if tapped).
  let charging = 0;
  const bb = e.battery.bus && buses[e.battery.bus];
  if (bb && !bb.src.battery && e.battery.charge < GRID.batteryCap) {
    const spare = Math.max(0, bb.src.solar + bb.src.dock + bb.src.eps - bb.need) + (e.taps[e.battery.bus] ? eps : 0);
    charging = Math.min(GRID.batteryCharge, spare, GRID.batteryCap - e.battery.charge);
  }
  const delivered = Object.fromEntries(SYSTEMS.map((s) => [s, demand[s] * buses[SYSTEM_BUS[s]].fraction]));
  const f = { buses, demand, delivered, containmentOk, charging, drawn: drawn + charging };
  flowCache.set(k, { at: Date.now(), f });
  return f;
}
const gridChanged = (k) => { flowCache.delete(k); scheduleNav(); };
// A console with no power on its bus is dark (ops and Engineering's grid controls aside).
const consoleDark = (ws) => !flow(ws.shipKey).buses[busOf(ws.station)].consolesOk;
const darkNote = (ws) => send(ws, { type: 'notice', text: `${ws.station}: console offline, no power on Bus ${busOf(ws.station)}` });

function gridView(k) {
  const e = engOf(k), f = flow(k);
  const near = STARBASES.find((b) => navState.has(k) && Math.hypot(navState.get(k).x - b.x, navState.get(k).y - b.y) <= DOCK_RANGE);
  return {
    core: e.core, start: e.start, startSecs: GRID.coreStartSecs, coreOutput: GRID.core,
    taps: e.taps, solar: e.solar, dock: e.dock, containment: e.containment, containmentOk: f.containmentOk,
    breach: e.breach ? GRID.breachSecs - e.breach : null,
    battery: { bus: e.battery.bus, charge: Math.round((e.battery.charge / GRID.batteryCap) * 100), charging: Math.round(f.charging) },
    docked: e.docked, near: near?.name || null,
    selfDestruct: e.selfDestruct ? { seconds: Math.max(0, Math.ceil((e.selfDestruct.at - Date.now()) / 1000)), by: e.selfDestruct.by } : null,
    buses: Object.fromEntries(BUSES.map((X) => { const b = f.buses[X]; return [X, { need: b.need, have: b.have, src: Object.fromEntries(Object.entries(b.src).map(([n, v]) => [n, Math.round(v)])), consolesOk: b.consolesOk, fraction: Math.round(b.fraction * 100) }]; })),
    systemBus: SYSTEM_BUS, consoleBus: CONSOLE_BUS, drawn: Math.round(f.drawn),
  };
}

// Engineering's grid controls: the warp core, EPS taps, sources and containment.
function gridCommand(ws, msg) {
  const key = ws.shipKey, e = engOf(key);
  const note = (text) => send(ws, { type: 'notice', text: `Engineering: ${text}` });
  if (ws.station !== 'Engineering') return send(ws, { type: 'notice', text: 'Only Engineering runs the power grid' });
  const said = [];
  if (msg.core === 'start' && e.core === 'offline') {
    e.core = 'starting'; e.start = 0; flowCache.delete(key);
    if (!flow(key).buses.A.coreOk) { e.core = 'offline'; flowCache.delete(key); return note(`not enough power on Bus A to start the warp core (needs ${GRID.coreStartDraw} for ${GRID.coreStartSecs} s; tie the batteries or dock power to Bus A)`); }
    said.push('warp core startup');
  } else if (msg.core === 'stop' && e.core !== 'offline') {
    e.core = 'offline'; e.start = 0;
    said.push('warp core shut down');
    if (e.containment === 'EPS') said.push('WARNING: containment is on the EPS');
  }
  if (msg.tap && BUSES.includes(msg.tap.bus)) { e.taps[msg.tap.bus] = !!msg.tap.on; said.push(`EPS tap to Bus ${msg.tap.bus} ${msg.tap.on ? 'open' : 'closed'}`); }
  if ('battery' in msg && ['A', 'B', null].includes(msg.battery)) { e.battery.bus = msg.battery; said.push(`batteries ${msg.battery ? `on Bus ${msg.battery}` : 'off'}`); }
  if ('solar' in msg && ['A', null].includes(msg.solar)) { e.solar = msg.solar; said.push(`solar ${msg.solar ? 'on Bus A' : 'off'}`); }
  if ('dock' in msg && ['A', null].includes(msg.dock)) { e.dock = msg.dock; said.push(`dock power ${msg.dock ? 'on Bus A' : 'off'}`); }
  if ('containment' in msg) {
    if (!['A', 'B', 'EPS'].includes(msg.containment)) return note('containment can only be fed from Bus A, Bus B or the EPS (switching it off takes a self-destruct)');
    e.containment = msg.containment;
    said.push(`antimatter containment fed from ${msg.containment === 'EPS' ? 'the EPS' : `Bus ${msg.containment}`}`);
  }
  if (!said.length) return;
  e.dirty = true;
  opLog(key, `Engineering (${ws.name}): ${said.join(', ')}`);
  note(said.join(', '));
  gridChanged(key);
}

// Helm docks at a starbase within range, at all stop (and leaves by going anywhere).
function dockCommand(ws, msg) {
  const key = ws.shipKey, e = engOf(key), nav = navState.get(key);
  const note = (text) => send(ws, { type: 'notice', text: `Helm: ${text}` });
  if (ws.station !== 'Helm') return send(ws, { type: 'notice', text: 'Only Helm docks the ship' });
  if (msg.undock) {
    if (!e.docked) return;
    opLog(key, `undocked from ${e.docked}`);
    note(`undocked from ${e.docked}`);
    e.docked = null; e.dirty = true;
    return gridChanged(key);
  }
  const base = nav && STARBASES.find((b) => Math.hypot(nav.x - b.x, nav.y - b.y) <= DOCK_RANGE);
  if (!base) return note(`no starbase within docking range (${DOCK_RANGE} units)`);
  if (nav.warp > 0) return note('come to all stop before docking');
  e.docked = base.name; e.dirty = true;
  opLog(key, `Helm (${ws.name}): docked at ${base.name}`);
  for (const u of crewOf(key)) send(u, { type: 'notice', text: `Helm: docked at ${base.name}` });
  gridChanged(key);
}

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

// A ship is destroyed: it takes ships close by with it (some), and comes back
// docked at a starbase picked at random, good as new.
function destroy(k, cause) {
  const c = combatOf(k);
  if (c.destroying) return;
  c.destroying = true;
  const name = shipName(k);
  for (const o of [...combat.keys()]) if (o !== k && cores.has(o) && distance(k, o) <= BLAST.range) hit(o, BLAST.damage, k, 'the blast');
  const base = STARBASES[Math.floor(Math.random() * STARBASES.length)];
  console.log(`the ${name} was destroyed (${cause}); back at ${base.name}`);
  opLog(k, `the ${name} was destroyed: ${cause}. Rebuilt and docked at ${base.name}`);
  for (const u of crewOf(k)) send(u, { type: 'destroyed', ship: name, cause, base: base.name, at: Date.now() });
  for (const [o, oc] of combat) if (oc.lock === k) { oc.lock = null; tellStations(o, ['Tactical'], `Tactical: the ${name} was destroyed`); }
  combat.set(k, { ...freshCombat(), loaded: true });
  eng.set(k, { ...freshEng(), docked: base.name });
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
const MIN_SHIELD_STRENGTH = 10;  // shield generators hold from here
const REPAIR = { auto: 0.5, directed: 3, hull: 0.1, hullDirected: 1, docked: 4 }; // per second (docked: times faster)
const UNDER_FIRE_MS = 10000;      // "taking fire" lasts this long after a hit
const SYSTEM_NAMES = { engines: 'engines', shields: 'shield generators', sensors: 'sensors', transporter: 'transporter', weapons: 'weapons', lifeSupport: 'life support' };
const combat = new Map(); // ship key -> { hull, shield, damage, torpedoes, repair, lock, armed, phaserCharge, torpedoAt, restockAt, hitAt, hitBy, dirty }

function freshCombat(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const num = (v, d, max = 100) => (Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : d);
  return {
    hull: num(s.hull, 100) || 100, shield: num(s.shield, 100),
    damage: Object.fromEntries(SYSTEMS.map((k) => [k, num(s.damage?.[k], 0)])),
    torpedoes: num(s.torpedoes, TORPEDO.carried, TORPEDO.carried),
    repair: s.repair === 'hull' || SYSTEMS.includes(s.repair) ? s.repair : null,
    lock: null, armed: false, phaserCharge: 0, torpedoAt: 0, restockAt: Date.now(), hitAt: 0, hitBy: null, dirty: false,
  };
}
const combatOf = (k) => { if (!combat.has(k)) combat.set(k, freshCombat()); return combat.get(k); };
const round1 = (v) => Math.round(v * 10) / 10;
const savedCombat = (k) => {
  const c = combatOf(k);
  return { hull: round1(c.hull), shield: round1(c.shield), damage: Object.fromEntries(SYSTEMS.map((s) => [s, round1(c.damage[s])])), torpedoes: c.torpedoes, repair: c.repair };
};
// What a ship's computer keeps: its position and settings, plus combat and grid state.
const coreCopy = (k) => (navState.has(k) ? { ...navState.get(k), combat: savedCombat(k), eng: savedEng(k) } : undefined);

// The ship's own combat state, for its consoles.
function combatView(k) {
  const c = combatOf(k), now = Date.now();
  const t = c.lock && navState.has(c.lock) ? c.lock : null;
  return {
    hull: Math.round(c.hull), shield: Math.round(c.shield),
    damage: Object.fromEntries(SYSTEMS.map((s) => [s, Math.ceil(c.damage[s])])),
    repair: c.repair, torpedoes: c.torpedoes, carried: TORPEDO.carried,
    phaser: { range: PHASER.range, armed: c.armed, charge: Math.floor(c.phaserCharge) },
    torpedo: { range: TORPEDO.range, ready: Math.max(0, c.torpedoAt - now), reload: TORPEDO.reload },
    lock: t ? { name: shipName(t), distance: Math.round(distance(k, t)), shields: shields.has(t), shield: Math.round(combatOf(t).shield), hull: Math.round(combatOf(t).hull) } : null,
    lockedBy: [...combat].filter(([o, oc]) => oc.lock === k && cores.has(o)).map(([o]) => shipName(o)),
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
  if (nav && core && nav.warp > maxWarp(k)) {
    const warp = p.engines <= 0 ? 0 : maxWarp(k);
    if (!warp) navTargets.delete(k);
    send(core, { type: 'core-helm', ship: shipName(k), warp });
  }
}

// A hit on ship t from ship `from`. Returns what happened, for the firing ship.
function hit(t, dmg, from, what = '') {
  const c = combatOf(t);
  c.hitAt = Date.now();
  c.hitBy = shipName(from);
  c.dirty = true;
  let rest = dmg;
  const said = [];
  if (shields.has(t)) {
    // Shield strength drained per point of damage: less with more shield power.
    const drain = (dmg * 60) / Math.max(MIN_SHIELD_POWER, powerOf(t).shields);
    if (c.shield > drain) { c.shield -= drain; rest = 0; } else { rest = dmg * (1 - c.shield / drain); c.shield = 0; }
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
    const sys = SYSTEMS[Math.floor(Math.random() * SYSTEMS.length)];
    c.damage[sys] = Math.min(100, c.damage[sys] + rest * 2);
    said.push(`hull ${Math.round(c.hull)}%`, `${SYSTEM_NAMES[sys]} damaged`);
    opLog(t, `hit by the ${shipName(from)}${what ? ` (${what})` : ''}: hull ${Math.round(c.hull)}%, ${SYSTEM_NAMES[sys]} damaged`);
    tellStations(t, ['Engineering'], `Engineering: ${SYSTEM_NAMES[sys]} damaged (${Math.ceil(c.damage[sys])}%)`);
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
    c.repair = msg.system === 'hull' || SYSTEMS.includes(msg.system) ? msg.system : null;
    c.dirty = true;
    const what = c.repair ? `repair crews to the ${c.repair === 'hull' ? 'hull' : SYSTEM_NAMES[c.repair]}` : 'repair crews spread across the ship';
    opLog(key, `Engineering (${ws.name}): ${what}`);
    send(ws, { type: 'notice', text: `Engineering: ${what}` });
    scheduleNav();
    return;
  }

  if (ws.station !== 'Tactical') return send(ws, { type: 'notice', text: 'Only Tactical controls the weapons' });

  if (msg.type === 'arm') {
    c.armed = !!msg.on;
    if (!c.armed) c.phaserCharge = 0; // the banks bleed off
    opLog(key, `${ws.name}: phasers ${c.armed ? 'armed' : 'stood down'}`);
    gridChanged(key);
    return note(c.armed ? 'phasers armed, banks charging' : 'phasers stood down');
  }

  if (msg.type === 'lock') {
    if (!msg.ship) {
      if (c.lock) opLog(key, `${ws.name}: weapons lock on the ${shipName(c.lock)} released`);
      c.lock = null;
      scheduleNav();
      return note('weapons lock released');
    }
    const t = shipKey(clean(msg.ship));
    if (t === key) return note('cannot target our own ship');
    if (!cores.has(t) || !navState.has(t) || !sensorOk(key, t)) return note(`the ${clean(msg.ship)} is not on sensors`);
    if (c.lock === t) return;
    c.lock = t;
    opLog(key, `${ws.name}: weapons locked on the ${shipName(t)}`);
    opLog(t, `the ${shipName(key)} has locked weapons on us`);
    tellStations(t, ['Tactical', 'Captain'], `Tactical: the ${shipName(key)} has locked weapons on us`);
    scheduleNav();
    return note(`weapons locked on the ${shipName(t)}`);
  }

  if (msg.type === 'fire') {
    const torpedo = msg.weapon === 'torpedo';
    const w = torpedo ? TORPEDO : PHASER, what = torpedo ? 'torpedo' : 'phaser';
    const t = c.lock;
    if (!t) return note('no target: lock weapons first');
    if (!cores.has(t) || !sensorOk(key, t)) { c.lock = null; scheduleNav(); return note('target lost'); }
    const d = distance(key, t);
    if (d > w.range) return note(`the ${shipName(t)} is out of ${what} range (${Math.round(d)} units; get within ${w.range})`);
    const now = Date.now();
    if (torpedo) {
      if (c.torpedoes <= 0) return note('no torpedoes left: restock at a starbase');
      if (now < c.torpedoAt) return note('torpedo tubes reloading');
      c.torpedoes--;
      c.torpedoAt = now + TORPEDO.reload;
      c.dirty = true;
    } else {
      if (!c.armed) return note('phasers are not armed');
      if (c.phaserCharge < 100) return note(`phaser banks charging (${Math.floor(c.phaserCharge)}%)`);
      c.phaserCharge = 0;
    }
    const result = hit(t, w.damage, key, torpedo ? 'torpedo' : 'phasers');
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
  const now = Date.now();
  let changed = false;
  for (const k of [...cores.keys()]) {
    if (!navState.has(k)) continue;
    const c = combatOf(k), e = engOf(k);
    const state = () => JSON.stringify([c.hull, c.shield, c.damage, c.torpedoes, c.repair, Math.floor(c.phaserCharge), e.core, e.start, e.breach, Math.round(e.battery.charge / 30), e.docked]);
    const before = state();
    flowCache.delete(k);
    const f = flow(k);

    // Self-destruct: containment off, and the core goes.
    if (e.selfDestruct && now >= e.selfDestruct.at) { destroy(k, `self-destruct, by order of ${e.selfDestruct.by}`); changed = true; continue; }
    // Containment: a few seconds on reserve, then the core breaches.
    if (!f.containmentOk) {
      e.breach++;
      if (e.breach === 1) { opLog(k, 'antimatter containment failing: no power'); for (const u of crewOf(k)) send(u, { type: 'notice', text: `Warning: antimatter containment failing (no power from ${e.containment === 'EPS' ? 'the EPS' : `Bus ${e.containment}`})` }); }
      if (e.breach >= GRID.breachSecs) { destroy(k, 'warp core breach: antimatter containment lost'); changed = true; continue; }
    } else if (e.breach) { e.breach = 0; opLog(k, 'antimatter containment restored'); tellStations(k, ['Engineering', 'Captain'], 'Engineering: antimatter containment restored'); }
    // The core starting up, on Bus A power.
    if (e.core === 'starting') {
      if (!f.buses.A.coreOk) { e.core = 'offline'; e.start = 0; opLog(k, 'warp core startup failed: not enough power on Bus A'); tellStations(k, ['Engineering'], 'Engineering: warp core startup failed, not enough power on Bus A'); }
      else if (++e.start >= GRID.coreStartSecs) { e.core = 'online'; e.start = 0; e.dirty = true; opLog(k, 'warp core online'); tellStations(k, ['Engineering', 'Captain'], 'Engineering: warp core online'); }
    }
    // Batteries.
    const bb = e.battery.bus && f.buses[e.battery.bus];
    if (bb) e.battery.charge = Math.max(0, Math.min(GRID.batteryCap, e.battery.charge - bb.src.battery + f.charging));
    // Docking ends when the ship moves off.
    const nav = navState.get(k);
    if (e.docked) {
      const base = STARBASES.find((b) => b.name === e.docked);
      if (!base || nav.warp > 0 || Math.hypot(nav.x - base.x, nav.y - base.y) > DOCK_RANGE) { opLog(k, `departed ${e.docked}`); e.docked = null; e.dirty = true; }
    }

    const p = powerOf(k);
    if (c.shield < 100 && p.shields > 0) c.shield = Math.min(100, c.shield + (2 * p.shields) / 100);
    const fast = e.docked ? REPAIR.docked : 1;
    for (const s of SYSTEMS) if (c.damage[s] > 0) c.damage[s] = Math.max(0, c.damage[s] - (c.repair === s ? REPAIR.directed : REPAIR.auto) * fast);
    if (c.hull < 100) c.hull = Math.min(100, c.hull + (c.repair === 'hull' ? REPAIR.hullDirected : REPAIR.hull) * fast);
    if (c.repair && (c.repair === 'hull' ? c.hull >= 100 : c.damage[c.repair] <= 0)) {
      tellStations(k, ['Engineering'], `Engineering: ${c.repair === 'hull' ? 'hull' : SYSTEM_NAMES[c.repair]} repaired`);
      c.repair = null;
    }
    if (c.armed && c.phaserCharge < 100) c.phaserCharge = Math.min(100, c.phaserCharge + (PHASER.chargeRate * p.weapons) / 100);
    if (!e.docked || c.torpedoes >= TORPEDO.carried) c.restockAt = now;
    else if (now - c.restockAt >= TORPEDO.restock) { c.torpedoes++; c.restockAt = now; }
    if (c.lock && (!cores.has(c.lock) || !sensorOk(k, c.lock))) {
      opLog(k, `weapons lock on the ${shipName(c.lock)} lost`);
      tellStations(k, ['Tactical'], `Tactical: weapons lock on the ${shipName(c.lock)} lost (out of sensor range)`);
      c.lock = null;
      changed = true;
    }
    if (state() !== before || e.selfDestruct) { c.dirty = true; changed = true; enforcePower(k); }
    if ((c.dirty || e.dirty) && combatTick % 5 === 0 && primaryCore.has(k)) {
      send(primaryCore.get(k), { type: 'core-set', ship: shipName(k), set: { combat: savedCombat(k), eng: savedEng(k) } });
      c.dirty = e.dirty = false;
    }
  }
  if (changed) scheduleNav();
}, 1000).unref();


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
    if (!ws.operator) return res.writeHead(403).end('Only ops can delete library files');
    if (key !== ws.shipKey) return res.writeHead(403).end("Ops can only delete from their own ship's library");
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
  if (opsOf(key).length || cores.has(key) || !linkedTo(key).length) return;
  const formerNet = [...network(key)];
  for (const k of linkedTo(key)) { links.delete(linkKey(key, k)); opLog(k, `data link with the ${shipName(key)} lost: no operator or ship's computer`); }
  refreshNetworks(formerNet);
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

    if (msg.type === 'operator' && !ws.id && !ws.operator) {
      // The ops station is aboard as crew at the Operations station.
      const ship = clean(msg.ship), name = clean(msg.name);
      if (OPERATOR_KEY && msg.key !== OPERATOR_KEY) return send(ws, { type: 'operator-failed', reason: 'wrong operator key' });
      if (!NAME_RE.test(name)) return send(ws, { type: 'operator-failed', reason: 'enter your name (letters, digits, spaces, \' . -)' });
      if (!NAME_RE.test(ship)) return send(ws, { type: 'operator-failed', reason: 'enter your ship name (letters, digits, spaces, \' . -)' });
      if (!hasComputer(ship)) return send(ws, { type: 'operator-failed', reason: `the ${ship} has no ship's computer online` });
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
      if (!hasComputer(ship)) return send(ws, { type: 'register-failed', reason: `the ${ship} has no ship's computer online` });
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
      if (consoleDark(ws)) return darkNote(ws);
      if (msg.up && powerOf(ws.shipKey).shields < MIN_SHIELD_POWER) return send(ws, { type: 'notice', text: `Tactical: not enough power to raise shields (needs ${MIN_SHIELD_POWER}%; ask Engineering)` });
      if (msg.up && combatOf(ws.shipKey).shield < MIN_SHIELD_STRENGTH) return send(ws, { type: 'notice', text: `Tactical: the shield generators are recharging (${Math.floor(combatOf(ws.shipKey).shield)}%; they hold from ${MIN_SHIELD_STRENGTH}%)` });
      if (msg.up) shields.add(ws.shipKey); else shields.delete(ws.shipKey);
      opLog(ws.shipKey, `${ws.name}: shields ${msg.up ? 'up' : 'down'}`);
      broadcastShips();
      return;
    }

    // The transporter beams someone aboard this ship to another ship.
    if (msg.type === 'beam' && ws.id) {
      const fail = (text) => send(ws, { type: 'notice', text: `Transporter: ${text}` });
      if (ws.station !== 'Transporter') return fail('only the transporter room can beam people');
      if (consoleDark(ws)) return fail(`console offline, no power on Bus ${busOf(ws.station)}`);
      const u = typeof msg.who === 'string' && users.get(msg.who);
      const toKey = shipKey(clean(msg.ship));
      if (!u || u.shipKey !== ws.shipKey) return fail('that person is not aboard');
      if (u.operator) return fail('the ops station cannot be beamed');
      if (powerOf(ws.shipKey).transporter <= 0) return fail('no power to the transporter: ask Engineering');
      if (toKey !== ws.shipKey && cores.has(toKey) && !transporterOk(ws.shipKey, toKey)) return fail(`the ${shipName(toKey)} is out of transporter range (${rangeText(ws.shipKey, toKey)}; get within ${Math.round(rangesOf(ws.shipKey).transporter)})`);
      if (!cores.has(toKey)) return fail(`the ${clean(msg.ship)} has no ship's computer online`);
      if (toKey === ws.shipKey) return fail(`${u.name} is already aboard`);
      for (const k of [ws.shipKey, toKey]) if (shields.has(k)) return fail(`cannot beam through the shields of the ${shipName(k)}`);
      if (lockoutOf(toKey)) return fail(`the ${shipName(toKey)} has a transporter lockout: Security's force field is up`);
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

    if ((msg.type === 'helm' || msg.type === 'scan' || msg.type === 'plot-course' || msg.type === 'power') && ws.id) return consoleDark(ws) && msg.type !== 'power' ? darkNote(ws) : navCommand(ws, msg);
    if (['alert', 'order', 'reassign', 'lockout', 'confine', 'sickbay'].includes(msg.type) && ws.id) return consoleDark(ws) ? darkNote(ws) : crewCommand(ws, msg);
    if (['lock', 'fire', 'repair', 'arm'].includes(msg.type) && ws.id) return consoleDark(ws) ? darkNote(ws) : combatCommand(ws, msg);
    if (msg.type === 'grid' && ws.id) return gridCommand(ws, msg); // emergency power: works with the console dark
    if (msg.type === 'dock' && ws.id) return consoleDark(ws) ? darkNote(ws) : dockCommand(ws, msg);
    if (msg.type === 'self-destruct' && ws.id) return consoleDark(ws) ? darkNote(ws) : selfDestructCommand(ws, msg);

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
      // Confined to quarters: only Security, Medical or ops can be called.
      if (msg.type === 'call' && ws.confined && !CONFINED_MAY_CALL.has(target.station)) {
        send(ws, { type: 'notice', text: 'You are confined to quarters: you can only call Security, Medical or ops' });
        return send(ws, { type: 'unavailable', id: msg.to });
      }
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

  // The relay's own station list, so pages only offer stations it accepts
  // (and can tell when the relay is older than the pages).
  send(ws, { type: 'hello', relay: RELAY_NAME, stations: STATIONS, opsKey: !!OPERATOR_KEY, version: require('./package.json').version });
  send(ws, { type: 'ships', ships: shipList() });
});

server.listen(PORT, () => console.log(`${RELAY_NAME} on http://localhost:${PORT}`));
module.exports = server;
