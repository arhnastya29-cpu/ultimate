import { db } from '../db.js';
import { esc, el, icon, field, formRow, modal, toast, on, today, addDays, startOfWeek, monthKey, fmtDate, fmtNum, fmtMinutes, sum, sortBy, emptyState, emptyAction, statLine, pageMenu, barChart, lineChart, plural } from '../ui.js';

export const title = 'Тренировки';

const TYPES = { strength: 'Силовая', cardio: 'Кардио', mobility: 'Мобильность', other: 'Другое' };
const TYPE_PILL = { strength: 'accent', cardio: 'info', mobility: 'good', other: '' };
const dm = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const num = (v) => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
const isCardio = (type) => type === 'cardio';
const modeOf = (type) => isCardio(type) ? 'cardio' : 'strength';

// Локальное состояние страницы.
let progressEx = '';

// ---------- Вычисления ----------
function tonnage(w) {
  if (isCardio(w.type)) return 0;
  return sum((w.exercises || []).flatMap(e => e.sets || []), s => (Number(s.reps) || 0) * (Number(s.weight) || 0));
}

function exSummary(e, type) {
  const name = (e.name || '').trim();
  if (isCardio(type)) {
    const parts = [];
    if (e.distanceKm) parts.push(`${fmtNum(e.distanceKm, 1)} км`);
    if (e.minutes) parts.push(`${fmtNum(e.minutes)} мин`);
    return [name, parts.join(' · ')].filter(Boolean).join(' ');
  }
  const sets = e.sets || [];
  if (!sets.length) return name;
  const reps = sets.map(s => Number(s.reps) || 0).filter(Boolean);
  const repsStr = reps.length ? (new Set(reps).size === 1 ? String(reps[0]) : `${Math.min(...reps)}–${Math.max(...reps)}`) : '';
  const maxW = Math.max(0, ...sets.map(s => Number(s.weight) || 0));
  return `${name} ${sets.length}${repsStr ? '×' + repsStr : ' подх.'}${maxW ? ` @ ${fmtNum(maxW, 1)} кг` : ''}`;
}
const workoutSummary = (w) => (w.exercises || []).map(e => exSummary(e, w.type)).filter(Boolean).join(' · ');

function weekStreak(dates) {
  const weeks = new Set(dates.map(d => startOfWeek(d)));
  let w = startOfWeek(today());
  if (!weeks.has(w)) w = addDays(w, -7);
  let n = 0;
  while (weeks.has(w)) { n++; w = addDays(w, -7); }
  return n;
}

function exerciseNames() {
  const s = new Set();
  for (const w of db.all('workouts')) for (const e of w.exercises || []) if (e.name && e.name.trim()) s.add(e.name.trim());
  for (const t of db.all('workoutTemplates')) for (const e of t.exercises || []) if (e.name && e.name.trim()) s.add(e.name.trim());
  return [...s].sort((a, b) => a.localeCompare(b, 'ru'));
}

// Рекорды: самые частые силовые упражнения, лучший вес и расчётный 1ПМ.
function personalRecords(workouts) {
  const freq = {}, best = {};
  for (const w of workouts) {
    if (isCardio(w.type)) continue;
    for (const e of w.exercises || []) {
      const name = (e.name || '').trim();
      const sets = (e.sets || []).filter(s => Number(s.weight) > 0);
      if (!name || !sets.length) continue;
      freq[name] = (freq[name] || 0) + 1;
      const b = (best[name] ||= { maxW: 0, maxWReps: 0, maxWDate: '', e1rm: 0, e1rmDate: '' });
      for (const s of sets) {
        const wt = Number(s.weight), reps = Number(s.reps) || 0, r = reps || 1;
        if (wt > b.maxW || (wt === b.maxW && reps > b.maxWReps)) { b.maxW = wt; b.maxWReps = reps; b.maxWDate = w.date; }
        const e1 = wt * (1 + r / 30);
        if (e1 > b.e1rm) { b.e1rm = e1; b.e1rmDate = w.date; }
      }
    }
  }
  return Object.keys(freq)
    .sort((a, b) => freq[b] - freq[a] || a.localeCompare(b, 'ru'))
    .slice(0, 6)
    .map(n => ({ name: n, count: freq[n], ...best[n] }));
}

