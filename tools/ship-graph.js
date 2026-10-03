// Ship graphs (step 1 of moving designs to a graph of systems; docs/ship-graph.md): every system a
// class has (buses, places, consoles, systems, subsystems, sources, batteries, tanks, docking) and
// what each draws from (its upstream), per resource, with what's allowed on each link. Built here
// from the current design files as the relay reads them, so nothing in the game changes yet:
//   node tools/ship-graph.js runabout      writes config/ships-graph/runabout.json
//   node tools/ship-graph.js --all         every ship class
//   node tools/ship-graph.js --check       the files there are valid and up to date (exit 1 if not)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CONFIG = process.env.CONFIG_DIR || path.join(ROOT, 'config');
const OUT = path.join(CONFIG, 'ships-graph');
const SCHEMA = 'tng-ship-graph/1';
const TYPES_FILE = path.join(CONFIG, 'system-types.json');
// A link's permission, each way (pull: the downstream system may draw from the upstream one; push:
// it may send back): false, never; "warn", allowed but not advised; true, allowed; "auto", allowed
// and on when the vessel first loads.
const PERMS = [false, 'warn', true, 'auto'];
const RESOURCES = ['power', 'eps', 'odn', 'deu', 'am', 'heat'];

// What a system lets the vessel do, beyond moving a resource: what play asks for ("the best FTL
// aboard", "its shields") rather than a system's id. Each effect has its parameters, from the design;
// how much of it there is in play is how well the system is fed (supplied over required, its health).
function effectsOf(key, z) {
  const E = {
    'system:engines': { ftl: { maxWarp: z.maxWarp } }, 'system:deflector': { deflector: {} }, 'system:bussard': { 'fuel-collection': {} },
    'system:shields': { shields: { strength: z.shields } }, 'system:weapons': { torpedoes: { carried: z.torpedoes ?? 10 } },
    'system:tractor': { tractor: {} }, 'system:transporter': { transport: {} }, 'system:sensors': { sensors: { range: 'long' } }, 'system:lateral': { sensors: { range: 'lateral' } },
    'system:sif': { sif: {} }, 'system:idf': { dampers: {} }, 'system:gravity': { gravity: {} }, 'system:atmosphere': { 'life-support': { part: 'atmosphere' } },
    'system:thermal': { 'life-support': { part: 'thermal' } }, 'system:lights': { 'life-support': { part: 'lights' } }, 'system:lighting': { 'emergency-lighting': {} },
    'system:replicators': { replication: {} }, 'system:recreation': { recreation: {} }, 'system:spore': { jump: {} }, 'system:sporeGrow': { 'spore-cultivation': {} },
    'system:amBus': { 'antimatter-transfer': {} }, 'system:industrial': { industry: {} },
    impulsePort: { impulse: {} }, impulseStarboard: { impulse: {} }, thrustersPort: { maneuver: {} }, thrustersStarboard: { maneuver: {} },
    'sub:forcefields': { 'force-fields': {} }, 'sub:brigField': { brig: {} }, 'sub:holoEmitters': { holo: {} }, 'sub:bayDoors': { 'shuttle-bay': { slots: z.bay } },
    'sub:rf': { comms: { range: 'aboard' } }, 'sub:radio': { comms: { range: 'hails' } }, 'sub:subspace': { comms: { range: 'subspace' } },
  };
  const m = /^system:(phaser|drydock)(\d)$/.exec(key);
  if (m) return m[1] === 'phaser' ? { phasers: { array: Number(m[2]) } } : { drydock: { berth: Number(m[2]) } };
  if (/^sub:computer\d$/.test(key)) return { computing: {} };
  return E[key] || null;
}
const types = () => JSON.parse(fs.readFileSync(TYPES_FILE, 'utf8')).types;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const BUS_ID = { A: 'bus-a', B: 'bus-b', C: 'bus-c', EPS: 'eps' };
const resOf = (node) => (node === 'EPS' ? 'eps' : 'power');

