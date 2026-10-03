// The ship designer (admin, /shipdesigner): a vessel's graph of systems edited as nodes and wires
// (public/shipdesigner.js, on litegraph). Its requests, all an admin's:
//   GET  /api/ship-designs            the design files' ids and names, and the type library
//   GET  /api/ship-designs/<id>       one design file (a graph) and its node positions
//   POST /api/ship-designs/check      { id, graph }: what's wrong with it, and whether it's stable
//                                     (nothing saved)
//   PUT  /api/ship-designs/<id>       { graph, layout, asNew }: saved by config.saveShip (checked
//                                     first, the old file kept in config/ships/.backup/)
// Node positions are the designer's own, in config/layouts/ships/<id>.json (not read by the game;
// the supervisor doesn't reload for them). Saving a design reloads the relay as the admin page's does.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const CONFIG = require('./config');
const GRAPH = require('./ship-graph');

const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_BODY = 4 * 1024 * 1024;
const LAYOUT_DIR = path.join(CONFIG.DIR, 'layouts', 'ships');

const library = () => JSON.parse(fs.readFileSync(path.join(CONFIG.DIR, 'system-types.json'), 'utf8'));
const readLayout = (id) => { try { return JSON.parse(fs.readFileSync(path.join(LAYOUT_DIR, `${id}.json`), 'utf8')); } catch { return null; } };

// What's wrong with a graph: the checker's list, then the design fields worked out of it as the
// loader reads them (config.checkShip), as saving checks it.
function problems(graph) {
  if (!GRAPH.isGraphFile(graph)) return [`not a ship graph (schema "${GRAPH.SCHEMA}", type, systems)`];
  const bad = GRAPH.check(graph);
  if (bad.length) return bad;
  let design;
  try { design = GRAPH.toDesign(graph); } catch (e) { return [`its design fields can't be worked out: ${e.message}`]; }
  const wrong = CONFIG.checkShip(design);
  return wrong ? [`${wrong.field ? `${wrong.field}: ` : ''}${wrong.message}`] : [];
}

// Stable, as `ship-graph.js --check` asks: the design fields worked out of it build the same graph.
// Until step 4 is done parts of the relay still read those fields, so a graph that isn't stable
// (a system they have no table for, say) plays partly as the rebuilt one. A warning, not a refusal.
// The relay's dump is run on a copy of config/ with this graph in it (asynchronously: the relay
// this runs in keeps going).
function stability(id, graph) {
  return new Promise((resolve) => {
    let tmp;
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-designer-'));
      const cfg = path.join(tmp, 'config'), data = path.join(tmp, 'data');
      fs.cpSync(CONFIG.DIR, cfg, { recursive: true, filter: (f) => { const rel = path.relative(CONFIG.DIR, f).split(path.sep); return !rel.includes('.backup') && rel[0] !== 'layouts'; } });
      fs.mkdirSync(path.join(cfg, 'ships'), { recursive: true });
      fs.writeFileSync(path.join(cfg, 'ships', `${id}.json`), JSON.stringify(graph));
      fs.mkdirSync(data);
      execFile(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), maxBuffer: 64 << 20, timeout: 30000,
        env: { ...process.env, CONFIG_DIR: cfg, SHIP_GRAPH_DUMP: '1', PORT: '0', RELAY_DATA: data, STARBASES_FILE: path.join(data, 'starbases.json'), SHIPCORE_DATA: data } }, (err, out) => {
        fs.rmSync(tmp, { recursive: true, force: true });
        if (err) return resolve([`couldn't check it's stable: ${err.message.split('\n')[0]}`]);
        try {
          const again = GRAPH.toFile(id, GRAPH.toDesign(graph), JSON.parse(out));
          const a = GRAPH.nodes(graph).all, b = GRAPH.nodes(again).all, warn = [];
          for (const k of Object.keys(again)) if (k !== 'systems' && JSON.stringify(again[k]) !== JSON.stringify(graph[k])) warn.push(`${k}: rebuilt differently from the design fields`);
          for (const k of Object.keys(a)) if (!b[k]) warn.push(`systems.${k}: the design fields have no place for it (the old tables don't know it)`);
          for (const k of Object.keys(b)) if (!a[k]) warn.push(`systems.${k}: the design fields add it back`);
          for (const k of Object.keys(a)) if (b[k] && JSON.stringify(a[k]) !== JSON.stringify(b[k])) warn.push(`systems.${k}: the design fields rebuild it differently`);
          resolve(warn.length ? [`not stable: parts of the relay that still read the old design fields (until step 4c/4d) will see it as rebuilt from them.`, ...warn] : []);
        } catch (e) { resolve([`couldn't check it's stable: ${e.message}`]); }
      });
    } catch (e) { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); resolve([`couldn't check it's stable: ${e.message}`]); }
  });
}

