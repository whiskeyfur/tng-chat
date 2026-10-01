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
  sel.replaceChildren(placeholder, ...ships.map((s) => new Option(s.ops ? s.name : `${s.name} (ops offline)`, s.name)));
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
  $('reassign-key').hidden = $('new-station').value !== 'Operations' || !opsKeyRequired;
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
const POWER = [['engines', 'Engines'], ['shields', 'Shields'], ['sensors', 'Sensors'], ['transporter', 'Transporter'], ['weapons', 'Weapons'], ['lifeSupport', 'Life support']];
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
  if (tr) {
    const keep = { who: tr.querySelector('#beam-who')?.value, ship: tr.querySelector('#beam-ship')?.value };
    const who = el('select', { className: 'ops-select', id: 'beam-who', ariaLabel: 'who to beam' }, ...crew.map((u) => new Option(u.id === me.id ? `${u.name} (you)` : `${u.name} · ${u.station}`, u.id)));
    const dest = el('select', { className: 'ops-select', id: 'beam-ship', ariaLabel: 'destination ship' }, ...targets.map((s) => new Option(s.shields ? `${s.name} (shields up)` : s.name, s.name)));
    if (keep.who && crew.some((u) => u.id === keep.who)) who.value = keep.who;
    if (keep.ship && targets.some((s) => s.name === keep.ship)) dest.value = keep.ship;
    const noPower = p && p.transporter <= 0;
    const blocked = noPower ? 'No power to the transporter: ask Engineering' : up ? `Shields are up aboard the ${me.ship}` : '';
    const energize = el('button', {
      type: 'button', className: 'lcars-button lcars-button--pill', id: 'beam-go', textContent: 'Energize',
      disabled: !crew.length || !targets.length || noPower,
      onclick: () => { stationView.energize(); send({ type: 'beam', who: who.value, ship: dest.value }); },
    });
    const form = el('div', { className: 'ops-form' }, el('span', { textContent: 'Beam' }), who, el('span', { textContent: 'to the' }), dest, energize);
    const status = el('p', { className: 'ops-notice', id: 'beam-status', textContent: blocked || tr.querySelector('#beam-status')?.textContent || '' });
    const reach = el('p', { className: 'ops-hint', id: 'beam-range', textContent: range != null ? `Transporter range ${Math.round(range)} units (sensor power ${p?.sensors ?? 100}%)` : '' });
    tr.replaceChildren(form, status, reach);
  }
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
  if (sec && changed(sec, crewSig, !!lastNav?.own?.lockout, securityAlerts.length)) {
    const lockout = !!lastNav?.own?.lockout;
    const keep = sec.querySelector('#sec-who')?.value;
    const others = crew.filter((u) => u.id !== me.id);
    const who = pickCrew('sec-who', others, keep);
    const confined = others.filter((u) => u.confined);
    sec.replaceChildren(
      el('div', { className: 'st-control' },
        el('p', { className: 'st-state', textContent: lockout ? 'Transporter lockout: force field up' : 'Transporter lockout: off' }),
        button(lockout ? 'Drop force field' : 'Raise force field', () => send({ type: 'lockout', on: !lockout }), lockout ? '' : 'lcars-button--alert')),
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

// --- combat: Tactical's weapons, Engineering's damage control, the Captain's status ---
// Ready times count down here between 'nav' messages.
let combatAt = 0;
function renderCombat() {
  if (!me) return;
  const own = lastNav?.own, c = own?.combat;
  if (!c) return;
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const button = (text, id, onclick, extra = '') => el('button', { type: 'button', className: `lcars-button lcars-button--pill ${extra}`, id, textContent: text, onclick });
  const changed = (node, ...state) => { const sig = JSON.stringify(state); if (node.dataset.sig === sig) return false; node.dataset.sig = sig; return true; };
  const NAMES = Object.fromEntries(POWER);
  combatAt = Date.now();

  // Warnings on every console aboard; a weapons lock on us for Tactical and the Captain.
  bc.setAlert('fire', c.underFire ? `Taking fire from the ${c.underFire} · shields ${lastNav.own && ownShip()?.shields ? `${c.shield}%` : 'down'} · hull ${c.hull}%` : null);
  bc.setAlert('disabled', c.disabled ? `Hull breached: the ${me.ship} is disabled until repaired (hull ${c.hull}%, 10% needed)` : null);
  bc.setAlert('locked', c.lockedBy.length && ['Tactical', 'Captain'].includes(me.station) ? `Weapons lock: the ${c.lockedBy.join(', the ')} ${c.lockedBy.length > 1 ? 'have' : 'has'} locked on us` : null, { level: 'yellow' });
  if (!stationView) return;

  // Tactical: target, lock, fire.
  const wp = document.querySelector('[data-weapons]');
  if (wp) {
    if (!wp.firstChild) {
      const sel = el('select', { className: 'ops-select', id: 'weapons-target', ariaLabel: 'target' });
      wp.append(
        el('div', { className: 'ops-form' }, el('span', { textContent: 'Target' }), sel,
          button('Lock weapons', 'weapons-lock', () => sel.value && send({ type: 'lock', ship: sel.value }), 'lcars-button--alert'),
          button('Release', 'weapons-release', () => send({ type: 'lock', ship: null }))),
        el('p', { className: 'st-state', id: 'weapons-lock-state' }),
        el('div', { className: 'ops-form wp-fire' },
          button('Fire phasers', 'fire-phaser', () => send({ type: 'fire', weapon: 'phaser' }), 'lcars-button--alert'),
          button('Fire torpedo', 'fire-torpedo', () => send({ type: 'fire', weapon: 'torpedo' }), 'lcars-button--alert')),
        el('div', { className: 'ops-readouts' },
          el('div', { className: 'lcars-readout', id: 'wp-phasers' }), el('div', { className: 'lcars-readout', id: 'wp-torpedoes' })),
        el('p', { className: 'ops-notice', id: 'weapons-status' }),
        el('p', { className: 'ops-hint', textContent: `Phasers reach ${c.phaser.range} units, hit harder with more weapons power, and recharge in ${c.phaser.recharge / 1000} s. Torpedoes reach ${c.torpedo.range} units and reload in ${c.torpedo.reload / 1000} s; ${c.carried} carried, restocked one a minute. Shields soak hits until they fail; then the hull and systems take damage.` }));
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
    lockState.textContent = c.disabled ? 'Ship disabled: weapons offline'
      : c.lock ? `Locked on the ${c.lock.name} · ${c.lock.distance} units · shields ${c.lock.shields ? `up, ${c.lock.shield}%` : 'down'} · hull ${c.lock.hull}%${c.lock.disabled ? ' · disabled' : ''}` : 'No weapons lock';
    lockState.toggleAttribute('data-up', !!c.lock);
    wp.querySelector('#weapons-release').disabled = !c.lock;
    updateWeaponTimers();
  }

  // Engineering: damage and repair crews.
  const dc = document.querySelector('[data-damage]');
  if (dc && changed(dc, c.hull, c.damage, c.repair, c.disabled, own.power, own.allocated)) {
    const status = dc.querySelector('#damage-status')?.textContent || '';
    const row = (key, label, value, note) => el('li', { className: 'dc-row' },
      el('span', { className: 'dc-label', textContent: label }),
      el('span', { className: 'dc-value', textContent: value }),
      el('span', { className: 'dc-note', textContent: note }),
      c.repair === key ? button('Directing repairs', '', () => send({ type: 'repair', system: null }), 'dc-active')
        : button('Direct repairs', '', () => send({ type: 'repair', system: key }), (key === 'hull' ? c.hull < 100 : c.damage[key] > 0) ? 'lcars-button--alert' : ''));
    dc.replaceChildren(
      el('ul', { className: 'st-list dc-list' },
        row('hull', 'Hull', `${c.hull}%`, c.disabled ? 'Breached: ship disabled' : c.hull < 100 ? 'Damaged' : 'Intact'),
        ...POWER.map(([k, label]) => row(k, label, c.damage[k] ? `${c.damage[k]}% damaged` : 'Operational',
          own.power[k] < own.allocated[k] ? `gets ${own.power[k]}% of ${own.allocated[k]}% routed` : `${own.power[k]}%`))),
      el('p', { className: 'ops-notice', id: 'damage-status', textContent: status }),
      el('p', { className: 'ops-hint', textContent: 'Damage caps what a system can draw. Repair crews fix everything slowly; directed to one system (or the hull) they fix it six to ten times faster.' }));
    for (const li of dc.querySelectorAll('.dc-row')) li.dataset.system = li.querySelector('.dc-label').textContent;
  }

  // Captain: the ship's real status.
  const ss = document.querySelector('[data-ship-status]');
  if (ss) {
    const up = !!ownShip()?.shields;
    const damaged = POWER.filter(([k]) => c.damage[k] > 0).map(([k]) => NAMES[k].toLowerCase());
    const speed = own.warp <= 0 ? 'All stop' : own.warp < 1 ? 'Impulse' : `Warp ${+own.warp.toFixed(1)}`;
    const items = [
      ['Alert status', own.alert && own.alert !== 'green' ? `${own.alert[0].toUpperCase()}${own.alert.slice(1)} alert` : 'Condition green', 'sky'],
      ['Shields', `${up ? 'Up' : 'Down'} · ${c.shield}%`, 'sky'],
      ['Hull integrity', `${c.hull}%${c.disabled ? ' · disabled' : ''}`, 'gold'],
      ['Velocity', speed, 'orange'],
      ['Weapons', c.lock ? `Locked: the ${c.lock.name}` : 'Standby', 'red'],
      ['Damage', damaged.length ? damaged.join(', ') : 'None', 'peach'],
    ];
    if (changed(ss, items)) {
      ss.replaceChildren(el('div', { className: 'ops-readouts' }, ...items.map(([label, value, color]) => {
        const r = el('div', { className: 'lcars-readout' }, el('span', { className: 'lcars-readout__label', textContent: label }), el('span', { className: 'lcars-readout__value', textContent: value }));
        r.style.setProperty('--accent', `var(--lcars-${color})`);
        r.dataset.readout = label;
        return r;
      })));
    }
  }
}

// Phaser charge and torpedo reload, counted down between updates.
function updateWeaponTimers() {
  const wp = document.querySelector('[data-weapons]');
  const c = lastNav?.own?.combat;
  if (!wp?.firstChild || !c) return;
  const since = Date.now() - combatAt;
  const left = (w) => Math.max(0, w.ready - since);
  const noPower = (ownPower()?.weapons ?? 0) <= 0;
  const ph = left(c.phaser), tp = left(c.torpedo);
  const set = (id, label, value) => wp.querySelector(id).replaceChildren(
    Object.assign(document.createElement('span'), { className: 'lcars-readout__label', textContent: label }),
    Object.assign(document.createElement('span'), { className: 'lcars-readout__value', textContent: value }));
  set('#wp-phasers', 'Phasers', c.disabled || noPower ? 'Offline' : ph ? `Charging ${Math.round((1 - ph / c.phaser.recharge) * 100)}%` : `Ready · ${ownPower().weapons}% power`);
  set('#wp-torpedoes', 'Photon torpedoes', `${c.torpedoes} of ${c.carried}${tp ? ' · reloading' : ''}`);
  const blocked = !c.lock || c.disabled || noPower;
  wp.querySelector('#fire-phaser').disabled = blocked || ph > 0 || c.lock.distance > c.phaser.range;
  wp.querySelector('#fire-torpedo').disabled = blocked || tp > 0 || !c.torpedoes || c.lock.distance > c.torpedo.range;
}
setInterval(updateWeaponTimers, 250);

// Engineering: route the reactor's output. Sliders per system (0-100%), the
// total against the reactor, and what the settings mean for the ship.
let powerDraft = null; // Engineering's unsent changes
const ownAllocation = () => lastNav?.own?.allocated || ownPower();
function renderPower() {
  const root = document.querySelector('[data-power]');
  const p = ownAllocation();
  if (!root || !p) return;
  const reactor = lastNav.own.reactor || 450;
  const draft = powerDraft || { ...p };
  const total = POWER.reduce((n, [k]) => n + draft[k], 0);
  const f = draft.sensors / 100;
  const warp = draft.engines <= 0 ? 0 : Math.max(0.25, Math.round((draft.engines / 100) * 90) / 10);
  if (!root.firstChild) {
    root.append(
      ...POWER.map(([k, label]) => {
        const row = document.createElement('label');
        row.className = 'pw-row';
        row.innerHTML = `<span class="pw-label">${label}</span><input type="range" min="0" max="100" step="5" class="pw-slider" data-system="${k}" aria-label="${label} power"><b class="pw-value"></b>`;
        row.querySelector('input').oninput = (e) => { powerDraft = { ...(powerDraft || ownAllocation()), [k]: Number(e.target.value) }; renderPower(); };
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
    const input = root.querySelector(`[data-system="${k}"]`);
    if (document.activeElement !== input) input.value = draft[k];
    input.parentElement.querySelector('.pw-value').textContent = `${draft[k]}%`;
  }
  const over = total > reactor;
  root.querySelector('.pw-total').textContent = `Reactor ${total}% of ${reactor}%${over ? ': over capacity' : ''}${powerDraft ? ' · not routed yet' : ''}`;
  root.querySelector('.pw-total').toggleAttribute('data-over', over);
  root.querySelector('.pw-effects').replaceChildren(...[
    `Top speed: ${warp <= 0 ? 'none (no engine power)' : warp < 1 ? 'impulse' : `warp ${warp}`}`,
    `Sensors ${Math.round(600 * f)} · subspace ${Math.round(400 * f)} · transporter ${Math.round(20 * f)} units`,
    draft.shields < 20 ? 'Shields: too little power to hold them' : 'Shields: can be raised',
    draft.transporter <= 0 ? 'Transporter: no power' : 'Transporter: ready',
    draft.lifeSupport < 50 ? `Life support: ${draft.lifeSupport}%, crew warned` : 'Life support: nominal',
    // The more power the ship uses, the further off other ships' sensors see it.
    `Power signature ${Math.round(Math.min(1, Math.max(0.1, total / reactor)) * 100)}%: seen from ${Math.round(600 * Math.min(1, Math.max(0.1, total / reactor)))} units by full sensors${total / reactor < 0.6 ? ' (running quiet)' : ''}`,
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
    const st = document.getElementById(msg.text.startsWith('Tactical') ? 'weapons-status' : 'damage-status');
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
      me = { id: msg.id, name: msg.name, ship: msg.ship, station: msg.station };
      token = msg.token;
      if (ops) hideOps();
      queueMicrotask(() => comms.radio?.render());
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
  if (me) $('new-station').replaceChildren(...stations.filter((n) => n !== me.station).map((n) => new Option(n, n)));
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
$('new-station').onchange = () => { $('reassign-key').hidden = $('new-station').value !== 'Operations' || !opsKeyRequired; };
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
window.__broadcast = bc;
window.__nav = { get last() { return lastNav; } };
window.__operator = new Proxy({}, { get: (_, k) => ops?.[k] });
window.__voice = Object.create(comms.voice, {
  myName: { get: () => me?.name },
  me: { get: () => me },
  token: { get: () => token },
});
