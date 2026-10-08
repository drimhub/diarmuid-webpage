# Network-aware candidate areas: design

Status: **designed, not built.** This expands the "known limitation" in [ROADMAP.md](ROADMAP.md) step 6. Rules and decisions for the project are in [CLAUDE.md](CLAUDE.md).

## 1. The problem, with evidence

The calculation decides *where to look for venues* from straight-line geometry (centroid, median, minimax, and time-weighted versions). London's travel times follow the rail network, not the map, so the geometry can steer the search away from the places that are actually quickest for everyone.

The first live scenario (Stockwell and Hampstead by transit, Blackfriars by bike, drinks, Saturday 19:30) searched Oxford Circus, Marble Arch, Covent Garden, Farringdon, Blackfriars and Southwark. A probe of two transit people to nine hubs (Google Routes, 18 elements, arriving 19:30) showed the better options were never searched:

| Hub | Stockwell | Hampstead | Longest |
|---|---|---|---|
| **Euston** | 22 | 11 | **22** |
| **Bank** | 22 | 21 | **22** |
| Oxford Circus (best geometric candidate) | 22 | 25 | 25 (venue-level best was 26.6) |
| Borough | 22 | 27 | 27 |
| London Bridge | 25 | 28 | 28 |
| King's Cross | 30 | 17 | 30 |
| Waterloo | 32 | 26 | 32 |

Stockwell and Hampstead are on the same Northern line, so Euston (average 16.5 min) and Bank are much better than where the geometry pointed. Geometry cannot know that, and no weights tuning fixes it, because the right area is never in the candidate list.

## 2. What we are and are not trying to do

- **Goal:** put the genuinely quick-for-everyone areas into the candidate list, at **no extra per-run cost**.
- **Principle:** whatever supplies network knowledge is only a *ranker* of areas to search. The numbers users see (and the final choice between venues) always come from the live routing call for the real arrival time. A mediocre ranker costs a missed opportunity, never a wrong answer shown to anyone.
- **Not in scope:** showing these estimates to users, step-free or accessibility routing, bus-only trips, anything outside Greater London.

## 3. What was tested on 8 October 2026

TfL's open journey planner (`api.tfl.gov.uk/Journey/JourneyResults/{lat,lon}/to/{lat,lon}`) answered **without an API key**, in 1-2 seconds per call, returning up to three journeys with legs, durations and live disruptions (it even reported a live Northern line signal failure). That makes a one-off *offline* build of an area-to-area table free, which changes the options: the earlier objection to TfL (one request per pair, which hits Worker subrequest limits) does not apply to a script run on a laptop.

Its numbers are not Google's, though. Tuesday 13 October, 19:00 departing, same neighbourhood anchors:

| From, to | TfL (min) | Google (min) | TfL minus Google |
|---|---|---|---|
| Stockwell, Euston | 27 | 22 | +5 |
| Hampstead, Euston | 28 | 11 | **+17** |
| Stockwell, Bank | 27 | 22 | +5 |
| Hampstead, Bank | 34 | 21 | **+13** |
| Stockwell, Oxford Circus | 25 | 22 | +3 |
| Hampstead, Oxford Circus | 34 | 25 | +9 |

The Hampstead to Euston journey is `walk 9 + Northern line 10 + walk 9`: the ride matches Google's total, but TfL adds about 18 minutes of walking at the ends (for the same pair Saturday gave 27, so it is not the date). Cause not yet understood; likely how the planner snaps a coordinate to a stop. Two consequences:

1. TfL is **systematically slower and noisier than Google**, so it cannot be treated as the truth. It might still **rank** hubs correctly (on these six pairs both agree Euston is best for the pair; they disagree on Bank vs Oxford Circus), which is all we need, but that has to be measured, not assumed (section 6).
2. Anchor quality matters. Neighbourhood anchors are not stations, and both providers include the walk from the anchor.

## 4. Options

