// Помощник на Claude: контекст из данных приложения, запрос к API прямо из браузера,
// потоковый ответ и действия (добавить задачу, отметить привычку, записать в Shadow и т.д.).
//
// Ключ API хранится только на этом устройстве (localStorage), в облако синхронизации не уходит.
// Запрос идёт напрямую в api.anthropic.com с заголовком anthropic-dangerous-direct-browser-access —
// это допустимо для личного приложения, где ключ принадлежит самому пользователю.

import { db } from './db.js';
import { today, addDays, fmtDate, lastNDays } from './ui.js';
import { occursOn } from './pages/calendar.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
const LS_KEY = 'ultimate_ai';
const LS_CHAT = 'ultimate_ai_chat';
export const MODELS = [
  ['claude-opus-5-5', 'Claude Opus 5.5 — умная, для разборов и советов'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 — быстрая и сильная'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5 — самая дешёвая, для простых вопросов'],
];

// ---------- настройки ----------
let cfg = load();
function load() { try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null') || { apiKey: '', model: 'claude-opus-5-5', workspaceId: '' }; } catch { return { apiKey: '', model: 'claude-opus-5-5', workspaceId: '' }; } }
export function aiConfig() { return { ...cfg }; }
export function setAiConfig(patch) { cfg = { ...cfg, ...patch }; try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch {} }
export function aiReady() { return !!(cfg.apiKey && cfg.apiKey.trim()); }

// ---------- история чата (только текст, для показа и продолжения разговора) ----------
let history = (() => { try { return JSON.parse(localStorage.getItem(LS_CHAT) || '[]'); } catch { return []; } })();
export function chatHistory() { return history; }
export function clearChat() { history = []; try { localStorage.removeItem(LS_CHAT); } catch {} }
function saveHistory() { history = history.slice(-40); try { localStorage.setItem(LS_CHAT, JSON.stringify(history)); } catch {} }

// ---------- контекст из данных ----------
const cut = (s, n = 140) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
const avg = (arr, f) => arr.length ? (arr.reduce((s, x) => s + (Number(f(x)) || 0), 0) / arr.length) : 0;

export function buildContext(pageId) {
  const t = today();
  const s = db.settings();
  const week = lastNDays(7, t);
  const two = lastNDays(14, t);
  const L = [];
  L.push(`Сегодня ${t} (${fmtDate(t, { weekday: true })}). Пользователь: ${s.name || 'имя не указано'}. Открытый раздел: ${pageId}.`);

  // Задачи
  const tasks = db.all('tasks');
  const open = tasks.filter(x => !x.done);
  const todayT = open.filter(x => x.date === t);
  const overdue = open.filter(x => x.date && x.date < t);
  const inbox = open.filter(x => !x.date && !x.timeless);
  const timeless = open.filter(x => !x.date && x.timeless);
  const doneToday = tasks.filter(x => x.done && String(x.doneAt || '').slice(0, 10) === t);
  const projName = (id) => id ? (db.get('projects', id)?.name || '') : '';
  const tline = (x) => `- [id ${x.id}] ${cut(x.title, 90)}${x.priority === 1 ? ' (важно)' : ''}${x.date ? ` · ${x.date}` : ''}${x.projectId ? ` · проект: ${cut(projName(x.projectId), 40)}` : ''}`;
  L.push(`\n## Задачи\nНа сегодня: ${todayT.length}, просрочено: ${overdue.length}, в инбоксе: ${inbox.length}, сделано сегодня: ${doneToday.length}.`);
  if (todayT.length) L.push('Сегодня:\n' + todayT.slice(0, 15).map(tline).join('\n'));
  if (overdue.length) L.push('Просрочено:\n' + overdue.slice(0, 10).map(tline).join('\n'));
  if (inbox.length) L.push('Инбокс:\n' + inbox.slice(0, 10).map(tline).join('\n'));
  if (timeless.length) L.push('Бессрочные (без дедлайна):\n' + timeless.slice(0, 10).map(tline).join('\n'));

  // Календарь: события на 7 дней
  const evLines = [];
  for (let i = 0; i < 7; i++) { const dd = addDays(t, i); for (const ev of db.all('events')) if (occursOn(ev, dd)) evLines.push(`- ${dd}${ev.time ? ` ${ev.time}` : ''}${ev.endTime ? `–${ev.endTime}` : ''}: ${cut(ev.title, 60)}${ev.place ? ` (${cut(ev.place, 30)})` : ''}`); }
  if (evLines.length) L.push(`\n## Календарь (события на неделю)\n` + evLines.slice(0, 25).join('\n'));

  // Цели
  const goals = db.all('goals').filter(g => g.status === 'active');
  if (goals.length) L.push(`\n## Цели (активные)\n` + goals.slice(0, 12).map(g => {
    const krs = g.keyResults || [];
    const p = krs.length ? pct(krs.filter(k => k.done).length, krs.length) : (Number(g.progress) || 0);
    return `- [id ${g.id}] ${cut(g.title, 90)} · ${g.horizon || ''} · ${p}%${g.deadline ? ` · до ${g.deadline}` : ''}${krs.length ? ` · результаты: ${krs.map(k => (k.done ? '✓ ' : '○ ') + cut(k.title, 50)).join('; ')}` : ''}`;
  }).join('\n'));
  if (s.visionStatement) L.push(`Картина будущего: ${cut(s.visionStatement, 600)}`);

  // Проекты и стримы
  const projects = db.all('projects').filter(p => p.status !== 'done');
  if (projects.length) L.push(`\n## Проекты\n` + projects.slice(0, 10).map(p => {
    const streams = db.where('streams', x => x.projectId === p.id);
    const pt = tasks.filter(x => x.projectId === p.id);
    const log = (p.log || []).slice(0, 2).map(e => `${e.date}: ${cut(e.text, 100)}`).join(' | ');
    return `- [id ${p.id}] ${cut(p.name, 80)} · ${p.status} · ${p.progress || 0}%${p.deadline ? ` · до ${p.deadline}` : ''}${p.nextStep ? ` · следующий шаг: ${cut(p.nextStep, 100)}` : ''}${streams.length ? ` · стримы: ${streams.map(st => `${cut(st.name, 30)} (${pt.filter(x => x.streamId === st.id && !x.done).length} откр.)`).join(', ')}` : ''}${pt.length ? ` · задач ${pt.filter(x => x.done).length}/${pt.length}` : ''}${log ? ` · журнал: ${log}` : ''}${p.notes ? ` · заметки: ${cut(p.notes, 200)}` : ''}`;
  }).join('\n'));

  // Shadow
  const sTasks = db.all('shadowTasks').filter(x => !x.done);
  const sNotes = db.all('shadowNotes');
  if (sTasks.length || sNotes.length) {
    L.push(`\n## Shadow (работа с CEO)`);
    if (sTasks.length) L.push('Открытые задачи от CEO:\n' + sTasks.slice(0, 10).map(x => `- [id ${x.id}] ${cut(x.title, 90)}${x.deadline ? ` · до ${x.deadline}` : ''}${x.priority === 1 ? ' (срочно)' : ''}${x.context ? ` · ${cut(x.context, 120)}` : ''}`).join('\n'));
    const advice = sNotes.filter(n => n.type === 'advice').sort((a, b) => (b.pinned - a.pinned) || (b.date > a.date ? 1 : -1)).slice(0, 10);
    const notes = sNotes.filter(n => n.type === 'note').sort((a, b) => (b.pinned - a.pinned) || (b.date > a.date ? 1 : -1)).slice(0, 10);
    if (advice.length) L.push('Его рекомендации:\n' + advice.map(n => `- ${n.pinned ? '★ ' : ''}${cut(n.title, 80)}${n.body ? `: ${cut(n.body, 160)}` : ''}`).join('\n'));
    if (notes.length) L.push('Наблюдения о нём:\n' + notes.map(n => `- ${n.pinned ? '★ ' : ''}${cut(n.title, 80)}${n.body ? `: ${cut(n.body, 160)}` : ''}`).join('\n'));
  }

  // Люди и обязательства
  const people = db.all('people');
  const comms = db.all('commitments').filter(c => !c.done);
  if (people.length) {
    const lastOf = (id) => { const l = db.where('contacts', c => c.personId === id).map(c => c.date).sort(); return l.length ? l[l.length - 1] : null; };
    L.push(`\n## Люди\n` + people.slice(0, 15).map(p => {
      const mine = comms.filter(c => c.personId === p.id && c.direction === 'mine'), theirs = comms.filter(c => c.personId === p.id && c.direction === 'theirs');
      const last = lastOf(p.id);
      return `- [id ${p.id}] ${cut(p.name, 40)}${p.role ? ` · ${cut(p.role, 40)}` : ''} (${p.type})${last ? ` · последний контакт ${last}` : ' · контактов не было'}${mine.length ? ` · я обещала: ${mine.map(c => `${cut(c.title, 50)}${c.due ? ` до ${c.due}` : ''}`).join('; ')}` : ''}${theirs.length ? ` · мне обещали: ${theirs.map(c => `${cut(c.title, 50)}${c.due ? ` до ${c.due}` : ''}`).join('; ')}` : ''}${p.notes ? ` · как работать: ${cut(p.notes, 120)}` : ''}`;
    }).join('\n'));
  }
  const ideas = db.all('ideas').filter(i => i.status !== 'done' && i.status !== 'dropped');
  if (ideas.length) L.push(`\n## Идеи (копилка)\n` + ideas.slice(0, 10).map(i => `- [id ${i.id}] ${cut(i.title, 70)} · ${i.status} · эффект ${i.impact || 2}/3, усилия ${i.effort || 2}/3`).join('\n'));
  const kbSections = db.all('kbSections');
  if (kbSections.length) L.push(`\n## База знаний\n` + kbSections.map(sec => `- ${sec.icon || ''} ${cut(sec.name, 40)}: ${db.where('kbPages', pg => pg.sectionId === sec.id).slice(0, 8).map(pg => cut(pg.title, 40)).join(', ') || 'пусто'}`).join('\n'));

  // Привычки
  const habits = db.all('habits').filter(h => !h.archived);
  if (habits.length) {
    const logs = db.all('habitLogs');
    L.push(`\n## Привычки (выполнение за 7 дней)\n` + habits.map(h => {
      const days = week.filter(d => logs.some(l => l.habitId === h.id && l.date === d && (l.count || 0) >= (h.target || 1))).length;
      const todayDone = logs.some(l => l.habitId === h.id && l.date === t && (l.count || 0) >= (h.target || 1));
      return `- [id ${h.id}] ${h.icon || ''} ${cut(h.name, 50)}: ${days}/7${todayDone ? ', сегодня ✓' : ', сегодня ещё нет'}`;
    }).join('\n'));
  }

  // Дневник
  const journal = db.all('journal').filter(j => two.includes(j.date)).sort((a, b) => b.date > a.date ? 1 : -1).slice(0, 4);
  if (journal.length) L.push(`\n## Рефлексия (последние записи)\n` + journal.map(j => `- ${j.date}${j.mood ? ` · настроение ${j.mood}/5` : ''}${j.highlight ? ` · главное: ${cut(j.highlight, 100)}` : ''}${j.wentWell ? ` · хорошо: ${cut(j.wentWell, 120)}` : ''}${j.improve ? ` · улучшить: ${cut(j.improve, 120)}` : ''}${j.lessons ? ` · урок: ${cut(j.lessons, 100)}` : ''}`).join('\n'));
  const reviews = db.all('weeklyReviews').sort((a, b) => b.weekStart > a.weekStart ? 1 : -1).slice(0, 1);
  if (reviews.length) L.push(`Последний недельный обзор (${reviews[0].weekStart}): победы: ${cut(reviews[0].wins, 150)}; трудности: ${cut(reviews[0].challenges, 150)}; фокус: ${cut(reviews[0].nextFocus, 120)}`);

  // Тело
  const sleep = db.all('sleepLogs').filter(x => week.includes(x.date));
  const checks = db.all('checkins').filter(x => week.includes(x.date));
  const meals = db.all('meals').filter(m => m.date === t);
  const dayLog = db.all('dayLogs').find(d => d.date === t);
  const workouts = db.all('workouts').filter(w => two.includes(w.date));
  const body = [];
  if (sleep.length) body.push(`сон за неделю: в среднем ${avg(sleep, x => x.hours).toFixed(1)} ч при цели ${s.sleepTarget}, качество ${avg(sleep, x => x.quality).toFixed(1)}/5, записей ${sleep.length}`);
  if (checks.length) body.push(`самочувствие за неделю: настроение ${avg(checks, x => x.mood).toFixed(1)}, энергия ${avg(checks, x => x.energy).toFixed(1)}, стресс ${avg(checks, x => x.stress).toFixed(1)}, уверенность ${avg(checks.filter(x => x.confidence), x => x.confidence).toFixed(1)} (из 5)`);
  if (meals.length || dayLog) body.push(`питание сегодня: ${Math.round(meals.reduce((a, m) => a + (m.kcal || 0), 0))} ккал из ${s.kcalTarget}, белок ${Math.round(meals.reduce((a, m) => a + (m.protein || 0), 0))} г из ${s.proteinTarget}, вода ${dayLog?.waterMl || 0} мл из ${s.waterTarget}, шаги ${dayLog?.steps || 0} из ${s.stepsTarget}`);
  body.push(`тренировок за 14 дней: ${workouts.length}${workouts.length ? ` (${workouts.slice(0, 5).map(w => `${w.date} ${cut(w.title || w.type, 30)}`).join(', ')})` : ''}`);
  L.push(`\n## Тело\n` + body.map(b => '- ' + b).join('\n'));

  // Финансы, обучение, книги
  const month = t.slice(0, 7);
  const tx = db.all('transactions').filter(x => String(x.date || '').startsWith(month));
  if (tx.length) {
    const inc = tx.filter(x => x.type === 'income').reduce((a, x) => a + (Number(x.amount) || 0), 0);
    const exp = tx.filter(x => x.type === 'expense').reduce((a, x) => a + (Number(x.amount) || 0), 0);
    const byCat = {}; for (const x of tx) if (x.type === 'expense') byCat[x.category || 'другое'] = (byCat[x.category || 'другое'] || 0) + (Number(x.amount) || 0);
    const top = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, v]) => `${c} ${Math.round(v)}`).join(', ');
    L.push(`\n## Финансы за ${month}\n- доходы ${Math.round(inc)}, расходы ${Math.round(exp)} ${s.currency || ''}; крупнейшие категории: ${top}`);
  }
  const sessions = db.all('studySessions').filter(x => week.includes(x.date));
  const notes = db.all('notes').sort((a, b) => ((b.date || b.createdAt || '') > (a.date || a.createdAt || '') ? 1 : -1)).slice(0, 8);
  const learn = [];
  if (sessions.length || s.learningWeeklyMinutes) learn.push(`обучение за неделю: ${sessions.reduce((a, x) => a + (Number(x.minutes) || 0), 0)} мин из ${s.learningWeeklyMinutes}`);
  if (notes.length) learn.push(`последние заметки (книги, статьи, подкасты): ${notes.map(n => `«${cut(n.title, 50)}»${n.sourceTitle ? ` из «${cut(n.sourceTitle, 30)}»` : ''}${(n.tags || []).length ? ` #${n.tags.slice(0, 3).join(' #')}` : ''}`).join('; ')}`);
  if (learn.length) L.push(`\n## Развитие\n` + learn.map(b => '- ' + b).join('\n'));

  return L.join('\n');
}

