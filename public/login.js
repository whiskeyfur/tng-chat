// The login page: an account (a username and password, not a character's name).
// Log in, or register (the first account is the admin; after that, as Settings
// say: open, admin approval or closed). Then on to the consoles (or ?next=).
(function () {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const next = /^\/[\w/.-]*$/.test(params.get('next') || '') ? params.get('next') : './';
  const api = (what, body) => fetch(`${relay.http()}/api/account/${what}`, { method: body ? 'POST' : 'GET', credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
  let mode = location.hash === '#register' ? 'register' : 'login', info = { accounts: true, registration: 'approval' };
  const note = (text, kind = '') => { $('login-note').textContent = text; $('login-note').dataset.kind = kind; };
  function render() {
    const closed = info.accounts && info.registration === 'closed';
    if (closed && mode === 'register') mode = 'login';
    const tap = (m, text) => { const b = Object.assign(document.createElement('button'), { type: 'button', className: 'lcars-button tr-tap', textContent: text, id: `login-mode-${m}` }); b.setAttribute('aria-pressed', String(mode === m)); b.disabled = m === 'register' && closed; if (b.disabled) b.title = 'Registration is closed: ask an admin'; b.onclick = () => { mode = m; note(''); render(); }; return b; };
    $('login-mode').replaceChildren(pillBar('Account', [tap('login', 'Log in'), tap('register', 'Register')]));
    $('login-confirm').hidden = mode !== 'register';
    $('login-confirm').required = mode === 'register';
    $('login-password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    $('login-go').textContent = mode === 'register' ? 'Register' : 'Log in';
    $('login-first').hidden = info.accounts;
    document.querySelector('.lcars-header__title').textContent = mode === 'register' ? 'Register' : 'Log in';
    if (params.get('admin') && !$('login-note').textContent) note('The admin page needs an admin login', 'error');
  }
  $('login-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = { username: $('login-username').value.trim(), password: $('login-password').value };
    if (mode === 'register') body.confirm = $('login-confirm').value;
    $('login-go').disabled = true;
    try {
      const r = await api(mode, body);
      if (r.error) return note(r.error, 'error');
      if (r.pending) { note(`Registered: ${r.user.username} is awaiting approval by an admin`); mode = 'login'; return render(); }
      // (A page from another origin keeps the token to send the relay; here the cookie does.)
      if (r.token) { try { localStorage.setItem('stchat-session', r.token); } catch {} }
      note(`Logged in: ${r.user.username}`);
      location.href = next;
    } catch { note('Comm relay unreachable', 'error'); } finally { $('login-go').disabled = false; }
  };
  api('me').then((r) => {
    info = r;
    if (r.user && !params.get('admin')) { location.replace(next); return; }
    if (!r.accounts) mode = location.hash === '#login' ? 'login' : 'register';
    render();
  }).catch(() => { note('Comm relay unreachable', 'error'); render(); });
  render();
})();
