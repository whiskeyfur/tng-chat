// The game's database (docs/database.md; MariaDB, or MySQL 8): the schema, the designs, the star
// charts and the system library, and the game's state: the ships' saves, the starbases', the accounts.
// The game uses it when data/settings.json has "database" (tools/store.js, which calls this).
//   node tools/db.js migrate    db/schema.sql and db/seed.sql (refuses to drop a table that holds rows)
//   node tools/db.js load       config/ into the database: the designs (and their graphs, as the relay
//                               builds them), the star charts and the system library (replacing those)
//   node tools/db.js export     the other way: the database's designs and star charts written to config/
//                               (for git: what the admin page's editor saved, say)
//   node tools/db.js check      each class read back from the database (merged) is the graph the relay builds
//   node tools/db.js show <class> [system]   a class's systems as merged, or one system's
// (And for tools/store.js: snapshot, relay-state, nav <ship> <file>, write, save-design <id>.)
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

// --- config/ into the database ---------------------------------------------------------------

// Each vessel kind's graph as the relay builds it from config/ (the relay, in its dump mode, reads the files).
// (Worked out from config/ alone: the game's reads from the database are off in this process from here.)
function graphs(only) {
  require('./store').filesOnly();
  const d = GRAPH.dump();
  const files = CONFIG.files.ships();
  const { classes, starbase, relay } = CONFIG.files.loadShips(() => {});
  const designs = { ...classes, starbase, ...(relay ? { [relay.id || 'subspace-relay']: relay } : {}) };
  return Object.keys(d.classes).filter((id) => !only || only.includes(id)).map((id) => ({ id, file: files[id], graph: GRAPH.convert(id, designs[id], d) }));
}
const nodeProps = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !['type', 'systems', 'upstream'].includes(k)));

