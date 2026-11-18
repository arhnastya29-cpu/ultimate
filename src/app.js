import { db } from './db.js';
import { esc, icon, toast, el } from './ui.js';
import { afterRender, watchCelebrations, openCommandPalette } from './fx.js';

// Реестр страниц. Каждая страница — модуль, экспортирующий { title, render(root) }.
// render может вернуть функцию очистки. На любое изменение данных страница перерисовывается.
export const PAGES = [
  { id: 'today',    group: 'Главное',   title: 'Сегодня',          short: 'Сегодня', icon: 'sun',      mod: () => import('./pages/today.js') },
  { id: 'goals',    group: 'Главное',   title: 'Цели и задачи',    short: 'Цели', icon: 'target',   mod: () => import('./pages/goals.js') },
  { id: 'habits',   group: 'Главное',   title: 'Привычки',         short: 'Привычки', icon: 'repeat',   mod: () => import('./pages/habits.js') },
  { id: 'journal',  group: 'Главное',   title: 'Рефлексия',        short: 'Дневник', icon: 'pen',      mod: () => import('./pages/journal.js') },
  { id: 'learning', group: 'Развитие',  title: 'Обучение',         short: 'Учёба', icon: 'brain',    mod: () => import('./pages/learning.js') },
  { id: 'books',    group: 'Развитие',  title: 'Книги и заметки',  short: 'Книги', icon: 'library',  mod: () => import('./pages/books.js') },
  { id: 'health',   group: 'Тело',      title: 'Здоровье',         short: 'Здоровье', icon: 'heart',    mod: () => import('./pages/health.js') },
  { id: 'workouts', group: 'Тело',      title: 'Тренировки',       short: 'Спорт', icon: 'dumbbell', mod: () => import('./pages/workouts.js') },
  { id: 'nutrition',group: 'Тело',      title: 'Питание',          icon: 'utensils', mod: () => import('./pages/nutrition.js') },
  { id: 'sleep',    group: 'Тело',      title: 'Сон и энергия',    short: 'Сон', icon: 'moon',     mod: () => import('./pages/sleep.js') },
  { id: 'finance',  group: 'Ресурсы',   title: 'Финансы',          short: 'Финансы', icon: 'wallet',   mod: () => import('./pages/finance.js') },
  { id: 'settings', group: 'Ресурсы',   title: 'Настройки',        short: 'Настройки', icon: 'settings', mod: () => import('./pages/settings.js') },
];

const MOBILE_TABS = 4; // первые N разделов — вкладки внизу экрана телефона, остальные в «Ещё»
const sidebar = document.getElementById('sidebar');
let pageRoot = document.getElementById('page');
let current = null;      // { id, cleanup }
let currentMod = null;

export function navigate(id, params = {}) {
  const q = new URLSearchParams(params).toString();
  location.hash = '#/' + id + (q ? '?' + q : '');
}

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [id, q] = h.split('?');
  return { id: id || 'today', params: Object.fromEntries(new URLSearchParams(q || '')) };
}

function isDark() {
  const t = db.settings().theme || 'auto';
  return t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function renderSidebar(activeId) {
  let html = `<div class="brand"><span class="logo"></span>ULTIMATE</div><nav><div class="indicator"></div>`;
  let lastGroup = null;
  PAGES.forEach((p, i) => {
    if (p.group !== lastGroup) { html += `<div class="group">${esc(p.group)}</div>`; lastGroup = p.group; }
    html += `<a class="nav-item ${p.id === activeId ? 'active' : ''} ${i >= MOBILE_TABS ? 'nav-secondary' : ''}" href="#/${p.id}" data-page="${p.id}">${icon(p.icon)}<span class="t-full">${esc(p.title)}</span><span class="t-short">${esc(p.short || p.title)}</span></a>`;
  });
  const moreActive = PAGES.findIndex(p => p.id === activeId) >= MOBILE_TABS;
  html += `<button type="button" class="nav-item nav-more ${moreActive ? 'active' : ''}" data-more>${icon('more')}<span class="t-short">Ещё</span></button>`;
  html += `</nav><div class="foot"><span class="hint"><span class="kbd">⌘K</span> команды</span><button class="theme-toggle" type="button" aria-label="Переключить тему" title="Переключить тему">${icon(isDark() ? 'sun' : 'moon')}</button></div>`;
  sidebar.innerHTML = html;
  sidebar.querySelector('.theme-toggle').addEventListener('click', () => db.setSettings({ theme: isDark() ? 'light' : 'dark' }));
  sidebar.querySelector('[data-more]').addEventListener('click', () => openMoreSheet(activeId));
  moveIndicator(activeId);
}

// Шторка «Ещё» на телефоне: все разделы плиткой, по группам.
function openMoreSheet(activeId) {
  let lastGroup = null, body = '';
  for (const p of PAGES) {
    if (p.group !== lastGroup) { body += `${lastGroup ? '</div>' : ''}<div class="sheet-group">${esc(p.group)}</div><div class="sheet-grid">`; lastGroup = p.group; }
    body += `<a class="sheet-tile ${p.id === activeId ? 'active' : ''}" href="#/${p.id}">${icon(p.icon)}<span>${esc(p.short || p.title)}</span></a>`;
  }
  body += '</div>';
  const wrap = el(`<div class="modal-backdrop sheet-backdrop"><div class="modal sheet" role="dialog" aria-label="Все разделы"><div class="sheet-handle"></div>${body}
    <div class="sheet-foot"><button type="button" class="btn secondary block" data-close>Закрыть</button></div></div></div>`);
  const close = () => { wrap.classList.add('closing'); setTimeout(() => wrap.remove(), 180); };
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]') || e.target.closest('.sheet-tile')) close(); });
  document.getElementById('modals').appendChild(wrap);
}

