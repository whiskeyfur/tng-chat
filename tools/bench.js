#!/usr/bin/env node
// Speed tests (John's): which is faster, run here, each timed many times (the median).
//   1. The game's start: the designs, the star chart and the system library from the files, or from
//      the database (on an open connection; and as the game does it, a child process each time).
//   2. A ship's save, written and read: its .nav.json, or its row (one transaction a write).
//   3. A tick's power, every ship class in every grid state: the graph solver, or the path tracer.
//   4. The path tracer in SQL (db/path-solver.sql: a stored procedure, a recursive query for each
//      path) against the same in JavaScript, on the same network, the answers compared.
// The database is the test one (DB_TEST_NAME, startrek_test by default): never the game's.
//   node tools/bench.js [--runs 200]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
process.env.DB_NAME = process.env.DB_TEST_NAME || 'startrek_test';
const DB = require('./db');
const CONFIG = require('./config');
const GRAPH = require('./ship-graph');
const SOLVER = require('./graph-solver');
const PATH = require('./path-solver');
require('./store').filesOnly();

const RUNS = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 200;
const ROOT = path.join(__dirname, '..');
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const now = () => Number(process.hrtime.bigint()) / 1e6; // ms
const time = (fn, runs = RUNS) => { fn(); const xs = []; for (let i = 0; i < runs; i++) { const t = now(); fn(); xs.push(now() - t); } return median(xs); };
const timeAsync = async (fn, runs = RUNS) => { await fn(); const xs = []; for (let i = 0; i < runs; i++) { const t = now(); await fn(); xs.push(now() - t); } return median(xs); };
const ms = (x) => (x >= 100 ? `${x.toFixed(0)} ms` : x >= 1 ? `${x.toFixed(2)} ms` : `${(x * 1000).toFixed(1)} µs`);
const rows = [];
const row = (what, a, aName, b, bName) => { rows.push([what, `${aName} ${ms(a)}`, `${bName} ${ms(b)}`, a < b ? `${aName}, ${(b / a).toFixed(1)}×` : `${bName}, ${(a / b).toFixed(1)}×`]); console.log(`${what}: ${aName} ${ms(a)}, ${bName} ${ms(b)}`); };

