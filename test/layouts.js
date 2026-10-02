// The LCARS layout designer (/designer), on a copy of config/: parts dragged on from the palette
// (an elbow, a bar, labels, a panel stack), a label dropped into the elbow and another into the
// stack, the elbow moved (its label with it) and closed, the bar resized, undo and redo; saved as
// config/layouts/<name>.json, the page reloaded and the layout opened again just as it was; the
// sample layouts open and draw.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const PORT = Number(process.env.PORT || 8099) + 11;
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-layouts-'));
const CONFIG = path.join(TMP, 'config'), DATA = path.join(TMP, 'data');
fs.cpSync(path.join(ROOT, 'config'), CONFIG, { recursive: true });
fs.mkdirSync(DATA);
const URL = `http://localhost:${PORT}/designer`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`ok - ${s}`);

(async () => {
  let ok = false, browser, relay;
  try {
    relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT, CONFIG_DIR: CONFIG, RELAY_DATA: DATA, SHIPCORE_DATA: DATA, STARBASES_FILE: path.join(DATA, 'starbases.json') } });
    await wait(1200);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
    const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(URL);
    await page.waitForSelector('#lyt-palette button[data-add="elbow"]');
    await page.waitForFunction(() => window.__designer && document.querySelector('#lyt-canvas .lyt-stage'));
    const layout = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__designer.layout)));
    // A canvas cell's place on the screen.
    const cell = (x, y) => page.evaluate(([x, y]) => { const r = document.getElementById('lyt-canvas').getBoundingClientRect(), s = Number(document.querySelector('#lyt-canvas .lyt-stage').dataset.scale); return { x: r.left + x * 8 * s, y: r.top + y * 8 * s }; }, [x, y]);
    const drag = async (from, to) => {
      await page.mouse.move(from.x, from.y); await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
      await page.mouse.up();
    };
    const center = async (sel) => { const b = await page.locator(sel).first().boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
    const dragPart = async (kind, x, y) => (await page.locator(`#lyt-palette button[data-add="${kind}"]`).scrollIntoViewIfNeeded(), drag(await center(`#lyt-palette button[data-add="${kind}"]`), await cell(x, y)));

    // Parts dragged on: an elbow, a bar, a label, a panel stack.
    await dragPart('elbow', 30, 20);
    await dragPart('hbar', 100, 8);
    await dragPart('text', 100, 60);
    await dragPart('stack', 140, 50);
    let v = await layout();
    assert.deepEqual(v.items.map((i) => i.type), ['elbow', 'hbar', 'text', 'stack'], `the four parts on the canvas: ${v.items.map((i) => i.type)}`);
    const elbow = v.items[0];
    assert.deepEqual([elbow.x, elbow.y], [10, 8], 'the elbow centred where it was dropped, on the grid');
    step('an elbow, a bar, a label and a panel stack dragged on from the palette, on the grid');

    // The label dragged into the elbow (its body); another dropped straight into the stack.
    const label = v.items[2];
    await drag(await center(`#lyt-canvas [data-id="${label.id}"]`), await cell(elbow.x + 26, elbow.y + 12));
    await dragPart('text', 140, 40);
    v = await layout();
    const e2 = v.items.find((i) => i.type === 'elbow'), s2 = v.items.find((i) => i.type === 'stack');
    assert.equal(v.items.length, 3, 'two on the canvas less one: the label is in the elbow');
    assert.deepEqual(e2.children.map((c) => [c.type, c.region]), [['text', 'body']], 'the label is in the elbow\'s body');
    assert.deepEqual(s2.children.map((c) => c.type), ['text'], 'a label in the stack');
    assert.equal(await page.locator(`#lyt-canvas [data-id="${e2.id}"] [data-id="${label.id}"]`).count(), 1, 'drawn inside the elbow');
    step('a label dragged into the elbow\'s body, another dropped into the panel stack');

    // The elbow moved: its label moves with it. Closed (a C: everything shown).
    const before = await page.locator(`[data-id="${label.id}"]`).boundingBox();
    await drag(await cell(e2.x + 2, e2.y + 12), await cell(e2.x + 12, e2.y + 17));
    v = await layout();
    const e3 = v.items.find((i) => i.type === 'elbow');
    assert.deepEqual([e3.x - e2.x, e3.y - e2.y], [10, 5], 'the elbow moved 10, 5 cells');
    const after = await page.locator(`[data-id="${label.id}"]`).boundingBox();
    assert.ok(after.x > before.x + 20 && after.y > before.y + 10, 'its label went with it');
    await page.click(`#lyt-prop-end button[data-value="closed"]`);
    assert.equal((await layout()).items.find((i) => i.type === 'elbow').end, 'closed');
    step('the elbow moved, its label with it, and set closed (a C)');

    // The bar resized by its right-hand handle; undone and redone.
    const bar = v.items.find((i) => i.type === 'hbar');
    await page.click(`#lyt-canvas [data-id="${bar.id}"]`);
    await drag(await center('.lyt-handle[data-handle="e"]'), await cell(bar.x + bar.w + 10, bar.y + 2));
    assert.equal((await layout()).items.find((i) => i.type === 'hbar').w, bar.w + 10, 'the bar 10 cells wider');
    await page.click('#lyt-undo');
    assert.equal((await layout()).items.find((i) => i.type === 'hbar').w, bar.w, 'undone');
    await page.click('#lyt-redo');
    assert.equal((await layout()).items.find((i) => i.type === 'hbar').w, bar.w + 10, 'redone');
    step('the bar resized by a handle, undone and redone');

    // Saved, the page reloaded, opened again: as it was.
    await page.fill('#lyt-name', 'test-bridge');
    await page.fill('#lyt-title', 'Test bridge');
    await page.click('#lyt-save');
    await page.waitForSelector('#lyt-status:has-text("saved")');
    const saved = await layout();
    const file = JSON.parse(fs.readFileSync(path.join(CONFIG, 'layouts', 'test-bridge.json'), 'utf8'));
    assert.deepEqual(file.items, saved.items, 'the file has the layout');
    await page.goto(URL);
    await page.waitForSelector('#lyt-saved-list button[data-value="test-bridge"]');
    await page.click('#lyt-saved-list button[data-value="test-bridge"]');
    await page.waitForFunction(() => window.__designer.layout.name === 'test-bridge');
    const back = await layout();
    assert.deepEqual(back.items, saved.items, 'opened again just as saved');
    assert.equal(back.title, 'Test bridge');
    assert.equal(await page.locator(`#lyt-canvas [data-id="${e2.id}"] [data-id="${label.id}"]`).count(), 1, 'the label drawn in the elbow again');
    step('saved (config/layouts/test-bridge.json), the page reloaded, and the layout opened again just as it was');

    // The samples open and draw (the images too).
    for (const name of ['vico-msd', 'access-813']) {
      await page.click(`#lyt-saved-list button[data-value="${name}"]`);
      await page.waitForFunction((n) => window.__designer.layout.name === n, name);
      const n = await page.locator('#lyt-canvas .lyt-item').count();
      assert.ok(n > 5, `${name}: ${n} parts drawn`);
      await page.waitForFunction(() => [...document.querySelectorAll('#lyt-canvas img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 5000 });
    }
    step('the sample layouts (the Vico MSD, LCARS Access 813) open and draw, their images too');
    assert.deepEqual(errors, [], `no page errors: ${errors}`);
    if (process.env.LAYOUT_SHOTS) {
      for (const name of ['vico-msd', 'access-813']) {
        await page.click(`#lyt-saved-list button[data-value="${name}"]`);
        await page.waitForFunction((n) => window.__designer.layout.name === n, name);
        await wait(300);
        await page.screenshot({ path: path.join(process.env.LAYOUT_SHOTS, `${name}.png`) });
      }
    }
    ok = true;
  } catch (err) {
    console.error('FAIL:', err.message);
  } finally {
    await browser?.close();
    if (relay) await new Promise((r) => { relay.once('exit', r); relay.kill(); });
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
  }
})();
