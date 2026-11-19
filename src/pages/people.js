// Люди: лёгкий личный CRM на единых моделях.
// Обещания — это задачи (tasks с personId: direction 'mine' — я обещала, 'theirs' — мне обещали),
// итоги встреч — заметки (notes с type 'meeting'), следующая встреча — событие календаря с personId.
// Коллекции commitments и contacts здесь не читаются и не пишутся.
import { db } from '../db.js';
import { esc, icon, modal, field, formRow, toast, on, today, fmtDate, daysBetween, checkBtn, sortBy, plural, statLine, emptyAction, pageMenu } from '../ui.js';
import { lastContactOf, nextMeetingWith, openTasksOfPerson, tasksOfPerson, notesOfPerson, toggleTask, addNote, isMine, MEETING_KINDS, NOTE_TYPES, TASK_SOURCES } from '../model.js';
import { openTaskModal } from './task-modal.js';

export const title = 'Люди';

export const PERSON_TYPES = { ceo: 'CEO / руководство', team: 'Команда', partner: 'Партнёры', client: 'Клиенты', other: 'Другие' };
const TYPE_OPTIONS = Object.entries(PERSON_TYPES);
const STALE_DAYS = 30;
const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)'];

// ---------- Локальное состояние ----------
let typeFilter = 'all';
let search = '';
let filtersOpen = false;          // телефон: раскрыты ли чипы категорий
const showDone = new Set();       // id людей, у которых раскрыты закрытые обязательства

// ---------- Помощники ----------
const parseTags = (s) => [...new Set(String(s || '').split(/[,;]/).map(x => x.trim()).filter(Boolean))];
const dayWord = (n) => plural(n, 'день', 'дня', 'дней');
const initials = (name) => String(name || '?').split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
const isPhone = () => window.matchMedia('(max-width: 860px)').matches;
const personTasks = (id) => tasksOfPerson(id);
const sinceText = (last, t) => { if (!last) return ''; const n = daysBetween(last, t); return n === 0 ? 'сегодня' : n === 1 ? 'вчера' : `${n} ${dayWord(n)} назад`; };
const isStale = (last, t) => !!last && daysBetween(last, t) > STALE_DAYS;
const tgLink = (tg) => { const u = String(tg || '').trim().replace(/^@/, ''); return /^[\w]{3,}$/.test(u) ? `https://t.me/${u}` : null; };
const meetingText = (ev) => `${fmtDate(ev.on)}${ev.time ? ` ${ev.time}` : ''}${ev.title ? ` · ${ev.title}` : ''}`;

// ---------- Модалки ----------
export function openPersonModal(p) {
  const isNew = !p;
  const x = p || { name: '', role: '', org: '', type: 'team', tg: '', email: '', phone: '', tags: [], notes: '', color: COLORS[db.all('people').length % COLORS.length] };
  modal({
    title: isNew ? 'Новый человек' : 'Карточка человека',
    wide: true,
    body: `<div class="form">
      ${formRow(
        field({ name: 'name', label: 'Имя', value: x.name, required: true, placeholder: 'Как зовут', autofocus: isNew }),
        field({ name: 'type', label: 'Кто это', type: 'select', value: x.type || 'team', options: TYPE_OPTIONS }),
      )}
      ${formRow(
        field({ name: 'role', label: 'Роль / должность', value: x.role || '', placeholder: 'Например: CTO, руководитель направления' }),
        field({ name: 'org', label: 'Компания / отдел', value: x.org || '' }),
      )}
      ${formRow(
        field({ name: 'tg', label: 'Telegram', value: x.tg || '', placeholder: '@username' }),
        field({ name: 'email', label: 'Почта', type: 'email', value: x.email || '' }),
        field({ name: 'phone', label: 'Телефон', type: 'tel', value: x.phone || '' }),
      )}
      ${field({ name: 'tags', label: 'Теги', value: (x.tags || []).join(', '), placeholder: 'через запятую: ключевой, совет директоров, финансы' })}
      ${field({ name: 'notes', label: 'Как с ним работать', type: 'textarea', value: x.notes || '', rows: 5, placeholder: 'Что ценит, чего не любит, как лучше заходить с вопросами, важные договорённости' })}
    </div>`,
    onSubmit: (d) => {
      const patch = { name: d.name.trim(), type: PERSON_TYPES[d.type] ? d.type : 'other', role: d.role || '', org: d.org || '', tg: d.tg || '', email: d.email || '', phone: d.phone || '', tags: parseTags(d.tags), notes: d.notes || '' };
      if (isNew) { const rec = db.add('people', { ...patch, color: x.color }); toast('Человек добавлен'); if (location.hash.startsWith('#/people')) location.hash = `#/people?id=${rec.id}`; }
      else { db.update('people', p.id, patch); toast('Сохранено'); }
    },
    onDelete: isNew ? undefined : () => {
      // Задачи, заметки и события человека остаются — только отвязываем их.
      for (const t of db.where('tasks', t => t.personId === p.id)) db.update('tasks', t.id, { personId: null });
      for (const n of db.where('notes', n => n.personId === p.id)) db.update('notes', n.id, { personId: null });
      for (const ev of db.where('events', ev => ev.personId === p.id)) db.update('events', ev.id, { personId: null });
      db.remove('people', p.id); toast('Человек удалён, его записи сохранены');
      if (location.hash.includes('id=')) location.hash = '#/people';
    },
  });
}

