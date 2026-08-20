// Минимальный service worker — нужен только для того, чтобы Android Chrome
// предложил "Установить приложение" и запускал его в отдельном окне без
// адресной строки. Данные (логин, статусы) он не кэширует — приложение
// всегда работает с актуальными данными из МойСклад через прокси.
//
// Стратегия "сначала сеть, кэш — только как запасной вариант при отсутствии
// интернета". Это специально изменено после случая, когда старая закэшированная
// версия config.js мешала обновлениям доходить до телефона.

const CACHE_NAME = "sklad-scanner-shell-v8";
const SHELL_FILES = [
  "./index.html",
  "./app.js",
  "./config.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Только "оболочка" приложения вообще проходит через кэш. Все запросы к
// прокси/МойСклад не трогаем — они всегда идут напрямую в сеть.
self.addEventListener("fetch", (event) => {
  const isShellFile = SHELL_FILES.some((f) => event.request.url.includes(f.replace("./", "")));
  if (!isShellFile) return;

  event.respondWith(
    fetch(event.request)
      .then((fresh) => {
        // Обновляем кэш свежей версией на будущее (на случай если пропадёт интернет)
        const clone = fresh.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return fresh;
      })
      .catch(() => caches.match(event.request)) // сеть недоступна — берём то, что есть в кэше
  );
});
