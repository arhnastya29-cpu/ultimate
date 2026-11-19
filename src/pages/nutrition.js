import { db } from '../db.js';
import {
  esc, icon, modal, field, formRow, toast, today, addDays, fmtDate, fmtNum, on, dateNav,
  ring, progressBar, barChart, emptyState, emptyAction, statLine, pageMenu, sum, lastNDays, weekdayShort, sortBy, plural,
} from '../ui.js';
import { addWater } from '../model.js';

export const title = 'Питание';

const MEAL_TYPES = [
  ['breakfast', 'Завтрак', '🍳'],
  ['lunch', 'Обед', '🍲'],
  ['dinner', 'Ужин', '🍽️'],
  ['snack', 'Перекус', '🍎'],
];
const MEAL_LABEL = Object.fromEntries(MEAL_TYPES.map(([k, l]) => [k, l]));

// Стартовая библиотека (всё на 100 г).
const SEED_FOODS = [
  { name: 'Куриная грудка', kcal: 165, protein: 31, fat: 3.6, carbs: 0, portionGrams: 150 },
  { name: 'Яйцо куриное', kcal: 155, protein: 13, fat: 11, carbs: 1.1, portionGrams: 55 },
  { name: 'Творог 5%', kcal: 121, protein: 17, fat: 5, carbs: 1.8, portionGrams: 150 },
  { name: 'Греческий йогурт', kcal: 97, protein: 9, fat: 5, carbs: 4, portionGrams: 150 },
  { name: 'Овсянка (сухая)', kcal: 370, protein: 13, fat: 7, carbs: 62, portionGrams: 50 },
  { name: 'Рис (сухой)', kcal: 360, protein: 7, fat: 0.7, carbs: 79, portionGrams: 70 },
  { name: 'Гречка (сухая)', kcal: 343, protein: 13, fat: 3.4, carbs: 72, portionGrams: 70 },
  { name: 'Банан', kcal: 89, protein: 1.1, fat: 0.3, carbs: 23, portionGrams: 120 },
  { name: 'Яблоко', kcal: 52, protein: 0.3, fat: 0.2, carbs: 14, portionGrams: 180 },
  { name: 'Лосось', kcal: 208, protein: 20, fat: 13, carbs: 0, portionGrams: 150 },
  { name: 'Говядина', kcal: 250, protein: 26, fat: 15, carbs: 0, portionGrams: 150 },
  { name: 'Индейка (филе)', kcal: 135, protein: 29, fat: 1.5, carbs: 0, portionGrams: 150 },
  { name: 'Протеин (порошок)', kcal: 380, protein: 75, fat: 5, carbs: 8, portionGrams: 30 },
  { name: 'Молоко 2,5%', kcal: 52, protein: 2.9, fat: 2.5, carbs: 4.8, portionGrams: 250 },
  { name: 'Хлеб цельнозерновой', kcal: 250, protein: 9, fat: 3.5, carbs: 43, portionGrams: 40 },
  { name: 'Авокадо', kcal: 160, protein: 2, fat: 15, carbs: 9, portionGrams: 100 },
  { name: 'Миндаль', kcal: 580, protein: 21, fat: 50, carbs: 22, portionGrams: 30 },
  { name: 'Оливковое масло', kcal: 884, protein: 0, fat: 100, carbs: 0, portionGrams: 10 },
  { name: 'Картофель', kcal: 77, protein: 2, fat: 0.1, carbs: 17, portionGrams: 200 },
  { name: 'Брокколи', kcal: 34, protein: 2.8, fat: 0.4, carbs: 7, portionGrams: 150 },
  { name: 'Макароны (сухие)', kcal: 350, protein: 12, fat: 1.5, carbs: 71, portionGrams: 80 },
  { name: 'Сыр твёрдый', kcal: 360, protein: 25, fat: 28, carbs: 1, portionGrams: 30 },
  { name: 'Тунец консервированный', kcal: 116, protein: 26, fat: 1, carbs: 0, portionGrams: 100 },
  { name: 'Кефир 2,5%', kcal: 50, protein: 2.9, fat: 2.5, carbs: 4, portionGrams: 250 },
  { name: 'Шоколад тёмный', kcal: 550, protein: 6, fat: 35, carbs: 50, portionGrams: 20 },
];

