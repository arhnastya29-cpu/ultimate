// Сигналы и модель: разметка новостей (тема, важность, повторы), краткий пересказ статьи, сводки за день и неделю,
// утренний автозапуск. Работает пачками и с ограничением по размеру, чтобы влезать в контекст локальной модели.
import { db } from './db.js';
import { items, sources, activeSources, topics, untagged, applyTags, isPrimary, focusTerms, votedExamples, digestInput, digestPrompt, saveDigest, todayDigest, weekDigest, fetchText, cleanDigest, refreshAll, staleFor, isRefreshing } from './signals.js';
import { askPlain, aiReady, aiProvider } from './ai.js';
import { today } from './ui.js';

const BATCH = 20;
let busy = false, progress = null;
export const isTagging = () => busy;
export const tagProgress = () => progress;

const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function prompt(batch, known, srcName) {
  const list = topics();
  const focus = String(db.settings().signalsFocus || '').trim();
  const ex = votedExamples(8);
  return `Ты — редактор новостной ленты. Темы: ${list.join(', ')}.
Для каждой новой записи определи:
- topic — одна тема из списка (если не подходит ни одна — «${list.includes('Другое') ? 'Другое' : list[list.length - 1]}»);
- importance — 3: важно знать сегодня (законы и решения регуляторов, крупные сделки и смены руководства, события, меняющие рынок или работу пользователя${focus ? ', а также всё, что прямо касается интересов пользователя' : ''}), 2: полезно знать, 1: фон — скидки, обзоры гаджетов, развлечения, мелкие апдейты, реклама; «важно» ставь не больше чем четверти записей;
- dup — если запись рассказывает о том же событии, что другая: номер новой записи (число) или код известной («E3»); иначе null. Повтор — это то же событие, а не просто та же тема.
${focus ? `\nИнтересы пользователя (что важно в первую очередь): ${focus}.` : ''}${ex.up.length ? `\nПримеры записей, которые пользователь отметил полезными:\n${ex.up.map(i => `- ${cut(i.title, 110)}`).join('\n')}` : ''}${ex.down.length ? `\nПримеры записей, которые пользователь отметил НЕполезными (похожее ставь в фон):\n${ex.down.map(i => `- ${cut(i.title, 110)}`).join('\n')}` : ''}

${known.length ? `Уже известные записи (для поиска повторов):\n${known.map((k, i) => `E${i + 1}. ${cut(k.title, 120)}`).join('\n')}\n\n` : ''}Новые записи:
${batch.map((it, i) => `${i + 1}. [${cut(srcName(it.sourceId), 25)}] ${cut(it.title, 140)}${it.summary && it.summary !== it.title ? ` — ${cut(it.summary, 160)}` : ''}`).join('\n')}

Верни СТРОГО JSON без пояснений: {"items":[{"n":1,"topic":"…","importance":2,"dup":null}, …]} — по одному объекту на каждую новую запись.`;
}

function parse(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/); if (!m) return null;
  try { const j = JSON.parse(m[0]); return Array.isArray(j.items) ? j.items : Array.isArray(j) ? j : null; } catch { return null; }
}

