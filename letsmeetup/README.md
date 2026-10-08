# letsmeetup

**letsmeetup.diarmu.id** — helps a group of friends in London find a place to meet that is a fair compromise for everyone's journey. Design rules and decisions are in [CLAUDE.md](CLAUDE.md).

Status: **steps 1-6 of the build.** What exists: the Worker with static assets, the D1 schema, Google sign-in and cookie sessions, the neighbourhood list and on-device snapping, the Google spike script, the events flow (create, share link, join, say where you're travelling from, organiser controls), the provider layer (Google Places and Routes behind swappable interfaces, plus a record/replay harness), and the calculation itself (`src/calc/`: picks 3-5 fair venues with a journey summary). The calculation is not yet wired to the API or UI (the "Find a spot" button is a placeholder). The calculation and the results UI are not built yet (the "Find a spot" button is a placeholder). The remaining steps are in [ROADMAP.md](ROADMAP.md).

## Structure

```
wrangler.toml            Worker config: custom domain, static assets (SPA fallback), D1 binding, vars
migrations/0001_init.sql D1 schema (users, sessions, events, participants, calc_runs, suggestions, travel_times)
src/index.js             Worker entry: /api/* routing, CSRF check; everything else is served from public/
src/auth.js              Google ID-token verification, hashed cookie sessions
src/events.js            /api/events/* handlers (create, list, view, join, set my area, leave, lock, remove, delete)
src/validate.js          Event types, tags, travel modes, limits, and input validation (area ids only, never coordinates)
src/turnstile.js         Cloudflare Turnstile check (fails closed)
src/util.js              JSON/response helpers, share-code generator
src/providers/types.js   Provider-neutral types and the two interfaces (findVenues, getTravelTimes)
src/providers/index.js   Chooses providers from PLACES_PROVIDER / ROUTING_PROVIDER (default google); registry for adding more
src/providers/places/google.js   Google Places (New) Nearby Search -> normalised venues
src/providers/routing/google.js  Google Routes computeRouteMatrix -> normalised travel times (batching, de-duplication)
src/providers/google-http.js     Shared Google HTTP: key header, field mask, retries, key-safe errors
src/providers/http.js    Record/replay at the HTTP level (recordingFetch / replayFetch / MemoryStore)
src/hours.js             Opening-hours logic over the normalised hours (open at a time, minutes until close)
src/areas.js             Server-side area lookup by id (bundles public/areas.json); coordinates always come from here
public/index.html        App shell
public/app.js            Front end: sign-in, home (create + my events), event page (share, my journey, who's in, organiser controls)
public/style.css         Styles (light/dark, mobile first)
public/snap.js           On-device snapping: nearest area, type-ahead, postcode lookup, geolocation (pure functions, unit-tested)
public/time.js          London-time helpers (typed London wall-clock time <-> UTC, formatting), unit-tested
public/areas.json        ~280 London neighbourhoods { id, name, lat, lng }: the anchors people snap to and routing starts from
public/_headers          Security headers for static files
scripts/build-areas.mjs  Builds public/areas.json from OpenStreetMap (`npm run build:areas`); curation lists (MUST_HAVE, EXCLUDE, INCLUDE_EXTRA) live in this file
scripts/serve-areas-map.mjs  `npm run areas:map` serves dev/areas-map.html at http://localhost:5174
dev/areas-map.html       Local-only map of every area on OpenStreetMap, for sanity-checking the list (not deployed)
spike/google-spike.mjs   One-off script: real Places + Routes calls for a London test scenario (`npm run spike:dry` previews the requests with no network; `npm run spike` makes the real, billable calls); saves raw responses to fixtures/ (git-ignored)
test/*.test.mjs          `npm test`: snapping, time helpers and the events API
testing/d1-shim.mjs      Test-only D1 look-alike on node:sqlite (applies the real migrations)
testing/fake-providers.mjs  Deterministic offline providers (straight-line travel times, synthetic venues), also for developing the heuristics
testing/google-stub.mjs  A fake Google (fetch) with synthetic Google-shaped responses; enforces the real element caps
testing/file-store.mjs   File-backed record/replay store for scripts and tests
scripts/run-scenario.mjs Runs the whole calculation for a scenario and prints the suggestions (`npm run scenario -- scenarios/<file>.json`; free on fakes by default, `--replay` from a recording, `--live --yes` for real Google calls)
scripts/explain-scenario.mjs  Replays a recording and prints every costed venue ranked by score, plus what was filtered out and why (`node scripts/explain-scenario.mjs scenarios/<file>.json`)
scenarios/*.json         Scenario inputs: people (name, area, mode, optional max minutes), event type, tags and time
src/calc/                The calculation: index.js (orchestrator), config.js (every tunable number), geo.js, candidates.js, venues.js, score.js, select.js
ROADMAP.md               What's done and the remaining steps in detail
```

## How it works (so far)

- **Create:** a signed-in user makes an event (title, type lunch/dinner/drinks, start time in London time, tags) behind a Turnstile check and gets a share link `https://letsmeetup.diarmu.id/e/<code>`. The code is 10 random base32 characters. They become the first participant.
- **Join:** anyone with the link signs in with Google and presses Join. Until they join they only see the title, type, time, organiser's first name and a head-count.
- **Say where you are:** participants pick a neighbourhood (typed name, postcode, or "use my location"), a travel mode (transit/bike/walk) and optionally a longest acceptable journey. Others see each person's first name, neighbourhood and mode; nobody else's longest-journey limit.
- **Organiser:** can lock/unlock the event, remove people, and delete the event (which deletes everything attached). Other people can leave.
- **Limits:** 12 people per event, 10 events created per user per day, start time at most 90 days ahead.
- The front end refreshes the "who's in" list every 15 seconds while the tab is visible.

## API

All routes are JSON. `GET` routes need nothing special; every other request must send `X-Requested-With: letsmeetup` and (if present) an `Origin` equal to the site's own. Routes under `/api/events` need a signed-in session (401 otherwise).

| Route | |
|---|---|
| `GET /api/config` | `{ googleClientId, turnstileSiteKey }` |
| `GET /api/me` | `{ user }` or `{ user: null }` |
| `POST /api/auth/google` | `{ credential }` (Google ID token). Verifies it, creates the user and a session cookie |
| `POST /api/auth/logout` | Deletes the session |
| `GET /api/events` | Events I'm in |
| `POST /api/events` | `{ title, eventType, startAt (ISO UTC), tags[], turnstileToken }` → `201 { code }` |
| `GET /api/events/:code` | `{ event, me, participants }`; for non-participants `me` is null and there is no `participants` |
| `POST /api/events/:code/join` | Join (idempotent; 409 if full or locked) |
| `PUT /api/events/:code/me` | `{ areaId, mode, maxMinutes? }`. Extra fields (including coordinates) are ignored |
| `DELETE /api/events/:code/me` | Leave (not for the organiser) |
| `POST /api/events/:code/lock` | Organiser: `{ locked: boolean }` |
| `DELETE /api/events/:code/participants/:id` | Organiser: remove someone |
| `DELETE /api/events/:code` | Organiser: delete the event |

The session cookie is `__Host-lm_session` (HttpOnly, Secure, SameSite=Lax, host-only; `lm_session` over plain-http local dev). Only its SHA-256 is stored in D1.

## Providers (places and routing)

Business logic never touches Google directly. It calls two interfaces defined in `src/providers/types.js`:

- `findVenues({ center, radiusMeters, eventType, maxResults }) -> { venues, cost }`: venues are normalised (id, name, location, rating, price level, normalised opening hours, outdoor-seating and similar attributes where `null` means unknown).
- `getTravelTimes({ origins: [{lat, lng, mode}], destinations, arriveBy }) -> { times, cost, warnings }`: an origins x destinations grid of `{ status, durationS, distanceM }`. The Google provider de-duplicates identical origins (cost saving) and splits requests to respect Google's caps (100 elements for transit, 625 otherwise); callers always ask for the whole matrix. Transit uses `arrivalTime`; a time in the past is dropped with a warning. Per-journey failures are flagged cells (`error` / `no_route`), not exceptions; HTTP failures throw `ProviderError` (transient 429/5xx are retried, and the API key never appears in errors).

`createProviders(env)` picks the implementation from `PLACES_PROVIDER` / `ROUTING_PROVIDER` (default `google`); to add one, write a factory and register it in `src/providers/index.js`. `npm test` runs one shared **contract suite** against every implementation (the Google code over a stubbed network, the offline fake, and Google replayed from recordings), so a new provider must pass the same tests.

**Record and replay.** `recordingFetch` / `replayFetch` (`src/providers/http.js`) capture and serve real API traffic at the HTTP level, so the real provider code runs against real data with no network and no cost. Requests match on method, URL, field mask and body (key order ignored); the API key is never matched or stored. A request that wasn't recorded throws `ReplayMissError` describing what was asked. `npm run scenario -- scenarios/<file>.json --live` shows the plan and worst-case cost; add `--yes` to run the whole calculation against real Google and save the traffic to `fixtures/scenarios/` (git-ignored, because it is Google content), then `--replay` serves it back. The pipeline chooses its own searches, so a recording contains exactly what a replay asks for. For everyday development use the fakes in `testing/` instead, which are free and deterministic.

## The calculation (`src/calc/`)

`computeSuggestions({ event, participants, areas, providers, config? })` returns plain JSON (stored as-is in step 7). It never mentions Google: providers are passed in, so it runs identically on the fakes, a recording, or live.

1. **Candidate areas** (free, no API). From everyone's neighbourhood: the centroid, the geometric median (least total distance), the minimax centre (least longest trip), and time-weighted versions of the last two (a cyclist covers more ground than a walker). Each snaps to its 3 nearest area anchors, candidates are pruned with a straight-line time estimate and anyone's personal limit, spaced at least 600 m apart, and the best 6 are kept. Each remembers which heuristics proposed it.
2. **Venue search.** One Places request per candidate (radius 500 m; widened once to 900 m if fewer than 3 venues qualify). Cost is bounded: at most 12 Places requests.
3. **Filters.** Right kind of place for the event (a "bar" search also returns hotels and cinemas), open at the start time (known-closed is never relaxed; unknown hours are allowed, penalised, and flagged to the user), a quality bar (rating and review count), and the tags: outdoor seating and open late (open at least 3 hours and until 23:00) are hard filters first. If fewer than 3 venues qualify, tags become preferences and then the quality bar drops, each with a note for the user.
4. **Shortlist** of at most 15 venues, round-robin across candidate areas so no area crowds out the rest. This bounds routing cost (people x venues).
5. **Journeys.** One routing call for everyone to every shortlisted venue, arriving by the start time. A venue is dropped if any journey is unavailable, over someone's own limit, or over the hard cap for their mode (walking 45 min, cycling 75, transit 120).
6. **Score** (minutes, lower is better): 1.0 x mean journey + 0.7 x longest + 0.3 x spread (longest minus shortest), minus a review bonus (6 minutes per star above 4.0, scaled by how many reviews back it), minus tag and large-group bonuses, plus penalties for unmet tags or unknown hours.
7. **Picks.** 3-5 venues, the best from each candidate area first (never two within 150 m), filled up from the rest only if there would be fewer than 3. Each pick gets labels it genuinely wins ("Quickest overall", "Fairest", "Shortest longest journey", "Best rated") and a journey summary (per person, mean, longest, spread and who travels furthest by how much).

**Known limitation:** candidate areas come from straight-line geometry, which misses network-shaped shortcuts (two people on the same tube line are better served by an interchange on that line than by the geometric centre). The planned fix and the evidence are in ROADMAP.md step 6.

Results: `status` is `ok`, `not_enough_people`, or `no_results` with a `reason` (`no_venues_found`, `no_venues_matched`, `no_venue_within_limits` with the three `closestMisses` and who they exceed, or `journeys_unavailable`). Also returned: user-facing `notes`, the `candidates` looked at, what was excluded and why, and the `cost` in provider requests. Every tunable number is in `src/calc/config.js` (overridable per call), and `HEURISTICS_VERSION` is stored with each run.

## Neighbourhoods and snapping

- Where someone travels from is only ever one of the areas in `public/areas.json`. The browser picks it from a typed area name, a postcode, or the device's location, and sends **only the area id** to the server. Exact coordinates and postcodes are never sent to or stored by our server.
- Postcodes and outcodes (e.g. `E8`) are resolved with the free [postcodes.io](https://postcodes.io) API directly from the browser, so postcodes.io sees the postcode (our server doesn't). Browser geolocation stays on the device.
- A point snaps to the nearest area anchor, and is rejected if it is outside the Greater London envelope (`LONDON_BOUNDS`) or more than 4 km (`MAX_SNAP_KM`) from any anchor.
- The list comes from OpenStreetMap place nodes (&copy; OpenStreetMap contributors, ODbL; credited on the page) trimmed by `scripts/build-areas.mjs`. To add, remove or rename an area, edit the lists at the top of that script and run `npm run build:areas` (it tries several Overpass mirrors, which are sometimes busy; `-- --from saved.json` reuses a saved response). Don't hand-edit `areas.json`, a rebuild would lose it.
- Anchors are OSM node positions (roughly the centre of each area) and are used as routing origins, so an anchor in the wrong spot skews travel times. Review them before launch.
- **Reviewing the list:** `npm run areas:map` opens a local map (http://localhost:5174) with every area as a marker, a filterable list, an optional 4 km snap-radius ring, and click-anywhere to see what a point snaps to. Areas whose anchors are under 0.6 km from another area, or over 4 km from any other, are shown in red (outer-edge places like Biggin Hill are legitimately isolated; a stray one may be outside London). By default it shows only the hand-placed anchors (`INCLUDE_EXTRA` in the build script, whose coordinates were placed from memory) as draggable pins; drag one to the right spot and press Copy to get replacement `INCLUDE_EXTRA` lines. The list of hand-placed names is written to `dev/extras.json` by the build. Untick the checkbox to see every area.

## One-time setup

1. **D1**: `cd letsmeetup && npm install && npx wrangler d1 create letsmeetup`, put the returned `database_id` in `wrangler.toml` (keep `binding = "DB"`), then `npm run db:remote`. (You'll need `npx wrangler login` once.)
2. **Google OAuth client**: Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID → Web application. Add authorised JavaScript origins `https://letsmeetup.diarmu.id` and `http://localhost:8787`. Put the client ID in `GOOGLE_CLIENT_ID` in `wrangler.toml` (it is public). The consent screen only needs the default `openid email profile` scopes.
3. **Turnstile**: Cloudflare dashboard → Turnstile → add a widget for `letsmeetup.diarmu.id`. Put the **site key** in `TURNSTILE_SITE_KEY` in `wrangler.toml` (it ships as Cloudflare's always-pass test key, which must be replaced before launch) and run `npx wrangler secret put TURNSTILE_SECRET` with the **secret key**. Without the secret, event creation is refused (it fails closed).
4. **Deploy**: `npm run deploy`. Cloudflare creates the `letsmeetup.diarmu.id` DNS record and certificate (the `diarmu.id` zone must be in the same Cloudflare account).
5. **Google Maps key** (for `npm run spike` and later the calculation): create a key restricted to Places API (New) and Routes API, put `GOOGLE_MAPS_API_KEY=...` in `letsmeetup/.dev.vars` for local use and run `npx wrangler secret put GOOGLE_MAPS_API_KEY` for production. Set a billing alert and low daily quotas on both APIs.

## Local development

Wrangler is a pinned dev dependency of this folder (not a global install, and not just an `npx` cache that can disappear), so after cloning run `npm install` once. Use the npm scripts (or `npx wrangler ...`) rather than a bare `wrangler`.

```
cd letsmeetup
npm install
npm run db:local      # apply migrations to the local D1
npm run dev           # http://localhost:8787
npm test              # unit + API tests (no network, no Wrangler needed)
npm run db:remote     # apply migrations to the real D1
npm run deploy
```

Local `.dev.vars` (git-ignored) should contain `TURNSTILE_SECRET=1x0000000000000000000000000000000AA` (Cloudflare's test secret, which always passes) alongside `GOOGLE_MAPS_API_KEY`. `TURNSTILE_DISABLED=1` skips the check entirely for local work. Real Google sign-in locally needs a real `GOOGLE_CLIENT_ID` in `wrangler.toml` and `http://localhost:8787` as an authorised origin.

`npm test` runs the API tests against `testing/d1-shim.mjs`, a small D1 look-alike on `node:sqlite` that applies the real migrations, so constraints, foreign keys and cascades behave like production.
