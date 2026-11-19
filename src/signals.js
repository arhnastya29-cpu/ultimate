// Сигналы: источники новостей (RSS/Atom/JSON-ленты, сайты, Telegram-каналы), загрузка и разбор лент,
// лента записей в базе и сводка от помощника.
//
// Данные:
//   signalSources: { id, name, kind: 'rss'|'telegram'|'site', url (что ввёл пользователь), feedUrl (откуда читаем),
//                    tag, paused, lastFetchAt, lastError, lastCount, siteUrl, renamed }
//   signalItems:   { id (детерминированный: источник + ссылка), sourceId, title, link, date, summary, read, saved, fetchedAt }
//   signalDigests: { id, date, period, text, itemIds, provider }
//
// Браузер не может читать чужие сайты напрямую (CORS), поэтому загрузка идёт через «мост»:
//   1) локальный сервер ULTIMATE (serve.py, когда приложение открыто через start.command) — самый надёжный;
//   2) прямой запрос — если сайт сам разрешает;
//   3) публичные CORS-прокси (видят только адрес ленты, никаких ваших данных).
// В настройках можно задать свой адрес моста (signalsProxy): 'auto' | 'local' | 'direct' | шаблон с {url}.

import { db } from './db.js';
import { today, addDays } from './ui.js';

export const KINDS = { rss: 'Лента', telegram: 'Telegram', site: 'Сайт' };
const PUBLIC_PROXIES = [
  'https://api.allorigins.win/raw?url={url}',
  'https://api.codetabs.com/v1/proxy?quest={url}',
  'https://api.rss2json.com/v1/api.json?rss_url={url}',   // только для RSS: отдаёт ленту в виде JSON (см. parseJsonFeed)
];
const MAX_ITEMS_PER_SOURCE = 60;
const SUMMARY_LEN = 500;

// ---------- мост к сети ----------
let localOk = null;      // null — ещё не проверяли
let lastGood = null;     // шаблон публичного прокси, который сработал последним
export const proxyMode = () => db.settings().signalsProxy || 'auto';
export function bridgeStatus() { return { local: localOk, lastGood }; }

export async function probeLocal() {
  try {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch('/__ping', { signal: ctl.signal, cache: 'no-store' }); clearTimeout(tm);
    const j = r.ok ? await r.json() : null;
    localOk = !!(j && j.app === 'ultimate');
  } catch { localOk = false; }
  return localOk;
}

const LOCAL = '/__fetch/{key}?url={url}';   // {key} делает адрес уникальным, чтобы браузер не отдал старый ответ из кэша
async function fetchVia(template, url, signal) {
  const target = template === 'direct' ? url : template.replace('{key}', Date.now().toString(36)).replace('{url}', encodeURIComponent(url));
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 25000);
  signal?.addEventListener('abort', () => ctl.abort());
  try {
    const r = await fetch(target, { signal: ctl.signal, cache: 'no-store', headers: template === 'direct' ? {} : { 'accept': '*/*' } });
    if (!r.ok) {
      let msg = `ответ ${r.status}`;
      if (template === LOCAL) { try { msg = (await r.json()).error || msg; } catch {} }
      throw new Error(msg);
    }
    const text = await r.text();
    if (!text.trim()) throw new Error('пустой ответ');
    return { text, type: r.headers.get('content-type') || '', finalUrl: r.headers.get('x-final-url') || url };
  } finally { clearTimeout(tm); }
}

