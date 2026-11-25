// טופס בחירת מנות ללקוח (דף ציבורי, בלי כניסה).
// הקישור מכיל קוד אקראי; הדף קורא רק את הטופס של הקוד הזה ושולח את הבחירה – דרך שתי פונקציות ב-Supabase.
import { supabaseConfig } from './config.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const token = new URLSearchParams(location.search).get('t') || '';
const app = $('#app');

async function rpc(fn, body) {
  const res = await fetch(`${supabaseConfig.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: supabaseConfig.anonKey,
      Authorization: `Bearer ${supabaseConfig.anonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.message || `שגיאה ${res.status}`);
    err.code = data?.message;
    throw err;
  }
  return data;
}

function message(title, text) {
  app.innerHTML = `<section class="card center"><h1>${esc(title)}</h1><p>${text}</p></section>`;
}

const GROUPS = [
  { key: 'starters', title: 'ראשונות וסלטים', word: 'מנות ראשונות' },
  { key: 'pizzas', title: 'פיצות', word: 'סוגי פיצות' },
  { key: 'desserts', title: 'קינוחים', word: 'קינוחים', optional: true },
];

function header(d) {
  return `<header class="head">
    <img src="${esc(d.logo || 'assets/logo.png')}" alt="" onerror="this.src='assets/logo.png'">
    <div>
      <div class="kicker">${esc(d.title || 'PIZZA-BAR')}</div>
      <h1>בחירת מנות לאירוע</h1>
      <div class="sub">${esc([d.eventType, d.date].filter(Boolean).join(' · '))}${d.number ? ` · הצעה ${esc(d.number)}` : ''}</div>
    </div>
  </header>`;
}

