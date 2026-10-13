// Builds src/data/transit-times.json: how long transit takes between every pair of neighbourhoods,
// from TfL's open journey planner (free, no key needed; a key just raises the rate limit). One-off,
// resumable and polite. See NETWORK-CANDIDATES.md.
//
//   node scripts/build-transit-table.mjs --dry              what it would do (pairs, time), no requests
//   node scripts/build-transit-table.mjs --sample 20        fetch 20 random pairs and print them; writes nothing
//   node scripts/build-transit-table.mjs                    fetch everything missing, then write the table
//   options: --date YYYYMMDD (default: a Tuesday at least a week away) --rate N (requests/second, default 1,
//            8 with TFL_APP_KEY) --concurrency N (default 6) --out FILE --cache FILE
//
// Every answer is appended to fixtures/transit-cache.jsonl (git-ignored), keyed by the two anchors'
// coordinates and the time basis, so an interruption, or moving one anchor, only redoes what is missing.
// One direction per pair is fetched (i < j) and mirrored.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTable, UNREACHABLE } from '../src/calc/network.js';
import { compactJourneys, tableValue } from './lib/tfl-journey.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };

// Key: TFL_APP_KEY in letsmeetup/.dev.vars (git-ignored) or the environment. Optional, but far faster.
const devVars = fileURLToPath(new URL('../.dev.vars', import.meta.url));
const keyFromFile = existsSync(devVars) ? (readFileSync(devVars, 'utf8').match(/^\s*TFL_APP_KEY\s*=\s*"?([^"\s]+)"?\s*$/m) || [])[1] : '';
const KEY = process.env.TFL_APP_KEY || keyFromFile || '';
// Without a key TfL allows roughly one request a second before answering 429; with a free key, far more.
const rate = Number(opt('rate', KEY ? 8 : 1));
const concurrency = Number(opt('concurrency', 6));
const cachePath = opt('cache', root + 'fixtures/transit-cache.jsonl');
const outPath = opt('out', root + 'src/data/transit-times.json');
const areas = JSON.parse(readFileSync(root + 'public/areas.json', 'utf8'));

function nextTuesday() {
  const d = new Date(Date.now() + 7 * 864e5);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
const date = opt('date', nextTuesday());
const basis = `Tuesday ${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)} 19:00 departing, scheduled`;

const pairs = [];
for (let i = 0; i < areas.length; i++) for (let j = i + 1; j < areas.length; j++) pairs.push([i, j]);
const ckey = (a, b) => `${a.lat},${a.lng}|${b.lat},${b.lng}|${date}1900`;

// ---- cache ----
const cache = new Map();
if (existsSync(cachePath)) {
  for (const line of readFileSync(cachePath, 'utf8').split('\n')) {
    if (!line) continue;
    try { const { k, j } = JSON.parse(line); cache.set(k, j); } catch { /* a torn last line from an interrupted run */ }
  }
}
const todo = pairs.filter(([i, j]) => !cache.has(ckey(areas[i], areas[j])));

console.log(`${areas.length} areas, ${pairs.length} pairs, ${pairs.length - todo.length} cached, ${todo.length} to fetch.`);
console.log(`Basis: ${basis}. ~${Math.round(todo.length / rate / 60)} min at ${rate} requests/second.`);
if (flag('dry')) process.exit(0);

// ---- fetching ----
let lastStart = 0;
let pausedUntil = 0; // a 429 pauses every worker, not just the one that saw it
async function paced() {
  if (pausedUntil > Date.now()) await new Promise((r) => setTimeout(r, pausedUntil - Date.now()));
  const wait = lastStart + 1000 / rate - Date.now();
  lastStart = Math.max(Date.now(), lastStart + 1000 / rate);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function fetchPair(a, b) {
  const url = `https://api.tfl.gov.uk/Journey/JourneyResults/${a.lat},${a.lng}/to/${b.lat},${b.lng}`
    + `?date=${date}&time=1900&timeIs=Departing&journeyPreference=LeastTime${KEY ? `&app_key=${KEY}` : ''}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    await paced();
    let res;
    try { res = await fetch(url); } catch { await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
    if (res.status === 429) {
      const wait = (Number(res.headers.get('retry-after')) || 5 * 2 ** attempt) * 1000;
      if (pausedUntil < Date.now()) console.warn(`429, pausing ${Math.round(wait / 1000)}s`);
      pausedUntil = Math.max(pausedUntil, Date.now() + wait);
      continue;
    }
    if (res.status === 400 || res.status === 404) return []; // no journey between these points
    if (!res.ok) { await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
    return compactJourneys(await res.json());
  }
  throw new Error(`gave up on ${a.id} to ${b.id}`);
}

async function fetchAll(list) {
  let next = 0, done = 0, failed = 0;
  const started = Date.now();
  const worker = async () => {
    while (next < list.length) {
      const [i, j] = list[next++];
      const a = areas[i], b = areas[j];
      try {
        const journeys = await fetchPair(a, b);
        const k = ckey(a, b);
        cache.set(k, journeys);
        mkdirSync(dirname(cachePath), { recursive: true });
        appendFileSync(cachePath, JSON.stringify({ k, j: journeys }) + '\n');
      } catch (e) { failed++; console.warn(e.message); }
      if (++done % 200 === 0) {
        const per = (Date.now() - started) / done;
        console.log(`${done}/${list.length} (${failed} failed), ~${Math.round(per * (list.length - done) / 60000)} min left`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return failed;
}

if (flag('sample')) {
  const n = Number(opt('sample', 20));
  let s = 12345; const rand = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; // seeded: repeatable
  const picks = Array.from({ length: n }, () => pairs[Math.floor(rand() * pairs.length)]);
  for (const [i, j] of picks) {
    const journeys = await fetchPair(areas[i], areas[j]);
    console.log(`${areas[i].id} > ${areas[j].id}`.padEnd(44), String(tableValue(journeys)).padStart(4), `(${journeys.length} journeys)`);
  }
  process.exit(0);
}

const failed = await fetchAll(todo);
if (failed) { console.error(`${failed} pairs failed; re-run to retry them. Not writing the table.`); process.exit(1); }

// ---- table ----
const n = areas.length;
const bytes = new Uint8Array(n * n);
let unreachable = 0;
for (const [i, j] of pairs) {
  const v = tableValue(cache.get(ckey(areas[i], areas[j])));
  if (v === UNREACHABLE) unreachable++;
  bytes[i * n + j] = v;
  bytes[j * n + i] = v;
}
const table = makeTable({ areas, bytes, source: 'tfl', basis, builtAt: new Date().toISOString().slice(0, 10) });
writeFileSync(outPath, JSON.stringify(table) + '\n');
console.log(`Wrote ${outPath} (${unreachable} unreachable pairs of ${pairs.length}).`);
