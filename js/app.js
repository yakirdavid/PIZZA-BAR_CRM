import { createStore, isCloud } from './store.js';
import { DEFAULT_SETTINGS, STATUSES, clone, withDefaults } from './defaults.js';
import { calcQuote, formatILS, formatGuests, formatDuration } from './pricing.js';
import { esc, formatDate, eventTypeLabel, renderPages, pagesToPdf } from './quote-render.js';

// ---------- עזרים ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const setPath = (o, p, v) => {
  const ks = p.split('.');
  let a = o;
  for (const k of ks.slice(0, -1)) a = a[k] ??= {};
  a[ks.at(-1)] = v;
};
const today = () => new Date().toISOString().slice(0, 10);
const statusLabel = (id) => STATUSES.find((s) => s.id === id)?.label || id;
const normPhone = (p) => String(p || '').replace(/\D/g, '');

function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3000);
}

function busy(on, text = 'רגע...') {
  $('#busy').hidden = !on;
  $('#busy-text').textContent = text;
}

// שדה טופס מקושר לנתיב באובייקט
function field(label, path, obj, o = {}) {
  const v = getPath(obj, path) ?? '';
  const id = 'f_' + path.replace(/\./g, '_');
  const attrs = `id="${id}" data-bind="${path}" ${o.type === 'number' ? 'data-type="number" inputmode="decimal"' : ''} ${
    o.rerender ? 'data-rerender="1"' : ''
  } ${o.required ? 'required' : ''} ${o.placeholder ? `placeholder="${esc(o.placeholder)}"` : ''}`;
  let input;
  if (o.options) {
    input = `<select ${attrs}>${o.options
      .map((op) => {
        const [val, lab] = Array.isArray(op) ? op : [op, op];
        return `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(lab)}</option>`;
      })
      .join('')}</select>`;
  } else if (o.type === 'textarea') {
    input = `<textarea ${attrs} rows="${o.rows || 3}">${esc(v)}</textarea>`;
  } else {
    input = `<input type="${o.type || 'text'}" ${attrs} value="${esc(v)}" ${o.step ? `step="${o.step}"` : ''} ${
      o.min != null ? `min="${o.min}"` : ''
    } ${o.dir ? `dir="${o.dir}"` : ''}>`;
  }
  return `<label class="field ${o.cls || ''}" for="${id}"><span>${esc(label)}${o.required ? ' *' : ''}</span>${input}${
    o.hint ? `<small>${o.hint}</small>` : ''
  }</label>`;
}

function bindForm(root, obj, onChange) {
  const handler = (e) => {
    const el = e.target;
    if (el.dataset.bind) {
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (el.dataset.type === 'number') v = v === '' ? '' : Number(v);
      setPath(obj, el.dataset.bind, v);
    } else if (el.dataset.bindLines) {
      setPath(
        obj,
        el.dataset.bindLines,
        el.value.split('\n').map((l) => l.trim()).filter(Boolean)
      );
    } else return;
    onChange(el, e.type);
  };
  root.addEventListener('input', handler);
  root.addEventListener('change', handler);
}

// ---------- מצב ----------
const state = {
  store: null,
  settings: null,
  quotes: [],
  dirty: false,
  listFilter: { q: '', status: '', type: '', sort: 'created' },
};
const images = {}; // ref → url

async function resolveImages(refs) {
  const out = {};
  for (const [k, ref] of Object.entries(refs || {})) {
    if (!(ref in images)) images[ref] = await state.store.resolveImage(ref);
    out[k] = images[ref];
  }
  return out;
}

async function loadData() {
  state.settings = withDefaults(await state.store.getSettings());
  state.quotes = await state.store.listQuotes();
}

// ---------- ניווט ----------
function go(hash) {
  location.hash = hash;
}

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) e.preventDefault();
});

let lastHash = location.hash;
window.addEventListener('hashchange', () => {
  if (state.dirty && !confirm('יש שינויים שלא נשמרו. לצאת בלי לשמור?')) {
    history.replaceState(null, '', lastHash || '#/');
    return;
  }
  state.dirty = false;
  route();
});

async function route() {
  lastHash = location.hash;
  const [, page, id] = (location.hash || '#/').split('/');
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === (page || 'list')));
  window.scrollTo(0, 0);
  try {
    if (!page || page === 'list') return renderList();
    if (page === 'new') return renderEditor(newQuote(id ? decodeURIComponent(id) : null));
    if (page === 'edit' && id === 'draft') return renderEditor(null);
    if (page === 'edit') {
      const q = state.quotes.find((x) => x.id === id) || (await state.store.getQuote(id));
      return q ? renderEditor(clone(q)) : notFound();
    }
    if (page === 'view') {
      const q = state.quotes.find((x) => x.id === id) || (await state.store.getQuote(id));
      return q ? renderView(q) : notFound();
    }
    if (page === 'customers') return renderCustomers();
    if (page === 'settings') return renderSettings();
    notFound();
  } catch (err) {
    console.error(err);
    toast('שגיאה: ' + err.message, 'error');
  }
}

function notFound() {
  $('#main').innerHTML = `<div class="empty"><p>הדף או ההצעה לא נמצאו.</p><a class="btn" href="#/">חזרה לרשימה</a></div>`;
}

// ---------- הצעה חדשה ----------
function brandSnapshot(s) {
  return clone({
    business: s.business,
    ageGroups: s.ageGroups,
    features: s.features,
    menuNote: s.menuNote,
    images: s.images,
  });
}

function newQuote(customerKey) {
  const s = state.settings;
  const q = {
    id: null,
    number: null,
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: null,
    quoteDate: today(),
    customer: { name: '', phone: '', email: '' },
    event: { type: s.eventTypes[0] || 'אחר', typeOther: '', date: '', address: '', startTime: '' },
    guests: { adults: '', children: '', infants: '', max: '' },
    packageId: s.packages[0]?.id,
    pkg: clone(s.packages[0] || {}),
    extensionMinutes: 0,
    extension: clone(s.extension),
    pasta: { name: s.pasta.name, portions: 0, pricePerPortion: s.pasta.pricePerPortion, setupFee: s.pasta.setupFee },
    addons: [],
    customItems: [],
    discount: { type: 'amount', value: 0 },
    overrides: { packagePrice: '', extensionPrice: '', deposit: '' },
    depositRules: clone(s.deposit),
    cancellation: clone(s.cancellation),
    terms: [...s.terms],
    pizzas: [],
    publicNotes: '',
    internalNotes: '',
    internal: clone(s.internal),
    brand: brandSnapshot(s),
    generated: [],
  };
  if (customerKey) {
    const prev = state.quotes
      .filter((x) => normPhone(x.customer?.phone) === customerKey || x.customer?.name === customerKey)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
    if (prev) q.customer = clone(prev.customer);
  }
  return q;
}

