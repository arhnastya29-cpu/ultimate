// Обучение: «Сейчас» (материал в работе, таймер, последние занятия) → Материалы → Области → Карточки → Статистика.
import { db } from '../db.js';
import {
  esc, icon, modal, field, formRow, toast, today, addDays, fmtDate, weekDays, lastNDays, parseISO,
  fmtMinutes, progressBar, barChart, ring, on, sum, sortBy, clamp, plural,
  tabs, statLine, emptyAction, pageMenu,
} from '../ui.js';

export const title = 'Обучение';

// ---------- Справочники ----------
const TYPES = { course: 'Курс', book: 'Книга', article: 'Статья', video: 'Видео', practice: 'Практика', other: 'Другое' };
const TYPE_CLS = { course: 'accent', book: 'info', article: '', video: 'warn', practice: 'good', other: '' };
const STATUSES = { planned: 'Запланировано', active: 'В работе', done: 'Готово' };
const STATUS_ORDER = { active: 0, planned: 1, done: 2 };
const COLORS = [
  ['var(--c1)', 'Фиолетовый'], ['var(--c2)', 'Зелёный'], ['var(--c3)', 'Жёлтый'], ['var(--c4)', 'Красный'],
  ['var(--c5)', 'Синий'], ['var(--c6)', 'Розовый'], ['var(--c7)', 'Бирюзовый'], ['var(--c8)', 'Коричневый'],
];
const SEED_AREAS = [
  { name: 'Психология', icon: '🧠', color: 'var(--c1)' },
  { name: 'История', icon: '🏛️', color: 'var(--c2)' },
  { name: 'Менеджмент', icon: '📊', color: 'var(--c3)' },
  { name: 'Лидерство', icon: '🚀', color: 'var(--c4)' },
  { name: 'Эмпатия', icon: '💛', color: 'var(--c5)' },
  { name: 'Английский', icon: '🇬🇧', color: 'var(--c6)' },
];
const GRADES = [
  { key: 'again', label: 'Снова', cls: 'danger' },
  { key: 'hard', label: 'Трудно', cls: 'secondary' },
  { key: 'good', label: 'Хорошо', cls: '' },
  { key: 'easy', label: 'Легко', cls: 'good' },
];
const LEARNED_INTERVAL = 21;
const TABS = [['now', 'Сейчас'], ['items', 'Материалы'], ['areas', 'Области'], ['cards', 'Карточки'], ['stats', 'Статистика']];
const STEP = 10; // «следующий шаг» = +10% прогресса материала

// ---------- Локальное состояние (переживает перерисовку) ----------
let tab = 'now';
let selectedArea = null;   // id области-фильтра для материалов
let itemFilter = 'all';    // all | active | planned | done
let timerStart = null;     // ms, если таймер запущен
let timerInterval = null;
let seedChecked = false;

// ---------- Помощники ----------
const fmtElapsed = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
const colorBar = (value, max, color) => {
  const pct = max > 0 ? clamp((value / max) * 100, 0, 100) : 0;
  return `<div class="bar"><i style="width:${pct.toFixed(1)}%;background:${esc(color || 'var(--accent)')}"></i></div>`;
};
const safeUrl = (u) => /^https?:\/\//i.test(u || '') ? u : '';
const areaLabel = (a) => a ? `${a.icon || '📚'} ${a.name}` : 'Без области';
const findEnglish = (areas) => areas.find(a => String(a.name).trim().toLowerCase() === 'английский') || null;
const sessionWord = (n) => plural(n, 'занятие', 'занятия', 'занятий');

// Упрощённый SM-2.
function schedule(card, grade) {
  let interval = Number(card.interval) || 0;
  let ease = Number(card.ease) || 2.5;
  let reps = Number(card.reps) || 0;
  let lapses = Number(card.lapses) || 0;
  if (grade === 'again') { interval = 1; lapses += 1; ease = Math.max(1.3, ease - 0.2); }
  else if (grade === 'hard') { interval = Math.max(1, Math.round(interval * 1.2)); }
  else if (grade === 'good') { interval = reps === 0 ? 1 : reps === 1 ? 3 : Math.round(interval * ease); }
  else { interval = Math.round(Math.max(interval, 1) * ease * 1.3); ease += 0.15; }
  interval = Math.max(1, interval);
  return { interval, ease: Math.round(ease * 100) / 100, reps: reps + 1, lapses, due: addDays(today(), interval) };
}

