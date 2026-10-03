// The database (tools/db.js, docs/database.md), when one is configured (DB_USER, or "database" in
// data/settings.json), always in its test database (DB_TEST_NAME, startrek_test by default; never the
// game's): the schema applies (twice: it's safe to run again), config/ loads, every vessel kind read
// back (each system's type defaults merged with JSON_MERGE_PATCH under the class's changes, its links)
// is the graph the relay builds, and the designs, star charts and system library read back are what
// config/ says. Writes are a transaction a cycle: one that fails, or is cut off, leaves the database as
// it was. Accounts and saves come in from their files once. Skipped without a database.
const assert = require('assert');
process.env.DB_NAME = process.env.DB_TEST_NAME || 'startrek_test';
const DB = require('../tools/db');
const CONFIG = require('../tools/config');

const step = (s) => console.log(`ok - ${s}`);
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
(async () => {
  if (!DB.settings().user) { console.log('# no database configured (DB_USER or data/settings.json "database"): skipped'); console.log('PASS'); return; }
  let ok = false, db;
  try {
    try { db = await DB.connect(); } catch (err) { console.log(`# the test database ${process.env.DB_NAME} can't be reached (${err.message}): skipped`); console.log('PASS'); return; }
    await DB.migrate(db); await DB.migrate(db);
    const [[{ n: other }]] = await db.query("select count(*) n from information_schema.tables where table_schema = database() and table_type = 'BASE TABLE' and engine <> 'InnoDB' and table_name not like 'pt\\_%'"); // (tools/bench.js's scratch tables aside)
    assert.equal(other, 0, 'every table is InnoDB (transactions)');
    await db.query('delete from sessions'); await db.query('delete from users'); await db.query('delete from ships');
    const n = await DB.load(db);
    const res = await DB.check(db);
    assert.deepEqual(res.filter(([, same]) => !same).map(([id]) => id), [], 'every vessel kind the same read back');
    step(`the schema applied (twice), every table InnoDB; ${n} vessel kinds loaded, each read back from the database the same as the relay's graph (${res.map(([id, , k]) => `${id} ${k}`).join(', ')})`);
    const snap = await DB.snapshot(db);
    assert.ok(DB.same(snap.designs, CONFIG.files.ships()), 'the designs read back are config/ships');
    assert.ok(DB.same(snap.charts, CONFIG.files.systems()), 'the star charts read back are config/starsystem');
    assert.ok(DB.same(snap.types, CONFIG.files.types()), 'the system library read back is config/system-types.json');
    assert.deepEqual(snap.differs, []);
    step(`what the game reads from the database is what config/ says: ${Object.keys(snap.designs).length} designs, ${Object.keys(snap.charts).length} star chart, ${Object.keys(snap.types.types).length} system types`);
    // (Layers: a type's defaults, a class's changes; a null-valued setting survives, a "remove" removes.)
    const [[d]] = await db.query("select json_merge_patch('{\"a\":{\"b\":1,\"c\":2},\"d\":3}', '{\"a\":{\"c\":5},\"d\":null}') m");
    assert.deepEqual(J(d.m), { a: { b: 1, c: 5 } });
    const [[sol]] = await db.query("select mk_code from stars where star_name = 'Sol'");
    assert.equal(sol.mk_code, 'G2V');
    step('JSON_MERGE_PATCH merges nested values and removes on null; Sol is G2V');

    // A cycle of writes is one transaction: one that fails part-way changes nothing.
    const save = (x) => ({ kind: 'nav', ship: 'Testship', nav: { x, y: 1, class: 'runabout', game: 'g1' } });
    await DB.applyAll(db, [save(10)]);
    await assert.rejects(DB.applyAll(db, [save(20), { kind: 'users', put: { tester: { salt: 'a'.repeat(32), hash: 'b'.repeat(128), role: 'player', status: 'active', created: 1 } } }, { kind: 'no-such-write' }]));
    assert.equal((await DB.readNav(db, 'Testship')).x, 10, 'a cycle that failed: the save as it was');
    assert.deepEqual(await DB.readUsers(db), {}, 'and the account it made, not made');
    // (Cut off mid-transaction: the connection dies before it commits.)
    const other2 = await DB.connect();
    await other2.query('start transaction');
    await DB.apply(other2, save(30));
    other2.destroy();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await DB.readNav(db, 'Testship')).x, 10, 'a write cut off before it committed: the save as it was');
    const [[row]] = await db.query("select s.x, c.class_code from ships s join classes c on c.class_id = s.ship_class where ship_name = 'Testship'");
    assert.deepEqual([row.x, row.class_code], [10, 'runabout']);
    step('a cycle of writes is one transaction: one failing part-way, or cut off before it commits, leaves the database as it was');

    // The accounts, the starbases and a ship's save come in from their files once; after that, the database's.
    const fs = require('fs'), os = require('os'), path = require('path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-db-'));
    const files = { starbases: path.join(tmp, 'starbases.json'), users: path.join(tmp, 'users.json'), sessions: path.join(tmp, 'sessions.json') };
    fs.writeFileSync(files.starbases, JSON.stringify({ __game: 'g1', 'Starbase 47': { remoteBlock: true, nav: { x: 500, y: 120, heading: 0 } }, 'Sol Subspace Relay': { eng: { core: 'ejected' } } }));
    fs.writeFileSync(files.users, JSON.stringify({ captain: { salt: 'c'.repeat(32), hash: 'd'.repeat(128), role: 'admin', status: 'active', created: 5, lastLogin: 6, characters: ['Kirk'] } }));
    fs.writeFileSync(files.sessions, JSON.stringify({ ['e'.repeat(64)]: { user: 'captain', created: 7, seen: 8 } }));
    const first = await DB.relayState(db, files);
    assert.deepEqual(first.users.captain, { salt: 'c'.repeat(32), hash: 'd'.repeat(128), role: 'admin', status: 'active', created: 5, lastLogin: 6, characters: ['Kirk'] });
    assert.deepEqual(first.sessions, { ['e'.repeat(64)]: { user: 'captain', created: 7, seen: 8 } });
    assert.deepEqual(first.bases, { __game: 'g1', 'Starbase 47': { remoteBlock: true, nav: { x: 500, y: 120, heading: 0 } }, 'Sol Subspace Relay': { eng: { core: 'ejected' } } });
    const [[relayRow]] = await db.query("select c.kind from ships s join classes c on c.class_id = s.ship_class where ship_name = 'Sol Subspace Relay'");
    assert.equal(relayRow.kind, 'relay', 'the subspace relay kept as a relay, the starbases as starbases');
    fs.writeFileSync(files.users, JSON.stringify({ someoneelse: first.users.captain }));
    const again = await DB.relayState(db, files);
    assert.deepEqual(Object.keys(again.users), ['captain'], 'brought in once: after that, the database\'s');
    // (Accounts: only what changed is written; a session goes with its account.)
    await DB.applyAll(db, [{ kind: 'users', put: { captain: { ...first.users.captain, role: 'player' } } }, { kind: 'sessions', put: { ['f'.repeat(64)]: { user: 'captain', created: 9, seen: 9 } } }]);
    assert.equal((await DB.readUsers(db)).captain.role, 'player');
    await DB.applyAll(db, [{ kind: 'users', drop: ['captain'] }]);
    assert.deepEqual(await DB.readSessions(db), {}, 'an account deleted: its sessions with it');
    const navFile = path.join(tmp, 'nav.json');
    fs.writeFileSync(navFile, JSON.stringify({ x: 1, y: 2, class: 'galaxy' }));
    assert.deepEqual(await DB.nav(db, 'Newship', navFile), { nav: { x: 1, y: 2, class: 'galaxy' }, imported: true });
    fs.writeFileSync(navFile, JSON.stringify({ x: 9, y: 9 }));
    assert.deepEqual(await DB.nav(db, 'Newship', navFile), { nav: { x: 1, y: 2, class: 'galaxy' }, imported: false });
    assert.deepEqual(await DB.nav(db, 'Nobody', path.join(tmp, 'none.json')), { nav: null, imported: false });
    fs.rmSync(tmp, { recursive: true, force: true });
    step('the starbases, the accounts and a ship\'s save come in from their files the first time, and from the database after that; an account\'s change written alone, its sessions going with it');
    await db.query('delete from sessions'); await db.query('delete from users'); await db.query('delete from ships');
    ok = true;
  } catch (err) {
    console.error('FAIL:', err.stack || err.message);
  } finally {
    await db?.end();
    console.log(ok ? 'PASS' : 'FAIL');
    process.exitCode = ok ? 0 : 1;
  }
})();
