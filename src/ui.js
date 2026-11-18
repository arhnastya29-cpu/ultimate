// Общие UI-помощники. Страницы рендерятся как HTML-строки + навешивание событий.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Создать DOM-элемент из HTML-строки (первый узел).
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ---------- Даты ----------
const pad = (n) => String(n).padStart(2, '0');
export function iso(d = new Date()) {
  if (typeof d === 'string') return d.slice(0, 10);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export const today = () => iso(new Date());
export function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
export function addDays(dateOrIso, n) {
  const d = typeof dateOrIso === 'string' ? parseISO(dateOrIso) : new Date(dateOrIso);
  d.setDate(d.getDate() + n);
  return typeof dateOrIso === 'string' ? iso(d) : d;
}
export function daysBetween(aIso, bIso) { return Math.round((parseISO(bIso) - parseISO(aIso)) / 86400000); }
export function startOfWeek(dateIso = today()) {
  const d = parseISO(dateIso);
  const dow = (d.getDay() + 6) % 7; // Пн = 0
  d.setDate(d.getDate() - dow);
  return iso(d);
}
export function weekDays(dateIso = today()) {
  const s = startOfWeek(dateIso);
  return Array.from({ length: 7 }, (_, i) => addDays(s, i));
}
export function monthKey(dateIso = today()) { return dateIso.slice(0, 7); }
export function lastNDays(n, end = today()) {
  return Array.from({ length: n }, (_, i) => addDays(end, i - n + 1));
}
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_FULL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const WD = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const WD_FULL = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
export function fmtDate(dateIso, opts = {}) {
  if (!dateIso) return '';
  const d = parseISO(dateIso);
  const t = today();
  if (opts.relative !== false) {
    if (dateIso === t) return 'Сегодня';
    if (dateIso === addDays(t, -1)) return 'Вчера';
    if (dateIso === addDays(t, 1)) return 'Завтра';
  }
  const s = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const year = d.getFullYear() !== new Date().getFullYear() || opts.year ? ` ${d.getFullYear()}` : '';
  return opts.weekday ? `${WD[(d.getDay() + 6) % 7]}, ${s}${year}` : s + year;
}
export function fmtDateLong(dateIso) {
  const d = parseISO(dateIso);
  return `${WD_FULL[(d.getDay() + 6) % 7]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
export function fmtMonth(key) { const [y, m] = key.split('-').map(Number); return `${MONTHS_FULL[m - 1]} ${y}`; }
export const weekdayShort = (dateIso) => WD[(parseISO(dateIso).getDay() + 6) % 7];
export function fmtMinutes(min) {
  min = Math.round(min || 0);
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}
export const fmtNum = (n, digits = 0) => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
export const fmtMoney = (n, cur = '₽') => `${fmtNum(n, 0)} ${cur}`;
export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const sum = (arr, f = (x) => x) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);
export const avg = (arr, f) => arr.length ? sum(arr, f) / arr.length : 0;
export const groupBy = (arr, keyFn) => arr.reduce((m, x) => { const k = keyFn(x); (m[k] ||= []).push(x); return m; }, {});
export const sortBy = (arr, f, desc = false) => [...arr].sort((a, b) => { const x = f(a), y = f(b); return (x < y ? -1 : x > y ? 1 : 0) * (desc ? -1 : 1); });

// ---------- Иконки (Lucide-подобные, stroke) ----------
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15Z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  heart: '<path d="M19 14c1.5-1.4 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .9-4.5 2.5C10.5 3.9 9.3 3 7.5 3A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.1 3 5.5l7 7Z"/>',
  dumbbell: '<path d="M6.5 6.5h11M6.5 17.5h11M3 10v4M21 10v4M6.5 4v16M17.5 4v16"/>',
  utensils: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  library: '<path d="m16 6 4 14M12 6v14M8 8v12M4 4v16"/>',
  wallet: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>',
  pen: '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.2-.2-4.1 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.2-2.4 1-3.5.3 1 1.5 3 2.5 3Z"/>',
  droplet: '<path d="M12 2.7 6.3 8.4a8 8 0 1 0 11.3 0L12 2.7Z"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>',
  star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1L12 2Z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  brain: '<path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-1.04Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-1.04Z"/>',
  play: '<path d="m6 3 14 9-14 9V3Z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  flask: '<path d="M10 2v7.5L4.5 19a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 9.5V2M8.5 2h7M7 15h10"/>',
  pill: '<path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"/><path d="m8.5 8.5 7 7"/>',
  smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7l10-5Z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  trending: '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
};
export function icon(name, cls = '') {
  const d = ICONS[name] || ICONS.info;
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

// ---------- Элементы ----------
export function progressBar(value, max = 100, cls = '') {
  const pct = max > 0 ? clamp((value / max) * 100, 0, 100) : 0;
  return `<div class="bar ${cls}"><i style="width:${pct.toFixed(1)}%"></i></div>`;
}
export function emptyState(text, emoji = '✨') {
  return `<div class="empty"><div class="big">${emoji}</div>${esc(text)}</div>`;
}
export function checkBtn(on, extra = '') {
  return `<button type="button" class="check ${on ? 'on' : ''}" ${extra} aria-pressed="${on ? 'true' : 'false'}">${icon('check')}</button>`;
}
export function ring(pct, { size = 96, stroke = 10, color = 'var(--accent)', label = '', sub = '' } = {}) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const p = clamp(pct, 0, 100);
  return `<svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p / 100)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" style="font: 800 ${size / 4.5}px var(--font-num); letter-spacing: -0.03em; fill: var(--fg)">${esc(label)}</text>
    ${sub ? `<text x="50%" y="${size / 2 + size / 5}" text-anchor="middle" style="font: 500 ${size / 9}px var(--font-body); fill: var(--fg-2)">${esc(sub)}</text>` : ''}
  </svg>`;
}

// Простая столбчатая диаграмма. data: [{label, value, color?}], target — горизонтальная линия.
export function barChart(data, { height = 120, target = null, max = null, showValues = false, color = 'var(--accent)' } = {}) {
  const w = 600, padL = 6, padR = 6, padT = 12, padB = 20;
  const n = data.length || 1;
  const m = max || Math.max(1, ...data.map(d => d.value || 0), target || 0) * 1.1;
  const bw = (w - padL - padR) / n;
  const bars = data.map((d, i) => {
    const h = Math.max(d.value ? 2 : 0, ((d.value || 0) / m) * (height - padT - padB));
    const x = padL + i * bw + bw * 0.15, y = height - padB - h;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${d.color || color}" data-tip="${esc(d.tip ?? `${d.label}: ${d.valueLabel ?? Math.round(d.value || 0)}`)}"/>
      ${showValues && d.value ? `<text x="${(x + bw * 0.35).toFixed(1)}" y="${(y - 3).toFixed(1)}" text-anchor="middle">${esc(d.valueLabel ?? Math.round(d.value))}</text>` : ''}
      <text x="${(x + bw * 0.35).toFixed(1)}" y="${height - 5}" text-anchor="middle">${esc(d.label)}</text>`;
  }).join('');
  const tl = target ? (() => { const y = height - padB - (target / m) * (height - padT - padB); return `<line x1="${padL}" x2="${w - padR}" y1="${y}" y2="${y}" stroke="var(--fg-3)" stroke-dasharray="4 4"/>`; })() : '';
  return `<svg class="chart" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none" style="height:${height}px">${tl}${bars}</svg>`;
}

