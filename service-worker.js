/* ============================================================
   EngForDev Service Worker
   - 预缓存应用外壳（本地双击运行时不会注册，仅在 HTTP 部署时生效）
   - 离线优先策略：网络失败回退缓存
   ============================================================ */
const CACHE = 'engfordev-v18';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './data.js',
  './manifest.json'
];

// 安装：预缓存核心资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

// 激活：清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 请求拦截：缓存优先，回退网络
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((resp) => {
          // 同源响应才缓存
          if (resp && resp.status === 200 && new URL(event.request.url).origin === location.origin) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => cached);
    })
  );
});
