// Календарь: всё, что привязано к датам, в одном месте — свои события и расписание (с временем
// и повтором), задачи, дедлайны проектов и целей, задачи от CEO, обязательства, медицинские дела.
// Виды: месяц, неделя, день.
import { db } from '../db.js';
import { esc, icon, modal, field, formRow, toast, on, today, addDays, fmtDate, daysBetween, checkBtn, emptyState, sortBy, plural, startOfWeek, weekDays, parseISO, iso } from '../ui.js';
import { openTaskModal } from './task-modal.js';
import { cheer } from '../motivation.js';

export const title = 'Календарь';

let view = 'week';           // month | week | day
let cursor = today();        // выбранная дата

const KINDS = { meeting: ['Встреча', 'accent'], work: ['Работа', ''], personal: ['Личное', 'good'], health: ['Здоровье', 'warn'], other: ['Другое', ''] };
const REPEATS = { none: 'Не повторять', daily: 'Каждый день', weekdays: 'По будням', weekly: 'Каждую неделю', monthly: 'Каждый месяц' };
const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const wdIndex = (d) => (parseISO(d).getDay() + 6) % 7;

// ---------- повторяющиеся события ----------
export function occursOn(ev, d) {
  if (!ev.date) return false;
  if (ev.date === d) return true;
  if (!ev.repeat || ev.repeat === 'none' || d < ev.date) return false;
  if (ev.until && d > ev.until) return false;
  if (ev.repeat === 'daily') return true;
  if (ev.repeat === 'weekdays') return wdIndex(d) < 5;
  if (ev.repeat === 'weekly') return wdIndex(d) === wdIndex(ev.date);
  if (ev.repeat === 'monthly') return parseISO(d).getDate() === parseISO(ev.date).getDate();
  return false;
}

// ---------- сбор всего на день ----------
export function itemsOn(d) {
  const out = [];
  for (const ev of db.all('events')) if (occursOn(ev, d)) out.push({ type: 'event', id: ev.id, title: ev.title, time: ev.time || '', end: ev.endTime || '', place: ev.place || '', kind: ev.kind || 'other', repeat: ev.repeat && ev.repeat !== 'none', data: ev });
  for (const t of db.all('tasks')) if (t.date === d) out.push({ type: 'task', id: t.id, title: t.title, time: '', done: !!t.done, priority: t.priority, data: t });
  for (const p of db.all('projects')) if (p.deadline === d && p.status !== 'done') out.push({ type: 'deadline', id: p.id, title: `Дедлайн: ${p.name}`, time: '', page: 'projects', params: { id: p.id } });
  for (const g of db.all('goals')) if (g.deadline === d && g.status === 'active') out.push({ type: 'deadline', id: g.id, title: `Цель: ${g.title}`, time: '', page: 'goals' });
  for (const x of db.all('shadowTasks')) if (x.deadline === d && !x.done) out.push({ type: 'shadow', id: x.id, title: `CEO: ${x.title}`, time: '', page: 'shadow' });
  for (const c of db.all('commitments')) if (c.due === d && !c.done) out.push({ type: 'commitment', id: c.id, title: `${c.direction === 'mine' ? 'Обещала' : 'Мне обещали'}: ${c.title}`, time: '', page: 'people', params: { id: c.personId } });
  for (const h of db.all('healthTodos')) if (h.date === d && !h.done) out.push({ type: 'health', id: h.id, title: h.title, time: '', page: 'health' });
  return sortBy(out, i => `${i.time ? '0' + i.time : '1'}-${i.type === 'event' ? 0 : 1}-${i.priority || 2}`);
}

const TYPE_CLS = { event: 'ci-event', task: 'ci-task', deadline: 'ci-deadline', shadow: 'ci-shadow', commitment: 'ci-commit', health: 'ci-health' };

