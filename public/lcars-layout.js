// LCARS layouts drawn (the layout designer's canvas, its preview, and any screen that shows a
// saved layout): LCARSLayout.render(layout, host) builds it in host, scaled to fit.
// A layout: { name, title, aspect: "16:9", items: [item] }. Sizes and places are grid cells
// (CELL px each; a layout is COLS cells wide). An item: { id, type, x, y, w, h, color, ... };
// a container's children: x, y from its own corner (a stack places them itself).
(function () {
  const CELL = 8, COLS = 160;
  const SWATCHES = ['orange', 'peach', 'gold', 'tan', 'lilac', 'violet', 'blue', 'sky', 'red', 'pink', 'white'];
  const HEX = { orange: '#ff9900', peach: '#ff9966', gold: '#ffcc66', tan: '#cc9966', lilac: '#cc99cc', violet: '#9977dd', blue: '#9999ff', sky: '#99ccff', red: '#dd4444', pink: '#ffbbcc', white: '#f4f0ff', ink: '#000' };
  const color = (c, fallback = 'orange') => HEX[c] || HEX[fallback];
  const rows = (aspect) => { const [a, b] = String(aspect || '16:9').split(':').map(Number); return Math.round((COLS * (b || 9)) / (a || 16)); };
  const CONTAINERS = new Set(['elbow', 'frame', 'stack', 'lpair']);

  // What each kind of part is made with, when it's added (w, h in cells).
  const KINDS = {
    elbow: { label: 'Elbow', w: 40, h: 24, color: 'lilac', corner: 'tl', arm: 4, side: 12, radius: 3, end: 'open', text: '' },
    lpair: { label: 'Header + body', w: 120, h: 70, color: 'orange', color2: 'lilac', side: 14, arm: 3, radius: 3, header: 18, gap: 1, end: 'open', text: '' },
    hbar: { label: 'Bar', w: 40, h: 4, color: 'orange', text: '' },
    vbar: { label: 'Column', w: 6, h: 30, color: 'peach', text: '' },
    cap: { label: 'End cap', w: 4, h: 4, color: 'lilac', side: 'left' },
    pill: { label: 'Pill', w: 16, h: 5, color: 'gold', text: 'Button' },
    pillbar: { label: 'Pill bar', w: 48, h: 5, color: 'orange', text: 'Label', options: 'One, Two, Three' },
    block: { label: 'Panel', w: 18, h: 10, color: 'peach', text: '' },
    text: { label: 'Label', w: 30, h: 4, color: 'gold', text: 'Label', size: 3, align: 'left' },
    title: { label: 'Title', w: 50, h: 7, color: 'gold', text: 'TITLE', size: 6, align: 'left', type: 'text' },
    number: { label: 'Number', w: 14, h: 6, color: 'orange', text: '01-0000', size: 4, align: 'right', type: 'block' },
    frame: { label: 'Capsule', w: 50, h: 24, color: 'orange', thick: 2, arm: 6 },
    stack: { label: 'Panel stack', w: 18, h: 40, color: '', dir: 'v', gap: 1 },
    image: { label: 'Image', w: 50, h: 30, src: '', fit: 'contain' },
    callout: { label: 'Callout', w: 0, h: 0, color: 'orange', text: 'Callout', bend: 'h', size: 1.6 },
  };

  // A callout's box, from its two ends: the label end (lx, ly) and the anchor (ax, ay).
  function calloutBox(it) {
    const x = Math.min(it.ax, it.lx), y = Math.min(it.ay, it.ly);
    return { x, y, w: Math.max(Math.abs(it.ax - it.lx), 1), h: Math.max(Math.abs(it.ay - it.ly), 1) };
  }
  // Its line: right angles, from the label end to the anchor. h: across, then up or down;
  // v: up or down, then across; z: across halfway, up or down, across.
  function calloutPoints(it) {
    const { lx, ly, ax, ay } = it;
    if (it.bend === 'v') return [[lx, ly], [lx, ay], [ax, ay]];
    if (it.bend === 'z') { const mx = (lx + ax) / 2; return [[lx, ly], [mx, ly], [mx, ay], [ax, ay]]; }
    return [[lx, ly], [ax, ly], [ax, ay]];
  }
  // The points as an SVG path (px), its corners rounded a little.
  function roundedPath(pts, r) {
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
      const [x, y] = pts[i];
      if (i < pts.length - 1) {
        const [px, py] = pts[i - 1], [nx, ny] = pts[i + 1];
        const r1 = Math.min(r, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
        const ux = Math.sign(x - px), uy = Math.sign(y - py), vx = Math.sign(nx - x), vy = Math.sign(ny - y);
        d += ` L${x - ux * r1},${y - uy * r1} Q${x},${y} ${x + vx * r1},${y + vy * r1}`;
      } else d += ` L${x},${y}`;
    }
    return d;
  }

  // An elbow's L, for its top-left corner (the others are this, mirrored), in px.
  function elbowPath(w, h, side, arm, ri) {
    // (The outer curve an ellipse, as LCARS draws it: wide across the spine, short down the arm.)
    side = Math.min(side, w); arm = Math.min(arm, h); ri = Math.max(0, Math.min(ri, w - side, h - arm));
    const rx = Math.min(w, side * 0.6 + ri), ry = Math.min(h, arm * 2.5 + ri);
    return `M0,${h} L0,${ry} A${rx},${ry} 0 0 1 ${rx},0 L${w},0 L${w},${arm} L${side + ri},${arm} A${ri},${ri} 0 0 0 ${side},${arm + ri} L${side},${h} Z`;
  }
  // Where a container's children go: its regions (cells, from its corner), each a free area
  // (children placed where they're put) or a stack (one under another, or across).
  // An elbow: its body, and its spine (menu blocks); a capsule: inside it; a stack: itself;
  // a header + body pair: the header, the body, and the lower spine (menu blocks).
  function regions(it) {
    const g = 1;
    if (it.type === 'elbow') {
      const s = Math.min(it.side ?? 12, it.w), a = Math.min(it.arm ?? 4, it.h), r = it.radius ?? 3, closed = it.end === 'closed';
      const left = it.corner?.[1] !== 'r', top = it.corner?.[0] !== 'b';
      const bodyY = closed || top ? a + g : 0, bodyH = it.h - (closed ? 2 * (a + g) : a + g);
      const spineY = closed || top ? a + r + g : 0, spineH = it.h - (closed ? 2 * (a + r + g) : a + r + g);
      return [
        { name: 'body', x: left ? s + g : 0, y: bodyY, w: Math.max(0, it.w - s - g), h: Math.max(0, bodyH) },
        { name: 'spine', x: left ? 0 : it.w - s, y: spineY, w: s, h: Math.max(0, spineH), stack: 'v', gap: 0.5, menu: true },
      ];
    }
    if (it.type === 'lpair') {
      const s = it.side ?? 14, a = it.arm ?? 3, r = it.radius ?? 3, hh = it.header ?? 18, gp = it.gap ?? 1, closed = it.end === 'closed';
      const bodyTop = hh + gp;
      return [
        { name: 'header', x: s + g, y: closed ? a + g : 0, w: Math.max(0, it.w - s - g), h: Math.max(0, hh - a - g - (closed ? a + g : 0)) },
        { name: 'body', x: s + g, y: bodyTop + a + g, w: Math.max(0, it.w - s - g), h: Math.max(0, it.h - bodyTop - a - g - (closed ? a + g : 0)) },
        { name: 'spine', x: 0, y: bodyTop + a + r + g, w: s, h: Math.max(0, it.h - bodyTop - a - r - g - (closed ? a + r + g : 0)), stack: 'v', gap: 0.5, menu: true },
      ];
    }
    if (it.type === 'frame') { const t = (it.thick ?? 2) + 1; return [{ name: 'body', x: t, y: t, w: Math.max(0, it.w - 2 * t), h: Math.max(0, it.h - 2 * t) }]; }
    if (it.type === 'stack') return [{ name: 'body', x: 0, y: 0, w: it.w, h: it.h, stack: it.dir === 'h' ? 'h' : 'v', gap: it.gap ?? 1 }];
    return [];
  }
  const regionOf = (it, ch) => { const rs = regions(it); return rs.find((r) => r.name === ch.region) || rs[0]; };
  // Each child's box (cells, from the container's corner): { id: box }.
  function childBoxes(it) {
    const out = {};
    for (const r of regions(it)) {
      const kids = (it.children || []).filter((c) => c.type !== 'callout' && regionOf(it, c).name === r.name);
      let at = 0;
      for (const c of kids) {
        if (r.stack === 'h') { out[c.id] = { x: r.x + at, y: r.y, w: c.w, h: r.h }; at += c.w + r.gap; }
        else if (r.stack) { out[c.id] = { x: r.x, y: r.y + at, w: r.w, h: c.h }; at += c.h + r.gap; }
        else out[c.id] = { x: r.x + c.x, y: r.y + c.y, w: c.w, h: c.h };
      }
    }
    return out;
  }

  const el = (tag, cls, css) => { const e = document.createElement(tag); if (cls) e.className = cls; if (css) Object.assign(e.style, css); return e; };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); return e; };
  const px = (n) => `${n * CELL}px`;
  const textOf = (it) => String(it.text ?? '');

  // One item (and its children), placed at box (cells, in its parent).
  function drawItem(it, box, opts) {
    const node = el('div', `lyt-item lyt-${it.type}`, { left: px(box.x), top: px(box.y), width: px(box.w), height: px(box.h) });
    node.dataset.id = it.id;
    const c = color(it.color);
    const W = box.w * CELL, H = box.h * CELL;
    const label = (txt, css) => { const s = el('span', 'lyt-label', css); s.textContent = txt; return s; };
    switch (it.type) {
      case 'elbow': {
        const s = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'lyt-shape' });
        const right = it.corner?.[1] === 'r', bottom = it.corner?.[0] === 'b';
        const L = (x, y, w, h, flipX, flipY, fill) => s.appendChild(svg('path', { d: elbowPath(w, h, (it.side ?? 12) * CELL, (it.arm ?? 4) * CELL, (it.radius ?? 3) * CELL), fill, transform: `translate(${x + (flipX ? w : 0)},${y + (flipY ? h : 0)}) scale(${flipX ? -1 : 1},${flipY ? -1 : 1})` }));
        if (it.end === 'closed') { L(0, 0, W, H / 2 + 1, right, false, c); L(0, H / 2, W, H / 2, right, true, c); }
        else L(0, 0, W, H, right, bottom, c);
        node.appendChild(s);
        if (textOf(it)) node.appendChild(label(textOf(it), { [right ? 'right' : 'left']: '0', width: px(it.side ?? 12), [bottom ? 'top' : 'bottom']: '2px', justifyContent: 'flex-end', paddingRight: '6px', color: '#000', fontSize: px(Math.min(2.4, (it.side ?? 12) / 4)) }));
        break;
      }
      case 'lpair': {
        // The header's L (its spine curving into the bar under it) over the body's (a bar curving
        // into the spine): two bars facing across the gap. Closed: each a C.
        const s = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'lyt-shape' });
        const side = (it.side ?? 14) * CELL, arm = (it.arm ?? 3) * CELL, ri = (it.radius ?? 3) * CELL, hh = (it.header ?? 18) * CELL, top = hh + (it.gap ?? 1) * CELL;
        const L = (y, h, flipY, fill) => s.appendChild(svg('path', { d: elbowPath(W, h, side, arm, ri), fill, transform: `translate(0,${y + (flipY ? h : 0)}) scale(1,${flipY ? -1 : 1})` }));
        const c2 = color(it.color2, 'lilac');
        if (it.end === 'closed') { L(0, hh / 2 + 1, false, c2); L(hh / 2, hh / 2, true, c2); L(top, (H - top) / 2 + 1, false, c); L(top + (H - top) / 2, (H - top) / 2, true, c); }
        else { L(0, hh, true, c2); L(top, H - top, false, c); }
        node.appendChild(s);
        if (textOf(it)) node.appendChild(label(textOf(it), { left: '0', width: `${side}px`, top: `${top + arm + 4}px`, justifyContent: 'flex-end', paddingRight: '6px', color: '#000', fontSize: px(2) }));
        break;
      }
      case 'hbar': case 'vbar': case 'block':
        node.style.background = c;
        if (textOf(it)) node.appendChild(label(textOf(it), { right: '6px', bottom: '2px', color: '#000', fontSize: px(it.size ?? Math.min(2.4, Math.max(1.4, box.h * 0.6))) }));
        break;
      case 'cap':
        node.style.background = c;
        node.style.borderRadius = it.side === 'right' ? `0 ${H / 2}px ${H / 2}px 0` : `${H / 2}px 0 0 ${H / 2}px`;
        break;
      case 'pill':
        node.style.background = c; node.style.borderRadius = `${H / 2}px`;
        node.appendChild(label(textOf(it), { right: `${H / 2}px`, bottom: '2px', color: '#000', fontSize: px(Math.min(2.4, box.h * 0.45)) }));
        break;
      case 'pillbar': {
        const row = el('div', 'lyt-pillbar-row');
        const cap = (side) => { const d = el('span', 'lyt-pb-cap', { background: c, width: px(Math.min(3, box.h * 0.7)), borderRadius: side === 'l' ? `${H / 2}px 0 0 ${H / 2}px` : `0 ${H / 2}px ${H / 2}px 0` }); return d; };
        row.appendChild(cap('l'));
        const seg = (t, cls) => { const d = el('span', `lyt-pb-seg ${cls}`, { fontSize: px(Math.min(2.2, box.h * 0.42)) }); d.textContent = t; return d; };
        row.appendChild(Object.assign(seg(textOf(it), 'lyt-pb-label'), { style: `background:${c};font-size:${px(Math.min(2.2, box.h * 0.42))}` }));
        for (const o of String(it.options || '').split(',').map((s) => s.trim()).filter(Boolean)) row.appendChild(Object.assign(seg(o, 'lyt-pb-opt'), { style: `border-color:${c};color:${c};font-size:${px(Math.min(2.2, box.h * 0.42))}` }));
        row.appendChild(cap('r'));
        node.appendChild(row);
        break;
      }
      case 'text': {
        const t = label(textOf(it), { position: 'static', color: c, fontSize: px(it.size ?? 3), lineHeight: '1', justifyContent: { left: 'flex-start', center: 'center', right: 'flex-end' }[it.align || 'left'], width: '100%', height: '100%', alignItems: 'center' });
        node.appendChild(t);
        break;
      }
      case 'frame': {
        const t = (it.thick ?? 2) * CELL, a = Math.min((it.arm ?? 6) * CELL, W / 2), r = Math.min(H / 2, a + t);
        node.appendChild(el('div', 'lyt-bracket', { left: 0, width: `${a}px`, border: `${t}px solid ${c}`, borderRight: 'none', borderRadius: `${r}px 0 0 ${r}px` }));
        node.appendChild(el('div', 'lyt-bracket', { right: 0, width: `${a}px`, border: `${t}px solid ${c}`, borderLeft: 'none', borderRadius: `0 ${r}px ${r}px 0` }));
        break;
      }
      case 'stack':
        if (it.color) node.style.background = color(it.color);
        break;
      case 'image':
        if (it.src) {
          const img = el('img', 'lyt-img', { objectFit: it.fit === 'cover' ? 'cover' : 'contain' });
          img.src = /^(https?:|data:|\/)/.test(it.src) ? it.src : `/layouts/assets/${encodeURIComponent(it.src)}`;
          img.alt = it.text || '';
          img.draggable = false;
          node.appendChild(img);
        } else if (opts.editor) node.appendChild(label('Image', { position: 'static', margin: 'auto', color: '#666', fontSize: px(2.4) }));
        if (!it.src && opts.editor) node.classList.add('lyt-empty');
        break;
    }
    if (CONTAINERS.has(it.type) && it.children?.length) {
      const boxes = childBoxes(it);
      // (A spine with menu blocks: black between them, its colour again below the last.)
      for (const r of regions(it).filter((x) => x.menu)) {
        const kids = it.children.filter((ch) => regionOf(it, ch).name === r.name);
        if (!kids.length) continue;
        const used = kids.reduce((n, ch) => n + ch.h + r.gap, 0);
        node.appendChild(el('div', 'lyt-spine-gap', { left: px(r.x), top: px(r.y), width: px(r.w), height: px(Math.min(used, r.h)), background: '#000' }));
      }
      for (const ch of it.children) if (ch.type !== 'callout' && boxes[ch.id]) node.appendChild(drawItem(ch, boxes[ch.id], opts));
    }
    if (opts.editor && CONTAINERS.has(it.type)) node.classList.add('lyt-container');
    return node;
  }

  // The callouts: lines in one SVG over everything, their labels beside their ends.
  function drawCallouts(items, stage, W, H, opts) {
    const layer = svg('svg', { class: 'lyt-callouts', width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    for (const it of items.filter((i) => i.type === 'callout')) {
      const pts = calloutPoints(it).map(([x, y]) => [x * CELL, y * CELL]);
      const c = color(it.color);
      const g = svg('g', { 'data-id': it.id, class: 'lyt-callout' });
      if (opts.editor) g.appendChild(svg('path', { d: roundedPath(pts, 10), stroke: 'transparent', 'stroke-width': 12, fill: 'none', class: 'lyt-callout-hit' }));
      g.appendChild(svg('path', { d: roundedPath(pts, 10), stroke: c, 'stroke-width': 1.5, fill: 'none' }));
      g.appendChild(svg('circle', { cx: pts.at(-1)[0], cy: pts.at(-1)[1], r: 2.5, fill: c }));
      layer.appendChild(g);
      const left = it.bend === 'v' ? it.lx <= it.ax : it.lx <= it.ax; // (the label sits on the far side from the anchor)
      const t = el('span', 'lyt-callout-label', { top: `${it.ly * CELL}px`, color: c, fontSize: px(it.size ?? 1.6), [left ? 'right' : 'left']: `${left ? W - it.lx * CELL + 4 : it.lx * CELL + 4}px` });
      t.textContent = textOf(it);
      t.dataset.id = it.id;
      stage.appendChild(t);
    }
    stage.appendChild(layer);
  }

  // The layout built in host: a stage W×H px, scaled to host's width (or to fit both ways).
  function render(layout, host, opts = {}) {
    const W = COLS * CELL, H = rows(layout.aspect) * CELL;
    const stage = el('div', 'lyt-stage', { width: `${W}px`, height: `${H}px` });
    stage.dataset.aspect = layout.aspect || '16:9';
    for (const it of layout.items || []) if (it.type !== 'callout') stage.appendChild(drawItem(it, it, opts));
    drawCallouts(layout.items || [], stage, W, H, opts);
    host.replaceChildren(stage);
    fit(stage, host, opts.contain);
    return stage;
  }
  function fit(stage, host, contain) {
    const W = parseFloat(stage.style.width), H = parseFloat(stage.style.height);
    const s = contain ? Math.min(host.clientWidth / W, host.clientHeight / H) : host.clientWidth / W;
    stage.style.transform = `scale(${s || 1})`;
    stage.style.transformOrigin = '0 0';
    if (!contain) host.style.height = `${H * (s || 1)}px`;
    stage.dataset.scale = s || 1;
    return s || 1;
  }

  window.LCARSLayout = { CELL, COLS, SWATCHES, HEX, KINDS, CONTAINERS, rows, render, fit, regions, regionOf, childBoxes, calloutBox, calloutPoints };
})();
