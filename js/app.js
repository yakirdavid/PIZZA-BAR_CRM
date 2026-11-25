import { createStore, isCloud } from './store.js';
import { parseRequest } from './parse-request.js';
import { DEFAULT_SETTINGS, STATUSES, clone, withDefaults } from './defaults.js';
import { calcQuote, formatILS, formatGuests, formatDuration, fillTerms, pricingModeOf } from './pricing.js';
import {
  ORDER_STATUSES, newOrder, orderRequirements, orderProblems, formSnapshot, orderFromSubmission,
  parseMenuLine, menuLine, visibleItems, chosen, ensureFixed, OTHER_PREFIX, isOther,
} from './order.js';
import { esc, eventTypeLabel, guestsText, renderPages, buildOrderBlocks, pagesToPdfBlob, renderStageCanvases, saveBlob, addMinutes, HEB_MONTHS, eventDateKey, eventDateShort } from './quote-render.js';
import { renderLanding } from './landing-stats.js';

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
// נייד ישראלי: 10 ספרות שמתחילות ב-05, עם או בלי מקף אחרי 3 הספרות הראשונות
const validPhone = (p) => /^05\d-?\d{7}$/.test(String(p || '').trim());

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
  if (o.type === 'checkbox') {
    return `<label class="field check ${o.cls || ''}" for="${id}"><input type="checkbox" id="${id}" data-bind="${path}" ${
      o.rerender ? 'data-rerender="1"' : ''
    } ${v ? 'checked' : ''}><span>${esc(label)}</span></label>`;
  }
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
  orders: [],
  forms: [], // טופסי בחירת מנות שנשלחו ללקוחות (רק עם Supabase)
  formsError: null,
  orderFilter: { q: '', status: '', sort: 'event' },
  landingRange: '30',
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
  state.orders = await state.store.listOrders();
  await loadForms();
}

async function loadForms() {
  if (!state.store.formsSupported) return;
  try {
    state.forms = await state.store.listForms();
    state.formsError = null;
  } catch (err) {
    state.formsError = err.code === 'no-forms' ? 'no-table' : err.message;
  }
}

// הזמנה מקושרת להצעה (אחת לכל הצעה)
const orderOf = (q) => state.orders.find((o) => o.quoteId === q?.id) || null;
const quoteOf = (o) => state.quotes.find((q) => q.id === o?.quoteId) || null;
const formOf = (q) => state.forms.find((f) => f.quote_id === q?.id) || null;

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
  if (/^#(access_token|error|type)=/.test(location.hash)) history.replaceState(null, '', location.pathname + '#/');
  lastHash = location.hash;
  $$('.modal-back').forEach((m) => m.remove()); // חלון פתוח (למשל וואטסאפ) נסגר במעבר דף
  const [, page, id] = (location.hash || '#/').split('/');
  const navPage = page?.startsWith('order') ? 'orders' : page || 'list';
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === navPage));
  window.scrollTo(0, 0);
  try {
    if (!page || page === 'list') {
      await loadForms();
      return renderList();
    }
    if (page === 'new') return renderEditor(newQuote(id ? decodeURIComponent(id) : null));
    if (page === 'edit' && id === 'draft') return renderEditor(null);
    if (page === 'edit') {
      const q = state.quotes.find((x) => x.id === id) || (await state.store.getQuote(id));
      return q ? renderEditor(clone(q)) : notFound();
    }
    if (page === 'view') {
      await loadForms();
      const q = state.quotes.find((x) => x.id === id) || (await state.store.getQuote(id));
      return q ? renderView(q) : notFound();
    }
    if (page === 'orders') {
      await loadForms();
      return renderOrders();
    }
    if (page === 'order-new') {
      const q = state.quotes.find((x) => x.id === id);
      if (!q) return notFound();
      if (orderOf(q)) return go(`#/order/${orderOf(q).id}`);
      if (q.status !== 'approved') {
        toast('אפשר ליצור הזמנה רק מהצעה מאושרת', 'error');
        return go(`#/view/${q.id}`);
      }
      const pending = state.pendingOrder?.quoteId === q.id ? state.pendingOrder : null;
      state.pendingOrder = null;
      return renderOrderEditor(pending || newOrder(q, state.settings.menu), q);
    }
    if (page === 'order' || page === 'order-edit') {
      const o = state.orders.find((x) => x.id === id);
      const q = quoteOf(o);
      if (!o || !q) return notFound();
      return page === 'order' ? renderOrderView(o, q) : renderOrderEditor(clone(o), q);
    }
    if (page === 'customers') return renderCustomers();
    if (page === 'settings') return renderSettings();
    if (page === 'landing') return showLanding();
    notFound();
  } catch (err) {
    console.error(err);
    toast('שגיאה: ' + err.message, 'error');
  }
}

function showLanding({ recentOpen = false } = {}) {
  return renderLanding($('#main'), state.store, {
    range: state.landingRange,
    toast,
    recentOpen,
    onRange: (r) => {
      state.landingRange = r;
      showLanding();
    },
    // המכשירים של בעלי העסק נשמרים בהגדרות (בענן), כך שהסימון לא תלוי בדפדפן
    ownDevices: state.settings.lpOwnDevices || [],
    onOwnDevices: async (list) => {
      const next = { ...state.settings, lpOwnDevices: list };
      await state.store.saveSettings(next);
      state.settings = next;
      showLanding({ recentOpen: true });
    },
  });
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
    starterNote: s.starterNote,
    packageStarters: Object.fromEntries(s.packages.map((p) => [p.id, Number(p.starterCount) || 0])),
    images: s.images,
  });
}

function newQuote(customerKey) {
  const s = state.settings;
  const d = s.quoteDefaults;
  const pkg = s.packages.find((p) => p.id === d.packageId) || s.packages[0] || {};
  const q = {
    id: null,
    number: null,
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: null,
    quoteDate: today(),
    customer: { name: '', phone: '', email: '' },
    event: {
      type: s.eventTypes.includes(d.eventType) ? d.eventType : s.eventTypes[0] || 'אחר',
      typeOther: '',
      dateMode: 'exact',
      date: '',
      monthNum: '',
      year: '',
      address: '',
      startTime: d.startTime || '',
    },
    guests: { adults: '', children: '', infants: '', max: '' },
    packageId: pkg.id,
    pkg: clone(pkg),
    pricing: { mode: 'auto', perGuest: '' },
    display: { showBreakdown: d.showBreakdown !== false },
    pizzaCount: d.pizzaCount,
    starterCount: Number(pkg.starterCount) || 0,
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
    // הצעות בלי תאריך אירוע תמיד בסוף, בשני הכיוונים
    event: (a, b) => (eventDateKey(a) || '9999').localeCompare(eventDateKey(b) || '9999'),
    eventDesc: (a, b) => (eventDateKey(b) || '0000').localeCompare(eventDateKey(a) || '0000'),
    total: (a, b) => calcQuote(b).total - calcQuote(a).total,
  }[sort];
  return [...list].sort(by);
}

function renderList() {
  const f = state.listFilter;
  const s = state.settings;
  const counts = Object.fromEntries(STATUSES.map((st) => [st.id, 0]));
  state.quotes.forEach((q) => (counts[q.status] = (counts[q.status] || 0) + 1));
  const upcomingApproved = state.quotes.filter((q) => q.status === 'approved' && eventDateKey(q) >= today().slice(0, 8));

  $('#main').innerHTML = `
    <div class="page-head">
      <h1>הצעות מחיר</h1>
      <div class="head-actions">
        <button class="btn" id="paste-new">📋 הצעה מהודעה</button>
        <a class="btn primary" href="#/new">+ הצעה חדשה</a>
      </div>
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
        <option value="event" ${f.sort === 'event' ? 'selected' : ''}>מיון: תאריך אירוע – מהקרוב לרחוק</option>
        <option value="eventDesc" ${f.sort === 'eventDesc' ? 'selected' : ''}>מיון: תאריך אירוע – מהרחוק לקרוב</option>
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
                <td data-l="תאריך">${esc(eventDateShort(q)) || '—'}</td>
                <td data-l="סכום" class="money">${formatILS(c.total)}</td>
                <td data-l="סטטוס"><select class="status-select badge ${q.status}" data-act="status">${STATUSES.map((st) => `<option value="${st.id}" ${st.id === q.status ? 'selected' : ''}>${st.label}</option>`).join('')}</select></td>
                <td class="actions">
                  <a class="icon" href="#/view/${q.id}" title="תצוגה">👁</a>
                  <a class="icon" href="#/edit/${q.id}" title="עריכה">✎</a>
                  <button class="icon" data-act="dup" title="שכפול">⧉</button>
                  <button class="icon" data-act="pdf" title="הורדת PDF">⬇</button>
                  <button class="icon" data-act="wa" title="שליחה בוואטסאפ">💬</button>
                  ${formIcon(q)}${orderLink(q, true)}
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
  $('#paste-new').addEventListener('click', () =>
    openPasteDialog((parsed) => {
      const q = newQuote();
      applyParsed(q, parsed.values);
      state.pendingDraft = q;
      state.pendingPasteReport = parsed;
      go('#/edit/draft');
    })
  );
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
    renderList(); // גם אם הביטול לא נשמר – מחזיר את הבחירה לסטטוס הקודם
  });
  $('#list-body').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const q = state.quotes.find((x) => x.id === btn.closest('tr').dataset.id);
    if (btn.dataset.act === 'dup') duplicateQuote(q);
    if (btn.dataset.act === 'pdf') downloadPdf(q);
    if (btn.dataset.act === 'wa') openWhatsApp(q);
    if (btn.dataset.act === 'del') deleteQuote(q);
    if (btn.dataset.act === 'send-form') sendForm(q);
    if (btn.dataset.act === 'load-form') loadFromForm(q);
  });
}

async function persist(q) {
  q.updatedAt = new Date().toISOString();
  await state.store.saveQuote(q);
  const i = state.quotes.findIndex((x) => x.id === q.id);
  if (i >= 0) state.quotes[i] = q;
  else state.quotes.push(q);
}

// מעבר לסטטוס "בוטלה" מחייב סיבת ביטול. מחזיר false אם השינוי לא נשמר.
async function setStatus(q, status) {
  if (status !== 'approved' && q.status === 'approved' && orderOf(q) && !confirmOrderStatus(q)) return false;
  let reason = q.cancelReason;
  if (status === 'cancelled') {
    reason = await askCancelReason(q);
    if (reason == null) return false;
  }
  q.status = status;
  if (status === 'cancelled') q.cancelReason = reason;
  else delete q.cancelReason;
  await persist(q);
  toast(`הסטטוס עודכן: ${statusLabel(status)}`);
  return true;
}

// חלון חובה להזנת סיבת ביטול. מחזיר את הסיבה, או null אם המשתמש סגר בלי לשמור.
function askCancelReason(q) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal card" role="dialog" aria-label="סיבת ביטול">
        <div class="modal-head"><h2>ביטול הצעה ${esc(q.number || '')}</h2><button class="icon" data-x title="סגירה">✕</button></div>
        <label class="field"><span>סיבת ביטול *</span><textarea id="cancel-reason" rows="4" required placeholder="למשל: הלקוח בחר ספק אחר">${esc(q.cancelReason || '')}</textarea>
          <small id="cancel-hint">שדה חובה. אי אפשר לשמור את הביטול בלי סיבה.</small></label>
        <div class="wa-actions">
          <button class="btn primary" id="cancel-ok">שמירת הביטול</button>
          <button class="btn ghost" data-x>חזרה בלי לשנות</button>
        </div>
      </div>`;
    document.body.append(back);
    const ta = $('#cancel-reason', back);
    const done = (v) => {
      back.remove();
      resolve(v);
    };
    back.addEventListener('click', (e) => {
      if (e.target === back || e.target.closest('[data-x]')) done(null);
    });
    ta.addEventListener('input', () => {
      ta.classList.remove('invalid');
      $('#cancel-hint', back).classList.remove('err');
    });
    $('#cancel-ok', back).addEventListener('click', () => {
      const v = ta.value.trim();
      if (!v) {
        ta.classList.add('invalid');
        $('#cancel-hint', back).classList.add('err');
        toast('יש להזין סיבת ביטול', 'error');
        ta.focus();
        return;
      }
      done(v);
    });
    ta.focus();
  });
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
  delete d.cancelReason;
  state.pendingDraft = d;
  go('#/edit/draft');
}

