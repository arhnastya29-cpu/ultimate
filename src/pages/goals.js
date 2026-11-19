// Цели — вкладка «Цели» раздела «План» (src/pages/plan.js) с подпереключателем «Цели | Визуализация».
// Это не самостоятельная страница: модуль отдаёт разметку вкладки и обработчики.
// Прогресс цели считается в model.js (goalProgress): по ключевым результатам, иначе по задачам, иначе вручную.
import { db, uid } from '../db.js';
import { esc, icon, modal, field, formRow, toast, on, today, fmtDate, daysBetween, startOfWeek, checkBtn, progressBar, emptyAction, statLine, sortBy, clamp, plural } from '../ui.js';
import { goalProgress } from '../model.js';
import { renderVision, bindVision } from './vision.js';

// ---------- Локальное состояние вкладки ----------
let sub = 'goals';        // 'goals' | 'vision'
let horizon = 'all';      // фильтр целей: all | year | quarter | month
let showDone = false;     // показывать завершённые цели

// ---------- Справочники ----------
export const AREAS = { career: 'Карьера', health: 'Здоровье', learning: 'Обучение', finance: 'Финансы', relations: 'Отношения', personal: 'Личное' };
const HORIZONS = { year: 'Год', quarter: 'Квартал', month: 'Месяц' };
const STATUSES = { active: 'Активна', done: 'Завершена', paused: 'На паузе' };
const AREA_OPTIONS = Object.entries(AREAS);
const HORIZON_OPTIONS = Object.entries(HORIZONS);
const STATUS_OPTIONS = Object.entries(STATUSES);
const dayWord = (n) => plural(n, 'день', 'дня', 'дней');

// ---------- Мутации ----------
function toggleKR(goalId, krId) {
  db.update('goals', goalId, (g) => ({ keyResults: (g.keyResults || []).map(k => k.id === krId ? { ...k, done: !k.done } : k) }));
}
function addKR(goalId) {
  modal({
    title: 'Ключевой результат',
    body: `<div class="form">${field({ name: 'title', label: 'Измеримый итог', value: '', required: true, placeholder: 'Например: 10 встреч с клиентами', autofocus: true })}</div>`,
    submitText: 'Добавить',
    onSubmit: (d) => {
      const text = String(d.title || '').trim(); if (!text) return false;
      db.update('goals', goalId, (g) => ({ keyResults: [...(g.keyResults || []), { id: uid(), title: text, done: false }] }));
    },
  });
}
function removeKR(goalId, krId) {
  if (!confirm('Удалить ключевой результат?')) return;
  db.update('goals', goalId, (g) => ({ keyResults: (g.keyResults || []).filter(k => k.id !== krId) }));
}

