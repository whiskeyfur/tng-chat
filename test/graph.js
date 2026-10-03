// Ship graphs (step 1, docs/ship-graph.md): every ship class converts to a valid graph that loses
// nothing (each tie key aboard is a system, and its links that are "auto" are the ties a new ship
// of that class starts with); the up/down index agrees both ways; config/ships-graph is up to date
// and loads; a graph with something wrong in it is refused, saying what.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const GRAPH = require('../tools/ship-graph');
const CONFIG = require('../tools/config');

const step = (s) => console.log(`ok - ${s}`);
let ok = false;
try {
  const d = GRAPH.dump();
  const designs = CONFIG.readShips(); // (the design files are graphs: their design fields, worked out)
  const counts = [];
  for (const id of Object.keys(d.classes)) {
    const g = GRAPH.convert(id, designs[id], d);
    assert.deepEqual(GRAPH.check(g), [], `${id}: valid`);
    const keys = Object.keys(d.classes[id].keys).filter((k) => k !== 'crosslink');
    const mapped = new Set(Object.values(GRAPH.nodes(g).all).map((s) => s.key).filter(Boolean));
    assert.deepEqual(keys.filter((k) => !mapped.has(k)), [], `${id}: every tie key aboard is a system`);
    const ties = GRAPH.toTies(g);
    const differ = keys.filter((k) => JSON.stringify(ties[k]) !== JSON.stringify(d.classes[id].keys[k].tied));
    assert.deepEqual(differ.map((k) => `${k}: ${ties[k]} ≠ ${d.classes[id].keys[k].tied}`), [], `${id}: the "auto" links are a new ship's ties`);
    const { up, down } = GRAPH.index(g);
    for (const [a, res] of Object.entries(up)) for (const [r, list] of Object.entries(res)) for (const b of list) assert.ok(down[b][r].includes(a), `${id}: ${a} draws ${r} from ${b}, so ${b} feeds ${a}`);
    counts.push(`${id} ${Object.keys(GRAPH.nodes(g).all).length}`);
  }
  step(`every ship class converts to a valid graph, losing nothing; its "auto" links are a new ship's ties (${counts.join(', ')})`);

  // The runabout's file: up to date, and it loads.
  const g = GRAPH.convert('runabout', designs.runabout, d);
  // (The design files are graphs: each the same built again from the design fields worked out of it.)
  const files = CONFIG.readShipFiles();
  for (const id of Object.keys(d.classes)) {
    assert.ok(GRAPH.isGraphFile(files[id]), `config/ships/${id}.json is a graph`);
    const again = GRAPH.toFile(id, GRAPH.toDesign(files[id]), d);
    for (const k of Object.keys(again)) assert.equal(JSON.stringify(files[id][k]), JSON.stringify(again[k]), `${id}: ${k} the same built again`);
  }
  const loaded = CONFIG.loadGraphs((line) => { throw new Error(line); });
  assert.ok(loaded.runabout, 'the config loader loads it');
  // (From any system, both ways: the EPS feeds the shields' and the taps; Bus B's sources.)
  const { up, down } = GRAPH.index(g);
  assert.ok(down.eps.eps.includes('bus-a') && down.eps.eps.includes('system-weapons'), 'the EPS feeds Bus A (its tap) and the weapons');
  assert.ok(up['bus-b'].power.includes('solar') && up['bus-b'].power.includes('dock-power'), 'Bus B draws from solar and dock power');
  const all = GRAPH.nodes(g).all;
  assert.equal(all['bus-c'].upstream['bus-a'].power.pull, false, 'A and C never link directly');
  // (Nested: a system's parts are in it; consumes and produces are each system's, never the vessel's.)
  assert.ok(g.systems['warp-core'].systems['subsystem-injector'] && g.systems['impulse-port'].systems['impulse-port-thrusters'], 'the warp core holds its injector; a drive its thrusters');
  assert.ok(!('consumes' in g) && !('produces' in g), 'consumes and produces are on the systems');
  // (Effects: what the runabout can do, by its systems, with their parameters.)
  const can = new Set(Object.values(all).flatMap((s) => Object.keys(s.effects || {})));
  for (const fx of ['ftl', 'impulse', 'maneuver', 'shields', 'phasers', 'torpedoes', 'transport', 'docking']) assert.ok(can.has(fx), `the runabout can: ${fx}`);
  assert.equal(all['system-engines'].effects.ftl.maxWarp, designs.runabout.maxWarp, 'its FTL: the design\'s top warp');
  assert.ok(!can.has('jump'), 'no spore drive: no jump');
  // (Its seats: one a console, the stations it has.)
  const seats = Object.values(all).filter((s) => s.effects?.seat).map((s) => s.effects.seat.station).sort();
  assert.deepEqual(seats, [...designs.runabout.stations, ...designs.runabout.places.flatMap((p) => p.stations)].filter((v, i, a) => a.indexOf(v) === i).sort(), `the runabout's seats are its stations: ${seats}`);
  // (Heat: what everything makes, at full draw, the radiators can dump; pull priority and minimums.)
  const made = Object.entries(all).filter(([id]) => !id.startsWith('radiator')).reduce((n, [, s]) => n + (s.produces?.heat || 0), 0);
  const dumped = Object.entries(all).filter(([id]) => id.startsWith('radiator')).reduce((n, [, s]) => n + s.consumes.heat, 0);
  assert.ok(made > 0 && dumped >= made && dumped < made * 1.2, `the radiators just balance the heat (${made} made, ${dumped} dumped)`);
  assert.ok(Object.keys(GRAPH.index(g).up['coolant-loop'].heat).length > 10, 'the coolant loop takes heat from the systems');
  assert.equal(all['containment-am-pods'].upstream['bus-a'].power.pri, 0, 'containment is served first');
  assert.ok(all['console-helm'].upstream['bus-a'].power.pri < all['system-shields'].upstream.eps.eps.pri + 100, 'pri set');
  assert.equal(all['console-helm'].upstream['bus-a'].power.min, 2, 'a console works on its 2 MW or not at all');
  assert.equal(all['subsystem-injector'].upstream['bus-a'].power.min, 'all', 'a subsystem needs all it draws');
  // (The starbase's design is creative in power, EPS, deuterium and antimatter: its core and tanks never run dry.)
  const sb = GRAPH.nodes(GRAPH.convert('starbase', designs.starbase, d)).all;
  assert.ok(sb['warp-core']?.creative?.eps && sb['tank-deu-main']?.creative?.deu && sb['tank-am-main']?.creative?.am, 'a starbase: creative core and tanks');
  step(`heat: ${Math.round(made)} made at full draw, ${dumped} the radiators dump; pull priority and minimums on every load's links`);
  step(`every design file in config/ships is a graph, the same built again from its design fields; the runabout's loads (${Object.keys(all).length} systems, ${Object.keys(g.systems).length} at the top); walking up and down from any system works; its effects say what it can do (${[...can].length} effects)`);

  // Something wrong: refused, saying what.
  const broken = JSON.parse(JSON.stringify(g)), b = GRAPH.nodes(broken).all;
  b['system-shields'].type = 'deflector-dish';
  b['console-helm'].upstream['bus-z'] = { power: { pull: true } };
  b['solar'].upstream['bus-b'] = { power: { pull: 'maybe' } };
  b['subsystem-patternbuffers'].place = 'nowhere';
  b['console-helm'].upstream['bus-a'].power.min = 'some';
  broken.produces = { power: 5 };
  broken.systems['warp-core'].systems['bus-a'] = { type: 'bus', name: 'Bus A again', upstream: {} };
  const bad = GRAPH.check(broken);
  for (const want of ['no system type "deflector-dish"', 'no system "bus-z"', 'false, "warn", true or "auto"', 'place: no place "nowhere"', 'produces: belongs on a system', '"bus-a" is used twice', 'min: a number, or "all"']) assert.ok(bad.some((b) => b.includes(want)), `refused for: ${want} (${bad})`);
  step('a graph with an unknown type, a missing upstream, a bad permission, a missing place, production on the vessel or an id used twice is refused, each named');
  ok = true;
} catch (err) {
  console.error('FAIL:', err.message);
}
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
