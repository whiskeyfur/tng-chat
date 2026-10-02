// The LCARS console, for every station including Operations. Crew report
// aboard a ship at a station and get that
// station's displays (stations.js), one screen at a time (screens.js), with
// Comms at the top of the left-hand menu and Library at the bottom. Comms
// opens the shared modal (comms.js): everyone you can call (your ship, plus
// every ship on its data network, ops included) and the call itself
// (voice.js). Library (library.js) is the ship's computer. Other ships are
// reached through ops, or by the transporter room (Transporter station), unless
// shields are up (Tactical station). Signing in at Operations takes the ship's
// ops station instead (any ship name; a new name creates the ship) and shows
// the ops screens from ops.js. The relay (server.js) is found by relay.js.
let ws, me = null;  // me: { id, name, ship, station } once registered
let token = null;   // proves who we are to the library's HTTP endpoints
let stationView = null;
let ops = null;     // the ops screens, when signed in at Operations
let traffic = [];   // calls in progress on our data network (Communications)
let lastNav = null; // ships on sensors and our own position, from the relay
let navPanel = null; // Helm or Science navigation controls (nav.js)
let ships = [];     // [{ name, ops, shields }]
// Where consoles are aboard (the places of the ship's design, from config/ships via the relay)
// and the bridge's seats (the room mic): for my ship, or the one picked to sign in to.
function applyPlaces() {
  const pick = (me?.ship || document.getElementById('ship')?.value || '').toLowerCase();
  const d = window.DESIGNS?.[ships.find((s) => s.name.toLowerCase() === pick)?.classId] || window.DESIGNS?.galaxy;
  window.PLACES = d?.places || [];
  window.SEATS = d?.seats || {};
}
let relayName = 'Comm relay';   // the relay's name, from its hello
let opsKeyRequired = true;      // whether the relay asks ops for an authorization code (from its hello)
let stations = STATION_NAMES; // what the relay accepts (from its hello); all we know until then

const $ = (id) => document.getElementById(id);
function log(text, level) {
  const li = document.createElement('li');
  li.className = 'lcars-log__line' + (level ? ` lcars-log__line--${level}` : '');
  li.textContent = text;
  $('log').prepend(li);
  while ($('log').children.length > 40) $('log').lastChild.remove();
  console.log(text);
}
const send = (msg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

const comms = createComms({
  send, me: () => me, log,
  canShipRadio: () => !!me && (me.station === 'Communications' || !!ops),
  button: $('comms-button'),
  extras: $('transfer-form'), // ops only: hand off the call you're in
  onChange: () => ops?.render(),
});
const bc = createBroadcast({ send, me: () => me, log });
// The room you're in (the bridge, or your station): proximity chat, by seat on the bridge.
const room = createRoomVoice({ send, log, seats: () => window.SEATS || {}, placeOf: (id) => { const u = comms.users.find((x) => x.id === id); return u ? u.console || u.station : null; }, myPlace: () => myPlace() });
function renderRoomMic() {
  const b = $('room-mic');
  b.setAttribute('aria-pressed', String(room.mic));
  b.querySelector('span').textContent = room.mic ? 'Room mic: live' : 'Room mic';
  b.style.setProperty('--accent', room.mic ? 'var(--lcars-red)' : 'var(--lcars-tan)');
}
$('room-mic').onclick = () => {
  room.setMic(!room.mic); renderRoomMic(); renderRoomPanel();
  log(room.mic ? 'room mic live: everyone in the room hears you' : 'room mic off');
  if (document.body.dataset.pane !== 'room') window.openPane('room');
};
// The room mic's panel: your mic, who you hear in the room, who hears you.
function renderRoomPanel() {
  const box = $('room-view');
  if (!box || document.body.dataset.pane !== 'room') return;
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const hearing = room.listening, sending = room.speaking.length;
  const sig = JSON.stringify([room.mic, hearing.map((l) => [l.from, l.connected]), sending]);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.replaceChildren(
    el('p', { className: 'st-state', id: 'room-state', textContent: room.mic ? `Your mic is live: ${sending} in the room hear${sending === 1 ? 's' : ''} you` : 'Your mic is off: tap Room mic to talk' }),
    el('h3', { className: 'ops-subhead', textContent: 'Live in the room' }),
    el('ul', { className: 'st-list', id: 'room-live' }, ...(hearing.length ? hearing.map((l) => el('li', {}, l.from, el('span', { textContent: l.connected ? 'live' : 'connecting' }))) : [el('li', { className: 'empty', textContent: 'Nobody else has their mic on' })])));
}
setInterval(renderRoomPanel, 1000);
window.addEventListener('screenchange', renderRoomPanel);
const library = createLibrary($('library-view'), { token: () => token, base: relay.http, log, canDelete: (s) => s.own && (!!ops || me?.station === 'Communications') });

function setLink(status, text) {
  $('link').dataset.status = status;
  $('link').textContent = text;
}

// Connect as soon as the page loads, so the ship list is live before sign-in.
// If the link drops, sign out locally and reconnect.
function connect() {
  setLink('connecting', 'Comm relay: connecting');
  if (!relay.ws()) {
    setLink('error', 'No comm relay set');
    $('register-error').textContent = 'Enter the comm relay address below to connect.';
    return;
  }
  try {
    ws = new WebSocket(relay.ws());
  } catch {
    setLink('error', 'Comm relay address invalid');
    return;
  }
  ws.onopen = () => setLink('online', `${relayName} online`);
  // Handle messages one at a time so ICE candidates never race ahead of the SDP.
  let queue = Promise.resolve();
  ws.onmessage = (ev) => { queue = queue.then(() => onMessage(JSON.parse(ev.data))).catch((err) => log(`error: ${err}`, 'error')); };
  ws.onclose = () => {
    if (reloading) return waitForRelay(); // the relay is restarting: reload once it's back
    log('signaling disconnected', 'error');
    signedOut('Lost the link to the comm relay. Reconnecting...');
    setLink('error', `Comm relay unreachable: ${relay.address()}`);
    renderShips([]);
    setTimeout(connect, 3000);
  };
}

// The relay restarting (or the pages changing): remember who and where we
// are, reload once the relay is back, and rejoin. Calls aren't resumed.
const REJOIN = 'stchat-rejoin';
let reloading = false;
// Kept up to date while signed in (the screen showing too), so a refresh
// by hand comes back the same way.
// Where you are: your station, or the bridge console you're at (which runs a station).
const myPlace = () => me?.console || me?.station;
const BRIDGE_CONSOLES = ['Bridge 1', 'Bridge 2', 'Bridge 3', 'Bridge 4', 'Bridge 5'];
const CONSOLE_MODES = ['Science', 'Engineering', 'Communications', 'Security', 'Medical'];
const BRIDGE = ['Captain', 'First Officer', 'Helm', 'Tactical', 'Operations', ...BRIDGE_CONSOLES];
const shownScreen = () => [...document.querySelectorAll('[data-screen]')].find((x) => !x.hidden)?.dataset.screen;
function saveRejoin() {
  try { if (me) sessionStorage.setItem(REJOIN, JSON.stringify({ name: me.name, ship: me.ship, station: myPlace(), screen: shownScreen() })); } catch {}
}
window.addEventListener("screenchange", () => { if (me) saveRejoin(); });
window.addEventListener('pagehide', saveRejoin);
let pendingScreen = null;
// After rejoining: back to the screen it was on, if this station has it.
function restoreScreen() {
  const id = pendingScreen;
  pendingScreen = null;
  quietScreen = true;
  if (id && document.querySelector(`[data-screen="${CSS.escape(id)}"]`)) showScreen(id);
  quietScreen = false;
  saveRejoin();
}

// Back (the bottom-left corner): the screens shown at this station, on this
// vessel (a remote one too), newest last. Moving to another station starts
// afresh, so Back never crosses stations. Kept across reloads.
const HISTORY = 'stchat-history';
let screenHistory = { key: null, stack: [], at: null };
try { screenHistory = { ...screenHistory, ...JSON.parse(sessionStorage.getItem(HISTORY) || '{}') }; } catch {}
let quietScreen = false; // showing a screen that isn't a step forward (Back, a rejoin, a station's first screen)
let controllingVessel = null;
const historyKey = () => (me ? `${controllingVessel || me.ship}|${me.station}` : null);
function renderBack() {
  const b = $('back-button');
  if (b) b.disabled = !me || screenHistory.key !== historyKey() || !screenHistory.stack.length;
}
window.addEventListener('screenchange', (ev) => {
  const key = historyKey(), id = ev.detail;
  if (!key) return renderBack();
  if (screenHistory.key !== key) screenHistory = { key, stack: [], at: null };
  else if (!quietScreen && screenHistory.at && screenHistory.at !== id) { screenHistory.stack.push(screenHistory.at); screenHistory.stack.splice(0, screenHistory.stack.length - 50); }
  screenHistory.at = id;
  try { sessionStorage.setItem(HISTORY, JSON.stringify(screenHistory)); } catch {}
  renderBack();
});
document.getElementById('back-button')?.addEventListener('click', () => {
  if (screenHistory.key !== historyKey()) return;
  while (screenHistory.stack.length) {
    const id = screenHistory.stack.pop();
    if (!document.querySelector(`[data-screen="${CSS.escape(id)}"]`)) continue;
    quietScreen = true;
    showScreen(id);
    quietScreen = false;
    return;
  }
  renderBack();
});
// Home (the top-left corner): the station's main screen.
function goHome() {
  if (!me) return;
  showScreen(stationView ? stationView.sections[0].id : 'status');
}
for (const corner of document.querySelectorAll('.lcars-elbow--top')) {
  corner.setAttribute('role', 'button'); corner.tabIndex = 0; corner.setAttribute('aria-label', 'Home');
  corner.addEventListener('click', goHome);
  corner.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); goHome(); } });
}
// The admin panel: shift-click the relay's name at the foot of the console.
// What the supervisor runs (the relay, the ship's computers), who's connected,
// a recent log, and restarting a ship's computer, all of them, or the relay.
// TODO: no access control yet (fine on localhost): add it before this goes live.
let adminTimer = null;
function adminDialog() {
  let d = document.getElementById('admin-dialog');
  if (d) return d;
  d = Object.assign(document.createElement('dialog'), { id: 'admin-dialog', className: 'lcars-modal admin-dialog' });
  d.addEventListener('close', () => { clearInterval(adminTimer); adminTimer = null; });
  document.body.append(d);
  return d;
}
document.getElementById('link')?.addEventListener('click', (ev) => {
  if (!ev.shiftKey) return;
  const d = adminDialog();
  d.replaceChildren(Object.assign(document.createElement('p'), { className: 'ops-hint', textContent: 'Asking the supervisor…' }));
  if (!d.open) d.showModal();
  send({ type: 'admin', action: 'status' });
  clearInterval(adminTimer);
  adminTimer = setInterval(() => send({ type: 'admin', action: 'status' }), 2000);
});
// The admin panel: the supervisor's status (refreshed every 2 s) above, and
// Create ship below (built once per opening, so typing isn't interrupted).
let adminBases = [];
const createDraft = { name: '', cls: null, at: null, x: null, y: null };
// The classes to create: each design in config/ships (the relay's hello), starbase last.
const createClasses = () => Object.entries(window.DESIGNS || {}).sort(([a], [b]) => (a === 'starbase') - (b === 'starbase')).map(([id, d]) => [id, id === 'starbase' ? 'Starbase' : d.name]);
function renderAdmin(st) {
  const d = adminDialog();
  if (!d.open) return;
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const btn = (text, id, onclick, alert) => el('button', { type: 'button', className: `lcars-button lcars-button--pill${alert ? ' lcars-button--alert' : ''}`, id, textContent: text, onclick });
  const ago = (t) => (t ? `${Math.round((Date.now() - t) / 1000)} s` : '');
  if (st.bases) adminBases = st.bases;
  if (!d.querySelector('#admin-status-box')) {
    d.replaceChildren(el('h2', { id: 'admin-title', textContent: 'Relay admin' }), el('p', { className: 'ops-hint', textContent: 'No access control yet: localhost only.' }),
      el('div', { id: 'admin-status-box' }), el('section', { id: 'admin-create' }), btn('Close', 'admin-close', () => d.close()));
    renderCreate(d.querySelector('#admin-create'));
  }
  d.querySelector('#admin-title').textContent = `Relay admin · ${st.relayName || ''}`;
  const box = d.querySelector('#admin-status-box');
  if (st.error) { box.replaceChildren(el('p', { className: 'ops-notice', textContent: st.error })); renderCreate(d.querySelector('#admin-create'), true); return; }
  box.replaceChildren(
    el('p', { className: 'st-state', id: 'admin-relay', textContent: `Relay: ${st.relay?.up ? 'up' : 'down'} on port ${st.relay?.port} · pid ${st.relay?.pid} · ${ago(st.relay?.since)}${st.note ? ` · ${st.note}` : ''}` }),
    el('div', { className: 'ops-form' }, btn('Restart the relay', 'admin-restart-relay', () => { if (confirm('Restart the relay? Every console reloads and signs back in; calls end.')) send({ type: 'admin', action: 'restart-relay' }); }, true),
      btn("Restart every ship's computer", 'admin-restart-ships', () => send({ type: 'admin', action: 'restart-ships' }))),
    el('h3', { textContent: "Ship's computers" }),
    el('ul', { className: 'st-list', id: 'admin-ships' }, ...(st.ships?.length ? st.ships.map((x) => el('li', {}, el('span', { textContent: `${x.ship}: ${x.connected ? 'connected' : 'not connected'}${x.primary?.length ? ', flying it' : ''} · ${ago(x.since)}` }),
      btn('Restart', `admin-restart-${x.ship}`, () => send({ type: 'admin', action: 'restart-ship', ship: x.ship })))) : [el('li', { className: 'empty', textContent: 'none' })])),
    el('h3', { textContent: 'Connected consoles' }),
    el('ul', { className: 'st-list', id: 'admin-consoles' }, ...(st.consoles?.length ? [...new Set(st.consoles.map((u) => u.ship))].sort().flatMap((ship) => [el('li', { className: 'place-ship', textContent: ship }), ...placeNodes(st.consoles.filter((u) => u.ship === ship), (u) => u.console || u.station, (u) => el('li', { textContent: `${u.name} · ${u.ship} · ${u.station}` }), 'li')]) : [el('li', { className: 'empty', textContent: 'none' })])),
    el('h3', { textContent: 'Supervisor log' }),
    el('pre', { className: 'admin-log', id: 'admin-log', textContent: (st.log || []).join('\n') }));
  const pre = box.querySelector('#admin-log'); pre.scrollTop = pre.scrollHeight;
  renderCreate(d.querySelector('#admin-create'), true);
}
// Create ship: a name; a class (taps, none to start); for a ship, the starbase
// it's parked at (taps); for a starbase, a spot on the map. Create stays off
// until it's all there; the relay refuses a name in use.
function renderCreate(box, refresh = false) {
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const tap = (text, value, on, onclick) => { const b = el('button', { type: 'button', className: 'lcars-button lcars-button--pill tr-tap', textContent: text, onclick }); b.dataset.value = value; b.setAttribute('aria-pressed', String(!!on)); return b; };
  if (!box.querySelector('#create-name')) {
    const name = el('input', { className: 'ops-input', id: 'create-name', placeholder: 'Name', autocomplete: 'off', ariaLabel: 'new vessel name', value: createDraft.name });
    name.oninput = () => { createDraft.name = name.value; renderCreate(box, true); };
    box.replaceChildren(el('h3', { textContent: 'Create ship' }), el('div', { className: 'ops-form' }, name),
      el('div', { className: 'tr-pick' }, el('span', { className: 'tr-label', textContent: 'Class' }), el('div', { className: 'tr-taps', id: 'create-class' })),
      el('div', { id: 'create-where' }),
      el('div', { className: 'ops-form' }, el('button', { type: 'button', className: 'lcars-button lcars-button--pill', id: 'create-go', textContent: 'Create', onclick: () => {
        send({ type: 'admin', action: 'create', name: createDraft.name.trim(), cls: createDraft.cls, ...(createDraft.cls === 'starbase' ? { x: createDraft.x, y: createDraft.y } : { at: createDraft.at }) });
      } }), el('span', { className: 'ops-hint', id: 'create-status' })));
  }
  if (!refresh && box.dataset.built) return;
  box.dataset.built = '1';
  box.querySelector('#create-class').replaceChildren(...createClasses().map(([v, n]) => tap(n, v, createDraft.cls === v, () => { createDraft.cls = v; renderCreate(box, true); })));
  const where = box.querySelector('#create-where');
  if (createDraft.cls === 'starbase') {
    // A map of the sector (1000 x 1000): click where the new starbase goes.
    const NS = 'http://www.w3.org/2000/svg', node = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
    const svg = node('svg', { viewBox: '0 0 1000 1000', width: 300, height: 300, id: 'create-map', role: 'img', 'aria-label': 'click where the new starbase goes', style: 'background:#000;border:2px solid var(--lcars-orange);cursor:crosshair' });
    for (const b of adminBases) svg.append(node('circle', { cx: b.x, cy: b.y, r: 12, fill: 'var(--lcars-sky)' }), node('text', { x: b.x + 18, y: b.y + 8, fill: 'var(--lcars-sky)', 'font-size': 36 }, b.name));
    if (createDraft.x != null) svg.append(node('circle', { cx: createDraft.x, cy: createDraft.y, r: 16, fill: 'var(--lcars-gold)', id: 'create-spot' }));
    svg.addEventListener('click', (ev) => { const r = svg.getBoundingClientRect(); createDraft.x = Math.round(((ev.clientX - r.left) / r.width) * 1000); createDraft.y = Math.round(((ev.clientY - r.top) / r.height) * 1000); renderCreate(box, true); });
    where.replaceChildren(el('div', { className: 'tr-pick' }, el('span', { className: 'tr-label', textContent: 'Where' }), svg, el('span', { className: 'ops-hint', textContent: createDraft.x != null ? `at ${createDraft.x}, ${createDraft.y}` : 'click the map' })));
  } else if (createDraft.cls) {
    where.replaceChildren(el('div', { className: 'tr-pick' }, el('span', { className: 'tr-label', textContent: 'Parked at' }), el('div', { className: 'tr-taps', id: 'create-at' },
      ...adminBases.map((b) => tap(b.name, b.name, createDraft.at === b.name, () => { createDraft.at = b.name; renderCreate(box, true); })))));
  } else where.replaceChildren();
  const ready = createDraft.name.trim() && createDraft.cls && (createDraft.cls === 'starbase' ? createDraft.x != null : createDraft.at);
  box.querySelector('#create-go').disabled = !ready;
}

// Rank, species and gender: picked by taps at sign-in or on the Station
// screen, remembered with the name in this browser. Rank shows with your name
// everywhere; species and gender to people in the same place.
const PROFILE = {
  rank: ['Ensign', 'Lt. JG', 'Lieutenant', 'Lt. Cmdr.', 'Commander', 'Captain', 'Admiral', 'Crewman', 'Civilian'],
  species: ['Human', 'Vulcan', 'Klingon', 'Betazoid', 'Andorian', 'Bajoran', 'Trill', 'Ferengi', 'Romulan', 'Cardassian', 'Android', 'Hologram', 'Other'],
  gender: ['Male', 'Female', 'Non-binary', 'Other'],
};
let profile = { rank: null, species: null, gender: null };
try { profile = { ...profile, ...JSON.parse(localStorage.getItem('stchat-profile') || '{}') }; } catch {}
function setProfile(p, tell = true) {
  profile = { ...profile, ...p };
  try { localStorage.setItem('stchat-profile', JSON.stringify(profile)); } catch {}
  if (tell && me) send({ type: 'profile', ...profile });
  for (const box of document.querySelectorAll('[data-profile-taps]')) renderProfileTaps(box);
}
function renderProfileTaps(box) {
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  box.replaceChildren(...Object.entries(PROFILE).map(([k, list]) => el('div', { className: 'tr-pick' }, el('span', { className: 'tr-label', textContent: k[0].toUpperCase() + k.slice(1) }),
    el('div', { className: 'tr-taps', role: 'group', ariaLabel: k }, ...list.map((v) => {
      const b = el('button', { type: 'button', className: 'lcars-button lcars-button--pill tr-tap', textContent: v, onclick: () => setProfile({ [k]: profile[k] === v ? null : v }) });
      b.dataset.profile = k; b.dataset.value = v;
      b.setAttribute('aria-pressed', String(profile[k] === v));
      return b;
    })))));
}
for (const box of document.querySelectorAll('[data-profile-taps]')) renderProfileTaps(box);

// The library tab, offline (no console power or local RF): says why instead of opening.
document.getElementById('library-tab')?.addEventListener('click', (ev) => {
  const t = ev.currentTarget;
  if (!t.hasAttribute('data-offline')) return;
  ev.preventDefault(); ev.stopImmediatePropagation();
  log('Library offline: no console power or local RF');
}, true);

