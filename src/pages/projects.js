import { db, uid } from '../db.js';
import { openTaskModal } from './task-modal.js';
import {
  esc, icon, modal, field, formRow, toast, on,
  today, fmtDate, daysBetween, progressBar, emptyState, sortBy, clamp, plural, checkBtn, fmtMinutes,
} from '../ui.js';

export const title = 'Проекты';

// ---------- Локальное состояние страницы ----------
let filter = 'open';      // open | active | idea | paused | done | all
let openLog = new Set();  // id проектов с раскрытым журналом

// ---------- Справочники ----------
const STATUSES = {
  idea:   ['Идея',      ''],
  active: ['В работе',  'accent'],
  paused: ['На паузе',  'warn'],
  done:   ['Завершён',  'good'],
};
const STATUS_OPTIONS = Object.entries(STATUSES).map(([k, [l]]) => [k, l]);
const PRIORITY_OPTIONS = [[1, 'Высокий'], [2, 'Обычный'], [3, 'Низкий']];
const PRIORITY = { 1: ['высокий', 'bad'], 2: ['обычный', ''], 3: ['низкий', ''] };
const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)'];
const FILTERS = [['open', 'Текущие'], ['active', 'В работе'], ['idea', 'Идеи'], ['paused', 'На паузе'], ['done', 'Завершённые'], ['all', 'Все']];

const dayWord = (n) => plural(n, 'день', 'дня', 'дней');
const parseTags = (s) => String(s || '').split(/[,;]/).map(t => t.trim()).filter(Boolean);

// ---------- Модалки ----------
function openProjectModal(project) {
  const isNew = !project;
  const p = project || {
    name: '', description: '', status: 'active', priority: 2, deadline: null, progress: 0,
    nextStep: '', link: '', tags: [], notes: '', color: COLORS[db.all('projects').length % COLORS.length],
  };
  modal({
    title: isNew ? 'Новый проект' : 'Проект',
    wide: true,
    body: `<div class="form">
      ${field({ name: 'name', label: 'Название', value: p.name, required: true, placeholder: 'Как называется проект', autofocus: isNew })}
      ${field({ name: 'description', label: 'Суть проекта', type: 'textarea', value: p.description || '', rows: 3, placeholder: 'Что это, зачем и какой результат считается успехом' })}
      ${formRow(
        field({ name: 'status', label: 'Статус', type: 'select', value: p.status || 'active', options: STATUS_OPTIONS }),
        field({ name: 'priority', label: 'Приоритет', type: 'select', value: p.priority || 2, options: PRIORITY_OPTIONS }),
        field({ name: 'deadline', label: 'Дедлайн', type: 'date', value: p.deadline || '' }),
      )}
      ${formRow(
        field({ name: 'progress', label: 'Готовность, %', type: 'number', value: p.progress ?? 0, min: 0, max: 100, step: 5 }),
        field({ name: 'link', label: 'Ссылка', type: 'url', value: p.link || '', placeholder: 'https://…' }),
      )}
      ${field({ name: 'nextStep', label: 'Следующий шаг', value: p.nextStep || '', placeholder: 'Одно конкретное действие, которое двигает проект' })}
      ${field({ name: 'tags', label: 'Теги', value: (p.tags || []).join(', '), placeholder: 'через запятую: работа, клиент, личное' })}
      ${field({ name: 'notes', label: 'Заметки', type: 'textarea', value: p.notes || '', rows: 6, placeholder: 'Контакты, договорённости, решения, ссылки на документы — всё, что нужно держать под рукой' })}
    </div>`,
    onSubmit: (d) => {
      const status = STATUSES[d.status] ? d.status : 'active';
      const patch = {
        name: d.name.trim(), description: d.description || '', status,
        priority: Number(d.priority) || 2, deadline: d.deadline || null,
        progress: status === 'done' ? 100 : clamp(Number(d.progress) || 0, 0, 100),
        nextStep: d.nextStep || '', link: d.link || '', tags: parseTags(d.tags), notes: d.notes || '',
      };
      if (status === 'done' && p.status !== 'done') patch.finishedAt = today();
      if (status !== 'done') patch.finishedAt = null;
      if (isNew) { db.add('projects', { ...patch, color: p.color, log: [], startedAt: today() }); toast('Проект добавлен'); }
      else { db.update('projects', p.id, patch); toast('Проект сохранён'); }
    },
    onDelete: isNew ? undefined : () => {
      for (const x of db.where('tasks', x => x.projectId === p.id)) db.update('tasks', x.id, { projectId: null, streamId: null });
      for (const st of db.where('streams', st => st.projectId === p.id)) db.remove('streams', st.id);
      db.remove('projects', p.id); toast('Проект удалён');
    },
  });
}

