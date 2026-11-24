import { db } from './db.js';
import { esc, icon, toast, el } from './ui.js';
import { afterRender, watchCelebrations, openCommandPalette } from './fx.js';
import { initSync } from './sync.js';
import { initAiPanel, setAiPage } from './ai-panel.js';
import { afterPageRender, toggleEditMode } from './blocks.js';
import { maybePageQuote, quoteHtml, nextQuote } from './motivation.js';
import { runMigrations } from './migrate.js';
import { openCapture } from './capture.js';
import { moduleState } from './model.js';

// Реестр страниц. Каждая страница — модуль, экспортирующий { title, render(root) }.
// Группы сворачиваются в сайдбаре; на телефоне внизу: Сегодня · План · [+] · Работа · Ещё.
export const PAGES = [
  { id: 'today',    group: 'Основное', title: 'Сегодня',        short: 'Сегодня',  icon: 'sun',       mod: () => import('./pages/today.js') },
  { id: 'plan',     group: 'Основное', title: 'План',           short: 'План',     icon: 'calendar',  mod: () => import('./pages/plan.js') },
  { id: 'projects', group: 'Работа',   title: 'Проекты',        short: 'Проекты',  icon: 'layers',    mod: () => import('./pages/projects.js') },
  { id: 'people',   group: 'Работа',   title: 'Люди',           short: 'Люди',     icon: 'users',     mod: () => import('./pages/people.js') },
  { id: 'shadow',   group: 'Работа',   title: 'Shadow',         short: 'Shadow',   icon: 'briefcase', mod: () => import('./pages/shadow.js') },
  { id: 'chats',    group: 'Работа',   title: 'Чаты',           short: 'Чаты',     icon: 'send',      mod: () => import('./pages/chats.js') },
  { id: 'learning', group: 'Знания',   title: 'Обучение',       short: 'Учёба',    icon: 'brain',     mod: () => import('./pages/learning.js') },
  { id: 'notes',    group: 'Знания',   title: 'Заметки',        short: 'Заметки',  icon: 'library',   mod: () => import('./pages/notes.js') },
  { id: 'kb',       group: 'Знания',   title: 'База знаний',    short: 'База',     icon: 'folder',    mod: () => import('./pages/kb.js') },
  { id: 'signals',  group: 'Знания',   title: 'Сигналы',        short: 'Сигналы',  icon: 'rss',       mod: () => import('./pages/signals.js') },
  { id: 'habits',   group: 'Личное',   title: 'Привычки',       short: 'Привычки', icon: 'repeat',    mod: () => import('./pages/habits.js') },
  { id: 'journal',  group: 'Личное',   title: 'Рефлексия',      short: 'Дневник',  icon: 'pen',       mod: () => import('./pages/journal.js') },
  { id: 'health',   group: 'Личное',   title: 'Здоровье',       short: 'Здоровье', icon: 'heart',     mod: () => import('./pages/health.js') },
  { id: 'workouts', group: 'Личное',   title: 'Тренировки',     short: 'Спорт',    icon: 'dumbbell',  mod: () => import('./pages/workouts.js') },
  { id: 'nutrition',group: 'Личное',   title: 'Питание',        short: 'Питание',  icon: 'utensils',  mod: () => import('./pages/nutrition.js') },
  { id: 'sleep',    group: 'Личное',   title: 'Сон и энергия',  short: 'Сон',      icon: 'moon',      mod: () => import('./pages/sleep.js') },
  { id: 'finance',  group: 'Ресурсы',  title: 'Финансы',        short: 'Финансы',  icon: 'wallet',    mod: () => import('./pages/finance.js') },
  { id: 'settings', group: 'Ресурсы',  title: 'Настройки',      short: 'Настройки',icon: 'settings',  mod: () => import('./pages/settings.js') },
];
const GROUPS = ['Основное', 'Работа', 'Знания', 'Личное', 'Ресурсы'];
// Старые адреса продолжают работать.
const ALIASES = { goals: ['plan', { tab: 'goals' }], calendar: ['plan', { tab: 'week' }], books: ['notes', {}] };
const WORK_GROUP = 'Работа';

