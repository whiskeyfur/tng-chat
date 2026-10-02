// Ops console screens, shown in the same console page when someone signs in at
// the Operations station: channel status and the comm log, ship-to-ship hails,
// data links, intercom and conference, and the crew roster. The operator is
// aboard as crew too, so calls go through the shared Comms modal (comms.js),
// with an extra Transfer control while in a call.
//
// const ops = createOps({ send, comms, me });
// ops.handle(msg)  // ops messages from the relay; true if handled
// ops.render()     // redraw (call state changed, directory changed)
(function () {
  // A tap keypad for a 5-digit command prefix (no text field): digits, Clear and
  // the action button; the entry shows masked. onEnter(code) with 5 digits.
  window.makeKeypad = function makeKeypad(id, action, onEnter) {
    let code = '';
    const shown = Object.assign(document.createElement('span'), { className: 'keypad-shown', id: `${id}-shown`, textContent: '-----' });
    const key = (text, onclick, cls = '') => Object.assign(document.createElement('button'), { type: 'button', className: `lcars-button lcars-button--pill tr-tap ${cls}`, textContent: text, onclick });
    const show = () => { shown.textContent = '•'.repeat(code.length) + '-'.repeat(5 - code.length); go.disabled = code.length !== 5; };
    const go = key(action, () => { if (code.length === 5) { onEnter(code); code = ''; show(); } });
    go.id = `${id}-enter`;
    const pad = Object.assign(document.createElement('div'), { className: 'keypad', id });
    pad.append(shown, ...'1234567890'.split('').map((d) => { const b = key(d, () => { if (code.length < 5) code += d; show(); }); b.dataset.digit = d; return b; }), key('Clear', () => { code = ''; show(); }), go);
    show();
    pad.reset = () => { code = ''; show(); };
    return pad;
  };
  window.createOps = function createOps({ send, comms, me: getMe }) {
    const $ = (id) => document.getElementById(id);
    const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
    const voice = comms.voice;
    let roster = [], ships = [], incoming = [], outgoing = [];
    let linkShips = []; // ships a data link can reach (the whole system over subspace)
    let links = [], hardLinks = [], network = [], linkIncoming = [], linkOutgoing = [];
    let graph = { ships: [], links: [], requests: [] };
    let broadcasts = [];
    let me = getMe(), ship = me.ship;

    function stardate() {
      const now = new Date();
      const start = Date.UTC(now.getUTCFullYear(), 0, 1);
      const end = Date.UTC(now.getUTCFullYear() + 1, 0, 1);
      return ((now.getUTCFullYear() - 1946) * 1000 + ((now - start) / (end - start)) * 1000).toFixed(1);
    }

    function log(text, level) {
      $('ops-log').prepend(el('li', { className: 'lcars-log__line' + (level ? ` lcars-log__line--${level}` : ''), textContent: `${stardate()} · ${text}` }));
      console.log(text);
    }

    function handle(msg) {
      switch (msg.type) {
        case 'roster':
          logRosterChanges(roster, msg.users);
          logShipChanges(ships, msg.ships);
          ({ users: roster, ships, incoming, outgoing, links, network, linkIncoming, linkOutgoing } = msg);
          hardLinks = msg.hardLinks || [];
          linkShips = msg.linkShips || ships;
          graph = msg.graph || graph;
          broadcasts = msg.broadcasts || [];
          remoteBlock = !!msg.remoteBlock;
          renderDrydock(msg.drydock, msg.berths);
          renderPrefix(msg.prefix);
          renderAutomation(msg.automation);
          render();
          return true;
        case 'op-ok':
          $('status').textContent = msg.text;
          log(msg.text);
          return true;
        case 'op-log':
          log(msg.text, 'warn');
          return true;
        case 'op-error':
          $('status').replaceChildren(el('span', { className: 'error', textContent: `Unable to comply: ${msg.reason}` }));
          log(`unable to comply: ${msg.reason}`, 'warn');
          return true;
        case 'ships': {
          const own = msg.ships.find((s) => s.name.toLowerCase() === ship.toLowerCase());
          $('shield-state').textContent = own?.shields ? 'Up' : 'Down';
          return false; // the page uses the ship list too
        }
      }
      return false;
    }

    // Automation: per panel, on or off (Engineering: Startup or Shutdown), and what it's doing.
    function renderAutomation(list) {
      const ul = document.getElementById('automation-list');
      if (!ul || !list) return;
      const tap = (text, on, msg) => { const b = el('button', { type: 'button', className: 'lcars-button lcars-button--pill tr-tap', textContent: text, onclick: () => send({ type: 'automation', ...msg }) }); b.setAttribute('aria-pressed', String(!!on)); return b; };
      ul.replaceChildren(...placeNodes(list, (a) => a.station, (a) => {
        const taps = a.panel === 'engineering'
          ? [tap('Off', !a.on, { panel: a.panel, mode: null }), tap('Startup', a.on === 'startup', { panel: a.panel, mode: 'startup' }), tap('Shutdown', a.on === 'shutdown', { panel: a.panel, mode: 'shutdown' })]
          : [tap(a.on ? 'Auto: on' : 'Auto: off', a.on, { panel: a.panel, on: !a.on })];
        if (!a.built) for (const t of taps) { t.disabled = true; t.title = 'coming next'; }
        const li = el('li', { className: 'ops-hail' }, el('span', { className: 'ops-hail__text', textContent: `${a.name} (${a.station})${!a.built ? ' · coming next' : a.on ? ` · ${a.status || 'running'}` : a.status ? ` · ${a.status}` : ''}` }), ...taps);
        li.dataset.panel = a.panel;
        return li;
      }, 'li'));
    }

    // The command prefix: masked (tap Show to see it), set on a keypad.
    let prefix = null, revealed = false;
    const prefixBox = document.getElementById('prefix-box');
    if (prefixBox) {
      // (The page can make the ops console more than once, signing in again: replace whichever is there.)
      prefixBox.querySelector('#prefix-pad-slot, #prefix-pad')?.replaceWith(makeKeypad('prefix-pad', 'Set prefix', (code) => send({ type: 'prefix', code })));
      document.getElementById('prefix-reveal').onclick = () => { revealed = !revealed; renderPrefix(prefix); };
    }
    function renderPrefix(p) {
      if (!prefixBox) return;
      prefix = p ?? prefix;
      prefixBox.hidden = prefix == null;
      document.getElementById('prefix-show').textContent = prefix == null ? '' : revealed ? prefix : '•••••';
      document.getElementById('prefix-reveal').textContent = revealed ? 'Hide' : 'Show';
    }

    // The shipyard's drydock: each ship in it, its release (if requested) and our hold.
    function renderDrydock(list, berths) {
      const box = document.getElementById('drydock');
      if (!box) return;
      box.hidden = !list;
      if (!list) return;
      box.querySelector('h3').textContent = `Drydock (${list.length} of ${berths} berths)`;
      $('drydock-list').replaceChildren(...(list.length ? list.map((d) => {
        const li = el('li', { className: 'ops-hail' }, el('span', { className: 'ops-hail__text', textContent: `The ${d.ship}${d.release != null ? ` · release in ${d.release} s` : ''}${d.hold ? ' · HELD' : ''}${d.repair ? ` · repairing ${d.repair}` : ''}` }),
          el('button', { className: 'lcars-button lcars-button--pill', textContent: 'Release now', onclick: () => send({ type: 'drydock', ship: d.ship, action: 'release' }) }),
          el('button', { className: `lcars-button lcars-button--pill${d.hold ? '' : ' lcars-button--alert'}`, textContent: d.hold ? 'Stop holding' : 'Hold', onclick: () => send({ type: 'drydock', ship: d.ship, action: d.hold ? 'unhold' : 'hold' }) }));
        li.dataset.ship = d.ship;
        return li;
      }) : [el('li', { className: 'empty', textContent: 'No ships in drydock' })]));
    }

    // Remote control of our stations by other vessels: allowed or blocked.
    let remoteBlock = false;
    const blockBtn = document.getElementById('remote-block');
    if (blockBtn) blockBtn.onclick = () => send({ type: 'remote-block', on: !remoteBlock });
    function renderRemoteBlock() {
      if (!blockBtn) return;
      blockBtn.textContent = remoteBlock ? 'Remote control: blocked' : 'Remote control: allowed';
      blockBtn.setAttribute('aria-pressed', String(remoteBlock));
      blockBtn.classList.toggle('lcars-button--alert', remoteBlock);
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

    // The data network map: every ship around a circle (ours at the top),
    // solid lines for data links, dashed for pending requests. Clicking a
    // ship picks it in the "request a data link" form.
    function renderMap() {
      const svg = $('net-map');
      if (!svg) return;
      const NS = 'http://www.w3.org/2000/svg';
      const node = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
      const color = (n) => `var(--lcars-${n})`;
      const own = ship.toLowerCase();
      const onNet = new Set([own, ...network.map((n) => n.toLowerCase())]);
      const list = [...graph.ships].sort((a, b) => (b.name.toLowerCase() === own) - (a.name.toLowerCase() === own) || a.name.localeCompare(b.name));
      const W = 600, H = 400, cx = W / 2, cy = H / 2, NH = 52;
      const widthOf = (sh) => Math.max(120, sh.name.length * 11 + 36);
      // A force-directed layout: our own ship pinned at the centre; every vessel
      // pushes the others away (so labels never overlap), open data links pull
      // their two ends together; unlinked vessels drift outward but stay inside.
      // Positions are kept between refreshes, so the picture settles and stays put.
      const keys = list.map((sh) => sh.name.toLowerCase());
      for (const k of [...layout.keys()]) if (!keys.includes(k)) layout.delete(k);
      list.forEach((sh, i) => {
        const k = sh.name.toLowerCase();
        if (!layout.has(k)) { const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, list.length); layout.set(k, { x: cx + 160 * Math.cos(a), y: cy + 120 * Math.sin(a) }); }
        layout.get(k).w = widthOf(sh);
      });
      if (layout.has(own)) Object.assign(layout.get(own), { x: cx, y: cy });
      const linked = graph.links.map(([a, b]) => [a.toLowerCase(), b.toLowerCase()]).filter(([a, b]) => layout.has(a) && layout.has(b));
      const nodes = [...layout.entries()];
      for (let it = 0, n = settled ? 40 : 300; it < n; it++) {
        const f = new Map(nodes.map(([k]) => [k, { x: 0, y: 0 }]));
        for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
          const [ka, p] = nodes[i], [kb, q] = nodes[j];
          let dx = p.x - q.x, dy = p.y - q.y;
          if (!dx && !dy) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; }
          const d = Math.hypot(dx, dy), want = (p.w + q.w) / 2 + 30, rep = (want * want) / Math.max(d, 1) * 0.05;
          f.get(ka).x += (dx / d) * rep; f.get(ka).y += (dy / d) * rep * 1.6;
          f.get(kb).x -= (dx / d) * rep; f.get(kb).y -= (dy / d) * rep * 1.6;
        }
        for (const [a, b] of linked) {
          const p = layout.get(a), q = layout.get(b), dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1, pull = (d - 170) * 0.05;
          f.get(a).x += (dx / d) * pull; f.get(a).y += (dy / d) * pull; f.get(b).x -= (dx / d) * pull; f.get(b).y -= (dy / d) * pull;
        }
        for (const [k, p] of nodes) {
          if (k === own) continue;
          const v = f.get(k), step = Math.min(12, Math.hypot(v.x, v.y)), m = Math.hypot(v.x, v.y) || 1;
          p.x = Math.max(p.w / 2 + 4, Math.min(W - p.w / 2 - 4, p.x + (v.x / m) * step));
          p.y = Math.max(NH / 2 + 4, Math.min(H - NH / 2 - 4, p.y + (v.y / m) * step));
        }
      }
      // (Then any labels still touching, pushed apart: no overlaps.)
      for (let pass = 0; pass < 60; pass++) {
        let moved = false;
        for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
          const [ka, p] = nodes[i], [kb, q] = nodes[j], ox = (p.w + q.w) / 2 + 6 - Math.abs(p.x - q.x), oy = NH + 6 - Math.abs(p.y - q.y);
          if (ox <= 0 || oy <= 0) continue;
          const d = (oy / 2 + 1) * (p.y <= q.y ? -1 : 1);
          if (ka !== own) p.y = Math.max(NH / 2, Math.min(H - NH / 2, p.y + d));
          if (kb !== own) q.y = Math.max(NH / 2, Math.min(H - NH / 2, q.y - d));
          moved = true;
        }
        if (!moved) break;
      }
      settled = true;
      const pos = layout;
      svg.replaceChildren();
      // Links: subspace in sky blue; a docking port's hard link thicker, in orange; requests dashed gold.
      const hardSet = new Set((graph.hard || []).map(([a, b]) => [a, b].map((x) => x.toLowerCase()).sort().join('|')));
      const edge = ([a, b], pending) => {
        const p = pos.get(a.toLowerCase()), q = pos.get(b.toLowerCase());
        if (!p || !q) return;
        const hard = !pending && hardSet.has([a, b].map((x) => x.toLowerCase()).sort().join('|'));
        const line = node('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, stroke: color(pending ? 'gold' : hard ? 'orange' : 'sky'), 'stroke-width': pending ? 3 : hard ? 9 : 5,
          'stroke-dasharray': pending ? '10 8' : 'none', 'stroke-linecap': 'round', opacity: pending ? 0.8 : 1 });
        if (hard) line.setAttribute('data-hard', '');
        svg.append(line);
      };
      graph.links.forEach((l) => edge(l, false));
      graph.requests.forEach((l) => edge(l, true));
      for (const sh of list) {
        const key = sh.name.toLowerCase();
        const { x, y } = pos.get(key);
        // (Each node keeps the label width the layout spaced it by.)
        const fill = key === own ? 'gold' : !sh.ops ? 'tan' : onNet.has(key) ? 'sky' : 'lilac';
        const label = sh.name.toUpperCase();
        const w = Math.max(120, label.length * 11 + 36), h = 52;
        const g = node('g', { class: 'net-node', transform: `translate(${x - w / 2} ${y - h / 2})`, tabindex: 0, role: 'button', 'aria-label': `The ${sh.name}` });
        g.append(
          node('rect', { width: w, height: h, rx: h / 2, fill: color(fill), opacity: sh.ops ? 1 : 0.6 }),
          node('text', { x: w / 2, y: 22, 'text-anchor': 'middle', 'font-size': 18, fill: '#000' }, label),
          node('text', { x: w / 2, y: 40, 'text-anchor': 'middle', 'font-size': 12, fill: '#000' },
            `${sh.crew} aboard${sh.shields ? ' · shields up' : ''}${sh.ops ? '' : ' · no ops'}`));
        if (sh.shields) g.append(node('rect', { x: -5, y: -5, width: w + 10, height: h + 10, rx: h / 2 + 5, fill: 'none', stroke: color('red'), 'stroke-width': 2 }));
        if (key !== own) {
          const pick = () => document.querySelector(`#link-taps button[data-ship="${CSS.escape(sh.name)}"]`)?.focus();
          g.addEventListener('click', pick);
          g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
        }
        svg.append(g);
      }
      if (!list.length) svg.append(node('text', { x: cx, y: cy, 'text-anchor': 'middle', fill: color('tan'), 'font-size': 18 }, 'No ships'));
    }

    // The map's layout, kept between refreshes (vessel key -> { x, y, w }).
    const layout = new Map();
    let settled = false;
    function render() {
      renderRemoteBlock();
      renderMap();

      // All hands: who's on air, and the speaker picker (captain first).
      fillSelect('ah-speaker', roster, Math.max(0, roster.findIndex((u) => u.station === 'Captain')));
      $('broadcasts').replaceChildren(...broadcasts.map((b) => el('li', { className: 'ops-hail' },
        el('span', { className: 'ops-hail__text', textContent: `On air: ${b.speaker.name} (${b.speaker.station}), ${b.label}` }),
        el('button', { className: 'lcars-button lcars-button--pill lcars-button--alert', textContent: 'End', onclick: () => send({ type: 'all-hands-end', id: b.id }) }))));
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
      linkList.replaceChildren(...(links.length ? links.map((s) => (hardLinks || []).includes(s) ? el('li', { className: 'ops-hail' },
        el('span', { className: 'ops-hail__text', textContent: `Linked with the ${s} · hard link: docking port` })) : el('li', { className: 'ops-hail' },
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
      // Every other vessel as a tap: one that can be linked requests it; the rest greyed with why.
      const why = (s) => (links.includes(s) ? 'linked' : linkOutgoing.some((r) => r.toShip === s) || linkIncoming.some((r) => r.fromShip === s) ? 'requested' : linkShips.includes(s) ? '' : 'out of reach: a subspace relay down');
      const others = [...new Set([...graph.ships.map((x) => x.name), ...linkShips])].filter((s) => s.toLowerCase() !== ship.toLowerCase()).sort();
      $('link-taps').replaceChildren(...(others.length ? others.map((s) => { const w = why(s); const b = el('button', { type: 'button', className: 'lcars-button lcars-button--pill tr-tap', textContent: w ? `${s} · ${w}` : s, disabled: !!w, title: w, onclick: () => send({ type: 'link-request', ship: s }) }); b.dataset.ship = s; return b; }) : [el('span', { className: 'ops-hint', textContent: 'No other vessels' })]));

      // Roster
      const body = $('roster');
      body.replaceChildren();
      if (!roster.length) body.append(el('tr', { className: 'empty' }, el('td', { colSpan: 4, textContent: 'No crew on the comm net' })));
      // (By where they are aboard, in deck order: a heading row for each place.)
      for (const g of byPlace(roster, (x) => x.console || x.station)) {
        body.append(el('tr', { className: 'place-row' }, el('th', { colSpan: 4, className: 'place-head', textContent: g.label })));
        for (const u of g.items) {
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
              // Radio (other ships in range can see the call is on), or a data link (private) when there's a link path.
              el('button', { className: 'lcars-button lcars-button--pill', textContent: 'Route by radio', disabled: !roster.length,
                onclick: () => send({ type: 'route', hail: h.id, to: pick.value, via: 'radio' }) }),
              ...(network.includes(h.fromShip) ? [el('button', { className: 'lcars-button lcars-button--pill', textContent: 'Route by data link', disabled: !roster.length,
                onclick: () => send({ type: 'route', hail: h.id, to: pick.value, via: 'link' }) })] : []),
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
    action('allhands-form', () => ({ type: 'all-hands', speaker: $('ah-speaker').value, scope: $('ah-scope').value }));
    action('transfer-form', () => {
      const v = $('transfer-to').value;
      return v.startsWith('ship:') ? { type: 'transfer', ship: v.slice(5) } : { type: 'transfer', to: v };
    });

    log(`${me.name} has the ops station aboard the ${ship}`);
    render();

    return {
      handle,
      render,
      get roster() { return roster; },
      get ships() { return ships; },
      get incoming() { return incoming; },
      get outgoing() { return outgoing; },
      get links() { return links; },
      get linkShips() { return linkShips; },
      get network() { return network; },
      get linkIncoming() { return linkIncoming; },
      get graph() { return graph; },
    };
  };
})();