// Линейный график. series: [{points:[{x:idx,y}], color}], labels по x.
export function lineChart(series, labels, { height = 140, min = null, max = null, target = null } = {}) {
  const w = 600, padL = 8, padR = 8, padT = 10, padB = 20;
  const ys = series.flatMap(s => s.points.map(p => p.y)).filter(v => v != null);
  const lo = min ?? Math.min(...ys, target ?? Infinity), hi = max ?? Math.max(...ys, target ?? -Infinity);
  const range = hi - lo || 1;
  const n = Math.max(labels.length, 2);
  const X = (i) => padL + (i / (n - 1)) * (w - padL - padR);
  const Y = (v) => height - padB - ((v - lo) / range) * (height - padT - padB);
  const paths = series.map(s => {
    const pts = s.points.filter(p => p.y != null);
    if (!pts.length) return '';
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
    const dots = pts.map(p => `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="3.5" fill="${s.color || 'var(--accent)'}" stroke="var(--surface)" stroke-width="1.5" data-tip="${esc(p.tip ?? `${labels[p.x] ?? ''}${s.name ? ' · ' + s.name : ''}: ${Number.isInteger(p.y) ? p.y : p.y.toFixed(1)}`)}"/>`).join('');
    return `<path d="${d}" fill="none" stroke="${s.color || 'var(--accent)'}" stroke-width="2" stroke-linejoin="round"/>${dots}`;
  }).join('');
  const step = Math.ceil(labels.length / 8);
  const lbl = labels.map((l, i) => i % step === 0 ? `<text x="${X(i).toFixed(1)}" y="${height - 5}" text-anchor="middle">${esc(l)}</text>` : '').join('');
  const tl = target != null ? `<line x1="${padL}" x2="${w - padR}" y1="${Y(target)}" y2="${Y(target)}" stroke="var(--fg-3)" stroke-dasharray="4 4"/>` : '';
  return `<svg class="chart" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none" style="height:${height}px">${tl}${paths}${lbl}</svg>`;
}

