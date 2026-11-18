import { db, DEFAULT_SETTINGS, COLLECTIONS } from '../db.js';
import { esc, icon, field, formRow, formData, toast, on, fmtNum, modal, fmtDate } from '../ui.js';
import { canInstall, promptInstall, isStandalone, onInstallChange } from '../pwa.js';
import { status as syncStatus, onChange as onSyncChange, enable as syncEnable, disable as syncDisable, syncNow } from '../sync.js';

export const title = 'Настройки';


function installBlock() {
  if (isStandalone()) return `<p class="muted small">ULTIMATE открыт как установленное приложение и работает офлайн. Данные по-прежнему хранятся на этом устройстве.</p>`;
  if (canInstall()) return `<p class="muted small" style="margin-bottom:10px">Поставьте ULTIMATE на экран как обычное приложение: откроется без адресной строки и будет работать без интернета.</p><button class="btn" data-install>${icon('download')} Установить</button>`;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  return ios
    ? `<p class="muted small">На iPhone: нажмите кнопку «Поделиться» в Safari, затем «На экран Домой». Иконка ULTIMATE появится рядом с другими приложениями.</p>`
    : `<p class="muted small">В Chrome или Edge: иконка установки в адресной строке, либо меню браузера → «Установить ULTIMATE». В Safari на Mac: Файл → «Добавить в Dock».</p>`;
}

