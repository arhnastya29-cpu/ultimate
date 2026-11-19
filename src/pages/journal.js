// Рефлексия: быстрый режим (настроение + главное событие) по умолчанию, полный — по кнопке «Подробнее».
// Настроение хранится в checkins.mood (единый источник, см. model.js); journal.mood дублируется для совместимости.
import { db } from '../db.js';
import {
  esc, icon, modal, field, formData, toast, on,
  today, addDays, parseISO, fmtDate, fmtDateLong, startOfWeek, lastNDays, dateNav,
  lineChart, sortBy, avg, plural, statLine, emptyAction, pageMenu,
} from '../ui.js';
import { checkinOn, setCheckin } from '../model.js';

export const title = 'Рефлексия';

// ---------- Локальное состояние ----------
let day = today();
let full = false;        // полный режим включён вручную
let statsOpen = false;

// ---------- Справочники ----------
const PROMPTS = [
  'Что сегодня дало больше всего энергии, а что её забрало?',
  'Какое решение сегодня я принял(а) осознанно, а какое — на автомате?',
  'Если бы этот день повторился завтра, что бы я сделал(а) иначе?',
  'За что я могу похвалить себя сегодня — даже за мелочь?',
  'Что я сегодня узнал(а) о себе или о мире?',
  'Кому я сегодня помог(ла) или кто помог мне?',
  'Какая мысль сегодня занимала меня дольше всего — и стоит ли она того?',
  'Что из сегодняшнего приближает меня к целям на квартал?',
  'Что я откладывал(а) сегодня и почему?',
  'Какой момент дня я хотел(а) бы запомнить?',
];
const MOODS = ['😞', '😕', '😐', '🙂', '😄'];
const MOOD_WORDS = ['тяжёлый', 'так себе', 'обычный', 'хороший', 'отличный'];
const moodEmoji = (m) => MOODS[Number(m) - 1] || '·';
const FULL_FIELDS = ['wentWell', 'improve', 'gratitude', 'lessons', 'note'];

function dayOfYear(dateIso) {
  const d = parseISO(dateIso);
  return Math.round((d - new Date(d.getFullYear(), 0, 1)) / 86400000);
}
// Настроение дня: чек-ин — главный источник, запись дневника — запасной.
const moodOn = (d, rec) => { const c = checkinOn(d); const m = c?.mood ?? rec?.mood ?? null; return m ? Number(m) : null; };

// ---------- Модалка недельного обзора ----------
function openWeeklyReviewModal(weekStart) {
  const ex = db.all('weeklyReviews').find(r => r.weekStart === weekStart) || null;
  modal({
    title: `Обзор недели с ${fmtDate(weekStart, { relative: false, year: true })}`,
    body: `<div class="form">
      ${field({ name: 'wins', label: 'Победы недели', type: 'textarea', value: ex?.wins || '', rows: 3, placeholder: 'Что получилось и чем горжусь' })}
      ${field({ name: 'challenges', label: 'Сложности', type: 'textarea', value: ex?.challenges || '', rows: 3, placeholder: 'Что мешало, где буксовал' })}
      ${field({ name: 'nextFocus', label: 'Фокус на следующую неделю', type: 'textarea', value: ex?.nextFocus || '', rows: 2, placeholder: '1–3 главных приоритета' })}
      ${field({ name: 'rating', label: 'Оценка недели', type: 'rating', value: ex?.rating ?? '', hint: '1 — провальная, 5 — отличная' })}
    </div>`,
    onSubmit: (d) => {
      const data = { weekStart, wins: d.wins || '', challenges: d.challenges || '', nextFocus: d.nextFocus || '', rating: d.rating ?? null };
      if (ex) db.update('weeklyReviews', ex.id, data); else db.add('weeklyReviews', data);
      toast('Обзор недели сохранён');
    },
    onDelete: ex ? () => { db.remove('weeklyReviews', ex.id); toast('Обзор удалён'); } : undefined,
  });
}

