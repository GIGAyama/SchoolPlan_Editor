/**
 * 週案エディタ PWAシェル用 Service Worker
 *
 * シェル（index.html / manifest / アイコン等）のみをキャッシュします。
 * GAS本体（script.google.com）はクロスオリジンのiframeとして読み込まれるため、
 * ここではキャッシュしません（オフライン時はシェルのみ表示されます）。
 */
const CACHE_NAME = 'school-plan-note-shell-v2';
const SHELL_ASSETS = [
  './',
  './index.html',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 同一オリジンのGETのみ扱う（GAS本体やCDNはブラウザに任せる）
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // ナビゲーションはネットワーク優先、失敗時はキャッシュ済みシェルを返す
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // その他のシェル資産はキャッシュ優先 + バックグラウンド更新
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetched = fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
