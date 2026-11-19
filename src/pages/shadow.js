// Shadow — рабочее представление взаимодействия с CEO. Ничего своего не хранит:
// показывает задачи (tasks.personId = CEO), заметки (notes.personId = CEO) и события с ним.
import { db } from '../db.js';
import { esc, icon, modal, field, formRow, toast, on, today, fmtDate, daysBetween, checkBtn, emptyAction, statLine, tabs, pageMenu, sortBy, plural } from '../ui.js';
import { ceoPerson, ensureCeoPerson, nextMeetingWith, lastContactOf, toggleTask, addNote, isMine, NOTE_TYPES, MEETING_KINDS } from '../model.js';
import { openTaskModal } from './task-modal.js';
import { cheer } from '../motivation.js';

export const title = 'Shadow';

let tab = 'tasks';         // tasks | meetings | notes
let showDone = false;
let search = '';
const dayWord = (n) => plural(n, 'день', 'дня', 'дней');
const parseTags = (s) => [...new Set(String(s || '').split(/[,;]/).map(t => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))];

// ---------- модалки ----------
function openCeoModal() {
  modal({
    title: 'Кто ваш CEO',
    body: `<div class="form"><p class="small muted">Shadow показывает задачи, встречи и заметки, связанные с этим человеком. Карточку можно дополнить в разделе «Люди».</p>
      ${formRow(field({ name: 'name', label: 'Имя', value: '', required: true, placeholder: 'Имя или инициалы', autofocus: true }), field({ name: 'role', label: 'Роль', value: 'CEO' }))}</div>`,
    submitText: 'Сохранить',
    onSubmit: (d) => { const p = db.add('people', { name: d.name.trim(), type: 'ceo', role: d.role || 'CEO', org: '', tg: '', email: '', phone: '', tags: [], notes: '', color: 'var(--c3)' }); db.setSettings({ ceoPersonId: p.id }); toast('Готово'); },
  });
}

function openNoteModal(note, { type = 'note', personId } = {}) {
  const isNew = !note;
  const n = note || { type, title: '', body: '', date: today(), tags: [], pinned: false, quote: false, meetingKind: 'meeting', next: '' };
  const kind = (t) => t === 'recommendation' ? 'Рекомендация CEO' : t === 'meeting' ? 'Итог встречи' : 'Заметка о работе с CEO';
  modal({
    title: isNew ? kind(n.type) : NOTE_TYPES[n.type] || 'Запись',
    wide: true,
    body: `<div class="form">
      ${formRow(
        field({ name: 'type', label: 'Тип', type: 'select', value: n.type, options: [['recommendation', 'Рекомендация'], ['meeting', 'Итог встречи'], ['note', 'Заметка']] }),
        field({ name: 'date', label: 'Дата', type: 'date', value: n.date || today() }),
        field({ name: 'meetingKind', label: 'Формат встречи', type: 'select', value: n.meetingKind || 'meeting', options: Object.entries(MEETING_KINDS) }),
      )}
      ${field({ name: 'title', label: 'Коротко', value: n.title, required: true, placeholder: n.type === 'recommendation' ? 'Суть совета одной строкой' : n.type === 'meeting' ? 'О чём говорили' : 'О чём заметка', autofocus: isNew })}
      ${field({ name: 'body', label: 'Подробно', type: 'textarea', value: n.body || '', rows: 6, placeholder: n.type === 'recommendation' ? 'Как он это сформулировал, в какой ситуации, как применить' : n.type === 'meeting' ? 'Что обсудили, о чём договорились, что заметила' : 'Как принимает решения, что ценит, как лучше заходить с вопросами' })}
      ${field({ name: 'next', label: 'Следующий шаг', value: n.next || '', placeholder: 'необязательно: что сделать после разговора' })}
      ${field({ name: 'tags', label: 'Теги', value: (n.tags || []).join(', '), placeholder: 'через запятую' })}
      ${formRow(
        field({ name: 'pinned', label: 'Закрепить сверху', type: 'checkbox', value: !!n.pinned }),
        field({ name: 'quote', label: 'Показывать как цитату (если послания включены в настройках)', type: 'checkbox', value: !!n.quote }),
      )}
    </div>`,
    onSubmit: (d) => {
      const t = ['recommendation', 'meeting', 'note'].includes(d.type) ? d.type : 'note';
      const patch = { type: t, date: d.date || today(), title: d.title.trim(), body: d.body || '', tags: parseTags(d.tags), pinned: !!d.pinned, quote: !!d.quote, next: d.next || '', meetingKind: t === 'meeting' ? (d.meetingKind || 'meeting') : undefined, personId: personId || n.personId };
      if (isNew) { addNote(patch); toast(t === 'recommendation' ? 'Рекомендация записана' : t === 'meeting' ? 'Итог встречи записан' : 'Заметка записана'); }
      else { db.update('notes', n.id, patch); toast('Сохранено'); }
      tab = t === 'meeting' ? 'meetings' : t === 'recommendation' || t === 'note' ? 'notes' : tab;
    },
    onDelete: isNew ? undefined : () => { db.remove('notes', n.id); toast('Удалено'); },
  });
}

