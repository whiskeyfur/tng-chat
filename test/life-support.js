// Life support (tools/life-support.js; wish list 1), on every class's graph: each place has its own
// air, every vessel its tanks, scrubber and reclaimer, and hydroponics only where its design says. A
// runabout with five aboard, its atmosphere system powered, keeps its air for two days (carbon dioxide
// low, oxygen held, the oxygen tank barely drawn on, carbon stored); unpowered, its carbon dioxide
// climbs past the warning and toward danger while its oxygen falls. Hydroponics keeps the air breathable when the atmosphere system is down;
// a starbase's tanks never run dry; water vapour never passes saturation; nothing goes negative.
// In play: the relay runs it each second (at the admin's speed) and shows each place's air on
// Engineering's grid; with the atmosphere switched off, the air where the crew are goes stale; the
// air and the tanks are saved with the ship.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const GRAPH = require('../tools/ship-graph');
const CONFIG = require('../tools/config');
const LS = require('../tools/life-support');
require('../tools/store').filesOnly();

const step = (s) => console.log(`ok - ${s}`);
let ok = false;
try {
  const d = GRAPH.dump(), { classes, starbase, relay } = CONFIG.files.loadShips(() => {});
  const designs = { ...classes, starbase, [relay.id || 'subspace-relay']: relay };
  const graphs = {};
  for (const id of Object.keys(d.classes)) {
    const g = graphs[id] = GRAPH.convert(id, designs[id], d), { all } = GRAPH.nodes(g);
    assert.deepEqual(GRAPH.check(g), [], `${id}: valid`);
    const places = Object.keys(all).filter((x) => all[x].type === 'place'), airs = Object.keys(all).filter((x) => all[x].type === 'atmosphere');
    assert.equal(airs.length, places.length, `${id}: an air for each place`);
    for (const x of ['air-handler', 'tank-o2', 'tank-n2', 'tank-h2o', 'tank-carbon', 'co2-scrubber', 'water-reclaimer']) assert.ok(all[x], `${id}: ${x}`);
    assert.equal(!!all.hydroponics, !!designs[id].hydroponics, `${id}: hydroponics as its design says`);
  }
  step(`every vessel kind: an air for each of its places, an air handler, oxygen, nitrogen and water tanks, a carbon store, a CO2 scrubber and a water reclaimer; hydroponics on ${Object.keys(designs).filter((x) => designs[x].hydroponics).join(', ')}`);

  const run = (g, hours, opts) => { const st = LS.init(g); let r; const worst = { co2: 0, o2: Infinity, h2o: 0 }, at = {}; for (let h = 1; h <= hours; h++) for (let i = 0; i < 60; i++) { r = LS.step(g, st, { dt: 60, ...opts }); for (const a of Object.values(r.air)) { worst.co2 = Math.max(worst.co2, a.kPa.co2); worst.o2 = Math.min(worst.o2, a.kPa.o2); worst.h2o = Math.max(worst.h2o, a.kPa.h2o); for (const w of a.warn) at[w] ??= h; } for (const v of Object.values(r.tanks)) assert.ok(v >= -1e-9, 'no tank below empty'); } return { r, st, worst, at }; };
  const crew = { 'place-cockpit': 3, 'place-aft-compartment': 2 };
  const ls = CONFIG.files.types().lifeSupport;
  const on = run(graphs.runabout, 48, { crew, power: { 'system-atmosphere': 1, 'system-lighting': 1 } });
  assert.ok(on.worst.co2 < ls.air.co2WarnKPa && on.worst.o2 > ls.air.o2WarnKPa, `powered: CO2 at most ${on.worst.co2.toFixed(2)} kPa, O2 at least ${on.worst.o2.toFixed(2)} kPa`);
  const o2cap = Object.values(GRAPH.nodes(graphs.runabout).all['tank-o2'].capacity)[0], used = o2cap - on.r.tanks['tank-o2'];
  assert.ok(used > 0 && used < 2, `the scrubber gives most of the oxygen back: the tank down ${used.toFixed(2)} kg in two days`);
  assert.ok(on.r.tanks['tank-carbon'] > 0, 'carbon stored');
  assert.ok(on.worst.h2o <= ls.air.saturationKPa + 1e-9, 'water vapour never past saturation');
  step(`a runabout, five aboard, powered for two days: CO2 at most ${on.worst.co2.toFixed(2)} kPa, O2 held at ${on.worst.o2.toFixed(1)} kPa, the oxygen tank down ${used.toFixed(2)} kg of ${o2cap}, ${on.r.tanks['tank-carbon'].toFixed(1)} kg of carbon stored`);
  const off = run(graphs.runabout, 72, { crew, power: { 'system-atmosphere': 0, 'system-lighting': 1 } });
  assert.ok(off.at['carbon dioxide high'] && off.worst.co2 > on.worst.co2 * 10 && off.worst.o2 < on.worst.o2, `unpowered: CO2 high after ${off.at['carbon dioxide high']} h`);
  step(`its atmosphere unpowered: carbon dioxide high after ${off.at['carbon dioxide high']} h (${off.worst.co2.toFixed(2)} kPa in three days), oxygen down to ${off.worst.o2.toFixed(1)} kPa${off.at['danger: carbon dioxide'] ? `, danger after ${off.at['danger: carbon dioxide']} h` : ''}`);

  // Hydroponics: with the atmosphere system down, the plants (on the lighting's power) still take
  // carbon dioxide out and put oxygen back.
  const gCrew = { 'place-bridge': 10, 'place-crew-quarters': 40 };
  const lit = run(graphs.galaxy, 24, { crew: gCrew, power: { 'system-atmosphere': 0, 'system-lighting': 1 } });
  const dark = run(graphs.galaxy, 24, { crew: gCrew, power: { 'system-atmosphere': 0, 'system-lighting': 0 } });
  assert.ok(lit.worst.co2 < dark.worst.co2 && lit.r.tanks['tank-carbon'] > 0, `hydroponics keeps carbon dioxide down (${lit.worst.co2.toFixed(2)} against ${dark.worst.co2.toFixed(2)} kPa) and grows biomass`);
  // A starbase: creative tanks never run down.
  const sb = run(graphs.starbase, 24, { crew: { 'place-bridge': 20 }, power: { 'system-atmosphere': 0.2, 'system-lighting': 0 } });
  const sbInit = LS.init(graphs.starbase).tanks;
  for (const t of ['tank-o2', 'tank-n2', 'tank-h2o']) assert.equal(sb.r.tanks[t], sbInit[t], `the starbase's ${t} as it was`);
  // (The admin's speed: an hour at 60× is 60 hours of breathing.)
  const st = LS.init(graphs.runabout), fast = LS.step(graphs.runabout, st, { dt: 60, speed: 60, crew, power: { 'system-atmosphere': 0 } });
  const slow = run(graphs.runabout, 1, { crew, power: { 'system-atmosphere': 0 } });
  assert.ok(fast.air['air-cockpit'].kPa.co2 > slow.r.air['air-cockpit'].kPa.co2, 'faster at speed 60');
  step(`a Galaxy, fifty aboard, a day with its atmosphere system down: hydroponics holds the worst carbon dioxide to ${lit.worst.co2.toFixed(2)} kPa (${dark.worst.co2.toFixed(2)} without) and grows ${lit.r.tanks['tank-carbon'].toFixed(1)} kg of biomass; a starbase's creative tanks never run down; the admin's speed setting runs it faster`);
  ok = true;
} catch (err) {
  console.error('FAIL:', err.stack || err.message);
}

