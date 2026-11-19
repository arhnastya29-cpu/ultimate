// Раздел «План»: Сегодня · Неделя · Все задачи · Цели. Один источник правды — model.js
// (agendaOn, toggleTask, addTask, goalProgress). Календарь и цели живут в calendar.js и goals.js
// как модули-помощники; этот файл собирает вкладки, шапку и общие обработчики.
import { db } from '../db.js';
import { esc, icon, toast, on, today, addDays, fmtDate, fmtMinutes, plural, tabs, pageMenu, statLine, emptyAction, sortBy, sum } from '../ui.js';
import { agendaOn, toggleTask, addTask, isMine, spawnNextRecurring, overdueItems, doneOn } from '../model.js';
import { openTaskModal } from './task-modal.js';
import { cheer } from '../motivation.js';
import { renderCalendarTab, bindCalendarTab, openEventModal, calendarNav, agendaRow, toItem, weekStrip } from './calendar.js';
import { renderGoalsTab, bindGoalsTab, openGoalModal, openWeeklyReviewModal } from './goals.js';

export const title = 'План';

const TAB_IDS = ['today', 'week', 'all', 'goals'];
const FILTERS = [['all', 'Все'], ['with', 'С проектом'], ['without', 'Без проекта'], ['people', 'От CEO / с людьми']];

// ---------- состояние (помним между открытиями раздела) ----------
let tab = 'today';
let day = today();
let filter = 'all';
const accOpen = { overdue: false, summary: false, done: false };

const pri = (x) => x.priority || 2;
const byPriority = (list) => sortBy(list, x => `${pri(x)}${x.time || '~'}`);

// Разбор быстрого ввода: «! купить билеты завтра» → важная задача на завтра.
function parseQuick(raw, d) {
  let title = raw.trim(); let priority = 2; let date = d; let timeless = false;
  if (title.startsWith('!')) { priority = 1; title = title.slice(1).trim(); }
  if (/\s+завтра$/i.test(title)) { date = addDays(d, 1); title = title.replace(/\s+завтра$/i, ''); }
  else if (/\s+послезавтра$/i.test(title)) { date = addDays(d, 2); title = title.replace(/\s+послезавтра$/i, ''); }
  else if (/\s+инбокс$/i.test(title)) { date = null; title = title.replace(/\s+инбокс$/i, ''); }
  else if (/\s+бессрочно$/i.test(title)) { date = null; timeless = true; title = title.replace(/\s+бессрочно$/i, ''); }
  return { title, priority, date, timeless };
}
const matchFilter = (t) => filter === 'with' ? !!t.projectId : filter === 'without' ? !t.projectId : filter === 'people' ? !!t.personId : true;

// Адрес отражает вкладку и день, но без перерисовки (replaceState не вызывает hashchange).
function syncHash() {
  const p = new URLSearchParams({ tab });
  if (day !== today()) p.set('date', day);
  try { history.replaceState(null, '', `#/plan?${p}`); } catch {}
}

function doToggle(id) {
  const x = db.get('tasks', id); if (!x) return;
  const wasDone = x.done;
  toggleTask(id);
  if (wasDone) return;
  const c = cheer(); if (c) toast(c);
  const next = spawnNextRecurring(db.get('tasks', id));
  if (next) toast(`Следующий повтор: ${fmtDate(next.date)}`);
}

// ---------- список дня (общий для «Сегодня» и недели на телефоне) ----------
const trailMoveToday = (id) => `<button type="button" class="btn sm secondary" data-action="move-today" data-id="${esc(id)}">→ сегодня</button>`;

export function dayList(d) {
  const t = today();
  const items = agendaOn(d).filter(i => (i.type !== 'task' && i.type !== 'waiting') || matchFilter(i.data));
  const events = items.filter(i => i.type === 'event');
  const other = items.filter(i => i.type === 'deadline' || i.type === 'health');
  const tasks = items.filter(i => i.type === 'task' && !i.done);
  const waiting = items.filter(i => i.type === 'waiting' && !i.done);
  const main = [...events, ...other, ...tasks];
  if (!main.length && !waiting.length) {
    const hidden = filter !== 'all' && agendaOn(d).some(i => !i.done);
    return emptyAction({
      text: hidden ? 'По этому фильтру на день ничего нет' : d === t ? 'На сегодня ничего не запланировано' : `На ${fmtDate(d, { weekday: true }).toLowerCase()} ничего не запланировано`,
      action: 'new-task', label: 'Добавить задачу', second: { action: 'new-event', label: 'Событие' },
    });
  }
  return `${main.length ? `<div class="list">${main.map(i => agendaRow(i)).join('')}</div>` : ''}
    ${waiting.length ? `<div class="section-title" style="margin-top:12px"><h2 class="small">Жду от других</h2><span class="tiny muted">${waiting.length}</span></div>
    <div class="list">${waiting.map(i => agendaRow(i)).join('')}</div>` : ''}`;
}

