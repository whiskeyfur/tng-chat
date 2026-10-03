// The designs, read from config/ (the live state stays in data/ and the ships' own folders):
//   config/ships/<class>.json       one per ship class (and starbase.json for every starbase)
//   config/starsystem/<system>.json one per star chart
// A new class is a new file. Each file is checked as it's read: a bad one is
// skipped, with a log line naming the file and the field, and the rest load.
const fs = require('fs');
const path = require('path');

const DIR = process.env.CONFIG_DIR || path.join(__dirname, '..', 'config');

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isBool = (v) => typeof v === 'boolean';
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isPoint = (v) => isNum(v?.x) && isNum(v?.y);
// (An org chart's position: n of them, if n is given.)
const isPosition = (p) => isStr(p?.id) && isStr(p?.title) && isStr(p?.rank) && isStr(p?.station) && (p.n === undefined || (Number.isInteger(p.n) && p.n > 0));

// field: [check, what it must be, required]
const SHIP_FIELDS = {
  name: [isStr, 'a name', true],
  bus: [isNum, 'a number (each low bus\'s limit)', true],
  eps: [isNum, 'a number (the EPS\'s limit)', true],
  core: [isNum, 'a number (the warp core\'s output, ×)', true],
  maxWarp: [isNum, 'a number (top warp; 0: none)', true],
  shields: [isNum, 'a number (shield strength, ×)', true],
  arrays: [isNum, 'a number (phaser arrays)', true],
  warpCore: [isBool, 'true or false', true],
  transporter: [isBool, 'true or false', true],
  ports: [(v) => v === null || isNum(v), 'a number of docking ports, or null for as many as needed', true],
  bay: [isNum, 'a number (shuttle bay slots)', true],
  kind: [(v) => v === 'ship' || v === 'starbase' || v === 'relay', '"ship", "starbase" or "relay"', false],
  refit: [isBool, 'true or false', false],
  spore: [isBool, 'true or false', false],
  torpedoes: [isNum, 'a number (torpedoes carried)', false],
  stations: [(v) => v === null || (Array.isArray(v) && v.every(isStr)), 'a list of station names, or null for all of them', false],
  ties: [(v) => isObj(v) && Object.values(v).every((x) => Array.isArray(x) && x.every(isStr)), 'an object of tie lists', false],
  places: [(v) => Array.isArray(v) && v.every((p) => isStr(p?.name) && isNum(p?.deck) && Array.isArray(p?.stations) && p.stations.every(isStr) && (p.via === undefined || isStr(p.via))), 'a list of { name, deck, stations, rows?, via?, default? }', false],
  // (Never short of these: a starbase, a shipyard, a GM object; the graph engine honours it.)
  creative: [(v) => Array.isArray(v) && v.every((r) => ['power', 'eps', 'odn', 'deu', 'am', 'heat'].includes(r)), 'a list of resources it never runs short of (power, eps, deu, am...)', false],
  seats: [(v) => isObj(v) && Object.values(v).every((s) => Array.isArray(s) && s.length === 2 && s.every(isNum)), 'an object of [x, y] seats', false],
  solar: [(v) => isObj(v) && isNum(v.output) && v.output >= 0, 'its solar arrays: { output } (power, 0 for none)', false],
  antimatter: [isBool, 'true or false (antimatter carried: false for none, no tanks to fill or contain)', false],
  indestructible: [isBool, 'true or false (never destroyed: its safety systems eject the core instead)', false],
  fuel: [(v) => isObj(v) && ['antimatter', 'deuterium'].every((x) => v[x] === undefined || (isNum(v[x]) && v[x] >= 0)) && (v.tanks === undefined || (isObj(v.tanks) && Object.values(v.tanks).every((n) => isNum(n) && n >= 0))),
    'its fuel storage: { antimatter, deuterium, tanks?: { "deu:core": 100, ... } }', false],
  wiring: [(v) => v === 'places', '"places" (a new grid ties only what its places hold), or left out', false],
  lands: [(v) => v === 'any' || v === 'starbase', '"any" (any shuttle bay) or "starbase" (a starbase\'s), or left out (it doesn\'t land)', false],
  emergency: [(v) => Array.isArray(v) && v.every((b) => ['A', 'B', 'C'].includes(b)), 'a list of the low buses with an emergency battery ([] for none; left out: all three)', false],
  fusion: [isBool, 'true or false (impulse and auxiliary fusion reactors aboard)', false],
  org: [(v) => isObj(v) && Array.isArray(v.command) && v.command.every(isPosition) && (v.departments === undefined || (Array.isArray(v.departments) && v.departments.every((d) => isStr(d?.name) && Array.isArray(d.positions) && d.positions.every(isPosition)))),
    'its org chart: { command: [positions], departments: [{ name, positions }] }, a position { id, title, rank, station, n? }', false],
};
const SYSTEM_FIELDS = {
  name: [isStr, 'a name', true],
  size: [(v) => isNum(v) && v > 0, 'a positive number (the chart\'s width and height)', true],
  starbases: [(v) => Array.isArray(v) && v.length > 0 && v.every((b) => isStr(b?.name) && isPoint(b)), 'a list of { name, x, y } (at least one)', true],
  bodies: [(v) => Array.isArray(v) && v.every((b) => isStr(b?.name) && isPoint(b)), 'a list of { name, x, y }', false],
  waypoints: [(v) => Array.isArray(v) && v.every((b) => isStr(b?.name) && isPoint(b)), 'a list of { name, x, y }', false],
  relay: [(v) => isStr(v?.name) && isPoint(v), 'its subspace relay: { name, x, y }', false],
};

