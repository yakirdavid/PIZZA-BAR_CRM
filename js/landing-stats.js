// מדדי דף הנחיתה: חישוב מאירועי הביקור (טבלת pb_lp_events) ותצוגה במסך "דף נחיתה"
import { esc } from './quote-render.js';

// סדר הסקשנים בדף הנחיתה (המפתחות תואמים ל-data-track בדף)
export const SECTIONS = [
  ['hero', 'פתיח'],
  ['food', 'למה הפיצה שלנו אחרת'],
  ['menu', 'תפריט'],
  ['reviews', 'ממליצים'],
  ['how', 'איך זה עובד'],
  ['events', 'אירועים'],
  ['about', 'מי אנחנו'],
  ['quote', 'טופס בדיקת זמינות'],
  ['faq', 'שאלות נפוצות'],
  ['cta', 'פס סיום'],
  ['footer', 'תחתית הדף'],
];
const SECTION_INDEX = Object.fromEntries(SECTIONS.map(([k], i) => [k, i]));
const sectionLabel = (k) => SECTIONS[SECTION_INDEX[k]]?.[1] || k;

const SOURCE_LABELS = { instagram: 'אינסטגרם', whatsapp: 'וואטסאפ', facebook: 'פייסבוק', google: 'גוגל', tiktok: 'טיקטוק', direct: 'ישיר / לא ידוע' };
const CLICK_LABELS = {
  whatsapp: 'וואטסאפ',
  phone: 'חיוג',
  instagram: 'אינסטגרם',
  'instagram:about': 'אינסטגרם: "עוד תמונות" (מי אנחנו)',
  'instagram:quote': 'אינסטגרם: ליד הטופס',
  'instagram:footer': 'אינסטגרם: תחתית הדף',
  'cta:quote': 'כפתור בדיקת זמינות',
  'cta:menu': 'כפתור לתפריט',
  'tab:pizza': 'לשונית פיצות',
  'tab:starters': 'לשונית מנות ראשונות',
  'tab:dessert': 'לשונית קינוחים',
};
const clickLabel = (n) =>
  CLICK_LABELS[n] || (n.startsWith('package:') ? `בחירת מסלול: ${n.slice(8)}` : n.startsWith('nav:') ? `תפריט עליון: ${sectionLabel(n.slice(4))}` : n);

const CONTACT_CLICKS = new Set(['whatsapp', 'phone']);
const isInstagram = (name) => name === 'instagram' || String(name).startsWith('instagram:');
const MAX_TIME = 30 * 60 * 1000; // ביקור ארוך מזה (טאב שנשכח פתוח) נספר כ-30 דקות
const QUICK_EXIT = 10 * 1000;

