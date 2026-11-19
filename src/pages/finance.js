import { db } from '../db.js';
import {
  esc, icon, modal, field, formRow, formData, toast, today, fmtDate, fmtMonth, fmtMoney, fmtNum, on,
  progressBar, barChart, lineChart, emptyState, emptyAction, statLine, pageMenu, sum, sortBy, monthKey, plural,
} from '../ui.js';
import { addTransaction } from '../model.js';

export const title = 'Финансы';

const EXPENSE_CATS = ['Еда', 'Продукты', 'Транспорт', 'Жильё', 'Здоровье', 'Спорт', 'Образование', 'Развлечения', 'Одежда', 'Подарки', 'Путешествия', 'Подписки', 'Другое'];
const INCOME_CATS = ['Зарплата', 'Фриланс', 'Подарок', 'Инвестиции', 'Другое'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

// ---------- Локальное состояние страницы ----------
let month = monthKey();
let quickType = 'expense';
let filterType = 'all';
let filterCat = '';

// ---------- Помощники ----------
const pad2 = (n) => String(n).padStart(2, '0');
function shiftMonth(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function daysInMonth(key) { const [y, m] = key.split('-').map(Number); return new Date(y, m, 0).getDate(); }
function monthShort(key) { const [y, m] = key.split('-').map(Number); return `${MONTHS_SHORT[m - 1]} ${String(y).slice(2)}`; }
const amt = (t) => Math.abs(Number(t.amount)) || 0;
const inMonth = (t, key) => typeof t.date === 'string' && t.date.slice(0, 7) === key;
const catKey = (c) => String(c || '').trim() || 'Без категории';
const barCls = (pct) => pct >= 100 ? 'bad' : pct >= 70 ? 'warn' : 'good';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const uniqSorted = (arr) => [...new Set(arr)].sort((a, b) => a.localeCompare(b, 'ru'));
const options = (list) => list.map(c => `<option value="${esc(c)}">`).join('');

function allCategories(type) {
  const used = db.all('transactions').filter(t => !type || t.type === type).map(t => catKey(t.category));
  const base = type === 'income' ? INCOME_CATS : type === 'expense' ? EXPENSE_CATS : [...EXPENSE_CATS, ...INCOME_CATS];
  return uniqSorted([...base, ...used]);
}

// ---------- Модалки ----------
function openTxModal(t, cur) {
  modal({
    title: 'Операция',
    body: `
      ${formRow(
        field({ name: 'type', label: 'Тип', type: 'select', value: t.type, options: [['expense', 'Расход'], ['income', 'Доход']] }),
        field({ name: 'amount', label: `Сумма, ${cur}`, type: 'number', min: 0.01, step: 0.01, value: amt(t), required: true, inputmode: 'decimal' }),
        field({ name: 'date', label: 'Дата', type: 'date', value: t.date || today(), required: true }),
      )}
      ${field({ name: 'category', label: 'Категория', value: t.category || '', list: 'fin-tx-cats', required: true, placeholder: 'Выберите или введите свою' })}
      ${field({ name: 'note', label: 'Заметка', value: t.note || '', placeholder: 'Необязательно' })}
      <datalist id="fin-tx-cats">${options(allCategories(null))}</datalist>`,
    onSubmit: (d) => {
      if (!(d.amount > 0)) { toast('Укажите сумму'); return false; }
      db.update('transactions', t.id, {
        type: d.type === 'income' ? 'income' : 'expense',
        amount: round2(d.amount),
        date: d.date || today(),
        category: catKey(d.category),
        note: d.note || '',
      });
      toast('Операция сохранена');
    },
    onDelete: () => { db.remove('transactions', t.id); toast('Операция удалена'); },
  });
}

function openBudgetModal(b, cur) {
  modal({
    title: b ? 'Бюджет' : 'Новый бюджет',
    body: `
      ${field({ name: 'category', label: 'Категория расходов', value: b?.category || '', list: 'fin-budget-cats', required: true, placeholder: 'Например, Продукты' })}
      ${field({ name: 'monthlyLimit', label: `Лимит в месяц, ${cur}`, type: 'number', min: 1, step: 1, value: b?.monthlyLimit ?? '', required: true, inputmode: 'decimal' })}
      <datalist id="fin-budget-cats">${options(allCategories('expense'))}</datalist>`,
    onSubmit: (d) => {
      if (!(d.monthlyLimit > 0)) { toast('Укажите лимит'); return false; }
      const rec = { category: catKey(d.category), monthlyLimit: round2(d.monthlyLimit) };
      if (b) db.update('budgets', b.id, rec); else db.add('budgets', rec);
      toast('Бюджет сохранён');
    },
    onDelete: b ? () => { db.remove('budgets', b.id); toast('Бюджет удалён'); } : undefined,
  });
}

function openGoalModal(g, cur) {
  modal({
    title: g ? 'Финансовая цель' : 'Новая цель',
    body: `
      ${field({ name: 'title', label: 'Название', value: g?.title || '', required: true, placeholder: 'Подушка безопасности, отпуск…' })}
      ${formRow(
        field({ name: 'target', label: `Цель, ${cur}`, type: 'number', min: 1, step: 1, value: g?.target ?? '', required: true, inputmode: 'decimal' }),
        field({ name: 'saved', label: `Накоплено, ${cur}`, type: 'number', min: 0, step: 1, value: g?.saved ?? 0, inputmode: 'decimal' }),
      )}
      ${field({ name: 'deadline', label: 'Срок', type: 'date', value: g?.deadline || '' })}`,
    onSubmit: (d) => {
      if (!(d.target > 0)) { toast('Укажите сумму цели'); return false; }
      const rec = { title: String(d.title || '').trim(), target: round2(d.target), saved: round2(d.saved), deadline: d.deadline || null };
      if (!rec.title) { toast('Укажите название'); return false; }
      if (g) db.update('financeGoals', g.id, rec); else db.add('financeGoals', rec);
      toast('Цель сохранена');
    },
    onDelete: g ? () => { db.remove('financeGoals', g.id); toast('Цель удалена'); } : undefined,
  });
}

// ---------- Рендер ----------
export async function render(root) {
  const s = db.settings();
  const cur = s.currency || '₽';
  const money = (n) => fmtMoney(n, cur);
  const signedMoney = (n) => `${n < 0 ? '−' : '+'}${money(Math.abs(n))}`;

  const all = db.all('transactions');
  const tx = all.filter(t => inMonth(t, month));
  const expenses = tx.filter(t => t.type === 'expense');
  const incomes = tx.filter(t => t.type === 'income');
  const income = sum(incomes, amt);
  const expense = sum(expenses, amt);
  const balance = income - expense;

  const nowKey = monthKey();
  const isCurrent = month === nowKey;
  const dim = daysInMonth(month);
  const elapsed = isCurrent ? Number(today().slice(8, 10)) : month < nowKey ? dim : 0;
  const avgDay = elapsed ? expense / elapsed : 0;
  const forecast = isCurrent ? avgDay * dim : null;

  // По категориям
  const byCat = {};
  for (const t of expenses) { const k = catKey(t.category); byCat[k] = (byCat[k] || 0) + amt(t); }
  const catRows = sortBy(Object.entries(byCat).map(([category, total]) => ({ category, total })), r => r.total, true);

  // По дням
  const daily = Array.from({ length: dim }, (_, i) => ({ label: (i === 0 || (i + 1) % 5 === 0) ? String(i + 1) : '', value: 0 }));
  for (const t of expenses) { const d = Number(t.date.slice(8, 10)); if (d >= 1 && d <= dim) daily[d - 1].value += amt(t); }

  // Бюджеты
  const budgetRows = sortBy(db.all('budgets'), b => catKey(b.category).toLowerCase()).map(b => {
    const limit = Number(b.monthlyLimit) || 0;
    const spent = byCat[catKey(b.category)] || 0;
    const pct = limit ? (spent / limit) * 100 : 0;
    return { ...b, limit, spent, pct };
  });
  const budgetLeft = sum(budgetRows, r => r.limit - r.spent);

  // Тренд за 6 месяцев (заканчивая выбранным)
  const trend = Array.from({ length: 6 }, (_, i) => shiftMonth(month, i - 5)).map(key => {
    const list = all.filter(t => inMonth(t, key));
    return {
      key,
      income: sum(list.filter(t => t.type === 'income'), amt),
      expense: sum(list.filter(t => t.type === 'expense'), amt),
      n: list.length,
    };
  });
  const activeMonths = trend.filter(m => m.n > 0);
  const avgNet = activeMonths.length ? sum(activeMonths, m => m.income - m.expense) / activeMonths.length : 0;

  // Цели
  const goals = sortBy(db.all('financeGoals'), g => (Number(g.saved) || 0) / (Number(g.target) || 1), true);

  // Операции с фильтрами
  const monthCats = uniqSorted(tx.map(t => catKey(t.category)));
  if (filterCat && !monthCats.includes(filterCat)) monthCats.push(filterCat);
  let shown = tx;
  if (filterType !== 'all') shown = shown.filter(t => t.type === filterType);
  if (filterCat) shown = shown.filter(t => catKey(t.category) === filterCat);
  shown = [...shown].sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  const stats = statLine([
    income ? `Доходы <b class="good">${money(income)}</b>` : '',
    expense ? `Расходы <b class="bad">${money(expense)}</b>` : '',
    tx.length ? `Баланс <b class="${balance >= 0 ? 'good' : 'bad'}">${signedMoney(balance)}</b>` : '',
    expense && forecast != null ? `прогноз расходов на месяц <b>${money(forecast)}</b>` : '',
    expense && elapsed && !isCurrent ? `в среднем <b>${money(avgDay)}</b> в день` : '',
  ]);

  const goalRow = (g) => {
    const target = Number(g.target) || 0, saved = Number(g.saved) || 0;
    const left = target - saved;
    const pct = target ? Math.min(100, Math.round((saved / target) * 100)) : 0;
    let eta;
    if (left <= 0) eta = '<span class="pill good">цель достигнута</span>';
    else if (avgNet > 0) { const m = Math.ceil(left / avgNet); eta = `≈ ${m} ${plural(m, 'месяц', 'месяца', 'месяцев')} при текущем темпе`; }
    else eta = 'нет данных для прогноза';
    return `<div class="list-item">
      <div class="main clickable" data-goal-edit="${esc(g.id)}" tabindex="0" role="button" style="cursor:pointer">
        <div class="row between"><div class="title">${esc(g.title)}</div><span class="small bold ${left <= 0 ? 'good' : ''}">${money(saved)} <span class="muted">/ ${money(target)}</span></span></div>
        <div style="margin:6px 0 4px">${progressBar(saved, target, left <= 0 ? 'good' : '')}</div>
        <div class="sub">${pct}%${left > 0 ? ` · осталось ${money(left)}` : ''}${g.deadline ? ` · до ${esc(fmtDate(g.deadline, { relative: false, year: true }))}` : ''} · ${eta}</div>
      </div>
      ${left > 0 ? `<button type="button" class="btn sm secondary" data-goal-topup="${esc(g.id)}">${icon('plus')} Пополнить</button>` : ''}
    </div>`;
  };

  const txTable = `<div class="scroll-x"><table class="tbl tx-table">
    <thead><tr><th>Дата</th><th>Категория</th><th>Заметка</th><th class="num">Сумма</th></tr></thead>
    <tbody>${shown.map(t => `<tr class="clickable" data-tx-edit="${esc(t.id)}">
      <td>${esc(fmtDate(t.date))}</td>
      <td><span class="tag">${esc(catKey(t.category))}</span></td>
      <td class="muted">${esc(t.note || '')}</td>
      <td class="num bold ${t.type === 'income' ? 'good' : 'bad'}" style="white-space:nowrap">${t.type === 'income' ? '+' : '−'}${money(amt(t))}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;

  root.innerHTML = `
  <div class="body-page" data-page="finance">
    <div class="page-head">
      <div><div class="eyebrow">Ресурсы</div><h1>Финансы</h1></div>
      <div class="actions">
        <div class="month-nav">
          <button type="button" class="icon-btn sm" data-month="prev" aria-label="Предыдущий месяц">${icon('chevronLeft')}</button>
          <button type="button" class="chip ${isCurrent ? 'active' : ''}" data-month="today">${esc(fmtMonth(month))}</button>
          <button type="button" class="icon-btn sm" data-month="next" aria-label="Следующий месяц">${icon('chevronRight')}</button>
        </div>
        <button type="button" class="btn" data-action="quick-expense">${icon('plus')} Расход</button>
        ${pageMenu([
          { label: 'Доход', action: 'quick-income', icon: 'arrowUp' },
          { label: 'Бюджет на категорию', action: 'budget-add', icon: 'target' },
          { label: 'Финансовая цель', action: 'goal-add', icon: 'star' },
          { label: 'Настроить страницу', action: 'customize', icon: 'sliders' },
        ])}
      </div>
    </div>
    ${stats}

    <div class="grid-2" style="align-items:start">
      <div class="stack">
        <div class="card" data-block="transactions" data-block-title="Операции">
          <div class="row between" style="margin-bottom:${tx.length ? 10 : 6}px"><h3 style="margin:0">Операции · ${esc(fmtMonth(month))}${tx.length ? ` <span class="muted small">· ${shown.length}</span>` : ''}</h3></div>
          ${tx.length ? `<div class="filters">
            <div class="chips">
              <button type="button" class="chip ${filterType === 'all' ? 'active' : ''}" data-ftype="all">Все</button>
              <button type="button" class="chip ${filterType === 'expense' ? 'active' : ''}" data-ftype="expense">Расходы</button>
              <button type="button" class="chip ${filterType === 'income' ? 'active' : ''}" data-ftype="income">Доходы</button>
            </div>
            ${monthCats.length > 1 || filterCat ? `<select class="input" data-fcat aria-label="Категория">
              <option value="">Все категории</option>
              ${monthCats.map(c => `<option value="${esc(c)}" ${c === filterCat ? 'selected' : ''}>${esc(c)}</option>`).join('')}
            </select>` : ''}
          </div>` : ''}
          ${shown.length ? txTable
            : tx.length ? emptyState('По этому фильтру ничего нет', '💸')
            : emptyAction({ text: 'Записывайте расходы и доходы: будет видно, куда уходят деньги и сколько остаётся', action: 'quick-expense', label: 'Расход' })}
        </div>

        <form class="card form fin-quick" data-quick data-block="quick" data-block-title="Быстрая запись">
          <div class="row between wrap" style="gap:8px">
            <h3 style="margin:0">Быстрая запись</h3>
            <div class="seg">
              <button type="button" data-qtype="expense" class="${quickType === 'expense' ? 'active' : ''}">Расход</button>
              <button type="button" data-qtype="income" class="${quickType === 'income' ? 'active' : ''}">Доход</button>
            </div>
          </div>
          <input type="hidden" name="type" value="${quickType}">
          ${formRow(
            field({ name: 'amount', label: `Сумма, ${cur}`, type: 'number', min: 0.01, step: 0.01, required: true, placeholder: '0', inputmode: 'decimal' }),
            field({ name: 'category', label: 'Категория', value: '', list: `fin-cats-${quickType}`, required: true, placeholder: 'Выберите или введите свою' }),
          )}
          ${formRow(
            field({ name: 'date', label: 'Дата', type: 'date', value: today(), required: true }),
            field({ name: 'note', label: 'Заметка', placeholder: 'Необязательно' }),
          )}
          <datalist id="fin-cats-expense">${options(allCategories('expense'))}</datalist>
          <datalist id="fin-cats-income">${options(allCategories('income'))}</datalist>
          <button class="btn" type="submit">${icon('plus')} Добавить</button>
        </form>
      </div>

      <div class="stack">
        <div class="card" data-block="budgets" data-block-title="Бюджеты на месяц">
          <div class="row between" style="margin-bottom:8px">
            <h3 style="margin:0">Бюджеты на месяц</h3>
            ${budgetRows.length ? `<button type="button" class="btn sm secondary" data-action="budget-add">${icon('plus')} Бюджет</button>` : ''}
          </div>
          ${budgetRows.length ? `<div class="list">${budgetRows.map(b => `<div class="list-item clickable" data-budget-edit="${esc(b.id)}" tabindex="0" role="button">
              <div class="main">
                <div class="row between small"><span class="bold">${esc(b.category)}</span><span class="${barCls(b.pct)}">${money(b.spent)} <span class="muted">/ ${money(b.limit)}</span></span></div>
                <div style="margin:6px 0 4px">${progressBar(b.spent, b.limit, barCls(b.pct))}</div>
                <div class="sub">${b.limit - b.spent >= 0 ? `осталось ${money(b.limit - b.spent)}` : `<span class="bad">перерасход ${money(b.spent - b.limit)}</span>`} · ${Math.round(b.pct)}%</div>
              </div>
            </div>`).join('')}</div>
            <div class="divider" style="margin:10px 0"></div>
            <div class="row between small"><span class="muted">Остаток по бюджетам</span><span class="bold ${budgetLeft >= 0 ? 'good' : 'bad'}">${signedMoney(budgetLeft)}</span></div>`
          : emptyAction({ text: 'Лимит по категории покажет, сколько ещё можно потратить в этом месяце', action: 'budget-add', label: 'Бюджет' })}
        </div>

        <div class="card" data-block="goals" data-block-title="Финансовые цели">
          <div class="row between" style="margin-bottom:8px">
            <h3 style="margin:0">Финансовые цели</h3>
            ${goals.length ? `<button type="button" class="btn sm secondary" data-action="goal-add">${icon('plus')} Цель</button>` : ''}
          </div>
          ${goals.length ? `<div class="list">${goals.map(goalRow).join('')}</div>
            <div class="tiny faint" style="margin-top:8px">Прогноз — по среднему чистому доходу за 6 месяцев${avgNet > 0 ? ` (${signedMoney(avgNet)} в месяц)` : ''}.</div>`
          : emptyAction({ text: 'Накопления на что-то важное: цель, сумма и срок — пополняйте по мере возможности', action: 'goal-add', label: 'Цель' })}
        </div>
      </div>
    </div>

    ${all.length ? `<details class="acc card" data-block="analytics" data-block-title="Аналитика" style="margin-top:14px">
      <summary><span class="icon-btn sm chev">${icon('chevronDown')}</span> Аналитика <span class="sum-sub">категории · по дням · 6 месяцев</span></summary>
      <div class="acc-body">
        <div class="acc-grid">
          <div class="card">
            <h3>Расходы по категориям</h3>
            ${catRows.length ? `<div class="stack" style="gap:8px">${catRows.map((r, i) => {
              const pct = expense ? (r.total / expense) * 100 : 0;
              const color = `var(--c${(i % 8) + 1})`;
              return `<div>
                <div class="row between small">
                  <span class="row" style="gap:6px;min-width:0"><i class="color-dot" style="background:${color}"></i><span class="ellipsis">${esc(r.category)}</span></span>
                  <span style="white-space:nowrap"><b>${money(r.total)}</b> <span class="muted tiny">${Math.round(pct)}%</span></span>
                </div>
                <div class="bar thin" style="margin-top:4px"><i style="width:${pct.toFixed(1)}%;background:${color}"></i></div>
              </div>`;
            }).join('')}</div>` : '<p class="tiny muted">В этом месяце расходов нет.</p>'}
            ${expense ? `<div class="divider" style="margin:14px 0 10px"></div>
            <div class="label caps" style="margin-bottom:6px">Расходы по дням</div>
            ${barChart(daily, { height: 110, color: 'var(--bad)' })}` : ''}
          </div>
          <div class="card">
            <div class="row between wrap" style="margin-bottom:6px">
              <h3 style="margin:0">Динамика за 6 месяцев</h3>
              <div class="legend"><span><i class="sw" style="background:var(--good)"></i>Доходы</span><span><i class="sw" style="background:var(--bad)"></i>Расходы</span></div>
            </div>
            ${lineChart([
              { points: trend.map((m, i) => ({ x: i, y: m.income })), color: 'var(--good)' },
              { points: trend.map((m, i) => ({ x: i, y: m.expense })), color: 'var(--bad)' },
            ], trend.map(m => monthShort(m.key)), { height: 150, min: 0 })}
            <div class="row wrap tiny muted" style="gap:12px;margin-top:6px">${trend.map(m => `<span>${esc(monthShort(m.key))}: <span class="${m.income - m.expense >= 0 ? 'good' : 'bad'}">${m.n ? signedMoney(m.income - m.expense) : '—'}</span></span>`).join('')}</div>
          </div>
        </div>
      </div>
    </details>` : ''}
  </div>`;

  const page = root.firstElementChild;
  const rerender = () => render(root);

  // Месяц
  on(page, 'click', '[data-month]', (e, t) => {
    const a = t.dataset.month;
    if (a === 'prev') month = shiftMonth(month, -1);
    else if (a === 'next') month = shiftMonth(month, 1);
    else month = monthKey();
    rerender();
  });

  // Быстрая запись
  const quick = page.querySelector('[data-quick]');
  const setQuickType = (type) => {
    quickType = type === 'income' ? 'income' : 'expense';
    quick.querySelectorAll('[data-qtype]').forEach(b => b.classList.toggle('active', b.dataset.qtype === quickType));
    quick.querySelector('[name="type"]').value = quickType;
    quick.querySelector('[name="category"]').setAttribute('list', `fin-cats-${quickType}`);
  };
  on(page, 'click', '[data-qtype]', (e, t) => setQuickType(t.dataset.qtype));
  // Главное действие в шапке и кнопка пустого состояния: подготовить форму и поставить курсор в сумму.
  on(page, 'click', '[data-action="quick-expense"], [data-action="quick-income"]', (e, t) => {
    setQuickType(t.dataset.action === 'quick-income' ? 'income' : 'expense');
    quick.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => quick.querySelector('[name="amount"]')?.focus(), 350);
  });
  quick.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!quick.reportValidity()) return;
    const d = formData(quick);
    if (!(d.amount > 0)) { toast('Укажите сумму'); return; }
    const date = d.date || today();
    const type = d.type === 'income' ? 'income' : 'expense';
    addTransaction({ date, type, amount: round2(d.amount), category: catKey(d.category), note: d.note || '' });
    if (date.slice(0, 7) !== month) month = date.slice(0, 7);
    toast(type === 'income' ? `Доход добавлен: ${money(d.amount)}` : `Расход добавлен: ${money(d.amount)}`);
  });

  // Бюджеты
  on(page, 'click', '[data-action="budget-add"]', () => openBudgetModal(null, cur));
  on(page, 'click', '[data-budget-edit]', (e, t) => {
    const b = db.get('budgets', t.dataset.budgetEdit);
    if (b) openBudgetModal(b, cur);
  });
  on(page, 'keydown', '[data-budget-edit], [data-goal-edit]', (e, t) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); t.click(); } });

  // Цели
  on(page, 'click', '[data-action="goal-add"]', () => openGoalModal(null, cur));
  on(page, 'click', '[data-goal-edit]', (e, t) => {
    const g = db.get('financeGoals', t.dataset.goalEdit);
    if (g) openGoalModal(g, cur);
  });
  on(page, 'click', '[data-goal-topup]', (e, t) => {
    const g = db.get('financeGoals', t.dataset.goalTopup);
    if (!g) return;
    const raw = prompt(`Сумма пополнения «${g.title}», ${cur}`);
    if (raw == null) return;
    const n = Number(String(raw).replace(',', '.').replace(/\s/g, ''));
    if (!(n > 0)) { toast('Введите положительную сумму'); return; }
    db.update('financeGoals', g.id, (x) => ({ saved: round2((Number(x.saved) || 0) + n) }));
    toast(`Пополнено на ${money(n)}`);
  });

  // Операции
  on(page, 'click', '[data-ftype]', (e, t) => { filterType = t.dataset.ftype; rerender(); });
  on(page, 'change', '[data-fcat]', (e, t) => { filterCat = t.value; rerender(); });
  on(page, 'click', '[data-tx-edit]', (e, t) => {
    const tr = db.get('transactions', t.dataset.txEdit);
    if (tr) openTxModal(tr, cur);
  });
}
