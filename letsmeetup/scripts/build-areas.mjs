// Builds public/areas.json: the ~230 London neighbourhoods people snap to.
// Source: OpenStreetMap place nodes (suburb/town/neighbourhood/quarter) inside a London bounding box,
// © OpenStreetMap contributors, ODbL (credited in README and on the page).
//
// Usage (from letsmeetup/):  npm run build:areas                 fetch from Overpass (tries a few mirrors)
//                            npm run build:areas -- --from f.json  reuse a saved Overpass response
//
// The result is committed, so this only needs re-running to refresh the list. Hand edits belong in
// the EXCLUDE / INCLUDE_EXTRA / RENAME sections below, not in areas.json, so a rebuild keeps them.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'public', 'areas.json');

const BBOX = '51.28,-0.51,51.70,0.33'; // south,west,north,east
const CENTRE = { lat: 51.5074, lon: -0.1278 }; // Charing Cross
const MAX_KM_FROM_CENTRE = 27;
// Minimum gap between two kept areas by distance from the centre: dense inside, sparse outside.
const spacingKm = (d) => (d < 8 ? 1.0 : d < 15 ? 1.6 : 2.4);

const MIRRORS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// OSM names that are outside Greater London (inside the bounding box) or aren't neighbourhoods.
const EXCLUDE = new Set([
  'Potters Bar', 'Bushey', 'Watford', 'Epsom', 'Esher', 'Walton-on-Thames', 'Caterham', 'Waltham Cross',
  'Banstead', 'Warlingham', 'Sunbury-on-Thames', 'Molesey', 'Ashford', 'Dartford', 'Ashtead', 'Epping',
  'Hersham', 'Swanley', 'Littleton', 'Joydens Wood', 'Iver', 'Battlers Green', 'Otterspool',
  'Batchworth', 'Borehamwood', 'Buckhurst Hill', 'Cassiobury', 'Carpenders Park', 'Chigwell', 'Waltham Abbey',
  'Ewell', 'Long Ditton', 'Lower Ashtead', 'Lower Green Esher', 'Kingswood Warren', 'Nork', 'Whyteleafe',
  'Shepperton Green', 'Barnes Cray', 'Ashford Common', 'Brooklands', 'Church End', 'Southend', 'Southborough',
  'Meriden', 'Preston', 'Upton', 'Rosehill', "St Mary's", 'The Bridge',
  'High Firs', 'New Town', 'North Watford', 'Watford Heath', 'West Ewell', 'Loughton', 'Temple Hill', 'White Oak',
]);
const EXCLUDE_PATTERN = /\b(estate|industrial|business park|retail park|trading|garden village)\b/i;

// Well-known areas that always get a spot (matched loosely on name). Everything else is gap-filling
// from OSM suburbs and towns. Add a name here to force an area in; a missing one is reported below.
const MUST_HAVE = [
  'Soho', 'Shoreditch', 'Angel', 'Clerkenwell', "King's Cross", 'Brixton', 'Bow', 'Deptford', 'Brockley',
  'Forest Hill', 'Crystal Palace', 'Hackney Wick', 'Finsbury Park', 'Archway', 'Tufnell Park', 'Barbican',
  'Pimlico', 'Belgravia', 'Westminster', "Earl's Court", 'Fitzrovia', 'Camden Town', 'Hoxton', 'Dalston',
  'Peckham', 'Clapham', 'Bermondsey', 'Canary Wharf', 'Greenwich', 'Walthamstow',
  'Hackney', 'Haggerston', 'Kentish Town', 'Highbury', 'Holloway', 'Hampstead', 'Battersea', 'Wimbledon',
  'Putney', 'Richmond', 'Kew', 'Hammersmith', 'Chiswick', 'Ealing', 'Acton', "Shepherd's Bush", 'Notting Hill',
  'Kensington', 'Chelsea', 'Fulham', 'Stratford', 'Leyton', 'Leytonstone', 'Lewisham', 'Catford', 'New Cross',
  'Streatham', 'Tooting', 'Balham', 'Croydon', 'Bromley', 'Kingston upon Thames', 'Harrow', 'Wembley',
  'Enfield', 'Ilford', 'Romford', 'Barking', 'Woolwich', 'Elephant and Castle', 'Waterloo', 'Vauxhall',
  'Victoria', 'Marylebone', 'Mayfair', 'Bloomsbury', 'Covent Garden', 'Holborn', 'Paddington', 'Maida Vale',
  'Kilburn', "St John's Wood", 'Primrose Hill', 'Highgate', 'Muswell Hill', 'Crouch End', 'Wood Green',
  'Tottenham', 'Stoke Newington', 'Clapton', 'Bethnal Green', 'Mile End', 'Whitechapel', 'Wapping',
  'Limehouse', 'Poplar', 'Canning Town', 'Dulwich', 'East Dulwich', 'Herne Hill', 'Camberwell', 'Nunhead',
  'Sydenham', 'Blackheath', 'Charlton', 'Eltham', 'Sidcup', 'Bexleyheath', 'Islington', 'Stockwell',
  'Oval', 'Kennington', 'Southwark', 'Rotherhithe', 'Surrey Quays', 'Lambeth', 'Brent Cross', 'Golders Green',
  'Finchley', 'Cricklewood', 'Willesden', 'Wandsworth', 'Southfields', 'Earlsfield', 'Colliers Wood',
  'Morden', 'Sutton', 'Mitcham', 'Wood Green', 'Palmers Green', 'Southgate', 'Edgware', 'Stanmore',
  'Pinner', 'Uxbridge', 'Hounslow', 'Twickenham', 'Hampton', 'Teddington', 'Brentford', 'Isleworth',
  'Southall', 'Hayes', 'Orpington', 'Beckenham', 'Anerley', 'Thornton Heath',
  'Purley', 'Coulsdon', 'Sanderstead', 'Surbiton', 'New Malden', 'Barnes', 'Mortlake', 'East Sheen',
  'Roehampton', 'Bayswater', "Queen's Park", 'Swiss Cottage', 'Belsize Park',
  'Gospel Oak', 'Hendon', 'Mill Hill', 'Burnt Oak', 'Dagenham', 'Hornchurch', 'Upminster', 'Plumstead',
  'Abbey Wood', 'Erith', 'Lee', 'Grove Park', 'Hither Green', 'Honor Oak', 'Elmers End', 'West Norwood',
];
// Must-haves OSM has no suitable node for. Anchors are approximate (main station / centre).
const INCLUDE_EXTRA = [
  { name: 'London Bridge', lat: 51.5045, lon: -0.0865 },
  { name: 'Borough', lat: 51.5011, lon: -0.0943 },
  { name: 'Westbourne Park', lat: 51.5210, lon: -0.2010 },
];
const mustKey = (s) => s.normalize('NFKD').toLowerCase().replace(/[^a-z]+/g, '');
const MUST = new Map(MUST_HAVE.map((n) => [mustKey(n), n]));

