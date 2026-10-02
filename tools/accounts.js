// Accounts: a username and password (not a character's name), a role (admin or
// player) and a status (active, pending approval, disabled), in data/users.json;
// sessions (a random token a browser keeps in a cookie) in data/sessions.json.
// Passwords are scrypt hashes with a salt each; tokens are kept only as their
// SHA-256. Nothing here logs a password or a token.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.RELAY_DATA || path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DIR, 'users.json');
const SESSIONS_FILE = path.join(DIR, 'sessions.json');
const IDLE_MS = 30 * 24 * 3600 * 1000; // a session ends after 30 days unused
const LOCKOUT = { fails: 5, ms: 60 * 1000 }; // 5 wrong passwords: 60 s before the next try
const USER_RE = /^[a-z0-9._-]{3,24}$/;

const read = (file, empty) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return empty; } };
// (Written as a dotfile, then renamed: the supervisor's watch ignores dotfiles, and these files, so
// a login never restarts the relay.)
const tmpOf = (file) => path.join(path.dirname(file), `.${path.basename(file)}.tmp`);
const write = (file, v) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(tmpOf(file), JSON.stringify(v, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmpOf(file), file); };
let users = read(USERS_FILE, {});      // username -> { salt, hash, role, status, created, lastLogin, characters }
let sessions = read(SESSIONS_FILE, {}); // sha256(token) -> { user, created, seen }
// (The users file changed under us, npm run make-admin from the shell: read it again.)
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
let usersAt = mtime(USERS_FILE);
const fresh = () => { const t = mtime(USERS_FILE); if (t !== usersAt) { usersAt = t; users = read(USERS_FILE, {}); } };
const saveUsers = () => { write(USERS_FILE, users); usersAt = mtime(USERS_FILE); };
const saveSessions = () => write(SESSIONS_FILE, sessions);
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const hashOf = (password, salt) => crypto.scryptSync(String(password), salt, 64).toString('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

const norm = (u) => String(u || '').trim().toLowerCase();
const any = () => { fresh(); return Object.keys(users).length > 0; };
const admins = () => Object.entries(users).filter(([, u]) => u.role === 'admin' && u.status === 'active').map(([n]) => n);
const pub = (name) => { const u = users[name]; return u && { username: name, role: u.role, status: u.status, created: u.created, lastLogin: u.lastLogin || null, characters: u.characters || [] }; };
const checkName = (name) => (USER_RE.test(name) ? null : 'a username is 3-24 letters, digits, . _ or -');
const checkPassword = (p) => (typeof p === 'string' && p.length >= 6 ? null : 'a password is at least 6 characters');

// A new account. The first one is an active admin; after that the registration mode decides:
// open (active), approval (pending until an admin approves) or closed (refused).
function register(username, password, mode = 'approval', { byAdmin = false, role } = {}) {
  fresh();
  const name = norm(username);
  const bad = checkName(name) || checkPassword(password);
  if (bad) return { error: bad };
  if (users[name]) return { error: 'that username is taken' };
  const first = !any();
  if (!first && !byAdmin && mode === 'closed') return { error: 'registration is closed: ask an admin' };
  const salt = crypto.randomBytes(16).toString('hex');
  users[name] = { salt, hash: hashOf(password, salt), role: first ? 'admin' : role === 'admin' ? 'admin' : 'player', status: first || byAdmin || mode === 'open' ? 'active' : 'pending', created: Date.now(), characters: [] };
  saveUsers();
  return { user: pub(name) };
}

// Wrong passwords, by username from an address: 5 and it's locked for a minute.
const fails = new Map(); // "user@address" -> { n, until }
const lockedFor = (key) => { const f = fails.get(key); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; };
function failed(key) {
  const f = fails.get(key) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= LOCKOUT.fails) { f.until = Date.now() + LOCKOUT.ms; f.n = 0; }
  fails.set(key, f);
}
// Log in: a session token (to set as the cookie), or why not.
function login(username, password, addr = '') {
  fresh();
  const name = norm(username), key = `${name}@${addr}`;
  const wait = lockedFor(key);
  if (wait) return { error: `too many wrong passwords: try again in ${wait} s` };
  const u = users[name];
  if (!u || !same(hashOf(password, u.salt), u.hash)) { failed(key); return { error: 'wrong username or password' }; }
  fails.delete(key);
  if (u.status === 'pending') return { error: 'your account is awaiting approval by an admin' };
  if (u.status === 'disabled') return { error: 'this account is disabled' };
  const token = crypto.randomBytes(32).toString('hex');
  sessions[sha(token)] = { user: name, created: Date.now(), seen: Date.now() };
  u.lastLogin = Date.now();
  saveUsers(); saveSessions();
  return { token, user: pub(name) };
}
// The account a token belongs to (and still active), or null; a session unused for 30 days is gone.
let seenDirty = false;
function session(token) {
  fresh();
  if (!token) return null;
  const s = sessions[sha(token)];
  if (!s) return null;
  const u = users[s.user];
  if (!u || u.status !== 'active' || Date.now() - s.seen > IDLE_MS) { delete sessions[sha(token)]; saveSessions(); return null; }
  if (Date.now() - s.seen > 60 * 1000) { s.seen = Date.now(); seenDirty = true; }
  return pub(s.user);
}
setInterval(() => { if (seenDirty) { seenDirty = false; saveSessions(); } }, 30 * 1000).unref();
function logout(token) { if (token && sessions[sha(token)]) { delete sessions[sha(token)]; saveSessions(); } }
// Every session of an account ended (force logout, disabled, deleted, password reset).
function endSessions(name) { let n = 0; for (const [k, s] of Object.entries(sessions)) if (s.user === name) { delete sessions[k]; n++; } if (n) saveSessions(); return n; }

