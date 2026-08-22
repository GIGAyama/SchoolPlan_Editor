/**
 * 品質ゲート（GIGA Standard v5 Part I の検査）自身のテスト。
 *
 * なぜ要るか：
 *   「0件でした」だけでは、検査が動いているのか何も見ていないのか区別できない。
 *   わざと壊した木を作って、ちゃんと拾えることを確かめる。
 *   逆に、正しく書いてあるものを誤って拾わないことも確かめる
 *   （実際、コメントの文言や @supports のフォールバックで誤検知した）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runGigaV5Checks, stripComments } from '../scripts/lib/giga-v5-checks.mjs';

function makeTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-v5-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function check(files, options = {}) {
  const dir = makeTree(files);
  const list = Object.keys(files);
  return runGigaV5Checks(dir, list, { repoName: 'Demo_App', ...options });
}

const codes = (issues) => issues.map(i => i.code);

// 最低限そろっている木（これを基準に、1つずつ壊す）
const OK_TREE = {
  'LICENSE': 'MIT',
  '.gitignore': 'node_modules/\n',
  '.github/dependabot.yml': 'version: 2\n',
  'App.html': `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<style>#app { height: 100dvh; }
@supports not (height: 100dvh) { #app { height: 100vh; } }</style>`,
  'code.gs': `function doGet() {
  return HtmlService.createTemplateFromFile('App').evaluate()
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, viewport-fit=cover');
}`,
  'docs/manifest.webmanifest': JSON.stringify({ id: '/Demo_App/', scope: '/Demo_App/', start_url: '/Demo_App/' }),
  'docs/offline.html': '<p>つながっていません</p>',
  'docs/install-hook.js': 'window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); });',
  // 公開ページ（ポータル・OAuth のホームページ欄からの入口）。
  // アプリ本体と同じ manifest とアイコンを持ち、インストールの合図も受ける。
  'docs/about.html': `<head><script src="install-hook.js"></script>
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png"></head>
<body><a href="./">アプリを開く</a></body>`,
  'docs/index.html': `<head><script src="install-hook.js"></script></head>
<body><img src="a.png" width="64" height="64">
<script>
// Safari には beforeinstallprompt が無いので、メニューに常時出す
if (document.readyState === 'complete') navigator.serviceWorker.register('sw.js');
else window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js'); });
</script></body>`,
  'docs/sw.js': `const CACHE_PREFIX = 'demo-';
const APP_VERSION = 'v0'; /* __APP_VERSION__ */
// localStorage は一切操作しない
self.addEventListener('install', (event) => { event.waitUntil(caches.open('demo-v1')); });
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => caches.delete(k)))));
});
self.addEventListener('message', (e) => { if (e.data.type === 'SKIP_WAITING') self.skipWaiting(); });`,
  // 版の生成器。これが無いと GIGA_SW_VERSION_GENERATED が「自動生成が外れている」と言う
  'tools/build-sw.mjs': '// 正本 standards/sw/build-sw-static.mjs のコピー'
};

test('正しく書けている木では何も報告しない（誤検知していない）', () => {
  assert.deepEqual(check(OK_TREE), []);
});

test('@supports のフォールバックの 100vh を誤検知しない', () => {
  const issues = check(OK_TREE);
  assert.equal(issues.filter(i => i.code === 'GIGA_VIEWPORT_100VH').length, 0);
});

test('コメントの中の localStorage / beforeinstallprompt を誤検知しない', () => {
  const issues = check(OK_TREE);
  assert.equal(issues.filter(i => i.code === 'GIGA_SW_LOCALSTORAGE').length, 0);
  assert.equal(issues.filter(i => i.code === 'GIGA_INSTALL_HOOK_INLINE').length, 0);
});

test('法務ファイルが無ければ拾う', () => {
  const tree = { ...OK_TREE };
  delete tree.LICENSE;
  assert.ok(codes(check(tree)).includes('GIGA_LEGAL_FILE_MISSING'));
});

test('ブラウザ内 Babel と Tailwind CDN を拾う', () => {
  const tree = {
    ...OK_TREE,
    'App.html': OK_TREE['App.html'] +
      '<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>' +
      '<script src="https://cdn.tailwindcss.com"></script>'
  };
  const found = codes(check(tree));
  assert.ok(found.includes('GIGA_BROWSER_BABEL'));
  assert.ok(found.includes('GIGA_TAILWIND_CDN'));
  assert.ok(found.includes('GIGA_CDN_EXECUTABLE'));
});

test('CDN から読む実行コードを拾い、Google Fonts は見逃す', () => {
  const tree = {
    ...OK_TREE,
    'App.html': OK_TREE['App.html'] +
      '<link href="https://fonts.googleapis.com/css2?family=X" rel="stylesheet">' +
      '<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">'
  };
  const found = check(tree).filter(i => i.code === 'GIGA_CDN_EXECUTABLE');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /cdn\.jsdelivr\.net/);
});

test('許可した宛先（apis.google.com）は拾わない', () => {
  const tree = {
    ...OK_TREE,
    'App.html': OK_TREE['App.html'] + '<script src="https://apis.google.com/js/api.js" async></script>'
  };
  const found = codes(check(tree, { allowedRemoteScripts: ['^https://apis\\.google\\.com/'] }));
  assert.ok(!found.includes('GIGA_CDN_EXECUTABLE'));
});

test('viewport-fit=cover の欠けを、HTML と .gs の両方で拾う', () => {
  const tree = {
    ...OK_TREE,
    'App.html': '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    'code.gs': "function doGet(){ return x.addMetaTag('viewport', 'width=device-width, initial-scale=1.0'); }"
  };
  const found = check(tree).filter(i => i.code === 'GIGA_VIEWPORT_FIT');
  assert.equal(found.length, 2);
  assert.deepEqual(found.map(i => i.file).sort(), ['App.html', 'code.gs']);
});

test('拡大の禁止を拾う', () => {
  const tree = {
    ...OK_TREE,
    'App.html': '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">'
  };
  assert.ok(codes(check(tree)).includes('GIGA_NO_ZOOM'));
});

test('100vh の単独使用を拾う', () => {
  const tree = { ...OK_TREE, 'App.html': OK_TREE['App.html'] + '<style>.shell { height: 100vh; }</style>' };
  assert.ok(codes(check(tree)).includes('GIGA_VIEWPORT_100VH'));
});

test('rt の色の決め打ちを拾う', () => {
  const tree = { ...OK_TREE, 'App.html': OK_TREE['App.html'] + '<style>rt { color: #666; }</style>' };
  assert.ok(codes(check(tree)).includes('GIGA_RT_COLOR'));
});

test('prefers-reduced-motion で 0 にしているのを拾う', () => {
  const tree = {
    ...OK_TREE,
    'App.html': OK_TREE['App.html'] +
      '<style>@media (prefers-reduced-motion: reduce) { * { animation-duration: 0s !important; } }</style>'
  };
  assert.ok(codes(check(tree)).includes('GIGA_REDUCED_MOTION_ZERO'));
});

test('SW の版が手書きに戻っていたら拾う', () => {
  // 手書きの版は「上げるのは人の仕事」で、上げ忘れても検査は何も言えない。
  // 2026-08-21 に12リポジトリで同時に上げ忘れる事故が起きたのがその形。
  const tree = {
    ...OK_TREE,
    'docs/sw.js': OK_TREE['docs/sw.js'].replace(
      "const APP_VERSION = 'v0'; /* __APP_VERSION__ */", "const APP_VERSION = 'v6';"),
  };
  assert.ok(codes(check(tree)).includes('GIGA_SW_VERSION_GENERATED'));
});

test('版の生成器が無ければ拾う', () => {
  const tree = { ...OK_TREE };
  delete tree['tools/build-sw.mjs'];
  assert.ok(codes(check(tree)).includes('GIGA_SW_VERSION_GENERATED'));
});

test('目印はコメントなので、コメント除去のあとで探してはいけない', () => {
  // 実際にここを間違えて、正しく書けている sw.js を「手書きに戻っている」と
  // 報告した。stripComments が /* __APP_VERSION__ */ を消すため
  assert.ok(!codes(check(OK_TREE)).includes('GIGA_SW_VERSION_GENERATED'));
});

test('sw.js の全キャッシュ削除を拾う（アロー関数で消していても）', () => {
  const tree = {
    ...OK_TREE,
    'docs/sw.js': `self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
});
self.addEventListener('message', (e) => { if (e.data.type === 'SKIP_WAITING') self.skipWaiting(); });`
  };
  assert.ok(codes(check(tree)).includes('GIGA_SW_CACHE_WIPE'));
});

test('install の中の skipWaiting を拾う', () => {
  const tree = {
    ...OK_TREE,
    'docs/sw.js': OK_TREE['docs/sw.js'].replace(
      "self.addEventListener('install', (event) => { event.waitUntil(caches.open('demo-v1')); });",
      "self.addEventListener('install', (event) => {\n  event.waitUntil(caches.open('demo-v1').then(() => self.skipWaiting()));\n});")
  };
  assert.ok(codes(check(tree)).includes('GIGA_SW_SKIP_WAITING'));
});

test('sw.js が localStorage を触っていたら拾う', () => {
  const tree = { ...OK_TREE, 'docs/sw.js': OK_TREE['docs/sw.js'] + "\nlocalStorage.setItem('x', '1');" };
  assert.ok(codes(check(tree)).includes('GIGA_SW_LOCALSTORAGE'));
});

test('offline.html が無ければ拾う', () => {
  const tree = { ...OK_TREE };
  delete tree['docs/offline.html'];
  assert.ok(codes(check(tree)).includes('GIGA_OFFLINE_HTML_MISSING'));
});

test('相対パス（./）はどちらの配信でも正しく解決されるので拾わない', () => {
  // './' は manifest の置き場所を基準に解決される。
  // 共有オリジンなら /Demo_App/、独自ドメインならサブドメイン直下。
  // どちらでも自分のアプリを指すので、取り違えは起きない。
  const tree = {
    ...OK_TREE,
    'docs/manifest.webmanifest': JSON.stringify({ id: './', scope: './', start_url: './' })
  };
  assert.deepEqual(check(tree).filter(i => i.code === 'GIGA_MANIFEST_PATH'), []);
});

test('別リポジトリ名のパスをコピーしたままなら拾う', () => {
  const tree = {
    ...OK_TREE,
    'docs/manifest.webmanifest': JSON.stringify({ id: '/Other_App/', scope: '/Other_App/', start_url: '/Other_App/' })
  };
  assert.equal(check(tree).filter(i => i.code === 'GIGA_MANIFEST_PATH').length, 3);
});

test('CNAME があるのにリポジトリ名の絶対パスのままなら拾う', () => {
  // 独自ドメインではアプリはサブドメイン直下に置かれる。
  // /Demo_App/ のままだと scope がページの URL を含まず、インストールできなくなる。
  const tree = {
    ...OK_TREE,
    'docs/CNAME': 'demo-app.giga-school.com\n',
    'docs/manifest.webmanifest': JSON.stringify({ id: '/Demo_App/', scope: '/Demo_App/', start_url: '/Demo_App/' })
  };
  assert.equal(check(tree).filter(i => i.code === 'GIGA_MANIFEST_PATH').length, 3);
});

test('CNAME があればサブドメイン直下（/）を拾わない', () => {
  const tree = {
    ...OK_TREE,
    'docs/CNAME': 'demo-app.giga-school.com\n',
    'docs/manifest.webmanifest': JSON.stringify({ id: '/', scope: '/', start_url: '/?source=pwa' })
  };
  assert.deepEqual(check(tree).filter(i => i.code === 'GIGA_MANIFEST_PATH'), []);
});

test('CNAME の BOM を拾う', () => {
  // 目に見えないので、テストで押さえておかないと二度と気づけない。
  const tree = {
    ...OK_TREE,
    'docs/CNAME': '﻿demo-app.giga-school.com\n',
    'docs/manifest.webmanifest': JSON.stringify({ id: './', scope: './', start_url: './' })
  };
  const found = check(tree).filter(i => i.code === 'GIGA_CNAME_BOM');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
});

test('正しい CNAME は拾わない', () => {
  const tree = {
    ...OK_TREE,
    'docs/CNAME': 'demo-app.giga-school.com\n',
    'docs/manifest.webmanifest': JSON.stringify({ id: './', scope: './', start_url: './' })
  };
  assert.deepEqual(check(tree).filter(i => i.code.startsWith('GIGA_CNAME')), []);
});

test('CNAME の書式まちがいを拾う', () => {
  for (const bad of ['https://demo-app.giga-school.com\n', 'demo-app.giga-school.com/\n', 'Demo-App.giga-school.com\n', 'localhost\n']) {
    const tree = {
      ...OK_TREE,
      'docs/CNAME': bad,
      'docs/manifest.webmanifest': JSON.stringify({ id: './', scope: './', start_url: './' })
    };
    assert.equal(check(tree).filter(i => i.code === 'GIGA_CNAME_FORMAT').length, 1, `見逃した: ${JSON.stringify(bad)}`);
  }
});

test('CNAME に 2 行以上あれば拾う', () => {
  const tree = {
    ...OK_TREE,
    'docs/CNAME': 'demo-app.giga-school.com\nwww.demo-app.giga-school.com\n',
    'docs/manifest.webmanifest': JSON.stringify({ id: './', scope: './', start_url: './' })
  };
  assert.equal(check(tree).filter(i => i.code === 'GIGA_CNAME_FORMAT').length, 1);
});

test('beforeinstallprompt をインラインで受けていたら拾う', () => {
  const tree = {
    ...OK_TREE,
    'docs/index.html': OK_TREE['docs/index.html'].replace(
      '<script>', "<script>window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); });")
  };
  assert.ok(codes(check(tree)).includes('GIGA_INSTALL_HOOK_INLINE'));
});

test('install-hook.js を読み込んでいなければ拾う', () => {
  const tree = {
    ...OK_TREE,
    'docs/index.html': OK_TREE['docs/index.html'].replace('<script src="install-hook.js"></script>', '')
  };
  assert.ok(codes(check(tree)).includes('GIGA_INSTALL_HOOK_MISSING'));
});

test('Service Worker 登録に readyState の分岐が無ければ拾う', () => {
  const tree = {
    ...OK_TREE,
    'docs/index.html': `<head><script src="install-hook.js"></script></head>