// ---------- модалка события ----------
function openEventModal(ev, presetDate) {
  const isNew = !ev;
  const x = ev || { title: '', date: presetDate || cursor, time: '', endTime: '', place: '', kind: 'meeting', repeat: 'none', until: '', notes: '' };
  modal({
    title: isNew ? 'Новое событие' : 'Событие',
    body: `<div class="form">
      ${field({ name: 'title', label: 'Что', value: x.title, required: true, placeholder: 'Планёрка, тренировка, созвон…', autofocus: isNew })}
      ${formRow(
        field({ name: 'date', label: 'Дата', type: 'date', value: x.date || cursor, required: true }),
        field({ name: 'time', label: 'Начало', type: 'time', value: x.time || '' }),
        field({ name: 'endTime', label: 'Конец', type: 'time', value: x.endTime || '' }),
      )}
      ${formRow(
        field({ name: 'kind', label: 'Тип', type: 'select', value: x.kind || 'meeting', options: Object.entries(KINDS).map(([k, [l]]) => [k, l]) }),
        field({ name: 'repeat', label: 'Повтор', type: 'select', value: x.repeat || 'none', options: Object.entries(REPEATS) }),
        field({ name: 'until', label: 'Повторять до', type: 'date', value: x.until || '' }),
      )}
      ${field({ name: 'place', label: 'Где / ссылка', value: x.place || '', placeholder: 'офис, Zoom, адрес' })}
      ${field({ name: 'notes', label: 'Заметки', type: 'textarea', value: x.notes || '', rows: 3 })}
    </div>`,
    onSubmit: (d) => {
      const patch = { title: d.title.trim(), date: d.date, time: d.time || '', endTime: d.endTime || '', place: d.place || '', kind: KINDS[d.kind] ? d.kind : 'other', repeat: REPEATS[d.repeat] ? d.repeat : 'none', until: d.until || '', notes: d.notes || '' };
      if (isNew) { db.add('events', patch); toast('Событие добавлено'); }
      else { db.update('events', ev.id, patch); toast('Сохранено'); }
    },
    onDelete: isNew ? undefined : () => { db.remove('events', ev.id); toast('Событие удалено'); },
  });
}

// ---------- фрагменты ----------
function chip(i, { compact = false } = {}) {
  const label = compact ? esc(i.title) : `${i.time ? `<b class="mono">${esc(i.time)}</b> ` : ''}${esc(i.title)}`;
  return `<div class="ci ${TYPE_CLS[i.type]} ${i.done ? 'is-done' : ''}" data-ci="${esc(i.type)}" data-id="${esc(i.id)}" ${i.page ? `data-page="${esc(i.page)}" data-params='${esc(JSON.stringify(i.params || {}))}'` : ''} title="${esc(i.title)}">${label}</div>`;
}

function dayRow(i) {
  const [kindLabel, kindCls] = i.type === 'event' ? (KINDS[i.kind] || KINDS.other) : ['', ''];
  const meta = i.type === 'event' ? `${i.time ? `${esc(i.time)}${i.end ? `–${esc(i.end)}` : ''}` : 'весь день'}${i.place ? ` · ${esc(i.place)}` : ''}${i.repeat ? ' · повтор' : ''}`
    : i.type === 'task' ? `задача${i.priority === 1 ? ' · важно' : ''}` : i.type === 'deadline' ? 'дедлайн' : i.type === 'shadow' ? 'задача от CEO' : i.type === 'commitment' ? 'обязательство' : 'здоровье';
  return `<div class="list-item cal-row ${TYPE_CLS[i.type]}">
    ${i.type === 'task' ? checkBtn(!!i.done, `data-task-toggle="${esc(i.id)}" aria-label="Выполнено"`) : `<span class="cal-dot"></span>`}
    <div class="main" data-ci="${esc(i.type)}" data-id="${esc(i.id)}" ${i.page ? `data-page="${esc(i.page)}" data-params='${esc(JSON.stringify(i.params || {}))}'` : ''} style="cursor:pointer">
      <div class="title ${i.done ? 'strike' : ''}">${esc(i.title)}</div>
      <div class="sub row wrap" style="gap:6px">${kindLabel ? `<span class="pill ${kindCls}">${esc(kindLabel)}</span>` : ''}<span>${meta}</span></div>
    </div>
  </div>`;
}