// Shift-click the name and ship in the header: sign out to the sign-in screen
// to start somewhere new. Leaves the ship (and any call), and forgets the
// ship, station, screen and menu so nothing signs back in; the name stays.
document.getElementById('station-sub')?.addEventListener('click', (ev) => {
  if (!ev.shiftKey || !me) return;
  const name = me.name;
  me = null; // (so nothing saves the sign-in again on the way out)
  try {
    sessionStorage.removeItem(REJOIN);
    localStorage.setItem('voice-reg', JSON.stringify({ name }));
  } catch {}
  location.reload();
});
function prepareReload(restart) {
  saveRejoin();
  reloading = true;
  log(restart ? 'the comm relay is restarting: back in a moment' : 'consoles updated: reloading');
  if (!restart) setTimeout(() => location.reload(), 300);
}
function waitForRelay() {
  const probe = () => {
    let t;
    try { t = new WebSocket(relay.ws()); } catch { return setTimeout(probe, 1000); }
    t.onopen = () => { t.close(); location.reload(); };
    t.onerror = () => setTimeout(probe, 1000);
  };
  setTimeout(probe, 1000);
}
// After a reload: sign straight back in (once the ship is in the list).
let rejoin = null;
try { rejoin = JSON.parse(sessionStorage.getItem(REJOIN) || 'null'); } catch {}
function tryRejoin() {
  if (!rejoin || me || !ships.some((x) => x.computer && x.name.toLowerCase() === rejoin.ship.toLowerCase())) return;
  const r = rejoin;
  rejoin = null;
  pendingScreen = r.screen || null;
  if (r.station === 'Operations' && opsKeyRequired) { $('name').value = r.name; return; } // needs the code: sign in by hand
  if (r.station === 'Operations') send({ type: 'operator', name: r.name, ship: r.ship, ...profile });
  else send({ type: 'register', name: r.name, ship: r.ship, station: r.station, ...profile });
  log(`rejoined the ${r.ship} as ${r.name}, ${r.station}`);
}

// Back to the sign-in form when the link to the server drops.
function signedOut(reason) {
  comms.reset(reason);
  bc.reset();
  me = null;
  token = null;
  stationView = null;
  navPanel = null;
  lastNav = null;
  document.body.dataset.alert = 'green';
  ops = null;
  $('ops-view').hidden = true;
  $('transfer-form').hidden = true;
  for (const t of document.querySelectorAll('.ops-tab')) t.hidden = true;
  $('home').hidden = true;
  $('comms-button').hidden = true;
  room.reset(); renderRoomMic();
  $('room-mic').hidden = true;
  $('log-tab').hidden = true;
  $('reassign-tab').hidden = true;
  $('library-tab').hidden = true;
  $('sections').replaceChildren();
  showScreen('register');
  $('station-view').replaceChildren();
  $('register-error').textContent = reason;
  $('register-form').querySelector('button').disabled = false;
  setHeader('LCARS', relayName, 'Report aboard');
  document.title = 'LCARS: Report aboard';
}

function setHeader(code, sub, title) {
  $('station-code').textContent = code;
  $('station-sub').textContent = sub;
  $('station-title').textContent = title;
}

// Ships you can sign in to, ops included: only those with a ship's computer
// online (no ship's computer, no ship). Ships without ops on duty are marked.
function renderShips(all) {
  const ships = all.filter((s) => s.computer);
  const sel = $('ship');
  const keep = sel.value || urlParams.get('ship') || savedReg?.ship || '';
  const placeholder = new Option(ships.length ? 'Ship' : "No ships: start a ship's computer", '');
  placeholder.disabled = true;
  sel.replaceChildren(placeholder, ...ships.map((s) => new Option(s.starbase ? `${s.name} (starbase${s.ops ? '' : ', automated'})` : s.ops ? s.name : `${s.name} (ops offline)`, s.name)));
  const match = ships.find((s) => s.name.toLowerCase() === keep.toLowerCase());
  sel.value = match?.name || '';
  updateSignInMode();
}

// Operations takes the ship's ops station, plus the authorization code if the
// relay asks for one.
const opsSelected = () => $('station').value === 'Operations';
function updateSignInMode() {
  const isOps = opsSelected();
  $('key').hidden = !isOps || !opsKeyRequired;
  $('register-form').querySelector('button').disabled = $('ship').options.length <= 1;
  $('register-form').querySelector('button').textContent = isOps ? 'Take ops station' : 'Report aboard';
}

// Station displays, and a sidebar tab for each one.
function showStation() {
  stationView = renderStation($('station-view'), me.station, { ship: me.ship });
  renderConsoleBar();
  setHeader(stationView.code, `${me.title || me.name} · ${me.ship}`, me.station);
  // The top-left elbow and the header bar running from it share the station's colour.
  document.querySelector('.lcars-header').style.setProperty('--elbow', `var(--lcars-${stationView.color})`);
  $('sections').replaceChildren(...stationView.sections.map((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lcars-nav-button';
    b.dataset.screenTab = s.id;
    b.style.setProperty('--accent', s.color);
    b.append(Object.assign(document.createElement('span'), { textContent: s.title }));
    return b;
  }));
  stationView.setCrew(comms.users);
  // The master systems display, where this station has one.
  const msdRoot = document.querySelector('[data-msd]');
  msd = msdRoot ? createMSD(msdRoot, { open: openSystem, starbase: !!ships.find((x) => x.name.toLowerCase() === me.ship.toLowerCase())?.starbase }) : null;
  renderMSD();
  // Helm and Science fly and watch the ship on the sector map.
  const navRoot = document.querySelector('[data-helm], [data-sensors]');
  navPanel = navRoot ? createNavPanel(navRoot, { mode: navRoot.hasAttribute('data-helm') ? 'helm' : 'science', send }) : null;
  if (lastNav) { navPanel?.update(lastNav); stationView.setNav(lastNav.own); }
  shipStateSig = '';
  powerDraft = null;
  renderPower();
  renderCrewPanels();
  renderShipState();
  renderCombat();
  renderServices();
  fillReassign();
  renderTraffic();
  renderCommLinks();
  quietScreen = screenHistory.key === historyKey();
  showScreen(stationView.sections[0].id);
  quietScreen = false;
  restoreScreen();
}

// A bridge console: buttons along the top pick what it runs (you stay at the console).
function renderConsoleBar() {
  const bar = $('console-bar');
  bar.hidden = !me?.console;
  if (!me?.console) return bar.replaceChildren();
  bar.replaceChildren(Object.assign(document.createElement('span'), { className: 'console-bar__name', textContent: me.console }), ...CONSOLE_MODES.map((m) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'lcars-button lcars-button--pill tr-tap', textContent: m });
    b.dataset.mode = m;
    b.setAttribute('aria-pressed', String(m === me.station));
    b.onclick = () => { if (m !== me.station) send({ type: 'console-mode', mode: m }); };
    return b;
  }));
}

// The Station screen: any other station, Operations included.
// Every station is a tap; Operations asks for the code first if the relay
// wants one. Docked, the vessels across the dock get their own taps.
let dockSig = '';
function fillReassign() {
  if (!me) return;
  $('assignment').textContent = `${me.name}: ${me.console ? `${me.console} (${me.station})` : me.station}, the ${me.ship}`;
  // Every vessel lists every station, Operations included; where you are now is greyed out.
  const tap = (name, ship) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'lcars-button lcars-button--pill tr-tap', textContent: name });
    b.dataset.station = name;
    if (ship) b.dataset.ship = ship;
    if (!ship && name === myPlace()) { b.disabled = true; b.title = 'You are here'; b.setAttribute('aria-current', 'true'); }
    // The brig's force field: nobody walks into the Brig, or out of it.
    else if (!ship && lastNav?.own?.grid?.brigSealed && (name === 'Brig' || myPlace() === 'Brig')) { b.disabled = true; b.title = 'The brig force field is up'; b.textContent = `${name} · brig field up`; }
    b.onclick = () => {
      $('reassign-error').textContent = '';
      if (name === 'Operations' && opsKeyRequired) { $('reassign-form').hidden = false; $('reassign-form').dataset.ship = ship || ''; $('reassign-key').focus(); return; }
      send({ type: 'change-station', station: name, ...(ship ? { ship } : {}) });
    };
    return b;
  };
  // Operations right after First Officer.
  const fo = stations.indexOf('First Officer');
  const all = [...stations.slice(0, fo + 1), 'Operations', ...stations.slice(fo + 1)];
  $('station-taps').replaceChildren(...placeBars(all, (n) => n, (n) => tap(n)));
  const across = lastNav?.own?.grid?.dockedWith || [];
  dockSig = JSON.stringify(across);
  $('dock-stations').replaceChildren(...across.map((v) => {
    const box = document.createElement('div');
    box.className = 'dock-stations';
    box.dataset.vessel = v;
    box.append(Object.assign(document.createElement('h3'), { className: 'ops-subhead', textContent: `Across the dock: ${/^(Starbase|Deep Space) /.test(v) ? v : `the ${v}`}` }),
      Object.assign(document.createElement('div'), { className: 'tr-taps' }));
    box.lastChild.append(...placeBars(all, (n) => n, (n) => tap(n, v)));
    return box;
  }));
  $('reassign-form').hidden = true;
  $('reassign-key').value = '';
}

// Communications runs data links too: request one with a ship in range,
// answer requests, close open links.
let commLinks = null;
// (With the data network map, as Ops has: netmap.js.)
let commMap = null;
function renderCommLinks() {
  const box = document.querySelector('[data-links]');
  if (!box || !commLinks) return;
  const wrap = document.querySelector('[data-netmap]');
  if (wrap && window.createNetMap && commLinks.graph) {
    if (!wrap.firstChild) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'net-map'); svg.id = 'comm-net-map'; svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Ships and the data links between them');
      wrap.append(svg);
      commMap = createNetMap({ svg, details: document.querySelector('[data-netmap-details]'), send, own: () => me.ship });
    }
    commMap.update({ graph: commLinks.graph, links: commLinks.links, hardLinks: commLinks.hardLinks, linkShips: commLinks.ships, linkIncoming: commLinks.linkIncoming, linkOutgoing: commLinks.linkOutgoing, network: commLinks.network });
    window.__commMap = commMap;
  }
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const btn = (text, onclick, alert) => el('button', { type: 'button', className: `lcars-button lcars-button--pill tr-tap${alert ? ' lcars-button--alert' : ''}`, textContent: text, onclick });
  const status = box.querySelector('#links-status')?.textContent || '';
  const linked = new Set(commLinks.links), pending = new Set([...commLinks.linkOutgoing.map((r) => r.toShip), ...commLinks.linkIncoming.map((r) => r.fromShip)]);
  const free = commLinks.ships.filter((n) => !linked.has(n) && !pending.has(n));
  box.replaceChildren(
    el('h3', { className: 'ops-subhead', textContent: 'Request a link' }),
    el('div', { className: 'tr-taps', id: 'links-request' }, ...(free.length ? free.map((n) => { const b = btn(n, () => send({ type: 'link-request', ship: n })); b.dataset.ship = n; return b; }) : [el('span', { className: 'ops-hint', textContent: 'No ships in range to link with' })])),
    ...(commLinks.linkIncoming.length ? [el('h3', { className: 'ops-subhead', textContent: 'Requests to us' }), el('ul', { className: 'st-list', id: 'links-incoming' }, ...commLinks.linkIncoming.map((r) => el('li', {}, `The ${r.fromShip}`, el('span', {}, btn('Accept', () => send({ type: 'link-accept', request: r.id })), btn('Decline', () => send({ type: 'link-decline', request: r.id }), true)))))] : []),
    ...(commLinks.linkOutgoing.length ? [el('h3', { className: 'ops-subhead', textContent: 'Our requests' }), el('ul', { className: 'st-list' }, ...commLinks.linkOutgoing.map((r) => el('li', {}, `The ${r.toShip}`, el('span', {}, btn('Cancel', () => send({ type: 'link-cancel', request: r.id }), true)))))] : []),
    el('h3', { className: 'ops-subhead', textContent: 'Open links' }),
    el('ul', { className: 'st-list', id: 'links-open' }, ...(commLinks.links.length ? commLinks.links.map((n) => { const li = (commLinks.hardLinks || []).includes(n) ? el('li', {}, n, el('small', { className: 'ops-hint', textContent: ' · hard link: docking port' })) : el('li', {}, n, el('span', {}, btn('Close', () => send({ type: 'link-close', ship: n }), true))); li.dataset.ship = n; return li; }) : [el('li', { className: 'empty', textContent: 'No open links' })])),
    el('p', { className: 'ops-notice', id: 'links-status', textContent: status }));
}

