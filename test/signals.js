// Signals and the comms stage. The reckoning (tools/signals.js): a nearer transmitter is stronger, a
// closing one has a phase offset, a neighbour on the next channel interferes, and each module takes
// out what it's for (the filter on the right channel the interference, the phase shifter the offset,
// the waveform matcher the noise). In play: the Defiant's Ops hails the Enterprise, which has only
// Communications on duty; the hail pops up on the Enterprise's stage as an RF source (channel,
// bearing, strength, from the Defiant); wired through a filter, a phase shifter and a matched waveform
// to the Captain, it goes through, and they're in a call. A third
// ship listening on the Defiant's channel intercepts it (in its core log).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { chromium } = require('playwright');
const SIGNALS = require('../tools/signals');

const step = (s) => console.log(`ok - ${s}`);
const PORT = Number(process.env.PORT || 8099) + 19;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-signals-'));
const env = { ...process.env, PORT, RELAY_DATA: DATA, STARBASES_FILE: path.join(DATA, 'starbases.json') };
const procs = [];
const run = (args) => { const p = spawn(process.execPath, args, { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' }); procs.push(p); return p; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function connect(hello) {
  const ws = new WebSocket(`ws://localhost:${PORT}`), msgs = [];
  ws.on('message', (m) => msgs.push(JSON.parse(m)));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify(hello));
  const until = async (pred, what, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const m = [...msgs].reverse().find(pred); if (m) return m; await wait(100); } throw new Error(`timed out: ${what}`); };
  return { ws, msgs, until, send: (m) => ws.send(JSON.stringify(m)) };
}

