// הוצאות, רווח ורשימת קניות לאירוע.
// התחזית מחושבת מההגדרות (כוח אדם, דלק, גז, חומרי גלם) ומפרטי האירוע (משתתפים, שעות, מנות).
// לכל סעיף אפשר להזין סכום בפועל באירוע עצמו; הרווח מחושב לפי הסכום בפועל כשקיים.
import { calcQuote } from './pricing.js';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const money = (v) => Math.round(num(v));
const isSet = (v) => v !== '' && v != null && Number.isFinite(Number(v));

// שעות העבודה באירוע: זמן ההגשה (כולל הארכה) + הקמה, פירוק ונסיעה
export function eventHours(q, exp) {
  const serving = num(q.pkg?.hours) + num(q.extensionMinutes) / 60;
  return { serving, work: serving + num(exp?.setupHours) };
}

// מספר האורחים לחישוב כמויות: מבוגרים + ילדים לפי המקדם (כמו במחיר)
export const guestUnits = (q) => calcQuote(q).billable;

// ---------- רשימת קניות ----------
// פריט: { name, category, unit, qty, per, dish, price }
//   per: guest – לכל אורח · share – לכל אורח, מתחלק בין סוגי הפיצות שנבחרו (תוספות של פיצה מסוימת)
//        event – קבוע לאירוע · hour – לכל שעת הגשה
//   dish: ריק – לכל אירוע · שם מנה – רק כשהמנה נבחרה בהזמנה
export const PER_OPTIONS = [
  ['guest', 'לכל אורח'],
  ['share', 'לכל אורח, מתחלק בין סוגי הפיצות'],
  ['event', 'קבוע לאירוע'],
  ['hour', 'לכל שעת הגשה'],
];
const WHOLE_UNITS = ['יח׳', "יח'", 'מנה', 'מנות', 'בלון', 'קופסה', 'קופסאות', 'מגש', 'מגשים', 'חבילה', 'חבילות', 'שקית', 'בקבוק', 'קרטון'];

// המנות של האירוע: מההזמנה אם קיימת, אחרת מה שנבחר בהצעה
export function eventDishes(q, order) {
  const src = order || { pizzas: q.pizzas || [], starters: [], desserts: [] };
  return {
    pizzas: (src.pizzas || []).filter(Boolean),
    all: [...(src.pizzas || []), ...(src.starters || []), ...(src.desserts || [])].filter(Boolean),
  };
}

const roundQty = (qty, unit) => (WHOLE_UNITS.includes(String(unit).trim()) ? Math.ceil(qty - 1e-9) : Math.ceil(qty * 10 - 1e-9) / 10);

export function shoppingList(q, order, settings) {
  const items = settings.shopping || [];
  const guests = guestUnits(q);
  const { serving } = eventHours(q, settings.expenses);
  const dishes = eventDishes(q, order);
  const pizzaTypes = Math.max(1, dishes.pizzas.length);
  const out = [];
  for (const it of items) {
    if (!String(it.name || '').trim()) continue;
    if (it.dish && !dishes.all.includes(it.dish)) continue;
    const base = num(it.qty);
    const qty = {
      guest: base * guests,
      share: (base * guests) / pizzaTypes,
      event: base,
      hour: base * serving,
    }[it.per || 'guest'];
    if (!(qty > 0)) continue;
    const rounded = roundQty(qty, it.unit);
    out.push({ ...it, qty: rounded, cost: money(rounded * num(it.price)) });
  }
  // בלוני גז לטאבונים – מחושב מהגדרות ההוצאות
  const gas = gasNeed(q, settings.expenses);
  if (gas.cylinders > 0) out.push({ name: 'בלון גז לטאבון (מלא)', category: 'ציוד', unit: 'בלון', qty: gas.cylinders, cost: 0, auto: true });
  return out;
}

// ---------- תחזית הוצאות ----------
export function gasNeed(q, exp) {
  const g = exp?.gas || {};
  const { serving } = eventHours(q, exp);
  const kg = num(g.ovens) * num(g.kgPerHourPerOven) * (serving + num(g.preheatHours));
  const size = num(g.cylinderKg);
  return { kg, cylinders: size > 0 ? Math.ceil(kg / size - 1e-9) : 0, cost: size > 0 ? money((kg / size) * num(g.cylinderPrice)) : 0 };
}

