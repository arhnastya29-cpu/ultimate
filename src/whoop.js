// WHOOP: сон, восстановление, нагрузка и тренировки. Данные забирает локальный сервер (serve.py → whoop/),
// приложение читает их с моста и записывает в базу: сон → sleepLogs (часы, отбой, подъём), день → whoopDays
// (recovery, HRV, пульс покоя, strain), тренировки → workouts с пометкой source: 'whoop'. База синхронизируется,
// так что на телефоне данные тоже видны; сам WHOOP подключён только к Mac.
import { db } from './db.js';
import { bridgeStatus, probeLocal } from './signals.js';
import { today } from './ui.js';

let status = null;
let syncing = false;
export const whoopStatus = () => status;
export const isSyncing = () => syncing;

async function base() {
  if (bridgeStatus().local === null) await probeLocal();
  return bridgeStatus().local ? bridgeStatus().base : null;
}
async function call(action, params = {}, { timeout = 15000 } = {}) {
  const b = await base();
  if (b === null) throw new Error('Нет связи с сервером ULTIMATE на Mac: откройте приложение через start.command.');
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), timeout);
  try {
    const q = new URLSearchParams({ ...params, t: Date.now().toString(36) }).toString();
    const r = await fetch(`${b}/__whoop/${action}?${q}`, { cache: 'no-store', signal: ctl.signal });
    if (!r.ok) throw new Error(`сервер ответил ${r.status}`);
    return await r.json();
  } finally { clearTimeout(tm); }
}
// Сохранить ключи приложения WHOOP на сервере (whoop/config.json). Значения уходят только на 127.0.0.1.
export async function saveConfig(clientId, clientSecret) {
  const b = await base();
  if (b === null) throw new Error('Нет связи с сервером ULTIMATE на Mac: откройте приложение через start.command.');
  const r = await fetch(`${b}/__whoop/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || `сервер ответил ${r.status}`);
  return refreshStatus();
}
export async function connectUrl() { const b = await base(); return b === null ? null : `${b || location.origin}/__whoop/connect`; }
export async function refreshStatus() { status = await call('status'); window.dispatchEvent(new Event('ultimate:whoop')); return status; }
export async function disconnect() { await call('disconnect'); return refreshStatus(); }

// Сбор на сервере + запись в базу. days — глубина (при первом подключении сервер уже взял 30 дней).
export async function sync({ days = 7 } = {}) {
  if (syncing) return null;
  syncing = true; window.dispatchEvent(new Event('ultimate:whoop'));
  try {
    const r = await call('sync', { days }, { timeout: 120000 });
    if (!r.ok) throw new Error(r.error || 'сбор не удался');
    const data = await call('data', {}, { timeout: 30000 });
    const n = importData(data);
    try { localStorage.setItem('ultimate_whoop_synced', new Date().toISOString()); } catch {}
    await refreshStatus();
    return { ...r, imported: n };
  } finally { syncing = false; window.dispatchEvent(new Event('ultimate:whoop')); }
}
export function lastSyncAt() { try { return localStorage.getItem('ultimate_whoop_synced'); } catch { return null; } }
export function stale(ms = 3 * 3600 * 1000) { const t = lastSyncAt(); return !t || Date.now() - new Date(t).getTime() > ms; }

// Тихая синхронизация при запуске на Mac: если WHOOP подключён и данные старше трёх часов.
export async function autoSync() {
  try {
    if (await base() === null) return;
    await refreshStatus();
    if (status?.connected && stale() && !syncing) await sync({ days: 7 });
  } catch (e) { console.warn('WHOOP autosync', e); }
}

// Запись в базу. Возвращает число обновлённых дней.
export function importData(data) {
  const days = Object.values(data?.days || {});
  let n = 0;
  for (const d of days) {
    if (!d.date) continue;
    const id = 'whoop_' + d.date;
    const rec = { id, date: d.date, recovery: d.recovery ?? null, hrv: d.hrv ?? null, rhr: d.rhr ?? null, spo2: d.spo2 ?? null, skinTemp: d.skinTemp ?? null,
      strain: d.strain ?? null, kcal: d.kcal ?? null, avgHr: d.avgHr ?? null, maxHr: d.maxHr ?? null, steps: d.steps ?? null,
      sleepHours: d.hours ?? null, inBedHours: d.inBedHours ?? null, performance: d.performance ?? null, efficiency: d.efficiency ?? null, consistency: d.consistency ?? null,
      remMin: d.remMin ?? null, deepMin: d.deepMin ?? null, lightMin: d.lightMin ?? null, awakeMin: d.awakeMin ?? null, disturbances: d.disturbances ?? null,
      respiratoryRate: d.respiratoryRate ?? null, sleepNeededHours: d.sleepNeededHours ?? null };
    const cur = db.get('whoopDays', id);
    if (!cur || JSON.stringify({ ...cur, updatedAt: 0, createdAt: 0 }) !== JSON.stringify({ ...cur, ...rec, updatedAt: 0, createdAt: 0 })) { db.upsert('whoopDays', rec); n++; }
    // Сон: часы, отбой и подъём — в единый журнал сна; оценка качества и заметки остаются ручными.
    if (d.hours != null) {
      const log = db.all('sleepLogs').find(x => x.date === d.date);
      const patch = { date: d.date, hours: Math.round(Number(d.hours) * 100) / 100, bedTime: d.bedTime || '', wakeTime: d.wakeTime || '', source: 'whoop' };
      if (!log) db.add('sleepLogs', { ...patch, quality: null, notes: '' });
      else if (log.source === 'whoop' || !log.hours) db.update('sleepLogs', log.id, patch);
    }
  }
  // Тренировки
  const have = new Set(db.all('workouts').map(w => w.id));
  for (const w of data?.workouts || []) {
    const id = 'whoop_wk_' + w.id;
    if (have.has(id)) continue;
    const sport = String(w.sport || 'Тренировка');
    const type = /strength|weight|сил|function/i.test(sport) ? 'strength' : /yoga|stretch|pilates|mobility|йог/i.test(sport) ? 'mobility' : 'cardio';
    db.add('workouts', { id, date: w.date, type, title: sport, durationMin: w.durationMin || null, rpe: null, exercises: [], source: 'whoop',
      notes: `WHOOP: нагрузка ${w.strain != null ? Number(w.strain).toFixed(1) : '—'}${w.avgHr ? `, пульс ${w.avgHr} (макс ${w.maxHr})` : ''}${w.kcal ? `, ${w.kcal} ккал` : ''}${w.distanceM ? `, ${(w.distanceM / 1000).toFixed(1)} км` : ''}` });
  }
  return n;
}

export const whoopOn = (d = today()) => db.get('whoopDays', 'whoop_' + d) || null;
export const whoopUsed = () => db.all('whoopDays').length > 0;
export const recoveryClass = (r) => r == null ? '' : r >= 67 ? 'good' : r >= 34 ? 'warn' : 'bad';
export const recoveryWord = (r) => r == null ? '' : r >= 67 ? 'зелёная зона' : r >= 34 ? 'жёлтая зона' : 'красная зона';
