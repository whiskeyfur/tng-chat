// One-way broadcasts, shown in a bar across the top of every console:
//  - All hands: ops opens it for a speaker; the speaker's mic goes to everyone
//    aboard (or on the data network) over send-only connections. Listeners
//    only receive: no return channel. Listeners can mute it locally.
//  - Ship's radio: a station put on by Communications or ops; each console
//    plays the stream itself.
//
// const bc = createBroadcast({ send, me, log });
// await bc.handle(msg)  // bcast-* / bsignal / ship-radio messages; true if handled ('gone' is shared)
(function () {
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

  window.createBroadcast = function createBroadcast({ send, me, log }) {
    const bar = el('div', { className: 'bcast-bar', id: 'bcast-bar', role: 'status' });
    document.body.append(bar);
    // An open modal (Comms) makes the rest of the page inert, so the bar moves
    // into it while it's open, to stay usable (End broadcast, Mute).
    const place = () => {
      const host = document.querySelector('dialog[open]') || document.body;
      if (bar.parentElement !== host) host.append(bar);
    };
    new MutationObserver(place).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });

    let speaking = null;            // { bid, label, stream, ready, pcs: Map(listener id -> pc) }
    const listening = new Map();    // bid -> { bid, from, label, pc, audio, muted }
    let radio = null;               // { name, url, by, audio, muted }
    let alert = null;               // a ship-wide warning, e.g. life support low

    const sig = (to, bid, data) => send({ type: 'bsignal', to, bid, data });

    // --- speaking ---------------------------------------------------------

    async function addListener(listener) {
      const s = speaking;
      const stream = await s.ready;
      if (speaking !== s) return;
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      s.pcs.set(listener.id, pc);
      const track = stream?.getAudioTracks()[0];
      if (track) pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
      else pc.addTransceiver('audio', { direction: 'sendonly' });
      pc.onicecandidate = (e) => e.candidate && sig(listener.id, s.bid, { candidate: e.candidate });
      await pc.setLocalDescription(await pc.createOffer());
      sig(listener.id, s.bid, { sdp: pc.localDescription });
    }

    function stopSpeaking() {
      if (!speaking) return;
      speaking.pcs.forEach((pc) => pc.close());
      speaking.ready.then((st) => st?.getTracks().forEach((t) => t.stop()));
      speaking = null;
    }

    // --- listening --------------------------------------------------------

    function stopListening(bid) {
      const l = listening.get(bid);
      if (!l) return;
      l.pc?.close();
      l.audio.srcObject = null;
      listening.delete(bid);
    }

    // --- ship's radio -----------------------------------------------------

    function setShipRadio(r) {
      if (radio && (!r || r.url !== radio.url)) { radio.audio.pause(); radio.audio.removeAttribute('src'); radio.audio.load(); radio = null; }
      if (r && !radio) {
        const audio = new Audio(r.url);
        radio = { ...r, audio, muted: false };
        audio.play().catch(() => { if (radio) radio.blocked = true; render(); });
        log?.(`ship's radio: ${r.name} (${r.by.name})`);
      } else if (r) Object.assign(radio, { name: r.name, by: r.by });
    }

    // --- messages ---------------------------------------------------------

    async function handle(msg) {
      switch (msg.type) {
        case 'bcast-speak':
          stopSpeaking();
          speaking = {
            bid: msg.bid, label: msg.label, pcs: new Map(),
            ready: navigator.mediaDevices.getUserMedia({ audio: true, video: false }).catch((err) => { log?.(`no microphone for the broadcast (${err.name})`); return null; }),
          };
          log?.(`you are broadcasting: ${msg.label}`);
          render();
          return true;
        case 'bcast-add':
          if (speaking?.bid === msg.bid) await addListener(msg.listener);
          return true;
        case 'bcast-listen': {
          stopListening(msg.bid);
          const audio = new Audio();
          audio.autoplay = true;
          listening.set(msg.bid, { bid: msg.bid, from: msg.from, label: msg.label, audio, muted: false });
          log?.(`all hands: ${msg.from.name} (${msg.from.station})`);
          render();
          return true;
        }
        case 'bsignal': {
          if (speaking?.bid === msg.bid) {
            const pc = speaking.pcs.get(msg.from);
            if (!pc) return true;
            if (msg.data.sdp) await pc.setRemoteDescription(msg.data.sdp);
            else if (msg.data.candidate) await pc.addIceCandidate(msg.data.candidate).catch(() => {});
            return true;
          }
          const l = listening.get(msg.bid);
          if (!l || msg.from !== l.from.id) return true;
          if (msg.data.sdp?.type === 'offer') {
            l.pc?.close();
            const pc = l.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
            pc.ontrack = (e) => { l.audio.srcObject = e.streams[0] || new MediaStream([e.track]); l.audio.muted = l.muted; };
            pc.onicecandidate = (e) => e.candidate && sig(l.from.id, l.bid, { candidate: e.candidate });
            await pc.setRemoteDescription(msg.data.sdp);
            await pc.setLocalDescription(await pc.createAnswer());
            sig(l.from.id, l.bid, { sdp: pc.localDescription });
          } else if (msg.data.candidate) {
            await l.pc?.addIceCandidate(msg.data.candidate).catch(() => {});
          }
          return true;
        }
        case 'bcast-ended':
          if (speaking?.bid === msg.bid) { stopSpeaking(); log?.(`broadcast ended${msg.reason ? `: ${msg.reason}` : ''}`); }
          if (listening.has(msg.bid)) { stopListening(msg.bid); log?.(`all-hands broadcast ended`); }
          render();
          return true;
        case 'ship-radio':
          setShipRadio(msg.radio);
          render();
          return true;
        case 'gone':
          // A listener left: drop their connection (shared with the call engine).
          if (speaking?.pcs.has(msg.id)) { speaking.pcs.get(msg.id).close(); speaking.pcs.delete(msg.id); }
          return false;
      }
      return false;
    }

    // --- the bar ----------------------------------------------------------

    function render() {
      bar.replaceChildren();
      const pill = (cls, text, ...buttons) => bar.append(el('div', { className: `bcast ${cls}` }, el('span', { className: 'bcast-text', textContent: text }), ...buttons));
      const button = (text, onclick, alert) => { const b = el('button', { type: 'button', className: `lcars-button lcars-button--pill${alert ? ' lcars-button--alert' : ''}`, textContent: text }); b.onclick = onclick; return b; };
      if (alert) pill('bcast--alert', alert);
      if (speaking) {
        pill('bcast--speaking', `On air: ${speaking.label}`, button('End broadcast', () => send({ type: 'bcast-end', bid: speaking.bid }), true));
      }
      for (const l of listening.values()) {
        pill('bcast--listening', `All hands · ${l.from.name} (${l.from.station}${l.from.ship.toLowerCase() !== me()?.ship.toLowerCase() ? `, ${l.from.ship}` : ''})`,
          button(l.muted ? 'Unmute' : 'Mute', () => { l.muted = !l.muted; l.audio.muted = l.muted; render(); }));
      }
      if (radio) {
        pill('bcast--radio', `Ship's radio · ${radio.name} (${radio.by.name})`,
          button(radio.blocked ? 'Play' : radio.muted ? 'Unmute' : 'Mute', () => {
            if (radio.blocked) { radio.blocked = false; radio.audio.play().catch(() => {}); } else { radio.muted = !radio.muted; radio.audio.muted = radio.muted; }
            render();
          }));
      }
      bar.hidden = !bar.children.length;
    }

    // Signed out: drop everything.
    function reset() {
      stopSpeaking();
      [...listening.keys()].forEach(stopListening);
      setShipRadio(null);
      render();
    }

    render();
    return {
      handle,
      reset,
      // A warning shown to everyone aboard (null clears it).
      setAlert(text) { if (text !== alert) { alert = text; render(); } },
      get speaking() { return speaking ? { bid: speaking.bid, label: speaking.label, listeners: speaking.pcs.size } : null; },
      get listening() { return [...listening.values()].map((l) => ({ bid: l.bid, from: l.from.name, connected: l.pc?.connectionState === 'connected', pc: l.pc })); },
      get shipRadio() { return radio ? { name: radio.name, url: radio.url, playing: !radio.audio.paused } : null; },
    };
  };
})();
