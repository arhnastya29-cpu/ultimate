// Главная: дата и статус → фокус дня (до 3 задач) → ближайшее событие → быстрое добавление →
// строка привычек → быстрый чек-ин → только актуальные модули → вечерняя рефлексия.
import { db } from '../db.js';
import { composeBlocks, customizeButton, bindCustomize } from '../blocks.js';
import { occursOn } from './calendar.js';
import { esc, icon, today, addDays, fmtDate, fmtDateLong, fmtMinutes, fmtNum, fmtMoney, progressBar, checkBtn, on, toast, weekDays, lastNDays, sum, monthKey, plural, daysBetween, clamp } from '../ui.js';

export const title = 'Сегодня';

let showRest = false;   // раскрыт ли список остальных задач дня
let habitsEdit = false; // режим правки привычек на главной (крестики на чипах)

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Доброй ночи';
  if (h < 12) return 'Доброе утро';
  if (h < 18) return 'Добрый день';
  return 'Добрый вечер';
}
const dayWord = (n) => plural(n, 'день', 'дня', 'дней');

// Разбор быстрого ввода: «! купить билеты завтра» → важная задача на завтра
function parseQuick(raw, d) {
  let title = raw.trim(); let priority = 2; let date = d; let timeless = false;
  if (title.startsWith('!')) { priority = 1; title = title.slice(1).trim(); }
  if (/\s+завтра$/i.test(title)) { date = addDays(d, 1); title = title.replace(/\s+завтра$/i, ''); }
  else if (/\s+послезавтра$/i.test(title)) { date = addDays(d, 2); title = title.replace(/\s+послезавтра$/i, ''); }
  else if (/\s+инбокс$/i.test(title)) { date = null; title = title.replace(/\s+инбокс$/i, ''); }
  else if (/\s+бессрочно$/i.test(title)) { date = null; timeless = true; title = title.replace(/\s+бессрочно$/i, ''); }
  return { title, priority, date, timeless };
}

