# letsmeetup roadmap

What is built, and the remaining steps in order. Rules and decisions are in [CLAUDE.md](CLAUDE.md); setup and structure are in [README.md](README.md). Tick items off here as they land.

## Done

- [x] **1. Skeleton:** Worker + static assets on `letsmeetup.diarmu.id`, D1 schema, Google sign-in, hashed cookie sessions, CSRF header/Origin check.
- [x] **2. Google spike:** `npm run spike` ran real Places + Routes calls. Findings: the matrix accepts `arrivalTime`; Nearby Search returns rating, hours, outdoor seating etc. with the full field mask; walking is unrealistic beyond short trips. Raw responses are in `fixtures/` (git-ignored).
- [x] **3. Neighbourhoods:** `public/areas.json` (242 areas), on-device snapping (`public/snap.js`), server lookup by id (`src/areas.js`), preview picker, tests.

## Before moving on (small, do soon)

- [ ] Set up Google Cloud for real use: OAuth client ID into `wrangler.toml`, create the D1 database and put its id in `wrangler.toml`, apply the remote migration, first `npm run deploy`, confirm sign-in works at `https://letsmeetup.diarmu.id`.
- [ ] Read Cloud Console → Billing → Reports (group by SKU) for the spike's calls. Record which SKUs the transit, bike and walk matrices and the two Nearby Search masks hit, and update the cost estimate in CLAUDE.md.
- [ ] Sanity-check the area list with `npm run areas:map` (browse all areas on OpenStreetMap). Fix names/anchors via `scripts/build-areas.mjs`.
- [ ] Set Google Cloud daily quotas (about 100 requests/day per API while testing) and a $25 budget alert.

## 4. Events: create, share, join

Nothing is saved from the UI until this step. Everything goes through `/api/*` with the existing session and CSRF checks.

