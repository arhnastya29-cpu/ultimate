// Заметки: единая лента всех типов (заметка, идея, рекомендация, встреча, инсайт, журнал проекта)
// с фильтрами по типу, тегу, человеку и проекту, общим поиском и переносом в базу знаний.
// Идеи живут в этой же коллекции (`type: 'idea'`), вкладка «Идеи» — в ideas.js.
import { db } from '../db.js';
import { esc, icon, modal, field, formRow, toast, on, today, fmtDate, sortBy, plural, tabs, statLine, emptyAction, pageMenu } from '../ui.js';
import { NOTE_TYPES, NOTE_TYPE_OPTIONS, MEETING_KINDS, addNote, personName } from '../model.js';
import { renderIdeas, bindIdeas, openIdeaModal, IDEA_STATUSES, ideaMeta, syncFilterDetails } from './ideas.js';

export const title = 'Заметки';

// ---------- Справочники ----------
export const SOURCE_TYPES = {
  book:    ['Книга',    'book'],
  article: ['Статья',  'library'],
  podcast: ['Подкаст', 'play'],
  video:   ['Видео',   'play'],
  course:  ['Курс',    'brain'],
  other:   ['Другое',  'info'],
};
const KINDS = { summary: 'Саммери', idea: 'Мысль', quote: 'Цитата' };
const SOURCE_OPTIONS = [['thought', 'Нет — своя мысль'], ...Object.entries(SOURCE_TYPES).map(([k, [l]]) => [k, l])];
const KIND_OPTIONS = Object.entries(KINDS);
const TYPE_CLASS = { note: '', idea: 'accent', recommendation: 'gold', meeting: 'info', insight: 'good', 'project-log': '' };
const TABS = { all: 'Все', notes: 'Заметки', ideas: 'Идеи', sources: 'Из источников' };
const PREVIEW = 260;
const MAX_TAG_CHIPS = 14;

// ---------- Локальное состояние ----------
let tab = 'all';            // all | notes | ideas | sources
let typeFilter = 'all';     // тип заметки (вкладки «Все», «Заметки»)
let srcFilter = 'all';      // тип источника (вкладка «Из источников»)
let tagFilter = null;
let personFilter = null;
let projectFilter = null;
let query = '';
let sort = 'new';           // new | old
let expanded = new Set();   // id раскрытых заметок
let appliedParams = '';     // чтобы параметры адреса применялись один раз, а не при каждой перерисовке

const parseTags = (s) => [...new Set(String(s || '').split(/[,;]/).map(x => x.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))];
const noteDate = (n) => (n.date || n.updatedAt || n.createdAt || '').slice(0, 10);
const typeOf = (n) => NOTE_TYPES[n.type] ? n.type : 'note';
const fromSource = (n) => !!n.sourceTitle || (!!n.sourceType && n.sourceType !== 'thought' && n.sourceType !== 'other');
const srcTypeOf = (n) => SOURCE_TYPES[n.sourceType] ? n.sourceType : 'other';
const stars = (r) => { r = Math.max(0, Math.min(5, Number(r) || 0)); return r ? '★'.repeat(r) + '☆'.repeat(5 - r) : ''; };
const projectName = (id) => (id && db.get('projects', id)?.name) || '';
const goalTitle = (id) => (id && db.get('goals', id)?.title) || '';
const inTab = (n, t) => t === 'ideas' ? n.type === 'idea' : t === 'sources' ? fromSource(n) : t === 'notes' ? n.type !== 'idea' && !fromSource(n) : true;
const hasFilters = () => !!(tagFilter || personFilter || projectFilter || query.trim() || typeFilter !== 'all' || srcFilter !== 'all');
const resetFilters = () => { tagFilter = null; personFilter = null; projectFilter = null; query = ''; typeFilter = 'all'; srcFilter = 'all'; };

