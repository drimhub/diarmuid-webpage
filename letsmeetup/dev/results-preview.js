// Renders the real results view and map with made-up results (see scripts/serve-preview.mjs).
import { loadAreas } from '/snap.js';
import { h, renderResults } from '/view.js';
import { resultsMap } from '/map.js';

const areas = await loadAreas();
const nameOf = (id) => areas.find((a) => a.id === id)?.name || id;

const people = [
  { participantId: 'a', name: 'Alice', areaId: 'angel', mode: 'transit' },
  { participantId: 'b', name: 'Bob', areaId: 'acton', mode: 'bike' },
  { participantId: 'c', name: 'Carol', areaId: 'angel', mode: 'walk' },
  { participantId: 'd', name: 'Dev', areaId: 'abbey-wood', mode: 'transit' },
];
const travel = (mins) => {
  const perPerson = people.map((p, i) => ({ ...p, minutes: mins[i] }));
  const max = Math.max(...mins);
  const mean = Math.round(mins.reduce((x, y) => x + y, 0) / mins.length);
  const f = perPerson[mins.indexOf(max)];
  return { perPerson, meanMinutes: mean, maxMinutes: max, spreadMinutes: max - Math.min(...mins), furthest: { participantId: f.participantId, name: f.name, minutes: max, aboveMeanMinutes: max - mean } };
};
const spot = (rank, name, areaId, mins, labels, type = 'pub') => ({
  rank, name, address: `${rank} High Street, London`, rating: 4.3 + rank / 20, ratingCount: 200 * rank, priceLevel: 2, primaryType: type,
  mapsUrl: 'https://maps.google.com/?cid=1', openUntil: 'Open until 23:00', outdoorSeating: rank % 2 === 1,
  area: { id: areaId, name: nameOf(areaId) }, labels, reasons: [], travel: travel(mins),
});

const ok = { status: 'ok', reason: null, notes: [], planned: 4, skipped: 0, stale: false, closestMisses: [], suggestions: [
  spot(1, 'The Crown', 'bank', [28, 35, 30, 34], ['Fairest']),
  spot(2, 'The Anchor', 'bank', [30, 33, 31, 36], ['Quickest for most']),
  spot(3, 'Garden Room', 'camden-town', [22, 40, 18, 48], ['Shortest total travel'], 'cocktail_bar'),
  spot(4, 'The Fox', 'shoreditch', [25, 45, 29, 38], []),
] };
const miss = { ...ok, status: 'no_results', reason: 'no_venue_within_limits', suggestions: [],
  closestMisses: [{ ...spot(1, 'The Crown', 'bank', [28, 35, 30, 55], []), exceeds: [{ name: 'Dev' }] }, { ...spot(2, 'Garden Room', 'camden-town', [22, 40, 18, 58], []), exceeds: [{ name: 'Dev' }] }] };
const stale = { ...ok, stale: true, skipped: 1 };

const out = document.getElementById('out');
const show = (label, r) => out.replaceChildren(...renderResults(r, { isOwner: true, areas, map: resultsMap }));
const buttons = [['Results', ok], ['Closest misses', miss], ['Stale + left out', stale]];
document.getElementById('switch').append(...buttons.map(([label, r]) => h('button', { type: 'button', onclick: () => show(label, r) }, label)));
show(...buttons[0]);