- **API**
  - `POST /api/events` (signed in, Turnstile): `{ title, event_type, start_at, tags[] }` → creates the event, adds the owner as a participant, returns the `join_code`. Limits: title 1-80 chars, `start_at` in the future (and within, say, 90 days), type in `lunch|dinner|drinks`, tags from an allow-list in code, max events per user per day.
  - `GET /api/events/:code`: event details and the participant list (first name, area name, mode, whether they've set a location; never anything else). Visible to anyone signed in who has the code (that is what the link is).
  - `POST /api/events/:code/join`: adds the signed-in user (idempotent), enforces `max_participants` (12).
  - `PUT /api/events/:code/me`: `{ area_id, mode, max_minutes? }`. Validates `area_id` against `src/areas.js`, mode in `transit|bike|walk` (walk only if the area is plausibly close, enforced later by the calculation, not here). Rejects changes while status is `calculating`.
  - Owner only: `POST .../lock` (status → `closed`), `DELETE .../participants/:id`, `DELETE /api/events/:code`.
- **Front end:** the page needs routes `/` (my events + create), `/e/<code>` (join / my location / results), set `assets.not_found_handling = "single-page-application"` in `wrangler.toml` so `/e/...` serves `index.html`. Likely split `public/index.html` into a small app module + CSS now that it grows. Mobile-first (people open the link from WhatsApp).
  - Create form (title, type, date/time in London time, tags), then a share screen with a copy-link button and the native share sheet.
  - Join screen: sign in → pick area (reuse the snapping picker) → choose transit/bike → optional "max minutes" → see who's in.
  - Owner view: participant list with who hasn't set a location, remove button, "Find a spot" button (enabled when at least 2 people have locations; wired up in step 6).
- **Share link:** `/e/<join_code>`; the code is ~10 random base32 chars. Add Open Graph tags later via a Worker-rendered shell (title and "X invited you") if the plain link preview looks poor.
- **Turnstile:** needs a widget for `letsmeetup.diarmu.id` and a `TURNSTILE_SECRET` Worker secret.
- **Tests:** API handler tests against a local D1 (`wrangler`'s test setup or an in-memory SQLite shim), covering limits, ownership checks, and that no endpoint accepts or returns coordinates.
- **Docs:** README API table, schema notes.

## 5. Provider layer and replay harness

Do this before the heuristics, so tuning never touches live paid APIs. See the provider rules in CLAUDE.md.

- `src/providers/types.js`: normalised `Venue`, `TravelTime`, `Area` shapes (JSDoc typedefs) and the two interfaces: `findVenues(area, filters)` and `getTravelTimes(origins, destinations, { arriveBy | departAt })`.
- `src/providers/places/google.js`: Nearby Search with the minimal full-field mask, mapping tags to Places fields (`outdoorSeating`, `servesBeer`, `goodForGroups`, `reservable`) and event types to included types; normalises opening hours to "open at `start_at` / closes after X".
- `src/providers/routing/google.js`: one matrix per mode; **batches under the 100-element transit cap** and the 625 cap for other modes; uses `arrivalTime` for transit (the spike showed it is accepted); retries/backoff; partial-failure handling (a cell with no route becomes "unreachable", not a crash); returns a cost counter (requests, elements).
- `src/providers/index.js`: picks the provider from `PLACES_PROVIDER` / `ROUTING_PROVIDER`.
- **Record/replay harness:** a `recording` wrapper that saves provider input and output keyed by a hash, and a `replay` provider that serves them with no network. Convert the spike's `fixtures/` into the first scenario, then record a few more (see step 6). Fixtures stay git-ignored (Google content); document how to regenerate them.
- **Contract tests:** run the same assertions against every provider implementation (and the replay provider) so a future TravelTime/Foursquare/OSM provider can be dropped in.

## 6. The calculation (heuristics, the bulk of the work)

Pure functions over normalised types in `src/calc/`, so they run offline against replayed fixtures.

1. **Candidate areas.** From the participants' area anchors: centroid, geometric median (Weiszfeld), minimax centre (smallest enclosing circle), plus the nearest few `areas.json` anchors to each. Dedupe and keep about 6-8. *Note:* a precomputed area-to-area transit time table would be better but is too expensive (243 x 243 = ~59k matrix elements, hundreds of dollars), so v1 pre-filters with straight-line distance and a mode-based speed factor. Revisit if TfL data or a cheaper provider is added.
2. **Venues.** Provider `findVenues` per candidate area, widening the radius (150m → 800m) until there are enough venues. Reject venues outside London, closed at `start_at`, below a minimum rating/review count, or failing hard tags (open late = closes at least 2h after start).
3. **Shortlist** to about 10-15 venues across the candidate areas (diverse, best-rated per area) so the matrix stays small (cost scales with participants x venues).
4. **Travel times.** `getTravelTimes` from each participant's area anchor to each venue, by that participant's mode, arriving by `start_at`. People with `max_minutes` below their time veto the venue.
5. **Score.** Weighted mean time + max time + spread (max - min), small bonus for rating and tag matches. Weights start as constants in one file and get tuned on the scenarios below.
6. **Pick 3-5 with diversity.** No two from the same area unless the pool is tiny; label each by what it wins ("Fastest overall", "Fairest", "Best rated"). Store `score_breakdown` so the UI can explain why.
7. **Summary.** Per person time and mode, total, mean, who travels furthest and by how much, spread.

- **Scenarios** (`test/scenarios/*.json`): realistic groups with expected qualitative outcomes, e.g. four people spread across north/south/east with one cyclist (the spike scenario), two people at opposite ends of one line, a group that all live in one area, one person very far out, someone with a tight `max_minutes`. Tests assert properties (nobody over their limit, furthest person not worse than X, picks are diverse), not exact venues.
- **Weight tuning** is done against replayed fixtures only. Record new fixtures sparingly (each costs real money).

## 7. Run it: async calculation and results

- `POST /api/events/:code/calculate` (owner): checks at least 2 located participants, the per-event run cap (3), a global daily budget guard (a counter in D1 that refuses runs past a limit), then creates a `calc_runs` row (`running`), snapshots the inputs, sets the event to `calculating` and does the work in `ctx.waitUntil`. Returns immediately.
- The work: step 6 → write `suggestions` and `travel_times` → `calc_runs.status = done`, event `done`. On any error: `failed` with a user-safe message and the real error logged. A stale-run reaper (a run still `running` after a few minutes is marked `failed`).
- `GET /api/events/:code` includes the latest run state and, when done, suggestions with per-person times. The client polls every few seconds.
- **Results UI:** 3-5 cards (venue name, rating, why it won, "Open in Google Maps" link), a per-person travel table with mode and minutes, a clear "X travels furthest (N min)" flag, and the cost-free "re-run" for the owner after changes. Google attribution as the terms require. A map is optional (an OpenStreetMap/Leaflet map of the venues and participants' areas).
- Check the Workers `waitUntil` time limit against a realistic run; if it is marginal, move the work to a Cloudflare Queue (needs the paid plan).

## 8. Hardening and launch

- Security headers: add a Content-Security-Policy (allow `accounts.google.com`, Turnstile, `api.postcodes.io`, and OpenStreetMap tiles if a map is used).
- Rate limiting on auth, event creation and calculate (Cloudflare rate-limiting rules or a D1 counter).
- Privacy: a short plain-English privacy note (what is stored: Google account name/email/avatar, area, mode; what is not: exact location). A retention job (Cron Trigger) deleting events, participants and runs about 30 days after `start_at`, plus expired sessions. "Delete my data" for a signed-in user.
- Google Maps Platform: confirm the caching/attribution terms against what is stored (provider id long-term, other content briefly), final quotas and budget alerts, restrict the key to Places API (New) + Routes API.
- Observability: structured error logging (`wrangler tail` is enough to start), a simple per-day cost counter in D1 shown to the owner.
- Review all area anchors; run `npm test`; deploy checklist in the README; update both READMEs and root `CLAUDE.md` if conventions changed.

## Later (v2 and ideas)

- Voting on the suggestions and a "chosen venue" state.
- Subtags (step-free, vegan, dog-friendly, etc.) and more event types.
- Other providers behind the interfaces: TravelTime (isochrone intersection looks well-suited; check licence/price), TfL (free but one call per pair, needs the paid Workers plan), Foursquare, OSM/Overture for free candidate generation.
- Add friends without Google accounts (the schema already allows `participants.user_id` to be null).
- Optional "precise" start point (still stored only as a neighbourhood).
- Notifications (email/WhatsApp share text), calendar invite for the chosen venue.
- Hosting the map/area review as a proper admin tool if the list keeps changing.
