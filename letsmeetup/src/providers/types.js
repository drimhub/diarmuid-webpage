// Provider-neutral types and interfaces. Heuristics, the database and the UI only ever see these
// shapes, never a provider's own response format (see ../../CLAUDE.md). Documentation only: this
// file has no runtime exports except the error class and constants.

/**
 * @typedef {Object} OpeningHours  Regular weekly opening hours in the venue's local (London) time.
 * @property {Array<{open: {day: number, minute: number}, close: {day: number, minute: number} | null}>} periods
 *   `day` is 0=Sunday..6=Saturday, `minute` is minutes since local midnight. `close` may be on the
 *   next day (or wrap from Saturday to Sunday). A period with `close: null` means open 24 hours.
 */

/**
 * @typedef {Object} Venue
 * @property {string} provider           e.g. 'google'
 * @property {string} providerPlaceId    stable id within that provider
 * @property {string} name
 * @property {string|null} address
 * @property {number} lat
 * @property {number} lng
 * @property {number|null} rating        0-5
 * @property {number|null} ratingCount
 * @property {number|null} priceLevel    0 (free) .. 4 (very expensive)
 * @property {string|null} primaryType   provider's main category, e.g. 'pub', 'cocktail_bar'
 * @property {string|null} mapsUrl
 * @property {OpeningHours|null} openingHours  null = unknown
 * @property {{outdoorSeating: boolean|null, servesBeer: boolean|null, servesWine: boolean|null,
 *             goodForGroups: boolean|null, reservable: boolean|null}} attributes  null = unknown
 */

/**
 * @typedef {Object} TravelTime
 * @property {'ok'|'no_route'|'error'} status
 * @property {number|null} durationS
 * @property {number|null} distanceM
 */

/**
 * @typedef {Object} Cost  What a call used, so runs can be costed and capped.
 * @property {string} provider
 * @property {number} requests
 * @property {number} [elements]  routing: matrix cells requested
 */

/**
 * Places provider.
 * findVenues({ center: {lat,lng}, radiusMeters, eventType: 'lunch'|'dinner'|'drinks', maxResults })
 *   -> { venues: Venue[], cost: Cost }
 *
 * Routing provider.
 * getTravelTimes({ origins: {lat,lng,mode: 'transit'|'bike'|'walk'}[], destinations: {lat,lng}[],
 *                  arriveBy?: ISO string, departAt?: ISO string })
 *   -> { times: TravelTime[][] /* origins x destinations *\/, cost: Cost, warnings: string[] }
 *
 * Providers split large requests themselves (e.g. transit's 100-element cap); callers always ask
 * for the whole matrix.
 */

export class ProviderError extends Error {
  constructor(message, { status, provider } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.provider = provider;
  }
}

export const EVENT_TYPES = ['lunch', 'dinner', 'drinks'];
export const TRAVEL_MODES = ['transit', 'bike', 'walk'];

export function newCost(provider) {
  return { provider, requests: 0, elements: 0 };
}

export function addCost(a, b) {
  return { provider: a.provider, requests: a.requests + b.requests, elements: (a.elements || 0) + (b.elements || 0) };
}
