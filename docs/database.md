# The database (branch `database`, not in play yet)

MariaDB 10.11 on localhost:3306, database `startrek`. `tools/db.js` builds the schema and loads the game's designs and star charts into it. The game itself still reads its files: nothing in play uses the database yet, and saves and accounts haven't moved.

## Running it

The connection comes from `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` and `DB_NAME` in the environment, or else from `"database": { "host", "port", "user", "password", "database" }` in `data/settings.json`. It's never stored in git.

```
DB_USER=startrek DB_PASSWORD=startrek node tools/db.js migrate          # db/schema.sql, db/seed.sql (safe to run again)
DB_USER=startrek DB_PASSWORD=startrek node tools/db.js load             # the designs (as the relay builds them) and the star charts
DB_USER=startrek DB_PASSWORD=startrek node tools/db.js check            # each class read back is the relay's graph
DB_USER=startrek DB_PASSWORD=startrek node tools/db.js show runabout    # a class's systems, merged (or: show runabout console-helm)
```

`migrate` refuses to drop a table from the first draft (`systems`, `system_properties`, `default_properties`) if it holds rows.

## Layers, merged with JSON_MERGE_PATCH

Each system's settings are JSON, in layers, and each layer stores only what differs from the one under it:

| Layer | Table | What |
|---|---|---|
| Type | `base_systems.defaults` | What every system of a type shares, in every design: a console draws 2 MW, a fusion reactor makes 75 EPS. |
| Class | `class_systems.props` | What a class's system changes from its type's defaults: its name, its place, its effects. |
| Ship | `ship_systems.props` | What a ship's system changes from its class (its live state; empty until saves move here). |

`vw_class_systems` gives each class's systems merged (`json_merge_patch(type defaults, class props)`), and `vw_ship_systems` adds the ship's layer on top.

A patch sets what it names, at any depth, and keeps everything else. For example, defaults of `{"produces":{"eps":75,"heat":9}}` patched with `{"produces":{"heat":12}}` give `{"produces":{"eps":75,"heat":12}}`.

- **Remove:** a `null` in a patch removes that key. A setting whose value really is null (a starbase's docking ports, `count: null`, "as many as needed") is stored as `{"$null": true}` and read back as null.
- **Off:** "explicitly off" is `false` or `0`, never null.
- **Arrays** are replaced whole, so anything changed item by item is an object keyed by id. Effects are keyed by name, and links are rows.

## Links

`class_links` holds one row per pair and resource: `system_key` draws (pull) from `other_key`, or sends back (push). Its `link` is `{ pull, push, connect, rate, pushRate, pri, min, why }`. `ship_links` overrides a ship's links over its class's, and `vw_ship_links` gives them merged.

## Stars and planets

- **Stars** are classed in Morgan-Keenan form:
  - `spectral_class`, from a lookup: O B A F G K M L T Y and the white dwarfs DA DB DC DO DQ DZ, each with its colour and temperature range in kelvin.
  - `spectral_subclass`: 0-9.5.
  - `luminosity_class`, from a lookup: 0, Ia, Iab, Ib, II, III, IV, V, VI, VII, each with its name.
  - `peculiarity`: e, m, n, p, var and so on.
  - `mk_code` is generated from them: Sol is `G2V`.
- **Planets** have a class from `planet_types`: the Federation's letters, A to Y, each with its atmosphere, surface and habitability. Earth is M, Mars K, Jupiter and Saturn J.
- **Charts:** `star_systems` holds the charts, and `chart_objects` the starbases, waypoints and relay on each.

## World state for the database's own ticks

These tables are laid out so a database event can move them by itself. There are no events yet. The server's `event_scheduler` is OFF, and turning it on (`SET GLOBAL event_scheduler = ON`) needs an admin.

| Table | What an event would do |
|---|---|
| `orbits` | Move each planet's `x`, `y` along its orbit (radius, period, phase, epoch). |
| `starbase_stock` | Restock what a starbase holds, toward its capacity, at its rate. |
| `timers` | Fire what's due: a repair done, a convoy arriving, once or repeating. |
| `world_history` | Snapshots, for history and replays. |
| `ships.mothballed`, `ships.state` | A laid-up ship's slow changes (its batteries draining). |

The relay keeps the fast ship ticks (the power solver, combat, helm). The database's events would take the slow world ticks.

## Tests

`test/db.js`, in `npm test`, is skipped when no database is configured. It runs the schema twice, loads, checks that every class reads back as the relay's graph, and checks the merge rules and Sol's class.
