// שכבת נתונים: Supabase או Firebase (ענן, חינמי), או מצב מקומי (localStorage) כשאין הגדרות.
import { supabaseConfig, firebaseConfig } from './config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';

const useSupabase = Boolean(supabaseConfig.url && supabaseConfig.anonKey);
const useFirebase = !useSupabase && Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
export const isCloud = useSupabase || useFirebase;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------- מצב מקומי ----------
class LocalStore {
  mode = 'local';
  user = { email: 'מצב מקומי' };

  _get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  }
  _set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      throw new Error('האחסון בדפדפן מלא – מומלץ לחבר את Supabase. ' + e.message);
    }
  }

  onAuth(cb) {
    cb(this.user);
  }
  async signIn() {}
  async signOut() {}
  async resetPassword() {}

  async getSettings() {
    return this._get('pb_settings', null);
  }
  async saveSettings(s) {
    this._set('pb_settings', s);
  }
  async listQuotes() {
    return Object.values(this._get('pb_quotes', {}));
  }
  async getQuote(id) {
    return this._get('pb_quotes', {})[id] || null;
  }
  async saveQuote(q) {
    const all = this._get('pb_quotes', {});
    if (!q.id) q.id = uid();
    all[q.id] = q;
    this._set('pb_quotes', all);
    return q;
  }
  async deleteQuote(id) {
    const all = this._get('pb_quotes', {});
    delete all[id];
    this._set('pb_quotes', all);
  }
  async nextNumber(start) {
    const cur = this._get('pb_counter', null);
    const next = Math.max(Number(cur ?? start - 1) + 1, start);
    this._set('pb_counter', next);
    return next;
  }
  // אין אחסון קבצים במצב מקומי – אין קישור לשליחה
  async uploadPdf() {
    return null;
  }
  async saveImage(dataUrl) {
    const imgs = this._get('pb_images', {});
    const id = uid();
    imgs[id] = dataUrl;
    this._set('pb_images', imgs);
    return 'img:' + id;
  }
  async _loadImage(id) {
    return this._get('pb_images', {})[id] || null;
  }
  async exportAll() {
    return {
      settings: await this.getSettings(),
      quotes: await this.listQuotes(),
      images: this._get('pb_images', {}),
      counter: this._get('pb_counter', null),
    };
  }
  async importAll(data) {
    if (data.settings) this._set('pb_settings', data.settings);
    const all = this._get('pb_quotes', {});
    for (const q of data.quotes || []) all[q.id] = q;
    this._set('pb_quotes', all);
    this._set('pb_images', { ...this._get('pb_images', {}), ...(data.images || {}) });
    if (data.counter != null) this._set('pb_counter', Math.max(Number(data.counter), Number(this._get('pb_counter', 0))));
  }
}

// ---------- מצב ענן (Firebase Auth + Firestore) ----------
class CloudStore {
  mode = 'cloud';
  user = null;

  async init() {
    const [{ initializeApp }, auth, fs] = await Promise.all([
      import(FB + 'firebase-app.js'),
      import(FB + 'firebase-auth.js'),
      import(FB + 'firebase-firestore.js'),
    ]);
    this.A = auth;
    this.F = fs;
    const app = initializeApp(firebaseConfig);
    this.auth = auth.getAuth(app);
    try {
      this.db = fs.initializeFirestore(app, {
        localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
      });
    } catch {
      this.db = fs.getFirestore(app);
    }
    return this;
  }

  _doc(...path) {
    return this.F.doc(this.db, 'users', this.user.uid, ...path);
  }
  _col(name) {
    return this.F.collection(this.db, 'users', this.user.uid, name);
  }

  onAuth(cb) {
    this.A.onAuthStateChanged(this.auth, (u) => {
      this.user = u;
      cb(u);
    });
  }
  async signIn(email, password) {
    await this.A.setPersistence(this.auth, this.A.browserLocalPersistence);
    await this.A.signInWithEmailAndPassword(this.auth, email, password);
  }
  async signOut() {
    await this.A.signOut(this.auth);
  }
  async resetPassword(email) {
    await this.A.sendPasswordResetEmail(this.auth, email);
  }

