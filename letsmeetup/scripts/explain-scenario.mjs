// Debug view of a recorded scenario (free: replays fixtures/scenarios/<name>.json). Shows how many
// venues Google returned, why others were filtered out, and EVERY costed venue ranked by score,
// not just the final picks, so weights can be judged against the whole field.
//
//   node scripts/explain-scenario.mjs scenarios/<file>.json

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSuggestions } from '../src/calc/index.js';
import { createProviders } from '../src/providers/index.js';
import { replayFetch } from '../src/providers/http.js';
import { FileStore } from '../testing/file-store.mjs';
import { londonLocalToUtcIso } from '../public/time.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/explain-scenario.mjs scenarios/<file>.json'); process.exit(1); }

const scenario = JSON.parse(readFileSync(join(root, file), 'utf8'));
const areas = JSON.parse(readFileSync(join(root, 'public', 'areas.json'), 'utf8'));

// The recording was made for a particular start time; read it back from the recorded routing request.
const store = new FileStore(join(root, 'fixtures', 'scenarios', `${scenario.name}.json`));
const routingEntry = Object.values(store.entries).find((e) => e.request.url.includes('routes.googleapis.com') && e.request.body.arrivalTime);
const startAt = routingEntry ? routingEntry.request.body.arrivalTime : londonLocalToUtcIso(`${new Date().toISOString().slice(0, 10)}T${scenario.startLondon}`);

const participants = scenario.participants.map((p, i) => ({ id: `p${i + 1}`, areaId: p.area, mode: p.mode, maxMinutes: p.maxMinutes ?? null }));
const names = Object.fromEntries(scenario.participants.map((p, i) => [`p${i + 1}`, p.name]));

const r = await computeSuggestions({
  event: { eventType: scenario.eventType, startAt, tags: scenario.tags || [] },
  participants, areas,
  providers: createProviders({ GOOGLE_MAPS_API_KEY: 'replay' }, { fetch: replayFetch(store) }),
  config: { minSuggestions: 99, maxSuggestions: 99, minPickSeparationMeters: 0 }, // show everything that was costed
});

console.log(`Venues found ${r.meta.venuesFound}; qualifying ${r.meta.venuesQualifying}; costed ${r.meta.venuesCosted}`);
console.log('Rejected before costing:', JSON.stringify(r.excluded.venuesRejected));
console.log('Candidates:', r.candidates.map((c) => `${c.name} ~${c.estimatedMeanMinutes}m`).join(', '));
console.log(`\n${'#'.padEnd(3)} ${'venue'.padEnd(30)} ${'area'.padEnd(14)} ${'type'.padEnd(18)} rating   ` + participants.map((p) => names[p.id].slice(0, 8).padStart(8)).join(' ') + '   mean  max sprd | score = travel - quality');
r.suggestions.forEach((s, i) => {
  const t = s.travel.perPerson.map((p) => String(p.minutes).padStart(8)).join(' ');
  const b = s.scoreBreakdown;
  console.log(`${String(i + 1).padEnd(3)} ${s.venue.name.slice(0, 29).padEnd(30)} ${s.area.name.slice(0, 13).padEnd(14)} ${(s.venue.primaryType || '-').slice(0, 17).padEnd(18)} ${String(s.venue.rating).padStart(3)}/${String(s.venue.ratingCount).padEnd(5)} ${t}   ${String(s.travel.meanMinutes).padStart(4)} ${String(s.travel.maxMinutes).padStart(4)} ${String(s.travel.spreadMinutes).padStart(4)} | ${String(s.score).padStart(5)} = ${b.travel} - ${b.quality}${b.unknownHoursPenalty ? ' +hours?' : ''}`);
});
for (const n of r.notes) console.log('Note:', n);
