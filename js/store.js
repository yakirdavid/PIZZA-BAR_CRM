// שכבת נתונים: Firebase (ענן, חינמי) או מצב מקומי (localStorage) כשאין הגדרות Firebase.
import { firebaseConfig } from './config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';

export const isCloud = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

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
      throw new Error('האחסון בדפדפן מלא – מומלץ לעבור למצב ענן (Firebase). ' + e.message);
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

const imageCache = new Map();

export async function createStore() {
  const store = isCloud ? await new CloudStore().init() : new LocalStore();
  // הפניה לתמונה: נתיב קובץ / data URL / 'img:<id>' (תמונה שהועלתה)
  store.resolveImage = async (ref) => {
    if (!ref || !String(ref).startsWith('img:')) return ref || '';
    const id = ref.slice(4);
    if (!imageCache.has(id)) imageCache.set(id, await store._loadImage(id));
    return imageCache.get(id) || '';
  };
  return store;
}
