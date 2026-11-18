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
| `tasks` | `title, date (date|null = без даты/инбокс), priority: 1 (высокий)\|2\|3, goalId?, done bool, doneAt?, notes, estimateMin?, recurring?: 'daily'\|'weekly'\|null` |
| `checkins` | `date (уникальна), mood 1-5, energy 1-5, stress 1-5, symptoms: string[], weight?, notes` |
| `labTests` | `date, name, value (number), unit, refLow?, refHigh?, notes` |
| `healthTodos` | `title, date?, type: 'appointment'\|'test'\|'other', done bool, notes` |
| `medications` | `name, dose, times: ('morning'\|'day'\|'evening')[], active bool, notes` |
| `medLogs` | `medId, date, time: 'morning'\|'day'\|'evening'` |
| `workouts` | `date, type: 'strength'\|'cardio'\|'mobility'\|'other', title, durationMin, rpe 1-10?, exercises: [{name, sets:[{reps, weight}]}] для strength, для cardio `{name, distanceKm, minutes}`, notes` |
| `workoutTemplates` | `title, type, exercises (та же структура, без заполненных сетов)` |
| `foods` | библиотека продуктов: `name, kcal, protein, fat, carbs` — всё **на 100 г**; `portionGrams?` (стандартная порция) |
| `meals` | `date, mealType: 'breakfast'\|'lunch'\|'dinner'\|'snack', name, grams, kcal, protein, fat, carbs` (итого за запись, уже умноженное), `foodId?` |
| `dayLogs` | `date (уникальна), waterMl, steps` |
| `habits` | `name, icon (emoji), color, days: number[] (0=пн..6=вс; пусто = ежедневно), target (раз в день, по умолчанию 1), archived bool, order` |
| `habitLogs` | `habitId, date, count` |
| `sleepLogs` | `date (дата пробуждения, уникальна), bedTime 'HH:MM', wakeTime 'HH:MM', hours (number), quality 1-5, energy 1-5, notes` |
| `books` | `title, author, status: 'want'\|'reading'\|'done', rating 1-5?, pages?, pagesRead?, areaId?, startedAt?, finishedAt?, summary` |
| `notes` | `title, body, tags: string[], bookId?, areaId?, pinned bool` |
| `transactions` | `date, type: 'income'\|'expense', amount (number), category, note` |
| `budgets` | `category, monthlyLimit` |
| `financeGoals` | `title, target, saved, deadline?` |
| `journal` | `date (уникальна), wentWell, improve, gratitude, lessons, highlight, mood 1-5` |
| `weeklyReviews` | `weekStart (date пн), wins, challenges, nextFocus, rating 1-5` |

Настройки: `db.settings()` → `{ name, theme, kcalTarget, proteinTarget, fatTarget, carbsTarget, waterTarget, sleepTarget, stepsTarget, currency, learningWeeklyMinutes }`.
