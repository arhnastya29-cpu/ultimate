import { db } from '../db.js';
import { esc, icon, today, addDays, fmtDate, fmtDateLong, fmtMinutes, fmtNum, fmtMoney, progressBar, ring, checkBtn, on, toast, startOfWeek, weekDays, lastNDays, sum, monthKey, plural, clamp } from '../ui.js';

export const title = 'Сегодня';

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Доброй ночи';
  if (h < 12) return 'Доброе утро';
  if (h < 18) return 'Добрый день';
  return 'Добрый вечер';
}

export async function render(root, { navigate }) {
  const s = db.settings();
  const d = today();
  const wd = (new Date().getDay() + 6) % 7;

  // --- Задачи ---
  const tasks = db.all('tasks');
  const todayTasks = tasks.filter(t => t.date === d && !t.done).sort((a, b) => (a.priority || 2) - (b.priority || 2));
  const doneToday = tasks.filter(t => t.done && (t.doneAt || '').slice(0, 10) === d);
  const overdue = tasks.filter(t => t.date && t.date < d && !t.done);
  const goals = db.all('goals').filter(g => g.status === 'active');

  // --- Привычки ---
  const habits = db.all('habits').filter(h => !h.archived && (!h.days?.length || h.days.includes(wd))).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const hlogs = db.all('habitLogs').filter(l => l.date === d);
  const habitDone = (h) => (hlogs.find(l => l.habitId === h.id)?.count || 0) >= (h.target || 1);
  const habitsDoneN = habits.filter(habitDone).length;

  // --- Питание ---
  const meals = db.all('meals').filter(m => m.date === d);
  const kcal = sum(meals, m => m.kcal), protein = sum(meals, m => m.protein);
  const dayLog = db.all('dayLogs').find(x => x.date === d);
  const water = dayLog?.waterMl || 0;

  // --- Тренировки ---
  const workouts = db.all('workouts');
  const wToday = workouts.filter(w => w.date === d);
  const lastW = [...workouts].sort((a, b) => b.date.localeCompare(a.date))[0];
  const wWeek = workouts.filter(w => weekDays(d).includes(w.date)).length;

  // --- Сон ---
  const sleep = db.all('sleepLogs').find(x => x.date === d);

  // --- Обучение ---
  const week = weekDays(d);
  const sessions = db.all('studySessions').filter(x => week.includes(x.date));
  const studyMin = sum(sessions, x => x.minutes);
  const studyToday = sum(sessions.filter(x => x.date === d), x => x.minutes);
  const dueCards = db.all('flashcards').filter(c => !c.due || c.due <= d).length;
  const activeItems = db.all('learningItems').filter(i => i.status === 'active').slice(0, 3);

  // --- Здоровье ---
  const checkin = db.all('checkins').find(c => c.date === d);
  const meds = db.all('medications').filter(m => m.active !== false);
  const medLogs = db.all('medLogs').filter(l => l.date === d);
  const medSlots = meds.flatMap(m => (m.times?.length ? m.times : ['morning']).map(t => ({ m, t })));
  const medsTaken = medSlots.filter(({ m, t }) => medLogs.some(l => l.medId === m.id && l.time === t)).length;
  const healthTodos = db.all('healthTodos').filter(t => !t.done && t.date && t.date <= addDays(d, 7)).sort((a, b) => a.date.localeCompare(b.date));

  // --- Рефлексия ---
  const journal = db.all('journal').find(j => j.date === d);

  // --- Финансы ---
  const tx = db.all('transactions');
  const spentToday = sum(tx.filter(t => t.type === 'expense' && t.date === d), t => t.amount);
  const spentMonth = sum(tx.filter(t => t.type === 'expense' && t.date.slice(0, 7) === monthKey(d)), t => t.amount);

  // --- Цели с ближайшим дедлайном ---
  const goalProgress = (g) => g.keyResults?.length ? Math.round(100 * g.keyResults.filter(k => k.done).length / g.keyResults.length) : (g.progress || 0);
  const nearGoals = [...goals].sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999')).slice(0, 4);

  // --- Фокус-подсказки (что ещё не сделано) ---
  const nudges = [];
  if (!sleep) nudges.push({ text: 'Запишите, как спали', page: 'sleep' });
  if (!checkin) nudges.push({ text: 'Отметьте самочувствие', page: 'health' });
  if (dueCards) nudges.push({ text: `${dueCards} ${plural(dueCards, 'карточка', 'карточки', 'карточек')} английского к повторению`, page: 'learning' });
  if (!todayTasks.length && !doneToday.length) nudges.push({ text: 'План на день пуст — добавьте задачи', page: 'goals' });
  if (overdue.length) nudges.push({ text: `${overdue.length} ${plural(overdue.length, 'просроченная задача', 'просроченные задачи', 'просроченных задач')}`, page: 'goals' });
  if (new Date().getHours() >= 19 && !journal) nudges.push({ text: 'Вечер — время для рефлексии', page: 'journal' });
  if (protein < s.proteinTarget * 0.5 && new Date().getHours() >= 15) nudges.push({ text: `Белка пока ${fmtNum(protein)} г из ${s.proteinTarget}`, page: 'nutrition' });

  const WTYPE = { strength: 'Силовая', cardio: 'Кардио', mobility: 'Мобильность', other: 'Другое' };
  const prio = (p) => p === 1 ? '<span class="pill bad">важно</span>' : p === 3 ? '' : '<span class="pill warn">средне</span>';
  const goalName = (id) => id ? db.get('goals', id)?.title : '';

  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">${esc(fmtDateLong(d))}</div>
        <h1>${greeting()}${s.name ? ', ' + esc(s.name) : ''}</h1>
      </div>
      <div class="actions">
        <button class="btn secondary sm" data-go="journal">${icon('pen')} Рефлексия</button>
        <button class="btn sm" data-add-task>${icon('plus')} Задача</button>
      </div>
    </div>

    ${nudges.length ? `<div class="chips" style="margin-bottom:16px">${nudges.map(n => `<button class="chip" data-go="${n.page}">${icon('zap')}&nbsp;${esc(n.text)}</button>`).join('')}</div>` : ''}

    <div class="grid-4" style="margin-bottom:16px">
      <div class="stat"><div class="label">${icon('target')} Задачи</div><div class="value">${doneToday.length}<small>/ ${doneToday.length + todayTasks.length}</small></div>${progressBar(doneToday.length, doneToday.length + todayTasks.length, 'thin good')}</div>
      <div class="stat"><div class="label">${icon('repeat')} Привычки</div><div class="value">${habitsDoneN}<small>/ ${habits.length}</small></div>${progressBar(habitsDoneN, habits.length, 'thin')}</div>
      <div class="stat"><div class="label">${icon('utensils')} Белок</div><div class="value">${fmtNum(protein)}<small>/ ${s.proteinTarget} г</small></div>${progressBar(protein, s.proteinTarget, 'thin ' + (protein >= s.proteinTarget ? 'good' : 'info'))}</div>
      <div class="stat"><div class="label">${icon('brain')} Обучение</div><div class="value">${fmtNum(studyMin)}<small>/ ${s.learningWeeklyMinutes} мин</small></div>${progressBar(studyMin, s.learningWeeklyMinutes, 'thin')}<div class="sub">неделя · сегодня ${fmtMinutes(studyToday)}</div></div>
    </div>

    <div class="grid-2" style="align-items:start">
      <div class="stack">
        <div class="card">
          <div class="section-title"><h2>План на день</h2><button class="link" data-go="goals">Все задачи</button></div>
          <form class="row" id="quickTask" style="margin-bottom:8px">
            <input class="input grow" name="title" placeholder="Новая задача на сегодня…" autocomplete="off">
            <button class="icon-btn primary" type="submit" aria-label="Добавить">${icon('plus')}</button>
          </form>
          ${overdue.length ? `<div class="tiny bad" style="margin-bottom:6px">${icon('clock')} Просрочено: ${overdue.length} — <button class="link" data-go="goals">посмотреть</button></div>` : ''}
          <div class="list">
            ${todayTasks.map(t => `<div class="list-item">
              ${checkBtn(false, `data-task="${t.id}"`)}
              <div class="main"><div class="title">${esc(t.title)}</div><div class="sub row wrap" style="gap:6px">${t.projectId && db.get('projects', t.projectId) ? `<span class="pill accent ellipsis" style="max-width:160px">${esc(db.get('projects', t.projectId).name)}</span>` : ''}${[t.estimateMin ? fmtMinutes(t.estimateMin) : '', goalName(t.goalId)].filter(Boolean).map(v => `<span>${esc(v)}</span>`).join('')}</div></div>
              ${prio(t.priority)}
            </div>`).join('')}
            ${doneToday.map(t => `<div class="list-item">
              ${checkBtn(true, `data-task="${t.id}"`)}
              <div class="main"><div class="title strike">${esc(t.title)}</div></div>
            </div>`).join('')}
            ${!todayTasks.length && !doneToday.length ? '<div class="empty tiny">Пока пусто. Что сделает день успешным?</div>' : ''}
          </div>
        </div>

        <div class="card">
          <div class="section-title"><h2>Привычки</h2><button class="link" data-go="habits">Подробнее</button></div>
          ${habits.length ? `<div class="list">${habits.map(h => {
            const cnt = hlogs.find(l => l.habitId === h.id)?.count || 0;
            return `<div class="list-item">${checkBtn(cnt >= (h.target || 1), `data-habit="${h.id}"`)}
              <div class="main"><div class="title">${esc(h.icon || '')} ${esc(h.name)}</div>${(h.target || 1) > 1 ? `<div class="sub">${cnt} / ${h.target}</div>` : ''}</div></div>`;
          }).join('')}</div>` : '<div class="empty tiny">Нет привычек на сегодня</div>'}
        </div>

        <div class="card">
          <div class="section-title"><h2>Цели в фокусе</h2><button class="link" data-go="goals">Все цели</button></div>
          ${nearGoals.length ? `<div class="stack">${nearGoals.map(g => {
            const p = goalProgress(g);
            const left = g.deadline ? Math.round((new Date(g.deadline) - new Date(d)) / 86400000) : null;
            return `<div><div class="row between"><div class="bold small ellipsis">${esc(g.title)}</div><div class="tiny ${left != null && left < 0 ? 'bad' : 'muted'}">${left == null ? '' : left < 0 ? `просрочено на ${-left} дн.` : left === 0 ? 'сегодня' : `${left} дн.`} · ${p}%</div></div>${progressBar(p, 100, 'thin')}</div>`;
          }).join('')}</div>` : '<div class="empty tiny">Поставьте первую цель</div>'}
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="section-title"><h2>Питание</h2><button class="link" data-go="nutrition">Добавить</button></div>
          <div class="row" style="gap:16px">
            ${ring(clamp(kcal / s.kcalTarget * 100, 0, 100), { size: 92, label: fmtNum(kcal), sub: `из ${s.kcalTarget}` })}
            <div class="grow stack tight">
              <div><div class="row between tiny"><span>Белки</span><span class="mono">${fmtNum(protein)} / ${s.proteinTarget} г</span></div>${progressBar(protein, s.proteinTarget, 'thin good')}</div>
              <div><div class="row between tiny"><span>Жиры</span><span class="mono">${fmtNum(sum(meals, m => m.fat))} / ${s.fatTarget} г</span></div>${progressBar(sum(meals, m => m.fat), s.fatTarget, 'thin warn')}</div>
              <div><div class="row between tiny"><span>Углеводы</span><span class="mono">${fmtNum(sum(meals, m => m.carbs))} / ${s.carbsTarget} г</span></div>${progressBar(sum(meals, m => m.carbs), s.carbsTarget, 'thin info')}</div>
              <div class="row between wrap tiny" style="margin-top:4px;gap:6px"><span style="white-space:nowrap">${icon('droplet')} Вода <b>${fmtNum(water)}</b> / ${s.waterTarget} мл</span><span class="row" style="gap:4px"><button class="btn secondary sm" data-water="250">+250</button><button class="btn secondary sm" data-water="500">+500</button></span></div>
            </div>
          </div>
        </div>

        <div class="grid-2">
          <div class="card">
            <div class="section-title"><h2>Сон</h2><button class="link" data-go="sleep">${sleep ? 'Изменить' : 'Записать'}</button></div>
            ${sleep ? `<div class="value">${fmtNum(sleep.hours, 1)}<small>ч</small></div><div class="tiny muted">${esc(sleep.bedTime || '')}${sleep.bedTime ? ' → ' : ''}${esc(sleep.wakeTime || '')} · качество ${sleep.quality || '—'}/5 · энергия ${sleep.energy || '—'}/5</div>` : '<div class="muted small">Нет записи за эту ночь</div>'}
          </div>
          <div class="card">
            <div class="section-title"><h2>Самочувствие</h2><button class="link" data-go="health">${checkin ? 'Изменить' : 'Отметить'}</button></div>
            ${checkin ? `<div class="row wrap tiny" style="gap:6px"><span class="pill">настроение ${checkin.mood ?? '—'}</span><span class="pill">энергия ${checkin.energy ?? '—'}</span><span class="pill">стресс ${checkin.stress ?? '—'}</span>${checkin.weight ? `<span class="pill">${fmtNum(checkin.weight, 1)} кг</span>` : ''}</div>` : '<div class="muted small">Как вы себя чувствуете?</div>'}
            ${medSlots.length ? `<div class="tiny muted" style="margin-top:8px">${icon('pill')} Лекарства: ${medsTaken}/${medSlots.length}</div>` : ''}
            ${healthTodos.length ? `<div class="tiny" style="margin-top:6px">${healthTodos.slice(0, 2).map(t => `<div>${icon('calendar')} ${esc(t.title)} · <span class="${t.date < d ? 'bad' : 'muted'}">${esc(t.date)}</span></div>`).join('')}</div>` : ''}
          </div>
        </div>

        <div class="card">
          <div class="section-title"><h2>Тренировка</h2><button class="link" data-go="workouts">${wToday.length ? 'Открыть' : 'Записать'}</button></div>
          ${wToday.length ? wToday.map(w => `<div class="row between"><div><div class="bold">${esc(w.title || 'Тренировка')}</div><div class="tiny muted">${esc(WTYPE[w.type] || w.type)} · ${fmtMinutes(w.durationMin)}${w.rpe ? ` · RPE ${w.rpe}` : ''}</div></div><span class="pill good">${icon('check')} сегодня</span></div>`).join('') :
            `<div class="row between"><div class="small muted">${lastW ? `Последняя: ${esc(lastW.title || WTYPE[lastW.type] || lastW.type)} · ${esc(fmtDate(lastW.date))}` : 'Ещё нет тренировок'}</div><span class="pill">${wWeek} на этой неделе</span></div>`}
        </div>

        <div class="card">
          <div class="section-title"><h2>Обучение</h2><button class="link" data-go="learning">Открыть</button></div>
          <div class="stack tight small">
            ${dueCards ? `<div class="row between"><span>${icon('layers')} Английский: ${dueCards} к повторению</span><button class="btn sm" data-go="learning">Повторить</button></div>` : '<div class="muted">Карточки английского повторены ✓</div>'}
            ${activeItems.map(i => `<div class="row between"><span class="ellipsis">${icon('book')} ${esc(i.title)}</span><span class="tiny muted">${i.progress || 0}%</span></div>`).join('')}
          </div>
        </div>

        <div class="card">
          <div class="section-title"><h2>Финансы</h2><button class="link" data-go="finance">Добавить</button></div>
          <div class="row between"><div><div class="label">Сегодня</div><div class="value" style="font-size:20px">${fmtMoney(spentToday, s.currency)}</div></div><div style="text-align:right"><div class="label">За месяц</div><div class="value" style="font-size:20px">${fmtMoney(spentMonth, s.currency)}</div></div></div>
        </div>
      </div>
    </div>`;

  on(root, 'click', '[data-go]', (e, t) => navigate(t.dataset.go));
  on(root, 'click', '[data-task]', (e, t) => {
    const task = db.get('tasks', t.dataset.task);
    db.update('tasks', task.id, { done: !task.done, doneAt: task.done ? null : new Date().toISOString() });
  });
  on(root, 'click', '[data-habit]', (e, t) => {
    const h = db.get('habits', t.dataset.habit);
    const log = hlogs.find(l => l.habitId === h.id);
    const target = h.target || 1;
    const cur = log?.count || 0;
    const next = cur >= target ? 0 : target > 1 ? cur + 1 : target;
    if (log) db.update('habitLogs', log.id, { count: next }); else db.add('habitLogs', { habitId: h.id, date: d, count: next });
  });
  on(root, 'click', '[data-water]', (e, t) => {
    const add = Number(t.dataset.water);
    if (dayLog) db.update('dayLogs', dayLog.id, { waterMl: (dayLog.waterMl || 0) + add }); else db.add('dayLogs', { date: d, waterMl: add, steps: 0 });
  });
  root.querySelector('#quickTask').addEventListener('submit', (e) => {
    e.preventDefault();
    const title = e.target.title.value.trim();
    if (!title) return;
    db.add('tasks', { title, date: d, priority: 2, done: false });
    toast('Задача добавлена');
  });
  on(root, 'click', '[data-add-task]', () => { root.querySelector('#quickTask input').focus(); });
}