// Communications: every call in progress on our data network, who's in it
// and for how long. Metadata only; nobody listens in.
function renderTraffic() {
  const box = document.querySelector('[data-traffic]');
  if (!box) return;
  const ul = document.createElement('ul');
  ul.className = 'traffic';
  const fmt = (ms) => { const t = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  const STATE = { 'in-call': ['Open', ''], ringing: ['Ringing', ' traffic-state--ringing'], hailing: ['Hailing', ' traffic-state--ringing'], broadcast: ['All hands', ' traffic-state--broadcast'] };
  for (const c of traffic) {
    const li = document.createElement('li');
    const [word, cls] = STATE[c.state] || [c.state, ''];
    // A radio call between ships we only overhear: ship to ship, no detail.
    const who = c.ships ? `${c.ships.join('  ⟷  ')} (radio)${c.members.length ? `: ${c.members.map((m) => comms.voice.label(m)).join(', ')}` : ''}` : c.members.map((m) => comms.voice.label(m)).join('  ⟷  ');
    li.append(
      Object.assign(document.createElement('span'), { className: `traffic-state${cls}`, textContent: word }),
      Object.assign(document.createElement('span'), { className: 'traffic-who',
        textContent: c.state === 'hailing' ? `${who} → the ${c.to}, awaiting their ops` : c.state === 'broadcast' ? `${who} → ${c.to}` : who }),
      Object.assign(document.createElement('span'), { className: 'traffic-time', textContent: fmt(Date.now() - c.since) }));
    ul.append(li);
  }
  if (!traffic.length) ul.append(Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No comm traffic' }));
  box.replaceChildren(ul);
}
setInterval(renderTraffic, 1000);

const ownShip = () => ships.find((s) => me && s.name.toLowerCase() === me.ship.toLowerCase());

// Shields (footer, displays, Tactical's control) and the transporter controls.
// Power as Engineering has routed it (from the ship's computer, via 'nav').
const POWER = [['engines', 'Warp field coils'], ['lights', 'Lighting'], ['injectors', 'Plasma injectors'], ['deflector', 'Navigational deflector'], ['bussard', 'Bussard collectors'], ['shields', 'Shields'], ['sensors', 'Long-range sensors'], ['lateral', 'Lateral sensors'], ['transporter', 'Transporter'], ['weapons', 'Weapons'], ['sif', 'Structural integrity field'], ['idf', 'Inertial dampers'], ['atmosphere', 'Atmospheric processors'], ['thermal', 'Thermal regulation'], ['gravity', 'Gravity generators'], ['lighting', 'Emergency lighting'], ['replicators', 'Replicators'], ['recreation', 'Recreation']];
const ownPower = () => lastNav?.own?.power || null;

// Shields (footer, displays, Tactical's control), the transporter controls and
// the life support warning. Rebuilt only when something they show changes, so
// buttons don't move under the pointer.
let shipStateSig = '';
function renderShipState() {
  if (!me) return;
  const p = ownPower();
  // Life support: any place with someone in it that has no atmosphere (switched off, or
  // unpowered) is named; otherwise a warning when life support runs low. Empty places don't warn.
  const ls = lastNav?.own?.grid?.ls;
  const occupied = new Set(comms.users.filter((u) => u.ship.toLowerCase() === me.ship.toLowerCase()).map((u) => u.station));
  const airless = ls ? Object.entries(ls).filter(([loc, x]) => occupied.has(loc) && !x.got.atmosphere).map(([loc]) => loc) : [];
  bc.setAlert('life', airless.length ? `NO ATMOSPHERE: ${airless.join(', ')}` : p && p.lifeSupport < 50 ? `Life support at ${p.lifeSupport}%` : null);
  // Alert status: red or yellow frame and a bar on every console aboard.
  const alert = lastNav?.own?.alert || 'green';
  document.body.dataset.alert = alert;
  bc.setAlert('alert', alert === 'green' ? null : `${{ red: 'Red', yellow: 'Yellow', black: 'Black' }[alert] || 'Yellow'} alert`, { level: alert });
  if (!stationView) return;
  const up = !!ownShip()?.shields;
  const crew = comms.users.filter((u) => u.ship.toLowerCase() === me.ship.toLowerCase() && u.station !== 'Operations' && !u.hologram);
  const targets = ships.filter((s) => s.computer && s.name.toLowerCase() !== me.ship.toLowerCase());
  const range = lastNav?.ranges?.transporter;
  const strength = lastNav?.own?.combat?.shield;
  // Where each target is, for the transporter's reach (updates as ships move).
  const where = (name) => lastNav?.ships?.find((x) => x.name === name)?.distance ?? lastNav?.bases?.find((b) => b.name === name)?.distance;
  const trState = lastNav?.own?.transporter || {};
  const sig = JSON.stringify([up, p?.shields, lastNav?.own?.capacity?.shields, p?.transporter, lastNav?.own?.allocated?.transporter, trState.lock, !!trState.energizing, trState.diag, trState.fault, trState.from, Math.round(range || 0), crew.map((u) => u.id), targets.map((t) => [t.name, t.shields, Math.round(where(t.name) ?? -1)]), strength]);
  if (sig === shipStateSig) return;
  shipStateSig = sig;
  stationView.setShields(up);
  document.body.toggleAttribute('data-shields-up', up);
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

  const shieldCtl = document.querySelector('[data-shield-control]');
  if (shieldCtl) {
    // Raising them needs the power to be there (what they may draw: down, they draw nothing).
    const weak = ((lastNav?.own?.capacity?.shields ?? p?.shields) < 20) || strength < 10;
    const btn = el('button', {
      type: 'button',
      className: `lcars-button lcars-button--pill${up ? '' : ' lcars-button--alert'}`,
      textContent: up ? 'Lower shields' : 'Raise shields',
      disabled: !up && weak,
      onclick: () => send({ type: 'shields', up: !up }),
    });
    const state = el('p', { className: 'st-state', textContent: up ? 'Shields up · transporters blocked' : strength < 10 ? 'Shields down · generators recharging' : weak ? 'Shields down · not enough power' : 'Shields down' });
    state.toggleAttribute('data-up', up);
    const power = el('p', { className: 'ops-hint', id: 'shield-strength', textContent: p ? `Shield strength ${strength ?? 100}% · shield power ${p.shields}% (20% needed to hold them; more power, less drain per hit)` : '' });
    shieldCtl.replaceChildren(el('div', { className: 'st-control' }, state, btn, power));
  }

  const tr = document.querySelector('[data-transporter]');
  if (tr) renderTransporter(tr, { crew, targets, up, p, range, where });
}

// The transporter room. From: a vessel (this one, or one whose people Science
// can place, in range), then one of its manned stations, then one or more of
// the people there. To: a vessel (tapping it locks on; this one too: site to
// site), then a station (or the same one). Then push all three energize
// sliders to the top, as on the old Constitution-class consoles.
// No lock: it draws nothing; locked: half its power; energizing: all of it.
const beamSel = { fromShip: null, fromStation: null, who: new Set(), station: null };
function renderTransporter(trEl, { crew, targets, up, p, range, where = () => undefined }) {
  const tr = trEl;
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  if (!tr.querySelector('.tr-sliders')) {
    const sliders = el('div', { className: 'tr-sliders', id: 'beam-sliders' }, ...[1, 2, 3].map((n) => {
      const r = el('input', { type: 'range', min: 0, max: 100, value: 0, className: 'tr-slider', id: `beam-slider-${n}`, ariaLabel: `energize ${n}` });
      r.oninput = () => { // the three move together: one push energizes
        for (const o of tr.querySelectorAll('.tr-slider')) if (o !== r) o.value = r.value;
        energizeCheck();
      };
      return r;
    }));
    const row = (label, id) => el('div', { className: 'tr-pick' }, el('span', { className: 'tr-label', textContent: label }), el('div', { className: 'tr-taps', id }));
    tr.replaceChildren(
      el('h4', { className: 'tr-head', textContent: 'Beam' }),
      row('From', 'beam-from-ship'), row('', 'beam-from-station'), row('', 'beam-who'),
      row('To', 'beam-ship'), row('', 'beam-station'),
      el('div', { className: 'tr-energize' }, sliders, el('span', { className: 'tr-label', textContent: 'Energize: all three up' })),
      el('p', { className: 'ops-notice', id: 'beam-status' }),
      el('div', { className: 'ops-form' }, el('span', { id: 'beam-diag' }), Object.assign(el('button', { type: 'button', className: 'lcars-button lcars-button--pill', id: 'beam-diag-run', textContent: 'Run level-3 diagnostic' }), { onclick: () => send({ type: 'transporter-diagnostic' }) })),
      el('p', { className: 'ops-hint', id: 'beam-range' }));
  }
  const rerender = () => renderTransporter(trEl, { crew, targets, up, p, range, where });
  const tr2 = lastNav?.own?.transporter || {};
  // From: vessels, their manned stations, the people there. A pick that's gone clears what's under it.
  const sources = tr2.from || [{ ship: me.ship, here: true, stations: [] }];
  if (!sources.some((v) => v.ship === beamSel.fromShip)) { beamSel.fromShip = sources[0]?.ship || null; beamSel.fromStation = null; beamSel.who.clear(); }
  const src = sources.find((v) => v.ship === beamSel.fromShip);
  if (!src?.stations.some((x) => x.station === beamSel.fromStation)) { beamSel.fromStation = src?.stations[0]?.station || null; beamSel.who.clear(); }
  const people = src?.stations.find((x) => x.station === beamSel.fromStation)?.people || [];
  for (const id of [...beamSel.who]) if (!people.some((u) => u.id === id)) beamSel.who.delete(id);
  // To: this vessel and the others in the list; only places within reach right now (in range, shields down).
  const ships = [{ name: me.ship, here: true }, ...targets];
  const reach = (x) => {
    if (x.here) return '';
    const d = where(x.name);
    if (d == null) return 'not on sensors';
    if (range != null && d > range) return `out of range (${Math.round(d)} of ${Math.round(range)})`;
    if (x.shields) return 'shields up';
    if (up) return 'our shields up';
    return '';
  };
  const stations = ['Same station', ...STATION_NAMES.filter((n) => n !== 'Operations')];
  if (!stations.includes(beamSel.station)) beamSel.station = 'Same station';
  // (Station taps: grouped by where they are aboard.)
  const taps = (box, items, isOn, set, places = false) => {
    const tapOf = ([value, text, why]) => {
      const b = el('button', { type: 'button', className: 'lcars-button lcars-button--pill tr-tap', textContent: why ? `${text} · ${why}` : text });
      b.dataset.value = value;
      if (why) { b.disabled = true; b.title = why; }
      b.setAttribute('aria-pressed', String(isOn(value)));
      b.onclick = () => { set(value); rerender(); };
      return b;
    };
    box.replaceChildren(...(places ? [...items.filter(([v]) => v === 'Same station').map(tapOf), ...placeNodes(items.filter(([v]) => v !== 'Same station'), ([v]) => v, tapOf)] : items.map(tapOf)));
  };
  const vesselName = (n, here) => (here ? `The ${n} (here)` : /^(Starbase|Deep Space|Utopia) /.test(n) ? n : `The ${n}`);
  taps(tr.querySelector('#beam-from-ship'), sources.map((v) => [v.ship, vesselName(v.ship, v.here)]), (v) => v === beamSel.fromShip,
    (v) => { if (v !== beamSel.fromShip) { beamSel.fromShip = v; beamSel.fromStation = null; beamSel.who.clear(); } });
  taps(tr.querySelector('#beam-from-station'), (src?.stations || []).map((x) => [x.station, `${x.station} (${x.people.length})`]), (v) => v === beamSel.fromStation,
    (v) => { if (v !== beamSel.fromStation) { beamSel.fromStation = v; beamSel.who.clear(); } }, true);
  if (!src?.stations.length) tr.querySelector('#beam-from-station').append(el('span', { className: 'ops-hint', textContent: 'Nobody aboard to beam' }));
  // People: one or more (tap to add or remove).
  taps(tr.querySelector('#beam-who'), people.map((u) => [u.id, u.id === me.id ? `${u.name} (you)` : u.name]), (v) => beamSel.who.has(v),
    (v) => { if (beamSel.who.has(v)) beamSel.who.delete(v); else beamSel.who.add(v); });
  // Tap a destination to lock on; tap the locked one again to let go (always allowed).
  taps(tr.querySelector('#beam-ship'), ships.map((x) => [x.name, x.here ? `The ${x.name} (site to site)` : vesselName(x.name), x.name === tr2.lock ? '' : reach(x)]), (v) => v === tr2.lock,
    (v) => { send({ type: 'transporter-lock', ship: v === tr2.lock ? null : v }); });
  taps(tr.querySelector('#beam-station'), stations.map((n) => [n, n]), (v) => v === beamSel.station, (v) => { beamSel.station = v; }, true);
  const limit = lastNav?.own?.allocated?.transporter ?? 100;
  // The level-3 diagnostic: it must pass before anyone is beamed.
  const diag = tr2.diag || { state: 'passed' };
  tr.querySelector('#beam-diag').textContent = diag.state === 'passed' ? 'Level-3 diagnostic: passed' : diag.state === 'running' ? `Level-3 diagnostic: running (${diag.t} of ${diag.secs} s)` : 'Level-3 diagnostic: required before beaming';
  tr.querySelector('#beam-diag-run').disabled = diag.state === 'running' || !!tr2.fault;
  const n = beamSel.who.size;
  const blocked = tr2.energizing ? `Energizing · 100% power` : tr2.fault ? `Transporter offline: ${tr2.fault}` : !tr2.lock ? 'No lock · tap a destination (To) to lock on (transporter idle, no power drawn)'
    : limit < 100 ? `Locked on the ${tr2.lock} · limiter at ${limit}%: energizing needs 100% (ask Engineering)`
    : up && tr2.lock !== me.ship ? `Locked on the ${tr2.lock} · shields are up aboard the ${me.ship}`
    : !n ? `Locked on the ${tr2.lock} · pick who to beam (From)`
    : `Locked on the ${tr2.lock} · ${n} to beam · ${p?.transporter ?? 0}% power (energizing takes 100% for ${tr2.secs || 5} s)`;
  for (const r of tr.querySelectorAll('.tr-slider')) r.disabled = !n || !tr2.lock || !!tr2.energizing || limit < 100 || !!tr2.fault || diag.state !== 'passed';
  tr.querySelector('#beam-status').textContent = blocked;
  tr.querySelector('#beam-range').textContent = range != null ? `Transporter range ${Math.round(range)} units (sensor power ${p?.sensors ?? 100}%)` : '';
}

// All three sliders at the top: energize once, then they fall back (and
// can't fire again until they have).
let energizing = false;
function energizeCheck() {
  const rs = [...document.querySelectorAll('.tr-slider')];
  if (energizing || !rs.length || rs.some((r) => Number(r.value) < 95) || !beamSel.who.size || !lastNav?.own?.transporter?.lock) return;
  energizing = true;
  stationView?.energize();
  send({ type: 'beam', who: [...beamSel.who], ...(beamSel.station !== 'Same station' ? { station: beamSel.station } : {}) });
  beamSel.who.clear(); // (they're on their way)
  setTimeout(() => { rs.forEach((r) => { r.value = 0; }); energizing = false; }, 900);
}

// The crosslink's flow bars sit between the checkboxes: measured once laid out (and on resize).
function placeFlows(row) {
  for (const bar of row.querySelectorAll('.xflow-bar')) {
    const td = bar.parentElement, a = td.querySelector('input'), b = td.nextElementSibling?.querySelector('input');
    if (!a || !b) continue;
    const r0 = td.getBoundingClientRect(), ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    bar.style.left = `${ra.right - r0.left + 6}px`;
    bar.style.width = `${Math.max(24, rb.left - ra.right - 12)}px`;
  }
}
window.addEventListener('resize', () => { for (const row of document.querySelectorAll('#ties-crosslink')) placeFlows(row); });
// The master systems display: what it shows, and where its labels and tiles lead.
let msd = null;
const engEvents = [];
function renderMSD() {
  if (!msd || !lastNav?.own?.grid) return;
  msd.update({ ...lastNav.own, speed: lastNav.speed, shieldsUp: !!ownShip()?.shields }, engEvents);
}
const MSD_SCREENS = {
  warp: ['st-core', 'st-grid'], fuel: ['st-grid'], eps: ['st-grid'], comp: ['st-grid'], fusion: ['st-grid'], deut: ['st-grid'], batt: ['st-grid'], ext: ['st-grid'],
  env: ['st-power', 'st-grid'], atmo: ['st-power', 'st-grid'], thermal: ['st-power', 'st-grid'], gravity: ['st-power', 'st-grid'], lighting: ['st-power', 'st-grid'],
  sif: ['st-power', 'st-grid'], idf: ['st-power', 'st-grid'], defl: ['st-nav', 'st-power', 'st-grid'], sens: ['st-sensors', 'st-power', 'st-grid'], lrs: ['st-sensors', 'st-power', 'st-grid'],
  trans: ['st-transporter', 'st-grid'], comm: ['st-links', 'st-traffic', 'st-grid'], prop: ['st-nav', 'st-core', 'st-power'], impulse: ['st-nav', 'st-grid'],
  shld: ['st-shieldctl', 'st-power'], tractor: ['st-weapons', 'st-grid'],
};
function openSystem(k) {
  const id = (MSD_SCREENS[k] || []).find((x) => document.querySelector(`[data-screen="${x}"]`));
  if (id) showScreen(id);
}
// Engineering's Life support panel: each place aboard, its atmosphere, heat,
// gravity and lights (taps), and what it's actually getting.
// The Brig's screen: the force field, and who's held here.
function renderBrig(grid) {
  const box = document.querySelector('[data-brig]');
  if (!box || !grid) return;
  const held = comms.users.filter((u) => u.ship.toLowerCase() === me?.ship.toLowerCase() && u.station === 'Brig');
  const sig = JSON.stringify([grid.brigSealed, held.map((u) => u.id)]);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  box.replaceChildren(el('p', { className: 'st-brig-title', textContent: 'BRIG' }),
    el('p', { className: 'st-state', id: 'brig-state', textContent: grid.brigSealed ? 'Force field up: nobody walks in or out' : 'Force field down' }),
    el('ul', { className: 'st-list', id: 'brig-held' }, ...(held.length ? held.map((u) => el('li', { textContent: u.title || u.name })) : [el('li', { className: 'empty', textContent: 'Nobody held' })])));
}
// Department readiness: call one department (or all) to report ready.
window.__callReadiness = (dept) => send({ type: 'readiness', dept });
// Hangar control (the Shuttle Bay's panel): the bay doors (tap to open or
// close), the containment field, room, and who's landed.
function renderBay() {
  const box = document.querySelector('[data-bay]');
  const b = lastNav?.own?.grid?.bay;
  if (!box || !b) return;
  const sig = JSON.stringify(b);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const doors = el('button', { type: 'button', className: `lcars-button lcars-button--pill${b.open ? ' lcars-button--alert' : ''}`, id: 'bay-doors', textContent: b.open ? 'Close the bay doors' : 'Open the bay doors', disabled: !b.capacity, onclick: () => send({ type: 'bay-doors', open: !b.open }) });
  doors.setAttribute('aria-pressed', String(!!b.open));
  box.replaceChildren(
    el('p', { className: 'st-state', id: 'bay-doors-state', textContent: !b.capacity ? 'No shuttle bay aboard' : `Doors ${b.open ? 'open' : 'closed'}${!b.doorsOk ? ' · doors have no power' : ''}` }),
    el('div', { className: 'ops-form' }, doors),
    el('p', { className: 'st-state', id: 'bay-field-state', textContent: !b.capacity ? '' : `Containment field: ${!b.open ? 'standing by (doors closed)' : b.fieldOk ? 'holding the air in' : 'DOWN: no power'}` }),
    el('p', { className: 'ops-hint', textContent: b.capacity ? `${b.landed.length} of ${b.capacity} landed` : '' }),
    el('ul', { className: 'st-list', id: 'bay-landed' }, ...(b.landed.length ? b.landed.map((n) => el('li', { textContent: `The ${n}` })) : [el('li', { className: 'empty', textContent: 'Nothing landed' })])));
}
function renderLifeSupport() {
  const root = document.querySelector('[data-lifesupport]');
  const ls = lastNav?.own?.grid?.ls;
  if (!root || !ls) return;
  const sig = JSON.stringify(ls);
  if (root.dataset.sig === sig) return;
  root.dataset.sig = sig;
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const SYS = [['atmosphere', 'Atmosphere'], ['thermal', 'Thermal'], ['gravity', 'Gravity'], ['lights', 'Lights']];
  const tap = (loc, sys, on, got) => {
    const b = el('button', { type: 'button', className: 'lcars-button lcars-button--pill lcars-toggle ls-tap', textContent: on ? (got ? 'On' : 'On · no power') : 'Off', onclick: () => send({ type: 'grid', ls: { loc, sys, on: !on } }) });
    b.setAttribute('aria-pressed', String(on));
    b.dataset.loc = loc; b.dataset.sys = sys;
    if (on && !got) b.dataset.short = '';
    return b;
  };
  const all = (sys, on) => el('button', { type: 'button', className: 'lcars-button lcars-button--pill grid-mini', textContent: on ? 'All on' : 'All off', onclick: () => send({ type: 'grid', ls: { loc: 'all', sys, on } }) });
  root.replaceChildren(el('table', { className: 'grid-table ls-table', id: 'ls-table' },
    el('thead', {}, el('tr', {}, el('th', { scope: 'col', textContent: 'Place' }), ...SYS.map(([k, n]) => el('th', { scope: 'col' }, el('span', { textContent: n }), all(k, true), all(k, false))), el('th', { scope: 'col', textContent: 'Status' }))),
    el('tbody', {}, ...Object.entries(ls).map(([loc, x]) => el('tr', { id: `ls-${loc.replace(/\s/g, '-')}` }, el('th', { scope: 'row', textContent: loc }),
      ...SYS.map(([k]) => el('td', {}, tap(loc, k, x.on[k], x.got[k]))),
      el('td', { className: 'grid-note', textContent: !x.lit ? 'DARK' : x.emergency ? 'emergency lighting' : x.on.atmosphere && !x.got.atmosphere ? 'NO ATMOSPHERE' : 'nominal' }))))),
    el('p', { className: 'ops-hint', textContent: 'Each system draws for the places it\'s on in: switch areas off to save power. A place is served only while its system has power; emergency lighting lights any place whose lights are on but unpowered. A dark place with its console dark goes black but for Station and comms.' }));
}
// Damage control's core eject: armed by the first press, fired by a second within 5 s.
let ejectArmedAt = 0;
const ejectArmed = () => Date.now() - ejectArmedAt < 5000;
// Engineering's grid table order, remembered per console (this browser).
const GRID_ORDERS = [['startup', 'Startup'], ['operations', 'Operations'], ['shutdown', 'Shutdown']];
let gridOrder = 'operations';
try { const o = localStorage.getItem('stchat-grid-order'); if (GRID_ORDERS.some(([v]) => v === o)) gridOrder = o; } catch {}
function setGridOrder(v) { gridOrder = v; try { localStorage.setItem('stchat-grid-order', v); } catch {} }

// --- Captain, First Officer, Security, Medical controls --------------------------
const securityAlerts = []; // beam-ins Security has been told about
const sentOrders = new Map(); // orders we gave, with acknowledgements
// Orders: who's picked to send the next one to (nobody: all hands).
const orderPick = new Set();
function issueOrder(text) {
  if (!text.value.trim()) return;
  send({ type: 'order', text: text.value.trim(), ...(orderPick.size ? { to: [...orderPick] } : {}) });
  text.value = '';
  orderPick.clear();
  renderCrewPanels();
}

function renderCrewPanels() {
  if (!me || !stationView) return;
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const button = (text, onclick, extra = '') => el('button', { type: 'button', className: `lcars-button lcars-button--pill ${extra}`, textContent: text, onclick });
  const aboard = comms.users.filter((u) => u.ship.toLowerCase() === me.ship.toLowerCase());
  const crew = aboard.filter((u) => u.station !== 'Operations');
  const status = (u) => (u.sickbay ? 'Sickbay' : u.confined ? 'Confined to quarters' : 'On duty');
  // Rebuild a panel only when what it shows has changed (buttons stay put).
  const changed = (node, ...state) => { const sig = JSON.stringify(state); if (node.dataset.sig === sig) return false; node.dataset.sig = sig; return true; };
  const crewSig = crew.map((u) => [u.id, u.station, u.console, !!u.fielded, !!u.sickbay, !!u.confined]);
  const pickCrew = (id, list, keep) => {
    const sel = el('select', { className: 'ops-select', id, ariaLabel: 'crew member' }, ...list.map((u) => new Option(u.id === me.id ? `${u.name} (you)` : `${u.name} · ${u.station}`, u.id)));
    if (keep && list.some((u) => u.id === keep)) sel.value = keep;
    return sel;
  };

  // Captain: alert status and orders.
  const cmd = document.querySelector('[data-command]');
  if (cmd) {
    if (!cmd.firstChild) {
      const text = el('input', { className: 'ops-input', id: 'order-text', placeholder: 'Orders to all hands aboard', autocomplete: 'off' });
      const form = el('form', { className: 'ops-form' }, text, el('button', { className: 'lcars-button lcars-button--pill', id: 'order-send', textContent: 'Issue order' }));
      form.onsubmit = (e) => { e.preventDefault(); issueOrder(text); };
      cmd.append(
        el('p', { className: 'st-state', id: 'alert-state' }),
        el('div', { className: 'ops-form', id: 'alert-buttons' },
          ...[['green', 'Condition green', ''], ['yellow', 'Yellow alert', 'alert-yellow'], ['red', 'Red alert', 'lcars-button--alert'], ['black', 'Black alert', 'alert-black']].map(([lvl, t, c]) => {
            const b = button(t, () => send({ type: 'alert', level: lvl }), c);
            b.dataset.level = lvl;
            return b;
          })),
        el('p', { className: 'ops-hint', textContent: 'Red alert raises shields if they have power, and turns every console aboard red.' }),
        form);
    }
    const level = lastNav?.own?.alert || 'green';
    cmd.querySelector('#alert-state').textContent = level === 'green' ? 'Condition green' : `${level} alert`;
    cmd.querySelector('#alert-state').dataset.level = level;
    for (const b of cmd.querySelectorAll('#alert-buttons button')) b.setAttribute('aria-pressed', String(b.dataset.level === level));
    // (Black alert: only aboard a ship with a spore drive.)
    cmd.querySelector('#alert-buttons button[data-level="black"]').hidden = !lastNav?.own?.grid?.spore;
  }

  // First Officer: reassign crew.
  const ra = document.querySelector('[data-reassign]');
  if (ra && changed(ra, crewSig, stations)) {
    const keep = ra.querySelector('#xo-who')?.value, keepSt = ra.querySelector('#xo-station')?.value;
    const who = pickCrew('xo-who', crew, keep);
    const st = el('select', { className: 'ops-select', id: 'xo-station', ariaLabel: 'station' }, ...byPlace(stations).map((g) => el('optgroup', { label: g.label }, ...g.items.map((n) => new Option(n, n)))));
    if (keepSt) st.value = keepSt;
    ra.replaceChildren(
      el('div', { className: 'ops-form' }, el('span', { textContent: 'Reassign' }), who, el('span', { textContent: 'to' }), st,
        button('Reassign', () => send({ type: 'reassign', who: who.value, station: st.value }))),
      el('p', { className: 'ops-hint', textContent: 'Sent as an order: the crew member moves when they acknowledge it (or declines it). Force fields hold, as for walking.' }),
      el('ul', { className: 'st-list order-tally' }));
  }

  // Security: transporter lockout, confinement, beam-in alerts.
  const sec = document.querySelector('[data-security]');
  const fields = lastNav?.own?.grid?.forcefields || [];
  if (sec && changed(sec, crewSig, !!lastNav?.own?.lockout, securityAlerts.length, fields, lastNav?.own?.grid?.fieldsUp, lastNav?.own?.grid?.brigField, lastNav?.own?.grid?.brigSealed)) {
    const lockout = !!lastNav?.own?.lockout;
    const keep = sec.querySelector('#sec-who')?.value;
    const others = crew.filter((u) => u.id !== me.id);
    const who = pickCrew('sec-who', others, keep);
    const confined = others.filter((u) => u.confined);
    sec.replaceChildren(
      el('div', { className: 'st-control' },
        el('p', { className: 'st-state', textContent: lockout ? 'Transporter lockout: force field up' : 'Transporter lockout: off' }),
        button(lockout ? 'Drop force field' : 'Raise force field', () => send({ type: 'lockout', on: !lockout }), lockout ? '' : 'lcars-button--alert')),
      el('div', { className: 'st-control' },
        el('p', { className: 'st-state', id: 'brig-field-state', textContent: lastNav?.own?.grid?.brigSealed ? 'Brig force field: up' : 'Brig force field: down' }),
        button(lastNav?.own?.grid?.brigField ? 'Drop brig field' : 'Raise brig field', () => send({ type: 'brig-field', on: !lastNav?.own?.grid?.brigField }), lastNav?.own?.grid?.brigField ? '' : 'lcars-button--alert')),
      el('h3', { className: 'ops-subhead', textContent: 'Force fields (isolate a station)' }),
      el('div', { className: 'tr-taps', id: 'sec-fields' }, ...placeNodes(stations, (st) => st, (st) => {
        const on = fields.includes(st);
        const b = button(st, () => send({ type: 'forcefield', station: st, on: !on }), on ? 'lcars-button--alert' : '');
        b.classList.add('tr-tap');
        b.dataset.station = st;
        b.setAttribute('aria-pressed', String(on));
        return b;
      })),
      el('p', { className: 'ops-hint', textContent: fields.length ? `Isolated: ${fields.join(', ')}${lastNav?.own?.grid?.fieldsUp ? '' : ' (emitters have no power: fields are down)'}` : 'Tap a station to isolate it: nobody walks in or out (the transporter still gets through); whoever is inside keeps their console. 5 power each, from the emitters.' }),
      el('h3', { className: 'ops-subhead', textContent: 'Bridge force fields (hold a person)' }),
      el('div', { className: 'tr-taps', id: 'sec-people' }, ...(() => {
        const onBridge = crew.filter((u) => BRIDGE.includes(u.console || u.station));
        return onBridge.length ? onBridge.map((u) => {
          const b = button(`${u.title || u.name} · ${u.console || u.station}`, () => send({ type: 'person-field', who: u.id, on: !u.fielded }), u.fielded ? 'lcars-button--alert' : '');
          b.classList.add('tr-tap');
          b.dataset.person = u.id;
          b.setAttribute('aria-pressed', String(!!u.fielded));
          return b;
        }) : [el('p', { className: 'ops-hint', textContent: 'Nobody on the bridge' })];
      })()),
      el('p', { className: 'ops-hint', textContent: 'Tap someone on the bridge to hold them in a force field: they can\'t walk off (the transporter still gets through). 5 power each, from the emitters.' }),
      el('div', { className: 'ops-form' }, el('span', { textContent: 'Quarters' }), who,
        button('Confine', () => send({ type: 'confine', who: who.value, on: true }), 'lcars-button--alert'),
        button('Release', () => send({ type: 'confine', who: who.value, on: false }))),
      el('p', { className: 'ops-hint', textContent: confined.length ? `Confined: ${confined.map((u) => u.name).join(', ')}` : 'Nobody is confined to quarters' }),
      el('h3', { className: 'ops-subhead', textContent: 'Beam-in alerts' }),
      el('ul', { className: 'lcars-log', id: 'sec-alerts' }, ...(securityAlerts.length ? securityAlerts.slice(-8).reverse().map((t) => el('li', { className: 'lcars-log__line lcars-log__line--warn', textContent: t })) : [el('li', { className: 'lcars-log__line', textContent: 'No unauthorized arrivals' })])));
  }

  // Medical: sickbay and life signs.
  const med = document.querySelector('[data-medical]');
  const emhOn = !!lastNav?.own?.automation?.medical;
  if (med && changed(med, crewSig, ownPower()?.lifeSupport, emhOn)) {
    const p = ownPower();
    med.replaceChildren(
      el('div', { className: 'st-control' },
        el('p', { className: 'st-state', id: 'emh-state', textContent: emhOn ? 'Emergency medical hologram: active' : 'Emergency medical hologram: off' }),
        button(emhOn ? 'Deactivate EMH' : 'Activate EMH', () => send({ type: 'emh', on: !emhOn }), emhOn ? '' : 'lcars-button--alert')),
      el('p', { className: 'ops-hint', textContent: p ? `Life support ${p.lifeSupport}%${p.lifeSupport < 50 ? ': crew at risk' : ''}` : '' }),
      el('ul', { className: 'st-list st-patients' }, ...crew.map((u) => {
        const li = el('li', {}, `${u.name}${u.id === me.id ? ' (you)' : ''}`, el('span', { textContent: `${u.station} · ${status(u)}` }),
          u.sickbay ? button('Discharge', () => send({ type: 'sickbay', who: u.id, on: false })) : button('Admit', () => send({ type: 'sickbay', who: u.id, on: true }), 'lcars-button--alert'));
        li.dataset.crew = u.id;
        return li;
      })),
      el('p', { className: 'ops-hint', textContent: 'Crew in sickbay are off duty: they don\'t count in department readiness.' }));
  }
  // Orders (Captain, First Officer): the form; under it who to send them to
  // (taps: a department's label for all of it, a name for one; nobody picked:
  // all hands); and the orders given, newest first, each with who has
  // acknowledged it (green) and who hasn't yet (amber).
  for (const box of document.querySelectorAll('[data-orders], [data-command]')) {
    if (box.matches('[data-orders]') && !box.firstChild) {
      const text = el('input', { className: 'ops-input', id: 'order-text', placeholder: 'Orders to the crew aboard', autocomplete: 'off' });
      const form = el('form', { className: 'ops-form' }, text, el('button', { className: 'lcars-button lcars-button--pill', id: 'order-send', textContent: 'Issue order' }));
      form.onsubmit = (e) => { e.preventDefault(); issueOrder(text); };
      box.append(form, el('p', { className: 'ops-hint', textContent: 'Everyone aboard but you and the Captain is asked to acknowledge.' }));
    }
    let targets = box.querySelector('.order-targets'), history = box.querySelector('.order-history');
    if (!targets) { targets = el('div', { className: 'order-targets' }); box.querySelector('form')?.after(targets); }
    if (!history) { history = el('div', { className: 'order-history' }); box.append(history); }
    // Who could be sent orders: the crew aboard by station (not me; not the Captain; nor the First Officer for theirs).
    const skip = me.station === 'First Officer' ? ['Captain', 'First Officer'] : ['Captain'];
    const reachable = crew.filter((u) => u.id !== me.id && !skip.includes(u.station));
    for (const id of [...orderPick]) if (!reachable.some((u) => u.id === id)) orderPick.delete(id);
    const byDept = (list) => byPlace([...new Set(list.map((u) => u.station))]).flatMap((g) => g.items).map((st) => [st, list.filter((u) => u.station === st)]);
    const withPlaces = (rows) => { let at = null; return rows.flatMap(([st, ...rest]) => { const g = byPlace([st])[0]; const head = g.name !== at ? [el('p', { className: 'place-head', textContent: g.label })] : []; at = g.name; return [...head, [st, ...rest]]; }); };
    // (One look for both lists: a department pill and name chips, taps where they do something.)
    const chip = (u, state, onclick) => { const b = el('button', { type: 'button', className: 'order-chip', textContent: u.name, onclick, disabled: !onclick }); b.dataset.state = state; b.dataset.who = u.id; return b; };
    const deptPill = (st, onclick, on) => { const b = el('button', { type: 'button', className: 'order-dept', textContent: st, onclick, disabled: !onclick }); if (onclick) b.setAttribute('aria-pressed', String(!!on)); return b; };
    if (changed(targets, reachable.map((u) => [u.id, u.station]), [...orderPick])) {
      targets.replaceChildren(el('p', { className: 'ops-hint', textContent: orderPick.size ? `To ${orderPick.size} picked · tap again to unpick` : 'To all hands · or tap a department or names to pick who' }),
        ...withPlaces(byDept(reachable)).map((x) => { if (!Array.isArray(x)) return x; const [st, us] = x;
          const all = us.every((u) => orderPick.has(u.id));
          const label = deptPill(st, () => { for (const u of us) if (all) orderPick.delete(u.id); else orderPick.add(u.id); renderCrewPanels(); }, all);
          const row = el('div', { className: 'order-row' }, label, el('span', { className: 'order-chips' }, ...us.map((u) => { const c = chip(u, orderPick.has(u.id) ? 'picked' : 'idle', () => { if (orderPick.has(u.id)) orderPick.delete(u.id); else orderPick.add(u.id); renderCrewPanels(); }); c.setAttribute('aria-pressed', String(orderPick.has(u.id))); return c; })));
          row.dataset.dept = st;
          return row;
        }));
    }
    const log = lastNav?.own?.orders || [];
    if (changed(history, log)) {
      if (!log.length) history.replaceChildren(el('p', { className: 'ops-hint order-none', textContent: 'No orders given yet' }));
      else history.replaceChildren(...log.map((o) => {
        const waiting = o.to.filter((u) => !o.acked.includes(u.id) && !(o.declined && o.declined === u.name));
        const sec = el('section', { className: 'order-entry' },
          el('h4', { className: 'order-title', textContent: o.text }),
          el('small', { className: 'grid-note', textContent: `${new Date(o.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${o.from.title || o.from.name}${o.declined ? ` · declined by ${o.declined}` : waiting.length ? ` · ${o.acked.length} acknowledged · waiting for ${waiting.map((u) => u.name).join(', ')}` : o.to.length ? ` · all ${o.acked.length} acknowledged` : ' · nobody to acknowledge'}` }),
          ...withPlaces(byDept(o.to)).map((x) => (!Array.isArray(x) ? x : el('div', { className: 'order-row' }, deptPill(x[0]), el('span', { className: 'order-chips' }, ...x[1].map((u) => chip(u, o.acked.includes(u.id) ? 'acked' : o.declined === u.name ? 'declined' : 'pending')))))));
        sec.dataset.order = o.id;
        return sec;
      }));
    }
  }
  // The First Officer's reassignments: who has moved.
  for (const box of document.querySelectorAll('[data-reassign]')) {
    let tally = box.querySelector('.order-tally');
    if (!tally) { tally = el('ul', { className: 'st-list order-tally' }); box.append(tally); }
    if (changed(tally, [...sentOrders.values()])) {
      tally.replaceChildren(...[...sentOrders.values()].slice(-5).reverse().map((o) => {
        const li = el('li', {}, o.text, el('span', { textContent: o.declined ? `declined by ${o.declined}` : o.pending.length ? `${o.acked.length} acknowledged · waiting for ${o.pending.join(', ')}` : o.acked.length ? `all ${o.acked.length} acknowledged` : 'nobody to acknowledge' }));
        li.dataset.order = o.id;
        return li;
      }));
    }
  }

}

// Remote control: buttons top right of the station screens, one per vessel
// this console can run the same station aboard (over a data link, that
// station unmanned there); our own ship at the far right.
let vesselSig = '';
// The command prefix for taking over another vessel's station: a keypad in a dialog.
function askPrefix(ship) {
  let d = document.getElementById('prefix-dialog');
  if (!d) {
    d = Object.assign(document.createElement('dialog'), { id: 'prefix-dialog', className: 'lcars-modal' });
    document.body.append(d);
  }
  const title = Object.assign(document.createElement('h3'), { className: 'ops-subhead', textContent: `The ${ship}'s command prefix` });
  const cancel = Object.assign(document.createElement('button'), { type: 'button', className: 'lcars-button lcars-button--pill', id: 'prefix-cancel', textContent: 'Cancel', onclick: () => d.close() });
  d.replaceChildren(title, makeKeypad('prefix-entry', 'Take control', (code) => { send({ type: 'control', ship, prefix: code }); d.close(); }), cancel);
  if (!d.open) d.showModal();
}
function renderVesselBar(remote) {
  const bar = $('vessel-bar');
  controllingVessel = remote?.controlling || null;
  const vessels = remote?.vessels || [];
  const sig = JSON.stringify([vessels, remote?.controlling, me?.station]);
  bc.setAlert('remote', remote?.controlling ? `Remote control: the ${remote.controlling}'s ${me.station}` : null, { level: 'yellow' });
  if (sig === vesselSig) return;
  vesselSig = sig;
  bar.hidden = !vessels.length && !remote?.controlling;
  const b = (label, ship, pressed) => {
    const x = Object.assign(document.createElement('button'), { type: 'button', className: 'lcars-button lcars-button--pill tr-tap', textContent: label });
    x.dataset.vessel = ship || '';
    x.setAttribute('aria-pressed', String(pressed));
    // Another vessel: its command prefix first, on a keypad.
    x.onclick = () => (ship && ship !== remote?.controlling ? askPrefix(ship) : send({ type: 'control', ship }));
    return x;
  };
  bar.replaceChildren(...vessels.map((v) => b(v, v, remote.controlling === v)), b(remote?.home || me?.ship || 'Own ship', null, !remote?.controlling));
}

// A dark console covers its station screens only: Station (to move to a
// console that has power), Console log and Library stay usable.
let consoleDark = false;
function updateCover() {
  const shown = [...document.querySelectorAll('[data-screen]')].find((el) => !el.hidden);
  $('console-dark').hidden = !consoleDark || !shown?.closest('#station-view, #ops-view');
}
// A dark room: no lights where this console is (off, or unpowered with no
// emergency lighting) and the console itself dark: the whole screen goes
// black but for the Station button and comms.
// Engineering is the exception: its Power grid stays usable too, to bring the ship up from cold iron.
function renderDarkness() {
  const grid = lastNav?.own?.grid, here = me && grid?.ls?.[myPlace()];
  const unpowered = me && (myPlace() === 'Engineering' ? grid?.consoleOk?.Engineering === false : consoleDark);
  const dark = !!(here && !here.lit && unpowered);
  if (dark) document.body.dataset.blackout = myPlace() === 'Engineering' ? 'engineering' : 'all';
  else delete document.body.dataset.blackout;
}
window.addEventListener('screenchange', updateCover);

// --- combat and the power grid: Tactical's weapons, Engineering's grid and
// damage control, the Captain's status and self-destruct, dark consoles ---
// The torpedo reload counts down here between 'nav' messages.
let combatAt = 0;
function renderCombat() {
  if (!me) return;
  const own = lastNav?.own, c = own?.combat, grid = own?.grid;
  if (!c || !grid) return;
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const button = (text, id, onclick, extra = '') => el('button', { type: 'button', className: `lcars-button lcars-button--pill ${extra}`, id, textContent: text, onclick });
  const changed = (node, ...state) => { const sig = JSON.stringify(state); if (node.dataset.sig === sig) return false; node.dataset.sig = sig; return true; };
  const NAMES = Object.fromEntries(POWER);
  const feeds = (list) => (list.length ? list.map((n) => (n === 'EPS' ? 'EPS' : `Bus ${n}`)).join(' + ') : 'nothing');
  combatAt = Date.now();

  // Warnings on every console aboard; a weapons lock on us for Tactical and the Captain.
  bc.setAlert('fire', c.underFire ? `Taking fire from the ${c.underFire} · shields ${ownShip()?.shields ? `${c.shield}%` : 'down'} · hull ${c.hull}%` : null);
  bc.setAlert('locked', c.lockedBy.length && ['Tactical', 'Captain'].includes(me.station) ? `Weapons lock: the ${c.lockedBy.join(', the ')} ${c.lockedBy.length > 1 ? 'have' : 'has'} locked on us` : null, { level: 'yellow' });
  bc.setAlert('breach', grid.breach != null ? `Antimatter containment failing: field ${grid.contain?.field}%, breach in ${grid.breach} s (no power from ${feeds(grid.ties.containment)}, reserve exhausted)` : null);
  bc.setAlert('tractor', grid.towedBy ? `Held in the ${grid.towedBy}'s tractor beam` : null, { level: 'yellow' });
  bc.setAlert('selfdestruct', grid.selfDestruct ? `Self-destruct in ${grid.selfDestruct.seconds} s · ordered by ${grid.selfDestruct.by}` : null);

  // This console goes dark when its bus has no power (comms still work).
  const tied = grid.ties[`console:${myPlace()}`] || [];
  const bus = tied.length ? tied.map((n) => `Bus ${n}`).join(' or ') : 'its bus (not tied in)';
  const fielded = grid.fieldsUp && grid.forcefields.includes(myPlace());
  bc.setAlert('isolated', fielded ? `A Security force field isolates ${myPlace()}: nobody walks in or out` : null, { level: 'yellow' });
  const held = !!comms.users.find((u) => u.id === me.id)?.fielded;
  bc.setAlert('held', held ? `A Security force field holds you at ${myPlace()}` : null, { level: 'yellow' });
  const dark = grid.consoleOk[myPlace()] === false;
  // Engineering's power grid runs on emergency power, so it's never covered.
  const emergency = dark && myPlace() === 'Engineering';
  bc.setAlert('emergency', emergency ? `Console on emergency power (no power on ${bus}): Power grid controls only` : null, { level: 'yellow' });
  consoleDark = dark && !emergency;
  // Off the optical data network: no station controls; Comms, the log, the library and Station still work.
  const odnOff = me && grid.odn && grid.odn[myPlace()] === false && myPlace() !== 'Engineering';
  if (odnOff !== document.body.hasAttribute('data-odn-off')) {
    document.body.toggleAttribute('data-odn-off', odnOff);
    const shown = [...document.querySelectorAll('[data-screen]')].find((x) => !x.hidden);
    if (odnOff && shown?.closest('#station-view, #ops-view')) showScreen('odn-off');
    if (!odnOff && shown?.dataset.screen === 'odn-off') showScreen(stationView ? stationView.sections[0].id : 'status');
  }
  // Comms and the library: this console powered, or the ship's local RF up.
  const commsOn = !dark || grid.subOk?.rf !== false;
  comms.setOffline(commsOn ? '' : 'Comms offline: no console power or local RF. Proximity only.');
  const lib = $('library-tab');
  lib.toggleAttribute('data-offline', !commsOn);
  lib.title = commsOn ? '' : 'Library offline: no console power or local RF';
  if (dark) $('console-dark').querySelector('p').textContent = `Console offline · no power on ${bus}`;
  updateCover();
  renderDarkness();
  renderLifeSupport();
  renderBay();
  document.body.toggleAttribute('data-console-dark', dark);
  if (!stationView) return;

  // Tactical: contacts (tap to lock; up to 6 locks, a starbase 24), the locks
  // (pick one: aim its phasers at a system, fire), the tractor beam (only on a
  // locked target), arm phasers, the arrays' charge and the torpedoes.
  const wp = document.querySelector('[data-weapons]');
  if (wp) {
    if (!wp.firstChild) {
      wp.append(
        el('h3', { className: 'ops-subhead', textContent: 'Contacts · tap to lock' }), el('div', { className: 'tr-taps', id: 'wp-contacts' }),
        el('p', { className: 'st-state', id: 'weapons-lock-state' }),
        el('h3', { className: 'ops-subhead', id: 'wp-locks-head', textContent: 'Locks' }), el('div', { className: 'tr-taps', id: 'wp-locks' }),
        el('div', { className: 'tr-pick' }, el('span', { className: 'tr-label', textContent: 'Aim' }), el('div', { className: 'tr-taps', id: 'wp-aim' })),
        el('div', { className: 'ops-form wp-fire' },
          button('Arm phasers', 'arm-phasers', () => send({ type: 'arm', on: !lastNav?.own?.combat?.phaser.armed })),
          button('Fire phasers', 'fire-phaser', () => send({ type: 'fire', weapon: 'phaser', ...(wpFocus ? { ship: wpFocus } : {}) }), 'lcars-button--alert'),
          button('Fire torpedo', 'fire-torpedo', () => send({ type: 'fire', weapon: 'torpedo', ...(wpFocus ? { ship: wpFocus } : {}) }), 'lcars-button--alert'),
          button('Release all locks', 'weapons-release', () => send({ type: 'lock', ship: null }))),
        // Torpedo yield (a light bar), and the weapons' and shields' frequencies (taps).
        el('div', { className: 'tr-pick' }, el('span', { className: 'tr-label', textContent: 'Yield' }), (() => { const bar = lightBar('Torpedo yield', 10, (v) => send({ type: 'yield', value: v })); bar.id = 'torpedo-yield'; return bar; })(), el('span', { className: 'ops-hint', id: 'yield-note' })),
        el('div', { className: 'tr-pick' }, el('span', { className: 'tr-label', textContent: 'Weapon freq.' }), el('div', { className: 'tr-taps', id: 'freq-weapons' })),
        el('div', { className: 'tr-pick' }, el('span', { className: 'tr-label', textContent: 'Shield freq.' }), el('div', { className: 'tr-taps', id: 'freq-shields' })),
        el('div', { className: 'tr-pick' }, el('span', { className: 'tr-label', textContent: 'Tractor' }), el('div', { className: 'tr-taps', id: 'tractor-targets' })),
        el('div', { className: 'ops-form' }, button('Release tractor', 'tractor-release', () => send({ type: 'tractor', ship: null })), el('span', { className: 'ops-hint', id: 'tractor-state' })),
        el('div', { className: 'ops-readouts' },
          el('div', { className: 'lcars-readout', id: 'wp-phasers' }), el('div', { className: 'lcars-readout', id: 'wp-torpedoes' })),
        el('p', { className: 'st-state', id: 'wp-torpedo-am' }),
        el('p', { className: 'ops-notice', id: 'weapons-status' }),
        el('p', { className: 'ops-hint', textContent: `Arm phasers to charge the arrays (faster with more power to each array; armed weapons draw power, which shows on sensors). A charged array fires at the lock picked, up to ${c.phaser.range} units, aimed at a system if you pick one. Torpedoes reach ${c.torpedo.range} units and reload in ${c.torpedo.reload / 1000} s; ${c.carried} carried, restocked only when docked at a starbase. Shields soak hits until they fail; then the hull and systems take damage, and with no hull left the ship is destroyed.` }));
    }
    const locks = c.locks || [];
    if (!locks.some((x) => x.name === wpFocus)) wpFocus = c.lock?.name || locks[0]?.name || null;
    const focus = locks.find((x) => x.name === wpFocus) || null;
    // Contacts: ships on sensors (and starbases, which can be locked for the tractor beam only).
    const contacts = [...lastNav.ships.filter((s) => s.name !== own.name).map((s) => ({ name: s.name, distance: s.distance, shields: s.shields })), ...(lastNav.bases || []).filter((b) => b.name !== own.name).map((b) => ({ name: b.name, distance: b.distance, base: true }))];
    const tap = (text, value, on, onclick, why = '') => { const b = button(why ? `${text} · ${why}` : text, '', onclick); b.classList.add('tr-tap'); b.dataset.ship = value; b.setAttribute('aria-pressed', String(!!on)); if (why) { b.disabled = true; b.title = why; } return b; };
    const full = locks.length >= (c.lockMax || 6);
    const sig = JSON.stringify([contacts.map((x) => [x.name, Math.round(x.distance), x.shields]), locks, wpFocus, grid.towing, c.aimable?.length]);
    if (wp.dataset.sig !== sig) {
      wp.dataset.sig = sig;
      wp.querySelector('#wp-contacts').replaceChildren(...(contacts.length ? contacts.map((x) => { const on = locks.some((l) => l.name === x.name); return tap(`${x.base ? x.name : `The ${x.name}`} (${Math.round(x.distance)} units${x.shields ? ', shields up' : ''})`, x.name, on, () => send({ type: 'lock', ship: x.name }), !on && full ? 'all locks in use' : ''); }) : [el('span', { className: 'ops-hint', textContent: 'No contacts on sensors' })]));
      wp.querySelector('#wp-locks-head').textContent = `Locks (${locks.length} of ${c.lockMax || 6}) · tap one to pick it`;
      wp.querySelector('#wp-locks').replaceChildren(...(locks.length ? locks.map((l) => tap(`The ${l.name} · ${l.distance} units · shields ${l.shields ? `up ${l.shield}%` : 'down'} · hull ${l.hull}%${l.aimName ? ` · aimed: ${l.aimName}` : ''}`, l.name, l.name === wpFocus, () => { wpFocus = l.name; wp.dataset.sig = ''; renderCombat(); })) : [el('span', { className: 'ops-hint', textContent: 'No locks' })]));
      // Aim the picked lock's phasers: anywhere, or one of its systems.
      wp.querySelector('#wp-aim').replaceChildren(...(focus ? [['', 'Anywhere'], ...(c.aimable || [])].map(([x, n]) => { const b = tap(n, x, (focus.aim || '') === x, () => send({ type: 'aim', ship: focus.name, system: x || null })); b.dataset.system = x; return b; }) : [el('span', { className: 'ops-hint', textContent: 'Pick a lock to aim at its systems' })]));
      // The tractor beam: only on a locked target.
      wp.querySelector('#tractor-targets').replaceChildren(...(contacts.length ? contacts.map((x) => { const on = locks.some((l) => l.name === x.name); return tap(x.base ? x.name : `The ${x.name}`, x.name, grid.towing === x.name, () => send({ type: 'tractor', ship: x.name }), on ? '' : 'no Tactical lock'); }) : [el('span', { className: 'ops-hint', textContent: 'No contacts' })]));
    }
    const lockState = wp.querySelector('#weapons-lock-state');
    lockState.textContent = focus ? `Locked on the ${focus.name} · ${focus.distance} units · shields ${focus.shields ? `up, ${focus.shield}%` : 'down'} · hull ${focus.hull}%${locks.length > 1 ? ` (and ${locks.length - 1} more)` : ''}` : 'No weapons lock';
    lockState.toggleAttribute('data-up', !!focus);
    wp.querySelector('#weapons-release').disabled = !locks.length;
    wp.querySelector('#tractor-release').disabled = !grid.towing;
    wp.querySelector('#tractor-state').textContent = grid.towing ? `Towing the ${grid.towing} (warp 3 at most)` : grid.towedBy ? `Held in the ${grid.towedBy}'s tractor beam` : 'Tractor beam: holds a locked target within 20 units with its shields down';
    wp.querySelector('#torpedo-yield').set(c.torpedo.yield ?? 5);
    wp.querySelector('#yield-note').textContent = `yield ${c.torpedo.yield ?? 5}: ${c.torpedo.antimatter ?? 10} antimatter a torpedo (bay ${c.torpedo.bay ?? 0}), ${(c.torpedo.reload / 1000).toFixed(1)} s to load`;
    for (const which of ['weapons', 'shields']) {
      const box = wp.querySelector(`#freq-${which}`), cur = c.freq?.[which];
      if (box.dataset.cur === String(cur)) continue;
      box.dataset.cur = String(cur);
      box.replaceChildren(...Array.from({ length: c.freq?.max || 10 }, (_, i) => { const b = button(String(i + 1), '', () => send({ type: 'frequency', [which]: i + 1 })); b.classList.add('tr-tap'); b.dataset.value = String(i + 1); b.setAttribute('aria-pressed', String(cur === i + 1)); return b; }));
    }
    const arm = wp.querySelector('#arm-phasers');
    arm.textContent = c.phaser.armed ? 'Stand down phasers' : 'Arm phasers';
    arm.setAttribute('aria-pressed', String(c.phaser.armed));
    updateWeaponTimers();
    // The torpedo bay's antimatter tank (filled from the antimatter bus by Engineering).
    const bay = grid.fuel?.am?.tanks.find((t) => t.name === 'torpedo');
    wp.querySelector('#wp-torpedo-am').textContent = bay ? `Torpedo bay antimatter: ${bay.level} of ${bay.cap}${grid.fuel.am.down ? ' · antimatter bus offline' : ''}` : '';
  }

  // Engineering: the warp core's reaction (the Warp core panel).
  const wcp = document.querySelector('[data-warpcore]');
  if (wcp && grid.warpCore && changed(wcp, grid.warpCore, grid.core, grid.contain, grid.fuel, grid.start)) {
    const w = grid.warpCore, need = w.need;
    const live = grid.core === 'online' || grid.core === 'starting';
    const state = grid.core === 'ejected' ? 'Ejected' : grid.core === 'starting' ? `Cold ignition · self-sustaining in ${grid.startSecs - grid.start} s` : grid.core === 'online' ? `Running · ${w.actual}% (set ${w.rate}%)` : 'Cold';
    const rate = lightBar('Reaction rate', 100, (v) => send({ type: 'grid', coreRate: v }));
    rate.id = 'core-rate';
    rate.set(w.rate, live ? Math.min(w.actual, w.rate) : 0);
    const mixes = el('span', { className: 'grid-gears' }, ...[10, 12, 15, 20].map((m) => { const b = button(`${m}:1`, `core-mix-${m}`, () => send({ type: 'grid', coreMix: m })); b.setAttribute('aria-pressed', String(w.mix === m)); return b; }));
    const tog = (text, id, on, onTap) => { const b = button(text, id, onTap, 'lcars-toggle'); b.setAttribute('aria-pressed', String(!!on)); return b; };
    // Why the injectors won't open, if they won't.
    const coreTank = (bus) => grid.fuel?.[bus]?.tanks.find((t) => t.name === 'core')?.pct ?? 0;
    const blocks = [grid.contain?.field < need.field && `containment field ${grid.contain.field}% (needs ${need.field}%)`, coreTank('deu') < need.light && `its deuterium tank ${coreTank('deu')}% (needs ${need.light}%)`, coreTank('am') < need.light && `its antimatter tank ${coreTank('am')}% (needs ${need.light}%)`, w.mix < need.mix && `mixture ${w.mix}:1 (cold ignition needs ${need.mix}:1 or richer)`].filter(Boolean);
    wcp.replaceChildren(
      el('p', { className: 'st-state', id: 'wc-state', textContent: `Warp core: ${state}${w.breachT != null ? ` · BREACH IN ${w.breachT} s` : ''}` }),
      el('div', { className: 'ops-readouts' },
        ...[['Output', `${w.output} of ${grid.coreMax}`], ['Efficiency', `${w.eff}%`], ['Core temperature', `${Math.round(w.temp)}%${w.temp > need.hot ? ' · HOT' : ''}`], ['Containment field', `${grid.contain?.field}%`],
          ['Dilithium alignment', `${w.align}%`], ['Crystal integrity', `${w.crystal}%`], ['Core tanks', `deuterium ${coreTank('deu')}% · antimatter ${coreTank('am')}%`], ['Mixture', `${w.mix}:1 (best ${need.bestMix}:1)`]]
          .map(([k, v]) => el('div', { className: 'lcars-readout wc-readout' }, el('span', { textContent: k }), el('b', { textContent: v })))),
      el('div', { className: 'ops-form' }, el('span', { textContent: 'Reaction rate' }), rate),
      el('div', { className: 'ops-form' }, el('span', { textContent: 'Mixture (deuterium : antimatter)' }), mixes),
      el('div', { className: 'ops-form' },
        grid.core === 'offline' ? button('Cold ignition', 'wc-start', () => send({ type: 'grid', core: 'start' })) : grid.core === 'ejected' ? el('span') : button('SCRAM', 'wc-scram', () => send({ type: 'grid', core: 'scram' }), 'lcars-button--alert'),
        tog(`Plasma conduits to nacelles: ${w.plasma ? 'open' : 'closed'}`, 'wc-plasma', w.plasma, () => send({ type: 'grid', plasma: !w.plasma })),
        button('Trim dilithium', 'wc-trim', () => send({ type: 'grid', trim: true })),
        tog(`Auto-trim: ${w.autoTrim ? 'on' : 'off'}`, 'wc-autotrim', w.autoTrim, () => send({ type: 'grid', autoTrim: !w.autoTrim }))),
      el('p', { className: 'ops-hint', id: 'wc-hint', textContent: grid.core === 'offline' && blocks.length ? `The injectors won't open: ${blocks.join('; ')}.` : `Cold ignition runs at ${need.rate}% or less for ${grid.startSecs} s, then the rate climbs to its setting. Auto-trim needs all three computer cores (${w.cores} online). Over ${need.hot}% the core wears the containment field down; when either of its tanks runs dry it flames out.` }));
    wcp.querySelector('#wc-state').toggleAttribute('data-up', w.breachT != null);
  }

  // Engineering: the power grid.
  const gp = document.querySelector('[data-grid]');
  // Not while someone's typing an amount or picking a resource there.
  if (gp && !gp.contains(document.activeElement?.closest?.('input[type=number], select') || null) && changed(gp, grid, own.power, gridOrder)) {
    const status = gp.querySelector('#grid-status')?.textContent || '';
    const keepRes = gp.querySelector('#transfer-resource')?.value, keepAmt = gp.querySelector('#transfer-amount')?.value;
    // A source's ties: any of Bus A, Bus B and the EPS (checkboxes).
    // The grid as a table: a row per source (and containment, and power fed
    // to a docked ship), a column per bus and the EPS, each cell a tie
    // checkbox with the power flowing through it; the footer is used/available.
    const NODE_NAMES = { ODN: 'ODN', A: 'Bus A', B: 'Bus B', C: 'Bus C', EPS: 'EPS', Deu: 'Deu. bus', AM: 'AM bus' };
    // The optical data network (each console's link), the power buses, then the fuel buses.
    const COLS = ['ODN', 'A', 'B', 'C', 'EPS', 'Deu', 'AM'];
    const FUEL_COL = { deu: 'Deu', am: 'AM' };
    // Every row's buttons (Fill / Drain, Import / Export, Light, Start, On / Off, ...) sit in the Controls column.
    const ctlCell = (controls = []) => el('td', { className: 'grid-controls' }, ...controls);
    // The column a node's cell is in (after the System and Controls columns).
    const colAt = (tr, n) => tr.children[2 + COLS.indexOf(n)];
    // A row: label (with a note), its controls, then a cell per node:
    // the tie checkbox (only where this row may tie) and the power through it,
    // + for supply, − for draw.
    const SOURCE_ROWS = new Set(['ship', 'shipEps', 'solar', 'dock', 'dockEps', 'emergA', 'emergB', 'emergC', 'impulsePort', 'impulseStarboard', 'core', 'stores']);
    const ties = (key, label, cellKey = key, { level = 0, note = '', controls = [], sign } = {}) => {
      const cut = grid.cutOff?.[key];
      if (cut?.length) note = `${note ? `${note} · ` : ''}CUT OFF (${cut.map((n) => NODE_NAMES[n]).join(', ')}): a conduit above isn't tied`;
      const th = el('th', { scope: 'row' }, el('span', { textContent: label }), ...(note ? [el('small', { className: 'grid-note', textContent: note })] : []));
      if (level) th.className = `grid-indent grid-indent--${level}`;
      const tr = el('tr', { id: `ties-${key.replace(':', '-')}` }, th, ctlCell(controls));
      const allowed = grid.tieNodes[key] || [];
      const plus = sign ?? SOURCE_ROWS.has(cellKey);
      for (const n of COLS) {
        if (!allowed.includes(n)) { tr.append(el('td', { className: 'grid-na', textContent: '·', title: `can't be tied to ${NODE_NAMES[n]}` })); continue; }
        const box = el('input', { type: 'checkbox', checked: grid.ties[key].includes(n), ariaLabel: `${label}: ${NODE_NAMES[n]}` });
        box.dataset.node = n;
        // One tie for sources and EPS loads: tapping another moves it, tapping the lit one unties it.
        // Several for low-power loads (their load split evenly) and the crosslink.
        box.onchange = () => send({ type: 'grid', ties: { [key]: grid.multi.includes(key) ? COLS.filter((m) => (m === n ? box.checked : grid.ties[key].includes(m))) : box.checked ? [n] : [] } });
        const v = grid.cells[cellKey]?.[n] || 0;
        const text = !v ? '' : v < 0 || !plus ? `−${Math.abs(v)}` : `+${v}`;
        tr.append(el('td', {}, el('label', { className: 'grid-tie' }, box, el('span', { className: `grid-flow${text.startsWith('+') ? ' grid-flow--in' : ''}`, textContent: text }))));
      }
      return tr;
    };
    // A system with subsystems (the warp core, an impulse drive) has no tie
    // cells of its own: status and controls only; its subsystems carry the ties.
    const parentRow = (id, label, level, note, controls = []) => {
      const tr = el('tr', { id }, el('th', { scope: 'row', className: `grid-indent grid-indent--${level}` }, el('span', { textContent: label }), ...(note ? [el('small', { className: 'grid-note', textContent: note })] : [])), ctlCell(controls));
      for (const n of COLS) tr.append(el('td', { className: 'grid-na' }));
      return tr;
    };
    const small = (text, id, onclick, alert) => { const b = button(text, id, onclick, alert ? 'lcars-button--alert' : ''); b.classList.add('grid-mini'); return b; };
    const subRow = (name, level, note) => ties(`sub:${name}`, grid.subsystems[name].name, `sub:${name}`, { level, note: note ?? (grid.subOk[name] === false ? 'NO POWER' : '') });
    // A tap row across the bus columns: on/off (lit when on).
    const toggleRow = (id, label, level, on, onTap, note = '') => {
      const b = small(on ? 'On' : 'Off', `${id}-toggle`, onTap);
      b.classList.add('lcars-toggle');
      b.setAttribute('aria-pressed', String(!!on));
      return spanRow(id, label, level, null, note, [b]);
    };
    // A fusion reactor (an impulse drive or an aux reactor): its reaction
    // chamber (light / shut down), deuterium pump and EPS tap; a drive's
    // accelerators (throttle) and driver coils (gear) and thrusters; an aux
    // reactor's power output to the EPS.
    const reactorRows = (rn, x, { drive = false } = {}) => {
      const cap = (t) => `${t[0].toUpperCase()}${t.slice(1)}`;
      const label = drive ? `${cap(rn)} impulse drive` : `Aux fusion reactor ${rn.slice(3)}`;
      const src = drive ? `impulse${cap(rn)}` : rn;
      const state = x.state === 'starting' ? `lighting ${x.start} of ${grid.impulseStartSecs} s` : x.state;
      const out = drive ? (x.state === 'running' ? ` · ${grid.cells[src]?.EPS || 0} of ${grid.impulseOutput} to the EPS, the rest to thrust` : '') : (x.state === 'running' ? ` · ${grid.cells[src]?.EPS || 0} of ${grid.auxOutput} to the EPS` : '');
      const self = x.epsTap && grid.epsLive && x.state === 'running';
      // The chamber's own pressure (its pump pulls deuterium from the feed): it lights at the feed's minimum.
      // The chamber burns from the reactor's own deuterium tank: it lights at the bus's minimum.
      const tank = grid.fuel?.deu?.tanks.find((t) => t.name === rn);
      const press = `tank ${tank?.pct ?? 0}% (lights at ${grid.fuel?.deu?.light ?? 30}%)`;
      const chamber = subRow(`${rn}Chamber`, 2, `${press}${x.state === 'starting' ? (grid.subOk[`${rn}Chamber`] ? ' · lighting' : ' · NO POWER') : x.state === 'running' ? (self ? ' · self-powered from the EPS' : ' · on its bus ties') : ''}`);
      chamber.querySelector('.grid-controls').prepend(x.state === 'off' ? small('Light', `${rn}-start`, () => send({ type: 'grid', reactor: { name: rn, on: true } })) : small('Shut down', `${rn}-stop`, () => send({ type: 'grid', reactor: { name: rn, on: false } }), true));
      const rows = [
        parentRow(`ties-${src}`, label, 1, `${state}${out}`),
        ...tankRow('deu', rn), // (the tank above the chamber it feeds)
        chamber,
        toggleRow(`${rn}-epstap`, 'EPS tap', 2, x.epsTap, () => send({ type: 'grid', reactor: { name: rn, epsTap: !x.epsTap } }), x.epsTap ? (grid.epsLive ? 'running, the chamber powers itself from the EPS' : 'the EPS isn\'t energized: on its bus ties') : 'the chamber runs on its bus ties'),
      ];
      if (drive) {
        const bar = lightBar(`${label} accelerators`, 100, (v) => send({ type: 'grid', reactor: { name: rn, accel: v } }));
        bar.id = `accel-${rn}`;
        bar.set(x.accel);
        const gears = el('span', { className: 'grid-gears' }, ...['low', 'high'].map((g) => { const b = small(g === 'low' ? 'Low' : 'High', `${rn}-gear-${g}`, () => send({ type: 'grid', reactor: { name: rn, gear: g } })); b.setAttribute('aria-pressed', String(x.gear === g)); return b; }));
        rows.push(
          spanRow(`${rn}-accel`, 'Accelerators', 2, bar, `throttle ${x.accel}%`),
          spanRow(`${rn}-coils`, 'Driver coils', 2, null, x.gear === 'low' ? 'Low gear: quick, a quarter impulse at most' : 'High gear: full impulse, slower to build', [gears]),
          ties(`thrusters${cap(rn)}`, 'Maneuvering thrusters', `thrusters${cap(rn)}`, { level: 2, note: x.thrusters ? 'tied in: the drive\'s unused thrust feeds the EPS' : 'untied: thrust only, nothing to the EPS' }));
      } else rows.push(ties(rn, 'Power output', rn, { level: 2, note: `${grid.auxOutput} to the EPS while running` }));
      return rows;
    };
    const driveRows = (d) => reactorRows(d, grid.drives[d], { drive: true });
    const auxRows = () => Object.entries(grid.aux || {}).flatMap(([a, x]) => reactorRows(a, x));
    // The fuel buses. A tank row: its level and Fill / Drain, tied to its bus
    // by the checkbox in that bus's column; an antimatter tank (but the pods,
    // whose containment has its own row) also ties to the low buses for its
    // own containment, its field shown. Each system's tank sits under it.
    const tankRow = (bus, name, level = 2) => {
      const t = grid.fuel?.[bus]?.tanks.find((x) => x.name === name);
      if (!t) return [];
      const fill = small('Fill', `tank-${bus}-${t.name}-fill`, () => send({ type: 'grid', tank: { bus, name: t.name, fill: !t.fill } }));
      const drain = small('Drain', `tank-${bus}-${t.name}-drain`, () => send({ type: 'grid', tank: { bus, name: t.name, drain: !t.drain } }));
      for (const [b, on] of [[fill, t.fill], [drain, t.drain]]) { b.classList.add('lcars-toggle'); b.setAttribute('aria-pressed', String(!!on)); }
      const label = `${bus === 'am' ? 'Antimatter' : 'Deuterium'}${t.name === 'main' ? `: ${t.label}` : ' tank'}`;
      // The pods' containment: the ship's main antimatter containment (field, internal reserve, breach countdown).
      const pods = bus === 'am' && t.name === 'main';
      const podsNote = !grid.antimatter ? ' · containment: no antimatter, may be off' : ` · containment field ${grid.contain?.field}% · reserve ${grid.contain?.reserve}% (${grid.contain?.reserveSecs} s)${grid.breach != null ? ` · FAILING: breach in ${grid.breach} s` : grid.contain?.onReserve ? ' · ON RESERVE: restore its feed' : ''}`;
      const note = `${t.level} of ${t.cap} (${t.pct}%)${t.name !== 'main' && t.pct < grid.fuel[bus].light ? ' · LOW' : ''}${pods ? podsNote : t.field != null && t.level > 0 ? ` · containment ${t.field}%${t.field < 100 ? ' FAILING' : ''}` : ''}`;
      const own = bus === 'am' && t.containKey;
      const tr = own ? ties(t.containKey, label, t.containKey, { level, sign: false, note, controls: [fill, drain] })
        : el('tr', {}, el('th', { scope: 'row', className: `grid-indent grid-indent--${level}` }, el('span', { textContent: label }), el('small', { className: 'grid-note', textContent: note })), ctlCell([fill, drain]), ...COLS.map(() => el('td', { className: 'grid-na' })));
      tr.id = `tank-${bus}-${t.name}`;
      const cell = colAt(tr, FUEL_COL[bus]);
      const box = el('input', { type: 'checkbox', checked: t.tied, ariaLabel: `${label}: ${NODE_NAMES[FUEL_COL[bus]]}` });
      box.onchange = () => send({ type: 'grid', tank: { bus, name: t.name, tied: box.checked } });
      cell.className = ''; cell.replaceChildren(el('label', { className: 'grid-tie' }, box));
      return [tr];
    };
    // Fuel storage: the buses' state, then the main storage on each.
    const storageRows = () => ['deu', 'am'].flatMap((bus) => {
      const fb = grid.fuel?.[bus];
      if (!fb) return [];
      const xfer = `${bus}Transfer`;
      return [parentRow(`fuel-${bus}`, bus === 'deu' ? 'Deuterium bus' : 'Antimatter bus', 1, fb.down ? `${fb.why.toUpperCase()}: nothing moves` : fb.flow ? `moving ${fb.flow} a second` : 'idle'),
        subRow(xfer, 2, `${grid.ties[`sub:${xfer}`]?.length ? '' : 'untied: nothing moves · '}draws ${bus === 'deu' ? '5 while deuterium moves' : '5 all the time it\'s tied'}`),
        ...tankRow(bus, 'main')];
    });
    // The computer cores: a parent row, then each core with its Boot / Shut down tap and boot stage.
    const computerRows = () => {
      const cs = grid.computers || [];
      return [
        parentRow('ties-computer-parent', 'Computer cores', 1, `${cs.filter((x) => x.state === 'online').length} of ${cs.length} online${cs.some((x) => x.state === 'online') ? '' : ' · EPS taps need one'}`),
        ...cs.map((x, i) => {
          const n = i + 1;
          const note = x.state === 'booting' ? `booting: ${x.stage} (${x.t} of ${grid.computerBootSecs} s)` : x.state;
          // (A core boots by itself once tied and powered; it crashes without power, and boots again when it's back.)
          return subRow(`computer${n}`, 2, x.state === 'off' ? 'off: boots once tied to a bus with power' : x.state === 'crashed' ? 'CRASHED: power lost, boots again when it returns' : note);
        }),
      ];
    };
    // A row with a control across the bus columns (EPS taps' light bars).
    const spanRow = (id, label, level, control, note = '', controls = []) => {
      const tr = el('tr', { id }, el('th', { scope: 'row', className: `grid-indent grid-indent--${level}` }, el('span', { textContent: label }), ...(note ? [el('small', { className: 'grid-note', textContent: note })] : [])), ctlCell(controls));
      tr.append(el('td', { colSpan: COLS.length }, ...(control ? [control] : [])));
      return tr;
    };
    const tapRows = () => [
      // What's flowing down the taps: out of the EPS, into each bus.
      (() => {
        const tr = parentRow('eps-taps', 'EPS taps', 1, `${grid.epsLive ? 'EPS energized' : `EPS NOT ENERGIZED: the manifold charges from ${grid.epsChargeGen}+ of EPS generation (now ${grid.epsGen})`} · EPS power down into each low bus, up to the level set (a computer core works the regulators)`);
        COLS.forEach((n) => { const v = grid.cells.taps?.[n] || 0; colAt(tr, n).replaceChildren(el('span', { className: `grid-flow${v > 0 ? ' grid-flow--in' : ''}`, textContent: v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '' })); });
        return tr;
      })(),
      ...['A', 'B', 'C'].map((X) => {
        const bar = lightBar(`EPS tap to Bus ${X}`, grid.busMax[X], (v) => send({ type: 'grid', tap: { bus: X, amount: v } }));
        bar.id = `tap-${X}`;
        bar.set(grid.taps[X]);
        return spanRow(`tap-row-${X}`, `EPS → Bus ${X}`, 2, bar, `${grid.taps[X] ? `up to ${grid.taps[X]}` : 'closed'}`);
      }),
    ];
    const crosslinkRow = () => ties('crosslink', 'Bus crosslink', 'crosslink', { level: 1, note: grid.ties.crosslink.length >= 2 ? `Bus ${grid.ties.crosslink.join(' + ')} share one pool` : 'check two or more buses to join them' });
    // Engineering's own rows: life support, then every power source and its subsystems.
    const engineeringRows = () => [
      parentRow('ties-core-parent', 'Warp core (M/ARC)', 1, grid.core === 'starting' ? `starting ${grid.start} of ${grid.startSecs} s` : grid.core,
        [...(grid.core === 'ejected' ? [] : grid.core === 'offline' ? [small('Start', 'core-start', () => send({ type: 'grid', core: 'start' }))] : [small('Stop', 'core-stop', () => send({ type: 'grid', core: 'stop' }), true)]),
          // Only in the shipyard's drydock: a new warp core and antimatter pods.
          ...(grid.drydock?.in ? [small('Replace core', 'core-replace', () => send({ type: 'grid', refit: true }))] : [])]),
      ...(grid.core !== 'ejected' ? [
        // (The core's tanks above the injectors they feed.)
        ...['constriction', 'amConduit'].map((x) => subRow(x, 2)),
        ...tankRow('deu', 'core'), ...tankRow('am', 'core'),
        subRow('injector', 2),
        ties('core', 'Power transfer conduits', 'core', { level: 2, note: c.damage.conduits >= 50 ? 'DAMAGED: no output' : 'carry the core\'s output into the EPS' }),
        ...(grid.starbase ? [] : [toggleRow('core-plasma', 'Plasma transfer conduits', 2, grid.warpCore?.plasma, () => send({ type: 'grid', plasma: !grid.warpCore?.plasma }), grid.warpCore?.plasma ? 'open to the nacelles: warp' : 'closed: no warp')]),
      ] : []),
      ...driveRows('port'), ...driveRows('starboard'),
      ...auxRows(),
      ...tapRows(),
      ...computerRows(),
    ];
    // External sources: solar (Bus B), then the connections.
    const sourceRows = () => [ties('solar', 'Solar', 'solar', { level: 1 })];
    // Connections: the starbase and each ship docked with us. Per connection,
    // Deuterium, Antimatter and Power, each with Import and Export (import
    // keeps ours full, export keeps ours empty, both hold a set point); power
    // ties to Bus B and/or the EPS.
    const connectionRows = () => (grid.connections || []).flatMap((x) => {
      const slug = x.name.replace(/\W+/g, '-');
      const io = (res, c) => ['imp', 'exp'].map((d) => {
        const b = small(d === 'imp' ? 'Import' : 'Export', `conn-${slug}-${res}-${d}`, () => send({ type: 'grid', conn: { with: x.kind === 'station' ? 'station' : x.name, res, [d]: !c[d] } }));
        b.classList.add('lcars-toggle'); b.setAttribute('aria-pressed', String(!!c[d]));
        return b;
      });
      const fuelRow = (res, label, have, cap) => {
        const c = x[res];
        const note = `ours ${Math.round((100 * have) / cap)}%${c.flow ? ` · ${c.flow > 0 ? `+${c.flow}` : c.flow} a second` : ''}${c.why ? ` · ${c.why}` : ''}${c.imp && c.exp ? ' · holding 50%' : ''}`;
        const tr = el('tr', { id: `conn-${slug}-${res}` }, el('th', { scope: 'row', className: 'grid-indent grid-indent--2' }, el('span', { textContent: label }), el('small', { className: 'grid-note', textContent: note })), ctlCell(io(res, c)), ...COLS.map(() => el('td', { className: 'grid-na' })));
        return tr;
      };
      // Power (Bus B, set point Battery B full) and EPS (the EPS, set point the manifold full).
      const moving = (v) => (v > 0 ? `+${v} in` : v < 0 ? `${v} out` : 'nothing moving');
      const src = x.kind === 'station' ? 'dock' : 'ship';
      const power = ties(src, 'Power', src, { level: 2, controls: io('power', x.power), note: `${x.power.imp && x.power.exp ? 'holding Battery B full · ' : ''}${moving(x.powerIn)}` });
      power.id = `conn-${slug}-power`;
      const eps = ties(`${src}Eps`, 'EPS', `${src}Eps`, { level: 2, controls: io('eps', x.eps), note: `${x.eps.imp && x.eps.exp ? 'holding the manifold full · ' : ''}${moving(x.epsIn)}` });
      eps.id = `conn-${slug}-eps`;
      const parent = parentRow(`conn-${slug}`, x.kind === 'station' ? `${x.name} (${x.port} dock)` : `The ${x.name} (${x.port} dock)`, 1, x.kind === 'station' ? `a starbase: it always has fuel to give and room to take${x.hardLink ? ' · hard link: docking port' : ''}` : '');
      // The starbase connection's ties: the ODN (a hard data link) on its own row; the Deu. and
      // AM buses (its Import / Export need them) on the Deuterium and Antimatter rows.
      const deu = fuelRow('deu', 'Deuterium', grid.deuterium, grid.fuelCaps.deuterium), am = fuelRow('am', 'Antimatter', grid.antimatter, grid.fuelCaps.antimatter);
      if (x.kind === 'station' && x.ties) for (const [res, col, row] of [['deu', 'Deu', deu], ['am', 'AM', am], ['odn', 'ODN', parent]]) {
        const box = el('input', { type: 'checkbox', checked: !!x.ties[res], ariaLabel: `${x.name} connection: ${NODE_NAMES[col]}` });
        box.id = `conn-tie-${res}`;
        box.onchange = () => send({ type: 'grid', connTie: { res, on: box.checked } });
        const cell = colAt(row, col);
        cell.className = ''; cell.replaceChildren(el('label', { className: 'grid-tie' }, box));
      }
      // A spore drive's reserve: from or to the starbase.
      const spores = x.kind === 'station' && grid.spore ? [(() => { const c = x.spores; const tr = el('tr', { id: `conn-${slug}-spores` }, el('th', { scope: 'row', className: 'grid-indent grid-indent--2' }, el('span', { textContent: 'Spores' }), el('small', { className: 'grid-note', textContent: `ours ${Math.round((100 * grid.spore.spores) / grid.spore.cap)}%${c.flow ? ` · ${c.flow > 0 ? `+${c.flow}` : c.flow} a second` : ''}` })), ctlCell(io('spores', c)), ...COLS.map(() => el('td', { className: 'grid-na' }))); return tr; })()] : [];
      return [parent, deu, am, power, eps, ...spores];
    });
    // The stores, one per column under the headings: each bus's battery and
    // the EPS manifold's pressure, how full, and charging (−) or covering a shortfall (+).
    const storesRow = () => {
      const tr = el('tr', { id: 'grid-stores', className: 'grid-stores' }, el('th', { scope: 'row', textContent: 'Batteries · EPS pressure' }), el('td'));
      for (const n of COLS) {
        const st = grid.stores?.[n];
        if (!st) { tr.append(el('td', { className: 'grid-na' })); continue; }
        const flow = st.supplying ? `+${st.supplying}` : st.charging ? `−${st.charging}` : '';
        // A battery's main breaker: a tap to put it in or out of service.
        const brk = st.breaker == null ? [] : [(() => {
          const box = el('input', { type: 'checkbox', checked: st.breaker, ariaLabel: `Battery ${n} main breaker`, id: `breaker-${n}` });
          box.onchange = () => send({ type: 'grid', breaker: { bus: n, on: box.checked } });
          return box;
        })()];
        tr.append(el('td', {}, ...brk, el('span', { className: 'grid-store-level', textContent: `${n === 'EPS' ? 'Pressure' : 'Battery'} ${st.level}%` }), el('span', { className: `grid-flow${st.supplying ? ' grid-flow--in' : ''}`, textContent: flow })));
      }
      tr.querySelectorAll('td').forEach((td) => td.toggleAttribute('data-low', /\b([0-9]|1[0-9]|2[0-4])%/.test(td.textContent)));
      return tr;
    };
    // The emergency batteries, right under the bus batteries: one per bus, tied
    // to it or not (checkbox), charge %, + while supplying; they never recharge.
    // Docked at a starbase, Replace swaps in a full one.
    const emergRow = () => {
      const tr = el('tr', { id: 'grid-emerg', className: 'grid-stores grid-emerg' }, el('th', { scope: 'row', textContent: 'Emergency batteries' }), el('td', { className: 'grid-controls', textContent: grid.canReplace ? '' : 'replaced at a starbase' }));
      for (const n of COLS) {
        const b = (grid.emerg || []).find((x) => x.bus === n);
        if (!b) { tr.append(el('td', { className: 'grid-na' })); continue; }
        const box = el('input', { type: 'checkbox', checked: (grid.ties[b.name] || []).includes(n), ariaLabel: `Emergency battery ${n}: Bus ${n}`, id: `emerg-tie-${n}` });
        box.dataset.node = n;
        box.onchange = () => send({ type: 'grid', ties: { [b.name]: box.checked ? [n] : [] } });
        tr.append(el('td', {}, box, el('span', { className: 'grid-store-level', textContent: `Emergency ${b.pct}%` }), el('span', { className: `grid-flow${b.supplying ? ' grid-flow--in' : ''}`, textContent: b.supplying ? `+${b.supplying}` : '' }),
          ...(grid.canReplace ? [small('Replace', `${b.name}-replace`, () => send({ type: 'grid', emergReplace: b.name }))] : [])));
      }
      tr.querySelectorAll('td').forEach((td) => td.toggleAttribute('data-low', /\b([0-9]|1[0-9]|2[0-4])%/.test(td.textContent)));
      return tr;
    };
    const table = () => {
      const SYS = { ...Object.fromEntries(POWER), amBus: 'AM bus magnetic containment', spore: 'Spore drive', tractor: 'Tractor beam', drydock1: 'Drydock connection 1', drydock2: 'Drydock connection 2', drydock3: 'Drydock connection 3', industrial: 'Industrial replicators', phaser1: 'Phaser array 1', phaser2: 'Phaser array 2', phaser3: 'Phaser array 3', phaser4: 'Phaser array 4' };
      // (Every row named: a system without a name here shows its id, and says so.)
      const sysName = (sys) => SYS[sys] || (console.warn(`grid: no display name for the ${sys} system`), sys);
      const crewAt = (st) => comms.users.filter((u) => u.ship.toLowerCase() === me.ship.toLowerCase() && u.station === st).length;
      const consoles = Object.keys(grid.tieNodes).filter((x) => x.startsWith('console:')).map((x) => x.slice(8));
      // A console's rows: the console, its systems, and its subsystems (Engineering: the reactors too).
      const consoleRows = (st, { reactors = true } = {}) => {
        const n = crewAt(st), rows = [];
        const linked = grid.odn?.[st] !== false;
        const con = ties(`console:${st}`, `${st} console`, `console:${st}`, { note: `${n ? (grid.consoleOk[st] ? `${n} aboard` : `${n} aboard · DARK`) : 'unmanned'}${linked ? '' : ' · OFF THE ODN'}` });
        // Its ODN link (Engineering's can't be cut).
        const box = el('input', { type: 'checkbox', checked: linked, disabled: st === 'Engineering', ariaLabel: `${st} console: optical data network` });
        box.onchange = () => send({ type: 'grid', odn: { station: st, on: box.checked } });
        const odnCell = colAt(con, 'ODN');
        odnCell.className = ''; odnCell.replaceChildren(el('label', { className: 'grid-tie' }, box));
        rows.push(con);
        const sysRow = (sys, level) => {
          // A parent (Life support): no ties of its own, its systems under it.
          if (grid.systemParents?.[sys]) {
            const kids = grid.systemChildren[sys] || [];
            // (A parent system is a conduit too: its ties carry power on to its systems.)
            const short = kids.some((x) => grid.delivered[x] < grid.demand[x]) ? 'SHORT' : '';
            rows.push(grid.tieNodes[`system:${sys}`] ? ties(`system:${sys}`, grid.systemParents[sys], `system:${sys}`, { level, note: short || 'conduit: draws nothing' }) : parentRow(`ties-system-${sys}`, grid.systemParents[sys], level, short));
            for (const child of kids) sysRow(child, level + 1);
            return;
          }
          // (Shown rounded up: a load split over places can be fractional.)
          const up = (v) => Math.ceil(v - 1e-9);
          const want = up(sys === 'tractor' ? (grid.towing ? 30 : 0) : grid.demand[sys]), got = up(sys === 'tractor' ? want : grid.delivered[sys]);
          // A starbase's industrial replicators: a light bar (taps) for how hard they run.
          // (And each phaser array's, ten taps for the power it may draw.)
          const controls = sys === 'industrial' || /^phaser\d$/.test(sys) ? [(() => { const bar = lightBar(sysName(sys), 100, (v) => send({ type: 'power', power: { [sys]: v } })); bar.id = `${sys}-bar`; bar.set(lastNav?.own?.allocated?.[sys] ?? 0); return bar; })()] : [];
          const idle = /^drydock\d$/.test(sys) ? 'no ship in this berth' : 'off';
          rows.push(ties(`system:${sys}`, sysName(sys), `system:${sys}`, { level, controls, note: want ? `${got} of ${want}${got < want ? ' · SHORT' : ''}${got > 100 ? ' · OVERDRIVE' : ''}` : idle }));
          if (sys === 'weapons') rows.push(...tankRow('am', 'torpedo', level + 1)); // the torpedo bay's antimatter
          for (const child of grid.systemChildren[sys] || []) sysRow(child, level + 1);
        };
        for (const sys of grid.stationSystems[st] || []) sysRow(sys, 1);
        if (st === 'Engineering' && reactors) rows.push(...engineeringRows());
        // Any station's own subsystems (Communications' RF, radio and relay; Security's force field emitters).
        rows.push(...Object.entries(grid.subsystems).filter(([, v]) => v.parent === st).map(([x]) => subRow(x, 1)));
        return rows;
      };
      // A place aboard: a sub-heading over its consoles' rows.
      // (A place is a conduit on each bus: its ties carry power on to everything in it.)
      const placeRow = (label, name) => {
        if (!name || !grid.tieNodes[`place:${name}`]) return el('tr', { className: 'grid-place' }, el('th', { scope: 'rowgroup', colSpan: COLS.length + 2 }, el('span', { textContent: label })));
        const tr = ties(`place:${name}`, label, `place:${name}`, { note: 'conduit: draws nothing' });
        tr.classList.add('grid-place');
        return tr;
      };
      const header = (text, extra = []) => { const tr = el('tr', { className: 'grid-section' }, el('th', { scope: 'rowgroup', colSpan: COLS.length + 2 }, el('span', { textContent: text }), ...extra)); return tr; };
      const divide = (rows) => { rows[rows.length - 1]?.classList.add('grid-crosslink'); return rows; };
      const xl = () => { const r = crosslinkRow(); r.querySelector('th').className = ''; return withFlows(r); };
      // Power moving along the crosslink (A–B, B–C): a bar in the gap between
      // the two buses' checkboxes, pulsing the way it flows, the amount in the middle.
      const withFlows = (row) => {
        for (const [pair, v] of Object.entries(grid.crossflow || {})) {
          const [x, y] = pair.split(''), from = v > 0 ? x : y, to = v > 0 ? y : x;
          const td = colAt(row, x);
          if (!td) continue;
          td.classList.add('xflow-host');
          td.append(el('div', { className: `xflow-bar xflow-bar--${from === x ? 'right' : 'left'}`, title: `${Math.abs(v)} from Bus ${from} to Bus ${to}` },
            el('span', { className: 'xflow-label', textContent: `${from === x ? '' : '← '}${Math.abs(v)}${from === x ? ' →' : ''}` })));
          td.lastChild.dataset.flow = `${from}${to}`;
        }
        requestAnimationFrame(() => placeFlows(row));
        return row;
      };
      const rows = [];
      if (gridOrder === 'operations') {
        // Management layout: power sources, the crosslink, batteries, then the consoles.
        rows.push(header('External sources'), ...divide([...sourceRows(), ...connectionRows()]), header('Bus crosslink'), ...divide([xl()]));
        // Then everything else by where it is aboard (the design's places, in deck order): a heading
        // for each place, then its consoles and systems, each with its subsystems under it. A place
        // lists its rows ('system:x', 'sub:x', or a row's id); a row it doesn't name stays with the
        // one before it, and anything no place names goes to the default place.
        const rowId = (k) => (/^(system|sub|console):/.test(k) ? `ties-${k.replace(':', '-')}` : k);
        const places = window.PLACES || [], fallback = places.find((p) => p.default) || places[places.length - 1];
        const placeOfRow = new Map(places.flatMap((p) => [...p.stations.map((st) => [`ties-console-${st}`, p]), ...(p.rows || []).map((k) => [rowId(k), p])]));
        const segments = [], heads = new Set();
        for (const r of [...storageRows(), ...consoles.flatMap((st) => consoleRows(st))]) {
          if ((placeOfRow.has(r.id) && !heads.has(r.id)) || !segments.length) { heads.add(r.id); segments.push({ head: r.id, place: placeOfRow.get(r.id) || fallback, rows: [r] }); }
          else segments[segments.length - 1].rows.push(r);
        }
        const order = (p, id) => { const list = [...p.stations.map((st) => `ties-console-${st}`), ...(p.rows || []).map(rowId)]; return list.indexOf(id) + 1 || 999; };
        for (const p of [...places].sort((a, b) => a.deck - b.deck)) {
          const mine = segments.filter((g) => g.place === p).sort((a, b) => order(p, a.head) - order(p, b.head));
          if (mine.length) rows.push(placeRow(`Deck ${p.deck} · ${p.name}`, p.name), ...mine.flatMap((g) => g.rows));
        }
        if (!places.length) rows.push(...segments.flatMap((g) => g.rows)); // (no design yet)
      } else {
        // Startup / Shutdown: a checklist, worked top to bottom.
        const busOn = ['A', 'B', 'C'].some((X) => grid.totals[X]?.available > 0);
        const epsOn = grid.totals.EPS?.available > 0;
        const running = grid.core === 'online' || grid.core === 'starting' || Object.values(grid.drives).some((d) => d.state !== 'off');
        const cells = (k) => Object.values(grid.cells[k] || {}).reduce((a, b) => a + Math.abs(b), 0);
        const drives = Object.values(grid.drives);
        const others = consoles.filter((st) => st !== 'Engineering');
        const engNoReactors = () => consoleRows('Engineering', { reactors: false });
        const containment = tankRow('am', 'main'); // (the pods' row carries their containment ties)
        // In Shutdown the core's rows run the other way under it (conduits first, constriction last).
        const coreRows = () => { const [head, ...rest] = engineeringRows().filter((r) => /^(ties-(core|sub-constriction|sub-amConduit|sub-injector)|core-plasma|tank-(deu|am)-core)/.test(r.id)); return [head, ...(gridOrder === 'shutdown' ? rest.reverse() : rest)]; };
        const driveRowsAll = () => [...driveRows('port'), ...driveRows('starboard')];
        const steps = [
          { title: 'External sources', rows: () => [...sourceRows(), ...connectionRows()], state: () => (['dock', 'dockEps', 'solar', 'ship', 'shipEps'].reduce((n, x) => n + cells(x), 0) > 0 ? 'Online' : 'Cold'),
            off: () => (running ? 'shut down the warp core and impulse drives first' : '') },
          // (The stores sit under the column headings; this step has no controls.)
          { title: 'Bus batteries and EPS pressure', rows: () => [], state: () => (Object.values(grid.stores || {}).some((x) => x.breaker && x.level > 0) ? 'Online' : 'Cold') },
          { title: 'Bus crosslink', rows: () => [xl()], state: () => (grid.ties.crosslink.length >= 2 ? 'Online' : 'Cold'),
            off: () => (running ? 'shut down the warp core and impulse drives first' : '') },
          { title: 'Engineering console', rows: engNoReactors, state: () => (grid.ties['console:Engineering'].length ? (grid.consoleOk.Engineering ? 'Online' : 'Startup') : 'Cold'),
            on: () => (busOn ? '' : 'the Engineering console needs Bus A, B or C energized'), off: () => (running ? 'shut down the warp core and impulse drives first' : '') },
          { title: 'Computer cores', rows: computerRows, state: () => { const cs = grid.computers || []; return cs.length && cs.every((x) => x.state === 'online') ? 'Online' : cs.some((x) => x.state === 'booting' || x.state === 'online') ? 'Startup' : 'Cold'; },
            on: () => (busOn ? '' : 'the computer cores need Bus A, B or C energized') },
          { title: 'Antimatter containment', rows: () => containment, state: () => (!grid.antimatter ? 'Cold' : grid.ties.containment.length && grid.containmentOk ? 'Online' : 'Startup'),
            on: () => (grid.core === 'ejected' ? 'no warp core aboard' : busOn ? '' : 'containment needs Bus A, B or C energized'), off: () => (grid.antimatter ? 'containment can\'t be cut with antimatter aboard: offload it at a starbase' : '') },
          // (The pods' row is under Antimatter containment.)
          { title: 'Fuel buses', rows: () => storageRows().filter((r) => r.id !== 'tank-am-main'), state: () => { const sys = ['deu', 'am'].flatMap((b) => grid.fuel?.[b]?.tanks.filter((t) => t.name !== 'main' && t.name !== 'torpedo') || []); return sys.length && sys.every((t) => t.pct >= (grid.fuel.deu.light || 30)) ? 'Online' : sys.some((t) => t.fill && t.tied) ? 'Startup' : 'Cold'; },
            on: () => (!grid.deuterium && !grid.antimatter ? 'no fuel aboard: onboard deuterium and antimatter' : '') },
          { title: 'Impulse drives', rows: driveRowsAll, state: () => (drives.every((d) => d.state === 'running') ? 'Online' : drives.some((d) => d.state !== 'off') ? 'Startup' : 'Cold'),
            on: () => (busOn ? '' : 'the reaction chambers need Bus A, B or C energized') },
          { title: 'Aux fusion reactors', rows: auxRows, state: () => { const xs = Object.values(grid.aux || {}); return xs.length && xs.every((x) => x.state === 'running') ? 'Online' : xs.some((x) => x.state !== 'off') ? 'Startup' : 'Cold'; },
            on: () => (busOn ? '' : 'the reaction chambers need Bus A, B or C energized') },
          { title: 'EPS taps', rows: tapRows, state: () => (Object.values(grid.taps).some((v) => v > 0) ? 'Online' : 'Cold'),
            on: () => (!grid.epsLive ? `the EPS isn't energized: the manifold charges from ${grid.epsChargeGen}+ of EPS generation` : !(grid.computers || []).some((x) => x.state === 'online') ? 'the EPS taps need a computer core online' : epsOn ? '' : 'the EPS taps need the EPS energized') },
          { title: 'Warp core', rows: coreRows, state: () => ({ online: 'Online', starting: 'Startup', ejected: 'Ejected' })[grid.core] || 'Cold',
            on: () => (grid.core === 'ejected' ? 'no warp core: install one at a starbase' : !grid.antimatter ? 'the warp core needs antimatter aboard' : busOn ? '' : 'the constriction needs Bus A, B or C energized') },
          { title: 'Consoles and systems', rows: () => byPlace(others).flatMap((g) => [placeRow(g.label, g.name), ...g.items.flatMap((st) => consoleRows(st))]), state: () => { const manned = others.filter((st) => crewAt(st)); const tied = others.filter((st) => grid.ties[`console:${st}`].length); return manned.length && manned.every((st) => grid.consoleOk[st]) ? 'Online' : tied.length ? 'Startup' : 'Cold'; },
            on: () => (busOn ? '' : 'the consoles need Bus A, B or C energized') },
        ];
        const list = gridOrder === 'shutdown' ? [...steps].reverse() : steps;
        // Startup takes antimatter aboard from the dock (to a full tank); Shutdown offloads it all.
        const tripped = new Set((grid.tripped || []).map((k) => `ties-${k.replace(':', '-')}`));
        list.forEach((step, i) => {
          const body = step.rows();
          const state = body.some((r) => tripped.has(r.id)) ? 'Tripped' : step.state();
          const why = (gridOrder === 'shutdown' ? step.off : step.on)?.() || '';
          const chip = el('span', { className: 'grid-chip', textContent: state });
          chip.dataset.state = state.toLowerCase();
          const head = header(`${i + 1}. ${step.title}`, [chip, ...(step.extra?.() || []), ...(why ? [el('small', { className: 'grid-note grid-locked-why', textContent: `Locked: ${why}` })] : [])]);
          head.dataset.step = step.title;
          rows.push(head);
          for (const r of body) {
            if (!why) continue;
            // Locked: greyed, and a tap is refused (logged) instead of acted on.
            r.classList.add('grid-locked');
            r.addEventListener('click', (ev) => { if (!ev.target.closest('input, button')) return; ev.preventDefault(); ev.stopPropagation(); const st = gp.querySelector('#grid-status'); if (st) st.textContent = `Unable to comply. ${why[0].toUpperCase()}${why.slice(1)}.`; }, true);
          }
          rows.push(...divide(body));
        });
      }
      return el('table', { className: 'grid-table', id: 'grid-table' },
        el('thead', {}, el('tr', {}, el('th', { scope: 'col', textContent: 'System' }), el('th', { scope: 'col', textContent: 'Controls' }), ...COLS.map((n) => el('th', { scope: 'col', textContent: NODE_NAMES[n] }))), storesRow(), emergRow()),
        el('tbody', {}, ...rows),
        el('tfoot', {}, el('tr', {}, el('th', { scope: 'row', textContent: 'Used / available / max' }), el('td'),
          ...COLS.map((n) => {
            // A fuel bus: what its tanks hold, of what they could.
            const fb = grid.fuel?.[Object.keys(FUEL_COL).find((b) => FUEL_COL[b] === n)];
            if (fb) return el('td', { id: `grid-total-${n}` }, `${fb.tanks.reduce((a, x) => a + x.level, 0)} / ${fb.tanks.reduce((a, x) => a + x.cap, 0)}`);
            if (n === 'ODN') { const o = Object.values(grid.odn || {}); return el('td', { id: 'grid-total-ODN' }, `${o.filter(Boolean).length} / ${o.length} linked`); }
            if (!grid.totals[n]) return el('td');
            const t = grid.totals[n];
            const td = el('td', { id: `grid-total-${n}` }, `${t.used} / ${t.available} / ${t.max}`, ...(t.condition < 100 ? [el('small', { className: 'grid-note', textContent: `damaged: ${t.condition}% condition` })] : []));
            td.toggleAttribute('data-over', t.tied > t.max || t.condition < 100);
            return td;
          }))));
    };
    // Three orders for the table: Startup and Shutdown checklists, and Operations (management).
    const orderTaps = () => el('div', { className: 'ops-form grid-orders', role: 'group', ariaLabel: 'grid order' }, ...GRID_ORDERS.map(([v, text]) => {
      const b = button(text, `grid-order-${v}`, () => { setGridOrder(v); renderCombat(); });
      b.setAttribute('aria-pressed', String(gridOrder === v));
      return b;
    }));
    // Startup done: ready for departure. Shutdown done: back to a cold ship.
    const banner = () => {
      const manned = Object.keys(grid.consoleOk).filter((st) => comms.users.some((u) => u.ship.toLowerCase() === me.ship.toLowerCase() && u.station === st));
      const ready = grid.core === 'online' && Object.values(grid.drives).every((d) => d.state === 'running') && (!grid.antimatter || grid.containmentOk)
        && Object.values(grid.taps).some((v) => v > 0) && manned.every((st) => grid.consoleOk[st]);
      const COLD_KEEP = ['impulsePort', 'impulseStarboard', 'thrustersPort', 'thrustersStarboard'];
      const cold = !['online', 'starting'].includes(grid.core) && Object.values(grid.drives).every((d) => d.state === 'off')
        && Object.values(grid.taps).every((v) => !v) && Object.entries(grid.ties).every(([k, v]) => COLD_KEEP.includes(k) || !v.length)
        && Object.values(grid.stores || {}).every((x) => !x.breaker);
      const text = gridOrder === 'startup' && ready ? 'Ready for departure' : gridOrder === 'shutdown' && cold ? 'Cold ship' : '';
      const b = el('p', { className: 'st-state grid-banner', id: 'grid-banner', textContent: text, hidden: !text });
      b.toggleAttribute('data-up', !!text);
      return b;
    };
    // What's aboard (it moves through Connections, and over the fuel buses).
    const supplies = () => el('div', { className: 'grid-supplies' },
      el('p', { className: 'st-state', id: 'supplies', textContent: `Antimatter ${grid.antimatter} / ${grid.fuelCaps.antimatter} · Deuterium ${grid.deuterium} / ${grid.fuelCaps.deuterium}` }));
    const coreText = grid.core === 'online' ? `Online · ${grid.coreOutput} to ${feeds(grid.ties.core)}` : grid.core === 'starting' ? `Cold ignition · ${grid.start} of ${grid.startSecs} s` : grid.core === 'ejected' ? 'Ejected · solar and batteries only' : 'Offline';
    gp.replaceChildren(
      el('div', { className: 'st-control' },
        el('p', { className: 'st-state', id: 'core-state', textContent: `Warp core (M/ARC): ${coreText}` }),
        // (Start and stop are on the warp core's row; eject is in Damage control;
        // replacing the core waits for the shipyard's drydock.)
        ),
      orderTaps(),
      banner(),
      table(),
      supplies(),
      el('p', { className: 'st-state grid-containment', id: 'containment-state', textContent: grid.core === 'ejected' ? 'Warp core ejected: no antimatter aboard' : !grid.antimatter ? 'No antimatter aboard: containment not needed' : grid.breach != null ? `CONTAINMENT FAILING: field ${grid.contain?.field}%, breach in ${grid.breach} s` : grid.contain?.onReserve ? `Containment on its internal reserve: ${grid.contain.reserveSecs} s left` : `Containment holding (field ${grid.contain?.field}%), fed from ${feeds(grid.ties.containment)}` }),

      el('p', { className: 'ops-notice', id: 'grid-status', textContent: status }),
      el('p', { className: 'ops-hint', textContent: `The core burns antimatter and deuterium for the power it gives (the impulse reactor burns deuterium, and while it gives power the ship is held to slow impulse). Tie each source to any of Bus A, Bus B and the EPS; the EPS reaches a bus through its open tap. The core starts on Bus A power (${grid.startSecs} s). Antimatter containment must always have power from one of its feeds, or the core breaches in seconds (ejecting the core ends that). Power goes to containment first, then consoles, then is shared among systems. EPS carrying ${grid.eps}; total drawn ${grid.drawn} (that's what other ships' sensors see).` }));
    gp.querySelector('#containment-state').toggleAttribute('data-up', grid.breach != null);
    for (const box of gp.querySelectorAll('#tank-am-main input[data-node]')) box.disabled = grid.antimatter > 0 && box.checked && grid.ties.containment.length === 1; // never none with antimatter aboard
    if (keepRes && gp.querySelector('#transfer-resource')) gp.querySelector('#transfer-resource').value = keepRes;
    if (keepAmt && gp.querySelector('#transfer-amount')) gp.querySelector('#transfer-amount').value = keepAmt;
  }

  // Engineering: damage and repair crews.
  const dc = document.querySelector('[data-damage]');
  if (dc && changed(dc, c.hull, c.damage, c.repair, own.power, own.allocated, grid.docked)) {
    const status = dc.querySelector('#damage-status')?.textContent || '';
    const row = (key, label, value, note) => el('li', { className: 'dc-row' },
      el('span', { className: 'dc-label', textContent: label }),
      el('span', { className: 'dc-value', textContent: value }),
      el('span', { className: 'dc-note', textContent: note }),
      c.repair === key ? button('Directing repairs', '', () => send({ type: 'repair', system: null }), 'dc-active')
        : button('Direct repairs', '', () => send({ type: 'repair', system: key }), (key === 'hull' ? c.hull < 100 : c.damage[key] > 0) ? 'lcars-button--alert' : ''));
    dc.replaceChildren(
      el('ul', { className: 'st-list dc-list' },
        row('hull', 'Hull', `${c.hull}%`, c.hull < 100 ? 'Damaged: at 0% the ship is destroyed' : 'Intact'),
        ...POWER.map(([k, label]) => row(k, label, c.damage[k] ? `${c.damage[k]}% damaged` : 'Operational',
          own.power[k] < own.allocated[k] ? `gets ${own.power[k]}% of ${own.allocated[k]}% set` : `${own.power[k]}%`)),
        ...(grid.core !== 'ejected' ? [el('li', { className: 'dc-row', id: 'dc-eject' },
          el('span', { className: 'dc-label', textContent: 'Warp core and antimatter pods' }),
          el('span', { className: 'dc-value', textContent: ejectArmed() ? 'EJECT ARMED' : grid.core }),
          el('span', { className: 'dc-note', textContent: ejectArmed() ? 'press again within 5 s to eject' : 'eject: press twice within 5 s' }),
          button(ejectArmed() ? 'Confirm eject' : 'Eject core', 'core-eject', () => {
            if (ejectArmed()) { ejectArmedAt = 0; send({ type: 'grid', eject: true }); return; }
            ejectArmedAt = Date.now(); dc.dataset.sig = ''; renderCombat();
            setTimeout(() => { dc.dataset.sig = ''; renderCombat(); }, 5100);
          }, 'lcars-button--alert'))] : []),
        row('conduits', 'Warp core power transfer conduits', c.damage.conduits ? `${c.damage.conduits}% damaged` : 'Operational', c.damage.conduits >= 50 ? 'FAILED: no core output' : ''),
        // Subsystems fail outright when badly damaged (50% or more).
        // The buses: a damaged bus carries less (its max scales with its condition).
        ...['A', 'B', 'C', 'EPS'].map((X) => row(`bus${X}`, X === 'EPS' ? 'EPS grid' : `Bus ${X}`, c.damage[`bus${X}`] ? `${c.damage[`bus${X}`]}% damaged` : 'Operational',
          `carries ${grid.totals[X].max} of ${grid.totals[X].fullMax}`)),
        ...Object.entries(grid.subsystems).filter(([x]) => x in c.damage).map(([x, v]) => row(x, `${v.parent === 'Communications' ? '' : v.parent === 'core' ? 'Warp core ' : v.parent === 'impulsePort' ? 'Port drive ' : 'Starboard drive '}${v.name}`,
          c.damage[x] ? `${c.damage[x]}% damaged` : 'Operational', c.damage[x] >= 50 ? 'FAILED: repair below 50%' : ''))),
      el('p', { className: 'ops-notice', id: 'damage-status', textContent: status }),
      el('p', { className: 'ops-hint', textContent: `Damage caps what a system can draw. Repair crews fix everything slowly; directed to one system (or the hull) they fix it six to ten times faster.${grid.docked ? ` Docked at ${grid.docked}: repairs go four times faster.` : ''}` }));
    for (const li of dc.querySelectorAll('.dc-row')) li.dataset.system = li.querySelector('.dc-label').textContent;
  }

  // Captain: the ship's real status, and the self-destruct.
  const ss = document.querySelector('[data-ship-status]');
  if (ss) {
    const up = !!ownShip()?.shields;
    const damaged = POWER.filter(([k]) => c.damage[k] > 0).map(([k]) => NAMES[k].toLowerCase());
    const speed = grid.towedBy ? `Towed by the ${grid.towedBy}` : own.warp <= 0 ? (grid.docked ? `Docked at ${grid.docked}` : grid.dockedShip ? `Docked with the ${grid.dockedShip}` : 'All stop') : `${own.warp < 1 ? 'Impulse' : `Warp ${+own.warp.toFixed(1)}`}${grid.towing ? `, towing the ${grid.towing}` : ''}`;
    const items = [
      ['Alert status', own.alert && own.alert !== 'green' ? `${own.alert[0].toUpperCase()}${own.alert.slice(1)} alert` : 'Condition green', 'sky'],
      ['Shields', up ? `Up · ${c.shield}%` : c.shield < 100 ? `Down (generators ${c.shield}%)` : 'Down', 'sky'],
      ['Hull integrity', `${c.hull}%`, 'gold'],
      ['Velocity', speed, 'orange'],
      ['Weapons', c.lock ? `Locked: the ${c.lock.name}` : c.phaser.armed ? 'Phasers armed' : 'Standby', 'red'],
      ['Warp core', { online: 'Online', starting: 'Starting', offline: 'Offline', ejected: 'Ejected' }[grid.core], 'blue'],
      ['Antimatter · deuterium', `${Math.round((grid.antimatter / grid.fuelCaps.antimatter) * 100)}% · ${Math.round((grid.deuterium / grid.fuelCaps.deuterium) * 100)}%`, 'violet'],
      ['Damage', damaged.length ? damaged.join(', ') : 'None', 'peach'],
    ];
    if (changed(ss, items, grid.selfDestruct)) {
      const sd = grid.selfDestruct;
      ss.replaceChildren(
        el('div', { className: 'ops-readouts' }, ...items.map(([label, value, color]) => {
          const r = el('div', { className: 'lcars-readout' }, el('span', { className: 'lcars-readout__label', textContent: label }), el('span', { className: 'lcars-readout__value', textContent: value }));
          r.style.setProperty('--accent', `var(--lcars-${color})`);
          r.dataset.readout = label;
          return r;
        })),
        el('div', { className: 'ops-form' },
          sd ? el('span', { className: 'st-state', id: 'self-destruct-state', textContent: `Self-destruct in ${sd.seconds} s` }) : el('span', { textContent: 'Self-destruct' }),
          sd ? button('Abort self-destruct', 'self-destruct-abort', () => send({ type: 'self-destruct', on: false }))
            : button('Self-destruct', 'self-destruct', () => { if (confirm(`Destroy the ${me.ship}? Everyone aboard is warned, and you can abort until the countdown ends.`)) send({ type: 'self-destruct', on: true }); }, 'lcars-button--alert')));
    }
  }
}

// Crew services (Crew consoles): replicators and recreation, as powered.
function renderServices() {
  const box = document.querySelector('[data-services]');
  const p = ownPower();
  if (!box || !p) return;
  const state = [
    ['Alert status', lastNav.own.alert && lastNav.own.alert !== 'green' ? `${lastNav.own.alert[0].toUpperCase()}${lastNav.own.alert.slice(1)} alert` : 'Condition green', 'sky'],
    ['Replicators', p.replicators <= 0 ? 'Offline' : p.replicators < 20 ? `Rationed (${p.replicators}%)` : `Online (${p.replicators}%)`, 'orange'],
    ['Recreation · holodecks', p.recreation <= 0 ? 'Closed' : `Open (${p.recreation}%)`, 'gold'],
  ];
  const sig = JSON.stringify(state);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.replaceChildren(...state.map(([label, value, color]) => {
    const r = document.createElement('div');
    r.className = 'lcars-readout';
    r.dataset.readout = label;
    r.style.setProperty('--accent', `var(--lcars-${color})`);
    r.append(Object.assign(document.createElement('span'), { className: 'lcars-readout__label', textContent: label }), Object.assign(document.createElement('span'), { className: 'lcars-readout__value', textContent: value }));
    return r;
  }));
}

// The lock Tactical has picked (fire, aim).
let wpFocus = null;
// Phaser charge and torpedo reload, between updates.
function updateWeaponTimers() {
  const wp = document.querySelector('[data-weapons]');
  const c = lastNav?.own?.combat;
  if (!wp?.firstChild || !c) return;
  const tp = Math.max(0, c.torpedo.ready - (Date.now() - combatAt));
  const set = (id, label, value) => wp.querySelector(id).replaceChildren(
    Object.assign(document.createElement('span'), { className: 'lcars-readout__label', textContent: label }),
    Object.assign(document.createElement('span'), { className: 'lcars-readout__value', textContent: value }));
  const arrays = c.phaser.arrays || [c.phaser.charge];
  set('#wp-phasers', arrays.length > 1 ? `Phaser arrays (${arrays.length})` : 'Phaser array', !c.phaser.armed ? 'Not armed' : arrays.length > 1 ? arrays.map((x) => (x >= 100 ? 'ready' : `${x}%`)).join(' · ') : c.phaser.charge >= 100 ? 'Charged · ready' : `Charging ${c.phaser.charge}%`);
  set('#wp-torpedoes', 'Photon torpedoes', `${c.torpedoes} of ${c.carried}${tp ? ' · reloading' : ''}`);
  const f = (c.locks || []).find((x) => x.name === wpFocus);
  const base = f && (lastNav?.bases || []).some((b) => b.name === f.name); // (the weapons won't fire on a starbase)
  wp.querySelector('#fire-phaser').disabled = !f || base || !c.phaser.armed || c.phaser.charge < 100 || f.distance > c.phaser.range;
  wp.querySelector('#fire-torpedo').disabled = !f || base || tp > 0 || !c.torpedoes || f.distance > c.torpedo.range;
}
setInterval(updateWeaponTimers, 250);

// A light bar: ten LCARS buttons for a level from 0 to max. Pressing button
// N sets N tenths of max (buttons up to N light up); pressing the top lit
// button again turns it off (0).
// As a limiter (power): `segments` past ten run into overdrive (orange), and
// set(limit, used) shows what's drawn fully lit, the rest of the allowance dim.
function lightBar(label, max, onset, { segments = 10, rated = max } = {}) {
  const bar = document.createElement('div');
  bar.className = 'light-bar';
  bar.style.gridTemplateColumns = `repeat(${segments}, minmax(0, 1fr))`;
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', label);
  let value = 0;
  const step = max / segments;
  for (let n = 1; n <= segments; n++) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'light-bar__seg', title: `${n * step}` });
    b.dataset.level = n;
    if (n * step > rated) b.dataset.overdrive = '';
    b.setAttribute('aria-label', `${label}: ${n * step}`);
    b.onclick = () => onset(Math.round(value) === n * step ? 0 : n * step);
    bar.append(b);
  }
  bar.set = (v, used = v) => {
    value = v;
    for (const b of bar.children) {
      const top = Number(b.dataset.level) * step;
      const allowed = top <= v + 1e-9;
      b.toggleAttribute('data-lit', allowed && top - step < used - 1e-9); // in use
      b.toggleAttribute('data-allowed', allowed); // allowed (dim when not drawn)
      b.setAttribute('aria-pressed', String(allowed));
    }
  };
  return bar;
}

