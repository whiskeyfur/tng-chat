// The comms stage (Communications: John's): a node stage (Drawflow) with the signals on the air on
// the left as they come (each an RF source: its channel, bearing, strength, phase offset and the
// interference on it; who it's from and for, once it's ours or we're listening), the crew aboard on
// the right, and modules in between that clean a signal up: an RF filter (tuned to a channel), a
// phase shifter (against the Doppler offset) and a waveform matcher (its red wave matched to the
// signal's blue one). Wire a hail through modules to someone and put it through: the relay works out
// the same quality (/shared/signals.js) and connects it if it's clean enough. Taps only, no sliders.
//   const stage = createStage(root, { send });
//   stage.update(own, crew)   // own: the nav's own (signals, comm); crew: the people aboard
(function () {
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const load = (src, css) => new Promise((ok, no) => { const t = css ? el('link', { rel: 'stylesheet', href: src }) : el('script', { src }); t.onload = ok; t.onerror = no; document.head.append(t); });
  let ready = null;
  const libs = () => (ready ||= Promise.all([load('/vendor/drawflow.css', true), load('/vendor/drawflow.js'), window.SIGNALS ? null : load('/shared/signals.js')]));

  window.createStage = function createStage(root, { send }) {
    let editor = null, own = null, crew = [];
    const bySignal = new Map(), byCrew = new Map(); // id -> drawflow node id
    const sigOf = (nid) => [...bySignal].find(([, n]) => n === nid)?.[0];
    const head = el('div', { className: 'stage-head' }), canvas = el('div', { className: 'stage-canvas', id: 'comm-stage' }), foot = el('p', { className: 'ops-hint' });
    foot.textContent = 'Drag from a signal to a module or a crew member to wire it; each module cleans the signal up: an RF filter on its channel takes out the interference, a phase shifter set against its offset the phase error, the waveform matcher the noise (match the red wave to the blue). Put through needs 60%.';
    root.replaceChildren(head, canvas, foot);
    const tap = (text, fn, id) => { const b = el('button', { type: 'button', className: 'lcars-button tr-tap', textContent: text, onclick: fn }); if (id) b.id = id; return b; };
    // (Buttons inside the nodes call these: Drawflow keeps node HTML as text.)
    const act = window.__stage = {
      route(sid) { const p = pathFrom(sid); if (p) send({ type: 'comms', route: { hail: sid, to: p.to, chain: p.chain } }); },
      listen(ch) { send({ type: 'comms', listen: ch }); },
      set(nid, key, delta, min, max, wrap) { const d = editor.getNodeFromId(nid).data; let v = (Number(d[key]) || 0) + delta; v = wrap ? ((v % wrap) + wrap) % wrap : Math.max(min, Math.min(max, v)); editor.updateNodeDataFromId(nid, { ...d, [key]: v }); paint(); },
    };

    function addModule(kind) {
      const n = ['filter', 'phase', 'wave'].reduce((t, k) => t + editor.getNodesFromName(k).length, 0);
      const data = kind === 'filter' ? { type: 'filter', channel: own?.comm?.channel || 100 } : kind === 'phase' ? { type: 'phase', shift: 0 } : { type: 'wave', frequency: 5, amplitude: 5, phase: 0 };
      editor.addNode(kind, 1, 1, 300 + (n % 2) * 20, 20 + n * 175, `stage-node stage-${kind}`, data, '');
      paint();
    }
    // The modules between a signal and someone aboard: the first full path, in order.
    function pathFrom(sid) {
      const start = bySignal.get(sid);
      if (!editor || !start) return null;
      const data = editor.export().drawflow.Home.data;
      const walk = (nid, chain, seen) => {
        const out = data[nid]?.outputs?.output_1?.connections || [];
        for (const c of out) {
          if (seen.has(c.node)) continue;
          const n = data[c.node];
          const who = [...byCrew].find(([, x]) => String(x) === String(c.node))?.[0];
          if (who) return { to: who, chain };
          if (n?.data?.type) { const r = walk(c.node, [...chain, n.data], new Set([...seen, c.node])); if (r) return r; }
        }
        return null;
      };
      return walk(String(start), [], new Set([String(start)]));
    }
    // A module's signal: the one wired into it, upstream.
    function signalInto(nid) {
      const data = editor.export().drawflow.Home.data;
      for (let x = String(nid), i = 0; i < 10; i++) {
        const sid = sigOf(Number(x)) || sigOf(x);
        if (sid) return (own?.signals || []).find((s) => s.id === sid);
        const up = data[x]?.inputs?.input_1?.connections?.[0];
        if (!up) return null;
        x = String(up.node);
      }
      return null;
    }
    const pct = (v) => `${Math.round(v * 100)}%`;
    function sourceHtml(s) {
      const p = pathFrom(s.id), q = p ? window.SIGNALS.quality(s, p.chain) : null;
      const who = p && crew.find((u) => u.id === p.to);
      return `<div class="stage-title">${s.kind === 'hail' ? 'Hail' : s.kind === 'call' ? 'Call' : 'Data link'} · RF source</div>`
        + `<div>Channel ${s.channel} · bearing ${String(s.bearing).padStart(3, '0')}° · ${s.distance} away</div>`
        + `<div>Strength ${pct(s.strength)} · phase ${s.phase > 0 ? '+' : ''}${s.phase}° · interference ${pct(s.interference)}</div>`
        + (s.from ? `<div>From the ${s.from}${s.to ? ` for the ${s.to}` : ''}${s.parties?.length ? `: ${s.parties.join(', ')}` : ''}</div>` : '<div>Unidentified carrier</div>')
        + (s.addressed && s.kind === 'hail' ? `<div>${q ? `Through: ${pct(q.quality)}${who ? ` to ${who.name}` : ''}` : 'Not wired to anyone'} <button class="lcars-button tr-tap" id="stage-route-${s.id}" onclick="window.__stage.route('${s.id}')"${!q || q.quality < window.SIGNALS.QUALITY_TO_ROUTE ? ' disabled' : ''}>Put through</button></div>` : '')
        + (!s.addressed ? `<div><button class="lcars-button tr-tap" onclick="window.__stage.listen(${s.listened ? 'null' : s.channel})">${s.listened ? 'Stop listening' : `Listen on ${s.channel}`}</button></div>` : '');
    }
    function moduleHtml(nid, d) {
      const b = (t, key, delta, min, max, wrap) => `<button class="lcars-button tr-tap" onclick="window.__stage.set(${nid}, '${key}', ${delta}, ${min}, ${max}, ${wrap || 0})">${t}</button>`;
      const sig = signalInto(nid);
      if (d.type === 'filter') return `<div class="stage-title">RF filter</div><div>Passes channel ${d.channel}${sig ? (sig.channel === d.channel ? ' · on the signal' : ` · the signal's is ${sig.channel}`) : ''}</div><div>${b('−10', 'channel', -10, 100, 999)}${b('−1', 'channel', -1, 100, 999)}${b('+1', 'channel', 1, 100, 999)}${b('+10', 'channel', 10, 100, 999)}</div>`;
      if (d.type === 'phase') return `<div class="stage-title">Phase shifter</div><div>Shift ${d.shift > 0 ? '+' : ''}${d.shift}°${sig ? ` · error ${Math.round(window.SIGNALS.quality(sig, [d]).parts.phaseError)}°` : ''}</div><div>${b('−15°', 'shift', -15, -180, 180)}${b('+15°', 'shift', 15, -180, 180)}</div>`;
      const m = sig ? window.SIGNALS.waveMatch(sig, d) : 0;
      return `<div class="stage-title">Waveform matcher${sig ? ` · ${pct(m)} match` : ''}</div><canvas class="stage-wave" width="220" height="60" data-node="${nid}"></canvas>`
        + `<div>Freq ${d.frequency} ${b('−', 'frequency', -1, 1, 9)}${b('+', 'frequency', 1, 1, 9)} Amp ${d.amplitude} ${b('−', 'amplitude', -1, 1, 9)}${b('+', 'amplitude', 1, 1, 9)} Phase ${d.phase}° ${b('−', 'phase', -15, -180, 180)}${b('+', 'phase', 15, -180, 180)}</div>`;
    }
    function drawWaves() {
      for (const c of canvas.querySelectorAll('canvas.stage-wave')) {
        const nid = Number(c.dataset.node), d = editor.getNodeFromId(nid)?.data, sig = signalInto(nid), g = c.getContext('2d');
        g.clearRect(0, 0, c.width, c.height);
        const wave = (w, colour) => { g.strokeStyle = colour; g.lineWidth = 2; g.beginPath(); for (let x = 0; x <= c.width; x++) { const y = c.height / 2 - (w.amplitude / 9) * (c.height / 2 - 4) * Math.sin((x / c.width) * w.frequency * 2 * Math.PI + (w.phase * Math.PI) / 180); if (x) g.lineTo(x, y); else g.moveTo(x, y); } g.stroke(); };
        if (sig) wave(sig.wave, '#99ccff');
        if (d) wave(d, '#dd4444');
      }
    }
    // Every node's text as things stand (the signals move, the settings change).
    function paint() {
      if (!editor) return;
      for (const s of own?.signals || []) { const nid = bySignal.get(s.id); const box = nid && canvas.querySelector(`#node-${nid} .drawflow_content_node`); if (box) box.innerHTML = sourceHtml(s); }
      for (const [, n] of Object.entries(editor.export().drawflow.Home.data)) if (n.data?.type) { const box = canvas.querySelector(`#node-${n.id} .drawflow_content_node`); if (box) box.innerHTML = moduleHtml(n.id, n.data); }
      drawWaves();
    }
    function sync() {
      if (!editor || !own) return;
      const sigs = own.signals || [];
      for (const [sid, nid] of [...bySignal]) if (!sigs.some((s) => s.id === sid)) { editor.removeNodeId(`node-${nid}`); bySignal.delete(sid); }
      sigs.forEach((s, i) => { if (!bySignal.has(s.id)) bySignal.set(s.id, editor.addNode('signal', 0, 1, 10, 20 + i * 170, `stage-node stage-signal${s.addressed ? ' stage-ours' : ''}`, { signal: s.id }, '')); });
      const right = Math.max(560, canvas.clientWidth - 260);
      for (const [uid, nid] of [...byCrew]) if (!crew.some((u) => u.id === uid)) { editor.removeNodeId(`node-${nid}`); byCrew.delete(uid); }
      crew.forEach((u, i) => { if (!byCrew.has(u.id)) byCrew.set(u.id, editor.addNode('crew', 1, 0, right, 20 + i * 70, 'stage-node stage-crew', { crew: u.id }, `<div class="stage-title">${u.name}</div><div>${u.station}</div>`)); });
      head.replaceChildren(
        pillBar(`Transmitting on ${own.comm.channel}`, [tap('−10', () => send({ type: 'comms', tune: own.comm.channel - 10 })), tap('−1', () => send({ type: 'comms', tune: own.comm.channel - 1 })), tap('+1', () => send({ type: 'comms', tune: own.comm.channel + 1 })), tap('+10', () => send({ type: 'comms', tune: own.comm.channel + 10 }))]),
        pillBar(own.comm.listen == null ? 'Not listening' : `Listening on ${own.comm.listen}`, [tap('Stop', () => send({ type: 'comms', listen: null }), 'stage-listen-off')]),
        pillBar('Add a module', [tap('RF filter', () => addModule('filter'), 'stage-add-filter'), tap('Phase shifter', () => addModule('phase'), 'stage-add-phase'), tap('Waveform matcher', () => addModule('wave'), 'stage-add-wave')]),
        el('p', { className: 'st-state', id: 'stage-state', textContent: sigs.length ? `${sigs.length} signal${sigs.length === 1 ? '' : 's'} on the air: ${sigs.filter((s) => s.addressed && s.kind === 'hail').length} hail${sigs.filter((s) => s.addressed && s.kind === 'hail').length === 1 ? '' : 's'} for us` : 'Nothing on the air in range' }));
      paint();
    }
    let lastSig = '';
    const api = {
      async update(o, people) {
        own = o; crew = people || [];
        if (!editor) {
          await libs();
          editor = new window.Drawflow(canvas);
          editor.reroute = false;
          editor.start();
          for (const ev of ['connectionCreated', 'connectionRemoved', 'nodeRemoved']) editor.on(ev, () => paint());
        }
        const sig = JSON.stringify([own.signals, own.comm, crew.map((u) => [u.id, u.station])]);
        if (sig === lastSig) return;
        lastSig = sig;
        sync();
      },
      pathFrom, editor: () => editor, nodes: () => ({ signals: Object.fromEntries(bySignal), crew: Object.fromEntries(byCrew) }),
    };
    window.__stageApi = api; // (for the tests)
    return api;
  };
}());