// ---------- Редактор упражнений (чистый DOM внутри модалки) ----------
function setRowEl(s, i) {
  return el(`<tr data-set>
    <td class="muted tiny" style="width:28px">${i}</td>
    <td><input type="number" class="input" data-reps min="0" step="1" placeholder="повт." value="${esc(s.reps ?? '')}"></td>
    <td><input type="number" class="input" data-weight min="0" step="0.5" placeholder="кг" value="${esc(s.weight ?? '')}"></td>
    <td style="width:36px"><button type="button" class="icon-btn sm" data-set-remove aria-label="Убрать подход">${icon('x')}</button></td>
  </tr>`);
}

function exRowEl(e, mode, tpl) {
  const nameInput = `<input class="input" data-ex-name list="exNames" placeholder="Упражнение" maxlength="80" value="${esc(e.name ?? '')}">`;
  const removeBtn = `<button type="button" class="icon-btn sm" data-ex-remove aria-label="Убрать упражнение">${icon('trash')}</button>`;
  if (mode === 'cardio') {
    return el(`<div class="card" style="background:var(--bg);padding:10px" data-ex>
      <div class="row">
        <div class="grow">${nameInput}</div>
        ${tpl ? '' : `<input type="number" class="input" data-dist min="0" step="0.1" placeholder="км" style="width:90px" value="${esc(e.distanceKm ?? '')}">
        <input type="number" class="input" data-min min="0" step="1" placeholder="мин" style="width:90px" value="${esc(e.minutes ?? '')}">`}
        ${removeBtn}
      </div>
    </div>`);
  }
  if (tpl) {
    return el(`<div class="card" style="background:var(--bg);padding:10px" data-ex>
      <div class="row">
        <div class="grow">${nameInput}</div>
        <label class="row tiny muted" style="gap:6px;white-space:nowrap">Подходов <input type="number" class="input" data-setcount min="1" max="20" step="1" style="width:70px" value="${esc((e.sets || []).length || 3)}"></label>
        ${removeBtn}
      </div>
    </div>`);
  }
  const sets = (e.sets && e.sets.length) ? e.sets : [{}, {}, {}];
  const row = el(`<div class="card" style="background:var(--bg);padding:10px" data-ex>
    <div class="row"><div class="grow">${nameInput}</div>${removeBtn}</div>
    <table class="tbl" style="margin-top:6px"><thead><tr><th>#</th><th>Повторы</th><th>Вес, кг</th><th></th></tr></thead><tbody></tbody></table>
    <button type="button" class="btn sm ghost" data-set-add style="margin-top:4px">${icon('plus')} подход</button>
  </div>`);
  const tb = row.querySelector('tbody');
  sets.forEach((s, i) => tb.appendChild(setRowEl(s, i + 1)));
  return row;
}

function readExercises(container, mode, tpl) {
  return [...container.querySelectorAll('[data-ex]')].map(ex => {
    const name = ex.querySelector('[data-ex-name]').value.trim();
    if (mode === 'cardio') {
      if (tpl) return { name, distanceKm: null, minutes: null };
      return { name, distanceKm: num(ex.querySelector('[data-dist]').value), minutes: num(ex.querySelector('[data-min]').value) };
    }
    if (tpl) {
      const n = Math.max(1, Math.min(20, Number(ex.querySelector('[data-setcount]').value) || 1));
      return { name, sets: Array.from({ length: n }, () => ({ reps: null, weight: null })) };
    }
    return { name, sets: [...ex.querySelectorAll('[data-set]')].map(tr => ({ reps: num(tr.querySelector('[data-reps]').value), weight: num(tr.querySelector('[data-weight]').value) })) };
  }).filter(e => e.name);
}