export async function render(root, { navigate }) {
  const s = db.settings();
  const d = today();
  const hour = new Date().getHours();
  const wd = (new Date().getDay() + 6) % 7;
  const week = weekDays(d);
  const two = lastNDays(14, d);
  const projName = (id) => (id && db.get('projects', id)?.name) || '';

  // ---------- Задачи и фокус ----------
  const tasks = db.all('tasks');
  const todayTasks = tasks.filter(t => t.date === d && !t.done).sort((a, b) => (a.priority || 2) - (b.priority || 2) || (b.projectId ? 1 : 0) - (a.projectId ? 1 : 0));
  const doneToday = tasks.filter(t => t.done && String(t.doneAt || '').slice(0, 10) === d);
  const overdue = tasks.filter(t => t.date && t.date < d && !t.done);
  let focus = todayTasks.filter(t => t.focusDate === d);
  const manualFocus = focus.length > 0;
  if (!manualFocus) focus = todayTasks.slice(0, 3);
  focus = focus.slice(0, 3);
  const focusDone = doneToday.filter(t => t.focusDate === d);
  const rest = todayTasks.filter(t => !focus.includes(t));

  // ---------- Ближайшее событие / дедлайн ----------
  const upcoming = [];
  for (const t of tasks) if (!t.done && t.date && t.date > d) upcoming.push({ date: t.date, title: t.title, kind: 'задача', page: 'goals' });
  for (const p of db.all('projects')) if (p.status !== 'done' && p.deadline && p.deadline >= d) upcoming.push({ date: p.deadline, title: p.name, kind: 'дедлайн проекта', page: 'projects', params: { id: p.id } });
  for (const g of db.all('goals')) if (g.status === 'active' && g.deadline && g.deadline >= d) upcoming.push({ date: g.deadline, title: g.title, kind: 'дедлайн цели', page: 'goals' });
  for (const x of db.all('shadowTasks')) if (!x.done && x.deadline && x.deadline >= d) upcoming.push({ date: x.deadline, title: x.title, kind: 'задача от CEO', page: 'shadow' });
  for (const x of db.all('healthTodos')) if (!x.done && x.date && x.date >= d) upcoming.push({ date: x.date, title: x.title, kind: x.type === 'appointment' ? 'приём' : 'здоровье', page: 'health' });
  // события календаря: сегодня (с временем) и ближайшие
  const nowHM = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`;
  const eventsToday = db.all('events').filter(ev => occursOn(ev, d)).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  for (let i = 0; i <= 14; i++) { const dd = addDays(d, i); for (const ev of db.all('events')) if (occursOn(ev, dd) && (i > 0 || (ev.time && ev.time >= nowHM))) upcoming.push({ date: dd, title: ev.title + (ev.time ? ` · ${ev.time}` : ''), kind: 'событие', page: 'calendar', params: { date: dd }, time: ev.time || '' }); }
  const personName = (id) => db.get('people', id)?.name || '';
  for (const c of db.all('commitments')) if (!c.done && c.due && c.due >= d) upcoming.push({ date: c.due, title: `${c.title} · ${personName(c.personId)}`, kind: c.direction === 'mine' ? 'я обещала' : 'мне обещали', page: 'people', params: { id: c.personId } });
  const commOpen = db.all('commitments').filter(c => !c.done);
  const commSoon = commOpen.filter(c => c.due && c.due <= addDays(d, 7)).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 5);
  upcoming.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
  const next = upcoming.slice(0, 2);
  const overdueAll = overdue.length + db.all('shadowTasks').filter(x => !x.done && x.deadline && x.deadline < d).length + db.all('projects').filter(p => p.status !== 'done' && p.deadline && p.deadline < d).length + commOpen.filter(c => c.due && c.due < d).length;

  // ---------- Привычки ----------
  const habits = db.all('habits').filter(h => !h.archived && (!h.days?.length || h.days.includes(wd))).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const hlogs = db.all('habitLogs').filter(l => l.date === d);
  const habitCount = (h) => hlogs.find(l => l.habitId === h.id)?.count || 0;
  const habitDone = (h) => habitCount(h) >= (h.target || 1);
  const habitsDoneN = habits.filter(habitDone).length;

  // ---------- Чек-ин ----------
  const sleep = db.all('sleepLogs').find(x => x.date === d);
  const checkin = db.all('checkins').find(c => c.date === d);
  const journal = db.all('journal').find(j => j.date === d);

  // ---------- Модули: показываем только актуальные ----------
  const meals = db.all('meals').filter(m => m.date === d);
  const dayLog = db.all('dayLogs').find(x => x.date === d);
  const nutritionUsed = meals.length || dayLog || db.all('meals').some(m => two.includes(m.date));
  const kcal = sum(meals, m => m.kcal), protein = sum(meals, m => m.protein), water = dayLog?.waterMl || 0;

  const workouts = db.all('workouts');
  const wToday = workouts.filter(w => w.date === d);
  const wWeek = workouts.filter(w => week.includes(w.date)).length;
  const lastW = [...workouts].sort((a, b) => b.date.localeCompare(a.date))[0];
  const workoutsUsed = wToday.length || workouts.some(w => two.includes(w.date));
  const WTYPE = { strength: 'Силовая', cardio: 'Кардио', mobility: 'Мобильность', other: 'Другое' };

  const projects = db.all('projects').filter(p => p.status === 'active').sort((a, b) => (a.priority || 2) - (b.priority || 2) || (a.deadline || '9999').localeCompare(b.deadline || '9999')).slice(0, 3);
  const shadowOpen = db.all('shadowTasks').filter(x => !x.done).sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999')).slice(0, 3);
  const goals = db.all('goals').filter(g => g.status === 'active');
  const goalProgress = (g) => g.keyResults?.length ? Math.round(100 * g.keyResults.filter(k => k.done).length / g.keyResults.length) : (g.progress || 0);
  const nearGoals = [...goals].sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999')).slice(0, 3);

  const sessions = db.all('studySessions').filter(x => week.includes(x.date));
  const studyMin = sum(sessions, x => x.minutes);
  const dueCards = db.all('flashcards').filter(c => !c.due || c.due <= d).length;
  const activeItems = db.all('learningItems').filter(i => i.status === 'active').slice(0, 2);
  const learningUsed = dueCards || activeItems.length || sessions.length;

  const meds = db.all('medications').filter(m => m.active !== false);
  const medLogs = db.all('medLogs').filter(l => l.date === d);
  const medSlots = meds.flatMap(m => (m.times?.length ? m.times : ['morning']).map(t => ({ m, t })));
  const medsTaken = medSlots.filter(({ m, t }) => medLogs.some(l => l.medId === m.id && l.time === t)).length;
  const healthUsed = medSlots.length > 0;

  const tx = db.all('transactions');
  const spentToday = sum(tx.filter(t => t.type === 'expense' && t.date === d), t => t.amount);
  const spentMonth = sum(tx.filter(t => t.type === 'expense' && String(t.date).slice(0, 7) === monthKey(d)), t => t.amount);
  const financeUsed = tx.some(t => String(t.date).slice(0, 7) === monthKey(d));

  // ---------- Статус одной строкой ----------
  const status = [
    todayTasks.length + doneToday.length ? `задачи ${doneToday.length}/${todayTasks.length + doneToday.length}` : 'задач на день нет',
    habits.length ? `привычки ${habitsDoneN}/${habits.length}` : '',
    sleep ? `сон ${fmtNum(sleep.hours, 1)} ч` : '',
    overdueAll ? `<span class="bad">просрочено ${overdueAll}</span>` : '',
  ].filter(Boolean).join(' · ');

  const rate = (name, value, labels) => `<div class="qc-rate" data-rate="${name}">${[1, 2, 3, 4, 5].map(v => `<button type="button" class="${Number(value) === v ? 'active' : ''}" data-v="${v}" title="${labels?.[v - 1] || v}">${v}</button>`).join('')}</div>`;
  const taskRow = (t, { big = false } = {}) => `<div class="list-item ${big ? 'focus-item' : ''}">
      ${checkBtn(!!t.done, `data-task="${esc(t.id)}" aria-label="Выполнено"`)}
      <div class="main">
        <div class="title ${t.done ? 'strike' : ''}">${esc(t.title)}</div>
        <div class="sub row wrap" style="gap:6px">${t.priority === 1 ? '<span class="pill bad">важно</span>' : ''}${t.projectId && projName(t.projectId) ? `<span class="pill accent ellipsis" style="max-width:160px">${esc(projName(t.projectId))}</span>` : ''}${t.estimateMin ? `<span>${esc(fmtMinutes(t.estimateMin))}</span>` : ''}</div>
      </div>
      ${big
        ? (t.focusDate === d ? `<button type="button" class="icon-btn sm" data-unfocus="${esc(t.id)}" aria-label="Убрать из фокуса" data-tip="Убрать из фокуса">${icon('x')}</button>` : '')
        : `<button type="button" class="icon-btn sm" data-focus="${esc(t.id)}" aria-label="В фокус" data-tip="В фокус дня">${icon('star')}</button>`}
    </div>`;

  const evening = hour >= 18 || journal;

  // ---------- Блоки страницы (порядок/видимость настраиваются пользователем) ----------
  const blocks = [
    { id: 'focus', title: 'Фокус дня', col: 1, html: `<div class="card focus-card">
          <div class="section-title"><h2>${icon('target')} Фокус дня</h2><span class="tiny muted">${manualFocus ? 'выбрано вручную' : focus.length ? 'по приоритету · отметьте ★, чтобы выбрать свои' : ''}</span></div>
          ${focus.length || focusDone.length
            ? `<div class="list">${focus.map(t => taskRow(t, { big: true })).join('')}${focusDone.map(t => taskRow(t, { big: true })).join('')}</div>`
            : `<div class="empty tiny">Выберите до трёх задач, которые сделают день успешным. Добавьте задачу ниже или отметьте ★ в списке.</div>`}
          ${rest.length ? `<button type="button" class="link" data-toggle-rest style="margin-top:8px">${showRest ? 'Скрыть' : `Ещё ${rest.length} ${plural(rest.length, 'задача', 'задачи', 'задач')} на сегодня`}</button>
            ${showRest ? `<div class="list" style="margin-top:4px">${rest.map(t => taskRow(t)).join('')}</div>` : ''}` : ''}
          ${doneToday.filter(t => t.focusDate !== d).length ? `<div class="tiny faint" style="margin-top:8px">${icon('check')} сделано сегодня: ${doneToday.filter(t => t.focusDate !== d).length}</div>` : ''}
          ${overdue.length ? `<div class="tiny bad" style="margin-top:8px">${icon('clock')} Просрочено задач: ${overdue.length} · <button class="link" data-go="goals">разобрать</button></div>` : ''}
        </div>` },
    { id: 'quick', title: 'Быстрое добавление', col: 1, html: `<form class="card row quick-add" id="quickTask" style="gap:8px">
          <input class="input grow" name="title" placeholder="Добавить задачу…  «!» — важная, «завтра» — на завтра, «бессрочно» — без срока" autocomplete="off">
          <button class="icon-btn primary" type="submit" aria-label="Добавить">${icon('plus')}</button>
        </form>` },
    { id: 'habits', title: 'Привычки', col: 1, html: `<div class="card">
          <div class="section-title"><h2>${icon('repeat')} Привычки</h2><span class="row tiny muted" style="gap:8px">${habits.length ? `${habitsDoneN}/${habits.length}` : ''}<button class="link" data-habit-add>+ привычка</button><button class="link" data-habit-edit>${habitsEdit ? 'готово' : 'изменить'}</button></span></div>
          ${habits.length ? `<div class="habit-row ${habitsEdit ? 'editing' : ''}">${habits.map(h => `<button type="button" class="habit-chip ${habitDone(h) ? 'done' : ''}" data-habit="${esc(h.id)}"><span class="hc-icon">${esc(h.icon || '✓')}</span><span class="hc-name">${esc(h.name)}</span>${(h.target || 1) > 1 ? `<span class="hc-cnt">${habitCount(h)}/${h.target}</span>` : ''}${habitsEdit ? `<span class="hc-x" data-habit-remove="${esc(h.id)}" title="Убрать (в архив)">${icon('x')}</span>` : ''}</button>`).join('')}</div>` : '<div class="empty tiny">Нет привычек на сегодня. Нажмите «+ привычка»</div>'}
          ${habitsEdit ? '<div class="tiny faint" style="margin-top:8px">Тап по привычке открывает её настройки, крестик убирает в архив. Порядок и дни — на странице «Привычки».</div>' : ''}
        </div>` },
    { id: 'checkin', title: 'Чек-ин: сон, энергия, настроение', col: 1, html: `<div class="card qc">
          <div class="section-title"><h2>${icon('heart')} Как вы сегодня</h2><span class="tiny muted">${sleep && checkin?.mood && checkin?.energy && checkin?.confidence ? 'записано ✓' : 'одно касание'}</span></div>
          <div class="qc-grid">
            <div><div class="label caps">Сон, часов</div><div class="qc-rate" data-sleep>${[5, 6, 7, 8, 9].map(v => `<button type="button" class="${sleep && Math.round(sleep.hours) === v ? 'active' : ''}" data-v="${v}">${v}</button>`).join('')}${sleep && ![5, 6, 7, 8, 9].includes(Math.round(sleep.hours)) ? `<span class="tiny muted">${fmtNum(sleep.hours, 1)}</span>` : ''}</div></div>
            <div><div class="label caps">Энергия</div>${rate('energy', checkin?.energy, ['нет сил', 'мало', 'нормально', 'хорошо', 'полна сил'])}</div>
            <div><div class="label caps">Настроение</div>${rate('mood', checkin?.mood, ['плохо', 'так себе', 'ровно', 'хорошо', 'отлично'])}</div>
            <div><div class="label caps">Уверенность</div>${rate('confidence', checkin?.confidence, ['совсем нет', 'шатко', 'нормально', 'уверенно', 'непобедима'])}</div>
          </div>
        </div>` },
    { id: 'reflect', title: 'Вечерняя рефлексия', col: 1, html: evening ? `<div class="card reflect">
          <div class="section-title"><h2>${icon('moon')} Вечерняя рефлексия</h2><button class="link" data-go="journal">${journal ? 'открыть дневник' : 'подробнее'}</button></div>
          <form id="reflectForm" class="form">
            <div class="field"><label>Главное событие дня</label><input name="highlight" class="input" value="${esc(journal?.highlight || '')}" placeholder="Одной строкой"></div>
            <div class="form-row">
              <div class="field"><label>Что получилось</label><textarea name="wentWell" rows="2" placeholder="Чем довольна">${esc(journal?.wentWell || '')}</textarea></div>
              <div class="field"><label>Что улучшить</label><textarea name="improve" rows="2" placeholder="Что сделать иначе завтра">${esc(journal?.improve || '')}</textarea></div>
            </div>
            <div class="row between wrap" style="gap:8px"><span class="tiny faint">${journal ? 'сохранено' : 'сохраняется кнопкой'}</span><button class="btn sm" type="submit">${icon('check')} Сохранить</button></div>
          </form>
        </div>` : `<div class="tiny faint" style="padding:0 6px">${icon('moon')} После 18:00 здесь появится вечерняя рефлексия</div>` },
    { id: 'next', title: 'Ближайшее событие', col: 2, html: `<div class="card next-card">
          <div class="section-title"><h2>${icon('calendar')} Ближайшее</h2>${overdueAll ? `<span class="pill bad">просрочено ${overdueAll}</span>` : ''}</div>
          ${next.length ? `<div class="stack tight">${next.map((u, i) => {
            const n = daysBetween(d, u.date);
            return `<div class="row between next-item ${i === 0 ? 'first' : ''}" data-go="${esc(u.page)}" ${u.params ? `data-params='${esc(JSON.stringify(u.params))}'` : ''}>
              <div class="main"><div class="${i === 0 ? 'bold' : 'small'} ellipsis">${esc(u.title)}</div><div class="tiny muted">${esc(u.kind)}</div></div>
              <div class="tiny ${n === 0 ? 'warn bold' : 'muted'}" style="white-space:nowrap">${n === 0 ? 'сегодня' : n === 1 ? 'завтра' : `через ${n} ${dayWord(n)}`}<br><span class="faint">${esc(fmtDate(u.date, { relative: false }))}</span></div>
            </div>`;
          }).join('')}</div>` : '<div class="muted small">Ближайших дедлайнов нет. Можно выдохнуть.</div>'}
        </div>` },
    { id: 'schedule', title: 'Расписание на сегодня', col: 2, html: eventsToday.length ? `<div class="card">
          <div class="section-title"><h2>${icon('clock')} Сегодня по часам</h2><button class="link" data-go="calendar">календарь</button></div>
          <div class="list">${eventsToday.map(ev => `<div class="list-item" style="padding:7px 0;${ev.time && ev.time < nowHM && (!ev.endTime || ev.endTime < nowHM) ? 'opacity:.55' : ''}"><span class="mono tiny" style="min-width:44px">${esc(ev.time || '—')}</span><div class="main"><div class="title small">${esc(ev.title)}</div>${ev.place ? `<div class="sub">${esc(ev.place)}</div>` : ''}</div></div>`).join('')}</div>
        </div>` : '' },
    { id: 'people', title: 'Обязательства', col: 2, html: commSoon.length ? `<div class="card">
          <div class="section-title"><h2>${icon('users')} Обязательства</h2><button class="link" data-go="people">все</button></div>
          <div class="list">${commSoon.map(c => `<div class="list-item" style="padding:7px 0"><div class="main"><div class="title small">${esc(c.title)}</div><div class="sub"><span class="pill ${c.direction === 'mine' ? 'accent' : 'gold'}">${c.direction === 'mine' ? 'я обещала' : 'мне обещали'}</span> ${esc(personName(c.personId))}</div></div><span class="tiny ${c.due < d ? 'bad' : 'muted'}">${esc(fmtDate(c.due))}</span></div>`).join('')}</div>
        </div>` : '' },
    { id: 'shadow', title: 'Shadow: задачи от CEO', col: 2, html: shadowOpen.length ? `<div class="card">
          <div class="section-title"><h2>${icon('briefcase')} Shadow</h2><button class="link" data-go="shadow">открыть</button></div>
          <div class="list">${shadowOpen.map(x => `<div class="list-item" style="padding:7px 0"><div class="main"><div class="title small">${esc(x.title)}</div></div>${x.deadline ? `<span class="tiny ${x.deadline < d ? 'bad' : 'muted'}">${esc(fmtDate(x.deadline))}</span>` : ''}</div>`).join('')}</div>
        </div>` : '' },
    { id: 'projects', title: 'Проекты', col: 2, html: projects.length ? `<div class="card">
          <div class="section-title"><h2>${icon('layers')} Проекты</h2><button class="link" data-go="projects">все</button></div>
          <div class="stack tight">${projects.map(p => `<div class="proj-mini" data-go="projects" data-params='${esc(JSON.stringify({ id: p.id }))}'>
            <div class="row between"><span class="bold small ellipsis">${esc(p.name)}</span><span class="tiny mono muted">${clamp(Number(p.progress) || 0, 0, 100)}%</span></div>
            ${progressBar(clamp(Number(p.progress) || 0, 0, 100), 100, 'thin')}
            ${p.nextStep ? `<div class="tiny muted ellipsis" style="margin-top:4px">${icon('zap')} ${esc(p.nextStep)}</div>` : ''}
          </div>`).join('')}</div>
        </div>` : '' },
    { id: 'goals', title: 'Цели', col: 2, html: nearGoals.length ? `<div class="card">
          <div class="section-title"><h2>${icon('target')} Цели</h2><button class="link" data-go="goals">все</button></div>
          <div class="stack tight">${nearGoals.map(g => {
            const p = goalProgress(g); const left = g.deadline ? daysBetween(d, g.deadline) : null;
            return `<div><div class="row between"><div class="bold small ellipsis">${esc(g.title)}</div><div class="tiny ${left != null && left < 0 ? 'bad' : 'muted'}">${left == null ? '' : left < 0 ? `просрочено на ${-left} ${dayWord(-left)} · ` : left === 0 ? 'сегодня · ' : `${left} ${dayWord(left)} · `}${p}%</div></div>${progressBar(p, 100, 'thin')}</div>`;
          }).join('')}</div>
        </div>` : '' },
    { id: 'nutrition', title: 'Питание', col: 2, html: nutritionUsed ? `<div class="card">
          <div class="section-title"><h2>${icon('utensils')} Питание</h2><button class="link" data-go="nutrition">добавить</button></div>
          <div class="row wrap" style="gap:12px">
            <div><div class="label">Калории</div><div class="value" style="font-size:20px">${fmtNum(kcal)}<small>/ ${s.kcalTarget}</small></div></div>
            <div><div class="label">Белок</div><div class="value" style="font-size:20px">${fmtNum(protein)}<small>/ ${s.proteinTarget} г</small></div></div>
            <div class="grow"><div class="label">Вода</div><div class="row" style="gap:6px"><span class="value" style="font-size:20px">${fmtNum(water)}<small>/ ${s.waterTarget}</small></span><button class="btn secondary sm" data-water="250">+250</button><button class="btn secondary sm" data-water="500">+500</button></div></div>
          </div>
          ${progressBar(protein, s.proteinTarget, 'thin ' + (protein >= s.proteinTarget ? 'good' : 'info'))}
        </div>` : '' },
    { id: 'workouts', title: 'Тренировка', col: 2, html: workoutsUsed ? `<div class="card">
          <div class="section-title"><h2>${icon('dumbbell')} Тренировка</h2><button class="link" data-go="workouts">${wToday.length ? 'открыть' : 'записать'}</button></div>
          ${wToday.length ? wToday.map(w => `<div class="row between"><div><div class="bold small">${esc(w.title || 'Тренировка')}</div><div class="tiny muted">${esc(WTYPE[w.type] || w.type)} · ${fmtMinutes(w.durationMin)}</div></div><span class="pill good">${icon('check')} сегодня</span></div>`).join('')
            : `<div class="row between"><div class="small muted">${lastW ? `Последняя: ${esc(lastW.title || WTYPE[lastW.type] || lastW.type)} · ${esc(fmtDate(lastW.date))}` : 'Ещё нет тренировок'}</div><span class="pill">${wWeek} на неделе</span></div>`}
        </div>` : '' },
    { id: 'learning', title: 'Обучение', col: 2, html: learningUsed ? `<div class="card">
          <div class="section-title"><h2>${icon('brain')} Обучение</h2><button class="link" data-go="learning">открыть</button></div>
          <div class="stack tight small">
            <div class="row between"><span class="muted">За неделю</span><span class="mono">${fmtMinutes(studyMin)} / ${fmtMinutes(s.learningWeeklyMinutes)}</span></div>
            ${dueCards ? `<div class="row between"><span>${icon('layers')} Карточек к повторению: ${dueCards}</span><button class="btn sm" data-go="learning">Повторить</button></div>` : ''}
            ${activeItems.map(i => `<div class="row between"><span class="ellipsis">${icon('book')} ${esc(i.title)}</span><span class="tiny muted">${i.progress || 0}%</span></div>`).join('')}
          </div>
        </div>` : '' },
    { id: 'health', title: 'Лекарства', col: 2, html: healthUsed ? `<div class="card">
          <div class="section-title"><h2>${icon('pill')} Лекарства</h2><button class="link" data-go="health">открыть</button></div>
          <div class="row between"><span class="small muted">Принято сегодня</span><span class="pill ${medsTaken === medSlots.length ? 'good' : ''}">${medsTaken}/${medSlots.length}</span></div>
        </div>` : '' },
    { id: 'finance', title: 'Финансы', col: 2, html: financeUsed ? `<div class="card">
          <div class="section-title"><h2>${icon('wallet')} Финансы</h2><button class="link" data-go="finance">добавить</button></div>
          <div class="row between"><div><div class="label">Сегодня</div><div class="value" style="font-size:20px">${fmtMoney(spentToday, s.currency)}</div></div><div style="text-align:right"><div class="label">За месяц</div><div class="value" style="font-size:20px">${fmtMoney(spentMonth, s.currency)}</div></div></div>
        </div>` : '' },
  ];

  root.innerHTML = `<div>
    <div class="page-head">
      <div>
        <div class="eyebrow">${esc(fmtDateLong(d))}</div>
        <h1>${greeting()}${s.name ? ', ' + esc(s.name) : ''}</h1>
        <div class="small muted" style="margin-top:6px">${status}</div>
      </div>
      <div class="actions">
        ${customizeButton('today')}
        <button class="btn secondary sm" data-go="journal">${icon('pen')} Дневник</button>
        <button class="btn sm" data-add-task>${icon('plus')} Задача</button>
      </div>
    </div>
    ${composeBlocks('today', blocks)}
  </div>`;
  const view = root.firstElementChild;
  bindCustomize(view, 'today', blocks);

  // ---------- события ----------
  on(view, 'click', '[data-go]', (e, t) => {
    if (e.target.closest('[data-task],[data-habit],[data-water],[data-focus],[data-unfocus]')) return;
    let params = {}; try { params = t.dataset.params ? JSON.parse(t.dataset.params) : {}; } catch {}
    navigate(t.dataset.go, params);
  });
  on(view, 'click', '[data-task]', (e, t) => {
    const task = db.get('tasks', t.dataset.task); if (!task) return;
    db.update('tasks', task.id, { done: !task.done, doneAt: task.done ? null : new Date().toISOString() });
  });
  on(view, 'click', '[data-focus]', (e, t) => {
    const n = tasks.filter(x => x.focusDate === d && !x.done).length;
    if (n >= 3) { toast('В фокусе уже три задачи — уберите одну'); return; }
    // первый ручной выбор: закрепляем и текущие автоматические, чтобы они не пропали
    if (!manualFocus) for (const f of focus) db.update('tasks', f.id, { focusDate: d });
    db.update('tasks', t.dataset.focus, { focusDate: d });
  });
  on(view, 'click', '[data-unfocus]', (e, t) => db.update('tasks', t.dataset.unfocus, { focusDate: null }));
  on(view, 'click', '[data-toggle-rest]', () => { showRest = !showRest; render(root, { navigate }); });
  on(view, 'click', '[data-habit-add]', async () => { const m = await import('./habits.js'); m.openHabitModal(null, db.all('habits').length); });
  on(view, 'click', '[data-habit-edit]', () => { habitsEdit = !habitsEdit; render(root, { navigate }); });
  on(view, 'click', '[data-habit-remove]', (e, t) => { e.stopPropagation(); const h = db.get('habits', t.dataset.habitRemove); if (h && confirm(`Убрать «${h.name}» в архив? История сохранится.`)) db.update('habits', h.id, { archived: true }); });
  on(view, 'click', '[data-habit]', async (e, t) => {
    if (e.target.closest('[data-habit-remove]')) return;
    const h = db.get('habits', t.dataset.habit); if (!h) return;
    if (habitsEdit) { const m = await import('./habits.js'); m.openHabitModal(h); return; }
    const log = hlogs.find(l => l.habitId === h.id);
    const target = h.target || 1; const cur = log?.count || 0;
    const nextV = cur >= target ? 0 : target > 1 ? cur + 1 : target;
    if (log) db.update('habitLogs', log.id, { count: nextV }); else db.add('habitLogs', { habitId: h.id, date: d, count: nextV });
  });
  on(view, 'click', '[data-water]', (e, t) => {
    const add = Number(t.dataset.water);
    if (dayLog) db.update('dayLogs', dayLog.id, { waterMl: (dayLog.waterMl || 0) + add }); else db.add('dayLogs', { date: d, waterMl: add, steps: 0 });
  });
  on(view, 'click', '[data-sleep] button', (e, b) => {
    const hours = Number(b.dataset.v);
    if (sleep) db.update('sleepLogs', sleep.id, { hours }); else db.add('sleepLogs', { date: d, bedTime: '', wakeTime: '', hours, quality: null, energy: null, notes: '' });
    toast(`Сон: ${hours} ч`);
  });
  on(view, 'click', '[data-rate] button', (e, b) => {
    const name = b.closest('[data-rate]').dataset.rate; const v = Number(b.dataset.v);
    if (checkin) db.update('checkins', checkin.id, { [name]: v });
    else db.add('checkins', { date: d, mood: null, energy: null, stress: null, confidence: null, symptoms: [], notes: '', [name]: v });
  });
  view.querySelector('#quickTask')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const { title: tt, priority, date, timeless } = parseQuick(e.target.title.value, d);
    if (!tt) return;
    db.add('tasks', { title: tt, date, priority, timeless, done: false, doneAt: null, goalId: null, projectId: null, streamId: null, notes: '', estimateMin: null, recurring: null });
    toast(date === d ? 'Задача на сегодня добавлена' : date ? `Задача на ${fmtDate(date)}` : timeless ? 'Бессрочная задача добавлена' : 'Задача в инбоксе');
  });
  on(view, 'click', '[data-add-task]', () => { const i = view.querySelector('#quickTask input'); if (i) i.focus(); else navigate('goals'); });
  const rf = view.querySelector('#reflectForm');
  if (rf) rf.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const patch = { highlight: f.highlight.value.trim(), wentWell: f.wentWell.value.trim(), improve: f.improve.value.trim() };
    if (journal) db.update('journal', journal.id, patch);
    else db.add('journal', { date: d, gratitude: '', lessons: '', mood: checkin?.mood || null, ...patch });
    toast('Рефлексия сохранена');
  });
}
