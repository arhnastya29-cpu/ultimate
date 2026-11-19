// Интерактивные эффекты: анимация чисел и прогресса, тултипы, командная палитра,
// конфетти за закрытый день, переключатель темы.
import { db } from './db.js';
import { allDoneMessage } from './motivation.js';
import { habitStatus, isMine, tone, addTask, addNote, addWater } from './model.js';
import { openCapture } from './capture.js';
import { esc, icon, today, toast } from './ui.js';

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- Числа: плавный счётчик ----------
function countUp(el) {
  const node = [...el.childNodes].find(n => n.nodeType === 3 && /\d/.test(n.textContent));
  if (!node) return;
  const raw = node.textContent;
  const m = raw.match(/^(\s*[+\-−]?)([\d\s ]+(?:[.,]\d+)?)(.*)$/);
  if (!m) return;
  const [, pre, numStr, post] = m;
  const clean = numStr.replace(/[\s ]/g, '').replace(',', '.');
  const target = parseFloat(clean);
  if (!isFinite(target) || target === 0) return;
  const decimals = (clean.split('.')[1] || '').length;
  const useSep = /[\s ]/.test(numStr);
  const fmt = (v) => {
    let s = v.toFixed(decimals);
    if (useSep || Math.abs(target) >= 10000) s = Number(s).toLocaleString('ru-RU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    else if (decimals && numStr.includes(',')) s = s.replace('.', ',');
    return s;
  };
  const dur = 700, t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    node.textContent = pre + fmt(target * e) + post;
    if (p < 1) requestAnimationFrame(step); else node.textContent = raw;
  };
  requestAnimationFrame(step);
}

// ---------- Прогресс-бары и кольца ----------
function animateBars(root) {
  root.querySelectorAll('.bar > i').forEach(i => {
    const w = i.style.width; if (!w) return;
    i.style.transition = 'none'; i.style.width = '0%';
    void i.offsetWidth;
    i.style.transition = ''; i.style.width = w;
  });
  root.querySelectorAll('.ring circle:nth-child(2)').forEach(c => {
    const off = c.getAttribute('stroke-dashoffset'), dash = c.getAttribute('stroke-dasharray');
    if (off == null || dash == null) return;
    c.style.transition = 'none'; c.style.strokeDashoffset = dash;
    void c.getBoundingClientRect();
    c.style.transition = ''; c.style.strokeDashoffset = off;
  });
}

export function afterRender(root, { changed }) {
  if (reduced()) return;
  animateBars(root);
  if (changed) root.querySelectorAll('.stat .value, .big-num').forEach(countUp);
}

// ---------- Тултипы (data-tip) ----------
const tip = () => document.getElementById('tooltip');
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest?.('[data-tip]'); if (!t) return;
  const el = tip(); el.textContent = t.dataset.tip; el.classList.add('show');
  const r = t.getBoundingClientRect();
  el.style.left = (r.left + r.width / 2) + 'px';
  el.style.top = r.top + 'px';
});
document.addEventListener('mouseout', (e) => { if (e.target.closest?.('[data-tip]')) tip().classList.remove('show'); });
document.addEventListener('scroll', () => tip().classList.remove('show'), true);

// ---------- Конфетти ----------
export function confetti({ count = 140, origin } = {}) {
  if (reduced()) return;
  const cv = document.getElementById('confetti'); const ctx = cv.getContext('2d');
  cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio;
  cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  const colors = ['#8B7CFF', '#D08CFF', '#E2BC63', '#3CCB83', '#5FA3F7', '#F26A76', '#ffffff'];
  const ox = origin?.x ?? innerWidth / 2, oy = origin?.y ?? innerHeight * 0.35;
  const ps = Array.from({ length: count }, () => {
    const a = Math.random() * Math.PI * 2, v = 6 + Math.random() * 9;
    return { x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 6, g: 0.28 + Math.random() * 0.1, w: 5 + Math.random() * 6, h: 3 + Math.random() * 4, r: Math.random() * Math.PI, vr: (Math.random() - .5) * .3, c: colors[Math.floor(Math.random() * colors.length)], life: 90 + Math.random() * 50 };
  });
  let frame = 0;
  const draw = () => {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    let alive = false;
    for (const p of ps) {
      if (frame > p.life) continue; alive = true;
      p.vx *= 0.985; p.vy += p.g; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.globalAlpha = Math.max(0, 1 - (frame / p.life) ** 3);
      ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
    }
    frame++;
    if (alive) requestAnimationFrame(draw); else ctx.clearRect(0, 0, innerWidth, innerHeight);
  };
  requestAnimationFrame(draw);
}

