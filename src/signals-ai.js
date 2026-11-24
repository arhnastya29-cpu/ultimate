// Разметка новостей моделью: тема, важность, повторы. Работает пачками, чтобы влезать в контекст локальной модели.
import { db } from './db.js';
import { items, sources, topics, untagged, applyTags, isPrimary } from './signals.js';
import { askPlain, aiReady } from './ai.js';

const BATCH = 20;
let busy = false, progress = null;
export const isTagging = () => busy;
export const tagProgress = () => progress;

const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function prompt(batch, known, srcName) {
  const list = topics();
  return `Ты — редактор новостной ленты. Темы: ${list.join(', ')}.
Для каждой новой записи определи:
- topic — одна тема из списка (если не подходит ни одна — «${list.includes('Другое') ? 'Другое' : list[list.length - 1]}»);
- importance — 3: важно знать сегодня (законы и решения регуляторов, крупные сделки и смены руководства, события, меняющие рынок или работу пользователя), 2: полезно знать, 1: фон — скидки, обзоры гаджетов, развлечения, мелкие апдейты, реклама; «важно» ставь не больше чем четверти записей;
- dup — если запись рассказывает о том же событии, что другая: номер новой записи (число) или код известной («E3»); иначе null. Повтор — это то же событие, а не просто та же тема.

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
