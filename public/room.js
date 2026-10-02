// The room you're in: proximity chat with positional audio.
//
// The bridge is one room (its stations and consoles); every other place aboard
// is its own. With your room mic on, everyone else in the room hears you, over
// one-way connections (as for all hands): the relay says who's in the room
// (room-add: someone to send to; room-listen: someone to hear; room-drop when
// they part). On the bridge each place has a seat, everyone facing the
// viewscreen: a voice is panned left or right and quieter with distance.
// Elsewhere everyone is in the same spot.
//
// const room = createRoomVoice({ send, log, placeOf(id) -> place | null, myPlace() });
// await room.handle(msg)  // room-* / rsignal messages; true if handled ('gone' is shared)
// room.setMic(on), room.mic, room.reset()
(function () {
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
  // Bridge seats (metres; the viewscreen is ahead, -y): Helm and Ops forward,
  // the Captain in the centre with the First Officer beside them, Tactical
  // behind, the five consoles around the sides and the aft wall (numbered forward to aft).
  const SEATS = {
    Operations: [-1.2, -2.2], Helm: [1.2, -2.2], Captain: [0, 0], 'First Officer': [1, 0.2], Tactical: [0, 2.4],
    'Bridge 1': [-3.5, 0.5], 'Bridge 2': [3.5, 0.5], 'Bridge 3': [-3, 2.6], 'Bridge 4': [3, 2.6], 'Bridge 5': [0, 3.8],
  };
  const spot = (place) => SEATS[place] || [0, 0];
  // Where a voice sits for this listener: pan (-1 left, 1 right) and gain.
  function heard(from, at) {
    const [x1, y1] = spot(at), [x2, y2] = spot(from);
    const dx = x2 - x1, dist = Math.hypot(dx, y2 - y1);
    return { pan: Math.max(-1, Math.min(1, (0.8 * dx) / (dist + 0.5))), gain: 1 / (1 + dist / 4) };
  }

  window.createRoomVoice = function createRoomVoice({ send, log, placeOf, myPlace }) {
    let mic = null;             // { stream: Promise<MediaStream | null> }
    const out = new Map();      // listener id -> pc (what we send)
    const ins = new Map();      // speaker id -> { from, pc, el, src, gain, pan } (what we hear)
    let ctx = null;
    const audioCtx = () => {
      if (!ctx && window.AudioContext) ctx = new AudioContext();
      if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    };
    document.addEventListener('pointerdown', () => { if (ctx?.state === 'suspended') ctx.resume().catch(() => {}); });
    const sig = (to, dir, data) => send({ type: 'rsignal', to, dir, data });

    // --- sending ------------------------------------------------------------

    async function addListener(l) {
      const m = mic;
      if (!m) return;
      const stream = await m.stream;
      if (mic !== m) return;
      out.get(l.id)?.close();
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      out.set(l.id, pc);
      const track = stream?.getAudioTracks()[0];
      if (track) pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
      else pc.addTransceiver('audio', { direction: 'sendonly' });
      pc.onicecandidate = (e) => e.candidate && sig(l.id, 'listener', { candidate: e.candidate });
      await pc.setLocalDescription(await pc.createOffer());
      sig(l.id, 'listener', { sdp: pc.localDescription });
    }
    const dropOut = (id) => { out.get(id)?.close(); out.delete(id); };

    // --- hearing ------------------------------------------------------------

    function position(x) {
      const h = heard(placeOf(x.from.id) || x.from.console || x.from.station, myPlace());
      x.where = h;
      if (x.pan) { x.pan.pan.value = h.pan; x.gain.gain.value = h.gain; }
    }
    function dropIn(id) {
      const x = ins.get(id);
      if (!x) return;
      x.pc?.close();
      x.el.srcObject = null;
      x.src?.disconnect();
      ins.delete(id);
    }
    function play(x, stream) {
      x.el.srcObject = stream;
      const c = audioCtx();
      if (!c) { x.el.muted = false; return; }
      // (Chrome plays a remote stream through Web Audio only while an element holds it too, muted.)
      x.el.muted = true;
      x.src?.disconnect();
      x.src = c.createMediaStreamSource(stream);
      x.gain = c.createGain();
      x.pan = c.createStereoPanner();
      x.src.connect(x.gain).connect(x.pan).connect(c.destination);
      position(x);
    }

    // --- messages -----------------------------------------------------------

    async function handle(msg) {
      switch (msg.type) {
        case 'room-listen': {
          dropIn(msg.from.id);
          const el = new Audio();
          el.autoplay = true;
          ins.set(msg.from.id, { from: msg.from, el });
          log?.(`room: you hear ${msg.from.title || msg.from.name} (${msg.from.console || msg.from.station})`);
          return true;
        }
        case 'room-add':
          await addListener(msg.listener);
          return true;
        case 'room-drop':
          if (msg.from) dropIn(msg.from);
          if (msg.listener) dropOut(msg.listener);
          return true;
        case 'room-reset':
          [...out.keys()].forEach(dropOut);
          [...ins.keys()].forEach(dropIn);
          return true;
        case 'rsignal': {
          if (msg.dir === 'speaker') {
            const pc = out.get(msg.from);
            if (!pc) return true;
            if (msg.data.sdp) await pc.setRemoteDescription(msg.data.sdp);
            else if (msg.data.candidate) await pc.addIceCandidate(msg.data.candidate).catch(() => {});
            return true;
          }
          const x = ins.get(msg.from);
          if (!x) return true;
          if (msg.data.sdp?.type === 'offer') {
            x.pc?.close();
            const pc = x.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
            pc.ontrack = (e) => play(x, e.streams[0] || new MediaStream([e.track]));
            pc.onicecandidate = (e) => e.candidate && sig(msg.from, 'speaker', { candidate: e.candidate });
            await pc.setRemoteDescription(msg.data.sdp);
            await pc.setLocalDescription(await pc.createAnswer());
            sig(msg.from, 'speaker', { sdp: pc.localDescription });
          } else if (msg.data.candidate) {
            await x.pc?.addIceCandidate(msg.data.candidate).catch(() => {});
          }
          return true;
        }
        case 'gone':
          dropIn(msg.id);
          dropOut(msg.id);
          return false;
      }
      return false;
    }

    function setMic(on) {
      if (!!mic === !!on) return;
      if (on) {
        mic = { stream: navigator.mediaDevices.getUserMedia({ audio: true, video: false }).catch((err) => { log?.(`no microphone for the room (${err.name})`); return null; }) };
        audioCtx();
      } else {
        const m = mic;
        mic = null;
        [...out.keys()].forEach(dropOut);
        m.stream.then((st) => st?.getTracks().forEach((t) => t.stop()));
      }
      send({ type: 'room-mic', on: !!on });
    }

    // Seats change as people move about the bridge.
    setInterval(() => ins.forEach(position), 1000);

    const api = {
      handle,
      setMic,
      get mic() { return !!mic; },
      // Signed out: drop everything.
      reset() { if (mic) setMic(false); handle({ type: 'room-reset' }); },
      get speaking() { return [...out.entries()].map(([id, pc]) => ({ id, connected: pc.connectionState === 'connected' })); },
      get listening() { return [...ins.values()].map((x) => ({ from: x.from.name, connected: x.pc?.connectionState === 'connected', ...(x.where || {}) })); },
    };
    window.__room = api;
    return api;
  };
})();