// Шаблон хранит только структуру: имена и число подходов, без значений.
function stripToTemplate(exs, type) {
  return exs.map(e => isCardio(type)
    ? { name: e.name, distanceKm: null, minutes: null }
    : { name: e.name, sets: Array.from({ length: Math.max(1, (e.sets || []).length) }, () => ({ reps: null, weight: null })) });
}

function wireExerciseEditor(wrap, initial, tpl) {
  const form = wrap.querySelector('.modal-form');
  const list = wrap.querySelector('[data-ex-list]');
  const typeSel = form.querySelector('[name="type"]');
  let mode = modeOf(typeSel.value);
  const renderRows = (exs) => { list.innerHTML = ''; exs.forEach(e => list.appendChild(exRowEl(e, mode, tpl))); };
  renderRows(initial);
  // Enter в полях упражнений не должен отправлять всю форму.
  list.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input')) e.preventDefault(); });

  typeSel.addEventListener('change', () => {
    const next = modeOf(typeSel.value);
    if (next === mode) return;
    const cur = readExercises(list, mode, tpl);
    mode = next;
    renderRows(cur.map(e => next === 'cardio' ? { name: e.name } : { name: e.name, sets: (e.sets && e.sets.length) ? e.sets : [{}, {}, {}] }));
  });

  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !wrap.contains(b)) return;
    if (b.hasAttribute('data-add-ex')) {
      const r = exRowEl({ name: '' }, mode, tpl);
      list.appendChild(r);
      r.querySelector('[data-ex-name]').focus();
    } else if (b.hasAttribute('data-ex-remove')) {
      b.closest('[data-ex]').remove();
    } else if (b.hasAttribute('data-set-add')) {
      const tb = b.closest('[data-ex]').querySelector('tbody');
      const last = tb.lastElementChild;
      const s = last ? { reps: last.querySelector('[data-reps]').value, weight: last.querySelector('[data-weight]').value } : {};
      tb.appendChild(setRowEl(s, tb.children.length + 1));
    } else if (b.hasAttribute('data-set-remove')) {
      const tb = b.closest('tbody');
      b.closest('tr').remove();
      [...tb.children].forEach((tr, i) => { tr.firstElementChild.textContent = i + 1; });
    }
  });
}

// ---------- Модалки ----------
function workoutModal(w, preset) {
  const base = w || preset || { date: today(), type: 'strength', title: '', exercises: [] };
  const names = exerciseNames();
  modal({
    title: w ? 'Тренировка' : 'Новая тренировка',
    wide: true,
    body: `
      <datalist id="exNames">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
      ${formRow(
        field({ name: 'date', label: 'Дата', type: 'date', value: base.date || today(), required: true }),
        field({ name: 'type', label: 'Тип', type: 'select', value: base.type || 'strength', options: Object.entries(TYPES) }),
        field({ name: 'durationMin', label: 'Длительность, мин', type: 'number', min: 0, step: 5, value: base.durationMin ?? '' }),
        field({ name: 'rpe', label: 'RPE, 1–10', type: 'number', min: 1, max: 10, step: 1, value: base.rpe ?? '' }),
      )}
      ${field({ name: 'title', label: 'Название', value: base.title, placeholder: 'Верх тела / Бег 5 км' })}
      <div class="field">
        <label>Упражнения</label>
        <div class="stack tight" data-ex-list></div>
        <div><button type="button" class="btn sm secondary" data-add-ex>${icon('plus')} упражнение</button></div>
      </div>
      ${field({ name: 'notes', label: 'Заметки', type: 'textarea', rows: 2, value: base.notes })}
      <div class="row" style="margin-top:8px"><button type="button" class="btn sm ghost" data-save-template>${icon('copy')} Сохранить как шаблон</button></div>`,
    onSubmit: (d, form) => {
      const exercises = readExercises(form, modeOf(d.type), false);
      const rec = { date: d.date, type: d.type, title: d.title || TYPES[d.type] || 'Тренировка', durationMin: d.durationMin, rpe: d.rpe, notes: d.notes, exercises };
      if (w) db.update('workouts', w.id, rec);
      else db.add('workouts', rec);
      toast(w ? 'Тренировка обновлена' : 'Тренировка добавлена');
    },
    onDelete: w ? () => { db.remove('workouts', w.id); toast('Тренировка удалена'); } : undefined,
    onOpen: (wrap) => {
      wireExerciseEditor(wrap, base.exercises || [], false);
      wrap.querySelector('[data-save-template]').addEventListener('click', () => {
        const form = wrap.querySelector('.modal-form');
        const type = form.querySelector('[name="type"]').value;
        const exs = readExercises(form, modeOf(type), false);
        if (!exs.length) { toast('Добавьте хотя бы одно упражнение'); return; }
        const ttl = form.querySelector('[name="title"]').value.trim() || TYPES[type] || 'Шаблон';
        db.add('workoutTemplates', { title: ttl, type, exercises: stripToTemplate(exs, type) });
        toast(`Шаблон «${ttl}» сохранён`);
      });
    },
  });
}

