// One screen at a time: every console fits the window without page scrolling.
// Sidebar buttons with data-screen-tab="id" switch to the element with
// data-screen="id"; everything else with data-screen is hidden.
(function () {
  window.showScreen = function showScreen(id) {
    for (const s of document.querySelectorAll('[data-screen]')) s.hidden = s.dataset.screen !== id;
    for (const b of document.querySelectorAll('[data-screen-tab]')) {
      if (b.dataset.screenTab === id) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    window.dispatchEvent(new CustomEvent('screenchange', { detail: id }));
  };
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-screen-tab]');
    if (!tab) return;
    e.preventDefault();
    showScreen(tab.dataset.screenTab);
  });
})();
