// The designs in config/: every file loads; a bad one is skipped (with a log
// line naming the file and the field) and the rest still load; and a ship of
// each class comes up built from its file (its class, its buses' limits), with
// the starbases from the star chart.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const CONFIG = require('../tools/config');

const PORT = Number(process.env.PORT || 8099) + 3;
const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-config-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`ok - ${s}`);
const procs = new Set();
const run = (args, env = {}) => { const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, PORT, STARBASES_FILE: path.join(DATA, 'starbases.json'), RELAY_DATA: DATA, ...env }, stdio: process.env.DEBUG ? 'inherit' : 'ignore' }); procs.add(p); p.on('exit', () => procs.delete(p)); return p; };
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(100); } throw new Error('timed out'); };

(async () => {
  let ok = false;
  try {
    // Every file loads (nothing skipped).
    const said = [];
    const { classes, starbase } = CONFIG.loadShips((l) => said.push(l));
    const systems = CONFIG.loadSystems((l) => said.push(l));
    assert.deepEqual(said, [], 'every config file loads');
    const files = fs.readdirSync(path.join(CONFIG.DIR, 'ships')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    const relayFiles = files.filter((f) => JSON.parse(fs.readFileSync(path.join(CONFIG.DIR, 'ships', `${f}.json`), 'utf8')).kind === 'relay');
    assert.deepEqual([...Object.keys(classes), 'starbase', ...relayFiles].sort(), files.sort(), 'a class for each file in config/ships (and the starbases\' and the relays\' designs)');
    assert.ok(starbase && systems.sol, 'the starbases\' design and the Sol chart');
    step(`config: ${files.length} designs (${files.join(', ')}) and ${Object.keys(systems).length} star chart (${Object.keys(systems).join(', ')}) loaded`);

    // A bad file is skipped, named with its field; the others still load.
    const BAD = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-badconfig-'));
    fs.cpSync(CONFIG.DIR, BAD, { recursive: true });
    fs.writeFileSync(path.join(BAD, 'ships', 'broken.json'), JSON.stringify({ name: 'Broken', bus: 'lots' }));
    fs.writeFileSync(path.join(BAD, 'ships', 'garbled.json'), '{ not json');
    const out = require('child_process').execFileSync(process.execPath, ['-e', "const c=require('./tools/config'); const s=c.loadShips((l)=>console.log(l)); console.log(JSON.stringify(Object.keys(s.classes)))"], { cwd: ROOT, env: { ...process.env, CONFIG_DIR: BAD } }).toString();
    assert.match(out, /skipping config\/ships\/broken\.json: field "bus" is wrong/);
    assert.match(out, /skipping config\/ships\/garbled\.json: not valid JSON/);
    assert.deepEqual(JSON.parse(out.trim().split('\n').pop()).sort(), Object.keys(classes).sort(), 'the good files still load');
    fs.rmSync(BAD, { recursive: true, force: true });
    step('config: a bad file is skipped with a log line naming it and its field (or that it is not JSON); the rest load');

    // A ship of each class, from its file; the starbases from the chart.
    run(['server.js']);
    await wait(800);
    const ids = Object.keys(classes);
    for (const id of ids) run(['tools/shipcore.js', '--relay', `ws://localhost:${PORT}`, '--data', DATA, '--warm', '--position', '500,500', '--class', id, `Test ${id}`]);
    for (const id of ids) {
      const c = classes[id];
      const ws = new WebSocket(`ws://localhost:${PORT}`);
      const msgs = [];
      ws.on('message', (m) => msgs.push(JSON.parse(m)));
      await new Promise((r) => ws.on('open', r));
      await until(() => msgs.some((m) => m.type === 'ships' && m.ships.some((s) => s.name === `Test ${id}` && s.computer)));
      ws.send(JSON.stringify({ type: 'register', name: 'tester', ship: `Test ${id}`, station: 'Helm' }));
      const g = await until(() => [...msgs].reverse().find((m) => m.type === 'nav' && m.own?.grid)?.own);
      assert.equal(g.class, c.name, `the Test ${id} is ${c.name} class`);
      assert.deepEqual([g.grid.totals.A.max, g.grid.totals.EPS.max], [c.bus, c.eps], `the ${c.name}'s buses from its file`);
      const hello = msgs.find((m) => m.type === 'hello');
      assert.deepEqual(hello.designs[id].places, c.places, `the ${c.name}'s places from its file`);
      assert.deepEqual(hello.system.size, systems.sol.size);
      const list = [...msgs].reverse().find((m) => m.type === 'ships').ships;
      assert.equal(list.find((s) => s.name === `Test ${id}`).classId, id);
      for (const b of systems.sol.starbases) assert.ok(list.some((s) => s.name === b.name && s.starbase), `the chart's ${b.name}`);
      ws.close();
    }
    step(`config: a ship of each class (${ids.join(', ')}) came up built from its file (its class, its buses' limits, its places), with the chart's starbases`);
    // A second star system (a test file): its relay and Sol's link to each other.
    {
      const TWO = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-twosystems-'));
      fs.cpSync(CONFIG.DIR, TWO, { recursive: true });
      fs.writeFileSync(path.join(TWO, 'starsystem', 'alpha.json'), JSON.stringify({ name: 'Alpha Centauri', size: 1000, starbases: [{ name: 'Starbase 1', x: 300, y: 300 }], relay: { name: 'Alpha Subspace Relay', x: 500, y: 500 } }));
      const rp = run(['server.js'], { PORT: PORT + 10, CONFIG_DIR: TWO });
      await wait(1200);
      const ws2 = new WebSocket(`ws://localhost:${PORT + 10}`), m2 = [];
      ws2.on('message', (m) => m2.push(JSON.parse(m)));
      await new Promise((r) => ws2.on('open', r));
      ws2.send(JSON.stringify({ type: 'operator', name: 'two', ship: 'Starbase 47' }));
      await until(() => [...m2].reverse().find((x) => x.type === 'roster')?.graph?.links.some((l) => l.includes('Sol Subspace Relay') && l.includes('Alpha Subspace Relay')));
      ws2.close();
      await new Promise((r) => { rp.once('exit', r); rp.kill(); });
      fs.rmSync(TWO, { recursive: true, force: true });
      step('a second star system file: its subspace relay and Sol\'s linked to each other');
    }
    // A design edited (a copy of config/): a ship keeps its class across restarts, and on the next
    // load Engineering takes the new limits and power paths, its own state (ties) kept.
    {
      const ED = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-design-')), SHIPS = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-designship-'));
      fs.cpSync(CONFIG.DIR, ED, { recursive: true });
      const P = PORT + 10, env = { PORT: P, CONFIG_DIR: ED, RELAY_DATA: SHIPS, STARBASES_FILE: path.join(SHIPS, 'starbases.json') };
      const kill = (p) => new Promise((r) => { if (p.exitCode !== null) return r(); p.once('exit', r); p.kill(); });
      const look = async () => {
        const ws = new WebSocket(`ws://localhost:${P}`), m = [];
        ws.on('message', (x) => m.push(JSON.parse(x)));
        await new Promise((r) => ws.on('open', r));
        await until(() => m.some((x) => x.type === 'ships' && x.ships.some((s) => s.name === 'Designship' && s.computer)));
        ws.send(JSON.stringify({ type: 'register', name: 'tester', ship: 'Designship', station: 'Helm' }));
        const own = await until(() => [...m].reverse().find((x) => x.type === 'nav' && x.own?.grid)?.own);
        ws.close();
        return own;
      };
      let rp = run(['server.js'], env);
      await wait(1000);
      let sc = run(['tools/shipcore.js', '--relay', `ws://localhost:${P}`, '--data', SHIPS, '--warm', '--position', '500,500', '--class', 'shuttle', 'Designship'], env);
      let own = await look();
      assert.equal(own.class, 'Shuttle');
      assert.deepEqual(own.grid.busMax, { A: 60, B: 60, C: 60, EPS: 80 }, 'its taps\' limits: its buses');
      assert.deepEqual([own.grid.cutOff['system:gravity'], own.grid.cutOff['system:lateral']], [undefined, undefined], 'warm: its design\'s ties (gravity, lateral sensors on Bus C) not cut off');
      await wait(2500);
      await kill(sc); await kill(rp);
      assert.equal(JSON.parse(fs.readFileSync(path.join(SHIPS, 'Designship', '.nav.json'), 'utf8')).class, 'shuttle', 'the class saved with the ship');
      // The design changes: bigger buses, and the lateral sensors moved to a place of their own.
      const file = path.join(ED, 'ships', 'shuttle.json'), d = JSON.parse(fs.readFileSync(file, 'utf8'));
      d.bus = 90;
      d.places.find((pl) => pl.name === 'Cockpit').rows = d.places.find((pl) => pl.name === 'Cockpit').rows.filter((r) => r !== 'system:lateral');
      d.places.push({ name: 'Sensor Pod', deck: 2, stations: [], rows: ['system:lateral'] });
      fs.writeFileSync(file, JSON.stringify(d, null, 2));
      rp = run(['server.js'], env);
      await wait(1000);
      sc = run(['tools/shipcore.js', '--relay', `ws://localhost:${P}`, '--data', SHIPS, 'Designship'], env);
      own = await look();
      assert.equal(own.class, 'Shuttle', 'still a shuttle (no --class this time)');
      assert.deepEqual([own.grid.busMax.A, own.grid.totals.A.max], [90, 90], 'the new bus limit');
      assert.deepEqual(own.grid.ties['system:lateral'], ['C'], 'its own ties kept');
      assert.ok(own.grid.ties['place:Sensor Pod']?.includes('C'), `the new place carries its load (${JSON.stringify(own.grid.ties['place:Sensor Pod'])})`);
      assert.equal(own.grid.cutOff['system:lateral'], undefined, 'the moved load isn\'t cut off');
      await kill(sc); await kill(rp);
      fs.rmSync(ED, { recursive: true, force: true }); fs.rmSync(SHIPS, { recursive: true, force: true });
      step('a design edited: the shuttle kept its class across restarts (saved with it), came up warm with its design\'s ties, then took the new bus limit (90) and its lateral sensors\' new place (Sensor Pod, tied on Bus C) with its own ties kept');
    }
    // A Galaxy made a runabout (Admin → Fleet): its engineering rebuilt from the runabout's design,
    // nothing of the Galaxy's left (no Security console, brig, crew services) on its grid or tied.
    {
      const GD = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-reclass-'));
      const P = PORT + 10, env = { PORT: P, RELAY_DATA: GD, STARBASES_FILE: path.join(GD, 'starbases.json') };
      const rp = run(['server.js'], env);
      await wait(1000);
      const sc = run(['tools/shipcore.js', '--relay', `ws://localhost:${P}`, '--data', GD, '--warm', '--position', '500,500', 'Reclassed'], env);
      const ws = new WebSocket(`ws://localhost:${P}`), m = [];
      ws.on('message', (x) => m.push(JSON.parse(x)));
      await new Promise((r) => ws.on('open', r));
      await until(() => m.some((x) => x.type === 'ships' && x.ships.some((v) => v.name === 'Reclassed' && v.computer)));
      ws.send(JSON.stringify({ type: 'register', name: 'tester', ship: 'Reclassed', station: 'Helm' }));
      const grid = () => [...m].reverse().find((x) => x.type === 'nav' && x.own?.grid)?.own;
      const GALAXY_ONLY = ['console:Security', 'console:Crew', 'console:Brig', 'sub:brigField', 'sub:forcefields', 'system:replicators', 'console:Medical'];
      await until(() => grid()?.class === 'Galaxy' && GALAXY_ONLY.every((x) => grid().grid.tieNodes[x]));
      ws.send(JSON.stringify({ type: 'admin', action: 'set-class', name: 'Reclassed', cls: 'runabout' }));
      await until(() => m.some((x) => x.type === 'admin-created' && x.ok));
      await until(() => grid()?.class === 'Runabout');
      const g = grid().grid;
      const left = GALAXY_ONLY.filter((x) => g.tieNodes[x] || (g.ties[x] || []).length);
      assert.deepEqual(left, [], `the Galaxy's loads gone from the runabout: ${left}`);
      assert.ok(g.tieNodes['console:Helm'] && g.tieNodes['console:Engineering'], 'the runabout\'s own consoles');
      await wait(1500);
      ws.close();
      await new Promise((r) => { sc.once('exit', r); sc.kill(); });
      assert.equal(JSON.parse(fs.readFileSync(path.join(GD, 'Reclassed', '.nav.json'), 'utf8')).class, 'runabout', 'saved with the ship');
      await new Promise((r) => { rp.once('exit', r); rp.kill(); });
      fs.rmSync(GD, { recursive: true, force: true });
      step('a Galaxy made a runabout (Admin → Fleet): its engineering rebuilt from the runabout\'s design, none of the Galaxy\'s consoles or systems (Security, the brig, crew services, sickbay) left on its grid, and the class saved with it');
    }
    // The subspace relay: its own design (config/ships, kind relay), a grid of its own (pure solar,
    // the output its design gives), a maintenance console (Bridge 1) to tend it; its links lose
    // signal while its transceiver (the subspace subsystem) has no power.
    {
      const RD = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-relaydesign-')), RS = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-relaydata-'));
      fs.cpSync(CONFIG.DIR, RD, { recursive: true });
      const relayFile = Object.keys(classes).length && fs.readdirSync(path.join(RD, 'ships')).find((f) => JSON.parse(fs.readFileSync(path.join(RD, 'ships', f), 'utf8')).kind === 'relay');
      const rd = JSON.parse(fs.readFileSync(path.join(RD, 'ships', relayFile), 'utf8'));
      rd.solar = { output: 70 };
      fs.writeFileSync(path.join(RD, 'ships', relayFile), JSON.stringify(rd, null, 2));
      const P = PORT + 10, env = { PORT: P, CONFIG_DIR: RD, RELAY_DATA: RS, STARBASES_FILE: path.join(RS, 'starbases.json') };
      const rp = run(['server.js'], env);
      await wait(1200);
      const sock = async (hello) => { const ws = new WebSocket(`ws://localhost:${P}`), m = []; ws.on('message', (x) => m.push(JSON.parse(x))); await new Promise((r) => ws.on('open', r)); if (hello) ws.send(JSON.stringify(hello)); return { ws, m }; };
      const tech = await sock();
      const listed = await until(() => [...tech.m].reverse().find((x) => x.type === 'ships')?.ships.find((s) => s.relay));
      assert.deepEqual([listed.name, listed.classId, listed.stations], ['Sol Subspace Relay', relayFile.slice(0, -5), ['Bridge 1']]);
      tech.ws.send(JSON.stringify({ type: 'register', name: 'tech', ship: 'Sol Subspace Relay', station: 'Bridge 1' }));
      await until(() => tech.m.some((x) => x.type === 'registered'));
      tech.ws.send(JSON.stringify({ type: 'console-mode', mode: 'Engineering' }));
      const grid = () => [...tech.m].reverse().find((x) => x.type === 'nav' && x.own?.grid)?.own.grid;
      await wait(1500);
      await until(() => grid());
      const g = grid();
      assert.equal(g.solarOut, 70, 'its solar arrays: the output its design gives');
      assert.ok(g.cells.solar.B > 0 && g.core === 'ejected' && Object.values(g.drives).every((d) => d.state === 'off'), `pure solar: solar ${JSON.stringify(g.cells.solar)}, core ${g.core}`);
      assert.ok(g.subOk.subspace !== false, 'its transceiver powered');
      // (No antimatter aboard a relay: nothing to contain, so nothing to breach, and nothing to blow up near the ships around it.)
      assert.ok(Object.values(g.fuel.am.tanks).every((t) => t.level === 0), `no antimatter: ${JSON.stringify(g.fuel.am.tanks.map((t) => [t.name, t.level]))}`);
      await wait(3000);
      assert.equal(grid().core, 'ejected');
      assert.ok(!tech.m.some((x) => x.type === 'notice' && /containment|breach|destroyed/i.test(x.text)), 'no containment trouble on the relay');
      tech.ws.send(JSON.stringify({ type: 'grid', reactor: { name: 'aux1', start: true } }));
      await until(() => tech.m.some((x) => x.type === 'notice' && /no fusion reactors aboard/.test(x.text)));
      // Its links: Starbase 47's to it lose signal while the transceiver is untied; tied again, they carry.
      const ops = await sock({ type: 'operator', name: 'watch', ship: 'Starbase 47' });
      const relayLinks = () => { const gr = [...ops.m].reverse().find((x) => x.type === 'roster')?.graph; return gr ? gr.links.filter((l) => l.includes('Sol Subspace Relay')).map((l) => (gr.lost || []).some((x) => x.includes('Sol Subspace Relay') && x.includes(l.find((n) => n !== 'Sol Subspace Relay'))) ) : null; };
      await until(() => relayLinks()?.length > 0 && relayLinks().every((lost) => !lost));
      tech.ws.send(JSON.stringify({ type: 'grid', ties: { 'sub:subspace': [] } }));
      await until(() => relayLinks()?.length > 0 && relayLinks().every((lost) => lost));
      tech.ws.send(JSON.stringify({ type: 'grid', ties: { 'sub:subspace': ['B'] } }));
      await until(() => relayLinks().every((lost) => !lost));
      tech.ws.close(); ops.ws.close();
      await new Promise((r) => { rp.once('exit', r); rp.kill(); });
      fs.rmSync(RD, { recursive: true, force: true }); fs.rmSync(RS, { recursive: true, force: true });
      step("the subspace relay: its own design (solar 70, no fusion reactors, no warp core), signed into at its maintenance console (Bridge 1) for its grid; its links lost signal with its transceiver untied, and carried again tied");
    }
    ok = true;
  } catch (err) {
    console.error('FAIL:', err.message);
  } finally {
    await Promise.all([...procs].map((p) => new Promise((r) => { p.once('exit', r); p.kill(); })));
    fs.rmSync(DATA, { recursive: true, force: true });
    console.log(ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
  }
})();
