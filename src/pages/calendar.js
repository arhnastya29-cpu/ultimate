// Календарь — вкладка «Неделя» раздела «План» (src/pages/plan.js). Это не самостоятельная
// страница: модуль отдаёт функции разметки и обработчики, а состояние выбранного дня хранит plan.js.
// Всё, что привязано к датам, берётся из agendaOn(d) в model.js: события (с повтором), задачи,
// ожидания от других людей, дедлайны проектов и целей, медицинские дела.
import { db } from '../db.js';
import { esc, icon, modal, field, formRow, toast, on, today, addDays, fmtDate, fmtMinutes, checkBtn, startOfWeek, weekDays, parseISO, iso, emptyAction } from '../ui.js';
import { agendaOn, isMine, personName, TASK_SOURCES } from '../model.js';
import { openTaskModal } from './task-modal.js';

// Совместимость: today.js и другие модули импортируют occursOn отсюда.
export { occursOn } from '../model.js';
// Всё на день — через общую повестку.
export const itemsOn = (d) => agendaOn(d);

export const KINDS = { meeting: ['Встреча', 'accent'], work: ['Работа', ''], personal: ['Личное', 'good'], health: ['Здоровье', 'warn'], other: ['Другое', ''] };
export const REPEATS = { none: 'Не повторять', daily: 'Каждый день', weekdays: 'По будням', weekly: 'Каждую неделю', monthly: 'Каждый месяц' };
// Типы элементов повестки: подпись и иконка (не только цвет).
export const AGENDA_TYPES = {
  event: { label: 'событие', icon: 'calendar' },
  task: { label: 'задача', icon: 'check' },
  waiting: { label: 'жду от других', icon: 'clock' },
  deadline: { label: 'дедлайн', icon: 'target' },
  health: { label: 'здоровье', icon: 'heart' },
};
const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const wdIndex = (d) => (parseISO(d).getDay() + 6) % 7;
export const isNarrow = () => window.matchMedia('(max-width: 860px)').matches;

let view = 'week';           // month | week | day — вид календаря (помним между открытиями)
export const getCalView = () => view;
export const setCalView = (v) => { view = ['month', 'week', 'day'].includes(v) ? v : 'week'; };
// Сдвиг даты стрелками в зависимости от вида.
export function calendarNav(cursor, n) {
  if (n === 0) return today();
  if (view === 'month') { const d = parseISO(cursor); return iso(new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), 28))); }
  return addDays(cursor, view === 'week' ? 7 * n : n);
}

// ---------- модалка события ----------
export function openEventModal(ev, presetDate) {
  const isNew = !ev;
  const x = ev || { title: '', date: presetDate || today(), time: '', endTime: '', place: '', kind: 'meeting', repeat: 'none', until: '', notes: '', personId: null };
  const people = db.all('people').map(p => [p.id, p.name + (p.type === 'ceo' ? ' (CEO)' : '')]);
  modal({
    title: isNew ? 'Новое событие' : 'Событие',
    body: `<div class="form">
      ${field({ name: 'title', label: 'Что', value: x.title, required: true, placeholder: 'Планёрка, тренировка, созвон…', autofocus: isNew })}
      ${formRow(
        field({ name: 'date', label: 'Дата', type: 'date', value: x.date || today(), required: true }),
        field({ name: 'time', label: 'Начало', type: 'time', value: x.time || '' }),
        field({ name: 'endTime', label: 'Конец', type: 'time', value: x.endTime || '' }),
      )}
      ${formRow(
        field({ name: 'kind', label: 'Тип', type: 'select', value: x.kind || 'meeting', options: Object.entries(KINDS).map(([k, [l]]) => [k, l]) }),
        field({ name: 'personId', label: 'С кем', type: 'select', value: x.personId || '', options: [['', '— никто —'], ...people], hint: people.length ? '' : 'Людей пока нет — добавьте их в разделе «Люди»' }),
      )}
      ${formRow(
        field({ name: 'repeat', label: 'Повтор', type: 'select', value: x.repeat || 'none', options: Object.entries(REPEATS) }),
        field({ name: 'until', label: 'Повторять до', type: 'date', value: x.until || '' }),
      )}
      ${field({ name: 'place', label: 'Где / ссылка', value: x.place || '', placeholder: 'офис, Zoom, адрес' })}
      ${field({ name: 'notes', label: 'Заметки', type: 'textarea', value: x.notes || '', rows: 3 })}
    </div>`,
    onSubmit: (d) => {
      const patch = { title: d.title.trim(), date: d.date, time: d.time || '', endTime: d.endTime || '', place: d.place || '', kind: KINDS[d.kind] ? d.kind : 'other', repeat: REPEATS[d.repeat] ? d.repeat : 'none', until: d.until || '', notes: d.notes || '', personId: d.personId || null };
      if (isNew) { db.add('events', patch); toast('Событие добавлено'); }
      else { db.update('events', ev.id, patch); toast('Сохранено'); }
    },
    onDelete: isNew ? undefined : () => { db.remove('events', ev.id); toast('Событие удалено'); },
  });
}

