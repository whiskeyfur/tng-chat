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
    assert.deepEqual(g.ties.battery, ['A'], 'batteries tie to one bus');
    assert.deepEqual(g.ties.containment, ['A'], 'containment no longer takes the EPS');
    assert.deepEqual(g.ties['system:transporter'], ['B'], 'the transporter no longer takes the EPS');
    assert.deepEqual(g.ties['console:Helm'], ['A', 'B'], 'a console may share two buses');
    assert.deepEqual(g.ties['sub:portThrusters'], [], 'thrusters that were off stay untied');
    assert.deepEqual(g.ties.dock, ['A']);
    step('an older save came through: taps, crosslink, single-bus sources, EPS ties moved to their bus, thrusters off');

    await wait(5500); // the relay hands the computer a copy every 5 s
    await stop(r); r = relay(); await wait(4000);
    assert.equal((await look()).docked, 'Starbase 47');
    step('still docked at Starbase 47 after the relay restarted');

    await stop(c); c = computer(); await wait(4000);
    assert.equal((await look()).docked, 'Starbase 47');
    step("still docked at Starbase 47 after the ship's computer restarted");
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
