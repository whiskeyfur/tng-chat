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
  ws.onopen = () => setLink('online', `${relayName} online`);
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
  showScreen(stationView.sections[0].id);
}

// The Station screen: any other station, Operations included.
// Every station is a tap; Operations asks for the code first if the relay
// wants one. Docked, the vessels across the dock get their own taps.
let dockSig = '';
function fillReassign() {
  if (!me) return;
  $('assignment').textContent = `${me.name}: ${me.station}, the ${me.ship}`;
  // Every vessel lists every station, Operations included; where you are now is greyed out.
  const tap = (name, ship, remote) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'lcars-button lcars-button--pill tr-tap', textContent: name });
    b.dataset.station = name;
    if (ship) b.dataset.ship = ship;
    if (remote) { b.dataset.remote = ''; b.onclick = () => { $('reassign-error').textContent = ''; send({ type: 'change-station', station: name, ship, remote: true }); }; return b; }
    if (!ship && name === me.station) { b.disabled = true; b.title = 'You are here'; b.setAttribute('aria-current', 'true'); }
    b.onclick = () => {
      $('reassign-error').textContent = '';
      if (name === 'Operations' && opsKeyRequired) { $('reassign-form').hidden = false; $('reassign-form').dataset.ship = ship || ''; $('reassign-key').focus(); return; }
      send({ type: 'change-station', station: name, ...(ship ? { ship } : {}) });
    };
    return b;
  };
  const all = ['Operations', ...stations];
  $('station-taps').replaceChildren(...all.map((n) => tap(n)));
  const across = lastNav?.own?.grid?.dockedWith || [];
  const remote = lastNav?.own?.remoteTargets || [];
  dockSig = JSON.stringify([across, remote, me.remoteFrom]);
  $('dock-stations').replaceChildren(...across.map((v) => {
    const box = document.createElement('div');
    box.className = 'dock-stations';
    box.dataset.vessel = v;
    box.append(Object.assign(document.createElement('h3'), { className: 'ops-subhead', textContent: `Across the dock: ${/^(Starbase|Deep Space) /.test(v) ? v : `the ${v}`}` }),
      Object.assign(document.createElement('div'), { className: 'tr-taps' }));
    box.lastChild.append(...all.map((n) => tap(n, v)));
    return box;
  }), ...remote.map((v) => {
    // Remote control over a data link: a crewless ship's stations (not ops).
    const box = document.createElement('div');
    box.className = 'dock-stations';
    box.dataset.remoteVessel = v;
    box.append(Object.assign(document.createElement('h3'), { className: 'ops-subhead', textContent: `By data link (no crew aboard): the ${v}` }),
      Object.assign(document.createElement('div'), { className: 'tr-taps' }));
    box.lastChild.append(...stations.map((n) => tap(n, v, true)));
    return box;
  }), ...(me.remoteFrom ? [(() => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'lcars-button lcars-button--pill lcars-button--alert', id: 'remote-return', textContent: `Return to the ${me.remoteFrom}` });
    b.onclick = () => send({ type: 'change-station', station: 'Crew', ship: me.remoteFrom });
    const box = document.createElement('div');
    box.className = 'dock-stations';
    box.append(Object.assign(document.createElement('h3'), { className: 'ops-subhead', textContent: `Remote control of the ${me.ship} from the ${me.remoteFrom}` }), b);
    return box;
  })()] : []));
  $('reassign-form').hidden = true;
  $('reassign-key').value = '';
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
    const who = c.members.map((m) => comms.voice.label(m)).join('  ⟷  ');
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
const POWER = [['engines', 'Engines'], ['injectors', 'Plasma injectors'], ['shields', 'Shields'], ['sensors', 'Sensors'], ['transporter', 'Transporter'], ['weapons', 'Weapons'], ['lifeSupport', 'Life support'], ['replicators', 'Replicators'], ['recreation', 'Recreation']];
const ownPower = () => lastNav?.own?.power || null;

