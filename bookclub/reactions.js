// Emoji reactions for the bookclub page.
//
// Any element with a data-react-id="kind:id" attribute gets a reaction bar
// (pills, an add button and a "who?" link). New features only need to add that
// attribute; a MutationObserver keeps bars in sync when the page re-renders.
//
// Firestore: one doc per (target, member, reaction) in `bookclub_reactions`, with
// id `${targetId}__${memberId}__${reaction}`. Clicking a reaction you already made
// deletes the doc. See firestore.rules for the validation.
(function () {
  'use strict';

  const COLLECTION = 'bookclub_reactions';
  const ID_SEP = '__';

  // Stored in Firestore as the key; the glyph is display-only.
  const REACTIONS = {
    thumbsup: '👍',
    heart: '❤️',
    laugh: '😂',
    fire: '🔥',
    book: '📚',
    wow: '😮',
    sad: '😢',
    party: '🎉',
    robot: '🤖',
  };
  const REACTION_ORDER = Object.keys(REACTIONS);
  const MEMBER_KEYS = ['thumbsup', 'heart', 'laugh', 'fire', 'book', 'wow', 'sad', 'party'];
  const MODERATOR_KEYS = ['robot'];

  let ctx = null;
  const byTarget = new Map(); // targetId -> [{ id, memberId, name, reaction, createdAt }]
  const paintedSignature = new WeakMap(); // bar element -> last painted signature
  let picker = null; // { el, button }
  let who = null; // { targetId, filter }
  let whoModal = null;

  const CSS = `
    .bc-reactions { display: block; margin-top: 4px; font-size: 14px; font-weight: normal; color: #000; }
    .bc-reactions button { font: inherit; cursor: pointer; }
    .bc-pill, .bc-add { display: inline-block; margin: 0 4px 4px 0; padding: 1px 8px; border: 1px solid #999; border-radius: 12px; background: #f2f2f2; color: #000; }
    .bc-pill.bc-mine { background: #cfe8ff; border-color: #4a90d9; }
    .bc-pill.bc-locked { cursor: default; }
    .bc-who-link { margin-left: 4px; padding: 0; border: none; background: none; color: inherit; text-decoration: underline; font-size: 12px; }
    .bc-picker { position: fixed; z-index: 1100; display: flex; gap: 4px; padding: 6px; background: #fff; border: 1px solid #999; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
    .bc-picker button { padding: 2px 6px; font-size: 20px; border: none; border-radius: 6px; background: none; cursor: pointer; }
    .bc-picker button:hover { background: #eee; }
    .bc-who-overlay { position: fixed; inset: 0; z-index: 1050; background: rgba(0,0,0,0.6); }
    .bc-who-box { max-width: 340px; max-height: 70vh; overflow-y: auto; margin: 60px auto; padding: 16px; background: #fff; color: #000; }
    .bc-who-tabs button { margin: 0 4px 6px 0; padding: 1px 8px; border: 1px solid #999; border-radius: 12px; background: #f2f2f2; cursor: pointer; }
    .bc-who-tabs button.bc-active { background: #cfe8ff; border-color: #4a90d9; }
    .bc-who-row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
    .bc-who-row .bc-who-avatar { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; background: #ccc; flex: none; }
    .bc-who-row .bc-who-text { flex: 1; min-width: 0; }
    .bc-who-row small { display: block; color: #666; }
    .bc-who-row .bc-who-emoji { font-size: 20px; }
  `;

  function allowedKeys(identity) {
    if (!identity) return [];
    return ctx.isModerator(identity.name) ? MODERATOR_KEYS : MEMBER_KEYS;
  }

  function reactionsFor(targetId) {
    return byTarget.get(targetId) || [];
  }

  // ---- writes ----------------------------------------------------------

  async function toggle(targetId, key) {
    const me = ctx.getIdentity();
    if (!me) { ctx.onLoginRequired(); return; }
    if (!allowedKeys(me).includes(key)) return;

    const id = [targetId, me.id, key].join(ID_SEP);
    const ref = ctx.db.collection(COLLECTION).doc(id);
    const isMine = reactionsFor(targetId).some((r) => r.id === id);
    try {
      if (isMine) {
        await ref.delete();
      } else {
        await ref.set({
          targetId,
          targetKind: targetId.split(':')[0],
          memberId: me.id,
          name: me.name,
          reaction: key,
          createdAt: ctx.firebase.firestore.FieldValue.serverTimestamp(),
        });
      }
    } catch (e) {
      console.error('Reaction failed', e);
    }
  }

  // ---- reaction bar ----------------------------------------------------

  function signatureFor(targetId, me) {
    const list = reactionsFor(targetId).map((r) => r.id).sort().join(',');
    return `${targetId}|${me ? me.id + ':' + me.name : ''}|${list}`;
  }

  function buildBar(bar, targetId, me) {
    bar.textContent = '';
    const list = reactionsFor(targetId);
    const allowed = allowedKeys(me);

    REACTION_ORDER.forEach((key) => {
      const entries = list.filter((r) => r.reaction === key);
      if (entries.length === 0) return;
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'bc-pill';
      if (me && entries.some((r) => r.memberId === me.id)) pill.classList.add('bc-mine');
      if (me && !allowed.includes(key)) pill.classList.add('bc-locked');
      pill.dataset.key = key;
      pill.title = entries.map((r) => r.name).join(', ');
      pill.textContent = `${REACTIONS[key]} ${entries.length}`;
      bar.appendChild(pill);
    });

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'bc-add';
    add.textContent = '＋';
    add.title = 'Add a reaction';
    bar.appendChild(add);

    if (list.length > 0) {
      const whoLink = document.createElement('button');
      whoLink.type = 'button';
      whoLink.className = 'bc-who-link';
      whoLink.textContent = 'who?';
      bar.appendChild(whoLink);
    }
  }

  function paint(el) {
    const targetId = el.dataset.reactId;
    const me = ctx.getIdentity();
    let bar = el.querySelector(':scope > .bc-reactions');
    if (!bar) {
      bar = document.createElement('span');
      bar.className = 'bc-reactions';
      el.appendChild(bar);
    }
    const signature = signatureFor(targetId, me);
    if (paintedSignature.get(bar) === signature) return;
    paintedSignature.set(bar, signature);
    bar.dataset.targetId = targetId;
    buildBar(bar, targetId, me);
  }

  // Idempotent: only touches the DOM when a bar is missing or stale, so the
  // observer that calls it settles after one extra pass.
  function scan() {
    document.querySelectorAll('[data-react-id]').forEach(paint);
    document.querySelectorAll('.bc-reactions').forEach((bar) => {
      if (!bar.parentElement || !bar.parentElement.hasAttribute('data-react-id')) bar.remove();
    });
  }

  // ---- picker ----------------------------------------------------------

  function closePicker() {
    if (picker) { picker.el.remove(); picker = null; }
  }

  function openPicker(button, targetId) {
    const me = ctx.getIdentity();
    if (!me) { ctx.onLoginRequired(); return; }
    closePicker();

    const el = document.createElement('div');
    el.className = 'bc-picker';
    allowedKeys(me).forEach((key) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = REACTIONS[key];
      b.title = key;
      b.addEventListener('click', () => {
        closePicker();
        toggle(targetId, key);
      });
      el.appendChild(b);
    });
    document.body.appendChild(el);

    const rect = button.getBoundingClientRect();
    const width = el.offsetWidth;
    el.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - width - 4))}px`;
    const below = rect.bottom + 4;
    el.style.top = `${below + el.offsetHeight > window.innerHeight ? Math.max(4, rect.top - el.offsetHeight - 4) : below}px`;
    picker = { el, button };
  }

  // ---- "who reacted" modal ---------------------------------------------

  function ensureWhoModal() {
    if (whoModal) return whoModal;
    const overlay = document.createElement('div');
    overlay.className = 'bc-who-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = '<div class="bc-who-box"><h3 style="margin-top:0;">Reactions</h3><div class="bc-who-tabs"></div><div class="bc-who-list"></div><p style="text-align:center;"><button type="button" class="bc-who-close">Close</button></p></div>';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.classList.contains('bc-who-close')) closeWho();
    });
    document.body.appendChild(overlay);
    whoModal = overlay;
    return overlay;
  }

  function openWho(targetId) {
    who = { targetId, filter: 'all' };
    ensureWhoModal().style.display = 'block';
    renderWho();
  }

  function closeWho() {
    who = null;
    if (whoModal) whoModal.style.display = 'none';
  }

  function renderWho() {
    if (!who || !whoModal) return;
    const all = reactionsFor(who.targetId).slice().sort((a, b) => b.createdAt - a.createdAt);
    const present = REACTION_ORDER.filter((key) => all.some((r) => r.reaction === key));
    if (who.filter !== 'all' && !present.includes(who.filter)) who.filter = 'all';

    const tabs = whoModal.querySelector('.bc-who-tabs');
    tabs.textContent = '';
    ['all', ...present].forEach((key) => {
      const b = document.createElement('button');
      b.type = 'button';
      if (key === who.filter) b.className = 'bc-active';
      b.textContent = key === 'all' ? `All ${all.length}` : `${REACTIONS[key]} ${all.filter((r) => r.reaction === key).length}`;
      b.addEventListener('click', () => { who.filter = key; renderWho(); });
      tabs.appendChild(b);
    });

    const listEl = whoModal.querySelector('.bc-who-list');
    listEl.textContent = '';
    const shown = who.filter === 'all' ? all : all.filter((r) => r.reaction === who.filter);
    if (shown.length === 0) {
      const p = document.createElement('p');
      p.textContent = 'No reactions yet.';
      listEl.appendChild(p);
      return;
    }

    const members = ctx.getMembers();
    shown.forEach((r) => {
      const member = members[r.memberId];
      const row = document.createElement('div');
      row.className = 'bc-who-row';

      const avatar = document.createElement(member && member.avatar ? 'img' : 'span');
      avatar.className = 'bc-who-avatar';
      if (member && member.avatar) { avatar.src = member.avatar; avatar.alt = ''; }
      row.appendChild(avatar);

      const text = document.createElement('div');
      text.className = 'bc-who-text';
      const name = document.createElement('strong');
      name.textContent = r.name;
      const time = document.createElement('small');
      time.textContent = r.createdAt.toLocaleString();
      text.append(name, time);
      row.appendChild(text);

      const emoji = document.createElement('span');
      emoji.className = 'bc-who-emoji';
      emoji.textContent = REACTIONS[r.reaction];
      row.appendChild(emoji);

      listEl.appendChild(row);
    });
  }

  // ---- wiring ----------------------------------------------------------

  function onDocumentClick(e) {
    if (picker && !picker.el.contains(e.target) && e.target !== picker.button) closePicker();

    const bar = e.target.closest('.bc-reactions');
    if (!bar) return;
    const targetId = bar.dataset.targetId;
    if (e.target.closest('.bc-pill')) toggle(targetId, e.target.closest('.bc-pill').dataset.key);
    else if (e.target.closest('.bc-add')) openPicker(e.target.closest('.bc-add'), targetId);
    else if (e.target.closest('.bc-who-link')) openWho(targetId);
  }

  function init(options) {
    ctx = options;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      closePicker();
      closeWho();
    });
    new MutationObserver(scan).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-react-id'],
    });

    ctx.db.collection(COLLECTION).onSnapshot((snapshot) => {
      byTarget.clear();
      snapshot.docs.forEach((doc) => {
        const d = doc.data({ serverTimestamps: 'estimate' });
        if (!byTarget.has(d.targetId)) byTarget.set(d.targetId, []);
        byTarget.get(d.targetId).push({
          id: doc.id,
          memberId: d.memberId,
          name: d.name,
          reaction: d.reaction,
          createdAt: d.createdAt ? d.createdAt.toDate() : new Date(),
        });
      });
      scan();
      renderWho();
    }, (err) => console.error('Reactions listener failed', err));

    scan();
  }

  // Repaint bars after login/logout, and refresh the modal (member avatars may have loaded).
  function refresh() {
    if (!ctx) return;
    scan();
    renderWho();
  }

  window.BookclubReactions = { init, refresh };
})();
