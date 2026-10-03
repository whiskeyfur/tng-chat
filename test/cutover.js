// The graph engine's new game (docs/ship-graph.md, step 3), on temporary folders: tools/cutover.js
// says what it would do and changes nothing; with --go it moves the game (the ships' computers'
// saves, the starbases) to a dated backup and sets the engine, accounts and settings kept. Then on
// the graph engine a ship's computer saves its ties by system id, and they come back the same after
// the relay and the computer restart.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 8099) + 12;
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-cutover-'));
const DATA = path.join(TMP, 'data'), CORES = path.join(TMP, 'shipcore-data'), BACKUPS = path.join(TMP, 'backups');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`ok - ${s}`);
const until = async (fn, ms = 15000, what = 'it') => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(150); } throw new Error(`timed out waiting for ${what}`); };
const env = { ...process.env, PORT: String(PORT), RELAY_DATA: DATA, SHIPCORE_DATA: CORES, STARBASES_FILE: path.join(DATA, 'starbases.json'), BACKUPS_DIR: BACKUPS };
const procs = new Set();
const run = (args, extra = {}) => { const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...env, ...extra }, stdio: 'ignore' }); procs.add(p); p.on('exit', () => procs.delete(p)); return p; };
const stop = (p) => new Promise((r) => { if (!p || p.exitCode !== null) return r(); p.once('exit', r); p.kill(); });

(async () => {
  let ok = false;
  try {
    // A game in progress: a ship's save, the starbases, accounts and settings.
    fs.mkdirSync(path.join(CORES, 'Oldship'), { recursive: true });
    fs.writeFileSync(path.join(CORES, 'Oldship', '.nav.json'), '{"x":1}');
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, 'starbases.json'), '{}');
    fs.writeFileSync(path.join(DATA, 'users.json'), '{"users":[]}');
    fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ port: 8085, registration: 'open' }));
    const dry = execFileSync(process.execPath, ['tools/cutover.js'], { cwd: ROOT, env }).toString();
    assert.match(dry, /Would copy/);
    assert.ok(fs.existsSync(path.join(CORES, 'Oldship', '.nav.json')) && !fs.existsSync(BACKUPS), 'a dry run changes nothing');
    execFileSync(process.execPath, ['tools/cutover.js', '--go'], { cwd: ROOT, env });
    const [dest] = fs.readdirSync(BACKUPS);
    assert.match(dest, /^game-\d{4}-/);
    assert.ok(fs.existsSync(path.join(BACKUPS, dest, 'shipcore-data', 'Oldship', '.nav.json')) && fs.existsSync(path.join(BACKUPS, dest, 'starbases.json')), 'the old game in the backup');
    const settings = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8'));
    assert.equal(settings.engine, 'graph'); assert.match(settings.game, /^game-/); assert.equal(settings.registration, 'open', 'the other settings kept');
    assert.ok(fs.existsSync(path.join(DATA, 'users.json')), 'accounts kept');
    step(`the cutover: a dry run changed nothing; --go copied the game to backups/${dest}/, set the engine to "graph" and a new game id, and kept accounts and settings`);
    fs.rmSync(path.join(DATA, 'users.json')); // (no accounts: the relay stays open for this test)

    // The graph engine: a ship saved in the old game (warm, undocked) comes back new: cold, docked, its class kept.
    fs.writeFileSync(path.join(CORES, 'Oldship', '.nav.json'), JSON.stringify({ x: 300, y: 300, heading: 0, warp: 0, dest: null, class: 'runabout', eng: { core: 'online', antimatter: 500, deuterium: 1000, ties: {} } }));
    // The graph engine: a new ship's ties saved by system id, the same after both restart.
    let relay = run(['server.js']);
    const oldCore = run(['tools/shipcore.js', '--relay', `ws://localhost:${PORT}`, '--data', CORES, 'Oldship']);
    const reborn = await until(() => { try { const v = JSON.parse(fs.readFileSync(path.join(CORES, 'Oldship', '.nav.json'), 'utf8')); return v.game ? v : null; } catch { return null; } }, 20000, 'the old ship saved in the new game');
    assert.equal(reborn.class, 'runabout', 'its class kept');
    assert.equal(reborn.eng.core, 'offline', 'cold');
    assert.ok(reborn.eng.docked, 'docked at a starbase');
    await stop(oldCore);
    step(`a ship saved in the old game came back new in the new one: a cold runabout docked at ${reborn.eng.docked}`);
    await wait(1500);
    let core = run(['tools/shipcore.js', '--relay', `ws://localhost:${PORT}`, '--data', CORES, '--warm', 'Graphship']);
    const navFile = path.join(CORES, 'Graphship', '.nav.json');
    const saved = await until(() => { try { const v = JSON.parse(fs.readFileSync(navFile, 'utf8')); return v.eng?.tiesById ? v : null; } catch { return null; } }, 20000, 'a save by system id');
    assert.ok(!saved.eng.ties, 'no ties by the relay\'s names');
    assert.deepEqual(saved.eng.tiesById['console-helm'], ['bus-a'], `the Helm console on Bus A, by id: ${JSON.stringify(saved.eng.tiesById['console-helm'])}`);
    const tiesNow = async () => {
      const ws = new WebSocket(`ws://localhost:${PORT}`), msgs = [];
      ws.on('message', (m) => msgs.push(JSON.parse(m)));
      await new Promise((r) => ws.on('open', r));
      ws.send(JSON.stringify({ type: 'register', name: 'chief', ship: 'Graphship', station: 'Engineering' }));
      const g = await until(() => msgs.find((m) => m.own?.grid?.ties)?.own.grid, 15000, 'the grid');
      ws.close();
      return g;
    };
    const before = await tiesNow();
    assert.equal(before.graphId, 'galaxy');
    // (Bus B for Helm, saved; then the relay and the computer restart.)
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'register', name: 'chief2', ship: 'Graphship', station: 'Engineering' }));
    await wait(500);
    ws.send(JSON.stringify({ type: 'grid', ties: { 'console:Helm': ['B'] } }));
    await until(() => { try { return JSON.parse(fs.readFileSync(navFile, 'utf8')).eng.tiesById['console-helm']?.[0] === 'bus-b'; } catch { return false; } }, 20000, 'Helm on Bus B, saved');
    ws.close();
    await stop(core); await stop(relay);
    relay = run(['server.js']);
    await wait(1500);
    core = run(['tools/shipcore.js', '--relay', `ws://localhost:${PORT}`, '--data', CORES, 'Graphship']);
    await wait(3000); // (its computer back online)
    const after = await tiesNow();
    assert.deepEqual(after.ties['console:Helm'], ['B'], 'the Helm console still on Bus B');
    for (const k of Object.keys(before.ties)) if (k !== 'console:Helm') assert.deepEqual(after.ties[k], before.ties[k], `${k} the same`);
    step('on the graph engine a ship\'s computer saves its ties by system id (console-helm: bus-b), and after the relay and the computer restart they\'re all the same');
    ok = true;
  } catch (err) {
    console.error('FAIL:', err.message);
  } finally {
    for (const p of procs) p.kill();
    await wait(300);
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
  }
})();