// Загружает текст по адресу через доступные мосты. Возвращает { text, type, finalUrl }.
// quick: только самый надёжный мост (для перебора адресов при поиске ленты).
export async function fetchText(url, { signal, quick = false } = {}) {
  const mode = proxyMode();
  const chain = [];
  if (mode === 'local') chain.push(LOCAL);
  else if (mode === 'direct') chain.push('direct');
  else if (mode !== 'auto') chain.push(mode);
  else {
    if (localOk === null) await probeLocal();
    if (localOk) chain.push(LOCAL);
    if (lastGood) chain.push(lastGood);
    chain.push('direct', ...PUBLIC_PROXIES.filter(p => p !== lastGood));
  }
  if (quick) chain.splice(chain[0] === 'direct' ? 2 : 1);   // локальный мост или известный прокси; иначе «напрямую + один прокси»
  const errors = [];
  for (const t of chain) {
    if (signal?.aborted) throw new Error('отменено');
    try {
      const res = await fetchVia(t, url, signal);
      if (t !== 'direct' && t !== LOCAL) lastGood = t;
      return res;
    } catch (e) {
      if (t === LOCAL && /ответил ошибкой/.test(e.message || '')) throw new Error(e.message);   // сайт ответил — другие мосты не помогут
      errors.push(`${t === 'direct' ? 'напрямую' : t === LOCAL ? 'локально' : new URL(t.replace('{url}', 'x')).host}: ${e.message || e}`);
    }
  }
  throw new Error('Не удалось загрузить. ' + errors.slice(0, 3).join('; '));
}

// ---------- разбор ----------
const stripTags = (html) => { const d = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html'); return (d.body.textContent || '').replace(/\s+/g, ' ').trim(); };
const cut = (s, n = SUMMARY_LEN) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const isoDate = (s) => { const d = new Date(s || ''); return isNaN(d) ? null : d.toISOString(); };
const q = (node, sel) => { for (const s of sel.split(',')) { const el = [...node.children].find(c => c.localName === s.trim() || c.tagName === s.trim()); if (el) return el; } return null; };
const txt = (node, sel) => { const el = q(node, sel); return el ? (el.textContent || '').trim() : ''; };

export function parseFeed(text, baseUrl = '') {
  const t = text.trim();
  if (t.startsWith('{')) return parseJsonFeed(JSON.parse(t), baseUrl);
  const doc = new DOMParser().parseFromString(t, 'text/xml');
  if (doc.querySelector('parsererror')) {
    // Иногда прокси отдаёт HTML-обёртку или ленту с мусором в начале — попробуем вырезать
    const m = t.match(/<(rss|feed|rdf:RDF)[\s\S]*<\/\1>/i);
    if (!m) throw new Error('это не RSS-лента');
    return parseFeed(m[0], baseUrl);
  }
  const root = doc.documentElement;
  if (root.localName === 'feed') {                         // Atom
    const title = txt(root, 'title');
    const items = [...root.children].filter(c => c.localName === 'entry').map(e => {
      const links = [...e.children].filter(c => c.localName === 'link');
      const alt = links.find(l => !l.getAttribute('rel') || l.getAttribute('rel') === 'alternate') || links[0];
      const body = txt(e, 'summary') || txt(e, 'content');
      return { title: txt(e, 'title'), link: abs(alt?.getAttribute('href') || '', baseUrl), date: isoDate(txt(e, 'published') || txt(e, 'updated')), summary: cut(stripTags(body)) };
    });
    return { title, items, siteUrl: [...root.children].find(c => c.localName === 'link' && (c.getAttribute('rel') || 'alternate') === 'alternate')?.getAttribute('href') || '' };
  }
  if (root.localName !== 'rss' && root.localName !== 'RDF') throw new Error('это не RSS-лента');
  const channel = root.localName === 'rss' ? q(root, 'channel') : root;   // RSS 2.0 или RDF
  const title = channel ? txt(channel, 'title') : '';
  const nodes = [...(channel ? channel.children : []), ...(root.localName !== 'rss' ? root.children : [])].filter(c => c.localName === 'item');
  const items = nodes.map(it => {
    const encoded = [...it.children].find(c => c.localName === 'encoded');   // content:encoded
    const body = txt(it, 'description') || (encoded ? encoded.textContent : '');
    const link = txt(it, 'link') || [...it.children].find(c => c.localName === 'link')?.getAttribute('href') || txt(it, 'guid');
    return { title: txt(it, 'title') || cut(stripTags(body), 90), link: abs(link, baseUrl), date: isoDate(txt(it, 'pubDate') || txt(it, 'date') || txt(it, 'updated')), summary: cut(stripTags(body)) };
  });
  return { title, items, siteUrl: channel ? txt(channel, 'link') : '' };
}

function parseJsonFeed(j, baseUrl) {
  if (j.status && j.feed && Array.isArray(j.items)) {   // ответ rss2json
    if (j.status !== 'ok') throw new Error(j.message || 'лента не прочиталась');
    return { title: j.feed.title || '', siteUrl: j.feed.link || '', items: j.items.map(i => ({ title: i.title || '', link: abs(i.link || i.guid || '', baseUrl), date: isoDate(i.pubDate), summary: cut(stripTags(i.description || i.content || '')) })) };
  }
  const items = (j.items || []).map(i => ({ title: i.title || cut(stripTags(i.content_text || i.content_html), 90), link: abs(i.url || i.external_url || i.id || '', baseUrl), date: isoDate(i.date_published || i.date_modified), summary: cut(i.content_text || stripTags(i.content_html || i.summary || '')) }));
  return { title: j.title || '', items, siteUrl: j.home_page_url || '' };
}

function abs(href, base) { try { return new URL(href, base || undefined).href; } catch { return href || ''; } }

// Telegram: публичная веб-версия канала t.me/s/<канал>
export const telegramName = (input) => { const s = String(input || '').trim(); const m = s.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:s\/)?@?([A-Za-z0-9_]{3,})/i) || s.match(/^@([A-Za-z0-9_]{3,})$/); return m ? m[1] : null; };
export function parseTelegram(html, channel) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = (doc.querySelector('.tgme_channel_info_header_title')?.textContent || doc.querySelector('.tgme_header_title')?.textContent || channel).trim();
  const items = [...doc.querySelectorAll('.tgme_widget_message')].map(m => {
    const post = m.getAttribute('data-post') || '';
    const textEl = m.querySelector('.tgme_widget_message_text');
    const text = (textEl?.innerText || textEl?.textContent || '').replace(/\s+/g, ' ').trim();
    const date = m.querySelector('.tgme_widget_message_date time')?.getAttribute('datetime') || '';
    const preview = m.querySelector('.link_preview_title')?.textContent?.trim();
    if (!text && !preview) return null;
    return { title: cut(text || preview, 110), link: post ? `https://t.me/${post}` : `https://t.me/s/${channel}`, date: isoDate(date), summary: cut(text) };
  }).filter(Boolean);
  if (!items.length && !doc.querySelector('.tgme_widget_message_wrap')) throw new Error('канал закрыт или не найден (веб-превью недоступно)');
  return { title, items, siteUrl: `https://t.me/${channel}` };
}

