// Caches only the app shell, so the dashboard opens instantly and survives a
// flaky connection. Supabase traffic is never cached — it must always be live.
const SHELL = 'claude-remote-v4';
const FILES = ['.', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // Network-first so a redeploy is picked up, cache as the offline fallback.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        caches.open(SHELL).then((c) => c.put(e.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
