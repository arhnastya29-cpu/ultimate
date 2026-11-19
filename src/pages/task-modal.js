// Общая форма задачи: одна модель для своих задач, задач от CEO, обещаний и задач проекта.
// Используется в Плане, проекте, Shadow, карточке человека и календаре.
import { db } from '../db.js';
import { esc, modal, field, formRow, toast } from '../ui.js';
import { newTask, ceoPerson } from '../model.js';

const PRIORITY_OPTIONS = [[1, 'Важная'], [2, 'Обычная'], [3, 'Низкая']];
const DIRECTION_OPTIONS = [['mine', 'Я'], ['theirs', 'Другой человек (жду от него)']];

export function openTaskModal(task, { defaults = {}, lockProject = false, lockPerson = false } = {}) {
  const isNew = !task;
  const x = task || newTask(defaults);
  const goals = db.all('goals').filter(g => g.status !== 'done' || g.id === x.goalId).map(g => [g.id, g.title]);
  const projects = db.all('projects').filter(p => p.status !== 'done' || p.id === x.projectId).map(p => [p.id, p.name]);
  const people = db.all('people').map(p => [p.id, p.name + (p.type === 'ceo' ? ' (CEO)' : '')]);
  const streamsFor = (pid) => db.all('streams').filter(s => s.projectId === pid && (s.status !== 'done' || s.id === x.streamId)).map(s => [s.id, s.name]);
  const streamField = (pid) => field({ name: 'streamId', label: 'Стрим', type: 'select', value: x.streamId || '', options: [['', pid ? (streamsFor(pid).length ? '— без стрима —' : 'стримов пока нет') : '— сначала проект —'], ...(pid ? streamsFor(pid) : [])] });
  const ceo = ceoPerson();
  modal({
    title: isNew ? (x.source === 'ceo' ? 'Задача от CEO' : x.personId ? 'Обязательство' : 'Новая задача') : 'Задача',
    body: `<div class="form">
      ${field({ name: 'title', label: 'Название', value: x.title, required: true, placeholder: 'Что нужно сделать', autofocus: isNew })}
      ${formRow(
        field({ name: 'date', label: 'Дата', type: 'date', value: x.date || '', hint: 'Пусто — в инбокс' }),
        field({ name: 'time', label: 'Время', type: 'time', value: x.time || '' }),
        field({ name: 'priority', label: 'Приоритет', type: 'select', value: x.priority ?? 2, options: PRIORITY_OPTIONS }),
      )}
      ${formRow(
        lockPerson
          ? `<input type="hidden" name="personId" value="${esc(x.personId || '')}">`
          : field({ name: 'personId', label: 'Человек', type: 'select', value: x.personId || '', options: [['', '— без человека —'], ...people], hint: ceo && !x.personId ? 'Выберите CEO, чтобы задача попала в Shadow' : '' }),
        field({ name: 'direction', label: 'Кто делает', type: 'select', value: x.direction || 'mine', options: DIRECTION_OPTIONS }),
      )}
      ${formRow(
        lockProject
          ? `<input type="hidden" name="projectId" value="${esc(x.projectId || '')}">`
          : field({ name: 'projectId', label: 'Проект', type: 'select', value: x.projectId || '', options: [['', '— без проекта —'], ...projects] }),
        `<div data-stream-slot>${streamField(x.projectId)}</div>`,
      )}
      ${formRow(
        field({ name: 'goalId', label: 'Цель', type: 'select', value: x.goalId || '', options: [['', '— без цели —'], ...goals] }),
        field({ name: 'estimateMin', label: 'Оценка, мин', type: 'number', value: x.estimateMin ?? '', min: 0, step: 5 }),
        field({ name: 'recurring', label: 'Повтор', type: 'select', value: x.recurring || '', options: [['', 'Нет'], ['daily', 'Ежедневно'], ['weekly', 'Еженедельно']] }),
      )}
      ${field({ name: 'notes', label: 'Описание / контекст', type: 'textarea', value: x.notes || '', rows: 3, placeholder: x.source === 'ceo' ? 'Зачем это ему, что ожидает увидеть' : '' })}
      ${field({ name: 'tags', label: 'Теги', value: (x.tags || []).join(', '), placeholder: 'через запятую' })}
      ${!isNew && (x.source === 'ceo' || x.personId) ? field({ name: 'result', label: 'Результат / что ответила', type: 'textarea', value: x.result || '', rows: 2 }) : ''}
      ${field({ name: 'timeless', label: 'Бессрочно — задача без дедлайна, живёт в отдельном списке', type: 'checkbox', value: !!x.timeless })}
    </div>`,
    onOpen: (wrap) => {
      const sel = wrap.querySelector('select[name="projectId"]');
      if (!sel) return;
      sel.addEventListener('change', () => { x.streamId = null; wrap.querySelector('[data-stream-slot]').innerHTML = streamField(sel.value || null); });
    },
    onSubmit: (d) => {
      const projectId = d.projectId || null;
      const streamId = projectId && d.streamId && db.get('streams', d.streamId)?.projectId === projectId ? d.streamId : null;
      const personId = d.personId || null;
      const direction = d.direction === 'theirs' ? 'theirs' : 'mine';
      let source = x.source || 'manual';
      if (isNew || source === 'manual' || source === 'promise' || source === 'project' || source === 'ceo') {
        source = personId && ceo && personId === ceo.id ? (x.source === 'promise' ? 'promise' : 'ceo') : personId ? 'promise' : projectId ? 'project' : (x.source === 'assistant' || x.source === 'meeting' ? x.source : 'manual');
      }
      const patch = {
        title: d.title.trim(), date: d.timeless ? null : (d.date || null), time: d.time || '', priority: Number(d.priority) || 2, timeless: !!d.timeless,
        goalId: d.goalId || null, projectId, streamId, personId, direction, source, estimateMin: d.estimateMin ?? null,
        notes: d.notes || '', recurring: d.recurring || null, tags: String(d.tags || '').split(/[,;]/).map(t => t.trim()).filter(Boolean),
      };
      if (d.result !== undefined) patch.result = d.result || '';
      if (isNew) { db.add('tasks', { ...newTask(), ...patch, done: false, doneAt: null, receivedAt: source === 'ceo' ? new Date().toISOString().slice(0, 10) : undefined }); toast('Задача добавлена'); }
      else { db.update('tasks', x.id, patch); toast('Задача сохранена'); }
    },
    onDelete: isNew ? undefined : () => { db.remove('tasks', x.id); toast('Задача удалена'); },
  });
}