// ---------- вкладка «Сегодня» ----------
function renderTodayTab() {
  const t = today();
  const all = db.all('tasks');
  const od = overdueItems();
  const overdue = day === t ? sortBy(od.tasks.filter(matchFilter), x => x.date) : [];
  const dayTasks = all.filter(x => x.date === day && isMine(x) && matchFilter(x));
  const open = dayTasks.filter(x => !x.done);
  // Сделанное за день: задачи этого дня плюс задачи без даты, закрытые в этот день.
  const done = sortBy(all.filter(x => x.done && isMine(x) && matchFilter(x) && (x.date === day || (!x.date && doneOn(x, day)))), x => x.doneAt || '', true);
  const minutes = sum([...open, ...overdue], x => x.estimateMin);
  const nTasks = open.length + done.length;
  const stats = statLine([
    nTasks ? `${nTasks} ${plural(nTasks, 'задача', 'задачи', 'задач')}${done.length ? ` · сделано ${done.length}` : ''}` : '',
    minutes ? fmtMinutes(minutes) : '',
    od.tasks.length ? [`${od.tasks.length} просрочено`, 'bad'] : '',
    od.waiting.length ? [`${od.waiting.length} ждут ответа`, 'warn'] : '',
  ], 'plan-stats');
  return `
    ${weekStrip(day)}
    <div class="card" data-block="day" data-block-title="Список дня">
      ${overdue.length ? `<details class="acc plan-overdue" data-acc="overdue" ${accOpen.overdue ? 'open' : ''}>
        <summary><span class="bad">Просрочено</span><span class="pill bad">${overdue.length}</span></summary>
        <div class="list" style="margin:6px 0 8px">${overdue.map(x => agendaRow(toItem(x), { showDate: true, trail: trailMoveToday(x.id) })).join('')}</div>
        <div style="margin:0 0 14px"><button type="button" class="link" data-action="move-all">Перенести все на сегодня</button></div>
      </details>` : ''}
      ${dayList(day)}
    </div>
    <form class="card quick-add plan-quick" data-quick data-block="quick" data-block-title="Быстрое добавление">
      <input class="input grow" name="title" placeholder="Добавить задачу на ${esc(fmtDate(day).toLowerCase())}…  «!» — важная, «завтра», «бессрочно»" autocomplete="off" aria-label="Новая задача">
      <button class="icon-btn primary" type="submit" aria-label="Добавить">${icon('plus')}</button>
    </form>
    <div class="chips plan-filters" data-block="filters" data-block-title="Фильтры">${FILTERS.map(([v, l]) => `<button type="button" class="chip ${filter === v ? 'active' : ''}" data-action="filter" data-filter="${v}" aria-pressed="${filter === v}">${l}</button>`).join('')}</div>
    ${stats || done.length ? `<details class="acc card plan-summary" data-acc="summary" data-block="summary" data-block-title="Сводка и сделанное" ${accOpen.summary ? 'open' : ''}>
      <summary>Сводка${done.length ? ` · сделано ${done.length}` : ''}</summary>
      <div style="margin-top:10px">${stats}${done.length ? `<div class="list">${done.map(x => agendaRow(toItem(x))).join('')}</div>` : '<div class="tiny faint">Сделанных задач за этот день пока нет</div>'}</div>
    </details>` : ''}`;
}

