/**
 * 週案エディタ PWAシェル用 Service Worker
 *
 * シェル（index.html / manifest / アイコン等）のみをキャッシュします。
 * GAS本体（script.google.com）はクロスオリジンのiframeとして読み込まれるため、
 * ここではキャッシュしません（オフライン時はシェルのみ表示されます）。
 */
/* 【重要】キャッシュの掃除は、かならず自アプリのぶんだけに限る。
 *
 * gigayama.github.io は数十本の学習アプリが同じドメインを共有している。
 * ブラウザのキャッシュはドメイン単位なので、caches.keys() は
 * このアプリのものだけでなく、同居する全アプリのキャッシュを返す。
 *
 * これまでは「CACHE_NAME 以外ぜんぶ」を消していたため、先生が週案エディタを開いて
 * 新しい Service Worker が有効になった瞬間、その端末に入っていた
 * 児童むけアプリ（Qalc・KANJI_Town など）のオフライン用データまで消えていた。
 * 児童がオフラインでアプリを開いても起動せず、しかも原因がそのアプリ側に
 * 見えないため「たまに開かなくなる」という再現しにくい不具合になっていた。
 *
 * CACHE_PREFIX で始まるものだけを消せば、他のアプリには触らない。
 *
 * 【接頭辞はリポジトリごとに固有にすること】
 * 同一オリジンには GIGAyama/School_plan_note という別リポジトリ版があり、
 * そちらは 'school-plan-note-shell-' を使っている。接頭辞を共有すると、
 * 片方が有効になるたびにもう片方のキャッシュを消す——「全消し」を
 * 2アプリ間に縮めただけの、同じ不具合になる。
 * ここは 'schoolplan-editor-shell-' として重ならないようにしてある。 */
const CACHE_PREFIX = 'schoolplan-editor-shell-';
const CACHE_NAME = CACHE_PREFIX + 'v2';
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
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))   // ← 自アプリ分だけ削除
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
