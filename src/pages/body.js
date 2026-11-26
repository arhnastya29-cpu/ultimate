// Здоровье — единый раздел с переключателем: Обзор · Самочувствие · Сон · Тренировки · Питание.
// Подразделы — прежние страницы (health.js, sleep.js, workouts.js, nutrition.js), они рисуются внутри хаба,
// их собственный заголовок скрыт стилями (.hb-sub .page-head > div:first-child). Данные не меняются.
// Обзор: WHOOP за сегодня, часы сна и динамика сна и recovery за 14 дней, опрос энергии и уверенности 1–10, сводка.
import { db } from '../db.js';
import { esc, icon, tabs, statLine, barChart, lineChart, on, toast, today, addDays, lastNDays, fmtDate, fmtNum, fmtMinutes, sum, avg, plural, weekdayShort } from '../ui.js';
import { checkinOn, setCheckin, sleepOn, moduleOn } from '../model.js';
import { whoopOn, whoopUsed, recoveryClass, recoveryWord } from '../whoop.js';

export const title = 'Здоровье';

const SUBS = {
  checkin:   { label: 'Самочувствие', mod: () => import('./health.js') },
  sleep:     { label: 'Сон',          mod: () => import('./sleep.js') },
  workouts:  { label: 'Тренировки',   mod: () => import('./workouts.js') },
  nutrition: { label: 'Питание',      mod: () => import('./nutrition.js') },
};
let tab = 'overview';

// ---------- опрос 1–10 ----------
const scale10 = (name, value, lo, hi) => `<div class="hb-scale" data-scale="${name}" role="radiogroup" aria-label="${esc(name)}">
  ${Array.from({ length: 10 }, (_, i) => i + 1).map(v => `<button type="button" role="radio" aria-checked="${Number(value) === v}" class="${Number(value) === v ? 'active' : ''} ${v <= 3 ? 'lo' : v >= 8 ? 'hi' : ''}" data-v="${v}">${v}</button>`).join('')}
  <span class="hb-scale-lo">${esc(lo)}</span><span class="hb-scale-hi">${esc(hi)}</span></div>`;

