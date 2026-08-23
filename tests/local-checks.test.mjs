/**
 * このリポジトリだけの検査（scripts/lib/local-checks.mjs）自身のテスト。
 *
 * なぜ要るか：
 *   「0件でした」だけでは、検査が動いているのか何も見ていないのか区別できない。
 *   わざと壊した木を作って、ちゃんと拾えることを確かめる。
 *   逆に、正しく書いてあるものを誤って拾わないことも確かめる
 *   （実際、コメントの文言で誤検知したことがある）。
 *
 * 共通の検査は正本（GIGAyama.github.io/standards/lib/giga-v5-checks.mjs）が
 * 受け持ち、そのテストは正本と同じ場所にある（91件）。ここにあるのは、
 * 正本に行き先が無くてこのリポジトリに残した検査の分だけである。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runLocalChecks } from '../scripts/lib/local-checks.mjs';

function makeTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-checks-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

const check = (files) => runLocalChecks(makeTree(files));
/** 落ちた検査の id だけを取り出す */
const failed = (files) => check(files).filter((r) => !r.ok).map((r) => r.id);
const find = (files, id) => check(files).find((r) => r.id === id);

// 最低限そろっている木（これを基準に、1つずつ壊す）
const OK_TREE = {
  'docs/sw.js': "self.addEventListener('install', () => {});",
  'docs/install-hook.js': 'window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); });',
  'docs/index.html': `<head><script src="install-hook.js"></script></head>
<body><img src="a.png" width="64" height="64">
<script>
// Safari には beforeinstallprompt が無いので、メニューに常時出す
if (document.readyState === 'complete') navigator.serviceWorker.register('sw.js');
</script></body>`,
  // 紹介ページ（ポータル・OAuth のホームページ欄からの入口）。
  // アプリ本体と同じ manifest とアイコンを持ち、インストールの合図も受ける。
  'docs/about.html': `<head><script src="install-hook.js"></script>
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png"></head>
<body><a href="./">アプリを開く</a></body>`,
  'docs/offline.html': '<p>つながっていません</p>',
  'App.html': '<div id="app"></div>',
};

test('正しく書けている木では何も落ちない（誤検知していない）', () => {
  assert.deepEqual(failed(OK_TREE), []);
});

// ---- 実体の有無（正本は「読み込んでいるか」しか見ない） ----

test('sw.js が無ければ拾う', () => {
  const tree = { ...OK_TREE };
  delete tree['docs/sw.js'];
  assert.ok(failed(tree).includes('E_SW_EXISTS'));
});

test('install-hook.js の実体が無ければ拾う', () => {
  const tree = { ...OK_TREE };
  delete tree['docs/install-hook.js'];
  assert.ok(failed(tree).includes('E3_INSTALL_HOOK_FILE'));
});

test('beforeinstallprompt をインラインで受けていたら拾う', () => {
  const tree = {
    ...OK_TREE,
    'docs/index.html': OK_TREE['docs/index.html'].replace(
      '<script>', "<script>window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); });"),
  };
  assert.ok(failed(tree).includes('INSTALL_HOOK_INLINE'));
});

test('コメントの中の beforeinstallprompt は「インラインで受けている」と数えない', () => {
  // OK_TREE の入口にはすでに「Safari には beforeinstallprompt が無いので」という
  // 注意書きが入っている。語だけで拾うと、この一行で毎回落ちる。
  assert.equal(find(OK_TREE, 'INSTALL_HOOK_INLINE').ok, true);
});

// ---- 公開ページ（紹介ページ）のインストール導線 ----
//
// 公開ページをアプリ本体から紹介ページに差し替えたとき、
// iOS Safari の「ホーム画面に追加」がアプリではなくブックマークを作るようになった。
// 目に見える壊れ方をしない（ページは普通に開く）ので、検査で押さえておく。

test('紹介ページに manifest が無ければ拾う', () => {
  const tree = {
    ...OK_TREE,
    'docs/about.html': OK_TREE['docs/about.html']
      .replace('<link rel="manifest" href="manifest.webmanifest">\n', ''),
  };
  const found = find(tree, 'LANDING_MANIFEST');
  assert.equal(found.ok, false);
  assert.equal(found.severity, 'P1');
});

test('コメントアウトされた manifest は「ある」と数えない', () => {
  const tree = {
    ...OK_TREE,
    'docs/about.html': OK_TREE['docs/about.html']
      .replace('<link rel="manifest" href="manifest.webmanifest">',
        '<!-- <link rel="manifest" href="manifest.webmanifest"> -->'),
  };
  assert.ok(failed(tree).includes('LANDING_MANIFEST'));
});

test('紹介ページが install-hook.js を読んでいなければ拾う', () => {
  const tree = {
    ...OK_TREE,
    'docs/about.html': OK_TREE['docs/about.html'].replace('<script src="install-hook.js"></script>', ''),
  };
  assert.ok(failed(tree).includes('LANDING_INSTALL_HOOK'));
});