// The relay's own tables and what each class has aboard (the relay in its dump mode: nothing starts).
function dump() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-graph-'));
  try {
    return JSON.parse(execFileSync(process.execPath, ['server.js'], { cwd: ROOT, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, SHIP_GRAPH_DUMP: '1', PORT: '0', RELAY_DATA: tmp, STARBASES_FILE: path.join(tmp, 'starbases.json'), SHIPCORE_DATA: tmp } }).toString());
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// One class's graph, from its design file and the dump.
function convert(id, design, d) {
  const t = d.tables, c = d.classes[id], keys = c.keys;
  const systems = {};
  const add = (sid, sys) => { const fx = effectsOf(sys.key, design); systems[sid] = { ...sys, ...(fx ? { effects: fx } : {}), upstream: sys.upstream || {} }; return systems[sid]; };
  const link = (down, up, res, perm) => { const s = systems[down]; (s.upstream[up] ||= {})[res] = { ...(s.upstream[up][res] || {}), ...perm }; };
  const allow = (on) => (on ? 'auto' : true);
  const idOf = {}; // the relay's tie key -> system id
  const nameOf = (key) => {
    const [kind, x] = key.includes(':') ? [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)] : ['', key];
    if (kind === 'console') return `${x} console`;
    if (kind === 'system') return t.SYSTEM_NAMES[x] || x;
    if (kind === 'sub') return t.SUBSYSTEMS[x]?.name || x;
    if (kind === 'place') return x;
    return x;
  };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // The buses: A, B and C (power), and the EPS manifold; the crosslink and the EPS taps on them.
  for (const n of ['A', 'B', 'C']) add(BUS_ID[n], { type: 'bus', name: `Bus ${n}`, capacity: { power: c.busMax[n] } });
  add('eps', { type: 'eps-manifold', name: 'EPS manifold', capacity: { eps: c.busMax.EPS } });
  const xl = keys.crosslink?.tied || [];
  for (const [a, b] of [['A', 'B'], ['B', 'C']]) {
    const on = xl.includes(a) && xl.includes(b);
    link(BUS_ID[b], BUS_ID[a], 'power', { pull: c.xlBlock.includes(`${a}>${b}`) ? true : allow(on), push: c.xlBlock.includes(`${b}>${a}`) ? true : allow(on) });
  }
  link('bus-c', 'bus-a', 'power', { pull: false, push: false, why: 'A and C link only through B' });
  for (const n of ['A', 'B', 'C']) link(BUS_ID[n], 'eps', 'eps', { pull: allow(c.taps[n] > 0), push: false, rate: c.taps[n] || c.busMax[n] });

  // Sources.
  const src = (key, sid, sys) => { if (!keys[key]) return; idOf[key] = sid; add(sid, { key, ...sys }); for (const n of keys[key].nodes) link(BUS_ID[n], sid, resOf(n), { pull: allow(keys[key].tied.includes(n)), push: false }); };
  src('solar', 'solar', { type: 'solar', name: 'Solar', produces: { power: design.solar?.output ?? 0 } });
  for (const n of ['A', 'B', 'C']) src(`emerg${n}`, `emergency-${n.toLowerCase()}`, { type: 'emergency-battery', name: `Emergency battery ${n}`, produces: { power: t.EMERG.out }, capacity: { power: t.EMERG.cap } });
  src('impulsePort', 'impulse-port', { type: 'fusion-reactor', name: 'Impulse reactor (port)', produces: { eps: t.GRID.impulse } });
  src('impulseStarboard', 'impulse-starboard', { type: 'fusion-reactor', name: 'Impulse reactor (starboard)', produces: { eps: t.GRID.impulse } });
  src('aux1', 'aux-1', { type: 'fusion-reactor', name: 'Aux fusion 1', produces: { eps: t.FUSION.aux } });
  src('aux2', 'aux-2', { type: 'fusion-reactor', name: 'Aux fusion 2', produces: { eps: t.FUSION.aux } });
  src('core', 'warp-core', { type: 'warp-core', name: 'Warp core', produces: { eps: c.coreOutput } });
  // (A drive's thrusters: tied to the EPS, what the drive isn't spending on thrust feeds it.)
  for (const [key, drive] of [['thrustersPort', 'impulse-port'], ['thrustersStarboard', 'impulse-starboard']]) if (keys[key] && systems[drive]) { idOf[key] = `${drive}-thrusters`; add(`${drive}-thrusters`, { key, type: 'thrusters', name: `${systems[drive].name} thrusters`, parent: drive, upstream: { [drive]: { eps: { pull: 'auto', push: false } } } }); for (const n of keys[key].nodes) link(BUS_ID[n], `${drive}-thrusters`, resOf(n), { pull: allow(keys[key].tied.includes(n)), push: false }); }
  // The bus batteries and the EPS's pressure: each charges from its bus and supplies it.
  for (const [store, node] of Object.entries(t.STORES)) {
    const sid = node === 'EPS' ? 'eps-pressure' : `battery-${node.toLowerCase()}`, on = node === 'EPS' ? true : c.breakers[node];
    add(sid, { type: node === 'EPS' ? 'eps-pressure' : 'battery', name: node === 'EPS' ? 'EPS pressure' : `Battery ${node}`, capacity: { [resOf(node)]: node === 'EPS' ? t.GRID.epsCap : t.GRID.batteryCap }, produces: { [resOf(node)]: node === 'EPS' ? t.GRID.epsOut : t.GRID.batteryOut } });
    link(BUS_ID[node], sid, resOf(node), { pull: allow(on), push: allow(on), rate: node === 'EPS' ? t.GRID.epsCharge : t.GRID.batteryCharge });
  }
  // Docking: the ports, their connectors, and power through them (a starbase's; a docked ship's).
  if (keys.dock || keys.ship) {
    const ports = design.ports === null ? null : design.ports;
    for (let i = 1; i <= (ports ?? 1); i++) add(`docking-port-${i}`, { type: 'docking-port', effects: { docking: {} }, name: ports === null ? 'Docking ports (as many as needed)' : `Docking port ${i}`, ...(ports === null ? { count: null } : {}) });
    add('docking-connectors', { type: 'docking-connectors', name: 'Docking connectors', upstream: Object.fromEntries(Object.keys(systems).filter((s) => s.startsWith('docking-port-')).map((p) => [p, Object.fromEntries(RESOURCES.map((r) => [r, { pull: true, push: true }]))])) });
    src('dock', 'dock-power', { type: 'dock-feed', name: 'Dock power (starbase)', produces: { power: t.GRID.dock }, upstream: { 'docking-connectors': { power: { pull: true, push: true } } } });
    src('dockEps', 'dock-eps', { type: 'dock-feed', name: 'Dock EPS (starbase)', produces: { eps: t.GRID.dock }, upstream: { 'docking-connectors': { eps: { pull: true, push: true } } } });
    src('ship', 'ship-power', { type: 'dock-feed', name: 'Docked ship power', upstream: { 'docking-connectors': { power: { pull: true, push: true } } } });
    src('shipEps', 'ship-eps', { type: 'dock-feed', name: 'Docked ship EPS', upstream: { 'docking-connectors': { eps: { pull: true, push: true } } } });
  }

  // Fuel: the main tanks, each system's own, and the fuel buses between them.
  const fuelCap = { deu: c.fuelCaps.deuterium, am: c.fuelCaps.antimatter };
  for (const [bus, tanks] of Object.entries(t.TANKS)) {
    if (!fuelCap[bus] && bus === 'am') continue;
    add(`fuel-${bus}`, { type: 'fuel-bus', name: bus === 'deu' ? 'Deuterium bus' : 'Antimatter bus', resource: bus });
    for (const [n, tk] of Object.entries(tanks)) {
      const size = n === 'main' ? fuelCap[bus] : c.tankCaps[`${bus}:${n}`];
      if (!size) continue;
      const tid = `tank-${bus}-${n}`;
      add(tid, { type: 'tank', name: tk.label, capacity: { [bus]: size } });
      link(`fuel-${bus}`, tid, bus, { pull: true, push: true });
    }
  }
  // (What each system's own tank feeds.)
  const feeds = { 'tank-deu-core': 'warp-core', 'tank-am-core': 'warp-core', 'tank-deu-port': 'impulse-port', 'tank-deu-starboard': 'impulse-starboard', 'tank-deu-aux1': 'aux-1', 'tank-deu-aux2': 'aux-2' };
  for (const [tid, sid] of Object.entries(feeds)) if (systems[tid] && systems[sid]) link(sid, tid, tid.split('-')[1], { pull: 'auto', push: false });

  // Places (the conduits a load's power runs through), then the loads, each in its place.
  for (const [key, k] of Object.entries(keys)) if (key.startsWith('place:')) {
    const place = (design.places || []).find((p) => `place:${p.name}` === key);
    const sid = `place-${slug(key.slice(6))}`;
    idOf[key] = sid;
    add(sid, { key, type: 'place', name: key.slice(6), ...(place ? { deck: place.deck } : {}) });
    for (const n of k.nodes) link(sid, BUS_ID[n], resOf(n), { pull: allow(k.tied.includes(n)), push: false });
  }
  if (keys['system:lifeSupport']) { idOf['system:lifeSupport'] = 'life-support'; add('life-support', { key: 'system:lifeSupport', type: 'conduit', name: 'Life support' }); for (const n of keys['system:lifeSupport'].nodes) link('life-support', BUS_ID[n], resOf(n), { pull: allow(keys['system:lifeSupport'].tied.includes(n)), push: false }); }
  const loadType = (key) => (key.startsWith('console:') ? 'console' : key.startsWith('sub:') ? 'subsystem' : key.startsWith('contain:') || key === 'containment' ? 'containment' : 'system');
  const loadId = (key) => (key === 'containment' ? 'containment-am-pods' : `${loadType(key)}-${slug(key.slice(key.indexOf(':') + 1))}`);
  for (const [key, k] of Object.entries(keys)) {
    if (!(/^(console|system|sub|contain):/.test(key) || key === 'containment') || idOf[key]) continue;
    idOf[key] = loadId(key);
  }
  const PARENT = { core: 'warp-core', impulsePort: 'impulse-port', impulseStarboard: 'impulse-starboard', aux1: 'aux-1', aux2: 'aux-2', fuel: null, computer: 'computers' };
  if (Object.keys(keys).some((x) => /^sub:computer\d/.test(x))) add('computers', { type: 'group', name: 'Computer cores' });
  for (const [key, k] of Object.entries(keys)) {
    const sid = idOf[key];
    if (!sid || systems[sid]) continue;
    const x = key.slice(key.indexOf(':') + 1);
    const sys = { key, type: loadType(key), name: key === 'containment' ? 'Antimatter containment (pods)' : cap(nameOf(key)) };
    // (Its place: the first conduit on its path that's a place; its parent: a system above it.)
    const conduits = (k.path || []).map((p) => idOf[p]).filter(Boolean);
    const place = conduits.find((p) => p.startsWith('place-'));
    if (place) sys.place = place;
    if (key.startsWith('sub:')) {
      const p = t.SUBSYSTEMS[x]?.parent;
      const pid = p in PARENT ? PARENT[p] : t.STATION_SYSTEMS[p] !== undefined || /^[A-Z]/.test(p) ? `console-${slug(p)}` : idOf[`system:${p}`];
      if (p === 'fuel') sys.parent = x.startsWith('deu') ? 'fuel-deu' : 'fuel-am';
      else if (pid && (systems[pid] || Object.values(idOf).includes(pid))) sys.parent = pid;
      else if (p) sys.parentName = p; // (a parent this class has no system for: a station it lacks)
    }
    if (key === 'containment') sys.parent = 'tank-am-main';
    if (key.startsWith('contain:')) sys.parent = { 'contain:amCore': 'tank-am-core', 'contain:amTorpedo': 'tank-am-torpedo' }[key];
    const via = conduits.filter((p) => !p.startsWith('place-')).pop();
    if (via) sys.via = via; // (a conduit it runs through below its place: life support's, the engines')
    if (key.startsWith('system:')) sys.consumes = { [k.nodes.includes('EPS') ? 'eps' : 'power']: t.RATING[x] ?? 100 };
    if (key.startsWith('console:')) sys.consumes = { power: t.GRID.console };
    add(sid, sys);
    // (Who's served first when a bus is short: containment ahead of everything; then loads tied to one
    // bus, then two, then three, each tier in the systems' priority order. Today's rule, as numbers.)
    const tier = key === 'containment' || key.startsWith('contain:') ? 0 : 100 * Math.max(1, k.tied.length);
    const order = key.startsWith('system:') ? t.SYSTEM_PRIORITY.indexOf(x) : -1;
    const pri = tier === 0 ? 0 : tier + (order < 0 ? 50 : order);
    // (The least it works on: a console or a subsystem needs all it draws; a system works on what it gets.)
    const min = key.startsWith('console:') ? t.GRID.console : key.startsWith('sub:') || key.startsWith('contain:') || key === 'containment' ? 'all' : undefined;
    for (const n of k.nodes) link(sid, BUS_ID[n], resOf(n), { pull: allow(k.tied.includes(n)), push: false, pri, ...(min !== undefined ? { min } : {}) });
  }
  // (A parent can only be pointed at once it exists: drop pointers at systems this class lacks.)
  for (const s of Object.values(systems)) if (s.parent && !systems[s.parent]) { s.parentName = s.parent; delete s.parent; }
  // Heat (schema now, simulated from step 2): every system that consumes or produces makes heat, a
  // share of what it handles (the type library's, or its effect's); the coolant loop carries it from
  // each to the heat sink and the radiators, which dump it to space (their pumps on Bus B). Sized so
  // a vessel running every system at once just balances.
  const lib = types(), heatLib = JSON.parse(fs.readFileSync(TYPES_FILE, 'utf8')).heat;
  let heatTotal = 0;
  add('coolant-loop', { type: 'coolant-loop', name: 'Coolant loop' });
  for (const [id, s] of Object.entries(systems)) {
    const h = heatLib.byType[s.type];
    if (!h) continue;
    const fxShare = Math.max(0, ...Object.keys(s.effects || {}).map((fx) => heatLib.byEffect[fx] || 0));
    const base = Object.entries(s[h.of] || {}).filter(([r]) => r === 'power' || r === 'eps').reduce((n, [, v]) => n + v, 0);
    const heat = Math.round(base * Math.max(h.share, fxShare) * 10) / 10;
    if (!heat) continue;
    s.produces = { ...(s.produces || {}), heat };
    heatTotal += heat;
    link('coolant-loop', id, 'heat', { pull: 'auto', push: false });
  }
  const radiators = Math.max(2, Math.ceil(heatTotal / 400)), each = Math.ceil(heatTotal / radiators / 5) * 5;
  add('heat-sink', { type: 'heat-sink', name: 'Heat sink', capacity: { heat: Math.ceil(heatTotal * 30) } });
  link('coolant-loop', 'heat-sink', 'heat', { pull: 'auto', push: 'auto' });
  for (let i = 1; i <= radiators; i++) {
    const rid = `radiator-${i}`;
    add(rid, { type: 'radiator', name: `Radiator ${i}`, consumes: { heat: each, power: heatLib.pumpPower }, upstream: { 'coolant-loop': { heat: { pull: 'auto', push: false, rate: each } }, 'bus-b': { power: { pull: 'auto', push: false, pri: 100, min: heatLib.pumpPower } } } });
  }
  // Nested: a system's parts are in its own "systems" (a subsystem in its system, station or source;
  // a thruster in its drive; a containment in its tank; a life-support system in life support's
  // conduit; the injectors in the engines). Ids stay unique across the whole tree.
  for (const s of Object.values(systems)) if (s.via && !s.parent) s.parent = s.via;
  const kids = {};
  for (const [id, s] of Object.entries(systems)) if (s.parent) (kids[s.parent] ||= []).push(id);
  const sorted = (ids) => ids.sort((a, b) => rank(systems[a]) - rank(systems[b]) || a.localeCompare(b));
  const node = (id) => {
    const { parent, via, ...rest } = systems[id];
    return { ...rest, ...(via && via !== parent ? { via } : {}), ...(kids[id] ? { systems: Object.fromEntries(sorted(kids[id]).map((k) => [k, node(k)])) } : {}) };
  };
  return {
    schema: SCHEMA,
    type: design.kind || 'ship',
    class: id,
    name: design.name,
    generatedFrom: `config/ships/${id}.json`,
    note: 'Generated by tools/ship-graph.js from the design file (step 1): not read by the game yet. Edit the design file, then run node tools/ship-graph.js --all.',
    places: (design.places || []).map((p) => ({ id: `place-${slug(p.name)}`, name: p.name, deck: p.deck })),
    systems: Object.fromEntries(sorted(Object.keys(systems).filter((s) => !systems[s].parent)).map((s) => [s, node(s)])),
  };
}
// Every node in the tree, flat: { id: node }, and each one's parent (null at the top).
function nodes(g) {
  const all = {}, parentOf = {};
  const walk = (sys, parent) => { for (const [id, s] of Object.entries(sys || {})) { if (all[id]) all[`dup:${id}`] = s; all[id] ||= s; parentOf[id] = parent; walk(s.systems, id); } };
  walk(g.systems, null);
  return { all, parentOf };
}
const RANK = ['bus', 'eps-manifold', 'coolant-loop', 'heat-sink', 'radiator', 'solar', 'emergency-battery', 'battery', 'eps-pressure', 'dock-feed', 'docking-connectors', 'docking-port', 'fusion-reactor', 'thrusters', 'warp-core', 'fuel-bus', 'tank', 'place', 'conduit', 'group', 'console', 'system', 'subsystem', 'containment'];
const rank = (s) => { const i = RANK.indexOf(s.type); return i < 0 ? RANK.length : i; };

