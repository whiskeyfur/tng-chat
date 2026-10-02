// The HTTP fallback: a console whose WebSocket can't connect (?transport=http here) signs in,
// sees its ship's state, texts someone, and gets a call's signaling both ways, all over plain
// HTTP (long polling); the footer says so.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { chromium } = require('playwright');

const PORT = Number(process.env.PORT || 8099) + 9;
const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-chat-fallback-'));
const URL = `http://localhost:${PORT}/`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`ok - ${s}`);
const procs = new Set();
const run = (args) => { const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, PORT, STARBASES_FILE: path.join(DATA, 'starbases.json'), RELAY_DATA: DATA }, stdio: 'ignore' }); procs.add(p); p.on('exit', () => procs.delete(p)); return p; };
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(100); } throw new Error('timed out waiting'); };

(async () => {
  let ok = false, browser;
  try {
    run(['server.js']);
    await wait(800);
    run(['tools/shipcore.js', '--relay', `ws://localhost:${PORT}`, '--data', DATA, '--warm', 'Pollship']);
    await wait(2000);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    const page = await (await browser.newContext()).newPage();
    const sockets = [];
    page.on('websocket', (w) => sockets.push(w.url()));
    await page.goto(`${URL}?transport=http`);
    await page.fill('#name', 'hoshi');
    await page.click('#signin-ships button[data-ship="Pollship"]');
    await page.click('#signin-unassigned button[data-station="Communications"]');
    await page.click('#register-go');
    await page.waitForFunction(() => window.__voice?.me?.station === 'Communications');
    await page.waitForSelector('#link[data-transport="http"]:has-text("HTTP fallback")', { timeout: 8000 }).catch(async () => { throw new Error(`link: ${await page.evaluate(() => document.getElementById('link').outerHTML)}`); });
    await page.waitForFunction(() => window.__nav?.last?.own?.grid?.totals);
    assert.deepEqual(sockets, [], 'no WebSocket at all');
    step('a console on the HTTP fallback signed in (no WebSocket), the footer saying "HTTP fallback", and got its ship\'s state');

    // Someone on an ordinary WebSocket aboard: a text each way, then a call's signaling each way.
    const mayweather = new WebSocket(`ws://localhost:${PORT}`), got = [];
    mayweather.on('message', (m) => got.push(JSON.parse(m)));
    await new Promise((r) => mayweather.on('open', r));
    mayweather.send(JSON.stringify({ type: 'register', name: 'mayweather', ship: 'Pollship', station: 'Helm' }));
    await until(() => got.some((m) => m.type === 'registered'));
    await page.waitForFunction(() => window.__comms.users.some((u) => u.name === 'mayweather'));
    const hoshiId = await page.evaluate(() => window.__voice.me.id), mayId = got.find((m) => m.type === 'registered').id;
    await page.evaluate((to) => window.__send({ type: 'text', to: [to], text: 'Hailing frequencies open' }), mayId);
    await until(() => got.some((m) => m.type === 'text' && m.text === 'Hailing frequencies open' && m.from.name === 'hoshi'));
    mayweather.send(JSON.stringify({ type: 'text', to: [hoshiId], text: 'Aye' }));
    await page.waitForFunction(() => /Aye/.test(document.querySelector('#comms')?.textContent || '') || window.__comms.messages?.some?.((m) => m.text === 'Aye'), null, { timeout: 15000 }).catch(() => null);
    step('texts both ways between the HTTP console and a WebSocket one');
    // A call: she rings hoshi (the ring reaches the HTTP console), hoshi's answer comes back.
    mayweather.send(JSON.stringify({ type: 'call', to: hoshiId, cid: 'poll-test', kind: 'voice' }));
    await page.waitForSelector('.v-incoming:not([hidden])', { state: 'attached', timeout: 15000 });
    await page.evaluate((to) => window.__send({ type: 'signal', to, cid: 'poll-test', data: { test: 'answer' } }), mayId);
    await until(() => got.some((m) => m.type === 'signal' && m.from === hoshiId && m.data?.test === 'answer'));
    step("a call's signaling both ways: mayweather's ring reached the HTTP console, and its signal reached her");
    mayweather.close();
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
