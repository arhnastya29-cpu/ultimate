// Вкладка «Идеи» внутри раздела «Заметки»: копилка своих идей со статусом, оценкой
// «эффект / усилия», тегами и превращением идеи в проект или задачу.
import { db } from '../db.js';
import { esc, icon, modal, field, formRow, toast, on, today, fmtDate, emptyState, sortBy, plural } from '../ui.js';

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

const score = (i) => (Number(i.impact) || 2) * 2 - (Number(i.effort) || 2);   // чем выше, тем выгоднее
const localDay = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dots = (n, cls) => `<span class="idea-dots ${cls}">${[1, 2, 3].map(v => `<i class="${v <= (Number(n) || 0) ? 'on' : ''}"></i>`).join('')}</span>`;

function openIdeaModal(idea) {
  const isNew = !idea;
  const x = idea || { title: '', body: '', status: 'new', impact: 2, effort: 2, tags: [], pinned: false };
  const tags = [...new Set(db.all('ideas').flatMap(z => z.tags || []))].sort();
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
      ${field({ name: 'tags', label: 'Теги', value: (x.tags || []).join(', '), placeholder: 'через запятую: продукт, процесс, личное', list: 'ideaTags' })}
      <datalist id="ideaTags">${tags.map(t => `<option value="${esc(t)}">`).join('')}</datalist>
      ${field({ name: 'pinned', label: 'Закрепить сверху', type: 'checkbox', value: !!x.pinned })}
    </div>`,
    onSubmit: (d) => {
      const patch = { title: d.title.trim(), body: d.body || '', status: IDEA_STATUSES[d.status] ? d.status : 'new', impact: Number(d.impact) || 2, effort: Number(d.effort) || 2, tags: parseTags(d.tags), pinned: !!d.pinned };
      if (isNew) { db.add('ideas', patch); toast('Идея записана'); }
      else { db.update('ideas', idea.id, patch); toast('Сохранено'); }
    },
    onDelete: isNew ? undefined : () => { db.remove('ideas', idea.id); toast('Идея удалена'); },
  });
}

function toProject(i) {
  if (i.projectId && db.get('projects', i.projectId)) { location.hash = `#/projects?id=${i.projectId}`; return; }
  const p = db.add('projects', { name: i.title, description: i.body || '', status: 'active', priority: 2, deadline: null, progress: 0, nextStep: '', link: '', tags: i.tags || [], notes: '', color: 'var(--c1)', log: [{ id: Date.now().toString(36), date: today(), text: 'Проект создан из идеи' }], startedAt: today() });
  db.update('ideas', i.id, { status: 'inwork', projectId: p.id });
  toast('Проект создан из идеи');
  location.hash = `#/projects?id=${p.id}`;
}

function toTask(i) {
  db.add('tasks', { title: i.title, date: null, priority: 2, goalId: null, projectId: i.projectId || null, streamId: null, estimateMin: null, notes: i.body || '', recurring: null, done: false, doneAt: null });
  if (i.status === 'new' || i.status === 'maybe') db.update('ideas', i.id, { status: 'inwork' });
  toast('Задача добавлена в инбокс');
}

