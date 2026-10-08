// Runs the whole calculation for a scenario and prints what it suggests.
//
//   npm run scenario -- scenarios/<file>.json            free: offline fake providers (instant, no network)
//   npm run scenario -- scenarios/<file>.json --replay   replay fixtures/scenarios/<name>.json (no network, no cost)
//   npm run scenario -- scenarios/<file>.json --live     show the plan and worst-case cost only
//   npm run scenario -- scenarios/<file>.json --live --yes   REAL Google calls (costs pennies); also records them
//                                                            to fixtures/scenarios/<name>.json for --replay
// (PowerShell can swallow the `--`; run `node scripts/run-scenario.mjs <file> --replay` directly if so.)
//
// A scenario: event type, start (daysAhead + startLondon), tags, and people (name, area id, mode,
// optional maxMinutes). The pipeline chooses its own searches, so a live recording contains
// exactly the requests that a replay will ask for.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSuggestions } from '../src/calc/index.js';
import { DEFAULTS } from '../src/calc/config.js';
import { createProviders } from '../src/providers/index.js';
import { recordingFetch, replayFetch } from '../src/providers/http.js';
import { FileStore } from '../testing/file-store.mjs';
import { createFakePlaces, createFakeRouting } from '../testing/fake-providers.mjs';
import { londonLocalToUtcIso, formatLondon } from '../public/time.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const flag = (f) => args.includes(`--${f}`);
const fail = (m) => { console.error(m); process.exit(1); };
if (!file) fail('Usage: node scripts/run-scenario.mjs scenarios/<file>.json [--replay | --live [--yes]]');

const scenario = JSON.parse(readFileSync(join(root, file), 'utf8'));
const areas = JSON.parse(readFileSync(join(root, 'public', 'areas.json'), 'utf8'));
const areaById = new Map(areas.map((a) => [a.id, a]));
for (const p of scenario.participants) if (!areaById.has(p.area)) fail(`Unknown area id "${p.area}" in ${file}`);

const day = new Date(Date.now() + (scenario.daysAhead ?? 1) * 86400 * 1000);
const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(day);
const startAt = londonLocalToUtcIso(`${dateStr}T${scenario.startLondon || '19:30'}`);
const fixturePath = join(root, 'fixtures', 'scenarios', `${scenario.name}.json`);

const participants = scenario.participants.map((p, i) => ({ id: `p${i + 1}`, areaId: p.area, mode: p.mode, maxMinutes: p.maxMinutes ?? null }));
const names = Object.fromEntries(scenario.participants.map((p, i) => [`p${i + 1}`, p.name || `Person ${i + 1}`]));
const event = { eventType: scenario.eventType, startAt, tags: scenario.tags || [] };

let providers;
let store = null;
let source;
if (flag('live')) {
  const maxPlaces = DEFAULTS.maxCandidates * DEFAULTS.radiusStepsMeters.length;
  const origins = new Set(participants.map((p) => `${p.mode}|${p.areaId}`)).size;
  const maxElements = origins * DEFAULTS.maxShortlist;
  console.log(`Plan: up to ${maxPlaces} Places searches (typically ${DEFAULTS.maxCandidates}) and up to ${maxElements} routing elements`);
  console.log(`Worst case about $${(maxPlaces * 0.04 + maxElements * 0.015).toFixed(2)}, typically $${(DEFAULTS.maxCandidates * 0.04 + maxElements * 0.008).toFixed(2)}; inside Google's free monthly allowance for occasional runs.`);
  if (!flag('yes')) {
    console.log('\nNothing was called. Add --yes to run for real and record the traffic.');
    process.exit(0);
  }
  const devVars = join(root, '.dev.vars');
  const fromFile = existsSync(devVars) ? (readFileSync(devVars, 'utf8').match(/^\s*GOOGLE_MAPS_API_KEY\s*=\s*"?([^"\s]+)"?\s*$/m) || [])[1] : null;
  const key = process.env.GOOGLE_MAPS_API_KEY || fromFile;
  if (!key) fail('GOOGLE_MAPS_API_KEY not found in letsmeetup/.dev.vars');
  store = new FileStore(fixturePath);
  providers = createProviders({ GOOGLE_MAPS_API_KEY: key }, { fetch: recordingFetch(fetch, store) });
  source = 'live Google (recording)';
} else if (flag('replay')) {
  if (!existsSync(fixturePath)) fail(`No recording at fixtures/scenarios/${scenario.name}.json yet. Record one with --live --yes.`);
  providers = createProviders({ GOOGLE_MAPS_API_KEY: 'replay' }, { fetch: replayFetch(new FileStore(fixturePath)) });
  source = 'replayed Google recording';
} else {
  providers = { places: createFakePlaces(), routing: createFakeRouting() };
  source = 'offline fake providers (straight-line times, synthetic venues)';
}

const result = await computeSuggestions({ event, participants, areas, providers });
if (store) store.save();

const who = participants.map((p) => `${names[p.id]} (${areaById.get(p.areaId).name}, ${p.mode}${p.maxMinutes ? `, max ${p.maxMinutes}m` : ''})`);
console.log(`\n${scenario.name}: ${scenario.eventType} at ${formatLondon(startAt)} London${event.tags.length ? ` [${event.tags.join(', ')}]` : ''}`);
console.log(`People: ${who.join('; ')}`);
console.log(`Source: ${source}`);
console.log(`Looked around: ${result.candidates.map((c) => `${c.name} (${c.heuristics.join('+')})`).join(', ')}\n`);

const showCost = () => {
  console.log(`\nCalls: ${result.cost.places.requests} Places requests, ${result.cost.routing.requests} Routes requests (${result.cost.routing.elements} elements)`);
  if (store) console.log(`Saved recording to fixtures/scenarios/${scenario.name}.json`);
};

if (result.status !== 'ok') {
  console.log(`No suggestions: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
  for (const m of result.closestMisses || []) {
    console.log(`  closest: ${m.venue.name} in ${m.area.name}; over the limit for ${m.exceeds.map((x) => `${names[x.participantId]} (${x.minutes}m vs ${x.limit}m)`).join(', ')}`);
  }
  for (const n of result.notes) console.log(`  note: ${n}`);
  showCost();
  process.exit(0);
}

for (const s of result.suggestions) {
  const v = s.venue;
  console.log(`${s.rank}. ${v.name}  [${s.area.name}]  ${v.rating ?? '-'} stars (${v.ratingCount ?? '-'} reviews)  ${s.labels.length ? '<' + s.labels.join(', ') + '>' : ''}`);
  console.log(`   ${s.travel.perPerson.map((p) => `${names[p.participantId]} ${p.minutes}m`).join('   ')}`);
  console.log(`   mean ${s.travel.meanMinutes}m, longest ${s.travel.maxMinutes}m (${names[s.travel.furthest.participantId]}, ${s.travel.furthest.aboveMeanMinutes}m above average), spread ${s.travel.spreadMinutes}m, score ${s.score}`);
}
for (const n of result.notes) console.log(`\nNote: ${n}`);
showCost();
