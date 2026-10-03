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
| `effects` | What it lets the vessel do beyond converting resources, with its parameters: `{ "ftl": { "maxWarp": 5 } }`, `{ "shields": { "strength": 0.4 } }`, `{ "phasers": { "array": 1 } }`, `{ "comms": { "range": "subspace" } }`. The names: `ftl`, `jump`, `impulse`, `maneuver`, `shields`, `phasers`, `torpedoes`, `tractor`, `transport`, `sensors`, `comms`, `life-support`, `gravity`, `dampers`, `sif`, `deflector`, `holo`, `force-fields`, `brig`, `shuttle-bay`, `docking`, `computing`, `replication`… (and `cloak` when a design has one). In play, an effect's strength is how well its system is fed (supplied over required) times its health. Play will ask for an effect ("the best FTL aboard") rather than a system's id, so a new kind of drive or weapon is a design change, not code (John, 2026-10-03). |
| `count` | On a docking port: `null` for as many as needed (a starbase). |

`type`, `name`, `consumes`, `produces`, `capacity`, `effects`, `upstream` and `systems` sit together on each system: a system is a resource converter (what it consumes, what it produces) with effects (John). The vessel itself (the root) carries only who it is (`type`, `class`, `name`, its `places`) and its `systems`: what it consumes and produces as a whole is worked out from them, never stored, so it can't disagree with them.

### A link

A link is stored on the system downstream, under the upstream system's id, for each resource it carries:

| Setting | |
|---|---|
| `pull` | May the downstream system draw from the upstream one? |
| `push` | May it send back the other way? (a battery charging; a crosslink carrying the other way; a docked ship's export) |
| `connect` | For a resource that's connected rather than moved (the ODN). |
| `rate` | Its limit (an EPS tap's, a battery's charge rate, a radiator's). |
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

- **Heat** is in the schema only, and the numbers are first guesses:
  - Systems' and reactors' shares are set; subsystems make none yet, because their draws aren't in the graph.
  - "Every system at once" is the worst case. A design may want fewer radiators and rely on the heat sink for bursts (phasers firing, a warp jump).
- **pri and min** write today's rule as numbers. Step 2's solver comparison will show whether they reproduce it exactly.
- **The ODN** (consoles' data link) isn't in the graph yet; consoles list `odn` as a resource but nothing feeds it.
- **Docking power:** the starbase's and a docked ship's power are separate sources behind the docking connectors, not the ports themselves. That's how the relay models them today. One port per runabout; a starbase's ports are one entry with `count: null`.
- **Thrusters:** a drive's thrusters are a conduit that feeds the EPS (what the drive doesn't spend on thrust), as today.
- **The runabout's comms:** its RF, radio and subspace subsystems belong to Communications, a station it doesn't have. They sit at the top level with `parentName: "Communications"`. Either the runabout gets a Communications console, or the subsystems move to Operations.
- **Draws:**
  - Systems' `consumes` is their rating at 100%, and a console's is 2.
  - Subsystems' and containments' draws vary in play (starting, running), so they aren't in the graph yet.
  - Reactors' fuel use isn't in the graph yet either.

## The steps

1. **Now:** the schema, the type library, the converter and the checks. Nothing in play changes.
2. A graph-based solver alongside today's. Tests run both on every ship and require the same flows.
3. Distribution (root-agnostic) and the Power grid read the graph; ships save by system id.
   - **No old-save conversion** (John): the switch starts a new game.
   - Before it, `shipcore-data/` and `data/starbases.json` are moved to a timestamped backup folder, never deleted; accounts and settings stay.
   - The cutover itself is asked for first.
4. Today's tables go, and the design files become graphs.