function seedAreasIfEmpty() {
  if (seedChecked) return;
  seedChecked = true;
  if (db.all('learningAreas').length) return;
  for (const a of SEED_AREAS) db.add('learningAreas', { ...a, description: '', weeklyMinutesTarget: 60 });
}

// ---------- Рендер ----------
export async function render(root, ctx = {}) {
  seedAreasIfEmpty();
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  if (ctx.params?.tab && TABS.some(([id]) => id === ctx.params.tab)) tab = ctx.params.tab;

  const rerender = () => {
    const y = window.scrollY;
    return render(root, ctx).then(() => window.scrollTo(0, y));
  };

  const settings = db.settings();
  const weeklyTarget = Number(settings.learningWeeklyMinutes) || 0;
  const areas = sortBy(db.all('learningAreas'), a => a.createdAt || '');
  const areaById = Object.fromEntries(areas.map(a => [a.id, a]));
  if (selectedArea && !areaById[selectedArea]) selectedArea = null;
  const items = db.all('learningItems');
  const itemById = Object.fromEntries(items.map(i => [i.id, i]));
  const sessions = db.all('studySessions');
  const cards = db.all('flashcards');
  const t = today();

  // Неделя
  const week = weekDays(t);
  const weekSet = new Set(week);
  const weekSessions = sessions.filter(s => weekSet.has(s.date));
  const weekMinutes = sum(weekSessions, s => s.minutes);
  const todayMinutes = sum(sessions.filter(s => s.date === t), s => s.minutes);
  const weekPct = weeklyTarget > 0 ? (weekMinutes / weeklyTarget) * 100 : 0;
  const minutesByArea = {};
  for (const s of weekSessions) minutesByArea[s.areaId] = (minutesByArea[s.areaId] || 0) + (Number(s.minutes) || 0);

  // Серия дней подряд
  const daySet = new Set(sessions.map(s => s.date));
  let streak = 0, d = t;
  if (!daySet.has(d)) d = addDays(d, -1);
  while (daySet.has(d)) { streak++; d = addDays(d, -1); }

  // Материалы
  const activeItems = sortBy(items.filter(i => i.status === 'active'), i => i.updatedAt || i.createdAt || '', true);
  let visibleItems = items;
  if (selectedArea) visibleItems = visibleItems.filter(i => i.areaId === selectedArea);
  if (itemFilter !== 'all') visibleItems = visibleItems.filter(i => i.status === itemFilter);
  visibleItems = [...visibleItems].sort((a, b) =>
    (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const minutesByItem = {};
  for (const s of sessions) if (s.itemId) minutesByItem[s.itemId] = (minutesByItem[s.itemId] || 0) + (Number(s.minutes) || 0);

  // Последние занятия
  const recent = [...sessions].sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  // Карточки
  const dueCards = cards.filter(c => (c.due || t) <= t);
  const learnedCount = cards.filter(c => (Number(c.interval) || 0) >= LEARNED_INTERVAL).length;
  const cardsSorted = [...cards].sort((a, b) => String(a.due || '').localeCompare(String(b.due || '')));
  const CARDS_LIMIT = 30;

  // ---------- Фрагменты ----------
  const areaCard = (a) => {
    const mins = minutesByArea[a.id] || 0;
    const target = Number(a.weeklyMinutesTarget) || 0;
    const activeCount = items.filter(i => i.areaId === a.id && i.status === 'active').length;
    return `<div class="card ln-area" data-action="select-area" data-id="${esc(a.id)}" role="button" tabindex="0">
      <div class="row between top">
        <div class="row" style="min-width:0">
          <span style="font-size:24px;line-height:1">${esc(a.icon || '📚')}</span>
          <div style="min-width:0">
            <div class="bold ellipsis">${esc(a.name)}</div>
            <div class="tiny muted">${activeCount ? `${activeCount} ${plural(activeCount, 'материал', 'материала', 'материалов')} в работе` : 'нет материалов в работе'}</div>
          </div>
        </div>
        <button type="button" class="icon-btn sm" data-action="edit-area" data-id="${esc(a.id)}" aria-label="Изменить область ${esc(a.name)}">${icon('edit')}</button>
      </div>
      <div class="row between tiny muted" style="margin:12px 0 5px">
        <span class="bold" style="color:var(--fg)">${esc(fmtMinutes(mins))} за неделю</span>
        <span>${target ? `цель ${esc(fmtMinutes(target))}` : 'без цели'}</span>
      </div>
      ${colorBar(mins, target, a.color)}
    </div>`;
  };

  const itemRow = (it, { step = false } = {}) => {
    const a = areaById[it.areaId];
    const p = clamp(Number(it.progress) || 0, 0, 100);
    const url = safeUrl(it.url);
    const mins = minutesByItem[it.id] || 0;
    return `<div class="list-item ln-item">
      <div class="main">
        <div class="row wrap" style="gap:6px">
          <span class="pill ${TYPE_CLS[it.type] || ''}">${esc(TYPES[it.type] || TYPES.other)}</span>
          <button type="button" class="ln-title ${it.status === 'done' ? 'strike' : ''}" data-action="edit-item" data-id="${esc(it.id)}">${esc(it.title)}</button>
          ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener" class="tiny" aria-label="Открыть ссылку">↗</a>` : ''}
        </div>
        <div class="sub">${esc(areaLabel(a))}${step ? '' : ` · ${esc(STATUSES[it.status] || it.status)}`}${mins ? ` · ${esc(fmtMinutes(mins))}` : ''}${it.notes ? ` — ${esc(it.notes)}` : ''}</div>
        <div class="row" style="margin-top:7px">
          <div class="grow">${progressBar(p, 100, it.status === 'done' ? 'good thin' : 'thin')}</div>
          <span class="tiny mono muted" style="width:38px;text-align:right">${p}%</span>
        </div>
      </div>
      <div class="ln-item-actions">
        ${step
          ? `<button type="button" class="btn sm" data-action="step" data-id="${esc(it.id)}" ${p >= 100 ? 'disabled' : ''}>${icon('chevronRight')} Следующий шаг</button>
             <button type="button" class="btn sm secondary" data-action="log-session" data-item="${esc(it.id)}">${icon('clock')} Занятие</button>`
          : `<button type="button" class="btn sm secondary" data-action="step" data-id="${esc(it.id)}" ${p >= 100 ? 'disabled' : ''} aria-label="Следующий шаг: ${esc(it.title)}">+${STEP}%</button>`}
      </div>
    </div>`;
  };

  const sessionRow = (s) => {
    const a = areaById[s.areaId];
    const it = s.itemId ? itemById[s.itemId] : null;
    return `<div class="list-item">
      <span style="font-size:20px;line-height:1;width:28px;text-align:center">${esc(a?.icon || '📚')}</span>
      <div class="main">
        <div class="title">${esc(fmtMinutes(s.minutes))} · ${esc(a ? a.name : 'Без области')}</div>
        <div class="sub">${esc(fmtDate(s.date))}${it ? ` · ${esc(it.title)}` : ''}${s.notes ? ` — ${esc(s.notes)}` : ''}</div>
      </div>
      <button type="button" class="icon-btn sm" data-action="del-session" data-id="${esc(s.id)}" aria-label="Удалить занятие">${icon('trash')}</button>
    </div>`;
  };

  const cardRow = (c) => {
    const due = c.due || t;
    const interval = Number(c.interval) || 0;
    const pillCls = due <= t ? 'warn' : interval >= LEARNED_INTERVAL ? 'good' : '';
    const pillText = due <= t ? 'к повторению' : `${esc(fmtDate(due))}`;
    return `<div class="list-item clickable" data-action="edit-card" data-id="${esc(c.id)}">
      <div class="main">
        <div class="title">${esc(c.front)} <span class="muted" style="font-weight:500">— ${esc(c.back)}</span></div>
        ${c.example ? `<div class="sub" style="font-style:italic">${esc(c.example)}</div>` : ''}
      </div>
      <span class="pill ${pillCls}">${pillText}</span>
    </div>`;
  };

  const timerCard = () => timerStart
    ? `<div class="card ln-timer running" data-block="timer" data-block-title="Таймер">
        <div class="row between wrap">
          <div class="row"><span class="pill accent mono" id="timerElapsed">${fmtElapsed(Date.now() - timerStart)}</span><span class="small muted">занятие идёт</span></div>
          <button type="button" class="btn danger" data-action="timer-stop">${icon('x')} Стоп и записать</button>
        </div>
      </div>`
    : `<div class="card ln-timer" data-block="timer" data-block-title="Таймер">
        <div class="row between wrap">
          <div><div class="bold">Занятие</div><div class="tiny muted">Запустите таймер — минуты запишутся сами</div></div>
          <button type="button" class="btn secondary" data-action="timer-start">${icon('play')} Старт таймера</button>
        </div>
      </div>`;

  // ---------- Вкладки ----------
  const line = statLine([
    todayMinutes ? `сегодня <b>${esc(fmtMinutes(todayMinutes))}</b>` : '',
    weekMinutes ? `неделя <b>${esc(fmtMinutes(weekMinutes))}</b>${weeklyTarget ? ` из ${esc(fmtMinutes(weeklyTarget))}` : ''}` : '',
    streak ? `серия <b>${streak} ${plural(streak, 'день', 'дня', 'дней')}</b>` : '',
    dueCards.length ? [`${dueCards.length} ${plural(dueCards.length, 'карточка', 'карточки', 'карточек')} к повторению`, 'warn'] : '',
  ]);

  let body = '';
  if (tab === 'now') {
    const nothing = !items.length && !sessions.length;
    if (nothing) {
      body = emptyAction({
        text: 'Записывайте занятия и ведите материалы — здесь будет то, чем вы занимаетесь сейчас.',
        action: 'log-session', label: 'Занятие',
        second: { action: 'add-item', label: 'Добавить материал' },
      });
    } else {
      body = `${timerCard()}
      <div class="card" data-block="active" data-block-title="В работе">
        <div class="section-title"><h2>В работе</h2>${activeItems.length ? `<span class="tiny muted">${activeItems.length} ${plural(activeItems.length, 'материал', 'материала', 'материалов')}</span>` : ''}</div>
        ${activeItems.length
          ? `<div class="list">${activeItems.map(it => itemRow(it, { step: true })).join('')}</div>`
          : emptyAction({ text: 'Отметьте материал «в работе» — он появится здесь с кнопкой следующего шага.', action: 'add-item', label: 'Материал' })}
      </div>
      ${recent.length ? `<div class="card" data-block="recent" data-block-title="Последние занятия">
        <div class="section-title"><h2>Последние занятия</h2><button type="button" class="link" data-tab="stats">вся статистика</button></div>
        <div class="list">${recent.slice(0, 5).map(sessionRow).join('')}</div>
      </div>` : ''}`;
    }
  } else if (tab === 'items') {
    const segBtn = (key, label) => `<button type="button" class="chip ${itemFilter === key ? 'active' : ''}" data-action="filter" data-filter="${key}">${label}</button>`;
    body = items.length
      ? `<div class="chips ln-chips">${segBtn('all', 'Все')}${segBtn('active', 'В работе')}${segBtn('planned', 'Запланировано')}${segBtn('done', 'Готово')}</div>
        ${areas.length > 1 ? `<div class="chips ln-chips">
          <button type="button" class="chip ${!selectedArea ? 'active' : ''}" data-action="pick-area" data-id="">Все области</button>
          ${areas.map(a => `<button type="button" class="chip ${selectedArea === a.id ? 'active' : ''}" data-action="pick-area" data-id="${esc(a.id)}">${esc(areaLabel(a))}</button>`).join('')}
        </div>` : ''}
        <div class="card">
          ${visibleItems.length ? `<div class="list">${visibleItems.map(it => itemRow(it)).join('')}</div>` : `<div class="tiny muted">Ничего не найдено по текущему фильтру.</div>`}
        </div>`
      : emptyAction({ text: 'Курс, книга или статья: добавьте материал, чтобы видеть прогресс по нему.', action: 'add-item', label: 'Материал' });
  } else if (tab === 'areas') {
    body = areas.length
      ? `<div class="grid-auto ln-areas">${areas.map(areaCard).join('')}</div>`
      : emptyAction({ text: 'Области группируют материалы и занятия: например, «Психология» или «Английский».', action: 'add-area', label: 'Область' });
  } else if (tab === 'cards') {
    body = cards.length
      ? `${statLine([`всего <b>${cards.length}</b>`, dueCards.length ? [`<b>${dueCards.length}</b> к повторению`, 'warn'] : '', learnedCount ? [`<b>${learnedCount}</b> выучено`, 'good'] : ''])}
        <div class="card">
          ${dueCards.length ? `<div class="row between wrap" style="margin-bottom:10px"><span class="small">${dueCards.length} ${plural(dueCards.length, 'карточка ждёт', 'карточки ждут', 'карточек ждут')} повторения</span><button type="button" class="btn sm" data-action="review">${icon('repeat')} Повторить</button></div>` : ''}
          <div class="list">${cardsSorted.slice(0, CARDS_LIMIT).map(cardRow).join('')}</div>
          ${cards.length > CARDS_LIMIT ? `<div class="tiny muted" style="margin-top:8px">…и ещё ${cards.length - CARDS_LIMIT}</div>` : ''}
        </div>`
      : emptyAction({ text: 'Слова и фразы для повторения по интервалам: добавьте первую карточку.', action: 'add-card', label: 'Карточка' });
  } else if (tab === 'stats') {
    if (!sessions.length) {
      body = emptyAction({ text: 'Статистика появится после первого занятия.', action: 'log-session', label: 'Занятие' });
    } else {
      const byDay = {};
      for (const s of sessions) byDay[s.date] = (byDay[s.date] || 0) + (Number(s.minutes) || 0);
      const chartData = lastNDays(14, t).map(day => ({
        label: String(parseISO(day).getDate()),
        value: byDay[day] || 0,
        color: day === t ? 'var(--c6)' : 'var(--accent)',
      }));
      const dailyTarget = weeklyTarget > 0 ? Math.round(weeklyTarget / 7) : null;
      const areasWithMinutes = areas.filter(a => minutesByArea[a.id]);
      body = `<div class="card">
        <div class="row" style="gap:16px">
          ${ring(weekPct, { size: 84, stroke: 9, label: `${Math.round(weekPct)}%`, color: weekPct >= 100 ? 'var(--good)' : 'var(--accent)' })}
          <div class="grow">
            <div class="label">Эта неделя</div>
            <div class="value">${esc(fmtMinutes(weekMinutes))}</div>
            <div class="tiny muted" style="margin-top:4px">${weeklyTarget ? `из ${esc(fmtMinutes(weeklyTarget))} · ` : ''}${weekSessions.length} ${sessionWord(weekSessions.length)}${streak ? ` · серия ${streak} ${plural(streak, 'день', 'дня', 'дней')}` : ''}</div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="row between"><h3>Минуты за 14 дней</h3>${dailyTarget ? `<span class="tiny muted">пунктир — ${esc(fmtMinutes(dailyTarget))}/день</span>` : ''}</div>
        ${barChart(chartData, { height: 130, target: dailyTarget, showValues: true })}
      </div>
      ${areasWithMinutes.length ? `<div class="card">
        <h3>По областям за неделю</h3>
        <div class="stack tight">${areasWithMinutes.map(a => `<div>
          <div class="row between tiny" style="margin-bottom:4px"><span>${esc(areaLabel(a))}</span><span class="muted">${esc(fmtMinutes(minutesByArea[a.id]))}${Number(a.weeklyMinutesTarget) ? ` из ${esc(fmtMinutes(a.weeklyMinutesTarget))}` : ''}</span></div>
          ${colorBar(minutesByArea[a.id], Number(a.weeklyMinutesTarget) || Math.max(...areasWithMinutes.map(x => minutesByArea[x.id])), a.color)}
        </div>`).join('')}</div>
      </div>` : ''}
      <div class="card">
        <div class="section-title"><h2>Все занятия</h2><span class="tiny muted">последние ${Math.min(recent.length, 30)}</span></div>
        <div class="list">${recent.slice(0, 30).map(sessionRow).join('')}</div>
      </div>`;
    }
  }

  const MAIN = {
    now: ['log-session', 'Занятие'], items: ['add-item', 'Материал'], areas: ['add-area', 'Область'],
    cards: ['add-card', 'Карточка'], stats: ['log-session', 'Занятие'],
  };
  const [mainAction, mainLabel] = MAIN[tab] || MAIN.now;

  root.innerHTML = `<div class="learning-page">
    <div class="page-head">
      <div><div class="eyebrow">Знания</div><h1>Обучение</h1></div>
      <div class="actions">
        ${timerStart && tab !== 'now' ? `<button type="button" class="btn secondary" data-action="timer-stop"><span class="mono" id="timerElapsed">${fmtElapsed(Date.now() - timerStart)}</span> · Стоп</button>` : ''}
        <button type="button" class="btn" data-action="${mainAction}">${icon('plus')} ${mainLabel}</button>
        ${pageMenu([
          timerStart ? null : { label: 'Старт таймера', action: 'timer-start', icon: 'play' },
          tab !== 'now' ? { label: 'Записать занятие', action: 'log-session', icon: 'clock' } : null,
          tab !== 'items' ? { label: 'Добавить материал', action: 'add-item', icon: 'book' } : null,
          tab !== 'areas' ? { label: 'Добавить область', action: 'add-area', icon: 'layers' } : null,
          tab !== 'cards' ? { label: 'Добавить карточку', action: 'add-card', icon: 'copy' } : null,
          dueCards.length ? { label: `Повторить карточки (${dueCards.length})`, action: 'review', icon: 'repeat' } : null,
          { label: 'Настроить страницу', action: 'customize', icon: 'sliders' },
        ])}
      </div>
    </div>
    ${tabs(TABS.map(([id, label]) => [id, label, id === 'items' && activeItems.length ? activeItems.length : id === 'cards' && dueCards.length ? dueCards.length : null]), tab, 'data-tab')}
    ${line}
    <div class="ln-body stack">${body}</div>
  </div>`;

  const page = root.firstElementChild;

  // Таймер
  if (timerStart) {
    const span = root.querySelector('#timerElapsed');
    timerInterval = setInterval(() => {
      if (!timerStart || !span || !document.body.contains(span)) return;
      span.textContent = fmtElapsed(Date.now() - timerStart);
    }, 1000);
  }

  // ---------- Модалки ----------
  const areaOptions = (withEmpty = true) => [
    ...(withEmpty ? [['', 'Без области']] : []),
    ...areas.map(a => [a.id, areaLabel(a)]),
  ];

  function openAreaModal(a) {
    modal({
      title: a ? 'Область обучения' : 'Новая область',
      body: `
        ${formRow(
          field({ name: 'icon', label: 'Эмодзи', value: a?.icon ?? '📚', placeholder: '📚' }),
          field({ name: 'name', label: 'Название', value: a?.name ?? '', required: true, placeholder: 'Например, Психология' }),
        )}
        ${formRow(
          field({ name: 'color', label: 'Цвет', type: 'select', value: a?.color ?? 'var(--c1)', options: COLORS }),
          field({ name: 'weeklyMinutesTarget', label: 'Цель, мин/неделю', type: 'number', value: a?.weeklyMinutesTarget ?? 60, min: 0, step: 15 }),
        )}
        ${field({ name: 'description', label: 'Описание', type: 'textarea', value: a?.description ?? '', rows: 3 })}`,
      onSubmit: (d) => {
        const rec = { name: d.name, icon: d.icon || '📚', color: d.color || 'var(--c1)', weeklyMinutesTarget: d.weeklyMinutesTarget ?? 60, description: d.description || '' };
        if (a) db.update('learningAreas', a.id, rec); else db.add('learningAreas', rec);
        toast(a ? 'Область обновлена' : 'Область добавлена');
      },
      onDelete: a ? () => {
        if (selectedArea === a.id) selectedArea = null;
        db.remove('learningAreas', a.id);
        toast('Область удалена');
      } : undefined,
    });
  }

  function openItemModal(it) {
    modal({
      title: it ? 'Материал' : 'Новый материал',
      body: `
        ${field({ name: 'title', label: 'Название', value: it?.title ?? '', required: true, placeholder: 'Курс, книга, статья…' })}
        ${formRow(
          field({ name: 'areaId', label: 'Область', type: 'select', value: it?.areaId ?? selectedArea ?? '', options: areaOptions() }),
          field({ name: 'type', label: 'Тип', type: 'select', value: it?.type ?? 'course', options: Object.entries(TYPES) }),
        )}
        ${formRow(
          field({ name: 'status', label: 'Статус', type: 'select', value: it?.status ?? (it ? 'planned' : 'active'), options: Object.entries(STATUSES) }),
          field({ name: 'progress', label: 'Прогресс, %', type: 'number', value: it?.progress ?? 0, min: 0, max: 100, step: 5 }),
        )}
        ${field({ name: 'url', label: 'Ссылка', type: 'url', value: it?.url ?? '', placeholder: 'https://…' })}
        ${field({ name: 'notes', label: 'Заметки', type: 'textarea', value: it?.notes ?? '', rows: 3 })}`,
      onSubmit: (d) => {
        const progress = clamp(Number(d.progress) || 0, 0, 100);
        const rec = { title: d.title, areaId: d.areaId || null, type: d.type, status: d.status, progress, url: d.url || '', notes: d.notes || '' };
        if (it) db.update('learningItems', it.id, rec); else db.add('learningItems', rec);
        toast(it ? 'Материал обновлён' : 'Материал добавлен');
      },
      onDelete: it ? () => { db.remove('learningItems', it.id); toast('Материал удалён'); } : undefined,
    });
  }

  function openLogModal({ minutes = 30, areaId = null, itemId = null, date = t } = {}) {
    const itemOptions = [['', 'Без материала'], ...sortBy(items.filter(i => i.status !== 'done' || i.id === itemId), i => `${STATUS_ORDER[i.status] ?? 9}${i.title}`)
      .map(i => [i.id, `${i.title}${areaById[i.areaId] ? ` · ${areaById[i.areaId].name}` : ''}`])];
    const preArea = areaId ?? (itemId && itemById[itemId]?.areaId) ?? selectedArea ?? areas[0]?.id ?? '';
    modal({
      title: 'Записать занятие',
      body: `
        ${formRow(
          field({ name: 'areaId', label: 'Область', type: 'select', value: preArea, options: areaOptions(!areas.length) }),
          field({ name: 'itemId', label: 'Материал', type: 'select', value: itemId ?? '', options: itemOptions }),
        )}
        ${formRow(
          field({ name: 'date', label: 'Дата', type: 'date', value: date, required: true }),
          field({ name: 'minutes', label: 'Минуты', type: 'number', value: minutes, min: 1, step: 5, required: true }),
        )}
        ${field({ name: 'notes', label: 'Заметки', type: 'textarea', value: '', rows: 2, placeholder: 'Что изучали, что поняли' })}`,
      onSubmit: (d) => {
        const mins = Math.max(1, Math.round(Number(d.minutes) || 0));
        let aId = d.areaId || null;
        if (!aId && d.itemId && itemById[d.itemId]) aId = itemById[d.itemId].areaId || null;
        db.add('studySessions', { areaId: aId, itemId: d.itemId || null, date: d.date || t, minutes: mins, notes: d.notes || '' });
        const it = d.itemId ? itemById[d.itemId] : null;
        if (it && it.status === 'planned') db.update('learningItems', it.id, { status: 'active' });
        toast(`Записано ${fmtMinutes(mins)}`);
      },
    });
  }

  function openCardModal(c) {
    const english = findEnglish(areas);
    modal({
      title: c ? 'Карточка' : 'Новая карточка',
      body: `
        ${field({ name: 'front', label: 'Слово или фраза', value: c?.front ?? '', required: true, placeholder: 'to look forward to' })}
        ${field({ name: 'back', label: 'Перевод', value: c?.back ?? '', required: true, placeholder: 'с нетерпением ждать' })}
        ${field({ name: 'example', label: 'Пример', type: 'textarea', value: c?.example ?? '', rows: 2, placeholder: 'I am looking forward to the weekend.' })}
        ${c ? `<div class="tiny muted" style="margin-top:4px">Интервал ${Number(c.interval) || 0} дн · повторений ${Number(c.reps) || 0} · ошибок ${Number(c.lapses) || 0} · следующий повтор ${esc(fmtDate(c.due || t))}</div>` : ''}`,
      onSubmit: (d) => {
        if (c) {
          db.update('flashcards', c.id, { front: d.front, back: d.back, example: d.example || '' });
          toast('Карточка обновлена');
        } else {
          db.add('flashcards', { areaId: english ? english.id : null, front: d.front, back: d.back, example: d.example || '', due: t, interval: 0, ease: 2.5, reps: 0, lapses: 0 });
          toast('Карточка добавлена');
        }
      },
      onDelete: c ? () => { db.remove('flashcards', c.id); toast('Карточка удалена'); } : undefined,
    });
  }

  function openReview() {
    const queue = db.where('flashcards', c => (c.due || t) <= t).sort((a, b) => String(a.due || '').localeCompare(String(b.due || '')));
    if (!queue.length) { toast('Нет карточек к повторению'); return; }
    let idx = 0, shown = false, done = 0;
    const m = modal({ title: 'Повторение', body: '', noForm: true, cancelText: 'Закрыть' });
    const body = m.el.querySelector('.modal-body');

    const draw = () => {
      if (idx >= queue.length) {
        body.innerHTML = `<div class="empty"><div class="big">✓</div>Повторено карточек: ${done}</div>`;
        return;
      }
      const c = queue[idx];
      body.innerHTML = `
        <div class="row between tiny muted" style="margin-bottom:10px"><span>Карточка ${idx + 1} из ${queue.length}</span><span>интервал ${Number(c.interval) || 0} дн</span></div>
        <div class="card" style="background:var(--bg);box-shadow:none;text-align:center;padding:28px 16px">
          <div class="value" style="font-size:26px">${esc(c.front)}</div>
          ${shown ? `
            <div class="divider" style="margin:16px 0"></div>
            <div class="value" style="font-size:20px;color:var(--accent)">${esc(c.back)}</div>
            ${c.example ? `<div class="muted small" style="margin-top:8px;font-style:italic">${esc(c.example)}</div>` : ''}` : ''}
        </div>
        <div class="row wrap" style="margin-top:14px;justify-content:center;gap:8px">
          ${shown
            ? GRADES.map((g, i) => `<button type="button" class="btn ${g.cls}" data-rate="${g.key}" title="Клавиша ${i + 1}">${g.label}<span class="tiny" style="opacity:.75;margin-left:4px">${schedule(c, g.key).interval} дн</span></button>`).join('')
            : `<button type="button" class="btn" data-show>Показать ответ <span class="tiny" style="opacity:.75;margin-left:4px">пробел</span></button>`}
        </div>`;
    };

    const rate = (grade) => {
      const c = queue[idx];
      db.update('flashcards', c.id, schedule(c, grade));
      done++; idx++; shown = false;
      draw();
    };

    body.addEventListener('click', (e) => {
      const show = e.target.closest('[data-show]');
      if (show) { shown = true; draw(); return; }
      const r = e.target.closest('[data-rate]');
      if (r && shown) rate(r.dataset.rate);
    });

    const onKey = (e) => {
      if (!document.body.contains(m.el)) { document.removeEventListener('keydown', onKey); return; }
      if (idx >= queue.length) return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!shown) { shown = true; draw(); } }
      else if (shown && ['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); rate(GRADES[Number(e.key) - 1].key); }
    };
    document.addEventListener('keydown', onKey);
    const obs = new MutationObserver(() => {
      if (!document.body.contains(m.el)) { obs.disconnect(); document.removeEventListener('keydown', onKey); }
    });
    obs.observe(document.getElementById('modals'), { childList: true });

    draw();
  }

  // ---------- События ----------
  on(page, 'click', '[data-tab]', (e, b) => { tab = b.dataset.tab; render(root, ctx); });
  on(page, 'keydown', '.ln-area[role=button]', (e, el) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
  });
  on(page, 'click', '[data-action]', (e, btn) => {
    const act = btn.dataset.action, id = btn.dataset.id;
    switch (act) {
      case 'timer-start':
        timerStart = Date.now();
        tab = 'now';
        rerender();
        toast('Таймер запущен');
        break;
      case 'timer-stop': {
        const mins = Math.max(1, Math.round((Date.now() - timerStart) / 60000));
        timerStart = null;
        if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
        rerender();
        openLogModal({ minutes: mins, itemId: activeItems.length === 1 ? activeItems[0].id : null });
        break;
      }
      case 'log-session': openLogModal({ itemId: btn.dataset.item || null }); break;
      case 'add-area': openAreaModal(null); break;
      case 'edit-area': e.stopPropagation(); openAreaModal(areaById[id]); break;
      case 'select-area':
        if (e.target.closest('[data-action="edit-area"]')) break;
        selectedArea = id; itemFilter = 'all'; tab = 'items';
        render(root, ctx);
        break;
      case 'pick-area': selectedArea = id || null; rerender(); break;
      case 'filter': itemFilter = btn.dataset.filter || 'all'; rerender(); break;
      case 'add-item': openItemModal(null); break;
      case 'edit-item': openItemModal(itemById[id]); break;
      case 'step': {
        const it = itemById[id]; if (!it) break;
        const p = clamp((Number(it.progress) || 0) + STEP, 0, 100);
        const patch = { progress: p };
        if (p >= 100) patch.status = 'done';
        else if (it.status === 'planned') patch.status = 'active';
        db.update('learningItems', id, patch);
        toast(p >= 100 ? `«${it.title}» — готово` : `${it.title}: ${p}%`);
        break;
      }
      case 'del-session':
        if (confirm('Удалить занятие?')) { db.remove('studySessions', id); toast('Занятие удалено'); }
        break;
      case 'add-card': openCardModal(null); break;
      case 'edit-card': openCardModal(db.get('flashcards', id)); break;
      case 'review': openReview(); break;
    }
  });

  return () => { if (timerInterval) { clearInterval(timerInterval); timerInterval = null; } };
}
