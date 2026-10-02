// The relay's own settings, kept on this machine (data/settings.json, not in git):
// the address it listens on (host, port), how new accounts are let in, and where
// the admin page answers from. PORT and HOST in the environment win over the file.
const fs = require('fs');
const net = require('net');
const path = require('path');

const DIR = process.env.RELAY_DATA || path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'settings.json');
const DEFAULTS = { host: '', port: 8085, registration: 'approval', adminAccess: 'localhost' };
const REGISTRATION = ['open', 'approval', 'closed'];
const ADMIN_ACCESS = ['localhost', 'lan'];
const RESERVED = { 8080: 'kept for coturn' };

const read = () => { try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return { ...DEFAULTS }; } };
// What's in force: the file, under the environment.
function effective() {
  const s = read();
  return { ...s, port: Number(process.env.PORT) || s.port, host: process.env.HOST ?? s.host, overridden: { port: !!process.env.PORT, host: process.env.HOST !== undefined } };
}
// A change checked: null, or { field, message }. (A port is also tried, unless it's the one in use now.)
function check(v) {
  if (v.host !== undefined && v.host !== '' && !net.isIP(v.host)) return { field: 'host', message: 'an IP address (like 0.0.0.0, 192.168.1.20 or ::), or empty for every interface' };
  if (v.port !== undefined && !(Number.isInteger(v.port) && v.port >= 1 && v.port <= 65535)) return { field: 'port', message: 'a port number, 1-65535' };
  if (v.port !== undefined && RESERVED[v.port]) return { field: 'port', message: `port ${v.port} is ${RESERVED[v.port]}` };
  if (v.registration !== undefined && !REGISTRATION.includes(v.registration)) return { field: 'registration', message: `one of ${REGISTRATION.join(', ')}` };
  if (v.adminAccess !== undefined && !ADMIN_ACCESS.includes(v.adminAccess)) return { field: 'adminAccess', message: `one of ${ADMIN_ACCESS.join(', ')}` };
  return null;
}
// Is a port free on this host? (true, or the error's code)
const portFree = (port, host) => new Promise((resolve) => {
  const s = net.createServer().once('error', (e) => resolve(e.code || 'in use')).once('listening', () => s.close(() => resolve(true)));
  s.listen(port, host || undefined);
});
function save(change) {
  const next = { ...read(), ...change };
  fs.mkdirSync(DIR, { recursive: true });
  const keep = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, next[k]]));
  const tmp = path.join(DIR, '.settings.json.tmp'); // (a dotfile: only the rename is a change to the supervisor)
  fs.writeFileSync(tmp, JSON.stringify(keep, null, 2) + '\n');
  fs.renameSync(tmp, FILE);
  return keep;
}
// The address a local program reaches the relay on.
const localUrl = (s = effective()) => `ws://${!s.host || s.host === '0.0.0.0' || s.host === '::' ? 'localhost' : s.host.includes(':') ? `[${s.host}]` : s.host}:${s.port}`;

module.exports = { FILE, DEFAULTS, REGISTRATION, ADMIN_ACCESS, read, effective, check, portFree, save, localUrl };
