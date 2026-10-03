// The game on the database (tools/store.js), in the test database (DB_TEST_NAME, startrek_test by
// default; never the game's): a ship's computer brings its save in from its .nav.json the first time,
// the relay reads the designs and the star chart from the database and keeps the starbases and the
// accounts there, and after both restart the ship is where it was, the account and its session still
// good, and the files untouched. A database that can't be reached is said, and waited for. Skipped
// without a database.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');
process.env.DB_NAME = process.env.DB_TEST_NAME || 'startrek_test';
const DB = require('../tools/db');
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

const PORT = Number(process.env.PORT || 8099) + 13;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-dbgame-'));
const ROOT = path.join(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`ok - ${s}`);
const procs = new Set();
// (The relay and the computer find the database in their settings.json, as the game does.)
const childEnv = { ...process.env, PORT, RELAY_DATA: DATA, STARBASES_FILE: path.join(DATA, 'starbases.json') };
for (const k of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'DB_TEST_NAME']) delete childEnv[k];
const out = [];
const run = (args) => { const p = spawn(process.execPath, args, { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }); for (const s of [p.stdout, p.stderr]) s.on('data', (b) => out.push(b.toString())); procs.add(p); p.on('exit', () => procs.delete(p)); return p; };
const stop = (p) => new Promise((r) => { if (p.exitCode !== null) return r(); p.once('exit', r); p.kill(); });
const relay = () => run(['server.js']);
const computer = () => run(['tools/shipcore.js', '--relay', `ws://localhost:${PORT}`, '--data', DATA, 'Dbship']);
const waitFor = async (fn, what, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(150); } throw new Error(`timed out: ${what}`); };