// A character signed in with this account ("last used by").
function usedCharacter(name, character) {
  const u = users[norm(name)];
  if (!u) return;
  u.characters = [character, ...(u.characters || []).filter((c) => c.toLowerCase() !== character.toLowerCase())].slice(0, 10);
  saveUsers();
}

// The user manager (admins): every account; change one. Refuses to leave no active admin.
const list = () => { fresh(); return Object.keys(users).sort().map(pub); };
function update(name, change) {
  fresh();
  name = norm(name);
  const u = users[name];
  if (!u) return { error: 'no such account' };
  const lastAdmin = u.role === 'admin' && u.status === 'active' && admins().length <= 1;
  switch (change.action) {
    case 'approve': if (u.status !== 'pending') return { error: 'not awaiting approval' }; u.status = 'active'; break;
    case 'reject': if (u.status !== 'pending') return { error: 'not awaiting approval' }; delete users[name]; break;
    case 'promote': u.role = 'admin'; break;
    case 'demote': if (lastAdmin) return { error: 'that is the last admin: promote someone else first' }; u.role = 'player'; break;
    case 'disable': if (lastAdmin) return { error: 'that is the last admin: it can\'t be disabled' }; u.status = 'disabled'; endSessions(name); break;
    case 'enable': u.status = 'active'; break;
    case 'delete': if (lastAdmin) return { error: 'that is the last admin: it can\'t be deleted' }; delete users[name]; endSessions(name); break;
    case 'logout': return { ended: endSessions(name) };
    case 'reset-password': {
      // A temporary password, shown to the admin once (not stored anywhere but as its hash).
      const temp = crypto.randomBytes(6).toString('base64').replace(/[+/=]/g, '').slice(0, 10);
      u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashOf(temp, u.salt);
      endSessions(name); saveUsers();
      return { temp };
    }
    default: return { error: 'unknown action' };
  }
  saveUsers();
  return {};
}
// npm run make-admin <user>
function makeAdmin(name) { name = norm(name); if (!users[name]) return false; users[name].role = 'admin'; users[name].status = 'active'; saveUsers(); return true; }
const reload = () => { users = read(USERS_FILE, {}); sessions = read(SESSIONS_FILE, {}); };

module.exports = { DIR, USERS_FILE, SESSIONS_FILE, any, register, login, session, logout, endSessions, usedCharacter, list, update, makeAdmin, reload, norm };