// Engineering: route the reactor's output. Sliders per system (0-100%), the
// total against the reactor, and what the settings mean for the ship.
let powerDraft = null; // Engineering's unsent changes
const ownAllocation = () => lastNav?.own?.allocated || ownPower();
function renderPower() {
  const root = document.querySelector('[data-power]');
  const p = ownAllocation();
  if (!root || !p) return;
  const draft = powerDraft || { ...p };
  const total = POWER.reduce((n, [k]) => n + draft[k], 0);
  const f = Math.max(draft.sensors, draft.lateral / 4) / 100;
  const warp = draft.engines <= 0 ? 0 : Math.max(0.25, Math.round((draft.engines / 100) * 90) / 10);
  if (!root.firstChild) {
    root.append(
      ...POWER.map(([k, label]) => {
        const row = document.createElement('div');
        row.className = 'pw-row';
        row.append(Object.assign(document.createElement('span'), { className: 'pw-label', textContent: label }),
          lightBar(`${label} power`, 150, (v) => { powerDraft = { ...(powerDraft || ownAllocation()), [k]: v }; renderPower(); }, { segments: 15, rated: 100 }),
          Object.assign(document.createElement('b'), { className: 'pw-value' }));
        row.querySelector('.light-bar').dataset.system = k;
        return row;
      }),
      Object.assign(document.createElement('p'), { className: 'pw-total' }),
      Object.assign(document.createElement('ul'), { className: 'pw-effects' }),
      Object.assign(document.createElement('div'), { className: 'ops-form pw-actions' }));
    const apply = Object.assign(document.createElement('button'), { type: 'button', className: 'lcars-button lcars-button--pill', id: 'power-apply', textContent: 'Route power' });
    const reset = Object.assign(document.createElement('button'), { type: 'button', className: 'lcars-button lcars-button--pill lcars-button--alert', id: 'power-reset', textContent: 'Undo' });
    apply.onclick = () => { if (powerDraft) send({ type: 'power', power: powerDraft }); powerDraft = null; };
    reset.onclick = () => { powerDraft = null; renderPower(); };
    root.querySelector('.pw-actions').append(apply, reset);
  }
  for (const [k] of POWER) {
    const bar = root.querySelector(`[data-system="${k}"]`);
    const used = ownPower()?.[k] ?? 0;
    bar.set(draft[k], Math.min(used, draft[k]));
    bar.parentElement.querySelector('.pw-value').textContent = `${used}/${draft[k]}%`;
    bar.parentElement.toggleAttribute('data-overdrive', draft[k] > 100);
  }
  // The light bars set each system's demand; the grid (Power grid screen) decides what it gets.
  const grid = lastNav.own.grid;
  // Each system's demand shown on the first bus (or the EPS) it's tied to.
  const busDemand = (X) => POWER.filter(([k]) => grid?.ties[`system:${k}`]?.[0] === X).reduce((n, [k]) => n + (k === 'weapons' && !lastNav.own.combat?.phaser.armed ? 0 : Math.round((draft[k] * (grid.ratings?.[k] ?? 100)) / 100)), 0);
  const short = grid ? POWER.filter(([k]) => grid.delivered[k] < grid.demand[k]).map(([, label]) => label.toLowerCase()) : [];
  const over = false;
  root.querySelector('.pw-total').textContent = grid
    ? `Systems demand: Bus A ${busDemand('A')} · Bus B ${busDemand('B')} · Bus C ${busDemand('C')} · EPS ${busDemand('EPS')} (weapons draw only when armed)${short.length ? ` · short of power: ${short.join(', ')}` : ''}${powerDraft ? ' · not routed yet' : ''}`
    : `Demand ${total}%${powerDraft ? ' · not routed yet' : ''}`;
  root.querySelector('.pw-total').toggleAttribute('data-over', short.length > 0);
  root.querySelector('.pw-effects').replaceChildren(...[
    `Top speed: ${warp <= 0 ? 'none (no engine power)' : warp < 1 ? 'impulse' : `warp ${warp}`}`,
    `Sensors ${Math.round(600 * f)} · subspace ${Math.round(400 * f)} · transporter ${Math.round((20 * draft.lateral) / 100)} units`,
    draft.shields < 20 ? 'Shields: too little power to hold them' : 'Shields: can be raised',
    draft.transporter <= 0 ? 'Transporter: no power' : 'Transporter: ready',
    Math.min(draft.atmosphere, draft.thermal) < 50 ? `Life support: ${Math.min(draft.atmosphere, draft.thermal)}%, crew warned` : 'Life support: nominal',
    draft.gravity < 50 ? `Gravity: ${draft.gravity}%` : 'Gravity: nominal',
    draft.replicators <= 0 ? 'Replicators: offline' : draft.replicators < 20 ? 'Replicators: rationed' : 'Replicators: online',
    draft.recreation <= 0 ? 'Recreation and holodecks: closed' : 'Recreation and holodecks: open',
    // The more power the ship uses, the further off other ships' sensors see it.
    `Power signature now ${Math.round(lastNav.own.signature * 100)}%: seen from ${Math.round(600 * lastNav.own.signature)} units by full sensors${lastNav.own.signature < 0.6 ? ' (running quiet)' : ''}`,
    ...(Object.values(lastNav.own.combat?.damage || {}).some((d) => d > 0) ? ['Damaged systems get less than routed: see Damage control'] : []),
  ].map((t) => Object.assign(document.createElement('li'), { textContent: t })));
  root.querySelector('#power-apply').disabled = !powerDraft || over;
  root.querySelector('#power-reset').disabled = !powerDraft;
}