// ---------- действия, доступные модели ----------
const TOOLS = [
  { name: 'add_task', description: 'Добавить задачу в список дел пользователя. Если дата не указана — задача попадёт в инбокс без даты. timeless=true — бессрочная задача без дедлайна (отдельный список). Можно привязать к проекту по id из контекста.',
    input_schema: { type: 'object', properties: { title: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD или пусто' }, priority: { type: 'integer', description: '1 важная, 2 обычная, 3 низкая' }, projectId: { type: 'string' }, timeless: { type: 'boolean' } }, required: ['title'] } },
  { name: 'complete_task', description: 'Отметить задачу выполненной по её id из контекста.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'log_habit', description: 'Отметить привычку выполненной сегодня по id привычки из контекста.',
    input_schema: { type: 'object', properties: { habitId: { type: 'string' } }, required: ['habitId'] } },
  { name: 'add_shadow_task', description: 'Записать задачу от CEO в раздел Shadow.',
    input_schema: { type: 'object', properties: { title: { type: 'string' }, deadline: { type: 'string', description: 'YYYY-MM-DD или пусто' }, context: { type: 'string' }, priority: { type: 'integer', description: '1 срочно, 2 обычная, 3 не срочно' } }, required: ['title'] } },
  { name: 'add_shadow_note', description: 'Записать в Shadow рекомендацию CEO (type=advice) или наблюдение о работе с ним (type=note).',
    input_schema: { type: 'object', properties: { type: { type: 'string', enum: ['advice', 'note'] }, title: { type: 'string' }, body: { type: 'string' } }, required: ['type', 'title'] } },
  { name: 'add_project_log', description: 'Добавить запись в журнал проекта по id проекта из контекста. Можно обновить готовность в процентах.',
    input_schema: { type: 'object', properties: { projectId: { type: 'string' }, text: { type: 'string' }, progress: { type: 'integer' } }, required: ['projectId', 'text'] } },
  { name: 'add_goal', description: 'Создать новую цель.',
    input_schema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, horizon: { type: 'string', enum: ['year', 'quarter', 'month'] }, deadline: { type: 'string' }, areaKey: { type: 'string', enum: ['career', 'health', 'learning', 'finance', 'relations', 'personal'] } }, required: ['title'] } },
  { name: 'add_commitment', description: 'Записать обязательство: что я обещала человеку (direction=mine) или что он обещал мне (direction=theirs). personId — из контекста раздела «Люди».',
    input_schema: { type: 'object', properties: { personId: { type: 'string' }, direction: { type: 'string', enum: ['mine', 'theirs'] }, title: { type: 'string' }, due: { type: 'string', description: 'YYYY-MM-DD или пусто' } }, required: ['personId', 'direction', 'title'] } },
  { name: 'log_contact', description: 'Записать контакт с человеком (встреча, созвон, переписка): о чём говорили и следующий шаг. Обновляет дату последнего контакта.',
    input_schema: { type: 'object', properties: { personId: { type: 'string' }, text: { type: 'string' }, next: { type: 'string' }, kind: { type: 'string', enum: ['meeting', 'call', 'chat', 'other'] } }, required: ['personId', 'text'] } },
  { name: 'add_idea', description: 'Записать идею в копилку идей (раздел Заметки → Идеи).',
    input_schema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, impact: { type: 'integer', description: '1-3' }, effort: { type: 'integer', description: '1-3' } }, required: ['title'] } },
  { name: 'add_event', description: 'Добавить событие в календарь: встреча, созвон, тренировка. Время в формате HH:MM, повтор: none|daily|weekdays|weekly|monthly.',
    input_schema: { type: 'object', properties: { title: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' }, time: { type: 'string' }, endTime: { type: 'string' }, place: { type: 'string' }, repeat: { type: 'string', enum: ['none', 'daily', 'weekdays', 'weekly', 'monthly'] } }, required: ['title', 'date'] } },
  { name: 'write_journal', description: 'Записать или дополнить дневник за сегодня. Передавайте только те поля, которые пользователь попросил записать.',
    input_schema: { type: 'object', properties: { highlight: { type: 'string' }, wentWell: { type: 'string' }, improve: { type: 'string' }, gratitude: { type: 'string' }, lessons: { type: 'string' }, mood: { type: 'integer', description: '1-5' } } } },
];

function runTool(name, input) {
  const t = today();
  switch (name) {
    case 'add_task': {
      const rec = db.add('tasks', { title: String(input.title || '').trim(), date: input.timeless ? null : (input.date || null), timeless: !!input.timeless, priority: [1, 2, 3].includes(Number(input.priority)) ? Number(input.priority) : 2, goalId: null, projectId: input.projectId && db.get('projects', input.projectId) ? input.projectId : null, streamId: null, estimateMin: null, notes: '', recurring: null, done: false, doneAt: null });
      return `Задача добавлена: «${rec.title}»${rec.date ? ` на ${rec.date}` : rec.timeless ? ' (бессрочная)' : ' (в инбокс)'}.`;
    }
    case 'complete_task': {
      const x = db.get('tasks', input.id); if (!x) return 'Ошибка: задача с таким id не найдена.';
      db.update('tasks', x.id, { done: true, doneAt: t }); return `Задача «${x.title}» отмечена выполненной.`;
    }
    case 'log_habit': {
      const h = db.get('habits', input.habitId); if (!h) return 'Ошибка: привычка не найдена.';
      const existing = db.all('habitLogs').find(l => l.habitId === h.id && l.date === t);
      if (existing) db.update('habitLogs', existing.id, { count: Math.max(existing.count || 0, h.target || 1) });
      else db.add('habitLogs', { habitId: h.id, date: t, count: h.target || 1 });
      return `Привычка «${h.name}» отмечена на сегодня.`;
    }
    case 'add_shadow_task': {
      const rec = db.add('shadowTasks', { title: String(input.title || '').trim(), context: input.context || '', deadline: input.deadline || null, priority: [1, 2, 3].includes(Number(input.priority)) ? Number(input.priority) : 2, done: false, doneAt: null, result: '', receivedAt: t });
      return `В Shadow записана задача: «${rec.title}»${rec.deadline ? ` до ${rec.deadline}` : ''}.`;
    }
    case 'add_shadow_note': {
      const rec = db.add('shadowNotes', { type: input.type === 'advice' ? 'advice' : 'note', title: String(input.title || '').trim(), body: input.body || '', date: t, tags: [], pinned: false });
      return `${rec.type === 'advice' ? 'Рекомендация' : 'Заметка'} записана: «${rec.title}».`;
    }
    case 'add_project_log': {
      const p = db.get('projects', input.projectId); if (!p) return 'Ошибка: проект не найден.';
      db.update('projects', p.id, (cur) => ({ ...cur, progress: input.progress != null ? Math.max(0, Math.min(100, Number(input.progress) || 0)) : cur.progress, log: [{ id: Date.now().toString(36), date: t, text: String(input.text || '') }, ...(cur.log || [])] }));
      return `В журнал проекта «${p.name}» добавлена запись.`;
    }
    case 'add_goal': {
      const rec = db.add('goals', { title: String(input.title || '').trim(), description: input.description || '', areaKey: input.areaKey || 'personal', horizon: input.horizon || 'quarter', deadline: input.deadline || null, status: 'active', keyResults: [], progress: 0 });
      return `Цель создана: «${rec.title}».`;
    }
    case 'add_commitment': {
      const p = db.get('people', input.personId); if (!p) return 'Ошибка: человек не найден.';
      const rec = db.add('commitments', { personId: p.id, direction: input.direction === 'theirs' ? 'theirs' : 'mine', title: String(input.title || '').trim(), due: input.due || null, notes: '', done: false, doneAt: null });
      return `${rec.direction === 'mine' ? 'Записано обещание' : 'Записано, что обещали'}: «${rec.title}» (${p.name})${rec.due ? ` до ${rec.due}` : ''}.`;
    }
    case 'log_contact': {
      const p = db.get('people', input.personId); if (!p) return 'Ошибка: человек не найден.';
      db.add('contacts', { personId: p.id, date: t, kind: input.kind || 'other', text: String(input.text || '').trim(), next: input.next || '' });
      return `Контакт с ${p.name} записан.`;
    }
    case 'add_idea': {
      const rec = db.add('ideas', { title: String(input.title || '').trim(), body: input.body || '', status: 'new', impact: [1, 2, 3].includes(Number(input.impact)) ? Number(input.impact) : 2, effort: [1, 2, 3].includes(Number(input.effort)) ? Number(input.effort) : 2, tags: [], pinned: false });
      return `Идея записана: «${rec.title}».`;
    }
    case 'add_event': {
      const rec = db.add('events', { title: String(input.title || '').trim(), date: input.date || t, time: input.time || '', endTime: input.endTime || '', place: input.place || '', kind: 'meeting', repeat: input.repeat || 'none', until: '', notes: '' });
      return `Событие добавлено: «${rec.title}» ${rec.date}${rec.time ? ` в ${rec.time}` : ''}${rec.repeat !== 'none' ? ' (с повтором)' : ''}.`;
    }
    case 'write_journal': {
      const fields = ['highlight', 'wentWell', 'improve', 'gratitude', 'lessons'];
      const patch = {}; for (const f of fields) if (input[f]) patch[f] = String(input[f]);
      if (input.mood) patch.mood = Math.max(1, Math.min(5, Number(input.mood)));
      const ex = db.all('journal').find(j => j.date === t);
      if (ex) db.update('journal', ex.id, patch); else db.add('journal', { date: t, wentWell: '', improve: '', gratitude: '', lessons: '', highlight: '', mood: null, ...patch });
      return 'Дневник за сегодня обновлён.';
    }
    default: return 'Неизвестное действие.';
  }
}

// ---------- системный промпт ----------
function systemPrompt(pageId) {
  const s = db.settings();
  return `Ты — личный помощник в приложении ULTIMATE, персональной системе эффективности${s.name ? ` пользователя по имени ${s.name}` : ''}. Разделы приложения: Сегодня, Календарь (события, расписание, все даты), Цели и задачи (с доской визуализации), Проекты (со стримами и задачами), Shadow (работа с CEO: его задачи, рекомендации, наблюдения), Люди (команда, партнёры, обязательства в обе стороны, журнал контактов), База знаний (разделы пользователя), Привычки, Рефлексия (дневник и недельные обзоры), Обучение, Книги, Здоровье, Тренировки, Питание, Сон, Финансы.

Ниже дана выжимка реальных данных пользователя на сегодня. Опирайся только на неё и на то, что пользователь пишет; ничего не выдумывай. Если данных не хватает — скажи, чего именно, и задай один точный вопрос.

Стиль: по-русски, на «ты», коротко и по делу, как опытный коуч и ассистент одновременно. Пользователь любит чемпионский настрой: можно изредка обращаться «чемпион» и заканчивать ответ одной короткой мотивирующей фразой, без пафоса и без повторов. Конкретные советы вместо общих слов. Нумерованные списки для шагов, без воды и без лишних вступлений. Когда уместно — ссылайся на цифры из данных. Если видишь перегруз (много просроченного, мало сна, высокий стресс, низкая уверенность) — скажи об этом прямо и предложи, что убрать.

Для раздела Shadow: помогай готовиться к разговорам с CEO, опираясь на записанные рекомендации и наблюдения; формулируй, как лучше подать вопрос или результат именно этому человеку.

Действия: у тебя есть инструменты для записи в приложение (добавить задачу, отметить выполненной, отметить привычку, записать в Shadow, в журнал проекта, в дневник, создать цель, записать обязательство или контакт с человеком, записать идею, добавить событие в календарь). Используй их, когда пользователь прямо просит что-то записать, добавить или отметить. После действия коротко подтверди, что сделано. Не создавай записи без явной просьбы.

Открыт раздел: ${pageId}.`;
}

// ---------- запрос ----------
function parseSSE(buffer) {
  // возвращает [events, rest]
  const events = []; let rest = buffer;
  let idx;
  while ((idx = rest.indexOf('\n\n')) >= 0) {
    const chunk = rest.slice(0, idx); rest = rest.slice(idx + 2);
    const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
    if (data) { try { events.push(JSON.parse(data)); } catch {} }
  }
  return [events, rest];
}

async function request(messages, pageId, { onText, signal, withFallback = true }) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': cfg.apiKey.trim(),
    'anthropic-version': API_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (cfg.workspaceId) headers['anthropic-workspace-id'] = cfg.workspaceId.trim();
  if (withFallback) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  const body = {
    model: cfg.model || 'claude-opus-5-5',
    max_tokens: 4096,
    system: systemPrompt(pageId) + '\n\n# Данные пользователя\n' + buildContext(pageId),
    messages,
    tools: TOOLS,
    stream: true,
  };
  if (withFallback) body.fallbacks = 'default';
  const r = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!r.ok) {
    let msg = `Ошибка ${r.status}`;
    try { const j = await r.json(); msg = j?.error?.message || msg; } catch {}
    if (withFallback && r.status === 400 && /fallback/i.test(msg)) return request(messages, pageId, { onText, signal, withFallback: false });
    if (r.status === 401) throw new Error('Ключ не принят: проверьте, что он скопирован целиком, и что у аккаунта есть баланс. ' + msg);
    if (r.status === 429) throw new Error('Слишком много запросов подряд, подождите минуту.');
    throw new Error(msg);
  }
  // Собираем ответ из потока
  const content = []; let stopReason = null; let buf = '';
  const reader = r.body.getReader(); const dec = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const [events, rest] = parseSSE(buf); buf = rest;
    for (const ev of events) {
      if (ev.type === 'content_block_start') {
        const b = ev.content_block;
        content[ev.index] = b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, _json: '' } : b.type === 'text' ? { type: 'text', text: '' } : { type: b.type, _skip: true, ...b };
      } else if (ev.type === 'content_block_delta') {
        const blk = content[ev.index]; if (!blk) continue;
        if (ev.delta.type === 'text_delta') { blk.text += ev.delta.text; onText?.(ev.delta.text); }
        else if (ev.delta.type === 'input_json_delta') blk._json += ev.delta.partial_json;
      } else if (ev.type === 'message_delta') {
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
      } else if (ev.type === 'error') {
        throw new Error(ev.error?.message || 'Ошибка потока');
      }
    }
  }
  for (const blk of content) if (blk?.type === 'tool_use') { try { blk.input = JSON.parse(blk._json || '{}'); } catch { blk.input = {}; } delete blk._json; }
  return { content: content.filter(b => b && !b._skip), stopReason };
}