// Празднуем, когда все задачи дня или все привычки дня закрыты.
let prevTasksDone = null, prevHabitsDone = null;
function dayState() {
  const d = today(), wd = (new Date().getDay() + 6) % 7;
  const tasks = db.all('tasks').filter(t => isMine(t) && (t.date === d || (t.done && (t.doneAt || '').slice(0, 10) === d)));
  const tasksAll = tasks.length > 0 && tasks.every(t => t.done);
  const habits = db.all('habits').filter(h => !h.archived && (!h.days?.length || h.days.includes(wd)));
  const habitsAll = habits.length > 0 && habits.every(h => habitStatus(h, d).done);
  return { tasksAll, habitsAll };
}
export function watchCelebrations() {
  const s = dayState(); prevTasksDone = s.tasksAll; prevHabitsDone = s.habitsAll;
  db.subscribe((col) => {
    if (!['tasks', 'habitLogs', 'habits', 'dayLogs', 'workouts', 'studySessions', 'sleepLogs'].includes(col)) return;
    if (tone() === 'neutral') { const n0 = dayState(); prevTasksDone = n0.tasksAll; prevHabitsDone = n0.habitsAll; return; }   // в нейтральном режиме без конфетти
    const n = dayState();
    if (n.tasksAll && !prevTasksDone) { confetti(); toast(allDoneMessage('tasks'), 3200); }
    if (n.habitsAll && !prevHabitsDone) { confetti({ count: 100 }); toast(allDoneMessage('habits'), 3200); }
    prevTasksDone = n.tasksAll; prevHabitsDone = n.habitsAll;
  });
}

