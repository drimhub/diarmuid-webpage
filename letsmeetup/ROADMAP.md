# letsmeetup roadmap

What is built, and the remaining steps in order. Rules and decisions are in [CLAUDE.md](CLAUDE.md); setup and structure are in [README.md](README.md). Tick items off here as they land.

## Done

- [x] **1. Skeleton:** Worker + static assets on `letsmeetup.diarmu.id`, D1 schema, Google sign-in, hashed cookie sessions, CSRF header/Origin check.
- [x] **2. Google spike:** `npm run spike` ran real Places + Routes calls. Findings: the matrix accepts `arrivalTime`; Nearby Search returns rating, hours, outdoor seating etc. with the full field mask; walking is unrealistic beyond short trips. Raw responses are in `fixtures/` (git-ignored).
- [x] **3. Neighbourhoods:** `public/areas.json` (279 areas), on-device snapping (`public/snap.js`), server lookup by id (`src/areas.js`), preview picker, tests.
- [x] **8. Hardening:** rate limits, daily retention cron, delete-my-data, privacy page, security headers (CSP report-only until checked in a browser), structured logging, launch checklist, and an independent security review whose findings are fixed. 175 tests.
- [x] **7. Run it:** `POST /calculate` with guards, background run, polling, results UI, out-of-date flag, stale-run cleanup, per-event and daily caps. 147 tests.
- [x] **6. The calculation:** candidate areas (centroid, median, minimax and time-weighted forms), venue search and filters with relaxation, shortlist, journey limits, scoring, diverse labelled picks and journey summaries; `npm run scenario`. 118 tests. Weights are first guesses, to be tuned on real recordings.
- [x] **5. Provider layer and replay harness:** normalised types and interfaces, Google Places + Routes providers (batching under the transit cap, de-duplicated origins, arrival times, retries), HTTP-level record/replay, shared contract suite, offline fakes, scenario recorder (`npm run record`). 76 tests.
- [x] **4. Events:** create, share link, join, set your neighbourhood and mode, organiser lock/remove/delete, Turnstile, limits, API tests (see the notes under step 4 below).

## Before moving on (small, do soon)

- [ ] Set up Google Cloud for real use: OAuth client ID into `wrangler.toml`, create the D1 database and put its id in `wrangler.toml`, apply the remote migration, first `npm run deploy`, confirm sign-in works at `https://letsmeetup.diarmu.id`.
- [ ] Read Cloud Console → Billing → Reports (group by SKU) for the spike's calls. Record which SKUs the transit, bike and walk matrices and the two Nearby Search masks hit, and update the cost estimate in CLAUDE.md.
- [ ] Sanity-check the area list with `npm run areas:map` (browse all areas on OpenStreetMap). Fix names/anchors via `scripts/build-areas.mjs`.
- [ ] Set Google Cloud daily quotas (about 100 requests/day per API while testing) and a $25 budget alert.

## 4. Events: create, share, join (built)

*Built as specified below, with these differences:* the API uses `eventType`/`startAt`/`areaId` camelCase JSON; `GET /api/events` lists my events; link holders who have not joined see only the basics; there is no OG-tag shell yet (later); the "Find a spot" button is a disabled placeholder until step 7. Still to do for this step: try it in a real browser on a phone with real Google sign-in (needs the deploy and OAuth client ID).

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

## 5. Provider layer and replay harness (built)

*Built, with these notes:* record/replay is at the HTTP level (so the real provider code is exercised) rather than wrapping provider methods; the offline `testing/fake-providers.mjs` and `testing/google-stub.mjs` are the everyday dev tools; `src/hours.js` holds the opening-hours logic. **For step 6:** replay only serves requests that were recorded, and the heuristics choose their own candidate areas, so a recorded scenario fixes the centres to search (see `scenarios/`). Develop the heuristics against the fakes, and use recorded scenarios as realism checks, re-recording when the candidate generation changes. The original plan follows.

Do this before the heuristics, so tuning never touches live paid APIs. See the provider rules in CLAUDE.md.

- `src/providers/types.js`: normalised `Venue`, `TravelTime`, `Area` shapes (JSDoc typedefs) and the two interfaces: `findVenues(area, filters)` and `getTravelTimes(origins, destinations, { arriveBy | departAt })`.
- `src/providers/places/google.js`: Nearby Search with the minimal full-field mask, mapping tags to Places fields (`outdoorSeating`, `servesBeer`, `goodForGroups`, `reservable`) and event types to included types; normalises opening hours to "open at `start_at` / closes after X".
- `src/providers/routing/google.js`: one matrix per mode; **batches under the 100-element transit cap** and the 625 cap for other modes; uses `arrivalTime` for transit (the spike showed it is accepted); retries/backoff; partial-failure handling (a cell with no route becomes "unreachable", not a crash); returns a cost counter (requests, elements).
- `src/providers/index.js`: picks the provider from `PLACES_PROVIDER` / `ROUTING_PROVIDER`.
- **Record/replay harness:** a `recording` wrapper that saves provider input and output keyed by a hash, and a `replay` provider that serves them with no network. Convert the spike's `fixtures/` into the first scenario, then record a few more (see step 6). Fixtures stay git-ignored (Google content); document how to regenerate them.
- **Contract tests:** run the same assertions against every provider implementation (and the replay provider) so a future TravelTime/Foursquare/OSM provider can be dropped in.

## 6. The calculation (built; tuning continues)