// Размечает все неразмеченные записи. onProgress({ done, total }).
export async function tagNew({ onProgress, signal, limit = 200 } = {}) {
  if (busy || !aiReady()) return null;
  const todo = untagged().sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, limit);
  if (!todo.length) return { done: 0 };
  busy = true; progress = { done: 0, total: todo.length };
  window.dispatchEvent(new Event('ultimate:signals'));
  const srcMap = new Map(sources().map(s => [s.id, s.name]));
  const srcName = (id) => srcMap.get(id) || '?';
  const since = new Date(Date.now() - 3 * 86400000).toISOString();
  let done = 0, errors = 0;
  try {
    for (let i = 0; i < todo.length; i += BATCH) {
      if (signal?.aborted) break;
      const batch = todo.slice(i, i + BATCH);
      const known = items().filter(x => x.tagged && isPrimary(x) && String(x.date) >= since && !batch.includes(x)).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 40);
      try {
        const raw = await askPlain(prompt(batch, known, srcName), { json: true, maxTokens: 1800, signal });
        const rows = parse(raw) || [];
        const map = {};
        for (const r of rows) {
          const it = batch[Number(r.n) - 1]; if (!it) continue;
          let dupOf = null;
          if (typeof r.dup === 'string' && /^E\d+$/i.test(r.dup.trim())) dupOf = known[Number(r.dup.trim().slice(1)) - 1]?.id || null;
          else if (r.dup != null && r.dup !== '' && Number(r.dup) > 0) { const other = batch[Number(r.dup) - 1]; if (other && other.id !== it.id) dupOf = other.id; }
          map[it.id] = { topic: r.topic, importance: r.importance, dupOf };
        }
        // Внутри пачки: если A→B и B→A, оставляем более раннюю как основную
        for (const [id, r] of Object.entries(map)) if (r.dupOf && map[r.dupOf]?.dupOf === id) { const a = db.get('signalItems', id), b = db.get('signalItems', r.dupOf); if (String(a.date) <= String(b.date)) r.dupOf = null; else map[r.dupOf].dupOf = null; }
        for (const it of batch) if (!map[it.id]) map[it.id] = { topic: '', importance: 2, dupOf: null };
        applyTags(map);
      } catch (e) { if (e.name === 'AbortError') break; errors++; console.warn('tagNew batch failed', e); if (errors > 2) break; }
      done += batch.length; progress = { done, total: todo.length }; onProgress?.(progress);
      window.dispatchEvent(new Event('ultimate:signals'));
    }
  } finally { busy = false; progress = null; window.dispatchEvent(new Event('ultimate:signals')); }
  return { done, errors };
}

