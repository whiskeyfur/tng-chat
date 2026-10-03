// The graph solver (step 2 of ship graphs; docs/ship-graph.md): who gets how much power, worked out
// from a ship's graph (config/ships-graph/<class>.json) and its runtime state, alongside the relay's
// own solver (server.js flow()), which play still uses. test/solver.js runs both on every class in a
// set of grid states and requires the same answers.
//
// The rules, from the graph:
// - Each bus (and the EPS manifold) draws on its sources in the order the graph lists them, then on
//   the EPS through its tap (up to the tap's rate), and on its last-resort sources (batteries, the
//   EPS's pressure, emergency batteries) only when nothing else will do. Crosslinked buses are one
//   pool, power crossing only the ways their links allow. A source tied to several buses gives each
//   an even share first.
// - Loads are served in "pri" order (lower first): containment ahead of everything, each from its
//   feeds in turn; then loads on one bus (each bus in turn, then its battery charges), on two, on
//   three, each split evenly; then what's still short, from any share left; then the batteries.
// - "min": a load that can't get its minimum gets nothing, and the power goes on to the next (the
//   solver works it out again without it until nothing more falls short).
// - A load gets a bus's power only while every conduit on its path (its place; life support's) is
//   tied to that bus too.
const GRAPH = require('./ship-graph');

function solve(g, rt, { enforceMin = true } = {}) {
  const off = new Set();
  let r;
  // (Loads that fall short of their minimum drop out, one round at a time, until none do.)
  for (let round = 0; round < 50; round++) {
    r = once(g, rt, off);
    if (!enforceMin) break;
    // (Containment, served ahead of everything, never drops out: what it gets holds the antimatter.)
    const failing = r.consumers.filter((id) => !off.has(id) && r.pri[id] >= 1000 && r.want[id] > 0 && r.got[id] > 1e-9 && r.got[id] < r.min[id] - 1e-9);
    if (!failing.length) break;
    for (const id of failing) off.add(id);
  }
  r.dropped = [...off];
  return r;
}

