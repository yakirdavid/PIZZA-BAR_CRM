import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, parseDate, normalizePhone } from '../js/parse-request.js';
import { DEFAULT_SETTINGS } from '../js/defaults.js';

const now = new Date('2026-11-13T12:00:00');

const SAMPLE = `היי, אשמח לבדוק זמינות לאירוע 🍕🔥
שם: בדיקה
טלפון: 0524578565
סוג האירוע: אירוע משפחתי
תאריך: 18/11/2026
מיקום: גני תקווה
מבוגרים (מגיל 7): 17
ילדים (גילאי 3 עד 7): 5
תינוקות (עד גיל 3): 2
סה״כ אורחים: 24
מסלול: מסלול מלא
הערות: בדיקה שהכל עובד`;

test('the sample message is fully recognized', () => {
  const { values, warnings, ignored } = parseRequest(SAMPLE, DEFAULT_SETTINGS, now);
  assert.equal(values.name, 'בדיקה');
  assert.equal(values.phone, '052-4578565');
  assert.equal(values.eventType, 'אחר');
  assert.equal(values.eventTypeOther, 'אירוע משפחתי');
  assert.equal(values.date, '2026-11-18');
  assert.equal(values.address, 'גני תקווה');
  assert.equal(values.adults, 17);
  assert.equal(values.children, 5);
  assert.equal(values.infants, 2);
  assert.equal(values.total, 24);
  assert.equal(values.packageId, 'full');
  assert.equal(values.notes, 'בדיקה שהכל עובד');
  assert.deepEqual(warnings, []);
  assert.deepEqual(ignored, ['היי, אשמח לבדוק זמינות לאירוע 🍕🔥']);
});

test('known event types and packages are matched', () => {
  const r = parseRequest('סוג אירוע: מסיבת רווקות\nמסלול: פיצות בלבד', DEFAULT_SETTINGS, now);
  assert.equal(r.values.eventType, 'מסיבת רווקות');
  assert.equal(r.values.packageId, 'pizza');
  assert.equal(parseRequest('סוג האירוע: חתונה', DEFAULT_SETTINGS, now).values.eventType, 'חתונה');
});

test('unknown package gives a warning', () => {
  const r = parseRequest('מסלול: מסלול זהב', DEFAULT_SETTINGS, now);
  assert.equal(r.values.packageId, undefined);
  assert.match(r.warnings[0], /לא זוהה/);
});

test('totals that do not add up are flagged', () => {
  const r = parseRequest('מבוגרים: 10\nילדים: 2\nסה״כ אורחים: 15', DEFAULT_SETTINGS, now);
  assert.match(r.warnings.join(), /לא תואם/);
});

test('dates in several formats', () => {
  assert.deepEqual(parseDate('18/11/2026', now), { date: '2026-11-18' });
  assert.deepEqual(parseDate('18.11.26', now), { date: '2026-11-18' });
  assert.deepEqual(parseDate('2026-12-03', now), { date: '2026-12-03' });
  assert.deepEqual(parseDate('5/1', now), { date: '2027-01-05' }); // without a year, already passed this year
  assert.deepEqual(parseDate('דצמבר 2026', now), { monthNum: 12, year: 2026 });
  assert.deepEqual(parseDate('12/2026', now), { monthNum: 12, year: 2026 });
  assert.equal(parseDate('31/02/2026', now), null);
});

test('phone formats', () => {
  assert.equal(normalizePhone('0524578565'), '052-4578565');
  assert.equal(normalizePhone('+972 52-457-8565'), '052-4578565');
  assert.equal(normalizePhone('052 457 8565'), '052-4578565');
});

test('multi-line notes and time', () => {
  const r = parseRequest('שעת הגשה: 19:30\nהערות: שורה ראשונה\nשורה שנייה', DEFAULT_SETTINGS, now);
  assert.equal(r.values.startTime, '19:30');
  assert.equal(r.values.notes, 'שורה ראשונה\nשורה שנייה');
});