const sidebar = document.getElementById('sidebar');
const main = document.getElementById('main');
let pageRoot = document.getElementById('page');
let current = null;      // { id, cleanup }
let currentMod = null;

export function navigate(id, params = {}) {
  const q = new URLSearchParams(params).toString();
  location.hash = '#/' + id + (q ? '?' + q : '');
}

export function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [rawId, q] = h.split('?');
  let id = rawId || 'today';
  let params = Object.fromEntries(new URLSearchParams(q || ''));
  if (ALIASES[id]) { const [to, extra] = ALIASES[id]; id = to; params = { ...extra, ...params }; }
  return { id, params };
}
const pageById = (id) => PAGES.find(p => p.id === id);
const isNarrow = () => window.innerWidth <= 860;

function isDark() {
  const t = db.settings().theme || 'auto';
  return t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

// ---------- видимость разделов ----------
const visiblePages = () => PAGES.filter(p => p.id === 'settings' || p.id === 'today' || moduleState(p.id) === 'on');

// Какой раздел открывает вкладка «Работа»: последний посещённый из группы.
const lastWork = () => { try { return localStorage.getItem('ultimate_lastWork') || 'projects'; } catch { return 'projects'; } };
function rememberWork(id) { try { localStorage.setItem('ultimate_lastWork', id); } catch {} }

// ---------- свёртывание групп в сайдбаре ----------
function navOpenState() { try { return JSON.parse(localStorage.getItem('ultimate_navOpen') || '{}'); } catch { return {}; } }
function setNavOpen(group, open) { const s = navOpenState(); s[group] = open; try { localStorage.setItem('ultimate_navOpen', JSON.stringify(s)); } catch {} }

function renderSidebar(activeId) {
  const open = navOpenState();
  const active = pageById(activeId);
  const pages = visiblePages();
  const s = db.settings();
  const third = s.mobileTab && s.mobileTab !== 'work' && pageById(s.mobileTab) ? pageById(s.mobileTab) : null;
  let html = `<div class="brand"><span class="logo"></span>ULTIMATE</div>
    <button type="button" class="btn capture-btn" data-capture aria-label="Записать" title="Записать: задача, событие, заметка (клавиша N)">${icon('plus')} Записать</button>
    <nav aria-label="Разделы"><div class="indicator"></div>`;
  for (const g of GROUPS) {
    const items = pages.filter(p => p.group === g);
    if (!items.length) continue;
    const isOpen = g === 'Основное' || open[g] !== false || items.some(p => p.id === activeId);
    html += `<button type="button" class="group ${isOpen ? 'open' : ''}" data-group="${esc(g)}" aria-expanded="${isOpen}">${esc(g)}${g === 'Основное' ? '' : icon('chevronDown', 'chev')}</button>`;
    html += `<div class="group-items ${isOpen ? '' : 'collapsed'}">`;
    for (const p of items) html += `<a class="nav-item ${p.id === activeId ? 'active' : ''}" href="#/${p.id}" data-page="${p.id}">${icon(p.icon)}<span class="t-full">${esc(p.title)}</span></a>`;
    html += `</div>`;
  }
  html += `</nav>
    <nav class="tabbar" aria-label="Основные разделы">
      <a class="tab-item ${activeId === 'today' ? 'active' : ''}" href="#/today">${icon('sun')}<span>Сегодня</span></a>
      <a class="tab-item ${activeId === 'plan' ? 'active' : ''}" href="#/plan">${icon('calendar')}<span>План</span></a>
      <button type="button" class="tab-plus" data-capture aria-label="Записать">${icon('plus')}</button>
      ${third
        ? `<a class="tab-item ${activeId === third.id ? 'active' : ''}" href="#/${third.id}">${icon(third.icon)}<span>${esc(third.short || third.title)}</span></a>`
        : `<a class="tab-item ${active?.group === WORK_GROUP ? 'active' : ''}" href="#/${lastWork()}" data-work>${icon('briefcase')}<span>Работа</span></a>`}
      <button type="button" class="tab-item ${!['today', 'plan'].includes(activeId) && !(third ? activeId === third.id : active?.group === WORK_GROUP) ? 'active' : ''}" data-more aria-label="Все разделы">${icon('menu')}<span>Ещё</span></button>
    </nav>
    <div class="foot"><span class="hint"><span class="kbd">⌘K</span> команды</span><button class="theme-toggle" type="button" aria-label="Переключить тему" title="Переключить тему">${icon(isDark() ? 'sun' : 'moon')}</button></div>`;
  sidebar.innerHTML = html;
  sidebar.querySelector('.theme-toggle').addEventListener('click', () => db.setSettings({ theme: isDark() ? 'light' : 'dark' }));
  sidebar.querySelector('[data-more]').addEventListener('click', () => openDrawer(activeId));
  sidebar.querySelectorAll('[data-group]').forEach(b => b.addEventListener('click', () => {
    const g = b.dataset.group; if (g === 'Основное') return;
    const items = b.nextElementSibling; const willOpen = items.classList.contains('collapsed');
    items.classList.toggle('collapsed', !willOpen); b.classList.toggle('open', willOpen); b.setAttribute('aria-expanded', String(willOpen));
    setNavOpen(g, willOpen); moveIndicator(activeId);
  }));
  moveIndicator(activeId);
}

// Переключатель разделов группы «Работа» на телефоне (над страницей).
function renderHub(page) {
  let hub = document.getElementById('hub');
  if (!hub) { hub = document.createElement('div'); hub.id = 'hub'; main.prepend(hub); }
  if (!page || page.group !== WORK_GROUP || !isNarrow()) { hub.innerHTML = ''; hub.hidden = true; return; }
  const items = visiblePages().filter(p => p.group === WORK_GROUP);
  hub.hidden = false;
  hub.innerHTML = `<div class="seg hub-seg" role="tablist">${items.map(p => `<a role="tab" class="${p.id === page.id ? 'active' : ''}" aria-selected="${p.id === page.id}" href="#/${p.id}">${esc(p.title)}</a>`).join('')}</div>`;
}

// Боковое меню на телефоне: все разделы по группам.
function openDrawer(activeId) {
  if (document.querySelector('.drawer-backdrop')) return;
  let body = '';
  for (const g of GROUPS) {
    const items = visiblePages().filter(p => p.group === g); if (!items.length) continue;
    body += `<div class="group">${esc(g)}</div>`;
    for (const p of items) body += `<a class="nav-item ${p.id === activeId ? 'active' : ''}" href="#/${p.id}">${icon(p.icon)}<span>${esc(p.title)}</span></a>`;
  }
  const wrap = el(`<div class="drawer-backdrop">
    <aside class="drawer" role="dialog" aria-label="Разделы">
      <div class="drawer-head"><div class="brand"><span class="logo"></span>ULTIMATE</div><button type="button" class="icon-btn sm" data-close aria-label="Закрыть">${icon('x')}</button></div>
      <nav class="drawer-nav">${body}</nav>
      <div class="drawer-foot">
        <button type="button" class="btn secondary sm" data-toggle-theme>${icon(isDark() ? 'sun' : 'moon')} ${isDark() ? 'Светлая тема' : 'Тёмная тема'}</button>
        <span class="tiny faint">${esc(db.settings().name || '')}</span>
      </div>
    </aside></div>`);
  const close = () => { wrap.classList.add('closing'); document.removeEventListener('keydown', onKey); setTimeout(() => wrap.remove(), 220); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]') || e.target.closest('.nav-item')) close();
    if (e.target.closest('[data-toggle-theme]')) { db.setSettings({ theme: isDark() ? 'light' : 'dark' }); close(); }
  });
  let x0 = null;
  wrap.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  wrap.addEventListener('touchend', (e) => { if (x0 != null && x0 - e.changedTouches[0].clientX > 60) close(); x0 = null; }, { passive: true });
  document.getElementById('modals').appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
}

