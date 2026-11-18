import { db } from '../db.js';
import {
  esc, icon, modal, field, formRow, toast, on,
  today, fmtDate, daysBetween, checkBtn, emptyState, sortBy, plural,
} from '../ui.js';

export const title = 'Shadow';

// ---------- Локальное состояние ----------
let showDone = false;      // показывать выполненные задачи
let noteTab = 'advice';    // advice | note — правая колонка
let search = '';           // поиск по рекомендациям и заметкам

// ---------- Справочники ----------
const PRIORITY_OPTIONS = [[1, 'Срочно'], [2, 'Обычная'], [3, 'Когда будет время']];
const PRIORITY = { 1: ['срочно', 'bad'], 2: ['', ''], 3: ['не срочно', ''] };
const NOTE_TYPES = { advice: 'Рекомендация', note: 'Заметка' };
const NOTE_TYPE_OPTIONS = Object.entries(NOTE_TYPES);
const dayWord = (n) => plural(n, 'день', 'дня', 'дней');
const parseTags = (s) => String(s || '').split(/[,;]/).map(t => t.trim()).filter(Boolean);

// ---------- Модалки ----------
function openTaskModal(task) {
  const isNew = !task;
  const x = task || { title: '', context: '', deadline: null, priority: 2, done: false, result: '' };
  modal({
    title: isNew ? 'Задача от CEO' : 'Задача',
    body: `<div class="form">
      ${field({ name: 'title', label: 'Что нужно сделать', value: x.title, required: true, placeholder: 'Формулировка так, как прозвучала', autofocus: isNew })}
      ${field({ name: 'context', label: 'Контекст', type: 'textarea', value: x.context || '', rows: 3, placeholder: 'Зачем это ему, что ожидает увидеть, какие детали важны' })}
      ${formRow(
        field({ name: 'deadline', label: 'Срок', type: 'date', value: x.deadline || '' }),
        field({ name: 'priority', label: 'Приоритет', type: 'select', value: x.priority || 2, options: PRIORITY_OPTIONS }),
      )}
      ${isNew ? '' : field({ name: 'result', label: 'Результат / что ответила', type: 'textarea', value: x.result || '', rows: 3, placeholder: 'Чем закончилось, какая была реакция' })}
    </div>`,
    onSubmit: (d) => {
      const patch = { title: d.title.trim(), context: d.context || '', deadline: d.deadline || null, priority: Number(d.priority) || 2 };
      if (!isNew) patch.result = d.result || '';
      if (isNew) { db.add('shadowTasks', { ...patch, done: false, doneAt: null, result: '', receivedAt: today() }); toast('Задача записана'); }
      else { db.update('shadowTasks', x.id, patch); toast('Сохранено'); }
    },
    onDelete: isNew ? undefined : () => { db.remove('shadowTasks', x.id); toast('Удалено'); },
  });
}

function openNoteModal(note, type = noteTab) {
  const isNew = !note;
  const n = note || { type, title: '', body: '', date: today(), tags: [], pinned: false };
  modal({
    title: isNew ? (n.type === 'advice' ? 'Рекомендация от CEO' : 'Заметка о работе с CEO') : NOTE_TYPES[n.type] || 'Запись',
    wide: true,
    body: `<div class="form">
      ${formRow(
        field({ name: 'type', label: 'Тип', type: 'select', value: n.type, options: NOTE_TYPE_OPTIONS }),
        field({ name: 'date', label: 'Дата', type: 'date', value: n.date || today() }),
      )}
      ${field({ name: 'title', label: 'Коротко', value: n.title, required: true, placeholder: n.type === 'advice' ? 'Суть совета одной строкой' : 'О чём заметка', autofocus: isNew })}
      ${field({ name: 'body', label: 'Подробно', type: 'textarea', value: n.body || '', rows: 6, placeholder: n.type === 'advice' ? 'Как он это сформулировал, в какой ситуации, как применить' : 'Что заметила: как он принимает решения, что ценит, чего не любит, как лучше заходить с вопросами' })}
      ${field({ name: 'tags', label: 'Теги', value: (n.tags || []).join(', '), placeholder: 'через запятую: встречи, презентации, стиль' })}
      ${field({ name: 'pinned', label: 'Закрепить сверху', type: 'checkbox', value: !!n.pinned })}
    </div>`,
    onSubmit: (d) => {
      const patch = { type: NOTE_TYPES[d.type] ? d.type : 'note', date: d.date || today(), title: d.title.trim(), body: d.body || '', tags: parseTags(d.tags), pinned: !!d.pinned };
      if (isNew) { db.add('shadowNotes', patch); toast(patch.type === 'advice' ? 'Рекомендация записана' : 'Заметка записана'); }
      else { db.update('shadowNotes', n.id, patch); toast('Сохранено'); }
      noteTab = patch.type;
    },
    onDelete: isNew ? undefined : () => { db.remove('shadowNotes', n.id); toast('Удалено'); },
  });
}

