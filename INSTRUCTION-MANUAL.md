# Game Library — Instruction Manual

A client-side user guide to every web app in the Game Library portal. This covers
how to open each app, every screen and control, the rules the client enforces, and
the client-side details (storage, GPS, sync, push, admin codes) you need to run a game.

All three games are mobile-first web apps. Open them in a phone browser (Chrome/Safari)
or install them to the home screen as a PWA. **Location-based features require HTTPS**
(or `localhost`) and the browser's location permission.

---

## 0. The Lobby (portal)

**URL:** `/` (the site root)
**File:** `lobby/index.html` — a static page, no JavaScript.

The lobby is a launcher with three tiles. Tap a tile to open that app:

| Tile | Opens | Link |
|------|-------|------|
| **Urban Hunt** — Live GPS field game | `/urban-hunt/` | Hide, seek, claim objectives, run the match from an admin console. |
| **Jetlag Mobile App** — Two-phone Jet Lag app | `/jetlag/` | Full hider/seeker flow with sync, push, cards, timers. |
| **Jetlag Deduction Board** — Shared map console | `/deduction-board/` | Track clues, shrink the hiding area, sync rooms across devices. |

That's the whole lobby — it just navigates. Everything else lives in the three apps below.

---

# 1. Urban Hunt

A real-time, GPS field game. One **Admin** device runs the match; **Hiders** roam a
shrinking play zone completing photo objectives while **Seekers** chase them using a
*time-delayed* trail of where the hiders were. The server is authoritative and pushes
live state over a websocket (Socket.IO).

**URL:** `/urban-hunt/`
**Client:** `Urban Hunt/client/src/main.tsx` (React + Leaflet + Socket.IO)

### 1.1 What the client stores on your device
The app remembers you across reloads using `localStorage`:

- `uh_role` — your role (`HIDER` / `SEEKER` / `ADMIN`)
- `uh_name` — your call sign
- `uh_player_id` + `uh_player_secret` — your identity; on reconnect the client
  silently rejoins as the same player so GPS/heartbeat resume without a reload.
  (Admins are **not** auto-rejoined — there is no stored PIN — so an admin who
  refreshes must re-enter the PIN.)
- `uh_pending_location` — the last GPS fix that hasn't been acknowledged by the
  server yet, so a dropped packet is retried after a reconnect.

**Leaving** a game (the `<` back button) clears all of these and returns you to the lobby.

### 1.2 The Lobby screen (joining)
1. Type a **call sign** in "ENTER CALL SIGN".
2. Tap **Hide** (complete objectives) or **Seek** (close the net) to join in that role.
3. **Admin access:** tap the faint `... admin access ...` link, enter the **Admin PIN**,
   and tap **Access** (or press Enter). The PIN is set server-side via the `ADMIN_PIN`
   env var.

After joining you land on **Waiting** (hiders/seekers) or the **Admin console** (admin).

### 1.3 Waiting screen
Shows your role badge, your name, and the **Connected Devices** roster (who's joined and
whether each is online/offline). You wait here until the admin starts the game.

### 1.4 Admin console
The admin sets up and controls the entire match. Sections, top to bottom:

- **Starting Zone** (setup only):
  - **Longitude / Latitude** number fields for the zone origin.
  - **Initial radius** slider (100–20000 m).
  - **Pin Origin / Set Radius** toggle: choose a mode, then **tap the map**. "Pin Origin"
    drops the zone center; "Set Radius" sets the radius as the distance from the origin to
    your tap. (After pinning an origin it auto-switches to radius mode.)
