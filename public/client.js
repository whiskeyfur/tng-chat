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
let ships = [];     // [{ name, ops, shields }]
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
  button: $('comms-button'),
  extras: $('transfer-form'), // ops only: hand off the call you're in
  onChange: () => ops?.render(),
});
const library = createLibrary($('library-view'), { token: () => token, base: relay.http, log, canDelete: (s) => s.own && !!ops });

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
  ws.onopen = () => setLink('online', 'Comm relay online');
  // Handle messages one at a time so ICE candidates never race ahead of the SDP.
  let queue = Promise.resolve();
  ws.onmessage = (ev) => { queue = queue.then(() => onMessage(JSON.parse(ev.data))).catch((err) => log(`error: ${err}`, 'error')); };
  ws.onclose = () => {
    log('signaling disconnected', 'error');
    signedOut('Lost the link to the comm relay. Reconnecting...');
    setLink('error', `Comm relay unreachable: ${relay.address()}`);
    renderShips([]);
    setTimeout(connect, 3000);
  };
}

// Back to the sign-in form when the link to the server drops.
function signedOut(reason) {
  comms.reset(reason);
  me = null;
  token = null;
  stationView = null;
  ops = null;
  $('ops-view').hidden = true;
  $('transfer-form').hidden = true;
  for (const t of document.querySelectorAll('.ops-tab')) t.hidden = true;
  $('home').hidden = true;
  $('comms-button').hidden = true;
  $('log-tab').hidden = true;
  $('reassign-tab').hidden = true;
  $('library-tab').hidden = true;
  $('sections').replaceChildren();
  showScreen('register');
  $('station-view').replaceChildren();
  $('register-error').textContent = reason;
  $('register-form').querySelector('button').disabled = false;
  setHeader('LCARS', 'Personnel access', 'Report aboard');
  document.title = 'LCARS: Report aboard';
}

function setHeader(code, sub, title) {
  $('station-code').textContent = code;
  $('station-sub').textContent = sub;
  $('station-title').textContent = title;
}

// Ships come from their ops stations: [{ name, ops }]. A ship whose ops
// dropped out is still listed while crew are aboard, marked "ops offline".
function renderShips(ships) {
  const sel = $('ship');
  const keep = sel.value || savedReg?.ship || '';
  const placeholder = new Option(ships.length ? 'Ship' : 'No ships with ops on duty', '');
  placeholder.disabled = true;
  sel.replaceChildren(placeholder, ...ships.map((s) => new Option(s.ops ? s.name : `${s.name} (ops offline)`, s.name)));
  const match = ships.find((s) => s.name.toLowerCase() === keep.toLowerCase());
  sel.value = match?.name || '';
  updateSignInMode();
}

// Operations takes the ship's ops station: any ship name (a new one creates
// the ship), plus the authorization code if the relay asks for one.
const opsSelected = () => $('station').value === 'Operations';
function updateSignInMode() {
  const isOps = opsSelected();
  $('ship').hidden = isOps;
  $('ops-ship').hidden = !isOps;
  $('key').hidden = !isOps;
  $('register-form').querySelector('button').disabled = !isOps && $('ship').options.length <= 1;
  $('register-form').querySelector('button').textContent = isOps ? 'Take ops station' : 'Report aboard';
}

// Station displays, and a sidebar tab for each one.
function showStation() {
  stationView = renderStation($('station-view'), me.station, { ship: me.ship });
  setHeader(stationView.code, `${me.name} · ${me.ship}`, me.station);
  document.querySelector('.lcars-elbow--top').style.setProperty('--elbow', `var(--lcars-${stationView.color})`);
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
  renderShipState();
  fillReassign();
  renderTraffic();
  showScreen(stationView.sections[0].id);
}

// The Station screen: any other station, Operations included.
function fillReassign() {
  $('assignment').textContent = `${me.name}: ${me.station}, the ${me.ship}`;
  $('new-station').replaceChildren(...['Operations', ...stations].filter((n) => n !== me.station).map((n) => new Option(n, n)));
  $('reassign-error').textContent = '';
  $('reassign-key').value = '';
  $('reassign-key').hidden = $('new-station').value !== 'Operations';
}

