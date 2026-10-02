// Accounts: a username and password (not a character's name). Before any account the relay
// is open; the first registered is the admin, and from then on the pages, the console
// connection and the admin page need a login. Registration by admin approval; a login
// lockout; a player kept out of the admin page; the last admin kept; logging out; the
// Settings (8080 and bad addresses refused; a new port used after a restart).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { chromium } = require('playwright');

const PORT = Number(process.env.PORT || 8099) + 7, PORT2 = PORT + 1;
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-accounts-'));
const URL = `http://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`ok - ${s}`);
const procs = new Set();
const relay = (env) => { const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...env, STARBASES_FILE: path.join(TMP, 'starbases.json'), RELAY_DATA: TMP }, stdio: process.env.DEBUG ? 'inherit' : 'ignore' }); procs.add(p); p.on('exit', () => procs.delete(p)); return p; };
const stop = (p) => new Promise((r) => { if (!p || p.exitCode !== null) return r(); p.once('exit', r); p.kill(); });
// The account API, as a browser would call it (the session cookie kept by hand).
const api = async (what, body, cookie, base = URL) => {
  const r = await fetch(`${base}/api/account/${what}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const set = r.headers.get('set-cookie');
  return { status: r.status, cookie: set ? set.split(';')[0] : null, setCookie: set, ...(await r.json().catch(() => ({}))) };
};
// A console connection (with a cookie, or none): its first messages, and how it closed.
const socket = (cookie) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://localhost:${PORT}`, { headers: cookie ? { Cookie: cookie } : {} });
  const msgs = [];
  ws.on('message', (m) => { try { msgs.push(JSON.parse(m)); } catch {} });
  ws.on('open', () => resolve({ ws, msgs, closed: new Promise((r) => ws.on('close', (code) => r(code))) }));
});
const waitFor = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await wait(100); } throw new Error('timed out waiting'); };