function once(g, rt, off) {
  const { all } = GRAPH.nodes(g);
  const lib = GRAPH.types();
  const ids = Object.keys(all);
  const typeOf = (id) => lib[all[id].type] || {};
  const lows = ids.filter((id) => all[id].type === 'bus');
  const eps = ids.find((id) => all[id].type === 'eps-manifold');
  const NODES = [...lows, eps];
  const isNode = (id) => NODES.includes(id);
  const lastResort = (id) => !!typeOf(id).lastResort;
  const resOf = (n) => (n === eps ? 'eps' : 'power');

  // Sources (and stores): what each could give, where it's tied, an even share each when it's several.
  const srcIds = ids.filter((id) => ['source', 'store'].includes(typeOf(id).role) && NODES.some((n) => all[n].upstream?.[id]));
  const srcs = srcIds.map((id) => {
    const ties = NODES.filter((n) => all[n].upstream?.[id] && rt.on(n, id));
    // (Creative on what it gives (a starbase, a GM object): never runs dry while it's there; each
    // link's rate still limits it.)
    const creative = ties.some((n) => all[id].creative?.[resOf(n)]);
    const rate = ties.reduce((m, n) => m + (all[n].upstream[id][resOf(n)]?.rate ?? Infinity), 0);
    const avail = ties.length ? rt.supply(id) : 0;
    // (There to give: a feed while its connection is (a starbase while docked); a store or a tank always.)
    const there = avail > 0 || typeOf(id).role === 'store';
    const full = Math.min(creative && there ? Infinity : avail, rate);
    return { id, ties, left: full, full, given: 0, creative, share: ties.length > 1 ? Object.fromEntries(ties.map((n) => [n, full / ties.length])) : null };
  });
  const srcById = Object.fromEntries(srcs.map((s) => [s.id, s]));
  const blank = () => Object.fromEntries(NODES.map((n) => [n, 0]));
  const cells = {};
  const cell = (id) => (cells[id] ||= blank());
  const bus = Object.fromEntries(lows.map((n) => [n, { need: 0, have: 0, tapUsed: 0 }]));
  let viaEps = 0;

  // The crosslink: pools of buses whose links are closed, and which ways power may cross them.
  const pair = (a, b) => (all[b].upstream?.[a] ? [b, a] : all[a].upstream?.[b] ? [a, b] : null); // [down, up]
  const joined = (a, b) => { const p = pair(a, b); return !!p && rt.on(p[0], p[1]); };
  const poolOf = {};
  for (const n of lows) {
    if (poolOf[n]) continue;
    const seen = new Set([n]), todo = [n];
    while (todo.length) { const x = todo.pop(); for (const y of lows) if (!seen.has(y) && joined(x, y)) { seen.add(y); todo.push(y); } }
    for (const x of seen) poolOf[x] = seen;
  }
  const pool = (n) => [...poolOf[n]];
  // (Power from one bus into another: along the chain of closed links, each crossing allowed that way.)
  const route = (from, to) => {
    if (from === to) return [from];
    const prev = { [from]: null }, todo = [from];
    while (todo.length) { const x = todo.shift(); for (const y of lows) if (!(y in prev) && joined(x, y)) { prev[y] = x; todo.push(y); } }
    if (!(to in prev)) return null;
    const path = [to];
    while (prev[path[0]] !== null) path.unshift(prev[path[0]]);
    return path;
  };
  const xlOk = (from, to) => { const p = route(from, to); return !!p && p.every((x, i) => i === 0 || rt.crossOk(p[i - 1], x)); };
  const crossflow = {};
  const xflow = (from, to, t) => {
    const p = from === to || t <= 0 ? null : route(from, to);
    if (!p) return;
    for (let i = 1; i < p.length; i++) { const [a, b] = [p[i - 1], p[i]], key = [a, b].sort().join('|'); crossflow[key] = (crossflow[key] || 0) + (a < b ? t : -t); }
  };
  const taps = Object.fromEntries(lows.map((n) => [n, all[n].upstream?.[eps] ? rt.tap(n) : 0]));
  const maxOf = (n) => rt.busMax(n);
  const busRoom = (n) => pool(n).reduce((m, x) => m + maxOf(x) - bus[x].have, 0);
  const tapRoom = (n) => pool(n).reduce((m, x) => m + Math.max(0, taps[x] - bus[x].tapUsed), 0);

  let storesOk = false;
  const take = (node, amt, topUp = false) => {
    let got = 0;
    const b = bus[node];
    const pull = (s, viaTap, side = node) => {
      if (viaTap && !rt.epsLive) return;
      if (b && !viaTap && side !== node && !xlOk(side, node)) return;
      const room = Math.min(b ? busRoom(node) - got : Infinity, viaTap ? maxOf(eps) - viaEps : Infinity, b && viaTap ? tapRoom(node) : Infinity);
      const t = Math.min(s.left, amt - got, room, s.share && !viaTap ? s.share[side] : Infinity);
      if (t <= 0) return;
      s.left -= t; s.given += t; got += t;
      if (s.share && !viaTap) s.share[side] -= t;
      cell(s.id)[viaTap ? eps : side] += t;
      if (viaTap) viaEps += t;
      if (b && !viaTap) xflow(side, node, t);
      if (b && viaTap) { let rest = t; for (const x of [node, ...pool(node).filter((y) => y !== node && xlOk(y, node))]) { const u = Math.min(rest, Math.max(0, taps[x] - bus[x].tapUsed)); bus[x].tapUsed += u; rest -= u; xflow(x, node, u); } }
    };
    const sides = b ? pool(node) : [node];
    for (const last of storesOk ? [false, true] : [false]) {
      for (const side of sides) for (const s of srcs) if (lastResort(s.id) === last && s.ties.includes(side)) pull(s, node === eps, side);
      if (b) for (const s of srcs) if (lastResort(s.id) === last && s.ties.includes(eps)) pull(s, true);
    }
    if (b) { if (!topUp) b.need += amt; b.have += got; }
    return got;
  };

  // The loads: what each wants, where it's tied (and every conduit on its path too), its pri and min.
  const consumers = ids.filter((id) => typeOf(id).role === 'load' && NODES.some((n) => all[id].upstream?.[n]));
  const path = (id) => [all[id].place, all[id].via].filter((x) => x && all[x]);
  const tiesFor = (id) => NODES.filter((n) => all[id].upstream?.[n] && rt.on(id, n) && path(id).every((c) => all[c].upstream?.[n] && rt.on(c, n)));
  const priOf = (id) => Math.min(...NODES.map((n) => all[id].upstream?.[n]?.[resOf(n)]?.pri).filter((x) => x !== undefined), Infinity);
  const want = Object.fromEntries(consumers.map((id) => [id, off.has(id) ? 0 : rt.want(id)]));
  const min = Object.fromEntries(consumers.map((id) => { const m = NODES.map((n) => all[id].upstream?.[n]?.[resOf(n)]?.min).find((x) => x !== undefined); return [id, m === 'all' ? rt.want(id) : m || 0]; }));
  const got = Object.fromEntries(consumers.map((id) => [id, 0]));
  const byPri = [...consumers].sort((a, b) => priOf(a) - priOf(b));
  const serve = (id, amt, topUp = false) => {
    const ties = tiesFor(id);
    if (!ties.length || amt <= 0) return 0;
    let g2 = 0;
    if (topUp) { for (const n of ties) { const t = take(n, amt - g2, true); cell(id)[n] += t; g2 += t; } return g2; }
    const part = amt / ties.length;
    for (const n of ties) { const t = take(n, part); cell(id)[n] += t; g2 += t; }
    return g2;
  };
  // (Containment, pri under 1000: from each feed in turn, the batteries straight away if short.)
  for (const id of byPri.filter((x) => priOf(x) < 1000)) {
    const ties = tiesFor(id);
    for (const n of ties) if (got[id] < want[id]) { const t = take(n, want[id] - got[id]); cell(id)[n] += t; got[id] += t; }
    storesOk = true;
    for (const n of ties) if (got[id] < want[id]) { const t = take(n, want[id] - got[id], true); cell(id)[n] += t; got[id] += t; }
    storesOk = false;
  }
  // Charging a bus's battery from what's left: its breaker closed, and not covering a shortfall itself.
  const charging = blank();
  const storeOf = (n) => srcs.find((s) => typeOf(s.id).role === 'store' && all[n].upstream?.[s.id]);
  const usedOf = (s) => (s ? s.given : 0);
  const chargeFrom = (n, split) => {
    const st = storeOf(n);
    if (!st || !rt.on(n, st.id) || usedOf(st) > 0) return;
    const link = all[n].upstream[st.id][resOf(n)];
    const room = Math.min(link.pushRate ?? link.rate ?? Infinity, all[st.id].creative?.[resOf(n)] ? Infinity : (all[st.id].capacity?.[resOf(n)] ?? Infinity) - rt.level(st.id));
    for (const x of srcs) {
      if (lastResort(x.id) || charging[n] >= room || (!split && x.ties.length > 1) || (!rt.epsLive && x.ties.includes(eps))) continue;
      const sides = pool(n), direct = sides.some((y) => x.ties.includes(y));
      if (!(direct || (tapRoom(n) > 0 && x.ties.includes(eps)))) continue;
      const via = sides.find((y) => x.ties.includes(y));
      const t = Math.min(x.left, room - charging[n], busRoom(n), direct ? (x.share ? x.share[via] : Infinity) : tapRoom(n));
      if (t <= 0) continue;
      x.left -= t; x.given += t; charging[n] += t;
      if (direct && x.share) x.share[via] -= t;
      bus[n].need += t; bus[n].have += t;
      if (direct) xflow(via, n, t);
      if (!direct) { viaEps += t; let rest = t; for (const y of sides) { const u = Math.min(rest, Math.max(0, taps[y] - bus[y].tapUsed)); bus[y].tapUsed += u; rest -= u; xflow(y, n, u); } }
      cell(st.id)[n] -= t;
      cell(x.id)[direct ? via : eps] += t;
    }
  };
  // Everything else: on one bus (each bus in turn, then its battery), on two, on three.
  const rest = byPri.filter((x) => priOf(x) >= 1000);
  const order = [];
  for (const n of NODES) {
    for (const id of rest) { const t = tiesFor(id); if (t.length === 1 && t[0] === n) { order.push(id); got[id] = serve(id, want[id]); } }
    if (n !== eps) chargeFrom(n, false);
  }
  for (const k of [2, 3, 4]) for (const id of rest) if (tiesFor(id).length === k) { order.push(id); got[id] = serve(id, want[id]); }
  for (const s of srcs) s.share = null;
  for (const id of order) if (got[id] < want[id] - 1e-9) got[id] += serve(id, want[id] - got[id], true);
  storesOk = true;
  for (const id of order) if (got[id] < want[id] - 1e-9) got[id] += serve(id, want[id] - got[id], true);
  for (const n of lows) chargeFrom(n, true);
  // The EPS's pressure builds from what's left of the EPS sources' output.
  const press = storeOf(eps);
  const epsGen = srcs.filter((x) => !lastResort(x.id) && x.ties.includes(eps)).reduce((m, x) => m + (Number.isFinite(x.full) ? x.full : rt.epsChargeGen), 0);
  if (press && usedOf(press) <= 0 && (rt.epsLive || epsGen >= rt.epsChargeGen)) {
    const link = all[eps].upstream[press.id].eps;
    const room = Math.min(link.pushRate ?? link.rate ?? Infinity, all[press.id].creative?.eps ? Infinity : (all[press.id].capacity?.eps ?? Infinity) - rt.level(press.id), maxOf(eps) - viaEps);
    for (const x of srcs) {
      if (lastResort(x.id) || !x.ties.includes(eps) || charging[eps] >= room) continue;
      const t = Math.min(x.left, room - charging[eps]);
      if (t <= 0) continue;
      x.left -= t; x.given += t; charging[eps] += t; viaEps += t;
      cell(press.id)[eps] -= t; cell(x.id)[eps] += t;
    }
  }
  const tapUsed = Object.fromEntries(lows.map((n) => [n, bus[n].tapUsed]));
  return { cells, got, want, min, consumers, crossflow, charging, viaEps, tapUsed, buses: bus, pri: Object.fromEntries(consumers.map((id) => [id, priOf(id)])), used: Object.fromEntries(srcs.map((s) => [s.id, usedOf(s)])) };
}

