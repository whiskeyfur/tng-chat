// The database (tools/db.js, docs/database.md), when one is configured (DB_USER, or "database" in
// data/settings.json): the schema applies (twice: it's safe to run again), the designs and star charts
// load, and every vessel kind read back from the database (each system's type defaults merged with
// JSON_MERGE_PATCH under the class's changes, its links) is the graph the relay builds. Skipped without one.
const assert = require('assert');
const DB = require('../tools/db');

const step = (s) => console.log(`ok - ${s}`);
(async () => {
  if (!DB.settings().user) { console.log('# no database configured (DB_USER or data/settings.json "database"): skipped'); console.log('PASS'); return; }
  let ok = false, db;
  try {
    db = await DB.connect();
    await DB.migrate(db); await DB.migrate(db);
    const n = await DB.load(db);
    const res = await DB.check(db);
    assert.deepEqual(res.filter(([, same]) => !same).map(([id]) => id), [], 'every vessel kind the same read back');
    step(`the schema applied (twice), ${n} vessel kinds loaded, each read back from the database the same as the relay's graph (${res.map(([id, , k]) => `${id} ${k}`).join(', ')})`);
    // (Layers: a type's defaults, a class's changes; a null-valued setting survives, a "remove" removes.)
    const [[d]] = await db.query("select json_merge_patch('{\"a\":{\"b\":1,\"c\":2},\"d\":3}', '{\"a\":{\"c\":5},\"d\":null}') m");
    assert.deepEqual(typeof d.m === 'string' ? JSON.parse(d.m) : d.m, { a: { b: 1, c: 5 } });
    const [[sol]] = await db.query("select mk_code from stars where star_name = 'Sol'");
    assert.equal(sol.mk_code, 'G2V');
    step('JSON_MERGE_PATCH merges nested values and removes on null; Sol is G2V');
    ok = true;
  } catch (err) {
    console.error('FAIL:', err.message);
  } finally {
    await db?.end();
    console.log(ok ? 'PASS' : 'FAIL');
    process.exitCode = ok ? 0 : 1;
  }
})();