// Итог встречи / контакта: заметка type 'meeting'. personId может быть пустым — тогда человека выбирают в форме.
// note — существующая заметка для редактирования.
export function openMeetingNoteModal(personId = null, note = null) {
  const people = db.all('people').map(p => [p.id, p.name + (p.type === 'ceo' ? ' (CEO)' : '')]);
  if (!people.length && !note) { toast('Сначала добавьте человека'); openPersonModal(null); return; }
  const isNew = !note;
  const x = note || { personId, date: today(), meetingKind: 'meeting', body: '', next: '' };
  const lock = !!(x.personId && db.get('people', x.personId));
  modal({
    title: isNew ? 'Записать встречу' : 'Встреча',
    submitText: isNew ? 'Записать' : 'Сохранить',
    body: `<div class="form">
      ${lock ? `<input type="hidden" name="personId" value="${esc(x.personId)}">` : field({ name: 'personId', label: 'С кем', type: 'select', value: x.personId || people[0]?.[0] || '', options: people })}
      ${formRow(
        field({ name: 'date', label: 'Дата', type: 'date', value: x.date || today() }),
        field({ name: 'meetingKind', label: 'Формат', type: 'select', value: x.meetingKind || 'meeting', options: Object.entries(MEETING_KINDS) }),
      )}
      ${field({ name: 'body', label: 'О чём', type: 'textarea', value: x.body || '', rows: 4, required: true, placeholder: 'Что обсудили, о чём договорились, что заметила', autofocus: true })}
      ${field({ name: 'next', label: 'Следующий шаг', value: x.next || '', placeholder: 'необязательно: что сделать после этой встречи' })}
    </div>`,
    onSubmit: (d) => {
      const body = String(d.body || '').trim();
      if (!body) return false;
      const patch = { personId: d.personId || null, date: d.date || today(), meetingKind: MEETING_KINDS[d.meetingKind] ? d.meetingKind : 'other', body, next: d.next || '' };
      if (isNew) { addNote({ type: 'meeting', ...patch }); toast('Встреча записана'); }
      else { db.update('notes', note.id, { ...patch, title: body.split('\n')[0].slice(0, 80) }); toast('Сохранено'); }
    },
    onDelete: isNew ? undefined : () => { db.remove('notes', note.id); toast('Заметка удалена'); },
  });
}

// Запланировать встречу: простое событие календаря с personId.
function openEventModal(personId) {
  const p = db.get('people', personId); if (!p) return;
  modal({
    title: 'Запланировать встречу',
    submitText: 'Добавить',
    body: `<div class="form">
      ${field({ name: 'title', label: 'Название', value: `Встреча: ${p.name}`, required: true, autofocus: true })}
      ${formRow(
        field({ name: 'date', label: 'Дата', type: 'date', value: today(), required: true }),
        field({ name: 'time', label: 'Время', type: 'time', value: '' }),
      )}
    </div>`,
    onSubmit: (d) => {
      if (!d.date) return false;
      db.add('events', { title: d.title.trim(), date: d.date, time: d.time || '', endTime: '', place: '', kind: 'meeting', repeat: 'none', until: '', notes: '', personId });
      toast('Встреча в календаре');
    },
  });
}

const openPromise = (personId) => openTaskModal(null, { defaults: { personId, source: 'promise', direction: 'mine' }, lockPerson: !!personId });

