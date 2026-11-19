// Привычки: сегодняшний список → неделя → серии → статистика (раскрывается).
// Выполнение считается через model.js (habitStatus учитывает ручные отметки и данные дня).
import { db } from '../db.js';
import {
  esc, icon, modal, field, formRow, toast, on,
  today, addDays, fmtDate, weekDays, startOfWeek, lastNDays, weekdayShort, dateNav,
  checkBtn, emptyAction, statLine, pageMenu, plural,
} from '../ui.js';
import { HABIT_AUTO, habitStatus, habitScheduled, habitTarget, setHabitCount } from '../model.js';
import { habitCheer } from '../motivation.js';

export const title = 'Привычки';

// ---------- Локальное состояние ----------
let day = today();
let statsOpen = false;
let archiveOpen = false;

// ---------- Справочники ----------
const WD = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const COLORS = Array.from({ length: 8 }, (_, i) => [`var(--c${i + 1})`, `Цвет ${i + 1}`]);
const SEED = [
  { name: 'Английский 15 мин', icon: '📘', color: 'var(--c1)' },
  { name: 'Чтение', icon: '📖', color: 'var(--c5)' },
  { name: 'Вода 2 л', icon: '💧', color: 'var(--c7)' },
  { name: 'Зарядка/растяжка', icon: '🤸', color: 'var(--c2)' },
  { name: 'Медитация', icon: '🧘', color: 'var(--c6)' },
];
const SEED_FLAG = 'lifeos_habitsSeeded';
// Подписи к полю нормы для автоматических привычек.
const AUTO_TARGET = {
  water: { label: 'Норма, мл', hint: 'Пусто — норма из настроек', step: 100 },
  steps: { label: 'Норма, шагов', hint: 'Пусто — норма из настроек', step: 500 },
  study: { label: 'Норма, минут', hint: 'Пусто — достаточно любого занятия', step: 5 },
  sleep: { label: 'Норма, часов', hint: 'Пусто — норма из настроек', step: 0.5 },
};

const dayWord = (n) => plural(n, 'день', 'дня', 'дней');
const habitWord = (n) => plural(n, 'привычка', 'привычки', 'привычек');

function seedIfEmpty() {
  if (db.all('habits').length) return;
  let seeded = null;
  try { seeded = localStorage.getItem(SEED_FLAG); } catch { seeded = null; }
  if (seeded) return;
  SEED.forEach((s, i) => db.add('habits', { ...s, days: [], target: 1, archived: false, order: i }));
  try { localStorage.setItem(SEED_FLAG, '1'); } catch { /* приватный режим — не критично */ }
}

// Кэш статусов на время одного рендера: habitStatus за каждый день для каждой привычки.
function makeStatus() {
  const logs = db.all('habitLogs');
  const byHabit = new Map();
  for (const l of logs) { if (!byHabit.has(l.habitId)) byHabit.set(l.habitId, []); byHabit.get(l.habitId).push(l); }
  const memo = new Map();
  return (h, d) => {
    const k = `${h.id}|${d}`;
    if (!memo.has(k)) memo.set(k, habitStatus(h, d, byHabit.get(h.id) || []));
    return memo.get(k);
  };
}

// Текущая серия: подряд выполненные запланированные дни до endIso включительно.
// Если сам endIso ещё не выполнен — он не ломает серию (день ещё идёт).
function currentStreak(h, status, endIso) {
  let s = 0, d = endIso;
  for (let i = 0; i < 400; i++) {
    if (habitScheduled(h, d)) {
      if (status(h, d).done) s++;
      else if (d !== endIso) break;
    }
    d = addDays(d, -1);
  }
  return s;
}

function bestStreak(h, status, endIso) {
  let best = 0, run = 0;
  for (const d of lastNDays(365, endIso)) {
    if (!habitScheduled(h, d)) continue;
    if (status(h, d).done) { run++; if (run > best) best = run; }
    else run = 0;
  }
  return best;
}

// Серия дней, когда выполнены все запланированные привычки (сегодня не ломает серию).
function allDoneStreak(active, status, endIso) {
  let s = 0, d = endIso;
  for (let i = 0; i < 400; i++) {
    const sch = active.filter(h => habitScheduled(h, d));
    if (sch.length) {
      if (sch.every(h => status(h, d).done)) s++;
      else if (d !== endIso) break;
    }
    d = addDays(d, -1);
  }
  return s;
}

