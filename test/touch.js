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
const run = (args) => { const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, PORT, STARBASES_FILE: path.join(DATA, 'starbases.json'), RELAY_DATA: DATA }, stdio: 'ignore' }); procs.add(p); p.on('exit', () => procs.delete(p)); return p; };

(async () => {
  let ok = false, browser;
  try {
    run(['server.js']);
    await wait(800);
    run(['tools/shipcore.js', '--relay', `ws://localhost:${PORT}`, '--data', DATA, '--warm', '--class', 'crossfield', 'Tabletship']); // (a Crossfield, docked at a starbase: the spore drive's rows, and its Connections)
    run(['tools/shipcore.js', '--relay', `ws://localhost:${PORT}`, '--data', DATA, '--warm', '--class', 'runabout', 'Tundra']); // (a runabout: another vessel's places)
    await wait(2500);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    // A tablet held landscape, short enough that the grid and the sidebar overflow.
    const ctx = await browser.newContext({ ...devices['iPad (gen 7) landscape'], viewport: { width: 1080, height: 560 } });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    // A real touch drag: a finger down at the middle of an element, moving up the screen, lifted.
    const drag = async (sel, dy = -400, pg = page, cd = cdp) => {
      const box = await pg.locator(sel).first().boundingBox();
      const x = Math.round(box.x + box.width / 2), y0 = Math.round(box.y + Math.min(box.height - 10, Math.max(10, box.height / 2 - dy / 2)));
      const at = (y) => [{ x, y: Math.max(1, Math.round(y)), id: 1 }];
      await cd.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(y0) });
      for (let i = 1; i <= 12; i++) { await cd.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(y0 + (dy * i) / 12) }); await wait(16); }
      await cd.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await wait(300);
    };
    const scrolled = (sel) => page.$eval(sel, (e) => e.scrollTop);
    await page.goto(URL);
    await page.waitForSelector('#ship option[value="Tabletship"]', { state: 'attached' });
    await page.fill('#name', 'tablet');
    await page.click('#signin-ships button[data-ship="Tabletship"]');
    await page.click('#signin-unassigned button[data-station="Engineering"]');
    await page.click('#register-go');
    // Another vessel's stations by its own places: the Tundra (a runabout) across the dock, as the
    // transporter's destination, and under remote control, never this Crossfield's decks.
    await page.waitForFunction(() => window.__nav?.last?.own?.grid && ships.some((v) => v.name === 'Tundra' && v.classId === 'runabout'));
    const runabout = await page.evaluate(() => window.DESIGNS.runabout.places.map((pl) => pl.name));
    const across = await page.evaluate(() => {
      lastNav = { ...lastNav, own: { ...lastNav.own, grid: { ...lastNav.own.grid, dockedWith: ['Tundra'] } } };
      fillReassign();
      const box = document.querySelector('#dock-stations [data-vessel="Tundra"]');
      return { places: [...box.querySelectorAll('.place-bar')].map((b) => b.dataset.place), stations: [...box.querySelectorAll('button[data-station]')].map((b) => b.dataset.station) };
    });
    assert.ok(across.places.length && across.places.every((pl) => runabout.includes(pl)), `across the dock: the runabout's places only (${across.places})`);
    assert.ok(!across.stations.includes('Captain') && !across.stations.includes('Brig'), `the runabout's stations only (${across.stations})`);
    const controlled = await page.evaluate(() => { renderVesselBar({ controlling: 'Tundra', vessels: ['Tundra'], home: 'Tabletship' }); const v = window.PLACES.map((pl) => pl.name); renderVesselBar({ vessels: ['Tundra'], home: 'Tabletship' }); return [v, window.PLACES.map((pl) => pl.name)]; });
    assert.deepEqual(controlled[0], runabout, 'remote control: the controlled vessel\'s places');
    assert.ok(controlled[1].includes('Spore Propulsion Laboratory'), 'back home: the Crossfield\'s own');
    await page.evaluate(() => { lastNav = { ...lastNav, own: { ...lastNav.own, grid: { ...lastNav.own.grid, dockedWith: [] } } }; fillReassign(); });
    step(`the Tundra (a runabout): across the dock and under remote control, its own places (${across.places.join(', ')}) and stations (${across.stations.join(', ')}), not the Crossfield's`);
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
    assert.ok(await page.$('#ties-system-sporeGrow'), 'spore cultivation has its row');
    assert.ok(await page.$('#grid-table tr[id^="conn-"]'), 'docked: the starbase connection is listed');
    assert.equal(await page.locator('#grid-table tr[id$="-spores"]').count(), 0, 'no Spores row in Connections: spores are grown aboard');
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
    // Switched off on purpose reads "standby" (dead is for empty): the untied console, and a charged battery not feeding.
    const helmWord = async () => page.textContent('[data-distribution] .dist-node[data-key="console:Helm"]');
    if (was) await page.waitForFunction(() => /standby/.test(document.querySelector('[data-distribution] .dist-node[data-key="console:Helm"]').textContent));
    const battery = await page.evaluate(() => [...document.querySelectorAll('[data-distribution] .dist-node')].map((n) => n.textContent).find((t) => /^battery a/i.test(t)));
    const store = await page.evaluate(() => window.__nav.last.own.grid.stores.A);
    if (store.level > 0 && !store.supplying) assert.match(battery, /standby/, battery);
    const standbySeen = `${was ? await helmWord() : ''} / ${battery}`;
    // Which way things flow: a battery supplying runs out to the bus; charging, in from it.
    const batteryFlow = (store) => page.evaluate((st) => {
      const g = structuredClone(window.__nav.last.own.grid);
      g.stores.A = { ...g.stores.A, ...st };
      renderDistribution(g);
      const line = [...document.querySelectorAll('[data-distribution] path.dist-flow')].find((p) => /Battery A/.test(p.dataset.flow));
      return line ? [line.dataset.flow, line.getAttribute(line.classList.contains('dist-flow--rev') ? 'marker-start' : 'marker-end')] : null;
    }, store);
    assert.deepEqual(await batteryFlow({ level: 60, supplying: 40, charging: 0, breaker: true }), ['Battery A → Bus A', 'url(#dist-arrow)'], 'discharging: battery → bus');
    assert.deepEqual(await batteryFlow({ level: 60, supplying: 0, charging: 12, breaker: true }), ['Bus A → Battery A', 'url(#dist-arrow)'], 'charging: bus → battery');
    assert.equal(await batteryFlow({ level: 60, supplying: 0, charging: 0, breaker: true }), null, 'idle: no flow drawn');
    await page.click('[data-distribution] .dist-node[data-key="console:Helm"]');
    await page.waitForFunction((w) => window.__nav.last.own.grid.ties['console:Helm'].includes('A') === w, was);
    step(`Distribution: the EPS schematic (Main Engineering on it); Bus A, where a tap on the Helm console untied it (standby) and another tied it back; a charged battery not feeding reads standby (${standbySeen}); a battery's line runs battery → bus discharging, bus → battery charging`);
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
    // The Comms pane (beside the station screen, a gutter between it and the sidebar) scrolls with a drag.
    await page.click('#comms-button');
    const commsFrame = '#comms .lcars-modal__frame';
    await page.waitForSelector(commsFrame);
    await page.waitForFunction(() => !document.body.classList.contains('pane-moving')); // (the slide done)
    const gutter = await page.evaluate(() => document.querySelector('#comms .lcars-modal__frame').getBoundingClientRect().left - document.querySelector('.lcars-sidebar').getBoundingClientRect().right);
    assert.ok(gutter >= 6, `a gutter between the sidebar and the Comms pane (${gutter} px)`);
    if (await page.$eval(commsFrame, (e) => e.scrollHeight > e.clientHeight + 20)) {
      await drag(commsFrame, -300);
      await page.waitForFunction((q) => document.querySelector(q).scrollTop > 10, commsFrame);
    }
    await page.click('#comms-close');
    step(`the Comms pane: ${gutter} px from the sidebar, and it scrolls with a touch drag`);
    // A dark room's flashlight (its overlay over everything) doesn't get in the way of a drag.
    await page.evaluate(() => { document.querySelector('[data-screen-tab="st-grid"]').click(); document.querySelector('[data-screen="st-grid"] .lcars-panel__body').scrollTop = 0;
      document.body.dataset.blackout = 'engineering'; document.body.setAttribute('data-flashlight', ''); document.getElementById('darkness').hidden = false; });
    await drag(gridBody);
    await page.waitForFunction((q) => document.querySelector(q).scrollTop > 100, gridBody);
    await page.evaluate(() => { delete document.body.dataset.blackout; document.body.removeAttribute('data-flashlight'); document.getElementById('darkness').hidden = true; });
    step('with the flashlight on, a touch drag still scrolled the power grid');
    // A phone (480 px): no sidebar label broken or clipped; the stacked sidebar and the Comms pane scroll with a drag.
    {
      const phoneCtx = await browser.newContext({ ...devices['Pixel 5'], viewport: { width: 480, height: 560 } });
      const phone = await phoneCtx.newPage(), phoneCdp = await phoneCtx.newCDPSession(phone);
      await phone.goto(URL);
      await phone.fill('#name', 'phone');
      await phone.click('#signin-ships button[data-ship="Tabletship"]');
      await phone.click('#signin-unassigned button[data-station="Engineering"]');
      await phone.click('#register-go');
      await phone.waitForSelector('#sections [data-screen-tab="st-grid"]');
      await phone.waitForTimeout(500);
      const clipped = await phone.evaluate(() => [...document.querySelectorAll('.lcars-sidebar .lcars-nav-button')].filter((b) => b.offsetParent && (b.scrollWidth > b.clientWidth + 1 || getComputedStyle(b).overflowWrap === 'anywhere')).map((b) => b.textContent.trim()));
      assert.deepEqual(clipped, [], 'sidebar labels clipped or broken mid-word at 480 px');
      const side = '.lcars-sidebar';
      if (await phone.$eval(side, (e) => e.scrollHeight > e.clientHeight + 20)) {
        await drag(side, -300, phone, phoneCdp);
        await phone.waitForFunction((q) => document.querySelector(q).scrollTop > 10, side);
      }
      await phone.click('#comms-button');
      await phone.waitForSelector(commsFrame);
      await phone.waitForFunction(() => !document.body.classList.contains('pane-moving'));
      assert.ok(await phone.$eval(commsFrame, (e) => e.scrollHeight > e.clientHeight + 20), 'Comms overflows a short phone');
      if (await phone.$eval(commsFrame, (e) => e.scrollHeight > e.clientHeight + 20)) {
        await drag(commsFrame, -300, phone, phoneCdp);
        await phone.waitForFunction((q) => document.querySelector(q).scrollTop > 10, commsFrame);
      }
      await phoneCtx.close();
    }
    step('a phone at 480 px: every sidebar label whole, and the sidebar and the Comms pane scroll with a touch drag');
    // The admin panel: its bottom (Create ship) is reachable by dragging.
    await page.goto(`${URL}admin`);
    await page.waitForSelector('#admin-create #create-name');
    const fleetBody = '[data-screen="fleet"] .lcars-panel__body';
    if (await page.$eval(fleetBody, (e) => e.scrollHeight > e.clientHeight + 4)) {
      for (let i = 0; i < 6; i++) await drag(fleetBody, -500);
      await page.waitForFunction((s) => { const d = document.querySelector(s); return d.scrollTop + d.clientHeight >= d.scrollHeight - 4; }, fleetBody);
    }
    assert.ok(await page.locator('#admin-create #create-name').isVisible());
    step('touch drags reached the bottom of the admin page\'s Fleet (Create ship)');
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