// A design checked (the same check the loader makes): null, or { field, message }.
function checkFields(v, fields) {
  if (!isObj(v)) return { field: '', message: 'not an object' };
  const bad = Object.entries(fields).find(([k, [ok, , required]]) => (v[k] === undefined ? required : !ok(v[k])));
  return bad ? { field: bad[0], message: `${v[bad[0]] === undefined ? 'is missing' : 'is wrong'}: it must be ${bad[1][1]}` } : null;
}
const checkShip = (v) => checkFields(v, SHIP_FIELDS);
// (Design files are graphs now, docs/ship-graph.md: the design fields are worked out from the graph.)
const GRAPH = () => require('./ship-graph');
// Every <name>.json in a folder of config/, checked: { id: content }.
function loadFolder(sub, fields, log) {
  const dir = path.join(DIR, sub), out = {};
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch (err) { log(`config: can't read ${path.join('config', sub)}: ${err.message}`); return out; }
  for (const f of files) {
    const where = path.join('config', sub, f);
    let v;
    try { v = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (err) { log(`config: skipping ${where}: not valid JSON (${err.message})`); continue; }
    if (sub === 'ships' && GRAPH().isGraphFile(v)) {
      const wrong = GRAPH().check(v);
      if (wrong.length) { log(`config: skipping ${where}: ${wrong.slice(0, 3).join('; ')}${wrong.length > 3 ? ` (and ${wrong.length - 3} more)` : ''}`); continue; }
      v = GRAPH().toDesign(v);
    }
    const bad = checkFields(v, fields);
    if (bad) { log(`config: skipping ${where}: ${bad.field ? `field "${bad.field}" ${bad.message}` : bad.message}`); continue; }
    out[f.slice(0, -5).toLowerCase()] = v;
  }
  return out;
}

// The designs by kind: the ship classes, the starbases' (starbase.json), the subspace relays'
// (the first file of kind "relay"); probes and planets will be kinds too.
function loadShips(log = console.warn) {
  const all = loadFolder('ships', SHIP_FIELDS, log);
  const classes = {}, starbase = all.starbase || null;
  const relayId = Object.keys(all).find((id) => all[id].kind === 'relay') || null;
  for (const [id, c] of Object.entries(all)) if (id !== 'starbase' && c.kind !== 'starbase' && c.kind !== 'relay') classes[id] = { kind: 'ship', refit: true, spore: false, torpedoes: 10, stations: null, ties: {}, places: [], seats: {}, ...c };
  return { classes, starbase: starbase && { refit: false, spore: false, torpedoes: 10, stations: null, ties: {}, places: [], seats: {}, ...starbase },
    relay: relayId && { id: relayId, refit: false, spore: false, torpedoes: 0, stations: [], ties: {}, places: [], seats: {}, ...all[relayId] } };
}

// The star charts.
function loadSystems(log = console.warn) {
  const all = loadFolder('starsystem', SYSTEM_FIELDS, log);
  for (const s of Object.values(all)) { s.bodies ||= []; s.waypoints ||= []; }
  return all;
}

// A design written back (the admin page's editor): checked first, pretty-printed in a stable
// key order, the old file kept in config/ships/.backup/<class>.<time>.json. Returns null or an error.
const KEY_ORDER = ['about', 'kind', 'name', ...Object.keys(SHIP_FIELDS)];
function saveShip(id, design) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) return { field: 'id', message: 'a class id: lower-case letters, digits and -, starting with a letter' };
  // (A graph: checked as one, and its design fields as the loader works them out.)
  const graph = GRAPH().isGraphFile(design);
  if (graph) { const wrong = GRAPH().check(design); if (wrong.length) return { field: '', message: wrong[0] }; }
  const bad = checkShip(graph ? GRAPH().toDesign(design) : design);
  if (bad) return bad;
  const dir = path.join(DIR, 'ships'), file = path.join(dir, `${id}.json`);
  if (fs.existsSync(file)) {
    fs.mkdirSync(path.join(dir, '.backup'), { recursive: true });
    fs.copyFileSync(file, path.join(dir, '.backup', `${id}.${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  }
  const order = graph ? ['schema', 'type', 'class', 'name', ...GRAPH().META, 'places', 'systems'] : KEY_ORDER;
  const ordered = Object.fromEntries([...order.filter((k) => k in design), ...Object.keys(design).filter((k) => !order.includes(k)).sort()].map((k) => [k, design[k]]));
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(ordered, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
  return null;
}
// The ship graphs: the design files in config/ships that are graphs, each checked against the
// system types (a bad one is skipped, named).
function loadGraphs(log = console.warn) {
  const GRAPH = require('./ship-graph');
  const dir = path.join(DIR, 'ships'), out = {};
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort(); } catch { return out; }
  let lib;
  try { lib = JSON.parse(fs.readFileSync(path.join(DIR, 'system-types.json'), 'utf8')).types; } catch (err) { log(`config: can't read config/system-types.json: ${err.message}`); return out; }
  for (const f of files) {
    let g;
    try { g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (err) { log(`config: skipping config/ships/${f}: not valid JSON (${err.message})`); continue; }
    if (!GRAPH.isGraphFile(g)) continue;
    const bad = GRAPH.check(g, lib);
    if (bad.length) { log(`config: skipping config/ships/${f}: ${bad.slice(0, 3).join('; ')}${bad.length > 3 ? ` (and ${bad.length - 3} more)` : ''}`); continue; }
    out[f.slice(0, -5)] = g;
  }
  return out;
}
// The designs as files say (for the editor), their design fields: { id: design }; and the files themselves.
const readShips = () => loadFolder('ships', {}, () => {});
const readShipFiles = () => { const dir = path.join(DIR, 'ships'), out = {}; for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('.'))) { try { out[f.slice(0, -5).toLowerCase()] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch {} } return out; };

module.exports = { DIR, loadShips, loadSystems, loadGraphs, checkShip, saveShip, readShips, readShipFiles };