// ---------- Модалки ----------
export function openGoalModal(goal) {
  const isNew = !goal;
  const g = goal || { title: '', description: '', areaKey: 'personal', horizon: 'quarter', deadline: null, status: 'active', progress: 0, keyResults: [] };
  const krs = g.keyResults || [];
  const hasKR = krs.length > 0;
  const linked = isNew ? 0 : db.where('tasks', x => x.goalId === g.id).length;
  modal({
    title: isNew ? 'Новая цель' : 'Цель',
    body: `<div class="form">
      ${field({ name: 'title', label: 'Цель', value: g.title, required: true, placeholder: 'Чего хочу достичь', autofocus: isNew })}
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
        : linked
          ? `<div class="hint muted tiny">Прогресс считается по задачам цели (${linked}). Добавьте ключевые результаты, чтобы считать по ним.</div>`
          : field({ name: 'progress', label: 'Прогресс, %', type: 'number', value: g.progress ?? 0, min: 0, max: 100, step: 5, hint: 'Ручной прогресс; добавьте ключевые результаты или задачи, чтобы считать автоматически' })}
    </div>`,
    onSubmit: (d) => {
      const patch = {
        title: d.title, description: d.description || '', areaKey: d.areaKey || 'personal',
        horizon: d.horizon || 'quarter', deadline: d.deadline || null, status: d.status || 'active',
      };
      if (!hasKR && !linked) patch.progress = clamp(Number(d.progress) || 0, 0, 100);
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

export function openWeeklyReviewModal(weekStart = startOfWeek()) {
  const ex = db.all('weeklyReviews').find(r => r.weekStart === weekStart) || null;
  modal({
    title: `Обзор недели с ${fmtDate(weekStart, { relative: false, year: true })}`,
    body: `<div class="form">
      ${field({ name: 'wins', label: 'Победы недели', type: 'textarea', value: ex?.wins || '', rows: 3, placeholder: 'Что получилось' })}
      ${field({ name: 'challenges', label: 'Сложности', type: 'textarea', value: ex?.challenges || '', rows: 3, placeholder: 'Что мешало' })}
      ${field({ name: 'nextFocus', label: 'Фокус на следующую неделю', type: 'textarea', value: ex?.nextFocus || '', rows: 2, placeholder: '1–3 главных приоритета' })}
      ${field({ name: 'rating', label: 'Оценка недели', type: 'rating', value: ex?.rating ?? '', hint: '1 — тяжёлая, 5 — отличная' })}
    </div>`,
    onSubmit: (d) => {
      const data = { weekStart, wins: d.wins || '', challenges: d.challenges || '', nextFocus: d.nextFocus || '', rating: d.rating ?? null };
      if (ex) db.update('weeklyReviews', ex.id, data); else db.add('weeklyReviews', data);
      toast('Обзор недели сохранён');
    },
    onDelete: ex ? () => { db.remove('weeklyReviews', ex.id); toast('Обзор удалён'); } : undefined,
  });
}

// ---------- Фрагменты ----------
export function weeklyCard() {
  const ws = startOfWeek();
  const rev = db.all('weeklyReviews').find(r => r.weekStart === ws) || null;
  const text = rev
    ? (rev.wins ? esc(rev.wins) : 'Обзор заполнен, но победы не записаны.')
    : `Неделя с ${esc(fmtDate(ws, { relative: false }))}. Подведите итоги: победы, сложности и фокус на следующую неделю.`;
  return `<div class="card" data-block="weekly" data-block-title="Недельный обзор">
    <div class="row between"><h3 style="margin:0">Недельный обзор</h3>${rev && rev.rating ? `<span class="pill accent">${Number(rev.rating)}/5</span>` : ''}</div>
    <p class="small muted" style="margin:6px 0 10px;white-space:pre-line">${text}</p>
    <button type="button" class="btn secondary sm" data-action="weekly">${icon('edit')} ${rev ? 'Изменить обзор' : 'Заполнить обзор'}</button>
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
  return `<div class="card stack tight goal-card ${isDone ? 'is-done' : ''}">
    <div class="row between">
      <span class="pill accent">${esc(AREAS[g.areaKey] || 'Личное')}</span>
      <span class="row" style="gap:6px">
        <span class="tag">${esc(HORIZONS[g.horizon] || '')}</span>
        ${g.status && g.status !== 'active' ? `<span class="pill ${isDone ? 'good' : ''}">${esc(STATUSES[g.status] || g.status)}</span>` : ''}
      </span>
    </div>
    <button type="button" class="goal-title" data-action="edit-goal" data-id="${esc(g.id)}">${esc(g.title)}</button>
    <div class="tiny">${deadlineHtml}</div>
    <div class="row" style="gap:8px">${progressBar(pct, 100, `grow ${barCls}`)}<span class="tiny bold mono" style="min-width:36px;text-align:right">${pct}%</span></div>
    ${krList}
    <div class="row between">
      <button type="button" class="link" data-action="add-kr" data-id="${esc(g.id)}">+ результат</button>
      <span class="tiny muted">${openTasks ? `открытых задач: ${openTasks}` : ''}</span>
    </div>
  </div>`;
}

// ---------- Вкладка ----------
export const getGoalsSub = () => sub;
export function renderGoalsTab() {
  const t = today();
  const goals = db.all('goals');
  const tasks = db.all('tasks');
  const switcher = `<div class="seg plan-sub" role="tablist" aria-label="Цели или визуализация">
    <button type="button" role="tab" aria-selected="${sub === 'goals'}" class="${sub === 'goals' ? 'active' : ''}" data-action="goals-sub" data-sub="goals">Цели</button>
    <button type="button" role="tab" aria-selected="${sub === 'vision'}" class="${sub === 'vision' ? 'active' : ''}" data-action="goals-sub" data-sub="vision">Визуализация</button>
  </div>`;
  if (sub === 'vision') return `${switcher}<div data-block="vision" data-block-title="Визуализация">${renderVision()}</div>`;

  let list = showDone ? goals : goals.filter(g => g.status !== 'done');
  if (horizon !== 'all') list = list.filter(g => g.horizon === horizon);
  list = sortBy(list, g => `${g.status === 'done' ? 1 : 0}|${g.deadline || '9999-99-99'}`);
  const activeCount = goals.filter(g => g.status === 'active').length;
  const doneCount = goals.filter(g => g.status === 'done').length;
  const pausedCount = goals.filter(g => g.status === 'paused').length;
  const chips = [['all', 'Все'], ['year', 'Год'], ['quarter', 'Квартал'], ['month', 'Месяц']]
    .map(([v, l]) => `<button type="button" class="chip ${horizon === v ? 'active' : ''}" data-action="horizon" data-h="${v}">${l}</button>`).join('');

  if (!goals.length) {
    return `${switcher}
      <div data-block="goals" data-block-title="Цели">${emptyAction({ text: 'Цель — это то, ради чего вы планируете задачи. Сформулируйте первую, а задачи привязывайте к ней в карточке задачи', action: 'new-goal', label: 'Новая цель' })}</div>
      <div style="margin-top:14px">${weeklyCard()}</div>`;
  }
  return `${switcher}
    <div class="row between wrap" style="margin-bottom:12px;gap:8px">
      <div class="chips">${chips}${doneCount ? `<button type="button" class="chip ${showDone ? 'active' : ''}" data-action="toggle-done">завершённые (${doneCount})</button>` : ''}</div>
      <button type="button" class="btn secondary sm" data-action="new-goal">${icon('plus')} Цель</button>
    </div>
    ${statLine([activeCount ? `<b>${activeCount}</b> ${plural(activeCount, 'активная', 'активные', 'активных')}` : '', pausedCount ? `${pausedCount} на паузе` : '', doneCount ? `${doneCount} ${plural(doneCount, 'завершена', 'завершены', 'завершено')}` : ''])}
    <div data-block="goals" data-block-title="Цели">${list.length
      ? `<div class="grid-auto goal-grid">${list.map(g => goalCard(g, tasks, t)).join('')}</div>`
      : `<div class="tiny faint" style="padding:8px 0 14px">По этому фильтру целей нет</div>`}</div>
    <div style="margin-top:14px">${weeklyCard()}</div>`;
}

// Обработчики вкладки. «Новая цель» (new-goal) и «Недельный обзор» (weekly) обрабатывает plan.js,
// потому что они есть и в меню страницы.
export function bindGoalsTab(root, rerender) {
  if (sub === 'vision') bindVision(root, rerender);
  on(root, 'click', '[data-action]', (e, b) => {
    const a = b.dataset.action, id = b.dataset.id;
    switch (a) {
      case 'goals-sub': sub = b.dataset.sub === 'vision' ? 'vision' : 'goals'; rerender(); break;
      case 'horizon': horizon = b.dataset.h || 'all'; rerender(); break;
      case 'toggle-done': showDone = !showDone; rerender(); break;
      case 'edit-goal': { const g = db.get('goals', id); if (g) openGoalModal(g); break; }
      case 'toggle-kr': toggleKR(id, b.dataset.kr); break;
      case 'del-kr': removeKR(id, b.dataset.kr); break;
      case 'add-kr': addKR(id); break;
      default: break;
    }
  });
}