// ---------- элементы повестки ----------
// Задача → элемент повестки (как в agendaOn), чтобы списки задач и календаря выглядели одинаково.
export function toItem(t) {
  return { type: isMine(t) ? 'task' : 'waiting', id: t.id, title: t.title, time: t.time || '', done: !!t.done, priority: t.priority, source: t.source, personId: t.personId || null, date: t.date || null, data: t };
}
export function kindIco(type, { small = false } = {}) {
  const k = AGENDA_TYPES[type] || AGENDA_TYPES.task;
  return `<span class="kind-ico ${esc(type)} ${small ? 'xs' : ''}" aria-hidden="true">${icon(k.icon)}</span>`;
}
const PRI = { 1: '<span class="pill bad">важно</span>', 3: '<span class="tag faint">низкий приоритет</span>' };

// Строка повестки: чекбокс (задачи) или иконка типа, время, название, подпись типа и детали.
// opts: trail — html справа (кнопки), showDate — показать дату вместо времени.
export function agendaRow(i, { trail = '', showDate = false } = {}) {
  const k = AGENDA_TYPES[i.type] || AGENDA_TYPES.task;
  const isTask = i.type === 'task' || i.type === 'waiting';
  const t = i.data;
  const meta = [`<span class="agenda-kind">${kindIco(i.type, { small: true })}${esc(k.label)}</span>`];
  if (i.type === 'event') {
    const kind = KINDS[i.kind] || KINDS.other;
    if (kind[0] && i.kind !== 'other') meta.push(`<span>${esc(kind[0])}</span>`);
    if (i.personId) meta.push(`<span>с ${esc(personName(i.personId) || 'человеком')}</span>`);
    if (i.place) meta.push(`<span class="ellipsis" style="max-width:180px">${esc(i.place)}</span>`);
    if (i.repeat) meta.push('<span>повтор</span>');
  } else if (isTask && t) {
    if (PRI[t.priority]) meta.push(PRI[t.priority]);
    const p = t.projectId ? db.get('projects', t.projectId) : null;
    if (p) meta.push(`<span class="pill accent ellipsis" style="max-width:160px">${esc(p.name)}</span>`);
    if (t.personId) meta.push(`<span class="tag">${esc(t.source === 'ceo' ? TASK_SOURCES.ceo : (i.type === 'waiting' ? 'от ' : '') + (personName(t.personId) || 'человек'))}</span>`);
    else if (t.source && t.source !== 'manual' && t.source !== 'project') meta.push(`<span class="tag">${esc(TASK_SOURCES[t.source] || t.source)}</span>`);
    const g = t.goalId ? db.get('goals', t.goalId) : null;
    if (g) meta.push(`<span class="tag ellipsis" style="max-width:150px">${icon('target')} ${esc(g.title)}</span>`);
    if (t.estimateMin) meta.push(`<span>${esc(fmtMinutes(t.estimateMin))}</span>`);
    if (t.recurring) meta.push(`<span>↻ ${t.recurring === 'daily' ? 'ежедневно' : 'еженедельно'}</span>`);
    if (t.timeless) meta.push('<span>∞ бессрочно</span>');
  }
  const lead = i.type === 'task' ? checkBtn(!!i.done, `data-action="toggle" data-id="${esc(i.id)}" aria-label="Выполнено"`) : kindIco(i.type);
  const open = i.type === 'event' ? `data-action="event" data-id="${esc(i.id)}"`
    : isTask ? `data-action="edit" data-id="${esc(i.id)}"`
    : i.page ? `data-action="go" data-page="${esc(i.page)}" data-params='${esc(JSON.stringify(i.params || {}))}'` : '';
  const when = showDate && i.date ? `<span class="agenda-time ${i.date < today() && !i.done ? 'bad' : ''}">${esc(fmtDate(i.date))}</span>` : i.time ? `<span class="agenda-time mono">${esc(i.time)}${i.end ? `–${esc(i.end)}` : ''}</span>` : '';
  const closeBtn = i.type === 'waiting' && !i.done ? `<button type="button" class="btn sm secondary" data-action="toggle" data-id="${esc(i.id)}">Получено</button>` : '';
  return `<div class="list-item agenda-row ${esc(i.type)} ${i.done ? 'is-done' : ''}">
    ${lead}
    <div class="main" ${open} ${open ? 'tabindex="0" role="button"' : ''}>
      <div class="title ${i.done ? 'strike' : ''}">${when}${esc(i.title)}</div>
      <div class="sub row wrap" style="gap:6px">${meta.join('')}</div>
    </div>
    ${closeBtn}${trail}
  </div>`;
}

