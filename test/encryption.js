// Encryption: an enciphered signal is nothing but noise without a decryptor holding its key in the
// chain. In play: the Defiant transmits with its private cipher and hails the Enterprise; the
// Enterprise sees who it's from and for but can't put it through (no key, its Starfleet key won't do);
// the two open a data link and the Defiant shares its key over it; with a decryptor on the Defiant's
// key the Enterprise puts it through. The Excelsior, listening on the Defiant's channel, sees an
// enciphered signal it can't read, its cores working to break it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const SIGNALS = require('../tools/signals');

const step = (s) => console.log(`ok - ${s}`);
const PORT = Number(process.env.PORT || 8099) + 20;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-crypto-'));
const env = { ...process.env, PORT, RELAY_DATA: DATA, STARBASES_FILE: path.join(DATA, 'starbases.json') };
const procs = [];
const run = (args) => { const p = spawn(process.execPath, args, { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' }); procs.push(p); return p; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function connect(hello) {
  const ws = new WebSocket(`ws://localhost:${PORT}`), msgs = [];
  ws.on('message', (m) => msgs.push(JSON.parse(m)));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify(hello));
  let since = 0;
  const until = async (pred, what, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const m = msgs.slice(since).reverse().find(pred); if (m) return m; await wait(100); } throw new Error(`timed out: ${what}`); };
  return { ws, msgs, until, send: (m) => { since = msgs.length; ws.send(JSON.stringify(m)); }, own: () => [...msgs].reverse().find((m) => m.type === 'nav' && m.own)?.own };
}

let ok = false;
(async () => {
  try {
    const sig = { channel: 300, strength: 0.9, phase: 0, interference: 0, cipher: 'private:defiant' };
    assert.equal(SIGNALS.quality(sig, [{ type: 'filter', channel: 300 }]).quality, 0, 'no decryptor: noise');
    assert.equal(SIGNALS.quality(sig, [{ type: 'decrypt', cipher: 'starfleet' }]).quality, 0, 'the wrong key: noise');
    assert.ok(SIGNALS.quality(sig, SIGNALS.bestChain(sig)).quality >= SIGNALS.QUALITY_TO_ROUTE, 'its key: clean');
    step('the reckoning: an enciphered signal is noise without a decryptor holding its key, clean with one');

    run(['server.js']); await wait(1200);
    for (const [f, pos, n] of [['e', '500,300', 'Enterprise'], ['d', '560,330', 'Defiant'], ['x', '520,360', 'Excelsior']]) run(['tools/shipcore.js', '--relay', `ws://localhost:${PORT}`, '--data', path.join(DATA, f), '--warm', '--position', pos, '--class', 'galaxy', n]);
    await wait(3000);
    const sisko = await connect({ type: 'register', name: 'sisko', ship: 'Defiant', station: 'Captain' });
    const nog = await connect({ type: 'register', name: 'nog', ship: 'Defiant', station: 'Communications' });
    const dax = await connect({ type: 'operator', name: 'dax', ship: 'Defiant' });
    const picard = await connect({ type: 'register', name: 'picard', ship: 'Enterprise', station: 'Captain' });
    const uhura = await connect({ type: 'register', name: 'uhura', ship: 'Enterprise', station: 'Communications' });
    const spy = await connect({ type: 'register', name: 'spy', ship: 'Excelsior', station: 'Communications' });
    await nog.until((m) => m.type === 'nav' && m.own?.comm, 'the Defiant\'s comms');
    nog.send({ type: 'comms', cipher: 'private' });
    await nog.until((m) => m.type === 'nav' && m.own?.comm?.cipher === 'private:defiant', 'enciphering with its own');
    spy.send({ type: 'comms', listen: nog.own().comm.channel });
    const siskoId = sisko.msgs.find((m) => m.type === 'registered').id, picardId = (await picard.until((m) => m.type === 'registered', 'Picard')).id;
    dax.send({ type: 'hail', crew: siskoId, ship: 'Enterprise' });
    const hail = (await uhura.until((m) => m.type === 'nav' && m.own?.signals?.some((x) => x.kind === 'hail' && x.addressed), 'the hail on the Enterprise')).own.signals.find((x) => x.kind === 'hail');
    assert.ok(hail.cipher === 'private:defiant' && !hail.keyed && hail.from === 'Defiant', `enciphered, no key, from the Defiant (${JSON.stringify(hail)})`);
    uhura.send({ type: 'comms', route: { hail: hail.id, to: picardId, chain: [{ type: 'decrypt', cipher: 'starfleet' }, ...SIGNALS.bestChain({ ...hail, cipher: null })] } });
    await uhura.until((m) => m.type === 'notice' && /too noisy/.test(m.text), 'refused: noise without the key');
    step(`the Defiant hails enciphered (${hail.cipherName}): the Enterprise sees it's from the Defiant but can't put it through with the Starfleet key`);
    // (A data link, then the key over it.)
    dax.send({ type: 'link-request', ship: 'Enterprise' });
    const req = (await uhura.until((m) => m.type === 'comm-links' && m.linkIncoming?.length, 'the link request at the Enterprise\'s Communications')).linkIncoming[0];
    uhura.send({ type: 'link-accept', request: req.id });
    await nog.until((m) => m.type === 'nav' && m.own?.comm?.linked?.includes('Enterprise'), 'the data link open');
    nog.send({ type: 'comms', shareKey: 'Enterprise' });
    await uhura.until((m) => m.type === 'nav' && m.own?.signals?.some((x) => x.id === hail.id && x.keyed), 'the Enterprise holding the key');
    uhura.send({ type: 'comms', route: { hail: hail.id, to: picardId, chain: SIGNALS.bestChain(hail) } });
    await picard.until((m) => m.type === 'connect' && m.peers?.some((p) => p.name === 'sisko'), 'Picard connected to Sisko').catch((e) => { console.log('# uhura:', JSON.stringify(uhura.msgs.filter((m) => m.type === 'notice').slice(-2))); throw e; });
    step('a data link opened, the Defiant shared its key over it; with a decryptor on that key, the Enterprise put the hail through');
    // (The listener: an enciphered signal it can't read, its cores at it.)
    dax.send({ type: 'hail', crew: (await nog.until((m) => true, 'x')) && nog.msgs.find((m) => m.type === 'registered').id, ship: 'Enterprise' });
    const seen = await spy.until((m) => m.type === 'nav' && m.own?.signals?.some((x) => x.cipher === 'private:defiant' && x.breaking > 0), 'the Excelsior breaking it', 15000);
    const x = seen.own.signals.find((y) => y.cipher === 'private:defiant');
    assert.ok(!x.keyed && !x.parties, 'it can\'t read who\'s talking');
    step(`the Excelsior, listening on the Defiant's channel, sees an enciphered signal (${x.cipherName}) it can't read; its cores have it ${Math.round(x.breaking * 100)}% broken`);
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
