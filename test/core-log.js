// The computer core's log: the ship's systems report to it (power lost, power restored), and so do
// the automation, Ops' log and the stations' notices; a console asks for the whole of it and gets
// each new entry as it comes; it's kept with the ship through a restart; and with no computer core
// online, nothing is recorded (it's counted as lost).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 8099) + 18;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-corelog-'));
const env = { ...process.env, PORT, RELAY_DATA: DATA, STARBASES_FILE: path.join(DATA, 'starbases.json') };
const procs = [];
const run = (args) => { const p = spawn(process.execPath, args, { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' }); procs.push(p); return p; };
const stop = (p) => new Promise((r) => { if (p.exitCode !== null) return r(); p.once('exit', r); p.kill(); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`ok - ${s}`);
async function connect(hello) {
  const ws = new WebSocket(`ws://localhost:${PORT}`), msgs = [];
  ws.on('message', (m) => msgs.push(JSON.parse(m)));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify(hello));
  const until = async (pred, what, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return; await wait(100); } throw new Error(`timed out: ${what}`); };
  const log = () => { const full = msgs.filter((m) => m.type === 'core-log'); const out = []; for (const m of full) { if (m.full) out.length = 0; out.push(...m.entries); } return out; };
  return { ws, msgs, until, log, send: (m) => ws.send(JSON.stringify(m)) };
}

let ok = false;
(async () => {
  try {
    fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ port: PORT, engine: 'graph', solver: 'path' }));
    let r = run(['server.js']); await wait(1200);
    let c = run(['tools/shipcore.js', '--relay', `ws://localhost:${PORT}`, '--data', DATA, '--warm', '--class', 'runabout', 'Logship']); await wait(2500);
    const chief = await connect({ type: 'register', name: 'chief', ship: 'Logship', station: 'Engineering' });
    await chief.until(() => chief.msgs.some((m) => m.type === 'nav' && m.own?.grid), 'aboard');
    chief.send({ type: 'core-log-get' });
    await chief.until(() => chief.msgs.some((m) => m.type === 'core-log' && m.full), 'the whole log on asking');
    // (The cockpit cut off: its systems report no power, then power restored.)
    chief.send({ type: 'grid', link: { id: 'branch-cockpit', bus: 'all', closed: false } });
    await chief.until(() => chief.log().some((x) => x.text === 'no power' && x.level === 'warn'), 'a system reporting no power');
    chief.send({ type: 'grid', link: { id: 'branch-cockpit', bus: 'all', closed: true } });
    await chief.until(() => chief.log().some((x) => x.text === 'power restored'), 'and power restored');
    const lost = chief.log().filter((x) => x.text === 'no power').map((x) => x.sys);
    // (Ops' log goes in too.)
    const ops = await connect({ type: 'operator', name: 'opsy', ship: 'Logship' });
    await wait(500);
    ops.send({ type: 'automation', panel: 'tactical', on: true });
    await chief.until(() => chief.log().some((x) => x.sys === 'Operations' && /Tactical on/.test(x.text)), 'Ops\' log in the core log');
    step(`the core log: the cockpit cut off, ${lost.join(', ')} reported no power, then power restored; Ops' log is in it; a console gets each entry as it comes`);
    // (Kept with the ship through a restart.)
    const count = chief.log().length;
    await wait(6000);
    await stop(c); await stop(r);
    r = run(['server.js']); await wait(1200);
    c = run(['tools/shipcore.js', '--relay', `ws://localhost:${PORT}`, '--data', DATA, 'Logship']); await wait(2500);
    const again = await connect({ type: 'register', name: 'chief2', ship: 'Logship', station: 'Engineering' });
    await again.until(() => again.msgs.some((m) => m.type === 'nav' && m.own), 'aboard again');
    again.send({ type: 'core-log-get' });
    await again.until(() => again.msgs.some((m) => m.type === 'core-log' && m.full && m.entries.some((x) => x.text === 'no power')), 'the log kept through the restart');
    step(`kept with the ship through a restart (${count} entries before it)`);
    // (No core online: not recorded, counted as lost.)
    // (Each core untied from its bus: it crashes without power.)
    again.send({ type: 'grid', ties: { 'sub:computer1': [], 'sub:computer2': [], 'sub:computer3': [] } });
    await again.until(() => { const g = [...again.msgs].reverse().find((m) => m.type === 'nav' && m.own?.grid)?.own.grid; return g && g.computers.every((x) => x.state !== 'online'); }, 'every computer core down');
    const before = again.log().length;
    const ops2 = await connect({ type: 'operator', name: 'opsy2', ship: 'Logship' });
    await wait(500);
    ops2.send({ type: 'automation', panel: 'science', on: true });
    await wait(1500);
    again.send({ type: 'core-log-get' });
    await again.until(() => [...again.msgs].reverse().find((m) => m.type === 'core-log' && m.full)?.lost > 0 || again.log().length > before, 'lost, or recorded');
    const last = [...again.msgs].reverse().find((m) => m.type === 'core-log' && m.full);
    assert.ok(last.lost > 0 && !again.log().some((x) => /Science on/.test(x.text)), `with the computer cores down, nothing recorded (${last.lost} lost)`);
    step(`with every computer core down, reports aren't recorded: ${last.lost} counted as lost`);
    ok = true;
  } catch (err) {
    console.error('FAIL:', err.stack || err.message);
  } finally {
    for (const p of procs) p.kill('SIGKILL');
    fs.rmSync(DATA, { recursive: true, force: true });
    console.log(ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
  }
})();
