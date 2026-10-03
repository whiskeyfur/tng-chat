# Ship graphs (draft, step 1)

A vessel's design as a **graph of systems**. Every system a class has gets one entry: buses, places, consoles, systems, subsystems, sources, batteries, tanks and docking. Each entry lists what that system draws from (its **upstream**), per resource, and what's allowed on each link.

Today the same facts are spread over the design file and tables inside the relay. The graph puts them in one place, so the solver, Distribution, the Power grid and the MSD can all read the same thing. It also lets any system be the root of a chart.

**Status:** step 1 of 4. The graphs are generated from the current design files by `tools/ship-graph.js` and checked by the config loader. The game doesn't read them yet, and nothing in play changes.

## Files

| File | What |
|---|---|
| `config/system-types.json` | The library of system types: what every system of a type is (its role, its resources). A graph only says what's particular to a system. |
| `config/ships-graph/<class>.json` | One class's graph, generated: `node tools/ship-graph.js <class>`, `--all` for every class, `--check` to see the files are valid and up to date. |
| `tools/ship-graph.js` | The converter, the checker (`check`), the both-ways index (`index`), and `toTies` (the converter's own check that it lost nothing). |

The relay prints its power tables and what each class has aboard when it's run with `SHIP_GRAPH_DUMP=1`, then exits without listening. The converter uses that output, so a graph is exactly what the game builds for a new ship of that class.

## A graph

```json
{
  "schema": "tng-ship-graph/1",
  "type": "ship",
  "class": "runabout",
  "name": "Runabout",
  "places": [{ "id": "place-cockpit", "name": "Cockpit", "deck": 1 }],
  "systems": {
    "bus-b": {
      "type": "bus", "name": "Bus B", "capacity": { "power": 100 },
      "upstream": {
        "bus-a": { "power": { "pull": true, "push": true } },
        "eps": { "eps": { "pull": "auto", "push": false, "rate": 100 } },
        "solar": { "power": { "pull": "auto", "push": false } },
        "battery-b": { "power": { "pull": "auto", "push": "auto", "rate": 50 } }
      }
    },
    "warp-core": {
      "key": "core", "type": "warp-core", "name": "Warp core", "produces": { "eps": 300 },
      "upstream": { "tank-deu-core": { "deu": { "pull": "auto", "push": false } } },
      "systems": {
        "subsystem-injector": { "key": "sub:injector", "type": "subsystem", "name": "Antimatter injector", "place": "place-aft-compartment", "upstream": { "bus-a": { "power": { "pull": "auto", "push": false } } } }
      }
    },
    "system-engines": {
      "key": "system:engines", "type": "system", "name": "Warp drive", "place": "place-warp-nacelles-port-and-starboard",
      "consumes": { "eps": 100 }, "effects": { "ftl": { "maxWarp": 5 } },
      "upstream": { "eps": { "eps": { "pull": "auto", "push": false } } }
    },
    "console-helm": {
      "key": "console:Helm", "type": "console", "name": "Helm console", "place": "place-cockpit",
      "consumes": { "power": 2 },
      "upstream": { "bus-a": { "power": { "pull": "auto", "push": false } }, "bus-b": { "power": { "pull": true, "push": false } } }
    }
  }
}
```

### A system

| Field | |
|---|---|
| id (its key in `systems`) | Lower-case letters, digits and `-`, readable and stable (`bus-b`, `place-cockpit`, `system-shields`). A ship's save will key its runtime values by these ids. |
| `type` | A type in `config/system-types.json`. |
| `name` | What the crew sees. |
| `key` | Step 1 only: the relay's own name for it today (`console:Helm`). It goes once the relay reads graphs. |
| `capacity`, `produces`, `consumes` | Per resource, numbers (MW for power and EPS; units for fuel). |
| `place` | The place it's in (its power runs through that place's conduit). |
| `systems` | Its parts, nested: each the same shape as any system. A subsystem is in its system, station or source; a thruster in its drive; a containment in its tank; a life-support system in life support's conduit. Ids are unique across the whole tree, so a link can point anywhere. `parentName` names a parent this class doesn't have (a station it lacks). |
| `via` | A conduit below its place that its power also runs through (life support's, the engines'). |
| `upstream` | `{ upstream system id: { resource: link } }`: what it draws from. |
| `effects` | What it lets the vessel do beyond converting resources, with its parameters: `{ "ftl": { "maxWarp": 5 } }`, `{ "shields": { "strength": 0.4 } }`, `{ "phasers": { "array": 1 } }`, `{ "comms": { "range": "subspace" } }`. The names: `ftl`, `jump`, `impulse`, `maneuver`, `shields`, `phasers`, `torpedoes`, `tractor`, `transport`, `sensors`, `comms`, `life-support`, `gravity`, `dampers`, `sif`, `deflector`, `holo`, `force-fields`, `brig`, `shuttle-bay`, `docking`, `computing`, `replication`, `seat`… A console's `seat` (`{ "seat": { "station": "Helm" } }`) is the one place someone sits at it; more seats are more consoles. A vessel's stations are its seats (John, 2026-10-03). (and `cloak` when a design has one). In play, an effect's strength is how well its system is fed (supplied over required) times its health. Play will ask for an effect ("the best FTL aboard") rather than a system's id, so a new kind of drive or weapon is a design change, not code (John, 2026-10-03). |
| `creative` | `{ resource: true }`: it never runs short of that resource (John, 2026-10-03). As a source it gives whatever's asked of it while it's there, with its links' `rate` still the limit. As a store or tank it never runs dry or fills. A starbase, a shipyard or a GM object: a design lists `"creative": ["power", "eps", "deu", "am"]` and its sources, stores and tanks get it. A ship's dock feeds are creative (the starbase on the other side), at the dock's rate. |
| `count` | On a docking port: `null` for as many as needed (a starbase). |