// Communications: every call in progress on our data network, who's in it
// and for how long. Metadata only; nobody listens in.
function renderTraffic() {
  const box = document.querySelector('[data-traffic]');
  if (!box) return;
  const ul = document.createElement('ul');
  ul.className = 'traffic';
  const fmt = (ms) => { const t = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  for (const c of traffic) {
    const li = document.createElement('li');
    li.append(
      Object.assign(document.createElement('span'), { className: `traffic-state${c.state === 'in-call' ? '' : ' traffic-state--ringing'}`, textContent: c.state === 'in-call' ? 'Open' : 'Ringing' }),
      Object.assign(document.createElement('span'), { className: 'traffic-who', textContent: c.members.map((m) => comms.voice.label(m)).join('  ⟷  ') }),
      Object.assign(document.createElement('span'), { className: 'traffic-time', textContent: fmt(Date.now() - c.since) }));
    ul.append(li);
  }
  if (!traffic.length) ul.append(Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No comm traffic' }));
  box.replaceChildren(ul);
}
setInterval(renderTraffic, 1000);

const ownShip = () => ships.find((s) => me && s.name.toLowerCase() === me.ship.toLowerCase());

// Shields (footer, displays, Tactical's control) and the transporter controls.
function renderShipState() {
  if (!me || !stationView) return;
  const up = !!ownShip()?.shields;
  stationView.setShields(up);
  document.body.toggleAttribute('data-shields-up', up);

  const shieldCtl = document.querySelector('[data-shield-control]');
  if (shieldCtl) {
    const btn = Object.assign(document.createElement('button'), {
      type: 'button',
      className: `lcars-button lcars-button--pill${up ? '' : ' lcars-button--alert'}`,
      textContent: up ? 'Lower shields' : 'Raise shields',
      onclick: () => send({ type: 'shields', up: !up }),
    });
    const state = Object.assign(document.createElement('p'), { className: 'st-state', textContent: up ? 'Shields up · transporters blocked' : 'Shields down' });
    state.toggleAttribute('data-up', up);
    const box = Object.assign(document.createElement('div'), { className: 'st-control' });
    box.append(state, btn);
    shieldCtl.replaceChildren(box);
  }

  const tr = document.querySelector('[data-transporter]');
  if (tr) {
    const keep = { who: tr.querySelector('#beam-who')?.value, ship: tr.querySelector('#beam-ship')?.value };
    const crew = comms.users.filter((u) => u.ship.toLowerCase() === me.ship.toLowerCase() && u.station !== 'Operations');
    const targets = ships.filter((s) => s.name.toLowerCase() !== me.ship.toLowerCase());
    const who = Object.assign(document.createElement('select'), { className: 'ops-select', id: 'beam-who', ariaLabel: 'who to beam' });
    who.append(...crew.map((u) => new Option(u.id === me.id ? `${u.name} (you)` : `${u.name} · ${u.station}`, u.id)));
    const dest = Object.assign(document.createElement('select'), { className: 'ops-select', id: 'beam-ship', ariaLabel: 'destination ship' });
    dest.append(...targets.map((s) => new Option(s.shields ? `${s.name} (shields up)` : s.name, s.name)));
    if (keep.who && crew.some((u) => u.id === keep.who)) who.value = keep.who;
    if (keep.ship && targets.some((s) => s.name === keep.ship)) dest.value = keep.ship;
    const blocked = up ? `Shields are up aboard the ${me.ship}` : '';
    const energize = Object.assign(document.createElement('button'), {
      type: 'button', className: 'lcars-button lcars-button--pill', id: 'beam-go', textContent: 'Energize',
      disabled: !crew.length || !targets.length,
      onclick: () => { stationView.energize(); send({ type: 'beam', who: who.value, ship: dest.value }); },
    });
    const form = Object.assign(document.createElement('div'), { className: 'ops-form' });
    form.append(Object.assign(document.createElement('span'), { textContent: 'Beam' }), who,
      Object.assign(document.createElement('span'), { textContent: 'to the' }), dest, energize);
    const status = Object.assign(document.createElement('p'), { className: 'ops-notice', id: 'beam-status', textContent: blocked || tr.querySelector('#beam-status')?.textContent || '' });
    tr.replaceChildren(form, status);
  }
}

// Ops screens instead of station displays.
function showOps() {
  stationView = null;
  $('station-view').replaceChildren();
  $('sections').replaceChildren();
  setHeader('OPS', `${me.name} · ${me.ship}`, 'Operations');
  document.querySelector('.lcars-elbow--top').style.removeProperty('--elbow');
  for (const t of document.querySelectorAll('.ops-tab')) t.hidden = false;
  $('reassign-tab').hidden = false;
  $('ops-view').hidden = false;
  $('ops-log').replaceChildren();
  ops = createOps({ send, comms, me: () => me });
  fillReassign();
  showScreen('status');
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
  if (msg.type === 'notice' && msg.text.startsWith('Transporter:')) {
    const st = document.getElementById('beam-status');
    if (st) st.textContent = msg.text;
  }
  if (msg.type === 'users') {
    stationView?.setCrew(msg.users);
    queueMicrotask(renderShipState); // transporter crew list
    setLink(msg.ops ? 'online' : 'error', msg.ops ? 'Comm relay online · ops on duty' : 'Ops offline');
  }
  if (await comms.handle(msg)) return;
  switch (msg.type) {
    case 'registered':
      me = { id: msg.id, name: msg.name, ship: msg.ship, station: msg.station };
      token = msg.token;
      if (ops) hideOps();
      if (msg.beamedFrom) log(`beamed from the ${msg.beamedFrom} to the ${me.ship}`);
      document.title = `LCARS: ${me.station} · ${me.ship}`;
      $('home').hidden = false;
      $('comms-button').hidden = false;
      $('log-tab').hidden = false;
      $('reassign-tab').hidden = false;
      $('library-tab').hidden = false;
      log(msg.beamedFrom ? `${me.name} now aboard the ${me.ship}: ${me.station}` : `${me.name} reporting for duty aboard the ${me.ship}: ${me.station}`);
      showStation();
      try { localStorage.setItem('voice-reg', JSON.stringify({ name: me.name, ship: me.ship, station: me.station })); } catch {}
      break;
    case 'register-failed':
      $('register-error').textContent = msg.reason;
      $('register-form').querySelector('button').disabled = false;
      break;
    case 'operator-ok':
      me = { id: msg.id, name: msg.name, ship: msg.ship, station: msg.station };
      token = msg.token;
      document.title = `LCARS: Ops · ${me.ship}`;
      $('home').hidden = false;
      $('comms-button').hidden = false;
      $('log-tab').hidden = false;
      $('library-tab').hidden = false;
      log(`${me.name} took the ops station aboard the ${me.ship}`);
      showOps();
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
    case 'traffic':
      traffic = msg.calls;
      renderTraffic();
      break;
    case 'hello': {
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
      renderShips(msg.ships);
      renderShipState();
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
$('ops-ship').value = urlParams.get('ship') || (savedReg?.station === 'Operations' ? savedReg.ship : '');
$('station').onchange = updateSignInMode;

function fillStations() {
  const sel = $('station');
  const keep = sel.value || urlParams.get('station') || savedReg?.station || '';
  const placeholder = new Option('Station', '');
  placeholder.disabled = true;
  const all = ['Operations', ...stations];
  sel.replaceChildren(placeholder, ...all.map((n) => new Option(n, n)));
  sel.value = all.includes(keep) ? keep : '';
  updateSignInMode();
  if (me) $('new-station').replaceChildren(...stations.filter((n) => n !== me.station).map((n) => new Option(n, n)));
}
fillStations();

$('register-form').onsubmit = (e) => {
  e.preventDefault();
  if (ws?.readyState !== WebSocket.OPEN) return;
  $('register-error').textContent = '';
  $('register-form').querySelector('button').disabled = true;
  if (opsSelected() && !$('ops-ship').value.trim()) {
    $('register-error').textContent = 'Enter the ship for this ops station';
    $('register-form').querySelector('button').disabled = false;
    return;
  }
  if (opsSelected()) send({ type: 'operator', name: $('name').value.trim(), ship: $('ops-ship').value.trim(), key: $('key').value });
  else send({ type: 'register', name: $('name').value.trim(), ship: $('ship').value, station: $('station').value });
};
$('new-station').onchange = () => { $('reassign-key').hidden = $('new-station').value !== 'Operations'; };
$('reassign-form').onsubmit = (e) => {
  e.preventDefault();
  $('reassign-error').textContent = '';
  send({ type: 'change-station', station: $('new-station').value, key: $('reassign-key').value });
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
window.__operator = new Proxy({}, { get: (_, k) => ops?.[k] });
window.__voice = Object.create(comms.voice, {
  myName: { get: () => me?.name },
  me: { get: () => me },
  token: { get: () => token },
});