<body><img src="a.png" width="64" height="64">
<script>window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js'); });</script></body>`
  };
  assert.ok(codes(check(tree)).includes('GIGA_SW_REGISTER_READYSTATE'));
});

test('img に width/height が無ければ警告する', () => {
  const tree = {
    ...OK_TREE,
    'docs/index.html': OK_TREE['docs/index.html'].replace('<img src="a.png" width="64" height="64">', '<img src="a.png">')
  };
  const found = check(tree).filter(i => i.code === 'GIGA_IMG_SIZE');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warning');
});

test('生成物（Vendor_*.html）は表示の検査対象にしない', () => {
  const tree = { ...OK_TREE, 'Vendor_Bootstrap.html': '<style>.modal { height: 100vh; }</style>' };
  assert.deepEqual(check(tree), []);
});

test('stripComments はコメントだけを落とす', () => {
  assert.match(stripComments('/* localStorage */ const a = 1;'), /const a = 1;/);
  assert.doesNotMatch(stripComments('/* localStorage */ const a = 1;'), /localStorage/);
  assert.doesNotMatch(stripComments('// localStorage\nconst b = 2;'), /localStorage/);
  assert.doesNotMatch(stripComments('<!-- localStorage -->'), /localStorage/);
  // URL の // を壊さない
  assert.match(stripComments('const u = "https://example.com/x";'), /https:\/\/example\.com/);
});