(async () => {
  let ok = false, browser, r1;
  const env = { ...process.env, PORT: String(PORT) };
  delete env.HOST;
  try {
    r1 = relay(env);
    await waitFor(async () => { try { return (await api('me')).status === 200; } catch { return false; } });
    // No accounts: open, as before (a console connection gets its hello).
    assert.equal((await api('me')).accounts, false);
    const open = await socket();
    await waitFor(() => open.msgs.some((m) => m.type === 'hello'));
    assert.equal(open.msgs.find((m) => m.type === 'hello').accounts, false);
    open.ws.close();
    step('no accounts yet: the relay is open, as before');

    // The first account, registered on the log-in page: the admin, logged in, on to the consoles.
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
    const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
    await page.goto(`${URL}/login.html`);
    await page.waitForSelector('#login-first:not([hidden])');
    await page.waitForSelector('#login-mode-register[aria-pressed="true"]');
    await page.fill('#login-username', 'JLPicard');
    await page.fill('#login-password', 'engage1');
    await page.fill('#login-confirm', 'engage1');
    await page.click('#login-go');
    await page.waitForURL(`${URL}/`);
    await page.waitForSelector('#account-menu:not([hidden]):has-text("jlpicard")');
    await page.waitForSelector('#signin-account:has-text("Logged in as jlpicard (admin)")');
    // The character is still a name of its own: riker, at a starbase.
    await page.fill('#name', 'riker');
    await page.click('#signin-ships button[data-ship="Starbase 47"]');
    await page.click('#signin-unassigned button[data-station="Crew"]');
    await page.click('#register-go');
    await page.waitForFunction(() => window.__voice?.me?.name === 'riker');
    step('the first account (JLPicard → jlpicard), registered on the log-in page: the admin, logged in; its character is riker, a name of its own');

    // Now logins are needed: the consoles' page, and a console connection without a session.
    const anon = await fetch(`${URL}/`, { redirect: 'manual' });
    assert.equal(anon.status, 302);
    assert.match(anon.headers.get('location'), /login\.html/);
    const noSession = await socket();
    noSession.ws.send(JSON.stringify({ type: 'register', name: 'q', ship: 'Starbase 47', station: 'Crew' }));
    assert.equal(await noSession.closed, 4401, 'refused without a session');
    assert.ok(noSession.msgs.some((m) => m.type === 'auth-required') && !noSession.msgs.some((m) => m.type === 'hello'));
    step('with an account, the consoles\' page redirects to the log-in page, and a console connection without a session is refused (4401)');

    // Registration needs an admin's approval (the default): pending until approved in Users.
    const pend = await api('register', { username: 'wcrusher', password: 'warp9!!', confirm: 'warp9!!' });
    assert.equal(pend.pending, true);
    assert.match((await api('login', { username: 'wcrusher', password: 'warp9!!' })).error, /awaiting approval/);
    const admin = await (await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 1300, height: 900 } })).newPage();
    await admin.goto(`${URL}/admin`);
    await admin.click('[data-screen-tab="users"]');
    await admin.waitForSelector('#user-table tr[data-user="wcrusher"][data-status="pending"]');
    await admin.click('#user-approve-wcrusher');
    await admin.waitForSelector('#user-table tr[data-user="wcrusher"][data-status="active"]');
    assert.ok((await api('login', { username: 'wcrusher', password: 'warp9!!' })).cookie, 'approved: logs in');
    assert.match(await admin.textContent('#user-table tr[data-user="jlpicard"]'), /admin.*riker/s);
    step('wcrusher registered and waited for approval; the admin approved it in Users (where jlpicard shows its character, riker)');

    // A login lockout: 5 wrong passwords, then even the right one waits.
    for (let i = 0; i < 5; i++) assert.equal((await api('login', { username: 'wcrusher', password: 'nope' })).status, 401);
    const locked = await api('login', { username: 'wcrusher', password: 'warp9!!' });
    assert.equal(locked.status, 429);
    assert.match(locked.error, /too many wrong passwords/);
    step(`five wrong passwords locked wcrusher out ("${locked.error}")`);

    // A player can't reach the admin page, nor make admin requests.
    await admin.fill('#user-new-name', 'dtroi');
    await admin.fill('#user-new-password', 'empath');
    await admin.click('#user-add');
    await admin.waitForSelector('#user-table tr[data-user="dtroi"][data-status="active"]');
    const troi = await api('login', { username: 'dtroi', password: 'empath' });
    const adminAsPlayer = await fetch(`${URL}/admin`, { headers: { Cookie: troi.cookie }, redirect: 'manual' });
    assert.equal(adminAsPlayer.status, 302);
    assert.match(adminAsPlayer.headers.get('location'), /login\.html\?next=%2Fadmin&admin=1/);
    const troiWs = await socket(troi.cookie);
    await waitFor(() => troiWs.msgs.some((m) => m.type === 'hello'));
    troiWs.ws.send(JSON.stringify({ type: 'admin', action: 'users' }));
    await waitFor(() => troiWs.msgs.some((m) => m.type === 'admin-status'));
    assert.match(troiWs.msgs.find((m) => m.type === 'admin-status').error, /needs an admin login/);
    troiWs.ws.close();
    step('dtroi, added by the admin as a player: her console connects, but /admin and the admin requests refuse her');

    // The last admin can't be made a player, disabled or deleted.
    await admin.click('#user-demote-jlpicard');
    await admin.waitForSelector('#users-status:has-text("last admin")');
    page.once('dialog', () => {});
    admin.once('dialog', (d) => d.accept());
    await admin.click('#user-delete-jlpicard');
    await admin.waitForSelector('#users-status:has-text("last admin")');
    assert.equal((await api('me', null, troi.cookie)).user.role, 'player');
    step('the last admin can\'t be demoted or deleted');

    // A new password, shown once: the old sessions end; the new one logs in.
    admin.once('dialog', (d) => d.accept());
    await admin.click('#user-reset-password-dtroi');
    const temp = (await admin.textContent('#user-temp')).match(/dtroi: (\S+)/)[1];
    assert.equal((await api('me', null, troi.cookie)).user, null, 'her old session ended');
    assert.ok((await api('login', { username: 'dtroi', password: temp })).cookie);
    step('a new password for dtroi, shown once: her session ended, and it logs her in');

    // Logging out: from the header's account menu, back to the log-in page; then in again.
    await page.click('#account-menu');
    await page.waitForURL(/login\.html/);
    await page.goto(`${URL}/`);
    await page.waitForURL(/login\.html/);
    await page.waitForSelector('#login-mode-login[aria-pressed="true"]');
    await page.fill('#login-username', 'jlpicard');
    await page.fill('#login-password', 'engage1');
    await page.click('#login-go');
    await page.waitForURL(`${URL}/`);
    await page.waitForSelector('#account-menu:has-text("jlpicard")');
    step('jlpicard logged out (the account menu) to the log-in page, and logged back in');

    // (That was the admin page's session too: it went to the log-in page. Back, as the new session.)
    await admin.waitForURL(/login\.html/);
    const settings = await page.context().newPage();
    await settings.goto(`${URL}/admin`);
    // Settings: 8080 and a bad address refused; a new port saved, used once the relay restarts.
    await settings.click('[data-screen-tab="settings"]');
    await settings.waitForSelector('#settings-port');
    await settings.fill('#settings-port', '8080'); await settings.dispatchEvent('#settings-port', 'change');
    await settings.click('#settings-save');
    await settings.waitForSelector('#settings-status:has-text("coturn")');
    await settings.fill('#settings-port', String(PORT)); await settings.dispatchEvent('#settings-port', 'change');
    await settings.fill('#settings-host', '999.1.2.3'); await settings.dispatchEvent('#settings-host', 'change');
    await settings.click('#settings-save');
    await settings.waitForSelector('#settings-status:has-text("IP address")');
    await settings.fill('#settings-host', ''); await settings.dispatchEvent('#settings-host', 'change');
    await settings.fill('#settings-port', String(PORT2)); await settings.dispatchEvent('#settings-port', 'change');
    await settings.click('#settings-registration-open');
    await settings.click('#settings-save');
    await settings.waitForSelector('#settings-moving', { timeout: 8000 }).catch(async () => { throw new Error(`not moving: ${await settings.textContent('#admin-settings')}`); });
    assert.match(await settings.textContent('#settings-moving'), new RegExp(`:${PORT2}/admin`));
    const saved = JSON.parse(fs.readFileSync(path.join(TMP, 'settings.json'), 'utf8'));
    assert.deepEqual([saved.port, saved.registration], [PORT2, 'open']);
    await stop(r1);
    const env2 = { ...env }; delete env2.PORT;
    r1 = relay(env2);
    await waitFor(async () => { try { return (await api('me', null, null, `http://localhost:${PORT2}`)).status === 200; } catch { return false; } });
    assert.equal((await api('me', null, null, `http://localhost:${PORT2}`)).registration, 'open');
    step(`Settings: port 8080 (coturn) and 999.1.2.3 refused; port ${PORT2} and open registration saved, and the restarted relay listens there`);
    ok = true;
  } catch (err) {
    console.error('FAIL:', err.message);
  } finally {
    await browser?.close();
    await Promise.all([...procs].map(stop));
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
  }
})();
