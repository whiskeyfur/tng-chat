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
      <p class="lcars-note" id="ops-status"></p>
      <p class="ops-notice" id="notice"></p>
      <div class="ops-call" id="call"></div>
      <div id="comms-extras"></div>
      <h3 class="ops-subhead">Directory</h3>
      <ul class="comms-dir" id="users"></ul>
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
    let prev = 'idle';
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
        opts.onChange?.(state);
      },
    });

    function open() {
      if (!dialog.open) dialog.showModal();
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
      opts.button.querySelector('span').textContent = label;
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
          textContent: isHome ? `Aboard the ${ship}` : `The ${ship} · data link`,
        }));
        const crew = others.filter((u) => u.ship === ship)
          .sort((a, b) => (b.station === 'Operations') - (a.station === 'Operations') || a.name.localeCompare(b.name));
        for (const u of crew) {
          const li = document.createElement('li');
          li.className = 'comms-entry';
          const name = document.createElement('span');
          name.textContent = u.name;
          const station = document.createElement('small');
          station.textContent = isHome ? u.station : `${u.station}, ${u.ship}`;
          name.append(station);
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'lcars-button lcars-button--pill';
          btn.textContent = u.station === 'Operations' ? 'Call ops' : 'Call';
          btn.disabled = voice.state !== 'idle';
          btn.onclick = () => voice.placeCall(u);
          li.append(name, btn);
          ul.append(li);
        }
      }
    }

    function setOps(online) {
      $('ops-status').textContent = online ? '' : 'Ops offline: no new off-ship communications. Calls in progress continue.';
    }

    async function handle(msg) {
      if (await voice.handle(msg)) return true;
      switch (msg.type) {
        case 'users':
          users = msg.users;
          setOps(msg.ops);
          $('comms-net').textContent = msg.network?.length > 1 ? `Data network: ${msg.network.join(' · ')}` : '';
          renderDirectory();
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
    return {
      handle,
      open,
      close,
      voice,
      setOps,
      get users() { return users; },
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
