// Operator console (LCARS styled) for one ship's ops station. The operator is
// aboard as crew at the Operations station and has the same Comms menu as
// everyone (comms.js): call anyone aboard or on the data network, take calls,
// plus Transfer, to hand a call to someone else (or another ship). The console
// also manages this ship's crew (intercom, patch in, disconnect), ship-to-ship
// hails (hail another ship for someone, route incoming hails to someone
// aboard, themselves included), data links with other ships, and the ship's
// Library. One screen at a time (screens.js), so the console fits the window.
let token = null;
let ws, me = null, ship = '', roster = [], ships = [], incoming = [], outgoing = [];
let links = [], network = [], linkIncoming = [], linkOutgoing = [];

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

function log(text, level) {
  $('log').prepend(el('li', { className: 'lcars-log__line' + (level ? ` lcars-log__line--${level}` : ''), textContent: `${stardate()} · ${text}` }));
  console.log(text);
}

function setLink(status, text) {
  $('link').dataset.status = status;
  $('link').textContent = text;
}

const send = (msg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

const comms = createComms({
  send,
  me: () => me,
  log: (text) => log(text),
  button: $('comms-button'),
  extras: $('transfer-form'),
  onChange: () => render(),
});
const voice = comms.voice;
const library = createLibrary($('library-view'), { token: () => token, base: relay.http, log: (text) => log(text) });

function signIn(name, shipName, key) {
  setLink('connecting', 'Subspace link: connecting');
  try {
    ws = new WebSocket(relay.ws());
  } catch {
    $('login-error').textContent = 'That comm relay address is not valid';
    $('login-form').querySelector('button').disabled = false;
    return;
  }
  ws.onopen = () => send({ type: 'operator', name, ship: shipName, key });
  // Handle messages one at a time so ICE candidates never race ahead of the SDP.
  let queue = Promise.resolve();
  ws.onmessage = (ev) => { queue = queue.then(() => onMessage(JSON.parse(ev.data))).catch((err) => log(`error: ${err}`, 'error')); };
  ws.onclose = () => {
    if ($('console').hidden) {
      if (!me) { $('login-error').textContent = `Comm relay unreachable: ${relay.address()}`; $('login-form').querySelector('button').disabled = false; }
      return;
    }
    setLink('error', 'Subspace link lost');
    $('status').textContent = 'Link to comm relay lost. Reload to reconnect.';
    log('link to comm relay lost', 'error');
  };
}

async function onMessage(msg) {
  if (await comms.handle(msg)) {
    if (msg.type === 'users') render(); // transfer targets span the data network
    return;
  }
  switch (msg.type) {
    case 'operator-ok':
      me = { id: msg.id, name: msg.name, ship: msg.ship, station: msg.station };
      token = msg.token;
      ship = msg.ship;
      $('login').hidden = true;
      $('login-error').textContent = '';
      $('console').hidden = false;
      $('comms-button').hidden = false;
      for (const tab of document.querySelectorAll('[data-screen-tab]')) tab.hidden = false;
      showScreen('status');
      $('ship-name').textContent = `Ops · ${ship}`;
      document.title = `Ops: ${ship}`;
      setLink('online', 'Subspace link online');
      log(`${me.name} has the ops station aboard the ${ship}`);
      try { localStorage.setItem('ops-ship', ship); localStorage.setItem('ops-name', me.name); } catch {}
      break;
    case 'operator-failed':
      $('login-error').textContent = `Access denied: ${msg.reason}`;
      $('login').hidden = false;
      $('login-form').querySelector('button').disabled = false;
      setLink('error', 'Clearance required');
      ws.onclose = null;
      ws.close();
      break;
    case 'roster':
      logRosterChanges(roster, msg.users);
      logShipChanges(ships, msg.ships);
      ({ users: roster, ships, incoming, outgoing, links, network, linkIncoming, linkOutgoing } = msg);
      render();
      break;
    case 'op-ok':
      $('status').textContent = msg.text;
      log(msg.text);
      break;
    case 'library':
      library.render(msg);
      break;
    case 'ships': {
      const own = msg.ships.find((s) => s.name.toLowerCase() === ship.toLowerCase());
      $('shield-state').textContent = own?.shields ? 'Up' : 'Down';
      break;
    }
    case 'op-log':
      log(msg.text, 'warn');
      break;
    case 'op-error':
      $('status').replaceChildren(el('span', { className: 'error', textContent: `Unable to comply: ${msg.reason}` }));
      log(`unable to comply: ${msg.reason}`, 'warn');
      break;
  }
}

// Note arrivals and departures in the comm log (not on the first roster).
let firstRoster = true;
function logRosterChanges(before, after) {
  if (firstRoster) return;
  const was = new Map(before.map((u) => [u.id, u]));
  const now = new Map(after.map((u) => [u.id, u]));
  for (const [id, u] of now) if (!was.has(id)) log(`${u.name} (${u.station}) reported aboard`);
  for (const [id, u] of was) if (!now.has(id)) log(`${u.name} left the comm net`, 'warn');
}
function logShipChanges(before, after) {
  if (firstRoster) { firstRoster = false; return; }
  for (const s of after) if (!before.includes(s)) log(`the ${s} is in range`);
  for (const s of before) if (!after.includes(s)) log(`lost contact with the ${s}`, 'warn');
}

// "Martok (Captain, K'Vatch)": the ship only when it isn't ours.
const label = (u) => `${u.name} (${u.station}${u.ship && u.ship.toLowerCase() !== ship.toLowerCase() ? `, ${u.ship}` : ''})`;

function describe(u) {
  switch (u.state) {
    case 'calling': return `calling ${label(u.peers[0])}`;
    case 'ringing': return `incoming call from ${label(u.peers[0])}`;
    case 'in-call': return `in call with ${u.peers.map(label).join(', ')}`;
    default: return 'standing by';
  }
}

function render() {
  // Transfer (in the Comms modal) shows while you are in a call: anyone
  // aboard or on the data network, or a hail to a ship off the network.
  const inMyCall = voice.state === 'in-call';
  $('transfer-form').hidden = !inMyCall;
  if (inMyCall) {
    const peers = new Set(voice.call.peers.keys());
    const sel = $('transfer-to');
    const keep = sel.value;
    const people = comms.users.filter((u) => u.id !== me.id && !peers.has(u.id))
      .sort((a, b) => (b.ship === ship) - (a.ship === ship) || a.ship.localeCompare(b.ship) || a.name.localeCompare(b.name));
    sel.replaceChildren(
      ...people.map((u) => new Option(u.ship === ship ? `${u.name} · ${u.station}` : `${u.name} · ${u.station} · ${u.ship}`, u.id)),
      ...(peers.size === 1 ? ships.filter((s) => !network.includes(s)).map((s) => new Option(`The ${s} (hail)`, `ship:${s}`)) : []));
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    $('transfer-form').querySelector('button').disabled = !sel.options.length;
  }

  // Data link
  $('network').textContent = network.length ? `Data network: ${[ship, ...network].join(' · ')}` : 'Not linked';
  const linkList = $('links');
  linkList.replaceChildren(...(links.length ? links.map((s) => el('li', { className: 'ops-hail' },
    el('span', { className: 'ops-hail__text', textContent: `Linked with the ${s}` }),
    el('button', { className: 'lcars-button lcars-button--pill lcars-button--alert', textContent: 'Close link',
      onclick: () => send({ type: 'link-close', ship: s }) }))) : [el('li', { className: 'empty', textContent: 'No open links' })]));
  const reqList = $('link-requests');
  reqList.replaceChildren(
    ...linkIncoming.map((r) => el('li', { className: 'ops-hail ops-hail--incoming' },
      el('span', { className: 'ops-hail__text', textContent: `The ${r.fromShip} requests a data link` }),
      el('button', { className: 'lcars-button lcars-button--pill', textContent: 'Accept', onclick: () => send({ type: 'link-accept', request: r.id }) }),
      el('button', { className: 'lcars-button lcars-button--pill lcars-button--alert', textContent: 'Decline', onclick: () => send({ type: 'link-decline', request: r.id }) }))),
    ...linkOutgoing.map((r) => el('li', { className: 'ops-hail' },
      el('span', { className: 'ops-hail__text', textContent: `Requesting a data link with the ${r.toShip}` }),
      el('button', { className: 'lcars-button lcars-button--pill lcars-button--alert', textContent: 'Withdraw', onclick: () => send({ type: 'link-cancel', request: r.id }) }))));
  if (!reqList.children.length) reqList.append(el('li', { className: 'empty', textContent: 'No link requests' }));
  const linkable = ships.filter((s) => !links.includes(s));
  const linkSel = $('link-ship');
  const keepLink = linkSel.value;
  linkSel.replaceChildren(...linkable.map((s) => new Option(s, s)));
  if (linkable.includes(keepLink)) linkSel.value = keepLink;
  $('link-form').querySelector('button').disabled = !linkable.length;

  // Roster
  const body = $('roster');
  body.replaceChildren();
  if (!roster.length) body.append(el('tr', { className: 'empty' }, el('td', { colSpan: 4, textContent: 'No crew on the comm net' })));
  for (const u of roster) {
    const actions = el('td');
    const isMe = u.id === me?.id;
    if (!isMe && voice.state === 'idle') {
      actions.append(el('button', {
        className: 'lcars-button lcars-button--pill',
        textContent: 'Call',
        onclick: () => voice.placeCall(u),
      }), ' ');
    }
    if (u.state !== 'idle') {
      actions.append(el('button', {
        className: 'lcars-button lcars-button--pill lcars-button--alert',
        textContent: 'Disconnect',
        onclick: () => send({ type: 'end', name: u.id }),
      }));
    }
    const pending = outgoing.find((h) => h.caller.id === u.id);
    const channel = pending && u.state === 'idle' ? `awaiting the ${pending.toShip}` : describe(u);
    body.append(el('tr', {},
      el('td', { textContent: isMe ? `${u.name} (you)` : u.name }),
      el('td', { textContent: u.station }),
      el('td', { textContent: channel, className: u.state === 'idle' ? (pending ? 'ringing' : 'idle') : u.state === 'in-call' ? 'busy' : 'ringing' }),
      actions));
  }

  // Hail queues
  const hailList = (ul, hails, kind) => {
    ul.replaceChildren();
    if (!hails.length) { ul.append(el('li', { className: 'empty', textContent: kind === 'in' ? 'No incoming hails' : 'No outgoing hails' })); return; }
    for (const h of hails) {
      const li = el('li', { className: `ops-hail ops-hail--${kind === 'in' ? 'incoming' : 'outgoing'}` });
      if (kind === 'in') {
        const pick = el('select', { className: 'ops-select', ariaLabel: 'route hail to' }, ...roster.map((u) => new Option(label(u), u.id)));
        const captain = roster.find((u) => u.station === 'Captain');
        if (captain) pick.value = captain.id;
        li.append(
          el('span', { className: 'ops-hail__text', textContent: `The ${h.fromShip} is hailing: ${label(h.caller)}` }),
          el('span', { textContent: 'route to' }), pick,
          el('button', { className: 'lcars-button lcars-button--pill', textContent: 'Route', disabled: !roster.length,
            onclick: () => send({ type: 'route', hail: h.id, to: pick.value }) }),
          el('button', { className: 'lcars-button lcars-button--pill lcars-button--alert', textContent: 'Decline',
            onclick: () => send({ type: 'decline-hail', hail: h.id }) }));
      } else {
        li.append(
          el('span', { className: 'ops-hail__text', textContent: `Hailing the ${h.toShip} for ${h.caller.name}` }),
          el('button', { className: 'lcars-button lcars-button--pill lcars-button--alert', textContent: 'Cancel',
            onclick: () => send({ type: 'cancel-hail', hail: h.id }) }));
      }
      ul.append(li);
    }
  };
  hailList($('incoming'), incoming, 'in');
  hailList($('outgoing'), outgoing, 'out');

  // Readouts. A channel is a group of people in a call together.
  const inCall = roster.filter((u) => u.state === 'in-call');
  const channels = new Set(inCall.map((u) => [u.id, ...u.peers.map((p) => p.id)].sort().join('|')));
  $('count-online').textContent = roster.length;
  $('count-channels').textContent = channels.size;
  $('count-idle').textContent = roster.filter((u) => u.state === 'idle').length;
  $('count-ships').textContent = ships.length;

  // Pickers
  fillSelect('a', roster, 0);
  fillSelect('b', roster, 1);
  if ($('a').value === $('b').value) {
    const other = roster.find((u) => u.id !== $('a').value);
    if (other) $('b').value = other.id;
  }
  fillSelect('newcomer', roster, roster.findIndex((u) => u.state !== 'in-call'));
  fillSelect('host', inCall, 0);
  fillSelect('hail-crew', roster, Math.max(0, roster.findIndex((u) => u.station === 'Captain')));
  const shipSel = $('hail-ship');
  const keepShip = shipSel.value;
  shipSel.replaceChildren(...ships.map((s) => new Option(s, s)));
  if (ships.includes(keepShip)) shipSel.value = keepShip;
  $('connect-form').querySelector('button').disabled = roster.length < 2;
  $('add-form').querySelector('button').disabled = !inCall.length || roster.length < 2;
  $('hail-form').querySelector('button').disabled = !ships.length || !roster.length;
}

// Refill a crew <select> (value = user id), keeping the current pick if still listed.
function fillSelect(id, users, fallback) {
  const sel = $(id);
  const keep = sel.value;
  sel.replaceChildren(...users.map((u) => new Option(`${u.name} · ${u.station}`, u.id)));
  if (users.some((u) => u.id === keep)) sel.value = keep;
  else if (users[fallback]) sel.value = users[fallback].id;
}

// Same display "stardate" as the LCARS base shell: year offset plus fraction of the year.
function stardate() {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), 0, 1);
  const end = Date.UTC(now.getUTCFullYear() + 1, 0, 1);
  return ((now.getUTCFullYear() - 1946) * 1000 + ((now - start) / (end - start)) * 1000).toFixed(1);
}
const tick = () => { $('stardate').textContent = `Stardate ${stardate()}`; };
tick();
setInterval(tick, 1000);