// ---------- Формы ----------
// field({name, label, type, value, options, placeholder, required, min, max, step, hint, rows})
export function field(f) {
  const id = `f_${f.name}_${Math.random().toString(36).slice(2, 6)}`;
  const req = f.required ? 'required' : '';
  const attrs = `id="${id}" name="${esc(f.name)}" ${req} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} ${f.type === 'number' ? 'step="any"' : f.step != null ? `step="${f.step}"` : ''} ${f.autofocus ? 'autofocus' : ''}`;
  let input;
  if (f.type === 'select') {
    input = `<select ${attrs}>${(f.options || []).map(o => {
      const [v, l] = Array.isArray(o) ? o : [o.value ?? o, o.label ?? o];
      return `<option value="${esc(v)}" ${String(v) === String(f.value ?? '') ? 'selected' : ''}>${esc(l)}</option>`;
    }).join('')}</select>`;
  } else if (f.type === 'textarea') {
    input = `<textarea ${attrs} ${f.rows ? `rows="${f.rows}"` : ''}>${esc(f.value ?? '')}</textarea>`;
  } else if (f.type === 'checkbox') {
    return `<label class="row" style="gap:8px;font-size:14px"><input type="checkbox" name="${esc(f.name)}" ${f.value ? 'checked' : ''}> ${esc(f.label)}</label>`;
  } else if (f.type === 'rating') {
    const n = f.max || 5;
    return `<div class="field"><label>${esc(f.label)}</label><div class="rating" data-rating="${esc(f.name)}">
      <input type="hidden" name="${esc(f.name)}" value="${esc(f.value ?? '')}">
      ${Array.from({ length: n }, (_, i) => `<button type="button" data-v="${i + 1}" class="${Number(f.value) === i + 1 ? 'active' : ''}">${f.labels?.[i] ?? i + 1}</button>`).join('')}
    </div>${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
  } else {
    input = `<input type="${f.type || 'text'}" ${attrs} value="${esc(f.value ?? '')}" ${f.list ? `list="${f.list}"` : ''} ${f.inputmode ? `inputmode="${f.inputmode}"` : ''}>`;
  }
  return `<div class="field"><label for="${id}">${esc(f.label)}</label>${input}${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
}
export const formRow = (...fields) => `<div class="form-row">${fields.join('')}</div>`;

// Считать значения формы в объект. Числовые поля (type=number) приводятся к Number.
export function formData(form) {
  const out = {};
  const fd = new FormData(form);
  for (const [k, v] of fd.entries()) {
    const input = form.querySelector(`[name="${CSS.escape(k)}"]`);
    if (input && input.type === 'checkbox') out[k] = true;
    else if (input && input.type === 'number') out[k] = v === '' ? null : Number(v);
    else if (input && input.closest('.rating')) out[k] = v === '' ? null : Number(v);
    else out[k] = typeof v === 'string' ? v.trim() : v;
  }
  for (const cb of form.querySelectorAll('input[type=checkbox]')) if (!(cb.name in out)) out[cb.name] = false;
  return out;
}

function wireRatings(root) {
  root.querySelectorAll('.rating').forEach(r => {
    r.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      const hidden = r.querySelector('input[type=hidden]');
      const v = b.dataset.v;
      if (hidden.value === v) { hidden.value = ''; r.querySelectorAll('button').forEach(x => x.classList.remove('active')); return; }
      hidden.value = v;
      r.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    });
  });
}

