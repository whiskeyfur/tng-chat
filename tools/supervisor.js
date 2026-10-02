#!/usr/bin/env node
// Runs the relay (in its own process) and the ship's computers (in this one),
// and keeps them up to date with the code: 5 seconds after the last change
// (a burst of saves is one change),
//  - to server.js or data/*.json: every console is told to reload, the relay
//    restarts, and the consoles sign back in; the ship's computers reconnect;
//  - to tools/shipcore.js: the ship's computers reload here, in this process;
//  - to public/*: the consoles reload.
// Ship state survives in each ship's .nav.json, as always. A change to this
// file needs `npm start` again.
//
// It also answers the relay's admin requests (the admin panel: shift-click
// the relay's name at the foot of any console): what it runs, a recent log,
// and restarting a ship's computer, all of them, or the relay.
// TODO: the admin panel has no access control yet (fine on localhost); add it before this goes live.
//
//   node tools/supervisor.js                 (npm start: a computer per folder in shipcore-data/)
//   node tools/supervisor.js Enterprise Cole (just these ships)
//
// Environment: PORT (8085), SHIPCORE_DATA (./shipcore-data), OPERATOR_KEY (passed on),
// SUPERVISE_DELAY (ms, 5000), SUPERVISE_WATCH (paths to watch instead of the defaults).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || '8085';
const DATA = path.resolve(process.env.SHIPCORE_DATA || 'shipcore-data');
const DELAY = Number(process.env.SUPERVISE_DELAY) || 5000;
const WATCH = process.env.SUPERVISE_WATCH ? process.env.SUPERVISE_WATCH.split(path.delimiter) : ['server.js', 'tools', 'data', 'public'].map((p) => path.join(ROOT, p));
// Files the relay writes itself: changing them mustn't restart it.
const IGNORE = [path.join(ROOT, 'data', 'starbases.json')];
const SHIPCORE = path.join(__dirname, 'shipcore.js');
const RELAY_URL = `ws://localhost:${PORT}`;

// A recent log, for the admin panel.
const recent = [];
const log = (...a) => {
  const line = `${new Date().toISOString().slice(11, 19)} [supervisor] ${a.join(' ')}`;
  console.log(line);
  recent.push(line); recent.splice(0, Math.max(0, recent.length - 200));
};

// Which ships: named on the command line, or one per folder of saved ships.
const ships = () => {
  const named = process.argv.slice(2);
  if (named.length) return named;
  try { return fs.readdirSync(DATA, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
};

// --- the ship's computers, here in this process -------------------------------------
const computers = new Map(); // ship -> { core, since }
const loadShipcore = () => { delete require.cache[require.resolve(SHIPCORE)]; return require(SHIPCORE); };
let shipcoreModule = null;
function startComputer(ship) {
  stopComputer(ship);
  shipcoreModule ||= loadShipcore();
  const shipLog = (...a) => { const line = `${new Date().toISOString().slice(11, 19)} [${ship}] ${a.join(' ')}`; console.log(line); recent.push(line); recent.splice(0, Math.max(0, recent.length - 200)); };
  const core = shipcoreModule.createShipcore({ relay: RELAY_URL, data: DATA, key: process.env.OPERATOR_KEY || '', ships: [ship] }, { log: shipLog, onFail: (why) => log(`the ship's computer for ${ship} was refused: ${why}`) });
  computers.set(ship, { core, since: Date.now() });
}
function stopComputer(ship) { const c = computers.get(ship); if (c) { c.core.stop(); computers.delete(ship); } }
function startComputers() { for (const s of ships()) startComputer(s); log(`ship's computers: ${[...computers.keys()].join(', ') || 'none'}`); }
function stopComputers() { for (const s of [...computers.keys()]) stopComputer(s); }
// The ship's computers' code changed: load it again and restart them.
function reloadComputers() { stopComputers(); shipcoreModule = loadShipcore(); startComputers(); }

// --- the relay, in its own process ----------------------------------------------------
// A relay that dies right after starting (its port taken, say) is started
// again a couple of times, then the supervisor gives up, rather than looping.
const QUICK_FAIL_MS = 10000, MAX_FAILS = 3;
let relay = null, relaySince = 0, fails = 0, stopping = false;
const env = { ...process.env, PORT };
function startRelay() {
  const startedAt = Date.now();
  relaySince = startedAt;
  relay = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['inherit', 'inherit', 'pipe', 'ipc'] });
  // Its errors still go to the terminal; a port in use is noted for the give-up message.
  let portInUse = false;
  relay.stderr.on('data', (b) => { process.stderr.write(b); if (/EADDRINUSE/.test(b)) portInUse = true; });
  relay.on('message', onRelayMessage);
  relay.on('exit', (code, sig) => {
    if (stopping) return;
    log(`relay exited (${sig || code})`);
    if (Date.now() - startedAt > QUICK_FAIL_MS) { fails = 0; return; }
    if (++fails >= MAX_FAILS) {
      log(portInUse ? `the relay failed to start ${fails} times in a row: port ${PORT} is already in use (PORT=${PORT}${process.env.PORT ? ', from the environment' : ', the default'}). Stopping.` : `the relay crashed ${fails} times in a row (see the error above). Stopping.`);
      shutdown(1);
      return;
    }
    log(`starting it again (${fails} of ${MAX_FAILS} tries)`);
    setTimeout(() => { stopRelay().then(startRelay); }, 2000);
  });
  log(`relay on port ${PORT}`);
}
function stopRelay() {
  const r = relay;
  if (!r || r.exitCode !== null || r.signalCode !== null) return Promise.resolve();
  stopping = true;
  return new Promise((res) => { r.once('exit', res); r.kill(); }).then(() => { stopping = false; });
}
// Restart the relay: the consoles get the word first.
async function restartRelay() {
  if (relay?.connected) relay.send({ type: 'reload', restart: true });
  await new Promise((r) => setTimeout(r, 500));
  await stopRelay();
  startRelay();
}

