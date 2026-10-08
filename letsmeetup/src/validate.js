// Input validation and the product's constants. Tag names and event types live here (in code,
// not in the database) so adding one is a one-line change.

import { getArea } from './areas.js';

export const EVENT_TYPES = ['lunch', 'dinner', 'drinks'];
export const TAGS = ['outdoor_seating', 'open_late'];
export const MODES = ['transit', 'bike', 'walk'];

export const LIMITS = {
  titleMax: 80,
  maxParticipants: 12,
  eventsPerUserPerDay: 10,
  startMaxDaysAhead: 90,
  startGraceMs: 15 * 60 * 1000, // "drinks in 5 minutes" is fine; yesterday is not
  maxMinutesMin: 10,
  maxMinutesMax: 180,
  displayNameMax: 30,
};

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export function cleanText(value) {
  return typeof value === 'string' ? value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim() : '';
}

// Others only ever see a first name.
export function firstName(fullName) {
  const first = cleanText(fullName).split(' ')[0];
  return (first || 'Friend').slice(0, LIMITS.displayNameMax);
}

export function validateNewEvent(body, now = Date.now()) {
  const title = cleanText(body.title);
  if (!title || title.length > LIMITS.titleMax) return { error: `Title must be 1-${LIMITS.titleMax} characters` };

  if (!EVENT_TYPES.includes(body.eventType)) return { error: 'Unknown event type' };

  const startMs = typeof body.startAt === 'string' ? Date.parse(body.startAt) : NaN;
  if (!Number.isFinite(startMs)) return { error: 'Start time is not valid' };
  if (startMs < now - LIMITS.startGraceMs) return { error: 'Start time is in the past' };
  if (startMs > now + LIMITS.startMaxDaysAhead * 86400 * 1000) {
    return { error: `Start time must be within ${LIMITS.startMaxDaysAhead} days` };
  }

  const rawTags = body.tags === undefined ? [] : body.tags;
  if (!Array.isArray(rawTags) || rawTags.some((t) => !TAGS.includes(t))) return { error: 'Unknown tag' };

  return {
    value: {
      title,
      eventType: body.eventType,
      startAt: new Date(startMs).toISOString(),
      tags: [...new Set(rawTags)],
    },
  };
}

// The only location input the server accepts: an area id (never coordinates).
export function validateMe(body) {
  if (!getArea(body.areaId)) return { error: 'Choose a neighbourhood' };
  if (!MODES.includes(body.mode)) return { error: 'Unknown travel mode' };

  let maxMinutes = null;
  if (body.maxMinutes !== null && body.maxMinutes !== undefined && body.maxMinutes !== '') {
    maxMinutes = body.maxMinutes;
    if (!Number.isInteger(maxMinutes) || maxMinutes < LIMITS.maxMinutesMin || maxMinutes > LIMITS.maxMinutesMax) {
      return { error: `Max travel time must be ${LIMITS.maxMinutesMin}-${LIMITS.maxMinutesMax} minutes` };
    }
  }
  return { value: { areaId: body.areaId, mode: body.mode, maxMinutes } };
}
