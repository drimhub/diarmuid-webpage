# letsmeetup

**letsmeetup.diarmu.id** — helps a group of friends in London find a place to meet that is a fair compromise for everyone's journey. Design rules and decisions are in [CLAUDE.md](CLAUDE.md).

Status: **steps 1-3 of the build.** What exists: the Worker with static assets, the D1 schema, Google sign-in and cookie sessions, the neighbourhood list and on-device snapping (shown as a preview picker on the home page; nothing is saved yet), and the Google spike script. Events, the calculation and the results UI are not built yet. The remaining steps are in [ROADMAP.md](ROADMAP.md).

## Structure

```
wrangler.toml            Worker config: custom domain, static assets, D1 binding, vars
migrations/0001_init.sql D1 schema (users, sessions, events, participants, calc_runs, suggestions, travel_times)
src/index.js             Worker entry: /api/* routes; everything else is served from public/
src/auth.js              Google ID-token verification, hashed cookie sessions
spike/google-spike.mjs   One-off script: real Places + Routes calls for a London test scenario (`npm run spike:dry` previews the requests with no network; `npm run spike` makes the real, billable calls); saves raw responses to fixtures/ (git-ignored)
src/areas.js             Server-side area lookup by id (bundles public/areas.json); coordinates always come from here
scripts/build-areas.mjs  Builds public/areas.json from OpenStreetMap (`npm run build:areas`); curation lists (MUST_HAVE, EXCLUDE, INCLUDE_EXTRA) live in this file
public/areas.json        ~240 London neighbourhoods { id, name, lat, lng }: the anchors people snap to and routing starts from
public/snap.js           On-device snapping: nearest area, type-ahead, postcode lookup, geolocation (pure functions, unit-tested)
dev/areas-map.html       Local-only map of every area on OpenStreetMap, for sanity-checking the list (not deployed)
scripts/serve-areas-map.mjs  `npm run areas:map` serves that page at http://localhost:5174
ROADMAP.md               What's done and the remaining steps in detail
test/snap.test.mjs       `npm test`: areas.json sanity checks and snapping/search/postcode tests
public/index.html        Front end (Google sign-in and the preview location picker)
public/_headers          Security headers for static files
```

## API (so far)

| Route | |
|---|---|
| `GET /api/config` | `{ googleClientId }` for the sign-in button |
| `GET /api/me` | `{ user }` or `{ user: null }` |
| `POST /api/auth/google` | Body `{ credential }` (Google ID token). Verifies it, creates the user and a session cookie |
| `POST /api/auth/logout` | Deletes the session |

Every non-GET request must send `X-Requested-With: letsmeetup` and (if present) an `Origin` equal to the site's own.

The session cookie is `__Host-lm_session` (HttpOnly, Secure, SameSite=Lax, host-only; `lm_session` over plain-http local dev). Only its SHA-256 is stored in D1.

## Neighbourhoods and snapping

- Where someone travels from is only ever one of the areas in `public/areas.json`. The browser picks it from a typed area name, a postcode, or the device's location, and sends **only the area id** to the server. Exact coordinates and postcodes are never sent to or stored by our server.
- Postcodes and outcodes (e.g. `E8`) are resolved with the free [postcodes.io](https://postcodes.io) API directly from the browser, so postcodes.io sees the postcode (our server doesn't). Browser geolocation stays on the device.
- A point snaps to the nearest area anchor, and is rejected if it is outside the Greater London envelope (`LONDON_BOUNDS`) or more than 4 km (`MAX_SNAP_KM`) from any anchor.
- The list comes from OpenStreetMap place nodes (&copy; OpenStreetMap contributors, ODbL; credited on the page) trimmed by `scripts/build-areas.mjs`. To add, remove or rename an area, edit the lists at the top of that script and run `npm run build:areas` (it tries several Overpass mirrors, which are sometimes busy; `-- --from saved.json` reuses a saved response). Don't hand-edit `areas.json`, a rebuild would lose it.
- Anchors are OSM node positions (roughly the centre of each area) and are used as routing origins, so an anchor in the wrong spot skews travel times. Review them before launch.
- `npm test` runs the snapping tests.
- **Reviewing the list:** `npm run areas:map` opens a local map (http://localhost:5174) with every area as a marker, a filterable list, an optional 4 km snap-radius ring, and click-anywhere to see what a point snaps to. Areas whose anchors are under 0.6 km from another area, or over 4 km from any other, are shown in red (outer-edge places like Biggin Hill are legitimately isolated; a stray one may be outside London).

## One-time setup

1. **D1**: `cd letsmeetup && npm install && npx wrangler d1 create letsmeetup`, put the returned `database_id` in `wrangler.toml`, then `npm run db:remote`. (You'll need `npx wrangler login` once.)
2. **Google OAuth client**: Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID → Web application. Add authorised JavaScript origins `https://letsmeetup.diarmu.id` and `http://localhost:8787`. Put the client ID in `GOOGLE_CLIENT_ID` in `wrangler.toml` (it is public). The consent screen only needs the default `openid email profile` scopes.
3. **Deploy**: `npm run deploy`. Cloudflare creates the `letsmeetup.diarmu.id` DNS record and certificate (the `diarmu.id` zone must be in the same Cloudflare account).

4. **Google Maps key** (for `npm run spike` and later the calculation): create a key restricted to Places API (New) and Routes API, put `GOOGLE_MAPS_API_KEY=...` in `letsmeetup/.dev.vars` for local use and run `npx wrangler secret put GOOGLE_MAPS_API_KEY` for production. Set a billing alert and low daily quotas on both APIs.

Later steps will add Turnstile on event creation.

## Local development

Wrangler is a pinned dev dependency of this folder (not a global install, and not just an `npx` cache that can disappear), so after cloning run `npm install` once. Use the npm scripts (or `npx wrangler ...`) rather than a bare `wrangler`.

```
cd letsmeetup
npm install
npm run db:local      # apply migrations to the local D1
npm run dev           # http://localhost:8787
npm run db:remote     # apply migrations to the real D1
npm run deploy
```
