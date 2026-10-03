// The path-tracing solver (John's: docs/ship-graph.md), alongside the graph solver (tools/graph-solver.js),
// which play uses. test/path-solver.js runs both on every class in the same grid states and lists
// where they differ. The rules:
// - Sources: the live generators first, then the stores (batteries, the EPS's pressure, emergency
//   batteries); within each, the nearest first (the fewest links to the consumer), the most power on
//   hand of those. A creative source (a starbase's) never runs short; its link's rate still limits it.
// - Consumers, in "pri" order (lower first: antimatter containment ahead of everything). Each one,
//   from each source in turn: a path from the source to it through the graph (buses, the EPS and its
//   taps, the crosslink, the conduits on its own path), each link limited to what it has left (its
//   rate; a bus to its limit). The source gives what the path can carry; every node along the way
//   records it passing through (+x in, -x out). A consumer may draw on several sources and paths.
// - A consumer that can't reach its "min" is rolled back (its sources, links and pass-through as they
//   were): the power goes on to the next. Containment is never rolled back.
// - What's left charges the batteries, then the EPS's pressure, each up to its link's push rate.
// - A docked group is one graph: each vessel's export to the other's dock feed is a link across the
//   dock, at the dock's rate, only the ways its exports and imports allow. A consumer draws on its own
//   vessel's sources first, then across the dock.
// Nothing is changed in the graphs or the runtimes: the answer is returned (the relay posts it).
const GRAPH = require('./ship-graph');

const EPS = 1e-9;
const resOf = (all, n) => (all[n]?.type === 'eps-manifold' ? 'eps' : 'power');

