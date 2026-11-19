// Глобальная кнопка «+»: одно окно для любой записи. Сначала текст, потом тип и детали.
// Тип угадывается по тексту (время → событие, сумма → расход, «выпила 500» → активность),
// контекст — по открытому разделу (Shadow → задача от CEO, карточка человека → с этим человеком,
// проект → в проект). Сохраняет в общие модели (model.js), так что запись сразу видна везде.
import { db } from './db.js';
import { esc, icon, el, toast, today, addDays, fmtDate } from './ui.js';
import { addTask, addNote, addTransaction, addWater, addSteps, setSleepHours, ceoPerson, NOTE_TYPES } from './model.js';

const TYPES = [
  ['task', 'Задача', 'check'],
  ['event', 'Событие', 'calendar'],
  ['note', 'Заметка', 'pen'],
  ['money', 'Расход / доход', 'wallet'],
  ['activity', 'Активность', 'activity'],
];
const WD = { пн: 0, вт: 1, ср: 2, чт: 3, пт: 4, сб: 5, вс: 6, понедельник: 0, вторник: 1, среда: 2, среду: 2, четверг: 3, пятница: 4, пятницу: 4, суббота: 5, субботу: 5, воскресенье: 6 };
const RU_MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
let open = false;

// ---------- разбор текста ----------
function parseDate(text, base = today()) {
  let t = text, date = null;
  const rep = (re, d) => { if (re.test(t)) { date = d; t = t.replace(re, ' '); } };
  rep(/(^|\s)послезавтра(?=\s|$)/i, addDays(base, 2));
  if (!date) rep(/(^|\s)завтра(?=\s|$)/i, addDays(base, 1));
  if (!date) rep(/(^|\s)сегодня(?=\s|$)/i, base);
  if (!date) {
    const m = t.match(/(^|\s)(?:в|во)\s+(пн|вт|ср|чт|пт|сб|вс|понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)(?=\s|$)/i);
    if (m) { const want = WD[m[2].toLowerCase()]; const cur = (new Date(base + 'T00:00').getDay() + 6) % 7; let diff = (want - cur + 7) % 7; if (diff === 0) diff = 7; date = addDays(base, diff); t = t.replace(m[0], ' '); }
  }
  if (!date) {
    const m = t.match(/(^|\s)(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?=\s|$)/);
    if (m) { const y = m[4] ? (m[4].length === 2 ? '20' + m[4] : m[4]) : base.slice(0, 4); date = `${y}-${m[3].padStart(2, '0')}-${m[2].padStart(2, '0')}`; t = t.replace(m[0], ' '); }
  }
  if (!date) {
    const m = t.match(/(^|\s)(\d{1,2})\s+(янв|фев|мар|апр|мая|май|июн|июл|авг|сен|окт|ноя|дек)[а-я]*(?=\s|$)/i);
    if (m) { const mi = RU_MONTHS.indexOf(m[3].toLowerCase().slice(0, 3).replace('май', 'мая')); if (mi >= 0) { date = `${base.slice(0, 4)}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`; t = t.replace(m[0], ' '); } }
  }
  return { text: t.replace(/\s{2,}/g, ' ').trim(), date };
}
function parseTime(text) {
  const m = text.match(/(^|\s)(?:в\s+)?(\d{1,2})[:.](\d{2})(?=\s|$)/);
  if (!m) return { text, time: '' };
  const hh = Number(m[2]), mm = Number(m[3]);
  if (hh > 23 || mm > 59) return { text, time: '' };
  return { text: text.replace(m[0], ' ').replace(/\s{2,}/g, ' ').trim(), time: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` };
}
function parseMoney(text) {
  const m = text.match(/(^|\s)([+-]?)(\d[\d\s]*(?:[.,]\d+)?)\s*(₽|руб\.?|р\.?|\$|€|usd|eur)?(?=\s|$)/i);
  if (!m) return null;
  const amount = Number(m[3].replace(/\s/g, '').replace(',', '.'));
  if (!amount) return null;
  const income = m[2] === '+' || /доход|зарплат|получил|пришл|премия|вернул/i.test(text);
  return { amount, income, rest: text.replace(m[0], ' ').replace(/\s{2,}/g, ' ').trim() };
}
function guessType(text) {
  const s = text.toLowerCase();
  if (/(^|\s)(выпил|вода|воды|шаг|тренир|бег|пробеж|йога|зал|спал|сон\s|занимал|урок|занятие)/.test(s)) return 'activity';
  if (/(^|\s)(потратил|купил|оплатил|расход|доход|зарплат|руб|₽)/.test(s) || /\d+\s*(₽|руб)/.test(s)) return 'money';
  if (/\d{1,2}[:.]\d{2}/.test(s) || /(^|\s)(встреча|созвон|звонок|планёрка|планерка|презентац|собес)/.test(s)) return 'event';
  if (/(^|\s)(идея|заметка|мысль|запомнить|инсайт|совет|рекомендац)/.test(s)) return 'note';
  return 'task';
}
function guessActivity(text) {
  const s = text.toLowerCase();
  if (/выпил|вода|воды|мл|литр/.test(s)) return 'water';
  if (/шаг/.test(s)) return 'steps';
  if (/спал|сон/.test(s)) return 'sleep';
  if (/занимал|урок|занятие|учил|английск|курс/.test(s)) return 'study';
  return 'workout';
}
const firstNumber = (text) => { const m = text.match(/(\d+(?:[.,]\d+)?)/); return m ? Number(m[1].replace(',', '.')) : null; };

// ---------- контекст раздела ----------
function contextOf({ pageId, params }) {
  const ctx = { personId: null, projectId: null, date: null, type: null, source: 'manual', noteType: 'note' };
  if (pageId === 'shadow') { const c = ceoPerson(); if (c) { ctx.personId = c.id; ctx.source = 'ceo'; } }
  if (pageId === 'people' && params?.id && db.get('people', params.id)) ctx.personId = params.id;
  if (pageId === 'projects' && params?.id && db.get('projects', params.id)) { ctx.projectId = params.id; ctx.source = 'project'; }
  if (pageId === 'plan' && params?.date) ctx.date = params.date;
  if (pageId === 'finance') ctx.type = 'money';
  if (pageId === 'notes' || pageId === 'kb') ctx.type = 'note';
  if (pageId === 'journal') { ctx.type = 'note'; ctx.noteType = 'insight'; }
  if (['habits', 'workouts', 'nutrition', 'sleep', 'health'].includes(pageId)) ctx.type = 'activity';
  return ctx;
}

// ---------- окно ----------
export function openCapture({ pageId = 'today', params = {}, type = null, text = '' } = {}) {
  if (open) return; open = true;
  const ctx = contextOf({ pageId, params });
  let curType = type || ctx.type || null;      // null = угадывать по тексту
  let details = false;
  const people = db.all('people').map(p => [p.id, p.name]);
  const projects = db.all('projects').filter(p => p.status !== 'done').map(p => [p.id, p.name]);
  const person = ctx.personId ? db.get('people', ctx.personId) : null;
  const project = ctx.projectId ? db.get('projects', ctx.projectId) : null;

  const wrap = el(`<div class="cap-backdrop" role="dialog" aria-modal="true" aria-label="Записать">
    <div class="cap">
      <div class="cap-head"><b>Записать</b>${person || project ? `<span class="tag">${esc(person ? person.name : project.name)}</span>` : ''}<button type="button" class="icon-btn sm" data-close aria-label="Закрыть">${icon('x')}</button></div>
      <textarea class="cap-input" rows="2" placeholder="Что записать? Например: «Отчёт CEO завтра», «Созвон 15:30», «Кофе 350 ₽», «Выпила 500 мл»" aria-label="Текст записи"></textarea>
      <div class="cap-types" role="radiogroup" aria-label="Тип записи"></div>
      <div class="cap-details" hidden></div>
      <div class="cap-foot">
        <button type="button" class="link" data-details>${icon('sliders')} Подробнее</button>
        <span class="cap-hint tiny faint"></span>
        <button type="button" class="btn" data-save>${icon('check')} Сохранить</button>
      </div>
    </div></div>`);
  const input = wrap.querySelector('.cap-input'), typesEl = wrap.querySelector('.cap-types'), detEl = wrap.querySelector('.cap-details'), hint = wrap.querySelector('.cap-hint');
  input.value = text;

  const effType = () => curType || guessType(input.value);
  const drawTypes = () => {
    const t = effType();
    typesEl.innerHTML = TYPES.map(([v, l, ic]) => `<button type="button" role="radio" aria-checked="${v === t}" class="chip ${v === t ? 'active' : ''}" data-type="${v}">${icon(ic)} ${l}</button>`).join('');
    drawHint();
  };
  const drawHint = () => {
    const t = effType(); const v = input.value.trim();
    if (!v) { hint.textContent = curType ? '' : 'тип подбирается по тексту'; return; }
    if (t === 'task') { const { date } = parseDate(v); const money = null; hint.textContent = [date ? fmtDate(date) : (ctx.date ? fmtDate(ctx.date) : 'сегодня'), person ? person.name : '', project ? project.name : ''].filter(Boolean).join(' · '); }
    else if (t === 'event') { const { date } = parseDate(v); const { time } = parseTime(v); hint.textContent = `${date ? fmtDate(date) : 'сегодня'}${time ? ' · ' + time : ' · без времени'}`; }
    else if (t === 'money') { const m = parseMoney(v); hint.textContent = m ? `${m.income ? 'доход' : 'расход'} ${m.amount} ${db.settings().currency || '₽'}` : 'укажите сумму'; }
    else if (t === 'activity') { const a = guessActivity(v); const n = firstNumber(v); hint.textContent = { water: `вода ${n || 250} мл`, steps: `шаги ${n || 0}`, sleep: `сон ${n || 8} ч`, study: `занятие ${n || 30} мин`, workout: `тренировка ${n || 45} мин` }[a]; }
    else hint.textContent = NOTE_TYPES[detEl.querySelector('[name=noteType]')?.value || ctx.noteType] || 'заметка';
  };
  const sel = (name, label, options, value) => `<label class="field"><span>${esc(label)}</span><select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  const inp = (name, label, type = 'text', value = '', extra = '') => `<label class="field"><span>${esc(label)}</span><input type="${type}" name="${name}" value="${esc(value)}" ${extra}></label>`;
  const drawDetails = () => {
    const t = effType();
    let h = '';
    if (t === 'task') h = `<div class="form-row">${inp('date', 'Дата', 'date', ctx.date || '')}${inp('time', 'Время', 'time')}${sel('priority', 'Приоритет', [[1, 'Важная'], [2, 'Обычная'], [3, 'Низкая']], 2)}</div>
      <div class="form-row">${sel('personId', 'Человек', [['', '—'], ...people], ctx.personId || '')}${sel('projectId', 'Проект', [['', '—'], ...projects], ctx.projectId || '')}${sel('direction', 'Кто делает', [['mine', 'Я'], ['theirs', 'Другой человек (жду)']], 'mine')}</div>
      <label class="row" style="gap:8px"><input type="checkbox" name="timeless"> Бессрочно, без срока</label>`;
    else if (t === 'event') h = `<div class="form-row">${inp('date', 'Дата', 'date', ctx.date || today())}${inp('time', 'Начало', 'time')}${inp('endTime', 'Конец', 'time')}</div>
      <div class="form-row">${sel('kind', 'Тип', [['meeting', 'Встреча'], ['work', 'Работа'], ['personal', 'Личное'], ['health', 'Здоровье'], ['other', 'Другое']], 'meeting')}${sel('personId', 'С кем', [['', '—'], ...people], ctx.personId || '')}${sel('repeat', 'Повтор', [['none', 'Нет'], ['daily', 'Каждый день'], ['weekdays', 'По будням'], ['weekly', 'Каждую неделю'], ['monthly', 'Каждый месяц']], 'none')}</div>
      ${inp('place', 'Где / ссылка')}`;
    else if (t === 'note') h = `<div class="form-row">${sel('noteType', 'Тип', [['note', 'Заметка'], ['idea', 'Идея'], ['recommendation', 'Рекомендация'], ['meeting', 'Итог встречи'], ['insight', 'Инсайт']], ctx.noteType)}${inp('date', 'Дата', 'date', today())}</div>
      <div class="form-row">${sel('personId', 'Человек', [['', '—'], ...people], ctx.personId || '')}${sel('projectId', 'Проект', [['', '—'], ...projects], ctx.projectId || '')}</div>
      ${inp('tags', 'Теги', 'text', '', 'placeholder="через запятую"')}
      <label class="row" style="gap:8px"><input type="checkbox" name="quote"> Показывать как цитату (при включённых посланиях)</label>`;
    else if (t === 'money') h = `<div class="form-row">${sel('mtype', 'Что это', [['expense', 'Расход'], ['income', 'Доход']], 'expense')}${inp('amount', 'Сумма', 'number', '', 'inputmode="decimal"')}${inp('date', 'Дата', 'date', today())}</div>${inp('category', 'Категория', 'text', '', 'placeholder="Еда, транспорт, подписки…"')}`;
    else if (t === 'activity') h = `<div class="form-row">${sel('akind', 'Что записать', [['water', 'Вода, мл'], ['workout', 'Тренировка, мин'], ['study', 'Занятие, мин'], ['sleep', 'Сон, часов'], ['steps', 'Шаги']], guessActivity(input.value))}${inp('amount', 'Сколько', 'number', '', 'inputmode="decimal"')}${inp('date', 'Дата', 'date', today())}</div>`;
    detEl.innerHTML = h;
    detEl.hidden = !details;
    wrap.querySelector('[data-details]').classList.toggle('active', details);
  };
  const val = (name) => { const e = detEl.querySelector(`[name="${name}"]`); if (!e) return undefined; return e.type === 'checkbox' ? e.checked : e.value; };
  const pick = (name, fallback) => { const v = details ? val(name) : undefined; return v === undefined || v === '' ? fallback : v; };

  const save = () => {
    const raw = input.value.trim();
    const t = effType();
    if (!raw && t !== 'activity') { input.focus(); return; }
    if (t === 'task') {
      let { text: s, date } = parseDate(raw); const pt = parseTime(s); s = pt.text;
      let priority = 2; if (s.startsWith('!')) { priority = 1; s = s.slice(1).trim(); }
      let timeless = false; if (/\s+бессрочно$/i.test(s)) { timeless = true; s = s.replace(/\s+бессрочно$/i, ''); }
      const personId = pick('personId', ctx.personId) || null, projectId = pick('projectId', ctx.projectId) || null;
      const direction = pick('direction', 'mine');
      const rec = addTask({ title: s, date: pick('timeless', timeless) ? null : (pick('date', date || ctx.date) || null), time: pick('time', pt.time) || '', priority: Number(pick('priority', priority)), personId, projectId, direction, source: personId && ctx.source === 'ceo' ? 'ceo' : personId && direction === 'theirs' ? 'promise' : projectId ? 'project' : personId ? 'promise' : 'manual', timeless: !!pick('timeless', timeless) });
      if (!rec) return;
      toast(rec.date ? `Задача на ${fmtDate(rec.date)}` : rec.timeless ? 'Бессрочная задача добавлена' : 'Задача в инбоксе');
    } else if (t === 'event') {
      let { text: s, date } = parseDate(raw); const pt = parseTime(s); s = pt.text;
      db.add('events', { title: s || 'Событие', date: pick('date', date || ctx.date || today()), time: pick('time', pt.time) || '', endTime: pick('endTime', '') || '', place: pick('place', '') || '', kind: pick('kind', 'meeting'), personId: pick('personId', ctx.personId) || null, repeat: pick('repeat', 'none'), until: '', notes: '' });
      toast('Событие добавлено');
    } else if (t === 'note') {
      const lines = raw.split('\n'); const title = lines[0].slice(0, 120); const body = lines.length > 1 ? lines.slice(1).join('\n').trim() : (lines[0].length > 120 ? raw : '');
      const tags = String(pick('tags', '') || '').split(/[,;]/).map(x => x.trim().replace(/^#/, '').toLowerCase()).filter(Boolean);
      const noteType = pick('noteType', ctx.noteType);
      const rec = addNote({ type: noteType, title, body, date: pick('date', today()), tags, personId: pick('personId', ctx.personId) || null, projectId: pick('projectId', ctx.projectId) || null, quote: !!pick('quote', false), ...(noteType === 'idea' ? { status: 'new', impact: 2, effort: 2 } : {}), ...(noteType === 'meeting' ? { meetingKind: 'meeting', next: '' } : {}) });
      if (!rec) return;
      toast(`${NOTE_TYPES[noteType] || 'Заметка'} сохранена`);
    } else if (t === 'money') {
      const m = parseMoney(raw);
      const amount = Number(pick('amount', m?.amount)); if (!amount) { toast('Укажите сумму'); details = true; drawDetails(); detEl.querySelector('[name=amount]')?.focus(); return; }
      const type = pick('mtype', m?.income ? 'income' : 'expense');
      addTransaction({ type, amount, category: pick('category', '') || (m?.rest || '').split(' ').slice(0, 2).join(' ') || '', note: m?.rest || raw, date: pick('date', today()) });
      toast(`${type === 'income' ? 'Доход' : 'Расход'} ${amount} ${db.settings().currency || '₽'} записан`);
    } else if (t === 'activity') {
      const kind = pick('akind', guessActivity(raw)); const n = Number(pick('amount', firstNumber(raw))); const d = pick('date', today());
      if (kind === 'water') { addWater(n || 250, d); toast(`+${n || 250} мл воды`); }
      else if (kind === 'steps') { if (!n) { toast('Сколько шагов?'); return; } addSteps(n, d); toast(`+${n} шагов`); }
      else if (kind === 'sleep') { setSleepHours(d, n || 8); toast(`Сон: ${n || 8} ч`); }
      else if (kind === 'study') { const a = db.all('learningAreas')[0]; if (!a) { toast('Сначала создайте область обучения'); return; } db.add('studySessions', { areaId: a.id, date: d, minutes: n || 30, notes: raw.replace(/\d+/, '').trim() }); toast(`Занятие ${n || 30} мин записано`); }
      else { db.add('workouts', { date: d, type: /бег|кардио|вело|плав/i.test(raw) ? 'cardio' : /йога|растяж|мобил/i.test(raw) ? 'mobility' : 'strength', title: raw.replace(/\d+\s*(мин)?/i, '').trim() || 'Тренировка', durationMin: n || 45, rpe: null, exercises: [], notes: '' }); toast('Тренировка записана'); }
    }
    close();
  };
  const close = () => { wrap.classList.remove('open'); document.removeEventListener('keydown', onKey); setTimeout(() => { wrap.remove(); open = false; }, 180); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) return close();
    const tb = e.target.closest('[data-type]'); if (tb) { curType = tb.dataset.type; drawTypes(); drawDetails(); return; }
    if (e.target.closest('[data-details]')) { details = !details; drawDetails(); if (details) detEl.querySelector('input,select')?.focus(); return; }
    if (e.target.closest('[data-save]')) save();
  });
  input.addEventListener('input', () => { if (!curType) drawTypes(); else drawHint(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } });
  detEl.addEventListener('change', drawHint);
  document.getElementById('modals').appendChild(wrap);
  drawTypes(); drawDetails();
  requestAnimationFrame(() => { wrap.classList.add('open'); input.focus(); });
}
