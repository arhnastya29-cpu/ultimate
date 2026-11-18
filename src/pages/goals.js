import { db, uid } from '../db.js';
import {
  esc, icon, modal, field, formRow, formData, toast, on,
  today, addDays, fmtDate, fmtMinutes, daysBetween, startOfWeek, dateNav,
  checkBtn, progressBar, emptyState, sortBy, sum, clamp, plural,
} from '../ui.js';

import { renderVision, bindVision } from './vision.js';
import { openTaskModal } from './task-modal.js';

export const title = 'Цели и задачи';

// ---------- Локальное состояние страницы ----------
let tab = 'tasks';        // 'tasks' | 'goals' | 'vision'
let day = today();        // выбранный день во вкладке задач
let horizon = 'all';      // фильтр целей: all | year | quarter | month
let showDone = false;     // показывать завершённые цели
let inboxOpen = false;    // раскрыт ли инбокс
let projFilter = 'all';   // фильтр задач: all | with | without (с проектом / без)

// ---------- Справочники ----------
const AREAS = { career: 'Карьера', health: 'Здоровье', learning: 'Обучение', finance: 'Финансы', relations: 'Отношения', personal: 'Личное' };
const HORIZONS = { year: 'Год', quarter: 'Квартал', month: 'Месяц' };
const STATUSES = { active: 'Активна', done: 'Завершена', paused: 'На паузе' };
const PRIORITY = { 1: ['важно', 'bad'], 2: ['средне', 'warn'], 3: ['низко', ''] };

const AREA_OPTIONS = Object.entries(AREAS);
const HORIZON_OPTIONS = Object.entries(HORIZONS);
const STATUS_OPTIONS = Object.entries(STATUSES);
const PRIORITY_OPTIONS = [[1, 'Важная'], [2, 'Обычная'], [3, 'Низкая']];

const dayWord = (n) => plural(n, 'день', 'дня', 'дней');

// ---------- Вычисления ----------
function goalProgress(g) {
  const krs = g.keyResults || [];
  if (krs.length) return Math.round(krs.filter(k => k.done).length / krs.length * 100);
  return clamp(Math.round(Number(g.progress) || 0), 0, 100);
}

function priPill(p) {
  const [label, cls] = PRIORITY[p] || PRIORITY[2];
  return `<span class="pill ${cls}">${label}</span>`;
}

// ---------- Мутации ----------
function toggleTask(id) {
  const x = db.get('tasks', id);
  if (!x) return;
  if (x.done) { db.update('tasks', id, { done: false, doneAt: null }); return; }
  db.update('tasks', id, { done: true, doneAt: day });
  if (x.recurring === 'daily' || x.recurring === 'weekly') {
    const step = x.recurring === 'daily' ? 1 : 7;
    const t = today();
    let next = addDays(x.date || day, step);
    let guard = 0;
    while (next < t && guard++ < 400) next = addDays(next, step);
    db.add('tasks', {
      title: x.title, date: next, priority: x.priority || 2, goalId: x.goalId || null,
      notes: x.notes || '', estimateMin: x.estimateMin ?? null, recurring: x.recurring,
      done: false, doneAt: null,
    });
    toast(`Следующий повтор: ${fmtDate(next)}`);
  }
}

function toggleKR(goalId, krId) {
  db.update('goals', goalId, (g) => ({
    keyResults: (g.keyResults || []).map(k => k.id === krId ? { ...k, done: !k.done } : k),
  }));
}

function addKR(goalId) {
  const text = prompt('Ключевой результат (измеримый итог):');
  if (!text || !text.trim()) return;
  db.update('goals', goalId, (g) => ({
    keyResults: [...(g.keyResults || []), { id: uid(), title: text.trim(), done: false }],
  }));
}

function removeKR(goalId, krId) {
  if (!confirm('Удалить ключевой результат?')) return;
  db.update('goals', goalId, (g) => ({ keyResults: (g.keyResults || []).filter(k => k.id !== krId) }));
}

