// Общая доменная логика: единственное место, где считается «что сегодня», прогресс проектов и целей,
// выполнение привычек из фактических данных, кто такой CEO, тон приложения и включённые модули.
// Страницы — это представления над этими функциями; они не должны дублировать подсчёты.
import { db } from './db.js';
import { today, addDays, sum } from './ui.js';

// ---------- справочники ----------
export const TASK_SOURCES = { manual: 'Своя', ceo: 'От CEO', promise: 'Обещание', project: 'Проект', meeting: 'Со встречи', assistant: 'Помощник' };
export const NOTE_TYPES = { note: 'Заметка', idea: 'Идея', recommendation: 'Рекомендация', meeting: 'Встреча', insight: 'Инсайт', 'project-log': 'Журнал проекта' };
export const NOTE_TYPE_OPTIONS = Object.entries(NOTE_TYPES);
export const MEETING_KINDS = { meeting: 'Встреча', call: 'Созвон', chat: 'Переписка', other: 'Другое' };

// ---------- тон и шум ----------
export const tone = () => db.settings().tone || 'neutral';
export const quotesOn = () => !!db.settings().quotes;
// Обращение к пользователю: в нейтральном и деловом режиме — по имени или без обращения.
export function addressing() {
  const s = db.settings();
  if (tone() === 'support') return 'чемпион';
  return (s.name || '').trim();
}

// ---------- модули ----------
export function moduleState(pageId) {
  const m = db.settings().modules || {};
  return m[pageId] || 'on';
}
export const moduleOn = (pageId) => moduleState(pageId) !== 'off';
export const moduleInMenu = (pageId) => moduleState(pageId) === 'on';

// ---------- CEO ----------
export function ceoPerson() {
  const s = db.settings();
  if (s.ceoPersonId) { const p = db.get('people', s.ceoPersonId); if (p) return p; }
  return db.all('people').find(p => p.type === 'ceo') || null;
}
export function ensureCeoPerson() {
  const p = ceoPerson(); if (p) return p;
  return db.upsert('people', { id: 'person_ceo', name: 'CEO', type: 'ceo', role: '', org: '', tg: '', email: '', phone: '', tags: [], notes: '', color: 'var(--c3)' });
}

// ---------- задачи ----------
export const isMine = (t) => t.direction !== 'theirs';          // моя задача (не «мне обещали»)
export const isOpen = (t) => !t.done;
export function newTask(patch = {}) {
  return { title: '', notes: '', date: null, time: '', priority: 2, done: false, doneAt: null, projectId: null, streamId: null, goalId: null, personId: null, source: 'manual', direction: 'mine', tags: [], estimateMin: null, recurring: null, checklist: [], timeless: false, ...patch };
}
export function addTask(patch) { const t = newTask(patch); if (!t.title) return null; return db.add('tasks', t); }
export function setTaskDone(id, done = true) {
  const t = db.get('tasks', id); if (!t) return null;
  return db.update('tasks', id, done ? { done: true, doneAt: new Date().toISOString() } : { done: false, doneAt: null });
}
export function toggleTask(id) { const t = db.get('tasks', id); if (!t) return null; return setTaskDone(id, !t.done); }
// Повторяющаяся задача: после закрытия создаёт следующий повтор (не раньше сегодняшнего дня).
// Возвращает новую задачу или null, если повтора нет.
export function spawnNextRecurring(t) {
  if (!t || !t.done || (t.recurring !== 'daily' && t.recurring !== 'weekly')) return null;
  const step = t.recurring === 'daily' ? 1 : 7;
  const tod = today();
  let next = addDays(t.date || tod, step);
  let guard = 0;
  while (next < tod && guard++ < 400) next = addDays(next, step);
  const exists = db.all('tasks').some(x => !x.done && x.title === t.title && x.date === next && x.recurring === t.recurring);
  if (exists) return null;
  return addTask({ title: t.title, date: next, time: t.time || '', priority: t.priority || 2, goalId: t.goalId || null, projectId: t.projectId || null, streamId: t.streamId || null, personId: t.personId || null, source: t.source || 'manual', direction: t.direction || 'mine', notes: t.notes || '', estimateMin: t.estimateMin ?? null, recurring: t.recurring, tags: t.tags || [] });
}
export const doneOn = (t, d) => t.done && String(t.doneAt || '').slice(0, 10) === d;
export const tasksOfPerson = (personId) => db.where('tasks', t => t.personId === personId);
export const tasksOfProject = (projectId) => db.where('tasks', t => t.projectId === projectId);
export const openTasksOfPerson = (personId) => tasksOfPerson(personId).filter(isOpen);

