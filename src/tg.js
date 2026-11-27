// Чаты Telegram: данные приходят с локального сервера ULTIMATE (serve.py → tg/collect.py) и живут только
// в памяти страницы и на диске Mac (tg/data/messages.json). В базу приложения и в облачную синхронизацию
// переписка не попадает. Здесь: загрузка, «кто ждёт ответа» без модели, приоритеты людей, «прочитано / не важно»,
// затишье с важными людьми, тексты для разбора моделью (переписка за день, одна группа, черновик ответа), поиск.
import { bridgeStatus, probeLocal } from './signals.js';
import { today } from './ui.js';

const PREFS_KEY = 'ultimate_tg_prefs';
const SUMMARY_KEY = 'ultimate_tg_summary';
const GROUPS_KEY = 'ultimate_tg_groups';
let cache = null;            // { chats: {id: {...}}, messages: [...], syncedAt, me }
let status = null;           // ответ /__tg/status
let syncing = false;

export const isSyncing = () => syncing;
export const tgData = () => cache;
export const tgStatus = () => status;

// Настройки раздела (только на этом Mac): exclude — чаты вне разбора; priority — { chatId: 1 важный | -1 не важный };
// dismissed — { chatId: id последнего сообщения, которое отмечено «прочитано» }; quietDays — через сколько дней молчания напоминать.
const DEF = { exclude: [], hours: 24, allowCloud: false, priority: {}, dismissed: {}, quietDays: 7 };
export function prefs() { try { return { ...DEF, ...(JSON.parse(localStorage.getItem(PREFS_KEY) || 'null') || {}) }; } catch { return { ...DEF }; } }
export function setPrefs(patch) { try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs(), ...patch })); } catch {} window.dispatchEvent(new Event('ultimate:tg')); }
export function lastSummary() { try { return JSON.parse(localStorage.getItem(SUMMARY_KEY) || 'null'); } catch { return null; } }
export function saveSummary(obj) { try { localStorage.setItem(SUMMARY_KEY, JSON.stringify({ ...obj, at: new Date().toISOString() })); } catch {} }
export function groupSummaries() { try { return JSON.parse(localStorage.getItem(GROUPS_KEY) || 'null') || {}; } catch { return {}; } }
export function saveGroupSummary(chatId, obj) { try { const all = groupSummaries(); all[chatId] = { ...obj, at: new Date().toISOString() }; localStorage.setItem(GROUPS_KEY, JSON.stringify(all)); } catch {} }

export const priorityOf = (id) => Number(prefs().priority?.[id]) || 0;
export function setPriority(id, v) { const p = { ...prefs().priority }; if (v) p[id] = v; else delete p[id]; setPrefs({ priority: p }); }
// «Прочитано»: убрать чат из «ждут ответа», пока не придёт новое сообщение
export function dismiss(chatId, msgId) { setPrefs({ dismissed: { ...prefs().dismissed, [chatId]: Number(msgId) || 0 } }); }
export const isDismissed = (chatId, msgId) => (prefs().dismissed?.[chatId] || 0) >= Number(msgId);

async function base() {
  const b = bridgeStatus();
  if (b.local === null) await probeLocal();
  return bridgeStatus().local ? bridgeStatus().base : null;
}
async function call(action, { timeout = 10000 } = {}) {
  const b = await base();
  if (b === null) throw new Error('Нет связи с сервером ULTIMATE на Mac: откройте приложение через start.command.');
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(`${b}/__tg/${action}?t=${Date.now().toString(36)}`, { cache: 'no-store', signal: ctl.signal });
    if (!r.ok) throw new Error(`сервер ответил ${r.status}`);
    return await r.json();
  } finally { clearTimeout(tm); }
}

