// The data network map (d3-force), with John's topology: Utopia Planitia–Vengence–
// Discovery, Deep Space 4–Cole, Enterprise and Farragut both with Starbase 47;
// Starbase 12 and 74 on no ship's link, but every starbase joined through the Sol
// Subspace Relay (so it's all one data network). Seen from the Discovery's ops: linked vessels
// close together, no pills overlapping, the unlinked starbases further out;
// tapping a link lists its data network. Communications has the map too, and
// can request a link the other ship's ops sees.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { chromium } = require('playwright');

const PORT = Number(process.env.PORT || 8099) + 5;
const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-netmap-'));
const URL = `http://localhost:${PORT}/`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`ok - ${s}`);
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(100); } throw new Error(`timed out: ${fn.toString().slice(0, 120)}`); };
const procs = new Set();
const run = (args) => { const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, PORT, STARBASES_FILE: path.join(DATA, 'starbases.json') }, stdio: 'ignore' }); procs.add(p); p.on('exit', () => procs.delete(p)); return p; };
async function sock(hello) {
  const w = new WebSocket(`ws://localhost:${PORT}`), msgs = [];
  w.on('message', (m) => msgs.push(JSON.parse(m)));
  await new Promise((r) => w.on('open', r));
  w.send(JSON.stringify(hello));
  const last = (type) => [...msgs].reverse().find((m) => m.type === type);
  return { send: (m) => w.send(JSON.stringify(m)), msgs, last, close: () => w.close() };
}