// ---------- вкладка «Все задачи» ----------
function renderAllTab() {
  const t = today();
  const all = db.all('tasks');
  if (!all.length) return emptyAction({ text: 'Задачи — всё, что нужно сделать: с датой, в инбоксе без даты или бессрочно', action: 'new-task', label: 'Добавить задачу' });
  const open = all.filter(x => !x.done);
  const mine = open.filter(isMine);
  const inbox = byPriority(mine.filter(x => !x.date && !x.timeless));
  const timeless = byPriority(mine.filter(x => !x.date && x.timeless));
  const overdue = sortBy(mine.filter(x => x.date && x.date < t), x => x.date);
  const dated = sortBy(mine.filter(x => x.date && x.date >= t), x => `${x.date}${x.time || '~'}${pri(x)}`);
  const tomorrow = addDays(t, 1), weekEnd = addDays(t, 6);
  const groups = [
    ['Сегодня', dated.filter(x => x.date === t), false],
    ['Завтра', dated.filter(x => x.date === tomorrow), false],
    ['На неделе', dated.filter(x => x.date > tomorrow && x.date <= weekEnd), true],
    ['Позже', dated.filter(x => x.date > weekEnd), true],
  ];
  const waiting = sortBy(open.filter(x => !isMine(x)), x => x.date || '9999');
  const done = sortBy(all.filter(x => x.done), x => x.doneAt || '', true).slice(0, 50);
  const section = (title, list, { id, showDate = false, trail = null, hint = '' } = {}) => list.length ? `<div class="card" data-block="${id}" data-block-title="${esc(title)}">
      <div class="section-title"><h2>${esc(title)}</h2><span class="tiny muted">${list.length}</span></div>
      <div class="list">${list.map(x => agendaRow(toItem(x), { showDate, trail: trail ? trail(x) : '' })).join('')}</div>
      ${hint ? `<div class="tiny faint" style="margin-top:8px">${hint}</div>` : ''}
    </div>` : '';
  const stats = statLine([
    mine.length ? `${mine.length} ${plural(mine.length, 'открытая', 'открытые', 'открытых')}` : '',
    inbox.length ? `${inbox.length} в инбоксе` : '',
    waiting.length ? `${waiting.length} жду от других` : '',
    overdue.length ? [`${overdue.length} просрочено`, 'bad'] : '',
  ]);
  return `${stats}
    ${section('Просрочено', overdue, { id: 'overdue', showDate: true, trail: x => trailMoveToday(x.id) })}
    ${section('Инбокс', inbox, { id: 'inbox', trail: x => `<span class="row" style="gap:4px"><button type="button" class="btn sm secondary" data-action="schedule" data-id="${esc(x.id)}">→ ${esc(fmtDate(day).toLowerCase())}</button><button type="button" class="icon-btn sm" data-action="timeless" data-id="${esc(x.id)}" aria-label="Сделать бессрочной" data-tip="Бессрочно">∞</button></span>`, hint: 'Без даты. Назначьте день или сделайте бессрочной' })}
    ${groups.map(([title, list, showDate]) => section(title, list, { id: 'g-' + title, showDate })).join('')}
    ${section('Бессрочные', timeless, { id: 'timeless', trail: x => `<button type="button" class="btn sm secondary" data-action="schedule" data-id="${esc(x.id)}">→ ${esc(fmtDate(day).toLowerCase())}</button>`, hint: 'Без дедлайна: то, что хочется сделать, но не к дате' })}
    ${section('Жду от других', waiting, { id: 'waiting', showDate: true })}
    ${!mine.length && !waiting.length ? `<div class="tiny faint" style="padding:6px 0 12px">Открытых задач нет</div>` : ''}
    ${done.length ? `<details class="acc card" data-acc="done" data-block="done" data-block-title="Сделано" ${accOpen.done ? 'open' : ''}>
      <summary>Сделано <span class="pill">${all.filter(x => x.done).length}</span></summary>
      <div class="list" style="margin-top:8px">${done.map(x => agendaRow(toItem(x), { trail: `<span class="tiny muted" style="white-space:nowrap">${esc(fmtDate(String(x.doneAt || '').slice(0, 10)))}</span>` })).join('')}</div>
    </details>` : ''}`;
}

