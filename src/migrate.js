// Миграции данных к единым моделям (см. docs/REDESIGN.md, раздел 4).
// Запускается после загрузки базы, после импорта JSON и после слияния синхронизации.
// Идемпотентна: id новых записей детерминированы, старые коллекции не удаляются,
// удалённые пользователем мигрированные записи не возрождаются (проверка tombstone).
import { db } from './db.js';
import { ensureCeoPerson, ceoPerson } from './model.js';

let running = false;

const dead = (col, id) => !!db.tombstones?.[col]?.[id];
const exists = (col, id) => !!db.get(col, id) || dead(col, id);
const put = (col, rec) => db.add(col, rec);   // add сохраняет переданный id

function migrateShadowTasks(ceoId) {
  let n = 0;
  for (const x of db.all('shadowTasks')) {
    const id = 'ceo_' + x.id; if (exists('tasks', id)) continue;
    put('tasks', { id, createdAt: x.createdAt, title: x.title || '', notes: x.context || '', date: x.deadline || null, time: '', priority: [1, 2, 3].includes(Number(x.priority)) ? Number(x.priority) : 2, done: !!x.done, doneAt: x.doneAt || null, projectId: null, streamId: null, goalId: null, personId: ceoId, source: 'ceo', direction: 'mine', tags: [], estimateMin: null, recurring: null, checklist: [], timeless: false, result: x.result || '', receivedAt: x.receivedAt || (x.createdAt || '').slice(0, 10) });
    n++;
  }
  return n;
}

function migrateCommitments() {
  let n = 0;
  for (const c of db.all('commitments')) {
    const id = 'commit_' + c.id; if (exists('tasks', id)) continue;
    if (!c.personId || !db.get('people', c.personId)) continue;    // без человека обещание бессмысленно; останется в старой коллекции
    put('tasks', { id, createdAt: c.createdAt, title: c.title || '', notes: c.notes || '', date: c.due || null, time: '', priority: 2, done: !!c.done, doneAt: c.doneAt || null, projectId: null, streamId: null, goalId: null, personId: c.personId, source: 'promise', direction: c.direction === 'theirs' ? 'theirs' : 'mine', tags: [], estimateMin: null, recurring: null, checklist: [], timeless: false });
    n++;
  }
  return n;
}

function migrateShadowNotes(ceoId) {
  let n = 0;
  for (const x of db.all('shadowNotes')) {
    const id = 'shadow_' + x.id; if (exists('notes', id)) continue;
    put('notes', { id, createdAt: x.createdAt, type: x.type === 'advice' ? 'recommendation' : 'note', title: x.title || '', body: x.body || '', date: x.date || (x.createdAt || '').slice(0, 10), tags: Array.isArray(x.tags) ? x.tags : [], personId: ceoId, projectId: null, goalId: null, learningItemId: null, pinned: !!x.pinned, quote: !!x.quote, sourceType: 'thought', sourceTitle: '', sourceAuthor: '', sourceUrl: '' });
    n++;
  }
  return n;
}

function migrateIdeas() {
  let n = 0;
  for (const i of db.all('ideas')) {
    const id = 'idea_' + i.id; if (exists('notes', id)) continue;
    put('notes', { id, createdAt: i.createdAt, type: 'idea', title: i.title || '', body: i.body || '', date: (i.createdAt || '').slice(0, 10), tags: Array.isArray(i.tags) ? i.tags : [], personId: null, projectId: i.projectId || null, goalId: null, learningItemId: null, pinned: !!i.pinned, quote: false, status: i.status || 'new', impact: Number(i.impact) || 2, effort: Number(i.effort) || 2, sourceType: 'thought', sourceTitle: '', sourceAuthor: '', sourceUrl: '' });
    n++;
  }
  return n;
}

function migrateContacts() {
  let n = 0;
  for (const c of db.all('contacts')) {
    const id = 'contact_' + c.id; if (exists('notes', id)) continue;
    if (!c.personId) continue;
    const text = String(c.text || '').trim();
    put('notes', { id, createdAt: c.createdAt, type: 'meeting', title: text.split('\n')[0].slice(0, 80) || 'Контакт', body: text, date: c.date || (c.createdAt || '').slice(0, 10), tags: [], personId: c.personId, projectId: null, goalId: null, learningItemId: null, pinned: false, quote: false, meetingKind: c.kind || 'other', next: c.next || '', sourceType: 'thought', sourceTitle: '', sourceAuthor: '', sourceUrl: '' });
    n++;
  }
  return n;
}

function normalizeNotes() {
  let n = 0;
  for (const x of db.all('notes')) {
    const patch = {};
    if (!x.type) patch.type = 'note';
    if (x.quote === undefined) patch.quote = false;
    if (Object.keys(patch).length) { db.update('notes', x.id, patch); n++; }
  }
  return n;
}

function normalizeTasks() {
  let n = 0;
  for (const t of db.all('tasks')) {
    const patch = {};
    if (!t.source) patch.source = 'manual';
    if (!t.direction) patch.direction = 'mine';
    if (Object.keys(patch).length) { db.update('tasks', t.id, patch); n++; }
  }
  return n;
}

export function runMigrations() {
  if (running) return null; running = true;
  try {
    const hasShadow = db.all('shadowTasks').length || db.all('shadowNotes').length;
    const ceo = hasShadow ? ensureCeoPerson() : ceoPerson();
    const ceoId = ceo?.id || null;
    const report = {
      ceoTasks: ceoId ? migrateShadowTasks(ceoId) : 0,
      commitments: migrateCommitments(),
      ceoNotes: ceoId ? migrateShadowNotes(ceoId) : 0,
      ideas: migrateIdeas(),
      contacts: migrateContacts(),
      notes: normalizeNotes(),
      tasks: normalizeTasks(),
    };
    if ((db.settings().unifyV || 0) < 1) db.setSettings({ unifyV: 1 });
    const total = Object.values(report).reduce((a, b) => a + b, 0);
    if (total) console.info('[migrate]', report);
    return report;
  } finally { running = false; }
}
