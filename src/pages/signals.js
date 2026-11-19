// Сигналы: новости из выбранных источников (RSS/сайты/Telegram-каналы) и сводка от помощника.
// Вкладки: Лента (записи по дням, непрочитанное/сохранённое) · Сводка (текст от модели) · Источники (добавить/пауза/удалить).
import { db } from '../db.js';
import { esc, icon, modal, field, toast, on, today, fmtDate, pageMenu, tabs, statLine, emptyAction, plural, sortBy } from '../ui.js';
import { addNote, addTask } from '../model.js';
import { aiReady, aiProvider, askPlain, aiLabel } from '../ai.js';
import {
  KINDS, sources, activeSources, items, unreadCount, resolveSource, addSource, removeSource, refreshAll, refreshSource, isRefreshing,
  lastRefreshAt, staleFor, digestInput, digestPrompt, digests, todayDigest, saveDigest, probeLocal, bridgeStatus, proxyMode, prune,
} from '../signals.js';

export const title = 'Сигналы';

let tab = 'feed';          // feed | digest | sources
let filter = 'unread';     // unread | all | saved
let srcFilter = '';        // id источника или ''
let digestBusy = false;    // идёт сборка сводки
let digestDraft = '';      // текст сводки по мере генерации
let digestError = '';
let addBusy = false;       // идёт проверка нового источника
let addError = '';
let refreshNote = '';      // «обновлено: +N»
let expanded = new Set();  // раскрытые записи

const srcName = (id) => sources().find(s => s.id === id)?.name || '?';
const timeOf = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const dayOf = (iso) => { const d = new Date(iso); if (isNaN(d)) return today(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const ago = (iso) => { if (!iso) return 'ещё не обновлялось'; const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); if (m < 1) return 'только что'; if (m < 60) return `${m} мин назад`; const h = Math.round(m / 60); if (h < 24) return `${h} ч назад`; return fmtDate(dayOf(iso)); };

// Простейшая разметка ответа модели: **жирный**, списки «- », «• », «1. », абзацы.
function md(text) {
  const lines = String(text || '').split('\n');
  let out = '', list = null;
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\s)\*(?!\s)(.+?)\*(?=\s|$|[.,;:])/g, '$1<i>$2</i>');
  const closeList = () => { if (list) { out += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { closeList(); continue; }
    let m;
    if ((m = l.match(/^[-•*]\s+(.*)/))) { if (list !== 'ul') { closeList(); out += '<ul>'; list = 'ul'; } out += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^\d+[.)]\s+(.*)/))) { if (list !== 'ol') { closeList(); out += '<ol>'; list = 'ol'; } out += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^#{1,4}\s+(.*)/))) { closeList(); out += `<h4>${inline(m[1])}</h4>`; }
    else if (/^\*\*[^*]+\*\*:?$/.test(l)) { closeList(); out += `<h4>${inline(l.replace(/\*\*/g, '').replace(/:$/, ''))}</h4>`; }
    else { closeList(); out += `<p>${inline(l)}</p>`; }
  }
  closeList();
  return out;
}