// ---------- Модалка ----------
export function openHabitModal(habit, nextOrder) {
  const isNew = !habit;
  const x = habit || { name: '', icon: '✅', color: 'var(--c1)', days: [], target: 1, archived: false, auto: null };
  const days = Array.isArray(x.days) ? x.days : [];
  const auto = x.auto && x.auto.kind ? x.auto : { kind: '', target: '', keyword: '' };
  const autoOptions = [['', 'Нет — отмечаю вручную'], ...Object.entries(HABIT_AUTO).map(([k, v]) => [k, `${v.icon} ${v.label}`])];
  modal({
    title: isNew ? 'Новая привычка' : 'Привычка',
    body: `<div class="form">
      ${field({ name: 'name', label: 'Название', value: x.name, required: true, placeholder: 'Например, Чтение 20 мин' })}
      ${formRow(
        field({ name: 'icon', label: 'Эмодзи', value: x.icon || '', placeholder: '✅' }),
        field({ name: 'color', label: 'Цвет', type: 'select', value: x.color || 'var(--c1)', options: COLORS }),
        field({ name: 'target', label: 'Раз в день', type: 'number', value: x.target || 1, min: 1, max: 20, step: 1 }),
      )}
      <div class="field">
        <label>Дни недели</label>
        <div class="row wrap hb-days">
          ${WD.map((w, i) => `<label class="row"><input type="checkbox" name="d${i}" ${days.includes(i) ? 'checked' : ''}> ${w}</label>`).join('')}
        </div>
        <div class="hint">Ничего не отмечено — ежедневно</div>
      </div>
      <div class="hb-auto" data-auto-block>
        <div class="label" style="margin-bottom:8px">Выполняется автоматически</div>
        ${field({ name: 'autoKind', label: 'Из каких данных', type: 'select', value: auto.kind || '', options: autoOptions, hint: 'Привычка отметится сама, когда в приложении появятся нужные данные за день' })}
        <div data-auto-target ${AUTO_TARGET[auto.kind] ? '' : 'hidden'}>
          ${field({ name: 'autoTarget', label: AUTO_TARGET[auto.kind]?.label || 'Норма', type: 'number', value: auto.target ?? '', min: 0, hint: AUTO_TARGET[auto.kind]?.hint || '' })}
        </div>
        <div data-auto-keyword ${auto.kind === 'task' ? '' : 'hidden'}>
          ${field({ name: 'autoKeyword', label: 'Слово в названии задачи', value: auto.keyword || '', placeholder: 'Например, отчёт', hint: 'Привычка выполнена, если за день закрыта задача с этим словом' })}
        </div>
      </div>
      ${isNew ? '' : field({ name: 'archived', label: 'В архиве (не показывать в списке дня)', type: 'checkbox', value: !!x.archived })}
    </div>`,
    onOpen: (wrap) => {
      const sel = wrap.querySelector('[name="autoKind"]');
      const tgBox = wrap.querySelector('[data-auto-target]');
      const kwBox = wrap.querySelector('[data-auto-keyword]');
      const sync = () => {
        const k = sel.value;
        const cfg = AUTO_TARGET[k];
        tgBox.hidden = !cfg;
        kwBox.hidden = k !== 'task';
        if (cfg) {
          tgBox.querySelector('label').textContent = cfg.label;
          const hint = tgBox.querySelector('.hint'); if (hint) hint.textContent = cfg.hint;
        }
      };
      sel.addEventListener('change', sync);
    },
    onSubmit: (d) => {
      const picked = WD.map((_, i) => i).filter(i => d[`d${i}`]);
      const kind = d.autoKind || '';
      let autoPatch = null;
      if (kind && HABIT_AUTO[kind]) {
        autoPatch = { kind };
        if (AUTO_TARGET[kind] && d.autoTarget != null && Number(d.autoTarget) > 0) autoPatch.target = Number(d.autoTarget);
        if (kind === 'task') {
          const kw = String(d.autoKeyword || '').trim();
          if (!kw) { toast('Укажите слово, по которому искать задачу'); return false; }
          autoPatch.keyword = kw;
        }
      }
      const patch = {
        name: d.name,
        icon: (d.icon || '✅').trim() || '✅',
        color: d.color || 'var(--c1)',
        days: picked.length === 7 ? [] : picked,
        target: Math.max(1, Number(d.target) || 1),
        archived: !!d.archived,
        auto: autoPatch,
      };
      if (isNew) { db.add('habits', { ...patch, order: nextOrder ?? db.all('habits').length }); toast('Привычка добавлена'); }
      else { db.update('habits', x.id, patch); toast('Сохранено'); }
    },
    onDelete: isNew ? undefined : () => {
      for (const l of db.where('habitLogs', l => l.habitId === x.id)) db.remove('habitLogs', l.id);
      db.remove('habits', x.id);
      toast('Привычка удалена');
    },
  });
}