function monthView(t) {
  const c = parseISO(cursor); const y = c.getFullYear(), m = c.getMonth();
  const first = iso(new Date(y, m, 1));
  const start = startOfWeek(first);
  const cells = [];
  for (let i = 0; i < 42; i++) cells.push(addDays(start, i));
  const lastRow = cells.slice(35).some(d => parseISO(d).getMonth() === m) ? 42 : 35;
  return `<div class="cal-month">
    <div class="cal-wd">${WD.map(w => `<div>${w}</div>`).join('')}</div>
    <div class="cal-grid">${cells.slice(0, lastRow).map(d => {
      const items = itemsOn(d); const inMonth = parseISO(d).getMonth() === m;
      return `<div class="cal-cell ${inMonth ? '' : 'is-out'} ${d === t ? 'is-today' : ''} ${d === cursor ? 'is-sel' : ''}" data-day="${d}">
        <div class="cal-num">${parseISO(d).getDate()}</div>
        <div class="cal-items">${items.slice(0, 3).map(i => chip(i, { compact: true })).join('')}${items.length > 3 ? `<div class="tiny faint">+${items.length - 3}</div>` : ''}</div>
      </div>`;
    }).join('')}</div>
  </div>`;
}

function weekView(t) {
  const days = weekDays(cursor);
  return `<div class="cal-week">${days.map(d => {
    const items = itemsOn(d);
    return `<div class="cal-col ${d === t ? 'is-today' : ''}" data-day="${d}">
      <div class="cal-col-head"><span class="tiny muted">${WD[wdIndex(d)]}</span><b class="${d === t ? 'accent' : ''}">${parseISO(d).getDate()}</b></div>
      <div class="cal-col-items">${items.length ? items.map(i => chip(i)).join('') : '<div class="tiny faint">—</div>'}</div>
      <button type="button" class="link tiny" data-add-day="${d}">+ добавить</button>
    </div>`;
  }).join('')}</div>`;
}

function dayView(t) {
  const items = itemsOn(cursor);
  const timed = items.filter(i => i.time), allDay = items.filter(i => !i.time);
  return `<div class="grid-2" style="align-items:start">
    <div class="card" data-block="schedule" data-block-title="Расписание дня">
      <div class="section-title"><h2>Расписание</h2><button type="button" class="link" data-add-day="${cursor}">+ событие</button></div>
      ${timed.length ? `<div class="list">${timed.map(dayRow).join('')}</div>` : '<div class="tiny faint">Событий со временем нет. Добавьте встречи и расписание, они будут здесь по часам</div>'}
    </div>
    <div class="card" data-block="allday" data-block-title="Дела без времени">
      <div class="section-title"><h2>Дела и дедлайны</h2><button type="button" class="link" data-add-task="${cursor}">+ задача</button></div>
      ${allDay.length ? `<div class="list">${allDay.map(dayRow).join('')}</div>` : '<div class="tiny faint">На этот день ничего не запланировано</div>'}
    </div>
  </div>`;
}