// ---------- רשימת הצעות ----------
function quoteMatches(q, f) {
  if (f.status && q.status !== f.status) return false;
  if (f.type && q.event?.type !== f.type) return false;
  if (f.q) {
    const needle = f.q.trim().toLowerCase();
    const hay = [q.number, q.customer?.name, q.customer?.phone, normPhone(q.customer?.phone), q.customer?.email, q.event?.address, eventTypeLabel(q)]
      .join(' ')
      .toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

function sortQuotes(list, sort) {
  const by = {
    created: (a, b) => (b.number || 0) - (a.number || 0),
    event: (a, b) => (a.event?.date || '9999').localeCompare(b.event?.date || '9999'),
    total: (a, b) => calcQuote(b).total - calcQuote(a).total,
  }[sort];
  return [...list].sort(by);
}

function renderList() {
  const f = state.listFilter;
  const s = state.settings;
  const counts = Object.fromEntries(STATUSES.map((st) => [st.id, 0]));
  state.quotes.forEach((q) => (counts[q.status] = (counts[q.status] || 0) + 1));
  const upcomingApproved = state.quotes.filter((q) => q.status === 'approved' && (q.event?.date || '') >= today());

  $('#main').innerHTML = `
    <div class="page-head">
      <h1>הצעות מחיר</h1>
      <a class="btn primary" href="#/new">+ הצעה חדשה</a>
    </div>
    <div class="stats">
      ${STATUSES.map(
        (st) => `<button class="stat ${f.status === st.id ? 'on' : ''}" data-status="${st.id}"><b>${counts[st.id] || 0}</b><span class="badge ${st.id}">${st.label}</span></button>`
      ).join('')}
      <div class="stat wide"><b>${formatILS(upcomingApproved.reduce((a, q) => a + calcQuote(q).total, 0))}</b><span>${upcomingApproved.length} אירועים מאושרים קרובים</span></div>
    </div>
    <div class="toolbar">
      <input type="search" id="flt-q" placeholder="חיפוש לפי שם, טלפון, מספר הצעה..." value="${esc(f.q)}">
      <select id="flt-status"><option value="">כל הסטטוסים</option>${STATUSES.map((st) => `<option value="${st.id}" ${f.status === st.id ? 'selected' : ''}>${st.label}</option>`).join('')}</select>
      <select id="flt-type"><option value="">כל סוגי האירועים</option>${s.eventTypes.map((t) => `<option ${f.type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <select id="flt-sort">
        <option value="created" ${f.sort === 'created' ? 'selected' : ''}>מיון: חדשות קודם</option>
        <option value="event" ${f.sort === 'event' ? 'selected' : ''}>מיון: תאריך אירוע</option>
        <option value="total" ${f.sort === 'total' ? 'selected' : ''}>מיון: סכום</option>
      </select>
    </div>
    <div id="list-body"></div>`;

  const draw = () => {
    const rows = sortQuotes(state.quotes.filter((q) => quoteMatches(q, f)), f.sort);
    $('#list-body').innerHTML = rows.length
      ? `<table class="quotes">
          <thead><tr><th>מס׳</th><th>לקוח</th><th>טלפון</th><th>אירוע</th><th>תאריך</th><th>סכום</th><th>סטטוס</th><th></th></tr></thead>
          <tbody>${rows
            .map((q) => {
              const c = calcQuote(q);
              return `<tr data-id="${q.id}">
                <td data-l="מס׳" class="num"><a href="#/view/${q.id}">${esc(q.number)}</a></td>
                <td data-l="לקוח"><a href="#/view/${q.id}"><b>${esc(q.customer?.name)}</b></a></td>
                <td data-l="טלפון"><a href="tel:${esc(normPhone(q.customer?.phone))}" dir="ltr">${esc(q.customer?.phone)}</a></td>
                <td data-l="אירוע">${esc(eventTypeLabel(q))}</td>
                <td data-l="תאריך">${esc(formatDate(q.event?.date)) || '—'}</td>
                <td data-l="סכום" class="money">${formatILS(c.total)}</td>
                <td data-l="סטטוס"><select class="status-select badge ${q.status}" data-act="status">${STATUSES.map((st) => `<option value="${st.id}" ${st.id === q.status ? 'selected' : ''}>${st.label}</option>`).join('')}</select></td>
                <td class="actions">
                  <a class="icon" href="#/view/${q.id}" title="תצוגה">👁</a>
                  <a class="icon" href="#/edit/${q.id}" title="עריכה">✎</a>
                  <button class="icon" data-act="dup" title="שכפול">⧉</button>
                  <button class="icon" data-act="pdf" title="הורדת PDF">⬇</button>
                  <button class="icon danger" data-act="del" title="מחיקה">🗑</button>
                </td>
              </tr>`;
            })
            .join('')}</tbody></table>`
      : `<div class="empty"><p>${state.quotes.length ? 'לא נמצאו הצעות התואמות לחיפוש.' : 'עדיין אין הצעות מחיר.'}</p>${
          state.quotes.length ? '' : '<a class="btn primary" href="#/new">צור הצעה ראשונה</a>'
        }</div>`;
  };
  draw();

  $('#flt-q').addEventListener('input', (e) => ((f.q = e.target.value), draw()));
  $('#flt-status').addEventListener('change', (e) => ((f.status = e.target.value), renderList()));
  $('#flt-type').addEventListener('change', (e) => ((f.type = e.target.value), draw()));
  $('#flt-sort').addEventListener('change', (e) => ((f.sort = e.target.value), draw()));
  $$('.stat[data-status]').forEach((b) =>
    b.addEventListener('click', () => ((f.status = f.status === b.dataset.status ? '' : b.dataset.status), renderList()))
  );

  $('#list-body').addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'status') return;
    const q = state.quotes.find((x) => x.id === e.target.closest('tr').dataset.id);
    await setStatus(q, e.target.value);
    renderList();
  });
  $('#list-body').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const q = state.quotes.find((x) => x.id === btn.closest('tr').dataset.id);
    if (btn.dataset.act === 'dup') duplicateQuote(q);
    if (btn.dataset.act === 'pdf') downloadPdf(q);
    if (btn.dataset.act === 'del') deleteQuote(q);
  });
}

async function persist(q) {
  q.updatedAt = new Date().toISOString();
  await state.store.saveQuote(q);
  const i = state.quotes.findIndex((x) => x.id === q.id);
  if (i >= 0) state.quotes[i] = q;
  else state.quotes.push(q);
}

async function setStatus(q, status) {
  q.status = status;
  await persist(q);
  toast(`הסטטוס עודכן: ${statusLabel(status)}`);
}

function duplicateQuote(q) {
  const d = clone(q);
  Object.assign(d, {
    id: null,
    number: null,
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: null,
    quoteDate: today(),
    generated: [],
  });
  state.pendingDraft = d;
  go('#/edit/draft');
}

async function deleteQuote(q) {
  if (!confirm(`למחוק את הצעה ${q.number} של ${q.customer?.name || 'ללא שם'}? לא ניתן לבטל.`)) return;
  await state.store.deleteQuote(q.id);
  state.quotes = state.quotes.filter((x) => x.id !== q.id);
  toast('ההצעה נמחקה');
  if (location.hash.startsWith('#/view')) go('#/');
  else renderList();
}

// ---------- PDF ----------
const pdfName = (q) => `הצעת מחיר ${q.number} - ${(q.customer?.name || '').replace(/[\\/:*?"<>|]/g, '')}.pdf`;

async function prepareStage(q) {
  const imgs = await resolveImages(q.brand?.images);
  return renderPages($('#doc-stage'), q, imgs);
}

// מפיק PDF ושומר עותק (צילום מצב של ההצעה ברגע ההפקה)
async function downloadPdf(q, { saveCopy = true } = {}) {
  busy(true, 'מפיק PDF...');
  try {
    await prepareStage(q);
    await pagesToPdf($('#doc-stage'), pdfName(q));
    if (saveCopy && q.id) {
      const { generated, ...snap } = q;
      q.generated = [{ at: new Date().toISOString(), total: calcQuote(q).total, snapshot: clone(snap) }, ...(generated || [])].slice(0, 15);
      await persist(q);
    }
    toast('ה-PDF הורד ונשמר עותק בהצעה');
  } catch (err) {
    console.error(err);
    toast('שגיאה בהפקת PDF: ' + err.message, 'error');
  } finally {
    busy(false);
  }
}

// ---------- עורך הצעה ----------
const STEPS = ['לקוח ואירוע', 'מסלול וכמויות', 'תוספות והנחה', 'תנאים ותשלום'];

function renderEditor(q) {
  if (location.hash === '#/edit/draft') {
    if (!state.pendingDraft) return go('#/');
    q = state.pendingDraft;
    state.pendingDraft = null;
  }
  const s = state.settings;
  let step = 0;

  $('#main').innerHTML = `
    <div class="page-head">
      <h1>${q.id ? `עריכת הצעה ${esc(q.number)}` : 'הצעה חדשה'}</h1>
      <div class="head-actions">
        <a class="btn ghost" href="${q.id ? `#/view/${q.id}` : '#/'}">ביטול</a>
        <button class="btn" id="save">שמירה</button>
        <button class="btn primary" id="save-view">שמירה ותצוגה מקדימה</button>
      </div>
    </div>
    <nav class="steps">${STEPS.map((t, i) => `<button data-step="${i}"><span>${i + 1}</span>${t}</button>`).join('')}<button data-step="preview"><span>5</span>תצוגה מקדימה</button></nav>
    <div class="editor">
      <form id="qform" class="card" autocomplete="off" onsubmit="return false"></form>
      <aside class="summary card" id="summary"></aside>
    </div>
    <div class="mobile-total" id="mobile-total"></div>`;

  const form = $('#qform');

  const sections = [
    () => `
      <h2>פרטי הלקוח</h2>
      <div class="grid">
        ${field('שם הלקוח', 'customer.name', q, { required: true })}
        ${field('טלפון', 'customer.phone', q, { type: 'tel', dir: 'ltr' })}
        ${field('אימייל (רשות)', 'customer.email', q, { type: 'email', dir: 'ltr' })}
      </div>
      <h2>פרטי האירוע</h2>
      <div class="grid">
        ${field('סוג האירוע', 'event.type', q, { options: s.eventTypes, rerender: true })}
        ${q.event.type === 'אחר' ? field('פירוט סוג האירוע', 'event.typeOther', q) : ''}
        ${field('תאריך האירוע', 'event.date', q, { type: 'date' })}
        ${field('שעת תחילת הגשה', 'event.startTime', q, { type: 'time' })}
        ${field('כתובת האירוע', 'event.address', q, { cls: 'span2' })}
      </div>
      <h2>פרטי ההצעה</h2>
      <div class="grid">
        ${field('תאריך ההצעה', 'quoteDate', q, { type: 'date' })}
        ${field('סטטוס', 'status', q, { options: STATUSES.map((x) => [x.id, x.label]) })}
      </div>`,

    () => {
      const c = calcQuote(q);
      const ages = q.brand.ageGroups;
      return `
      <h2>בחירת מסלול</h2>
      <div class="pkg-options">
        ${s.packages
          .map(
            (p) => `<label class="pkg-option ${q.packageId === p.id ? 'on' : ''}">
              <input type="radio" name="pkg" value="${esc(p.id)}" ${q.packageId === p.id ? 'checked' : ''} data-act="pkg">
              <b>${esc(p.name)}</b>
              <small>${esc(p.includes)}</small>
              <small>${esc(formatDuration(p.hours * 60))} · מינימום ${formatILS(p.minPrice)} עד ${p.minGuests} משתתפים · ${formatILS(p.extraAdult)} למבוגר נוסף</small>
            </label>`
          )
          .join('')}
      </div>
      <h2>כמויות משתתפים</h2>
      <div class="grid four">
        ${field(`מבוגרים (מגיל ${ages.adultFromAge})`, 'guests.adults', q, { type: 'number', min: 0 })}
        ${field(`ילדים (גיל ${ages.childFromAge}–${ages.childToAge})`, 'guests.children', q, { type: 'number', min: 0, hint: `נספר כ-${ages.childFactor} משתתף` })}
        ${field(`פעוטות (גיל 0–${ages.infantToAge})`, 'guests.infants', q, { type: 'number', min: 0, hint: 'ללא חיוב' })}
        ${field('כמות מקסימלית משוערת (רשות)', 'guests.max', q, { type: 'number', min: 0, hint: 'להצגת מחיר במקרה של הגדלה' })}
      </div>
      <div class="calc-note" id="pkg-calc">משתתפים לחיוב: <b>${formatGuests(c.billable)}</b> · מחיר מסלול מחושב: <b>${formatILS(c.computedPackage)}</b></div>
      <details class="sub" ${q.overrides.packagePrice !== '' ? 'open' : ''}>
        <summary>עריכת מחירי המסלול להצעה זו בלבד</summary>
        <div class="grid four">
          ${field('מחיר מינימום', 'pkg.minPrice', q, { type: 'number' })}
          ${field('משתתפים כלולים במינימום', 'pkg.minGuests', q, { type: 'number' })}
          ${field('מחיר מבוגר נוסף', 'pkg.extraAdult', q, { type: 'number', hint: `ילד נוסף: ${formatILS(q.pkg.extraAdult * ages.childFactor)}` })}
          ${field('שעות הגשה כלולות', 'pkg.hours', q, { type: 'number', step: 0.5 })}
          ${field('כלול במסלול', 'pkg.includes', q, { cls: 'span2' })}
          ${field('מחיר מסלול סופי (דריסה ידנית)', 'overrides.packagePrice', q, { type: 'number', placeholder: 'ריק = לפי החישוב', cls: 'span2' })}
          ${field('תיאור השירות', 'pkg.description', q, { type: 'textarea', cls: 'span4' })}
        </div>
        <button type="button" class="btn small ghost" data-act="refresh-prices">עדכון למחירון הנוכחי מההגדרות</button>
      </details>`;
    },

    () => {
      const extOpts = [];
      for (let m = 0; m <= 360; m += 30) extOpts.push([m, m ? formatDuration(m) : 'ללא הארכה']);
      return `
      <h2>הארכת זמן הגשה</h2>
      <div class="grid">
        ${field('הארכה מעבר לזמן הכלול', 'extensionMinutes', q, { options: extOpts, type: 'number' })}
        ${field('מחיר הארכה (דריסה ידנית)', 'overrides.extensionPrice', q, { type: 'number', placeholder: 'ריק = לפי החישוב', hint: `${formatILS(q.extension.hourPrice)} לשעה · ${formatILS(q.extension.halfHourPrice)} לחצי שעה` })}
      </div>
      <h2>פסטות</h2>
      <div class="grid">
        ${field('מספר מנות', 'pasta.portions', q, { type: 'number', min: 0 })}
        ${field('מחיר למנה', 'pasta.pricePerPortion', q, { type: 'number' })}
        ${field('דמי הקמה', 'pasta.setupFee', q, { type: 'number' })}
      </div>
      <h2>תוספות מהמחירון</h2>
      <div class="rows">
        ${q.addons
          .map(
            (a, i) => `<div class="row-item">
            ${field('פריט', `addons.${i}.name`, q, { cls: 'grow' })}
            ${field('מחיר', `addons.${i}.price`, q, { type: 'number' })}
            ${field('חיוב', `addons.${i}.unit`, q, { options: [['qty', 'לפי כמות'], ['fixed', 'מחיר קבוע']], rerender: true })}
            ${a.unit === 'fixed' ? '' : field('כמות', `addons.${i}.qty`, q, { type: 'number', min: 0 })}
            <button type="button" class="icon danger" data-act="del-addon" data-i="${i}" title="הסרה">✕</button>
          </div>`
          )
          .join('')}
        <div class="add-row">
          <select id="addon-pick"><option value="">+ הוספת פריט מהמחירון...</option>${s.addons
            .map((a) => `<option value="${esc(a.id)}">${esc(a.category ? a.category + ' – ' : '')}${esc(a.name)} (${formatILS(a.price)}${a.unit === 'fixed' ? '' : ' ליחידה'})</option>`)
            .join('')}</select>
        </div>
      </div>
      <h2>סעיפי מחיר חופשיים</h2>
      <div class="rows">
        ${q.customItems
          .map(
            (c, i) => `<div class="row-item">
            ${field('תיאור', `customItems.${i}.name`, q, { cls: 'grow' })}
            ${field('סכום', `customItems.${i}.amount`, q, { type: 'number' })}
            <button type="button" class="icon danger" data-act="del-custom" data-i="${i}" title="הסרה">✕</button>
          </div>`
          )
          .join('')}
        <button type="button" class="btn small ghost" data-act="add-custom">+ סעיף חופשי</button>
      </div>
      <h2>הנחה</h2>
      <div class="grid">
        ${field('סוג הנחה', 'discount.type', q, { options: [['amount', 'סכום קבוע (₪)'], ['percent', 'אחוזים (%)']] })}
        ${field('ערך ההנחה', 'discount.value', q, { type: 'number', min: 0 })}
      </div>`;
    },

    () => {
      const c = calcQuote(q);
      const menuPizzas = s.menu.pizzas.map((p) => p.name);
      const extraPicked = q.pizzas.filter((p) => !menuPizzas.includes(p));
      return `
      <h2>מקדמה ותשלום</h2>
      <div class="grid">
        ${field('אחוז מקדמה', 'depositRules.percent', q, { type: 'number' })}
        ${field('מקדמה מינימלית', 'depositRules.min', q, { type: 'number' })}
        ${field('מקדמה (דריסה ידנית)', 'overrides.deposit', q, { type: 'number', placeholder: `מחושב: ${c.computedDeposit}` })}
        ${field('דמי ביטול חלקיים (% מהמקדמה)', 'cancellation.partialFeePercent', q, { type: 'number' })}
      </div>
      <h2>תנאי התקשרות</h2>
      <label class="field"><span>שורה לכל סעיף. משתנים: {מקדמה} {יתרה} {סכום} {דמי_ביטול_חלקיים}</span>
        <textarea data-bind-lines="terms" rows="8">${esc(q.terms.join('\n'))}</textarea></label>
      <button type="button" class="btn small ghost" data-act="reset-terms">שחזור תנאי ברירת המחדל</button>
      <h2>בחירת פיצות (רשות – עד 6)</h2>
      <p class="hint">אם לא נבחרו, יודפס: "${esc(q.brand.menuNote)}"</p>
      <div class="chips">
        ${[...menuPizzas, ...extraPicked]
          .map((p) => `<label class="chip"><input type="checkbox" data-pizza value="${esc(p)}" ${q.pizzas.includes(p) ? 'checked' : ''}> ${esc(p)}</label>`)
          .join('')}
      </div>
      <h2>הערות</h2>
      ${field('הערות ללקוח (יודפסו בהצעה)', 'publicNotes', q, { type: 'textarea' })}
      <div class="internal-box">
        <h3>🔒 פנימי בלבד – לא מודפס</h3>
        ${field('הערות פנימיות', 'internalNotes', q, { type: 'textarea' })}
        <div class="grid">
          ${field('עלות פנימית למשתתף', 'internal.costPerGuest', q, { type: 'number' })}
          ${field('עלות קבועה', 'internal.fixedCost', q, { type: 'number' })}
          ${field('עמלה (%)', 'internal.commissionPercent', q, { type: 'number' })}
        </div>
      </div>`;
    },
  ];

  const drawSummary = () => {
    const c = calcQuote(q);
    const row = (l, v, cls = '') => `<div class="sum-row ${cls}"><span>${l}</span><b>${v}</b></div>`;
    $('#summary').innerHTML = `
      <h3>סיכום מחיר</h3>
      ${row('משתתפים לחיוב', formatGuests(c.billable))}
      ${row(`מסלול ${esc(q.pkg.name || '')}`, formatILS(c.packagePrice))}
      ${c.extPrice ? row('הארכה', formatILS(c.extPrice)) : ''}
      ${c.pastaPrice ? row('פסטות', formatILS(c.pastaPrice)) : ''}
      ${c.addonsTotal ? row('תוספות', formatILS(c.addonsTotal)) : ''}
      ${c.customTotal ? row('סעיפים חופשיים', formatILS(c.customTotal)) : ''}
      ${c.discount ? row('הנחה', '− ' + formatILS(c.discount), 'neg') : ''}
      ${row('סה״כ', formatILS(c.total), 'total')}
      ${c.billable ? row('ממוצע למשתתף', formatILS(c.perGuest), 'muted') : ''}
      ${c.max ? row(`במקרה של ${formatGuests(c.max.guests)} משתתפים`, formatILS(c.max.total), 'muted') : ''}
      ${row('מקדמה', formatILS(c.deposit))}
      ${row('יתרה', formatILS(c.balance))}
      <div class="sum-internal">
        ${row('🔒 עלות פנימית', formatILS(c.internal.cost), 'muted')}
        ${row('🔒 עמלה', formatILS(c.internal.commission), 'muted')}
        ${row('🔒 רווח משוער', formatILS(c.internal.profit), 'muted')}
      </div>`;
    $('#mobile-total').innerHTML = `<span>סה״כ <b>${formatILS(c.total)}</b></span><span>מקדמה ${formatILS(c.deposit)}</span>`;
    const calcEl = $('#pkg-calc');
    if (calcEl) calcEl.innerHTML = `משתתפים לחיוב: <b>${formatGuests(c.billable)}</b> · מחיר מסלול מחושב: <b>${formatILS(c.computedPackage)}</b>`;
  };

  const drawStep = () => {
    form.innerHTML =
      sections[step]() +
      `<div class="step-nav">
        ${step > 0 ? '<button type="button" class="btn ghost" data-act="prev">→ הקודם</button>' : '<span></span>'}
        ${step < sections.length - 1 ? '<button type="button" class="btn" data-act="next">הבא ←</button>' : '<button type="button" class="btn primary" data-act="finish">שמירה ותצוגה מקדימה</button>'}
      </div>`;
    $$('.steps button').forEach((b) => b.classList.toggle('on', b.dataset.step === String(step)));
    drawSummary();
  };

  bindForm(form, q, (el) => {
    state.dirty = true;
    if (el.dataset.rerender) drawStep();
    else drawSummary();
  });

  form.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.act === 'pkg') {
      const p = s.packages.find((x) => x.id === el.value);
      q.packageId = p.id;
      q.pkg = clone(p);
      q.overrides.packagePrice = '';
      state.dirty = true;
      drawStep();
    }
    if (el.id === 'addon-pick' && el.value) {
      const a = s.addons.find((x) => x.id === el.value);
      q.addons.push({ name: a.name, price: a.price, unit: a.unit, qty: a.unit === 'fixed' ? 1 : 1 });
      state.dirty = true;
      drawStep();
    }
    if (el.dataset.pizza !== undefined) {
      const picked = $$('[data-pizza]:checked', form).map((x) => x.value);
      if (picked.length > 6) {
        el.checked = false;
        toast('ניתן לבחור עד 6 סוגי פיצות', 'error');
        return;
      }
      q.pizzas = picked;
      state.dirty = true;
    }
  });

  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.tagName === 'INPUT' || b.tagName === 'SELECT') return;
    const act = b.dataset.act;
    if (act === 'next') step++;
    else if (act === 'prev') step--;
    else if (act === 'finish') return save(true);
    else if (act === 'del-addon') q.addons.splice(+b.dataset.i, 1);
    else if (act === 'add-custom') q.customItems.push({ name: '', amount: 0 });
    else if (act === 'del-custom') q.customItems.splice(+b.dataset.i, 1);
    else if (act === 'reset-terms') {
      if (!confirm('להחליף את התנאים בהצעה זו בתנאי ברירת המחדל מההגדרות?')) return;
      q.terms = [...s.terms];
    } else if (act === 'refresh-prices') {
      if (!confirm('לעדכן את מחירי המסלול, ההארכה והמקדמה בהצעה זו לפי המחירון הנוכחי?')) return;
      const p = s.packages.find((x) => x.id === q.packageId) || s.packages[0];
      q.pkg = clone(p);
      q.packageId = p.id;
      q.extension = clone(s.extension);
      q.depositRules = clone(s.deposit);
      q.cancellation = clone(s.cancellation);
      q.brand = brandSnapshot(s);
      toast('המחירים עודכנו לפי המחירון הנוכחי');
    } else return;
    if (['del-addon', 'add-custom', 'del-custom', 'reset-terms', 'refresh-prices'].includes(act)) state.dirty = true;
    drawStep();
    if (act === 'next' || act === 'prev') window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  $$('.steps button').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.step === 'preview') return save(true);
      step = +b.dataset.step;
      drawStep();
    })
  );

  async function save(thenView) {
    if (!q.customer.name.trim()) {
      step = 0;
      drawStep();
      toast('יש להזין שם לקוח', 'error');
      $('#f_customer_name')?.focus();
      return;
    }
    busy(true, 'שומר...');
    try {
      if (!q.number) q.number = await state.store.nextNumber(Number(s.numbering.start) || 1);
      await persist(q);
      state.dirty = false;
      toast(`הצעה ${q.number} נשמרה`);
      if (thenView) go(`#/view/${q.id}`);
      else if (!location.hash.startsWith('#/edit/' + q.id)) {
        lastHash = `#/edit/${q.id}`;
        history.replaceState(null, '', lastHash);
        $('.page-head h1').textContent = `עריכת הצעה ${q.number}`;
      }
    } catch (err) {
      toast('שגיאה בשמירה: ' + err.message, 'error');
    } finally {
      busy(false);
    }
  }
  $('#save').addEventListener('click', () => save(false));
  $('#save-view').addEventListener('click', () => save(true));

  drawStep();
}

// ---------- תצוגה מקדימה ----------
async function renderView(q) {
  const c = calcQuote(q);
  $('#main').innerHTML = `
    <div class="page-head">
      <h1>הצעה ${esc(q.number)} · ${esc(q.customer?.name)}</h1>
      <div class="head-actions">
        <select id="v-status" class="status-select badge ${q.status}">${STATUSES.map((st) => `<option value="${st.id}" ${st.id === q.status ? 'selected' : ''}>${st.label}</option>`).join('')}</select>
        <a class="btn ghost" href="#/edit/${q.id}">✎ עריכה</a>
        <button class="btn ghost" id="v-dup">⧉ שכפול</button>
        <button class="btn ghost" id="v-print">🖨 הדפסה</button>
        <button class="btn primary" id="v-pdf">⬇ הורדת PDF</button>
        <button class="btn ghost danger" id="v-del">🗑</button>
      </div>
    </div>
    <div class="view-layout">
      <div class="preview-wrap card"><div class="preview" id="preview"><div class="loading">טוען תצוגה...</div></div></div>
      <aside class="card side">
        <h3>פרטים פנימיים</h3>
        <div class="sum-row"><span>סה״כ</span><b>${formatILS(c.total)}</b></div>
        <div class="sum-row"><span>מקדמה</span><b>${formatILS(c.deposit)}</b></div>
        <div class="sum-row muted"><span>🔒 עלות פנימית</span><b>${formatILS(c.internal.cost)}</b></div>
        <div class="sum-row muted"><span>🔒 עמלה</span><b>${formatILS(c.internal.commission)}</b></div>
        <div class="sum-row muted"><span>🔒 רווח משוער</span><b>${formatILS(c.internal.profit)}</b></div>
        ${q.internalNotes ? `<div class="internal-notes"><b>הערות פנימיות:</b><br>${esc(q.internalNotes).replace(/\n/g, '<br>')}</div>` : ''}
        <h3>עותקי PDF שהופקו</h3>
        ${
          q.generated?.length
            ? `<ul class="copies">${q.generated
                .map(
                  (g, i) => `<li><span>${new Date(g.at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })} · ${formatILS(g.total)}</span><button class="btn small ghost" data-copy="${i}">⬇</button></li>`
                )
                .join('')}</ul>`
            : '<p class="hint">עדיין לא הופק PDF. בכל הורדה נשמר עותק של ההצעה כפי שהייתה ברגע ההפקה.</p>'
        }
        ${q.customer?.phone ? `<a class="btn small ghost wa" target="_blank" rel="noopener" href="https://wa.me/${waPhone(q.customer.phone)}">💬 פתיחת וואטסאפ ללקוח</a>` : ''}
      </aside>
    </div>`;

  const pages = await prepareStage(q);
  const preview = $('#preview');
  preview.innerHTML = '';
  $$('#doc-stage .q-page').forEach((p) => preview.append(p.cloneNode(true)));
  const fit = () => {
    const w = $('.preview-wrap')?.clientWidth;
    if (w) preview.style.zoom = Math.min(1, (w - 24) / 794);
  };
  fit();
  window.onresize = fit;
  preview.dataset.pages = pages;

  $('#v-status').addEventListener('change', async (e) => {
    await setStatus(q, e.target.value);
    e.target.className = `status-select badge ${q.status}`;
  });
  $('#v-dup').addEventListener('click', () => duplicateQuote(q));
  $('#v-del').addEventListener('click', () => deleteQuote(q));
  $('#v-print').addEventListener('click', async () => {
    await prepareStage(q);
    window.print();
  });
  $('#v-pdf').addEventListener('click', async () => {
    await downloadPdf(q);
    renderView(q);
  });
  $$('[data-copy]').forEach((b) =>
    b.addEventListener('click', async () => {
      const g = q.generated[+b.dataset.copy];
      await downloadPdf({ ...g.snapshot, generated: [] }, { saveCopy: false });
      prepareStage(q);
    })
  );
}

function waPhone(p) {
  let d = normPhone(p);
  if (d.startsWith('0')) d = '972' + d.slice(1);
  return d;
}

// ---------- לקוחות ----------
function renderCustomers() {
  const map = new Map();
  for (const q of state.quotes) {
    const key = normPhone(q.customer?.phone) || q.customer?.name || '—';
    const e = map.get(key) || { key, name: '', phone: '', email: '', quotes: [], last: '' };
    e.quotes.push(q);
    const newer = !e.lastCreated || (q.createdAt || '') > e.lastCreated;
    if (newer) {
      e.lastCreated = q.createdAt || '';
      e.name = q.customer?.name;
      e.phone = q.customer?.phone;
      e.email = q.customer?.email || e.email;
    }
    if ((q.event?.date || '') > e.last) e.last = q.event.date;
    map.set(key, e);
  }
  const list = [...map.values()].sort((a, b) => (b.lastCreated || '').localeCompare(a.lastCreated || ''));
  let term = '';

  $('#main').innerHTML = `
    <div class="page-head"><h1>לקוחות</h1></div>
    <p class="hint">רשימת הלקוחות נבנית אוטומטית מההצעות (לפי מספר טלפון).</p>
    <div class="toolbar"><input type="search" id="c-q" placeholder="חיפוש לקוח..."></div>
    <div id="c-body"></div>`;

  const draw = () => {
    const rows = list.filter((e) => !term || [e.name, e.phone, normPhone(e.phone), e.email].join(' ').toLowerCase().includes(term));
    $('#c-body').innerHTML = rows.length
      ? `<table class="quotes"><thead><tr><th>שם</th><th>טלפון</th><th>אימייל</th><th>הצעות</th><th>אירוע אחרון</th><th>מאושר</th><th></th></tr></thead><tbody>
        ${rows
          .map((e) => {
            const approved = e.quotes.filter((q) => q.status === 'approved').reduce((a, q) => a + calcQuote(q).total, 0);
            return `<tr>
              <td data-l="שם"><b>${esc(e.name)}</b></td>
              <td data-l="טלפון"><a href="tel:${esc(normPhone(e.phone))}" dir="ltr">${esc(e.phone)}</a></td>
              <td data-l="אימייל" dir="ltr">${esc(e.email)}</td>
              <td data-l="הצעות">${e.quotes.map((q) => `<a class="badge ${q.status}" href="#/view/${q.id}">${esc(q.number)}</a>`).join(' ')}</td>
              <td data-l="אירוע אחרון">${esc(formatDate(e.last)) || '—'}</td>
              <td data-l="מאושר" class="money">${approved ? formatILS(approved) : '—'}</td>
              <td class="actions"><a class="btn small ghost" href="#/new/${encodeURIComponent(e.key)}">+ הצעה</a>${
                e.phone ? `<a class="icon" target="_blank" rel="noopener" href="https://wa.me/${waPhone(e.phone)}" title="וואטסאפ">💬</a>` : ''
              }</td>
            </tr>`;
          })
          .join('')}</tbody></table>`
      : `<div class="empty"><p>${list.length ? 'לא נמצאו לקוחות.' : 'עדיין אין לקוחות – הם יופיעו כאן אחרי יצירת הצעה ראשונה.'}</p></div>`;
  };
  draw();
  $('#c-q').addEventListener('input', (e) => ((term = e.target.value.trim().toLowerCase()), draw()));
}

// ---------- הגדרות ----------
async function fileToDataUrl(file, maxSide, asPng) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('קובץ תמונה לא תקין'));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.width * scale);
    cv.height = Math.round(img.height * scale);
    const ctx = cv.getContext('2d');
    if (!asPng) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cv.width, cv.height);
    }
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL(asPng ? 'image/png' : 'image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function renderSettings() {
  const s = clone(state.settings);
  const imgs = await resolveImages(s.images);
  const linesOf = (arr) => arr.map((x) => (x.desc ? `${x.name} | ${x.desc}` : x.name)).join('\n');
  const parseLines = (t) =>
    t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, ...d] = l.split('|');
      return { name: name.trim(), desc: d.join('|').trim() };
    });

  const sec = (title, body, open = false) => `<details class="card set-sec" ${open ? 'open' : ''}><summary>${title}</summary><div class="set-body">${body}</div></details>`;

  const draw = () => {
    $('#set-form').innerHTML = [
      sec(
        'עסק ומיתוג',
        `<div class="grid">
          ${field('כותרת ראשית', 'business.title', s)}
          ${field('כותרת משנה', 'business.subtitle', s)}
          ${field('פסקת פתיחה', 'business.intro', s, { type: 'textarea', cls: 'span2' })}
          ${field('פרטי קשר (שורת תחתית)', 'business.contact', s, { cls: 'span2' })}
          ${field('משפט סיום', 'business.closing', s, { cls: 'span2' })}
          ${field('ברכה', 'business.blessing', s)}
          ${field('הערת מחיר', 'business.priceNote', s)}
        </div>
        <h3>לוגו ותמונות</h3>
        <div class="img-grid">
          ${[['logo', 'לוגו'], ['photo1', 'תמונה 1'], ['photo2', 'תמונה 2']]
            .map(
              ([k, l]) => `<div class="img-slot">
                <span>${l}</span>
                <div class="img-prev">${imgs[k] ? `<img src="${esc(imgs[k])}" alt="">` : 'אין תמונה'}</div>
                <label class="btn small ghost">העלאה<input type="file" accept="image/*" data-img="${k}" hidden></label>
                <button type="button" class="btn small ghost" data-img-reset="${k}">ברירת מחדל</button>
              </div>`
            )
            .join('')}
        </div>`,
        true
      ),
      sec(
        'מסלולים ומחירון',
        s.packages
          .map(
            (p, i) => `<div class="pkg-edit">
              <div class="grid four">
                ${field('שם המסלול', `packages.${i}.name`, s)}
                ${field('שעות הגשה כלולות', `packages.${i}.hours`, s, { type: 'number', step: 0.5 })}
                ${field('משתתפים כלולים במינימום', `packages.${i}.minGuests`, s, { type: 'number' })}
                ${field('מחיר מינימום', `packages.${i}.minPrice`, s, { type: 'number' })}
                ${field('מחיר מבוגר נוסף', `packages.${i}.extraAdult`, s, { type: 'number', hint: `ילד נוסף: ${formatILS(p.extraAdult * s.ageGroups.childFactor)} · פעוט: ללא חיוב` })}
                ${field('כלול במסלול', `packages.${i}.includes`, s, { cls: 'span3' })}
                ${field('תיאור השירות', `packages.${i}.description`, s, { type: 'textarea', cls: 'span4' })}
              </div>
              ${s.packages.length > 1 ? `<button type="button" class="btn small ghost danger" data-del-pkg="${i}">הסרת מסלול</button>` : ''}
            </div>`
          )
          .join('') + `<button type="button" class="btn small ghost" data-act="add-pkg">+ מסלול חדש</button>`
      ),
      sec(
        'קבוצות גיל',
        `<div class="grid four">
          ${field('מבוגר מגיל', 'ageGroups.adultFromAge', s, { type: 'number' })}
          ${field('ילד מגיל', 'ageGroups.childFromAge', s, { type: 'number' })}
          ${field('ילד עד גיל', 'ageGroups.childToAge', s, { type: 'number' })}
          ${field('פעוט עד גיל', 'ageGroups.infantToAge', s, { type: 'number' })}
          ${field('ילד נספר כ- (חלק ממבוגר)', 'ageGroups.childFactor', s, { type: 'number', step: 0.05 })}
        </div>`
      ),
      sec(
        'הארכת זמן, מקדמה וביטול',
        `<div class="grid four">
          ${field('הארכה – מחיר לשעה', 'extension.hourPrice', s, { type: 'number' })}
          ${field('הארכה – מחיר לחצי שעה', 'extension.halfHourPrice', s, { type: 'number' })}
          ${field('מקדמה (%)', 'deposit.percent', s, { type: 'number' })}
          ${field('מקדמה מינימלית', 'deposit.min', s, { type: 'number' })}
          ${field('דמי ביטול חלקיים (% מהמקדמה)', 'cancellation.partialFeePercent', s, { type: 'number' })}
        </div>`
      ),
      sec(
        'פסטות ומחירון תוספות',
        `<div class="grid">
          ${field('שם', 'pasta.name', s)}
          ${field('מחיר פסטה למנה', 'pasta.pricePerPortion', s, { type: 'number' })}
          ${field('דמי הקמה לפסטה', 'pasta.setupFee', s, { type: 'number' })}
        </div>
        <h3>מחירון תוספות</h3>
        <div class="rows">
          ${s.addons
            .map(
              (a, i) => `<div class="row-item">
              ${field('פריט', `addons.${i}.name`, s, { cls: 'grow' })}
              ${field('קטגוריה', `addons.${i}.category`, s)}
              ${field('מחיר', `addons.${i}.price`, s, { type: 'number' })}
              ${field('חיוב', `addons.${i}.unit`, s, { options: [['qty', 'לפי כמות'], ['fixed', 'מחיר קבוע']] })}
              <button type="button" class="icon danger" data-del-addon="${i}" title="הסרה">✕</button>
            </div>`
            )
            .join('')}
          <button type="button" class="btn small ghost" data-act="add-addon">+ פריט</button>
        </div>`
      ),
      sec(
        '"מה כוללת החוויה" – כרטיסי שירות',
        `<div class="rows">${s.features
          .map(
            (f, i) => `<div class="row-item">
            ${field('כותרת', `features.${i}.title`, s)}
            ${field('טקסט', `features.${i}.text`, s, { cls: 'grow' })}
            <button type="button" class="icon danger" data-del-feature="${i}" title="הסרה">✕</button>
          </div>`
          )
          .join('')}
          <button type="button" class="btn small ghost" data-act="add-feature">+ כרטיס</button>
        </div>`
      ),
      sec(
        'תנאי תשלום וביטול (ברירת מחדל להצעות חדשות)',
        `<label class="field"><span>שורה לכל סעיף. משתנים: {מקדמה} {יתרה} {סכום} {דמי_ביטול_חלקיים}</span>
          <textarea data-bind-lines="terms" rows="8">${esc(s.terms.join('\n'))}</textarea></label>
          ${field('הערת בחירת תפריט', 'menuNote', s, { cls: 'span2' })}`
      ),
      sec(
        'תפריט',
        `<p class="hint">שורה לכל מנה, בפורמט: שם | תיאור</p>
        <div class="grid">
          <label class="field span2"><span>פיצות</span><textarea data-menu="pizzas" rows="9">${esc(linesOf(s.menu.pizzas))}</textarea></label>
          <label class="field"><span>ראשונות וסלטים</span><textarea data-menu="starters" rows="8">${esc(linesOf(s.menu.starters))}</textarea></label>
          <label class="field"><span>קינוחים</span><textarea data-menu="desserts" rows="8">${esc(linesOf(s.menu.desserts))}</textarea></label>
        </div>`
      ),
      sec(
        '🔒 עלויות פנימיות ועמלות (לא מודפס)',
        `<div class="grid">
          ${field('עלות פנימית למשתתף', 'internal.costPerGuest', s, { type: 'number' })}
          ${field('עלות קבועה לאירוע', 'internal.fixedCost', s, { type: 'number' })}
          ${field('עמלה (%)', 'internal.commissionPercent', s, { type: 'number' })}
        </div>`
      ),
      sec(
        'כללי',
        `<div class="grid">
          ${field('מספר הצעה ראשון', 'numbering.start', s, { type: 'number' })}
          <label class="field"><span>סוגי אירועים (מופרדים בפסיק)</span><input data-event-types value="${esc(s.eventTypes.join(', '))}"></label>
        </div>`
      ),
    ].join('');
  };

  $('#main').innerHTML = `
    <div class="page-head">
      <h1>הגדרות</h1>
      <div class="head-actions"><button class="btn primary" id="set-save">שמירת הגדרות</button></div>
    </div>
    <p class="hint">שינוי ההגדרות חל על הצעות חדשות בלבד. הצעות שנשמרו ו-PDF שהופקו לא ישתנו.</p>
    <form id="set-form" onsubmit="return false"></form>
    <section class="card backup">
      <h2>גיבוי ושחזור</h2>
      <p class="hint">מומלץ להוריד גיבוי מדי פעם ולשמור אותו בענן (Google Drive וכד׳). ${
        state.store.mode === 'local' ? '<b>במצב מקומי הנתונים נשמרים בדפדפן זה בלבד – הגיבוי חשוב במיוחד.</b>' : ''
      }</p>
      <button class="btn" id="bk-export">⬇ הורדת גיבוי מלא</button>
      <label class="btn ghost">⬆ שחזור מגיבוי<input type="file" accept=".json,application/json" id="bk-import" hidden></label>
    </section>`;

  draw();
  const form = $('#set-form');
  const markDirty = () => (state.dirty = true);
  bindForm(form, s, markDirty);

  form.addEventListener('input', (e) => {
    if (e.target.dataset.menu) {
      s.menu[e.target.dataset.menu] = parseLines(e.target.value);
      markDirty();
    }
    if (e.target.dataset.eventTypes !== undefined) {
      s.eventTypes = e.target.value.split(',').map((x) => x.trim()).filter(Boolean);
      if (!s.eventTypes.includes('אחר')) s.eventTypes.push('אחר');
      markDirty();
    }
  });

  form.addEventListener('change', async (e) => {
    const k = e.target.dataset.img;
    if (!k || !e.target.files[0]) return;
    busy(true, 'מעלה תמונה...');
    try {
      const data = await fileToDataUrl(e.target.files[0], k === 'logo' ? 500 : 1100, k === 'logo');
      const ref = await state.store.saveImage(data);
      images[ref] = data;
      s.images[k] = ref;
      imgs[k] = data;
      markDirty();
      draw();
      $$('.set-sec')[0].open = true;
      toast('התמונה הועלתה – יש ללחוץ "שמירת הגדרות"');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      busy(false);
    }
  });

  form.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const openIdx = $$('.set-sec').map((d) => d.open);
    if (b.dataset.imgReset) {
      const k = b.dataset.imgReset;
      s.images[k] = DEFAULT_SETTINGS.images[k];
      Object.assign(imgs, await resolveImages({ [k]: s.images[k] }));
    } else if (b.dataset.delPkg) s.packages.splice(+b.dataset.delPkg, 1);
    else if (b.dataset.delAddon) s.addons.splice(+b.dataset.delAddon, 1);
    else if (b.dataset.delFeature) s.features.splice(+b.dataset.delFeature, 1);
    else if (b.dataset.act === 'add-pkg')
      s.packages.push({ ...clone(s.packages[0]), id: 'p' + Date.now().toString(36), name: 'מסלול חדש' });
    else if (b.dataset.act === 'add-addon')
      s.addons.push({ id: 'a' + Date.now().toString(36), name: '', category: '', price: 0, unit: 'qty' });
    else if (b.dataset.act === 'add-feature') s.features.push({ title: '', text: '' });
    else return;
    markDirty();
    draw();
    $$('.set-sec').forEach((d, i) => (d.open = openIdx[i] ?? d.open));
  });

  $('#set-save').addEventListener('click', async () => {
    busy(true, 'שומר...');
    try {
      await state.store.saveSettings(s);
      state.settings = withDefaults(s);
      state.dirty = false;
      toast('ההגדרות נשמרו');
    } catch (err) {
      toast('שגיאה בשמירה: ' + err.message, 'error');
    } finally {
      busy(false);
    }
  });

  $('#bk-export').addEventListener('click', async () => {
    busy(true, 'מכין גיבוי...');
    try {
      const data = { app: 'pizza-bar-quotes', exportedAt: new Date().toISOString(), ...(await state.store.exportAll()) };
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `pizza-bar-backup-${today()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } finally {
      busy(false);
    }
  });

  $('#bk-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'pizza-bar-quotes') throw new Error('הקובץ אינו גיבוי של המערכת');
      if (!confirm(`לשחזר ${data.quotes?.length || 0} הצעות והגדרות מהגיבוי? הצעות קיימות עם אותו מזהה יוחלפו.`)) return;
      busy(true, 'משחזר...');
      await state.store.importAll(data);
      await loadData();
      state.dirty = false;
      toast('השחזור הושלם');
      renderSettings();
    } catch (err) {
      toast('שגיאה בשחזור: ' + err.message, 'error');
    } finally {
      busy(false);
      e.target.value = '';
    }
  });
}

// ---------- כניסה ----------
function renderLogin() {
  document.body.classList.add('logged-out');
  $('#main').innerHTML = `
    <form class="card login" id="login">
      <img src="assets/logo.png" alt="" class="login-logo">
      <h1>כניסה למערכת הצעות המחיר</h1>
      <label class="field"><span>אימייל</span><input type="email" id="l-email" required dir="ltr" autocomplete="username"></label>
      <label class="field"><span>סיסמה</span><input type="password" id="l-pass" required dir="ltr" autocomplete="current-password"></label>
      <button class="btn primary" type="submit">כניסה</button>
      <button class="btn ghost small" type="button" id="l-reset">שכחתי סיסמה</button>
    </form>`;
  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    busy(true, 'מתחבר...');
    try {
      await state.store.signIn($('#l-email').value.trim(), $('#l-pass').value);
    } catch (err) {
      toast('הכניסה נכשלה – בדקו אימייל וסיסמה', 'error');
    } finally {
      busy(false);
    }
  });
  $('#l-reset').addEventListener('click', async () => {
    const email = $('#l-email').value.trim();
    if (!email) return toast('הזינו אימייל ואז לחצו שוב', 'error');
    try {
      await state.store.resetPassword(email);
      toast('נשלח מייל לאיפוס סיסמה');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// ---------- אתחול ----------
async function start() {
  busy(true, 'טוען...');
  try {
    state.store = await createStore();
  } catch (err) {
    busy(false);
    $('#main').innerHTML = `<div class="empty"><p>שגיאה בחיבור למסד הנתונים: ${esc(err.message)}</p></div>`;
    return;
  }
  if (!isCloud) $('#mode-banner').hidden = false;
  $('#logout').hidden = !isCloud;
  $('#logout').addEventListener('click', () => state.store.signOut());

  state.store.onAuth(async (user) => {
    busy(false);
    if (!user) return renderLogin();
    document.body.classList.remove('logged-out');
    busy(true, 'טוען נתונים...');
    try {
      await loadData();
    } catch (err) {
      toast('שגיאה בטעינת נתונים: ' + err.message, 'error');
    } finally {
      busy(false);
    }
    route();
  });
}

start();