function openChooser(ceo) {
  const m = modal({
    title: 'Записать', noForm: true, cancelText: 'Закрыть',
    body: `<div class="chooser">
      <button type="button" class="chooser-item" data-pick="task">${icon('check')}<span><b>Задача от CEO</b><small>попадёт в План, календарь и сюда</small></span></button>
      <button type="button" class="chooser-item" data-pick="theirs">${icon('clock')}<span><b>Жду от него</b><small>что CEO обещал сделать или прислать</small></span></button>
      <button type="button" class="chooser-item" data-pick="recommendation">${icon('star')}<span><b>Рекомендация</b><small>его совет или правило; можно сделать цитатой</small></span></button>
      <button type="button" class="chooser-item" data-pick="meeting">${icon('users')}<span><b>Итог встречи</b><small>о чём говорили, договорённости, следующий шаг</small></span></button>
      <button type="button" class="chooser-item" data-pick="note">${icon('pen')}<span><b>Заметка</b><small>наблюдение о том, как с ним работать</small></span></button>
    </div>`,
  });
  m.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]'); if (!b) return;
    m.close();
    const k = b.dataset.pick;
    if (k === 'task') openTaskModal(null, { defaults: { personId: ceo.id, source: 'ceo', receivedAt: today() }, lockPerson: true });
    else if (k === 'theirs') openTaskModal(null, { defaults: { personId: ceo.id, source: 'promise', direction: 'theirs' }, lockPerson: true });
    else openNoteModal(null, { type: k, personId: ceo.id });
  });
}

// ---------- фрагменты ----------
function taskRow(x, t) {
  let when = '';
  if (x.date && !x.done) { const n = daysBetween(t, x.date); when = n < 0 ? `<span class="bad bold">просрочено на ${-n} ${dayWord(-n)}</span>` : n === 0 ? '<span class="warn bold">сегодня</span>' : n === 1 ? '<span class="warn">завтра</span>' : `<span class="muted">${esc(fmtDate(x.date))}</span>`; }
  else if (x.done && x.doneAt) when = `<span class="faint">сделано ${esc(fmtDate(String(x.doneAt).slice(0, 10)))}</span>`;
  return `<div class="list-item">
    ${checkBtn(!!x.done, `data-action="toggle" data-id="${esc(x.id)}" aria-label="Выполнено"`)}
    <div class="main" data-action="edit-task" data-id="${esc(x.id)}" style="cursor:pointer" tabindex="0" role="button">
      <div class="title ${x.done ? 'strike' : ''}">${esc(x.title)}</div>
      <div class="sub row wrap" style="gap:6px">
        ${!isMine(x) ? '<span class="pill gold">жду от него</span>' : x.source === 'promise' ? '<span class="pill accent">я обещала</span>' : ''}
        ${x.priority === 1 && !x.done ? '<span class="pill bad">срочно</span>' : ''}
        ${when}
        ${x.receivedAt ? `<span class="faint">· получено ${esc(fmtDate(x.receivedAt))}</span>` : ''}
        ${x.notes ? `<span class="faint ellipsis" style="max-width:260px">· ${esc(x.notes)}</span>` : ''}
      </div>
      ${x.done && x.result ? `<div class="tiny muted" style="margin-top:3px">${icon('check')} ${esc(x.result)}</div>` : ''}
    </div>
  </div>`;
}

