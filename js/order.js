// הזמנה: נוצרת מהצעת מחיר מאושרת (הזמנה אחת לכל הצעה) ומכילה את המנות שהלקוח בחר.
// פרטי הלקוח, האירוע והמחיר נלקחים תמיד מההצעה המקושרת.
import { calcQuote } from './pricing.js';

export const ORDER_STATUSES = [
  { id: 'new', label: 'טרם נשלחה' },
  { id: 'sent', label: 'נשלחה ללקוח' },
  { id: 'done', label: 'האירוע בוצע' },
];

// ---------- מנות בתפריט ----------
// כל מנה: { name, desc, fixed?, hidden?, note? }
//   fixed  – כלולה תמיד, מסומנת מראש ואי אפשר לבטל (למשל פוקאצ׳ה, קלצונה נוטלה). לא נספרת בכמות לבחירה.
//   hidden – לא מוצגת ללקוח בטופס ולא בבחירת המנות בהזמנה
//   note   – הערה בולטת ליד המנה (למשל "בתוספת 10 ₪ לאדם")
// בהגדרות כל מנה היא שורה: שם | תיאור | סימון. סימון: קבוע / מוסתר / כל טקסט אחר = הערה.
const FIXED_WORD = 'קבוע';
const HIDDEN_WORD = 'מוסתר';

export function parseMenuLine(line) {
  const [name, desc = '', ...rest] = line.split('|').map((x) => x.trim());
  const item = { name, desc };
  const notes = [];
  for (const tok of rest.join(',').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (tok === FIXED_WORD) item.fixed = true;
    else if (tok === HIDDEN_WORD) item.hidden = true;
    else notes.push(tok);
  }
  if (notes.length) item.note = notes.join(', ');
  return item;
}

export function menuLine(x) {
  const marks = [x.fixed && FIXED_WORD, x.hidden && HIDDEN_WORD, x.note].filter(Boolean).join(', ');
  if (marks) return `${x.name} | ${x.desc || ''} | ${marks}`;
  return x.desc ? `${x.name} | ${x.desc}` : x.name;
}

export const visibleItems = (list) => (list || []).filter((x) => !x.hidden);
const fixedNames = (list) => visibleItems(list).filter((x) => x.fixed).map((x) => x.name);
const choosable = (list) => visibleItems(list).filter((x) => !x.fixed);

// פיצה שתואמה בנפרד ולא מופיעה בתפריט נשמרת כ"אחר: <תיאור>"
export const OTHER_PREFIX = 'אחר: ';
export const isOther = (n) => String(n).startsWith(OTHER_PREFIX);

// כמה מנות חובה לבחור בכל קטגוריה, לפי ההצעה (ולא יותר ממה שיש בתפריט),
// ואילו מנות כלולות תמיד. בלי מנות ראשונות בהצעה (למשל "פיצות בלבד") – אין גם מנות ראשונות קבועות.
export function orderRequirements(q, menu) {
  const cap = (n, max) => Math.min(Math.max(0, Math.floor(Number(n) || 0)), max);
  const starters = cap(calcQuote(q).starterCount, choosable(menu?.starters).length);
  return {
    pizzas: cap(q.pizzaCount, choosable(menu?.pizzas).length + 1), // +1: "אחר"
    starters,
    fixed: {
      starters: starters ? fixedNames(menu?.starters) : [],
      desserts: fixedNames(menu?.desserts),
    },
  };
}

// מנות שנבחרו בפועל (בלי המנות הקבועות)
export const chosen = (order, req, key) => (order[key] || []).filter((n) => !(req.fixed?.[key] || []).includes(n));

// המנות הקבועות תמיד בתחילת הרשימה
const withFixed = (names, fixed) => [...fixed, ...(names || []).filter((n) => !fixed.includes(n))];

