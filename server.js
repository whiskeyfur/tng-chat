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
  'link-request', 'link-accept', 'link-decline', 'link-cancel', 'link-close', 'all-hands', 'all-hands-end', 'remote-block']);
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
    remoteBlock: !!engOf(key).remoteBlock,
    broadcasts: [...broadcasts.values()].filter((b) => b.ships.has(key) || users.get(b.speaker)?.shipKey === key)
      .map((b) => ({ id: b.bid, speaker: peerInfo(b.speaker), label: b.label, since: b.since })),
  };
  for (const op of ops) if (!op.controlling) send(op, msg); // (one running another vessel's ops sees that one's)
  // An ops console remote-controlling this vessel's ops gets its picture too.
  for (const u of users.values()) if (u.operator && u.controlling === key) send(u, msg);
  // Communications runs data links too: it gets the link picture.
  const links = { type: 'comm-links', ships: otherShips, links: msg.links, network: msg.network, linkIncoming: msg.linkIncoming, linkOutgoing: msg.linkOutgoing };
  for (const u of comms) send(u, links);
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
  const live = new Set([...[...operators].map((op) => op.shipKey), ...[...users.values()].map((u) => u.shipKey), ...cores.keys(), ...BASE_KEYS]);
  return [...live].map((k) => ({
    name: shipName(k), ops: opsOf(k).length > 0, shields: shields.has(k), computer: present(k), active: true, ...(isBase(k) ? { starbase: true } : {}),
  })).sort((a, b) => a.name.localeCompare(b.name));
}
// Starbases run themselves (no ship's computer needed), so they're always there.
const hasComputer = (name) => present(shipKey(name));
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
      const automated = isBase(target) && !opsOf(target).length;
      if (automated && !crewOf(target).length) return fail(`${shipName(target)} (automated): nobody aboard to take the call. Docking is open, and data links are accepted automatically`);
      if (!automated && !opsOf(target).length) return fail(`no response from ${clean(msg.ship) || 'that ship'}: no operator on duty`);
      if (!commsOk(op.shipKey, target)) return fail(`the ${shipName(target)} is out of subspace range (${rangeText(op.shipKey, target)})`);
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
        if (!commsOk(op.shipKey, target)) return fail(`the ${shipName(target)} is out of subspace range (${rangeText(op.shipKey, target)})`);
        if (!commsUp(op.shipKey, 'subspace')) return fail('our subspace relay has no power: data links need it');
        if (!commsUp(target, 'subspace')) return fail(`the ${shipName(target)}'s subspace relay is down`);
      }
      if (links.has(linkKey(op.shipKey, target))) return fail(`a data link with the ${shipName(target)} is already open`);
      if ([...linkRequests.values()].some((r) => linkKey(r.fromShip, r.toShip) === linkKey(op.shipKey, target))) return fail(`a data link with the ${shipName(target)} is already being negotiated`);
      if (crewless && !answers) {
        links.add(linkKey(op.shipKey, target));
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
        if (!hardLine(op.shipKey, other) && !commsOk(op.shipKey, other)) { broadcastOps(op.shipKey); return fail(`the ${shipName(other)} is out of subspace range (${rangeText(op.shipKey, other)})`); }
        if (!hardLine(op.shipKey, other) && (!commsUp(op.shipKey, 'subspace') || !commsUp(other, 'subspace'))) { broadcastOps(op.shipKey); return fail('a subspace relay is down: no data link'); }
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
function beam(u, toKey, station, how = 'beamed') {
  const from = u.ship;
  // Site to site: within the ship, to another station's console.
  // Beaming drops you out of any call you're in (the others stay connected).
  if (toKey === u.shipKey) {
    const was = u.station;
    if (u.state !== 'idle') send(u, { type: 'force-hangup', reason: `beamed to ${station}` });
    u.station = station;
    send(u, { type: 'registered', ...info(u), token: u.token });
    send(u, { type: 'notice', text: `Transporter: beamed from ${was} to ${station}` });
    broadcastCrew(toKey);
    opLog(toKey, `${u.name} beamed from ${was} to ${station}`);
    return;
  }
  if (station) u.station = station;
  send(u, { type: 'force-hangup', reason: `${how} to the ${shipName(toKey)}` });
  signOut(u);
  Object.assign(u, { id: userId(u.name, shipName(toKey)), shipKey: toKey, ship: shipName(toKey), state: 'idle', peers: [], cid: null });
  users.set(u.id, u);
  send(u, { type: 'registered', ...info(u), token: u.token, [how === 'walked' ? 'walkedFrom' : how === 'beamed' ? 'beamedFrom' : how === 'returned' ? 'returnedFrom' : 'remoteVia']: from });
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
const SYSTEMS = ['engines', 'injectors', 'shields', 'sensors', 'transporter', 'weapons', 'lifeSupport', 'replicators', 'recreation'];
// Each system's power setting is a limit, 0-150: past 100 (its rating) is
// emergency overdrive, which slowly damages it, faster the further over it runs.
const POWER_MAX = 150;
const OVERDRIVE_DAMAGE = 0.02; // damage per second for each point drawn over 100
const REACTOR = 450; // total power to share, in percent of one system at full
const MIN_SHIELD_POWER = 20;
const DEFAULT_POWER = { engines: 80, injectors: 80, shields: 60, sensors: 100, transporter: 60, weapons: 50, lifeSupport: 100, replicators: 40, recreation: 10 };
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
const signatureOf = (k) => (isBase(k) ? 1 : Math.max(0.1, Math.min(1, flow(k).drawn / REACTOR)));
function rangesOf(k) {
  const f = Math.max(0, Math.min(POWER_MAX, powerOf(k).sensors)) / 100;
  return { comms: COMMS_RANGE * f, sensors: SENSOR_RANGE * f, transporter: TRANSPORTER_RANGE * f };
}
// Top speeds: warp (1-9) needs the warp core online and engine power; impulse
// (below 1) comes from the running impulse drives, half impulse (0.125) each. maxWarp: the top of whichever the ship has.
function speedLimits(k) {
  const e = eng.get(k);
  // Warp needs both the engines and their plasma injectors: the weaker sets the top speed.
  const warpPower = Math.min(100, powerOf(k).engines, powerOf(k).injectors);
  const eng9 = warpPower <= 0 ? 0 : Math.round((warpPower / 100) * 9 * 10) / 10;
  if (!e || isBase(k)) return { warp: eng9 >= 1 ? eng9 : 0, impulse: 0.25 };
  let warp = e.core === 'online' && eng9 >= 1 ? eng9 : 0;
  if (e.towing) warp = Math.min(warp, TRACTOR.maxWarp); // towing holds a ship back
  return { warp, impulse: 0.125 * flow(k).thrusting };
}
const maxWarp = (k) => { const l = speedLimits(k); return l.warp || l.impulse; };
// Is this speed within what the ship has? (impulse and warp are separate)
const speedOk = (k, w) => { const l = speedLimits(k); return w <= 0 || (w < 1 ? w <= l.impulse + 1e-9 : w <= l.warp); };
// Both ships' sensors have to reach for subspace comms (hails, data links).
const commsOk = (a, b) => a === b || distance(a, b) <= Math.min(rangesOf(a).comms, rangesOf(b).comms);
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
    own: own ? { name: shipName(key), ...own, power: powerOf(key), allocated: allocOf(key), reactor: REACTOR, signature: signatureOf(key), combat: combatView(key), grid: gridView(key),
      autopilot: autopilots.get(key)?.target || null,
      autopilotMode: autopilots.get(key) ? { mode: autopilots.get(key).mode, range: autopilots.get(key).range || null } : null, followRanges: FOLLOW_RANGES,
      known: [...(known.get(key) || [])].filter(([o]) => present(o)).map(([o, p]) => ({ name: shipName(o), x: Math.round(p.x), y: Math.round(p.y), age: Math.round((Date.now() - p.at) / 1000), visible: sensorOk(key, o) })) } : null,
    bases: STARBASES.map((b) => ({ ...b, distance: own ? Math.round(Math.hypot(own.x - b.x, own.y - b.y)) : null })),
    ships: seen.map((k) => ({ name: shipName(k), ...navState.get(k), ops: opsOf(k).length > 0, shields: shields.has(k), distance: k === key ? 0 : distance(key, k) })),
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
          engOf(k).docked = base.name; engOf(k).dockedPort = freePort(k) || 'port'; engOf(k).dirty = true; flowCache.delete(k);
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
    for (const l of [...links]) {
      const [a, b] = l.split('|');
      const relayDown = !commsUp(a, 'subspace') || !commsUp(b, 'subspace');
      if (!hardLine(a, b) && (!commsOk(a, b) || relayDown) && present(a) && present(b)) {
        links.delete(l);
        for (const k of [a, b]) opLog(k, `data link with the ${shipName(k === a ? b : a)} lost: ${relayDown ? 'a subspace relay is down' : 'out of subspace range'}`);
        refreshNetworks([a, b]);
        broadcastAllOps();
      }
    }
    // Ops consoles list the ships in hailing range: refresh them when that changes.
    const keys = [...new Set([...cores.keys(), ...BASE_KEYS])].sort();
    const sig = keys.flatMap((a, i) => keys.slice(i + 1).filter((b) => commsOk(a, b)).map((b) => `${a}|${b}`)).join(',');
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
  if (ALERTS.includes(nav.alert)) clean.alert = nav.alert;
  if (nav.lockout) clean.lockout = true;
  if (nav.power && typeof nav.power === 'object') clean.power = Object.fromEntries(SYSTEMS.map((s) => [s, Math.max(0, Math.min(POWER_MAX, Number(nav.power[s] ?? DEFAULT_POWER[s]) || 0))]));
  // Hull, shields and damage: the relay runs combat, so it only takes the
  // computer's saved copy when it has none of its own.
  // A new ship (nothing saved) starts cold, docked at a starbase, unless its
  // computer says --warm or --position.
  let spawnAt = null;
  if (!combat.get(key)?.loaded) {
    combat.set(key, { ...freshCombat(nav.combat), loaded: true });
    eng.set(key, freshEng(nav.eng, { cold: !nav.eng && !nav.warm }));
    if (!nav.eng && nav.spawn) { spawnAt = STARBASES[Math.floor(Math.random() * STARBASES.length)]; engOf(key).docked = spawnAt.name; }
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
    const core = primaryCore.get(key);
    if (!core) return note("No ship's computer is flying the ship");
    if (isBase(key)) return note(`Helm: ${shipName(key)} is a starbase: it holds station`);
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
        if (!lim.impulse) return note('Helm: no impulse: start an impulse drive (Engineering)');
        order.warp = Math.min(order.warp, lim.impulse); // impulse: what there is
      } else if (order.warp >= 1 && order.warp > lim.warp) {
        return note(lim.warp ? `Helm: engines only give warp ${lim.warp} at this power` : engOf(key).core !== 'online' ? 'Helm: no warp: the warp core is offline' : 'Helm: no power to the engines');
      }
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
    for (const s of SYSTEMS) if (msg.power && Number.isFinite(msg.power[s])) p[s] = Math.max(0, Math.min(POWER_MAX, Math.round(msg.power[s])));
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
      damaged: DAMAGEABLE.filter((s) => combatOf(t).damage[s] >= 1).map((s) => SYSTEM_NAMES[s]), core: engOf(t).core, docked: engOf(t).docked,
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
      if (!setShip({ alert: level })) return;
      // Red alert: shields up, if there's the power for them.
      if (level === 'red' && !shields.has(key) && powerOf(key).shields >= MIN_SHIELD_POWER && combatOf(key).shield >= MIN_SHIELD_STRENGTH) { shields.add(key); broadcastShips(); }
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
      const to = crewOf(key).filter((u) => u !== ws && !skip.includes(u.station) && !u.operator);
      const o = { id: newId('o-'), ship: key, by: ws.id, from: info(ws), text, at: Date.now(), pending: new Set(to.map((u) => u.id)), acked: new Set() };
      orders.set(o.id, o);
      for (const u of to) send(u, { type: 'order', id: o.id, from: o.from, text, at: o.at });
      orderStatus(o);
      opLog(key, `${ws.station === 'Captain' ? "Captain's" : "First Officer's"} orders: ${text}`);
      return;
    }
    case 'order-ack': {
      const o = orders.get(msg.id);
      if (!o || !o.pending.has(ws.id)) return;
      // A reassignment: move now, as walking would (force fields hold).
      if (o.reassign) {
        const to = o.reassign.station;
        if (sealed(key, ws.station)) return note(`A Security force field isolates ${ws.station}: you can't leave to report to ${to}`);
        if (sealed(key, to)) return note(`A Security force field isolates ${to}: you can't report there`);
        const was = ws.station;
        ws.station = to;
        send(ws, { type: 'registered', ...info(ws), token: ws.token });
        broadcastCrew(key);
        opLog(key, `${ws.name} reported to ${to} (from ${was}), as ordered`);
      }
      o.pending.delete(ws.id);
      o.acked.add(ws.id);
      orderStatus(o);
      return;
    }
    case 'reassign': {
      if (ws.station !== 'First Officer') return note('Only the First Officer reassigns crew');
      const u = aboard(msg.who);
      if (!u) return note('That crew member is not aboard');
      if (u.operator) return note('The ops station can only be left by the operator');
      if (!STATIONS.includes(msg.station)) return note('No such station');
      if (u.station === msg.station) return;
      // An order to the crewman: they move when they acknowledge (or decline it).
      const o = { id: newId('o-'), ship: key, by: ws.id, from: info(ws), text: `${u.name}: report to ${msg.station}`, at: Date.now(), pending: new Set([u.id]), acked: new Set(), reassign: { who: u.id, station: msg.station } };
      orders.set(o.id, o);
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

const GRID = { forcefield: 5, core: 650, coreStartSecs: 10, containment: 20, constriction: { start: 60, run: 20 }, corePump: 10, injector: 10, solar: 25, dock: 700, impulse: 75, impulseStartSecs: 5, impulsePump: 10, comms: 10, batteryOut: 150, batteryCap: 3000, batteryCharge: 50, console: 2, breachSecs: 5 };
const BUS_MAX = { A: 300, B: 300, C: 300, EPS: 1000 };
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
const SOURCES = ['ship', 'solar', 'dock', 'impulsePort', 'impulseStarboard', 'core', 'battery'];
// Every tie is one class: Bus A/B, or the EPS only (the warp core's and
// impulse drives' outputs). The warp core itself spans both: its
// subsystems on A/B, its output on the EPS.
const SOURCE_NODES = { ship: AB, solar: AB, dock: AB, impulsePort: ['EPS'], impulseStarboard: ['EPS'], thrustersPort: ['EPS'], thrustersStarboard: ['EPS'], core: ['EPS'], battery: AB, containment: AB, crosslink: AB };
// Low-power loads and sources may tie to several of Bus A, B and C (a load
// split evenly over them, a source's output shared evenly); so may the
// crosslink (the buses checked are one pool). EPS ties are one.
const isMulti = (k) => k === 'crosslink' || ((['containment', 'ship', 'solar', 'dock', 'battery'].includes(k) || /^(console|system|sub):/.test(k)) && !tieNodes(k).includes('EPS'));
const SHIP_FEED_MAX = 500; // what Engineering can offer a ship docked with us
const PORTS = ['port', 'starboard']; // docking ports (starbases take any number)
// The port a ship is docked to us at (or null), and the ships docked with us (both sides agreeing).
const portFor = (k, other) => PORTS.find((p) => engOf(k).shipDocks[p] === other) || null;
const shipsDocked = (k) => PORTS.map((p) => [p, engOf(k).shipDocks[p]]).filter(([, o]) => o && portFor(o, k));
const SYSTEM_BUS = { lifeSupport: 'A', sensors: 'A', replicators: 'B', recreation: 'B', engines: 'B', injectors: 'B', shields: 'B', weapons: 'B', transporter: 'B' };
const CONSOLE_BUS = { Captain: 'A', 'First Officer': 'A', Helm: 'A', Science: 'A', Engineering: 'A', Communications: 'A', Operations: 'A', Tactical: 'B', Security: 'B', Medical: 'B', Transporter: 'B', Crew: 'B' };
const STATION_SYSTEMS = { Helm: ['engines'], Tactical: ['shields', 'weapons', 'tractor'], Science: ['sensors'], Engineering: ['lifeSupport'], Transporter: ['transporter'], Crew: ['replicators', 'recreation'] };
const LOAD_NODES = {
  lifeSupport: AB, sensors: AB, replicators: AB, recreation: AB, // low power
  transporter: AB, tractor: AB,
  engines: ['EPS'], injectors: ['EPS'], shields: ['EPS'], weapons: ['EPS'], // high power: EPS only
};
const SYSTEM_PRIORITY = ['lifeSupport', 'sensors', 'shields', 'engines', 'injectors', 'weapons', 'tractor', 'transporter', 'replicators', 'recreation'];
// Systems shown under another system in the grid table (Helm > Engines > Plasma injectors).
const SYSTEM_CHILDREN = { engines: ['injectors'] };
// Subsystems: low-power loads (A or B) that their parent needs to work.
const SUBSYSTEMS = {
  constriction: { parent: 'core', ties: ['A'], name: 'magnetic constriction' },
  corePump: { parent: 'core', ties: ['A'], name: 'deuterium pump' },
  injector: { parent: 'core', ties: ['A'], name: 'antimatter injector' },
  portPump: { parent: 'impulsePort', ties: ['B'], name: 'deuterium pump' },
  starboardPump: { parent: 'impulseStarboard', ties: ['B'], name: 'deuterium pump' },
  forcefields: { parent: 'Security', ties: ['B'], name: 'force field emitters' },
  rf: { parent: 'Communications', ties: ['B'], name: 'local RF (calls aboard)' },
  radio: { parent: 'Communications', ties: ['B'], name: 'radio (hails, ship-to-ship calls)' },
  subspace: { parent: 'Communications', ties: ['B'], name: 'subspace relay (data links)' },
};
const DEFAULT_LOAD_TIES = {
  ...Object.fromEntries(Object.entries(CONSOLE_BUS).map(([st, b]) => [`console:${st}`, [b]])),
  ...Object.fromEntries(Object.entries(SYSTEM_BUS).map(([sys, b]) => [`system:${sys}`, LOAD_NODES[sys].includes(b) ? [b] : ['EPS']])),
  'system:tractor': ['B'],
  ...Object.fromEntries(Object.entries(SUBSYSTEMS).map(([k, v]) => [`sub:${k}`, v.ties])),
};
const loadNodes = (key) => (key.startsWith('console:') || key.startsWith('sub:') ? AB : LOAD_NODES[key.slice(7)] || []);
const tieNodes = (key) => SOURCE_NODES[key] || loadNodes(key);
const NEVER_TRIP = new Set(['containment', 'sub:constriction']);
// Starbases: dock to restock torpedoes, take dock power, repair faster and
// refit a warp core. A destroyed ship comes back docked at one of them.
const STARBASES = [{ name: 'Starbase 47', x: 500, y: 120 }, { name: 'Starbase 12', x: 120, y: 860 }, { name: 'Starbase 74', x: 880, y: 820 }, { name: 'Deep Space 4', x: 860, y: 160 }];
const DOCK_RANGE = 10;
// Starbases are on the comm net by themselves: anyone can report aboard,
// ops included. Automated, they accept data links after a short delay
// (sooner with crew aboard to expedite it) and put hails through to whoever
// is aboard; an operator aboard can answer first.
const BASE_DELAY = { link: 5000, linkCrewed: 2000, hail: 2000 };
const BASE_KEYS = new Set();
const isBase = (k) => BASE_KEYS.has(k);
const present = (k) => cores.has(k) || BASE_KEYS.has(k);
for (const b of STARBASES) { const k = registerShip(b.name); BASE_KEYS.add(k); navState.set(k, { x: b.x, y: b.y, heading: 0, warp: 0, dest: null }); }

function autoAcceptLink(id) {
  const req = linkRequests.get(id);
  if (!req) return; // answered already
  linkRequests.delete(id);
  const base = shipName(req.toShip);
  if ((!opsOf(req.fromShip).length && !crewOf(req.fromShip).some((u) => u.station === 'Communications')) || (!hardLine(req.fromShip, req.toShip) && (!commsOk(req.fromShip, req.toShip) || !commsUp(req.fromShip, 'subspace')))) { opLog(req.fromShip, `${base} could not open the data link`); broadcastAllOps(); return; }
  links.add(linkKey(req.fromShip, req.toShip));
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
const DEFAULT_TIES = { solar: ['A'], dock: ['A'], ship: [], impulsePort: ['EPS'], impulseStarboard: ['EPS'], thrustersPort: ['EPS'], thrustersStarboard: ['EPS'], core: ['EPS'], battery: ['B'], containment: ['A'], crosslink: [] };
// New ships (unless their computer says --warm) and rebuilt ones start cold:
// docked at a starbase, reactors offline, no power source tied in (consoles
// and systems keep their wiring), taps closed, no antimatter or deuterium.
// Engineering brings them up on dock power.
const COLD = { ties: { ...Object.fromEntries(Object.keys(DEFAULT_TIES).map((k) => [k, []])), impulsePort: ['EPS'], impulseStarboard: ['EPS'], thrustersPort: ['EPS'], thrustersStarboard: ['EPS'] }, taps: { A: 0, B: 0, C: 0 }, core: 'offline', drives: { port: 'off', starboard: 'off' }, antimatter: 0, deuterium: 0 };
function freshEng(saved, { cold = false } = {}) {
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
  const ties = Object.fromEntries(Object.entries(DEFAULT_TIES).map(([k, d]) => [k, tiesOf(k, s.ties?.[k] ?? (k === 'battery' ? s.battery?.bus : k === 'crosslink' ? oldXl : k === 'thrustersPort' ? oldThr('port') : k === 'thrustersStarboard' ? oldThr('starboard') : s[k]), d)]));
  // Older saves: antimatter was true/false (false: core ejected); tanks full.
  const amount = (v, cap) => (Number.isFinite(v) ? Math.max(0, Math.min(cap, v)) : v === false ? 0 : cap);
  const antimatter = amount(s.antimatter, FUEL.antimatter), deuterium = amount(s.deuterium, FUEL.deuterium);
  if (!ties.containment.length && antimatter > 0) ties.containment = DEFAULT_TIES.containment; // never no feed with antimatter aboard
  for (const [k, d] of Object.entries(DEFAULT_LOAD_TIES)) ties[k] = tiesOf(k, s.ties?.[k], d);
  const core = s.core === 'ejected' || s.antimatter === false ? 'ejected' : s.core === 'offline' || !antimatter || !deuterium ? 'offline' : 'online';
  return {
    core, antimatter, deuterium, start: 0, // a startup in progress starts over
    drives: Object.fromEntries(DRIVES.map((d) => [d, { state: (s.drives?.[d] ?? 'running') === 'running' && deuterium > 0 ? 'running' : 'off', start: 0 }])),
    // EPS taps: how much EPS power may flow down into each low bus (older saves: open/closed).
    taps: Object.fromEntries(BUSES.map((X) => { const t = s.taps?.[X]; return [X, typeof t === 'number' ? Math.max(0, Math.min(BUS_MAX[X], t)) : t === false ? 0 : t === true || X !== 'C' ? BUS_MAX[X] : 0]; })), ties,

    transfer: null, feed: { port: 0, starboard: 0 }, fed: { port: 0, starboard: 0 }, // power offered to a ship docked at each port, and what actually went
    remoteBlock: !!s.remoteBlock, // ops refuse remote control by other vessels
    forcefields: Array.isArray(s.forcefields) ? s.forcefields.filter((st) => STATIONS.includes(st)) : [], // stations Security has isolated
    // Docked with another ship: kept across restarts (it's checked once both are back).
    // Two docking ports. A starbase takes one (docked, dockedPort); ships dock
    // to a port each side (shipDocks), each connection with its own power offer.
    shipDocks: Object.fromEntries(PORTS.map((p) => { const v = s.shipDocks?.[p] ?? (p === 'starboard' && typeof s.dockedShip === 'string' ? s.dockedShip : null); return [p, typeof v === 'string' ? shipKey(v) : null]; })),
    partnerGoneAt: { port: Date.now(), starboard: Date.now() },
    dockedPort: PORTS.includes(s.dockedPort) ? s.dockedPort : 'port',
    autoRefuel: !!s.autoRefuel, // top up antimatter and deuterium while docked at a starbase
    battery: { charge: Number.isFinite(s.battery?.charge) ? Math.max(0, Math.min(GRID.batteryCap, s.battery.charge)) : GRID.batteryCap },
    docked: STARBASES.some((b) => b.name === s.docked) ? s.docked : null,
    breach: 0, selfDestruct: null, towing: null, dirty: false,
  };
}
const engOf = (k) => {
  if (!eng.has(k)) eng.set(k, { ...freshEng(), ...(isBase(k) ? { remoteBlock: baseSettings[shipName(k)]?.remoteBlock ?? true } : {}) });
  return eng.get(k);
};
// Starbases have no ship's computer to keep their settings: the relay keeps
// them (remote control starts blocked at a starbase).
const BASE_SETTINGS_FILE = path.join(__dirname, 'data', 'starbases.json');
let baseSettings = {};
try { baseSettings = JSON.parse(fs.readFileSync(BASE_SETTINGS_FILE, 'utf8')); } catch {}
function saveBaseSettings() {
  for (const k of BASE_KEYS) baseSettings[shipName(k)] = { remoteBlock: !!engOf(k).remoteBlock };
  try { fs.mkdirSync(path.dirname(BASE_SETTINGS_FILE), { recursive: true }); fs.writeFileSync(BASE_SETTINGS_FILE, JSON.stringify(baseSettings, null, 2)); } catch (err) { console.warn(`could not save starbase settings: ${err.message}`); }
}
const savedEng = (k) => {
  const e = engOf(k);
  return {
    core: e.core === 'starting' ? 'offline' : e.core, drives: Object.fromEntries(DRIVES.map((d) => [d, e.drives[d].state === 'running' ? 'running' : 'off'])),
    antimatter: round1(e.antimatter), deuterium: round1(e.deuterium), taps: e.taps, ties: e.ties, forcefields: e.forcefields, remoteBlock: !!e.remoteBlock, battery: { charge: Math.round(e.battery.charge) }, docked: e.docked,
    dockedPort: e.dockedPort, autoRefuel: e.autoRefuel,
    shipDocks: Object.fromEntries(PORTS.map((p) => [p, e.shipDocks[p] ? shipName(e.shipDocks[p]) : null])),
  };
};
const towedBy = (k) => [...eng].find(([, e]) => e.towing === k)?.[0] || null;
// A subsystem works when it has its power and isn't badly damaged.
const SUB_FAIL_DAMAGE = 50;

// Where each ship's power goes, worked out fresh (cached briefly: it's asked a lot).
const flowCache = new Map();
function flow(k) {
  const cached = flowCache.get(k);
  if (cached && Date.now() - cached.at < 200) return cached.f;
  const e = engOf(k), c = combatOf(k), a = allocOf(k);
  const demand = {};
  // Damage takes the same share off what a system can draw, overdrive included.
  for (const s of SYSTEMS) demand[s] = s === 'weapons' && !c.armed ? 0 : Math.min(a[s], Math.max(0, (POWER_MAX * (100 - c.damage[s])) / 100));
  // A ship docked with us: each side offers power (feed); whoever offers more
  // sends the difference, drawn from (or, received, fed into) the docked-ship ties.
  // Each connection on its own: per port, whoever offers more sends the difference.
  const conns = shipsDocked(k).map(([p, o]) => { const theirs = portFor(o, k); return { p, o, net: e.feed[p] - engOf(o).feed[theirs], theirFed: engOf(o).fed[theirs] || 0 }; });
  // Each running drive gives half impulse. With its thrusters tied in to the
  // EPS, whatever share of it isn't thrusting feeds the EPS; untied, it only thrusts.
  const nv = navState.get(k);
  const running = DRIVES.filter((d) => e.drives[d].state === 'running' && e.deuterium > 0);
  const impulseNow = nv && nv.warp > 0 && nv.warp < 1 ? nv.warp : 0;
  const share = running.length ? Math.min(1, impulseNow / (0.125 * running.length)) : 0;
  const driveGen = (d) => (running.includes(d) && (e.ties[`thrusters${d[0].toUpperCase()}${d.slice(1)}`] || []).length ? GRID.impulse * (1 - share) : 0);
  const cap = { ship: conns.reduce((n, cn) => n + (cn.net < 0 ? Math.min(-cn.net, cn.theirFed) : 0), 0), solar: GRID.solar, dock: e.docked ? GRID.dock : 0, impulsePort: driveGen('port'), impulseStarboard: driveGen('starboard'), core: e.core === 'online' && (c.damage.conduits || 0) < SUB_FAIL_DAMAGE ? GRID.core : 0, battery: Math.min(GRID.batteryOut, e.battery.charge) };
  // A source tied to several buses shares its output evenly between them.
  const srcs = SOURCES.map((name) => {
    const t = e.ties[name], full = t.length ? cap[name] : 0;
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
  const poolOf = Object.fromEntries(BUSES.map((X) => [X, new Set([X])]));
  if (e.ties.crosslink.length >= 2) { const m = new Set(e.ties.crosslink); for (const y of m) poolOf[y] = m; }
  const pool = (X) => [...poolOf[X]];
  // A damaged bus carries less: its max scales with its condition.
  const maxOf = (X) => BUS_MAX[X] * Math.max(0, 1 - (c.damage[`bus${X}`] || 0) / 100);
  const busRoom = (node) => pool(node).reduce((n, X) => n + maxOf(X) - buses[X].have, 0);
  const tapRoom = (node) => pool(node).reduce((n, X) => n + Math.max(0, e.taps[X] - buses[X].tapUsed), 0);
  const take = (node, amt) => {
    let got = 0;
    const bus = buses[node];
    const pull = (s, eps, side = node) => {
      const room = Math.min(bus ? busRoom(node) - got : Infinity, eps ? maxOf('EPS') - viaEps : Infinity, bus && eps ? tapRoom(node) : Infinity);
      const t = Math.min(s.left, amt - got, room, s.share && !eps ? s.share[side] : Infinity);
      if (t <= 0) return;
      s.left -= t; got += t;
      if (s.share && !eps) s.share[side] -= t;
      cells[s.name][eps ? 'EPS' : side] += t;
      if (eps) viaEps += t;
      if (bus && eps) { let rest = t; for (const X of [node, ...pool(node).filter((y) => y !== node)]) { const u = Math.min(rest, Math.max(0, e.taps[X] - buses[X].tapUsed)); buses[X].tapUsed += u; rest -= u; } }
      if (bus) bus.src[s.name] = (bus.src[s.name] || 0) + t;
    };
    const sides = bus ? pool(node) : [node];
    for (const last of [false, true]) { // batteries only when nothing else will do
      for (const side of sides) for (const s of srcs) if ((s.name === 'battery') === last && s.ties.includes(side)) pull(s, node === 'EPS', side);
      if (bus) for (const s of srcs) if ((s.name === 'battery') === last && s.ties.includes('EPS')) pull(s, true);
    }
    if (bus) { bus.need += amt; bus.have += got; }
    return got;
  };
  // What's tied to each node, for the breakers (a split load counts its share on each).
  const tied = blank();
  const trippable = [];
  // Breakers watch sustained load: startup surges don't count.
  const sustained = (key, amt) => (key === 'sub:constriction' && e.core === 'starting' ? GRID.constriction.run : key.endsWith('Pump') && key !== 'sub:corePump' ? 0 : amt);
  // Power for a docked ship goes out the way it comes in.
  const tiesFor = (key) => (key.startsWith('feed:') ? e.ties.ship : e.ties[key]) || [];
  // A load tied to several buses is split evenly across them (each bus
  // serves its share); its cell row records where its power came from.
  const serve = (key, amt) => {
    const row = cells[key] || (cells[key] = blank());
    const ties = tiesFor(key);
    if (!ties.length || amt <= 0) return 0;
    const part = amt / ties.length, counted = sustained(key, amt) / ties.length;
    let got = 0;
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
    for (const n of e.ties.containment) { tied[n] += GRID.containment / e.ties.containment.length; if (contained < GRID.containment) { const t = take(n, GRID.containment - contained); row[n] += t; contained += t; } }
  }
  const containmentOk = e.antimatter <= 0 || contained >= GRID.containment;
  // Every other load, in priority order: the reactors' subsystems, consoles,
  // Communications, power for a docked ship, then the systems.
  const coreOn = e.core === 'online' || e.core === 'starting';
  const crew = crewOf(k);
  const loads = [
    ['sub:constriction', !coreOn ? 0 : e.core === 'starting' ? GRID.constriction.start : GRID.constriction.run],
    ['sub:corePump', coreOn ? GRID.corePump : 0], ['sub:injector', coreOn ? GRID.injector : 0],
    ...DRIVES.map((d) => [`sub:${d}Pump`, e.drives[d].state === 'starting' ? GRID.impulsePump : 0]), // running drives power their own pumps
    ...Object.keys(CONSOLE_BUS).map((st) => [`console:${st}`, crew.filter((u) => u.station === st).length * GRID.console]),
    ...['rf', 'radio', 'subspace'].map((x) => [`sub:${x}`, GRID.comms]),
    ['sub:forcefields', e.forcefields.length * GRID.forcefield],
    ...PORTS.map((p) => [`feed:${p}`, Math.max(0, conns.find((cn) => cn.p === p)?.net || 0)]),
    ...SYSTEM_PRIORITY.map((sys) => [`system:${sys}`, sys === 'tractor' ? (e.towing ? TRACTOR.draw : 0) : demand[sys]]),
  ];
  // Each bus serves the loads tied to it alone first (priority order), then
  // its batteries charge, then loads split over two buses, then over three.
  const got = {};
  const bt = e.ties.battery;
  const usedOf = (name) => { const src = srcs.find((x) => x.name === name); return src.ties.length ? cap[name] - src.left : 0; };
  let charging = 0;
  const chargeFrom = (X) => {
    if (!bt.includes(X) || usedOf('battery') > 0) return;
    const room = Math.min(GRID.batteryCharge, GRID.batteryCap - e.battery.charge);
    for (const x of srcs) {
      if (x.name === 'battery' || charging >= room) continue;
      const sides = pool(X);
      const direct = sides.some((y) => x.ties.includes(y));
      if (!(direct || (tapRoom(X) > 0 && x.ties.includes('EPS')))) continue;
      const via = sides.find((y) => x.ties.includes(y));
      const t = Math.min(x.left, room - charging, busRoom(X), direct ? (x.share ? x.share[via] : Infinity) : tapRoom(X));
      if (t <= 0) continue;
      x.left -= t; charging += t;
      if (direct && x.share) x.share[via] -= t;
      buses[X].need += t; buses[X].have += t;
      if (!direct) { viaEps += t; let rest = t; for (const y of sides) { const u = Math.min(rest, Math.max(0, e.taps[y] - buses[y].tapUsed)); buses[y].tapUsed += u; rest -= u; } }
      cells.battery[X] -= t; // shown as a draw on the battery row
    }
  };
  for (const X of NODES) {
    for (const [key, amt] of loads) if (tiesFor(key).length === 1 && tiesFor(key)[0] === X) got[key] = serve(key, amt);
    if (X !== 'EPS') chargeFrom(X);
  }
  for (const n of [2, 3]) for (const [key, amt] of loads) if (tiesFor(key).length === n) got[key] = serve(key, amt);
  const amtOf = Object.fromEntries(loads);
  const full = (key) => (got[key] || 0) >= amtOf[key] - 1e-9;
  const subOk = {};
  for (const name of Object.keys(SUBSYSTEMS)) subOk[name] = full(`sub:${name}`) && (c.damage[name] || 0) < SUB_FAIL_DAMAGE;
  const coreSubsOk = ['constriction', 'corePump', 'injector'].every((x) => subOk[x]);
  const consoleOk = Object.fromEntries(Object.keys(CONSOLE_BUS).map((st) => [st, full(`console:${st}`)]));
  const fed = PORTS.reduce((n, p) => n + (got[`feed:${p}`] || 0), 0);
  for (const p of PORTS) e.fed[p] = got[`feed:${p}`] || 0;
  cells.feed = blank();
  for (const p of PORTS) for (const n of NODES) cells.feed[n] += cells[`feed:${p}`]?.[n] || 0;
  const delivered = Object.fromEntries(SYSTEMS.map((sys) => [sys, got[`system:${sys}`] || 0]));
  const tractorOk = !e.towing || full('system:tractor');
  for (const X of BUSES) {
    const sys = SYSTEMS.filter((x) => e.ties[`system:${x}`]?.includes(X));
    const want = sys.reduce((n, x) => n + demand[x], 0);
    Object.assign(buses[X], { consolesOk: Object.keys(CONSOLE_BUS).every((st) => !e.ties[`console:${st}`]?.includes(X) || consoleOk[st]), fraction: want ? Math.min(1, sys.reduce((n, x) => n + delivered[x], 0) / want) : 1 });
  }
  const used = usedOf('battery');
  const drawn = SOURCES.reduce((n, name, i) => n + ((srcs[i].ties.length ? cap[name] : 0) - srcs[i].left), 0); // charging included
  // Impulse: half impulse for each running drive.
  const thrusting = running.length;
  // The grid table's footer: per bus (and the EPS), power used, available and the most it carries.
  const epsLeft = srcs.filter((x) => x.ties.includes('EPS')).reduce((m, x) => m + x.left, 0);
  const totals = Object.fromEntries(NODES.map((n) => {
    const cond = Math.round(100 - (c.damage[`bus${n}`] || 0));
    if (n === 'EPS') return [n, { used: Math.round(viaEps), available: Math.round(Math.min(maxOf('EPS'), viaEps + epsLeft)), max: Math.round(maxOf('EPS')), fullMax: BUS_MAX.EPS, condition: cond, tied: Math.round(tied.EPS) }];
    const direct = srcs.filter((x) => pool(n).some((y) => x.ties.includes(y))).reduce((m, x) => m + x.left, 0);
    const have = buses[n].have;
    return [n, { used: Math.round(have), available: Math.round(Math.min(maxOf(n), have + direct + Math.min(epsLeft, tapRoom(n)))), max: Math.round(maxOf(n)), fullMax: BUS_MAX[n], condition: cond, tied: Math.round(tied[n]), tap: e.taps[n], pool: pool(n).join('') }];
  }));
  const f = {
    cells, totals, buses, consoleOk, demand, delivered, containmentOk, coreSubsOk, subOk, tractorOk, tied, trippable, thrusting,
    batteryUsed: Math.max(0, used), coreUsed: usedOf('core'), impulseUsed: usedOf('impulsePort') + usedOf('impulseStarboard'), charging, drawn, viaEps,
  };
  flowCache.set(k, { at: Date.now(), f });
  return f;
}
const gridChanged = (k) => { flowCache.delete(k); scheduleNav(); };
// A console with no power on its bus is dark (ops and Engineering's grid controls aside).
// A station Security has isolated with a force field (while the emitters have
// power): nobody walks in or out (the Station menu, across a dock); whoever
// is inside keeps using its console. Transporters get through.
const sealed = (k, station) => engOf(k).forcefields.includes(station) && flow(k).subOk.forcefields !== false;
const consoleDark = (ws) => { flowCache.delete(ws.shipKey); return flow(ws.shipKey).consoleOk[ws.station] === false; }; // fresh: who's aboard may have just changed
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
    e.ties[t.key] = e.ties[t.key].filter((n) => n !== over);
    e.dirty = true;
    const name = t.key.startsWith('console:') ? `${t.key.slice(8)} console` : t.key.startsWith('sub:') ? SUBSYSTEMS[t.key.slice(4)].name : SYSTEM_NAMES[t.key.slice(7)] || t.key;
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

function gridView(k) {
  const e = engOf(k), f = flow(k);
  const near = isBase(k) ? null : STARBASES.find((b) => navState.has(k) && Math.hypot(navState.get(k).x - b.x, navState.get(k).y - b.y) <= DOCK_RANGE);
  const tower = towedBy(k);
  const r = (o) => Object.fromEntries(Object.entries(o).map(([x, v]) => [x, Math.round(v)]));
  return {
    core: e.core, antimatter: Math.floor(e.antimatter), deuterium: Math.floor(e.deuterium), fuelCaps: { antimatter: FUEL.antimatter, deuterium: FUEL.deuterium },
    drives: Object.fromEntries(DRIVES.map((d) => [d, { state: e.drives[d].state, start: e.drives[d].start, thrusters: !!(e.ties[`thrusters${d[0].toUpperCase()}${d.slice(1)}`] || []).length }])), impulseStartSecs: GRID.impulseStartSecs, impulseOutput: GRID.impulse,
    transfer: e.transfer ? { ...e.transfer, left: Math.ceil(e.transfer.left), with: e.transfer.with === 'station' ? e.docked : shipName(e.transfer.with) } : null,
    dockedPort: e.docked ? e.dockedPort : null, nearShip: nearShip(k), dockedWith: dockedWith(k).map(shipName), autoRefuel: e.autoRefuel,
    // What each port holds: a starbase, a ship (with its power offers), or nothing.
    ports: Object.fromEntries(PORTS.map((p) => {
      const o = e.shipDocks[p] && portFor(e.shipDocks[p], k) ? e.shipDocks[p] : null;
      return [p, e.docked && e.dockedPort === p ? { base: e.docked } : o ? { ship: shipName(o), feed: e.feed[p], fed: Math.round(e.fed[p]), theirFeed: engOf(o).feed[portFor(o, k)] } : null];
    })),
    dockedShip: shipsDocked(k)[0] ? shipName(shipsDocked(k)[0][1]) : null, // (first, for older pages)
    shipIn: Math.round(Object.values(f.cells.ship).reduce((a, b) => a + b, 0)), feedMax: SHIP_FEED_MAX,
    dockRequest: dockRequests.get(k) ? { from: shipName(dockRequests.get(k).from), port: dockRequests.get(k).port, seconds: Math.max(0, Math.ceil((dockRequests.get(k).until - Date.now()) / 1000)) } : null,
    thrustersOk: thrustersOk(k),
    cells: Object.fromEntries(Object.entries(f.cells).map(([n, c]) => [n, r(c)])), totals: f.totals,
    coreUsed: Math.round(f.coreUsed), impulseUsed: Math.round(f.impulseUsed), coreSubsOk: f.coreSubsOk, subOk: f.subOk,
    start: e.start, startSecs: GRID.coreStartSecs, coreOutput: GRID.core,
    taps: e.taps, ties: e.ties, containmentOk: f.containmentOk, eps: Math.round(f.viaEps),
    breach: e.breach ? GRID.breachSecs - e.breach : null,
    battery: { charge: Math.round((e.battery.charge / GRID.batteryCap) * 100), charging: Math.round(f.charging), supplying: Math.round(f.batteryUsed) },
    docked: e.docked, near: near?.name || null,
    towing: e.towing ? shipName(e.towing) : null, towedBy: tower ? shipName(tower) : null,
    selfDestruct: e.selfDestruct ? { seconds: Math.max(0, Math.ceil((e.selfDestruct.at - Date.now()) / 1000)), by: e.selfDestruct.by } : null,
    buses: Object.fromEntries(BUSES.map((X) => { const b = f.buses[X]; return [X, { need: Math.round(b.need), have: Math.round(b.have), src: r(b.src), consolesOk: b.consolesOk, fraction: Math.round(b.fraction * 100) }]; })),
    consoleOk: f.consoleOk, systemChildren: SYSTEM_CHILDREN, powerMax: POWER_MAX, forcefields: e.forcefields, fieldsUp: e.forcefields.length > 0 && f.subOk.forcefields !== false, stationSystems: STATION_SYSTEMS, subsystems: Object.fromEntries(Object.entries(SUBSYSTEMS).map(([x, v]) => [x, { parent: v.parent, name: v.name }])),
    tieNodes: Object.fromEntries(Object.keys(e.ties).map((key) => [key, tieNodes(key)])), multi: Object.keys(e.ties).filter(isMulti), busMax: BUS_MAX,
    delivered: r(f.delivered), demand: f.demand, drawn: Math.round(f.drawn),
  };
}

// Engineering's grid controls: the warp core and impulse drives, EPS taps,
// ties, ejecting and replacing the core, docked-ship power, supplies.
function gridCommand(ws, msg) {
  const key = ws.shipKey, e = engOf(key);
  const note = (text) => send(ws, { type: 'notice', text: `Engineering: ${text}` });
  if (ws.station !== 'Engineering') return send(ws, { type: 'notice', text: 'Only Engineering runs the power grid' });
  const said = [];
  const NAME = { core: 'power transfer conduits', thrustersPort: 'port maneuvering thrusters', thrustersStarboard: 'starboard maneuvering thrusters', crosslink: 'bus crosslink', solar: 'solar', dock: 'dock power', ship: 'docked-ship power', core: 'warp core', battery: 'batteries', containment: 'antimatter containment', impulsePort: 'port impulse drive', impulseStarboard: 'starboard impulse drive' };
  const feeds = (list) => (list.length ? list.map((n) => (n === 'EPS' ? 'EPS' : `Bus ${n}`)).join(' + ') : 'off');
  if (msg.eject) {
    if (e.core === 'ejected') return note('the warp core is already gone');
    Object.assign(e, { core: 'ejected', antimatter: 0, start: 0, breach: 0 });
    if (e.transfer?.resource === 'antimatter') e.transfer = null;
    said.push('WARP CORE AND ANTIMATTER PODS EJECTED');
    for (const u of crewOf(key)) if (u !== ws) send(u, { type: 'notice', text: `Engineering: the warp core has been ejected (${ws.name})` });
  }
  if (msg.refit) {
    // A new warp core and antimatter pods, from the starbase. Full pods need a
    // containment feed set to go into; without one they come empty.
    if (!e.docked) return note('a warp core and antimatter pods can only be replaced at a starbase');
    if (e.core === 'online' || e.core === 'starting') return note('shut the warp core down before replacing it');
    const fill = e.ties.containment.length > 0;
    Object.assign(e, { core: 'offline', start: 0, breach: 0, antimatter: fill ? FUEL.antimatter : 0 });
    if (e.transfer?.resource === 'antimatter') e.transfer = null;
    said.push(`new warp core and ${fill ? 'full' : 'empty'} antimatter pods installed at ${e.docked} (offline: start it up${fill ? '' : '; set a containment feed and refuel first'})`);
  }
  if (msg.core === 'start' && e.core === 'offline') {
    if (e.antimatter <= 0 || e.deuterium <= 0) return note(`the warp core needs antimatter and deuterium (aboard: ${Math.floor(e.antimatter)} antimatter, ${Math.floor(e.deuterium)} deuterium)`);
    e.core = 'starting'; e.start = 0; flowCache.delete(key);
    if (!flow(key).coreSubsOk) { e.core = 'offline'; flowCache.delete(key); return note(`the warp core's constriction (${GRID.constriction.start} to start), deuterium pump and antimatter injector need power: tie them to a bus that has it`); }
    said.push('warp core startup');
  } else if (msg.core === 'start' && e.core === 'ejected') return note('there is no warp core: install a new one at a starbase');
  else if (msg.core === 'stop' && (e.core === 'online' || e.core === 'starting')) {
    e.core = 'offline'; e.start = 0;
    said.push('warp core shut down');
  }
  // Impulse drives: start (on bus power for their pumps) or stop; thrusters in or out.
  if (msg.impulse && DRIVES.includes(msg.impulse.drive)) {
    const d = e.drives[msg.impulse.drive], side = msg.impulse.drive;
    if (msg.impulse.on && d.state === 'off') {
      if (e.deuterium <= 0) return note('the impulse drives need deuterium');
      d.state = 'starting'; d.start = 0; flowCache.delete(key);
      if (!flow(key).subOk[`${side}Pump`]) { d.state = 'off'; flowCache.delete(key); return note(`the ${side} impulse drive's deuterium pump needs ${GRID.impulsePump} to start: tie it to a bus that has it`); }
      said.push(`${side} impulse drive startup`);
    } else if (!msg.impulse.on && d.state !== 'off') { d.state = 'off'; d.start = 0; said.push(`${side} impulse drive shut down`); }
  }
  // EPS taps: how much EPS power may flow into a bus ({bus, amount}, or {bus, on} for all or nothing).
  if (msg.tap && BUSES.includes(msg.tap.bus)) {
    const X = msg.tap.bus;
    e.taps[X] = Math.max(0, Math.min(BUS_MAX[X], Math.round(Number.isFinite(msg.tap.amount) ? msg.tap.amount : msg.tap.on ? BUS_MAX[X] : 0)));
    said.push(`EPS tap to Bus ${X}: ${e.taps[X] ? `up to ${e.taps[X]}` : 'closed'}`);
  }
  for (const [k, v] of Object.entries(msg.ties && typeof msg.ties === 'object' ? msg.ties : {})) {
    if (!(k in e.ties) || !Array.isArray(v) || k === 'impulsePort' || k === 'impulseStarboard') continue; // a drive feeds the EPS through its thrusters' tie
    const allowed = tieNodes(k);
    if (v.some((n) => !allowed.includes(n))) return note(`${NAME[k] || k.split(':')[1]} can only be tied to ${feeds(allowed)}`);
    const list = NODES.filter((n) => v.includes(n));
    if (list.length > 1 && !isMulti(k)) return note(`${NAME[k] || k.split(':')[1]} ties to one: Bus A, B or C (the crosslink joins buses)`);
    if (k === 'containment' && !list.length && e.antimatter > 0) return note('antimatter containment can\'t be switched off with antimatter aboard (only self-destruct does that): leave it at least one feed');
    e.ties[k] = list;
    said.push(`${NAME[k] || (k.startsWith('console:') ? `${k.slice(8)} console` : k.startsWith('sub:') ? SUBSYSTEMS[k.slice(4)].name : SYSTEM_NAMES[k.slice(7)] || k.slice(7))} ${k === 'containment' ? 'fed from' : 'tied to'} ${feeds(list)}`);
  }
  if ('feed' in msg) {
    // Power offered across one docking port (the first ship connection if no port is named).
    const p = PORTS.includes(msg.port) ? msg.port : shipsDocked(key)[0]?.[0] || 'port';
    e.feed[p] = Math.max(0, Math.min(SHIP_FEED_MAX, Math.round(Number(msg.feed) || 0)));
    const o = e.shipDocks[p];
    said.push(o ? `offering the ${shipName(o)} ${e.feed[p]} power (${p} dock)` : `power for a ship at the ${p} dock set to ${e.feed[p]}`);
  }
  if ('autoRefuel' in msg) {
    e.autoRefuel = !!msg.autoRefuel;
    said.push(`auto refuel ${e.autoRefuel ? 'on: antimatter and deuterium are topped off while docked at a starbase' : 'off'}`);
  }
  // Supplies: take on or send off antimatter or deuterium, docked at a
  // starbase (refuel, offload) or with another ship (send ours to them).
  if ('transfer' in msg) {
    const t = msg.transfer;
    if (!t) { if (e.transfer) said.push('transfer stopped'); e.transfer = null; }
    else {
      if (!RESOURCES.includes(t.resource)) return note('transfer antimatter or deuterium');
      const amount = Math.max(1, Math.min(FUEL[t.resource], Math.round(Number(t.amount) || FUEL[t.resource])));
      const inbound = t.dir === 'in';
      // From a starbase, or to a ship docked with us (msg.ship picks which).
      const shipTo = msg.transfer.ship ? shipKey(clean(msg.transfer.ship)) : shipsDocked(key)[0]?.[1];
      const partner = e.docked && !msg.transfer.ship ? 'station' : shipTo && portFor(key, shipTo) && portFor(shipTo, key) ? shipTo : e.docked ? 'station' : null;
      if (!partner) return note('dock at a starbase (or with another ship) to transfer supplies');
      if (inbound && partner !== 'station') return note(`the ${shipName(partner)} sends its own supplies: ask their Engineering`);
      if (inbound && t.resource === 'antimatter' && !e.ties.containment.length) return note('set a containment feed before taking on antimatter');
      if (inbound && t.resource === 'antimatter' && e.core === 'ejected') return note('no warp core to hold antimatter: install one first');
      if (!inbound && partner !== 'station' && t.resource === 'antimatter' && !engOf(partner).ties.containment.length) return note(`the ${shipName(partner)} has no containment feed set: it can't take antimatter`);
      const room = inbound ? FUEL[t.resource] - e[t.resource] : partner === 'station' ? e[t.resource] : Math.min(e[t.resource], FUEL[t.resource] - engOf(partner)[t.resource]);
      if (room < 1) return note(inbound ? `the ${t.resource} tank is already full` : partner === 'station' ? `no ${t.resource} aboard to offload` : `nothing to send: our ${t.resource} is empty or the ${shipName(partner)}'s tank is full`);
      e.transfer = { resource: t.resource, dir: inbound ? 'in' : 'out', left: amount, with: partner };
      said.push(`${inbound ? 'taking on' : partner === 'station' ? 'offloading' : `sending the ${shipName(partner)}`} ${amount} ${t.resource}${partner === 'station' ? ` (${e.docked})` : ''}`);
    }
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
const freePort = (k, want) => (PORTS.includes(want) && !portTaken(k, want) ? want : PORTS.find((p) => !portTaken(k, p)) || null);
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
  if (msg.undock) {
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
  opLog(key, `Helm (${ws.name}): docked at ${base.name} (${port} dock)`);
  for (const u of crewOf(key)) send(u, { type: 'notice', text: `Helm: docked at ${base.name}` });
  gridChanged(key);
}

// Docked vessels are joined by a hard line through the dock: always in data
// link reach of each other, whatever their sensors or subspace relays.
const hardLine = (a, b) => present(a) && present(b) && dockedWith(a).includes(b);

// The vessels docked with this one: its starbase and the ship docked with it
// (for a starbase, every ship docked there).
function dockedWith(k) {
  const e = engOf(k), out = [];
  if (e.docked) out.push(shipKey(e.docked));
  for (const [, o] of shipsDocked(k)) out.push(o);
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
  engOf(k).feed[p] = 0; engOf(k).fed[p] = 0;
  if (tp) { engOf(t).feed[tp] = 0; engOf(t).fed[tp] = 0; } // ships start offering nothing
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
  if (isBase(t)) return note(`${shipName(t)} is a starbase: it doesn't move`);
  if (!cores.has(t) || !navState.has(t) || !sensorOk(key, t)) return note(`the ${clean(msg.ship)} is not on sensors`);
  if (distance(key, t) > TRACTOR.range) return note(`the ${shipName(t)} is out of tractor range (${Math.round(distance(key, t))} units; get within ${TRACTOR.range})`);
  if (shields.has(t)) return note(`the ${shipName(t)} has its shields up: the tractor beam can't hold it`);
  if (towedBy(key)) return note('we are held in a tractor beam ourselves');
  if (towedBy(t) && towedBy(t) !== key) return note(`the ${shipName(t)} is already in the ${shipName(towedBy(t))}'s tractor beam`);
  if (engOf(t).towing === key) return note(`the ${shipName(t)} has us in its tractor beam`);
  if (e.towing && e.towing !== t) releaseTractor(key, 'switching target');
  e.towing = t;
  flowCache.delete(key);
  if (!flow(key).tractorOk) { e.towing = null; flowCache.delete(key); return note(`not enough power on Bus B for the tractor beam (needs ${TRACTOR.draw})`); }
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

// Towed ships follow just behind the ship towing them.
function tow() {
  for (const [k, e] of eng) {
    const t = e.towing;
    if (!t) continue;
    const why = !cores.has(k) || !cores.has(t) ? 'lost contact' : shields.has(t) ? `the ${shipName(t)} raised shields` : !flow(k).tractorOk ? 'not enough power on Bus B' : consoleDarkFor(k, 'Tactical') ? 'no power to Tactical' : null;
    if (why) { releaseTractor(k, why); continue; }
    const n = navState.get(k), m = navState.get(t);
    if (!n || !m) continue;
    const a = (n.heading * Math.PI) / 180;
    const x = Math.min(1000, Math.max(0, n.x - Math.sin(a) * TRACTOR.behind)), y = Math.min(1000, Math.max(0, n.y + Math.cos(a) * TRACTOR.behind));
    if (Math.hypot(m.x - x, m.y - y) < 0.3 && !m.warp) continue;
    Object.assign(m, { x, y, heading: n.heading, warp: 0, dest: null });
    const core = primaryCore.get(t);
    if (core) send(core, { type: 'core-set', ship: shipName(t), set: { moveTo: { x, y, heading: n.heading } } });
  }
}
const consoleDarkFor = (k, station) => flow(k).consoleOk[station] === false;


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
  releaseTractor(k, `the ${name} was destroyed`);
  const tower = towedBy(k);
  if (tower) releaseTractor(tower, `the ${name} was destroyed`);
  combat.set(k, { ...freshCombat(), loaded: true });
  undockShips(k, `the ${name} was destroyed`);
  eng.set(k, { ...freshEng(null, { cold: true }), docked: base.name }); // rebuilt cold: Engineering brings it up on dock power
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
const SYSTEM_NAMES = { engines: 'engines', shields: 'shield generators', sensors: 'sensors', transporter: 'transporter', weapons: 'weapons', lifeSupport: 'life support', replicators: 'replicators', recreation: 'recreation (holodecks)', tractor: 'tractor beam', injectors: 'plasma injectors',
  corePump: "warp core's deuterium pump", injector: 'antimatter injector', portPump: "port impulse drive's deuterium pump", starboardPump: "starboard impulse drive's deuterium pump",
  conduits: 'power transfer conduits', rf: 'local RF', radio: 'radio', subspace: 'subspace relay', busA: 'Bus A', busB: 'Bus B', busC: 'Bus C', busEPS: 'EPS grid' };
// What a hit can damage: the systems, and the subsystems that fail when badly damaged.
const DAMAGEABLE = [...SYSTEMS, 'conduits', 'corePump', 'injector', 'portPump', 'starboardPump', 'rf', 'radio', 'subspace', 'busA', 'busB', 'busC', 'busEPS'];
const combat = new Map(); // ship key -> { hull, shield, damage, torpedoes, repair, lock, armed, phaserCharge, torpedoAt, restockAt, hitAt, hitBy, dirty }

function freshCombat(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const num = (v, d, max = 100) => (Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : d);
  return {
    hull: num(s.hull, 100) || 100, shield: num(s.shield, 100),
    damage: Object.fromEntries(DAMAGEABLE.map((k) => [k, num(s.damage?.[k], 0)])),
    torpedoes: num(s.torpedoes, TORPEDO.carried, TORPEDO.carried),
    repair: s.repair === 'hull' || DAMAGEABLE.includes(s.repair) ? s.repair : null,
    lock: null, armed: false, phaserCharge: 0, torpedoAt: 0, restockAt: Date.now(), hitAt: 0, hitBy: null, dirty: false,
  };
}
const combatOf = (k) => { if (!combat.has(k)) combat.set(k, freshCombat()); return combat.get(k); };
const round1 = (v) => Math.round(v * 10) / 10;
const savedCombat = (k) => {
  const c = combatOf(k);
  return { hull: round1(c.hull), shield: round1(c.shield), damage: Object.fromEntries(DAMAGEABLE.map((s) => [s, round1(c.damage[s])])), torpedoes: c.torpedoes, repair: c.repair };
};
// What a ship's computer keeps: its position and settings, plus combat and grid state.
const coreCopy = (k) => (navState.has(k) ? { ...navState.get(k), combat: savedCombat(k), eng: savedEng(k) } : undefined);

// The ship's own combat state, for its consoles.
function combatView(k) {
  const c = combatOf(k), now = Date.now();
  const t = c.lock && navState.has(c.lock) ? c.lock : null;
  return {
    hull: Math.round(c.hull), shield: Math.round(c.shield),
    damage: Object.fromEntries(DAMAGEABLE.map((s) => [s, Math.ceil(c.damage[s])])),
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
  if (nav && core && !speedOk(k, nav.warp)) {
    const l = speedLimits(k);
    const warp = nav.warp >= 1 ? l.warp || l.impulse : l.impulse;
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
    const sys = DAMAGEABLE[Math.floor(Math.random() * DAMAGEABLE.length)];
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
    c.repair = msg.system === 'hull' || DAMAGEABLE.includes(msg.system) ? msg.system : null;
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
    if (isBase(t)) return note(`${shipName(t)} is a Federation starbase: weapons won't lock on it`);
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
    if (!navState.has(k) || isBase(k)) continue;
    const c = combatOf(k), e = engOf(k);
    const state = () => JSON.stringify([c.hull, c.shield, c.damage, c.torpedoes, c.repair, Math.floor(c.phaserCharge), e.core, e.start, e.breach, Math.round(e.battery.charge / 30), e.docked, e.shipDocks, Math.floor(e.antimatter), Math.floor(e.deuterium), e.transfer?.left, e.drives]);
    const before = state();
    flowCache.delete(k);
    const f = flow(k);

    // Self-destruct: containment off, and the core goes.
    if (e.selfDestruct && now >= e.selfDestruct.at) { destroy(k, `self-destruct, by order of ${e.selfDestruct.by}`); changed = true; continue; }
    // Containment: a few seconds on reserve, then the core breaches.
    if (!f.containmentOk) {
      e.breach++;
      if (e.breach === 1) { opLog(k, 'antimatter containment failing: no power'); for (const u of crewOf(k)) send(u, { type: 'notice', text: 'Warning: antimatter containment failing (no power on its feeds): restore power or eject the core' }); }
      if (e.breach >= GRID.breachSecs) { destroy(k, 'warp core breach: antimatter containment lost'); changed = true; continue; }
    } else if (e.breach) { e.breach = 0; opLog(k, 'antimatter containment restored'); tellStations(k, ['Engineering', 'Captain'], 'Engineering: antimatter containment restored'); }
    // The warp core: starting up, and running, need its constriction, pump and injector.
    const coreWhy = () => ['constriction', 'corePump', 'injector'].filter((x) => !f.subOk[x]).map((x) => SUBSYSTEMS[x].name).join(', ');
    if (e.core === 'starting') {
      if (!f.coreSubsOk) { e.core = 'offline'; e.start = 0; opLog(k, `warp core startup failed: no power to its ${coreWhy()}`); tellStations(k, ['Engineering'], `Engineering: warp core startup failed, no power to its ${coreWhy()}`); }
      else if (++e.start >= GRID.coreStartSecs) { e.core = 'online'; e.start = 0; e.dirty = true; opLog(k, 'warp core online'); tellStations(k, ['Engineering', 'Captain'], 'Engineering: warp core online'); }
    } else if (e.core === 'online' && !f.coreSubsOk) {
      e.core = 'offline'; e.dirty = true;
      opLog(k, `warp core shut down: no power to its ${coreWhy()}`);
      tellStations(k, ['Engineering', 'Captain'], `Engineering: warp core shut down, no power to its ${coreWhy()}`);
    }
    // Overdrive: a system drawing past its rating wears itself out.
    for (const sys of SYSTEMS) if (f.delivered[sys] > 100) {
      const was = c.damage[sys];
      c.damage[sys] = Math.min(100, c.damage[sys] + (f.delivered[sys] - 100) * OVERDRIVE_DAMAGE);
      if (Math.floor(was / 10) !== Math.floor(c.damage[sys] / 10)) tellStations(k, ['Engineering'], `Engineering: ${SYSTEM_NAMES[sys]} overdriven (${Math.round(f.delivered[sys])}%), damage ${Math.ceil(c.damage[sys])}%`);
    }
    // Impulse drives: starting on bus power for their pumps, then self-sustaining.
    for (const d of DRIVES) {
      const dr = e.drives[d];
      if (dr.state === 'starting') {
        if (!f.subOk[`${d}Pump`]) { dr.state = 'off'; dr.start = 0; tellStations(k, ['Engineering'], `Engineering: ${d} impulse drive startup failed, no power to its deuterium pump`); }
        else if (++dr.start >= GRID.impulseStartSecs) { dr.state = 'running'; dr.start = 0; e.dirty = true; opLog(k, `${d} impulse drive running`); tellStations(k, ['Engineering'], `Engineering: ${d} impulse drive running`); }
      }
      if (dr.state !== 'off') e.deuterium = Math.max(0, e.deuterium - FUEL.impulseBurn);
      if (dr.state !== 'off' && (e.deuterium <= 0 || (c.damage[`${d}Pump`] || 0) >= SUB_FAIL_DAMAGE)) { dr.state = 'off'; e.dirty = true; tellStations(k, ['Engineering'], `Engineering: ${d} impulse drive shut down (${e.deuterium <= 0 ? 'out of deuterium' : 'deuterium pump damaged'})`); }
    }
    tripBreakers(k);
    // Batteries.
    e.battery.charge = Math.max(0, Math.min(GRID.batteryCap, e.battery.charge - f.batteryUsed + f.charging));
    // Fuel: the core burns antimatter and deuterium for what it gives, the impulse reactor deuterium.
    if (f.coreUsed > 0) { const burn = (f.coreUsed / GRID.core) * FUEL.coreBurn; e.antimatter = Math.max(0, e.antimatter - burn); e.deuterium = Math.max(0, e.deuterium - burn); }
    if ((e.core === 'online' || e.core === 'starting') && (e.antimatter <= 0 || e.deuterium <= 0)) {
      e.core = 'offline'; e.start = 0; e.dirty = true;
      opLog(k, `warp core shut down: out of ${e.antimatter <= 0 ? 'antimatter' : 'deuterium'}`);
      tellStations(k, ['Engineering', 'Captain'], `Engineering: warp core shut down, out of ${e.antimatter <= 0 ? 'antimatter' : 'deuterium'}`);
    }
    // Supplies moving: from or to a starbase, or to a ship docked with us.
    if (e.transfer) {
      const t = e.transfer, other = t.with === 'station' ? null : engOf(t.with);
      const stillDocked = t.with === 'station' ? !!e.docked : !!(portFor(k, t.with) && portFor(t.with, k));
      let n = Math.min(FUEL.transferRate, t.left);
      if (t.dir === 'in') n = Math.min(n, FUEL[t.resource] - e[t.resource]);
      else n = Math.min(n, e[t.resource], other ? FUEL[t.resource] - other[t.resource] : Infinity);
      // Within a unit of full (or empty) is done: a running core keeps
      // nibbling at a full tank, which would keep a transfer going forever.
      if (!stillDocked) { e.transfer = null; tellStations(k, ['Engineering'], 'Engineering: transfer stopped, no longer docked'); }
      else if (n < 1) { e.transfer = null; if (!t.auto) tellStations(k, ['Engineering'], `Engineering: ${t.resource} transfer done (${t.dir === 'in' || other ? 'tank full' : 'tank empty'})`); }
      else {
        e[t.resource] += t.dir === 'in' ? n : -n;
        if (other) { other[t.resource] += n; other.dirty = true; flowCache.delete(t.with); }
        t.left -= n;
        e.dirty = true;
        if (t.left <= 0) { e.transfer = null; if (!t.auto) tellStations(k, ['Engineering'], `Engineering: ${t.resource} transfer done`); }
      }
    }
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
    // A docking request not answered in time lapses.
    const req = dockRequests.get(k);
    if (req && now > req.until) { dockRequests.delete(k); for (const u of crewOf(req.from)) if (u.station === 'Helm') send(u, { type: 'notice', text: `Helm: the ${shipName(k)} didn't answer the docking request` }); }
    // Auto refuel: top off antimatter and deuterium while docked at a starbase.
    if (e.autoRefuel && e.docked && !e.transfer) {
      const want = ['deuterium', 'antimatter'].find((r) => FUEL[r] - e[r] >= 1 && (r !== 'antimatter' || (e.ties.containment.length && e.core !== 'ejected')));
      if (want) e.transfer = { resource: want, dir: 'in', left: FUEL[want] - e[want], with: 'station', auto: true };
    }
    if (e.docked) {
      const base = STARBASES.find((b) => b.name === e.docked);
      if (!base || nav.warp > 0 || Math.hypot(nav.x - base.x, nav.y - base.y) > DOCK_RANGE) { opLog(k, `departed ${e.docked}`); e.docked = null; e.dirty = true; }
    }

    const p = powerOf(k);
    if (c.shield < 100 && p.shields > 0) c.shield = Math.min(100, c.shield + (2 * p.shields) / 100);
    const fast = e.docked ? REPAIR.docked : 1;
    for (const s of DAMAGEABLE) if (c.damage[s] > 0 && !(f.delivered[s] > 100)) c.damage[s] = Math.max(0, c.damage[s] - (c.repair === s ? REPAIR.directed : REPAIR.auto) * fast);
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


// Station commands, from a console (or a console remote-controlling another vessel).
function stationCommand(ws, msg) {
  const t = msg.type;
  const gate = (fn) => { if (consoleDark(ws)) darkNote(ws); else fn(ws, msg); return true; };
  if (t === 'shields') return shieldsCommand(ws, msg), true;
  if (t === 'beam') return beamCommand(ws, msg), true;
  if (['helm', 'autopilot', 'scan', 'plot-course'].includes(t)) return gate(navCommand);
  if (t === 'power') return navCommand(ws, msg), true;
  if (t === 'order-ack' || t === 'order-decline') return crewCommand(ws, msg), true; // answering an order needs no console
  if (['alert', 'order', 'reassign', 'lockout', 'confine', 'sickbay', 'forcefield'].includes(t)) return gate(crewCommand);
  if (['lock', 'fire', 'repair', 'arm'].includes(t)) return gate(combatCommand);
  if (t === 'grid') return gridCommand(ws, msg), true; // emergency power: works with the console dark
  if (t === 'tractor') return gate(tractorCommand);
  if (t === 'dock') return gate(dockCommand);
  if (t === 'self-destruct') return gate(selfDestructCommand);
  return false;
}

// Remote control. Like controls like: a console can run the same station
// aboard another vessel over a working data link while that station there is
// unmanned (whoever else is aboard), unless that vessel's ops have blocked it.
function remoteOk(ws, t) {
  if (!t || t === ws.shipKey || !present(t) || !links.has(linkKey(ws.shipKey, t))) return false;
  if (ws.station === 'Crew') return false;
  if (crewOf(t).some((u) => u.station === ws.station)) return false; // manned there (ops included)
  if ([...users.values()].some((u) => u !== ws && u.controlling === t && u.station === ws.station)) return false; // someone else has it
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
function controlCommand(ws, msg) {
  const t = msg.ship ? shipKey(clean(msg.ship)) : null;
  if (!t || t === ws.shipKey) {
    if (ws.controlling) { opLog(ws.controlling, `${ws.name} (${ws.ship}) released remote control of ${ws.station}`); send(ws, { type: 'notice', text: `Remote control of the ${shipName(ws.controlling)} ended` }); }
    ws.controlling = null;
    if (ws.operator) broadcastOps(ws.shipKey);
  } else {
    if (!remoteOk(ws, t)) return send(ws, { type: 'notice', text: `Remote control: can't run the ${shipName(t)}'s ${ws.station} (needs a data link, the station unmanned there, and its ops not blocking)` });
    ws.controlling = t;
    if (ws.operator) broadcastOps(t);
    opLog(t, `${ws.name} of the ${ws.ship} took remote control of ${ws.station} over the data link`);
    send(ws, { type: 'notice', text: `Remote control: running the ${shipName(t)}'s ${ws.station}` });
  }
  scheduleNav();
}
// Consoles whose remote control no longer holds go back to their own ship.
function checkRemotes() {
  for (const u of users.values()) {
    if (!u.controlling || remoteOk(u, u.controlling)) continue;
    const t = u.controlling;
    const why = !links.has(linkKey(u.shipKey, t)) ? 'the data link dropped' : crewOf(t).some((x) => x.station === u.station) ? `someone took ${u.station} there` : engOf(t).remoteBlock ? 'its ops blocked remote control' : 'it is no longer available';
    u.controlling = null;
    send(u, { type: 'notice', text: `Remote control of the ${shipName(t)} ended: ${why}` });
    if (u.operator) broadcastOps(u.shipKey);
  }
}

// Tactical raises or lowers the ship's shields.
function shieldsCommand(ws, msg) {
  if (ws.station !== 'Tactical') return send(ws, { type: 'notice', text: 'Only Tactical can raise or lower shields' });
  if (consoleDark(ws)) return darkNote(ws);
  if (msg.up && powerOf(ws.shipKey).shields < MIN_SHIELD_POWER) return send(ws, { type: 'notice', text: `Tactical: not enough power to raise shields (needs ${MIN_SHIELD_POWER}%; ask Engineering)` });
  if (msg.up && combatOf(ws.shipKey).shield < MIN_SHIELD_STRENGTH) return send(ws, { type: 'notice', text: `Tactical: the shield generators are recharging (${Math.floor(combatOf(ws.shipKey).shield)}%; they hold from ${MIN_SHIELD_STRENGTH}%)` });
  if (msg.up) shields.add(ws.shipKey); else shields.delete(ws.shipKey);
  opLog(ws.shipKey, `${ws.name}: shields ${msg.up ? 'up' : 'down'}`);
  broadcastShips();
  return;
}

// The transporter beams someone aboard this ship to another ship (or within it).
function beamCommand(ws, msg) {
  const fail = (text) => send(ws, { type: 'notice', text: `Transporter: ${text}` });
  if (ws.station !== 'Transporter') return fail('only the transporter room can beam people');
  if (consoleDark(ws)) return fail('console offline, no power on its bus');
  const u = typeof msg.who === 'string' && users.get(msg.who);
  const toKey = shipKey(clean(msg.ship));
  if (!u || u.shipKey !== ws.shipKey) return fail('that person is not aboard');
  if (u.operator) return fail('the ops station cannot be beamed');
  const station = msg.station == null ? null : STATIONS.includes(msg.station) && msg.station !== 'Operations' ? msg.station : undefined;
  if (station === undefined) return fail('no such station to beam to');
  if (toKey === ws.shipKey) {
    // Site to site, within the ship: inside our own shields and lockout.
    if (!station || station === u.station) return fail(`${u.name} is already at ${u.station}: pick another station`);
    if (powerOf(ws.shipKey).transporter <= 0) return fail('no power to the transporter: ask Engineering');
    if (u !== ws) send(u, { type: 'notice', text: `You are being beamed to ${station}` });
    beam(u, toKey, station);
    if (u !== ws) send(ws, { type: 'notice', text: `Transporter: ${u.name} beamed to ${station}` });
    return;
  }
  if (powerOf(ws.shipKey).transporter <= 0) return fail('no power to the transporter: ask Engineering');
  if (toKey !== ws.shipKey && present(toKey) && !transporterOk(ws.shipKey, toKey)) return fail(`the ${shipName(toKey)} is out of transporter range (${rangeText(ws.shipKey, toKey)}; get within ${Math.round(rangesOf(ws.shipKey).transporter)})`);
  if (!present(toKey)) return fail(`the ${clean(msg.ship)} has no ship's computer online`);
  for (const k of [ws.shipKey, toKey]) if (shields.has(k)) return fail(`cannot beam through the shields of the ${shipName(k)}`);
  if (lockoutOf(toKey)) return fail(`the ${shipName(toKey)} has a transporter lockout: Security's force field is up`);
  if (users.has(userId(u.name, shipName(toKey)))) return fail(`someone called ${u.name} is already aboard the ${shipName(toKey)}`);
  if (u !== ws) send(u, { type: 'notice', text: `You are being beamed to the ${shipName(toKey)}` });
  beam(u, toKey, station);
  if (u !== ws) send(ws, { type: 'notice', text: `Transporter: ${u.name} beamed to the ${shipName(toKey)}${station ? `'s ${station}` : ''}` });
  return;
}

// POST   /api/library            upload to your own ship (X-Token, X-Filename)
// GET    /api/library/<ship>/<f> download, from any ship on your data network
// DELETE /api/library/<ship>/<f> ops or Communications, own ship only
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
      // Force fields: nobody walks out of an isolated station, or into one (aboard here or across a dock).
      const target = msg.ship ? shipKey(clean(msg.ship)) : ws.shipKey;
      if (!ws.operator && sealed(ws.shipKey, ws.station)) return send(ws, { type: 'station-failed', reason: `a Security force field isolates ${ws.station}: nobody walks out (the transporter can beam you)` });
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
      const reach = to.filter((u) => sameNetwork(ws.shipKey, u.shipKey));
      const down = (u) => (u.shipKey === ws.shipKey ? !commsUp(ws.shipKey, 'rf') : !commsUp(ws.shipKey, 'radio') || !commsUp(u.shipKey, 'radio'));
      const sent = reach.filter((u) => !down(u));
      const failed = to.filter((u) => !sent.includes(u));
      if (failed.length) send(ws, { type: 'notice', text: `Communications: no message to ${failed.map((u) => u.name).join(', ')} (${failed.some((u) => !reach.includes(u)) ? 'not on our comm net' : 'no power to local RF or radio'})` });
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

  // The relay's own station list, so pages only offer stations it accepts
  // (and can tell when the relay is older than the pages).
  send(ws, { type: 'hello', relay: RELAY_NAME, stations: STATIONS, opsKey: !!OPERATOR_KEY, version: require('./package.json').version });
  send(ws, { type: 'ships', ships: shipList() });
});

server.listen(PORT, () => console.log(`${RELAY_NAME} on http://localhost:${PORT}`));
module.exports = server;
