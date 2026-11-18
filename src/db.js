// Слой хранения: все коллекции держатся в памяти и сохраняются в IndexedDB
// (с резервом на localStorage). Любая мутация уведомляет подписчиков.
//
// API:
//   await db.ready
//   db.all(col)                 -> массив (копия ссылки, не мутировать)
//   db.get(col, id)             -> запись или undefined
//   db.where(col, predicate)    -> отфильтрованный массив
//   db.add(col, obj)            -> запись с id и createdAt
//   db.update(col, id, patch)   -> обновлённая запись (patch может быть функцией)
//   db.upsert(col, obj)         -> по obj.id
//   db.remove(col, id)
//   db.settings()               -> объект настроек; db.setSettings(patch)
//   db.subscribe(fn)            -> отписка; fn(colName)
//   db.exportJSON() / db.importJSON(obj, {merge})
//   db.clearAll()

export const COLLECTIONS = [
  'learningAreas', 'learningItems', 'studySessions', 'flashcards',
  'goals', 'tasks', 'projects', 'streams', 'visionItems',
  'shadowTasks', 'shadowNotes',
  'people', 'commitments', 'contacts',
  'kbSections', 'kbPages',
  'checkins', 'labTests', 'healthTodos', 'medications', 'medLogs',
  'workouts', 'workoutTemplates',
  'foods', 'meals', 'dayLogs',
  'habits', 'habitLogs',
  'sleepLogs',
  'books', 'notes',
  'transactions', 'budgets', 'financeGoals',
  'journal', 'weeklyReviews',
];

export const DEFAULT_SETTINGS = {
  name: '',
  theme: 'dark',           // auto | light | dark — по умолчанию Deep Space
  themeV: 2,
  visionStatement: '',     // текст «картины будущего» на вкладке Визуализация               // версия темы: при смене оформления один раз переключаем на тёмную
  kcalTarget: 2000,
  proteinTarget: 120,
  fatTarget: 70,
  carbsTarget: 220,
  waterTarget: 2000,       // мл
  sleepTarget: 8,          // часов
  stepsTarget: 8000,
  currency: '₽',
  weekStartsMonday: true,
  learningWeeklyMinutes: 300,
};

const DB_NAME = 'lifeos';
const STORE = 'kv';

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function openIDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return resolve(null);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function idbGetAll(idb) {
  return new Promise((resolve) => {
    const out = {};
    const tx = idb.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { out[cur.key] = cur.value; cur.continue(); } else resolve(out);
    };
    req.onerror = () => resolve(out);
  });
}

