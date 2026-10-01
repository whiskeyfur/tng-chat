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
  const unitsPerSecond = (w) => (w <= 0 ? 0 : w < 1 ? 0.5 : 2 * w ** 1.8); // as tools/shipcore.js
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
        g.fillText(`${sh.name.toUpperCase()}${sh.warp > 0 ? ` · ${speedName(sh.warp).toUpperCase()}` : ''}`, x + 12, y - 8);
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
    const contacts = el('ul', { className: 'nav-contacts' });
    const scanOut = el('div', { className: 'nav-scan' });

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
          el('span', { textContent: `Destination: ${dest}${eta != null ? ` · ETA ${eta < 60 ? `${Math.ceil(eta)} s` : `${Math.round(eta / 60)} min`}` : ''}` }));
      } else {
        readout.textContent = "No ship's computer is flying the ship";
      }
      const others = nav.ships.filter((s) => s.name !== own?.name);
      if (mode === 'helm') {
        // Show what Helm picked, or else where the ship is actually heading.
        const keep = selected ? `ship:${selected}` : waypoint ? 'waypoint' : own?.dest?.name ? `ship:${own.dest.name}` : '';
        destSel.replaceChildren(new Option('Hold current heading', ''),
          ...(waypoint ? [new Option(`Waypoint ${waypoint.x}, ${waypoint.y}`, 'waypoint')] : []),
          ...others.map((s) => new Option(`The ${s.name} (${Math.round(s.distance)} units)`, `ship:${s.name}`)));
        if ([...destSel.options].some((o) => o.value === keep)) destSel.value = keep;
      } else {
        contacts.replaceChildren(...(others.length ? others : []).map((s) => {
          const li = el('li', { className: s.name === selected ? 'selected' : '' },
            el('span', { className: 'nav-contact-name', textContent: s.name }),
            el('span', { className: 'nav-contact-info', textContent: `${Math.round(s.distance)} units · ${speedName(s.warp)}${s.distance <= nav.ranges.comms ? ' · in comms range' : ''}` }),
            button('Scan', '', () => { selected = s.name; send({ type: 'scan', ship: s.name }); renderControls(); draw(); }),
            button('Plot course', '', () => send({ type: 'plot-course', dest: { ship: s.name } })));
          li.dataset.ship = s.name;
          return li;
        }));
        if (!others.length) contacts.append(el('li', { className: 'empty', textContent: 'No contacts on sensors' }));
      }
    }

    function status(text) { note.textContent = text; }

    return {
      update(msg) { nav = msg; renderControls(); draw(); },
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
        scanOut.replaceChildren(
          el('h3', { className: 'ops-subhead', textContent: `Scan: the ${msg.ship}` }),
          el('ul', { className: 'nav-scan-list' },
            ...[
              ['Distance', `${d.distance} units${d.inTransporterRange ? ' (transporter range)' : d.inCommsRange ? ' (comms range)' : ''}`],
              ['Position', `${Math.round(d.x)}, ${Math.round(d.y)}`],
              ['Heading · speed', `${String(Math.round(d.heading)).padStart(3, '0')} · ${speedName(d.warp)}`],
              ['Shields', d.shields ? 'Up' : 'Down'],
              ['Ops', d.ops ? 'On duty' : 'None on duty'],
              ['Life signs', `${d.crew} (${stations})`],
            ].map(([k, v]) => el('li', {}, el('span', { textContent: k }), el('b', { textContent: v })))));
      },
      status,
      get nav() { return nav; },
    };
  };
})();
