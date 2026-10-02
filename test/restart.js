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
process.env.STARBASES_FILE = path.join(DATA, 'starbases.json'); // (the starbases' state: never the live file)
process.env.RELAY_DATA = DATA; // (accounts and settings too)
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
    assert.ok(['A', 'B', 'C'].every((n) => g.stores[n].level >= 90 && g.stores[n].breaker), `the old battery shared across Battery A, B and C, in service (${JSON.stringify(g.stores)})`);
    assert.deepEqual(g.ties.containment, ['A'], 'containment no longer takes the EPS');
    assert.deepEqual(g.ties['system:transporter'], ['B'], 'the transporter no longer takes the EPS');
    assert.deepEqual(g.ties['console:Helm'], ['A', 'B'], 'a console may share two buses');
    assert.deepEqual(g.ties.thrustersPort, [], 'thrusters that were off stay untied');
    assert.deepEqual(g.ties.thrustersStarboard, ['EPS'], 'thrusters otherwise tied in');
    assert.deepEqual(g.ties.dock, ['B'], 'dock power (saved on Bus A) moves to Bus B, its only bus');
    assert.deepEqual(g.ties.solar, ['B'], 'solar is wired to Bus B');
    step('an older save came through: taps, crosslink, batteries on two buses, EPS ties moved to their bus, thrusters off');
    // (it's been repairing itself since it signed on)
    assert.ok(g.totals.B.condition >= 50 && g.totals.B.condition < 70, `Bus B condition ${g.totals.B.condition}`);
    assert.ok(Math.abs(g.totals.B.max - 3 * g.totals.B.condition) <= 3, 'a damaged bus carries its condition share of its max');
    assert.equal(g.totals.A.max, 300);
    // A save from before power paths: its places and life support tied where its loads are (nothing cut off).
    assert.deepEqual(g.cutOff, {}, `an older save: nothing cut off (${JSON.stringify(g.cutOff)})`);
    assert.ok(g.ties['place:Bridge'].includes('A') && g.ties['place:Main Engineering'].length, 'its conduits tied where its loads are');
    step('an older save from before power paths: its places tied where their loads are, nothing cut off');
    step(`a damaged Bus B (saved at 50%, now ${g.totals.B.condition}%) carries ${g.totals.B.max} of its 300`);

    // A data link with Starbase 12 (it accepts by itself), to see it come back after the restart.
    const opsWs = async () => { const w = new WebSocket(`ws://localhost:${PORT}`); const m = []; w.on('message', (x) => m.push(JSON.parse(x))); await new Promise((res) => w.on('open', res)); w.send(JSON.stringify({ type: 'operator', name: `ops${Date.now() % 1000}`, ship: 'Oldship' })); return { w, m, net: () => [...m].reverse().find((x) => x.type === 'roster')?.network || [] }; };
    const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await wait(100); } throw new Error('timed out'); };
    let o = await opsWs();
    await wait(500);
    o.w.send(JSON.stringify({ type: 'link-request', ship: 'Starbase 12' }));
    await waitFor(() => o.net().includes('Starbase 12'));
    o.w.close();
    await wait(5500); // the relay hands the computer a copy every 5 s
    await stop(r); r = relay(); await wait(4000);
    assert.equal((await look()).docked, 'Starbase 47');
    step('still docked at Starbase 47 after the relay restarted');
    o = await opsWs();
    await waitFor(() => o.net().includes('Starbase 12'), 10000);
    o.w.close();
    step('the data link with Starbase 12 came back after the relay restarted');

    await stop(c); c = computer(); await wait(4000);
    assert.equal((await look()).docked, 'Starbase 47');
    step("still docked at Starbase 47 after the ship's computer restarted");

    // The supervisor (npm start): a code change restarts the relay and the
    // computers 1 s after (5 s normally), telling the consoles to reload first;
    // a change to the pages only reloads them.
    await stop(c); await stop(r);
    const WATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-watch-'));
    fs.mkdirSync(path.join(WATCH, 'public'));
    // (And a single file watched on its own, as server.js is.)
    const LONE = path.join(WATCH, 'lone', 'public', 'lone.html');
    fs.mkdirSync(path.dirname(LONE), { recursive: true });
    fs.writeFileSync(LONE, 'one');
    const sup = run(['tools/supervisor.js'], { SHIPCORE_DATA: DATA, SUPERVISE_DELAY: '800', SUPERVISE_WATCH: [path.join(WATCH, 'code'), path.join(WATCH, 'public'), LONE].join(path.delimiter) });
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
    // A single watched file replaced (as git checkout does: a new file, renamed into place), twice:
    // both changes are noticed (a watcher on the old file would have gone deaf).
    for (const n of [1, 2]) {
      const before = got.filter((m) => m.type === 'reload').length;
      fs.writeFileSync(`${LONE}.tmp`, `version ${n}`); fs.renameSync(`${LONE}.tmp`, LONE);
      await until(() => got.filter((m) => m.type === 'reload').length > before);
    }
    step('a single watched file replaced twice (as a git checkout does): the supervisor noticed both');
    step('the supervisor: a change to the pages told the consoles to reload, without restarting the relay');
    // The admin panel's requests: what the supervisor runs, who's connected; restart a ship's computer.
    ws.send(JSON.stringify({ type: 'admin', action: 'status' }));
    await until(() => got.some((m) => m.type === 'admin-status' && m.relay?.up && m.ships?.some((x) => x.ship === 'Oldship' && x.connected) && m.consoles?.some((u) => u.name === 'kim')));
    const before = got.filter((m) => m.type === 'admin-status').pop().ships.find((x) => x.ship === 'Oldship').since;
    ws.send(JSON.stringify({ type: 'admin', action: 'restart-ship', ship: 'Oldship' }));
    await until(() => got.some((m) => m.type === 'admin-status' && m.ships?.find((x) => x.ship === 'Oldship')?.since > before));
    await until(() => got.filter((m) => m.type === 'admin-status').pop().log.some((l) => /restarting the ship's computer for Oldship/.test(l)));
    step("the admin panel: the supervisor reported the relay, the ship's computers and the consoles, and restarted Oldship's computer");
    // Create ship: the supervisor starts the new ship's computer at once (its class), docked where it was parked.
    ws.send(JSON.stringify({ type: 'admin', action: 'create', name: 'Newship', cls: 'runabout', at: 'Starbase 12' }));
    await until(() => got.some((m) => m.type === 'admin-created' && m.ok));
    ws.send(JSON.stringify({ type: 'admin', action: 'status' }));
    await until(() => { ws.send(JSON.stringify({ type: 'admin', action: 'status' })); return got.filter((m) => m.type === 'admin-status').pop()?.ships?.some((x) => x.ship === 'Newship' && x.connected); });
    await until(() => got.filter((m) => m.type === 'ships').pop()?.ships.some((x) => x.name === 'Newship' && x.class === 'Runabout'));
    step('the admin panel created the Newship (a runabout, parked at Starbase 12): the supervisor started its computer at once');
    // A change to the ship's computers' code reloads them here, in the supervisor (the relay stays up).
    fs.writeFileSync(path.join(WATCH, 'code', 'shipcore.js'), '// changed');
    await wait(1500);
    assert.equal(ws.readyState, WebSocket.OPEN, "a ship's computer change should not restart the relay");
    ws.send(JSON.stringify({ type: 'admin', action: 'status' }));
    await until(() => got.filter((m) => m.type === 'admin-status').pop()?.log.some((l) => /reloading the ship's computers/.test(l)));
    await wait(1500);
    assert.equal((await look()).docked, 'Starbase 47');
    step("a change to the ship's computers' code reloaded them in the supervisor; the relay stayed up and the ship stayed docked");
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