export async function refreshStatus() { status = await call('status'); return status; }
export async function load() {
  const d = await call('data', { timeout: 20000 });
  cache = { chats: d.chats || {}, messages: (d.messages || []).slice().sort((a, b) => a.date.localeCompare(b.date)), syncedAt: d.syncedAt || null, me: d.me || null };
  window.dispatchEvent(new Event('ultimate:tg'));
  return cache;
}
export async function sync() {
  if (syncing) return null;
  syncing = true; window.dispatchEvent(new Event('ultimate:tg'));
  try {
    const r = await call('sync', { timeout: 310000 });
    if (!r.ok) throw new Error(r.error || 'сбор не удался');
    await load(); await refreshStatus();
    return r;
  } finally { syncing = false; window.dispatchEvent(new Event('ultimate:tg')); }
}
export function stale(ms = 15 * 60 * 1000) { const t = cache?.syncedAt || status?.syncedAt; return !t || Date.now() - new Date(t).getTime() > ms; }
// Тихая загрузка на Mac (для главной): без сбора, только то, что уже лежит на диске
export async function autoLoad() { try { if (cache) return cache; if (await base() === null) return null; await refreshStatus(); if (status?.session) await load(); return cache; } catch { return null; } }

// ---------- выборки ----------
const p = prefs;
export const chatList = () => Object.values(cache?.chats || {}).sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
export const activeChats = () => chatList().filter(c => !p().exclude.includes(c.id));
export const chatName = (id) => cache?.chats?.[id]?.name || '?';
export const chatOf = (id) => cache?.chats?.[id] || null;
// Ссылка в Telegram: личный чат — по id или @username; группа — на последнее сообщение (для супергрупп)
export function chatLink(chat, msgId = null) {
  if (!chat) return '';
  if (chat.kind === 'user') return chat.username ? `https://t.me/${chat.username}` : `tg://user?id=${String(chat.id).replace(/^-/, '')}`;
  const id = String(chat.id);
  if (id.startsWith('-100')) return `https://t.me/c/${id.slice(4)}${msgId ? `/${msgId}` : ''}`;
  return '';
}
const sinceIso = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString();
export function messagesSince(hours, { includeExcluded = false } = {}) {
  const ex = new Set(includeExcluded ? [] : p().exclude);
  const since = sinceIso(hours);
  return (cache?.messages || []).filter(m => m.date >= since && !ex.has(m.chat));
}
export const messagesOf = (chatId, n = 60) => (cache?.messages || []).filter(m => m.chat === chatId).slice(-n);

// Кто ждёт ответа: личные чаты, где последнее сообщение не моё и ему больше minHours часов.
// Отмеченные «прочитано» (до нового сообщения) и «не важные» чаты не показываются; важные люди — первыми.
export function waitingForMe({ minHours = 2, maxDays = 7, includeDismissed = false } = {}) {
  if (!cache) return [];
  const pr = p();
  const ex = new Set(pr.exclude);
  const since = sinceIso(maxDays * 24);
  const lastByChat = new Map();
  for (const m of cache.messages) if (m.date >= since) lastByChat.set(m.chat, m);   // отсортированы по дате
  const out = [];
  for (const [chatId, m] of lastByChat) {
    const chat = cache.chats[chatId];
    if (!chat || chat.kind !== 'user' || ex.has(chatId) || m.me) continue;
    const priority = Number(pr.priority?.[chatId]) || 0;
    if (priority < 0) continue;
    if (!includeDismissed && (pr.dismissed?.[chatId] || 0) >= m.id) continue;
    const hours = (Date.now() - new Date(m.date).getTime()) / 3600000;
    if (hours < minHours) continue;
    const thread = cache.messages.filter(x => x.chat === chatId && x.date >= since).slice(-4);
    out.push({ chat, msg: m, hours, thread, priority });
  }
  return out.sort((a, b) => b.priority - a.priority || a.msg.date.localeCompare(b.msg.date));
}
export const importantWaiting = () => waitingForMe().filter(w => w.priority > 0);