// Полный цикл: текст → (действия → результаты → снова запрос)* → ответ.
export async function ask(userText, { pageId = 'today', onText, onAction, signal } = {}) {
  if (!aiReady()) throw new Error('Сначала вставьте ключ Claude в Настройках.');
  const msgs = [...history.filter(m => m.role === 'user' || m.role === 'assistant').slice(-12).map(m => ({ role: m.role, content: m.text })), { role: 'user', content: userText }];
  history.push({ role: 'user', text: userText, at: Date.now() });
  let full = '';
  const actions = [];
  for (let round = 0; round < 6; round++) {
    const { content, stopReason } = await request(msgs, pageId, { onText: (tx) => { full += tx; onText?.(tx); }, signal });
    if (stopReason === 'refusal') { full += '\n\n(Запрос отклонён системой безопасности модели.)'; onText?.('\n\n(Запрос отклонён системой безопасности модели.)'); break; }
    const toolUses = content.filter(b => b.type === 'tool_use');
    if (stopReason !== 'tool_use' || !toolUses.length) break;
    msgs.push({ role: 'assistant', content });
    const results = toolUses.map(tu => {
      let out;
      try { out = runTool(tu.name, tu.input || {}); } catch (e) { out = 'Ошибка: ' + (e.message || e); }
      actions.push({ name: tu.name, result: out });
      onAction?.(out);
      return { type: 'tool_result', tool_use_id: tu.id, content: out, is_error: /^Ошибка/.test(out) };
    });
    msgs.push({ role: 'user', content: results });
  }
  history.push({ role: 'assistant', text: full.trim(), actions, at: Date.now() });
  saveHistory();
  return { text: full.trim(), actions };
}