// ---------- пересказ статьи ----------
// Загружает страницу по ссылке через мост, вытаскивает читаемый текст и просит модель пересказать в трёх строках.
const briefBusy = new Set();
export const isBriefing = (id) => briefBusy.has(id);
function readable(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const sel of ['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'iframe', 'svg', '[role=navigation]', '.share', '.comments', '.related']) doc.querySelectorAll(sel).forEach(n => n.remove());
  const root = doc.querySelector('article') || doc.querySelector('main') || doc.querySelector('[itemprop=articleBody]') || doc.querySelector('.post, .entry-content, .article, .content') || doc.body;
  const paras = [...(root?.querySelectorAll('p, h1, h2, h3, li') || [])].map(n => (n.textContent || '').replace(/\s+/g, ' ').trim()).filter(t => t.length > 30);
  let text = paras.join('\n');
  if (text.length < 300) text = (root?.textContent || '').replace(/\s+/g, ' ').trim();
  return text;
}
export async function brief(id, { signal, maxChars = 7000 } = {}) {
  const it = db.get('signalItems', id);
  if (!it || !it.link || briefBusy.has(id)) return null;
  if (!aiReady()) throw new Error('Помощник не подключён');
  briefBusy.add(id); window.dispatchEvent(new Event('ultimate:signals'));
  try {
    let text = '';
    if (/^https:\/\/t\.me\//.test(it.link)) text = it.summary || it.title;      // пост Telegram: весь текст уже в записи
    else {
      const r = await fetchText(it.link, { signal });
      text = /html/i.test(r.type) || /<html|<body|<p[\s>]/i.test(r.text.slice(0, 4000)) ? readable(r.text) : r.text;
    }
    text = String(text || '').trim();
    if (text.length < 200 && (it.summary || '').length > text.length) text = it.summary;
    if (!text) throw new Error('Не удалось прочитать текст статьи');
    text = text.slice(0, maxChars);
    const out = await askPlain(`Перескажи статью по-русски ровно в трёх коротких строках (каждая — одно предложение, без списков, заголовков и вступлений): 1) что произошло, 2) детали и цифры, 3) почему это важно или что будет дальше. Только факты из текста, ничего не выдумывай. Если это не статья, а список или реклама — скажи одной строкой, что там.\n\nЗаголовок: ${it.title}\nТекст:\n${text}`, { signal, maxTokens: 400 });
    const res = String(out || '').trim();
    if (!res) throw new Error('Пустой ответ модели');
    db.update('signalItems', id, { brief: res, briefAt: new Date().toISOString(), read: true });
    return res;
  } finally { briefBusy.delete(id); window.dispatchEvent(new Event('ultimate:signals')); }
}

// ---------- сводки ----------
let digestBusyKind = null;
export const digestBusy = () => digestBusyKind;
// Сводка за день (weekly=false) или неделю. onText — поток текста для отрисовки. Возвращает { text, items } или null, если нечего собирать.
export async function makeDigest({ weekly = false, signal, onText, minItems = 1 } = {}) {
  if (digestBusyKind || !aiReady()) return null;
  const s = db.settings();
  const input = weekly ? digestInput({ hours: 168, limit: 70, maxChars: 14000 }) : digestInput({ hours: Number(s.signalsHours) || 24 });
  if (input.items.length < minItems) return null;
  digestBusyKind = weekly ? 'week' : 'day'; window.dispatchEvent(new Event('ultimate:signals'));
  let draft = '';
  try {
    const raw = await askPlain(digestPrompt(input.text, { focus: s.signalsFocus || '', name: s.name || '', weekly }), { signal, maxTokens: weekly ? 1800 : 1500, onText: (tx) => { draft += tx; onText?.(draft); } });
    const text = cleanDigest(raw);
    const rec = { text, itemIds: input.items.map(i => i.id), provider: aiProvider(), period: input.period, kind: weekly ? 'week' : 'day' };
    saveDigest(rec);
    if (!weekly) for (const i of input.items) if (!i.read) db.update('signalItems', i.id, { read: true });
    return { text, items: input.items };
  } catch (e) {
    if (e.name === 'AbortError' && draft.trim()) { saveDigest({ text: cleanDigest(draft.trim()), itemIds: input.items.map(i => i.id), provider: aiProvider(), period: input.period, kind: weekly ? 'week' : 'day' }); return { text: draft.trim(), items: input.items }; }
    throw e;
  } finally { digestBusyKind = null; window.dispatchEvent(new Event('ultimate:signals')); }
}

// ---------- утренний запуск ----------
// При первом открытии за день (на любом устройстве, где доступна модель): обновить ленты, если давно не обновлялись,
// разметить новое, собрать сводку дня, а по понедельникам — и обзор недели. Повторно за день не запускается.
const AUTO_KEY = 'ultimate_signals_auto';
function autoState() { try { return JSON.parse(localStorage.getItem(AUTO_KEY) || 'null') || {}; } catch { return {}; } }
function setAuto(patch) { try { localStorage.setItem(AUTO_KEY, JSON.stringify({ ...autoState(), ...patch })); } catch {} }
let morningBusy = false;
export const isMorningRun = () => morningBusy;
export async function morningRun() {
  const s = db.settings();
  if (morningBusy || s.signalsAutoDigest === false || !activeSources().length || !aiReady()) return null;
  const d = today();
  const st = autoState();
  if (st.day === d && (todayDigest() || st.failed >= 2)) return null;   // уже есть сводка на сегодня или две неудачи подряд
  morningBusy = true;
  try {
    if (staleFor() && !isRefreshing()) await refreshAll();
    if (s.signalsAutoTag !== false && untagged().length) await tagNew({ limit: 120 });
    let made = null;
    if (!todayDigest()) made = await makeDigest({ minItems: 3 });
    if (s.signalsWeekly !== false && !weekDigest() && new Date().getDay() === 1) await makeDigest({ weekly: true, minItems: 8 }).catch(e => console.warn('weekly digest', e));
    setAuto({ day: d, at: new Date().toISOString(), failed: 0 });
    return made;
  } catch (e) {
    console.warn('morningRun', e);
    setAuto({ day: d, failed: (st.day === d ? st.failed || 0 : 0) + 1 });
    return null;
  } finally { morningBusy = false; window.dispatchEvent(new Event('ultimate:signals')); }
}
// Планировщик: пробует после загрузки и при появлении модели (Ollama отвечает не сразу).
export function scheduleMorningRun() {
  let tries = 0;
  const attempt = () => { if (tries++ > 6) return; if (aiReady()) morningRun(); else setTimeout(attempt, 20000); };
  setTimeout(attempt, 5000);
  window.addEventListener('ultimate:ai', () => { if (aiReady()) morningRun(); });
}