- **Game Settings** (live-editable sliders; changes broadcast immediately):
  - **Objective spawn distance** (dual slider, min–max metres): how far from a hider new
    objectives appear.
  - **Game length** (minutes, `0` = no time limit). If the clock runs out with any hider
    still free, **hiders win**.
  - **Shrink** (%) and **Shrink interval** (s): the global play zone contracts by this
    percentage every interval, pulling toward the seekers.
  - **Ping interval** (min): how often seekers receive a fresh (delayed) hider position.
  - **Delay** (min): how far *behind real time* the seekers' view of each hider is. This is
    the core balance lever — seekers always chase a stale trail.
  - **Lockdown every** (N pings), **Lockdown radius** (m), **Lockdown edge distance** (m),
    **Lockdown duration** (s): periodically a bonus "lockdown" zone appears near a hider;
    reaching it/claiming inside it scores extra.
  - **Regular** and **Lockdown objective points**.
- **Connected Devices** roster.
- **Game Control** (while active): **Start** (resume), **Pause**, **End**.
  Before the game starts instead you get **Start Game** and **Disconnect All**.
- **Reset Everything** (danger): confirms, then ends any game, clears all players, wipes
  game history, and sends every device back to the home screen.
- **Map**: live Leaflet map (dark CARTO tiles) showing the safe zone, hider markers,
  seeker markers, objectives, and lockdown circles. In setup it also handles your
  origin/radius taps.
- **Claim Evidence** (when claims exist): each claim shows the hider, status, points,
  objective, distance, and the submitted **photo**. Admins can **Disallow** an accepted
  claim (with a typed reason).
- **Game History**: recent games with durations and per-player scores.

### 1.5 Hider screen
A split view: **map on top, control panel below.**

- **Proximity to nearest seeker** — a status word (e.g. near / far) driven by the
  configured `proximityThresholds`.
- **Survive for** — the game countdown (if a time limit is set).
- **Out of bounds** warning — if you leave the play zone, objectives lock until you return.
- **Score**.
- **Lockdown timers** — current lockdown remaining, or a "reach next lockdown" countdown,
  plus a "next lockdown" forecast time.