// ---------- Лента ----------
function feedView() {
  const srcs = sources();
  if (!srcs.length) return emptyAction({ text: 'Добавьте сайты, RSS-ленты или Telegram-каналы — здесь будут собираться их новости, а помощник сделает по ним короткую сводку.', action: 'sg-tab-sources', label: 'Добавить источник' });
  const all = items();
  if (!all.length) return emptyAction({ text: isRefreshing() ? 'Загружаю ленты…' : 'Записей пока нет. Нажмите «Обновить», чтобы загрузить ленты.', action: isRefreshing() ? '' : 'sg-refresh', label: 'Обновить' });
  let list = filter === 'unread' ? all.filter(i => !i.read) : filter === 'saved' ? all.filter(i => i.saved) : all;
  if (srcFilter) list = list.filter(i => i.sourceId === srcFilter);
  list = sortBy(list, i => String(i.date || i.fetchedAt), true);
  const unread = all.filter(i => !i.read).length, saved = all.filter(i => i.saved).length;
  const perSrc = {}; for (const i of all) if (!i.read) perSrc[i.sourceId] = (perSrc[i.sourceId] || 0) + 1;
  const chips = [
    `<button class="chip ${filter === 'unread' ? 'active' : ''}" data-sg-filter="unread">Непрочитанные${unread ? ` <span class="faint">${unread}</span>` : ''}</button>`,
    `<button class="chip ${filter === 'all' ? 'active' : ''}" data-sg-filter="all">Все <span class="faint">${all.length}</span></button>`,
    `<button class="chip ${filter === 'saved' ? 'active' : ''}" data-sg-filter="saved">${icon('bookmark')} Сохранённые${saved ? ` <span class="faint">${saved}</span>` : ''}</button>`,
    ...(srcs.length > 1 ? srcs.map(s => `<button class="chip ${srcFilter === s.id ? 'active' : ''}" data-sg-src="${esc(s.id)}">${esc(s.name)}${perSrc[s.id] ? ` <span class="faint">${perSrc[s.id]}</span>` : ''}</button>`) : []),
  ];
  // Группируем по дню
  const groups = [];
  for (const i of list) { const d = dayOf(i.date || i.fetchedAt); const g = groups[groups.length - 1]; if (g && g.day === d) g.items.push(i); else groups.push({ day: d, items: [i] }); }
  const body = list.length
    ? groups.map(g => `<div class="sg-day"><div class="sg-day-title">${esc(fmtDate(g.day, { weekday: true }))}</div>${g.items.map(itemRow).join('')}</div>`).join('')
    : `<div class="card tiny muted" style="text-align:center">${filter === 'unread' ? 'Всё прочитано' : 'Здесь пусто'}</div>`;
  return `
    ${statLine([unread ? `непрочитано <b>${unread}</b>` : 'всё прочитано', `источников <b>${activeSources().length}</b>`, refreshNote ? [refreshNote, 'good'] : `обновлено ${ago(lastRefreshAt())}`])}
    <div class="row between wrap" style="gap:8px;margin:12px 0">
      <div class="chips nchips">${chips.join('')}</div>
      ${unread && filter !== 'saved' ? `<button type="button" class="btn sm secondary" data-action="sg-read-all">${icon('check')} Прочитано всё</button>` : ''}
    </div>
    <div class="sg-feed" data-block="signals-feed" data-block-title="Лента">${body}</div>`;
}

function itemRow(i) {
  const open = expanded.has(i.id);
  const host = (() => { try { return new URL(i.link).host.replace(/^www\./, ''); } catch { return ''; } })();
  return `<article class="sg-item ${i.read ? 'is-read' : ''} ${i.saved ? 'is-saved' : ''} ${open ? 'is-open' : ''}" data-id="${esc(i.id)}">
    <div class="sg-item-head">
      <span class="sg-src">${esc(srcName(i.sourceId))}</span><span class="sg-time">${timeOf(i.date)}</span>
      ${i.saved ? `<span class="pill accent">${icon('bookmark')}</span>` : ''}
    </div>
    <button type="button" class="sg-title" data-action="sg-toggle" data-id="${esc(i.id)}">${esc(i.title)}</button>
    ${i.summary && i.summary !== i.title ? `<div class="sg-summary ${open ? '' : 'clamp'}">${esc(i.summary)}</div>` : ''}
    <div class="sg-actions">
      ${i.link ? `<a class="btn sm secondary" href="${esc(i.link)}" target="_blank" rel="noopener" data-action="sg-open" data-id="${esc(i.id)}">${icon('link')} Открыть${host ? ` <span class="faint">${esc(host)}</span>` : ''}</a>` : ''}
      <button type="button" class="icon-btn sm ${i.saved ? 'on' : ''}" data-action="sg-save" data-id="${esc(i.id)}" aria-label="${i.saved ? 'Убрать из сохранённых' : 'Сохранить'}" title="${i.saved ? 'Убрать из сохранённых' : 'Сохранить'}">${icon('bookmark')}</button>
      <button type="button" class="icon-btn sm" data-action="sg-note" data-id="${esc(i.id)}" aria-label="В заметки" title="В заметки">${icon('pen')}</button>
      <button type="button" class="icon-btn sm" data-action="sg-task" data-id="${esc(i.id)}" aria-label="В задачу" title="В задачу">${icon('check')}</button>
      ${i.read ? '' : `<button type="button" class="link" data-action="sg-read" data-id="${esc(i.id)}">прочитано</button>`}
    </div>
  </article>`;
}

