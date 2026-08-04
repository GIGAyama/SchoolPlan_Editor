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
  'docs/index.html': `<head><script src="install-hook.js"></script></head>
<body><img src="a.png" width="64" height="64">
<script>
// Safari には beforeinstallprompt が無いので、メニューに常時出す
if (document.readyState === 'complete') navigator.serviceWorker.register('sw.js');
else window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js'); });
</script></body>`,
  'docs/sw.js': `const CACHE_PREFIX = 'demo-';
// localStorage は一切操作しない
self.addEventListener('install', (event) => { event.waitUntil(caches.open('demo-v1')); });
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => caches.delete(k)))));
});
self.addEventListener('message', (e) => { if (e.data.type === 'SKIP_WAITING') self.skipWaiting(); });`
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

test('manifest の id/scope/start_url が相対のままなら拾う', () => {
  const tree = {
    ...OK_TREE,
    'docs/manifest.webmanifest': JSON.stringify({ id: './', scope: './', start_url: './' })
  };
  const found = check(tree).filter(i => i.code === 'GIGA_MANIFEST_PATH');
  assert.equal(found.length, 3);
});

test('別リポジトリ名のパスをコピーしたままなら拾う', () => {
  const tree = {
    ...OK_TREE,
    'docs/manifest.webmanifest': JSON.stringify({ id: '/Other_App/', scope: '/Other_App/', start_url: '/Other_App/' })
  };
  assert.equal(check(tree).filter(i => i.code === 'GIGA_MANIFEST_PATH').length, 3);
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
