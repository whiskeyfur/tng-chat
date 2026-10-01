# tng-chat

Starship comms in the browser, on LCARS consoles. A small Node server serves the pages, keeps track of who is aboard which ship at which station, and relays call signaling. Audio, chat and files go peer-to-peer over WebRTC: each call is one `RTCPeerConnection` per other participant, carrying the audio track plus two data channels.

## Run

```sh
npm install
npm start            # http://localhost:8080  (PORT=xxxx to change)
```

Everyone uses the same page, http://localhost:8080:

1. **Start an ops station** for each ship: enter your name, pick **Operations** as the station, and type the ship's name (a new name creates the ship). A ship comes into existence when its ops station signs on.
2. **Report aboard:** enter a name, pick a ship from the list, pick a station (Captain, First Officer, Helm, Tactical, Security, Engineering, Medical, Science, Communications, Transporter, Crew). Names only need to be unique within a ship.

`operator.html` still works as a link to the Operations sign-in.

Ship libraries are stored under `data/<ship>/` next to `server.js`. Set `DATA_DIR` to put them elsewhere, and `MAX_UPLOAD_MB` to change the upload limit (default 200).

### Hosting the pages elsewhere (GitHub Pages)

The pages in `public/` are static, so they can be hosted anywhere, for example GitHub Pages, as long as they can reach a running `server.js` (the comm relay):

```sh
node tools/export-pages.js ../whiskeyfur.github.io/stchat wss://relay.example.com
```

That copies `public/` into the folder and writes `config.js` with the relay address. Without one, people enter it in the **Comm relay** field on the sign-in screen (remembered per browser), or open the page with `?relay=wss://relay.example.com`. Pages served over `https://` (like github.io) need a `wss://` relay, for example the server behind a TLS reverse proxy or `ngrok http 8080`; a relay on `localhost` also works for local testing. The library endpoints allow cross-origin requests, authenticated by the session token.

Browsers only allow the microphone on `https://` or `localhost`. To try it across machines, put the server behind HTTPS (for example a reverse proxy, or a tunnel such as `ngrok http 8080`); the pages switch to `wss://` automatically.

## Crew consoles

Each crew member gets an LCARS console for their station, styled with `public/lcars.css` (copied from `../lcars-base`). The displays suit the post, with simulated telemetry:

| Station | Displays |
| --- | --- |
| Captain | ship status, tactical plot, department readiness, senior staff on duty, captain's log |
| First Officer | duty roster (who is actually aboard), department readiness, ship status, duty log |
| Helm | forward view starfield, course, helm systems |
| Tactical | shield grid, weapons, **shield control** (raise/lower the ship's shields), targeting scan |
| Security | internal sensors deck grid, force fields, security log |
| Engineering | side view of the ship with the warp core, warp field harmonics, power distribution |
| Medical | patient monitor with ECG and vitals, neural activity, sickbay, cellular analysis |
| Science | long range sensors, spectral analysis, anomaly readings, science log |
| Communications | subspace bands, carrier signal, message traffic |
| Transporter | transporter controls (beam crew to another ship), transporter pad, pattern buffer |
| Crew | ship schematic, ship status, deck status |

Every console fits the window: there's no page scrolling. The left-hand menu switches between full-window screens: **Comms** at the top, then one screen per display, the console log, and **Library** at the bottom. Long lists scroll inside their own panel.

Comms opens an LCARS modal, the same for every role, ops included:

- **Directory:** everyone you can call. That's your ship (ops first, as **Call ops**), plus every ship on your data network.
- **Call panel:** incoming calls with Accept and Decline, then mute, hang up, chat and files (any size, sent in 16 KB chunks). The microphone is only requested once a call connects.
- **Call waiting:** while you're in a call, a second caller shows up as "call waiting" with three choices. **Ignore** tells them you're busy. **Switch** hangs up your current call and answers them. **Join** brings them into the call you're in, so everyone hears everyone. If your call ends while someone's waiting, their call rings. Anyone else calling while you're busy, ringing or dialling hears busy.
- The modal opens by itself for an incoming or waiting call, or when an operator puts you through. Calls carry on while it's closed, and the Comms button shows the call state.

## Stations, transporters and shields

- **Change station:** the **Station** screen moves you to another station aboard the same ship. Your console changes to the new station; calls in progress carry on. (The ops console always stays at Operations.)
- **Transporter:** the Transporter station beams anyone aboard (themselves included, but not the ops station) to another ship in the list. The person's call ends, they leave this ship's comm net and report aboard the other ship with the same name and station; both ships' ops see them leave and arrive. Beaming is refused if someone with that name is already aboard the destination.
- **Shields:** the Tactical station raises and lowers the ship's shields. While a ship's shields are up, nobody can be beamed off it or onto it. Shield state shows on Tactical's shield grid, in the transporter's ship list and on the ops Status screen.

## Library

The **Library** screen, at the bottom of the left-hand menu on every console, is the ship's computer: the files uploaded to your ship, stored on the server as `data/<ship>/<file>`. Anyone aboard can upload files to their own ship's library and download any file listed. Ops can **delete** files from their own ship's library (after a confirmation); crew can't, and nobody can delete from another ship's library. Across data links, every library on your data network is listed too, each in its own ship folder (your ship first). Closing the link takes the other ship's folder away, and its files can no longer be downloaded.

File names are cleaned up: folders, control characters and leading dots are removed, and a name that's already taken gets " (2)". Uploads and downloads go over HTTP with a per-session token handed out at sign-in.

## Ops console (Operations station)

Pick **Operations** at sign-in, or open `?station=Operations&name=O'Brien&ship=Enterprise` (or the old `operator.html` link). The page remembers the last sign-in. Ops is assumed to be on the bridge. The operator is aboard as crew at the **Operations** station and has the same Comms menu as everyone. It adds **Transfer to**: hand the call you're in to anyone aboard or on the data network, or to another ship by hail, and drop off the line. A call with several people is handed over whole.

- **Hail · ship to ship:** hail another ship on behalf of one of your crew, yourself included. That ship's operator routes the hail to someone aboard (it defaults to their Captain, and can be themselves), or declines. You can cancel while it's pending. For example: Picard on the Enterprise, via Enterprise ops, via K'Vatch ops, to Martok, Captain of the K'Vatch.
- **Data link:** request a link with another ship. Their operator accepts or declines, and either side can close the link later. Linked ships form a data network (links chain, so three or more ships can share one network). Everyone on it sees everyone on every ship in the Comms directory and can call them directly. The **data network map** beside the controls shows every ship (crew aboard, shields, ops on duty) and who is linked to whom: solid lines are data links, dashed lines pending requests, and colours mark this ship, the ships on its network, other ships and ships without ops. Click a ship to pick it for a link request.
- **Intercom:** connect two of your crew immediately, without ringing, ending any calls they're in.
- **Conference · patch in:** bring one of your crew into the call another crew member is in, even if it spans ships.
- **Crew roster:** your crew's stations and call status, with Call and Disconnect buttons.
- **Comm log:** arrivals, departures, ships in range, hails, links and operator actions.

The ops menu has Comms, Status (channel readouts and the comm log), Hail, Data link, Intercom (intercom and conference), Crew roster and, at the bottom, Library.

By default anyone can take an ops station. To require a key, start the server with `OPERATOR_KEY=yourkey npm start` and enter it as the authorization code.

### When ops drops out

If a ship's last ops station signs off, nobody is cut off. Calls in progress carry on, including calls with other ships, until people hang up, and crew can still call anyone aboard. But no new off-ship communication can start. Other ships can't hail the ship, its data links close, and pending hails and link requests are dropped. Crew see "Ops offline". The ship stays in the list, marked "ops offline", while anyone is aboard.

## Test

```sh
npm test
```

Starts the server and drives headless Chromium pages with a fake microphone through crew consoles and ops consoles:

- **Crew calls:** decline; accept with audio both ways; chat; a 300 KB file arrives byte-for-byte; hang-up; a peer going offline.
- **Call waiting:** ignore (the caller hears busy), the caller giving up, join (three-way), switch, and a waiting call ringing once the current one ends.
- **Operator actions:** intercom, moving someone, patching a third person in (everyone hears everyone, chat and files reach everyone), one person leaving a three-way call, disconnect.
- **Calls with ops:** crew calling ops, ops transferring the call aboard, ops calling crew.
- **Ship to ship:** each ship sees only its own crew, and stations get their own displays. Then a hail routed to the Captain, a declined hail, a cancelled hail, and an off-ship transfer that the other ship's ops answers and passes on.
- **Data links:** the map showing a pending request then the open link, a call across a data link, closing the link, and the link dropping with ops.
- **Stations, transporter, shields:** changing station; shields up blocking the transporter; shields down and a crew member beamed to the K'Vatch.
- **Hosting elsewhere:** the library endpoints answer cross-origin preflight requests.
- **Library delete:** crew and other ships' ops are refused; ops delete from their own ship and the file is gone from disk and from everyone's library.
- **Library:** an upload lands in `data/Enterprise/`, a shipmate sees it, a K'Vatch crew member downloads it over the data link, and access ends when the link closes.
- **Without ops:** the call in progress carries on and shipmates can still call each other.

If Playwright can't find its browser, set `CHROMIUM_PATH` to a Chromium binary.

## How it works

- `server.js` keeps everyone online by id (`name@ship`, lowercased), with their ship and station. It sends each person the crew list for their data network (just their ship when unlinked), relays call-control and signal messages to a user id, and adds `from` and `fromInfo`. A `call` to someone off your network is refused with `unavailable`. Each ship's ops consoles get a roster of that ship's crew, the ships in range, their links and network, and the open hails and link requests. Hails and link requests live on the server until answered or until a party goes away.
- `public/relay.js` finds the comm relay (same server by default, or `config.js`, `?relay=`, or the sign-in field).
- `public/voice.js` is the call engine and call panel. `public/comms.js` builds the Comms modal around it: the directory, plus optional extras like Transfer. `public/library.js` is the Library screen and `public/screens.js` switches screens. All of these are shared by the crew console (`public/client.js`, with the station displays in `public/stations.js`) and, at the Operations station, the ops screens (`public/ops.js`), all on the one console page. Shared console styles are in `public/console.css`.
- The library lives on disk. `GET /api/library/<ship>/<file>` downloads from any ship on your data network, and `POST /api/library` (headers `X-Token` and `X-Filename`, the file as the body) uploads to your own ship, and `DELETE /api/library/<ship>/<file>` deletes (ops only, own ship only). The `X-Token` comes from `registered` or `operator-ok`. After every change, the server sends `{type:"library", ships:[{name, own, files:[{name, size, modified}]}]}` to everyone on the data network.
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
| `{type:"change-station", station}` | move to another station aboard your ship; reply `registered` with the new station |
| `{type:"shields", up}` | Tactical only: raise or lower the ship's shields |
| `{type:"beam", who, ship}` | Transporter only: beam user id `who` (aboard your ship) to `ship`; they get `registered` with `beamedFrom` |

| Message (server → client) | Meaning |
| --- | --- |
| `{type:"ships", ships}` | every ship, `[{name, ops, shields}]`: the sign-in pull-down, transporter targets and shield state |
| `{type:"users", users, ops, network}` | everyone on your data network `[{id, name, ship, station}]`, whether your ship has ops on duty, and the network's ships |
| relayed message with `from`, `fromInfo` | a call-control or signal message |
| `{type:"unavailable", id}` / `{type:"gone", id}` | that user can't be reached / left the comm net |
| `{type:"connect", peers, role, cid}` | an operator connected you with `peers`; `role:"caller"` means you send the offers |
| `{type:"add-peer", peer, cid}` | an operator is patching `peer` into your call; wait for their offer |
| `{type:"force-hangup", reason?}` | an operator disconnected you, or your transfer went through (ops) |
| `{type:"notice", text}` | hail progress, for example "Ops is hailing the K'Vatch for you" |

| Message (operator → server) | Meaning |
| --- | --- |
| `{type:"operator", name, ship, key}` | take the ops station for `ship` (also signs in as crew `name` at Operations); reply `operator-ok {id, name, ship, station}` or `operator-failed` |
| `{type:"connect", a, b}` / `{type:"add", name, into}` / `{type:"end", name}` | intercom, patch in, disconnect (own crew ids only) |
| `{type:"hail", ship, crew}` | hail `ship` on behalf of crew id `crew` |
| `{type:"route", hail, to}` / `{type:"decline-hail", hail}` | answer an incoming hail: connect it to crew id `to`, or decline |
| `{type:"cancel-hail", hail}` | withdraw an outgoing hail |
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
- No auth: anyone can register any free name on any ship, and with no OPERATOR_KEY anyone can take any ship's ops station. A ship is just a name: it exists while its ops station or any of its crew is online. State is in memory only.