// Shields (footer, displays, Tactical's control), the transporter controls and
// the life support warning. Rebuilt only when something they show changes, so
// buttons don't move under the pointer.
let shipStateSig = '';
function renderShipState() {
  if (!me) return;
  const p = ownPower();
  bc.setAlert('life', p && p.lifeSupport < 50 ? `Life support at ${p.lifeSupport}%` : null);
  // Alert status: red or yellow frame and a bar on every console aboard.
  const alert = lastNav?.own?.alert || 'green';
  document.body.dataset.alert = alert;
  bc.setAlert('alert', alert === 'green' ? null : `${alert === 'red' ? 'Red' : 'Yellow'} alert`, { level: alert });
  if (!stationView) return;
  const up = !!ownShip()?.shields;
  const crew = comms.users.filter((u) => u.ship.toLowerCase() === me.ship.toLowerCase() && u.station !== 'Operations');
  const targets = ships.filter((s) => s.computer && s.name.toLowerCase() !== me.ship.toLowerCase());
  const range = lastNav?.ranges?.transporter;
  const strength = lastNav?.own?.combat?.shield;
  const sig = JSON.stringify([up, p?.shields, p?.transporter, Math.round(range || 0), crew.map((u) => u.id), targets.map((t) => [t.name, t.shields]), strength]);
  if (sig === shipStateSig) return;
  shipStateSig = sig;
  stationView.setShields(up);
  document.body.toggleAttribute('data-shields-up', up);
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

  const shieldCtl = document.querySelector('[data-shield-control]');
  if (shieldCtl) {
    const weak = (p && p.shields < 20) || strength < 10;
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
  if (tr) renderTransporter(tr, { crew, targets, up, p, range });
}

// The transporter room: tap who to beam, which ship (this one too: site to
// site) and which station they arrive at, then push all three energize
// sliders to the top, as on the old Constitution-class consoles.
const beamSel = { who: null, ship: null, station: null };
function renderTransporter(tr, { crew, targets, up, p, range }) {
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
    tr.replaceChildren(
      el('div', { className: 'tr-pick' }, el('span', { className: 'tr-label', textContent: 'Beam' }), el('div', { className: 'tr-taps', id: 'beam-who' })),
      el('div', { className: 'tr-pick' }, el('span', { className: 'tr-label', textContent: 'To' }), el('div', { className: 'tr-taps', id: 'beam-ship' })),
      el('div', { className: 'tr-pick' }, el('span', { className: 'tr-label', textContent: 'Station' }), el('div', { className: 'tr-taps', id: 'beam-station' })),
      el('div', { className: 'tr-energize' }, sliders, el('span', { className: 'tr-label', textContent: 'Energize: all three up' })),
      el('p', { className: 'ops-notice', id: 'beam-status' }),
      el('p', { className: 'ops-hint', id: 'beam-range' }));
  }
  const ships = [{ name: me.ship, here: true }, ...targets];
  if (!crew.some((u) => u.id === beamSel.who)) beamSel.who = crew[0]?.id || null;
  if (!ships.some((x) => x.name === beamSel.ship)) beamSel.ship = targets[0]?.name || me.ship;
  const stations = ['Same station', ...STATION_NAMES.filter((n) => n !== 'Operations')];
  if (!stations.includes(beamSel.station)) beamSel.station = 'Same station';
  const taps = (box, items, sel, set) => box.replaceChildren(...items.map(([value, text]) => {
    const b = el('button', { type: 'button', className: 'lcars-button lcars-button--pill tr-tap', textContent: text });
    b.dataset.value = value;
    b.setAttribute('aria-pressed', String(value === sel));
    b.onclick = () => { set(value); renderTransporter(tr, { crew, targets, up, p, range }); };
    return b;
  }));
  taps(tr.querySelector('#beam-who'), crew.map((u) => [u.id, u.id === me.id ? `${u.name} (you)` : `${u.name} · ${u.station}`]), beamSel.who, (v) => { beamSel.who = v; });
  taps(tr.querySelector('#beam-ship'), ships.map((x) => [x.name, x.here ? `The ${x.name} (site to site)` : `The ${x.name}${x.shields ? ' (shields up)' : ''}`]), beamSel.ship, (v) => { beamSel.ship = v; });
  taps(tr.querySelector('#beam-station'), stations.map((n) => [n, n]), beamSel.station, (v) => { beamSel.station = v; });
  const noPower = p && p.transporter <= 0;
  const blocked = noPower ? 'No power to the transporter: ask Engineering' : up && beamSel.ship !== me.ship ? `Shields are up aboard the ${me.ship}` : '';
  for (const r of tr.querySelectorAll('.tr-slider')) r.disabled = !crew.length || noPower;

  if (blocked) tr.querySelector('#beam-status').textContent = blocked;
  tr.querySelector('#beam-range').textContent = range != null ? `Transporter range ${Math.round(range)} units (sensor power ${p?.sensors ?? 100}%)` : '';
}

// All three sliders at the top: energize once, then they fall back (and
// can't fire again until they have).
let energizing = false;
function energizeCheck() {
  const rs = [...document.querySelectorAll('.tr-slider')];
  if (energizing || !rs.length || rs.some((r) => Number(r.value) < 95) || !beamSel.who) return;
  energizing = true;
  stationView?.energize();
  send({ type: 'beam', who: beamSel.who, ship: beamSel.ship, ...(beamSel.station !== 'Same station' ? { station: beamSel.station } : {}) });
  setTimeout(() => { rs.forEach((r) => { r.value = 0; }); energizing = false; }, 900);
}

// --- Captain, First Officer, Security, Medical controls --------------------------
const securityAlerts = []; // beam-ins Security has been told about