// Today's relay state as a graph runtime (the bridge while both solvers run): its ties, taps,
// breakers, crosslink, what each source could give and each load wants.
function fromRelay(g, st, tables) {
  const { all } = GRAPH.nodes(g);
  const L = { 'bus-a': 'A', 'bus-b': 'B', 'bus-c': 'C', eps: 'EPS' };
  const keyOf = (id) => all[id]?.key;
  // (Power out to the starbase or a docked ship goes the way it comes in: its connection's tie.)
  const tieKey = (k) => ({ 'feed:station': 'dock', 'feedEps:station': 'dockEps' })[k] || (k?.startsWith('feedEps:') ? 'shipEps' : k?.startsWith('feed:') ? 'ship' : k);
  return {
    letters: L,
    epsLive: st.epsLive,
    epsChargeGen: tables.EPS_CHARGE_GEN,
    on(down, up) {
      if (L[down] && L[up]) {
        if (up === 'eps') return st.coresUp && (st.taps[L[down]] || 0) > 0;
        return st.ties.crosslink.includes(L[down]) && st.ties.crosslink.includes(L[up]);
      }
      if (L[down]) { // a source or store on a bus
        const k = keyOf(up);
        if (k in tables.STORES) return tables.STORES[k] === 'EPS' || !!st.breakers[tables.STORES[k]];
        return (st.ties[k] || []).includes(L[down]);
      }
      return (st.ties[tieKey(keyOf(down))] || []).includes(L[up]); // a load or conduit on a bus
    },
    crossOk: (from, to) => !st.xlBlock.includes(`${L[from]}>${L[to]}`),
    // The corridors (graph.layout; the path tracer's): a link carries a bus while it's closed for it (its
    // layout's default, unless Engineering set it) and isn't cut (damaged 50% or more).
    linkOn: (id, n) => { if ((st.linkDamage?.[id] || 0) >= 50) return false; const set = st.links?.[id]?.[L[n]]; return set ?? !!(g.layout?.links || []).find((l) => l.id === id)?.closed; },
    supply: (id) => st.srcCap[keyOf(id)] || 0,
    want: (id) => st.wants[keyOf(id)] || 0,
    tap: (n) => (st.coresUp ? st.taps[L[n]] || 0 : 0),
    busMax: (n) => st.busMax[L[n]],
    level: (id) => st.stores[keyOf(id)] ?? 0,
  };
}