// members: [{ g, rt, name }] (rt as tools/graph-solver.js fromRelay); docks: [{ from: [member,
// exportId], to: [member, dockFeedId], rate }]; opts: { enforceMin, networkOnly }.
// Returns { members: [per vessel, as solve()], dropped }.
function solveGroup(members, docks = [], opts = {}) {
  const { enforceMin = true } = opts;
  const lib = GRAPH.types();
  const node = {}; // key -> { m, id, kind: 'bus' | 'eps' | 'source' | 'load' | 'pass', cap, used, left, ... }
  const out = {}; // key -> [edge]
  const K = (m, id) => `${m}\u0000${id}`;
  const edge = (from, to, cap, extra = {}) => { (out[from] ||= []).push({ from, to, cap, used: 0, ...extra }); };
  const passing = new Set(docks.flatMap((d) => [K(d.from[0], d.from[1]), K(d.to[0], d.to[1])]));
  const layouts = []; // per member: its corridors (graph.layout), or null

  members.forEach(({ g, rt }, m) => {
    const { all } = GRAPH.nodes(g);
    const ids = Object.keys(all), typeOf = (id) => lib[all[id].type] || {};
    const lows = ids.filter((id) => all[id].type === 'bus'), eps = ids.find((id) => all[id].type === 'eps-manifold');
    // (An EPS that isn't live carries nothing: no source into it, no load or tap out of it.)
    const NODES = [...lows, ...(eps && rt.epsLive ? [eps] : [])];
    // Corridors (graph.layout): each bus, and the EPS, a segment in every place and corridor, starting
    // at home (Engineering) and joined along the links that are closed for it and not cut.
    const lay = g.layout || null;
    layouts[m] = lay;
    const locs = lay ? [...(lay.corridors || []).map((c) => c.id), ...(g.places || []).map((p) => p.id)] : [];
    const linkOn = (l, n) => (rt.linkOn ? rt.linkOn(l.id, n) : !!l.closed);
    const B = (n) => K(m, lay ? `${n}@${lay.home}` : n); // (a bus where its sources are: home)
    const S = (n, loc) => (lay && loc && locs.includes(loc) ? K(m, `${n}@${loc}`) : B(n)); // (a bus in a place)
    for (const n of NODES) {
      const cap = n === eps ? rt.busMax(n) ?? Infinity : rt.busMax(n);
      if (!lay) node[K(m, n)] = { m, id: n, kind: n === eps ? 'eps' : 'bus', cap, used: 0 };
      else for (const loc of locs) node[K(m, `${n}@${loc}`)] = { m, id: n, loc, kind: n === eps ? 'eps' : 'bus', cap, used: 0 };
    }
    if (lay) for (const l of lay.links || []) for (const n of NODES) if (linkOn(l, n)) { edge(S(n, l.a), S(n, l.b), Infinity, { seg: l.id }); edge(S(n, l.b), S(n, l.a), Infinity, { seg: l.id }); }
    // Sources into the buses and the EPS (and the batteries' charge back, later).
    for (const id of ids) {
      if (!['source', 'store'].includes(typeOf(id).role)) continue;
      const ties = NODES.filter((n) => all[n].upstream?.[id] && rt.on(n, id));
      if (!ties.length && !passing.has(K(m, id))) continue;
      const creative = ties.some((n) => all[id].creative?.[resOf(all, n)]);
      const avail = rt.supply(id);
      const there = avail > 0 || typeOf(id).role === 'store';
      if (passing.has(K(m, id))) node[K(m, id)] = { m, id, kind: 'pass', cap: Infinity, used: 0 };
      else node[K(m, id)] = { m, id, kind: 'source', last: !!typeOf(id).lastResort, store: typeOf(id).role === 'store', creative: creative && there, left: creative && there ? Infinity : avail, given: 0 };
      for (const n of ties) edge(K(m, id), B(n), all[n].upstream[id][resOf(all, n)]?.rate ?? Infinity);
    }
    // The crosslink: a closed link joins two buses, power crossing each way it allows.
    for (const a of lows) for (const b of lows) {
      if (a === b || !all[a].upstream?.[b] || !rt.on(a, b)) continue;
      if (rt.crossOk(a, b)) edge(B(a), B(b), Infinity, { cross: true });
      if (rt.crossOk(b, a)) edge(B(b), B(a), Infinity, { cross: true });
    }
    // The EPS taps: from the EPS into each bus, up to its tap (while the EPS is live).
    if (eps && rt.epsLive) for (const n of lows) if (all[n].upstream?.[eps] && rt.on(n, eps)) edge(B(eps), B(n), rt.tap(n), { tap: true });
    // Loads (and exports across a dock): from each bus they're tied to, every conduit on their path tied there too.
    const via = (id) => [all[id].place, all[id].via].filter((x) => x && all[x]);
    for (const id of ids) {
      if (typeOf(id).role !== 'load' || !NODES.some((n) => all[id].upstream?.[n])) continue;
      const ties = NODES.filter((n) => all[id].upstream?.[n] && rt.on(id, n) && via(id).every((c) => all[c].upstream?.[n] && rt.on(c, n)));
      const links = NODES.map((n) => all[id].upstream?.[n]?.[resOf(all, n)]).filter(Boolean);
      const pri = Math.min(...links.map((l) => l.pri).filter((x) => x !== undefined), Infinity);
      const m0 = links.map((l) => l.min).find((x) => x !== undefined);
      if (passing.has(K(m, id))) node[K(m, id)] = { m, id, kind: 'pass', cap: Infinity, used: 0 };
      else { const want = rt.want(id); node[K(m, id)] = { m, id, kind: 'load', want, pri, min: m0 === 'all' ? want : m0 || 0, got: 0 }; }
      for (const n of ties) edge(S(n, all[id].place), K(m, id), Infinity, { through: via(id).map((c) => K(m, c)) });
    }
  });
  // Across each dock: the export on one side into the dock feed on the other, at the dock's rate.
  for (const d of docks) edge(K(d.from[0], d.from[1]), K(d.to[0], d.to[1]), d.rate ?? Infinity, { dock: true });
  // (The network alone, as built: for the SQL version's comparison, tools/bench.js.)
  if (opts.networkOnly) return { node, out };

  const through = {}; // key -> power passed through it this tick
  const room = (e) => e.cap - e.used;
  const nodeRoom = (k) => { const n = node[k]; return n.kind === 'bus' || n.kind === 'eps' || n.kind === 'pass' ? n.cap - n.used : Infinity; };
  // A path from a source to a target with room left on every link and node: the fewest hops.
  const findPath = (src, target) => {
    const prev = { [src]: null }, todo = [src];
    while (todo.length) {
      const x = todo.shift();
      for (const e of out[x] || []) {
        if (e.to in prev || room(e) <= EPS) continue;
        const k = node[e.to];
        if (!k) continue;
        if (e.to !== target && !['bus', 'eps', 'pass'].includes(k.kind)) continue; // (through buses, the EPS and docks only)
        if (e.to !== target && nodeRoom(e.to) <= EPS) continue;
        prev[e.to] = e;
        if (e.to === target) { const p = []; for (let y = target; prev[y]; y = prev[y].from) p.unshift(prev[y]); return p; }
        todo.push(e.to);
      }
    }
    return null;
  };
  // Power along a path (recorded so it can be rolled back).
  const send = (s, p, amt, log) => {
    s.left -= amt; s.given += amt;
    for (const e of p) {
      e.used += amt;
      if (node[e.to].kind !== 'load' && node[e.to].kind !== 'source') { node[e.to].used += amt; through[e.to] = (through[e.to] || 0) + amt; }
      for (const c of e.through || []) through[c] = (through[c] || 0) + amt;
    }
    log.push([s, p, amt]);
  };
  const undo = (log) => {
    for (const [s, p, amt] of log) {
      s.left += amt; s.given -= amt;
      for (const e of p) {
        e.used -= amt;
        if (node[e.to].kind !== 'load' && node[e.to].kind !== 'source') { node[e.to].used -= amt; through[e.to] -= amt; }
        for (const c of e.through || []) through[c] -= amt;
      }
    }
  };
  const sources = Object.keys(node).filter((k) => node[k].kind === 'source');
  // For a consumer on vessel m, its sources in tiers: its own vessel's generators, its own stores,
  // then across a dock the same. Within a tier, the nearest first (the fewest links: what's on a
  // load's own bus before what comes through the EPS's taps), the most on hand of those.
  const tier = (k, m) => (node[k].m !== m) * 2 + node[k].last;
  const draw = (target, amt, m, { stores = true } = {}) => {
    const log = [];
    let got = 0;
    for (const t0 of [0, 1, 2, 3]) {
      if (!stores && t0 % 2) continue;
      for (;;) {
        if (got >= amt - EPS) return { got, log };
        // (The next source and path in this tier.)
        let best = null;
        for (const k of sources) {
          if (tier(k, m) !== t0 || node[k].left <= EPS) continue;
          const p = findPath(k, target);
          if (!p) continue;
          if (!best || p.length < best.p.length || (p.length === best.p.length && node[k].left > node[best.k].left)) best = { k, p };
        }
        if (!best) break;
        const s = node[best.k], p = best.p;
        const t = Math.min(s.left, amt - got, ...p.map(room), ...p.slice(0, -1).map((e) => nodeRoom(e.to)));
        if (t <= EPS) break;
        send(s, p, t, log);
        got += t;
      }
    }
    return { got, log };
  };

  // The consumers, by pri (containment first), each served or rolled back.
  const loads = Object.keys(node).filter((k) => node[k].kind === 'load').sort((a, b) => node[a].pri - node[b].pri);
  const dropped = [];
  for (const k of loads) {
    const l = node[k];
    if (l.want <= 0) continue;
    const { got, log } = draw(k, l.want, l.m);
    if (enforceMin && l.pri >= 1000 && got > EPS && got < l.min - EPS) { undo(log); dropped.push(k); continue; }
    l.got = got;
  }
  // What's left charges the batteries (each up to its push rate and its room), then the EPS's pressure.
  const charging = {};
  members.forEach(({ g, rt }, m) => {
    const { all } = GRAPH.nodes(g);
    const typeOf = (id) => lib[all[id].type] || {};
    const NODES = Object.keys(all).filter((id) => ['bus', 'eps-manifold'].includes(all[id].type));
    for (const n of NODES) {
      const st = Object.keys(all[n].upstream || {}).find((u) => typeOf(u).role === 'store');
      const s = st && node[K(m, st)];
      if (!s || s.kind !== 'source' || s.given > EPS || !rt.on(n, st)) continue;
      const link = all[n].upstream[st][resOf(all, n)];
      const r = resOf(all, n);
      const want = Math.min(link.pushRate ?? link.rate ?? Infinity, all[st].creative?.[r] ? Infinity : (all[st].capacity?.[r] ?? Infinity) - rt.level(st));
      if (!(want > EPS)) continue;
      // (Into the store from its bus: a target of its own, fed from the generators only.)
      const tk = K(m, `${st}\u0000charge`), home = K(m, layouts[m] ? `${n}@${layouts[m].home}` : n);
      if (!node[home]) continue;
      node[tk] = { m, id: st, kind: 'load', want, got: 0 };
      edge(home, tk, Infinity);
      const { got } = draw(tk, want, m, { stores: false });
      charging[home] = got;
    }
  });

  // Each vessel's answer, in the graph solver's shape (cells: what each source gave to, and each load
  // took from, each bus; the crosslink; charging; what the EPS carried), with pass-through.
  return {
    dropped,
    members: members.map(({ g }, m) => {
      const { all } = GRAPH.nodes(g);
      const mine = (k) => node[k]?.m === m;
      const cells = {}, crossflow = {}, used = {}, got = {}, want = {}, min = {}, pri = {}, pass = {};
      const cell = (id, n, t) => { (cells[id] ||= {})[n] = ((cells[id] || {})[n] || 0) + t; };
      for (const list of Object.values(out)) for (const e of list) {
        if (e.used <= EPS || !mine(e.from) && !mine(e.to)) continue;
        const a = node[e.from], b = node[e.to];
        if (a.kind === 'source' && a.m === m && (b.kind === 'bus' || b.kind === 'eps')) cell(a.id, b.id, e.used);
        if (b.kind === 'load' && b.m === m && (a.kind === 'bus' || a.kind === 'eps')) cell(b.id, a.id, e.used);
        if (b.kind === 'load' && b.m === m && /\u0000charge$/.test(e.to)) cell(b.id, a.id, -e.used);
        if (e.cross && a.m === m) { const key = [a.id, b.id].sort().join('|'); crossflow[key] = (crossflow[key] || 0) + (a.id < b.id ? e.used : -e.used); }
      }
      for (const [k, v] of Object.entries(node)) {
        if (v.m !== m) continue;
        if (v.kind === 'source') used[v.id] = (used[v.id] || 0) + v.given;
        if (v.kind === 'load' && !/\u0000charge$/.test(k)) { got[v.id] = v.got; want[v.id] = v.want; min[v.id] = v.min; pri[v.id] = v.pri; }
      }
      for (const [k, t] of Object.entries(through)) if (mine(k) || k.split('\u0000')[0] === String(m)) { const id = k.split('\u0000')[1]; if (t > EPS) pass[id] = t; }
      const ch = Object.fromEntries(Object.entries(charging).filter(([k]) => node[k].m === m).map(([k, t]) => [node[k].id, t]));
      const epsId = Object.keys(all).find((id) => all[id].type === 'eps-manifold'), lay = layouts[m];
      const atHome = (v) => !lay || v.loc === lay.home, homeKey = (n) => K(m, lay ? `${n}@${lay.home}` : n);
      // (Each bus as the relay shows it: what was asked of it, what it carried, what came in by its tap.)
      const buses = {};
      for (const [k, v] of Object.entries(node)) if (v.m === m && v.kind === 'bus' && atHome(v)) buses[v.id] = { need: 0, have: through[k] || 0, tapUsed: (out[homeKey(epsId)] || []).filter((e) => e.to === k).reduce((a, e) => a + e.used, 0) };
      for (const [k, v] of Object.entries(node)) {
        if (v.m !== m || v.kind !== 'load' || /\u0000charge$/.test(k)) continue;
        const from = Object.values(out).flat().filter((e) => e.to === k && node[e.from].kind === 'bus');
        for (const e of from) buses[node[e.from].id].need += e.used + Math.max(0, v.want - v.got) / from.length;
      }
      // (Corridors: what each segment carried, and where each bus reaches from home along its links.)
      const segments = lay ? Object.fromEntries(Object.entries(through).filter(([k, t]) => node[k]?.m === m && node[k].loc && t > EPS).map(([k, t]) => [`${node[k].id}@${node[k].loc}`, t])) : null;
      const reach = lay ? Object.fromEntries(Object.entries(node).filter(([k, v]) => v.m === m && v.loc === lay.home).map(([k, v]) => { const seen = new Set([k]), todo = [k]; while (todo.length) { const x = todo.pop(); for (const e2 of out[x] || []) if (e2.seg && !seen.has(e2.to)) { seen.add(e2.to); todo.push(e2.to); } } return [v.id, [...seen].map((x) => node[x].loc)]; })) : null;
      return { cells, got, want, min, pri, used, crossflow, charging: ch, buses, viaEps: (lay ? through[homeKey(epsId)] : pass[epsId]) || 0, ...(lay ? { segments, reach } : {}), through: pass, consumers: Object.keys(got), dropped: dropped.filter(mine).map((k) => node[k].id) };
    }),
  };
}

// One vessel on its own.
const solve = (g, rt, opts) => solveGroup([{ g, rt }], [], opts).members[0];

module.exports = { solve, solveGroup };