// ---------- Сводка ----------
function digestView() {
  const s = db.settings();
  const dg = todayDigest();
  const srcs = sources();
  if (!srcs.length) return emptyAction({ text: 'Сводка собирается из ваших источников. Сначала добавьте хотя бы один.', action: 'sg-tab-sources', label: 'Добавить источник' });
  const ready = aiReady();
  const input = digestInput({ hours: Number(s.signalsHours) || 24 });
  const head = `<div class="card sg-digest-card" data-block="signals-digest" data-block-title="Сводка">
    <div class="section-title"><h2>${icon('zap')} Сводка ${dg ? `на ${esc(fmtDate(dg.date))}` : 'на сегодня'}</h2>
      <span class="row tiny muted" style="gap:8px">${ready ? esc(aiLabel()) : 'помощник не подключён'}</span></div>
    ${digestBusy ? `<div class="sg-digest-text">${md(digestDraft) || '<p class="muted">Читаю записи…</p>'}</div><div class="tiny muted" style="margin-top:8px">Собираю сводку…</div>`
      : digestError ? `<div class="small bad" style="margin-bottom:10px">${esc(digestError)}</div>` : ''}
    ${!digestBusy && dg ? `<div class="sg-digest-text">${md(dg.text)}</div>` : ''}
    ${!digestBusy && !dg && !digestError ? `<div class="small muted" style="margin-bottom:12px">${input.items.length ? `Готово к сборке: ${input.items.length} ${plural(input.items.length, 'запись', 'записи', 'записей')} за ${hoursLabel(s.signalsHours)}.` : 'Записей для сводки пока нет — сначала обновите ленту.'}</div>` : ''}
    <div class="row wrap" style="gap:8px;margin-top:12px;align-items:center">
      ${ready ? `<button type="button" class="btn ${dg ? 'secondary' : ''}" data-action="sg-digest" ${digestBusy || !input.items.length ? 'disabled' : ''}>${icon('zap')} ${dg ? 'Собрать заново' : 'Собрать сводку'}</button>` : `<a class="btn" href="#/settings">${icon('settings')} Подключить помощника</a>`}
      ${digestBusy ? `<button type="button" class="btn secondary" data-action="sg-digest-stop">Остановить</button>` : ''}
      <label class="row tiny muted" style="gap:6px">за <select class="input" data-sg-hours style="width:auto;padding:5px 8px">${[[12, '12 часов'], [24, 'сутки'], [48, '2 дня'], [168, 'неделю']].map(([v, l]) => `<option value="${v}" ${Number(s.signalsHours) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${dg && !digestBusy ? `<button type="button" class="btn sm secondary" data-action="sg-digest-note">${icon('pen')} В заметки</button><button type="button" class="btn sm secondary" data-action="sg-digest-copy">${icon('copy')} Копировать</button>` : ''}
    </div>
    ${!ready ? `<div class="tiny muted" style="margin-top:10px">${aiProvider() === 'ollama' ? 'Локальная модель отвечает только на Mac, где запущена Ollama. Откройте ULTIMATE через start.command или включите Claude в Настройках.' : 'Вставьте ключ Claude в Настройках.'}</div>` : ''}
  </div>`;
  const focus = `<div class="card" data-block="signals-focus" data-block-title="Что важно">
    <div class="section-title"><h2>${icon('target')} Что мне важно</h2></div>
    <div class="tiny muted" style="margin-bottom:8px">Помощник будет выделять это в сводке первым. Например: «продуктовые запуски, AI-инструменты, рынок финтеха, решения регуляторов».</div>
    <textarea class="input" data-sg-focus rows="2" placeholder="Темы, компании, люди — через запятую">${esc(s.signalsFocus || '')}</textarea>
  </div>`;
  const past = digests().filter(d => d.id !== dg?.id);
  const history = past.length ? `<details class="sg-past" data-block="signals-past" data-block-title="Прошлые сводки"><summary class="btn secondary sm">${icon('clock')} Прошлые сводки · ${past.length}</summary>
    <div class="stack" style="margin-top:10px">${past.slice(0, 14).map(d => `<div class="card"><div class="row between"><b class="small">${esc(fmtDate(d.date, { weekday: true }))}</b><button type="button" class="link" data-action="sg-digest-del" data-id="${esc(d.id)}">удалить</button></div><div class="sg-digest-text small">${md(d.text)}</div></div>`).join('')}</div></details>` : '';
  return `<div class="sg-digest">${head}${focus}${history}</div>`;
}
const hoursLabel = (h) => ({ 12: '12 часов', 24: 'сутки', 48: '2 дня', 168: 'неделю' }[Number(h)] || `${h} ч`);

// ---------- Источники ----------
function sourcesView() {
  const list = sources();
  const b = bridgeStatus();
  const unreadBy = {}; for (const i of items()) if (!i.read) unreadBy[i.sourceId] = (unreadBy[i.sourceId] || 0) + 1;
  const mode = proxyMode();
  return `<div class="sg-sources">
    <div class="card" data-block="signals-add" data-block-title="Добавить источник">
      <div class="section-title"><h2>${icon('plus')} Добавить источник</h2></div>
      <form class="row wrap sg-add" data-sg-add style="gap:8px;align-items:flex-start">
        <input class="input grow" name="url" placeholder="Адрес сайта, RSS-лента, ссылка на Telegram-канал или @канал" autocomplete="off" ${addBusy ? 'disabled' : ''} required style="min-width:220px">
        <button type="submit" class="btn" ${addBusy ? 'disabled' : ''}>${addBusy ? 'Проверяю…' : 'Добавить'}</button>
      </form>
      ${addError ? `<div class="small bad" style="margin-top:8px">${esc(addError)}</div>` : ''}
      <div class="tiny muted" style="margin-top:8px">Подойдёт почти любой сайт с новостями или блогом: ленту я найду сама. Для Telegram работают публичные каналы.</div>
    </div>
    ${list.length ? `<div class="list sg-src-list" data-block="signals-sources" data-block-title="Источники">${list.map(s => `<div class="list-item sg-src ${s.paused ? 'is-paused' : ''} ${s.lastError ? 'has-error' : ''}">
        <div class="main">
          <div class="row wrap" style="gap:6px;align-items:center"><button type="button" class="sg-src-name" data-action="sg-src-edit" data-id="${esc(s.id)}">${esc(s.name)}</button><span class="tag">${esc(KINDS[s.kind] || s.kind)}</span>${s.tag ? `<span class="tag">#${esc(s.tag)}</span>` : ''}${s.paused ? '<span class="pill warn">пауза</span>' : ''}${unreadBy[s.id] ? `<span class="pill accent">${unreadBy[s.id]} новых</span>` : ''}</div>
          <div class="tiny muted ellipsis">${esc(s.feedUrl)}</div>
          <div class="tiny ${s.lastError ? 'bad' : 'faint'}">${s.lastError ? `Ошибка: ${esc(s.lastError)}` : `обновлено ${ago(s.lastFetchAt)}${s.lastCount ? ` · +${s.lastCount}` : ''}`}</div>
        </div>
        <div class="row" style="gap:4px">
          <button type="button" class="icon-btn sm" data-action="sg-src-refresh" data-id="${esc(s.id)}" aria-label="Обновить" title="Обновить">${icon('refresh')}</button>
          <button type="button" class="icon-btn sm" data-action="sg-src-pause" data-id="${esc(s.id)}" aria-label="${s.paused ? 'Возобновить' : 'Пауза'}" title="${s.paused ? 'Возобновить' : 'Пауза'}">${icon(s.paused ? 'play' : 'pause')}</button>
          <button type="button" class="icon-btn sm" data-action="sg-src-del" data-id="${esc(s.id)}" aria-label="Удалить" title="Удалить">${icon('trash')}</button>
        </div>
      </div>`).join('')}</div>` : ''}
    <details class="sg-adv" data-block="signals-bridge" data-block-title="Как загружаются ленты">
      <summary class="btn secondary sm">${icon('sliders')} Как загружаются ленты</summary>
      <div class="card" style="margin-top:10px">
        <div class="small" style="margin-bottom:8px">Браузер не умеет читать чужие сайты напрямую, поэтому ленты идут через «мост». ${b.local ? '<span class="good">Сейчас работает локальный мост ULTIMATE</span> — самый надёжный вариант.' : 'Локальный мост не найден: откройте ULTIMATE через <b>start.command</b> на Mac, и ленты будут загружаться через него. Пока используется запасной путь — публичный прокси, который видит только адреса лент.'}</div>
        <label class="field"><span class="tiny muted">Способ загрузки</span><select class="input" data-sg-proxy style="width:auto">${[['auto', 'Автоматически (рекомендуется)'], ['local', 'Только локальный мост'], ['direct', 'Только напрямую'], ['custom', 'Свой адрес моста']].map(([v, l]) => `<option value="${v}" ${(['auto', 'local', 'direct'].includes(mode) ? mode : 'custom') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        ${!['auto', 'local', 'direct'].includes(mode) || false ? `<input class="input" data-sg-proxy-url value="${esc(mode)}" placeholder="https://мой-прокси/?url={url}" style="margin-top:8px">` : ''}
        <div class="tiny muted" style="margin-top:8px">Хранить непрочитанное: <select class="input" data-sg-keep style="width:auto;padding:4px 8px">${[[7, '7 дней'], [14, '14 дней'], [30, '30 дней']].map(([v, l]) => `<option value="${v}" ${Number(db.settings().signalsKeepDays) === v ? 'selected' : ''}>${l}</option>`).join('')}</select> · сохранённые остаются навсегда</div>
      </div>
    </details>
  </div>`;
}

function openSourceModal(s) {
  modal({
    title: 'Источник',
    body: `<div class="form">
      ${field({ name: 'name', label: 'Название', value: s.name, required: true })}
      ${field({ name: 'tag', label: 'Группа (необязательно)', value: s.tag || '', placeholder: 'работа, рынок, личное' })}
      ${field({ name: 'feedUrl', label: 'Адрес ленты', value: s.feedUrl, required: true })}
    </div>`,
    onSubmit: (d) => { db.update('signalSources', s.id, { name: d.name.trim(), tag: d.tag.trim().replace(/^#/, ''), feedUrl: d.feedUrl.trim(), renamed: d.name.trim() !== s.name || s.renamed }); toast('Сохранено'); },
    onDelete: () => { removeSource(s.id); toast('Источник удалён'); },
  });
}

// ---------- Страница ----------
let digestCtl = null;
export async function render(root, { params }) {
  if (params?.tab && ['feed', 'digest', 'sources'].includes(params.tab)) tab = params.tab;
  const unread = unreadCount();
  const srcN = sources().length;

  const draw = () => {
    root.innerHTML = `<div>
      <div class="page-head">
        <div><div class="eyebrow">Знания</div><h1>Сигналы</h1></div>
        <div class="actions">
          ${srcN ? `<button type="button" class="btn secondary" data-action="sg-refresh" ${isRefreshing() ? 'disabled' : ''}>${icon('refresh')} ${isRefreshing() ? 'Обновляю…' : 'Обновить'}</button>` : ''}
          ${srcN && aiReady() ? `<button type="button" class="btn" data-action="sg-go-digest">${icon('zap')} Сводка</button>` : `<button type="button" class="btn" data-action="sg-tab-sources">${icon('plus')} Источник</button>`}
          ${pageMenu([{ label: 'Отметить всё прочитанным', action: 'sg-read-all', icon: 'check' }, { label: 'Источники', action: 'sg-tab-sources', icon: 'rss' }])}
        </div>
      </div>
      ${tabs([['feed', 'Лента', unreadCount() || null], ['digest', 'Сводка'], ['sources', 'Источники', sources().length || null]], tab, 'data-sg-tab')}
      <div class="sg-body">${tab === 'feed' ? feedView() : tab === 'digest' ? digestView() : sourcesView()}</div>
    </div>`;
  };
  draw();
  const rerender = () => { const y = window.scrollY; draw(); window.scrollTo(0, y); };

  // ---- события ----
  on(root, 'click', '[data-sg-tab]', (e, el) => { tab = el.dataset.sgTab; rerender(); });
  on(root, 'click', '[data-action="sg-tab-sources"]', () => { tab = 'sources'; rerender(); setTimeout(() => root.querySelector('[data-sg-add] input')?.focus(), 30); });
  on(root, 'click', '[data-action="sg-go-digest"]', () => { tab = 'digest'; rerender(); if (!todayDigest() && !digestBusy) buildDigest(); });
  on(root, 'click', '[data-sg-filter]', (e, el) => { filter = el.dataset.sgFilter; rerender(); });
  on(root, 'click', '[data-sg-src]', (e, el) => { srcFilter = srcFilter === el.dataset.sgSrc ? '' : el.dataset.sgSrc; rerender(); });
  on(root, 'click', '[data-action="sg-refresh"]', () => doRefresh());
  on(root, 'click', '[data-action="sg-read-all"]', () => {
    let list = items().filter(i => !i.read); if (srcFilter) list = list.filter(i => i.sourceId === srcFilter);
    for (const i of list) db.update('signalItems', i.id, { read: true });
    toast(`Прочитано: ${list.length}`); rerender();
  });
  on(root, 'click', '[data-action="sg-toggle"]', (e, el) => { const id = el.dataset.id; if (expanded.has(id)) expanded.delete(id); else expanded.add(id); const it = db.get('signalItems', id); if (it && !it.read) db.update('signalItems', id, { read: true }); rerender(); });
  on(root, 'click', '[data-action="sg-open"]', (e, el) => { const it = db.get('signalItems', el.dataset.id); if (it && !it.read) db.update('signalItems', it.id, { read: true }); setTimeout(rerender, 300); });
  on(root, 'click', '[data-action="sg-read"]', (e, el) => { db.update('signalItems', el.dataset.id, { read: true }); rerender(); });
  on(root, 'click', '[data-action="sg-save"]', (e, el) => { const it = db.get('signalItems', el.dataset.id); if (!it) return; db.update('signalItems', it.id, { saved: !it.saved, read: true }); toast(it.saved ? 'Убрано из сохранённых' : 'Сохранено'); rerender(); });
  on(root, 'click', '[data-action="sg-note"]', (e, el) => {
    const it = db.get('signalItems', el.dataset.id); if (!it) return;
    addNote({ type: 'note', title: it.title, body: `${it.summary ? it.summary + '\n\n' : ''}${it.link}`, tags: ['сигналы', ...(sources().find(s => s.id === it.sourceId)?.tag ? [sources().find(s => s.id === it.sourceId).tag] : [])], date: today() });
    db.update('signalItems', it.id, { read: true, saved: true }); toast('Записано в заметки'); rerender();
  });
  on(root, 'click', '[data-action="sg-task"]', (e, el) => {
    const it = db.get('signalItems', el.dataset.id); if (!it) return;
    addTask({ title: it.title, notes: it.link, tags: ['сигналы'] });
    db.update('signalItems', it.id, { read: true }); toast('Задача добавлена в инбокс'); rerender();
  });
  // сводка
  on(root, 'click', '[data-action="sg-digest"]', () => buildDigest());
  on(root, 'click', '[data-action="sg-digest-stop"]', () => digestCtl?.abort());
  on(root, 'click', '[data-action="sg-digest-note"]', () => { const d = todayDigest(); if (!d) return; addNote({ type: 'note', title: `Сводка новостей ${fmtDate(d.date)}`, body: d.text, tags: ['сигналы', 'сводка'], date: d.date }); toast('Записано в заметки'); });
  on(root, 'click', '[data-action="sg-digest-copy"]', async () => { const d = todayDigest(); if (!d) return; try { await navigator.clipboard.writeText(d.text); toast('Скопировано'); } catch { toast('Не удалось скопировать'); } });
  on(root, 'click', '[data-action="sg-digest-del"]', (e, el) => { db.remove('signalDigests', el.dataset.id); rerender(); });
  on(root, 'change', '[data-sg-hours]', (e, el) => { db.setSettings({ signalsHours: Number(el.value) || 24 }); rerender(); });
  on(root, 'change', '[data-sg-focus]', (e, el) => { db.setSettings({ signalsFocus: el.value.trim() }); toast('Сохранено'); });
  // источники
  on(root, 'submit', '[data-sg-add]', async (e, form) => {
    e.preventDefault();
    const url = form.url.value.trim(); if (!url || addBusy) return;
    addBusy = true; addError = ''; rerender();
    try {
      const r = await resolveSource(url);
      const src = addSource(r);
      if (!src.lastFetchAt) await refreshSource(src);
      toast(`Добавлено: ${src.name}`);
      addBusy = false; rerender();
    } catch (err) { addBusy = false; addError = String(err.message || err); rerender(); const inp = root.querySelector('[data-sg-add] input'); if (inp) { inp.value = url; inp.focus(); } }
  });
  on(root, 'click', '[data-action="sg-src-edit"]', (e, el) => { const s = db.get('signalSources', el.dataset.id); if (s) openSourceModal(s); });
  on(root, 'click', '[data-action="sg-src-pause"]', (e, el) => { const s = db.get('signalSources', el.dataset.id); if (s) { db.update('signalSources', s.id, { paused: !s.paused }); rerender(); } });
  on(root, 'click', '[data-action="sg-src-del"]', (e, el) => { const s = db.get('signalSources', el.dataset.id); if (s && confirm(`Удалить источник «${s.name}»? Сохранённые записи останутся.`)) { removeSource(s.id); toast('Источник удалён'); rerender(); } });
  on(root, 'click', '[data-action="sg-src-refresh"]', async (e, el) => { const s = db.get('signalSources', el.dataset.id); if (!s) return; el.disabled = true; const r = await refreshSource(s); toast(r.ok ? `+${r.added} новых` : r.error); prune(); rerender(); });
  on(root, 'change', '[data-sg-proxy]', (e, el) => { const v = el.value; if (v === 'custom') { db.setSettings({ signalsProxy: 'https://api.allorigins.win/raw?url={url}' }); } else db.setSettings({ signalsProxy: v }); rerender(); });
  on(root, 'change', '[data-sg-proxy-url]', (e, el) => { const v = el.value.trim(); if (v.includes('{url}')) { db.setSettings({ signalsProxy: v }); toast('Сохранено'); } else toast('В адресе должно быть {url}'); });
  on(root, 'change', '[data-sg-keep]', (e, el) => { db.setSettings({ signalsKeepDays: Number(el.value) || 14 }); prune(); rerender(); });

  async function doRefresh() {
    if (isRefreshing() || !activeSources().length) return;
    refreshNote = ''; rerender();
    const r = await refreshAll({ onProgress: () => rerender() });
    if (r) { refreshNote = r.added ? `+${r.added} ${plural(r.added, 'новая', 'новые', 'новых')}` : 'новых нет'; if (r.failed) toast(`Не загрузились: ${r.failed} ${plural(r.failed, 'источник', 'источника', 'источников')}`); }
    rerender();
  }
  async function buildDigest() {
    if (digestBusy || !aiReady()) return;
    const s = db.settings();
    const input = digestInput({ hours: Number(s.signalsHours) || 24 });
    if (!input.items.length) { toast('Нет записей для сводки — обновите ленту'); return; }
    digestBusy = true; digestDraft = ''; digestError = ''; digestCtl = new AbortController(); tab = 'digest'; rerender();
    let tick = 0;
    try {
      const text = await askPlain(digestPrompt(input.text, { focus: s.signalsFocus || '', name: s.name || '' }), {
        signal: digestCtl.signal,
        onText: (tx) => { digestDraft += tx; if (++tick % 6 === 0) { const box = root.querySelector('.sg-digest-text'); if (box) box.innerHTML = md(digestDraft); } },
      });
      saveDigest({ text, itemIds: input.items.map(i => i.id), provider: aiProvider(), period: input.period });
      for (const i of input.items) if (!i.read) db.update('signalItems', i.id, { read: true });
    } catch (e) {
      if (e.name === 'AbortError') { if (digestDraft.trim()) saveDigest({ text: digestDraft.trim(), itemIds: input.items.map(i => i.id), provider: aiProvider(), period: input.period }); }
      else digestError = String(e.message || e);
    }
    digestBusy = false; digestCtl = null; rerender();
  }

  // Автообновление: раз в час при открытии, если есть источники
  const onSig = () => rerender();
  window.addEventListener('ultimate:signals', onSig);
  probeLocal().then(() => { if (tab === 'sources') rerender(); });
  if (activeSources().length && staleFor() && !isRefreshing()) doRefresh();
  else if (unread === 0 && srcN && tab === 'feed' && !items().length) {/* пусто — подсказка уже на экране */}

  return () => { window.removeEventListener('ultimate:signals', onSig); };
}
