// Corridors (the path tracer's): every class's generated layout is valid and changes nothing while
// every link is as it comes (the same power as without corridors); a cut branch leaves its place
// without power, and closing the backup crawlway brings it back. In play (the graph engine on the path
// tracer), Engineering opens a runabout's cockpit branch: the Corridors view says the Cockpit is cut
// off and which link would bring it back; closing that link does; with Rerouting automated, the relay
// closes it by itself. The ties are saved with the ship.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const GRAPH = require('../tools/ship-graph');
const SOLVER = require('../tools/graph-solver');
const PATH = require('../tools/path-solver');
const CONFIG = require('../tools/config');
require('../tools/store').filesOnly();

const step = (s) => console.log(`ok - ${s}`);
const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
let ok = false;
const procs = [];
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-corr-'));
(async () => {
  try {
    const d = GRAPH.dump({ scenarios: true }), t = d.tables, { classes } = CONFIG.files.loadShips(() => {});
    for (const id of Object.keys(d.scenarios)) {
      const g = GRAPH.convert(id, classes[id], d), flat = { ...g };
      delete flat.layout;
      assert.deepEqual(GRAPH.check(g), [], `${id}: its layout valid`);
      for (const [name, sc] of Object.entries(d.scenarios[id])) {
        const rt = SOLVER.fromRelay(g, sc.state, t), a = PATH.solve(flat, rt), b = PATH.solve(g, rt);
        for (const k of Object.keys(a.got)) assert.ok(Math.abs(a.got[k] - (b.got[k] || 0)) < 1e-6, `${id}/${name}: ${k} the same with corridors (${a.got[k]} / ${b.got[k]})`);
      }
    }
    step(`every class's corridors as they come: the same power to every load as without them, in all ${Object.values(d.scenarios).reduce((n, x) => n + Object.keys(x).length, 0)} states`);
    // (A runabout warm: its cockpit's branch cut, then the crawlway closed.)
    const g = GRAPH.convert('runabout', classes.runabout, d), { all } = GRAPH.nodes(g), sc = d.scenarios.runabout.warm;
    const inCockpit = Object.keys(all).filter((x) => all[x].place === 'place-cockpit');
    const base = SOLVER.fromRelay(g, sc.state, t);
    const cut = PATH.solve(g, { ...base, linkOn: (id, n) => (id === 'branch-cockpit' ? false : base.linkOn(id, n)) });
    const fixed = PATH.solve(g, { ...base, linkOn: (id, n) => (id === 'branch-cockpit' ? false : id === 'crawlway-cockpit' ? true : base.linkOn(id, n)) });
    const whole = PATH.solve(g, base);
    const cockpit = (r) => sum(Object.fromEntries(inCockpit.filter((x) => r.got[x] !== undefined).map((x) => [x, r.got[x]])));
    assert.ok(cockpit(whole) > 0 && cockpit(cut) === 0 && Math.abs(cockpit(fixed) - cockpit(whole)) < 1e-6, `the cockpit: ${cockpit(whole)} as it comes, ${cockpit(cut)} cut, ${cockpit(fixed)} by the crawlway`);
    assert.ok(!cut.reach['bus-a'].includes('place-cockpit') && fixed.reach['bus-a'].includes('place-cockpit'));
    step(`a runabout's cockpit branch cut: the cockpit gets nothing (${cockpit(whole)} as it comes); the crawlway closed, it all comes back`);

    // In play.
    const PORT = Number(process.env.PORT || 8099) + 17;
    const env = { ...process.env, PORT, RELAY_DATA: DATA, STARBASES_FILE: path.join(DATA, 'starbases.json') };
    fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ port: PORT, engine: 'graph', solver: 'path' }));
    const run = (args) => { const p = spawn(process.execPath, args, { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' }); procs.push(p); return p; };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    run(['server.js']); await wait(1200);
    run(['tools/shipcore.js', '--relay', `ws://localhost:${PORT}`, '--data', DATA, '--warm', '--class', 'runabout', 'Tubeship']); await wait(2500);
    const ws = new WebSocket(`ws://localhost:${PORT}`), msgs = [];
    ws.on('message', (m) => msgs.push(JSON.parse(m)));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'register', name: 'chief', ship: 'Tubeship', station: 'Engineering' }));
    let since = 0;
    const send = (m) => { since = msgs.length; ws.send(JSON.stringify(m)); };
    const corr = async (pred, what) => { for (let i = 0; i < 100; i++) { const c = msgs.slice(since).reverse().find((m) => m.type === 'nav' && m.own?.grid?.corridors)?.own.grid.corridors; if (c && pred(c)) return c; await wait(150); } throw new Error(`timed out: ${what}`); };
    await corr((c) => c.cutOff.length === 0 && c.links.length === 7, 'the corridors, nothing cut off');
    send({ type: 'grid', link: { id: 'branch-cockpit', bus: 'all', closed: false } });
    const off = await corr((c) => c.cutOff.some((x) => x.placeId === 'place-cockpit'), 'the cockpit cut off');
    const x = off.cutOff.find((y) => y.placeId === 'place-cockpit');
    assert.deepEqual(x.fix, ['Crawlway to Cockpit'], `the way back: ${x.fix}`);
    send({ type: 'grid', link: { id: 'crawlway-cockpit', bus: 'all', closed: true } });
    await corr((c) => c.cutOff.length === 0, 'the cockpit back by the crawlway');
    step('in play: Engineering opens the cockpit\'s branch; the Corridors view says the Cockpit is cut off and that the crawlway would bring it back; closing it does');
    send({ type: 'grid', link: { id: 'crawlway-cockpit', bus: 'all', closed: false } });
    await corr((c) => c.cutOff.some((y) => y.placeId === 'place-cockpit'), 'cut off again');
    send({ type: 'automation', panel: 'rerouting', on: true });
    await corr((c) => c.cutOff.length === 0 && c.links.find((l) => l.id === 'crawlway-cockpit').closed.A, 'rerouted by automation', 20000);
    let saved = null;
    for (let i = 0; i < 40 && saved?.eng?.corridorTies?.['branch-cockpit']?.A !== false; i++) { await wait(500); saved = JSON.parse(fs.readFileSync(path.join(DATA, 'Tubeship', '.nav.json'), 'utf8')); }
    assert.equal(saved.eng?.corridorTies?.['branch-cockpit']?.A, false, `the ties saved with the ship (${JSON.stringify(saved.eng?.corridorTies)})`);
    step('with Rerouting automated, the relay closes the crawlway by itself; the corridor ties are saved with the ship');
    ws.close();
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