async function look(cookie) {
  const ws = new WebSocket(`ws://localhost:${PORT}`, cookie ? { headers: { Cookie: cookie } } : {});
  const msgs = [];
  ws.on('message', (m) => msgs.push(JSON.parse(m)));
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.send(JSON.stringify({ type: 'register', name: `eng${Date.now() % 100000}`, ship: 'Dbship', station: 'Engineering' }));
  try { return await waitFor(() => [...msgs].reverse().find((m) => m.type === 'nav' && m.own?.grid)?.own, 'the ship\'s grid', 10000); } catch (err) { throw new Error(`${err.message} (the console had: ${[...new Set(msgs.map((m) => m.type + (m.reason ? `: ${m.reason}` : '')))].join(', ')})`); } finally { ws.close(); }
}
const account = async (what, body, cookie) => {
  const r = await fetch(`http://localhost:${PORT}/api/account/${what}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};

(async () => {
  const conf = DB.settings();
  if (!conf.user) { console.log('# no database configured (DB_USER or data/settings.json "database"): skipped'); console.log('PASS'); return; }
  let db;
  try { db = await DB.connect(); } catch (err) { console.log(`# the test database ${conf.database} can't be reached (${err.message}): skipped`); console.log('PASS'); return; }
  let ok = false;
  try {
    await DB.migrate(db);
    await db.query('delete from sessions'); await db.query('delete from users'); await db.query('delete from ships');
    fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ port: PORT, registration: 'open', database: { host: conf.host, port: conf.port, user: conf.user, password: conf.password, database: conf.database } }));
    // A ship saved in its file, docked at Starbase 47.
    const save = { x: 498.5, y: 117.5, heading: 0, warp: 0, dest: null, class: 'runabout', combat: { hull: 100, shield: 100, damage: {}, torpedoes: 10 }, eng: { core: 'online', antimatter: 900, deuterium: 1800, docked: 'Starbase 47' } };
    fs.mkdirSync(path.join(DATA, 'Dbship'), { recursive: true });
    const navFile = path.join(DATA, 'Dbship', '.nav.json'), text = JSON.stringify(save);
    fs.writeFileSync(navFile, text);

    let r = relay(); await wait(1200);
    let c = computer();
    await waitFor(() => out.join('').includes('Dbship: flying the ship'), 'the ship\'s computer online');
    const g = await look();
    assert.equal(g.grid.docked, 'Starbase 47');
    assert.ok(out.join('').includes('the game is read from'), 'the relay says where the game comes from');
    assert.ok(out.join('').includes('its save brought in to the database'), 'the computer says it brought the save in');
    const row = await waitFor(async () => { const [[x]] = await db.query("select s.state, c.class_code from ships s join classes c on c.class_id = s.ship_class where ship_name = 'Dbship'"); return x && J(x.state).eng?.stores && x; }, 'the ship\'s save, as the relay has it, in the database');
    assert.equal(row.class_code, 'runabout');
    await waitFor(async () => { const [[x]] = await db.query("select count(*) n from ships s join classes c on c.class_id = s.ship_class where c.kind = 'starbase'"); return x.n >= 5; }, 'the starbases kept in the database');
    step('the relay reads the game from the database; the ship\'s computer brought its save in from its file, and saves it there (its class, its grid); the starbases are kept there');

    // An account (the first: an admin), logged in.
    const reg = await account('register', { username: 'dbtester', password: 'secret123' });
    assert.equal(reg.status, 200);
    assert.ok(reg.cookie.startsWith('tng_session=') || reg.cookie.includes('='), 'a session cookie');
    await waitFor(async () => { const [[x]] = await db.query("select count(*) n from sessions s join users u using (username) where u.username = 'dbtester' and u.role = 'admin'"); return x.n === 1; }, 'the account and its session in the database');
    step('a new account and its session are kept in the database');

    // Both restart: the ship where it was, the account and its session still good.
    await stop(c); await stop(r);
    const [[before]] = await db.query("select state from ships where ship_name = 'Dbship'");
    out.length = 0;
    r = relay(); await wait(1200);
    c = computer();
    await waitFor(() => out.join('').includes('Dbship: flying the ship'), 'the ship\'s computer online again');
    const me = await (await fetch(`http://localhost:${PORT}/api/account/me`, { headers: { Cookie: reg.cookie } })).json();
    assert.equal(me.user?.username, 'dbtester', 'the session still good after the restart');
    const g2 = await look(reg.cookie);
    assert.equal(g2.grid.docked, 'Starbase 47', 'still docked');
    assert.ok(!out.join('').includes('brought in'), 'nothing brought in again');
    assert.equal(fs.readFileSync(navFile, 'utf8'), text, 'the ship\'s file untouched');
    assert.ok(!fs.existsSync(path.join(DATA, 'users.json')) && !fs.existsSync(path.join(DATA, 'starbases.json')), 'no accounts or starbases file written');
    assert.ok(J(before.state).eng.stores, 'its save kept through the restart');
    const login = await account('login', { username: 'dbtester', password: 'secret123' });
    assert.equal(login.status, 200, 'its password still good');
    step('after the relay and the computer restart: the ship is where it was (read from the database, nothing brought in again), the account\'s session and password still good, the files untouched');
    await stop(c); await stop(r);

    // A database that can't be reached: said, and waited for (no quiet fall back to the files).
    fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ port: PORT, database: { host: '127.0.0.1', port: 1, user: 'nobody', password: 'x', database: 'none' } }));
    out.length = 0;
    r = relay();
    await waitFor(() => out.join('').includes("can't be reached"), 'the relay saying it can\'t reach the database', 10000);
    await wait(500);
    assert.equal(r.exitCode, null, 'the relay waits for it');
    assert.ok(!(await fetch(`http://localhost:${PORT}/`).then(() => true, () => false)), 'not serving the game from the files meanwhile');
    step('a database that can\'t be reached: the relay says so and waits for it, rather than playing from the files');
    ok = true;
  } catch (err) {
    console.error('FAIL:', err.stack || err.message);
    console.error(out.join('').slice(-3000));
  } finally {
    for (const p of procs) p.kill('SIGKILL');
    await db.query('delete from sessions').catch(() => {}); await db.query('delete from users').catch(() => {}); await db.query('delete from ships').catch(() => {});
    await db.end();
    fs.rmSync(DATA, { recursive: true, force: true });
    console.log(ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
  }
})();
