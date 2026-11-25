import test from 'node:test';
import assert from 'node:assert/strict';
import { newOrder, orderRequirements, orderProblems, parseMenuLine, menuLine } from '../js/order.js';
import { DEFAULT_SETTINGS, withDefaults } from '../js/defaults.js';

const menu = DEFAULT_SETTINGS.menu;
const quote = (extra = {}) => ({ id: 'q1', number: 1005, pizzaCount: 5, starterCount: 4, pizzas: ['מרגריטה', 'לא בתפריט'], ...extra });

test('new order is linked to its quote and keeps quote pizzas that are on the menu', () => {
  const o = newOrder(quote(), menu);
  assert.equal(o.quoteId, 'q1');
  assert.equal(o.number, 1005);
  assert.equal(o.status, 'new');
  assert.deepEqual(o.pizzas, ['מרגריטה']);
});

test('required dish counts come from the quote; fixed dishes are extra and not counted', () => {
  const r = orderRequirements(quote(), menu);
  assert.equal(r.pizzas, 5);
  assert.equal(r.starters, 4);
  assert.deepEqual(r.fixed, { starters: ['פוקאצ׳ה'], desserts: ['קלצונה נוטלה'] });
  // פיצות בלבד: אין ראשונות – גם לא הפוקאצ׳ה הקבועה
  const p = orderRequirements(quote({ starterCount: 0 }), menu);
  assert.equal(p.starters, 0);
  assert.deepEqual(p.fixed.starters, []);
  assert.equal(orderRequirements(quote({ pizzaCount: 99 }), menu).pizzas, menu.pizzas.length + 1);
});

test('new orders start with the fixed dishes, which do not count toward the required number', () => {
  const o = newOrder(quote(), menu);
  assert.deepEqual(o.starters, ['פוקאצ׳ה']);
  assert.deepEqual(o.desserts, ['קלצונה נוטלה']);
  const req = { pizzas: 0, starters: 2, fixed: { starters: ['פוקאצ׳ה'], desserts: [] } };
  assert.equal(orderProblems({ starters: ['פוקאצ׳ה', 'א'] }, req).length, 1);
  assert.equal(orderProblems({ starters: ['פוקאצ׳ה', 'א', 'ב'] }, req).length, 0);
});

test('menu lines keep fixed / hidden / note marks', () => {
  const a = parseMenuLine('מלבי | מלבי שמנת | בתוספת 10 ₪ לאדם');
  assert.deepEqual(a, { name: 'מלבי', desc: 'מלבי שמנת', note: 'בתוספת 10 ₪ לאדם' });
  assert.deepEqual(parseMenuLine('פוקאצ׳ה | לחם | קבוע'), { name: 'פוקאצ׳ה', desc: 'לחם', fixed: true });
  assert.deepEqual(parseMenuLine('פיצה שחיתות | נוטלה | מוסתר'), { name: 'פיצה שחיתות', desc: 'נוטלה', hidden: true });
  assert.deepEqual(parseMenuLine('מרגריטה | עגבניות'), { name: 'מרגריטה', desc: 'עגבניות' });
  for (const x of [...menu.starters, ...menu.desserts]) assert.deepEqual(parseMenuLine(menuLine(x)), x);
});

test('saved settings from before get the fixed / hidden / note marks once', () => {
  const old = { schema: 3, menu: { starters: [{ name: "פוקאצ'ה", desc: 'לחם' }], pizzas: [], desserts: [
    { name: 'קלצונה נוטלה', desc: '' }, { name: 'פיצה שחיתות', desc: '' }, { name: 'מלבי', desc: '' }] } };
  const s = withDefaults(old);
  assert.equal(s.menu.starters[0].fixed, true);
  assert.deepEqual(s.menu.desserts.map((x) => [x.fixed, x.hidden, x.note]), [[true, undefined, undefined], [undefined, true, undefined], [undefined, undefined, 'בתוספת 10 ₪ לאדם']]);
  assert.equal(s.schema, 4);
});

test('an order cannot be saved until all required dishes are chosen', () => {
  const req = { pizzas: 2, starters: 1 };
  const o = { pizzas: ['א'], starters: [], desserts: [] };
  assert.deepEqual(orderProblems(o, req).map((p) => p.key), ['pizzas', 'starters']);
  o.pizzas.push('ב');
  o.starters.push('ג');
  assert.deepEqual(orderProblems(o, req), []);
});

import { formSnapshot, orderFromSubmission } from '../js/order.js';

test('form snapshot carries the required counts and the menu, hiding starters when none are needed', () => {
  const snap = formSnapshot(quote(), DEFAULT_SETTINGS, { date: '20.12.2026' });
  assert.deepEqual(snap.need, { pizzas: 5, starters: 4 });
  assert.equal(snap.menu.pizzas.length, menu.pizzas.length);
  assert.equal(snap.menu.starters.length, menu.starters.length);
  assert.equal(snap.menu.starters.find((x) => x.name === 'פוקאצ׳ה').fixed, true);
  assert.deepEqual(snap.menu.desserts.map((x) => x.name), ['קלצונה נוטלה', 'מלבי']);
  assert.equal(snap.menu.desserts[1].note, 'בתוספת 10 ₪ לאדם');
  assert.deepEqual(snap.preset.pizzas, ['מרגריטה']);
  assert.deepEqual(formSnapshot(quote({ starterCount: 0 }), DEFAULT_SETTINGS).menu.starters, []);
});

test('a customer submission becomes an order with only valid dishes, "other" pizzas and the fixed dishes', () => {
  const sub = {
    pizzas: ['מרגריטה', 'פיצה מומצאת', 'מרגריטה', 'אחר: פיצה טרופית', 'בוראטה'],
    starters: ['כרובית על טחינה', 'פיצה שחיתות'],
    desserts: ['מלבי', 'פיצה שחיתות'],
    notes: ' בלי בצל ',
  };
  const o = orderFromSubmission(quote({ pizzaCount: 2 }), menu, sub);
  assert.deepEqual(o.pizzas, ['מרגריטה', 'אחר: פיצה טרופית']);
  assert.deepEqual(o.starters, ['פוקאצ׳ה', 'כרובית על טחינה']);
  assert.deepEqual(o.desserts, ['קלצונה נוטלה', 'מלבי']);
  assert.deepEqual(orderFromSubmission(quote({ starterCount: 0 }), menu, sub).starters, []);
  assert.equal(o.notes, 'בלי בצל');
  assert.equal(o.quoteId, 'q1');
});