function overviewHtml(d) {
  const s = db.settings();
  const days14 = lastNDays(14, d);
  const week = lastNDays(7, d);
  const w = whoopOn(d);
  const ck = checkinOn(d);
  const target = Number(s.sleepTarget) || 8;

  // Сон и recovery за 14 дней: часы — из журнала сна (WHOOP пишет туда же), recovery — из WHOOP
  const sleepPts = days14.map(x => { const l = sleepOn(x); const wd = whoopOn(x); return { date: x, hours: l?.hours != null ? Number(l.hours) : wd?.sleepHours ?? null, recovery: wd?.recovery ?? null, hrv: wd?.hrv ?? null }; });
  const hoursArr = sleepPts.filter(p => p.hours != null);
  const recArr = sleepPts.filter(p => p.recovery != null);
  const avgH7 = avg(sleepPts.slice(-7).filter(p => p.hours != null), p => p.hours);
  const avgR7 = avg(sleepPts.slice(-7).filter(p => p.recovery != null), p => p.recovery);
  const recColor = (r) => r >= 67 ? 'var(--good)' : r >= 34 ? 'var(--warn)' : 'var(--bad)';
  const lbl = (x, i) => (i % 2 === 0 || days14.length <= 7) ? weekdayShort(x) : '';

  const whoopCard = `<div class="card hb-whoop" data-block="hb-whoop" data-block-title="WHOOP сегодня">
    <div class="section-title"><h2>${icon('activity')} ${w ? 'WHOOP · сегодня' : 'Сон и восстановление'}</h2>${w ? '' : (whoopUsed() ? '<span class="tiny muted">за сегодня данных ещё нет</span>' : '<a class="link" href="#/settings">подключить WHOOP</a>')}</div>
    <div class="hb-metrics">
      ${w?.recovery != null ? `<div class="hb-metric"><div class="label">Recovery</div><div class="value ${recoveryClass(w.recovery)}">${Math.round(w.recovery)}%</div><div class="tiny muted">${recoveryWord(w.recovery)}</div></div>` : ''}
      ${(w?.sleepHours ?? sleepOn(d)?.hours) != null ? `<div class="hb-metric"><div class="label">Сон</div><div class="value">${fmtNum(w?.sleepHours ?? sleepOn(d).hours, 1)}<small> ч</small></div>${w?.performance != null ? `<div class="tiny muted">${Math.round(w.performance)}% от нормы</div>` : `<div class="tiny muted">цель ${fmtNum(target, 1)} ч</div>`}</div>` : ''}
      ${w?.hrv != null ? `<div class="hb-metric"><div class="label">HRV</div><div class="value">${Math.round(w.hrv)}<small> мс</small></div></div>` : ''}
      ${w?.rhr != null ? `<div class="hb-metric"><div class="label">Пульс покоя</div><div class="value">${Math.round(w.rhr)}</div></div>` : ''}
      ${w?.strain != null ? `<div class="hb-metric"><div class="label">Нагрузка</div><div class="value">${fmtNum(w.strain, 1)}</div><div class="tiny muted">из 21</div></div>` : ''}
      ${w?.remMin != null ? `<div class="hb-metric"><div class="label">Глубокий + REM</div><div class="value">${fmtMinutes((w.deepMin || 0) + (w.remMin || 0))}</div><div class="tiny muted">пробуждений ${w.disturbances ?? '—'}</div></div>` : ''}
    </div>
    ${!w && !sleepOn(d) ? `<div class="small muted">Сегодня ещё нет записи сна. ${whoopUsed() ? 'Данные WHOOP подтянутся при следующем обновлении.' : 'Запишите сон во вкладке «Сон» или подключите WHOOP в Настройках.'}</div>` : ''}
  </div>`;

  const charts = `<div class="card" data-block="hb-trend" data-block-title="Динамика сна и recovery">
    <div class="section-title"><h2>${icon('trending')} Динамика за 14 дней</h2><span class="tiny muted">${avgH7 ? `сон в среднем <b class="${avgH7 >= target ? 'good' : 'warn'}">${fmtNum(avgH7, 1)} ч</b>` : ''}${avgR7 ? ` · recovery <b class="${recoveryClass(avgR7)}">${Math.round(avgR7)}%</b>` : ''} за неделю</span></div>
    <div class="hb-chart"><div class="label">Часы сна${target ? ` · пунктир — цель ${fmtNum(target, 1)} ч` : ''}</div>
      ${hoursArr.length ? barChart(sleepPts.map((p, i) => ({ label: lbl(p.date, i), value: p.hours || 0, color: p.hours == null ? 'var(--surface-3)' : p.hours >= target ? 'var(--good)' : p.hours >= target - 1 ? 'var(--accent)' : 'var(--warn)', tip: `${fmtDate(p.date)}: ${p.hours != null ? fmtNum(p.hours, 1) + ' ч' : 'нет записи'}` })), { height: 120, target, max: Math.max(10, target + 1) }) : '<div class="small muted">Пока нет записей сна</div>'}
    </div>
    ${recArr.length ? `<div class="hb-chart"><div class="label">Recovery, % · зелёная зона от 67, жёлтая от 34</div>
      ${barChart(sleepPts.map((p, i) => ({ label: lbl(p.date, i), value: p.recovery || 0, color: p.recovery == null ? 'var(--surface-3)' : recColor(p.recovery), tip: `${fmtDate(p.date)}: ${p.recovery != null ? Math.round(p.recovery) + '%' : 'нет данных'}${p.hrv ? ` · HRV ${Math.round(p.hrv)}` : ''}` })), { height: 120, max: 100 })}
    </div>` : (whoopUsed() ? '' : '<div class="tiny muted">Recovery появится после подключения WHOOP</div>')}
  </div>`;

  // Опрос энергии и уверенности 1–10 (хранится в чек-ине дня; шкала 1–5 для старых карточек заполняется автоматически)
  const hist = lastNDays(14, d).map(x => { const c = checkinOn(x); return { date: x, e: c?.energy10 ?? (c?.energy ? c.energy * 2 : null), c: c?.confidence10 ?? (c?.confidence ? c.confidence * 2 : null) }; });
  const ePts = hist.map((h, i) => ({ x: i, y: h.e })).filter(p => p.y != null), cPts = hist.map((h, i) => ({ x: i, y: h.c })).filter(p => p.y != null);
  const survey = `<div class="card hb-survey" data-block="hb-survey" data-block-title="Энергия и уверенность">
    <div class="section-title"><h2>${icon('zap')} Как вы сегодня</h2><span class="tiny muted">${ck?.energy10 || ck?.confidence10 ? 'сохранено' : 'от 1 до 10'}</span></div>
    <div class="hb-q"><div class="hb-q-title">Энергия <b>${ck?.energy10 ?? '—'}</b></div>${scale10('energy10', ck?.energy10, 'выжата', 'полна сил')}</div>
    <div class="hb-q"><div class="hb-q-title">Уверенность <b>${ck?.confidence10 ?? '—'}</b></div>${scale10('confidence10', ck?.confidence10, 'шатко', 'непоколебимо')}</div>
    ${ePts.length + cPts.length >= 3 ? `<div class="hb-chart" style="margin-top:12px"><div class="label"><span class="hb-dot" style="background:var(--accent)"></span> энергия · <span class="hb-dot" style="background:var(--gold, #F2B544)"></span> уверенность · 14 дней</div>${lineChart([{ points: ePts, color: 'var(--accent)' }, { points: cPts, color: 'var(--gold, #F2B544)' }], hist.map((h, i) => lbl(h.date, i)), { height: 110, min: 1, max: 10 })}</div>` : ''}
  </div>`;

  // Сводка по здоровью
  const meals = db.all('meals').filter(m => m.date === d);
  const dayLog = db.all('dayLogs').find(x => x.date === d);
  const kcal = sum(meals, m => m.kcal), protein = sum(meals, m => m.protein), water = dayLog?.waterMl || 0;
  const workouts = db.all('workouts').filter(x => week.includes(x.date));
  const wMin = sum(workouts, x => x.durationMin);
  const medLogs = db.all('medLogs').filter(l => l.date === d);
  const medSlots = db.all('medications').filter(m => m.active !== false).flatMap(m => (m.times?.length ? m.times : ['morning']).map(t => ({ m, t })));
  const meds = medSlots;   // приёмов за день
  const medsTaken = medSlots.filter(({ m, t }) => medLogs.some(l => l.medId === m.id && l.time === t)).length;
  const moods = week.map(x => checkinOn(x)?.mood).filter(Boolean);
  const steps = w?.steps ?? dayLog?.steps ?? null;
  const lastLab = [...db.all('labTests')].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  const row = (label, value, sub = '', go = '') => `<div class="hb-sum-row" ${go ? `data-go-tab="${go}" role="link" tabindex="0"` : ''}><div><div class="small">${label}</div>${sub ? `<div class="tiny muted">${sub}</div>` : ''}</div><div class="hb-sum-val">${value}</div></div>`;
  const summary = `<div class="card" data-block="hb-summary" data-block-title="Сводка по здоровью">
    <div class="section-title"><h2>${icon('heart')} Сводка</h2><span class="tiny muted">${esc(fmtDate(d, { weekday: true }))}</span></div>
    <div class="hb-sum">
      ${row('Сон за неделю', avgH7 ? `<b class="${avgH7 >= target ? 'good' : 'warn'}">${fmtNum(avgH7, 1)} ч</b>` : '<span class="muted">—</span>', hoursArr.length ? `${hoursArr.slice(-7).length} ${plural(hoursArr.slice(-7).length, 'ночь', 'ночи', 'ночей')} записано` : 'нет записей', 'sleep')}
      ${whoopUsed() ? row('Recovery за неделю', avgR7 ? `<b class="${recoveryClass(avgR7)}">${Math.round(avgR7)}%</b>` : '<span class="muted">—</span>', recArr.length ? `${recArr.slice(-7).length} ${plural(recArr.slice(-7).length, 'день', 'дня', 'дней')}` : '', 'sleep') : ''}
      ${row('Тренировки за неделю', `<b>${workouts.length}</b>`, wMin ? fmtMinutes(wMin) : 'пока нет', 'workouts')}
      ${moduleOn('nutrition') ? row('Питание сегодня', `<b class="${kcal > (s.kcalTarget || 2000) ? 'warn' : ''}">${fmtNum(kcal)}</b> <small class="muted">/ ${s.kcalTarget} ккал</small>`, `белок ${fmtNum(protein)} / ${s.proteinTarget} г · вода ${fmtNum(water)} / ${s.waterTarget} мл`, 'nutrition') : ''}
      ${steps != null ? row('Шаги', `<b class="${steps >= (s.stepsTarget || 8000) ? 'good' : ''}">${fmtNum(steps)}</b> <small class="muted">/ ${fmtNum(s.stepsTarget)}</small>`, w?.steps != null ? 'по WHOOP' : '') : ''}
      ${meds.length ? row('Лекарства сегодня', `<b class="${medsTaken >= meds.length ? 'good' : 'warn'}">${medsTaken}</b> <small class="muted">/ ${meds.length}</small>`, 'приёмов', 'checkin') : ''}
      ${moods.length ? row('Настроение за неделю', `<b>${fmtNum(avg(moods), 1)}</b> <small class="muted">/ 5</small>`, `${moods.length} ${plural(moods.length, 'отметка', 'отметки', 'отметок')}`, 'checkin') : ''}
      ${lastLab ? row('Последние анализы', esc(fmtDate(lastLab.date)), esc(lastLab.name || lastLab.title || ''), 'checkin') : ''}
    </div>
  </div>`;

  return `<div class="hb-overview"><div class="hb-col">${whoopCard}${survey}</div><div class="hb-col">${charts}${summary}</div></div>`;
}

