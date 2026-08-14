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
// リリースごとに必ず上げる。上げ忘れると、直した内容が先生の端末に届かない。
const CACHE_NAME = CACHE_PREFIX + 'v4';
const SHELL_ASSETS = [
  './',
  './index.html',
  './offline.html',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // addAll は1本でも失敗すると全部が落ちる。1つずつ入れて、
    // 取りこぼしたものがあっても残りは使えるようにする。
    await Promise.all(SHELL_ASSETS.map((url) =>
      cache.add(new Request(url, { cache: 'reload' }))
        .catch((err) => console.warn('[sw] precache skipped', url, err))
    ));
    // ここでは skipWaiting しない。
    // 先生が入力している最中に画面が入れ替わると、打ちかけの週案が消える。
    // 画面側で「あたらしい版があります」を出し、押されてから切り替える。
  })());
});

// 画面側で「最新にする」が押されたときだけ切り替える。
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
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
          // 【重要】ナビゲーション先が何であれ ./index.html として保存してはいけない。
          // 同じオリジンには about.html / privacy-policy.html / terms.html があり、
          // 先生がそれらを一度開くと、オフライン用のシェルがその静的ページに
          // 差し替わる。次に圏外でアプリを開くと、週案ではなく利用規約が出る。
          // シェル自身（ルート または index.html）のときだけ保存する。
          const path = url.pathname.replace(/\/$/, '/index.html');
          if (path.endsWith('/index.html')) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          }
          return res;
        })
        // 圏外のとき：まずキャッシュ済みのシェル、それも無ければ
        // 「つながっていません」の画面を出す。何も返さないと
        // ブラウザ既定のエラー画面になり、先生には「壊れた」ように見える。
        .catch(() => caches.match('./index.html')
          .then((hit) => hit || caches.match('./offline.html'))
          .then((hit) => hit || Response.error()))
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
