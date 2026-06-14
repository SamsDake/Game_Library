# Reset Guide — Wiping the Whole Game Library

How to reset the portal back to a clean slate, app by app and all at once. The
site is three independent web apps behind one lobby, and **each app stores its
state in a different place**, so a true "reset everything" touches all of them.

There are two levels of reset:

- **Level 1 — In-app reset (no server access needed).** Every app has admin
  buttons that end the current game and clear its live state. This is what you
  want between rounds. Fast, safe, reversible-ish.
- **Level 2 — Full server wipe.** Stop the services and delete the persisted
  data on disk (and Redis/Postgres if configured). Use this to remove *all*
  history, photos, leaderboards, saved rooms, and push subscriptions — a
  factory reset.

> **Important:** Jetlag Mobile and the Deduction Board are **client-authoritative** —
> the phones hold the real state in `localStorage`/IndexedDB and re-seed the
> server when they reconnect. Wiping the server alone is **not** enough for those
> two; you must also reset the phones (Level 1 in-app reset, or clear the browser
> storage). Urban Hunt is **server-authoritative**, so wiping the server is the
> source of truth there.

---

## Where each app keeps its state

| App | Live/server state | Persisted on disk (server) | On the phone (browser) |
|-----|-------------------|----------------------------|------------------------|
| **Urban Hunt** (`/urban-hunt/`) | In `data/state.json`, or Redis key `urban-hunt:state` if `REDIS_URL` set | `data/state.json`, `data/history.json`, `data/uploads/<gameId>/*` (claim photos); Postgres `claims` + `pois` tables if `DATABASE_URL` set | `localStorage`: `uh_role`, `uh_name`, `uh_player_id`, `uh_player_secret`, `uh_pending_location` |
| **Jetlag Mobile** (`/jetlag/`) | `gameState` in memory only (lost on restart, re-seeded by phones) | `push-subs.json`, `native-push-tokens.json`, `vapid.json` (push only — not game data) | `localStorage`: `jetlag_state_v4` (game), `jetlag_device_v1` (Phone A/B); IndexedDB `jetlag-cache` (map data) |
| **Deduction Board** (`/deduction-board/`) | Per-room files | `server/state/<roomId>.json` (one per room) | `localStorage`: `jetlag-deduction-v1`; IndexedDB `jetlag-game-state` (board) + `jetlag-cache` (map data); room code in the URL `#room=` |

The deployment layout (per `deploy/README.md`) on the VPS is
`/var/www/minigame-library`, with services `urban-hunt`, `jetlag-mobile-server`,
and `jetlag-deduction-server` managed by systemd.

---

## Level 1 — In-app reset (between games)

### Urban Hunt
1. Join as **Admin** (lobby → `... admin access ...` → enter the **Admin PIN**).
2. In the admin console, scroll to **Reset Everything** (danger).
3. Confirm. This ends any game, clears all players, wipes game history, and
   sends every device back to the home screen (`force_reset`).
   - The admin-configured **Starting Zone and Game Settings are intentionally
     kept** so they carry into the next game. To change those, edit them before
     starting the next round.
   - History is only cleared if the reset is sent with the "clear history"
     option (the danger reset does clear it).

### Jetlag Mobile App
1. Tap the **admin (gear) icon** on any screen → enter `6789`.
2. **Reset entire game** (two-tap confirm) — clears the round.
3. **Kick all devices off** (two-tap confirm) — forces every phone back to the
   Phone A/B device-setup gate.
4. On **each phone**, this rides the normal state sync, but to be certain the
   phone is clean also do a Level-1 client clear (below) if it misbehaves.
   - "New game" (from the leaderboard) keeps leaderboard, deck config, countdown
     length, and selected countries — it is **not** a full reset.

### Deduction Board
1. In the sidebar, tap the red **Reset map** button (confirm).
2. This clears the selected countries, the seeker pin, and all clues for the
   current room.
   - Note: this resets the **shared room**, so the other phone in the same
     `#room=` sees it cleared too.

---

## Level 2 — Full server wipe (factory reset)

Run on the VPS as a user that can write the app data dirs (e.g. with `sudo`).
Adjust the base path if you didn't deploy to `/var/www/minigame-library`.

### Step 1 — Stop the services
```bash
sudo systemctl stop urban-hunt jetlag-mobile-server jetlag-deduction-server
```