// ---------- Страница ----------
export async function render(root, ctx) {
  const rerender = () => render(root, ctx);
  const t = today();
  const journal = db.all('journal');
  const byDate = new Map(journal.map(r => [r.date, r]));
  const rec = byDate.get(day) || null;
  const mood = moodOn(day, rec);
  const recent = sortBy(journal, r => r.date, true).slice(0, 14);
  const reviews = sortBy(db.all('weeklyReviews'), r => r.weekStart, true);
  const currentWeek = startOfWeek();
  const currentReview = reviews.find(r => r.weekStart === currentWeek) || null;
  const promptText = PROMPTS[((dayOfYear(day) % PROMPTS.length) + PROMPTS.length) % PROMPTS.length];
  const showFull = full || FULL_FIELDS.some(k => rec && String(rec[k] || '').trim());

  // Серия дней с записями (сегодня или вчера — отправная точка).
  let streak = 0;
  for (let d = byDate.has(t) ? t : addDays(t, -1); byDate.has(d) && streak < 3650; d = addDays(d, -1)) streak++;

  // Настроение за 30 дней (чек-ины + записи).
  const days30 = lastNDays(30, t);
  const points = [];
  days30.forEach((d, i) => { const m = moodOn(d, byDate.get(d)); if (m) points.push({ x: i, y: m }); });
  const avgMood = points.length ? avg(points, p => p.y) : null;

  const f = rec || {};
  const formHtml = `<form class="card form jr-form" data-journal data-block="entry" data-block-title="Запись дня">
    <div class="row between wrap"><h3 style="margin:0">${day === t ? 'Как прошёл день' : esc(fmtDate(day, { weekday: true }))}</h3><span class="tiny muted">${esc(fmtDateLong(day))}</span></div>
    <div class="field">
      <label id="jr-mood-label">Настроение</label>
      <div class="rating jr-mood" data-rating="mood" role="group" aria-labelledby="jr-mood-label">
        <input type="hidden" name="mood" value="${mood ?? ''}">
        ${MOODS.map((m, i) => `<button type="button" data-v="${i + 1}" class="${mood === i + 1 ? 'active' : ''}" aria-label="${esc(MOOD_WORDS[i])} день" aria-pressed="${mood === i + 1}">${m}</button>`).join('')}
      </div>
      <div class="hint">${mood ? `${esc(MOOD_WORDS[mood - 1])} день` : '1 — тяжёлый день, 5 — отличный'}</div>
    </div>
    ${field({ name: 'highlight', label: 'Главное событие', value: f.highlight || '', placeholder: 'Одной строкой' })}
    ${showFull ? `
      <div class="jr-prompt">${esc(promptText)}</div>
      ${field({ name: 'wentWell', label: 'Что прошло хорошо', type: 'textarea', value: f.wentWell || '', rows: 3 })}
      ${field({ name: 'improve', label: 'Что улучшить', type: 'textarea', value: f.improve || '', rows: 3 })}
      ${field({ name: 'gratitude', label: 'Благодарность', type: 'textarea', value: f.gratitude || '', rows: 2 })}
      ${field({ name: 'lessons', label: 'Инсайт дня', type: 'textarea', value: f.lessons || '', rows: 2 })}
      ${field({ name: 'note', label: 'Подробная заметка', type: 'textarea', value: f.note || '', rows: 4 })}
    ` : ''}
    <div class="row between wrap jr-foot">
      <button class="btn" type="submit">${icon('check')} Сохранить</button>
      ${showFull
        ? (full ? `<button type="button" class="btn ghost sm" data-action="less">Короче</button>` : '')
        : `<button type="button" class="btn ghost sm" data-action="more">Подробнее ${icon('chevronDown')}</button>`}
    </div>
  </form>`;

  const recentHtml = recent.length
    ? `<div class="list jr-history">${recent.map(r => `<button type="button" class="list-item clickable ${r.date === day ? 'current' : ''}" data-action="go" data-date="${esc(r.date)}" aria-current="${r.date === day ? 'date' : 'false'}">
        <span class="jr-mood-ico" aria-hidden="true">${moodEmoji(moodOn(r.date, r))}</span>
        <div class="main">
          <div class="title">${esc(fmtDate(r.date, { weekday: true }))}</div>
          <div class="sub ellipsis">${esc(r.highlight || r.wentWell || r.lessons || r.note || 'без заголовка')}</div>
        </div>
      </button>`).join('')}</div>`
    : '';

  const reviewsHtml = reviews.length
    ? `<div class="list">${reviews.slice(0, 8).map(r => `<button type="button" class="list-item clickable" data-action="edit-review" data-id="${esc(r.id)}">
        <div class="main">
          <div class="title">Неделя с ${esc(fmtDate(r.weekStart, { relative: false, year: true }))}${r.weekStart === currentWeek ? ' <span class="tag">текущая</span>' : ''}</div>
          <div class="sub ellipsis">${esc(r.wins || r.nextFocus || r.challenges || '—')}</div>
        </div>
        ${r.rating ? `<span class="pill ${Number(r.rating) >= 4 ? 'good' : Number(r.rating) <= 2 ? 'bad' : ''}">${Number(r.rating)}/5</span>` : ''}
      </button>`).join('')}</div>`
    : `<div class="tiny muted">Итоги недели: победы, сложности и фокус на следующую. Пятница или воскресенье — хороший момент.</div>`;

  const statsHtml = points.length >= 2
    ? `<div class="tiny muted" style="margin-bottom:6px">Настроение за 30 дней · 1 — плохо, 5 — отлично</div>
       ${lineChart([{ points, color: 'var(--accent)' }], days30.map(d => String(Number(d.slice(8, 10)))), { height: 120, min: 1, max: 5 })}`
    : `<div class="tiny muted">График настроения появится, когда будет хотя бы две отметки за 30 дней.</div>`;

  root.innerHTML = `<div class="journal-page">
    <div class="page-head">
      <div><div class="eyebrow">Личное</div><h1>Рефлексия</h1></div>
      <div class="actions">
        <div class="dn-compact">${dateNav(day)}</div>
        ${pageMenu([
          { label: currentReview ? 'Изменить обзор недели' : 'Обзор недели', action: 'weekly', icon: 'calendar' },
          rec ? { label: 'Удалить запись дня', action: 'delete-entry', icon: 'trash' } : null,
          { label: 'Настроить страницу', action: 'customize', icon: 'sliders' },
        ])}
      </div>
    </div>
    ${statLine([
      journal.length ? `<b>${journal.length}</b> ${plural(journal.length, 'запись', 'записи', 'записей')}` : '',
      streak ? `серия <b>${streak} ${plural(streak, 'день', 'дня', 'дней')}</b>` : '',
      avgMood != null ? `настроение <b>${moodEmoji(Math.round(avgMood))} ${avgMood.toFixed(1)}</b> за 30 дней` : '',
    ])}
    <div class="grid-2 jr-grid" style="align-items:start">
      <div class="stack">
        ${formHtml}
      </div>
      <div class="stack">
        <section class="card" data-block="history" data-block-title="Записи">
          <div class="section-title"><h2>Записи</h2>${journal.length > recent.length ? `<span class="tiny muted">последние ${recent.length} из ${journal.length}</span>` : ''}</div>
          ${recentHtml || emptyAction({ text: 'Две строки в день: настроение и главное событие. Записи появятся здесь.', action: 'focus-form', label: 'Записать сегодня' })}
        </section>
        <section class="card" data-block="weekly" data-block-title="Обзор недели">
          <div class="section-title">
            <h2>Обзор недели</h2>
            <button type="button" class="btn sm secondary" data-action="weekly">${icon('edit')} ${currentReview ? 'Изменить' : 'Написать'}</button>
          </div>
          ${reviewsHtml}
        </section>
        ${journal.length || points.length ? `<section class="card" data-block="stats" data-block-title="Статистика">
          <details class="acc" data-acc="stats" ${statsOpen ? 'open' : ''}>
            <summary>${icon('chevronDown')} Статистика</summary>
            <div class="acc-body">${statsHtml}</div>
          </details>
        </section>` : ''}
      </div>
    </div>
  </div>`;

  const view = root.firstElementChild;

  // Настроение: кнопки 1–5 (в модалках это делает ui.js, здесь — вручную).
  on(view, 'click', '.rating button[data-v]', (e, b) => {
    const r = b.closest('.rating');
    const hidden = r.querySelector('input[type=hidden]');
    const off = hidden.value === b.dataset.v;
    hidden.value = off ? '' : b.dataset.v;
    r.querySelectorAll('button').forEach(x => { const onB = !off && x === b; x.classList.toggle('active', onB); x.setAttribute('aria-pressed', String(onB)); });
    const hint = r.parentElement.querySelector('.hint');
    if (hint) hint.textContent = off ? '1 — тяжёлый день, 5 — отличный' : `${MOOD_WORDS[Number(b.dataset.v) - 1]} день`;
  });

  on(view, 'submit', 'form[data-journal]', (e, form) => {
    e.preventDefault();
    const d = formData(form);
    const moodV = d.mood ?? null;
    const data = { date: day, highlight: d.highlight || '', mood: moodV };
    if (showFull) {
      data.wentWell = d.wentWell || ''; data.improve = d.improve || ''; data.gratitude = d.gratitude || '';
      data.lessons = d.lessons || ''; data.note = d.note || '';
    }
    const hasText = [data.highlight, data.wentWell, data.improve, data.gratitude, data.lessons, data.note].some(x => x && String(x).trim());
    if (!hasText && moodV == null) { toast('Отметьте настроение или напишите пару слов'); return; }
    // Настроение — в чек-ин дня (единый источник), копия — в запись дневника.
    const cur = checkinOn(day);
    if (moodV != null || cur) setCheckin(day, { mood: moodV });
    const existing = db.all('journal').find(r => r.date === day);
    if (existing) db.update('journal', existing.id, data); else db.add('journal', { wentWell: '', improve: '', gratitude: '', lessons: '', note: '', ...data });
    toast('Запись сохранена');
  });

  on(view, 'click', '[data-action]', (e, b) => {
    switch (b.dataset.action) {
      case 'go': day = b.dataset.date; full = false; rerender(); window.scrollTo({ top: 0, behavior: 'smooth' }); break;
      case 'more': full = true; rerender(); setTimeout(() => view.querySelector('[name="wentWell"]')?.focus(), 30); break;
      case 'less': full = false; rerender(); break;
      case 'focus-form': view.querySelector('.jr-mood button')?.focus(); break;
      case 'delete-entry':
        if (rec && confirm('Удалить запись за этот день?')) { db.remove('journal', rec.id); toast('Запись удалена'); }
        break;
      case 'weekly': openWeeklyReviewModal(currentWeek); break;
      case 'edit-review': { const r = db.get('weeklyReviews', b.dataset.id); if (r) openWeeklyReviewModal(r.weekStart); break; }
      default: break;
    }
  });

  on(view, 'click', '[data-dn]', (e, b) => {
    const a = b.dataset.dn;
    if (a === 'prev') day = addDays(day, -1);
    else if (a === 'next') day = addDays(day, 1);
    else if (a === 'today') day = today();
    else return;
    full = false;
    rerender();
  });
  on(view, 'change', '[data-dn="pick"]', (e, inp) => { if (inp.value) { day = inp.value; full = false; rerender(); } });

  view.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d instanceof HTMLDetailsElement && d.dataset.acc === 'stats') statsOpen = d.open;
  }, true);
}
