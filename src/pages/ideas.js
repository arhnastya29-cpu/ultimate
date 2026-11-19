// Вкладка «Идеи» внутри раздела «Заметки»: идеи — это заметки `type: 'idea'` (единая модель notes)
// со статусом, оценкой «эффект / усилия», тегами, привязкой к проекту и превращением в проект или задачу.
import { db } from '../db.js';
import { esc, icon, modal, field, formRow, toast, on, today, fmtDate, sortBy, statLine, emptyAction } from '../ui.js';
import { addNote, addTask } from '../model.js';

export const IDEA_STATUSES = {
  new:     ['Новая',       ''],
  maybe:   ['Когда-нибудь', ''],
  inwork:  ['В работе',    'accent'],
  done:    ['Реализована', 'good'],
  dropped: ['Отложена',    'warn'],
};
const STATUS_OPTIONS = Object.entries(IDEA_STATUSES).map(([k, [l]]) => [k, l]);
const LEVELS = [[1, 'низкий'], [2, 'средний'], [3, 'высокий']];
const parseTags = (s) => [...new Set(String(s || '').split(/[,;]/).map(x => x.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))];

let statusFilter = 'open';   // open | new | maybe | inwork | done | dropped | all
let sortMode = 'score';      // score | new

export const isIdea = (n) => n.type === 'idea';
export const allIdeas = () => db.where('notes', isIdea);
export const isOpenIdea = (i) => i.status !== 'done' && i.status !== 'dropped';
const score = (i) => (Number(i.impact) || 2) * 2 - (Number(i.effort) || 2);   // чем выше, тем выгоднее
const ideaDate = (i) => (i.date || i.createdAt || '').slice(0, 10);
export const dots = (n, cls) => `<span class="idea-dots ${cls}">${[1, 2, 3].map(v => `<i class="${v <= (Number(n) || 0) ? 'on' : ''}"></i>`).join('')}</span>`;
// Короткая строка оценки для карточки в общей ленте заметок.
export const ideaMeta = (i) => `<span class="row wrap tiny muted" style="gap:12px"><span>эффект ${dots(i.impact, 'good')}</span><span>усилия ${dots(i.effort, 'warn')}</span></span>`;

export function openIdeaModal(idea, preset = {}) {
  const isNew = !idea;
  const x = idea || { title: '', body: '', status: 'new', impact: 2, effort: 2, tags: [], pinned: false, projectId: null, date: today(), ...preset };
  const tags = [...new Set(db.all('notes').flatMap(z => z.tags || []))].sort((a, b) => a.localeCompare(b, 'ru'));
  const projects = db.all('projects').filter(p => p.status !== 'done' || p.id === x.projectId);
  modal({
    title: isNew ? 'Новая идея' : 'Идея',
    wide: true,
    body: `<div class="form">
      ${field({ name: 'title', label: 'Идея одной строкой', value: x.title, required: true, placeholder: 'Что если…', autofocus: isNew })}
      ${field({ name: 'body', label: 'Подробнее', type: 'textarea', value: x.body || '', rows: 6, placeholder: 'Откуда взялась, кому полезна, с чего начать, что мешает' })}
      ${formRow(
        field({ name: 'status', label: 'Статус', type: 'select', value: x.status || 'new', options: STATUS_OPTIONS }),
        field({ name: 'impact', label: 'Эффект', type: 'select', value: x.impact || 2, options: LEVELS }),
        field({ name: 'effort', label: 'Усилия', type: 'select', value: x.effort || 2, options: LEVELS }),
      )}
      ${formRow(
        field({ name: 'projectId', label: 'Проект', type: 'select', value: x.projectId || '', options: [['', '—'], ...projects.map(p => [p.id, p.name])] }),
        field({ name: 'date', label: 'Дата', type: 'date', value: x.date || today() }),
      )}
      ${field({ name: 'tags', label: 'Теги', value: (x.tags || []).join(', '), placeholder: 'через запятую: продукт, процесс, личное', list: 'ideaTags' })}
      <datalist id="ideaTags">${tags.map(t => `<option value="${esc(t)}">`).join('')}</datalist>
      ${field({ name: 'pinned', label: 'Закрепить сверху', type: 'checkbox', value: !!x.pinned })}
    </div>`,
    onSubmit: (d) => {
      const patch = { type: 'idea', title: d.title.trim(), body: d.body || '', status: IDEA_STATUSES[d.status] ? d.status : 'new', impact: Number(d.impact) || 2, effort: Number(d.effort) || 2, projectId: d.projectId || null, date: d.date || today(), tags: parseTags(d.tags), pinned: !!d.pinned };
      if (isNew) { addNote(patch); toast('Идея записана'); }
      else { db.update('notes', idea.id, patch); toast('Сохранено'); }
    },
    onDelete: isNew ? undefined : () => { db.remove('notes', idea.id); toast('Идея удалена'); },
  });
}