// What's wrong with a graph (empty: nothing).
function check(g, lib = types()) {
  const bad = [];
  if (g?.schema !== SCHEMA) bad.push(`schema: must be "${SCHEMA}"`);
  if (!g?.systems || typeof g.systems !== 'object') return [...bad, 'systems: an object of systems'];
  for (const f of ['consumes', 'produces', 'effects']) if (g[f] !== undefined) bad.push(`${f}: belongs on a system, not the vessel`);
  const { all } = nodes(g);
  for (const id of Object.keys(all).filter((x) => x.startsWith('dup:'))) bad.push(`systems: "${id.slice(4)}" is used twice (ids are unique across the tree)`);
  for (const [id, s] of Object.entries(all).filter(([x]) => !x.startsWith('dup:'))) {
    const where = `systems.${id}`;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) bad.push(`${where}: ids are lower-case letters, digits and -`);
    const ty = lib[s.type];
    if (!ty) { bad.push(`${where}: no system type "${s.type}"`); continue; }
    if (typeof s.name !== 'string' || !s.name) bad.push(`${where}: needs a name`);
    for (const f of ['capacity', 'produces', 'consumes']) for (const [r, v] of Object.entries(s[f] || {})) {
      if (!RESOURCES.includes(r)) bad.push(`${where}.${f}: no resource "${r}"`);
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) bad.push(`${where}.${f}.${r}: a number, 0 or more`);
    }
    if (s.effects !== undefined && !(s.effects && typeof s.effects === 'object' && !Array.isArray(s.effects) && Object.entries(s.effects).every(([x, v]) => /^[a-z][a-z-]*$/.test(x) && v && typeof v === 'object'))) bad.push(`${where}.effects: { effect name (lower-case, -): its parameters }`);
    const placeIds = new Set((g.places || []).map((p) => p.id).concat(Object.keys(all)));
    if (s.place !== undefined && !placeIds.has(s.place)) bad.push(`${where}.place: no place "${s.place}"`);
    if (s.via !== undefined && !all[s.via]) bad.push(`${where}.via: no system "${s.via}"`);
    for (const [up, res] of Object.entries(s.upstream || {})) {
      if (!all[up]) { bad.push(`${where}.upstream: no system "${up}"`); continue; }
      if (up === id) bad.push(`${where}.upstream: a system can't draw from itself`);
      for (const [r, perm] of Object.entries(res)) {
        if (!RESOURCES.includes(r)) bad.push(`${where}.upstream.${up}: no resource "${r}"`);
        for (const w of ['pull', 'push', 'connect']) if (perm[w] !== undefined && !PERMS.includes(perm[w])) bad.push(`${where}.upstream.${up}.${r}.${w}: false, "warn", true or "auto"`);
        for (const f of Object.keys(perm)) if (!['pull', 'push', 'connect', 'rate', 'why', 'pri', 'min'].includes(f)) bad.push(`${where}.upstream.${up}.${r}: no setting "${f}"`);
        if (perm.pri !== undefined && !(typeof perm.pri === 'number' && Number.isFinite(perm.pri))) bad.push(`${where}.upstream.${up}.${r}.pri: a number (lower is served first)`);
        if (perm.min !== undefined && !(perm.min === 'all' || (typeof perm.min === 'number' && perm.min >= 0))) bad.push(`${where}.upstream.${up}.${r}.min: a number, or "all"`);
        if (perm.why !== undefined && typeof perm.why !== 'string') bad.push(`${where}.upstream.${up}.${r}.why: a reason, as text`);
        if (perm.rate !== undefined && !(typeof perm.rate === 'number' && perm.rate >= 0)) bad.push(`${where}.upstream.${up}.${r}.rate: a number, 0 or more`);
      }
    }
  }
  return bad;
}