// ---------- Фрагменты ----------
function habitRow(h, st) {
  const tg = st.target;
  const auto = st.auto;
  const autoDone = !!auto?.done;
  const autoIcon = h.auto?.kind && HABIT_AUTO[h.auto.kind] ? HABIT_AUTO[h.auto.kind].icon : '';
  const daysLabel = Array.isArray(h.days) && h.days.length ? h.days.map(i => WD[i]).filter(Boolean).join(', ') : '';
  const parts = [];
  if (auto) parts.push(`<span class="${autoDone ? 'good' : ''}">из данных: ${autoIcon} ${esc(auto.text)}</span>`);
  else if (tg > 1) parts.push(`<b class="${st.done ? 'good' : ''}">${st.manual}/${tg}</b> за день`);
  if (daysLabel) parts.push(esc(daysLabel));
  return `<div class="list-item hb-row ${st.done ? 'done' : ''}">
    ${checkBtn(st.done, `data-action="toggle" data-id="${esc(h.id)}" aria-label="${st.done ? 'Снять отметку' : 'Выполнено'}: ${esc(h.name)}" ${autoDone && st.manual < tg ? 'disabled title="Отмечено автоматически из данных дня"' : ''}`)}
    <span class="hb-ico" style="--dot:${esc(h.color || 'var(--c1)')}">${esc(h.icon || '✅')}</span>
    <div class="main">
      <button type="button" class="title hb-title" data-action="edit" data-id="${esc(h.id)}">${esc(h.name)}</button>
      ${parts.length ? `<div class="sub">${parts.join(' · ')}</div>` : ''}
    </div>
    ${tg > 1 && !autoDone ? `<button type="button" class="btn sm secondary" data-action="plus" data-id="${esc(h.id)}" ${st.done ? 'disabled' : ''} aria-label="Добавить одно выполнение: ${esc(h.name)}">+1</button>` : ''}
  </div>`;
}

function weekStrip(active, status, week, t) {
  return `<div class="hb-week" role="group" aria-label="Прогресс недели">${week.map(d => {
    const sch = active.filter(h => habitScheduled(h, d));
    const done = sch.filter(h => status(h, d).done).length;
    const future = d > t;
    const pct = sch.length ? Math.round(done / sch.length * 100) : 0;
    const cls = [d === day ? 'sel' : '', d === t ? 'today' : '', future ? 'future' : '', sch.length && done === sch.length ? 'full' : ''].filter(Boolean).join(' ');
    const label = `${fmtDate(d, { weekday: true })}: ${done} из ${sch.length}`;
    return `<button type="button" class="hb-day ${cls}" data-day="${d}" aria-label="${esc(label)}" aria-pressed="${d === day}" title="${esc(label)}">
      <span class="hb-day-n">${esc(weekdayShort(d))}</span>
      <span class="hb-day-bar"><i style="height:${future ? 0 : pct}%"></i></span>
      <span class="hb-day-v">${future ? '' : sch.length ? `${done}/${sch.length}` : '—'}</span>
    </button>`;
  }).join('')}</div>`;
}

function heatmap(h, status, t) {
  const tg = habitTarget(h);
  const start = startOfWeek(addDays(t, -77)); // 12 недель, последняя — текущая
  let done = 0, sched = 0;
  const cells = [];
  for (let i = 0; i < 84; i++) {
    const d = addDays(start, i);
    const future = d > t;
    const sch = habitScheduled(h, d);
    let lvl = '', c = 0;
    if (!future) {
      const st = status(h, d);
      c = st.done ? tg : st.manual;
      if (c > 0) { const r = c / tg; lvl = r >= 1 ? 'l3' : r >= 0.5 ? 'l2' : 'l1'; }
      if (sch) { sched++; if (st.done) done++; }
    }
    const style = future ? 'opacity:.25' : sch ? '' : 'opacity:.5';
    cells.push(`<i class="${lvl}" style="${style}" title="${esc(fmtDate(d, { relative: false }))}: ${c}/${tg}"></i>`);
  }
  const pct = sched ? Math.round(done / sched * 100) : 0;
  return `<div class="hb-heat">
    <div class="row between wrap">
      <div class="row" style="gap:8px"><span style="font-size:18px">${esc(h.icon || '✅')}</span><b>${esc(h.name)}</b></div>
      <span class="tiny muted">${done} из ${sched} · ${pct}%</span>
    </div>
    <div class="scroll-x" style="margin-top:8px"><div class="hgrid" style="--accent:${esc(h.color || 'var(--c1)')}">${cells.join('')}</div></div>
  </div>`;
}