const dayKey = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const countBy = (items, key) => {
  const m = new Map();
  for (const it of items) {
    const k = key(it);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

// events: שורות מהטבלה. days: מספר הימים בטווח (לגרף היומי), או null לכל התקופה
export function summarizeLanding(events, { days = null, now = new Date() } = {}) {
  const sessions = new Map();
  const clickEvents = [];
  for (const e of events) {
    let s = sessions.get(e.session);
    if (!s) {
      s = { id: e.session, visitor: e.visitor, start: e.created_at, dev: '', src: '', seen: new Set(), deepest: -1, time: 0, scroll: 0, lead: false, contact: false, instagram: false, clicks: 0 };
      sessions.set(e.session, s);
    }
    if (e.created_at < s.start) s.start = e.created_at;
    const d = e.data || {};
    if (e.type === 'view') {
      s.dev = d.dev || s.dev;
      s.src = d.src || s.src;
    } else if (e.type === 'section' && e.name in SECTION_INDEX) {
      s.seen.add(e.name);
      s.deepest = Math.max(s.deepest, SECTION_INDEX[e.name]);
    } else if (e.type === 'leave') {
      s.time = Math.max(s.time, Number(e.value) || 0);
      s.scroll = Math.max(s.scroll, Number(d.scroll) || 0);
    } else if (e.type === 'click') {
      s.clicks++;
      clickEvents.push(e.name || '');
      if (CONTACT_CLICKS.has(e.name)) s.contact = true;
      if (isInstagram(e.name)) s.instagram = true;
    } else if (e.type === 'lead') {
      s.lead = true;
    }
  }

  const list = [...sessions.values()];
  const n = list.length;
  const pct = (x, of = n) => (of ? x / of : 0);
  const timed = list.filter((s) => s.time > 0).map((s) => Math.min(s.time, MAX_TIME));
  const leads = list.filter((s) => s.lead).length;
  const contacts = list.filter((s) => s.contact).length;
  const engaged = list.filter((s) => s.lead || s.contact).length;
  const instagram = list.filter((s) => s.instagram).length;
  const quick = list.filter((s) => s.time > 0 && s.time < QUICK_EXIT && !s.clicks && !s.lead).length;

  // גרף יומי: כל יום בטווח, גם ימים בלי כניסות
  const perDay = new Map(countBy(list, (s) => dayKey(s.start)));
  const firstDay = days ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1) : list.length ? new Date(dayKey(list.reduce((a, s) => (s.start < a ? s.start : a), list[0].start))) : now;
  const daily = [];
  for (let d = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate()); d <= now; d.setDate(d.getDate() + 1)) {
    const k = dayKey(d);
    daily.push({ day: k, sessions: perDay.get(k) || 0 });
  }

  // עד לאן הגיעו: אחוז הביקורים שראו כל סקשן
  const reach = SECTIONS.map(([k, label]) => {
    const c = list.filter((s) => s.seen.has(k)).length;
    return { key: k, label, count: c, share: pct(c) };
  });

  // איפה עזבו: הסקשן העמוק ביותר שנצפה, בביקורים שלא הסתיימו בפנייה
  const leavers = list.filter((s) => !s.lead && !s.contact && s.deepest >= 0);
  const exits = SECTIONS.map(([k, label], i) => {
    const c = leavers.filter((s) => s.deepest === i).length;
    return { key: k, label, count: c, share: pct(c, leavers.length) };
  });
  const topExit = exits.reduce((a, b) => (b.count > a.count ? b : a), exits[0]);

  return {
    sessions: n,
    visitors: new Set(list.map((s) => s.visitor)).size,
    leads,
    leadRate: pct(leads),
    contacts,
    contactRate: pct(contacts),
    engaged,
    engagedRate: pct(engaged),
    instagram,
    instagramRate: pct(instagram),
    instagramClicks: clickEvents.filter(isInstagram).length,
    avgTime: timed.length ? timed.reduce((a, b) => a + b, 0) / timed.length : 0,
    medianTime: median(timed),
    quickRate: pct(quick, timed.length),
    avgScroll: timed.length ? list.filter((s) => s.time > 0).reduce((a, s) => a + s.scroll, 0) / timed.length : 0,
    mobileRate: pct(list.filter((s) => s.dev === 'mobile').length),
    daily,
    reach,
    exits,
    leavers: leavers.length,
    topExit: topExit && topExit.count ? topExit : null,
    sources: countBy(list, (s) => s.src || 'direct').map(([k, c]) => ({ key: k, label: SOURCE_LABELS[k] || k, count: c, share: pct(c) })),
    clicks: countBy(clickEvents, (k) => k).map(([k, c]) => ({ key: k, label: clickLabel(k), count: c })),
    // ביקורים אחרונים (החדש קודם), כדי לזהות ולמחוק כניסות של בעלי העסק
    recent: [...list]
      .sort((a, b) => (b.start > a.start ? 1 : -1))
      .slice(0, 30)
      .map((s) => ({
        session: s.id,
        start: s.start,
        source: SOURCE_LABELS[s.src || 'direct'] || s.src,
        device: s.dev === 'mobile' ? 'טלפון' : s.dev === 'desktop' ? 'מחשב' : '—',
        time: s.time,
        deepest: s.deepest >= 0 ? SECTIONS[s.deepest][1] : '—',
        outcome: [s.lead && 'טופס', s.contact && 'וואטסאפ / חיוג', s.instagram && 'אינסטגרם'].filter(Boolean).join(', ') || '—',
      })),
  };
}

