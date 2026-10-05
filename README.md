# diarmuid-webpage

Diarmuid's personal website — a static site with a couple of small backend pieces, deployed on Cloudflare.

## Structure

```
index.html                   Homepage (static HTML/CSS/JS, no build step)
bookclub/index.html          /bookclub page (members, availability, discussion, reactions; see below)
bookclub/reactions.js        Emoji reactions module used by the bookclub page
bookclub_world/index.html    /bookclub_world/ 3D multiplayer room (Three.js + Firestore, see below)
assets/                      Images and audio (HOTW mp3, gang.jpg background)
assets/book-covers/          Cover images + manifest.json (array of filenames) for the bookclub page
version.json                 { "version": ... } read by the homepage to force a reload on deploy
_headers                     Cloudflare Pages header rules (disables caching)
firestore.rules              Firestore security rules (deployed with the Firebase CLI)
firebase.json, .firebaserc   Firebase CLI config (project: diarmuid-webpage)
location-worker/             Cloudflare Worker + D1 backing the "Locations" map on the homepage
tools/                       Local scratch/tooling (not part of the deployed site)
```

## Homepage (`index.html`)

Single static page, no build tooling — just open it or deploy the folder as-is. It includes:

- **Heat of the Month** — an audio player for `assets/HOTW 1.mp3`.
- **Top Songs (last 7 days)** — fetched client-side from the Last.fm API for user `diarmuidcoffey`.
- **Locations** — a Leaflet map plotting points fetched from the `location-worker` API (see below). All client-side, no Worker changes:
  - The trail is drawn as per-segment lines and small dots that fade and shift from blue (oldest) to red (newest) within the points currently shown; the latest shown point is a larger pulsing marker.
  - Range buttons (24h / 7d / 30d / All, relative to now) filter the points and re-fit the map. A slider scrubs through the filtered points in time order, and ▶ Play animates it (about 10s end to end).
  - Tapping a point shows its time in a popup. There are no place names, as that would need reverse geocoding.
  - Timestamps without a zone (D1 `YYYY-MM-DD HH:MM:SS`) are treated as UTC and shown in the viewer's local time.
- **Comments** — a simple guestbook backed directly by Firebase Firestore from the client.
- **Version check** — polls `version.json` and reloads the page when the version changes, to bust caching.
- A bouncing "NEW: bookclub" banner linking to `/bookclub`.

