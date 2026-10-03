# The database

MariaDB 10.11 on localhost:3306, database `startrek`. With `"database"` in `data/settings.json`, the game is played from it: the relay and the ship's computers read the designs, the star chart and the system library from it, and keep the ships' saves, the starbases' state and the accounts there. Without it, the game keeps to its files as before (the tests do, apart from the database's own).

## Turning it on

In `data/settings.json` (by hand: it's never in git, and the admin page never shows the password):

```
"database": { "host": "127.0.0.1", "port": 3306, "user": "startrek", "password": "...", "database": "startrek" }
```

The supervisor restarts the relay on the change, and the ship's computers take it when they next reload (a change to `tools/shipcore.js`, or `npm start` again). On the first start:

- an empty database is loaded from `config/` (the designs, the star chart, the system library);
- each ship's computer brings in its ship's `.nav.json`, and the relay `data/starbases.json`, `users.json` and `sessions.json`, each once: the files are left as they were, and not written after that.

To go back to the files: take `"database"` out of `data/settings.json`. The files are as they were when the database took over (the backups in `backups/` too).

A database that can't be reached is said in the log, and waited for: the relay doesn't start serving, and each ship's computer tries again every 10 seconds. The game never quietly plays from the files instead.

## What's where

| | Files | Database |
|---|---|---|
| Designs | `config/ships/<class>.json` | `classes.design` (every field, as the file has it), with its systems and links (`class_systems`, `class_links`) |
| Star chart | `config/starsystem/<id>.json` | `star_systems`, `stars`, `planets`, `chart_objects` |
| System library | `config/system-types.json` | `base_systems` (info, heat, defaults), `effects`, `game_rules` |
| A ship's save | `shipcore-data/<ship>/.nav.json` | `ships.state` (and its class, position and game) |
| Starbases, relays | `data/starbases.json` | `ships.state`, as vessels of class starbase or subspace-relay |
| Accounts, sessions | `data/users.json`, `sessions.json` | `users`, `sessions` |
| Settings | `data/settings.json` | (stays a file: it says where the database is) |
| Ships' libraries | `shipcore-data/<ship>/` | (stay files) |

The admin page's design editor saves to the database and to `config/ships/<class>.json` (its copy for git, and what the supervisor reloads on). At start, the relay says if a design in `config/` isn't what the database has (the database's is used).

## Writes

Each cycle of writes (what's waiting: a ship's save, the starbases', the accounts' changes) is one transaction: all of it or none, so a crash or an error part-way leaves the database as it was. Rows are taken in one order (accounts, starbases, then ships by name), and a deadlock or a lock wait that timed out is tried again. Every table is InnoDB. A write that fails (the database away) is kept, the newest of each kind, and tried every 5 seconds; what's waiting is written before the relay or a ship's computer stops.

The ship's computers in one supervisor share one writer, so saves that are waiting together (both ships of a dock, say) go in one transaction; each is still its own computer's save, so two vessels' saves aren't yet guaranteed to be in the same transaction.

## Running it

The connection comes from `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` and `DB_NAME` in the environment, or else from `"database"` in `data/settings.json`.

```
node tools/db.js migrate          # db/schema.sql, db/seed.sql (safe to run again)
node tools/db.js load             # config/ into the database: the designs (their graphs as the relay builds them), the star chart, the system library
node tools/db.js export           # the other way: the database's designs and star chart into config/ (for git)
node tools/db.js check            # each class read back is the relay's graph
node tools/db.js show runabout    # a class's systems, merged (or: show runabout console-helm)
```

`load` replaces the designs in the database with `config/`'s: a design saved from the admin page since is in `config/` too, so nothing's lost. `migrate` refuses to drop a table from the first draft (`systems`, `system_properties`, `default_properties`) if it holds rows.

`node tools/bench.js` times the files against the database (the game's start, a ship's save written and read), the graph solver against the path tracer, and the path tracer in JavaScript against SQL, in `startrek_test`.

The tests use the database `startrek_test` (`DB_TEST_NAME`), never the game's: `test/db.js` (the schema, the round trip, the transactions, bringing the files in) and `test/db-game.js` (the relay and a ship's computer on the database, through restarts). They're skipped without a database.

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

These tables are laid out so a database event can move them by itself. There are no events yet; the server's `event_scheduler` is ON. Each world tick an event runs is to be one transaction.

| Table | What an event would do |
|---|---|
| `orbits` | Move each planet's `x`, `y` along its orbit (radius, period, phase, epoch). |
| `starbase_stock` | Restock what a starbase holds, toward its capacity, at its rate. |
| `timers` | Fire what's due: a repair done, a convoy arriving, once or repeating. |
| `world_history` | Snapshots, for history and replays. |
| `ships.mothballed`, `ships.state` | A laid-up ship's slow changes (its batteries draining). |

The relay keeps the fast ship ticks (the power solver, combat, helm). The database's events would take the slow world ticks.

