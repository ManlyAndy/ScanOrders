// Минимальный service worker — нужен только для того, чтобы Android Chrome
// предложил "Установить приложение" и запускал его в отдельном окне без
// адресной строки. Данные (логин, статусы) он не кэширует — приложение
// всегда работает с актуальными данными из МойСклад через прокси.

const CACHE_NAME = "sklad-scanner-shell-v6";
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

// Только "оболочка" приложения идёт из кэша (чтобы быстро открывалось).
// Все запросы к API/прокси НИКОГДА не кэшируются — всегда идут в сеть.
self.addEventListener("fetch", (event) => {
  const isShellFile = SHELL_FILES.some((f) => event.request.url.includes(f.replace("./", "")));
  if (!isShellFile) return; // не трогаем запросы к прокси/МойСклад

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
