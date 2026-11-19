// Проекты: список активных проектов, следующие действия, ближайшие дедлайны, проекты без активности;
// страница проекта: стримы и задачи, заметки проекта, журнал. Прогресс — только projectProgress() из model.js.
import { db, uid } from '../db.js';
import { openTaskModal } from './task-modal.js';
import { addNote, toggleTask, projectProgress, tasksOfProject, isMine, isOpen } from '../model.js';
import {
  esc, icon, modal, field, formRow, toast, on,
  today, addDays, fmtDate, daysBetween, progressBar, emptyAction, statLine, pageMenu,
  sortBy, clamp, plural, checkBtn, fmtMinutes,
} from '../ui.js';

export const title = 'Проекты';

// ---------- Локальное состояние страницы ----------
let filter = 'active';            // active | idea | paused | all
const showDoneTasks = new Set();  // id проектов, где показаны выполненные задачи

// ---------- Справочники ----------
const STATUSES = {
  idea:   ['Идея',      ''],
  active: ['В работе',  'accent'],
  paused: ['На паузе',  'warn'],
  done:   ['Завершён',  'good'],
};
const STATUS_OPTIONS = Object.entries(STATUSES).map(([k, [l]]) => [k, l]);
const PRIORITY_OPTIONS = [[1, 'Высокий'], [2, 'Обычный'], [3, 'Низкий']];
const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)'];
const FILTERS = [['active', 'В работе'], ['idea', 'Идеи'], ['paused', 'На паузе'], ['all', 'Все текущие']];
const STREAM_STATUSES = { active: ['В работе', 'accent'], paused: ['На паузе', 'warn'], done: ['Готово', 'good'] };
const INACTIVE_DAYS = 14;

const dayWord = (n) => plural(n, 'день', 'дня', 'дней');
const parseTags = (s) => String(s || '').split(/[,;]/).map(t => t.trim()).filter(Boolean);
const openTasksOf = (p) => tasksOfProject(p.id).filter(x => isOpen(x) && isMine(x));
const notesOfProject = (pid) => sortBy(db.where('notes', n => n.projectId === pid), n => n.date || '', true);
const taskSort = (list) => sortBy(list, x => `${x.date || '9999-99-99'}-${x.priority || 2}`);

// Дата последней активности: правка проекта, запись в журнале, задача или заметка проекта.
function lastActivityOf(p) {
  const dates = [String(p.updatedAt || p.createdAt || '').slice(0, 10), p.startedAt || ''];
  for (const e of p.log || []) dates.push(e.date || '');
  for (const x of tasksOfProject(p.id)) dates.push(String(x.updatedAt || x.createdAt || '').slice(0, 10), String(x.doneAt || '').slice(0, 10));
  for (const n of db.where('notes', n => n.projectId === p.id)) dates.push(n.date || '', String(n.updatedAt || '').slice(0, 10));
  const list = dates.filter(Boolean).sort();
  return list.length ? list.at(-1) : null;
}

function deadlineText(p, t) {
  if (!p.deadline) return '';
  if (p.status === 'done') return `завершён${p.finishedAt ? ' ' + fmtDate(p.finishedAt) : ''}`;
  const n = daysBetween(t, p.deadline);
  if (n < 0) return `просрочено на ${-n} ${dayWord(-n)}`;
  if (n === 0) return 'дедлайн сегодня';
  return `${fmtDate(p.deadline, { relative: false })} · осталось ${n} ${dayWord(n)}`;
}
const isLate = (p, t) => !!p.deadline && p.status !== 'done' && p.deadline < t;

