// Модульные страницы. Страница описывает блоки: { id, title, html, col: 1|2, hidden?: true (по умолчанию) }.
// Пользователь через «Настроить страницу» меняет порядок, колонку и видимость; это хранится в
// settings.layouts[pageId] = { order: [id…], col: { id: 1|2 }, hidden: [id…] } и синхронизируется.
//
// Использование на странице:
//   const blocks = [ { id: 'focus', title: 'Фокус дня', col: 1, html: `…` }, … ];
//   root.innerHTML = `<div>${pageHead}${composeBlocks('today', blocks)}</div>`;
//   bindCustomize(root.firstElementChild, 'today', blocks);
import { db } from './db.js';
import { esc, icon, modal, toast } from './ui.js';

export const isNarrow = () => window.matchMedia('(max-width: 860px)').matches;

export function layoutOf(pageId) {
  const all = db.settings().layouts || {};
  const l = all[pageId] || {};
  return { order: Array.isArray(l.order) ? l.order : [], col: l.col || {}, hidden: Array.isArray(l.hidden) ? l.hidden : null };
}

function saveLayout(pageId, layout) {
  const all = { ...(db.settings().layouts || {}) };
  all[pageId] = layout;
  db.setSettings({ layouts: all });
}

// Итоговый список блоков с учётом настроек: порядок, колонка, видимость.
export function resolveBlocks(pageId, blocks) {
  const l = layoutOf(pageId);
  const byId = new Map(blocks.map(b => [b.id, b]));
  const ordered = [...l.order.filter(id => byId.has(id)).map(id => byId.get(id)), ...blocks.filter(b => !l.order.includes(b.id))];
  const hiddenSet = new Set(l.hidden || blocks.filter(b => b.hidden).map(b => b.id));
  return ordered.map(b => ({ ...b, col: l.col[b.id] || b.col || 1, visible: !hiddenSet.has(b.id) }));
}

export function composeBlocks(pageId, blocks) {
  const list = resolveBlocks(pageId, blocks).filter(b => b.visible && b.html);
  const col = (n) => list.filter(b => b.col === n).map(b => `<section class="block" data-block="${esc(b.id)}">${b.html}</section>`).join('');
  const single = list.map(b => `<section class="block" data-block="${esc(b.id)}">${b.html}</section>`).join('');
  if (!list.length) return `<div class="card"><div class="empty">Все блоки скрыты. Нажмите «Настроить страницу», чтобы вернуть нужные.</div></div>`;
  // Десктоп: две колонки по выбранной колонке; телефон: общий порядок одной лентой.
  // Рендерим только один вариант, чтобы id и обработчики не дублировались; при смене ширины
  // app.js перерисовывает страницу (см. isNarrow()).
  return isNarrow()
    ? `<div class="blocks blocks-single stack" data-page="${esc(pageId)}">${single}</div>`
    : `<div class="blocks blocks-cols" data-page="${esc(pageId)}"><div class="stack">${col(1)}</div><div class="stack">${col(2)}</div></div>`;
}

export function customizeButton(pageId) {
  return `<button type="button" class="icon-btn sm" data-customize="${esc(pageId)}" aria-label="Настроить страницу" data-tip="Настроить страницу: порядок и видимость блоков">${icon('settings')}</button>`;
}

export function bindCustomize(root, pageId, blocks) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-customize]');
    if (b && b.dataset.customize === pageId) openCustomize(pageId, blocks);
  });
}

