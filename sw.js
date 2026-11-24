/* ULTIMATE service worker.
   Стратегия: оболочка приложения (HTML, JS, CSS, иконки) кладётся в кэш при установке
   и отдаётся из него сразу («cache first»), а в фоне обновляется с сети.
   Шрифты Google кэшируются по мере загрузки. Данные приложения живут в IndexedDB,
   service worker их не трогает.
   При любом изменении файлов в src/ поднимайте VERSION — старый кэш удалится. */
const VERSION = 'lifeos-v29';
const APP_SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon.svg",
  "icons/maskable-512.png",
  "icons/maskable.svg",
  "src/ai-panel.js",
  "src/ai.js",
  "src/app.js",
  "src/blocks.js",
  "src/capture.js",
  "src/css/body.css",
  "src/css/chats.css",
  "src/css/habits.css",
  "src/css/journal.css",
  "src/css/kb.css",
  "src/css/learning.css",
  "src/css/notes.css",
  "src/css/people.css",
  "src/css/plan.css",
  "src/css/projects.css",
  "src/css/signals.css",
  "src/db.js",
  "src/fx.js",
  "src/pages/calendar.js",
  "src/pages/chats.js",
  "src/pages/finance.js",
  "src/pages/goals.js",
  "src/pages/habits.js",
  "src/pages/health.js",
  "src/pages/ideas.js",
  "src/pages/journal.js",
  "src/pages/kb.js",
  "src/pages/learning.js",
  "src/pages/notes.js",
  "src/pages/nutrition.js",
  "src/pages/people.js",
  "src/pages/projects.js",
  "src/pages/settings.js",
  "src/pages/shadow.js",
  "src/pages/signals.js",
  "src/pages/sleep.js",
  "src/pages/task-modal.js",
  "src/pages/today.js",
  "src/pages/vision.js",
  "src/pages/workouts.js",
  "src/migrate.js",
  "src/model.js",
  "src/motivation.js",
  "src/pages/plan.js",
  "src/pwa.js",
  "src/signals-ai.js",
  "src/signals.js",
  "src/styles.css",
  "src/sync.js",
  "src/tg.js",
  "src/ui.js",
  "src/whoop.js"
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    // Каждый файл кладём отдельно: если один не закэшировался, новая версия всё равно установится.
    caches.open(VERSION).then((cache) => Promise.allSettled(APP_SHELL.map((f) => cache.add(f)))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k.startsWith('lifeos-')).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Шрифты: stale-while-revalidate, чтобы офлайн не ломалась типографика.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(req, 'lifeos-fonts'));
    return;
  }
  if (url.origin !== self.location.origin) return;
  // Мост к лентам и проверка локального сервера (serve.py) — всегда напрямую в сеть, без кэша.
  if (url.pathname.startsWith('/__')) return;

  // Навигация: отдаём index.html из кэша, иначе сеть.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./').then((hit) => hit || caches.match('index.html')).then((hit) => hit || fetch(req))
    );
    return;
  }
  event.respondWith(staleWhileRevalidate(req, VERSION));
});

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req).then((res) => {
    // Ответ с Cache-Control: no-store в кэш не кладётся — это не ошибка, отдаём его как есть.
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
    return res;
  }).catch(() => undefined);
  return cached || (await network) || Response.error();
}
