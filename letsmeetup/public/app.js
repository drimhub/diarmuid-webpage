// letsmeetup front end: a small vanilla-JS single page app (no build step).
// Rules: every piece of server- or user-supplied text goes in via textContent / text nodes, never
// innerHTML. The only location data ever sent is an area id (see snap.js).

import { loadAreas } from '/snap.js';
import { areaPicker } from '/picker.js';
import { guestForm } from '/guests.js';
import { londonLocalToUtcIso, formatLondon, defaultStartLocal } from '/time.js';
import { MODE_LABELS, h, renderResults } from '/view.js';

const API_HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'letsmeetup' };
const TYPE_LABELS = { drinks: 'Drinks', lunch: 'Lunch', dinner: 'Dinner' };
const TAG_LABELS = { outdoor_seating: 'Outdoor seating', open_late: 'Open late' };
const POLL_MS = 15000;

const app = document.getElementById('app');
const state = { user: null, config: null, areas: [], pollTimer: null, renderToken: 0 };

const link = (text, href) => h('a', { href, onclick: (e) => { e.preventDefault(); navigate(href); } }, text);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: method === 'GET' ? undefined : API_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || 'Something went wrong');
    err.status = res.status;
    throw err;
  }
  return data;
}

function navigate(path) {
  history.pushState({}, '', path);
  render();
}

// ---------- Google sign-in and Turnstile (third-party scripts load async) ----------

function whenReady(test, cb) {
  if (test()) return cb();
  const t = setInterval(() => { if (test()) { clearInterval(t); cb(); } }, 100);
}

let gisReady = false;
function renderGoogleButton(container, onError) {
  whenReady(() => window.google && google.accounts && google.accounts.id, () => {
    if (!gisReady) {
      google.accounts.id.initialize({
        client_id: state.config.googleClientId,
        callback: async (resp) => {
          try {
            const { user } = await api('/api/auth/google', { method: 'POST', body: { credential: resp.credential } });
            state.user = user;
            render();
          } catch {
            onError('Sign-in failed. Please try again.');
          }
        },
      });
      gisReady = true;
    }
    google.accounts.id.renderButton(container, { theme: 'outline', size: 'large' });
  });
}

// ---------- views ----------

function header() {
  return h('header', { class: 'bar' },
    h('a', { class: 'brand', href: '/', onclick: (e) => { e.preventDefault(); navigate('/'); } }, "Let's meet up"),
    state.user && h('div', { class: 'who' },
      h('span', {}, state.user.name),
      h('button', { class: 'link', type: 'button', onclick: async () => {
        await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
        state.user = null;
        render();
      } }, 'Sign out')));
}

function messageView(text) {
  return { el: h('section', { class: 'card' }, h('p', {}, text), link('Back to your events', '/')) };
}

function signedOutView() {
  const invited = /^\/e\//.test(location.pathname);
  const err = h('p', { class: 'error', role: 'alert' });
  const button = h('div', {});
  return {
    el: h('section', { class: 'card' },
      h('h1', {}, invited ? "You've been invited" : "Let's meet up"),
      h('p', {}, invited
        ? 'Sign in with Google to see the event and say where you are travelling from.'
        : 'Find a London spot that works for everyone. Create an event, share the link, and we will suggest places that are a fair journey for all of you.'),
      button, err),
    mount: () => renderGoogleButton(button, (m) => { err.textContent = m; }),
  };
}

