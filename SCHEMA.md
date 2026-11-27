# LifeOS — архитектура и схема данных

Приложение без сборки: `index.html` + ES-модули в `src/`. Запуск: `start.command` (python3 http.server на 127.0.0.1:8765).

## Как устроена страница

`src/pages/<id>.js` экспортирует:

```js
export const title = 'Название';
export async function render(root, { params, navigate, page }) {
  root.innerHTML = `...html...`;
  // навесить события; можно вернуть функцию очистки
}
```

- Любое изменение в `db` (add/update/remove/setSettings) автоматически перерисовывает текущую страницу с сохранением скролла. Поэтому **не держите состояние ввода в root во время сохранений**: редактирование делайте через `modal()` (она живёт вне root и не перерисовывается), а инлайн-правки сохраняйте на `change`/`blur`, не на `input`.
- Локальное состояние страницы (выбранная дата, фильтр, вкладка) храните в переменных уровня модуля — они переживают перерисовку.
- Импорты: `import { db } from '../db.js'` и `import { esc, el, icon, modal, field, formRow, toast, today, iso, addDays, fmtDate, ... } from '../ui.js'`.
- Стили: только классы из `src/styles.css` (card, stat, list, list-item, pill, chip, btn, field, grid-*, bar, tbl, empty...). Инлайн-стили допустимы для мелочей.
- Делегирование: `on(root, 'click', '[data-action]', (e, t) => ...)`.
- Даты всегда строка `YYYY-MM-DD` (локальная), helper `today()`, `addDays(iso, n)`, `iso(date)`.
- Все записи получают `id`, `createdAt` автоматически.
- Любой элемент с атрибутом `data-tip="текст"` показывает тултип при наведении; `barChart`/`lineChart` ставят его сами (можно переопределить полем `tip` у точки/столбца).
- При смене страницы блоки верхнего уровня в `#page` появляются с анимацией, значения `.stat .value` и `.big-num` считаются от нуля, прогресс-бары и кольца анимируются.

## Коллекции (`db.all('name')`)

