#!/usr/bin/env node
/**
 * オフライン下見用のプレビュー HTML を組み立てる。
 *
 * App.html の `<?!= include('X'); ?>` を X.html の中身に置き換え、
 * `google.script.run` をサーバへ行かないスタブに差し替えたものを出力します。
 *
 * ⚠️ これは **セレクタ検証と動線の下見にだけ** 使うものです。
 *    Google の OAuth 審査では「本番デプロイ済みのアプリで撮ること」が要件なので、
 *    この出力を録画して提出してはいけません（差し戻しになります）。
 *
 *   node tools/demo-video/build-preview.mjs
 *   → dist/demo-preview/index.html
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

// dist/ は .gitignore 済みで、品質チェックの走査対象からも外れている
const OUT_DIR = path.join(ROOT, 'dist', 'demo-preview');
const OUT_FILE = path.join(OUT_DIR, 'index.html');

/** google.script.run のスタブ。ハンドラは呼ばず、呼び出し履歴だけ残す */
const STUB = `
<script>
// ---- オフライン下見用スタブ（本番には存在しません）----------------------
window.__DEMO_PREVIEW__ = true;
window.__serverCalls = [];
(function () {
  function makeRunner() {
    var runner = new Proxy(function () {}, {
      get: function (target, prop) {
        if (prop === 'withSuccessHandler' || prop === 'withFailureHandler' ||
            prop === 'withUserObject') {
          return function () { return runner; };
        }
        return function () {
          window.__serverCalls.push(String(prop));
          // ハンドラを呼ばない = 画面は「読み込み中」のまま止まる。
          // 静的マークアップのセレクタ検証にはこれで十分で、
          // 偽のデータを画面に出してしまう事故も防げる。
        };
      },
      apply: function () { return runner; },
    });
    return runner;
  }
  window.google = window.google || {};
  window.google.script = { run: makeRunner(), host: { close: function () {} },
                           url: { getLocation: function (cb) { cb({ parameter: {} }); } } };
})();
</script>
`;

function inlineIncludes(html) {
  return html.replace(/<\?!=\s*include\('([^']+)'\);?\s*\?>/g, (whole, name) => {
    const file = path.join(ROOT, `${name}.html`);
    if (!fs.existsSync(file)) throw new Error(`include の対象が見つかりません: ${name}.html`);
    return fs.readFileSync(file, 'utf8');
  });
}

export function buildPreview() {
  const source = fs.readFileSync(path.join(ROOT, 'App.html'), 'utf8');
  let html = inlineIncludes(source);

  // include 以外のスクリプトレット（`<?= PWA_SHELL_URL ?>` など）はサーバ側の値なので
  // オフラインでは決まらない。空文字にして、静的なマークアップだけを残す。
  html = html.replace(/<\?[\s\S]*?\?>/g, '');

  // 残ったスクリプトレットだけを弾く。`Promise<?Array>` のような JSDoc は
  // `<?` に続く文字が `!`・`=`・空白ではないので誤検知しない。
  if (/<\?[!=\s]/.test(html)) throw new Error('置き換えられていない GAS テンプレート構文が残っています');

  // apis.google.com の Picker はオフラインでは読めないので外す
  html = html.replace(/<script[^>]*apis\.google\.com[^>]*><\/script>/g, '');
  // スタブは他のスクリプトより先に読ませる
  html = html.replace('</head>', `${STUB}</head>`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, html, 'utf8');
  return OUT_FILE;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = buildPreview();
  const size = (fs.statSync(file).size / 1024).toFixed(0);
  console.log(`プレビューを書き出しました: ${path.relative(ROOT, file)} (${size} KB)`);
  console.log('※ 下見・セレクタ検証専用です。提出用の録画には使えません。');
}
