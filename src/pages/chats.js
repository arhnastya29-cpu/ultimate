// Чаты: переписка Telegram с Mac → кто ждёт ответа (важные люди первыми, «прочитано» и «не важно»), черновики ответов,
// обещания со сроками → в План, затишье с важными людьми, разбор рабочих групп, сводка за день, выбор чатов.
// Переписка не хранится в базе приложения; разбор делает локальная модель (Claude — только с явного разрешения).
import { db } from '../db.js';
import { esc, icon, toast, on, today, fmtDate, tabs, statLine, pageMenu, plural } from '../ui.js';
import { addTask, addNote } from '../model.js';
import { aiReady, aiProvider, askPlain, aiLabel } from '../ai.js';
import * as tg from '../tg.js';

export const title = 'Чаты';

let tab = 'review';        // review | waiting | groups | chats | chat
let openChat = null;       // id открытого чата (вкладка «chat»)
let busy = false;          // идёт разбор переписки
let groupBusy = null;      // id группы, которую разбираем
let draftBusy = null;      // id чата, для которого пишем ответ
const drafts = {};         // chatId -> текст черновика (только в памяти страницы)
let error = '';
let loadError = '';
let syncNote = '';

const ago = (iso) => { if (!iso) return '—'; const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); if (m < 1) return 'только что'; if (m < 60) return `${m} мин назад`; const h = Math.round(m / 60); if (h < 24) return `${h} ч назад`; const d = Math.round(h / 24); return `${d} ${plural(d, 'день', 'дня', 'дней')} назад`; };
const waitLabel = (hours) => hours < 24 ? `${Math.round(hours)} ч` : `${Math.round(hours / 24)} ${plural(Math.round(hours / 24), 'день', 'дня', 'дней')}`;
const hm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const isoDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : '';
const cloudBlocked = () => aiProvider() === 'claude' && !tg.prefs().allowCloud;

function setupView(st) {
  const steps = [];
  if (!st?.env || !st?.configured) steps.push('Дважды щёлкните <b>tg/login.command</b> в папке lifeos. Он попросит два ключа с сайта my.telegram.org (раздел «API development tools») — их получаете вы сами.');
  else if (!st?.session) steps.push('Дважды щёлкните <b>tg/login.command</b>: Telegram спросит номер телефона и код из приложения.');
  steps.push('Вернитесь сюда и нажмите «Проверить». Первый сбор сообщений занимает до нескольких минут.');
  return `<div class="card">
    <div class="section-title"><h2>${icon('send')} Подключить Telegram</h2></div>
    <p class="small muted">ULTIMATE читает ваши личные чаты и группы от вашего имени и показывает, кто ждёт ответа, что вы обещали и что важного произошло. Всё остаётся на этом Mac: ключи, вход и сообщения не уходят ни в облако, ни в синхронизацию.</p>
    <ol class="tg-steps">${steps.map(s => `<li>${s}</li>`).join('')}</ol>
    ${loadError ? `<div class="small bad" style="margin-top:8px">${esc(loadError)}</div>` : ''}
    <div class="row wrap" style="gap:8px;margin-top:12px"><button type="button" class="btn" data-action="tg-check">${icon('refresh')} Проверить</button></div>
  </div>`;
}

// Кнопки приоритета человека: ★ важный / «не важно»
const prioBtns = (c) => { const pv = tg.priorityOf(c.id); return `<span class="tg-prio"><button type="button" class="icon-btn sm ${pv > 0 ? 'on' : ''}" data-action="tg-prio" data-id="${esc(c.id)}" data-v="1" title="${pv > 0 ? 'Убрать из важных' : 'Важный человек: выше в списке и на главной'}" aria-label="Важный">${icon('star')}</button><button type="button" class="chip xs ${pv < 0 ? 'active' : ''}" data-action="tg-prio" data-id="${esc(c.id)}" data-v="-1" title="Не важно: не показывать в «ждут ответа» и на главной">не важно</button></span>`; };