function fmtWhen(isoStr) {
  if (!isoStr) return 'ещё не было';
  const d = new Date(isoStr); const diff = Date.now() - d.getTime();
  if (diff < 60000) return 'только что';
  if (diff < 3600000) return `${Math.round(diff / 60000)} мин назад`;
  return `${fmtDate(isoStr.slice(0, 10))} в ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function syncBlock() {
  const st = syncStatus();
  if (!st.enabled) {
    return `<p class="muted small" style="margin-bottom:12px">Чтобы записи были одинаковыми на телефоне и компьютере, включите синхронизацию и задайте пароль. Данные шифруются этим паролем ещё на устройстве, в облаке лежит только нечитаемый набор символов.</p>
      <button class="btn" data-sync-enable>${icon('upload')} Включить синхронизацию</button>`;
  }
  return `<div class="stack tight" style="margin-bottom:12px">
      <div class="row" style="gap:8px"><span class="pill ${st.lastError ? 'bad' : 'good'}">${st.busy ? 'синхронизация…' : st.lastError ? 'ошибка' : 'включена'}</span><span class="small muted">последняя: ${esc(fmtWhen(st.lastSync))}</span></div>
      ${st.lastError ? `<div class="small bad">${esc(st.lastError)}</div>` : ''}
      <p class="muted tiny">На другом устройстве откройте этот же раздел и введите тот же пароль. Синхронизация идёт автоматически после каждого изменения и при открытии приложения.</p>
    </div>
    <div class="row wrap">
      <button class="btn secondary" data-sync-now ${st.busy ? 'disabled' : ''}>${icon('repeat')} Синхронизировать сейчас</button>
      <button class="btn ghost" data-sync-disable>Выключить</button>
    </div>`;
}

function openSyncModal() {
  modal({
    title: 'Пароль синхронизации',
    submitText: 'Включить',
    body: `<div class="form">
      <p class="small muted">Придумайте пароль. Его нужно будет ввести один раз на каждом устройстве. Если забыть пароль, облачную копию прочитать будет нельзя, поэтому запишите его в надёжном месте.</p>
      ${field({ name: 'password', label: 'Пароль', type: 'password', required: true, placeholder: 'не короче 8 символов', autofocus: true })}
      ${field({ name: 'password2', label: 'Ещё раз', type: 'password', required: true, placeholder: 'повторите пароль' })}
      <div class="tiny faint" data-sync-progress></div>
    </div>`,
    onSubmit: (d, form) => {
      if (d.password.length < 8) { alert('Пароль должен быть не короче 8 символов'); return false; }
      if (d.password !== d.password2) { alert('Пароли не совпадают'); return false; }
      const btn = form.querySelector('[data-submit]'); const prog = form.querySelector('[data-sync-progress]');
      btn.disabled = true; prog.textContent = 'Готовим ключ и подключаемся к облаку…';
      syncEnable(d.password).then((r) => {
        form.closest('.modal-backdrop')?.remove();
        const localCount = COLLECTIONS.reduce((n, c) => n + db.all(c).length, 0);
        if (r?.created && localCount < 3) {
          alert('В облаке пока нет данных с таким паролем — создано новое хранилище. Если вы уже включали синхронизацию на другом устройстве, скорее всего пароль введён иначе: выключите синхронизацию и попробуйте ещё раз.');
        } else if (r?.created) {
          toast('Синхронизация включена, данные отправлены в облако');
        } else {
          toast(r?.changedLocal ? 'Синхронизация включена, данные объединены' : 'Синхронизация включена');
        }
      }).catch((e) => {
        btn.disabled = false; prog.textContent = '';
        alert(e.message || String(e));
      });
      return false;
    },
  });
}

export async function render(root) {
  const s = db.settings();
  const counts = COLLECTIONS.map(c => db.all(c).length).reduce((a, b) => a + b, 0);
  root.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Ресурсы</div><h1>Настройки</h1></div></div>
    <div class="grid-2" style="align-items:start">
      <form class="card form" id="sform">
        <h3>Профиль и нормы</h3>
        ${field({ name: 'name', label: 'Имя', value: s.name, placeholder: 'Как к вам обращаться' })}
        ${field({ name: 'theme', label: 'Тема', type: 'select', value: s.theme, options: [['auto', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']] })}
        <div class="divider"></div>
        <div class="label caps">Питание (в день)</div>
        ${formRow(
          field({ name: 'kcalTarget', label: 'Калории', type: 'number', value: s.kcalTarget, min: 800, step: 10 }),
          field({ name: 'proteinTarget', label: 'Белок, г', type: 'number', value: s.proteinTarget, min: 0 }),
          field({ name: 'fatTarget', label: 'Жиры, г', type: 'number', value: s.fatTarget, min: 0 }),
          field({ name: 'carbsTarget', label: 'Углеводы, г', type: 'number', value: s.carbsTarget, min: 0 }),
        )}
        ${formRow(
          field({ name: 'waterTarget', label: 'Вода, мл', type: 'number', value: s.waterTarget, min: 0, step: 100 }),
          field({ name: 'stepsTarget', label: 'Шаги', type: 'number', value: s.stepsTarget, min: 0, step: 500 }),
        )}
        <div class="divider"></div>
        ${formRow(
          field({ name: 'sleepTarget', label: 'Сон, часов', type: 'number', value: s.sleepTarget, min: 4, max: 12, step: 0.5 }),
          field({ name: 'learningWeeklyMinutes', label: 'Обучение, мин/неделю', type: 'number', value: s.learningWeeklyMinutes, min: 0, step: 15 }),
          field({ name: 'currency', label: 'Валюта', value: s.currency }),
        )}
        <button class="btn" type="submit">${icon('check')} Сохранить</button>
      </form>
      <div class="stack">
        <div class="card">
          <h3>Данные</h3>
          <p class="muted small" style="margin-bottom:12px">Всё хранится локально в этом браузере (IndexedDB). Записей: <b>${fmtNum(counts)}</b>. Делайте резервную копию раз в неделю — файл можно импортировать на другом устройстве.</p>
          <div class="row wrap">
            <button class="btn secondary" data-export>${icon('download')} Экспорт JSON</button>
            <button class="btn secondary" data-import>${icon('upload')} Импорт JSON</button>
            <input type="file" accept="application/json,.json" hidden id="importFile">
          </div>
          <label class="row tiny muted" style="margin-top:10px;gap:6px"><input type="checkbox" id="mergeImport"> При импорте объединять с текущими данными, а не заменять</label>
        </div>
        <div class="card" id="syncCard">
          <h3>Синхронизация между устройствами</h3>
          ${syncBlock()}
        </div>
        <div class="card" id="installCard">
          <h3>Приложение на телефоне</h3>
          ${installBlock()}
        </div>
        <div class="card">
          <h3>Горячие клавиши</h3>
          <div class="small muted stack tight">
            <div><span class="kbd">g</span> затем <span class="kbd">t</span> — Сегодня, <span class="kbd">g</span> <span class="kbd">g</span> — Цели, <span class="kbd">g</span> <span class="kbd">h</span> — Привычки</div>
            <div><span class="kbd">g</span> <span class="kbd">l</span> — Обучение, <span class="kbd">g</span> <span class="kbd">n</span> — Питание, <span class="kbd">g</span> <span class="kbd">w</span> — Тренировки, <span class="kbd">g</span> <span class="kbd">s</span> — Сон</div>
            <div><span class="kbd">Esc</span> — закрыть окно</div>
          </div>
        </div>
        <div class="card">
          <h3 class="bad">Опасная зона</h3>
          <p class="muted small" style="margin-bottom:10px">Удалить все данные приложения без возможности восстановления.</p>
          <button class="btn danger" data-wipe>${icon('trash')} Стереть всё</button>
        </div>
      </div>
    </div>`;

  root.querySelector('#sform').addEventListener('submit', (e) => {
    e.preventDefault();
    const d = formData(e.target);
    for (const k of Object.keys(d)) if (d[k] == null && typeof DEFAULT_SETTINGS[k] === 'number') d[k] = DEFAULT_SETTINGS[k];
    db.setSettings(d);
    toast('Настройки сохранены');
  });

  on(root, 'click', '[data-sync-enable]', () => openSyncModal());
  on(root, 'click', '[data-sync-now]', async () => { const r = await syncNow(); toast(r.ok ? (r.changedLocal ? 'Получены изменения с другого устройства' : 'Всё синхронизировано') : (r.reason === 'busy' ? 'Уже идёт' : 'Не удалось: ' + r.reason)); });
  on(root, 'click', '[data-sync-disable]', () => { if (confirm('Выключить синхронизацию на этом устройстве? Данные останутся и здесь, и в облаке.')) { syncDisable(); toast('Синхронизация выключена'); } });
  const offSync = onSyncChange(() => {
    const c = root.querySelector('#syncCard');
    if (c) c.innerHTML = `<h3>Синхронизация между устройствами</h3>${syncBlock()}`;
  });

  on(root, 'click', '[data-install]', async () => { await promptInstall(); });
  const offInstall = onInstallChange(() => {
    const c = root.querySelector('#installCard');
    if (c) c.innerHTML = `<h3>Приложение на телефоне</h3>${installBlock()}`;
  });

  on(root, 'click', '[data-export]', () => {
    const blob = new Blob([JSON.stringify(db.exportJSON(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ultimate-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    localStorage.setItem('lifeos_lastExport', String(Date.now()));
    toast('Файл резервной копии сохранён');
  });
  const fileInput = root.querySelector('#importFile');
  on(root, 'click', '[data-import]', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0]; if (!f) return;
    try {
      const obj = JSON.parse(await f.text());
      if (obj._app !== 'lifeos') throw new Error('Это не файл ULTIMATE (LifeOS)');
      const merge = root.querySelector('#mergeImport').checked;
      if (!merge && !confirm('Заменить все текущие данные данными из файла?')) return;
      await db.importJSON(obj, { merge });
      toast('Данные импортированы');
    } catch (e) { alert('Не удалось импортировать: ' + e.message); }
  });
  on(root, 'click', '[data-wipe]', async () => {
    if (!confirm('Точно стереть ВСЕ данные? Сначала сделайте экспорт.')) return;
    if (prompt('Введите СТЕРЕТЬ для подтверждения') !== 'СТЕРЕТЬ') return;
    await db.clearAll();
    toast('Все данные удалены');
  });
  return () => { offInstall(); offSync(); };
}