- **Objectives** (one card per active slot): the objective name, category, distance to it,
  point value, and an expiry timer for lockdown objectives. The button reads
  **Move Closer** (too far), **Out Of Bounds** (outside zone), or **Claim Objective**
  (you're within `claimRadius`, default 40 m).
- **Claim flow:** tapping **Claim Objective** opens the **Claim sheet**:
  - Two readiness checks: **GPS** (`ready` when within range, else shows distance) and
    **Photo** (`required` until captured).
  - A camera input (`capture="environment"`, i.e. the rear camera) to take/upload a photo.
  - **Confirm Claim** uploads the photo + your live coordinates to `/api/claims`. The server
    re-verifies GPS freshness and distance; failures surface as readable messages
    ("you are too far from the objective", "live GPS location is too old", etc.).
- **I Have Been Caught** (danger button): a two-tap confirm ("Tap Again To Confirm",
  armed for 5 s). Confirming converts you to a **Seeker** for the rest of the match and
  posts your final score to the leaderboard. **When the last hider is caught, seekers win.**
- **Zone shrink** timer at the bottom counts down to the next contraction.

The hider map shows: the global safe zone, your position, your objectives, your current/next
lockdown circles, and your legal area (safe zone minus any active lockdown cut-out).

### 1.6 Seeker screen
Also map + panel.

- **Time left** (if a limit is set).
- **Hider signals**: one row per hider showing name, the *capture time* of the shown
  position, and their active objectives. **Seekers only ever see a delayed position and a
  delayed trail** — never the hider's live location.
- The map draws seeker markers (live), each hider's **delayed** marker + trail, lockdown
  circles, objectives, and the safe zone.

**Note:** if you're caught as a hider you're automatically flipped to a seeker — the client
detects the seeker-only broadcast, updates your role + storage, and switches you to this
screen so a refresh rejoins correctly.

### 1.7 Game Over screen
Shows the **winner** ("HIDERS win" / "SEEKERS win"), total game time, the **Leaderboard**
(ranked by score), and — for the admin — claim evidence and game history. Tap `<` to leave.
The admin stays on their console instead, ready to start the next game.

### 1.8 GPS & notifications (client behaviour)
- While you're a hider or seeker the client continuously watches your location and streams
  it to the server, retrying any unsent fix (`uh_pending_location`) until acknowledged. A
  30-second heartbeat keeps your "online" status fresh.
- On native builds it uses a **background geolocation** plugin so GPS keeps flowing with the
  screen off; in a plain browser it uses `navigator.geolocation.watchPosition` with high
  accuracy. **Live GPS is mandatory** — without it you can't play or claim.
- If the server has **demo location** enabled, a simulated location is used when real GPS is
  unavailable (it drifts toward your objective/target). This is a dev/testing aid only.
- **Push notifications:** once you have an identity the app registers a service worker and a
  Web Push subscription, so you get alerts (e.g. "a new lockdown zone appeared") even with
  the app closed or the screen locked. Grant the notification permission when asked.

---

# 2. Jetlag Mobile App

A two-phone companion for a "Jet Lag: Hide + Seek"-style game. **One phone is the hider,
one is the seeker.** It runs the whole round: a head-start countdown, the hider's card deck
(curses / powerups / time bonuses), the seeker's question deck with GPS, an auto-deducing
tactical map, the found/endgame flow, and a leaderboard. Two phones stay in lock-step over a
websocket; either phone can open the admin panel.

**URL:** `/jetlag/`
**Client:** `Jetlag Mobile App/src/App.jsx` (React + Zustand-style store + Leaflet)
**Admin code:** `6789` (4-digit; `ADMIN_CODE` in `src/lib/data.js`)

### 2.1 First run — device gate
Each phone must declare whether it is **Phone A** or **Phone B**, and this is admin-locked:

1. Enter the 4-digit admin code (`6789`) on the keypad.
2. Tap **Phone A** or **Phone B**. The choice is saved in `localStorage` (`jetlag_device_v1`);
   changing it later requires the code again (Admin ▸ "Switch device").

Game state is saved under `jetlag_state_v4`. The two phones are kept in sync by a websocket
relay; a small dot in the top-right corner is **green = connected**, **orange = reconnecting**.

### 2.2 Home screen — pick a side
"This device is Phone A/B. Choose a role to join the round."

- **Hider** — draw cards, answer questions, run the clock.
- **Seeker** — ask questions, share GPS, close in.
- **Leaderboard** row — view longest-hidden times (and, after a game, a photo gallery).
- If the other phone has chosen, you'll see "Phone B is the seeker," etc.

The two phones must pick **different** roles (one hider, one seeker).

### 2.3 Lobby & starting
Once you have a role you see the **Lobby**: your role badge, the head-start length, and both
phones' readiness. When both phones have opposite roles, **Start head start** is enabled.
Tap it to begin the countdown. (Until then it shows why it's disabled — waiting on the other
phone, or both picked the same role.)

### 2.4 Countdown (head start)
A circular timer counts the hider's head start (default **120 min**).

- **Hider:** "GO HIDE" — get as far as possible; your card hand and the question feed unlock
  when the timer hits zero.
- **Seeker:** "HOLD POSITION" — no seeking yet; your question deck arms when the head start
  ends.
- Milestone alerts fire at 2 h and 1 h remaining, and a "Head start over!" alert at zero.

### 2.5 Hider panel
The hider's cockpit. Header tools: **Question log** and **Photo gallery** (badge = photo
count). Below:

- **Hide clock** — total time you've been hidden (the score), or "paused".
- **Overflowing Chalice** strip — if active, "+1 draw for N more questions".
- **Active question / answer block** — when the seeker asks, the question appears here:
  - The category, the question text, and any instruction (e.g. photo framing rules).
  - **GPS pills** — the seeker's shared coordinates (link out to Google Maps). You can't
    answer until the required GPS has arrived (single-GPS waits for one point; the
    **Thermometer** waits for the 2nd point).
  - **Answer controls** depend on the category:
    - **Choice** (Yes/No, Closer/Further, Hotter/Colder): tap a button.
    - **Text** / **Tentacles**: tap the nearest named place the app found, or type an answer.
    - **Photo**: take/upload a photo.
    - **Auto — answer from my location**: the app reads *your* GPS and computes the truthful
      answer for you (for everything except photo questions).
  - **Play instead of answering** — if you hold a **Veto** or **Randomize** card you can play
    it here instead of answering.
  - **Answer timer** — counts down; answering late cuts how many cards you draw.
