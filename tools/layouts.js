// LCARS layouts (the admin's layout designer): config/layouts/<name>.json, and the images they
// use in config/layouts/assets/. The supervisor doesn't reload the relay for these (it ignores
// config/layouts), so saving one changes nothing that's running.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DIR: CONFIG_DIR } = require('./config');

const DIR = path.join(CONFIG_DIR, 'layouts');
const ASSETS = path.join(DIR, 'assets');
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const MAX_ASSET = 8 * 1024 * 1024;
const MAX_LAYOUT = 2 * 1024 * 1024;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
// A layout checked: null, or what's wrong.
function check(v) {
  if (!isObj(v)) return 'not an object';
  if (typeof v.aspect !== 'string' || !/^\d+:\d+$/.test(v.aspect)) return 'aspect: like "16:9"';
  if (!Array.isArray(v.items)) return 'items: a list';
  const walk = (items) => {
    for (const it of items) {
      if (!isObj(it) || typeof it.type !== 'string' || typeof it.id !== 'string') return 'an item without a type or id';
      for (const f of ['x', 'y', 'w', 'h']) if (typeof it[f] !== 'number' || !Number.isFinite(it[f])) return `${it.id}: ${f} must be a number`;
      if (it.children !== undefined) { if (!Array.isArray(it.children)) return `${it.id}: children must be a list`; const bad = walk(it.children); if (bad) return bad; }
    }
    return null;
  };
  return walk(v.items);
}

function list() {
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort(); } catch { return []; }
  return files.map((f) => {
    const name = f.slice(0, -5);
    try { const v = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); return { name, title: v.title || name, aspect: v.aspect }; } catch { return { name, title: name, broken: true }; }
  });
}
function read(name) {
  if (!NAME_RE.test(name)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8')); } catch { return null; }
}
// Saved (checked first; the previous version kept as .<name>.json.bak).
function save(name, layout) {
  if (!NAME_RE.test(name)) return 'name: lower-case letters, digits and -';
  const bad = check(layout);
  if (bad) return bad;
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${name}.json`);
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(DIR, `.${name}.json.bak`));
  fs.writeFileSync(path.join(DIR, `.${name}.json.tmp`), JSON.stringify({ ...layout, name }, null, 2) + '\n');
  fs.renameSync(path.join(DIR, `.${name}.json.tmp`), file);
  return null;
}
function assets() {
  try { return fs.readdirSync(ASSETS).filter((f) => IMAGE_TYPES[path.extname(f).toLowerCase()] && !f.startsWith('.')).sort(); } catch { return []; }
}
// An image added: named for its content (the same image twice is one file).
function addAsset(filename, data) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (!IMAGE_TYPES[ext]) return { error: 'an image: png, jpg, gif, webp or svg' };
  if (!data.length || data.length > MAX_ASSET) return { error: 'up to 8 MB' };
  const base = path.basename(String(filename), path.extname(String(filename))).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'image';
  const file = `${base}-${crypto.createHash('sha256').update(data).digest('hex').slice(0, 8)}${ext === '.jpeg' ? '.jpg' : ext}`;
  fs.mkdirSync(ASSETS, { recursive: true });
  if (!fs.existsSync(path.join(ASSETS, file))) fs.writeFileSync(path.join(ASSETS, file), data);
  return { file };
}
function assetPath(file) {
  if (!/^[a-z0-9-]+\.(png|jpg|gif|webp|svg)$/.test(file)) return null;
  const p = path.join(ASSETS, file);
  return fs.existsSync(p) ? { path: p, type: IMAGE_TYPES[path.extname(p)] } : null;
}

module.exports = { DIR, NAME_RE, MAX_ASSET, MAX_LAYOUT, check, list, read, save, assets, addAsset, assetPath };
