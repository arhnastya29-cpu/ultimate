// Сигналы: новости из выбранных источников (RSS/сайты/Telegram-каналы) и сводки от помощника.
// Вкладки: Лента (по темам и дням; важное и «по фокусу» сверху, остальное под «ещё N») · Сводка (день и неделя) ·
// Источники (добавить, готовые наборы, качество каждого источника).
import { db } from '../db.js';
import { esc, icon, modal, field, toast, on, today, fmtDate, pageMenu, tabs, statLine, emptyAction, plural, sortBy } from '../ui.js';
import { addNote, addTask } from '../model.js';
import { aiReady, aiProvider, aiLabel } from '../ai.js';
import {
  KINDS, PRESETS, sources, activeSources, items, unreadCount, resolveSource, addSource, removeSource, refreshAll, refreshSource, isRefreshing,
  lastRefreshAt, staleFor, digestInput, digests, todayDigest, weekDigest, probeLocal, bridgeStatus, proxyMode, prune,
  topics, DEFAULT_TOPICS, untagged, dupsOf, isPrimary, vote, isTop, focusTerms, matchesFocus, sourceStats, cleanDigest,
} from '../signals.js';
import { tagNew, isTagging, tagProgress, brief, isBriefing, makeDigest, digestBusy, isMorningRun } from '../signals-ai.js';

export const title = 'Сигналы';

let tab = 'feed';          // feed | digest | sources
let filter = 'unread';     // unread | all | saved | useful
let srcFilter = '';        // id источника или ''
let topicFilter = '';      // тема или ''
let digestDraft = '';      // текст сводки по мере генерации
let digestError = '';
let weekDraft = '';
let weekError = '';
let addBusy = false;       // идёт проверка нового источника
let addError = '';
let refreshNote = '';      // «обновлено: +N»
let expanded = new Set();  // раскрытые записи, похожие, «ещё N» по дням
let preset = null;         // { id, done, total, added, failed: [] } — идёт добавление набора

