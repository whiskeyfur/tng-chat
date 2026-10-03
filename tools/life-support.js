// Life support (wish list 1; docs/ship-graph.md), from a vessel's graph: each place's own air, the
// crew breathing it, the ventilation between places, and what turns carbon dioxide and water back
// into air. Not in play yet: like heat, a step the relay will run each tick after the power solve.
//
// Each step of dt seconds (times speed: the admin's setting, 1 for real time):
// - The crew in each place breathe its oxygen and give off carbon dioxide and water vapour; they drink
//   from the water tank, and what they don't breathe out goes to the reclaimer as waste.
// - The air handler (the atmosphere system's power) mixes each place's air toward the others'.
// - The CO2 scrubber (the same power) takes carbon dioxide out of the air: oxygen to its tank, carbon
//   to the store. The water reclaimer takes the humidity over the comfortable level and the waste back
//   to the water tank, 93% of it. Hydroponics (the lighting's power) turns carbon dioxide and water into
//   oxygen for the air and biomass.
// - The regulator (the air handler) tops each place's oxygen and nitrogen up from the tanks to the air
//   it keeps (21 kPa of oxygen, 79 of nitrogen).
// Each runs at the share of its power the solve gave it (0 to 1). What a place is short of is said:
// carbon dioxide over 1 kPa a warning, over 4 kPa danger; oxygen under 16 kPa a warning, under 12 danger.
const GRAPH = require('./ship-graph');

const R = 8.314, MOLAR = { o2: 0.032, n2: 0.028, co2: 0.044, h2o: 0.018 }, GASES = Object.keys(MOLAR);
const lib = () => require('./config').systemTypes().lifeSupport;
// A gas's pressure (kPa) from its mass (kg) in a volume (m³), and the mass for a pressure.
const kPa = (gas, kg, volume, T) => (kg / MOLAR[gas]) * R * T / volume / 1000;
const kgFor = (gas, p, volume, T) => (p * 1000 * volume) / (R * T) * MOLAR[gas];

// A new vessel's life support: every place's air as the regulator keeps it, every tank full.
function init(g) {
  const ls = lib(), T = ls.air.tempK, { all } = GRAPH.nodes(g), state = { air: {}, tanks: {}, waste: 0 };
  for (const [id, s] of Object.entries(all)) {
    if (s.type === 'atmosphere') state.air[id] = { o2: kgFor('o2', ls.air.o2kPa, s.volume, T), n2: kgFor('n2', ls.air.n2kPa, s.volume, T), co2: kgFor('co2', 0.04, s.volume, T), h2o: kgFor('h2o', ls.air.humidityKPa, s.volume, T) };
    if (s.type === 'tank' && /^tank-(o2|n2|h2o|carbon)$/.test(id)) state.tanks[id] = id === 'tank-carbon' ? 0 : Object.values(s.capacity)[0];
  }
  return state;
}

// A saved state brought back for this graph: places and tanks it no longer has dropped, new ones as
// a new vessel's, every amount a number of 0 or more.
function restore(g, saved) {
  const fresh = init(g), num = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
  if (!saved || typeof saved !== 'object') return fresh;
  for (const [a, air] of Object.entries(fresh.air)) if (saved.air?.[a]) for (const gas of GASES) air[gas] = num(saved.air[a][gas], air[gas]);
  for (const t of Object.keys(fresh.tanks)) fresh.tanks[t] = num(saved.tanks?.[t], fresh.tanks[t]);
  fresh.waste = num(saved.waste, 0);
  return fresh;
}