`type`, `name`, `consumes`, `produces`, `capacity`, `effects`, `upstream` and `systems` sit together on each system: a system is a resource converter (what it consumes, what it produces) with effects (John). The vessel itself (the root) carries only who it is (`type`, `class`, `name`, its `places`) and its `systems`: what it consumes and produces as a whole is worked out from them, never stored, so it can't disagree with them.

### A link

A link is stored on the system downstream, under the upstream system's id, for each resource it carries:

| Setting | |
|---|---|
| `pull` | May the downstream system draw from the upstream one? |
| `push` | May it send back the other way? (a battery charging; a crosslink carrying the other way; a docked ship's export) |
| `connect` | For a resource that's connected rather than moved (the ODN). |
| `rate` | Its limit on a pull: what the upstream system gives down this link at most (an EPS tap's, a battery's output, the dock's, a radiator's). |
| `pushRate` | Its limit the other way (a battery's charge rate). |
| `pri` | On a pull: who's served first when the supply is short (lower first). The converter writes today's rule as numbers: containment 0; loads tied to one bus 100+, to two 200+, to three 300+, each tier in the systems' priority order. |
| `min` | On a pull: the least the system must get to work at all. Below it, it gets nothing, reads NO OUTPUT, and the supply goes on to the next link. A number, or `"all"` (all it draws: a subsystem, a containment). A console's is 2; a system works on what it gets, so it has none. |
| `why` | Optional: why it's `false` or `"warn"`, shown to the crew. |

`pull`, `push` and `connect` each take one of four values (John, 2026-10-03):

| Value | Meaning | In play |
|---|---|---|
| `false` | Not allowed, ever. | Not shown as an option; a save that had it on loses it. |
| `"warn"` | Allowed, but not advised. | Caution amber; turning it on takes a second, confirming tap (with `why`). Automation never turns it on. |
| `true` | Allowed. | Off when the vessel first loads; the crew turns it on. |
| `"auto"` | Allowed, and on when the vessel first loads. | Today's "a new ship starts tied". |

The design holds what's allowed. A ship's save holds only what's on (off/on, levels, charge, damage), keyed by system id. On loading, anything the design doesn't allow, or doesn't have, is dropped.

The converter maps today's ties like this:
- A tie a new ship starts with becomes `"auto"`.
- A tie it could make becomes `true`.
- One it can't make is left out, or is `false` where it's worth saying. A and C, for example, link only through B.

### Heat

`heat` is a resource like the others (John, 2026-10-03). Every system that consumes or produces makes heat, a share of what it handles:
- The library's `heat.byType` sets the share for each type: a tenth of a system's draw, more for a warp core or a fusion reactor.
- `heat.byEffect` makes some effects hotter: phasers 0.3, FTL 0.2, shields 0.15.

The coolant loop (`coolant-loop`) pulls heat from each system that makes it. It takes heat to the heat sink (`heat-sink`, a buffer that buys time) and to the radiators (`radiator`), which dump it to space at their rate and run their pumps on Bus B.

The converter sizes the radiators so a vessel running every system at once just balances. The runabout makes 290 at full draw and its 2 radiators dump 300.

From step 2, a system whose heat can't leave warms up. Past `warm` (70% of its limit) its effects weaken, and past `hot` (90%) it takes damage.

### Walking it: any system as the root

`nodes(graph)` lists every system in the tree flat, with its parent. `index(graph)` gives both directions per resource:
- `up[id][resource]` lists the systems it draws from.
- `down[id][resource]` lists the systems that draw from it.

That's enough to chart from any system: what feeds it sits to its left and what it feeds to its right, spreading out hop by hop, as the network map does. A bus view on Distribution becomes one case of that (John, 2026-10-03).

## The runabout (step 1 output)

`config/ships-graph/runabout.json`, made from `config/ships/runabout.json`:
- **Buses:** A, B, C and the EPS manifold. The crosslink is B's links to A and C's to B. A↔C is `false`. Each low bus has a tap link to the EPS.
- **Sources:** solar, three emergency batteries, the impulse reactors and their thrusters, the aux reactors, the warp core, and dock and docked-ship power behind the docking connectors and port.
- **Stores:** a battery per low bus and the EPS pressure.
- **Fuel:** the deuterium and antimatter buses and their tanks, each tank linked to what it feeds.
- **Places:** its places (listed on the vessel, and as conduits in the tree), life support's conduit and the computer cores' group.
- **Nesting:** 89 systems, 61 at the top level; the rest are parts inside their systems.
- **Loads:** every console, system, subsystem and containment, each in its place with its parent.

## Rough spots, for review

- **Heat** numbers are first guesses:
  - Systems', subsystems', containments' and reactors' shares are set, now that the graph has their draws.
  - "Every system at once" is the worst case. A design may want fewer radiators and rely on the heat sink for bursts (phasers firing, a warp jump).
- **pri and min** write today's rule as numbers. Step 2's comparison shows they reproduce it exactly: the graph solver and the relay's agree in every state tested.
- **Serving rules the graph solver still takes from today's solver:**
  - Single-bus loads are served bus by bus, with each bus's battery charging after its own loads.
  - A bus draws on its sources in the order they're listed.
  - These are rules of the solver, not settings in the graph. Step 3 could make them settings.
- **Power exported to a docked ship or starbase** (`feed:*`) isn't a system in the graph yet. The comparison leaves it out; the test states don't export.
- **Heat sizing is conservative:** a ship rarely draws everything at once (the runabout makes 77/s at full stretch, against radiators sized for 300).
- **The ODN** (consoles' data link) isn't in the graph yet; consoles list `odn` as a resource but nothing feeds it.
- **Docking power:** the starbase's and a docked ship's power are separate sources behind the docking connectors, not the ports themselves. That's how the relay models them today. One port per runabout; a starbase's ports are one entry with `count: null`.
- **Thrusters:** a drive's thrusters are a conduit that feeds the EPS (what the drive doesn't spend on thrust), as today.
- **The runabout's comms:** its RF, radio and subspace subsystems belong to Communications, a station it doesn't have. They sit at the top level with `parentName: "Communications"`. Either the runabout gets a Communications console, or the subsystems move to Operations.
- **Draws:**
  - Systems' `consumes` is their rating at 100%, and a console's is 2.
  - Subsystems' and containments' `consumes` is what they draw while working. Some draw more while starting (the constriction 60), which the graph doesn't show.

## Step 2: the graph solver

`tools/graph-solver.js` works out who gets how much power from a ship's graph and its runtime state. It runs alongside the relay's own solver, which play still uses. `test/solver.js` runs both on every class in nine grid states and requires the same answers on every load, every source, the batteries, the crosslink and charging. The nine states:
- cold iron
- warm
- all on (at warp, armed, shields up)
- a brownout
- the crosslink both ways
- the crosslink one way
- buses on their EPS taps alone
- docked
- starved (solar only, batteries out of service)

All 54 agree.

The rules, read from the graph:
- **Sources:** a bus draws on its sources in the order the graph lists them. After those it draws on the EPS through its tap, up to the tap's rate. Last-resort sources (batteries, the EPS's pressure, emergency batteries; `lastResort` in the type library) are drawn on only when nothing else will do.
- **Crosslink:** crosslinked buses are one pool, and power crosses only the ways their links allow. A source tied to several buses gives each an even share first.
- **Serving order:**
  1. Loads are served in `pri` order, containment first: each containment draws from its feeds in turn, and the batteries straight away if it's short.
  2. Then loads on one bus, each bus in turn, followed by that bus's battery charging.
  3. Then loads on two buses, then on three, each split evenly.
  4. Then whatever is still short gets any share left over, then the batteries.
- **Conduits:** a load gets a bus's power only while its place and every conduit on its path are tied to that bus too.
- **`min`:** a load that can't get its minimum gets nothing, and its power passes on. The solver works it out again without that load until nothing else falls short.

What `min` changes against today, from the starved state: the subspace relay gets 5 of its 10 MW, which isn't enough to work. The relay powers it anyway, and the graph solver gives those 5 MW to the next load. Containment never loses power to a minimum.

**Draws and fuel** are in the graphs now, from the relay's numbers:
- Subsystems: the constriction 20, the injector 10, pattern buffers 15, a computer core 2, and so on.
- Containment fields: their draw.
- The warp core: deuterium and antimatter, scaled to its output.
- Fusion reactors: 0.1 deuterium/s.

**Heat**, in the graph solver only (off in play):
- Each tick, `heatStep()` gives each system its heat for what it handled. The coolant loop takes it to the radiators, which dump it while their pumps have power, and to the heat sink, which holds what the radiators can't.
- What neither takes stays in the systems that made it. Past 70% of a system's limit its effects weaken, down to half at 90%. Past 90% it takes damage.
- The runabout at full stretch (warp 5, armed, shields up) makes 77/s. Its radiators dump that with room to spare: they're sized for every system's full draw at once, which is 300.
- With the pumps off, the sink fills and then the systems warm and overheat (the test times it).

## The path tracer (tools/path-solver.js)

John's solver, beside the graph solver; it plays with `"solver": "path"` in `data/settings.json` (the graph engine on; `"graph"`, the default, for the graph solver; `SOLVER` in the environment wins): each consumer, in pri order (containment first), traced along a path from a source to it.

- **Sources:** its own vessel's live generators, then its stores (batteries, the EPS's pressure, emergency batteries), then across a dock the same. Within each, the nearest first (the fewest links: what's on a load's own bus before what comes through the EPS's taps), and the most power on hand of those. A creative source never runs short; its link's rate still limits it.
- **Paths:** through the buses, the EPS and its taps, the crosslink (each way it allows) and the conduits on the load's own path. Every link has what's left of its rate, every bus what's left of its limit; the source gives what the path can carry, and every node on the way records it passing through (+x in, −x out). A consumer may draw on several sources and paths.
- **Minimums:** a consumer that can't reach its minimum is rolled back (sources, links and pass-through as they were), and the power goes on to the next. Containment is never rolled back.
- **Charging:** what's left charges the batteries, then the EPS's pressure, each up to its push rate.
- **Docked:** a docked group is one graph (`solveGroup`): each vessel's export joined to the other's dock feed, at the dock's rate, only the ways the exports allow. Containment on either vessel comes first; a vessel's consumers use their own sources before crossing the dock.

`test/path-solver.js` runs it on every class in the graph solver's grid states. No source gives more than it has, no bus carries more than its limit, what's given is what's taken and charged, a load gets its minimum or nothing, containment gets at least what the graph solver gives, and it never delivers less in total. It lists where the two differ: it follows pri strictly (the graph solver serves single-bus loads bus by bus), and it reaches power the graph solver leaves (phasers on the crossfield and the Intrepid at full stretch, the shuttle's inertial dampers).