export async function render(root, ctx) {
  const params = ctx?.params || {};
  if (params.tab && (params.tab === 'overview' || SUBS[params.tab])) tab = params.tab;
  let subCleanup = null;
  const d = today();

  const draw = async () => {
    if (typeof subCleanup === 'function') { try { subCleanup(); } catch {} subCleanup = null; }
    root.innerHTML = `<div>
      <div class="page-head"><div><div class="eyebrow">Личное</div><h1>Здоровье</h1></div></div>
      ${tabs([['overview', 'Обзор'], ...Object.entries(SUBS).map(([k, v]) => [k, v.label])], tab, 'data-hb-tab', 'hb-tabs')}
      <div class="hb-body ${tab === 'overview' ? '' : 'hb-sub'}"></div>
    </div>`;
    const body = root.querySelector('.hb-body');
    if (tab === 'overview') { body.innerHTML = overviewHtml(d); return; }
    const mod = await SUBS[tab].mod();
    const sub = document.createElement('div');
    body.appendChild(sub);
    try { subCleanup = await mod.render(sub, { ...ctx, params: { ...params, tab: undefined } }); }
    catch (e) { console.error(e); sub.innerHTML = `<div class="card"><h3>Ошибка в подразделе</h3><pre class="mono tiny" style="white-space:pre-wrap">${esc(e.stack || e.message)}</pre></div>`; }
  };
  await draw();

  on(root, 'click', '[data-hb-tab]', (e, el) => { tab = el.dataset.hbTab; history.replaceState(null, '', `#/health?tab=${tab}`); draw(); });
  on(root, 'click', '[data-go-tab]', (e, el) => { tab = el.dataset.goTab; history.replaceState(null, '', `#/health?tab=${tab}`); draw(); });
  on(root, 'keydown', '[data-go-tab]', (e, el) => { if (e.key === 'Enter') el.click(); });
  on(root, 'click', '.hb-scale button', (e, el) => {
    const name = el.closest('[data-scale]').dataset.scale; const v = Number(el.dataset.v);
    const patch = { [name]: v, [name.replace('10', '')]: Math.max(1, Math.min(5, Math.ceil(v / 2))) };   // 1–10 → 1–5 для старых карточек
    setCheckin(d, patch);
    toast(name === 'energy10' ? `Энергия: ${v}` : `Уверенность: ${v}`);
    if (tab === 'overview') { const y = window.scrollY; root.querySelector('.hb-body').innerHTML = overviewHtml(d); window.scrollTo(0, y); }
  });
  const onWhoop = () => { if (tab === 'overview') { const y = window.scrollY; root.querySelector('.hb-body').innerHTML = overviewHtml(d); window.scrollTo(0, y); } };
  window.addEventListener('ultimate:whoop', onWhoop);
  return () => { window.removeEventListener('ultimate:whoop', onWhoop); if (typeof subCleanup === 'function') { try { subCleanup(); } catch {} } };
}