export async function testKey() {
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey.trim(), 'anthropic-version': API_VERSION, 'anthropic-dangerous-direct-browser-access': 'true', ...(cfg.workspaceId ? { 'anthropic-workspace-id': cfg.workspaceId.trim() } : {}) },
    body: JSON.stringify({ model: cfg.model || 'claude-opus-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'Ответь одним словом: готов?' }] }),
  });
  if (r.ok) return true;
  let msg = `Ошибка ${r.status}`; try { const j = await r.json(); msg = j?.error?.message || msg; } catch {}
  throw new Error(msg);
}

// Подсказки по разделам для панели
export function quickPrompts(pageId) {
  const map = {
    today: ['Собери план на сегодня', 'Что сейчас важнее всего?', 'Что я упускаю на этой неделе?'],
    calendar: ['Что у меня на этой неделе?', 'Где в расписании окна для глубокой работы?', 'Что перенести, чтобы разгрузить неделю?'],
    goals: ['Где я буксую по целям?', 'Разбей главную цель на шаги', 'Какие цели конфликтуют между собой?'],
    projects: ['Какие риски по проектам?', 'Следующий шаг для каждого проекта', 'Что просрочено и что с этим делать?'],
    shadow: ['Как лучше зайти к CEO с вопросом?', 'Что я знаю о его стиле: сведи в 5 правил', 'Какие его задачи горят?'],
    habits: ['Какие привычки сыпятся и почему?', 'Предложи перестроить привычки под мою неделю'],
    journal: ['Разбери мои последние записи', 'Подведи итоги недели', 'Какие паттерны в настроении?'],
    health: ['Что видно по самочувствию за неделю?', 'Что поменять, чтобы было больше энергии?'],
    sleep: ['Как улучшить сон по моим данным?', 'Сколько я недосыпаю?'],
    nutrition: ['Что добить по питанию сегодня?', 'Как добрать белок?'],
    workouts: ['Оцени мою активность за 2 недели', 'Составь план тренировок на неделю'],
    finance: ['Куда уходят деньги в этом месяце?', 'Где можно сократить расходы?'],
    learning: ['Как распределить учёбу на неделю?'],
    notes: ['Какие идеи из заметок стоит применить на этой неделе?', 'Сведи мои заметки по теме в выводы'],
    people: ['Кому я давно не писала и что обещала?', 'Какие обещания горят на этой неделе?', 'Как построить разговор с этим человеком?'],
    kb: ['Чего не хватает в базе знаний по моей роли?', 'Собери оглавление для нового раздела'],
  };
  return map[pageId] || ['Что мне стоит сделать сегодня?', 'Дай три совета по моей ситуации'];
}
