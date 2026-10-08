// The "where are you travelling from?" picker: type-ahead over London neighbourhoods, a UK postcode
// lookup, or "use my location". Only the chosen area's id ever leaves this component; positions and
// postcodes are resolved here in the browser (see snap.js). The lookups are injectable so tests
// don't need a network or a real device.

import { searchAreas, snapToArea, looksLikePostcode, lookupPostcode, getCurrentPosition } from './snap.js';
import { h } from './view.js';

export const MESSAGES = {
  noMatch: 'No match. Try a London neighbourhood, like Soho or Brixton, or a UK postcode.',
  outside: "That looks to be outside London. Pick the London neighbourhood you'll be travelling from, for example Soho.",
  postcodeNotFound: "Couldn't find that postcode. Try a London neighbourhood name instead.",
  postcodeHint: 'Press Enter to look up this postcode.',
  locating: 'Locating…',
};

export function areaPicker({ areas, initialAreaId, lookup = lookupPostcode, locate = getCurrentPosition }) {
  let chosen = areas.find((a) => a.id === initialAreaId) || null;
  const input = h('input', { type: 'search', placeholder: 'Area or postcode, e.g. Hoxton or E8', autocomplete: 'off', 'aria-label': 'Area or postcode' });
  const list = h('ul', { class: 'picks' });
  const picked = h('p', { class: 'picked', role: 'status' });

  const status = () => (chosen ? `Travelling from ${chosen.name}` : '');

  function choose(area, note) {
    chosen = area;
    input.value = '';
    list.replaceChildren();
    picked.textContent = `Travelling from ${area.name}${note ? ` (${note})` : ''}`;
  }

  // A failed attempt leaves any earlier choice in place; the message says what happened.
  function say(message) {
    list.replaceChildren();
    picked.textContent = message;
  }

  function snap(point, note) {
    const hit = snapToArea(point.lat, point.lng, areas);
    if (hit) choose(hit.area, note);
    else say(MESSAGES.outside);
  }

  input.addEventListener('input', () => {
    const text = input.value.trim();
    const matches = searchAreas(text, areas);
    list.replaceChildren(...matches.map((a) => h('li', {}, h('button', { type: 'button', onclick: () => choose(a) }, a.name))));
    if (!text || matches.length > 0) picked.textContent = status();
    else if (looksLikePostcode(text)) picked.textContent = MESSAGES.postcodeHint;
    else picked.textContent = MESSAGES.noMatch;
  });

  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault(); // don't submit the surrounding form
    const text = input.value.trim();
    if (!text) return;
    if (looksLikePostcode(text)) {
      const point = await Promise.resolve(lookup(text)).catch(() => null);
      if (!point) say(MESSAGES.postcodeNotFound);
      else snap(point, 'from your postcode');
      return;
    }
    const [first] = searchAreas(text, areas, 1);
    if (first) choose(first); // Enter takes the top suggestion
  });

  const locateButton = h('button', { type: 'button', onclick: async () => {
    try {
      picked.textContent = MESSAGES.locating;
      snap(await locate(), 'from your location');
    } catch (e) {
      say(e && e.message ? e.message : 'Could not get your location.');
    }
  } }, 'Use my location');

  picked.textContent = status();
  return {
    el: h('div', {}, input, list,
      h('p', { class: 'muted small' }, 'Type an area, or a postcode and press Enter. Your exact location stays on your device; only the neighbourhood is shared.'),
      h('div', { class: 'row' }, locateButton), picked),
    getArea: () => chosen,
  };
}
