// The data network map (Ops' Data link screen and Communications): every vessel
// as an LCARS pill, laid out by d3-force. Data links pull their two ends to a
// short rest length; every vessel pushes the others away, and pills never
// overlap; our own ship is fixed at the centre and the rest are drawn gently
// towards it, a vessel on no link more weakly, so they ring the outside. The
// layout runs to rest before it's drawn, starts from the same places each time
// (seeded), and is fitted to the box by scaling the view. Drag a pill to move
// it (it's let go on release). Tap a pill for its details, a link for its two
// ends and the data network it's part of; tap empty space to clear.
//
// const map = createNetMap({ svg, details, send, own: () => ship name });
// map.update({ graph, links, hardLinks, linkShips, linkIncoming, linkOutgoing, network })
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const H = 52;
  const widthOf = (name) => Math.max(120, name.length * 11 + 36);
  const keyOf = (n) => n.toLowerCase();
  const pairKey = (a, b) => [keyOf(a), keyOf(b)].sort().join('|');
  // (A small seeded random source: the same layout every time for the same picture.)
  const seeded = (s) => () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const hash = (str) => [...str].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

  window.createNetMap = function createNetMap({ svg, details, send, own }) {
    const d3 = window.d3;
    let data = null, sim = null, selected = null; // selected: { node: key } | { link: pairKey }
    const nodes = new Map(); // key -> node (kept between updates: positions persist)
    const node = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
    const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
    const color = (n) => `var(--lcars-${n})`;
    svg.style.touchAction = 'none'; // (the map drags for itself; scrolling elsewhere is untouched)

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

    // The layout: d3-force, run to rest (or, after a change, a gentle reheat, animated).
    function layout(animate) {
      const g = data.graph, me = keyOf(own());
      const keys = new Set(g.ships.map((s) => keyOf(s.name)));
      for (const k of [...nodes.keys()]) if (!keys.has(k)) nodes.delete(k);
      const linked = g.links.filter(([a, b]) => keys.has(keyOf(a)) && keys.has(keyOf(b)));
      const degree = new Map();
      for (const [a, b] of linked) for (const x of [a, b]) degree.set(keyOf(x), (degree.get(keyOf(x)) || 0) + 1);
      let fresh = false;
      for (const s of g.ships) {
        const k = keyOf(s.name);
        if (!nodes.has(k)) {
          fresh = true;
          // Start near a vessel it's linked to, if one is placed; else on a seeded ring.
          const near = linked.map(([a, b]) => (keyOf(a) === k ? keyOf(b) : keyOf(b) === k ? keyOf(a) : null)).find((o) => o && nodes.has(o));
          const r = seeded(hash(k)), a = r() * Math.PI * 2, d = near ? 80 : degree.get(k) ? 220 : 380;
          const base = near ? nodes.get(near) : { x: 0, y: 0 };
          nodes.set(k, { id: k, x: base.x + d * Math.cos(a), y: base.y + d * Math.sin(a) });
        }
        Object.assign(nodes.get(k), { name: s.name, ship: s, w: widthOf(s.name), linked: !!degree.get(k) });
        if (k === me) Object.assign(nodes.get(k), { fx: 0, fy: 0 });
        else if (!nodes.get(k).dragging) Object.assign(nodes.get(k), { fx: null, fy: null });
      }
      const list = [...nodes.values()];
      const edges = linked.map(([a, b]) => ({ source: keyOf(a), target: keyOf(b) }));
      // Which data network each is in (separate networks keep apart; a vessel off its
      // links' lines: no pill sits on a link it isn't part of).
      const comp = new Map(list.map((n) => [n.id, n.id]));
      const root = (k) => { while (comp.get(k) !== k) k = comp.get(k); return k; };
      for (const [a, b] of linked) comp.set(root(keyOf(a)), root(keyOf(b)));
      const apart = (alpha) => {
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
          const p = list[i], q = list[j];
          if (root(p.id) === root(q.id)) continue;
          const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1, want = (p.w + q.w) / 2 + 90;
          if (d >= want) continue;
          const f = ((want - d) / d) * alpha * 0.5, sp = p.fx != null ? 0 : q.fx != null ? 2 : 1, sq = 2 - sp;
          p.x -= dx * f * sp / 2; p.y -= dy * f * sp / 2; q.x += dx * f * sq / 2; q.y += dy * f * sq / 2;
        }
      };
      const offLines = (alpha) => {
        for (const e of edges) {
          const a = typeof e.source === 'object' ? e.source : nodes.get(e.source), b = typeof e.target === 'object' ? e.target : nodes.get(e.target);
          if (!a || !b) continue;
          const vx = b.x - a.x, vy = b.y - a.y, len2 = vx * vx + vy * vy || 1;
          for (const n of list) {
            if (n === a || n === b || n.fx != null) continue;
            const t = Math.max(0, Math.min(1, ((n.x - a.x) * vx + (n.y - a.y) * vy) / len2));
            const px = a.x + t * vx, py = a.y + t * vy, dx = n.x - px, dy = n.y - py, d = Math.hypot(dx, dy) || 1, clear = H / 2 + 26 + (Math.abs(vx) > Math.abs(vy) ? 0 : n.w / 2 - H / 2);
            if (d >= clear || t <= 0 || t >= 1) continue;
            const f = ((clear - d) / d) * alpha;
            n.x += dx * f; n.y += dy * f;
          }
        }
      };
      // Pills never overlap: pairs pushed apart along their smaller overlap.
      const collide = () => {
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
          const p = list[i], q = list[j];
          const ox = (p.w + q.w) / 2 + 12 - Math.abs(p.x - q.x), oy = H + 12 - Math.abs(p.y - q.y);
          if (ox <= 0 || oy <= 0) continue;
          const fixedP = p.fx != null, fixedQ = q.fx != null, share = fixedP ? 0 : fixedQ ? 1 : 0.5;
          if (ox < oy * 2.5) { const s = (p.x < q.x ? -1 : 1) * ox; p.x += s * share; q.x -= s * (1 - share); }
          else { const s = (p.y < q.y ? -1 : 1) * oy; p.y += s * share; q.y -= s * (1 - share); }
        }
      };
      sim?.stop();
      sim = d3.forceSimulation(list).randomSource(seeded(42))
        .force('link', d3.forceLink(edges).id((n) => n.id).distance((e) => 0.75 * (e.source.w + e.target.w)).strength(0.9))
        .force('charge', d3.forceManyBody().strength((n) => (n.linked ? -500 : -250)))
        .force('x', d3.forceX(0).strength((n) => (n.linked ? 0.08 : 0.01)))
        .force('y', d3.forceY(0).strength((n) => (n.linked ? 0.12 : 0.015)))
        .force('ring', d3.forceRadial((n) => (n.linked ? 0 : outer()), 0, 0).strength((n) => (n.linked ? 0 : 0.12)))
        .force('apart', apart)
        .force('offLines', offLines)
        .force('collide', collide)
        .stop();
      // (The ring of vessels on no link: just outside the linked ones.)
      function outer() { return Math.max(220, list.filter((n) => n.linked).reduce((m, n) => Math.max(m, Math.hypot(n.x, n.y) + n.w / 2), 0) + 110); }
      if (!animate || fresh) { sim.alpha(1); for (let i = 0; i < 400; i++) sim.tick(); for (let i = 0; i < 30; i++) { offLines(0.5); collide(); } draw(true); }
      else { draw(false); sim.alpha(0.3).alphaDecay(0.05).on('tick', move).restart(); }
    }
    // While it moves (a reheat, a drag): the drawn pills and links follow.
    const drawn = { nodes: new Map(), links: [] };
    function move() {
      for (const [k, grp] of drawn.nodes) { const n = nodes.get(k); if (n) grp.setAttribute('transform', `translate(${n.x - n.w / 2} ${n.y - H / 2})`); }
      for (const { a, b, lines } of drawn.links) { const p = nodes.get(a), q = nodes.get(b); if (p && q) for (const l of lines) { l.setAttribute('x1', p.x); l.setAttribute('y1', p.y); l.setAttribute('x2', q.x); l.setAttribute('y2', q.y); } }
    }

    // Fit the view to what's drawn (scaled, never clamped).
    function fit() {
      const list = [...nodes.values()];
      if (!list.length) return svg.setAttribute('viewBox', '-300 -200 600 400');
      const x0 = Math.min(...list.map((n) => n.x - n.w / 2)) - 24, x1 = Math.max(...list.map((n) => n.x + n.w / 2)) + 24;
      const y0 = Math.min(...list.map((n) => n.y - H / 2)) - 24, y1 = Math.max(...list.map((n) => n.y + H / 2)) + 24;
      svg.setAttribute('viewBox', `${x0} ${y0} ${x1 - x0} ${y1 - y0}`);
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
      drawn.nodes.clear(); drawn.links.length = 0;
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
        grp.append(
          node('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, stroke: color(lit ? 'gold' : pending ? 'gold' : isHard ? 'orange' : isLost ? 'tan' : 'sky'), 'stroke-width': lit ? 9 : pending ? 3 : isHard ? 9 : 5,
            'stroke-dasharray': pending ? '10 8' : isLost ? '4 10' : 'none', ...(isLost ? { 'data-lost': '' } : {}), 'stroke-linecap': 'round', opacity: pending ? 0.8 : 1, ...(isHard ? { 'data-hard': '' } : {}) }),
          // (A wide invisible stroke: easy to tap on a tablet.)
          node('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, stroke: 'transparent', 'stroke-width': 26, class: 'net-hit' }));
        drawn.links.push({ a: keyOf(a), b: keyOf(b), lines: [...grp.children] });
        if (!pending) grp.addEventListener('click', (ev) => { ev.stopPropagation(); select({ link: k }); });
        svg.append(grp);
      };
      g.links.forEach((l) => edge(l, false));
      g.requests.forEach((l) => edge(l, true));
      for (const n of nodes.values()) {
        const sh = n.ship, k = n.id, label = sh.name.toUpperCase(), w = n.w;
        const fill = k === me ? 'gold' : !sh.ops ? 'tan' : onNet.has(k) ? 'sky' : 'lilac';
        const grp = node('g', { class: 'net-node', 'data-ship': sh.name, transform: `translate(${n.x - w / 2} ${n.y - H / 2})`, tabindex: 0, role: 'button', 'aria-label': `The ${sh.name}` });
        grp.append(
          node('rect', { width: w, height: H, rx: H / 2, fill: color(fill), opacity: sh.ops || sh.starbase ? 1 : 0.6 }),
          node('text', { x: w / 2, y: 22, 'text-anchor': 'middle', 'font-size': 18, fill: '#000' }, label),
          node('text', { x: w / 2, y: 40, 'text-anchor': 'middle', 'font-size': 12, fill: '#000' }, `${sh.crew} aboard${sh.shields ? ' · shields up' : ''}${sh.ops ? '' : ' · no ops'}`));
        if (sh.shields) grp.append(node('rect', { x: -5, y: -5, width: w + 10, height: H + 10, rx: H / 2 + 5, fill: 'none', stroke: color('red'), 'stroke-width': 2 }));
        if (selected?.node === k || (hiNet && hiNet.members.map(keyOf).includes(k))) grp.append(node('rect', { x: -7, y: -7, width: w + 14, height: H + 14, rx: H / 2 + 7, fill: 'none', stroke: color('gold'), 'stroke-width': 4, class: 'net-selected' }));
        grp.addEventListener('click', (ev) => { ev.stopPropagation(); select({ node: k }); });
        grp.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select({ node: k }); } });
        svg.append(grp);
        drawn.nodes.set(k, grp);
        // Drag a pill to move it; a tap (less than a few pixels) selects instead.
        if (k !== me) d3.select(grp).datum(n).call(d3.drag().clickDistance(6)
          .on('start', () => { n.dragging = true; n.fx = n.x; n.fy = n.y; sim.alphaTarget(0.2).on('tick', move).restart(); })
          .on('drag', (ev) => { n.fx = ev.x; n.fy = ev.y; }) // (d3-drag gives the map's own coordinates)
          .on('end', () => { n.dragging = false; n.fx = null; n.fy = null; sim.alphaTarget(0); sim.on('end', () => draw(true)); }));
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
        if (!d3) { svg.replaceChildren(); return; }
        const now = JSON.stringify([data.graph.ships.map((s) => s.name).sort(), data.graph.links, data.graph.requests]);
        if (now !== was) layout(!!was);
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
