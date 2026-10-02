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
    ws.onopen = () => { $('admin-link').dataset.status = 'online'; $('admin-link').textContent = 'Relay online'; send({ type: 'admin', action: 'status' }); };
    ws.onclose = () => { $('admin-link').dataset.status = 'offline'; $('admin-link').textContent = 'Relay offline: reconnecting'; setTimeout(connect, 2000); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'hello') { designs = m.designs || {}; system = m.system || null; $('admin-relay-name').textContent = `Relay admin · ${m.relay || ''}`; renderCreate(true); }
      if (m.type === 'admin-status') { status = m; render(); }
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
  function renderFleet() {
    const fleet = status.fleet || [], computers = new Map((status.ships || []).map((x) => [x.ship, x]));
    $('admin-fleet').replaceChildren(
      el('tr', {}, ...['Vessel', 'Class', 'Crew', 'Ops', 'Position', "Ship's computer", ''].map((h) => el('th', { textContent: h }))),
      ...fleet.map((v) => {
        const c = computers.get(v.name);
        const tr = el('tr', {}, el('td', { textContent: v.name }), el('td', { textContent: v.starbase ? 'Starbase' : v.class || '' }), el('td', { textContent: String(v.crew ?? '') }),
          el('td', { textContent: v.ops ? 'manned' : '—' }), el('td', { textContent: v.x != null ? `${v.x}, ${v.y}` : '' }),
          el('td', { textContent: v.starbase ? 'automated (the relay)' : c ? `${c.connected ? 'connected' : 'not connected'}${c.primary?.length ? ', flying it' : ''} · ${ago(c.since)}` : v.computer ? 'connected (not the supervisor\'s)' : 'offline' }),
          el('td', {}, ...(c ? [btn('Restart', `admin-restart-${v.name}`, () => send({ type: 'admin', action: 'restart-ship', ship: v.name }))] : [])));
        tr.dataset.vessel = v.name;
        return tr;
      }));
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
    box.replaceChildren(el('p', { className: 'ops-hint', textContent: system ? `${system.name}: ${system.size} × ${system.size}` : '' }), chartSvg({ size: system?.size || 1000, bases: status.bases || [], fleet: status.fleet || [] }));
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

  connect();
  window.addEventListener('screenchange', () => renderChart());
})();