### Step 2 — Wipe Urban Hunt (server-authoritative)
```bash
cd "/var/www/minigame-library/Urban Hunt"

# Game state, history, and all uploaded claim photos
rm -f  data/state.json data/history.json
rm -rf data/uploads/*

# If Redis is the state backend (REDIS_URL set in urban-hunt.service):
redis-cli DEL urban-hunt:state

# If Postgres is configured (DATABASE_URL set), clear claims (and POIs if you
# want a clean objective cache — POIs will repopulate from Overpass on demand):
psql "$DATABASE_URL" -c "TRUNCATE claims;"
# psql "$DATABASE_URL" -c "TRUNCATE pois;"   # optional
```
Leave `vapid keys`/push files in place unless you want players to re-subscribe.

### Step 3 — Wipe Jetlag Mobile App
The game state is in memory, so a restart clears it. Only push files persist:
```bash
cd "/var/www/minigame-library/Jetlag Mobile App/server"

# Optional: drop push subscriptions (players must re-grant notifications).
# Do NOT delete vapid.json unless you want to rotate keys (it forces every
# phone to re-subscribe with the new key).
rm -f push-subs.json native-push-tokens.json
```
> Because the phones hold the authoritative game state in `localStorage`, you
> **must** also do the per-phone client reset (below) or the next phone to
> connect will re-seed the old game into the server.

### Step 4 — Wipe Deduction Board (all saved rooms)
```bash
cd "/var/www/minigame-library/jetlag-deduction-board/server"
rm -rf state/*    # deletes every saved room (state/<roomId>.json)
```
> Same caveat: phones re-seed a room from their own IndexedDB/`localStorage`. To
> truly retire a room, also clear the phones that used it.

### Step 5 — Restart
```bash
sudo systemctl start urban-hunt jetlag-mobile-server jetlag-deduction-server
sudo systemctl status urban-hunt jetlag-mobile-server jetlag-deduction-server --no-pager
```

### One-shot script
```bash
#!/usr/bin/env bash
set -euo pipefail
BASE="/var/www/minigame-library"

sudo systemctl stop urban-hunt jetlag-mobile-server jetlag-deduction-server

# Urban Hunt
rm -f  "$BASE/Urban Hunt/data/state.json" "$BASE/Urban Hunt/data/history.json"
rm -rf "$BASE/Urban Hunt/data/uploads/"*
# redis-cli DEL urban-hunt:state                       # if REDIS_URL set
# psql "$DATABASE_URL" -c "TRUNCATE claims;"           # if DATABASE_URL set

# Jetlag Mobile (push only; state is in-memory)
rm -f "$BASE/Jetlag Mobile App/server/push-subs.json" \
      "$BASE/Jetlag Mobile App/server/native-push-tokens.json"

# Deduction Board (all rooms)
rm -rf "$BASE/jetlag-deduction-board/server/state/"*

sudo systemctl start urban-hunt jetlag-mobile-server jetlag-deduction-server
echo "All three apps reset. Remember to clear the phones for Jetlag + Deduction."
```

---

## Per-phone (client) reset

Required for **Jetlag Mobile** and **Deduction Board** (client-authoritative);
optional cleanup for **Urban Hunt**.

**Easiest:** in each app use its in-app reset/leave control —
- Urban Hunt: the `<` **back** button clears all `uh_*` keys and returns to the lobby.
- Jetlag: Admin → **Kick all devices off** (returns to the device gate).
- Deduction: **Reset map**.

**Nuclear (clears everything for that origin):** in the phone's browser, open the
site, then **DevTools → Application → Storage → Clear site data**, or run in the
console:
```js
localStorage.clear();
indexedDB.databases?.().then(dbs => dbs.forEach(d => indexedDB.deleteDatabase(d.name)));
// then unregister the service worker so push/SW caches reset:
navigator.serviceWorker?.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
location.reload();
```
This removes saved roles, the Phone A/B assignment, saved games, deduction
boards, the `#room=` you were on, cached map data, and the push subscription.
On iOS Safari without DevTools, use **Settings → Safari → Advanced → Website
Data** and remove the site, or remove and re-add the PWA from the home screen.

---

## Quick checklist

- [ ] Urban Hunt: admin **Reset Everything** (or wipe `data/state.json`, `data/history.json`, `data/uploads/`, Redis key, `claims` table).
- [ ] Jetlag Mobile: admin **Reset entire game** + **Kick all devices off**, restart server, **clear both phones** (`jetlag_state_v4`, `jetlag_device_v1`).
- [ ] Deduction Board: **Reset map**, delete `server/state/*`, **clear phones** (`jetlag-deduction-v1`, IndexedDB `jetlag-game-state`).
- [ ] (Optional) Drop push subscriptions so devices re-register.
- [ ] Restart all three systemd services and confirm they're `active (running)`.