// ---------- Локальное состояние страницы ----------
let day = today();
let libOpen = false;
let libSearch = '';

// ---------- Помощники ----------
const r0 = (n) => Math.round(Number(n) || 0);
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const macroLine = (m) => `Б ${fmtNum(m.protein, 1)} · Ж ${fmtNum(m.fat, 1)} · У ${fmtNum(m.carbs, 1)}`;

function totalsOf(list) {
  return {
    kcal: sum(list, m => m.kcal),
    protein: sum(list, m => m.protein),
    fat: sum(list, m => m.fat),
    carbs: sum(list, m => m.carbs),
  };
}

function dayLog(date) { return db.where('dayLogs', l => l.date === date)[0]; }

function patchDayLog(date, patchFn) {
  const log = dayLog(date);
  if (log) db.update('dayLogs', log.id, patchFn);
  else db.add('dayLogs', { date, waterMl: 0, steps: 0, ...patchFn({ waterMl: 0, steps: 0 }) });
}

function seedFoodsIfEmpty() {
  if (db.all('foods').length) return;
  for (const f of SEED_FOODS) db.add('foods', f);
}

function foodMatches(f, q) {
  const s = (q || '').trim().toLowerCase();
  return !s || String(f.name || '').toLowerCase().includes(s);
}

function sortedFoods() { return sortBy(db.all('foods'), f => String(f.name || '').toLowerCase()); }

function macroRow(label, val, target, cls, extra = '') {
  return `<div class="stack" style="gap:4px">
    <div class="row between small"><span class="bold">${label} ${extra}</span><span class="muted">${fmtNum(val)} / ${fmtNum(target)} г</span></div>
    ${progressBar(val, target, cls)}
  </div>`;
}

function libRows(foods, q) {
  const list = foods.filter(f => foodMatches(f, q));
  if (!list.length) return `<tr><td colspan="6">${emptyState('Ничего не найдено', '🔍')}</td></tr>`;
  return list.map(f => `<tr class="clickable" data-food-edit="${esc(f.id)}">
    <td class="bold">${esc(f.name)}</td>
    <td class="num">${fmtNum(f.kcal)}</td>
    <td class="num">${fmtNum(f.protein, 1)}</td>
    <td class="num">${fmtNum(f.fat, 1)}</td>
    <td class="num">${fmtNum(f.carbs, 1)}</td>
    <td class="num muted">${f.portionGrams ? fmtNum(f.portionGrams) + ' г' : '—'}</td>
  </tr>`).join('');
}

