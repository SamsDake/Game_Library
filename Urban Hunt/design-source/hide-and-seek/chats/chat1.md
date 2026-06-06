# Implementation Handover Setup

_Started 2026-06-04 20:29 UTC_

---

## User

I have given a handover on what to implement and design. Also add placeholder pages to allow devices to know if they are hiding/seeking, and an admin panel to adjust values and variables.

## Assistant

_[tool: read_file]_

_[tool: questions_v2]_

## User

Questions answered:
- vibe: Dark & tactical (military/ops feel)
- color_scheme: 0
- device: Mobile-first (phones in the field)
- map_style: Dark/satellite tactical
- variations: All of the above
- prototype_depth: Clickable prototype (nav between screens)
- branding: Use 'Hide & Seek'
- admin_panel_style: Card-based settings panels
- explore_variations: Yes — show me 2-3 directions

## Assistant

_[tool: update_todos]_

_[tool: copy_starter_component]_

Let me start building! Copying the tweaks panel and then writing all files.

_[tool: write_file]_

Building everything now across 4 files!

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

Now the main app with simulation engine and tweaks:

_[tool: update_todos]_

_[tool: done]_

_[tool: fork_verifier_agent]_

Clean load! Let me verify all screens look right.

All files are built and loading clean. Here's what was delivered:

---

**5 screens, fully interactive:**

- **Lobby** — HIDE / SEEK role cards, call sign input, game code join, triple-tap logo for admin access
- **Hider View** — Live Leaflet map (dark CartoDB tiles) showing your position, lockdown circle & objective marker. Bottom panel: giant proximity indicator (DISTANT → FAR → NEAR with pulse animation), active objective + distance, zone shrink countdown, zone health bar, lockdown badge
- **Seeker View** — Same map but showing delayed hider pings (diamond markers + "Xm ago" labels) and all lockdown circles. Your own position as a glowing dot
- **Admin Panel** — Full card-based control deck with live stats (players / elapsed / zone radius), sliders for all 8 variables from the spec (squeeze %, interval, location delay, ping interval, lockdown trigger, lockdown radius, near/far thresholds), connected player list, mini overview map
- **Game Over** — Winner screen with duration, objectives cleared, zone remaining %, OOB events

**Live simulation engine** — seekers slowly close in on the hider, zone shrinks on a configurable timer, proximity state updates every second, lockdown circles refresh on ping intervals, objectives auto-cycle on approach

**Tweaks panel** — 3 visual directions (Ghost / Shadow / Hunt), scan-line toggle, map brightness, quick-nav buttons, simulation pause

## User

Verifier agent check completed

## Assistant

All good — verifier confirmed everything renders correctly across all screens. ✓

**Next steps you might want:**

- **Real GPS** — swap the simulated coords for `navigator.geolocation.watchPosition()` so actual phones report live positions
- **Backend wiring** — connect the Socket.io event schema from the spec (the payloads are already modelled in the simulation state)
- **More hiders** — the data model supports multiple hiders; the admin map already handles `hiders[]`
- **Sound design** — proximity NEAR could trigger a haptic/audio alert
- **PWA manifest** — add a `manifest.json` so players can install it to their home screen for full-screen field use

## User

Remove the game code feature, only one game will be played at a time. Allow the admin to set the initial starting zone location and radius. When starting up the game, all devices must identify as hider or seeker, there will be a panel to show which device is what. Hiders need to prove that they are at their objective by gps location, and with a photo before the objective clears.

## Assistant

_[tool: update_todos]_

_[tool: str_replace_edit]_

Building all the changes now across all files simultaneously.

_[tool: write_file]_

Now rewriting all three JSX files:

_[tool: write_file]_

_[tool: write_file]_

Now the updated app state engine:

_[tool: done]_

_[tool: fork_verifier_agent]_

Clean! Forking verification across all the new screens.

Here's what changed in this update:

---

**Removed**
- Game code input and JOIN button — one game at a time, no session juggling

**Added: Pre-game Waiting Room**
- All non-admin devices see a waiting room after picking their role showing their role (HIDER/SEEKER) in large text, the full roster of connected devices, and a live count. They wait until admin fires the start

**Added: Admin Setup Panel** (pre-game state)
- Zone center: lat/lng coordinate inputs with a **📍 Use My Location** button (calls `navigator.geolocation`)
- Initial radius slider (200m → 5000m)
- Live zone preview map shows exactly what the starting boundary looks like before committing
- All key game settings configurable before start (shrink %, delay, lockdown radius)
- Roster of connected devices + **▶ START GAME** button — launching transitions all devices to their game screen

**Added: Objective Claim Sheet**
- Hider must satisfy two conditions to clear an objective:
  1. **GPS check** — must be within 40m of the landmark (shows exact distance if too far)
  2. **Photo proof** — tap to open camera (`capture="environment"` opens rear camera on mobile), preview thumbnail shown after capture
- Both checks show ✓ / ○ status; **CONFIRM CLAIM** button only activates when both are green
- Sheet slides up automatically when entering range, can be dismissed and re-opened via the pulsing in-range tap target
- Objectives no longer auto-clear — manual proof required every time

## User

Verifier agent check completed

## Assistant

_[tool: update_todos]_

All verified and clean across every screen. ✓

**Possible next steps:**

- **Real GPS** — swap simulated coords for `navigator.geolocation.watchPosition()` so actual phones update their positions live
- **Photo upload to server** — the claim sheet captures the image locally; in production it would POST to your backend for admin review before the objective clears
- **Admin approval of claims** — admin could see incoming claim photos and approve/reject before the objective advances
- **Sound & haptics** — proximity NEAR state could trigger `navigator.vibrate()` + an audio alert on mobile
- **PWA manifest** — add `manifest.json` + service worker so players can install to home screen for full-screen field use
- **Multiple hiders** — the data model and map already support `hiders[]`, just needs a second role slot in the lobby
- **Tiebreaker / scoring** — objectives cleared vs time survived leaderboard on the Game Over screen