// Свайп от левого края — открыть меню (телефон)
let edgeX = null;
document.addEventListener('touchstart', (e) => { edgeX = e.touches[0].clientX <= 24 ? e.touches[0].clientX : null; }, { passive: true });
document.addEventListener('touchend', (e) => {
  if (edgeX != null && isNarrow() && e.changedTouches[0].clientX - edgeX > 70) openDrawer(parseHash().id);
  edgeX = null;
}, { passive: true });

function moveIndicator(activeId) {
  const ind = sidebar.querySelector('.indicator'), a = sidebar.querySelector(`.nav-item[data-page="${activeId}"]`);
  if (!ind) return;
  if (!a || a.closest('.collapsed')) { ind.style.opacity = '0'; return; }
  ind.style.transform = `translateY(${a.offsetTop}px)`;
  ind.style.opacity = '1';
}

// Заголовок и каркас нужной страницы до загрузки данных — без вспышки «Сегодня».
function paintSkeleton() {
  const { id } = parseHash();
  const page = pageById(id) || PAGES[0];
  document.title = `${page.title} · ULTIMATE`;
  if (!pageRoot.innerHTML.trim()) pageRoot.innerHTML = `<div class="page-head"><div><div class="eyebrow">${esc(page.group)}</div><h1>${esc(page.title)}</h1></div></div>`;
}