function ideaCard(i) {
  const [label, cls] = IDEA_STATUSES[i.status] || IDEA_STATUSES.new;
  const project = i.projectId ? db.get('projects', i.projectId) : null;
  return `<div class="card ncard idea-card ${i.pinned ? 'is-pinned' : ''}">
    <div class="row between top" style="gap:8px">
      <div class="row wrap" style="gap:6px"><span class="pill ${cls}">${esc(label)}</span>${i.pinned ? `<span class="tag">${icon('star')}</span>` : ''}</div>
      <span class="tiny faint" style="white-space:nowrap">${esc(fmtDate(localDay(i.createdAt)))}</span>
    </div>
    <div class="ncard-title" data-action="i-edit" data-id="${esc(i.id)}">${esc(i.title)}</div>
    ${i.body ? `<div class="small muted" style="white-space:pre-wrap">${esc(String(i.body).slice(0, 240))}${i.body.length > 240 ? '…' : ''}</div>` : ''}
    <div class="row wrap tiny muted" style="gap:12px"><span>эффект ${dots(i.impact, 'good')}</span><span>усилия ${dots(i.effort, 'warn')}</span>${project ? `<a class="pill accent" href="#/projects?id=${esc(project.id)}">${icon('layers')} ${esc(project.name)}</a>` : ''}</div>
    ${(i.tags || []).length ? `<div class="row wrap" style="gap:5px">${i.tags.map(t => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : ''}
    ${i.status !== 'done' && i.status !== 'dropped' ? `<div class="row wrap" style="gap:6px;margin-top:auto">
      <button type="button" class="btn sm secondary" data-action="i-task" data-id="${esc(i.id)}">${icon('check')} В задачу</button>
      <button type="button" class="btn sm secondary" data-action="i-project" data-id="${esc(i.id)}">${icon('layers')} ${project ? 'Открыть проект' : 'В проект'}</button>
    </div>` : ''}
  </div>`;
}

export function renderIdeas() {
  const all = db.all('ideas');
  let list = statusFilter === 'all' ? all : statusFilter === 'open' ? all.filter(i => i.status !== 'done' && i.status !== 'dropped') : all.filter(i => i.status === statusFilter);
  list = sortMode === 'score' ? sortBy(list, i => -score(i) * 1000 + (i.createdAt ? 0 : 1)) : sortBy(list, i => i.createdAt || '', true);
  list = [...list.filter(i => i.pinned), ...list.filter(i => !i.pinned)];
  const counts = {}; for (const i of all) counts[i.status] = (counts[i.status] || 0) + 1;
  const open = all.filter(i => i.status !== 'done' && i.status !== 'dropped');
  const best = sortBy(open, i => -score(i))[0];
  return `
    <div class="grid-3" style="margin-bottom:14px">
      <div class="stat"><span class="label">${icon('zap')} Идей в копилке</span><span class="value">${open.length}</span><span class="sub">всего ${all.length}</span></div>
      <div class="stat"><span class="label">${icon('trending')} Лучшее соотношение</span><span class="value" style="font-size:16px;line-height:1.3">${best ? esc(best.title.slice(0, 40)) : '—'}</span><span class="sub">${best ? 'большой эффект, мало усилий' : 'добавьте идеи с оценками'}</span></div>
      <div class="stat"><span class="label">${icon('check')} Реализовано</span><span class="value">${counts.done || 0}</span><span class="sub">${counts.inwork ? `в работе: ${counts.inwork}` : ''}</span></div>
    </div>
    <div class="row between wrap" style="gap:8px;margin-bottom:12px">
      <div class="chips" style="padding:0">
        <button class="chip ${statusFilter === 'open' ? 'active' : ''}" data-ifilter="open">Актуальные · ${open.length}</button>
        ${Object.entries(IDEA_STATUSES).filter(([k]) => counts[k]).map(([k, [l]]) => `<button class="chip ${statusFilter === k ? 'active' : ''}" data-ifilter="${k}">${esc(l)} · ${counts[k]}</button>`).join('')}
        <button class="chip ${statusFilter === 'all' ? 'active' : ''}" data-ifilter="all">Все</button>
      </div>
      <div class="seg"><button type="button" class="${sortMode === 'score' ? 'active' : ''}" data-isort="score">По выгоде</button><button type="button" class="${sortMode === 'new' ? 'active' : ''}" data-isort="new">Новые</button></div>
    </div>
    ${list.length ? `<div class="grid-auto ngrid">${list.map(ideaCard).join('')}</div>` : `<div class="card">${emptyState(all.length ? 'В этом фильтре идей нет' : 'Записывайте идеи сразу, как приходят. Оценка «эффект / усилия» подскажет, с чего начать, а кнопки превратят идею в проект или задачу', '💡')}</div>`}`;
}

export function bindIdeas(view, rerender) {
  on(view, 'click', '[data-action="i-new"]', () => openIdeaModal(null));
  on(view, 'click', '[data-action="i-edit"]', (e, el) => { const i = db.get('ideas', el.dataset.id); if (i) openIdeaModal(i); });
  on(view, 'click', '[data-action="i-task"]', (e, el) => { const i = db.get('ideas', el.dataset.id); if (i) toTask(i); });
  on(view, 'click', '[data-action="i-project"]', (e, el) => { const i = db.get('ideas', el.dataset.id); if (i) toProject(i); });
  on(view, 'click', '[data-ifilter]', (e, el) => { statusFilter = el.dataset.ifilter; rerender(); });
  on(view, 'click', '[data-isort]', (e, el) => { sortMode = el.dataset.isort; rerender(); });
}