// ---------- Модалки ----------
function openProjectModal(project) {
  const isNew = !project;
  const p = project || {
    name: '', description: '', status: 'active', priority: 2, deadline: null, progress: 0,
    nextStep: '', link: '', tags: [], notes: '', color: COLORS[db.all('projects').length % COLORS.length],
  };
  const hasTasks = !isNew && tasksOfProject(p.id).length > 0;
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
        field({ name: 'progress', label: 'Готовность, %', type: 'number', value: p.progress ?? 0, min: 0, max: 100, step: 5, hint: hasTasks ? `Считается из задач (сейчас ${projectProgress(p)}%). Это поле — запасное, когда задач нет` : 'Запасной вариант: как только появятся задачи, готовность считается из них' }),
        field({ name: 'link', label: 'Ссылка', type: 'url', value: p.link || '', placeholder: 'https://…' }),
      )}
      ${field({ name: 'nextStep', label: 'Следующий шаг', value: p.nextStep || '', placeholder: 'Одно конкретное действие, которое двигает проект' })}
      ${field({ name: 'tags', label: 'Теги', value: (p.tags || []).join(', '), placeholder: 'через запятую: работа, клиент, личное' })}
      ${field({ name: 'notes', label: 'Описание и договорённости', type: 'textarea', value: p.notes || '', rows: 5, placeholder: 'Контакты, договорённости, решения, ссылки на документы — всё, что нужно держать под рукой' })}
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
      for (const n of db.where('notes', n => n.projectId === p.id)) db.update('notes', n.id, { projectId: null });
      db.remove('projects', p.id); toast('Проект удалён');
      if (location.hash.includes('id=' + p.id)) location.hash = '#/projects';
    },
  });
}

function openLogModal(project) {
  const hasTasks = tasksOfProject(project.id).length > 0;
  modal({
    title: `Запись: ${project.name}`,
    submitText: 'Записать',
    body: `<div class="form">
      ${field({ name: 'text', label: 'Что произошло', type: 'textarea', value: '', rows: 4, required: true, placeholder: 'Созвон, решение, проблема, идея — коротко, своими словами', autofocus: true })}
      ${formRow(
        field({ name: 'date', label: 'Дата', type: 'date', value: today() }),
        hasTasks ? '' : field({ name: 'progress', label: 'Готовность теперь, %', type: 'number', value: project.progress ?? 0, min: 0, max: 100, step: 5 }),
      )}
      ${hasTasks ? `<div class="hint">Готовность считается из задач: ${projectProgress(project)}%</div>` : ''}
    </div>`,
    onSubmit: (d) => {
      const text = String(d.text || '').trim();
      if (!text) return false;
      db.update('projects', project.id, (cur) => ({
        ...cur,
        progress: hasTasks ? cur.progress : clamp(Number(d.progress) || 0, 0, 100),
        log: [{ id: uid(), date: d.date || today(), text }, ...(cur.log || [])],
      }));
      toast('Записано');
    },
  });
}

// Простая заметка: заголовок + текст. type: 'note' (заметка проекта) или 'idea' (идея).
// note — существующая запись для редактирования.
function openQuickNoteModal({ type = 'note', projectId = null, note = null } = {}) {
  const isIdea = (note ? note.type : type) === 'idea';
  modal({
    title: note ? (isIdea ? 'Идея' : 'Заметка') : isIdea ? 'Новая идея' : 'Заметка проекта',
    submitText: note ? 'Сохранить' : isIdea ? 'Записать идею' : 'Сохранить',
    body: `<div class="form">
      ${field({ name: 'title', label: 'Заголовок', value: note?.title || '', required: true, placeholder: isIdea ? 'Что за идея' : 'О чём заметка', autofocus: !note })}
      ${field({ name: 'body', label: 'Текст', type: 'textarea', value: note?.body || '', rows: 5, placeholder: isIdea ? 'Суть, зачем это и что даст' : 'Договорённости, детали, ссылки' })}
    </div>`,
    onSubmit: (d) => {
      const title = String(d.title || '').trim();
      if (!title) return false;
      if (note) { db.update('notes', note.id, { title, body: d.body || '' }); toast('Сохранено'); return; }
      const extra = isIdea ? { status: 'new', impact: 2, effort: 2 } : {};
      addNote({ type, projectId, title, body: d.body || '', ...extra });
      toast(isIdea ? 'Идея записана' : 'Заметка добавлена');
    },
    onDelete: note ? () => { db.remove('notes', note.id); toast('Заметка удалена'); } : undefined,
  });
}

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

// ---------- Общие фрагменты ----------
function progressRow(p, { cls = '' } = {}) {
  const pct = projectProgress(p);
  const n = tasksOfProject(p.id).length;
  return `<div class="row pj-progress" style="gap:8px">${progressBar(pct, 100, `grow ${p.status === 'done' || pct === 100 ? 'good' : cls}`)}<span class="tiny bold mono pj-pct">${pct}%</span></div>
    ${n ? `<div class="tiny faint">считается из задач · закрыто ${tasksOfProject(p.id).filter(x => x.done).length} из ${n}</div>` : ''}`;
}