// ---------- Карточки ----------
function taskRow(x, t) {
  const [pl, pc] = PRIORITY[x.priority] || PRIORITY[2];
  let when = '';
  if (x.deadline && !x.done) {
    const n = daysBetween(t, x.deadline);
    when = n < 0 ? `<span class="bad bold">просрочено на ${-n} ${dayWord(-n)}</span>` : n === 0 ? '<span class="warn bold">сегодня</span>' : n === 1 ? '<span class="warn">завтра</span>' : `<span class="muted">${esc(fmtDate(x.deadline))}</span>`;
  } else if (x.done && x.doneAt) when = `<span class="faint">сделано ${esc(fmtDate(x.doneAt))}</span>`;
  return `<div class="list-item">
    ${checkBtn(!!x.done, `data-action="toggle" data-id="${esc(x.id)}" aria-label="Выполнено"`)}
    <div class="main" data-action="edit-task" data-id="${esc(x.id)}" style="cursor:pointer">
      <div class="title ${x.done ? 'strike' : ''}">${esc(x.title)}</div>
      <div class="sub row wrap" style="gap:6px">
        ${pl && !x.done ? `<span class="pill ${pc}">${pl}</span>` : ''}
        ${when}
        ${x.receivedAt ? `<span class="faint">· получено ${esc(fmtDate(x.receivedAt))}</span>` : ''}
        ${x.context ? `<span class="faint ellipsis" style="max-width:260px">· ${esc(x.context)}</span>` : ''}
      </div>
      ${x.done && x.result ? `<div class="tiny muted" style="margin-top:3px">${icon('check')} ${esc(x.result)}</div>` : ''}
    </div>
  </div>`;
}

function noteCard(n) {
  return `<div class="card stack tight ${n.pinned ? 'is-pinned' : ''}">
    <div class="row between">
      <span class="row" style="gap:6px"><span class="pill ${n.type === 'advice' ? 'accent' : ''}">${esc(NOTE_TYPES[n.type] || 'Заметка')}</span>${n.pinned ? `<span class="tag">${icon('star')} закреплено</span>` : ''}</span>
      <span class="tiny faint">${esc(fmtDate(n.date, { relative: false }))}</span>
    </div>
    <div class="bold" style="font-size:14.5px;cursor:pointer" data-action="edit-note" data-id="${esc(n.id)}">${esc(n.title)}</div>
    ${n.body ? `<div class="small muted pnotes">${esc(n.body)}</div>` : ''}
    ${(n.tags || []).length ? `<div class="row wrap" style="gap:5px">${n.tags.map(tg => `<span class="tag">${esc(tg)}</span>`).join('')}</div>` : ''}
  </div>`;
}

