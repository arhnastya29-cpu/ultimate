// Облачная синхронизация с паролем.
//
// Как устроено:
//   • Из пароля (PBKDF2, 250 000 итераций) выводятся две вещи: идентификатор «полки» в облаке
//     и ключ шифрования AES-GCM. Пароль никуда не отправляется.
//   • Весь снимок данных (db.snapshot) сжимается, шифруется и кладётся в таблицу `vaults`
//     Supabase одной строкой. В облаке лежит только шифртекст.
//   • При синхронизации: скачать → расшифровать → слить с локальным (по записям: новее побеждает,
//     удаления учитываются через метки db.tombstones) → применить локально → отправить обратно.
//     Отправка защищена номером версии: если кто-то успел записать раньше, сливаем заново.
//   • Запускается при старте, при возвращении на вкладку, при появлении сети и через пару секунд
//     после любого изменения данных.
//
// Публичный ключ Supabase (anon/publishable) не секретный: доступ к данным даёт только пароль.

import { db, COLLECTIONS } from './db.js';

const SUPABASE_URL = 'https://alsiycuvfpbcafbqmxbc.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Jva5ty_BFTaFAZmcOvouTw_FEa35EiD';
const TABLE = 'vaults';
const LS_KEY = 'ultimate_sync';
const PBKDF2_ITER = 250000;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- состояние ----------
let cfg = loadCfg();            // { vaultId, keyJwk, enabledAt, lastSync, lastError }
let cryptoKey = null;           // CryptoKey, восстанавливается из cfg.keyJwk
let busy = false;
let pending = false;
let applying = false;           // пока применяем слитое состояние, не реагируем на события db
let timer = null;
const listeners = new Set();

function loadCfg() { try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; } }
function saveCfg() { try { cfg ? localStorage.setItem(LS_KEY, JSON.stringify(cfg)) : localStorage.removeItem(LS_KEY); } catch {} }
function notify() { for (const fn of listeners) { try { fn(status()); } catch (e) { console.error(e); } } }

export function status() {
  return { enabled: !!cfg, busy, lastSync: cfg?.lastSync || null, lastError: cfg?.lastError || null, enabledAt: cfg?.enabledAt || null };
}
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// ---------- криптография ----------
const toHex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
function b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(str) { const s = atob(str); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }

async function deriveBits(password, salt, bits) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: PBKDF2_ITER }, base, bits);
}

async function deriveFromPassword(password) {
  const idBits = await deriveBits(password, 'ultimate-sync-id-v1', 256);
  const keyBits = await deriveBits(password, 'ultimate-sync-key-v1', 256);
  const key = await crypto.subtle.importKey('raw', keyBits, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  const keyJwk = await crypto.subtle.exportKey('jwk', key);
  return { vaultId: toHex(idBits), key, keyJwk };
}

async function getKey() {
  if (cryptoKey) return cryptoKey;
  if (!cfg?.keyJwk) throw new Error('Синхронизация не настроена');
  cryptoKey = await crypto.subtle.importKey('jwk', cfg.keyJwk, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  return cryptoKey;
}

async function gzip(bytes) {
  if (typeof CompressionStream === 'undefined') return { bytes, gz: false };
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return { bytes: new Uint8Array(await new Response(stream).arrayBuffer()), gz: true };
}
async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Формат blob: "<tag>.<base64(iv)>.<base64(ciphertext)>", tag = 'g1' (gzip) | 'p1' (без сжатия)
async function encryptState(state) {
  const key = await getKey();
  const { bytes, gz } = await gzip(enc.encode(JSON.stringify(state)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return `${gz ? 'g1' : 'p1'}.${b64(iv)}.${b64(ct)}`;
}

async function decryptState(blob) {
  const key = await getKey();
  const [tag, ivB, ctB] = String(blob).split('.');
  if (!tag || !ivB || !ctB) throw new Error('Повреждённые данные в облаке');
  let plain;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB) }, key, unb64(ctB)));
  } catch {
    throw new Error('Не удалось расшифровать: пароль не совпадает с тем, что использован на другом устройстве');
  }
  if (tag === 'g1') plain = await gunzip(plain);
  return JSON.parse(dec.decode(plain));
}

// ---------- Supabase REST ----------
function headers(extra = {}) {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', ...extra };
}

async function pull(vaultId) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(vaultId)}&select=blob,version`, { headers: headers() });
  if (!r.ok) throw new Error(`Облако недоступно (${r.status})`);
  const rows = await r.json();
  return rows[0] || null;
}

// Возвращает true при успехе, false при конфликте версий (кто-то записал раньше).
async function push(vaultId, blob, version) {
  const now = new Date().toISOString();
  if (version == null) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
      method: 'POST', headers: headers({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ id: vaultId, blob, version: 1, updated_at: now }),
    });
    if (r.status === 409) return false;            // уже создали с другого устройства
    if (!r.ok) throw new Error(`Не удалось сохранить в облако (${r.status})`);
    return true;
  }
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(vaultId)}&version=eq.${version}`, {
    method: 'PATCH', headers: headers({ Prefer: 'return=representation' }),
    body: JSON.stringify({ blob, version: version + 1, updated_at: now }),
  });
  if (!r.ok) throw new Error(`Не удалось сохранить в облако (${r.status})`);
  const rows = await r.json();
  return rows.length > 0;
}