  async getSettings() {
    const s = await this.F.getDoc(this._doc('meta', 'settings'));
    return s.exists() ? s.data().value : null;
  }
  async saveSettings(value) {
    await this.F.setDoc(this._doc('meta', 'settings'), { value });
  }
  async listQuotes() {
    const snap = await this.F.getDocs(this._col('quotes'));
    return snap.docs.map((d) => d.data());
  }
  async getQuote(id) {
    const s = await this.F.getDoc(this._doc('quotes', id));
    return s.exists() ? s.data() : null;
  }
  async saveQuote(q) {
    if (!q.id) q.id = uid();
    await this.F.setDoc(this._doc('quotes', q.id), JSON.parse(JSON.stringify(q)));
    return q;
  }
  async deleteQuote(id) {
    await this.F.deleteDoc(this._doc('quotes', id));
  }
  async nextNumber(start) {
    const ref = this._doc('meta', 'counter');
    return this.F.runTransaction(this.db, async (tx) => {
      const s = await tx.get(ref);
      const cur = s.exists() ? Number(s.data().value) : start - 1;
      const next = Math.max(cur + 1, start);
      tx.set(ref, { value: next });
      return next;
    });
  }
  async uploadPdf() {
    return null; // Firebase Storage דורש תוכנית בתשלום
  }
  async saveImage(dataUrl) {
    const id = uid();
    await this.F.setDoc(this._doc('images', id), { data: dataUrl });
    return 'img:' + id;
  }
  async _loadImage(id) {
    const s = await this.F.getDoc(this._doc('images', id));
    return s.exists() ? s.data().data : null;
  }
  async exportAll() {
    const imgs = await this.F.getDocs(this._col('images'));
    const counter = await this.F.getDoc(this._doc('meta', 'counter'));
    return {
      settings: await this.getSettings(),
      quotes: await this.listQuotes(),
      images: Object.fromEntries(imgs.docs.map((d) => [d.id, d.data().data])),
      counter: counter.exists() ? counter.data().value : null,
    };
  }
  async importAll(data) {
    if (data.settings) await this.saveSettings(data.settings);
    for (const q of data.quotes || []) await this.saveQuote(q);
    for (const [id, d] of Object.entries(data.images || {})) await this.F.setDoc(this._doc('images', id), { data: d });
    if (data.counter != null) {
      const ref = this._doc('meta', 'counter');
      const s = await this.F.getDoc(ref);
      const cur = s.exists() ? Number(s.data().value) : 0;
      await this.F.setDoc(ref, { value: Math.max(cur, Number(data.counter)) });
    }
  }
}

function storeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ---------- מצב ענן (Supabase Auth + Postgres) ----------
// כל הנתונים בטבלה אחת pb_docs (ראו supabase.sql), מוגנת ב-RLS לפי המשתמש המחובר.
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('טעינת ' + src + ' נכשלה'));
    document.head.append(s);
  });
}

class SupabaseStore {
  mode = 'cloud';
  user = null;

  async init() {
    await this._health();
    if (!window.supabase) await loadScript('vendor/supabase.js');
    this.sb = window.supabase.createClient(supabaseConfig.url, supabaseConfig.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    return this;
  }

  // בדיקה מהירה שהשרת זמין – פרויקט חינמי מושהה אחרי שבוע ללא שימוש ואז הבקשות נתקעות
  async _health() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let res;
    try {
      res = await fetch(supabaseConfig.url + '/auth/v1/health', {
        headers: { apikey: supabaseConfig.anonKey },
        signal: ctrl.signal,
        cache: 'no-store',
      });
    } catch {
      throw storeError('down', 'שרת מסד הנתונים לא מגיב');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) throw storeError('key', 'מפתח החיבור ל-Supabase לא תקין');
    if (!res.ok) throw storeError('down', `שרת מסד הנתונים לא זמין (${res.status})`);
  }

  _check({ data, error }) {
    if (error) throw new Error(error.message);
    return data;
  }
  _table() {
    return this.sb.from('pb_docs');
  }
  async _get(kind, id) {
    const rows = this._check(await this._table().select('data').eq('kind', kind).eq('id', id).limit(1));
    return rows[0]?.data ?? null;
  }
  async _put(kind, id, data) {
    this._check(
      await this._table().upsert(
        { user_id: this.user.id, kind, id, data, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,kind,id' }
      )
    );
  }
  async _all(kind) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const rows = this._check(await this._table().select('id,data').eq('kind', kind).range(from, from + 999));
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  }