| | A. Google table, hubs only | B. Probe hubs on every run | C. TfL table, all areas | D. Add major hubs as candidates, no data |
|---|---|---|---|---|
| What | Precompute Google transit times, every area to ~45 hubs | At run time, route each person to ~12 plausible hubs, then search the best | Precompute TfL times for every area pair (282 x 282) | Always include the best-connected interchanges inside the group's area |
| Candidate pool | ~45 hubs | ~12 hubs | **all 282 areas** | ~10 hubs |
| Cost | ~12,700 elements once: **free** if transit matrices are Essentials tier (10,000 free a month, so split over two months), roughly **$65-190** if Enterprise | 3 people x 12 = 36 elements per run (about $0.20-0.55), growing with group size (12 people: about $2) | **$0** (takes about 1.5-2.5 hours of machine time) | $0 data, but +$0.04 per extra Places search per run |
| Per-run cost | $0 | yes | $0 | small |
| Same source as the final times | yes | yes | **no** (needs validation) | n/a |
| Knows who shares a line | yes (for hubs) | yes | yes | **no**, only a prior |
| Effort / moving parts | script + table | second routing stage, more latency | script + table + validation | tiny |
| Main risk | cost depends on an unknown SKU | cost grows; extra latency in the background run | TfL numbers differ from Google's | misses the case that triggered this |

Rejected: building our own rail graph from TfL line data (a lot of work to reproduce what the planner already does, and wrong in every edge case).

**Recommendation: C, validated, with A as the fallback and the same table format for both.** C is free, covers every neighbourhood (not just a hub list, so "Camden Town to Angel" style meeting points are considered too), adds nothing to per-run cost, and keeps the runtime code identical whichever source built the table. Because TfL's numbers are not Google's, the build is gated by an acceptance test (section 6) that compares its rankings with real Google results. If it fails, build the table from Google for hubs only (A) behind the same file format. D is a reasonable stop-gap but would not have found the case that motivated this, so it is not recommended on its own.

## 5. Design

### 5.1 The table

A generated file, `src/data/transit-times.json`, bundled into the Worker (not served to browsers):

```json
{
  "format": 1,
  "source": "tfl",
  "basis": "Tuesday 19:00 departing, scheduled",
  "builtAt": "2026-10-..",
  "anchorsHash": "<sha256 of every area id + lat + lng>",
  "areas": ["abbey-wood", "acton", "..."],
  "minutes": "<base64 of an n x n uint8 matrix, row = from, column = to>",
  "attribution": "Contains TfL Open Data. Powered by TfL Open Data."
}
```

- Whole minutes, capped at 254; 255 means no journey.
- 282 x 282 = about 80 KB raw, about 106 KB as base64 (a few KB gzipped). The Worker bundle is 102 KB today, comfortably inside Cloudflare's limits.
- Computed for one direction per pair and mirrored (journeys are close to symmetrical, and it halves the calls: 39,000 instead of 78,000).
- `anchorsHash` ties the table to the exact `areas.json` (ids and coordinates). A test fails if `areas.json` changes without a rebuild; the loader refuses a stale table and the calculation silently falls back to today's geometry (never an error).

### 5.2 The build script

`scripts/build-transit-table.mjs --source tfl|google [--sample N] [--resume] [--concurrency N] [--dry]`

- `--dry` prints the number of pairs, the estimated time and (for Google) the estimated cost, and does nothing.
- `--sample N` builds only N random pairs and compares them with the previous table or with Google, as a smoke test.
- **Resumable and incremental.** Every answer is appended to a cache (`fixtures/transit-cache.jsonl`, git-ignored) keyed by the two anchors' coordinates and the time basis. Re-running skips what is cached, so an interruption, or moving an anchor, only recomputes the affected rows and columns.
- **Polite.** Concurrency of about 6, never above about 8 requests a second, honours `Retry-After` on 429, retries with backoff, prints progress and an ETA. A TfL app key (free, from the TfL API portal) raises the allowed rate to about 500 requests a minute; without one it still works but is slower.
- TfL query: `date=<a clean Tuesday>&time=1900&timeIs=Departing&journeyPreference=LeastTime`, taking the **shortest duration among the returned journeys**; no journey means unreachable.
- Estimated run: 39,000 calls at about 5 a second is about 2 hours (about 80 minutes with a key). One-off; rebuilt only when `areas.json` changes or the rail network does (about yearly).
- The `google` source reuses the existing `getTravelTimes` provider (so the same code path, caps and batching as the live routing), restricted to a hub list.

