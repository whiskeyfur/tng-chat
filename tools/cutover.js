// The cutover to the graph engine (docs/ship-graph.md, step 3): a new game. The game so far
// (shipcore-data/, the ships' computers' saves, and data/starbases.json) is copied to a dated folder in
// backups/, never deleted; data/settings.json gets engine "graph" and a new game id; accounts and the
// other settings stay. It can run while npm start does: the supervisor restarts the relay on the
// settings change, and the new relay starts every ship and starbase saved in another game new (cold,
// docked at a starbase, its class kept), its computer saving it from then on in the new game.
//   node tools/cutover.js          says what it would do (nothing changes)
//   node tools/cutover.js --go     does it
const fs = require('fs');
const path = require('path');
const SETTINGS = require('./settings');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.RELAY_DATA || path.join(ROOT, 'data');
const SHIPCORE = process.env.SHIPCORE_DATA || path.join(ROOT, 'shipcore-data');
const STARBASES = process.env.STARBASES_FILE || path.join(DATA, 'starbases.json');
const BACKUPS = process.env.BACKUPS_DIR || path.join(ROOT, 'backups');

function plan() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(BACKUPS, `game-${stamp}`);
  const moves = [[SHIPCORE, path.join(dest, 'shipcore-data')], [STARBASES, path.join(dest, 'starbases.json')]].filter(([from]) => fs.existsSync(from));
  return { dest, moves, engine: SETTINGS.read().engine, game: `game-${stamp}` };
}

function main(argv) {
  const go = argv.includes('--go');
  const p = plan();
  const rel = (x) => path.relative(ROOT, x) || '.';
  if (p.engine === 'graph') console.log('The engine is already "graph": the cutover was done before.');
  console.log(`${go ? 'Copying' : 'Would copy'} the game so far to ${rel(p.dest)}/:`);
  for (const [from, to] of p.moves) console.log(`  ${rel(from)} → ${rel(to)}`);
  if (!p.moves.length) console.log('  (nothing: no saved game here)');
  console.log(`${go ? 'Setting' : 'Would set'} data/settings.json engine: "graph", game: "${p.game}" (accounts, sessions and the other settings stay).`);
  if (!go) { console.log('Nothing changed. Run with --go (npm start can stay running: the relay restarts by itself).'); return 0; }
  fs.mkdirSync(p.dest, { recursive: true });
  for (const [from, to] of p.moves) fs.cpSync(from, to, { recursive: true });
  // (Checked before anything else changes: every file there.)
  const count = (x) => (fs.statSync(x).isDirectory() ? fs.readdirSync(x).reduce((n, f) => n + count(path.join(x, f)), 0) : 1);
  for (const [from, to] of p.moves) if (count(from) !== count(to)) throw new Error(`the copy of ${rel(from)} is incomplete: nothing else changed`);
  SETTINGS.save({ engine: 'graph', game: p.game });
  console.log(`Done: a new game (${p.game}) on the graph engine. The old game is in ${rel(p.dest)}/. To go back: stop npm start, copy them back, set engine "relay" and game "" in data/settings.json.`);
  return 0;
}

module.exports = { plan };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
