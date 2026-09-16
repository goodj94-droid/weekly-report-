// Service worker: selalu ambil versi terbaru saat online, pakai cache saat offline.
const SCOPE = self.registration.scope;
const CACHE = 'net-v1:' + SCOPE;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.startsWith('net-') && k.endsWith(SCOPE) && k !== CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function fromCache(req) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  if (req.mode === 'navigate') {
    return (await caches.match(SCOPE)) || (await caches.match(SCOPE + 'index.html')) || null;
  }
  return null;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const mine = req.url.startsWith(SCOPE);
  if (!mine && url.hostname !== 'cdnjs.cloudflare.com') return;

  e.respondWith((async () => {
    const net = fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    });
    net.catch(() => {});
    try {
      const res = await Promise.race([net, new Promise((r) => setTimeout(r, 5000, null))]);
      if (res) return res;
      const hit = await fromCache(req);
      return hit || await net;
    } catch (err) {
      const hit = await fromCache(req);
      return hit || Response.error();
    }
  })());
});
