// Чаты: переписка Telegram с Mac → кто ждёт ответа, обещания и просьбы, сводка за день, выбор чатов.
// Переписка не хранится в базе приложения; разбор делает локальная модель (Claude — только с явного разрешения).
import { db } from '../db.js';
import { esc, icon, toast, on, today, fmtDate, tabs, statLine, pageMenu, plural } from '../ui.js';
import { addTask, addNote } from '../model.js';
import { aiReady, aiProvider, askPlain, aiLabel } from '../ai.js';
import * as tg from '../tg.js';

export const title = 'Чаты';

let tab = 'review';        // review | waiting | chats
let busy = false;          // идёт разбор
let error = '';
let loadError = '';
let syncNote = '';

const ago = (iso) => { if (!iso) return '—'; const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); if (m < 1) return 'только что'; if (m < 60) return `${m} мин назад`; const h = Math.round(m / 60); if (h < 24) return `${h} ч назад`; const d = Math.round(h / 24); return `${d} ${plural(d, 'день', 'дня', 'дней')} назад`; };
const waitLabel = (hours) => hours < 24 ? `${Math.round(hours)} ч` : `${Math.round(hours / 24)} ${plural(Math.round(hours / 24), 'день', 'дня', 'дней')}`;
const hm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

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

function waitingView() {
  const list = tg.waitingForMe();
  if (!list.length) return `<div class="card tiny muted" style="text-align:center">Никто не ждёт ответа дольше двух часов</div>`;
  return `<div class="tg-wait">${list.map(w => `<div class="tg-wait-item">
    <div class="row between" style="gap:8px"><span class="tg-name">${esc(w.chat.name)}</span><span class="tg-ago">ждёт ${waitLabel(w.hours)}</span></div>
    <div class="tg-thread">${w.thread.map(m => `<div class="tg-msg"><b>${m.me ? 'Я' : esc(m.from || w.chat.name)}</b> <span class="faint">${hm(m.date)}</span> ${esc(m.text.slice(0, 280))}</div>`).join('')}</div>
    <div class="row wrap" style="gap:6px"><button type="button" class="btn sm secondary" data-action="tg-task" data-title="${esc('Ответить: ' + w.chat.name)}" data-notes="${esc(w.msg.text.slice(0, 300))}">${icon('check')} Задача «ответить»</button></div>
  </div>`).join('')}</div>`;
}

