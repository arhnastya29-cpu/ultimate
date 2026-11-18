import { db, uid } from '../db.js';
import {
  esc, icon, modal, field, formRow, toast, on,
  today, fmtDate, daysBetween, progressBar, emptyState, sortBy, clamp, plural,
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
    onDelete: isNew ? undefined : () => { db.remove('projects', p.id); toast('Проект удалён'); },
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
    <div class="pcard-title" data-action="edit" data-id="${esc(p.id)}">${esc(p.name)}</div>
    ${p.description ? `<div class="small muted pcard-desc">${esc(p.description)}</div>` : ''}
    <div class="row" style="gap:8px">${progressBar(pct, 100, `grow ${isDone ? 'good' : late ? 'bad' : ''}`)}<span class="tiny bold mono" style="min-width:36px;text-align:right">${pct}%</span></div>
    ${deadlineHtml ? `<div class="tiny row" style="gap:6px">${deadlineHtml}</div>` : ''}
    ${p.nextStep && !isDone ? `<div class="pcard-next"><span class="tiny faint">Следующий шаг</span><div class="small">${icon('zap')} ${esc(p.nextStep)}</div></div>` : ''}
    ${(p.tags || []).length ? `<div class="row wrap" style="gap:5px">${p.tags.map(tg => `<span class="tag">${esc(tg)}</span>`).join('')}</div>` : ''}
    ${logHtml}
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

// ---------- Страница ----------
export async function render(root) {
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

  root.innerHTML = `
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
  `;

  on(root, 'click', '[data-filter]', (e, el) => { filter = el.dataset.filter; render(root); });
  on(root, 'click', '[data-action="new"]', () => openProjectModal(null));
  on(root, 'click', '[data-action="edit"]', (e, el) => { const p = db.get('projects', el.dataset.id); if (p) openProjectModal(p); });
  on(root, 'click', '[data-action="log"]', (e, el) => { const p = db.get('projects', el.dataset.id); if (p) openLogModal(p); });
  on(root, 'click', '[data-action="notes"]', (e, el) => { const p = db.get('projects', el.dataset.id); if (p) openNotes(p); });
  on(root, 'click', '[data-action="toggle-log"]', (e, el) => { const id = el.dataset.id; openLog.has(id) ? openLog.delete(id) : openLog.add(id); render(root); });
  on(root, 'click', '[data-action="del-log"]', (e, el) => {
    if (!confirm('Удалить запись из журнала?')) return;
    db.update('projects', el.dataset.id, (cur) => ({ ...cur, log: (cur.log || []).filter(x => x.id !== el.dataset.log) }));
  });
}