// Heat (step 2: the graph solver only, not in play yet). One tick of dt seconds after a solve: each
// system makes heat for what it actually handled (its share, from its "produces.heat" at full);
// the coolant loop carries it to the radiators (each dumps up to its rate while its pumps have power)
// and the heat sink (which holds what they can't, up to its capacity). What neither can take stays in
// the systems that made it: each warms (temperature 0 cold, 1 at its limit). Past "warm" its effects
// weaken (strength falls to half by "hot"); past "hot" it takes damage.
// state: { temp: { id: 0..1+ }, sink: heat held } (kept between ticks). Returns what happened.
function heatStep(g, r, state, { dt = 1, pumps = true } = {}) {
  const { all } = GRAPH.nodes(g);
  const lib = require('./config').systemTypes();
  const { warm, hot } = lib.heat.temperature;
  state.temp ||= {}; state.sink ||= 0;
  const loop = Object.keys(all).find((id) => all[id].type === 'coolant-loop');
  const makers = loop ? Object.keys(all[loop].upstream).filter((id) => all[id].type !== 'heat-sink' && all[id].produces?.heat) : [];
  // (What each made: its full-power heat, scaled by what it handled of its full draw or output.)
  const made = {};
  for (const id of makers) {
    const s = all[id], full = Object.entries(s.consumes || {}).concat(Object.entries(s.produces || {})).filter(([k]) => k === 'power' || k === 'eps').reduce((n, [, v]) => n + v, 0);
    const now = r.consumers.includes(id) ? r.got[id] || 0 : r.used[id] || 0;
    made[id] = full ? (s.produces.heat * Math.min(1, now / full)) * dt : 0;
  }
  const total = Object.values(made).reduce((a, b) => a + b, 0);
  const radiators = Object.keys(all).filter((id) => all[id].type === 'radiator');
  const dumpCap = pumps ? radiators.reduce((n, id) => n + (all[id].upstream[loop]?.heat?.rate || 0), 0) * dt : 0;
  const sinkId = Object.keys(all).find((id) => all[id].type === 'heat-sink'), sinkCap = sinkId ? all[sinkId].capacity.heat : 0;
  // (The radiators first, from the sink too; then the sink fills; then the systems keep the rest.)
  let dumped = Math.min(dumpCap, total + state.sink);
  const fromSink = Math.max(0, dumped - total);
  state.sink -= fromSink;
  const over = Math.max(0, total - dumped);
  const toSink = Math.min(over, sinkCap - state.sink);
  state.sink += toSink;
  const kept = over - toSink;
  // (Kept heat warms each system by its share of what was made; a system's limit is a minute of its own full heat.)
  for (const id of makers) {
    const limit = all[id].produces.heat * 60;
    const share = total ? made[id] / total : 0;
    const was = state.temp[id] || 0;
    // (Cooling: what the loop took away, back toward cold, a little each tick.)
    state.temp[id] = Math.max(0, was + (kept * share) / limit - (kept ? 0 : 0.02 * dt));
  }
  const strength = {}, damage = [];
  for (const id of makers) {
    const tmp = state.temp[id];
    strength[id] = tmp <= warm ? 1 : tmp >= hot ? 0.5 : 1 - (0.5 * (tmp - warm)) / (hot - warm);
    if (tmp > hot) damage.push(id);
  }
  return { made: total, dumped, sink: state.sink, kept, strength, damage };
}

module.exports = { solve, fromRelay, heatStep };
