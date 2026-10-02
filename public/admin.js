// The admin page (/admin, localhost only: the relay refuses it otherwise). What the
// supervisor runs (the relay, the ship's computers) and its log; the fleet (every
// ship and starbase: class, crew, position, its computer) with Create ship; the
// star chart; the ship designs (config/ships). It talks to the relay as an
// ordinary socket, with the admin requests the relay only takes from localhost.
// TODO: no access control yet (fine on localhost): add it before this goes live.
(function () {
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const btn = (text, id, onclick, alert) => el('button', { type: 'button', className: `lcars-button lcars-button--pill${alert ? ' lcars-button--alert' : ''}`, id, textContent: text, onclick });
  const tap = (text, value, on, onclick) => { const b = el('button', { type: 'button', className: 'lcars-button lcars-button--pill tr-tap', textContent: text, onclick }); b.dataset.value = value; b.setAttribute('aria-pressed', String(!!on)); return b; };
  const ago = (t) => (t ? `${Math.round((Date.now() - t) / 1000)} s` : '');
  let ws = null, status = {}, designs = {}, system = null;
  const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));
  window.__adminSend = send;
  window.__admin = { get status() { return status; } };

  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    ws.onopen = () => { $('admin-link').dataset.status = 'online'; $('admin-link').textContent = 'Relay online'; send({ type: 'admin', action: 'status' }); send({ type: 'admin', action: 'settings' }); send({ type: 'admin', action: 'users' }); };
    ws.onclose = () => { $('admin-link').dataset.status = 'offline'; $('admin-link').textContent = 'Relay offline: reconnecting'; setTimeout(connect, 2000); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'hello') { designs = m.designs || {}; system = m.system || null; $('admin-relay-name').textContent = `Relay admin · ${m.relay || ''}`; renderCreate(true); }
      if (m.type === 'admin-status') { status = m; render(); }
      if (m.type === 'admin-designs') designsMessage(m);
      if (m.type === 'admin-settings') settingsMessage(m);
      if (m.type === 'admin-users') usersMessage(m);
      if (m.type === 'logged-out' || m.type === 'auth-required') location.href = 'login.html?next=/admin';
      if (m.type === 'admin-created') { $('create-status').textContent = m.text; $('create-status').className = m.ok ? 'ops-hint ok-note' : 'ops-hint err-note'; send({ type: 'admin', action: 'status' }); }
      // (The pages changed: reload. A relay restart: it reconnects by itself, keeping what's being edited.)
      if (m.type === 'reload' && !m.restart) setTimeout(() => location.reload(), 300);
    };
  }
  setInterval(() => send({ type: 'admin', action: 'status' }), 2000);

  function render() {
    $('admin-error').hidden = !status.error;
    $('admin-error').textContent = status.error || '';
    renderFleet(); renderChart(); renderSupervisor(); renderCreate(true);
  }

  // Fleet: every vessel (the relay's picture) and its computer (the supervisor's).
  let classOpen = null; // (the ship whose class taps are open)
  function renderFleet() {
    const fleet = status.fleet || [], computers = new Map((status.ships || []).map((x) => [x.ship, x]));
    $('admin-fleet').replaceChildren(
      el('tr', {}, ...['Vessel', 'Class', 'Crew', 'Ops', 'Position', "Ship's computer", ''].map((h) => el('th', { textContent: h }))),
      ...(status.relays || []).map((r) => {
        const tr = el('tr', {}, el('td', { textContent: r.name }), el('td', { textContent: 'Subspace relay' }), el('td', { textContent: '—' }), el('td', { textContent: '—' }),
          el('td', { textContent: `${r.x}, ${r.y}` }), el('td', { textContent: r.on ? 'on: linking its system' : 'DISABLED' }),
          el('td', {}, btn(r.on ? 'Disable' : 'Enable', `admin-relay-${r.name}`, () => send({ type: 'admin', action: 'relay', name: r.name, on: !r.on }), r.on)));
        tr.dataset.vessel = r.name;
        return tr;
      }),
      ...fleet.map((v) => {
        const c = computers.get(v.name);
        const tr = el('tr', {}, el('td', { textContent: v.name }), el('td', {}, v.starbase || !v.classId ? (v.starbase ? 'Starbase' : v.class || '') : btn(`${v.class || 'Class unknown'}${v.classUnknown ? ' (unknown: set it)' : ''} ▸`, `admin-class-${v.name}`, () => { classOpen = classOpen === v.name ? null : v.name; renderFleet(); })), el('td', { textContent: String(v.crew ?? '') }),
          el('td', { textContent: v.ops ? 'manned' : '—' }), el('td', { textContent: v.x != null ? `${v.x}, ${v.y}` : '' }),
          el('td', { textContent: v.starbase ? 'automated (the relay)' : c ? `${c.connected ? 'connected' : 'not connected'}${c.primary?.length ? ', flying it' : ''} · ${ago(c.since)}` : v.computer ? 'connected (not the supervisor\'s)' : 'offline' }),
          el('td', {}, ...(c ? [btn('Restart', `admin-restart-${v.name}`, () => send({ type: 'admin', action: 'restart-ship', ship: v.name }))] : [])));
        tr.dataset.vessel = v.name;
        // (Its class: a tap opens the classes as taps, under it; one picked is its design from then on.)
        if (classOpen !== v.name) return tr;
        const pick = el('tr', { className: 'admin-class-pick' }, el('td', { colSpan: 7 }, pillBar(`${v.name}: class`, Object.entries(status.classes || {}).map(([id, c]) => {
          const b = tap(c.name || id, id, id === v.classId, () => { if (id !== v.classId && confirm(`Make the ${v.name} a ${c.name || id}? Its design (places, systems, limits) changes now.`)) send({ type: 'admin', action: 'set-class', name: v.name, cls: id }); classOpen = null; renderFleet(); });
          b.id = `admin-class-${v.name}-${id}`;
          return b;
        }))));
        return [tr, pick];
      }).flat());
  }

  // Create ship: a name; a class (taps); for a ship, the starbase it's parked at (taps);
  // for a starbase, a spot on the map. Create waits until it's all there.
  const draft = { name: '', cls: null, at: null, x: null, y: null };
  function renderCreate(refresh = false) {
    const box = $('admin-create');
    if (!box.querySelector('#create-name')) {
      const name = el('input', { className: 'ops-input', id: 'create-name', placeholder: 'Name', autocomplete: 'off', ariaLabel: 'new vessel name' });
      name.oninput = () => { draft.name = name.value; renderCreate(true); };
      box.replaceChildren(el('h3', { className: 'ops-subhead', textContent: 'Create ship' }), el('div', { className: 'ops-form' }, name),
        el('div', { className: 'tr-pick' }, el('span', { className: 'tr-label', textContent: 'Class' }), el('div', { className: 'tr-taps', id: 'create-class' })),
        el('div', { id: 'create-where' }),
        el('div', { className: 'ops-form' }, btn('Create', 'create-go', () => send({ type: 'admin', action: 'create', name: draft.name.trim(), cls: draft.cls, ...(draft.cls === 'starbase' ? { x: draft.x, y: draft.y } : { at: draft.at }) })),
          el('span', { className: 'ops-hint', id: 'create-status' })));
    }
    if (!refresh && box.dataset.built) return;
    box.dataset.built = '1';
    const classes = Object.entries(designs).sort(([a], [b]) => (a === 'starbase') - (b === 'starbase')).map(([id, d]) => [id, id === 'starbase' ? 'Starbase' : d.name]);
    box.querySelector('#create-class').replaceChildren(...classes.map(([v, n]) => tap(n, v, draft.cls === v, () => { draft.cls = v; renderCreate(true); })));
    const where = box.querySelector('#create-where'), bases = status.bases || [];
    if (draft.cls === 'starbase') {
      const size = system?.size || 1000;
      const svg = chartSvg({ size, bases, pick: true, id: 'create-map', width: 300 });
      svg.addEventListener('click', (ev) => { const r = svg.getBoundingClientRect(); draft.x = Math.round(((ev.clientX - r.left) / r.width) * size); draft.y = Math.round(((ev.clientY - r.top) / r.height) * size); renderCreate(true); });
      where.replaceChildren(el('div', { className: 'tr-pick' }, el('span', { className: 'tr-label', textContent: 'Where' }), svg, el('span', { className: 'ops-hint', textContent: draft.x != null ? `at ${draft.x}, ${draft.y}` : 'click the map' })));
    } else if (draft.cls) {
      where.replaceChildren(el('div', { className: 'tr-pick' }, el('span', { className: 'tr-label', textContent: 'Parked at' }), el('div', { className: 'tr-taps', id: 'create-at' },
        ...bases.map((b) => tap(b.name, b.name, draft.at === b.name, () => { draft.at = b.name; renderCreate(true); })))));
    } else where.replaceChildren();
    box.querySelector('#create-go').disabled = !(draft.name.trim() && draft.cls && (draft.cls === 'starbase' ? draft.x != null : draft.at));
  }

  // The star chart: its bodies, starbases (and relays), and the ships where they are.
  function chartSvg({ size = 1000, bases = [], pick = false, id = '', width = null, fleet = [] }) {
    const NS = 'http://www.w3.org/2000/svg', node = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
    // (The full chart fills its panel; Create ship's picker is a fixed small map.)
    const svg = node('svg', { viewBox: `0 0 ${size} ${size}`, class: width ? 'chart-pick' : 'chart', ...(id ? { id } : {}), role: 'img', 'aria-label': pick ? 'click where the new starbase goes' : 'the star chart',
      style: `${width ? `width:${width}px;height:${width}px;background:#050505;` : ''}${pick ? 'cursor:crosshair;border:2px solid var(--lcars-orange)' : ''}` });
    const k = size / 1000;
    // (A label near the right edge reads leftward, to stay on the chart.)
    const label = (x, y, text, fill, fs) => node('text', { x: x > size * 0.7 ? x - 18 * k : x + 18 * k, y, fill, 'font-size': fs, 'text-anchor': x > size * 0.7 ? 'end' : 'start' }, text);
    for (let i = 0; i <= 10; i++) svg.append(node('line', { x1: i * size / 10, y1: 0, x2: i * size / 10, y2: size, stroke: 'rgba(153,153,255,0.15)', 'stroke-width': 2 * k }), node('line', { x1: 0, y1: i * size / 10, x2: size, y2: i * size / 10, stroke: 'rgba(153,153,255,0.15)', 'stroke-width': 2 * k }));
    for (const b of system?.bodies || []) svg.append(node('circle', { cx: b.x, cy: b.y, r: (b.r || 5) * 2 * k, fill: b.kind === 'star' ? 'var(--lcars-gold)' : 'var(--lcars-tan)', opacity: 0.5 }), label(b.x, b.y + 8 * k, b.name, 'var(--lcars-tan)', 26 * k));
    for (const b of bases) svg.append(node('rect', { x: b.x - 12 * k, y: b.y - 12 * k, width: 24 * k, height: 24 * k, fill: b.relay ? 'var(--lcars-violet)' : 'var(--lcars-sky)' }), label(b.x, b.y + 8 * k, b.name, 'var(--lcars-sky)', 32 * k));
    for (const v of fleet) if (!v.starbase && v.x != null) svg.append(node('circle', { cx: v.x, cy: v.y, r: 9 * k, fill: 'var(--lcars-orange)' }), label(v.x, v.y - 10 * k, v.name, 'var(--lcars-orange)', 26 * k));
    if (pick && draft.x != null) svg.append(node('circle', { cx: draft.x, cy: draft.y, r: 16 * k, fill: 'var(--lcars-gold)', id: 'create-spot' }));
    return svg;
  }
  function renderChart() {
    const box = $('admin-chart');
    if (box.closest('[data-screen]').hidden) return;
    box.replaceChildren(el('p', { className: 'ops-hint', textContent: system ? `${system.name}: ${system.size} × ${system.size}` : '' }), chartSvg({ size: system?.size || 1000, bases: [...(status.bases || []), ...(status.relays || []).map((r) => ({ ...r, relay: true }))], fleet: status.fleet || [] }));
  }

  // The relay and the supervisor: what runs, restart them, the log (a failed reload in red), who's connected.
  function renderSupervisor() {
    const box = $('admin-supervisor');
    const st = status;
    const log = el('pre', { className: 'admin-log', id: 'admin-log' }, ...(st.log || []).map((l) => el('span', { className: /RELOAD FAILED/.test(l) ? 'failed' : '', textContent: `${l}\n` })));
    const consoles = st.consoles || [];
    box.replaceChildren(
      el('p', { className: 'st-state', id: 'admin-relay', textContent: st.error ? st.error : `Relay: ${st.relay?.up ? 'up' : 'down'} on port ${st.relay?.port} · pid ${st.relay?.pid} · ${ago(st.relay?.since)}${st.note ? ` · ${st.note}` : ''}` }),
      ...((st.log || []).some((l) => /RELOAD FAILED/.test(l)) ? [el('p', { className: 'ops-notice', id: 'admin-reload-failed', textContent: 'A reload failed (see the log): fix it, or run npm start again.' })] : []),
      el('div', { className: 'ops-form' }, btn('Restart the relay', 'admin-restart-relay', () => { if (confirm('Restart the relay? Every console reloads and signs back in; calls end.')) send({ type: 'admin', action: 'restart-relay' }); }, true),
        btn("Restart every ship's computer", 'admin-restart-ships', () => send({ type: 'admin', action: 'restart-ships' }))),
      el('h3', { className: 'ops-subhead', textContent: 'Connected consoles' }),
      el('ul', { className: 'st-list', id: 'admin-consoles' }, ...(consoles.length ? [...new Set(consoles.map((u) => u.ship))].sort().flatMap((ship) => [el('li', { className: 'place-head', textContent: ship }),
        ...consoles.filter((u) => u.ship === ship).sort((a, b) => a.station.localeCompare(b.station)).map((u) => el('li', { textContent: `${u.name} · ${u.station}` }))]) : [el('li', { className: 'empty', textContent: 'none' })])),
      el('h3', { className: 'ops-subhead', textContent: 'Supervisor log' }), log);
    log.scrollTop = log.scrollHeight;
  }

  // --- The ship design editor (config/ships/<class>.json) ------------------------------
  // Pick a class (taps) and edit it: numbers by entry or the -/+ steppers, lists by taps
  // (add, remove, move up or down). Save checks it as the loader would (an error shows
  // beside its field), keeps a backup, and the supervisor reloads to apply it; Save as a
  // new class writes a new file. Removing a place or row a live ship uses asks first.
  let ed = { files: {}, stations: [], systems: [], subsystems: [], id: null, draft: null, asNew: false, error: null, note: '', confirm: null, newId: '' };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  function designsMessage(m) {
    if (m.designs) { ed = { ...ed, files: m.designs, stations: m.stations || [], systems: m.systems || [], subsystems: m.subsystems || [] }; if (ed.id && !ed.asNew && m.designs[ed.id]) ed.draft ||= clone(m.designs[ed.id]); }
    if ('saved' in m) {
      ed.error = m.error || null; ed.confirm = m.confirm || null;
      ed.note = m.saved ? m.note : m.confirm ? '' : 'not saved';
      if (m.saved) { ed.asNew = false; ed.id = m.id; send({ type: 'admin', action: 'designs' }); }
    }
    renderDesigns();
  }
  function renderDesigns() {
    const box = $('admin-designs');
    if (!box) return;
    const d = ed.draft, err = ed.error;
    const errAt = (field) => (err && err.field === field ? [el('p', { className: 'err-note design-error', textContent: `${field}: ${err.message}` })] : []);
    const pick = (label, ...kids) => el('div', { className: 'tr-pick' }, el('span', { className: 'tr-label', textContent: label }), ...kids);
    const field = (f, node) => { const w = el('div', { className: 'design-field' }, node, ...errAt(f)); w.dataset.field = f; return w; };
    const num = (label, f, step = 1, { nullable = false } = {}) => {
      const input = el('input', { className: 'ops-input design-num', type: 'number', step, value: d[f] ?? '', ariaLabel: label });
      input.id = `design-${f}`;
      input.onchange = () => { d[f] = input.value === '' && nullable ? null : Number(input.value); renderDesigns(); };
      const bump = (k) => () => { d[f] = Math.round(((Number(d[f]) || 0) + k * step) * 100) / 100; renderDesigns(); };
      return field(f, pick(label, btn('−', `design-${f}-down`, bump(-1)), input, btn('+', `design-${f}-up`, bump(1)), ...(nullable ? [tap('As many as needed', 'null', d[f] === null, () => { d[f] = d[f] === null ? 2 : null; renderDesigns(); })] : [])));
    };
    const flag = (label, f) => tap(label, f, !!d[f], () => { d[f] = !d[f]; renderDesigns(); });
    const ids = Object.keys(ed.files).sort();
    const list = el('div', { className: 'place-bar', id: 'design-list' }, el('span', { className: 'place-label', textContent: 'Class' }),
      ...ids.map((id) => tap(ed.files[id].name || id, id, ed.id === id && !ed.asNew, () => { ed.id = id; ed.asNew = false; ed.draft = clone(ed.files[id]); ed.error = null; ed.note = ''; ed.confirm = null; renderDesigns(); })),
      el('span', { className: 'place-cap place-cap--r' }));
    const newId = el('input', { className: 'ops-input', id: 'design-new-id', placeholder: 'new class id (e.g. akira)', value: ed.newId, autocomplete: 'off' });
    newId.oninput = () => { ed.newId = newId.value; };
    const startNew = (from) => { if (!ed.files[from]) return; ed.draft = clone(ed.files[from]); ed.draft.name = ed.newId ? ed.newId[0].toUpperCase() + ed.newId.slice(1) : `${ed.draft.name} copy`; delete ed.draft.about; ed.id = ed.newId.trim().toLowerCase(); ed.asNew = true; ed.error = null; ed.note = ''; renderDesigns(); };
    const head = [list, el('div', { className: 'ops-form' }, newId, btn('Duplicate as a new class', 'design-duplicate', () => startNew(ed.id || 'galaxy')), btn('New from Galaxy', 'design-new', () => startNew('galaxy')))];
    if (!d) return box.replaceChildren(...head, el('p', { className: 'ops-hint', textContent: 'Pick a class to edit, or start a new one.' }));
    // Stations: all of them, or the ones picked.
    const stations = el('div', { className: 'tr-taps', id: 'design-stations' }, tap('All stations', 'all', d.stations == null, () => { d.stations = d.stations == null ? ['Helm'] : null; renderDesigns(); }),
      ...(d.stations == null ? [] : ed.stations.map((st) => tap(st, st, d.stations.includes(st), () => { d.stations = d.stations.includes(st) ? d.stations.filter((x) => x !== st) : [...d.stations, st]; renderDesigns(); }))));
    // Places: each in order (move up / down), its deck, name, stations and the grid rows found there.
    const keys = [...ed.systems.map((x) => `system:${x}`), ...ed.subsystems.map((x) => `sub:${x}`)];
    const places = (d.places || []).map((p, i) => {
      const name = el('input', { className: 'ops-input', value: p.name, ariaLabel: 'place name' });
      name.onchange = () => { p.name = name.value; renderDesigns(); };
      const deck = el('input', { className: 'ops-input design-num', type: 'number', value: p.deck, ariaLabel: 'deck' });
      deck.onchange = () => { p.deck = Number(deck.value); renderDesigns(); };
      const move = (k) => () => { const a = d.places; [a[i], a[i + k]] = [a[i + k], a[i]]; renderDesigns(); };
      const adding = ed.addingTo === i;
      const sec = el('section', { className: 'design-place' },
        el('div', { className: 'ops-form' }, el('span', { className: 'tr-label', textContent: 'Deck' }), deck, name,
          btn('↑', '', move(-1)), btn('↓', '', move(1)), tap('Default', 'default', !!p.default, () => { for (const q of d.places) delete q.default; p.default = true; renderDesigns(); }),
          btn('Remove place', '', () => { d.places.splice(i, 1); renderDesigns(); }, true)),
        pick('Stations', el('div', { className: 'tr-taps' }, ...ed.stations.map((st) => tap(st, st, p.stations.includes(st), () => { p.stations = p.stations.includes(st) ? p.stations.filter((x) => x !== st) : [...p.stations, st]; renderDesigns(); })))),
        pick('Reached via', el('div', { className: 'tr-taps' }, tap('Nothing', '', !p.via, () => { delete p.via; renderDesigns(); }), ...d.places.filter((q) => q !== p).map((q) => tap(q.name, q.name, p.via === q.name, () => { p.via = q.name; renderDesigns(); })))),
        pick('Found here', el('div', { className: 'tr-taps' }, ...(p.rows || []).map((r) => tap(`${r} ✕`, r, true, () => { p.rows = p.rows.filter((x) => x !== r); renderDesigns(); })),
          tap(adding ? 'Done adding' : 'Add a system…', 'add', adding, () => { ed.addingTo = adding ? null : i; renderDesigns(); }))),
        ...(adding ? [el('div', { className: 'tr-taps design-add' }, ...keys.filter((k) => !(p.rows || []).includes(k)).map((k) => tap(k, k, false, () => { p.rows = [...(p.rows || []), k]; renderDesigns(); })))] : []));
      sec.dataset.place = p.name;
      return sec;
    });
    // Bridge seats (the room mic): x and y in metres, the viewscreen ahead (-y).
    const seats = Object.entries(d.seats || {}).map(([st, [x, y]]) => {
      const mk = (v, j) => { const inp = el('input', { className: 'ops-input design-num', type: 'number', step: 0.1, value: v, ariaLabel: `${st} ${j ? 'y' : 'x'}` }); inp.onchange = () => { d.seats[st][j] = Number(inp.value); }; return inp; };
      return pick(st, mk(x, 0), mk(y, 1), btn('✕', '', () => { delete d.seats[st]; renderDesigns(); }, true));
    });
    // Warm-start ties: a load, and the buses it's tied to (taps).
    const ties = Object.entries(d.ties || {}).map(([k, nodes]) => pick(k, el('div', { className: 'tr-taps' }, ...['A', 'B', 'C', 'EPS'].map((n) => tap(n, n, nodes.includes(n), () => { d.ties[k] = nodes.includes(n) ? nodes.filter((x) => x !== n) : [...nodes, n]; renderDesigns(); })),
      btn('✕', '', () => { delete d.ties[k]; renderDesigns(); }, true))));
    const nameIn = el('input', { className: 'ops-input', id: 'design-name', value: d.name || '', ariaLabel: 'class name' });
    nameIn.onchange = () => { d.name = nameIn.value; renderDesigns(); };
    box.replaceChildren(...head,
      el('h3', { className: 'ops-subhead', id: 'design-title', textContent: ed.asNew ? `New class: ${ed.id || '(give it an id above)'}` : `${d.name} (config/ships/${ed.id}.json)` }),
      ...errAt('id'), ...(err && !err.field ? [el('p', { className: 'err-note', textContent: err.message })] : []),
      el('h3', { className: 'ops-subhead', textContent: 'Identity' }), field('name', pick('Name', nameIn)),
      el('h3', { className: 'ops-subhead', textContent: 'Limits' }),
      num('Low buses (each)', 'bus'), num('EPS', 'eps', 10), num('Warp core ×', 'core', 0.1), num('Top warp', 'maxWarp'), num('Shields ×', 'shields', 0.1), num('Phaser arrays', 'arrays'), num('Torpedoes', 'torpedoes'),
      num('Docking ports', 'ports', 1, { nullable: true }), num('Shuttle bay', 'bay'),
      // Solar arrays (their output; 0: none) and fusion reactors (none: a pure-solar design).
      (() => {
        const input = el('input', { className: 'ops-input design-num', type: 'number', step: 5, min: 0, value: d.solar?.output ?? 0, ariaLabel: 'solar output', id: 'design-solar' });
        const set = (v) => { if (v > 0) d.solar = { ...(d.solar || {}), output: v }; else delete d.solar; renderDesigns(); };
        input.onchange = () => set(Math.max(0, Number(input.value) || 0));
        return field('solar', pick('Solar output', btn('−', 'design-solar-down', () => set(Math.max(0, (d.solar?.output || 0) - 5))), input, btn('+', 'design-solar-up', () => set((d.solar?.output || 0) + 5))));
      })(),
      // Fuel storage: the main deuterium tank and antimatter pods (what the design holds, and a new ship of it starts with).
      ...['deuterium', 'antimatter'].map((res) => {
        const input = el('input', { className: 'ops-input design-num', type: 'number', step: 50, min: 0, value: d.fuel?.[res] ?? '', placeholder: { antimatter: '1000', deuterium: '2000' }[res], ariaLabel: `${res} storage`, id: `design-fuel-${res}` });
        const set = (v) => { d.fuel = { ...(d.fuel || {}), [res]: Math.max(0, v) }; renderDesigns(); };
        input.onchange = () => set(Number(input.value) || 0);
        return field('fuel', pick(res === 'antimatter' ? 'Antimatter pods' : 'Deuterium storage', btn('−', `design-fuel-${res}-down`, () => set((d.fuel?.[res] ?? 0) - 50)), input, btn('+', `design-fuel-${res}-up`, () => set((d.fuel?.[res] ?? 0) + 50))));
      }),
      // Its systems' own tanks (the warp core's, the impulse and fusion reactors', the torpedo bay's).
      field('fuel', pick('System tanks', el('div', { className: 'tr-taps', id: 'design-tanks' }, ...[['deu:core', 'Core (deu.)'], ['am:core', 'Core (AM)'], ['deu:port', 'Port impulse'], ['deu:starboard', 'Starboard impulse'], ['deu:aux1', 'Aux 1'], ['deu:aux2', 'Aux 2'], ['am:torpedo', 'Torpedo bay']].map(([key, label]) => {
        const input = el('input', { className: 'ops-input design-num', type: 'number', step: 10, min: 0, value: d.fuel?.tanks?.[key] ?? '', ariaLabel: `${label} tank`, id: `design-tank-${key.replace(':', '-')}` });
        input.onchange = () => { d.fuel = { ...(d.fuel || {}), tanks: { ...(d.fuel?.tanks || {}), [key]: Math.max(0, Number(input.value) || 0) } }; renderDesigns(); };
        return el('label', { className: 'design-tank' }, el('span', { textContent: label }), input);
      })))),
      field('fusion', pillBar('Fusion reactors', [tap('Aboard', 'on', d.fusion !== false, () => { delete d.fusion; renderDesigns(); }), tap('None (pure solar)', 'off', d.fusion === false, () => { d.fusion = false; renderDesigns(); })], { groupId: 'design-fusion' })),
      pick('Has', el('div', { className: 'tr-taps', id: 'design-flags' }, flag('Warp core', 'warpCore'), flag('Transporter', 'transporter'), flag('Spore drive', 'spore'), flag('Warp core replaceable', 'refit'))),
      el('h3', { className: 'ops-subhead', textContent: 'Stations' }), field('stations', stations),
      el('h3', { className: 'ops-subhead', textContent: 'Places' }), field('places', el('div', { id: 'design-places' }, ...places, btn('Add a place', 'design-add-place', () => { d.places = [...(d.places || []), { name: 'New place', deck: 1, stations: [], rows: [] }]; renderDesigns(); }))),
      el('h3', { className: 'ops-subhead', textContent: 'Bridge seats (room mic)' }), field('seats', el('div', {}, ...seats)),
      el('h3', { className: 'ops-subhead', textContent: 'Warm-start ties' }), field('ties', el('div', {}, ...ties)),
      el('h3', { className: 'ops-subhead', textContent: 'Org chart' }), el('p', { className: 'ops-hint', textContent: 'Positions and ranks: coming with the org chart.' }),
      ...(ed.confirm ? [el('div', { className: 'ops-notice', id: 'design-confirm' }, el('p', { textContent: `Live ships of this class (${ed.confirm.ships.join(', ')}) use what this removes: ${[...ed.confirm.places, ...ed.confirm.rows].join(', ')}.` }),
        btn('Save anyway', 'design-save-anyway', () => save(true), true))] : []),
      el('div', { className: 'ops-form' }, btn(ed.asNew ? 'Save as a new class' : 'Save', 'design-save', () => save(false)),
        ...(ed.asNew ? [] : [btn('Revert', 'design-revert', () => { ed.draft = clone(ed.files[ed.id]); ed.error = null; ed.note = ''; renderDesigns(); })]),
        el('span', { className: ed.note && ed.note.startsWith('saved') ? 'ops-hint ok-note' : 'ops-hint err-note', id: 'design-status', textContent: ed.note })));
  }
  function save(confirm) {
    if (ed.asNew) ed.id = (ed.newId || ed.id || '').trim().toLowerCase();
    send({ type: 'admin', action: 'design-save', id: ed.id, design: ed.draft, asNew: ed.asNew, confirm });
  }
  window.__editor = { get state() { return ed; } };

  connect();
  window.addEventListener('screenchange', (ev) => { renderChart(); if (ev.detail === 'designs') send({ type: 'admin', action: 'designs' }); if (ev.detail === 'users') send({ type: 'admin', action: 'users' }); if (ev.detail === 'settings') send({ type: 'admin', action: 'settings' }); });

  // --- Settings (data/settings.json): where the relay listens, registration, admin access ---
  // Typed: the address and port; taps: the rest. Saved, the supervisor restarts the relay on
  // it; a new address is shown, and this page goes there once the relay is up on it.
  let st = { draft: null, last: null, error: null, note: '', moving: null };
  function settingsMessage(m) {
    st.last = m;
    if (!st.draft || m.saved) st.draft = { ...m.settings };
    st.error = m.error || null;
    if (m.saved) {
      st.note = m.moving ? '' : 'Saved: the relay restarts to apply it';
      if (m.moving) { const e = m.settings, host = !e.host || e.host === '0.0.0.0' || e.host === '::' ? location.hostname : e.host; st.moving = `${location.protocol}//${host.includes(':') ? `[${host}]` : host}:${e.port}/admin`; setTimeout(() => { location.href = st.moving; }, 8000); }
    } else if ('saved' in m) st.note = 'Not saved';
    banner(m);
    renderSettings();
  }
  function banner(m) {
    const b = $('admin-banner');
    b.hidden = !!m.accounts;
    if (!m.accounts) b.textContent = `Admin: ${m.settings.adminAccess === 'lan' ? 'this network (LAN)' : 'localhost only'}. No accounts yet: register the first (admin) account to require logins.`;
  }
  function renderSettings() {
    const box = $('admin-settings'), m = st.last, d = st.draft;
    if (!m || !d) return;
    const field = (k) => (st.error?.field === k ? [el('span', { className: 'err-note design-error', textContent: st.error.message })] : []);
    const input = (k, id, ph) => { const i = el('input', { className: 'ops-input', id, value: String(d[k] ?? ''), placeholder: ph, autocomplete: 'off' }); i.onchange = () => { d[k] = k === 'port' ? Number(i.value) : i.value.trim(); }; return i; };
    const pick = (k, label, opts) => pillBar(label, opts.map(([v, t]) => { const b = tap(t, v, d[k] === v, () => { d[k] = v; renderSettings(); }); b.id = `settings-${k}-${v}`; return b; }), { groupId: `settings-${k}` });
    const e = m.effective;
    box.replaceChildren(
      el('p', { className: 'st-state', id: 'settings-now', textContent: `Listening on ${m.listening.host || 'every interface'}, port ${m.listening.port}` }),
      ...(e.overridden.port || e.overridden.host ? [el('p', { className: 'ops-notice', textContent: `${[e.overridden.host && 'HOST', e.overridden.port && 'PORT'].filter(Boolean).join(' and ')} set in the environment: that wins over these settings.` })] : []),
      el('h3', { className: 'ops-subhead', textContent: 'Address' }),
      el('div', { className: 'design-field settings-form', id: 'settings-field-host' }, pillBar('IP address', [input('host', 'settings-host', 'every interface (empty), or an IP')]), ...field('host')),
      el('div', { className: 'design-field settings-form', id: 'settings-field-port' }, pillBar('Port', [input('port', 'settings-port', '8085')]), ...field('port')),
      el('p', { className: 'ops-hint', textContent: 'Port 8080 is kept for coturn. A new address is tried first (free, and one this machine has); the relay then restarts on it.' }),
      el('h3', { className: 'ops-subhead', textContent: 'Accounts' }),
      pick('registration', 'Registration', [['open', 'Open'], ['approval', 'Admin approval'], ['closed', 'Closed']]),
      el('p', { className: 'ops-hint', textContent: 'Open: a new account can log in at once. Admin approval: it waits in Users for Approve. Closed: only an admin adds accounts. (The first account is always the admin.)' }),
      pick('adminAccess', 'Admin page from', [['localhost', 'This machine only'], ['lan', 'LAN (admins only)']]),
      el('div', { className: 'ops-form' }, btn('Save settings', 'settings-save', () => send({ type: 'admin', action: 'settings-save', settings: { ...d } })),
        ...(m.supervised ? [btn('Restart the relay now', 'settings-restart', () => send({ type: 'admin', action: 'restart-relay' }))] : [])),
      el('p', { className: `ops-hint ${st.error ? 'err-note' : 'ok-note'}`, id: 'settings-status', textContent: st.error ? `Not saved: ${st.error.message}` : st.note }),
      ...(st.moving ? [el('p', { className: 'st-state', id: 'settings-moving' }, 'The relay is moving to ', el('a', { className: 'settings-url', href: st.moving, textContent: st.moving }), m.supervised ? ': this page follows it in a few seconds.' : ': restart it (npm start runs the supervisor, which does that itself).')] : []));
  }

  // --- Users: the accounts (a username, not a character), their roles and status ----------
  let us = { last: null, newRole: 'player' };
  function usersMessage(m) { us.last = m; renderUsers(); }
  function renderUsers() {
    const box = $('admin-users'), m = us.last;
    if (!m) return;
    const day = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '—');
    const act = (u, change, text, alert, ask) => btn(text, `user-${change}-${u.username}`, () => { if (!ask || confirm(ask)) send({ type: 'admin', action: 'user', username: u.username, change }); }, alert);
    const actions = (u) => (u.status === 'pending' ? [act(u, 'approve', 'Approve'), act(u, 'reject', 'Reject', true, `Reject ${u.username}'s account?`)]
      : [u.status === 'active' ? act(u, 'disable', 'Disable', true) : act(u, 'enable', 'Enable'), u.role === 'admin' ? act(u, 'demote', 'Make player') : act(u, 'promote', 'Make admin'),
        act(u, 'reset-password', 'New password', false, `Give ${u.username} a new password? It's shown here once.`), act(u, 'logout', 'Log out'), act(u, 'delete', 'Delete', true, `Delete the account ${u.username}? Its characters are not touched.`)]);
    const name = el('input', { className: 'ops-input', id: 'user-new-name', placeholder: 'Username', autocomplete: 'off' });
    const pass = el('input', { className: 'ops-input', id: 'user-new-password', placeholder: 'Password (6 or more)', type: 'password', autocomplete: 'new-password' });
    const roles = pillBar('Role', [['player', 'Player'], ['admin', 'Admin']].map(([v, t]) => tap(t, v, us.newRole === v, () => { us.newRole = v; renderUsers(); })), { groupId: 'user-new-role' });
    box.replaceChildren(
      ...(m.temp ? [el('p', { className: 'user-temp', id: 'user-temp', textContent: `New password for ${m.temp.username}: ${m.temp.password} (shown once: pass it on)` })] : []),
      ...(m.error || m.note ? [el('p', { className: `ops-hint ${m.error ? 'err-note' : 'ok-note'}`, id: 'users-status', textContent: m.error || m.note })] : []),
      el('h3', { className: 'ops-subhead', textContent: `Accounts · registration ${{ open: 'open', approval: 'by admin approval', closed: 'closed' }[m.registration]}` }),
      m.users.length ? el('table', { className: 'user-table', id: 'user-table' },
        el('tr', {}, ...['Username', 'Role', 'Status', 'Created', 'Last login', 'Characters', 'Aboard now', ''].map((h) => el('th', { textContent: h }))),
        ...m.users.map((u) => {
          const tr = el('tr', {}, el('td', { className: 'user-name', textContent: `${u.username}${u.username === m.me ? ' (you)' : ''}` }), el('td', { textContent: u.role }), el('td', { textContent: u.status }),
            el('td', { textContent: day(u.created) }), el('td', { textContent: day(u.lastLogin) }), el('td', { textContent: u.characters.join(', ') || '—' }), el('td', { textContent: u.online.join(', ') || '—' }),
            el('td', {}, pillCluster(...actions(u))));
          tr.dataset.user = u.username; tr.dataset.status = u.status;
          return tr;
        })) : el('p', { className: 'ops-hint', textContent: 'No accounts yet: the first one registered (on the log-in page) is the admin.' }),
      el('h3', { className: 'ops-subhead', textContent: 'Add a user' }),
      el('div', { className: 'ops-form' }, name, pass), roles,
      el('div', { className: 'ops-form' }, btn('Add', 'user-add', () => send({ type: 'admin', action: 'user-create', username: name.value.trim(), password: pass.value, role: us.newRole }))));
  }
})();
