// Every tunable number in the calculation lives here, so weights can be tuned in one place against
// recorded scenarios without touching logic. Pass overrides to computeSuggestions({ config }).

export const HEURISTICS_VERSION = '1';

export const DEFAULTS = {
  // How many suggestions to return.
  minSuggestions: 3,
  maxSuggestions: 5,

  // --- Candidate areas -------------------------------------------------------------------------
  nearestAreasPerPoint: 3,    // snap each computed centre to this many nearest area anchors
  maxCandidates: 6,           // areas searched for venues (cost: one Places request each)
  candidateSpacingKm: 0.6,    // candidate anchors closer than this to a better one are dropped
  candidateLimitSlack: 1.4,   // drop a candidate if the straight-line estimate exceeds someone's limit by this factor

  // Straight-line travel estimates used only to prune candidates (the real times come from routing).
  estimate: {
    speedKmh: { transit: 15, bike: 13, walk: 4.8 },
    transitWaitMinutes: 5,
    detour: 1.3,
  },

  // --- Venues ----------------------------------------------------------------------------------
  radiusStepsMeters: [500, 900], // search radius; widened once if too few venues qualify
  maxResultsPerSearch: 20,
  minVenues: 3,                  // below this many qualifying venues, filters relax (and a note is added)
  maxShortlist: 15,              // venues sent to the routing matrix (cost scales with people x venues)
  quality: { minRating: 3.9, minRatingCount: 50 },
  relaxedQuality: { minRating: 3.5, minRatingCount: 20 },
  openLate: { minMinutesAfterStart: 180, minCloseMinuteOfDay: 23 * 60 },
  largeGroupSize: 6,             // from this many people, prefer places good for groups / reservable

  // --- Journeys --------------------------------------------------------------------------------
  maxJourneyMinutes: { transit: 120, bike: 75, walk: 45 }, // hard caps, whatever people ask for

  // --- Scoring (all in "minutes"; lower is better) --------------------------------------------
  weights: { mean: 1.0, max: 0.7, spread: 0.3 },
  quality_bonus: { minutesPerStar: 6, baselineRating: 4.0, fullTrustReviews: 500 },
  bonuses: { outdoorSeating: 2, goodForGroups: 3, reservable: 1 }, // minutes-equivalent
  penalties: { unknownHours: 4, tagUnmet: 3 },

  // --- Picking ---------------------------------------------------------------------------------
  minPickSeparationMeters: 150,
};

// Deep-merges plain objects so callers can override one nested number.
export function withOverrides(base, overrides) {
  if (!overrides) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? withOverrides(base[k], v) : v;
  }
  return out;
}
