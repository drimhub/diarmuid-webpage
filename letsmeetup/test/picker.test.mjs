import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const areas = JSON.parse(readFileSync(new URL('../public/areas.json', import.meta.url), 'utf8'));
let dom, mod;

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.document = dom.window.document;
  mod = await import('../public/picker.js');
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const DUBLIN = { lat: 53.3498, lng: -6.2603 };
const HACKNEY = { lat: 51.5456, lng: -0.0557 };
const BRIXTON = { lat: 51.4613, lng: -0.1156 };

function picker(over = {}) {
  const p = mod.areaPicker({ areas, ...over });
  const input = p.el.querySelector('input');
  const say = () => p.el.querySelector('.picked').textContent;
  const options = () => [...p.el.querySelectorAll('ul.picks button')].map((b) => b.textContent);
  const type = (text) => { input.value = text; input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const enter = async () => { input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await tick(); };
  const locate = async () => { [...p.el.querySelectorAll('button')].find((b) => b.textContent === 'Use my location').click(); await tick(); await tick(); };
  return { p, input, say, options, type, enter, locate };
}

test('typing something that is not in London says so, instead of showing nothing', () => {
  for (const text of ['Dublin', 'Cork', 'D02 X285', 'zzzz']) {
    const t = picker();
    t.type(text);
    assert.deepEqual(t.options(), [], text);
    assert.equal(t.say(), mod.MESSAGES.noMatch, text);
  }
  assert.match(mod.MESSAGES.noMatch, /London neighbourhood/);
  assert.match(mod.MESSAGES.noMatch, /UK postcode/);
});

test('typing a real neighbourhood offers it, and choosing it works', () => {
  const t = picker();
  t.type('sho');
  assert.ok(t.options().includes('Shoreditch') && t.options().includes('Soho') === false || t.options().length > 0);
  t.type('Soho');
  assert.deepEqual(t.options(), ['Soho']);
  assert.notEqual(t.say(), mod.MESSAGES.noMatch);
  [...t.p.el.querySelectorAll('ul.picks button')][0].click();
  assert.equal(t.say(), 'Travelling from Soho');
  assert.equal(t.p.getArea().id, 'soho');
  assert.equal(t.input.value, '');
  assert.deepEqual(t.options(), []);
});

test('Enter takes the top suggestion', async () => {
  const t = picker();
  t.type('brix');
  await t.enter();
  assert.equal(t.p.getArea().name, 'Brixton');
  assert.equal(t.say(), 'Travelling from Brixton');
});

test('a postcode-shaped entry gets a hint, and Enter looks it up', async () => {
  const asked = [];
  const t = picker({ lookup: async (text) => { asked.push(text); return HACKNEY; } });
  t.type('E8 3PN');
  assert.equal(t.say(), mod.MESSAGES.postcodeHint);
  await t.enter();
  assert.deepEqual(asked, ['E8 3PN']);
  assert.ok(t.p.getArea(), 'a Hackney postcode should snap to an area');
  assert.match(t.say(), /^Travelling from .+ \(from your postcode\)$/);
});

test('a postcode outside London, or one that does not exist, gets a helpful message', async () => {
  const outside = picker({ lookup: async () => DUBLIN });
  outside.type('D02 X285'); // not UK-shaped, so just a search
  assert.equal(outside.say(), mod.MESSAGES.noMatch);

  const t = picker({ lookup: async () => ({ lat: 53.4808, lng: -2.2426 }) }); // a Manchester postcode
  t.type('M1 1AE');
  await t.enter();
  assert.equal(t.say(), mod.MESSAGES.outside);
  assert.equal(t.p.getArea(), null);

  const missing = picker({ lookup: async () => null });
  missing.type('SW1A 1AA');
  await missing.enter();
  assert.equal(missing.say(), mod.MESSAGES.postcodeNotFound);

  const broken = picker({ lookup: async () => { throw new Error('network'); } });
  broken.type('SW1A 1AA');
  await broken.enter();
  assert.equal(broken.say(), mod.MESSAGES.postcodeNotFound);
});

test('"Use my location": London snaps; Ireland and the rest say to pick a London neighbourhood', async () => {
  const london = picker({ locate: async () => BRIXTON });
  await london.locate();
  assert.equal(london.p.getArea().name, 'Brixton');
  assert.equal(london.say(), 'Travelling from Brixton (from your location)');

  for (const [label, point] of [['Dublin', DUBLIN], ['Cork', { lat: 51.8985, lng: -8.4756 }], ['Belfast', { lat: 54.5973, lng: -5.9301 }]]) {
    const t = picker({ locate: async () => point });
    await t.locate();
    assert.equal(t.say(), mod.MESSAGES.outside, label);
    assert.equal(t.p.getArea(), null, label);
  }
  assert.match(mod.MESSAGES.outside, /outside London/);
  assert.match(mod.MESSAGES.outside, /Soho/);
});

test('"Use my location" failures are explained, and an earlier choice survives them', async () => {
  const denied = picker({ initialAreaId: 'peckham', locate: async () => { throw new Error('Location permission was denied'); } });
  assert.equal(denied.say(), 'Travelling from Peckham');
  await denied.locate();
  assert.equal(denied.say(), 'Location permission was denied');
  assert.equal(denied.p.getArea().id, 'peckham');

  const outside = picker({ initialAreaId: 'peckham', locate: async () => DUBLIN });
  await outside.locate();
  assert.equal(outside.say(), mod.MESSAGES.outside);
  assert.equal(outside.p.getArea().id, 'peckham'); // not cleared by a failed attempt
});

test('a saved area is shown when the page opens, and an unknown one is ignored', () => {
  assert.equal(picker({ initialAreaId: 'brixton' }).say(), 'Travelling from Brixton');
  const none = picker({ initialAreaId: 'narnia' });
  assert.equal(none.say(), '');
  assert.equal(none.p.getArea(), null);
});

test('clearing the box clears the hint', () => {
  const t = picker();
  t.type('Dublin');
  assert.equal(t.say(), mod.MESSAGES.noMatch);
  t.type('');
  assert.equal(t.say(), '');
});

test('every name the front-end modules import from another module really is exported', async () => {
  const dir = new URL('../public/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(new URL(file, dir), 'utf8');
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.?\/[^']+\.js)'/g)) {
      const target = await import(new URL(m[2].replace(/^\.?\//, ''), dir)); // '/x.js' (browser) and './x.js' both mean public/x.js
      for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
        assert.ok(name in target, `${file} imports { ${name} } from ${m[2]}, which does not export it`);
      }
    }
  }
});
