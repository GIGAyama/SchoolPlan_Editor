/**
 * 週案エディタ PWAシェル用 Service Worker
 *
 * シェル（index.html / manifest / アイコン等）のみをキャッシュします。
 * GAS本体（script.google.com）はクロスオリジンのiframeとして読み込まれるため、
 * ここではキャッシュしません（オフライン時はシェルのみ表示されます）。
 */
/*
 * 【最重要】activate では自アプリ以外のキャッシュを削除しない。
 *   gigayama.github.io は数十個のアプリが同一オリジンを共有しているため、
 *   CACHE_PREFIX で始まるキャッシュだけを掃除する。
 *   以前はここで caches.keys() の結果を全部消していた。そのため
 *   このアプリを開くたびに、同じ端末に入っている他の GIGA アプリの
 *   キャッシュまで巻き添えで消え、それらがオフラインで起動しなくなっていた。
 */
const CACHE_PREFIX = 'school-plan-note-shell-';
const APP_VERSION = 'v3';   // ← リリースごとに必ず上げる
const CACHE_NAME = CACHE_PREFIX + APP_VERSION;
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
        keys
          // ← 自アプリ接頭辞のものだけを削除する。ここを外すと
          //    同一オリジンの他アプリを巻き添えにする。
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
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