| Коллекция | Поля |
|---|---|
| `learningAreas` | `name, color (css var или hex), icon (emoji), description, weeklyMinutesTarget` |
| `learningItems` | `areaId, title, type: 'course'\|'book'\|'article'\|'video'\|'practice'\|'other', status: 'planned'\|'active'\|'done', progress 0-100, url, notes` |
| `studySessions` | `areaId, itemId?, date, minutes, notes` |
| `flashcards` | `areaId, front, back, example, due (date), interval (дни), ease (2.5), reps, lapses` |
| `goals` | `title, description, areaKey: 'career'\|'health'\|'learning'\|'finance'\|'relations'\|'personal', horizon: 'year'\|'quarter'\|'month', deadline (date|null), status: 'active'\|'done'\|'paused', keyResults: [{id,title,done}], progress 0-100 (если нет KR — ручной)` |
| `projects` | `name, description, status: 'idea'\|'active'\|'paused'\|'done', priority 1\|2\|3, deadline (date|null), progress 0-100, nextStep, link, tags: string[], notes, color, startedAt, finishedAt?, log: [{id, date, text}] (журнал событий, новые сверху)` |
| `visionItems` | доска «Визуализация» (вкладка на странице целей): `type: 'image'\|'text', src (data URL JPEG, сжато до 1400px), w, h, caption, area?, order` |
| `shadowTasks` | **устаревшая** (до v21): перенесена в `tasks` (`id: ceo_<id>`, `source: 'ceo'`, `personId` = CEO). Не читать и не писать |
| `shadowNotes` | **устаревшая**: перенесена в `notes` (`id: shadow_<id>`, `type: recommendation|note`, `personId` = CEO, `quote`) |
| `streams` | направления внутри проекта: `projectId, name, description, status: 'active'\|'paused'\|'done', order` |
| `people` | `name, type: 'ceo'\|'team'\|'partner'\|'client'\|'other', role, org, tg, email, phone, tags: string[], notes (как работать), color` |
| `commitments` | **устаревшая**: перенесена в `tasks` (`id: commit_<id>`, `source: 'promise'`, `personId`, `direction`) |
| `contacts` | **устаревшая**: перенесена в `notes` (`id: contact_<id>`, `type: 'meeting'`, `personId`, `meetingKind`, `next`) |
| `kbSections` | разделы базы знаний пользователя: `name, icon (emoji), description, order` |
| `kbPages` | страницы базы знаний: `sectionId, title, body (простая разметка: #, -, **, \`, [[Название]]), tags: string[], pinned` |
| `ideas` | **устаревшая**: перенесена в `notes` (`id: idea_<id>`, `type: 'idea'`, `status, impact, effort, projectId`) |
| `events` | события календаря: `title, date, time 'HH:MM'?, endTime?, place, kind: 'meeting'\|'work'\|'personal'\|'health'\|'other', repeat: 'none'\|'daily'\|'weekdays'\|'weekly'\|'monthly', until (date)?, notes, personId? (встреча с человеком → «следующая встреча» в Shadow и карточке)`; повторы считаются на лету (`occursOn` в model.js) |
| `tasks` | **единая модель задачи**: `title, notes, date (date\|null = инбокс), time 'HH:MM'?, priority 1\|2\|3, done, doneAt?, projectId?, streamId?, goalId?, personId?, source: 'manual'\|'ceo'\|'promise'\|'project'\|'meeting'\|'assistant', direction: 'mine'\|'theirs' («мне обещали» — не моё дело, но видно у человека/в Shadow/в календаре), tags[], estimateMin?, recurring?, checklist[{id,title,done}], focusDate?, timeless?, result? (что ответила), receivedAt?`. Задача от CEO = `source: ceo, personId: <CEO>` |
| `checkins` | **единственный источник** самочувствия: `date (уникальна), mood 1-5, energy 1-5, stress 1-5, confidence 1-5, symptoms: string[], weight?, notes` |
| `labTests` | `date, name, value (number), unit, refLow?, refHigh?, notes` |
| `healthTodos` | `title, date?, type: 'appointment'\|'test'\|'other', done bool, notes` |
| `medications` | `name, dose, times: ('morning'\|'day'\|'evening')[], active bool, notes` |
| `medLogs` | `medId, date, time: 'morning'\|'day'\|'evening'` |
| `workouts` | `date, type: 'strength'\|'cardio'\|'mobility'\|'other', title, durationMin, rpe 1-10?, exercises: [{name, sets:[{reps, weight}]}] для strength, для cardio `{name, distanceKm, minutes}`, notes` |
| `workoutTemplates` | `title, type, exercises (та же структура, без заполненных сетов)` |
| `foods` | библиотека продуктов: `name, kcal, protein, fat, carbs` — всё **на 100 г**; `portionGrams?` (стандартная порция) |
| `meals` | `date, mealType: 'breakfast'\|'lunch'\|'dinner'\|'snack', name, grams, kcal, protein, fat, carbs` (итого за запись, уже умноженное), `foodId?` |
| `dayLogs` | `date (уникальна), waterMl, steps` |
| `habits` | `name, icon (emoji), color, days: number[] (0=пн..6=вс; пусто = ежедневно), target, archived, order, auto?: { kind: 'water'\|'workout'\|'study'\|'sleep'\|'steps'\|'task', target?, keyword?, areaId? }` — при `auto` выполнение считается из данных дня (`habitStatus` в model.js) |
| `habitLogs` | `habitId, date, count` |
| `sleepLogs` | **единственный источник** сна: `date (дата пробуждения, уникальна), bedTime, wakeTime, hours, quality 1-5, notes`; `energy` больше не пишется (читается как запасное) |
| `books` | устаревшая коллекция; один раз переносится в `notes` (id `book_<id>`), страница не показывает |
| `notes` | **единая модель заметки**: `type: 'note'\|'idea'\|'recommendation'\|'meeting'\|'insight'\|'project-log', title, body, date, tags[] (нижний регистр), personId?, projectId?, goalId?, learningItemId?, pinned, quote (показывать как цитату при включённых посланиях), kbPageId?`; поля источника `sourceType: 'book'\|'article'\|'podcast'\|'video'\|'course'\|'thought'\|'other', sourceTitle, sourceAuthor, sourceUrl, rating?, kind: 'summary'\|'idea'\|'quote'`; для идей `status: 'new'\|'maybe'\|'inwork'\|'done'\|'dropped', impact 1-3, effort 1-3`; для встреч `meetingKind: 'meeting'\|'call'\|'chat'\|'other', next` |
| `transactions` | `date, type: 'income'\|'expense', amount (number), category, note` |
| `budgets` | `category, monthlyLimit` |
| `financeGoals` | `title, target, saved, deadline?` |
| `journal` | `date (уникальна), wentWell, improve, gratitude, lessons, highlight, mood 1-5` |
| `weeklyReviews` | `weekStart (date пн), wins, challenges, nextFocus, rating 1-5` |