// --- the admin panel's requests, through the relay ---------------------------------------
const status = () => ({
  relay: { up: !!relay && relay.exitCode === null && relay.signalCode === null, port: PORT, since: relaySince, pid: relay?.pid },
  ships: [...computers].map(([ship, c]) => ({ ship, since: c.since, ...c.core.status() })),
  log: recent.slice(-60),
});
async function onRelayMessage(m) {
  if (m?.type !== 'admin') return;
  const reply = (extra = {}) => { if (relay?.connected) relay.send({ type: 'admin-reply', reqId: m.reqId, status: status(), ...extra }); };
  if (m.action === 'restart-ship' && computers.has(m.ship)) { log(`admin: restarting the ship's computer for ${m.ship}`); startComputer(m.ship); }
  else if (m.action === 'restart-ships') { log("admin: restarting every ship's computer"); stopComputers(); startComputers(); }
  else if (m.action === 'restart-relay') { log('admin: restarting the relay'); reply({ note: 'restarting the relay' }); restartRelay(); return; }
  reply();
}

// --- changes, debounced ---------------------------------------------------------------------
let timer = null;
const changed = new Set();
function onChange(file) {
  if (!file || IGNORE.includes(file) || /(^|[/\\])\.|~$|\.swp$/.test(path.basename(file))) return;
  changed.add(file);
  clearTimeout(timer);
  timer = setTimeout(apply, DELAY);
}
async function apply() {
  const files = [...changed];
  changed.clear();
  const kind = (f) => (f.split(path.sep).includes('public') ? 'pages' : path.basename(f) === 'shipcore.js' ? 'computers' : path.basename(f) === 'supervisor.js' ? 'self' : 'relay');
  const kinds = new Set(files.map(kind));
  log(`${files.length} file(s) changed: ${[...kinds].join(', ')}`);
  if (kinds.has('self')) log('the supervisor itself changed: run npm start again to use the new one');
  if (kinds.has('computers')) { log("reloading the ship's computers"); reloadComputers(); }
  if (kinds.has('relay')) { log('restarting the relay'); await restartRelay(); }
  else if (kinds.has('pages') && relay?.connected) relay.send({ type: 'reload', restart: false });
}

for (const target of WATCH) {
  try {
    const dir = fs.statSync(target).isDirectory();
    fs.watch(target, { recursive: dir }, (event, name) => onChange(dir ? path.join(target, name || '') : target));
  } catch (err) { log(`not watching ${target}: ${err.message}`); }
}

function shutdown(code = 0) { stopComputers(); stopRelay().then(() => process.exit(code)); }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));
startRelay();
// The computers connect once the relay listens (they retry by themselves anyway).
setTimeout(startComputers, 500);
