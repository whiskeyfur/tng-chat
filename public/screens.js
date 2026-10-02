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