// Ops screens instead of station displays.
function showOps() {
  stationView = null;
  navPanel = null;
  $('station-view').replaceChildren();
  $('sections').replaceChildren();
  setHeader('OPS', `${me.name} · ${me.ship}`, 'Operations');
  document.querySelector('.lcars-header').style.removeProperty('--elbow');
  for (const t of document.querySelectorAll('.ops-tab')) t.hidden = false;
  $('reassign-tab').hidden = false;
  $('ops-view').hidden = false;
  $('ops-log').replaceChildren();
  ops = createOps({ send, comms, me: () => me });
  fillReassign();
  quietScreen = screenHistory.key === historyKey();
  showScreen('status');
  quietScreen = false;
  restoreScreen();
}

// Leaving the ops station for another one.
function hideOps() {
  ops = null;
  $('ops-view').hidden = true;
  $('transfer-form').hidden = true;
  for (const t of document.querySelectorAll('.ops-tab')) t.hidden = true;
}

async function onMessage(msg) {
  if (msg.type === 'users') queueMicrotask(() => ops?.render()); // transfer targets
  if (ops?.handle(msg)) return;
  if (await bc.handle(msg)) return;
  if (await room.handle(msg)) return;
  if (msg.type === 'notice' && /^(Helm|Sensors|Science|Course plotted|No ship's computer is flying)/.test(msg.text)) navPanel?.status(msg.text);
  // Engineering's event log (on the master systems display), coloured by what happened.
  if (msg.type === 'notice' && /^Engineering/.test(msg.text)) {
    engEvents.push({ at: Date.now(), text: msg.text.replace(/^Engineering(\s*\([^)]*\))?:\s*/, ''), cls: /fail|crash|breach|collapse|shut down|flameout|lost|tripped|damaged|no power/i.test(msg.text) ? 'bad' : /online|running|passed|energized|restored|averted|pressurized/i.test(msg.text) ? 'ok' : 'info' });
    engEvents.splice(0, Math.max(0, engEvents.length - 100));
    renderMSD();
  }
  if (msg.type === 'notice' && /^(Engineering|Tactical)/.test(msg.text)) {
    const st = document.getElementById(msg.text.startsWith('Tactical') ? 'weapons-status' : /^Engineering: (warp core|EPS|batteries|solar|dock|antimatter|not enough)/.test(msg.text) ? 'grid-status' : 'damage-status');
    if (st) st.textContent = msg.text;
  }
  if (msg.type === 'notice' && msg.text.startsWith('Transporter:')) {
    const st = document.getElementById('beam-status');
    if (st) st.textContent = msg.text;
  }
  if (msg.type === 'users') {
    stationView?.setCrew(msg.users);
    queueMicrotask(renderCrewPanels);
    queueMicrotask(renderShipState); // transporter crew list
    setLink(msg.ops ? 'online' : 'error', msg.ops ? `${relayName} · ops on duty` : `${relayName} · ops offline`);
  }
  if (await comms.handle(msg)) return;
  switch (msg.type) {
    case 'profile':
      if (me) me.title = msg.title;
      if (msg.profile) setProfile(msg.profile, false);
      if (stationView) setHeader(stationView.code, `${me.title || me.name} · ${me.ship}`, me.station);
      break;
    case 'registered':
      me = { id: msg.id, name: msg.name, ship: msg.ship, station: msg.station, console: msg.console || null, title: msg.title };
      applyPlaces();
      if (msg.profile) setProfile(msg.profile, false);
      token = msg.token;
      if (ops) hideOps();
      queueMicrotask(() => comms.radio?.render());
      if (msg.beamedFrom) log(`beamed from the ${msg.beamedFrom} to the ${me.ship}`);
      if (msg.walkedFrom) log(`crossed the dock from the ${msg.walkedFrom} to the ${me.ship}`);
      document.title = `LCARS: ${me.console ? `${me.console} · ` : ''}${me.station} · ${me.ship}`;
      $('home').hidden = false;
      $('comms-button').hidden = false;
      $('room-mic').hidden = false;
      $('log-tab').hidden = false;
      $('reassign-tab').hidden = false;
      $('library-tab').hidden = false;
      log(msg.beamedFrom || msg.walkedFrom ? `${me.name} now aboard the ${me.ship}: ${me.station}` : `${me.name} reporting for duty aboard the ${me.ship}: ${me.station}`);
      showStation();
      try { localStorage.setItem('voice-reg', JSON.stringify({ name: me.name, ship: me.ship, station: myPlace() })); } catch {}
      break;
    case 'register-failed':
      $('register-error').textContent = msg.reason;
      $('register-form').querySelector('button').disabled = false;
      break;
    case 'operator-ok':
      me = { id: msg.id, name: msg.name, ship: msg.ship, station: msg.station };
      token = msg.token;
      document.title = `LCARS: Ops · ${me.ship}`;
      renderConsoleBar();
      $('home').hidden = false;
      $('comms-button').hidden = false;
      $('room-mic').hidden = false;
      $('log-tab').hidden = false;
      $('library-tab').hidden = false;
      log(`${me.name} took the ops station aboard the ${me.ship}`);
      showOps();
      comms.radio?.render();
      try {
        localStorage.setItem('voice-reg', JSON.stringify({ name: me.name, ship: me.ship, station: 'Operations' }));
      } catch {}
      break;
    case 'operator-failed':
      $('register-error').textContent = `Access denied: ${msg.reason}`;
      $('register-form').querySelector('button').disabled = false;
      break;
    case 'station-failed':
      $('reassign-error').textContent = `Access denied: ${msg.reason}`;
      break;
    case 'comm-links':
      commLinks = msg;
      renderCommLinks();
      break;
    case 'op-ok':
    case 'op-error': {
      // Ops answers, for Communications running data links.
      const st = document.getElementById('links-status');
      if (st) st.textContent = msg.type === 'op-ok' ? msg.text : `Unable to comply: ${msg.reason}`;
      log(msg.type === 'op-ok' ? msg.text : `unable to comply: ${msg.reason}`, msg.type === 'op-error' ? 'warn' : undefined);
      break;
    }
    case 'traffic':
      traffic = msg.calls;
      renderTraffic();
      break;
    case 'admin-status':
      renderAdmin(msg);
      break;
    case 'admin-created': {
      const st = document.getElementById('create-status');
      if (st) st.textContent = msg.text;
      if (msg.ok) { Object.assign(createDraft, { name: '', cls: null, at: null, x: null, y: null }); const n = document.getElementById('create-name'); if (n) n.value = ''; const box = document.getElementById('admin-create'); if (box) renderCreate(box, true); }
      break;
    }
    case 'nav':
      lastNav = msg;
      // An automated panel at this station: a bar says so (a tap here by hand takes it back).
      { const all = Object.entries(msg.own?.automation || {}).filter(([, a]) => a.station === me?.station);
        // (The holographic doctor has its own bar: it works alongside Medical, it doesn't take the console.)
        const emh = all.find(([p]) => p === 'medical')?.[1], mine = all.filter(([p]) => p !== 'medical').map(([, a]) => a);
        bc.setAlert('emh', emh ? `EMH active: ${emh.status || 'running'}` : null, { level: 'yellow' });
        bc.setAlert('automation', mine.length ? `Automation (Ops): ${mine.map((a) => `${a.name}${typeof a.mode === 'string' ? ` ${a.mode}` : ''}: ${a.status || 'running'}`).join(' · ')}. A tap here by hand takes it over.` : null, { level: 'yellow' }); }
      // The brig's force field changes which stations can be walked to.
      if (!!msg.own?.grid?.brigSealed !== !!window.__brigSealed) { window.__brigSealed = !!msg.own?.grid?.brigSealed; fillReassign(); }
      renderBrig(msg.own?.grid);
      // Department readiness (Captain, First Officer): redraw when the answers change.
      if (JSON.stringify(msg.own?.readiness) !== JSON.stringify(window.__readiness)) { window.__readiness = msg.own?.readiness; stationView?.setCrew?.(comms.users); }
      // The Communications console's subspace bands follow the subspace relay.
      { const g = msg.own?.grid; window.__subspace = g ? { up: g.subOk?.subspace !== false, why: g.ties?.['sub:subspace']?.length ? 'no power to the relay, or it is damaged' : 'the relay is untied (Engineering)' } : null; }
      renderMSD();
      comms.setTextBlocked(msg.own?.grid?.computers && !msg.own.grid.computers.some((x) => x.state === 'online') ? 'Computer core offline: no text messages' : '');
      navPanel?.update(msg);
      stationView?.setNav(msg.own);
      renderShipState();
      renderPower();
      renderCrewPanels();
      renderCombat();
      renderServices();
      if (JSON.stringify(msg.own?.grid?.dockedWith || []) !== dockSig && !msg.remote?.controlling) fillReassign();
      renderVesselBar(msg.remote);
      break;
    case 'course-plotted':
      log(`${msg.by.name} plotted a course to ${msg.label}`);
      navPanel?.plotted(msg);
      break;
    case 'scan-result':
      navPanel?.scanned(msg);
      break;
    case 'sci-lock':
      navPanel?.sciLocked(msg.ship);
      break;
    case 'order-status': {
      // Orders we gave: who has acknowledged, who hasn't yet.
      sentOrders.set(msg.id, msg);
      renderCrewPanels();
      break;
    }
    case 'order':
      log(`Captain's orders (${msg.from.title || msg.from.name}): ${msg.text}`);
      bc.addOrder(msg.from, msg.text, msg.id, msg.reassign, msg.readiness);
      break;
    case 'override':
      // Someone on another vessel has taken over our station with our command prefix.
      bc.setAlert('override', msg.by ? `Remote override by the ${msg.by} (${msg.station})` : null, { level: 'yellow' });
      if (msg.by) log(`Remote override by the ${msg.by}: they are running ${msg.station}`, 'warn');
      break;
    case 'destroyed':
      log(`The ${msg.ship} was destroyed (${msg.cause}). Rebuilt and docked at ${msg.base}.`, 'warn');
      bc.setAlert(`destroyed-${msg.at}`, `The ${msg.ship} was destroyed: ${msg.cause}. Rebuilt and docked at ${msg.base}`, { dismiss: true });
      break;
    case 'security-alert':
      securityAlerts.push(`${new Date(msg.at).toLocaleTimeString()} ${msg.text}`);
      bc.setAlert(`intruder-${msg.at}`, `Security: ${msg.text}`, { dismiss: true });
      renderCrewPanels();
      break;
    case 'hello': {
      opsKeyRequired = msg.opsKey !== false; // older relays don't say: show it
      // The star chart, and the designs (each class's places and bridge seats).
      window.STAR_SYSTEM = msg.system || null;
      window.DESIGNS = msg.designs || {};
      applyPlaces();
      updateSignInMode();
      if (msg.relay) {
        relayName = msg.relay;
        setLink('online', `${relayName} online`);
        if (!me) setHeader('LCARS', relayName, 'Report aboard');
      }
      // Offer only the stations this relay accepts. If it lacks some this page
      // knows, the relay is older than the pages and needs a restart.
      stations = STATION_NAMES.filter((n) => msg.stations.includes(n));
      const missing = STATION_NAMES.filter((n) => !msg.stations.includes(n));
      fillStations();
      if (missing.length) {
        const note = `This comm relay is out of date (no ${missing.join(', ')} station). Restart it to update.`;
        $('register-error').textContent = note;
        log(note, 'warn');
      }
      break;
    }
    case 'ships':
      ships = msg.ships;
      applyPlaces();
      renderShips(msg.ships);
      if (!me) fillStations(); // (the stations follow the ship picked)
      renderShipState();
      tryRejoin();
      break;
    case 'reload':
      prepareReload(msg.restart);
      break;
    case 'library':
      library.render(msg);
      break;
  }
}

// Same display "stardate" as the LCARS base shell: year offset plus fraction of the year.
function tick() {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), 0, 1);
  const end = Date.UTC(now.getUTCFullYear() + 1, 0, 1);
  $('stardate').textContent = `Stardate ${((now.getUTCFullYear() - 1946) * 1000 + ((now - start) / (end - start)) * 1000).toFixed(1)}`;
}
tick();
setInterval(tick, 1000);