// ---------- Модалки ----------
function openGoalModal(goal) {
  const isNew = !goal;
  const g = goal || { title: '', description: '', areaKey: 'personal', horizon: 'quarter', deadline: null, status: 'active', progress: 0, keyResults: [] };
  const krs = g.keyResults || [];
  const hasKR = krs.length > 0;
  modal({
    title: isNew ? 'Новая цель' : 'Цель',
    body: `<div class="form">
      ${field({ name: 'title', label: 'Цель', value: g.title, required: true, placeholder: 'Чего хочу достичь' })}
      ${field({ name: 'description', label: 'Описание', type: 'textarea', value: g.description || '', rows: 3, placeholder: 'Зачем это и как пойму, что достиг' })}
      ${formRow(
        field({ name: 'areaKey', label: 'Сфера', type: 'select', value: g.areaKey || 'personal', options: AREA_OPTIONS }),
        field({ name: 'horizon', label: 'Горизонт', type: 'select', value: g.horizon || 'quarter', options: HORIZON_OPTIONS }),
      )}
      ${formRow(
        field({ name: 'deadline', label: 'Дедлайн', type: 'date', value: g.deadline || '' }),
        field({ name: 'status', label: 'Статус', type: 'select', value: g.status || 'active', options: STATUS_OPTIONS }),
      )}
      ${hasKR
        ? `<div class="hint muted tiny">Прогресс считается по ключевым результатам: выполнено ${krs.filter(k => k.done).length} из ${krs.length}.</div>`
        : field({ name: 'progress', label: 'Прогресс, %', type: 'number', value: g.progress ?? 0, min: 0, max: 100, step: 5, hint: 'Ручной прогресс; добавьте ключевые результаты в карточке, чтобы считать автоматически' })}
    </div>`,
    onSubmit: (d) => {
      const patch = {
        title: d.title, description: d.description || '', areaKey: d.areaKey || 'personal',
        horizon: d.horizon || 'quarter', deadline: d.deadline || null, status: d.status || 'active',
      };
      if (!hasKR) patch.progress = clamp(Number(d.progress) || 0, 0, 100);
      if (isNew) { db.add('goals', { ...patch, keyResults: [], progress: patch.progress ?? 0 }); toast('Цель добавлена'); }
      else { db.update('goals', g.id, patch); toast('Цель сохранена'); }
    },
    onDelete: isNew ? undefined : () => {
      for (const x of db.where('tasks', x => x.goalId === g.id)) db.update('tasks', x.id, { goalId: null });
      db.remove('goals', g.id);
      toast('Цель удалена');
    },
  });
}

function openWeeklyReviewModal(weekStart) {
  const ex = db.all('weeklyReviews').find(r => r.weekStart === weekStart) || null;
  modal({
    title: `Обзор недели с ${fmtDate(weekStart, { relative: false, year: true })}`,
    body: `<div class="form">
      ${field({ name: 'wins', label: 'Победы недели', type: 'textarea', value: ex?.wins || '', rows: 3, placeholder: 'Что получилось и чем горжусь' })}
      ${field({ name: 'challenges', label: 'Сложности', type: 'textarea', value: ex?.challenges || '', rows: 3, placeholder: 'Что мешало, где буксовал' })}
      ${field({ name: 'nextFocus', label: 'Фокус на следующую неделю', type: 'textarea', value: ex?.nextFocus || '', rows: 2, placeholder: '1–3 главных приоритета' })}
      ${field({ name: 'rating', label: 'Оценка недели', type: 'rating', value: ex?.rating ?? '', hint: '1 — провальная, 5 — отличная' })}
    </div>`,
    onSubmit: (d) => {
      const data = { weekStart, wins: d.wins || '', challenges: d.challenges || '', nextFocus: d.nextFocus || '', rating: d.rating ?? null };
      if (ex) db.update('weeklyReviews', ex.id, data); else db.add('weeklyReviews', data);
      toast('Обзор недели сохранён');
    },
    onDelete: ex ? () => { db.remove('weeklyReviews', ex.id); toast('Обзор удалён'); } : undefined,
  });
}