The **hub list** for source `google` (all already neighbourhoods in `areas.json`): Bank, Liverpool Street, King's Cross, Euston, London Bridge, Waterloo, Victoria, Oxford Circus, Paddington, Stratford, Canary Wharf, Clapham Junction, Vauxhall, Angel, Old Street, Borough, Elephant & Castle, Farringdon, Blackfriars, Tower Hill, Aldgate, Westminster, Holborn, Covent Garden, Soho, Marble Arch, Camden Town, Finsbury Park, Whitechapel, Shoreditch, Hammersmith, Shepherd's Bush, Earl's Court, South Kensington, Brixton, Stockwell, Kennington, Highbury, Kentish Town, Marylebone, Fitzrovia, Bayswater, Hackney, Peckham, Lewisham, Greenwich, Tottenham, Wood Green, Walthamstow, Ealing, Richmond, Wimbledon, Croydon, Putney, Battersea, Islington, Bethnal Green, Mile End, Stoke Newington, Dalston (60; trim to the best 45 by connectivity if cost matters). Baker Street is not a neighbourhood in the list and would be added.

### 5.3 Runtime

- `src/calc/network.js`: `loadTransitTable()` (decode once, cache in the isolate), `transitMinutes(fromId, toId)`, `isUsable(areas)` (hash matches and every area is covered). No Google or TfL code here: it only reads the file, so the source can change freely.
- `generateCandidateAreas` gains a second source of candidates:
  1. For every area `c` (all 282, a trivial amount of work), each **transit** participant's time is `scale x T[their area][c]`; each **bike or walk** participant uses the existing straight-line estimate (the table says nothing about them). `scale` (config `network.scale`, default 1) is fitted by the validation so TfL minutes land near Google's.
  2. Score `c` with the same mean, longest and spread weights and the same personal-limit pruning (with its slack) as today.
  3. Take the best `network.candidates` (4) with the existing 600 m spacing, tagged `network` in `heuristics`.
  4. Fill the remaining slots (`maxCandidates` stays 6) with the existing geometric candidates, de-duplicated. A group with **no** transit participants gets only geometric candidates, exactly as today.
- Everything downstream (venue search, filters, shortlist, one routing call, limits, scoring, picks) is unchanged, and **per-run cost is unchanged**: still about 6 Places searches and 1-3 Routes requests.
- Config keys (all in `src/calc/config.js`, overridable per call): `network.enabled`, `network.candidates`, `network.scale`, `network.slack`.
- The result's `candidates` already lists each candidate's heuristics, so "network" shows in the debug output and in `explain-scenario`.

## 6. Validation: how we decide, and keep deciding, that it is good enough

The table is a ranker, so the test is whether it ranks like Google does. This needs a small amount of real Google data once, then is free and offline forever.

1. **Ground truth** (`scripts/build-ground-truth.mjs`): 12 origin neighbourhoods chosen to span zones 1-4 and different lines, times the 45-60 hubs, by Google Routes transit, arriving 19:30 on a weekday. About 12 x 60 = 720 elements, roughly **$3.60-10.80, free within the monthly allowance if transit is Essentials**. Saved to `fixtures/` (git-ignored: it is Google content).
2. **Offline evaluation** (`scripts/evaluate-table.mjs`, free): form every 2-person and 3-person group from those 12 origins (66 + 220 = 286 groups). For each, rank the hubs with the table and with the ground truth using the project's scoring weights, and report:
   - **recall@4**: how often the truly best hub is in the table's top 4. **Acceptance: at least 90%.**
   - **regret**: how much worse (in score minutes) the best of the table's top 4 is than the truth's best. **Acceptance: median at most 2 minutes, 95th percentile at most 6.**
   - **per-origin rank correlation** (Spearman) of table against truth: **at least 0.8**.
   - the same numbers for today's **geometry-only** candidates, as the baseline the change has to beat clearly.
