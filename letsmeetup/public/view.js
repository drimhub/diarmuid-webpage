// Pure DOM building shared by the app and its tests: the `h()` element helper and the results view.
// Every piece of server- or third-party-supplied text (names, addresses, notes) goes in through
// textContent or text nodes, never innerHTML, and links are only ever plain Google Maps URLs.
// Uses the global `document`, so it can run under a simulated DOM in tests.

export const MODE_LABELS = { transit: 'Public transport', bike: 'Cycling', walk: 'Walking' };

// ---------- tiny DOM helpers ----------

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}


// ---------- results ----------

// Links to Google Maps come from the server's data; only plain Google Maps links become hrefs.
export function safeMapsHref(url) {
  return typeof url === 'string' && /^https:\/\/(maps\.google\.com\/|(www\.)?google\.com\/maps)/.test(url) ? url : null;
}
export const humanType = (t) => (t ? t.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '');
export const priceText = (n) => (n == null ? '' : n === 0 ? 'Free' : '£'.repeat(n));

const NO_RESULT_TEXT = {
  no_venues_found: "We couldn't find any places near the middle of everyone's journeys.",
  no_venues_matched: 'Nothing suitable looks to be open then. Try a different time or fewer requirements.',
  no_venue_within_limits: "Nobody can get to a suitable place within everyone's limits.",
  journeys_unavailable: "We couldn't work out the journeys right now. Please try again.",
};

function journeyList(travel) {
  return h('ul', { class: 'plain journeys' }, travel.perPerson.map((p) => h('li', {},
    h('span', {}, p.name, h('span', { class: 'muted small' }, ` · ${MODE_LABELS[p.mode] || p.mode}`)),
    h('span', {}, `${p.minutes} min`, p.participantId === travel.furthest.participantId && travel.perPerson.length > 1 && h('span', { class: 'chip', style: 'margin-left:.4rem' }, 'furthest')))));
}

export function suggestionCard(s, { miss } = {}) {
  const href = safeMapsHref(s.mapsUrl);
  const facts = [humanType(s.primaryType), s.rating != null ? `${s.rating} ★ (${s.ratingCount ?? 0} reviews)` : null, priceText(s.priceLevel), s.openUntil, s.outdoorSeating ? 'Outdoor seating' : null].filter(Boolean);
  return h('div', { class: 'pick' },
    h('div', { class: 'row' }, h('strong', { class: 'grow' }, `${s.rank}. `, href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, s.name) : s.name),
      h('span', { class: 'muted small' }, s.area.name)),
    s.labels.length > 0 && h('div', {}, s.labels.map((l) => h('span', { class: 'chip' }, l))),
    h('div', { class: 'muted small' }, facts.join(' · ')),
    s.address && h('div', { class: 'muted small' }, s.address),
    journeyList(s.travel),
    h('div', { class: 'small' }, `Average ${s.travel.meanMinutes} min · longest ${s.travel.maxMinutes} min (${s.travel.furthest.name}${s.travel.furthest.aboveMeanMinutes > 0 ? `, ${s.travel.furthest.aboveMeanMinutes} min above average` : ''})`),
    miss && h('div', { class: 'error' }, 'Too far for: ' + miss.exceeds.map((x) => x.name).join(', ')));
}

export function renderResults(r, { isOwner }) {
  const out = [];
  if (r.stale) out.push(h('p', { class: 'stale' }, isOwner ? 'Someone has changed their plans since this was worked out. Press "Find again" to update it.' : 'Someone has changed their plans since this was worked out. The organiser can update it.'));
  if (r.skipped > 0) out.push(h('p', { class: 'muted small' }, `${r.skipped} ${r.skipped === 1 ? 'person hadn\'t' : 'people hadn\'t'} said where they are travelling from, so ${r.skipped === 1 ? 'they were' : 'they were'} left out.`));
  if (r.status !== 'ok') {
    out.push(h('p', {}, NO_RESULT_TEXT[r.reason] || 'We could not find suggestions this time.'));
    if (r.closestMisses.length) {
      out.push(h('p', { class: 'muted small' }, 'The closest options, which go over someone\'s limit:'));
      out.push(...r.closestMisses.map((m) => suggestionCard(m, { miss: m })));
    }
  } else {
    out.push(...r.suggestions.map((s) => suggestionCard(s)));
  }
  if (r.notes.length) out.push(h('ul', { class: 'plain notes' }, r.notes.map((n) => h('li', { class: 'muted small' }, n))));
  out.push(h('p', { class: 'muted small' }, 'Place details from Google Maps.'));
  return out;
}