// Each system's links both ways, per resource: up[id][res] = systems it draws from; down[id][res] =
// systems that draw from it. (Any system can be the root of a chart: walk up and down from it.)
function index(g) {
  const up = {}, down = {}, { all } = nodes(g);
  for (const id of Object.keys(all)) { up[id] = {}; down[id] = {}; }
  for (const [id, s] of Object.entries(all)) for (const [u, res] of Object.entries(s.upstream || {})) for (const r of Object.keys(res)) {
    (up[id][r] ||= []).push(u);
    (down[u][r] ||= []).push(id);
  }
  return { up, down };
}
// The relay's ties as a fresh vessel of this class starts with them, read back from the graph (the
// links that are "auto"): the converter's own check that it lost nothing.
function toTies(g) {
  const NODE = { 'bus-a': 'A', 'bus-b': 'B', 'bus-c': 'C', eps: 'EPS' };
  const on = (res) => Object.values(res || {}).some((p) => p.pull === 'auto');
  const ties = {}, { all } = nodes(g);
  for (const [id, s] of Object.entries(all)) {
    if (!s.key) continue;
    // (A load's link is on its own upstream; a source's, on the bus it feeds.)
    ties[s.key] = ['A', 'B', 'C', 'EPS'].filter((n) => on(s.upstream?.[BUS_ID[n]]) || on(all[BUS_ID[n]].upstream?.[id]));
  }
  return ties;
}

