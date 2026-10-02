# tng-chat

Starship comms in the browser, on LCARS consoles. A small Node server, the comm relay ("Subspace Relay Station 47" unless you set `RELAY_NAME`), serves the pages, keeps track of who is aboard which ship at which station, and relays call signaling. Ship's computers (`tools/shipcore.js`) keep ships alive and hold their libraries. Audio, chat and files go peer-to-peer over WebRTC: each call is one `RTCPeerConnection` per other participant, carrying the audio track plus two data channels.

## Run

```sh
npm install
npm start                                  # the relay (http://localhost:8085; PORT, RELAY_NAME to change) and a ship's computer for every ship saved in shipcore-data/
npm start -- Enterprise "K'Vatch"          # ... or for just these ships
npm run relay                              # the relay alone
npm run shipcore -- Enterprise "K'Vatch"   # a ship's computer on its own: no ship's computer, no ship
```

`npm start` runs `tools/supervisor.js`, which also restarts everything when the code changes: 5 seconds after the last change to `server.js`, `tools/*.js` or `data/*.json`, every console is told to reload, the relay and the ship's computers restart, and each console signs back in as who and where it was (calls aren't resumed: call or join again). A change to `public/*` only reloads the consoles. Ship state comes through in each ship's `.nav.json`. (With `npm start` running the ship's computers, there's no need to start them by hand as well.)

Everyone uses the same page, http://localhost:8085:

1. **Start a ship's computer** for each ship (above). A ship exists only while a ship's computer runs it; the ship list on the sign-in screen shows exactly those ships, for everyone, ops included.
2. **Take the ops station:** enter your name, pick the ship, pick **Operations** as the station.
3. **Report aboard:** enter a name, pick a ship from the list, pick a station (Captain, First Officer, Helm, Tactical, Security, Engineering, Medical, Science, Communications, Transporter, Crew). Names only need to be unique within a ship.

`operator.html` still works as a link to the Operations sign-in.

The relay stores nothing on disk; ships and their libraries live on ship's computers (see below). Ships without ops on duty show "(ops offline)" in the list. If a ship's computer goes offline, the people already aboard stay on and keep their calls, but nobody new can sign in to (or be beamed to) that ship until a computer runs it again. `MAX_UPLOAD_MB` changes the upload limit (default 200).

### Hosting the pages elsewhere (GitHub Pages)

The pages in `public/` are static, so they can be hosted anywhere, for example GitHub Pages, as long as they can reach a running `server.js` (the comm relay):

```sh
node tools/export-pages.js ../whiskeyfur.github.io/stchat wss://relay.example.com
```

That copies `public/` into the folder and writes `config.js` with the relay address. Without one, people enter it in the **Comm relay** field on the sign-in screen (remembered per browser), or open the page with `?relay=wss://relay.example.com`. Pages served over `https://` (like github.io) need a `wss://` relay, for example the server behind a TLS reverse proxy or `ngrok http 8085`; a relay on `localhost` also works for local testing. The library endpoints allow cross-origin requests, authenticated by the session token.

Browsers only allow the microphone on `https://` or `localhost`. To try it across machines, put the server behind HTTPS (for example a reverse proxy, or a tunnel such as `ngrok http 8085`); the pages switch to `wss://` automatically.

## Crew consoles

Each crew member gets an LCARS console for their station, styled with `public/lcars.css` (copied from `../lcars-base`). The displays suit the post, with simulated telemetry:

| Station | Displays |
| --- | --- |
| Captain | **command** (alert status: condition green, yellow or red alert; orders to all hands), **ship status** (real: alert, shields and their strength, hull, speed, weapons, warp core, damaged systems; **self-destruct**), tactical plot, **department readiness** (how many are on duty at each station aboard: green when manned, red when not), senior staff on duty, captain's log |
| First Officer | **reassign crew** to any station, duty roster (who is actually aboard), department readiness (real, as for the Captain), ship status, duty log |
| Helm | **navigation**: the sector map, course (a ship, a starbase, or click the map for a waypoint), **Dock** at a starbase and speed (impulse, warp 1-9), Engage / All stop, courses plotted by Science; forward view starfield at the ship's real speed; helm systems |
| Tactical | **weapons** (target lock, arm and fire phasers, photon torpedoes), shield grid (real shield strength), **shield control** (raise/lower the ship's shields), targeting scan |
| Security | **security control** (transporter lockout force field, confine crew to quarters, beam-in alerts), internal sensors deck grid, force fields, security log |
| Engineering | side view of the ship with the warp core, warp field harmonics, **power distribution** (what engines, shields, sensors, transporter, weapons and life support ask for), **power grid** (warp core, EPS taps, batteries, solar, dock power, antimatter containment, Bus A and Bus B), **damage control** (damage to each system and the hull; direct repair crews) |
| Medical | patient monitor with ECG and vitals, neural activity, **sickbay** (admit and discharge crew; patients are off duty), cellular analysis |
| Science | **long range sensors**: the sector map and every contact on sensors with distance and speed, **Scan** (distance, position, heading and speed, shields and their strength, hull and damage, power signature, ops, life signs by station) and **Plot course** for Helm; spectral analysis, anomaly readings, science log |
| Communications | **data links** (request a link with a ship in range, accept or decline requests, close links: as ops can), and deleting from the ship's library; **comm traffic** (no listening in, metadata only: the ship's own local calls in full; radio calls and hails between vessels, ship to ship only, when one end is within radio range and our radio has power; nothing inside another ship and nothing carried over a data link; all-hands broadcasts on the ship and its data network), subspace bands, carrier signal, message traffic |
| Transporter | transporter controls (beam crew to another ship), transporter pad, pattern buffer |
| Crew | ship schematic, ship status, deck status |

Every console fits the window: there's no page scrolling. The left-hand menu switches between full-window screens: **Comms** at the top, then one screen per display; at the bottom, on every console, **Console log**, **Station** and **Library**. Long lists scroll inside their own panel.

Comms opens an LCARS modal, the same for every role, ops included:

- **Directory:** everyone you can call. That's your ship (ops first, as **Call ops**), plus every ship on your data network.
- **Call panel:** incoming calls with Accept and Decline, then mute, hang up, chat and files (any size, sent in 16 KB chunks). The microphone is only requested once a call connects.
- **Subspace radio:** search internet radio stations (the free, community-run [Radio Browser](https://www.radio-browser.info/) directory) or tune any stream URL, and listen on your console. During a call, **Patch into call** mixes the station into what you send, alongside your mic (Mute still mutes just your mic), so everyone on the call hears it; the call's chat notes when someone patches radio in or out. Patching needs the station's server to allow cross-site access (CORS), which many Icecast servers do; stations that don't still play locally, with Patch disabled. Pages served over https can only play https streams. The radio search and streams go straight from the browser to radio-browser.info and the station's own servers.
- **Ship's radio:** Communications and ops get **Ship's radio** and **Fleet radio** buttons for the station they're playing: every console aboard (or across the data network) then plays it, shown in a bar at the top of the screen with a local Mute. **Ship's radio off** switches it off. Crew who come aboard later hear it too.
- **Messages:** text anyone you could call, no call needed: tap **Msg** by one or more names in the directory (a group), type, Send. Messages show under the directory with who they went to, and **Reply** answers everyone in a conversation. The Comms button counts unread messages. Local RF carries them aboard, radio between ships.
- **How calls between ships travel:** a crew member calling someone on another ship of the data network goes over the **data link** (private; it needs both ships' subspace relays). When ops put a hail through they pick **Route by radio** or, if a data-link path joins the ships, **Route by data link**. A data-link call whose link breaks carries on by radio if the ships are in radio range, otherwise it ends.
- **Call waiting:** while you're in a call, a second caller shows up as "call waiting" with three choices. **Ignore** tells them you're busy. **Switch** hangs up your current call and answers them. **Join** brings them into the call you're in, so everyone hears everyone. If your call ends while someone's waiting, their call rings. Anyone else calling while you're busy, ringing or dialling hears busy.
- The modal opens by itself for an incoming or waiting call, or when an operator puts you through. Calls carry on while it's closed, and the Comms button shows the call state.

## Stations, transporters and shields

- **Back and Home:** the bottom-left corner goes back to the screen shown before, at this station (a station change starts afresh, so Back never crosses stations; its label dims when there's nothing to go back to). The top-left corner goes Home, to the station's main screen. **Comms** sits just above Console log, then Library, then **Station** at the very bottom.
- **Start somewhere new:** shift-click your name and ship in the header: you sign out to the sign-in screen (leaving the ship and any call), name kept, ship, station, screen and menu forgotten so nothing signs you back in.
- **Refresh or restart:** a console that reloads (a refresh by hand, or the relay restarting) signs back in as the same person at the same station, on the screen it was showing.
- **Change station:** the **Station** screen is a tap per station: tap one to move there, **Operations** included (it asks for the authorization code if the relay requires one), and operators can move from Operations to any other station. Every vessel's list shows every station, Operations included; the one you're at is greyed out. Docked with a starbase or another ship, the Station screen also lists that vessel's stations: tap one to walk across the dock to it, its Operations too (you leave this ship's comm net and report aboard the other, so your call ends; no transporter, and Security isn't alerted). Your console changes to the new station; calls in progress carry on. A ship can have several operators on duty, and any of them can route hails, manage data links, transfer calls and so on; the ship only loses off-ship comms when the last one leaves.
- **Transporter:** the Transporter console is all taps: who to beam (anyone aboard, themselves included, but not the ops station), a **lock** on the destination (another ship in the list, or this one: site to site; tap it again to let go) and which station they arrive at (or the same station). Then push all three **energize sliders** to the top, as on the old Constitution-class consoles (the only sliders anywhere): the transporter energizes for 5 seconds and the person moves at the end of it. Its power follows what it's doing: nothing with no lock, 50% while it holds one, 100% while energizing. It needs the full 100%: with its limiter under 100, or the bus unable to supply it, it won't energize, and if power falls short (or the destination drops its shields, leaves range, ...) during the 5 seconds, the beam fails and the person stays put. A lock on another ship drops if it leaves transporter range. Beaming drops the person out of any call they're in (the others stay connected). To another ship they leave this ship's comm net and report aboard the other ship with the same name, at the station picked; both ships' ops see them leave and arrive. Beaming is refused if someone with that name is already aboard the destination.
- **Shields:** the Tactical station raises and lowers the ship's shields. While a ship's shields are up, nobody can be beamed off it or onto it. Shield state shows on Tactical's shield grid, in the transporter's ship list and on the ops Status screen.

## Navigation and range

Ships have a real position in a 1000 × 1000 sector, flown by their ship's computer (new ships start cold, docked at a random starbase: see Supplies and cold starts; `--position x,y` sets where instead, and `--warm` starts them powered up and fuelled). **Helm** sets course and speed: impulse is 0.5 units a second, warp *w* is 2·*w*^1.8 (warp 9 crosses the sector in about ten seconds); heading for another ship tracks it and stops 5 units short. **Science** watches everything within **sensor range (600)**, scans ships and plots courses that Helm can engage with one click. Distance now matters everywhere:

- **Hard line:** vessels docked together (a ship at a starbase, or two ships) are always in data-link reach of each other, through the dock, whatever their sensors or subspace relays.
- **Subspace range (400):** hails, data links and transfers to another ship need it. Ops only list ships in range to hail or link, and a data link drops when the ships drift out of range.
- **Transporter range (20):** beaming needs the ships close: have Helm intercept the other ship first.

**Autopilot:** every ship on sensors becomes a **known contact**, remembered with where it was last seen. Helm's Autopilot taps list the known contacts and the starbases: tap one and the ship's computer flies there at the speed set (nobody needs to stay at Helm). It intercepts a ship it can see and heads for its last known position when it can't (picking up the intercept again if the ship comes back on sensors), and docks on arriving at a starbase. Besides **Go to**, the autopilot can **Follow** a ship on sensors at a range picked by tap (10, 25, 50, 100 or 200 units) or **Match** its heading and speed; both stop, with a note in the log, if the ship leaves sensor range. Any manual Helm order takes it off autopilot.

When several computers run one ship, the relay picks one to fly it; the others keep a copy of its position and the next one takes over if it stops. Positions are saved in `<data>/<ship>/.nav.json`.

## Command, security and medical

- **Captain:** sets **alert status**. Red alert turns the frame of every console aboard red, shows a "Red alert" bar and raises shields if they have power; yellow alert turns them gold; condition green clears it. **Orders** go to every console aboard as a bar to acknowledge.
- **First Officer:** **reassigns** any crew member to another station (not ops) by order: the crew member gets "Report to …" to **Acknowledge** (they move then, as walking would: force fields hold) or **Decline** (the First Officer is told). The First Officer sees it pending until answered. The First Officer can also give orders like the Captain.
- **Orders:** the Captain's and First Officer's orders go to everyone aboard to acknowledge, except whoever gave them (and the Captain, for the First Officer's); acknowledgements come back to the giver as a tally.
- **Security:** **force fields**: tap a station (Security's own too) to isolate it: nobody walks in or out (the Station menu, or across a dock), while whoever is inside keeps full use of the console; the transporter still beams people in and out. Tap again to release it. The emitters are a low-power load under Security (5 per isolated station), and without power the fields drop. A **transporter lockout** (force field) refuses anyone beaming aboard; every beam-in otherwise raises a **beam-in alert** for Security. **Confine to quarters**: a confined crew member can only call Security, Medical or ops until released.
- **Medical:** **admits** crew to sickbay and **discharges** them. Patients are off duty: department readiness doesn't count them, and the Comms directory and rosters mark them.

## Power (Engineering)

Engineering has three screens for power: **Power distribution** (what each system asks for, on light bars), **Power grid** (where the power comes from) and **Damage control**.

### Power distribution

A light bar per system is a **limiter**: the most that system may draw, 0–150 (default: engines 80, plasma injectors 80, shields 60, sensors 100, transporter 100, weapons 50, atmospheric processors, thermal regulation and gravity generators 100 each, replicators 40, recreation 10). Ten segments run 0–100% of the system's rating, then five orange ones (110–150%) are emergency **overdrive**: it does more (sensors reach further, for one), but running past 100% damages the system, faster the further over, and it doesn't repair itself while overdriven. Segments are lit for power actually in use, dim for allowed but not drawn, dark above the limit. Press a segment to set the limit; press the top lit one again for 0. Damage takes the same share off what a system can draw; **Route power** sends it. The panel shows the demand on each bus before it's routed. What a system actually gets depends on the grid (a bus short of power browns out) and on damage, and every station feels it:

- **Engines** and their **plasma injectors** (under Engines at Helm, EPS power) set the top warp speed together, the weaker of the two deciding: 100 is warp 9, 80 warp 7.2; no injector power, no warp (warp also needs the warp core online). Impulse comes from the impulse drives instead. Helm's speeds out of reach show "(no power)"; losing power slows a ship that's already going faster.
- **Sensors** scale all three ranges: sensor range (600), subspace range for hails and data links (400) and transporter range (20) at 100; at 50, half of each. Hails and data links need *both* ships' ranges to reach, so the weaker one decides; a link drops if a power cut takes the ships out of range.
- **Shields** need at least 20 to be raised, and drop if their power falls below that.
- **Transporter** under 100 can't energize (it draws by state: 0 idle, 50 locked, 100 energizing).
- **Life support** under 50 puts a flashing warning on every console aboard.
- **Weapons** charge the phaser banks (see Combat). They only draw power while the phasers are armed.
- **Replicators** (a medium load) and **recreation** (holodecks; a small one): Crew consoles show them online, rationed (replicators under 20) or offline/closed. Cutting them is an easy way to save power or run quiet.

### Power grid

Three low-power buses, **A**, **B** and **C** (300 each at most), and the high-power **EPS** (1000) carry the ship's power. The Power grid screen is a table: a row for each station's console, with the systems it controls indented under it (Engineering's rows hold every power source, the EPS taps and the crosslink, each with its subsystems a level deeper); a column each for Bus A, B, C and the EPS; each cell a tie checkbox with the power through it (+ supply, − draw); and a footer with each column's used / available / max.

| Source | Gives | Ties |
| --- | --- | --- |
| Solar collectors | 25 | any of A, B, C |
| Dock power | 700, while docked at a starbase | any of A, B, C |
| Docked ship | what a ship docked with us sends | any of A, B, C |
| Port and starboard impulse drives | 75 each, burning deuterium | EPS |
| Warp core (M/ARC) | 650, burning antimatter and deuterium | EPS |
| Battery A, B, C | one per low bus, fixed to it: up to 100 each (1000 stored), only when nothing else covers that bus; recharge from its surplus; a **main breaker** (tap) puts each in or out of service (open on a cold ship) | its own bus |
| EPS pressure | the EPS manifold's plasma pressure (1000 stored): up to 300 to cover an EPS shortfall, built up from surplus EPS generation (100 a second); starts at 0 | EPS |

Sources are drawn on in this order: a docked ship's power, solar, dock power, the impulse drives, the warp core; the stores (batteries, EPS pressure) last of all, after every other source's output has been shared out. The stores sit in one row under the table's column headings (charge or pressure %, + covering a shortfall, − charging), with each battery's breaker. The column headings and the used / available / max line are sticky, each with a thick bar above and below.

- **Systems draw what they use**, up to their limiter (the light bar's lit segments are power in use, dim ones allowed but unused; at 0 a system draws nothing): the transporter by state (0 idle, 50 locked, 100 energizing), weapons while armed (all they may while the banks charge, a trickle to hold them full), shields while up or recharging, the warp drive and its injectors by the warp being made, the deflector while moving, sensors as far as they're allowed (overdrive reaches further), and the rest (life support, hull fields, replicators, recreation) steadily at their rating. Checks made before a system is in use (raising shields, going to warp) look at what it *could* draw. A ship's sensor signature is full at 300 drawn.
- **Hull fields:** the **structural integrity field** (35) and **inertial dampers** (22), on the EPS under Engineering. The dampers need the SIF at 50%; the warp core needs the SIF at 50% to start (so a cold start powers the EPS from an impulse drive first); impulse needs SIF 60% and dampers 80%; warp needs both at 90%.
- **Sensors:** the **long-range sensors** (22, EPS) set sensor and subspace range; the **lateral arrays** (10, low bus) see a quarter as far on their own and set transporter range. The **navigational deflector** (80, EPS, under Helm) needs the long-range sensors, and warp needs it at 90%.
- **Life support** is a parent row with three systems of its own under it, each with its own ties and light bar: **atmospheric processors** (10 at 100%), **thermal regulation** (8) and **gravity generators** (20), and **emergency lighting** (1). Solar alone (25) runs the first two with a little over to charge batteries, not gravity as well. Life support's level (the crew warnings) is the lower of atmosphere and thermal. Older saves' one life support setting and ties go to all three.
- **Fusion reactors:** the two impulse drives and two **aux fusion reactors** (75 each to the EPS through their Power output tie). The deuterium feed makes deuterium available; each reactor's own **deuterium pump** (low bus, 5) pulls it into its **fusion reaction chamber**, building the chamber's pressure (20% a second; without the pump or the feed it falls 10%), shown on the chamber's row. **Light** primes the chamber, which lights at 30% (10 from its low-bus ties to light, 5 to keep running) and flames out below it or without its power; an unpowered pump means a flameout even with the feed up. An **EPS tap** row: on, a running reactor powers its chamber and pump from an energized EPS; off, they run on their bus ties. The impulse drives add **accelerators** (a throttle light bar, 0-100) and **driver coils**: Low gear builds impulse quickly but tops out at a quarter, High gives full impulse, built more slowly; then the maneuvering thrusters tie.
- **Deuterium feed:** isolation valves (a tap), cryo-pumps and slush heaters (low bus, 2.5 each while the valves are open): with both powered and the valves open, feed pressure builds (10% a second), otherwise it falls (5%); at 30% deuterium is available to the reactors' pumps (the warp core's injectors want 80%). Tank level and slush temperature show on its row.
- **EPS manifold:** the EPS carries nothing until it's pressurized: it charges from 100 or more of EPS generation (both impulse drives, or a drive and an aux reactor, or the warp core; about 10 s), then covers shortfalls from its pressure and tops up from surplus. When the pressure runs out it collapses and has to be pressurized again.
- **Antimatter containment** is a field: it holds at strength (climbing back to 100%) while it has its 20, from its feeds or, when they fail, from its own **internal reserve** (about 9 minutes; recharged from the feeds at 5 a second). With neither, the field falls 5% a second, and below 20% the pods breach. The warp core's **antimatter transfer conduit** (a low-bus subsystem, 5) only pressurizes with the field at 95%, and the core needs it to start and run.
- **The warp core** (Engineering's **Warp core** panel): **Cold ignition** opens the injectors (they need the containment field at 95%, the deuterium feed at 80% and the antimatter transfer conduit) and runs the reaction at 10% or less on a deuterium-rich mixture (15:1 or richer) until it's self-sustaining (6 s); then the rate climbs (5% a second) to the **reaction rate** light bar's setting. Output is up to 1000 × rate × efficiency; efficiency comes from the **mixture** (best near 12:1; taps 10, 12, 15, 20:1), the **dilithium alignment** (it drifts while running: **Trim**, or **Auto-trim**, which needs all three computer cores) and the **crystal integrity** (it wears above 80%). Readouts: output, efficiency, temperature, containment field, alignment, crystal, feed pressure. A hot core (over 90%) wears the containment field down; a live reaction with the field under 35% starts a **45 s breach countdown** (cancelled above 60%, or if the reaction stops). Under 50% feed pressure it flames out. **SCRAM** stops it at once. The **plasma transfer conduits** to the nacelles (a tap on the warp core's grid rows) must be open for warp, and top warp follows the core's output (650 or more for all of it). Engines are now the **warp field coils** (300 at 100%).
- **Transporter subsystems** (under the Transporter console, low bus): **pattern buffers** (15; they need the lateral sensors), **targeting scanners** (2; for a lock), **Heisenberg compensators** and the **biofilter** (2 each), and the **energizing coils** (5, while energizing). A **level-3 diagnostic** (16 s, every subsystem powered; **Run level-3 diagnostic** on the Transporter console) must pass before anyone is beamed, and the pattern buffers losing power invalidates it. Older saves: passed.
- **Computer cores:** three, under Engineering (a parent row, each core a low-bus subsystem drawing 2, on A, B and C by default) with a **Boot** / **Shut down** tap. A core boots in stages (POST, LCARS kernel, ODN handshake, isolinear verification, subprocessor sync: about 14 s) and crashes if its power fails (boot it again). The EPS taps (the flow regulators) need at least one online; text messages need one online at each end (greyed out with the reason otherwise). Startup's step 5.
- **Comms by power:** calls aboard need Local RF; calls over a data link the subspace relays; calls by radio both radios. A call in progress drops if its carrier loses power at either end.
- **Every column balances:** a source's cell shows all it gave, battery charging included; the **EPS taps** row shows what flows down each tap (− in the EPS column, + in the bus's), so sources + taps = loads + charging in each column (a crosslinked pool balances as a whole).
- **Two classes:** everything ties to the low-power buses or to the EPS alone, never both. Low-power loads (consoles, life support, sensors, replicators, recreation, transporter, containment, the subsystems) and sources (solar, dock power, docked-ship power, batteries) may tie to any combination of A, B and C: a load is split evenly between them, a source's output shared evenly (batteries charge from and drain into each). Engines, shields, weapons and the tractor beam draw on the EPS alone, so they need the warp core or an impulse drive.
- **EPS taps:** one light bar per low bus sets how much EPS power may flow down into it (default A 300, B 300, C 0; a cold ship starts at 0).
- **Three orders**, by taps over the table (each console remembers its choice): **Operations** (power sources: dock power, docked ships and solar; then the bus crosslink; then every console with its systems, Engineering's warp core and impulse drives under it), **Startup** (a numbered checklist from a cold ship: dock power and solar, bus batteries and EPS pressure, crosslink, Engineering console, antimatter containment (with an **Onboard antimatter** button: fills the tank from the dock, refused unless containment's feed has power), impulse drives, EPS taps, warp core, then the other consoles; each step has a Cold / Startup / Online / Tripped chip and is locked, greyed with the reason, until what it needs is up: a tap there is refused with "Unable to comply"; *Ready for departure* when it's all running) and **Shutdown** (the same steps reversed, ending with dock power, with **Offload antimatter** to empty the tank to the dock; the crosslink, Engineering console and sources stay locked until the warp core and impulse drives are down; *Cold ship* when it's all off). Only the order changes: every row keeps its controls. The warp core's **Start / Stop** are on its row in the table; **Eject core** is in Damage control (press twice within 5 s); replacing the core waits for the shipyard's drydock.
- **Bus crosslink:** a chain, A–B–C: check A+B, B+C or all three (A and C only link through B, so A+C alone is refused; power from A to C passes through B). Power crossing it shows as a bar in the gap between two buses' checkboxes, pulsing the way it flows (still with reduced motion) with the amount in the middle.
- **Breakers:** tie more sustained load to a bus (or pool) than it carries and its breaker trips loads off it at random, one at a time, until it fits; Engineering re-ties them. The console log says what tripped. Startup surges don't count, and containment and the warp core's constriction never trip.
- **Serving order** when supply is short: antimatter containment first, ahead of everything. Then each bus serves the loads tied to it alone, in priority order (the reactors' subsystems, consoles, Communications, power for a docked ship, then life support, sensors, shields, engines, weapons, tractor beam, transporter, replicators, recreation), and charges its batteries; then loads split over two buses; then over three. A source tied to several buses splits its output evenly, but a share one bus can't use goes to its other buses that are still short; only what's left after that charges batteries from it.
- **Systems with subsystems** (the warp core, the impulse drives) show their status and controls but have no ties of their own: their subsystems carry the ties. The warp core's output reaches the EPS through its **power transfer conduits** (an EPS tie; they fail, cutting the core's output, at 50% damage); each impulse drive's through its maneuvering thrusters.
- **The warp core** needs its magnetic constriction (60 to start, 20 running), deuterium pump (10) and antimatter injector (10), all low-power loads, to start (10 seconds) and to keep running, plus antimatter and deuterium aboard. It shuts down if any of them fails or fuel runs out. Warp needs it.
- **Impulse drives:** each is its own reactor. Start it on bus power for its deuterium pump (10, for 5 seconds); then it powers itself. Each running drive gives half impulse. Its **maneuvering thrusters** tie to the EPS: tied in, whatever share of the drive isn't thrusting feeds the EPS (all stop: all 75; half impulse: half; full impulse: none); untied, the drive only thrusts.
- **Communications** has three subsystems (10 each, default Bus B): local RF (calls aboard), radio (hails and calls between ships) and the subspace relay (data links). Without power, that service stops.
- **Subsystems** can be damaged in combat and fail outright at 50% damage until repaired.
- **Buses** (A, B, C and the EPS) can be damaged in combat too, and damage control repairs them: a bus carries its condition's share of its max (at 50%, half; at 0%, nothing), and its breaker trips against that. The table's footer and the damage control list show each bus's condition.
- **Antimatter containment** draws 20 while there's antimatter aboard, from its feeds in turn. With antimatter aboard it can't be left with no feed: only self-destruct switches it off. With none aboard it can be switched off safely, and taking on antimatter needs a feed set first. With no power for 5 seconds the core **breaches** and the ship is destroyed; every console counts it down.
- **Ejecting the core:** Engineering can eject the warp core and antimatter pods (with a confirmation). No more breach (ejecting during a breach countdown saves the ship), but no more core power either.
- **Replacing the core:** docked at a starbase, with the core shut down, Engineering can **replace the warp core and antimatter pods** (or install them after an ejection). The pods come full if a containment feed is set, empty if not.
- **Power between docked ships:** each ship's Engineering offers the other some power (a light bar, 0 to start, up to 500). Whoever offers more sends the difference, out through the docked-ship tie; the other ship takes it in through its own. A starbase gives every ship docked with it its full dock power.
- **Dark consoles:** a console whose bus can't power it goes dark: its station displays black out and it can't give orders. Comms still work (combadges), and so do the Station screen, Console log and Library. Engineering's grid controls have emergency power.
- **Stealth:** a ship's **power signature** is everything it draws out of 450, and other ships' sensors only see it within their sensor range times that signature (never less than 10%). Cutting power runs quiet, at the cost of speed, shields and weapons; containment, the reactors' subsystems and Communications always draw a little. Engineering's panels and Science's map show the ship's own signature; a scan shows the other ship's. Losing a ship from sensors breaks a weapons lock and Helm's intercept course.

## Supplies and cold starts

- **Antimatter** (tank 1000) and **deuterium** (tank 2000). The warp core burns both for the power it gives (half a unit of each a second at its full 500); the impulse reactor burns deuterium (0.2 a second at its full 150). Engineering's Power grid screen shows what's aboard.
- **Refuel and offload** at a starbase: docked, Engineering picks antimatter or deuterium and an amount and presses Refuel or Offload (50 units a second; starbases have all they need).
- **Docking ports:** every ship has two, **port** and **starboard**; a starbase takes one, another ship one each (starbases have as many as needed). Helm taps which port to use; each port shows what's on it, and undocks on its own. Moving away breaks only the connections that go out of range. Helm needs working maneuvering thrusters (an impulse drive running) to dock at all.
- **Ship to ship:** Helm docks with another ship within 10 units, both at all stop, its shields down. If that ship is crewed and its thrusters work, it's a **request**: its Helm gets Accept / Decline (30 seconds); a ship with nobody aboard, or no working thrusters, is docked with regardless. Starbases always accept. Each connection has its own supply transfers and power offer (Engineering's grid shows them by port). A ship docked between a starbase and another ship passes nothing on by itself: power reaches the far ship only through its own offer. Walking across reaches only the vessel directly docked.
- **Auto refuel:** two toggles on Engineering's supplies, antimatter and deuterium (each off by default, kept with the ship; lit when on): while docked at a starbase, each is topped off at 50 a second (antimatter only with a containment feed set).
- **Cold starts:** a new ship (unless its computer says `--warm`) and a destroyed one when it's rebuilt start docked at a random starbase, cold iron: reactor and drives offline, nothing tied in anywhere (sources, consoles, systems, subsystems, thrusters), crosslink off, EPS taps closed, no antimatter or deuterium, batteries charged but their breakers open, the EPS unpressurized. Saved ships keep their ties. Every console is dark except Engineering's grid controls. Engineering ties in dock power (to Bus A, Bus B and the EPS: enough for everything), sets a containment feed, refuels and starts the core.

## Starbases

Four starbases sit in the sector: **Starbase 47** (500, 120), **Starbase 12** (120, 860), **Starbase 74** (880, 820) and **Deep Space 4** (860, 160). They're built into the relay: always on the comm net and in the ship list (marked starbase), with no ship's computer needed, so anyone can report aboard one, ops included. A ship's computer run for a starbase only holds its library; the station itself isn't touched. Starbases don't dock (ships dock with them). They show on the sector map, and Helm can set course for one. They don't move, can't be targeted, and have no library unless a ship's computer runs for them.

Starbases are **automated**: a data link request is accepted by itself after 5 seconds (2 seconds with crew aboard to expedite it), and a hail is put through to whoever is aboard (the Captain or Communications first) after 2 seconds; with nobody aboard, the hailing ops gets an automated reply instead. An operator on duty aboard can answer links and hails first, as on any ship. Within 10 units, at all stop, Helm can **Dock**. Docked, a ship gets dock power (for Engineering to tie in), can refuel and offload, restocks photon torpedoes (one every 5 seconds) and repairs four times faster. Going anywhere undocks it.

## Tractor beam (Tactical)

Tactical can lock a tractor beam on a ship within 20 units whose shields are down (raising shields breaks it: that's how a ship refuses a tow). The towed ship follows just behind; its Helm can't engage, and it's undocked if it was docked. The towing ship is held to warp 3, and the beam draws 30 from its EPS: it lets go if that power or the Tactical console fails. So a ship with no core can be towed to a starbase, docked and refitted.

## Combat (Tactical)

The relay runs combat; each ship's computer keeps its hull, shields, damage, torpedoes and power grid settings in `.nav.json`.

- **Lock:** Tactical picks a ship on sensors and locks weapons; that ship's Tactical and Captain are warned ("has locked weapons on us"). The lock is lost if the target leaves sensor range.
- **Phasers:** Tactical **arms** them and the banks charge (20% a second at full weapons power, slower with less; armed weapons draw power, which other ships' sensors see). A full bank fires, up to 150 units, for 15 damage. Standing down drains the banks.
- **Photon torpedoes:** reach 300 units, reload in 5 seconds, hit for 25. Ten carried, restocked only while docked at a starbase.
- **Shields** soak hits while up, draining their strength (less drain with more shield power; strength recharges with shield power). At 0% they fail and drop, and the generators need 10% strength back before they'll raise again.
- **Hull and systems:** with shields down a hit takes off hull and damages one system at random. Damage caps what a system can draw (40% damaged sensors get at most 60, even if 100 is asked for), so it shrinks ranges, top speed and so on. At 0% hull the ship is **destroyed**.
- **Repairs:** everything repairs slowly by itself (four times faster docked). Engineering's damage control can direct repair crews to one system (or the hull) to fix it much faster.
- Every console aboard a ship under fire shows "Taking fire from the …" with its shields and hull; Engineering is told which systems are hit.

## Destruction and self-destruct

- A ship is **destroyed** when its hull reaches 0, when antimatter containment fails, or by self-destruct. The blast damages any ship within 30 units (30 damage).
- The ship is then rebuilt, as good as new, **docked at a starbase picked at random**. Everyone aboard stays aboard and is told what happened; ops logs it.
- **Self-destruct:** the Captain sets it on the Ship status screen (with a confirmation). Every console aboard counts down from 30 seconds (`SELF_DESTRUCT_SECONDS` on the relay changes it), and the Captain can abort until it ends.

## Ship's computers and the library

A **ship's computer** is a small Node program that signs on to the relay *as one or more ships* rather than as a person:

```sh
node tools/shipcore.js [--relay ws://host:port] [--data folder] [--key operator-key] [--position x,y] [--warm] <ship> [ship...]
```

- **Keeps data links up:** a link opened by two operators stays open while either side's ops or ship's computer is there, so it survives everyone leaving the bridge (or the ship). A ship's computer can't start a link; only ops can. With neither ops nor a computer, the ship's links close (calls already going over them carry on).
- **Makes the ship:** no ship's computer, no ship. While one is connected, its ships are in the ship list (even with nobody aboard), so ops and crew can sign in any time; without one, nobody can. (Off-ship comms still need an ops station on duty.)
- **Holds the library:** the **Library** screen (bottom of the left-hand menu) lists the files uploaded to your ship and, across data links, every library on your data network in its own ship folder. Uploads stream through the relay straight to one of the ship's computers, which stores them in `<data>/<ship>/` (default `./shipcore-data`); downloads stream back the same way. The relay never stores files. With no computer online for a ship, its library shows as offline.
- **Work together:** run several computers for the same ship (on different machines, say) and they keep each other's libraries in sync through the relay: a new or changed file is copied to the others, the newest version wins, and deletions are remembered (`.index.json`), so a computer that was offline catches up without bringing deleted files back. One computer can also run several ships.
- Anyone aboard can upload and download; ops can **delete** from their own ship's library. File names are cleaned up (no folders, control characters or leading dots; a taken name gets " (2)"). Uploads and downloads go over HTTP with a per-session token handed out at sign-in. With `OPERATOR_KEY` set, ship's computers need `--key` too.
- To bring in files from an older version that kept them in the relay's `data/<ship>/`, point a computer at that folder: `node tools/shipcore.js --data ./data <ship>`.

## Data links to crewless ships, and remote control

- **Forcing a data link:** a ship with nobody aboard (only its ship's computer) has no one to accept or refuse a data link, so ops' link request opens it at once ("forced"). Crewless ships are listed for ops to link to.
- **Remote control:** like controls like. Over a working data link, a console can run the **same station** aboard another vessel (a ship or a starbase) while that station there is unmanned, whoever else is aboard. Each station screen shows vessel buttons at the top right: one per vessel this console can run, and our own ship at the far right. Tap a vessel and the console shows and controls that vessel's station (a yellow bar says so); tap our own ship to come back. It snaps back by itself, with a notice, if the link drops, someone takes that station there, or that vessel's ops block it.
- **Blocking it:** ops' Status screen has a **Remote control: allowed / blocked** toggle for their own vessel. Ships start allowed, and with nobody at their ops nobody can block it. Starbases start blocked, and their block holds with nobody at their ops; someone at a starbase's ops can allow it (the relay keeps starbases' setting in `data/starbases.json`).
- **Ops too:** an ops console gets the same vessel buttons, to run another vessel's unmanned ops.

## Ops console (Operations station)

Pick **Operations** at sign-in, or open `?station=Operations&name=O'Brien&ship=Enterprise` (or the old `operator.html` link). The page remembers the last sign-in. Ops is assumed to be on the bridge. The operator is aboard as crew at the **Operations** station and has the same Comms menu as everyone. It adds **Transfer to**: hand the call you're in to anyone aboard or on the data network, or to another ship by hail, and drop off the line. A call with several people is handed over whole.

- **Hail · ship to ship:** hail another ship on behalf of one of your crew, yourself included. That ship's operator routes the hail to someone aboard (it defaults to their Captain, and can be themselves), or declines. You can cancel while it's pending. For example: Picard on the Enterprise, via Enterprise ops, via K'Vatch ops, to Martok, Captain of the K'Vatch.
- **Data link:** request a link with another ship. Their operator accepts or declines, and either side can close the link later. Linked ships form a data network (links chain, so three or more ships can share one network). Everyone on it sees everyone on every ship in the Comms directory and can call them directly. The **data network map** beside the controls shows every ship (crew aboard, shields, ops on duty) and who is linked to whom: solid lines are data links, dashed lines pending requests, and colours mark this ship, the ships on its network, other ships and ships without ops. Click a ship to pick it for a link request.
- **All hands:** open a one-way broadcast for someone aboard (the Captain, yourself, anyone), to **this ship** or **the data network** (the fleet). Their mic goes to everyone in range over send-only connections, so listeners hear it on top of any call they're in but can't answer. Everyone sees an "All hands" bar at the top of their console with a local Mute; the speaker gets "On air" with End broadcast, and ops can End it too. Crew who come aboard during it hear it as well.
- **Intercom:** connect two of your crew immediately, without ringing, ending any calls they're in.
- **Conference · patch in:** bring one of your crew into the call another crew member is in, even if it spans ships.
- **Crew roster:** your crew's stations and call status, with Call and Disconnect buttons.
- **Comm log:** arrivals, departures, ships in range, hails, links and operator actions.

The ops menu has Comms, Status (channel readouts and the comm log), Hail, Data link, Intercom (intercom and conference), Crew roster and, at the bottom, Library.

**Authorization code:** by default anyone can take an ops station, and the code field doesn't appear. Start the relay with `OPERATOR_KEY=yourkey npm start` and taking an ops station (at sign-in or on the Station screen) asks for that code, as does running a ship's computer (`--key`). Ops can force-connect people, disconnect them, transfer calls, open data links and all-hands broadcasts and delete library files, so the code keeps crew from making themselves ops.

### When ops drops out

If a ship's last ops station signs off, nobody is cut off. Calls in progress carry on, including calls with other ships, until people hang up, and crew can still call anyone aboard. But no new off-ship communication can start. Other ships can't hail the ship and pending hails and link requests are dropped; its data links stay open only if its ship's computer is running. Crew see "Ops offline". The ship stays in the list, marked "ops offline", while anyone is aboard.

## Test

```sh
npm test
```

Starts the server and drives headless Chromium pages with a fake microphone through crew consoles and ops consoles:

- **Crew calls:** decline; accept with audio both ways; chat; a 300 KB file arrives byte-for-byte; hang-up; a peer going offline.
- **Command, security, medical:** the force field refusing a beam-in and Security's beam-in alert; confinement (can call Security, not the First Officer); the First Officer reassigning bob; sickbay leaving Tactical unmanned until discharge; the Captain's orders, red alert (shields up, consoles red) and condition green.
- **Combat:** Tactical locking on the Defiant (its Tactical warned, the Captain's status shows the lock) and arming phasers; a torpedo draining raised shields with the hull untouched and the tubes reloading; "Taking fire" on the Defiant's consoles; a charged phaser bank hitting with shields down, damaging the hull and a system and capping its power; Engineering directing repairs until it's fixed, and the Defiant's computer saving the damage.
- **Stealth:** the Defiant powering down (replicators and holodecks too, shown offline on its Crew console) drops off the Enterprise's sensors 200 units away (and the weapons lock is lost), then shows up again when it powers up.
- **Starbases:** Helm flying to Starbase 12 and docking; the torpedo fired earlier restocked.
- **Restarts** (`test/restart.js`): a ship stays docked through a relay restart and a ship's computer restart, and a save in the older shapes (open/closed taps, the A-B crosslink, sources on two buses, EPS ties no longer allowed, thrusters off) comes through.
- **Power grid:** the warp core shut down with Bus B's EPS tap closed: Battery B carries Bus B until it's flat, then Bus B is dead (Tactical's console dark and refusing orders, no engines); restarted on dock power, the consoles come back. Ties to several buses at once (the core on A, B and EPS; batteries on A and B), and containment refusing to be left without a feed.
- **Supplies:** the warp core and full antimatter pods replaced at a starbase; the Enterprise offloading deuterium; the Defiant docking with the Enterprise, sending it deuterium, and (offering 100 power to the Enterprise's 30) feeding it the difference; then undocking.
- **Dark consoles and starbases:** a dark ops console still reaching its Station screen; a starbase not docking with itself; a ship's computer run for a starbase leaving the station in place.
- **Cold starts and impulse power:** the Enterprise rebuilt cold (consoles dark) and brought back on dock power; a new ship (the Excelsior) starting cold at a starbase with its consoles dark and no fuel, its core refusing to start without fuel, refused antimatter until a containment feed is set, refuelled, core started; its impulse reactor powering Bus B and holding it to slow impulse.
- **Eject and tow:** Engineering ejecting the core; the Defiant coming alongside and towing the Enterprise by tractor beam at warp 3 (the Enterprise's Helm can't break away); towed back to Starbase 12, released, docked, a new core installed and started.
- **Self-destruct and destruction:** the Captain's self-destruct counting down on every console, then aborted; antimatter containment on a dead bus breaching the core, the Enterprise destroyed and rebuilt docked at a starbase.
- **Power:** the sliders showing each bus's demand before routing; sensors at 20% shrink every range so beaming falls short; no engine power refuses warp; no shield power disables Raise shields; low life support warns the crew.
- **Navigation:** Science scanning the Defiant and plotting a course for Helm; Helm flying out of subspace range at warp 7 (the data link drops, the Defiant leaves hailing range, beaming is out of range), then intercepting the Defiant (back in range, beaming works).
- **Broadcasts:** Communications seeing a hail before it's answered; all hands to the ship (heard, receive-only, other ships don't hear it); all hands to the fleet over a data link, ended by ops; the fleet radio playing on crew consoles and switching off.
- **Subspace radio:** a local test station (a tone) tuned by URL and patched into a call (the outgoing track switches to the mix, the other side sees the note, the call stays up), unpatched back to the mic; a station without CORS plays locally with Patch disabled.
- **Call waiting:** ignore (the caller hears busy), the caller giving up, join (three-way), switch, and a waiting call ringing once the current one ends.
- **Operator actions:** intercom, moving someone, patching a third person in (everyone hears everyone, chat and files reach everyone), one person leaving a three-way call, disconnect.
- **Calls with ops:** crew calling ops, ops transferring the call aboard, ops calling crew.
- **Ship to ship:** each ship sees only its own crew, and stations get their own displays. Then a hail routed to the Captain, a declined hail, a cancelled hail, and an off-ship transfer that the other ship's ops answers and passes on.
- **Data links:** the map showing a pending request then the open link, a call across a data link, closing the link, and the link dropping with ops.
- **Stations, transporter, shields:** changing station (Transporter to Helm, Helm to Operations as a second operator who manages a data link with the first, back to Crew); Communications seeing a call in comm traffic without joining; shields up blocking the transporter; shields down and a crew member beamed to the K'Vatch.
- **Hosting elsewhere:** the library endpoints answer cross-origin preflight requests.
- **Library delete:** crew and other ships' ops are refused; ops delete from their own ship and the file is gone from both computers and from everyone's library.
- **Starbases:** with no ship's computers, only the four automated starbases are offered at sign-in; a hail to one with nobody aboard gets the automated reply; a data link to one is accepted by itself; with a Captain aboard, the starbase puts a hail straight through to them.
- **Ship's computers and the library:** offline with no computer; an upload reaching both Enterprise computers and not the relay, a shipmate seeing it and a K'Vatch crew member downloading it over the data link; access ending when the link closes; a computer that was offline catching up without reviving a deleted file; a computer keeping a ship in the list with nobody aboard.
- **Without ops:** the call in progress carries on and shipmates can still call each other.

If Playwright can't find its browser, set `CHROMIUM_PATH` to a Chromium binary.

## How it works

- `server.js` keeps everyone online by id (`name@ship`, lowercased), with their ship and station. It sends each person the crew list for their data network (just their ship when unlinked), relays call-control and signal messages to a user id, and adds `from` and `fromInfo`. A `call` to someone off your network is refused with `unavailable`. Each ship's ops consoles get a roster of that ship's crew, the ships in range, their links and network, and the open hails and link requests. Hails and link requests live on the server until answered or until a party goes away.
- `public/broadcast.js` handles all-hands broadcasts (send-only from the speaker, receive-only to each listener) and the ship's radio, with the bar at the top of every console.
- `public/radio.js` is Subspace radio; patching uses `voice.setRadio()`, which mixes mic and radio with Web Audio and swaps the outgoing track on every connection (`RTCRtpSender.replaceTrack`, no renegotiation).
- `public/relay.js` finds the comm relay (same server by default, or `config.js`, `?relay=`, or the sign-in field).
- `public/voice.js` is the call engine and call panel. `public/comms.js` builds the Comms modal around it: the directory, plus optional extras like Transfer. `public/library.js` is the Library screen and `public/screens.js` switches screens. All of these are shared by the crew console (`public/client.js`, with the station displays in `public/stations.js`) and, at the Operations station, the ops screens (`public/ops.js`), all on the one console page. Shared console styles are in `public/console.css`.
- The library lives on the ship's computers. They connect with `{type:"shipcore", ships, key}` and report what they hold (`core-index`); the relay merges those, tells computers to copy (`core-get` from one, `core-put` to another, binary frames prefixed with a 12-byte transfer id) or delete (`core-delete`) until they agree, and streams uploads and downloads through. `GET /api/library/<ship>/<file>` downloads from any ship on your data network, and `POST /api/library` (headers `X-Token` and `X-Filename`, the file as the body) uploads to your own ship, and `DELETE /api/library/<ship>/<file>` deletes (ops only, own ship only). The `X-Token` comes from `registered` or `operator-ok`. After every change, the server sends `{type:"library", ships:[{name, own, online, files:[{name, size, modified}]}]}` to everyone on the data network.
- A call can have several people: one `RTCPeerConnection` per other participant, a full mesh, all sharing one microphone stream. For a normal call, the caller sends `call` and the callee sees Accept/Decline; a callee already in a call auto-declines with `busy`. On accept, the callee creates its connection and sends `accept`, and the caller creates its connection and sends the SDP offer. When anyone leaves, the server sends `gone` to everyone, so calls end across ships.
- Every call-control and signal message carries a call id (`cid`). A client ignores messages whose id doesn't match its current call, so leftovers from a replaced call can't disturb the new one.
- Data channels are pre-negotiated (`negotiated: true`, ids 0 and 1). `chat` carries text. `files` carries a JSON header `{name, size, mime}` followed by binary chunks, waits on `bufferedAmount`, and queues files per person.

| Message (client → server) | Meaning |
| --- | --- |
| `{type:"register", name, ship, station}` | report aboard; reply `registered {id, name, ship, station}` or `register-failed {reason}` |
| `{type:"call"\|"accept"\|"decline"\|"hangup", to, cid}` | call control, relayed to user id `to` (`call` only within your data network) |
| `{type:"signal", to, cid, data}` | relay `{sdp}` or `{candidate}` |
| `{type:"status", state, peers, cid}` | your call state and the ids in your call, shown to operators |
| `{type:"merge", caller}` | call waiting, Join: bring user id `caller` (who is calling you) into your call |
| `{type:"change-station", station, key?}` | move to another station aboard your ship; reply `registered`, or `operator-ok` for Operations (`station-failed` if the key is wrong) |
| `{type:"shields", up}` | Tactical only: raise or lower the ship's shields |
| `{type:"helm", dest?, heading?, warp}` | Helm only: `dest` `{ship}` or `{x, y}`, speed `0` (all stop), `0.25` (impulse) or 1-9 |
| `{type:"alert", level}` / `{type:"order", text}` | Captain only: `green`, `yellow` or `red` alert / orders to everyone aboard (`order`) |
| `{type:"reassign", who, station}` | First Officer only: move a crew member to another station |
| `{type:"lockout", on}` / `{type:"confine", who, on}` | Security only: the transporter lockout / confining someone to quarters |
| `{type:"sickbay", who, on}` | Medical only: admit to or discharge from sickbay |
| `{type:"power", power}` | Engineering only: `{engines, shields, sensors, transporter, weapons, lifeSupport}` in percent, totalling at most 450 |
| `{type:"scan", ship}` / `{type:"plot-course", dest}` | Science only: scan a ship on sensors (reply `scan-result`) / send Helm a course (`course-plotted`) |
| `{type:"ship-radio", url, name, scope}` | Communications or ops: put a stream on the ship's (`ship`) or fleet's (`network`) radio; `url: null` switches it off |
| `{type:"bsignal", to, bid, data}` / `{type:"bcast-end", bid}` | all hands: offer/answer/ICE between speaker and listener; the speaker ending it |
| `{type:"transporter-lock", ship}` | Transporter only: lock onto `ship` (yours: site to site), or `ship: null` to let go |
| `{type:"beam", who, station?}` | Transporter only: energize, beaming user id `who` (aboard your ship) to the locked destination after 5 s (`BEAM_SECS`); they get `registered` with `beamedFrom` |

| Message (server → client) | Meaning |
| --- | --- |
| `{type:"ships", ships}` | every ship, `[{name, ops, shields}]`: the sign-in pull-down, transporter targets and shield state |
| `{type:"users", users, ops, network}` | everyone on your data network `[{id, name, ship, station}]`, whether your ship has ops on duty, and the network's ships |
| relayed message with `from`, `fromInfo` | a call-control or signal message |
| `{type:"unavailable", id}` / `{type:"gone", id}` | that user can't be reached / left the comm net |
| `{type:"connect", peers, role, cid}` | an operator connected you with `peers`; `role:"caller"` means you send the offers |
| `{type:"add-peer", peer, cid}` | an operator is patching `peer` into your call; wait for their offer |
| `{type:"force-hangup", reason?}` | an operator disconnected you, or your transfer went through (ops) |
| `{type:"traffic", calls}` | Communications only: calls, pending hails and broadcasts on your data network, `[{state, since, members, to?}]` |
| `{type:"bcast-speak", bid, label}` / `{type:"bcast-add", bid, listener}` | you're the all-hands speaker / connect (send-only) to this listener |
| `{type:"bcast-listen", bid, from, label}` / `{type:"bcast-ended", bid}` | an all-hands broadcast you'll receive (receive-only) / it ended |
| `{type:"ship-radio", radio}` | the ship's radio: `{name, url, by}` or `null` |
| `{type:"nav", own, ships, ranges, maxWarp}` | twice a second: your ship's position, course and power, every ship on your sensors, your current ranges and top speed |
| `{type:"notice", text}` | hail progress, for example "Ops is hailing the K'Vatch for you" |

| Message (operator → server) | Meaning |
| --- | --- |
| `{type:"operator", name, ship, key}` | take the ops station for `ship` (also signs in as crew `name` at Operations); reply `operator-ok {id, name, ship, station}` or `operator-failed` |
| `{type:"connect", a, b}` / `{type:"add", name, into}` / `{type:"end", name}` | intercom, patch in, disconnect (own crew ids only) |
| `{type:"hail", ship, crew}` | hail `ship` on behalf of crew id `crew` |
| `{type:"route", hail, to}` / `{type:"decline-hail", hail}` | answer an incoming hail: connect it to crew id `to`, or decline |
| `{type:"cancel-hail", hail}` | withdraw an outgoing hail |
| `{type:"all-hands", speaker, scope}` / `{type:"all-hands-end", id}` | open an all-hands broadcast for crew id `speaker` to `scope` `ship` or `network`, or end one |
| `{type:"transfer", to}` / `{type:"transfer", ship}` | hand the call you're in to user id `to` (aboard or on the data network), or hail `ship` for the person on the line; you drop off the call |
| `{type:"link-request", ship}` / `{type:"link-cancel", request}` | ask another ship's ops for a data link / withdraw the request |
| `{type:"link-accept", request}` / `{type:"link-decline", request}` | answer a data link request |
| `{type:"link-close", ship}` | close the data link with `ship` |

Operators also send and receive every crew message: they're crew too. The server answers operators with `roster {ship, users, ships, incoming, outgoing, links, network, linkIncoming, linkOutgoing}`, `op-ok {text}`, `op-error {reason}` and `op-log {text}`, which are events from other ships.

## Limits

- Only Google's public STUN server is configured, no TURN. Peers behind symmetric NAT or strict firewalls will show `failed`. Add a TURN server (for example coturn) to `ICE_SERVERS` in `public/voice.js` to fix that.
- Crew place one-to-one calls; only operators make group calls (patch in). Group calls are a full mesh, so each person uploads their audio once per other participant. That's comfortable up to roughly 5 to 8 people. Beyond that, an SFU such as Pion or mediasoup is the next step.
- Station telemetry is simulated for show; only the duty rosters reflect real crew.
- Library files can't be renamed from the consoles, and anyone aboard can read and add to their ship's library.
- No auth: anyone can register any free name on any ship, and with no OPERATOR_KEY anyone can take any ship's ops station or run a ship's computer. A ship is just a name: it exists while its ops station, any of its crew or a ship's computer is online. The relay keeps its state in memory only; libraries persist on the ship's computers.