// ---------- Модалка заметки ----------
function openNoteModal(n, preset = {}) {
  const isNew = !n;
  const x = n || { type: 'note', title: '', body: '', date: today(), tags: [], personId: null, projectId: null, goalId: null, pinned: false, quote: false, sourceType: 'thought', sourceTitle: '', sourceAuthor: '', sourceUrl: '', kind: 'idea', rating: null, status: 'new', impact: 2, effort: 2, meetingKind: 'meeting', next: '', ...preset };
  const all = db.all('notes');
  const sources = [...new Set(all.map(z => z.sourceTitle).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  const tagCount = {}; for (const z of all) for (const t of (z.tags || [])) tagCount[t] = (tagCount[t] || 0) + 1;
  const tags = Object.keys(tagCount).sort((a, b) => tagCount[b] - tagCount[a] || a.localeCompare(b, 'ru'));
  const people = sortBy(db.all('people'), p => p.name.toLowerCase());
  const projects = db.all('projects').filter(p => p.status !== 'done' || p.id === x.projectId);
  const goals = db.all('goals').filter(g => g.status === 'active' || g.id === x.goalId);
  const srcType = SOURCE_TYPES[x.sourceType] ? x.sourceType : 'thought';
  modal({
    title: isNew ? 'Новая заметка' : NOTE_TYPES[typeOf(x)],
    wide: true,
    body: `<div class="form nform">
      ${formRow(
        field({ name: 'type', label: 'Тип', type: 'select', value: typeOf(x), options: NOTE_TYPE_OPTIONS }),
        field({ name: 'date', label: 'Дата', type: 'date', value: x.date || today() }),
      )}
      ${field({ name: 'title', label: 'Заголовок', value: x.title || '', required: true, placeholder: 'Главная мысль одной строкой', autofocus: isNew })}
      ${field({ name: 'body', label: 'Текст', type: 'textarea', value: x.body || '', rows: 8, placeholder: 'Подробности: что из этого применить и как' })}
      ${field({ name: 'tags', label: 'Теги', value: (x.tags || []).join(', '), placeholder: 'через запятую: продуктивность, лидерство, переговоры', list: 'noteTags' })}
      <datalist id="noteTags">${tags.map(t => `<option value="${esc(t)}">`).join('')}</datalist>
      ${tags.length ? `<div class="row wrap" style="gap:5px;margin-top:-4px">${tags.slice(0, 20).map(t => `<button type="button" class="tag" data-add-tag="${esc(t)}" style="cursor:pointer">#${esc(t)}</button>`).join('')}</div>` : ''}
      ${formRow(
        field({ name: 'personId', label: 'Человек', type: 'select', value: x.personId || '', options: [['', '—'], ...people.map(p => [p.id, p.name])] }),
        field({ name: 'projectId', label: 'Проект', type: 'select', value: x.projectId || '', options: [['', '—'], ...projects.map(p => [p.id, p.name])] }),
        field({ name: 'goalId', label: 'Цель', type: 'select', value: x.goalId || '', options: [['', '—'], ...goals.map(g => [g.id, g.title])] }),
      )}
      <div data-when="idea">${formRow(
        field({ name: 'status', label: 'Статус идеи', type: 'select', value: x.status || 'new', options: Object.entries(IDEA_STATUSES).map(([k, [l]]) => [k, l]) }),
        field({ name: 'impact', label: 'Эффект', type: 'select', value: x.impact || 2, options: [[1, 'низкий'], [2, 'средний'], [3, 'высокий']] }),
        field({ name: 'effort', label: 'Усилия', type: 'select', value: x.effort || 2, options: [[1, 'низкие'], [2, 'средние'], [3, 'высокие']] }),
      )}</div>
      <div data-when="meeting">${formRow(
        field({ name: 'meetingKind', label: 'Формат встречи', type: 'select', value: x.meetingKind || 'meeting', options: Object.entries(MEETING_KINDS) }),
        field({ name: 'next', label: 'Следующий шаг', value: x.next || '', placeholder: 'О чём договорились' }),
      )}</div>
      <div data-when="note">
        ${field({ name: 'sourceType', label: 'Источник', type: 'select', value: srcType, options: SOURCE_OPTIONS })}
        <div class="form" data-src>
          ${formRow(
            field({ name: 'sourceTitle', label: 'Название источника', value: x.sourceTitle || '', placeholder: 'Книга, статья, выпуск подкаста…', list: 'noteSources' }),
            field({ name: 'sourceAuthor', label: 'Автор / канал', value: x.sourceAuthor || '', placeholder: 'необязательно' }),
          )}
          <datalist id="noteSources">${sources.map(s => `<option value="${esc(s)}">`).join('')}</datalist>
          ${formRow(
            field({ name: 'sourceUrl', label: 'Ссылка', type: 'url', value: x.sourceUrl || '', placeholder: 'https://… (необязательно)' }),
            field({ name: 'kind', label: 'Что это', type: 'select', value: KINDS[x.kind] ? x.kind : 'idea', options: KIND_OPTIONS }),
            field({ name: 'rating', label: 'Оценка источника', type: 'select', value: x.rating || '', options: [['', '—'], [5, '★★★★★'], [4, '★★★★'], [3, '★★★'], [2, '★★'], [1, '★']] }),
          )}
        </div>
      </div>
      <div class="row wrap" style="gap:16px">
        ${field({ name: 'pinned', label: 'Закрепить сверху', type: 'checkbox', value: !!x.pinned })}
        ${field({ name: 'quote', label: 'Показывать как цитату (в посланиях)', type: 'checkbox', value: !!x.quote })}
      </div>
    </div>`,
    onOpen: (wrap) => {
      const tagInput = wrap.querySelector('input[name="tags"]');
      wrap.querySelectorAll('[data-add-tag]').forEach(b => b.addEventListener('click', () => {
        const cur = parseTags(tagInput.value); const t = b.dataset.addTag;
        tagInput.value = (cur.includes(t) ? cur.filter(z => z !== t) : [...cur, t]).join(', ');
      }));
      const typeSel = wrap.querySelector('select[name="type"]'), srcSel = wrap.querySelector('select[name="sourceType"]');
      const sync = () => {
        const t = typeSel.value;
        wrap.querySelectorAll('[data-when]').forEach(b => { b.hidden = b.dataset.when !== t; });
        wrap.querySelector('[data-src]').hidden = !(t === 'note' && srcSel.value !== 'thought');
      };
      typeSel.addEventListener('change', sync); srcSel.addEventListener('change', sync); sync();
    },
    onSubmit: (d) => {
      const type = NOTE_TYPES[d.type] ? d.type : 'note';
      const rec = {
        type, title: d.title.trim(), body: d.body || '', date: d.date || today(), tags: parseTags(d.tags),
        personId: d.personId || null, projectId: d.projectId || null, goalId: d.goalId || null,
        pinned: !!d.pinned, quote: !!d.quote,
        sourceType: 'thought', sourceTitle: '', sourceAuthor: '', sourceUrl: '',
      };
      if (type === 'idea') Object.assign(rec, { status: IDEA_STATUSES[d.status] ? d.status : 'new', impact: Number(d.impact) || 2, effort: Number(d.effort) || 2 });
      if (type === 'meeting') Object.assign(rec, { meetingKind: MEETING_KINDS[d.meetingKind] ? d.meetingKind : 'meeting', next: String(d.next || '').trim() });
      if (type === 'note' && SOURCE_TYPES[d.sourceType]) Object.assign(rec, {
        sourceType: d.sourceType, sourceTitle: String(d.sourceTitle || '').trim(), sourceAuthor: String(d.sourceAuthor || '').trim(), sourceUrl: String(d.sourceUrl || '').trim(),
        kind: KINDS[d.kind] ? d.kind : 'idea', rating: d.rating ? Number(d.rating) : null,
      });
      if (isNew) { addNote(rec); toast('Заметка добавлена'); }
      else { db.update('notes', n.id, rec); toast('Сохранено'); }
    },
    onDelete: isNew ? undefined : () => { db.remove('notes', n.id); toast('Заметка удалена'); },
  });
}

// ---------- В базу знаний ----------
function toKb(n) {
  if (n.kbPageId && db.get('kbPages', n.kbPageId)) { location.hash = `#/kb?page=${n.kbPageId}`; return; }
  const sections = sortBy(db.all('kbSections'), s => s.order ?? 0);
  const options = sections.length ? sections.map(s => [s.id, `${s.icon || ''} ${s.name}`]) : [['__new', '📚 Общее (будет создан)']];
  modal({
    title: 'В базу знаний',
    submitText: 'Создать страницу',
    body: `<div class="form">
      <p class="small muted">Из заметки будет создана страница базы знаний. Заметка останется и получит ссылку на неё.</p>
      ${field({ name: 'title', label: 'Название страницы', value: n.title || '', required: true })}
      ${field({ name: 'sectionId', label: 'Раздел', type: 'select', value: options[0][0], options })}
    </div>`,
    onSubmit: (d) => {
      let sectionId = d.sectionId;
      if (sectionId === '__new' || !db.get('kbSections', sectionId)) sectionId = db.add('kbSections', { name: 'Общее', icon: '📚', description: '', order: db.all('kbSections').length }).id;
      const page = db.add('kbPages', { sectionId, title: d.title.trim(), body: n.body || '', tags: [...(n.tags || [])], pinned: false });
      db.update('notes', n.id, { kbPageId: page.id });
      toast('Страница создана в базе знаний');
    },
  });
}

// ---------- Карточка ----------
function noteCard(n, { showSource = true } = {}) {
  const type = typeOf(n);
  const isOpen = expanded.has(n.id);
  const body = String(n.body || '');
  const long = body.length > PREVIEW;
  const text = isOpen || !long ? body : body.slice(0, PREVIEW).replace(/\s+\S*$/, '') + '…';
  const asQuote = n.quote || n.kind === 'quote';
  const person = n.personId ? db.get('people', n.personId) : null;
  const project = n.projectId ? db.get('projects', n.projectId) : null;
  const goal = n.goalId ? db.get('goals', n.goalId) : null;
  const kbPage = n.kbPageId ? db.get('kbPages', n.kbPageId) : null;
  const src = showSource && fromSource(n) ? SOURCE_TYPES[srcTypeOf(n)] : null;
  const [ideaLabel, ideaCls] = type === 'idea' ? (IDEA_STATUSES[n.status] || IDEA_STATUSES.new) : ['', ''];
  return `<div class="card ncard ntype-${esc(type)} ${n.pinned ? 'is-pinned' : ''}">
    <div class="row between top" style="gap:8px">
      <div class="row wrap" style="gap:6px">
        <span class="pill ${TYPE_CLASS[type] || ''}">${esc(NOTE_TYPES[type])}</span>
        ${type === 'idea' ? `<span class="pill ${ideaCls}">${esc(ideaLabel)}</span>` : ''}
        ${type === 'meeting' && n.meetingKind && n.meetingKind !== 'meeting' ? `<span class="tag">${esc(MEETING_KINDS[n.meetingKind] || '')}</span>` : ''}
        ${src ? `<span class="tag">${icon(src[1])} ${esc(src[0])}</span>` : ''}
        ${n.kind === 'quote' && fromSource(n) ? `<span class="tag">${esc(KINDS.quote)}</span>` : ''}
        ${n.pinned ? `<span class="tag" title="Закреплено">${icon('star')}</span>` : ''}
        ${n.quote ? `<span class="tag accent">${icon('zap')} в посланиях</span>` : ''}
      </div>
      <span class="row" style="gap:6px;flex-shrink:0">
        <span class="tiny faint" style="white-space:nowrap">${esc(fmtDate(noteDate(n)))}</span>
        ${type === 'recommendation' ? `<button type="button" class="icon-btn sm ${n.quote ? 'primary' : ''}" data-action="quote-toggle" data-id="${esc(n.id)}" aria-label="${n.quote ? 'Убрать из посланий' : 'Показывать как цитату'}" data-tip="${n.quote ? 'Убрать из посланий' : 'Показывать как цитату на главной и других страницах'}">${icon('zap')}</button>` : ''}
      </span>
    </div>
    <button type="button" class="ncard-title" data-action="edit" data-id="${esc(n.id)}">${esc(n.title || 'Без названия')}</button>
    ${showSource && n.sourceTitle ? `<div class="tiny muted ncard-src">${esc(n.sourceTitle)}${n.sourceAuthor ? ` · ${esc(n.sourceAuthor)}` : ''}${n.rating ? ` · <span class="warn">${stars(n.rating)}</span>` : ''}${n.sourceUrl ? ` · <a class="link" href="${esc(n.sourceUrl)}" target="_blank" rel="noopener">ссылка</a>` : ''}</div>` : ''}
    ${text ? `<div class="small ${asQuote ? 'ncard-quote' : 'muted'}" style="white-space:pre-wrap">${esc(text)}</div>` : ''}
    ${long ? `<button type="button" class="link" data-action="toggle" data-id="${esc(n.id)}">${isOpen ? 'Свернуть' : 'Читать дальше'}</button>` : ''}
    ${type === 'idea' ? ideaMeta(n) : ''}
    ${type === 'meeting' && n.next ? `<div class="tiny"><span class="faint">Дальше:</span> ${esc(n.next)}</div>` : ''}
    ${person || project || goal ? `<div class="row wrap ncard-links" style="gap:6px">
      ${person ? `<button type="button" class="pill ${personFilter === person.id ? 'accent' : ''}" data-action="person" data-id="${esc(person.id)}" title="Показать заметки о человеке">${icon('user')} ${esc(person.name)}</button>` : ''}
      ${project ? `<button type="button" class="pill ${projectFilter === project.id ? 'accent' : ''}" data-action="project" data-id="${esc(project.id)}" title="Показать заметки проекта">${icon('layers')} ${esc(project.name)}</button>` : ''}
      ${goal ? `<span class="pill">${icon('target')} ${esc(goal.title)}</span>` : ''}
    </div>` : ''}
    ${(n.tags || []).length ? `<div class="row wrap" style="gap:5px">${n.tags.map(t => `<button type="button" class="tag ${tagFilter === t ? 'active' : ''}" data-action="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}
    <div class="row wrap ncard-foot" style="gap:10px;margin-top:auto">
      ${kbPage ? `<a class="link" href="#/kb?page=${esc(kbPage.id)}">${icon('folder')} в базе знаний: ${esc(kbPage.title)}</a>` : `<button type="button" class="link faint" data-action="to-kb" data-id="${esc(n.id)}">→ в базу знаний</button>`}
    </div>
  </div>`;
}

// ---------- Страница ----------
export async function render(root, { params = {}, internal = false } = {}) {
  const key = JSON.stringify(params);
  if (!internal && key !== appliedParams) {
    appliedParams = key;
    if (TABS[params.tab]) { tab = params.tab; if (!params.type) typeFilter = 'all'; }
    if (params.person) { personFilter = params.person; tab = tab === 'ideas' ? 'all' : tab; }
    if (params.project) { projectFilter = params.project; tab = tab === 'ideas' ? 'all' : tab; }
    if (params.tag) tagFilter = params.tag;
    if (params.type && NOTE_TYPES[params.type]) { typeFilter = params.type; tab = 'all'; }
    if (params.q != null) query = params.q;
  }
  const notes = db.all('notes');
  const counts = { all: notes.length, notes: 0, ideas: 0, sources: 0 };
  for (const n of notes) { if (n.type === 'idea') counts.ideas++; else if (fromSource(n)) counts.sources++; else counts.notes++; }

  const head = `<div class="page-head">
      <div><div class="eyebrow">Знания</div><h1>Заметки</h1></div>
      <div class="actions">
        <button type="button" class="btn" data-action="new">${icon('plus')} Заметка</button>
        ${pageMenu([{ label: 'Идея', action: 'i-new', icon: 'zap' }, { label: 'Настроить страницу', action: 'customize', icon: 'sliders' }])}
      </div>
    </div>`;
  const rerender = () => render(root, { internal: true });

  if (!notes.length) {
    root.innerHTML = `<div>${head}${emptyAction({ text: 'Одно место для мыслей, идей, рекомендаций и итогов встреч. Теги и связи с людьми и проектами помогут потом всё найти.', action: 'new', label: 'Заметка', second: { action: 'i-new', label: 'Идея' } })}</div>`;
    const v = root.firstElementChild;
    on(v, 'click', '[data-action="new"]', () => openNoteModal(null));
    on(v, 'click', '[data-action="i-new"]', () => openIdeaModal(null));
    return;
  }

  const tabsHtml = tabs(Object.entries(TABS).map(([k, l]) => [k, l, counts[k] || 0]), tab, 'data-tab');

  if (tab === 'ideas') {
    root.innerHTML = `<div>${head}${tabsHtml}${renderIdeas()}</div>`;
    const v = root.firstElementChild;
    on(v, 'click', '[data-tab]', (e, b) => { tab = b.dataset.tab; rerender(); });
    on(v, 'click', '[data-action="new"]', () => openNoteModal(null));
    bindIdeas(v, rerender);
    return;
  }

  // ---- лента ----
  const base = notes.filter(n => inTab(n, tab));
  const typeCount = {}; for (const n of base) typeCount[typeOf(n)] = (typeCount[typeOf(n)] || 0) + 1;
  const srcCount = {}; for (const n of base) srcCount[srcTypeOf(n)] = (srcCount[srcTypeOf(n)] || 0) + 1;
  const tagCount = {}; for (const n of base) for (const t of (n.tags || [])) tagCount[t] = (tagCount[t] || 0) + 1;
  const allTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'));
  if (tab !== 'sources' && typeFilter !== 'all' && !typeCount[typeFilter]) typeFilter = 'all';
  if (tab === 'sources' && srcFilter !== 'all' && !srcCount[srcFilter]) srcFilter = 'all';

  const q = query.trim().toLowerCase();
  let list = base;
  if (tab !== 'sources' && typeFilter !== 'all') list = list.filter(n => typeOf(n) === typeFilter);
  if (tab === 'sources' && srcFilter !== 'all') list = list.filter(n => srcTypeOf(n) === srcFilter);
  if (tagFilter) list = list.filter(n => (n.tags || []).includes(tagFilter));
  if (personFilter) list = list.filter(n => n.personId === personFilter);
  if (projectFilter) list = list.filter(n => n.projectId === projectFilter);
  if (q) list = list.filter(n => `${n.title} ${n.body} ${(n.tags || []).join(' ')} ${personName(n.personId)} ${projectName(n.projectId)} ${n.sourceTitle || ''} ${n.sourceAuthor || ''}`.toLowerCase().includes(q));
  list = sortBy(list, n => noteDate(n) + (n.createdAt || ''), sort === 'new');
  list = [...list.filter(n => n.pinned), ...list.filter(n => !n.pinned)];

  let bodyHtml;
  if (!list.length) {
    bodyHtml = `<div class="card nempty"><span class="muted">${base.length ? 'Ничего не найдено по этим условиям' : tab === 'sources' ? 'Заметок из книг, статей и подкастов пока нет: при добавлении заметки выберите источник' : 'В этой вкладке пока пусто'}</span>${hasFilters() ? `<button type="button" class="link" data-action="reset">Сбросить фильтры</button>` : ''}</div>`;
  } else if (tab === 'sources') {
    const groups = new Map();
    for (const n of list) { const k = n.sourceTitle || 'Без названия'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); }
    bodyHtml = [...groups.entries()].map(([k, arr]) => {
      const first = arr[0]; const [typeLabel, typeIcon] = SOURCE_TYPES[srcTypeOf(first)];
      return `<div class="nsource">
        <div class="section-title"><h2>${icon(typeIcon)} ${esc(k)}</h2><span class="tiny muted">${esc(typeLabel)}${first.sourceAuthor ? ` · ${esc(first.sourceAuthor)}` : ''} · ${arr.length} ${plural(arr.length, 'заметка', 'заметки', 'заметок')} <button type="button" class="link" data-action="new" data-source="${esc(first.sourceTitle || '')}" data-type="${esc(srcTypeOf(first))}" data-author="${esc(first.sourceAuthor || '')}">+ ещё</button></span></div>
        <div class="grid-auto ngrid">${arr.map(n => noteCard(n, { showSource: false })).join('')}</div>
      </div>`;
    }).join('');
  } else {
    bodyHtml = `<div class="grid-auto ngrid">${list.map(n => noteCard(n)).join('')}</div>`;
  }

  // Чипы фильтров: по типу заметки (или типу источника) + теги. На телефоне при > 4 чипах — сворачиваются в «Фильтр».
  const kindChips = tab === 'sources'
    ? [`<button class="chip ${srcFilter === 'all' ? 'active' : ''}" data-action="src" data-src="all">Все · ${base.length}</button>`, ...Object.entries(SOURCE_TYPES).filter(([k]) => srcCount[k]).map(([k, [l, ic]]) => `<button class="chip ${srcFilter === k ? 'active' : ''}" data-action="src" data-src="${k}">${icon(ic)} ${esc(l)} · ${srcCount[k]}</button>`)]
    : [`<button class="chip ${typeFilter === 'all' ? 'active' : ''}" data-action="type" data-type="all">Все · ${base.length}</button>`, ...Object.keys(NOTE_TYPES).filter(k => typeCount[k]).map(k => `<button class="chip ${typeFilter === k ? 'active' : ''}" data-action="type" data-type="${k}">${esc(NOTE_TYPES[k])} · ${typeCount[k]}</button>`)];
  const tagChips = allTags.length ? [`<button class="chip ${!tagFilter ? 'active' : ''}" data-action="tag" data-tag="">Все теги</button>`, ...allTags.slice(0, MAX_TAG_CHIPS).map(([t, c]) => `<button class="chip ${tagFilter === t ? 'active' : ''}" data-action="tag" data-tag="${esc(t)}">#${esc(t)} <span class="faint">${c}</span></button>`)] : [];
  const chipTotal = (kindChips.length > 1 ? kindChips.length : 0) + tagChips.length;
  const activeN = [tagFilter, personFilter, projectFilter, typeFilter !== 'all' && tab !== 'sources', srcFilter !== 'all' && tab === 'sources'].filter(Boolean).length;
  const filtersHtml = chipTotal ? `<details class="nfilter ${chipTotal > 4 ? 'many' : 'few'}" open data-block="filters" data-block-title="Фильтры">
      <summary class="btn secondary sm">${icon('filter')} Фильтр${activeN ? ` · ${activeN}` : ''}</summary>
      <div class="nfilter-body">
        ${kindChips.length > 1 ? `<div class="chips nchips">${kindChips.join('')}</div>` : ''}
        ${tagChips.length ? `<div class="chips nchips ntags">${tagChips.join('')}</div>` : ''}
      </div>
    </details>` : '';
  const activeHtml = (personFilter || projectFilter || tagFilter) ? `<div class="row wrap nactive" style="gap:6px">
      <span class="tiny faint">Показано:</span>
      ${personFilter ? `<button type="button" class="pill accent" data-action="person" data-id="${esc(personFilter)}">${icon('user')} ${esc(personName(personFilter) || 'человек')} ${icon('x')}</button>` : ''}
      ${projectFilter ? `<button type="button" class="pill accent" data-action="project" data-id="${esc(projectFilter)}">${icon('layers')} ${esc(projectName(projectFilter) || 'проект')} ${icon('x')}</button>` : ''}
      ${tagFilter ? `<button type="button" class="pill accent" data-action="tag" data-tag="${esc(tagFilter)}">#${esc(tagFilter)} ${icon('x')}</button>` : ''}
      <button type="button" class="link" data-action="reset">сбросить</button>
    </div>` : '';
  const sourcesN = new Set(notes.filter(fromSource).map(n => n.sourceTitle || '')).size;
  const tagsN = new Set(notes.flatMap(n => n.tags || [])).size;
  const stat = statLine([
    `<b>${notes.length}</b> ${plural(notes.length, 'заметка', 'заметки', 'заметок')}`,
    counts.ideas ? `<b>${counts.ideas}</b> ${plural(counts.ideas, 'идея', 'идеи', 'идей')}` : '',
    sourcesN ? `<b>${sourcesN}</b> ${plural(sourcesN, 'источник', 'источника', 'источников')}` : '',
    tagsN ? `<b>${tagsN}</b> ${plural(tagsN, 'тег', 'тега', 'тегов')}` : '',
  ]);

  root.innerHTML = `<div>
    ${head}
    ${tabsHtml}
    ${stat}
    <div class="nsearch" data-block="search" data-block-title="Поиск">
      <label class="nsearch-box"><span class="muted">${icon('search')}</span><input type="search" data-search placeholder="Поиск: текст, теги, человек, проект, источник…" value="${esc(query)}" aria-label="Поиск по заметкам"></label>
      <select class="input" data-sort aria-label="Порядок">
        <option value="new" ${sort === 'new' ? 'selected' : ''}>Сначала новые</option>
        <option value="old" ${sort === 'old' ? 'selected' : ''}>Сначала старые</option>
      </select>
    </div>
    ${activeHtml}
    <div data-block="list" data-block-title="Список заметок">${bodyHtml}</div>
    ${filtersHtml}
  </div>`;
  const page = root.firstElementChild;

  on(page, 'click', '[data-tab]', (e, b) => { tab = b.dataset.tab; rerender(); });
  on(page, 'click', '[data-action="new"]', (e, b) => openNoteModal(null, b.dataset.source != null ? { sourceTitle: b.dataset.source, sourceType: b.dataset.type || 'book', sourceAuthor: b.dataset.author || '' } : tab === 'sources' ? { sourceType: 'book' } : {}));
  on(page, 'click', '[data-action="i-new"]', () => openIdeaModal(null));
  on(page, 'click', '[data-action="edit"]', (e, b) => { const n = db.get('notes', b.dataset.id); if (!n) return; n.type === 'idea' ? openIdeaModal(n) : openNoteModal(n); });
  on(page, 'click', '[data-action="toggle"]', (e, b) => { expanded.has(b.dataset.id) ? expanded.delete(b.dataset.id) : expanded.add(b.dataset.id); rerender(); });
  on(page, 'click', '[data-action="type"]', (e, b) => { typeFilter = b.dataset.type; rerender(); });
  on(page, 'click', '[data-action="src"]', (e, b) => { srcFilter = b.dataset.src; rerender(); });
  on(page, 'click', '[data-action="tag"]', (e, b) => { tagFilter = b.dataset.tag && b.dataset.tag !== tagFilter ? b.dataset.tag : null; rerender(); });
  on(page, 'click', '[data-action="person"]', (e, b) => { personFilter = personFilter === b.dataset.id ? null : b.dataset.id; rerender(); });
  on(page, 'click', '[data-action="project"]', (e, b) => { projectFilter = projectFilter === b.dataset.id ? null : b.dataset.id; rerender(); });
  on(page, 'click', '[data-action="reset"]', () => { resetFilters(); rerender(); });
  on(page, 'click', '[data-action="to-kb"]', (e, b) => { const n = db.get('notes', b.dataset.id); if (n) toKb(n); });
  on(page, 'click', '[data-action="quote-toggle"]', (e, b) => { const n = db.get('notes', b.dataset.id); if (!n) return; db.update('notes', n.id, { quote: !n.quote }); toast(n.quote ? 'Убрано из посланий' : 'Теперь эта цитата будет появляться на главной и других страницах'); });
  page.querySelector('[data-sort]').addEventListener('change', (e) => { sort = e.target.value; rerender(); });
  const inp = page.querySelector('[data-search]');
  inp.addEventListener('input', () => { query = inp.value; const pos = inp.selectionStart; rerender(); const f = root.querySelector('[data-search]'); if (f) { f.focus(); f.setSelectionRange(pos, pos); } });
  syncFilterDetails(page);
}