export function newOrder(q, menu) {
  const req = orderRequirements(q, menu);
  const menuPizzas = visibleItems(menu?.pizzas).map((p) => p.name);
  return {
    id: null,
    quoteId: q.id,
    number: q.number,
    status: 'new',
    createdAt: new Date().toISOString(),
    updatedAt: null,
    // פיצות שכבר נבחרו בהצעה נכנסות מראש
    pizzas: (q.pizzas || []).filter((p) => menuPizzas.includes(p)).slice(0, req.pizzas),
    starters: [...req.fixed.starters],
    desserts: [...req.fixed.desserts],
    notes: '',
    internalNotes: '',
  };
}

// מה עוד חסר כדי לשמור את ההזמנה. רשימה ריקה = אפשר לשמור.
export function orderProblems(order, req) {
  const out = [];
  const n = (k) => chosen(order, req, k).length;
  if (req.pizzas && n('pizzas') !== req.pizzas) out.push({ key: 'pizzas', msg: `יש לבחור ${req.pizzas} סוגי פיצות (נבחרו ${n('pizzas')})` });
  if (req.starters && n('starters') !== req.starters)
    out.push({ key: 'starters', msg: `יש לבחור ${req.starters} מנות ראשונות (נבחרו ${n('starters')})` });
  return out;
}

// משלים מנות קבועות בהזמנה (למשל בהזמנה שנוצרה לפני שהמנה סומנה כקבועה)
export function ensureFixed(order, req) {
  for (const key of ['starters', 'desserts']) {
    const fixed = req.fixed?.[key] || [];
    if (fixed.some((n) => !(order[key] || []).includes(n))) order[key] = withFixed(order[key], fixed);
  }
  return order;
}

// ---------- טופס בחירת מנות ללקוח ----------
// מה שהטופס הציבורי מציג. נשמר בטבלת הטפסים, כך שהלקוח לא צריך גישה לשום נתון אחר.
export function formSnapshot(q, settings, { date = '', eventType = '', logo = '' } = {}) {
  const req = orderRequirements(q, settings.menu);
  const pick = (list) =>
    visibleItems(list).map(({ name, desc, fixed, note }) => ({ name, desc: desc || '', ...(fixed ? { fixed: true } : {}), ...(note ? { note } : {}) }));
  const pizzaNames = visibleItems(settings.menu?.pizzas).map((p) => p.name);
  return {
    number: q.number,
    name: q.customer?.name || '',
    date,
    eventType,
    title: settings.business?.title || '',
    contact: settings.business?.contact || '',
    logo,
    need: { pizzas: req.pizzas, starters: req.starters },
    allowOther: { pizzas: true },
    menu: {
      // בלי מנות ראשונות בהצעה (פיצות בלבד) – הקטגוריה לא מוצגת בכלל
      starters: req.starters ? pick(settings.menu?.starters) : [],
      pizzas: pick(settings.menu?.pizzas),
      desserts: pick(settings.menu?.desserts),
    },
    // מה שכבר נבחר בהצעה מסומן מראש בטופס
    preset: { pizzas: (q.pizzas || []).filter((p) => pizzaNames.includes(p)).slice(0, req.pizzas) },
  };
}

// הזמנה חדשה מתוך בחירת הלקוח. רק מנות שקיימות בתפריט (או "אחר" בפיצות), לא יותר מהכמות שנקבעה,
// ובתוספת המנות הקבועות.
export function orderFromSubmission(q, menu, sub) {
  const o = newOrder(q, menu);
  const req = orderRequirements(q, menu);
  const keep = (names, list, max, allowOther = false) => {
    const valid = choosable(list).map((x) => x.name);
    const out = [
      ...new Set(
        (names || [])
          .map((n) => String(n).trim())
          .filter((n) => valid.includes(n) || (allowOther && isOther(n) && n.length > OTHER_PREFIX.length))
      ),
    ];
    return max == null ? out : out.slice(0, max);
  };
  o.pizzas = keep(sub?.pizzas, menu?.pizzas, req.pizzas, true);
  o.starters = req.starters ? withFixed(keep(sub?.starters, menu?.starters, req.starters), req.fixed.starters) : [];
  o.desserts = withFixed(keep(sub?.desserts, menu?.desserts), req.fixed.desserts);
  o.notes = String(sub?.notes || '').trim();
  return o;
}
