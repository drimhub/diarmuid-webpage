# CLAUDE.md (letsmeetup/)

Applies to everything under `letsmeetup/`, on top of the root [CLAUDE.md](../CLAUDE.md). This is a separate Cloudflare Worker (static assets + API + D1) served at **letsmeetup.diarmu.id**, not part of the Pages site. See [README.md](README.md) for setup.

## What it is

Groups of friends in London sign in with Google, say roughly where they are travelling from (and whether they cycle), and the owner triggers a calculation that suggests 3-5 venues that are a fair compromise, with a travel-time summary (who travels furthest, etc). London only.

## Decisions (don't re-litigate without asking)

- **Google for v1, built to be swapped.** Google Places (venues) and Google Routes (travel-time matrix) are the v1 providers. Everything must be written so a different provider (TravelTime, Foursquare, OSM/Overture, TfL, ...) can replace either one without touching heuristics, schema or UI:
  - Provider code lives only in `src/providers/places/<name>.js` and `src/providers/routing/<name>.js`. Nothing else imports Google code or mentions Google field names or response shapes.
  - Providers implement small interfaces and return **normalised** types defined in `src/providers/types.js`: `findVenues(area, filters) -> Venue[]` and `getTravelTimes(origins, destinations, departAt) -> TravelTime[][]`. Heuristics only see these types.
  - The provider is chosen by config (`PLACES_PROVIDER`, `ROUTING_PROVIDER`, default `google`), not by `if (google)` in business logic.
  - The DB stores `provider` + `provider_place_id` rather than Google-specific columns. Store only what the provider's terms allow (for Google: `place_id` long term, other content only briefly and with attribution; check the terms before caching more).
  - Provider limits (e.g. 100 elements per transit matrix request) are handled inside the provider, which batches. Callers just ask for the whole matrix.
  - Considered and deferred: TfL API (one call per pair, so it hits Workers subrequest limits on the free plan), TravelTime (free tier is non-commercial; isochrone intersection is attractive), Foursquare, OSM/Overture for free candidate generation.
- **Locations are snapped to a London neighbourhood on the device.** The browser maps the user's input to one of ~150-250 areas in `public/areas.json` and sends **only `area_id`**. The server looks up the anchor coordinates from its own copy and ignores any coordinates the client sends. Exact coordinates are never stored or logged. Other participants see the area name only.
- **Own subdomain, host-only cookie.** The session cookie has no `Domain` attribute, so it is never sent to diarmu.id (agent-built pages and bookclub can't use it). Sessions are random tokens stored hashed in D1 (revocable). Non-GET API calls require the `X-Requested-With: letsmeetup` header and a matching `Origin`.
- **Auth is Google Sign-In** (ID token verified server-side against Google's JWKS). No Firebase/Firestore here.
- **Events have a start time** (`start_at`, UTC; shown as Europe/London). Transit times and "open at event time"/"open late" need it.
- Event types: `lunch`, `dinner`, `drinks`. Tags are validated in code (not a table), e.g. `outdoor_seating`, `open_late`.
- Calculation runs asynchronously (`ctx.waitUntil`), state lives in `calc_runs` in D1, and the client polls. Move to a Queue only if needed.

## Rules

- **Heuristics are the bulk of the work.** Keep them pure functions over normalised types so they can run offline. Build and use the fixture recorder / replay harness (record real provider responses, replay them) before tuning weights; don't tune against live paid APIs.
- **Cost control.** Use minimal field masks (Places is billed at the highest tier of any requested field, per request, not per place). Shortlist candidates before the routing matrix (billed per element). Keep hard daily quotas and a billing alert on the Google project. Cap participants (12), runs per event (3), events per user per day.
- **API keys.** Server key is a Worker secret. Don't put a Google Maps key in the browser unless a feature really needs it (snapping and area search don't).
- **London only.** Validate on the server, not just in the UI.
- Escape all user-supplied text (`escapeHtml`) before `innerHTML`/attributes; prefer `textContent`. This includes event titles, names and place names, and anything in OG tags.
- No new Firestore collections, no localStorage for anything that matters (a remembered UI preference is fine).
- Update `README.md` (this folder's and the root one, which has a short pointer) in the same change as anything that affects setup, structure, schema or config. Schema changes are new numbered files in `migrations/`, never edits to applied ones.
- Don't touch `tools/` or `node_modules/`.

## Security rules (learned the hard way; tests enforce several of these)

- Inside a `try`, always `await` a promise before returning it, or the `catch` (and its structured log line) never runs.
- Anything that can cost money or create data is rate limited (`src/ratelimit.js`) and capped. Order the steps of such an operation so that every failure can be undone, including refunding the day's budget; a state like `calculating` must never exist without the run that justifies it.
- What the privacy page (`public/privacy.html`) says must stay true of the code; `test/hardening.test.mjs` checks the retention numbers and key claims. Change both together.
- Never return another person's longest-journey limit, email, or any coordinate. Names are first names only, never derived from an email.
- Rendering: text via `textContent`/text nodes only, links only plain Google Maps URLs (`public/view.js`, tested with hostile input). No inline scripts or handlers (the CSP relies on it).
- When a person leaves, is removed or deletes their account, stored results that mention them are erased (`clearStoredResults`, `account.js`).
- Stored Google place details are erased 30 days after the run (`retention.js`).
