// Панель «Помощник»: плавающая кнопка, выезжающая панель с чатом, быстрые вопросы по разделу,
// голосовой ввод. Ответы приходят потоком; действия помощника показываются отдельной строкой.
import { esc, icon, el, toast } from './ui.js';
import { ask, aiReady, chatHistory, clearChat, quickPrompts, aiConfig, aiProvider, aiLabel } from './ai.js';
import { db } from './db.js';

let panel = null;
let currentPage = 'today';
let busy = false;
let abort = null;

export function setAiPage(id) { currentPage = id; if (panel) renderPrompts(); }

// Простейший markdown: абзацы, списки, жирный, заголовки
function md(text) {
  const lines = esc(text).split('\n');
  let out = '', list = null;
  const flush = () => { if (list) { out += `<${list.tag}>${list.items.map(i => `<li>${i}</li>`).join('')}</${list.tag}>`; list = null; } };
  for (let raw of lines) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    let m;
    if ((m = line.match(/^\s*[-•*]\s+(.*)$/))) { if (!list || list.tag !== 'ul') { flush(); list = { tag: 'ul', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { if (!list || list.tag !== 'ol') { flush(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); continue; }
    flush();
    if ((m = line.match(/^#{1,4}\s+(.*)$/))) { out += `<p class="ai-h">${m[1]}</p>`; continue; }
    if (line.trim()) out += `<p>${line}</p>`;
  }
  flush();
  return out;
}

function ensurePanel() {
  if (panel) return panel;
  panel = el(`<div class="ai-wrap" hidden>
    <div class="ai-backdrop" data-ai-close></div>
    <aside class="ai-panel" role="dialog" aria-label="Помощник">
      <div class="ai-head">
        <div class="row" style="gap:8px"><span class="ai-spark">${icon('zap')}</span><b>Помощник</b><span class="tag ai-model"></span></div>
        <div class="row" style="gap:4px">
          <button type="button" class="icon-btn sm" data-ai-clear aria-label="Очистить чат" data-tip="Очистить чат">${icon('trash')}</button>
          <button type="button" class="icon-btn sm" data-ai-close aria-label="Закрыть">${icon('x')}</button>
        </div>
      </div>
      <div class="ai-messages"></div>
      <div class="ai-prompts"></div>
      <form class="ai-form">
        <textarea class="ai-input" rows="1" placeholder="Спросите или скажите, что записать…"></textarea>
        <button type="button" class="icon-btn ai-mic" aria-label="Голосовой ввод" data-tip="Надиктовать">${icon('play')}</button>
        <button type="submit" class="icon-btn primary ai-send" aria-label="Отправить">${icon('arrowUp')}</button>
      </form>
    </aside>
  </div>`);
  document.body.appendChild(panel);
  panel.addEventListener('click', (e) => {
    if (e.target.closest('[data-ai-close]')) closePanel();
    if (e.target.closest('[data-ai-clear]')) { if (confirm('Очистить историю чата?')) { clearChat(); renderMessages(); } }
    const q = e.target.closest('[data-ai-q]'); if (q) send(q.dataset.aiQ);
  });
  const form = panel.querySelector('.ai-form');
  const input = panel.querySelector('.ai-input');
  form.addEventListener('submit', (e) => { e.preventDefault(); const v = input.value.trim(); if (v) { input.value = ''; autosize(input); send(v); } });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  input.addEventListener('input', () => autosize(input));
  setupMic(panel.querySelector('.ai-mic'), input);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) closePanel(); });
  return panel;
}

function autosize(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; }

function renderPrompts() {
  const box = panel.querySelector('.ai-prompts');
  const ready = aiReady();
  box.innerHTML = ready
    ? quickPrompts(currentPage).map(q => `<button type="button" class="chip" data-ai-q="${esc(q)}">${esc(q)}</button>`).join('')
    : (aiProvider() === 'ollama'
      ? `<div class="ai-setup">Локальная модель сейчас недоступна: она работает на Mac, где установлена Ollama. Проверьте, что Ollama запущена, или переключитесь на Claude в <a href="#/settings" data-ai-close>Настройках</a>.</div>`
      : `<div class="ai-setup">Чтобы помощник заработал, вставьте ключ Claude в <a href="#/settings" data-ai-close>Настройках</a>. Он хранится только на этом устройстве.</div>`);
  panel.querySelector('.ai-model').textContent = aiLabel();
  panel.querySelector('.ai-form').style.display = ready ? '' : 'none';
}

function renderMessages() {
  const box = panel.querySelector('.ai-messages');
  const h = chatHistory();
  box.innerHTML = h.length ? h.map(m => bubble(m)).join('') : `<div class="ai-empty">${icon('zap')}<div>Я вижу ваши задачи, цели, проекты, привычки, дневник и показатели тела. Спрашивайте совета или скажите, что записать: «добавь задачу на завтра: созвон с Леной».</div></div>`;
  box.scrollTop = box.scrollHeight;
}

function bubble(m) {
  if (m.role === 'user') return `<div class="ai-msg user"><div class="ai-bubble">${esc(m.text)}</div></div>`;
  return `<div class="ai-msg assistant"><div class="ai-bubble">${md(m.text || '…')}</div>${(m.actions || []).map(a => `<div class="ai-action">${icon('check')} ${esc(a.result)}</div>`).join('')}</div>`;
}

async function send(text) {
  if (busy) { abort?.abort(); busy = false; }
  if (!aiReady()) { toast(aiProvider() === 'ollama' ? 'Локальная модель недоступна на этом устройстве' : 'Сначала вставьте ключ Claude в Настройках'); return; }
  const box = panel.querySelector('.ai-messages');
  if (!chatHistory().length) box.innerHTML = '';
  box.insertAdjacentHTML('beforeend', bubble({ role: 'user', text }));
  const live = el(`<div class="ai-msg assistant"><div class="ai-bubble ai-typing">…</div></div>`);
  box.appendChild(live); box.scrollTop = box.scrollHeight;
  const bub = live.querySelector('.ai-bubble');
  let acc = '';
  busy = true; abort = new AbortController();
  panel.querySelector('.ai-send').disabled = true;
  try {
    const r = await ask(text, {
      pageId: currentPage,
      signal: abort.signal,
      onText: (tx) => { acc += tx; bub.classList.remove('ai-typing'); bub.innerHTML = md(acc); box.scrollTop = box.scrollHeight; },
      onAction: (res) => { live.insertAdjacentHTML('beforeend', `<div class="ai-action">${icon('check')} ${esc(res)}</div>`); box.scrollTop = box.scrollHeight; },
    });
    if (!acc && r.text) bub.innerHTML = md(r.text);
    if (!acc && !r.text) bub.innerHTML = '<span class="muted">Готово.</span>';
    bub.classList.remove('ai-typing');
  } catch (e) {
    if (e.name === 'AbortError') { bub.innerHTML = '<span class="muted">Остановлено.</span>'; }
    else bub.innerHTML = `<span class="bad">${esc(e.message || String(e))}</span>`;
    bub.classList.remove('ai-typing');
  } finally {
    busy = false; abort = null;
    panel.querySelector('.ai-send').disabled = false;
    box.scrollTop = box.scrollHeight;
  }
}

function setupMic(btn, input) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { btn.style.display = 'none'; return; }
  let rec = null;
  btn.addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    rec = new SR(); rec.lang = 'ru-RU'; rec.interimResults = true; rec.continuous = false;
    const base = input.value ? input.value.replace(/\s+$/, '') + ' ' : '';
    btn.classList.add('rec');
    rec.onresult = (e) => { let s = ''; for (const r of e.results) s += r[0].transcript; input.value = base + s; autosize(input); };
    rec.onerror = () => { toast('Микрофон недоступен'); };
    rec.onend = () => { btn.classList.remove('rec'); rec = null; input.focus(); };
    try { rec.start(); } catch { btn.classList.remove('rec'); rec = null; }
  });
}