// שינוי סטטוס של הצעה מאושרת שכבר יש לה הזמנה – מבקשים אישור
function confirmOrderStatus(q) {
  return confirm(`להצעה ${q.number} יש הזמנה. לשנות את סטטוס ההצעה בכל זאת? ההזמנה תישאר.`);
}

async function deleteQuote(q) {
  const o = orderOf(q);
  const also = o ? ' וגם את ההזמנה המקושרת אליה' : '';
  if (!confirm(`למחוק את הצעה ${q.number} של ${q.customer?.name || 'ללא שם'}${also}? לא ניתן לבטל.`)) return;
  if (o) {
    await state.store.deleteOrder(o.id);
    state.orders = state.orders.filter((x) => x.id !== o.id);
  }
  await state.store.deleteQuote(q.id);
  state.quotes = state.quotes.filter((x) => x.id !== q.id);
  toast('ההצעה נמחקה');
  if (location.hash.startsWith('#/view')) go('#/');
  else renderList();
}

// ---------- PDF ----------
const pdfName = (q) => `הצעת מחיר ${q.number} - ${(q.customer?.name || '').replace(/[\\/:*?"<>|]/g, '')}.pdf`;

// טקסטים, כרטיסי שירות, לוגו ותמונות תמיד לפי ההגדרות הנוכחיות.
// קבוצות הגיל נשארות מההצעה עצמה כי הן משפיעות על המחיר.
function withLiveBrand(q) {
  const live = brandSnapshot(state.settings);
  return { ...q, brand: { ...live, ageGroups: q.brand?.ageGroups || live.ageGroups } };
}

// frozen – עותק PDF שהופק בעבר: מציגים אותו בדיוק כפי שהיה
async function prepareStage(q, { frozen = false, stage = $('#doc-stage') } = {}) {
  const doc = frozen ? q : withLiveBrand(q);
  const imgs = await resolveImages(doc.brand?.images);
  return renderPages(stage, doc, imgs);
}

// התצוגה המקדימה מציגה את אותן תמונות עמוד שנכנסות ל-PDF, כך שהם זהים לגמרי
let previewToken = 0;
async function renderPdfPreview(q, preview, prepare = (stage) => prepareStage(q, { stage })) {
  const token = ++previewToken;
  const stage = document.createElement('div');
  stage.className = 'offstage';
  document.body.append(stage);
  try {
    await prepare(stage);
    const canvases = await renderStageCanvases(stage);
    if (token !== previewToken || !preview.isConnected) return;
    preview.replaceChildren(
      ...canvases.map((c, i) => {
        const img = new Image();
        img.className = 'q-page-img';
        img.alt = `עמוד ${i + 1}`;
        img.src = c.toDataURL('image/jpeg', 0.9);
        return img;
      })
    );
    preview.classList.add('pdf-ready');
  } catch (err) {
    console.error('preview render failed', err); // נשארת התצוגה הרגילה
  } finally {
    stage.remove();
  }
}

// מפיק את קובץ ה-PDF ושומר עותק בהצעה (צילום מצב של ההצעה ברגע ההפקה)
async function generatePdf(q, { saveCopy = true, frozen = false, upload = false } = {}) {
  const doc = frozen ? q : withLiveBrand(q);
  await prepareStage(doc, { frozen: true });
  const name = pdfName(doc);
  const blob = await pagesToPdfBlob($('#doc-stage'), name.replace(/\.pdf$/, ''));
  let url = null;
  let uploadError = null;
  if (upload) {
    try {
      url = await state.store.uploadPdf(blob, doc.number);
    } catch (err) {
      uploadError = err;
    }
  }
  if (saveCopy && q.id) {
    const { generated, ...snap } = doc;
    const copy = { at: new Date().toISOString(), total: calcQuote(doc).total, snapshot: clone(snap) };
    if (url) copy.url = url;
    q.generated = [copy, ...(generated || [])].slice(0, 15);
    await persist(q);
  }
  return { blob, name, url, uploadError, doc };
}

async function downloadPdf(q, opts = {}) {
  busy(true, 'מפיק PDF...');
  try {
    const { blob, name } = await generatePdf(q, opts);
    saveBlob(blob, name);
    toast(opts.saveCopy === false ? 'ה-PDF הורד' : 'ה-PDF הורד ונשמר עותק בהצעה');
  } catch (err) {
    console.error(err);
    toast('שגיאה בהפקת PDF: ' + err.message, 'error');
  } finally {
    busy(false);
  }
}

