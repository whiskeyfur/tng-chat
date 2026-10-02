# How the ship's systems are modelled

A description of what the code does, as of commit d2f0aa6, for anyone changing the simulation. Line numbers are for `server.js` unless another file is named; they drift as the code changes, so search for the quoted names if a line has moved. Where I'm not sure of something, it says so.

## 1. Where ship state lives

The relay (`server.js`) runs the simulation. The ship's computers (`tools/shipcore.js`) fly the ships (position, heading, speed) and keep each ship's saved state on disk.

**In the relay's memory, per ship (keyed by the lower-cased ship name):**

- `navState` (line 854): the ship's position, heading, speed (`warp`: under 1 is impulse), destination, and Engineering's limiter settings (`power`, a % per system), as last reported by its computer.
- `eng` (`const eng = new Map`, line 1563): the power grid and everything Engineering runs. `freshEng()` (line 1574) builds it from a save or from the cold-iron default `COLD` (line 1573). It holds:
  - `ties`: for each source and load, the nodes it's tied to (any of `A`, `B`, `C`, `EPS`). Keys look like `console:Helm`, `system:shields`, `sub:rf`, `contain:amCore`, `solar`, `dock`, `ship`, `core`, `crosslink`.
  - `taps` (EPS → bus limits), `breakers` (per battery), and `stores` (battery A/B/C charge; EPS manifold `pressure`).
  - `core` (offline / starting / online / ejected) and `wc` (the warp core's reaction: rate, actual, mix, align, crystal, temp, plasma, autoTrim, breachT).
  - `drives` (port and starboard: state, epsTap, accel, gear) and `aux` (aux1, aux2).
  - `computers` (three, state and boot time) and `epsLive` (manifold energized).
  - `antimatter` and `deuterium` (the main storage), `tanks` (the systems' own tanks), `tankCfg` (each tank's tie and Fill/Drain), `contain` (main containment field and reserve), and `tankContain` (the other antimatter tanks').
  - `ls` (life support per place), `trDiag` (transporter diagnostic), `conn` (Connections' Import/Export), `docked`, `shipDocks`, `forcefields`, and others.
- `combat` (`freshCombat`, line 2565): hull, shield strength, damage per system, phaser charge, torpedoes, lock, repair.
- `transporters` (line 2987): transporter lock and energizing state.
- `flowCache` (line 1713): each ship's last power-flow result, recomputed at most every 200 ms or when invalidated (`gridChanged`, line 1969).

**What's saved:** the relay sends `core-set` with `savedEng(k)` (line 1671) and `savedCombat(k)` to the ship's primary computer every 5 seconds when something changed (end of the tick, line 2889). The computer stores them in `store.nav` and writes `<data>/<ship>/.nav.json` (`tools/shipcore.js` `core-set`, line 213; also every 5 s while flying, line 147). The limiters (`power`) are saved by the computer when Engineering routes power (`core-power`). Older saves are migrated in `freshEng` and `freshCombat`: missing fields get defaults that keep a running ship running.

**The shape of a system.** There is no single "system object". A system is a key in several tables:

| What | Where |
|---|---|
| The list of systems | `SYSTEMS` (line 760) |
| Rating (power at 100%) | `RATING` (line 784), default 100 |
| Limiter (% the system may draw, 0-150) | `navState.power`, defaults `DEFAULT_POWER` (line 792), read through `allocOf` (line 797) |
| Which nodes it may tie to | `LOAD_NODES` (line 1470): low buses `AB` or `['EPS']` |
| Default tie | `SYSTEM_BUS` (line 1467), via `DEFAULT_LOAD_TIES` (line 1502) |
| Its console | `STATION_SYSTEMS` (line 1469) |
| Serving priority | `SYSTEM_PRIORITY` (line 1475) |
| Damage | `combat.damage[name]`, in `DAMAGEABLE` |
| Display name | `SYSTEM_NAMES` |

Subsystems (`SUBSYSTEMS`, line 1481) are low-bus loads with a parent (a console, `core`, a drive, an aux reactor, `computer`). Their draw is set in the flow's load list (below). They have no limiter.

## 2. The tick

Two clocks:

- **The ship's computer flies the ship 4 times a second** (`tools/shipcore.js` line 120): it moves each ship it's primary for and reports its position once a second (`core-nav`, line 146).
- **The relay's tick runs once a second** (`setInterval(...)`, line 2733, ending at line 2897).

Each relay tick does these steps in order:

1. Transporter locks are checked (`checkTransporterLocks`), and calls whose carrier lost power are dropped (`dropPowerlessCalls`, line 2399).
2. Then, for every ship with a computer (not starbases):
   1. The power flow is recomputed fresh (`flow(k)`).
   2. Self-destruct.
   3. The other antimatter tanks' containment, then the main containment field (line 2749). This is also where a breach or the 45 s countdown destroys the ship.
   4. The warp core: flameout, ignition, the self-sustaining check, losing its subsystems (line 2786). Then the reaction: rate toward its setting, heat, alignment drift, crystal wear (line 2794).
   5. Overdrive damage (line 2805), then the computer cores booting or crashing (line 2811).
   6. The fuel buses move fuel (`moveFuel`, line 2426). The fusion reactors light, run, or flame out, and burn their tanks (line 2820).
   7. The EPS manifold energizes or collapses (line 2833). Impulse builds toward Helm's order at the gear's rate (line 2836).
   8. Breakers trip (`tripBreakers`, line 1983). Batteries and EPS pressure charge or drain (line 2843).
   9. The Bussard collectors gather deuterium (line 2845) and the warp core burns its tanks (line 2849). Connections move fuel (`moveConnections`, line 2453).
   10. Docking checks, then repairs, shield recharge, phaser charge, torpedo restock, and weapons lock (line 2868 on).
   11. If anything changed, the state is saved and a nav broadcast is scheduled.

Not everything waits for the tick. Grid commands (`gridCommand`, line 2075) change state at once and invalidate the flow cache.

## 3. Power

All of this is `flow(k)` (line 1714). It returns cells (power through each source/load on each node), totals per node, `delivered` per system, `subOk` per subsystem, `consoleOk` per console, and more.

**Generation.** Sources are listed in `SOURCES` (line 1353) and capped in `cap` inside `flow`:

| Source | Output | Ties |
|---|---|---|
| Solar | 25 | Bus B only |
| Dock power | 700, when docked and power Import is on | Bus B and/or EPS |
| Docked ship | 100 per connection, when one side exports and the other imports | Bus B and/or EPS |
| Impulse drives | 75 each, scaled by the share of thrust not used | EPS, through the thrusters tie |
| Aux reactors | 75 each | EPS |
| Warp core | `coreOutput` = 1000 × rate × efficiency (line 1434) | EPS, through the power transfer conduits |

The stores are sources too: battery A/B/C (100 each) and EPS pressure (300). They're the last resort. `SOURCE_NODES` (line 1444) says where each source may tie.

**Demand.** For each system: `capacity = min(limiter, 150 × (100 − damage) / 100)`, then `demand = min(capacity, usageOf(system))` (around line 1717). `usageOf` (line 1695) is what the system is using right now:

- transporter: 0 idle, 50 locked, 100 energizing
- weapons: only while armed
- shields: while up or recharging
- warp field coils and plasma injectors: by the warp being made
- deflector: while moving
- Bussard collectors: at warp
- AM bus containment: 20% idle, full while antimatter moves
- life support: the share of places switched on
- everything else: 100

The load for a system is `demand × rating / 100`. Subsystems, consoles (2 per person aboard), Communications (10 each), containment, and power out to a dock or ship are built directly into the load list in `flow`.

**Allocation**, in this order:

1. Antimatter containment first (main, then each other antimatter tank), from their ties, falling back to the stores.
2. Each node serves the loads tied to it alone, in priority order. After each bus's loads, its battery charges from that bus's surplus, but only from sources tied to one node.
3. Loads tied to two nodes, then three.
4. Shares are lifted (`x.share = null`, line 1908). A source tied to several nodes splits evenly at first; the share a node didn't use now goes to its other nodes that are still short, and loads are topped up.
5. The stores (batteries, EPS pressure) cover what's still short (`storesOk = true`).
6. Batteries charge from what's left, then the EPS manifold (line 1914).

`take` (line 1775) and `serve` (line 1811) do the drawing; `chargeFrom` (line 1878) does the charging.

**Crosslink.** The crosslink is a chain A–B–C (`chainOk`, line 1438). Crosslinked buses pool their sources and their maxima. Power moving between them is recorded per pair (`crossflow`). A→C is shown as A→B plus B→C.

**EPS taps.** EPS power flows down into each bus up to its tap setting. The taps only work with a computer core online (`taps`, inside `flow`).

**EPS manifold.** The EPS carries nothing until `epsLive` is true:

- While it isn't, EPS sources can only charge the manifold, and only with 100 or more of EPS generation (`EPS_CHARGE_GEN`, line 1410).
- It energizes when pressure reaches 1000, and collapses when pressure hits 0 (line 2833).
- Once live, it covers EPS shortfalls from its pressure (up to 300 a second) and refills from surplus.

**Breakers.** A node's sustained tied load over its max (`BUS_MAX` 300 per bus, EPS 1000, scaled by damage) trips a random trippable load off it, repeated until it fits (`tripBreakers`, line 1983).

- Startup surges don't count (`sustained`).
- Containment, constriction and antimatter-tank containment never trip (`NEVER_TRIP`, line 1511).
- A tripped load is untied and shows as Tripped until re-tied.

**Delivered.** `delivered[system]` is the power received × 100 / rating, so it's a %. `powerOf(k)` (line 798) floors it and adds two derived values:

- `lifeSupport`: how fully atmosphere and heat are served where they're on
- `idf`: 0 if the SIF is under 50%

Systems read `powerOf` for their effects: sensor ranges (`rangesOf`, line 813), top speed (`speedLimits`, line 820), shield recharge, phaser charge, transporter energizing. Running over 100% damages the system (overdrive, line 2805).

## 4. Fuel

**Buses.** There are two fuel buses: deuterium (`deu`) and antimatter (`am`) (`TANKS`, line 1388).

- On each: the main storage (`e.deuterium`, 2000; `e.antimatter`, 1000) and the systems' own tanks:
  - deuterium: core 100; port, starboard, aux1 and aux2 50 each
  - antimatter: core 50, torpedo 100
- Each tank has a tie and Fill or Drain (`tankCfg`).

**Flow.** `moveFuel` (line 2426) runs once a second. Per bus, up to 50 moves from tied Drain tanks to tied Fill tanks, the systems' tanks first.

- The antimatter bus moves nothing unless its magnetic containment (`amBus`, an EPS system) gets what it asks for.
- An antimatter tank only takes antimatter with its containment powered.

**Connections** (`moveConnections`, line 2453) move fuel between the main storage and the starbase or a docked ship, by each side's Import/Export, 50 a second.

**Burn.**

- Each fusion reactor burns 0.1 a second from its own tank (line 2820). It lights at 30% and flames out dry.
- The warp core burns `coreUsed / 650 × 0.5` a second from each of its tanks (line 2849). It needs both at 30% to ignite and flames out when either is dry.
- The Bussard collectors add up to 5 a second to the main deuterium tank at warp 9 (line 2845).

**Containment.** `CONTAIN` is at line 1416, `AM_CONTAIN` at line 1405.

- The pods' main containment needs 20 from its ties, falling back to an internal reserve of 9 minutes (`RESERVE_SECS`), recharged at 5 a second.
- Held, the field rises 10%/s to 100. Not held, it falls 5%/s, or 2%/s if the core is over 90% hot.
- With a live reaction, a field under 35% starts a 45 s countdown, cancelled above 60% or if the reaction stops. Without one, a field under 20% destroys the ship.
- The warp core's and the torpedo bay's antimatter tanks each have their own containment: a draw scaled to their size, their own ties, the same field and reserve rules, and breach under 20%. An empty tank draws nothing.

## 5. The systems

- **Warp core** (`CORE`, line 1432; `coreEff`, line 1433). Cold ignition needs:
  - antimatter and deuterium in its tanks (30%)
  - the SIF at 50%
  - the containment field at 95%
  - a mixture of 15:1 or richer
  - its constriction, antimatter injector and antimatter transfer conduit powered

  It runs at up to 10% for 6 s until self-sustaining, then ramps 5%/s to the rate setting. Efficiency is the mixture factor (best at 12:1) × alignment × (0.5 + crystal/2). Alignment drifts while running unless auto-trim is on (all 3 computer cores). The crystal wears above 80%. Temperature follows the rate. SCRAM stops the reaction. The core needs the plasma conduits open for warp.
- **Fusion chambers** (`FUSION`, line 1375). Impulse drives and aux reactors share the same machinery: the chamber draws 10 to light (5 s) and 5 to run from its low-bus ties, or nothing with its EPS tap on and the EPS live. It flames out dry or without power.
- **Impulse and driver coils.** A drive's thrust is 0.125 × accelerators% × gear top (Low ¼, High 1) (`driveTop`). Impulse builds toward Helm's order at the gear's rate (Low 0.03/s, High 0.015/s) (line 2836). Impulse also needs SIF 60% and IDF 80% (`HULL`, line 767).
- **Hull fields** (`HULL`, line 767). The SIF (35) and IDF (22) are on the EPS. The IDF only counts with the SIF at 50%. Warp needs both at 90%. The core needs the SIF at 50% to start.
- **Sensors** (`rangesOf`, line 813). Long-range sensors (22, EPS) set sensor range (600) and subspace range (400). The lateral arrays (10, low bus) give a quarter of that on their own, and they alone set transporter range (20). Your sensor signature, as others see it, is total draw / 360 (`signatureOf`, line 811).
- **Deflector.** 80, EPS. It needs the long-range sensors, and warp needs it at 90% capacity.
- **Computer cores** (`COMPUTER`, line 1435). Three, at 2 each, on a low bus. They boot in 14 s and crash without power. The EPS taps need one online, texts need one at each end, and auto-trim needs all three.
- **Transporter** (`TR`, line 2994; `transporterFault`, line 2997). Pattern buffers (15, need the lateral sensors), targeting scanners, Heisenberg compensators, biofilter, and energizing coils (5 while energizing). Locking needs the buffers and scanners. A 16 s level-3 diagnostic must pass, and the buffers losing power invalidates it. Energizing takes 5 s at 100%; the person moves at the end.
- **Life support by place** (`LOCATIONS`, `LS_SYSTEMS`, line 777). Atmosphere 10, thermal 8, gravity 20, lights 6, emergency lighting 1. Each draws for the share of places it's switched on in, and "serves" a place while it has some power. Emergency lighting lights places whose lights are on but unpowered.
- **Comms gating** (`commsUp`, line 1979; `commsReach`, line 2504).
  - Calls aboard need local RF; data-link calls need the subspace relays at both ends; radio calls need both radios.
  - A call drops if its carrier loses power.
  - Everything on a console needs that console powered or local RF up (`commsReach`).
  - Texts also need a computer core at each end.
- **Bussard collectors** (`BUSSARD`, line 783). 20, EPS, under Helm. Draw only at warp; gather deuterium.

## 6. How the consoles get state

All of this goes over one WebSocket per console.

- **`nav`** is the main message. `navMessage(k)` (line 872) carries:
  - the ship (`own`, including `power`, `capacity`, `allocated` and `grid` from `gridView(k)`, line 2016)
  - contacts, starbases, ranges and speed limits
- It's sent to everyone aboard by `scheduleNav` (line 894). That's debounced to at most one broadcast every 500 ms, and runs whenever a ship's computer reports (about once a second), the grid changes, or the tick changed something.
- Other messages: `users` (who's aboard; species and gender only to people in the same place), `ships`, `notice`, `registered`, `profile`, `order`, `text`, call signalling, `admin-status`, and `reload`.
- The consoles render from the last `nav` (`public/client.js`, `case 'nav'`) and send commands back: `grid`, `power`, `helm`, `beam`, `transporter-lock`, and others.
- Engineering's grid commands go through `gridCommand` (line 2075).

**Unsure:** I haven't checked whether every older-save field has a migration.