// Short, familiar names people would actually type.
const RENAME = {
  'Elephant and Castle': 'Elephant & Castle',
};

const norm = (s) => s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function km(a, b) {
  const R = 6371, t = Math.PI / 180;
  const dl = (b.lat - a.lat) * t, dn = (b.lon - a.lon) * t;
  const x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

async function fetchOverpass() {
  const query = `[out:json][timeout:60];node["place"~"^(suburb|town|neighbourhood|quarter)$"]["name"](${BBOX});out body;`;
  for (const url of MIRRORS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': 'letsmeetup-build/1.0 (personal project)', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      const text = await res.text();
      if (text.trim().startsWith('{')) return JSON.parse(text);
      console.error(`  ${url}: no JSON (busy?), trying next`);
    } catch (e) {
      console.error(`  ${url}: ${e.message}, trying next`);
    }
  }
  throw new Error('All Overpass mirrors failed; retry later or pass --from <saved.json>');
}

const fromIdx = process.argv.indexOf('--from');
const data = fromIdx > -1 ? JSON.parse(readFileSync(process.argv[fromIdx + 1], 'utf8')) : await fetchOverpass();

const rank = (e) => (e.must ? 1000 : 0) + ({ town: 3, suburb: 2 }[e.tags.place] || 0) + (e.tags.wikidata ? 2 : 0) + (e.tags.population ? 1 : 0);

const all = data.elements
  .filter((e) => e.lat != null && e.tags?.name)
  .map((e) => ({ ...e, must: MUST.has(mustKey(e.tags.name)) }))
  .filter((e) => e.must || e.tags.place === 'suburb' || e.tags.place === 'town') // neighbourhood/quarter only if must-have
  .map((e) => ({ name: RENAME[e.tags.name] || e.tags.name, lat: e.lat, lon: e.lon, must: e.must, r: rank(e), d: km(CENTRE, { lat: e.lat, lon: e.lon }) }))
  .filter((e) => e.d <= MAX_KM_FROM_CENTRE && !EXCLUDE.has(e.name) && !EXCLUDE_PATTERN.test(e.name))
  .sort((a, b) => b.r - a.r || a.d - b.d);

for (const x of INCLUDE_EXTRA) if (!all.some((c) => c.name === x.name)) all.unshift({ ...x, must: true, r: 1000, d: km(CENTRE, x) });
const found = new Set(all.filter((c) => c.must).map((c) => mustKey(c.name)));
const missing = MUST_HAVE.filter((n) => !found.has(mustKey(n)) && !found.has(mustKey(RENAME[n] || n)));
if (missing.length) console.log('Must-have areas NOT found in OSM data (add manually or fix the name):', missing.join(', '));

const candidates = all;
const MUST_GAP_KM = 0.45; // must-haves may sit close together (Soho / Covent Garden / Fitzrovia)
const kept = [];
const seenNames = new Set();
for (const c of candidates) {
  if (seenNames.has(c.name)) continue;
  const gap = c.must ? MUST_GAP_KM : spacingKm(c.d);
  const clash = kept.some((k) => km(k, c) < (c.must ? MUST_GAP_KM : Math.max(gap, k.must ? spacingKm(k.d) * 0.7 : spacingKm(k.d))));
  if (clash) continue;
  seenNames.add(c.name);
  kept.push(c);
}

kept.sort((a, b) => a.name.localeCompare(b.name));
const ids = new Set();
const areas = kept.map((k) => {
  let id = norm(k.name);
  for (let i = 2; ids.has(id); i++) id = `${norm(k.name)}-${i}`;
  ids.add(id);
  return { id, name: k.name, lat: +k.lat.toFixed(4), lng: +k.lon.toFixed(4) };
});

writeFileSync(OUT, JSON.stringify(areas, null, 1) + '\n');
console.log(`${candidates.length} candidates -> ${areas.length} areas written to public/areas.json`);