function openCustomize(pageId, blocks) {
  const m = modal({
    title: 'Настроить страницу',
    noForm: true,
    cancelText: 'Готово',
    body: `<div class="stack tight">
      <p class="small muted">Переставляйте блоки стрелками, переносите между колонками, скрывайте ненужные. На телефоне блоки идут одной лентой в этом же порядке.</p>
      <div data-layout-list></div>
      <div class="row between" style="margin-top:8px"><button type="button" class="link" data-layout-reset>Сбросить к исходному</button><span class="tiny faint">сохраняется сразу</span></div>
    </div>`,
  });
  const box = m.el.querySelector('[data-layout-list]');
  const draw = () => {
    const list = resolveBlocks(pageId, blocks);
    box.innerHTML = `<div class="list">${list.map((b, i) => `<div class="list-item layout-item ${b.visible ? '' : 'is-off'}">
        <label class="row" style="gap:8px;flex:1;min-width:0;cursor:pointer"><input type="checkbox" data-vis="${esc(b.id)}" ${b.visible ? 'checked' : ''}><span class="title ellipsis">${esc(b.title)}</span></label>
        <div class="seg" style="padding:2px"><button type="button" class="${b.col === 1 ? 'active' : ''}" data-col="1" data-id="${esc(b.id)}" style="padding:4px 9px">←</button><button type="button" class="${b.col === 2 ? 'active' : ''}" data-col="2" data-id="${esc(b.id)}" style="padding:4px 9px">→</button></div>
        <button type="button" class="icon-btn sm" data-move="-1" data-id="${esc(b.id)}" ${i === 0 ? 'disabled' : ''} aria-label="Выше">${icon('arrowUp')}</button>
        <button type="button" class="icon-btn sm" data-move="1" data-id="${esc(b.id)}" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Ниже">${icon('arrowDown')}</button>
      </div>`).join('')}</div>`;
  };
  const current = () => {
    const list = resolveBlocks(pageId, blocks);
    return { order: list.map(b => b.id), col: Object.fromEntries(list.map(b => [b.id, b.col])), hidden: list.filter(b => !b.visible).map(b => b.id) };
  };
  box.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-vis]'); if (!cb) return;
    const l = current();
    l.hidden = cb.checked ? l.hidden.filter(id => id !== cb.dataset.vis) : [...new Set([...l.hidden, cb.dataset.vis])];
    saveLayout(pageId, l); draw();
  });
  box.addEventListener('click', (e) => {
    const mv = e.target.closest('[data-move]'); const cl = e.target.closest('[data-col]');
    if (mv) {
      const l = current(); const i = l.order.indexOf(mv.dataset.id); const j = i + Number(mv.dataset.move);
      if (i < 0 || j < 0 || j >= l.order.length) return;
      [l.order[i], l.order[j]] = [l.order[j], l.order[i]];
      saveLayout(pageId, l); draw();
    } else if (cl) {
      const l = current(); l.col[cl.dataset.id] = Number(cl.dataset.col);
      saveLayout(pageId, l); draw();
    }
  });
  m.el.querySelector('[data-layout-reset]').addEventListener('click', () => {
    const all = { ...(db.settings().layouts || {}) }; delete all[pageId];
    db.setSettings({ layouts: all }); draw(); toast('Страница сброшена к исходному виду');
  });
  draw();
}


// =====================================================================================
// Автоматическая модульность для остальных страниц: блоки находятся в готовой разметке
// (карточки с заголовком секции или элементы с data-block), затем к ним применяются
// сохранённые порядок, колонка и видимость. Вызывается из app.js после каждого рендера.
// =====================================================================================
const ITEM_CONTAINERS = ['grid-auto', 'pgrid', 'ngrid', 'vboard', 'list'];
const slug = (t) => 'b-' + String(t).toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40);

function blockTitle(el) {
  if (el.dataset.blockTitle) return el.dataset.blockTitle;
  const h = el.querySelector('.section-title h2, .section-title h3, :scope > h2, :scope > h3, :scope > .row > h3, :scope > .row h3, :scope > div > h3');
  let t = '';
  if (h) { const c = h.cloneNode(true); c.querySelectorAll('span, button, small, .pill, .tag, svg').forEach(x => x.remove()); t = c.textContent.replace(/\s+/g, ' ').replace(/[\s·:—-]*\d+\s*$/, '').trim(); }
  if (t) return t;
  if (el.querySelector('.stat')) return 'Показатели';
  return el.dataset.block || 'Блок';
}