// ---------- страница ----------
export async function render(root, { navigate, params = {} } = {}) {
  if (params.date) cursor = params.date;
  const t = today();
  const c = parseISO(cursor);
  const label = view === 'month' ? `${MONTHS[c.getMonth()]} ${c.getFullYear()}`
    : view === 'week' ? `${fmtDate(weekDays(cursor)[0], { relative: false })} — ${fmtDate(weekDays(cursor)[6], { relative: false })}`
    : fmtDate(cursor, { weekday: true, relative: false });
  const upcoming = [];
  for (let i = 0; i < 14; i++) { const d = addDays(t, i); for (const it of itemsOn(d)) if (!it.done) upcoming.push({ d, it }); }

  root.innerHTML = `<div>
    <div class="page-head">
      <div><div class="eyebrow">Главное</div><h1>Календарь</h1></div>
      <div class="actions">
        <div class="seg"><button type="button" class="${view === 'month' ? 'active' : ''}" data-view="month">Месяц</button><button type="button" class="${view === 'week' ? 'active' : ''}" data-view="week">Неделя</button><button type="button" class="${view === 'day' ? 'active' : ''}" data-view="day">День</button></div>
        <button class="btn" data-add-day="${cursor}">${icon('plus')} Событие</button>
      </div>
    </div>
    <div class="row between wrap" style="gap:8px;margin-bottom:12px">
      <div class="row" style="gap:6px">
        <button class="icon-btn sm" data-nav="-1" aria-label="Назад">${icon('chevronLeft')}</button>
        <button class="chip ${cursor === t ? 'active' : ''}" data-nav="0">Сегодня</button>
        <button class="icon-btn sm" data-nav="1" aria-label="Вперёд">${icon('chevronRight')}</button>
        <b style="margin-left:6px">${esc(label)}</b>
      </div>
      <div class="row wrap tiny muted" style="gap:10px"><span><i class="cal-dot ci-event"></i> события</span><span><i class="cal-dot ci-task"></i> задачи</span><span><i class="cal-dot ci-deadline"></i> дедлайны</span><span><i class="cal-dot ci-shadow"></i> CEO</span><span><i class="cal-dot ci-commit"></i> обещания</span></div>
    </div>
    <div data-block="calendar" data-block-title="Календарь">${view === 'month' ? monthView(t) : view === 'week' ? weekView(t) : dayView(t)}</div>
    ${view !== 'day' ? `<div class="card" style="margin-top:14px" data-block="upcoming" data-block-title="Ближайшие 14 дней">
      <div class="section-title"><h2>Ближайшие 14 дней</h2><span class="tiny muted">${upcoming.length}</span></div>
      ${upcoming.length ? `<div class="list">${upcoming.slice(0, 12).map(({ d, it }) => `<div class="list-item cal-row ${TYPE_CLS[it.type]}" style="padding:7px 6px"><span class="cal-dot"></span><div class="main" data-ci="${esc(it.type)}" data-id="${esc(it.id)}" ${it.page ? `data-page="${esc(it.page)}" data-params='${esc(JSON.stringify(it.params || {}))}'` : ''} style="cursor:pointer"><div class="title small">${esc(it.title)}</div></div><span class="tiny ${d === t ? 'warn bold' : 'muted'}" style="white-space:nowrap">${d === t ? 'сегодня' : esc(fmtDate(d))}${it.time ? ` · ${esc(it.time)}` : ''}</span></div>`).join('')}</div>` : emptyState('Две недели свободны. Добавьте расписание: планёрки, тренировки, созвоны', '🗓')}
    </div>` : ''}
  </div>`;
  const v = root.firstElementChild;
  const rerender = () => render(root, { navigate });

  on(v, 'click', '[data-view]', (e, b) => { view = b.dataset.view; rerender(); });
  on(v, 'click', '[data-nav]', (e, b) => {
    const n = Number(b.dataset.nav);
    if (n === 0) cursor = t;
    else if (view === 'month') { const d = parseISO(cursor); cursor = iso(new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), 28))); }
    else cursor = addDays(cursor, view === 'week' ? 7 * n : n);
    rerender();
  });
  on(v, 'click', '[data-day]', (e, b) => { if (e.target.closest('[data-ci],[data-add-day]')) return; cursor = b.dataset.day; view = 'day'; rerender(); });
  on(v, 'click', '[data-add-day]', (e, b) => { e.stopPropagation(); openEventModal(null, b.dataset.addDay); });
  on(v, 'click', '[data-add-task]', (e, b) => openTaskModal(null, { defaults: { date: b.dataset.addTask } }));
  on(v, 'click', '[data-task-toggle]', (e, b) => { const x = db.get('tasks', b.dataset.taskToggle); if (!x) return; db.update('tasks', x.id, x.done ? { done: false, doneAt: null } : { done: true, doneAt: today() }); if (!x.done && Math.random() < 0.6) toast(cheer(), 1800); });
  on(v, 'click', '[data-ci]', (e, b) => {
    e.stopPropagation();
    const type = b.dataset.ci, id = b.dataset.id;
    if (type === 'event') { const ev = db.get('events', id); if (ev) openEventModal(ev); }
    else if (type === 'task') { const x = db.get('tasks', id); if (x) openTaskModal(x); }
    else if (b.dataset.page) { let p = {}; try { p = JSON.parse(b.dataset.params || '{}'); } catch {} navigate(b.dataset.page, p); }
  });
}
