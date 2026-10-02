// One screen at a time: every console fits the window without page scrolling.
// Sidebar buttons with data-screen-tab="id" switch to the element with
// data-screen="id"; everything else with data-screen is hidden.
(function () {
  // The left pane (the sidebar's left column: Room mic, Comms, Console log, Library, Station)
  // slides in beside the station screen; a station screen (the right column) closes it.
  const pane = () => document.getElementById('left-pane');
  const inPane = (el) => !!el?.closest('#left-pane');
  let slideTimer = null;
  const slide = () => { document.body.classList.add('pane-moving'); clearTimeout(slideTimer); slideTimer = setTimeout(() => document.body.classList.remove('pane-moving'), 300); };
  window.closePane = function closePane() {
    if (!document.body.dataset.pane) return;
    slide();
    for (const s of pane()?.querySelectorAll('[data-screen]') || []) s.hidden = true;
    const c = document.getElementById('comms');
    if (c?.open && inPane(c)) c.close();
    delete document.body.dataset.pane;
    for (const b of document.querySelectorAll('.lcars-sidebar__col--left [aria-current]')) b.removeAttribute('aria-current');
    window.dispatchEvent(new CustomEvent('screenchange', { detail: shownMain() }));
  };
  // (The pane shows one thing: a screen, or Comms.)
  window.openPane = function openPane(id) {
    if (!document.body.dataset.pane) slide();
    for (const s of pane()?.querySelectorAll('[data-screen]') || []) s.hidden = s.dataset.screen !== id;
    const c = document.getElementById('comms');
    if (id !== 'comms' && c?.open && inPane(c)) c.close();
    document.body.dataset.pane = id;
    for (const b of document.querySelectorAll('.lcars-sidebar__col--left button')) {
      if ((b.dataset.screenTab || (b.id === 'comms-button' ? 'comms' : b.id === 'room-mic' ? 'room' : '')) === id) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    window.dispatchEvent(new CustomEvent('screenchange', { detail: id }));
  };
  const shownMain = () => [...document.querySelectorAll('[data-screen]')].find((x) => !x.hidden && !inPane(x))?.dataset.screen;
  window.showScreen = function showScreen(id) {
    const target = document.querySelector(`[data-screen="${CSS.escape(id)}"]`);
    if (inPane(target)) return openPane(id);
    for (const s of document.querySelectorAll('[data-screen]')) if (!inPane(s)) s.hidden = s.dataset.screen !== id;
    for (const b of document.querySelectorAll('.lcars-sidebar__col--right [data-screen-tab], #ops-view [data-screen-tab]')) {
      if (b.dataset.screenTab === id) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    if (document.body.dataset.pane) closePane();
    window.dispatchEvent(new CustomEvent('screenchange', { detail: id }));
  };
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-screen-tab]');
    if (!tab) return;
    e.preventDefault();
    // (A left-column tab already open: closes the pane.)
    if (inPane(document.querySelector(`[data-screen="${CSS.escape(tab.dataset.screenTab)}"]`)) && document.body.dataset.pane === tab.dataset.screenTab) return closePane();
    showScreen(tab.dataset.screenTab);
  });
})();

// The shared LCARS controls (styled in lcars.css):
// a pill bar, (] [LABEL] [tap] [tap] [)  (with no label: a right-capped cluster);
// a pill cluster, a few buttons rounded only at the ends; a capsule, a closed
// frame for a critical monitor, [( contents )].
window.pillBar = function pillBar(label, taps, { id, groupId, accent } = {}) {
  const bar = document.createElement('div');
  bar.className = label ? 'tr-pick' : 'tr-pick tr-pick--right';
  if (id) bar.id = id;
  if (accent) bar.style.setProperty('--accent', accent);
  const group = Object.assign(document.createElement('div'), { className: 'tr-taps' });
  group.setAttribute('role', 'group');
  if (label) group.setAttribute('aria-label', label);
  if (groupId) group.id = groupId;
  group.append(...taps.filter(Boolean));
  if (label) bar.append(Object.assign(document.createElement('span'), { className: 'tr-label', textContent: label }));
  bar.append(group);
  return bar;
};
window.pillCluster = function pillCluster(...buttons) {
  const c = Object.assign(document.createElement('span'), { className: 'pill-cluster' });
  c.append(...buttons.filter(Boolean));
  return c;
};
window.capsule = function capsule(body, { id } = {}) {
  const c = Object.assign(document.createElement('div'), { className: 'capsule' });
  if (id) c.id = id;
  body.classList.add('capsule-body');
  c.append(Object.assign(document.createElement('span'), { className: 'capsule-cap capsule-cap--l' }), body, Object.assign(document.createElement('span'), { className: 'capsule-cap capsule-cap--r' }));
  return c;
};

// Sidebar labels never clip: a label wider than its button (a long word in a narrow
// column) shrinks a pixel at a time, down to 9px; its full text is its title too.
(function () {
  const fit = () => {
    for (const b of document.querySelectorAll('.lcars-nav-button')) {
      if (!b.offsetParent) continue;
      b.style.fontSize = '';
      b.title = b.textContent.trim();
      let size = parseFloat(getComputedStyle(b).fontSize);
      while (b.scrollWidth > b.clientWidth + 1 && size > 9) b.style.fontSize = `${--size}px`;
    }
  };
  let queued = false;
  const later = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; fit(); }); } };
  window.addEventListener('resize', later);
  window.addEventListener('screenchange', later);
  const start = () => {
    later();
    for (const s of document.querySelectorAll('.lcars-sidebar')) new MutationObserver(later).observe(s, { childList: true, subtree: true, characterData: true, attributeFilter: ['hidden'] });
    document.fonts?.ready.then(later);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
