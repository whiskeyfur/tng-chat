# The ship designer

`/shipdesigner` (Admin, Ship designer): a vessel's design file (`config/ships/<id>.json`, a graph: [ship-graph.md](ship-graph.md)) edited as nodes and wires, on [litegraph](https://github.com/Comfy-Org/litegraph.js) (the ComfyUI fork, 0.17.2, served from `node_modules` like d3). Admin only, like the layout designer; not LCARS-styled.

| In the graph | In the designer |
|---|---|
| A system | A node, coloured by its role, with **one input and one output**; the input takes any number of wires. Its title is its name; its id and its effects are the tags above it. Its panel has the rest of the system (type, parent, place, via, key, count, consumes, produces, capacity, creative, effects), and lists the wires in and out. |
| What a system draws from another (`upstream[id]`) | **One wire per pair, a bundle**: it carries a resource each (power, EPS, fuel, heat…), each with its own pull, push, connect, rate, pushRate, pri, min and why. Click a wire's centre to edit the bundle: add or take out a resource, set its settings. A new wire carries what the two have in common (power, if nothing). Wires are coloured by state (the strongest of the bundle's: auto, true, warn, false) or by resource (white for several). |
| Child systems (`systems`) | A box round the system and its parts. Parent, in the node's panel, moves one; Regroup redraws the boxes. |
| Features (effects) | The node menu (right-click the canvas, or double-click to search): a node per feature (the effects listed in ship-graph.md and any other a design uses) and one with none. litegraph's own nodes are taken out. A new node gets that effect (`{}`, its parameters in the panel) and the `system` type (`console` for a seat). |
| The vessel's own fields | The panel with nothing selected: its name, kind, places and the rest (JSON). |

- **Check** runs the checker as saving does (`check`, then the design fields worked out of it, as the relay loads them). It also says whether the graph is **stable**, as `node tools/ship-graph.js --check` does: until step 4c/4d, parts of the relay still read the old design fields, and a system they have no table for (a new radiator, say) plays partly as the graph rebuilt from them. That's a warning, not a refusal.
- **Save** (Ctrl+S) refuses a graph with problems; otherwise it writes the file through `config.saveShip`, keeping the old one in `config/ships/.backup/`, and the supervisor reloads the relay. A design that hasn't changed isn't rewritten. **Save as** writes a new design; **New** starts an empty one.
- Positions are the designer's own, in `config/layouts/ships/<id>.json` (not read by the game, and the supervisor doesn't reload for them). A design with none is laid out by what feeds what: a column a hop right of what each system draws from, heat left out, a system's parts under it. **Auto-arrange** does that again.
- **Hide heat** stops drawing the wires that carry only heat (every system to the coolant loop).

Opening a design and saving it without changes writes back exactly the same file (`test/shipdesigner.js` checks every design).

The server side is `tools/ship-designer.js`: `GET /api/ship-designs` (the designs and the type library), `GET /api/ship-designs/<id>`, `POST /api/ship-designs/check`, `PUT /api/ship-designs/<id>`.