// ---------- Фрагменты разметки ----------
function taskRow(x, goalById, { overdue = false, inbox = false } = {}) {
  const g = x.goalId ? goalById(x.goalId) : null;
  const p = x.projectId ? db.get('projects', x.projectId) : null;
  const sub = [
    priPill(x.priority),
    p ? `<a class="pill accent ellipsis" style="max-width:180px" href="#/projects?id=${esc(p.id)}" title="Открыть проект">${esc(p.name)}</a>` : '<span class="tag faint">без проекта</span>',
    g ? `<span class="tag ellipsis" style="max-width:160px">${esc(g.title)}</span>` : '',
    x.estimateMin ? `<span>${esc(fmtMinutes(x.estimateMin))}</span>` : '',
    x.recurring ? `<span title="Повторяется">↻ ${x.recurring === 'daily' ? 'ежедневно' : 'еженедельно'}</span>` : '',
    overdue ? `<span class="bad">${esc(fmtDate(x.date, { relative: false }))}</span>` : '',
  ].filter(Boolean).join('');
  let action = '';
  if (overdue) action = `<button class="btn sm secondary" data-action="move-today" data-id="${esc(x.id)}">→ сегодня</button>`;
  else if (inbox) action = `<button class="btn sm secondary" data-action="schedule" data-id="${esc(x.id)}">→ ${esc(fmtDate(day))}</button>`;
  return `<div class="list-item">
    ${checkBtn(!!x.done, `data-action="toggle" data-id="${esc(x.id)}" aria-label="Выполнено"`)}
    <div class="main">
      <div class="title ${x.done ? 'strike' : ''}" data-action="edit" data-id="${esc(x.id)}" style="cursor:pointer">${esc(x.title)}</div>
      <div class="sub row wrap" style="gap:6px">${sub}</div>
    </div>
    ${action}
  </div>`;
}

function weeklyCard() {
  const ws = startOfWeek();
  const rev = db.all('weeklyReviews').find(r => r.weekStart === ws) || null;
  const text = rev
    ? (rev.wins ? esc(rev.wins) : 'Обзор заполнен, но победы не записаны.')
    : `Неделя с ${esc(fmtDate(ws, { relative: false }))}. Подведите итоги: победы, сложности и фокус на следующую неделю.`;
  return `<div class="card">
    <div class="row between"><h3 style="margin:0">Недельный обзор</h3>${rev && rev.rating ? `<span class="pill accent">${Number(rev.rating)}/5</span>` : ''}</div>
    <p class="small muted" style="margin:6px 0 10px;white-space:pre-line">${text}</p>
    <button class="btn secondary sm" data-action="weekly">${icon('edit')} ${rev ? 'Изменить обзор' : 'Заполнить обзор'}</button>
  </div>`;
}

