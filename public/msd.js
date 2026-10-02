// The Master Systems Display: a port profile of the ship (bow to the left)
// on a grid, with labelled pills that light as systems come up (tap one to
// open that system's screen), a power budget, a tile per system and an
// Engineering event log. The ship drawing is adapted from John's "Enterprise
// Main Engineering" page; starbases get a simple station outline.
//
//   const msd = createMSD(container, { open: (system) => ..., starbase: false });
//   msd.update(own, events)   // own: the nav message's own ship; events: [{ at, text, cls }]
(function () {
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const COL = () => ({
    line: '#1a1a2a', panel: '#141414', dim: '#555', tan: css('--lcars-tan'), orange: css('--lcars-orange'), sky: css('--lcars-sky'),
    lav: css('--lcars-lilac'), peach: css('--lcars-peach'), ok: '#66cc66', warn: css('--lcars-gold'), bad: css('--lcars-red'), off: '#444',
  });
  const STATUS_COL = (col, st) => ({ ok: col.ok, warn: col.warn, bad: col.bad, busy: col.sky, off: col.off }[st] || col.off);

  function prep(cv, vw, vh) {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return null;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const c = cv.getContext('2d'); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cv.width, cv.height);
    const s = Math.min(cv.width / vw, cv.height / vh); c.setTransform(s, 0, 0, s, (cv.width - vw * s) / 2, (cv.height - vh * s) / 2);
    cv._s = s; cv._ox = (cv.width - vw * s) / 2; cv._oy = (cv.height - vh * s) / 2; return c;
  }
  const glow = (c, color, blur) => { c.shadowColor = color; c.shadowBlur = blur; };
  const font = (c, px) => { c.font = `${px}px Antonio, "Arial Narrow", sans-serif`; };

  // Markers on the profile: where each system is, where its label sits, and the system it stands for.
  const SHIPMARK = [
    { go: 'sens', x: 96, y: 98, lx: 20, ly: 30, l: 'Lateral sensors' },
    { go: 'env', x: 200, y: 92, lx: 178, ly: 30, l: 'Life support' },
    { go: 'comp', x: 330, y: 88, lx: 312, ly: 30, l: 'Computer cores' },
    { go: 'trans', x: 480, y: 92, lx: 470, ly: 30, l: 'Transporters' },
    { go: 'fusion', x: 594, y: 96, lx: 612, ly: 30, l: 'Impulse reactors' },
    { go: 'prop', x: 870, y: 88, lx: 860, ly: 30, l: 'Warp nacelle' },
    { go: 'comm', x: 250, y: 112, lx: 200, ly: 270, l: 'Subspace antenna' },
    { go: 'defl', x: 532, y: 180, lx: 380, ly: 270, l: 'Deflector' },
    { go: 'warp', x: 618, y: 150, lx: 540, ly: 240, l: 'Warp core' },
    { go: 'fuel', x: 660, y: 196, lx: 620, ly: 285, l: 'Antimatter pods' },
    { go: 'eps', x: 720, y: 170, lx: 740, ly: 240, l: 'EPS taps' },
    { go: 'sif', x: 800, y: 180, lx: 850, ly: 270, l: 'SIF generators' },
  ];
  const BASEMARK = [
    { go: 'sens', x: 500, y: 60, lx: 40, ly: 30, l: 'Sensors' },
    { go: 'env', x: 420, y: 150, lx: 200, ly: 30, l: 'Life support' },
    { go: 'comp', x: 580, y: 150, lx: 360, ly: 30, l: 'Computer cores' },
    { go: 'fusion', x: 380, y: 210, lx: 600, ly: 30, l: 'Fusion reactors' },
    { go: 'comm', x: 500, y: 25, lx: 780, ly: 30, l: 'Subspace antenna' },
    { go: 'warp', x: 500, y: 150, lx: 380, ly: 270, l: 'Warp core' },
    { go: 'eps', x: 620, y: 210, lx: 560, ly: 270, l: 'EPS taps' },
    { go: 'sif', x: 500, y: 250, lx: 740, ly: 270, l: 'SIF generators' },
  ];

  // Each system's status (ok / warn / bad / busy / off) and a word for its tile.
  function statuses(own) {
    const g = own.grid, p = own.power, cs = g.computers || [];
    const drives = Object.values(g.drives || {}), aux = Object.values(g.aux || {}), tr = own.transporter || {};
    const level = (v, full = 100) => (v >= full ? 'ok' : v > 0 ? 'warn' : 'off');
    // (Nothing coming in: Standby when it's untied or limited to 0, switched off on purpose; No power when it's tied but unfed.)
    const pct = (sys, v, full = 100) => (v > 0 ? [level(v, full), `${v}%`] : (g.ties?.[`system:${sys}`] || []).length && own.allocated?.[sys] !== 0 ? ['warn', 'No power'] : ['off', 'Standby']);
    const fusionUp = [...drives, ...aux].filter((x) => x.state === 'running').length;
    return {
      sens: pct('lateral', p.lateral),
      lrs: pct('sensors', p.sensors),
      env: [p.lifeSupport >= 100 ? 'ok' : p.lifeSupport >= 50 ? 'warn' : p.lifeSupport > 0 ? 'bad' : 'off', `${p.lifeSupport}%`],
      atmo: pct('atmosphere', p.atmosphere), thermal: pct('thermal', p.thermal), gravity: pct('gravity', p.gravity), lighting: pct('lighting', p.lighting),
      comp: [cs.every((x) => x.state === 'online') ? 'ok' : cs.some((x) => x.state === 'booting') ? 'busy' : cs.some((x) => x.state === 'online') ? 'warn' : cs.some((x) => x.state === 'crashed') ? 'bad' : 'off',
        cs.some((x) => x.state === 'booting') ? 'Booting' : `${cs.filter((x) => x.state === 'online').length} of ${cs.length}`],
      trans: [tr.fault ? 'bad' : tr.diag?.state === 'passed' ? 'ok' : tr.diag?.state === 'running' ? 'busy' : 'warn', tr.fault ? 'Offline' : tr.diag?.state === 'passed' ? 'Ready' : tr.diag?.state === 'running' ? 'Diagnostic' : 'Needs diagnostic'],
      fusion: [fusionUp && fusionUp === drives.length + aux.length ? 'ok' : [...drives, ...aux].some((x) => x.state === 'starting') ? 'busy' : fusionUp ? 'warn' : 'off', [...drives, ...aux].some((x) => x.state === 'starting') ? 'Igniting' : `${fusionUp} online`],
      impulse: [own.speed?.impulse > 0 ? 'ok' : 'off', own.speed?.impulse > 0 ? `${Math.round(own.speed.impulse * 400)}% impulse max` : own.speed?.why?.impulse || 'Off'],
      prop: [own.speed?.warp >= 1 ? 'ok' : 'off', own.speed?.warp >= 1 ? `Warp ${own.speed.warp} max` : 'No warp'],
      comm: [g.subOk?.subspace === false ? 'bad' : 'ok', g.subOk?.subspace === false ? 'No power' : 'Online'],
      // (The deflector draws only while the ship moves: ready at rest is Standby.)
      defl: p.deflector > 0 ? [level(p.deflector, 90), `${p.deflector}%`] : (own.capacity?.deflector ?? 0) >= 90 && p.sensors > 0 ? ['ok', 'Standby'] : ['off', 'Off'],
      warp: [g.core === 'online' ? (g.warpCore?.breachT != null ? 'bad' : 'ok') : g.core === 'starting' ? 'busy' : g.core === 'ejected' ? 'bad' : 'off',
        g.warpCore?.breachT != null ? `BREACH ${g.warpCore.breachT} s` : { online: `Running ${g.warpCore?.actual ?? ''}%`, starting: 'Ignition', offline: 'Cold', ejected: 'Ejected' }[g.core]],
      fuel: [!g.antimatter ? 'off' : g.breach != null ? 'bad' : g.contain?.onReserve ? 'warn' : 'ok', !g.antimatter ? 'No antimatter' : `${g.contain?.field}% field${g.contain?.onReserve ? ' · reserve' : ''}`],
      // The fuel buses: the systems' own tanks at their lighting level, or filling.
      deut: (() => { const sys = ['deu', 'am'].flatMap((b) => g.fuel?.[b]?.tanks.filter((t) => t.name !== 'main' && t.name !== 'torpedo') || []); const low = sys.filter((t) => t.pct < (g.fuel?.deu?.light ?? 30));
        return [g.fuel?.am?.down ? 'bad' : !low.length ? 'ok' : g.fuel?.deu?.flow || g.fuel?.am?.flow ? 'busy' : 'warn', g.fuel?.am?.down ? 'AM bus offline' : `D ${g.deuterium} · AM ${g.antimatter}`]; })(),
      eps: [g.epsLive ? 'ok' : g.epsGen >= g.epsChargeGen ? 'busy' : 'off', g.epsLive ? 'Energized' : g.epsGen >= g.epsChargeGen ? 'Charging' : 'Dead'],
      sif: p.sif > 0 ? [p.sif >= 90 ? 'ok' : p.sif >= 50 ? 'warn' : 'bad', `${p.sif}%`] : pct('sif', 0),
      idf: p.idf > 0 ? [p.idf >= 90 ? 'ok' : p.idf >= 50 ? 'warn' : 'bad', `${p.idf}%`] : pct('idf', 0),
      shld: [own.shieldsUp ? 'ok' : 'off', own.shieldsUp ? `Up ${own.combat?.shield ?? ''}%` : 'Down'],
      batt: (() => { const b = ['A', 'B', 'C'].map((n) => g.stores?.[n]).filter(Boolean); const avg = Math.round(b.reduce((a, x) => a + x.level, 0) / (b.length || 1)); return [b.some((x) => x.breaker) ? (avg >= 25 ? 'ok' : 'warn') : 'off', `${avg}%${b.some((x) => x.supplying) ? ' · supplying' : ''}`]; })(),
      ext: [g.docked || Object.values(g.ports || {}).some((v) => v?.ship) ? (Object.values(g.cells?.dock || {}).some((v) => v) || Object.values(g.cells?.ship || {}).some((v) => v) ? 'ok' : 'warn') : 'off', g.docked ? `Docked: ${g.docked}` : 'Not docked'],
      tractor: [g.towing ? 'ok' : 'off', g.towing ? `Towing the ${g.towing}` : 'Standby'],
    };
  }
  const TILES = [['fuel', 'Antimatter containment'], ['batt', 'Bus batteries'], ['comp', 'Computer cores'], ['deut', 'Fuel buses'], ['fusion', 'Fusion reactors'], ['eps', 'EPS grid'],
    ['atmo', 'Atmosphere'], ['thermal', 'Thermal'], ['gravity', 'Gravity'], ['lighting', 'Emergency lighting'], ['sif', 'Structural integrity'], ['idf', 'Inertial dampers'],
    ['lrs', 'Long-range sensors'], ['sens', 'Lateral sensors'], ['comm', 'Communications'], ['warp', 'Warp core'], ['defl', 'Deflector'], ['shld', 'Shields'], ['trans', 'Transporters'],
    ['impulse', 'Impulse'], ['prop', 'Warp drive'], ['ext', 'Dock and solar power'], ['tractor', 'Tractor beam']];

  // The ship's places, by deck (the design's, window.PLACES): each one's power path
  // (its conduit) and what's in it, its consoles and systems, with their state.
  const WORST = ['ok', 'busy', 'off', 'warn', 'bad'];
  function placeStates(own) {
    const g = own.grid, p = own.power || {};
    const tied = (key) => g.ties?.[key] || [], cut = (key) => g.cutOff?.[key] || [];
    const via = (key) => tied(key).filter((n) => !cut(key).includes(n));
    const item = (key, name) => {
      if (!g.tieNodes?.[key]) return null;
      if (tied(key).length && !via(key).length) return [name, 'bad', 'Cut off'];
      if (!tied(key).length) return [name, 'off', 'Standby']; // (untied: switched off on purpose)
      if (key.startsWith('sub:') && g.subOk?.[key.slice(4)] === false) return [name, 'bad', 'No power'];
      const v = p[key.slice(7)];
      if (key.startsWith('system:') && typeof v === 'number') return [name, v >= 90 ? 'ok' : v > 0 ? 'warn' : 'off', `${v}%`];
      return [name, 'ok', 'Powered'];
    };
    return (window.PLACES || []).slice().sort((a, b) => a.deck - b.deck).map((pl) => {
      const conduit = `place:${pl.name}`;
      const items = [
        ...pl.stations.filter((st) => g.consoleOk && st in g.consoleOk).map((st) => [`${st} console`, g.consoleOk[st] ? 'ok' : 'off', g.consoleOk[st] ? 'Online' : 'No power']),
        ...(pl.rows || []).map((key) => item(key, key.startsWith('sub:') ? g.subsystems?.[key.slice(4)]?.name || key.slice(4) : g.sysNames?.[key.slice(7)] || key.replace(/^\w+:/, ''))).filter(Boolean),
      ];
      const path = !g.tieNodes?.[conduit] ? null : via(conduit).length ? ['ok', via(conduit).map((n) => (n === 'EPS' ? 'EPS' : `Bus ${n}`)).join(', ')] : tied(conduit).length ? ['bad', 'Cut off'] : ['off', 'Standby'];
      const worst = [path?.[0], ...items.map((x) => x[1])].filter(Boolean).reduce((a, b) => (WORST.indexOf(b) > WORST.indexOf(a) ? b : a), 'ok');
      return { name: pl.name, deck: pl.deck, path, items, state: worst };
    }).filter((x) => x.items.length || x.path);
  }

  window.createMSD = function createMSD(root, { open = () => {}, starbase = false } = {}) {
    const h = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
    const cv = h('canvas', { className: 'msd-canvas', ariaLabel: 'Ship profile: tap a label to open that system' });
    const overall = h('p', { className: 'msd-overall', id: 'msd-overall' });
    const budget = h('div', { className: 'msd-budget', id: 'msd-budget' });
    const tiles = h('div', { className: 'msd-tiles', id: 'msd-tiles' });
    const log = h('ol', { className: 'msd-log', id: 'msd-log' });
    const places = h('div', { className: 'msd-places', id: 'msd-places' });
    root.replaceChildren(
      h('section', { className: 'msd-card msd-card--ship' }, h('h3', { textContent: 'Master systems display' }), overall, cv,
        h('p', { className: 'ops-hint', textContent: `${starbase ? 'Station outline' : 'Port profile, bow to the left'}. Labels light as systems come up. Select a label to open that console.` })),
      h('div', { className: 'msd-grid' },
        h('section', { className: 'msd-card msd-card--budget' }, h('h3', { textContent: 'Power budget' }), budget),
        h('section', { className: 'msd-card msd-card--status' }, h('h3', { textContent: 'System status' }), tiles)),
      h('section', { className: 'msd-card msd-card--places' }, h('h3', { textContent: 'Locations aboard' }), places),
      h('section', { className: 'msd-card msd-card--log' }, h('h3', { textContent: 'Engineering event log' }), log));
    let own = null, st = {};
    const marks = starbase ? BASEMARK : SHIPMARK;

    function drawShip(c, t, col) {
      const g = own.grid, w = g.warpCore || {}, rate = g.core === 'online' ? (w.actual || 0) / 100 : g.core === 'starting' ? 0.05 : 0;
      const sh = own.shieldsUp ? (own.combat?.shield ?? 100) / 100 : 0;
      if (sh > 0) { c.save(); c.globalAlpha = sh * (0.35 + 0.1 * Math.sin(t * 2)); c.strokeStyle = col.sky; c.lineWidth = 3; glow(c, col.sky, 18); c.beginPath(); c.ellipse(510, 140, 500, 128, 0, 0, Math.PI * 2); c.stroke(); c.globalAlpha = sh * 0.06; c.fillStyle = col.sky; c.fill(); c.restore(); }
      const emergency = Object.values(g.totals || {}).some((x) => x.available > 0);
      c.lineWidth = 1.6; c.fillStyle = col.panel; c.strokeStyle = emergency ? col.tan : col.dim;
      // pylon + nacelle
      c.beginPath(); c.moveTo(720, 158); c.lineTo(772, 158); c.lineTo(880, 98); c.lineTo(832, 98); c.closePath(); c.fill(); c.stroke();
      c.beginPath(); c.roundRect(700, 76, 292, 24, 12); c.fill(); c.stroke();
      const coils = own.speed?.warp >= 1 ? Math.min(1, (own.power.engines || 0) / 100) : 0;
      c.save(); c.fillStyle = col.sky; c.globalAlpha = 0.15 + coils * 0.85; if (coils > 0) glow(c, col.sky, 14 * coils); c.fillRect(740, 90, 236, 5); c.restore();
      c.save(); c.fillStyle = col.bad; c.globalAlpha = 0.2 + rate * 0.8; if (rate > 0) glow(c, col.bad, 20 * rate); c.beginPath(); c.ellipse(712, 88, 10, 10, 0, 0, Math.PI * 2); c.fill(); c.restore();
      // engineering hull
      c.beginPath(); c.moveTo(520, 172); c.bezierCurveTo(560, 150, 700, 148, 900, 160); c.bezierCurveTo(932, 165, 936, 186, 906, 193); c.bezierCurveTo(760, 207, 600, 208, 525, 192); c.closePath(); c.fill(); c.stroke();
      // neck
      c.beginPath(); c.moveTo(430, 114); c.lineTo(560, 104); c.lineTo(684, 166); c.lineTo(560, 168); c.closePath(); c.fill(); c.stroke();
      // saucer
      c.beginPath(); c.moveTo(30, 99); c.bezierCurveTo(120, 70, 420, 60, 604, 92); c.lineTo(606, 100); c.bezierCurveTo(480, 124, 150, 126, 30, 103); c.closePath(); c.fill(); c.stroke();
      c.beginPath(); c.ellipse(300, 71, 30, 6, 0, Math.PI, 0); c.fill(); c.stroke();
      // windows: lit with atmosphere and heat, emergency red with only the lights
      const lit = own.power.atmosphere > 0 && own.power.thermal > 0, em = own.power.lighting > 0;
      if (lit || em) {
        c.fillStyle = lit ? col.tan : col.bad; c.globalAlpha = lit ? 0.85 : 0.35 + 0.15 * Math.sin(t * 3);
        for (let x = 60; x < 580; x += 13) c.fillRect(x, 99 + Math.abs(x - 320) * 0.004, 3, 2);
        for (let x = 565; x < 890; x += 14) c.fillRect(x, 177, 3, 2);
        c.globalAlpha = 1;
      }
      // deflector
      const df = Math.min(1, (own.power.deflector || 0) / 100); c.save(); c.beginPath(); c.arc(532, 180, 14, 0, Math.PI * 2); c.fillStyle = df > 0 ? col.orange : '#140c06'; c.globalAlpha = 0.25 + df * 0.75; if (df > 0) glow(c, col.orange, 22 * df); c.fill(); c.restore();
      // impulse
      const im = Math.min(1, (own.speed?.impulse || 0) / 0.25); c.save(); c.fillStyle = col.bad; c.globalAlpha = 0.2 + im * 0.8; if (im > 0) glow(c, col.bad, 16 * im); c.fillRect(590, 92, 14, 8); c.restore();
      // warp core
      const constr = g.subOk?.constriction !== false && g.core !== 'offline' ? 1 : 0;
      c.save(); c.strokeStyle = col.sky; c.lineWidth = 6; c.globalAlpha = 0.15 + Math.min(1, rate * 1.4 + constr * 0.2) * 0.85; if (rate > 0) glow(c, col.sky, 16 * rate); c.beginPath(); c.moveTo(618, 112); c.lineTo(618, 198); c.stroke();
      if (rate > 0) { c.fillStyle = '#fff'; for (let k = 0; k < 3; k++) { const p = (t * (1 + 3 * rate) + k / 3) % 1; c.globalAlpha = rate; c.fillRect(615, 112 + p * 40, 6, 3); c.fillRect(615, 198 - p * 40, 6, 3); } }
      c.restore();
    }
    function drawStation(c, t, col) {
      const g = own.grid, rate = g.core === 'online' ? (g.warpCore?.actual || 0) / 100 : 0;
      c.lineWidth = 1.6; c.fillStyle = col.panel; c.strokeStyle = col.tan;
      c.beginPath(); c.ellipse(500, 60, 140, 26, 0, 0, Math.PI * 2); c.fill(); c.stroke(); // upper dish
      c.beginPath(); c.roundRect(470, 60, 60, 190, 12); c.fill(); c.stroke(); // core shaft
      c.beginPath(); c.ellipse(500, 210, 220, 30, 0, 0, Math.PI * 2); c.fill(); c.stroke(); // docking ring
      c.beginPath(); c.moveTo(500, 25); c.lineTo(500, 0); c.stroke(); // antenna
      c.save(); c.strokeStyle = col.sky; c.lineWidth = 6; c.globalAlpha = 0.15 + rate * 0.85; if (rate > 0) glow(c, col.sky, 16 * rate); c.beginPath(); c.moveTo(500, 90); c.lineTo(500, 230); c.stroke(); c.restore();
    }
    function draw(t) {
      if (!own) return;
      const c = prep(cv, 1000, 300);
      if (!c) return;
      const col = COL();
      c.strokeStyle = col.line; c.lineWidth = 1;
      for (let x = 0; x <= 1000; x += 50) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, 300); c.stroke(); }
      for (let y = 0; y <= 300; y += 50) { c.beginPath(); c.moveTo(0, y); c.lineTo(1000, y); c.stroke(); }
      (starbase ? drawStation : drawShip)(c, t, col);
      font(c, 13); c.textBaseline = 'middle';
      for (const m of marks) {
        const colr = STATUS_COL(col, st[m.go]?.[0]);
        c.strokeStyle = colr; c.globalAlpha = 0.6; c.lineWidth = 1; c.beginPath(); c.moveTo(m.x, m.y); c.lineTo(m.x, m.ly < 150 ? m.ly + 8 : m.ly - 8); c.lineTo(m.lx, m.ly < 150 ? m.ly + 8 : m.ly - 8); c.stroke(); c.globalAlpha = 1;
        c.fillStyle = colr; c.beginPath(); c.arc(m.x, m.y, 4, 0, Math.PI * 2); c.fill();
        const w = c.measureText(m.l.toUpperCase()).width + 16; m.w = w;
        c.beginPath(); c.roundRect(m.lx - 2, m.ly - 9, w, 18, 9); c.fill(); c.fillStyle = '#000'; c.fillText(m.l.toUpperCase(), m.lx + 6, m.ly + 1);
      }
    }
    // Tap a label pill: open that system.
    cv.addEventListener('click', (ev) => {
      const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      const x = ((ev.clientX - r.left) * dpr - (cv._ox || 0)) / (cv._s || 1), y = ((ev.clientY - r.top) * dpr - (cv._oy || 0)) / (cv._s || 1);
      const m = marks.find((k) => k.w && x >= k.lx - 2 && x <= k.lx - 2 + k.w && y >= k.ly - 9 && y <= k.ly + 9);
      if (m) open(m.go);
    });
    // Animate only while it's on screen.
    let raf = 0;
    const loop = (ms) => { raf = 0; if (!root.isConnected || root.closest('[hidden]')) return; draw(ms / 1000); raf = requestAnimationFrame(loop); };
    const kick = () => { if (!raf && root.isConnected && !root.closest('[hidden]')) raf = requestAnimationFrame(loop); };
    window.addEventListener('screenchange', kick);

    function update(next, events = []) {
      own = next;
      if (!own?.grid) return;
      st = statuses(own);
      const g = own.grid;
      // The overall state.
      const anyBus = Object.entries(g.totals || {}).some(([n, x]) => n !== 'EPS' && x.available > 0);
      const states = Object.values(st).map((x) => x[0]);
      const word = !anyBus && !g.epsLive ? ['Dark ship', 'bad'] : !g.epsLive && g.core !== 'online' ? ['Emergency power', 'warn'] : states.every((x) => x === 'ok' || x === 'off') && g.core === 'online' && g.epsLive ? ['All systems operational', 'ok'] : ['Partial power', 'warn'];
      overall.textContent = word[0]; overall.dataset.state = word[1];
      // The power budget.
      const gen = Object.entries(g.cells || {}).filter(([k]) => ['solar', 'dock', 'ship', 'impulsePort', 'impulseStarboard', 'aux1', 'aux2', 'core'].includes(k)).reduce((n, [, v]) => n + Object.values(v).reduce((a, b) => a + Math.max(0, b), 0), 0);
      const fusion = ['impulsePort', 'impulseStarboard', 'aux1', 'aux2'].reduce((n, k) => n + Object.values(g.cells?.[k] || {}).reduce((a, b) => a + Math.max(0, b), 0), 0);
      const epsDemand = g.totals?.EPS?.used || 0, epsSupply = Math.max(1, g.totals?.EPS?.available || 0);
      const batt = ['A', 'B', 'C'].map((n) => g.stores?.[n]?.level ?? 0);
      const battPct = Math.round(batt.reduce((a, b) => a + b, 0) / batt.length);
      const ready = ['comp', 'fuel', 'deut', 'fusion', 'eps', 'warp', 'sif', 'idf', 'env', 'sens'].filter((k) => st[k]?.[0] === 'ok').length;
      const bar = (label, value, frac, color, warnIf) => h('div', { className: 'msd-bar' }, h('span', { className: 'msd-bar__label', textContent: label }),
        h('span', { className: 'msd-bar__track' }, (() => { const f = h('span', { className: 'msd-bar__fill' }); f.style.width = `${Math.max(0, Math.min(100, frac * 100))}%`; f.style.background = warnIf ? 'var(--lcars-red)' : color; return f; })()), h('b', { textContent: value }));
      budget.replaceChildren(
        bar('Generation', `${Math.round(gen)}`, gen / 1500, 'var(--lcars-orange)'),
        bar('EPS demand', `${epsDemand} of ${g.totals?.EPS?.available || 0}`, epsDemand / epsSupply, 'var(--lcars-lilac)', epsDemand > 0.95 * epsSupply && epsDemand > 0),
        bar('Warp core output', `${g.coreOutput || 0}`, (g.coreOutput || 0) / (g.coreMax || 1000), 'var(--lcars-sky)'),
        bar('Fusion', `${Math.round(fusion)}`, fusion / 300, 'var(--lcars-tan)'),
        bar('Battery charge', `${battPct}%`, battPct / 100, 'var(--lcars-peach)', battPct < 25),
        bar('Readiness', `${Math.round((ready / 10) * 100)}%`, ready / 10, '#66cc66'));
      tiles.replaceChildren(...TILES.filter(([k]) => !starbase || !['prop', 'defl', 'impulse'].includes(k)).map(([k, name]) => {
        const [s, text] = st[k] || ['off', ''];
        const b = h('button', { type: 'button', className: 'msd-tile' }, h('span', { textContent: name }), h('span', { className: 'msd-pill', textContent: text }));
        b.querySelector('.msd-pill').dataset.state = s;
        b.dataset.system = k;
        b.onclick = () => open(k);
        return b;
      }));
      // The places by deck: an LCARS bar each (deck and place, its power path), then what's in it.
      const pl = placeStates(own);
      places.replaceChildren(...(pl.length ? pl.map((x) => {
        const pill = (state, text) => { const s = h('span', { className: 'msd-pill', textContent: text }); s.dataset.state = state; return s; };
        const box = h('div', { className: 'msd-place' },
          h('div', { className: 'place-bar' }, h('span', { className: 'place-cap place-cap--l' }), h('span', { className: 'place-label', textContent: `Deck ${x.deck} - ${x.name}` }),
            ...(x.path ? [h('span', { className: 'msd-place__path' }, pill(x.path[0], x.path[1]))] : []), h('span', { className: 'place-cap place-cap--r' })),
          h('ul', { className: 'msd-place__items' }, ...x.items.map(([name, s, text]) => h('li', {}, h('span', { textContent: name }), pill(s, text)))));
        box.dataset.place = x.name;
        box.dataset.state = x.state;
        return box;
      }) : [h('p', { className: 'ops-hint', textContent: 'No places in this design' })]));
      log.replaceChildren(...(events.length ? events.slice(-30).reverse().map((ev) => { const li = h('li', { textContent: `${new Date(ev.at).toTimeString().slice(0, 8)} ${ev.text}` }); li.dataset.cls = ev.cls; return li; }) : [h('li', { className: 'empty', textContent: 'No events' })]));
      kick();
    }
    return { update, statuses: () => st };
  };
})();
