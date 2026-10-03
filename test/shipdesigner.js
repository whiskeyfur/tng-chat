// The ship designer (/shipdesigner), on a copy of config/: every design file opens and is written
// back exactly as it was; the node menu is a node per feature and one with none; a shields node
// added and wired from Bus B and Bus A with the mouse (both into its one input), Bus B's wire set
// to "warn" with a reason in its panel; Check finds no problems but says it isn't stable (the old
// design fields have no place for it); Save as a new design writes it
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
        // (In every view: each resource's, all of them, and rooted on its first bus.)
        const wrong = [];
        const viewSel = document.getElementById('view');
        for (const v of ['power', 'eps', 'heat', 'all']) {
          viewSel.value = v; viewSel.dispatchEvent(new Event('change'));
          if (JSON.stringify(st.toGraph()) !== JSON.stringify(file)) wrong.push(v);
        }
        const bus = st.graph._nodes.find((n) => n.sys.type === 'bus' || n.sys.type === 'eps-manifold');
        if (bus) {
          viewSel.value = 'power'; viewSel.dispatchEvent(new Event('change'));
          const n = st.graph._nodes.find((m) => m.sysId === bus.sysId);
          if (n) { st.canvas.selectNode(n); st.canvas.onNodeSelected(n); document.getElementById('root-here').click(); if (JSON.stringify(st.toGraph()) !== JSON.stringify(file)) wrong.push(`rooted on ${bus.sysId}`); }
          document.getElementById('unfocus').click();
        }
        return wrong;
      }, id);
      assert.deepEqual(same, [], `${id} written back as it was, in every view`);
    }
    step(`all ${ids.length} designs open and are written back unchanged, in every view (power, EPS, heat, all, rooted on a bus)`);

    // The power view: just the systems on power's graph; rooted on Bus B, just it and its neighbours.
    await page.selectOption('#design', 'runabout');
    await page.waitForFunction(() => window.__shipdesigner.id === 'runabout');
    await page.selectOption('#view', 'all');
    const counts = { all: await page.evaluate(() => window.__shipdesigner.graph._nodes.length) };
    await page.selectOption('#view', 'deu');
    counts.deu = await page.evaluate(() => window.__shipdesigner.graph._nodes.length);
    await page.selectOption('#view', 'power');
    await page.evaluate(() => { const st = window.__shipdesigner, n = st.graph._nodes.find((m) => m.sysId === 'bus-b'); st.canvas.selectNode(n); st.canvas.onNodeSelected(n); });
    await page.click('#root-here');
    const rooted = await page.evaluate(() => {
      const st = window.__shipdesigner, all = [];
      const walk = (ss) => { for (const [id, x] of Object.entries(ss || {})) { all.push([id, x]); walk(x.systems); } };
      walk(st.toGraph().systems);
      const near = new Set(['bus-b']);
      for (const [id, x] of all) for (const [u, rs] of Object.entries(x.upstream || {})) if (rs.power) { if (id === 'bus-b') near.add(u); if (u === 'bus-b') near.add(id); }
      return { shown: st.graph._nodes.map((n) => n.sysId).sort(), near: [...near].sort() };
    });
    assert.ok(counts.deu < counts.all / 3, `the deuterium view is a fraction of the whole: ${counts.deu} of ${counts.all}`);
    assert.deepEqual(rooted.shown, rooted.near, 'rooted on Bus B: it, what it draws power from and what draws power from it');
    await page.click('#unfocus');
    // An edit in a view lands in the whole design, and nothing else changes.
    await page.selectOption('#view', 'eps');
    const merged = await page.evaluate(async () => {
      const st = window.__shipdesigner, file = (await (await fetch('/api/ship-designs/runabout')).json()).graph;
      const bus = st.graph._nodes.find((n) => n.sysId === 'bus-b'), l = st.graph.links.get(bus.inputs.find((i) => i.link != null && st.graph.getNodeById(st.graph.links.get(i.link).origin_id).sysId === 'eps').link);
      l.bundle.eps.rate = 99;
      const g = st.toGraph();
      file.systems['bus-b'].upstream.eps.eps.rate = 99;
      return JSON.stringify(g) === JSON.stringify(file);
    });
    assert.ok(merged, 'a rate changed in the EPS view: that, and only that, in the design');
    await page.selectOption('#view', 'all');
    assert.equal(await page.evaluate(() => window.__shipdesigner.toGraph().systems['bus-b'].upstream.eps.eps.rate), 99, 'and still there in the all-resources view');
    await page.evaluate(() => { const st = window.__shipdesigner; const bus = st.graph._nodes.find((n) => n.sysId === 'bus-b'); const l = st.graph.links.get(bus.inputs.find((i) => i.link != null && st.graph.links.get(i.link).bundle.eps).link); l.bundle.eps.rate = 100; });
    step(`a view per resource (deuterium: ${counts.deu} of ${counts.all} systems); rooted on Bus B, ${rooted.shown.length} systems`);

    // (The rest in the all-resources view.)
    // The node menu: a node per feature (effect), and one with none; nothing of litegraph's own.
    const kinds = await page.evaluate(() => Object.keys(window.litegraph.js.LiteGraph.registered_node_types).sort());
    assert.ok(kinds.includes('feature/shields') && kinds.includes('feature/ftl') && kinds.includes('feature/seat') && kinds.includes('system/no feature'), `the node kinds: ${kinds}`);
    assert.ok(kinds.every((k) => k.startsWith('feature/') || k === 'system/no feature'), `only ours: ${kinds}`);
    step(`the node menu: ${kinds.length - 1} features (every effect the designs use too) and a node with none`);
    assert.ok(kinds.includes('feature/antimatter-transfer'), 'an effect a design uses (not in the docs list) is a feature');

    // A shields node, near Bus B; Bus B's out dragged to its in, then Bus A's onto the same in.
    const added = await page.evaluate(() => {
      const st = window.__shipdesigner, L = window.litegraph.js.LiteGraph, bus = st.graph._nodes.find((n) => n.sysId === 'bus-b');
      // (Out to the left of everything, so the wires' centres are clear of other nodes.)
      const minX = Math.min(...st.graph._nodes.map((m) => m.pos[0])), x = minX - 600;
      st.canvas.ds.scale = 0.6; st.canvas.ds.offset = [-x + 40, -bus.pos[1] + 300];
      const n = L.createNode('feature/shields'); n.pos = [x, bus.pos[1] + 200]; st.graph.add(n);
      st.canvas.setDirty(true, true);
      return { node: n.id, sysId: n.sysId };
    });
    assert.ok(/^shields-\d+$/.test(added.sysId), `a new shields node's id: ${added.sysId}`);
    assert.equal(await page.evaluate((id) => { const n = window.__shipdesigner.graph.getNodeById(id); return `${n.inputs.length}/${n.outputs.length}`; }, added.node), '1/1', 'one input, one output');
    await wait(200);
    const box = await page.locator('#graph-canvas').boundingBox();
    const screen = (pt, ds) => [box.x + (pt[0] + ds[0]) * ds[2], box.y + (pt[1] + ds[1]) * ds[2]];
    const wireFrom = async (busId) => {
      const pts = await page.evaluate(([id, busId]) => {
        const st = window.__shipdesigner, bus = st.graph._nodes.find((n) => n.sysId === busId), r = st.graph.getNodeById(id);
        return { a: [...bus.getConnectionPos(false, 0)], b: [...r.getConnectionPos(true, 0)], ds: [...st.canvas.ds.offset, st.canvas.ds.scale] };
      }, [added.node, busId]);
      const [A, B] = [screen(pts.a, pts.ds), screen(pts.b, pts.ds)];
      await page.mouse.move(...A); await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(A[0] + ((B[0] - A[0]) * i) / 8, A[1] + ((B[1] - A[1]) * i) / 8);
      await page.mouse.up();
      await wait(300);
    };
    await wireFrom('bus-b');
    const up = () => page.evaluate((id) => window.__shipdesigner.toGraph().systems[id].upstream, added.sysId);
    assert.deepEqual(await up(), { 'bus-b': { power: { pull: 'auto', push: false } } }, 'it draws power from Bus B');
    await wireFrom('bus-a');
    assert.deepEqual(await up(), { 'bus-b': { power: { pull: 'auto', push: false } }, 'bus-a': { power: { pull: 'auto', push: false } } }, 'and from Bus A, into the same input');
    const shown = await page.evaluate((id) => { const n = window.__shipdesigner.graph.getNodeById(id); return n.inputs.find((i) => i.spare).label; }, added.node);
    assert.equal(shown, 'in (2)', 'its input shows two wires');
    step('a shields node added from the menu; Bus B and Bus A wired into its one input with the mouse');

    // The wire's centre clicked: the link in the panel, set to warn with a reason.
    const mid = await page.evaluate((id) => {
      const st = window.__shipdesigner, r = st.graph.getNodeById(id), l = st.graph.links.get(r.inputs.find((i) => i.link != null).link); // (Bus B's)
      return { pos: [...l._pos], ds: [...st.canvas.ds.offset, st.canvas.ds.scale] };
    }, added.node);
    await page.mouse.click(...screen(mid.pos, mid.ds));
    await page.waitForSelector('#panel [data-bp="pull"][data-r="power"]');
    await page.selectOption('#panel [data-bp="pull"][data-r="power"]', 'warn');
    await page.fill('#panel [data-bf="why"][data-r="power"]', 'it runs hot');
    await page.press('#panel [data-bf="why"][data-r="power"]', 'Tab');
    await page.selectOption('#bundle-add', 'eps'); await page.click('#bundle-add-go');
    assert.deepEqual((await up())['bus-b'], { power: { pull: 'warn', push: false, why: 'it runs hot' }, eps: { pull: 'auto', push: false } }, 'the bundle set in the panel');
    await page.click('#panel [data-bdel="eps"]');
    assert.deepEqual((await up())['bus-b'], { power: { pull: 'warn', push: false, why: 'it runs hot' } }, 'eps taken out again');
    step("the wire's centre clicked opens its bundle: power set to warn with a reason, eps added and taken out");

    // Check: no problems, but not stable (the old design fields have no shields-N).
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
    assert.deepEqual(file.systems[added.sysId].upstream, { 'bus-b': { power: { pull: 'warn', push: false, why: 'it runs hot' } }, 'bus-a': { power: { pull: 'auto', push: false } } }, 'the saved file has the shields and its wires');
    assert.deepEqual(file.systems[added.sysId].effects, { shields: {} }, 'with its feature');
    assert.deepEqual({ ...file, class: 'runabout' }, before, 'the saved file is the graph as edited');
    const layout = JSON.parse(fs.readFileSync(path.join(CONFIG, 'layouts', 'ships', 'test-runabout.json'), 'utf8'));
    assert.ok(layout.nodes[added.sysId] && layout.nodes['bus-b'], 'positions saved');
    assert.equal(await page.evaluate(() => window.__shipdesigner.dirty), false, 'nothing unsaved after saving');
    await page.reload();
    await page.waitForFunction(() => window.__shipdesigner?.id === 'test-runabout' && window.__shipdesigner.graph._nodes.length);
    const again = await page.evaluate((id) => { const st = window.__shipdesigner, n = st.graph._nodes.find((x) => x.sysId === id); return { pos: [...n.pos], graph: st.toGraph() }; }, added.sysId);
    assert.deepEqual(again.graph, file, 'opened again: the same graph');
    assert.deepEqual(again.pos.map(Math.round), layout.nodes[added.sysId], 'opened again: the shields node where it was');
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
