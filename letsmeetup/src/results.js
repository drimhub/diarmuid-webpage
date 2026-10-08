// Turns a stored calculation run into what the API returns. Only first names, neighbourhoods and
// journey times of the people in the event are included, and only the fields the UI shows.

import { minutesOpenFrom, londonWeekMinute } from './hours.js';

// The "View on Google Maps" link comes from a third party, so only plain https Google Maps links
// are passed on (it ends up in an href).
export function safeMapsUrl(url) {
  if (typeof url !== 'string' || url.length > 600) return null;
  try {
    const u = new URL(url);
    const ok = u.protocol === 'https:' && (u.hostname === 'maps.google.com' || ((u.hostname === 'www.google.com' || u.hostname === 'google.com') && u.pathname.startsWith('/maps')));
    return ok ? u.href : null;
  } catch {
    return null;
  }
}

export function openUntilText(venue, startAt) {
  const open = minutesOpenFrom(venue.openingHours, startAt);
  if (open === null || open === 0) return null;
  if (open === Infinity) return 'Open 24 hours';
  const close = ((londonWeekMinute(startAt) % 1440) + open) % 1440;
  const hh = String(Math.floor(close / 60)).padStart(2, '0');
  const mm = String(close % 60).padStart(2, '0');
  return `Open until ${hh}:${mm}`;
}

// Have the inputs changed since the run? (someone moved, joined, left, or the event was edited)
export function inputsChanged(snapshot, currentParticipants, event) {
  const key = (p) => `${p.id}|${p.areaId}|${p.mode}|${p.maxMinutes ?? ''}`;
  const then = snapshot.participants.map(key).sort().join(',');
  const now = currentParticipants.filter((p) => p.areaId).map((p) => key({ id: p.id, areaId: p.areaId, mode: p.mode, maxMinutes: p.maxMinutes })).sort().join(',');
  const sameEvent = snapshot.event.startAt === event.startAt && snapshot.event.eventType === event.eventType
    && [...snapshot.event.tags].sort().join() === [...event.tags].sort().join();
  return then !== now || !sameEvent;
}

export function shapeRun(run, { currentParticipants, event }) {
  if (!run) return { run: null, results: null };
  const summary = {
    id: run.id,
    status: run.status,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    error: run.status === 'failed' ? 'We could not work out suggestions this time. Please try again.' : null,
  };
  // Stored suggestions are erased after 30 days (see retention.js); the run itself remains.
  if (run.status === 'done' && !run.result_json) return { run: { ...summary, status: 'expired' }, results: null };
  if (run.status !== 'done') return { run: summary, results: null };

  const snapshot = JSON.parse(run.input_snapshot);
  const result = JSON.parse(run.result_json);
  const nameOf = Object.fromEntries(snapshot.participants.map((p) => [p.id, p.name]));

  const shapeTravel = (t) => ({
    perPerson: t.perPerson.map((p) => ({ participantId: p.participantId, name: nameOf[p.participantId] || 'Someone', mode: p.mode, minutes: p.minutes })),
    meanMinutes: t.meanMinutes,
    maxMinutes: t.maxMinutes,
    spreadMinutes: t.spreadMinutes,
    furthest: { participantId: t.furthest.participantId, name: nameOf[t.furthest.participantId] || 'Someone', minutes: t.furthest.minutes, aboveMeanMinutes: t.furthest.aboveMeanMinutes },
  });
  const shapeSuggestion = (s) => ({
    rank: s.rank,
    name: s.venue.name,
    address: s.venue.address,
    rating: s.venue.rating,
    ratingCount: s.venue.ratingCount,
    priceLevel: s.venue.priceLevel,
    primaryType: s.venue.primaryType,
    mapsUrl: safeMapsUrl(s.venue.mapsUrl),
    openUntil: openUntilText(s.venue, snapshot.event.startAt),
    outdoorSeating: s.venue.attributes.outdoorSeating,
    area: s.area,
    labels: s.labels,
    reasons: s.reasons,
    travel: shapeTravel(s.travel),
  });

  return {
    run: summary,
    results: {
      status: result.status,
      reason: result.reason || null,
      notes: result.notes,
      suggestions: result.suggestions.map(shapeSuggestion),
      closestMisses: (result.closestMisses || []).map((m) => ({
        ...shapeSuggestion(m),
        exceeds: m.exceeds.map((x) => ({ name: nameOf[x.participantId] || 'Someone' })), // never the limit itself: it is private to that person
      })),
      planned: snapshot.participants.length,
      skipped: result.excluded && result.excluded.participantsWithoutLocation ? result.excluded.participantsWithoutLocation.length : 0,
      stale: inputsChanged(snapshot, currentParticipants, event),
    },
  };
}