// ---------- תצוגה ----------
const fmtInt = (x) => Math.round(x).toLocaleString('he-IL');
const fmtPct = (x) => `${Math.round(x * 100)}%`;
const fmtTime = (ms) => {
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec} שנ׳` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} דק׳`;
};
const fmtDay = (k) => {
  const [, m, d] = k.split('-');
  return `${Number(d)}.${Number(m)}`;
};
const fmtWhen = (iso) => {
  const d = new Date(iso);
  return `${d.getDate()}.${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function recentVisits(rows) {
  return `<details class="card lp-card lp-recent"><summary><b>ביקורים אחרונים</b> <span class="hint">(נכנסתם בעצמכם? אפשר למחוק את הביקור מכאן)</span></summary>
    ${table(
      ['זמן', 'מקור', 'מכשיר', 'זמן בדף', 'הגיעו עד', 'פעולה', ''],
      rows.map((r) => [
        fmtWhen(r.start),
        esc(r.source),
        r.device,
        r.time ? fmtTime(r.time) : '—',
        esc(r.deepest),
        esc(r.outcome),
        `<button class="btn small ghost danger" data-del-session="${esc(r.session)}" title="מחיקת הביקור הזה">מחיקה</button>`,
      ])
    )}
  </details>`;
}

const RANGES = [
  ['7', '7 ימים אחרונים'],
  ['30', '30 ימים אחרונים'],
  ['90', '90 ימים אחרונים'],
  ['all', 'כל התקופה'],
];
const LANDING_URL = 'https://yakirdavid.github.io/PIZZA-BAR_LandingPage/';

function tile(label, value, sub = '') {
  return `<div class="lp-tile"><span class="lp-tile-label">${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
}

// נבנה ברוחב האמיתי של הכרטיס, כדי שהעמודות והטקסט יישארו בגודל קבוע
function dailyChart(daily, width) {
  const W = Math.max(280, Math.round(width)), H = 200, padL = 34, padB = 26, padT = 10;
  const max = Math.max(1, ...daily.map((d) => d.sessions));
  const top = max <= 4 ? 4 : Math.ceil(max / 4) * 4; // ארבע קפיצות שוות של מספרים שלמים
  const ticks = [0, top / 4, top / 2, (top * 3) / 4, top];
  const slot = (W - padL) / daily.length;
  const bw = Math.min(24, Math.max(2, slot - 2));
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const labelEvery = Math.ceil(daily.length / Math.max(2, Math.floor((W - padL) / 56)));
  const bars = daily
    .map((d, i) => {
      const x = padL + i * slot + (slot - bw) / 2;
      const h = y(0) - y(d.sessions);
      const r = Math.min(4, h, bw / 2);
      const path = h > 0 ? `M${x},${y(0)} v${-(h - r)} q0,${-r} ${r},${-r} h${bw - 2 * r} q${r},0 ${r},${r} v${h - r} z` : '';
      const tip = `${fmtDay(d.day)}: ${fmtInt(d.sessions)} כניסות`;
      return `<g class="lp-col" tabindex="0" data-tip="${tip}" aria-label="${tip}">
        <rect x="${padL + i * slot}" y="${padT}" width="${slot}" height="${H - padT - padB}" fill="transparent"/>
        ${path ? `<path d="${path}"/>` : ''}
        ${i % labelEvery === 0 ? `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${fmtDay(d.day)}</text>` : ''}
      </g>`;
    })
    .join('');
  const grid = ticks.map((t) => `<line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${fmtInt(t)}</text>`).join('');
  return `<svg class="lp-daily" viewBox="0 0 ${W} ${H}" dir="ltr" role="img" aria-label="כניסות לפי יום"><g class="lp-grid">${grid}</g>${bars}</svg>`;
}

function meterRows(rows, { highlight = null, of = 'מהכניסות' } = {}) {
  const max = Math.max(...rows.map((r) => r.share), 0.0001);
  return `<div class="lp-meters">${rows
    .map((r) => {
      const hot = highlight && r.key === highlight;
      const tip = `${r.label}: ${fmtInt(r.count)} (${fmtPct(r.share)} ${of})`;
      return `<div class="lp-meter ${hot ? 'hot' : ''}" tabindex="0" data-tip="${esc(tip)}">
        <span class="lp-meter-name">${esc(r.label)}${hot ? ' <em>כאן הכי הרבה עוזבים</em>' : ''}</span>
        <span class="lp-meter-track"><i style="width:${(r.share / max) * 100}%"></i></span>
        <span class="lp-meter-val">${fmtPct(r.share)}</span>
      </div>`;
    })
    .join('')}</div>`;
}

function insights(st) {
  const out = [];
  if (st.topExit) out.push(`מי שלא פנה אליכם עזב בעיקר באזור <b>${esc(st.topExit.label)}</b> (${fmtPct(st.topExit.share)} מהביקורים בלי פנייה).`);
  const form = st.reach.find((r) => r.key === 'quote');
  if (form) out.push(`<b>${fmtPct(form.share)}</b> מהמבקרים הגיעו עד הטופס, ו־<b>${fmtPct(st.leadRate)}</b> שלחו אותו.`);
  const menu = st.reach.find((r) => r.key === 'menu');
  if (menu) out.push(`<b>${fmtPct(menu.share)}</b> מהמבקרים ראו את התפריט.`);
  out.push(`<b>${fmtPct(st.mobileRate)}</b> מהכניסות הן מהטלפון, אז חשוב שהדף ייראה טוב קודם כל בנייד.`);
  return `<ul class="lp-insights">${out.map((x) => `<li>${x}</li>`).join('')}</ul>`;
}

function table(head, rows) {
  return rows.length
    ? `<table class="quotes lp-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr>${r.map((c, i) => `<td data-l="${head[i]}">${c}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`
    : `<p class="hint">אין נתונים בטווח הזה.</p>`;
}

function setupHelp() {
  return `<div class="card lp-setup">
    <h2>חיבור מדדי דף הנחיתה (פעם אחת)</h2>
    <ol>
      <li>נכנסים ל-<a href="https://supabase.com/dashboard" target="_blank" rel="noopener">Supabase</a>, לפרויקט של המערכת.</li>
      <li><b>SQL Editor → New query</b>: מדביקים את כל התוכן של הקובץ <code>supabase-landing.sql</code> מהמאגר ולוחצים <b>Run</b>.</li>
      <li>חוזרים לכאן ומרעננים. מהרגע הזה כל כניסה לדף הנחיתה תיספר.</li>
    </ol>
    <p class="hint">הטבלה שומרת רק נתוני ביקור אנונימיים (בלי שמות ובלי טלפונים). דף הנחיתה יכול רק להוסיף שורות, ורק אתם רואים אותן.</p>
  </div>`;
}

function bindTips(root) {
  let tip = document.querySelector('.lp-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'lp-tip';
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  const show = (el, x, y) => {
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(Math.max(8, x - r.width / 2), innerWidth - r.width - 8)}px`;
    tip.style.top = `${Math.max(8, y - r.height - 12)}px`;
  };
  root.addEventListener('pointermove', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el) show(el, e.clientX, e.clientY);
    else tip.hidden = true;
  });
  root.addEventListener('pointerleave', () => (tip.hidden = true));
  root.addEventListener('focusin', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    show(el, r.left + r.width / 2, r.top);
  });
  root.addEventListener('focusout', () => (tip.hidden = true));
}

