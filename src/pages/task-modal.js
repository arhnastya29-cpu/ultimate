// Общая форма задачи: используется на странице целей и внутри проекта.
// Задача может быть привязана к цели, к проекту и к стриму внутри проекта.
import { db } from '../db.js';
import { esc, modal, field, formRow, toast } from '../ui.js';

const PRIORITY_OPTIONS = [[1, 'Важная'], [2, 'Обычная'], [3, 'Низкая']];

export function openTaskModal(task, { defaults = {}, lockProject = false } = {}) {
  const isNew = !task;
  const x = task || { title: '', date: null, priority: 2, goalId: null, projectId: null, streamId: null, estimateMin: null, notes: '', recurring: null, ...defaults };
  const goals = db.all('goals').filter(g => g.status !== 'done' || g.id === x.goalId).map(g => [g.id, g.title]);
  const projects = db.all('projects').filter(p => p.status !== 'done' || p.id === x.projectId).map(p => [p.id, p.name]);
  const streamsFor = (pid) => db.all('streams').filter(s => s.projectId === pid && (s.status !== 'done' || s.id === x.streamId)).map(s => [s.id, s.name]);
  const streamField = (pid) => field({ name: 'streamId', label: 'Стрим', type: 'select', value: x.streamId || '', options: [['', pid ? (streamsFor(pid).length ? '— без стрима —' : 'стримов пока нет') : '— сначала проект —'], ...(pid ? streamsFor(pid) : [])] });
  modal({
    title: isNew ? 'Новая задача' : 'Задача',
    body: `<div class="form">
      ${field({ name: 'title', label: 'Название', value: x.title, required: true, placeholder: 'Что нужно сделать', autofocus: isNew })}
      ${formRow(
        field({ name: 'date', label: 'Дата', type: 'date', value: x.date || '', hint: 'Пусто — в инбокс' }),
        field({ name: 'priority', label: 'Приоритет', type: 'select', value: x.priority ?? 2, options: PRIORITY_OPTIONS }),
        field({ name: 'estimateMin', label: 'Оценка, мин', type: 'number', value: x.estimateMin ?? '', min: 0, step: 5 }),
      )}
      ${formRow(
        lockProject
          ? `<input type="hidden" name="projectId" value="${esc(x.projectId || '')}">`
          : field({ name: 'projectId', label: 'Проект', type: 'select', value: x.projectId || '', options: [['', '— без проекта —'], ...projects] }),
        `<div data-stream-slot>${streamField(x.projectId)}</div>`,
      )}
      ${formRow(
        field({ name: 'goalId', label: 'Цель', type: 'select', value: x.goalId || '', options: [['', '— без цели —'], ...goals] }),
        field({ name: 'recurring', label: 'Повтор', type: 'select', value: x.recurring || '', options: [['', 'Нет'], ['daily', 'Ежедневно'], ['weekly', 'Еженедельно']] }),
      )}
      ${field({ name: 'notes', label: 'Заметки', type: 'textarea', value: x.notes || '', rows: 3 })}
      ${field({ name: 'timeless', label: 'Бессрочно — задача без дедлайна, живёт в отдельном списке', type: 'checkbox', value: !!x.timeless })}
    </div>`,
    onOpen: (wrap) => {
      const sel = wrap.querySelector('select[name="projectId"]');
      if (!sel) return;
      sel.addEventListener('change', () => {
        x.streamId = null;
        wrap.querySelector('[data-stream-slot]').innerHTML = streamField(sel.value || null);
      });
    },
    onSubmit: (d) => {
      const projectId = d.projectId || null;
      const streamId = projectId && d.streamId && db.get('streams', d.streamId)?.projectId === projectId ? d.streamId : null;
      const patch = {
        title: d.title.trim(), date: d.timeless ? null : (d.date || null), priority: Number(d.priority) || 2, timeless: !!d.timeless,
        goalId: d.goalId || null, projectId, streamId, estimateMin: d.estimateMin ?? null,
        notes: d.notes || '', recurring: d.recurring || null,
      };
      if (isNew) { db.add('tasks', { ...patch, done: false, doneAt: null }); toast('Задача добавлена'); }
      else { db.update('tasks', x.id, patch); toast('Задача сохранена'); }
    },
    onDelete: isNew ? undefined : () => { db.remove('tasks', x.id); toast('Задача удалена'); },
  });
}