// ---------- Модалки ----------
// modal({ title, body (html), submitText, onSubmit(data, formEl) -> false чтобы не закрывать, onDelete, wide, onOpen(modalEl) })
export function modal({ title, body, submitText = 'Сохранить', cancelText = 'Отмена', onSubmit, onDelete, deleteText = 'Удалить', wide = false, onOpen, noForm = false }) {
  const host = document.getElementById('modals');
  const wrap = el(`<div class="modal-backdrop">
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn sm" data-close aria-label="Закрыть">${icon('x')}</button></div>
      <${noForm ? 'div' : 'form'} class="modal-form" novalidate>
        <div class="modal-body">${body}</div>
        <div class="modal-foot">
          ${onDelete ? `<button type="button" class="btn danger left" data-delete>${esc(deleteText)}</button>` : ''}
          <button type="button" class="btn secondary" data-close>${esc(cancelText)}</button>
          ${onSubmit ? `<button type="submit" class="btn" data-submit>${esc(submitText)}</button>` : ''}
        </div>
      </${noForm ? 'div' : 'form'}>
    </div></div>`);
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
  const form = wrap.querySelector('.modal-form');
  if (!noForm) form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const data = formData(form);
    const r = onSubmit?.(data, form);
    if (r !== false) close();
  });
  if (onDelete) wrap.querySelector('[data-delete]').addEventListener('click', () => { if (confirm('Удалить? Это действие нельзя отменить.')) { onDelete(); close(); } });
  wireRatings(wrap);
  host.appendChild(wrap);
  const first = wrap.querySelector('input:not([type=hidden]), select, textarea');
  if (first && !wide) setTimeout(() => first.focus(), 30);
  onOpen?.(wrap, close);
  return { el: wrap, close };
}

export function confirmDialog(text, { okText = 'Да', danger = true } = {}) {
  return new Promise((resolve) => {
    const m = modal({
      title: 'Подтверждение', body: `<p>${esc(text)}</p>`, submitText: okText,
      onSubmit: () => { resolve(true); },
    });
    m.el.querySelector('[data-submit]').classList.toggle('danger', danger);
    const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { obs.disconnect(); resolve(false); } });
    obs.observe(document.getElementById('modals'), { childList: true });
  });
}

export function toast(text, ms = 2200) {
  const t = el(`<div class="toast">${esc(text)}</div>`);
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// Делегирование событий: on(root, 'click', '[data-x]', (e, target) => ...)
export function on(root, event, selector, handler) {
  root.addEventListener(event, (e) => {
    const t = e.target.closest(selector);
    if (t && root.contains(t)) handler(e, t);
  });
}

// Навигация по датам: возвращает HTML с кнопками и подписью.
export function dateNav(dateIso, { prefix = 'dn' } = {}) {
  return `<div class="row" style="gap:6px">
    <button class="icon-btn sm" data-${prefix}="prev" aria-label="Назад">${icon('chevronLeft')}</button>
    <button class="chip ${dateIso === today() ? 'active' : ''}" data-${prefix}="today">${esc(fmtDate(dateIso, { weekday: true }))}</button>
    <button class="icon-btn sm" data-${prefix}="next" aria-label="Вперёд">${icon('chevronRight')}</button>
    <input type="date" class="input" style="width:auto;padding:5px 8px;font-size:13px" value="${dateIso}" data-${prefix}="pick">
  </div>`;
}
