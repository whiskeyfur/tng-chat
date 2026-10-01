// Subspace radio, in the Comms modal: find an internet radio station (the
// free, community-run Radio Browser directory, radio-browser.info) or tune a
// stream URL, listen locally, and patch it into the call you're in so
// everyone hears it (voice.setRadio mixes it with your mic).
//
// Patching needs the station's server to allow cross-site access (CORS); many
// Icecast servers do. Stations that don't still play locally, but can't be
// patched in. Pages served over https can only play https streams.
//
// Communications and ops can also put the station on the ship's radio (every
// console aboard plays it) or the fleet's (the whole data network).
//
// const radio = createRadio(container, { voice, log, send, canShipRadio });
// radio.render()   // call state changed
(function () {
  const DIRECTORY = ['de1', 'fi1', 'nl1'].map((h) => `https://${h}.api.radio-browser.info`);
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

  window.createRadio = function createRadio(root, { voice, log, send, canShipRadio = () => false }) {
    const q = el('input', { className: 'ops-input', id: 'radio-q', placeholder: 'Station name or genre', autocomplete: 'off', ariaLabel: 'search radio stations' });
    const url = el('input', { className: 'ops-input', id: 'radio-url', placeholder: 'or a stream URL', autocomplete: 'off', ariaLabel: 'radio stream URL' });
    const btn = (text, id, cls = '') => el('button', { type: 'submit', className: `lcars-button lcars-button--pill ${cls}`, id, textContent: text });
    const search = el('form', { className: 'ops-form radio-form' }, q, btn('Search', 'radio-search'));
    const tune = el('form', { className: 'ops-form radio-form' }, url, btn('Tune', 'radio-tune'));
    const results = el('ul', { className: 'radio-results', id: 'radio-results' });
    const title = el('span', { className: 'radio-title', id: 'radio-title' });
    const stop = el('button', { type: 'button', className: 'lcars-button lcars-button--pill lcars-button--alert', id: 'radio-stop', textContent: 'Stop' });
    const patch = el('button', { type: 'button', className: 'lcars-button lcars-button--pill', id: 'radio-patch', textContent: 'Patch into call' });
    const onShip = el('button', { type: 'button', className: 'lcars-button lcars-button--pill', id: 'radio-ship', textContent: "Ship's radio" });
    const onFleet = el('button', { type: 'button', className: 'lcars-button lcars-button--pill', id: 'radio-fleet', textContent: 'Fleet radio' });
    const now = el('div', { className: 'radio-now', hidden: true }, title, patch, onShip, onFleet, stop);
    const off = el('button', { type: 'button', className: 'lcars-button lcars-button--pill lcars-button--alert', id: 'radio-off', textContent: "Ship's radio off" });
    const status = el('p', { className: 'ops-notice', id: 'radio-status' });
    root.replaceChildren(now, status, search, tune, results, el('div', { className: 'radio-ship-ctl' }, off));
    const toShip = (scope) => {
      if (!current) return;
      send({ type: 'ship-radio', url: current.url, name: current.name, scope });
      status.textContent = scope === 'network' ? `${current.name} is on the fleet's radio` : `${current.name} is on the ship's radio`;
      stopPlaying(); // the ship's radio plays it now
      render();
    };
    onShip.onclick = () => toShip('ship');
    onFleet.onclick = () => toShip('network');
    off.onclick = () => { send({ type: 'ship-radio', url: null, scope: 'network' }); status.textContent = "Ship's radio switched off"; };

    // The station playing now. With CORS, it goes through Web Audio so it can
    // be both heard here and sent into a call.
    let current = null; // { name, url, audio, ctx, dest, cors }

    function stopPlaying() {
      if (!current) return;
      if (voice.radioPatched) voice.setRadio(null);
      current.audio.pause();
      current.audio.removeAttribute('src');
      current.audio.load();
      current.ctx?.close().catch(() => {});
      current = null;
    }

    function play(name, streamUrl) {
      stopPlaying();
      if (location.protocol === 'https:' && streamUrl.startsWith('http:')) {
        status.textContent = `${name}: this page is https, so it can only play https streams`;
        return;
      }
      const start = (cors) => {
        const audio = new Audio();
        if (cors) audio.crossOrigin = 'anonymous';
        audio.src = streamUrl;
        const station = { name, url: streamUrl, audio, cors };
        current = station;
        audio.onerror = () => {
          if (current !== station) return;
          if (cors) { station.ctx?.close().catch(() => {}); start(false); return; } // try again, local only
          status.textContent = `${name}: no signal (the stream could not be played)`;
          current = null;
          render();
        };
        audio.onplaying = () => {
          if (current !== station) return;
          status.textContent = cors ? '' : `${name} plays here only: the station does not allow patching into calls`;
          render();
        };
        if (cors) {
          station.ctx = new AudioContext();
          const src = station.ctx.createMediaElementSource(audio);
          src.connect(station.ctx.destination);
          station.dest = station.ctx.createMediaStreamDestination();
          src.connect(station.dest);
          station.ctx.resume().catch(() => {});
        }
        audio.play().catch(() => {});
        status.textContent = `Tuning ${name}...`;
        render();
      };
      start(true);
      log?.(`subspace radio: ${name}`);
    }

    async function find(text) {
      results.replaceChildren(el('li', { className: 'empty', textContent: 'Scanning subspace frequencies...' }));
      const params = new URLSearchParams({ limit: '12', hidebroken: 'true', order: 'clickcount', reverse: 'true' });
      if (location.protocol === 'https:') params.set('is_https', 'true');
      let stations = null;
      for (const host of DIRECTORY) {
        try {
          const get = async (field) => (await fetch(`${host}/json/stations/search?${field}=${encodeURIComponent(text)}&${params}`)).json();
          stations = await get('name');
          if (stations.length < 4) stations = [...stations, ...(await get('tag'))].slice(0, 12);
          break;
        } catch { /* try the next directory server */ }
      }
      if (!stations) { results.replaceChildren(el('li', { className: 'empty', textContent: 'The station directory is not answering' })); return; }
      if (!stations.length) { results.replaceChildren(el('li', { className: 'empty', textContent: 'No stations found' })); return; }
      results.replaceChildren(...stations.map((s) => {
        const b = el('button', { type: 'button', className: 'lcars-button lcars-button--pill', textContent: 'Play' });
        b.onclick = () => play(s.name.trim(), s.url_resolved || s.url);
        const info = [s.countrycode, s.codec, s.bitrate ? `${s.bitrate} kbps` : '', (s.tags || '').split(',').slice(0, 2).join(' ')].filter(Boolean).join(' · ');
        return el('li', {}, el('span', { className: 'radio-name', textContent: s.name.trim() }), el('small', { textContent: info }), b);
      }));
    }

    search.onsubmit = (e) => { e.preventDefault(); if (q.value.trim()) find(q.value.trim()); };
    tune.onsubmit = (e) => {
      e.preventDefault();
      const u = url.value.trim();
      if (!/^https?:\/\//i.test(u)) { status.textContent = 'Enter a stream URL starting with http:// or https://'; return; }
      play(u.replace(/^https?:\/\//i, '').split(/[/?#]/)[0], u);
    };
    stop.onclick = () => { stopPlaying(); status.textContent = ''; render(); };
    patch.onclick = async () => {
      if (!current?.dest) return;
      patch.disabled = true;
      if (voice.radioPatched) await voice.setRadio(null);
      else await voice.setRadio(current.dest.stream, current.name);
      render();
    };

    function render() {
      const can = canShipRadio();
      onShip.hidden = onFleet.hidden = !can;
      off.parentElement.hidden = !can;
      now.hidden = !current;
      if (!current) return;
      title.textContent = `On air: ${current.name}`;
      patch.textContent = voice.radioPatched ? 'Unpatch from call' : 'Patch into call';
      patch.disabled = !current.dest || (voice.state !== 'in-call' && !voice.radioPatched);
      patch.title = !current.dest ? 'This station does not allow patching into calls' : voice.state !== 'in-call' ? 'Patch in during a call' : '';
    }

    render();
    return {
      render,
      get playing() { return current?.name || null; },
      get canPatch() { return !!current?.dest; },
    };
  };
})();
