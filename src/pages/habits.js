import { db } from '../db.js';
import {
  esc, icon, modal, field, formRow, toast, on,
  today, addDays, parseISO, fmtDate, weekDays, startOfWeek, lastNDays, weekdayShort, dateNav,
  checkBtn, ring, emptyState, plural,
} from '../ui.js';

export const title = 'Привычки';

// ---------- Локальное состояние ----------
let day = today();

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

const dayWord = (n) => plural(n, 'день', 'дня', 'дней');

// ---------- Вычисления ----------
const weekdayIdx = (dateIso) => (parseISO(dateIso).getDay() + 6) % 7; // 0 = пн
const targetOf = (h) => Math.max(1, Number(h.target) || 1);
const isScheduled = (h, dateIso) => !(Array.isArray(h.days) && h.days.length) || h.days.includes(weekdayIdx(dateIso));
const key = (habitId, dateIso) => `${habitId}|${dateIso}`;

function seedIfEmpty() {
  if (db.all('habits').length) return;
  let seeded = null;
  try { seeded = localStorage.getItem(SEED_FLAG); } catch { seeded = null; }
  if (seeded) return;
  SEED.forEach((s, i) => db.add('habits', { ...s, days: [], target: 1, archived: false, order: i }));
  try { localStorage.setItem(SEED_FLAG, '1'); } catch { /* приватный режим — не критично */ }
}

function buildCounts() {
  const m = new Map();
  for (const l of db.all('habitLogs')) {
    const k = key(l.habitId, l.date);
    m.set(k, Math.max(m.get(k) || 0, Number(l.count) || 0));
  }
  return m;
}

function setCount(habitId, dateIso, count) {
  const ex = db.all('habitLogs').find(l => l.habitId === habitId && l.date === dateIso);
  if (count <= 0) { if (ex) db.remove('habitLogs', ex.id); return; }
  if (ex) db.update('habitLogs', ex.id, { count });
  else db.add('habitLogs', { habitId, date: dateIso, count });
}

// Текущая серия: подряд выполненные запланированные дни до endIso включительно.
// Если сам endIso ещё не выполнен — он не ломает серию (день ещё идёт).
function currentStreak(h, counts, endIso) {
  const tg = targetOf(h);
  let s = 0, d = endIso;
  for (let i = 0; i < 400; i++) {
    if (isScheduled(h, d)) {
      const c = counts.get(key(h.id, d)) || 0;
      if (c >= tg) s++;
      else if (d !== endIso) break;
    }
    d = addDays(d, -1);
  }
  return s;
}

function bestStreak(h, counts, endIso) {
  const tg = targetOf(h);
  let best = 0, run = 0;
  for (const d of lastNDays(365, endIso)) {
    if (!isScheduled(h, d)) continue;
    if ((counts.get(key(h.id, d)) || 0) >= tg) { run++; if (run > best) best = run; }
    else run = 0;
  }
  return best;
}