function noteCard(n) {
  const label = n.type === 'recommendation' ? 'Рекомендация' : n.type === 'meeting' ? (MEETING_KINDS[n.meetingKind] || 'Встреча') : 'Заметка';
  return `<div class="card stack tight ${n.pinned ? 'is-pinned' : ''}">
    <div class="row between">
      <span class="row" style="gap:6px"><span class="pill ${n.type === 'recommendation' ? 'accent' : ''}">${esc(label)}</span>${n.pinned ? `<span class="tag">${icon('star')} закреплено</span>` : ''}${n.quote ? `<span class="tag accent">${icon('zap')} цитата</span>` : ''}</span>
      <span class="row" style="gap:6px"><span class="tiny faint">${esc(fmtDate(n.date, { relative: false }))}</span>${n.type === 'recommendation' ? `<button type="button" class="icon-btn sm ${n.quote ? 'primary' : ''}" data-action="quote-toggle" data-id="${esc(n.id)}" aria-label="${n.quote ? 'Убрать из цитат' : 'Показывать как цитату'}" data-tip="${n.quote ? 'Убрать из цитат' : 'Показывать как цитату на главной (при включённых посланиях)'}">${icon('zap')}</button>` : ''}</span>
    </div>
    <div class="bold" style="font-size:14.5px;cursor:pointer" data-action="edit-note" data-id="${esc(n.id)}" tabindex="0" role="button">${esc(n.title)}</div>
    ${n.body ? `<div class="small muted pnotes">${esc(n.body)}</div>` : ''}
    ${n.next ? `<div class="tiny accent">${icon('zap')} ${esc(n.next)}</div>` : ''}
    ${(n.tags || []).length ? `<div class="row wrap" style="gap:5px">${n.tags.map(tg => `<span class="tag">${esc(tg)}</span>`).join('')}</div>` : ''}
  </div>`;
}

