// The game's database (docs/database.md; MariaDB or MySQL 8): the schema, and the designs and star
// charts loaded into it. Nothing in play reads it yet.
//   node tools/db.js migrate    db/schema.sql and db/seed.sql (refuses to drop a table that holds rows)
//   node tools/db.js load       the vessel kinds' designs (as the relay builds their graphs) and the star charts
//   node tools/db.js check      each class read back from the database (merged) is the graph the relay builds
//   node tools/db.js show <class> [system]   a class's systems as merged, or one system's
// Connection: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, else data/settings.json "database"
// ({ host, port, user, password, database }); never in git.
const fs = require('fs');
const path = require('path');
const GRAPH = require('./ship-graph');
const CONFIG = require('./config');
const SETTINGS = require('./settings');

const ROOT = path.join(__dirname, '..');
function settings() {
  const s = SETTINGS.read().database || {};
  return { host: process.env.DB_HOST || s.host || '127.0.0.1', port: Number(process.env.DB_PORT || s.port || 3306), user: process.env.DB_USER || s.user,
    password: process.env.DB_PASSWORD ?? s.password, database: process.env.DB_NAME || s.database || 'startrek' };
}
async function connect() {
  const mysql = require('mysql2/promise');
  const c = settings();
  if (!c.user) throw new Error('no database user: set DB_USER (and DB_PASSWORD), or "database" in data/settings.json');
  return mysql.createConnection({ ...c, multipleStatements: true });
}

// (JSON_MERGE_PATCH reads null as "remove": a value that is really null is stored as this, and read back.)
const NULL = { $null: true };
const enc = (v) => (v === null ? NULL : Array.isArray(v) ? v.map(enc) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) : v);
const dec = (v) => (v && typeof v === 'object' && !Array.isArray(v) && v.$null === true && Object.keys(v).length === 1 ? null : Array.isArray(v) ? v.map(dec) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)])) : v);
// (JSON columns come back as text on MariaDB, parsed on MySQL.)
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
// What every one of these objects has, the same (objects: what they share, all the way down).
function common(list) {
  if (!list.length) return {};
  const out = {};
  for (const k of Object.keys(list[0])) {
    if (!list.every((o) => k in o)) continue;
    const vals = list.map((o) => o[k]);
    if (vals.every(isObj)) { const c = common(vals); if (Object.keys(c).length) out[k] = c; } else if (vals.every((v) => same(v, vals[0]))) out[k] = vals[0];
  }
  return out;
}
// The merge patch that takes base to target (what changes; null for what goes).
function diff(base, target) {
  const out = {};
  for (const [k, v] of Object.entries(target)) {
    if (!(k in base)) out[k] = v;
    else if (isObj(v) && isObj(base[k])) { const d = diff(base[k], v); if (Object.keys(d).length) out[k] = d; } else if (!same(v, base[k])) out[k] = v;
  }
  for (const k of Object.keys(base)) if (!(k in target)) out[k] = null;
  return out;
}

async function migrate(db) {
  // (The first draft's tables this replaces: only while they're empty.)
  for (const t of ['system_properties', 'default_properties', 'systems']) {
    const [[exists]] = await db.query('select count(*) n from information_schema.tables where table_schema = database() and table_name = ? and table_type = "BASE TABLE"', [t]);
    if (!exists.n) continue;
    const [[rows]] = await db.query(`select count(*) n from \`${t}\``);
    if (rows.n) throw new Error(`${t} holds ${rows.n} rows: not dropping it (back it up and empty it first)`);
  }
  await db.query(fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8'));
  await db.query(fs.readFileSync(path.join(ROOT, 'db', 'seed.sql'), 'utf8'));
}

// Each vessel kind's graph as the relay builds it today, and its design.
function graphs() {
  const d = GRAPH.dump();
  const { classes, starbase, relay } = CONFIG.loadShips(() => {});
  const designs = { ...classes, starbase, ...(relay ? { [relay.id || 'subspace-relay']: relay } : {}) };
  return Object.keys(d.classes).map((id) => ({ id, design: designs[id], graph: GRAPH.convert(id, designs[id], d) }));
}
const META = ['about', 'refit', 'indestructible', 'lands', 'wiring', 'org', 'seats'];
const nodeProps = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !['type', 'systems', 'upstream'].includes(k)));