- **Your hand** — a grid of card slots (max hand size 6 by default). Tap a card to open its
  detail (type, title, rules text, casting cost). Then **Play card** or **Discard**.
  - Cards with a **casting cost** open a "pay cost" modal (discard N cards / a powerup / a
    time bonus / your whole hand). Some cards (Move, Veto, Randomize, Discard-&-Draw,
    Duplicate) have their own dedicated modal flow.
  - Cards that "need an active question" (Veto/Randomize) are only playable while a question
    is on screen.
- **Draw modal** — after you answer, you draw cards: the app shows what you drew and how many
  you may **keep** (reduced by a late penalty); pick keepers, and if your hand exceeds the
  limit, trim it down.
- **Mark hider as found** box (two-tap confirm) — see Found flow below.

**Card types** (full deck in `src/lib/data.js`):
- **Curses** — burdens you impose on the seekers (right-turns-only, carry a lemon, beat you
  at hangman, etc.). Some block questions until cleared (the seeker sends a proof photo);
  some run on a timer; some grant you a time bonus if the seekers fail a condition.
- **Powerups** — **Move** (relocate, freezing seekers 60 min), **Veto**, **Randomize**,
  **Duplicate**, **Discard 1 Draw 2**, **Discard 2 Draw 3**.
- **Time bonuses** — +15 / +20 / +30 minutes added to your final time.

### 2.6 Seeker panel
The seeker's cockpit. Header tools: **Tactical map**, **Question log**, **Photo gallery**.

- **Hide clock** ("the hider is loose") and a **map strip** (tap to open the tactical map).
- **Active on you** — any curses the hider played. Blocking curses must be cleared by tapping
  **Send proof** (a photo) before you can ask again; timed curses show a countdown bar.
- **Ask a question:**
  1. Pick a **category** chip: **Matching, Measuring, Thermometer, Radar, Tentacles, Photo**.
     (A "Spotty Memory" curse can disable one random category at a time.)
  2. Read the blurb and the draw/keep cost.
  3. **Radar** also has a custom-range text field.
  4. Tap a question option to ask it. For GPS categories the app grabs **your** location at
     ask time. Each option is marked "asked" once used.
- **Active question** view (after you ask): share GPS as required —
  - **Single-GPS** (Matching/Measuring/Radar): **Share my GPS with hider**.
  - **Thermometer** (double-GPS): **Share start GPS**, travel the stated distance, then
    **Share GPS after travel** — the client checks you actually traveled far enough before
    accepting the 2nd point. The hider's answer timer only starts once your final GPS is in.
- **Latest answer** card — the hider's most recent answer, with a tappable photo if any
  (opens a lightbox).
- **Mark hider as found** box.

### 2.7 Tactical map (seeker)
A Leaflet deduction map that **shrinks the possible hiding zone** as evidence comes in. Open
it from the map strip or the header map icon.

- The lit polygon is the still-possible area; everything ruled out is darkened; off-map is
  separate. A legend and a reveal count sit under the map.
- **Two tabs:**
  - **Deduce** — the manual deduction console (same engine as the standalone Deduction Board,
    see §3.5). Set the seeker origin (Place pin / Use GPS / type coordinates), pick a
    question type (Radius, Measuring, Matching, Thermometer, Tentacles, Manual shrink), and
    apply a constraint. Manual deductions land as **Preview** cuts (off until you toggle them).
  - **History** — two sub-views:
    - **Confirmed** — every question the hider actually answered, auto-resolved into a map
      cut. Radar/Thermometer cuts are made the moment they're answered; Matching/Measuring
      resolve here via OpenStreetMap lookups; **Tentacles** needs you to tap **Resolve** and
      pick the place the hider named.
    - **Preview** — your speculative manual deductions, each with an on/off toggle.
