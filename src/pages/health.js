import { db } from '../db.js';
import { esc, el, icon, field, formRow, formData, modal, toast, on, today, addDays, lastNDays, fmtDate, fmtNum, avg, sortBy, emptyState, checkBtn, lineChart, dateNav, weekdayShort, plural } from '../ui.js';

export const title = 'Здоровье';

const SYMPTOMS = ['головная боль', 'усталость', 'плохой сон', 'боль в спине', 'простуда', 'тревога', 'аллергия'];
const MOOD = ['😞', '😕', '😐', '🙂', '😄'];
const ENERGY = ['🪫', '😴', '😐', '⚡', '🔥'];
const STRESS = ['😌', '🙂', '😐', '😬', '🤯'];
const CONFIDENCE = ['🫣', '😟', '😐', '😎', '🦁'];
const TODO_TYPES = { appointment: 'Приём', test: 'Анализ', other: 'Другое' };
const TIMES = [['morning', 'Утро'], ['day', 'День'], ['evening', 'Вечер']];
const dm = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const tile = (label, value, sub = '') => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;

// Локальное состояние страницы (переживает перерисовку).
let day = today();
let labFilter = '';

// ---------- Вычисления ----------
function streakDays(dates) {
  let d = today();
  if (!dates.has(d)) d = addDays(d, -1);
  let n = 0;
  while (dates.has(d)) { n++; d = addDays(d, -1); }
  return n;
}

const hasRef = (v) => v != null && v !== '' && !isNaN(Number(v));

function labStatus(t) {
  const lo = hasRef(t.refLow) ? Number(t.refLow) : null;
  const hi = hasRef(t.refHigh) ? Number(t.refHigh) : null;
  if (lo == null && hi == null) return { cls: '', text: 'Без референса' };
  const v = Number(t.value);
  if (lo != null && v < lo) return { cls: 'bad', text: 'Ниже нормы' };
  if (hi != null && v > hi) return { cls: 'bad', text: 'Выше нормы' };
  return { cls: 'good', text: 'Норма' };
}

function refText(t) {
  const lo = hasRef(t.refLow), hi = hasRef(t.refHigh);
  if (lo && hi) return `${fmtNum(t.refLow, 2)}–${fmtNum(t.refHigh, 2)}`;
  if (lo) return `≥ ${fmtNum(t.refLow, 2)}`;
  if (hi) return `≤ ${fmtNum(t.refHigh, 2)}`;
  return '—';
}

