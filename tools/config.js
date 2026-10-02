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
  seats: [(v) => isObj(v) && Object.values(v).every((s) => Array.isArray(s) && s.length === 2 && s.every(isNum)), 'an object of [x, y] seats', false],
  solar: [(v) => isObj(v) && isNum(v.output) && v.output >= 0, 'its solar arrays: { output } (power, 0 for none)', false],
  antimatter: [isBool, 'true or false (antimatter carried: false for none, no tanks to fill or contain)', false],
  indestructible: [isBool, 'true or false (never destroyed: its safety systems eject the core instead)', false],
  fuel: [(v) => isObj(v) && ['antimatter', 'deuterium'].every((x) => v[x] === undefined || (isNum(v[x]) && v[x] >= 0)) && (v.tanks === undefined || (isObj(v.tanks) && Object.values(v.tanks).every((n) => isNum(n) && n >= 0))),
    'its fuel storage: { antimatter, deuterium, tanks?: { "deu:core": 100, ... } }', false],
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
// Every <name>.json in a folder of config/, checked: { id: content }.
function loadFolder(sub, fields, log) {
  const dir = path.join(DIR, sub), out = {};
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch (err) { log(`config: can't read ${path.join('config', sub)}: ${err.message}`); return out; }
  for (const f of files) {
    const where = path.join('config', sub, f);
    let v;
    try { v = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (err) { log(`config: skipping ${where}: not valid JSON (${err.message})`); continue; }
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
  const bad = checkShip(design);
  if (bad) return bad;
  const dir = path.join(DIR, 'ships'), file = path.join(dir, `${id}.json`);
  if (fs.existsSync(file)) {
    fs.mkdirSync(path.join(dir, '.backup'), { recursive: true });
    fs.copyFileSync(file, path.join(dir, '.backup', `${id}.${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  }
  const ordered = Object.fromEntries([...KEY_ORDER.filter((k) => k in design), ...Object.keys(design).filter((k) => !KEY_ORDER.includes(k)).sort()].map((k) => [k, design[k]]));
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(ordered, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
  return null;
}
// The designs as files say (for the editor): { id: content }.
const readShips = () => loadFolder('ships', {}, () => {});

module.exports = { DIR, loadShips, loadSystems, checkShip, saveShip, readShips };