function renderTasks(tasks, goalById, t) {
  if (projFilter === 'with') tasks = tasks.filter(x => !!x.projectId);
  else if (projFilter === 'without') tasks = tasks.filter(x => !x.projectId);
  const open = tasks.filter(x => !x.done);
  const dayTasks = sortBy(open.filter(x => x.date === day), x => x.priority || 2);
  const overdueAll = sortBy(open.filter(x => x.date && x.date < t), x => x.date);
  const overdue = day === t ? overdueAll : [];
  const inbox = sortBy(open.filter(x => !x.date), x => x.priority || 2);
  const done = tasks.filter(x => x.done && String(x.doneAt || '').slice(0, 10) === day);
  const total = dayTasks.length + done.length;
  const planMin = sum([...dayTasks, ...overdue], x => x.estimateMin);
  const row = (x, o) => taskRow(x, goalById, o);

  return `
    <div class="row between wrap" style="margin-bottom:14px;gap:10px">${dateNav(day)}
      <div class="seg">
        <button type="button" class="${projFilter === 'all' ? 'active' : ''}" data-action="proj-filter" data-filter="all">Все</button>
        <button type="button" class="${projFilter === 'with' ? 'active' : ''}" data-action="proj-filter" data-filter="with">С проектом</button>
        <button type="button" class="${projFilter === 'without' ? 'active' : ''}" data-action="proj-filter" data-filter="without">Без проекта</button>
      </div>
    </div>
    <div class="grid-3" style="margin-bottom:12px">
      <div class="stat">
        <div class="label">Сделано</div>
        <div class="value">${done.length}<small>/ ${total}</small></div>
        <div class="sub">${total ? `${Math.round(done.length / total * 100)}% задач дня` : 'задач на день нет'}</div>
      </div>
      <div class="stat">
        <div class="label">План</div>
        <div class="value">${planMin ? esc(fmtMinutes(planMin)) : '—'}</div>
        <div class="sub">по оценкам открытых задач</div>
      </div>
      <div class="stat">
        <div class="label">Просрочено</div>
        <div class="value ${overdueAll.length ? 'bad' : ''}">${overdueAll.length}</div>
        <div class="sub">${overdueAll.length ? 'ждут переноса' : 'всё в срок'}</div>
      </div>
    </div>
    <form class="card row wrap" data-quick style="gap:8px;margin-bottom:12px">
      <input class="input grow" name="title" placeholder="Новая задача на ${esc(fmtDate(day).toLowerCase())}…" required autocomplete="off" style="min-width:180px">
      <select class="input" name="priority" style="width:auto">
        <option value="2">Обычная</option><option value="1">Важная</option><option value="3">Низкая</option>
      </select>
      <button class="btn" type="submit">${icon('plus')} Добавить</button>
    </form>
    <div class="grid-2" style="align-items:start">
      <div class="stack">
        <div class="card">
          <div class="section-title"><h2>На день</h2><span class="tiny muted">${dayTasks.length}</span></div>
          ${dayTasks.length ? `<div class="list">${dayTasks.map(x => row(x)).join('')}</div>` : emptyState('На этот день задач нет', '🗓️')}
        </div>
        ${overdue.length ? `<div class="card">
          <div class="section-title"><h2 class="bad">Просрочено</h2><button class="link" data-action="move-all">Перенести все на сегодня</button></div>
          <div class="list">${overdue.map(x => row(x, { overdue: true })).join('')}</div>
        </div>` : ''}
      </div>
      <div class="stack">
        <div class="card">
          <details class="acc" data-inbox ${inboxOpen ? 'open' : ''}>
            <summary>Без даты / инбокс <span class="pill">${inbox.length}</span></summary>
            <div style="margin-top:8px">
              ${inbox.length ? `<div class="list">${inbox.map(x => row(x, { inbox: true })).join('')}</div>` : emptyState('Инбокс пуст', '📭')}
            </div>
          </details>
        </div>
        <div class="card">
          <div class="section-title"><h2>Сделано</h2><span class="tiny muted">${done.length}</span></div>
          ${done.length ? `<div class="list">${done.map(x => row(x)).join('')}</div>` : emptyState('Пока ничего не отмечено', '☕')}
        </div>
        ${weeklyCard()}
      </div>
    </div>`;
}