// Station picker, then pre-fill the last registration on this browser
// (the ship once the list arrives).
// Also from the URL: ?station=Operations&name=O'Brien&ship=Enterprise
const urlParams = new URLSearchParams(location.search);
let savedReg = null;
try { savedReg = JSON.parse(localStorage.getItem('voice-reg') || 'null'); } catch {}
$('name').value = urlParams.get('name') || savedReg?.name || '';
$('station').onchange = updateSignInMode;

function fillStations() {
  const sel = $('station');
  const keep = sel.value || urlParams.get('station') || savedReg?.station || '';
  const placeholder = new Option('Station', '');
  placeholder.disabled = true;
  const all = ['Operations', ...stations];
  // A ship's class sets its stations (a runabout's cockpit, a shuttle's Helm): the others are greyed.
  const pick = (typeof ships !== 'undefined' ? ships : []).find((x) => x.name.toLowerCase() === ($('ship')?.value || '').toLowerCase());
  const aboard = (n) => n === 'Operations' || !pick?.stations || pick.stations.includes(n);
  sel.replaceChildren(placeholder, ...byPlace(all).map((g) => Object.assign(document.createElement('optgroup'), { label: g.label })).map((og, i) => {
    og.append(...byPlace(all)[i].items.map((n) => Object.assign(new Option(aboard(n) ? n : `${n} (not aboard a ${pick.class})`, n), { disabled: !aboard(n) })));
    return og;
  }));
  sel.value = all.includes(keep) && aboard(keep) ? keep : '';
  updateSignInMode();
  fillReassign();
}
fillStations();
$('ship')?.addEventListener('change', () => { applyPlaces(); fillStations(); });