function openLogModal(project) {
  modal({
    title: `Запись: ${project.name}`,
    submitText: 'Записать',
    body: `<div class="form">
      ${field({ name: 'text', label: 'Что произошло', type: 'textarea', value: '', rows: 4, required: true, placeholder: 'Созвон, решение, проблема, идея — коротко, своими словами', autofocus: true })}
      ${formRow(
        field({ name: 'date', label: 'Дата', type: 'date', value: today() }),
        field({ name: 'progress', label: 'Готовность теперь, %', type: 'number', value: project.progress ?? 0, min: 0, max: 100, step: 5 }),
      )}
    </div>`,
    onSubmit: (d) => {
      const text = String(d.text || '').trim();
      if (!text) return false;
      db.update('projects', project.id, (cur) => ({
        ...cur,
        progress: clamp(Number(d.progress) || 0, 0, 100),
        log: [{ id: uid(), date: d.date || today(), text }, ...(cur.log || [])],
      }));
      openLog.add(project.id);
      toast('Записано');
    },
  });
}

// ---------- Карточка ----------
function projectCard(p, t) {
  const isDone = p.status === 'done';
  const [statusLabel, statusCls] = STATUSES[p.status] || STATUSES.active;
  const [priLabel, priCls] = PRIORITY[p.priority] || PRIORITY[2];
  const pct = clamp(Number(p.progress) || 0, 0, 100);
  let deadlineHtml = '';
  let late = false;
  if (p.deadline) {
    const n = daysBetween(t, p.deadline);
    late = n < 0 && !isDone;
    const txt = isDone ? 'завершён' : n < 0 ? `просрочено на ${-n} ${dayWord(-n)}` : n === 0 ? 'дедлайн сегодня' : `осталось ${n} ${dayWord(n)}`;
    deadlineHtml = `<span class="${late ? 'bad bold' : 'muted'}">${icon('calendar')} ${esc(fmtDate(p.deadline, { relative: false }))} · ${txt}</span>`;
  }
  const log = p.log || [];
  const expanded = openLog.has(p.id);
  const shown = expanded ? log : log.slice(0, 1);
  const logHtml = log.length ? `<div class="plog">
      ${shown.map(e => `<div class="plog-item"><span class="plog-date mono">${esc(fmtDate(e.date))}</span><span class="plog-text">${esc(e.text)}</span>
        <button type="button" class="icon-btn sm plog-del" data-action="del-log" data-id="${esc(p.id)}" data-log="${esc(e.id)}" aria-label="Удалить запись">${icon('x')}</button></div>`).join('')}
      ${log.length > 1 ? `<button type="button" class="link" data-action="toggle-log" data-id="${esc(p.id)}">${expanded ? 'Свернуть' : `Ещё ${log.length - 1} ${plural(log.length - 1, 'запись', 'записи', 'записей')}`}</button>` : ''}
    </div>` : '';
  return `<div class="card stack tight pcard ${isDone ? 'is-done' : ''}" style="--pc:${esc(p.color || 'var(--c1)')}">
    <div class="row between">
      <span class="row" style="gap:6px;flex-wrap:wrap">
        <span class="pill ${statusCls}">${esc(statusLabel)}</span>
        ${p.priority === 1 && !isDone ? `<span class="pill ${priCls}">${esc(priLabel)} приоритет</span>` : ''}
      </span>
      <span class="row" style="gap:4px">
        ${p.link ? `<a class="icon-btn sm" href="${esc(p.link)}" target="_blank" rel="noopener" aria-label="Открыть ссылку" data-tip="Открыть ссылку">${icon('arrowUp')}</a>` : ''}
        <button type="button" class="icon-btn sm" data-action="edit" data-id="${esc(p.id)}" aria-label="Редактировать" data-tip="Редактировать">${icon('edit')}</button>
      </span>
    </div>
    <a class="pcard-title" href="#/projects?id=${esc(p.id)}">${esc(p.name)} ${icon('chevronRight')}</a>
    ${p.description ? `<div class="small muted pcard-desc">${esc(p.description)}</div>` : ''}
    <div class="row" style="gap:8px">${progressBar(pct, 100, `grow ${isDone ? 'good' : late ? 'bad' : ''}`)}<span class="tiny bold mono" style="min-width:36px;text-align:right">${pct}%</span></div>
    ${deadlineHtml ? `<div class="tiny row" style="gap:6px">${deadlineHtml}</div>` : ''}
    ${p.nextStep && !isDone ? `<div class="pcard-next"><span class="tiny faint">Следующий шаг</span><div class="small">${icon('zap')} ${esc(p.nextStep)}</div></div>` : ''}
    ${(p.tags || []).length ? `<div class="row wrap" style="gap:5px">${p.tags.map(tg => `<span class="tag">${esc(tg)}</span>`).join('')}</div>` : ''}
    ${logHtml}
    ${(() => { const tk = db.where('tasks', x => x.projectId === p.id); const st = db.where('streams', x => x.projectId === p.id); return tk.length || st.length ? `<div class="tiny muted row" style="gap:10px">${st.length ? `<span>${icon('layers')} ${st.length} ${plural(st.length, 'стрим', 'стрима', 'стримов')}</span>` : ''}<span>${icon('check')} задачи ${tk.filter(x => x.done).length}/${tk.length}</span></div>` : ''; })()}
    <div class="row between" style="margin-top:2px">
      <button type="button" class="link" data-action="log" data-id="${esc(p.id)}">+ запись в журнал</button>
      ${p.notes ? `<button type="button" class="link" data-action="notes" data-id="${esc(p.id)}">Заметки</button>` : '<span class="tiny faint">заметок нет</span>'}
    </div>
  </div>`;
}

