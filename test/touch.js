// Tablets: long screens, the sidebar and the admin panel scroll with a touch drag.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium, devices } = require('playwright');

const PORT = Number(process.env.PORT || 8099) + 4;
const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-touch-'));
const URL = `http://localhost:${PORT}/`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`ok - ${s}`);
const procs = new Set();
const run = (args) => { const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, PORT, STARBASES_FILE: path.join(DATA, 'starbases.json') }, stdio: 'ignore' }); procs.add(p); p.on('exit', () => procs.delete(p)); return p; };

(async () => {
  let ok = false, browser;
  try {
    run(['server.js']);
    await wait(800);
    run(['tools/shipcore.js', '--relay', `ws://localhost:${PORT}`, '--data', DATA, '--warm', '--position', '500,500', '--class', 'crossfield', 'Tabletship']); // (a Crossfield: the spore drive's row too)
    await wait(2500);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    // A tablet held landscape, short enough that the grid and the sidebar overflow.
    const ctx = await browser.newContext({ ...devices['iPad (gen 7) landscape'], viewport: { width: 1080, height: 560 } });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    // A real touch drag: a finger down at the middle of an element, moving up the screen, lifted.
    const drag = async (sel, dy = -400) => {
      const box = await page.locator(sel).first().boundingBox();
      const x = Math.round(box.x + box.width / 2), y0 = Math.round(box.y + Math.min(box.height - 10, Math.max(10, box.height / 2 - dy / 2)));
      const at = (y) => [{ x, y: Math.max(1, Math.round(y)), id: 1 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(y0) });
      for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(y0 + (dy * i) / 12) }); await wait(16); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await wait(300);
    };
    const scrolled = (sel) => page.$eval(sel, (e) => e.scrollTop);
    await page.goto(URL);
    await page.waitForSelector('#ship option[value="Tabletship"]', { state: 'attached' });
    await page.fill('#name', 'tablet');
    await page.selectOption('#ship', 'Tabletship');
    await page.selectOption('#station', 'Engineering');
    await page.click('#register-form button');
    // The power grid: its panel body scrolls with a drag.
    await page.waitForSelector('#grid-table', { state: 'attached' });
    await page.evaluate(() => document.querySelector('[data-screen-tab="st-grid"]')?.click());
    const gridBody = '[data-screen="st-grid"] .lcars-panel__body';
    await page.waitForSelector(gridBody);
    assert.ok(await page.$eval(gridBody, (e) => e.scrollHeight > e.clientHeight + 100), 'the grid overflows its panel');
    await drag(gridBody);
    await page.waitForFunction((s) => document.querySelector(s).scrollTop > 100, gridBody);
    step(`a touch drag scrolled the power grid (${await scrolled(gridBody)} px)`);
    // Every row of the grid has a name (both orders).
    for (const order of ['startup', 'operations']) {
      await page.evaluate((o) => document.getElementById(`grid-order-${o}`).click(), order);
      await page.waitForTimeout(300);
      const blank = await page.$$eval('#grid-table tbody tr:not(.grid-section):not(.grid-place) > th', (ths) => ths.filter((th) => !th.querySelector('span')?.textContent.trim() && !th.textContent.trim()).map((th) => th.parentElement.id));
      assert.deepEqual(blank, [], `grid rows without a name (${order})`);
    }
    assert.ok(await page.$('#ties-system-spore'), 'the spore drive has its row');
    assert.match(await page.textContent('#ties-system-spore'), /Spore drive/);
    assert.match(await page.textContent('#ties-system-amBus'), /AM bus magnetic containment/);
    step('every grid row on a Crossfield has a name (the AM bus magnetic containment and the spore drive too)');
    // Engineering's Distribution: the EPS schematic (sources, the manifold, places, loads); a tap ties or unties.
    await page.evaluate(() => document.querySelector('[data-screen-tab="st-dist"]').click());
    await page.waitForSelector('[data-distribution] .dist-map .dist-node');
    assert.ok(await page.$('[data-distribution] .dist-node[data-key="place:Main Engineering"]'), 'the EPS: Main Engineering on it');
    await page.click('[data-distribution] button[data-bus="A"]');
    await page.waitForSelector('[data-distribution] .dist-node[data-key="console:Engineering"]');
    const tiedA = () => page.evaluate(() => window.__nav.last.own.grid.ties['console:Helm'].includes('A'));
    const was = await tiedA();
    await page.click('[data-distribution] .dist-node[data-key="console:Helm"]');
    await page.waitForFunction((w) => window.__nav.last.own.grid.ties['console:Helm'].includes('A') !== w, was);
    await page.click('[data-distribution] .dist-node[data-key="console:Helm"]');
    await page.waitForFunction((w) => window.__nav.last.own.grid.ties['console:Helm'].includes('A') === w, was);
    step('Distribution: the EPS schematic (Main Engineering on it); Bus A, where a tap on the Helm console untied it and another tied it back');
    // The sidebar: two columns (ship-wide on the left, this station's screens on the right), each
    // scrolling by itself when it's taller than the screen.
    for (const col of ['.lcars-sidebar__col--right', '.lcars-sidebar__col--left']) {
      if (await page.$eval(col, (e) => e.scrollHeight > e.clientHeight + 20)) {
        await drag(col);
        await page.waitForFunction((c) => document.querySelector(c).scrollTop > 10, col);
        step(`a touch drag scrolled the sidebar's ${col.includes('right') ? 'right (station)' : 'left (ship-wide)'} column`);
      } else step(`the sidebar's ${col.includes('right') ? 'right' : 'left'} column fits (nothing to scroll)`);
    }
    // The left column's panels open beside the station screen (the pane), and close again.
    await page.click('#reassign-tab');
    await page.waitForFunction(() => document.body.dataset.pane === 'reassign' && !document.querySelector('[data-screen="reassign"]').hidden);
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('.lcars-content [data-screen]')].some((s) => !s.hidden && s.getBoundingClientRect().width > 200)), 'the station screen stays beside it');
    await page.click('#reassign-tab');
    await page.waitForFunction(() => !document.body.dataset.pane);
    step('the Station panel slid in beside the station screen, and out again on a second tap');
    // The admin panel: its bottom (Create ship) is reachable by dragging.
    await page.click('#link', { modifiers: ['Shift'] }); // (shift-click the relay's name at the foot)
    await page.waitForSelector('.admin-dialog[open] #admin-create');
    for (let i = 0; i < 6; i++) await drag('.admin-dialog', -500);
    await page.waitForFunction(() => { const d = document.querySelector('.admin-dialog'); return d.scrollTop + d.clientHeight >= d.scrollHeight - 4; });
    assert.ok(await page.locator('#admin-create').isVisible());
    step('touch drags reached the bottom of the admin panel (Create ship)');
    ok = true;
  } catch (err) {
    console.error('FAIL:', err.message);
  } finally {
    await browser?.close();
    await Promise.all([...procs].map((p) => new Promise((r) => { p.once('exit', r); p.kill(); })));
    fs.rmSync(DATA, { recursive: true, force: true });
    console.log(ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
  }
})();