**First live result (stockwell-blackfriars-hampstead, drinks, Sat 19:30).** Google returned 118 venues over 6 searches; 49 qualified (67 were the wrong type, mostly hotels and restaurants; 2 closed; none failed the review bar, because central London places all have thousands of reviews). Top picks: Simmons Bar (Oxford Circus, 4.7 stars, 27/15/20 min), Flat Iron Square (Southwark), Gordon's Wine Bar (Covent Garden), SOUND (Marble Arch), The Blackfriar. Cost: 6 Places requests and 2 Routes requests (45 elements). The ranking within the pool looks sensible. `node scripts/explain-scenario.mjs scenarios/<file>.json` replays a recording and prints every costed venue, not just the picks.

**Known limitation, found by that run: candidates come from straight-line geometry, and London's travel times are network-shaped.** Stockwell and Hampstead are on the same Northern line, so the two transit people have a direct, quick journey to Euston (22 and 11 min), Bank (22 and 21) or Borough, none of which were searched, while the geometric centres drifted to Oxford Circus and Marble Arch (the best of which gave a 27 min longest journey vs 22 at Euston). Probe of 9 hubs for two transit people (18 elements): Euston 22/11, Bank 22/21, Oxford Circus 22/25, King's Cross 30/17, London Bridge 25/28, Waterloo 32/26. Fix options for the next iteration:
1. **Precomputed area-to-hub transit times** (best): about 25 interchange hubs (Bank, Euston, King's Cross, Liverpool Street, London Bridge, Waterloo, Victoria, Oxford Circus, Baker Street, Paddington, Stratford, Canary Wharf, Clapham Junction, Vauxhall, Angel, Old Street, Borough, Elephant & Castle, ...) x 279 areas is about 7,000 elements, one-off, then candidate generation is network-aware, free per run, instant, offline and deterministic. Cost depends on which SKU transit matrices bill under: if Essentials ($5 per 1,000, 10,000 free a month) it is free; if Enterprise it is roughly $35-105 once. **Decide after reading the SKU billing report for the spike.**
2. **Per-run hub probe:** route each distinct transit origin to the ~12 hubs that pass a straight-line pre-filter (e.g. 3 people x 12 = 36 elements, about $0.20-0.55 per run, growing with group size) and add the best 3 hubs to the candidates. No upfront cost, but every run pays.
3. Both leave the existing geometric candidates in place for cyclists, walkers and areas away from the hubs.
Either way the hubs become extra candidate areas and everything downstream (filters, shortlist, scoring, picks) is unchanged.

*Built as `src/calc/` (see README "The calculation"). Differences from the plan below: no precomputed area-to-area table (as planned); the shortlist is round-robin by review quality; the "open late" rule is open for 3+ hours and until 23:00; unknown opening hours are allowed but penalised and flagged. **Still to do for this step:** record the real scenario (`npm run scenario -- scenarios/stockwell-blackfriars-hampstead.json --live --yes`), read the suggestions for sense, and tune the weights in `src/calc/config.js` against replays. Add more scenarios (a lone far-out person, all in one area, a tight personal limit, a cyclist-only group). The original plan follows.*

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

## 7. Run it: async calculation and results (built)

*Built as described below, with these differences:* every run counts against the per-event cap of 5 (failed runs too, because they spend API calls); results are stored as JSON on `calc_runs` (`result_json`), so the `suggestions` and `travel_times` tables from 0001 are unused and reserved for voting; the daily budget is a counter in D1 (`usage_counters`, default 30 a day, `CALC_DAILY_LIMIT` to change); stale runs are reaped lazily when the event is read or a new run starts, not by a cron. **To do before this works live:** `npm run db:remote`, `npx wrangler secret put GOOGLE_MAPS_API_KEY`, deploy, then try it with two real people. **For step 8:** the stored result contains Google place details (names, addresses, ratings, hours), so the retention job must delete results within Google's caching limit (about 30 days) and the page already credits Google Maps. The original plan follows.

- `POST /api/events/:code/calculate` (owner): checks at least 2 located participants, the per-event run cap (3), a global daily budget guard (a counter in D1 that refuses runs past a limit), then creates a `calc_runs` row (`running`), snapshots the inputs, sets the event to `calculating` and does the work in `ctx.waitUntil`. Returns immediately.
- The work: step 6 → write `suggestions` and `travel_times` → `calc_runs.status = done`, event `done`. On any error: `failed` with a user-safe message and the real error logged. A stale-run reaper (a run still `running` after a few minutes is marked `failed`).
- `GET /api/events/:code` includes the latest run state and, when done, suggestions with per-person times. The client polls every few seconds.
- **Results UI:** 3-5 cards (venue name, rating, why it won, "Open in Google Maps" link), a per-person travel table with mode and minutes, a clear "X travels furthest (N min)" flag, and the cost-free "re-run" for the owner after changes. Google attribution as the terms require. A map is optional (an OpenStreetMap/Leaflet map of the venues and participants' areas).
- Check the Workers `waitUntil` time limit against a realistic run; if it is marginal, move the work to a Cloudflare Queue (needs the paid plan).

## 8. Hardening and launch (built)

*Built; see README "Security, privacy and operations" and "Launch checklist".* An independent review found, and the code now fixes: other people's limits visible on the "no results" screen; the daily budget leaking on races and no per-user daily cap; an event able to get stuck "calculating"; people who left still present in stored results; a nameless Google account showing its email as a display name; request bodies buffered before the size check; the Worker reachable on `workers_dev`; and forged key ids forcing Google key refetches. Writing the tests for the stuck-event fix also exposed a real bug (an un-awaited handler promise escaping the error handler), fixed. **Still to do by hand:** the launch checklist, in particular enforcing the CSP after a browser check. The original plan follows.

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