// In play: a relay and a runabout's computer, life support at 600×.
(async () => {
  if (!ok) return finish();
  ok = false;
  const PORT = Number(process.env.PORT || 8099) + 15, DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-life-'));
  const env = { ...process.env, PORT, RELAY_DATA: DATA, STARBASES_FILE: path.join(DATA, 'starbases.json') };
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ port: PORT, lifeSpeed: 600 }));
  const procs = [];
  const run = (args) => { const p = spawn(process.execPath, args, { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' }); procs.push(p); return p; };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    run(['server.js']); await wait(1200);
    run(['tools/shipcore.js', '--relay', `ws://localhost:${PORT}`, '--data', DATA, '--warm', '--class', 'runabout', 'Airship']); await wait(2500);
    const ws = new WebSocket(`ws://localhost:${PORT}`), msgs = [];
    ws.on('message', (m) => msgs.push(JSON.parse(m)));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'register', name: 'chief', ship: 'Airship', station: 'Engineering' }));
    const life = async (pred, what) => { for (let i = 0; i < 100; i++) { const l = [...msgs].reverse().find((m) => m.type === 'nav' && m.own?.grid?.life)?.own.grid.life; if (l && pred(l)) return l; await wait(150); } throw new Error(`timed out: ${what}`); };
    const first = await life((l) => l.places.some((p) => p.crew), 'the air on Engineering\'s grid, with the crew in it');
    assert.equal(first.speed, 600);
    const where = first.places.find((p) => p.crew);
    assert.ok(where.kPa.o2 > 20 && where.kPa.co2 < 1 && first.tanks.o2.kg > 0, `breathable to start (${JSON.stringify(where.kPa)})`);
    // (The atmosphere switched off everywhere: the air where the chief is goes stale.)
    ws.send(JSON.stringify({ type: 'grid', ls: { loc: 'all', sys: 'atmosphere', on: false } }));
    const co2At = (l) => l.places.find((p) => p.name === where.name).kPa.co2;
    const a = co2At(await life(() => true, 'a reading')); await wait(2500);
    const b = co2At(await life(() => true, 'a later reading'));
    assert.ok(b > a, `carbon dioxide rising with the atmosphere off (${a} to ${b} kPa)`);
    ws.close();
    for (const p of procs.splice(1)) { p.kill(); await new Promise((r) => p.once('exit', r)); }
    const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'Airship', '.nav.json'), 'utf8'));
    assert.ok(saved.eng?.life?.air && Object.keys(saved.eng.life.air).length === first.places.length && saved.eng.life.tanks['tank-o2'] > 0, 'the air and the tanks saved with the ship');
    console.log(`ok - in play at 600×: Engineering's grid shows each place's air (${where.name}: O2 ${where.kPa.o2} kPa, CO2 ${where.kPa.co2}, the chief there); with the atmosphere off, its CO2 rose ${a} to ${b} kPa; the air and the tanks saved with the ship`);
    ok = true;
  } catch (err) {
    console.error('FAIL:', err.stack || err.message);
  } finally {
    for (const p of procs) p.kill('SIGKILL');
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  }
})();
function finish() { console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1); }