(async () => {
  const db = await DB.connect();
  try {
    await DB.migrate(db);
    const [[{ n }]] = await db.query('select count(*) n from classes');
    if (!n) await DB.load(db);
    console.log(`# ${os.cpus()[0].model}, node ${process.version}, ${RUNS} runs each (median), database ${process.env.DB_NAME}`);

    // 1. The game's start.
    const files = time(() => { CONFIG.files.loadShips(() => {}); CONFIG.files.systems(); CONFIG.files.types(); });
    const inDb = await timeAsync(async () => { await DB.readDesigns(db); await DB.readCharts(db); await DB.readTypes(db); });
    row('Start: designs, chart, system library', files, 'files', inDb, 'database');
    const child = time(() => execFileSync(process.execPath, [path.join(__dirname, 'db.js'), 'snapshot'], { maxBuffer: 256 << 20, env: { ...process.env } }), Math.min(RUNS, 20));
    const childFiles = time(() => execFileSync(process.execPath, ['-e', "const C=require('./tools/config');C.files.loadShips(()=>{});C.files.systems();C.files.types()"], { cwd: ROOT }), Math.min(RUNS, 20));
    row('Start, as the game does it (a child process)', childFiles, 'files', child, 'database');

    // 2. A ship's save.
    const navFile = ['shipcore-data/Discovery/.nav.json', '../web-rtc/shipcore-data/Discovery/.nav.json'].map((f) => path.join(ROOT, f)).find((f) => fs.existsSync(f));
    const nav = navFile ? JSON.parse(fs.readFileSync(navFile, 'utf8')) : { x: 1, y: 2, eng: { filler: 'x'.repeat(13000) } };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-bench-')), f = path.join(tmp, '.nav.json');
    const fileWrite = time(() => { fs.writeFileSync(`${f}.tmp`, JSON.stringify(nav)); fs.renameSync(`${f}.tmp`, f); });
    const dbWrite = await timeAsync(() => DB.applyAll(db, [{ kind: 'nav', ship: 'Benchship', nav: { ...nav, x: Math.random() } }]));
    row(`A ship's save written (${(JSON.stringify(nav).length / 1024).toFixed(1)} KB)`, fileWrite, 'file', dbWrite, 'database');
    const fileRead = time(() => JSON.parse(fs.readFileSync(f, 'utf8')));
    const dbRead = await timeAsync(() => DB.readNav(db, 'Benchship'));
    row('A ship\'s save read', fileRead, 'file', dbRead, 'database');
    fs.rmSync(tmp, { recursive: true, force: true });
    await db.query("delete from ships where ship_name = 'Benchship'");

    // 3. A tick's power.
    const d = GRAPH.dump({ scenarios: true }), t = d.tables, { classes } = CONFIG.files.loadShips(() => {});
    const per = { graph: [], path: [] };
    for (const id of Object.keys(d.scenarios)) {
      const g = GRAPH.convert(id, classes[id], d);
      for (const sc of Object.values(d.scenarios[id])) {
        const rt = SOLVER.fromRelay(g, sc.state, t);
        per.graph.push(time(() => SOLVER.solve(g, rt)));
        per.path.push(time(() => PATH.solve(g, rt)));
      }
    }
    row(`A ship's power, one tick (median of ${per.graph.length} states)`, median(per.graph), 'graph solver', median(per.path), 'path tracer');
    row('A ship\'s power, one tick (the slowest state)', Math.max(...per.graph), 'graph solver', Math.max(...per.path), 'path tracer');

    // 4. The path tracer in SQL, on the same networks.
    await db.query(fs.readFileSync(path.join(ROOT, 'db', 'path-solver.sql'), 'utf8'));
    const sqlTimes = [], jsTimes = [], mismatches = [];
    const SQL_RUNS = Math.max(3, Math.min(RUNS, 10));
    for (const id of Object.keys(d.scenarios)) {
      const g = GRAPH.convert(id, classes[id], d);
      for (const [name, sc] of Object.entries(d.scenarios[id])) {
        const rt = SOLVER.fromRelay(g, sc.state, t);
        const { node, out } = PATH.solveGroup([{ g, rt }], [], { networkOnly: true });
        const keys = Object.keys(node), num = Object.fromEntries(keys.map((k, i) => [k, i + 1]));
        const big = (x) => (Number.isFinite(x) ? x : 1e300);
        const nodes = keys.map((k) => { const v = node[k]; return [num[k], v.kind, v.m, v.last ? 1 : 0, big(v.cap ?? Infinity), 0, big(v.left ?? 0), 0, big(v.pri ?? 0), v.want || 0, v.min || 0, 0]; });
        const edges = Object.values(out).flat().map((e, i) => [i + 1, num[e.from], num[e.to], big(e.cap), 0]);
        const load = async () => {
          await db.query('delete from pt_node'); await db.query('delete from pt_edge');
          await db.query('insert into pt_node (id, kind, m, last, cap, used, lft, given, pri, want, min_n, got) values ?', [nodes]);
          if (edges.length) await db.query('insert into pt_edge (id, src, dst, cap, used) values ?', [edges]);
        };
        const xs = [];
        for (let i = 0; i < SQL_RUNS; i++) { await load(); const t0 = now(); await db.query('call pt_solve()'); xs.push(now() - t0); }
        sqlTimes.push(median(xs));
        jsTimes.push(time(() => PATH.solve(g, rt)));
        // (The same answers: what each load got.)
        const [got] = await db.query("select id, got from pt_node where kind = 'load'");
        const js = PATH.solve(g, rt), byNum = Object.fromEntries(keys.map((k) => [num[k], node[k].id]));
        for (const r of got) if (Math.abs(r.got - (js.got[byNum[r.id]] || 0)) > 1e-6) mismatches.push(`${id}/${name} ${byNum[r.id]}: SQL ${r.got}, JS ${js.got[byNum[r.id]]}`);
      }
    }
    row(`The path tracer, one tick (median of ${sqlTimes.length} states)`, median(jsTimes), 'JavaScript', median(sqlTimes), 'SQL');
    row('The path tracer, one tick (the slowest state)', Math.max(...jsTimes), 'JavaScript', Math.max(...sqlTimes), 'SQL');
    console.log(mismatches.length ? `# SQL and JavaScript differ on ${mismatches.length} loads:\n#   ${mismatches.slice(0, 20).join('\n#   ')}` : `# SQL and JavaScript gave every load the same, in all ${sqlTimes.length} states`);
    console.log('\n| Test | A | B | Faster |\n|---|---|---|---|');
    for (const r of rows) console.log(`| ${r.join(' | ')} |`);
  } finally { await db.end(); }
})().catch((err) => { console.error(err.stack || err.message); process.exitCode = 1; });
