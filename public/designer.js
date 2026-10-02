// The LCARS layout designer (admin): parts dragged onto a canvas (or tapped on), moved and
// resized on a grid, dropped into containers (elbows, capsules, panel stacks, header + body
// pairs), set by taps; saved as config/layouts/<name>.json. lcars-layout.js draws it, here and
// anywhere a layout is shown. Pointer events throughout: a mouse, a pen or a finger.
(function () {
  const L = window.LCARSLayout;
  const { CELL, KINDS, CONTAINERS } = L;
  const $ = (id) => document.getElementById(id);
  const canvas = $('lyt-canvas');
  const blank = () => ({ name: '', title: '', aspect: '16:9', items: [] });
  const st = { layout: blank(), sel: [], undo: [], redo: [], snap: true, grid: true, saved: [], assets: [], drag: null, dirty: false };
  window.__designer = st;
  let seq = 0;
  const newId = (type) => { let id; do id = `${type}-${(++seq).toString(36)}${Math.random().toString(36).slice(2, 5)}`; while (find(id)); return id; };

  // --- the layout's tree -------------------------------------------------------------------
  // An item, its parent (null: the canvas) and the list it's in.
  function find(id, items = st.layout.items, parent = null) {
    for (const it of items) {
      if (it.id === id) return { item: it, parent, list: items };
      if (it.children) { const f = find(id, it.children, it); if (f) return f; }
    }
    return null;
  }
  const within = (id, ancestorId) => { for (let f = find(id); f; f = f.parent && find(f.parent.id)) if (f.item.id === ancestorId) return true; return false; };
  // An item's box on the canvas (cells).
  function absBox(id) {
    const f = find(id);
    if (!f) return null;
    if (f.item.type === 'callout') return L.calloutBox(f.item);
    if (!f.parent) return { x: f.item.x, y: f.item.y, w: f.item.w, h: f.item.h };
    const p = absBox(f.parent.id), b = L.childBoxes(f.parent)[id] || { x: 0, y: 0, w: f.item.w, h: f.item.h };
    return { x: p.x + b.x, y: p.y + b.y, w: b.w, h: b.h };
  }
  // The innermost container region under a point (cells), not one of the items moving.
  function dropTarget(pt, moving = []) {
    let best = null;
    const walk = (items) => {
      for (const it of items) {
        if (moving.some((m) => it.id === m || within(it.id, m))) continue;
        if (CONTAINERS.has(it.type)) {
          const b = absBox(it.id);
          for (const r of L.regions(it)) {
            const x = b.x + r.x, y = b.y + r.y;
            if (pt.x >= x && pt.x <= x + r.w && pt.y >= y && pt.y <= y + r.h) best = { container: it, region: r, x, y };
          }
        }
        if (it.children) walk(it.children);
      }
    };
    walk(st.layout.items);
    return best;
  }
  const rows = () => L.rows(st.layout.aspect);
  const snapTo = (v) => (st.snap ? Math.round(v) : Math.round(v * 4) / 4);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const reId = (it) => { it.id = newId(it.type); (it.children || []).forEach(reId); return it; };

  // Put an item (box on the canvas, cells) into a container region (or onto the canvas).
  function place(item, box, target, pt) {
    if (item.type === 'callout' || !target) {
      if (item.type !== 'callout') Object.assign(item, { x: box.x, y: box.y });
      delete item.region;
      st.layout.items.push(item);
      return;
    }
    const c = target.container, r = target.region;
    c.children ||= [];
    item.region = r.name;
    if (r.stack) {
      // (In a stack: before the first child its middle is past.)
      const boxes = L.childBoxes(c), base = absBox(c.id);
      const kids = c.children.filter((k) => L.regionOf(c, k).name === r.name);
      const at = kids.find((k) => { const b = boxes[k.id]; return r.stack === 'h' ? pt.x < base.x + b.x + b.w / 2 : pt.y < base.y + b.y + b.h / 2; });
      if (r.stack === 'h') item.w = Math.max(1, Math.min(item.w, r.w)); else item.h = Math.max(1, Math.min(item.h, r.h));
      item.x = 0; item.y = 0;
      c.children.splice(at ? c.children.indexOf(at) : c.children.length, 0, item);
    } else {
      item.x = Math.max(0, snapTo(box.x - target.x));
      item.y = Math.max(0, snapTo(box.y - target.y));
      c.children.push(item);
    }
  }
  function detach(id) { const f = find(id); if (f) f.list.splice(f.list.indexOf(f.item), 1); return f; }

  // --- history -----------------------------------------------------------------------------
  const snapshot = () => JSON.stringify(st.layout);
  function remember(before) { st.undo.push(before); if (st.undo.length > 200) st.undo.shift(); st.redo = []; st.dirty = true; }
  function change(fn) { const before = snapshot(); fn(); if (snapshot() !== before) remember(before); draw(); }
  function undo() { if (!st.undo.length) return; st.redo.push(snapshot()); st.layout = JSON.parse(st.undo.pop()); prune(); draw(); }
  function redo() { if (!st.redo.length) return; st.undo.push(snapshot()); st.layout = JSON.parse(st.redo.pop()); prune(); draw(); }
  const prune = () => { st.sel = st.sel.filter((id) => find(id)); };

  // --- drawing -----------------------------------------------------------------------------
  let stage = null;
  const scale = () => Number(stage?.dataset.scale || 1);
  function draw() {
    stage = L.render(st.layout, canvas, { editor: true });
    stage.classList.toggle('lyt-grid', st.grid);
    stage.style.backgroundSize = `${CELL * 2}px ${CELL * 2}px`;
    drawOverlay();
    drawProps();
    drawToolbar();
    $('lyt-name-shown').textContent = st.layout.title || st.layout.name || 'New layout';
    if (document.activeElement !== $('lyt-name')) $('lyt-name').value = st.layout.name || '';
    if (document.activeElement !== $('lyt-title')) $('lyt-title').value = st.layout.title || '';
  }
  // Selection outlines and handles; the drop target while dragging; the preview of a move.
  function drawOverlay() {
    stage.querySelector('.lyt-overlay')?.remove();
    const ov = document.createElement('div');
    ov.className = 'lyt-overlay';
    const box = (b, cls) => { const d = document.createElement('div'); d.className = cls; Object.assign(d.style, { left: `${b.x * CELL}px`, top: `${b.y * CELL}px`, width: `${b.w * CELL}px`, height: `${b.h * CELL}px` }); ov.appendChild(d); return d; };
    const hs = Math.max(8, 12 / scale());
    const handle = (x, y, data, cls = '') => {
      const d = document.createElement('div');
      d.className = `lyt-handle ${cls}`;
      Object.assign(d.style, { left: `${x * CELL - hs / 2}px`, top: `${y * CELL - hs / 2}px`, width: `${hs}px`, height: `${hs}px`, cursor: data.cursor || 'pointer' });
      Object.assign(d.dataset, data.set);
      ov.appendChild(d);
    };
    const d = st.drag;
    if (d?.target) { const t = d.target; box({ x: t.x, y: t.y, w: t.region.w, h: t.region.h }, 'lyt-target'); }
    if (d?.ghosts) for (const g of d.ghosts) box(g, 'lyt-sel lyt-sel--ghost');
    for (const id of st.sel) {
      const f = find(id), b = absBox(id);
      if (!f || !b) continue;
      if (f.item.type === 'callout') {
        handle(f.item.lx, f.item.ly, { set: { handle: 'l', id }, cursor: 'grab' }, 'lyt-handle--point');
        handle(f.item.ax, f.item.ay, { set: { handle: 'a', id }, cursor: 'crosshair' }, 'lyt-handle--point');
        continue;
      }
      box(b, 'lyt-sel');
      if (st.sel.length !== 1) continue;
      const inStack = f.parent && L.regionOf(f.parent, f.item).stack;
      const dirs = inStack ? (L.regionOf(f.parent, f.item).stack === 'h' ? ['e'] : ['s']) : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
      for (const dir of dirs) {
        const x = b.x + (dir.includes('w') ? 0 : dir.includes('e') ? b.w : b.w / 2), y = b.y + (dir.includes('n') ? 0 : dir.includes('s') ? b.h : b.h / 2);
        handle(x, y, { set: { handle: dir, id }, cursor: `${dir}-resize` });
      }
    }
    stage.appendChild(ov);
  }

  // --- pointer: the canvas ----------------------------------------------------------------
  // A pointer's place on the canvas (cells).
  function at(e) { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) / scale() / CELL, y: (e.clientY - r.top) / scale() / CELL }; }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    canvas.focus({ preventScroll: true });
    const pt = at(e), h = e.target.closest('.lyt-handle');
    const hit = e.target.closest('[data-id]');
    if (h) {
      const before = snapshot(), f = find(h.dataset.id);
      st.drag = { kind: h.dataset.handle.length === 1 && 'al'.includes(h.dataset.handle) && f.item.type === 'callout' ? 'point' : 'resize', handle: h.dataset.handle, id: h.dataset.id, start: pt, orig: clone(f.item), box: absBox(h.dataset.id), before };
    } else if (hit && find(hit.dataset.id)) {
      const id = hit.dataset.id;
      if (e.shiftKey || e.ctrlKey || e.metaKey) st.sel = st.sel.includes(id) ? st.sel.filter((x) => x !== id) : [...st.sel, id];
      else if (!st.sel.includes(id)) st.sel = [id];
      // (Moving a container's child with the container: just the container.)
      const moving = st.sel.filter((s) => !st.sel.some((o) => o !== s && within(s, o)));
      st.drag = { kind: 'move', ids: moving, start: pt, orig: Object.fromEntries(moving.map((m) => [m, { item: clone(find(m).item), box: absBox(m) }])), before: snapshot(), moved: false };
    } else {
      st.sel = [];
      st.drag = null;
    }
    canvas.setPointerCapture(e.pointerId);
    draw();
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    const d = st.drag;
    if (!d) return;
    const pt = at(e), dx = pt.x - d.start.x, dy = pt.y - d.start.y;
    if (d.kind === 'move') {
      if (!d.moved && Math.hypot(dx, dy) * CELL * scale() < 4) return;
      d.moved = true;
      const sx = snapTo(dx), sy = snapTo(dy);
      d.ghosts = [];
      for (const id of d.ids) {
        const o = d.orig[id], it = find(id).item;
        if (it.type === 'callout') Object.assign(it, { lx: o.item.lx + sx, ly: o.item.ly + sy, ax: o.item.ax + sx, ay: o.item.ay + sy });
        else d.ghosts.push({ x: o.box.x + sx, y: o.box.y + sy, w: o.box.w, h: o.box.h });
      }
      const t = dropTarget(pt, d.ids);
      d.target = d.ids.some((id) => find(id).item.type !== 'callout') ? t : null;
      draw();
    } else if (d.kind === 'resize') {
      const b = { ...d.box }, h = d.handle, it = find(d.id).item;
      if (h.includes('e')) b.w = Math.max(1, snapTo(d.box.w + dx));
      if (h.includes('s')) b.h = Math.max(1, snapTo(d.box.h + dy));
      if (h.includes('w')) { const nx = Math.min(d.box.x + d.box.w - 1, snapTo(d.box.x + dx)); b.w = d.box.x + d.box.w - nx; b.x = nx; }
      if (h.includes('n')) { const ny = Math.min(d.box.y + d.box.h - 1, snapTo(d.box.y + dy)); b.h = d.box.y + d.box.h - ny; b.y = ny; }
      it.w = b.w; it.h = b.h;
      it.x = d.orig.x + (b.x - d.box.x); it.y = d.orig.y + (b.y - d.box.y);
      draw();
    } else if (d.kind === 'point') {
      const it = find(d.id).item, p = { x: snapTo(pt.x), y: snapTo(pt.y) };
      if (d.handle === 'a') Object.assign(it, { ax: p.x, ay: p.y }); else Object.assign(it, { lx: p.x, ly: p.y });
      Object.assign(it, L.calloutBox(it));
      draw();
    }
  });
  const endDrag = (e) => {
    const d = st.drag;
    if (!d) return;
    st.drag = null;
    if (d.kind === 'move' && d.moved) {
      const pt = at(e), sx = snapTo(pt.x - d.start.x), sy = snapTo(pt.y - d.start.y);
      const target = dropTarget(pt, d.ids);
      for (const id of d.ids) {
        const o = d.orig[id], f = find(id);
        if (f.item.type === 'callout') { Object.assign(f.item, L.calloutBox(f.item)); continue; }
        const box = { x: o.box.x + sx, y: o.box.y + sy, w: o.box.w, h: o.box.h };
        const sameFree = target && f.parent === target.container && L.regionOf(f.parent, f.item).name === target.region.name && !target.region.stack;
        if (sameFree || (!target && !f.parent)) {
          // (Moved where it is: its place in its parent.)
          f.item.x = Math.max(f.parent ? 0 : -1e6, snapTo(o.item.x + sx)); f.item.y = Math.max(f.parent ? 0 : -1e6, snapTo(o.item.y + sy));
          continue;
        }
        detach(id);
        f.item.w = box.w; f.item.h = box.h;
        place(f.item, box, target, pt);
      }
    }
    if (d.kind === 'point') { const it = find(d.id)?.item; if (it) Object.assign(it, L.calloutBox(it)); }
    if (snapshot() !== d.before) remember(d.before);
    draw();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // --- pointer: the palette (drag a part on, or tap it) -----------------------------------
  const ghost = $('lyt-ghost');
  function addPart(kind, pt, target) {
    const k = KINDS[kind], type = k.type || kind;
    const item = { id: newId(type), type, ...clone(Object.fromEntries(Object.entries(k).filter(([f]) => !['label', 'type'].includes(f)))) };
    if (type === 'callout') {
      const x = snapTo(pt.x), y = snapTo(pt.y);
      Object.assign(item, { lx: x, ly: y, ax: Math.min(L.COLS - 1, x + 20), ay: Math.min(rows() - 1, y + 8) });
      Object.assign(item, L.calloutBox(item));
    }
    const box = { x: snapTo(pt.x - item.w / 2), y: snapTo(pt.y - item.h / 2), w: item.w, h: item.h };
    change(() => place(item, box, type === 'callout' ? null : target, pt));
    st.sel = [item.id];
    draw();
    return item;
  }
  function drawPalette() {
    const pal = $('lyt-palette');
    const accents = ['--lcars-lilac', '--lcars-orange', '--lcars-peach', '--lcars-gold', '--lcars-sky', '--lcars-blue', '--lcars-tan', '--lcars-violet'];
    pal.replaceChildren(...Object.entries(KINDS).map(([kind, k], i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lcars-nav-button';
      b.dataset.add = kind;
      b.style.setProperty('--accent', `var(${accents[i % accents.length]})`);
      b.innerHTML = '<span></span>';
      b.firstChild.textContent = k.label;
      b.addEventListener('pointerdown', (e) => {
        if (e.button > 0) return;
        b.setPointerCapture(e.pointerId);
        st.drag = { kind: 'new', part: kind, x0: e.clientX, y0: e.clientY, moved: false };
        e.preventDefault();
      });
      b.addEventListener('pointermove', (e) => {
        const d = st.drag;
        if (d?.kind !== 'new') return;
        if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
        d.moved = true;
        Object.assign(ghost.style, { left: `${e.clientX}px`, top: `${e.clientY}px` });
        ghost.textContent = k.label;
        ghost.hidden = false;
        const r = canvas.getBoundingClientRect(), over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        d.target = over && kind !== 'callout' ? dropTarget(at(e)) : null;
        drawOverlay();
      });
      const done = (e) => {
        const d = st.drag;
        if (d?.kind !== 'new') return;
        st.drag = null;
        ghost.hidden = true;
        const r = canvas.getBoundingClientRect();
        if (!d.moved && e.type === 'pointerup') {
          // A tap: into the one container picked (its first region), or the canvas's middle.
          const c = st.sel.length === 1 && find(st.sel[0]).item;
          if (c && CONTAINERS.has(c.type) && kind !== 'callout') {
            const b = absBox(c.id), reg = L.regions(c).find((x) => !x.menu) || L.regions(c)[0];
            addPart(kind, { x: b.x + reg.x + reg.w / 2, y: b.y + reg.y + Math.min(reg.h / 2, (KINDS[kind].h || 4) / 2 + 1) }, { container: c, region: reg, x: b.x + reg.x, y: b.y + reg.y });
          } else addPart(kind, { x: L.COLS / 2, y: rows() / 2 }, null);
        } else if (e.type === 'pointerup' && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          const pt = at(e);
          addPart(kind, pt, kind === 'callout' ? null : dropTarget(pt));
        } else draw();
      };
      b.addEventListener('pointerup', done);
      b.addEventListener('pointercancel', done);
      return b;
    }), Object.assign(document.createElement('div'), { className: 'lcars-sidebar__fill' }));
  }

  // --- keys ---------------------------------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) return;
    if (!$('lyt-preview').hidden) { if (e.key === 'Escape') closePreview(); return; }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); return redo(); }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); return duplicate(); }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); return save(); }
    if (!st.sel.length) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return remove(); }
    const step = e.shiftKey ? 4 : st.snap ? 1 : 0.25;
    const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (mv) { e.preventDefault(); nudge(...mv); }
    if (e.key === 'Escape') { st.sel = []; draw(); }
  });
  function nudge(dx, dy) {
    change(() => {
      for (const id of st.sel) {
        const f = find(id);
        if (!f) continue;
        if (f.item.type === 'callout') { f.item.lx += dx; f.item.ax += dx; f.item.ly += dy; f.item.ay += dy; Object.assign(f.item, L.calloutBox(f.item)); continue; }
        if (f.parent && L.regionOf(f.parent, f.item).stack) {
          // (In a stack, up/left and down/right reorder it.)
          const i = f.list.indexOf(f.item), j = i + Math.sign(dx + dy);
          if (j >= 0 && j < f.list.length) [f.list[i], f.list[j]] = [f.list[j], f.list[i]];
          continue;
        }
        f.item.x = f.parent ? Math.max(0, f.item.x + dx) : f.item.x + dx;
        f.item.y = f.parent ? Math.max(0, f.item.y + dy) : f.item.y + dy;
      }
    });
  }
  function remove() { change(() => { for (const id of st.sel) detach(id); st.sel = []; }); }
  function duplicate() {
    if (!st.sel.length) return;
    const made = [];
    change(() => {
      for (const id of st.sel) {
        const f = find(id);
        if (!f) continue;
        const c = reId(clone(f.item));
        if (c.type === 'callout') { c.lx += 2; c.ly += 2; c.ax += 2; c.ay += 2; Object.assign(c, L.calloutBox(c)); } else { c.x += 2; c.y += 2; }
        f.list.splice(f.list.indexOf(f.item) + 1, 0, c);
        made.push(c.id);
      }
    });
    st.sel = made;
    draw();
  }
  // Layers: forward (drawn later, over the rest) and back.
  function layer(dir) {
    change(() => {
      const order = dir > 0 ? [...st.sel].reverse() : st.sel;
      for (const id of order) {
        const f = find(id), i = f.list.indexOf(f.item), j = dir === 2 ? f.list.length - 1 : dir === -2 ? 0 : i + dir;
        if (j < 0 || j >= f.list.length || j === i) continue;
        f.list.splice(i, 1); f.list.splice(j, 0, f.item);
      }
    });
  }

  // --- taps ---------------------------------------------------------------------------------
  function tap(text, on, fn, { id, pressed, value, title } = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lcars-button tr-tap';
    b.textContent = text;
    if (id) b.id = id;
    if (value !== undefined) b.dataset.value = value;
    if (pressed !== undefined) b.setAttribute('aria-pressed', String(!!pressed));
    if (title) b.title = title;
    b.disabled = on === false;
    b.addEventListener('click', fn);
    return b;
  }
  function drawToolbar() {
    const one = st.sel.length > 0;
    $('lyt-toolbar').replaceChildren(
      pillBar('Edit', [
        tap('Undo', st.undo.length > 0, undo, { id: 'lyt-undo' }), tap('Redo', st.redo.length > 0, redo, { id: 'lyt-redo' }),
        tap('Duplicate', one, duplicate, { id: 'lyt-dup' }), tap('Delete', one, remove, { id: 'lyt-del' }),
      ]),
      pillBar('Layer', [
        tap('To back', one, () => layer(-2)), tap('Back', one, () => layer(-1), { id: 'lyt-back' }), tap('Forward', one, () => layer(1), { id: 'lyt-forward' }), tap('To front', one, () => layer(2)),
      ]),
      pillBar('Canvas', [
        ...['16:9', '21:9', '16:10', '4:3'].map((a) => tap(a, true, () => change(() => { st.layout.aspect = a; }), { pressed: st.layout.aspect === a, value: a })),
        tap('Snap', true, () => { st.snap = !st.snap; draw(); }, { pressed: st.snap, id: 'lyt-snap' }),
        tap('Grid', true, () => { st.grid = !st.grid; draw(); }, { pressed: st.grid, id: 'lyt-grid' }),
        tap('Preview', true, preview, { id: 'lyt-preview-open' }),
      ], { groupId: 'lyt-aspect' }),
    );
  }
  function drawFilebar() {
    $('lyt-filebar').replaceChildren(pillBar('File', [
      tap('New', true, () => { if (st.dirty && !confirm('Start a new layout? Unsaved changes are lost.')) return; Object.assign(st, { layout: blank(), sel: [], undo: [], redo: [], dirty: false }); status(''); draw(); }, { id: 'lyt-new' }),
      tap('Save', true, save, { id: 'lyt-save' }),
      tap('Save as copy', true, saveCopy, { id: 'lyt-copy' }),
    ]));
    $('lyt-saved').replaceChildren(pillBar('Open', st.saved.length ? st.saved.map((s) => tap(s.title && s.title !== s.name ? `${s.title} (${s.name})` : s.name, true, () => load(s.name), { value: s.name, pressed: s.name === st.layout.name })) : [Object.assign(document.createElement('span'), { className: 'ops-hint', textContent: 'none saved yet' })], { groupId: 'lyt-saved-list' }));
  }

  // --- properties ---------------------------------------------------------------------------
  function drawProps() {
    const host = $('lyt-props');
    const items = st.sel.map((id) => find(id)?.item).filter(Boolean);
    $('lyt-props-title').textContent = items.length === 1 ? (KINDS[items[0].type]?.label || items[0].type) : items.length ? `${items.length} selected` : 'Properties';
    if (!items.length) { host.replaceChildren(Object.assign(document.createElement('p'), { className: 'ops-hint', textContent: 'Tap a part to set it up. Drag parts from the left onto the canvas, or into a container (an elbow, a capsule, a panel stack, a header + body).' })); return; }
    const it = items[0], out = [];
    const set = (fn) => change(() => items.forEach(fn));
    const prop = (label, ...kids) => { const d = document.createElement('div'); d.className = 'lyt-prop'; if (label) d.append(Object.assign(document.createElement('span'), { className: 'tr-label', textContent: label })); d.append(...kids); return d; };
    const textField = (field, label, id) => {
      const i = document.createElement('input');
      i.value = it[field] ?? ''; i.id = id || `lyt-prop-${field}`; i.autocomplete = 'off';
      i.addEventListener('change', () => set((x) => { x[field] = i.value; }));
      return prop(label, i);
    };
    const stepper = (field, label, { min = 0, max = 200, step = 1, def = 0 } = {}) => {
      const v = it[field] ?? def, o = document.createElement('output');
      o.textContent = v; o.id = `lyt-prop-${field}`;
      const by = (d) => () => set((x) => { x[field] = Math.max(min, Math.min(max, Math.round(((x[field] ?? def) + d) * 100) / 100)); });
      const s = document.createElement('span'); s.className = 'lyt-step';
      s.append(tap('−', true, by(-step), { id: `lyt-prop-${field}-down` }), o, tap('+', true, by(step), { id: `lyt-prop-${field}-up` }));
      return prop(label, s);
    };
    const choice = (field, label, options) => pillBar(label, options.map(([v, t]) => tap(t, true, () => set((x) => { x[field] = v; }), { pressed: it[field] === v, value: v })), { groupId: `lyt-prop-${field}` });
    const swatches = (field, label, none) => {
      const g = document.createElement('div'); g.className = 'tr-taps'; g.id = `lyt-prop-${field}`;
      if (none) { const b = tap('', true, () => set((x) => { x[field] = ''; }), { pressed: !it[field], value: '', title: 'none' }); b.className = 'lyt-swatch lyt-swatch--none'; g.append(b); }
      for (const c of L.SWATCHES) {
        const b = tap('', true, () => set((x) => { x[field] = c; }), { pressed: it[field] === c, value: c, title: c });
        b.className = 'lyt-swatch'; b.style.background = L.HEX[c];
        g.append(b);
      }
      return prop(label, g);
    };
    const t = it.type;
    if (items.every((x) => x.type !== 'image')) out.push(swatches('color', t === 'lpair' ? 'Body' : t === 'text' ? 'Text' : 'Colour', t === 'stack'));
    if (items.length === 1) {
      if (t === 'lpair') out.push(swatches('color2', 'Header'));
      if (['text', 'pill', 'pillbar', 'hbar', 'vbar', 'block', 'elbow', 'lpair', 'callout'].includes(t)) out.push(textField('text', t === 'pillbar' ? 'Label' : 'Text'));
      if (t === 'pillbar') out.push(textField('options', 'Taps (a, b, c)'));
      if (t === 'elbow') {
        out.push(choice('corner', 'Corner', [['tl', 'Top left'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['br', 'Bottom right']]));
        out.push(choice('end', 'End', [['open', 'Open (more below)'], ['closed', 'Closed C (all shown)']]));
        out.push(stepper('side', 'Spine', { min: 1, def: 12 }), stepper('arm', 'Arm', { min: 1, def: 4 }), stepper('radius', 'Inner curve', { def: 3 }));
      }
      if (t === 'lpair') {
        out.push(choice('end', 'End', [['open', 'Open (more below)'], ['closed', 'Closed C (all shown)']]));
        out.push(stepper('side', 'Spine', { min: 2, def: 14 }), stepper('arm', 'Bars', { min: 1, def: 3 }), stepper('header', 'Header', { min: 4, def: 18 }), stepper('gap', 'Divider', { min: 0.5, step: 0.5, def: 1 }), stepper('radius', 'Inner curve', { def: 3 }));
      }
      if (t === 'frame') out.push(stepper('thick', 'Thickness', { min: 1, def: 2 }), stepper('arm', 'Arms', { min: 1, def: 6 }));
      if (t === 'stack') out.push(choice('dir', 'Direction', [['v', 'Down'], ['h', 'Across']]), stepper('gap', 'Gap', { min: 0, step: 0.5, def: 1 }));
      if (t === 'cap') out.push(choice('side', 'Side', [['left', 'Left'], ['right', 'Right']]));
      if (t === 'text') out.push(choice('align', 'Align', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']]), stepper('size', 'Size', { min: 0.5, step: 0.5, def: 3 }));
      if (t === 'block' || t === 'hbar' || t === 'vbar') out.push(stepper('size', 'Text size', { min: 0.5, step: 0.5, def: 2 }));
      if (t === 'callout') out.push(choice('bend', 'Line', [['h', 'Across, then up/down'], ['v', 'Up/down, then across'], ['z', 'Across, up/down, across']]), stepper('size', 'Text size', { min: 0.5, step: 0.2, def: 1.6 }));
      if (t === 'image') {
        const up = document.createElement('label');
        up.className = 'lcars-button tr-tap lyt-upload';
        up.textContent = 'Upload…';
        const file = document.createElement('input');
        file.type = 'file'; file.accept = 'image/*'; file.id = 'lyt-upload';
        file.addEventListener('change', () => file.files[0] && upload(file.files[0], it.id));
        up.append(file);
        out.push(pillBar('Image', [up, tap('None', true, () => set((x) => { x.src = ''; }), { pressed: !it.src, value: '' }), ...st.assets.map((a) => tap(a, true, () => set((x) => { x.src = a; }), { pressed: it.src === a, value: a }))], { groupId: 'lyt-prop-src' }));
        out.push(choice('fit', 'Fit', [['contain', 'Whole image'], ['cover', 'Fill']]));
      }
      // Place and size (cells), typed.
      if (t !== 'callout') {
        const f = find(it.id), inStack = f.parent && L.regionOf(f.parent, it).stack;
        const nums = document.createElement('div'); nums.className = 'lyt-nums';
        for (const k of inStack ? ['w', 'h'] : ['x', 'y', 'w', 'h']) {
          const lab = document.createElement('label'); lab.textContent = { x: 'X', y: 'Y', w: 'Width', h: 'Height' }[k];
          const i = document.createElement('input'); i.inputMode = 'decimal'; i.value = it[k]; i.id = `lyt-prop-${k}`;
          i.addEventListener('change', () => { const v = Number(i.value); if (Number.isFinite(v)) set((x) => { x[k] = k === 'w' || k === 'h' ? Math.max(1, v) : v; }); });
          lab.append(i); nums.append(lab);
        }
        out.push(prop('Cells', nums));
        if (f.parent) out.push(prop('In', Object.assign(document.createElement('span'), { textContent: `${KINDS[f.parent.type]?.label || f.parent.type}${L.regions(f.parent).length > 1 ? ` · ${L.regionOf(f.parent, it).name}` : ''}` }), tap('Take out', true, () => change(() => { const b = absBox(it.id); detach(it.id); place(it, b, null); }), { id: 'lyt-takeout' })));
      }
    }
    host.replaceChildren(...out);
  }

  // --- files --------------------------------------------------------------------------------
  function status(text, kind) { const s = $('lyt-status'); s.textContent = text; s.className = `lyt-status ${kind || ''}`; }
  async function api(url, opts) {
    const r = await fetch(url, { credentials: 'same-origin', ...opts });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `${r.status} ${r.statusText}`);
    return body;
  }
  async function refresh() {
    try { const v = await api('/api/layouts'); st.saved = v.layouts; st.assets = v.assets; } catch (err) { status(`can't list layouts: ${err.message}`, 'err'); }
    drawFilebar();
    drawProps();
  }
  const nameOk = (n) => /^[a-z0-9][a-z0-9-]{0,47}$/.test(n);
  async function save() {
    const name = $('lyt-name').value.trim().toLowerCase();
    if (!nameOk(name)) { status('name: lower-case letters, digits and - (like vico-msd)', 'err'); $('lyt-name').focus(); return; }
    st.layout.name = name;
    st.layout.title = $('lyt-title').value.trim();
    try {
      await api(`/api/layouts/${name}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st.layout) });
      st.dirty = false;
      status(`saved: config/layouts/${name}.json`, 'ok');
      history.replaceState(null, '', `?layout=${name}`);
    } catch (err) { status(`not saved: ${err.message}`, 'err'); }
    await refresh();
    draw();
  }
  async function saveCopy() {
    const base = ($('lyt-name').value.trim().toLowerCase() || 'layout').replace(/-copy(-\d+)?$/, '');
    let n = `${base}-copy`, i = 2;
    while (st.saved.some((s) => s.name === n)) n = `${base}-copy-${i++}`;
    $('lyt-name').value = n;
    st.layout.title = st.layout.title ? `${st.layout.title} (copy)` : '';
    $('lyt-title').value = st.layout.title;
    await save();
  }
  async function load(name) {
    if (st.dirty && !confirm('Open another layout? Unsaved changes are lost.')) return;
    try {
      const v = await api(`/api/layouts/${encodeURIComponent(name)}`);
      Object.assign(st, { layout: { ...blank(), ...v.layout, name }, sel: [], undo: [], redo: [], dirty: false });
      status(`opened ${name}`, 'ok');
      history.replaceState(null, '', `?layout=${name}`);
    } catch (err) { status(`can't open ${name}: ${err.message}`, 'err'); }
    drawFilebar();
    draw();
  }
  async function upload(file, id) {
    status(`uploading ${file.name}…`);
    try {
      const v = await api('/api/layouts/assets', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(file.name), 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      await refresh();
      change(() => { const f = find(id); if (f) f.item.src = v.file; });
      status(`added ${v.file}`, 'ok');
    } catch (err) { status(`not uploaded: ${err.message}`, 'err'); }
  }
  $('lyt-name').addEventListener('change', () => { st.layout.name = $('lyt-name').value.trim().toLowerCase(); st.dirty = true; });
  $('lyt-title').addEventListener('change', () => change(() => { st.layout.title = $('lyt-title').value.trim(); }));
  window.addEventListener('beforeunload', (e) => { if (st.dirty && st.undo.length) { e.preventDefault(); e.returnValue = ''; } });

  // --- preview: full screen; a tap or Escape closes it ---------------------------------------
  function preview() {
    const p = $('lyt-preview');
    p.hidden = false;
    const host = $('lyt-preview-host');
    const s = L.render(st.layout, host, { contain: true });
    s.style.left = `${(host.clientWidth - parseFloat(s.style.width) * Number(s.dataset.scale)) / 2}px`;
    s.style.top = `${(host.clientHeight - parseFloat(s.style.height) * Number(s.dataset.scale)) / 2}px`;
    p.requestFullscreen?.().catch(() => {});
  }
  function closePreview() { $('lyt-preview').hidden = true; if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
  $('lyt-preview').addEventListener('click', closePreview);
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && !$('lyt-preview').hidden) $('lyt-preview').hidden = true; });

  new ResizeObserver(() => { if (stage) { L.fit(stage, canvas); drawOverlay(); } }).observe(canvas.parentElement);
  drawPalette();
  draw();
  refresh().then(() => { const q = new URLSearchParams(location.search).get('layout'); if (q) load(q); });
})();