// ---- 公開ページ（紹介ページ）のインストール導線 ----
//
// 公開ページをアプリ本体から紹介ページに差し替えたとき、
// iOS Safari の「ホーム画面に追加」がアプリではなくブックマークを作るようになった。
// 目に見える壊れ方をしない（ページは普通に開く）ので、検査で押さえておく。

test('正しい公開ページは拾わない', () => {
  assert.deepEqual(check(OK_TREE).filter(i => i.code.startsWith('GIGA_LANDING')), []);
});

test('公開ページに manifest が無ければ拾う', () => {
  const tree = {
    ...OK_TREE,
    'docs/about.html': OK_TREE['docs/about.html']
      .replace('<link rel="manifest" href="manifest.webmanifest">\n', '')
  };
  const found = check(tree).filter(i => i.code === 'GIGA_LANDING_NO_MANIFEST');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
});

test('コメントアウトされた manifest は「ある」と数えない', () => {
  const tree = {
    ...OK_TREE,
    'docs/about.html': OK_TREE['docs/about.html']
      .replace('<link rel="manifest" href="manifest.webmanifest">',
        '<!-- <link rel="manifest" href="manifest.webmanifest"> -->')
  };
  assert.ok(codes(check(tree)).includes('GIGA_LANDING_NO_MANIFEST'));
});