// Затишье: важные люди, с которыми давно не было переписки (по дате последнего сообщения в диалоге).
export function quietContacts({ days = p().quietDays || 7 } = {}) {
  if (!cache) return [];
  const pr = p();
  const out = [];
  for (const [id, v] of Object.entries(pr.priority || {})) {
    if (Number(v) <= 0) continue;
    const chat = cache.chats[id]; if (!chat || chat.kind !== 'user') continue;
    const last = chat.lastAt ? new Date(chat.lastAt).getTime() : 0;
    const d = last ? (Date.now() - last) / 86400000 : 999;
    if (d >= days) out.push({ chat, days: Math.floor(d), lastAt: chat.lastAt || null });
  }
  return out.sort((a, b) => b.days - a.days);
}

// ---------- текст для модели ----------
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const hm = (iso) => { const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const WD = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const todayLine = () => { const d = new Date(); return `Сегодня ${today()} (${WD[d.getDay()]}).`; };
export function transcript({ hours = 24, maxChars = 12000, perChat = 40 } = {}) {
  const msgs = messagesSince(hours);
  const byChat = new Map();
  for (const m of msgs) (byChat.get(m.chat) || byChat.set(m.chat, []).get(m.chat)).push(m);
  const pr = p();
  const chats = [...byChat.entries()].sort((a, b) => (Number(pr.priority?.[b[0]]) || 0) - (Number(pr.priority?.[a[0]]) || 0) || b[1][b[1].length - 1].date.localeCompare(a[1][a[1].length - 1].date));
  let text = '', used = 0;
  for (const [id, list] of chats) {
    const chat = cache.chats[id];
    const block = `## ${chat?.name || '?'} (${chat?.kind === 'group' ? 'группа' : 'личный чат'}${(Number(pr.priority?.[id]) || 0) > 0 ? ', важный человек' : ''})\n` +
      list.slice(-perChat).map(m => `[${hm(m.date)}] ${m.me ? 'Я' : cut(m.from || 'Собеседник', 30)}: ${cut(m.text, 300)}`).join('\n') + '\n\n';
    if (text.length + block.length > maxChars) { if (!text) text = block.slice(0, maxChars); break; }
    text += block; used++;
  }
  return { text, chats: used, messages: msgs.length };
}

export function analysisPrompt(text, { name = '' } = {}) {
  return `Ты — ассистент${name ? ` пользователя по имени ${name}` : ''}. ${todayLine()} Ниже — переписка пользователя в Telegram за последнее время (строки «Я:» — сообщения самого пользователя). Разбери её и верни СТРОГО JSON без пояснений, по схеме:
{
  "waiting": [{"chat": "название чата", "who": "кто ждёт", "ask": "что именно спрашивают или ждут, одной фразой"}],
  "my_promises": [{"chat": "чат", "text": "что я обещала сделать", "due": "срок словами или пусто", "due_date": "YYYY-MM-DD, если срок можно вычислить по дате сообщения и сегодняшней дате, иначе пусто"}],
  "their_promises": [{"chat": "чат", "who": "кто", "text": "что обещали мне", "due": "срок или пусто", "due_date": "YYYY-MM-DD или пусто"}],
  "requests": [{"chat": "чат", "who": "кто", "text": "просьба или задача для меня, которая ещё не сделана", "due_date": "YYYY-MM-DD или пусто"}],
  "summary": ["3–6 коротких пунктов: что важного произошло в чатах"]
}
Как различать:
- waiting — вопрос или сообщение КО МНЕ, на которое я ещё не ответила (после него нет моей реплики «Я:»).
- my_promises — то, что Я сама написала, что сделаю («пришлю», «сделаю», «посмотрю»).
- their_promises — то, что СОБЕСЕДНИК написал, что сделает он («отправлю тебе», «подготовлю»). Это не просьба ко мне и не waiting.
- requests — то, что просят сделать МЕНЯ («подготовь», «пришли», «можешь…»). Одну и ту же просьбу не дублируй в waiting.
- due_date: «завтра», «в пятницу», «к понедельнику», «до 15-го» переводи в дату, считая от даты сообщения; если срока нет — пусто.
Правила: только то, что есть в переписке, ничего не выдумывай; пустые списки оставляй пустыми; пиши по-русски, коротко.

Переписка:
${text}`;
}

// Черновик ответа на последнее сообщение в личном чате: короткий, в тоне самого пользователя (по его репликам).
export function draftPrompt(chatId, { name = '' } = {}) {
  const chat = cache?.chats?.[chatId]; if (!chat) return '';
  const list = messagesOf(chatId, 14);
  const mine = (cache?.messages || []).filter(m => m.me).slice(-12).map(m => cut(m.text, 120)).filter(Boolean);
  return `Ты помогаешь${name ? ` ${name}` : ' пользователю'} ответить в Telegram. ${todayLine()}
Ниже — переписка с «${chat.name}» (строки «Я:» — сообщения пользователя). Напиши ЧЕРНОВИК ответа на последние сообщения собеседника от лица пользователя: 1–3 коротких предложения, по делу, в том же тоне и стиле, что и реплики «Я:» (обращение на ты/вы, степень формальности, эмодзи — как у пользователя). Если собеседник задал вопрос, на который нужна информация, которой нет в переписке, оставь в скобках место для неё: «[когда]», «[сумма]». Верни только текст ответа, без кавычек и пояснений.
${mine.length ? `\nПримеры реплик пользователя в других чатах (для тона):\n${mine.map(t => `- ${t}`).join('\n')}\n` : ''}
Переписка:
${list.map(m => `[${hm(m.date)}] ${m.me ? 'Я' : cut(m.from || chat.name, 30)}: ${cut(m.text, 400)}`).join('\n')}`;
}

// Разбор одной группы: что решили, кто что взял, открытые вопросы, что касается меня.
export function groupTranscript(chatId, { maxChars = 11000, limit = 120 } = {}) {
  const list = messagesOf(chatId, limit);
  let text = '';
  for (const m of list.slice().reverse()) { const line = `[${hm(m.date)}] ${m.me ? 'Я' : cut(m.from || '?', 30)}: ${cut(m.text, 350)}\n`; if (text.length + line.length > maxChars) break; text = line + text; }
  return { text, messages: list.length };
}
export function groupPrompt(chatId, text, { name = '' } = {}) {
  const chat = cache?.chats?.[chatId];
  return `Ты — ассистент${name ? ` пользователя по имени ${name}` : ''}. ${todayLine()} Ниже — переписка рабочей группы «${chat?.name || ''}» в Telegram (строки «Я:» — сообщения пользователя). Разбери её и верни СТРОГО JSON без пояснений:
{
  "decisions": ["что решили или о чём договорились — по одному пункту"],
  "owners": [{"who": "кто", "what": "что взял на себя или ему поручили", "due": "срок словами или пусто", "due_date": "YYYY-MM-DD или пусто"}],
  "open": ["открытые вопросы, на которые никто не ответил"],
  "for_me": ["что касается пользователя: просьбы, упоминания, ожидания от него"],
  "summary": ["2–4 пункта: о чём была переписка"]
}
Правила: только то, что есть в переписке; пустые списки оставляй пустыми; пиши по-русски, коротко; имена — как в переписке.

Переписка:
${text}`;
}

// Поиск для помощника: по тексту и/или по имени чата или собеседника.
export function searchMessages({ query = '', chat = '', limit = 20, hours = 24 * 14 } = {}) {
  if (!cache) return [];
  const q = String(query || '').toLowerCase().trim(), c = String(chat || '').toLowerCase().trim();
  const since = sinceIso(hours);
  return cache.messages.filter(m => m.date >= since && (!c || chatName(m.chat).toLowerCase().includes(c) || String(m.from || '').toLowerCase().includes(c)) && (!q || String(m.text).toLowerCase().includes(q)))
    .slice(-limit).map(m => ({ chat: chatName(m.chat), from: m.me ? 'Я' : m.from, date: m.date, text: cut(m.text, 400) }));
}
export const fmtMsg = (m) => `[${hm(m.date)}] ${m.chat} · ${m.from}: ${m.text}`;