// One step. crew: { placeId: people }; power: { systemId: 0..1 } (the share of its draw the solve
// gave it); places: { placeId: 0..1 }, if given, each place's air handling (switched on there, and
// served): a place without it is sealed off from the ventilation and the regulator. Returns what each
// place's air is now, and what's wrong.
function step(g, state, { dt = 1, speed = 1, crew = {}, power = {}, places: placePower = null } = {}) {
  const ls = lib(), T = ls.air.tempK, day = ls.perPersonPerDay, { all } = GRAPH.nodes(g);
  const secs = dt * speed, perDay = secs / 86400;
  const places = Object.keys(state.air), vol = (a) => all[a].volume, placeOf = (a) => Object.keys(all).find((id) => all[id].systems?.[a]) || null;
  const handler = all['air-handler'], f = (sys) => (sys?.poweredBy ? Math.max(0, Math.min(1, power[sys.poweredBy] ?? 0)) : 1);
  const fAir = f(handler);
  const tank = (id) => (state.tanks[id] ?? 0), cap = (id) => (all[id] ? Object.values(all[id].capacity)[0] : 0);
  const creative = (id) => !!all[id]?.creative;
  const fill = (id, kg) => { if (!all[id]) return kg; const room = creative(id) ? Infinity : cap(id) - tank(id), put = Math.min(room, kg); state.tanks[id] = tank(id) + (creative(id) ? 0 : put); return kg - put; };
  const draw = (id, kg) => { if (!all[id]) return 0; const got = creative(id) ? kg : Math.min(tank(id), kg); if (!creative(id)) state.tanks[id] = tank(id) - got; return got; };
  // (Taking a gas from the air, from the places in proportion to what each holds.)
  // (The processors reach the air through the ventilation: the places it serves.)
  let reach = places;
  const fromAir = (gas, kg) => { const total = reach.reduce((n, a) => n + state.air[a][gas], 0); if (total <= 0) return 0; const t = Math.min(kg, total); for (const a of reach) state.air[a][gas] -= t * (state.air[a][gas] / total); return t; };
  const toAir = (gas, kg) => { const V = reach.reduce((n, a) => n + vol(a), 0); if (!V) return; for (const a of reach) state.air[a][gas] += kg * vol(a) / V; };

  // The crew.
  const short = {};
  for (const [pid, n] of Object.entries(crew)) {
    const a = places.find((x) => placeOf(x) === pid);
    if (!a || !n) continue;
    const want = n * day.o2 * perDay, got = Math.min(want, state.air[a].o2);
    state.air[a].o2 -= got;
    if (got < want) short[a] = true;
    state.air[a].co2 += n * day.co2 * perDay;
    state.air[a].h2o += n * day.h2oVapour * perDay;
    // (What they drink: what they breathe out is in the air above, the rest goes to the reclaimer.)
    state.waste += Math.max(0, draw('tank-h2o', n * day.h2oDrink * perDay) - n * day.h2oVapour * perDay);
  }
  // Ventilation: each place toward the mix of all of them (ten minutes to even out, at full power).
  const served = (a) => (placePower ? Math.max(0, Math.min(1, placePower[placeOf(a)] ?? 0)) : 1);
  const vented = places.filter((a) => served(a) > 0);
  const k = Math.min(1, (secs / 600) * fAir);
  if (k > 0 && vented.length > 1) {
    const V = vented.reduce((n, a) => n + vol(a), 0);
    for (const gas of GASES) { const mean = vented.reduce((n, a) => n + state.air[a][gas], 0) / V; for (const a of vented) state.air[a][gas] += (mean * vol(a) - state.air[a][gas]) * k * served(a); }
  }
  reach = vented;
  // The CO2 scrubber: carbon dioxide out of the air; oxygen to its tank, carbon to the store.
  const scrub = all['co2-scrubber'];
  let scrubbed = 0;
  if (scrub) {
    scrubbed = fromAir('co2', scrub.consumes.co2 * perDay * f(scrub));
    fill('tank-o2', scrubbed * (32 / 44)); fill('tank-carbon', scrubbed * (12 / 44));
  }
  // The water reclaimer: humidity over the comfortable level, and the waste, back to the water tank.
  const rec = all['water-reclaimer'];
  let reclaimed = 0;
  if (rec) {
    const room = rec.consumes.h2o * perDay * f(rec);
    const fromWaste = Math.min(state.waste, room);
    state.waste -= fromWaste;
    const over = places.reduce((n, a) => n + Math.max(0, state.air[a].h2o - kgFor('h2o', ls.air.humidityKPa, vol(a), T)), 0);
    const fromHumidity = fromAir('h2o', Math.min(over, room - fromWaste));
    reclaimed = (fromWaste + fromHumidity) * ls.reclaimEfficiency;
    fill('tank-h2o', reclaimed);
  }
  // Hydroponics: carbon dioxide and water into oxygen and biomass.
  const hyd = all.hydroponics;
  if (hyd) {
    const co2 = fromAir('co2', hyd.consumes.co2 * perDay * f(hyd));
    const h2o = draw('tank-h2o', co2 * (18 / 44));
    const done = Math.min(co2, h2o * (44 / 18));
    if (done < co2) toAir('co2', co2 - done);
    toAir('o2', done * (32 / 44)); fill('tank-carbon', done * (12 / 44));
  }
  // The regulator: oxygen and nitrogen topped up from the tanks to the air it keeps.
  if (fAir > 0) for (const a of vented) for (const [gas, p, tid] of [['o2', ls.air.o2kPa, 'tank-o2'], ['n2', ls.air.n2kPa, 'tank-n2']]) {
    const lack = kgFor(gas, p, vol(a), T) - state.air[a][gas];
    if (lack > 0) state.air[a][gas] += draw(tid, Math.min(lack, lack * Math.min(1, (secs / 300) * fAir * served(a))));
  }
  // (Water vapour past saturation condenses: to the reclaimer, as waste.)
  for (const a of places) { const most = kgFor('h2o', ls.air.saturationKPa, vol(a), T); if (state.air[a].h2o > most) { state.waste += state.air[a].h2o - most; state.air[a].h2o = most; } }
  // Each place's air, and what's wrong with it.
  const out = {};
  for (const a of places) {
    const p = Object.fromEntries(GASES.map((gas) => [gas, kPa(gas, state.air[a][gas], vol(a), T)]));
    const total = Object.values(p).reduce((x, y) => x + y, 0);
    const warn = [];
    if (p.co2 >= ls.air.co2DangerKPa) warn.push('danger: carbon dioxide'); else if (p.co2 >= ls.air.co2WarnKPa) warn.push('carbon dioxide high');
    if (p.o2 <= ls.air.o2DangerKPa || short[a]) warn.push('danger: oxygen'); else if (p.o2 <= ls.air.o2WarnKPa) warn.push('oxygen low');
    out[a] = { kPa: p, total, warn };
  }
  return { air: out, scrubbed, reclaimed, tanks: { ...state.tanks }, waste: state.waste };
}

module.exports = { init, restore, step, kPa, kgFor };