- Every reveal row has a **toggle** (does it shape the zone?), the **−% reduction** it
  contributes, and a **delete** button.

The **game area itself** (which countries are in play) is set by the **admin**, not here.

### 2.8 Found / endgame flow
Either side taps **Mark hider as found** (two-tap arm-then-confirm). The round ends only when
**both** sides confirm. Then the **Found screen**:

- Shows the **total time hidden**.
- **Conditional bonuses** — for any curse with a "did the seekers fail X?" condition, the
  **seeker** verifies Yes/Apply or No/Skip; confirmed ones add bonus minutes. The hider waits
  for verification before posting.
- **Redeem unplayed time cards** — the hider can cash remaining time-bonus cards into the
  final time.
- **Sign the leaderboard** — the hider types name(s) and taps **Post time**.

### 2.9 Leaderboard
Ranks runs by **longest time hidden**. After a game you can **View & download gallery**
(all photos taken during the round) and start a **New game** (keeps the leaderboard, deck
config, countdown length, and selected countries; resets everything else).

### 2.10 Admin panel
Tap the admin (gear) icon on any screen and enter `6789`. The panel (collapsible sections):

- **Sync** status; **Switch device** (Phone A/B).
- **Game state** — jump directly to any phase: lobby / countdown / hunt / found / leaderboard.
- **Game area** — searchable country picker. The seeker's starting zone is the union of the
  countries you select. Includes **Reset map** (clear area + reveals).
- **Relocation (Move)** — if a Move is in progress, **End relocation now**.
- **Head-start duration** — set the countdown minutes; ±1/±5 min nudges; **Skip** to jump
  straight to the hunt.
- **Hiding time** — **Pause/Resume** the hide clock; ±5/±15 min adjustments.
- **Hider deck** — configure how many of each curse/powerup/time card are in the draw pile
  (rebuilding reshuffles it). Default: 14 curses, the listed powerups, and 3×15/2×20/1×30 time.
- **Give a card** — hand the hider a random powerup/curse/time card; **Clear hand**.
- **Leaderboard** — remove a row or clear it.
- **Kick all devices off** — forces every connected phone back to the device-setup gate
  (rides the normal state sync; two-tap confirm).
- **Reset entire game** (two-tap confirm).

### 2.11 Notifications (client behaviour)
On first run as a known device the app registers a service worker and subscribes to **Web
Push** (or **native push** on app builds, if enabled), so you get alerts — new question,
answer, curse played, countdown milestones — even when the app is backgrounded. Grant the
notification permission when prompted. Toasts also appear in-app for your role.

---

# 3. Jetlag Deduction Board

A standalone, two-phone **deduction console** — the same map-shrinking engine as the Jetlag
Mobile App's tactical map, but as its own focused tool with no roles, cards, or timers. Use it
to track a hide-and-seek round: pick the countries in play, log each clue the hider gives, and
watch the possible hiding area collapse. Two devices can share a **room** so both see the same
board live.

**URL:** `/deduction-board/`
**Client:** `jetlag-deduction-board/src/App.jsx` (React + Leaflet + Zustand)

### 3.1 Rooms & sync
On first load the app reads `#room=XXXX` from the URL; if absent it generates a 6-character
room code and writes it into the hash. **Share that URL (or just the code) with the second
phone** to put both on the same board. A colored dot shows sync status:
**green = synced**, **yellow = connecting**, **grey = offline** (it works fully offline and
reconnects silently). The full board state (countries, seeker pin, clues) is broadcast to the
room; whoever connects first seeds the shared state.

### 3.2 Layout
- **Desktop:** sidebar (360 px) on the left, full-height map on the right.
- **Mobile:** one pane at a time — a top bar toggles between **Panel** and **Map**.
- Sidebar header shows **Zone area** (km²) and **% of original** — your live progress.
- Three tabs: **Countries**, **Ask**, **Clues**. A red **Reset map** button (with confirm)
  clears countries, seeker, and all clues.