// costs: הנתונים של האירוע עצמו (q.costs) – מרחק, מספר עובדים, סכומים בפועל, הוצאות נוספות
export function forecastExpenses(q, order, settings) {
  const exp = settings.expenses || {};
  const costs = q.costs || {};
  const guests = guestUnits(q);
  const { serving, work } = eventHours(q, exp);
  const lines = [];

  // כוח אדם
  const staff = (exp.staff || []).map((r, i) => {
    const count = isSet(costs.staffCount?.[i]) ? num(costs.staffCount[i]) : num(r.count);
    const amount = r.type === 'event' ? count * num(r.rate) : count * num(r.rate) * work;
    return { ...r, count, amount: money(amount) };
  });
  lines.push({
    key: 'staff',
    label: 'כוח אדם',
    amount: staff.reduce((s, r) => s + r.amount, 0),
    detail: staff
      .filter((r) => r.count)
      .map((r) => `${r.count} ${r.name} × ${r.type === 'event' ? `${num(r.rate)} ₪ לאירוע` : `${round1(work)} ש׳ × ${num(r.rate)} ₪`}`)
      .join(' · '),
  });

  // חומרי גלם: מהמחירים ברשימת הקניות, או לפי עלות לאורח כשאין מחירים
  const list = shoppingList(q, order, settings);
  const listCost = list.reduce((s, x) => s + x.cost, 0);
  lines.push(
    listCost > 0
      ? { key: 'food', label: 'חומרי גלם (Food cost)', amount: listCost, detail: 'לפי רשימת הקניות והמחירים בהגדרות' }
      : { key: 'food', label: 'חומרי גלם (Food cost)', amount: money(num(exp.foodPerGuest) * guests), detail: `${round1(guests)} אורחים × ${num(exp.foodPerGuest)} ₪` }
  );

  // דלק: הלוך וחזור
  const f = exp.fuel || {};
  const km = isSet(costs.distanceKm) ? num(costs.distanceKm) : num(f.distanceKm);
  const liters = num(f.kmPerLiter) > 0 ? (km * 2) / num(f.kmPerLiter) : 0;
  lines.push({ key: 'fuel', label: 'דלק', amount: money(liters * num(f.pricePerLiter)), detail: `${km} ק״מ לכל כיוון · ${round1(liters)} ליטר × ${num(f.pricePerLiter)} ₪` });

  // גז לטאבונים
  const gas = gasNeed(q, exp);
  lines.push({
    key: 'gas',
    label: 'גז לטאבונים',
    amount: gas.cost,
    detail: `${num(exp.gas?.ovens)} טאבונים × ${round1(serving + num(exp.gas?.preheatHours))} ש׳ · ${round1(gas.kg)} ק״ג (${gas.cylinders === 1 ? 'בלון אחד' : `${gas.cylinders} בלונים`})`,
  });

  // הוצאות קבועות נוספות מההגדרות (חד פעמי, ביטוח וכו')
  for (const [i, o] of (exp.other || []).entries()) {
    if (!String(o.name || '').trim()) continue;
    const amount = money(o.per === 'guest' ? num(o.amount) * guests : num(o.amount));
    lines.push({ key: `other${i}`, label: o.name, amount, detail: o.per === 'guest' ? `${round1(guests)} אורחים × ${num(o.amount)} ₪` : 'קבוע לאירוע' });
  }

  // עמלה מההצעה (אם הוגדרה)
  const c = calcQuote(q);
  if (c.internal.commission) lines.push({ key: 'commission', label: 'עמלה', amount: c.internal.commission, detail: `${num(q.internal?.commissionPercent)}% מסכום ההצעה` });

  // הוצאות נוספות שהוזנו באירוע עצמו
  for (const [i, x] of (costs.extra || []).entries()) {
    if (String(x.name || '').trim() || num(x.amount)) lines.push({ key: `extra${i}`, label: x.name || 'הוצאה נוספת', amount: money(x.amount), detail: 'הוזן באירוע', extra: true });
  }

  for (const l of lines) {
    const actual = costs.actual?.[l.key];
    l.forecast = l.amount;
    l.actual = isSet(actual) ? money(actual) : null;
    l.final = l.actual ?? l.forecast;
  }
  return { lines, staff, guests, hours: { serving, work }, km };
}

// ---------- רווח ----------
export function eventProfit(q, order, settings) {
  const revenue = calcQuote(q).total;
  const f = forecastExpenses(q, order, settings);
  const forecast = f.lines.reduce((s, l) => s + l.forecast, 0);
  const expenses = f.lines.reduce((s, l) => s + l.final, 0);
  const partners = (settings.expenses?.partners || []).filter((p) => String(p).trim());
  const n = Math.max(1, partners.length);
  const profit = revenue - expenses;
  return {
    revenue,
    forecast,
    expenses,
    hasActual: f.lines.some((l) => l.actual != null),
    profit,
    margin: revenue ? profit / revenue : 0,
    partners: (partners.length ? partners : ['רווח']).map((name) => ({ name, share: money(profit / n) })),
    lines: f.lines,
    detail: f,
  };
}

function round1(v) {
  return Math.round(num(v) * 10) / 10;
}