export function findBlocks(root) {
  const out = []; const seen = new Set();
  const isItem = (el) => el.parentElement && ITEM_CONTAINERS.some(c => el.parentElement.classList.contains(c));
  const cands = root.querySelectorAll('[data-block], .card, .grid-3, .grid-4');
  for (const el of cands) {
    if (el.closest('.page-head') || el.closest('.modal') || el.closest('.blocks[data-page]')) continue;
    if (!el.dataset.block) {
      if (isItem(el)) continue;
      const hasHeading = !!el.querySelector(':scope > .section-title, :scope > h2, :scope > h3, :scope > .row > h3, :scope > div > h3, :scope > .row > .section-title');
      const isStats = (el.classList.contains('grid-3') || el.classList.contains('grid-4')) && el.querySelector(':scope > .stat');
      if (!hasHeading && !isStats) continue;
      if (el.classList.contains('stat')) continue;
    }
    // вложенные блоки не считаем
    if ([...seen].some(p => p.contains(el) && p !== el)) continue;
    seen.add(el);
    const title = blockTitle(el);
    const id = el.dataset.block || slug(title);
    out.push({ id, title, el });
  }
  // уникальные id
  const used = new Map();
  for (const b of out) { const n = (used.get(b.id) || 0) + 1; used.set(b.id, n); if (n > 1) b.id = `${b.id}-${n}`; b.el.dataset.blockId = b.id; }
  return out;
}

let applying = false;
export function applyLayout(root, pageId) {
  if (applying) return;
  const blocks = findBlocks(root);
  if (blocks.length < 2) return;
  applying = true;
  try {
    const l = layoutOf(pageId);
    const index = new Map(l.order.map((id, i) => [id, i]));
    const hidden = new Set(l.hidden || []);
    // колонки: первый grid-2 с двумя .stack
    const grid = [...root.querySelectorAll('.grid-2')].find(g => g.querySelectorAll(':scope > .stack').length >= 2);
    const stacks = grid ? [...grid.querySelectorAll(':scope > .stack')] : [];
    for (const b of blocks) {
      b.el.style.display = hidden.has(b.id) ? 'none' : '';
      const c = l.col[b.id];
      if (stacks.length && c && stacks[c - 1] && b.el.parentElement !== stacks[c - 1] && stacks.includes(b.el.parentElement)) stacks[c - 1].appendChild(b.el);
    }
    // порядок среди соседей
    const parents = new Set(blocks.map(b => b.el.parentElement));
    for (const parent of parents) {
      const kids = [...parent.children];
      const mine = kids.filter(k => blocks.some(b => b.el === k));
      if (mine.length < 2) continue;
      const sorted = [...mine].sort((a, b) => (index.has(a.dataset.blockId) ? index.get(a.dataset.blockId) : 1e6 + kids.indexOf(a)) - (index.has(b.dataset.blockId) ? index.get(b.dataset.blockId) : 1e6 + kids.indexOf(b)));
      if (sorted.every((k, i) => k === mine[i])) continue;
      // Маркеры на местах блоков, затем расставляем отсортированные блоки по маркерам
      const markers = mine.map(k => { const m = document.createComment('slot'); parent.insertBefore(m, k); return m; });
      sorted.forEach((node, i) => parent.insertBefore(node, markers[i]));
      markers.forEach(m => m.remove());
    }
    // кнопка настройки
    const actions = root.querySelector('.page-head .actions') || (() => { const h = root.querySelector('.page-head'); if (!h) return null; const a = document.createElement('div'); a.className = 'actions'; h.appendChild(a); return a; })();
    if (actions && !actions.querySelector('[data-customize]')) actions.insertAdjacentHTML('afterbegin', customizeButton(pageId));
  } finally { applying = false; }
}