### 3.3 Countries tab
Search and tick the countries/regions in play. Their **union becomes the starting hiding
zone**. Selected countries appear as removable chips, and their borders are outlined on the map.

### 3.4 Map
Dark CARTO tiles. The cyan polygon is the live playable zone; a dark mask covers everything
ruled out; selected-country borders are dashed; the seeker is a blue pin. **Tapping the map**
does different things depending on what you've armed in the Ask tab:
- place the **seeker pin**,
- drop a **manual shrink circle**,
- set your **new position** for a hotter/colder question.

### 3.5 Ask tab (the deduction console)
Every control applies a geometric constraint to the zone — either **keep inside**
(intersect) or **cut out** (difference). Sections:

- **Seeker position (origin)** — **Place pin** (then tap the map) or **Use GPS**. Required
  for distance/radius questions. Current coordinates are shown.
- **① Radius proximity** — enter a radius (m); ask "Is the hider within this radius of me?"
  Answer **YES** (keep the circle) or **NO** (cut it out).
- **② Hotter / colder** — tap **Start**, then tap your new position on the map after moving,
  then choose **Hotter** or **Colder**. The board keeps the half of the map on the
  correct side of the perpendicular bisector and moves the seeker pin to the new spot.
- **③ Manual shrink point** — enter a radius, choose **Safe (keep inside)** or
  **Exclude (cut out)**, **Arm**, and tap the map to drop the circle. A free-form way to
  carve the zone by hand.
- **④ Feature questions** — pick a real-world **Feature** and ask a comparison. Features
  come from OpenStreetMap/Overpass (or local geometry for borders/elevation):
  - **Points:** airport, rail station, mountain peak, museum, library, cinema, hospital,
    zoo, aquarium, amusement park, park, golf course, foreign consulate.
  - **Lines:** coastline, international border (uses nearest-distance automatically).
  - **Area:** administrative division (pick a **division level** — country-dependent; e.g.
    UK level 6 ≈ county, 8 ≈ district, 10 ≈ parish).
  - **Special:** sea level (experimental, coarse elevation grid).
  - Question modes per feature: **Same nearest feature? (YES/NO)**, **Closer / Further**, and
    **Closest of nearby** (loads candidates within the radius; tap which one the hider is
    closest to). A **↻ Refresh data** link discards cached feature data and re-pulls fresh.
- A status line reports each action, including warnings about partial/cached data.

### 3.6 Clues tab
The running timeline of every constraint you've applied, in order. Each entry shows its label,
whether it **kept inside** or **cut out**, and the **−% area** it removed. **Undo last** pops
the most recent clue; **Delete** removes any specific one (the zone is recomputed from
scratch). This is your audit trail of how the hiding area shrank.

### 3.7 Performance note
Feature data is fetched once per feature against the *original* country bounding box and
cached (in memory and IndexedDB), then clipped to the current zone locally — so repeat
questions are instant and don't re-download. Some data is preloaded for common regions.

---

## Quick reference

| | Urban Hunt | Jetlag Mobile App | Deduction Board |
|---|---|---|---|
| **URL** | `/urban-hunt/` | `/jetlag/` | `/deduction-board/` |
| **Players** | Many: 1 admin + hiders + seekers | Exactly 2 phones (A/B) | 1–2 phones (shared room) |
| **Roles** | Hide / Seek / Admin | Hider / Seeker (+ admin code) | None |
| **Admin gate** | Server **Admin PIN** | Code **6789** | — |
| **Live GPS** | Required (background on native) | Used for answers/questions | Optional (Use GPS) |
| **Sync** | Socket.IO, server-authoritative | Websocket relay (A↔B) | Websocket rooms (`#room=`) |
| **Push** | Web Push + native | Web/native push | None |
| **Win** | Last hider caught → seekers; time out → hiders | Longest time hidden (leaderboard) | — (a tracking tool) |

> **Tip:** open all three from the lobby at the site root. For anything GPS- or
> push-related, use HTTPS and grant the location and notification permissions when the
> browser asks — several features silently do nothing without them.