// Легенда типов: иконка + подпись.
export function agendaLegend() {
  return `<div class="agenda-legend tiny muted">${Object.entries(AGENDA_TYPES).map(([k, v]) => `<span>${kindIco(k, { small: true })}${esc(v.label)}</span>`).join('')}</div>`;
}

// Компактная полоска дней недели: ‹ диапазон › Сегодня / Пн..Вс с числами и точкой, если есть дела.
export function weekStrip(cursor, { navLabel = '' } = {}) {
  const t = today(); const days = weekDays(cursor);
  const label = navLabel || `${fmtDate(days[0], { relative: false })} — ${fmtDate(days[6], { relative: false })}`;
  return `<div class="wstrip" data-block="days" data-block-title="Дни недели">
    <div class="wstrip-nav">
      <button type="button" class="icon-btn sm" data-nav="-1" aria-label="Назад">${icon('chevronLeft')}</button>
      <b class="wstrip-label">${esc(label)}</b>
      <button type="button" class="icon-btn sm" data-nav="1" aria-label="Вперёд">${icon('chevronRight')}</button>
      <button type="button" class="chip ${cursor === t ? 'active' : ''}" data-nav="0">Сегодня</button>
    </div>
    <div class="wstrip-days" role="group" aria-label="Дни недели">${days.map(d => {
      const n = agendaOn(d).filter(i => !i.done).length;
      return `<button type="button" class="wday ${d === cursor ? 'active' : ''} ${d === t ? 'is-today' : ''}" data-pick-day="${d}" aria-pressed="${d === cursor}" aria-label="${esc(fmtDate(d, { weekday: true }))}${n ? `, дел: ${n}` : ''}">
        <span class="wd">${WD[wdIndex(d)]}</span><span class="dn">${parseISO(d).getDate()}</span><i class="dot ${n ? 'on' : ''}"></i>
      </button>`;
    }).join('')}</div>
  </div>`;
}