// ---------- Страница ----------
export async function render(root) {
  const t = today();
  const tasks = db.all('shadowTasks');
  const notes = db.all('shadowNotes');
  const open = sortBy(tasks.filter(x => !x.done), x => `${x.priority || 2}-${x.deadline || '9999'}`);
  const done = sortBy(tasks.filter(x => x.done), x => x.doneAt || '', true);
  const overdue = open.filter(x => x.deadline && x.deadline < t).length;
  const q = search.trim().toLowerCase();
  const list = sortBy(
    notes.filter(n => n.type === noteTab && (!q || `${n.title} ${n.body} ${(n.tags || []).join(' ')}`.toLowerCase().includes(q))),
    n => `${n.pinned ? 0 : 1}-${String(99999999 - Number((n.date || '').replace(/-/g, '')))}`,
  );
  const adviceCount = notes.filter(n => n.type === 'advice').length;
  const noteCount = notes.length - adviceCount;

  root.innerHTML = `<div>
    <div class="page-head">
      <div><div class="eyebrow">Работа с CEO</div><h1>Shadow</h1></div>
      <div class="actions">
        <button class="btn secondary" data-action="new-note" data-type="advice">${icon('star')} Рекомендация</button>
        <button class="btn secondary" data-action="new-note" data-type="note">${icon('pen')} Заметка</button>
        <button class="btn" data-action="new-task">${icon('plus')} Задача от CEO</button>
      </div>
    </div>
    <div class="grid-4" style="margin-bottom:18px">
      <div class="stat"><span class="label">${icon('target')} Открытых задач</span><span class="value ${overdue ? 'bad' : ''}">${open.length}</span><span class="sub">${overdue ? `просрочено: ${overdue}` : 'всё в сроке'}</span></div>
      <div class="stat"><span class="label">${icon('check')} Выполнено</span><span class="value">${done.length}</span><span class="sub">за всё время</span></div>
      <div class="stat"><span class="label">${icon('star')} Рекомендаций</span><span class="value">${adviceCount}</span><span class="sub">его советы и правила</span></div>
      <div class="stat"><span class="label">${icon('pen')} Заметок</span><span class="value">${noteCount}</span><span class="sub">наблюдения о работе с ним</span></div>
    </div>
    <div class="grid-2" style="align-items:start">
      <div class="card">
        <div class="section-title"><h2>Задачи от CEO</h2><button class="link" data-action="toggle-done">${showDone ? 'Скрыть выполненные' : `Выполненные (${done.length})`}</button></div>
        ${open.length ? `<div class="list">${open.map(x => taskRow(x, t)).join('')}</div>` : emptyState('Пока нет открытых задач. Записывайте сразу после разговора, пока формулировка свежая', '📝')}
        ${showDone && done.length ? `<div class="divider" style="margin:12px 0"></div><div class="label caps" style="margin-bottom:6px">Выполненные</div><div class="list">${done.map(x => taskRow(x, t)).join('')}</div>` : ''}
      </div>
      <div class="stack">
        <div class="row between wrap" style="gap:8px">
          <div class="seg">
            <button type="button" class="${noteTab === 'advice' ? 'active' : ''}" data-action="note-tab" data-tab="advice">Рекомендации</button>
            <button type="button" class="${noteTab === 'note' ? 'active' : ''}" data-action="note-tab" data-tab="note">Заметки</button>
          </div>
          <input class="input" type="search" placeholder="Поиск…" value="${esc(search)}" data-search style="width:180px;padding:7px 10px">
        </div>
        ${list.length
          ? list.map(noteCard).join('')
          : `<div class="card">${emptyState(noteTab === 'advice'
              ? 'Сюда идут его советы, правила и формулировки, которые стоит запомнить. Закрепляйте главные'
              : 'Сюда идут наблюдения: как он принимает решения, что ценит, как лучше заходить с вопросами', noteTab === 'advice' ? '💡' : '🧭')}</div>`}
      </div>
    </div></div>`;
  const view = root.firstElementChild;

  on(view, 'click', '[data-action="new-task"]', () => openTaskModal(null));
  on(view, 'click', '[data-action="new-note"]', (e, el) => openNoteModal(null, el.dataset.type));
  on(view, 'click', '[data-action="edit-task"]', (e, el) => { const x = db.get('shadowTasks', el.dataset.id); if (x) openTaskModal(x); });
  on(view, 'click', '[data-action="edit-note"]', (e, el) => { const n = db.get('shadowNotes', el.dataset.id); if (n) openNoteModal(n); });
  on(view, 'click', '[data-action="toggle"]', (e, el) => {
    const x = db.get('shadowTasks', el.dataset.id); if (!x) return;
    db.update('shadowTasks', x.id, x.done ? { done: false, doneAt: null } : { done: true, doneAt: today() });
    if (!x.done) toast('Отмечено выполненным. Добавьте результат в карточке, если важно запомнить реакцию');
  });
  on(view, 'click', '[data-action="toggle-done"]', () => { showDone = !showDone; render(root); });
  on(view, 'click', '[data-action="note-tab"]', (e, el) => { noteTab = el.dataset.tab; render(root); });
  const inp = view.querySelector('[data-search]');
  inp.addEventListener('input', () => { search = inp.value; const pos = inp.selectionStart; render(root); const n = view.querySelector('[data-search]'); n.focus(); n.setSelectionRange(pos, pos); });
}