async function renderPage(force = false) {
  const { id, params } = parseHash();
  const page = pageById(id) || PAGES[0];
  const changed = !current || current.id !== page.id;
  if (changed || force) {
    if (current?.cleanup) { try { current.cleanup(); } catch {} }
    renderSidebar(page.id);
    renderHub(page);
    document.title = `${page.title} · ULTIMATE`;
    setAiPage(page.id);
    if (page.group === WORK_GROUP) rememberWork(page.id);
  }
  if (changed) currentMod = await page.mod();
  const scrollY = window.scrollY;
  const fresh = document.createElement('div');
  fresh.id = 'page';
  if (!changed) fresh.className = 'silent';
  pageRoot.replaceWith(fresh);
  pageRoot = fresh;
  let cleanup;
  try {
    if (moduleState(page.id) === 'off' && page.id !== 'settings' && page.id !== 'today') {
      pageRoot.innerHTML = `<div class="page-head"><div><div class="eyebrow">${esc(page.group)}</div><h1>${esc(page.title)}</h1></div></div><div class="empty-act"><div class="empty-act-text">Раздел выключен в настройках модулей.</div><button type="button" class="btn" data-enable-module="${page.id}">Включить раздел</button></div>`;
    } else cleanup = await currentMod.render(pageRoot, { params, navigate, page });
  } catch (e) {
    console.error(e);
    pageRoot.innerHTML = `<div class="card"><h3>Ошибка на странице «${esc(page.title)}»</h3><pre class="mono tiny" style="white-space:pre-wrap">${esc(e.stack || e.message)}</pre></div>`;
  }
  current = { id: page.id, cleanup };
  afterPageRender(pageRoot, page.id);
  if (page.id !== 'today' && changed) { const q = maybePageQuote(page.id); const h1 = pageRoot.querySelector('.page-head h1'); if (q && h1 && !pageRoot.querySelector('.champ-line')) h1.insertAdjacentHTML('afterend', quoteHtml(q, esc)); }
  {
    const obs = new MutationObserver(() => afterPageRender(pageRoot, page.id));
    obs.observe(pageRoot, { childList: true });
    const prevCleanup = cleanup;
    cleanup = () => { obs.disconnect(); if (typeof prevCleanup === 'function') prevCleanup(); };
    current.cleanup = cleanup;
  }
  if (!changed) window.scrollTo(0, scrollY); else window.scrollTo(0, 0);
  afterRender(pageRoot, { changed });
}