function waitItem(w) {
  const link = tg.chatLink(w.chat, w.msg.id);
  const d = drafts[w.chat.id];
  return `<div class="tg-wait-item ${w.priority > 0 ? 'is-vip' : ''}">
    <div class="row between" style="gap:8px;align-items:center"><span class="row" style="gap:8px;align-items:center"><button type="button" class="tg-name link" data-action="tg-open-chat" data-id="${esc(w.chat.id)}">${esc(w.chat.name)}</button>${w.priority > 0 ? '<span class="pill accent">важный</span>' : ''}</span><span class="tg-ago">ждёт ${waitLabel(w.hours)}</span></div>
    <div class="tg-thread">${w.thread.map(m => `<div class="tg-msg"><b>${m.me ? 'Я' : esc(m.from || w.chat.name)}</b> <span class="faint">${hm(m.date)}</span> ${esc(m.text.slice(0, 280))}</div>`).join('')}</div>
    ${draftBusy === w.chat.id ? '<div class="tg-draft muted">Пишу черновик…</div>' : d ? `<div class="tg-draft"><div class="tiny muted" style="margin-bottom:4px">Черновик ответа — проверьте и вставьте в Telegram:</div><div class="tg-draft-text">${esc(d)}</div><div class="row wrap" style="gap:6px;margin-top:8px"><button type="button" class="btn sm" data-action="tg-copy" data-id="${esc(w.chat.id)}">${icon('copy')} Скопировать</button>${link ? `<a class="btn sm secondary" href="${esc(link)}" target="_blank" rel="noopener">${icon('send')} Открыть в Telegram</a>` : ''}<button type="button" class="link" data-action="tg-draft" data-id="${esc(w.chat.id)}">переписать</button></div></div>` : ''}
    <div class="row wrap between" style="gap:6px">
      <div class="row wrap" style="gap:6px">
        ${aiReady() && !d && draftBusy !== w.chat.id ? `<button type="button" class="btn sm" data-action="tg-draft" data-id="${esc(w.chat.id)}" title="${cloudBlocked() ? 'Нужно разрешить отправку в Claude (вкладка «Разбор») или локальная модель' : 'Помощник напишет короткий ответ в вашем тоне'}">${icon('zap')} Предложить ответ</button>` : ''}
        <button type="button" class="btn sm secondary" data-action="tg-task" data-title="${esc('Ответить: ' + w.chat.name)}" data-notes="${esc(w.msg.text.slice(0, 300))}" data-chat="${esc(w.chat.id)}" data-msg="${w.msg.id}">${icon('check')} Задача «ответить»</button>
        ${link && !d ? `<a class="btn sm secondary" href="${esc(link)}" target="_blank" rel="noopener">${icon('send')} В Telegram</a>` : ''}
      </div>
      <div class="row wrap" style="gap:6px">
        <button type="button" class="chip xs" data-action="tg-dismiss" data-id="${esc(w.chat.id)}" data-msg="${w.msg.id}" title="Убрать из списка до следующего сообщения">${icon('check')} прочитано</button>
        ${prioBtns(w.chat)}
      </div>
    </div>
  </div>`;
}

