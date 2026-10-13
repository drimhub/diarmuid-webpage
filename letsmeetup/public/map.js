// The results map: where everyone is travelling from (their neighbourhood) and where each suggested
// spot is (its neighbourhood), on OpenStreetMap tiles via Leaflet.
// Nothing here receives a coordinate from the server: results carry neighbourhood ids, and the
// positions come from our own areas.json, so pins mark neighbourhood centres, not exact addresses
// or homes. Names go into Leaflet only as DOM nodes (a string tooltip would be parsed as HTML).
// buildMapModel is pure so it can be tested in Node; the Leaflet part runs in the browser.

import { h, MODE_LABELS } from './view.js';

const LEAFLET = {
  version: '1.9.4',
  js: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  jsIntegrity: 'sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==',
  css: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  cssIntegrity: 'sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw==',
};
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const SPREAD_METRES = 350; // how far apart suggestions that share a neighbourhood are drawn

// options: result suggestions (rank, name, area {id,name}, travel.perPerson [{name, areaId, mode, minutes}])
// areaById: Map of areas.json entries. Anything whose area is unknown is left off the map.
export function buildMapModel(options, areaById) {
  const byArea = new Map();
  for (const o of options) {
    const a = o.area && areaById.get(o.area.id);
    if (!a) continue;
    if (!byArea.has(a.id)) byArea.set(a.id, []);
    byArea.get(a.id).push(o);
  }

  const venues = [];
  for (const [id, group] of byArea) {
    const a = areaById.get(id);
    group.forEach((o, i) => {
      let { lat, lng } = a;
      if (group.length > 1) { // fan out around the neighbourhood centre so the pins don't sit on top of each other
        const angle = (2 * Math.PI * i) / group.length;
        lat += (SPREAD_METRES / 111320) * Math.cos(angle);
        lng += (SPREAD_METRES / (111320 * Math.cos((a.lat * Math.PI) / 180))) * Math.sin(angle);
      }
      venues.push({ rank: o.rank, areaName: a.name, lat, lng }); // no venue name: it is Google Places content, shown on the cards, not on this OpenStreetMap map
    });
  }
  venues.sort((x, y) => x.rank - y.rank);

  // Everyone is planned for in every option, so the first option lists all the origins.
  const originsByArea = new Map();
  for (const p of (options[0] ? options[0].travel.perPerson : [])) {
    const a = p.areaId && areaById.get(p.areaId);
    if (!a) continue;
    if (!originsByArea.has(a.id)) originsByArea.set(a.id, { areaName: a.name, lat: a.lat, lng: a.lng, names: [] });
    originsByArea.get(a.id).names.push(p.name);
  }
  const origins = [...originsByArea.values()];

  // One line per person per option: from where they start to that option.
  const lines = {};
  for (const o of options) {
    const v = venues.find((x) => x.rank === o.rank);
    if (!v) continue;
    lines[o.rank] = o.travel.perPerson.flatMap((p) => {
      const a = p.areaId && areaById.get(p.areaId);
      return a ? [{ name: p.name, mode: p.mode, minutes: p.minutes, from: [a.lat, a.lng], to: [v.lat, v.lng] }] : [];
    });
  }
  return { venues, origins, lines };
}

let leafletLoading = null;
// Leaflet comes from cdnjs with subresource integrity. Resolves to the global L, rejects if it can't load.
export function loadLeaflet() {
  if (globalThis.L) return Promise.resolve(globalThis.L);
  if (!leafletLoading) {
    leafletLoading = new Promise((resolve, reject) => {
      document.head.append(h('link', { rel: 'stylesheet', href: LEAFLET.css, integrity: LEAFLET.cssIntegrity, crossorigin: '' }));
      const script = h('script', { src: LEAFLET.js, integrity: LEAFLET.jsIntegrity, crossorigin: '' });
      script.addEventListener('load', () => (globalThis.L ? resolve(globalThis.L) : reject(new Error('Leaflet did not start'))));
      script.addEventListener('error', () => reject(new Error('Leaflet did not load')));
      document.head.append(script);
    }).catch((e) => { leafletLoading = null; throw e; });
  }
  return leafletLoading;
}

// Returns { el, select(rank) }. The map appears once Leaflet has loaded; if it can't, the box says so
// and the cards still work on their own.
export function resultsMap(options, areas, { load = loadLeaflet } = {}) {
  const model = buildMapModel(options, new Map(areas.map((a) => [a.id, a])));
  const note = h('p', { class: 'muted small map-note' }, 'Pins mark neighbourhood centres, and lines are straight, not the route.');
  const canvas = h('div', { class: 'map', role: 'img', 'aria-label': 'Map of where everyone is travelling from and the suggested spots' });
  const el = h('div', { class: 'map-wrap', hidden: model.venues.length === 0 }, canvas, note);
  let selectNow = () => {};
  let wanted = options.length ? options[0].rank : null;

  load().then((L) => {
    const map = L.map(canvas, { scrollWheelZoom: false });
    L.tileLayer(TILES, { maxZoom: 17, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
    const tip = (text) => h('span', {}, text);
    const lineLayer = L.layerGroup().addTo(map);
    const pins = new Map();

    for (const o of model.origins) {
      L.marker([o.lat, o.lng], { icon: L.divIcon({ className: 'map-origin', html: h('span', {}), iconSize: [14, 14] }), keyboard: false })
        .bindTooltip(tip(`${o.names.join(', ')} · from ${o.areaName}`)).addTo(map);
    }
    for (const v of model.venues) {
      const pin = L.marker([v.lat, v.lng], { icon: L.divIcon({ className: 'map-pin', html: h('span', {}, v.rank), iconSize: [28, 28] }), keyboard: false })
        .bindTooltip(tip(`Option ${v.rank} · ${v.areaName}`)).addTo(map);
      pin.on('click', () => selectNow(v.rank));
      pins.set(v.rank, pin);
    }

    selectNow = (rank) => {
      wanted = rank;
      lineLayer.clearLayers();
      for (const [r, pin] of pins) pin.getElement()?.classList.toggle('selected', r === rank);
      for (const l of model.lines[rank] || []) {
        L.polyline([l.from, l.to], { color: '#1f6feb', weight: 3, opacity: 0.7, dashArray: l.mode === 'transit' ? null : '6 6' })
          .bindTooltip(tip(`${l.name} · ${MODE_LABELS[l.mode] || l.mode} · ${l.minutes} min`), { sticky: true }).addTo(lineLayer);
      }
      pins.get(rank)?.setZIndexOffset(1000);
    };

    const points = [...model.origins, ...model.venues].map((p) => [p.lat, p.lng]);
    map.fitBounds(points, { padding: [30, 30], maxZoom: 14 });
    selectNow(wanted);
  }).catch(() => {
    canvas.hidden = true;
    note.textContent = "The map couldn't be loaded, but the suggestions below are unaffected.";
  });

  return { el, select: (rank) => selectNow(rank) };
}
