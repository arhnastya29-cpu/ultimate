// Главная: что сегодня главное → что произойдёт следующим → что требует внимания.
// Порядок: дата и приветствие → следующее событие → фокус дня (с быстрым добавлением) →
// привычки → компактный чек-ин → ближайшие дедлайны и предупреждения → вечерняя рефлексия.
// Карточки модулей показываются только если модуль используется.
import { db } from '../db.js';
import { composeBlocks, bindCustomize } from '../blocks.js';
import { greetingFor, dailyQuote, quoteHtml, cheer, habitCheer } from '../motivation.js';
import { openCapture } from '../capture.js';
import { aiReady, askOnce, aiProvider } from '../ai.js';
import { whoopOn, recoveryClass, recoveryWord } from '../whoop.js';
import { tgData, waitingForMe, quietContacts, chatLink } from '../tg.js';
import { cleanDigest } from '../signals.js';
import { esc, icon, today, addDays, fmtDate, fmtDateLong, fmtMinutes, fmtNum, fmtMoney, progressBar, checkBtn, on, toast, weekDays, lastNDays, sum, monthKey, plural, daysBetween, clamp, pageMenu, statLine } from '../ui.js';
import { agendaOn, nextEvent, upcomingDeadlines, overdueItems, isMine, toggleTask, addTask, habitStatus, habitScheduled, setHabitCount, checkinOn, sleepOn, setCheckin, setSleepHours, addWater, projectProgress, goalProgress, moduleOn, ceoPerson, personName, nowHM } from '../model.js';

export const title = 'Сегодня';

let showRest = false;    // раскрыт ли список остальных задач дня
let habitsEdit = false;  // режим правки привычек (крестики)
let checkinOpen = false; // раскрыт ли полный чек-ин
let adviceBusy = false;  // идёт запрос совета дня
const ADVICE_KEY = 'ultimate_advice';
function loadAdvice(d) { try { const a = JSON.parse(localStorage.getItem(ADVICE_KEY) || 'null'); return a && a.date === d ? a : null; } catch { return null; } }
function saveAdvice(d, text) { try { localStorage.setItem(ADVICE_KEY, JSON.stringify({ date: d, text, at: Date.now() })); } catch {} }

const dayWord = (n) => plural(n, 'день', 'дня', 'дней');
const minWord = (n) => plural(n, 'минуту', 'минуты', 'минут');

// Разбор быстрого ввода: «! купить билеты завтра» → важная задача на завтра
export function parseQuick(raw, d) {
  let title = raw.trim(); let priority = 2; let date = d; let timeless = false;
  if (title.startsWith('!')) { priority = 1; title = title.slice(1).trim(); }
  if (/\s+завтра$/i.test(title)) { date = addDays(d, 1); title = title.replace(/\s+завтра$/i, ''); }
  else if (/\s+послезавтра$/i.test(title)) { date = addDays(d, 2); title = title.replace(/\s+послезавтра$/i, ''); }
  else if (/\s+инбокс$/i.test(title)) { date = null; title = title.replace(/\s+инбокс$/i, ''); }
  else if (/\s+бессрочно$/i.test(title)) { date = null; timeless = true; title = title.replace(/\s+бессрочно$/i, ''); }
  return { title, priority, date, timeless };
}

const minutesUntil = (hm) => { const [h, m] = hm.split(':').map(Number); const n = new Date(); return h * 60 + m - (n.getHours() * 60 + n.getMinutes()); };