function goalCard(g, tasks, t) {
  const krs = g.keyResults || [];
  const pct = goalProgress(g);
  const openTasks = tasks.filter(x => x.goalId === g.id && !x.done).length;
  const isDone = g.status === 'done';
  let deadlineHtml = '<span class="faint">без срока</span>';
  let late = false;
  if (g.deadline) {
    const n = daysBetween(t, g.deadline);
    late = n < 0 && !isDone;
    const txt = isDone ? 'завершена' : n < 0 ? `просрочено на ${-n} ${dayWord(-n)}` : n === 0 ? 'дедлайн сегодня' : `осталось ${n} ${dayWord(n)}`;
    deadlineHtml = `<span class="${late ? 'bad bold' : 'muted'}">${esc(fmtDate(g.deadline, { relative: false }))} · ${txt}</span>`;
  }
  const barCls = isDone || pct >= 100 ? 'good' : late ? 'bad' : '';
  const krList = krs.length
    ? `<div class="list">${krs.map(k => `<div class="list-item" style="padding:6px 0">
        ${checkBtn(!!k.done, `data-action="toggle-kr" data-id="${esc(g.id)}" data-kr="${esc(k.id)}" aria-label="Выполнено"`)}
        <div class="main small ${k.done ? 'strike' : ''}">${esc(k.title)}</div>
        <button type="button" class="icon-btn sm" data-action="del-kr" data-id="${esc(g.id)}" data-kr="${esc(k.id)}" aria-label="Удалить результат">${icon('x')}</button>
      </div>`).join('')}</div>`
    : `<div class="tiny faint">${g.description ? esc(g.description) : 'Добавьте ключевые результаты — прогресс будет считаться по ним'}</div>`;
  return `<div class="card stack tight" style="opacity:${isDone ? 0.75 : 1}">
    <div class="row between">
      <span class="pill accent">${esc(AREAS[g.areaKey] || 'Личное')}</span>
      <span class="row" style="gap:6px">
        <span class="tag">${esc(HORIZONS[g.horizon] || '')}</span>
        ${g.status && g.status !== 'active' ? `<span class="pill ${isDone ? 'good' : ''}">${esc(STATUSES[g.status] || g.status)}</span>` : ''}
      </span>
    </div>
    <div class="bold" style="font-size:15px;cursor:pointer" data-action="edit-goal" data-id="${esc(g.id)}">${esc(g.title)}</div>
    <div class="tiny">${deadlineHtml}</div>
    <div class="row" style="gap:8px">${progressBar(pct, 100, `grow ${barCls}`)}<span class="tiny bold mono" style="min-width:36px;text-align:right">${pct}%</span></div>
    ${krList}
    <div class="row between">
      <button type="button" class="link" data-action="add-kr" data-id="${esc(g.id)}">+ результат</button>
      <span class="tiny muted">${openTasks ? `открытых задач: ${openTasks}` : 'нет открытых задач'}</span>
    </div>
  </div>`;
}

