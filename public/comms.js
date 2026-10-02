// The Comms modal, the same for every role (crew consoles and the ops
// console): a directory of everyone you can call (your ship, plus every ship
// on your data network), and the call panel from voice.js. It opens from a
// sidebar button, and opens by itself when a call comes in or an operator
// connects you. Calls carry on while it is closed.
//
// const comms = createComms({
//   send, me, log,          // as for createVoice
//   button,                 // sidebar element that opens the modal
//   extras,                 // optional element shown under the call panel (ops: transfer)
//   onChange(state),        // call state changed
// });
// await comms.handle(msg)   // call messages, 'users' and 'notice'; true if handled
(function () {
  const MODAL = `
    <div class="lcars-modal__frame">
      <header class="lcars-modal__bar">
        <span class="lcars-modal__title">Comms</span>
        <span class="lcars-modal__fill"></span>
        <span class="lcars-modal__net" id="comms-net"></span>
        <button type="button" class="lcars-button lcars-button--pill" id="comms-close">Close</button>
      </header>
      <p class="ops-notice comms-offline" id="comms-offline" hidden></p>
      <p class="lcars-note" id="ops-status"></p>
      <p class="ops-notice" id="notice"></p>
      <div class="ops-call" id="call"></div>
      <div id="comms-extras"></div>
      <h3 class="ops-subhead">Directory</h3>
      <ul class="comms-dir" id="users"></ul>
      <h3 class="ops-subhead">Messages</h3>
      <ol class="comms-msgs" id="messages" aria-live="polite"></ol>
      <form class="ops-form comms-compose" id="msg-form">
        <span id="msg-to">Tap Msg by names to pick who to write to</span>
        <input class="ops-input" id="msg-text" placeholder="Message" autocomplete="off" aria-label="message">
        <button class="lcars-button lcars-button--pill" id="msg-send">Send</button>
      </form>
      <h3 class="ops-subhead">Subspace radio</h3>
      <div class="radio" id="radio"></div>
    </div>`;

  window.createComms = function createComms(opts) {
    const dialog = document.createElement('dialog');
    dialog.className = 'lcars-modal';
    dialog.id = 'comms';
    dialog.setAttribute('aria-label', 'Comms');
    dialog.innerHTML = MODAL;
    document.body.append(dialog);
    const $ = (id) => dialog.querySelector(`#${id}`);
    if (opts.extras) $('comms-extras').append(opts.extras);

    let users = [];
    let hardLinks = []; // ships we're linked to by a docking port's hard line
    let prev = 'idle';
    // Text messages, no call needed: to one person or a group, by tapping Msg in the directory.
    const recipients = new Set();
    const messages = [];
    let unread = 0;
    const me = () => opts.me();

    const voice = createVoice($('call'), {
      send: opts.send,
      me: opts.me,
      log: opts.log,
      buttonClass: 'lcars-button lcars-button--pill',
      onChange: (state) => {
        // Pop up for an incoming or waiting call, or when an operator puts you through.
        if ((state === 'ringing' || voice?.waiting || (state === 'in-call' && prev === 'idle')) && !dialog.open) open();
        // Hail and transfer progress notices are done once a call is under way.
        if (state === 'in-call' || state === 'calling') $('notice').textContent = '';
        prev = state;
        renderButton();
        renderDirectory();
        radio?.render();
        opts.onChange?.(state);
      },
    });

    // Subspace radio: listen, or patch a station into the call.
    const radio = window.createRadio ? createRadio($('radio'), { voice, log: opts.log, send: opts.send, canShipRadio: opts.canShipRadio }) : null;

    function open() {
      if (!dialog.open) dialog.showModal();
      unread = 0;
      renderButton();
    }
    function close() {
      if (dialog.open) dialog.close();
    }
    $('comms-close').onclick = close;
    if (opts.button) opts.button.onclick = (e) => { e.preventDefault(); open(); };

    function renderButton() {
      if (!opts.button) return;
      const label = voice.waiting ? 'Comms · call waiting'
        : { idle: 'Comms', calling: 'Comms · calling', ringing: 'Comms · incoming', 'in-call': 'Comms · in call' }[voice.state];
      opts.button.dataset.state = voice.waiting ? 'ringing' : voice.state;
      opts.button.querySelector('span').textContent = unread ? `${label} · ${unread} message${unread > 1 ? 's' : ''}` : label;
    }

    // Your ship first, then the other ships on the data network.
    function renderDirectory() {
      const ul = $('users');
      ul.replaceChildren();
      const self = me();
      if (!self) return;
      const others = users.filter((u) => u.id !== self.id);
      if (!others.length) {
        ul.append(Object.assign(document.createElement('li'), { className: 'empty', textContent: 'Nobody else is on the comm net' }));
        return;
      }
      const home = self.ship.toLowerCase();
      const ships = [...new Set(others.map((u) => u.ship))]
        .sort((a, b) => (b.toLowerCase() === home) - (a.toLowerCase() === home) || a.localeCompare(b));
      for (const ship of ships) {
        const isHome = ship.toLowerCase() === home;
        ul.append(Object.assign(document.createElement('li'), {
          className: `comms-ship${isHome ? ' comms-ship--home' : ''}`,
          textContent: isHome ? `Aboard the ${ship}` : `The ${ship} · ${hardLinks.includes(ship) ? 'hard link: docking port' : 'data link'}`,
        }));
        const crew = others.filter((u) => u.ship === ship)
          .sort((a, b) => (b.station === 'Operations') - (a.station === 'Operations') || a.name.localeCompare(b.name));
        // (By where they are aboard, in deck order: a heading for each place.)
        for (const g of byPlace(crew, (x) => x.console || x.station)) {
          ul.append(Object.assign(document.createElement('li'), { className: 'place-head', textContent: g.label }));
          for (const u of g.items) {
          const li = document.createElement('li');
          li.className = 'comms-entry';
          const name = document.createElement('span');
          name.textContent = u.title || u.name;
          const station = document.createElement('small');
          // Species and gender come only for people in the same place.
          const inPerson = [u.species, u.gender].filter(Boolean).join(', ');
          station.textContent = `${isHome ? u.station : `${u.station}, ${u.ship}`}${inPerson ? ` · ${inPerson}` : ''}${u.hologram ? ' · hologram' : ''}${u.sickbay ? ' · sickbay' : ''}${u.confined ? ' · confined' : ''}`;
          name.append(station);
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'lcars-button lcars-button--pill';
          btn.textContent = u.station === 'Operations' ? 'Call ops' : 'Call';
          btn.disabled = voice.state !== 'idle' || !!u.hologram;
          if (u.hologram) btn.title = 'a hologram: no comm badge';
          btn.onclick = () => voice.placeCall(u);
          const msgBtn = document.createElement('button');
          msgBtn.type = 'button';
          msgBtn.className = 'lcars-button lcars-button--pill comms-msg-pick';
          msgBtn.textContent = 'Msg';
          msgBtn.dataset.user = u.id;
          msgBtn.setAttribute('aria-pressed', String(recipients.has(u.id)));
          msgBtn.onclick = () => { if (recipients.has(u.id)) recipients.delete(u.id); else recipients.add(u.id); renderDirectory(); renderCompose(); };
          if (textBlocked) { msgBtn.disabled = true; msgBtn.title = textBlocked; }
          if (u.hologram) { msgBtn.disabled = true; msgBtn.title = 'a hologram: no comm badge'; }
          li.append(name, btn, msgBtn);
          ul.append(li);
          }
        }
      }
    }

    function renderCompose() {
      for (const id of [...recipients]) if (!users.some((u) => u.id === id)) recipients.delete(id); // gone
      const names = [...recipients].map((id) => users.find((u) => u.id === id)?.name).filter(Boolean);
      $('msg-to').textContent = textBlocked || (names.length ? `To ${names.join(', ')}` : 'Tap Msg by names to pick who to write to');
      $('msg-send').disabled = !names.length || !!textBlocked;
    }
    function renderMessages() {
      const ol = $('messages');
      ol.replaceChildren(...(messages.length ? messages.slice(-50).map((m) => {
        const li = document.createElement('li');
        const mine = m.from.id === me()?.id;
        const others = m.to.filter((t) => t.id !== me()?.id).map((t) => t.name);
        li.className = mine ? 'comms-msg--mine' : '';
        const head = document.createElement('small');
        head.textContent = `${new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${mine ? `to ${m.to.map((t) => t.title || t.name).join(', ')}` : `${m.from.title || m.from.name}${others.length ? ` to you, ${others.join(', ')}` : ''}`}`;
        const reply = document.createElement('button');
        reply.type = 'button';
        reply.className = 'lcars-button lcars-button--pill comms-reply';
        reply.textContent = 'Reply';
        reply.onclick = () => { recipients.clear(); for (const p of [m.from, ...m.to]) if (p.id !== me()?.id) recipients.add(p.id); renderDirectory(); renderCompose(); $('msg-text').focus(); };
        li.append(head, document.createTextNode(m.text), ...(mine ? [] : [reply]));
        return li;
      }) : [Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No messages' })]));
      ol.scrollTop = ol.scrollHeight;
    }
    $('msg-form').onsubmit = (e) => {
      e.preventDefault();
      const text = $('msg-text').value.trim();
      if (!text || !recipients.size) return;
      opts.send({ type: 'text', to: [...recipients], text });
      $('msg-text').value = '';
    };

    // No console power and no local RF: comms are offline (proximity only), nothing usable.
    function setOffline(reason) {
      dialog.toggleAttribute('data-offline', !!reason);
      $('comms-offline').hidden = !reason;
      $('comms-offline').textContent = reason || '';
    }

    // Text messages need a computer core online aboard: otherwise greyed, with the reason.
    let textBlocked = '';
    function setTextBlocked(reason) {
      if ((reason || '') === textBlocked) return;
      textBlocked = reason || '';
      renderDirectory(); renderCompose();
    }

    function setOps(online) {
      $('ops-status').textContent = online ? '' : 'Ops offline: no new off-ship communications. Calls in progress continue.';
    }

    async function handle(msg) {
      if (await voice.handle(msg)) return true;
      switch (msg.type) {
        case 'users':
          users = msg.users;
          hardLinks = msg.hardLinks || [];
          setOps(msg.ops);
          $('comms-net').textContent = msg.network?.length > 1 ? `Data network: ${msg.network.join(' · ')}` : '';
          renderDirectory();
          renderCompose();
          return true;
        case 'text':
          messages.push(msg);
          if (msg.from.id !== me()?.id) { opts.log(`message from ${msg.from.title || msg.from.name}: ${msg.text}`); if (!dialog.open) unread++; }
          renderMessages();
          renderButton();
          return true;
        case 'notice':
          opts.log(msg.text);
          $('notice').textContent = msg.text;
          voice.sys(msg.text);
          return true;
      }
      return false;
    }

    renderButton();
    renderMessages();
    renderCompose();
    return {
      handle,
      open,
      close,
      voice,
      radio,
      setOps,
      setTextBlocked,
      setOffline,
      get users() { return users; },
      get messages() { return messages.map((m) => ({ from: m.from.name, to: m.to.map((t) => t.name), text: m.text })); },
      get isOpen() { return dialog.open; },
      // Signed out: drop the call and the directory.
      reset(reason) {
        voice.end(reason);
        users = [];
        setOps(true);
        $('notice').textContent = '';
        renderDirectory();
        close();
      },
    };
  };
})();