The Last.fm API key and Firebase config are embedded client-side by design (they're public-facing keys, not secrets).

## Bookclub (`bookclub/index.html`)

Single static page using the same Firebase project as the homepage (Firestore, client-side) plus d3 from cdnjs. No build step.

- **Currently Reading** — hardcoded `CURRENT_BOOK` constant in the page; covers listed in `assets/book-covers/manifest.json` cycle every 3s.
- **Join / log in** — no real auth. Joining creates a `bookclub_members` doc (name, avatar, bio); logging in just picks a name from the list, so anyone can log in as anyone (including the Moderator) — this impersonation is an intended feature, not a bug. The identity is stored in `localStorage` (`bookclubMember`). A member named `Moderator` gets special styling (dark red page, highlighted comments, chases members in the canvas).
- **Avatars** — uploaded images are resized client-side to a 200px JPEG data URL and stored in Firestore; a generated initials avatar is used if none is uploaded.
- **Edit Bio** — updates the member's `bio`.
- **My Availability / Best Dates** — members add dates (`bookclub_availability`); Best Dates tallies them live, most-available first, with clickable avatars opening a profile modal.
- **Members** — avatar row (latest 20) and member count; "Watch the members play" runs a d3 force-simulation canvas.
- **Discussion** — live comment feed (`bookclub_comments`).
- Also includes an a-ads ad unit and the same `version.json` reload check as the homepage.

Firestore collections: `bookclub_members`, `bookclub_availability`, `bookclub_comments`, `bookclub_reactions`.

### Emoji reactions (`bookclub/reactions.js`)

Any element with a `data-react-id="kind:id"` attribute automatically gets a reaction bar (emoji pills, a ＋ picker and a "who?" link that opens a list of who reacted, when, and with what). A `MutationObserver` keeps bars in sync when the page re-renders, so a new feature only needs to add the attribute.

Target ID kinds in use:

| Kind | Example | Where |
|---|---|---|
| `comment` | `comment:<docId>` | Each discussion comment |
| `book` | `book:current` | Currently-reading block |
| `date` | `date:2026-10-05` | Each row of Best Dates |
| `feature` | `feature:play` | The "Watch the members play" button |
| `avatar` | `avatar:<memberId>` | Profile picture in the profile modal only |
| `bio` | `bio:<memberId>` | Bio in the profile modal only |

- Mobile: pills and buttons are sized for touch, the picker is a 4-column grid that closes on scroll, and pressing and holding a pill (touch only) opens the who-reacted list filtered to that emoji, since phones have no hover tooltip.
- Palette: 👍 ❤️ 😂 🔥 📚 😮 😢 🎉. The 🤖 reaction is Moderator-only, and the Moderator can use nothing else.
- Storage: one doc per (target, member, reaction) in `bookclub_reactions`, id `<targetId>__<memberId>__<reaction>`, with `createdAt` set by the server. Clicking a reaction you already made deletes the doc.
- Avatars are not stored on reactions; the "who?" modal looks them up from the members list.

### Firestore rules

Rules live in `firestore.rules` (the old wide-open rule is gone; only the listed collections are reachable). Existing collections are still open read/write. `bookclub_reactions` is validated (emoji whitelist, Moderator-only 🤖, server timestamp, and the reacting member must exist and match the stored name). `bookclub_world_positions` is validated too (exact field set including the bot lease/catch fields, x/z inside the room, vx/vz bounded, `lastSeen` must be the server time, no deletes). **Any new collection must be added to `firestore.rules`.** Logging in as any member, including the Moderator, is intentional, so the rules are guard rails rather than identity checks. To deploy:

```
npm install -g firebase-tools   # once
firebase login                  # once
firebase deploy --only firestore:rules
```

Deploying only replaces the rules; it never changes or deletes data.

## Bookclub World (`bookclub_world/index.html`)

A first-person 3D room at `/bookclub_world/`, built with Three.js (r128 from cdnjs) and the same Firebase project. Single static page, no build step.

- **Room** — a 40x40 square room, 14 high (floor, four walls, ceiling). Constants at the top of the script.
- **Controls** — desktop: WASD/arrows to move, drag the mouse to look. Phone: floating joystick on the left half of the screen to move, drag on the right half to look.
- **Landscape only on phones** — in portrait, touch devices see a full-screen "rotate your phone" overlay (CSS). On first touch it also tries a fullscreen + landscape orientation lock, which only works on Android Chrome; iOS relies on the overlay.
- **Errors** — Firestore load/save/listener failures are shown in red in the HUD (a `permission-denied` error names the collection whose rules need fixing).
- **Identity** — reuses the `/bookclub` login (`bookclubMember` in `localStorage`). Not logged in = spectator: can look around and see others but has no avatar and saves nothing.
- **Avatars** — other players are a coloured body with their avatar as a camera-facing circular "face" sprite plus a name label.
- **Persistence** — each member's position is stored in Firestore collection `bookclub_world_positions/{memberId}` as `{ x, z, yaw, vx, vz, lastSeen, name, avatar }` (x/z is the floor plane, vx/vz the current velocity in units/second). On load the member resumes where they left off; first-time members spawn near the centre.
- **Live positions and Firestore cost controls**
  - Writes only happen when the player has moved, at most once every 1.5s (starting or stopping is sent after at least 0.75s), plus on tab hide/page hide and a 90s heartbeat while standing still. Looking around without moving doesn't write. `name`/`avatar` are sent only on the first write of a session.
  - Every member who has ever been in the world stays visible at their last saved position. Players who moved in the last 10 seconds are "here now"; anyone idle longer is shown dimmed where they stand (no extrapolation). Activity is judged from position changes seen on this device's own clock (heartbeat writes don't count, and clock skew can't dim people); on first load it falls back to the stored timestamp. The Moderator never dims. The HUD shows both counts.
  - The listener reads the 100 most recently seen positions (ordered by `lastSeen`) and is detached while the tab is hidden. Each (re)attach re-reads those docs once, so reads per session are roughly (members x tab returns) plus live updates.
  - Each write includes the player's velocity; other clients dead-reckon (project forward from the last update, capped at 2.5s, clamped to the room) and ease toward that point, so a 1.5s update rate still looks smooth.
  - Reads scale roughly with (players online)² x write rate. This is fine for a small club; a large audience would need Realtime Database or a Durable Object instead.
- **The Moderator bot** — while no real Moderator is logged in, a giant (5x) Moderator chases players around the room.
  - **One leader simulates it.** It is stored as a normal position doc (`bookclub_world_positions/moderator_bot`, name `Moderator`) carrying `leaderId` and `leaseUntil`. One logged-in client at a time holds a 6s lease (claimed in a Firestore transaction when the lease has expired, renewed on each bot write), runs the chase at 60fps and writes the bot every 1.5s with velocity, like a player. Everyone else renders and smooths it like any other player. The lease is released when the leader's tab is hidden or closed so another client takes over quickly.
  - **Chase logic** — the bot (3.2 units/s, slower than players at 4) goes for the closest active player (seen in the last 2 minutes, leader included). On a catch (within about 2.5 units) it records `caughtId`/`caughtAt` (the caught player sees the caught screen) and walks away to the room corner farthest from them for 5s (so a lone player isn't trapped), then picks its next target: anyone caught in the last 15s is skipped, and if everyone was caught recently it picks whoever was caught longest ago. With nobody active it stands still.
  - **Look** — the Moderator has a red body and red name label, and its face is the avatar of the member named `Moderator` (looked up by the leader from `bookclub_members` when it claims the lease and stored on the bot doc; other clients swap the face in when it arrives). Falls back to a red "M" circle if there is no such member.
  - **Caught screen** — the caught player gets a full-screen "YOU WERE CAUGHT BY THE MODERATOR. PLAY NICER" overlay and can't move for 3s (they can still look around).
  - **Collision** — players are pushed out of the bot so they can't stand inside it. The room is 14 high so the giant fits.
  - Lease timing uses each client's own clock, so large clock skew between devices could cause the lease to flap.
  - Not built yet: stepping aside when a real Moderator logs in.
- Needs the `bookclub_world_positions` rule in `firestore.rules` (see "Firestore rules" under Bookclub); the `lastSeen` single-field index is automatic.
- Linked from `/bookclub` by a bouncing "NEW: Moderator's World" banner (same style as the homepage's bookclub banner) that only shows when a member other than the Moderator is logged in.
- **The Moderator member can't enter.** Logged in as `Moderator`, the page shows a "not allowed" message instead of loading (no rendering, no Firestore writes), and the banner is hidden. Any position doc named `Moderator` other than `moderator_bot` is ignored when rendering, so the only Moderator in the world is the chasing bot. Includes the same `version.json` reload check.

## `location-worker/`

A Cloudflare Worker exposing `GET/POST /api/location`, backed by a Cloudflare D1 database.

- `POST /api/location` — appends a `{ lat, long }` point. Requires header `X-Auth-Token` matching the `LOCATION_SECRET` secret.
- `GET /api/location?limit=N` — returns up to `N` (default 500, max 2000) recent points, oldest first.

### Setup

```
cd location-worker
npm install -g wrangler   # if not already installed
wrangler d1 execute diarmuid-locations --file=migrations/0001_create_locations.sql
wrangler secret put LOCATION_SECRET
```

### Local development

```
cd location-worker
wrangler dev
```

`.dev.vars` in this folder holds the local `LOCATION_SECRET` value and is git-ignored.

### Deploy

```
cd location-worker
wrangler deploy
```

The homepage auto-detects `localhost`/`127.0.0.1` and points at `http://localhost:8787/api/location` in that case; otherwise it calls the deployed worker at `https://diarmuid-location-api.diarmuidcoffey99.workers.dev/api/location`.

## Deployment

The site itself is deployed via Cloudflare Pages (static hosting of the repo root); `_headers` disables caching so the version-check reload logic always sees fresh content. The Worker in `location-worker/` is deployed separately via `wrangler deploy`.
