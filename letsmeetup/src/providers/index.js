// Picks the places and routing providers from config (PLACES_PROVIDER / ROUTING_PROVIDER, default
// 'google'). Business logic only ever calls the interfaces in types.js; to add a provider, write a
// factory and register it here.

import { createGooglePlaces } from './places/google.js';
import { createGoogleRouting } from './routing/google.js';
import { ProviderError } from './types.js';

export const REGISTRY = {
  places: { google: createGooglePlaces },
  routing: { google: createGoogleRouting },
};

function pick(kind, name, registry) {
  const factory = registry[kind] && registry[kind][name];
  if (!factory) throw new ProviderError(`Unknown ${kind} provider "${name}"`, { provider: name });
  return factory;
}

// `fetch` is injectable so a recording or replaying fetch can be swapped in (see ./http.js).
export function createProviders(env, { fetch: fetchImpl = fetch, sleep, registry = REGISTRY } = {}) {
  const placesName = env.PLACES_PROVIDER || 'google';
  const routingName = env.ROUTING_PROVIDER || 'google';
  return {
    places: pick('places', placesName, registry)({ env, fetch: fetchImpl, sleep }),
    routing: pick('routing', routingName, registry)({ env, fetch: fetchImpl, sleep }),
  };
}
