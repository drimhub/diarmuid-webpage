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
  'Peckham', 'Bermondsey', 'Canary Wharf', 'Greenwich', 'Walthamstow',
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
// Must-haves OSM has no suitable node for, and gap-fillers for zones 1-3 where people think in
// station names (Blackfriars, Bank, ...). Anchors are approximate (the station / centre).
const INCLUDE_EXTRA = [
  // Original gaps
  { name: 'London Bridge', lat: 51.5045, lon: -0.0865 },
  { name: 'Borough', lat: 51.5011, lon: -0.0943 },
  { name: 'Westbourne Park', lat: 51.5210, lon: -0.2010 },
  // City and central stations
  { name: 'Blackfriars', lat: 51.5117, lon: -0.1031 },
  { name: 'Bank', lat: 51.5133, lon: -0.0886 },
  { name: 'Liverpool Street', lat: 51.5178, lon: -0.0823 },
  { name: 'Aldgate', lat: 51.5143, lon: -0.0755 },
  { name: 'Tower Hill', lat: 51.5098, lon: -0.0766 },
  { name: 'Farringdon', lat: 51.5203, lon: -0.1053 },
  { name: 'Old Street', lat: 51.5263, lon: -0.0873 },
  { name: 'Euston', lat: 51.5282, lon: -0.1337 },
  { name: 'Oxford Circus', lat: 51.5152, lon: -0.1415 },
  { name: 'Marble Arch', lat: 51.5136, lon: -0.1586 },
  { name: 'Sloane Square', lat: 51.4924, lon: -0.1565 },
  { name: 'South Kensington', lat: 51.4941, lon: -0.1738 },
  // West and south-west (zones 2-3)
  { name: 'Holland Park', lat: 51.5075, lon: -0.2060 },
  { name: 'Ladbroke Grove', lat: 51.5172, lon: -0.2107 },
  { name: 'White City', lat: 51.5120, lon: -0.2240 },
  { name: 'East Acton', lat: 51.5170, lon: -0.2470 },
  { name: 'Kensal Green', lat: 51.5307, lon: -0.2250 },
  { name: 'Willesden Junction', lat: 51.5322, lon: -0.2438 },
  { name: 'Ravenscourt Park', lat: 51.4942, lon: -0.2359 },
  { name: 'Barons Court', lat: 51.4905, lon: -0.2139 },
  { name: 'West Brompton', lat: 51.4872, lon: -0.1953 },
  { name: 'Fulham Broadway', lat: 51.4802, lon: -0.1950 },
  { name: 'Parsons Green', lat: 51.4753, lon: -0.2011 },
  { name: 'Clapham Junction', lat: 51.4642, lon: -0.1704 },
  { name: 'Wandsworth Common', lat: 51.4560, lon: -0.1670 },
  { name: 'Clapham Common', lat: 51.4618, lon: -0.1384 },
  { name: 'Battersea Park', lat: 51.4776, lon: -0.1479 },
  { name: 'Nine Elms', lat: 51.4800, lon: -0.1300 },
  { name: 'Loughborough Junction', lat: 51.4659, lon: -0.1021 },
  { name: 'Tooting Bec', lat: 51.4357, lon: -0.1597 },
  { name: 'Streatham Common', lat: 51.4180, lon: -0.1360 },
  { name: 'Gipsy Hill', lat: 51.4310, lon: -0.0850 },
  // North and east (zones 2-3)
  { name: 'Finchley Road', lat: 51.5472, lon: -0.1803 },
  { name: 'Caledonian Road', lat: 51.5481, lon: -0.1188 },
  { name: 'Canonbury', lat: 51.5485, lon: -0.0920 },
  { name: 'De Beauvoir', lat: 51.5385, lon: -0.0800 },
  { name: 'Manor House', lat: 51.5712, lon: -0.0958 },
  { name: 'Seven Sisters', lat: 51.5832, lon: -0.0749 },
  { name: 'Victoria Park', lat: 51.5362, lon: -0.0381 },
  { name: 'West Ham', lat: 51.5287, lon: 0.0050 },
  { name: 'Isle of Dogs', lat: 51.4950, lon: -0.0200 },
  { name: 'Canada Water', lat: 51.4982, lon: -0.0502 },
  { name: 'Lea Bridge', lat: 51.5650, lon: -0.0370 },
  { name: 'Tottenham Hale', lat: 51.5882, lon: -0.0594 },
  { name: 'Putney Bridge', lat: 51.4682, lon: -0.2089 },
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

// Curated entries win over any same-named OSM node, so the anchor is the one listed above.
for (const x of INCLUDE_EXTRA) {
  for (let i = all.length - 1; i >= 0; i--) if (all[i].name === x.name) all.splice(i, 1);
  all.unshift({ ...x, must: true, r: 1000, d: km(CENTRE, x) });
}
const found = new Set(all.filter((c) => c.must).map((c) => mustKey(c.name)));
const missing = MUST_HAVE.filter((n) => !found.has(mustKey(n)) && !found.has(mustKey(RENAME[n] || n)));
if (missing.length) console.log('Must-have areas NOT found in OSM data (add manually or fix the name):', missing.join(', '));

const candidates = all;
const MUST_GAP_KM = 0.2; // must-haves may sit close together (Soho / Covent Garden / Fitzrovia; Notting Hill / Holland Park)
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

const keptKeys = new Set(kept.map((k) => mustKey(k.name)));
const droppedMust = MUST_HAVE.filter((n) => !keptKeys.has(mustKey(RENAME[n] || n)) && !keptKeys.has(mustKey(n)) && found.has(mustKey(n)));
if (droppedMust.length) console.log('MUST_HAVE dropped by the spacing rule (move or merge them):', droppedMust.join(', '));
const droppedExtras = INCLUDE_EXTRA.filter((x) => !kept.some((k) => k.name === x.name)).map((x) => x.name);
if (droppedExtras.length) console.log('INCLUDE_EXTRA dropped (too close to another must-have):', droppedExtras.join(', '));

kept.sort((a, b) => a.name.localeCompare(b.name));
const ids = new Set();
const areas = kept.map((k) => {
  let id = norm(k.name);
  for (let i = 2; ids.has(id); i++) id = `${norm(k.name)}-${i}`;
  ids.add(id);
  return { id, name: k.name, lat: +k.lat.toFixed(4), lng: +k.lon.toFixed(4) };
});

writeFileSync(OUT, JSON.stringify(areas, null, 1) + '\n');
// Names of the hand-placed anchors, so dev/areas-map.html can show (and let you drag) just those.
writeFileSync(join(here, '..', 'dev', 'extras.json'), JSON.stringify(INCLUDE_EXTRA.map((x) => x.name), null, 1) + '\n');
console.log(`${candidates.length} candidates -> ${areas.length} areas written to public/areas.json`);