const srcName = (id) => sources().find(s => s.id === id)?.name || '?';
const timeOf = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const dayOf = (iso) => { const d = new Date(iso); if (isNaN(d)) return today(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const ago = (iso) => { if (!iso) return 'ещё не обновлялось'; const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); if (m < 1) return 'только что'; if (m < 60) return `${m} мин назад`; const h = Math.round(m / 60); if (h < 24) return `${h} ч назад`; return fmtDate(dayOf(iso)); };

// Простейшая разметка ответа модели: **жирный**, списки «- », «• », «1. », абзацы.
export function md(text) {
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
  const primary = all.filter(isPrimary);
  const terms = focusTerms();
  let list = filter === 'unread' ? primary.filter(i => !i.read) : filter === 'saved' ? all.filter(i => i.saved) : filter === 'useful' ? all.filter(i => i.vote === 1) : primary;
  if (srcFilter) list = list.filter(i => i.sourceId === srcFilter);
  // Вкладки тем: счётчик — непрочитанные (в режиме «все» — все записи темы)
  const perTopic = {}; let noTopic = 0;
  for (const i of (srcFilter ? list : (filter === 'unread' ? primary.filter(i => !i.read) : filter === 'all' ? primary : list))) { if (i.topic) perTopic[i.topic] = (perTopic[i.topic] || 0) + 1; else noTopic++; }
  const topicTabs = [['', 'Все', null], ...topics().filter(t => perTopic[t] || t === topicFilter).map(t => [t, t, perTopic[t] || null])];
  if (topicFilter) list = list.filter(i => i.topic === topicFilter);
  list = sortBy(list, i => String(i.date || i.fetchedAt), true);
  const unread = primary.filter(i => !i.read).length, saved = all.filter(i => i.saved).length, useful = all.filter(i => i.vote === 1).length;
  const perSrc = {}; for (const i of primary) if (!i.read) perSrc[i.sourceId] = (perSrc[i.sourceId] || 0) + 1;
  const left = untagged().length, tp = tagProgress();
  const chips = [
    `<button class="chip ${filter === 'unread' ? 'active' : ''}" data-sg-filter="unread">Непрочитанные${unread ? ` <span class="faint">${unread}</span>` : ''}</button>`,
    `<button class="chip ${filter === 'all' ? 'active' : ''}" data-sg-filter="all">Все <span class="faint">${primary.length}</span></button>`,
    `<button class="chip ${filter === 'useful' ? 'active' : ''}" data-sg-filter="useful">${icon('star')} Полезные${useful ? ` <span class="faint">${useful}</span>` : ''}</button>`,
    `<button class="chip ${filter === 'saved' ? 'active' : ''}" data-sg-filter="saved">${icon('bookmark')} Сохранённые${saved ? ` <span class="faint">${saved}</span>` : ''}</button>`,
    ...(srcs.length > 1 ? srcs.map(s => `<button class="chip ${srcFilter === s.id ? 'active' : ''}" data-sg-src="${esc(s.id)}">${esc(s.name)}${perSrc[s.id] ? ` <span class="faint">${perSrc[s.id]}</span>` : ''}</button>`) : []),
  ];
  // Группируем по дню; внутри дня — важное, «по фокусу» и полезное сверху, остальное под «ещё N новостей»
  const groups = [];
  for (const i of list) { const d = dayOf(i.date || i.fetchedAt); const g = groups[groups.length - 1]; if (g && g.day === d) g.items.push(i); else groups.push({ day: d, items: [i] }); }
  const collapse = filter === 'unread' || filter === 'all';
  const dayHtml = (g) => {
    g.items.sort((a, b) => (isTop(b, terms) ? 1 : 0) - (isTop(a, terms) ? 1 : 0) || (Number(b.importance) || 2) - (Number(a.importance) || 2) || String(b.date).localeCompare(String(a.date)));
    const top = collapse ? g.items.filter(i => isTop(i, terms)) : g.items;
    const rest = collapse ? g.items.filter(i => !isTop(i, terms)) : [];
    const open = expanded.has('more:' + g.day);
    const show = !top.length || open || rest.length <= 2 ? g.items : top;
    const hidden = g.items.length - show.length;
    return `<div class="sg-day"><div class="sg-day-title">${esc(fmtDate(g.day, { weekday: true }))}${top.length && rest.length > 2 ? ` <span class="faint" style="letter-spacing:0;text-transform:none;font-weight:500">· важное ${top.length} из ${g.items.length}</span>` : ''}</div>
      ${show.map(i => itemRow(i, terms)).join('')}
      ${hidden > 0 ? `<button type="button" class="sg-more" data-action="sg-more" data-day="${g.day}">${icon('list')} Ещё ${hidden} ${plural(hidden, 'новость', 'новости', 'новостей')}</button>` : open && rest.length > 2 ? `<button type="button" class="sg-more" data-action="sg-more" data-day="${g.day}">Свернуть</button>` : ''}
    </div>`;
  };
  const body = list.length ? groups.map(dayHtml).join('') : `<div class="card tiny muted" style="text-align:center">${filter === 'unread' ? 'Всё прочитано' : filter === 'useful' ? 'Отмечайте полезные новости кнопкой «полезно» — они соберутся здесь' : 'Здесь пусто'}</div>`;
  return `
    ${statLine([unread ? `непрочитано <b>${unread}</b>` : 'всё прочитано', `источников <b>${activeSources().length}</b>`, refreshNote ? [refreshNote, 'good'] : `обновлено ${ago(lastRefreshAt())}`, tp ? [`размечаю ${tp.done} из ${tp.total}…`, 'accent'] : left ? [`не размечено <b>${left}</b>`, 'muted'] : ''])}
    <div class="row between wrap" style="gap:8px;margin:12px 0 8px">
      <div class="chips nchips">${chips.join('')}</div>
      <div class="row wrap" style="gap:6px">
        ${left && aiReady() && !tp ? `<button type="button" class="btn sm secondary" data-action="sg-tag">${icon('zap')} Разметить</button>` : ''}
        ${unread && filter !== 'saved' && filter !== 'useful' ? `<button type="button" class="btn sm secondary" data-action="sg-read-all">${icon('check')} Прочитано всё</button>` : ''}
      </div>
    </div>
    ${topicTabs.length > 1 ? `<div class="sg-topic-tabs">${tabs(topicTabs, topicFilter, 'data-sg-topic')}</div>` : ''}
    ${terms.length && collapse ? '' : terms.length ? '' : `<div class="tiny muted" style="margin:0 0 10px">Напишите во вкладке «Сводка», что вам важно — такие новости будут подниматься вверх, а остальное сворачиваться под «ещё N».</div>`}
    <div class="sg-feed" data-block="signals-feed" data-block-title="Лента">${body}</div>`;
}

function itemRow(i, terms = focusTerms()) {
  const open = expanded.has(i.id);
  const host = (() => { try { return new URL(i.link).host.replace(/^www\./, ''); } catch { return ''; } })();
  const dups = dupsOf(i.id); const dupsOpen = expanded.has('dups:' + i.id);
  const focus = matchesFocus(i, terms);
  const briefing = isBriefing(i.id);
  return `<article class="sg-item ${i.read ? 'is-read' : ''} ${i.saved ? 'is-saved' : ''} ${open ? 'is-open' : ''} ${i.importance === 3 || focus ? 'is-hot' : i.importance === 1 && i.vote !== 1 ? 'is-low' : ''} ${i.vote === 1 ? 'is-useful' : i.vote === -1 ? 'is-useless' : ''}" data-id="${esc(i.id)}">
    <div class="sg-item-head">
      <span class="sg-src">${esc(srcName(i.sourceId))}</span><span class="sg-time">${timeOf(i.date)}</span>
      ${i.topic ? `<button type="button" class="tag sg-topic" data-sg-topic="${esc(i.topic)}">${esc(i.topic)}</button>` : ''}
      ${i.importance === 3 ? '<span class="pill warn">важно</span>' : ''}${focus ? '<span class="pill accent">по фокусу</span>' : ''}${i.importance === 1 && !focus && i.vote !== 1 ? '<span class="tiny faint">фон</span>' : ''}
      ${i.saved ? `<span class="pill accent">${icon('bookmark')}</span>` : ''}
      ${dups.length ? `<button type="button" class="link sg-dups-btn" data-action="sg-dups" data-id="${esc(i.id)}">+${dups.length} ${plural(dups.length, 'похожая', 'похожие', 'похожих')}</button>` : ''}
    </div>
    ${dups.length && dupsOpen ? `<div class="sg-dups">${dups.map(d => `<div class="tiny"><span class="muted">${esc(srcName(d.sourceId))}:</span> ${d.link ? `<a href="${esc(d.link)}" target="_blank" rel="noopener">${esc(d.title)}</a>` : esc(d.title)}</div>`).join('')}</div>` : ''}
    <button type="button" class="sg-title" data-action="sg-toggle" data-id="${esc(i.id)}">${esc(i.title)}</button>
    ${i.brief ? `<div class="sg-brief">${esc(i.brief).split('\n').filter(Boolean).map(l => `<div>${l}</div>`).join('')}</div>` : briefing ? '<div class="sg-brief muted">Читаю статью…</div>' : ''}
    ${i.summary && i.summary !== i.title && !(i.brief && !open) ? `<div class="sg-summary ${open ? '' : 'clamp'}">${esc(i.summary)}</div>` : ''}
    <div class="sg-actions">
      ${i.link ? `<a class="btn sm secondary" href="${esc(i.link)}" target="_blank" rel="noopener" data-action="sg-open" data-id="${esc(i.id)}">${icon('link')} Открыть${host ? ` <span class="faint">${esc(host)}</span>` : ''}</a>` : ''}
      ${i.link && aiReady() && !i.brief ? `<button type="button" class="btn sm secondary" data-action="sg-brief" data-id="${esc(i.id)}" ${briefing ? 'disabled' : ''} title="Прочитать статью и пересказать в трёх строках">${icon('zap')} ${briefing ? 'Читаю…' : 'Кратко'}</button>` : ''}
      <button type="button" class="icon-btn sm ${i.saved ? 'on' : ''}" data-action="sg-save" data-id="${esc(i.id)}" aria-label="${i.saved ? 'Убрать из сохранённых' : 'Сохранить'}" title="${i.saved ? 'Убрать из сохранённых' : 'Сохранить'}">${icon('bookmark')}</button>
      <button type="button" class="icon-btn sm" data-action="sg-note" data-id="${esc(i.id)}" aria-label="В заметки" title="В заметки">${icon('pen')}</button>
      <button type="button" class="icon-btn sm" data-action="sg-task" data-id="${esc(i.id)}" aria-label="В задачи" title="В задачи (инбокс)">${icon('check')}</button>
      <span class="sg-vote"><button type="button" class="chip xs ${i.vote === 1 ? 'active good' : ''}" data-action="sg-vote" data-v="1" data-id="${esc(i.id)}" title="Полезно: таких новостей хочу больше">${icon('star')} полезно</button><button type="button" class="chip xs ${i.vote === -1 ? 'active' : ''}" data-action="sg-vote" data-v="-1" data-id="${esc(i.id)}" title="Не полезно: похожее уйдёт в фон">не полезно</button></span>
      ${i.read ? '' : `<button type="button" class="link" data-action="sg-read" data-id="${esc(i.id)}">прочитано</button>`}
    </div>
  </article>`;
}

// ---------- Сводка ----------
function digestView() {
  const s = db.settings();
  const dg = todayDigest(), wk = weekDigest();
  const srcs = sources();
  if (!srcs.length) return emptyAction({ text: 'Сводка собирается из ваших источников. Сначала добавьте хотя бы один.', action: 'sg-tab-sources', label: 'Добавить источник' });
  const ready = aiReady();
  const busy = digestBusy();
  const input = digestInput({ hours: Number(s.signalsHours) || 24 });
  const weekInput = digestInput({ hours: 168, limit: 70, maxChars: 14000 });
  const head = `<div class="card sg-digest-card" data-block="signals-digest" data-block-title="Сводка дня">
    <div class="section-title"><h2>${icon('zap')} Сводка ${dg ? `на ${esc(fmtDate(dg.date))}` : 'на сегодня'}</h2>
      <span class="row tiny muted" style="gap:8px">${ready ? esc(aiLabel()) : 'помощник не подключён'}</span></div>
    ${busy === 'day' ? `<div class="sg-digest-text" data-sg-draft="day">${md(digestDraft) || '<p class="muted">Читаю записи…</p>'}</div><div class="tiny muted" style="margin-top:8px">Собираю сводку…</div>`
      : digestError ? `<div class="small bad" style="margin-bottom:10px">${esc(digestError)}</div>` : ''}
    ${busy !== 'day' && dg ? `<div class="sg-digest-text">${md(cleanDigest(dg.text))}</div>` : ''}
    ${busy !== 'day' && !dg && !digestError ? `<div class="small muted" style="margin-bottom:12px">${isMorningRun() ? 'Утренняя сводка собирается сама, подождите минуту…' : input.items.length ? `Готово к сборке: ${input.items.length} ${plural(input.items.length, 'запись', 'записи', 'записей')} за ${hoursLabel(s.signalsHours)}.${s.signalsAutoDigest !== false ? ' Обычно сводка собирается сама при первом открытии за день.' : ''}` : 'Записей для сводки пока нет — сначала обновите ленту.'}</div>` : ''}
    <div class="row wrap" style="gap:8px;margin-top:12px;align-items:center">
      ${ready ? `<button type="button" class="btn ${dg ? 'secondary' : ''}" data-action="sg-digest" ${busy || !input.items.length ? 'disabled' : ''}>${icon('zap')} ${dg ? 'Собрать заново' : 'Собрать сводку'}</button>` : `<a class="btn" href="#/settings">${icon('settings')} Подключить помощника</a>`}
      ${busy === 'day' ? `<button type="button" class="btn secondary" data-action="sg-digest-stop">Остановить</button>` : ''}
      <label class="row tiny muted" style="gap:6px">за <select class="input" data-sg-hours style="width:auto;padding:5px 8px">${[[12, '12 часов'], [24, 'сутки'], [48, '2 дня'], [168, 'неделю']].map(([v, l]) => `<option value="${v}" ${Number(s.signalsHours) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${dg && busy !== 'day' ? `<button type="button" class="btn sm secondary" data-action="sg-digest-note" data-kind="day">${icon('pen')} В заметки</button><button type="button" class="btn sm secondary" data-action="sg-digest-copy" data-kind="day">${icon('copy')} Копировать</button>` : ''}
    </div>
    ${!ready ? `<div class="tiny muted" style="margin-top:10px">${aiProvider() === 'ollama' ? 'Локальная модель отвечает только на Mac, где запущена Ollama. Откройте ULTIMATE через start.command или включите Claude в Настройках.' : 'Вставьте ключ Claude в Настройках.'}</div>` : ''}
  </div>`;
  const week = `<div class="card sg-digest-card" data-block="signals-week" data-block-title="Обзор недели">
    <div class="section-title"><h2>${icon('calendar')} Обзор недели${wk ? ` <span class="tiny muted" style="font-weight:400">с ${esc(fmtDate(wk.date))}</span>` : ''}</h2></div>
    ${busy === 'week' ? `<div class="sg-digest-text" data-sg-draft="week">${md(weekDraft) || '<p class="muted">Читаю записи за неделю…</p>'}</div>` : weekError ? `<div class="small bad" style="margin-bottom:10px">${esc(weekError)}</div>` : ''}
    ${busy !== 'week' && wk ? `<div class="sg-digest-text">${md(cleanDigest(wk.text))}</div>` : ''}
    ${busy !== 'week' && !wk && !weekError ? `<div class="small muted">Что изменилось за неделю по темам, тренд и выводы — для стратегических решений, а не для ленты.${s.signalsWeekly !== false ? ' Собирается сам по понедельникам' : ''}${weekInput.items.length ? ` · записей за неделю: ${weekInput.items.length}` : ''}.</div>` : ''}
    ${ready ? `<div class="row wrap" style="gap:8px;margin-top:12px"><button type="button" class="btn ${wk ? 'secondary' : ''} sm" data-action="sg-week" ${busy || weekInput.items.length < 3 ? 'disabled' : ''}>${icon('zap')} ${wk ? 'Собрать заново' : 'Собрать обзор недели'}</button>${busy === 'week' ? `<button type="button" class="btn secondary sm" data-action="sg-digest-stop">Остановить</button>` : ''}${wk && busy !== 'week' ? `<button type="button" class="btn sm secondary" data-action="sg-digest-note" data-kind="week">${icon('pen')} В заметки</button><button type="button" class="btn sm secondary" data-action="sg-digest-copy" data-kind="week">${icon('copy')} Копировать</button>` : ''}</div>` : ''}
  </div>`;
  const focus = `<div class="card" data-block="signals-focus" data-block-title="Что важно">
    <div class="section-title"><h2>${icon('target')} Что мне важно</h2></div>
    <div class="tiny muted" style="margin-bottom:8px">Фразы через запятую. Новости с ними поднимаются наверх ленты с пометкой «по фокусу», идут в «Главное» сводки, а модель считает их важными при разметке. Например: «регуляция igaming, Мальта, платёжные решения, конкуренты».</div>
    <textarea class="input" data-sg-focus rows="2" placeholder="Темы, компании, страны, люди — через запятую">${esc(s.signalsFocus || '')}</textarea>
    <div class="tiny muted" style="margin:12px 0 6px">Темы для разметки ленты (через запятую). Модель относит каждую новость к одной из них, оценивает важность и склеивает повторы. Темы становятся вкладками ленты.</div>
    <input class="input" data-sg-topics value="${esc(topics().join(', '))}" placeholder="${esc(DEFAULT_TOPICS.join(', '))}">
    <label class="row tiny muted" style="gap:8px;margin-top:10px"><input type="checkbox" data-sg-autotag ${s.signalsAutoTag !== false ? 'checked' : ''}> Размечать новые записи автоматически после обновления ленты</label>
    <label class="row tiny muted" style="gap:8px;margin-top:6px"><input type="checkbox" data-sg-autodigest ${s.signalsAutoDigest !== false ? 'checked' : ''}> Собирать сводку дня самой при первом открытии приложения</label>
    <label class="row tiny muted" style="gap:8px;margin-top:6px"><input type="checkbox" data-sg-weekly ${s.signalsWeekly !== false ? 'checked' : ''}> Обзор недели по понедельникам</label>
  </div>`;
  const past = [...digests('day').filter(d => d.id !== dg?.id), ...digests('week').filter(d => d.id !== wk?.id)].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const history = past.length ? `<details class="sg-past" data-block="signals-past" data-block-title="Прошлые сводки"><summary class="btn secondary sm">${icon('clock')} Прошлые сводки · ${past.length}</summary>
    <div class="stack" style="margin-top:10px">${past.slice(0, 14).map(d => `<div class="card"><div class="row between"><b class="small">${d.kind === 'week' ? 'Неделя с ' : ''}${esc(fmtDate(d.date, { weekday: d.kind !== 'week' }))}</b><button type="button" class="link" data-action="sg-digest-del" data-id="${esc(d.id)}">удалить</button></div><div class="sg-digest-text small">${md(cleanDigest(d.text))}</div></div>`).join('')}</div></details>` : '';
  return `<div class="sg-digest">${head}${week}${focus}${history}</div>`;
}
const hoursLabel = (h) => ({ 12: '12 часов', 24: 'сутки', 48: '2 дня', 168: 'неделю' }[Number(h)] || `${h} ч`);

// ---------- Источники ----------
function sourcesView() {
  const list = sources();
  const b = bridgeStatus();
  const unreadBy = {}; for (const i of items()) if (!i.read) unreadBy[i.sourceId] = (unreadBy[i.sourceId] || 0) + 1;
  const mode = proxyMode();
  const have = new Set(list.map(s => s.feedUrl)); const haveUrl = new Set(list.map(s => String(s.url || '').toLowerCase()));
  const inSet = (u) => { const low = String(u).toLowerCase(); return have.has(u) || haveUrl.has(low) || haveUrl.has(low.replace(/\/$/, '')) || (low.startsWith('@') && haveUrl.has(`https://t.me/${low.slice(1)}`)); };
  const presets = `<div class="card" data-block="signals-presets" data-block-title="Готовые наборы">
    <div class="section-title"><h2>${icon('layers')} Готовые наборы</h2></div>
    <div class="tiny muted" style="margin-bottom:10px">Подборки источников одним нажатием. Каждый адрес проверяется при добавлении; уже добавленные пропускаются.</div>
    <div class="sg-presets">${PRESETS.map(p => { const left = p.items.filter(x => !inSet(x.url)); const run = preset?.id === p.id; return `<div class="sg-preset">
      <div class="main"><div class="small bold">${esc(p.name)} <span class="faint" style="font-weight:400">· ${p.items.length}</span></div><div class="tiny muted">${esc(p.desc)}</div><div class="tiny faint ellipsis">${p.items.map(x => x.name).join(' · ')}</div>
        ${run ? `<div class="tiny accent" style="margin-top:4px">добавляю ${preset.done} из ${preset.total}…</div>` : ''}
        ${!run && preset?.id === 'done:' + p.id && preset.failed.length ? `<div class="tiny warn" style="margin-top:4px">не удалось: ${preset.failed.map(esc).join(', ')}</div>` : ''}</div>
      <button type="button" class="btn sm ${left.length ? '' : 'secondary'}" data-action="sg-preset" data-id="${p.id}" ${!left.length || preset?.id === p.id ? 'disabled' : ''}>${left.length ? `${icon('plus')} Добавить${left.length < p.items.length ? ` ещё ${left.length}` : ''}` : 'Добавлено'}</button>
    </div>`; }).join('')}</div>
  </div>`;
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
    ${list.length ? `<div class="list sg-src-list" data-block="signals-sources" data-block-title="Источники">${list.map(s => { const st = sourceStats(s.id); return `<div class="list-item sg-src ${s.paused ? 'is-paused' : ''} ${s.lastError ? 'has-error' : ''}">
        <div class="main">
          <div class="row wrap" style="gap:6px;align-items:center"><button type="button" class="sg-src-name" data-action="sg-src-edit" data-id="${esc(s.id)}">${esc(s.name)}</button><span class="tag">${esc(KINDS[s.kind] || s.kind)}</span>${s.tag ? `<span class="tag">#${esc(s.tag)}</span>` : ''}${s.paused ? '<span class="pill warn">выключен</span>' : ''}${unreadBy[s.id] ? `<span class="pill accent">${unreadBy[s.id]} новых</span>` : ''}${st.noisy && !s.paused ? '<span class="pill bad" title="Много фона и неполезного, важного нет">шумный</span>' : st.strong ? '<span class="pill good" title="Приносит важные и полезные новости">сильный</span>' : ''}</div>
          <div class="tiny muted ellipsis">${esc(s.feedUrl)}</div>
          <div class="tiny ${s.lastError ? 'bad' : 'faint'}">${s.lastError ? `Ошибка: ${esc(s.lastError)}` : `обновлено ${ago(s.lastFetchAt)}${s.lastCount ? ` · +${s.lastCount}` : ''}`}</div>
          ${st.total ? `<div class="tiny muted sg-src-stats">записей ${st.total}${st.tagged ? ` · важных <b class="${st.hot ? 'good' : ''}">${st.hot}</b> · фон ${st.low}` : ''}${st.up || st.down ? ` · полезно <b class="good">${st.up}</b> · не полезно <b class="${st.down ? 'bad' : ''}">${st.down}</b>` : ''}</div>` : ''}
        </div>
        <div class="row" style="gap:4px">
          <button type="button" class="icon-btn sm" data-action="sg-src-refresh" data-id="${esc(s.id)}" aria-label="Обновить" title="Обновить">${icon('refresh')}</button>
          <button type="button" class="icon-btn sm ${s.paused ? '' : 'on'}" data-action="sg-src-pause" data-id="${esc(s.id)}" aria-label="${s.paused ? 'Включить' : 'Выключить'}" title="${s.paused ? 'Включить' : 'Выключить (записи останутся, новые не загружаются)'}">${icon(s.paused ? 'play' : 'pause')}</button>
          <button type="button" class="icon-btn sm" data-action="sg-src-del" data-id="${esc(s.id)}" aria-label="Удалить" title="Удалить">${icon('trash')}</button>
        </div>
      </div>`; }).join('')}</div>` : ''}
    ${presets}
    <details class="sg-adv" data-block="signals-bridge" data-block-title="Как загружаются ленты">
      <summary class="btn secondary sm">${icon('sliders')} Как загружаются ленты</summary>
      <div class="card" style="margin-top:10px">
        <div class="small" style="margin-bottom:8px">Браузер не умеет читать чужие сайты напрямую, поэтому ленты идут через «мост». ${b.local ? '<span class="good">Сейчас работает локальный мост ULTIMATE</span> — самый надёжный вариант.' : 'Локальный мост не найден: откройте ULTIMATE через <b>start.command</b> на Mac, и ленты будут загружаться через него. Пока используется запасной путь — публичный прокси, который видит только адреса лент.'}</div>
        <label class="field"><span class="tiny muted">Способ загрузки</span><select class="input" data-sg-proxy style="width:auto">${[['auto', 'Автоматически (рекомендуется)'], ['local', 'Только локальный мост'], ['direct', 'Только напрямую'], ['custom', 'Свой адрес моста']].map(([v, l]) => `<option value="${v}" ${(['auto', 'local', 'direct'].includes(mode) ? mode : 'custom') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        ${!['auto', 'local', 'direct'].includes(mode) ? `<input class="input" data-sg-proxy-url value="${esc(mode)}" placeholder="https://мой-прокси/?url={url}" style="margin-top:8px">` : ''}
        <div class="tiny muted" style="margin-top:8px">Хранить непрочитанное: <select class="input" data-sg-keep style="width:auto;padding:4px 8px">${[[7, '7 дней'], [14, '14 дней'], [30, '30 дней']].map(([v, l]) => `<option value="${v}" ${Number(db.settings().signalsKeepDays) === v ? 'selected' : ''}>${l}</option>`).join('')}</select> · сохранённые и полезные остаются навсегда</div>
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
let lastParams = '';
export async function render(root, { params }) {
  // Параметры адреса применяем один раз: перерисовка после записи в базу не должна возвращать на вкладку из ссылки
  const key = JSON.stringify(params || {});
  if (key !== lastParams) {
    lastParams = key;
    if (params?.tab && ['feed', 'digest', 'sources'].includes(params.tab)) tab = params.tab;
    if (params?.topic) { topicFilter = params.topic; tab = 'feed'; }
  }
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
  on(root, 'click', '[data-action="sg-go-digest"]', () => { tab = 'digest'; rerender(); if (!todayDigest() && !digestBusy()) buildDigest(false); });
  on(root, 'click', '[data-sg-filter]', (e, el) => { filter = el.dataset.sgFilter; rerender(); });
  on(root, 'click', '[data-sg-src]', (e, el) => { srcFilter = srcFilter === el.dataset.sgSrc ? '' : el.dataset.sgSrc; rerender(); });
  on(root, 'click', '[data-sg-topic]', (e, el) => { const t = el.dataset.sgTopic; topicFilter = el.classList.contains('tab') ? t : (topicFilter === t ? '' : t); tab = 'feed'; rerender(); });
  on(root, 'click', '[data-action="sg-dups"]', (e, el) => { const k = 'dups:' + el.dataset.id; if (expanded.has(k)) expanded.delete(k); else expanded.add(k); rerender(); });
  on(root, 'click', '[data-action="sg-more"]', (e, el) => { const k = 'more:' + el.dataset.day; if (expanded.has(k)) expanded.delete(k); else expanded.add(k); rerender(); });
  on(root, 'click', '[data-action="sg-tag"]', () => doTag());
  on(root, 'change', '[data-sg-topics]', (e, el) => { const list = [...new Set(el.value.split(/[,;\n]/).map(x => x.trim()).filter(Boolean))]; db.setSettings({ signalsTopics: list.length ? list : null }); toast('Темы сохранены'); rerender(); });
  on(root, 'change', '[data-sg-autotag]', (e, el) => { db.setSettings({ signalsAutoTag: el.checked }); });
  on(root, 'change', '[data-sg-autodigest]', (e, el) => { db.setSettings({ signalsAutoDigest: el.checked }); });
  on(root, 'change', '[data-sg-weekly]', (e, el) => { db.setSettings({ signalsWeekly: el.checked }); });
  on(root, 'click', '[data-action="sg-refresh"]', () => doRefresh());
  on(root, 'click', '[data-action="sg-read-all"]', () => {
    let list = items().filter(i => !i.read); if (srcFilter) list = list.filter(i => i.sourceId === srcFilter); if (topicFilter) list = list.filter(i => i.topic === topicFilter);
    for (const i of list) db.update('signalItems', i.id, { read: true });
    toast(`Прочитано: ${list.length}`); rerender();
  });
  on(root, 'click', '[data-action="sg-toggle"]', (e, el) => { const id = el.dataset.id; if (expanded.has(id)) expanded.delete(id); else expanded.add(id); const it = db.get('signalItems', id); if (it && !it.read) db.update('signalItems', id, { read: true }); rerender(); });
  on(root, 'click', '[data-action="sg-open"]', (e, el) => { const it = db.get('signalItems', el.dataset.id); if (it && !it.read) db.update('signalItems', it.id, { read: true }); setTimeout(rerender, 300); });
  on(root, 'click', '[data-action="sg-read"]', (e, el) => { db.update('signalItems', el.dataset.id, { read: true }); rerender(); });
  on(root, 'click', '[data-action="sg-vote"]', (e, el) => { const v = vote(el.dataset.id, Number(el.dataset.v)); if (v === 1) toast('Полезно — таких новостей будет больше'); else if (v === -1) toast('Не полезно — похожее уйдёт в фон'); rerender(); });
  on(root, 'click', '[data-action="sg-brief"]', async (e, el) => {
    const id = el.dataset.id; rerenderSoon();
    try { await brief(id); } catch (err) { toast('Не удалось пересказать: ' + (err.message || err), 4000); }
    rerender();
  });
  on(root, 'click', '[data-action="sg-save"]', (e, el) => { const it = db.get('signalItems', el.dataset.id); if (!it) return; db.update('signalItems', it.id, { saved: !it.saved, read: true }); toast(it.saved ? 'Убрано из сохранённых' : 'Сохранено'); rerender(); });
  on(root, 'click', '[data-action="sg-note"]', (e, el) => {
    const it = db.get('signalItems', el.dataset.id); if (!it) return;
    const src = sources().find(s => s.id === it.sourceId);
    addNote({ type: /иде/i.test(it.topic || '') ? 'idea' : 'note', title: it.title, body: `${it.brief ? it.brief + '\n\n' : ''}${it.summary && it.summary !== it.title ? it.summary + '\n\n' : ''}${it.link}`, tags: ['сигналы', ...(it.topic ? [it.topic.toLowerCase()] : []), ...(src?.tag ? [src.tag] : [])], date: today(), ...(/иде/i.test(it.topic || '') ? { status: 'new', impact: 2, effort: 2 } : {}) });
    db.update('signalItems', it.id, { read: true, saved: true }); toast(/иде/i.test(it.topic || '') ? 'Записано в идеи' : 'Записано в заметки'); rerender();
  });
  on(root, 'click', '[data-action="sg-task"]', (e, el) => {
    const it = db.get('signalItems', el.dataset.id); if (!it) return;
    addTask({ title: it.title, notes: `${it.brief ? it.brief + '\n' : ''}${it.link}`, tags: ['сигналы'], link: it.link ? { kind: 'url', url: it.link, label: srcName(it.sourceId) } : null });
    db.update('signalItems', it.id, { read: true }); toast('Задача добавлена в инбокс'); rerender();
  });
  // сводка
  on(root, 'click', '[data-action="sg-digest"]', () => buildDigest(false));
  on(root, 'click', '[data-action="sg-week"]', () => buildDigest(true));
  on(root, 'click', '[data-action="sg-digest-stop"]', () => digestCtl?.abort());
  on(root, 'click', '[data-action="sg-digest-note"]', (e, el) => { const w = el.dataset.kind === 'week'; const d = w ? weekDigest() : todayDigest(); if (!d) return; addNote({ type: 'note', title: w ? `Обзор недели с ${fmtDate(d.date)}` : `Сводка новостей ${fmtDate(d.date)}`, body: d.text, tags: ['сигналы', w ? 'неделя' : 'сводка'], date: today() }); toast('Записано в заметки'); });
  on(root, 'click', '[data-action="sg-digest-copy"]', async (e, el) => { const d = el.dataset.kind === 'week' ? weekDigest() : todayDigest(); if (!d) return; try { await navigator.clipboard.writeText(d.text); toast('Скопировано'); } catch { toast('Не удалось скопировать'); } });
  on(root, 'click', '[data-action="sg-digest-del"]', (e, el) => { db.remove('signalDigests', el.dataset.id); rerender(); });
  on(root, 'change', '[data-sg-hours]', (e, el) => { db.setSettings({ signalsHours: Number(el.value) || 24 }); rerender(); });
  on(root, 'change', '[data-sg-focus]', (e, el) => { db.setSettings({ signalsFocus: el.value.trim() }); toast('Сохранено'); rerender(); });
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
  on(root, 'click', '[data-action="sg-preset"]', (e, el) => addPreset(el.dataset.id));
  on(root, 'click', '[data-action="sg-src-edit"]', (e, el) => { const s = db.get('signalSources', el.dataset.id); if (s) openSourceModal(s); });
  on(root, 'click', '[data-action="sg-src-pause"]', (e, el) => { const s = db.get('signalSources', el.dataset.id); if (s) { db.update('signalSources', s.id, { paused: !s.paused }); toast(s.paused ? 'Источник включён' : 'Источник выключен: новые записи не загружаются'); rerender(); } });
  on(root, 'click', '[data-action="sg-src-del"]', (e, el) => { const s = db.get('signalSources', el.dataset.id); if (s && confirm(`Удалить источник «${s.name}»? Сохранённые записи останутся.`)) { removeSource(s.id); toast('Источник удалён'); rerender(); } });
  on(root, 'click', '[data-action="sg-src-refresh"]', async (e, el) => { const s = db.get('signalSources', el.dataset.id); if (!s) return; el.disabled = true; const r = await refreshSource(s); toast(r.ok ? `+${r.added} новых` : r.error); prune(); rerender(); });
  on(root, 'change', '[data-sg-proxy]', (e, el) => { const v = el.value; if (v === 'custom') { db.setSettings({ signalsProxy: 'https://api.allorigins.win/raw?url={url}' }); } else db.setSettings({ signalsProxy: v }); rerender(); });
  on(root, 'change', '[data-sg-proxy-url]', (e, el) => { const v = el.value.trim(); if (v.includes('{url}')) { db.setSettings({ signalsProxy: v }); toast('Сохранено'); } else toast('В адресе должно быть {url}'); });
  on(root, 'change', '[data-sg-keep]', (e, el) => { db.setSettings({ signalsKeepDays: Number(el.value) || 14 }); prune(); rerender(); });

  let rerenderTm = null;
  function rerenderSoon() { clearTimeout(rerenderTm); rerenderTm = setTimeout(rerender, 30); }
  async function doRefresh() {
    if (isRefreshing() || !activeSources().length) return;
    refreshNote = ''; rerender();
    const r = await refreshAll({ onProgress: () => rerender() });
    if (r) { refreshNote = r.added ? `+${r.added} ${plural(r.added, 'новая', 'новые', 'новых')}` : 'новых нет'; if (r.failed) toast(`Не загрузились: ${r.failed} ${plural(r.failed, 'источник', 'источника', 'источников')}`); }
    rerender();
    if (db.settings().signalsAutoTag !== false && untagged().length && aiReady()) doTag();
  }
  async function doTag() {
    if (isTagging() || !aiReady()) return;
    const r = await tagNew({ onProgress: () => rerender() });
    if (r?.done) toast(`Размечено: ${r.done}${r.errors ? `, с ошибками: ${r.errors}` : ''}`);
    rerender();
  }
  async function buildDigest(weekly) {
    if (digestBusy() || !aiReady()) return;
    if (weekly) { weekDraft = ''; weekError = ''; } else { digestDraft = ''; digestError = ''; }
    digestCtl = new AbortController(); tab = 'digest';
    let tick = 0;
    try {
      const r = await makeDigest({ weekly, signal: digestCtl.signal, minItems: weekly ? 3 : 1, onText: (draft) => { if (weekly) weekDraft = draft; else digestDraft = draft; if (++tick % 6 === 0) { const box = root.querySelector(`[data-sg-draft="${weekly ? 'week' : 'day'}"]`); if (box) box.innerHTML = md(draft); } } });
      if (r === null) toast('Нет записей для сводки — обновите ленту');
    } catch (e) {
      if (e.name !== 'AbortError') { if (weekly) weekError = String(e.message || e); else digestError = String(e.message || e); }
    }
    digestCtl = null; rerender();
  }
  async function addPreset(id) {
    const p = PRESETS.find(x => x.id === id); if (!p || preset?.id === id) return;
    const have = new Set(sources().map(s => s.feedUrl)); const haveUrl = new Set(sources().map(s => String(s.url || '').toLowerCase()));
    const todo = p.items.filter(x => { const low = x.url.toLowerCase(); return !(have.has(x.url) || haveUrl.has(low) || haveUrl.has(low.replace(/\/$/, '')) || (low.startsWith('@') && haveUrl.has(`https://t.me/${low.slice(1)}`))); });
    preset = { id, done: 0, total: todo.length, added: 0, failed: [] }; rerender();
    for (const x of todo) {
      try { const r = await resolveSource(x.url); const src = addSource({ ...r, tag: p.name.toLowerCase() }); if (!src.renamed && x.name && src.name !== x.name && src.kind !== 'telegram') db.update('signalSources', src.id, { name: x.name, renamed: true }); if (!src.lastFetchAt) await refreshSource(src); preset.added++; }
      catch (e) { preset.failed.push(x.name); console.warn('preset', x.url, e); }
      preset.done++; rerender();
    }
    const { added, failed } = preset;
    preset = { id: 'done:' + id, failed }; prune(); rerender();
    toast(`Добавлено: ${added}${failed.length ? `, не удалось: ${failed.length}` : ''}`, 4000);
    if (db.settings().signalsAutoTag !== false && untagged().length && aiReady()) doTag();
  }

  // Автообновление: раз в час при открытии, если есть источники
  const onSig = () => rerenderSoon();
  window.addEventListener('ultimate:signals', onSig);
  probeLocal().then(() => { if (tab === 'sources') rerender(); });
  if (activeSources().length && staleFor() && !isRefreshing()) doRefresh();

  return () => { window.removeEventListener('ultimate:signals', onSig); clearTimeout(rerenderTm); };
}
