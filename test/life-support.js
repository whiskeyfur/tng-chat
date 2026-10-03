// Life support (tools/life-support.js; wish list 1), on every class's graph: each place has its own
// air, every vessel its tanks, scrubber and reclaimer, and hydroponics only where its design says. A
// runabout with five aboard, its atmosphere system powered, keeps its air for two days (carbon dioxide
// low, oxygen held, the oxygen tank barely drawn on, carbon stored); unpowered, its carbon dioxide
// climbs past the warning and toward danger while its oxygen falls. Hydroponics keeps the air breathable when the atmosphere system is down;
// a starbase's tanks never run dry; water vapour never passes saturation; nothing goes negative.
const assert = require('assert');
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
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