function moveIndicator(activeId) {
  const ind = sidebar.querySelector('.indicator'), a = sidebar.querySelector(`.nav-item[data-page="${activeId}"]`);
  if (!ind || !a) return;
  ind.style.transform = `translateY(${a.offsetTop}px)`;
  ind.style.opacity = '1';
}

async function renderPage(force = false) {
  const { id, params } = parseHash();
  const page = PAGES.find(p => p.id === id) || PAGES[0];
  const changed = !current || current.id !== page.id;
  if (changed || force) {
    if (current?.cleanup) { try { current.cleanup(); } catch {} }
    renderSidebar(page.id);
    document.title = `${page.title} · ULTIMATE`;
  }
  if (changed) currentMod = await page.mod();
  const scrollY = window.scrollY;
  // Контейнер пересоздаётся, чтобы обработчики событий прошлого рендера не накапливались.
  const fresh = document.createElement('div');
  fresh.id = 'page';
  if (!changed) fresh.className = 'silent';
  pageRoot.replaceWith(fresh);
  pageRoot = fresh;
  let cleanup;
  try {
    cleanup = await currentMod.render(pageRoot, { params, navigate, page });
  } catch (e) {
    console.error(e);
    pageRoot.innerHTML = `<div class="card"><h3>Ошибка на странице «${esc(page.title)}»</h3><pre class="mono tiny" style="white-space:pre-wrap">${esc(e.stack || e.message)}</pre></div>`;
  }
  current = { id: page.id, cleanup };
  if (!changed) window.scrollTo(0, scrollY);
  else window.scrollTo(0, 0);
  afterRender(pageRoot, { changed });
}

function applyTheme() {
  const t = db.settings().theme || 'auto';
  const root = document.documentElement;
  if (t === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
  root.classList.toggle('sys-light', !window.matchMedia('(prefers-color-scheme: dark)').matches);
  const tb = sidebar.querySelector('.theme-toggle');
  if (tb) tb.innerHTML = icon(isDark() ? 'sun' : 'moon');
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// Перерисовка при изменении данных, с дебаунсом (несколько мутаций подряд = один рендер).
let rerenderTimer = null;
db.subscribe((col) => {
  if (col === 'settings') applyTheme();
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => renderPage(false), 30);
});

window.addEventListener('hashchange', () => renderPage(false));
window.addEventListener('resize', () => moveIndicator(current?.id));
if (document.fonts?.ready) document.fonts.ready.then(() => moveIndicator(current?.id));

// Горячие клавиши: ⌘K — палитра, g + буква — переход.
let gPending = false;
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCommandPalette(PAGES, navigate); return; }
  if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey) return;
  if (e.key === 'g') { gPending = true; setTimeout(() => gPending = false, 800); return; }
  if (!gPending) return;
  const map = { t: 'today', g: 'goals', h: 'habits', j: 'journal', l: 'learning', b: 'books', z: 'health', w: 'workouts', n: 'nutrition', s: 'sleep', f: 'finance', ',': 'settings' };
  if (map[e.key]) { navigate(map[e.key]); gPending = false; }
});

(async () => {
  await db.ready;
  applyTheme();
  await renderPage(true);
  watchCelebrations();
  // Напоминание о бэкапе раз в неделю.
  const last = localStorage.getItem('lifeos_lastExport');
  if (last && Date.now() - Number(last) > 7 * 86400000) toast('Прошла неделя с последнего бэкапа — экспортируйте данные в Настройках');
})();