// ---------- слияние ----------
const ts = (r) => r?.updatedAt || r?.createdAt || '';

function mergeStates(local, remote) {
  const tomb = {};
  for (const src of [local.tombstones || {}, remote.tombstones || {}]) {
    for (const col of Object.keys(src)) for (const [id, t] of Object.entries(src[col])) {
      tomb[col] ||= {};
      if (!tomb[col][id] || tomb[col][id] < t) tomb[col][id] = t;
    }
  }
  const collections = {};
  let changedLocal = false;
  for (const col of COLLECTIONS) {
    const byId = new Map();
    for (const r of local.collections?.[col] || []) if (r?.id) byId.set(r.id, r);
    for (const r of remote.collections?.[col] || []) {
      if (!r?.id) continue;
      const cur = byId.get(r.id);
      if (!cur || ts(r) > ts(cur)) byId.set(r.id, r);
    }
    const out = [];
    for (const r of byId.values()) {
      const t = tomb[col]?.[r.id];
      if (t && t >= ts(r)) continue;                 // удалено позже, чем менялось
      out.push(r);
    }
    out.sort((a, b) => (a.createdAt || '') < (b.createdAt || '') ? -1 : 1);
    collections[col] = out;
    if (JSON.stringify(out) !== JSON.stringify(local.collections?.[col] || [])) changedLocal = true;
  }
  const ls = local.settings || {}, rs = remote.settings || {};
  const settings = (rs.updatedAt || '') > (ls.updatedAt || '') ? rs : ls;
  if (settings !== ls) changedLocal = true;
  if (JSON.stringify(tomb) !== JSON.stringify(local.tombstones || {})) changedLocal = true;
  return { state: { v: 1, settings, tombstones: tomb, collections }, changedLocal };
}

// ---------- основной цикл ----------
export async function syncNow({ silent = true } = {}) {
  if (!cfg) return { ok: false, reason: 'disabled' };
  if (busy) { pending = true; return { ok: false, reason: 'busy' }; }
  busy = true; notify();
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const remote = await pull(cfg.vaultId);
      const local = db.snapshot();
      let merged = local, changedLocal = false, same = false;
      if (remote) {
        const remoteState = await decryptState(remote.blob);
        ({ state: merged, changedLocal } = mergeStates(local, remoteState));
        same = JSON.stringify(merged) === JSON.stringify(remoteState);
      }
      if (changedLocal) {
        applying = true;
        try { db.applyMerged(merged); } finally { applying = false; }
      }
      if (!same) {
        const blob = await encryptState(merged);
        const ok = await push(cfg.vaultId, blob, remote ? remote.version : null);
        if (!ok) continue;                           // конфликт версий — повторить с новыми данными
      }
      cfg.lastSync = new Date().toISOString(); cfg.lastError = null; saveCfg();
      return { ok: true, changedLocal, created: !remote };
    }
    throw new Error('Облако слишком занято, попробуйте ещё раз');
  } catch (e) {
    cfg.lastError = e.message || String(e); saveCfg();
    if (!silent) throw e;
    console.warn('sync:', e);
    return { ok: false, reason: cfg.lastError };
  } finally {
    busy = false; notify();
    if (pending) { pending = false; schedule(1500); }
  }
}

function schedule(ms = 2500) {
  if (!cfg) return;
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; syncNow(); }, ms);
}

export async function enable(password) {
  if (!password || password.length < 8) throw new Error('Пароль должен быть не короче 8 символов');
  if (!crypto?.subtle) throw new Error('Браузер не поддерживает шифрование (нужен HTTPS)');
  const { vaultId, key, keyJwk } = await deriveFromPassword(password);
  cfg = { vaultId, keyJwk, enabledAt: new Date().toISOString(), lastSync: null, lastError: null };
  cryptoKey = key; saveCfg(); notify();
  try {
    return await syncNow({ silent: false });
  } catch (e) {
    // Неверный пароль для уже существующей полки — не оставляем синхронизацию включённой.
    cfg = null; cryptoKey = null; saveCfg(); notify();
    throw e;
  }
}

export function disable() {
  clearTimeout(timer); timer = null;
  cfg = null; cryptoKey = null; saveCfg(); notify();
}

export function initSync() {
  db.subscribe(() => { if (cfg && !applying) schedule(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(300); });
  window.addEventListener('online', () => schedule(300));
  window.addEventListener('pagehide', () => { if (timer) { clearTimeout(timer); timer = null; syncNow(); } });
  if (cfg) schedule(200);
}