function summary(d, sub) {
  return GROUPS.map((g) => {
    const names = sub?.[g.key] || [];
    return names.length ? `<h3>${esc(g.title)}</h3><ul class="sum">${names.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
  }).join('') + (sub?.notes ? `<h3>הערות</h3><p>${esc(sub.notes)}</p>` : '');
}

function renderForm(form) {
  const d = form.data;
  const need = d.need || {};
  const groups = GROUPS.filter((g) => (d.menu?.[g.key] || []).length && (g.optional || need[g.key] > 0));
  const start = form.submission || d.preset || {};
  const picked = Object.fromEntries(
    groups.map((g) => {
      const valid = d.menu[g.key].map((x) => x.name);
      const list = (start[g.key] || []).filter((n) => valid.includes(n));
      return [g.key, g.optional ? list : list.slice(0, need[g.key])];
    })
  );
  let tried = false;

  app.innerHTML = `
    ${header(d)}
    <section class="card intro">
      <p>שלום ${esc(d.name)} 👋</p>
      <p>לקראת האירוע – נשמח שתבחרו את המנות. מסמנים את המנות הרצויות בכל קטגוריה ולוחצים "שליחת הבחירה" בתחתית הדף.</p>
      ${form.submitted_at ? '<p class="note">כבר קיבלנו מכם בחירה. אפשר לעדכן אותה ולשלוח שוב.</p>' : ''}
    </section>
    ${groups
      .map(
        (g) => `<section class="card group" data-group="${g.key}">
          <h2>${esc(g.title)}</h2>
          <p class="need" data-need="${g.key}"></p>
          <div class="items">
            ${d.menu[g.key]
              .map(
                (it) => `<label class="item">
                  <input type="checkbox" data-key="${g.key}" value="${esc(it.name)}" ${picked[g.key].includes(it.name) ? 'checked' : ''}>
                  <span class="box" aria-hidden="true"></span>
                  <span class="txt"><b>${esc(it.name)}</b>${it.desc ? `<small>${esc(it.desc)}</small>` : ''}</span>
                </label>`
              )
              .join('')}
          </div>
        </section>`
      )
      .join('')}
    <section class="card">
      <h2>הערות (רשות)</h2>
      <textarea id="notes" rows="3" maxlength="1000" placeholder="רגישויות, בקשות מיוחדות…">${esc(form.submission?.notes || '')}</textarea>
    </section>
    ${d.contact ? `<p class="contact">שאלות? ${esc(d.contact)}</p>` : ''}
    <div class="bar">
      <div id="status"></div>
      <button id="send" class="btn">שליחת הבחירה</button>
    </div>`;

  const needText = (g) => {
    const n = picked[g.key].length;
    if (g.optional) return n ? `רשות · נבחרו ${n}` : 'רשות – אפשר לבחור או לדלג';
    return n === need[g.key] ? `✓ נבחרו ${n} מתוך ${need[g.key]}` : `יש לבחור ${need[g.key]} ${g.word} · נבחרו ${n}`;
  };
  const complete = (g) => g.optional || picked[g.key].length === need[g.key];
  const draw = () => {
    for (const g of groups) {
      const el = $(`[data-need="${g.key}"]`);
      el.textContent = needText(g);
      el.className = `need ${complete(g) && !g.optional ? 'ok' : !complete(g) && tried ? 'err' : ''}`;
      $(`[data-group="${g.key}"]`).classList.toggle('missing', tried && !complete(g));
    }
    const left = groups.filter((g) => !complete(g));
    $('#status').textContent = left.length
      ? left.map((g) => `${g.title}: ${picked[g.key].length}/${need[g.key]}`).join(' · ')
      : '✓ הכול נבחר';
    $('#status').className = left.length ? '' : 'ok';
  };
  draw();

  app.addEventListener('change', (e) => {
    const el = e.target;
    const key = el.dataset.key;
    if (!key) return;
    const g = groups.find((x) => x.key === key);
    const now = $$(`[data-key="${key}"]:checked`).map((x) => x.value);
    if (!g.optional && now.length > need[key]) {
      el.checked = false;
      flash(`אפשר לבחור עד ${need[key]} ${g.word}. כדי להחליף – בטלו קודם בחירה אחרת.`);
      return;
    }
    picked[key] = now;
    draw();
  });

  $('#send').addEventListener('click', async () => {
    tried = true;
    draw();
    const missing = groups.find((g) => !complete(g));
    if (missing) {
      flash(`עוד לא הושלמה הבחירה: ${needText(missing)}`);
      $(`[data-group="${missing.key}"]`).scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const btn = $('#send');
    btn.disabled = true;
    btn.textContent = 'שולח…';
    const choice = { pizzas: picked.pizzas || [], starters: picked.starters || [], desserts: picked.desserts || [], notes: $('#notes').value.trim() };
    try {
      await rpc('pb_submit_form', { form_token: token, choice });
      app.innerHTML = `${header(d)}
        <section class="card center thanks">
          <div class="big">🎉</div>
          <h1>תודה ${esc(d.name)}!</h1>
          <p>הבחירה שלכם התקבלה. נעבור עליה ונשלח לכם אישור הזמנה מסודר.</p>
        </section>
        <section class="card">${summary(d, choice)}</section>`;
      window.scrollTo(0, 0);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'שליחת הבחירה';
      if (/locked/.test(err.message)) flash('הבחירה כבר אושרה ועברה להכנה. לשינויים צרו איתנו קשר.');
      else flash('השליחה נכשלה – בדקו את החיבור לאינטרנט ונסו שוב.');
    }
  });
}

let flashTimer;
function flash(text) {
  let el = $('#flash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'flash';
    document.body.append(el);
  }
  el.textContent = text;
  el.className = 'show';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (el.className = ''), 4000);
}

async function start() {
  if (!token || !supabaseConfig.url) return message('הקישור לא תקין', 'נראה שהקישור חסר או שגוי. בקשו מאיתנו קישור חדש.');
  let form;
  try {
    form = await rpc('pb_get_form', { form_token: token });
  } catch {
    return message('לא הצלחנו לטעון את הטופס', 'בדקו את החיבור לאינטרנט ורעננו את הדף.');
  }
  if (!form?.data) return message('הטופס לא נמצא', 'ייתכן שהקישור ישן. בקשו מאיתנו קישור חדש.');
  if (form.locked) {
    app.innerHTML = `${header(form.data)}
      <section class="card center"><h1>הבחירה כבר התקבלה ✓</h1>
        <p>הבחירה שלכם אושרה ועברה להכנה. לשינויים צרו איתנו קשר${form.data.contact ? `: ${esc(form.data.contact)}` : '.'}</p></section>
      <section class="card">${summary(form.data, form.submission)}</section>`;
    return;
  }
  renderForm(form);
}

start();
