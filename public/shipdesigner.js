// The ship designer (admin): a vessel's graph of systems (docs/ship-graph.md) as litegraph nodes.
//   A system is a node with one input and one output; the input takes any number of wires. A wire
//   is a bundle: everything a system draws from another (upstream[id]), a resource each with its
//   settings (pull, push, connect, rate, pri, min...) in the wire's panel. The node's panel has
//   the rest of the system (its type, place, draws, effects...). A system's parts (child systems)
//   sit in a box with it; the panel's Parent moves one.
//   The node menu (right-click, or double-click for search): a node per feature (effect), and one
//   with none; litegraph's own nodes are taken out.
// Saving checks it first (tools/ship-graph.js check, as the relay loads it) and keeps the old
// file; positions are kept apart, in config/layouts/ships/<id>.json.
(function () {
  const { LGraph, LGraphCanvas, LGraphNode, LGraphGroup, LGraphBadge, LiteGraph } = window.litegraph.js;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

  const RES_COLOUR = { power: '#f2c14e', eps: '#4ea8de', odn: '#b48ead', deu: '#2ec4b6', am: '#ef476f', heat: '#ff7f11' };
  const STATE_COLOUR = { auto: '#3fb950', true: '#58a6ff', warn: '#d29922', false: '#6e7681' };
  const ROLE_COLOUR = { bus: '#3a3f1c', source: '#1c3a2a', store: '#1c2f3a', conduit: '#2f2f2f', load: '#3a2a1c', group: '#2a1c3a', sink: '#3a1c1c' };
  const HANDLED = ['type', 'name', 'key', 'place', 'via', 'parentName', 'count', 'consumes', 'produces', 'capacity', 'creative', 'effects', 'upstream', 'systems'];
  // The features: these (docs/ship-graph.md), and any other effect a design file uses.
  let EFFECTS = ['ftl', 'jump', 'impulse', 'maneuver', 'shields', 'phasers', 'torpedoes', 'tractor', 'transport', 'sensors', 'comms', 'life-support', 'gravity', 'dampers', 'sif', 'deflector', 'holo', 'force-fields', 'brig', 'shuttle-bay', 'docking', 'computing', 'replication', 'seat', 'cloak'];

  const st = {
    lib: null, types: {}, resources: [], designs: [],
    id: null, isNew: false, root: null, order: [], // the design's own fields (all but systems); its systems' ids in file order
    dirty: false, loading: false, sel: null, wireMode: 'state', hideHeat: false,
    // The view: one resource's graph (or all of them), optionally rooted on one system (its
    // neighbours only). The whole design is st.model; the canvas shows the view's part of it.
    model: null, view: 'power', focus: null, removed: new Set(), removedParent: {}, positions: {}, layout: null,
  };
  window.__shipdesigner = st;
  st.toGraph = () => toGraph();

  // --- the canvas ----------------------------------------------------------------------------
  LiteGraph.alt_drag_do_clone_nodes = true;
  const graph = new LGraph();
  const canvas = new LGraphCanvas($('graph-canvas'), graph);
  canvas.render_canvas_border = false;
  canvas.show_info = false;
  canvas.links_render_mode = LiteGraph.SPLINE_LINK;
  st.graph = graph; st.canvas = canvas;
  for (const [r, c] of Object.entries(RES_COLOUR)) LGraphCanvas.link_type_colors[r] = c;
  const resize = () => { const w = $('canvas-wrap'); canvas.resize(w.clientWidth, w.clientHeight); };
  new ResizeObserver(resize).observe($('canvas-wrap'));

  // Heat wires hidden: not drawn at all.
  const renderLink = canvas.renderLink.bind(canvas);
  canvas.renderLink = (ctx, a, b, link, ...rest) => (st.hideHeat && link && heatOnly(link) ? undefined : renderLink(ctx, a, b, link, ...rest));
  // A click on a wire's centre selects it (instead of litegraph's menu).
  canvas.showLinkMenu = (segment) => {
    const link = graph.links.get ? graph.links.get(segment.id) : graph.links[segment.id];
    if (link) select({ kind: 'link', link });
    return false;
  };
  canvas.onNodeSelected = (node) => select({ kind: 'node', node });
  canvas.onSelectionChange = () => {
    const nodes = [...canvas.selectedItems].filter((x) => x instanceof LGraphNode);
    if (nodes.length === 1) select({ kind: 'node', node: nodes[0] });
    else if (!nodes.length && st.sel?.kind === 'node') select(null);
  };

  // --- node kinds: one per feature (effect), and one with none ----------------------------------
  // Every node has one input and one output. The input takes any number of wires: litegraph gives
  // an input one link, so each wire has its own input slot, all drawn at the same spot, with a
  // free one on top to drop the next wire on. A wire is a bundle: everything one system draws from
  // another (upstream[id] in the file: a resource each, with its own settings, in its panel).
  const PLAIN = 'system/no feature';
  const featureOf = (sys) => Object.keys(sys.effects || {}).find((k) => EFFECTS.includes(k)) || null;
  const nodeType = (feature) => (feature ? `feature/${feature}` : PLAIN);
  function registerTypes() {
    // (litegraph's own nodes gone: only these are in the menu.)
    for (const k of Object.keys(LiteGraph.registered_node_types)) LiteGraph.unregisterNodeType(k);
    for (const f of [...EFFECTS, null]) {
      class SystemNode extends LGraphNode {
        constructor(title) { super(title || f || 'system'); this.feature = f; this.serialize_widgets = false; }
        onConnectInput(slot, type, output, origin, originSlot) { return canDraw(this, origin, slot, originSlot); }
        onConnectionsChange(io, index, connected, link) { connectionChanged(this, io, index, connected, link); }
        onRemoved() { nodeRemoved(this); }
      }
      SystemNode.title = f || 'no feature';
      SystemNode.desc = f ? `A system with the ${f} effect` : 'A system with no effect';
      LiteGraph.registerNodeType(nodeType(f), SystemNode);
    }
  }

  // --- systems as nodes --------------------------------------------------------------------------
  // node.sys: the system's fields (without upstream and systems); node.sysId, node.parentId;
  // node.keyOrder: the file's key order, kept on saving. A wire's bundle: link.bundle,
  // { resource: { pull, push, connect, rate, pushRate, pri, min, why } }.
  const nodeById = (id) => graph._nodes.find((n) => n.sysId === id);
  const linkOf = (id) => (graph.links.get ? graph.links.get(id) : graph.links[id]);
  const allLinks = () => (graph.links.values ? [...graph.links.values()] : Object.values(graph.links)).filter(Boolean);
  const label = (n) => `${n.sys.name || n.sysId}`;
  const linksIn = (n) => (n.inputs || []).filter((i) => i.link != null).map((i) => linkOf(i.link)).filter(Boolean);
  const linksOut = (n) => allLinks().filter((l) => l.origin_id === n.id);
  const SLOT = 'system';
  const IN_POS = [10, 14];

  function styleNode(n) {
    const role = st.types[n.sys.type]?.role;
    n.title = label(n);
    n.bgcolor = ROLE_COLOUR[role] || '#333';
    n.color = '#222';
    const fx = Object.keys(n.sys.effects || {});
    n.badges = [new LGraphBadge({ text: n.sysId, fgColor: '#ccc', bgColor: '#0006' })];
    if (fx.length) n.badges.push(new LGraphBadge({ text: fx.join(' · '), fgColor: '#fff', bgColor: '#1f6feb99' }));
    if (!st.types[n.sys.type]) n.badges.push(new LGraphBadge({ text: `no type ${n.sys.type}`, fgColor: '#fff', bgColor: '#a33' }));
  }
  function addSlots(n) {
    if (!n.outputs?.length) n.addOutput('out', SLOT);
    addSpare(n);
  }
  // The free input, on top: dropping a wire on the input lands there.
  function addSpare(n) {
    if (n.inputs?.some((i) => i.spare)) return;
    const s = n.addInput('in', SLOT, { pos: [...IN_POS] }); s.spare = true;
  }
  function labelInputs(n) {
    const count = linksIn(n).length;
    for (const inp of n.inputs || []) { inp.pos = [...IN_POS]; inp.label = inp.spare ? (count ? `in (${count})` : 'in') : ' '; }
    if (n.outputs?.[0]) n.outputs[0].label = `out${linksOut(n).length ? ` (${linksOut(n).length})` : ''}`;
  }
  const labelAll = () => { for (const n of graph._nodes) if (n.sys) labelInputs(n); };
  function fitNode(n) { n.setSize([200, LiteGraph.NODE_SLOT_HEIGHT * 1.4]); }

  function makeNode(id, sys, parentId) {
    const n = LiteGraph.createNode(nodeType(featureOf(sys)));
    n.sysId = id; n.parentId = parentId || null;
    n.keyOrder = Object.keys(sys);
    n.sys = clone(sys); delete n.sys.upstream; delete n.sys.systems;
    styleNode(n);
    return n;
  }
  // What a system gives and takes: its type's resources and what it produces, holds or consumes.
  const gives = (n) => new Set([...(st.types[n.sys.type]?.resources || []), ...Object.keys(n.sys.produces || {}), ...Object.keys(n.sys.capacity || {}), ...Object.keys(n.sys.creative || {})]);
  const takes = (n) => new Set([...(st.types[n.sys.type]?.resources || []), ...Object.keys(n.sys.consumes || {})]);
  // A new wire's bundle: what the two have in common (power, if nothing).
  function newBundle(origin, node) {
    if (st.view !== 'all') return { [st.view]: { pull: 'auto', push: false } };
    const g = gives(origin), t = takes(node), common = [...g].filter((r) => t.has(r) && r !== 'heat');
    return Object.fromEntries((common.length ? common.slice(0, 1) : [[...g][0] || 'power']).map((r) => [r, { pull: 'auto', push: false }]));
  }
  const resOf = (l) => Object.keys(l.bundle || {});

  // --- loading a design ---------------------------------------------------------------------------
  function walk(systems, parent, out) {
    for (const [id, s] of Object.entries(systems || {})) { out.push({ id, s, parent }); walk(s.systems, id, out); }
    return out;
  }
  function load(id, file, layout, isNew = false) {
    st.id = id; st.isNew = isNew;
    st.root = clone(file); delete st.root.systems;
    st.model = clone(file);
    st.layout = layout; st.positions = {}; st.focus = null;
    build();
    setDirty(false);
    problems(null);
  }
  const viewKey = () => `${st.view}|${st.focus || ''}`;
  // Which links the view draws between shown systems: all of them, or rooted, only the root's.
  const wired = (a, b) => !st.focus || a === st.focus || b === st.focus;
  const inView = (r) => st.view === 'all' || r === st.view;
  // Which systems the view shows: those on its resource's graph (linked by it, or of a type, or
  // drawing, making or holding it); rooted on a system, just it and its neighbours.
  function shownIds(list) {
    const ids = new Set();
    for (const { id, s: sys } of list) {
      for (const [u, rs] of Object.entries(sys.upstream || {})) if (Object.keys(rs).some(inView)) { ids.add(id); ids.add(u); }
      if (st.view === 'all' || (st.types[sys.type]?.resources || []).includes(st.view) || ['consumes', 'produces', 'capacity', 'creative'].some((f) => sys[f] && st.view in sys[f])) ids.add(id);
    }
    if (st.focus && ids.has(st.focus)) {
      const near = new Set([st.focus]);
      for (const { id, s: sys } of list) for (const [u, rs] of Object.entries(sys.upstream || {})) if (Object.keys(rs).some(inView)) { if (id === st.focus) near.add(u); if (u === st.focus) near.add(id); }
      return near;
    }
    return ids;
  }
  function build() {
    st.loading = true;
    graph.clear();
    st.removed = new Set(); st.removedParent = {};
    const list = walk(st.model.systems, null, []);
    const ids = shownIds(list);
    const pending = [];
    for (const { id: sid, s: sys, parent } of list) {
      if (!ids.has(sid)) continue;
      const n = makeNode(sid, sys, parent);
      n.addOutput('out', SLOT);
      // (An input per wire, in the file's order, then the free one. A wire: the view's resources.)
      for (const [u, rs] of Object.entries(sys.upstream || {})) {
        const bundle = Object.fromEntries(Object.entries(rs).filter(([r]) => inView(r)));
        if (!ids.has(u) || !Object.keys(bundle).length || !wired(u, sid)) continue;
        n.addInput('in', SLOT, { pos: [...IN_POS] }); pending.push({ n, slot: n.inputs.length - 1, u, bundle });
      }
      addSpare(n);
      fitNode(n);
      graph.add(n);
    }
    for (const p of pending) {
      const up = nodeById(p.u);
      if (!up) continue; // (an upstream that isn't there: the checker names it; dropped here)
      const link = up.connect(0, p.n, p.slot);
      if (link) { link.bundle = clone(p.bundle); colourLink(link); }
    }
    labelAll();
    const saved = st.positions[viewKey()] || (st.view === 'all' && !st.focus ? st.layout : null);
    if (saved?.nodes && graph._nodes.every((n) => saved.nodes[n.sysId])) {
      for (const n of graph._nodes) n.pos = [...saved.nodes[n.sysId]];
      regroup(saved.groups);
      if (saved.view) { canvas.ds.offset = [...saved.view.offset]; canvas.ds.scale = saved.view.scale; } else fit();
    } else { arrange(); fit(); }
    st.loading = false;
    viewControls();
    select(null);
    canvas.setDirty(true, true);
  }
  // Another view: what's on the canvas goes back into the design first.
  function setView(view, focus = null) {
    st.positions[viewKey()] = layoutOf(true);
    st.model = toGraph();
    st.view = view; st.focus = focus;
    try { localStorage.setItem('shipdesigner.view', view); } catch { /* (no storage) */ }
    build();
  }
  function viewControls() {
    $('view').value = st.view;
    $('unfocus').hidden = !st.focus;
    $('unfocus').textContent = st.focus ? `Rooted on ${st.focus}: show all` : '';
  }

  // --- wires ----------------------------------------------------------------------------------------
  const PERM_RANK = { false: 0, warn: 1, true: 2, auto: 3 };
  function stateOf(perm) {
    const vals = ['pull', 'push', 'connect'].map((k) => perm?.[k]).filter((v) => v !== undefined);
    if (!vals.length) return 'false';
    return String(vals.sort((a, b) => PERM_RANK[b] - PERM_RANK[a])[0]);
  }
  // A bundle's state: its strongest resource's. Its colour by resource: the one it carries, or white for several.
  function colourLink(link) {
    const rs = resOf(link), states = Object.values(link.bundle || {}).map(stateOf);
    link.color = st.wireMode === 'resource' ? (rs.length === 1 ? RES_COLOUR[rs[0]] || '#999' : '#e6e6e6') : STATE_COLOUR[states.sort((a, b) => PERM_RANK[b] - PERM_RANK[a])[0] || 'false'];
  }
  const heatOnly = (l) => { const rs = resOf(l); return rs.length > 0 && rs.every((r) => r === 'heat'); };
  const recolour = () => { for (const l of allLinks()) colourLink(l); canvas.setDirty(true, true); legend(); };
  function legend() {
    const items = st.wireMode === 'resource' ? [...Object.entries(RES_COLOUR), ['several', '#e6e6e6']] : Object.entries(STATE_COLOUR).reverse().map(([k, c]) => [k === 'true' ? 'true (crew turns on)' : k === 'auto' ? 'auto (on at load)' : k === 'warn' ? 'warn' : 'false', c]);
    $('legend').innerHTML = items.map(([k, c]) => `<span><i style="background:${c}"></i>${esc(k)}</span>`).join('');
  }

  // May `node` take a wire from `origin`? Not from itself, and one wire (one bundle) per pair.
  // A wire dropped on a taken slot (they share a spot) goes to the free one instead.
  function canDraw(node, origin, slot, originSlot) {
    if (st.loading) return true;
    if (!origin || origin === node || !wired(origin.sysId, node.sysId) || linksIn(node).some((l) => l.origin_id === origin.id && l.target_slot !== slot)) return false;
    const inp = node.inputs[slot];
    if (inp && !inp.spare) {
      setTimeout(() => { const free = node.inputs.findIndex((i) => i.spare); if (free >= 0) origin.connect(originSlot ?? 0, node, free); });
      return false;
    }
    return true;
  }
  function connectionChanged(node, io, index, connected, link) {
    if (st.loading) return;
    if (io === LiteGraph.INPUT) {
      const slot = node.inputs[index];
      if (!slot) return;
      if (connected) {
        if (link && !link.bundle) { const o = graph.getNodeById(link.origin_id); link.bundle = newBundle(o, node); }
        if (link) colourLink(link);
        if (slot.spare) { slot.spare = false; addSpare(node); }
      } else if (!slot.spare) {
        // (A wire gone: its slot goes too, unless it's being replaced right now.)
        setTimeout(() => {
          const i = node.inputs.indexOf(slot);
          if (i >= 0 && slot.link == null) { node.removeInput(i); addSpare(node); labelInputs(node); canvas.setDirty(true, true); }
        });
      }
    }
    setTimeout(() => { labelAll(); canvas.setDirty(true, true); });
    if (st.sel?.kind === 'link' && !linkOf(st.sel.link.id)) select(null);
    else if (st.sel?.kind === 'node') select(st.sel);
    setDirty(true);
  }
  function nodeRemoved(node) {
    if (st.loading) return;
    st.removed.add(node.sysId); st.removedParent[node.sysId] = node.parentId;
    for (const n of graph._nodes) if (n.parentId === node.sysId) n.parentId = node.parentId;
    if (st.sel?.node === node) select(null);
    setDirty(true);
    setTimeout(() => regroup());
  }

  // A node added from the menu: a new system, with that feature.
  graph.onNodeAdded = (n) => {
    if (st.loading || n.sys) return;
    const f = n.feature, base = f || 'system';
    let i = 1; while (nodeById(`${base}-${i}`)) i++;
    n.sysId = `${base}-${i}`; n.parentId = null; n.keyOrder = [];
    n.sys = { type: f === 'seat' ? 'console' : 'system', name: `New ${(f || 'system').replace(/-/g, ' ')}`, ...(f ? { effects: { [f]: {} } } : {}) };
    addSlots(n); styleNode(n); fitNode(n); labelInputs(n);
    setDirty(true);
    setTimeout(() => select({ kind: 'node', node: n }));
  };

  // --- the graph written back --------------------------------------------------------------------
  function ordered(obj, order) {
    const keys = [...order.filter((k) => k in obj), ...Object.keys(obj).filter((k) => !order.includes(k))];
    return Object.fromEntries(keys.map((k) => [k, obj[k]]));
  }
  // A shown system: its own fields from the node; its links from the design, with those the view
  // shows (the view's resources, from systems on the canvas) taken from the wires instead.
  function systemOf(n, base, shown) {
    const s = clone(n.sys), orig = base?.upstream || {}, wires = {};
    for (const l of linksIn(n)) { const o = graph.getNodeById(l.origin_id); if (o) wires[o.sysId] = l.bundle || {}; }
    const up = {};
    for (const src of [...Object.keys(orig), ...Object.keys(wires).filter((k) => !(k in orig))]) {
      if (st.removed.has(src)) continue;
      const o = orig[src] || {}, w = wires[src];
      let obj = {};
      if (!shown.has(src) || !wired(src, n.sysId)) obj = clone(o);
      else {
        for (const k of Object.keys(o)) if (!inView(k)) obj[k] = clone(o[k]); else if (w && k in w) obj[k] = clone(w[k]);
        for (const k of Object.keys(w || {})) if (!(k in obj)) obj[k] = clone(w[k]);
      }
      if (Object.keys(obj).length) up[src] = obj;
    }
    s.upstream = up;
    return s;
  }
  // The whole design: the shown systems from the canvas, the rest as they were (less links to a
  // system deleted here), nested by parent, in the file's order (new ones last).
  function toGraph() {
    const nodes = new Map([...graph._nodes].filter((n) => n.sys).map((n) => [n.sysId, n]));
    const shown = new Set(nodes.keys());
    const list = walk(st.model.systems, null, []).filter((x) => !st.removed.has(x.id));
    const ids = [...list.map((x) => x.id), ...[...nodes.values()].filter((n) => !list.some((x) => x.id === n.sysId)).sort((a, b) => a.id - b.id).map((n) => n.sysId)];
    const base = new Map(list.map((x) => [x.id, x]));
    const built = new Map(), parentOf = new Map(), orderOf = new Map();
    for (const id of ids) {
      const n = nodes.get(id), b = base.get(id);
      if (n) { built.set(id, systemOf(n, b?.s, shown)); parentOf.set(id, n.parentId); orderOf.set(id, n.keyOrder); continue; }
      const s = clone(b.s); delete s.systems;
      if (s.upstream) for (const k of Object.keys(s.upstream)) if (st.removed.has(k)) delete s.upstream[k];
      let p = b.parent, guard = 0; while (p && st.removed.has(p) && guard++ < 50) p = st.removedParent[p];
      built.set(id, s); parentOf.set(id, p); orderOf.set(id, Object.keys(b.s));
    }
    const systems = {};
    for (const id of ids) {
      const s = built.get(id), p = parentOf.get(id), parent = p && p !== id && built.get(p);
      (parent ? (parent.systems ||= {}) : systems)[id] = s;
    }
    for (const id of ids) {
      const s = built.get(id), ko = orderOf.get(id), fresh = ordered(s, ko?.length ? ko : ['type', 'name', 'key', 'place', 'via', 'capacity', 'produces', 'consumes', 'effects', 'creative', 'upstream', 'systems']);
      for (const k of Object.keys(s)) delete s[k];
      Object.assign(s, fresh);
    }
    return { ...st.root, systems };
  }
  // Positions to save: the all-resources view's (the canvas's, or as it was left).
  function layoutOf(here = false) {
    if (!here && viewKey() !== 'all|') return st.positions['all|'] || null;
    const nodes = {}, groups = {};
    for (const n of graph._nodes) if (n.sysId) nodes[n.sysId] = Array.from(n.pos, Math.round);
    for (const g of graph._groups) if (g.sysId) groups[g.sysId] = [...g.pos, ...g.size].map(Math.round);
    return { nodes, groups, view: { offset: [...canvas.ds.offset], scale: canvas.ds.scale } };
  }

  // --- arranging --------------------------------------------------------------------------------
  // Columns by what feeds what (power, EPS and fuel; heat left out): a system a hop right of what
  // it draws from. Crosslinks and batteries make loops: the first edge back into one is dropped.
  // A system's parts sit under it, in its column.
  function arrange() {
    if (st.focus && nodeById(st.focus)) return arrangeRooted();
    const nodes = graph._nodes.filter((n) => n.sys);
    const top = nodes.filter((n) => !n.parentId || !nodeById(n.parentId));
    const topOf = (n) => { let x = n, guard = 0; while (x.parentId && nodeById(x.parentId) && guard++ < 20) x = nodeById(x.parentId); return x; };
    const edges = new Map(top.map((n) => [n, new Set()]));
    const noFlow = new Set(top);
    for (const l of allLinks()) {
      const a = topOf(graph.getNodeById(l.origin_id)), b = topOf(graph.getNodeById(l.target_id));
      if (!a || !b || a === b) continue;
      if (heatOnly(l)) continue;
      noFlow.delete(a); noFlow.delete(b);
      edges.get(a).add(b);
    }
    // (Drop the edges that close loops: depth-first, an edge to a node still open.)
    const state = new Map(), dag = new Map(top.map((n) => [n, []]));
    const visit = (n) => {
      state.set(n, 1);
      for (const m of edges.get(n)) {
        if (state.get(m) === 1) continue;
        dag.get(n).push(m);
        if (!state.has(m)) visit(m);
      }
      state.set(n, 2);
    };
    for (const n of top) if (!state.has(n)) visit(n);
    const depth = new Map(top.map((n) => [n, 0]));
    const order = []; const seen = new Set();
    const topo = (n) => { if (seen.has(n)) return; seen.add(n); for (const m of dag.get(n)) topo(m); order.unshift(n); };
    for (const n of top) topo(n);
    for (const n of order) for (const m of dag.get(n)) depth.set(m, Math.max(depth.get(m), depth.get(n) + 1));
    const maxD = Math.max(0, ...[...depth.entries()].filter(([n]) => !noFlow.has(n)).map(([, d]) => d));
    for (const n of noFlow) if (linksIn(n).some(heatOnly)) depth.set(n, maxD + 1);
    const cols = new Map();
    for (const n of top) { const d = depth.get(n); if (!cols.has(d)) cols.set(d, []); cols.get(d).push(n); }
    const TH = LiteGraph.NODE_TITLE_HEIGHT, GAP = 30, COLW = 280, GROUP_PAD = 12;
    const kids = (n) => nodes.filter((m) => m.parentId === n.sysId);
    // (A tall column wraps into more, side by side, so the whole is roughly as wide as it's high.)
    const heightOf = (fam) => fam.reduce((h, m) => h + m.size[1] + TH + 14, 0) + GAP + (fam.length > 1 ? TH + 2 * GROUP_PAD : 0);
    const total = top.reduce((h, n) => h + heightOf([n, ...descendants(n, kids)]), 0);
    const maxH = Math.max(1200, Math.sqrt(total * COLW * 1.6));
    let x = 0;
    for (const d of [...cols.keys()].sort((a, b) => a - b)) {
      let y = 0, w = 0;
      for (const n of cols.get(d)) {
        const family = [n, ...descendants(n, kids)], h = heightOf(family);
        if (y > 0 && y + h > maxH) { x += COLW; y = 0; }
        if (family.length > 1) y += TH + GROUP_PAD;
        for (const m of family) { m.pos = [x + (m === n ? 0 : 16), y + TH]; y += m.size[1] + TH + 14; w = Math.max(w, m.size[0]); }
        y += GAP + (family.length > 1 ? GROUP_PAD : 0);
      }
      x += Math.max(COLW, w + 100);
    }
    regroup();
  }
  // Rooted on a system: it in the middle, what it draws from on the left, what draws from it on
  // the right (both ways: on the left).
  function arrangeRooted() {
    const root = nodeById(st.focus), left = [], right = [];
    const ups = new Set(linksIn(root).map((l) => l.origin_id)), downs = new Set(linksOut(root).map((l) => l.target_id));
    for (const n of graph._nodes) if (n !== root && n.sys) (ups.has(n.id) || !downs.has(n.id) ? left : right).push(n);
    const TH = LiteGraph.NODE_TITLE_HEIGHT, ROW = LiteGraph.NODE_SLOT_HEIGHT * 1.4 + TH + 26, COLW = 300;
    const column = (list, x) => { const per = Math.max(1, Math.ceil(list.length / Math.ceil(list.length / 14))); list.forEach((n, i) => { n.pos = [x + Math.floor(i / per) * COLW * Math.sign(x), TH + (i % per) * ROW]; }); return Math.min(list.length, per); };
    const rows = Math.max(column(left, -COLW), column(right, COLW), 1);
    root.pos = [0, TH + ((rows - 1) * ROW) / 2];
    for (const g of [...graph._groups]) graph.remove(g);
    canvas.setDirty(true, true);
  }
  function descendants(n, kids) { const out = []; for (const k of kids(n)) out.push(k, ...descendants(k, kids)); return out; }

  // A box round each system that has parts: it and them. (Saved positions keep their own boxes.)
  function regroup(saved) {
    for (const g of [...graph._groups]) graph.remove(g);
    if (st.focus) return;
    const nodes = graph._nodes.filter((n) => n.sys);
    for (const p of nodes) {
      const kids = nodes.filter((n) => n.parentId === p.sysId);
      if (!kids.length) continue;
      const g = new LGraphGroup(`${label(p)}: its parts`);
      g.sysId = p.sysId;
      g.color = '#3b4252';
      graph.add(g);
      const box = saved?.[p.sysId];
      if (box) { g.pos = [box[0], box[1]]; g.size = [box[2], box[3]]; } else boxRound(g, [p, ...descendants(p, (n) => nodes.filter((m) => m.parentId === n.sysId))]);
    }
    canvas.setDirty(true, true);
  }
  // (Worked out here: litegraph's own bounds are only brought up to date as it draws.)
  function boxRound(g, list, pad = 10) {
    const TH = LiteGraph.NODE_TITLE_HEIGHT;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of list) { x0 = Math.min(x0, n.pos[0]); y0 = Math.min(y0, n.pos[1] - TH - 16); x1 = Math.max(x1, n.pos[0] + n.size[0]); y1 = Math.max(y1, n.pos[1] + n.size[1]); }
    g.pos = [x0 - pad, y0 - pad - g.titleHeight];
    g.size = [x1 - x0 + 2 * pad, y1 - y0 + 2 * pad + g.titleHeight];
  }
  function fit() {
    const nodes = graph._nodes;
    if (!nodes.length) { canvas.ds.offset = [40, 40]; canvas.ds.scale = 1; return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) { x0 = Math.min(x0, n.pos[0]); y0 = Math.min(y0, n.pos[1] - LiteGraph.NODE_TITLE_HEIGHT); x1 = Math.max(x1, n.pos[0] + n.size[0]); y1 = Math.max(y1, n.pos[1] + n.size[1]); }
    const w = canvas.canvas.width / (window.devicePixelRatio || 1), h = canvas.canvas.height / (window.devicePixelRatio || 1);
    const scale = Math.max(0.1, Math.min(1.2, Math.min((w - 40) / (x1 - x0), (h - 40) / (y1 - y0))));
    canvas.ds.scale = scale;
    canvas.ds.offset = [20 / scale - x0, 20 / scale - y0];
    canvas.setDirty(true, true);
  }
  function centreOn(n) {
    const w = canvas.canvas.width / (window.devicePixelRatio || 1), h = canvas.canvas.height / (window.devicePixelRatio || 1);
    canvas.ds.scale = Math.max(canvas.ds.scale, 0.8);
    canvas.ds.offset = [w / 2 / canvas.ds.scale - n.pos[0] - n.size[0] / 2, h / 2 / canvas.ds.scale - n.pos[1]];
    canvas.selectNode(n);
    canvas.setDirty(true, true);
  }

  // --- the panel ---------------------------------------------------------------------------------
  function select(sel) {
    st.sel = sel;
    const p = $('panel');
    if (sel?.kind === 'node' && sel.node.sys) p.innerHTML = nodePanel(sel.node);
    else if (sel?.kind === 'link') p.innerHTML = linkPanel(sel.link);
    else p.innerHTML = vesselPanel();
    bindPanel();
  }
  const opt = (v, cur, text = v) => `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(text)}</option>`;
  const row = (labelText, html, title = '') => `<div class="row"${title ? ` title="${esc(title)}"` : ''}><label>${esc(labelText)}</label>${html}</div>`;
  const placesAndSystems = () => [...(st.root.places || []).map((p) => [p.id, `${p.name} (place)`]), ...graph._nodes.filter((n) => n.sys).map((n) => [n.sysId, label(n)])];

  function resTable(field, vals) {
    const rows = Object.entries(vals || {}).map(([r, v]) => `<tr><td><select data-rt="${field}" data-k="${esc(r)}" data-part="res">${st.resources.map((x) => opt(x, r)).join('')}</select></td><td><input type="number" step="any" min="0" data-rt="${field}" data-k="${esc(r)}" data-part="val" value="${esc(v)}"></td><td><button data-rt-del="${field}" data-k="${esc(r)}" title="Remove">×</button></td></tr>`).join('');
    return `<h3>${field}</h3><table class="res">${rows}</table><button data-rt-add="${field}">+ ${field}</button>`;
  }
  function nodePanel(n) {
    const s = n.sys, def = st.types[s.type];
    const others = Object.fromEntries(Object.entries(s).filter(([k]) => !HANDLED.includes(k)));
    const nodes = graph._nodes.filter((m) => m.sys && m !== n);
    const wire = (l, other) => `<li><a href="#" data-goto-link="${l.id}">${esc(other ? label(other) : '?')}</a>: ${esc(resOf(l).join(', ') || '(nothing)')}</li>`;
    const ins = linksIn(n), outs = linksOut(n);
    return `<h2>${esc(label(n))}</h2>
      <div class="about">${esc(def ? `${s.type} (${def.role}): ${def.about || ''}` : `no system type "${s.type}"`)}</div>
      ${row('Id', `<input data-f="id" value="${esc(n.sysId)}">`, 'Lower-case letters, digits and -; other systems refer to it by this')}
      ${row('Name', `<input data-f="name" value="${esc(s.name)}">`)}
      ${row('Type', `<select data-f="type">${Object.keys(st.types).map((t) => opt(t, s.type)).join('')}${def ? '' : opt(s.type, s.type)}</select>`)}
      ${row('Parent', `<select data-f="parent"><option value="">(none: top level)</option>${nodes.map((m) => opt(m.sysId, n.parentId, label(m))).join('')}</select>`, 'The system it is a part of')}
      ${row('Place', `<select data-f="place"><option value="">(none)</option>${placesAndSystems().filter(([id]) => id !== n.sysId).map(([id, t]) => opt(id, s.place, t)).join('')}</select>`)}
      ${row('Via', `<select data-f="via"><option value="">(none)</option>${nodes.map((m) => opt(m.sysId, s.via, label(m))).join('')}</select>`, 'A conduit below its place its power also runs through')}
      ${row('Key', `<input data-f="key" value="${esc(s.key ?? '')}">`, "The relay's own name for it (step 1)")}
      ${row('Parent name', `<input data-f="parentName" value="${esc(s.parentName ?? '')}">`, "A parent this class doesn't have")}
      ${row('Count', `<input data-f="count" value="${esc(s.count === null ? 'null' : s.count ?? '')}" placeholder="(blank: not set; null: as many as needed)">`)}
      ${resTable('consumes', s.consumes)}${resTable('produces', s.produces)}${resTable('capacity', s.capacity)}
      <h3>creative</h3><p class="hint">Never runs short of:</p>
      <div class="chips">${st.resources.map((r) => `<label class="chip"><input type="checkbox" data-creative="${r}"${s.creative?.[r] ? ' checked' : ''}>${r}</label>`).join('')}</div>
      <h3>effects</h3>
      <textarea data-json="effects" placeholder='{ "ftl": { "maxWarp": 5 } }'>${esc(s.effects ? JSON.stringify(s.effects, null, 1) : '')}</textarea>
      <p class="hint">Names: ${EFFECTS.join(', ')}. A console's seat: { "seat": { "station": "Helm" } }.</p>
      <h3>draws from (${ins.length})</h3><ul class="wires">${ins.map((l) => wire(l, graph.getNodeById(l.origin_id))).join('')}</ul>
      <h3>feeds (${outs.length})</h3><ul class="wires">${outs.map((l) => wire(l, graph.getNodeById(l.target_id))).join('')}</ul>
      ${Object.keys(others).length ? `<h3>other fields</h3><textarea data-json="others">${esc(JSON.stringify(others, null, 1))}</textarea>` : ''}
      <div class="actions"><button id="centre">Centre</button><button id="root-here" title="Show just it and what it draws from and feeds, in this view">Root here</button><button id="del-node" class="danger">Delete system</button></div>`;
  }
  // A wire: its bundle, a block of settings per resource.
  function linkPanel(l) {
    const a = graph.getNodeById(l.origin_id), b = graph.getNodeById(l.target_id), bundle = l.bundle || {};
    const block = (r, p) => {
      const permSel = (k) => `<select data-bp="${k}" data-r="${esc(r)}"><option value="">(not set)</option>${['false', 'warn', 'true', 'auto'].map((v) => opt(v, p[k] === undefined ? '' : String(p[k]))).join('')}</select>`;
      const num = (k, t) => row(k, `<input type="number" step="any" data-bn="${k}" data-r="${esc(r)}" value="${esc(p[k] ?? '')}">`, t);
      return `<fieldset class="res-block" style="border-color:${RES_COLOUR[r] || '#555'}"><legend><select data-bres data-r="${esc(r)}">${st.resources.map((x) => opt(x, r)).join('')}</select> <button data-bdel="${esc(r)}" title="Take it out of the bundle">×</button></legend>
        ${row('pull', permSel('pull'), 'May the downstream system draw from the upstream one?')}
        ${row('push', permSel('push'), 'May it send back the other way?')}
        ${row('connect', permSel('connect'), 'For a resource connected rather than moved')}
        ${num('rate', 'Its limit on a pull')}${num('pushRate', 'Its limit the other way')}${num('pri', 'Who is served first when short (lower first)')}
        ${row('min', `<input data-bf="min" data-r="${esc(r)}" value="${esc(p.min ?? '')}" placeholder='a number, or "all"'>`, 'The least it must get to work at all')}
        ${row('why', `<input data-bf="why" data-r="${esc(r)}" value="${esc(p.why ?? '')}">`, "Why it's false or warn, shown to the crew")}
      </fieldset>`;
    };
    const left = st.resources.filter((r) => !(r in bundle));
    return `<h2>${esc(a ? label(a) : '?')} → ${esc(b ? label(b) : '?')}</h2>
      <div class="about">A bundle: what <b>${esc(b ? label(b) : '?')}</b> draws from <b>${esc(a ? label(a) : '?')}</b>, a resource each. Stored on ${esc(b?.sysId)}, under upstream.${esc(a?.sysId)}.</div>
      <p class="hint">false: never. warn: allowed, not advised (a confirming tap). true: allowed, off at load. auto: allowed and on at load.</p>
      ${Object.entries(bundle).map(([r, p]) => block(r, p)).join('') || '<p class="hint">It carries nothing yet.</p>'}
      ${left.length && st.view === 'all' ? `<p><select id="bundle-add">${left.map((r) => opt(r, '')).join('')}</select> <button id="bundle-add-go">+ resource</button></p>` : ''}
      <div class="actions"><button id="del-link" class="danger">Delete wire</button></div>`;
  }
  function vesselPanel() {
    if (!st.root) return '<p class="hint">Pick a design.</p>';
    const r = st.root;
    const meta = Object.fromEntries(Object.entries(r).filter(([k]) => !['schema', 'type', 'class', 'name', 'places'].includes(k)));
    const nodes = graph._nodes.filter((n) => n.sys);
    return `<h2>${esc(r.name || st.id)}</h2>
      <div class="about">${nodes.length} systems, ${allLinks().length} links. Select a node or click a wire's centre to edit it. Right-click the canvas (or double-click) to add a system; drag from a node's out to another's in to wire them (one wire per pair, a bundle of resources).</div>
      ${row('Design id', `<input value="${esc(st.id)}" disabled>`, 'config/ships/<id>.json')}
      ${row('Name', `<input data-v="name" value="${esc(r.name ?? '')}">`)}
      ${row('Kind', `<select data-v="type">${['ship', 'starbase', 'relay'].map((t) => opt(t, r.type)).join('')}</select>`)}
      <h3>places</h3>
      <textarea data-vjson="places" style="min-height:160px">${esc(JSON.stringify(r.places || [], null, 1))}</textarea>
      <h3>the rest of the design</h3>
      <p class="hint">about, refit, lands, wiring, org, seats…</p>
      <textarea data-vjson="meta" style="min-height:160px">${esc(JSON.stringify(meta, null, 1))}</textarea>`;
  }

  function changed(n) { if (n) { styleNode(n); labelAll(); } setDirty(true); canvas.setDirty(true, true); }
  function bindPanel() {
    const p = $('panel'), sel = st.sel;
    if (sel?.kind === 'node') {
      const n = sel.node, s = n.sys;
      p.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('change', () => {
        const f = el.dataset.f, v = el.value.trim();
        if (f === 'id') {
          if (!ID_RE.test(v) || (v !== n.sysId && nodeById(v)) || (st.root.places || []).some((x) => x.id === v)) { el.classList.add('bad'); return; }
          el.classList.remove('bad'); renameSystem(n, v);
        } else if (f === 'parent') {
          let x = v && nodeById(v), guard = 0; while (x && guard++ < 50) { if (x === n) { el.value = n.parentId || ''; return alert("That's one of its own parts."); } x = x.parentId && nodeById(x.parentId); }
          n.parentId = v || null; regroup();
        } else if (f === 'count') {
          if (v === '') delete s.count; else if (v === 'null') s.count = null; else if (Number.isFinite(Number(v))) s.count = Number(v); else { el.classList.add('bad'); return; }
        } else if (f === 'type') s.type = v;
        else if (f === 'name') s.name = v;
        else if (v === '') delete s[f]; else s[f] = v;
        changed(n);
        if (['type', 'id', 'name'].includes(f)) select(sel);
      }));
      p.querySelectorAll('[data-rt]').forEach((el) => el.addEventListener('change', () => {
        const f = el.dataset.rt, k = el.dataset.k, obj = s[f] || {};
        if (el.dataset.part === 'res') {
          if (el.value in obj) { el.value = k; return; }
          s[f] = Object.fromEntries(Object.entries(obj).map(([r, x]) => [r === k ? el.value : r, x]));
        } else obj[k] = Number(el.value) || 0;
        changed(n); select(sel);
      }));
      p.querySelectorAll('[data-rt-del]').forEach((el) => el.addEventListener('click', () => {
        const f = el.dataset.rtDel; delete s[f][el.dataset.k]; if (!Object.keys(s[f]).length) delete s[f]; changed(n); select(sel);
      }));
      p.querySelectorAll('[data-rt-add]').forEach((el) => el.addEventListener('click', () => {
        const f = el.dataset.rtAdd, obj = (s[f] ||= {}); const r = st.resources.find((x) => !(x in obj)); if (!r) return;
        obj[r] = 0; changed(n); select(sel);
      }));
      p.querySelectorAll('[data-creative]').forEach((el) => el.addEventListener('change', () => {
        const r = el.dataset.creative; s.creative ||= {};
        if (el.checked) s.creative[r] = true; else delete s.creative[r];
        if (!Object.keys(s.creative).length) delete s.creative;
        changed(n);
      }));
      p.querySelectorAll('[data-json]').forEach((el) => el.addEventListener('change', () => {
        let v = null;
        if (el.value.trim()) { try { v = JSON.parse(el.value); } catch { el.classList.add('bad'); return; } }
        el.classList.remove('bad');
        if (el.dataset.json === 'effects') { if (v && typeof v === 'object' && !Array.isArray(v)) s.effects = v; else if (v === null) delete s.effects; else { el.classList.add('bad'); return; } }
        else { for (const k of Object.keys(s)) if (!HANDLED.includes(k)) delete s[k]; Object.assign(s, v || {}); }
        changed(n);
      }));
      p.querySelectorAll('[data-goto-link]').forEach((el) => el.addEventListener('click', (e) => { e.preventDefault(); const l = linkOf(Number(el.dataset.gotoLink)); if (l) select({ kind: 'link', link: l }); }));
      $('centre')?.addEventListener('click', () => centreOn(n));
      $('root-here')?.addEventListener('click', () => setView(st.view, n.sysId));
      $('del-node')?.addEventListener('click', () => { graph.remove(n); select(null); });
    } else if (sel?.kind === 'link') {
      const l = sel.link; l.bundle ||= {};
      const parse = (v) => ({ false: false, true: true, warn: 'warn', auto: 'auto' }[v]);
      const done = () => { colourLink(l); changed(); };
      p.querySelectorAll('[data-bp]').forEach((el) => el.addEventListener('change', () => {
        const perm = l.bundle[el.dataset.r]; if (el.value === '') delete perm[el.dataset.bp]; else perm[el.dataset.bp] = parse(el.value); done();
      }));
      p.querySelectorAll('[data-bn]').forEach((el) => el.addEventListener('change', () => {
        const perm = l.bundle[el.dataset.r], k = el.dataset.bn; if (el.value === '') delete perm[k]; else perm[k] = Number(el.value); done();
      }));
      p.querySelectorAll('[data-bf]').forEach((el) => el.addEventListener('change', () => {
        const perm = l.bundle[el.dataset.r], k = el.dataset.bf, v = el.value.trim();
        if (v === '') delete perm[k]; else if (k === 'min') perm.min = v === 'all' ? 'all' : Number.isFinite(Number(v)) ? Number(v) : v; else perm[k] = v;
        done();
      }));
      p.querySelectorAll('[data-bres]').forEach((el) => el.addEventListener('change', () => {
        const was = el.dataset.r;
        if (el.value in l.bundle) { el.value = was; return; }
        l.bundle = Object.fromEntries(Object.entries(l.bundle).map(([r, x]) => [r === was ? el.value : r, x]));
        done(); select(sel);
      }));
      p.querySelectorAll('[data-bdel]').forEach((el) => el.addEventListener('click', () => { delete l.bundle[el.dataset.bdel]; done(); select(sel); }));
      $('bundle-add-go')?.addEventListener('click', () => { const r = $('bundle-add').value; if (r && !(r in l.bundle)) { l.bundle[r] = { pull: 'auto', push: false }; done(); select(sel); } });
      $('del-link')?.addEventListener('click', () => {
        const t = graph.getNodeById(l.target_id);
        if (t) t.disconnectInput(l.target_slot);
        select(null);
      });
    } else if (st.root) {
      p.querySelectorAll('[data-v]').forEach((el) => el.addEventListener('change', () => { st.root[el.dataset.v] = el.value; changed(); }));
      p.querySelectorAll('[data-vjson]').forEach((el) => el.addEventListener('change', () => {
        let v; try { v = JSON.parse(el.value); } catch { el.classList.add('bad'); return; }
        el.classList.remove('bad');
        if (el.dataset.vjson === 'places') { if (!Array.isArray(v)) { el.classList.add('bad'); return; } st.root.places = v; }
        else {
          if (!v || typeof v !== 'object' || Array.isArray(v)) { el.classList.add('bad'); return; }
          const keep = ['schema', 'type', 'class', 'name', 'places'];
          st.root = { ...Object.fromEntries(Object.entries(st.root).filter(([k]) => keep.includes(k))), ...v };
          st.root = ordered(st.root, ['schema', 'type', 'class', 'name', ...(st.lib.meta || []), 'places']);
        }
        changed();
      }));
    }
  }
  // An id changed: what refers to it (links, places, via, parents) follows, on the canvas and in
  // the rest of the design. (Wires are by node.)
  function renameSystem(n, id) {
    const was = n.sysId;
    const renameKey = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k === was ? id : k, v]));
    for (const m of graph._nodes) {
      if (!m.sys) continue;
      if (m.parentId === was) m.parentId = id;
      if (m.sys.place === was) m.sys.place = id;
      if (m.sys.via === was) m.sys.via = id;
    }
    const fix = (systems) => {
      for (const sys of Object.values(systems || {})) {
        if (sys.upstream && was in sys.upstream) sys.upstream = renameKey(sys.upstream);
        if (sys.place === was) sys.place = id;
        if (sys.via === was) sys.via = id;
        if (sys.systems) { if (was in sys.systems) sys.systems = renameKey(sys.systems); fix(sys.systems); }
      }
    };
    if (was in st.model.systems) st.model.systems = renameKey(st.model.systems);
    fix(st.model.systems);
    for (const g of graph._groups) if (g.sysId === was) g.sysId = id;
    n.sysId = id;
  }

  // --- checking and saving ------------------------------------------------------------------------
  function problems(list, okText, warnings = []) {
    const f = $('problems');
    if (!list) { f.innerHTML = ''; return; }
    const ul = (xs) => `<ul>${xs.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
    f.innerHTML = (list.length ? `<span class="bad">${list.length} problem${list.length === 1 ? '' : 's'}:</span>${ul(list)}` : `<span class="ok">${esc(okText || 'No problems found.')}</span>`)
      + (warnings.length ? `<div class="warn">${esc(warnings[0])}</div>${ul(warnings.slice(1))}` : '');
    f.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
      const m = li.textContent.match(/^systems\.([a-z0-9-]+)/), n = m && nodeById(m[1]);
      if (n) { centreOn(n); select({ kind: 'node', node: n }); }
    }));
  }
  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    let v = {}; try { v = await r.json(); } catch { /* (not JSON) */ }
    if (!r.ok && !v.problems) throw new Error(v.error || `${r.status} ${r.statusText}`);
    return v;
  }
  async function check() {
    status('Checking…');
    const v = await api('POST', '/api/ship-designs/check', { id: st.id, graph: toGraph() });
    setDirty(st.dirty);
    problems(v.problems, v.warnings?.length ? 'No problems found: it would save.' : 'No problems found, and stable: it would save.', v.warnings);
    return v.problems;
  }
  async function save(asId) {
    const id = asId || st.id, asNew = !!asId || st.isNew;
    const g = toGraph();
    if (asId) g.class = asId;
    const v = await api('PUT', `/api/ship-designs/${encodeURIComponent(id)}`, { graph: g, layout: layoutOf(), asNew });
    if (!v.saved) { problems(v.problems || ['not saved']); status('Not saved: see the problems below'); return false; }
    if (asId || st.isNew) {
      st.id = id; st.isNew = false; st.root.class = g.class; await listDesigns(id);
      try { localStorage.setItem('shipdesigner.design', id); } catch { /* (no storage) */ }
    }
    st.model = clone(g); st.removed = new Set(); st.removedParent = {};
    for (const n of graph._nodes) if (n.sys) { const s = findIn(g.systems, n.sysId); if (s) n.keyOrder = Object.keys(s); }
    setDirty(false);
    problems([], v.note, v.warnings);
    return true;
  }
  function findIn(systems, id) { for (const [k, s] of Object.entries(systems || {})) { if (k === id) return s; const x = findIn(s.systems, id); if (x) return x; } return null; }

  // --- the page -----------------------------------------------------------------------------------
  function status(t) { $('status').textContent = t; }
  function setDirty(d) { st.dirty = d; $('status').classList.toggle('dirty', d); status(st.id ? `${st.id}${st.isNew ? ' (new)' : ''}${d ? ': unsaved changes' : ''}` : ''); }
  window.addEventListener('beforeunload', (e) => { if (st.dirty) { e.preventDefault(); e.returnValue = ''; } });
  // (Moving nodes isn't a design change, but it's worth saving: positions are kept on Save.)

  async function listDesigns(pick) {
    const v = await api('GET', '/api/ship-designs');
    st.lib = v; st.designs = v.designs;
    $('design').innerHTML = v.designs.map((d) => opt(d.id, pick, `${d.name} (${d.id})${d.graph ? '' : ': not a graph'}`)).join('');
  }
  async function open(id) {
    const v = await api('GET', `/api/ship-designs/${encodeURIComponent(id)}`);
    load(id, v.graph, v.layout);
    try { localStorage.setItem('shipdesigner.design', id); } catch { /* (no storage) */ }
  }
  const guard = () => !st.dirty || confirm('Discard the unsaved changes?');

  $('design').addEventListener('change', async (e) => {
    if (!guard()) { e.target.value = st.id; return; }
    try { await open(e.target.value); } catch (err) { status(`Couldn't open it: ${err.message}`); }
  });
  $('new').addEventListener('click', () => {
    if (!guard()) return;
    const id = (prompt('A new design: its id (lower-case letters, digits and -)') || '').trim();
    if (!id) return;
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id) || st.designs.some((d) => d.id === id)) return alert('That id is taken or not valid.');
    const name = (prompt('Its name', id) || id).trim();
    load(id, { schema: st.lib.schema, type: 'ship', class: id, name, places: [], systems: {} }, null, true);
    setDirty(true);
  });
  $('check').addEventListener('click', () => check().catch((err) => problems([err.message])));
  $('save').addEventListener('click', () => save().catch((err) => problems([err.message])));
  $('save-as').addEventListener('click', () => {
    const id = (prompt('Save as a new design: its id') || '').trim();
    if (!id) return;
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) return alert('Lower-case letters, digits and -, starting with a letter.');
    save(id).catch((err) => problems([err.message]));
  });
  $('arrange').addEventListener('click', () => { arrange(); fit(); });
  $('view').addEventListener('change', (e) => setView(e.target.value, st.focus));
  $('unfocus').addEventListener('click', () => setView(st.view, null));
  $('regroup').addEventListener('click', () => regroup());
  $('fit').addEventListener('click', fit);
  $('wire-mode').addEventListener('change', (e) => { st.wireMode = e.target.value; recolour(); });
  $('hide-heat').addEventListener('change', (e) => { st.hideHeat = e.target.checked; recolour(); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save().catch((err) => problems([err.message])); }
  });

  (async function start() {
    try {
      await listDesigns();
      st.types = st.lib.types; st.resources = st.lib.resources;
      EFFECTS = [...new Set([...EFFECTS, ...(st.lib.effects || [])])];
      $('view').innerHTML = `<option value="all">all resources</option>${st.resources.map((r) => `<option value="${r}">${r}</option>`).join('')}`;
      try { const v = localStorage.getItem('shipdesigner.view'); if (v === 'all' || st.resources.includes(v)) st.view = v; } catch { /* (no storage) */ }
      registerTypes();
      legend();
      let pick = null; try { pick = localStorage.getItem('shipdesigner.design'); } catch { /* (no storage) */ }
      const first = st.designs.find((d) => d.id === pick) || st.designs.find((d) => d.graph) || st.designs[0];
      resize();
      if (first) { $('design').value = first.id; await open(first.id); }
      canvas.draw(true, true);
    } catch (err) { status(`Couldn't start: ${err.message}`); console.error(err); }
  })();
})();
