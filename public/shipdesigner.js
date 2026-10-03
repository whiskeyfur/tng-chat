// The ship designer (admin): a vessel's graph of systems (docs/ship-graph.md) as litegraph nodes.
//   A system is a node: one output per resource it gives, one input per link it draws on, and a
//   spare "+ resource" input to draw a new one. A wire is a link, from the upstream system to the
//   one that draws on it; its settings (pull, push, connect, rate, pri, min...) are in the panel.
//   A system's parts (child systems) sit in a box with it; the panel's Parent moves one.
//   The node menu (right-click, or double-click for search) is the type library.
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
  const EFFECTS = ['ftl', 'jump', 'impulse', 'maneuver', 'shields', 'phasers', 'torpedoes', 'tractor', 'transport', 'sensors', 'comms', 'life-support', 'gravity', 'dampers', 'sif', 'deflector', 'holo', 'force-fields', 'brig', 'shuttle-bay', 'docking', 'computing', 'replication', 'seat', 'cloak'];

  const st = {
    lib: null, types: {}, resources: [], designs: [],
    id: null, isNew: false, root: null, order: [], // the design's own fields (all but systems); its systems' ids in file order
    dirty: false, loading: false, sel: null, wireMode: 'state', hideHeat: false,
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
  canvas.renderLink = (ctx, a, b, link, ...rest) => (st.hideHeat && link?.type === 'heat' ? undefined : renderLink(ctx, a, b, link, ...rest));
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

  // --- the type library as node kinds ----------------------------------------------------------
  const nodeType = (t) => `${st.types[t]?.role || 'other'}/${t}`;
  function registerTypes() {
    const names = Object.keys(st.types).concat(['unknown']);
    for (const t of names) {
      const def = st.types[t] || { role: 'other', resources: [] };
      class SystemNode extends LGraphNode {
        constructor(title) { super(title || t); this.sysType = t; this.serialize_widgets = false; }
        onConnectInput(slot, type, output, origin) { return canDraw(this, origin, type, slot); }
        onConnectionsChange(io, index, connected, link) { connectionChanged(this, io, index, connected, link); }
        onRemoved() { nodeRemoved(this); }
      }
      SystemNode.title = t;
      SystemNode.desc = def.about || '';
      LiteGraph.registerNodeType(nodeType(t), SystemNode);
    }
  }

  // --- systems as nodes --------------------------------------------------------------------------
  // node.sys: the system's fields (without upstream and systems); node.sysId, node.parentId;
  // node.keyOrder / node.upOrder: the file's key order, kept on saving.
  const nodeById = (id) => graph._nodes.find((n) => n.sysId === id);
  const linkOf = (id) => (graph.links.get ? graph.links.get(id) : graph.links[id]);
  const allLinks = () => (graph.links.values ? [...graph.links.values()] : Object.values(graph.links)).filter(Boolean);
  const label = (n) => `${n.sys.name || n.sysId}`;

  function styleNode(n) {
    const role = st.types[n.sys.type]?.role;
    n.title = label(n);
    n.bgcolor = ROLE_COLOUR[role] || '#333';
    n.color = '#222';
    n.badges = [new LGraphBadge({ text: n.sysId, fgColor: '#ccc', bgColor: '#0006' })];
    if (!st.types[n.sys.type]) n.badges.push(new LGraphBadge({ text: `no type ${n.sys.type}`, fgColor: '#fff', bgColor: '#a33' }));
  }
  function slotColours(slot, r) { slot.color_on = RES_COLOUR[r] || '#ccc'; slot.color_off = RES_COLOUR[r] || '#888'; }
  function addOutputFor(n, r) {
    if (n.outputs?.some((o) => o.type === r)) return;
    slotColours(n.addOutput(r, r), r);
  }
  function addSpare(n, r) {
    if (n.inputs?.some((i) => i.spare && i.type === r)) return;
    const s = n.addInput(`+ ${r}`, r); s.spare = true; slotColours(s, r);
  }
  // An input's label: the resource and where it's drawn from.
  function labelInputs(n) {
    for (const inp of n.inputs || []) {
      if (inp.spare) { inp.label = `+ ${inp.type}`; continue; }
      const l = inp.link != null && linkOf(inp.link), o = l && graph.getNodeById(l.origin_id);
      inp.label = o ? `${inp.type} ← ${label(o)}` : inp.type;
    }
  }
  const labelAll = () => { for (const n of graph._nodes) if (n.sys) labelInputs(n); };
  function resourcesOf(n) { return [...new Set((n.outputs || []).map((o) => o.type).concat((n.inputs || []).map((i) => i.type)))]; }
  function addResource(n, r) { addOutputFor(n, r); addSpare(n, r); fitNode(n); canvas.setDirty(true, true); }
  function fitNode(n) { const s = n.computeSize(); n.setSize([Math.max(s[0], 180), s[1]]); }

  function makeNode(id, sys, parentId) {
    const n = LiteGraph.createNode(nodeType(st.types[sys.type] ? sys.type : 'unknown'));
    n.sysId = id; n.parentId = parentId || null;
    n.keyOrder = Object.keys(sys); n.upOrder = Object.keys(sys.upstream || {});
    n.sys = clone(sys); delete n.sys.upstream; delete n.sys.systems;
    styleNode(n);
    return n;
  }
  // A resource's slots: what the type says, what it consumes, produces, holds, and what its links carry.
  function initialResources(sys, outgoing) {
    const r = new Set(st.types[sys.type]?.resources || []);
    for (const f of ['consumes', 'produces', 'capacity', 'creative']) for (const k of Object.keys(sys[f] || {})) r.add(k);
    for (const res of Object.values(sys.upstream || {})) for (const k of Object.keys(res)) r.add(k);
    for (const k of outgoing || []) r.add(k);
    return [...r];
  }

  // --- loading a design ---------------------------------------------------------------------------
  function walk(systems, parent, out) {
    for (const [id, s] of Object.entries(systems || {})) { out.push({ id, s, parent }); walk(s.systems, id, out); }
    return out;
  }
  function load(id, file, layout, isNew = false) {
    st.loading = true;
    graph.clear();
    st.id = id; st.isNew = isNew;
    st.root = clone(file); delete st.root.systems;
    const list = walk(file.systems, null, []);
    st.order = list.map((x) => x.id);
    const outgoing = {};
    for (const { s } of list) for (const [u, res] of Object.entries(s.upstream || {})) for (const r of Object.keys(res)) (outgoing[u] ||= new Set()).add(r);
    const pending = [];
    for (const { id: sid, s, parent } of list) {
      const n = makeNode(sid, s, parent);
      const res = initialResources(s, outgoing[sid]);
      for (const r of res) addOutputFor(n, r);
      // (Inputs by resource: a slot per link, then the spare.)
      for (const r of res) {
        for (const [u, rs] of Object.entries(s.upstream || {})) if (rs[r]) { const slot = n.addInput(r, r); slotColours(slot, r); pending.push({ n, slot: n.inputs.length - 1, u, r, perm: rs[r] }); }
        addSpare(n, r);
      }
      fitNode(n);
      graph.add(n);
    }
    for (const p of pending) {
      const up = nodeById(p.u);
      if (!up) continue; // (an upstream that isn't there: the checker names it; dropped here)
      const link = up.connect(up.findOutputSlot(p.r), p.n, p.slot);
      if (link) { link.perm = clone(p.perm); colourLink(link); }
    }
    labelAll();
    for (const n of graph._nodes) fitNode(n);
    if (layout?.nodes && list.every(({ id: sid }) => layout.nodes[sid])) {
      for (const n of graph._nodes) n.pos = [...layout.nodes[n.sysId]];
      regroup(layout.groups);
    } else arrange();
    if (layout?.view) { canvas.ds.offset = [...layout.view.offset]; canvas.ds.scale = layout.view.scale; } else fit();
    st.loading = false;
    setDirty(false);
    select(null);
    problems(null);
    canvas.setDirty(true, true);
  }

  // --- wires ----------------------------------------------------------------------------------------
  const PERM_RANK = { false: 0, warn: 1, true: 2, auto: 3 };
  function stateOf(perm) {
    const vals = ['pull', 'push', 'connect'].map((k) => perm?.[k]).filter((v) => v !== undefined);
    if (!vals.length) return 'false';
    return String(vals.sort((a, b) => PERM_RANK[b] - PERM_RANK[a])[0]);
  }
  function colourLink(link) {
    link.color = st.wireMode === 'resource' ? RES_COLOUR[link.type] || '#999' : STATE_COLOUR[stateOf(link.perm)];
  }
  const recolour = () => { for (const l of allLinks()) colourLink(l); canvas.setDirty(true, true); legend(); };
  function legend() {
    const items = st.wireMode === 'resource' ? Object.entries(RES_COLOUR) : Object.entries(STATE_COLOUR).reverse().map(([k, c]) => [k === 'true' ? 'true (crew turns on)' : k === 'auto' ? 'auto (on at load)' : k === 'warn' ? 'warn' : 'false', c]);
    $('legend').innerHTML = items.map(([k, c]) => `<span><i style="background:${c}"></i>${esc(k)}</span>`).join('');
  }

  // May `node` draw `type` from `origin`? Not from itself, and once per resource per upstream system.
  function canDraw(node, origin, type, slot) {
    if (!origin || origin === node) return false;
    return !(node.inputs || []).some((inp, i) => i !== slot && inp.link != null && linkOf(inp.link)?.origin_id === origin.id && inp.type === type);
  }
  function connectionChanged(node, io, index, connected, link) {
    if (st.loading || io !== LiteGraph.INPUT) return;
    const slot = node.inputs[index];
    if (!slot) return;
    if (connected) {
      if (link && !link.perm) link.perm = { pull: 'auto', push: false };
      if (link) colourLink(link);
      if (slot.spare) { slot.spare = false; slot.name = slot.type; setTimeout(() => { addSpare(node, slot.type); labelInputs(node); fitNode(node); canvas.setDirty(true, true); }); }
      labelInputs(node);
    } else if (!slot.spare) {
      // (A link gone: its slot goes too, unless it's being replaced right now.)
      setTimeout(() => {
        const i = node.inputs.indexOf(slot);
        if (i >= 0 && slot.link == null) { node.removeInput(i); addSpare(node, slot.type); fitNode(node); canvas.setDirty(true, true); }
      });
    }
    if (st.sel?.kind === 'link' && !linkOf(st.sel.link.id)) select(null);
    setDirty(true);
  }
  function nodeRemoved(node) {
    if (st.loading) return;
    for (const n of graph._nodes) if (n.parentId === node.sysId) n.parentId = node.parentId;
    if (st.sel?.node === node) select(null);
    setDirty(true);
    setTimeout(() => regroup());
  }

  // A node added from the menu: a new system of that type.
  graph.onNodeAdded = (n) => {
    if (st.loading || n.sys) return;
    const t = n.sysType;
    let i = 1; while (nodeById(`${t}-${i}`)) i++;
    n.sysId = `${t}-${i}`; n.parentId = null; n.keyOrder = []; n.upOrder = [];
    n.sys = { type: t, name: `New ${t.replace(/-/g, ' ')}` };
    for (const r of st.types[t]?.resources || []) { addOutputFor(n, r); addSpare(n, r); }
    styleNode(n); fitNode(n);
    setDirty(true);
    setTimeout(() => select({ kind: 'node', node: n }));
  };

  // --- the graph written back --------------------------------------------------------------------
  function ordered(obj, order) {
    const keys = [...order.filter((k) => k in obj), ...Object.keys(obj).filter((k) => !order.includes(k))];
    return Object.fromEntries(keys.map((k) => [k, obj[k]]));
  }
  function systemOf(n) {
    const s = clone(n.sys);
    const up = {};
    for (const inp of n.inputs || []) {
      if (inp.link == null) continue;
      const l = linkOf(inp.link), o = l && graph.getNodeById(l.origin_id);
      if (!o) continue;
      (up[o.sysId] ||= {})[l.type] = clone(l.perm || { pull: 'auto', push: false });
    }
    // (In the file's order: its upstream systems, and each one's resources.)
    const upOrdered = ordered(up, n.upOrder);
    s.upstream = upOrdered;
    return s;
  }
  function toGraph() {
    const nodes = [...graph._nodes].filter((n) => n.sys);
    const rank = (n) => { const i = st.order.indexOf(n.sysId); return i < 0 ? 1e9 + n.id : i; };
    nodes.sort((a, b) => rank(a) - rank(b));
    const built = new Map(nodes.map((n) => [n.sysId, systemOf(n)]));
    const systems = {};
    for (const n of nodes) {
      const s = built.get(n.sysId), parent = n.parentId && built.get(n.parentId);
      const target = parent && n.parentId !== n.sysId ? (parent.systems ||= {}) : systems;
      target[n.sysId] = s;
    }
    for (const n of nodes) {
      const s = built.get(n.sysId), fresh = ordered(s, n.keyOrder.length ? n.keyOrder : ['type', 'name', 'key', 'place', 'via', 'capacity', 'produces', 'consumes', 'effects', 'creative', 'upstream', 'systems']);
      for (const k of Object.keys(s)) delete s[k];
      Object.assign(s, fresh);
    }
    return { ...st.root, systems };
  }
  function layoutOf() {
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
    const nodes = graph._nodes.filter((n) => n.sys);
    const top = nodes.filter((n) => !n.parentId || !nodeById(n.parentId));
    const topOf = (n) => { let x = n, guard = 0; while (x.parentId && nodeById(x.parentId) && guard++ < 20) x = nodeById(x.parentId); return x; };
    const edges = new Map(top.map((n) => [n, new Set()]));
    const heatOnly = new Set(top);
    for (const l of allLinks()) {
      const a = topOf(graph.getNodeById(l.origin_id)), b = topOf(graph.getNodeById(l.target_id));
      if (!a || !b || a === b) continue;
      if (l.type === 'heat') continue;
      heatOnly.delete(a); heatOnly.delete(b);
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
    const maxD = Math.max(0, ...[...depth.entries()].filter(([n]) => !heatOnly.has(n)).map(([, d]) => d));
    for (const n of heatOnly) if (n.inputs?.some((i) => i.type === 'heat' && i.link != null)) depth.set(n, maxD + 1);
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
  function descendants(n, kids) { const out = []; for (const k of kids(n)) out.push(k, ...descendants(k, kids)); return out; }

  // A box round each system that has parts: it and them. (Saved positions keep their own boxes.)
  function regroup(saved) {
    for (const g of [...graph._groups]) graph.remove(g);
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
    const res = resourcesOf(n);
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
      <h3>slots</h3>
      <div class="chips">${res.map((r) => `<span class="chip"><span class="dot" style="background:${RES_COLOUR[r] || '#ccc'}"></span>${r}</span>`).join('')}</div>
      <p><select id="add-res">${st.resources.filter((r) => !res.includes(r)).map((r) => opt(r, '')).join('')}</select> <button id="add-res-go">+ resource slot</button></p>
      ${Object.keys(others).length ? `<h3>other fields</h3><textarea data-json="others">${esc(JSON.stringify(others, null, 1))}</textarea>` : ''}
      <div class="actions"><button id="centre">Centre</button><button id="del-node" class="danger">Delete system</button></div>`;
  }
  function linkPanel(l) {
    const a = graph.getNodeById(l.origin_id), b = graph.getNodeById(l.target_id), p = l.perm || {};
    const permSel = (k) => `<select data-p="${k}"><option value="">(not set)</option>${['false', 'warn', 'true', 'auto'].map((v) => opt(v, p[k] === undefined ? '' : String(p[k]))).join('')}</select>`;
    const num = (k, t) => row(k, `<input type="number" step="any" data-pn="${k}" value="${esc(p[k] ?? '')}">`, t);
    return `<h2>${esc(l.type)} link</h2>
      <div class="about"><b>${esc(b ? label(b) : '?')}</b> draws ${esc(l.type)} from <b>${esc(a ? label(a) : '?')}</b>. Stored on ${esc(b?.sysId)}, under upstream.${esc(a?.sysId)}.${esc(l.type)}.</div>
      ${row('pull', permSel('pull'), 'May the downstream system draw from the upstream one?')}
      ${row('push', permSel('push'), 'May it send back the other way?')}
      ${row('connect', permSel('connect'), 'For a resource connected rather than moved')}
      <p class="hint">false: never. warn: allowed, not advised (a confirming tap). true: allowed, off at load. auto: allowed and on at load.</p>
      ${num('rate', 'Its limit on a pull')}${num('pushRate', 'Its limit the other way')}${num('pri', 'Who is served first when short (lower first)')}
      ${row('min', `<input data-f="min" value="${esc(p.min ?? '')}" placeholder='a number, or "all"'>`, 'The least it must get to work at all')}
      ${row('why', `<input data-f="why" value="${esc(p.why ?? '')}">`, "Why it's false or warn, shown to the crew")}
      <div class="actions"><button id="del-link" class="danger">Delete link</button></div>`;
  }
  function vesselPanel() {
    if (!st.root) return '<p class="hint">Pick a design.</p>';
    const r = st.root;
    const meta = Object.fromEntries(Object.entries(r).filter(([k]) => !['schema', 'type', 'class', 'name', 'places'].includes(k)));
    const nodes = graph._nodes.filter((n) => n.sys);
    return `<h2>${esc(r.name || st.id)}</h2>
      <div class="about">${nodes.length} systems, ${allLinks().length} links. Select a node or click a wire's centre to edit it. Right-click the canvas (or double-click) to add a system; drag from an output to a "+" input to link.</div>
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
        } else if (f === 'type') { s.type = v; for (const r of st.types[v]?.resources || []) addResource(n, r); }
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
          addResource(n, el.value);
        } else obj[k] = Number(el.value) || 0;
        changed(n); select(sel);
      }));
      p.querySelectorAll('[data-rt-del]').forEach((el) => el.addEventListener('click', () => {
        const f = el.dataset.rtDel; delete s[f][el.dataset.k]; if (!Object.keys(s[f]).length) delete s[f]; changed(n); select(sel);
      }));
      p.querySelectorAll('[data-rt-add]').forEach((el) => el.addEventListener('click', () => {
        const f = el.dataset.rtAdd, obj = (s[f] ||= {}); const r = st.resources.find((x) => !(x in obj)); if (!r) return;
        obj[r] = 0; addResource(n, r); changed(n); select(sel);
      }));
      p.querySelectorAll('[data-creative]').forEach((el) => el.addEventListener('change', () => {
        const r = el.dataset.creative; s.creative ||= {};
        if (el.checked) { s.creative[r] = true; addResource(n, r); } else delete s.creative[r];
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
      $('add-res-go')?.addEventListener('click', () => { const r = $('add-res').value; if (r) { addResource(n, r); changed(n); select(sel); } });
      $('centre')?.addEventListener('click', () => centreOn(n));
      $('del-node')?.addEventListener('click', () => { graph.remove(n); select(null); });
    } else if (sel?.kind === 'link') {
      const l = sel.link; l.perm ||= {};
      const parse = (v) => ({ false: false, true: true, warn: 'warn', auto: 'auto' }[v]);
      p.querySelectorAll('[data-p]').forEach((el) => el.addEventListener('change', () => {
        if (el.value === '') delete l.perm[el.dataset.p]; else l.perm[el.dataset.p] = parse(el.value);
        colourLink(l); changed();
      }));
      p.querySelectorAll('[data-pn]').forEach((el) => el.addEventListener('change', () => {
        const k = el.dataset.pn; if (el.value === '') delete l.perm[k]; else l.perm[k] = Number(el.value); changed();
      }));
      p.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('change', () => {
        const k = el.dataset.f, v = el.value.trim();
        if (v === '') delete l.perm[k]; else if (k === 'min') l.perm.min = v === 'all' ? 'all' : Number.isFinite(Number(v)) ? Number(v) : v; else l.perm[k] = v;
        changed();
      }));
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
  // An id changed: what refers to it (places, via, parents) follows. Links are by node.
  function renameSystem(n, id) {
    const was = n.sysId;
    for (const m of graph._nodes) {
      if (!m.sys) continue;
      if (m.parentId === was) m.parentId = id;
      if (m.sys.place === was) m.sys.place = id;
      if (m.sys.via === was) m.sys.via = id;
      const i = m.upOrder.indexOf(was); if (i >= 0) m.upOrder[i] = id;
    }
    const j = st.order.indexOf(was); if (j >= 0) st.order[j] = id;
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
    problems([], v.note, v.warnings);
    if (asId || st.isNew) {
      st.id = id; st.isNew = false; st.root.class = g.class; await listDesigns(id);
      try { localStorage.setItem('shipdesigner.design', id); } catch { /* (no storage) */ }
    }
    st.order = walk(g.systems, null, []).map((x) => x.id);
    for (const n of graph._nodes) if (n.sys) { const s = findIn(g.systems, n.sysId); if (s) { n.keyOrder = Object.keys(s); n.upOrder = Object.keys(s.upstream || {}); } }
    setDirty(false);
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