// ---------- страница ----------
export async function render(root, { params = {}, navigate } = {}) {
  if (params.tab && TAB_IDS.includes(params.tab)) tab = params.tab;
  if (params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date)) day = params.date;
  const t = today();
  const rerender = () => { syncHash(); render(root, { params: {}, navigate }); };
  const tasksAll = db.all('tasks');
  const nToday = tasksAll.filter(x => x.date === t && !x.done && isMine(x)).length;
  const nAll = tasksAll.filter(x => !x.done && isMine(x)).length;
  const nGoals = db.all('goals').filter(g => g.status === 'active').length;
  const mainBtn = tab === 'week'
    ? `<button type="button" class="btn" data-action="new-event">${icon('plus')} Событие</button>`
    : `<button type="button" class="btn" data-action="new-task">${icon('plus')} Задача</button>`;
  const menu = pageMenu([
    tab === 'week' ? { label: 'Новая задача', action: 'new-task', icon: 'plus' } : { label: 'Новое событие', action: 'new-event', icon: 'calendar' },
    { label: 'Новая цель', action: 'new-goal', icon: 'target' },
    { label: 'Недельный обзор', action: 'weekly', icon: 'edit' },
    { label: 'Настроить страницу', action: 'customize', icon: 'sliders' },
  ]);
  const body = tab === 'today' ? renderTodayTab()
    : tab === 'week' ? renderCalendarTab({ cursor: day, dayList })
    : tab === 'all' ? renderAllTab()
    : renderGoalsTab();

  root.innerHTML = `<div class="plan-page">
    <div class="page-head">
      <div><div class="eyebrow">Основное</div><h1>План</h1></div>
      <div class="actions">${mainBtn}${menu}</div>
    </div>
    ${tabs([['today', 'Сегодня', nToday || ''], ['week', 'Неделя'], ['all', 'Все задачи', nAll || ''], ['goals', 'Цели', nGoals || '']], tab, 'data-tab')}
    <div class="plan-tab plan-tab-${esc(tab)}">${body}</div>
  </div>`;
  const view = root.firstElementChild;

  on(view, 'click', '[data-tab]', (e, b) => { tab = b.dataset.tab; rerender(); });
  on(view, 'click', '[data-nav]', (e, b) => {
    const n = Number(b.dataset.nav);
    day = tab === 'week' ? calendarNav(day, n) : n === 0 ? today() : addDays(day, 7 * n);
    rerender();
  });
  on(view, 'click', '[data-pick-day]', (e, b) => { day = b.dataset.pickDay; rerender(); });
  on(view, 'click', '[data-action]', (e, b) => {
    const a = b.dataset.action, id = b.dataset.id;
    switch (a) {
      case 'new-task': openTaskModal(null, { defaults: { date: day } }); break;
      case 'new-event': openEventModal(null, day); break;
      case 'new-goal': openGoalModal(null); break;
      case 'weekly': openWeeklyReviewModal(); break;
      case 'toggle': doToggle(id); break;
      case 'edit': { const x = db.get('tasks', id); if (x) openTaskModal(x); break; }
      case 'event': { const ev = db.get('events', id); if (ev) openEventModal(ev); break; }
      case 'go': { let p = {}; try { p = JSON.parse(b.dataset.params || '{}'); } catch {} navigate(b.dataset.page, p); break; }
      case 'move-today': db.update('tasks', id, { date: today() }); break;
      case 'schedule': db.update('tasks', id, { date: day, timeless: false }); break;
      case 'timeless': db.update('tasks', id, { date: null, timeless: true }); break;
      case 'move-all': {
        const list = overdueItems().tasks;
        for (const x of list) db.update('tasks', x.id, { date: today() });
        toast(`Перенесено: ${list.length}`);
        break;
      }
      case 'filter': filter = b.dataset.filter || 'all'; rerender(); break;
      default: break;
    }
  });
  // Строки списка открываются и с клавиатуры.
  view.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest('[data-action][tabindex], [data-day][tabindex]');
    if (!el || e.target !== el) return;
    e.preventDefault(); el.click();
  });
  on(view, 'submit', 'form[data-quick]', (e, form) => {
    e.preventDefault();
    const { title: tt, priority, date, timeless } = parseQuick(form.title.value, day);
    if (!tt) return;
    addTask({ title: tt, date, priority, timeless });
    toast(date === t ? 'Задача на сегодня добавлена' : date ? `Задача на ${fmtDate(date).toLowerCase()}` : timeless ? 'Бессрочная задача добавлена' : 'Задача в инбоксе');
  });
  view.querySelectorAll('details[data-acc]').forEach(d => d.addEventListener('toggle', () => { accOpen[d.dataset.acc] = d.open; }));

  if (tab === 'week') bindCalendarTab(view, { setDay: (d) => { day = d; }, rerender });
  if (tab === 'goals') bindGoalsTab(view, rerender);
}