function renderGoals(goals, tasks, t) {
  let list = showDone ? goals : goals.filter(g => g.status !== 'done');
  if (horizon !== 'all') list = list.filter(g => g.horizon === horizon);
  list = sortBy(list, g => `${g.status === 'done' ? 1 : 0}|${g.deadline || '9999-99-99'}`);
  const chips = [['all', 'Все'], ['year', 'Год'], ['quarter', 'Квартал'], ['month', 'Месяц']]
    .map(([v, l]) => `<button type="button" class="chip ${horizon === v ? 'active' : ''}" data-action="horizon" data-h="${v}">${l}</button>`).join('');
  const activeCount = goals.filter(g => g.status === 'active').length;
  const doneCount = goals.filter(g => g.status === 'done').length;
  return `
    <div class="row between wrap" style="margin-bottom:14px">
      <div class="chips">${chips}</div>
      <button type="button" class="chip ${showDone ? 'active' : ''}" data-action="toggle-done">показать завершённые${doneCount ? ` (${doneCount})` : ''}</button>
    </div>
    ${list.length
      ? `<div class="grid-auto" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">${list.map(g => goalCard(g, tasks, t)).join('')}</div>`
      : emptyState(goals.length ? 'По этому фильтру целей нет' : 'Целей пока нет — сформулируйте первую', '🎯')}
    <div class="grid-2" style="align-items:start;margin-top:12px">
      ${weeklyCard()}
      <div class="card">
        <h3>Сводка</h3>
        <div class="small muted">Активных целей: <b>${activeCount}</b>, завершённых: <b>${doneCount}</b>. Привязывайте задачи к целям в карточке задачи — так видно, что двигает цель вперёд.</div>
      </div>
    </div>`;
}

// ---------- Страница ----------
export async function render(root, ctx) {
  const rerender = () => render(root, ctx);
  const t = today();
  const tasks = db.all('tasks');
  const goals = db.all('goals');
  const goalById = (id) => goals.find(g => g.id === id);

  root.innerHTML = `<div>
    <div class="page-head">
      <div><div class="eyebrow">Главное</div><h1>Цели и задачи</h1></div>
      <div class="actions">
        <div class="seg">
          <button type="button" class="${tab === 'tasks' ? 'active' : ''}" data-action="tab" data-tab="tasks">Задачи</button>
          <button type="button" class="${tab === 'goals' ? 'active' : ''}" data-action="tab" data-tab="goals">Цели</button>
          <button type="button" class="${tab === 'vision' ? 'active' : ''}" data-action="tab" data-tab="vision">Визуализация</button>
        </div>
        ${tab === 'tasks'
          ? `<button class="btn" data-action="new-task">${icon('plus')} Задача</button>`
          : tab === 'goals' ? `<button class="btn" data-action="new-goal">${icon('plus')} Новая цель</button>` : ''}
      </div>
    </div>
    ${tab === 'tasks' ? renderTasks(tasks, goalById, t) : tab === 'goals' ? renderGoals(goals, tasks, t) : renderVision()}
  </div>`;

  if (tab === 'vision') bindVision(root.firstElementChild, rerender);

  const view = root.firstElementChild;

  on(view, 'click', '[data-action]', (e, b) => {
    const a = b.dataset.action, id = b.dataset.id;
    switch (a) {
      case 'tab': tab = b.dataset.tab; rerender(); break;
      case 'new-task': openTaskModal(null, { defaults: { date: day } }); break;
      case 'proj-filter': projFilter = b.dataset.filter; rerender(); break;
      case 'new-goal': openGoalModal(null); break;
      case 'toggle': toggleTask(id); break;
      case 'edit': { const x = db.get('tasks', id); if (x) openTaskModal(x); break; }
      case 'move-today': db.update('tasks', id, { date: today() }); break;
      case 'schedule': db.update('tasks', id, { date: day }); break;
      case 'move-all': {
        const list = db.where('tasks', x => !x.done && x.date && x.date < today());
        for (const x of list) db.update('tasks', x.id, { date: today() });
        toast(`Перенесено: ${list.length}`);
        break;
      }
      case 'weekly': openWeeklyReviewModal(startOfWeek()); break;
      case 'horizon': horizon = b.dataset.h || 'all'; rerender(); break;
      case 'toggle-done': showDone = !showDone; rerender(); break;
      case 'edit-goal': { const g = db.get('goals', id); if (g) openGoalModal(g); break; }
      case 'toggle-kr': toggleKR(id, b.dataset.kr); break;
      case 'del-kr': removeKR(id, b.dataset.kr); break;
      case 'add-kr': addKR(id); break;
      default: break;
    }
  });

  on(view, 'click', '[data-dn]', (e, b) => {
    const a = b.dataset.dn;
    if (a === 'prev') day = addDays(day, -1);
    else if (a === 'next') day = addDays(day, 1);
    else if (a === 'today') day = today();
    else return;
    rerender();
  });
  on(view, 'change', '[data-dn="pick"]', (e, inp) => { if (inp.value) { day = inp.value; rerender(); } });

  on(view, 'submit', 'form[data-quick]', (e, form) => {
    e.preventDefault();
    const d = formData(form);
    if (!d.title) return;
    db.add('tasks', {
      title: d.title, date: day, priority: Number(d.priority) || 2, goalId: null,
      estimateMin: null, notes: '', recurring: null, done: false, doneAt: null,
    });
  });

  const inboxEl = view.querySelector('[data-inbox]');
  if (inboxEl) inboxEl.addEventListener('toggle', () => { inboxOpen = inboxEl.open; });
}
