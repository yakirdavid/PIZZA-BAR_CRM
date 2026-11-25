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
