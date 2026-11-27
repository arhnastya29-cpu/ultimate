// Регистрация service worker и обработка установки PWA.
// Экспортирует canInstall()/promptInstall() для кнопки «Установить» в настройках.
import { toast } from './ui.js';

let deferredPrompt = null;
const listeners = new Set();

export function canInstall() { return !!deferredPrompt; }
export function onInstallChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
// Версия установленной копии (из service worker) — показывается в Настройках, чтобы было видно, что открылось.
export function appVersion() {
  return new Promise((resolve) => {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) return resolve(null);
    const tm = setTimeout(() => resolve(null), 1500);
    const onMsg = (e) => { if (e.data?.type === 'version') { clearTimeout(tm); navigator.serviceWorker.removeEventListener('message', onMsg); resolve(String(e.data.version).replace('lifeos-', '')); } };
    navigator.serviceWorker.addEventListener('message', onMsg);
    sw.postMessage('version');
  });
}
// Проверить обновление вручную (кнопка в Настройках). Возвращает true, если нашлась новая версия.
export async function checkUpdate() {
  const reg = await navigator.serviceWorker?.getRegistration();
  if (!reg) return false;
  await reg.update();
  return !!(reg.installing || reg.waiting);
}
export async function promptInstall() {
  if (!deferredPrompt) return false;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  listeners.forEach((fn) => fn());
  return outcome === 'accepted';
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  listeners.forEach((fn) => fn());
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  listeners.forEach((fn) => fn());
  toast('ULTIMATE установлен');
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      // На телефоне приложение живёт в фоне днями: проверяем обновление при каждом возвращении на экран и раз в полчаса.
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
      setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
      if (reg.waiting && navigator.serviceWorker.controller) reg.waiting.postMessage('skipWaiting');   // обновление уже скачано раньше
      // Новая версия скачана и ждёт — применяем и перезагружаем один раз.
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Доступно обновление, перезагружаю…', 1800);
            nw.postMessage('skipWaiting');
          }
        });
      });
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return; reloaded = true;
        if (navigator.serviceWorker.controller) location.reload();
      });
    } catch (err) {
      console.warn('Service worker не зарегистрирован:', err);
    }
  });
}