export function openPanel(prefill = '') {
  ensurePanel();
  renderPrompts(); renderMessages();
  panel.hidden = false;
  requestAnimationFrame(() => panel.classList.add('open'));
  const input = panel.querySelector('.ai-input');
  if (prefill) { input.value = prefill; autosize(input); }
  if (aiReady() && window.innerWidth > 860) setTimeout(() => input.focus(), 50);
}
export function closePanel() {
  if (!panel) return;
  panel.classList.remove('open');
  setTimeout(() => { panel.hidden = true; }, 220);
}
export function togglePanel() { if (!panel || panel.hidden) openPanel(); else closePanel(); }

// Плавающая кнопка показывается только когда ключ настроен и кнопка не отключена в настройках.
// Без ключа помощник доступен из палитры ⌘K / ⌘J и из настроек, но не занимает место на экране.
let fab = null;
export function refreshFab() {
  const want = aiReady() && db.settings().aiFab !== false;
  if (want && !fab) {
    fab = el(`<button type="button" class="ai-fab" aria-label="Помощник Claude" title="Помощник (⌘J)">${icon('zap')}</button>`);
    fab.addEventListener('click', () => togglePanel());
    document.body.appendChild(fab);
  } else if (!want && fab) { fab.remove(); fab = null; }
}
export function initAiPanel() {
  refreshFab();
  db.subscribe((col) => { if (col === 'settings' || col === '*') refreshFab(); });
  window.addEventListener('storage', refreshFab);
  window.addEventListener('ultimate:ai', refreshFab);
  document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'j') { e.preventDefault(); togglePanel(); } });
}
