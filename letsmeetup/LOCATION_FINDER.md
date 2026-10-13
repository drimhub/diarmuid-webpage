# Location finder: how the heuristic works today

Summary of `src/calc/` as it currently stands. Every tunable number is in `src/calc/config.js` (`HEURISTICS_VERSION = '2'`). The code is pure over normalised types: it never imports Google, and providers are passed in.

## Pipeline (`src/calc/index.js`, `computeSuggestions`)

```
snapped areas -> candidate areas (free) -> venue search (Places) -> filters -> shortlist
              -> travel times (Routes, one matrix call) -> limits + scoring -> diverse picks + labels
```

### 0. Inputs and location snapping

- Each participant sends only an `area_id` (the browser snaps their postcode/GPS/typed name to one of the ~150-250 anchors in `public/areas.json`; `public/snap.js`, max 4 km from an anchor, inside the London box). The server looks up the anchor's coordinates itself.
- So the algorithm works on **anchor points**, not exact addresses. Each participant has a mode (`transit`, `bike`, `walk`) and an optional personal max journey time.
- Participants without a valid area are excluded. Fewer than 2 located people gives `not_enough_people`.

### 1. Candidate areas (`candidates.js`, `network.js`, `geo.js`) - no API cost

**Network candidates (when there are transit travellers and `src/data/transit-times.json` is built).** Every area is scored by table time for the transit people (`scale x table minutes + offset`, offset 8 provisional; walk-only pairs use the walking estimate; unreachable pairs exclude the area; bike and walk people use the straight-line estimate below), with the same mean / longest / spread weights and personal-limit pruning. The best 4, spaced 600 m apart, take the first slots and are tagged `network`. Without the table they are skipped and the rest runs as before.

**Geometric candidates.** Five "centres" are computed from the participants' anchor points:

| Centre | Minimises |
|---|---|
| `centroid` | the plain average position |
| `median` | total straight-line distance (Weiszfeld geometric median) |
| `minimax` | the longest straight-line trip (Badoiu-Clarkson) |
| `median_time` | the same as median, weighted by 1/speed per mode |
| `minimax_time` | the same as minimax, weighted by 1/speed per mode |

Then:

1. Each centre snaps to its **3 nearest area anchors** (`nearestAreasPerPoint`). Anchors proposed by several centres are merged, and the proposing heuristics are remembered.
2. Each anchor gets a **straight-line travel estimate** per person: haversine x 1.3 detour / mode speed (transit 15, bike 13, walk 4.8 km/h), plus 5 min transit wait. That gives mean, max and spread, scored as `1.0*mean + 0.7*max + 0.3*spread`.
3. Anchors that someone couldn't reach within their own limit (x1.4 slack, since it is only an estimate) are dropped. If that would drop everything, nothing is pruned.
4. Geometry fills the remaining slots up to **6** (`maxCandidates`) in total, best first, skipping any within **0.6 km** of one already kept. An area proposed by both keeps both tags.

### 2. Venue search and filtering (`venues.js`)

- One Places search per candidate (radius **500 m**, up to 20 results). If fewer than **3** venues qualify, it repeats once at **900 m**. Results are de-duplicated by place id.
- Hard filters: the type must suit the event (drinks: pub/bar types; lunch: restaurants, cafes, bakeries etc.; dinner: restaurants, bistros, steakhouses etc.), the venue must not be closed at the start time (never relaxed), and quality must be at least 3.9 stars with 50 or more ratings. Tags filter strictly at first: `outdoor_seating`, and `open_late` (open 3+ hours after start and still open at 23:00 or later).
- **Relaxation** if fewer than 3 venues survive: level 1 turns the tag filters into preferences (with a note); level 2 also lowers quality to 3.5 stars / 20 ratings (with a note).
- No venues found gives `no_results` (`no_venues_found`). Venues found but all rejected gives `no_venues_matched`.

### 3. Shortlist

Each surviving venue is assigned to its **nearest candidate area**. The shortlist is built **round-robin across candidate areas**, best `rating x log10(ratingCount + 10)` first within each, up to **15** venues. This stops one busy area crowding out the rest and caps the routing cost (people x venues).

### 4. Real travel times

One routing matrix call (everyone x every shortlisted venue, arriving by the event start time) gives actual door-to-door durations. This is the only point where real journey times enter.

### 5. Limits and scoring (`score.js`)

- A venue where any journey is unavailable is discarded. A venue where anyone exceeds `min(their personal max, mode cap)` is moved to "over limit". Mode caps: transit 120, bike 75, walk 45 min.
- Score for the rest, **in minutes, lower is better**:

  `score = travel - quality - bonuses + unknownHoursPenalty`

  - `travel = 1.0*mean + 0.7*max + 0.3*spread` (mean, longest and spread of the real journey times).
  - `quality = (rating - 4.0) * 6 * min(1, ratingCount/500)`. Many reviews count for more, and a rating under 4.0 costs minutes.
  - `bonuses`: when requested, `outdoor_seating` is +2 (or -3 if unmet) and `open_late` is -3 if unmet. For groups of 6 or more: good for groups +3, reservable +1.
  - `unknownHoursPenalty` is +4 when opening hours are missing.

### 6. Picking and labelling (`select.js`)

- `pickDiverse`: take the best-scoring venue from **each candidate area** first (up to 5), skipping any within 150 m of one already picked. If that gives fewer than 3, top up with the best remaining. Output is sorted by score.
- `labelPicks` awards "Quickest overall" (lowest mean), "Fairest" (lowest spread), "Shortest longest journey" (lowest max) and "Best rated". A label is only given if it distinguishes the picks.
- If nothing is feasible, the result is `no_results` with `no_venue_within_limits`, which includes the 3 closest misses and who exceeded what. The other reason is `journeys_unavailable`.

## Output

Plain JSON: status, suggestions (rank, venue, area, score and breakdown, reasons, labels, per-person travel, `sourceHeuristics`), candidates considered, rejection counts, notes, and the Places/Routes request cost.

## Known limitation

The network table is built but not yet validated against Google (offset provisional), see [NETWORK-CANDIDATES.md](NETWORK-CANDIDATES.md). It is only a ranker of areas to search. Geometry alone (the fallback when there are no transit travellers or the table is stale) misses network-shaped shortcuts: two people on the same tube line are better served by an interchange on that line than by the geometric centre.
