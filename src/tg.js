// Чаты Telegram: данные приходят с локального сервера ULTIMATE (serve.py → tg/collect.py) и живут только
// в памяти страницы и на диске Mac (tg/data/messages.json). В базу приложения и в облачную синхронизацию
// переписка не попадает. Здесь: загрузка, «кто ждёт ответа» без модели, текст для разбора моделью, поиск.
import { bridgeStatus, probeLocal } from './signals.js';

const PREFS_KEY = 'ultimate_tg_prefs';
const SUMMARY_KEY = 'ultimate_tg_summary';
let cache = null;            // { chats: {id: {...}}, messages: [...], syncedAt, me }
let status = null;           // ответ /__tg/status
let syncing = false;

export const isSyncing = () => syncing;
export const tgData = () => cache;
export const tgStatus = () => status;

export function prefs() { try { return { exclude: [], hours: 24, allowCloud: false, ...(JSON.parse(localStorage.getItem(PREFS_KEY) || 'null') || {}) }; } catch { return { exclude: [], hours: 24, allowCloud: false }; } }
export function setPrefs(patch) { try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs(), ...patch })); } catch {} }
export function lastSummary() { try { return JSON.parse(localStorage.getItem(SUMMARY_KEY) || 'null'); } catch { return null; } }
export function saveSummary(obj) { try { localStorage.setItem(SUMMARY_KEY, JSON.stringify({ ...obj, at: new Date().toISOString() })); } catch {} }

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

// ---------- выборки ----------
const p = prefs;
export const chatList = () => Object.values(cache?.chats || {}).sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
export const activeChats = () => chatList().filter(c => !p().exclude.includes(c.id));
export const chatName = (id) => cache?.chats?.[id]?.name || '?';
const sinceIso = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString();
export function messagesSince(hours, { includeExcluded = false } = {}) {
  const ex = new Set(includeExcluded ? [] : p().exclude);
  const since = sinceIso(hours);
  return (cache?.messages || []).filter(m => m.date >= since && !ex.has(m.chat));
}

// Кто ждёт ответа: личные чаты, где последнее сообщение не моё и ему больше minHours часов.
export function waitingForMe({ minHours = 2, maxDays = 7 } = {}) {
  if (!cache) return [];
  const ex = new Set(p().exclude);
  const since = sinceIso(maxDays * 24);
  const lastByChat = new Map();
  for (const m of cache.messages) if (m.date >= since) lastByChat.set(m.chat, m);   // отсортированы по дате
  const out = [];
  for (const [chatId, m] of lastByChat) {
    const chat = cache.chats[chatId];
    if (!chat || chat.kind !== 'user' || ex.has(chatId) || m.me) continue;
    const hours = (Date.now() - new Date(m.date).getTime()) / 3600000;
    if (hours < minHours) continue;
    const thread = cache.messages.filter(x => x.chat === chatId && x.date >= since).slice(-4);
    out.push({ chat, msg: m, hours, thread });
  }
  return out.sort((a, b) => a.msg.date.localeCompare(b.msg.date));
}

// ---------- текст для модели ----------
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const hm = (iso) => { const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
export function transcript({ hours = 24, maxChars = 12000, perChat = 40 } = {}) {
  const msgs = messagesSince(hours);
  const byChat = new Map();
  for (const m of msgs) (byChat.get(m.chat) || byChat.set(m.chat, []).get(m.chat)).push(m);
  const chats = [...byChat.entries()].sort((a, b) => b[1][b[1].length - 1].date.localeCompare(a[1][a[1].length - 1].date));
  let text = '', used = 0;
  for (const [id, list] of chats) {
    const chat = cache.chats[id];
    const block = `## ${chat?.name || '?'} (${chat?.kind === 'group' ? 'группа' : 'личный чат'})\n` +
      list.slice(-perChat).map(m => `[${hm(m.date)}] ${m.me ? 'Я' : cut(m.from || 'Собеседник', 30)}: ${cut(m.text, 300)}`).join('\n') + '\n\n';
    if (text.length + block.length > maxChars) { if (!text) text = block.slice(0, maxChars); break; }
    text += block; used++;
  }
  return { text, chats: used, messages: msgs.length };
}

export function analysisPrompt(text, { name = '' } = {}) {
  return `Ты — ассистент${name ? ` пользователя по имени ${name}` : ''}. Ниже — переписка пользователя в Telegram за последнее время (строки «Я:» — сообщения самого пользователя). Разбери её и верни СТРОГО JSON без пояснений, по схеме:
{
  "waiting": [{"chat": "название чата", "who": "кто ждёт", "ask": "что именно спрашивают или ждут, одной фразой"}],
  "my_promises": [{"chat": "чат", "text": "что я обещала сделать", "due": "срок словами или пусто"}],
  "their_promises": [{"chat": "чат", "who": "кто", "text": "что обещали мне", "due": "срок или пусто"}],
  "requests": [{"chat": "чат", "who": "кто", "text": "просьба или задача для меня, которая ещё не сделана"}],
  "summary": ["3–6 коротких пунктов: что важного произошло в чатах"]
}
Как различать:
- waiting — вопрос или сообщение КО МНЕ, на которое я ещё не ответила (после него нет моей реплики «Я:»).
- my_promises — то, что Я сама написала, что сделаю («пришлю», «сделаю», «посмотрю»).
- their_promises — то, что СОБЕСЕДНИК написал, что сделает он («отправлю тебе», «подготовлю»). Это не просьба ко мне и не waiting.
- requests — то, что просят сделать МЕНЯ («подготовь», «пришли», «можешь…»). Одну и ту же просьбу не дублируй в waiting.
Правила: только то, что есть в переписке, ничего не выдумывай; пустые списки оставляй пустыми; пиши по-русски, коротко.

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