const PRI = { 1: '<span class="pill bad">важно</span>', 2: '', 3: '<span class="tag">низко</span>' };
function taskRow(x, t, { project = null } = {}) {
  let when = '';
  if (x.date && !x.done) when = x.date < t ? `<span class="bad bold">${esc(fmtDate(x.date))}</span>` : `<span class="muted">${esc(fmtDate(x.date))}</span>`;
  return `<div class="list-item pj-task">
    ${checkBtn(!!x.done, `data-action="task-toggle" data-id="${esc(x.id)}" aria-label="Выполнено"`)}
    <div class="main" data-action="task-edit" data-id="${esc(x.id)}" role="button" tabindex="0">
      <div class="title ${x.done ? 'strike' : ''}">${esc(x.title)}</div>
      <div class="sub row wrap" style="gap:6px">${PRI[x.priority] || ''}${when}${project ? `<a class="pj-proj-link" href="#/projects?id=${esc(project.id)}">${icon('layers')} ${esc(project.name)}</a>` : ''}${x.estimateMin ? `<span class="faint">${esc(fmtMinutes(x.estimateMin))}</span>` : ''}${x.notes && !project ? `<span class="faint ellipsis" style="max-width:240px">${esc(x.notes)}</span>` : ''}</div>
    </div>
  </div>`;
}

function logList(p, { limit = null } = {}) {
  const log = limit ? (p.log || []).slice(0, limit) : (p.log || []);
  return `<div class="plog pj-log">${log.map(e => `<div class="plog-item"><span class="plog-date mono">${esc(fmtDate(e.date))}</span><span class="plog-text">${esc(e.text)}</span>
    <button type="button" class="icon-btn sm plog-del" data-action="del-log" data-id="${esc(p.id)}" data-log="${esc(e.id)}" aria-label="Удалить запись">${icon('x')}</button></div>`).join('')}</div>`;
}

// ---------- Карточка проекта в списке ----------
function projectCard(p, t) {
  const isDone = p.status === 'done';
  const [statusLabel, statusCls] = STATUSES[p.status] || STATUSES.active;
  const late = isLate(p, t);
  const open = openTasksOf(p).length;
  const dl = deadlineText(p, t);
  return `<div class="card stack tight pcard pj-card ${isDone ? 'is-done' : ''}" style="--pc:${esc(p.color || 'var(--c1)')}">
    <div class="row between">
      <span class="row wrap" style="gap:6px">
        <span class="pill ${statusCls}">${esc(statusLabel)}</span>
        ${p.priority === 1 && !isDone ? '<span class="pill bad">высокий приоритет</span>' : ''}
      </span>
      <button type="button" class="icon-btn sm" data-action="edit" data-id="${esc(p.id)}" aria-label="Редактировать проект" data-tip="Редактировать">${icon('edit')}</button>
    </div>
    <a class="pcard-title" href="#/projects?id=${esc(p.id)}">${esc(p.name)} ${icon('chevronRight')}</a>
    ${progressRow(p, { cls: late ? 'bad' : '' })}
    ${p.nextStep && !isDone ? `<div class="pcard-next"><span class="tiny faint">Следующий шаг</span><div class="small">${icon('zap')} ${esc(p.nextStep)}</div></div>` : ''}
    <div class="tiny muted row wrap pj-meta" style="gap:10px">
      ${dl ? `<span class="${late ? 'bad bold' : ''}">${icon('calendar')} ${esc(dl)}</span>` : ''}
      <span>${icon('check')} ${open ? `${open} ${plural(open, 'открытая задача', 'открытые задачи', 'открытых задач')}` : 'открытых задач нет'}</span>
    </div>
  </div>`;
}

