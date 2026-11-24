import { db } from '../db.js';
import { esc, icon, field, formRow, formData, toast, on, today, addDays, lastNDays, fmtDate, fmtNum, avg, sum, sortBy, emptyAction, statLine, pageMenu, barChart, lineChart, dateNav, weekdayShort, plural } from '../ui.js';
import { checkinOn, setCheckin, energyOn } from '../model.js';
import { whoopOn, recoveryClass, recoveryWord } from '../whoop.js';

export const title = 'Сон и энергия';

const QUALITY = ['😫', '😕', '😐', '🙂', '😴'];
const ENERGY = ['🪫', '😴', '😐', '⚡', '🔥'];

// Локальное состояние: выбранная дата (дата пробуждения).
let day = today();

// ---------- Время ----------
const toMin = (t) => {
  if (!t || !/^\d{1,2}:\d{2}/.test(t)) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const fromMin = (m) => {
  m = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
// Для усреднения отбоя: время до полудня считаем «после полуночи» (+24 ч).
const bedNorm = (t) => { const v = toMin(t); return v == null ? null : (v < 720 ? v + 1440 : v); };

function calcHours(bed, wake) {
  const b = toMin(bed), w = toMin(wake);
  if (b == null || w == null) return null;
  let d = w - b;
  if (d < 0) d += 1440;
  return Math.round(d / 15) / 4;
}

// ---------- Инсайты ----------
function insights(logs, target) {
  if (logs.length < 7) return [`Недостаточно данных: нужно хотя бы 7 записей, пока ${logs.length}.`];
  const out = [];
  const f1 = (v) => fmtNum(v, 1);

  const withE = logs.map(l => ({ ...l, energy: energyOn(l.date) })).filter(l => l.hours != null && l.energy);
  const long = withE.filter(l => Number(l.hours) >= target), short = withE.filter(l => Number(l.hours) < target);
  if (long.length >= 3 && short.length >= 3) {
    const a = avg(long, l => l.energy), b = avg(short, l => l.energy);
    out.push(`В дни после сна ≥ ${f1(target)} ч средняя энергия ${f1(a)}, после короткого сна — ${f1(b)}${a - b >= 0.3 ? '. Длинный сон явно помогает.' : a - b <= -0.3 ? '. Любопытно: короткий сон не снижает энергию.' : '. Разница небольшая.'}`);
  } else out.push('Связь длительности сна и энергии: недостаточно данных (нужно по 3 дня с длинным и коротким сном).');

  const wDates = new Set(db.all('workouts').map(w => w.date));
  const withQ = logs.filter(l => l.quality);
  const afterW = withQ.filter(l => wDates.has(addDays(l.date, -1)));
  const noW = withQ.filter(l => !wDates.has(addDays(l.date, -1)));
  if (afterW.length >= 3 && noW.length >= 3) {
    const a = avg(afterW, l => l.quality), b = avg(noW, l => l.quality);
    out.push(`Качество сна в ночь после тренировки — ${f1(a)}/5, без тренировки — ${f1(b)}/5${a - b >= 0.3 ? '. Тренировки улучшают сон.' : a - b <= -0.3 ? '. После тренировок сон хуже — возможно, они слишком поздно.' : '. Заметной разницы нет.'}`);
  } else out.push('Связь тренировок и сна: недостаточно данных (нужно по 3 ночи после тренировки и без неё).');

  const withB = logs.filter(l => bedNorm(l.bedTime) != null && l.quality);
  if (withB.length >= 6) {
    const sorted = sortBy(withB, l => bedNorm(l.bedTime));
    const med = bedNorm(sorted[Math.floor(sorted.length / 2)].bedTime);
    const early = withB.filter(l => bedNorm(l.bedTime) < med), late = withB.filter(l => bedNorm(l.bedTime) >= med);
    if (early.length >= 3 && late.length >= 3) {
      const a = avg(early, l => l.quality), b = avg(late, l => l.quality);
      out.push(`Если лечь раньше ${fromMin(med)}, качество сна в среднем ${f1(a)}/5, позже — ${f1(b)}/5.`);
    }
  }
  return out;
}

// ---------- Страница ----------
export async function render(root, ctx) {
  const rerender = () => render(root, ctx);
  const target = Number(db.settings().sleepTarget) || 8;
  const logs = sortBy(db.all('sleepLogs'), l => l.date);
  const byDate = new Map(logs.map(l => [l.date, l]));
  const cur = byDate.get(day);
  // Энергия дня — из чек-ина (единый источник); старое поле sleepLogs.energy читается только как запасное.
  const curEnergy = energyOn(day);

  // --- статистика за 7 дней
  const week = lastNDays(7).map(d => byDate.get(d)).filter(Boolean);
  const weekH = week.filter(l => l.hours != null && !isNaN(Number(l.hours)));
  const avgH = weekH.length ? avg(weekH, l => l.hours) : null;
  const weekQ = week.filter(l => l.quality);
  const avgQ = weekQ.length ? avg(weekQ, l => l.quality) : null;
  const debt = sum(weekH, l => Math.max(0, target - Number(l.hours)));
  const beds = week.map(l => bedNorm(l.bedTime)).filter(v => v != null);
  const avgBed = beds.length ? fromMin(avg(beds)) : null;

  // --- графики за 14 дней
  const days14 = lastNDays(14);
  const bars = days14.map(d => {
    const h = Number(byDate.get(d)?.hours) || 0;
    return { label: weekdayShort(d), value: h, valueLabel: fmtNum(h, 1), color: h >= target ? 'var(--good)' : 'var(--warn)' };
  });
  const hasBars = bars.some(b => b.value > 0);
  const energyPts = days14.map((d, i) => ({ x: i, y: energyOn(d) })).filter(p => p.y != null);
  const qualityPts = days14.map((d, i) => ({ x: i, y: byDate.get(d)?.quality ?? null })).filter(p => p.y != null);

  const recent = [...logs].reverse().slice(0, 14);
  const tips = logs.length ? insights(logs, target) : [];

  const stats = statLine([
    avgH != null ? `Сон <b class="${avgH >= target ? 'good' : 'warn'}">${fmtNum(avgH, 1)} ч</b> в среднем за 7 дней (цель ${fmtNum(target, 1)} ч)` : '',
    avgQ != null ? `Качество <b>${fmtNum(avgQ, 1)}</b>/5` : '',
    weekH.length && debt > 0 ? `Недосып <b class="${debt >= 5 ? 'bad' : 'warn'}">${fmtNum(debt, 1)} ч</b> за неделю` : '',
    avgBed ? `Отбой в среднем <b>${avgBed}</b>` : '',
  ]);

  const historyRow = (l) => {
    const h = Number(l.hours);
    const en = energyOn(l.date);
    const bits = [];
    if (l.bedTime || l.wakeTime) bits.push(`${esc(l.bedTime || '—')} → ${esc(l.wakeTime || '—')}`);
    if (l.quality) bits.push(`качество ${esc(l.quality)}/5`);
    if (en) bits.push(`энергия ${esc(en)}/5`);
    const wd = whoopOn(l.date); if (wd?.recovery != null) bits.push(`<span class="${recoveryClass(wd.recovery)}">recovery ${Math.round(wd.recovery)}%</span>`);
    return `<div class="list-item">
      <div class="main" data-pick="${esc(l.date)}" tabindex="0" role="button">
        <div class="title">${esc(fmtDate(l.date, { weekday: true }))}</div>
        <div class="sub">${bits.join(' · ') || '—'}${l.notes ? ` · <span class="faint">${esc(l.notes)}</span>` : ''}</div>
      </div>
      ${l.hours != null && !isNaN(h) ? `<span class="pill ${h >= target ? 'good' : 'warn'}">${fmtNum(h, 2)} ч</span>` : ''}
      <button class="icon-btn sm" data-del="${esc(l.id)}" aria-label="Удалить">${icon('trash')}</button>
    </div>`;
  };

  root.innerHTML = `<div class="body-page" data-page="sleep">
    <div class="page-head">
      <div><div class="eyebrow">Тело</div><h1>Сон и энергия</h1></div>
      <div class="actions">
        <div class="dnav">${dateNav(day)}</div>
        ${pageMenu([{ label: 'Настроить страницу', action: 'customize', icon: 'sliders' }])}
      </div>
    </div>
    ${stats}

    <div class="grid-2" style="align-items:start">
      <div class="stack">
        <form class="card form day-card" id="sleepForm" data-block="sleep-form" data-block-title="Запись сна">
          <div class="row between"><h3 style="margin:0">Сон · ${esc(fmtDate(day, { weekday: true }))}</h3>${cur ? '<span class="pill good">Записано</span>' : ''}</div>
          <p class="tiny muted" style="margin:0">Дата — день пробуждения. Часы считаются по времени отбоя и подъёма, их можно поправить.</p>
          ${(() => { const w = whoopOn(day); if (!w) return ''; return `<div class="whoop-box" data-block="whoop-day" data-block-title="WHOOP">
            <div class="row wrap" style="gap:14px">
              ${w.recovery != null ? `<div><div class="label">Recovery</div><div class="value ${recoveryClass(w.recovery)}" style="font-size:22px">${Math.round(w.recovery)}%</div><div class="tiny muted">${recoveryWord(w.recovery)}</div></div>` : ''}
              ${w.hrv != null ? `<div><div class="label">HRV</div><div class="value" style="font-size:22px">${Math.round(w.hrv)}<small> мс</small></div></div>` : ''}
              ${w.rhr != null ? `<div><div class="label">Пульс покоя</div><div class="value" style="font-size:22px">${Math.round(w.rhr)}</div></div>` : ''}
              ${w.performance != null ? `<div><div class="label">Сон</div><div class="value" style="font-size:22px">${Math.round(w.performance)}%</div><div class="tiny muted">от нужных ${w.sleepNeededHours ? fmtNum(w.sleepNeededHours, 1) + ' ч' : ''}</div></div>` : ''}
              ${w.strain != null ? `<div><div class="label">Нагрузка</div><div class="value" style="font-size:22px">${fmtNum(w.strain, 1)}</div></div>` : ''}
            </div>
            ${w.remMin != null ? `<div class="tiny muted" style="margin-top:8px">Фазы: глубокий ${w.deepMin} мин · REM ${w.remMin} мин · лёгкий ${w.lightMin} мин · бодрствование ${w.awakeMin} мин${w.disturbances != null ? ` · пробуждений ${w.disturbances}` : ''}${w.respiratoryRate ? ` · дыхание ${fmtNum(w.respiratoryRate, 1)}/мин` : ''}</div>` : ''}
          </div>`; })()}
          ${formRow(
            field({ name: 'bedTime', label: 'Лёг спать', type: 'time', value: cur?.bedTime || '' }),
            field({ name: 'wakeTime', label: 'Проснулся', type: 'time', value: cur?.wakeTime || '' }),
            field({ name: 'hours', label: 'Часов сна', type: 'number', step: 0.25, min: 0, max: 24, value: cur?.hours ?? '', placeholder: '7.5' }),
          )}
          <div class="row wrap top" style="gap:16px">
            ${field({ name: 'quality', label: 'Качество сна', type: 'rating', value: cur?.quality, labels: QUALITY })}
            ${field({ name: 'energy', label: 'Энергия днём', type: 'rating', value: curEnergy, labels: ENERGY, hint: 'Та же оценка, что в чек-ине на странице «Здоровье»' })}
          </div>
          ${field({ name: 'notes', label: 'Заметки', type: 'textarea', value: cur?.notes, rows: 2, placeholder: 'Что повлияло на сон?' })}
          <button class="btn" type="submit">${icon('check')} Сохранить</button>
        </form>
      </div>

      <div class="stack">
        <div class="card" data-block="history" data-block-title="История">
          <div class="row between"><h3 style="margin:0">История</h3>${recent.length ? '<span class="tiny muted">последние 14</span>' : ''}</div>
          ${recent.length ? `<div class="list">${recent.map(historyRow).join('')}</div>`
            : emptyAction({ text: 'Записи сна покажут, сколько вы спите и как это связано с энергией днём', action: 'focus-form', label: 'Запись сна' })}
        </div>
      </div>
    </div>

    ${logs.length ? `<details class="acc card" data-block="analytics" data-block-title="Динамика и наблюдения" style="margin-top:14px">
      <summary><span class="icon-btn sm chev">${icon('chevronDown')}</span> Динамика и наблюдения <span class="sum-sub">14 дней</span></summary>
      <div class="acc-body">
        <div class="acc-grid">
          ${hasBars ? `<div class="card">
            <div class="row between"><h3 style="margin:0">Часы сна · 14 дней</h3><span class="tiny muted">пунктир — цель ${fmtNum(target, 1)} ч</span></div>
            ${barChart(bars, { target, showValues: true, height: 130 })}
          </div>` : ''}
          ${(energyPts.length + qualityPts.length) > 0 ? `<div class="card">
            <h3>Энергия и качество сна · 14 дней</h3>
            ${lineChart([{ points: energyPts, color: 'var(--c2)' }, { points: qualityPts, color: 'var(--c1)' }], days14.map(weekdayShort), { min: 1, max: 5 })}
            <div class="legend" style="margin-top:8px">
              <span><i class="sw" style="background:var(--c2)"></i>Энергия</span>
              <span><i class="sw" style="background:var(--c1)"></i>Качество сна</span>
            </div>
          </div>` : ''}
        </div>
        <div class="card">
          <h3>Наблюдения</h3>
          <div class="stack tight small">${tips.map(t => `<div class="row top" style="gap:8px"><span class="accent">•</span><span>${esc(t)}</span></div>`).join('')}</div>
        </div>
      </div>
    </details>` : ''}
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
  on(view, 'click', '[data-pick]', (e, t) => { day = t.dataset.pick; rerender(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  on(view, 'keydown', '[data-pick]', (e, t) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); t.click(); } });
  on(view, 'click', '[data-action="focus-form"]', () => {
    const f = view.querySelector('#sleepForm');
    f.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => f.querySelector('[name="bedTime"]')?.focus(), 350);
  });

  // --- оценки 1-5 внутри страницы
  on(view, 'click', '.rating button[data-v]', (e, b) => {
    const r = b.closest('.rating');
    const hidden = r.querySelector('input[type=hidden]');
    if (hidden.value === b.dataset.v) { hidden.value = ''; r.querySelectorAll('button').forEach(x => x.classList.remove('active')); return; }
    hidden.value = b.dataset.v;
    r.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
  });

  // --- форма сна: часы и качество — в sleepLogs, энергия — в чек-ин (checkins)
  const form = view.querySelector('#sleepForm');
  const bedEl = form.querySelector('[name="bedTime"]'), wakeEl = form.querySelector('[name="wakeTime"]'), hoursEl = form.querySelector('[name="hours"]');
  const recompute = () => { const h = calcHours(bedEl.value, wakeEl.value); if (h != null) hoursEl.value = h; };
  bedEl.addEventListener('change', recompute);
  wakeEl.addEventListener('change', recompute);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const d = formData(form);
    let hours = d.hours;
    if (hours == null) hours = calcHours(d.bedTime, d.wakeTime);
    if (hours == null && !d.quality && !d.energy) { toast('Укажите время сна или часы'); return; }
    if (hours != null || d.quality || d.bedTime || d.wakeTime || d.notes || cur) {
      const rec = { date: day, bedTime: d.bedTime || '', wakeTime: d.wakeTime || '', hours, quality: d.quality, notes: d.notes };
      // Старое поле energy в sleepLogs очищаем: его единственный источник теперь чек-ин.
      if (cur) db.update('sleepLogs', cur.id, { ...rec, energy: null });
      else db.add('sleepLogs', rec);
    }
    if (d.energy) setCheckin(day, { energy: d.energy });
    else if (checkinOn(day)?.energy) setCheckin(day, { energy: null });
    toast('Сон сохранён');
  });

  // --- удаление из истории
  on(view, 'click', '[data-del]', (e, t) => {
    const l = db.get('sleepLogs', t.dataset.del); if (!l) return;
    if (!confirm(`Удалить запись за ${fmtDate(l.date)}?`)) return;
    db.remove('sleepLogs', l.id);
    toast('Запись удалена');
  });
}