function templateModal(t) {
  const base = t || { title: '', type: 'strength', exercises: [] };
  const names = exerciseNames();
  modal({
    title: t ? 'Шаблон тренировки' : 'Новый шаблон',
    wide: true,
    body: `
      <datalist id="exNames">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
      ${formRow(
        field({ name: 'title', label: 'Название', value: base.title, required: true, placeholder: 'Верх тела A' }),
        field({ name: 'type', label: 'Тип', type: 'select', value: base.type || 'strength', options: Object.entries(TYPES) }),
      )}
      <div class="field">
        <label>Упражнения</label>
        <div class="hint" style="margin-bottom:4px">В шаблоне хранится только список упражнений и число подходов — веса и повторы вводятся в тренировке.</div>
        <div class="stack tight" data-ex-list></div>
        <div><button type="button" class="btn sm secondary" data-add-ex>${icon('plus')} упражнение</button></div>
      </div>`,
    onSubmit: (d, form) => {
      const exercises = readExercises(form, modeOf(d.type), true);
      if (!exercises.length) { toast('Добавьте хотя бы одно упражнение'); return false; }
      const rec = { title: d.title, type: d.type, exercises };
      if (t) db.update('workoutTemplates', t.id, rec);
      else db.add('workoutTemplates', rec);
      toast(t ? 'Шаблон обновлён' : 'Шаблон создан');
    },
    onDelete: t ? () => db.remove('workoutTemplates', t.id) : undefined,
    onOpen: (wrap) => wireExerciseEditor(wrap, base.exercises || [], true),
  });
}

function startFromTemplate(t) {
  const exercises = stripToTemplate(t.exercises || [], t.type);
  workoutModal(null, { date: today(), type: t.type || 'strength', title: t.title || '', durationMin: null, rpe: null, notes: '', exercises });
}

