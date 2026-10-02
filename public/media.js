// Media that works in every browser, Safari on iPads and iPhones included:
//  - getMic(): the microphone, or a clear refusal (no crash) where the page can't have one:
//    browsers give the microphone only to a secure page (https, or localhost), and an iPad on
//    the LAN over plain http has no navigator.mediaDevices at all;
//  - playRemote(el, stream): a call's or the room's audio, played inline; when the browser
//    won't start it without a tap (Safari's autoplay rule), it starts on the next tap or key.
(function () {
  const waiting = new Set();
  window.getMic = () => (navigator.mediaDevices?.getUserMedia
    ? navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    : Promise.reject(Object.assign(new Error('this page needs https (or localhost) for a microphone'), { name: window.isSecureContext ? 'NotSupportedError' : 'needs https' })));
  window.playRemote = (el, stream) => {
    el.autoplay = true;
    el.setAttribute('playsinline', '');
    el.srcObject = stream;
    const p = el.play?.();
    if (p?.catch) p.catch(() => waiting.add(el));
  };
  const resume = () => { for (const el of [...waiting]) el.play().then(() => waiting.delete(el)).catch(() => {}); };
  for (const t of ['pointerdown', 'touchend', 'keydown']) document.addEventListener(t, resume, true);
  window.__media = { get waiting() { return waiting.size; } };
})();