// ---------- Модалка ----------
export function openHabitModal(habit, nextOrder) {
  const isNew = !habit;
  const x = habit || { name: '', icon: '✅', color: 'var(--c1)', days: [], target: 1, archived: false };
  const days = Array.isArray(x.days) ? x.days : [];
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
        <div class="row wrap" style="gap:10px">
          ${WD.map((w, i) => `<label class="row" style="gap:4px;font-size:13px"><input type="checkbox" name="d${i}" ${days.includes(i) ? 'checked' : ''}> ${w}</label>`).join('')}
        </div>
        <div class="hint">Ничего не отмечено — ежедневно</div>
      </div>
      ${isNew ? '' : field({ name: 'archived', label: 'В архиве (не показывать в списке дня)', type: 'checkbox', value: !!x.archived })}
    </div>`,
    onSubmit: (d) => {
      const picked = WD.map((_, i) => i).filter(i => d[`d${i}`]);
      const patch = {
        name: d.name,
        icon: (d.icon || '✅').trim() || '✅',
        color: d.color || 'var(--c1)',
        days: picked.length === 7 ? [] : picked,
        target: Math.max(1, Number(d.target) || 1),
        archived: !!d.archived,
      };
      if (isNew) { db.add('habits', { ...patch, order: nextOrder }); toast('Привычка добавлена'); }
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
function habitRow(h, counts, week, t) {
  const tg = targetOf(h);
  const c = counts.get(key(h.id, day)) || 0;
  const done = c >= tg;
  const streak = currentStreak(h, counts, day);
  const dots = week.map(d => {
    const sch = isScheduled(h, d);
    const on = sch && (counts.get(key(h.id, d)) || 0) >= tg;
    return `<i class="${on ? 'on' : ''} ${d === t ? 'today' : ''}" style="${sch ? '' : 'opacity:.35'}" title="${esc(fmtDate(d, { relative: false }))}">${weekdayShort(d)}</i>`;
  }).join('');
  const daysLabel = Array.isArray(h.days) && h.days.length ? h.days.map(i => WD[i]).filter(Boolean).join(', ') : 'ежедневно';
  return `<div class="list-item">
    <span class="color-dot" style="background:${esc(h.color || 'var(--c1)')}"></span>
    <span style="font-size:22px;line-height:1;width:28px;text-align:center">${esc(h.icon || '✅')}</span>
    <div class="main">
      <div class="title" data-action="edit" data-id="${esc(h.id)}" style="cursor:pointer">${esc(h.name)}</div>
      <div class="sub">${streak ? `🔥 ${streak} ${dayWord(streak)} подряд` : 'серия не начата'} · ${esc(daysLabel)}${tg > 1 ? ` · <b class="${done ? 'good' : ''}">${c}/${tg}</b>` : ''}</div>
    </div>
    <div class="week-dots">${dots}</div>
    ${tg > 1 ? `<button type="button" class="btn sm secondary" data-action="plus" data-id="${esc(h.id)}" ${done ? 'disabled' : ''}>+1</button>` : ''}
    ${checkBtn(done, `data-action="toggle" data-id="${esc(h.id)}" aria-label="Выполнено"`)}
  </div>`;
}

function historyCard(h, counts, t) {
  const tg = targetOf(h);
  const start = startOfWeek(addDays(t, -77)); // 12 недель, последняя — текущая
  let done = 0, sched = 0;
  const cells = [];
  for (let i = 0; i < 84; i++) {
    const d = addDays(start, i);
    const future = d > t;
    const sch = isScheduled(h, d);
    const c = counts.get(key(h.id, d)) || 0;
    let lvl = '';
    if (!future && c > 0) { const r = c / tg; lvl = r >= 1 ? 'l3' : r >= 0.5 ? 'l2' : 'l1'; }
    if (!future && sch) { sched++; if (c >= tg) done++; }
    const style = future ? 'opacity:.25' : sch ? '' : 'opacity:.5';
    cells.push(`<i class="${lvl}" style="${style}" title="${esc(fmtDate(d, { relative: false }))}: ${c}/${tg}"></i>`);
  }
  const pct = sched ? Math.round(done / sched * 100) : 0;
  return `<div class="card">
    <div class="row between wrap">
      <div class="row" style="gap:8px"><span style="font-size:18px">${esc(h.icon || '✅')}</span><b>${esc(h.name)}</b></div>
      <span class="tiny muted">${done} из ${sched} · ${pct}%</span>
    </div>
    <div class="scroll-x" style="margin-top:10px"><div class="hgrid" style="--accent:${esc(h.color || 'var(--c1)')}">${cells.join('')}</div></div>
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
  const counts = buildCounts();
  const cnt = (h, d) => counts.get(key(h.id, d)) || 0;

  const scheduled = active.filter(h => isScheduled(h, day));
  const notToday = active.filter(h => !isScheduled(h, day));
  const doneToday = scheduled.filter(h => cnt(h, day) >= targetOf(h)).length;
  const pct = scheduled.length ? Math.round(doneToday / scheduled.length * 100) : 0;

  let best = { n: 0, h: null };
  for (const h of active) { const n = bestStreak(h, counts, t); if (n > best.n) best = { n, h }; }

  let s30 = 0, d30 = 0;
  for (const d of lastNDays(30, t)) for (const h of active) if (isScheduled(h, d)) { s30++; if (cnt(h, d) >= targetOf(h)) d30++; }
  const pct30 = s30 ? Math.round(d30 / s30 * 100) : 0;
  const week = weekDays(day);

  root.innerHTML = `<div>
    <div class="page-head">
      <div><div class="eyebrow">Главное</div><h1>Привычки</h1></div>
      <div class="actions">${dateNav(day)}<button class="btn" data-action="new">${icon('plus')} Привычка</button></div>
    </div>
    <div class="grid-3" style="margin-bottom:12px">
      <div class="stat">
        <div class="row" style="gap:14px">
          ${ring(pct, { label: `${doneToday}/${scheduled.length}`, sub: 'выполнено', color: pct >= 100 ? 'var(--good)' : 'var(--accent)' })}
          <div>
            <div class="label">${day === t ? 'Сегодня' : esc(fmtDate(day))}</div>
            <div class="value">${pct}<small>%</small></div>
            <div class="sub">${scheduled.length} ${plural(scheduled.length, 'привычка', 'привычки', 'привычек')} в плане</div>
          </div>
        </div>
      </div>
      <div class="stat">
        <div class="label">Лучшая серия</div>
        <div class="value">${best.n}<small>${dayWord(best.n)}</small></div>
        <div class="sub ellipsis">${best.h ? esc(`${best.h.icon || ''} ${best.h.name}`.trim()) : 'за последний год'}</div>
      </div>
      <div class="stat">
        <div class="label">За 30 дней</div>
        <div class="value">${pct30}<small>%</small></div>
        <div class="sub">${d30} из ${s30} отметок</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:12px">
      <div class="section-title">
        <h2>${day === t ? 'Сегодня' : esc(fmtDate(day, { weekday: true }))}</h2>
        <span class="tiny muted">${doneToday} из ${scheduled.length}</span>
      </div>
      ${scheduled.length
        ? `<div class="list">${scheduled.map(h => habitRow(h, counts, week, t)).join('')}</div>`
        : (active.length ? emptyState('На этот день привычек не запланировано', '🌤️') : emptyState('Привычек пока нет — добавьте первую', '🌱'))}
      ${notToday.length ? `<div class="tiny faint" style="margin-top:10px">Не в этот день: ${notToday.map(h => esc(h.name)).join(', ')}</div>` : ''}
    </div>

    <div class="section-title"><h2>История</h2><span class="tiny muted">последние 12 недель · столбец = неделя, пн–вс сверху вниз</span></div>
    ${active.length ? `<div class="stack">${active.map(h => historyCard(h, counts, t)).join('')}</div>` : emptyState('История появится после первых отметок', '📈')}

    ${archived.length ? `<div class="card" style="margin-top:12px">
      <details class="acc">
        <summary>Архив <span class="pill">${archived.length}</span></summary>
        <div class="list" style="margin-top:8px">
          ${archived.map(h => `<div class="list-item">
            <span style="font-size:20px;width:28px;text-align:center">${esc(h.icon || '✅')}</span>
            <div class="main"><div class="title muted">${esc(h.name)}</div></div>
            <button type="button" class="btn sm secondary" data-action="restore" data-id="${esc(h.id)}">восстановить</button>
            <button type="button" class="icon-btn sm" data-action="edit" data-id="${esc(h.id)}" aria-label="Изменить">${icon('edit')}</button>
          </div>`).join('')}
        </div>
      </details>
    </div>` : ''}
  </div>`;

  const view = root.firstElementChild;

  on(view, 'click', '[data-action]', (e, b) => {
    const a = b.dataset.action, id = b.dataset.id;
    const h = id ? db.get('habits', id) : null;
    switch (a) {
      case 'new': openHabitModal(null, all.length); break;
      case 'edit': if (h) openHabitModal(h, all.length); break;
      case 'toggle': if (h) { const tg = targetOf(h); setCount(h.id, day, cnt(h, day) >= tg ? 0 : tg); } break;
      case 'plus': if (h) setCount(h.id, day, Math.min(targetOf(h), cnt(h, day) + 1)); break;
      case 'restore': if (h) { db.update('habits', h.id, { archived: false }); toast('Привычка восстановлена'); } break;
      default: break;
    }
  });

  on(view, 'click', '[data-dn]', (e, b) => {
    const a = b.dataset.dn;
    if (a === 'prev') day = addDays(day, -1);
    else if (a === 'next') day = addDays(day, 1);
    else if (a === 'today') day = today();
    else return;
    rerender();
  });
  on(view, 'change', '[data-dn="pick"]', (e, inp) => { if (inp.value) { day = inp.value; rerender(); } });
}