function openNotes(p) {
  modal({
    title: p.name,
    noForm: true,
    submitText: '',
    cancelText: 'Закрыть',
    body: `<div class="stack">
      ${p.description ? `<div class="small muted">${esc(p.description)}</div><div class="divider"></div>` : ''}
      <div class="pnotes">${esc(p.notes)}</div>
      <div><button type="button" class="btn secondary sm" data-edit-notes>${icon('edit')} Редактировать</button></div>
    </div>`,
    onOpen: (wrap, close) => {
      wrap.querySelector('[data-edit-notes]').addEventListener('click', () => { close(); openProjectModal(p); });
    },
  });
}

// ---------- Стримы ----------
const STREAM_STATUSES = { active: ['В работе', 'accent'], paused: ['На паузе', 'warn'], done: ['Готово', 'good'] };
let showDoneTasks = new Set();   // id проектов, где показаны выполненные задачи

function openStreamModal(stream, projectId) {
  const isNew = !stream;
  const st = stream || { projectId, name: '', description: '', status: 'active', order: db.where('streams', x => x.projectId === projectId).length };
  modal({
    title: isNew ? 'Новый стрим' : 'Стрим',
    body: `<div class="form">
      ${field({ name: 'name', label: 'Название', value: st.name, required: true, placeholder: 'Например: Маркетинг, Разработка, Договор', autofocus: isNew })}
      ${field({ name: 'description', label: 'Что входит', type: 'textarea', value: st.description || '', rows: 3, placeholder: 'Границы стрима, кто отвечает, что считается результатом' })}
      ${field({ name: 'status', label: 'Статус', type: 'select', value: st.status || 'active', options: Object.entries(STREAM_STATUSES).map(([k, [l]]) => [k, l]) })}
    </div>`,
    onSubmit: (d) => {
      const patch = { name: d.name.trim(), description: d.description || '', status: STREAM_STATUSES[d.status] ? d.status : 'active' };
      if (isNew) { db.add('streams', { ...patch, projectId, order: st.order }); toast('Стрим добавлен'); }
      else { db.update('streams', st.id, patch); toast('Сохранено'); }
    },
    onDelete: isNew ? undefined : () => {
      for (const x of db.where('tasks', x => x.streamId === st.id)) db.update('tasks', x.id, { streamId: null });
      db.remove('streams', st.id); toast('Стрим удалён, задачи остались в проекте');
    },
  });
}