// ---------- Список проектов ----------
function renderList(root) {
  const t = today();
  const all = db.all('projects');
  const menu = pageMenu([
    { label: 'Записать идею', action: 'idea', icon: 'zap' },
    { label: 'Настроить страницу', action: 'customize', icon: 'sliders' },
  ]);
  const head = `<div class="page-head">
      <div><div class="eyebrow">Работа</div><h1>Проекты</h1></div>
      <div class="actions"><button type="button" class="btn" data-action="new">${icon('plus')} Проект</button>${menu}</div>
    </div>`;

  if (!all.length) {
    root.innerHTML = `<div>${head}${emptyAction({ text: 'Активных проектов пока нет. Заведите первый: название, суть и следующий шаг — а задачи и журнал будут жить внутри.', action: 'new', label: 'Создать проект', second: { action: 'idea', label: 'Записать идею' } })}</div>`;
    bindList(root);
    return;
  }

  const current = all.filter(p => p.status !== 'done');
  const active = all.filter(p => p.status === 'active');
  const finished = sortBy(all.filter(p => p.status === 'done'), p => p.finishedAt || p.updatedAt || '', true);
  const weekEnd = addDays(t, 7);
  const weekDl = current.filter(p => p.deadline && p.deadline >= t && p.deadline <= weekEnd).length;
  const overdue = current.filter(p => isLate(p, t)).length;
  const stats = statLine([
    active.length ? `${active.length} ${plural(active.length, 'активный', 'активных', 'активных')}` : '',
    weekDl ? `${weekDl} ${plural(weekDl, 'дедлайн', 'дедлайна', 'дедлайнов')} на неделе` : '',
    overdue ? [`${overdue} ${plural(overdue, 'просрочен', 'просрочены', 'просрочены')}`, 'bad'] : '',
  ]);

  // 1) карточки по фильтру
  const visible = filter === 'all' ? current : current.filter(p => p.status === filter);
  const order = { active: 0, idea: 1, paused: 2 };
  const list = sortBy(visible, p => `${order[p.status] ?? 1}-${p.priority || 2}-${p.deadline || '9999'}`);
  const counts = {}; for (const p of current) counts[p.status] = (counts[p.status] || 0) + 1;
  const chips = `<div class="chips pj-chips">${FILTERS.map(([k, l]) => { const n = k === 'all' ? current.length : counts[k] || 0; return `<button type="button" class="chip ${filter === k ? 'active' : ''}" data-filter="${k}" aria-pressed="${filter === k}">${esc(l)}${n ? ` <span class="pj-chip-n">${n}</span>` : ''}</button>`; }).join('')}</div>`;
  const listHtml = list.length
    ? `<div class="grid-auto pgrid">${list.map(p => projectCard(p, t)).join('')}</div>`
    : `<div class="card"><div class="empty">${filter === 'active' ? 'В работе ничего нет. Переведите проект в статус «В работе» или создайте новый' : 'В этом фильтре проектов нет'}</div></div>`;

  // 2) следующие действия: следующий шаг каждого активного проекта + ближайшие открытые задачи проектов
  const steps = active.filter(p => p.nextStep).map(p => ({ p, text: p.nextStep }));
  const tasks = taskSort(active.flatMap(p => openTasksOf(p).filter(x => x.date).map(x => ({ x, p })))).slice(0, 8);
  const nextHtml = steps.length || tasks.length ? `<div class="card pj-next" data-block="next" data-block-title="Следующие действия">
      <div class="section-title"><h2>Следующие действия</h2></div>
      ${steps.length ? `<div class="list">${steps.map(({ p, text }) => `<div class="list-item pj-step">
        <span class="kind-ico">${icon('zap')}</span>
        <div class="main"><div class="title">${esc(text)}</div><div class="sub"><a class="pj-proj-link" href="#/projects?id=${esc(p.id)}">${esc(p.name)}</a></div></div>
        <button type="button" class="btn sm secondary" data-action="step-task" data-id="${esc(p.id)}" aria-label="Сделать задачей">${icon('plus')} В задачу</button>
      </div>`).join('')}</div>` : ''}
      ${tasks.length ? `<div class="list">${tasks.map(({ x, p }) => taskRow(x, t, { project: p })).join('')}</div>` : ''}
    </div>` : '';

  // 3) ближайшие дедлайны проектов (просроченные и в ближайшие 14 дней)
  const soonEnd = addDays(t, 14);
  const soon = sortBy(current.filter(p => p.deadline && p.deadline <= soonEnd), p => p.deadline);
  const soonHtml = soon.length ? `<div class="card" data-block="deadlines" data-block-title="Ближайшие дедлайны">
      <div class="section-title"><h2>Ближайшие дедлайны</h2></div>
      <div class="list">${soon.map(p => { const late = isLate(p, t); const n = daysBetween(t, p.deadline); return `<a class="list-item pj-dl ${late ? 'is-late' : ''}" href="#/projects?id=${esc(p.id)}">
        <span class="kind-ico deadline">${icon('calendar')}</span>
        <div class="main"><div class="title">${esc(p.name)}</div><div class="sub">${esc(fmtDate(p.deadline))} · ${late ? `просрочено на ${-n} ${dayWord(-n)}` : n === 0 ? 'сегодня' : `через ${n} ${dayWord(n)}`}</div></div>
        <span class="tiny mono ${late ? 'bad bold' : 'muted'}">${projectProgress(p)}%</span>
      </a>`; }).join('')}</div>
    </div>` : '';

  // 4) проекты без активности > 14 дней (в работе или на паузе)
  const stale = current.filter(p => p.status !== 'idea').map(p => ({ p, last: lastActivityOf(p) })).filter(({ last }) => !last || daysBetween(last, t) > INACTIVE_DAYS);
  const staleHtml = stale.length ? `<div class="card" data-block="stale" data-block-title="Проекты без активности">
      <div class="section-title"><h2>Проекты без активности</h2><span class="tiny muted">больше ${INACTIVE_DAYS} дней</span></div>
      <div class="list">${stale.map(({ p, last }) => `<div class="list-item pj-stale">
        <span class="kind-ico waiting">${icon('clock')}</span>
        <div class="main"><a class="title pj-link" href="#/projects?id=${esc(p.id)}">${esc(p.name)}</a><div class="sub">${last ? `последняя активность ${esc(fmtDate(last))}` : 'активности не было'}</div></div>
        <button type="button" class="btn sm secondary" data-action="log" data-id="${esc(p.id)}">${icon('pen')} Запись</button>
      </div>`).join('')}</div>
    </div>` : '';

  // 5) аналитика и завершённые
  const avgPct = active.length ? Math.round(active.reduce((s, p) => s + projectProgress(p), 0) / active.length) : 0;
  const openTotal = current.reduce((s, p) => s + openTasksOf(p).length, 0);
  const analyticsLine = statLine([
    active.length ? `средняя готовность активных ${avgPct}%` : '',
    openTotal ? `${openTotal} ${plural(openTotal, 'открытая задача', 'открытые задачи', 'открытых задач')}` : '',
    counts.idea ? `${counts.idea} ${plural(counts.idea, 'идея', 'идеи', 'идей')}` : '',
    counts.paused ? `${counts.paused} на паузе` : '',
    finished.length ? `${finished.length} ${plural(finished.length, 'завершён', 'завершены', 'завершены')}` : '',
  ], 'pj-analytics');
  const moreHtml = analyticsLine || finished.length ? `<details class="acc card pj-acc" data-block="more" data-block-title="Аналитика и завершённые">
      <summary>${icon('chevronDown')} Аналитика и завершённые${finished.length ? ` <span class="tiny muted">(${finished.length})</span>` : ''}</summary>
      <div class="stack" style="margin-top:12px">
        ${analyticsLine}
        ${finished.length ? `<div class="list">${finished.map(p => `<div class="list-item pj-done">
          <span class="kind-ico health">${icon('check')}</span>
          <div class="main"><a class="title pj-link" href="#/projects?id=${esc(p.id)}">${esc(p.name)}</a><div class="sub">${p.finishedAt ? `завершён ${esc(fmtDate(p.finishedAt, { relative: false }))}` : 'завершён'}</div></div>
          <button type="button" class="icon-btn sm" data-action="edit" data-id="${esc(p.id)}" aria-label="Редактировать проект">${icon('edit')}</button>
        </div>`).join('')}</div>` : ''}
      </div>
    </details>` : '';

  root.innerHTML = `<div class="pj">
    ${head}
    ${stats}
    <div data-block="list" data-block-title="Список проектов">
      ${chips}
      ${listHtml}
    </div>
    ${nextHtml}
    ${soonHtml}
    ${staleHtml}
    ${moreHtml}
  </div>`;
  bindList(root);
}