// Positions: { nodes: { id: [x, y] }, groups: { id: [x, y, w, h] }, view: { offset, scale } }.
function cleanLayout(v) {
  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const out = { nodes: {}, groups: {} };
  for (const [k, p] of Object.entries(v?.nodes || {})) if (/^[a-z0-9][a-z0-9-]*$/.test(k) && Array.isArray(p) && p.length === 2 && p.every(num)) out.nodes[k] = p.map(Math.round);
  for (const [k, p] of Object.entries(v?.groups || {})) if (/^[a-z0-9][a-z0-9-]*$/.test(k) && Array.isArray(p) && p.length === 4 && p.every(num)) out.groups[k] = p.map(Math.round);
  if (v?.view && Array.isArray(v.view.offset) && v.view.offset.length === 2 && v.view.offset.every(num) && num(v.view.scale)) out.view = { offset: v.view.offset, scale: v.view.scale };
  return out;
}

function request(req, res, urlPath, { admin, log = console.log }) {
  const json = (code, v) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(v));
  if (!admin) return json(403, { error: 'the ship designer is for an admin' });
  const what = decodeURIComponent(urlPath.slice('/api/ship-designs'.length).replace(/^\//, ''));
  const body = (done) => {
    const parts = []; let size = 0, over = false;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { over = true; req.destroy(); } else parts.push(c); });
    req.on('end', () => {
      if (over) return;
      let v; try { v = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return json(400, { error: 'not JSON' }); }
      done(v);
    });
    req.on('close', () => { if (over && !res.headersSent) json(413, { error: 'too big' }); });
  };
  const files = CONFIG.readShipFiles();
  if (!what && req.method === 'GET') {
    const lib = library();
    return json(200, {
      designs: Object.entries(files).map(([id, g]) => ({ id, name: g.name || id, graph: GRAPH.isGraphFile(g), type: g.type || g.kind || 'ship' })).sort((a, b) => a.id.localeCompare(b.id)),
      // (The features: every effect a design file uses, for the node menu.)
      effects: [...new Set(Object.values(files).filter(GRAPH.isGraphFile).flatMap((g) => Object.values(GRAPH.nodes(g).all).flatMap((x) => Object.keys(x?.effects || {}))))].sort(),
      types: lib.types, heat: lib.heat, resources: GRAPH.RESOURCES, perms: GRAPH.PERMS, meta: GRAPH.META, schema: GRAPH.SCHEMA,
    });
  }
  if (what === 'check' && req.method === 'POST') {
    return body(async (v) => {
      const bad = problems(v.graph);
      const id = ID_RE.test(String(v.id || '')) ? v.id : v.graph?.class;
      json(200, { problems: bad, warnings: bad.length || !ID_RE.test(String(id || '')) ? [] : await stability(id, v.graph) });
    });
  }
  if (!ID_RE.test(what)) return json(404, { error: 'no such design' });
  if (req.method === 'GET') return files[what] ? json(200, { graph: files[what], layout: readLayout(what) }) : json(404, { error: 'no such design' });
  if (req.method === 'PUT') {
    return body((v) => {
      if (v.asNew && files[what]) return json(409, { saved: false, problems: [`there's already a design ${what}`] });
      if (!v.asNew && !files[what]) return json(404, { saved: false, problems: ['no such design (Save as, for a new one)'] });
      const bad = problems(v.graph);
      if (bad.length) return json(400, { saved: false, problems: bad });
      // (Unchanged: not written, so the relay isn't reloaded for nothing.)
      const same = files[what] && JSON.stringify(files[what]) === JSON.stringify(v.graph);
      if (!same) {
        const err = CONFIG.saveShip(what, v.graph);
        if (err) return json(400, { saved: false, problems: [`${err.field ? `${err.field}: ` : ''}${err.message}`] });
      }
      const finish = (warnings) => {
        if (v.layout) {
          fs.mkdirSync(LAYOUT_DIR, { recursive: true });
          fs.writeFileSync(path.join(LAYOUT_DIR, `${what}.json`), JSON.stringify(cleanLayout(v.layout), null, 1) + '\n');
        }
        log(`ship designer: ${what} ${same ? 'positions saved (design unchanged)' : `saved${v.asNew ? ' (a new design)' : ''}`}`);
        json(200, { saved: true, id: what, changed: !same, warnings, note: same ? 'positions saved; the design was unchanged' : process.send ? 'saved: the supervisor reloads the relay to apply it' : 'saved (no supervisor here: restart the relay to apply it)' });
      };
      if (same) return finish([]);
      stability(what, v.graph).then(finish);
    });
  }
  json(405, { error: 'GET, POST check, PUT' });
}

module.exports = { request, problems, LAYOUT_DIR };