// ---------- Страница ----------
export async function render(root, ctx) {
  const rerender = () => render(root, ctx);
  const workouts = db.all('workouts');
  const templates = sortBy(db.all('workoutTemplates'), t => (t.title || '').toLowerCase());
  const t = today();
  const weekStart = startOfWeek(t);
  const weekW = workouts.filter(w => w.date >= weekStart && w.date <= addDays(weekStart, 6));
  const monthW = workouts.filter(w => monthKey(w.date) === monthKey(t));
  const weekTime = sum(weekW, w => w.durationMin);
  const weekTon = sum(weekW, tonnage);
  const streak = weekStreak(workouts.map(w => w.date));

  // --- тренировки по неделям (8 недель)
  const weeks8 = Array.from({ length: 8 }, (_, i) => addDays(weekStart, (i - 7) * 7));
  const bars = weeks8.map(ws => {
    const we = addDays(ws, 6);
    const c = workouts.filter(w => w.date >= ws && w.date <= we).length;
    return { label: dm(ws), value: c, color: ws === weekStart ? 'var(--accent)' : 'var(--c5)' };
  });

  // --- рекорды и прогресс
  const prs = personalRecords(workouts);
  const exNames = exerciseNames().filter(n => workouts.some(w => !isCardio(w.type) && (w.exercises || []).some(e => (e.name || '').trim() === n && (e.sets || []).some(s => Number(s.weight) > 0))));
  if (!progressEx || !exNames.includes(progressEx)) progressEx = prs[0]?.name || exNames[0] || '';
  let progressChart = '';
  if (progressEx) {
    const pts = sortBy(workouts.filter(w => !isCardio(w.type)), w => w.date + (w.createdAt || ''))
      .map(w => {
        const ex = (w.exercises || []).filter(e => (e.name || '').trim() === progressEx);
        const maxW = Math.max(0, ...ex.flatMap(e => (e.sets || []).map(s => Number(s.weight) || 0)));
        return maxW > 0 ? { date: w.date, y: maxW } : null;
      }).filter(Boolean);
    progressChart = pts.length >= 2
      ? lineChart([{ points: pts.map((p, i) => ({ x: i, y: p.y })), color: 'var(--c6)' }], pts.map(p => dm(p.date)))
      : emptyState('Нужно минимум две тренировки с этим упражнением', '📈');
  }

  // --- журнал: последние 30 тренировок, группировка по дате
  const recent = sortBy(workouts, w => w.date + (w.createdAt || ''), true).slice(0, 30);
  const dates = [...new Set(recent.map(w => w.date))];
  const workoutRow = (w) => `
    <div class="list-item clickable" data-workout="${esc(w.id)}" tabindex="0" role="button">
      <span class="pill ${TYPE_PILL[w.type] || ''}">${esc(TYPES[w.type] || TYPES.other)}</span>
      <div class="main">
        <div class="title">${esc(w.title || TYPES[w.type] || 'Тренировка')}</div>
        <div class="sub ellipsis">${esc(workoutSummary(w)) || '<span class="faint">без упражнений</span>'}</div>
      </div>
      <div class="tiny muted" style="text-align:right;white-space:nowrap">
        ${w.durationMin ? esc(fmtMinutes(w.durationMin)) : ''}
        ${w.rpe ? `<div>RPE ${esc(w.rpe)}</div>` : ''}
      </div>
    </div>`;

  const stats = statLine([
    weekW.length ? `На этой неделе <b>${weekW.length}</b> ${plural(weekW.length, 'тренировка', 'тренировки', 'тренировок')}` : '',
    weekTime ? `<b>${esc(fmtMinutes(weekTime))}</b>` : '',
    weekTon ? `тоннаж <b>${fmtNum(weekTon)} кг</b>` : '',
    monthW.length ? `за месяц <b>${monthW.length}</b>` : '',
    streak > 1 ? `<b>${streak}</b> ${plural(streak, 'неделя', 'недели', 'недель')} подряд` : '',
  ]);

  const templateChip = (tp) => `<span class="tpl-chip">
    <button type="button" class="tpl-start" data-tpl-start="${esc(tp.id)}" title="${esc((tp.exercises || []).map(e => e.name).join(', '))}">${icon('play')} ${esc(tp.title)}</button>
    <button type="button" class="icon-btn sm" data-tpl-edit="${esc(tp.id)}" aria-label="Изменить шаблон «${esc(tp.title)}»">${icon('edit')}</button>
  </span>`;

  root.innerHTML = `<div class="body-page" data-page="workouts">
    <div class="page-head">
      <div><div class="eyebrow">Тело</div><h1>Тренировки</h1></div>
      <div class="actions">
        <button class="btn" data-action="add-workout">${icon('plus')} Тренировка</button>
        ${pageMenu([
          { label: 'Новый шаблон', action: 'add-template', icon: 'copy' },
          { label: 'Настроить страницу', action: 'customize', icon: 'sliders' },
        ])}
      </div>
    </div>
    ${stats}

    <div class="card" data-block="journal" data-block-title="Журнал">
      <div class="row between"><h3 style="margin:0">Журнал</h3>${dates.length ? `<span class="tiny muted">последние ${recent.length}</span>` : ''}</div>
      ${dates.length ? dates.map(d => `
        <div class="label caps" style="margin:10px 0 2px">${esc(fmtDate(d, { weekday: true }))}</div>
        <div class="list">${recent.filter(w => w.date === d).map(workoutRow).join('')}</div>`).join('')
      : emptyAction({ text: 'Записывайте тренировки: упражнения, подходы и вес — рекорды и прогресс посчитаются сами', action: 'add-workout', label: 'Тренировка' })}
    </div>

    ${templates.length ? `<div class="section-title"><h2>Начать по шаблону</h2><button class="btn sm secondary" data-action="add-template">${icon('plus')} Шаблон</button></div>
      <div class="tpl-row" data-block="templates" data-block-title="Шаблоны">${templates.map(templateChip).join('')}</div>`
    : workouts.length ? `<div class="empty-row" data-block="templates" data-block-title="Шаблоны"><span>Шаблон хранит список упражнений: повторяющиеся тренировки записываются в два касания.</span><button class="btn sm secondary" data-action="add-template">${icon('plus')} Шаблон</button></div>` : ''}

    ${workouts.length ? `<details class="acc card" data-block="analytics" data-block-title="Динамика и рекорды" style="margin-top:14px">
      <summary><span class="icon-btn sm chev">${icon('chevronDown')}</span> Динамика и рекорды <span class="sum-sub">8 недель</span></summary>
      <div class="acc-body">
        <div class="acc-grid">
          <div class="card">
            <div class="row between"><h3 style="margin:0">Тренировки по неделям</h3><span class="tiny muted">8 недель</span></div>
            ${barChart(bars, { showValues: true, height: 120 })}
          </div>
          ${prs.length ? `<div class="card">
            <h3>Личные рекорды</h3>
            <div class="pr-grid">${prs.map(p => `
              <div class="pr-item">
                <div class="label ellipsis" title="${esc(p.name)}">${esc(p.name)}</div>
                <div class="value">${fmtNum(p.maxW, 1)}<small>кг${p.maxWReps ? ` × ${esc(p.maxWReps)}` : ''}</small></div>
                <div class="tiny muted">1ПМ ≈ ${fmtNum(p.e1rm)} кг · ${esc(fmtDate(p.maxWDate))}</div>
              </div>`).join('')}</div>
          </div>` : ''}
        </div>
        ${exNames.length ? `<div class="card">
          <div class="row between wrap">
            <h3 style="margin:0">Прогресс по упражнению</h3>
            <select class="input" style="width:auto;padding:6px 10px;font-size:13px" data-progress aria-label="Упражнение">
              ${exNames.map(n => `<option value="${esc(n)}" ${n === progressEx ? 'selected' : ''}>${esc(n)}</option>`).join('')}
            </select>
          </div>
          <p class="tiny muted" style="margin:4px 0 8px">Максимальный рабочий вес в каждой тренировке.</p>
          ${progressChart}
        </div>` : ''}
      </div>
    </details>` : ''}
  </div>`;

  const view = root.firstElementChild;
  on(view, 'click', '[data-action="add-workout"]', () => workoutModal(null));
  on(view, 'click', '[data-action="add-template"]', () => templateModal(null));
  on(view, 'click', '[data-tpl-start]', (e, b) => { const tp = db.get('workoutTemplates', b.dataset.tplStart); if (tp) startFromTemplate(tp); });
  on(view, 'click', '[data-tpl-edit]', (e, b) => { const tp = db.get('workoutTemplates', b.dataset.tplEdit); if (tp) templateModal(tp); });
  on(view, 'click', '[data-workout]', (e, r) => { const w = db.get('workouts', r.dataset.workout); if (w) workoutModal(w); });
  on(view, 'keydown', '[data-workout]', (e, r) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); r.click(); } });
  on(view, 'change', '[data-progress]', (e, s) => { progressEx = s.value; rerender(); });
}