function bindList(root) {
  const view = root.firstElementChild;
  on(view, 'click', '[data-filter]', (e, el) => { filter = el.dataset.filter; renderList(root); });
  on(view, 'click', '[data-action="new"]', () => openProjectModal(null));
  on(view, 'click', '[data-action="idea"]', () => openQuickNoteModal({ type: 'idea' }));
  on(view, 'click', '[data-action="edit"]', (e, el) => { const p = db.get('projects', el.dataset.id); if (p) openProjectModal(p); });
  on(view, 'click', '[data-action="log"]', (e, el) => { const p = db.get('projects', el.dataset.id); if (p) openLogModal(p); });
  on(view, 'click', '[data-action="step-task"]', (e, el) => {
    const p = db.get('projects', el.dataset.id); if (!p) return;
    openTaskModal(null, { defaults: { projectId: p.id, streamId: null, source: 'project', title: p.nextStep || '' }, lockProject: true });
  });
  on(view, 'click', '[data-action="task-toggle"]', (e, el) => toggleTask(el.dataset.id));
  on(view, 'click', '[data-action="task-edit"]', (e, el) => { if (e.target.closest('a')) return; const x = db.get('tasks', el.dataset.id); if (x) openTaskModal(x); });
  on(view, 'keydown', '[data-action="task-edit"]', (e, el) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const x = db.get('tasks', el.dataset.id); if (x) openTaskModal(x); } });
  on(view, 'click', '[data-action="del-log"]', (e, el) => {
    if (!confirm('Удалить запись из журнала?')) return;
    db.update('projects', el.dataset.id, (cur) => ({ ...cur, log: (cur.log || []).filter(x => x.id !== el.dataset.log) }));
  });
}