  onAuth(cb) {
    let current;
    const emit = (u) => {
      this.user = u;
      if ((u?.id ?? null) === current) return; // רענון טוקן לא מרנדר מחדש
      current = u?.id ?? null;
      cb(u);
    };
    this.sb.auth.onAuthStateChange((event, session) => {
      emit(session?.user ?? null);
      // הגעה מקישור "איפוס סיסמה" במייל – האפליקציה מציגה מסך לבחירת סיסמה חדשה
      if (event === 'PASSWORD_RECOVERY') setTimeout(() => this.onRecovery?.(), 300);
    });
  }
  async setNewPassword(password) {
    this._check(await this.sb.auth.updateUser({ password }));
  }
  async signIn(email, password) {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(storeError('down', 'השרת לא הגיב בזמן')), 15000));
    const { error } = await Promise.race([this.sb.auth.signInWithPassword({ email, password }), timeout]);
    if (!error) return;
    if (/invalid login credentials/i.test(error.message)) throw storeError('credentials', error.message);
    if (/email not confirmed/i.test(error.message)) throw storeError('unconfirmed', error.message);
    if (error.status === 0 || error.status >= 500 || /fetch|network/i.test(error.message)) throw storeError('down', error.message);
    throw new Error(error.message);
  }
  async signOut() {
    await this.sb.auth.signOut();
  }
  async resetPassword(email) {
    const { error } = await this.sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if (!error) return;
    if (error.status === 429 || /rate limit/i.test(error.message)) throw storeError('rate', error.message);
    throw new Error(error.message);
  }

  async getSettings() {
    return this._get('settings', 'main');
  }
  async saveSettings(s) {
    await this._put('settings', 'main', s);
  }
  async listQuotes() {
    return (await this._all('quote')).map((r) => r.data);
  }
  async getQuote(id) {
    return this._get('quote', id);
  }
  async saveQuote(q) {
    if (!q.id) q.id = uid();
    await this._put('quote', q.id, JSON.parse(JSON.stringify(q)));
    return q;
  }
  async deleteQuote(id) {
    this._check(await this._table().delete().eq('kind', 'quote').eq('id', id));
  }
  async nextNumber(start) {
    return this._check(await this.sb.rpc('pb_next_number', { start_at: start }));
  }
  // אירועי ביקור מדף הנחיתה (ראו supabase-landing.sql). since: ISO או null לכל התקופה
  async listLandingEvents(since) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      let q = this.sb.from('pb_lp_events').select('created_at,visitor,session,type,name,value,data').order('id').range(from, from + 999);
      if (since) q = q.gte('created_at', since);
      const { data, error } = await q;
      if (error) {
        if (/pb_lp_events|PGRST205|42P01/.test(`${error.code} ${error.message}`)) throw storeError('no-table', error.message);
        throw new Error(error.message);
      }
      out.push(...data);
      if (data.length < 1000) return out;
    }
  }
  async clearLandingEvents() {
    this._check(await this.sb.from('pb_lp_events').delete().gte('id', 0));
  }
  // מעלה את ה-PDF לאחסון (bucket ציבורי quotes, שם קובץ אקראי) ומחזיר קישור לשליחה ללקוח
  async uploadPdf(blob, number) {
    const path = `${this.user.id}/${number}-${uid()}${uid()}.pdf`;
    const bucket = this.sb.storage.from('quotes');
    const { error } = await bucket.upload(path, blob, { contentType: 'application/pdf', cacheControl: '31536000' });
    if (error) {
      if (/bucket not found|row-level security|not found|unauthorized/i.test(error.message)) throw storeError('nobucket', error.message);
      throw new Error(error.message);
    }
    return bucket.getPublicUrl(path).data.publicUrl;
  }
  async saveImage(dataUrl) {
    const id = uid();
    await this._put('image', id, dataUrl);
    return 'img:' + id;
  }
  async _loadImage(id) {
    return this._get('image', id);
  }
  async exportAll() {
    return {
      settings: await this.getSettings(),
      quotes: await this.listQuotes(),
      images: Object.fromEntries((await this._all('image')).map((r) => [r.id, r.data])),
      counter: await this._get('counter', 'quote'),
    };
  }
  async importAll(data) {
    if (data.settings) await this.saveSettings(data.settings);
    for (const q of data.quotes || []) await this.saveQuote(q);
    for (const [id, d] of Object.entries(data.images || {})) await this._put('image', id, d);
    if (data.counter != null) {
      const cur = Number((await this._get('counter', 'quote')) ?? 0);
      await this._put('counter', 'quote', Math.max(cur, Number(data.counter)));
    }
  }
}

const imageCache = new Map();

export async function createStore() {
  const store = useSupabase
    ? await new SupabaseStore().init()
    : useFirebase
      ? await new CloudStore().init()
      : new LocalStore();
  // הפניה לתמונה: נתיב קובץ / data URL / 'img:<id>' (תמונה שהועלתה)
  store.resolveImage = async (ref) => {
    if (!ref || !String(ref).startsWith('img:')) return ref || '';
    const id = ref.slice(4);
    if (!imageCache.has(id)) imageCache.set(id, await store._loadImage(id));
    return imageCache.get(id) || '';
  };
  return store;
}
