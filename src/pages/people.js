// Люди и обязательства: команда, партнёры, CEO. У человека — обещания в обе стороны,
// журнал контактов (из него считается дата последнего контакта) и заметки «как с ним работать».
import { db } from '../db.js';
import { esc, icon, modal, field, formRow, toast, on, today, fmtDate, daysBetween, checkBtn, emptyState, sortBy, plural } from '../ui.js';

export const title = 'Люди';

export const PERSON_TYPES = { ceo: 'CEO / руководство', team: 'Команда', partner: 'Партнёры', client: 'Клиенты', other: 'Другие' };
const TYPE_OPTIONS = Object.entries(PERSON_TYPES);
const DIRECTIONS = { mine: 'Я обещала', theirs: 'Мне обещали' };
const STALE_DAYS = 30;

let typeFilter = 'all';
let search = '';
let showDone = new Set();

const parseTags = (s) => [...new Set(String(s || '').split(/[,;]/).map(x => x.trim()).filter(Boolean))];
const dayWord = (n) => plural(n, 'день', 'дня', 'дней');
const initials = (name) => String(name || '?').split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)'];

export function lastContactOf(personId) {
  const logs = db.where('contacts', c => c.personId === personId);
  return logs.length ? logs.map(c => c.date).sort().at(-1) : null;
}