// ---------- Командная палитра (⌘K) ----------
let cmdOpen = false;
export function openCommandPalette(pages, navigate) {
  if (cmdOpen) return; cmdOpen = true;
  const host = document.getElementById('modals');
  const wrap = document.createElement('div');
  wrap.className = 'cmdk-backdrop';
  wrap.innerHTML = `<div class="cmdk" role="dialog" aria-label="Команды">
    <input type="text" placeholder="Куда перейти или что записать…" autocomplete="off" spellcheck="false">
    <div class="list"></div>
    <div class="foot"><span><span class="kbd">↑↓</span> выбор</span><span><span class="kbd">↵</span> выполнить</span><span><span class="kbd">esc</span> закрыть</span></div>
  </div>`;
  const input = wrap.querySelector('input'), list = wrap.querySelector('.list');
  const close = () => { wrap.remove(); cmdOpen = false; document.removeEventListener('keydown', onKey); };
  let sel = 0, items = [];

  const baseActions = (q) => {
    const d = today();
    const acts = [];
    const text = q.trim();
    const num = parseInt(text.match(/\d+/)?.[0] || '', 10);
    if (text) {
      acts.push({ group: 'Быстрые действия', icon: 'plus', keys: ['записать', 'запись'], label: `Записать: «${text.slice(0, 40)}» (подобрать тип)`, run: () => openCapture({ text }) });
      acts.push({ group: 'Быстрые действия', icon: 'check', keys: ['задача', 'сделать', 'todo'], label: `Задача на сегодня: «${text}»`, run: () => { addTask({ title: text, date: d }); toast('Задача добавлена'); } });
      acts.push({ group: 'Быстрые действия', icon: 'pen', keys: ['заметка', 'мысль', 'идея'], label: `Заметка: «${text.slice(0, 40)}»`, run: () => { addNote({ title: text.slice(0, 80), body: text.length > 80 ? text : '' }); toast('Заметка сохранена'); } });
      if (num) {
        acts.push({ group: 'Быстрые действия', icon: 'droplet', keys: ['вода', 'воды', 'мл', 'выпил', 'выпила'], label: `Вода +${num} мл`, run: () => { addWater(num, d); toast(`+${num} мл воды`); } });
        acts.push({ group: 'Быстрые действия', icon: 'brain', keys: ['занятие', 'учил', 'учила', 'мин', 'обучение', 'урок'], label: `Занятие ${num} мин (первая область)`, run: () => { const a = db.all('learningAreas')[0]; if (!a) return toast('Сначала создайте область обучения'); db.add('studySessions', { areaId: a.id, date: d, minutes: num, notes: text.replace(/\d+/, '').trim() }); toast('Занятие записано'); } });
      }
    }
    if (!text) acts.push({ group: 'Быстрые действия', icon: 'plus', label: 'Записать… (задача, событие, заметка, расход)', run: () => openCapture({}) });
    for (const p of pages) acts.push({ group: 'Перейти', icon: p.icon, label: p.title, k: p.group, run: () => navigate(p.id) });
    acts.push({ group: 'Перейти', icon: 'zap', label: 'Помощник Claude', run: () => import('./ai-panel.js').then(m => m.openPanel()) });
    acts.push({ group: 'Тема', icon: 'sun', label: 'Светлая тема', run: () => db.setSettings({ theme: 'light' }) });
    acts.push({ group: 'Тема', icon: 'moon', label: 'Тёмная тема', run: () => db.setSettings({ theme: 'dark' }) });
    acts.push({ group: 'Тема', icon: 'settings', label: 'Тема как в системе', run: () => db.setSettings({ theme: 'auto' }) });
    acts.push({ group: 'Данные', icon: 'download', label: 'Экспорт резервной копии', run: () => navigate('settings') });
    return acts;
  };
  const match = (a, q) => !q || a.group === 'Быстрые действия' || a.label.toLowerCase().includes(q.toLowerCase());
  const renderList = () => {
    const q = input.value;
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const score = (a) => (a.keys || []).some(k => words.some(w => w.startsWith(k) || k.startsWith(w))) ? 1 : 0;
    items = baseActions(q).filter(a => match(a, q));
    if (words.length) items = items.map((a, i) => [a, i]).sort((x, y) => score(y[0]) - score(x[0]) || x[1] - y[1]).map(x => x[0]);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    let html = '', lastG = null;
    items.forEach((a, i) => {
      if (a.group !== lastG) { html += `<div class="grp">${esc(a.group)}</div>`; lastG = a.group; }
      html += `<div class="item ${i === sel ? 'sel' : ''}" data-i="${i}">${icon(a.icon)}<span>${esc(a.label)}</span>${a.k ? `<span class="k">${esc(a.k)}</span>` : ''}</div>`;
    });
    list.innerHTML = html || '<div class="empty">Ничего не найдено</div>';
    list.querySelector('.item.sel')?.scrollIntoView({ block: 'nearest' });
  };
  const run = (i) => { const a = items[i]; if (!a) return; close(); a.run(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % items.length; renderList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; renderList(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
  };
  document.addEventListener('keydown', onKey);
  input.addEventListener('input', () => { sel = 0; renderList(); });
  list.addEventListener('click', (e) => { const it = e.target.closest('.item'); if (it) run(Number(it.dataset.i)); });
  list.addEventListener('mousemove', (e) => { const it = e.target.closest('.item'); if (it && Number(it.dataset.i) !== sel) { sel = Number(it.dataset.i); renderList(); } });
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  host.appendChild(wrap);
  renderList();
  input.focus();
}
