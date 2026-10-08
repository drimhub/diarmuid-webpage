// The organiser's "Add someone" form: a friend who won't sign in. The organiser says what they would
// say for themselves (name, where from, how, optional longest journey). The same form edits an
// existing guest. Only an area id is ever sent, never coordinates; text is shown via textContent.

import { areaPicker } from './picker.js';
import { MODE_LABELS, h } from './view.js';

export const NAME_MAX = 30;

export const GUEST_MESSAGES = {
  nameNeeded: 'Enter their name.',
  nameEmail: 'Use a first name, not an email address.',
  areaNeeded: 'Choose where they are travelling from.',
};

// onSubmit({ id|null, name, areaId, mode, maxMinutes|null }) may reject with an Error whose message is shown.
export function guestForm({ areas, onSubmit }) {
  let editingId = null;
  let picker;

  const name = h('input', { type: 'text', maxlength: NAME_MAX, placeholder: 'e.g. Maeve', autocomplete: 'off', 'aria-label': 'Their name' });
  const pickerBox = h('div', {});
  const mode = h('select', { 'aria-label': 'How they will get there' }, Object.entries(MODE_LABELS).map(([v, l]) => h('option', { value: v }, l)));
  const maxMin = h('input', { type: 'number', min: 10, max: 180, step: 5, inputmode: 'numeric', placeholder: 'No limit', 'aria-label': 'Longest journey in minutes' });
  const msg = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { class: 'primary', type: 'submit' }, 'Add');
  const cancel = h('button', { type: 'button', hidden: true, onclick: () => reset() }, 'Cancel');

  function setPicker(areaId) {
    picker = areaPicker({ areas, initialAreaId: areaId });
    pickerBox.replaceChildren(picker.el);
  }

  function reset() {
    editingId = null;
    name.value = '';
    mode.value = 'transit';
    maxMin.value = '';
    msg.textContent = '';
    submit.textContent = 'Add';
    cancel.hidden = true;
    setPicker(null);
  }

  // Load an existing guest into the form: { id, name, areaId, mode, maxMinutes }.
  function edit(guest) {
    editingId = guest.id;
    name.value = guest.name;
    mode.value = guest.mode;
    maxMin.value = guest.maxMinutes ?? '';
    msg.textContent = '';
    submit.textContent = 'Save changes';
    cancel.hidden = false;
    setPicker(guest.areaId);
    if (typeof name.scrollIntoView === 'function') name.scrollIntoView({ block: 'center' });
    name.focus();
  }

  async function handle(e) {
    e.preventDefault();
    msg.textContent = '';
    const text = name.value.trim();
    if (!text) { msg.textContent = GUEST_MESSAGES.nameNeeded; return; }
    if (text.includes('@')) { msg.textContent = GUEST_MESSAGES.nameEmail; return; }
    const area = picker.getArea();
    if (!area) { msg.textContent = GUEST_MESSAGES.areaNeeded; return; }

    submit.disabled = true;
    try {
      await onSubmit({
        id: editingId,
        name: text,
        areaId: area.id,
        mode: mode.value,
        maxMinutes: maxMin.value === '' ? null : Number(maxMin.value),
      });
      reset();
    } catch (err) {
      msg.textContent = err && err.message ? err.message : 'Could not save. Please try again.';
    } finally {
      submit.disabled = false;
    }
  }

  const form = h('form', { onsubmit: handle },
    h('label', { class: 'field' }, 'Their name', name),
    h('label', { class: 'field' }, 'Where are they travelling from?'), pickerBox,
    h('label', { class: 'field' }, 'How will they get there?', mode),
    h('label', { class: 'field' }, h('span', {}, 'Longest journey they would accept '), h('span', { class: 'hint' }, '(minutes, optional)'), maxMin),
    msg,
    h('div', { class: 'row' }, submit, cancel));

  reset();
  return { el: form, edit, reset };
}
