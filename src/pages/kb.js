// База знаний: разделы заводит сам пользователь (iGaming, холдинг, процессы…), внутри — страницы
// с текстом (простая разметка), тегами, закреплением и ссылками [[Название страницы]].
import { db } from '../db.js';
import { esc, icon, modal, field, formRow, toast, on, fmtDate, sortBy, plural, statLine, emptyAction, pageMenu } from '../ui.js';

export const title = 'База знаний';

let sectionId = null;     // выбранный раздел
let pageId = null;        // открытая страница
let editing = false;      // режим редактирования открытой страницы
let query = '';
let tagFilter = null;
let filtersOpen = false;  // телефон: раскрыт ли блок «Фильтр»
let appliedParams = '';

const EMOJIS = ['📚', '🎰', '🏢', '⚙️', '📈', '🧠', '🛠', '💼', '📝', '🌐', '🔐', '🎯'];
const parseTags = (s) => [...new Set(String(s || '').split(/[,;]/).map(x => x.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))];
const pageDate = (p) => (p.updatedAt || p.createdAt || '').slice(0, 10);
const plain = (s) => String(s || '').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/[#*>`-]/g, ' ').replace(/\s+/g, ' ').trim();

// ---------- простая разметка: заголовки, списки, жирный, код, ссылки, [[страницы]] ----------
export function renderMarkup(text, { linkPages = true } = {}) {
  const pages = linkPages ? db.all('kbPages') : [];
  const inline = (s) => esc(s)
    .replace(/\[\[([^\]]+)\]\]/g, (m, name) => { const p = pages.find(x => x.title.toLowerCase() === name.trim().toLowerCase()); return p ? `<a class="link" href="#/kb?page=${esc(p.id)}">${esc(name)}</a>` : `<span class="muted" title="Страницы пока нет">${esc(name)}</span>`; })
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a class="link" href="$1" target="_blank" rel="noopener">$1</a>');
  const lines = String(text || '').split('\n');
  let out = '', list = null;
  const flush = () => { if (list) { out += `<${list.tag}>${list.items.map(i => `<li>${i}</li>`).join('')}</${list.tag}>`; list = null; } };
  for (const raw of lines) {
    let m;
    if ((m = raw.match(/^\s*[-•*]\s+(.*)$/))) { if (!list || list.tag !== 'ul') { flush(); list = { tag: 'ul', items: [] }; } list.items.push(inline(m[1])); continue; }
    if ((m = raw.match(/^\s*\d+[.)]\s+(.*)$/))) { if (!list || list.tag !== 'ol') { flush(); list = { tag: 'ol', items: [] }; } list.items.push(inline(m[1])); continue; }
    flush();
    if ((m = raw.match(/^(#{1,3})\s+(.*)$/))) { out += `<h${m[1].length + 2} class="kb-h">${inline(m[2])}</h${m[1].length + 2}>`; continue; }
    if ((m = raw.match(/^>\s?(.*)$/))) { out += `<blockquote class="kb-quote">${inline(m[1])}</blockquote>`; continue; }
    if (/^\s*---+\s*$/.test(raw)) { out += '<hr class="divider">'; continue; }
    if (raw.trim()) out += `<p>${inline(raw)}</p>`;
  }
  flush();
  return out || '<p class="faint">Пусто</p>';
}

// ---------- Модалки ----------
function openSectionModal(s) {
  const isNew = !s;
  const x = s || { name: '', icon: '📚', description: '' };
  modal({
    title: isNew ? 'Новый раздел' : 'Раздел',
    body: `<div class="form">
      ${formRow(
        field({ name: 'icon', label: 'Иконка', type: 'select', value: x.icon || '📚', options: EMOJIS.map(e => [e, e]) }),
        field({ name: 'name', label: 'Название', value: x.name, required: true, placeholder: 'База знаний по iGaming', autofocus: isNew }),
      )}
      ${field({ name: 'description', label: 'О чём раздел', value: x.description || '', placeholder: 'Коротко: что сюда складываем' })}
    </div>`,
    onSubmit: (d) => {
      const patch = { name: d.name.trim(), icon: d.icon || '📚', description: d.description || '' };
      if (isNew) { const rec = db.add('kbSections', { ...patch, order: db.all('kbSections').length }); sectionId = rec.id; pageId = null; toast('Раздел создан'); }
      else { db.update('kbSections', s.id, patch); toast('Сохранено'); }
    },
    onDelete: isNew ? undefined : () => {
      const n = db.where('kbPages', p => p.sectionId === s.id).length;
      if (n && !confirm(`В разделе ${n} ${plural(n, 'страница', 'страницы', 'страниц')}. Удалить вместе с ними?`)) return;
      for (const p of db.where('kbPages', p => p.sectionId === s.id)) db.remove('kbPages', p.id);
      db.remove('kbSections', s.id); if (sectionId === s.id) sectionId = null; pageId = null; toast('Раздел удалён');
    },
  });
}

function openPageModal(p, presetSection) {
  const isNew = !p;
  const x = p || { sectionId: presetSection || sectionId, title: '', body: '', tags: [], pinned: false };
  const sections = sortBy(db.all('kbSections'), s => s.order ?? 0).map(s => [s.id, `${s.icon || ''} ${s.name}`]);
  if (!sections.length) { openSectionModal(null); return; }
  const tags = [...new Set(db.all('kbPages').flatMap(z => z.tags || []))].sort((a, b) => a.localeCompare(b, 'ru'));
  modal({
    title: isNew ? 'Новая страница' : 'Свойства страницы',
    body: `<div class="form">
      ${field({ name: 'title', label: 'Название', value: x.title, required: true, placeholder: 'Например: Лицензии и регуляторы', autofocus: isNew })}
      ${formRow(
        field({ name: 'sectionId', label: 'Раздел', type: 'select', value: x.sectionId || sections[0][0], options: sections }),
        field({ name: 'tags', label: 'Теги', value: (x.tags || []).join(', '), placeholder: 'через запятую', list: 'kbTags' }),
      )}
      <datalist id="kbTags">${tags.map(t => `<option value="${esc(t)}">`).join('')}</datalist>
      ${isNew ? field({ name: 'body', label: 'Текст', type: 'textarea', value: '', rows: 8, placeholder: '# Заголовок\n- список\n**жирный**, [[Ссылка на другую страницу]]' }) : ''}
      ${field({ name: 'pinned', label: 'Закрепить в разделе', type: 'checkbox', value: !!x.pinned })}
    </div>`,
    onSubmit: (d) => {
      const patch = { title: d.title.trim(), sectionId: d.sectionId, tags: parseTags(d.tags), pinned: !!d.pinned };
      if (isNew) { const rec = db.add('kbPages', { ...patch, body: d.body || '' }); sectionId = rec.sectionId; pageId = rec.id; editing = false; query = ''; toast('Страница создана'); }
      else { db.update('kbPages', p.id, patch); toast('Сохранено'); }
    },
    onDelete: isNew ? undefined : () => { db.remove('kbPages', p.id); if (pageId === p.id) pageId = null; toast('Страница удалена'); },
  });
}

// ---------- Страница ----------
export async function render(root, { params = {}, internal = false } = {}) {
  const key = JSON.stringify(params);
  if (!internal && key !== appliedParams) {
    appliedParams = key;
    if (params.page && db.get('kbPages', params.page)) { pageId = params.page; sectionId = db.get('kbPages', pageId).sectionId; editing = false; query = ''; }
    if (params.q != null) query = params.q;
  }
  const sections = sortBy(db.all('kbSections'), s => s.order ?? 0);
  const pages = db.all('kbPages');
  if (sectionId && !sections.some(s => s.id === sectionId)) sectionId = null;
  if (!sectionId && sections.length) sectionId = sections[0].id;
  if (pageId && !pages.some(p => p.id === pageId)) pageId = null;
  const section = sections.find(s => s.id === sectionId) || null;
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const sectionOf = (p) => sections.find(s => s.id === p.sectionId);
  const current = pageId ? pages.find(p => p.id === pageId) : null;

  const head = `<div class="page-head">
      <div><div class="eyebrow">Знания</div><h1>База знаний</h1></div>
      <div class="actions">
        <button type="button" class="btn" data-action="new-page">${icon('plus')} Страница</button>
        ${pageMenu([
          { label: 'Новый раздел', action: 'new-section', icon: 'folder' },
          section ? { label: 'Настроить раздел', action: 'edit-section', icon: 'settings' } : null,
          current && !searching ? { label: 'Свойства страницы', action: 'props', icon: 'edit' } : null,
          { label: 'Настроить страницу', action: 'customize', icon: 'sliders' },
        ])}
      </div>
    </div>`;
  const rerender = () => render(root, { internal: true });

  if (!sections.length) {
    root.innerHTML = `<div>${head}${emptyAction({ text: 'Разделы — это полки: iGaming, холдинг, процессы. Внутри — страницы с терминами, выводами и договорённостями.', action: 'new-section', label: 'Создать раздел' })}</div>`;
    const v = root.firstElementChild;
    on(v, 'click', '[data-action="new-section"], [data-action="new-page"]', () => openSectionModal(null));
    return;
  }

  // Список страниц: раздел или результаты поиска по всей базе (заголовок, текст, теги).
  const scope = searching ? pages : pages.filter(p => p.sectionId === sectionId);
  let list = scope;
  if (q) list = list.filter(p => `${p.title} ${p.body} ${(p.tags || []).join(' ')}`.toLowerCase().includes(q));
  const tagsHere = [...new Set(scope.flatMap(p => p.tags || []))].sort((a, b) => a.localeCompare(b, 'ru'));
  if (tagFilter && !tagsHere.includes(tagFilter)) tagFilter = null;
  if (tagFilter) list = list.filter(p => (p.tags || []).includes(tagFilter));
  list = [...sortBy(list.filter(p => p.pinned), p => p.title.toLowerCase()), ...sortBy(list.filter(p => !p.pinned), p => pageDate(p), true)];

  const sidebar = `<div class="card kb-side" data-block="sections" data-block-title="Разделы">
      <div class="section-title"><h2>Разделы</h2><button type="button" class="link" data-action="new-section">+ раздел</button></div>
      <div class="kb-sections">${sections.map(s => { const n = pages.filter(p => p.sectionId === s.id).length; return `<button type="button" class="kb-sec ${s.id === sectionId && !searching ? 'active' : ''}" data-action="section" data-id="${esc(s.id)}" aria-pressed="${s.id === sectionId && !searching}"><span class="kb-ico">${esc(s.icon || '📚')}</span><span class="grow ellipsis">${esc(s.name)}</span>${n ? `<span class="tiny faint">${n}</span>` : ''}</button>`; }).join('')}</div>
    </div>`;

  let main;
  if (current && !searching) {
    const s = sectionOf(current);
    main = `<div class="card kb-page" data-block="page" data-block-title="Страница">
      <div class="row between top kb-page-head" style="gap:10px;margin-bottom:10px">
        <div style="min-width:0"><div class="eyebrow">${esc(s ? `${s.icon || ''} ${s.name}` : '')} · <button type="button" class="link" data-action="back">к списку</button></div><h2 class="kb-title">${current.pinned ? '📌 ' : ''}${esc(current.title)}</h2>
          <div class="row wrap tiny muted" style="gap:6px;margin-top:4px">${(current.tags || []).map(tg => `<span class="tag">#${esc(tg)}</span>`).join('')}<span style="white-space:nowrap">обновлено ${esc(fmtDate(pageDate(current)))}</span></div></div>
        <div class="row kb-page-actions" style="gap:6px;flex-shrink:0">
          <button type="button" class="icon-btn sm" data-action="props" aria-label="Свойства страницы" data-tip="Название, раздел, теги">${icon('settings')}</button>
          <button type="button" class="btn sm ${editing ? 'secondary' : ''}" data-action="edit-toggle">${editing ? icon('x') + ' Отмена' : icon('edit') + ' Редактировать'}</button>
        </div>
      </div>
      ${editing
        ? `<form data-editor class="form"><textarea name="body" class="kb-editor" rows="18" placeholder="# Заголовок&#10;- список&#10;**жирный**, \`код\`, [[Ссылка на страницу]]">${esc(current.body || '')}</textarea>
            <div class="row between wrap" style="gap:8px"><span class="tiny faint"># заголовок · - список · **жирный** · [[Название страницы]] для ссылки</span><button class="btn sm" type="submit">${icon('check')} Сохранить</button></div></form>`
        : `<div class="kb-body">${renderMarkup(current.body)}</div>`}
    </div>`;
  } else {
    const tagChips = tagsHere.length ? [`<button class="chip ${!tagFilter ? 'active' : ''}" data-tag="">Все</button>`, ...tagsHere.map(t => `<button class="chip ${tagFilter === t ? 'active' : ''}" data-tag="${esc(t)}">#${esc(t)}</button>`)] : [];
    const filters = tagChips.length ? `<details class="kb-filter ${tagChips.length > 4 ? 'many' : 'few'}" open>
        <summary class="btn secondary sm">${icon('filter')} Фильтр${tagFilter ? ' · 1' : ''}</summary>
        <div class="chips kb-chips">${tagChips.join('')}</div>
      </details>` : '';
    const listHtml = list.length ? `<div class="stack tight">${list.map(p => `<div class="card kb-item" role="button" tabindex="0" data-action="open" data-id="${esc(p.id)}">
          <div class="row between top" style="gap:8px"><div class="bold">${p.pinned ? '📌 ' : ''}${esc(p.title)}</div><span class="tiny faint" style="white-space:nowrap">${esc(fmtDate(pageDate(p)))}</span></div>
          ${searching || plain(p.body) ? `<div class="tiny muted kb-preview">${searching ? `<span class="tag">${esc(sectionOf(p)?.name || '')}</span> ` : ''}${esc(plain(p.body).slice(0, 160))}</div>` : ''}
          ${(p.tags || []).length ? `<div class="row wrap" style="gap:4px;margin-top:6px">${p.tags.map(tg => `<span class="tag">#${esc(tg)}</span>`).join('')}</div>` : ''}
        </div>`).join('')}</div>`
      : searching || tagFilter
        ? `<div class="card kb-empty"><span class="muted">Ничего не найдено</span><button type="button" class="link" data-action="reset">Сбросить</button></div>`
        : emptyAction({ text: `В разделе «${section?.name || ''}» пока нет страниц: процессы, контакты, термины, выводы.`, action: 'new-page', label: 'Страница' });
    main = `<div data-block="pages" data-block-title="Страницы">
      <div class="row between wrap" style="gap:8px;margin-bottom:10px">
        <div class="grow"><h2 style="font-size:18px">${searching ? `Поиск: «${esc(query)}»` : `${esc(section?.icon || '')} ${esc(section?.name || 'База знаний')}`}</h2>${section && !searching && section.description ? `<div class="tiny muted">${esc(section.description)}</div>` : ''}${searching ? `<div class="tiny muted">${list.length} ${plural(list.length, 'страница', 'страницы', 'страниц')} по всей базе</div>` : ''}</div>
      </div>
      ${listHtml}
      ${filters}
    </div>`;
  }

  root.innerHTML = `<div>
    ${head}
    ${statLine([pages.length ? `<b>${pages.length}</b> ${plural(pages.length, 'страница', 'страницы', 'страниц')}` : '', sections.length > 1 ? `<b>${sections.length}</b> ${plural(sections.length, 'раздел', 'раздела', 'разделов')}` : ''])}
    <div class="kb-search" data-block="search" data-block-title="Поиск">
      <label class="kb-search-box"><span class="muted">${icon('search')}</span><input type="search" data-search placeholder="Поиск по всей базе: название, текст, теги…" value="${esc(query)}" aria-label="Поиск по базе знаний"></label>
    </div>
    <div class="kb-layout">${sidebar}<div class="kb-main">${main}</div></div>
  </div>`;
  const view = root.firstElementChild;

  on(view, 'click', '[data-action="new-section"]', () => openSectionModal(null));
  on(view, 'click', '[data-action="edit-section"]', () => { const s = db.get('kbSections', sectionId); if (s) openSectionModal(s); });
  on(view, 'click', '[data-action="section"]', (e, el) => { sectionId = el.dataset.id; pageId = null; query = ''; tagFilter = null; editing = false; rerender(); });
  on(view, 'click', '[data-action="new-page"]', () => openPageModal(null, sectionId));
  on(view, 'click', '[data-action="open"]', (e, el) => { pageId = el.dataset.id; editing = false; const p = db.get('kbPages', pageId); if (p) sectionId = p.sectionId; query = ''; rerender(); });
  view.addEventListener('keydown', (e) => { const el = e.target.closest('.kb-item[data-action="open"]'); if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); el.click(); } });
  on(view, 'click', '[data-action="back"]', () => { pageId = null; editing = false; rerender(); });
  on(view, 'click', '[data-action="props"]', () => { const p = db.get('kbPages', pageId); if (p) openPageModal(p); });
  on(view, 'click', '[data-action="edit-toggle"]', () => { editing = !editing; rerender(); if (editing) setTimeout(() => root.querySelector('.kb-editor')?.focus(), 30); });
  on(view, 'click', '[data-action="reset"]', () => { query = ''; tagFilter = null; rerender(); });
  on(view, 'click', '[data-tag]', (e, el) => { tagFilter = el.dataset.tag || null; rerender(); });
  view.querySelector('[data-editor]')?.addEventListener('submit', (e) => { e.preventDefault(); db.update('kbPages', pageId, { body: e.target.body.value }); editing = false; toast('Сохранено'); });
  const inp = view.querySelector('[data-search]');
  inp.addEventListener('input', () => { query = inp.value; tagFilter = null; const pos = inp.selectionStart; rerender(); const n = root.querySelector('[data-search]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } });
  // На телефоне при > 4 тегах фильтр свёрнут в кнопку; на широком экране всегда раскрыт.
  const mobile = window.matchMedia('(max-width: 860px)').matches;
  view.querySelectorAll('details.kb-filter').forEach(d => {
    const collapsible = mobile && d.classList.contains('many');
    d.open = !collapsible || filtersOpen;
    d.addEventListener('toggle', () => { if (collapsible) filtersOpen = d.open; });
  });
}