// ---------- Фрагменты ----------
function taskRow(t, d, { withPerson = false } = {}) {
  const p = withPerson ? db.get('people', t.personId) : null;
  const mine = isMine(t);
  let when = '';
  if (t.date && !t.done) { const n = daysBetween(d, t.date); when = n < 0 ? `<span class="bad bold">просрочено на ${-n} ${dayWord(-n)}</span>` : n === 0 ? '<span class="warn bold">сегодня</span>' : `<span class="muted">${esc(fmtDate(t.date))}${t.time ? ' ' + esc(t.time) : ''}</span>`; }
  else if (t.done && t.doneAt) when = `<span class="faint">закрыто ${esc(fmtDate(String(t.doneAt).slice(0, 10)))}</span>`;
  const src = t.source === 'ceo' ? `<span class="pill gold">${esc(TASK_SOURCES.ceo)}</span>` : '';
  return `<div class="list-item ptask ${t.done ? 'is-done' : ''}">
    ${checkBtn(!!t.done, `data-action="t-toggle" data-id="${esc(t.id)}" aria-label="${t.done ? 'Открыть заново' : 'Выполнено'}"`)}
    <div class="main">
      <button type="button" class="title ptask-title ${t.done ? 'strike' : ''}" data-action="t-edit" data-id="${esc(t.id)}">${esc(t.title)}</button>
      <div class="sub row wrap" style="gap:6px"><span class="pill ${mine ? 'accent' : 'gold'}">${mine ? 'я обещала' : 'жду'}</span>${src}${p ? `<a class="tag" href="#/people?id=${esc(p.id)}">${esc(p.name)}</a>` : ''}${when}${t.notes ? `<span class="faint ellipsis ptask-note">${esc(t.notes)}</span>` : ''}</div>
    </div>
  </div>`;
}

function noteRow(n) {
  const type = NOTE_TYPES[n.type] || NOTE_TYPES.note;
  const kind = n.type === 'meeting' && MEETING_KINDS[n.meetingKind] && n.meetingKind !== 'meeting' ? MEETING_KINDS[n.meetingKind] : '';
  const clickable = n.type === 'meeting';
  // Заголовок заметки обычно — первая строка текста; в выдержке её не повторяем.
  const body = String(n.body || '').trim();
  const excerpt = n.title && body.startsWith(n.title) ? body.slice(n.title.length).trim() : (body !== n.title ? body : '');
  return `<div class="list-item pnote">
    <div class="main">
      ${clickable ? `<button type="button" class="title pnote-title" data-action="n-edit" data-id="${esc(n.id)}">${esc(n.title || '(без названия)')}</button>` : `<div class="title">${esc(n.title || '(без названия)')}</div>`}
      <div class="sub row wrap" style="gap:6px"><span class="pill ${n.type === 'meeting' ? 'info' : n.type === 'recommendation' ? 'gold' : ''}">${esc(kind || type)}</span><span class="muted">${esc(fmtDate(n.date))}</span>${n.quote ? '<span class="faint">цитата</span>' : ''}</div>
      ${excerpt ? `<div class="pnote-body tiny muted">${esc(excerpt)}</div>` : ''}
      ${n.next ? `<div class="tiny accent pnote-next">${icon('zap')} ${esc(n.next)}</div>` : ''}
    </div>
  </div>`;
}

function personCard(p, d) {
  const open = openTasksOfPerson(p.id);
  const mine = open.filter(isMine), theirs = open.filter(t => !isMine(t));
  const overdue = open.filter(t => t.date && t.date < d).length;
  const last = lastContactOf(p.id);
  const next = nextMeetingWith(p.id);
  const ceo = p.type === 'ceo';
  const obl = [];
  if (mine.length) obl.push(`я: ${mine.length}`);
  if (theirs.length) obl.push(`жду: ${theirs.length}`);
  return `<a class="card pcard person-card ${ceo ? 'is-ceo' : ''}" href="#/people?id=${esc(p.id)}" style="--pc:${esc(p.color || 'var(--c1)')}">
    <div class="row top" style="gap:12px">
      <span class="avatar" style="background:${esc(p.color || 'var(--c1)')}">${esc(initials(p.name))}</span>
      <div class="grow">
        <div class="person-name">${esc(p.name)}${ceo ? ' <span class="pill gold">CEO</span>' : ''}</div>
        <div class="tiny muted person-role">${[p.role, p.org].filter(Boolean).map(esc).join(' · ') || esc(PERSON_TYPES[p.type] || PERSON_TYPES.other)}</div>
      </div>
    </div>
    <div class="person-facts tiny">
      <span class="${isStale(last, d) ? 'warn' : 'muted'}">${icon('clock')} ${last ? `контакт ${sinceText(last, d)}` : 'контактов пока нет'}</span>
      ${obl.length ? `<span class="${overdue ? 'bad bold' : 'muted'}">${icon('check')} ${obl.join(' · ')}${overdue ? ` · просрочено ${overdue}` : ''}</span>` : ''}
      ${next ? `<span class="accent">${icon('calendar')} ${esc(meetingText(next))}</span>` : ''}
    </div>
    ${(p.tags || []).length ? `<div class="row wrap" style="gap:5px;margin-top:8px">${p.tags.map(tg => `<span class="tag">${esc(tg)}</span>`).join('')}</div>` : ''}
  </a>`;
}