// ---------- Модалки ----------
function openMealModal({ mealType = 'breakfast', entry = null } = {}) {
  const foods = sortedFoods();
  const isEdit = !!entry;
  const initMode = isEdit ? 'manual' : 'lib';
  const per100 = (entry && Number(entry.grams) > 0) ? {
    kcal: r1(entry.kcal / entry.grams * 100),
    protein: r1(entry.protein / entry.grams * 100),
    fat: r1(entry.fat / entry.grams * 100),
    carbs: r1(entry.carbs / entry.grams * 100),
  } : null;

  const body = `
    <div class="row between" style="margin-bottom:12px">
      <div class="seg">
        <button type="button" data-mode="lib" class="${initMode === 'lib' ? 'active' : ''}">Из библиотеки</button>
        <button type="button" data-mode="manual" class="${initMode === 'manual' ? 'active' : ''}">Вручную</button>
      </div>
      <span class="tiny muted">${esc(fmtDate(entry?.date || day))}</span>
    </div>
    <input type="hidden" name="mode" value="${initMode}">
    <input type="hidden" name="foodId" value="${esc(entry?.foodId || '')}">
    <input type="hidden" name="p100kcal" value="${per100 ? per100.kcal : ''}">
    <input type="hidden" name="p100protein" value="${per100 ? per100.protein : ''}">
    <input type="hidden" name="p100fat" value="${per100 ? per100.fat : ''}">
    <input type="hidden" name="p100carbs" value="${per100 ? per100.carbs : ''}">
    <div data-pane="lib" ${initMode !== 'lib' ? 'hidden' : ''}>
      <div class="field"><label>Поиск продукта</label><input type="search" class="input" placeholder="Начните вводить название…" autocomplete="off" data-food-search></div>
      <div class="list" data-food-results style="max-height:200px;overflow-y:auto;margin:6px 0 10px"></div>
    </div>
    ${formRow(
      field({ name: 'mealType', label: 'Приём пищи', type: 'select', value: entry?.mealType || mealType, options: MEAL_TYPES.map(([k, l]) => [k, l]) }),
      field({ name: 'grams', label: 'Граммы', type: 'number', min: 0, step: 1, value: entry?.grams ?? 100, inputmode: 'decimal' }),
    )}
    ${field({ name: 'name', label: 'Название', value: entry?.name || '', placeholder: 'Что съели' })}
    <div class="small muted" data-preview style="margin-top:8px;min-height:18px"></div>
    <div data-pane="manual" ${initMode !== 'manual' ? 'hidden' : ''}>
      <div class="label caps" style="margin:10px 0 6px">Итого за порцию</div>
      ${formRow(
        field({ name: 'kcal', label: 'Ккал', type: 'number', min: 0, step: 1, value: entry?.kcal ?? '', inputmode: 'decimal' }),
        field({ name: 'protein', label: 'Белки, г', type: 'number', min: 0, step: 0.1, value: entry?.protein ?? '', inputmode: 'decimal' }),
        field({ name: 'fat', label: 'Жиры, г', type: 'number', min: 0, step: 0.1, value: entry?.fat ?? '', inputmode: 'decimal' }),
        field({ name: 'carbs', label: 'Углеводы, г', type: 'number', min: 0, step: 0.1, value: entry?.carbs ?? '', inputmode: 'decimal' }),
      )}
      ${!isEdit ? `<div style="margin-top:10px">${field({ name: 'saveLib', label: 'Сохранить в библиотеку (пересчитать на 100 г)', type: 'checkbox' })}</div>` : ''}
    </div>`;

  modal({
    title: isEdit ? 'Изменить запись' : `Добавить: ${MEAL_LABEL[mealType] || 'приём пищи'}`,
    body,
    submitText: isEdit ? 'Сохранить' : 'Добавить',
    onOpen: (wrap) => {
      const form = wrap.querySelector('.modal-form');
      const q = (sel) => form.querySelector(sel);
      const hid = (n) => q(`[name="${n}"]`);
      const modeInput = hid('mode');
      const results = q('[data-food-results]');
      const search = q('[data-food-search]');
      const preview = q('[data-preview]');
      const gramsEl = hid('grams');
      const nameEl = hid('name');
      const macro = { kcal: hid('kcal'), protein: hid('protein'), fat: hid('fat'), carbs: hid('carbs') };

      const recalc = () => {
        if (modeInput.value !== 'lib') { preview.textContent = ''; return; }
        if (hid('p100kcal').value === '') { preview.textContent = 'Выберите продукт из списка'; return; }
        const g = Number(gramsEl.value) || 0;
        const k = g / 100;
        const t = {
          kcal: r0(Number(hid('p100kcal').value) * k),
          protein: r1(Number(hid('p100protein').value) * k),
          fat: r1(Number(hid('p100fat').value) * k),
          carbs: r1(Number(hid('p100carbs').value) * k),
        };
        for (const key of Object.keys(t)) macro[key].value = t[key];
        preview.textContent = `${fmtNum(g)} г → ${fmtNum(t.kcal)} ккал · Б ${fmtNum(t.protein, 1)} · Ж ${fmtNum(t.fat, 1)} · У ${fmtNum(t.carbs, 1)}`;
      };

      const renderResults = () => {
        const list = foods.filter(f => foodMatches(f, search.value)).slice(0, 40);
        const picked = hid('foodId').value;
        results.innerHTML = list.length ? list.map(f => `<div class="list-item clickable" data-pick="${esc(f.id)}" style="padding:7px 8px;border-radius:8px;${f.id === picked ? 'background:var(--accent-soft)' : ''}">
          <div class="main"><div class="title">${esc(f.name)}</div><div class="sub">${fmtNum(f.kcal)} ккал · ${macroLine(f)} — на 100 г</div></div>
          ${f.portionGrams ? `<span class="tiny muted" style="white-space:nowrap">порция ${fmtNum(f.portionGrams)} г</span>` : ''}
        </div>`).join('') : `<div class="empty" style="padding:14px">Ничего не найдено — переключитесь на «Вручную»</div>`;
      };

      const pick = (f) => {
        hid('foodId').value = f.id;
        hid('p100kcal').value = Number(f.kcal) || 0;
        hid('p100protein').value = Number(f.protein) || 0;
        hid('p100fat').value = Number(f.fat) || 0;
        hid('p100carbs').value = Number(f.carbs) || 0;
        nameEl.value = f.name;
        gramsEl.value = f.portionGrams || 100;
        renderResults();
        recalc();
      };

      const setMode = (mode) => {
        modeInput.value = mode;
        wrap.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
        q('[data-pane="lib"]').hidden = mode !== 'lib';
        q('[data-pane="manual"]').hidden = mode !== 'manual';
        recalc();
        if (mode === 'lib') setTimeout(() => search.focus(), 20);
        else setTimeout(() => nameEl.focus(), 20);
      };

      search.addEventListener('input', renderResults);
      search.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const first = results.querySelector('[data-pick]');
        const f = first && foods.find(x => x.id === first.dataset.pick);
        if (f) pick(f);
      });
      results.addEventListener('click', (e) => {
        const t = e.target.closest('[data-pick]'); if (!t) return;
        const f = foods.find(x => x.id === t.dataset.pick);
        if (f) pick(f);
      });
      gramsEl.addEventListener('input', recalc);
      wrap.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
      renderResults();
      recalc();
      if (initMode === 'lib') setTimeout(() => search.focus(), 40);
    },
    onSubmit: (d) => {
      const name = String(d.name || '').trim();
      const grams = Math.max(0, Number(d.grams) || 0);
      let t;
      if (d.mode === 'lib') {
        if (d.p100kcal === '' || !d.foodId) { toast('Выберите продукт из списка или переключитесь на «Вручную»'); return false; }
        const k = grams / 100;
        t = {
          kcal: r0(Number(d.p100kcal) * k),
          protein: r1(Number(d.p100protein) * k),
          fat: r1(Number(d.p100fat) * k),
          carbs: r1(Number(d.p100carbs) * k),
        };
      } else {
        t = { kcal: r0(d.kcal), protein: r1(d.protein), fat: r1(d.fat), carbs: r1(d.carbs) };
      }
      if (!name) { toast('Укажите название'); return false; }
      let foodId = d.foodId || null;
      if (d.mode === 'manual' && d.saveLib && grams > 0) {
        const k = 100 / grams;
        const food = db.add('foods', {
          name, kcal: r0(t.kcal * k), protein: r1(t.protein * k), fat: r1(t.fat * k), carbs: r1(t.carbs * k), portionGrams: grams,
        });
        foodId = food.id;
      }
      const rec = { date: entry?.date || day, mealType: MEAL_LABEL[d.mealType] ? d.mealType : mealType, name, grams, ...t, foodId };
      if (isEdit) db.update('meals', entry.id, rec); else db.add('meals', rec);
      toast(isEdit ? 'Запись обновлена' : `Добавлено: ${name}`);
    },
    onDelete: isEdit ? () => { db.remove('meals', entry.id); toast('Запись удалена'); } : undefined,
  });
}