test('紹介ページに apple-touch-icon が無ければ警告する', () => {
  const tree = {
    ...OK_TREE,
    'docs/about.html': OK_TREE['docs/about.html']
      .replace('<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">', ''),
  };
  const found = find(tree, 'LANDING_APPLE_ICON');
  assert.equal(found.ok, false);
  assert.equal(found.severity, 'P2');
});

test('紹介ページの apple-mobile-web-app-capable を拾う', () => {
  // 古い iOS では manifest を読まないため、この指定があると
  // 「紹介ページが枠なしで開くだけ」の行き止まりがホーム画面に出来る。
  const tree = {
    ...OK_TREE,
    'docs/about.html': OK_TREE['docs/about.html']
      .replace('<head>', '<head><meta name="apple-mobile-web-app-capable" content="yes">'),
  };
  assert.ok(failed(tree).includes('LANDING_STANDALONE_META'));
});

test('「あえて書かない」と説明したコメントは拾わない', () => {
  const tree = {
    ...OK_TREE,
    'docs/about.html': OK_TREE['docs/about.html']
      .replace('<head>', '<head><!-- apple-mobile-web-app-capable はあえて書かない -->'),
  };
  assert.equal(find(tree, 'LANDING_STANDALONE_META').ok, true);
});

test('紹介ページが無いリポジトリでは紹介ページの検査を出さない', () => {
  const tree = { ...OK_TREE };
  delete tree['docs/about.html'];
  assert.deepEqual(check(tree).filter((r) => r.id.startsWith('LANDING')), []);
});

// ---- 中央寄せで文字が潰れる ----
//
// 実際に「ホーム画面に追加」の案内が iPhone で縦一列の帯になり、読めなくなっていた。
// 要素は出ていて色も形も正しいので、目視では見落とす。

test('left:50% + translateX(-50%) で幅を決めていなければ拾う', () => {
  const tree = {
    ...OK_TREE,
    'docs/index.html': OK_TREE['docs/index.html'] + `<style>
#banner { position: fixed; left: 50%; transform: translateX(-50%); bottom: 12px; max-width: 560px; }
</style>`,
  };
  const found = find(tree, 'FIXED_CENTER_SQUEEZE');
  assert.equal(found.ok, false);
  assert.equal(found.severity, 'P1');
});

test('max-width だけでは「幅を決めた」ことにならない', () => {
  // max-width は上限を決めるだけで、使える幅（包む枠 − left）は半分のまま。
  const tree = {
    ...OK_TREE,
    'docs/about.html': OK_TREE['docs/about.html'] + `<style>
#toast { position: absolute; left: 50%; transform: translateX(-50%); max-width: calc(100vw - 24px); }
</style>`,
  };
  assert.ok(failed(tree).includes('FIXED_CENTER_SQUEEZE'));
});

test('GAS 本体側の HTML（App*.html）も見る', () => {
  // このリポジトリは CSS も .html に入れて GAS に置いている（App_Css.html）。
  // docs/ だけ見ていると、先生が実際に使う画面の側を素通りする。
  const tree = {
    ...OK_TREE,
    'App_Css.html': `<style>
#banner { position: fixed; left: 50%; transform: translateX(-50%); }
</style>`,
  };
  const found = find(tree, 'FIXED_CENTER_SQUEEZE');
  assert.equal(found.ok, false);
  assert.match(found.detail, /App_Css\.html/);
});

test('取り込んだ配布物（Vendor_*.html）は見ない', () => {
  const tree = {
    ...OK_TREE,
    'Vendor_Bootstrap.html': `<style>
.tooltip { position: absolute; left: 50%; transform: translateX(-50%); }
</style>`,
  };
  assert.equal(find(tree, 'FIXED_CENTER_SQUEEZE').ok, true);
});

test('left と right の両方を決めていれば拾わない', () => {
  const tree = {
    ...OK_TREE,
    'docs/index.html': OK_TREE['docs/index.html'] + `<style>
#banner { position: fixed; left: 12px; right: 12px; margin: 0 auto; max-width: 560px; }
</style>`,
  };
  assert.equal(find(tree, 'FIXED_CENTER_SQUEEZE').ok, true);
});

test('width を決めてあれば拾わない', () => {
  const tree = {
    ...OK_TREE,
    'docs/index.html': OK_TREE['docs/index.html'] + `<style>
#banner { position: fixed; left: 50%; transform: translateX(-50%); width: 320px; }
</style>`,
  };
  assert.equal(find(tree, 'FIXED_CENTER_SQUEEZE').ok, true);
});

test('position を指定していない中央寄せは拾わない', () => {
  const tree = {
    ...OK_TREE,
    'docs/index.html': OK_TREE['docs/index.html'] + `<style>
.centered { left: 50%; transform: translateX(-50%); }
</style>`,
  };
  assert.equal(find(tree, 'FIXED_CENTER_SQUEEZE').ok, true);
});

test('コメントの中の中央寄せは拾わない', () => {
  const tree = {
    ...OK_TREE,
    'docs/index.html': OK_TREE['docs/index.html'] + `<!--
かつてこう書いていて潰れた: #banner { position: fixed; left: 50%; transform: translateX(-50%); }
-->`,
  };
  assert.equal(find(tree, 'FIXED_CENTER_SQUEEZE').ok, true);
});
