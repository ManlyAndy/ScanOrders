const CACHE_NAME = "sklad-scanner-shell-v7";
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

self.addEventListener("fetch", (event) => {
  const isShellFile = SHELL_FILES.some((f) => event.request.url.includes(f.replace("./", "")));
  if (!isShellFile) return;

  event.respondWith(
    fetch(event.request)
      .then((fresh) => {
    
        const clone = fresh.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return fresh;
      })
      .catch(() => caches.match(event.request)) 
  );
});