test('公開ページが install-hook.js を読んでいなければ拾う', () => {
  const tree = {
    ...OK_TREE,
    'docs/about.html': OK_TREE['docs/about.html'].replace('<script src="install-hook.js"></script>', '')
  };
  assert.ok(codes(check(tree)).includes('GIGA_LANDING_NO_INSTALL_HOOK'));
});

test('公開ページに apple-touch-icon が無ければ警告する', () => {
  const tree = {
    ...OK_TREE,
    'docs/about.html': OK_TREE['docs/about.html']
      .replace('<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">', '')
  };
  const found = check(tree).filter(i => i.code === 'GIGA_LANDING_NO_APPLE_ICON');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warning');
});

test('公開ページの apple-mobile-web-app-capable を拾う', () => {
  // 古い iOS では manifest を読まないため、この指定があると
  // 「紹介ページが枠なしで開くだけ」の行き止まりがホーム画面に出来る。
  const tree = {
    ...OK_TREE,
    'docs/about.html': OK_TREE['docs/about.html']
      .replace('<head>', '<head><meta name="apple-mobile-web-app-capable" content="yes">')
  };
  assert.ok(codes(check(tree)).includes('GIGA_LANDING_STANDALONE_META'));
});

test('「あえて書かない」と説明したコメントは拾わない', () => {
  const tree = {
    ...OK_TREE,
    'docs/about.html': OK_TREE['docs/about.html']
      .replace('<head>', '<head><!-- apple-mobile-web-app-capable はあえて書かない -->')
  };
  assert.deepEqual(check(tree).filter(i => i.code === 'GIGA_LANDING_STANDALONE_META'), []);
});