const PRI = { 1: '<span class="pill bad">важно</span>', 2: '', 3: '<span class="tag">низко</span>' };
function projectTaskRow(x, t) {
  let when = '';
  if (x.date && !x.done) when = x.date < t ? `<span class="bad bold">${esc(fmtDate(x.date))}</span>` : `<span class="muted">${esc(fmtDate(x.date))}</span>`;
  return `<div class="list-item">
    ${checkBtn(!!x.done, `data-action="task-toggle" data-id="${esc(x.id)}" aria-label="Выполнено"`)}
    <div class="main" data-action="task-edit" data-id="${esc(x.id)}" style="cursor:pointer">
      <div class="title ${x.done ? 'strike' : ''}">${esc(x.title)}</div>
      <div class="sub row wrap" style="gap:6px">${PRI[x.priority] || ''}${when}${x.estimateMin ? `<span class="faint">${esc(fmtMinutes(x.estimateMin))}</span>` : ''}${x.notes ? `<span class="faint ellipsis" style="max-width:240px">${esc(x.notes)}</span>` : ''}</div>
    </div>
  </div>`;
}

function streamCard(st, tasks, t, showDone) {
  const mine = tasks.filter(x => x.streamId === st.id);
  const open = sortBy(mine.filter(x => !x.done), x => `${x.priority || 2}-${x.date || '9999'}`);
  const done = mine.filter(x => x.done);
  const pct = mine.length ? Math.round(done.length / mine.length * 100) : 0;
  const [label, cls] = STREAM_STATUSES[st.status] || STREAM_STATUSES.active;
  return `<div class="card stack tight stream ${st.status === 'done' ? 'is-done' : ''}">
    <div class="row between">
      <div class="row" style="gap:8px"><span class="bold" style="font-size:15px;cursor:pointer" data-action="stream-edit" data-id="${esc(st.id)}">${esc(st.name)}</span><span class="pill ${cls}">${label}</span></div>
      <button type="button" class="btn sm secondary" data-action="task-new" data-stream="${esc(st.id)}">${icon('plus')} Задача</button>
    </div>
    ${st.description ? `<div class="small muted">${esc(st.description)}</div>` : ''}
    ${mine.length ? `<div class="row" style="gap:8px">${progressBar(pct, 100, `grow ${pct === 100 ? 'good' : ''}`)}<span class="tiny mono muted">${done.length}/${mine.length}</span></div>` : ''}
    ${open.length ? `<div class="list">${open.map(x => projectTaskRow(x, t)).join('')}</div>` : `<div class="tiny faint">${mine.length ? 'Все задачи стрима закрыты' : 'Задач пока нет'}</div>`}
    ${showDone && done.length ? `<div class="list" style="opacity:.7">${done.map(x => projectTaskRow(x, t)).join('')}</div>` : ''}
  </div>`;
}

