// Signals (wish list: radio frequencies): every hail, call and data link between vessels is carried
// on a channel, and what a receiver makes of it comes from where the two are and how they move:
// - its bearing, from the receiver to the transmitter;
// - its strength, falling with the square of the distance across the radio's range, scaled by the
//   power the transmitter's radio has;
// - its phase offset, from the Doppler shift of their closing speed;
// - its interference, the other signals on nearby channels the receiver hears too.
// A Communications officer cleans a signal up on the comms stage before routing it: an RF filter
// tuned to its channel takes out the interference, a phase shifter set against its offset takes out
// the phase error, and the waveform matcher (its frequency, amplitude and phase matched to the
// signal's) takes out the noise. Routing needs QUALITY_TO_ROUTE.
const CHANNELS = { min: 100, max: 999 };
// Encryption: what a transmission can be enciphered with, and how hard each is to break without its
// key (a listener's computer cores at it: strength x a minute, a core). Every Federation vessel holds
// the Starfleet key; a vessel's own (private:<its name>) only it, and whoever it shares it with over
// a data link.
const CIPHERS = { starfleet: { name: 'Starfleet standard', strength: 1 }, private: { name: 'Private', strength: 5 } };
const cipherOf = (id) => (id ? CIPHERS[String(id).split(':')[0]] || null : null);
const cipherName = (id) => (!id ? 'none' : id.startsWith('private:') ? `private (${id.slice(8)})` : cipherOf(id)?.name || id);
const QUALITY_TO_ROUTE = 0.6;

// A vessel's own channel to start with: from its name (the same every time; a ship's registry, if you
// like), until Communications retunes it.
function homeChannel(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CHANNELS.min + (h % (CHANNELS.max - CHANNELS.min + 1));
}
const clampChannel = (n) => Math.max(CHANNELS.min, Math.min(CHANNELS.max, Math.round(Number(n) || 0)));

// What a receiver at rx makes of a transmitter at tx: { bearing (degrees, 0 = north, clockwise),
// distance, strength (0..1), phase (the Doppler offset, degrees, -180..180) }. Positions { x, y };
// velocities { vx, vy } in units a second; range: how far the radios reach; power: the transmitter's
// radio power, 0..1.
function seen(rx, tx, { range, power = 1 }) {
  const dx = tx.x - rx.x, dy = tx.y - rx.y, distance = Math.hypot(dx, dy);
  const bearing = Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360);
  const strength = Math.max(0, Math.min(1, power * (1 - (distance / range) ** 2)));
  // (Closing speed along the line between them: the Doppler shift, as a phase offset.)
  const ux = distance ? dx / distance : 0, uy = distance ? dy / distance : 0;
  const closing = ((rx.vx || 0) - (tx.vx || 0)) * ux + ((rx.vy || 0) - (tx.vy || 0)) * uy;
  const phase = Math.round(((((closing * 40) % 360) + 540) % 360) - 180);
  return { bearing, distance: Math.round(distance), strength: Math.round(strength * 1000) / 1000, phase };
}

// The interference on a channel at a receiver: the other signals it hears within 3 channels, weighted
// by how close their channel is and how strong they are.
function interference(channel, others) {
  return Math.min(1, others.reduce((n, o) => { const d = Math.abs(o.channel - channel); return d > 3 ? n : n + o.strength * (1 - d / 4); }, 0));
}

// How good the signal is through a chain of modules: { quality (0..1), parts }. chain: [{ type:
// 'filter', channel } | { type: 'phase', shift } | { type: 'wave', frequency, amplitude, phase }], in
// order. A filter on the signal's own channel removes the interference; a phase shifter turns the
// offset by its shift; the waveform matcher removes the noise as closely as it matches.
function quality(signal, chain = []) {
  let interf = signal.interference || 0, phaseErr = Math.abs(signal.phase || 0), noise = 1 - signal.strength;
  // (Enciphered: nothing but noise until a decryptor with its key is in the chain.)
  if (signal.cipher && !chain.some((m) => m.type === 'decrypt' && m.cipher === signal.cipher)) return { quality: 0, parts: { strength: signal.strength, interference: interf, phaseError: phaseErr, noise: 1, encrypted: signal.cipher } };
  for (const m of chain) {
    if (m.type === 'filter' && m.channel === signal.channel) interf = 0;
    if (m.type === 'phase') phaseErr = Math.abs(((((signal.phase || 0) - (m.shift || 0)) % 360) + 540) % 360 - 180);
    if (m.type === 'wave') noise *= 1 - waveMatch(signal, m);
  }
  const q = signal.strength * (1 - interf) * (1 - phaseErr / 180) * (1 - noise * 0.5);
  return { quality: Math.max(0, Math.min(1, Math.round(q * 1000) / 1000)), parts: { strength: signal.strength, interference: interf, phaseError: phaseErr, noise: Math.round(noise * 1000) / 1000 } };
}
// The waveform the signal shows (the blue one): its frequency (1-9 cycles across the scope, from its
// channel), amplitude (1-9, from its strength) and phase (its offset, in 15° steps). How well a
// matcher's settings match it, 0..1.
const waveOf = (signal) => ({ frequency: 1 + (signal.channel % 9), amplitude: Math.max(1, Math.min(9, Math.round(signal.strength * 9))), phase: Math.round((signal.phase || 0) / 15) * 15 });
function waveMatch(signal, m) {
  const w = waveOf(signal);
  const df = Math.abs((m.frequency || 0) - w.frequency) / 8, da = Math.abs((m.amplitude || 0) - w.amplitude) / 8, dp = Math.abs(((((m.phase || 0) - w.phase) % 360) + 540) % 360 - 180) / 180;
  return Math.max(0, 1 - (df * 0.5 + da * 0.25 + dp * 0.25) * 2);
}
// The best chain for a signal (what the computer does when it's automated, or Ops routes it).
const bestChain = (signal) => [...(signal.cipher ? [{ type: 'decrypt', cipher: signal.cipher }] : []), { type: 'filter', channel: signal.channel }, { type: 'phase', shift: signal.phase || 0 }, { type: 'wave', ...waveOf(signal) }];

const SIGNALS = { CHANNELS, CIPHERS, cipherOf, cipherName, QUALITY_TO_ROUTE, homeChannel, clampChannel, seen, interference, quality, waveOf, waveMatch, bestChain };
// (The relay's, and the comms stage's in the browser: /shared/signals.js, the same reckoning both ends.)
if (typeof module !== 'undefined' && module.exports) module.exports = SIGNALS; else window.SIGNALS = SIGNALS;
