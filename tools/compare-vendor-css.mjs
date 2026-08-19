#!/usr/bin/env node
/**
 * 同梱ライブラリ（Bootstrap など）の版を上げたときに、画面の見た目が変わっていないかを
 * 実ブラウザで確かめる。
 *
 * ## なぜ要るか
 *
 * Vendor_*.html は生成物なので、版を上げると1行の差分に見える。だが中身は
 * アプリ全体に効く CSS で、実際に何が変わるかは minify された文字列を読んでも分からない。
 * AUDIT.md の D8 が記録しているとおり、このアプリの配色は Bootstrap の既定色と
 * 干渉する箇所があり、「patch 版だから安全」とは言い切れない。
 *
 * そこで**同じ DOM を新旧2つの CSS で描いて、全要素の計算後スタイルを比べる**。
 * minify された CSS を読む必要がなく、見た目に出る差だけが残る。
 * （AUDIT.md §7-3 の「GAS が返す画面を手元で組み立てて実ブラウザで測る」手法と同じ考え方）
 *
 * ## 使い方
 *
 *   # 1. いまの生成物を退避してから、新しい版で作り直す
 *   cp Vendor_Bootstrap.html /tmp/Vendor_Bootstrap_old.html
 *   npm install && npm run build:vendor -- bootstrap
 *
 *   # 2. 旧版と比べる
 *   node tools/compare-vendor-css.mjs Vendor_Bootstrap /tmp/Vendor_Bootstrap_old.html
 *
 * 差分 0 件なら、その版上げは画面に影響しない。差分が出たら、その箇所を目で確かめること。
 *
 * ## 気をつけること
 *
 * **「差分 0 件」を鵜呑みにしない。** 比較そのものが壊れていても 0 件になる。
 * `--self-test` を付けると、わざと1行足した CSS を検出できるかを先に確かめてから比較する。
 * 迷ったら必ず付けること。
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 見た目に出るものを中心に。全プロパティを見ると、意味のない差（内部的な計算値）で埋まる。
const PROPS = [
  'color', 'background-color', 'border-top-color', 'border-bottom-color',
  'border-top-width', 'border-radius', 'font-size', 'font-weight', 'font-family',
  'line-height', 'padding-top', 'padding-left', 'margin-top', 'margin-left',
  'width', 'height', 'display', 'position', 'opacity', 'box-shadow', 'text-align'
];

const args = process.argv.slice(2);
const selfTest = args.includes('--self-test');
const [vendorName, oldFile] = args.filter(a => a !== '--self-test');

if (!vendorName || !oldFile) {
  console.error('使い方: node tools/compare-vendor-css.mjs <Vendor名> <比較対象のHTML> [--self-test]');
  console.error('  例: node tools/compare-vendor-css.mjs Vendor_Bootstrap /tmp/Vendor_Bootstrap_old.html');
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'vendor-css-'));

/** App.html の include を実体に置き換えて1枚の HTML にする。 */
function buildStandalone(outPath, replacement) {
  let html = readFileSync(join(ROOT, 'App.html'), 'utf8');
  html = html.replace(/<\?!=\s*include\('([^']+)'\);?\s*\?>/g, (_, name) => {
    const file = (name === vendorName && replacement) ? replacement : join(ROOT, name + '.html');
    return readFileSync(file, 'utf8');
  });
  html = html.replace(/<\?=\s*PWA_SHELL_URL\s*\?>/g, 'https://example.invalid/');
  // サーバー呼び出しはダミーにして、本編の描画まで進める
  html = html.replace('</head>', `<script>
    window.google = { script: {
      run: new Proxy({}, { get: function () { return function () { return window.google.script.run; }; } }),
      host: { close: function () {} }
    } };
  </script></head>`);
  writeFileSync(outPath, html);
  return outPath;
}

async function snapshot(browser, file, colorScheme) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme });
  const page = await context.newPage();
  page.on('pageerror', () => { /* サーバー無しで動かすので例外は出る。描画には影響しない */ });
  await page.goto('file://' + file);
  await page.waitForTimeout(1200);
  const data = await page.evaluate((props) => {
    const out = {};
    const els = document.querySelectorAll('body *');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const cs = getComputedStyle(el);
      const key = i + '|' + el.tagName + '|' + (el.id || '') + '|' + String(el.className || '').slice(0, 60);
      const vals = {};
      for (const p of props) vals[p] = cs.getPropertyValue(p);
      out[key] = vals;
    }
    return out;
  }, PROPS);
  await context.close();
  return data;
}

function diffOf(before, after) {
  const diffs = [];
  for (const key of Object.keys(before)) {
    if (!after[key]) continue;
    for (const p of PROPS) {
      if (before[key][p] !== after[key][p]) {
        diffs.push({ key, prop: p, before: before[key][p], after: after[key][p] });
      }
    }
  }
  return diffs;
}

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

try {
  const current = buildStandalone(join(work, 'current.html'), null);
  const previous = buildStandalone(join(work, 'previous.html'), resolve(oldFile));

  if (selfTest) {
    // 検出できることを先に確かめる。ここが 0 件なら、比較が壊れている。
    const injected = readFileSync(resolve(oldFile), 'utf8')
      .replace('</style>', '.btn{color:#ff00ff}\n</style>');
    const controlFile = join(work, 'control-vendor.html');
    writeFileSync(controlFile, injected);
    const control = buildStandalone(join(work, 'control.html'), controlFile);
    const found = diffOf(await snapshot(browser, previous, 'light'),
      await snapshot(browser, control, 'light'));
    if (found.length === 0) {
      console.error('自己テストに失敗しました。わざと入れた差を検出できていないので、'
        + 'この比較結果は信用できません。');
      process.exit(1);
    }
    console.log(`自己テスト: わざと入れた1行を ${found.length} 件として検出できました。比較は機能しています。\n`);
  }

  let total = 0;
  for (const theme of ['light', 'dark']) {
    const before = await snapshot(browser, previous, theme);
    const after = await snapshot(browser, current, theme);
    const diffs = diffOf(before, after);
    total += diffs.length;

    console.log(`===== ${theme} : 要素 ${Object.keys(before).length} 個 / 差分 ${diffs.length} 件 =====`);
    const byProp = {};
    for (const d of diffs) byProp[d.prop] = (byProp[d.prop] || 0) + 1;
    if (diffs.length) console.log('  プロパティ別:', JSON.stringify(byProp));
    for (const d of diffs.slice(0, 30)) {
      console.log(`  ${d.key.split('|').slice(1).join(' ').trim()}`);
      console.log(`    ${d.prop}: ${d.before}  →  ${d.after}`);
    }
    if (diffs.length > 30) console.log(`  …ほか ${diffs.length - 30} 件`);
  }

  console.log(total === 0
    ? '\n見た目に出る差はありませんでした。'
    : `\n差分が ${total} 件あります。該当箇所を目で確かめてください。`);
} finally {
  await browser.close();
}