// ---------- שליחה בוואטסאפ ----------
function waMessage(q, link) {
  const c = calcQuote(q);
  const msg = (state.settings.whatsapp?.message || '')
    .replaceAll('{שם_לקוח}', q.customer?.name || '')
    .replaceAll('{סוג_אירוע}', eventTypeLabel(q))
    .replaceAll('{תאריך_אירוע}', eventDateShort(q) || '')
    .replaceAll('{מספר_הצעה}', String(q.number ?? ''))
    .replaceAll('{סכום}', formatILS(c.total))
    .replaceAll('{קישור}', link || '');
  return msg
    .replace(/[ \t]*\(\s*\)/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// חלון שליחה בוואטסאפ (להצעה או להזמנה): מפיק PDF, מעלה אותו לקישור ופותח צ'אט עם ההודעה
async function openWaDialog({ title, customer, makePdf, message, onReady, onSent }) {
  const hasPhone = normPhone(customer?.phone).length >= 9;
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal card" role="dialog" aria-label="שליחה בוואטסאפ">
      <div class="modal-head"><h2>${esc(title)}</h2><button class="icon" data-x title="סגירה">✕</button></div>
      <div class="wa-status" id="wa-status"><span class="spinner small"></span> מכין את ה-PDF…</div>
      <div id="wa-body" hidden>
        <label class="field"><span>ההודעה (אפשר לערוך)</span><textarea id="wa-msg" rows="6"></textarea></label>
        <div class="wa-actions">
          <button class="btn wa-btn" id="wa-customer" ${hasPhone ? '' : 'disabled'}>💬 ללקוח: ${esc(customer?.name || '')} <span dir="ltr">${esc(customer?.phone || 'אין טלפון')}</span></button>
          <div class="wa-other">
            <input type="tel" id="wa-phone" dir="ltr" placeholder="מספר אחר: 050-1234567" inputmode="tel">
            <button class="btn" id="wa-other-send">שליחה</button>
          </div>
          <button class="btn ghost" id="wa-pick">👥 בחירת איש קשר בוואטסאפ</button>
          <button class="btn ghost" id="wa-share" hidden>📎 שיתוף קובץ ה-PDF (בוחרים וואטסאפ ונמען)</button>
          <button class="btn ghost" id="wa-download">⬇ הורדת ה-PDF</button>
        </div>
      </div>
    </div>`;
  document.body.append(back);
  const close = () => back.remove();
  back.addEventListener('click', (e) => {
    if (e.target === back || e.target.closest('[data-x]')) close();
  });

  let result = {};
  if (makePdf) {
    try {
      result = await makePdf();
    } catch (err) {
      $('#wa-status', back).innerHTML = `⚠️ שגיאה בהפקת ה-PDF: ${esc(err.message)}`;
      return;
    }
  }
  const { blob, name, url, uploadError } = result;
  const file = blob ? new File([blob], name, { type: 'application/pdf' }) : null;
  const canShareFile = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));

  let status;
  if (!makePdf) status = '';
  else if (url) status = '✅ ה-PDF מוכן, והקישור אליו נוסף להודעה. הלקוח יפתח אותו בלחיצה.';
  else if (uploadError?.code === 'nobucket')
    status = '⚠️ ה-PDF מוכן, אבל עדיין אין אחסון לקישור. צריך להריץ פעם אחת את הקובץ supabase-storage.sql ב-Supabase (הסבר ב-README). בינתיים: "שיתוף קובץ ה-PDF" או הורדה וצירוף ידני.';
  else if (uploadError) status = `⚠️ ה-PDF מוכן, אבל העלאת הקישור נכשלה (${esc(uploadError.message)}). אפשר לשתף את הקובץ עצמו.`;
  else status = 'ℹ️ ה-PDF מוכן. במצב מקומי אין קישור – שתפו את הקובץ או הורידו וצרפו אותו.';
  $('#wa-status', back).innerHTML = status;
  $('#wa-status', back).hidden = !status;
  $('#wa-msg', back).value = message(result);
  $('#wa-body', back).hidden = false;
  $('#wa-share', back).hidden = !canShareFile;
  $('#wa-download', back).hidden = !blob;
  onReady?.(result);

  const openChat = (phone) => {
    const text = encodeURIComponent($('#wa-msg', back).value);
    const target = phone ? `https://wa.me/${waPhone(phone)}?text=${text}` : `https://wa.me/?text=${text}`;
    const w = window.open(target, '_blank', 'noopener');
    if (!w) location.href = target;
    onSent?.();
  };
  $('#wa-customer', back).addEventListener('click', () => openChat(customer.phone));
  $('#wa-other-send', back).addEventListener('click', () => {
    const ph = $('#wa-phone', back).value.trim();
    if (!validPhone(ph)) return toast('מספר לא תקין – 10 ספרות שמתחילות ב-05', 'error');
    openChat(ph);
  });
  $('#wa-pick', back).addEventListener('click', () => openChat(null));
  $('#wa-share', back).addEventListener('click', async () => {
    try {
      await navigator.share({ files: [file], text: $('#wa-msg', back).value });
      onSent?.();
    } catch (err) {
      if (err.name !== 'AbortError') toast('השיתוף נכשל: ' + err.message, 'error');
    }
  });
  $('#wa-download', back).addEventListener('click', () => saveBlob(blob, name));
}

function openWhatsApp(q) {
  return openWaDialog({
    title: `💬 שליחת הצעה ${q.number} בוואטסאפ`,
    customer: q.customer,
    makePdf: () => generatePdf(q, { upload: true }),
    message: (r) => waMessage(r.doc, r.url),
    onReady: () => renderSideCopies(q),
    onSent: async () => {
      if (q.status !== 'draft') return;
      await setStatus(q, 'sent');
      const sel = $('#v-status');
      if (sel) {
        sel.value = 'sent';
        sel.className = 'status-select badge sent';
      }
    },
  });
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
  // דוח מילוי אוטומטי מהודעה (אם ההצעה נוצרה מהדבקת טקסט)
  let pasteReport = state.pendingPasteReport || null;
  state.pendingPasteReport = null;
  // השלמת שדות להצעות שנשמרו בגרסה קודמת
  q.pricing ??= { mode: pricingModeOf(q), perGuest: '' };
  q.display ??= { showBreakdown: true };
  q.event.dateMode ??= 'exact';
  q.pizzaCount ??= 6;
  q.starterCount ??= Number(s.packages.find((p) => p.id === q.packageId)?.starterCount) || 0;

  const validate = s.quoteDefaults.validatePhone !== false;
  // ההצעה שומרת עותק של המחירון; מציינים אם המחירון בהגדרות השתנה מאז
  const pricesStale = () => {
    const p = s.packages.find((x) => x.id === q.packageId);
    if (!q.id || !p) return false;
    const diff = (a, b, keys) => keys.some((k) => String(a?.[k] ?? '') !== String(b?.[k] ?? ''));
    return (
      diff(q.pkg, p, ['hours', 'minGuests', 'minPrice', 'extraAdult']) ||
      diff(q.extension, s.extension, ['hourPrice', 'halfHourPrice']) ||
      diff(q.depositRules, s.deposit, ['percent', 'min'])
    );
  };
  const staleBanner = () =>
    pricesStale()
      ? `<div class="stale">המחירון או שעות ההגשה בהגדרות השתנו מאז שההצעה נשמרה. ההצעה משתמשת במחירים שלה.
          <button type="button" class="btn small" data-act="refresh-prices">עדכון למחירון הנוכחי</button></div>`
      : '';
  const servingText = () => {
    const mins = Number(q.pkg.hours || 0) * 60 + Number(q.extensionMinutes || 0);
    const t = q.event.startTime;
    return `${formatDuration(mins)}${t ? ` · ${t}–${addMinutes(t, mins)}` : ''}`;
  };
  const years = [];
  for (let y = new Date().getFullYear(); y <= new Date().getFullYear() + 3; y++) years.push([y, y]);

  $('#main').innerHTML = `
    <div class="page-head">
      <h1>${q.id ? `עריכת הצעה ${esc(q.number)}` : 'הצעה חדשה'}</h1>
      <div class="head-actions">
        <a class="btn ghost" href="${q.id ? `#/view/${q.id}` : '#/'}">ביטול</a>
        ${q.id ? '' : '<button class="btn ghost" id="paste-fill">📋 מילוי מהודעה</button>'}
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
        ${field('טלפון נייד', 'customer.phone', q, {
          type: 'tel',
          dir: 'ltr',
          required: validate,
          placeholder: '050-1234567',
          hint: validate ? '<span id="phone-hint">10 ספרות שמתחילות ב-05</span>' : '',
        })}
        ${field('אימייל (רשות)', 'customer.email', q, { type: 'email', dir: 'ltr' })}
      </div>
      <h2>פרטי האירוע</h2>
      <div class="grid">
        ${field('סוג האירוע', 'event.type', q, { options: s.eventTypes, rerender: true })}
        ${q.event.type === 'אחר' ? field('פירוט סוג האירוע', 'event.typeOther', q) : ''}
        ${field('מועד האירוע', 'event.dateMode', q, { options: [['exact', 'תאריך ידוע'], ['month', 'ידוע רק החודש']], rerender: true })}
        ${
          q.event.dateMode === 'month'
            ? `<div class="pair">${field('חודש', 'event.monthNum', q, { type: 'number', options: HEB_MONTHS.map((m, i) => [i + 1, m]) })}${field('שנה', 'event.year', q, { type: 'number', options: years })}</div>`
            : field('תאריך האירוע', 'event.date', q, { type: 'date' })
        }
        ${field('שעת תחילת הגשה', 'event.startTime', q, { type: 'time' })}
        ${field('כתובת האירוע', 'event.address', q, { cls: 'span2' })}
      </div>
      <h2>פרטי ההצעה</h2>
      <div class="grid">
        ${field('תאריך ההצעה', 'quoteDate', q, { type: 'date' })}
        ${field('סטטוס', 'status', q, { options: STATUSES.map((x) => [x.id, x.label]), rerender: true })}
        ${q.status === 'cancelled' ? field('סיבת ביטול', 'cancelReason', q, { type: 'textarea', required: true, cls: 'span2', hint: '<span id="cancel-hint">שדה חובה כשההצעה מבוטלת</span>' }) : ''}
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
      <div class="calc-note" id="pkg-calc"></div>
      <h2>תמחור וזמן הגשה</h2>
      <div class="grid">
        ${field('אופן התמחור', 'pricing.mode', q, {
          rerender: true,
          options: [
            ['auto', 'לפי המחירון (מינימום + משתתף נוסף)'],
            ['perGuest', 'מחיר ידני למשתתף'],
            ['total', 'סכום ידני למסלול'],
          ],
        })}
        ${
          q.pricing.mode === 'perGuest'
            ? field('מחיר למבוגר (₪)', 'pricing.perGuest', q, { type: 'number', min: 0, hint: 'ילד משלם חצי מהמחיר' })
            : q.pricing.mode === 'total'
              ? field('מחיר המסלול (₪)', 'overrides.packagePrice', q, { type: 'number', min: 0, hint: 'סכום קבוע, לא משתנה לפי הכמות' })
              : `<div class="field"><span>מחיר לפי המחירון</span><div class="readonly">${formatILS(c.computedPackage)}</div></div>`
        }
        ${field('שעות הגשה כלולות במסלול', 'pkg.hours', q, { type: 'number', step: 0.5, min: 0 })}
        <div class="field"><span>זמני הגשה (כולל הארכה)</span><div class="readonly" id="serving">${esc(servingText())}</div></div>
        ${field('הצגת פירוט המחיר בהצעה ללקוח', 'display.showBreakdown', q, { type: 'checkbox', cls: 'span2' })}
      </div>
      <details class="sub">
        <summary>עריכת מחירי המסלול להצעה זו בלבד</summary>
        <div class="grid four">
          ${field('מחיר מינימום', 'pkg.minPrice', q, { type: 'number' })}
          ${field('משתתפים כלולים במינימום', 'pkg.minGuests', q, { type: 'number' })}
          ${field('מחיר מבוגר נוסף', 'pkg.extraAdult', q, { type: 'number', hint: `ילד נוסף: ${formatILS(q.pkg.extraAdult * ages.childFactor)}` })}
          ${field('כלול במסלול', 'pkg.includes', q, { cls: 'span3' })}
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
        ${field('הארכה מעבר לזמן הכלול', 'extensionMinutes', q, { options: extOpts, type: 'number', hint: `כלול במסלול: ${esc(formatDuration(q.pkg.hours * 60))}` })}
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
      <label class="field"><span>שורה לכל סעיף. משתנים: {מקדמה} {יתרה} {סכום} {דמי_ביטול_חלקיים} {מספר_פיצות}</span>
        <textarea data-bind-lines="terms" rows="8">${esc(q.terms.join('\n'))}</textarea></label>
      <button type="button" class="btn small ghost" data-act="reset-terms">שחזור תנאי ברירת המחדל</button>
      <h2>בחירת פיצות</h2>
      <div class="grid">
        ${field('מספר סוגי הפיצות לבחירה', 'pizzaCount', q, { type: 'number', min: 1, rerender: true })}
        ${field('מספר מנות ראשונות לבחירה', 'starterCount', q, { type: 'number', min: 0, hint: '0 = לא מודפס (למשל במסלול פיצות בלבד)' })}
      </div>
      <p class="hint">אפשר לבחור עכשיו עד ${esc(q.pizzaCount)} סוגים, או להשאיר לבחירה בהמשך. אם לא נבחרו, יודפס: "${esc(fillTerms(s.menuNote, c))}"</p>
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
      ${row('משתתפים', esc(guestsText(q)) || '—')}
      ${row(`מסלול ${esc(q.pkg.name || '')}${c.pricingMode === 'perGuest' ? ` (${formatILS(c.perGuestPrice)} למשתתף)` : c.pricingMode === 'total' ? ' (ידני)' : ''}`, formatILS(c.packagePrice))}
      ${row('זמן הגשה', esc(servingText()), 'muted')}
      ${c.extPrice ? row('הארכה', formatILS(c.extPrice)) : ''}
      ${c.pastaPrice ? row('פסטות', formatILS(c.pastaPrice)) : ''}
      ${c.addonsTotal ? row('תוספות', formatILS(c.addonsTotal)) : ''}
      ${c.customTotal ? row('סעיפים חופשיים', formatILS(c.customTotal)) : ''}
      ${c.discount ? row('הנחה', '− ' + formatILS(c.discount), 'neg') : ''}
      ${row('סה״כ', formatILS(c.total), 'total')}
      ${c.billable ? row('ממוצע למבוגר', formatILS(c.perGuest), 'muted') : ''}
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
    if (calcEl)
      calcEl.innerHTML = `${guestsText(q) ? `המחיר מחושב ל-<b>${esc(guestsText(q))}</b> · ` : ''}מחיר המסלול: <b>${formatILS(c.packagePrice)}</b>${
        c.pricingMode === 'auto' ? '' : ` <small>(לפי המחירון: ${formatILS(c.computedPackage)})</small>`
      }`;
    const servEl = $('#serving');
    if (servEl) servEl.textContent = servingText();
    const ph = $('#f_customer_phone');
    if (ph && validate) {
      const bad = ph.value.trim() !== '' && !validPhone(ph.value);
      ph.classList.toggle('invalid', bad);
      $('#phone-hint')?.classList.toggle('err', bad);
    }
    const cr = $('#f_cancelReason');
    if (cr && cr.value.trim()) {
      cr.classList.remove('invalid');
      $('#cancel-hint')?.classList.remove('err');
    }
  };

  const drawStep = () => {
    if (q.event.dateMode === 'month' && !q.event.monthNum) {
      const n = new Date();
      q.event.monthNum = n.getMonth() + 1;
      q.event.year = n.getFullYear();
    }
    form.innerHTML =
      staleBanner() +
      (step === 0 ? pasteBanner() : '') +
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
      q.starterCount = Number(p.starterCount) || 0;
      q.overrides.packagePrice = '';
      if (q.pricing.mode === 'total') q.pricing.mode = 'auto';
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
      if (picked.length > Number(q.pizzaCount || 0)) {
        el.checked = false;
        toast(`ניתן לבחור עד ${q.pizzaCount} סוגי פיצות`, 'error');
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
    else if (act === 'close-report') pasteReport = null;
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
      q.starterCount = Number(p.starterCount) || 0;
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
    if (validate && !validPhone(q.customer.phone)) {
      step = 0;
      drawStep();
      toast('מספר טלפון לא תקין – 10 ספרות שמתחילות ב-05 (למשל 050-1234567)', 'error');
      $('#f_customer_phone')?.focus();
      return;
    }
    if (q.status === 'cancelled' && !String(q.cancelReason || '').trim()) {
      step = 0;
      drawStep();
      toast('יש להזין סיבת ביטול', 'error');
      $('#f_cancelReason')?.classList.add('invalid');
      $('#cancel-hint')?.classList.add('err');
      $('#f_cancelReason')?.focus();
      return;
    }
    const saved = state.quotes.find((x) => x.id === q.id);
    if (saved?.status === 'approved' && q.status !== 'approved' && orderOf(q) && !confirmOrderStatus(q)) return;
    if (q.status === 'cancelled') q.cancelReason = q.cancelReason.trim();
    else delete q.cancelReason;
    busy(true, 'שומר...');
    try {
      if (!q.number) q.number = await state.store.nextNumber(Number(s.numbering.start) || 1);
      q.brand = withLiveBrand(q).brand;
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

  function pasteBanner() {
    if (!pasteReport) return '';
    const list = (items) => `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
    return `<div class="paste-report">
      <div class="paste-report-head"><b>📋 הפרטים מולאו אוטומטית מההודעה – עברו עליהם לפני השמירה</b>
        <button type="button" class="icon" data-act="close-report" title="הסתרה">✕</button></div>
      ${list(pasteReport.filled)}
      ${pasteReport.warnings.length ? `<div class="paste-warn"><b>⚠️ כדאי לבדוק:</b>${list(pasteReport.warnings)}</div>` : ''}
      ${pasteReport.ignored.length ? `<details><summary>שורות שלא זוהו (${pasteReport.ignored.length})</summary>${list(pasteReport.ignored)}</details>` : ''}
    </div>`;
  }
  $('#paste-fill')?.addEventListener('click', () =>
    openPasteDialog((parsed) => {
      applyParsed(q, parsed.values);
      pasteReport = parsed;
      state.dirty = true;
      step = 0;
      drawStep();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    })
  );
  if (pasteReport) state.dirty = true; // הצעה שנוצרה מהודעה עדיין לא נשמרה

  drawStep();
}

// ---------- הצעה מהודעה (הדבקת טקסט) ----------
function applyParsed(q, v) {
  const s = state.settings;
  if (v.name) q.customer.name = v.name;
  if (v.phone) q.customer.phone = v.phone;
  if (v.email) q.customer.email = v.email;
  if (v.eventType) {
    q.event.type = v.eventType;
    q.event.typeOther = v.eventTypeOther || '';
  }
  if (v.date) {
    q.event.dateMode = 'exact';
    q.event.date = v.date;
  } else if (v.monthNum) {
    q.event.dateMode = 'month';
    q.event.monthNum = v.monthNum;
    q.event.year = v.year;
  }
  if (v.startTime) q.event.startTime = v.startTime;
  if (v.address) q.event.address = v.address;
  for (const k of ['adults', 'children', 'infants']) if (v[k] != null) q.guests[k] = v[k];
  const p = v.packageId && s.packages.find((x) => x.id === v.packageId);
  if (p && p.id !== q.packageId) {
    q.packageId = p.id;
    q.pkg = clone(p);
    q.starterCount = Number(p.starterCount) || 0;
    q.overrides.packagePrice = '';
    if (q.pricing?.mode === 'total') q.pricing.mode = 'auto';
  }
  if (v.notes) q.internalNotes = [q.internalNotes, `הערות הלקוח: ${v.notes}`].filter(Boolean).join('\n');
}

function openPasteDialog(onApply) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal card" role="dialog" aria-label="הצעה מהודעה">
      <div class="modal-head"><h2>📋 הצעה מהודעה</h2><button class="icon" data-x title="סגירה">✕</button></div>
      <p class="hint">מדביקים את ההודעה מהלקוח (וואטסאפ או טופס), בפורמט "שדה: ערך" בכל שורה. המערכת ממלאת את ההצעה, ואתם רק עוברים על הפרטים.</p>
      <textarea id="paste-text" rows="11" placeholder="שם: ...&#10;טלפון: ...&#10;סוג האירוע: ...&#10;תאריך: ...&#10;מבוגרים: ..."></textarea>
      <div class="wa-actions">
        ${navigator.clipboard?.readText ? '<button class="btn ghost" id="paste-clip">📥 הדבקה מהלוח</button>' : ''}
        <button class="btn primary" id="paste-go">✨ מילוי ההצעה</button>
      </div>
    </div>`;
  document.body.append(back);
  const close = () => back.remove();
  back.addEventListener('click', (e) => {
    if (e.target === back || e.target.closest('[data-x]')) close();
  });
  $('#paste-text', back).focus();
  $('#paste-clip', back)?.addEventListener('click', async () => {
    try {
      $('#paste-text', back).value = await navigator.clipboard.readText();
    } catch {
      toast('אין גישה ללוח – הדביקו ידנית בתיבה (לחיצה ארוכה ← הדבק)', 'error');
    }
  });
  $('#paste-go', back).addEventListener('click', () => {
    const parsed = parseRequest($('#paste-text', back).value, state.settings);
    if (!parsed.filled.length) return toast('לא זוהו פרטים בהודעה. ודאו שכל שורה בפורמט "שדה: ערך"', 'error');
    close();
    onApply(parsed);
  });
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
        <button class="btn ghost" id="v-pdf">⬇ הורדת PDF</button>
        <button class="btn primary wa-main" id="v-wa">💬 שליחה בוואטסאפ</button>
        <span id="v-order">${orderLink(q)}${formButtons(q)}</span>
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
        <div class="internal-notes" id="v-cancel-reason" ${q.status === 'cancelled' ? '' : 'hidden'}><b>סיבת ביטול:</b><br><span>${esc(q.cancelReason || '')}</span></div>
        ${q.internalNotes ? `<div class="internal-notes"><b>הערות פנימיות:</b><br>${esc(q.internalNotes).replace(/\n/g, '<br>')}</div>` : ''}
        <div id="copies-box">${copiesHtml(q)}</div>
      </aside>
    </div>`;

  const pages = await prepareStage(q);
  const preview = $('#preview');
  preview.innerHTML = '';
  $$('#doc-stage .q-page').forEach((p) => preview.append(p.cloneNode(true)));
  renderPdfPreview(q, preview);
  const fit = () => {
    const w = $('.preview-wrap')?.clientWidth;
    if (w) preview.style.zoom = Math.min(1, (w - 24) / 794);
  };
  fit();
  window.onresize = fit;
  preview.dataset.pages = pages;

  $('#v-status').addEventListener('change', async (e) => {
    await setStatus(q, e.target.value);
    e.target.value = q.status;
    e.target.className = `status-select badge ${q.status}`;
    $('#v-order').innerHTML = orderLink(q) + formButtons(q);
    const cr = $('#v-cancel-reason');
    if (cr) {
      cr.hidden = q.status !== 'cancelled';
      $('span', cr).textContent = q.cancelReason || '';
    }
  });
  $('#v-order').addEventListener('click', (e) => formAction(e, q));
  $('#v-dup').addEventListener('click', () => duplicateQuote(q));
  $('#v-del').addEventListener('click', () => deleteQuote(q));
  $('#v-print').addEventListener('click', async () => {
    await prepareStage(q);
    window.print();
  });
  $('#v-pdf').addEventListener('click', async () => {
    await downloadPdf(q);
    renderSideCopies(q);
  });
  $('#v-wa').addEventListener('click', () => openWhatsApp(q));
  $('#copies-box').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    const g = q.generated[+b.dataset.copy];
    await downloadPdf({ ...g.snapshot, generated: [] }, { saveCopy: false, frozen: true });
  });
}

function copiesHtml(q) {
  return `<h3>עותקי PDF שהופקו</h3>${
    q.generated?.length
      ? `<ul class="copies">${q.generated
          .map(
            (g, i) => `<li><span>${new Date(g.at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })} · ${formatILS(g.total)}</span>
              <span>${g.url ? `<a class="btn small ghost" href="${esc(g.url)}" target="_blank" rel="noopener" title="הקישור שנשלח">🔗</a>` : ''}<button class="btn small ghost" data-copy="${i}" title="הורדת העותק">⬇</button></span></li>`
          )
          .join('')}</ul>`
      : '<p class="hint">עדיין לא הופק PDF. בכל הורדה או שליחה נשמר עותק של ההצעה כפי שהייתה באותו רגע.</p>'
  }`;
}

function renderSideCopies(q) {
  const box = $('#copies-box');
  if (box) box.innerHTML = copiesHtml(q);
}

function waPhone(p) {
  let d = normPhone(p);
  if (d.startsWith('0')) d = '972' + d.slice(1);
  return d;
}

// ---------- הזמנות ----------
const orderStatusLabel = (id) => ORDER_STATUSES.find((s) => s.id === id)?.label || id;
const orderStatusSelect = (o, id, attrs = '') =>
  `<select ${id ? `id="${id}"` : ''} class="status-select badge o-${o.status}" ${attrs}>${ORDER_STATUSES.map(
    (st) => `<option value="${st.id}" ${st.id === o.status ? 'selected' : ''}>${st.label}</option>`
  ).join('')}</select>`;

// כפתור/אייקון בהצעה: מעבר להזמנה הקיימת, או יצירת הזמנה (רק בהצעה מאושרת)
function orderLink(q, icon = false) {
  const o = orderOf(q);
  if (o) return icon ? `<a class="icon" href="#/order/${o.id}" title="להזמנה">📦</a>` : `<a class="btn ghost" href="#/order/${o.id}">📦 להזמנה ${esc(o.number)}</a>`;
  if (q.status !== 'approved') return '';
  return icon
    ? `<a class="icon" href="#/order-new/${q.id}" title="יצירת הזמנה">➕</a>`
    : `<a class="btn order-btn" href="#/order-new/${q.id}">📦 יצירת הזמנה</a>`;
}

async function persistOrder(o) {
  o.updatedAt = new Date().toISOString();
  await state.store.saveOrder(o);
  const i = state.orders.findIndex((x) => x.id === o.id);
  if (i >= 0) state.orders[i] = o;
  else state.orders.push(o);
}

const orderReq = (q) => orderRequirements(q, state.settings.menu);
const orderPdfName = (o, q) => `הזמנה ${o.number} - ${(q.customer?.name || '').replace(/[\\/:*?"<>|]/g, '')}.pdf`;

async function prepareOrderStage(o, q, stage = $('#doc-stage')) {
  const doc = withLiveBrand(q);
  const imgs = await resolveImages(doc.brand?.images);
  return renderPages(stage, doc, imgs, buildOrderBlocks(doc, imgs, o, state.settings.menu));
}

// לא שולחים/מפיקים הזמנה שחסרות בה מנות (למשל אם מספר הפיצות בהצעה השתנה)
function orderReady(o, q) {
  const problems = orderProblems(o, orderReq(q));
  if (!problems.length) return true;
  toast(`${problems[0].msg} – יש להשלים את בחירת המנות`, 'error');
  go(`#/order-edit/${o.id}`);
  return false;
}

async function generateOrderPdf(o, q, { upload = false } = {}) {
  await prepareOrderStage(o, q);
  const name = orderPdfName(o, q);
  const blob = await pagesToPdfBlob($('#doc-stage'), name.replace(/\.pdf$/, ''));
  let url = null;
  let uploadError = null;
  if (upload) {
    try {
      url = await state.store.uploadPdf(blob, `order-${o.number}`);
    } catch (err) {
      uploadError = err;
    }
  }
  if (url) {
    o.lastPdf = { at: new Date().toISOString(), url };
    await persistOrder(o);
  }
  return { blob, name, url, uploadError };
}

async function downloadOrderPdf(o, q) {
  if (!orderReady(o, q)) return;
  busy(true, 'מפיק PDF...');
  try {
    const { blob, name } = await generateOrderPdf(o, q);
    saveBlob(blob, name);
    toast('ה-PDF של ההזמנה הורד');
  } catch (err) {
    console.error(err);
    toast('שגיאה בהפקת PDF: ' + err.message, 'error');
  } finally {
    busy(false);
  }
}

function orderWaMessage(o, q, link) {
  return (state.settings.whatsapp?.orderMessage || '')
    .replaceAll('{שם_לקוח}', q.customer?.name || '')
    .replaceAll('{סוג_אירוע}', eventTypeLabel(q))
    .replaceAll('{תאריך_אירוע}', eventDateShort(q) || '')
    .replaceAll('{מספר_הזמנה}', String(o.number ?? ''))
    .replaceAll('{מספר_הצעה}', String(q.number ?? ''))
    .replaceAll('{סכום}', formatILS(calcQuote(q).total))
    .replaceAll('{קישור}', link || '')
    .replace(/[ \t]*\(\s*\)/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function openOrderWhatsApp(o, q) {
  if (!orderReady(o, q)) return;
  return openWaDialog({
    title: `💬 שליחת הזמנה ${o.number} בוואטסאפ`,
    customer: q.customer,
    makePdf: () => generateOrderPdf(o, q, { upload: true }),
    message: (r) => orderWaMessage(o, q, r.url),
    onSent: async () => {
      if (o.status !== 'new') return;
      o.status = 'sent';
      o.sentAt = new Date().toISOString();
      await persistOrder(o);
      toast('ההזמנה סומנה כנשלחה ללקוח');
      const sel = $('#o-status');
      if (sel) {
        sel.value = 'sent';
        sel.className = 'status-select badge o-sent';
      }
    },
  });
}

async function deleteOrder(o) {
  if (!confirm(`למחוק את הזמנה ${o.number}? ההצעה עצמה לא תימחק, ואפשר יהיה ליצור ממנה הזמנה חדשה.`)) return;
  await state.store.deleteOrder(o.id);
  state.orders = state.orders.filter((x) => x.id !== o.id);
  // הטופס שממנו נוצרה ההזמנה נפתח מחדש: אפשר לטעון שוב את הבחירה, והלקוח יכול לעדכן אותה
  const f = state.forms.find((x) => x.quote_id === o.quoteId);
  if (f?.loaded_at && state.store.reopenForm) {
    try {
      await state.store.reopenForm(f.token);
      f.loaded_at = null;
    } catch (err) {
      toast('ההזמנה נמחקה, אבל פתיחת טופס המנות מחדש נכשלה: ' + err.message, 'error');
    }
  }
  toast('ההזמנה נמחקה');
  go('#/orders');
}

function sortOrders(list, sort) {
  const key = (o) => eventDateKey(quoteOf(o) || {});
  const by = {
    event: (a, b) => (key(a) || '9999').localeCompare(key(b) || '9999'),
    eventDesc: (a, b) => (key(b) || '0000').localeCompare(key(a) || '0000'),
    created: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
  }[sort];
  return [...list].sort(by);
}

function renderOrders() {
  const f = state.orderFilter;
  const counts = Object.fromEntries(ORDER_STATUSES.map((st) => [st.id, 0]));
  state.orders.forEach((o) => (counts[o.status] = (counts[o.status] || 0) + 1));
  // הצעות מאושרות שעוד אין להן הזמנה
  const waiting = sortQuotes(
    state.quotes.filter((q) => q.status === 'approved' && !orderOf(q)),
    'event'
  );

  $('#main').innerHTML = `
    <div class="page-head"><h1>הזמנות</h1></div>
    ${
      waiting.length
        ? `<section class="card waiting-orders">
            <h2>הצעות מאושרות שממתינות להזמנה (${waiting.length})</h2>
            ${
              state.store.formsSupported
                ? `<p class="hint">כשבוע לפני האירוע שולחים ללקוח טופס בחירת מנות. כשהוא ממלא – תגיע אליך התראה, ו"טעינת בחירת הלקוח" יוצרת את ההזמנה.</p>
                  ${state.formsError === 'no-table' ? `<div class="stale">${FORMS_SETUP_MSG}</div>` : ''}`
                : ''
            }
            <div class="waiting-list">${waiting
              .map(
                (q) => `<div class="waiting-item ${(daysUntil(q) ?? 99) >= 0 && daysUntil(q) <= 8 ? 'soon' : ''}" data-qid="${q.id}">
                  <span class="waiting-info"><span><b>${esc(q.customer?.name)}</b> · הצעה ${esc(q.number)} · ${esc(eventTypeLabel(q))} · ${esc(eventDateShort(q)) || 'ללא תאריך'}</span>
                    <span class="pills">${whenPill(q)}${formPill(q)}</span></span>
                  <span class="waiting-actions">${formButtons(q, true)}<a class="btn small ${state.store.formsSupported ? 'ghost' : 'order-btn'}" href="#/order-new/${q.id}">📦 ${state.store.formsSupported ? 'יצירה ידנית' : 'יצירת הזמנה'}</a></span>
                </div>`
              )
              .join('')}</div>
          </section>`
        : ''
    }
    <div class="stats">
      ${ORDER_STATUSES.map(
        (st) => `<button class="stat ${f.status === st.id ? 'on' : ''}" data-status="${st.id}"><b>${counts[st.id] || 0}</b><span class="badge o-${st.id}">${st.label}</span></button>`
      ).join('')}
    </div>
    <div class="toolbar">
      <input type="search" id="of-q" placeholder="חיפוש לפי שם, טלפון, מספר הזמנה..." value="${esc(f.q)}">
      <select id="of-status"><option value="">כל הסטטוסים</option>${ORDER_STATUSES.map((st) => `<option value="${st.id}" ${f.status === st.id ? 'selected' : ''}>${st.label}</option>`).join('')}</select>
      <select id="of-sort">
        <option value="event" ${f.sort === 'event' ? 'selected' : ''}>מיון: תאריך אירוע – מהקרוב לרחוק</option>
        <option value="eventDesc" ${f.sort === 'eventDesc' ? 'selected' : ''}>מיון: תאריך אירוע – מהרחוק לקרוב</option>
        <option value="created" ${f.sort === 'created' ? 'selected' : ''}>מיון: חדשות קודם</option>
      </select>
    </div>
    <div id="orders-body"></div>`;

  const draw = () => {
    const term = f.q.trim().toLowerCase();
    const rows = sortOrders(
      state.orders.filter((o) => {
        const q = quoteOf(o);
        if (f.status && o.status !== f.status) return false;
        if (!term) return true;
        return [o.number, q?.customer?.name, q?.customer?.phone, normPhone(q?.customer?.phone)].join(' ').toLowerCase().includes(term);
      }),
      f.sort
    );
    $('#orders-body').innerHTML = rows.length
      ? `<table class="quotes">
          <thead><tr><th>מס׳</th><th>לקוח</th><th>טלפון</th><th>אירוע</th><th>תאריך</th><th>משתתפים</th><th>מנות</th><th>סכום</th><th>סטטוס</th><th></th></tr></thead>
          <tbody>${rows
            .map((o) => {
              const q = quoteOf(o) || { customer: {} };
              const missing = q.id ? orderProblems(o, orderReq(q)).length : 0;
              return `<tr data-id="${o.id}">
                <td data-l="מס׳" class="num"><a href="#/order/${o.id}">${esc(o.number)}</a></td>
                <td data-l="לקוח"><a href="#/order/${o.id}"><b>${esc(q.customer?.name)}</b></a></td>
                <td data-l="טלפון"><a href="tel:${esc(normPhone(q.customer?.phone))}" dir="ltr">${esc(q.customer?.phone)}</a></td>
                <td data-l="אירוע">${esc(eventTypeLabel(q))}</td>
                <td data-l="תאריך">${esc(eventDateShort(q)) || '—'}</td>
                <td data-l="משתתפים">${esc(guestsText(q)) || '—'}</td>
                <td data-l="מנות">${missing ? '<span class="pill warn">חסרות מנות</span>' : '<span class="pill ok">✓ נבחרו</span>'}</td>
                <td data-l="סכום" class="money">${q.id ? formatILS(calcQuote(q).total) : '—'}</td>
                <td data-l="סטטוס">${orderStatusSelect(o, '', 'data-act="ostatus"')}</td>
                <td class="actions">
                  <a class="icon" href="#/order/${o.id}" title="תצוגה">👁</a>
                  <a class="icon" href="#/order-edit/${o.id}" title="עריכת המנות">✎</a>
                  <a class="icon" href="#/view/${o.quoteId}" title="ההצעה">📄</a>
                  <button class="icon" data-act="opdf" title="הורדת PDF">⬇</button>
                  <button class="icon" data-act="owa" title="שליחה בוואטסאפ">💬</button>
                </td>
              </tr>`;
            })
            .join('')}</tbody></table>`
      : `<div class="empty"><p>${
          state.orders.length
            ? 'לא נמצאו הזמנות התואמות לחיפוש.'
            : 'עדיין אין הזמנות. יוצרים הזמנה מתוך הצעת מחיר מאושרת (כפתור "📦 יצירת הזמנה").'
        }</p></div>`;
  };
  draw();

  $('.waiting-orders')?.addEventListener('click', (e) => {
    const id = e.target.closest('[data-qid]')?.dataset.qid;
    const q = state.quotes.find((x) => x.id === id);
    if (q) formAction(e, q);
  });
  $('#of-q').addEventListener('input', (e) => ((f.q = e.target.value), draw()));
  $('#of-status').addEventListener('change', (e) => ((f.status = e.target.value), renderOrders()));
  $('#of-sort').addEventListener('change', (e) => ((f.sort = e.target.value), draw()));
  $$('.stat[data-status]').forEach((b) =>
    b.addEventListener('click', () => ((f.status = f.status === b.dataset.status ? '' : b.dataset.status), renderOrders()))
  );
  $('#orders-body').addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'ostatus') return;
    const o = state.orders.find((x) => x.id === e.target.closest('tr').dataset.id);
    o.status = e.target.value;
    await persistOrder(o);
    toast(`סטטוס ההזמנה עודכן: ${orderStatusLabel(o.status)}`);
    renderOrders();
  });
  $('#orders-body').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const o = state.orders.find((x) => x.id === btn.closest('tr').dataset.id);
    const q = quoteOf(o);
    if (!q) return toast('ההצעה המקושרת לא נמצאה', 'error');
    if (btn.dataset.act === 'opdf') downloadOrderPdf(o, q);
    if (btn.dataset.act === 'owa') openOrderWhatsApp(o, q);
  });
}

// עורך הזמנה: בחירת המנות (חובה) והערות
function renderOrderEditor(o, q) {
  const s = state.settings;
  const req = orderReq(q);
  const c = calcQuote(q);
  let tried = false; // אחרי ניסיון שמירה – מסמנים באדום את מה שחסר
  const backHref = o.id ? `#/order/${o.id}` : `#/view/${q.id}`;

  $('#main').innerHTML = `
    <div class="page-head">
      <h1>${o.id ? `עריכת הזמנה ${esc(o.number)}` : `הזמנה חדשה מהצעה ${esc(q.number)}`}</h1>
      <div class="head-actions">
        <a class="btn ghost" href="${backHref}">ביטול</a>
        <button class="btn" id="o-save">שמירה</button>
        <button class="btn primary" id="o-save-view">שמירה ותצוגה מקדימה</button>
      </div>
    </div>
    <form id="oform" class="card order-form" autocomplete="off" onsubmit="return false">
      <div class="order-quote">
        <div><b>${esc(q.customer?.name)}</b> · <span dir="ltr">${esc(q.customer?.phone)}</span></div>
        <div>${esc(eventTypeLabel(q))} · ${esc(eventDateShort(q)) || 'ללא תאריך'} · מסלול ${esc(q.pkg?.name || '')} · ${esc(guestsText(q)) || '—'} · ${formatILS(c.total)}</div>
        <a href="#/view/${q.id}">📄 להצעה ${esc(q.number)}</a>
      </div>
      ${o.formToken ? '<div class="from-form">📥 המנות נטענו מהטופס שהלקוח מילא. עברו עליהן ושמרו כדי ליצור את ההזמנה.</div>' : ''}
      <div id="o-picks"></div>
      <h2>הערות</h2>
      ${field('הערות ללקוח (יודפסו בהזמנה)', 'notes', o, { type: 'textarea' })}
      <div class="internal-box">
        <h3>🔒 פנימי בלבד – לא מודפס</h3>
        ${field('הערות פנימיות', 'internalNotes', o, { type: 'textarea' })}
      </div>
      ${o.id ? `<div class="grid">${field('סטטוס ההזמנה', 'status', o, { options: ORDER_STATUSES.map((x) => [x.id, x.label]) })}</div>` : ''}
    </form>`;

  ensureFixed(o, req);
  const groups = [
    { key: 'pizzas', title: 'פיצות', list: s.menu.pizzas, need: req.pizzas, other: true },
    { key: 'starters', title: 'ראשונות וסלטים', list: s.menu.starters, need: req.starters },
    { key: 'desserts', title: 'קינוחים', list: s.menu.desserts, need: 0, optional: true },
  ].filter((g) => g.need > 0 || (g.optional && visibleItems(g.list).length) || o[g.key]?.length);

  const fixedOf = (g) => req.fixed?.[g.key] || [];
  const countText = (g) => {
    const n = chosen(o, req, g.key).length;
    const plus = fixedOf(g).length ? ` (בנוסף ל${fixedOf(g).join(', ')})` : '';
    if (!g.need) return `רשות · נבחרו ${n}${plus}`;
    return `${n === g.need ? '✓ ' : ''}נבחרו ${n} מתוך ${g.need}${plus}`;
  };
  const countState = (g) => {
    if (!g.need) return '';
    return chosen(o, req, g.key).length === g.need ? 'ok' : tried ? 'err' : '';
  };

  const drawPicks = () => {
    $('#o-picks').innerHTML = groups
      .map((g) => {
        const items = visibleItems(g.list);
        const names = items.map((x) => x.name);
        const extra = (o[g.key] || []).filter((n) => !names.includes(n)); // "אחר" או מנה שהוסרה מהתפריט
        return `<section class="pick-group" data-group="${g.key}">
          <h2>${esc(g.title)}${g.need ? ` – יש לבחור ${g.need} *` : ' (רשות)'}</h2>
          <p class="pick-count ${countState(g)}" data-count="${g.key}">${countText(g)}</p>
          <div class="chips">
            ${[...names, ...extra]
              .map((n) => {
                const it = items.find((x) => x.name === n);
                const fixed = fixedOf(g).includes(n);
                return `<label class="chip ${fixed ? 'fixed' : ''}" ${it?.desc ? `title="${esc(it.desc)}"` : ''}><input type="checkbox" data-pick="${g.key}" value="${esc(n)}" ${
                  (o[g.key] || []).includes(n) ? 'checked' : ''
                } ${fixed ? 'disabled' : ''}> ${esc(n)}${fixed ? ' 🔒' : ''}${it?.note ? ` <small class="chip-note">${esc(it.note)}</small>` : ''}</label>`;
              })
              .join('')}
          </div>
          ${
            g.other
              ? `<div class="other-add"><input type="text" id="other-${g.key}" placeholder="פיצה שתואמה בנפרד (אחר)" maxlength="80">
                  <button type="button" class="btn small ghost" data-add-other="${g.key}">+ הוספת "אחר"</button></div>`
              : ''
          }
        </section>`;
      })
      .join('');
  };
  drawPicks();

  const refreshCount = (g) => {
    const cnt = $(`[data-count="${g.key}"]`, form);
    cnt.textContent = countText(g);
    cnt.className = `pick-count ${countState(g)}`;
  };
  // פיצה "אחר" – תואמה בנפרד ולא מופיעה בתפריט; נספרת בכמות
  $('#o-picks').addEventListener('click', (e) => {
    const key = e.target.closest('[data-add-other]')?.dataset.addOther;
    if (!key) return;
    const g = groups.find((x) => x.key === key);
    const input = $(`#other-${key}`);
    const text = input.value.trim();
    if (!text) return toast('כתבו איזו פיצה תואמה', 'error');
    if (chosen(o, req, key).length >= g.need) return toast(`כבר נבחרו ${g.need} ב${g.title}. בטלו קודם בחירה אחרת.`, 'error');
    const name = OTHER_PREFIX + text;
    if (!(o[key] || []).includes(name)) o[key] = [...(o[key] || []), name];
    state.dirty = true;
    drawPicks();
  });

  const form = $('#oform');
  bindForm(form, o, () => (state.dirty = true));
  form.addEventListener('change', (e) => {
    const el = e.target;
    const key = el.dataset.pick;
    if (!key) return;
    const g = groups.find((x) => x.key === key);
    // שומרים לפי סדר התפריט, כדי שההדפסה תהיה מסודרת (מנות קבועות מסומנות ונעולות)
    const picked = $$(`[data-pick="${key}"]:checked`, form).map((x) => x.value);
    if (g.need && chosen({ [key]: picked }, req, key).length > g.need) {
      el.checked = false;
      toast(`ניתן לבחור עד ${g.need} ב${g.title}. כדי להחליף מנה – בטלו קודם בחירה אחרת.`, 'error');
      return;
    }
    o[key] = picked;
    state.dirty = true;
    refreshCount(g);
  });

  async function save(thenView) {
    const problems = orderProblems(o, req);
    if (problems.length) {
      tried = true;
      drawPicks();
      toast(problems.map((p) => p.msg).join(' · '), 'error');
      $(`[data-group="${problems[0].key}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (!o.id) {
      // הזמנה אחת לכל הצעה
      if (orderOf(q)) {
        toast('להצעה זו כבר קיימת הזמנה', 'error');
        return go(`#/order/${orderOf(q).id}`);
      }
      const live = state.quotes.find((x) => x.id === q.id);
      if (live?.status !== 'approved') return toast('ההצעה כבר לא מאושרת – אי אפשר ליצור ממנה הזמנה', 'error');
    }
    busy(true, 'שומר...');
    try {
      const isNew = !o.id;
      await persistOrder(o);
      if (isNew && o.formToken) {
        try {
          await state.store.markFormLoaded(o.formToken);
          const f = state.forms.find((x) => x.token === o.formToken);
          if (f) f.loaded_at = new Date().toISOString();
        } catch (err) {
          toast('ההזמנה נשמרה, אבל סימון הטופס כ"נטען" נכשל: ' + err.message, 'error');
        }
      }
      state.dirty = false;
      toast(isNew ? `הזמנה ${o.number} נוצרה` : `הזמנה ${o.number} נשמרה`);
      if (thenView || isNew) go(`#/order/${o.id}`);
    } catch (err) {
      toast('שגיאה בשמירה: ' + err.message, 'error');
    } finally {
      busy(false);
    }
  }
  $('#o-save').addEventListener('click', () => save(false));
  $('#o-save-view').addEventListener('click', () => save(true));
}

async function renderOrderView(o, q) {
  const c = calcQuote(q);
  const problems = orderProblems(o, orderReq(q));
  $('#main').innerHTML = `
    <div class="page-head">
      <h1>הזמנה ${esc(o.number)} · ${esc(q.customer?.name)}</h1>
      <div class="head-actions">
        ${orderStatusSelect(o, 'o-status')}
        <a class="btn ghost" href="#/order-edit/${o.id}">✎ עריכת המנות</a>
        <a class="btn ghost" href="#/view/${q.id}">📄 הצעה ${esc(q.number)}</a>
        <button class="btn ghost" id="o-print">🖨 הדפסה</button>
        <button class="btn ghost" id="o-pdf">⬇ הורדת PDF</button>
        <button class="btn primary wa-main" id="o-wa">💬 שליחה ללקוח</button>
        <button class="btn ghost danger" id="o-del">🗑</button>
      </div>
    </div>
    ${
      problems.length
        ? `<div class="stale">${esc(problems.map((p) => p.msg).join(' · '))}. ייתכן שההצעה עודכנה אחרי יצירת ההזמנה.
            <a class="btn small" href="#/order-edit/${o.id}">השלמת המנות</a></div>`
        : ''
    }
    <div class="view-layout">
      <div class="preview-wrap card"><div class="preview" id="preview"><div class="loading">טוען תצוגה...</div></div></div>
      <aside class="card side">
        <h3>פרטי ההזמנה</h3>
        <div class="sum-row"><span>תאריך האירוע</span><b>${esc(eventDateShort(q)) || '—'}</b></div>
        <div class="sum-row"><span>משתתפים</span><b>${esc(guestsText(q)) || '—'}</b></div>
        <div class="sum-row"><span>סה״כ</span><b>${formatILS(c.total)}</b></div>
        <div class="sum-row"><span>מקדמה</span><b>${formatILS(c.deposit)}</b></div>
        <div class="sum-row"><span>יתרה</span><b>${formatILS(c.balance)}</b></div>
        <div class="sum-row muted"><span>נוצרה</span><b>${new Date(o.createdAt).toLocaleDateString('he-IL')}</b></div>
        ${o.sentAt ? `<div class="sum-row muted"><span>נשלחה ללקוח</span><b>${new Date(o.sentAt).toLocaleDateString('he-IL')}</b></div>` : ''}
        ${o.lastPdf?.url ? `<p><a class="btn small ghost" href="${esc(o.lastPdf.url)}" target="_blank" rel="noopener">🔗 הקישור האחרון שנשלח</a></p>` : ''}
        ${o.internalNotes ? `<div class="internal-notes"><b>הערות פנימיות:</b><br>${esc(o.internalNotes).replace(/\n/g, '<br>')}</div>` : ''}
      </aside>
    </div>`;

  const pages = await prepareOrderStage(o, q);
  const preview = $('#preview');
  preview.innerHTML = '';
  $$('#doc-stage .q-page').forEach((p) => preview.append(p.cloneNode(true)));
  renderPdfPreview(q, preview, (stage) => prepareOrderStage(o, q, stage));
  const fit = () => {
    const w = $('.preview-wrap')?.clientWidth;
    if (w) preview.style.zoom = Math.min(1, (w - 24) / 794);
  };
  fit();
  window.onresize = fit;
  preview.dataset.pages = pages;

  $('#o-status').addEventListener('change', async (e) => {
    o.status = e.target.value;
    await persistOrder(o);
    e.target.className = `status-select badge o-${o.status}`;
    toast(`סטטוס ההזמנה עודכן: ${orderStatusLabel(o.status)}`);
  });
  $('#o-print').addEventListener('click', async () => {
    if (!orderReady(o, q)) return;
    await prepareOrderStage(o, q);
    window.print();
  });
  $('#o-pdf').addEventListener('click', () => downloadOrderPdf(o, q));
  $('#o-wa').addEventListener('click', () => openOrderWhatsApp(o, q));
  $('#o-del').addEventListener('click', () => deleteOrder(o));
}

// ---------- טופס בחירת מנות ללקוח ----------
// שבוע לפני האירוע שולחים ללקוח קישור לטופס. הבחירה שלו נשמרת ב-Supabase,
// ומכאן טוענים אותה להזמנה בלחיצה.
const daysUntil = (q) => {
  const k = eventDateKey(q);
  if (!k) return null;
  return Math.round((new Date(k + 'T12:00:00') - new Date(today() + 'T12:00:00')) / 86400000);
};

function formState(q) {
  const f = formOf(q);
  if (!f) return 'none';
  if (f.loaded_at && orderOf(q)) return 'loaded';
  if (f.submitted_at) return 'submitted';
  return 'sent';
}

function formPill(q) {
  return {
    sent: '<span class="pill wait">📝 הטופס נשלח – ממתין ללקוח</span>',
    submitted: '<span class="pill ok">✅ הלקוח בחר מנות</span>',
  }[formState(q)] || '';
}

function whenPill(q) {
  const d = daysUntil(q);
  if (d == null || d > 10) return '';
  if (d < 0) return '<span class="pill muted">האירוע עבר</span>';
  return `<span class="pill soon">⏰ ${d === 0 ? 'היום' : d === 1 ? 'מחר' : `בעוד ${d} ימים`}</span>`;
}

// כפתורי הטופס בהצעה מאושרת שעוד אין לה הזמנה
function formButtons(q, small = false) {
  if (q.status !== 'approved' || orderOf(q) || !state.store.formsSupported) return '';
  const st = formState(q);
  const cls = small ? 'btn small' : 'btn';
  return (
    (st === 'submitted' ? `<button type="button" class="${cls} order-btn" data-act="load-form">📥 טעינת בחירת הלקוח</button>` : '') +
    `<button type="button" class="${cls} ghost" data-act="send-form">📝 ${st === 'none' ? 'שליחת טופס מנות' : 'שליחת הטופס שוב'}</button>`
  );
}

// אייקון ברשימת ההצעות: שליחת טופס מנות, או טעינת הבחירה כשהלקוח כבר מילא
function formIcon(q) {
  if (q.status !== 'approved' || orderOf(q) || !state.store.formsSupported) return '';
  return formState(q) === 'submitted'
    ? '<button class="icon form-ready" data-act="load-form" title="הלקוח בחר מנות – טעינה להזמנה">📥</button>'
    : `<button class="icon" data-act="send-form" title="${formState(q) === 'none' ? 'שליחת טופס מנות ללקוח' : 'הטופס נשלח – שליחה שוב'}">📝</button>`;
}

function formAction(e, q) {
  const b = e.target.closest('[data-act]');
  if (b?.dataset.act === 'send-form') sendForm(q);
  if (b?.dataset.act === 'load-form') loadFromForm(q);
}

const FORMS_SETUP_MSG = 'כדי לשלוח טופס ללקוח צריך להריץ פעם אחת את הקובץ supabase-forms.sql ב-Supabase (הסבר ב-README)';

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function formWaMessage(q, link) {
  return (state.settings.whatsapp?.formMessage || '{קישור}')
    .replaceAll('{שם_לקוח}', q.customer?.name || '')
    .replaceAll('{סוג_אירוע}', eventTypeLabel(q))
    .replaceAll('{תאריך_אירוע}', eventDateShort(q) || '')
    .replaceAll('{מספר_הצעה}', String(q.number ?? ''))
    .replaceAll('{קישור}', link)
    .replace(/[ \t]*\(\s*\)/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sendForm(q) {
  if (state.formsError === 'no-table') return toast(FORMS_SETUP_MSG, 'error');
  const existing = formOf(q);
  if (existing?.loaded_at && orderOf(q)) return toast('הבחירה מהטופס כבר נטענה להזמנה', 'error');
  if (existing?.loaded_at) {
    // ההזמנה שנוצרה מהטופס נמחקה – פותחים את אותו קישור למילוי מחדש, בלי הבחירה הקודמת
    try {
      await state.store.reopenForm(existing.token, { clear: true });
      Object.assign(existing, { loaded_at: null, submission: null, submitted_at: null });
    } catch (err) {
      return toast('פתיחת הטופס מחדש נכשלה: ' + err.message, 'error');
    }
  } else if (existing?.submitted_at && !confirm('הלקוח כבר מילא את הטופס. לשלוח אותו שוב? הלקוח יראה את הבחירה שלו ויוכל לעדכן אותה.')) {
    return;
  }
  // אותו קישור נשמר לאורך זמן; התוכן (תפריט, כמויות) מתעדכן בכל שליחה
  const token = existing?.token || randomToken();
  const logo = String(state.settings.images?.logo || '');
  const data = formSnapshot(q, state.settings, {
    date: eventDateShort(q),
    eventType: eventTypeLabel(q),
    logo: /^(https?:|assets\/)/.test(logo) ? logo : '',
  });
  busy(true, 'מכין את הטופס...');
  try {
    await state.store.saveForm(token, q.id, data);
  } catch (err) {
    if (err.code === 'no-forms') {
      state.formsError = 'no-table';
      return toast(FORMS_SETUP_MSG, 'error');
    }
    return toast('שגיאה בהכנת הטופס: ' + err.message, 'error');
  } finally {
    busy(false);
  }
  if (!existing) state.forms.push({ token, quote_id: q.id, submission: null, submitted_at: null, loaded_at: null, created_at: new Date().toISOString() });
  refreshFormButtons(q);
  const link = new URL(`form.html?t=${token}`, location.href.split('#')[0]).href;
  openWaDialog({
    title: `📝 טופס בחירת מנות – ${q.customer?.name || ''}`,
    customer: q.customer,
    message: () => formWaMessage(q, link),
  });
}

// אחרי שליחה/טעינה – מעדכנים את הכפתורים בדף הנוכחי
function refreshFormButtons(q) {
  const v = $('#v-order');
  if (v) v.innerHTML = orderLink(q) + formButtons(q);
  if (location.hash.startsWith('#/orders')) renderOrders();
  else if (!location.hash || location.hash === '#/' || location.hash.startsWith('#/list')) renderList();
}

async function loadFromForm(q) {
  busy(true, 'טוען את בחירת הלקוח...');
  await loadForms();
  busy(false);
  const f = formOf(q);
  if (!f?.submission) return toast('עדיין לא התקבלה בחירה מהלקוח', 'error');
  if (orderOf(q)) return go(`#/order/${orderOf(q).id}`);
  const o = orderFromSubmission(q, state.settings.menu, f.submission);
  o.formToken = f.token;
  state.pendingOrder = o;
  go(`#/order-new/${q.id}`);
}

// הודעת בדיקה ישירות מהדפדפן ל-CallMeBot (התשובה עצמה לא קריאה – בודקים בוואטסאפ)
function sendNotifyTest(n) {
  let phone = normPhone(n?.phone);
  if (phone.startsWith('0')) phone = '972' + phone.slice(1);
  if (!phone || !String(n?.apikey || '').trim()) return toast('יש למלא טלפון ומפתח CallMeBot', 'error');
  const text = encodeURIComponent('✅ בדיקה: התראות ממערכת PIZZA-BAR מוגדרות');
  fetch(`https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${text}&apikey=${encodeURIComponent(n.apikey.trim())}`, { mode: 'no-cors' })
    .then(() => toast('הבקשה נשלחה – בדקו שהגיעה הודעה בוואטסאפ (לפעמים לוקח דקה). אל תשכחו "שמירת הגדרות".'))
    .catch((err) => toast('השליחה נכשלה: ' + err.message, 'error'));
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
    if (eventDateKey(q) > (e.lastKey || '')) {
      e.lastKey = eventDateKey(q);
      e.last = eventDateShort(q);
    }
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
              <td data-l="אירוע אחרון">${esc(e.last) || '—'}</td>
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
  const linesOf = (arr) => arr.map(menuLine).join('\n');
  const parseLines = (t) => t.split('\n').map((l) => l.trim()).filter(Boolean).map(parseMenuLine);

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
          ${field('פסקת פתיחה במסמך ההזמנה', 'business.orderIntro', s, { type: 'textarea', cls: 'span2', hint: 'מודפסת בראש מסמך ההזמנה שנשלח ללקוח אחרי בחירת המנות' })}
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
                ${field('מנות ראשונות לבחירה', `packages.${i}.starterCount`, s, { type: 'number', min: 0 })}
                ${field('כלול במסלול', `packages.${i}.includes`, s, { cls: 'span2' })}
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
        `<p class="hint">לכל כרטיס אפשר לקבוע מה יודפס בכל מסלול: הטקסט הרגיל, טקסט אחר (למשל בלי ראשונות וסלטים במסלול פיצות בלבד), או לא להציג אותו בכלל.</p>
        <div class="rows">${s.features
          .map(
            (f, i) => `<div class="row-item">
            ${field('כותרת', `features.${i}.title`, s)}
            ${field('טקסט', `features.${i}.text`, s, { cls: 'grow' })}
            <button type="button" class="icon danger" data-del-feature="${i}" title="הסרה">✕</button>
            ${s.packages
              .map(
                (p) => `<div class="feat-pkg">
                  ${field(`במסלול ${p.name}`, `features.${i}.byPkg.${p.id}.mode`, s, {
                    options: [['same', 'הטקסט הרגיל'], ['custom', 'טקסט אחר'], ['hide', 'לא להציג']],
                  })}
                  ${field(`טקסט אחר למסלול ${p.name}`, `features.${i}.byPkg.${p.id}.text`, s, {
                    cls: 'grow',
                    placeholder: 'מודפס רק כשנבחר "טקסט אחר"',
                  })}
                </div>`
              )
              .join('')}
          </div>`
          )
          .join('')}
          <button type="button" class="btn small ghost" data-act="add-feature">+ כרטיס</button>
        </div>`
      ),
      sec(
        'תנאי תשלום וביטול (ברירת מחדל להצעות חדשות)',
        `<label class="field"><span>שורה לכל סעיף. משתנים: {מקדמה} {יתרה} {סכום} {דמי_ביטול_חלקיים} {מספר_פיצות}</span>
          <textarea data-bind-lines="terms" rows="8">${esc(s.terms.join('\n'))}</textarea></label>
          ${field('הערת בחירת תפריט', 'menuNote', s, { cls: 'span2', hint: 'מודפסת כשלא נבחרו פיצות. {מספר_פיצות} מוחלף במספר שנקבע בהצעה' })}
          ${field('הערת מנות ראשונות', 'starterNote', s, { cls: 'span2', hint: 'מודפסת כשבמסלול יש מנות ראשונות לבחירה. {מספר_ראשונות} מוחלף במספר' })}`
      ),
      sec(
        'תפריט',
        `<p class="hint">שורה לכל מנה, בפורמט: שם | תיאור | סימון (רשות).<br>
          סימון: <b>קבוע</b> – כלולה תמיד, מסומנת מראש בטופס ללקוח ואי אפשר לבטל (לא נספרת בכמות לבחירה) · <b>מוסתר</b> – לא מוצגת בטופס ללקוח · כל טקסט אחר – הערה בולטת ליד המנה, למשל: מלבי | מלבי שמנת | בתוספת 10 ₪ לאדם</p>
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
        '💬 הודעת וואטסאפ',
        `${field('נוסח ההודעה ללקוח', 'whatsapp.message', s, { type: 'textarea', rows: 6, hint: 'משתנים: {שם_לקוח} {סוג_אירוע} {תאריך_אירוע} {מספר_הצעה} {סכום} {קישור}' })}
        ${field('נוסח ההודעה עם טופס בחירת המנות', 'whatsapp.formMessage', s, { type: 'textarea', rows: 6, hint: 'משתנים: {שם_לקוח} {סוג_אירוע} {תאריך_אירוע} {מספר_הצעה} {קישור}' })}
        ${field('נוסח ההודעה לשליחת הזמנה', 'whatsapp.orderMessage', s, { type: 'textarea', rows: 6, hint: 'משתנים: {שם_לקוח} {סוג_אירוע} {תאריך_אירוע} {מספר_הזמנה} {סכום} {קישור}' })}`
      ),
      sec(
        '🔔 התראה בוואטסאפ כשלקוח ממלא טופס מנות',
        `<p class="hint">כשלקוח שולח את טופס בחירת המנות, נשלחת אליך הודעת וואטסאפ דרך השירות החינמי CallMeBot. הגדרה חד-פעמית:</p>
        <ol class="hint steps-list">
          <li>פותחים בטלפון את <a href="https://www.callmebot.com/blog/free-api-whatsapp-messages/" target="_blank" rel="noopener">דף ההוראות של CallMeBot</a>, ושולחים בוואטסאפ את ההודעה שמופיעה שם למספר שלהם.</li>
          <li>מקבלים מהם בוואטסאפ מפתח (apikey) – מעתיקים אותו לכאן, יחד עם מספר הטלפון שלך, ושומרים.</li>
          <li>לוחצים "שליחת הודעת בדיקה" ומוודאים שהגיעה הודעה.</li>
        </ol>
        <div class="grid">
          ${field('הטלפון שלך לקבלת התראות', 'notify.phone', s, { type: 'tel', dir: 'ltr', placeholder: '050-1234567' })}
          ${field('מפתח CallMeBot (apikey)', 'notify.apikey', s, { dir: 'ltr', placeholder: '123456' })}
        </div>
        <button type="button" class="btn small ghost" data-act="notify-test">📨 שליחת הודעת בדיקה</button>`
      ),
      sec(
        'ברירות מחדל להצעה חדשה',
        `<div class="grid">
          ${field('סוג אירוע ברירת מחדל', 'quoteDefaults.eventType', s, { options: s.eventTypes })}
          ${field('מסלול ברירת מחדל', 'quoteDefaults.packageId', s, { options: s.packages.map((p) => [p.id, p.name]) })}
          ${field('מספר סוגי פיצות לבחירה', 'quoteDefaults.pizzaCount', s, { type: 'number', min: 1 })}
          ${field('שעת תחילת הגשה (רשות)', 'quoteDefaults.startTime', s, { type: 'time' })}
          ${field('הצגת פירוט המחיר בהצעה ללקוח', 'quoteDefaults.showBreakdown', s, { type: 'checkbox' })}
          ${field('בדיקת טלפון נייד (10 ספרות, מתחיל ב-05)', 'quoteDefaults.validatePhone', s, { type: 'checkbox' })}
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
    else if (b.dataset.act === 'notify-test') return sendNotifyTest(s.notify);
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
      if (!confirm(`לשחזר ${data.quotes?.length || 0} הצעות${data.orders?.length ? `, ${data.orders.length} הזמנות` : ''} והגדרות מהגיבוי? הצעות קיימות עם אותו מזהה יוחלפו.`)) return;
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
      <label class="field"><span>סיסמה</span>
        <span class="pass-wrap"><input type="password" id="l-pass" required dir="ltr" autocomplete="current-password">
        <button type="button" class="icon" id="l-show" title="הצגת הסיסמה" aria-label="הצגת הסיסמה">👁</button></span></label>
      <button class="btn primary" type="submit">כניסה</button>
      <button class="btn ghost small" type="button" id="l-reset">שכחתי סיסמה</button>
      <p class="hint login-help" id="l-help" hidden></p>
    </form>`;
  const help = (html) => {
    $('#l-help').innerHTML = html;
    $('#l-help').hidden = false;
  };
  $('#l-show').addEventListener('click', () => {
    const el = $('#l-pass');
    el.type = el.type === 'password' ? 'text' : 'password';
  });
  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    busy(true, 'מתחבר...');
    try {
      await state.store.signIn($('#l-email').value.trim().toLowerCase(), $('#l-pass').value);
    } catch (err) {
      if (err.code === 'down') return renderServerDown(err);
      const msg = {
        credentials: 'אימייל או סיסמה שגויים',
        unconfirmed: 'המשתמש לא אושר – ב-Supabase: Authentication → Users → לסמן את המשתמש כמאושר',
      }[err.code];
      toast(msg || 'הכניסה נכשלה: ' + err.message, 'error');
      if (err.code === 'credentials')
        help('אם הסיסמה מולאה אוטומטית, ייתכן שהדפדפן שמר סיסמה ישנה – לחצו 👁 כדי לבדוק. אפשר גם לקבוע סיסמה חדשה ישירות ב-Supabase (ראו README).');
    } finally {
      busy(false);
    }
  });
  $('#l-reset').addEventListener('click', async () => {
    const email = $('#l-email').value.trim();
    if (!email) return toast('הזינו אימייל ואז לחצו שוב', 'error');
    busy(true, 'שולח...');
    try {
      await state.store.resetPassword(email.toLowerCase());
      help(`אם קיים משתמש עם הכתובת <b dir="ltr">${esc(email)}</b>, יישלח אליו מייל מ-Supabase Auth בדקות הקרובות. בדקו גם בתיקיית הספאם. בקישור שבמייל בוחרים סיסמה חדשה.`);
    } catch (err) {
      if (err.code === 'rate') help('נשלחו יותר מדי מיילים בזמן קצר (מגבלה של השרת החינמי). נסו שוב בעוד שעה, או קבעו סיסמה חדשה ישירות ב-Supabase.');
      else toast(err.message, 'error');
    } finally {
      busy(false);
    }
  });
}

// מסך בחירת סיסמה חדשה (אחרי לחיצה על הקישור במייל)
function renderSetPassword() {
  busy(false);
  document.body.classList.add('logged-out');
  $('#main').innerHTML = `
    <form class="card login" id="newpass">
      <img src="assets/logo.png" alt="" class="login-logo">
      <h1>בחירת סיסמה חדשה</h1>
      <label class="field"><span>סיסמה חדשה (לפחות 6 תווים)</span><input type="password" id="np1" required minlength="6" dir="ltr" autocomplete="new-password"></label>
      <label class="field"><span>שוב, לאימות</span><input type="password" id="np2" required minlength="6" dir="ltr" autocomplete="new-password"></label>
      <button class="btn primary" type="submit">שמירת הסיסמה</button>
    </form>`;
  $('#newpass').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('#np1').value !== $('#np2').value) return toast('הסיסמאות לא זהות', 'error');
    busy(true, 'שומר...');
    try {
      await state.store.setNewPassword($('#np1').value);
      toast('הסיסמה עודכנה');
      document.body.classList.remove('logged-out');
      go('#/');
      route();
    } catch (err) {
      toast('עדכון הסיסמה נכשל: ' + err.message, 'error');
    } finally {
      busy(false);
    }
  });
}

// ---------- אתחול ----------
// מסך כשהשרת לא זמין – במקום להיתקע או להציג "סיסמה שגויה"
function renderServerDown(err) {
  busy(false);
  document.body.classList.add('logged-out');
  const keyProblem = err?.code === 'key';
  $('#main').innerHTML = `
    <div class="card login down">
      <img src="assets/logo.png" alt="" class="login-logo">
      <h1>${keyProblem ? 'בעיה בהגדרות החיבור' : 'מסד הנתונים לא זמין כרגע'}</h1>
      ${
        keyProblem
          ? '<p>מפתח ה-Supabase בקובץ ההגדרות לא תקין. הנתונים שלך לא נפגעו.</p>'
          : `<p>הנתונים שלך שמורים ולא נמחקו. הסיבה הנפוצה: פרויקט Supabase חינמי <b>מושהה אוטומטית</b> אחרי שבוע ללא שימוש.</p>
             <ol>
               <li>נכנסים ל-<a href="https://supabase.com/dashboard" target="_blank" rel="noopener">supabase.com/dashboard</a></li>
               <li>פותחים את הפרויקט ולוחצים <b>Restore project</b></li>
               <li>מחכים 1–2 דקות ולוחצים "נסו שוב"</li>
             </ol>`
      }
      <button class="btn primary" type="button" onclick="location.reload()">נסו שוב</button>
      <small class="hint">פרטים טכניים: ${esc(err?.message || '')}</small>
    </div>`;
}

async function start() {
  $('#app-version').textContent = `גרסה ${window.APP_VERSION || 'dev'}`;
  busy(true, 'טוען...');
  try {
    state.store = await createStore();
  } catch (err) {
    busy(false);
    renderServerDown(err);
    return;
  }
  if (!isCloud) $('#mode-banner').hidden = false;
  $('#logout').hidden = !isCloud;
  $('#logout').addEventListener('click', () => state.store.signOut());
  state.store.onRecovery = renderSetPassword;
  // קישור איפוס שפג תוקפו מחזיר שגיאה בכתובת
  const hashParams = new URLSearchParams(location.hash.replace(/^#\/?/, ''));
  if (hashParams.get('error_description')) {
    toast('קישור האיפוס לא תקף: ' + hashParams.get('error_description').replace(/\+/g, ' ') + ' – בקשו קישור חדש', 'error');
    history.replaceState(null, '', location.pathname + '#/');
  }

  state.store.onAuth(async (user) => {
    busy(false);
    if (!user) return renderLogin();
    document.body.classList.remove('logged-out');
    // דף הנחיתה נמצא באותו אתר (yakirdavid.github.io) ולכן חולק את האחסון:
    // דפדפן שמחובר למערכת הוא של בעלי העסק, וכניסות ממנו לדף הנחיתה לא נספרות במדדים
    try {
      localStorage.setItem('pb_notrack', '1');
    } catch {}
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