let ok = false, browser;
(async () => {
  try {
    // The reckoning.
    const near = SIGNALS.seen({ x: 0, y: 0 }, { x: 0, y: -50 }, { range: 200 }), far = SIGNALS.seen({ x: 0, y: 0 }, { x: 0, y: -150 }, { range: 200 });
    assert.ok(near.strength > far.strength && near.bearing === 0, 'nearer is stronger; north is 000');
    const closing = SIGNALS.seen({ x: 0, y: 0, vx: 0, vy: -3 }, { x: 0, y: -50 }, { range: 200 });
    assert.ok(closing.phase !== 0 && near.phase === 0, 'closing: a phase offset');
    const sig = { channel: 452, strength: 0.8, phase: 60, interference: SIGNALS.interference(452, [{ channel: 453, strength: 0.6 }]) };
    assert.ok(sig.interference > 0 && SIGNALS.interference(452, [{ channel: 460, strength: 1 }]) === 0, 'the next channel interferes, a far one doesn\'t');
    const raw = SIGNALS.quality(sig).quality, filtered = SIGNALS.quality(sig, [{ type: 'filter', channel: 452 }]).quality, wrong = SIGNALS.quality(sig, [{ type: 'filter', channel: 450 }]).quality;
    const phased = SIGNALS.quality(sig, [{ type: 'filter', channel: 452 }, { type: 'phase', shift: 60 }]).quality, best = SIGNALS.quality(sig, SIGNALS.bestChain(sig)).quality;
    assert.ok(raw < filtered && wrong === raw && filtered < phased && phased < best && best >= SIGNALS.QUALITY_TO_ROUTE, `${raw} < ${filtered} < ${phased} < ${best}`);
    step(`the reckoning: strength falls with distance, a closing ship shows a phase offset, the next channel interferes; raw ${raw}, filtered ${filtered}, phase-corrected ${phased}, waveform matched ${best}`);

    // In play.
    run(['server.js']); await wait(1200);
    run(['tools/shipcore.js', '--relay', `ws://localhost:${PORT}`, '--data', path.join(DATA, 'e'), '--warm', '--position', '500,300', '--class', 'galaxy', 'Enterprise']);
    run(['tools/shipcore.js', '--relay', `ws://localhost:${PORT}`, '--data', path.join(DATA, 'd'), '--warm', '--position', '560,330', '--class', 'galaxy', 'Defiant']);
    run(['tools/shipcore.js', '--relay', `ws://localhost:${PORT}`, '--data', path.join(DATA, 'x'), '--warm', '--position', '520,360', '--class', 'galaxy', 'Excelsior']);
    await wait(3000);
    const sisko = await connect({ type: 'register', name: 'sisko', ship: 'Defiant', station: 'Captain' });
    const dops = await connect({ type: 'operator', name: 'dax', ship: 'Defiant' });
    const picard = await connect({ type: 'register', name: 'picard', ship: 'Enterprise', station: 'Captain' });
    const spy = await connect({ type: 'register', name: 'spy', ship: 'Excelsior', station: 'Communications' });
    await sisko.until((m) => m.type === 'registered', 'Sisko aboard');
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
    page.on('pageerror', (e) => console.log('  [uhura] page error', e.message));
    await page.goto(`http://localhost:${PORT}/`);
    await page.fill('#name', 'uhura');
    await page.click('#signin-ships button[data-ship="Enterprise"]');
    await page.click('#signin-unassigned button[data-station="Communications"]');
    await page.click('#register-go');
    await page.waitForFunction(() => window.showScreen);
    await page.evaluate(() => window.showScreen('st-stage'));
    // (The spy listens on the Defiant's channel.)
    const dch = (await dops.until((m) => m.type === 'roster', 'the Defiant\'s ops')) && null;
    void dch;
    const sNav = await sisko.until((m) => m.type === 'nav' && m.own?.comm, 'the Defiant\'s channel');
    spy.send({ type: 'comms', listen: sNav.own.comm.channel });
    // The hail.
    const crewId = (await sisko.until((m) => m.type === 'registered', 'Sisko')).id;
    dops.send({ type: 'hail', crew: crewId, ship: 'Enterprise' });
    await page.waitForSelector('.stage-signal:has-text("From the Defiant")', { timeout: 15000 });
    const text = await page.textContent('.stage-signal');
    assert.ok(/Channel \d+ · bearing \d{3}°/.test(text) && /Strength \d+%/.test(text), `the RF source: ${text}`);
    step(`the hail pops up on the Enterprise's stage: ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
    // (Straight to the Captain: wired, but too noisy? Then through the modules.)
    await page.waitForFunction(() => window.__stageApi?.nodes().crew && Object.keys(window.__stageApi.nodes().crew).length > 0);
    const picardId = (await picard.until((m) => m.type === 'registered', 'Picard')).id;
    const wire = (from, to) => page.evaluate(([a, b]) => window.__stageApi.editor().addConnection(a, b, 'output_1', 'input_1'), [from, to]);
    const nodes = await page.evaluate(() => window.__stageApi.nodes());
    const src = Object.values(nodes.signals)[0], cap = nodes.crew[picardId];
    await page.click('#stage-add-filter'); await page.click('#stage-add-phase'); await page.click('#stage-add-wave');
    const mods = await page.evaluate(() => { const d = window.__stageApi.editor().export().drawflow.Home.data; return Object.values(d).filter((n) => n.data?.type).map((n) => [n.data.type, n.id]); });
    const id = (t) => mods.find(([x]) => x === t)[1];
    await wire(src, id('filter')); await wire(id('filter'), id('phase')); await wire(id('phase'), id('wave')); await wire(id('wave'), cap);
    // (Each module set from what the signal shows: the filter on its channel, the shift against its phase, the wave matched.)
    const s = (await picard.until((m) => m.type === 'nav' && m.own?.signals?.length, 'the signal')).own.signals.find((x) => x.kind === 'hail');
    await page.evaluate(([nid, ch]) => { const ed = window.__stageApi.editor(); ed.updateNodeDataFromId(nid, { ...ed.getNodeFromId(nid).data, channel: ch }); }, [id('filter'), s.channel]);
    await page.evaluate(([nid, ph]) => { const ed = window.__stageApi.editor(); ed.updateNodeDataFromId(nid, { ...ed.getNodeFromId(nid).data, shift: ph }); }, [id('phase'), s.phase]);
    await page.evaluate(([nid, w]) => { const ed = window.__stageApi.editor(); ed.updateNodeDataFromId(nid, { ...ed.getNodeFromId(nid).data, ...w }); }, [id('wave'), s.wave]);
    await page.evaluate(() => window.__stage.set(0, 'x', 0, 0, 0)).catch(() => {});
    await page.click(`#stage-route-${s.id}`, { force: true }).catch(async () => { await page.evaluate((sid) => window.__stage.route(sid), s.id); });
    await picard.until((m) => m.type === 'connect' && m.peers?.some((p) => p.name === 'sisko'), 'Picard connected to Sisko');
    step(`wired through an RF filter (channel ${s.channel}), a phase shifter (${s.phase}°) and a matched waveform to the Captain, the hail went through: Picard and Sisko connected`);
    await spy.until((m) => m.type === 'core-log' && m.entries.some((x) => /intercepted on channel/.test(x.text)), 'the Excelsior intercepted it', 15000).catch(async (err) => { spy.send({ type: 'core-log-get' }); await wait(500); console.log('# spy log:', JSON.stringify(spy.msgs.filter((m) => m.type === 'core-log').slice(-1)), JSON.stringify(spy.msgs.filter((m) => m.type === 'notice').map((m) => m.text))); throw err; });
    step('the Excelsior, listening on the Defiant\'s channel, intercepted it (in its core log)');
    await page.screenshot({ path: path.join(os.tmpdir(), 'tng-stage.png') });
    ok = true;
  } catch (err) {
    console.error('FAIL:', err.stack || err.message);
  } finally {
    await browser?.close().catch(() => {});
    for (const p of procs) p.kill('SIGKILL');
    fs.rmSync(DATA, { recursive: true, force: true });
    console.log(ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
  }
})();