`db/path-solver.sql` is the same in SQL (a stored procedure, a recursive query for each path), for `tools/bench.js`'s comparison; it gives every load the same answer.

## Life support (tools/life-support.js; wish list 1)

Five more resources, in kg: o2, n2, co2, h2o and c (carbon: biomass, food). Every vessel's graph has:

- **An air for each place** (`air-<place>`, type `atmosphere`, inside its place): so many kg of each gas in its volume (a design's `places[].volume`, m³; else `lifeSupport.placeVolume`, more on a big crew). Pressures follow from them.
- **The air handler** (ventilation, on the atmosphere system's power): mixes each place's air toward the others' and tops oxygen and nitrogen up from their tanks to the air it keeps (21.2 kPa of oxygen, 79 of nitrogen).
- **Tanks:** oxygen and water (30 days of the crew's needs), nitrogen (twice the air's), and the carbon store. A starbase's are creative.
- **The CO2 scrubber** (atmosphere power): carbon dioxide out of the air; each kg gives 0.727 kg of oxygen to its tank and 0.273 kg of carbon to the store.
- **The water reclaimer** (atmosphere power): humidity over the comfortable level, and the crew's waste, back to the water tank (93%). Vapour past saturation condenses to it.
- **Hydroponics**, where the design says `"hydroponics": true` (the Galaxy, the Intrepid, starbases), on the lighting's power: carbon dioxide and water into oxygen for the air and biomass.

The crew in each place breathe its oxygen and give off carbon dioxide and water vapour (per person per day: 0.84 kg O2, 1.0 kg CO2, 2.5 kg of water drunk, 1.0 breathed out). In play, the relay runs it each second after the power: the crew breathe the air of the place that holds their station; the atmosphere system's power (the share the places switched on need) runs the air handling, the scrubber and the reclaimer, and a place whose atmosphere is switched off is sealed from them; the lighting's runs the hydroponics. The air and the tanks are saved with the ship (`eng.life`). Engineering's Life support panel shows each place's air (oxygen, carbon dioxide, pressure, who's there, what's wrong) and the tanks; every console aboard gets an AIR alert when a place with people in it is wrong (red when dangerous), and Medical says so too. Admin → Settings → Life support sets the speed (`lifeSpeed` in data/settings.json: real time, 10×, 60×, 600×). Everything runs at the share of its power the solve gave it. Each place's air says what's wrong: carbon dioxide over 1 kPa high, over 4 kPa danger; oxygen under 16 kPa low, under 12 danger. `speed` (the admin's setting, 1 for real time) runs it faster. The constants are `lifeSupport` in `config/system-types.json` (the database's `game_rules`). `test/life-support.js`: a runabout keeps its air for two days on power and loses it without (carbon dioxide high after 17 hours); hydroponics keeps a Galaxy's air breathable with its atmosphere system down.

## Step 3: the graph in play

- **The relay builds every vessel kind's graph at start** (the ship classes, the starbase, the subspace relay), from its designs as they are. A design saved from the admin page (the supervisor restarts the relay) is in it. Consoles fetch their vessel's graph from `/api/ships-graph/<id>`; the grid says which one (`graphId`) and which version (`graphRev`).
- **Distribution, centred on any system:** a ◎ on every pill centres it there.
  - What feeds it is on the left and what it feeds (and its parts) on the right, a hop further out each column.
  - A tap on a neighbour ties or unties its link to the centre.
  - The buses keep their own views.
- **The Power grid's Systems order** lists the graph as a tree: sources, then buses and stores, then fuel, then each place's consoles and systems with their parts under them.
- **Seats:** a vessel's stations are its consoles' `seat` effects, and a seat whose console has no power reads standby on the sign-in and Station screens.
- **The graph engine** (`"engine": "graph"` in `data/settings.json`; `ENGINE` in the environment wins):
  - The relay shares out power with the graph solver, so minimums and `creative` take effect.
  - Ships save their ties by system id (`tiesById`: `{ "console-helm": ["bus-a"] }`).
  - The relay's own solver still works out what each load wants and the breakers' loads.
  - Off by default: the game plays as before until the cutover.
- **The cutover** (`node tools/cutover.js`; asked for first):
  - Stop `npm start`.
  - `node tools/cutover.js` says what it would do, changing nothing.
  - `--go` moves `shipcore-data/` and `data/starbases.json` to `backups/game-<date>/`, never deleted. It sets the engine to "graph" and keeps accounts and settings.
  - Start `npm start`: a new game, on the graph engine.
  - To go back: stop it, move them back, and set the engine to "relay".

## The steps

1. **Done:** the schema, the type library, the converter and the checks. Nothing in play changes.
2. **Done:** a graph-based solver alongside today's. Tests run both on every ship and require the same flows. The graphs now carry draws and fuel use, and heat is simulated in the graph solver only.
3. **Built, cutover not yet run:** Distribution (root-agnostic) and the Power grid read the graph, the graph engine plays, and ships save by system id.
   - **No old-save conversion** (John): the switch starts a new game.
   - Before it, `shipcore-data/` and `data/starbases.json` are moved to a timestamped backup folder, never deleted; accounts and settings stay.
   - The cutover itself is asked for first.
4. Today's tables go, and the design files become graphs.
