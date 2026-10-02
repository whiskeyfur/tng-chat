// Station displays for the crew consoles. Each station gets LCARS panels that
// suit the post: Medical has vitals and an ECG, Engineering a side view of the
// ship with the warp core, Helm a navigation starfield, and so on. The data is
// simulated (a gentle random walk), except the duty roster and department
// readiness (who is actually aboard, at which station) and the shields, which
// follow the ship's real shield state and strength. The
// Transporter and Tactical stations have live controls that client.js fills
// in (elements marked data-transporter and data-shield-control), and
// Communications has live comm traffic (data-traffic).
//
// renderStation(container, station, { ship }) -> { sections: [{ id, title, color }], setCrew(users), setShields(up) }
// Each panel becomes its own screen (data-screen = panel id) that fills the window.
// The DOM helpers mirror js/lcars/components.js from lcars-base.
(function () {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(`--lcars-${name}`).trim() || '#f90';
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const timers = [];
  const every = (ms, fn) => { fn(); timers.push(setInterval(fn, reduceMotion ? ms * 4 : ms)); };

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
      else el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...children.flat().filter((c) => c != null && c !== false));
    return el;
  }
  const svgEl = (tag, attrs = {}, ...kids) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.append(...kids);
    return el;
  };
  const accent = (color) => ({ '--accent': `var(--lcars-${color})` });

  function panel(id, title, color, wide, ...children) {
    return h('section', { class: `lcars-panel${wide ? ' ops-wide' : ''}`, id, style: accent(color) },
      h('h2', { class: 'lcars-panel__title' }, h('span', {}, title)),
      h('div', { class: 'lcars-panel__body' }, ...children));
  }

  function readout(label, color = 'gold', unit = '') {
    const value = h('span', { class: 'lcars-readout__value' }, '---');
    const el = h('div', { class: 'lcars-readout', style: accent(color) },
      h('span', { class: 'lcars-readout__label' }, label), value, unit && h('span', { class: 'lcars-readout__unit' }, unit));
    el.set = (v) => { value.textContent = String(v); };
    return el;
  }

  function gauge(label, color = 'blue', format = (v) => `${Math.round(v * 100)}%`) {
    const fill = h('div', { class: 'lcars-gauge__fill' });
    const text = h('span', { class: 'lcars-gauge__text' }, '---');
    const el = h('div', { class: 'lcars-gauge', style: accent(color), role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 1 },
      h('span', { class: 'lcars-gauge__label' }, label), h('div', { class: 'lcars-gauge__track' }, fill), text);
    el.set = (v) => { fill.style.width = `${clamp(v, 0, 1) * 100}%`; text.textContent = format(v); el.setAttribute('aria-valuenow', v.toFixed(2)); };
    return el;
  }

  function logView(lines, max = 8) {
    const el = h('ol', { class: 'lcars-log', 'aria-live': 'off' });
    el.add = (text, level) => {
      el.prepend(h('li', { class: `lcars-log__line${level ? ` lcars-log__line--${level}` : ''}` }, text));
      while (el.children.length > max) el.lastChild.remove();
    };
    let i = 0;
    if (lines) every(4200, () => { const [t, lvl] = lines[i++ % lines.length]; el.add(t, lvl); });
    return el;
  }

  // A value that drifts within [min, max].
  function drift(start, min, max, step) {
    let v = start;
    return () => (v = clamp(v + rand(-step, step), min, max));
  }

  // A canvas that redraws every frame (throttled when motion is reduced). It
  // sits in a wrapper that grows to fill its panel, so screens fit the window.
  function canvas(height, draw) {
    const c = h('canvas', { class: 'st-canvas' });
    const wrap = h('div', { class: 'st-canvas-wrap', role: 'img', style: { 'flex-basis': `${height}px` } }, c);
    const ctx = c.getContext('2d');
    let w = 0, hgt = 0, t = 0, last = 0;
    const resize = () => {
      const dpr = devicePixelRatio || 1;
      w = c.clientWidth; hgt = c.clientHeight;
      c.width = Math.max(1, w * dpr); c.height = Math.max(1, hgt * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    new ResizeObserver(resize).observe(c);
    const frame = (now) => {
      if (c.isConnected) {
        if (!reduceMotion || now - last > 250) {
          t += Math.min(64, now - (last || now)) / 1000;
          last = now;
          if (w > 0) draw(ctx, w, hgt, t);
        }
        requestAnimationFrame(frame);
      }
    };
    requestAnimationFrame(frame);
    return wrap;
  }

  // --- reusable displays -----------------------------------------------------

  // Scrolling trace, e.g. an ECG or a warp field harmonic. fn(x) -> -1..1
  function trace(height, color, fn, speed = 120, label) {
    const pts = [];
    let acc = 0;
    const c = canvas(height, (g, w, ht, t) => {
      acc += speed / 60;
      while (acc >= 2) { acc -= 2; pts.push(fn(t)); }
      const n = Math.ceil(w / 2);
      while (pts.length > n) pts.shift();
      g.clearRect(0, 0, w, ht);
      g.strokeStyle = 'rgba(255,255,255,0.08)';
      g.lineWidth = 1;
      for (let x = 0; x < w; x += 24) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, ht); g.stroke(); }
      for (let y = 0; y < ht; y += 24) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
      g.strokeStyle = css(color);
      g.lineWidth = 2;
      g.beginPath();
      pts.forEach((p, i) => { const x = w - (pts.length - i) * 2, y = ht / 2 - p * (ht / 2 - 6); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke();
    });
    if (label) c.setAttribute('aria-label', label);
    return c;
  }

  // Animated bar spectrum.
  // gain(): how much activity to show (0 flattens it).
  function spectrum(height, colors, n = 32, label, gain = () => 1) {
    const vals = Array.from({ length: n }, () => rand(0.2, 0.8));
    const c = canvas(height, (g, w, ht, t) => {
      g.clearRect(0, 0, w, ht);
      const bw = w / n;
      const k = gain();
      vals.forEach((v, i) => {
        vals[i] = clamp(v + rand(-0.06, 0.06) + 0.02 * Math.sin(t * 2 + i / 3), 0.05, 1);
        g.fillStyle = css(colors[i % colors.length]);
        const bh = Math.max(0.02, vals[i] * k) * (ht - 4);
        g.fillRect(i * bw + 2, ht - bh, Math.max(2, bw - 4), bh);
      });
    });
    if (label) c.setAttribute('aria-label', label);
    return c;
  }

  // Radar sweep with contacts.
  function sweep(height, color, contacts = 5, label) {
    const blips = Array.from({ length: contacts }, () => ({ a: rand(0, Math.PI * 2), r: rand(0.2, 0.95), seen: 0 }));
    const c = canvas(height, (g, w, ht, t) => {
      const cx = w / 2, cy = ht / 2, R = Math.min(w, ht) / 2 - 6;
      g.clearRect(0, 0, w, ht);
      g.strokeStyle = css(color);
      g.globalAlpha = 0.35;
      for (let i = 1; i <= 4; i++) { g.beginPath(); g.arc(cx, cy, (R * i) / 4, 0, Math.PI * 2); g.stroke(); }
      g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
      const a = (t * 1.4) % (Math.PI * 2);
      const grad = g.createConicGradient ? g.createConicGradient(a - 0.6, cx, cy) : null;
      if (grad) {
        grad.addColorStop(0, 'transparent'); grad.addColorStop(0.095, css(color)); grad.addColorStop(0.1, 'transparent');
        g.globalAlpha = 0.5; g.fillStyle = grad; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
      for (const b of blips) {
        const d = (a - b.a + Math.PI * 2) % (Math.PI * 2);
        if (d < 0.08) b.seen = 1;
        b.seen *= 0.985;
        b.a += rand(-0.002, 0.002);
        g.fillStyle = css('gold');
        g.globalAlpha = 0.2 + 0.8 * b.seen;
        g.beginPath(); g.arc(cx + Math.cos(b.a) * b.r * R, cy + Math.sin(b.a) * b.r * R, 4, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
    });
    if (label) c.setAttribute('aria-label', label);
    return c;
  }

  // Forward view starfield for the helm.
  function starfield(height, speed) {
    const stars = Array.from({ length: 160 }, () => ({ x: rand(-1, 1), y: rand(-1, 1), z: rand(0.05, 1) }));
    const c = canvas(height, (g, w, ht) => {
      g.fillStyle = '#000'; g.fillRect(0, 0, w, ht);
      const v = speed();
      for (const s of stars) {
        s.z -= 0.004 * v;
        const respawn = () => Object.assign(s, { x: rand(-1, 1), y: rand(-1, 1), z: 1 });
        if (s.z <= 0.05) { respawn(); continue; }
        const px = w / 2 + (s.x / s.z) * w / 2, py = ht / 2 + (s.y / s.z) * ht / 2;
        if (px < 0 || px > w || py < 0 || py > ht) { respawn(); continue; }
        // Streak back toward where the star was a moment ago.
        const tail = s.z + 0.015 * v;
        const qx = w / 2 + (s.x / tail) * w / 2, qy = ht / 2 + (s.y / tail) * ht / 2;
        g.strokeStyle = `rgba(200,220,255,${clamp(1.2 - s.z, 0.2, 1)})`;
        g.lineWidth = clamp(2 - s.z * 2, 0.5, 2);
        g.beginPath(); g.moveTo(qx, qy); g.lineTo(px, py); g.stroke();
      }
    });
    c.setAttribute('aria-label', 'Forward view');
    return c;
  }

  // Side view schematic of the ship: saucer, secondary hull, nacelles, with
  // a pulsing warp core and labelled sections.
  function shipSide(shipName) {
    const o = css('orange'), p = css('peach'), l = css('lilac'), b = css('blue'), s = css('sky');
    const line = (d, color, width = 2.5, extra = {}) => svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linejoin': 'round', ...extra });
    const label = (x, y, tx, ty, text, anchor = 'start') => svgEl('g', {},
      svgEl('path', { d: `M${x} ${y} L${tx} ${ty}`, stroke: css('tan'), 'stroke-width': 1 }),
      svgEl('circle', { cx: x, cy: y, r: 3, fill: css('gold') }),
      svgEl('text', { x: tx + (anchor === 'end' ? -4 : 4), y: ty + 4, fill: css('gold'), 'font-size': 13, 'text-anchor': anchor, 'letter-spacing': '0.08em' }, text.toUpperCase()));
    const decks = [];
    for (let i = 0; i < 7; i++) decks.push(svgEl('path', { d: `M${70 + i * 6} ${96 + i * 6} H${312 - i * 4}`, stroke: l, 'stroke-width': 1, opacity: 0.45 }));
    const core = svgEl('rect', { x: 338, y: 162, width: 8, height: 74, rx: 4, fill: s, class: 'st-core' });
    const svg = svgEl('svg', { viewBox: '0 0 720 300', class: 'st-ship', role: 'img', 'aria-label': `Side view of the ${shipName}` },
      // nacelles and pylons
      line('M402 196 L470 116 M430 196 L500 116', p, 3),
      line('M430 84 H680 Q712 84 712 100 Q712 116 680 116 H430 Q410 116 410 100 Q410 84 430 84 Z', o, 3),
      line('M430 92 H600', s, 6, { opacity: 0.85, class: 'st-nacelle' }),
      svgEl('path', { d: 'M412 92 Q404 100 412 108', fill: 'none', stroke: css('red'), 'stroke-width': 6 }),
      // saucer
      line('M40 92 Q60 70 190 66 Q320 70 332 92 Q330 120 190 128 Q50 120 40 92 Z', o, 3),
      line('M150 66 Q190 52 230 66', p, 3),
      ...decks,
      // neck and secondary hull
      line('M250 124 L300 176 M300 124 L330 160', o, 3),
      line('M290 168 Q300 158 420 160 Q520 166 540 196 Q520 240 400 246 Q300 246 280 214 Q270 186 290 168 Z', o, 3),
      svgEl('circle', { cx: 296, cy: 196, r: 18, fill: 'none', stroke: b, 'stroke-width': 5 }),
      svgEl('rect', { x: 506, y: 196, width: 30, height: 20, fill: 'none', stroke: l, 'stroke-width': 2 }),
      core,
      label(190, 58, 150, 22, 'Main bridge'),
      label(342, 200, 380, 278, 'Warp core'),
      label(296, 196, 230, 278, 'Navigational deflector'),
      label(520, 206, 600, 278, 'Shuttlebay'),
      label(600, 92, 630, 40, 'Warp nacelles'),
      label(110, 104, 40, 170, 'Decks 1-16', 'start'));
    return svg;
  }

  // Top view with four shield arcs whose strength is shown by opacity.
  function shields(strength) {
    const arcs = ['fore', 'starboard', 'aft', 'port'].map((name, i) => {
      const a0 = -Math.PI / 2 + i * Math.PI / 2 - Math.PI / 4 + 0.08, a1 = a0 + Math.PI / 2 - 0.16;
      const R = 110, cx = 150, cy = 130;
      const d = `M${cx + R * Math.cos(a0)} ${cy + R * Math.sin(a0) * 0.85} A${R} ${R * 0.85} 0 0 1 ${cx + R * Math.cos(a1)} ${cy + R * Math.sin(a1) * 0.85}`;
      return svgEl('path', { d, fill: 'none', stroke: css('sky'), 'stroke-width': 10, 'stroke-linecap': 'round', 'data-arc': name });
    });
    const o = css('orange');
    const svg = svgEl('svg', { viewBox: '0 0 300 260', class: 'st-shields', 'data-shields': '', role: 'img', 'aria-label': 'Shield arcs' },
      ...arcs,
      svgEl('ellipse', { cx: 150, cy: 100, rx: 60, ry: 52, fill: 'none', stroke: o, 'stroke-width': 3 }),
      svgEl('path', { d: 'M135 150 H165 L170 200 H130 Z', fill: 'none', stroke: o, 'stroke-width': 3 }),
      svgEl('path', { d: 'M110 170 V226 M190 170 V226', stroke: css('peach'), 'stroke-width': 8, 'stroke-linecap': 'round' }));
    every(900, () => arcs.forEach((a, i) => a.setAttribute('opacity', (0.25 + 0.75 * strength(i)).toFixed(2))));
    return svg;
  }

  // Deck-by-deck status grid; cells flicker gold/red now and then.
  function deckGrid(decks = 12, sections = 8) {
    const cells = [];
    const grid = h('div', { class: 'st-decks', role: 'img', 'aria-label': 'Deck status', style: { '--cols': sections } });
    for (let d = 1; d <= decks; d++) {
      grid.append(h('span', { class: 'st-deck-label' }, String(d).padStart(2, '0')));
      for (let s = 0; s < sections; s++) { const c = h('span', { class: 'st-cell' }); cells.push(c); grid.append(c); }
    }
    every(1500, () => {
      for (const c of cells) c.dataset.state = '';
      for (let i = 0; i < 3; i++) cells[Math.floor(rand(0, cells.length))].dataset.state = 'warn';
      if (Math.random() < 0.3) cells[Math.floor(rand(0, cells.length))].dataset.state = 'alert';
    });
    return grid;
  }

  // Transporter pad: six pads with a shimmer that runs while energizing.
  function transporterPad() {
    const o = css('orange'), b = css('blue'), s = css('sky');
    const pads = [[150, 70], [100, 105], [200, 105], [100, 165], [200, 165], [150, 200]].map(([x, y]) =>
      svgEl('g', {},
        svgEl('ellipse', { cx: x, cy: y, rx: 34, ry: 14, fill: 'none', stroke: o, 'stroke-width': 3 }),
        svgEl('ellipse', { cx: x, cy: y, rx: 22, ry: 8, fill: b, opacity: 0.35 }),
        svgEl('rect', { x: x - 14, y: y - 60, width: 28, height: 60, fill: s, opacity: 0, class: 'st-beam', rx: 6 })));
    return svgEl('svg', { viewBox: '0 0 300 240', class: 'st-pad', 'data-pad': '', role: 'img', 'aria-label': 'Transporter pad' },
      svgEl('path', { d: 'M40 30 H260 M40 230 H260', stroke: css('peach'), 'stroke-width': 6, 'stroke-linecap': 'round' }), ...pads);
  }

  // Readouts and gauges that update from drifting values.
  function live(el, gen, format = (v) => v) { every(1200, () => el.set(format(gen()))); return el; }

  // --- stations ----------------------------------------------------------------

  const ecg = (t) => {
    const ph = (t * 1.2) % 1;
    if (ph < 0.04) return ph * 6;
    if (ph < 0.06) return 0.24 - (ph - 0.04) * 40;
    if (ph < 0.09) return -0.56 + (ph - 0.06) * 60;
    if (ph < 0.12) return 1.24 - (ph - 0.09) * 44;
    if (ph > 0.3 && ph < 0.42) return 0.25 * Math.sin(((ph - 0.3) / 0.12) * Math.PI);
    return rand(-0.02, 0.02);
  };

  const STATIONS = {
    Captain: (ship) => ({ code: 'CMD 01', color: 'gold', panels: [
      // Alert status and orders (client.js fills it in).
      panel('st-command', 'Command', 'red', true, h('div', { 'data-command': '' })),
      // The master systems display, with the ship's real hull, shields, speed and
      // damage, and the self-destruct, under it (client.js fills them in).
      panel('st-msd', 'Master systems display', 'orange', true, h('div', { class: 'msd', 'data-msd': '' }),
        h('section', { class: 'msd-card' }, h('h3', {}, 'Ship status'), h('div', { 'data-ship-status': '' }))),
      panel('st-tactical', 'Tactical plot', 'red', false, sweep(240, 'red', 4, 'Tactical plot')),
      panel('st-dept', 'Department readiness', 'blue', false, h('ul', { class: 'st-depts', 'data-depts': '' })),
      panel('st-roster', 'Senior staff on duty', 'lilac', true, h('ul', { class: 'st-roster', 'data-roster': '' })),
      panel('st-log', "Captain's log", 'peach', true, logView([
        [`${ship}: holding position, all departments reporting`], ['Long range sensors: no contacts of note'], ['Science: survey of system complete'], ['Engineering: warp core at optimum efficiency']])),
    ] }),
    'First Officer': (ship) => ({ code: 'XO 02', color: 'red', panels: [
      panel('st-orders', 'Orders', 'red', true, h('div', { 'data-orders': '' })),
      panel('st-assign', 'Reassign crew', 'peach', true, h('div', { 'data-reassign': '' })),
      panel('st-roster', 'Duty roster', 'gold', true, h('ul', { class: 'st-roster', 'data-roster': '' })),
      panel('st-dept', 'Department readiness', 'blue', false, h('ul', { class: 'st-depts', 'data-depts': '' })),
      panel('st-msd', 'Master systems display', 'orange', false, h('div', { class: 'msd', 'data-msd': '' })),
      panel('st-log', 'Duty log', 'lilac', true, logView([
        ['Security drill scheduled, deck 8'], [`${ship}: personnel evaluations due`], ['Shore leave rotation approved'], ['Away team readiness confirmed']])),
    ] }),
    Helm: () => {
      return { code: 'CON 03', color: 'orange', panels: [
        // Course and speed, on the sector map (nav.js, filled in by client.js).
        panel('st-nav', 'Navigation', 'gold', true, h('div', { 'data-helm': '' })),
        // The stars move at the ship's real speed.
        panel('st-view', 'Forward view', 'orange', true, starfield(260, () => navSpeed)),
        panel('st-helm', 'Helm systems', 'blue', false,
          live(gauge('Impulse reserve', 'blue'), drift(0.95, 0.85, 1, 0.02)),
          live(gauge('Inertial dampers', 'sky'), drift(0.99, 0.95, 1, 0.01)),
          live(gauge('Structural integrity field', 'violet'), drift(0.97, 0.9, 1, 0.01))),
      ] };
    },
    Tactical: () => {
      // The arcs follow the real shield strength, with a little shimmer.
      const arcs = [0, 0, 0, 0].map(() => rand(-0.02, 0.02));
      every(900, () => arcs.forEach((v, i) => { arcs[i] = clamp(v + rand(-0.01, 0.01), -0.03, 0.03); }));
      const arc = (i) => clamp(shieldLevel + arcs[i], 0, 1);
      return { code: 'TAC 04', color: 'red', panels: [
        // Target lock, phasers and torpedoes (client.js fills it in).
        panel('st-weapons', 'Weapons', 'red', true, h('div', { 'data-weapons': '' })),
        panel('st-shields', 'Shield grid', 'sky', false, shields(arc),
          h('div', { class: 'ops-readouts' }, ...['Fore', 'Starboard', 'Aft', 'Port'].map((n, i) => live(readout(n, 'sky', '%'), () => arc(i) * 100, Math.round)))),
        panel('st-shieldctl', 'Shield control', 'red', true, h('div', { 'data-shield-control': '' })),
        panel('st-plot', 'Targeting scan', 'orange', true, sweep(240, 'orange', 6, 'Targeting scan')),
      ] };
    },
    Security: (ship) => ({ code: 'SEC 05', color: 'gold', panels: [
      // Transporter lockout, confinement, beam-in alerts (client.js fills it in).
      panel('st-secctl', 'Security control', 'red', true, h('div', { 'data-security': '' })),
      panel('st-decks', 'Internal sensors · deck status', 'gold', true, deckGrid(14, 10)),
      panel('st-fields', 'Force fields', 'blue', false,
        ...['Brig', 'Main bridge', 'Engineering', 'Armory'].map((n) => live(gauge(n, 'blue'), drift(1, 0.95, 1, 0.01)))),
      panel('st-log', 'Security log', 'red', false, logView([
        ['Deck 6: routine sweep complete'], [`${ship}: internal sensors nominal`], ['Armory inventory verified'], ['Deck 11: door malfunction logged', 'warn'], ['Brig: no detainees']])),
    ] }),
    Engineering: (ship) => {
      const core = drift(0.92, 0.85, 0.98, 0.01);
      return { code: 'ENG 06', color: 'orange', panels: [
        // The master systems display (msd.js, filled in by client.js): Engineering's main screen.
        panel('st-msd', 'Master systems display', 'orange', true, h('div', { class: 'msd', 'data-msd': '' })),
        // The warp core's reaction: client.js fills in the controls.
        panel('st-core', 'Warp core', 'sky', true,
          h('div', { 'data-warpcore': '' }),
          trace(110, 'sky', (t) => 0.6 * Math.sin(t * 9) * Math.sin(t * 1.3) + rand(-0.05, 0.05), 160, 'Warp field harmonics')),
        // Real power routing (client.js fills it in): every station feels it.
        panel('st-power', 'Power distribution', 'gold', true, h('div', { class: 'pw', 'data-power': '' })),
        // Power sources, buses, the warp core and containment (client.js fills it in).
        panel('st-grid', 'Power grid', 'sky', true, h('div', { 'data-grid': '' })),
        // Damage and where the repair crews go (client.js fills it in).
        panel('st-damage', 'Damage control', 'red', true, h('div', { 'data-damage': '' })),
        // Life support, place by place (client.js fills it in).
        panel('st-lifesupport', 'Life support', 'blue', true, h('div', { 'data-lifesupport': '' })),
      ] };
    },
    Medical: () => ({ code: 'MED 07', color: 'blue', panels: [
      panel('st-ecg', 'Patient monitor · biobed 1', 'sky', true, trace(150, 'sky', ecg, 130, 'Electrocardiogram'),
        h('div', { class: 'ops-readouts' },
          live(readout('Heart rate', 'sky', 'bpm'), drift(72, 66, 80, 1.5), Math.round),
          live(readout('Blood pressure', 'gold'), drift(118, 112, 126, 1.5), (v) => `${Math.round(v)}/${Math.round(v * 0.66)}`),
          live(readout('Temperature', 'orange', '°C'), drift(36.9, 36.6, 37.2, 0.05), (v) => v.toFixed(1)),
          live(readout('Blood O2', 'blue', '%'), drift(98, 96, 99.5, 0.3), Math.round))),
      panel('st-neural', 'Neural activity', 'violet', false, trace(100, 'violet', (t) => 0.4 * Math.sin(t * 23) * Math.sin(t * 3.1) + 0.25 * Math.sin(t * 41) + rand(-0.1, 0.1), 140, 'Neural activity'),
        live(gauge('Cortical function', 'violet'), drift(0.94, 0.9, 0.98, 0.01)),
        live(gauge('Synaptic response', 'lilac'), drift(0.9, 0.84, 0.96, 0.01))),
      // Real crew: admit to and discharge from sickbay (client.js fills it in).
      panel('st-sickbay', 'Sickbay · life signs', 'blue', true, h('div', { 'data-medical': '' })),
      panel('st-cell', 'Cellular analysis', 'peach', false, spectrum(110, ['peach', 'lilac'], 24, 'Cellular analysis')),
    ] }),
    Science: () => ({ code: 'SCI 08', color: 'blue', panels: [
      panel('st-sensors', 'Long range sensors', 'blue', true, h('div', { 'data-sensors': '' })),
      panel('st-spectrum', 'Spectral analysis', 'violet', false, spectrum(150, ['violet', 'blue', 'sky', 'lilac'], 40, 'Spectral analysis'),
        live(readout('Dominant band', 'sky', 'nm'), drift(486, 430, 660, 6), Math.round)),
      panel('st-readings', 'Anomaly readings', 'sky', true, h('div', { class: 'ops-readouts' },
        live(readout('Subspace variance', 'sky'), drift(0.02, 0, 0.08, 0.005), (v) => v.toFixed(3)),
        live(readout('Tachyon count', 'gold'), drift(140, 100, 200, 8), Math.round),
        live(readout('Gravimetric shear', 'orange'), drift(0.4, 0.1, 0.9, 0.03), (v) => v.toFixed(2)),
        live(readout('Radiation', 'red', 'rad'), drift(12, 8, 18, 0.5), (v) => v.toFixed(1)))),
      panel('st-log', 'Science log', 'lilac', true, logView([
        ['Stellar cartography updated'], ['Class M planet catalogued'], ['Ion storm tracked at bearing 210', 'warn'], ['Spectrometer recalibrated']])),
    ] }),
    Communications: (ship) => ({ code: 'COM 09', color: 'peach', panels: [
      panel('st-traffic', 'Comm traffic', 'sky', true, h('div', { 'data-traffic': '' })),
      // Data links, run from here as well as from ops (client.js fills it in).
      panel('st-links', 'Data links', 'peach', true, h('div', { 'data-links': '' })),
      // Subspace bands follow the ship's subspace relay (powered and undamaged): dead flat without it.
      panel('st-bands', 'Subspace bands', 'peach', true, spectrum(140, ['peach', 'orange', 'gold'], 48, 'Subspace band activity', () => (window.__subspace?.up === false ? 0 : 1)),
        live(readout('Subspace relay', 'gold'), () => (window.__subspace ? (window.__subspace.up ? 'Online: the whole system' : `OFFLINE: ${window.__subspace.why}`) : '---'))),
      panel('st-signal', 'Carrier signal', 'sky', false, trace(110, 'sky', (t) => 0.7 * Math.sin(t * 14) * (0.7 + 0.3 * Math.sin(t * 0.7)) + rand(-0.04, 0.04), 160, 'Carrier signal'),
        live(gauge('Signal strength', 'sky'), drift(0.86, 0.7, 0.98, 0.03)),
        live(readout('Relay', 'gold'), () => 'Starbase relay 4')),
      panel('st-log', 'Message traffic', 'lilac', false, logView([
        ['Starfleet Command: priority one routing test'], [`${ship}: subspace relay handshake`], ['Encrypted packet received, decoding'], ['Long range comm array aligned']])),
    ] }),
    Transporter: (ship) => ({ code: 'TRN 11', color: 'blue', panels: [
      panel('st-transporter', 'Transporter controls', 'blue', true, h('div', { 'data-transporter': '' }), transporterPad()),
      panel('st-buffer', 'Pattern buffer', 'violet', false,
        trace(110, 'violet', (t) => 0.5 * Math.sin(t * 17) * Math.sin(t * 2.3) + rand(-0.08, 0.08), 150, 'Annular confinement beam'),
        live(gauge('Pattern integrity', 'violet', (v) => `${(v * 100).toFixed(1)}%`), drift(0.995, 0.98, 1, 0.003)),
        live(gauge('Heisenberg compensators', 'blue'), drift(0.97, 0.92, 1, 0.01)),
        live(readout('Emitter array', 'sky'), () => 'Online'),
        live(readout('Targeting scanners', 'gold'), () => `Locked: the ${ship}`)),
    ] }),
    // The brig: a place, no console controls (who's held here, and the force field).
    Brig: (ship) => ({ code: 'BRG 13', color: 'red', panels: [
      panel('st-brig', 'Brig', 'red', true, h('div', { class: 'st-brig', 'data-brig': '' }, h('p', { class: 'st-brig-title' }, 'BRIG'))),
    ] }),
    // The shuttle bay: where shuttles and runabouts land and crew board them (a bay status panel; Ops works the doors).
    'Shuttle Bay': (ship) => ({ code: 'SHB 12', color: 'peach', panels: [
      panel('st-bay', 'Hangar control', 'peach', true, h('div', { 'data-bay': '' })),
    ] }),
    Crew: (ship) => ({ code: 'CRW 10', color: 'tan', panels: [
      // The master systems display, with the real alert status, replicators and
      // recreation under it (client.js fills them in).
      panel('st-msd', 'Master systems display', 'orange', true, h('div', { class: 'msd', 'data-msd': '' }),
        h('section', { class: 'msd-card' }, h('h3', {}, 'Crew services'), h('div', { 'data-services': '' }),
          live(readout('Shift', 'gold'), () => ['Alpha', 'Beta', 'Gamma'][Math.floor(new Date().getHours() / 8)]))),
      panel('st-decks', 'Deck status', 'blue', false, deckGrid(8, 8)),
    ] }),
  };

  // (and the bridge consoles: each runs one of the stations above, picked by its top buttons)
  window.STATION_NAMES = [...Object.keys(STATIONS), 'Bridge 1', 'Bridge 2', 'Bridge 3', 'Bridge 4', 'Bridge 5'];
  // The ship's real speed (warp factor; impulse 0.25), for the forward view.
  let navSpeed = 0;
  // Shield strength (0..1) for the shield grid.
  let shieldLevel = 1;
  // The duty stations counted for department readiness.
  const DEPARTMENTS = ['Operations', 'Helm', 'Tactical', 'Security', 'Engineering', 'Medical', 'Science', 'Communications', 'Transporter'];

  window.renderStation = function renderStation(container, station, { ship }) {
    timers.splice(0).forEach(clearInterval);
    const def = (STATIONS[station] || STATIONS.Crew)(ship);
    container.replaceChildren(...def.panels.map((p) => h('div', { class: 'screen', 'data-screen': p.id, hidden: true }, p)));
    const sections = def.panels.map((p) => ({ id: p.id, title: p.querySelector('.lcars-panel__title span').textContent, color: p.style.getPropertyValue('--accent') }));
    return {
      code: def.code,
      setNav(own) {
        navSpeed = own ? (own.warp >= 1 ? own.warp : own.warp > 0 ? 0.6 : 0.05) : 0;
        if (own?.combat) shieldLevel = own.combat.shield / 100;
      },
      // Shield displays follow the ship's real shield state.
      setShields(up) {
        for (const el of container.querySelectorAll('[data-shields]')) el.toggleAttribute('data-down', !up);
      },
      // The transporter pad shimmers while someone is being beamed.
      energize() {
        for (const el of container.querySelectorAll('[data-pad]')) {
          el.classList.remove('st-energize');
          void el.getBoundingClientRect();
          el.classList.add('st-energize');
        }
      },
      color: def.color,
      sections,
      // Rosters list who is actually aboard, by station.
      setCrew(users) {
        const aboard = users.filter((u) => u.ship.toLowerCase() === ship.toLowerCase());
        const tags = (u) => `${u.station}${[u.species, u.gender].filter(Boolean).map((x) => ` · ${x}`).join('')}${u.sickbay ? ' · sickbay' : ''}${u.confined ? ' · confined' : ''}`;
        for (const ul of container.querySelectorAll('[data-roster]')) {
          ul.replaceChildren(...(aboard.length ? aboard : [{ name: 'No one else aboard', station: '' }]).map((u) => h('li', {}, u.title || u.name, h('span', {}, tags(u)))));
        }
        // Department readiness: how many are at each duty station, and the
        // answers to the last readiness check (tap Check to call one department,
        // Check all for every one): green ready, amber waiting, no crew.
        const rd = window.__readiness || {};
        for (const ul of container.querySelectorAll('[data-depts]')) {
          const tapTo = (b, dept) => { b.onclick = () => window.__callReadiness?.(dept); return b; };
          const all = h('li', { class: 'st-dept-all' }, tapTo(h('button', { type: 'button', class: 'lcars-button lcars-button--pill', id: 'readiness-all' }, 'Check all departments'), 'all'));
          ul.replaceChildren(all, ...DEPARTMENTS.filter((d) => !window.__readiness || d in rd).map((d) => {
            const n = aboard.filter((u) => u.station === d && !u.sickbay).length; // sickbay is off duty
            const r = rd[d] || { state: 'idle' };
            const said = r.state === 'ready' ? `Ready (${r.ready.length})` : r.state === 'pending' ? `Waiting: ${r.pending.join(', ')}` : r.state === 'nocrew' ? 'No crew' : n ? `${n} on duty` : 'Unmanned';
            // Its people as chips: green once checked in, amber while waiting (no check yet: plain).
            const here = aboard.filter((u) => u.station === d && !u.sickbay).map((u) => u.name);
            const chips = r.state === 'pending' || r.state === 'ready'
              ? [...r.ready.map((nm) => h('span', { class: 'st-chip', 'data-state': 'ready' }, nm)), ...r.pending.map((nm) => h('span', { class: 'st-chip', 'data-state': 'pending' }, nm))]
              : here.length && r.state !== 'nocrew' ? here.map((nm) => h('span', { class: 'st-chip', 'data-state': 'idle' }, nm)) : [h('span', { class: 'st-dept-count' }, r.state === 'nocrew' ? 'No crew' : 'Unmanned')];
            return h('li', { 'data-dept': d, 'data-manned': n > 0, 'data-ready': r.state, title: said },
              tapTo(h('button', { type: 'button', class: 'lcars-button lcars-button--pill st-dept-check', 'data-check': d }, 'Check'), d),
              h('span', { class: 'st-dept-label' }, d),
              h('span', { class: 'st-chips' }, ...chips));
          }));
        }
      },
    };
  };
})();