$('register-form').onsubmit = (e) => {
  e.preventDefault();
  if (ws?.readyState !== WebSocket.OPEN) return;
  $('register-error').textContent = '';
  $('register-form').querySelector('button').disabled = true;
  if (opsSelected()) send({ type: 'operator', name: $('name').value.trim(), ship: $('ship').value, key: $('key').value, ...profile });
  else send({ type: 'register', name: $('name').value.trim(), ship: $('ship').value, station: $('station').value, ...profile });
};
$('reassign-form').onsubmit = (e) => {
  e.preventDefault();
  $('reassign-error').textContent = '';
  const ship = $('reassign-form').dataset.ship;
  send({ type: 'change-station', station: 'Operations', key: $('reassign-key').value, ...(ship ? { ship } : {}) });
};

// Comm relay: shown on the sign-in screen; changing it reconnects.
$('relay').value = relay.address();
$('relay-form').onsubmit = (e) => {
  e.preventDefault();
  if (!relay.set($('relay').value)) { $('register-error').textContent = 'That relay address is not valid'; return; }
  $('relay').value = relay.address();
  if (ws && ws.readyState <= WebSocket.OPEN) ws.close(); else connect();
};

renderShips([]);
showScreen('register');
connect();

// Exposed for the headless test.
window.__comms = comms;
window.__send = (m) => send(m); // (for tests: a command as the console would send it)
window.__broadcast = bc;
window.__nav = { get last() { return lastNav; } };
window.__operator = new Proxy({}, { get: (_, k) => ops?.[k] });
window.__voice = Object.create(comms.voice, {
  myName: { get: () => me?.name },
  me: { get: () => me },
  token: { get: () => token },
});