(async () => {
  let ok = false, browser;
  try {
    run(['server.js']);
    await wait(800);
    const ships = { Discovery: 'crossfield', Vengence: 'dreadnought', Cole: 'galaxy', Enterprise: 'galaxy', Farragut: 'galaxy' };
    Object.entries(ships).forEach(([name, cls], i) => run(['tools/shipcore.js', '--relay', `ws://localhost:${PORT}`, '--data', DATA, '--warm', '--position', `${300 + i * 80},500`, '--class', cls, name]));
    // (Each ship's computer online first.)
    const watch = await sock({ type: 'hello' });
    await until(() => Object.keys(ships).every((n) => watch.last('ships')?.ships.some((x) => x.name === n && x.computer)), 20000);
    watch.close();
    const ops = {};
    for (const name of Object.keys(ships)) {
      ops[name] = await sock({ type: 'operator', name: `ops-${name}`, ship: name });
      await until(() => ops[name].last('roster'));
    }
    // The links (a starbase accepts by itself; a ship's ops accepts the request).
    const link = async (from, to) => {
      ops[from].send({ type: 'link-request', ship: to });
      if (ops[to]) { const r = await until(() => ops[to].last('roster')?.linkIncoming?.find((x) => x.fromShip === from)); ops[to].send({ type: 'link-accept', request: r.id }); }
      await until(() => ops[from].last('roster')?.links?.includes(to));
    };
    await link('Vengence', 'Utopia Planitia');
    await link('Discovery', 'Vengence');
    await link('Cole', 'Deep Space 4');
    await link('Enterprise', 'Starbase 47');
    await link('Farragut', 'Starbase 47');
    step('the links made: Utopia Planitia–Vengence–Discovery, Deep Space 4–Cole, Enterprise and Farragut with Starbase 47');

    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    const page = await (await browser.newContext({ viewport: { width: 1300, height: 850 } })).newPage();
    await page.goto(URL);
    await page.waitForSelector('#ship option[value="Discovery"]', { state: 'attached' });
    await page.fill('#name', 'detmer');
    await page.click('#signin-ships button[data-ship="Discovery"]');
    await page.click('#signin-unassigned button[data-station="Operations"]');
    await page.click('#register-go');
    await page.evaluate(() => document.querySelector('[data-screen-tab="link"]')?.click());
    await page.waitForFunction(() => document.querySelectorAll('#net-map .net-node').length === 11, null, { timeout: 15000 });
    await wait(500);
    // The pills, in the map's own coordinates.
    const pills = await page.$$eval('#net-map .net-node', (gs) => gs.map((g) => { const m = /translate\(([-\d.e]+) ([-\d.e]+)\)/.exec(g.getAttribute('transform')); const r = g.querySelector('rect'); const w = +r.getAttribute('width'), h = +r.getAttribute('height'); return { name: g.dataset.ship, x: +m[1] + w / 2, y: +m[2] + h / 2, w, h }; }));
    const at = Object.fromEntries(pills.map((p) => [p.name, p]));
    const dist = (a, b) => Math.hypot(at[a].x - at[b].x, at[a].y - at[b].y);
    for (const [a, b] of [['Vengence', 'Utopia Planitia'], ['Discovery', 'Vengence'], ['Cole', 'Deep Space 4'], ['Enterprise', 'Starbase 47'], ['Farragut', 'Starbase 47']]) {
      assert.ok(dist(a, b) < 1.4 * (at[a].w + at[b].w) / 2 + 60, `${a}–${b} close (${Math.round(dist(a, b))})`);
    }
    for (let i = 0; i < pills.length; i++) for (let j = i + 1; j < pills.length; j++) {
      const p = pills[i], q = pills[j];
      assert.ok(Math.abs(p.x - q.x) >= (p.w + q.w) / 2 - 1 || Math.abs(p.y - q.y) >= (p.h + q.h) / 2 - 1, `${p.name} and ${q.name} overlap`);
    }
    assert.ok(Math.abs(at.Discovery.x) < 1 && Math.abs(at.Discovery.y) < 1, 'our ship at the centre');
    for (const b of ['Starbase 12', 'Starbase 74', 'Starbase 47', 'Deep Space 4', 'Utopia Planitia']) assert.ok(dist('Sol Subspace Relay', b) < 1.4 * (at[b].w + at['Sol Subspace Relay'].w) / 2 + 80, `${b} near the relay (${Math.round(dist('Sol Subspace Relay', b))})`);
    step('the map: linked vessels close together (every starbase around the subspace relay), no pills overlapping, the Discovery at the centre');
    // The relay: at its place on the chart, linked with every starbase; a starbase can't close that link;
    // through it, the Enterprise (linked with Starbase 47) is on Starbase 12's network.
    const g = ops.Discovery.last('roster').graph;
    const relay = g.ships.find((x) => x.relay);
    assert.deepEqual([relay?.name, relay?.x, relay?.y], ['Sol Subspace Relay', 530, 520]);
    for (const b of ['Starbase 12', 'Starbase 74', 'Starbase 47', 'Deep Space 4', 'Utopia Planitia']) assert.ok(g.links.some((l) => l.includes('Sol Subspace Relay') && l.includes(b)), `the relay links ${b}`);
    const sb47 = await sock({ type: 'operator', name: 'ops-sb47', ship: 'Starbase 47' });
    await until(() => sb47.last('roster'));
    sb47.send({ type: 'link-close', ship: 'Sol Subspace Relay' });
    await until(() => sb47.msgs.some((m) => /subspace relay's link: it stays/.test(m.text || m.reason || '')));
    assert.ok(ops.Enterprise.last('roster').network.includes('Starbase 12'), 'the Enterprise reaches Starbase 12 through the relay');
    sb47.close();
    step('the Sol Subspace Relay at 530, 520 links every starbase; Starbase 47 could not close its link; the Enterprise (linked with Starbase 47) is on Starbase 12\'s network through it');
    // Tap a link: its two ends and its data network.
    await page.click('#net-map .net-link[data-link="enterprise|starbase 47"] .net-hit', { force: true });
    await page.waitForSelector('#net-details-members');
    const members = await page.$$eval('#net-details-members li', (ls) => ls.map((l) => l.dataset.member));
    for (const m of ['Enterprise', 'Farragut', 'Starbase 47', 'Starbase 12', 'Sol Subspace Relay']) assert.ok(members.includes(m), `${m} on the network (${members})`);
    assert.match(await page.textContent('#net-details'), new RegExp(`${members.length} members`));
    // Tap a vessel: its details.
    await page.click('#net-map .net-node[data-ship="Cole"]');
    await page.waitForSelector('#net-details-title:has-text("The Cole")');
    assert.match(await page.textContent('#net-details-facts'), /Galaxy class/);
    assert.match(await page.textContent('#net-details-facts'), /Data network.*network \(\d+\)/);
    step('tapping the Enterprise–Starbase 47 link listed its data network (through the relay: every starbase and the ships linked with them); tapping the Cole showed its class and network');
    // A link whose path is down stays, dashed (signal lost), and either end still closes it; the
    // other ships' links say who can close them; our own Open Links match the map's edges.
    await page.click('#net-map .net-link[data-link="enterprise|starbase 47"] .net-hit', { force: true });
    assert.match(await page.textContent('#net-link-who'), /Closed by either end: the Enterprise's or the Starbase 47's ops or Communications/);
    const ours = await page.$$eval('#net-map .net-link', (ls) => ls.map((l) => l.dataset.link).filter((k) => k.split('|').includes('discovery')));
    assert.equal(ours.length, (await until(() => ops.Discovery.last('roster'))).links.length, 'Open Links match the map');
    const scotty = await sock({ type: 'register', name: 'scotty', ship: 'Vengence', station: 'Engineering' });
    await until(() => scotty.last('nav'));
    scotty.send({ type: 'grid', ties: { 'sub:subspace': [] } });
    await page.waitForSelector('#net-map .net-link[data-link="utopia planitia|vengence"] line[data-lost]', { state: 'attached', timeout: 15000 });
    ops.Vengence.send({ type: 'link-close', ship: 'Utopia Planitia' });
    await until(() => !ops.Vengence.last('roster')?.links?.includes('Utopia Planitia'));
    await page.waitForSelector('#net-map .net-link[data-link="utopia planitia|vengence"]', { state: 'detached', timeout: 15000 });
    scotty.send({ type: 'grid', ties: { 'sub:subspace': ['B'] } });
    scotty.close();
    step("a link with its subspace relay down showed dashed (signal lost) and the Vengence still closed it; a link that isn't ours says who can close it; our Open Links match the map");

    // Communications (the Farragut's) has the map too, and requests a link the Cole's ops sees.
    const comms = await (await browser.newContext({ viewport: { width: 1300, height: 850 } })).newPage();
    await comms.goto(URL);
    await comms.waitForSelector('#ship option[value="Farragut"]', { state: 'attached' });
    await comms.fill('#name', 'hoshi');
    await comms.click('#signin-ships button[data-ship="Farragut"]');
    await comms.click('#signin-unassigned button[data-station="Communications"]');
    await comms.click('#register-go');
    await comms.evaluate(() => document.querySelector('[data-screen-tab="st-links"]')?.click());
    await comms.waitForFunction(() => document.querySelectorAll('#comm-net-map .net-node').length === 11, null, { timeout: 15000 });
    await comms.click('#comm-net-map .net-node[data-ship="Cole"]');
    await comms.click('[data-netmap-details] button:has-text("Request link")');
    await until(() => ops.Cole.last('roster')?.linkIncoming?.some((r) => r.fromShip === 'Farragut'));
    step("the Farragut's Communications has the map: tapping the Cole and Request link sent a request the Cole's ops sees");
    // Live counts: someone signing on aboard the Cole, and its ops leaving, change its pill (and its
    // details) on the Discovery's map without a reload (and without laying the map out again).
    const pill = () => page.textContent('#net-map .net-node[data-ship="Cole"]');
    await page.click('#net-map .net-node[data-ship="Cole"]');
    await page.waitForSelector('#net-details-title:has-text("The Cole")');
    // (Once the map is at rest from the last change.)
    const coleAt = () => page.$eval('#net-map .net-node[data-ship="Cole"]', (g) => g.getAttribute('transform'));
    let before = await coleAt();
    for (let i = 0; i < 40; i++) { await wait(250); const now = await coleAt(); if (now === before) break; before = now; }
    assert.match(await pill(), /1 aboard(?! · no ops)/);
    const rand = await sock({ type: 'register', name: 'rand', ship: 'Cole', station: 'Crew' });
    await page.waitForFunction(() => /2 aboard/.test(document.querySelector('#net-map .net-node[data-ship="Cole"]').textContent), null, { timeout: 10000 });
    assert.match(await page.textContent('#net-details-facts'), /Aboard\s*2 · ops manned/);
    assert.equal(await page.$eval('#net-map .net-node[data-ship="Cole"]', (g) => g.getAttribute('transform')), before, 'a count change moves nothing');
    ops.Cole.close();
    await page.waitForFunction(() => /1 aboard · no ops/.test(document.querySelector('#net-map .net-node[data-ship="Cole"]').textContent), null, { timeout: 10000 });
    assert.match(await page.textContent('#net-details-facts'), /Aboard\s*1 · ops unmanned/);
    rand.close();
    step("the Discovery's map followed the Cole's crew live: 2 aboard when rand signed on, no ops when its ops left; a count change moved nothing");
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