// ---------- Страница проекта ----------
function streamCard(st, tasks, t, showDone) {
  const mine = tasks.filter(x => x.streamId === st.id);
  const open = taskSort(mine.filter(x => !x.done));
  const done = mine.filter(x => x.done);
  const pct = mine.length ? Math.round(done.length / mine.length * 100) : 0;
  const [label, cls] = STREAM_STATUSES[st.status] || STREAM_STATUSES.active;
  return `<div class="card stack tight stream pj-stream ${st.status === 'done' ? 'is-done' : ''}">
    <div class="row between">
      <div class="row" style="gap:8px;min-width:0"><button type="button" class="pj-stream-name" data-action="stream-edit" data-id="${esc(st.id)}">${esc(st.name)}</button><span class="pill ${cls}">${label}</span></div>
      <button type="button" class="btn sm secondary" data-action="task-new" data-stream="${esc(st.id)}">${icon('plus')} Задача</button>
    </div>
    ${st.description ? `<div class="small muted">${esc(st.description)}</div>` : ''}
    ${mine.length ? `<div class="row" style="gap:8px">${progressBar(pct, 100, `grow ${pct === 100 ? 'good' : ''}`)}<span class="tiny mono muted">${done.length}/${mine.length}</span></div>` : ''}
    ${open.length ? `<div class="list">${open.map(x => taskRow(x, t)).join('')}</div>` : `<div class="tiny faint">${mine.length ? 'Все задачи стрима закрыты' : 'Задач пока нет'}</div>`}
    ${showDone && done.length ? `<div class="list pj-done-list">${done.map(x => taskRow(x, t)).join('')}</div>` : ''}
  </div>`;
}