// ---------- Страница ----------
export async function render(root, ctx) {
  const rerender = () => render(root, ctx);
  seedIfEmpty();
  const t = today();
  const all = [...db.all('habits')].sort((a, b) =>
    ((a.order ?? 0) - (b.order ?? 0)) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const active = all.filter(h => !h.archived);
  const archived = all.filter(h => h.archived);
  const status = makeStatus();

  const scheduled = active.filter(h => habitScheduled(h, day));
  const notToday = active.filter(h => !habitScheduled(h, day));
  const doneToday = scheduled.filter(h => status(h, day).done).length;
  const week = weekDays(day);

  // Серии
  const streaks = active.map(h => ({ h, n: currentStreak(h, status, day) })).filter(x => x.n > 0).sort((a, b) => b.n - a.n);
  const allStreak = allDoneStreak(active, status, day);

  const menu = pageMenu([
    archived.length ? { label: `Архив (${archived.length})`, action: 'archive', icon: 'inbox' } : null,
    { label: 'Настроить страницу', action: 'customize', icon: 'sliders' },
  ]);

  // Пустое состояние: одна фраза, одно действие.
  if (!active.length && !archived.length) {
    root.innerHTML = `<div class="habits-page">
      <div class="page-head">
        <div><div class="eyebrow">Личное</div><h1>Привычки</h1></div>
        <div class="actions">${menu}</div>
      </div>
      ${emptyAction({ text: 'Маленькие ежедневные действия: отмечайте их одной галочкой, а вода, сон и тренировки могут отмечаться сами.', action: 'new', label: 'Привычка' })}
    </div>`;
    bind(root, ctx, { all, status, rerender });
    return;
  }

  // Статистика (внутри раскрываемого блока)
  let best = { n: 0, h: null };
  let s30 = 0, d30 = 0;
  const statsHtml = () => {
    for (const h of active) { const n = bestStreak(h, status, t); if (n > best.n) best = { n, h }; }
    for (const d of lastNDays(30, t)) for (const h of active) if (habitScheduled(h, d)) { s30++; if (status(h, d).done) d30++; }
    const pct30 = s30 ? Math.round(d30 / s30 * 100) : 0;
    const line = statLine([
      d30 ? `за 30 дней <b>${d30} из ${s30}</b> · ${pct30}%` : '',
      best.n ? `лучшая серия <b>${best.n} ${dayWord(best.n)}</b> — ${esc(`${best.h.icon || ''} ${best.h.name}`.trim())}` : '',
    ]);
    return `${line || '<div class="tiny muted" style="margin-bottom:10px">Отметок за последние 30 дней ещё нет</div>'}
      <div class="tiny faint" style="margin-bottom:8px">Последние 12 недель · столбец = неделя, пн–вс сверху вниз</div>
      <div class="stack">${active.map(h => heatmap(h, status, t)).join('')}</div>`;
  };

  root.innerHTML = `<div class="habits-page">
    <div class="page-head">
      <div><div class="eyebrow">Личное</div><h1>Привычки</h1></div>
      <div class="actions">
        <div class="dn-compact">${dateNav(day)}</div>
        <button type="button" class="btn" data-action="new">${icon('plus')} Привычка</button>
        ${menu}
      </div>
    </div>
    ${statLine([
      doneToday ? `<b>${doneToday} из ${scheduled.length}</b> ${day === t ? 'сегодня' : esc(fmtDate(day))}` : '',
      allStreak ? `серия <b>${allStreak} ${dayWord(allStreak)}</b>` : '',
    ])}

    <section class="card" data-block="today" data-block-title="Список дня">
      <div class="section-title">
        <h2>${day === t ? 'Сегодня' : esc(fmtDate(day, { weekday: true }))}</h2>
        ${scheduled.length ? `<span class="tiny muted">${doneToday === scheduled.length ? 'все выполнены' : `${doneToday} из ${scheduled.length}`}</span>` : ''}
      </div>
      ${scheduled.length
        ? `<div class="list">${scheduled.map(h => habitRow(h, status(h, day))).join('')}</div>`
        : active.length
          ? `<div class="tiny muted">На этот день привычек не запланировано.</div>`
          : emptyAction({ text: 'Все привычки в архиве.', action: 'new', label: 'Привычка', second: { action: 'archive', label: 'Открыть архив' } })}
      ${notToday.length ? `<div class="tiny faint" style="margin-top:10px">Не в этот день: ${notToday.map(h => esc(h.name)).join(', ')}</div>` : ''}
    </section>

    ${active.length ? `<section class="card" data-block="week" data-block-title="Неделя">
      <div class="section-title"><h2>Неделя</h2><span class="tiny muted">${esc(fmtDate(week[0], { relative: false }))} — ${esc(fmtDate(week[6], { relative: false }))}</span></div>
      ${weekStrip(active, status, week, t)}
    </section>` : ''}

    ${streaks.length ? `<section class="card" data-block="streaks" data-block-title="Серии">
      <div class="section-title"><h2>Серии</h2><span class="tiny muted">дней подряд</span></div>
      <div class="hb-streaks">${streaks.map(({ h, n }) => `<span class="chip hb-streak" title="${esc(h.name)}: ${n} ${dayWord(n)} подряд">🔥 ${esc(h.icon || '')} ${esc(h.name)} <b>${n}</b></span>`).join('')}</div>
    </section>` : ''}

    ${active.length ? `<section class="card" data-block="stats" data-block-title="Статистика">
      <details class="acc" data-acc="stats" ${statsOpen ? 'open' : ''}>
        <summary>${icon('chevronDown')} Статистика</summary>
        <div class="acc-body">${statsOpen ? statsHtml() : ''}</div>
      </details>
    </section>` : ''}

    ${archived.length ? `<section class="card" data-block="archive" data-block-title="Архив">
      <details class="acc" data-acc="archive" ${archiveOpen ? 'open' : ''}>
        <summary>${icon('chevronDown')} Архив <span class="pill">${archived.length}</span></summary>
        <div class="list acc-body">
          ${archived.map(h => `<div class="list-item">
            <span class="hb-ico" style="--dot:${esc(h.color || 'var(--c1)')}">${esc(h.icon || '✅')}</span>
            <div class="main"><div class="title muted">${esc(h.name)}</div></div>
            <button type="button" class="btn sm secondary" data-action="restore" data-id="${esc(h.id)}">Вернуть</button>
            <button type="button" class="icon-btn sm" data-action="edit" data-id="${esc(h.id)}" aria-label="Изменить: ${esc(h.name)}">${icon('edit')}</button>
          </div>`).join('')}
        </div>
      </details>
    </section>` : ''}
  </div>`;

  bind(root, ctx, { all, status, rerender, statsHtml });
}

function bind(root, ctx, { all, status, rerender, statsHtml }) {
  const view = root.firstElementChild;

  on(view, 'click', '[data-action]', (e, b) => {
    const a = b.dataset.action, id = b.dataset.id;
    const h = id ? db.get('habits', id) : null;
    switch (a) {
      case 'new': openHabitModal(null, all.length); break;
      case 'edit': if (h) openHabitModal(h, all.length); break;
      case 'toggle': {
        if (!h) break;
        const st = status(h, day);
        if (st.auto?.done && st.manual < st.target) { toast('Отмечено автоматически из данных дня'); break; }
        const nowDone = st.manual >= st.target;
        setHabitCount(h.id, day, nowDone ? 0 : st.target);
        if (!nowDone) { const c = habitCheer(); if (c) toast(c); }
        break;
      }
      case 'plus': {
        if (!h) break;
        const st = status(h, day);
        const next = Math.min(st.target, st.manual + 1);
        setHabitCount(h.id, day, next);
        if (next >= st.target) { const c = habitCheer(); if (c) toast(c); }
        break;
      }
      case 'restore': if (h) { db.update('habits', h.id, { archived: false }); toast('Привычка возвращена'); } break;
      case 'archive': {
        archiveOpen = true;
        const d = view.querySelector('details[data-acc="archive"]');
        if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        break;
      }
      default: break;
    }
  });

  on(view, 'click', '[data-day]', (e, b) => { day = b.dataset.day; rerender(); });

  on(view, 'click', '[data-dn]', (e, b) => {
    const a = b.dataset.dn;
    if (a === 'prev') day = addDays(day, -1);
    else if (a === 'next') day = addDays(day, 1);
    else if (a === 'today') day = today();
    else return;
    rerender();
  });
  on(view, 'change', '[data-dn="pick"]', (e, inp) => { if (inp.value) { day = inp.value; rerender(); } });

  // toggle не всплывает — ловим на фазе захвата; статистику считаем только при открытии.
  view.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement)) return;
    if (d.dataset.acc === 'stats') {
      statsOpen = d.open;
      const body = d.querySelector('.acc-body');
      if (d.open && body && !body.innerHTML.trim() && statsHtml) body.innerHTML = statsHtml();
    } else if (d.dataset.acc === 'archive') archiveOpen = d.open;
  }, true);
}
