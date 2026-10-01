// Call engine shared by the crew page (client.js) and the ops console
// (ops screens in ops.js). It handles every call message from the server, owns the
// WebRTC connections, and renders a call panel (incoming call, call bar with
// mute/hang-up, chat and file sharing) into a container the page provides.
//
// A call is one RTCPeerConnection per other participant (mesh), each carrying
// the shared microphone track plus two pre-negotiated data channels: "chat"
// (text) and "files" (file transfer). The caller sends the offer. Operators can
// force-connect people or patch someone into a call, so calls can have several
// participants. While in a call, a second caller gets "call waiting": ignore
// them (they hear busy), switch to them, or join them into the current call.
//
// const voice = createVoice(container, {
//   send(msg),          // send a message to the server
//   me(),               // { id, name, ship, station } once signed in
//   log(text),          // page log
//   onChange(state),    // state changed: idle | calling | ringing | in-call
//   buttonClass,        // extra class for the panel's buttons
// });
// await voice.handle(msg)  // returns true if the message was a call message
// voice.placeCall(user), voice.end(reason), voice.sys(text), voice.state, voice.call
(function () {
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
  const CHUNK = 16 * 1024;           // file chunk size; safe across browsers
  const HIGH_WATER = 1024 * 1024;    // pause sending while this much is buffered

  const PANEL = `
    <div class="v-incoming" hidden>
      <span class="v-incoming-text">Incoming call from <b class="v-incoming-from"></b></span>
      <button type="button" class="v-accept">Accept</button>
      <button type="button" class="v-decline">Decline</button>
    </div>
    <div class="v-waiting" hidden>
      <span class="v-waiting-text">Call waiting: <b class="v-waiting-from"></b></span>
      <button type="button" class="v-ignore">Ignore</button>
      <button type="button" class="v-switch">Switch</button>
      <button type="button" class="v-join">Join</button>
    </div>
    <div class="v-bar" hidden>
      <span class="v-status"></span>
      <button type="button" class="v-mute">Mute</button>
      <button type="button" class="v-hangup">Hang up</button>
    </div>
    <section class="v-chat" hidden>
      <div class="v-chatlog"></div>
      <form class="v-chat-form"><input class="v-chat-text" placeholder="message" autocomplete="off"><button>Send</button></form>
      <form class="v-file-form"><input class="v-file" type="file" multiple><button>Send file</button></form>
    </section>`;

  window.createVoice = function createVoice(root, opts) {
    root.innerHTML = PANEL;
    const q = (cls) => root.querySelector(`.v-${cls}`);
    if (opts.buttonClass) root.querySelectorAll('button').forEach((b) => b.classList.add(...opts.buttonClass.split(' ')));

    let state = 'idle';  // idle | calling | ringing | in-call
    let waiting = null;  // a second caller while in a call: { id, name, ship, station, cid }
    let call = null;     // { cid, peers: Map(user id -> peer), stream, viaOperator }
                         // peer: { id, name, ship, station, cid, pc, chat, files, audio, incoming, sendQueue }

    const me = () => opts.me();
    const log = (s) => opts.log(s);
    // "Riker (First Officer)", plus the ship when it isn't ours.
    const label = (u) => `${u.name} (${u.station}${u.ship && me() && u.ship.toLowerCase() !== me().ship.toLowerCase() ? `, ${u.ship}` : ''})`;

    const sendTo = (to, msg) => opts.send({ ...msg, to });
    // Every call carries an id so messages from an earlier or replaced call
    // (for example after an operator forces a new connection) are ignored.
    const sendCall = (p, msg) => sendTo(p.id, { ...msg, cid: p.cid });

    // --- server messages -----------------------------------------------------

    async function handle(msg) {
      switch (msg.type) {
        case 'gone': {
          // Someone left the comm net (closed the tab, lost network), on any ship.
          const p = call?.peers.get(msg.id);
          if (p) removePeer(p.id, `${p.name} went offline`);
          return true;
        }
        case 'unavailable': {
          const p = call?.peers.get(msg.id);
          if (p) removePeer(p.id, `${p.name} is not reachable`);
          return true;
        }
        case 'call':
          // In a call: one caller can wait (ignore, switch or join). Anyone else,
          // or anyone while we are still ringing or dialling, hears busy.
          if (state === 'in-call' && !waiting) {
            waiting = { ...msg.fromInfo, cid: msg.cid };
            log(`call waiting: ${label(waiting)}`);
            refresh();
            return true;
          }
          if (state !== 'idle') { sendTo(msg.from, { type: 'decline', reason: 'busy', cid: msg.cid }); return true; }
          call = newCall(msg.cid, [msg.fromInfo]);
          setState('ringing');
          return true;
        case 'connect': {
          // An operator joined us with msg.peers: drop whatever we were doing and
          // connect straight away, no ringing. The side with role "caller" sends
          // the offers; the server always tells the answering side first.
          abandonCall();
          const joined = msg.via === 'join';
          const c = call = newCall(msg.cid, msg.peers, !joined);
          setState('in-call');
          log(joined ? `joined the call with ${msg.peers.map(label).join(', ')}` : `operator connected you with ${msg.peers.map(label).join(', ')}`);
          for (const p of [...c.peers.values()]) {
            if (await setupPeer(p) && msg.role === 'caller') await sendOffer(p);
          }
          return true;
        }
        case 'add-peer': {
          // An operator is bringing someone into our call; they will send the offer.
          if (!call || call.cid !== msg.cid || state !== 'in-call') return true;
          const p = addPeer(call, msg.peer);
          chatLine(msg.via === 'join' ? `${label(msg.peer)} is joining the call` : `the operator is bringing ${label(msg.peer)} into the call`, 'sys');
          await setupPeer(p);
          refresh();
          return true;
        }
        case 'force-hangup':
          if (call) abandonCall(msg.reason || 'operator ended the call');
          return true;
        case 'accept':
        case 'decline':
        case 'hangup':
        case 'signal': {
          // The waiting caller gave up.
          if (waiting && msg.from === waiting.id && msg.cid === waiting.cid) {
            if (msg.type === 'hangup') { log(`${waiting.name} hung up`); waiting = null; refresh(); }
            return true;
          }
          // Belongs to the current call; ignore stragglers from others.
          const p = call?.peers.get(msg.from);
          if (p && msg.cid === call.cid) await onCallMessage(p, msg);
          return true;
        }
      }
      return false;
    }

    async function onCallMessage(p, msg) {
      switch (msg.type) {
        case 'accept':
          if (state !== 'calling') break;
          setState('in-call');
          if (await setupPeer(p)) await sendOffer(p);
          break;
        case 'decline':
          if (state === 'calling') endCall(`${p.name} ${msg.reason === 'busy' ? 'is busy' : 'declined'}`);
          break;
        case 'hangup':
          removePeer(p.id, `${p.name} hung up`);
          break;
        case 'signal': {
          const { pc } = p;
          if (!pc) break;
          if (msg.data.sdp) {
            await pc.setRemoteDescription(msg.data.sdp);
            if (msg.data.sdp.type === 'offer') {
              await pc.setLocalDescription(await pc.createAnswer());
              sendCall(p, { type: 'signal', data: { sdp: pc.localDescription } });
            }
          } else if (msg.data.candidate) {
            await pc.addIceCandidate(msg.data.candidate).catch((err) => log('ICE error: ' + err));
          }
          break;
        }
      }
    }

    // --- call lifecycle ------------------------------------------------------

    // people: [{ id, name, ship, station }]
    function newCall(cid, people, viaOperator = false) {
      const c = { cid, peers: new Map(), stream: null, streamReady: null, viaOperator };
      for (const u of people) addPeer(c, u);
      return c;
    }

    function addPeer(c, u) {
      const p = { id: u.id, name: u.name, ship: u.ship, station: u.station, cid: c.cid, sendQueue: Promise.resolve() };
      c.peers.set(u.id, p);
      return p;
    }

    function placeCall(u) {
      if (state !== 'idle') return;
      call = newCall(Math.random().toString(36).slice(2), [u]);
      setState('calling');
      sendCall(onlyPeer(), { type: 'call' });
    }

    async function acceptCall() {
      if (state !== 'ringing') return;
      const c = call;
      const p = onlyPeer();
      setState('in-call');
      // Create the connection before accepting so it is ready for the caller's offer.
      if (await setupPeer(p) && call === c) sendCall(p, { type: 'accept' });
    }

    function declineCall() {
      if (state !== 'ringing') return;
      sendCall(onlyPeer(), { type: 'decline' });
      endCall('declined');
    }

    // Leave the current call (if any) politely: decline if it was still ringing.
    function abandonCall(reason) {
      if (!call) return;
      for (const p of call.peers.values()) sendCall(p, { type: state === 'ringing' ? 'decline' : 'hangup' });
      endCall(reason || 'call ended');
    }

    const onlyPeer = () => call.peers.values().next().value;

    async function sendOffer(p) {
      await p.pc.setLocalDescription(await p.pc.createOffer());
      sendCall(p, { type: 'signal', data: { sdp: p.pc.localDescription } });
    }

    // The microphone is requested once per call, only when it actually connects,
    // and the same stream is shared by every connection in the call.
    function getStream(c) {
      c.streamReady ??= navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        .catch((err) => { log(`no microphone (${err.name}); continuing with chat and files only`); return null; })
        .then((stream) => {
          if (call !== c) { stream?.getTracks().forEach((t) => t.stop()); return null; } // hung up meanwhile
          c.stream = stream;
          q('mute').disabled = !stream;
          return stream;
        });
      return c.streamReady;
    }

    // Returns false if the call ended or the peer left while waiting for the mic.
    async function setupPeer(p) {
      const c = call;
      const stream = await getStream(c);
      if (call !== c || c.peers.get(p.id) !== p) return false;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      p.pc = pc;
      if (stream) stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      else pc.addTransceiver('audio', { direction: 'recvonly' });

      // Pre-negotiated channels: both sides create them with fixed ids, so no
      // ondatachannel handshake is needed and they open together with the call.
      p.chat = pc.createDataChannel('chat', { negotiated: true, id: 0 });
      p.files = pc.createDataChannel('files', { negotiated: true, id: 1 });
      p.files.binaryType = 'arraybuffer';
      p.files.bufferedAmountLowThreshold = HIGH_WATER / 2;
      p.chat.onopen = () => {
        chatLine(c.viaOperator && c.peers.size === 1 ? `the operator connected you with ${label(p)}` : `connected to ${label(p)}`, 'sys');
        q('chat-text').focus({ preventScroll: true });
      };
      p.chat.onmessage = (e) => chatLine(`${p.name}: ${e.data}`);
      p.files.onmessage = (e) => onFileData(p, e.data);

      p.audio = new Audio();
      p.audio.autoplay = true;
      pc.ontrack = (e) => { p.audio.srcObject = e.streams[0] || new MediaStream([e.track]); };
      pc.onicecandidate = (e) => e.candidate && sendCall(p, { type: 'signal', data: { candidate: e.candidate } });
      pc.onconnectionstatechange = () => {
        if (call !== c) return;
        renderStatus();
        if (pc.connectionState === 'failed') log(`connection to ${p.name} failed (a TURN server may be needed)`);
      };
      return true;
    }

    function closePeer(p) {
      p.pc?.close();
      if (p.audio) p.audio.srcObject = null;
    }

    // One person left the call; the call itself ends when nobody else is left.
    function removePeer(id, reason) {
      const p = call?.peers.get(id);
      if (!p) return;
      if (call.peers.size === 1) return endCall(reason);
      call.peers.delete(id);
      closePeer(p);
      log(reason);
      chatLine(reason, 'sys');
      refresh();
    }

    function endCall(reason) {
      const c = call;
      if (!c) return;
      call = null;
      const connected = [...c.peers.values()].some((p) => p.pc);
      c.peers.forEach(closePeer);
      c.stream?.getTracks().forEach((t) => t.stop());
      if (reason) log(reason);
      if (connected) chatLine(reason || 'call ended', 'sys');
      setState('idle');
      // Someone was waiting: now they ring normally.
      if (waiting) {
        const w = waiting;
        waiting = null;
        call = newCall(w.cid, [w]);
        setState('ringing');
      }
    }

    // --- call waiting ----------------------------------------------------------

    function ignoreWaiting() {
      if (!waiting) return;
      sendTo(waiting.id, { type: 'decline', reason: 'busy', cid: waiting.cid });
      log(`ignored ${waiting.name}`);
      waiting = null;
      refresh();
    }

    // Hang up on the current call and answer the waiting one.
    async function switchToWaiting() {
      if (!waiting) return;
      const w = waiting;
      waiting = null;
      abandonCall(`switched to ${w.name}`);
      call = newCall(w.cid, [w]);
      setState('ringing');
      await acceptCall();
    }

    // Bring the waiting caller into the current call. The server tells everyone
    // in it, and the caller connects to each of them.
    function joinWaiting() {
      if (!waiting || state !== 'in-call') return;
      opts.send({ type: 'merge', caller: waiting.id });
      waiting = null;
      refresh();
    }

    // --- chat and files ------------------------------------------------------

    function chatLine(text, cls, node) {
      const div = document.createElement('div');
      if (cls) div.className = cls;
      div.textContent = text;
      if (node) div.append(' ', node);
      q('chatlog').appendChild(div);
      q('chatlog').scrollTop = q('chatlog').scrollHeight;
      return div;
    }

    const openPeers = (channel) => [...(call?.peers.values() || [])].filter((p) => p[channel]?.readyState === 'open');

    // Chat goes to everyone in the call.
    function sendChat(text) {
      const targets = openPeers('chat');
      if (!targets.length || !text) return false;
      for (const p of targets) p.chat.send(text);
      chatLine(`${me().name}: ${text}`);
      return true;
    }

    // Files go to everyone in the call over each ordered, reliable "files"
    // channel as a JSON header followed by binary chunks. Each peer has its own
    // queue so two files never interleave on one channel.
    function sendFile(file) {
      const targets = openPeers('files');
      if (!targets.length) return;
      const line = chatLine(`sending ${file.name} (${fmtSize(file.size)})...`, 'sys');
      const sends = targets.map((p) => {
        const send = p.sendQueue.then(async () => {
          const ch = p.files;
          ch.send(JSON.stringify({ name: file.name, size: file.size, mime: file.type }));
          for (let off = 0; off < file.size; off += CHUNK) {
            if (ch.bufferedAmount > HIGH_WATER) {
              await new Promise((r) => ch.addEventListener('bufferedamountlow', r, { once: true }));
            }
            if (ch.readyState !== 'open') throw new Error(`${p.name} left`);
            ch.send(await file.slice(off, off + CHUNK).arrayBuffer());
          }
        });
        p.sendQueue = send.catch(() => {}); // keep the queue usable after a failure
        return send;
      });
      Promise.allSettled(sends).then((results) => {
        const failed = results.filter((r) => r.status === 'rejected');
        line.textContent = failed.length
          ? `sent ${file.name} to ${results.length - failed.length} of ${results.length} (${failed.map((r) => r.reason.message).join(', ')})`
          : `sent ${file.name} (${fmtSize(file.size)})`;
      });
    }

    function onFileData(p, data) {
      if (typeof data === 'string') {
        p.incoming = { ...JSON.parse(data), parts: [], received: 0 };
      } else if (p.incoming) {
        p.incoming.parts.push(data);
        p.incoming.received += data.byteLength;
      }
      const f = p.incoming;
      if (f && f.received >= f.size) {
        p.incoming = null;
        const url = URL.createObjectURL(new Blob(f.parts, { type: f.mime || 'application/octet-stream' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = f.name;
        a.textContent = `${f.name} (${fmtSize(f.size)})`;
        chatLine(`${p.name} sent`, null, a);
      }
    }

    function fmtSize(n) {
      return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
    }

    // --- panel ---------------------------------------------------------------

    function renderStatus() {
      if (state === 'calling') q('status').textContent = `Calling ${label(onlyPeer())}...`;
      if (state !== 'in-call') return;
      const who = [...call.peers.values()].map((p) => `${label(p)}: ${p.pc?.connectionState || 'connecting'}`);
      q('status').textContent = `In call with ${who.join(', ')}`;
    }

    // Redraw the panel and report our state to the server, so operators can see
    // who is free and who is in a call with whom.
    function refresh() {
      const peers = call ? [...call.peers.keys()] : [];
      if (me()) opts.send({ type: 'status', state, peers, cid: call?.cid || null });
      q('incoming').hidden = state !== 'ringing';
      q('waiting').hidden = !waiting;
      if (waiting) q('waiting-from').textContent = label(waiting);
      if (state === 'ringing') q('incoming-from').textContent = label(onlyPeer());
      q('bar').hidden = state !== 'calling' && state !== 'in-call';
      q('hangup').textContent = state === 'calling' ? 'Cancel' : 'Hang up';
      q('mute').hidden = state !== 'in-call';
      q('chat').hidden = state !== 'in-call';
      renderStatus();
      opts.onChange?.(state);
    }

    function setState(s) {
      if (s === 'in-call' && state !== 'in-call') q('chatlog').replaceChildren();
      if (s !== state) q('mute').textContent = 'Mute';
      state = s;
      refresh();
    }

    q('accept').onclick = acceptCall;
    q('ignore').onclick = ignoreWaiting;
    q('switch').onclick = switchToWaiting;
    q('join').onclick = joinWaiting;
    q('decline').onclick = declineCall;
    q('hangup').onclick = () => abandonCall('call ended');
    q('mute').onclick = () => {
      const track = call?.stream?.getAudioTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      q('mute').textContent = track.enabled ? 'Mute' : 'Unmute';
    };
    q('chat-form').onsubmit = (e) => {
      e.preventDefault();
      if (sendChat(q('chat-text').value.trim())) q('chat-text').value = '';
    };
    q('file-form').onsubmit = (e) => {
      e.preventDefault();
      for (const f of q('file').files) sendFile(f);
      q('file').value = '';
    };

    return {
      handle,
      placeCall,
      label,
      end: (reason) => endCall(reason),
      // A system line in the call's chat, if a call is up.
      sys: (text) => { if (call) chatLine(text, 'sys'); },
      get state() { return state; },
      get call() { return call; },
      get waiting() { return waiting; },
      // Look a call participant up by name (tests use names) or by id.
      peer: (n) => call && [...call.peers.values()].find((p) => p.id === n || p.name.toLowerCase() === n.toLowerCase()),
      peerNames: () => (call ? [...call.peers.values()].map((p) => p.name).sort() : []),
      // True when the call has exactly n other people and every connection is up.
      connectedTo: (n) => !!call && call.peers.size === n && [...call.peers.values()].every((p) => p.pc?.connectionState === 'connected'),
    };
  };
})();
