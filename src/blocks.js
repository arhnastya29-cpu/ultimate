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