3. **Calibration:** fit `network.scale` (and, if justified, an offset) by least squares on the ground truth, then re-run step 2. If TfL still fails, build from Google (option A) with the same evaluation.
4. **Regression guard:** the evaluation numbers go in the table's header comment and in the README; whenever the table or the weights change they are re-run, and a fresh Google ground truth is cheap enough to repeat each time the network changes.

## 7. Tests

Always run (no network or fixtures needed):
- Table encode and decode round-trips; symmetry and the 255 sentinel; capping at 254.
- **A toy city where straight lines mislead:** two people far apart in a straight line with a fast direct line between them and a river or gap that makes the geometric midpoint slow. The geometric heuristics miss the quick interchange; the network candidate finds it.
- A group with no transit users gets zero network candidates; a mixed group (transit and bike) combines table and estimate; personal limits prune.
- Stale table (hash mismatch, missing area) falls back to geometry and the run still succeeds; a corrupt file does too.
- `areas.json` changed without a rebuild fails a test that names the areas out of date.
- The Worker bundle stays under a stated size.
- Full pipeline on the fakes with a synthetic table: candidates include `network` ones; per-run provider calls are unchanged (same Places and Routes counts).

When fixtures exist (skipped on a fresh clone, like the spike tests):
- The validation metrics above as assertions with the acceptance thresholds.
- The Stockwell, Blackfriars, Hampstead scenario re-recorded: the candidate list now includes Euston or Bank, and the best suggestion's longest journey is no worse than before.

## 8. Phases

| Phase | What | Effort | Cost |
|---|---|---|---|
| 0. Validation spike | `build-ground-truth` and `evaluate-table` against a small TfL sample; decide TfL vs Google | one session, about 30-60 min of machine time | $0 to about $11 (likely free) |
| 1. Build the table | `build-transit-table` with the chosen source; commit `transit-times.json` | about 2 hours unattended (TfL) | $0 (TfL) |
| 2. Runtime and tests | `network.js`, candidate integration, config, tests | one session | $0 |
| 3. Re-record and compare | re-run the live scenario; read the new suggestions with the old | minutes | about $0.60 |
| 4. Docs and credit | README, privacy note (no new personal data: it is an offline table), footer credit "Contains TfL Open Data" with the OGL licence link | small | $0 |

## 9. Risks and what covers them

- **TfL numbers differ from Google's** (measured above): the acceptance test, calibration, and the Google fallback. The ranker never sets what users see.
- **Walking legs inflate TfL times, unexplained for Hampstead:** investigate during phase 0 (sample which stop the planner chooses for a few anchors); if anchors are the cause, move or re-snap the anchors that matter (the areas map is the tool), which benefits Google times too.
- **Time basis:** a table built for Tuesday 19:00 is wrong on a Saturday with engineering works. It is only used to choose where to look, and the live call checks the real arrival time. If validation shows weekends rank differently, add a weekend table (the format already carries `basis`).
- **Rate limits or terms:** use an app key, stay polite, resume on failure. The data is under the Open Government Licence and needs the credit above. If TfL ever stops answering, the file in the repo keeps working until the network changes.
- **Anchors move or areas are added:** the hash makes this a loud test failure and the incremental build repairs it in minutes.
- **A network change (new line, closures):** rebuild about yearly, or after a big change; the file records when it was built.
- **Bundle growth:** about 106 KB, fine; if areas ever grow tenfold, store only the triangle or compress.

## 10. Decisions needed from you

1. **Go with C (TfL, validated) as the primary route**, falling back to Google hubs only if validation fails? (Recommended. It does not depend on the billing report.)
2. **TfL app key:** optional but faster; register at the TfL API portal and tell me when I can use it (put it in `.dev.vars` as `TFL_APP_KEY`). Without it the build is slower but works.
3. **OK to spend up to about $11 once** (probably $0 within Google's free allowance) on the Google ground truth for validation?
4. **Time basis:** is a weekday evening table enough to start, with a weekend one only if validation says it matters?
5. **Credit:** a "Contains TfL Open Data" line in the footer is required by the licence; fine?