async function homeView() {
  const { events } = await api('/api/events');

  const title = h('input', { type: 'text', maxlength: 80, required: true, placeholder: 'Drinks tonight' });
  const type = h('select', {}, Object.entries(TYPE_LABELS).map(([v, l]) => h('option', { value: v }, l)));
  const when = h('input', { type: 'datetime-local', required: true, value: defaultStartLocal() });
  const tagBoxes = Object.entries(TAG_LABELS).map(([v, l]) => ({ v, box: h('input', { type: 'checkbox', value: v }), l }));
  const turnstileBox = h('div', {});
  const err = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { class: 'primary', type: 'submit' }, 'Create event');
  let widgetId = null;

  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    const startAt = londonLocalToUtcIso(when.value);
    if (!startAt) { err.textContent = 'Pick a date and time.'; return; }
    submit.disabled = true;
    try {
      const { code } = await api('/api/events', { method: 'POST', body: {
        title: title.value,
        eventType: type.value,
        startAt,
        tags: tagBoxes.filter((t) => t.box.checked).map((t) => t.v),
        turnstileToken: widgetId == null ? '' : window.turnstile.getResponse(widgetId),
      } });
      navigate(`/e/${code}`);
    } catch (ex) {
      err.textContent = ex.message;
      if (widgetId != null) window.turnstile.reset(widgetId);
    } finally {
      submit.disabled = false;
    }
  } },
    h('label', { class: 'field' }, 'What are you planning?', title),
    h('label', { class: 'field' }, 'Type', type),
    h('label', { class: 'field' }, h('span', {}, 'When '), h('span', { class: 'hint' }, '(London time)'), when),
    h('div', { class: 'checks' }, tagBoxes.map((t) => h('label', {}, t.box, t.l))),
    h('div', { class: 'row', style: 'margin-top:.75rem' }, turnstileBox),
    err, h('div', { class: 'row' }, submit));

  const list = events.length
    ? h('ul', { class: 'plain' }, events.map((ev) => h('li', {},
        h('div', {}, link(ev.title, `/e/${ev.code}`),
          h('div', { class: 'muted small' }, `${TYPE_LABELS[ev.eventType] || ev.eventType} · ${formatLondon(ev.startAt)} · ${ev.participantCount} ${ev.participantCount === 1 ? 'person' : 'people'}`)),
        ev.isOwner && h('span', { class: 'chip' }, 'Organiser'))))
    : h('p', { class: 'muted' }, 'Nothing yet. Create your first event above.');

  return {
    el: h('div', {},
      h('section', { class: 'card' }, h('h2', {}, 'Plan something'), form),
      h('section', { class: 'card' }, h('h2', {}, 'Your events'), list),
      h('section', { class: 'card' }, h('h2', {}, 'Your data'),
        h('p', { class: 'muted small' }, 'We keep your Google name, the events you are in and the neighbourhoods you picked. Never your address or exact location. ',
          h('a', { href: '/privacy.html' }, 'Privacy details')),
        h('button', { class: 'danger', type: 'button', onclick: async () => {
          if (!confirm('Delete your account and everything you organised? Your place in other people\'s events goes too. This cannot be undone.')) return;
          try {
            await api('/api/me', { method: 'DELETE' });
            state.user = null;
            navigate('/');
          } catch (e) { alert(e.message); }
        } }, 'Delete my data'))),
    mount: () => whenReady(() => window.turnstile, () => {
      widgetId = window.turnstile.render(turnstileBox, { sitekey: state.config.turnstileSiteKey });
    }),
  };
}