// Поиск ленты на сайте: <link rel="alternate" type="application/rss+xml"> или типовые адреса
async function discoverFeed(url, signal) {
  const res = await fetchText(url, { signal });
  const t = res.text.trim();
  if (t.startsWith('{') || /^<\?xml|<rss|<feed|<rdf:RDF/i.test(t.slice(0, 300))) return { feedUrl: url, feed: parseFeed(t, url) };
  const doc = new DOMParser().parseFromString(t, 'text/html');
  const alt = [...doc.querySelectorAll('link[rel="alternate"]')].find(l => /rss|atom|feed\+json|json/i.test(l.getAttribute('type') || ''));
  const cands = [];
  if (alt) cands.push(abs(alt.getAttribute('href'), res.finalUrl || url));
  const base = (() => { try { return new URL(res.finalUrl || url); } catch { return null; } })();
  if (base) for (const p of ['/rss', '/feed', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml', '/feed/', '/rss/', '/blog/feed', '/blog/rss.xml']) cands.push(new URL(p, base.origin + (base.pathname.replace(/\/$/, '') || '')).href, new URL(p, base.origin).href);
  const seen = new Set(); const errors = [];
  for (const c of cands) {
    if (seen.has(c)) continue; seen.add(c);
    try { const r = await fetchText(c, { signal, quick: true }); const feed = parseFeed(r.text, c); if (feed.items.length) return { feedUrl: c, feed }; }
    catch (e) { errors.push(e.message); }
    if (errors.length > 6) break;
  }
  throw new Error('На сайте не нашлась RSS-лента. Если знаете её адрес — вставьте его напрямую.');
}

// ---------- источники ----------
// Определяет тип по вводу и проверяет, что оттуда читается. Возвращает { kind, url, feedUrl, name, siteUrl, items }.
export async function resolveSource(input, { signal } = {}) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Введите адрес');
  const tg = telegramName(s);
  if (tg) {
    const r = await fetchText(`https://t.me/s/${tg}`, { signal });
    const feed = parseTelegram(r.text, tg);
    return { kind: 'telegram', url: `https://t.me/${tg}`, feedUrl: `https://t.me/s/${tg}`, name: feed.title, siteUrl: feed.siteUrl, items: feed.items };
  }
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { new URL(s); } catch { throw new Error('Похоже, это не адрес сайта'); }
  const { feedUrl, feed } = await discoverFeed(s, signal);
  let name = feed.title; try { name ||= new URL(s).host.replace(/^www\./, ''); } catch {}
  return { kind: feedUrl === s ? 'rss' : 'site', url: s, feedUrl, name, siteUrl: feed.siteUrl, items: feed.items };
}

export const sources = () => db.all('signalSources');
export const activeSources = () => sources().filter(s => !s.paused);
export function addSource({ kind, url, feedUrl, name, siteUrl, tag = '' }) {
  const dup = sources().find(s => s.feedUrl === feedUrl);
  if (dup) return dup;
  return db.add('signalSources', { kind, url, feedUrl, name: name || url, siteUrl: siteUrl || '', tag, paused: false, lastFetchAt: null, lastError: '', lastCount: 0, renamed: false });
}
export function removeSource(id) {
  for (const it of db.where('signalItems', i => i.sourceId === id && !i.saved)) db.remove('signalItems', it.id);
  db.remove('signalSources', id);
}

// ---------- записи ----------
function hash(str) { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
export const items = () => db.all('signalItems');
export const unreadCount = () => items().filter(i => !i.read).length;

function storeItems(src, list) {
  const existing = new Set(db.where('signalItems', i => i.sourceId === src.id).map(i => i.id));
  const gone = db.tombstones?.signalItems || {};
  const now = new Date().toISOString();
  let added = 0;
  for (const it of list.slice(0, MAX_ITEMS_PER_SOURCE)) {
    if (!it.title && !it.summary) continue;
    const id = 'sig_' + hash(src.id + '|' + (it.link || it.title));
    if (existing.has(id) || gone[id]) continue;
    db.add('signalItems', { id, sourceId: src.id, title: cut(it.title, 200), link: it.link || '', date: it.date || now, summary: it.summary || '', read: false, saved: false, fetchedAt: now });
    existing.add(id); added++;
  }
  return added;
}

export function prune() {
  const keepDays = Number(db.settings().signalsKeepDays) || 14;
  const edge = addDays(today(), -keepDays);
  const srcIds = new Set(sources().map(s => s.id));
  for (const it of items()) {
    if (it.saved) continue;
    if (!srcIds.has(it.sourceId) || String(it.date || it.fetchedAt).slice(0, 10) < edge) db.remove('signalItems', it.id);
  }
  for (const sid of srcIds) {
    const list = db.where('signalItems', i => i.sourceId === sid && !i.saved).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    for (const it of list.slice(MAX_ITEMS_PER_SOURCE * 2)) db.remove('signalItems', it.id);
  }
}

export async function refreshSource(src, { signal } = {}) {
  try {
    const r = await fetchText(src.feedUrl, { signal });
    const feed = src.kind === 'telegram' ? parseTelegram(r.text, telegramName(src.url) || '') : parseFeed(r.text, src.feedUrl);
    const added = storeItems(src, feed.items);
    db.update('signalSources', src.id, { lastFetchAt: new Date().toISOString(), lastError: '', lastCount: added, ...(feed.title && !src.renamed ? { name: feed.title } : {}) });
    return { ok: true, added };
  } catch (e) {
    db.update('signalSources', src.id, { lastFetchAt: new Date().toISOString(), lastError: String(e.message || e) });
    return { ok: false, error: String(e.message || e) };
  }
}

let refreshing = false;
export const isRefreshing = () => refreshing;
export async function refreshAll({ signal, onProgress } = {}) {
  if (refreshing) return null;
  refreshing = true;
  window.dispatchEvent(new Event('ultimate:signals'));
  const list = activeSources();
  let done = 0, added = 0, failed = 0;
  try {
    const queue = [...list];
    const worker = async () => { while (queue.length) { const s = queue.shift(); const r = await refreshSource(s, { signal }); done++; if (r.ok) added += r.added; else failed++; onProgress?.({ done, total: list.length, added, failed }); } };
    await Promise.all(Array.from({ length: Math.min(3, list.length) }, worker));
    prune();
    try { localStorage.setItem('ultimate_signals_refreshed', new Date().toISOString()); } catch {}
  } finally { refreshing = false; window.dispatchEvent(new Event('ultimate:signals')); }
  return { total: list.length, added, failed };
}
export function lastRefreshAt() { try { return localStorage.getItem('ultimate_signals_refreshed') || null; } catch { return null; } }
// Обновлять автоматически не чаще раза в час при открытии раздела
export function staleFor(ms = 60 * 60 * 1000) { const t = lastRefreshAt(); return !t || Date.now() - new Date(t).getTime() > ms; }

// ---------- сводка ----------
// Подбирает записи за период и формирует текст для модели (ограничен по размеру, чтобы влезть в контекст локальной модели).
export function digestInput({ hours = 24, limit = 45, maxChars = 11000 } = {}) {
  const since = Date.now() - hours * 3600 * 1000;
  const srcById = new Map(sources().map(s => [s.id, s]));
  const live = items().filter(i => srcById.has(i.sourceId) && !srcById.get(i.sourceId).paused).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  let list = live.filter(i => new Date(i.date || i.fetchedAt).getTime() >= since);
  let period = `${hours}h`;
  if (list.length < 8) { list = live; period = 'all'; }   // мало за период — берём последние записи вообще
  // Равномерно по источникам: сначала по одной из каждого, потом по кругу
  const bySrc = new Map();
  for (const i of list) (bySrc.get(i.sourceId) || bySrc.set(i.sourceId, []).get(i.sourceId)).push(i);
  const picked = [];
  for (let round = 0; picked.length < limit; round++) {
    let any = false;
    for (const arr of bySrc.values()) { if (arr[round]) { picked.push(arr[round]); any = true; if (picked.length >= limit) break; } }
    if (!any) break;
  }
  let text = ''; const used = [];
  for (const [n, i] of picked.entries()) {
    const line = `${n + 1}. [${srcById.get(i.sourceId)?.name || '?'}] ${i.title}${i.summary && i.summary !== i.title ? ` — ${cut(i.summary, 220)}` : ''}\n`;
    if (text.length + line.length > maxChars) break;
    text += line; used.push(i);
  }
  return { text, items: used, period };
}

export const digests = () => [...db.all('signalDigests')].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
export const todayDigest = () => digests().find(d => d.date === today()) || null;
export function saveDigest({ text, itemIds, provider, period }) {
  const ex = todayDigest();
  const rec = { date: today(), text, itemIds, provider, period };
  return ex ? db.update('signalDigests', ex.id, rec) : db.add('signalDigests', rec);
}

export function digestPrompt(inputText, { focus = '', name = '' } = {}) {
  return `Ты — личный редактор новостей${name ? ` для ${name}` : ''}. Ниже — свежие записи из источников, которые пользователь выбрал сам (в квадратных скобках — название источника).
${focus ? `Что для пользователя важно в первую очередь: ${focus}.\n` : ''}
Составь короткую сводку по-русски в таком виде:

**Главное** — 3–5 пунктов. Каждый пункт: одна-две фразы по сути, в конце в скобках источник.
**Ещё заметить** — до 5 пунктов по одной строке.
**Что это значит для меня** — 1–2 фразы: на что обратить внимание или что стоит сделать${focus ? ', учитывая интересы пользователя' : ''}.

Правила: не выдумывай фактов, которых нет в записях; не повторяй одно и то же событие дважды; объединяй дубли из разных источников; без вступлений и без заключения; если записей мало или они пустые — так и скажи одной строкой.

Записи:
${inputText}`;
}
