// The console's link to the relay: a WebSocket, or, when that can't connect (a proxy or
// network that won't pass it), plain HTTP: long polling, messages POSTed and a GET held
// open for what comes back (server.js, /api/poll). The two look the same to the console:
// send(text), close(), onopen, onmessage({ data }), onclose({ code }), readyState, kind.
(function () {
  class PollLink {
    constructor(base) { Object.assign(this, { base, kind: 'http', readyState: 0, out: [], sending: false, id: null }); this.open(); }
    async open() {
      try {
        const r = await fetch(`${this.base}/api/poll/open`, { method: 'POST', credentials: 'include' });
        if (!r.ok) return this.end(r.status === 401 ? 4401 : 1006);
        this.id = (await r.json()).id;
        this.readyState = 1;
        this.onopen?.();
        this.loop();
      } catch { this.end(1006); }
    }
    async loop() {
      while (this.readyState === 1) {
        try {
          const r = await fetch(`${this.base}/api/poll/recv?id=${this.id}`, { credentials: 'include', cache: 'no-store' });
          const v = await r.json();
          for (const m of v.messages || []) this.onmessage?.({ data: m });
          if (v.closed != null || r.status === 410) return this.end(v.closed ?? 1001);
        } catch { return this.end(1006); }
      }
    }
    send(data) { if (this.readyState !== 1) return; this.out.push(data); this.flush(); }
    async flush() {
      if (this.sending || !this.out.length || this.readyState !== 1) return;
      this.sending = true;
      const batch = this.out.splice(0);
      try {
        const r = await fetch(`${this.base}/api/poll/send?id=${this.id}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) });
        if (r.status === 410) { const v = await r.json().catch(() => ({})); this.end(v.closed ?? 1001); }
      } catch { this.end(1006); }
      this.sending = false;
      this.flush();
    }
    close() {
      if (this.readyState === 1) fetch(`${this.base}/api/poll/close?id=${this.id}`, { method: 'POST', credentials: 'include', keepalive: true }).catch(() => {});
      this.end(1000);
    }
    end(code) { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code }); }
  }
  // A WebSocket that fails before it opens (or hasn't in 5 s) three times running: HTTP from then
  // on, for this page. (?transport=http starts on HTTP.)
  let fails = 0, http = new URLSearchParams(location.search).get('transport') === 'http';
  window.relayLink = function relayLink(wsUrl, httpBase) {
    if (http) return new PollLink(httpBase);
    const ws = new WebSocket(wsUrl);
    ws.kind = 'ws';
    let opened = false;
    const timer = setTimeout(() => { if (!opened) ws.close(); }, 5000);
    ws.addEventListener('open', () => { opened = true; fails = 0; clearTimeout(timer); });
    ws.addEventListener('close', () => { clearTimeout(timer); if (!opened && ++fails >= 3) http = true; });
    return ws;
  };
  // While on HTTP: does a WebSocket get through now? (yes: onOk)
  window.relayLink.probe = (wsUrl, onOk) => {
    let t;
    try { t = new WebSocket(wsUrl); } catch { return; }
    const done = () => { try { t.close(); } catch {} };
    t.onopen = () => { done(); onOk(); };
    t.onerror = done;
    setTimeout(done, 5000);
  };
})();