// ---- 中央寄せで文字が潰れる ----
//
// 実際に「ホーム画面に追加」の案内が iPhone で縦一列の帯になり、読めなくなっていた。
// 要素は出ていて色も形も正しいので、目視では見落とす。

test('left:50% + translateX(-50%) で幅を決めていなければ拾う', () => {
  const tree = {
    ...OK_TREE,
    'App.html': OK_TREE['App.html'] + `<style>
#banner { position: fixed; left: 50%; transform: translateX(-50%); bottom: 12px; max-width: 560px; }
</style>`
  };
  const found = check(tree).filter(i => i.code === 'GIGA_FIXED_CENTER_SQUEEZE');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
});

test('max-width だけでは「幅を決めた」ことにならない', () => {
  // max-width は上限を決めるだけで、使える幅（包む枠 − left）は半分のまま。
  const tree = {
    ...OK_TREE,
    'App.html': OK_TREE['App.html'] + `<style>
#toast { position: absolute; left: 50%; transform: translateX(-50%); max-width: calc(100vw - 24px); }
</style>`
  };
  assert.ok(codes(check(tree)).includes('GIGA_FIXED_CENTER_SQUEEZE'));
});

test('left と right の両方を決めていれば拾わない', () => {
  const tree = {
    ...OK_TREE,
    'App.html': OK_TREE['App.html'] + `<style>
#banner { position: fixed; left: 12px; right: 12px; margin: 0 auto; max-width: 560px; }
</style>`
  };
  assert.deepEqual(check(tree).filter(i => i.code === 'GIGA_FIXED_CENTER_SQUEEZE'), []);
});

test('width を決めてあれば拾わない', () => {
  const tree = {
    ...OK_TREE,
    'App.html': OK_TREE['App.html'] + `<style>
#banner { position: fixed; left: 50%; transform: translateX(-50%); width: 320px; }
</style>`
  };
  assert.deepEqual(check(tree).filter(i => i.code === 'GIGA_FIXED_CENTER_SQUEEZE'), []);
});

test('position を指定していない中央寄せは拾わない', () => {
  const tree = {
    ...OK_TREE,
    'App.html': OK_TREE['App.html'] + `<style>
.centered { left: 50%; transform: translateX(-50%); }
</style>`
  };
  assert.deepEqual(check(tree).filter(i => i.code === 'GIGA_FIXED_CENTER_SQUEEZE'), []);
});
