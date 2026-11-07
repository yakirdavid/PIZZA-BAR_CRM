// בניית מסמך הצעת המחיר להדפסה / PDF – תבנית קבועה לפי ההצעה המאושרת.
// אותו מסמך משמש לתצוגה מקדימה, להדפסה ולהורדת PDF, ולכן החישוב זהה בכולם.
import { calcQuote, formatILS, formatGuests, formatDuration, fillTerms } from './pricing.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const PAGE_H = 1123; // A4 ב-96dpi
const PAGE_PAD_TOP = 34;
const PAGE_PAD_BOTTOM = 46;
const TOP_BAR = 14;
const CONTENT_H = PAGE_H - TOP_BAR - PAGE_PAD_TOP - PAGE_PAD_BOTTOM;

export function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return d && m && y ? `${d}.${m}.${y}` : iso;
}

const HEB_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export function dayName(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  return isNaN(d) ? '' : `יום ${HEB_DAYS[d.getDay()]}`;
}

export function addMinutes(time, minutes) {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number);
  const t = (h * 60 + m + Number(minutes || 0)) % (24 * 60);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

export function eventTypeLabel(q) {
  return q.event?.type === 'אחר' ? q.event?.typeOther || 'אירוע' : q.event?.type || 'אירוע';
}

function eventHeading(q) {
  const t = eventTypeLabel(q);
  return /^(אירוע|מסיב)/.test(t) ? `הצעת מחיר ל${t}` : `הצעת מחיר לאירוע ${t}`;
}

export const HEB_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

// תאריך מדויק, או רק חודש ושנה כשהתאריך עוד לא ידוע
export function isMonthOnly(q) {
  return q.event?.dateMode === 'month' && q.event?.year && q.event?.monthNum;
}
export function eventDateKey(q) {
  if (isMonthOnly(q)) return `${q.event.year}-${String(q.event.monthNum).padStart(2, '0')}-15`;
  return q.event?.date || '';
}
export function eventDateShort(q) {
  if (isMonthOnly(q)) return `${HEB_MONTHS[q.event.monthNum - 1]} ${q.event.year}`;
  return formatDate(q.event?.date);
}
function eventDateLong(q) {
  if (isMonthOnly(q)) return `${eventDateShort(q)} (התאריך המדויק ייקבע בהמשך)`;
  const d = q.event?.date;
  return d ? `${formatDate(d)} (${dayName(d)})` : '';
}

// ניסוח ללקוח: "28 מבוגרים + 2 ילדים (חצי מחיר)" – במקום מספר "משתתפים לחיוב" שמשקלל ילדים כחצי
function childPriceText(factor) {
  if (factor === 0.5) return 'חצי מחיר';
  if (factor === 0) return 'ללא חיוב';
  return `${Math.round(factor * 100)}% ממחיר מבוגר`;
}
function countText(n, word) {
  const forms = { מבוגר: ['מבוגר אחד', 'מבוגרים'], ילד: ['ילד אחד', 'ילדים'], פעוט: ['פעוט אחד', 'פעוטות'] }[word];
  return n === 1 ? forms[0] : `${n} ${forms[1]}`;
}
export function guestsText(q) {
  const g = q.guests || {};
  const factor = Number(q.brand?.ageGroups?.childFactor ?? 0.5);
  const adults = Number(g.adults) || 0;
  const kids = Number(g.children) || 0;
  const parts = [];
  if (adults) parts.push(countText(adults, 'מבוגר'));
  if (kids) parts.push(`${countText(kids, 'ילד')} (${childPriceText(factor)})`);
  return parts.join(' + ');
}

