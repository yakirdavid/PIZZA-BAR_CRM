import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLanding } from '../js/landing-stats.js';

const t0 = '2026-11-10T10:00:00.000Z';
const ev = (session, type, name = null, value = null, data = null, visitor = 'v-' + session) => ({
  created_at: t0,
  visitor,
  session,
  type,
  name,
  value,
  data,
});

// שלוש כניסות: אחת השאירה פרטים, אחת לחצה וואטסאפ, אחת עזבה בתפריט
const events = [
  ev('s1aaaaaa', 'view', null, null, { dev: 'mobile', src: 'instagram' }),
  ev('s1aaaaaa', 'section', 'hero'),
  ev('s1aaaaaa', 'section', 'food'),
  ev('s1aaaaaa', 'section', 'menu'),
  ev('s1aaaaaa', 'section', 'quote'),
  ev('s1aaaaaa', 'lead', 'quote_form'),
  ev('s1aaaaaa', 'leave', null, 120000, { scroll: 80 }),

  ev('s2bbbbbb', 'view', null, null, { dev: 'desktop' }, 'v-s1aaaaaa'),
  ev('s2bbbbbb', 'section', 'hero'),
  ev('s2bbbbbb', 'click', 'whatsapp'),
  ev('s2bbbbbb', 'leave', null, 30000, { scroll: 10 }),

  ev('s3cccccc', 'view', null, null, { dev: 'mobile', src: 'whatsapp' }),
  ev('s3cccccc', 'section', 'hero'),
  ev('s3cccccc', 'section', 'food'),
  ev('s3cccccc', 'section', 'menu'),
  ev('s3cccccc', 'leave', null, 5000, { scroll: 40 }),
  ev('s3cccccc', 'leave', null, 8000, { scroll: 45 }), // יציאה שנייה מאותו ביקור: נלקח המקסימום
];

test('counts sessions, visitors, leads and contacts', () => {
  const st = summarizeLanding(events, { days: 7, now: new Date('2026-11-12T12:00:00Z') });
  assert.equal(st.sessions, 3);
  assert.equal(st.visitors, 2); // s1 ו-s2 מאותו מבקר
  assert.equal(st.leads, 1);
  assert.equal(st.contacts, 1);
  assert.equal(st.engaged, 2);
  assert.ok(Math.abs(st.mobileRate - 2 / 3) < 1e-9);
});

test('time uses the longest leave per session and caps runaway tabs', () => {
  const st = summarizeLanding(events);
  assert.equal(st.avgTime, (120000 + 30000 + 8000) / 3);
  assert.equal(st.medianTime, 30000);
  // s3 נשאר 8 שניות בלי לחיצה: יציאה מהירה אחת מתוך שלוש
  assert.ok(Math.abs(st.quickRate - 1 / 3) < 1e-9);
  const long = summarizeLanding([ev('s9zzzzzz', 'leave', null, 5 * 3600 * 1000)]);
  assert.equal(long.avgTime, 30 * 60 * 1000);
});

test('reach and exit point by section', () => {
  const st = summarizeLanding(events);
  const reach = Object.fromEntries(st.reach.map((r) => [r.key, r.count]));
  assert.equal(reach.hero, 3);
  assert.equal(reach.menu, 2);
  assert.equal(reach.quote, 1);
  // רק s3 עזב בלי פנייה, והחלק העמוק ביותר שראה הוא התפריט
  assert.equal(st.leavers, 1);
  assert.equal(st.topExit.key, 'menu');
  assert.equal(st.topExit.share, 1);
});

test('sources default to direct and clicks are labeled', () => {
  const st = summarizeLanding(events);
  const src = Object.fromEntries(st.sources.map((r) => [r.key, r.count]));
  assert.deepEqual(src, { instagram: 1, direct: 1, whatsapp: 1 });
  assert.equal(st.clicks[0].label, 'וואטסאפ');
});

test('daily series covers every day in the range, including empty days', () => {
  const st = summarizeLanding(events, { days: 7, now: new Date(2026, 10, 12, 12) });
  assert.equal(st.daily.length, 7);
  assert.equal(st.daily.reduce((a, d) => a + d.sessions, 0), 3);
});

test('empty input', () => {
  const st = summarizeLanding([], { days: 30 });
  assert.equal(st.sessions, 0);
  assert.equal(st.topExit, null);
  assert.equal(st.daily.length, 30);
});
