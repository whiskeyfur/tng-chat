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
  kind: [(v) => v === 'ship' || v === 'starbase', '"ship" or "starbase"', false],
  refit: [isBool, 'true or false', false],
  spore: [isBool, 'true or false', false],
  torpedoes: [isNum, 'a number (torpedoes carried)', false],
  stations: [(v) => v === null || (Array.isArray(v) && v.every(isStr)), 'a list of station names, or null for all of them', false],
  ties: [(v) => isObj(v) && Object.values(v).every((x) => Array.isArray(x) && x.every(isStr)), 'an object of tie lists', false],
  places: [(v) => Array.isArray(v) && v.every((p) => isStr(p?.name) && isNum(p?.deck) && Array.isArray(p?.stations) && p.stations.every(isStr) && (p.via === undefined || isStr(p.via))), 'a list of { name, deck, stations, rows?, via?, default? }', false],
  seats: [(v) => isObj(v) && Object.values(v).every((s) => Array.isArray(s) && s.length === 2 && s.every(isNum)), 'an object of [x, y] seats', false],
  org: [(v) => Array.isArray(v), 'a list of departments', false],
};
const SYSTEM_FIELDS = {
  name: [isStr, 'a name', true],
  size: [(v) => isNum(v) && v > 0, 'a positive number (the chart\'s width and height)', true],
  starbases: [(v) => Array.isArray(v) && v.length > 0 && v.every((b) => isStr(b?.name) && isPoint(b)), 'a list of { name, x, y } (at least one)', true],
  bodies: [(v) => Array.isArray(v) && v.every((b) => isStr(b?.name) && isPoint(b)), 'a list of { name, x, y }', false],
  waypoints: [(v) => Array.isArray(v) && v.every((b) => isStr(b?.name) && isPoint(b)), 'a list of { name, x, y }', false],
};

// Every <name>.json in a folder of config/, checked: { id: content }.
function loadFolder(sub, fields, log) {
  const dir = path.join(DIR, sub), out = {};
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch (err) { log(`config: can't read ${path.join('config', sub)}: ${err.message}`); return out; }
  for (const f of files) {
    const where = path.join('config', sub, f);
    let v;
    try { v = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (err) { log(`config: skipping ${where}: not valid JSON (${err.message})`); continue; }
    if (!isObj(v)) { log(`config: skipping ${where}: not an object`); continue; }
    const bad = Object.entries(fields).find(([k, [ok, , required]]) => (v[k] === undefined ? required : !ok(v[k])));
    if (bad) { log(`config: skipping ${where}: field "${bad[0]}" ${v[bad[0]] === undefined ? 'is missing' : 'is wrong'}: it must be ${bad[1][1]}`); continue; }
    out[f.slice(0, -5).toLowerCase()] = v;
  }
  return out;
}

// The ship classes (starbase.json apart: the starbases' own design).
function loadShips(log = console.warn) {
  const all = loadFolder('ships', SHIP_FIELDS, log);
  const classes = {}, starbase = all.starbase || null;
  for (const [id, c] of Object.entries(all)) if (id !== 'starbase' && c.kind !== 'starbase') classes[id] = { kind: 'ship', refit: true, spore: false, torpedoes: 10, stations: null, ties: {}, places: [], seats: {}, ...c };
  return { classes, starbase: starbase && { refit: false, spore: false, torpedoes: 10, stations: null, ties: {}, places: [], seats: {}, ...starbase } };
}

// The star charts.
function loadSystems(log = console.warn) {
  const all = loadFolder('starsystem', SYSTEM_FIELDS, log);
  for (const s of Object.values(all)) { s.bodies ||= []; s.waypoints ||= []; }
  return all;
}

module.exports = { DIR, loadShips, loadSystems };