// מחזיר רשימת בלוקים לפי סדר – כל בלוק נשאר שלם בעמוד אחד
export function buildBlocks(q, images) {
  const s = q.brand; // עותק ההגדרות שנשמר עם ההצעה
  const c = calcQuote(q);
  const pkg = q.pkg || {};
  const g = q.guests || {};
  const totalMinutes = Number(pkg.hours || 0) * 60 + Number(q.extensionMinutes || 0);
  const adults = Number(g.adults) || 0;
  const kids = Number(g.children) || 0;
  const childFactor = Number(s.ageGroups?.childFactor ?? 0.5);
  const guests = guestsText(q);
  const blocks = [];
  const add = (html, opts = {}) => blocks.push({ html, ...opts });

  add(`
    <header class="q-head">
      <div class="q-head-text">
        <div class="q-kicker">${esc(eventHeading(q))}</div>
        <h1>${esc(s.business.title)}</h1>
        <div class="q-sub">${esc(s.business.subtitle)}</div>
      </div>
      ${images.logo ? `<img class="q-logo" src="${esc(images.logo)}" alt="">` : ''}
      <div class="q-datebox">
        <div>${esc(formatDate(q.quoteDate))}</div>
        <div>הצעת מחיר מס׳ ${esc(q.number ?? '')}</div>
      </div>
    </header>`);

  if (s.business.intro) add(`<p class="q-intro">${esc(s.business.intro)}</p>`);

  if (s.features?.length) {
    add(`
      <h2 class="q-h2">מה כוללת החוויה?</h2>
      <div class="q-features">
        ${s.features.map((f) => `<div class="q-card"><h3>${esc(f.title)}</h3><p>${esc(f.text)}</p></div>`).join('')}
      </div>`);
  }

  add(`
    <div class="q-package">
      <div class="q-package-title">מסלול ${esc(pkg.name)} | ${esc(formatDuration(totalMinutes))} הגשה ללא הגבלה</div>
      <p><b>כלול במסלול:</b> ${esc(pkg.includes)}</p>
      ${pkg.description ? `<p>${esc(pkg.description)}</p>` : ''}
    </div>`);

  const ev = q.event || {};
  const cust = q.customer || {};
  const rows = [
    ['שם הלקוח', cust.name],
    ['טלפון', cust.phone],
    ['אימייל', cust.email],
    ['סוג האירוע', eventTypeLabel(q)],
    [isMonthOnly(q) ? 'מועד האירוע' : 'תאריך האירוע', eventDateLong(q)],
    ['כתובת', ev.address],
    [
      'זמני הגשה',
      ev.startTime
        ? `${ev.startTime}–${addMinutes(ev.startTime, totalMinutes)} (${formatDuration(totalMinutes)})`
        : formatDuration(totalMinutes),
    ],
    [
      'משתתפים',
      [
        g.adults ? `${g.adults} מבוגרים (מגיל ${s.ageGroups.adultFromAge})` : '',
        g.children ? `${g.children} ילדים (${s.ageGroups.childFromAge}–${s.ageGroups.childToAge})` : '',
        g.infants ? `${g.infants} פעוטות (0–${s.ageGroups.infantToAge})` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    ],
  ].filter(([, v]) => v);
  add(`
    <div class="q-details">
      <h2 class="q-h2">פרטי האירוע</h2>
      <div class="q-details-grid">
        ${rows.map(([k, v]) => `<div class="q-detail"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}
      </div>
    </div>`);

  const pizzas = (q.pizzas || []).filter(Boolean);
  const photos = [images.photo1, images.photo2].filter(Boolean);
  add(`
    <div class="q-menu-row ${photos.length ? '' : 'no-photos'}">
      <div class="q-menu-card">
        <h3>בחירת התפריט</h3>
        ${
          pizzas.length
            ? `<p><b>הפיצות שנבחרו:</b></p><ul class="q-pizzas">${pizzas.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
            : `<p><b>${esc(fillTerms(s.menuNote, c))}</b></p>`
        }
        ${
          guests
            ? `<p>המחיר מחושב ל-${esc(guests)}${c.max ? `, עם אפשרות להגדלה עד ${esc(formatGuests(c.max.guests))} משתתפים` : ''}.</p>`
            : ''
        }
        ${
          pkg.minGuests && c.pricingMode === 'auto'
            ? `<p class="q-muted">מחיר המינימום של המסלול כולל עד ${esc(pkg.minGuests)} מבוגרים${kids ? ' (כל ילד נספר כחצי מבוגר)' : ''}.</p>`
            : ''
        }
      </div>
      ${
        photos.length
          ? `<div class="q-photos">${photos.map((p) => `<div class="q-photo"><img src="${esc(p)}" alt=""></div>`).join('')}</div>`
          : ''
      }
    </div>`);

  const line = (label, value, cls = '') =>
    `<div class="q-line ${cls}"><span>${label}</span><b>${value}</b></div>`;
  const lines = [];
  if (c.pricingMode === 'perGuest' && kids) {
    // מחיר ידני למשתתף: שורה למבוגרים ושורה לילדים, כדי שהחישוב יהיה ברור
    const adultsTotal = Math.round(adults * c.perGuestPrice);
    lines.push(line(`מסלול ${esc(pkg.name)} – ${esc(countText(adults, 'מבוגר'))} × ${formatILS(c.perGuestPrice)}`, formatILS(adultsTotal)));
    lines.push(
      line(
        `${esc(countText(kids, 'ילד'))} × ${formatILS(c.perGuestPrice * childFactor)} (${esc(childPriceText(childFactor))})`,
        formatILS(c.packagePrice - adultsTotal)
      )
    );
  } else {
    lines.push(
      line(
        c.pricingMode === 'perGuest'
          ? `מסלול ${esc(pkg.name)} – ${esc(guests)} × ${formatILS(c.perGuestPrice)}`
          : `מסלול ${esc(pkg.name)}${guests ? ` – ${esc(guests)}` : ''}`,
        formatILS(c.packagePrice)
      )
    );
  }
  if (q.extensionMinutes > 0 || c.extPrice)
    lines.push(line(`הארכת זמן הגשה – ${esc(formatDuration(q.extensionMinutes))}`, formatILS(c.extPrice)));
  if (c.pastaPrice)
    lines.push(line(`${esc(q.pasta.name || 'פסטה')} – ${esc(q.pasta.portions)} מנות`, formatILS(c.pastaPrice)));
  for (const a of c.addons)
    lines.push(line(esc(a.unit === 'fixed' ? a.name : `${a.name} × ${a.qty}`), formatILS(a.total)));
  for (const x of c.custom) lines.push(line(esc(x.name || 'סעיף נוסף'), formatILS(x.total)));
  if (c.discount)
    lines.push(
      line(
        `הנחה${q.discount?.type === 'percent' ? ` (${esc(q.discount.value)}%)` : ''}`,
        `− ${formatILS(c.discount)}`,
        'discount'
      )
    );

  add(`
    <section class="q-price">
      <div class="q-price-head">
        <h2>הצעת המחיר</h2>
        <span>${esc(guests)}${c.max ? ` | אפשרות להגדלה עד ${esc(formatGuests(c.max.guests))} משתתפים` : ''}</span>
      </div>
      <div class="q-price-body">
        ${
          c.pricingMode === 'perGuest'
            ? `<div class="q-price-hero">
                <div>
                  <div class="q-price-hero-label">${kids ? 'מחיר למבוגר' : 'מחיר למשתתף'}, למסלול ${esc(pkg.name)}</div>
                  <div class="q-muted">${
                    kids ? `ילד: ${formatILS(c.perGuestPrice * childFactor)} (${esc(childPriceText(childFactor))}) · ` : ''
                  }${esc(formatDuration(totalMinutes))} הגשה ללא הגבלה</div>
                </div>
                <div class="q-price-big">${formatILS(c.perGuestPrice)}</div>
              </div>`
            : `<div class="q-price-hero">
                <div>
                  <div class="q-price-hero-label">סה״כ להצעה</div>
                  <div class="q-muted">${
                    c.billable
                      ? `ממוצע ${formatILS(c.perGuest)} למבוגר${kids ? ` · ${formatILS(c.perGuest * childFactor)} לילד` : ''}`
                      : ''
                  }</div>
                </div>
                <div class="q-price-big">${formatILS(c.total)}</div>
              </div>`
        }
        ${q.display?.showBreakdown === false ? '' : `<div class="q-lines">${lines.join('')}</div>`}
        ${line('סה״כ', formatILS(c.total), 'total')}
        ${
          c.max
            ? line(`סה״כ ל־${esc(formatGuests(c.max.guests))} משתתפים (במקרה של הגדלה)`, formatILS(c.max.total), 'max')
            : ''
        }
        <div class="q-pay">
          ${line('מקדמה לשריון התאריך', formatILS(c.deposit))}
          ${line('יתרה לתשלום', formatILS(c.balance))}
        </div>
        ${s.business.priceNote ? `<div class="q-muted q-note">${esc(s.business.priceNote)}</div>` : ''}
      </div>
    </section>`);

  if (q.publicNotes?.trim()) {
    add(`<div class="q-public-notes"><h2 class="q-h2">הערות</h2><p>${esc(q.publicNotes).replace(/\n/g, '<br>')}</p></div>`);
  }

  const terms = (q.terms || []).filter((t) => String(t).trim());
  if (terms.length) {
    add(`<h2 class="q-h2 q-terms-title">פרטים ותנאים</h2>`, { keepWithNext: true });
    for (const t of terms) add(`<div class="q-term">• ${esc(fillTerms(t, c))}</div>`, { tight: true });
  }

  add(`
    <footer class="q-foot">
      <div>
        <div>${esc(s.business.closing)}</div>
        ${s.business.contact ? `<div class="q-muted">${esc(s.business.contact)}</div>` : ''}
      </div>
      <div class="q-bless">${esc(s.business.blessing)}</div>
    </footer>`);

  return blocks;
}

function pageShell(inner, idx, total) {
  return `<div class="q-page"><div class="q-topbar"></div><div class="q-content">${inner}</div>${
    total > 1 ? `<div class="q-pagenum">עמוד ${idx + 1} מתוך ${total}</div>` : ''
  }</div>`;
}

async function waitForImages(root) {
  await Promise.all(
    [...root.querySelectorAll('img')].map((img) =>
      img.complete ? null : new Promise((r) => ((img.onload = r), (img.onerror = r)))
    )
  );
  if (document.fonts?.ready) await document.fonts.ready;
}

// מחלק את הבלוקים לעמודי A4 בלי לחתוך בלוק באמצע
export async function renderPages(stage, q, images) {
  const blocks = buildBlocks(q, images);
  stage.innerHTML = `<div class="q-page measure"><div class="q-content">${blocks
    .map((b) => `<div class="q-blk ${b.tight ? 'tight' : ''}">${b.html}</div>`)
    .join('')}</div></div>`;
  await waitForImages(stage);
  const heights = [...stage.querySelectorAll('.q-blk')].map((el) => el.getBoundingClientRect().height);

  const pages = [[]];
  let used = 0;
  blocks.forEach((b, i) => {
    let need = heights[i];
    if (b.keepWithNext && i + 1 < blocks.length) need += heights[i + 1];
    if (used + need > CONTENT_H && pages.at(-1).length) {
      pages.push([]);
      used = 0;
    }
    pages.at(-1).push(i);
    used += heights[i];
  });

  stage.innerHTML = pages
    .map((idxs, p) =>
      pageShell(
        idxs.map((i) => `<div class="q-blk ${blocks[i].tight ? 'tight' : ''}">${blocks[i].html}</div>`).join(''),
        p,
        pages.length
      )
    )
    .join('');
  await waitForImages(stage);
  return stage.querySelectorAll('.q-page').length;
}

// ---------- הפקת PDF ----------
// הדפדפן מצייר כל עמוד לתמונה. כדי שה-PDF ייראה בדיוק כמו התצוגה בכל דפדפן (כולל אייפון):
// התמונות והגופן מוטמעים מראש, וכל עמוד נבדק שהתמונות בו לא יצאו ריקות – ואם כן, מצויר שוב.
const blobToDataUrl = (blob) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });

let fontCssPromise;
function fontEmbedCss() {
  fontCssPromise ??= (async () => {
    const faces = [
      ['assets/fonts/heebo-hebrew.woff2', 'U+0307-0308, U+0590-05FF, U+200C-2010, U+20AA, U+25CC, U+FB1D-FB4F'],
      ['assets/fonts/heebo-latin.woff2', 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'],
    ];
    const css = await Promise.all(
      faces.map(async ([url, range]) => {
        const data = await blobToDataUrl(await (await fetch(url)).blob());
        return `@font-face{font-family:'Heebo';font-style:normal;font-weight:400 800;src:url(${data}) format('woff2');unicode-range:${range};}`;
      })
    );
    return css.join('\n');
  })();
  return fontCssPromise;
}

async function inlineImages(root) {
  await Promise.all(
    [...root.querySelectorAll('img')].map(async (img) => {
      if (!img.src.startsWith('data:')) img.src = await blobToDataUrl(await (await fetch(img.src)).blob());
      try {
        await img.decode();
      } catch {}
    })
  );
}

// אזור תמונה "ריק" = כמעט בלי שונות בצבע (תמונה אמיתית תמיד מגוונת)
function imagesRendered(canvas, page, ratio) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const base = page.getBoundingClientRect();
  return [...page.querySelectorAll('img')].every((img) => {
    const r = img.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return true;
    const x = Math.round((r.left - base.left + r.width * 0.2) * ratio);
    const y = Math.round((r.top - base.top + r.height * 0.2) * ratio);
    const w = Math.max(1, Math.round(r.width * 0.6 * ratio));
    const h = Math.max(1, Math.round(r.height * 0.6 * ratio));
    const d = ctx.getImageData(x, y, w, h).data;
    let min = 255, max = 0;
    for (let i = 0; i < d.length; i += 16) {
      const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return max - min > 24;
  });
}

// עמוד שיצא ריק לגמרי (בלי טקסט) – גם הוא מצויר שוב
function hasContent(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let dark = 0;
  for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] < 300) dark++;
  return dark > 50;
}