function exportLabsCSV(rows) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Дата', 'Показатель', 'Значение', 'Ед. изм.', 'Референс от', 'Референс до', 'Заметки'].map(q).join(';');
  const lines = rows.map(r => [r.date, r.name, r.value, r.unit, r.refLow, r.refHigh, r.notes].map(q).join(';'));
  const blob = new Blob(['﻿' + [head, ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lifeos-labs-${today()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('CSV сохранён');
}

// ---------- Модалки ----------
function todoModal(t) {
  modal({
    title: t ? 'Медицинское дело' : 'Новое дело',
    body: `
      ${field({ name: 'title', label: 'Что сделать', value: t?.title, required: true, placeholder: 'Приём у терапевта' })}
      ${formRow(
        field({ name: 'type', label: 'Тип', type: 'select', value: t?.type || 'appointment', options: Object.entries(TODO_TYPES) }),
        field({ name: 'date', label: 'Дата', type: 'date', value: t?.date || '' }),
      )}
      ${field({ name: 'notes', label: 'Заметки', type: 'textarea', value: t?.notes, rows: 2 })}`,
    onSubmit: (d) => {
      const rec = { title: d.title, type: d.type, date: d.date || null, notes: d.notes };
      if (t) db.update('healthTodos', t.id, rec);
      else db.add('healthTodos', { ...rec, done: false });
      toast(t ? 'Сохранено' : 'Дело добавлено');
    },
    onDelete: t ? () => db.remove('healthTodos', t.id) : undefined,
  });
}

function medModal(m) {
  modal({
    title: m ? 'Лекарство' : 'Новое лекарство',
    body: `
      ${formRow(
        field({ name: 'name', label: 'Название', value: m?.name, required: true, placeholder: 'Магний' }),
        field({ name: 'dose', label: 'Доза', value: m?.dose, placeholder: '1 капс · 400 мг' }),
      )}
      <div class="field"><label>Время приёма</label>
        <div class="row wrap" style="gap:14px">
          ${TIMES.map(([k, l]) => field({ name: 't_' + k, type: 'checkbox', label: l, value: m ? (m.times || []).includes(k) : k === 'morning' })).join('')}
        </div>
      </div>
      ${field({ name: 'active', type: 'checkbox', label: 'Принимаю сейчас', value: m ? m.active !== false : true })}
      ${field({ name: 'notes', label: 'Заметки', type: 'textarea', value: m?.notes, rows: 2 })}`,
    onSubmit: (d) => {
      const times = TIMES.map(([k]) => k).filter(k => d['t_' + k]);
      if (!times.length) { toast('Выберите хотя бы одно время приёма'); return false; }
      const rec = { name: d.name, dose: d.dose, times, active: !!d.active, notes: d.notes };
      if (m) db.update('medications', m.id, rec);
      else db.add('medications', rec);
      toast(m ? 'Сохранено' : 'Лекарство добавлено');
    },
    onDelete: m ? () => {
      db.remove('medications', m.id);
      db.all('medLogs').filter(l => l.medId === m.id).forEach(l => db.remove('medLogs', l.id));
    } : undefined,
  });
}

function labModal(t) {
  const names = [...new Set(db.all('labTests').map(x => x.name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  modal({
    title: t ? 'Анализ' : 'Новый анализ',
    body: `
      <datalist id="labNames">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
      ${formRow(
        field({ name: 'date', label: 'Дата', type: 'date', value: t?.date || day, required: true }),
        field({ name: 'name', label: 'Показатель', value: t?.name, required: true, list: 'labNames', placeholder: 'Ферритин' }),
      )}
      ${formRow(
        field({ name: 'value', label: 'Значение', type: 'number', step: 'any', value: t?.value ?? '', required: true }),
        field({ name: 'unit', label: 'Ед. изм.', value: t?.unit, placeholder: 'нг/мл' }),
      )}
      ${formRow(
        field({ name: 'refLow', label: 'Референс от', type: 'number', step: 'any', value: t?.refLow ?? '' }),
        field({ name: 'refHigh', label: 'Референс до', type: 'number', step: 'any', value: t?.refHigh ?? '' }),
      )}
      ${field({ name: 'notes', label: 'Заметки', type: 'textarea', value: t?.notes, rows: 2 })}`,
    onSubmit: (d) => {
      const rec = { date: d.date, name: d.name, value: d.value, unit: d.unit, refLow: d.refLow, refHigh: d.refHigh, notes: d.notes };
      if (t) db.update('labTests', t.id, rec);
      else db.add('labTests', rec);
      toast(t ? 'Сохранено' : 'Анализ добавлен');
    },
    onDelete: t ? () => db.remove('labTests', t.id) : undefined,
  });
}

// ---------- Страница ----------
export async function render(root, ctx) {
  const rerender = () => render(root, ctx);

  // --- чек-ины
  const checkins = db.all('checkins');
  const byDate = new Map(checkins.map(c => [c.date, c]));
  const cur = byDate.get(day);
  const last7 = lastNDays(7).map(d => byDate.get(d)).filter(Boolean);
  const e7 = last7.filter(c => c.energy), m7 = last7.filter(c => c.mood);
  const avgEnergy = e7.length ? avg(e7, c => c.energy) : null;
  const avgMood = m7.length ? avg(m7, c => c.mood) : null;
  const weighed = sortBy(checkins.filter(c => c.weight != null && c.weight !== '' && !isNaN(Number(c.weight))), c => c.date);
  const lastW = weighed[weighed.length - 1];
  const w30 = weighed.filter(c => c.date >= addDays(today(), -30));
  const delta = w30.length >= 2 ? Number(w30[w30.length - 1].weight) - Number(w30[0].weight) : null;
  const streak = streakDays(new Set(checkins.map(c => c.date)));

  const days30 = lastNDays(30);
  const wPts = days30.map((d, i) => ({ x: i, y: byDate.get(d)?.weight != null && byDate.get(d)?.weight !== '' ? Number(byDate.get(d).weight) : null })).filter(p => p.y != null);
  const weightChart = wPts.length >= 2
    ? lineChart([{ points: wPts, color: 'var(--c5)' }], days30.map(dm))
    : emptyState('Нужно минимум две записи веса за 30 дней', '⚖️');

  const days14 = lastNDays(14);
  const mk = (k) => days14.map((d, i) => ({ x: i, y: byDate.get(d)?.[k] ?? null })).filter(p => p.y != null);
  const energyPts = mk('energy'), moodPts = mk('mood'), stressPts = mk('stress'), confPts = mk('confidence');
  const moodChart = (energyPts.length + moodPts.length + stressPts.length + confPts.length) > 0
    ? lineChart([
        { points: energyPts, color: 'var(--c2)' },
        { points: moodPts, color: 'var(--c1)' },
        { points: stressPts, color: 'var(--c4)' },
        { points: confPts, color: 'var(--c3)' },
      ], days14.map(weekdayShort), { min: 1, max: 5 })
    : emptyState('Заполните чек-ин, чтобы увидеть динамику', '📈');

  const activeSyms = new Set(cur?.symptoms || []);
  const allSyms = [...new Set([...SYMPTOMS, ...activeSyms])];

  // --- медицинские дела
  const todos = db.all('healthTodos');
  const openTodos = sortBy(todos.filter(t => !t.done), t => t.date || '9999-99-99');
  const doneTodos = sortBy(todos.filter(t => t.done), t => t.doneAt || t.date || '', true);
  const todoRow = (t) => `
    <div class="list-item">
      ${checkBtn(!!t.done, `data-todo-toggle="${esc(t.id)}" aria-label="Выполнено"`)}
      <div class="main" data-todo-edit="${esc(t.id)}" style="cursor:pointer">
        <div class="title ${t.done ? 'strike' : ''}">${esc(t.title)}</div>
        <div class="sub row wrap" style="gap:6px">
          <span class="pill">${esc(TODO_TYPES[t.type] || TODO_TYPES.other)}</span>
          ${t.date ? `<span class="${!t.done && t.date < today() ? 'bad bold' : ''}">${esc(fmtDate(t.date))}</span>` : ''}
          ${t.notes ? `<span class="faint ellipsis">${esc(t.notes)}</span>` : ''}
        </div>
      </div>
    </div>`;

  // --- лекарства
  const meds = db.all('medications');
  const activeMeds = meds.filter(m => m.active !== false);
  const inactiveMeds = meds.filter(m => m.active === false);
  const dayLogs = db.all('medLogs').filter(l => l.date === day);
  const taken = (medId, time) => dayLogs.some(l => l.medId === medId && l.time === time);
  const medGroups = TIMES.map(([k, l]) => ({ k, l, meds: activeMeds.filter(m => (m.times || []).includes(k)) })).filter(g => g.meds.length);
  const slotsTotal = medGroups.reduce((s, g) => s + g.meds.length, 0);
  const slotsTaken = medGroups.reduce((s, g) => s + g.meds.filter(m => taken(m.id, g.k)).length, 0);
  const medRow = (m, time) => `
    <div class="list-item">
      ${time ? checkBtn(taken(m.id, time), `data-med-log="${esc(m.id)}" data-time="${time}" aria-label="Принято"`) : ''}
      <div class="main">
        <div class="title ${m.active === false ? 'muted' : ''}">${esc(m.name)}</div>
        <div class="sub">${esc(m.dose || '')}${m.notes ? ` · <span class="faint">${esc(m.notes)}</span>` : ''}</div>
      </div>
      <button class="icon-btn sm" data-med-edit="${esc(m.id)}" aria-label="Изменить">${icon('edit')}</button>
    </div>`;

  // --- анализы
  const labs = sortBy(db.all('labTests'), t => t.date + (t.createdAt || ''), true);
  const labNames = [...new Set(labs.map(t => t.name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  if (labFilter && !labNames.includes(labFilter)) labFilter = '';
  const shownLabs = labFilter ? labs.filter(t => t.name === labFilter) : labs;
  let labChart = '';
  if (labFilter) {
    const series = sortBy(labs.filter(t => t.name === labFilter && t.value != null && !isNaN(Number(t.value))), t => t.date);
    const withRef = [...series].reverse().find(t => hasRef(t.refLow) || hasRef(t.refHigh));
    const unit = series.find(t => t.unit)?.unit || '';
    labChart = `<div class="card" style="margin-top:12px">
      <div class="row between wrap"><h3 style="margin:0">${esc(labFilter)}${unit ? ` <span class="muted small">(${esc(unit)})</span>` : ''}</h3>
        <span class="tiny muted">${withRef ? `Референс: ${esc(refText(withRef))}` : 'Референс не указан'}</span></div>
      ${series.length >= 2
        ? lineChart([{ points: series.map((t, i) => ({ x: i, y: Number(t.value) })), color: 'var(--c7)' }], series.map(t => dm(t.date)))
        : emptyState('Нужно минимум два результата, чтобы построить график', '🧪')}
    </div>`;
  } else if (labNames.length) {
    labChart = `<p class="tiny muted" style="margin-top:10px">Выберите показатель в фильтре, чтобы увидеть динамику.</p>`;
  }

  root.innerHTML = `<div>
    <div class="page-head">
      <div><div class="eyebrow">Тело</div><h1>Здоровье</h1></div>
      <div class="actions">${dateNav(day)}</div>
    </div>

    <div class="grid-4">
      ${tile('Энергия, 7 дней', avgEnergy != null ? `${fmtNum(avgEnergy, 1)}<small>/5</small>` : '—', e7.length ? `${e7.length} ${plural(e7.length, 'запись', 'записи', 'записей')}` : 'нет записей')}
      ${tile('Настроение, 7 дней', avgMood != null ? `${fmtNum(avgMood, 1)}<small>/5</small>` : '—', m7.length ? `${m7.length} ${plural(m7.length, 'запись', 'записи', 'записей')}` : 'нет записей')}
      ${tile('Вес', lastW ? `${fmtNum(lastW.weight, 1)}<small>кг</small>` : '—', lastW ? (delta != null ? `<span class="${delta > 0 ? 'warn' : delta < 0 ? 'good' : ''}">${delta > 0 ? '+' : ''}${fmtNum(delta, 1)} кг</span> за 30 дней` : esc(fmtDate(lastW.date))) : 'нет данных')}
      ${tile('Дней подряд', String(streak), streak ? `${plural(streak, 'день', 'дня', 'дней')} с чек-ином` : 'сделайте чек-ин сегодня')}
    </div>

    <div class="grid-2" style="margin-top:12px;align-items:start">
      <form class="card form" id="checkinForm">
        <div class="row between"><h3 style="margin:0">Чек-ин · ${esc(fmtDate(day, { weekday: true }))}</h3>${cur ? '<span class="pill good">Записано</span>' : ''}</div>
        <div class="row wrap top" style="gap:16px">
          ${field({ name: 'mood', label: 'Настроение', type: 'rating', value: cur?.mood, labels: MOOD })}
          ${field({ name: 'energy', label: 'Энергия', type: 'rating', value: cur?.energy, labels: ENERGY })}
          ${field({ name: 'stress', label: 'Стресс', type: 'rating', value: cur?.stress, labels: STRESS })}
          ${field({ name: 'confidence', label: 'Уверенность', type: 'rating', value: cur?.confidence, labels: CONFIDENCE })}
        </div>
        ${field({ name: 'weight', label: 'Вес, кг', type: 'number', value: cur?.weight ?? '', step: 0.1, min: 20, max: 300, placeholder: '70.5' })}
        <div class="field"><label>Симптомы</label>
          <div class="row wrap" data-symptoms style="gap:6px">
            ${allSyms.map(s => `<button type="button" class="chip ${activeSyms.has(s) ? 'active' : ''}" data-sym="${esc(s)}">${esc(s)}</button>`).join('')}
          </div>
          <div class="row" style="margin-top:4px">
            <input class="input" id="symInput" placeholder="Другой симптом…" maxlength="60">
            <button type="button" class="btn sm secondary" data-action="add-sym" aria-label="Добавить симптом">${icon('plus')}</button>
          </div>
        </div>
        ${field({ name: 'notes', label: 'Заметки', type: 'textarea', value: cur?.notes, rows: 2, placeholder: 'Как самочувствие?' })}
        <button class="btn" type="submit">${icon('check')} Сохранить</button>
      </form>
      <div class="stack">
        <div class="card">
          <div class="row between"><h3 style="margin:0">Вес, 30 дней</h3><span class="tiny muted">${wPts.length} ${plural(wPts.length, 'точка', 'точки', 'точек')}</span></div>
          ${weightChart}
        </div>
        <div class="card">
          <h3>Энергия, настроение, стресс, уверенность · 14 дней</h3>
          ${moodChart}
          <div class="legend" style="margin-top:8px">
            <span><i class="sw" style="background:var(--c2)"></i>Энергия</span>
            <span><i class="sw" style="background:var(--c1)"></i>Настроение</span>
            <span><i class="sw" style="background:var(--c4)"></i>Стресс</span>
            <span><i class="sw" style="background:var(--c3)"></i>Уверенность</span>
          </div>
        </div>
      </div>
    </div>

    <div class="section-title"><h2>Медицинские дела</h2><button class="btn sm secondary" data-action="add-todo">${icon('plus')} Дело</button></div>
    <div class="card">
      ${openTodos.length ? `<div class="list">${openTodos.map(todoRow).join('')}</div>` : emptyState('Нет открытых дел — приёмы и анализы под контролем', '🩺')}
      ${doneTodos.length ? `<details class="acc" style="margin-top:8px"><summary class="tiny muted">Выполнено (${doneTodos.length})</summary><div class="list">${doneTodos.map(todoRow).join('')}</div></details>` : ''}
    </div>

    <div class="section-title">
      <h2>Лекарства и добавки</h2>
      <div class="row">
        ${slotsTotal ? `<span class="pill ${slotsTaken === slotsTotal ? 'good' : ''}">${slotsTaken} из ${slotsTotal}</span>` : ''}
        <button class="btn sm secondary" data-action="add-med">${icon('plus')} Лекарство</button>
      </div>
    </div>
    <div class="card">
      ${medGroups.length
        ? medGroups.map(g => `<div class="label caps" style="margin:8px 0 2px">${g.l}</div><div class="list">${g.meds.map(m => medRow(m, g.k)).join('')}</div>`).join('')
        : emptyState('Добавьте лекарства или добавки, чтобы отмечать приём', '💊')}
      ${inactiveMeds.length ? `<details class="acc" style="margin-top:8px"><summary class="tiny muted">Не принимаю сейчас (${inactiveMeds.length})</summary><div class="list">${inactiveMeds.map(m => medRow(m, null)).join('')}</div></details>` : ''}
    </div>

    <div class="section-title">
      <h2>Анализы</h2>
      <div class="row wrap">
        <select class="input" style="width:auto;padding:6px 10px;font-size:13px" data-lab-filter ${labNames.length ? '' : 'disabled'}>
          <option value="">Все показатели</option>
          ${labNames.map(n => `<option value="${esc(n)}" ${n === labFilter ? 'selected' : ''}>${esc(n)}</option>`).join('')}
        </select>
        <button class="btn sm secondary" data-action="export-labs" ${labs.length ? '' : 'disabled'}>${icon('download')} Экспорт CSV</button>
        <button class="btn sm secondary" data-action="add-lab">${icon('plus')} Анализ</button>
      </div>
    </div>
    <div class="card pad-0">
      ${shownLabs.length ? `<div class="scroll-x"><table class="tbl">
        <thead><tr><th>Дата</th><th>Показатель</th><th class="num">Значение</th><th>Референс</th><th>Статус</th></tr></thead>
        <tbody>${shownLabs.map(t => {
          const st = labStatus(t);
          return `<tr class="clickable" data-lab-edit="${esc(t.id)}">
            <td class="mono tiny">${esc(fmtDate(t.date, { relative: false, year: true }))}</td>
            <td class="bold">${esc(t.name)}${t.notes ? `<div class="tiny faint">${esc(t.notes)}</div>` : ''}</td>
            <td class="num mono">${fmtNum(t.value, 3)} <span class="muted tiny">${esc(t.unit || '')}</span></td>
            <td class="muted">${esc(refText(t))}</td>
            <td><span class="pill ${st.cls}">${st.text}</span></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : emptyState(labs.length ? 'По этому показателю нет записей' : 'Добавьте результаты анализов, чтобы следить за динамикой', '🧪')}
    </div>
    ${labChart}
  </div>`;

  const view = root.firstElementChild;

  // --- навигация по датам
  on(view, 'click', '[data-dn]', (e, t) => {
    const a = t.dataset.dn;
    if (a === 'pick') return;
    day = a === 'prev' ? addDays(day, -1) : a === 'next' ? addDays(day, 1) : today();
    rerender();
  });
  on(view, 'change', '[data-dn="pick"]', (e, t) => { if (t.value) { day = t.value; rerender(); } });

  // --- оценки 1-5 внутри страницы
  on(view, 'click', '.rating button[data-v]', (e, b) => {
    const r = b.closest('.rating');
    const hidden = r.querySelector('input[type=hidden]');
    if (hidden.value === b.dataset.v) { hidden.value = ''; r.querySelectorAll('button').forEach(x => x.classList.remove('active')); return; }
    hidden.value = b.dataset.v;
    r.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
  });

  // --- симптомы
  on(view, 'click', '[data-sym]', (e, t) => t.classList.toggle('active'));
  const symInput = view.querySelector('#symInput');
  const addSymptom = () => {
    const v = symInput.value.trim().toLowerCase();
    if (!v) return;
    const box = view.querySelector('[data-symptoms]');
    const existing = [...box.querySelectorAll('[data-sym]')].find(b => b.dataset.sym === v);
    if (existing) existing.classList.add('active');
    else box.appendChild(el(`<button type="button" class="chip active" data-sym="${esc(v)}">${esc(v)}</button>`));
    symInput.value = '';
  };
  on(view, 'click', '[data-action="add-sym"]', addSymptom);
  symInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSymptom(); } });

  // --- сохранение чек-ина
  view.querySelector('#checkinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const d = formData(e.target);
    const symptoms = [...e.target.querySelectorAll('[data-sym].active')].map(b => b.dataset.sym);
    const rec = { date: day, mood: d.mood, energy: d.energy, stress: d.stress, confidence: d.confidence, weight: d.weight, symptoms, notes: d.notes };
    db.upsert('checkins', cur ? { id: cur.id, ...rec } : rec);
    toast('Чек-ин сохранён');
  });

  // --- медицинские дела
  on(view, 'click', '[data-action="add-todo"]', () => todoModal(null));
  on(view, 'click', '[data-todo-toggle]', (e, t) => {
    const item = db.get('healthTodos', t.dataset.todoToggle); if (!item) return;
    db.update('healthTodos', item.id, { done: !item.done, doneAt: !item.done ? today() : null });
  });
  on(view, 'click', '[data-todo-edit]', (e, t) => { const item = db.get('healthTodos', t.dataset.todoEdit); if (item) todoModal(item); });

  // --- лекарства
  on(view, 'click', '[data-action="add-med"]', () => medModal(null));
  on(view, 'click', '[data-med-edit]', (e, t) => { const m = db.get('medications', t.dataset.medEdit); if (m) medModal(m); });
  on(view, 'click', '[data-med-log]', (e, t) => {
    const medId = t.dataset.medLog, time = t.dataset.time;
    const log = db.all('medLogs').find(l => l.medId === medId && l.date === day && l.time === time);
    if (log) db.remove('medLogs', log.id);
    else db.add('medLogs', { medId, date: day, time });
  });

  // --- анализы
  on(view, 'click', '[data-action="add-lab"]', () => labModal(null));
  on(view, 'click', '[data-lab-edit]', (e, t) => { const item = db.get('labTests', t.dataset.labEdit); if (item) labModal(item); });
  on(view, 'change', '[data-lab-filter]', (e, t) => { labFilter = t.value; rerender(); });
  on(view, 'click', '[data-action="export-labs"]', () => {
    const rows = sortBy(db.all('labTests'), t => t.date);
    if (!rows.length) { toast('Нет данных для экспорта'); return; }
    exportLabsCSV(rows);
  });
}
