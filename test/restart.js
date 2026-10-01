// Restarts: the relay and a ship's computer each restart while a ship is
// docked, and the ship stays docked. The ship starts from a save in older
// shapes (single-bus ties, open/closed taps, the A-B crosslink, thrusters on
// or off, EPS ties that are no longer allowed), which have to come through.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 8099) + 2;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-restart-'));
const ROOT = path.join(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`ok - ${s}`);
const procs = new Set();
const run = (args, env = {}) => { const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, PORT, ...env }, stdio: 'ignore' }); procs.add(p); p.on('exit', () => procs.delete(p)); return p; };
const stop = (p) => new Promise((r) => { p.once('exit', r); p.kill(); });
const relay = () => run(['server.js']);
const computer = () => run(['tools/shipcore.js', '--relay', `ws://localhost:${PORT}`, '--data', DATA, 'Oldship']);

// A save from before the power grid rework.
fs.mkdirSync(path.join(DATA, 'Oldship'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'Oldship', '.nav.json'), JSON.stringify({
  x: 498.5, y: 117.5, heading: 0, warp: 0, dest: null,
  power: { engines: 80, shields: 60, sensors: 100, transporter: 60, weapons: 50, lifeSupport: 100 },
  combat: { hull: 100, shield: 100, damage: { busB: 50 }, torpedoes: 10 },
  eng: {
    core: 'online', antimatter: 900, deuterium: 1800, docked: 'Starbase 47', battery: { charge: 3000 },
    taps: { A: true, B: false }, crosslink: true, thrusters: { port: false },
    ties: { battery: ['A', 'B'], containment: ['EPS'], dock: 'A', solar: ['A'], core: ['EPS'], 'system:transporter': ['EPS'], 'console:Helm': ['A', 'B'] },
  },
}));

async function look() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const msgs = [];
  ws.on('message', (m) => msgs.push(JSON.parse(m)));
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.send(JSON.stringify({ type: 'register', name: `eng${Date.now() % 100000}`, ship: 'Oldship', station: 'Engineering' }));
  const end = Date.now() + 10000;
  while (Date.now() < end) { const n = [...msgs].reverse().find((m) => m.type === 'nav' && m.own?.grid); if (n) { ws.close(); return n.own.grid; } await wait(100); }
  ws.close();
  throw new Error('no nav from the relay');
}

(async () => {
  let ok = false, r, c;
  try {
    r = relay(); await wait(800);
    c = computer(); await wait(2500);
    const g = await look();
    assert.equal(g.docked, 'Starbase 47');
    assert.deepEqual(g.taps, { A: 300, B: 0, C: 0 });
    assert.deepEqual(g.ties.crosslink, ['A', 'B']);
    assert.deepEqual(g.ties.battery, ['A', 'B'], 'batteries may share two buses');
    assert.deepEqual(g.ties.containment, ['A'], 'containment no longer takes the EPS');
    assert.deepEqual(g.ties['system:transporter'], ['B'], 'the transporter no longer takes the EPS');
    assert.deepEqual(g.ties['console:Helm'], ['A', 'B'], 'a console may share two buses');
    assert.deepEqual(g.ties.thrustersPort, [], 'thrusters that were off stay untied');
    assert.deepEqual(g.ties.thrustersStarboard, ['EPS'], 'thrusters otherwise tied in');
    assert.deepEqual(g.ties.dock, ['A']);
    step('an older save came through: taps, crosslink, batteries on two buses, EPS ties moved to their bus, thrusters off');
    // (it's been repairing itself since it signed on)
    assert.ok(g.totals.B.condition >= 50 && g.totals.B.condition < 70, `Bus B condition ${g.totals.B.condition}`);
    assert.ok(Math.abs(g.totals.B.max - 3 * g.totals.B.condition) <= 3, 'a damaged bus carries its condition share of its max');
    assert.equal(g.totals.A.max, 300);
    step(`a damaged Bus B (saved at 50%, now ${g.totals.B.condition}%) carries ${g.totals.B.max} of its 300`);

    await wait(5500); // the relay hands the computer a copy every 5 s
    await stop(r); r = relay(); await wait(4000);
    assert.equal((await look()).docked, 'Starbase 47');
    step('still docked at Starbase 47 after the relay restarted');

    await stop(c); c = computer(); await wait(4000);
    assert.equal((await look()).docked, 'Starbase 47');
    step("still docked at Starbase 47 after the ship's computer restarted");

    // The supervisor (npm start): a code change restarts the relay and the
    // computers 1 s after (5 s normally), telling the consoles to reload first;
    // a change to the pages only reloads them.
    await stop(c); await stop(r);
    const WATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-watch-'));
    fs.mkdirSync(path.join(WATCH, 'public'));
    const sup = run(['tools/supervisor.js'], { SHIPCORE_DATA: DATA, SUPERVISE_DELAY: '800', SUPERVISE_WATCH: [path.join(WATCH, 'code'), path.join(WATCH, 'public')].join(path.delimiter) });
    fs.mkdirSync(path.join(WATCH, 'code'));
    await wait(3500);
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const got = [];
    ws.on('message', (m) => got.push(JSON.parse(m)));
    await new Promise((res) => ws.on('open', res));
    ws.send(JSON.stringify({ type: 'register', name: 'kim', ship: 'Oldship', station: 'Helm' }));
    await wait(800);
    fs.writeFileSync(path.join(WATCH, 'public', 'page.js'), '// changed');
    const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await wait(100); } throw new Error('timed out'); };
    await until(() => got.some((m) => m.type === 'reload' && m.restart === false));
    assert.equal(ws.readyState, WebSocket.OPEN, 'a page change should not restart the relay');
    step('the supervisor: a change to the pages told the consoles to reload, without restarting the relay');
    const closed = new Promise((res) => ws.on('close', res));
    fs.writeFileSync(path.join(WATCH, 'code', 'server.js'), '// changed');
    await until(() => got.some((m) => m.type === 'reload' && m.restart === true));
    await closed;
    await wait(4000);
    assert.equal((await look()).docked, 'Starbase 47');
    step('a code change: the consoles were told to reload, the relay and the ship\'s computer restarted, and the ship was still docked');
    procs.add(sup);
    await stop(sup);
    fs.rmSync(WATCH, { recursive: true, force: true });
    ok = true;
  } catch (err) {
    console.error('FAIL:', err.message);
  } finally {
    for (const p of procs) p.kill();
    fs.rmSync(DATA, { recursive: true, force: true });
    console.log(ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
  }
})();