// The system library: each type (its role and description, its heat, the defaults every system of
// the type starts from: what all of them share, in every design), the effects' heat, the rules.
async function loadTypes(db, all) {
  const lib = CONFIG.files.types(), byType = {};
  for (const { graph } of all) for (const s of Object.values(GRAPH.nodes(graph).all)) (byType[s.type] ||= []).push(nodeProps(s));
  for (const [t, info] of Object.entries(lib.types)) {
    const heat = lib.heat?.byType?.[t];
    await db.query('insert into base_systems (base_system_name, role, info, defaults, heat) values (?, ?, ?, ?, ?) on duplicate key update role = values(role), info = values(info), defaults = values(defaults), heat = values(heat)',
      [t, info.role, JSON.stringify(info), JSON.stringify(enc(common(byType[t] || []))), heat === undefined ? null : JSON.stringify(heat)]);
  }
  await db.query('update base_systems set heat = null, info = null where base_system_name not in (?)', [Object.keys(lib.types)]);
  await db.query('delete from effects');
  const fx = Object.entries(lib.heat?.byEffect || {});
  if (fx.length) await db.query('insert into effects (effect_name, heat_share) values ?', [fx]);
  const { byType: _t, byEffect: _e, ...heatRules } = lib.heat || {};
  // (The rest of the library's sections, life support's say, a rule each of their settings.)
  const sections = Object.entries(lib).filter(([k]) => !['about', 'types', 'heat'].includes(k));
  const rules = [['system-types.about', lib.about], ...Object.entries(heatRules).map(([k, v]) => [`heat.${k}`, v]),
    ...sections.flatMap(([sec, v]) => Object.entries(v).map(([k, x]) => [`${sec}.${k}`, x]))].filter(([, v]) => v !== undefined);
  await db.query("delete from game_rules where rule_name like '%.%'");
  if (rules.length) await db.query('insert into game_rules (rule_name, value) values ?', [rules.map(([k, v]) => [k, JSON.stringify(v)])]);
}
// A vessel kind: its design (every field, as its file has it), its systems (what each changes from
// its type's defaults) and its links (a row each).
async function loadClass(db, { id, file, graph }) {
  const [types] = await db.query('select base_system_id, base_system_name, defaults from base_systems');
  const typeId = Object.fromEntries(types.map((r) => [r.base_system_name, r.base_system_id]));
  const defaults = Object.fromEntries(types.map((r) => [r.base_system_name, dec(J(r.defaults))]));
  await db.query('insert into classes (class_code, class_name, kind, design, graph_places) values (?, ?, ?, ?, ?) on duplicate key update class_name = values(class_name), kind = values(kind), design = values(design), graph_places = values(graph_places)',
    [id, graph.name, graph.type, JSON.stringify(enc(file)), JSON.stringify(enc(graph.places ?? null))]);
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
// The star charts: each system, its stars and its other bodies (planets...), and the starbases,
// waypoints and relay.
const MK = { Sol: { spectral_class: 'G', spectral_subclass: 2, luminosity_class: 'V' } }; // (known stars' classes)
const PLANET = { Earth: 'M', Mars: 'K', Jupiter: 'J', Saturn: 'J', Venus: 'N', Mercury: 'B' }; // (known worlds' classes)
async function loadCharts(db) {
  for (const [code, chart] of Object.entries(CONFIG.files.systems())) {
    await db.query('insert into star_systems (star_system_code, star_system_name, size, about) values (?, ?, ?, ?) on duplicate key update star_system_name = values(star_system_name), size = values(size), about = values(about)', [code, chart.name, chart.size, chart.about ?? null]);
    const [[{ star_system_id: sid }]] = await db.query('select star_system_id from star_systems where star_system_code = ?', [code]);
    let starId = null;
    const bodies = chart.bodies || [];
    for (const b of bodies.filter((x) => x.kind === 'star')) {
      const mk = MK[b.name] || {};
      await db.query('insert into stars (star_system_id, star_name, star_x, star_y, radius, spectral_class, spectral_subclass, luminosity_class) values (?, ?, ?, ?, ?, ?, ?, ?) on duplicate key update star_x = values(star_x), star_y = values(star_y), radius = values(radius), spectral_class = values(spectral_class), spectral_subclass = values(spectral_subclass), luminosity_class = values(luminosity_class)',
        [sid, b.name, b.x, b.y, b.r ?? null, mk.spectral_class ?? null, mk.spectral_subclass ?? null, mk.luminosity_class ?? null]);
      const [[r]] = await db.query('select star_id from stars where star_system_id = ? and star_name = ?', [sid, b.name]);
      starId ??= r.star_id;
    }
    for (const b of bodies.filter((x) => x.kind !== 'star')) {
      await db.query(`insert into planets (star_id, planet_name, body_kind, x, y, radius, planet_type) values (?, ?, ?, ?, ?, ?, (select planet_type_id from planet_types where planet_type_code = ?))
        on duplicate key update body_kind = values(body_kind), x = values(x), y = values(y), radius = values(radius), planet_type = values(planet_type)`, [starId, b.name, b.kind || 'planet', b.x, b.y, b.r ?? null, PLANET[b.name] ?? null]);
    }
    await db.query('delete from chart_objects where star_system_id = ?', [sid]);
    const objs = [...(chart.starbases || []).map((b) => ['starbase', b]), ...(chart.waypoints || []).map((w) => ['waypoint', w]), ...(chart.relay ? [['relay', chart.relay]] : [])];
    if (objs.length) await db.query('insert into chart_objects (star_system_id, kind, name, x, y, props) values ?', [objs.map(([k, { name, x, y, ...rest }]) => [sid, k, name, x, y, JSON.stringify(rest)])]);
  }
}
async function load(db) {
  const all = graphs();
  await loadTypes(db, all);
  for (const c of all) await loadClass(db, c);
  await loadCharts(db);
  return all.length;
}

// --- the database's game, read ----------------------------------------------------------------

// The designs, as their files had them: { id: design }.
async function readDesigns(db) {
  const [rows] = await db.query('select class_code, design from classes where class_code is not null order by class_id');
  return Object.fromEntries(rows.map((r) => [r.class_code, dec(J(r.design))]));
}
// The star charts, as their files had them: { code: chart }.
async function readCharts(db) {
  const [systems] = await db.query('select star_system_id, star_system_code, star_system_name, size, about from star_systems order by star_system_id');
  const out = {};
  for (const s of systems) {
    const [stars] = await db.query('select star_id, star_name, star_x, star_y, radius from stars where star_system_id = ? order by star_id', [s.star_system_id]);
    const [planets] = stars.length ? await db.query('select planet_name, body_kind, x, y, radius from planets where star_id in (?) order by planet_id', [stars.map((r) => r.star_id)]) : [[]];
    const [objs] = await db.query('select kind, name, x, y, props from chart_objects where star_system_id = ? order by chart_object_id', [s.star_system_id]);
    const body = (name, kind, x, y, r) => ({ name, kind, x, y, ...(r === null ? {} : { r }) });
    const obj = (o) => ({ name: o.name, x: o.x, y: o.y, ...J(o.props) });
    const relay = objs.find((o) => o.kind === 'relay');
    out[s.star_system_code] = { ...(s.about === null ? {} : { about: s.about }), name: s.star_system_name, size: s.size,
      bodies: [...stars.map((r) => body(r.star_name, 'star', r.star_x, r.star_y, r.radius)), ...planets.map((r) => body(r.planet_name, r.body_kind, r.x, r.y, r.radius))],
      starbases: objs.filter((o) => o.kind === 'starbase').map(obj), waypoints: objs.filter((o) => o.kind === 'waypoint').map(obj), ...(relay ? { relay: obj(relay) } : {}) };
  }
  return out;
}
// The system library, as config/system-types.json has it: { about, types, heat }.
async function readTypes(db) {
  const [types] = await db.query('select base_system_name, info, heat from base_systems where info is not null order by base_system_id');
  const [fx] = await db.query('select effect_name, heat_share from effects order by effect_name');
  const [rules] = await db.query('select rule_name, cast(value as char) value from game_rules'); // (as text: a JSON string could come back either way)
  const rule = Object.fromEntries(rules.map((r) => [r.rule_name, J(r.value)]));
  const heatRules = Object.fromEntries(Object.entries(rule).filter(([k]) => k.startsWith('heat.')).map(([k, v]) => [k.slice(5), v]));
  const sections = {};
  for (const [k, v] of Object.entries(rule)) { const [sec, ...rest] = k.split('.'); if (!['heat', 'system-types'].includes(sec)) (sections[sec] ||= {})[rest.join('.')] = v; }
  return { ...(rule['system-types.about'] === undefined ? {} : { about: rule['system-types.about'] }), types: Object.fromEntries(types.map((r) => [r.base_system_name, J(r.info)])),
    heat: { ...heatRules, byType: Object.fromEntries(types.filter((r) => r.heat !== null).map((r) => [r.base_system_name, J(r.heat)])), byEffect: Object.fromEntries(fx.map((r) => [r.effect_name, r.heat_share])) }, ...sections };
}
// What the game starts from: { designs, charts, types, differs }. An empty database is loaded from
// config/ first; differs: the designs whose file in config/ says something else (the database's is used).
async function snapshot(db) {
  const [[{ n }]] = await db.query('select count(*) n from classes where design is not null and class_code is not null');
  if (!n) await load(db);
  const designs = await readDesigns(db), files = CONFIG.files.ships();
  const differs = [...new Set([...Object.keys(designs), ...Object.keys(files)])].filter((id) => !designs[id] || !files[id] || !same(designs[id], files[id])).sort();
  return { designs, charts: await readCharts(db), types: await readTypes(db), differs };
}

// --- the game's state -------------------------------------------------------------------------

const classIdOf = async (db, code) => { if (!code) return null; const [[r]] = await db.query('select class_id from classes where class_code = ?', [code]); return r?.class_id ?? null; };
const num = (v) => (Number.isFinite(v) ? v : null);
// A ship's save (as its computer keeps it: { x, y, heading, warp, dest, power, class, game, combat, eng }).
async function writeNav(db, ship, nav) {
  await db.query('insert into ships (ship_name, ship_class, x, y, game, state) values (?, ?, ?, ?, ?, ?) on duplicate key update ship_class = coalesce(values(ship_class), ship_class), x = values(x), y = values(y), game = values(game), state = values(state)',
    [ship, await classIdOf(db, nav?.class), num(nav?.x), num(nav?.y), nav?.game ?? null, JSON.stringify(nav ?? {})]);
}
async function readNav(db, ship) {
  const [[r]] = await db.query('select state from ships where ship_name = ?', [ship]);
  return r ? J(r.state) : null;
}
// The starbases' and relays' state (as data/starbases.json: { __game, <name>: { ... } }), or null.
async function readBases(db) {
  const [rows] = await db.query("select s.ship_name, s.game, s.state from ships s join classes c on c.class_id = s.ship_class where c.kind in ('starbase', 'relay') order by s.ship_id");
  if (!rows.length) return null;
  const games = [...new Set(rows.map((r) => r.game).filter(Boolean))];
  return { ...(games.length === 1 ? { __game: games[0] } : {}), ...Object.fromEntries(rows.map((r) => [r.ship_name, J(r.state)])) };
}
// (relays: which of them are subspace relays; the rest are starbases.)
async function writeBases(db, bases, relays = []) {
  const [kinds] = await db.query("select class_id, kind from classes where kind in ('starbase', 'relay') order by class_id");
  const cls = (kind) => kinds.find((k) => k.kind === kind)?.class_id ?? null;
  for (const [name, state] of Object.entries(bases)) {
    if (name === '__game' || !state) continue;
    await db.query('insert into ships (ship_name, ship_class, x, y, game, state) values (?, ?, ?, ?, ?, ?) on duplicate key update ship_class = values(ship_class), x = coalesce(values(x), x), y = coalesce(values(y), y), game = values(game), state = values(state)',
      [name, cls(relays.includes(name) ? 'relay' : 'starbase'), num(state.nav?.x), num(state.nav?.y), bases.__game ?? null, JSON.stringify(state)]);
  }
}
// The accounts (as data/users.json and data/sessions.json).
async function readUsers(db) {
  const [rows] = await db.query('select * from users order by username');
  return Object.fromEntries(rows.map((r) => [r.username, { salt: r.salt, hash: r.hash, role: r.role, status: r.status, created: Number(r.created), characters: J(r.characters), ...(r.last_login === null ? {} : { lastLogin: Number(r.last_login) }) }]));
}
async function readSessions(db) {
  const [rows] = await db.query('select * from sessions');
  return Object.fromEntries(rows.map((r) => [r.token_sha, { user: r.username, created: Number(r.created), seen: Number(r.seen) }]));
}
// What changed: { put: { name: account }, drop: [names] }. (An account another process changed,
// and this one didn't, is left as it is.)
async function writeUsers(db, { put = {}, drop = [] }) {
  for (const [name, u] of Object.entries(put)) {
    await db.query('insert into users (username, salt, hash, role, status, created, last_login, characters) values (?, ?, ?, ?, ?, ?, ?, ?) on duplicate key update salt = values(salt), hash = values(hash), role = values(role), status = values(status), created = values(created), last_login = values(last_login), characters = values(characters)',
      [name, u.salt, u.hash, u.role, u.status, u.created || Date.now(), u.lastLogin ?? null, JSON.stringify(u.characters || [])]);
  }
  if (drop.length) await db.query('delete from users where username in (?)', [drop]);
}
// (A session of an account that's gone isn't kept.)
async function writeSessions(db, { put = {}, drop = [] }) {
  for (const [sha, s] of Object.entries(put)) {
    await db.query('insert into sessions (token_sha, username, created, seen) select ?, ?, ?, ? from users where username = ? on duplicate key update seen = values(seen)', [sha, s.user, s.created, s.seen, s.user]);
  }
  if (drop.length) await db.query('delete from sessions where token_sha in (?)', [drop]);
}
// A write, from tools/store.js.
async function apply(db, op) {
  if (op.kind === 'nav') return writeNav(db, op.ship, op.nav);
  if (op.kind === 'bases') return writeBases(db, op.bases, op.relays);
  if (op.kind === 'users') return writeUsers(db, op);
  if (op.kind === 'sessions') return writeSessions(db, op);
  throw new Error(`no such write: ${op.kind}`);
}
// A cycle of writes, as one transaction: all of it or none (a crash or an error part-way leaves the
// database as it was). Rows are taken in one order (the accounts, the starbases, then each ship by
// name), and a deadlock or a lock wait that timed out is tried again, not dropped.
const RANK = { users: 0, sessions: 1, bases: 2, nav: 3 };
async function applyAll(db, ops) {
  const sorted = [...ops].sort((a, b) => (RANK[a.kind] ?? 9) - (RANK[b.kind] ?? 9) || (a.kind === 'nav' && b.kind === 'nav' ? String(a.ship).localeCompare(String(b.ship)) : 0));
  for (let tries = 0; ; tries++) {
    await db.query('start transaction');
    try {
      for (const op of sorted) await apply(db, op);
      await db.query('commit');
      return;
    } catch (err) {
      await db.query('rollback').catch(() => {});
      if ((err.errno === 1213 || err.errno === 1205) && tries < 5) { await new Promise((r) => setTimeout(r, 50 * 2 ** tries)); continue; }
      throw err;
    }
  }
}
const readJson = (f) => { try { return f ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch { return null; } };
// The relay's state; the first time, what the files hold brought in ({ starbases, users, sessions }: their paths).
async function relayState(db, files = {}) {
  let bases = await readBases(db);
  const [[{ n: users }]] = await db.query('select count(*) n from users');
  const imported = [];
  if (!bases && readJson(files.starbases)) {
    const [relays] = await db.query("select name from chart_objects where kind = 'relay'");
    await writeBases(db, readJson(files.starbases), relays.map((r) => r.name));
    bases = await readBases(db); imported.push(files.starbases);
  }
  if (!users && readJson(files.users)) {
    await writeUsers(db, { put: readJson(files.users) });
    await writeSessions(db, { put: readJson(files.sessions) || {} });
    imported.push(files.users, ...(readJson(files.sessions) ? [files.sessions] : []));
  }
  return { bases: bases || {}, users: await readUsers(db), sessions: await readSessions(db), imported };
}
// A ship's save; one the database hasn't seen yet, its file's brought in.
async function nav(db, ship, file) {
  const have = await readNav(db, ship);
  if (have) return { nav: have, imported: false };
  const fromFile = readJson(file);
  if (fromFile) { await writeNav(db, ship, fromFile); return { nav: fromFile, imported: true }; }
  return { nav: null, imported: false };
}
// A design saved (its file written first: its graph is worked out from config/, as the relay does).
async function saveDesign(db, id, design) {
  const [one] = graphs([id]);
  if (!one) throw new Error(`no graph for ${id}`);
  await loadClass(db, { id, file: design, graph: one.graph });
}

// The database's designs and star charts, written to config/ (each changed file's old copy kept).
async function exportConfig(db) {
  const out = [];
  for (const [id, design] of Object.entries(await readDesigns(db))) if (CONFIG.files.writeShip(id, design)) out.push(`config/ships/${id}.json`);
  for (const [code, chart] of Object.entries(await readCharts(db))) if (CONFIG.files.writeSystem(code, chart)) out.push(`config/starsystem/${code}.json`);
  return out;
}

// --- check: a class read back is the relay's graph ---------------------------------------------

// A class read back: its systems merged (type defaults, patched by the class), nested; its links.
async function readClass(db, code) {
  const [[c]] = await db.query('select class_id, class_code, class_name, kind, graph_places from classes where class_code = ?', [code]);
  if (!c) return null;
  const [sys] = await db.query('select system_key, parent_key, system_type, props from vw_class_systems where class_id = ? order by sort_order', [c.class_id]);
  const [links] = await db.query('select system_key, other_key, resource, link from class_links where class_id = ? order by sort_order', [c.class_id]);
  const nodes = {}, top = {};
  for (const r of sys) nodes[r.system_key] = { type: r.system_type, ...dec(J(r.props)) };
  for (const l of links) ((nodes[l.system_key].upstream ||= {})[l.other_key] ||= {})[l.resource] = dec(J(l.link));
  for (const k of Object.keys(nodes)) nodes[k].upstream ||= {};
  for (const r of sys) (r.parent_key ? (nodes[r.parent_key].systems ||= {}) : top)[r.system_key] = nodes[r.system_key];
  return { schema: GRAPH.SCHEMA, type: c.kind, class: c.class_code, name: c.class_name, places: dec(J(c.graph_places)), systems: top };
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

const stdin = () => { const t = fs.readFileSync(0, 'utf8'); return t ? JSON.parse(t) : null; };
const print = (v) => fs.writeSync(1, JSON.stringify(v)); // (all of it: a pipe takes a big write in parts)
async function main(argv) {
  const [cmd, ...rest] = argv;
  const db = await connect();
  try {
    if (cmd === 'migrate') { await migrate(db); console.log('migrated: db/schema.sql and db/seed.sql applied'); }
    else if (cmd === 'load') console.log(`loaded ${await load(db)} vessel kinds, the star charts and the system library from config/`);
    else if (cmd === 'export') { const w = await exportConfig(db); console.log(w.length ? `written: ${w.join(', ')}` : 'config/ already says what the database does'); }
    else if (cmd === 'check') {
      const res = await check(db);
      for (const [id, ok, n] of res) console.log(`${id}: ${ok ? 'the same' : 'DIFFERENT'} (${n} systems)`);
      return res.every(([, ok]) => ok) ? 0 : 1;
    } else if (cmd === 'show') {
      const [code, key] = rest;
      const [rows] = await db.query(`select system_key, parent_key, system_type, props from vw_class_systems where class_code = ? ${key ? 'and system_key = ?' : ''} order by sort_order`, key ? [code, key] : [code]);
      for (const r of rows) console.log(`${r.system_key}${r.parent_key ? ` (in ${r.parent_key})` : ''} [${r.system_type}] ${JSON.stringify(dec(J(r.props)))}`);
    } else if (cmd === 'snapshot') print(await snapshot(db));
    else if (cmd === 'relay-state') print(await relayState(db, stdin() || {}));
    else if (cmd === 'nav') print(await nav(db, rest[0], rest[1]));
    else if (cmd === 'write') { await applyAll(db, stdin() || []); print(true); }
    else if (cmd === 'save-design') { await saveDesign(db, rest[0], stdin()); print(true); }
    else { console.log('usage: node tools/db.js migrate | load | export | check | show <class> [system]'); return 2; }
    return 0;
  } finally { await db.end(); }
}

module.exports = { connect, settings, migrate, load, readClass, check, common, diff, enc, dec, same, apply, applyAll, snapshot, relayState, nav, readDesigns, readCharts, readTypes, readBases, readUsers, readSessions, readNav, exportConfig };
if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (err) => { console.error(err.message); process.exitCode = 1; });
