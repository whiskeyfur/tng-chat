// The data network map (Ops' Data link screen and Communications), laid out like the
// Distribution chart: the vessel being viewed in the middle, the vessels linked with it
// lined up in a column on each side (the subspace relay first, then hard links, then data
// links), and each further hop in the next column out, beside the vessel it's reached
// through, so the branches fan out without crossing. (With one link, and that one only one
// more, they stand in a line above the middle until it branches: the branches split left
// and right from there.) A vessel reached more than one way is
// placed once (its fewest hops) and its other links drawn too; vessels on no link with it
// sit in a row underneath. Links are schematic elbows: lit, dashed while pending, dotted
// with the signal lost. The layout only changes when the vessels or links do. Tap a pill
// for its details, a link for its two ends and the data network it's part of; tap empty
// space to clear.
//
// const map = createNetMap({ svg, details, send, own: () => ship name });
// map.update({ graph, links, hardLinks, linkShips, linkIncoming, linkOutgoing, network })
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const H = 52;
  const widthOf = (name) => Math.max(120, name.length * 11 + 36);
  const keyOf = (n) => n.toLowerCase();
  const pairKey = (a, b) => [keyOf(a), keyOf(b)].sort().join('|');

  window.createNetMap = function createNetMap({ svg, details, send, own }) {
    let data = null, selected = null; // selected: { node: key } | { link: pairKey }
    const nodes = new Map(); // key -> node (kept between updates: positions persist)
    const node = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
    const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
    const color = (n) => `var(--lcars-${n})`;

    // The data networks: each set of vessels joined by links (named after the
    // member of its oldest link, first alphabetically).
    function networks() {
      const g = data.graph, parent = new Map();
      const find = (k) => { while (parent.get(k) !== k) k = parent.get(k); return k; };
      for (const s of g.ships) parent.set(keyOf(s.name), keyOf(s.name));
      for (const [a, b] of g.links) if (parent.has(keyOf(a)) && parent.has(keyOf(b))) parent.set(find(keyOf(a)), find(keyOf(b)));
      const comps = new Map();
      for (const s of g.ships) { const r = find(keyOf(s.name)); if (!comps.has(r)) comps.set(r, { members: [], links: [] }); comps.get(r).members.push(s.name); }
      for (const [a, b] of g.links) comps.get(find(keyOf(a)))?.links.push([a, b]);
      for (const c of comps.values()) {
        const oldest = [...c.links].sort((x, y) => (g.since?.[pairKey(...x)] || 0) - (g.since?.[pairKey(...y)] || 0))[0];
        c.name = `${oldest ? [...oldest].sort()[0] : c.members[0]} network`;
        c.members.sort();
      }
      return { of: (name) => comps.get(find(keyOf(name))), all: [...comps.values()] };
    }

    // The layout: a schematic, by hops from the vessel in the middle.
    const COL_GAP = 90, ROW = H + 22, SCALE = 0.8; // (SCALE: the smallest it's drawn, map units to pixels)
    function layout() {
      const g = data.graph, me = keyOf(own());
      const ships = new Map(g.ships.map((sh) => [keyOf(sh.name), sh]));
      for (const k of [...nodes.keys()]) if (!ships.has(k)) nodes.delete(k);
      const linked = g.links.filter(([a, b]) => ships.has(keyOf(a)) && ships.has(keyOf(b)));
      const hard = new Set((g.hard || []).map(([a, b]) => pairKey(a, b)));
      const adj = new Map([...ships.keys()].map((k) => [k, []]));
      for (const [a, b] of linked) { adj.get(keyOf(a)).push(keyOf(b)); adj.get(keyOf(b)).push(keyOf(a)); }
      // (The order along a column: the relay first, then hard links, then data links, by name.)
      const rank = (from, k) => (ships.get(k).relay ? 0 : hard.has(pairKey(from, k)) ? 1 : 2);
      const order = (from, list) => [...new Set(list)].sort((x, y) => rank(from, x) - rank(from, y) || x.localeCompare(y));
      // Hops from the middle (breadth first): each vessel's depth, and the one it's reached through.
      const depth = new Map(), kids = new Map([...ships.keys()].map((k) => [k, []]));
      if (ships.has(me)) {
        depth.set(me, 0);
        let front = [me];
        while (front.length) {
          const next = [];
          for (const k of front) for (const o of order(k, adj.get(k))) if (!depth.has(o)) { depth.set(o, depth.get(k) + 1); kids.get(k).push(o); next.push(o); }
          front = next;
        }
      }
      const rows = (k) => Math.max(1, kids.get(k).reduce((n, c) => n + rows(c), 0));
      for (const [k, sh] of ships) {
        if (!nodes.has(k)) nodes.set(k, { id: k });
        Object.assign(nodes.get(k), { name: sh.name, ship: sh, w: widthOf(sh.name), linked: adj.get(k).length > 0 });
      }
      // A trunk first: while the middle has one link (and that one only one more), they stand in a
      // line above it; where it branches, the branches split left and right (by size, the smaller
      // side taking the next), each further hop a column further out, so both sides are used.
      const trunk = ships.has(me) ? [me] : [];
      while (trunk.length && kids.get(trunk[trunk.length - 1]).length === 1) trunk.push(kids.get(trunk[trunk.length - 1])[0]);
      const fork = trunk[trunk.length - 1], base = trunk.length - 1;
      const col = (k) => depth.get(k) - base; // (the fork's branches: column 1)
      // The columns: each as wide as its widest pill, a gap between.
      const maxCol = Math.max(0, ...[...depth.keys()].map(col)), colW = [];
      for (let c = 0; c <= maxCol; c++) colW[c] = Math.max(120, ...[...depth.keys()].filter((k) => (c === 0 ? trunk.includes(k) : col(k) === c)).map((k) => nodes.get(k).w));
      const colX = [0];
      for (let c = 1; c <= maxCol; c++) colX[c] = colX[c - 1] + colW[c - 1] / 2 + COL_GAP + colW[c] / 2;
      trunk.forEach((k, i) => Object.assign(nodes.get(k), { x: 0, y: -i * ROW * 1.4, depth: i }));
      const forkY = trunk.length ? nodes.get(fork).y : 0;
      const first = fork ? kids.get(fork) : [], side = { '-1': [], 1: [] }, used = { '-1': 0, 1: 0 };
      for (const k of first) { const sd = used[1] < used[-1] ? 1 : -1; side[sd].push(k); used[sd] += rows(k); }
      const place = (k, sd, top) => {
        const n = nodes.get(k), span = rows(k);
        Object.assign(n, { x: sd * colX[col(k)], y: top + (span * ROW) / 2 - ROW / 2, depth: depth.get(k) });
        let t = top;
        for (const c of kids.get(k)) { place(c, sd, t); t += rows(c) * ROW; }
      };
      for (const sd of [-1, 1]) { let t = forkY - (used[sd] * ROW) / 2; for (const k of side[sd]) { place(k, sd, t); t += rows(k) * ROW; } }
      // On no link with the middle: a row underneath.
      const placed = [...nodes.values()].filter((n) => depth.has(n.id));
      const bottom = Math.max(H / 2, ...placed.map((n) => n.y + H / 2));
      const rest = [...ships.keys()].filter((k) => !depth.has(k)).sort((a, b) => a.localeCompare(b));
      const restW = rest.reduce((n, k) => n + nodes.get(k).w + 16, -16);
      let x = -restW / 2;
      for (const k of rest) { const n = nodes.get(k); Object.assign(n, { x: x + n.w / 2, y: bottom + ROW, depth: null }); x += n.w + 16; }
      draw(true);
    }

    // (Scrolled so the vessel in the middle is in view: after a new layout, once the panel is shown.)
    let centre = false;
    function centreView() {
      const box = svg.parentElement;
      if (!centre || !box || !box.clientWidth) return;
      centre = false;
      box.scrollLeft = Math.max(0, (box.scrollWidth - box.clientWidth) / 2);
      box.scrollTop = Math.max(0, (svg.getBoundingClientRect().height - box.clientHeight) / 2);
    }
    if (window.ResizeObserver && svg.parentElement) new ResizeObserver(centreView).observe(svg.parentElement);
    // Fit the view to what's drawn (scaled, never clamped).
    function fit() {
      const list = [...nodes.values()];
      if (!list.length) return svg.setAttribute('viewBox', '-300 -200 600 400');
      const x0 = Math.min(...list.map((n) => n.x - n.w / 2)) - 24, x1 = Math.max(...list.map((n) => n.x + n.w / 2)) + 24;
      const y0 = Math.min(...list.map((n) => n.y - H / 2)) - 24, y1 = Math.max(...list.map((n) => n.y + H / 2)) + 24;
      // (Centred on the vessel in the middle; drawn at a readable size, the panel scrolling (a drag,
      // on a tablet) when it's bigger than that, and scrolled to the middle.)
      const xm = Math.max(-x0, x1);
      svg.setAttribute('viewBox', `${-xm} ${y0} ${2 * xm} ${y1 - y0}`);
      svg.style.minWidth = `${Math.round(2 * xm * SCALE)}px`;
      svg.style.minHeight = `${Math.round((y1 - y0) * SCALE)}px`;
      centre = true;
      requestAnimationFrame(centreView);
    }

    function draw(refit) {
      if (refit) fit();
      const g = data.graph, me = keyOf(own());
      const onNet = new Set([me, ...(data.network || []).map(keyOf)]);
      const hard = new Set((g.hard || []).map(([a, b]) => pairKey(a, b)));
      const lost = new Set((g.lost || []).map(([a, b]) => pairKey(a, b)));
      const nets = networks();
      const hiNet = selected?.link ? nets.of(selected.link.split('|')[0]) : null;
      const hiLinks = new Set((hiNet?.links || []).map(([a, b]) => pairKey(a, b)));
      svg.replaceChildren();
      // A transparent background takes taps on empty space (they clear the selection).
      const vb = svg.viewBox.baseVal;
      const bg = node('rect', { x: vb.x, y: vb.y, width: vb.width, height: vb.height, fill: 'transparent', class: 'net-bg' });
      bg.addEventListener('click', () => select(null));
      svg.append(bg);
      const edge = ([a, b], pending) => {
        const p = nodes.get(keyOf(a)), q = nodes.get(keyOf(b));
        if (!p || !q) return;
        const k = pairKey(a, b), isHard = !pending && hard.has(k), lit = selected?.link === k || hiLinks.has(k), isLost = !pending && lost.has(k);
        const grp = node('g', { class: 'net-link', 'data-link': k });
        // (An elbow from one pill's side to the other's, as on Distribution; in one column, straight up or down.)
        const [L, Rt] = p.x <= q.x ? [p, q] : [q, p], d = Math.abs(p.x - q.x) < 1
          ? `M${p.x},${p.y + Math.sign(q.y - p.y) * H / 2} V${q.y - Math.sign(q.y - p.y) * H / 2}`
          : `M${L.x + L.w / 2},${L.y} H${(L.x + L.w / 2 + Rt.x - Rt.w / 2) / 2} V${Rt.y} H${Rt.x - Rt.w / 2}`;
        grp.append(
          node('path', { d, fill: 'none', stroke: color(lit ? 'gold' : pending ? 'gold' : isHard ? 'orange' : isLost ? 'tan' : 'sky'), 'stroke-width': lit ? 9 : pending ? 3 : isHard ? 9 : 5,
            'stroke-dasharray': pending ? '10 8' : isLost ? '4 10' : 'none', ...(isLost ? { 'data-lost': '' } : {}), 'stroke-linecap': 'round', opacity: pending ? 0.8 : 1, ...(isHard ? { 'data-hard': '' } : {}) }),
          // (A wide invisible stroke: easy to tap on a tablet.)
          node('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': 26, class: 'net-hit' }));
        if (!pending) grp.addEventListener('click', (ev) => { ev.stopPropagation(); select({ link: k }); });
        svg.append(grp);
      };
      g.links.forEach((l) => edge(l, false));
      g.requests.forEach((l) => edge(l, true));
      for (const n of nodes.values()) {
        const sh = n.ship, k = n.id, label = sh.name.toUpperCase(), w = n.w;
        const fill = sh.relay ? 'violet' : k === me ? 'gold' : !sh.ops ? 'tan' : onNet.has(k) ? 'sky' : 'lilac';
        const grp = node('g', { class: 'net-node', 'data-ship': sh.name, transform: `translate(${n.x - w / 2} ${n.y - H / 2})`, tabindex: 0, role: 'button', 'aria-label': `The ${sh.name}` });
        grp.append(
          node('rect', { width: w, height: H, rx: H / 2, fill: color(fill), opacity: sh.ops || sh.starbase ? 1 : 0.6 }),
          node('text', { x: w / 2, y: 22, 'text-anchor': 'middle', 'font-size': 18, fill: '#000' }, label),
          node('text', { x: w / 2, y: 40, 'text-anchor': 'middle', 'font-size': 12, fill: '#000' }, sh.relay ? `SUBSPACE RELAY${sh.off ? ' · OFF' : ''}` : `${sh.crew} aboard${sh.shields ? ' · shields up' : ''}${sh.ops ? '' : ' · no ops'}`));
        if (sh.shields) grp.append(node('rect', { x: -5, y: -5, width: w + 10, height: H + 10, rx: H / 2 + 5, fill: 'none', stroke: color('red'), 'stroke-width': 2 }));
        if (selected?.node === k || (hiNet && hiNet.members.map(keyOf).includes(k))) grp.append(node('rect', { x: -7, y: -7, width: w + 14, height: H + 14, rx: H / 2 + 7, fill: 'none', stroke: color('gold'), 'stroke-width': 4, class: 'net-selected' }));
        grp.addEventListener('click', (ev) => { ev.stopPropagation(); select({ node: k }); });
        grp.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select({ node: k }); } });
        svg.append(grp);
      }
      if (!nodes.size) svg.append(node('text', { x: 0, y: 0, 'text-anchor': 'middle', fill: color('tan'), 'font-size': 18 }, 'No ships'));
    }

    // --- the details panel -------------------------------------------------------
    function select(sel) { selected = sel; draw(false); renderDetails(); }
    const bar = (label, ...taps) => el('div', { className: 'place-bar net-bar' }, el('span', { className: 'place-cap place-cap--l' }), el('span', { className: 'place-label', textContent: label }), ...taps, el('span', { className: 'place-cap place-cap--r' }));
    const tap = (text, onclick, alert) => { const b = el('button', { type: 'button', className: `lcars-button lcars-button--pill tr-tap${alert ? ' lcars-button--alert' : ''}`, textContent: text }); b.onclick = onclick; return b; };
    function renderDetails() {
      if (!details) return;
      const g = data.graph, me = own(), nets = networks();
      if (!selected) return details.replaceChildren(el('p', { className: 'ops-hint', textContent: 'Tap a vessel for its details, or a link for its two ends and its data network.' }));
      if (selected.node) {
        const n = nodes.get(selected.node);
        if (!n) return select(null);
        const sh = n.ship, mine = keyOf(sh.name) === keyOf(me), ours = nodes.get(keyOf(me))?.ship;
        if (sh.relay) {
          // A subspace relay: what it links (the stations of its system, the other systems' relays).
          const linked = g.links.filter(([a, b]) => keyOf(a) === keyOf(sh.name) || keyOf(b) === keyOf(sh.name)).map(([a, b]) => (keyOf(a) === keyOf(sh.name) ? b : a)).sort();
          return details.replaceChildren(el('h3', { className: 'ops-subhead', id: 'net-details-title', textContent: sh.name }),
            el('p', { className: 'ops-hint', textContent: `Subspace relay${sh.off ? ' (disabled from the admin page)' : ''}: joins every station in its system into one data network, and the systems to each other. Unmanned; its links stay (only the admin page disables it).` }),
            el('ul', { className: 'st-list', id: 'net-relay-links' }, ...(linked.length ? linked.map((m) => { const li = el('li', {}, tap(m, () => select({ node: keyOf(m) }))); li.dataset.member = m; return li; }) : [el('li', { className: 'empty', textContent: 'nothing linked' })])));
        }
        const dist = ours && sh.x != null && ours.x != null ? Math.round(Math.hypot(sh.x - ours.x, sh.y - ours.y)) : null;
        const linked = (data.links || []).includes(sh.name), hardLink = (data.hardLinks || []).includes(sh.name);
        const inc = (data.linkIncoming || []).find((r) => r.fromShip === sh.name), out = (data.linkOutgoing || []).find((r) => r.toShip === sh.name);
        const reach = (data.linkShips || []).includes(sh.name);
        const status = mine ? 'this ship' : linked ? (hardLink ? 'linked (hard link: docking port)' : 'linked') : inc ? 'requests a link with us' : out ? 'link requested' : 'not linked';
        const actions = mine ? [] : linked ? (hardLink ? [] : [tap('Close link', () => send({ type: 'link-close', ship: sh.name }), true)])
          : inc ? [tap('Accept', () => send({ type: 'link-accept', request: inc.id })), tap('Decline', () => send({ type: 'link-decline', request: inc.id }), true)]
          : out ? [tap('Withdraw', () => send({ type: 'link-cancel', request: out.id }), true)]
          : reach ? [tap('Request link', () => send({ type: 'link-request', ship: sh.name }))] : [];
        const net = nets.of(sh.name);
        const row = (k, v) => el('li', {}, el('span', { textContent: k }), el('span', { textContent: v }));
        details.replaceChildren(
          el('h3', { className: 'ops-subhead', id: 'net-details-title', textContent: sh.starbase ? sh.name : `The ${sh.name}` }),
          el('ul', { className: 'st-list net-facts', id: 'net-details-facts' },
            row('Type', sh.starbase ? 'Starbase' : `${sh.class || 'Ship'} class`),
            ...(sh.x != null ? [row('Position', `${Math.round(sh.x)}, ${Math.round(sh.y)}${dist != null && !mine ? ` · ${dist} away` : ''}`)] : []),
            ...(mine ? [] : [row('In reach', reach ? 'yes (data link reach)' : 'no')]),
            row('Aboard', `${sh.crew} · ops ${sh.ops ? 'manned' : 'unmanned'}`),
            row('Data link', status),
            row('Remote control', sh.remoteBlock ? 'blocked' : sh.automated ? 'automated (no crew)' : 'command prefix needed'),
            row('Data network', net && net.members.length > 1 ? `${net.name} (${net.members.length})` : 'none')),
          ...(actions.length ? [bar('Data link', ...actions)] : []));
      } else {
        const [a, b] = selected.link.split('|'), A = nodes.get(a), B = nodes.get(b);
        if (!A || !B) return select(null);
        const net = nets.of(A.name), since = data.graph.since?.[selected.link], me = keyOf(own());
        const isHard = (data.graph.hard || []).some(([x, y]) => pairKey(x, y) === selected.link), isLost = (data.graph.lost || []).some(([x, y]) => pairKey(x, y) === selected.link);
        const other = a === me ? B : b === me ? A : null;
        // Either end closes it (ours, or the vessel we run by remote control); a hard link ends at the dock.
        const close = other && !isHard ? [bar('Data link', tap('Close link', () => send({ type: 'link-close', ship: other.name }), true))] : [];
        const who = other ? (isHard ? 'A hard link (docking port): it ends when its ODN tie is cut on the Engineering grid, or on undocking.' : '')
          : `Closed by either end: the ${A.name}'s or the ${B.name}'s ops or Communications.`;
        details.replaceChildren(
          el('h3', { className: 'ops-subhead', id: 'net-details-title', textContent: 'Data link' }),
          bar('Between', tap(A.name, () => select({ node: a })), tap(B.name, () => select({ node: b }))),
          ...(isLost ? [el('p', { className: 'ops-hint net-lost', textContent: 'Signal lost: no subspace path (a relay down, or out of reach). The link stays, carrying nothing, until it returns.' })] : []),
          ...close, ...(who ? [el('p', { className: 'ops-hint', id: 'net-link-who', textContent: who })] : []),
          el('p', { className: 'ops-hint', textContent: since ? `Established ${new Date(since).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '' }),
          el('h3', { className: 'ops-subhead', textContent: `${net.name} · ${net.members.length} members` }),
          el('ul', { className: 'st-list', id: 'net-details-members' }, ...net.members.map((m) => { const li = el('li', {}, tap(m, () => select({ node: keyOf(m) }))); li.dataset.member = m; return li; })));
      }
    }

    return {
      update(next) {
        const was = data && JSON.stringify([data.graph.ships.map((s) => s.name).sort(), data.graph.links, data.graph.requests]);
        data = next;
        const now = JSON.stringify([data.graph.ships.map((s) => s.name).sort(), data.graph.links, data.graph.requests]);
        if (now !== was) layout();
        else {
          // (Same vessels and links: only what's shown on them changed, crew counts, ops, shields; nothing moves.)
          for (const sh of data.graph.ships) { const n = nodes.get(keyOf(sh.name)); if (n) n.ship = sh; }
          draw(false);
        }
        renderDetails();
      },
      select,
      get positions() { return [...nodes.values()].map((n) => ({ name: n.name, x: n.x, y: n.y, w: n.w, h: H, linked: n.linked })); },
    };
  };
})();
