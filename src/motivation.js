// Приветствие, послания и короткие подбадривания. Всё зависит от тона (settings.tone):
//   neutral  — «Доброе утро, Анастасия» (или без обращения), без цитат и восклицаний;
//   support  — «Доброе утро, чемпион», подбадривания при закрытии дел;
//   business — сухо, по делу.
// Цитаты показываются только при settings.quotes = true. Источник — заметки с пометкой «цитата»
// (рекомендации CEO из Shadow и любые другие); встроенные — лишь если помеченных нет.
import { today } from './ui.js';
import { db } from './db.js';
import { tone, quotesOn, addressing, quotePool } from './model.js';

const QUOTES = [
  'Дисциплина — это выбирать то, чего хочешь больше всего, вместо того, чего хочешь сейчас.',
  'Большие цели не пугают того, кто делает маленькие шаги каждый день.',
  'Один сфокусированный час стоит дня суеты.',
  'Не жди мотивации. Действие рождает её, а не наоборот.',
  'Сделай главное до обеда — и день уже твой.',
  'Говори «нет» хорошему, чтобы сказать «да» лучшему.',
  'Энергия важнее времени. Береги сон, как главный ресурс.',
  'Спокойная уверенность громче любого крика.',
  'Победа любит подготовку. Подготовься.',
  'Решение за три секунды лучше, чем сомнение за три дня.',
  'Сила не в том, чтобы всё успеть. Сила в том, чтобы выбрать главное.',
  'Начни с самого страшного пункта. Остальные покажутся лёгкими.',
  'Фокус — это сказать «нет» ста вещам, чтобы сделать одну блестяще.',
  'Уверенность приходит не до действия, а после него.',
  'Работай тихо. Пусть результат шумит.',
  'Где внимание — там и результат. Направь внимание.',
];

const CHEERS = {
  support: ['Есть, чемпион!', 'Ещё одно сделано. Так держать!', 'Красиво закрыто.', 'Минус одно, плюс уверенность.', 'Темп хороший, не сбавляй.', 'Сильный ход.', 'Так выглядит дисциплина.'],
  business: ['Сделано.', 'Закрыто.', 'Готово, следующее.'],
  neutral: [],
};
const HABIT_CHEERS = {
  support: ['Привычка держится — характер крепнет.', 'Ещё один день в копилку.', 'Серия растёт, чемпион.', 'Вот это постоянство.'],
  business: ['Отмечено.'],
  neutral: [],
};

function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return Math.abs(h >>> 0); }

export function greetingFor(hour = new Date().getHours()) {
  const g = hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';
  const who = addressing();
  return who ? `${g}, ${who}` : g;
}

// Совместимость: раньше пул брался из shadowNotes; теперь — из заметок с пометкой quote.
export function ceoPool() {
  return quotePool().map(n => { const body = String(n.body || '').trim(); const text = body && body.length <= 180 ? body : n.title; return { text, id: n.id, ceo: n.type === 'recommendation' }; }).filter(q => q.text);
}
export function hasCeoQuotes() { return ceoPool().length > 0; }

let rot = 0;
export function nextQuote() { rot++; }

function pick(seed) {
  if (!quotesOn()) return null;
  const pool = ceoPool();
  if (pool.length) { const q = pool[(hash(seed) + rot) % pool.length]; return { text: q.text, ceo: q.ceo, id: q.id }; }
  if (tone() !== 'support') return null;        // встроенные цитаты — только в поддерживающем режиме
  return { text: QUOTES[(hash(seed) + rot) % QUOTES.length], ceo: false };
}

export function dailyQuote(salt = '') { return pick(today() + '|' + salt); }
export function maybePageQuote(pageId) { return pick(today() + '#' + pageId); }

export function quoteHtml(q, esc) {
  if (!q) return '';
  return `<div class="champ-line" data-quote title="Нажмите, чтобы показать следующее">«${esc(q.text)}»${q.ceo ? ' <span class="champ-src">— CEO</span>' : ''}</div>`;
}

const rnd = (arr) => arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
export function cheer() { return rnd(CHEERS[tone()] || []); }
export function habitCheer() { return rnd(HABIT_CHEERS[tone()] || []); }
export function allDoneMessage(kind) {
  const t = tone();
  if (t === 'neutral') return kind === 'habits' ? 'Все привычки дня выполнены.' : 'Все задачи дня закрыты.';
  if (t === 'business') return kind === 'habits' ? 'Привычки дня: 100%.' : 'Задачи дня: 100%.';
  return kind === 'habits' ? 'Все привычки дня выполнены. Так выглядит чемпионский день.' : 'Все задачи дня закрыты. Чемпион — это ты.';
}
