// Automation toggles: a station turns its own panels' automation on and off from its console, kept in
// step with Ops'; when Ops flips a panel whose station is crewed, it's a request to that station's
// lead on duty (the most senior there), who confirms or denies it (nobody else can); Ops can withdraw
// it; with nobody at the station, Ops' flip is done at once, and a request waiting when the station
// empties is done then. Everything is in the ops log. Alert postures: red with Tactical and
// Engineering empty raises the shields, arms the phasers and sets the power at once; condition blue
// with the chief at Engineering is offered to them (nothing changes until Apply); condition green
// puts the power back as it was.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 8099) + 16;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-auto-'));
const env = { ...process.env, PORT, RELAY_DATA: DATA, STARBASES_FILE: path.join(DATA, 'starbases.json') };
const procs = [];
const run = (args) => { const p = spawn(process.execPath, args, { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' }); procs.push(p); return p; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`ok - ${s}`);
async function connect(hello) {
  const ws = new WebSocket(`ws://localhost:${PORT}`), msgs = [];
  ws.on('message', (m) => msgs.push(JSON.parse(m)));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify(hello));
  // (Only what's arrived since the last thing sent: an older message can't answer for a newer one.)
  let since = 0;
  const until = async (pred, what, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const m = msgs.slice(since).reverse().find(pred); if (m) return m; await wait(100); } throw new Error(`timed out: ${what}`); };
  return { ws, msgs, until, send: (m) => { since = msgs.length; ws.send(JSON.stringify(m)); }, own: () => [...msgs].reverse().find((m) => m.type === 'nav' && m.own)?.own };
}

let ok = false;
(async () => {
  try {
    run(['server.js']); await wait(1200);
    run(['tools/shipcore.js', '--relay', `ws://localhost:${PORT}`, '--data', DATA, '--warm', '--class', 'galaxy', 'Autoship']); await wait(2500);
    const chief = await connect({ type: 'register', name: 'chief', ship: 'Autoship', station: 'Engineering' });
    const ops = await connect({ type: 'operator', name: 'opsy', ship: 'Autoship' });
    await chief.until((m) => m.type === 'nav' && m.own?.autoPanels, 'the panels on the chief\'s console');
    const panel = (c, p) => c.own()?.autoPanels.find((a) => a.panel === p);
    // (The station's own toggle.)
    chief.send({ type: 'automation', panel: 'lifeSupport', on: true });
    await chief.until((m) => m.type === 'nav' && m.own?.autoPanels?.find((a) => a.panel === 'lifeSupport')?.mode === true, 'life support automated from Engineering');
    await ops.until((m) => m.type === 'roster' && m.automation?.find((a) => a.panel === 'lifeSupport')?.on === true, 'Ops sees it on');
    chief.send({ type: 'automation', panel: 'tactical', on: true });
    await chief.until((m) => m.type === 'notice' && /can't automate/.test(m.text), 'Engineering refused another station\'s panel');
    step('Engineering turns its own life support automation on from its console; Ops sees it; another station\'s panel is refused');

    // (Ops, with the station crewed: a request to its lead.)
    ops.send({ type: 'automation', panel: 'lifeSupport', on: false });
    await chief.until((m) => m.type === 'nav' && m.own?.autoRequests?.some((r) => r.panel === 'lifeSupport' && r.leadId), 'the request on the chief\'s console');
    assert.equal(panel(chief, 'lifeSupport').mode, true, 'not changed until it\'s answered');
    await ops.until((m) => m.type === 'roster' && m.automation?.find((a) => a.panel === 'lifeSupport')?.pending, 'Ops sees it awaiting the lead');
    const crewman = await connect({ type: 'register', name: 'wesley', ship: 'Autoship', station: 'Engineering' });
    await wait(300);
    crewman.send({ type: 'automation-answer', panel: 'lifeSupport', yes: true });
    await crewman.until((m) => m.type === 'notice' && /Only the lead on duty/.test(m.text), 'the second one in isn\'t the lead');
    chief.send({ type: 'automation-answer', panel: 'lifeSupport', yes: false });
    await chief.until((m) => m.type === 'nav' && m.own?.autoRequests?.length === 0, 'the request answered');
    assert.equal(panel(chief, 'lifeSupport').mode, true, 'denied: as it was');
    ops.send({ type: 'automation', panel: 'lifeSupport', on: false });
    await chief.until((m) => m.type === 'nav' && m.own?.autoRequests?.length === 1, 'asked again');
    chief.send({ type: 'automation-answer', panel: 'lifeSupport', yes: true });
    await chief.until((m) => m.type === 'nav' && !m.own?.autoPanels?.find((a) => a.panel === 'lifeSupport')?.mode && m.own?.autoRequests?.length === 0, 'confirmed: off');
    ops.send({ type: 'automation', panel: 'lifeSupport', on: true });
    await ops.until((m) => m.type === 'roster' && m.automation?.find((a) => a.panel === 'lifeSupport')?.pending, 'asked once more');
    ops.send({ type: 'automation', panel: 'lifeSupport', withdraw: true });
    await ops.until((m) => m.type === 'roster' && !m.automation?.find((a) => a.panel === 'lifeSupport')?.pending, 'withdrawn');
    step('Ops flipping a crewed station\'s panel asks its lead on duty: nobody else can answer, a denial leaves it, a confirmation does it, and Ops can withdraw it');

    // (Nobody at the station: done at once; a request waiting when the station empties, done then.)
    ops.send({ type: 'automation', panel: 'tactical', on: true });
    await ops.until((m) => m.type === 'roster' && m.automation?.find((a) => a.panel === 'tactical')?.on === true, 'Tactical, unmanned, automated at once');
    ops.send({ type: 'automation', panel: 'lifeSupport', on: true });
    await ops.until((m) => m.type === 'roster' && m.automation?.find((a) => a.panel === 'lifeSupport')?.pending, 'a request for the chief');
    chief.ws.close(); crewman.ws.close();
    await ops.until((m) => m.type === 'roster' && m.automation?.find((a) => a.panel === 'lifeSupport')?.on === true, 'done when Engineering empties', 10000);
    const text = ops.msgs.filter((m) => m.type === 'op-log').map((m) => m.text).join('\n');
    for (const w of ['asked', 'denied', 'confirmed by', 'withdrew', 'nobody left']) assert.ok(text.includes(w), `the ops log has "${w}" (${text})`);
    step('with nobody at the station, Ops\' flip is done at once; a request waiting when it empties is done then; every step is in the ops log');

    // Alert postures.
    ops.send({ type: 'automation', panel: 'tactical', on: false });
    await wait(500);
    const nav = () => JSON.parse(fs.readFileSync(path.join(DATA, 'Autoship', '.nav.json'), 'utf8'));
    const waitNav = async (pred, what) => { for (let i = 0; i < 60; i++) { const n = nav(); if (pred(n)) return n; await wait(250); } throw new Error(`timed out: ${what} (${JSON.stringify(nav().power)})`); };
    const before = nav().power;
    const capt = await connect({ type: 'register', name: 'kirk', ship: 'Autoship', station: 'Captain' });
    await capt.until((m) => m.type === 'nav' && m.own, 'the Captain aboard');
    capt.send({ type: 'alert', level: 'red' });
    await capt.until((m) => m.type === 'nav' && m.own?.alert === 'red', 'red alert');
    const red = await waitNav((n) => n.power.shields === 100 && n.power.recreation === 0, 'the red posture\'s power');
    step(`red alert, Tactical and Engineering empty: the posture at once (shields ${red.power.shields}%, weapons ${red.power.weapons}%, recreation ${red.power.recreation}%)`);
    const chief2 = await connect({ type: 'register', name: 'scotty', ship: 'Autoship', station: 'Engineering' });
    await chief2.until((m) => m.type === 'nav' && m.own, 'the chief back');
    capt.send({ type: 'alert', level: 'blue' });
    await chief2.until((m) => m.type === 'nav' && m.own?.postureOffers?.some((o) => o.station === 'Engineering' && o.level === 'blue'), 'blue offered to Engineering');
    await wait(1500);
    assert.equal(nav().power.engines, red.power.engines, 'nothing changes until Engineering applies it');
    chief2.send({ type: 'posture', apply: true });
    const blue = await waitNav((n) => n.power.engines === 10 && n.power.weapons === 0, 'the blue posture applied');
    capt.send({ type: 'alert', level: 'green' });
    await chief2.until((m) => m.type === 'nav' && m.own?.postureOffers?.some((o) => o.level === 'green'), 'green offered');
    chief2.send({ type: 'posture', apply: true });
    const back = await waitNav((n) => n.power.engines === before.engines && n.power.shields === before.shields && n.power.recreation === before.recreation, 'the power back as it was');
    step(`condition blue with the chief at Engineering: offered, applied on their tap (engines ${blue.power.engines}%, weapons ${blue.power.weapons}%); condition green: the power back as it was before the alert (engines ${back.power.engines}%, shields ${back.power.shields}%)`);
    ok = true;
  } catch (err) {
    console.error('FAIL:', err.stack || err.message);
  } finally {
    for (const p of procs) p.kill('SIGKILL');
    fs.rmSync(DATA, { recursive: true, force: true });
    console.log(ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
  }
})();
