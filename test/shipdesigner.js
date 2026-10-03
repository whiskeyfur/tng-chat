// The ship designer (/shipdesigner), on a copy of config/: every design file opens and is written
// back exactly as it was; a radiator added from the type library and wired to Bus B with the
// mouse, its link set to "warn" with a reason in the panel; Check finds no problems but says it
// isn't stable (the old design fields have no place for it); Save as a new design writes it
// (and its positions) and the page opens it again just as it was; a bad graph is refused.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const PORT = Number(process.env.PORT || 8099) + 20;
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-shipdesigner-'));
const CONFIG = path.join(TMP, 'config'), DATA = path.join(TMP, 'data');
fs.cpSync(path.join(ROOT, 'config'), CONFIG, { recursive: true });
fs.mkdirSync(DATA);
const BASE = `http://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`ok - ${s}`);

(async () => {
  let ok = false, browser, relay;
  try {
    relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT, CONFIG_DIR: CONFIG, RELAY_DATA: DATA, SHIPCORE_DATA: DATA, STARBASES_FILE: path.join(DATA, 'starbases.json') } });
    await wait(1200);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'test-runabout' : undefined));
    await page.goto(`${BASE}/shipdesigner`);
    await page.waitForFunction(() => window.__shipdesigner?.id && window.__shipdesigner.graph._nodes.length);

    // Every design: opened and written back unchanged.
    const ids = await page.evaluate(() => window.__shipdesigner.designs.map((d) => d.id));
    assert.ok(ids.includes('runabout') && ids.length >= 5, `the designs listed: ${ids}`);
    for (const id of ids) {
      const same = await page.evaluate(async (id) => {
        const st = window.__shipdesigner, file = (await (await fetch(`/api/ship-designs/${id}`)).json()).graph;
        const sel = document.getElementById('design'); sel.value = id; sel.dispatchEvent(new Event('change'));
        for (let i = 0; i < 50 && st.id !== id; i++) await new Promise((r) => setTimeout(r, 50));
        return JSON.stringify(st.toGraph()) === JSON.stringify(file);
      }, id);
      assert.ok(same, `${id} written back as it was`);
    }
    step(`all ${ids.length} designs open and are written back unchanged`);

    // A radiator from the type library, near Bus B; Bus B's power dragged to its "+ power".
    await page.selectOption('#design', 'runabout');
    await page.waitForFunction(() => window.__shipdesigner.id === 'runabout');
    const added = await page.evaluate(() => {
      const st = window.__shipdesigner, L = window.litegraph.js.LiteGraph, bus = st.graph._nodes.find((n) => n.sysId === 'bus-b');
      st.canvas.ds.scale = 1; st.canvas.ds.offset = [-bus.pos[0] + 100, -bus.pos[1] + 120];
      const n = L.createNode('sink/radiator'); n.pos = [bus.pos[0] + 400, bus.pos[1]]; st.graph.add(n);
      st.canvas.setDirty(true, true);
      return { node: n.id, sysId: n.sysId };
    });
    assert.ok(/^radiator-\d+$/.test(added.sysId), `a new radiator's id: ${added.sysId}`);
    await wait(200);
    const box = await page.locator('#graph-canvas').boundingBox();
    const screen = (pt, ds) => [box.x + (pt[0] + ds[0]) * ds[2], box.y + (pt[1] + ds[1]) * ds[2]];
    const pts = await page.evaluate((id) => {
      const st = window.__shipdesigner, bus = st.graph._nodes.find((n) => n.sysId === 'bus-b'), r = st.graph.getNodeById(id);
      return { a: [...bus.getConnectionPos(false, bus.findOutputSlot('power'))], b: [...r.getConnectionPos(true, r.inputs.findIndex((i) => i.spare && i.type === 'power'))], ds: [...st.canvas.ds.offset, st.canvas.ds.scale] };
    }, added.node);
    const [A, B] = [screen(pts.a, pts.ds), screen(pts.b, pts.ds)];
    await page.mouse.move(...A); await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(A[0] + ((B[0] - A[0]) * i) / 8, A[1] + ((B[1] - A[1]) * i) / 8);
    await page.mouse.up();
    await wait(200);
    const up = () => page.evaluate((id) => window.__shipdesigner.toGraph().systems[id].upstream, added.sysId);
    assert.deepEqual(await up(), { 'bus-b': { power: { pull: 'auto', push: false } } }, 'the radiator draws power from Bus B');
    const labels = await page.evaluate((id) => window.__shipdesigner.graph.getNodeById(id).inputs.map((i) => i.label), added.node);
    assert.ok(labels.includes('power ← Bus B') && labels.includes('+ power'), `its inputs: ${labels}`);
    step('a radiator added from the type library and wired to Bus B with the mouse');

    // The wire's centre clicked: the link in the panel, set to warn with a reason.
    const mid = await page.evaluate((id) => {
      const st = window.__shipdesigner, r = st.graph.getNodeById(id), l = st.graph.links.get(r.inputs.find((i) => i.link != null).link);
      return { pos: [...l._pos], ds: [...st.canvas.ds.offset, st.canvas.ds.scale] };
    }, added.node);
    await page.mouse.click(...screen(mid.pos, mid.ds));
    await page.waitForSelector('#panel [data-p="pull"]');
    await page.selectOption('#panel [data-p="pull"]', 'warn');
    await page.fill('#panel [data-f="why"]', 'it runs hot');
    await page.press('#panel [data-f="why"]', 'Tab');
    assert.deepEqual(await up(), { 'bus-b': { power: { pull: 'warn', push: false, why: 'it runs hot' } } }, 'the link set in the panel');
    step("the wire's centre clicked opens its link; pull set to warn, with a reason");

    // Check: no problems, but not stable (the old design fields have no radiator-N).
    await page.click('#check');
    await page.waitForFunction(() => /problem|No problems/.test(document.getElementById('problems').textContent));
    const checked = await page.textContent('#problems');
    assert.ok(/No problems found/.test(checked) && /not stable/.test(checked) && checked.includes(added.sysId), `the check: ${checked}`);
    step("Check: no problems, and a warning that it isn't stable yet");

    // Save as a new design; the file and its positions written; opened again as it was.
    const before = await page.evaluate(() => window.__shipdesigner.toGraph());
    await page.click('#save-as');
    await page.waitForFunction(() => /saved/.test(document.getElementById('problems').textContent));
    const file = JSON.parse(fs.readFileSync(path.join(CONFIG, 'ships', 'test-runabout.json'), 'utf8'));
    assert.equal(file.class, 'test-runabout');
    assert.deepEqual(file.systems[added.sysId].upstream, { 'bus-b': { power: { pull: 'warn', push: false, why: 'it runs hot' } } }, 'the saved file has the radiator and its link');
    assert.deepEqual({ ...file, class: 'runabout' }, before, 'the saved file is the graph as edited');
    const layout = JSON.parse(fs.readFileSync(path.join(CONFIG, 'layouts', 'ships', 'test-runabout.json'), 'utf8'));
    assert.ok(layout.nodes[added.sysId] && layout.nodes['bus-b'], 'positions saved');
    assert.equal(await page.evaluate(() => window.__shipdesigner.dirty), false, 'nothing unsaved after saving');
    await page.reload();
    await page.waitForFunction(() => window.__shipdesigner?.id === 'test-runabout' && window.__shipdesigner.graph._nodes.length);
    const again = await page.evaluate((id) => { const st = window.__shipdesigner, n = st.graph._nodes.find((x) => x.sysId === id); return { pos: [...n.pos], graph: st.toGraph() }; }, added.sysId);
    assert.deepEqual(again.graph, file, 'opened again: the same graph');
    assert.deepEqual(again.pos.map(Math.round), layout.nodes[added.sysId], 'opened again: the radiator where it was');
    step('Save as writes the design and its positions; the page opens it again just as it was');

    // A bad graph refused, the file untouched.
    const res = await page.evaluate(async () => {
      const g = window.__shipdesigner.toGraph(); g.systems['bus-b'].upstream['no-such'] = { power: { pull: true } };
      const r = await fetch('/api/ship-designs/test-runabout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ graph: g }) });
      return { status: r.status, body: await r.json() };
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.problems.some((p) => p.includes('no system "no-such"')), JSON.stringify(res.body));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(CONFIG, 'ships', 'test-runabout.json'), 'utf8')), file, 'the file untouched');
    step('a graph that fails the check is refused, and the file is left as it was');

    assert.deepEqual(errors, [], `no page errors: ${errors}`);
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
