// זיהוי פרטי אירוע מתוך הודעה שהלקוח שלח (וואטסאפ / טופס), בפורמט "שדה: ערך" בכל שורה.
// הפענוח נעשה בדפדפן בלבד – בלי שירות חיצוני.
import { HEB_MONTHS } from './quote-render.js';

const clean = (s) =>
  String(s ?? '')
    .replace(/[‎‏‪-‮]/g, '') // סימני כיווניות נסתרים מהעתקה
    .replace(/\s+/g, ' ')
    .trim();

// מפתח מנורמל: בלי סוגריים, בלי גרשיים, בלי רווחים כפולים
const normKey = (k) =>
  clean(k)
    .replace(/\(.*?\)/g, '')
    .replace(/["'״׳*•\-–—]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const FIELDS = [
  ['adults', /מבוגר/],
  ['children', /ילד/],
  ['infants', /תינוק|פעוט/],
  ['total', /סהכ|סך הכל|כמות אורחים|מספר אורחים|אורחים|משתתפים/],
  ['phone', /טלפון|נייד|פלאפון|פלפון|סלולרי|וואטסאפ/],
  ['email', /מייל|email|דואל/i],
  ['package', /מסלול|חבילה/],
  ['eventType', /סוג|^אירוע$/],
  ['date', /תאריך|מועד/],
  ['time', /שעה|שעת/],
  ['address', /מיקום|כתובת|מקום|עיר|ישוב/],
  ['notes', /הערה|הערות|בקשות|פרטים נוספים/],
  ['name', /^(שם|שם מלא|שם הלקוח|שם לקוח|שם המזמין|איש קשר|שמי)$/],
];

const firstInt = (v) => {
  const m = String(v).match(/\d+/);
  return m ? Number(m[0]) : null;
};

export function normalizePhone(v) {
  let d = String(v).replace(/\D/g, '');
  if (d.startsWith('972')) d = '0' + d.slice(3);
  if (d.length === 9 && d.startsWith('5')) d = '0' + d;
  return /^05\d{8}$/.test(d) ? `${d.slice(0, 3)}-${d.slice(3)}` : clean(v);
}

// תאריך מלא → {date: 'YYYY-MM-DD'}; רק חודש ושנה → {monthNum, year}
export function parseDate(v, now = new Date()) {
  const s = clean(v);
  const valid = (y, m, d) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  };
  const pad = (n) => String(n).padStart(2, '0');
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m && valid(+m[1], +m[2], +m[3])) return { date: `${m[1]}-${pad(m[2])}-${pad(m[3])}` };
  m = s.match(/(\d{1,2})[./\-](\d{1,2})(?:[./\-](\d{2,4}))?/);
  if (m) {
    let y = m[3] ? Number(m[3]) : now.getFullYear();
    if (y < 100) y += 2000;
    const d = Number(m[1]);
    const mo = Number(m[2]);
    // בלי שנה: אם התאריך כבר עבר השנה – כנראה השנה הבאה
    if (!m[3] && new Date(y, mo - 1, d) < new Date(now.getFullYear(), now.getMonth(), now.getDate())) y++;
    if (valid(y, mo, d)) return { date: `${y}-${pad(mo)}-${pad(d)}` };
    // "11/2026" – חודש ושנה
  }
  m = s.match(/^(\d{1,2})[./\-](\d{4})$/);
  if (m && +m[1] >= 1 && +m[1] <= 12) return { monthNum: +m[1], year: +m[2] };
  const mi = HEB_MONTHS.findIndex((name) => s.includes(name));
  if (mi >= 0) {
    const y = s.match(/\d{4}/);
    let year = y ? Number(y[0]) : now.getFullYear();
    if (!y && mi < now.getMonth()) year++;
    return { monthNum: mi + 1, year };
  }
  return null;
}