const action = (form, build) => {
  $(form).onsubmit = (e) => {
    e.preventDefault();
    $('status').textContent = '';
    send(build());
  };
};
action('connect-form', () => ({ type: 'connect', a: $('a').value, b: $('b').value }));
action('add-form', () => ({ type: 'add', name: $('newcomer').value, into: $('host').value }));
action('hail-form', () => ({ type: 'hail', ship: $('hail-ship').value, crew: $('hail-crew').value }));
action('link-form', () => ({ type: 'link-request', ship: $('link-ship').value }));
action('transfer-form', () => {
  const v = $('transfer-to').value;
  return v.startsWith('ship:') ? { type: 'transfer', ship: v.slice(5) } : { type: 'transfer', to: v };
});

$('login-form').onsubmit = (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  $('login-form').querySelector('button').disabled = true;
  if ($('relay').value.trim() !== relay.address() && !relay.set($('relay').value)) {
    $('login-error').textContent = 'That comm relay address is not valid';
    $('login-form').querySelector('button').disabled = false;
    return;
  }
  signIn($('op-name').value.trim(), $('ship').value.trim(), $('key').value);
};

// Ops is assumed to be on the bridge; it needs the operator's name and the ship.
// Both can also come from the URL (?name=O'Brien&ship=Enterprise) or the last sign-in here.
let savedShip = new URLSearchParams(location.search).get('ship') || '';
let savedName = new URLSearchParams(location.search).get('name') || '';
try { savedShip ||= localStorage.getItem('ops-ship') || ''; savedName ||= localStorage.getItem('ops-name') || ''; } catch {}
$('ship').value = savedShip;
$('op-name').value = savedName;
$('relay').value = relay.address();
showScreen('login');
setLink('error', 'Ops station offline');

// Exposed for the headless test: the ops console's own calls, like the crew page.
window.__comms = comms;
window.__voice = Object.create(voice, {
  myName: { get: () => me?.name },
  me: { get: () => me },
});
window.__operator = {
  get roster() { return roster; },
  get ships() { return ships; },
  get incoming() { return incoming; },
  get outgoing() { return outgoing; },
  get links() { return links; },
  get network() { return network; },
  get linkIncoming() { return linkIncoming; },
};
