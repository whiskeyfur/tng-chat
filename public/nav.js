// Navigation for the Helm and Science stations: a live sector map of the
// ships on sensors (from the relay's 'nav' messages), plus
//  - Helm: set a destination (a ship, or click the map for a waypoint) and a
//    speed (impulse or warp 1-9), Engage, All stop; take Science's plotted courses.
//  - Science: contacts with distance, Scan (shields, crew, ops, speed...) and
//    Plot course for Helm.
//
// const panel = createNavPanel(root, { mode: 'helm' | 'science', send });
// panel.update(navMsg); panel.plotted(msg); panel.scanned(msg); panel.status(text)
(function () {
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(`--lcars-${name}`).trim();
  const speedName = (w) => (w <= 0 ? 'All stop' : w < 1 ? 'Impulse' : `Warp ${+w.toFixed(1)}`);
  const unitsPerSecond = (w) => (w <= 0 ? 0 : w < 1 ? 2 * w : 2 * w ** 1.8); // as tools/shipcore.js
  const SPEEDS = [['0', 'All stop'], ['0.25', 'Impulse'], ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((w) => [String(w), `Warp ${w}`])];

  window.createNavPanel = function createNavPanel(root, { mode, send }) {
    let nav = null;          // last 'nav' message
    let selected = null;     // ship name picked on the map/list
    let waypoint = null;     // { x, y } clicked on the map (Helm)

    // --- the map ----------------------------------------------------------
    const canvas = el('canvas', { className: 'nav-canvas' });
    const wrap = el('div', { className: 'nav-map', role: 'img', ariaLabel: 'Sector map' }, canvas);
    const g = canvas.getContext('2d');
    let W = 0, H = 0;
    new ResizeObserver(() => {
      const dpr = devicePixelRatio || 1;
      W = wrap.clientWidth; H = wrap.clientHeight;
      canvas.width = Math.max(1, W * dpr); canvas.height = Math.max(1, H * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    }).observe(wrap);

    // World (0..1000) to canvas, keeping the sector square.
    const view = () => { const s = Math.min(W, H) / 1000; return { s, ox: (W - 1000 * s) / 2, oy: (H - 1000 * s) / 2 }; };
    const toScreen = (x, y) => { const v = view(); return [v.ox + x * v.s, v.oy + y * v.s]; };

    function draw() {
      if (!W || !H) return;
      const v = view();
      g.clearRect(0, 0, W, H);
      g.fillStyle = '#050505';
      g.fillRect(v.ox, v.oy, 1000 * v.s, 1000 * v.s);
      g.strokeStyle = 'rgba(153,153,255,0.18)';
      g.lineWidth = 1;
      for (let i = 0; i <= 1000; i += 100) {
        const [x0, y0] = toScreen(i, 0), [x1, y1] = toScreen(i, 1000);
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
        const [a0, b0] = toScreen(0, i), [a1, b1] = toScreen(1000, i);
        g.beginPath(); g.moveTo(a0, b0); g.lineTo(a1, b1); g.stroke();
      }
      if (!nav?.own) return;
      const own = nav.own;
      const [ox, oy] = toScreen(own.x, own.y);
      // Ranges around us: sensors, subspace (comms), transporter.
      const ring = (r, color, dash, alpha) => { g.save(); g.globalAlpha = alpha; g.strokeStyle = css(color); g.setLineDash(dash); g.beginPath(); g.arc(ox, oy, r * v.s, 0, Math.PI * 2); g.stroke(); g.restore(); };
      ring(nav.ranges.sensors, 'violet', [2, 6], 0.5);
      ring(nav.ranges.comms, 'sky', [8, 6], 0.7);
      ring(nav.ranges.transporter, 'gold', [3, 3], 0.9);
      // Where we're heading.
      const dest = own.dest || (mode === 'helm' && waypoint);
      if (dest) {
        const [dx, dy] = toScreen(dest.x, dest.y);
        g.save(); g.strokeStyle = css('gold'); g.setLineDash([6, 6]); g.beginPath(); g.moveTo(ox, oy); g.lineTo(dx, dy); g.stroke(); g.restore();
        g.strokeStyle = css('gold'); g.beginPath(); g.moveTo(dx - 6, dy); g.lineTo(dx + 6, dy); g.moveTo(dx, dy - 6); g.lineTo(dx, dy + 6); g.stroke();
      }
      // Starbases: dock to restock torpedoes and take dock power.
      for (const b of nav.bases || []) {
        const [x, y] = toScreen(b.x, b.y);
        g.strokeStyle = css('sky'); g.lineWidth = 2;
        g.strokeRect(x - 7, y - 7, 14, 14); g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.stroke(); g.lineWidth = 1;
        g.fillStyle = css('sky'); g.font = '13px Antonio, sans-serif';
        g.fillText(b.name.toUpperCase(), x + 12, y + 4);
      }
      for (const sh of nav.ships) {
        const [x, y] = toScreen(sh.x, sh.y);
        const isOwn = sh.name === own.name;
        const color = isOwn ? 'gold' : sh.ops ? 'lilac' : 'tan';
        g.save();
        g.translate(x, y);
        g.rotate((sh.heading * Math.PI) / 180);
        g.fillStyle = css(color);
        g.beginPath(); g.moveTo(0, -10); g.lineTo(7, 8); g.lineTo(0, 4); g.lineTo(-7, 8); g.closePath(); g.fill();
        g.restore();
        if (sh.shields) { g.strokeStyle = css('red'); g.beginPath(); g.arc(x, y, 13, 0, Math.PI * 2); g.stroke(); }
        if (sh.name === selected) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(x - 16, y - 16, 32, 32); g.lineWidth = 1; }
        g.fillStyle = css(color);
        g.font = '13px Antonio, sans-serif';
        g.fillText(`${sh.name.toUpperCase()}${sh.class ? ` · ${sh.class.toUpperCase()}` : ''}${sh.warp > 0 ? ` · ${speedName(sh.warp).toUpperCase()}` : ''}`, x + 12, y - 8);
      }
    }

    // Click: a ship nearby selects it; anywhere else sets a waypoint (Helm).
    wrap.addEventListener('click', (e) => {
      if (!nav) return;
      const r = wrap.getBoundingClientRect();
      const v = view();
      const wx = (e.clientX - r.left - v.ox) / v.s, wy = (e.clientY - r.top - v.oy) / v.s;
      const hit = nav.ships.filter((s) => s.name !== nav.own?.name).find((s) => Math.hypot(s.x - wx, s.y - wy) * v.s < 16);
      if (hit) { selected = hit.name; waypoint = null; }
      else if (mode === 'helm' && wx >= 0 && wx <= 1000 && wy >= 0 && wy <= 1000) { selected = null; waypoint = { x: Math.round(wx), y: Math.round(wy) }; }
      renderControls();
      draw();
    });

    // --- controls -----------------------------------------------------------
    const readout = el('p', { className: 'nav-readout' });
    const note = el('p', { className: 'ops-notice nav-status' });
    const controls = el('div', { className: 'nav-controls' });
    const side = el('div', { className: 'nav-side' }, readout, controls, note);
    root.replaceChildren(el('div', { className: 'nav-panel' }, wrap, side));

    const destSel = el('select', { className: 'ops-select', id: `${mode}-dest`, ariaLabel: 'destination' });
    const speedSel = el('select', { className: 'ops-select', id: 'helm-speed', ariaLabel: 'speed' }, ...SPEEDS.map(([v, t]) => new Option(t, v)));
    speedSel.value = '5';
    const button = (text, id, onclick, alert) => { const b = el('button', { type: 'button', className: `lcars-button lcars-button--pill${alert ? ' lcars-button--alert' : ''}`, id, textContent: text }); b.onclick = onclick; return b; };
    const plotted = el('div', { className: 'nav-plotted', hidden: true });
    // Autopilot: tap a known contact or a starbase; the ship's computer flies
    // there at the speed set above (and docks at a starbase).
    const autoBox = el('div', { className: 'nav-autopilot', id: 'autopilot' });
    let autoSig = '';
    let autoMode = 'go', autoRange = 25; // go to / follow (at a range) / match
    function renderAutopilot() {
      const own = nav?.own;
      if (!own) return;
      const targets = [...(own.known || []).map((k) => [k.name, `The ${k.name}${k.visible ? '' : ` (last seen ${k.age < 60 ? `${k.age} s` : `${Math.round(k.age / 60)} min`} ago)`}`]), ...(nav.bases || []).map((b) => [b.name, b.name])];
      const visible = new Set((own.known || []).filter((k) => k.visible).map((k) => k.name));
      const sig = JSON.stringify([targets, own.autopilot, own.autopilotMode, autoMode, autoRange, [...visible]]);
      if (sig === autoSig) return;
      autoSig = sig;
      const am = own.autopilotMode;
      const what = !own.autopilot ? '' : am?.mode === 'follow' ? `following the ${own.autopilot} at ${am.range} units` : am?.mode === 'match' ? `matching the ${own.autopilot}'s heading and speed` : `course for ${/^(Starbase|Deep Space) /.test(own.autopilot) ? own.autopilot : `the ${own.autopilot}`}`;
      const modeTap = (m, label) => { const b = button(label, `autopilot-mode-${m}`, () => { autoMode = m; autoSig = ''; renderAutopilot(); }); b.classList.add('tr-tap'); b.setAttribute('aria-pressed', String(autoMode === m)); return b; };
      const rangeTap = (r) => { const b = button(`${r}`, `autopilot-range-${r}`, () => { autoRange = r; autoSig = ''; renderAutopilot(); }); b.classList.add('tr-tap'); b.setAttribute('aria-pressed', String(autoRange === r)); return b; };
      // Follow and match need a ship on sensors; go to takes any known contact or a starbase.
      const shown = autoMode === 'go' ? targets : targets.filter(([name]) => visible.has(name));
      autoBox.replaceChildren(
        el('p', { className: 'ops-hint', id: 'autopilot-state', textContent: own.autopilot ? `Autopilot: ${what}. The ship's computer is flying.` : 'Pick go to, follow (at a range) or match, then tap a contact: the ship\'s computer flies it at the speed set above.' }),
        el('div', { className: 'tr-taps' }, modeTap('go', 'Go to'), modeTap('follow', 'Follow'), modeTap('match', 'Match')),
        ...(autoMode === 'follow' ? [el('div', { className: 'tr-taps' }, el('span', { textContent: 'Range' }), ...(own.followRanges || [10, 25, 50, 100, 200]).map(rangeTap))] : []),
        el('div', { className: 'tr-taps' }, ...shown.map(([name, label]) => {
          const b = button(label, '', () => send({ type: 'autopilot', target: name, mode: autoMode, range: autoRange, warp: Number(speedSel.value) || 5 }));
          b.classList.add('tr-tap');
          b.dataset.target = name;
          b.setAttribute('aria-pressed', String(own.autopilot === name));
          return b;
        }), ...(own.autopilot ? [button('Autopilot off', 'autopilot-off', () => send({ type: 'autopilot', target: null }), true)] : [])));
    }
    // Docking: two ports, port and starboard. Pick a port, then dock at the
    // starbase or with the ship in range; undock a port; answer a request.
    let dockPort = 'port';
    const dockBox = el('div', { className: 'nav-dock', id: 'helm-dock-box' });
    let dockSig = '';
    function renderDock() {
      const g = nav?.own?.grid;
      if (!g) return;
      const sig = JSON.stringify([g.ports, g.near, g.nearShip, g.dockRequest, g.thrustersOk, dockPort, g.docked, g.drydock, g.landed, g.bays]);
      if (sig === dockSig) return;
      dockSig = sig;
      const portTap = (pt) => {
        const v = g.ports[pt];
        const b = button(`${pt[0].toUpperCase()}${pt.slice(1)}: ${v?.base || (v?.ship ? `the ${v.ship}` : 'free')}`, `dock-port-${pt}`, () => { dockPort = pt; dockSig = ''; renderDock(); });
        b.classList.add('tr-tap');
        b.setAttribute('aria-pressed', String(dockPort === pt));
        return b;
      };
      const free = !g.ports[dockPort];
      const why = !g.thrustersOk ? 'no maneuvering thrusters (start an impulse drive)' : !free ? `the ${dockPort} dock is in use` : '';
      const act = [];
      if (g.near && !g.docked) act.push(button(`Dock at ${g.near}`, 'helm-dock', () => send({ type: 'dock', port: dockPort })));
      if (g.nearShip && !Object.values(g.ports).some((v) => v?.ship === g.nearShip)) act.push(button(`Dock with the ${g.nearShip}`, 'helm-dock-ship', () => send({ type: 'dock', ship: g.nearShip, port: dockPort })));
      for (const b of act) { b.disabled = !!why; if (why) b.title = why; }
      // In drydock the starbase port can't be let go: request release instead.
      const dd = g.drydock;
      const undock = Object.entries(g.ports).filter(([pt, v]) => v && !(dd?.in && v.base)).map(([pt, v]) => button(`Undock ${pt} (${v.base || `the ${v.ship}`})`, `helm-undock-${pt}`, () => send({ type: 'dock', undock: true, port: pt }), true));
      if (dd?.shipyard && !dd.in) act.push(button('Enter drydock', 'helm-drydock', () => send({ type: 'dock', drydock: true })));
      // A shuttle or runabout: land in a bay in range (greyed with why not), or take off.
      const landTaps = (g.bays || []).map((b) => { const x = button(`Land in ${/^(Starbase|Deep Space|Utopia) /.test(b.name) ? b.name : `the ${b.name}`}'s bay${b.why ? ` · ${b.why}` : ''}`, '', () => send({ type: 'dock', land: b.name })); x.dataset.bay = b.name; x.disabled = !!b.why; return x; });
      if (g.landed) act.push(button(`Take off from the ${g.landed}'s bay`, 'helm-takeoff', () => send({ type: 'dock', takeoff: true })));
      if (dd?.in) act.push(Object.assign(button(dd.release != null ? `Release in ${dd.release} s${dd.hold ? ' (held by the shipyard)' : ''}` : 'Request release', 'helm-release', () => send({ type: 'dock', release: true })), { disabled: dd.release != null }));
      dockBox.replaceChildren(
        el('div', { className: 'tr-taps' }, portTap('port'), portTap('starboard')),
        el('div', { className: 'ops-form' }, ...act, ...undock),
        ...(landTaps.length ? [el('div', { className: 'ops-form', id: 'helm-bays' }, ...landTaps)] : []),
        el('span', { className: 'ops-hint', id: 'helm-dock-state', textContent: dd?.in ? `In drydock at ${g.docked}: Helm is held until the shipyard releases us` : why && act.length ? `Can't dock: ${why}` : act.length ? '' : (g.near || g.nearShip ? '' : 'Nothing in docking range') }),
        ...(g.dockRequest ? [el('div', { className: 'ops-form', id: 'dock-request' }, el('span', { textContent: `The ${g.dockRequest.from} requests to dock (${g.dockRequest.seconds} s)` }),
          button('Accept', 'dock-accept', () => send({ type: 'dock', answer: 'accept', port: dockPort })), button('Decline', 'dock-decline', () => send({ type: 'dock', answer: 'decline' }), true))] : []));
    }
    const contacts = el('ul', { className: 'nav-contacts' });
    const scanOut = el('div', { className: 'nav-scan' });
    let sciLock = null; // the contact Science's sensors are locked on (tracked)

    destSel.onchange = () => {
      const v = destSel.value;
      selected = v.startsWith('ship:') ? v.slice(5) : null;
      if (v !== 'waypoint') waypoint = null;
      draw();
    };

    const destValue = () => {
      const v = destSel.value;
      if (v === 'waypoint' && waypoint) return { x: waypoint.x, y: waypoint.y };
      if (v.startsWith('ship:')) return { ship: v.slice(5) };
      if (v.startsWith('base:')) return { base: v.slice(5) };
      return null;
    };

    if (mode === 'helm') {
      controls.append(
        el('div', { className: 'ops-form' }, el('span', { textContent: 'Course' }), destSel),
        el('div', { className: 'ops-form' }, el('span', { textContent: 'Speed' }), speedSel,
          button('Engage', 'helm-engage', () => {
            const dest = destValue();
            send({ type: 'helm', warp: Number(speedSel.value), ...(dest ? { dest } : {}) });
          }),
          button('All stop', 'helm-stop', () => send({ type: 'helm', warp: 0 }), true)),
        el('h3', { className: 'ops-subhead', textContent: 'Docking' }),
        dockBox,
        el('h3', { className: 'ops-subhead', textContent: 'Autopilot' }),
        autoBox,
        plotted);
    } else {
      controls.append(el('h3', { className: 'ops-subhead', textContent: 'Contacts' }), contacts, scanOut);
    }

    function renderControls() {
      if (!nav) return;
      const own = nav.own;
      if (own) {
        const dest = own.dest ? (own.dest.name ? `the ${own.dest.name}` : `${Math.round(own.dest.x)}, ${Math.round(own.dest.y)}`) : 'none (holding heading)';
        const eta = own.dest && own.warp > 0 ? Math.max(0, Math.hypot(own.dest.x - own.x, own.dest.y - own.y) / unitsPerSecond(own.warp)) : null;
        readout.replaceChildren(
          el('span', { textContent: `Position ${Math.round(own.x)}, ${Math.round(own.y)}` }),
          el('span', { textContent: `Heading ${String(Math.round(own.heading)).padStart(3, '0')}` }),
          el('span', { textContent: speedName(own.warp) }),
          el('span', { textContent: `Destination: ${dest}${eta != null ? ` · ETA ${eta < 60 ? `${Math.ceil(eta)} s` : `${Math.round(eta / 60)} min`}` : ''}` }),
          ...(mode === 'science' && own.signature != null ? [el('span', { id: 'nav-signature', textContent: `Our power signature ${Math.round(own.signature * 100)}%` })] : []));
      } else {
        readout.textContent = "No ship's computer is flying the ship";
      }
      const others = nav.ships.filter((s) => s.name !== own?.name);
      if (mode === 'helm') {
        // Engine power caps the speed (Engineering).
        // Impulse comes from the impulse drives, warp from the warp core and engines.
        const lim = nav.speed || { warp: nav.maxWarp ?? 9, impulse: 0.25 };
        for (const o of speedSel.options) {
          const v = Number(o.value);
          const over = v > 0 && (v < 1 ? lim.impulse <= 0 : v > lim.warp);
          o.disabled = over;
          o.textContent = SPEEDS.find(([v]) => v === o.value)[1] + (over ? ' (no power)' : '');
        }
        if (speedSel.selectedOptions[0]?.disabled) speedSel.value = [...speedSel.options].filter((o) => !o.disabled).pop().value;
        // Show what Helm picked, or else where the ship is actually heading.
        const keep = destSel.value.startsWith('base:') ? destSel.value : selected ? `ship:${selected}` : waypoint ? 'waypoint' : own?.dest?.name ? `${(nav.bases || []).some((b) => b.name === own.dest.name) ? 'base' : 'ship'}:${own.dest.name}` : '';
        renderDock();
        destSel.replaceChildren(new Option('Hold current heading', ''),
          ...(waypoint ? [new Option(`Waypoint ${waypoint.x}, ${waypoint.y}`, 'waypoint')] : []),
          ...others.map((s) => new Option(`The ${s.name} (${Math.round(s.distance)} units)`, `ship:${s.name}`)),
          ...(nav.bases || []).map((b) => new Option(`${b.name} (${b.distance} units)`, `base:${b.name}`)));
        if ([...destSel.options].some((o) => o.value === keep)) destSel.value = keep;
      } else {
        contacts.replaceChildren(...(others.length ? others : []).map((s) => {
          const li = el('li', { className: s.name === selected ? 'selected' : '' },
            el('span', { className: 'nav-contact-name', textContent: s.name }),
            el('span', { className: 'nav-contact-info', textContent: `${s.class ? `${s.class} class · ` : ''}${Math.round(s.distance)} units · ${speedName(s.warp)}${s.distance <= nav.ranges.comms ? ' · in comms range' : ''}` }),
            button('Scan', '', () => { selected = s.name; send({ type: 'scan', ship: s.name }); renderControls(); draw(); }),
            // Lock: the scan, tracked each second (tap again to release).
            (() => { const b = button(sciLock === s.name ? 'Release lock' : 'Lock', '', () => { selected = s.name; send({ type: 'sci-lock', ship: sciLock === s.name ? null : s.name }); renderControls(); draw(); }, sciLock === s.name); b.classList.add('nav-sci-lock'); b.setAttribute('aria-pressed', String(sciLock === s.name)); return b; })(),
            button('Plot course', '', () => send({ type: 'plot-course', dest: { ship: s.name } })));
          li.dataset.ship = s.name;
          return li;
        }));
        if (!others.length) contacts.append(el('li', { className: 'empty', textContent: 'No contacts on sensors' }));
      }
    }

    function status(text) { note.textContent = text; }

    return {
      update(msg) { nav = msg; renderControls(); if (mode === 'helm') renderAutopilot(); draw(); },
      // Helm: Science plotted a course; one click to engage it.
      plotted(msg) {
        if (mode !== 'helm') return;
        plotted.hidden = false;
        plotted.replaceChildren(
          el('span', { textContent: `${msg.by.name} (Science) plotted a course to ${msg.label}` }),
          button('Engage', 'helm-engage-plot', () => { send({ type: 'helm', dest: msg.dest, warp: Number(speedSel.value) || 5 }); plotted.hidden = true; }),
          button('Dismiss', '', () => { plotted.hidden = true; }, true));
      },
      // Science: what the scan found.
      scanned(msg) {
        const d = msg.data;
        const stations = Object.entries(d.stations).map(([st, n]) => `${st} ${n}`).join(', ') || 'nobody';
        const species = Object.entries(d.species || {}).map(([sp, n]) => `${n} ${sp}`).join(', ');
        // Lifeforms by name and species; their exact locations only when resolved (shields down, or sensors above shields).
        const where = d.shields ? `Sensors ${d.sensors}% vs shields ${d.shieldLevel}%: locations ${d.resolved ? 'resolved' : 'unresolved'}` : 'Shields down: locations resolved';
        const lifeforms = el('ul', { className: 'nav-scan-lifeforms' }, ...(d.lifeforms?.length ? d.lifeforms.map((l) => el('li', { textContent: `${l.name} · ${l.species}${l.where ? ` · ${l.where}` : ''}` })) : [el('li', { className: 'empty', textContent: 'No life signs' })]));
        const power = d.power?.length ? [el('h4', { className: 'nav-scan-sub', textContent: `Power use: ${d.powerTotal}` }), el('ul', { className: 'nav-scan-power' }, ...d.power.map(([n, v]) => el('li', {}, el('span', { textContent: n }), el('b', { textContent: String(v) }))))] : [];
        scanOut.replaceChildren(
          el('h3', { className: 'ops-subhead', textContent: `${msg.tracking ? 'Tracking' : 'Scan'}: the ${msg.ship}` }),
          el('ul', { className: 'nav-scan-list' },
            ...[
              ...(d.class ? [['Class', d.class]] : []),
              ['Distance', `${d.distance} units${d.inTransporterRange ? ' (transporter range)' : d.inCommsRange ? ' (comms range)' : ''}`],
              ['Position', `${Math.round(d.x)}, ${Math.round(d.y)}`],
              ['Heading · speed', `${String(Math.round(d.heading)).padStart(3, '0')} · ${speedName(d.warp)}`],
              ['Shields', d.shields ? `Up${d.shieldStrength != null ? ` · ${d.shieldStrength}%` : ''}${d.shieldFreq ? ` · frequency ${d.shieldFreq}` : ''}` : 'Down'], // strength (and, resolved, frequency) only mean something while they're up
              ...(d.hull != null ? [['Hull', `${d.hull}%${d.disabled ? ' · disabled' : ''}${d.damaged.length ? ` · damaged: ${d.damaged.join(', ')}` : ''}`]] : []),
              ...(d.signature != null ? [['Power signature', `${d.signature}%${d.signature < 60 ? ' (running quiet)' : ''}`]] : []),
              ['Ops', d.ops ? 'On duty' : 'None on duty'],
              ['Life signs', `${d.crew}${species ? ` (${species})` : d.crew ? ` (${stations})` : ''}`],
              ...(d.crew ? [['Locations', where]] : []),
            ].map(([k, v]) => el('li', {}, el('span', { textContent: k }), el('b', { textContent: v })))),
          lifeforms, ...power);
      },
      // Science: the sensor lock (a contact's name, or null).
      sciLocked(ship) { sciLock = ship; if (!ship && scanOut.querySelector('h3')?.textContent.startsWith('Tracking')) scanOut.querySelector('h3').textContent = scanOut.querySelector('h3').textContent.replace('Tracking', 'Scan'); renderControls(); },
      status,
      get nav() { return nav; },
    };
  };
})();
