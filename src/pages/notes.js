// Заметки: саммери, мысли и цитаты из книг, статей, подкастов, видео, курсов и своих размышлений —
// всё в одном месте, с источником и тегами. Заменяет прежний раздел «Книги и заметки»;
// старые книги и заметки переносятся сюда один раз (см. migrate()).
import { db } from '../db.js';
import { esc, icon, modal, field, formRow, toast, on, today, fmtDate, emptyState, sortBy, plural } from '../ui.js';

export const title = 'Заметки';

// ---------- Справочники ----------
export const SOURCE_TYPES = {
  book:    ['Книга',    'book'],
  article: ['Статья',  'library'],
  podcast: ['Подкаст', 'play'],
  video:   ['Видео',   'play'],
  course:  ['Курс',    'brain'],
  thought: ['Своя мысль', 'zap'],
  other:   ['Другое',  'info'],
};
const KINDS = { summary: 'Саммери', idea: 'Мысль', quote: 'Цитата' };
const SOURCE_OPTIONS = Object.entries(SOURCE_TYPES).map(([k, [l]]) => [k, l]);
const KIND_OPTIONS = Object.entries(KINDS);
const PREVIEW = 260;

// ---------- Локальное состояние ----------
let typeFilter = 'all';     // all | book | article | ...
let tagFilter = null;       // имя тега
let query = '';
let view = 'feed';          // feed | sources
let sort = 'new';           // new | old | source
let expanded = new Set();   // id раскрытых заметок

const parseTags = (s) => [...new Set(String(s || '').split(/[,;]/).map(x => x.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))];
const noteDate = (n) => (n.date || n.updatedAt || n.createdAt || '').slice(0, 10);
const typeOf = (n) => SOURCE_TYPES[n.sourceType] ? n.sourceType : (n.sourceTitle ? 'other' : 'thought');
const stars = (r) => { r = Math.max(0, Math.min(5, Number(r) || 0)); return r ? '★'.repeat(r) + '☆'.repeat(5 - r) : ''; };

// ---------- Перенос старых данных: книги → заметки-саммери, bookId → источник ----------
function migrate() {
  const s = db.settings();
  if (s.notesV >= 2) return;
  const books = db.all('books');
  const byId = Object.fromEntries(books.map(b => [b.id, b]));
  const STATUS = { reading: 'читаю', want: 'хочу прочитать', done: 'прочитано' };
  for (const n of db.all('notes')) {
    const patch = {};
    if (!n.sourceType) {
      const b = n.bookId ? byId[n.bookId] : null;
      patch.sourceType = b ? 'book' : 'thought';
      if (b) { patch.sourceTitle = b.title || ''; patch.sourceAuthor = b.author || ''; }
    }
    if (!n.kind) patch.kind = 'idea';
    if (!n.date) patch.date = (n.createdAt || '').slice(0, 10) || today();
    if (Object.keys(patch).length) db.update('notes', n.id, patch);
  }
  for (const b of books) {
    const id = 'book_' + b.id;              // детерминированный id — на втором устройстве не продублируется
    if (db.get('notes', id)) continue;
    db.add('notes', {
      id, kind: 'summary', sourceType: 'book', sourceTitle: b.title || 'Книга', sourceAuthor: b.author || '', sourceUrl: '',
      title: b.title || 'Книга', body: b.summary || '', rating: b.rating || null,
      tags: ['книга', STATUS[b.status] || ''].filter(Boolean), pinned: false,
      date: (b.finishedAt || b.startedAt || b.createdAt || '').slice(0, 10) || today(), areaId: b.areaId || null,
    });
  }
  db.setSettings({ notesV: 2 });
}