function renderDetail(root, p, navigate) {
  const t = today();
  const tasks = db.where('tasks', x => x.projectId === p.id);
  const streams = sortBy(db.where('streams', x => x.projectId === p.id), x => x.order ?? 0);
  const loose = tasks.filter(x => !x.streamId || !streams.some(s => s.id === x.streamId));
  const looseOpen = sortBy(loose.filter(x => !x.done), x => `${x.priority || 2}-${x.date || '9999'}`);
  const looseDone = loose.filter(x => x.done);
  const showDone = showDoneTasks.has(p.id);
  const doneCount = tasks.filter(x => x.done).length;
  const taskPct = tasks.length ? Math.round(doneCount / tasks.length * 100) : null;
  const isDone = p.status === 'done';
  const [statusLabel, statusCls] = STATUSES[p.status] || STATUSES.active;
  const pct = clamp(Number(p.progress) || 0, 0, 100);
  let deadline = '';
  if (p.deadline) {
    const n = daysBetween(t, p.deadline);
    deadline = isDone ? `завершён ${p.finishedAt ? esc(fmtDate(p.finishedAt)) : ''}` : n < 0 ? `<span class="bad bold">просрочено на ${-n} ${dayWord(-n)}</span>` : `до ${esc(fmtDate(p.deadline, { relative: false }))} · осталось ${n} ${dayWord(n)}`;
  }
  const log = p.log || [];

  root.innerHTML = `<div>
    <div class="page-head">
      <div>
        <div class="eyebrow"><a href="#/projects" class="link">${icon('chevronLeft')} Все проекты</a></div>
        <h1 style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">${esc(p.name)} <span class="pill ${statusCls}" style="font-family:var(--font-body);font-size:11.5px;letter-spacing:0">${esc(statusLabel)}</span></h1>
      </div>
      <div class="actions">
        <button class="btn secondary" data-action="edit" data-id="${esc(p.id)}">${icon('edit')} Проект</button>
        <button class="btn secondary" data-action="stream-new">${icon('layers')} Стрим</button>
        <button class="btn" data-action="task-new">${icon('plus')} Задача</button>
      </div>
    </div>
    <div class="grid-2" style="align-items:start;margin-bottom:14px">
      <div class="card stack tight" style="border-left:3px solid ${esc(p.color || 'var(--c1)')}">
        ${p.description ? `<div class="small">${esc(p.description)}</div>` : '<div class="small faint">Описание не заполнено</div>'}
        <div class="row" style="gap:8px;margin-top:4px">${progressBar(pct, 100, `grow ${isDone ? 'good' : ''}`)}<span class="tiny bold mono" style="min-width:36px;text-align:right">${pct}%</span></div>
        <div class="tiny muted row wrap" style="gap:10px">
          ${deadline ? `<span>${icon('calendar')} ${deadline}</span>` : ''}
          ${taskPct != null ? `<span>${icon('check')} задачи ${doneCount}/${tasks.length} (${taskPct}%)</span>` : ''}
          ${p.priority === 1 ? '<span class="bad">высокий приоритет</span>' : ''}
          ${p.link ? `<a class="link" href="${esc(p.link)}" target="_blank" rel="noopener">${icon('arrowUp')} ссылка</a>` : ''}
        </div>
        ${p.nextStep && !isDone ? `<div class="pcard-next"><span class="tiny faint">Следующий шаг</span><div class="small">${icon('zap')} ${esc(p.nextStep)}</div></div>` : ''}
        ${(p.tags || []).length ? `<div class="row wrap" style="gap:5px">${p.tags.map(tg => `<span class="tag">${esc(tg)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="card stack tight">
        <div class="row between"><h3 style="margin:0">Заметки</h3><button type="button" class="link" data-action="edit" data-id="${esc(p.id)}">Изменить</button></div>
        ${p.notes ? `<div class="pnotes small muted" style="max-height:180px;overflow:auto">${esc(p.notes)}</div>` : '<div class="tiny faint">Контакты, договорённости, решения — всё, что нужно держать под рукой</div>'}
      </div>
    </div>

    <div class="section-title"><h2>Стримы</h2><div class="row" style="gap:10px"><span class="tiny muted">${streams.length ? `${streams.length} · задач ${tasks.length}` : ''}</span><button type="button" class="link" data-action="toggle-done">${showDone ? 'Скрыть выполненные' : `Показать выполненные (${doneCount})`}</button></div></div>
    ${streams.length || loose.length ? `<div class="grid-auto pgrid">
        ${streams.map(st => streamCard(st, tasks, t, showDone)).join('')}
        ${loose.length ? `<div class="card stack tight stream">
          <div class="row between"><span class="bold" style="font-size:15px">Без стрима</span><button type="button" class="btn sm secondary" data-action="task-new">${icon('plus')} Задача</button></div>
          ${looseOpen.length ? `<div class="list">${looseOpen.map(x => projectTaskRow(x, t)).join('')}</div>` : '<div class="tiny faint">Открытых задач нет</div>'}
          ${showDone && looseDone.length ? `<div class="list" style="opacity:.7">${looseDone.map(x => projectTaskRow(x, t)).join('')}</div>` : ''}
        </div>` : ''}
      </div>`
      : `<div class="card">${emptyState('Разбейте проект на стримы — направления работы, например «Маркетинг», «Разработка», «Договор». Внутри каждого живут свои задачи', '🧩')}</div>`}

    <div class="section-title" style="margin-top:22px"><h2>Журнал</h2><button type="button" class="link" data-action="log" data-id="${esc(p.id)}">+ запись</button></div>
    <div class="card">
      ${log.length ? `<div class="plog" style="border:0;padding:0">${log.map(e => `<div class="plog-item"><span class="plog-date mono">${esc(fmtDate(e.date))}</span><span class="plog-text">${esc(e.text)}</span>
        <button type="button" class="icon-btn sm plog-del" data-action="del-log" data-id="${esc(p.id)}" data-log="${esc(e.id)}" aria-label="Удалить запись">${icon('x')}</button></div>`).join('')}</div>`
      : emptyState('Записывайте, что произошло: созвоны, решения, проблемы. Так проект помнит свою историю', '📓')}
    </div></div>`;
  const view = root.firstElementChild;

  on(view, 'click', '[data-action="edit"]', (e, el) => { const x = db.get('projects', el.dataset.id); if (x) openProjectModal(x); });
  on(view, 'click', '[data-action="log"]', () => openLogModal(db.get('projects', p.id) || p));
  on(view, 'click', '[data-action="stream-new"]', () => openStreamModal(null, p.id));
  on(view, 'click', '[data-action="stream-edit"]', (e, el) => { const st = db.get('streams', el.dataset.id); if (st) openStreamModal(st, p.id); });
  on(view, 'click', '[data-action="task-new"]', (e, el) => openTaskModal(null, { defaults: { projectId: p.id, streamId: el.dataset.stream || null, date: null }, lockProject: true }));
  on(view, 'click', '[data-action="task-edit"]', (e, el) => { const x = db.get('tasks', el.dataset.id); if (x) openTaskModal(x); });
  on(view, 'click', '[data-action="task-toggle"]', (e, el) => {
    const x = db.get('tasks', el.dataset.id); if (!x) return;
    db.update('tasks', x.id, x.done ? { done: false, doneAt: null } : { done: true, doneAt: today() });
  });
  on(view, 'click', '[data-action="toggle-done"]', () => { showDoneTasks.has(p.id) ? showDoneTasks.delete(p.id) : showDoneTasks.add(p.id); renderDetail(root, db.get('projects', p.id) || p, navigate); });
  on(view, 'click', '[data-action="del-log"]', (e, el) => {
    if (!confirm('Удалить запись из журнала?')) return;
    db.update('projects', el.dataset.id, (cur) => ({ ...cur, log: (cur.log || []).filter(x => x.id !== el.dataset.log) }));
  });
}

// ---------- Страница ----------
export async function render(root, { params = {}, navigate } = {}) {
  if (params.id) {
    const p = db.get('projects', params.id);
    if (p) return renderDetail(root, p, navigate);
  }
  const t = today();
  const all = db.all('projects');
  const visible = all.filter(p => {
    if (filter === 'all') return true;
    if (filter === 'open') return p.status !== 'done';
    return p.status === filter;
  });
  const order = { active: 0, idea: 1, paused: 2, done: 3 };
  const list = sortBy(visible, p => `${order[p.status] ?? 1}-${p.priority || 2}-${p.deadline || '9999'}`);
  const active = all.filter(p => p.status === 'active');
  const soon = all.filter(p => p.deadline && p.status !== 'done' && daysBetween(t, p.deadline) <= 14);
  const avgPct = active.length ? Math.round(active.reduce((s, p) => s + (Number(p.progress) || 0), 0) / active.length) : 0;
  const doneCount = all.filter(p => p.status === 'done').length;

  root.innerHTML = `<div>
    <div class="page-head">
      <div><div class="eyebrow">Главное</div><h1>Проекты</h1></div>
      <div class="actions"><button class="btn" data-action="new">${icon('plus')} Проект</button></div>
    </div>
    <div class="grid-4" style="margin-bottom:18px">
      <div class="stat"><span class="label">${icon('layers')} В работе</span><span class="value">${active.length}</span><span class="sub">${all.length ? `всего проектов: ${all.length}` : 'пока пусто'}</span></div>
      <div class="stat"><span class="label">${icon('trending')} Средняя готовность</span><span class="value">${avgPct}<small>%</small></span><span class="sub">по активным</span></div>
      <div class="stat"><span class="label">${icon('calendar')} Дедлайны</span><span class="value ${soon.some(p => daysBetween(t, p.deadline) < 0) ? 'bad' : ''}">${soon.length}</span><span class="sub">в ближайшие 2 недели</span></div>
      <div class="stat"><span class="label">${icon('check')} Завершено</span><span class="value">${doneCount}</span><span class="sub">за всё время</span></div>
    </div>
    <div class="chips" style="margin-bottom:14px">${FILTERS.map(([k, l]) => `<button class="chip ${filter === k ? 'active' : ''}" data-filter="${k}">${esc(l)}</button>`).join('')}</div>
    ${list.length
      ? `<div class="grid-auto pgrid">${list.map(p => projectCard(p, t)).join('')}</div>`
      : all.length
        ? `<div class="card">${emptyState('В этом фильтре проектов нет', '🗂')}</div>`
        : `<div class="card">${emptyState('Добавьте первый проект: название, суть и следующий шаг. Журнал внутри карточки поможет помнить, что и когда происходило', '🚀')}</div>`}
  </div>`;
  const view = root.firstElementChild;

  on(view, 'click', '[data-filter]', (e, el) => { filter = el.dataset.filter; render(root); });
  on(view, 'click', '[data-action="new"]', () => openProjectModal(null));
  on(view, 'click', '[data-action="edit"]', (e, el) => { const p = db.get('projects', el.dataset.id); if (p) openProjectModal(p); });
  on(view, 'click', '[data-action="log"]', (e, el) => { const p = db.get('projects', el.dataset.id); if (p) openLogModal(p); });
  on(view, 'click', '[data-action="notes"]', (e, el) => { const p = db.get('projects', el.dataset.id); if (p) openNotes(p); });
  on(view, 'click', '[data-action="toggle-log"]', (e, el) => { const id = el.dataset.id; openLog.has(id) ? openLog.delete(id) : openLog.add(id); render(root); });
  on(view, 'click', '[data-action="del-log"]', (e, el) => {
    if (!confirm('Удалить запись из журнала?')) return;
    db.update('projects', el.dataset.id, (cur) => ({ ...cur, log: (cur.log || []).filter(x => x.id !== el.dataset.log) }));
  });
}