// ---------- Страница человека ----------
function renderDetail(root, p) {
  const d = today();
  const all = personTasks(p.id);
  const mineOpen = sortBy(all.filter(t => !t.done && isMine(t)), t => t.date || '9999');
  const theirsOpen = sortBy(all.filter(t => !t.done && !isMine(t)), t => t.date || '9999');
  const done = sortBy(all.filter(t => t.done), t => t.doneAt || '', true);
  const notes = sortBy(notesOfPerson(p.id), n => `${n.date || ''}${n.createdAt || ''}`, true);
  const last = lastContactOf(p.id);
  const next = nextMeetingWith(p.id);
  const ceo = p.type === 'ceo';
  const showAll = showDone.has(p.id);
  const tg = tgLink(p.tg);
  const contacts = [
    p.tg ? (tg ? `<a class="pcontact" href="${esc(tg)}" target="_blank" rel="noopener">${icon('more')} ${esc(p.tg)}</a>` : `<span class="pcontact">${icon('more')} ${esc(p.tg)}</span>`) : '',
    p.email ? `<a class="pcontact" href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : '',
    p.phone ? `<a class="pcontact" href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : '',
  ].filter(Boolean);

  root.innerHTML = `<div class="people-page person-page">
    <div class="page-head">
      <div class="grow">
        <div class="eyebrow"><a href="#/people" class="link">${icon('chevronLeft')} Все люди</a></div>
        <h1 class="person-h1"><span class="avatar" style="background:${esc(p.color || 'var(--c1)')}">${esc(initials(p.name))}</span><span>${esc(p.name)}</span>${ceo ? '<span class="pill gold">CEO</span>' : ''}</h1>
        <div class="small muted" style="margin-top:6px">${[ceo ? '' : PERSON_TYPES[p.type], p.role, p.org].filter(Boolean).map(esc).join(' · ')}</div>
      </div>
      <div class="actions">
        <button type="button" class="btn" data-action="meeting">${icon('pen')} Записать встречу</button>
        ${pageMenu([
          { label: 'Обещание', action: 'promise', icon: 'check' },
          { label: 'Запланировать встречу', action: 'event', icon: 'calendar' },
          { label: 'Изменить карточку', action: 'edit', icon: 'edit' },
          { label: 'Настроить страницу', action: 'customize', icon: 'sliders' },
        ])}
      </div>
    </div>

    <div class="card person-meta" data-block="meta" data-block-title="Контакты и следующая встреча">
      <div class="person-meta-row">
        <span class="person-meta-label">${icon('calendar')} Следующая встреча</span>
        ${next ? `<span class="bold">${esc(meetingText(next))}</span><a class="link" href="#/calendar?date=${esc(next.on)}">в календаре</a>` : `<span class="muted">не запланирована</span><button type="button" class="link" data-action="event">запланировать</button>`}
      </div>
      <div class="person-meta-row">
        <span class="person-meta-label">${icon('clock')} Последний контакт</span>
        <span class="${isStale(last, d) ? 'warn bold' : last ? 'bold' : 'muted'}">${last ? `${esc(fmtDate(last))}${daysBetween(last, d) > 1 ? ` · ${sinceText(last, d)}` : ''}` : 'ещё не записан'}</span>
      </div>
      ${contacts.length ? `<div class="person-meta-row"><span class="person-meta-label">${icon('user')} Контакты</span><span class="row wrap" style="gap:6px 14px">${contacts.join('')}</span></div>` : ''}
    </div>

    <div class="grid-2 person-grid">
      <div class="stack">
        <div class="card" data-block="tasks" data-block-title="Открытые обязательства">
          <div class="section-title"><h2>Открытые обязательства</h2><button type="button" class="link" data-action="promise">${icon('plus')} обещание</button></div>
          ${mineOpen.length || theirsOpen.length ? `
            ${mineOpen.length ? `<div class="pgroup"><div class="pgroup-title">Я обещала <span class="faint">${mineOpen.length}</span></div><div class="list">${mineOpen.map(t => taskRow(t, d)).join('')}</div></div>` : ''}
            ${theirsOpen.length ? `<div class="pgroup"><div class="pgroup-title">Мне обещали <span class="faint">${theirsOpen.length}</span></div><div class="list">${theirsOpen.map(t => taskRow(t, d)).join('')}</div></div>` : ''}`
          : `<div class="tiny faint">Открытых обязательств нет. Обещание — это задача с человеком: что сделать мне или чего жду от него</div>`}
          ${done.length ? `<details class="acc pdone" ${showAll ? 'open' : ''} data-done><summary class="tiny muted">${icon('chevronDown')} Закрытые (${done.length})</summary><div class="list" style="opacity:.75">${done.map(t => taskRow(t, d)).join('')}</div></details>` : ''}
        </div>
        <div class="card" data-block="notes" data-block-title="Последние заметки">
          <div class="section-title"><h2>Последние заметки</h2><button type="button" class="link" data-action="meeting">${icon('plus')} встреча</button></div>
          ${notes.length ? `<div class="list">${notes.slice(0, 12).map(noteRow).join('')}</div>${notes.length > 12 ? `<div class="tiny faint" style="margin-top:8px">Показаны последние 12 из ${notes.length}</div>` : ''}`
          : `<div class="tiny faint">Записывайте итоги встреч и созвонов: о чём договорились, что заметили. Отсюда считается дата последнего контакта</div>`}
        </div>
      </div>
      <div class="stack">
        <div class="card" data-block="howto" data-block-title="Как с ним работать">
          <div class="section-title"><h2>Как с ним работать</h2><button type="button" class="link" data-action="edit">изменить</button></div>
          ${p.notes ? `<div class="pnotes">${esc(p.notes)}</div>` : '<div class="tiny faint">Запишите, что человек ценит, чего не любит и как лучше заходить с вопросами</div>'}
          ${(p.tags || []).length ? `<div class="row wrap" style="gap:5px;margin-top:12px">${p.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
        </div>
      </div>
    </div>
  </div>`;
  const view = root.firstElementChild;
  on(view, 'click', '[data-action="edit"]', () => openPersonModal(db.get('people', p.id) || p));
  on(view, 'click', '[data-action="promise"]', () => openPromise(p.id));
  on(view, 'click', '[data-action="meeting"]', () => openMeetingNoteModal(p.id));
  on(view, 'click', '[data-action="event"]', () => openEventModal(p.id));
  on(view, 'click', '[data-action="t-edit"]', (e, el) => { const t = db.get('tasks', el.dataset.id); if (t) openTaskModal(t, { lockPerson: true }); });
  on(view, 'click', '[data-action="t-toggle"]', (e, el) => { toggleTask(el.dataset.id); });
  on(view, 'click', '[data-action="n-edit"]', (e, el) => { const n = db.get('notes', el.dataset.id); if (n) openMeetingNoteModal(n.personId, n); });
  view.querySelector('[data-done]')?.addEventListener('toggle', (e) => { e.target.open ? showDone.add(p.id) : showDone.delete(p.id); });
}

// ---------- Список ----------
export async function render(root, { params = {} } = {}) {
  if (params.id) { const p = db.get('people', params.id); if (p) return renderDetail(root, p); }
  const d = today();
  const people = db.all('people');
  const open = db.all('tasks').filter(t => !t.done && t.personId && db.get('people', t.personId));
  const mineOpen = open.filter(isMine), theirsOpen = open.filter(t => !isMine(t));
  const overdue = open.filter(t => t.date && t.date < d).length;
  const stale = people.filter(p => isStale(lastContactOf(p.id), d)).length;
  const q = search.trim().toLowerCase();
  let list = people;
  if (typeFilter !== 'all') list = list.filter(p => p.type === typeFilter);
  if (q) list = list.filter(p => `${p.name} ${p.role} ${p.org} ${(p.tags || []).join(' ')} ${p.notes}`.toLowerCase().includes(q));
  const order = { ceo: 0, team: 1, partner: 2, client: 3, other: 4 };
  list = sortBy(list, p => `${order[p.type] ?? 9}-${p.name.toLowerCase()}`);
  const soon = sortBy(open.filter(t => t.date), t => `${t.date}${t.time || ''}`).slice(0, 6);
  const phone = isPhone();
  const filterLabel = typeFilter === 'all' ? 'Все люди' : PERSON_TYPES[typeFilter];
  const typesPresent = TYPE_OPTIONS.filter(([k]) => people.some(p => p.type === k));

  root.innerHTML = `<div class="people-page">
    <div class="page-head">
      <div><div class="eyebrow">Работа</div><h1>Люди</h1></div>
      <div class="actions">
        <button type="button" class="btn" data-action="new">${icon('plus')} Человек</button>
        ${people.length ? pageMenu([
          { label: 'Обещание', action: 'promise', icon: 'check' },
          { label: 'Записать встречу', action: 'meeting', icon: 'pen' },
          { label: 'Настроить страницу', action: 'customize', icon: 'sliders' },
        ]) : ''}
      </div>
    </div>
    ${!people.length ? emptyAction({ text: 'Записывайте людей, с которыми работаете: обещания в обе стороны, итоги встреч и как с каждым лучше работать, чтобы ничего не держать в голове', action: 'new', label: 'Человек' }) : `
    ${statLine([
      mineOpen.length ? `я обещала <b>${mineOpen.length}</b>` : '',
      theirsOpen.length ? `жду <b>${theirsOpen.length}</b>` : '',
      overdue ? [`<b>${overdue}</b> просрочено`, 'bad'] : '',
      stale ? [`давно не общались <b>${stale}</b>`, 'warn'] : '',
    ])}
    <div class="card people-search" data-block="search" data-block-title="Поиск и фильтры">
      <div class="people-search-row">
        <span class="muted people-search-ico">${icon('search')}</span>
        <input type="search" class="input grow" data-search placeholder="Поиск по имени, роли, заметкам…" value="${esc(search)}" aria-label="Поиск людей">
      </div>
      ${typesPresent.length > 1 || typeFilter !== 'all' ? `<details class="pfilters" ${!phone || filtersOpen ? 'open' : ''} data-filters>
        <summary class="chip ${typeFilter !== 'all' ? 'active' : ''}">${icon('filter')} ${esc(filterLabel)} · Фильтр</summary>
        <div class="chips pchips"><button type="button" class="chip ${typeFilter === 'all' ? 'active' : ''}" data-type="all">Все люди <span class="chip-n">${people.length}</span></button>${typesPresent.map(([k, l]) => `<button type="button" class="chip ${typeFilter === k ? 'active' : ''}" data-type="${k}">${esc(l)} <span class="chip-n">${people.filter(p => p.type === k).length}</span></button>`).join('')}</div>
      </details>` : ''}
    </div>
    <div data-block="list" data-block-title="Список людей">${list.length
      ? `<div class="grid-auto pgrid">${list.map(p => personCard(p, d)).join('')}</div>`
      : `<div class="empty">Никого не нашлось</div>`}</div>
    ${soon.length ? `<div class="card" data-block="soon" data-block-title="Ближайшие обязательства" style="margin-top:14px">
      <div class="section-title"><h2>Ближайшие обязательства</h2><span class="tiny muted">по сроку</span></div>
      <div class="list">${soon.map(t => taskRow(t, d, { withPerson: true })).join('')}</div>
    </div>` : ''}`}
  </div>`;
  const view = root.firstElementChild;
  on(view, 'click', '[data-action="new"]', () => openPersonModal(null));
  on(view, 'click', '[data-action="promise"]', () => { if (!people.length) { toast('Сначала добавьте человека'); return; } openPromise(null); });
  on(view, 'click', '[data-action="meeting"]', () => openMeetingNoteModal(null));
  on(view, 'click', '[data-action="t-edit"]', (e, el) => { const t = db.get('tasks', el.dataset.id); if (t) openTaskModal(t); });
  on(view, 'click', '[data-action="t-toggle"]', (e, el) => { toggleTask(el.dataset.id); });
  on(view, 'click', '[data-type]', (e, el) => { typeFilter = el.dataset.type; if (isPhone()) filtersOpen = false; render(root, {}); });
  view.querySelector('[data-filters]')?.addEventListener('toggle', (e) => { if (isPhone()) filtersOpen = e.target.open; });
  const inp = view.querySelector('[data-search]');
  inp?.addEventListener('input', () => { search = inp.value; const pos = inp.selectionStart; render(root, {}); const n = root.querySelector('[data-search]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } });
}
