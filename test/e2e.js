// Headless end-to-end check: starts the server, opens Chromium pages with a fake
// microphone, and drives crew consoles and ops consoles through calls (decline,
// accept, audio, chat, files, hang-up), operator actions (intercom, patch in,
// disconnect, calls to and from ops, transfers), ship-to-ship hails, data
// links, and ops dropping out.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

process.env.PORT = process.env.PORT || '8099';
process.env.BEAM_SECS = process.env.BEAM_SECS || '2'; // the transporter energizes this long (5 s in play)
process.env.RESERVE_SECS = process.env.RESERVE_SECS || '3';
process.env.DIAG_SECS = process.env.DIAG_SECS || '2'; // the transporter's level-3 diagnostic (16 s in play) // antimatter containment's internal reserve (9 minutes in play)
// Ship's computers keep their libraries in a scratch folder for the test.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-test-'));
const computers = new Set();
// Start a ship's computer (tools/shipcore.js) for some ships, with its own folder.
// Test ships start close together (within transporter range) unless they fly off.
const START = { Enterprise: '500,500', Defiant: '510,500', "K'Vatch": '505,505', Voyager: '520,520' };
// Test ships start where START says, powered up and fuelled (--warm);
// startComputer.cold(folder, ship) starts a new ship as players get it.
function startComputer(folder, ...ships) {
  const opts = typeof ships[ships.length - 1] === 'object' ? ships.pop() : {};
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'shipcore.js'),
    '--relay', `ws://localhost:${process.env.PORT}`, '--data', path.join(DATA_DIR, folder), ...(opts.cold ? [] : ['--warm', '--position', opts.position || START[ships[0]] || '500,500']), ...ships], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => process.stdout.write(String(d).replace(/^(?=.)/gm, `  [computer ${folder}] `)));
  proc.stderr.on('data', (d) => process.stdout.write(String(d).replace(/^(?=.)/gm, `  [computer ${folder} ERR] `)));
  computers.add(proc);
  proc.on('exit', () => computers.delete(proc));
  return proc;
}
startComputer.cold = (folder, ship) => startComputer(folder, ship, { cold: true });
const stopComputer = (proc) => new Promise((r) => { proc.once('exit', r); proc.kill(); });
const stored = (folder, ship, name) => { try { return fs.readFileSync(path.join(DATA_DIR, folder, ship, name), 'utf8'); } catch { return null; } };
// Each column of the grid table balances: what the sources give (and the
// EPS taps bring down) is what the loads and charging batteries take. Cells
// are rounded up for display, so allow a few units. Returns the columns that don't.
const GRID_SOURCES = ['ship', 'solar', 'dock', 'impulsePort', 'impulseStarboard', 'core', 'stores', 'taps'];
const unbalanced = (g) => ['A', 'B', 'C', 'EPS'].map((n) => [n, Object.entries(g.cells).reduce((sum, [k, c]) => sum + (GRID_SOURCES.includes(k) ? c[n] || 0 : k === 'feed' ? 0 : -(c[n] || 0)), 0)]).filter(([, v]) => Math.abs(v) > 6); // (cells are shown rounded up)
const SYSTEMS_SHORT = (own) => Object.keys(own.grid.demand).filter((k) => own.grid.delivered[k] < own.grid.demand[k]);
// The transporter's TOS energize sliders: all three to the top.
const energize = async (page) => { await page.waitForSelector('#beam-slider-1:not([disabled])'); await page.waitForFunction(() => [...document.querySelectorAll('.tr-slider')].every((r) => Number(r.value) === 0)); for (const n of [1, 2, 3]) await page.$eval(`#beam-slider-${n}`, (r) => { r.value = 100; r.dispatchEvent(new Event('input', { bubbles: true })); }); };
const waitFor = async (fn, ms = 10000) => {
  const where = (new Error().stack.split('\n')[2] || '').trim(); // the caller, for the failure message
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`timed out waiting (${where})`);
};
const server = require('../server');
const URL = `http://localhost:${process.env.PORT}/`;

const step = (s) => console.log(`ok - ${s}`);

// A stand-in radio station: a 440 Hz tone as WAV, with and without CORS.
const RADIO_PORT = Number(process.env.PORT) + 1;
const radioStation = http.createServer((req, res) => {
  const rate = 8000, secs = 30, n = rate * secs;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  const headers = { 'Content-Type': 'audio/wav', 'Content-Length': buf.length };
  if (req.url.startsWith('/cors')) headers['Access-Control-Allow-Origin'] = '*';
  res.writeHead(200, headers).end(buf);
}).listen(RADIO_PORT);

async function openAs(browser, name, tag, ship = 'Enterprise', station = 'Crew') {
  const page = await (await browser.newContext()).newPage();
  page.on('console', (m) => console.log(`  [${tag}] ${m.text()}`));
  await page.goto(URL);
  await page.fill('#name', name);
  await page.selectOption('#ship', ship); // only ships with ops on duty are listed
  await page.selectOption('#station', station);
  await page.click('#register-form button');
  return page;
}

// Take a ship's ops station: the Operations station on the same console page.
// The operator is aboard as crew too.
async function openOps(browser, ship, tag, name = 'obrien') {
  const page = await (await browser.newContext()).newPage();
  page.on('console', (m) => console.log(`  [${tag}] ${m.text()}`));
  await page.goto(URL);
  await page.fill('#name', name);
  await page.selectOption('#station', 'Operations');
  await page.selectOption('#ship', ship); // only ships with a ship's computer are offered
  await page.click('#register-form button');
  await page.waitForSelector('[data-screen="status"]:not([hidden])');
  return page;
}

// User ids are "name@ship", lowercased.
const id = (name, ship = 'Enterprise') => `${name}@${ship}`.toLowerCase();

const stateOf = (page) => page.evaluate(() => window.__voice.state);

// Comms lives in a modal: open it before using the directory or call controls,
// and close it before using the ops console behind it.
const openComms = async (page) => { if (!(await page.evaluate(() => window.__comms.isOpen))) await page.click('#comms-button'); };
const closeComms = (page) => page.evaluate(() => window.__comms.close());
// Consoles show one screen at a time; switch before using one.
const screen = (page, id) => page.evaluate((id) => showScreen(id), id);
const callFrom = async (page, who) => { await openComms(page); await page.click(`#users li:has-text("${who}") button`); };