export async function renderLanding(main, store, { range = '30', onRange, toast } = {}) {
  main.innerHTML = `
    <div class="page-head">
      <h1>מדדי דף הנחיתה</h1>
      <div class="head-actions">
        <select id="lp-range">${RANGES.map(([v, l]) => `<option value="${v}" ${v === range ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <a class="btn ghost" href="${LANDING_URL}" target="_blank" rel="noopener">לדף הנחיתה ↗</a>
      </div>
    </div>
    <div id="lp-body"><div class="empty"><span class="spinner small"></span> טוען נתונים...</div></div>`;
  main.querySelector('#lp-range').addEventListener('change', (e) => onRange?.(e.target.value));
  const body = main.querySelector('#lp-body');

  if (!store.listLandingEvents) {
    body.innerHTML = `<div class="empty"><p>מדדי דף הנחיתה זמינים רק כשהמערכת מחוברת ל-Supabase (ראו README).</p></div>`;
    return;
  }
  const days = range === 'all' ? null : Number(range);
  let events;
  try {
    events = await store.listLandingEvents(days ? new Date(Date.now() - days * 864e5).toISOString() : null);
  } catch (err) {
    body.innerHTML = err.code === 'no-table' ? setupHelp() : `<div class="empty"><p>שגיאה בטעינת המדדים: ${esc(err.message)}</p></div>`;
    return;
  }
  const st = summarizeLanding(events, { days });

  if (!st.sessions) {
    body.innerHTML = `<div class="empty">
      <p>עדיין אין כניסות בטווח הזה.</p>
      <p class="hint">כניסות מדפדפן שמחובר למערכת הזו לא נספרות (ראו למטה).</p>
    </div>${trackingTips()}`;
    return;
  }

  body.innerHTML = `
    <div class="lp-tiles">
      ${tile('כניסות', fmtInt(st.sessions), `${fmtInt(st.visitors)} מבקרים שונים`)}
      ${tile('פניות', fmtInt(st.engaged), `${fmtPct(st.engagedRate)} מהכניסות`)}
      ${tile('שלחו טופס', fmtInt(st.leads), `${fmtPct(st.leadRate)} מהכניסות`)}
      ${tile('לחצו וואטסאפ / חיוג', fmtInt(st.contacts), `${fmtPct(st.contactRate)} מהכניסות`)}
      ${tile('עברו לאינסטגרם', fmtInt(st.instagram), `${fmtPct(st.instagramRate)} מהכניסות · ${fmtInt(st.instagramClicks)} לחיצות`)}
      ${tile('זמן ממוצע בדף', fmtTime(st.avgTime), `חציון ${fmtTime(st.medianTime)}`)}
      ${tile('יצאו תוך 10 שניות', fmtPct(st.quickRate), `גלילה ממוצעת ${fmtPct(st.avgScroll / 100)}`)}
    </div>

    <div class="card lp-card"><h2>מה רואים בנתונים</h2>${insights(st)}</div>

    <div class="card lp-card">
      <h2>כניסות לפי יום</h2>
      <div class="lp-daily-wrap"></div>
      <details class="sub"><summary>הצגה כטבלה</summary>${table(['יום', 'כניסות'], st.daily.map((d) => [fmtDay(d.day), fmtInt(d.sessions)]))}</details>
    </div>

    <div class="lp-two">
      <div class="card lp-card">
        <h2>עד לאן גללו</h2>
        <p class="hint">אחוז הכניסות שהגיעו לכל חלק בדף, לפי הסדר מלמעלה למטה.</p>
        ${meterRows(st.reach)}
      </div>
      <div class="card lp-card">
        <h2>איפה עזבו</h2>
        <p class="hint">${fmtInt(st.leavers)} כניסות שלא הסתיימו בפנייה: החלק האחרון שראו לפני שיצאו.</p>
        ${meterRows(st.exits.filter((r) => r.count), { highlight: st.topExit?.key, of: 'מהיוצאים' })}
      </div>
    </div>

    <div class="lp-two">
      <div class="card lp-card"><h2>מאיפה הגיעו</h2>${table(['מקור', 'כניסות', 'אחוז'], st.sources.map((r) => [esc(r.label), fmtInt(r.count), fmtPct(r.share)]))}</div>
      <div class="card lp-card"><h2>על מה לחצו</h2>${table(['כפתור', 'לחיצות'], st.clicks.map((r) => [esc(r.label), fmtInt(r.count)]))}</div>
    </div>

    ${recentVisits(st.recent)}
    ${trackingTips()}
    <p class="lp-clear"><button class="btn small ghost danger" id="lp-clear">מחיקת כל נתוני המדדים</button></p>`;

  const wrap = body.querySelector('.lp-daily-wrap');
  wrap.innerHTML = dailyChart(st.daily, wrap.clientWidth);
  bindTips(body);
  const remove = async (run, done) => {
    try {
      await run();
      toast?.(done);
      onRange?.(range);
    } catch (err) {
      if (err.code === 'not-deleted') {
        body.insertAdjacentHTML('afterbegin', deleteHelp());
        body.querySelector('.lp-setup')?.scrollIntoView({ behavior: 'smooth' });
        toast?.('המחיקה לא בוצעה: חסרה הרשאת מחיקה ב-Supabase', 'error');
      } else toast?.('שגיאה במחיקה: ' + err.message, 'error');
    }
  };
  body.querySelectorAll('[data-del-session]').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (confirm('למחוק את הביקור הזה מהמדדים?')) remove(() => store.deleteLandingSession(btn.dataset.delSession), 'הביקור נמחק');
    })
  );
  body.querySelector('#lp-clear').addEventListener('click', () => {
    if (confirm('למחוק את כל נתוני המדדים של דף הנחיתה? אי אפשר לבטל את זה.')) remove(() => store.clearLandingEvents(), 'נתוני המדדים נמחקו');
  });
}

// המחיקה נחסמה: בדרך כלל כי החלק האחרון של supabase-landing.sql לא רץ
function deleteHelp() {
  if (document.querySelector('.lp-setup')) return '';
  return `<div class="card lp-card lp-setup">
    <h2>המחיקה לא בוצעה</h2>
    <p>למסד הנתונים חסרה הרשאת מחיקה לטבלת המדדים. כדי לתקן (פעם אחת):</p>
    <ol>
      <li>ב-Supabase נכנסים ל-<b>SQL Editor → New query</b>.</li>
      <li>מדביקים את שלוש השורות האלה ולוחצים <b>Run</b>:
        <pre dir="ltr">drop policy if exists "owner deletes" on public.pb_lp_events;
create policy "owner deletes" on public.pb_lp_events for delete to authenticated using (true);
grant select, insert, delete on public.pb_lp_events to authenticated;</pre></li>
      <li>חוזרים לכאן ומוחקים שוב.</li>
    </ol>
  </div>`;
}

function trackingTips() {
  return `<details class="card lp-card lp-tips"><summary><b>טיפים: לדעת מאיפה הגיעו ולא לספור את עצמכם</b></summary>
    <ul>
      <li>כדי לדעת מאיזה ערוץ הגיעו, שתפו קישור עם תוספת קצרה בסוף:
        <br>באינסטגרם: <code dir="ltr">${LANDING_URL}?src=instagram</code>
        <br>בוואטסאפ: <code dir="ltr">${LANDING_URL}?src=whatsapp</code>
        <br>בפייסבוק: <code dir="ltr">${LANDING_URL}?src=facebook</code></li>
      <li>כניסות לדף הנחיתה מדפדפן שמחובר למערכת הזו לא נספרות, אוטומטית. זה עובד בכל דפדפן שבו נכנסתם למערכת (ספארי, כרום במחשב וכו׳).</li>
      <li>הדפדפן הפנימי של אינסטגרם, וואטסאפ ופייסבוק הוא דפדפן נפרד שלא יודע שנכנסתם למערכת, ולכן כניסה דרכו כן נספרת. מחקו אותה ברשימה "ביקורים אחרונים". אפשר גם לפתוח פעם אחת בתוך האפליקציה את <code dir="ltr">${LANDING_URL}?notrack</code>.</li>
      <li>הנתונים אנונימיים: לא נשמרים שמות, טלפונים או תוכן הטופס.</li>
    </ul>
  </details>`;
}
