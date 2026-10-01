// The Library screen: the ship's computer. Lists the files uploaded to your
// ship (data/<ship>/ on the server) and, across data links, the libraries of
// every ship on your data network, each in its own folder. Anyone can upload
// to their own ship's library and download from any listed library.
//
// const library = createLibrary(container, { token, base, log });  // base(): relay HTTP base
// library.render(msg)   // a 'library' message from the server
(function () {
  const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

  window.createLibrary = function createLibrary(container, opts) {
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
            xhr.open('POST', `${opts.base()}/api/library`);
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
        const res = await fetch(`${opts.base()}/api/library/${encodeURIComponent(ship)}/${encodeURIComponent(name)}`, { headers: { 'X-Token': opts.token() } });
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

    function render(msg) {
      folders.replaceChildren();
      for (const ship of msg.ships) {
        const rows = ship.files.map((f) => el('li', { className: 'lib-file-row' },
          el('span', { className: 'lib-name', textContent: f.name }),
          el('span', { className: 'lib-size', textContent: fmtSize(f.size) }),
          el('span', { className: 'lib-date', textContent: new Date(f.modified).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) }),
          (() => { const b = el('button', { className: 'lcars-button lcars-button--pill', type: 'button', textContent: 'Download' }); b.onclick = () => download(ship.name, f.name, b); return b; })()));
        const folder = el('div', { className: 'lib-folder' },
          el('h3', { className: `comms-ship lib-folder-name${ship.own ? ' comms-ship--home' : ''}`, textContent: ship.own ? `${ship.name} · this ship` : `${ship.name} · data link` }),
          el('ul', { className: 'lib-files' }, ...(rows.length ? rows : [el('li', { className: 'empty', textContent: 'No files' })])));
        folder.dataset.ship = ship.name;
        folders.append(folder);
      }
    }

    return { render };
  };
})();