export function openAutoCustomize(pageId) {
  const getBlocks = () => {
    const root = document.getElementById('page'); if (!root) return [];
    const stacks = (() => { const g = [...root.querySelectorAll('.grid-2')].find(g => g.querySelectorAll(':scope > .stack').length >= 2); return g ? [...g.querySelectorAll(':scope > .stack')] : []; })();
    const l = layoutOf(pageId); const hidden = new Set(l.hidden || []);
    return findBlocks(root).map(b => ({ id: b.id, title: b.title, visible: !hidden.has(b.id), col: stacks.length ? (stacks.indexOf(b.el.parentElement) + 1 || null) : null, hasCols: stacks.length > 0, parent: b.el.parentElement }));
  };
  const groupName = (b) => b.col === 1 ? 'Левая колонка' : b.col === 2 ? 'Правая колонка' : 'Общие блоки';
  const m = modal({
    title: 'Настроить страницу', noForm: true, cancelText: 'Готово',
    body: `<div class="stack tight"><p class="small muted">Порядок, колонка и видимость блоков. Сохраняется сразу и синхронизируется между устройствами.</p><div data-layout-list></div><div class="row between" style="margin-top:8px"><button type="button" class="link" data-layout-reset>Сбросить к исходному</button></div></div>`,
  });
  const box = m.el.querySelector('[data-layout-list]');
  const draw = () => {
    const list = getBlocks();
    // группы = контейнеры на странице; стрелки двигают только внутри группы
    const groups = [];
    for (const b of list) { let g = groups.find(x => x.parent === b.parent); if (!g) { g = { parent: b.parent, name: groupName(b), items: [] }; groups.push(g); } g.items.push(b); }
    box.innerHTML = groups.map(g => `<div class="label caps" style="margin:10px 0 4px">${esc(g.name)}</div><div class="list">${g.items.map((b, i) => `<div class="list-item layout-item ${b.visible ? '' : 'is-off'}">
      <label class="row" style="gap:8px;flex:1;min-width:0;cursor:pointer"><input type="checkbox" data-vis="${esc(b.id)}" ${b.visible ? 'checked' : ''}><span class="title ellipsis">${esc(b.title)}</span></label>
      ${b.hasCols && b.col ? `<div class="seg" style="padding:2px"><button type="button" class="${b.col === 1 ? 'active' : ''}" data-col="1" data-id="${esc(b.id)}" style="padding:4px 9px" title="В левую колонку">←</button><button type="button" class="${b.col === 2 ? 'active' : ''}" data-col="2" data-id="${esc(b.id)}" style="padding:4px 9px" title="В правую колонку">→</button></div>` : ''}
      <button type="button" class="icon-btn sm" data-move="-1" data-id="${esc(b.id)}" ${i === 0 ? 'disabled' : ''} aria-label="Выше">${icon('arrowUp')}</button>
      <button type="button" class="icon-btn sm" data-move="1" data-id="${esc(b.id)}" ${i === g.items.length - 1 ? 'disabled' : ''} aria-label="Ниже">${icon('arrowDown')}</button>
    </div>`).join('')}</div>`).join('');
  };
  const current = () => { const list = getBlocks(); const l = layoutOf(pageId); return { order: list.map(b => b.id), col: { ...l.col }, hidden: list.filter(b => !b.visible).map(b => b.id) }; };
  const commit = (l) => { saveLayout(pageId, l); setTimeout(draw, 80); };
  box.addEventListener('change', (e) => { const cb = e.target.closest('[data-vis]'); if (!cb) return; const l = current(); l.hidden = cb.checked ? l.hidden.filter(id => id !== cb.dataset.vis) : [...new Set([...l.hidden, cb.dataset.vis])]; commit(l); });
  box.addEventListener('click', (e) => {
    const mv = e.target.closest('[data-move]'); const cl = e.target.closest('[data-col]');
    if (mv) {
      const list = getBlocks(); const me = list.find(b => b.id === mv.dataset.id); if (!me) return;
      const sib = list.filter(b => b.parent === me.parent); const i = sib.indexOf(me); const j = i + Number(mv.dataset.move);
      if (j < 0 || j >= sib.length) return;
      const l = current(); const a = l.order.indexOf(me.id), c = l.order.indexOf(sib[j].id);
      [l.order[a], l.order[c]] = [l.order[c], l.order[a]]; commit(l);
    }
    else if (cl) { const l = current(); l.col[cl.dataset.id] = Number(cl.dataset.col); commit(l); }
  });
  m.el.querySelector('[data-layout-reset]').addEventListener('click', () => { const all = { ...(db.settings().layouts || {}) }; delete all[pageId]; db.setSettings({ layouts: all }); setTimeout(draw, 80); toast('Страница сброшена к исходному виду'); });
  draw();
}