export async function render(root, { navigate }) {
  const s = db.settings();
  const d = today();
  const hour = new Date().getHours();
  const week = weekDays(d);
  const two = lastNDays(14, d);
  const projName = (id) => (id && db.get('projects', id)?.name) || '';

  // ---------- задачи и фокус ----------
  const tasks = db.all('tasks');
  const mine = tasks.filter(isMine);
  const todayTasks = mine.filter(t => t.date === d && !t.done).sort((a, b) => (a.priority || 2) - (b.priority || 2) || (a.time || '99').localeCompare(b.time || '99'));
  const doneToday = mine.filter(t => t.done && String(t.doneAt || '').slice(0, 10) === d);
  let focus = todayTasks.filter(t => t.focusDate === d);
  const manualFocus = focus.length > 0;
  if (!manualFocus) focus = todayTasks.slice(0, 3);
  focus = focus.slice(0, 3);
  const focusDone = doneToday.filter(t => t.focusDate === d);
  const rest = todayTasks.filter(t => !focus.includes(t));

  // ---------- следующее событие, дедлайны, просрочка ----------
  const next = nextEvent(14);
  const agenda = agendaOn(d);
  const eventsToday = agenda.filter(i => i.type === 'event');
  const waitingToday = agenda.filter(i => i.type === 'waiting' && !i.done);
  const deadlines = upcomingDeadlines(14, 5);
  const overdue = overdueItems();

  // ---------- привычки ----------
  const habits = db.all('habits').filter(h => !h.archived && habitScheduled(h, d)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const hlogs = db.all('habitLogs').filter(l => l.date === d);
  const hst = new Map(habits.map(h => [h.id, habitStatus(h, d, hlogs)]));
  const habitsDoneN = habits.filter(h => hst.get(h.id).done).length;

  // ---------- чек-ин ----------
  const sleep = sleepOn(d);
  const checkin = checkinOn(d);
  const journal = db.all('journal').find(j => j.date === d);
  const checkinFilled = [sleep?.hours, checkin?.energy, checkin?.mood, checkin?.confidence].filter(v => v != null).length;

  // ---------- модули: только используемые ----------
  const meals = db.all('meals').filter(m => m.date === d);
  const dayLog = db.all('dayLogs').find(x => x.date === d);
  const nutritionUsed = moduleOn('nutrition') && (meals.length || dayLog || db.all('meals').some(m => two.includes(m.date)));
  const kcal = sum(meals, m => m.kcal), protein = sum(meals, m => m.protein), water = dayLog?.waterMl || 0;
  const workouts = db.all('workouts');
  const wToday = workouts.filter(w => w.date === d);
  const wWeek = workouts.filter(w => week.includes(w.date)).length;
  const lastW = [...workouts].sort((a, b) => b.date.localeCompare(a.date))[0];
  const workoutsUsed = moduleOn('workouts') && (wToday.length || workouts.some(w => two.includes(w.date)));
  const WTYPE = { strength: 'Силовая', cardio: 'Кардио', mobility: 'Мобильность', other: 'Другое' };
  const projects = moduleOn('projects') ? db.all('projects').filter(p => p.status === 'active').sort((a, b) => (a.priority || 2) - (b.priority || 2) || (a.deadline || '9999').localeCompare(b.deadline || '9999')).slice(0, 3) : [];
  const ceo = ceoPerson();
  const sigSources = moduleOn('signals') ? db.all('signalSources') : [];
  const sigUnread = sigSources.length ? db.all('signalItems').filter(i => !i.read) : [];
  const sigDigest = sigSources.length ? db.all('signalDigests').find(x => x.date === d) : null;
  const sigTop = [...sigUnread].filter(i => !i.dupOf).sort((a, b) => (b.importance === 3 ? 1 : 0) - (a.importance === 3 ? 1 : 0) || String(b.date).localeCompare(String(a.date))).slice(0, 3);
  const sigHot = sigUnread.filter(i => i.importance === 3 && !i.dupOf).length;
  // «Главное» из сводки дня: первые пункты раздела
  const sigMain = (() => { if (!sigDigest) return []; const lines = cleanDigest(sigDigest.text).split('\n').map(l => l.trim()).filter(Boolean); let i = lines.findIndex(l => /главное/i.test(l)); const out = []; for (let k = i < 0 ? 0 : i + 1; k < lines.length && out.length < 5; k++) { const l = lines[k]; if (/^\*\*|^#/.test(l) && out.length) break; const m = l.match(/^(?:[-•*]|\d+[.)])\s+(.*)/); if (m) out.push(m[1].replace(/\*\*/g, '')); } return out; })();
  const chatsOn = moduleOn('chats') && !!tgData();
  const waitAll = chatsOn ? waitingForMe() : [];
  const waitVip = waitAll.filter(w => w.priority > 0);
  const quiet = chatsOn ? quietContacts() : [];
  const sigSrcName = (id) => sigSources.find(s => s.id === id)?.name || '';
  const ceoOpen = moduleOn('shadow') && ceo ? tasks.filter(x => !x.done && x.personId === ceo.id).sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999')).slice(0, 3) : [];
  const goals = db.all('goals').filter(g => g.status === 'active');
  const nearGoals = [...goals].sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999')).slice(0, 3);
  const sessions = db.all('studySessions').filter(x => week.includes(x.date));
  const studyMin = sum(sessions, x => x.minutes);
  const dueCards = db.all('flashcards').filter(c => !c.due || c.due <= d).length;
  const activeItems = db.all('learningItems').filter(i => i.status === 'active').slice(0, 2);
  const learningUsed = moduleOn('learning') && (dueCards || activeItems.length || sessions.length);
  const meds = db.all('medications').filter(m => m.active !== false);
  const medLogs = db.all('medLogs').filter(l => l.date === d);
  const medSlots = meds.flatMap(m => (m.times?.length ? m.times : ['morning']).map(t => ({ m, t })));
  const medsTaken = medSlots.filter(({ m, t }) => medLogs.some(l => l.medId === m.id && l.time === t)).length;
  const healthUsed = moduleOn('health') && medSlots.length > 0;
  const tx = db.all('transactions');
  const spentToday = sum(tx.filter(t => t.type === 'expense' && t.date === d), t => t.amount);
  const spentMonth = sum(tx.filter(t => t.type === 'expense' && String(t.date).slice(0, 7) === monthKey(d)), t => t.amount);
  const financeUsed = moduleOn('finance') && tx.some(t => String(t.date).slice(0, 7) === monthKey(d));

  // ---------- статус одной строкой ----------
  const status = statLine([
    todayTasks.length + doneToday.length ? `задачи <b>${doneToday.length}/${todayTasks.length + doneToday.length}</b>` : '',
    habits.length ? `привычки <b>${habitsDoneN}/${habits.length}</b>` : '',
    sleep ? `сон <b>${fmtNum(sleep.hours, 1)} ч</b>` : '',
    overdue.total ? [`просрочено ${overdue.total}`, 'bad'] : '',
  ]);

  const rate = (name, value, labels) => `<div class="qc-rate" data-rate="${name}" role="radiogroup" aria-label="${esc(labels.join(', '))}">${[1, 2, 3, 4, 5].map(v => `<button type="button" role="radio" aria-checked="${Number(value) === v}" class="${Number(value) === v ? 'active' : ''}" data-v="${v}" title="${labels?.[v - 1] || v}">${v}</button>`).join('')}</div>`;
  const taskRow = (t, { big = false } = {}) => `<div class="list-item ${big ? 'focus-item' : ''}">
      ${checkBtn(!!t.done, `data-task="${esc(t.id)}" aria-label="Выполнено"`)}
      <div class="main" data-task-open="${esc(t.id)}" style="cursor:pointer">
        <div class="title ${t.done ? 'strike' : ''}">${esc(t.title)}</div>
        <div class="sub row wrap" style="gap:6px">${t.time ? `<span class="mono">${esc(t.time)}</span>` : ''}${t.priority === 1 ? '<span class="pill bad">важно</span>' : ''}${t.source === 'ceo' ? '<span class="pill gold">CEO</span>' : t.personId ? `<span class="pill">${esc(personName(t.personId))}</span>` : ''}${t.link?.kind === 'tg' ? `<a class="pill" href="#/chats?chat=${esc(t.link.chat)}" data-stop title="Открыть переписку">${icon('send')} ${esc((t.link.name || 'чат').slice(0, 18))}</a>` : ''}${t.projectId && projName(t.projectId) ? `<span class="pill accent ellipsis" style="max-width:160px">${esc(projName(t.projectId))}</span>` : ''}${t.estimateMin ? `<span>${esc(fmtMinutes(t.estimateMin))}</span>` : ''}</div>
      </div>
      ${big
        ? (t.focusDate === d ? `<button type="button" class="icon-btn sm" data-unfocus="${esc(t.id)}" aria-label="Убрать из фокуса" data-tip="Убрать из фокуса">${icon('x')}</button>` : '')
        : `<button type="button" class="icon-btn sm" data-focus="${esc(t.id)}" aria-label="В фокус дня" data-tip="В фокус дня">${icon('star')}</button>`}
    </div>`;

  const eveningFrom = Number(s.eveningFrom ?? 18);
  const evening = hour >= eveningFrom || journal;
  const nextHtml = (() => {
    if (!next) return `<div class="empty-row"><span>${icon('calendar')} Событий в ближайшие две недели нет</span><button type="button" class="link" data-capture-type="event">+ событие</button></div>`;
    const isToday = next.on === d;
    const mins = isToday && next.time ? minutesUntil(next.time) : null;
    const when = isToday ? (mins == null ? 'сегодня' : mins <= 0 ? 'сейчас' : mins < 60 ? `через ${mins} ${minWord(mins)}` : `в ${next.time}`) : next.on === addDays(d, 1) ? `завтра${next.time ? ' в ' + next.time : ''}` : `${fmtDate(next.on)}${next.time ? ' в ' + next.time : ''}`;
    return `<div class="next-ev" data-go="plan" data-params='${esc(JSON.stringify({ tab: 'week', date: next.on }))}' role="link" tabindex="0">
      <span class="kind-ico event">${icon('calendar')}</span>
      <div class="main"><div class="next-ev-title">${esc(next.title)}</div><div class="tiny muted">${esc(when)}${next.place ? ` · ${esc(next.place)}` : ''}${next.personId ? ` · ${esc(personName(next.personId))}` : ''}</div></div>
      ${eventsToday.length > 1 ? `<span class="tiny faint">ещё ${eventsToday.length - 1} сегодня</span>` : ''}
    </div>`;
  })();

  // ---------- блоки (порядок/видимость настраиваются через меню «•••») ----------
  const blocks = [
    { id: 'next', title: 'Следующее событие', col: 1, html: `<div class="card next-card" data-block="next">${nextHtml}</div>` },
    { id: 'focus', title: 'Фокус дня', col: 1, html: `<div class="card focus-card">
          <div class="section-title"><h2>${icon('target')} Фокус дня</h2><span class="tiny muted">${manualFocus ? 'выбрано вручную' : focus.length ? 'по приоритету · ★ чтобы выбрать свои' : ''}</span></div>
          ${focus.length || focusDone.length
            ? `<div class="list">${focus.map(t => taskRow(t, { big: true })).join('')}${focusDone.map(t => taskRow(t, { big: true })).join('')}</div>`
            : `<div class="empty-row"><span>Фокус дня пока не выбран</span></div>`}
          <form class="row quick-add" id="quickTask" style="gap:8px;margin-top:10px">
            <input class="input grow" name="title" placeholder="Добавить задачу… «!» важная, «завтра», «бессрочно»" autocomplete="off" aria-label="Новая задача">
            <button class="icon-btn primary" type="submit" aria-label="Добавить">${icon('plus')}</button>
          </form>
          ${rest.length ? `<button type="button" class="link" data-toggle-rest style="margin-top:10px">${showRest ? 'Скрыть' : `Ещё ${rest.length} ${plural(rest.length, 'задача', 'задачи', 'задач')} на сегодня`}</button>
            ${showRest ? `<div class="list" style="margin-top:4px">${rest.map(t => taskRow(t)).join('')}</div>` : ''}` : ''}
          ${waitingToday.length ? `<div class="tiny muted" style="margin-top:8px">${icon('clock')} жду от других сегодня: ${waitingToday.map(w => esc(w.title) + (w.personId ? ` (${esc(personName(w.personId))})` : '')).join(', ')}</div>` : ''}
          ${doneToday.filter(t => t.focusDate !== d).length ? `<div class="tiny faint" style="margin-top:8px">${icon('check')} сделано сегодня: ${doneToday.filter(t => t.focusDate !== d).length}</div>` : ''}
        </div>` },
    { id: 'habits', title: 'Привычки', col: 1, html: `<div class="card">
          <div class="section-title"><h2>${icon('repeat')} Привычки</h2><span class="row tiny muted" style="gap:10px">${habits.length ? `${habitsDoneN}/${habits.length}` : ''}<button type="button" class="link" data-habit-add>+ привычка</button>${habits.length ? `<button type="button" class="link" data-habit-edit>${habitsEdit ? 'готово' : 'изменить'}</button>` : ''}</span></div>
          ${habits.length ? `<div class="habit-row ${habitsEdit ? 'editing' : ''}">${habits.map(h => { const st = hst.get(h.id); return `<button type="button" class="habit-chip ${st.done ? 'done' : ''} ${st.auto ? 'auto' : ''}" data-habit="${esc(h.id)}" aria-pressed="${st.done}" title="${st.auto ? esc(st.auto.text) : ''}"><span class="hc-icon">${esc(h.icon || '✓')}</span><span class="hc-name">${esc(h.name)}</span>${st.target > 1 && !st.auto ? `<span class="hc-cnt">${st.count}/${st.target}</span>` : ''}${st.auto ? `<span class="hc-cnt">${st.auto.done ? 'из данных' : esc(st.auto.text)}</span>` : ''}${habitsEdit ? `<span class="hc-x" data-habit-remove="${esc(h.id)}" title="Убрать (в архив)">${icon('x')}</span>` : ''}</button>`; }).join('')}</div>` : '<div class="empty-row"><span>Привычек на сегодня нет</span></div>'}
          ${habitsEdit ? '<div class="tiny faint" style="margin-top:8px">Тап по привычке открывает её настройки, крестик убирает в архив.</div>' : ''}
        </div>` },
    { id: 'checkin', title: 'Чек-ин', col: 1, html: `<div class="card qc">
          <div class="row between" style="gap:10px;flex-wrap:wrap">
            <div class="row" style="gap:12px;flex-wrap:wrap"><h2 class="qc-title">${icon('heart')} Как вы сегодня?</h2>${checkinOpen ? '' : rate('mood', checkin?.mood, ['плохо', 'так себе', 'ровно', 'хорошо', 'отлично'])}</div>
            <button type="button" class="link" data-checkin-toggle>${checkinOpen ? 'свернуть' : checkinFilled ? `подробнее · ${checkinFilled}/4` : 'подробнее'}</button>
          </div>
          ${checkinOpen ? `<div class="qc-grid" style="margin-top:10px">
            <div><div class="label caps">Сон, часов</div><div class="qc-rate" data-sleep>${[5, 6, 7, 8, 9].map(v => `<button type="button" class="${sleep && Math.round(sleep.hours) === v ? 'active' : ''}" data-v="${v}">${v}</button>`).join('')}${sleep && ![5, 6, 7, 8, 9].includes(Math.round(sleep.hours)) ? `<span class="tiny muted">${fmtNum(sleep.hours, 1)}</span>` : ''}</div></div>
            <div><div class="label caps">Энергия</div>${rate('energy', checkin?.energy, ['нет сил', 'мало', 'нормально', 'хорошо', 'много'])}</div>
            <div><div class="label caps">Настроение</div>${rate('mood', checkin?.mood, ['плохо', 'так себе', 'ровно', 'хорошо', 'отлично'])}</div>
            <div><div class="label caps">Уверенность</div>${rate('confidence', checkin?.confidence, ['совсем нет', 'шатко', 'нормально', 'уверенно', 'очень'])}</div>
          </div>
          <input class="input" data-checkin-note placeholder="Заметка о самочувствии (необязательно)" value="${esc(checkin?.notes || '')}" style="margin-top:10px" aria-label="Заметка о самочувствии">` : ''}
        </div>` },
    { id: 'whoop', title: 'WHOOP', col: 1, html: (() => { const w = whoopOn(d); if (!w || (w.recovery == null && w.sleepHours == null)) return ''; return `<div class="card">
          <div class="section-title"><h2>${icon('activity')} WHOOP</h2><button type="button" class="link" data-go="sleep">подробнее</button></div>
          <div class="row wrap" style="gap:16px">
            ${w.recovery != null ? `<div><div class="label">Recovery</div><div class="value ${recoveryClass(w.recovery)}" style="font-size:22px">${Math.round(w.recovery)}%</div><div class="tiny muted">${recoveryWord(w.recovery)}</div></div>` : ''}
            ${w.sleepHours != null ? `<div><div class="label">Сон</div><div class="value" style="font-size:22px">${fmtNum(w.sleepHours, 1)}<small> ч</small></div>${w.performance != null ? `<div class="tiny muted">${Math.round(w.performance)}% от нормы</div>` : ''}</div>` : ''}
            ${w.hrv != null ? `<div><div class="label">HRV</div><div class="value" style="font-size:22px">${Math.round(w.hrv)}</div></div>` : ''}
            ${w.rhr != null ? `<div><div class="label">Пульс покоя</div><div class="value" style="font-size:22px">${Math.round(w.rhr)}</div></div>` : ''}
            ${w.strain != null ? `<div><div class="label">Нагрузка</div><div class="value" style="font-size:22px">${fmtNum(w.strain, 1)}</div></div>` : ''}
          </div>
        </div>`; })() },
    { id: 'advice', title: 'Совет помощника', col: 2, html: aiReady() ? (() => { const a = loadAdvice(d); return `<div class="card advice-card">
          <div class="section-title"><h2>${icon('zap')} Совет на сегодня</h2><span class="row tiny muted" style="gap:8px">${aiProvider() === 'ollama' ? 'локальная модель' : 'Claude'}${a ? `<button type="button" class="link" data-advice-refresh>обновить</button>` : ''}</span></div>
          ${a ? `<div class="small advice-text">${esc(a.text)}</div>` : adviceBusy ? '<div class="small muted">Думаю над вашими данными…</div>' : `<div class="empty-row"><span>Помощник посмотрит задачи, события и самочувствие и предложит, с чего начать.</span><button type="button" class="btn sm" data-advice-refresh>${icon('zap')} Получить совет</button></div>`}
        </div>`; })() : '' },
    { id: 'signals', title: 'Сигналы', col: 2, html: sigSources.length ? `<div class="card">
          <div class="section-title"><h2>${icon('rss')} Сигналы</h2><button type="button" class="link" data-go="signals" data-params='{"tab":"${sigDigest ? 'digest' : 'feed'}"}'>${sigDigest ? 'сводка' : sigUnread.length ? `${sigUnread.length} ${plural(sigUnread.length, 'новая', 'новые', 'новых')}` : 'открыть'}</button></div>
          ${sigDigest && sigMain.length ? `<div class="tiny muted" style="margin-bottom:4px">Главное за день</div><ul class="sg-today-main">${sigMain.map(l => `<li>${esc(l)}</li>`).join('')}</ul>${sigUnread.length ? `<div class="tiny muted" style="margin-top:6px">непрочитано ${sigUnread.length}${sigHot ? ` · важных ${sigHot}` : ''}</div>` : ''}`
            : sigDigest ? `<div class="small" style="white-space:pre-wrap;line-height:1.5">${esc(sigDigest.text.replace(/\*\*/g, '').split('\n').map(l => l.trim().replace(/^[-•*]\s+/, '· ')).filter(Boolean).slice(0, 4).join('\n'))}</div>`
            : sigTop.length ? `<div class="sg-today-list">${sigTop.map(i => `<div class="sg-today-item"><span class="sg-src">${esc(sigSrcName(i.sourceId))}</span><span class="ellipsis">${esc(i.title)}</span></div>`).join('')}</div>${sigUnread.length > 3 ? `<div class="tiny muted" style="margin-top:6px">и ещё ${sigUnread.length - 3}</div>` : ''}`
            : '<div class="small muted">Новых записей нет</div>'}
        </div>` : '' },
    { id: 'chats', title: 'Чаты', col: 2, html: chatsOn && (waitAll.length || quiet.length) ? `<div class="card">
          <div class="section-title"><h2>${icon('send')} Чаты</h2><button type="button" class="link" data-go="chats" data-params='{"tab":"waiting"}'>${waitAll.length ? `ждут ответа ${waitAll.length}` : 'открыть'}</button></div>
          ${waitVip.length ? `<div class="tiny muted" style="margin-bottom:4px">Важные люди ждут ответа</div><div class="tg-today-list">${waitVip.slice(0, 4).map(w => `<div class="row between"><span class="ellipsis"><b>${esc(w.chat.name)}</b> <span class="muted">${esc(w.msg.text.slice(0, 70))}</span></span><span class="tiny warn" style="white-space:nowrap">${w.hours < 24 ? `${Math.round(w.hours)} ч` : `${Math.round(w.hours / 24)} ${dayWord(Math.round(w.hours / 24))}`}</span></div>`).join('')}</div>` : ''}
          ${waitAll.length - waitVip.length ? `<div class="tiny muted" style="margin-top:${waitVip.length ? 8 : 0}px">${waitVip.length ? 'Ещё ждут' : 'Ждут ответа'}: ${esc(waitAll.filter(w => !(w.priority > 0)).slice(0, 4).map(w => w.chat.name).join(', '))}${waitAll.length - waitVip.length > 4 ? ` и ещё ${waitAll.length - waitVip.length - 4}` : ''}</div>` : ''}
          ${quiet.length ? `<div class="tiny muted" style="margin-top:8px">Давно не общались: ${quiet.slice(0, 3).map(q => `${chatLink(q.chat) ? `<a href="${esc(chatLink(q.chat))}" target="_blank" rel="noopener" data-stop>${esc(q.chat.name)}</a>` : esc(q.chat.name)} (${q.days} ${dayWord(q.days)})`).join(', ')}</div>` : ''}
        </div>` : '' },
    { id: 'attention', title: 'Требует внимания', col: 2, html: (deadlines.length || overdue.total) ? `<div class="card">
          <div class="section-title"><h2>${icon('clock')} Требует внимания</h2>${overdue.total ? `<span class="pill bad">просрочено ${overdue.total}</span>` : ''}</div>
          ${overdue.tasks.length ? `<div class="tiny bad" style="margin-bottom:8px">${icon('clock')} Просрочено задач: ${overdue.tasks.length} · <button type="button" class="link" data-go="plan" data-params='{"tab":"all"}'>разобрать</button></div>` : ''}
          ${overdue.waiting.length ? `<div class="tiny warn" style="margin-bottom:8px">${icon('clock')} Просрочено ожиданий от других: ${overdue.waiting.length}</div>` : ''}
          ${deadlines.length ? `<div class="stack tight">${deadlines.map(u => { const n = daysBetween(d, u.date); return `<div class="row between next-item" data-go="${esc(u.page)}" ${u.params ? `data-params='${esc(JSON.stringify(u.params))}'` : ''} role="link" tabindex="0">
              <div class="main"><div class="small ellipsis">${esc(u.title)}</div><div class="tiny muted">${esc(u.kind)}</div></div>
              <div class="tiny ${n <= 1 ? 'warn bold' : 'muted'}" style="white-space:nowrap">${n === 0 ? 'сегодня' : n === 1 ? 'завтра' : `через ${n} ${dayWord(n)}`}</div>
            </div>`; }).join('')}</div>` : ''}
        </div>` : '' },
    { id: 'reflect', title: 'Вечерняя рефлексия', col: 2, html: evening ? `<div class="card reflect">
          <div class="section-title"><h2>${icon('moon')} Вечерняя рефлексия</h2><button type="button" class="link" data-go="journal">${journal ? 'открыть дневник' : 'подробнее'}</button></div>
          <form id="reflectForm" class="form">
            <div class="field"><label for="rf-h">Главное событие дня</label><input id="rf-h" name="highlight" class="input" value="${esc(journal?.highlight || '')}" placeholder="Одной строкой"></div>
            <div class="form-row">
              <div class="field"><label for="rf-w">Что получилось</label><textarea id="rf-w" name="wentWell" rows="2">${esc(journal?.wentWell || '')}</textarea></div>
              <div class="field"><label for="rf-i">Что улучшить</label><textarea id="rf-i" name="improve" rows="2">${esc(journal?.improve || '')}</textarea></div>
            </div>
            <div class="row between wrap" style="gap:8px"><span class="tiny faint">${journal ? 'сохранено' : ''}</span><button class="btn sm" type="submit">${icon('check')} Сохранить</button></div>
          </form>
        </div>` : '' },
    { id: 'schedule', title: 'Расписание на сегодня', col: 2, html: eventsToday.length > 1 ? `<div class="card">
          <div class="section-title"><h2>${icon('clock')} Сегодня по часам</h2><button type="button" class="link" data-go="plan" data-params='{"tab":"week"}'>календарь</button></div>
          <div class="list">${eventsToday.map(ev => `<div class="list-item" style="padding:7px 0;${ev.time && ev.time < nowHM() && (!ev.end || ev.end < nowHM()) ? 'opacity:.55' : ''}"><span class="mono tiny" style="min-width:44px">${esc(ev.time || '—')}</span><div class="main"><div class="title small">${esc(ev.title)}</div>${ev.place ? `<div class="sub">${esc(ev.place)}</div>` : ''}</div></div>`).join('')}</div>
        </div>` : '' },
    { id: 'shadow', title: 'Shadow: задачи с CEO', col: 2, html: ceoOpen.length ? `<div class="card">
          <div class="section-title"><h2>${icon('briefcase')} Shadow</h2><button type="button" class="link" data-go="shadow">открыть</button></div>
          <div class="list">${ceoOpen.map(x => `<div class="list-item" style="padding:7px 0">${checkBtn(false, `data-task="${esc(x.id)}" aria-label="Выполнено"`)}<div class="main" data-task-open="${esc(x.id)}" style="cursor:pointer"><div class="title small">${esc(x.title)}</div>${x.direction === 'theirs' ? '<div class="sub">жду от него</div>' : ''}</div>${x.date ? `<span class="tiny ${x.date < d ? 'bad' : 'muted'}">${esc(fmtDate(x.date))}</span>` : ''}</div>`).join('')}</div>
        </div>` : '' },
    { id: 'projects', title: 'Проекты', col: 2, html: projects.length ? `<div class="card">
          <div class="section-title"><h2>${icon('layers')} Проекты</h2><button type="button" class="link" data-go="projects">все</button></div>
          <div class="stack tight">${projects.map(p => { const pct = projectProgress(p); return `<div class="proj-mini" data-go="projects" data-params='${esc(JSON.stringify({ id: p.id }))}' role="link" tabindex="0">
            <div class="row between"><span class="bold small ellipsis">${esc(p.name)}</span><span class="tiny mono muted">${pct}%</span></div>
            ${progressBar(pct, 100, 'thin')}
            ${p.nextStep ? `<div class="tiny muted ellipsis" style="margin-top:4px">${icon('zap')} ${esc(p.nextStep)}</div>` : ''}
          </div>`; }).join('')}</div>
        </div>` : '' },
    { id: 'goals', title: 'Цели', col: 2, html: nearGoals.length ? `<div class="card">
          <div class="section-title"><h2>${icon('target')} Цели</h2><button type="button" class="link" data-go="plan" data-params='{"tab":"goals"}'>все</button></div>
          <div class="stack tight">${nearGoals.map(g => { const p = goalProgress(g); const left = g.deadline ? daysBetween(d, g.deadline) : null; return `<div><div class="row between"><div class="bold small ellipsis">${esc(g.title)}</div><div class="tiny ${left != null && left < 0 ? 'bad' : 'muted'}">${left == null ? '' : left < 0 ? `просрочено на ${-left} ${dayWord(-left)} · ` : left === 0 ? 'сегодня · ' : `${left} ${dayWord(left)} · `}${p}%</div></div>${progressBar(p, 100, 'thin')}</div>`; }).join('')}</div>
        </div>` : '' },
    { id: 'nutrition', title: 'Питание', col: 2, html: nutritionUsed ? `<div class="card">
          <div class="section-title"><h2>${icon('utensils')} Питание</h2><button type="button" class="link" data-go="nutrition">добавить</button></div>
          <div class="row wrap" style="gap:12px">
            <div><div class="label">Калории</div><div class="value" style="font-size:20px">${fmtNum(kcal)}<small>/ ${s.kcalTarget}</small></div></div>
            <div><div class="label">Белок</div><div class="value" style="font-size:20px">${fmtNum(protein)}<small>/ ${s.proteinTarget} г</small></div></div>
            <div class="grow"><div class="label">Вода</div><div class="row" style="gap:6px"><span class="value" style="font-size:20px">${fmtNum(water)}<small>/ ${s.waterTarget}</small></span><button type="button" class="btn secondary sm" data-water="250">+250</button><button type="button" class="btn secondary sm" data-water="500">+500</button></div></div>
          </div>
        </div>` : '' },
    { id: 'workouts', title: 'Тренировка', col: 2, html: workoutsUsed ? `<div class="card">
          <div class="section-title"><h2>${icon('dumbbell')} Тренировка</h2><button type="button" class="link" data-go="workouts">${wToday.length ? 'открыть' : 'записать'}</button></div>
          ${wToday.length ? wToday.map(w => `<div class="row between"><div><div class="bold small">${esc(w.title || 'Тренировка')}</div><div class="tiny muted">${esc(WTYPE[w.type] || w.type)} · ${fmtMinutes(w.durationMin)}</div></div><span class="pill good">${icon('check')} сегодня</span></div>`).join('')
            : `<div class="row between"><div class="small muted">${lastW ? `Последняя: ${esc(lastW.title || WTYPE[lastW.type] || lastW.type)} · ${esc(fmtDate(lastW.date))}` : 'Ещё нет тренировок'}</div><span class="pill">${wWeek} на неделе</span></div>`}
        </div>` : '' },
    { id: 'learning', title: 'Обучение', col: 2, html: learningUsed ? `<div class="card">
          <div class="section-title"><h2>${icon('brain')} Обучение</h2><button type="button" class="link" data-go="learning">открыть</button></div>
          <div class="stack tight small">
            <div class="row between"><span class="muted">За неделю</span><span class="mono">${fmtMinutes(studyMin)} / ${fmtMinutes(s.learningWeeklyMinutes)}</span></div>
            ${dueCards ? `<div class="row between"><span>${icon('layers')} Карточек к повторению: ${dueCards}</span><button type="button" class="btn sm" data-go="learning">Повторить</button></div>` : ''}
            ${activeItems.map(i => `<div class="row between"><span class="ellipsis">${icon('book')} ${esc(i.title)}</span><span class="tiny muted">${i.progress || 0}%</span></div>`).join('')}
          </div>
        </div>` : '' },
    { id: 'health', title: 'Лекарства', col: 2, html: healthUsed ? `<div class="card">
          <div class="section-title"><h2>${icon('pill')} Лекарства</h2><button type="button" class="link" data-go="health">открыть</button></div>
          <div class="row between"><span class="small muted">Принято сегодня</span><span class="pill ${medsTaken === medSlots.length ? 'good' : ''}">${medsTaken}/${medSlots.length}</span></div>
        </div>` : '' },
    { id: 'finance', title: 'Финансы', col: 2, html: financeUsed ? `<div class="card">
          <div class="section-title"><h2>${icon('wallet')} Финансы</h2><button type="button" class="link" data-go="finance">добавить</button></div>
          <div class="row between"><div><div class="label">Сегодня</div><div class="value" style="font-size:20px">${fmtMoney(spentToday, s.currency)}</div></div><div style="text-align:right"><div class="label">За месяц</div><div class="value" style="font-size:20px">${fmtMoney(spentMonth, s.currency)}</div></div></div>
        </div>` : '' },
  ];

  root.innerHTML = `<div>
    <div class="page-head">
      <div>
        <div class="eyebrow">${esc(fmtDateLong(d))}</div>
        <h1>${esc(greetingFor())}</h1>
        ${quoteHtml(dailyQuote(), esc)}
        ${status}
      </div>
      <div class="actions">
        <button class="btn" data-capture>${icon('plus')} Записать</button>
        ${pageMenu([{ label: 'Дневник', action: 'go-journal', icon: 'pen' }, { label: 'План на день', action: 'go-plan', icon: 'calendar' }, { label: 'Настроить страницу', action: 'customize', icon: 'sliders' }])}
      </div>
    </div>
    ${composeBlocks('today', blocks)}
  </div>`;
  const view = root.firstElementChild;
  bindCustomize(view, 'today', blocks);

  // ---------- события ----------
  on(view, 'click', '[data-action="go-journal"]', () => navigate('journal'));
  on(view, 'click', '[data-advice-refresh]', async () => {
    if (adviceBusy) return;
    adviceBusy = true; render(root, { navigate });
    try {
      const text = await askOnce('Дай один короткий совет на сегодня (3–5 строк, без заголовков и списков): с чего начать день и что не упустить, с опорой на мои задачи, события, просрочку и самочувствие.', { pageId: 'today' });
      saveAdvice(d, text || 'Сегодня всё под контролем: начните с фокуса дня.');
    } catch (e) { toast('Совет не получен: ' + (e.message || e)); }
    finally { adviceBusy = false; render(root, { navigate }); }
  });
  on(view, 'click', '[data-action="go-plan"]', () => navigate('plan'));
  on(view, 'click', '[data-capture-type]', (e, t) => { e.stopPropagation(); openCapture({ pageId: 'today', type: t.dataset.captureType }); });
  on(view, 'click', '[data-go]', (e, t) => {
    if (e.target.closest('[data-task],[data-task-open],[data-habit],[data-water],[data-focus],[data-unfocus],[data-capture-type],[data-stop]')) return;
    let params = {}; try { params = t.dataset.params ? JSON.parse(t.dataset.params) : {}; } catch {}
    navigate(t.dataset.go, params);
  });
  on(view, 'keydown', '[data-go][role=link]', (e, t) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); t.click(); } });
  on(view, 'click', '[data-task]', (e, t) => {
    const task = db.get('tasks', t.dataset.task); if (!task) return;
    toggleTask(task.id);
    if (!task.done) { const c = cheer(); if (c && Math.random() < 0.6) toast(c, 1800); }
  });
  on(view, 'click', '[data-stop]', (e) => e.stopPropagation());
  on(view, 'click', '[data-task-open]', async (e, t) => { if (e.target.closest('[data-stop]')) return; const task = db.get('tasks', t.dataset.taskOpen); if (!task) return; const m = await import('./task-modal.js'); m.openTaskModal(task); });
  on(view, 'click', '[data-focus]', (e, t) => {
    const n = mine.filter(x => x.focusDate === d && !x.done).length;
    if (n >= 3) { toast('В фокусе уже три задачи — уберите одну'); return; }
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
    const st = habitStatus(h, d);
    if (st.auto) { toast(st.auto.done ? 'Выполнено автоматически: ' + st.auto.text : 'Считается из данных: ' + st.auto.text, 2200); return; }
    const nextV = st.manual >= st.target ? 0 : st.target > 1 ? st.manual + 1 : st.target;
    setHabitCount(h.id, d, nextV);
    if (nextV >= st.target) { const c = habitCheer(); if (c && Math.random() < 0.5) toast(c, 1800); }
  });
  on(view, 'click', '[data-water]', (e, t) => addWater(Number(t.dataset.water), d));
  on(view, 'click', '[data-sleep] button', (e, b) => { const hours = Number(b.dataset.v); setSleepHours(d, hours); toast(`Сон: ${hours} ч`); });
  on(view, 'click', '[data-rate] button', (e, b) => { const name = b.closest('[data-rate]').dataset.rate; setCheckin(d, { [name]: Number(b.dataset.v) }); });
  on(view, 'click', '[data-checkin-toggle]', () => { checkinOpen = !checkinOpen; render(root, { navigate }); });
  const note = view.querySelector('[data-checkin-note]');
  if (note) note.addEventListener('change', () => setCheckin(d, { notes: note.value.trim() }));
  view.querySelector('#quickTask')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const { title: tt, priority, date, timeless } = parseQuick(e.target.title.value, d);
    if (!tt) return;
    addTask({ title: tt, date, priority, timeless });
    e.target.reset();
    toast(date === d ? 'Задача на сегодня добавлена' : date ? `Задача на ${fmtDate(date)}` : timeless ? 'Бессрочная задача добавлена' : 'Задача в инбоксе');
  });
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
