#!/usr/bin/env node
// Runs the relay and the ship's computers, and restarts them when the code
// changes: 5 seconds after the last change to server.js, tools/*.js or
// data/*.json (a burst of saves is one restart), the relay tells every
// console to reload (they rejoin as who and where they were), then the relay
// and the computers start again. A change to public/* only reloads the
// consoles. Ship state survives in each ship's .nav.json, as always.
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
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[supervisor]', ...a);

// Which ships: named on the command line, or one per folder of saved ships.
const ships = () => {
  const named = process.argv.slice(2);
  if (named.length) return named;
  try { return fs.readdirSync(DATA, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
};

let relay = null;
let computers = [];
const env = { ...process.env, PORT };

// A relay that dies right after starting (its port taken, say) is started
// again a couple of times, then the supervisor gives up, rather than looping.
const QUICK_FAIL_MS = 10000, MAX_FAILS = 3;
let fails = 0;
function start() {
  const startedAt = Date.now();
  relay = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
  relay.on('exit', (code, sig) => {
    if (stopping) return;
    log(`relay exited (${sig || code})`);
    if (Date.now() - startedAt > QUICK_FAIL_MS) { fails = 0; return; }
    if (++fails >= MAX_FAILS) {
      log(`the relay failed to start ${fails} times in a row: is port ${PORT} already in use? (PORT=${PORT}${process.env.PORT ? ', from the environment' : ', the default'}) Stopping.`);
      stop().then(() => process.exit(1));
      return;
    }
    log(`starting it again (${fails} of ${MAX_FAILS} tries)`);
    setTimeout(() => { stop().then(start); }, 2000);
  });
  // The computers connect once the relay listens (they retry by themselves anyway).
  setTimeout(() => {
    computers = ships().map((ship) => spawn(process.execPath, [path.join(ROOT, 'tools', 'shipcore.js'), '--relay', `ws://localhost:${PORT}`, '--data', DATA, ship], { cwd: ROOT, env, stdio: 'inherit' }));
    log(`relay on port ${PORT}; ship's computers: ${ships().join(', ') || 'none'}`);
  }, 500);
}

let stopping = false;
function stop() {
  stopping = true;
  const all = [relay, ...computers].filter((p) => p && p.exitCode === null && p.signalCode === null);
  return Promise.all(all.map((p) => new Promise((r) => { p.once('exit', r); p.kill(); }))).then(() => { stopping = false; });
}

// Changes, debounced: a burst of saves is one restart (or one reload).
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
  const onlyPages = files.every((f) => f.split(path.sep).includes('public'));
  log(`${files.length} file(s) changed: ${onlyPages ? 'reloading the consoles' : 'restarting'}`);
  if (relay?.connected) relay.send({ type: 'reload', restart: !onlyPages });
  if (onlyPages) return;
  await new Promise((r) => setTimeout(r, 500)); // the consoles get the word first
  await stop();
  start();
}

for (const target of WATCH) {
  try {
    const dir = fs.statSync(target).isDirectory();
    fs.watch(target, { recursive: dir }, (event, name) => onChange(dir ? path.join(target, name || '') : target));
  } catch (err) { log(`not watching ${target}: ${err.message}`); }
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop().then(() => process.exit(0)));
start();