function toProject(i) {
  if (i.projectId && db.get('projects', i.projectId)) { location.hash = `#/projects?id=${i.projectId}`; return; }
  const p = db.add('projects', { name: i.title, description: i.body || '', status: 'active', priority: 2, deadline: null, progress: 0, nextStep: '', link: '', tags: i.tags || [], notes: '', color: 'var(--c1)', log: [{ id: Date.now().toString(36), date: today(), text: 'Проект создан из идеи' }], startedAt: today() });
  db.update('notes', i.id, { status: 'inwork', projectId: p.id });
  toast('Проект создан из идеи');
  location.hash = `#/projects?id=${p.id}`;
}

function toTask(i) {
  addTask({ title: i.title, notes: i.body || '', projectId: i.projectId || null });
  if (i.status === 'new' || i.status === 'maybe') db.update('notes', i.id, { status: 'inwork' });
  toast('Задача добавлена в инбокс');
}

function ideaCard(i) {
  const [label, cls] = IDEA_STATUSES[i.status] || IDEA_STATUSES.new;
  const project = i.projectId ? db.get('projects', i.projectId) : null;
  return `<div class="card ncard idea-card ${i.pinned ? 'is-pinned' : ''}">
    <div class="row between top" style="gap:8px">
      <div class="row wrap" style="gap:6px"><span class="pill ${cls}">${esc(label)}</span>${i.pinned ? `<span class="tag">${icon('star')}</span>` : ''}</div>
      <span class="tiny faint" style="white-space:nowrap">${esc(fmtDate(ideaDate(i)))}</span>
    </div>
    <button type="button" class="ncard-title" data-action="i-edit" data-id="${esc(i.id)}">${esc(i.title)}</button>
    ${i.body ? `<div class="small muted" style="white-space:pre-wrap">${esc(String(i.body).slice(0, 240))}${i.body.length > 240 ? '…' : ''}</div>` : ''}
    <div class="row wrap tiny muted" style="gap:12px"><span>эффект ${dots(i.impact, 'good')}</span><span>усилия ${dots(i.effort, 'warn')}</span>${project ? `<a class="pill accent" href="#/projects?id=${esc(project.id)}">${icon('layers')} ${esc(project.name)}</a>` : ''}</div>
    ${(i.tags || []).length ? `<div class="row wrap" style="gap:5px">${i.tags.map(t => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : ''}
    ${isOpenIdea(i) ? `<div class="row wrap" style="gap:6px;margin-top:auto">
      <button type="button" class="btn sm secondary" data-action="i-task" data-id="${esc(i.id)}">${icon('check')} В задачу</button>
      <button type="button" class="btn sm secondary" data-action="i-project" data-id="${esc(i.id)}">${icon('layers')} ${project ? 'Открыть проект' : 'В проект'}</button>
    </div>` : ''}
  </div>`;
}

export function renderIdeas() {
  const all = allIdeas();
  if (!all.length) return emptyAction({ text: 'Записывайте идеи сразу, как приходят. Оценка «эффект / усилия» подскажет, с чего начать, а кнопки превратят идею в проект или задачу.', action: 'i-new', label: 'Идея' });
  let list = statusFilter === 'all' ? all : statusFilter === 'open' ? all.filter(isOpenIdea) : all.filter(i => i.status === statusFilter);
  list = sortMode === 'score' ? sortBy(list, i => -score(i) * 1000 + (i.createdAt ? 0 : 1)) : sortBy(list, i => ideaDate(i) + (i.createdAt || ''), true);
  list = [...list.filter(i => i.pinned), ...list.filter(i => !i.pinned)];
  const counts = {}; for (const i of all) counts[i.status] = (counts[i.status] || 0) + 1;
  const open = all.filter(isOpenIdea);
  const best = sortBy(open, i => -score(i))[0];
  const chips = [
    `<button class="chip ${statusFilter === 'open' ? 'active' : ''}" data-ifilter="open">Актуальные · ${open.length}</button>`,
    ...Object.entries(IDEA_STATUSES).filter(([k]) => counts[k]).map(([k, [l]]) => `<button class="chip ${statusFilter === k ? 'active' : ''}" data-ifilter="${k}">${esc(l)} · ${counts[k]}</button>`),
    `<button class="chip ${statusFilter === 'all' ? 'active' : ''}" data-ifilter="all">Все · ${all.length}</button>`,
  ];
  return `
    ${statLine([`в копилке <b>${open.length}</b>`, counts.inwork ? `в работе <b>${counts.inwork}</b>` : '', counts.done ? `реализовано <b>${counts.done}</b>` : '', best && open.length > 1 ? `самая выгодная: <b>${esc(best.title.slice(0, 40))}</b>` : ''])}
    <div data-block="ideas-list" data-block-title="Идеи">
      ${list.length ? `<div class="grid-auto ngrid">${list.map(ideaCard).join('')}</div>` : `<div class="card tiny muted" style="text-align:center">В этом фильтре идей нет</div>`}
    </div>
    <details class="nfilter ${chips.length > 4 ? 'many' : 'few'}" open data-block="ideas-filter" data-block-title="Фильтр идей">
      <summary class="btn secondary sm">${icon('filter')} Фильтр</summary>
      <div class="nfilter-body">
        <div class="chips nchips">${chips.join('')}</div>
        <div class="seg"><button type="button" class="${sortMode === 'score' ? 'active' : ''}" data-isort="score">По выгоде</button><button type="button" class="${sortMode === 'new' ? 'active' : ''}" data-isort="new">Новые</button></div>
      </div>
    </details>`;
}

export function bindIdeas(view, rerender) {
  on(view, 'click', '[data-action="i-new"]', () => openIdeaModal(null));
  on(view, 'click', '[data-action="i-edit"]', (e, el) => { const i = db.get('notes', el.dataset.id); if (i) openIdeaModal(i); });
  on(view, 'click', '[data-action="i-task"]', (e, el) => { const i = db.get('notes', el.dataset.id); if (i) toTask(i); });
  on(view, 'click', '[data-action="i-project"]', (e, el) => { const i = db.get('notes', el.dataset.id); if (i) toProject(i); });
  on(view, 'click', '[data-ifilter]', (e, el) => { statusFilter = el.dataset.ifilter; rerender(); });
  on(view, 'click', '[data-isort]', (e, el) => { sortMode = el.dataset.isort; rerender(); });
  syncFilterDetails(view);
}

// На телефоне фильтр из > 4 чипов свёрнут в кнопку «Фильтр»; на широком экране и при ≤ 4 чипах всегда раскрыт.
let filtersOpen = false;
export function syncFilterDetails(view) {
  const mobile = window.matchMedia('(max-width: 860px)').matches;
  view.querySelectorAll('details.nfilter').forEach(d => {
    const collapsible = mobile && d.classList.contains('many');
    d.open = !collapsible || filtersOpen;
    d.addEventListener('toggle', () => { if (collapsible) filtersOpen = d.open; });
  });
}
