// Where the comm relay (server.js) is. By default it's the server that served
// this page. When the pages are hosted elsewhere, such as GitHub Pages, point
// them at a relay with, in order of preference:
//   ?relay=wss://relay.example.com   in the URL
//   the "Comm relay" field on the sign-in screen (remembered in this browser)
//   window.STCHAT_RELAY in config.js (set when deploying)
// Pages served over https need a wss:// relay (or one on localhost).
(function () {
  const KEY = 'stchat-relay';
  const params = new URLSearchParams(location.search);

  // Accept "host:port", "http(s)://..." or "ws(s)://..."; return a ws(s) URL.
  function normalize(addr) {
    addr = String(addr || '').trim();
    if (!addr) return null;
    if (!/^[a-z]+:\/\//i.test(addr)) addr = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${addr}`;
    try {
      const u = new URL(addr);
      if (u.protocol === 'http:') u.protocol = 'ws:';
      if (u.protocol === 'https:') u.protocol = 'wss:';
      if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
      return u;
    } catch {
      return null;
    }
  }

  function stored() {
    try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
  }

  // Static hosts (GitHub Pages) never run the relay themselves, so there the
  // address stays blank until someone enters one.
  const staticHost = /\.github\.io$/i.test(location.hostname) || location.protocol === 'file:';

  function current() {
    return normalize(params.get('relay')) || normalize(stored()) || normalize(window.STCHAT_RELAY)
      || (staticHost ? null : normalize(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`));
  }

  window.relay = {
    // WebSocket URL for signaling.
    ws: () => current()?.href.replace(/\/$/, '') ?? '',
    // HTTP base for the library endpoints.
    http: () => {
      const u = current();
      if (!u) return '';
      return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}${u.pathname.replace(/\/$/, '')}`;
    },
    // What to show in the "Comm relay" field.
    address: () => current()?.href.replace(/\/$/, '') ?? '',
    // Remember a relay for this browser (empty clears it). Returns false if invalid.
    set(addr) {
      if (addr && !normalize(addr)) return false;
      try { if (addr) localStorage.setItem(KEY, addr.trim()); else localStorage.removeItem(KEY); } catch {}
      if (params.has('relay')) { params.delete('relay'); history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`); }
      return true;
    },
  };
})();