Настройки: `db.settings()` → `{ name, theme, visionStatement, notesV, unifyV (версия миграции к единым моделям), layouts (раскладки страниц), tone: 'neutral'|'support'|'business', quotes (послания вкл/выкл, по умолчанию выкл), eveningFrom, preset: 'minimal'|'work'|'health'|'full'|'custom', modules: { pageId: 'on'|'hidden'|'off' }, mobileTab ('work' или id раздела), aiFab, ceoPersonId, kcalTarget, proteinTarget, fatTarget, carbsTarget, waterTarget, sleepTarget, stepsTarget, currency, learningWeeklyMinutes }`.

### Сигналы (новости)
- `signalSources` — `{ id, name, kind: 'rss'|'telegram'|'site', url, feedUrl, tag, paused, lastFetchAt, lastError, lastCount, siteUrl, renamed }`.
- `signalItems` — `{ id: 'sig_'+hash(источник+ссылка), sourceId, title, link, date, summary, read, saved, fetchedAt, tagged, topic, importance 1–3, dupOf, vote 1|-1|null, brief, briefAt }`; удалённые попадают в tombstones и не возвращаются при обновлении.
- `signalDigests` — `{ id, date, kind 'day'|'week', period, text, itemIds, provider }` — одна сводка на день и одна на неделю (date = понедельник).
- `tasks.link` — необязательная ссылка на источник задачи: `{ kind: 'tg', chat, name, msg, url }` из Чатов или `{ kind: 'url', url, label }` из Сигналов.
- Настройки: `signalsProxy` (auto | local | direct | шаблон с `{url}`), `signalsFocus`, `signalsKeepDays`, `signalsHours`, `signalsTopics`, `signalsAutoTag`, `signalsAutoDigest`, `signalsWeekly`.

## Единые модели и миграции (с v21)

- `src/model.js` — общая доменная логика: `agendaOn(d)` (события, задачи, ожидания, дедлайны, медицина на дату), `nextEvent()`, `nextMeetingWith(personId)`, `upcomingDeadlines()`, `overdueItems()`, `addTask/toggleTask/setTaskDone`, `addNote`, `projectProgress(p)` (из задач/стримов), `goalProgress(g)` (из KR или задач), `habitStatus(h, d)` (ручная отметка или авто из данных), `checkinOn/setCheckin/sleepOn/setSleepHours/energyOn`, `addWater/addSteps/addTransaction`, `ceoPerson()/ensureCeoPerson()`, `lastContactOf(personId)` (из заметок type meeting), `tone()/quotesOn()/addressing()`, `moduleOn(pageId)`.
- `src/migrate.js` — `runMigrations()` при старте, после импорта JSON и после слияния синхронизации. Идемпотентна: детерминированные id (`ceo_`, `commit_`, `shadow_`, `idea_`, `contact_`), проверка tombstones, старые коллекции не удаляются (поэтому старый JSON импортируется без потерь).
- `src/capture.js` — окно «Записать» (кнопка «+»): текст → тип угадывается (время → событие, сумма → расход, «выпила 500» → активность), контекст раздела даёт человека/проект/дату, «Подробнее» раскрывает поля.
- Shadow (`src/pages/shadow.js`) ничего не хранит: показывает `tasks.personId = CEO`, `notes.personId = CEO`, `events.personId = CEO`.
- Навигация (`src/app.js`): группы Основное/Работа/Знания/Личное/Ресурсы сворачиваются; на телефоне внизу Сегодня · План · «+» · Работа (хаб: проекты/люди/Shadow, переключатель над страницей) · Ещё. Алиасы маршрутов: `#/goals` → `#/plan?tab=goals`, `#/calendar` → `#/plan?tab=week`, `#/books` → `#/notes`. Настройка страницы — пункт меню «•••» (`pageMenu` в ui.js, пункт `action="customize"`).