function renderDetail(root, p) {
  const t = today();
  const tasks = tasksOfProject(p.id);
  const streams = sortBy(db.where('streams', x => x.projectId === p.id), x => x.order ?? 0);
  const loose = tasks.filter(x => !x.streamId || !streams.some(s => s.id === x.streamId));
  const looseOpen = taskSort(loose.filter(x => !x.done));
  const looseDone = loose.filter(x => x.done);
  const showDone = showDoneTasks.has(p.id);
  const doneCount = tasks.filter(x => x.done).length;
  const isDone = p.status === 'done';
  const [statusLabel, statusCls] = STATUSES[p.status] || STATUSES.active;
  const late = isLate(p, t);
  const dl = deadlineText(p, t);
  const log = p.log || [];
  const notes = notesOfProject(p.id);
  const openCount = tasks.length - doneCount;

  const menu = pageMenu([
    { label: 'Изменить проект', action: 'edit', icon: 'edit', attrs: `data-id="${esc(p.id)}"` },
    { label: 'Добавить стрим', action: 'stream-new', icon: 'layers' },
    { label: 'Запись в журнал', action: 'log', icon: 'pen', attrs: `data-id="${esc(p.id)}"` },
    { label: 'Заметка проекта', action: 'note-new', icon: 'library' },
    { label: 'Настроить страницу', action: 'customize', icon: 'sliders' },
  ]);

  root.innerHTML = `<div class="pj pj-detail">
    <div class="page-head">
      <div>
        <div class="eyebrow"><a href="#/projects" class="link">${icon('chevronLeft')} Все проекты</a></div>
        <h1 class="pj-h1">${esc(p.name)} <span class="pill ${statusCls}">${esc(statusLabel)}</span></h1>
      </div>
      <div class="actions"><button type="button" class="btn" data-action="task-new">${icon('plus')} Задача</button>${menu}</div>
    </div>
    ${statLine([
      openCount ? `${openCount} ${plural(openCount, 'открытая задача', 'открытые задачи', 'открытых задач')}` : '',
      streams.length ? `${streams.length} ${plural(streams.length, 'стрим', 'стрима', 'стримов')}` : '',
      dl ? [esc(dl), late ? 'bad' : ''] : '',
    ])}

    <div class="card stack tight pj-info" data-block="info" data-block-title="О проекте" style="--pc:${esc(p.color || 'var(--c1)')}">
      ${p.description ? `<div class="small">${esc(p.description)}</div>` : '<div class="small faint">Описание не заполнено</div>'}
      ${progressRow(p)}
      ${p.nextStep && !isDone ? `<div class="pcard-next"><span class="tiny faint">Следующий шаг</span><div class="small">${icon('zap')} ${esc(p.nextStep)}</div></div>` : ''}
      <div class="tiny muted row wrap" style="gap:10px">
        ${p.priority === 1 ? '<span class="bad">высокий приоритет</span>' : ''}
        ${p.link ? `<a class="link" href="${esc(p.link)}" target="_blank" rel="noopener">${icon('arrowUp')} ссылка</a>` : ''}
        ${(p.tags || []).map(tg => `<span class="tag">${esc(tg)}</span>`).join('')}
        <button type="button" class="link" data-action="edit" data-id="${esc(p.id)}">Изменить</button>
      </div>
      ${p.notes ? `<details class="acc pj-notes-acc"><summary class="tiny">${icon('chevronDown')} Описание и договорённости</summary><div class="pnotes small muted" style="margin-top:8px">${esc(p.notes)}</div></details>` : ''}
    </div>

    <div data-block="streams" data-block-title="Стримы и задачи">
      <div class="section-title"><h2>Стримы и задачи</h2><div class="row" style="gap:10px">
        <button type="button" class="link" data-action="stream-new">+ стрим</button>
        ${doneCount ? `<button type="button" class="link" data-action="toggle-done">${showDone ? 'Скрыть выполненные' : `Показать выполненные (${doneCount})`}</button>` : ''}
      </div></div>
      ${streams.length || loose.length ? `<div class="grid-auto pgrid">
        ${streams.map(st => streamCard(st, tasks, t, showDone)).join('')}
        ${loose.length ? `<div class="card stack tight stream pj-stream">
          <div class="row between"><span class="bold" style="font-size:15px">${streams.length ? 'Без стрима' : 'Задачи'}</span><button type="button" class="btn sm secondary" data-action="task-new">${icon('plus')} Задача</button></div>
          ${looseOpen.length ? `<div class="list">${looseOpen.map(x => taskRow(x, t)).join('')}</div>` : '<div class="tiny faint">Открытых задач нет</div>'}
          ${showDone && looseDone.length ? `<div class="list pj-done-list">${looseDone.map(x => taskRow(x, t)).join('')}</div>` : ''}
        </div>` : ''}
      </div>`
      : emptyAction({ text: 'Задач пока нет. Добавьте первую — готовность проекта будет считаться из них.', action: 'task-new', label: 'Добавить задачу', second: { action: 'stream-new', label: 'Создать стрим' } })}
    </div>

    <div data-block="notes" data-block-title="Заметки проекта">
      <div class="section-title"><h2>Заметки проекта</h2><button type="button" class="link" data-action="note-new">+ Заметка</button></div>
      ${notes.length ? `<div class="card"><div class="list pj-notes">${notes.map(n => `<div class="list-item clickable pj-note" data-action="note-edit" data-id="${esc(n.id)}" role="button" tabindex="0">
          <span class="kind-ico">${icon(n.type === 'idea' ? 'zap' : n.type === 'meeting' ? 'users' : 'library')}</span>
          <div class="main"><div class="title">${esc(n.title || String(n.body || '').split('\n')[0] || 'Без названия')}</div>${n.body && n.title ? `<div class="sub ellipsis">${esc(n.body)}</div>` : ''}</div>
          <span class="tiny faint mono">${esc(fmtDate(n.date))}</span>
        </div>`).join('')}</div></div>`
      : '<div class="tiny faint pj-hint">Договорённости, решения, ссылки — заметки с привязкой к проекту собираются здесь</div>'}
    </div>

    <div data-block="log" data-block-title="Журнал">
      <div class="section-title"><h2>Журнал</h2><button type="button" class="link" data-action="log" data-id="${esc(p.id)}">+ запись</button></div>
      ${log.length ? `<div class="card">${logList(p)}</div>` : '<div class="tiny faint pj-hint">Записывайте, что произошло: созвоны, решения, проблемы — так проект помнит свою историю</div>'}
    </div>
  </div>`;
  const view = root.firstElementChild;

  on(view, 'click', '[data-action="edit"]', (e, el) => { const x = db.get('projects', el.dataset.id || p.id); if (x) openProjectModal(x); });
  on(view, 'click', '[data-action="log"]', () => openLogModal(db.get('projects', p.id) || p));
  on(view, 'click', '[data-action="note-new"]', () => openQuickNoteModal({ type: 'note', projectId: p.id }));
  on(view, 'click', '[data-action="note-edit"]', (e, el) => { const n = db.get('notes', el.dataset.id); if (n) openQuickNoteModal({ note: n }); });
  on(view, 'keydown', '[data-action="note-edit"]', (e, el) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const n = db.get('notes', el.dataset.id); if (n) openQuickNoteModal({ note: n }); } });
  on(view, 'click', '[data-action="stream-new"]', () => openStreamModal(null, p.id));
  on(view, 'click', '[data-action="stream-edit"]', (e, el) => { const st = db.get('streams', el.dataset.id); if (st) openStreamModal(st, p.id); });
  on(view, 'click', '[data-action="task-new"]', (e, el) => openTaskModal(null, { defaults: { projectId: p.id, streamId: el.dataset.stream || null, source: 'project' }, lockProject: true }));
  on(view, 'click', '[data-action="task-edit"]', (e, el) => { const x = db.get('tasks', el.dataset.id); if (x) openTaskModal(x); });
  on(view, 'keydown', '[data-action="task-edit"]', (e, el) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const x = db.get('tasks', el.dataset.id); if (x) openTaskModal(x); } });
  on(view, 'click', '[data-action="task-toggle"]', (e, el) => toggleTask(el.dataset.id));
  on(view, 'click', '[data-action="toggle-done"]', () => { showDoneTasks.has(p.id) ? showDoneTasks.delete(p.id) : showDoneTasks.add(p.id); renderDetail(root, db.get('projects', p.id) || p); });
  on(view, 'click', '[data-action="del-log"]', (e, el) => {
    if (!confirm('Удалить запись из журнала?')) return;
    db.update('projects', el.dataset.id, (cur) => ({ ...cur, log: (cur.log || []).filter(x => x.id !== el.dataset.log) }));
  });
}

// ---------- Страница ----------
export async function render(root, { params = {} } = {}) {
  if (params.id) {
    const p = db.get('projects', params.id);
    if (p) return renderDetail(root, p);
  }
  renderList(root);
}