function openFoodModal(food = null) {
  modal({
    title: food ? 'Продукт' : 'Новый продукт',
    body: `
      ${field({ name: 'name', label: 'Название', value: food?.name || '', required: true, placeholder: 'Например, Творог 9%' })}
      <div class="label caps" style="margin:10px 0 6px">На 100 г</div>
      ${formRow(
        field({ name: 'kcal', label: 'Ккал', type: 'number', min: 0, step: 1, value: food?.kcal ?? '', required: true, inputmode: 'decimal' }),
        field({ name: 'protein', label: 'Белки, г', type: 'number', min: 0, step: 0.1, value: food?.protein ?? '', inputmode: 'decimal' }),
        field({ name: 'fat', label: 'Жиры, г', type: 'number', min: 0, step: 0.1, value: food?.fat ?? '', inputmode: 'decimal' }),
        field({ name: 'carbs', label: 'Углеводы, г', type: 'number', min: 0, step: 0.1, value: food?.carbs ?? '', inputmode: 'decimal' }),
      )}
      <div style="margin-top:10px">${field({ name: 'portionGrams', label: 'Стандартная порция, г', type: 'number', min: 0, step: 1, value: food?.portionGrams ?? '', hint: 'Подставляется в граммы при выборе продукта', inputmode: 'decimal' })}</div>`,
    onSubmit: (d) => {
      const rec = {
        name: String(d.name || '').trim(),
        kcal: r0(d.kcal), protein: r1(d.protein), fat: r1(d.fat), carbs: r1(d.carbs),
        portionGrams: d.portionGrams > 0 ? r0(d.portionGrams) : null,
      };
      if (!rec.name) { toast('Укажите название'); return false; }
      if (food) db.update('foods', food.id, rec); else db.add('foods', rec);
      toast('Продукт сохранён');
    },
    onDelete: food ? () => { db.remove('foods', food.id); toast('Продукт удалён'); } : undefined,
  });
}