// ---------- виды календаря ----------
function chip(i, { compact = false } = {}) {
  const open = i.type === 'event' ? `data-action="event" data-id="${esc(i.id)}"`
    : (i.type === 'task' || i.type === 'waiting') ? `data-action="edit" data-id="${esc(i.id)}"`
    : i.page ? `data-action="go" data-page="${esc(i.page)}" data-params='${esc(JSON.stringify(i.params || {}))}'` : '';
  const label = compact ? esc(i.title) : `${i.time ? `<b class="mono">${esc(i.time)}</b> ` : ''}${esc(i.title)}`;
  return `<button type="button" class="ci ci-${esc(i.type)} ${i.done ? 'is-done' : ''}" ${open} title="${esc(AGENDA_TYPES[i.type]?.label || '')}: ${esc(i.title)}">${kindIco(i.type, { small: true })}${label}</button>`;
}

function monthView(cursor, t) {
  const c = parseISO(cursor); const y = c.getFullYear(), m = c.getMonth();
  const start = startOfWeek(iso(new Date(y, m, 1)));
  const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const lastRow = cells.slice(35).some(d => parseISO(d).getMonth() === m) ? 42 : 35;
  return `<div class="cal-month">
    <div class="cal-wd">${WD.map(w => `<div>${w}</div>`).join('')}</div>
    <div class="cal-grid">${cells.slice(0, lastRow).map(d => {
      const items = agendaOn(d); const inMonth = parseISO(d).getMonth() === m;
      return `<div class="cal-cell ${inMonth ? '' : 'is-out'} ${d === t ? 'is-today' : ''} ${d === cursor ? 'is-sel' : ''}" data-day="${d}" role="button" tabindex="0" aria-label="${esc(fmtDate(d, { weekday: true, relative: false }))}${items.length ? `, дел: ${items.length}` : ''}">
        <div class="cal-num">${parseISO(d).getDate()}</div>
        <div class="cal-items">${items.slice(0, 3).map(i => chip(i, { compact: true })).join('')}${items.length > 3 ? `<div class="tiny faint">+${items.length - 3}</div>` : ''}</div>
      </div>`;
    }).join('')}</div>
  </div>`;
}

function weekView(cursor, t) {
  const days = weekDays(cursor);
  return `<div class="cal-week">${days.map(d => {
    const items = agendaOn(d);
    return `<div class="cal-col ${d === t ? 'is-today' : ''} ${d === cursor ? 'is-sel' : ''}">
      <button type="button" class="cal-col-head" data-day="${d}" aria-label="${esc(fmtDate(d, { weekday: true, relative: false }))}"><span class="tiny muted">${WD[wdIndex(d)]}</span><b class="${d === t ? 'accent' : ''}">${parseISO(d).getDate()}</b></button>
      <div class="cal-col-items">${items.length ? items.map(i => chip(i)).join('') : '<div class="tiny faint">—</div>'}</div>
      <button type="button" class="link tiny" data-add-day="${d}">+ событие</button>
    </div>`;
  }).join('')}</div>`;
}

function dayView(cursor) {
  const items = agendaOn(cursor);
  const timed = items.filter(i => i.time), allDay = items.filter(i => !i.time);
  return `<div class="grid-2" style="align-items:start">
    <div class="card" data-block="schedule" data-block-title="Расписание дня">
      <div class="section-title"><h2>Расписание</h2><button type="button" class="link" data-add-day="${cursor}">+ событие</button></div>
      ${timed.length ? `<div class="list">${timed.map(i => agendaRow(i)).join('')}</div>` : '<div class="tiny faint">Событий со временем нет</div>'}
    </div>
    <div class="card" data-block="allday" data-block-title="Дела без времени">
      <div class="section-title"><h2>Дела и дедлайны</h2><button type="button" class="link" data-add-task="${cursor}">+ задача</button></div>
      ${allDay.length ? `<div class="list">${allDay.map(i => agendaRow(i)).join('')}</div>` : '<div class="tiny faint">На этот день ничего не запланировано</div>'}
    </div>
  </div>`;
}

