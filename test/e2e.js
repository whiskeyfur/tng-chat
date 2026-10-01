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
process.env.STATE_FILE = path.join(DATA_DIR, 'relay-state.json'); // remembered ship names
const computers = new Set();
// Start a ship's computer (tools/shipcore.js) for some ships, with its own folder.
function startComputer(folder, ...ships) {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'shipcore.js'),
    '--relay', `ws://localhost:${process.env.PORT}`, '--data', path.join(DATA_DIR, folder), ...ships], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => process.stdout.write(String(d).replace(/^(?=.)/gm, `  [computer ${folder}] `)));
  proc.stderr.on('data', (d) => process.stdout.write(String(d).replace(/^(?=.)/gm, `  [computer ${folder} ERR] `)));
  computers.add(proc);
  proc.on('exit', () => computers.delete(proc));
  return proc;
}
const stopComputer = (proc) => new Promise((r) => { proc.once('exit', r); proc.kill(); });
const stored = (folder, ship, name) => { try { return fs.readFileSync(path.join(DATA_DIR, folder, ship, name), 'utf8'); } catch { return null; } };
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timed out waiting'); };
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
  await page.fill('#ops-ship', ship);
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
    // No ops on duty anywhere: no ships to report aboard.
    const early = await (await browser.newContext()).newPage();
    await early.goto(URL);
    await early.waitForSelector('#ship option:has-text("no ships with ops on duty")', { state: 'attached' });
    // The station picker comes from the relay and includes every station.
    await early.waitForSelector('#station option[value="Transporter"]', { state: 'attached' });
    assert.equal(await early.locator('#station option:not([disabled])').count(), 12); // 11 + Operations
    assert.equal(await early.isDisabled('#register-form button'), true);
    await early.close();
    step('without ops on duty there is no ship to report aboard');

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
    assert.equal(await kops.locator('#net-map .net-node').count(), 2);
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

    // Library: no ship's computer yet, so it's offline.
    await closeComms(alice);
    await screen(alice, 'library');
    await alice.waitForSelector('.lib-status:has-text("computer is offline")');
    assert.equal(await alice.isDisabled('.lib-upload button'), true);
    step("library: with no ship's computer online, the library is offline");

    // Two computers run the Enterprise, one the K'Vatch. Alice uploads; the
    // file goes through the relay (not stored there) to one Enterprise
    // computer and is copied to the other; the K'Vatch (linked) downloads it.
    const coreA = startComputer('a', 'Enterprise');
    let coreB = startComputer('b', 'Enterprise');
    startComputer('k', "K'Vatch");
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

    // The relay remembers the Voyager and still offers it.
    const lobby3 = await (await browser.newContext()).newPage();
    await lobby3.goto(URL);
    await lobby3.waitForSelector('#ship option[value="Voyager"]:has-text("no one aboard")', { state: 'attached' });
    // No OPERATOR_KEY on this relay, so no authorization code field.
    await lobby3.selectOption('#station', 'Operations');
    assert.equal(await lobby3.isVisible('#key'), false, 'code field shown with no key required');
    assert.ok((await lobby3.$$eval('#known-ships option', (o) => o.map((x) => x.value))).includes('Voyager'));
    await lobby3.selectOption('#station', 'Crew');
    await lobby3.fill('#name', 'kim');
    await lobby3.selectOption('#ship', 'Voyager');
    await lobby3.click('#register-form button');
    await lobby3.waitForFunction(() => window.__voice.me?.ship === 'Voyager');
    await lobby3.close();
    assert.ok(JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8')).ships.includes('Voyager'));
    step('the relay remembers past ships (saved to its state file) and offers them; kim reported aboard the empty Voyager');

    // Changing station aboard the same ship.
    await closeComms(carol);
    await screen(carol, 'reassign');
    await carol.selectOption('#new-station', 'Tactical');
    await carol.click('#reassign-form button');
    await carol.waitForFunction(() => window.__voice.me.station === 'Tactical');
    await op.waitForFunction(() => window.__operator.roster.find((u) => u.name === 'carol')?.station === 'Tactical');
    assert.equal(await carol.locator('[data-shield-control] button').count(), 1, 'tactical console has shield control');
    step('carol moved to Tactical; ops and the console follow');

    // Transporter: shields up blocks it; shields down lets wes beam to the K'Vatch.
    const chief = await openAs(browser, 'chief', 'chief', 'Enterprise', 'Transporter');
    const wes = await openAs(browser, 'wes', 'wes', 'Enterprise', 'Crew');
    await wes.waitForFunction(() => window.__voice.myName === 'wes');
    await chief.waitForSelector('#beam-who option[value="wes@enterprise"]', { state: 'attached' });
    await screen(carol, 'st-shieldctl');
    await carol.click('[data-shield-control] button');
    await chief.waitForFunction(() => document.body.hasAttribute('data-shields-up'));
    await op.waitForSelector('#shield-state:has-text("Up")', { state: 'attached' });
    await screen(chief, 'st-transporter');
    await chief.selectOption('#beam-who', id('wes'));
    await chief.selectOption('#beam-ship', "K'Vatch");
    await chief.click('#beam-go');
    await chief.waitForSelector('#beam-status:has-text("cannot beam through the shields of the Enterprise")');
    assert.equal(await wes.evaluate(() => window.__voice.me.ship), 'Enterprise');
    step('shields up: the transporter cannot beam anyone off the ship');

    await carol.click('[data-shield-control] button');
    await chief.waitForFunction(() => !document.body.hasAttribute('data-shields-up'));
    await chief.selectOption('#beam-who', id('wes'));
    await chief.selectOption('#beam-ship', "K'Vatch");
    await chief.click('#beam-go');
    await wes.waitForFunction(() => window.__voice.me?.ship === "K'Vatch");
    await kops.waitForFunction(() => window.__operator.roster.some((u) => u.name === 'wes'));
    await op.waitForFunction(() => !window.__operator.roster.some((u) => u.name === 'wes'));
    await wes.waitForSelector('#users li:has-text("kor")', { state: 'attached' });
    assert.equal(await wes.evaluate(() => window.__voice.me.station), 'Crew');
    step('shields down: the transporter beamed wes to the K\'Vatch, keeping his station');

    // Signed in as Transporter (above); now move from Transporter to Helm.
    assert.equal(await chief.evaluate(() => window.__voice.me.station), 'Transporter');
    await closeComms(chief);
    await screen(chief, 'reassign');
    assert.ok((await chief.$$eval('#new-station option', (o) => o.map((x) => x.value))).includes('Helm'));
    await chief.selectOption('#new-station', 'Helm');
    await chief.click('#reassign-form button');
    await chief.waitForFunction(() => window.__voice.me.station === 'Helm');
    assert.equal(await chief.locator('#st-view canvas').count(), 1, 'helm console after changing station');
    assert.equal(await chief.locator('[data-transporter]').count(), 0);
    await op.waitForFunction(() => window.__operator.roster.find((u) => u.name === 'chief')?.station === 'Helm');
    step('signed in as Transporter, then changed station to Helm');

    // Moving to Operations: chief becomes a second Enterprise operator, and
    // either operator can manage data links.
    await screen(chief, 'reassign');
    await chief.selectOption('#new-station', 'Operations');
    await chief.click('#reassign-form button');
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
    assert.equal(await chief.locator('#new-station option[value="Operations"]').count(), 0);
    await chief.selectOption('#new-station', 'Crew');
    await chief.click('#reassign-form button');
    await chief.waitForFunction(() => window.__voice.me.station === 'Crew' && !window.__operator.roster);
    assert.equal(await chief.locator('.ops-tab:not([hidden])').count(), 0);
    await op.waitForFunction(() => window.__operator.roster.find((u) => u.name === 'chief')?.station === 'Crew');
    step('chief left Operations for Crew; the Enterprise still has ops on duty');

    // Communications sees the calls going on without joining them.
    const uhura = await openAs(browser, 'uhura', 'uhura', 'Enterprise', 'Communications');
    await uhura.waitForSelector('[data-traffic] li:has-text("alice"):has-text("martok")', { state: 'attached' });
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
    // but no new hail to the K'Vatch can start.
    // Re-open the link so we can check it drops with the K'Vatch's ops.
    await screen(op, 'link');
    await screen(kops, 'link');
    await op.click('#link-form button');
    await kops.click('#link-requests li:has-text("Enterprise") button:has-text("Accept")');
    await bob.waitForSelector('#users li:has-text("kor")', { state: 'attached' });
    await kops.close();
    await closeComms(op);
    await op.waitForFunction(() => window.__operator.network.length === 0);
    await bob.waitForFunction(() => !window.__comms.users.some((u) => u.name === 'kor'));
    await martok.waitForSelector('#ops-status:has-text("Ops offline")', { state: 'attached' });
    await op.waitForFunction(() => !window.__operator.ships.includes("K'Vatch"));
    await alice.waitForTimeout(1000);
    assert.equal(await alice.evaluate(() => window.__voice.connectedTo(1)), true);
    await openComms(alice);
    await alice.fill('.v-chat-text', 'still with you');
    await alice.press('.v-chat-text', 'Enter');
    await martok.waitForSelector('.v-chatlog div:has-text("alice: still with you")');
    assert.equal(await op.isDisabled('#hail-form button'), true, 'Enterprise ops can still hail with no ship in range');
    step('ops drops out: the call in progress carries on, the data link closes, new hails are refused');

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
    for (const page of [nog, uhura2, dops]) await page.close();

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