function waitingView() {
  const list = tg.waitingForMe();
  const vip = list.filter(w => w.priority > 0), rest = list.filter(w => !(w.priority > 0));
  const quiet = tg.quietContacts();
  const pr = tg.prefs();
  const dismissedN = tg.waitingForMe({ includeDismissed: true }).length - list.length;
  const parts = [];
  if (!list.length) parts.push(`<div class="card tiny muted" style="text-align:center">Никто не ждёт ответа дольше двух часов${dismissedN ? ` · отмечено прочитанным: ${dismissedN}` : ''}</div>`);
  else {
    if (vip.length) parts.push(`<div class="tg-sub">Важные люди</div><div class="tg-wait">${vip.map(waitItem).join('')}</div>`);
    if (rest.length) parts.push(`${vip.length ? '<div class="tg-sub">Остальные</div>' : ''}<div class="tg-wait">${rest.map(waitItem).join('')}</div>`);
    if (dismissedN) parts.push(`<div class="tiny muted" style="text-align:center">отмечено прочитанным: ${dismissedN} · <button type="button" class="link" data-action="tg-undismiss">показать</button></div>`);
  }
  parts.push(`<div class="card" data-block="tg-quiet" data-block-title="Давно не общались">
    <div class="section-title"><h2>${icon('clock')} Давно не общались</h2><label class="row tiny muted" style="gap:6px">больше <select class="input" data-tg-quiet style="width:auto;padding:4px 8px">${[[3, '3 дней'], [7, 'недели'], [14, '2 недель'], [30, 'месяца']].map(([v, l]) => `<option value="${v}" ${Number(pr.quietDays) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
    ${!Object.values(pr.priority || {}).some(v => v > 0) ? '<div class="small muted">Отметьте важных людей звёздочкой (здесь или во вкладке «Чаты») — я напомню, если с кем-то из них давно не было переписки.</div>'
      : quiet.length ? `<div class="list">${quiet.map(q => `<div class="list-item" style="padding:8px 0"><div class="main"><div class="small bold">${esc(q.chat.name)}</div><div class="tiny muted">последнее сообщение ${q.lastAt ? ago(q.lastAt) : 'не найдено'}</div></div><div class="row" style="gap:6px">${tg.chatLink(q.chat) ? `<a class="btn sm" href="${esc(tg.chatLink(q.chat))}" target="_blank" rel="noopener">${icon('send')} Написать</a>` : ''}<button type="button" class="btn sm secondary" data-action="tg-task" data-title="${esc('Написать: ' + q.chat.name)}" data-notes="${esc(`Давно не общались (${q.days} дн.)`)}" data-chat="${esc(q.chat.id)}">${icon('check')} Задача</button></div></div>`).join('')}</div>`
      : '<div class="small muted">Со всеми важными людьми переписка была недавно.</div>'}
  </div>`);
  return parts.join('');
}

function reviewView() {
  const pr = tg.prefs();
  const s = tg.lastSummary();
  const fresh = s && s.date === today();
  const tr = tg.transcript({ hours: pr.hours });
  const cloud = aiProvider() === 'claude';
  const canRun = aiReady() && (!cloud || pr.allowCloud) && tr.messages > 0;
  return `<div class="card" data-block="tg-review" data-block-title="Разбор">
    <div class="section-title"><h2>${icon('zap')} Разбор переписки ${fresh ? `· ${esc(fmtDate(s.date))}` : ''}</h2><span class="tiny muted">${aiReady() ? esc(aiLabel()) : 'помощник не подключён'}</span></div>
    ${busy ? '<div class="small muted">Читаю переписку…</div>' : error ? `<div class="small bad" style="margin-bottom:8px">${esc(error)}</div>` : ''}
    ${!busy && fresh ? renderResult(s.result) : ''}
    ${!busy && !fresh ? `<div class="small muted">За ${hoursLabel(pr.hours)}: ${tr.messages} ${plural(tr.messages, 'сообщение', 'сообщения', 'сообщений')} в ${tr.chats} ${plural(tr.chats, 'чате', 'чатах', 'чатах')}.</div>` : ''}
    <div class="row wrap" style="gap:8px;margin-top:12px;align-items:center">
      ${aiReady() ? `<button type="button" class="btn ${fresh ? 'secondary' : ''}" data-action="tg-review" ${busy || !canRun ? 'disabled' : ''}>${icon('zap')} ${fresh ? 'Разобрать заново' : 'Разобрать'}</button>` : `<a class="btn" href="#/settings">${icon('settings')} Подключить помощника</a>`}
      <label class="row tiny muted" style="gap:6px">за <select class="input" data-tg-hours style="width:auto;padding:5px 8px">${[[12, '12 часов'], [24, 'сутки'], [48, '2 дня'], [168, 'неделю']].map(([v, l]) => `<option value="${v}" ${Number(pr.hours) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${fresh && !busy ? `<button type="button" class="btn sm secondary" data-action="tg-note">${icon('pen')} В заметки</button>` : ''}
    </div>
    ${cloud ? `<label class="row tiny ${pr.allowCloud ? 'muted' : 'warn'}" style="gap:8px;margin-top:10px"><input type="checkbox" data-tg-cloud ${pr.allowCloud ? 'checked' : ''}> Сейчас выбран Claude: переписка уйдёт в облако Anthropic. Разрешаю.</label>` : ''}
  </div>`;
}
const hoursLabel = (h) => ({ 12: '12 часов', 24: 'сутки', 48: '2 дня', 168: 'неделю' }[Number(h)] || `${h} ч`);

const dueLabel = (x) => { const d = isoDay(x.due_date); return d ? `<span class="${d < today() ? 'bad' : d === today() ? 'warn' : 'accent'}">${esc(fmtDate(d))}</span>${x.due ? ` (${esc(x.due)})` : ''}` : x.due ? esc(x.due) : ''; };
function renderResult(r) {
  if (!r || typeof r !== 'object') return '<div class="small muted">Разбор не удался — попробуйте ещё раз.</div>';
  const arr = (k) => Array.isArray(r[k]) ? r[k] : [];
  const row = (main, sub, btn) => `<div class="tg-row"><div class="main"><div>${main}</div>${sub ? `<div class="tiny muted">${sub}</div>` : ''}</div>${btn || ''}</div>`;
  const taskBtn = (title, notes, x = {}, extra = '') => `<button type="button" class="btn sm secondary" data-action="tg-task" data-title="${esc(title)}" data-notes="${esc(notes || '')}" data-date="${esc(isoDay(x.due_date))}" ${extra}>${icon('check')} ${isoDay(x.due_date) ? 'В План' : 'В задачу'}</button>`;
  const sec = [];
  if (arr('waiting').length) sec.push(`<h4>Ждут ответа</h4>${arr('waiting').map(x => row(esc(x.ask || ''), `${esc(x.who || '')} · ${esc(x.chat || '')}`, taskBtn(`Ответить ${x.who || ''}: ${x.ask || ''}`, `Чат: ${x.chat || ''}`))).join('')}`);
  const withDue = arr('my_promises').filter(x => isoDay(x.due_date));
  if (arr('my_promises').length) sec.push(`<h4>Я обещала${withDue.length > 1 ? ` <button type="button" class="link" style="text-transform:none;letter-spacing:0;font-weight:500" data-action="tg-plan-all">все со сроком в План (${withDue.length})</button>` : ''}</h4>${arr('my_promises').map(x => row(esc(x.text || ''), `${esc(x.chat || '')}${x.due || x.due_date ? ` · ${dueLabel(x)}` : ''}`, taskBtn(x.text || '', `Обещание в чате ${x.chat || ''}${x.due ? `, срок: ${x.due}` : ''}`, x, 'data-source="promise"'))).join('')}`);
  if (arr('their_promises').length) sec.push(`<h4>Мне обещали</h4>${arr('their_promises').map(x => row(esc(x.text || ''), `${esc(x.who || '')} · ${esc(x.chat || '')}${x.due || x.due_date ? ` · ${dueLabel(x)}` : ''}`, taskBtn(`${x.who || 'Собеседник'}: ${x.text || ''}`, `Обещали в чате ${x.chat || ''}${x.due ? `, срок: ${x.due}` : ''}`, x, 'data-direction="theirs"'))).join('')}`);
  if (arr('requests').length) sec.push(`<h4>Просьбы и задачи</h4>${arr('requests').map(x => row(esc(x.text || ''), `${esc(x.who || '')} · ${esc(x.chat || '')}${x.due_date ? ` · ${dueLabel(x)}` : ''}`, taskBtn(x.text || '', `Просьба от ${x.who || ''} в чате ${x.chat || ''}`, x))).join('')}`);
  if (arr('summary').length) sec.push(`<h4>Что важного</h4><ul class="tg-summary">${arr('summary').map(x => `<li>${esc(typeof x === 'string' ? x : JSON.stringify(x))}</li>`).join('')}</ul>`);
  return sec.length ? `<div class="tg-sec">${sec.join('')}</div>` : '<div class="small muted">Ничего важного: никто не ждёт, обещаний и просьб нет.</div>';
}

function groupsView() {
  const groups = tg.chatList().filter(c => c.kind === 'group' && !tg.prefs().exclude.includes(c.id));
  if (!groups.length) return `<div class="card tiny muted" style="text-align:center">Групп пока нет</div>`;
  const all = tg.groupSummaries();
  return `<div class="stack">${groups.map(c => { const g = all[c.id]; const n = tg.messagesOf(c.id, 500).length; const r = g?.result; const arr = (k) => Array.isArray(r?.[k]) ? r[k] : [];
    return `<div class="card" data-block="tg-group-${esc(c.id)}">
      <div class="section-title"><h2>${icon('users')} ${esc(c.name)}</h2><span class="tiny muted">${n} ${plural(n, 'сообщение', 'сообщения', 'сообщений')} · ${ago(c.lastAt)}</span></div>
      ${groupBusy === c.id ? '<div class="small muted">Читаю группу…</div>' : r ? `<div class="tg-sec">
        ${arr('decisions').length ? `<h4>Решили</h4><ul class="tg-summary">${arr('decisions').map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${arr('owners').length ? `<h4>Кто что взял</h4>${arr('owners').map(x => `<div class="tg-row"><div class="main"><div><b>${esc(x.who || '')}</b> — ${esc(x.what || '')}</div>${x.due || x.due_date ? `<div class="tiny muted">${dueLabel(x)}</div>` : ''}</div><button type="button" class="btn sm secondary" data-action="tg-task" data-title="${esc(`${x.who || ''}: ${x.what || ''}`)}" data-notes="${esc(`Группа ${c.name}`)}" data-date="${esc(isoDay(x.due_date))}" data-direction="theirs" data-chat="${esc(c.id)}">${icon('check')} Задача</button></div>`).join('')}` : ''}
        ${arr('open').length ? `<h4>Открытые вопросы</h4><ul class="tg-summary">${arr('open').map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${arr('for_me').length ? `<h4>Касается меня</h4>${arr('for_me').map(x => `<div class="tg-row"><div class="main">${esc(x)}</div><button type="button" class="btn sm secondary" data-action="tg-task" data-title="${esc(x)}" data-notes="${esc(`Группа ${c.name}`)}" data-chat="${esc(c.id)}">${icon('check')} В задачу</button></div>`).join('')}` : ''}
        ${arr('summary').length ? `<h4>О чём говорили</h4><ul class="tg-summary">${arr('summary').map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${!arr('decisions').length && !arr('owners').length && !arr('open').length && !arr('for_me').length && !arr('summary').length ? '<div class="small muted">Ничего существенного.</div>' : ''}
        <div class="tiny faint" style="margin-top:8px">разобрано ${ago(g.at)}</div></div>` : `<div class="small muted">Что решили, кто что взял на себя, какие вопросы открыты и что касается вас.</div>`}
      <div class="row wrap" style="gap:8px;margin-top:10px">${aiReady() ? `<button type="button" class="btn sm ${r ? 'secondary' : ''}" data-action="tg-group" data-id="${esc(c.id)}" ${groupBusy || !n ? 'disabled' : ''}>${icon('zap')} ${r ? 'Разобрать заново' : 'Разобрать группу'}</button>` : ''}<button type="button" class="btn sm secondary" data-action="tg-open-chat" data-id="${esc(c.id)}">${icon('list')} Переписка</button>${tg.chatLink(c) ? `<a class="btn sm secondary" href="${esc(tg.chatLink(c))}" target="_blank" rel="noopener">${icon('send')} В Telegram</a>` : ''}</div>
    </div>`; }).join('')}</div>`;
}

function chatsView() {
  const list = tg.chatList();
  const ex = new Set(tg.prefs().exclude);
  if (!list.length) return `<div class="card tiny muted" style="text-align:center">Чатов пока нет — нажмите «Обновить»</div>`;
  return `<div class="card" data-block="tg-chats" data-block-title="Чаты">
    <div class="section-title"><h2>${icon('users')} Люди и группы</h2><span class="tiny muted">${list.length - ex.size} из ${list.length} в разборе</span></div>
    <div class="tiny muted" style="margin-bottom:8px">Галочка — учитывать чат в разборе. Звёздочка — важный человек: его ожидание ответа поднимается вверх и показывается на главной. «Не важно» — не напоминать об этом чате.</div>
    <div class="list">${list.map(c => `<div class="tg-chat ${ex.has(c.id) ? 'off' : ''} ${tg.priorityOf(c.id) > 0 ? 'is-vip' : ''}"><input type="checkbox" data-tg-include="${esc(c.id)}" ${ex.has(c.id) ? '' : 'checked'} aria-label="Учитывать в разборе"><div class="main"><button type="button" class="small bold ellipsis link" style="text-align:left" data-action="tg-open-chat" data-id="${esc(c.id)}">${esc(c.name)}</button><div class="tiny muted">${c.kind === 'group' ? 'группа' : 'личный'} · ${ago(c.lastAt)}${c.unread ? ` · непрочитано ${c.unread}` : ''}</div></div>${c.kind === 'user' ? prioBtns(c) : `<button type="button" class="chip xs" data-action="tg-go-groups">разбор</button>`}</div>`).join('')}</div>
  </div>`;
}

// Переписка одного чата (куда ведут ссылки из задач и списков)
function chatView() {
  const c = tg.chatOf(openChat);
  if (!c) return `<div class="card tiny muted" style="text-align:center">Чат не найден или уже не хранится (переписка держится 2 недели)</div>`;
  const list = tg.messagesOf(c.id, 80);
  let day = '';
  const rows = list.map(m => { const d = m.date.slice(0, 10); const head = d !== day ? `<div class="sg-day-title" style="margin-top:10px">${esc(fmtDate(d, { weekday: true }))}</div>` : ''; day = d; return `${head}<div class="tg-msg ${m.me ? 'is-me' : ''}"><b>${m.me ? 'Я' : esc(m.from || c.name)}</b> <span class="faint">${hm(m.date)}</span> ${esc(m.text)}</div>`; }).join('');
  return `<div class="card" data-block="tg-chat" data-block-title="Переписка">
    <div class="section-title"><h2>${icon(c.kind === 'group' ? 'users' : 'user')} ${esc(c.name)}</h2><span class="row" style="gap:6px">${c.kind === 'user' ? prioBtns(c) : ''}${tg.chatLink(c) ? `<a class="btn sm secondary" href="${esc(tg.chatLink(c))}" target="_blank" rel="noopener">${icon('send')} В Telegram</a>` : ''}</span></div>
    <div class="tg-thread tg-full">${rows || '<div class="small muted">Сообщений за две недели нет</div>'}</div>
  </div>`;
}

let lastParams = '';
export async function render(root, { params, navigate }) {
  const key = JSON.stringify(params || {});
  if (key !== lastParams) {   // параметры адреса — один раз, чтобы перерисовка не сбрасывала вкладку
    lastParams = key;
    if (params?.tab && ['review', 'waiting', 'groups', 'chats'].includes(params.tab)) tab = params.tab;
    if (params?.chat) { openChat = String(params.chat); tab = 'chat'; }
  }
  const draw = () => {
    const st = tg.tgStatus();
    const data = tg.tgData();
    const ready = st?.session && (data?.messages?.length || st?.messages);
    const waiting = data ? tg.waitingForMe() : [];
    const vipN = waiting.filter(w => w.priority > 0).length;
    const groupsN = data ? tg.chatList().filter(c => c.kind === 'group').length : 0;
    root.innerHTML = `<div>
      <div class="page-head">
        <div><div class="eyebrow">Работа</div><h1>Чаты</h1></div>
        <div class="actions">
          ${ready ? `<button type="button" class="btn secondary" data-action="tg-sync" ${tg.isSyncing() ? 'disabled' : ''}>${icon('refresh')} ${tg.isSyncing() ? 'Собираю…' : 'Обновить'}</button>` : ''}
          ${ready && aiReady() ? `<button type="button" class="btn" data-action="tg-go-review">${icon('zap')} Разобрать</button>` : ''}
          ${pageMenu([{ label: 'Люди и группы', action: 'tg-tab-chats', icon: 'users' }])}
        </div>
      </div>
      ${ready ? `${statLine([waiting.length ? [`ждут ответа <b>${waiting.length}</b>${vipN ? ` (важных ${vipN})` : ''}`, 'warn'] : 'никто не ждёт ответа', `чатов <b>${tg.activeChats().length}</b>`, syncNote ? [syncNote, 'good'] : `собрано ${ago(data?.syncedAt || st?.syncedAt)}`, st?.auto ? [`сбор сам каждые ${st.auto} мин`, 'muted'] : ''])}
        ${tabs([['review', 'Разбор'], ['waiting', 'Ждут ответа', waiting.length || null], ['groups', 'Группы', groupsN || null], ['chats', 'Люди'], ...(tab === 'chat' ? [['chat', tg.chatOf(openChat)?.name?.slice(0, 18) || 'Чат']] : [])], tab, 'data-tg-tab')}
        <div class="tg-body">${tab === 'review' ? reviewView() : tab === 'waiting' ? waitingView() : tab === 'groups' ? groupsView() : tab === 'chat' ? chatView() : chatsView()}</div>`
        : `<div class="tg-body">${setupView(st)}</div>`}
    </div>`;
  };
  draw();
  const rerender = () => { const y = window.scrollY; draw(); window.scrollTo(0, y); };

  on(root, 'click', '[data-tg-tab]', (e, el) => { tab = el.dataset.tgTab; rerender(); });
  on(root, 'click', '[data-action="tg-tab-chats"]', () => { tab = 'chats'; rerender(); });
  on(root, 'click', '[data-action="tg-go-groups"]', () => { tab = 'groups'; rerender(); });
  on(root, 'click', '[data-action="tg-open-chat"]', (e, el) => { openChat = el.dataset.id; tab = 'chat'; rerender(); window.scrollTo(0, 0); });
  on(root, 'click', '[data-action="tg-check"]', () => boot(true));
  on(root, 'click', '[data-action="tg-sync"]', () => doSync());
  on(root, 'click', '[data-action="tg-go-review"]', () => { tab = 'review'; rerender(); if (!(tg.lastSummary()?.date === today()) && !busy) review(); });
  on(root, 'click', '[data-action="tg-review"]', () => review());
  on(root, 'click', '[data-action="tg-group"]', (e, el) => reviewGroup(el.dataset.id));
  on(root, 'click', '[data-action="tg-draft"]', (e, el) => draft(el.dataset.id));
  on(root, 'click', '[data-action="tg-copy"]', async (e, el) => { const t = drafts[el.dataset.id]; if (!t) return; try { await navigator.clipboard.writeText(t); toast('Скопировано — вставьте в Telegram'); } catch { toast('Не удалось скопировать'); } });
  on(root, 'click', '[data-action="tg-dismiss"]', (e, el) => { tg.dismiss(el.dataset.id, el.dataset.msg); toast('Прочитано — напомню, когда напишут снова'); rerender(); });
  on(root, 'click', '[data-action="tg-undismiss"]', () => { tg.setPrefs({ dismissed: {} }); rerender(); });
  on(root, 'click', '[data-action="tg-prio"]', (e, el) => { const v = Number(el.dataset.v); const cur = tg.priorityOf(el.dataset.id); tg.setPriority(el.dataset.id, cur === v ? 0 : v); toast(cur === v ? 'Обычный чат' : v > 0 ? 'Важный человек' : 'Не важно — напоминать не буду'); rerender(); });
  on(root, 'change', '[data-tg-quiet]', (e, el) => { tg.setPrefs({ quietDays: Number(el.value) || 7 }); rerender(); });
  on(root, 'click', '[data-action="tg-note"]', () => { const s = tg.lastSummary(); if (!s) return; addNote({ type: 'note', title: `Разбор чатов ${fmtDate(s.date)}`, body: summaryText(s.result), tags: ['чаты'], date: s.date }); toast('Записано в заметки'); });
  on(root, 'click', '[data-action="tg-task"]', (e, el) => {
    const chat = el.dataset.chat ? tg.chatOf(el.dataset.chat) : null;
    const t = addTask({ title: el.dataset.title, notes: el.dataset.notes || '', date: isoDay(el.dataset.date) || null, source: el.dataset.source || 'manual', direction: el.dataset.direction || 'mine', tags: ['чаты'],
      link: chat ? { kind: 'tg', chat: chat.id, name: chat.name, msg: Number(el.dataset.msg) || null, url: tg.chatLink(chat, Number(el.dataset.msg) || null) } : null });
    if (t) { toast(t.date ? `Задача в Плане на ${fmtDate(t.date)}` : 'Задача добавлена в инбокс'); el.disabled = true; el.textContent = 'Добавлено'; }
  });
  on(root, 'click', '[data-action="tg-plan-all"]', () => {
    const s = tg.lastSummary(); const list = (Array.isArray(s?.result?.my_promises) ? s.result.my_promises : []).filter(x => isoDay(x.due_date) && x.text);
    let n = 0; for (const x of list) { if (addTask({ title: x.text, notes: `Обещание в чате ${x.chat || ''}${x.due ? `, срок: ${x.due}` : ''}`, date: x.due_date, source: 'promise', tags: ['чаты'] })) n++; }
    toast(`В План добавлено: ${n}`);
  });
  on(root, 'change', '[data-tg-hours]', (e, el) => { tg.setPrefs({ hours: Number(el.value) || 24 }); rerender(); });
  on(root, 'change', '[data-tg-cloud]', (e, el) => { tg.setPrefs({ allowCloud: el.checked }); rerender(); });
  on(root, 'change', '[data-tg-include]', (e, el) => { const ex = new Set(tg.prefs().exclude); if (el.checked) ex.delete(el.dataset.tgInclude); else ex.add(el.dataset.tgInclude); tg.setPrefs({ exclude: [...ex] }); rerender(); });

  async function boot(force) {
    loadError = '';
    try { await tg.refreshStatus(); if (tg.tgStatus()?.session) await tg.load(); }
    catch (e) { loadError = String(e.message || e); }
    rerender();
    if (tg.tgStatus()?.session && (force || tg.stale()) && !tg.isSyncing()) doSync();
  }
  async function doSync() {
    syncNote = ''; rerender();
    try { const r = await tg.sync(); if (r) syncNote = r.added ? `+${r.added} ${plural(r.added, 'новое', 'новых', 'новых')}` : 'новых нет'; }
    catch (e) { toast(String(e.message || e), 4000); }
    rerender();
  }
  function guardCloud() { if (cloudBlocked()) { toast('Разрешите отправку в Claude (вкладка «Разбор») или переключитесь на локальную модель', 4000); return false; } return true; }
  async function review() {
    if (busy || !guardCloud()) return;
    const pr = tg.prefs();
    const tr = tg.transcript({ hours: pr.hours });
    if (!tr.messages) { toast('Нет сообщений за выбранный период'); return; }
    busy = true; error = ''; tab = 'review'; rerender();
    try {
      const raw = await askPlain(tg.analysisPrompt(tr.text, { name: db.settings().name || '' }), { json: true, maxTokens: 2200 });
      const result = parseJson(raw);
      if (!result) throw new Error('Модель ответила не по форме. Попробуйте ещё раз.');
      tg.saveSummary({ date: today(), result, chats: tr.chats, messages: tr.messages });
    } catch (e) { if (e.name !== 'AbortError') error = String(e.message || e); }
    busy = false; rerender();
  }
  async function reviewGroup(id) {
    if (groupBusy || !guardCloud()) return;
    const tr = tg.groupTranscript(id);
    if (!tr.messages) { toast('В группе нет сообщений'); return; }
    groupBusy = id; rerender();
    try {
      const raw = await askPlain(tg.groupPrompt(id, tr.text, { name: db.settings().name || '' }), { json: true, maxTokens: 1800 });
      const result = parseJson(raw);
      if (!result) throw new Error('Модель ответила не по форме. Попробуйте ещё раз.');
      tg.saveGroupSummary(id, { result, messages: tr.messages });
    } catch (e) { if (e.name !== 'AbortError') toast('Не удалось разобрать: ' + (e.message || e), 4000); }
    groupBusy = null; rerender();
  }
  async function draft(id) {
    if (draftBusy || !guardCloud()) return;
    draftBusy = id; delete drafts[id]; rerender();
    try {
      const text = await askPlain(tg.draftPrompt(id, { name: db.settings().name || '' }), { maxTokens: 300 });
      const t = String(text || '').trim().replace(/^["«]|["»]$/g, '');
      if (!t) throw new Error('пустой ответ');
      drafts[id] = t;
    } catch (e) { if (e.name !== 'AbortError') toast('Не удалось написать ответ: ' + (e.message || e), 4000); }
    draftBusy = null; rerender();
  }

  const onTg = () => rerender();
  window.addEventListener('ultimate:tg', onTg);
  boot(false);
  return () => window.removeEventListener('ultimate:tg', onTg);
}

function parseJson(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
function summaryText(r) {
  const L = [];
  const arr = (k) => Array.isArray(r?.[k]) ? r[k] : [];
  if (arr('waiting').length) L.push('Ждут ответа:\n' + arr('waiting').map(x => `- ${x.who || ''} (${x.chat || ''}): ${x.ask || ''}`).join('\n'));
  if (arr('my_promises').length) L.push('Я обещала:\n' + arr('my_promises').map(x => `- ${x.text || ''}${x.due_date || x.due ? ` — ${x.due_date || x.due}` : ''} (${x.chat || ''})`).join('\n'));
  if (arr('their_promises').length) L.push('Мне обещали:\n' + arr('their_promises').map(x => `- ${x.who || ''}: ${x.text || ''}${x.due_date || x.due ? ` — ${x.due_date || x.due}` : ''}`).join('\n'));
  if (arr('requests').length) L.push('Просьбы:\n' + arr('requests').map(x => `- ${x.who || ''}: ${x.text || ''}`).join('\n'));
  if (arr('summary').length) L.push('Что важного:\n' + arr('summary').map(x => `- ${x}`).join('\n'));
  return L.join('\n\n');
}
