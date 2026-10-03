// The path-tracing solver (tools/path-solver.js) beside the graph solver (tools/graph-solver.js), on
// every ship class in the same grid states (cold, warm, all on, brownout, crosslink both ways and one
// way, EPS taps alone, docked, starved). In each: every source gives no more than it has, every bus
// carries no more than its limit, what the sources gave is what the loads took and the batteries
// charged, a load gets its minimum or nothing, and containment gets at least what the graph solver
// gives it; and it never delivers less than the graph solver. Where the two differ is listed (they
// share power out by different rules). A docked group is one graph: a
// starved runabout draws across the dock from its starbase, which keeps its own loads powered.
const assert = require('assert');
const GRAPH = require('../tools/ship-graph');
const SOLVER = require('../tools/graph-solver');
const PATH = require('../tools/path-solver');
const CONFIG = require('../tools/config');
require('../tools/store').filesOnly();

const step = (s) => console.log(`ok - ${s}`);
const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
const E = 1e-6;
let ok = false;
try {
  const d = GRAPH.dump({ scenarios: true }), t = d.tables;
  const { classes, starbase } = CONFIG.files.loadShips(() => {});
  const notes = [];
  let states = 0;
  for (const id of Object.keys(d.scenarios)) {
    const g = GRAPH.convert(id, classes[id], d), { all } = GRAPH.nodes(g);
    for (const [name, sc] of Object.entries(d.scenarios[id])) {
      const rt = SOLVER.fromRelay(g, sc.state, t), where = `${id}/${name}`;
      const a = SOLVER.solve(g, rt);
      {
        const b = PATH.solve(g, rt);
        // (Every source within what it has; every bus within its limit.)
        for (const [sid, u] of Object.entries(b.used)) assert.ok(all[sid].creative || u <= rt.supply(sid) + E, `${where}: ${sid} gave ${u}, had ${rt.supply(sid)}`);
        for (const n of Object.keys(all).filter((x) => all[x].type === 'bus')) assert.ok((b.through[n] || 0) <= rt.busMax(n) + E, `${where}: ${n} carried ${b.through[n]}, its limit ${rt.busMax(n)}`);
        // (What was given is what was taken.)
        assert.ok(Math.abs(sum(b.used) - sum(b.got) - sum(b.charging)) < 1e-6, `${where}: given ${sum(b.used)}, taken ${sum(b.got)} + charged ${sum(b.charging)}`);
        // (A minimum or nothing; containment never short of what the graph solver gives it.)
        for (const cid of b.consumers) if (b.pri[cid] >= 1000) assert.ok(b.got[cid] <= E || b.got[cid] >= b.min[cid] - E, `${where}: ${cid} got ${b.got[cid]}, under its minimum ${b.min[cid]}`);
        for (const cid of b.consumers.filter((c) => b.pri[c] < 1000)) assert.ok(b.got[cid] >= a.got[cid] - E, `${where}: containment ${cid} got ${b.got[cid]}, the graph solver ${a.got[cid]}`);
        const differ = Object.keys(a.got).filter((k) => Math.abs((a.got[k] || 0) - (b.got[k] || 0)) > E);
        if (differ.length) notes.push(`${where}: delivered ${sum(b.got).toFixed(1)} (graph solver ${sum(a.got).toFixed(1)}); ${differ.map((k) => `${all[k].key} ${(b.got[k] || 0).toFixed(1)} (${(a.got[k] || 0).toFixed(1)})`).join(', ')}`);
        assert.ok(sum(b.got) >= sum(a.got) - E, `${where}: delivered ${sum(b.got)}, less than the graph solver's ${sum(a.got)}`);
      }
      states++;
    }
  }
  step(`in ${states} ship states: no source gives more than it has, no bus carries more than its limit, what's given is what's taken and charged, every load gets its minimum or nothing, containment never less than the graph solver gives, and never less delivered than the graph solver`);
  console.log(`# ${states - notes.length} of ${states} states the same as the graph solver; the rest (path solver, graph solver's in brackets):`);
  for (const n of notes) console.log(`#   ${n}`);

  // A docked group: a starved runabout at a starbase, one graph across the dock.
  const ga = GRAPH.convert('runabout', classes.runabout, d), gb = GRAPH.convert('starbase', starbase, d);
  const starved = JSON.parse(JSON.stringify(d.scenarios.runabout.starved.state));
  starved.ties.dock = ['B'];
  const ra = SOLVER.fromRelay(ga, starved, t), rb = SOLVER.fromRelay(gb, d.baseScenarios.exporting.state, t);
  const own = PATH.solve(gb, rb);
  const grp = PATH.solveGroup([{ g: ga, rt: ra }, { g: gb, rt: rb }], [{ from: [1, 'export-port-power'], to: [0, 'dock-power'], rate: t.GRID.dock }]);
  const [A, B] = grp.members;
  const crossed = A.through['dock-power'] || 0;
  assert.ok(crossed > 0 && Math.abs((B.through['export-port-power'] || 0) - crossed) < E, `power crossed the dock (${crossed}), out of the starbase's export the same`);
  assert.ok(crossed <= t.GRID.dock + E, 'no more than the dock\'s rate');
  assert.ok(Object.keys(B.got).every((k) => Math.abs(own.got[k] - B.got[k]) < E), 'the starbase\'s own loads as they were');
  const alone = PATH.solve(ga, SOLVER.fromRelay(ga, d.scenarios.runabout.starved.state, t));
  assert.ok(sum(A.got) > sum(alone.got), 'the runabout better off docked');
  step(`docked: a starved runabout (${sum(alone.got).toFixed(0)} on its own) draws ${crossed.toFixed(0)} across the dock from the starbase (${sum(A.got).toFixed(0)} in all), recorded passing through the starbase's export and its own dock feed; the starbase's loads as they were`);
  ok = true;
} catch (err) {
  console.error('FAIL:', err.stack || err.message);
}
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
