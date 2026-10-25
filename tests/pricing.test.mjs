import test from 'node:test';
import assert from 'node:assert/strict';
import { calcQuote, extensionPrice, autoDeposit, billableGuests, fillTerms } from '../js/pricing.js';
import { DEFAULT_SETTINGS } from '../js/defaults.js';

const base = (over = {}) => ({
  pkg: DEFAULT_SETTINGS.packages[0],
  ageGroups: DEFAULT_SETTINGS.ageGroups,
  extension: DEFAULT_SETTINGS.extension,
  depositRules: DEFAULT_SETTINGS.deposit,
  cancellation: DEFAULT_SETTINGS.cancellation,
  guests: { adults: 0, children: 0, infants: 0, max: '' },
  overrides: {},
  ...over,
});

test('billable guests: kids count half, infants ignored', () => {
  assert.equal(billableGuests(20, 4), 22);
});

test('minimum price up to 15 billable', () => {
  assert.equal(calcQuote(base({ guests: { adults: 10, children: 4, infants: 3 } })).total, 2700);
  assert.equal(calcQuote(base({ guests: { adults: 15, children: 0 } })).total, 2700);
});

test('extra adults and kids', () => {
  // 20 adults + 4 kids = 22 billable → 2700 + 7*150
  assert.equal(calcQuote(base({ guests: { adults: 20, children: 4 } })).total, 3750);
  // kid beyond min costs 75
  assert.equal(calcQuote(base({ guests: { adults: 15, children: 1 } })).total, 2775);
  const pizza = base({ pkg: DEFAULT_SETTINGS.packages[1], guests: { adults: 16, children: 0 } });
  assert.equal(calcQuote(pizza).total, 2220);
});

test('extension pricing', () => {
  const p = DEFAULT_SETTINGS.extension;
  assert.equal(extensionPrice(30, p), 250);
  assert.equal(extensionPrice(60, p), 500);
  assert.equal(extensionPrice(90, p), 750);
});

test('deposit 25% min 500 never above total', () => {
  assert.equal(autoDeposit(2700, { percent: 25, min: 500 }), 675);
  assert.equal(autoDeposit(1000, { percent: 25, min: 500 }), 500);
  assert.equal(autoDeposit(300, { percent: 25, min: 500 }), 300);
  assert.equal(autoDeposit(0, { percent: 25, min: 500 }), 0);
});

test('addons, pasta, custom, percent discount, deposit override', () => {
  const q = base({
    guests: { adults: 30, children: 0 },
    extensionMinutes: 60,
    pasta: { portions: 10, pricePerPortion: 30, setupFee: 100 },
    addons: [{ name: 'x', price: 15, qty: 10, unit: 'qty' }, { name: 'y', price: 300, unit: 'fixed' }],
    customItems: [{ name: 'z', amount: 200 }],
    discount: { type: 'percent', value: 10 },
  });
  const c = calcQuote(q);
  // package 2700 + 15*150 = 4950; ext 500; pasta 400; addons 450; custom 200 → 6500; -10% = 5850
  assert.equal(c.packagePrice, 4950);
  assert.equal(c.subtotal, 6500);
  assert.equal(c.discount, 650);
  assert.equal(c.total, 5850);
  assert.equal(c.deposit, 1463);
  assert.equal(c.balance, 5850 - 1463);
  q.overrides.deposit = 2000;
  assert.equal(calcQuote(q).deposit, 2000);
  q.overrides.deposit = 99999;
  assert.equal(calcQuote(q).deposit, 5850);
});

test('max guests scenario', () => {
  const c = calcQuote(base({ guests: { adults: 130, children: 0, max: 150 } }));
  assert.equal(c.total, 2700 + 115 * 150);
  assert.equal(c.max.total, 2700 + 135 * 150);
});

test('package price override', () => {
  const c = calcQuote(base({ guests: { adults: 40 }, overrides: { packagePrice: 5000 } }));
  assert.equal(c.total, 5000);
});

test('terms placeholders', () => {
  const c = calcQuote(base({ guests: { adults: 15 } }));
  assert.match(fillTerms('מקדמה {מקדמה} דמי {דמי_ביטול_חלקיים}', c), /675.*338/);
});