// ---------- события ----------
export function occursOn(ev, d) {
  if (!ev.date) return false;
  if (ev.date === d) return true;
  if (!ev.repeat || ev.repeat === 'none' || d < ev.date) return false;
  if (ev.until && d > ev.until) return false;
  const wd = (x) => (new Date(x + 'T00:00').getDay() + 6) % 7;
  if (ev.repeat === 'daily') return true;
  if (ev.repeat === 'weekdays') return wd(d) < 5;
  if (ev.repeat === 'weekly') return wd(d) === wd(ev.date);
  if (ev.repeat === 'monthly') return d.slice(8) === ev.date.slice(8);
  return false;
}
export const eventsOn = (d) => db.all('events').filter(ev => occursOn(ev, d)).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
export const nowHM = () => { const n = new Date(); return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`; };
// Следующее событие от текущего момента (сегодня с временем позже сейчас, иначе ближайший день).
export function nextEvent(days = 14) {
  const t = today(), hm = nowHM();
  for (let i = 0; i <= days; i++) {
    const d = addDays(t, i);
    for (const ev of eventsOn(d)) if (i > 0 || !ev.time || (ev.endTime || ev.time) >= hm) return { ...ev, on: d };
  }
  return null;
}
export function nextMeetingWith(personId, days = 60) {
  const t = today(), hm = nowHM();
  for (let i = 0; i <= days; i++) {
    const d = addDays(t, i);
    for (const ev of eventsOn(d)) if (ev.personId === personId && (i > 0 || !ev.time || (ev.endTime || ev.time) >= hm)) return { ...ev, on: d };
  }
  return null;
}

// ---------- повестка дня: всё, что привязано к дате ----------
// Возвращает элементы { type: event|task|waiting|deadline|health, id, title, time, done, priority, page, params, data }.
export function agendaOn(d) {
  const out = [];
  for (const ev of eventsOn(d)) out.push({ type: 'event', id: ev.id, title: ev.title, time: ev.time || '', end: ev.endTime || '', place: ev.place || '', kind: ev.kind || 'other', repeat: !!(ev.repeat && ev.repeat !== 'none'), personId: ev.personId || null, data: ev });
  for (const t of db.all('tasks')) if (t.date === d) out.push({ type: isMine(t) ? 'task' : 'waiting', id: t.id, title: t.title, time: t.time || '', done: !!t.done, priority: t.priority, source: t.source, personId: t.personId || null, data: t });
  for (const p of db.all('projects')) if (p.deadline === d && p.status !== 'done') out.push({ type: 'deadline', id: p.id, title: `Дедлайн: ${p.name}`, time: '', page: 'projects', params: { id: p.id } });
  for (const g of db.all('goals')) if (g.deadline === d && g.status === 'active') out.push({ type: 'deadline', id: g.id, title: `Цель: ${g.title}`, time: '', page: 'plan', params: { tab: 'goals' } });
  for (const h of db.all('healthTodos')) if (h.date === d && !h.done) out.push({ type: 'health', id: h.id, title: h.title, time: '', page: 'health' });
  const order = { event: 0, task: 1, waiting: 2, deadline: 3, health: 4 };
  return out.sort((a, b) => `${a.time ? '0' + a.time : '1'}${order[a.type]}${a.priority || 2}`.localeCompare(`${b.time ? '0' + b.time : '1'}${order[b.type]}${b.priority || 2}`));
}

// Ближайшие дедлайны и ожидания на N дней вперёд (без событий; они в nextEvent/agendaOn).
export function upcomingDeadlines(days = 14, limit = 5) {
  const t = today(), end = addDays(t, days), out = [];
  for (const x of db.all('tasks')) if (!x.done && x.date && x.date > t && x.date <= end) out.push({ date: x.date, title: x.title, kind: !isMine(x) ? 'ждём от ' + (personName(x.personId) || 'человека') : x.source === 'ceo' ? 'задача от CEO' : x.source === 'promise' ? 'обещание' : 'задача', page: 'plan', params: { tab: 'today', date: x.date }, id: x.id, type: 'task' });
  for (const p of db.all('projects')) if (p.status !== 'done' && p.deadline && p.deadline >= t && p.deadline <= end) out.push({ date: p.deadline, title: p.name, kind: 'дедлайн проекта', page: 'projects', params: { id: p.id } });
  for (const g of db.all('goals')) if (g.status === 'active' && g.deadline && g.deadline >= t && g.deadline <= end) out.push({ date: g.deadline, title: g.title, kind: 'дедлайн цели', page: 'plan', params: { tab: 'goals' } });
  for (const x of db.all('healthTodos')) if (!x.done && x.date && x.date >= t && x.date <= end) out.push({ date: x.date, title: x.title, kind: x.type === 'appointment' ? 'приём' : 'здоровье', page: 'health' });
  return out.sort((a, b) => a.date.localeCompare(b.date)).slice(0, limit);
}
export function overdueItems() {
  const t = today();
  const tasks = db.all('tasks').filter(x => !x.done && x.date && x.date < t && isMine(x));
  const waiting = db.all('tasks').filter(x => !x.done && x.date && x.date < t && !isMine(x));
  const projects = db.all('projects').filter(p => p.status !== 'done' && p.deadline && p.deadline < t);
  return { tasks, waiting, projects, total: tasks.length + waiting.length + projects.length };
}

// ---------- люди ----------
export const personName = (id) => (id && db.get('people', id)?.name) || '';
// Дата последнего контакта: заметки о встречах (новая модель) + старый журнал contacts (на всякий случай).
export function lastContactOf(personId) {
  const dates = [
    ...db.where('notes', n => n.type === 'meeting' && n.personId === personId).map(n => n.date),
    ...db.where('contacts', c => c.personId === personId).map(c => c.date),
  ].filter(Boolean);
  return dates.length ? dates.sort().at(-1) : null;
}
export const notesOfPerson = (personId) => db.where('notes', n => n.personId === personId);

// ---------- прогресс ----------
export function projectProgress(p) {
  const tasks = tasksOfProject(p.id);
  if (p.status === 'done') return 100;
  if (tasks.length) return Math.round(100 * tasks.filter(t => t.done).length / tasks.length);
  const streams = db.where('streams', s => s.projectId === p.id);
  if (streams.length && streams.some(s => s.status === 'done')) return Math.round(100 * streams.filter(s => s.status === 'done').length / streams.length);
  return Math.max(0, Math.min(100, Number(p.progress) || 0));
}
export function goalProgress(g) {
  const krs = g.keyResults || [];
  if (krs.length) return Math.round(100 * krs.filter(k => k.done).length / krs.length);
  const tasks = db.where('tasks', t => t.goalId === g.id);
  if (tasks.length) return Math.round(100 * tasks.filter(t => t.done).length / tasks.length);
  return Math.max(0, Math.min(100, Math.round(Number(g.progress) || 0)));
}

// ---------- привычки из фактических данных ----------
export const HABIT_AUTO = {
  water:   { label: 'Вода достигла нормы', icon: '💧' },
  workout: { label: 'Записана тренировка', icon: '🏋️' },
  study:   { label: 'Записано занятие', icon: '📘' },
  sleep:   { label: 'Сон не меньше нормы', icon: '🌙' },
  steps:   { label: 'Шаги достигли нормы', icon: '👟' },
  task:    { label: 'Закрыта задача со словом…', icon: '✅' },
};
const weekdayIdx = (dateIso) => (new Date(dateIso + 'T00:00').getDay() + 6) % 7;
export const habitScheduled = (h, d) => !(Array.isArray(h.days) && h.days.length) || h.days.includes(weekdayIdx(d));
export const habitTarget = (h) => Math.max(1, Number(h.target) || 1);

// Автоматический прогресс привычки за день: { count, target } или null, если авто не настроено.
export function habitAutoProgress(h, d) {
  const a = h.auto; if (!a || !a.kind) return null;
  const s = db.settings();
  switch (a.kind) {
    case 'water': { const log = db.all('dayLogs').find(x => x.date === d); const ml = log?.waterMl || 0; const tg = Number(a.target) || s.waterTarget || 2000; return { count: ml, target: tg, done: ml >= tg, text: `${ml} / ${tg} мл` }; }
    case 'steps': { const log = db.all('dayLogs').find(x => x.date === d); const n = log?.steps || 0; const tg = Number(a.target) || s.stepsTarget || 8000; return { count: n, target: tg, done: n >= tg, text: `${n} / ${tg}` }; }
    case 'workout': { const n = db.all('workouts').filter(w => w.date === d).length; return { count: n, target: 1, done: n >= 1, text: n ? 'тренировка записана' : 'нет тренировки' }; }
    case 'study': { const mins = sum(db.all('studySessions').filter(x => x.date === d && (!a.areaId || x.areaId === a.areaId)), x => x.minutes); const tg = Number(a.target) || 1; return { count: mins, target: tg, done: mins >= tg, text: `${mins} / ${tg} мин` }; }
    case 'sleep': { const log = db.all('sleepLogs').find(x => x.date === d); const hrs = Number(log?.hours) || 0; const tg = Number(a.target) || s.sleepTarget || 8; return { count: hrs, target: tg, done: hrs >= tg, text: log ? `${hrs} ч` : 'сон не записан' }; }
    case 'task': { const kw = String(a.keyword || '').trim().toLowerCase(); if (!kw) return null; const n = db.all('tasks').filter(t => doneOn(t, d) && String(t.title).toLowerCase().includes(kw)).length; return { count: n, target: 1, done: n >= 1, text: n ? 'задача закрыта' : `задача «${kw}» ещё открыта` }; }
    default: return null;
  }
}
// Итог по привычке за день: выполнена вручную (habitLogs) или автоматически.
export function habitStatus(h, d, logs = null) {
  const tg = habitTarget(h);
  const list = logs || db.all('habitLogs');
  const manual = list.filter(l => l.habitId === h.id && l.date === d).reduce((m, l) => Math.max(m, Number(l.count) || 0), 0);
  const auto = habitAutoProgress(h, d);
  const done = manual >= tg || !!auto?.done;
  return { count: done ? Math.max(manual, tg) : manual, target: tg, done, auto, manual };
}
export function setHabitCount(habitId, d, count) {
  const ex = db.all('habitLogs').find(l => l.habitId === habitId && l.date === d);
  if (count <= 0) { if (ex) db.remove('habitLogs', ex.id); return; }
  if (ex) db.update('habitLogs', ex.id, { count }); else db.add('habitLogs', { habitId, date: d, count });
}

// ---------- чек-ин и сон: единые источники ----------
export const checkinOn = (d) => db.all('checkins').find(c => c.date === d) || null;
export const sleepOn = (d) => db.all('sleepLogs').find(s => s.date === d) || null;
export function setCheckin(d, patch) {
  const cur = checkinOn(d);
  if (cur) return db.update('checkins', cur.id, patch);
  return db.add('checkins', { date: d, mood: null, energy: null, stress: null, confidence: null, symptoms: [], notes: '', ...patch });
}
export function setSleepHours(d, hours) {
  const cur = sleepOn(d);
  if (cur) return db.update('sleepLogs', cur.id, { hours });
  return db.add('sleepLogs', { date: d, bedTime: '', wakeTime: '', hours, quality: null, notes: '' });
}
export function energyOn(d) { const c = checkinOn(d); if (c?.energy) return c.energy; return sleepOn(d)?.energy || null; }

// ---------- быстрые записи активности ----------
export function addWater(ml, d = today()) {
  const log = db.all('dayLogs').find(x => x.date === d);
  if (log) db.update('dayLogs', log.id, { waterMl: (log.waterMl || 0) + ml }); else db.add('dayLogs', { date: d, waterMl: ml, steps: 0 });
}
export function addSteps(n, d = today()) {
  const log = db.all('dayLogs').find(x => x.date === d);
  if (log) db.update('dayLogs', log.id, { steps: (log.steps || 0) + n }); else db.add('dayLogs', { date: d, waterMl: 0, steps: n });
}

// ---------- заметки ----------
export function newNote(patch = {}) {
  return { type: 'note', title: '', body: '', date: today(), tags: [], personId: null, projectId: null, goalId: null, learningItemId: null, pinned: false, quote: false, sourceType: 'thought', sourceTitle: '', sourceAuthor: '', sourceUrl: '', ...patch };
}
export function addNote(patch) { const n = newNote(patch); if (!n.title && !n.body) return null; if (!n.title) n.title = String(n.body).split('\n')[0].slice(0, 80); return db.add('notes', n); }
// Пул цитат: заметки с пометкой «цитата» (рекомендации CEO и любые другие).
export const quotePool = () => db.all('notes').filter(n => n.quote && (n.body || n.title));

// ---------- расходы ----------
export function addTransaction({ type = 'expense', amount, category = '', note = '', date = today() }) {
  if (!amount) return null;
  return db.add('transactions', { date, type, amount: Number(amount), category: category || (type === 'income' ? 'Доход' : 'Прочее'), note });
}