// Inbound audio bytes from each person in the call, keyed by name.
const audioBytes = (page) => page.evaluate(async () => {
  const out = {};
  for (const p of window.__voice.call.peers.values()) {
    out[p.name] = 0;
    (await p.pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') out[p.name] += r.bytesReceived; });
  }
  return out;
});

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  let ok = false;
  try {
    // No ship's computers yet: no ships at all, not even for ops; only the
    // starbases, which run themselves.
    const early = await (await browser.newContext()).newPage();
    await early.goto(URL);
    await early.waitForSelector('#ship option[value="Starbase 47"]:has-text("automated")', { state: 'attached' });
    assert.deepEqual(await early.$$eval('#ship option:not([disabled])', (os) => os.map((o) => o.value)), ['Deep Space 4', 'Starbase 12', 'Starbase 47', 'Starbase 74']);
    // The station picker comes from the relay and includes every station.
    await early.waitForSelector('#station option[value="Transporter"]', { state: 'attached' });
    assert.equal(await early.locator('#station option:not([disabled])').count(), 12); // 11 + Operations
    step("without a ship's computer there is no ship, not even for ops: only the four automated starbases");

    // Ship's computers bring the ships into existence.
    let coreA = startComputer('a', 'Enterprise');
    let coreD = startComputer('d', 'Defiant');
    const coreK = startComputer('k', "K'Vatch");
    for (const ship of ['Enterprise', 'Defiant', "K'Vatch"]) await early.waitForSelector(`#ship option[value="${ship}"]`, { state: 'attached' });
    await early.close();
    step("ship's computers for the Enterprise, Defiant and K'Vatch put them in the ship list");

    const op = await openOps(browser, 'Enterprise', 'enterprise ops');
    const alice = await openAs(browser, 'alice', 'alice');
    const bob = await openAs(browser, 'bob', 'bob');
    await alice.waitForFunction(() => window.__voice.myName === 'alice');
    await bob.waitForFunction(() => window.__voice.myName === 'bob');

    // Names are unique, case-insensitively.
    const dup = await openAs(browser, 'ALICE', 'dup');
    await dup.waitForFunction(() => document.getElementById('register-error').textContent);
    assert.match(await dup.textContent('#register-error'), /already aboard the Enterprise/);
    await dup.close();
    const defiantOps = await openOps(browser, 'Defiant', 'defiant ops');
    const otherShip = await openAs(browser, 'alice', 'alice2', 'Defiant');
    await otherShip.waitForFunction(() => window.__voice.myName === 'alice');
    step('duplicate name on the same ship rejected; same name on another ship allowed');

    // The Defiant's ops station signs off: crew stay aboard and can still call
    // each other; the ship stays listed, marked ops offline.
    await defiantOps.close();
    await otherShip.waitForSelector('#ops-status:has-text("Ops offline")', { state: 'attached' });
    assert.equal(await otherShip.evaluate(() => window.__voice.myName), 'alice');
    const sisko = await openAs(browser, 'sisko', 'sisko', 'Defiant', 'Captain');
    await sisko.waitForFunction(() => window.__voice.myName === 'sisko');
    assert.match(await sisko.textContent('#ops-status'), /Ops offline/);
    await callFrom(sisko, 'alice');
    await otherShip.waitForSelector('.v-incoming:not([hidden])');
    await otherShip.click('.v-accept');
    await Promise.all([otherShip, sisko].map((page) => page.waitForFunction(() => window.__voice.connectedTo(1), null, { timeout: 20000 })));
    const lobby = await (await browser.newContext()).newPage();
    await lobby.goto(URL);
    await lobby.waitForSelector('#ship option[value="Defiant"]:has-text("ops offline")', { state: 'attached' });
    for (const page of [lobby, sisko, otherShip]) await page.close();
    step('no ops aboard: crew stay on, shipmates can still call each other, ship listed as ops offline');

    // Bob sees Alice in the online list; registering does not start any call.
    await bob.waitForSelector('#users li:has-text("alice") button', { state: 'attached' });
    assert.equal(await stateOf(alice), 'idle');
    step('online list shows other users, no call yet');

    // Declined call: no microphone or connection is ever set up.
    await callFrom(bob, 'alice');
    await alice.waitForSelector('.v-incoming:not([hidden])');
    assert.equal(await alice.textContent('.v-incoming-from'), 'bob (Crew)');
    await alice.click('.v-decline');
    await bob.waitForFunction(() => window.__voice.state === 'idle');
    assert.match(await bob.textContent('#log'), /alice declined/);
    step('call declined');

    // Accepted call: audio connects and flows both ways.
    await callFrom(bob, 'alice');
    await alice.waitForSelector('.v-incoming:not([hidden])');
    assert.equal(await alice.evaluate(() => !!window.__voice.peer('bob').pc), false, 'no connection before accept');
    await alice.click('.v-accept');
    for (const page of [alice, bob]) {
      await page.waitForFunction(() => window.__voice.connectedTo(1), null, { timeout: 20000 });
    }
    await alice.waitForTimeout(1500);
    for (const [who, page] of [['alice', alice], ['bob', bob]]) {
      const bytes = await audioBytes(page);
      assert.ok(Object.values(bytes).every((b) => b > 0), `${who} received no audio`);
      console.log(`  ${who} inbound audio bytes ${JSON.stringify(bytes)}`);
    }
    step('call accepted, audio flowing both ways');

    // Chat both directions.
    await alice.waitForFunction(() => window.__voice.peer('bob').chat?.readyState === 'open');
    await bob.fill('.v-chat-text', 'hello alice');
    await bob.click('.v-chat-form button');
    await alice.waitForSelector('.v-chatlog div:has-text("bob: hello alice")');
    await alice.fill('.v-chat-text', 'hi bob');
    await alice.press('.v-chat-text', 'Enter');
    await bob.waitForSelector('.v-chatlog div:has-text("alice: hi bob")');
    step('chat messages delivered');

    // File transfer: 300 KB (many chunks) with a byte pattern we can verify.
    const size = 300 * 1024 + 123;
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) & 0xff;
    await alice.setInputFiles('.v-file', { name: 'test.bin', mimeType: 'application/octet-stream', buffer: buf });
    await alice.click('.v-file-form button');
    const link = await bob.waitForSelector('.v-chatlog a[download="test.bin"]', { timeout: 15000 });
    const received = await link.evaluate(async (a) => Array.from(new Uint8Array(await (await fetch(a.href)).arrayBuffer())));
    assert.equal(received.length, size);
    assert.ok(received.every((b, i) => b === ((i * 31 + 7) & 0xff)), 'file contents differ');
    await alice.waitForSelector('.v-chatlog div:has-text("sent test.bin")');
    step(`file transferred intact (${size} bytes)`);

    // Subspace radio: alice tunes a station and patches it into the call.
    await openComms(alice);
    const micTrack = await alice.evaluate(() => window.__voice.call.stream.getAudioTracks()[0].id);
    await alice.fill('#radio-url', `http://localhost:${RADIO_PORT}/cors/tone.wav`);
    await alice.click('#radio-tune');
    await alice.waitForFunction(() => window.__comms.radio.canPatch && !document.getElementById('radio-patch').disabled);
    await alice.click('#radio-patch');
    await alice.waitForFunction(() => window.__voice.radioPatched);
    const sending = await alice.evaluate(() => window.__voice.peer('bob').pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio').sender.track.id);
    assert.notEqual(sending, micTrack, 'radio not mixed into what alice sends');
    await bob.waitForSelector('.v-chatlog div:has-text("[subspace radio] alice patched in")');
    await alice.waitForTimeout(1000);
    assert.equal(await bob.evaluate(() => window.__voice.connectedTo(1)), true);
    await alice.click('#radio-patch'); // unpatch
    await alice.waitForFunction(() => !window.__voice.radioPatched);
    assert.equal(await alice.evaluate(() => window.__voice.peer('bob').pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio').sender.track.id), micTrack);
    await bob.waitForSelector('.v-chatlog div:has-text("unpatched the radio")');
    step('subspace radio: alice patched a station into the call and unpatched it');

    // A station without CORS plays locally but can't be patched in.
    await alice.fill('#radio-url', `http://localhost:${RADIO_PORT}/plain/tone.wav`);
    await alice.click('#radio-tune');
    await alice.waitForSelector('#radio-status:has-text("plays here only")');
    assert.equal(await alice.isDisabled('#radio-patch'), true);
    await alice.click('#radio-stop');
    step('subspace radio: a station without cross-site access plays locally only');

    // Call waiting: carol calls alice while alice is talking to bob.
    const carol = await openAs(browser, 'carol', 'carol');
    await carol.waitForSelector('#users li:has-text("alice") button', { state: 'attached' });
    const talking = (page, n) => page.waitForFunction((n) => window.__voice.connectedTo(n), n, { timeout: 20000 });
    await callFrom(carol, 'alice');
    await alice.waitForSelector('.v-waiting:not([hidden])');
    assert.match(await alice.textContent('.v-waiting-from'), /carol/);
    assert.equal(await alice.evaluate(() => window.__voice.connectedTo(1)), true, 'call waiting interrupted the call');
    await alice.click('.v-ignore');
    await carol.waitForFunction(() => window.__voice.state === 'idle');
    assert.match(await carol.textContent('#log'), /alice is busy/);
    step('call waiting: ignore tells the caller alice is busy');

    await callFrom(carol, 'alice');
    await alice.waitForSelector('.v-waiting:not([hidden])');
    await carol.click('.v-hangup'); // carol gives up
    await alice.waitForSelector('.v-waiting', { state: 'hidden' });
    step('call waiting: the caller giving up clears it');

    await callFrom(carol, 'alice');
    await alice.waitForSelector('.v-waiting:not([hidden])');
    await alice.click('.v-join');
    await Promise.all([alice, bob, carol].map((page) => talking(page, 2)));
    assert.deepEqual(await carol.evaluate(() => window.__voice.peerNames()), ['alice', 'bob']);
    step('call waiting: join brings carol into alice and bob\'s call');
    await carol.click('.v-hangup');
    await Promise.all([talking(alice, 1), talking(bob, 1)]);

    await callFrom(carol, 'alice');
    await alice.waitForSelector('.v-waiting:not([hidden])');
    await alice.click('.v-switch');
    await bob.waitForFunction(() => window.__voice.state === 'idle');
    await Promise.all([talking(alice, 1), talking(carol, 1)]);
    assert.deepEqual(await alice.evaluate(() => window.__voice.peerNames()), ['carol']);
    step('call waiting: switch hangs up on bob and answers carol');

    // If the current call ends while someone waits, the waiting call rings.
    await callFrom(bob, 'alice');
    await alice.waitForSelector('.v-waiting:not([hidden])');
    await carol.click('.v-hangup');
    await alice.waitForSelector('.v-incoming:not([hidden])');
    assert.match(await alice.textContent('.v-incoming-from'), /bob/);
    await alice.click('.v-accept');
    await Promise.all([talking(alice, 1), talking(bob, 1)]);
    step('call waiting: when the current call ends, the waiting call rings');

    // Hang up ends the call on both sides.
    await alice.click('.v-hangup');
    await bob.waitForFunction(() => window.__voice.state === 'idle');
    assert.equal(await stateOf(alice), 'idle');
    step('hang up');

    // Operator console: sees everyone, force-connects without ringing, ends calls.
    await op.waitForFunction(() => window.__operator.roster.length === 4); // alice, bob, carol and ops
    const connected = (page, n = 1) => page.waitForFunction((n) => window.__voice.connectedTo(n), n, { timeout: 20000 });
    const opConnect = async (a, b) => {
      await closeComms(op);
      await screen(op, 'intercom');
      await op.selectOption('#a', id(a));
      await op.selectOption('#b', id(b));
      await op.click('#connect-form button');
    };
    step('operator sees all online users');

    await opConnect('alice', 'bob');
    await Promise.all([connected(alice), connected(bob)]);
    await bob.waitForFunction(() => window.__voice.peer('alice').chat?.readyState === 'open');
    await bob.fill('.v-chat-text', 'operator put us through');
    await bob.press('.v-chat-text', 'Enter');
    await alice.waitForSelector('.v-chatlog div:has-text("bob: operator put us through")');
    await op.waitForSelector('#roster td:has-text("in call with bob")', { state: 'attached' });
    step('operator connected alice and bob without ringing; chat works');

    // Reconnecting alice to carol drops her call with bob.
    await opConnect('alice', 'carol');
    await bob.waitForFunction(() => window.__voice.state === 'idle');
    await Promise.all([connected(alice), connected(carol)]);
    assert.deepEqual(await alice.evaluate(() => window.__voice.peerNames()), ['carol']);
    step('operator moved alice from bob to carol');

    // Alice and carol are talking; the operator brings bob into their call.
    await screen(op, 'intercom');
    await op.selectOption('#newcomer', id('bob'));
    await op.selectOption('#host', id('carol'));
    await op.click('#add-form button');
    await Promise.all([alice, bob, carol].map((page) => connected(page, 2)));
    assert.deepEqual(await bob.evaluate(() => window.__voice.peerNames()), ['alice', 'carol']);
    await bob.waitForTimeout(1500);
    for (const [who, page] of [['alice', alice], ['bob', bob], ['carol', carol]]) {
      const bytes = await audioBytes(page);
      assert.equal(Object.keys(bytes).length, 2);
      assert.ok(Object.values(bytes).every((b) => b > 0), `${who} is missing audio from someone: ${JSON.stringify(bytes)}`);
    }
    await op.waitForSelector('#roster tr:has(td:first-child:text-is("alice")) td:has-text("in call with")', { state: 'attached' });
    assert.match(await op.textContent('#roster tr:has(td:first-child:text-is("alice"))'), /carol.*bob|bob.*carol/);
    step('operator added bob into alice and carol\'s call; everyone hears everyone');

    await bob.waitForFunction(() => ['alice', 'carol'].every((n) => window.__voice.peer(n).chat?.readyState === 'open'));
    await bob.fill('.v-chat-text', 'hi both');
    await bob.press('.v-chat-text', 'Enter');
    await alice.waitForSelector('.v-chatlog div:has-text("bob: hi both")');
    await carol.waitForSelector('.v-chatlog div:has-text("bob: hi both")');
    await carol.setInputFiles('.v-file', { name: 'group.txt', mimeType: 'text/plain', buffer: Buffer.from('x'.repeat(40000)) });
    await carol.click('.v-file-form button');
    await alice.waitForSelector('.v-chatlog a[download="group.txt"]');
    await bob.waitForSelector('.v-chatlog a[download="group.txt"]');
    step('chat and files reach everyone in the three-way call');

    // Bob leaving a three-way call leaves the other two connected.
    await bob.click('.v-hangup');
    await alice.waitForSelector('.v-chatlog div:has-text("bob hung up")');
    await Promise.all([connected(alice), connected(carol)]);
    assert.equal(await stateOf(bob), 'idle');
    step('one person leaving a three-way call keeps the others connected');

    await screen(op, 'roster');
    await op.click('#roster tr:has(td:first-child:text-is("carol")) button.lcars-button--alert');
    await alice.waitForFunction(() => window.__voice.state === 'idle');
    await carol.waitForFunction(() => window.__voice.state === 'idle');
    await op.waitForFunction(() => window.__operator.roster.every((u) => u.state === 'idle'));
    step('operator ended the call');

    await opConnect('alice', 'alice');
    await op.waitForSelector('#status .error:has-text("two different crew members")', { state: 'attached' });
    step('operator cannot connect a user to themselves');

    // Crew can call ops; ops takes the call and transfers it aboard.
    await callFrom(alice, 'Operations');
    await op.waitForSelector('.v-incoming:not([hidden])');
    assert.match(await op.textContent('.v-incoming-from'), /alice \(Crew\)/);
    await op.click('.v-accept');
    await Promise.all([connected(alice), connected(op)]);
    await op.waitForSelector('#transfer-form:not([hidden])');
    step('crew called ops and ops answered');

    await op.selectOption('#transfer-to', id('bob'));
    await op.click('#transfer-form button');
    await Promise.all([connected(alice), connected(bob)]);
    assert.deepEqual(await alice.evaluate(() => window.__voice.peerNames()), ['bob']);
    await op.waitForFunction(() => window.__voice.state === 'idle');
    await op.waitForSelector('#ops-log li:has-text("transferred alice to bob")', { state: 'attached' });
    await closeComms(op);
    step('ops transferred alice to bob and dropped off the call');
    await bob.click('.v-hangup');
    await alice.waitForFunction(() => window.__voice.state === 'idle');

    // Ops places a call from the roster.
    await screen(op, 'roster');
    await op.click('#roster tr:has(td:first-child:text-is("carol")) button:has-text("Call")');
    await carol.waitForSelector('.v-incoming:not([hidden])');
    assert.match(await carol.textContent('.v-incoming-from'), /obrien \(Operations\)/);
    await carol.click('.v-accept');
    await Promise.all([connected(op), connected(carol)]);
    await openComms(op);
    await op.click('.v-hangup');
    await closeComms(op);
    await carol.waitForFunction(() => window.__voice.state === 'idle');
    step('ops called carol from the roster');

    // Station consoles: each post gets its own displays.
    assert.equal(await alice.locator('#st-msd .msd-canvas').count(), 1, 'crew console shows the master systems display');

    // Ship to ship: alice (Enterprise) reaches martok (K'Vatch) only through
    // both ships' operators.
    const kops = await openOps(browser, "K'Vatch", 'kvatch ops');
    const martok = await openAs(browser, 'martok', 'martok', "K'Vatch", 'Captain');
    const kor = await openAs(browser, 'kor', 'kor', "K'Vatch", 'Engineering');
    await martok.waitForFunction(() => window.__voice.myName === 'martok');
    await kops.waitForFunction(() => window.__operator.roster.length === 3 && window.__operator.ships.includes('Enterprise'));
    await op.waitForFunction(() => window.__operator.ships.includes("K'Vatch"));
    assert.equal(await op.evaluate(() => window.__operator.roster.some((u) => u.name === 'martok')), false, 'Enterprise ops sees K\'Vatch crew');
    assert.equal(await alice.locator('#users li:has-text("martok")').count(), 0, 'alice can see another ship\'s crew');
    await martok.waitForSelector('#users li:has-text("kor")', { state: 'attached' });
    assert.equal(await martok.locator('#st-tactical canvas').count(), 1, 'captain console has a tactical plot');
    // Department readiness counts who is at each station aboard: kor
    // (Engineering) and the K'Vatch's operator are on duty; Medical isn't.
    await martok.waitForSelector('#st-dept li[data-dept="Engineering"][data-manned]:has-text("1 on duty")', { state: 'attached' });
    await martok.waitForSelector('#st-dept li[data-dept="Operations"][data-manned]', { state: 'attached' });
    assert.match(await martok.textContent('#st-dept li[data-dept="Medical"]'), /Unmanned/);
    assert.equal(await martok.locator('#st-dept li[data-dept="Medical"][data-manned]').count(), 0);
    assert.equal(await kor.locator('#st-msd .msd-canvas').count(), 1, 'engineering console has the master systems display');
    step('each ship sees only its own crew; ops see the other ship; stations get their own displays');

    await screen(op, 'hail');
    await screen(kops, 'hail');
    await op.selectOption('#hail-ship', "K'Vatch");
    await op.selectOption('#hail-crew', id('alice'));
    await op.click('#hail-form button');
    await alice.waitForSelector('#notice:has-text("hailing the K\'Vatch")', { state: 'attached' });
    const hail = await kops.waitForSelector('#incoming li.ops-hail:has-text("Enterprise")');
    assert.match(await hail.textContent(), /alice \(Crew, Enterprise\)/);
    // Routing defaults to the captain.
    assert.equal(await hail.$eval('select', (s) => s.value), id('martok', "K'Vatch"));
    await hail.$eval('button', (b) => b.click()); // Route
    await Promise.all([connected(alice), connected(martok)]);
    await alice.waitForTimeout(1500);
    for (const [who, page] of [['alice', alice], ['martok', martok]]) {
      const bytes = await audioBytes(page);
      assert.ok(Object.values(bytes).every((b) => b > 0), `${who} received no audio`);
    }
    await martok.waitForFunction(() => window.__voice.peer('alice').chat?.readyState === 'open');
    await martok.fill('.v-chat-text', 'this is the captain of the Kvatch');
    await martok.press('.v-chat-text', 'Enter');
    await alice.waitForSelector('.v-chatlog div:has-text("martok: this is the captain")');
    await op.waitForSelector('#roster td:has-text("in call with martok (Captain, K\'Vatch)")', { state: 'attached' });
    await op.waitForSelector('#ops-log li:has-text("answered")', { state: 'attached' });
    await kops.waitForSelector('#roster td:has-text("in call with alice (Crew, Enterprise)")', { state: 'attached' });
    step('Enterprise ops hailed the K\'Vatch for alice; K\'Vatch ops routed it to the captain; they talk');

    // A declined hail tells the caller and the hailing ops station.
    await op.selectOption('#hail-crew', id('bob'));
    await op.click('#hail-form button');
    const hail2 = await kops.waitForSelector('#incoming li.ops-hail:has-text("bob")');
    await hail2.$eval('button.lcars-button--alert', (b) => b.click()); // Decline
    await bob.waitForSelector('#notice:has-text("did not answer")', { state: 'attached' });
    await op.waitForSelector('#ops-log li:has-text("declined the hail")', { state: 'attached' });
    await op.waitForFunction(() => window.__operator.outgoing.length === 0);
    step('declined hail reported to the caller and the hailing ship');

    // Cancelling from the hailing side clears it on the other ship.
    await op.click('#hail-form button');
    await kops.waitForFunction(() => window.__operator.incoming.length === 1);
    await op.click('#outgoing li.ops-hail button');
    await kops.waitForFunction(() => window.__operator.incoming.length === 0);
    await kops.waitForSelector('#ops-log li:has-text("cancelled their hail")', { state: 'attached' });
    step('cancelled hail cleared on the other ship');

    // Off-ship transfer: carol calls ops, ops transfers her to the K'Vatch,
    // K'Vatch ops takes the hail personally, then transfers her on to kor.
    await callFrom(carol, 'Operations');
    await op.waitForSelector('.v-incoming:not([hidden])');
    await op.click('.v-accept');
    await Promise.all([connected(op), connected(carol)]);
    await op.selectOption('#transfer-to', "ship:K'Vatch");
    await op.click('#transfer-form button');
    await op.waitForFunction(() => window.__voice.state === 'idle');
    await carol.waitForSelector('#notice:has-text("transferring you to the K\'Vatch")', { state: 'attached' });
    const hail3 = await kops.waitForSelector('#incoming li.ops-hail:has-text("carol")');
    await hail3.$eval('select', (sel) => { sel.value = [...sel.options].find((o) => o.text.startsWith('obrien')).value; });
    await hail3.$eval('button', (b) => b.click()); // Route to K'Vatch ops themselves
    await Promise.all([connected(carol), connected(kops)]);
    assert.equal(await carol.textContent('#notice'), '', 'stale transfer notice after the hail was routed');
    await kops.selectOption('#transfer-to', id('kor', "K'Vatch"));
    await kops.click('#transfer-form button');
    await Promise.all([connected(carol), connected(kor)]);
    assert.deepEqual(await carol.evaluate(() => window.__voice.peerNames()), ['kor']);
    await kops.waitForFunction(() => window.__voice.state === 'idle');
    step('ops transferred carol off ship; the other ship\'s ops took the hail and transferred her to kor');
    await kor.click('.v-hangup');
    await carol.waitForFunction(() => window.__voice.state === 'idle');

    // Data link: both operators agree, and then everyone on both ships sees
    // and can call everyone on the data network directly.
    await closeComms(op);
    await closeComms(kops);
    await screen(op, 'link');
    await screen(kops, 'link');
    await op.selectOption('#link-ship', "K'Vatch");
    await op.click('#link-form button');
    // The data network map: a pending request is a dashed line, then solid.
    await kops.waitForSelector('#net-map line[stroke-dasharray="10 8"]', { state: 'attached' });
    assert.equal(await kops.locator('#net-map .net-node').count(), 7); // Enterprise, K'Vatch, the Defiant (kept alive by its computer) and the four starbases
    await kops.click('#link-requests li:has-text("Enterprise") button:has-text("Accept")');
    await op.waitForFunction(() => window.__operator.network.includes("K'Vatch"));
    await op.waitForFunction(() => window.__operator.graph.links.some((l) => l.includes('Enterprise') && l.includes("K'Vatch")));
    await op.waitForSelector('#net-map line[stroke-dasharray="none"]', { state: 'attached' });
    await bob.waitForSelector('#users li:has-text("kor")', { state: 'attached' });
    await kor.waitForSelector('#users li:has-text("bob")', { state: 'attached' });
    assert.match(await bob.textContent('#comms-net'), /Enterprise.*K'Vatch/);
    await callFrom(bob, 'kor');
    await kor.waitForSelector('.v-incoming:not([hidden])');
    assert.match(await kor.textContent('.v-incoming-from'), /bob \(Crew, Enterprise\)/);
    await kor.click('.v-accept');
    await Promise.all([connected(bob), connected(kor)]);
    await bob.click('.v-hangup');
    await kor.waitForFunction(() => window.__voice.state === 'idle');
    step('ops opened a data link (shown on the data network map); bob called kor on the K\'Vatch directly');

    // Library: the Enterprise's computer goes offline, so its library is
    // offline (crew already aboard stay on).
    await stopComputer(coreA);
    await closeComms(alice);
    await screen(alice, 'library');
    await alice.waitForSelector('.lib-status:has-text("computer is offline")');
    assert.equal(await alice.isDisabled('.lib-upload button'), true);
    assert.equal(await alice.evaluate(() => window.__voice.me?.ship), 'Enterprise');
    assert.equal(await alice.evaluate(() => window.__voice.connectedTo(1)), true, 'the call with martok carries on');
    step("library: with the ship's computer offline, the library is offline and crew stay aboard");

    // Two computers run the Enterprise, one the K'Vatch. Alice uploads; the
    // file goes through the relay (not stored there) to one Enterprise
    // computer and is copied to the other; the K'Vatch (linked) downloads it.
    coreA = startComputer('a', 'Enterprise');
    let coreB = startComputer('b', 'Enterprise');
    await alice.waitForFunction(() => !document.querySelector('.lib-upload button').disabled);
    await kor.waitForSelector('.lib-folder[data-ship="K\'Vatch"] .lib-folder-name:not(:has-text("offline"))', { state: 'attached' });
    const briefing = 'Mission briefing: rendezvous with the K\'Vatch at stardate 48632.4\n'.repeat(200);
    await alice.setInputFiles('.lib-file', { name: 'mission briefing.txt', mimeType: 'text/plain', buffer: Buffer.from(briefing) });
    await alice.click('.lib-upload button');
    await alice.waitForSelector('.lib-status:has-text("Uploaded mission briefing.txt")');
    await waitFor(() => stored('a', 'Enterprise', 'mission briefing.txt') === briefing && stored('b', 'Enterprise', 'mission briefing.txt') === briefing);
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'data', 'Enterprise', 'mission briefing.txt')), false, 'the relay stored the file');
    await bob.waitForSelector('.lib-folder[data-ship="Enterprise"] li:has-text("mission briefing.txt")', { state: 'attached' });
    await kor.waitForSelector('.lib-folder[data-ship="Enterprise"] li:has-text("mission briefing.txt")', { state: 'attached' });
    assert.match(await kor.textContent('.lib-folder:first-child .lib-folder-name'), /K'Vatch/);
    await closeComms(kor);
    await screen(kor, 'library');
    const [download] = await Promise.all([
      kor.waitForEvent('download'),
      kor.click('.lib-folder[data-ship="Enterprise"] li:has-text("mission briefing.txt") button'),
    ]);
    assert.equal(download.suggestedFilename(), 'mission briefing.txt');
    assert.equal(fs.readFileSync(await download.path(), 'utf8'), briefing);
    step("library: alice's upload went to both Enterprise computers (not the relay); bob sees it; kor downloaded it over the data link");

    await op.click('#links li:has-text("K\'Vatch") button');
    await bob.waitForFunction(() => !window.__comms.users.some((u) => u.name === 'kor'));
    await kops.waitForFunction(() => window.__operator.network.length === 0);
    await kor.waitForFunction(() => !document.querySelector('.lib-folder[data-ship="Enterprise"]'));
    const status = await kor.evaluate(async () => (await fetch('/api/library/Enterprise/mission%20briefing.txt', { headers: { 'X-Token': window.__voice.token } })).status);
    assert.equal(status, 403, 'K\'Vatch can still read the Enterprise library after the link closed');
    step('closing the data link takes the other ship out of the directory and the library');

    // Library delete: ops only, own ship only.
    const del = (page) => page.evaluate(async () => (await fetch('/api/library/Enterprise/mission%20briefing.txt', { method: 'DELETE', headers: { 'X-Token': window.__voice.token } })).status);
    assert.equal(await bob.locator('.lib-folder button:has-text("Delete")').count(), 0, 'crew see a Delete button');
    assert.equal(await del(bob), 403, 'crew could delete a library file');
    assert.equal(await del(kops), 403, "another ship's ops could delete an Enterprise file");
    await closeComms(op);
    await screen(op, 'library');
    op.once('dialog', (d) => d.accept());
    await op.click('.lib-folder[data-ship="Enterprise"] li:has-text("mission briefing.txt") button:has-text("Delete")');
    await bob.waitForFunction(() => !document.querySelector('.lib-folder li.lib-file-row'));
    await waitFor(() => stored('a', 'Enterprise', 'mission briefing.txt') === null && stored('b', 'Enterprise', 'mission briefing.txt') === null);
    step('library: only ops can delete, and only from their own ship; both computers deleted it');

    // Computers catch up after being offline: B misses an upload and a
    // deletion, then comes back and gets the new file without reviving the
    // deleted one.
    await stopComputer(coreB);
    await alice.setInputFiles('.lib-file', { name: 'duty roster.txt', mimeType: 'text/plain', buffer: Buffer.from('Alpha shift: Riker') });
    await alice.click('.lib-upload button');
    await alice.waitForSelector('.lib-status:has-text("Uploaded duty roster.txt")');
    coreB = startComputer('b', 'Enterprise');
    await waitFor(() => stored('b', 'Enterprise', 'duty roster.txt') === 'Alpha shift: Riker');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(stored('b', 'Enterprise', 'mission briefing.txt'), null, 'a deleted file came back');
    assert.equal(stored('a', 'Enterprise', 'mission briefing.txt'), null, 'a deleted file came back');
    step('library: a computer that was offline catches up, and deletions stay deleted');

    // A ship's computer keeps a ship alive with nobody aboard.
    const voyager = startComputer('v', 'Voyager');
    const lobby2 = await (await browser.newContext()).newPage();
    await lobby2.goto(URL);
    await lobby2.waitForSelector('#ship option[value="Voyager"]', { state: 'attached' });
    await lobby2.close();
    await stopComputer(voyager);
    await op.waitForFunction(() => !window.__operator.graph.ships.some((s) => s.name === 'Voyager'));
    step("a ship's computer kept the Voyager alive with nobody aboard, until it stopped");

    // No ship's computer, no ship: the Voyager is no longer offered, to ops either.
    const lobby3 = await (await browser.newContext()).newPage();
    await lobby3.goto(URL);
    await lobby3.waitForSelector('#ship option[value="Enterprise"]', { state: 'attached' });
    assert.equal(await lobby3.locator('#ship option[value="Voyager"]').count(), 0);
    // No OPERATOR_KEY on this relay, so no authorization code field.
    await lobby3.selectOption('#station', 'Operations');
    assert.equal(await lobby3.isVisible('#key'), false, 'code field shown with no key required');
    assert.equal(await lobby3.locator('#ops-ship').count(), 0, 'ops still type a ship name');
    await lobby3.close();
    step("once its computer stopped the Voyager isn't offered to anyone, ops included; no code field without a key");

    // Changing station aboard the same ship.
    await closeComms(carol);
    await screen(carol, 'reassign');
    await carol.click('#station-taps button[data-station="Tactical"]');
    await carol.waitForFunction(() => window.__voice.me.station === 'Tactical');
    await op.waitForFunction(() => window.__operator.roster.find((u) => u.name === 'carol')?.station === 'Tactical');
    assert.equal(await carol.locator('[data-shield-control] button').count(), 1, 'tactical console has shield control');
    step('carol moved to Tactical; ops and the console follow');

    // Transporter: shields up blocks it; shields down lets wes beam to the K'Vatch.
    const chief = await openAs(browser, 'chief', 'chief', 'Enterprise', 'Transporter');
    const wes = await openAs(browser, 'wes', 'wes', 'Enterprise', 'Crew');
    await wes.waitForFunction(() => window.__voice.myName === 'wes');
    // From: this ship, a manned station (Crew), then who (one or more); To: a vessel, then a station.
    await chief.waitForSelector('#beam-from-station button[data-value="Crew"]', { state: 'attached' });
    await chief.$eval('#beam-from-station button[data-value="Crew"]', (b) => b.click());
    await chief.waitForSelector('#beam-who button[data-value="wes@enterprise"]', { state: 'attached' });
    await screen(carol, 'st-shieldctl');
    await carol.click('[data-shield-control] button');
    await chief.waitForFunction(() => document.body.hasAttribute('data-shields-up'));
    await op.waitForSelector('#shield-state:has-text("Up")', { state: 'attached' });
    await screen(chief, 'st-transporter');
    await chief.click(`#beam-who button[data-value="${id('wes')}"]`);
    // Out of reach, the K'Vatch is listed but greyed out, with the reason.
    await chief.waitForSelector('#beam-ship button[data-value="K\'Vatch"][disabled]:has-text("our shields up")');
    assert.equal(await chief.isDisabled('#beam-ship button[data-value="Starbase 47"]'), true, 'a far starbase is out of reach');
    assert.match(await chief.textContent('#beam-ship button[data-value="Starbase 47"]'), /out of range/);
    assert.equal(await wes.evaluate(() => window.__voice.me.ship), 'Enterprise');
    step("shields up: the transporter's destinations off the ship are greyed out (our shields up; far ones out of range)");

    await carol.click('[data-shield-control] button');
    await chief.waitForFunction(() => !document.body.hasAttribute('data-shields-up'));
    await chief.waitForSelector(`#beam-who button[data-value="${id('wes')}"][aria-pressed="true"]`);
    await chief.waitForSelector('#beam-status:has-text("No lock")');
    assert.equal(await chief.isDisabled('#beam-slider-1'), true, 'no lock: the sliders are dead');
    assert.equal(await chief.evaluate(() => window.__nav.last.own.power.transporter), 0, 'no lock, no power drawn');
    await chief.click('#beam-ship button[data-value="K\'Vatch"]');
    await chief.waitForSelector('#beam-ship button[data-value="K\'Vatch"][aria-pressed="true"]');
    await chief.waitForFunction(() => window.__nav.last.own.power.transporter === 50);
    step('the transporter locked onto the K\'Vatch: half power while it holds the lock, none before');
    await energize(chief);
    await chief.waitForSelector('#beam-status:has-text("Energizing")');
    await chief.waitForFunction(() => window.__nav.last.own.power.transporter === 100);
    assert.equal(await wes.evaluate(() => window.__voice.me?.ship), 'Enterprise', 'still aboard while it energizes');
    await wes.waitForFunction(() => window.__voice.me?.ship === "K'Vatch");
    await chief.waitForFunction(() => window.__nav.last.own.power.transporter === 50);
    await kops.waitForFunction(() => window.__operator.roster.some((u) => u.name === 'wes'));
    await op.waitForFunction(() => !window.__operator.roster.some((u) => u.name === 'wes'));
    await wes.waitForSelector('#users li:has-text("kor")', { state: 'attached' });
    assert.equal(await wes.evaluate(() => window.__voice.me.station), 'Crew');
    step('shields down: energizing drew 100% and wes arrived at the K\'Vatch at the end of it, keeping his station; back to 50% after');

    // Site to site, to a station: an ensign beamed to the Enterprise's Engineering console.
    const ensign = await (async () => { const sock = new (require('ws'))(`ws://localhost:${process.env.PORT}`); const msgs = []; sock.on('message', (m) => msgs.push(JSON.parse(m))); await new Promise((r) => sock.on('open', r)); sock.send(JSON.stringify({ type: 'register', name: 'ensign', ship: 'Enterprise', station: 'Crew' })); return { sock, msgs }; })();
    await chief.waitForSelector('#beam-from-station button[data-value="Crew"]', { state: 'attached' });
    await chief.click('#beam-from-station button[data-value="Crew"]');
    await chief.waitForSelector(`#beam-who button[data-value="${id('ensign')}"]`, { state: 'attached' });
    await chief.click(`#beam-who button[data-value="${id('ensign')}"]`);
    assert.equal(await chief.locator('#beam-who button[aria-pressed="true"]').count(), 1, 'only the ensign picked');
    await chief.click('#beam-ship button[data-value="Enterprise"]');
    await chief.click('#beam-station button[data-value="Engineering"]');
    await energize(chief);
    await waitFor(() => ensign.msgs.some((m) => m.type === 'registered' && m.station === 'Engineering' && m.ship === 'Enterprise'));
    ensign.sock.close();
    step("site to site: the transporter (taps, then three energize sliders) beamed an ensign to the Enterprise's Engineering console");

    // Signed in as Transporter (above); now move from Transporter to Helm.
    assert.equal(await chief.evaluate(() => window.__voice.me.station), 'Transporter');
    await closeComms(chief);
    await screen(chief, 'reassign');
    assert.equal(await chief.locator('#station-taps button[data-station="Helm"]').count(), 1);
    await chief.click('#station-taps button[data-station="Helm"]');
    await chief.waitForFunction(() => window.__voice.me.station === 'Helm');
    assert.equal(await chief.locator('#st-view canvas').count(), 1, 'helm console after changing station');
    assert.equal(await chief.locator('[data-transporter]').count(), 0);
    await op.waitForFunction(() => window.__operator.roster.find((u) => u.name === 'chief')?.station === 'Helm');
    step('signed in as Transporter, then changed station to Helm');

    // Moving to Operations: chief becomes a second Enterprise operator, and
    // either operator can manage data links.
    await screen(chief, 'reassign');
    await chief.click('#station-taps button[data-station="Operations"]');
    await chief.waitForSelector('[data-screen="status"]:not([hidden])');
    await op.waitForFunction(() => window.__operator.roster.find((u) => u.name === 'chief')?.station === 'Operations');
    await screen(chief, 'link');
    await chief.selectOption('#link-ship', "K'Vatch");
    await chief.click('#link-form button');
    await op.waitForSelector('#link-requests li:has-text("Requesting a data link with the K\'Vatch")', { state: 'attached' });
    await screen(kops, 'link');
    await kops.click('#link-requests li:has-text("Enterprise") button:has-text("Accept")');
    await chief.waitForFunction(() => window.__operator.network.includes("K'Vatch"));
    await screen(op, 'link');
    await op.click('#links li:has-text("K\'Vatch") button'); // the other operator closes it
    await chief.waitForFunction(() => window.__operator.network.length === 0);
    step('chief moved to Operations; two operators on duty, either one manages data links');

    // And back from Operations to a crew station.
    await screen(chief, 'reassign');
    assert.equal(await chief.isDisabled('#station-taps button[data-station="Operations"]'), true, 'the station you are at is greyed out');
    await chief.click('#station-taps button[data-station="Crew"]');
    await chief.waitForFunction(() => window.__voice.me.station === 'Crew' && !window.__operator.roster);
    assert.equal(await chief.locator('.ops-tab:not([hidden])').count(), 0);
    await op.waitForFunction(() => window.__operator.roster.find((u) => u.name === 'chief')?.station === 'Crew');
    step('chief left Operations for Crew; the Enterprise still has ops on duty');

    // Communications sees the calls going on without joining them.
    const uhura = await openAs(browser, 'uhura', 'uhura', 'Enterprise', 'Communications');
    // The routed hail is a radio call: ship to ship, our own crew named, theirs not.
    await uhura.waitForSelector('[data-traffic] li:has-text("Enterprise"):has-text("K\'Vatch"):has-text("radio"):has-text("alice")', { state: 'attached' });
    assert.doesNotMatch(await uhura.textContent('[data-traffic]'), /martok/, "another ship's crew aren't named");
    assert.match(await uhura.textContent('[data-traffic]'), /Open/);
    assert.deepEqual(await alice.evaluate(() => window.__voice.peerNames()), ['martok'], 'Communications joined the call');
    assert.equal(await uhura.evaluate(() => window.__voice.state), 'idle');
    await uhura.close();
    step("Communications sees alice's radio call with the K'Vatch in comm traffic (ship to ship, martok not named) without joining it");
    for (const page of [chief, wes]) await page.close();

    // Pages hosted elsewhere (GitHub Pages) can use this server as their relay.
    const pre = await fetch(`${URL}api/library`, { method: 'OPTIONS', headers: { Origin: 'https://whiskeyfur.github.io', 'Access-Control-Request-Headers': 'x-token,x-filename' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-headers'), /X-Token/i);
    step('library endpoints allow cross-origin use for pages hosted elsewhere');

    // The K'Vatch's ops station drops out mid-call: alice and martok carry on,
    // no new hail to the K'Vatch can start, but the K'Vatch's computer keeps
    // the data link up.
    await screen(op, 'link');
    await screen(kops, 'link');
    await op.selectOption('#link-ship', "K'Vatch");
    await op.click('#link-form button');
    await kops.click('#link-requests li:has-text("Enterprise") button:has-text("Accept")');
    await bob.waitForSelector('#users li:has-text("kor")', { state: 'attached' });
    await kops.close();
    await closeComms(op);
    await martok.waitForSelector('#ops-status:has-text("Ops offline")', { state: 'attached' });
    await op.waitForFunction(() => !window.__operator.ships.includes("K'Vatch"));
    await alice.waitForTimeout(1000);
    assert.equal(await alice.evaluate(() => window.__voice.connectedTo(1)), true);
    await openComms(alice);
    await alice.fill('.v-chat-text', 'still with you');
    await alice.press('.v-chat-text', 'Enter');
    await martok.waitForSelector('.v-chatlog div:has-text("alice: still with you")');
    assert.equal(await op.locator('#hail-ship option[value="K\'Vatch"]').count(), 0, 'Enterprise ops can still hail the K\'Vatch with no ops aboard');
    await op.waitForTimeout(300);
    assert.deepEqual(await op.evaluate(() => window.__operator.network), ["K'Vatch"], "the K'Vatch's computer didn't keep the link");
    assert.equal(await bob.evaluate(() => window.__comms.users.some((u) => u.name === 'kor')), true);
    step("ops drops out: the call carries on, new hails are refused, and the K'Vatch's computer keeps the data link up");

    // With neither ops nor a ship's computer, the link closes.
    await stopComputer(coreK);
    await op.waitForFunction(() => window.__operator.network.length === 0);
    await bob.waitForFunction(() => !window.__comms.users.some((u) => u.name === 'kor'));
    step("the K'Vatch's computer goes offline too: with neither ops nor a computer, the data link closes");

    // The call can still finish, and K'Vatch crew can still call each other.
    await martok.click('.v-hangup');
    await alice.waitForFunction(() => window.__voice.state === 'idle');
    await callFrom(martok, 'kor');
    await kor.waitForSelector('.v-incoming:not([hidden])');
    await kor.click('.v-accept');
    await Promise.all([martok, kor].map((page) => page.waitForFunction(() => window.__voice.connectedTo(1), null, { timeout: 20000 })));
    step('without ops, the call finishes normally and shipmates can still call each other');

    for (const page of [kor, martok]) await page.close();

    // Comm traffic shows a hail while it waits for the other ship's ops.
    const dops = await openOps(browser, 'Defiant', 'defiant ops 2', 'dax');
    const nog = await openAs(browser, 'nog', 'nog', 'Defiant', 'Crew');
    const uhura2 = await openAs(browser, 'uhura', 'uhura2', 'Enterprise', 'Communications');
    await uhura2.waitForFunction(() => window.__voice.myName === 'uhura');
    await closeComms(op);
    await screen(op, 'hail');
    await op.waitForFunction(() => window.__operator.ships.includes('Defiant'));
    await op.selectOption('#hail-ship', 'Defiant');
    await op.selectOption('#hail-crew', id('bob'));
    await op.click('#hail-form button');
    await uhura2.waitForSelector('[data-traffic] li:has-text("Hailing"):has-text("bob")', { state: 'attached' });
    await screen(dops, 'hail');
    const hail4 = await dops.waitForSelector('#incoming li.ops-hail:has-text("bob")');
    await hail4.$eval('button.lcars-button--alert', (b) => b.click()); // Decline
    await uhura2.waitForFunction(() => !document.querySelector('[data-traffic]').textContent.includes('Hailing'));
    step('Communications sees a hail in comm traffic before it is answered');

    // All hands aboard: alice speaks, everyone aboard hears, nobody sends back.
    await screen(op, 'intercom');
    await op.selectOption('#ah-speaker', id('alice'));
    await op.selectOption('#ah-scope', 'ship');
    await op.click('#allhands-form button');
    await alice.waitForFunction(() => window.__broadcast.speaking?.listeners >= 4); // bob, carol, ops, uhura
    for (const page of [bob, uhura2]) await page.waitForFunction(() => window.__broadcast.listening[0]?.connected, null, { timeout: 20000 });
    await bob.waitForTimeout(1500);
    const heard = await bob.evaluate(async () => {
      const pc = window.__broadcast.listening[0].pc;
      let bytes = 0;
      (await pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') bytes += r.bytesReceived; });
      const t = pc.getTransceivers()[0];
      return { bytes, direction: t.currentDirection, sending: !!t.sender.track };
    });
    assert.ok(heard.bytes > 0, 'bob did not hear the broadcast');
    assert.equal(heard.direction, 'recvonly', 'listeners must not send');
    assert.equal(heard.sending, false);
    assert.equal(await nog.evaluate(() => window.__broadcast.listening.length), 0, 'the Defiant heard an Enterprise-only broadcast');
    await bob.waitForSelector('.bcast--listening:has-text("alice")');
    await uhura2.waitForSelector('[data-traffic] li:has-text("All hands"):has-text("alice")', { state: 'attached' });
    await alice.click('.bcast--speaking button'); // End broadcast
    await bob.waitForFunction(() => window.__broadcast.listening.length === 0);
    step('all hands: ops opened a one-way broadcast for alice to the whole ship; bob heard it and sent nothing back');

    // All hands to the fleet (data network), ended by ops.
    await screen(op, 'link');
    await op.selectOption('#link-ship', 'Defiant');
    await op.click('#link-form button');
    await screen(dops, 'link');
    await dops.click('#link-requests li:has-text("Enterprise") button:has-text("Accept")');
    await op.waitForFunction(() => window.__operator.network.includes('Defiant'));
    await screen(op, 'intercom');
    await op.selectOption('#ah-speaker', id('carol'));
    await op.selectOption('#ah-scope', 'network');
    await op.click('#allhands-form button');
    await nog.waitForFunction(() => window.__broadcast.listening[0]?.connected, null, { timeout: 20000 });
    await nog.waitForSelector('.bcast--listening:has-text("carol"):has-text("Enterprise")');
    await op.click('#broadcasts li button'); // ops ends it
    await nog.waitForFunction(() => window.__broadcast.listening.length === 0);
    step('all hands to the fleet: carol was heard aboard the Defiant over the data link; ops ended it');

    // The ship's radio: Communications puts a station on the fleet's radio.
    assert.equal(await bob.isVisible('#radio-fleet'), false, 'crew can set the ship radio');
    await openComms(uhura2);
    await uhura2.fill('#radio-url', `http://localhost:${RADIO_PORT}/cors/tone.wav`);
    await uhura2.click('#radio-tune');
    await uhura2.waitForSelector('#radio-fleet:visible');
    await uhura2.click('#radio-fleet');
    for (const page of [bob, nog]) await page.waitForFunction(() => window.__broadcast.shipRadio?.playing, null, { timeout: 15000 });
    await bob.waitForSelector('.bcast--radio:has-text("uhura")');
    await uhura2.click('#radio-off');
    await bob.waitForFunction(() => !window.__broadcast.shipRadio);
    step("ship's radio: Communications put a station on every console in the fleet, then switched it off");

    // Communications runs data links too: uhura closes the link with the
    // Defiant, then asks for it again; the Defiant's ops accept.
    await closeComms(uhura2);
    await screen(uhura2, 'st-links');
    await uhura2.click('#links-open li[data-ship="Defiant"] button');
    await op.waitForFunction(() => !window.__operator.network.includes('Defiant'));
    await uhura2.click('#links-request button[data-ship="Defiant"]');
    await screen(dops, 'link');
    await dops.click('#link-requests li:has-text("Enterprise") button:has-text("Accept")');
    await op.waitForFunction(() => window.__operator.network.includes('Defiant'));
    await uhura2.waitForSelector('#links-open li[data-ship="Defiant"]', { state: 'attached' });
    step("Communications closed the data link with the Defiant and asked for it again; the Defiant's ops accepted");

    // Navigation: Science scans and plots; Helm flies. Distance matters.
    const WebSocket = require('ws');
    const sulu = new WebSocket(`ws://localhost:${process.env.PORT}`);
    const suluMsgs = [];
    sulu.on('message', (m) => { try { suluMsgs.push(JSON.parse(m)); } catch {} });
    await new Promise((r) => sulu.on('open', r));
    sulu.send(JSON.stringify({ type: 'register', name: 'sulu', ship: 'Enterprise', station: 'Helm' }));
    const helm = (order) => sulu.send(JSON.stringify({ type: 'helm', ...order }));
    // A transporter chief, beaming themself, to check transporter range.
    const rand = new WebSocket(`ws://localhost:${process.env.PORT}`);
    const randMsgs = [];
    rand.on('message', (m) => { try { randMsgs.push(JSON.parse(m)); } catch {} });
    await new Promise((r) => rand.on('open', r));
    rand.send(JSON.stringify({ type: 'register', name: 'rand', ship: 'Enterprise', station: 'Transporter' }));
    const beamSelf = () => { rand.send(JSON.stringify({ type: 'transporter-lock', ship: 'Defiant' })); rand.send(JSON.stringify({ type: 'beam', who: id('rand'), ship: 'Defiant' })); };
    const spock = await openAs(browser, 'spock', 'spock', 'Enterprise', 'Science');
    await spock.waitForSelector('.nav-contacts li[data-ship="Defiant"]', { state: 'attached' });
    await spock.click('.nav-contacts li[data-ship="Defiant"] button:has-text("Scan")');
    await spock.waitForSelector('.nav-scan:has-text("Scan: the Defiant")');
    assert.match(await spock.textContent('.nav-scan'), /Distance\s*10 units \(transporter range\)/);
    assert.match(await spock.textContent('.nav-scan'), /Ops\s*On duty/);
    assert.match(await spock.textContent('.nav-scan'), /Shields\s*Down(?!\s*·)/); // not "Down · 100%"
    // Lifeforms by name and species ("unknown" without a profile); shields down, their exact locations too.
    assert.match(await spock.textContent('.nav-scan'), /Locations\s*Shields down: locations resolved/);
    assert.match(await spock.textContent('.nav-scan-lifeforms'), /· unknown · [A-Za-z ]+, the Defiant/);
    await spock.click('.nav-contacts li[data-ship="Defiant"] button:has-text("Plot course")');
    await waitFor(() => suluMsgs.some((m) => m.type === 'course-plotted' && m.label === 'the Defiant'));
    step('Science scanned the Defiant (distance, ops, life signs by name and species, their locations with shields down) and plotted a course for Helm');

    // Helm takes the Enterprise out of radio range: the Defiant is no longer in
    // range to hail, but the data link holds (subspace reaches the whole system).
    helm({ dest: { x: 950, y: 950 }, warp: 7 }); // default engine power (80%) gives warp 7.2 at most
    // At warp the Bussard collectors draw and gather deuterium (at rest they draw nothing).
    await spock.waitForFunction(() => window.__nav.last.own.warp >= 1 && window.__nav.last.own.power.bussard > 0);
    await op.waitForFunction(() => !window.__operator.ships.includes('Defiant'), null, { timeout: 20000 });
    assert.ok(await op.evaluate(() => window.__operator.network.includes('Defiant')), 'the data link dropped out of radio range');
    assert.ok(await op.evaluate(() => window.__operator.linkShips.includes('Starbase 74')), 'a far starbase should be in data link reach (the whole system)');
    assert.ok((await spock.evaluate(() => window.__nav.last.own.warp)) > 0 || (await spock.evaluate(() => window.__nav.last.own.x)) > 800);
    beamSelf();
    await waitFor(() => randMsgs.some((m) => m.type === 'notice' && /out of transporter range/.test(m.text)));
    step('Helm flew the Enterprise out of radio range at warp 7: the Defiant left hailing range and beaming over is out of range, but the data link held (subspace reaches the whole system)');
    // A subspace relay down drops the link; back up, a new one opens across the system.
    const kyle = new WebSocket(`ws://localhost:${process.env.PORT}`);
    await new Promise((r) => kyle.on('open', r));
    kyle.send(JSON.stringify({ type: 'register', name: 'kyle', ship: 'Enterprise', station: 'Engineering' }));
    await new Promise((r) => setTimeout(r, 300));
    kyle.send(JSON.stringify({ type: 'grid', ties: { 'sub:subspace': [] } }));
    await op.waitForFunction(() => !window.__operator.network.includes('Defiant'), null, { timeout: 15000 });
    await op.waitForSelector('#ops-log li:has-text("a subspace relay is down")', { state: 'attached' });
    await op.waitForFunction(() => !window.__operator.linkShips.includes('Defiant'));
    kyle.send(JSON.stringify({ type: 'grid', ties: { 'sub:subspace': ['B'] } }));
    await op.waitForFunction(() => window.__operator.linkShips.includes('Defiant'), null, { timeout: 15000 });
    await screen(op, 'link');
    await op.selectOption('#link-ship', 'Defiant');
    await op.click('#link-form button');
    await screen(dops, 'link');
    await dops.click('#link-requests li:has-text("Enterprise") button:has-text("Accept")');
    await op.waitForFunction(() => window.__operator.network.includes('Defiant'));
    kyle.close();
    step('with the Enterprise\'s subspace relay untied the data link dropped; tied again, a new link opened with the far-off Defiant');

    // And back: intercept the Defiant, arriving within transporter range.
    // (Far off, the Defiant may be off our sensors: head for where it is, then intercept.)
    const dpos = await nog.evaluate(() => window.__nav.last.own);
    helm({ dest: { x: dpos.x, y: dpos.y + 30 }, warp: 7 });
    await waitFor(async () => (await spock.evaluate(() => window.__nav.last?.own.warp === 0 && window.__nav.last.ships.some((s) => s.name === 'Defiant'))), 30000).catch(async () => { throw new Error(`no Defiant on sensors: ${JSON.stringify(await spock.evaluate(() => ({ own: [window.__nav.last?.own.x, window.__nav.last?.own.y, window.__nav.last?.own.warp], ships: window.__nav.last?.ships.map((x) => [x.name, x.distance]), ranges: window.__nav.last?.ranges })))} sulu: ${JSON.stringify(suluMsgs.filter((m) => m.type === 'notice').slice(-3))} defiant: ${JSON.stringify(dpos && [dpos.x, dpos.y])} now ${JSON.stringify(await nog.evaluate(() => [window.__nav.last.own.x, window.__nav.last.own.y, window.__nav.last.own.signature]))}`); })
    helm({ dest: { ship: 'Defiant' }, warp: 7 });
    await waitFor(async () => { const n = await spock.evaluate(() => window.__nav.last); const d = n?.ships.find((s) => s.name === 'Defiant'); return n?.own.warp === 0 && d && d.distance <= 20; }, 30000).catch(async () => { throw new Error(`intercept failed: sulu ${JSON.stringify(suluMsgs.filter((m) => m.type === "notice").slice(-4).map((m) => m.text))}`); });
    await op.waitForFunction(() => window.__operator.ships.includes('Defiant'));
    beamSelf();
    await waitFor(() => randMsgs.some((m) => m.type === 'registered' && m.ship === 'Defiant'));
    step('Helm intercepted the Defiant: back in hailing range, and the transporter beamed across');
    // Engineering routes power, and every station feels it.
    const scotty = await openAs(browser, 'scotty', 'scotty', 'Enterprise', 'Engineering');
    await screen(scotty, 'st-power');
    await scotty.waitForSelector('[data-system="sensors"] button');
    const route = async (levels) => {
      for (const [k, v] of Object.entries(levels)) {
        // Light bar: press the segment for the level; 0 is the top lit segment pressed again.
        const now = Number((await scotty.textContent(`[data-system="${k}"] + .pw-value`)).split('/').pop().replace('%', '')); // "in use/limit%"
        if (v === 0) { if (now) await scotty.click(`[data-system="${k}"] button[data-level="${Math.ceil(now / 10)}"]`); }
        else if (now !== v) await scotty.click(`[data-system="${k}"] button[data-level="${v / 10}"]`);
      }
      await scotty.click('#power-apply');
    };
    // The sliders set demand, shown per bus before it's routed.
    await scotty.click('[data-system="engines"] button[data-level="10"]');
    assert.equal(await scotty.locator('[data-system="engines"] button[data-allowed]').count(), 10); // limit 100: ten of fifteen
    assert.equal(await scotty.locator('[data-system="engines"] button[data-overdrive]').count(), 5);
    assert.match(await scotty.textContent('.pw-total'), /EPS 619 .*not routed yet/);
    await scotty.click('#power-reset');
    // Sensors at 20%: every range drops to a fifth, so the transporter (4 units) can't reach.
    await route({ sensors: 20, lateral: 20 });
    await spock.waitForFunction(() => Math.round(window.__nav.last.ranges.transporter) === 4 && Math.round(window.__nav.last.ranges.comms) === 80);
    const odell = new WebSocket(`ws://localhost:${process.env.PORT}`);
    const odellMsgs = [];
    odell.on('message', (m) => { try { odellMsgs.push(JSON.parse(m)); } catch {} });
    await new Promise((r) => odell.on('open', r));
    odell.send(JSON.stringify({ type: 'register', name: 'odell', ship: 'Enterprise', station: 'Transporter' }));
    await new Promise((r) => setTimeout(r, 300));
    odell.send(JSON.stringify({ type: 'transporter-lock', ship: 'Defiant' }));
    await waitFor(() => odellMsgs.some((m) => m.type === 'notice' && /out of transporter range/.test(m.text) && /within 4/.test(m.text)));
    step('Engineering cut sensors to 20%: sensor, subspace and transporter range all fell to a fifth, and beaming fell short');
    // Overdrive: sensors past their rating reach further but wear out.
    await route({ sensors: 120 }); // (150 would overload Bus A and trip its breaker)
    await spock.waitForFunction(() => Math.round(window.__nav.last.ranges.sensors) > 600 && window.__nav.last.own.combat.damage.sensors > 0, null, { timeout: 15000 });
    step(`sensors overdriven to 120%: range ${Math.round(await spock.evaluate(() => window.__nav.last.ranges.sensors))} (past 600), and the overdrive damaged them`);

    // No engine power: no warp. No shield power: Tactical can't raise shields. Low life support: everyone is warned.
    await route({ sensors: 100, lateral: 100, engines: 0, shields: 0, atmosphere: 40 });
    await waitFor(async () => (await spock.evaluate(() => window.__nav.last.speed.warp)) === 0);
    helm({ dest: { ship: 'Defiant' }, warp: 5 });
    await waitFor(() => suluMsgs.some((m) => m.type === 'notice' && /no power to the engines/.test(m.text)));
    await closeComms(carol);
    await screen(carol, 'st-shieldctl');
    await carol.waitForSelector('[data-shield-control] button:has-text("Raise shields"):disabled');
    await bob.waitForSelector('.bcast--alert:has-text("Life support at 40%")', { state: 'attached' });
    step('no engine power refused warp, no shield power disabled Raise shields, and low life support warned the crew');
    await route({ engines: 80, shields: 60, atmosphere: 100 });
    await bob.waitForFunction(() => !document.querySelector('.bcast--alert'));
    odell.close();
    await scotty.close();

    // Phase 3. Security: the force field refuses a beam-in; once it's down,
    // Security is alerted when someone beams aboard.
    const worf = await openAs(browser, 'worf', 'worf', 'Enterprise', 'Security');
    await worf.waitForFunction(() => window.__voice.myName === 'worf');
    await screen(worf, 'st-secctl');
    await worf.click('[data-security] button:has-text("Raise force field")');
    await worf.waitForSelector('[data-security] .st-state:has-text("force field up")');
    const randBeams = () => { rand.send(JSON.stringify({ type: 'transporter-lock', ship: 'Enterprise' })); rand.send(JSON.stringify({ type: 'beam', who: id('rand', 'Defiant'), ship: 'Enterprise' })); };
    randBeams();
    await waitFor(() => randMsgs.some((m) => m.type === 'notice' && /transporter lockout/.test(m.text)));
    await worf.click('[data-security] button:has-text("Drop force field")');
    await worf.waitForSelector('[data-security] .st-state:has-text("lockout: off")');
    randBeams();
    await worf.waitForSelector('#sec-alerts li:has-text("rand (Transporter) beamed aboard from the Defiant")');
    await worf.waitForSelector('.bcast--alert:has-text("Security: rand")', { state: 'attached' });
    step('Security: the force field refused a beam-in; with it down, Security was alerted when rand beamed aboard');

    // Security isolates Helm with a force field: nobody walks in or out, but
    // Helm keeps its console.
    await worf.click('#sec-fields button[data-station="Helm"]');
    await worf.waitForSelector('#sec-fields button[data-station="Helm"][aria-pressed="true"]');
    sulu.send(JSON.stringify({ type: 'change-station', station: 'Crew' }));
    await waitFor(() => suluMsgs.some((m) => m.type === 'station-failed' && /force field isolates Helm: nobody walks out/.test(m.reason)));
    rand.send(JSON.stringify({ type: 'change-station', station: 'Helm' }));
    await waitFor(() => randMsgs.some((m) => m.type === 'station-failed' && /force field isolates Helm: nobody walks in/.test(m.reason)));
    helm({ warp: 0 });
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!suluMsgs.some((m) => m.type === 'notice' && /console/.test(m.text) && /sealed|offline/.test(m.text)), 'Helm keeps its console inside the field');
    await worf.click('#sec-fields button[data-station="Helm"]');
    await worf.waitForSelector('#sec-fields button[data-station="Helm"][aria-pressed="false"]');
    step('Security isolated Helm with a force field: Helm could not walk out nor anyone walk in, but kept the console; then dropped it');

    // Security confines alice to quarters: she can call Security, not the First Officer.
    const riker = await openAs(browser, 'riker', 'riker', 'Enterprise', 'First Officer');
    await riker.waitForFunction(() => window.__voice.myName === 'riker');
    await worf.waitForSelector('#sec-who option[value="alice@enterprise"]', { state: 'attached' });
    await worf.selectOption('#sec-who', id('alice'));
    await worf.click('[data-security] button:has-text("Confine")');
    await alice.waitForFunction(() => window.__voice.me && window.__comms.users.find((u) => u.name === 'alice')?.confined);
    await callFrom(alice, 'riker');
    await alice.waitForFunction(() => window.__voice.state === 'idle');
    assert.match(await alice.textContent('#log'), /confined to quarters/);
    await callFrom(alice, 'worf');
    await worf.waitForSelector('.v-incoming:not([hidden])');
    await worf.click('.v-decline');
    await alice.waitForFunction(() => window.__voice.state === 'idle');
    await closeComms(worf);
    await worf.selectOption('#sec-who', id('alice'));
    await worf.click('[data-security] button:has-text("Release")');
    await alice.waitForFunction(() => !window.__comms.users.find((u) => u.name === 'alice')?.confined);
    step('Security confined alice to quarters: she could call Security but not the First Officer; then released her');

    // First Officer reassigns bob to Medical; Medical admits carol to sickbay,
    // and Tactical shows unmanned on the Captain's readiness.
    await screen(riker, 'st-assign');
    await riker.selectOption('#xo-who', id('bob'));
    await riker.selectOption('#xo-station', 'Medical');
    await riker.click('[data-reassign] button:has-text("Reassign")');
    // Sent as an order: bob moves when he acknowledges it.
    await bob.waitForSelector('.bcast--order:has-text("Report to Medical")', { state: 'attached' });
    assert.notEqual(await bob.evaluate(() => window.__voice.me.station), 'Medical', 'reassigned before acknowledging');
    await riker.waitForSelector('[data-reassign] .order-tally li:has-text("bob: report to Medical"):has-text("waiting for bob")', { state: 'attached' });
    await bob.$eval('.bcast--order', (p) => [...p.querySelectorAll('button')].find((b) => b.textContent === 'Acknowledge').click());
    await bob.waitForFunction(() => window.__voice.me.station === 'Medical');
    const picard = await openAs(browser, 'picard', 'picard', 'Enterprise', 'Captain');
    await picard.waitForSelector('#st-dept li[data-dept="Tactical"][data-manned]', { state: 'attached' });
    await closeComms(bob);
    await screen(bob, 'st-sickbay');
    await bob.click('.st-patients li[data-crew="carol@enterprise"] button:has-text("Admit")');
    await picard.waitForSelector('#st-dept li[data-dept="Tactical"]:not([data-manned])', { state: 'attached' });
    await bob.click('.st-patients li[data-crew="carol@enterprise"] button:has-text("Discharge")');
    await picard.waitForSelector('#st-dept li[data-dept="Tactical"][data-manned]', { state: 'attached' });
    step('the First Officer ordered bob to Medical (he moved on acknowledging); carol in sickbay left Tactical unmanned until discharged');

    // The Captain: orders to every console, red alert (shields up, frames red), then green.
    await screen(picard, 'st-command');
    await picard.fill('#order-text', 'All hands, prepare for first contact');
    await picard.click('#order-send');
    await bob.waitForSelector('.bcast--order:has-text("prepare for first contact")', { state: 'attached' });
    assert.equal(await picard.locator('.bcast--order').count(), 0, 'the Captain is not asked to acknowledge his own order');
    await bob.click('.bcast--order:has-text("prepare for first contact") button');
    await picard.waitForSelector('.order-tally li:has-text("prepare for first contact"):has-text("acknowledged")', { state: 'attached' });
    assert.doesNotMatch(await picard.textContent('.order-tally li'), /waiting for [^·]*\bpicard\b/);
    // The First Officer's orders: neither the First Officer nor the Captain is asked.
    await screen(riker, 'st-orders');
    await riker.fill('#order-text', 'Drill on deck 8');
    await riker.click('#order-send');
    await bob.waitForSelector('.bcast--order:has-text("Drill on deck 8")', { state: 'attached' });
    await riker.waitForSelector('.order-tally li:has-text("Drill on deck 8")', { state: 'attached' });
    assert.equal(await riker.locator('.bcast--order:has-text("Drill on deck 8")').count(), 0);
    assert.equal(await picard.locator('.bcast--order:has-text("Drill on deck 8")').count(), 0);
    assert.doesNotMatch(await riker.textContent('.order-tally li'), /picard|riker/);
    await bob.click('.bcast--order:has-text("Drill on deck 8") button');
    step("orders: the Captain and the First Officer aren't asked to acknowledge their own (nor the Captain the First Officer's); bob's acknowledgement showed in the tally");
    await picard.click('#alert-buttons button[data-level="red"]');
    await bob.waitForFunction(() => document.body.dataset.alert === 'red');
    await carol.waitForSelector('[data-shield-control] .st-state:has-text("Shields up")', { state: 'attached' });
    await picard.click('#alert-buttons button[data-level="green"]');
    await bob.waitForFunction(() => document.body.dataset.alert === 'green');
    await carol.click('[data-shield-control] button:has-text("Lower shields")');
    await carol.waitForSelector('[data-shield-control] .st-state:has-text("Shields down")', { state: 'attached' });
    step("the Captain's orders reached every console; red alert raised shields and turned consoles red, then condition green");

    // Tactical combat: carol (Enterprise) locks on the Defiant, whose Tactical is warned.
    const crewWs = async (name, ship, station) => {
      const sock = new WebSocket(`ws://localhost:${process.env.PORT}`);
      const msgs = [];
      sock.on('message', (m) => { try { msgs.push(JSON.parse(m)); } catch {} });
      await new Promise((r) => sock.on('open', r));
      sock.send(JSON.stringify({ type: 'register', name, ship, station }));
      await waitFor(() => msgs.some((m) => m.type === 'registered' || m.type === 'register-failed'));
      const refused = msgs.find((m) => m.type === 'register-failed');
      if (refused) throw new Error(`${name} could not report aboard the ${ship}: ${refused.reason}`);
      return { msgs, send: (m) => sock.send(JSON.stringify(m)), close: () => sock.close(), nav: () => [...msgs].reverse().find((m) => m.type === 'nav') };
    };
    // Beaming people aboard from another vessel: From lists the Defiant (Science can place its
    // people: its shields are down), its manned stations and who's there; two beam over at once.
    {
      const lwaxana = await crewWs('lwaxana', 'Defiant', 'Crew');
      const barclay2 = await crewWs('reg', 'Defiant', 'Crew');
      const chief2 = await crewWs('chief2', 'Enterprise', 'Transporter');
      await waitFor(() => chief2.nav()?.own.transporter.from?.find((v) => v.ship === 'Defiant')?.stations.find((x) => x.station === 'Crew')?.people.length >= 2);
      chief2.send({ type: 'transporter-lock', ship: 'Enterprise' });
      await waitFor(() => chief2.nav()?.own.transporter.lock === 'Enterprise');
      chief2.send({ type: 'beam', who: [id('lwaxana', 'Defiant'), id('reg', 'Defiant')], station: 'Transporter' });
      await waitFor(() => [lwaxana, barclay2].every((w) => w.msgs.some((m) => m.type === 'registered' && m.ship === 'Enterprise' && m.station === 'Transporter')), 15000);
      lwaxana.close(); barclay2.close();
      chief2.send({ type: 'transporter-lock', ship: null });
      chief2.close();
      step('the Enterprise\'s transporter beamed two people aboard from the Defiant\'s Crew quarters (placed: its shields down) to its transporter room, in one go');
    }
    const kira = await crewWs('kira', 'Defiant', 'Tactical');
    const obrien = await crewWs('obrien', 'Defiant', 'Engineering');
    await screen(carol, 'st-weapons');
    await carol.waitForSelector('#weapons-target option[value="Defiant"]', { state: 'attached' });
    await carol.selectOption('#weapons-target', 'Defiant');
    await carol.click('#weapons-lock');
    await carol.waitForSelector('#weapons-lock-state:has-text("Locked on the Defiant")');
    await waitFor(() => kira.msgs.some((m) => m.type === 'notice' && /the Enterprise has locked weapons on us/.test(m.text)));
    await waitFor(() => kira.nav()?.own.combat.lockedBy.includes('Enterprise'));
    await carol.click('#arm-phasers'); // the banks charge while we go on
    await carol.waitForSelector('#wp-phasers:has-text("Charging")');
    await picard.waitForSelector('[data-readout="Weapons"]:has-text("Locked: the Defiant")', { state: 'attached' });
    step("Tactical locked weapons on the Defiant: the Defiant's Tactical was warned, and the Captain's status shows the lock");

    // The Defiant raises shields: a torpedo drains them, the hull holds.
    kira.send({ type: 'shields', up: true });
    await carol.waitForSelector('#weapons-lock-state:has-text("shields up")');
    await carol.click('#fire-torpedo');
    await waitFor(() => kira.nav()?.own.combat.shield < 80 && kira.nav().own.combat.hull === 100);
    assert.equal(await carol.isDisabled('#fire-torpedo'), true, 'torpedo tubes should be reloading');
    // Science locks sensors on the Defiant: tracked each second. With its shields up, locations
    // resolve only while our sensors (delivered %) beat its shields' strength.
    await spock.click('.nav-contacts li[data-ship="Defiant"] button.nav-sci-lock');
    await spock.waitForSelector('.nav-scan:has-text("Tracking: the Defiant")');
    await spock.waitForSelector('.nav-scan:has-text("vs shields")');
    const [, sens, shld, res] = /Sensors (\d+)% vs shields (\d+)%: locations (resolved|unresolved)/.exec(await spock.textContent('.nav-scan'));
    assert.equal(res, Number(sens) > Number(shld) ? 'resolved' : 'unresolved', `sensors ${sens}% vs shields ${shld}%`);
    assert.equal(/, the Defiant/.test(await spock.textContent('.nav-scan-lifeforms')), res === 'resolved', 'locations shown only when resolved');
    await spock.click('.nav-contacts li[data-ship="Defiant"] button.nav-sci-lock');
    await spock.waitForSelector('.nav-contacts li[data-ship="Defiant"] button.nav-sci-lock[aria-pressed="false"]');
    step(`Science locked sensors on the shielded Defiant and tracked it: sensors ${sens}% vs shields ${shld}%, locations ${res}; then released the lock`);
    await carol.waitForSelector('#wp-torpedoes:has-text("9 of 10")');
    await nog.waitForSelector('.bcast--alert:has-text("Taking fire from the Enterprise")', { state: 'attached' });
    step('a torpedo drained the Defiant\'s shields (hull untouched); the tubes reloaded, and every Defiant console showed "Taking fire"');

    // Shields down: phasers hit the hull and damage a system, which caps its power.
    kira.send({ type: 'shields', up: false });
    await waitFor(async () => !(await carol.textContent('#weapons-lock-state')).includes('shields up'));
    await carol.waitForSelector('#fire-phaser:not([disabled])', { timeout: 20000 });
    await carol.click('#fire-phaser');
    await waitFor(() => kira.nav()?.own.combat.hull < 100);
    const hit = kira.nav().own;
    const damaged = Object.entries(hit.combat.damage).find(([, d]) => d > 0);
    assert.ok(damaged, 'a system should be damaged');
    assert.ok(!(damaged[0] in hit.power) || hit.power[damaged[0]] <= 1.5 * (100 - damaged[1]) + 1, 'damage should cap the system\'s power'); // subsystems have no power level: they fail at 50%
    await waitFor(() => obrien.msgs.some((m) => m.type === 'notice' && /^Engineering: .* damaged/.test(m.text)));
    step(`with shields down a phaser hit the hull (${hit.combat.hull}%) and damaged the ${damaged[0]}, capping its power`);

    // Engineering directs repairs; the ship's computer keeps the damage.
    obrien.send({ type: 'repair', system: damaged[0] });
    await waitFor(() => obrien.nav()?.own.combat.repair === damaged[0] || obrien.msgs.some((m) => m.type === 'notice' && /repaired/.test(m.text)));
    await waitFor(() => { try { return JSON.parse(stored('d', 'Defiant', '.nav.json')).combat?.hull < 100; } catch { return false; } }, 15000);
    await waitFor(() => obrien.nav()?.own.combat.damage[damaged[0]] === 0, 30000);
    step(`Engineering sent repair crews to the ${damaged[0]} and fixed it; the Defiant's computer saved the hull damage`);

    // Stealth: the Enterprise stands off 250 units; the Defiant powers down
    // and drops off the Enterprise's sensors (and weapons lock), then powers up again.
    helm({ dest: { x: 250, y: 500 }, warp: 5 });
    await waitFor(async () => { const n = await spock.evaluate(() => window.__nav.last); return n?.own.warp === 0 && n.own.x < 260; }, 30000);
    await spock.waitForSelector('.nav-contacts li[data-ship="Defiant"]', { state: 'attached' });
    obrien.send({ type: 'power', power: { engines: 0, injectors: 0, shields: 0, sensors: 20, lateral: 0, deflector: 0, sif: 0, idf: 0, transporter: 0, weapons: 0, atmosphere: 60, thermal: 60, gravity: 0, lights: 0, replicators: 0, recreation: 0, amBus: 0 } }); // (the AM bus's containment draws all the time it's on)
    await nog.waitForSelector('[data-readout="Replicators"]:has-text("Offline")', { state: 'attached' });
    await spock.waitForSelector('.nav-contacts li[data-ship="Defiant"]', { state: 'detached' });
    await carol.waitForSelector('#weapons-lock-state:has-text("No weapons lock")');
    step(`the Defiant powered down (replicators and holodecks too: its Crew consoles show them offline) to a ${Math.round(obrien.nav().own.signature * 100)}% signature: off the Enterprise's sensors 250 units away, and the weapons lock was lost`);
    obrien.send({ type: 'power', power: { engines: 80, injectors: 80, shields: 60, sensors: 100, lateral: 100, deflector: 100, sif: 100, idf: 100, transporter: 100, weapons: 50, atmosphere: 100, thermal: 100, gravity: 100, replicators: 40, recreation: 10, amBus: 100 } });
    await spock.waitForSelector('.nav-contacts li[data-ship="Defiant"]', { state: 'attached' });
    step('powered up again, the Defiant showed up on sensors');
    kira.close();
    obrien.close();

    // Starbases: Helm sets the autopilot for Starbase 12 and leaves; the ship's
    // computer flies there and docks. The torpedo fired earlier is restocked.
    const ap = await crewWs('ensign2', 'Enterprise', 'Helm');
    await waitFor(() => ap.nav()?.own?.known?.some((k) => k.name === 'Defiant')); // the Defiant is a known contact
    ap.send({ type: 'autopilot', target: 'Starbase 12', warp: 7 });
    await waitFor(() => ap.msgs.some((m) => m.type === 'nav' && m.own?.autopilot === 'Starbase 12'));
    ap.close(); // nobody needs to stay at Helm (sulu keeps his post but does nothing)
    await waitFor(async () => (await spock.evaluate(() => window.__nav.last.own.grid.docked)) === 'Starbase 12', 30000);
    await carol.waitForSelector('#wp-torpedoes:has-text("10 of 10")', { timeout: 15000 });
    // Restarting the ship's computers keeps it docked (saved with the ship).
    await new Promise((r) => setTimeout(r, 5500)); // the relay sends the computers a copy every 5 s
    await Promise.all([stopComputer(coreA), stopComputer(coreB)]);
    coreA = startComputer('a', 'Enterprise'); coreB = startComputer('b', 'Enterprise');
    await new Promise((r) => setTimeout(r, 3000)); // the computers sign back on
    await waitFor(async () => (await spock.evaluate(() => window.__nav.last.own?.grid?.docked)) === 'Starbase 12', 15000);
    step("the autopilot flew the Enterprise to Starbase 12 and docked it (the Defiant was a known contact); the torpedo fired earlier was restocked; still docked after the ship's computers restarted");

    // The power grid: Tactical's console moved to Bus C with nothing on it (its
    // EPS tap closed, its battery out of service) goes dark and refuses orders;
    // with the core shut down there's no warp. Back on Bus B, with the core
    // restarted, it comes back.
    const laforge = await crewWs('laforge', 'Enterprise', 'Engineering');
    laforge.send({ type: 'grid', core: 'stop', tap: { bus: 'C', amount: 0 }, breaker: { bus: 'C', on: false }, ties: { 'console:Tactical': ['C'], crosslink: [] } }); // (the impulse drives still feed the EPS)
    await carol.waitForSelector('#console-dark:not([hidden])', { timeout: 20000 });
    await waitFor(() => laforge.nav()?.speed.warp === 0); // no warp (the impulse drives still run on their own)
    await carol.$eval('#fire-torpedo', (b) => { b.disabled = false; b.click(); });
    await waitFor(async () => /console offline, no power on its bus/.test(await carol.textContent('#log')));
    laforge.send({ type: 'grid', core: 'start', ties: { 'console:Tactical': ['B'] } });
    await waitFor(() => laforge.nav()?.own.grid.core === 'starting');
    await carol.waitForSelector('#console-dark', { state: 'hidden', timeout: 20000 });
    await waitFor(() => laforge.nav()?.own.grid.core === 'online', 20000);
    step("Tactical's console on a dead Bus C went dark and refused orders, and with the warp core shut down there was no warp; back on Bus B with the core restarted, it came back");

    // Ties are any combination of what a source allows: batteries on both
    // buses (not the EPS); the warp core feeds the EPS only. Containment can't
    // be left with no feed.
    laforge.send({ type: 'grid', ties: { crosslink: ['A', 'B'] } });
    await waitFor(() => laforge.nav()?.own.grid.ties.crosslink.join() === 'A,B');
    laforge.send({ type: 'grid', ties: { core: ['A', 'EPS'] } });
    await waitFor(() => laforge.msgs.some((m) => m.type === 'notice' && /warp core can only be tied to EPS/.test(m.text)));
    laforge.send({ type: 'grid', ties: { containment: [] } });
    await waitFor(() => laforge.msgs.some((m) => m.type === 'notice' && /containment can't be switched off/.test(m.text)));
    step('the A-B crosslink on; the warp core (EPS only) refused other ties; containment could not be left without a feed');

    // Docked, a hard line: docking left the starbase connection untied; tying its
    // ODN opens a hard link to Starbase 12 with the subspace relay untied. Ops
    // can't close it; untying the ODN does.
    assert.deepEqual(laforge.nav()?.own.grid.connections.find((x) => x.kind === 'station').ties, { deu: false, am: false, odn: false }, 'docking left the starbase connection tied');
    laforge.send({ type: 'grid', ties: { 'sub:subspace': [] } });
    await waitFor(() => laforge.nav()?.own.grid.subOk.subspace === false);
    laforge.send({ type: 'grid', connTie: { res: 'odn', on: true } });
    await op.waitForFunction(() => window.__operator.network.includes('Starbase 12'), null, { timeout: 15000 });
    await screen(op, 'link');
    await op.waitForSelector('#links li:has-text("hard link: docking port")');
    assert.equal(await op.$('#links li:has-text("Starbase 12") button'), null, 'Ops was offered Close on the hard link');
    laforge.send({ type: 'grid', connTie: { res: 'odn', on: false } });
    await op.waitForFunction(() => !window.__operator.network.includes('Starbase 12'));
    laforge.send({ type: 'grid', ties: { 'sub:subspace': ['B'], dock: ['B'] } }); // (and dock power back on Bus B)
    step('docked at Starbase 12 with nothing tied; tying the ODN opened a hard link (subspace relay unpowered) that Ops could not close; untying it closed the link');

    // Every subsystem is listed under its console in the grid table, Security's emitters included.
    const geordi = await openAs(browser, 'geordi', 'geordi', 'Enterprise', 'Engineering');
    await screen(geordi, 'st-grid');
    for (const row of ['sub-forcefields', 'sub-rf', 'sub-radio', 'sub-subspace', 'sub-constriction', 'sub-portChamber', 'thrustersPort', 'core']) await geordi.waitForSelector(`#ties-${row}`, { state: 'attached' });
    step("the grid table lists every subsystem under its console (Security's force field emitters, Communications' RF, radio and relay, the reactors')");
    // Three orders: Operations (sources, crosslink, batteries, then consoles), and the Startup and Shutdown checklists.
    assert.deepEqual(await geordi.evaluate(() => window.__nav.last.own.grid.tieNodes['system:tractor']), ['EPS'], 'the tractor beam ties to the EPS only');
    await geordi.click('#grid-order-operations');
    const sections = await geordi.$$eval('#grid-table tbody tr', (rs) => rs.map((r) => (r.classList.contains('grid-section') ? `[${r.textContent.trim()}]` : r.id)).slice(0, 20));
    // External sources: solar, then the connections (each with a Power row on Bus B and an EPS row).
    assert.deepEqual(sections.slice(0, 7), ['[External sources]', 'ties-solar', 'conn-Starbase-12', 'conn-Starbase-12-deu', 'conn-Starbase-12-am', 'conn-Starbase-12-power', 'conn-Starbase-12-eps'], sections.join(' '));
    // The emergency batteries: a row right under the bus batteries, one per bus.
    assert.deepEqual(await geordi.$$eval('#grid-table thead tr', (rs) => rs.map((r) => r.id).slice(1)), ['grid-stores', 'grid-emerg']);
    assert.match(await geordi.textContent('#grid-emerg'), /Emergency \d+%.*Emergency \d+%.*Emergency \d+%/);
    assert.ok(sections.indexOf('[Bus crosslink]') < sections.indexOf('ties-crosslink'), sections.join(' '));
    // A Controls column between System and the ODN: every row's buttons sit there.
    assert.deepEqual((await geordi.$$eval('#grid-table thead tr:first-child th', (hs) => hs.map((h) => h.textContent.trim()))).slice(0, 3), ['System', 'Controls', 'ODN']);
    assert.equal(await geordi.locator('#grid-table tbody th button').count(), 0, 'a button left in the System column');
    assert.ok(await geordi.locator('#grid-table td.grid-controls #tank-deu-main-fill').count() === 1, 'Fill is in the Controls column');
    // Then the fuel storage (the buses, the main tanks), then the consoles.
    assert.deepEqual(sections.slice(sections.indexOf('ties-crosslink') + 1, sections.indexOf('ties-console-Captain')), ['[Fuel storage]', 'fuel-deu', 'ties-sub-deuTransfer', 'tank-deu-main', 'fuel-am', 'ties-sub-amTransfer', 'tank-am-main']);
    // The pods' row carries their containment ties (the low buses); there's no separate containment row.
    assert.equal(await geordi.locator('#tank-am-main input[data-node="A"]').count(), 1, 'the pods tie their containment to the low buses');
    assert.equal(await geordi.locator('#ties-containment').count(), 0, 'a duplicate containment row');
    // Each system's own tank sits under it: the warp core's two, each drive's, the torpedo bay's under weapons.
    for (const row of ['tank-deu-core', 'tank-am-core', 'tank-deu-port', 'tank-deu-aux1', 'tank-am-torpedo']) assert.equal(await geordi.locator(`#grid-table #${row}`).count(), 1, row);
    // Power crossing the crosslink shows as a bar under it, the amount in the middle.
    for (const r of await geordi.$$eval('#ties-crosslink .xflow-bar', (bs) => bs.map((x) => ({ flow: x.dataset.flow, label: x.textContent })))) assert.match(r.label, /\d/, JSON.stringify(r));
    // The stores (each bus's battery, the EPS pressure) sit under the headings.
    assert.match(await geordi.textContent('#grid-table thead #grid-stores'), /Battery \d+%.*Battery \d+%.*Battery \d+%.*Pressure \d+%/);
    const STEPS = ['External sources', 'Bus batteries and EPS pressure', 'Bus crosslink', 'Engineering console', 'Computer cores', 'Antimatter containment', 'Fuel buses', 'Impulse drives', 'Aux fusion reactors', 'EPS taps', 'Warp core', 'Consoles and systems'];
    await geordi.click('#grid-order-startup');
    assert.deepEqual(await geordi.$$eval('#grid-table tr[data-step]', (rs) => rs.map((r) => r.dataset.step)), STEPS);
    assert.equal(await geordi.textContent('#grid-table tr[data-step="Warp core"] .grid-chip'), 'Online');
    await geordi.click('#grid-order-shutdown');
    assert.deepEqual(await geordi.$$eval('#grid-table tr[data-step]', (rs) => rs.map((r) => r.dataset.step)), [...STEPS].reverse());
    // The core is running: the batteries can't come off yet, and a tap there is refused.
    await geordi.waitForSelector('#grid-table tr[data-step="External sources"] .grid-locked-why:has-text("shut down the warp core")');
    const battTied = await geordi.isChecked('#conn-Starbase-12-power input[data-node="B"]');
    await geordi.click('#conn-Starbase-12-power input[data-node="B"]');
    await geordi.waitForSelector('#grid-status:has-text("Unable to comply. Shut down the warp core")');
    assert.equal(await geordi.isChecked('#conn-Starbase-12-power input[data-node="B"]'), battTied, 'the refused tap changed nothing');
    assert.equal(await geordi.evaluate(() => localStorage.getItem('stchat-grid-order')), 'shutdown');
    await geordi.click('#grid-order-operations');
    // Connections: the starbase we're docked at, its Deuterium / Antimatter / Power rows with Import and Export.
    await geordi.waitForSelector('#conn-Starbase-12-deu-imp[aria-pressed="false"]');
    await geordi.click('#conn-Starbase-12-deu-imp');
    await geordi.waitForSelector('#conn-Starbase-12-deu-imp[aria-pressed="true"]');
    assert.equal(await geordi.getAttribute('#conn-Starbase-12-am-imp', 'aria-pressed'), 'false', 'one at a time');
    await geordi.click('#conn-Starbase-12-deu-imp');
    await geordi.waitForSelector('#conn-Starbase-12-deu-imp[aria-pressed="false"]');
    assert.equal(await geordi.locator('#conn-Starbase-12-power input[data-node="EPS"]').count(), 0, 'the Power row ties to Bus B only');
    assert.equal(await geordi.locator('#conn-Starbase-12-eps input[data-node="EPS"]').count(), 1, 'the EPS row ties to the EPS');
    assert.equal(await geordi.locator('#conn-Starbase-12-eps input[data-node="B"]').count(), 0, 'the EPS row ties to the EPS only');
    // The starbase connection's ties: Deu. on the Deuterium row, AM on the Antimatter row, the ODN on the starbase's own row.
    for (const [row, tie] of [['conn-Starbase-12-deu', 'deu'], ['conn-Starbase-12-am', 'am'], ['conn-Starbase-12', 'odn']]) assert.equal(await geordi.locator(`#${row} #conn-tie-${tie}`).count(), 1, `${tie} tie on ${row}`);
    // The master systems display: the ship profile, the power budget, a tile per system (tap one to open it).
    await screen(geordi, 'st-msd');
    await geordi.waitForSelector('.msd-tile[data-system="warp"] .msd-pill[data-state="ok"]:has-text("Running")');
    assert.match(await geordi.textContent('#msd-budget'), /Generation.*EPS demand.*Warp core output.*Fusion.*Battery charge.*Readiness/s);
    assert.match(await geordi.textContent('#msd-overall'), /^(All systems operational|Partial power)$/);
    assert.ok(await geordi.$eval('.msd-canvas', (cv) => cv.width > 0), 'the profile is drawn');
    await geordi.click('.msd-tile[data-system="warp"]');
    await geordi.waitForSelector('[data-screen="st-core"]:not([hidden])');
    step(`the master systems display: ${await geordi.textContent('#msd-overall')}, the warp core tile Running, and tapping it opened the warp core panel`);
    // Life support place by place: switching gravity off in a place takes its share off the draw.
    await screen(geordi, 'st-lifesupport');
    await geordi.waitForSelector('#ls-table .ls-tap[data-loc="Crew"][data-sys="gravity"][aria-pressed="true"]');
    const gravBefore = await geordi.evaluate(() => window.__nav.last.own.grid.demand.gravity);
    await geordi.click('#ls-table .ls-tap[data-loc="Crew"][data-sys="gravity"]');
    await geordi.waitForSelector('#ls-table .ls-tap[data-loc="Crew"][data-sys="gravity"][aria-pressed="false"]');
    await geordi.waitForFunction((b) => window.__nav.last.own.grid.demand.gravity < b, gravBefore);
    await geordi.click('#ls-table .ls-tap[data-loc="Crew"][data-sys="gravity"]');
    // Atmosphere off where someone is: everyone aboard is warned, naming the place.
    const bobAt = await bob.evaluate(() => window.__voice.me.station);
    await geordi.click(`#ls-table .ls-tap[data-loc="${bobAt}"][data-sys="atmosphere"]`);
    await bob.waitForSelector(`.bcast--alert:has-text("NO ATMOSPHERE: ${bobAt}")`, { state: 'attached' });
    await geordi.click(`#ls-table .ls-tap[data-loc="${bobAt}"][data-sys="atmosphere"]`);
    await bob.waitForFunction(() => !document.querySelector('.bcast--alert')?.textContent.includes('NO ATMOSPHERE'));
    step(`the Life support panel: gravity switched off in Crew quarters took its share off the draw; atmosphere off at ${bobAt}, where bob is, warned "NO ATMOSPHERE: ${bobAt}"`);
    // The optical data network: Engineering cuts Science's console off it; Science sees only
    // "Disconnected", an empty menu (but Comms, log, library, Station), and its commands are refused.
    await screen(geordi, 'st-grid');
    assert.equal(await geordi.isDisabled('#ties-console-Engineering input[aria-label$="optical data network"]'), true, "Engineering's link can't be cut");
    await geordi.click('#ties-console-Science input[aria-label$="optical data network"]');
    await spock.waitForFunction(() => document.body.hasAttribute('data-odn-off'));
    await spock.waitForSelector('[data-screen="odn-off"]:not([hidden]):has-text("Disconnected from the optical data network")');
    assert.equal(await spock.locator('#sections > *:visible').count(), 0, 'an empty menu');
    assert.equal(await spock.isVisible('#reassign-tab'), true, 'Station still there');
    await spock.evaluate(() => window.__send({ type: 'scan', ship: 'Defiant' }));
    await spock.waitForFunction(() => /Disconnected from the optical data network/.test(document.getElementById('log').textContent));
    await geordi.click('#ties-console-Science input[aria-label$="optical data network"]');
    await spock.waitForFunction(() => !document.body.hasAttribute('data-odn-off'));
    step("the optical data network: Science's console, cut off by Engineering, showed only \"Disconnected\" with an empty menu and its scan was refused; relinked, it came back");
    // The Warp core panel: the reaction's state, readouts and controls.
    await screen(geordi, 'st-core');
    await geordi.waitForSelector('#wc-state:has-text("Running")');
    assert.match(await geordi.textContent('[data-warpcore]'), /Output\s*\d+ of 1000.*Efficiency\s*\d+%.*Dilithium alignment/s);
    assert.equal(await geordi.locator('#core-rate button').count(), 10, 'a light bar for the reaction rate');
    await geordi.waitForSelector('#wc-scram');
    await screen(geordi, 'st-grid');
    // The warp core's Start / Stop is on its row in the grid, in every order.
    await geordi.waitForSelector('#ties-core-parent #core-stop');
    assert.deepEqual(await geordi.evaluate(() => ['#grid-table thead', '#grid-table tfoot'].map((q) => getComputedStyle(document.querySelector(q)).position)), ['sticky', 'sticky'], 'the headings and totals stay in view');
    // A refresh comes back signed in, at the same station, on the same screen.
    await geordi.reload();
    await geordi.waitForFunction(() => window.__voice.me?.station === 'Engineering' && window.__voice.myName === 'geordi');
    await geordi.waitForSelector('[data-screen="st-grid"]:not([hidden])');
    step('a refresh rejoined geordi at Engineering, on the power grid screen');
    step('the grid table: Operations order (power sources, crosslink, batteries, consoles), the Startup checklist and Shutdown in reverse, a locked step refusing a tap; the tractor beam on the EPS');

    // Engineering ejects the warp core from Damage control (two presses): no antimatter, no core power.
    await screen(geordi, 'st-damage');
    await geordi.click('#core-eject');
    await geordi.waitForSelector('#core-eject:has-text("Confirm eject")');
    assert.notEqual(laforge.nav().own.grid.core, 'ejected', 'one press only arms it');
    await geordi.click('#core-eject');
    await waitFor(() => laforge.nav()?.own.grid.core === 'ejected' && !laforge.nav().own.grid.antimatter);
    step('Engineering ejected the warp core and antimatter pods from Damage control (armed by one press, fired by a second)');
    // Back (the bottom-left corner): to the power grid, where geordi was before Damage control (and before the refresh).
    await geordi.click('#back-button');
    await geordi.waitForSelector('[data-screen="st-grid"]:not([hidden])');
    // Home (the top-left corner): the station's main screen, the master systems display.
    await geordi.click('.lcars-elbow--top');
    await geordi.waitForSelector('[data-screen="st-msd"]:not([hidden])');
    step('Back returned to the power grid; Home (top-left) went to the master systems display');
    // Shift-click the name in the header: back to sign-in, to start somewhere new (nothing signs back in).
    await geordi.click('#station-sub', { modifiers: ['Shift'] });
    await geordi.waitForSelector('[data-screen="register"]:not([hidden])');
    await geordi.waitForTimeout(1500); // (no rejoin)
    assert.equal(await geordi.evaluate(() => window.__voice.me), null, 'signed out');
    assert.deepEqual(await geordi.evaluate(() => [document.getElementById('name').value, document.getElementById('ship').value]), ['geordi', ''], 'the name kept, the ship forgotten');
    await op.waitForFunction(() => !window.__operator.roster.some((u) => u.name === 'geordi'));
    step('shift-clicking the name in the header signed geordi out to the sign-in screen, name kept, ship and station forgotten');
    // Shift-click the relay's name at the foot: the admin panel (here the relay runs without the supervisor).
    await geordi.click('#link', { modifiers: ['Shift'] });
    await geordi.waitForSelector('#admin-dialog:has-text("no supervisor")');
    await geordi.click('#admin-close');
    step('shift-clicking the relay name opened the admin panel (no supervisor here, and it said so)');
    await geordi.close();

    // The Defiant comes alongside and tows the crippled Enterprise with a tractor beam.
    const ezri = await crewWs('ezri', 'Defiant', 'Helm');
    const tuvok = await crewWs('tuvok', 'Defiant', 'Tactical');
    const at = laforge.nav().own;
    ezri.send({ type: 'helm', dest: { x: at.x, y: at.y - 4 }, warp: 7 });
    await waitFor(() => { const n = ezri.nav(); const e = n?.ships.find((x) => x.name === 'Enterprise'); return n?.own.warp === 0 && e && e.distance <= 20; }, 30000);
    tuvok.send({ type: 'tractor', ship: 'Enterprise' });
    await waitFor(() => suluMsgs.some((m) => m.type === 'notice' && /has us in a tractor beam/.test(m.text)));
    helm({ dest: { x: 500, y: 500 }, warp: 1 });
    await waitFor(() => suluMsgs.some((m) => m.type === 'notice' && /held in the Defiant's tractor beam/.test(m.text)));
    ezri.send({ type: 'helm', dest: { x: 120, y: 700 }, warp: 5 });
    await waitFor(() => ezri.msgs.some((m) => m.type === 'notice' && /warp 3/.test(m.text)));
    ezri.send({ type: 'helm', dest: { x: 120, y: 700 }, warp: 3 });
    await waitFor(async () => { const n = await spock.evaluate(() => window.__nav.last.own); return n.y < 720; }, 30000);
    const towed = await spock.evaluate(() => window.__nav.last.own);
    const tug = ezri.nav().own;
    assert.ok(Math.hypot(towed.x - tug.x, towed.y - tug.y) < 6, 'the Enterprise should follow just behind the Defiant');
    await bob.waitForSelector('.bcast--alert:has-text("Held in the Defiant\'s tractor beam")', { state: 'attached' });
    step('the Defiant came alongside, locked a tractor beam on the Enterprise (whose Helm could not break away) and towed it at warp 3');

    // Back to Starbase 12, let go, dock, and install a new warp core.
    ezri.send({ type: 'helm', dest: { base: 'Starbase 12' }, warp: 3 });
    await waitFor(async () => (await spock.evaluate(() => window.__nav.last.own.grid.near)) === 'Starbase 12' && ezri.nav()?.own.warp === 0, 30000);
    tuvok.send({ type: 'tractor', ship: null });
    await waitFor(() => suluMsgs.some((m) => m.type === 'notice' && /Released from the Defiant's tractor beam/.test(m.text)));
    sulu.send(JSON.stringify({ type: 'dock' }));
    await waitFor(async () => (await spock.evaluate(() => window.__nav.last.own.grid.docked)) === 'Starbase 12');
    laforge.send({ type: 'grid', ties: { dock: ['B'] } }); // (docking leaves the connection untied)
    laforge.send({ type: 'grid', refit: true });
    await waitFor(() => laforge.nav()?.own.grid.core === 'offline' && laforge.nav().own.grid.antimatter >= 900); // (full pods; the core's own tank takes some over the bus)
    // (If the EPS collapsed while the core was out, its manifold has to pressurize again for the SIF.)
    await waitFor(() => laforge.nav()?.own.grid.epsLive && laforge.nav().own.power.sif >= 50, 30000);
    // (The new core's tanks fill from the pods and the deuterium tank over the buses.)
    await waitFor(() => ['deu', 'am'].every((b) => laforge.nav()?.own.grid.fuel[b].tanks.find((x) => x.name === 'core').pct >= 30), 15000);
    laforge.send({ type: 'grid', core: 'start' });
    await waitFor(() => laforge.nav()?.own.grid.core === 'online', 20000);
    step('towed back to Starbase 12 and released, the Enterprise docked, had a new warp core and full antimatter pods installed, and started it');

    // The antimatter bus: without its magnetic containment, or its transfer power, nothing moves on it;
    // the pods stay contained (their own ties). The deuterium bus: nothing moves without its transfer power.
    laforge.send({ type: 'grid', ties: { 'system:amBus': [] } });
    await waitFor(() => laforge.nav()?.own.grid.fuel.am.why === 'AM bus: containment offline');
    assert.ok(laforge.nav().own.grid.containmentOk, 'the pods lost containment with the AM bus');
    laforge.send({ type: 'grid', ties: { 'system:amBus': ['EPS'], 'sub:amTransfer': [] } });
    await waitFor(() => laforge.nav()?.own.grid.fuel.am.why === 'AM bus: no transfer power');
    assert.ok(laforge.nav().own.grid.containmentOk, 'the pods lost containment with the AM bus transfer');
    laforge.send({ type: 'grid', ties: { 'sub:amTransfer': ['B'], 'sub:deuTransfer': [] } });
    await waitFor(() => !laforge.nav()?.own.grid.fuel.am.down && laforge.nav().own.grid.fuel.deu.why === 'Deu. bus: no transfer power');
    laforge.send({ type: 'grid', ties: { 'sub:deuTransfer': ['B'] } });
    await waitFor(() => !laforge.nav()?.own.grid.fuel.deu.down);
    step('the antimatter bus stopped without its magnetic containment, then without its transfer power, the pods contained throughout; the deuterium bus stopped without its transfer power');

    // Supplies: the Enterprise exports deuterium to the starbase; the Defiant
    // docks with the Enterprise and sends it some of its own.
    const deuBefore = laforge.nav().own.grid.deuterium;
    laforge.send({ type: 'grid', conn: { with: 'station', res: 'deu', exp: true }, connTie: { res: 'deu', on: true } });
    await waitFor(() => laforge.nav()?.own.grid.deuterium <= deuBefore - 150, 15000);
    laforge.send({ type: 'grid', conn: { with: 'station', res: 'deu', exp: false } });
    const ent = laforge.nav().own;
    ezri.send({ type: 'helm', dest: { x: ent.x, y: ent.y - 3 }, warp: 1 });
    await waitFor(() => { const n = ezri.nav()?.own; return n && Math.hypot(n.x - ent.x, n.y - (ent.y - 3)) < 1 && n.warp === 0 && n.grid.nearShip === 'Enterprise'; }, 20000);
    // The Enterprise is crewed with working thrusters: docking is a request its Helm answers.
    ezri.send({ type: 'dock', ship: 'Enterprise' });
    await waitFor(() => suluMsgs.some((m) => m.type === 'notice' && /the Defiant requests to dock/.test(m.text)));
    sulu.send(JSON.stringify({ type: 'dock', answer: 'decline' }));
    await waitFor(() => ezri.msgs.some((m) => m.type === 'notice' && /the Enterprise declined to dock/.test(m.text)));
    const asked = suluMsgs.filter((m) => m.type === 'notice' && /requests to dock/.test(m.text)).length;
    ezri.send({ type: 'dock', ship: 'Enterprise', port: 'starboard' });
    await waitFor(() => suluMsgs.filter((m) => m.type === 'notice' && /requests to dock/.test(m.text)).length > asked);
    sulu.send(JSON.stringify({ type: 'dock', answer: 'accept' }));
    await waitFor(() => laforge.nav()?.own.grid.dockedShip === 'Defiant');
    // Two ports: Starbase 12 on one, the Defiant on the other.
    const ports = laforge.nav().own.grid.ports;
    assert.equal(Object.values(ports).filter((v) => v?.base === 'Starbase 12').length, 1);
    assert.equal(Object.values(ports).filter((v) => v?.ship === 'Defiant').length, 1);
    step("the Defiant asked to dock: the Enterprise's Helm declined, then accepted; the Enterprise has Starbase 12 on one port and the Defiant on the other");
    // Docked together across a restart of the Defiant's computer.
    await new Promise((r) => setTimeout(r, 5500));
    await stopComputer(coreD);
    coreD = startComputer('d', 'Defiant');
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(laforge.nav()?.own.grid.dockedShip, 'Defiant', "restarting the Defiant's computer undocked the ships");
    const rom = await crewWs('rom', 'Defiant', 'Engineering');
    const before = laforge.nav().own.grid.deuterium;
    rom.send({ type: 'grid', conn: { with: 'Enterprise', res: 'deu', exp: true } });
    laforge.send({ type: 'grid', conn: { with: 'Defiant', res: 'deu', imp: true } });
    await waitFor(() => laforge.nav()?.own.grid.deuterium >= before + 90, 15000);
    rom.send({ type: 'grid', conn: { with: 'Enterprise', res: 'deu', exp: false } });
    laforge.send({ type: 'grid', conn: { with: 'Defiant', res: 'deu', imp: false } });
    // Power across the dock: the Defiant exports from its Bus B, the Enterprise imports onto its Bus B.
    rom.send({ type: 'grid', ties: { ship: ['B'] }, conn: { with: 'Enterprise', res: 'power', exp: true } });
    laforge.send({ type: 'grid', ties: { ship: ['B'] }, conn: { with: 'Defiant', res: 'power', imp: true } });
    await waitFor(() => laforge.nav()?.own.grid.shipIn > 0 && Object.values(rom.nav()?.own.grid.ports || {}).find((v) => v?.ship === 'Enterprise')?.fed > 0);
    // And on the EPS row: EPS to EPS.
    rom.send({ type: 'grid', ties: { shipEps: ['EPS'] }, conn: { with: 'Enterprise', res: 'eps', exp: true } });
    laforge.send({ type: 'grid', ties: { shipEps: ['EPS'] }, conn: { with: 'Defiant', res: 'eps', imp: true } });
    await waitFor(() => laforge.nav()?.own.grid.connections.find((x) => x.name === 'Defiant')?.epsIn > 0);
    // Across the dock: the Station screen offers the Defiant's stations, and
    // the Defiant's engineer walks over to the Enterprise's Science console.
    await screen(spock, 'reassign');
    await spock.waitForSelector('#dock-stations [data-vessel="Defiant"] button[data-station="Operations"]');
    assert.equal(await spock.isDisabled('#station-taps button[data-station="Science"]'), true, 'the station you are at is greyed out');
    rom.send({ type: 'change-station', station: 'Science', ship: 'Enterprise' });
    await waitFor(() => rom.msgs.some((m) => m.type === 'registered' && m.ship === 'Enterprise' && m.station === 'Science'));
    step('docked together, the Station screen offered the Defiant\'s stations, and the Defiant\'s engineer walked across to the Enterprise\'s Science console');
    ezri.send({ type: 'dock', undock: true });
    await waitFor(() => !laforge.nav()?.own.grid.dockedShip);
    rom.close();
    step('Connections: the Enterprise exported deuterium to Starbase 12; the Defiant docked with it and exported deuterium and power (Bus B and EPS rows) to it (the Enterprise importing); then undocked');
    ezri.close();
    tuvok.close();

    // The Captain sets the self-destruct; everyone aboard sees the countdown; aborted.
    picard.on('dialog', (d) => d.accept());
    await screen(picard, 'st-msd'); // (the ship's status and the self-destruct sit under the master systems display)
    await picard.click('#self-destruct');
    await bob.waitForSelector('.bcast--alert:has-text("Self-destruct in")', { state: 'attached' });
    await picard.click('#self-destruct-abort');
    await bob.waitForSelector('.bcast--alert:has-text("Self-destruct")', { state: 'detached' });
    step('the Captain set the self-destruct (every console counted down) and aborted it');

    // Containment fed from Bus B with Bus B cut off: the core breaches and the
    // Enterprise is destroyed, then rebuilt docked at a starbase.
    // (Battery B carries Bus B a while first.)
    // (Bus C, with nothing on it: its battery out of service, its EPS tap closed.)
    // (The core shut down first: with a live reaction it would be the 45 s countdown instead.)
    laforge.send({ type: 'grid', core: 'stop', ties: { containment: ['C'], core: ['EPS'], crosslink: [] }, breaker: { bus: 'C', on: false }, tap: { bus: 'C', amount: 0 } });
    // Then containment's internal reserve, then its field falls: below 20% it breaches.
    await waitFor(() => laforge.msgs.some((m) => m.type === 'notice' && /containment on its internal reserve/.test(m.text)), 40000);
    await bob.waitForSelector('.bcast--alert:has-text("containment failing")', { state: 'attached', timeout: 40000 });
    assert.match(await bob.textContent('.bcast--alert:has-text("containment failing")'), /field \d+%, breach in \d+ s .*reserve exhausted/);
    await waitFor(() => suluMsgs.some((m) => m.type === 'destroyed' && /breach/.test(m.cause)), 30000);
    const reborn = suluMsgs.find((m) => m.type === 'destroyed');
    await waitFor(async () => { const n = await spock.evaluate(() => window.__nav.last.own); return n.grid.docked === reborn.base && n.combat.hull === 100 && n.grid.core === 'offline' && n.grid.antimatter === 0 && n.grid.containmentOk; });
    await bob.waitForSelector(`.bcast--alert:has-text("Rebuilt and docked at ${reborn.base}")`, { state: 'attached' });
    await op.waitForSelector('#console-dark:not([hidden])', { state: 'attached' }); // rebuilt cold: dark
    await screen(op, 'reassign'); // but the Station screen still works, to move to a console with power
    await op.waitForSelector('#console-dark', { state: 'hidden' });
    await screen(op, 'status');
    await op.waitForSelector('#console-dark:not([hidden])', { state: 'attached' });
    // (Cold iron: nothing tied in, consoles, sensors and comms included.)
    laforge.send({ type: 'grid', conn: { with: 'station', res: 'power', imp: true }, ties: { dock: ['B'], crosslink: ['A', 'B'], 'console:Operations': ['A'], 'console:Engineering': ['A'], 'system:lateral': ['A'], 'sub:rf': ['B'], 'sub:radio': ['B'], 'sub:subspace': ['B'], 'system:atmosphere': ['A'], 'system:thermal': ['A'], 'sub:computer1': ['A'] } });
    // (Computer core 1, tied to a powered bus, boots by itself: texts need a core.)
    await op.waitForSelector('#console-dark', { state: 'hidden' });
    step(`containment on a dead bus breached the core: the Enterprise was destroyed and rebuilt cold iron (nothing tied in, no fuel) docked at ${reborn.base}; tied to dock power, the ops console came back`);
    // Rebuilt like a new ship, its starbase connection had only the ODN tied: a hard link to the starbase. Untied, the link closes.
    await op.waitForFunction((b) => window.__operator.network.includes(b), reborn.base, { timeout: 10000 });
    laforge.send({ type: 'grid', connTie: { res: 'odn', on: false } });
    await op.waitForFunction((b) => !window.__operator.network.includes(b), reborn.base, { timeout: 10000 });
    laforge.close();

    // Automated starbases: a hail with nobody aboard gets the automated reply;
    // a data link is accepted by itself after a few seconds.
    await screen(op, 'hail');
    await op.waitForSelector(`#hail-ship option[value="${reborn.base}"]`, { state: 'attached' });
    await op.selectOption('#hail-ship', reborn.base);
    await op.selectOption('#hail-crew', id('alice'));
    await op.click('#hail-form button');
    await op.waitForSelector('#ops-log li:has-text("(automated): nobody aboard")', { state: 'attached' });
    await screen(op, 'link');
    await op.selectOption('#link-ship', reborn.base);
    await op.click('#link-form button');
    await op.waitForFunction((b) => window.__operator.network.includes(b), reborn.base, { timeout: 10000 });
    await op.waitForSelector('#ops-log li:has-text("(automated) accepted")', { state: 'attached' });
    step(`${reborn.base} (automated) answered a hail with nobody aboard, and accepted a data link by itself`);

    // Someone reports aboard the starbase: hails are put through to them.
    const bashir = await crewWs('bashir', reborn.base, 'Captain');
    await screen(op, 'hail');
    await op.selectOption('#hail-ship', reborn.base);
    await op.selectOption('#hail-crew', id('alice'));
    await op.click('#hail-form button');
    await waitFor(() => bashir.msgs.some((m) => m.type === 'connect' && m.peers.some((p) => p.name === 'alice')));
    await alice.waitForFunction(() => window.__voice.state !== 'idle', null, { timeout: 10000 });
    bashir.close();
    await alice.waitForFunction(() => window.__voice.state === 'idle', null, { timeout: 10000 });
    step(`with a Captain aboard ${reborn.base}, the automated station put alice's hail straight through to them`);

    // A crewless ship: the Enterprise forces a data link onto it (nobody to
    // refuse), and a crew member takes its Helm by remote control.
    const here = await spock.evaluate(() => window.__nav.last.own);
    const reliantCore = startComputer('r', 'Reliant', { position: `${Math.round(here.x + 8)},${Math.round(here.y)}` });
    await op.waitForFunction(() => window.__operator.ships.includes('Reliant'), null, { timeout: 15000 });
    await screen(op, 'link');
    await op.selectOption('#link-ship', 'Reliant');
    await op.click('#link-form button');
    await op.waitForFunction(() => window.__operator.network.includes('Reliant'));
    await op.waitForSelector('#ops-log li:has-text("forced")', { state: 'attached' });
    // Remote control: the Enterprise's Helm runs the Reliant's (unmanned) Helm
    // from its own console, over the data link.
    const data = await crewWs('data', 'Enterprise', 'Helm');
    await waitFor(() => data.nav()?.remote?.vessels?.includes('Reliant'));
    data.send({ type: 'control', ship: 'Reliant' });
    await waitFor(() => data.nav()?.remote?.controlling === 'Reliant' && data.nav().own?.name === 'Reliant');
    // Autopilot follow: the Reliant tails the Enterprise at 25 units; then matches it.
    data.send({ type: 'autopilot', target: 'Enterprise', mode: 'follow', range: 25, warp: 1 });
    await waitFor(() => { const n = data.nav(); const e = n?.ships.find((x) => x.name === 'Enterprise'); return n?.own?.autopilotMode?.mode === 'follow' && e && e.distance > 20 && e.distance < 32; }, 30000);
    data.send({ type: 'autopilot', target: 'Enterprise', mode: 'match' });
    await waitFor(() => data.nav()?.own?.autopilotMode?.mode === 'match' && data.nav().own.warp === 0); // the Enterprise is stopped
    step('autopilot (run remotely): the Reliant followed the Enterprise at 25 units, then matched its heading and speed');
    data.send({ type: 'autopilot', target: null });
    data.send({ type: 'control', ship: null });
    await waitFor(() => !data.nav()?.remote?.controlling && data.nav().own?.name === 'Enterprise');
    step("the Enterprise forced a data link onto the crewless Reliant; its Helm console ran the Reliant's Helm by remote control, then switched back");
    // Ops runs the Reliant's (unmanned) ops the same way.
    await op.waitForSelector('#vessel-bar button[data-vessel="Reliant"]', { state: 'attached' });
    await op.click('#vessel-bar button[data-vessel="Reliant"]');
    await op.waitForFunction(() => window.__operator.roster && document.querySelector('#vessel-bar button[data-vessel="Reliant"][aria-pressed="true"]'));
    await op.click('#vessel-bar button[data-vessel=""]'); // our own ship
    await op.waitForSelector('#vessel-bar button[data-vessel=""][aria-pressed="true"]', { state: 'attached' });
    step("Enterprise ops ran the Reliant's unmanned ops by remote control, then switched back");
    // A starbase blocks remote control by default, even with nobody at its ops.
    await screen(op, 'link');
    if (!(await op.evaluate((b) => window.__operator.network.includes(b), reborn.base))) { // (linked earlier, still open)
      await op.selectOption('#link-ship', reborn.base);
      await op.click('#link-form button');
      await op.waitForFunction((b) => window.__operator.network.includes(b), reborn.base, { timeout: 10000 });
    }
    await new Promise((r) => setTimeout(r, 1200));
    assert.ok(!(data.nav()?.remote?.vessels || []).includes(reborn.base), 'a starbase should start with remote control blocked');
    // Someone at the starbase's ops allows it: the Enterprise's Helm gets its button.
    const sbOps = await openOps(browser, reborn.base, 'starbase ops', 'quark');
    await sbOps.waitForSelector('#remote-block:has-text("blocked")'); // starbases start blocked
    await sbOps.click('#remote-block');
    await sbOps.waitForSelector('#remote-block:has-text("allowed")');
    await waitFor(() => (data.nav()?.remote?.vessels || []).includes(reborn.base));
    await sbOps.click('#remote-block'); // blocked again
    await waitFor(() => !(data.nav()?.remote?.vessels || []).includes(reborn.base));
    await sbOps.close();
    await op.click(`#links li:has-text("${reborn.base}") button`);
    step(`${reborn.base}, linked, offered no remote control (starbases start blocked); its ops allowed it (the Enterprise's Helm got its button), then blocked it again`);
    // The link closes: remote control snaps back.
    data.send({ type: 'control', ship: 'Reliant' });
    await waitFor(() => data.nav()?.remote?.controlling === 'Reliant');
    await screen(op, 'link');
    await op.click('#links li:has-text("Reliant") button');
    await waitFor(() => data.msgs.some((m) => m.type === 'notice' && /Remote control of the Reliant ended: the data link dropped/.test(m.text)));
    await waitFor(() => !data.nav()?.remote?.controlling);
    step('when the data link closed, remote control snapped back to the Enterprise');
    data.close();
    await stopComputer(reliantCore);

    // A starbase can't dock with itself, and a ship's computer run for one
    // only holds its library: the station stays put and isn't harmed.
    const odo = await crewWs('odo', 'Starbase 74', 'Helm');
    await waitFor(() => odo.nav()?.own);
    assert.equal(odo.nav().own.grid.near, null);
    odo.send({ type: 'dock' });
    await waitFor(() => odo.msgs.some((m) => m.type === 'notice' && /is a starbase: ships dock with it/.test(m.text)));
    const sbCore = startComputer('sb', 'Starbase 74');
    await new Promise((r) => setTimeout(r, 3000));
    assert.deepEqual([odo.nav().own.x, odo.nav().own.y], [880, 820]);
    // Listed once: as a starbase, never also as a ship contact.
    assert.equal(odo.nav().ships.filter((x) => x.name === 'Starbase 74').length, 0, 'the starbase also showed as a ship');
    assert.equal(odo.nav().bases.filter((b) => b.name === 'Starbase 74').length, 1);
    assert.ok(!odo.msgs.some((m) => m.type === 'destroyed'), 'the starbase was destroyed');
    await stopComputer(sbCore);
    odo.close();
    step("Starbase 74 offered no docking with itself, and a ship's computer run for it left the station in place, unharmed, and listed once");
    for (const page of [worf, riker, picard]) await page.close();

    sulu.close();
    rand.close();
    await spock.close();
    for (const page of [nog, uhura2, dops]) await page.close();

    // A new ship starts cold, docked at a starbase: every console but
    // Engineering's grid controls dark, no fuel. Engineering ties in dock
    // power, sets a containment feed, refuels and starts the core.
    startComputer.cold('x', 'Excelsior');
    await bob.waitForSelector('#ship option[value="Excelsior"]', { state: 'attached' }).catch(() => new Promise((r) => setTimeout(r, 2000)));
    const barclay = await crewWs('barclay', 'Excelsior', 'Engineering');
    const ro = await crewWs('ro', 'Excelsior', 'Tactical');
    await waitFor(() => barclay.nav()?.own?.grid.docked);
    const cold = barclay.nav().own.grid;
    assert.equal(cold.core, 'offline');
    assert.equal(cold.antimatter + cold.deuterium, 0);
    assert.ok(['solar', 'dock', 'ship', 'core', 'containment', 'crosslink'].every((k) => !cold.ties[k].length), 'a new ship should start with no power source tied in');
    assert.deepEqual(['A', 'B', 'C', 'EPS'].map((n) => cold.stores[n].level), [100, 100, 100, 0], 'full batteries on each bus; the EPS unpressurized');
    assert.deepEqual(['A', 'B', 'C'].map((n) => cold.stores[n].breaker), [false, false, false], "the batteries' main breakers open");
    assert.ok(Object.entries(cold.ties).every(([k, v]) => !v.length || ['impulsePort', 'impulseStarboard'].includes(k)), `cold iron: nothing tied in (${JSON.stringify(Object.entries(cold.ties).filter(([, v]) => v.length))})`);
    // A dark room: no lights and the console dark: black but for Station and comms.
    const dataPage = await openAs(browser, 'data', 'data', 'Excelsior', 'Science');
    await dataPage.waitForFunction(() => document.body.dataset.blackout === 'all');
    const inert = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#sections > [data-screen-tab], #log-tab, #library-tab, #reassign-tab, #comms-button, .lcars-elbow--top, #back-button')]
      .map((b) => [b.dataset.screenTab || b.id || b.className, getComputedStyle(b).pointerEvents === 'none'])));
    const darkSeen = await inert(dataPage);
    assert.ok(Object.entries(darkSeen).every(([k, v]) => v === !['reassign', 'reassign-tab', 'comms-button'].includes(k)), `only Comms and Station work in the dark: ${JSON.stringify(darkSeen)}`);
    // Engineering in the dark keeps its Power grid too, to bring the ship up.
    const engDark = await openAs(browser, 'scott', 'scott', 'Excelsior', 'Engineering');
    await engDark.waitForFunction(() => document.body.dataset.blackout === 'engineering');
    const engSeen = await inert(engDark);
    assert.ok(engSeen['st-grid'] === false && engSeen['st-msd'] === true && engSeen.reassign === false && engSeen['comms-button'] === false, JSON.stringify(engSeen));
    await engDark.close();
    // No console power and no local RF: the library and comms are offline (proximity only).
    await dataPage.waitForSelector('#library-tab[data-offline]');
    await dataPage.click('#comms-button');
    await dataPage.waitForSelector('#comms-offline:not([hidden]):has-text("Comms offline: no console power or local RF. Proximity only.")');
    await dataPage.click('#comms-close');
    assert.equal(await dataPage.isVisible('#reassign-tab'), true, 'the Station button still works');
    await dataPage.click('#reassign-tab');
    await dataPage.waitForSelector('[data-screen="reassign"]:not([hidden])');
    await dataPage.close();
    step("the Excelsior's Science station, unlit and its console dark, went black but for the Station button and comms");
    // Solar (25) comes in on Bus B only. Life support is several systems with their own
    // ties: solar alone runs the atmospheric processors (10) and thermal regulation (8) with
    // 7 over for Battery B, but not gravity (20) as well.
    assert.deepEqual(cold.tieNodes?.solar ?? ['B'], ['B'], 'solar ties to Bus B only');
    barclay.send({ type: 'grid', ties: { solar: ['B'], 'system:atmosphere': ['B'], 'system:thermal': ['B'], 'system:gravity': ['B'] }, breaker: { bus: 'B', on: true } });
    await waitFor(() => { const g = barclay.nav()?.own.grid; return g?.stores.B.supplying > 0 && g.stores.B.level <= 99 && g.cells.solar.B === 25; }); // (gravity on top: the battery covers it)
    assert.deepEqual(unbalanced(barclay.nav().own.grid), []);
    barclay.send({ type: 'grid', ties: { 'system:gravity': [] } });
    await waitFor(() => { const g = barclay.nav()?.own.grid; return g?.stores.B.charging > 0 && g.cells['system:atmosphere'].B === 10 && g.cells['system:thermal'].B === 8 && g.cells.solar.B === 25; });
    assert.deepEqual(unbalanced(barclay.nav().own.grid), [], 'solar 25 = atmosphere 10 + thermal 8 + Battery B charging 7');
    assert.equal(barclay.nav().own.power.lifeSupport, 100, 'atmosphere and thermal at full: life support 100%');
    barclay.send({ type: 'grid', ties: { 'system:atmosphere': [], 'system:thermal': [] }, breaker: { bus: 'B', on: false } });
    step('life support as several systems: solar alone (Bus B) ran the atmospheric processors (10) and thermal regulation (8) with 7 over for Battery B; gravity (20) on top needed the battery');
    // Engineering ties in the loads (a usual layout) before bringing anything up.
    barclay.send({ type: 'grid', ties: {
      'console:Engineering': ['A'], 'console:Tactical': ['A'], 'system:atmosphere': ['A'], 'system:thermal': ['A'], 'system:gravity': ['A'], 'system:lighting': ['A'], 'system:lateral': ['A'],
      'system:replicators': ['B'], 'system:recreation': ['B'], 'system:transporter': ['B'], 'sub:constriction': ['A'], 'sub:injector': ['A'], 'sub:amConduit': ['A'], 'contain:amCore': ['A'], 'contain:amTorpedo': ['A'], 'sub:portChamber': ['B'], 'sub:starboardChamber': ['B'], 'sub:aux1Chamber': ['A'], aux1: ['EPS'],
      'sub:rf': ['B'], 'sub:radio': ['B'], 'sub:subspace': ['B'], 'sub:forcefields': ['B'], 'sub:deuTransfer': ['B'], 'sub:amTransfer': ['B'], 'sub:computer1': ['A'], 'sub:computer2': ['B'], 'sub:computer3': ['C'], 'system:lights': ['A'], 'sub:patternBuffers': ['B'], 'sub:targetingScanners': ['B'], 'sub:energizingCoils': ['B'], 'sub:heisenberg': ['B'], 'sub:biofilter': ['B'], thrustersPort: ['EPS'], thrustersStarboard: ['EPS'],
      ...Object.fromEntries(['sensors', 'sif', 'idf', 'engines', 'injectors', 'shields', 'weapons', 'deflector', 'tractor', 'amBus'].map((x) => [`system:${x}`, ['EPS']])) } });
    // The fuel buses: the main storage drains into the systems' own tanks.
    for (const [bus, names] of [['deu', ['core', 'port', 'starboard', 'aux1']], ['am', ['core']]]) {
      barclay.send({ type: 'grid', tank: { bus, name: 'main', tied: true, drain: true } });
      for (const name of names) barclay.send({ type: 'grid', tank: { bus, name, tied: true, fill: true } });
    }
    await waitFor(() => barclay.nav()?.own.grid.ties['system:sif'].join() === 'EPS'); assert.ok(Object.values(cold.drives).every((d) => d.state === 'off') && Object.values(cold.taps).every((t) => t === 0), 'drives off and taps closed');
    // A new ship's starbase connection: only the ODN tied (no power, Deu. or AM), so a hard link to the starbase.
    assert.deepEqual(cold.connections.find((x) => x.kind === 'station')?.ties, { deu: false, am: false, odn: true }, 'a new ship starts with only the ODN tied');
    assert.deepEqual(cold.ties.dock, [], 'a new ship starts with dock power untied');
    ro.send({ type: 'lock', ship: 'Enterprise' });
    await waitFor(() => ro.msgs.some((m) => m.type === 'notice' && /console offline/.test(m.text)));
    // No computer core online: no text messages.
    ro.send({ type: 'text', to: [id('barclay', 'Excelsior')], text: 'testing' });
    await waitFor(() => ro.msgs.some((m) => m.type === 'notice' && /computer core offline/.test(m.text)));
    // Emergency batteries: full and untied on a new ship; tied to Bus B, one carries its loads and runs
    // down (it never recharges); docked, the starbase replaces it with a full one.
    assert.deepEqual(cold.emerg.map((b) => [b.bus, b.pct]), [['A', 100], ['B', 100], ['C', 100]], 'a new ship starts with full emergency batteries, one per bus');
    assert.deepEqual(cold.tieNodes.emergB, ['B'], 'an emergency battery ties only to its own bus');
    barclay.send({ type: 'grid', ties: { emergB: ['B'] } });
    await waitFor(() => barclay.nav()?.own.grid.emerg[1].supplying > 0);
    await waitFor(() => barclay.nav()?.own.grid.emerg[1].level < cold.emerg[1].level - 20);
    barclay.send({ type: 'grid', ties: { emergB: [] }, emergReplace: 'emergB' }); // (untied, so it isn't drawn on again)
    await waitFor(() => barclay.nav()?.own.grid.emerg[1].pct === 100 && barclay.nav().own.grid.emerg[1].level === cold.emerg[1].level);
    step('a new ship had full, untied emergency batteries, one per bus; tied, Battery B\'s ran down carrying Bus B\'s loads, and the starbase replaced it with a full one');
    barclay.send({ type: 'grid', conn: { with: 'station', res: 'power', imp: true }, ties: { dock: ['B'], crosslink: ['A', 'B'] } }); // dock power: imported, on Bus B, shared with A
    await waitFor(() => barclay.nav()?.own.grid.consoleOk.Tactical && barclay.nav().own.power.lifeSupport === 100);
    // The computer cores boot by themselves in stages (about 14 s) once tied and powered; one on an unpowered bus can't.
    await waitFor(() => barclay.nav()?.own.grid.computers[0].state === 'booting' && barclay.nav().own.grid.computers[0].stage);
    assert.equal(barclay.nav().own.grid.computers[2].state, 'off', 'core 3 (on an unpowered Bus C) booted');
    step(`no computer core online: no text messages; with dock power, core 1 booted by itself (${barclay.nav().own.grid.computers[0].stage}); core 3 (on an unpowered Bus C) stayed off`);
    assert.ok(barclay.nav().own.grid.crossflow.AB < 0, `Bus A drew on Bus B's dock power across the crosslink (${JSON.stringify(barclay.nav().own.grid.crossflow)})`);
    // The crosslink is a chain, A–B–C: A and C only link through B.
    barclay.send({ type: 'grid', ties: { crosslink: ['A', 'C'] } });
    await waitFor(() => barclay.msgs.some((m) => m.type === 'notice' && /A and C link only through B/.test(m.text)));
    assert.deepEqual(barclay.nav().own.grid.ties.crosslink, ['A', 'B']);
    // The transporter: a level-3 diagnostic before anyone is beamed; the pattern buffers losing power undo it.
    barclay.send({ type: 'grid', ties: { 'console:Transporter': ['B'] } });
    const kirk = await crewWs('kirk', 'Excelsior', 'Transporter');
    await waitFor(() => barclay.nav()?.own.grid.consoleOk.Transporter);
    kirk.send({ type: 'transporter-lock', ship: 'Excelsior' });
    kirk.send({ type: 'beam', who: id('kirk', 'Excelsior'), station: 'Crew' });
    await waitFor(() => kirk.msgs.some((m) => m.type === 'notice' && /run a level-3 diagnostic first/.test(m.text)));
    kirk.send({ type: 'transporter-diagnostic' });
    await waitFor(() => kirk.msgs.some((m) => m.type === 'notice' && /level-3 diagnostic passed/.test(m.text)), 10000);
    barclay.send({ type: 'grid', ties: { 'sub:patternBuffers': [] } });
    await waitFor(() => kirk.msgs.some((m) => m.type === 'notice' && /diagnostic invalidated: the pattern buffers lost power/.test(m.text)));
    barclay.send({ type: 'grid', ties: { 'sub:patternBuffers': ['B'] } });
    kirk.send({ type: 'transporter-lock', ship: null });
    await waitFor(() => barclay.nav()?.own.transporter.lock === null);
    kirk.close();
    step("the Excelsior's transporter refused to energize before a level-3 diagnostic; the diagnostic passed, and the pattern buffers losing power invalidated it");
    // Loads have their own ties: consoles on Bus A or B only; engines (high power) on the EPS only.
    barclay.send({ type: 'grid', ties: { 'console:Tactical': ['EPS'] } });
    await waitFor(() => barclay.msgs.some((m) => m.type === 'notice' && /Tactical can only be tied to Bus A \+ Bus B/.test(m.text)));
    barclay.send({ type: 'grid', ties: { 'system:engines': ['A'] } });
    await waitFor(() => barclay.msgs.some((m) => m.type === 'notice' && /engines can only be tied to EPS/.test(m.text)));
    barclay.send({ type: 'grid', ties: { 'console:Tactical': ['A'], 'system:lateral': ['B'] } });
    await waitFor(() => { const g = barclay.nav()?.own.grid; return g?.ties['console:Tactical'].join() === 'A' && g.ties['system:lateral'].join() === 'B' && g.cells['console:Tactical'].A === 2 && g.cells['system:lateral'].B === 10; });
    barclay.send({ type: 'grid', core: 'start' });
    await waitFor(() => barclay.msgs.some((m) => m.type === 'notice' && /needs antimatter and deuterium/.test(m.text)));
    // Supplies come through the starbase connection: Import. Antimatter needs its
    // containment powered (and the antimatter bus up): none comes aboard without them.
    barclay.send({ type: 'grid', conn: { with: 'station', res: 'am', imp: true }, connTie: { res: 'am', on: true } });
    barclay.send({ type: 'grid', ties: { containment: ['C'] } }); // nothing on Bus C
    await waitFor(() => /containment|antimatter bus/.test(barclay.nav()?.own.grid.connections?.[0]?.am.why || ''));
    assert.equal(barclay.nav().own.grid.antimatter, 0, 'no antimatter without its containment and the antimatter bus');
    barclay.send({ type: 'grid', ties: { containment: ['A'] } });
    barclay.send({ type: 'grid', conn: { with: 'station', res: 'deu', imp: true }, connTie: { res: 'deu', on: true } });
    await waitFor(() => barclay.nav()?.own.grid.fuel.deu.tanks.reduce((a, x) => a + x.level, 0) >= 395, 20000); // (the systems' tanks take theirs over the bus as it comes in)
    // (The drives' tanks fill from the deuterium tank over the bus; a chamber lights at 30%.)
    await waitFor(() => { const ts = barclay.nav()?.own.grid.fuel.deu.tanks; return ts && ['port', 'starboard', 'core'].every((n) => ts.find((x) => x.name === n).pct >= 30); }, 10000);
    // The warp core needs antimatter in its tank (the antimatter bus moves nothing
    // without its magnetic containment, on the EPS) and the structural integrity field
    // (EPS), and the EPS needs its manifold pressurized, from 100 or more of EPS generation: both impulse drives.
    barclay.send({ type: 'grid', core: 'start' });
    await waitFor(() => barclay.msgs.some((m) => m.type === 'notice' && /needs antimatter and deuterium in its tanks/.test(m.text)));
    assert.equal(barclay.nav().own.grid.fuel.am.down, true, 'the antimatter bus is down without its containment');
    for (const d of ['port', 'starboard']) barclay.send({ type: 'grid', reactor: { name: d, on: true, accel: 100, gear: 'high' } });
    await waitFor(() => { const g = barclay.nav()?.own.grid; return g?.drives.port.state === 'running' && g.drives.starboard.state === 'running'; }, 15000);
    assert.equal(barclay.nav().own.grid.epsLive, false, 'the manifold is still charging');
    await waitFor(() => barclay.nav()?.own.grid.epsLive && barclay.nav().own.power.sif >= 50, 20000);
    await waitFor(() => !barclay.nav().own.grid.fuel.am.down && barclay.nav().own.grid.fuel.am.tanks.find((x) => x.name === 'core').pct >= 30, 10000);
    barclay.send({ type: 'grid', core: 'start' });
    await waitFor(() => barclay.nav()?.own.grid.core === 'online', 20000);
    barclay.send({ type: 'grid', reactor: { name: 'starboard', on: false } });
    await waitFor(() => barclay.nav()?.own.grid.drives.starboard.state === 'off');
    // The warp core's reaction: containment lost under a live reaction starts a
    // 45 s breach countdown; restoring it cancels the countdown. SCRAM stops it at once,
    // and cold ignition needs a deuterium-rich mixture.
    barclay.send({ type: 'grid', ties: { containment: ['C'] } }); // (nothing on Bus C: the reserve, then the field falls)
    await waitFor(() => barclay.msgs.some((m) => m.type === 'notice' && /warp core breach in 45 seconds/.test(m.text)), 30000);
    await waitFor(() => barclay.nav()?.own.grid.warpCore.breachT > 0 && barclay.nav().own.grid.warpCore.breachT < 45); // the countdown runs
    barclay.send({ type: 'grid', ties: { containment: ['A'] } });
    await waitFor(() => barclay.msgs.some((m) => m.type === 'notice' && /breach averted/.test(m.text)), 20000);
    barclay.send({ type: 'grid', core: 'scram' });
    await waitFor(() => barclay.nav()?.own.grid.core === 'offline' && barclay.nav().own.grid.warpCore.actual === 0);
    barclay.send({ type: 'grid', coreMix: 10 });
    barclay.send({ type: 'grid', core: 'start' });
    await waitFor(() => barclay.msgs.some((m) => m.type === 'notice' && /(cold ignition needs a deuterium-rich mixture|injectors won't open)/.test(m.text)));
    barclay.send({ type: 'grid', coreMix: 15 });
    await waitFor(() => barclay.nav()?.own.grid.contain.field >= 95, 20000);
    barclay.send({ type: 'grid', core: 'start' });
    await waitFor(() => barclay.nav()?.own.grid.core === 'online', 20000);
    step('warp core: containment lost under a live reaction started a 45 s breach countdown, restoring it averted the breach; SCRAM stopped the reaction; cold ignition was refused on a lean mixture and relit at 15:1');
    step(`a new ship, the Excelsior, started cold at ${cold.docked} (consoles dark, no fuel); on dock power Engineering moved Tactical's console to Bus A and the lateral sensors to Bus B (consoles only take A or B, engines only the EPS), set a containment feed, imported deuterium (and, once the antimatter bus was up, antimatter) through the starbase connection, filled the systems' tanks over the deuterium bus, lit both impulse drives so the EPS manifold could pressurize (100+ of generation) for the structural integrity field and the antimatter bus's containment, filled the core's antimatter tank, and started the core`);

    // Impulse drives: started on bus power (their pumps), then self-sustaining.
    // Thrusters tied in, a drive moves the ship (half impulse); off, it feeds the EPS.
    barclay.send({ type: 'grid', impulse: { drive: 'port', on: true } });
    await waitFor(() => barclay.nav()?.own.grid.drives.port.state === 'running', 15000);
    await waitFor(() => barclay.nav()?.speed.impulse === 0.125);
    barclay.send({ type: 'grid', ties: { core: [] } }); // the EPS on the port drive alone
    await waitFor(() => barclay.nav()?.own.grid.cells.impulsePort.EPS > 0);
    const fed = barclay.nav().own.grid.cells.impulsePort.EPS;
    barclay.send({ type: 'grid', ties: { core: ['EPS'], thrustersPort: [] } }); // (the core back on the EPS: the hull fields need it for impulse)
    await waitFor(() => { const n = barclay.nav(); return n?.own.grid.cells.impulsePort.EPS === 0 && n.speed.impulse === 0.125; });
    step(`the port impulse drive started on bus power and gave half impulse; with its thrusters tied in, its unused thrust fed the EPS (${fed}); untied, thrust only`);
    // Driver coils: Low gear tops out at a quarter of what High gives.
    barclay.send({ type: 'grid', reactor: { name: 'port', gear: 'low' } });
    await waitFor(() => barclay.nav()?.speed.impulse === 0.03125);
    barclay.send({ type: 'grid', reactor: { name: 'port', accel: 0, gear: 'high' } });
    await waitFor(() => barclay.nav()?.speed.impulse === 0 && /accelerators are at 0/.test(barclay.nav().speed.why.impulse));
    step('driver coils in Low gear gave a quarter of High\'s impulse; accelerators at 0 gave none');
    // An aux fusion reactor: lit on bus power, its output (75) to the EPS.
    barclay.send({ type: 'grid', reactor: { name: 'aux1', on: true } });
    await waitFor(() => barclay.nav()?.own.grid.aux.aux1.state === 'running' && barclay.nav().own.grid.cells.aux1.EPS > 0, 15000);
    const auxFed = barclay.nav().own.grid.cells.aux1.EPS;
    // Drain its tank back into the main storage (which exports to the starbase to make room): dry, it flames out.
    barclay.send({ type: 'grid', conn: { with: 'station', res: 'deu', imp: false, exp: true } });
    barclay.send({ type: 'grid', tank: { bus: 'deu', name: 'main', fill: true } });
    barclay.send({ type: 'grid', tank: { bus: 'deu', name: 'aux1', drain: true } });
    await waitFor(() => barclay.msgs.some((m) => m.type === 'notice' && /aux fusion reactor 1 shut down \(flameout: its deuterium tank ran dry\)/.test(m.text)), 15000);
    barclay.send({ type: 'grid', tank: { bus: 'deu', name: 'main', drain: true } });
    barclay.send({ type: 'grid', tank: { bus: 'deu', name: 'aux1', fill: true } });
    barclay.send({ type: 'grid', conn: { with: 'station', res: 'deu', imp: true, exp: false } });
    step(`aux fusion reactor 1 lit on bus power and fed the EPS (${auxFed}); its tank drained over the bus into the main storage, it flamed out`);
    barclay.send({ type: 'grid', ties: { thrustersPort: ['EPS'] }, impulse: { drive: 'port', on: false } });
    // #2: a battery on Bus A charges from Bus A's surplus even while Bus B and
    // the EPS are short (Bus A is served, and its batteries charged, first).
    await waitFor(() => barclay.nav()?.own.grid.computers[0].state === 'online', 20000); // (the EPS taps need a computer core)
    ro.send({ type: 'text', to: [id('barclay', 'Excelsior')], text: 'core online' });
    await waitFor(() => barclay.msgs.some((m) => m.type === 'text' && m.text === 'core online'));
    barclay.send({ type: 'grid', ties: { dock: [], crosslink: [], core: [] }, tap: { bus: 'A', amount: 0 }, breaker: { bus: 'A', on: true } }); // Bus A on its battery alone: drain it a little
    await waitFor(() => barclay.nav()?.own.grid.stores.A.level <= 97, 15000);
    // Bus B short (its tap narrowed, its battery out of service), Bus A not.
    barclay.send({ type: 'power', power: { replicators: 100, recreation: 100 } });
    barclay.send({ type: 'grid', ties: { core: ['EPS'], dock: [] } });
    barclay.send({ type: 'grid', tap: { bus: 'A', on: true } });
    barclay.send({ type: 'grid', tap: { bus: 'B', amount: 60 } });
    await waitFor(() => { const n = barclay.nav()?.own; return n && n.grid.epsLive && n.grid.stores.A.charging > 0 && SYSTEMS_SHORT(n).length > 0; }, 20000);
    assert.deepEqual(unbalanced(barclay.nav().own.grid), [], 'the columns balance, the EPS taps included');
    step(`with Bus B short (${SYSTEMS_SHORT(barclay.nav().own).join(', ')}), the battery on Bus A still charged from Bus A's share; every column balanced`);
    barclay.send({ type: 'grid', tap: { bus: 'B', on: true } });
    ro.send({ type: 'shields', up: false });
    ro.send({ type: 'arm', on: false });
    barclay.send({ type: 'power', power: { shields: 60, weapons: 50, sensors: 100 } });

    // Breakers: tie more than Bus B carries (300) and it trips loads off at random.
    // (Systems draw what they use, so pile more onto Bus B: life support and Engineering's console;
    // not the warp core's pumps, which a trip would take out, and the core with them.)
    barclay.send({ type: 'grid', ties: { 'system:atmosphere': ['B'], 'system:thermal': ['B'], 'system:gravity': ['B'], 'system:lighting': ['B'], 'console:Engineering': ['B'], containment: ['B'] } });
    await waitFor(() => barclay.msgs.some((m) => m.type === 'notice' && /breaker tripped on Bus B/.test(m.text)));
    await waitFor(() => barclay.nav()?.own.grid.totals.B.tied <= 300);
    step(`over its 300 max, Bus B's breaker tripped loads off (${barclay.msgs.filter((m) => m.type === 'notice' && /breaker tripped/.test(m.text)).map((m) => m.text.split(': ').pop()).join('; ')})`);

    // A low-power system tied to two buses splits its load evenly between them.
    barclay.send({ type: 'power', power: { engines: 40, shields: 40, transporter: 40, replicators: 20, recreation: 10 } }); // plenty to go round
    barclay.send({ type: 'grid', ties: { 'system:gravity': ['A', 'C'] }, tap: { bus: 'C', amount: 300 } });
    await waitFor(() => { const c = barclay.nav()?.own.grid.cells['system:gravity']; return c && c.A === 10 && c.C === 10; });
    step('gravity generators tied to Bus A and Bus C drew half their load (20) from each');
    // The limiter caps what a system draws; it draws what it's using. At 0 it draws nothing.
    barclay.send({ type: 'power', power: { gravity: 0 } });
    await waitFor(() => { const g = barclay.nav()?.own.grid; return g && !g.cells['system:gravity'].A && !g.cells['system:gravity'].C && g.delivered.gravity === 0; });
    barclay.send({ type: 'power', power: { gravity: 100, transporter: 150, shields: 150, weapons: 150 } });
    await waitFor(() => barclay.nav()?.own.allocated.shields === 150);
    { const own = barclay.nav().own, g = own.grid, drew = (k) => Object.values(g.cells[`system:${k}`]).reduce((a, b) => a + b, 0);
      // Idle: no transporter lock, shields down and charged, phasers not armed.
      assert.deepEqual(['transporter', 'shields', 'weapons'].map(drew), [0, 0, 0], 'idle systems under a high limiter draw nothing');
      assert.equal(own.capacity.shields, 150, 'but could draw up to their limit when needed'); }
    barclay.send({ type: 'power', power: { transporter: 100, shields: 40, weapons: 20 } });
    step('a limiter at 0 draws nothing, and idle systems (transporter, shields down, phasers safe) draw nothing under a 150% limiter');


    // Communications' local RF without power: no calls aboard.
    barclay.send({ type: 'grid', ties: { 'sub:rf': [] } });
    await waitFor(() => barclay.nav()?.own.grid.subOk.rf === false).catch(() => { const g = barclay.nav()?.own.grid; throw new Error(`local RF still up: ${JSON.stringify({ rf: g?.subOk.rf, ties: g?.ties['sub:rf'], navs: barclay.msgs.filter((m) => m.type === 'nav').length, last: barclay.msgs.slice(-3).map((m) => m.type + (m.text ? `: ${m.text}` : '')) })}`); });
    barclay.send({ type: 'call', to: id('ro', 'Excelsior'), cid: 'x1' });
    await waitFor(() => barclay.msgs.some((m) => m.type === 'notice' && /local RF has no power/.test(m.text)));
    step("with Communications' local RF untied, a call aboard the Excelsior was refused");
    barclay.close();
    ro.close();

    // Text messages without a call: alice writes to bob and carol together.
    await closeComms(bob);
    await openComms(alice);
    await alice.click(`.comms-msg-pick[data-user="${id('bob')}"]`);
    await alice.click(`.comms-msg-pick[data-user="${id('carol')}"]`);
    await alice.fill('#msg-text', 'Meet in Ten Forward');
    await alice.click('#msg-send');
    for (const page of [bob, carol]) await page.waitForFunction(() => window.__comms.messages.some((m) => m.text === 'Meet in Ten Forward' && m.from === 'alice' && m.to.length === 2));
    await bob.waitForSelector('#comms-button:has-text("1 message")', { state: 'attached' });
    assert.equal(await alice.evaluate(() => window.__voice.state), 'idle', 'no call needed for messages');
    await closeComms(alice);
    step('alice texted bob and carol together without a call; bob\'s Comms button showed the unread message');

    // Rank, species and gender: alice picks hers on the Station screen. Her rank shows to
    // everyone with her name; her species and gender only to people in the same place.
    await screen(alice, 'reassign');
    for (const [k, v] of [['rank', 'Lt. Cmdr.'], ['species', 'Vulcan'], ['gender', 'Female']]) await alice.click(`#station-profile [data-profile="${k}"][data-value="${v}"]`);
    await alice.waitForSelector('#station-sub:has-text("Lt. Cmdr. alice")');
    const aliceAs = (page) => page.evaluate((who) => window.__comms.users.find((u) => u.id === who), id('alice'));
    const aliceAt = await alice.evaluate(() => window.__voice.me.station);
    for (const page of [bob, carol]) {
      await page.waitForFunction((who) => window.__comms.users.find((u) => u.id === who)?.title === 'Lt. Cmdr. alice', id('alice'));
      const there = (await page.evaluate(() => window.__voice.me.station)) === aliceAt, seen = await aliceAs(page);
      assert.deepEqual([seen.species ?? null, seen.gender ?? null], there ? ['Vulcan', 'Female'] : [null, null], `${await page.evaluate(() => window.__voice.me.name)} at ${await page.evaluate(() => window.__voice.me.station)} (alice at ${aliceAt})`);
    }
    assert.equal(await alice.evaluate(() => JSON.parse(localStorage.getItem('stchat-profile')).rank), 'Lt. Cmdr.', 'remembered with the name');
    step("alice took Lt. Cmdr., Vulcan, female on the Station screen: everyone sees \"Lt. Cmdr. alice\"; only people in her place see Vulcan, female");

    // Closing the tab mid-call ends the call for the other side. Meanwhile
    // another ship's Communications can't see this call inside the Enterprise.
    const odan = await crewWs('odan', 'Defiant', 'Communications');
    await callFrom(carol, 'bob');
    await bob.waitForSelector('.v-incoming:not([hidden])');
    await bob.click('.v-accept');
    await carol.waitForFunction(() => window.__voice.connectedTo(1), null, { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 600));
    const seen = [...odan.msgs].reverse().find((m) => m.type === 'traffic');
    assert.ok(!seen || !JSON.stringify(seen.calls).includes('carol'), "the Defiant's Communications saw a call inside the Enterprise");
    odan.close();
    step("another ship's Communications could not see a call inside the Enterprise");
    await carol.close();
    await bob.waitForFunction(() => window.__voice.state === 'idle', null, { timeout: 5000 });
    step('peer going offline ends the call');

    ok = true;
  } catch (err) {
    console.error('FAIL:', err.message, err.stack.split('\n').find((l) => l.includes('e2e.js')));
  } finally {
    await browser.close();
    server.close();
    radioStation.close();
    for (const proc of computers) proc.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    console.log(ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
  }
})();