function parseTime(v) {
  const m = clean(v).match(/(\d{1,2})(?::|\.)(\d{2})/) || clean(v).match(/^(\d{1,2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2] || 0);
  return h < 24 && mi < 60 ? `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` : null;
}

// התאמה לרשימה (סוגי אירוע / מסלולים) – לפי הכלה, בלי מילים כלליות
function matchOption(value, options, getName = (x) => x) {
  const strip = (s) => clean(s).replace(/^(מסלול|חבילת|חבילה)\s*/, '').replace(/["'״׳]/g, '');
  const v = strip(value);
  if (!v) return null;
  return (
    options.find((o) => strip(getName(o)) === v) ||
    options.find((o) => strip(getName(o)).includes(v) || v.includes(strip(getName(o)))) ||
    null
  );
}

/**
 * מפענח הודעה. מחזיר:
 *   values – שדות שזוהו (רק מה שנמצא)
 *   filled – תיאור קריא של מה שזוהה
 *   warnings – דברים שכדאי לבדוק
 *   ignored – שורות שלא זוהו
 */
export function parseRequest(text, settings, now = new Date()) {
  const values = {};
  const filled = [];
  const warnings = [];
  const ignored = [];
  let lastKey = null;

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = clean(raw);
    if (!line) continue;
    const m = line.match(/^([^:：]{1,40})[:：]\s*(.*)$/);
    if (!m) {
      if (lastKey === 'notes') values.notes += '\n' + line; // הערות שממשיכות בשורות הבאות
      else ignored.push(line);
      continue;
    }
    const key = normKey(m[1]);
    const val = clean(m[2]);
    const field = FIELDS.find(([, re]) => re.test(key))?.[0];
    lastKey = field || null;
    if (!field) {
      if (val) ignored.push(line);
      continue;
    }
    if (!val) continue;
    switch (field) {
      case 'name':
        values.name = val;
        break;
      case 'phone':
        values.phone = normalizePhone(val);
        break;
      case 'email':
        values.email = val;
        break;
      case 'adults':
      case 'children':
      case 'infants':
      case 'total': {
        const n = firstInt(val);
        if (n != null) values[field] = n;
        else warnings.push(`לא זוהה מספר בשורה "${line}"`);
        break;
      }
      case 'eventType':
        values.eventTypeRaw = val;
        break;
      case 'date': {
        const d = parseDate(val, now);
        if (d) Object.assign(values, d);
        else warnings.push(`התאריך "${val}" לא זוהה – יש להזין ידנית`);
        break;
      }
      case 'time': {
        const t = parseTime(val);
        if (t) values.startTime = t;
        else warnings.push(`השעה "${val}" לא זוהתה`);
        break;
      }
      case 'address':
        values.address = val;
        break;
      case 'package':
        values.packageRaw = val;
        break;
      case 'notes':
        values.notes = val;
        break;
    }
  }

  // סוג אירוע: מהרשימה בהגדרות, ואם אין התאמה – "אחר" עם הטקסט של הלקוח
  if (values.eventTypeRaw) {
    const t = matchOption(values.eventTypeRaw, settings.eventTypes.filter((x) => x !== 'אחר'));
    if (t) values.eventType = t;
    else {
      values.eventType = 'אחר';
      values.eventTypeOther = values.eventTypeRaw;
    }
  }
  if (values.packageRaw) {
    const p = matchOption(values.packageRaw, settings.packages, (x) => x.name);
    if (p) values.packageId = p.id;
    else warnings.push(`המסלול "${values.packageRaw}" לא זוהה – יש לבחור מסלול ידנית`);
  }

  const people = (values.adults || 0) + (values.children || 0) + (values.infants || 0);
  if (values.total != null && people && values.total !== people)
    warnings.push(`סה״כ האורחים בהודעה (${values.total}) לא תואם לפירוט (${people}) – כדאי לבדוק`);
  if (values.phone && !/^05\d-\d{7}$/.test(values.phone)) warnings.push(`מספר הטלפון "${values.phone}" לא נראה כמו נייד ישראלי`);

  const add = (label, v) => v != null && v !== '' && filled.push(`${label}: ${v}`);
  add('שם', values.name);
  add('טלפון', values.phone);
  add('אימייל', values.email);
  add('סוג האירוע', values.eventType === 'אחר' ? values.eventTypeOther : values.eventType);
  if (values.date) add('תאריך', values.date.split('-').reverse().join('.'));
  if (values.monthNum) add('מועד', `${HEB_MONTHS[values.monthNum - 1]} ${values.year} (רק חודש)`);
  add('שעה', values.startTime);
  add('מיקום', values.address);
  add('מבוגרים', values.adults);
  add('ילדים', values.children);
  add('פעוטות', values.infants);
  if (values.packageId) add('מסלול', settings.packages.find((p) => p.id === values.packageId)?.name);
  if (values.notes) filled.push('הערות הלקוח: נשמרו בהערות הפנימיות');

  return { values, filled, warnings, ignored };
}
