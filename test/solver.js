// The graph solver (tools/graph-solver.js, ship graphs step 2) against the relay's own (server.js
// flow()), on every ship class in a set of grid states: cold iron, warm, all on (at warp, armed,
// shields up), a brownout, the crosslink both ways and one way, buses on their EPS taps alone,
// docked. Without minimums, the two must agree on every load, every source, the batteries, the
// crosslink and charging. With them, what changes is listed (where the relay powers a console or
// a subsystem that can't work on what it gets).
const assert = require('assert');
const GRAPH = require('../tools/ship-graph');
const SOLVER = require('../tools/graph-solver');
const fs = require('fs');
const path = require('path');
const CONFIG = require('../tools/config');

const step = (s) => console.log(`ok - ${s}`);
const near = (a, b) => Math.abs((a || 0) - (b || 0)) < 1e-6;
let ok = false;
try {
  const d = GRAPH.dump({ scenarios: true });
  const t = d.tables;
  const diffs = [], minNotes = [];
  let compared = 0;
  for (const id of Object.keys(d.scenarios)) {
    const design = JSON.parse(fs.readFileSync(path.join(CONFIG.DIR, 'ships', `${id}.json`), 'utf8'));
    const g = GRAPH.convert(id, design, d);
    const { all } = GRAPH.nodes(g);
    for (const [name, sc] of Object.entries(d.scenarios[id])) {
      const rt = SOLVER.fromRelay(g, sc.state, t), L = rt.letters;
      const r = SOLVER.solve(g, rt, { enforceMin: false });
      const where = `${id}/${name}`;
      const today = sc.today.cells;
      // Every load: what it got, from each bus.
      for (const cid of r.consumers) {
        const k = all[cid].key;
        for (const n of Object.keys(L)) if (!near(r.cells[cid]?.[n], today[k]?.[L[n]])) diffs.push(`${where} ${k} from ${L[n]}: graph ${r.cells[cid]?.[n] || 0}, relay ${today[k]?.[L[n]] || 0}`);
      }
      // Every source (the batteries and the EPS's pressure as one row, as the relay keeps them).
      const stores = { A: 0, B: 0, C: 0, EPS: 0 };
      for (const [sid, row] of Object.entries(r.cells)) {
        const k = all[sid].key;
        if (k in t.STORES) { for (const n of Object.keys(L)) stores[L[n]] += row[n]; continue; }
        if (!t.SOURCES.includes(k)) continue;
        for (const n of Object.keys(L)) if (!near(row[n], today[k]?.[L[n]])) diffs.push(`${where} source ${k} on ${L[n]}: graph ${row[n]}, relay ${today[k]?.[L[n]] || 0}`);
      }
      for (const n of ['A', 'B', 'C', 'EPS']) if (!near(stores[n], today.stores?.[n])) diffs.push(`${where} batteries on ${n}: graph ${stores[n]}, relay ${today.stores?.[n] || 0}`);
      // The crosslink, charging, the EPS.
      const xl = {};
      for (const [k, v] of Object.entries(r.crossflow)) xl[k.split('|').map((x) => L[x]).join('')] = v;
      for (const k of new Set([...Object.keys(xl), ...Object.keys(sc.today.crossflow)])) if (!near(xl[k], sc.today.crossflow[k])) diffs.push(`${where} crosslink ${k}: graph ${xl[k] || 0}, relay ${sc.today.crossflow[k] || 0}`);
      for (const n of Object.keys(L)) if (!near(r.charging[n], sc.today.charging[L[n]])) diffs.push(`${where} charging ${L[n]}: graph ${r.charging[n]}, relay ${sc.today.charging[L[n]]}`);
      if (!near(r.viaEps, sc.today.viaEps)) diffs.push(`${where} EPS carried: graph ${r.viaEps}, relay ${sc.today.viaEps}`);
      // With minimums: who drops out, and that containment never does while there's power for it.
      const m = SOLVER.solve(g, rt);
      for (const cid of m.dropped) if (r.got[cid] > 1e-9) minNotes.push(`${where}: ${all[cid].key} (wanted ${Math.round(r.want[cid] * 10) / 10}, got ${Math.round(r.got[cid] * 10) / 10}; its minimum ${Math.round(r.min[cid] * 10) / 10})`);
      for (const cid of r.consumers.filter((c) => /containment/.test(all[c].type))) assert.ok(m.got[cid] >= r.got[cid] - 1e-6, `${where}: containment never loses power to minimums`);
      compared++;
    }
  }
  if (diffs.length) console.log(diffs.slice(0, 60).join('\n'));
  assert.equal(diffs.length, 0, `${diffs.length} differences between the solvers`);
  step(`the graph solver and the relay's agree on every load, source, battery, crosslink and charge, in ${compared} ship states (${Object.keys(d.scenarios).length} classes × ${Object.keys(d.scenarios.runabout).length} states)`);
  console.log(`# with minimums, the graph solver powers off what can't work on what it gets (${minNotes.length}):`);
  for (const n of minNotes) console.log(`#   ${n}`);
  // Heat, in the graph solver only: the runabout in the all-on state for ten minutes, radiators working,
  // stays cool; with its radiators' pumps off, the sink fills, then its systems warm (their effects
  // weaken past 70%) and overheat (damage past 90%).
  {
    const design = JSON.parse(fs.readFileSync(path.join(CONFIG.DIR, 'ships', 'runabout.json'), 'utf8'));
    const g = GRAPH.convert('runabout', design, d), sc = d.scenarios.runabout['all-on'];
    const r = SOLVER.solve(g, SOLVER.fromRelay(g, sc.state, t));
    const cool = {}, hot = {};
    let a, b;
    for (let i = 0; i < 600; i++) a = SOLVER.heatStep(g, r, cool, { pumps: true });
    assert.ok(a.kept === 0 && Object.values(cool.temp).every((x) => x === 0), `radiators on: nothing builds up (made ${a.made.toFixed(1)}/s, dumped ${a.dumped.toFixed(1)}/s)`);
    let weakAt = null, damageAt = null;
    for (let i = 1; i <= 3600 && damageAt === null; i++) { b = SOLVER.heatStep(g, r, hot, { pumps: false }); if (weakAt === null && Object.values(b.strength).some((x) => x < 1)) weakAt = i; if (b.damage.length) damageAt = i; }
    assert.ok(weakAt !== null && damageAt !== null && weakAt < damageAt, `pumps off: effects weaken (${weakAt} s), then damage (${damageAt} s)`);
    step(`heat (graph solver only): the runabout at full stretch makes ${a.made.toFixed(1)}/s and its radiators dump it; with their pumps off the heat sink fills, effects weaken after ${weakAt} s and systems overheat after ${damageAt} s`);
  }
  assert.ok(minNotes.length > 0, 'the starved states have loads the relay half-powers');
  step(`with minimums: ${minNotes.length} loads the relay half-powers (consoles dark anyway, subsystems that can't work) get nothing instead and pass their power on; containment never loses out`);
  ok = true;
} catch (err) {
  console.error('FAIL:', err.message);
}
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
