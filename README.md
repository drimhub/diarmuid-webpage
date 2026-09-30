# diarmuid-webpage

Diarmuid's personal website — a static site with a couple of small backend pieces, deployed on Cloudflare.

## Structure

```
index.html                   Homepage (static HTML/CSS/JS, no build step)
bookclub/index.html          /bookclub page (Firebase-backed book club app, see below)
bookclub_world/index.html    /bookclub_world/ 3D multiplayer room (Three.js + Firestore, see below)
assets/                      Images and audio (HOTW mp3, gang.jpg background)
assets/book-covers/          Cover images + manifest.json (array of filenames) for the bookclub page
version.json                 { "version": ... } read by the homepage to force a reload on deploy
_headers                     Cloudflare Pages header rules (disables caching)
firestore.rules              Firestore security rules (deploy with the Firebase CLI, see below)
firebase.json, .firebaserc   Firebase CLI config (project diarmuid-webpage)
location-worker/             Cloudflare Worker + D1 backing the "Locations" map on the homepage
tools/                       Local scratch/tooling (not part of the deployed site)
```

## Homepage (`index.html`)

Single static page, no build tooling — just open it or deploy the folder as-is. It includes:

- **Heat of the Month** — an audio player for `assets/HOTW 1.mp3`.
- **Top Songs (last 7 days)** — fetched client-side from the Last.fm API for user `diarmuidcoffey`.
- **Locations** — a Leaflet map plotting points fetched from the `location-worker` API (see below).
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

Firestore collections: `bookclub_members`, `bookclub_availability`, `bookclub_comments`.

## Bookclub World (`bookclub_world/index.html`)

A first-person 3D room at `/bookclub_world/`, built with Three.js (r128 from cdnjs) and the same Firebase project. Single static page, no build step.

- **Room** — a 40x40 square room (floor, four walls, ceiling). Constants at the top of the script.
- **Controls** — desktop: WASD/arrows to move, drag the mouse to look. Phone: floating joystick on the left half of the screen to move, drag on the right half to look.
- **Landscape only on phones** — in portrait, touch devices see a full-screen "rotate your phone" overlay (CSS). On first touch it also tries a fullscreen + landscape orientation lock, which only works on Android Chrome; iOS relies on the overlay.
- **Errors** — Firestore load/save/listener failures are shown in red in the HUD (a `permission-denied` error names the collection whose rules need fixing).
- **Identity** — reuses the `/bookclub` login (`bookclubMember` in `localStorage`). Not logged in = spectator: can look around and see others but has no avatar and saves nothing.
- **Avatars** — other players are a coloured body with their avatar as a camera-facing circular "face" sprite plus a name label.
- **Persistence** — each member's position is stored in Firestore collection `bookclub_world_positions/{memberId}` as `{ x, z, yaw, lastSeen, name, avatar }` (x/z is the floor plane). On load the member resumes where they left off; first-time members spawn near the centre.
- **Live positions and Firestore cost controls**
  - Writes only happen when the player has moved, at most once every 3s, plus on tab hide/page hide and a 90s heartbeat while standing still. `name`/`avatar` are sent only on the first write of a session.
  - The listener only queries players seen in the last 5 minutes (`lastSeen`), capped at 30, and is detached while the tab is hidden.
  - Remote players are interpolated client-side, so low update rates still look smooth.
  - Reads scale roughly with (players online)² x write rate. This is fine for a small club; a large audience would need Realtime Database or a Durable Object instead.
- Needs the `bookclub_world_positions` rule in `firestore.rules` (deployed, see "Firestore rules" below); the `lastSeen` single-field index is automatic.
- Linked from `/bookclub`. Includes the same `version.json` reload check.

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

## Firestore rules

Rules live in `firestore.rules` and cover every collection the site uses (`comments`, `bookclub_members`, `bookclub_availability`, `bookclub_comments`, `bookclub_reactions`, `bookclub_world_positions`). Anything not listed is denied. There's no Firebase Auth, so the rules are guard rails that validate the shape of writes, not real access control. The older collections are open; `bookclub_reactions` and `bookclub_world_positions` validate writes (world positions: exact field set, x/z inside the room, `lastSeen` must be the server time, no deletes). **Any new collection must be added here.** Deploy with:

```
firebase login            # first time only
firebase deploy --only firestore:rules
```

Deploying replaces whatever rules are live in the Firebase console.

## Deployment

The site itself is deployed via Cloudflare Pages (static hosting of the repo root); `_headers` disables caching so the version-check reload logic always sees fresh content. The Worker in `location-worker/` is deployed separately via `wrangler deploy`.
