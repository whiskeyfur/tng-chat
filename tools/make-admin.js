#!/usr/bin/env node
// npm run make-admin <username>: make an account an (active) admin, from this machine's shell
// (when accounts exist but none is an admin). The relay picks it up when it restarts.
const accounts = require('./accounts');
const name = process.argv[2];
if (!name) { console.error('usage: npm run make-admin <username>'); process.exit(2); }
if (!accounts.makeAdmin(name)) { console.error(`no account "${accounts.norm(name)}" in ${require('./store').enabled() ? 'the database' : accounts.USERS_FILE}`); process.exit(1); }
// (With a database, written there now.)
if (!require('./store').flushSync()) process.exit(1);
console.log(`${accounts.norm(name)} is an admin now (restart the relay, or let the supervisor, to apply it)`);
process.exit(0);