async function load(db) {
  const lib = GRAPH.types(), all = graphs();
  // The system types, and the defaults each starts from: what every system of the type shares, in every design.
  const byType = {};
  for (const { graph } of all) for (const s of Object.values(GRAPH.nodes(graph).all)) (byType[s.type] ||= []).push(nodeProps(s));
  const defaults = Object.fromEntries(Object.keys(lib).map((t) => [t, common(byType[t] || [])]));
  for (const [t, info] of Object.entries(lib)) {
    await db.query('insert into base_systems (base_system_name, role, info, defaults) values (?, ?, ?, ?) on duplicate key update role = values(role), info = values(info), defaults = values(defaults)',
      [t, info.role, JSON.stringify(info), JSON.stringify(enc(defaults[t]))]);
  }
  const [types] = await db.query('select base_system_id, base_system_name from base_systems');
  const typeId = Object.fromEntries(types.map((r) => [r.base_system_name, r.base_system_id]));
  // Each vessel kind: its row, its systems (what each changes from its type), its links (a row each).
  for (const { id, design, graph } of all) {
    const designJson = { ...Object.fromEntries(META.filter((k) => design[k] !== undefined).map((k) => [k, design[k]])), places: graph.places };
    await db.query('insert into classes (class_code, class_name, kind, design) values (?, ?, ?, ?) on duplicate key update class_name = values(class_name), kind = values(kind), design = values(design)',
      [id, graph.name, graph.type, JSON.stringify(enc(designJson))]);
    const [[{ class_id: cid }]] = await db.query('select class_id from classes where class_code = ?', [id]);
    await db.query('delete from class_links where class_id = ?', [cid]);
    await db.query('delete from class_systems where class_id = ?', [cid]);
    const rows = [], links = [];
    let n = 0, m = 0;
    const walk = (sys, parent) => { for (const [key, s] of Object.entries(sys || {})) {
      rows.push([cid, key, parent, typeId[s.type], JSON.stringify(enc(diff(defaults[s.type] || {}, nodeProps(s)))), n++]);
      for (const [other, res] of Object.entries(s.upstream || {})) for (const [r, link] of Object.entries(res)) links.push([cid, key, other, r, JSON.stringify(enc(link)), m++]);
      walk(s.systems, key);
    } };
    walk(graph.systems, null);
    if (rows.length) await db.query('insert into class_systems (class_id, system_key, parent_key, base_system_id, props, sort_order) values ?', [rows]);
    if (links.length) await db.query('insert into class_links (class_id, system_key, other_key, resource, link, sort_order) values ?', [links]);
  }
  // The star charts: each system, its stars and planets (its bodies), and the starbases, waypoints and relay.
  const MK = { Sol: { spectral_class: 'G', spectral_subclass: 2, luminosity_class: 'V' } }; // (known stars' classes)
  for (const [code, chart] of Object.entries(CONFIG.loadSystems(() => {}))) {
    await db.query('insert into star_systems (star_system_code, star_system_name, size) values (?, ?, ?) on duplicate key update star_system_name = values(star_system_name), size = values(size)', [code, chart.name, chart.size]);
    const [[{ star_system_id: sid }]] = await db.query('select star_system_id from star_systems where star_system_code = ?', [code]);
    let starId = null;
    for (const b of chart.bodies.filter((x) => x.kind === 'star')) {
      const mk = MK[b.name] || {};
      await db.query('insert into stars (star_system_id, star_name, star_x, star_y, radius, spectral_class, spectral_subclass, luminosity_class) values (?, ?, ?, ?, ?, ?, ?, ?) on duplicate key update star_x = values(star_x), star_y = values(star_y), radius = values(radius), spectral_class = values(spectral_class), spectral_subclass = values(spectral_subclass), luminosity_class = values(luminosity_class)',
        [sid, b.name, b.x, b.y, b.r ?? null, mk.spectral_class ?? null, mk.spectral_subclass ?? null, mk.luminosity_class ?? null]);
      const [[r]] = await db.query('select star_id from stars where star_system_id = ? and star_name = ?', [sid, b.name]);
      starId ??= r.star_id;
    }
    const PLANET = { Earth: 'M', Mars: 'K', Jupiter: 'J', Saturn: 'J', Venus: 'N', Mercury: 'B' }; // (known worlds' classes)
    for (const b of chart.bodies.filter((x) => x.kind !== 'star')) {
      await db.query(`insert into planets (star_id, planet_name, x, y, radius, planet_type) values (?, ?, ?, ?, ?, (select planet_type_id from planet_types where planet_type_code = ?))
        on duplicate key update x = values(x), y = values(y), radius = values(radius), planet_type = values(planet_type)`, [starId, b.name, b.x, b.y, b.r ?? null, PLANET[b.name] ?? null]);
    }
    await db.query('delete from chart_objects where star_system_id = ?', [sid]);
    const objs = [...chart.starbases.map((b) => ['starbase', b]), ...chart.waypoints.map((w) => ['waypoint', w]), ...(chart.relay ? [['relay', chart.relay]] : [])];
    if (objs.length) await db.query('insert into chart_objects (star_system_id, kind, name, x, y) values ?', [objs.map(([k, o]) => [sid, k, o.name, o.x, o.y])]);
  }
  return all.length;
}

