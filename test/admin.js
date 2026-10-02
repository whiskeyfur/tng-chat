// The admin page's ship design editor, under the supervisor (which reloads on a
// config change), on a copy of config/: Galaxy's bus limit changed and saved (a
// backup kept) and the reload applies it; a design that doesn't check out is
// refused with the error beside its field; Galaxy duplicated as a new class,
// which then appears in Create ship.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const PORT = Number(process.env.PORT || 8099) + 6;
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-admin-'));
const CONFIG = path.join(TMP, 'config'), DATA = path.join(TMP, 'data');
fs.cpSync(path.join(ROOT, 'config'), CONFIG, { recursive: true });
fs.mkdirSync(DATA);
const URL = `http://localhost:${PORT}/admin`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`ok - ${s}`);

(async () => {
  let ok = false, browser, sup;
  try {
    sup = spawn(process.execPath, ['tools/supervisor.js'], { cwd: ROOT, stdio: 'ignore',
      env: { ...process.env, PORT, CONFIG_DIR: CONFIG, SHIPCORE_DATA: DATA, STARBASES_FILE: path.join(TMP, 'starbases.json'), SUPERVISE_DELAY: '600', SUPERVISE_WATCH: CONFIG } });
    await wait(2500);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
    const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
    await page.goto(URL);
    await page.waitForFunction(() => window.__admin?.status?.classes?.galaxy, null, { timeout: 15000 });
    const galaxyBus = await page.evaluate(() => window.__admin.status.classes.galaxy.bus);
    await page.click('[data-screen-tab="designs"]');
    await page.click('#design-list button[data-value="galaxy"]');
    await page.waitForSelector('#design-title:has-text("galaxy.json")');
    // Galaxy's low buses: +10, saved; the file has it, the old one is kept; the reload applies it.
    await page.click('#design-bus-up');
    assert.equal(Number(await page.inputValue('#design-bus')), galaxyBus + 1);
    await page.fill('#design-bus', String(galaxyBus + 10));
    await page.dispatchEvent('#design-bus', 'change');
    await page.click('#design-save');
    await page.waitForSelector('#design-status:has-text("saved")');
    assert.equal(JSON.parse(fs.readFileSync(path.join(CONFIG, 'ships', 'galaxy.json'), 'utf8')).bus, galaxyBus + 10);
    assert.ok(fs.readdirSync(path.join(CONFIG, 'ships', '.backup')).some((f) => f.startsWith('galaxy.')), 'a backup kept');
    await page.waitForFunction((b) => window.__admin?.status?.classes?.galaxy?.bus === b, galaxyBus + 10, { timeout: 30000 });
    step(`the editor: Galaxy's low buses ${galaxyBus} → ${galaxyBus + 10}, saved (the old file in .backup), and the relay reloaded with it`);
    // A design that doesn't check out: refused, the error beside its field.
    await page.click('[data-screen-tab="designs"]');
    await page.click('#design-list button[data-value="galaxy"]');
    await page.fill('#design-name', '');
    await page.dispatchEvent('#design-name', 'change');
    await page.click('#design-save');
    await page.waitForSelector('[data-field="name"] .design-error');
    assert.equal(JSON.parse(fs.readFileSync(path.join(CONFIG, 'ships', 'galaxy.json'), 'utf8')).name, 'Galaxy', 'not saved');
    step('a design without a name was refused, the error beside its field, the file untouched');
    // Galaxy duplicated as a new class: a new file, and it's in Create ship.
    await page.click('#design-revert');
    await page.fill('#design-new-id', 'akira');
    await page.click('#design-duplicate');
    await page.fill('#design-name', 'Akira');
    await page.dispatchEvent('#design-name', 'change');
    await page.click('#design-save');
    await page.waitForSelector('#design-status:has-text("saved")');
    assert.ok(fs.existsSync(path.join(CONFIG, 'ships', 'akira.json')));
    await page.waitForFunction(() => window.__admin?.status?.classes?.akira, null, { timeout: 30000 });
    await page.click('[data-screen-tab="fleet"]');
    await page.waitForSelector('#create-class button[data-value="akira"]', { timeout: 15000 });
    step('Galaxy duplicated as the Akira class: config/ships/akira.json, and it\'s in Create ship');
    ok = true;
  } catch (err) {
    console.error('FAIL:', err.message);
  } finally {
    await browser?.close();
    if (sup) await new Promise((r) => { sup.once('exit', r); sup.kill(); });
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
  }
})();
