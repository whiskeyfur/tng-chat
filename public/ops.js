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
      const W = 600, H = 400, cx = W / 2, cy = H / 2 + 6, R = list.length > 1 ? 145 : 0;
      const pos = new Map(list.map((sh, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / list.length;
        return [sh.name.toLowerCase(), { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }];
      }));
      svg.replaceChildren();
      const edge = ([a, b], pending) => {
        const p = pos.get(a.toLowerCase()), q = pos.get(b.toLowerCase());
        if (!p || !q) return;
        svg.append(node('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, stroke: color(pending ? 'gold' : 'sky'), 'stroke-width': pending ? 3 : 5,
          'stroke-dasharray': pending ? '10 8' : 'none', 'stroke-linecap': 'round', opacity: pending ? 0.8 : 1 }));
      };
      graph.links.forEach((l) => edge(l, false));
      graph.requests.forEach((l) => edge(l, true));
      for (const sh of list) {
        const key = sh.name.toLowerCase();
        const { x, y } = pos.get(key);
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
          const pick = () => { const sel = $('link-ship'); if ([...sel.options].some((o) => o.value === sh.name)) { sel.value = sh.name; sel.focus(); } };
          g.addEventListener('click', pick);
          g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
        }
        svg.append(g);
      }
      if (!list.length) svg.append(node('text', { x: cx, y: cy, 'text-anchor': 'middle', fill: color('tan'), 'font-size': 18 }, 'No ships'));
    }

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
      const linkable = linkShips.filter((s) => !links.includes(s));
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
    action('link-form', () => ({ type: 'link-request', ship: $('link-ship').value }));
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