// ---------- Модалки ----------
function openPersonModal(p) {
  const isNew = !p;
  const x = p || { name: '', role: '', org: '', type: 'team', tg: '', email: '', phone: '', tags: [], notes: '', color: COLORS[db.all('people').length % COLORS.length] };
  modal({
    title: isNew ? 'Новый человек' : 'Человек',
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
        field({ name: 'phone', label: 'Телефон', value: x.phone || '' }),
      )}
      ${field({ name: 'tags', label: 'Теги', value: (x.tags || []).join(', '), placeholder: 'через запятую: ключевой, совет директоров, финансы' })}
      ${field({ name: 'notes', label: 'Как с ним работать', type: 'textarea', value: x.notes || '', rows: 5, placeholder: 'Что ценит, чего не любит, как лучше заходить с вопросами, важные договорённости' })}
    </div>`,
    onSubmit: (d) => {
      const patch = { name: d.name.trim(), type: PERSON_TYPES[d.type] ? d.type : 'other', role: d.role || '', org: d.org || '', tg: d.tg || '', email: d.email || '', phone: d.phone || '', tags: parseTags(d.tags), notes: d.notes || '' };
      if (isNew) { db.add('people', { ...patch, color: x.color }); toast('Добавлено'); }
      else { db.update('people', p.id, patch); toast('Сохранено'); }
    },
    onDelete: isNew ? undefined : () => {
      for (const c of db.where('commitments', c => c.personId === p.id)) db.remove('commitments', c.id);
      for (const c of db.where('contacts', c => c.personId === p.id)) db.remove('contacts', c.id);
      db.remove('people', p.id); toast('Удалено');
    },
  });
}

function openCommitmentModal(c, personId) {
  const isNew = !c;
  const x = c || { personId, direction: 'mine', title: '', due: null, notes: '', done: false };
  const people = db.all('people').map(p => [p.id, p.name]);
  modal({
    title: isNew ? 'Обязательство' : 'Обязательство',
    body: `<div class="form">
      ${formRow(
        field({ name: 'direction', label: 'Кто кому', type: 'select', value: x.direction, options: Object.entries(DIRECTIONS) }),
        field({ name: 'personId', label: 'Человек', type: 'select', value: x.personId || '', options: people }),
      )}
      ${field({ name: 'title', label: 'Что именно', value: x.title, required: true, placeholder: 'Сделать, прислать, решить…', autofocus: isNew })}
      ${formRow(
        field({ name: 'due', label: 'Срок', type: 'date', value: x.due || '' }),
        field({ name: 'notes', label: 'Контекст', value: x.notes || '', placeholder: 'где договорились, детали' }),
      )}
    </div>`,
    onSubmit: (d) => {
      const patch = { personId: d.personId, direction: d.direction === 'theirs' ? 'theirs' : 'mine', title: d.title.trim(), due: d.due || null, notes: d.notes || '' };
      if (isNew) { db.add('commitments', { ...patch, done: false, doneAt: null }); toast('Записано'); }
      else { db.update('commitments', c.id, patch); toast('Сохранено'); }
    },
    onDelete: isNew ? undefined : () => { db.remove('commitments', c.id); toast('Удалено'); },
  });
}

function openContactModal(personId) {
  modal({
    title: 'Записать контакт',
    submitText: 'Записать',
    body: `<div class="form">
      ${formRow(
        field({ name: 'date', label: 'Дата', type: 'date', value: today() }),
        field({ name: 'kind', label: 'Формат', type: 'select', value: 'meeting', options: [['meeting', 'Встреча'], ['call', 'Созвон'], ['chat', 'Переписка'], ['other', 'Другое']] }),
      )}
      ${field({ name: 'text', label: 'О чём', type: 'textarea', value: '', rows: 4, required: true, placeholder: 'Что обсудили, о чём договорились, что заметила', autofocus: true })}
      ${field({ name: 'next', label: 'Следующий шаг', value: '', placeholder: 'необязательно: что сделать после этого контакта' })}
    </div>`,
    onSubmit: (d) => {
      db.add('contacts', { personId, date: d.date || today(), kind: d.kind || 'other', text: String(d.text || '').trim(), next: d.next || '' });
      toast('Контакт записан');
    },
  });
}

// ---------- Фрагменты ----------
function commitmentRow(c, t, { withPerson = false } = {}) {
  const p = withPerson ? db.get('people', c.personId) : null;
  let when = '';
  if (c.due && !c.done) { const n = daysBetween(t, c.due); when = n < 0 ? `<span class="bad bold">просрочено на ${-n} ${dayWord(-n)}</span>` : n === 0 ? '<span class="warn bold">сегодня</span>' : `<span class="muted">${esc(fmtDate(c.due))}</span>`; }
  else if (c.done && c.doneAt) when = `<span class="faint">закрыто ${esc(fmtDate(c.doneAt))}</span>`;
  return `<div class="list-item">
    ${checkBtn(!!c.done, `data-action="c-toggle" data-id="${esc(c.id)}" aria-label="Выполнено"`)}
    <div class="main" data-action="c-edit" data-id="${esc(c.id)}" style="cursor:pointer">
      <div class="title ${c.done ? 'strike' : ''}">${esc(c.title)}</div>
      <div class="sub row wrap" style="gap:6px"><span class="pill ${c.direction === 'mine' ? 'accent' : 'gold'}">${esc(DIRECTIONS[c.direction])}</span>${p ? `<a class="tag" href="#/people?id=${esc(p.id)}">${esc(p.name)}</a>` : ''}${when}${c.notes ? `<span class="faint ellipsis" style="max-width:220px">${esc(c.notes)}</span>` : ''}</div>
    </div>
  </div>`;
}

function personCard(p, t) {
  const open = db.where('commitments', c => c.personId === p.id && !c.done);
  const mine = open.filter(c => c.direction === 'mine').length, theirs = open.length - mine;
  const overdue = open.filter(c => c.due && c.due < t).length;
  const last = lastContactOf(p.id);
  const since = last ? daysBetween(last, t) : null;
  return `<a class="card pcard person-card" href="#/people?id=${esc(p.id)}" style="--pc:${esc(p.color || 'var(--c1)')}">
    <div class="row" style="gap:12px">
      <span class="avatar" style="background:${esc(p.color || 'var(--c1)')}">${esc(initials(p.name))}</span>
      <div class="main" style="min-width:0">
        <div class="bold" style="font-size:15px">${esc(p.name)}</div>
        <div class="tiny muted ellipsis">${[p.role, p.org].filter(Boolean).map(esc).join(' · ') || esc(PERSON_TYPES[p.type] || '')}</div>
      </div>
      <span class="pill ${p.type === 'ceo' ? 'gold' : ''}">${esc(PERSON_TYPES[p.type] || 'Другие')}</span>
    </div>
    <div class="row wrap tiny" style="gap:8px;margin-top:10px">
      <span class="${overdue ? 'bad bold' : 'muted'}">${icon('check')} я: ${mine}${theirs ? ` · мне: ${theirs}` : ''}${overdue ? ` · просрочено ${overdue}` : ''}</span>
      <span class="${since != null && since > STALE_DAYS ? 'warn' : 'muted'}">${icon('clock')} ${last ? `контакт ${since === 0 ? 'сегодня' : `${since} ${dayWord(since)} назад`}` : 'контактов нет'}</span>
    </div>
    ${(p.tags || []).length ? `<div class="row wrap" style="gap:5px;margin-top:8px">${p.tags.map(tg => `<span class="tag">${esc(tg)}</span>`).join('')}</div>` : ''}
  </a>`;
}

// ---------- Страница человека ----------
function renderDetail(root, p) {
  const t = today();
  const comms = db.where('commitments', c => c.personId === p.id);
  const mineOpen = sortBy(comms.filter(c => c.direction === 'mine' && !c.done), c => c.due || '9999');
  const theirsOpen = sortBy(comms.filter(c => c.direction === 'theirs' && !c.done), c => c.due || '9999');
  const done = sortBy(comms.filter(c => c.done), c => c.doneAt || '', true);
  const logs = sortBy(db.where('contacts', c => c.personId === p.id), c => c.date + (c.createdAt || ''), true);
  const last = logs[0]?.date || null;
  const since = last ? daysBetween(last, t) : null;
  const KIND = { meeting: 'встреча', call: 'созвон', chat: 'переписка', other: '' };
  const showAll = showDone.has(p.id);

  root.innerHTML = `<div>
    <div class="page-head">
      <div>
        <div class="eyebrow"><a href="#/people" class="link">${icon('chevronLeft')} Все люди</a></div>
        <h1 style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><span class="avatar" style="background:${esc(p.color || 'var(--c1)')};width:40px;height:40px;font-size:15px">${esc(initials(p.name))}</span>${esc(p.name)}</h1>
        <div class="small muted" style="margin-top:4px">${[PERSON_TYPES[p.type], p.role, p.org].filter(Boolean).map(esc).join(' · ')}</div>
      </div>
      <div class="actions">
        <button class="btn secondary" data-action="edit">${icon('edit')} Карточка</button>
        <button class="btn secondary" data-action="commit">${icon('plus')} Обещание</button>
        <button class="btn" data-action="contact">${icon('pen')} Записать контакт</button>
      </div>
    </div>
    <div class="grid-2" style="align-items:start">
      <div class="stack">
        <div class="card" data-block="mine" data-block-title="Я обещала">
          <div class="section-title"><h2>Я обещала</h2><span class="tiny muted">${mineOpen.length}</span></div>
          ${mineOpen.length ? `<div class="list">${mineOpen.map(c => commitmentRow(c, t)).join('')}</div>` : '<div class="tiny faint">Открытых обещаний нет</div>'}
        </div>
        <div class="card" data-block="theirs" data-block-title="Мне обещали">
          <div class="section-title"><h2>Мне обещали</h2><span class="tiny muted">${theirsOpen.length}</span></div>
          ${theirsOpen.length ? `<div class="list">${theirsOpen.map(c => commitmentRow(c, t)).join('')}</div>` : '<div class="tiny faint">Пока ничего не ждём</div>'}
          ${done.length ? `<button type="button" class="link" data-action="toggle-done" style="margin-top:8px">${showAll ? 'Скрыть закрытые' : `Закрытые (${done.length})`}</button>${showAll ? `<div class="list" style="opacity:.7">${done.map(c => commitmentRow(c, t)).join('')}</div>` : ''}` : ''}
        </div>
      </div>
      <div class="stack">
        <div class="card" data-block="info" data-block-title="Как с ним работать">
          <div class="section-title"><h2>Как с ним работать</h2><button type="button" class="link" data-action="edit">изменить</button></div>
          ${p.notes ? `<div class="pnotes small muted">${esc(p.notes)}</div>` : '<div class="tiny faint">Запишите, что человек ценит, чего не любит и как лучше заходить с вопросами</div>'}
          <div class="row wrap tiny muted" style="gap:10px;margin-top:10px">
            ${p.tg ? `<span>${icon('more')} ${esc(p.tg)}</span>` : ''}${p.email ? `<a class="link" href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : ''}${p.phone ? `<a class="link" href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : ''}
            ${(p.tags || []).map(tg => `<span class="tag">${esc(tg)}</span>`).join('')}
          </div>
        </div>
        <div class="card" data-block="contacts" data-block-title="Контакты">
          <div class="section-title"><h2>Контакты</h2><span class="tiny ${since != null && since > STALE_DAYS ? 'warn' : 'muted'}">${last ? `последний ${since === 0 ? 'сегодня' : `${since} ${dayWord(since)} назад`}` : 'ещё не было'}</span></div>
          ${logs.length ? `<div class="plog" style="border:0;padding:0">${logs.slice(0, 20).map(l => `<div class="plog-item"><span class="plog-date mono">${esc(fmtDate(l.date))}</span><span class="plog-text">${KIND[l.kind] ? `<span class="tag">${KIND[l.kind]}</span> ` : ''}${esc(l.text)}${l.next ? `<div class="tiny accent" style="margin-top:3px">${icon('zap')} ${esc(l.next)}</div>` : ''}</span><button type="button" class="icon-btn sm plog-del" data-action="log-del" data-id="${esc(l.id)}" aria-label="Удалить">${icon('x')}</button></div>`).join('')}</div>`
          : emptyState('Записывайте встречи и созвоны: о чём договорились, что заметили. Отсюда считается дата последнего контакта', '🤝')}
        </div>
      </div>
    </div>
  </div>`;
  const view = root.firstElementChild;
  on(view, 'click', '[data-action="edit"]', () => openPersonModal(db.get('people', p.id) || p));
  on(view, 'click', '[data-action="commit"]', () => openCommitmentModal(null, p.id));
  on(view, 'click', '[data-action="contact"]', () => openContactModal(p.id));
  on(view, 'click', '[data-action="c-edit"]', (e, el) => { const c = db.get('commitments', el.dataset.id); if (c) openCommitmentModal(c, p.id); });
  on(view, 'click', '[data-action="c-toggle"]', (e, el) => { const c = db.get('commitments', el.dataset.id); if (c) db.update('commitments', c.id, c.done ? { done: false, doneAt: null } : { done: true, doneAt: today() }); });
  on(view, 'click', '[data-action="toggle-done"]', () => { showDone.has(p.id) ? showDone.delete(p.id) : showDone.add(p.id); renderDetail(root, db.get('people', p.id) || p); });
  on(view, 'click', '[data-action="log-del"]', (e, el) => { if (confirm('Удалить запись о контакте?')) db.remove('contacts', el.dataset.id); });
}

// ---------- Список ----------
export async function render(root, { params = {} } = {}) {
  if (params.id) { const p = db.get('people', params.id); if (p) return renderDetail(root, p); }
  const t = today();
  const people = db.all('people');
  const comms = db.all('commitments').filter(c => !c.done);
  const mineOpen = comms.filter(c => c.direction === 'mine');
  const theirsOpen = comms.filter(c => c.direction === 'theirs');
  const overdue = comms.filter(c => c.due && c.due < t);
  const stale = people.filter(p => { const l = lastContactOf(p.id); return !l || daysBetween(l, t) > STALE_DAYS; });
  const q = search.trim().toLowerCase();
  let list = people;
  if (typeFilter !== 'all') list = list.filter(p => p.type === typeFilter);
  if (q) list = list.filter(p => `${p.name} ${p.role} ${p.org} ${(p.tags || []).join(' ')} ${p.notes}`.toLowerCase().includes(q));
  const order = { ceo: 0, team: 1, partner: 2, client: 3, other: 4 };
  list = sortBy(list, p => `${order[p.type] ?? 9}-${p.name.toLowerCase()}`);
  const soon = sortBy(comms.filter(c => c.due), c => c.due).slice(0, 6);

  root.innerHTML = `<div>
    <div class="page-head">
      <div><div class="eyebrow">Ресурсы</div><h1>Люди</h1></div>
      <div class="actions"><button class="btn secondary" data-action="commit-any">${icon('plus')} Обещание</button><button class="btn" data-action="new">${icon('plus')} Человек</button></div>
    </div>
    <div class="grid-4" style="margin-bottom:14px">
      <div class="stat"><span class="label">${icon('check')} Я обещала</span><span class="value ${overdue.some(c => c.direction === 'mine') ? 'bad' : ''}">${mineOpen.length}</span><span class="sub">${overdue.filter(c => c.direction === 'mine').length ? `просрочено ${overdue.filter(c => c.direction === 'mine').length}` : 'всё в сроке'}</span></div>
      <div class="stat"><span class="label">${icon('star')} Мне обещали</span><span class="value">${theirsOpen.length}</span><span class="sub">${overdue.filter(c => c.direction === 'theirs').length ? `просрочено ${overdue.filter(c => c.direction === 'theirs').length}` : 'ждём'}</span></div>
      <div class="stat"><span class="label">${icon('clock')} Давно не общались</span><span class="value ${stale.length ? 'warn' : ''}">${stale.length}</span><span class="sub">больше ${STALE_DAYS} дней</span></div>
      <div class="stat"><span class="label">${icon('layers')} Всего людей</span><span class="value">${people.length}</span><span class="sub">${Object.entries(PERSON_TYPES).map(([k, l]) => people.filter(p => p.type === k).length ? `${l.split(' ')[0].toLowerCase()}: ${people.filter(p => p.type === k).length}` : '').filter(Boolean).slice(0, 3).join(' · ')}</span></div>
    </div>
    ${soon.length ? `<div class="card" data-block="soon" data-block-title="Ближайшие обязательства" style="margin-bottom:14px">
      <div class="section-title"><h2>Ближайшие обязательства</h2></div>
      <div class="list">${soon.map(c => commitmentRow(c, t, { withPerson: true })).join('')}</div>
    </div>` : ''}
    <div class="card" data-block="search" data-block-title="Поиск и фильтры" style="margin-bottom:12px;padding:10px 12px">
      <div class="row wrap" style="gap:8px">
        <span class="muted" style="display:grid;place-items:center">${icon('search')}</span>
        <input type="search" class="input grow" data-search placeholder="Поиск по имени, роли, заметкам…" value="${esc(search)}" style="border:0;background:transparent;padding:6px 4px;min-width:160px">
        <div class="chips" style="padding:0"><button class="chip ${typeFilter === 'all' ? 'active' : ''}" data-type="all">Все</button>${TYPE_OPTIONS.map(([k, l]) => `<button class="chip ${typeFilter === k ? 'active' : ''}" data-type="${k}">${esc(l)}</button>`).join('')}</div>
      </div>
    </div>
    <div data-block="list" data-block-title="Список людей">${list.length
      ? `<div class="grid-auto pgrid">${list.map(p => personCard(p, t)).join('')}</div>`
      : `<div class="card">${emptyState(people.length ? 'Никого не нашлось' : 'Добавьте CEO, команду и партнёров. К каждому — обещания в обе стороны и записи о контактах, чтобы ничего не держать в голове', '🤝')}</div>`}</div>
  </div>`;
  const view = root.firstElementChild;
  on(view, 'click', '[data-action="new"]', () => openPersonModal(null));
  on(view, 'click', '[data-action="commit-any"]', () => { if (!people.length) { toast('Сначала добавьте человека'); return; } openCommitmentModal(null, people[0].id); });
  on(view, 'click', '[data-action="c-edit"]', (e, el) => { const c = db.get('commitments', el.dataset.id); if (c) openCommitmentModal(c, c.personId); });
  on(view, 'click', '[data-action="c-toggle"]', (e, el) => { const c = db.get('commitments', el.dataset.id); if (c) db.update('commitments', c.id, c.done ? { done: false, doneAt: null } : { done: true, doneAt: today() }); });
  on(view, 'click', '[data-type]', (e, el) => { typeFilter = el.dataset.type; render(root, {}); });
  const inp = view.querySelector('[data-search]');
  inp.addEventListener('input', () => { search = inp.value; const pos = inp.selectionStart; render(root, {}); const n = root.querySelector('[data-search]'); n.focus(); n.setSelectionRange(pos, pos); });
}
