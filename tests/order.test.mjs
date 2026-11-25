import test from 'node:test';
import assert from 'node:assert/strict';
import { newOrder, orderRequirements, orderProblems } from '../js/order.js';
import { DEFAULT_SETTINGS } from '../js/defaults.js';

const menu = DEFAULT_SETTINGS.menu;
const quote = (extra = {}) => ({ id: 'q1', number: 1005, pizzaCount: 5, starterCount: 4, pizzas: ['מרגריטה', 'לא בתפריט'], ...extra });

test('new order is linked to its quote and keeps quote pizzas that are on the menu', () => {
  const o = newOrder(quote(), menu);
  assert.equal(o.quoteId, 'q1');
  assert.equal(o.number, 1005);
  assert.equal(o.status, 'new');
  assert.deepEqual(o.pizzas, ['מרגריטה']);
});

test('required dish counts come from the quote, capped by the menu', () => {
  assert.deepEqual(orderRequirements(quote(), menu), { pizzas: 5, starters: 4 });
  assert.deepEqual(orderRequirements(quote({ starterCount: 0 }), menu), { pizzas: 5, starters: 0 });
  assert.equal(orderRequirements(quote({ pizzaCount: 99 }), menu).pizzas, menu.pizzas.length);
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
  assert.deepEqual(snap.preset.pizzas, ['מרגריטה', 'לא בתפריט']);
  assert.deepEqual(formSnapshot(quote({ starterCount: 0 }), DEFAULT_SETTINGS).menu.starters, []);
});

test('a customer submission becomes an order with only valid dishes', () => {
  const sub = {
    pizzas: ['מרגריטה', 'בוראטה', 'מרגריטה', 'פיצה מומצאת'],
    starters: ['כרובית על טחינה'],
    desserts: ['מלבי'],
    notes: ' בלי בצל ',
  };
  const o = orderFromSubmission(quote({ pizzaCount: 2 }), menu, sub);
  assert.deepEqual(o.pizzas, ['מרגריטה', 'בוראטה']);
  assert.deepEqual(o.starters, ['כרובית על טחינה']);
  assert.deepEqual(o.desserts, ['מלבי']);
  assert.equal(o.notes, 'בלי בצל');
  assert.equal(o.quoteId, 'q1');
});