async function eventView(code) {
  let data = await api(`/api/events/${code}`);
  const ev = () => data.event;

  const status = h('span', { class: 'chip' });
  const partsBox = h('div', {});
  const ownerBox = h('div', {});

  // Organiser only: add (or edit) a friend who won't sign in. The server enforces all of it again.
  const guests = data.me && data.me.isOwner ? guestForm({
    areas: state.areas,
    onSubmit: async (g) => {
      await api(g.id ? `/api/events/${code}/guests/${g.id}` : `/api/events/${code}/guests`, {
        method: g.id ? 'PUT' : 'POST',
        body: { name: g.name, areaId: g.areaId, mode: g.mode, maxMinutes: g.maxMinutes },
      });
      await refresh();
    },
  }) : null;
  const guestCard = guests && h('section', { class: 'card', hidden: data.event.status !== 'open' },
    h('h2', {}, 'Add someone'),
    h('p', { class: 'muted small' }, "For a friend who won't sign in. Tell us where they are travelling from and how, and we plan for them too."),
    guests.el);
  const resultsBox = h('div', {});
  const resultsCard = h('section', { class: 'card' }, h('h2', {}, 'Suggested spots'), resultsBox);
  const wasOpen = data.event.status === 'open';

  function paintHeaderBits() {
    status.textContent = ev().status === 'closed' ? 'Locked' : ev().status === 'open' ? '' : ev().status;
    status.hidden = !status.textContent;
  }

  async function refresh() {
    try {
      data = await api(`/api/events/${code}`);
      if ((data.event.status === 'open') !== wasOpen) { render(); return; } // the form's locked state changed
      paintHeaderBits();
      paintParticipants();
      paintOwner();
      paintResults();
    } catch (e) {
      if (e.status === 401) { state.user = null; render(); }
    }
  }

  function paintParticipants() {
    if (!data.me) { partsBox.replaceChildren(); return; }
    const owner = data.me.isOwner;
    partsBox.replaceChildren(h('ul', { class: 'plain' }, data.participants.map((p) => h('li', {},
      h('div', {},
        h('strong', {}, p.name), p.isMe && ' (you)',
        p.isOwner && h('span', { class: 'chip', style: 'margin-left:.4rem' }, 'Organiser'),
        p.isGuest && h('span', { class: 'chip', style: 'margin-left:.4rem' }, owner ? 'Added by you' : 'Added by organiser'),
        h('div', { class: 'muted small' }, p.hasLocation ? `${p.areaName || 'Unknown area'} · ${MODE_LABELS[p.mode] || p.mode}` : "Hasn't said where yet")),
      owner && !p.isOwner && h('div', { class: 'row' },
        p.isGuest && guests && h('button', { type: 'button', onclick: () => guests.edit({ id: p.id, name: p.name, areaId: p.areaId, mode: p.mode, maxMinutes: p.maxMinutes ?? null }) }, 'Edit'),
        h('button', { class: 'danger', type: 'button', onclick: async () => {
          if (!confirm(`Remove ${p.name} from this event?`)) return;
          try { await api(`/api/events/${code}/participants/${p.id}`, { method: 'DELETE' }); } catch (e) { alert(e.message); }
          refresh();
        } }, 'Remove'))))));
  }

  function findButton() {
    const c = data.calculation;
    const running = ev().status === 'calculating';
    const startable = (ev().status === 'open' || ev().status === 'closed') && c.locatedCount >= c.minLocated && c.runsUsed < c.runsMax;
    const label = running ? 'Working it out…' : data.run ? 'Find again' : 'Find a spot';
    return h('button', { class: 'primary', type: 'button', disabled: !startable, onclick: async () => {
      try { await api(`/api/events/${code}/calculate`, { method: 'POST' }); } catch (e) { alert(e.message); }
      refresh();
    } }, label);
  }

  function paintResults() {
    resultsCard.hidden = !data.me || !data.run;
    if (resultsCard.hidden) return;
    const run = data.run;
    if (run.status === 'running') {
      resultsBox.replaceChildren(h('p', {}, 'Working out the fairest places… this takes a few seconds.'));
    } else if (run.status === 'expired') {
      resultsBox.replaceChildren(h('p', {}, data.me.isOwner ? 'These suggestions have expired. Press "Find again" to work them out afresh.' : 'These suggestions have expired. The organiser can work them out again.'));
    } else if (run.status === 'failed') {
      resultsBox.replaceChildren(h('p', { class: 'error' }, run.error));
    } else {
      resultsBox.replaceChildren(...renderResults(data.results, { isOwner: data.me.isOwner }));
    }
  }

  function paintOwner() {
    if (!data.me) { ownerBox.replaceChildren(); return; }
    const located = data.participants.filter((p) => p.hasLocation).length;
    const locked = ev().status === 'closed';
    if (data.me.isOwner) {
      ownerBox.replaceChildren(
        h('p', { class: 'muted small' }, `${located} of ${data.participants.length} have said where they are travelling from.` + (located < data.calculation.minLocated ? ' At least two are needed to find a spot.' : '') + ` Calculations used: ${data.calculation.runsUsed} of ${data.calculation.runsMax}.`),
        h('div', { class: 'row' },
          findButton(),
          h('button', { type: 'button', disabled: ev().status !== 'open' && !locked, onclick: async () => {
            try { await api(`/api/events/${code}/lock`, { method: 'POST', body: { locked: !locked } }); } catch (e) { alert(e.message); }
            refresh();
          } }, locked ? 'Unlock' : 'Lock event'),
          h('button', { class: 'danger', type: 'button', onclick: async () => {
            if (!confirm('Delete this event for everyone?')) return;
            try { await api(`/api/events/${code}`, { method: 'DELETE' }); navigate('/'); } catch (e) { alert(e.message); }
          } }, 'Delete event')));
    } else {
      ownerBox.replaceChildren(h('button', { class: 'danger', type: 'button', onclick: async () => {
        if (!confirm('Leave this event?')) return;
        try { await api(`/api/events/${code}/me`, { method: 'DELETE' }); render(); } catch (e) { alert(e.message); }
      } }, 'Leave event'));
    }
  }

  paintHeaderBits();
  paintParticipants();
  paintOwner();
  paintResults();

  const e0 = ev();
  const top = h('section', { class: 'card' },
    h('h1', {}, e0.title),
    h('p', { class: 'muted' }, `${TYPE_LABELS[e0.eventType] || e0.eventType} · ${formatLondon(e0.startAt)} · organised by ${e0.ownerName}`),
    h('div', {}, e0.tags.map((t) => h('span', { class: 'chip' }, TAG_LABELS[t] || t)), status));

  // Not joined yet: just the invitation.
  if (!data.me) {
    const err = h('p', { class: 'error', role: 'alert' });
    const open = e0.status === 'open';
    const join = h('button', { class: 'primary', type: 'button', disabled: !open, onclick: async () => {
      try { await api(`/api/events/${code}/join`, { method: 'POST' }); render(); } catch (e) { err.textContent = e.message; }
    } }, 'Join this event');
    return { el: h('div', {}, top, h('section', { class: 'card' },
      h('p', {}, `${e0.participantCount} of ${e0.maxParticipants} places taken.`),
      open ? join : h('p', { class: 'muted' }, 'This event is not accepting new people.'), err)) };
  }

  // Joined: share link, my journey, who's in.
  const url = `${location.origin}/e/${code}`;
  const shareInput = h('input', { type: 'url', readonly: true, value: url, 'aria-label': 'Share link' });
  const copy = h('button', { type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(url); } catch { shareInput.select(); document.execCommand('copy'); }
    copy.textContent = 'Copied';
    setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
  } }, 'Copy');
  const shareCard = h('section', { class: 'card' },
    h('h2', {}, 'Invite friends'),
    h('p', { class: 'muted small' }, 'Anyone with this link can join (they sign in with Google first).'),
    h('div', { class: 'share' }, shareInput, copy,
      navigator.share && h('button', { type: 'button', onclick: () => navigator.share({ title: e0.title, url }).catch(() => {}) }, 'Share')));

  const picker = areaPicker({ areas: state.areas, initialAreaId: data.me.areaId });
  const mode = h('select', {}, Object.entries(MODE_LABELS).map(([v, l]) => h('option', { value: v, selected: v === data.me.mode }, l)));
  const maxMin = h('input', { type: 'number', min: 10, max: 180, step: 5, inputmode: 'numeric', placeholder: 'No limit', value: data.me.maxMinutes ?? '' });
  const saveMsg = h('p', { class: 'error', role: 'status' });
  const save = h('button', { class: 'primary', type: 'submit' }, 'Save');
  const form = h('form', { onsubmit: async (ev2) => {
    ev2.preventDefault();
    saveMsg.className = 'error';
    saveMsg.textContent = '';
    const area = picker.getArea();
    if (!area) { saveMsg.textContent = 'Choose where you are travelling from.'; return; }
    save.disabled = true;
    try {
      await api(`/api/events/${code}/me`, { method: 'PUT', body: {
        areaId: area.id,
        mode: mode.value,
        maxMinutes: maxMin.value === '' ? null : Number(maxMin.value),
      } });
      saveMsg.className = 'ok';
      saveMsg.textContent = 'Saved';
      refresh();
    } catch (ex) {
      saveMsg.textContent = ex.message;
    } finally {
      save.disabled = false;
    }
  } },
    h('label', { class: 'field' }, 'Where are you travelling from?'), picker.el,
    h('label', { class: 'field' }, 'How will you get there?', mode),
    h('label', { class: 'field' }, h('span', {}, 'Longest journey you would accept '), h('span', { class: 'hint' }, '(minutes, optional)'), maxMin),
    saveMsg, h('div', { class: 'row' }, save));
  const locked = e0.status !== 'open';
  const journey = h('section', { class: 'card' }, h('h2', {}, 'Your journey'),
    locked ? h('p', { class: 'muted' }, 'This event is locked, so locations can not be changed.') : form);

  return {
    el: h('div', {}, top, resultsCard, shareCard, journey,
      h('section', { class: 'card' }, h('h2', {}, "Who's in"), partsBox, ownerBox), guestCard),
    // Keep the "who's in" list fresh while the tab is open, without touching the form.
    mount: () => {
      const mine = state.renderToken;
      const delay = () => (data.run && data.run.status === 'running' ? 2000 : POLL_MS);
      const tick = async () => {
        if (state.renderToken !== mine) return;
        if (document.visibilityState === 'visible') await refresh();
        if (state.renderToken === mine) state.pollTimer = setTimeout(tick, delay());
      };
      state.pollTimer = setTimeout(tick, delay());
    },
  };
}

// ---------- router ----------

async function render() {
  clearTimeout(state.pollTimer);
  const token = ++state.renderToken;
  let view;
  try {
    if (!state.user) {
      view = signedOutView();
    } else {
      const m = location.pathname.match(/^\/e\/([a-z2-7]{10})\/?$/);
      if (location.pathname === '/') view = await homeView();
      else if (m) view = await eventView(m[1]);
      else view = messageView('That page does not exist.');
    }
  } catch (e) {
    if (e.status === 401) { state.user = null; view = signedOutView(); }
    else view = messageView(e.message || 'Something went wrong.');
  }
  if (token !== state.renderToken) return; // a newer render has taken over
  app.replaceChildren(header(), h('main', {}, view.el));
  window.scrollTo(0, 0);
  if (view.mount) view.mount();
}

window.addEventListener('popstate', render);

(async function init() {
  try {
    const [config, areas, me] = await Promise.all([api('/api/config'), loadAreas(), api('/api/me')]);
    state.config = config;
    state.areas = areas;
    state.user = me.user;
  } catch {
    app.replaceChildren(h('main', {}, messageView('Could not load. Please refresh.').el));
    return;
  }
  render();
})();