function renderCrewPanels() {
  if (!me || !stationView) return;
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const button = (text, onclick, extra = '') => el('button', { type: 'button', className: `lcars-button lcars-button--pill ${extra}`, textContent: text, onclick });
  const aboard = comms.users.filter((u) => u.ship.toLowerCase() === me.ship.toLowerCase());
  const crew = aboard.filter((u) => u.station !== 'Operations');
  const status = (u) => (u.sickbay ? 'Sickbay' : u.confined ? 'Confined to quarters' : 'On duty');
  // Rebuild a panel only when what it shows has changed (buttons stay put).
  const changed = (node, ...state) => { const sig = JSON.stringify(state); if (node.dataset.sig === sig) return false; node.dataset.sig = sig; return true; };
  const crewSig = crew.map((u) => [u.id, u.station, !!u.sickbay, !!u.confined]);
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
      form.onsubmit = (e) => { e.preventDefault(); if (text.value.trim()) send({ type: 'order', text: text.value.trim() }); text.value = ''; };
      cmd.append(
        el('p', { className: 'st-state', id: 'alert-state' }),
        el('div', { className: 'ops-form', id: 'alert-buttons' },
          ...[['green', 'Condition green', ''], ['yellow', 'Yellow alert', 'alert-yellow'], ['red', 'Red alert', 'lcars-button--alert']].map(([lvl, t, c]) => {
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
  }

  // First Officer: reassign crew.
  const ra = document.querySelector('[data-reassign]');
  if (ra && changed(ra, crewSig, stations)) {
    const keep = ra.querySelector('#xo-who')?.value, keepSt = ra.querySelector('#xo-station')?.value;
    const who = pickCrew('xo-who', crew, keep);
    const st = el('select', { className: 'ops-select', id: 'xo-station', ariaLabel: 'station' }, ...stations.map((n) => new Option(n, n)));
    if (keepSt) st.value = keepSt;
    ra.replaceChildren(
      el('div', { className: 'ops-form' }, el('span', { textContent: 'Reassign' }), who, el('span', { textContent: 'to' }), st,
        button('Reassign', () => send({ type: 'reassign', who: who.value, station: st.value }))),
      el('p', { className: 'ops-hint', textContent: 'Covers unmanned departments: the crew member\'s console switches to the new station.' }));
  }

  // Security: transporter lockout, confinement, beam-in alerts.
  const sec = document.querySelector('[data-security]');
  const fields = lastNav?.own?.grid?.forcefields || [];
  if (sec && changed(sec, crewSig, !!lastNav?.own?.lockout, securityAlerts.length, fields, lastNav?.own?.grid?.fieldsUp)) {
    const lockout = !!lastNav?.own?.lockout;
    const keep = sec.querySelector('#sec-who')?.value;
    const others = crew.filter((u) => u.id !== me.id);
    const who = pickCrew('sec-who', others, keep);
    const confined = others.filter((u) => u.confined);
    sec.replaceChildren(
      el('div', { className: 'st-control' },
        el('p', { className: 'st-state', textContent: lockout ? 'Transporter lockout: force field up' : 'Transporter lockout: off' }),
        button(lockout ? 'Drop force field' : 'Raise force field', () => send({ type: 'lockout', on: !lockout }), lockout ? '' : 'lcars-button--alert')),
      el('h3', { className: 'ops-subhead', textContent: 'Console force fields' }),
      el('div', { className: 'tr-taps', id: 'sec-fields' }, ...stations.filter((st) => st !== 'Security').map((st) => {
        const on = fields.includes(st);
        const b = button(st, () => send({ type: 'forcefield', station: st, on: !on }), on ? 'lcars-button--alert' : '');
        b.classList.add('tr-tap');
        b.dataset.station = st;
        b.setAttribute('aria-pressed', String(on));
        return b;
      })),
      el('p', { className: 'ops-hint', textContent: fields.length ? `Sealed: ${fields.join(', ')}${lastNav?.own?.grid?.fieldsUp ? '' : ' (emitters have no power: fields are down)'}` : 'Tap a console to seal it with a force field (5 power each, from the emitters).' }),
      el('div', { className: 'ops-form' }, el('span', { textContent: 'Quarters' }), who,
        button('Confine', () => send({ type: 'confine', who: who.value, on: true }), 'lcars-button--alert'),
        button('Release', () => send({ type: 'confine', who: who.value, on: false }))),
      el('p', { className: 'ops-hint', textContent: confined.length ? `Confined: ${confined.map((u) => u.name).join(', ')}` : 'Nobody is confined to quarters' }),
      el('h3', { className: 'ops-subhead', textContent: 'Beam-in alerts' }),
      el('ul', { className: 'lcars-log', id: 'sec-alerts' }, ...(securityAlerts.length ? securityAlerts.slice(-8).reverse().map((t) => el('li', { className: 'lcars-log__line lcars-log__line--warn', textContent: t })) : [el('li', { className: 'lcars-log__line', textContent: 'No unauthorized arrivals' })])));
  }

  // Medical: sickbay and life signs.
  const med = document.querySelector('[data-medical]');
  if (med && changed(med, crewSig, ownPower()?.lifeSupport)) {
    const p = ownPower();
    med.replaceChildren(
      el('p', { className: 'ops-hint', textContent: p ? `Life support ${p.lifeSupport}%${p.lifeSupport < 50 ? ': crew at risk' : ''}` : '' }),
      el('ul', { className: 'st-list st-patients' }, ...crew.map((u) => {
        const li = el('li', {}, `${u.name}${u.id === me.id ? ' (you)' : ''}`, el('span', { textContent: `${u.station} · ${status(u)}` }),
          u.sickbay ? button('Discharge', () => send({ type: 'sickbay', who: u.id, on: false })) : button('Admit', () => send({ type: 'sickbay', who: u.id, on: true }), 'lcars-button--alert'));
        li.dataset.crew = u.id;
        return li;
      })),
      el('p', { className: 'ops-hint', textContent: 'Crew in sickbay are off duty: they don\'t count in department readiness.' }));
  }
}

// A dark console covers its station screens only: Station (to move to a
// console that has power), Console log and Library stay usable.
let consoleDark = false;
function updateCover() {
  const shown = [...document.querySelectorAll('[data-screen]')].find((el) => !el.hidden);
  $('console-dark').hidden = !consoleDark || !shown?.closest('#station-view, #ops-view');
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
  bc.setAlert('breach', grid.breach != null ? `Antimatter containment failing: core breach in ${grid.breach} s (no power from ${feeds(grid.ties.containment)})` : null);
  bc.setAlert('tractor', grid.towedBy ? `Held in the ${grid.towedBy}'s tractor beam` : null, { level: 'yellow' });
  bc.setAlert('selfdestruct', grid.selfDestruct ? `Self-destruct in ${grid.selfDestruct.seconds} s · ordered by ${grid.selfDestruct.by}` : null);

  // This console goes dark when its bus has no power (comms still work).
  const tied = grid.ties[`console:${me.station}`] || [];
  const bus = tied.length ? tied.map((n) => `Bus ${n}`).join(' or ') : 'its bus (not tied in)';
  const fielded = grid.fieldsUp && grid.forcefields.includes(me.station);
  const dark = fielded || grid.consoleOk[me.station] === false;
  // Engineering's power grid runs on emergency power, so it's never covered (a force field still seals it).
  const emergency = dark && !fielded && me.station === 'Engineering';
  bc.setAlert('emergency', emergency ? `Console on emergency power (no power on ${bus}): Power grid controls only` : null, { level: 'yellow' });
  consoleDark = dark && !emergency;
  if (dark) $('console-dark').querySelector('p').textContent = fielded ? 'Console sealed · Security force field' : `Console offline · no power on ${bus}`;
  updateCover();
  document.body.toggleAttribute('data-console-dark', dark);
  if (!stationView) return;

  // Tactical: target, lock, arm phasers, fire.
  const wp = document.querySelector('[data-weapons]');
  if (wp) {
    if (!wp.firstChild) {
      const sel = el('select', { className: 'ops-select', id: 'weapons-target', ariaLabel: 'target' });
      wp.append(
        el('div', { className: 'ops-form' }, el('span', { textContent: 'Target' }), sel,
          button('Lock weapons', 'weapons-lock', () => sel.value && send({ type: 'lock', ship: sel.value }), 'lcars-button--alert'),
          button('Release', 'weapons-release', () => send({ type: 'lock', ship: null }))),
        el('p', { className: 'st-state', id: 'weapons-lock-state' }),
        el('div', { className: 'ops-form' },
          button('Tractor beam', 'tractor-lock', () => sel.value && send({ type: 'tractor', ship: sel.value })),
          button('Release tractor', 'tractor-release', () => send({ type: 'tractor', ship: null })),
          el('span', { className: 'ops-hint', id: 'tractor-state' })),
        el('div', { className: 'ops-form wp-fire' },
          button('Arm phasers', 'arm-phasers', () => send({ type: 'arm', on: !lastNav?.own?.combat?.phaser.armed })),
          button('Fire phasers', 'fire-phaser', () => send({ type: 'fire', weapon: 'phaser' }), 'lcars-button--alert'),
          button('Fire torpedo', 'fire-torpedo', () => send({ type: 'fire', weapon: 'torpedo' }), 'lcars-button--alert')),
        el('div', { className: 'ops-readouts' },
          el('div', { className: 'lcars-readout', id: 'wp-phasers' }), el('div', { className: 'lcars-readout', id: 'wp-torpedoes' })),
        el('p', { className: 'ops-notice', id: 'weapons-status' }),
        el('p', { className: 'ops-hint', textContent: `Arm phasers to charge the banks (faster with more weapons power; armed weapons draw power, which shows on sensors). A full bank fires, up to ${c.phaser.range} units. Torpedoes reach ${c.torpedo.range} units and reload in ${c.torpedo.reload / 1000} s; ${c.carried} carried, restocked only when docked at a starbase. Shields soak hits until they fail; then the hull and systems take damage, and with no hull left the ship is destroyed.` }));
    }
    const sel = wp.querySelector('#weapons-target');
    const contacts = lastNav.ships.filter((s) => s.name !== own.name);
    if (changed(sel, contacts.map((s) => s.name), c.lock?.name)) {
      const keep = sel.value || c.lock?.name;
      sel.replaceChildren(...contacts.map((s) => new Option(s.name, s.name)));
      if (!contacts.length) sel.append(new Option('No contacts on sensors', ''));
      if (keep && contacts.some((s) => s.name === keep)) sel.value = keep;
    }
    for (const s of contacts) [...sel.options].find((o) => o.value === s.name).textContent = `The ${s.name} (${Math.round(s.distance)} units${s.shields ? ', shields up' : ''})`;
    const lockState = wp.querySelector('#weapons-lock-state');
    lockState.textContent = c.lock ? `Locked on the ${c.lock.name} · ${c.lock.distance} units · shields ${c.lock.shields ? `up, ${c.lock.shield}%` : 'down'} · hull ${c.lock.hull}%` : 'No weapons lock';
    lockState.toggleAttribute('data-up', !!c.lock);
    wp.querySelector('#weapons-release').disabled = !c.lock;
    wp.querySelector('#tractor-release').disabled = !grid.towing;
    wp.querySelector('#tractor-state').textContent = grid.towing ? `Towing the ${grid.towing} (warp 3 at most)` : grid.towedBy ? `Held in the ${grid.towedBy}'s tractor beam` : 'Tractor beam: holds a ship within 20 units with its shields down';
    const arm = wp.querySelector('#arm-phasers');
    arm.textContent = c.phaser.armed ? 'Stand down phasers' : 'Arm phasers';
    arm.setAttribute('aria-pressed', String(c.phaser.armed));
    updateWeaponTimers();
  }

  // Engineering: the power grid.
  const gp = document.querySelector('[data-grid]');
  // Not while someone's typing an amount or picking a resource there.
  if (gp && !gp.contains(document.activeElement?.closest?.('input[type=number], select') || null) && changed(gp, grid, own.power)) {
    const status = gp.querySelector('#grid-status')?.textContent || '';
    const keepRes = gp.querySelector('#transfer-resource')?.value, keepAmt = gp.querySelector('#transfer-amount')?.value;
    // A source's ties: any of Bus A, Bus B and the EPS (checkboxes).
    // The grid as a table: a row per source (and containment, and power fed
    // to a docked ship), a column per bus and the EPS, each cell a tie
    // checkbox with the power flowing through it; the footer is used/available.
    const NODE_NAMES = { A: 'Bus A', B: 'Bus B', C: 'Bus C', EPS: 'EPS' };
    const COLS = ['A', 'B', 'C', 'EPS'];
    // A row: label (with a note and maybe controls), then a cell per node:
    // the tie checkbox (only where this row may tie) and the power through it,
    // + for supply, − for draw.
    const SOURCE_ROWS = new Set(['ship', 'solar', 'dock', 'impulsePort', 'impulseStarboard', 'core', 'battery']);
    const ties = (key, label, cellKey = key, { level = 0, note = '', controls = [], sign } = {}) => {
      const th = el('th', { scope: 'row' }, el('span', { textContent: label }), ...controls, ...(note ? [el('small', { className: 'grid-note', textContent: note })] : []));
      if (level) th.className = `grid-indent grid-indent--${level}`;
      const tr = el('tr', { id: `ties-${key.replace(':', '-')}` }, th);
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
      const tr = el('tr', { id }, el('th', { scope: 'row', className: `grid-indent grid-indent--${level}` }, el('span', { textContent: label }), ...controls, ...(note ? [el('small', { className: 'grid-note', textContent: note })] : [])));
      for (const n of COLS) tr.append(el('td', { className: 'grid-na' }));
      return tr;
    };
    const small = (text, id, onclick, alert) => { const b = button(text, id, onclick, alert ? 'lcars-button--alert' : ''); b.classList.add('grid-mini'); return b; };
    const subRow = (name, level, note) => ties(`sub:${name}`, grid.subsystems[name].name, `sub:${name}`, { level, note: note ?? (grid.subOk[name] === false ? 'NO POWER' : '') });
    const driveRows = (d) => {
      const dr = grid.drives[d], src = d === 'port' ? 'impulsePort' : 'impulseStarboard';
      const state = dr.state === 'starting' ? `starting ${dr.start} of ${grid.impulseStartSecs} s` : dr.state;
      return [
        parentRow(`ties-${src}`, `${d[0].toUpperCase()}${d.slice(1)} impulse drive`, 1, `${state}${dr.state === 'running' ? ` · ${grid.cells[src].EPS || 0} of ${grid.impulseOutput} to the EPS, the rest to thrust` : ''}`,
          [dr.state === 'off' ? small('Start', `drive-${d}-start`, () => send({ type: 'grid', impulse: { drive: d, on: true } })) : small('Stop', `drive-${d}-stop`, () => send({ type: 'grid', impulse: { drive: d, on: false } }), true)]),
        subRow(`${d}Pump`, 2, dr.state === 'starting' ? (grid.subOk[`${d}Pump`] ? 'powering startup' : 'NO POWER') : dr.state === 'running' ? 'self-powered' : ''),
        ties(`thrusters${d[0].toUpperCase()}${d.slice(1)}`, 'Maneuvering thrusters', `thrusters${d[0].toUpperCase()}${d.slice(1)}`, { level: 2, note: dr.thrusters ? 'tied in: the drive\'s unused thrust feeds the EPS' : 'untied: thrust only, nothing to the EPS' }),
      ];
    };
    // A row with a control across the bus columns (EPS taps' light bars).
    const spanRow = (id, label, level, control, note = '') => {
      const tr = el('tr', { id }, el('th', { scope: 'row', className: `grid-indent grid-indent--${level}` }, el('span', { textContent: label }), ...(note ? [el('small', { className: 'grid-note', textContent: note })] : [])));
      tr.append(el('td', { colSpan: COLS.length }, ...(control ? [control] : [])));
      return tr;
    };
    const tapRows = () => [
      spanRow('eps-taps', 'EPS taps', 1, null, 'EPS power down into each low bus, up to the level set'),
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
      ...(grid.core !== 'ejected' ? [ties('containment', grid.antimatter ? 'Antimatter containment' : 'Containment (no antimatter: may be off)', 'containment', { level: 1, sign: false, note: grid.antimatter ? (grid.containmentOk ? 'holding' : 'FAILING') : '' })] : []),
      parentRow('ties-core-parent', 'Warp core (M/ARC)', 1, grid.core === 'starting' ? `starting ${grid.start} of ${grid.startSecs} s` : grid.core),
      ...(grid.core !== 'ejected' ? [
        ties('core', 'Power transfer conduits', 'core', { level: 2, note: c.damage.conduits >= 50 ? 'DAMAGED: no output' : 'carry the core\'s output into the EPS' }),
        ...['constriction', 'corePump', 'injector'].map((x) => subRow(x, 2)),
      ] : []),
      ...driveRows('port'), ...driveRows('starboard'),
      ...tapRows(),
      ties('battery', `Batteries ${grid.battery.charge}%`, 'battery', { level: 1, note: grid.battery.charging ? 'charging' : grid.battery.supplying ? 'supplying' : '' }),
      ties('solar', 'Solar', 'solar', { level: 1 }),
      ties('dock', grid.docked ? `Dock power (${grid.docked})` : 'Dock power (not docked)', 'dock', { level: 1 }),
      ...(grid.dockedShip ? [ties('ship', `From the ${grid.dockedShip}`, 'ship', { level: 1 }), Object.assign(ties('ship', `To the ${grid.dockedShip}`, 'feed', { level: 1, sign: false }), { id: 'ties-ship-feed' })] : []),
    ];
    const table = () => {
      const SYS = { ...Object.fromEntries(POWER), tractor: 'Tractor beam' };
      const crewAt = (st) => comms.users.filter((u) => u.ship.toLowerCase() === me.ship.toLowerCase() && u.station === st).length;
      // The bus crosslink heads the table, set apart from the consoles.
      const xl = crosslinkRow();
      xl.querySelector('th').className = '';
      xl.classList.add('grid-crosslink');
      const rows = [xl];
      for (const key of Object.keys(grid.tieNodes).filter((x) => x.startsWith('console:'))) {
        const st = key.slice(8), n = crewAt(st);
        rows.push(ties(key, `${st} console`, key, { note: n ? (grid.consoleOk[st] ? `${n} aboard` : `${n} aboard · DARK`) : 'unmanned' }));
        const sysRow = (sys, level) => {
          const want = sys === 'tractor' ? (grid.towing ? 30 : 0) : grid.demand[sys], got = sys === 'tractor' ? want : grid.delivered[sys];
          rows.push(ties(`system:${sys}`, SYS[sys], `system:${sys}`, { level, note: want ? `${got} of ${want}${got < want ? ' · SHORT' : ''}${got > 100 ? ' · OVERDRIVE' : ''}` : 'off' }));
          for (const child of grid.systemChildren[sys] || []) sysRow(child, level + 1);
        };
        for (const sys of grid.stationSystems[st] || []) sysRow(sys, 1);
        if (st === 'Engineering') rows.push(...engineeringRows());
        if (st === 'Communications') rows.push(...['rf', 'radio', 'subspace'].map((x) => subRow(x, 1)));
      }
      return el('table', { className: 'grid-table', id: 'grid-table' },
        el('thead', {}, el('tr', {}, el('th', { scope: 'col', textContent: 'System' }), ...COLS.map((n) => el('th', { scope: 'col', textContent: NODE_NAMES[n] })))),
        el('tbody', {}, ...rows),
        el('tfoot', {}, el('tr', {}, el('th', { scope: 'row', textContent: 'Used / available / max' }),
          ...COLS.map((n) => {
            const t = grid.totals[n];
            const td = el('td', { id: `grid-total-${n}` }, `${t.used} / ${t.available} / ${t.max}`, ...(t.condition < 100 ? [el('small', { className: 'grid-note', textContent: `damaged: ${t.condition}% condition` })] : []));
            td.toggleAttribute('data-over', t.tied > t.max || t.condition < 100);
            return td;
          }))));
    };
    // Power offered to a ship docked with us (they may offer some back: the difference flows).
    const feedControl = () => {
      if (!grid.dockedShip) return el('span');
      const bar = lightBar(`Power offered to the ${grid.dockedShip}`, grid.feedMax, (v) => send({ type: 'grid', feed: v }));
      bar.id = 'feed-bar';
      bar.set(grid.feed);
      const net = grid.feed - grid.partnerFeed;
      return el('div', { className: 'ops-form' },
        el('span', { textContent: `Offer the ${grid.dockedShip}: ${grid.feed}` }), bar,
        el('span', { className: 'ops-hint', id: 'feed-state', textContent: `They offer ${grid.partnerFeed}. ${net > 0 ? `We send ${grid.fed} of ${net}` : net < 0 ? `We receive ${grid.shipIn} of ${-net}` : 'Nothing flows'}${grid.ties.ship.length ? '' : ' (tie the docked-ship rows to a bus or the EPS)'}` }));
    };
    // Antimatter and deuterium aboard, and moving them: refuel or offload at a
    // starbase, or send ours to a ship docked with us.
    const supplies = () => {
      const res = el('select', { className: 'ops-select', id: 'transfer-resource', ariaLabel: 'resource' }, new Option('Antimatter', 'antimatter'), new Option('Deuterium', 'deuterium'));
      const amt = el('input', { className: 'ops-input', id: 'transfer-amount', type: 'number', min: 1, value: 200, ariaLabel: 'amount' });
      amt.style.width = '7em';
      const partner = grid.docked || (grid.dockedShip && `the ${grid.dockedShip}`);
      const t = grid.transfer;
      return el('div', { className: 'grid-supplies' },
        el('p', { className: 'st-state', id: 'supplies', textContent: `Antimatter ${grid.antimatter} / ${grid.fuelCaps.antimatter} · Deuterium ${grid.deuterium} / ${grid.fuelCaps.deuterium}` }),
        t ? el('div', { className: 'ops-form' }, el('span', { id: 'transfer-state', textContent: `${t.dir === 'in' ? 'Taking on' : 'Sending'} ${t.resource}: ${t.left} to go (${t.with})` }), button('Stop transfer', 'transfer-stop', () => send({ type: 'grid', transfer: null }), 'lcars-button--alert'))
          : partner ? el('div', { className: 'ops-form' }, el('span', { textContent: `Docked with ${partner}:` }), res, amt,
            ...(grid.docked ? [button('Refuel', 'transfer-in', () => send({ type: 'grid', transfer: { resource: res.value, dir: 'in', amount: Number(amt.value) } }))] : []),
            button(grid.docked ? 'Offload' : `Send to the ${grid.dockedShip}`, 'transfer-out', () => send({ type: 'grid', transfer: { resource: res.value, dir: 'out', amount: Number(amt.value) } })))
          : el('p', { className: 'ops-hint', textContent: 'Dock at a starbase to refuel or offload, or with another ship to send it supplies.' }));
    };
    const coreText = grid.core === 'online' ? `Online · ${grid.coreOutput} to ${feeds(grid.ties.core)}` : grid.core === 'starting' ? `Starting · ${grid.start} of ${grid.startSecs} s on Bus A power` : grid.core === 'ejected' ? 'Ejected · solar and batteries only' : 'Offline';
    gp.replaceChildren(
      el('div', { className: 'st-control' },
        el('p', { className: 'st-state', id: 'core-state', textContent: `Warp core (M/ARC): ${coreText}` }),
        el('div', { className: 'ops-form' },
          ...(grid.docked && grid.core !== 'online' && grid.core !== 'starting' ? [button(grid.core === 'ejected' ? 'Install new warp core and pods' : 'Replace warp core and pods', 'core-refit', () => send({ type: 'grid', refit: true }))] : []),
          grid.core === 'ejected' ? el('span')
            : grid.core === 'offline' ? button('Start warp core', 'core-start', () => send({ type: 'grid', core: 'start' })) : button('Shut down warp core', 'core-stop', () => send({ type: 'grid', core: 'stop' }), 'lcars-button--alert'),
          ...(grid.core !== 'ejected' ? [button('Eject warp core', 'core-eject', () => { if (confirm('Eject the warp core and antimatter pods? The ship is left with solar and batteries until a new core is installed at a starbase.')) send({ type: 'grid', eject: true }); }, 'lcars-button--alert')] : []))),
      table(),
      feedControl(),
      supplies(),
      el('p', { className: 'st-state grid-containment', id: 'containment-state', textContent: grid.core === 'ejected' ? 'Warp core ejected: no antimatter aboard' : !grid.antimatter ? 'No antimatter aboard: containment not needed' : grid.breach != null ? `CONTAINMENT FAILING: breach in ${grid.breach} s` : `Containment holding, fed from ${feeds(grid.ties.containment)}` }),

      el('p', { className: 'ops-notice', id: 'grid-status', textContent: status }),
      el('p', { className: 'ops-hint', textContent: `The core burns antimatter and deuterium for the power it gives (the impulse reactor burns deuterium, and while it gives power the ship is held to slow impulse). Tie each source to any of Bus A, Bus B and the EPS; the EPS reaches a bus through its open tap. The core starts on Bus A power (${grid.startSecs} s). Antimatter containment must always have power from one of its feeds, or the core breaches in seconds (ejecting the core ends that). Power goes to containment first, then consoles, then is shared among systems. EPS carrying ${grid.eps}; total drawn ${grid.drawn} (that's what other ships' sensors see).` }));
    gp.querySelector('#containment-state').toggleAttribute('data-up', grid.breach != null);
    for (const box of gp.querySelectorAll('#ties-containment input')) box.disabled = grid.antimatter > 0 && box.checked && grid.ties.containment.length === 1; // never none with antimatter aboard
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
    const speed = grid.towedBy ? `Towed by the ${grid.towedBy}` : own.warp <= 0 ? (grid.docked ? `Docked at ${grid.docked}` : 'All stop') : `${own.warp < 1 ? 'Impulse' : `Warp ${+own.warp.toFixed(1)}`}${grid.towing ? `, towing the ${grid.towing}` : ''}`;
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

// Phaser charge and torpedo reload, between updates.
function updateWeaponTimers() {
  const wp = document.querySelector('[data-weapons]');
  const c = lastNav?.own?.combat;
  if (!wp?.firstChild || !c) return;
  const tp = Math.max(0, c.torpedo.ready - (Date.now() - combatAt));
  const set = (id, label, value) => wp.querySelector(id).replaceChildren(
    Object.assign(document.createElement('span'), { className: 'lcars-readout__label', textContent: label }),
    Object.assign(document.createElement('span'), { className: 'lcars-readout__value', textContent: value }));
  const weapons = ownPower()?.weapons ?? 0;
  set('#wp-phasers', 'Phaser banks', !c.phaser.armed ? 'Not armed' : c.phaser.charge >= 100 ? 'Charged · ready' : weapons <= 0 ? `${c.phaser.charge}% · no power` : `Charging ${c.phaser.charge}%`);
  set('#wp-torpedoes', 'Photon torpedoes', `${c.torpedoes} of ${c.carried}${tp ? ' · reloading' : ''}`);
  wp.querySelector('#fire-phaser').disabled = !c.lock || !c.phaser.armed || c.phaser.charge < 100 || c.lock.distance > c.phaser.range;
  wp.querySelector('#fire-torpedo').disabled = !c.lock || tp > 0 || !c.torpedoes || c.lock.distance > c.torpedo.range;
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
  const f = draft.sensors / 100;
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
  const busDemand = (X) => POWER.filter(([k]) => grid?.ties[`system:${k}`]?.[0] === X).reduce((n, [k]) => n + (k === 'weapons' && !lastNav.own.combat?.phaser.armed ? 0 : draft[k]), 0);
  const short = grid ? POWER.filter(([k]) => grid.delivered[k] < grid.demand[k]).map(([, label]) => label.toLowerCase()) : [];
  const over = false;
  root.querySelector('.pw-total').textContent = grid
    ? `Systems demand: Bus A ${busDemand('A')} · Bus B ${busDemand('B')} · Bus C ${busDemand('C')} · EPS ${busDemand('EPS')} (weapons draw only when armed)${short.length ? ` · short of power: ${short.join(', ')}` : ''}${powerDraft ? ' · not routed yet' : ''}`
    : `Demand ${total}%${powerDraft ? ' · not routed yet' : ''}`;
  root.querySelector('.pw-total').toggleAttribute('data-over', short.length > 0);
  root.querySelector('.pw-effects').replaceChildren(...[
    `Top speed: ${warp <= 0 ? 'none (no engine power)' : warp < 1 ? 'impulse' : `warp ${warp}`}`,
    `Sensors ${Math.round(600 * f)} · subspace ${Math.round(400 * f)} · transporter ${Math.round(20 * f)} units`,
    draft.shields < 20 ? 'Shields: too little power to hold them' : 'Shields: can be raised',
    draft.transporter <= 0 ? 'Transporter: no power' : 'Transporter: ready',
    draft.lifeSupport < 50 ? `Life support: ${draft.lifeSupport}%, crew warned` : 'Life support: nominal',
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
  if (await bc.handle(msg)) return;
  if (msg.type === 'notice' && /^(Helm|Sensors|Science|Course plotted|No ship's computer is flying)/.test(msg.text)) navPanel?.status(msg.text);
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
    case 'registered':
      me = { id: msg.id, name: msg.name, ship: msg.ship, station: msg.station, remoteFrom: msg.remoteFrom || null };
      token = msg.token;
      if (ops) hideOps();
      queueMicrotask(() => comms.radio?.render());
      if (msg.beamedFrom) log(`beamed from the ${msg.beamedFrom} to the ${me.ship}`);
      if (msg.walkedFrom) log(`crossed the dock from the ${msg.walkedFrom} to the ${me.ship}`);
      if (msg.remoteVia) log(`remote control of the ${me.ship} over the data link`);
      if (msg.returnedFrom) log(`back aboard the ${me.ship} from remote control of the ${msg.returnedFrom}`);
      document.title = `LCARS: ${me.station} · ${me.ship}`;
      $('home').hidden = false;
      $('comms-button').hidden = false;
      $('log-tab').hidden = false;
      $('reassign-tab').hidden = false;
      $('library-tab').hidden = false;
      log(msg.beamedFrom || msg.walkedFrom || msg.remoteVia || msg.returnedFrom ? `${me.name} now aboard the ${me.ship}: ${me.station}` : `${me.name} reporting for duty aboard the ${me.ship}: ${me.station}`);
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
    case 'traffic':
      traffic = msg.calls;
      renderTraffic();
      break;
    case 'nav':
      lastNav = msg;
      navPanel?.update(msg);
      stationView?.setNav(msg.own);
      renderShipState();
      renderPower();
      renderCrewPanels();
      renderCombat();
      renderServices();
      if (JSON.stringify([msg.own?.grid?.dockedWith || [], msg.own?.remoteTargets || [], me?.remoteFrom || null]) !== dockSig) fillReassign();
      break;
    case 'course-plotted':
      log(`${msg.by.name} plotted a course to ${msg.label}`);
      navPanel?.plotted(msg);
      break;
    case 'scan-result':
      navPanel?.scanned(msg);
      break;
    case 'order':
      log(`Captain's orders (${msg.from.name}): ${msg.text}`);
      bc.addOrder(msg.from, msg.text);
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
  fillReassign();
}
fillStations();

$('register-form').onsubmit = (e) => {
  e.preventDefault();
  if (ws?.readyState !== WebSocket.OPEN) return;
  $('register-error').textContent = '';
  $('register-form').querySelector('button').disabled = true;
  if (opsSelected()) send({ type: 'operator', name: $('name').value.trim(), ship: $('ship').value, key: $('key').value });
  else send({ type: 'register', name: $('name').value.trim(), ship: $('ship').value, station: $('station').value });
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
window.__broadcast = bc;
window.__nav = { get last() { return lastNav; } };
window.__operator = new Proxy({}, { get: (_, k) => ops?.[k] });
window.__voice = Object.create(comms.voice, {
  myName: { get: () => me?.name },
  me: { get: () => me },
  token: { get: () => token },
});