// ---------- вкладка «Неделя» ----------
// dayList(d) — разметка списка дня (из plan.js), используется на телефоне вместо семи колонок.
export function renderCalendarTab({ cursor, dayList }) {
  const t = today(); const narrow = isNarrow();
  const c = parseISO(cursor);
  const label = view === 'month' ? `${MONTHS[c.getMonth()]} ${c.getFullYear()}`
    : view === 'week' ? `${fmtDate(weekDays(cursor)[0], { relative: false })} — ${fmtDate(weekDays(cursor)[6], { relative: false })}`
    : fmtDate(cursor, { weekday: true, relative: false });
  const upcoming = [];
  for (let i = 0; i < 14; i++) { const d = addDays(t, i); for (const it of agendaOn(d)) if (!it.done) upcoming.push({ ...it, date: d }); }
  const seg = `<div class="seg" role="tablist" aria-label="Вид календаря">${[['month', 'Месяц'], ['week', 'Неделя'], ['day', 'День']].map(([v, l]) => `<button type="button" role="tab" aria-selected="${view === v}" class="${view === v ? 'active' : ''}" data-view="${v}">${l}</button>`).join('')}</div>`;
  const nav = `<div class="row" style="gap:6px">
      <button type="button" class="icon-btn sm" data-nav="-1" aria-label="Назад">${icon('chevronLeft')}</button>
      <button type="button" class="chip ${cursor === t ? 'active' : ''}" data-nav="0">Сегодня</button>
      <button type="button" class="icon-btn sm" data-nav="1" aria-label="Вперёд">${icon('chevronRight')}</button>
      <b class="small" style="margin-left:4px">${esc(label)}</b>
    </div>`;
  const body = view === 'month' ? monthView(cursor, t)
    : view === 'week' ? (narrow ? `${weekStrip(cursor)}<div class="card">${dayList(cursor)}</div>` : weekView(cursor, t))
    : dayView(cursor);
  const hasAnything = db.all('events').length || db.all('tasks').some(x => x.date);
  return `
    <div class="row between wrap cal-head" style="gap:8px;margin-bottom:12px">${seg}${view === 'week' && narrow ? '' : nav}</div>
    <div data-block="calendar" data-block-title="Календарь">${body}</div>
    ${!hasAnything ? emptyAction({ text: 'Календарь пуст. Добавьте встречи, созвоны и расписание — они будут видны здесь и на главной', action: 'new-event', label: 'Добавить событие' }) : agendaLegend()}
    ${view !== 'day' ? `<div class="card" style="margin-top:14px" data-block="upcoming" data-block-title="Ближайшие 14 дней">
      <details class="acc" ${upcoming.length && !narrow ? 'open' : ''}><summary>Ближайшие 14 дней <span class="pill">${upcoming.length}</span></summary>
      <div style="margin-top:8px">${upcoming.length ? `<div class="list">${upcoming.slice(0, 12).map(it => agendaRow(it, { showDate: true, trail: `<span class="tiny ${it.date === t ? 'warn bold' : 'muted'}" style="white-space:nowrap">${it.date === t ? 'сегодня' : esc(fmtDate(it.date))}</span>` })).join('')}</div>` : '<div class="tiny faint">Две недели свободны</div>'}</div>
      </details>
    </div>` : ''}`;
}

// Обработчики вкладки: вид, клик по дню в сетке, «+ событие», «+ задача».
// Стрелки (data-nav) и выбор дня (data-pick-day), а также data-action — обрабатывает plan.js.
export function bindCalendarTab(root, { setDay, rerender }) {
  on(root, 'click', '[data-view]', (e, b) => { setCalView(b.dataset.view); rerender(); });
  on(root, 'click', '[data-day]', (e, b) => { if (e.target.closest('[data-action],[data-add-day]')) return; setDay(b.dataset.day); setCalView('day'); rerender(); });
  on(root, 'click', '[data-add-day]', (e, b) => { e.stopPropagation(); openEventModal(null, b.dataset.addDay); });
  on(root, 'click', '[data-add-task]', (e, b) => openTaskModal(null, { defaults: { date: b.dataset.addTask } }));
}