function idbPut(idb, key, value) {
  return new Promise((resolve) => {
    const tx = idb.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

function idbClear(idb) {
  return new Promise((resolve) => {
    const tx = idb.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

class Store {
  constructor() {
    this.data = {};
    this._settings = { ...DEFAULT_SETTINGS };
    this.tombstones = {};   // { col: { id: isoDate } } — удалённые записи, нужны для синхронизации
    this.subs = new Set();
    this.idb = null;
    this._pending = new Map();
    for (const c of COLLECTIONS) this.data[c] = [];
    this.ready = this._load();
  }

  async _load() {
    this.idb = await openIDB();
    let raw = {};
    if (this.idb) raw = await idbGetAll(this.idb);
    else {
      try { raw = JSON.parse(localStorage.getItem('lifeos') || '{}'); } catch { raw = {}; }
    }
    for (const c of COLLECTIONS) if (Array.isArray(raw[c])) this.data[c] = raw[c];
    if (raw.tombstones && typeof raw.tombstones === 'object') this.tombstones = raw.tombstones;
    if (raw.settings && typeof raw.settings === 'object') this._settings = { ...DEFAULT_SETTINGS, ...raw.settings };
    // Однократная миграция на Deep Space: старые настройки могли хранить светлую/авто тему.
    if ((raw.settings || {}).themeV !== DEFAULT_SETTINGS.themeV) {
      this._settings = { ...this._settings, theme: 'dark', themeV: DEFAULT_SETTINGS.themeV };
      this._persist('settings');
    }
    return this;
  }

  _persist(key) {
    // Дебаунс записи на коллекцию, чтобы не долбить диск при серии изменений.
    if (this._pending.has(key)) clearTimeout(this._pending.get(key));
    this._pending.set(key, setTimeout(() => {
      this._pending.delete(key);
      const value = key === 'settings' ? this._settings : key === 'tombstones' ? this.tombstones : this.data[key];
      if (this.idb) idbPut(this.idb, key, value);
      else {
        try {
          const all = JSON.parse(localStorage.getItem('lifeos') || '{}');
          all[key] = value;
          localStorage.setItem('lifeos', JSON.stringify(all));
        } catch (e) { console.warn('persist failed', e); }
      }
    }, 120));
  }

  _emit(col) { for (const fn of this.subs) { try { fn(col); } catch (e) { console.error(e); } } }

  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }

  all(col) { this._check(col); return this.data[col]; }
  get(col, id) { this._check(col); return this.data[col].find(r => r.id === id); }
  where(col, pred) { this._check(col); return this.data[col].filter(pred); }

  add(col, obj) {
    this._check(col);
    const now = new Date().toISOString();
    const rec = { id: uid(), createdAt: now, updatedAt: now, ...obj };
    this.data[col] = [...this.data[col], rec];
    this._persist(col); this._emit(col);
    return rec;
  }

  update(col, id, patch) {
    this._check(col);
    let updated;
    this.data[col] = this.data[col].map(r => {
      if (r.id !== id) return r;
      const p = typeof patch === 'function' ? patch(r) : patch;
      updated = { ...r, ...p, updatedAt: new Date().toISOString() };
      return updated;
    });
    if (updated) { this._persist(col); this._emit(col); }
    return updated;
  }

  upsert(col, obj) {
    if (obj.id && this.get(col, obj.id)) return this.update(col, obj.id, obj);
    return this.add(col, obj);
  }

  remove(col, id) {
    this._check(col);
    const before = this.data[col].length;
    this.data[col] = this.data[col].filter(r => r.id !== id);
    if (this.data[col].length !== before) {
      (this.tombstones[col] ||= {})[id] = new Date().toISOString();
      this._persist(col); this._persist('tombstones'); this._emit(col);
    }
  }

  settings() { return this._settings; }
  setSettings(patch) {
    this._settings = { ...this._settings, ...patch, updatedAt: new Date().toISOString() };
    this._persist('settings'); this._emit('settings');
    return this._settings;
  }

  // Снимок всего состояния для синхронизации и применение слитого состояния (без изменения меток времени).
  snapshot() {
    const collections = {};
    for (const c of COLLECTIONS) collections[c] = this.data[c];
    return { v: 1, settings: this._settings, tombstones: this.tombstones, collections };
  }

  applyMerged(state) {
    for (const c of COLLECTIONS) {
      const next = Array.isArray(state.collections?.[c]) ? state.collections[c] : this.data[c];
      if (next !== this.data[c]) { this.data[c] = next; this._persist(c); }
    }
    if (state.tombstones) { this.tombstones = state.tombstones; this._persist('tombstones'); }
    if (state.settings) { this._settings = { ...DEFAULT_SETTINGS, ...state.settings }; this._persist('settings'); }
    this._emit('*');
  }

  exportJSON() {
    const out = { _app: 'lifeos', _version: 1, exportedAt: new Date().toISOString(), settings: this._settings };
    for (const c of COLLECTIONS) out[c] = this.data[c];
    return out;
  }

  async importJSON(obj, { merge = false } = {}) {
    if (!obj || typeof obj !== 'object') throw new Error('Неверный формат файла');
    for (const c of COLLECTIONS) {
      if (!Array.isArray(obj[c])) continue;
      if (merge) {
        const byId = new Map(this.data[c].map(r => [r.id, r]));
        for (const r of obj[c]) if (r && r.id) byId.set(r.id, r);
        this.data[c] = [...byId.values()];
      } else this.data[c] = obj[c];
      this._persist(c);
    }
    if (obj.settings) { this._settings = { ...DEFAULT_SETTINGS, ...obj.settings }; this._persist('settings'); }
    this._emit('*');
  }

  async clearAll() {
    for (const c of COLLECTIONS) this.data[c] = [];
    this._settings = { ...DEFAULT_SETTINGS };
    this.tombstones = {};
    if (this.idb) await idbClear(this.idb); else localStorage.removeItem('lifeos');
    this._emit('*');
  }

  _check(col) { if (!(col in this.data)) throw new Error('Неизвестная коллекция: ' + col); }
}

export const db = new Store();