function main(argv) {
  const designs = Object.fromEntries(fs.readdirSync(path.join(CONFIG, 'ships')).filter((f) => f.endsWith('.json') && !f.startsWith('.')).map((f) => [f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(CONFIG, 'ships', f), 'utf8'))]));
  const d = dump();
  const all = Object.keys(d.classes);
  const want = argv.includes('--all') ? all : argv.includes('--check') ? fs.readdirSync(OUT).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : argv.filter((a) => !a.startsWith('--'));
  if (!want.length) { console.log('usage: node tools/ship-graph.js <class>... | --all | --check'); return 2; }
  let failed = 0;
  for (const id of want) {
    if (!d.classes[id]) { console.error(`${id}: no such ship class`); failed++; continue; }
    const g = convert(id, designs[id], d), bad = check(g);
    if (bad.length) { console.error(`${id}: ${bad.join('; ')}`); failed++; continue; }
    const text = JSON.stringify(g, null, 2) + '\n', file = path.join(OUT, `${id}.json`);
    if (argv.includes('--check')) {
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) { console.error(`${id}: config/ships-graph/${id}.json is out of date (node tools/ship-graph.js ${id})`); failed++; } else console.log(`${id}: up to date (${Object.keys(nodes(g).all).length} systems)`);
      continue;
    }
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`${id}: ${Object.keys(nodes(g).all).length} systems (${Object.keys(g.systems).length} at the top) → config/ships-graph/${id}.json`);
  }
  return failed ? 1 : 0;
}

module.exports = { SCHEMA, PERMS, RESOURCES, effectsOf, nodes, dump, convert, check, index, toTies, types };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