Общая форма задачи — `src/pages/task-modal.js` (`openTaskModal(task, { defaults, lockProject })`), используется в целях и внутри проекта. Страница проекта: `#/projects?id=<id>` (стримы, задачи по стримам, журнал).

## Модульные страницы (`src/blocks.js`)

Два механизма. (1) Явные блоки: страница строит массив `{ id, title, col, html }` и вызывает `composeBlocks(pageId, blocks)` + `bindCustomize(view, pageId, blocks)` (так сделана «Сегодня»). (2) Автоматические блоки: `app.js` после каждого рендера вызывает `applyLayout(root, pageId)`, который находит блоки (элементы с `data-block="id" data-block-title="…"` или карточки с заголовком секции, или ряды `.stat`) и применяет сохранённые порядок, колонку (`.grid-2 > .stack`) и видимость; кнопка «Настроить страницу» добавляется в `.page-head .actions`. Настройки — `settings.layouts[pageId] = { order, col, hidden }`, синхронизируются. Перестановка стрелками работает внутри одного контейнера; перенос между колонками — отдельными кнопками. Новые секции на странице: оберните в `data-block` с устойчивым id, иначе id выводится из текста заголовка.

## Синхронизация (`src/sync.js`)

Из пароля (PBKDF2) выводятся id «полки» и ключ AES-GCM; `db.snapshot()` сжимается, шифруется и хранится одной строкой в таблице `vaults` Supabase (`id, blob, version, updated_at`). Слияние по записям: побеждает большее `updatedAt`, удаления через `db.tombstones` (`{col: {id: isoDate}}`, пишутся в `db.remove`). Запись в облако защищена проверкой `version`. Настройки устройства — в `localStorage['ultimate_sync']` (id полки и ключ в JWK, пароль не хранится). Публичный ключ Supabase в коде не секретный.

## Помощник (`src/ai.js`, `src/ai-panel.js`)

Настройки помощника — в `localStorage['ultimate_ai']` (не синхронизируются): `provider: ollama|claude`, `ollamaUrl`, `ollamaModel`, ключ Claude и модель. Локальная модель: `requestOllama` (потоковый `/api/chat` с инструментами), `probeOllama()` проверяет доступность и даёт `aiReady()`; `askOnce()` — короткий ответ без истории («Совет на сегодня» на главной). `buildContext(pageId)` собирает текстовую выжимку всех разделов с id записей; `ask(text, {pageId, onText, onAction})` шлёт потоковый запрос в `api.anthropic.com/v1/messages` (`anthropic-version: 2026-10-21`, заголовок `anthropic-dangerous-direct-browser-access`), выполняет инструменты (`add_task`, `complete_task`, `log_habit`, `add_shadow_task`, `add_shadow_note`, `add_project_log`, `add_goal`, `write_journal`) и возвращает текст. История чата (текст) — `localStorage['ultimate_ai_chat']`. Панель: плавающая кнопка, ⌘J, быстрые вопросы по разделу (`quickPrompts`), голосовой ввод через SpeechRecognition.
