import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastExpenses, eventProfit, shoppingList, gasNeed } from '../js/expenses.js';
import { DEFAULT_SETTINGS, clone } from '../js/defaults.js';

const settings = clone(DEFAULT_SETTINGS);
const quote = (extra = {}) => ({
  id: 'q1',
  number: 1001,
  packageId: 'full',
  pkg: clone(DEFAULT_SETTINGS.packages[0]), // 3 שעות, מינימום 2,700 עד 15 משתתפים, 150 למבוגר נוסף
  guests: { adults: 30, children: 0, infants: 0 },
  extension: { hourPrice: 500, halfHourPrice: 250 },
  depositRules: { percent: 25, min: 500 },
  pizzaCount: 5,
  pizzas: ['מרגריטה', 'בוראטה'],
  ...extra,
});

test('staff cost uses serving hours plus setup hours', () => {
  const f = forecastExpenses(quote(), null, settings);
  const staff = f.lines.find((l) => l.key === 'staff');
  // (3 + 3) שעות × (2×60 + 1×50)
  assert.equal(staff.forecast, 6 * (2 * 60 + 50));
  // מספר עובדים שונה לאירוע הזה
  const f2 = forecastExpenses(quote({ costs: { staffCount: { 0: 3 } } }), null, settings);
  assert.equal(f2.lines.find((l) => l.key === 'staff').forecast, 6 * (3 * 60 + 50));
});

test('fuel is a round trip and the event distance overrides the default', () => {
  const fuel = (q) => forecastExpenses(q, null, settings).lines.find((l) => l.key === 'fuel').forecast;
  assert.equal(fuel(quote()), Math.round(((30 * 2) / 10) * 7.5));
  assert.equal(fuel(quote({ costs: { distanceKm: 100 } })), Math.round(((100 * 2) / 10) * 7.5));
});

test('gas: ovens × kg per hour × (serving + preheat), priced by cylinder', () => {
  const g = gasNeed(quote(), settings.expenses);
  assert.ok(Math.abs(g.kg - 4 * 0.7 * 4) < 1e-9);
  assert.equal(g.cylinders, 1);
  assert.equal(g.cost, Math.round((11.2 / 12) * 280));
});

test('shopping list scales with guests and only includes chosen dishes', () => {
  const order = { pizzas: ['מרגריטה', 'בוראטה'], starters: [], desserts: ['קלצונה נוטלה'] };
  const list = shoppingList(quote(), order, settings);
  const by = (n) => list.find((x) => x.name === n);
  assert.equal(by('קמח 00').qty, 6); // 0.2 × 30
  assert.equal(by('גבינת בורטה').qty, Math.ceil((0.3 * 30) / 2)); // מתחלק בין 2 סוגי פיצות, מעוגל ליחידה
  assert.equal(by('פטריות פורטובלו'), undefined); // פיצה פולנטה לא נבחרה
  assert.ok(by('נוטלה'));
  assert.equal(by('בלון גז לטאבון (מלא)').qty, 1);
});

test('food cost comes from the shopping list prices', () => {
  const f = forecastExpenses(quote(), null, settings);
  const list = shoppingList(quote(), null, settings);
  assert.equal(f.lines.find((l) => l.key === 'food').forecast, list.reduce((s, x) => s + x.cost, 0));
  const noPrices = { ...settings, shopping: [] };
  assert.equal(forecastExpenses(quote(), null, noPrices).lines.find((l) => l.key === 'food').forecast, 30 * 25);
});

test('profit = revenue − expenses (actual amounts win), split equally between partners', () => {
  const q = quote({ costs: { actual: { fuel: 200 }, extra: [{ name: 'חניה', amount: 50 }] } });
  const p = eventProfit(q, null, settings);
  assert.equal(p.revenue, 2700 + 15 * 150);
  assert.equal(p.lines.find((l) => l.key === 'fuel').final, 200);
  assert.ok(p.lines.find((l) => l.label === 'חניה'));
  assert.equal(p.expenses, p.lines.reduce((s, l) => s + l.final, 0));
  assert.equal(p.profit, p.revenue - p.expenses);
  assert.deepEqual(p.partners.map((x) => x.name), ['יקיר', 'טבע']);
  assert.equal(p.partners[0].share, Math.round(p.profit / 2));
  assert.equal(p.hasActual, true);
});
