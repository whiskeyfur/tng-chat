// The Library screen: the ship's computer. Lists the files uploaded to your
// ship (kept by its ship's computers, tools/shipcore.js) and, across data links, the libraries of
// every ship on your data network, each in its own folder. Anyone can upload
// to their own ship's library and download from any listed library; ops can
// delete files from their own ship's library.
//
// const library = createLibrary(container, { token, base, log, canDelete });
//   base(): relay HTTP base ('' = this server); canDelete(ship): show Delete
// library.render(msg)   // a 'library' message from the server
(function () {
  const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

  window.createLibrary = function createLibrary(container, opts) {
    const base = () => (typeof opts.base === 'function' ? opts.base() : '') || '';
    const status = el('p', { className: 'ops-notice lib-status', role: 'status' });
    const file = el('input', { type: 'file', multiple: true, className: 'lib-file', ariaLabel: 'files to upload' });
    const upload = el('button', { className: 'lcars-button lcars-button--pill', textContent: 'Upload' });
    const form = el('form', { className: 'ops-form lib-upload' }, el('span', { className: 'lib-upload-label', textContent: 'Upload to the ship’s computer' }), file, upload);
    const folders = el('div', { className: 'lib-folders' });
    const panel = el('section', { className: 'lcars-panel lib-panel', style: '--accent: var(--lcars-violet)' },
      el('h2', { className: 'lcars-panel__title' }, el('span', { textContent: 'Library · ship’s computer' })),
      el('div', { className: 'lcars-panel__body' }, form, status, folders));
    container.replaceChildren(panel);

    // Uploads use XHR for progress; one file at a time.
    form.onsubmit = async (e) => {
      e.preventDefault();
      const files = [...file.files];
      if (!files.length) return;
      upload.disabled = true;
      for (const f of files) {
        try {
          await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${base()}/api/library`);
            xhr.setRequestHeader('X-Token', opts.token());
            xhr.setRequestHeader('X-Filename', encodeURIComponent(f.name));
            xhr.upload.onprogress = (p) => { if (p.lengthComputable) status.textContent = `Uploading ${f.name}: ${Math.round((p.loaded / p.total) * 100)}%`; };
            xhr.onload = () => (xhr.status === 200 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(xhr.responseText || `error ${xhr.status}`)));
            xhr.onerror = () => reject(new Error('connection lost'));
            xhr.send(f);
          }).then((r) => { status.textContent = `Uploaded ${r.name} (${fmtSize(r.size)})`; opts.log?.(`uploaded ${r.name} to the library`); });
        } catch (err) {
          status.textContent = `Upload of ${f.name} failed: ${err.message}`;
        }
      }
      file.value = '';
      upload.disabled = false;
    };

    async function download(ship, name, button) {
      button.disabled = true;
      status.textContent = `Downloading ${name}...`;
      try {
        const res = await fetch(`${base()}/api/library/${encodeURIComponent(ship)}/${encodeURIComponent(name)}`, { headers: { 'X-Token': opts.token() } });
        if (!res.ok) throw new Error(await res.text());
        const url = URL.createObjectURL(await res.blob());
        const a = el('a', { href: url, download: name });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        status.textContent = `Downloaded ${name}`;
      } catch (err) {
        status.textContent = `Download of ${name} failed: ${err.message}`;
      }
      button.disabled = false;
    }

    async function remove(ship, name, button) {
      if (!confirm(`Delete ${name} from the ${ship} library? This cannot be undone.`)) return;
      button.disabled = true;
      try {
        const res = await fetch(`${base()}/api/library/${encodeURIComponent(ship)}/${encodeURIComponent(name)}`, { method: 'DELETE', headers: { 'X-Token': opts.token() } });
        if (!res.ok) throw new Error(await res.text());
        status.textContent = `Deleted ${name}`;
        opts.log?.(`deleted ${name} from the library`);
      } catch (err) {
        status.textContent = `Delete of ${name} failed: ${err.message}`;
        button.disabled = false;
      }
    }

    function render(msg) {
      folders.replaceChildren();
      const own = msg.ships.find((s) => s.own);
      upload.disabled = own?.online === false;
      if (own?.online === false) status.textContent = "The ship's computer is offline: the library is unavailable until it's back online";
      else if (status.textContent.startsWith("The ship's computer is offline")) status.textContent = '';
      for (const ship of msg.ships) {
        const rows = ship.files.map((f) => el('li', { className: 'lib-file-row' },
          el('span', { className: 'lib-name', textContent: f.name }),
          el('span', { className: 'lib-size', textContent: fmtSize(f.size) }),
          el('span', { className: 'lib-date', textContent: new Date(f.modified).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) }),
          el('span', { className: 'lib-actions' },
            (() => { const b = el('button', { className: 'lcars-button lcars-button--pill', type: 'button', textContent: 'Download' }); b.onclick = () => download(ship.name, f.name, b); return b; })(),
            opts.canDelete?.(ship) ? (() => { const b = el('button', { className: 'lcars-button lcars-button--pill lcars-button--alert', type: 'button', textContent: 'Delete' }); b.onclick = () => remove(ship.name, f.name, b); return b; })() : '')));
        const folder = el('div', { className: 'lib-folder' },
          el('h3', { className: `comms-ship lib-folder-name${ship.own ? ' comms-ship--home' : ''}`, textContent: `${ship.name} · ${ship.own ? 'this ship' : 'data link'}${ship.online === false ? " · computer offline" : ''}` }),
          el('ul', { className: 'lib-files' }, ...(rows.length ? rows : [el('li', { className: 'empty', textContent: ship.online === false ? "Ship's computer offline" : 'No files' })])));
        folder.dataset.ship = ship.name;
        folders.append(folder);
      }
    }

    return { render };
  };
})();