// Приём пищи по времени суток — для кнопки «+ Приём пищи» в шапке.
function mealTypeNow() {
  const h = new Date().getHours();
  return h < 11 ? 'breakfast' : h < 16 ? 'lunch' : h < 21 ? 'dinner' : 'snack';
}

// ---------- Рендер ----------
export async function render(root) {
  seedFoodsIfEmpty();
  const s = db.settings();
  const targets = {
    kcal: Number(s.kcalTarget) || 2000,
    protein: Number(s.proteinTarget) || 120,
    fat: Number(s.fatTarget) || 70,
    carbs: Number(s.carbsTarget) || 220,
    water: Number(s.waterTarget) || 2000,
    steps: Number(s.stepsTarget) || 8000,
  };

  const meals = db.where('meals', m => m.date === day);
  const tot = totalsOf(meals);
  const log = dayLog(day) || { waterMl: 0, steps: 0 };
  const water = Number(log.waterMl) || 0;
  const steps = Number(log.steps) || 0;
  const yesterday = addDays(day, -1);
  const yMeals = db.where('meals', m => m.date === yesterday);
  const foods = sortedFoods();

  const kcalPct = (tot.kcal / targets.kcal) * 100;
  const ringColor = kcalPct > 110 ? 'var(--bad)' : kcalPct >= 90 ? 'var(--good)' : 'var(--accent)';
  const leftKcal = targets.kcal - tot.kcal;
  const leftProtein = targets.protein - tot.protein;
  const proteinOk = tot.protein >= targets.protein;

  // Неделя (7 дней, заканчивая выбранным)
  const days = lastNDays(7, day);
  const weekRows = days.map(d => {
    const list = db.where('meals', m => m.date === d);
    return { date: d, logged: list.length > 0, ...totalsOf(list) };
  });
  const logged = weekRows.filter(r => r.logged);
  const avgKcal = logged.length ? sum(logged, r => r.kcal) / logged.length : 0;
  const avgProtein = logged.length ? sum(logged, r => r.protein) / logged.length : 0;
  const proteinDays = weekRows.filter(r => r.protein >= targets.protein).length;

  const stats = statLine([
    meals.length ? `<b>${fmtNum(tot.kcal)}</b> из ${fmtNum(targets.kcal)} ккал` : '',
    meals.length ? `Белок <b class="${proteinOk ? 'good' : ''}">${fmtNum(tot.protein)}</b> из ${fmtNum(targets.protein)} г` : '',
    water ? `Вода <b class="${water >= targets.water ? 'good' : ''}">${fmtNum(water)}</b> из ${fmtNum(targets.water)} мл` : '',
    steps ? `Шаги <b class="${steps >= targets.steps ? 'good' : ''}">${fmtNum(steps)}</b>` : '',
  ]);

  const mealCard = ([type, label, emoji]) => {
    const list = meals.filter(m => m.mealType === type);
    if (!list.length) return '';
    const t = totalsOf(list);
    return `<div class="card" data-block="meal-${type}" data-block-title="${esc(label)}">
      <div class="meal-head">
        <div>
          <h3>${emoji} ${esc(label)}</h3>
          <div class="tiny muted">${fmtNum(t.kcal)} ккал · ${fmtNum(t.protein)} г белка</div>
        </div>
        <div class="row">
          <button type="button" class="btn sm secondary" data-add-meal="${type}">${icon('plus')} Добавить</button>
        </div>
      </div>
      <div class="list">${list.map(m => `<div class="list-item clickable" data-edit-meal="${esc(m.id)}" tabindex="0" role="button">
        <div class="main"><div class="title ellipsis">${esc(m.name)}</div><div class="sub">${fmtNum(m.grams)} г · ${macroLine(m)}</div></div>
        <div class="bold mono" style="white-space:nowrap">${fmtNum(m.kcal)} <span class="tiny muted">ккал</span></div>
      </div>`).join('')}</div>
    </div>`;
  };
  // Быстрое добавление: по одному чипу на приём пищи; «как вчера» — если вчера в этом приёме что-то было, а сегодня пусто.
  const quickRow = `<div class="quick-row" data-block="quick-add" data-block-title="Быстрое добавление">
    ${MEAL_TYPES.map(([type, label, emoji]) => `<button type="button" class="chip" data-add-meal="${type}">${icon('plus')} ${emoji} ${esc(label)}</button>`).join('')}
    ${MEAL_TYPES.filter(([type]) => yMeals.some(m => m.mealType === type) && !meals.some(m => m.mealType === type))
      .map(([type, label]) => `<button type="button" class="chip ghost" data-repeat="${type}" title="Скопировать вчерашние записи этого приёма">${icon('repeat')} ${esc(label)} как вчера</button>`).join('')}
  </div>`;

  root.innerHTML = `
  <div class="body-page" data-page="nutrition">
    <div class="page-head">
      <div><div class="eyebrow">Тело</div><h1>Питание</h1></div>
      <div class="actions">
        <div class="dnav">${dateNav(day)}</div>
        <button type="button" class="btn" data-add-meal="${mealTypeNow()}">${icon('plus')} Приём пищи</button>
        ${pageMenu([
          { label: 'Продукт в библиотеку', action: 'food-add', icon: 'utensils' },
          { label: 'Настроить страницу', action: 'customize', icon: 'sliders' },
        ])}
      </div>
    </div>
    ${stats}

    <div class="grid-2" style="align-items:start">
      <div class="stack">
        ${meals.length ? MEAL_TYPES.map(mealCard).join('') : `<div class="card" data-block="meals-empty" data-block-title="Приёмы пищи">
          <h3>Приёмы пищи · ${esc(fmtDate(day))}</h3>
          ${emptyAction({ text: 'Записывайте еду: будет видно калории и белок за день и неделю', action: 'add-meal', label: 'Приём пищи', attrs: `data-add-meal="${mealTypeNow()}"` })}
        </div>`}
        ${quickRow}
      </div>

      <div class="stack">
        <div class="card" data-block="water" data-block-title="Вода и шаги">
          <div class="row between" style="margin-bottom:8px">
            <h3 style="margin:0">Вода</h3>
            <span class="pill ${water >= targets.water ? 'good' : ''}">${fmtNum(water)} / ${fmtNum(targets.water)} мл</span>
          </div>
          ${progressBar(water, targets.water, water >= targets.water ? 'good' : 'info')}
          <div class="water-btns">
            <button type="button" class="btn sm secondary" data-water="250">+250</button>
            <button type="button" class="btn sm secondary" data-water="500">+500</button>
            <button type="button" class="btn sm ghost" data-water="-250" ${water ? '' : 'disabled'}>−250</button>
            ${water ? `<span class="tiny muted">≈ ${fmtNum(Math.round(water / 250))} ст.</span>` : ''}
          </div>
          <div class="divider" style="margin:14px 0"></div>
          <div class="row between" style="gap:12px">
            <div><div class="bold small">Шаги</div><div class="tiny muted">цель ${fmtNum(targets.steps)}</div></div>
            <input type="number" class="input" style="width:140px" min="0" step="100" value="${steps || ''}" placeholder="0" data-steps aria-label="Шаги за день">
          </div>
          <div style="margin-top:8px">${progressBar(steps, targets.steps, steps >= targets.steps ? 'good' : '')}</div>
        </div>

        ${meals.length ? `<div class="card" data-block="day-total" data-block-title="Итог дня">
          <h3>Итог дня</h3>
          <div class="row top" style="gap:18px;flex-wrap:wrap">
            <div style="flex-shrink:0">${ring(kcalPct, { stroke: 10, color: ringColor, label: fmtNum(tot.kcal), sub: `из ${fmtNum(targets.kcal)}` })}</div>
            <div class="grow macro-grid">
              ${macroRow('Белки', tot.protein, targets.protein, proteinOk ? 'good' : '', proteinOk ? '<span class="pill good">норма</span>' : '')}
              ${macroRow('Жиры', tot.fat, targets.fat, tot.fat > targets.fat ? 'warn' : 'info')}
              ${macroRow('Углеводы', tot.carbs, targets.carbs, tot.carbs > targets.carbs ? 'warn' : 'info')}
            </div>
          </div>
          <div class="small muted" style="margin-top:12px">
            ${leftKcal >= 0 ? `Осталось: <b>${fmtNum(leftKcal)} ккал</b>` : `Перебор: <b class="bad">${fmtNum(-leftKcal)} ккал</b>`}
            · ${leftProtein > 0 ? `<b>${fmtNum(leftProtein)} г белка</b>` : '<b class="good">белок набран</b>'}
          </div>
        </div>` : ''}
      </div>
    </div>

    ${logged.length ? `<details class="acc card" data-block="week" data-block-title="Последние 7 дней" style="margin-top:14px">
      <summary><span class="icon-btn sm chev">${icon('chevronDown')}</span> Последние 7 дней <span class="sum-sub">по ${esc(fmtDate(day))} · ${logged.length} ${plural(logged.length, 'день', 'дня', 'дней')} с записями</span></summary>
      <div class="acc-body">
        ${statLine([
          `В среднем <b>${fmtNum(avgKcal)}</b> ккал в день (цель ${fmtNum(targets.kcal)})`,
          `Белок <b class="${avgProtein >= targets.protein ? 'good' : ''}">${fmtNum(avgProtein)}</b> г в день`,
          `Дней с нормой белка: <b class="${proteinDays >= 5 ? 'good' : ''}">${proteinDays}</b> из 7`,
        ], 'acc-stats')}
        <div class="acc-grid">
          <div class="card">
            <h3>Калории по дням</h3>
            ${barChart(weekRows.map(r => ({ label: weekdayShort(r.date), value: r.kcal, color: r.kcal > targets.kcal * 1.1 ? 'var(--bad)' : 'var(--accent)' })), { height: 130, target: targets.kcal, showValues: true })}
            <div class="tiny faint">пунктир — цель ${fmtNum(targets.kcal)} ккал</div>
          </div>
          <div class="card">
            <h3>Белок по дням</h3>
            ${barChart(weekRows.map(r => ({ label: weekdayShort(r.date), value: r.protein, color: r.protein >= targets.protein ? 'var(--good)' : 'var(--accent)' })), { height: 130, target: targets.protein, showValues: true })}
            <div class="tiny faint">пунктир — цель ${fmtNum(targets.protein)} г</div>
          </div>
        </div>
      </div>
    </details>` : ''}

    <details class="acc card" ${libOpen ? 'open' : ''} data-lib data-block="library" data-block-title="Библиотека продуктов" style="margin-top:14px">
      <summary><span class="icon-btn sm chev">${icon('chevronDown')}</span> Библиотека продуктов <span class="pill">${foods.length}</span></summary>
      <div class="acc-body">
        <div class="row" style="gap:8px">
          <input type="search" class="input grow" placeholder="Поиск по названию" value="${esc(libSearch)}" data-lib-search aria-label="Поиск продукта">
          <button type="button" class="btn sm secondary" data-action="food-add">${icon('plus')} Продукт</button>
        </div>
        <div class="scroll-x"><table class="tbl">
          <thead><tr><th>Продукт</th><th class="num">Ккал</th><th class="num">Белки</th><th class="num">Жиры</th><th class="num">Углев.</th><th class="num">Порция</th></tr></thead>
          <tbody data-lib-body>${libRows(foods, libSearch)}</tbody>
        </table></div>
        <div class="tiny faint">Значения на 100 г. Нажмите на строку, чтобы изменить или удалить.</div>
      </div>
    </details>
  </div>`;

  const page = root.firstElementChild;
  const rerender = () => render(root);

  // Навигация по дням
  on(page, 'click', '[data-dn]', (e, t) => {
    const a = t.dataset.dn;
    if (a === 'prev') day = addDays(day, -1);
    else if (a === 'next') day = addDays(day, 1);
    else if (a === 'today') day = today();
    else return;
    rerender();
  });
  on(page, 'change', '[data-dn="pick"]', (e, t) => { if (t.value) { day = t.value; rerender(); } });

  // Вода (через model.addWater — единый источник dayLogs.waterMl) и шаги
  on(page, 'click', '[data-water]', (e, t) => {
    let delta = Number(t.dataset.water) || 0;
    const cur = Number((dayLog(day) || {}).waterMl) || 0;
    if (delta < 0) delta = Math.max(delta, -cur);
    if (!delta) return;
    addWater(delta, day);
  });
  on(page, 'change', '[data-steps]', (e, t) => {
    const v = Math.max(0, Math.round(Number(t.value) || 0));
    patchDayLog(day, () => ({ steps: v }));
  });

  // Приёмы пищи
  on(page, 'click', '[data-add-meal]', (e, t) => openMealModal({ mealType: t.dataset.addMeal }));
  on(page, 'click', '[data-edit-meal]', (e, t) => {
    const entry = db.get('meals', t.dataset.editMeal);
    if (entry) openMealModal({ mealType: entry.mealType, entry });
  });
  on(page, 'keydown', '[data-edit-meal]', (e, t) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); t.click(); } });
  on(page, 'click', '[data-repeat]', (e, t) => {
    const type = t.dataset.repeat;
    const src = db.where('meals', m => m.date === yesterday && m.mealType === type);
    if (!src.length) { toast('Вчера в этом приёме ничего не было'); return; }
    for (const m of src) {
      const { id, createdAt, updatedAt, ...rest } = m;
      db.add('meals', { ...rest, date: day });
    }
    toast(`Скопировано: ${src.length} ${plural(src.length, 'запись', 'записи', 'записей')}`);
  });

  // Библиотека
  const details = page.querySelector('[data-lib]');
  details.addEventListener('toggle', () => { libOpen = details.open; });
  on(page, 'input', '[data-lib-search]', (e, t) => {
    libSearch = t.value;
    page.querySelector('[data-lib-body]').innerHTML = libRows(sortedFoods(), libSearch);
  });
  on(page, 'click', '[data-action="food-add"]', () => openFoodModal());
  on(page, 'click', '[data-food-edit]', (e, t) => {
    const f = db.get('foods', t.dataset.foodEdit);
    if (f) openFoodModal(f);
  });
}