function reviewView() {
  const pr = tg.prefs();
  const s = tg.lastSummary();
  const fresh = s && s.date === today();
  const tr = tg.transcript({ hours: pr.hours });
  const cloud = aiProvider() === 'claude';
  const canRun = aiReady() && (!cloud || pr.allowCloud) && tr.messages > 0;
  const head = `<div class="card" data-block="tg-review" data-block-title="Разбор">
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
  return head;
}
const hoursLabel = (h) => ({ 12: '12 часов', 24: 'сутки', 48: '2 дня', 168: 'неделю' }[Number(h)] || `${h} ч`);

function renderResult(r) {
  if (!r || typeof r !== 'object') return '<div class="small muted">Разбор не удался — попробуйте ещё раз.</div>';
  const arr = (k) => Array.isArray(r[k]) ? r[k] : [];
  const row = (main, sub, btn) => `<div class="tg-row"><div class="main"><div>${main}</div>${sub ? `<div class="tiny muted">${sub}</div>` : ''}</div>${btn || ''}</div>`;
  const taskBtn = (title, notes, extra = '') => `<button type="button" class="btn sm secondary" data-action="tg-task" data-title="${esc(title)}" data-notes="${esc(notes || '')}" ${extra}>${icon('check')} В задачу</button>`;
  const sec = [];
  if (arr('waiting').length) sec.push(`<h4>Ждут ответа</h4>${arr('waiting').map(x => row(esc(x.ask || ''), `${esc(x.who || '')} · ${esc(x.chat || '')}`, taskBtn(`Ответить ${x.who || ''}: ${x.ask || ''}`, `Чат: ${x.chat || ''}`))).join('')}`);
  if (arr('my_promises').length) sec.push(`<h4>Я обещала</h4>${arr('my_promises').map(x => row(esc(x.text || ''), `${esc(x.chat || '')}${x.due ? ` · ${esc(x.due)}` : ''}`, taskBtn(x.text || '', `Обещание в чате ${x.chat || ''}${x.due ? `, срок: ${x.due}` : ''}`, 'data-source="promise"'))).join('')}`);
  if (arr('their_promises').length) sec.push(`<h4>Мне обещали</h4>${arr('their_promises').map(x => row(esc(x.text || ''), `${esc(x.who || '')} · ${esc(x.chat || '')}${x.due ? ` · ${esc(x.due)}` : ''}`, taskBtn(`${x.who || 'Собеседник'}: ${x.text || ''}`, `Обещали в чате ${x.chat || ''}${x.due ? `, срок: ${x.due}` : ''}`, 'data-direction="theirs"'))).join('')}`);
  if (arr('requests').length) sec.push(`<h4>Просьбы и задачи</h4>${arr('requests').map(x => row(esc(x.text || ''), `${esc(x.who || '')} · ${esc(x.chat || '')}`, taskBtn(x.text || '', `Просьба от ${x.who || ''} в чате ${x.chat || ''}`))).join('')}`);
  if (arr('summary').length) sec.push(`<h4>Что важного</h4><ul class="tg-summary">${arr('summary').map(x => `<li>${esc(typeof x === 'string' ? x : JSON.stringify(x))}</li>`).join('')}</ul>`);
  return sec.length ? `<div class="tg-sec">${sec.join('')}</div>` : '<div class="small muted">Ничего важного: никто не ждёт, обещаний и просьб нет.</div>';
}

function chatsView() {
  const list = tg.chatList();
  const ex = new Set(tg.prefs().exclude);
  if (!list.length) return `<div class="card tiny muted" style="text-align:center">Чатов пока нет — нажмите «Обновить»</div>`;
  return `<div class="card" data-block="tg-chats" data-block-title="Чаты">
    <div class="section-title"><h2>${icon('users')} Какие чаты разбирать</h2><span class="tiny muted">${list.length - ex.size} из ${list.length}</span></div>
    <div class="list">${list.map(c => `<label class="tg-chat ${ex.has(c.id) ? 'off' : ''}"><input type="checkbox" data-tg-include="${esc(c.id)}" ${ex.has(c.id) ? '' : 'checked'}><div class="main"><div class="small bold ellipsis">${esc(c.name)}</div><div class="tiny muted">${c.kind === 'group' ? 'группа' : 'личный'} · ${ago(c.lastAt)}${c.unread ? ` · непрочитано ${c.unread}` : ''}</div></div></label>`).join('')}</div>
  </div>`;
}

export async function render(root, { params }) {
  if (params?.tab && ['review', 'waiting', 'chats'].includes(params.tab)) tab = params.tab;
  const draw = () => {
    const st = tg.tgStatus();
    const data = tg.tgData();
    const ready = st?.session && (data?.messages?.length || st?.messages);
    const waiting = data ? tg.waitingForMe().length : 0;
    root.innerHTML = `<div>
      <div class="page-head">
        <div><div class="eyebrow">Работа</div><h1>Чаты</h1></div>
        <div class="actions">
          ${ready ? `<button type="button" class="btn secondary" data-action="tg-sync" ${tg.isSyncing() ? 'disabled' : ''}>${icon('refresh')} ${tg.isSyncing() ? 'Собираю…' : 'Обновить'}</button>` : ''}
          ${ready && aiReady() ? `<button type="button" class="btn" data-action="tg-go-review">${icon('zap')} Разобрать</button>` : ''}
          ${pageMenu([{ label: 'Какие чаты разбирать', action: 'tg-tab-chats', icon: 'users' }])}
        </div>
      </div>
      ${ready ? `${statLine([waiting ? [`ждут ответа <b>${waiting}</b>`, 'warn'] : 'никто не ждёт ответа', `чатов <b>${tg.activeChats().length}</b>`, syncNote ? [syncNote, 'good'] : `собрано ${ago(data?.syncedAt || st?.syncedAt)}`])}
        ${tabs([['review', 'Разбор'], ['waiting', 'Ждут ответа', waiting || null], ['chats', 'Чаты']], tab, 'data-tg-tab')}
        <div class="tg-body">${tab === 'review' ? reviewView() : tab === 'waiting' ? waitingView() : chatsView()}</div>`
        : `<div class="tg-body">${setupView(st)}</div>`}
    </div>`;
  };
  draw();
  const rerender = () => { const y = window.scrollY; draw(); window.scrollTo(0, y); };

  on(root, 'click', '[data-tg-tab]', (e, el) => { tab = el.dataset.tgTab; rerender(); });
  on(root, 'click', '[data-action="tg-tab-chats"]', () => { tab = 'chats'; rerender(); });
  on(root, 'click', '[data-action="tg-check"]', () => boot(true));
  on(root, 'click', '[data-action="tg-sync"]', () => doSync());
  on(root, 'click', '[data-action="tg-go-review"]', () => { tab = 'review'; rerender(); if (!(tg.lastSummary()?.date === today()) && !busy) review(); });
  on(root, 'click', '[data-action="tg-review"]', () => review());
  on(root, 'click', '[data-action="tg-note"]', () => { const s = tg.lastSummary(); if (!s) return; addNote({ type: 'note', title: `Разбор чатов ${fmtDate(s.date)}`, body: summaryText(s.result), tags: ['чаты'], date: s.date }); toast('Записано в заметки'); });
  on(root, 'click', '[data-action="tg-task"]', (e, el) => {
    const t = addTask({ title: el.dataset.title, notes: el.dataset.notes || '', source: el.dataset.source || 'manual', direction: el.dataset.direction || 'mine', tags: ['чаты'] });
    if (t) { toast('Задача добавлена в инбокс'); el.disabled = true; el.textContent = 'Добавлено'; }
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
  async function review() {
    if (busy) return;
    const pr = tg.prefs();
    if (aiProvider() === 'claude' && !pr.allowCloud) { toast('Разрешите отправку в Claude или переключитесь на локальную модель'); return; }
    const tr = tg.transcript({ hours: pr.hours });
    if (!tr.messages) { toast('Нет сообщений за выбранный период'); return; }
    busy = true; error = ''; tab = 'review'; rerender();
    try {
      const raw = await askPlain(tg.analysisPrompt(tr.text, { name: db.settings().name || '' }), { json: true, maxTokens: 2000 });
      const result = parseJson(raw);
      if (!result) throw new Error('Модель ответила не по форме. Попробуйте ещё раз.');
      tg.saveSummary({ date: today(), result, chats: tr.chats, messages: tr.messages });
    } catch (e) { if (e.name !== 'AbortError') error = String(e.message || e); }
    busy = false; rerender();
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
  if (arr('my_promises').length) L.push('Я обещала:\n' + arr('my_promises').map(x => `- ${x.text || ''}${x.due ? ` — ${x.due}` : ''} (${x.chat || ''})`).join('\n'));
  if (arr('their_promises').length) L.push('Мне обещали:\n' + arr('their_promises').map(x => `- ${x.who || ''}: ${x.text || ''}${x.due ? ` — ${x.due}` : ''}`).join('\n'));
  if (arr('requests').length) L.push('Просьбы:\n' + arr('requests').map(x => `- ${x.who || ''}: ${x.text || ''}`).join('\n'));
  if (arr('summary').length) L.push('Что важного:\n' + arr('summary').map(x => `- ${x}`).join('\n'));
  return L.join('\n\n');
}
