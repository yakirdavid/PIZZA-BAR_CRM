// הזמנה: נוצרת מהצעת מחיר מאושרת (הזמנה אחת לכל הצעה) ומכילה את המנות שהלקוח בחר.
// פרטי הלקוח, האירוע והמחיר נלקחים תמיד מההצעה המקושרת.
import { calcQuote } from './pricing.js';

export const ORDER_STATUSES = [
  { id: 'new', label: 'טרם נשלחה' },
  { id: 'sent', label: 'נשלחה ללקוח' },
  { id: 'done', label: 'האירוע בוצע' },
];

export function newOrder(q, menu) {
  const menuPizzas = (menu?.pizzas || []).map((p) => p.name);
  return {
    id: null,
    quoteId: q.id,
    number: q.number,
    status: 'new',
    createdAt: new Date().toISOString(),
    updatedAt: null,
    // פיצות שכבר נבחרו בהצעה נכנסות מראש
    pizzas: (q.pizzas || []).filter((p) => menuPizzas.includes(p)),
    starters: [],
    desserts: [],
    notes: '',
    internalNotes: '',
  };
}

// כמה מנות חובה לבחור בכל קטגוריה, לפי ההצעה (ולא יותר ממה שיש בתפריט)
export function orderRequirements(q, menu) {
  const cap = (n, list) => Math.min(Math.max(0, Math.floor(Number(n) || 0)), (list || []).length);
  return {
    pizzas: cap(q.pizzaCount, menu?.pizzas),
    starters: cap(calcQuote(q).starterCount, menu?.starters),
  };
}

// מה עוד חסר כדי לשמור את ההזמנה. רשימה ריקה = אפשר לשמור.
export function orderProblems(order, req) {
  const out = [];
  const n = (k) => (order[k] || []).length;
  if (req.pizzas && n('pizzas') !== req.pizzas) out.push({ key: 'pizzas', msg: `יש לבחור ${req.pizzas} סוגי פיצות (נבחרו ${n('pizzas')})` });
  if (req.starters && n('starters') !== req.starters)
    out.push({ key: 'starters', msg: `יש לבחור ${req.starters} מנות ראשונות (נבחרו ${n('starters')})` });
  return out;
}

// ---------- טופס בחירת מנות ללקוח ----------
// מה שהטופס הציבורי מציג. נשמר בטבלת הטפסים, כך שהלקוח לא צריך גישה לשום נתון אחר.
export function formSnapshot(q, settings, { date = '', eventType = '', logo = '' } = {}) {
  const req = orderRequirements(q, settings.menu);
  const pick = (list) => (list || []).map(({ name, desc }) => ({ name, desc: desc || '' }));
  return {
    number: q.number,
    name: q.customer?.name || '',
    date,
    eventType,
    title: settings.business?.title || '',
    contact: settings.business?.contact || '',
    logo,
    need: req,
    menu: {
      starters: req.starters ? pick(settings.menu?.starters) : [],
      pizzas: pick(settings.menu?.pizzas),
      desserts: pick(settings.menu?.desserts),
    },
    // מה שכבר נבחר בהצעה מסומן מראש בטופס
    preset: { pizzas: (q.pizzas || []).slice(0, req.pizzas) },
  };
}

// הזמנה חדשה מתוך בחירת הלקוח. רק מנות שקיימות בתפריט, ולא יותר מהכמות שנקבעה.
export function orderFromSubmission(q, menu, sub) {
  const o = newOrder(q, menu);
  const req = orderRequirements(q, menu);
  const keep = (names, list, max) => {
    const valid = (list || []).map((x) => x.name);
    const out = [...new Set((names || []).filter((n) => valid.includes(n)))];
    return max == null ? out : out.slice(0, max);
  };
  o.pizzas = keep(sub?.pizzas, menu?.pizzas, req.pizzas);
  o.starters = keep(sub?.starters, menu?.starters, req.starters);
  o.desserts = keep(sub?.desserts, menu?.desserts);
  o.notes = String(sub?.notes || '').trim();
  return o;
}
