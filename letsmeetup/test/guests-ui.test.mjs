import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const areas = JSON.parse(readFileSync(new URL('../public/areas.json', import.meta.url), 'utf8'));
let dom, mod;

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.document = dom.window.document;
  mod = await import('../public/guests.js');
});

const tick = () => new Promise((r) => setTimeout(r, 0));

function make(onSubmit = async () => {}) {
  const calls = [];
  const form = mod.guestForm({ areas, onSubmit: async (g) => { calls.push(g); return onSubmit(g); } });
  document.body.replaceChildren(form.el);
  const el = form.el;
  const nameInput = el.querySelector('input[type=text]');
  const areaInput = el.querySelector('input[type=search]');
  const mode = el.querySelector('select');
  const maxMin = el.querySelector('input[type=number]');
  const message = () => el.querySelector('p.error').textContent;
  const picked = () => el.querySelector('.picked').textContent;
  const submitBtn = el.querySelector('button[type=submit]');
  const cancelBtn = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Cancel');
  const typeArea = (text) => { areaInput.value = text; areaInput.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const pickArea = (text) => { typeArea(text); el.querySelector('ul.picks button').click(); };
  const submit = async () => { el.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); await tick(); await tick(); };
  return { form, el, calls, nameInput, areaInput, mode, maxMin, message, picked, submitBtn, cancelBtn, typeArea, pickArea, submit };
}

test('it asks for a name, then a place, and explains what is missing', async () => {
  const t = make();
  await t.submit();
  assert.equal(t.message(), mod.GUEST_MESSAGES.nameNeeded);
  t.nameInput.value = '   ';
  await t.submit();
  assert.equal(t.message(), mod.GUEST_MESSAGES.nameNeeded);
  t.nameInput.value = 'Maeve';
  await t.submit();
  assert.equal(t.message(), mod.GUEST_MESSAGES.areaNeeded);
  assert.equal(t.calls.length, 0); // nothing was sent
});

test('an email address is not accepted as a name', async () => {
  const t = make();
  t.nameInput.value = 'maeve@example.com';
  t.pickArea('Peckham');
  await t.submit();
  assert.equal(t.message(), mod.GUEST_MESSAGES.nameEmail);
  assert.equal(t.calls.length, 0);
});

test('a complete form sends only what the server takes: name, area id, mode and limit, never coordinates', async () => {
  const t = make();
  t.nameInput.value = '  Maeve ';
  t.pickArea('Peckham');
  t.mode.value = 'bike';
  t.maxMin.value = '40';
  await t.submit();
  assert.deepEqual(t.calls, [{ id: null, name: 'Maeve', areaId: 'peckham', mode: 'bike', maxMinutes: 40 }]);
  assert.doesNotMatch(JSON.stringify(t.calls), /lat|lng|longitude|latitude/i);
});

test('an empty limit is sent as no limit', async () => {
  const t = make();
  t.nameInput.value = 'Maeve';
  t.pickArea('Soho');
  await t.submit();
  assert.equal(t.calls[0].maxMinutes, null);
  assert.equal(t.calls[0].mode, 'transit'); // the default
});

test('after adding someone the form clears, ready for the next person', async () => {
  const t = make();
  t.nameInput.value = 'Maeve';
  t.pickArea('Peckham');
  t.mode.value = 'walk';
  t.maxMin.value = '20';
  await t.submit();
  assert.equal(t.nameInput.value, '');
  assert.equal(t.mode.value, 'transit');
  assert.equal(t.maxMin.value, '');
  assert.equal(t.picked(), '');
  assert.equal(t.message(), '');
  assert.equal(t.submitBtn.textContent, 'Add');
  // and the cleared form really is empty: no stale area carried over
  t.nameInput.value = 'Cathal';
  await t.submit();
  assert.equal(t.message(), mod.GUEST_MESSAGES.areaNeeded);
});

test('a refusal from the server is shown and the form keeps what was typed', async () => {
  const t = make(async () => { throw new Error('This event is full'); });
  t.nameInput.value = 'Maeve';
  t.pickArea('Peckham');
  await t.submit();
  assert.equal(t.message(), 'This event is full');
  assert.equal(t.nameInput.value, 'Maeve');
  assert.equal(t.picked(), 'Travelling from Peckham');
  assert.equal(t.submitBtn.disabled, false); // can try again
});

test('editing loads the guest, sends their id, and Cancel puts the form back', async () => {
  const t = make();
  t.form.edit({ id: 'g-1', name: 'Maeve', areaId: 'brixton', mode: 'walk', maxMinutes: 25 });
  assert.equal(t.nameInput.value, 'Maeve');
  assert.equal(t.picked(), 'Travelling from Brixton');
  assert.equal(t.mode.value, 'walk');
  assert.equal(t.maxMin.value, '25');
  assert.equal(t.submitBtn.textContent, 'Save changes');
  assert.equal(t.cancelBtn.hidden, false);

  t.nameInput.value = 'Maeve O';
  await t.submit();
  assert.deepEqual(t.calls, [{ id: 'g-1', name: 'Maeve O', areaId: 'brixton', mode: 'walk', maxMinutes: 25 }]);
  assert.equal(t.submitBtn.textContent, 'Add'); // back to adding after saving

  t.form.edit({ id: 'g-2', name: 'Cathal', areaId: 'soho', mode: 'transit', maxMinutes: null });
  assert.equal(t.maxMin.value, '');
  t.cancelBtn.click();
  assert.equal(t.nameInput.value, '');
  assert.equal(t.submitBtn.textContent, 'Add');
  assert.equal(t.cancelBtn.hidden, true);
  await t.submit();
  assert.equal(t.message(), mod.GUEST_MESSAGES.nameNeeded);
  assert.equal(t.calls.length, 1); // Cancel sent nothing
});

test('the name box is length limited and hostile text is only ever a value', async () => {
  const t = make();
  assert.equal(t.nameInput.getAttribute('maxlength'), String(mod.NAME_MAX));
  const evil = '<img src=x onerror=alert(1)>';
  t.nameInput.value = evil;
  t.pickArea('Peckham');
  await t.submit();
  assert.equal(t.calls[0].name, evil); // the server and the display code deal with it as text
  assert.equal(document.querySelectorAll('img').length, 0);
});

test('the location picker inside is the real one, with its London-only messages', () => {
  const t = make();
  t.typeArea('Dublin');
  assert.match(t.picked(), /No match/);
  t.typeArea('Soho');
  assert.equal(t.el.querySelectorAll('ul.picks button').length, 1);
});