// A class read back: its systems merged (type defaults, patched by the class), nested; its links.
async function readClass(db, code) {
  const [[c]] = await db.query('select class_id, class_code, class_name, kind, design from classes where class_code = ?', [code]);
  if (!c) return null;
  const [sys] = await db.query('select system_key, parent_key, system_type, props from vw_class_systems where class_id = ? order by sort_order', [c.class_id]);
  const [links] = await db.query('select system_key, other_key, resource, link from class_links where class_id = ? order by sort_order', [c.class_id]);
  const nodes = {}, top = {};
  for (const r of sys) nodes[r.system_key] = { type: r.system_type, ...dec(J(r.props)) };
  for (const l of links) ((nodes[l.system_key].upstream ||= {})[l.other_key] ||= {})[l.resource] = dec(J(l.link));
  for (const k of Object.keys(nodes)) nodes[k].upstream ||= {};
  for (const r of sys) (r.parent_key ? (nodes[r.parent_key].systems ||= {}) : top)[r.system_key] = nodes[r.system_key];
  const design = dec(J(c.design));
  return { schema: GRAPH.SCHEMA, type: c.kind, class: c.class_code, name: c.class_name, places: design.places, systems: top };
}

async function check(db) {
  const out = [];
  for (const { id, graph } of graphs()) {
    const back = await readClass(db, id);
    const { generatedFrom, note, ...want } = graph;
    out.push([id, !!back && same(back, want), back ? Object.keys(GRAPH.nodes(back).all).length : 0]);
  }
  return out;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const db = await connect();
  try {
    if (cmd === 'migrate') { await migrate(db); console.log('migrated: db/schema.sql and db/seed.sql applied'); }
    else if (cmd === 'load') console.log(`loaded ${await load(db)} vessel kinds and the star charts`);
    else if (cmd === 'check') {
      const res = await check(db);
      for (const [id, ok, n] of res) console.log(`${id}: ${ok ? 'the same' : 'DIFFERENT'} (${n} systems)`);
      return res.every(([, ok]) => ok) ? 0 : 1;
    } else if (cmd === 'show') {
      const [code, key] = rest;
      const [rows] = await db.query(`select system_key, parent_key, system_type, props from vw_class_systems where class_code = ? ${key ? 'and system_key = ?' : ''} order by sort_order`, key ? [code, key] : [code]);
      for (const r of rows) console.log(`${r.system_key}${r.parent_key ? ` (in ${r.parent_key})` : ''} [${r.system_type}] ${JSON.stringify(dec(J(r.props)))}`);
    } else { console.log('usage: node tools/db.js migrate | load | check | show <class> [system]'); return 2; }
    return 0;
  } finally { await db.end(); }
}

module.exports = { connect, settings, migrate, load, readClass, check, common, diff, enc, dec };
if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (err) => { console.error(err.message); process.exitCode = 1; });