// ---------- Модалка ----------
function openNoteModal(n, preset = {}) {
  const isNew = !n;
  const x = n || { kind: 'idea', sourceType: 'book', sourceTitle: '', sourceAuthor: '', sourceUrl: '', title: '', body: '', tags: [], pinned: false, rating: null, date: today(), ...preset };
  const sources = [...new Set(db.all('notes').map(z => z.sourceTitle).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  const tags = [...new Set(db.all('notes').flatMap(z => z.tags || []))].sort((a, b) => a.localeCompare(b, 'ru'));
  modal({
    title: isNew ? 'Новая заметка' : 'Заметка',
    wide: true,
    body: `<div class="form">
      ${formRow(
        field({ name: 'kind', label: 'Что это', type: 'select', value: x.kind || 'idea', options: KIND_OPTIONS }),
        field({ name: 'sourceType', label: 'Источник', type: 'select', value: x.sourceType || 'book', options: SOURCE_OPTIONS }),
        field({ name: 'date', label: 'Дата', type: 'date', value: x.date || today() }),
      )}
      ${formRow(
        field({ name: 'sourceTitle', label: 'Название источника', value: x.sourceTitle || '', placeholder: 'Книга, статья, выпуск подкаста…', list: 'noteSources' }),
        field({ name: 'sourceAuthor', label: 'Автор / канал', value: x.sourceAuthor || '', placeholder: 'необязательно' }),
      )}
      <datalist id="noteSources">${sources.map(s => `<option value="${esc(s)}">`).join('')}</datalist>
      ${field({ name: 'sourceUrl', label: 'Ссылка', type: 'url', value: x.sourceUrl || '', placeholder: 'https://… (необязательно)' })}
      ${field({ name: 'title', label: 'Заголовок', value: x.title || '', required: true, placeholder: 'Главная мысль одной строкой', autofocus: isNew })}
      ${field({ name: 'body', label: 'Текст', type: 'textarea', value: x.body || '', rows: 9, placeholder: 'Саммери, цитата с контекстом или мысль: что из этого применить и как' })}
      ${field({ name: 'tags', label: 'Теги', value: (x.tags || []).join(', '), placeholder: 'через запятую: продуктивность, лидерство, переговоры', list: 'noteTags' })}
      <datalist id="noteTags">${tags.map(t => `<option value="${esc(t)}">`).join('')}</datalist>
      ${tags.length ? `<div class="row wrap" style="gap:5px;margin-top:-4px">${tags.slice(0, 20).map(t => `<button type="button" class="tag" data-add-tag="${esc(t)}" style="cursor:pointer">#${esc(t)}</button>`).join('')}</div>` : ''}
      ${formRow(
        field({ name: 'rating', label: 'Оценка источника', type: 'select', value: x.rating || '', options: [['', '—'], [5, '★★★★★'], [4, '★★★★'], [3, '★★★'], [2, '★★'], [1, '★']] }),
        field({ name: 'pinned', label: 'Закрепить сверху', type: 'checkbox', value: !!x.pinned }),
      )}
    </div>`,
    onOpen: (wrap) => {
      const tagInput = wrap.querySelector('input[name="tags"]');
      wrap.querySelectorAll('[data-add-tag]').forEach(b => b.addEventListener('click', () => {
        const cur = parseTags(tagInput.value); const t = b.dataset.addTag;
        tagInput.value = (cur.includes(t) ? cur.filter(z => z !== t) : [...cur, t]).join(', ');
      }));
    },
    onSubmit: (d) => {
      const rec = {
        kind: KINDS[d.kind] ? d.kind : 'idea', sourceType: SOURCE_TYPES[d.sourceType] ? d.sourceType : 'other',
        sourceTitle: String(d.sourceTitle || '').trim(), sourceAuthor: String(d.sourceAuthor || '').trim(), sourceUrl: String(d.sourceUrl || '').trim(),
        title: d.title.trim(), body: d.body || '', tags: parseTags(d.tags), pinned: !!d.pinned,
        rating: d.rating ? Number(d.rating) : null, date: d.date || today(),
      };
      if (isNew) { db.add('notes', rec); toast('Заметка добавлена'); }
      else { db.update('notes', n.id, rec); toast('Сохранено'); }
    },
    onDelete: isNew ? undefined : () => { db.remove('notes', n.id); toast('Заметка удалена'); },
  });
}

// ---------- Карточка ----------
function noteCard(n, { showSource = true } = {}) {
  const type = typeOf(n);
  const [typeLabel, typeIcon] = SOURCE_TYPES[type];
  const isOpen = expanded.has(n.id);
  const body = String(n.body || '');
  const long = body.length > PREVIEW;
  const text = isOpen || !long ? body : body.slice(0, PREVIEW).replace(/\s+\S*$/, '') + '…';
  return `<div class="card ncard ${n.pinned ? 'is-pinned' : ''} kind-${esc(n.kind || 'idea')}">
    <div class="row between top" style="gap:8px">
      <div class="row wrap" style="gap:6px">
        <span class="pill ${n.kind === 'quote' ? 'gold' : n.kind === 'summary' ? 'accent' : ''}">${esc(KINDS[n.kind] || 'Мысль')}</span>
        ${showSource ? `<span class="tag">${icon(typeIcon)} ${esc(typeLabel)}</span>` : ''}
        ${n.pinned ? `<span class="tag">${icon('star')}</span>` : ''}
      </div>
      <span class="tiny faint" style="white-space:nowrap">${esc(fmtDate(noteDate(n)))}</span>
    </div>
    <div class="ncard-title" data-action="edit" data-id="${esc(n.id)}">${esc(n.title || 'Без названия')}</div>
    ${showSource && n.sourceTitle ? `<div class="tiny muted ncard-src">${esc(n.sourceTitle)}${n.sourceAuthor ? ` · ${esc(n.sourceAuthor)}` : ''}${n.rating ? ` · <span class="warn">${stars(n.rating)}</span>` : ''}${n.sourceUrl ? ` · <a class="link" href="${esc(n.sourceUrl)}" target="_blank" rel="noopener">ссылка</a>` : ''}</div>` : ''}
    ${text ? `<div class="small ${n.kind === 'quote' ? 'ncard-quote' : 'muted'}" style="white-space:pre-wrap">${esc(text)}</div>` : ''}
    ${long ? `<button type="button" class="link" data-action="toggle" data-id="${esc(n.id)}">${isOpen ? 'Свернуть' : 'Читать дальше'}</button>` : ''}
    ${(n.tags || []).length ? `<div class="row wrap" style="gap:5px;margin-top:auto">${n.tags.map(t => `<button type="button" class="tag ${tagFilter === t ? 'active' : ''}" data-action="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}
  </div>`;
}

// ---------- Страница ----------
export async function render(root) {
  migrate();
  const notes = db.all('notes');
  const month = today().slice(0, 7);
  const counts = {}; for (const n of notes) counts[typeOf(n)] = (counts[typeOf(n)] || 0) + 1;
  const tagCount = {}; for (const n of notes) for (const t of (n.tags || [])) tagCount[t] = (tagCount[t] || 0) + 1;
  const allTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'));
  if (tagFilter && !tagCount[tagFilter]) tagFilter = null;
  const sources = new Set(notes.map(n => n.sourceTitle).filter(Boolean));

  const q = query.trim().toLowerCase();
  let list = notes;
  if (typeFilter !== 'all') list = list.filter(n => typeOf(n) === typeFilter);
  if (tagFilter) list = list.filter(n => (n.tags || []).includes(tagFilter));
  if (q) list = list.filter(n => `${n.title} ${n.body} ${n.sourceTitle} ${n.sourceAuthor} ${(n.tags || []).join(' ')}`.toLowerCase().includes(q));
  if (sort === 'source') list = sortBy(list, n => `${(n.sourceTitle || 'яяя').toLowerCase()}|${noteDate(n)}`);
  else list = sortBy(list, n => noteDate(n) + (n.createdAt || ''), sort === 'new');
  list = [...list.filter(n => n.pinned), ...list.filter(n => !n.pinned)];

  let bodyHtml;
  if (!list.length) {
    bodyHtml = `<div class="card">${emptyState(notes.length ? 'Ничего не найдено по этим фильтрам' : 'Записывайте саммери книг, мысли из статей и подкастов, цитаты. Добавляйте теги, чтобы потом найти всё по теме', '📝')}</div>`;
  } else if (view === 'sources') {
    const groups = new Map();
    for (const n of list) { const k = n.sourceTitle || (typeOf(n) === 'thought' ? 'Свои мысли' : 'Без источника'); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); }
    bodyHtml = [...groups.entries()].map(([k, arr]) => {
      const first = arr[0]; const [typeLabel, typeIcon] = SOURCE_TYPES[typeOf(first)];
      return `<div class="nsource">
        <div class="section-title"><h2>${icon(typeIcon)} ${esc(k)}</h2><span class="tiny muted">${esc(typeLabel)}${first.sourceAuthor ? ` · ${esc(first.sourceAuthor)}` : ''} · ${arr.length} ${plural(arr.length, 'заметка', 'заметки', 'заметок')} <button type="button" class="link" data-action="new" data-source="${esc(first.sourceTitle || '')}" data-type="${esc(typeOf(first))}" data-author="${esc(first.sourceAuthor || '')}">+ ещё</button></span></div>
        <div class="grid-auto ngrid">${arr.map(n => noteCard(n, { showSource: false })).join('')}</div>
      </div>`;
    }).join('');
  } else {
    bodyHtml = `<div class="grid-auto ngrid">${list.map(n => noteCard(n)).join('')}</div>`;
  }

  root.innerHTML = `<div>
    <div class="page-head">
      <div><div class="eyebrow">Развитие</div><h1>Заметки</h1></div>
      <div class="actions"><button class="btn" data-action="new">${icon('plus')} Заметка</button></div>
    </div>
    <div class="grid-3" style="margin-bottom:14px">
      <div class="stat"><span class="label">${icon('pen')} Заметок</span><span class="value">${notes.length}</span><span class="sub">${notes.filter(n => noteDate(n).startsWith(month)).length} в этом месяце</span></div>
      <div class="stat"><span class="label">${icon('library')} Источников</span><span class="value">${sources.size}</span><span class="sub">${counts.book ? `книг: ${counts.book}` : ''}${counts.article ? ` · статей: ${counts.article}` : ''}${counts.podcast ? ` · подкастов: ${counts.podcast}` : ''}</span></div>
      <div class="stat"><span class="label">${icon('star')} Тегов</span><span class="value">${allTags.length}</span><span class="sub">${allTags.slice(0, 3).map(([t]) => '#' + esc(t)).join(' ') || 'добавьте теги к заметкам'}</span></div>
    </div>
    <div class="card" style="margin-bottom:12px;padding:10px 12px">
      <div class="row wrap" style="gap:8px">
        <span class="muted" style="display:grid;place-items:center">${icon('search')}</span>
        <input type="search" class="input grow" data-search placeholder="Поиск по тексту, источнику и тегам…" value="${esc(query)}" style="border:0;background:transparent;padding:6px 4px;min-width:160px">
        <div class="seg">
          <button type="button" class="${view === 'feed' ? 'active' : ''}" data-action="view" data-view="feed">Лента</button>
          <button type="button" class="${view === 'sources' ? 'active' : ''}" data-action="view" data-view="sources">По источникам</button>
        </div>
        <select class="input" data-sort style="width:auto;padding:6px 8px">
          <option value="new" ${sort === 'new' ? 'selected' : ''}>Сначала новые</option>
          <option value="old" ${sort === 'old' ? 'selected' : ''}>Сначала старые</option>
          <option value="source" ${sort === 'source' ? 'selected' : ''}>По источнику</option>
        </select>
      </div>
    </div>
    <div class="chips" style="margin-bottom:8px">
      <button class="chip ${typeFilter === 'all' ? 'active' : ''}" data-action="type" data-type="all">Все · ${notes.length}</button>
      ${Object.entries(SOURCE_TYPES).filter(([k]) => counts[k]).map(([k, [l, ic]]) => `<button class="chip ${typeFilter === k ? 'active' : ''}" data-action="type" data-type="${k}">${icon(ic)} ${esc(l)} · ${counts[k]}</button>`).join('')}
    </div>
    ${allTags.length ? `<div class="chips ntags" style="margin-bottom:14px">
      <button class="chip ${!tagFilter ? 'active' : ''}" data-action="tag" data-tag="">Все теги</button>
      ${allTags.map(([t, c]) => `<button class="chip ${tagFilter === t ? 'active' : ''}" data-action="tag" data-tag="${esc(t)}">#${esc(t)} <span class="faint">${c}</span></button>`).join('')}
    </div>` : ''}
    ${bodyHtml}
  </div>`;
  const page = root.firstElementChild;

  on(page, 'click', '[data-action="new"]', (e, b) => openNoteModal(null, b.dataset.source != null ? { sourceTitle: b.dataset.source, sourceType: b.dataset.type || 'book', sourceAuthor: b.dataset.author || '' } : {}));
  on(page, 'click', '[data-action="edit"]', (e, b) => { const n = db.get('notes', b.dataset.id); if (n) openNoteModal(n); });
  on(page, 'click', '[data-action="toggle"]', (e, b) => { expanded.has(b.dataset.id) ? expanded.delete(b.dataset.id) : expanded.add(b.dataset.id); render(root); });
  on(page, 'click', '[data-action="type"]', (e, b) => { typeFilter = b.dataset.type; render(root); });
  on(page, 'click', '[data-action="tag"]', (e, b) => { tagFilter = b.dataset.tag && b.dataset.tag !== tagFilter ? b.dataset.tag : null; render(root); });
  on(page, 'click', '[data-action="view"]', (e, b) => { view = b.dataset.view; render(root); });
  page.querySelector('[data-sort]').addEventListener('change', (e) => { sort = e.target.value; render(root); });
  const inp = page.querySelector('[data-search]');
  inp.addEventListener('input', () => { query = inp.value; const pos = inp.selectionStart; render(root); const n = root.querySelector('[data-search]'); n.focus(); n.setSelectionRange(pos, pos); });
}