// ---------- страница ----------
export async function render(root, { navigate, params = {} } = {}) {
  if (params.tab) tab = params.tab;
  const t = today();
  const ceo = ceoPerson();
  if (!ceo) {
    root.innerHTML = `<div>
      <div class="page-head"><div><div class="eyebrow">Работа</div><h1>Shadow</h1></div></div>
      ${emptyAction({ text: 'Shadow — рабочее место для взаимодействия с руководителем: его задачи, обещания в обе стороны, итоги встреч и рекомендации. Всё это обычные задачи и заметки, связанные с одним человеком. Укажите, кто ваш CEO.', action: 'set-ceo', label: 'Указать CEO' })}
    </div>`;
    on(root.firstElementChild, 'click', '[data-action="set-ceo"]', () => openCeoModal());
    return;
  }
  const tasks = db.where('tasks', x => x.personId === ceo.id);
  const notes = db.where('notes', n => n.personId === ceo.id);
  const open = sortBy(tasks.filter(x => !x.done), x => `${x.priority || 2}-${x.date || '9999'}`);
  const mineOpen = open.filter(isMine), theirsOpen = open.filter(x => !isMine(x));
  const done = sortBy(tasks.filter(x => x.done), x => x.doneAt || '', true);
  const overdue = open.filter(x => x.date && x.date < t).length;
  const next = nextMeetingWith(ceo.id);
  const last = lastContactOf(ceo.id);
  const q = search.trim().toLowerCase();
  const match = (n) => !q || `${n.title} ${n.body} ${(n.tags || []).join(' ')}`.toLowerCase().includes(q);
  const byDate = (list) => sortBy(list, n => `${n.pinned ? 0 : 1}-${String(99999999 - Number((n.date || '').replace(/-/g, '')))}`);
  const meetings = byDate(notes.filter(n => n.type === 'meeting' && match(n)));
  const others = byDate(notes.filter(n => n.type !== 'meeting' && match(n)));
  const recent = byDate(notes).slice(0, 3);
  const nextText = next ? `${fmtDate(next.on, { weekday: true })}${next.time ? `, ${next.time}` : ''}${next.title ? ` · ${esc(next.title)}` : ''}` : '';
  const nDays = next ? daysBetween(t, next.on) : null;

  const stat = statLine([
    open.length ? `<b>${open.length}</b> ${plural(open.length, 'открытое', 'открытых', 'открытых')}` : '',
    overdue ? [`${overdue} просрочено`, 'bad'] : '',
    next ? (nDays === 0 ? 'встреча сегодня' : nDays === 1 ? 'встреча завтра' : `встреча через ${nDays} ${dayWord(nDays)}`) : '',
    last ? `последний контакт ${esc(fmtDate(last))}` : '',
  ]);

  const tabsHtml = tabs([['tasks', 'Обязательства', open.length || ''], ['meetings', 'Встречи', meetings.length || ''], ['notes', 'Заметки', others.length || '']], tab);
  let body = '';
  if (tab === 'tasks') {
    body = `<div class="card" data-block="tasks" data-block-title="Обязательства">
      ${mineOpen.length ? `<div class="list">${mineOpen.map(x => taskRow(x, t)).join('')}</div>` : ''}
      ${theirsOpen.length ? `<div class="label caps" style="margin:${mineOpen.length ? '14px' : '0'} 0 6px">Жду от него</div><div class="list">${theirsOpen.map(x => taskRow(x, t)).join('')}</div>` : ''}
      ${!open.length ? `<div class="empty-row"><span>Открытых обязательств нет</span><button type="button" class="link" data-action="new">+ записать</button></div>` : ''}
      ${done.length ? `<button type="button" class="link" data-action="toggle-done" style="margin-top:10px">${showDone ? 'Скрыть выполненные' : `Выполненные (${done.length})`}</button>${showDone ? `<div class="list" style="opacity:.75;margin-top:4px">${done.map(x => taskRow(x, t)).join('')}</div>` : ''}` : ''}
    </div>`;
  } else if (tab === 'meetings') {
    body = `<div class="stack" data-block="meetings" data-block-title="Встречи">
      ${next ? `<div class="card row between" style="gap:10px"><div><div class="label caps">Следующая встреча</div><div class="bold">${nextText}</div>${next.place ? `<div class="tiny muted">${esc(next.place)}</div>` : ''}</div><button type="button" class="btn secondary sm" data-action="go-cal" data-date="${esc(next.on)}">календарь</button></div>`
        : `<div class="empty-row"><span>${icon('calendar')} Встреча с CEO не запланирована</span><button type="button" class="link" data-action="plan-meeting">+ запланировать</button></div>`}
      ${meetings.length ? meetings.map(noteCard).join('') : `<div class="empty-row"><span>Итогов встреч пока нет</span><button type="button" class="link" data-action="new-meeting">+ записать итог</button></div>`}
    </div>`;
  } else {
    body = `<div class="stack" data-block="notes" data-block-title="Рекомендации и заметки">
      ${others.length ? others.map(noteCard).join('') : `<div class="empty-row"><span>${q ? 'Ничего не нашлось' : 'Рекомендаций и заметок пока нет'}</span><button type="button" class="link" data-action="new-advice">+ рекомендация</button></div>`}
    </div>`;
  }

  root.innerHTML = `<div>
    <div class="page-head">
      <div><div class="eyebrow">Работа</div><h1>Shadow — ${esc(ceo.name)}</h1>${next ? `<div class="small muted" style="margin-top:6px">${icon('calendar')} Следующая встреча: ${nextText}</div>` : ''}${stat}</div>
      <div class="actions">
        <button class="btn" data-action="new">${icon('plus')} Записать</button>
        ${pageMenu([{ label: 'Карточка CEO в «Людях»', action: 'go-person', icon: 'user' }, { label: 'Запланировать встречу', action: 'plan-meeting', icon: 'calendar' }, { label: 'Настроить страницу', action: 'customize', icon: 'sliders' }])}
      </div>
    </div>
    <form class="card row quick-add" data-quick style="gap:8px;margin-bottom:14px">
      <input class="input grow" name="text" placeholder="Записать после разговора… (сохранится как итог встречи)" autocomplete="off" aria-label="Итог разговора">
      <button class="icon-btn primary" type="submit" aria-label="Сохранить">${icon('arrowUp')}</button>
    </form>
    <div class="row between wrap" style="gap:8px">${tabsHtml}${tab !== 'tasks' ? `<input class="input" type="search" placeholder="Поиск…" value="${esc(search)}" data-search style="width:180px;padding:7px 10px;margin-bottom:16px" aria-label="Поиск по записям">` : ''}</div>
    ${body}
    ${tab === 'tasks' && recent.length ? `<div class="section-title"><h2>Последние записи</h2><button type="button" class="link" data-action="tab" data-tab="notes">все</button></div><div class="stack tight">${recent.map(n => `<div class="row between" style="gap:10px"><div class="main"><span class="pill ${n.type === 'recommendation' ? 'accent' : ''}">${esc(n.type === 'recommendation' ? 'Рекомендация' : n.type === 'meeting' ? 'Итог встречи' : 'Заметка')}</span> <span class="small" data-action="edit-note" data-id="${esc(n.id)}" style="cursor:pointer">${esc(n.title)}</span></div><span class="tiny faint">${esc(fmtDate(n.date))}</span></div>`).join('')}</div>` : ''}
  </div>`;
  const view = root.firstElementChild;

  on(view, 'click', '[data-action="new"]', () => openChooser(ceo));
  on(view, 'click', '[data-action="new-meeting"]', () => openNoteModal(null, { type: 'meeting', personId: ceo.id }));
  on(view, 'click', '[data-action="new-advice"]', () => openNoteModal(null, { type: 'recommendation', personId: ceo.id }));
  on(view, 'click', '[data-action="go-person"]', () => navigate('people', { id: ceo.id }));
  on(view, 'click', '[data-action="go-cal"]', (e, el) => navigate('plan', { tab: 'week', date: el.dataset.date }));
  on(view, 'click', '[data-action="plan-meeting"]', () => modal({
    title: 'Встреча с CEO', submitText: 'Добавить',
    body: `<div class="form">${field({ name: 'title', label: 'Что', value: `Встреча с ${ceo.name}`, required: true })}${formRow(field({ name: 'date', label: 'Дата', type: 'date', value: t, required: true }), field({ name: 'time', label: 'Время', type: 'time', value: '' }))}${field({ name: 'place', label: 'Где / ссылка', value: '' })}</div>`,
    onSubmit: (d) => { db.add('events', { title: d.title.trim(), date: d.date, time: d.time || '', endTime: '', place: d.place || '', kind: 'meeting', personId: ceo.id, repeat: 'none', until: '', notes: '' }); toast('Встреча добавлена в календарь'); },
  }));
  on(view, 'click', '[data-action="edit-task"]', (e, el) => { const x = db.get('tasks', el.dataset.id); if (x) openTaskModal(x); });
  on(view, 'keydown', '[role=button][data-action]', (e, el) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } });
  on(view, 'click', '[data-action="edit-note"]', (e, el) => { const n = db.get('notes', el.dataset.id); if (n) openNoteModal(n, { personId: ceo.id }); });
  on(view, 'click', '[data-action="toggle"]', (e, el) => { const x = db.get('tasks', el.dataset.id); if (!x) return; toggleTask(x.id); if (!x.done) { const c = cheer(); if (c) toast(c, 1800); } });
  on(view, 'click', '[data-action="toggle-done"]', () => { showDone = !showDone; render(root, { navigate }); });
  on(view, 'click', '[data-action="quote-toggle"]', (e, el) => { const n = db.get('notes', el.dataset.id); if (!n) return; db.update('notes', n.id, { quote: !n.quote }); toast(n.quote ? 'Убрано из цитат' : (db.settings().quotes ? 'Будет появляться как послание на главной' : 'Пометка сохранена. Послания выключены в настройках — включите «Показывать послания», чтобы видеть их')); });
  on(view, 'click', '[data-action="tab"]', (e, el) => { tab = el.dataset.tab; render(root, { navigate }); });
  on(view, 'click', '[data-tab]', (e, el) => { tab = el.dataset.tab; render(root, { navigate }); });
  on(view, 'submit', 'form[data-quick]', (e, form) => {
    e.preventDefault();
    const text = form.text.value.trim(); if (!text) return;
    addNote({ type: 'meeting', title: text.split('\n')[0].slice(0, 80), body: text.length > 80 ? text : '', date: t, personId: ceo.id, meetingKind: 'meeting', next: '' });
    form.reset(); toast('Итог встречи записан');
  });
  const inp = view.querySelector('[data-search]');
  if (inp) inp.addEventListener('input', () => { search = inp.value; const pos = inp.selectionStart; render(root, { navigate }); const n = root.querySelector('[data-search]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } });
}
