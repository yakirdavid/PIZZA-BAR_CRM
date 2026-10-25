// מנוע חישוב מחיר – אותה פונקציה משמשת את הטופס, התצוגה המקדימה וה-PDF.

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const money = (v) => Math.round(num(v));
const isSet = (v) => v !== null && v !== undefined && v !== '';

export function billableGuests(adults, children, childFactor = 0.5) {
  return Math.max(0, num(adults)) + Math.max(0, num(children)) * num(childFactor);
}

export function packagePriceFor(pkg, billable) {
  const extra = Math.max(0, billable - num(pkg.minGuests));
  return money(num(pkg.minPrice) + extra * num(pkg.extraAdult));
}

export function extensionPrice(minutes, prices) {
  const m = Math.max(0, num(minutes));
  const hours = Math.floor(m / 60);
  const halves = Math.ceil((m - hours * 60) / 30);
  return money(hours * num(prices.hourPrice) + halves * num(prices.halfHourPrice));
}

export function autoDeposit(total, rules) {
  if (total <= 0) return 0;
  const d = Math.max(num(rules.min), money((total * num(rules.percent)) / 100));
  return Math.min(total, d);
}

function lineTotal(item) {
  return item.unit === 'fixed' ? money(item.price) : money(num(item.price) * num(item.qty));
}

// q – אובייקט הצעה (ראו newQuote ב-app.js)
export function calcQuote(q) {
  const pkg = q.pkg || {};
  const ages = q.brand?.ageGroups || q.ageGroups;
  const factor = ages ? num(ages.childFactor) : 0.5;
  const billable = billableGuests(q.guests?.adults, q.guests?.children, factor);

  const computedPackage = packagePriceFor(pkg, billable);
  const packagePrice = isSet(q.overrides?.packagePrice) ? money(q.overrides.packagePrice) : computedPackage;

  const computedExtension = extensionPrice(q.extensionMinutes, q.extension || {});
  const extPrice = isSet(q.overrides?.extensionPrice) ? money(q.overrides.extensionPrice) : computedExtension;

  const pasta = q.pasta || {};
  const pastaPortions = Math.max(0, num(pasta.portions));
  const pastaPrice = pastaPortions > 0 ? money(pastaPortions * num(pasta.pricePerPortion) + num(pasta.setupFee)) : 0;

  const addons = (q.addons || []).map((a) => ({ ...a, total: lineTotal(a) }));
  const addonsTotal = addons.reduce((s, a) => s + a.total, 0);
  const custom = (q.customItems || []).map((c) => ({ ...c, total: money(c.amount) }));
  const customTotal = custom.reduce((s, c) => s + c.total, 0);

  const extrasTotal = extPrice + pastaPrice + addonsTotal + customTotal;

  const discountOf = (subtotal) => {
    const d = q.discount || {};
    const raw = d.type === 'percent' ? money((subtotal * num(d.value)) / 100) : money(d.value);
    return Math.min(Math.max(0, raw), subtotal);
  };

  const subtotal = packagePrice + extrasTotal;
  const discount = discountOf(subtotal);
  const total = subtotal - discount;

  const rules = q.depositRules || { percent: 25, min: 500 };
  const computedDeposit = autoDeposit(total, rules);
  const deposit = isSet(q.overrides?.deposit) ? Math.min(total, Math.max(0, money(q.overrides.deposit))) : computedDeposit;
  const balance = total - deposit;
  const partialCancelFee = money((deposit * num(q.cancellation?.partialFeePercent ?? 50)) / 100);

  // תרחיש כמות מקסימלית: אותה נוסחה בדיוק, עם מספר המשתתפים המקסימלי לחיוב
  let max = null;
  const maxGuests = num(q.guests?.max);
  if (maxGuests > billable) {
    const maxPackage = isSet(q.overrides?.packagePrice) ? packagePrice : packagePriceFor(pkg, maxGuests);
    const maxSubtotal = maxPackage + extrasTotal;
    const maxTotal = maxSubtotal - discountOf(maxSubtotal);
    max = { guests: maxGuests, packagePrice: maxPackage, total: maxTotal, perGuest: money(maxTotal / maxGuests) };
  }

  const internal = q.internal || {};
  const cost = money(num(internal.costPerGuest) * billable + num(internal.fixedCost));
  const commission = money((total * num(internal.commissionPercent)) / 100);

  return {
    billable,
    computedPackage,
    packagePrice,
    computedExtension,
    extPrice,
    pastaPrice,
    addons,
    addonsTotal,
    custom,
    customTotal,
    subtotal,
    discount,
    total,
    computedDeposit,
    deposit,
    balance,
    partialCancelFee,
    perGuest: billable > 0 ? money(total / billable) : 0,
    max,
    internal: { cost, commission, profit: total - cost - commission },
  };
}

export function formatILS(n) {
  return `${Math.round(num(n)).toLocaleString('he-IL')} ₪`;
}

export function formatGuests(n) {
  const v = num(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function formatDuration(minutes) {
  const m = Math.max(0, num(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  const hText = h === 0 ? '' : h === 1 ? 'שעה' : h === 2 ? 'שעתיים' : `${h} שעות`;
  if (!r) return hText || '0 דקות';
  return hText ? `${hText} וחצי` : 'חצי שעה';
}

export function fillTerms(text, calc) {
  return String(text)
    .replaceAll('{מקדמה}', formatILS(calc.deposit))
    .replaceAll('{יתרה}', formatILS(calc.balance))
    .replaceAll('{סכום}', formatILS(calc.total))
    .replaceAll('{דמי_ביטול_חלקיים}', formatILS(calc.partialCancelFee));
}