// ---------- глобальные клики: послание, меню «•••», настройка страницы, захват ----------
document.addEventListener('click', (e) => {
  const ql = e.target.closest('.champ-line[data-quote]');
  if (ql) { nextQuote(); renderPage(true); return; }
  if (e.target.closest('[data-capture]')) { openCapture({ pageId: current?.id, params: parseHash().params }); return; }
  const en = e.target.closest('[data-enable-module]');
  if (en) { db.setSettings({ modules: { ...(db.settings().modules || {}), [en.dataset.enableModule]: 'on' }, preset: 'custom' }); return; }
  const mb = e.target.closest('[data-pmenu]');
  if (mb) {
    const list = mb.parentElement.querySelector('.pmenu-list'); const open = list.hidden;
    document.querySelectorAll('.pmenu-list').forEach(l => { l.hidden = true; l.previousElementSibling?.setAttribute('aria-expanded', 'false'); });
    list.hidden = !open; mb.setAttribute('aria-expanded', String(open));
    if (open) list.querySelector('[role=menuitem]')?.focus();
    return;
  }
  if (!e.target.closest('.pmenu-list')) document.querySelectorAll('.pmenu-list').forEach(l => { l.hidden = true; l.previousElementSibling?.setAttribute('aria-expanded', 'false'); });
  else document.querySelectorAll('.pmenu-list').forEach(l => { l.hidden = true; });
  const c = e.target.closest('[data-action="customize"]');
  if (c) { toggleEditMode(current?.id); return; }
  const b = e.target.closest('[data-customize]');
  if (b && !document.querySelector('#page .blocks[data-page]')) toggleEditMode(b.dataset.customize);
});

function applyTheme() {
  const t = db.settings().theme || 'auto';
  const root = document.documentElement;
  if (t === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
  root.classList.toggle('sys-light', !window.matchMedia('(prefers-color-scheme: dark)').matches);
  const tb = sidebar.querySelector('.theme-toggle');
  if (tb) tb.innerHTML = icon(isDark() ? 'sun' : 'moon');
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
window.matchMedia('(max-width: 860px)').addEventListener('change', () => renderPage(true));

let rerenderTimer = null;
db.subscribe((col) => {
  if (col === 'settings') applyTheme();
  if (col === '*') runMigrations();           // импорт или слияние синхронизации могли принести старые записи
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => renderPage(col === 'settings'), 30);
});

window.addEventListener('hashchange', () => renderPage(false));
window.addEventListener('ultimate:ai', () => { clearTimeout(rerenderTimer); rerenderTimer = setTimeout(() => renderPage(false), 30); });   // доступность помощника изменилась — обновить карточки
window.addEventListener('resize', () => moveIndicator(current?.id));
if (document.fonts?.ready) document.fonts.ready.then(() => moveIndicator(current?.id));

// Горячие клавиши: ⌘K — палитра, N — записать, g + буква — переход.
let gPending = false;
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCommandPalette(visiblePages(), navigate); return; }
  if (e.key === 'Escape') document.querySelectorAll('.pmenu-list').forEach(l => { l.hidden = true; });
  if (e.target.matches('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if ((e.key === 'n' || e.key === 'т') && !gPending) { e.preventDefault(); openCapture({ pageId: current?.id, params: parseHash().params }); return; }
  if (e.key === 'g') { gPending = true; setTimeout(() => gPending = false, 800); return; }
  if (!gPending) return;
  const map = { t: 'today', p: 'plan', h: 'habits', j: 'journal', l: 'learning', b: 'notes', z: 'health', w: 'workouts', n: 'nutrition', s: 'sleep', f: 'finance', ',': 'settings' };
  if (map[e.key]) { navigate(map[e.key]); gPending = false; }
});

paintSkeleton();
(async () => {
  await db.ready;
  runMigrations();
  applyTheme();
  await renderPage(true);
  watchCelebrations();
  initSync();
  import('./whoop.js').then(m => m.autoSync()).catch(() => {});
  initAiPanel();
  let storageWarned = false;
  window.addEventListener('ultimate:storage', () => { if (storageWarned) return; storageWarned = true; toast('Браузер не даёт сохранить данные в базу — сделайте экспорт в Настройках', 6000); });
  const last = localStorage.getItem('lifeos_lastExport');
  if (last && Date.now() - Number(last) > 7 * 86400000) toast('Прошла неделя с последнего бэкапа — экспортируйте данные в Настройках');
})();
