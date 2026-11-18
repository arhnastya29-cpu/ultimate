// Вкладка «Визуализация» на странице целей: доска с картинками и текстами будущего.
// Используется из goals.js: renderVision() даёт HTML, bindVision(root) вешает обработчики.
import { db } from '../db.js';
import { esc, icon, modal, field, toast, on, sortBy, emptyState } from '../ui.js';

const AREAS = { career: 'Карьера', health: 'Здоровье', learning: 'Обучение', finance: 'Финансы', relations: 'Отношения', personal: 'Личное', home: 'Дом', travel: 'Путешествия' };
const AREA_OPTIONS = [['', 'Без сферы'], ...Object.entries(AREAS)];
const MAX_SIDE = 1400;     // длинная сторона картинки после сжатия
const QUALITY = 0.82;

let filter = '';           // фильтр по сфере

// ---------- картинки ----------
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось прочитать ' + file.name)); };
    img.src = url;
  });
}

async function compress(file) {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return { src: c.toDataURL('image/jpeg', QUALITY), w: c.width, h: c.height };
}

async function addFiles(files) {
  const list = [...files].filter(f => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
  if (!list.length) { toast('Выберите картинки'); return; }
  toast(`Загружаю ${list.length}…`, 1500);
  let order = db.all('visionItems').length;
  let ok = 0;
  for (const f of list) {
    try {
      const { src, w, h } = await compress(f);
      db.add('visionItems', { type: 'image', src, w, h, caption: '', area: '', order: order++ });
      ok++;
    } catch (e) { console.warn(e); }
  }
  toast(ok ? `Добавлено: ${ok}` : 'Не удалось загрузить картинки');
}

const kb = (s) => Math.round((s.length * 3) / 4 / 1024);
function totalKb() { return db.all('visionItems').reduce((n, x) => n + (x.src ? kb(x.src) : 0), 0); }

// ---------- модалки ----------
function openStatementModal() {
  const s = db.settings();
  modal({
    title: 'Картина будущего',
    wide: true,
    body: `<div class="form">
      <p class="small muted">Опишите, как выглядит ваша жизнь через 3–5 лет, в настоящем времени и от первого лица. Где живёте, чем занят день, кто рядом, как себя чувствуете. Это будет видно каждый раз, когда открываете вкладку.</p>
      ${field({ name: 'visionStatement', label: 'Моё будущее', type: 'textarea', value: s.visionStatement || '', rows: 10, placeholder: 'Я просыпаюсь в…', autofocus: true })}
    </div>`,
    onSubmit: (d) => { db.setSettings({ visionStatement: d.visionStatement || '' }); toast('Сохранено'); },
  });
}

function openItemModal(item) {
  const isImage = item.type === 'image';
  modal({
    title: isImage ? 'Картинка' : 'Текст',
    wide: isImage,
    body: `<div class="form">
      ${isImage ? `<img src="${item.src}" alt="" style="width:100%;border-radius:12px;max-height:60vh;object-fit:contain;background:#000">` : ''}
      ${isImage
        ? field({ name: 'caption', label: 'Подпись', value: item.caption || '', placeholder: 'Что это для вас' })
        : field({ name: 'caption', label: 'Текст', type: 'textarea', value: item.caption || '', rows: 4, required: true })}
      ${field({ name: 'area', label: 'Сфера', type: 'select', value: item.area || '', options: AREA_OPTIONS })}
      ${isImage ? `<div class="tiny faint">${kb(item.src)} КБ</div>` : ''}
    </div>`,
    onSubmit: (d) => { db.update('visionItems', item.id, { caption: d.caption || '', area: d.area || '' }); toast('Сохранено'); },
    onDelete: () => { db.remove('visionItems', item.id); toast('Удалено'); },
  });
}

function openTextModal() {
  modal({
    title: 'Текст на доску',
    body: `<div class="form">
      ${field({ name: 'caption', label: 'Текст', type: 'textarea', value: '', rows: 4, required: true, placeholder: 'Цитата, установка, конкретная цель — коротко и сильно', autofocus: true })}
      ${field({ name: 'area', label: 'Сфера', type: 'select', value: '', options: AREA_OPTIONS })}
    </div>`,
    onSubmit: (d) => {
      db.add('visionItems', { type: 'text', caption: d.caption.trim(), area: d.area || '', order: db.all('visionItems').length });
      toast('Добавлено');
    },
  });
}

function move(id, dir) {
  const items = sortBy(db.all('visionItems'), x => x.order ?? 0);
  const i = items.findIndex(x => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= items.length) return;
  const a = items[i], b = items[j];
  db.update('visionItems', a.id, { order: j });
  db.update('visionItems', b.id, { order: i });
}

// ---------- рендер ----------
function tile(x, i, n) {
  const areaTag = x.area ? `<span class="tag">${esc(AREAS[x.area] || x.area)}</span>` : '';
  const controls = `<div class="vtile-ctl">
      <button type="button" class="icon-btn sm" data-action="v-move" data-id="${esc(x.id)}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Раньше">${icon('arrowUp')}</button>
      <button type="button" class="icon-btn sm" data-action="v-move" data-id="${esc(x.id)}" data-dir="1" ${i === n - 1 ? 'disabled' : ''} aria-label="Позже">${icon('arrowDown')}</button>
    </div>`;
  if (x.type === 'image') {
    return `<figure class="vtile vimg" data-action="v-open" data-id="${esc(x.id)}" style="aspect-ratio:${x.w && x.h ? `${x.w}/${x.h}` : 'auto'}">
      <img src="${x.src}" alt="" loading="lazy">
      ${x.caption || areaTag ? `<figcaption><span>${esc(x.caption || '')}</span>${areaTag}</figcaption>` : ''}
      ${controls}
    </figure>`;
  }
  return `<div class="vtile vtext" data-action="v-open" data-id="${esc(x.id)}">
    <div class="vquote">${esc(x.caption || '')}</div>
    ${areaTag}
    ${controls}
  </div>`;
}

export function renderVision() {
  const s = db.settings();
  const all = sortBy(db.all('visionItems'), x => x.order ?? 0);
  const items = filter ? all.filter(x => x.area === filter) : all;
  const usedAreas = [...new Set(all.map(x => x.area).filter(Boolean))];
  const size = totalKb();
  return `
    <div class="card vstatement" data-action="v-statement">
      <div class="row between" style="margin-bottom:8px"><div class="eyebrow">Картина будущего</div><button type="button" class="link">${s.visionStatement ? 'Изменить' : 'Написать'}</button></div>
      ${s.visionStatement
        ? `<div class="vstatement-text">${esc(s.visionStatement)}</div>`
        : `<div class="muted small">Опишите свою жизнь через несколько лет так, будто это уже случилось. Затем добавьте картинки: места, вещи, состояния, людей, которые в этой жизни есть.</div>`}
    </div>
    <div class="row between wrap" style="margin:18px 0 12px;gap:10px">
      <div class="chips" style="padding-bottom:0">
        <button class="chip ${!filter ? 'active' : ''}" data-action="v-filter" data-area="">Всё</button>
        ${usedAreas.map(a => `<button class="chip ${filter === a ? 'active' : ''}" data-action="v-filter" data-area="${esc(a)}">${esc(AREAS[a] || a)}</button>`).join('')}
      </div>
      <div class="row" style="gap:8px">
        <button class="btn secondary sm" data-action="v-text">${icon('pen')} Текст</button>
        <label class="btn sm" style="cursor:pointer">${icon('upload')} Фото<input type="file" accept="image/*" multiple hidden data-vfile></label>
      </div>
    </div>
    ${items.length
      ? `<div class="vboard">${items.map((x, i) => tile(x, all.indexOf(x), all.length)).join('')}</div>`
      : `<div class="card">${emptyState(all.length ? 'В этой сфере пока пусто' : 'Добавьте первые картинки будущего: можно сразу несколько. Они сжимаются до разумного размера и синхронизируются вместе с остальными данными', '🌅')}</div>`}
    ${all.length ? `<div class="tiny faint" style="margin-top:10px">${all.length} ${all.length === 1 ? 'элемент' : all.length < 5 ? 'элемента' : 'элементов'} · картинки занимают ${size > 1024 ? (size / 1024).toFixed(1) + ' МБ' : size + ' КБ'}${size > 12000 ? ' — много для синхронизации, лучше удалить лишнее' : ''}</div>` : ''}
  `;
}

export function bindVision(root, rerender) {
  on(root, 'click', '[data-action="v-statement"]', () => openStatementModal());
  on(root, 'click', '[data-action="v-text"]', () => openTextModal());
  on(root, 'click', '[data-action="v-filter"]', (e, el) => { filter = el.dataset.area; rerender(); });
  on(root, 'click', '[data-action="v-open"]', (e, el) => {
    if (e.target.closest('[data-action="v-move"]')) return;
    const x = db.get('visionItems', el.dataset.id); if (x) openItemModal(x);
  });
  on(root, 'click', '[data-action="v-move"]', (e, el) => { e.stopPropagation(); move(el.dataset.id, Number(el.dataset.dir)); });
  const file = root.querySelector('[data-vfile]');
  if (file) file.addEventListener('change', async () => { await addFiles(file.files); file.value = ''; });
}
