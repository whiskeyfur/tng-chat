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
    '--relay', `ws://localhost:${process.env.PORT}`, '--data', path.join(DATA_DIR, folder), ...(opts.cold ? [] : ['--warm', '--position', START[ships[0]] || '500,500']), ...ships], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => process.stdout.write(String(d).replace(/^(?=.)/gm, `  [computer ${folder}] `)));
  proc.stderr.on('data', (d) => process.stdout.write(String(d).replace(/^(?=.)/gm, `  [computer ${folder} ERR] `)));
  computers.add(proc);
  proc.on('exit', () => computers.delete(proc));
  return proc;
}
startComputer.cold = (folder, ship) => startComputer(folder, ship, { cold: true });
const stopComputer = (proc) => new Promise((r) => { proc.once('exit', r); proc.kill(); });
const stored = (folder, ship, name) => { try { return fs.readFileSync(path.join(DATA_DIR, folder, ship, name), 'utf8'); } catch { return null; } };
const SYSTEMS_SHORT = (own) => Object.keys(own.grid.demand).filter((k) => own.grid.delivered[k] < own.grid.demand[k]);
// The transporter's TOS energize sliders: all three to the top.
const energize = async (page) => { await page.waitForFunction(() => [...document.querySelectorAll('.tr-slider')].every((r) => Number(r.value) === 0)); for (const n of [1, 2, 3]) await page.$eval(`#beam-slider-${n}`, (r) => { r.value = 100; r.dispatchEvent(new Event('input', { bubbles: true })); }); };
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
    assert.equal(await alice.locator('#st-ship .st-ship').count(), 1, 'crew console shows the ship');

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
    assert.equal(await kor.locator('#st-ship .st-ship').count(), 1, 'engineering console has the ship schematic');
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
    await chief.waitForSelector('#beam-who button[data-value="wes@enterprise"]', { state: 'attached' });
    await screen(carol, 'st-shieldctl');
    await carol.click('[data-shield-control] button');
    await chief.waitForFunction(() => document.body.hasAttribute('data-shields-up'));
    await op.waitForSelector('#shield-state:has-text("Up")', { state: 'attached' });
    await screen(chief, 'st-transporter');
    await chief.click(`#beam-who button[data-value="${id('wes')}"]`);
    await chief.click('#beam-ship button[data-value="K\'Vatch"]');
    await energize(chief);
    await chief.waitForSelector('#beam-status:has-text("cannot beam through the shields of the Enterprise")');
    assert.equal(await wes.evaluate(() => window.__voice.me.ship), 'Enterprise');
    step('shields up: the transporter cannot beam anyone off the ship');

    await carol.click('[data-shield-control] button');
    await chief.waitForFunction(() => !document.body.hasAttribute('data-shields-up'));
    await chief.click(`#beam-who button[data-value="${id('wes')}"]`);
    await chief.click('#beam-ship button[data-value="K\'Vatch"]');
    await energize(chief);
    await wes.waitForFunction(() => window.__voice.me?.ship === "K'Vatch");
    await kops.waitForFunction(() => window.__operator.roster.some((u) => u.name === 'wes'));
    await op.waitForFunction(() => !window.__operator.roster.some((u) => u.name === 'wes'));
    await wes.waitForSelector('#users li:has-text("kor")', { state: 'attached' });
    assert.equal(await wes.evaluate(() => window.__voice.me.station), 'Crew');
    step('shields down: the transporter beamed wes to the K\'Vatch, keeping his station');

    // Site to site, to a station: an ensign beamed to the Enterprise's Engineering console.
    const ensign = await (async () => { const sock = new (require('ws'))(`ws://localhost:${process.env.PORT}`); const msgs = []; sock.on('message', (m) => msgs.push(JSON.parse(m))); await new Promise((r) => sock.on('open', r)); sock.send(JSON.stringify({ type: 'register', name: 'ensign', ship: 'Enterprise', station: 'Crew' })); return { sock, msgs }; })();
    await chief.waitForSelector(`#beam-who button[data-value="${id('ensign')}"]`, { state: 'attached' });
    await chief.click(`#beam-who button[data-value="${id('ensign')}"]`);
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
    await uhura.waitForSelector('[data-traffic] li:has-text("alice"):has-text("martok")', { state: 'attached'  });
    assert.match(await uhura.textContent('[data-traffic]'), /Open/);
    assert.deepEqual(await alice.evaluate(() => window.__voice.peerNames()), ['martok'], 'Communications joined the call');
    assert.equal(await uhura.evaluate(() => window.__voice.state), 'idle');
    await uhura.close();
    step('Communications sees alice and martok\'s call in comm traffic without joining it');
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
    const beamSelf = () => rand.send(JSON.stringify({ type: 'beam', who: id('rand'), ship: 'Defiant' }));
    const spock = await openAs(browser, 'spock', 'spock', 'Enterprise', 'Science');
    await spock.waitForSelector('.nav-contacts li[data-ship="Defiant"]', { state: 'attached' });
    await spock.click('.nav-contacts li[data-ship="Defiant"] button:has-text("Scan")');
    await spock.waitForSelector('.nav-scan:has-text("Scan: the Defiant")');
    assert.match(await spock.textContent('.nav-scan'), /Distance\s*10 units \(transporter range\)/);
    assert.match(await spock.textContent('.nav-scan'), /Ops\s*On duty/);
    assert.match(await spock.textContent('.nav-scan'), /Shields\s*Down(?!\s*·)/); // not "Down · 100%"
    await spock.click('.nav-contacts li[data-ship="Defiant"] button:has-text("Plot course")');
    await waitFor(() => suluMsgs.some((m) => m.type === 'course-plotted' && m.label === 'the Defiant'));
    step('Science scanned the Defiant (distance, ops, life signs) and plotted a course for Helm');

    // Helm takes the Enterprise out of subspace range: the data link drops,
    // and the Defiant is no longer in range to hail.
    helm({ dest: { x: 950, y: 950 }, warp: 7 }); // default engine power (80%) gives warp 7.2 at most
    await op.waitForFunction(() => !window.__operator.network.includes('Defiant'), null, { timeout: 20000 });
    await op.waitForFunction(() => !window.__operator.ships.includes('Defiant'));
    await op.waitForSelector('#ops-log li:has-text("out of subspace range")', { state: 'attached' });
    assert.ok((await spock.evaluate(() => window.__nav.last.own.warp)) > 0 || (await spock.evaluate(() => window.__nav.last.own.x)) > 800);
    beamSelf();
    await waitFor(() => randMsgs.some((m) => m.type === 'notice' && /out of transporter range/.test(m.text)));
    step('Helm flew the Enterprise out of subspace range at warp 7: the data link dropped, the Defiant left hailing range, and beaming over is out of range');

    // And back: intercept the Defiant, arriving within transporter range.
    helm({ dest: { ship: 'Defiant' }, warp: 7 });
    await waitFor(async () => { const n = await spock.evaluate(() => window.__nav.last); const d = n?.ships.find((s) => s.name === 'Defiant'); return n?.own.warp === 0 && d && d.distance <= 20; }, 30000);
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
    assert.match(await scotty.textContent('.pw-total'), /EPS 240 .*not routed yet/);
    await scotty.click('#power-reset');
    // Sensors at 20%: every range drops to a fifth, so the transporter (4 units) can't reach.
    await route({ sensors: 20 });
    await spock.waitForFunction(() => Math.round(window.__nav.last.ranges.transporter) === 4 && Math.round(window.__nav.last.ranges.comms) === 80);
    const odell = new WebSocket(`ws://localhost:${process.env.PORT}`);
    const odellMsgs = [];
    odell.on('message', (m) => { try { odellMsgs.push(JSON.parse(m)); } catch {} });
    await new Promise((r) => odell.on('open', r));
    odell.send(JSON.stringify({ type: 'register', name: 'odell', ship: 'Enterprise', station: 'Transporter' }));
    await new Promise((r) => setTimeout(r, 300));
    odell.send(JSON.stringify({ type: 'beam', who: id('odell'), ship: 'Defiant' }));
    await waitFor(() => odellMsgs.some((m) => m.type === 'notice' && /out of transporter range/.test(m.text) && /within 4/.test(m.text)));
    step('Engineering cut sensors to 20%: sensor, subspace and transporter range all fell to a fifth, and beaming fell short');
    // Overdrive: sensors past their rating reach further but wear out.
    await route({ sensors: 120 }); // (150 would overload Bus A and trip its breaker)
    await spock.waitForFunction(() => Math.round(window.__nav.last.ranges.sensors) > 600 && window.__nav.last.own.combat.damage.sensors > 0, null, { timeout: 15000 });
    step(`sensors overdriven to 120%: range ${Math.round(await spock.evaluate(() => window.__nav.last.ranges.sensors))} (past 600), and the overdrive damaged them`);

    // No engine power: no warp. No shield power: Tactical can't raise shields. Low life support: everyone is warned.
    await route({ sensors: 100, engines: 0, shields: 0, lifeSupport: 40 });
    await waitFor(async () => (await spock.evaluate(() => window.__nav.last.speed.warp)) === 0);
    helm({ dest: { ship: 'Defiant' }, warp: 5 });
    await waitFor(() => suluMsgs.some((m) => m.type === 'notice' && /no power to the engines/.test(m.text)));
    await closeComms(carol);
    await screen(carol, 'st-shieldctl');
    await carol.waitForSelector('[data-shield-control] button:has-text("Raise shields"):disabled');
    await bob.waitForSelector('.bcast--alert:has-text("Life support at 40%")', { state: 'attached' });
    step('no engine power refused warp, no shield power disabled Raise shields, and low life support warned the crew');
    await route({ engines: 80, shields: 60, lifeSupport: 100 });
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
    const randBeams = () => rand.send(JSON.stringify({ type: 'beam', who: id('rand', 'Defiant'), ship: 'Enterprise' }));
    randBeams();
    await waitFor(() => randMsgs.some((m) => m.type === 'notice' && /transporter lockout/.test(m.text)));
    await worf.click('[data-security] button:has-text("Drop force field")');
    await worf.waitForSelector('[data-security] .st-state:has-text("lockout: off")');
    randBeams();
    await worf.waitForSelector('#sec-alerts li:has-text("rand (Transporter) beamed aboard from the Defiant")');
    await worf.waitForSelector('.bcast--alert:has-text("Security: rand")', { state: 'attached' });
    step('Security: the force field refused a beam-in; with it down, Security was alerted when rand beamed aboard');

    // Security seals the Helm console with a force field: Helm's orders are refused until it drops.
    await worf.click('#sec-fields button[data-station="Helm"]');
    await worf.waitForSelector('#sec-fields button[data-station="Helm"][aria-pressed="true"]');
    helm({ warp: 0 });
    await waitFor(() => suluMsgs.some((m) => m.type === 'notice' && /console sealed by a Security force field/.test(m.text)));
    await worf.click('#sec-fields button[data-station="Helm"]');
    await worf.waitForSelector('#sec-fields button[data-station="Helm"][aria-pressed="false"]');
    step('Security sealed the Helm console with a force field (its orders refused), then dropped it');

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
    await bob.waitForFunction(() => window.__voice.me.station === 'Medical');
    const picard = await openAs(browser, 'picard', 'picard', 'Enterprise', 'Captain');
    await picard.waitForSelector('#st-dept li[data-dept="Tactical"][data-manned]', { state: 'attached' });
    await closeComms(bob);
    await screen(bob, 'st-sickbay');
    await bob.click('.st-patients li[data-crew="carol@enterprise"] button:has-text("Admit")');
    await picard.waitForSelector('#st-dept li[data-dept="Tactical"]:not([data-manned])', { state: 'attached' });
    await bob.click('.st-patients li[data-crew="carol@enterprise"] button:has-text("Discharge")');
    await picard.waitForSelector('#st-dept li[data-dept="Tactical"][data-manned]', { state: 'attached' });
    step('the First Officer reassigned bob to Medical; carol in sickbay left Tactical unmanned until discharged');

    // The Captain: orders to every console, red alert (shields up, frames red), then green.
    await screen(picard, 'st-command');
    await picard.fill('#order-text', 'All hands, prepare for first contact');
    await picard.click('#order-send');
    await bob.waitForSelector('.bcast--order:has-text("prepare for first contact")', { state: 'attached' });
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
    obrien.send({ type: 'power', power: { engines: 0, injectors: 0, shields: 0, sensors: 20, transporter: 0, weapons: 0, lifeSupport: 60, replicators: 0, recreation: 0 } });
    await nog.waitForSelector('[data-readout="Replicators"]:has-text("Offline")', { state: 'attached' });
    await waitFor(() => obrien.nav()?.own.signature < 0.42);
    await spock.waitForSelector('.nav-contacts li[data-ship="Defiant"]', { state: 'detached' });
    await carol.waitForSelector('#weapons-lock-state:has-text("No weapons lock")');
    step(`the Defiant powered down (replicators and holodecks too: its Crew consoles show them offline) to a ${Math.round(obrien.nav().own.signature * 100)}% signature: off the Enterprise's sensors 250 units away, and the weapons lock was lost`);
    obrien.send({ type: 'power', power: { engines: 80, injectors: 80, shields: 60, sensors: 100, transporter: 60, weapons: 50, lifeSupport: 100, replicators: 40, recreation: 10 } });
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

    // The power grid: with the core shut down and the batteries off, Bus B is
    // dead: Tactical's console goes dark and refuses orders. Restarting the
    // core (on dock power, Bus A) brings it back.
    const laforge = await crewWs('laforge', 'Enterprise', 'Engineering');
    laforge.send({ type: 'grid', core: 'stop', ties: { battery: [] }, tap: { bus: 'B', amount: 0 } }); // (the impulse drives still feed the EPS)
    await carol.waitForSelector('#console-dark:not([hidden])');
    await waitFor(() => laforge.nav()?.speed.warp === 0); // no warp (the impulse drives still run on their own)
    await carol.$eval('#fire-torpedo', (b) => { b.disabled = false; b.click(); });
    await waitFor(async () => /console offline, no power on its bus/.test(await carol.textContent('#log')));
    laforge.send({ type: 'grid', core: 'start', tap: { bus: 'B', amount: 300 } });
    await waitFor(() => laforge.nav()?.own.grid.core === 'starting');
    await carol.waitForSelector('#console-dark', { state: 'hidden', timeout: 20000 });
    await waitFor(() => laforge.nav()?.own.grid.core === 'online', 20000);
    step("the warp core shut down, batteries off and Bus B's EPS tap closed left Bus B dead (Tactical dark, no warp); restarted on dock power with the tap open, the consoles came back");

    // Ties are any combination of what a source allows: batteries on both
    // buses (not the EPS); the warp core feeds the EPS only. Containment can't
    // be left with no feed.
    laforge.send({ type: 'grid', ties: { battery: ['A', 'B'], crosslink: ['A', 'B'] } });
    await waitFor(() => laforge.nav()?.own.grid.ties.battery.join() === 'A,B' && laforge.nav().own.grid.ties.crosslink.join() === 'A,B');
    laforge.send({ type: 'grid', ties: { core: ['A', 'EPS'] } });
    await waitFor(() => laforge.msgs.some((m) => m.type === 'notice' && /warp core can only be tied to EPS/.test(m.text)));
    laforge.send({ type: 'grid', ties: { battery: ['EPS'] } });
    await waitFor(() => laforge.msgs.some((m) => m.type === 'notice' && /batteries can only be tied to Bus A \+ Bus B/.test(m.text)));
    laforge.send({ type: 'grid', ties: { containment: [] } });
    await waitFor(() => laforge.msgs.some((m) => m.type === 'notice' && /containment can't be switched off/.test(m.text)));
    step('batteries tied to Bus A and B and the A-B crosslink on; the warp core (EPS only) and batteries (no EPS) refused other ties; containment could not be left without a feed');

    // Engineering ejects the warp core: no antimatter, no core power.
    laforge.send({ type: 'grid', eject: true });
    await waitFor(() => laforge.nav()?.own.grid.core === 'ejected' && !laforge.nav().own.grid.antimatter);
    step('Engineering ejected the warp core and antimatter pods');

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
    laforge.send({ type: 'grid', refit: true });
    await waitFor(() => laforge.nav()?.own.grid.core === 'offline' && laforge.nav().own.grid.antimatter === 1000);
    laforge.send({ type: 'grid', core: 'start' });
    await waitFor(() => laforge.nav()?.own.grid.core === 'online', 20000);
    step('towed back to Starbase 12 and released, the Enterprise docked, had a new warp core and full antimatter pods installed, and started it');

    // Supplies: the Enterprise offloads deuterium to the starbase; the Defiant
    // docks with the Enterprise and sends it some of its own.
    laforge.send({ type: 'grid', transfer: { resource: 'deuterium', dir: 'out', amount: 300 } });
    await waitFor(() => laforge.nav()?.own.grid.deuterium <= 1710 && !laforge.nav().own.grid.transfer, 15000);
    const ent = laforge.nav().own;
    ezri.send({ type: 'helm', dest: { x: ent.x, y: ent.y - 3 }, warp: 1 });
    await waitFor(() => { const n = ezri.nav()?.own; return n && Math.hypot(n.x - ent.x, n.y - (ent.y - 3)) < 1 && n.warp === 0 && n.grid.nearShip === 'Enterprise'; }, 20000);
    ezri.send({ type: 'dock', ship: 'Enterprise' });
    await waitFor(() => laforge.nav()?.own.grid.dockedShip === 'Defiant');
    // Docked together across a restart of the Defiant's computer.
    await new Promise((r) => setTimeout(r, 5500));
    await stopComputer(coreD);
    coreD = startComputer('d', 'Defiant');
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(laforge.nav()?.own.grid.dockedShip, 'Defiant', "restarting the Defiant's computer undocked the ships");
    const rom = await crewWs('rom', 'Defiant', 'Engineering');
    const before = laforge.nav().own.grid.deuterium;
    rom.send({ type: 'grid', transfer: { resource: 'deuterium', dir: 'out', amount: 100 } });
    await waitFor(() => laforge.nav()?.own.grid.deuterium >= before + 90, 15000);
    // Power across the dock: the Defiant offers 100 from its Bus B, the Enterprise 30; 70 flows to the Enterprise's Bus A.
    rom.send({ type: 'grid', ties: { ship: ['B'] }, feed: 100 });
    laforge.send({ type: 'grid', ties: { ship: ['A'] }, feed: 30 });
    await waitFor(() => laforge.nav()?.own.grid.shipIn === 70 && rom.nav()?.own.grid.fed === 70); // (the Enterprise's A and B are crosslinked: it lands on either)
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
    // A full tank: refuelling is refused, and a transfer can always be stopped (#1).
    laforge.send({ type: 'grid', transfer: { resource: 'antimatter', dir: 'in', amount: 500 } });
    await waitFor(() => laforge.msgs.some((m) => m.type === 'notice' && /antimatter tank is already full/.test(m.text)) || laforge.nav()?.own.grid.transfer);
    laforge.send({ type: 'grid', transfer: { resource: 'deuterium', dir: 'in', amount: 500 } });
    await waitFor(() => laforge.nav()?.own.grid.transfer);
    laforge.send({ type: 'grid', transfer: null });
    await waitFor(() => !laforge.nav()?.own.grid.transfer && laforge.msgs.some((m) => m.type === 'notice' && /transfer stopped/.test(m.text)));
    step('the Enterprise offloaded deuterium at Starbase 12; the Defiant docked with it, sent it 100 deuterium, and (offering 100 power to its 30) fed it the difference, 70; then undocked');
    ezri.close();
    tuvok.close();

    // The Captain sets the self-destruct; everyone aboard sees the countdown; aborted.
    picard.on('dialog', (d) => d.accept());
    await screen(picard, 'st-status');
    await picard.click('#self-destruct');
    await bob.waitForSelector('.bcast--alert:has-text("Self-destruct in")', { state: 'attached' });
    await picard.click('#self-destruct-abort');
    await bob.waitForSelector('.bcast--alert:has-text("Self-destruct")', { state: 'detached' });
    step('the Captain set the self-destruct (every console counted down) and aborted it');

    // Containment fed from Bus B with Bus B cut off: the core breaches and the
    // Enterprise is destroyed, then rebuilt docked at a starbase.
    laforge.send({ type: 'grid', ties: { containment: ['B'], core: ['EPS'], battery: [], crosslink: [] } });
    laforge.send({ type: 'grid', tap: { bus: 'B', on: false } });
    await bob.waitForSelector('.bcast--alert:has-text("containment failing")', { state: 'attached' });
    await waitFor(() => suluMsgs.some((m) => m.type === 'destroyed' && /breach/.test(m.cause)), 15000);
    const reborn = suluMsgs.find((m) => m.type === 'destroyed');
    await waitFor(async () => { const n = await spock.evaluate(() => window.__nav.last.own); return n.grid.docked === reborn.base && n.combat.hull === 100 && n.grid.core === 'offline' && n.grid.antimatter === 0 && n.grid.containmentOk; });
    await bob.waitForSelector(`.bcast--alert:has-text("Rebuilt and docked at ${reborn.base}")`, { state: 'attached' });
    await op.waitForSelector('#console-dark:not([hidden])', { state: 'attached' }); // rebuilt cold: dark
    await screen(op, 'reassign'); // but the Station screen still works, to move to a console with power
    await op.waitForSelector('#console-dark', { state: 'hidden' });
    await screen(op, 'status');
    await op.waitForSelector('#console-dark:not([hidden])', { state: 'attached' });
    laforge.send({ type: 'grid', ties: { dock: ['A'], crosslink: ['A', 'B'] } });
    await op.waitForSelector('#console-dark', { state: 'hidden' });
    step(`containment on a dead bus breached the core: the Enterprise was destroyed and rebuilt cold (consoles dark, no fuel) docked at ${reborn.base}; tied to dock power, it came back`);
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
    assert.ok(!odo.msgs.some((m) => m.type === 'destroyed'), 'the starbase was destroyed');
    await stopComputer(sbCore);
    odo.close();
    step("Starbase 74 offered no docking with itself, and a ship's computer run for it left the station in place and unharmed");
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
    assert.ok(['solar', 'dock', 'ship', 'core', 'battery', 'containment', 'crosslink'].every((k) => !cold.ties[k].length), 'a new ship should start with no power source tied in'); assert.ok(Object.values(cold.drives).every((d) => d.state === 'off') && Object.values(cold.taps).every((t) => t === 0), 'drives off and taps closed');
    ro.send({ type: 'lock', ship: 'Enterprise' });
    await waitFor(() => ro.msgs.some((m) => m.type === 'notice' && /console offline/.test(m.text)));
    barclay.send({ type: 'grid', ties: { dock: ['A'], crosslink: ['A', 'B'] } }); // dock power on Bus A, shared with B
    await waitFor(() => barclay.nav()?.own.grid.consoleOk.Tactical && barclay.nav().own.power.lifeSupport === 100);
    // Loads have their own ties: consoles on Bus A or B only; engines (high power) on the EPS only.
    barclay.send({ type: 'grid', ties: { 'console:Tactical': ['EPS'] } });
    await waitFor(() => barclay.msgs.some((m) => m.type === 'notice' && /Tactical can only be tied to Bus A \+ Bus B/.test(m.text)));
    barclay.send({ type: 'grid', ties: { 'system:engines': ['A'] } });
    await waitFor(() => barclay.msgs.some((m) => m.type === 'notice' && /engines can only be tied to EPS/.test(m.text)));
    barclay.send({ type: 'grid', ties: { 'console:Tactical': ['A'], 'system:sensors': ['B'] } });
    await waitFor(() => { const g = barclay.nav()?.own.grid; return g?.ties['console:Tactical'].join() === 'A' && g.ties['system:sensors'].join() === 'B' && g.cells['console:Tactical'].A === 2 && g.cells['system:sensors'].B === 100; });
    barclay.send({ type: 'grid', core: 'start' });
    await waitFor(() => barclay.msgs.some((m) => m.type === 'notice' && /needs antimatter and deuterium/.test(m.text)));
    barclay.send({ type: 'grid', transfer: { resource: 'antimatter', dir: 'in', amount: 200 } });
    await waitFor(() => barclay.msgs.some((m) => m.type === 'notice' && /set a containment feed/.test(m.text)));
    barclay.send({ type: 'grid', ties: { containment: ['A'] } });
    barclay.send({ type: 'grid', transfer: { resource: 'antimatter', dir: 'in', amount: 200 } });
    await waitFor(() => barclay.nav()?.own.grid.antimatter >= 200 && !barclay.nav().own.grid.transfer, 15000);
    barclay.send({ type: 'grid', transfer: { resource: 'deuterium', dir: 'in', amount: 400 } });
    await waitFor(() => barclay.nav()?.own.grid.deuterium >= 400 && !barclay.nav().own.grid.transfer, 20000);
    barclay.send({ type: 'grid', core: 'start' });
    await waitFor(() => barclay.nav()?.own.grid.core === 'online', 20000);
    step(`a new ship, the Excelsior, started cold at ${cold.docked} (consoles dark, no fuel); on dock power Engineering moved Tactical's console to Bus A and sensors to Bus B (consoles only take A or B, engines only the EPS), set a containment feed, took on antimatter and deuterium, and started the core`);

    // Impulse drives: started on bus power (their pumps), then self-sustaining.
    // Thrusters tied in, a drive moves the ship (half impulse); off, it feeds the EPS.
    barclay.send({ type: 'grid', impulse: { drive: 'port', on: true } });
    await waitFor(() => barclay.nav()?.own.grid.drives.port.state === 'running', 15000);
    await waitFor(() => barclay.nav()?.speed.impulse === 0.125);
    barclay.send({ type: 'grid', ties: { core: [] } }); // the EPS on the port drive alone
    await waitFor(() => barclay.nav()?.own.grid.cells.impulsePort.EPS > 0);
    const fed = barclay.nav().own.grid.cells.impulsePort.EPS;
    barclay.send({ type: 'grid', ties: { thrustersPort: [] } });
    await waitFor(() => { const n = barclay.nav(); return n?.own.grid.cells.impulsePort.EPS === 0 && n.speed.impulse === 0.125; });
    step(`the port impulse drive started on bus power and gave half impulse; with its thrusters tied in, its unused thrust fed the EPS (${fed}); untied, thrust only`);
    barclay.send({ type: 'grid', ties: { thrustersPort: ['EPS'] }, impulse: { drive: 'port', on: false } });
    // #2: a battery on Bus A charges from Bus A's surplus even while Bus B and
    // the EPS are short (Bus A is served, and its batteries charged, first).
    barclay.send({ type: 'grid', ties: { dock: ['A'], battery: ['B'], crosslink: [] } }); // Bus B on the battery alone: drain it a little
    await waitFor(() => barclay.nav()?.own.grid.battery.charge <= 97, 15000);
    barclay.send({ type: 'power', power: { engines: 100, shields: 100, transporter: 100 } });
    barclay.send({ type: 'grid', ties: { battery: ['A'], core: ['EPS'], dock: [] } });
    barclay.send({ type: 'grid', tap: { bus: 'A', on: true } });
    barclay.send({ type: 'grid', tap: { bus: 'B', on: true } });
    await waitFor(() => { const n = barclay.nav()?.own; return n && n.grid.battery.charging > 0 && SYSTEMS_SHORT(n).length > 0; });
    step(`with the warp core overloaded (short: ${SYSTEMS_SHORT(barclay.nav().own).join(', ')}), the battery on Bus A still charged from Bus A's share`);

    // Breakers: tie more than Bus B carries (300) and it trips loads off at random.
    barclay.send({ type: 'power', power: { replicators: 100, recreation: 100, transporter: 100 } });
    await waitFor(() => barclay.msgs.some((m) => m.type === 'notice' && /breaker tripped on Bus B/.test(m.text)));
    await waitFor(() => barclay.nav()?.own.grid.totals.B.tied <= 300);
    step(`over its 300 max, Bus B's breaker tripped loads off (${barclay.msgs.filter((m) => m.type === 'notice' && /breaker tripped/.test(m.text)).map((m) => m.text.split(': ').pop()).join('; ')})`);

    // A low-power system tied to two buses splits its load evenly between them.
    barclay.send({ type: 'power', power: { engines: 40, shields: 40, transporter: 40, replicators: 20, recreation: 10 } }); // plenty to go round
    barclay.send({ type: 'grid', ties: { 'system:lifeSupport': ['A', 'C'] }, tap: { bus: 'C', amount: 300 } });
    await waitFor(() => { const c = barclay.nav()?.own.grid.cells['system:lifeSupport']; return c && c.A === 50 && c.C === 50; });
    step('life support tied to Bus A and Bus C drew half its load from each');

    // A source tied to two buses shares its output evenly: solar on A and C.
    barclay.send({ type: 'grid', ties: { solar: ['A', 'C'] } });
    await waitFor(() => { const c = barclay.nav()?.own.grid.cells.solar; return c && c.A > 0 && c.C > 0 && c.A <= 12.5 + 0.5 && c.C <= 12.5 + 0.5; });
    step(`solar tied to Bus A and Bus C split its 25 between them (${barclay.nav().own.grid.cells.solar.A} + ${barclay.nav().own.grid.cells.solar.C})`);

    // Communications' local RF without power: no calls aboard.
    barclay.send({ type: 'grid', ties: { 'sub:rf': [] } });
    await waitFor(() => barclay.nav()?.own.grid.subOk.rf === false);
    barclay.send({ type: 'call', to: id('ro', 'Excelsior'), cid: 'x1' });
    await waitFor(() => barclay.msgs.some((m) => m.type === 'notice' && /local RF has no power/.test(m.text)));
    step("with Communications' local RF untied, a call aboard the Excelsior was refused");
    barclay.close();
    ro.close();

    // Closing the tab mid-call ends the call for the other side.
    await callFrom(carol, 'bob');
    await bob.waitForSelector('.v-incoming:not([hidden])');
    await bob.click('.v-accept');
    await carol.waitForFunction(() => window.__voice.connectedTo(1), null, { timeout: 20000 });
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