async function renderPageCanvas(page) {
  const ratio = 2;
  const opts = {
    pixelRatio: ratio,
    width: 794,
    height: 1123,
    backgroundColor: '#ffffff',
    cacheBust: false,
    fontEmbedCSS: await fontEmbedCss(),
  };
  let canvas;
  for (let attempt = 0; attempt < 4; attempt++) {
    canvas = await window.htmlToImage.toCanvas(page, opts);
    if (hasContent(canvas) && imagesRendered(canvas, page, ratio)) break;
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  return canvas;
}

// מצייר את כל עמודי המסמך לתמונות – אותן תמונות משמשות לתצוגה המקדימה ול-PDF
export async function renderStageCanvases(stage) {
  await inlineImages(stage);
  if (document.fonts?.ready) await document.fonts.ready;
  const canvases = [];
  for (const page of stage.querySelectorAll('.q-page')) canvases.push(await renderPageCanvas(page));
  return canvases;
}

// מחזיר את ה-PDF כקובץ (Blob)
export async function pagesToPdfBlob(stage, title) {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4', compress: true });
  const canvases = await renderStageCanvases(stage);
  for (let i = 0; i < canvases.length; i++) {
    const canvas = canvases[i];
    if (i) pdf.addPage();
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, 210, 297, undefined, 'FAST');
  }
  pdf.setProperties({ title });
  return pdf.output('blob');
}

export function saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
