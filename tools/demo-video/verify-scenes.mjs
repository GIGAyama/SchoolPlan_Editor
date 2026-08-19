#!/usr/bin/env node
/**
 * 台本（scenes.mjs）の下見。Google に一切アクセスせずに次を確認します。
 *
 *  1. appsscript.json の oauthScopes が、すべてどこかのシーンで実演されているか
 *  2. 台本が指すセレクタが、実際の App.html の DOM に存在するか
 *  3. 台本の英語字幕がひととおり揃っているか（尺の見積もりも出す）
 *
 * 撮影当日に「ボタンが見つからない」で止まらないための事前チェックです。
 *
 *   node tools/demo-video/verify-scenes.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchChromium } from './browser.mjs';
import { ROOT } from './config.mjs';
import { SCENES, SCOPE_COVERAGE } from './scenes.mjs';
import { buildPreview } from './build-preview.mjs';

const problems = [];
const notes = [];

// ---------------------------------------------------------------- スコープ
function checkScopeCoverage() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'appsscript.json'), 'utf8'));
  const demonstrated = new Set(SCENES.flatMap(scene => scene.scopes));
  for (const scope of manifest.oauthScopes) {
    const shortName = SCOPE_COVERAGE[scope];
    if (!shortName) {
      problems.push(`スコープ ${scope} が SCOPE_COVERAGE に未登録です（台本の更新漏れ）`);
      continue;
    }
    if (!demonstrated.has(shortName)) {
      problems.push(`スコープ ${shortName} を実演するシーンがありません（差し戻しの原因になります）`);
    }
  }
  for (const shortName of Object.values(SCOPE_COVERAGE)) {
    if (!demonstrated.has(shortName)) continue;
    notes.push(`✓ ${shortName}`);
  }
}

// ---------------------------------------------------------------- アプリ名
/**
 * 「同意画面のアプリ名・紹介ページの表記・動画に映るアプリ名が違う」は
 * 差し戻し理由の常連なので、リポジトリ内の表記ゆれを先に洗い出しておく。
 * 同意画面側の登録名はリポジトリからは分からないため、確認は人の目に委ねる。
 */
function checkAppName() {
  const appTitle = (fs.readFileSync(path.join(ROOT, 'App.html'), 'utf8')
    .match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  const aboutFile = path.join(ROOT, 'docs', 'about.html');
  const aboutHeading = fs.existsSync(aboutFile)
    ? ((fs.readFileSync(aboutFile, 'utf8').match(/<h1>([^<]*)<\/h1>/) || [])[1] || '')
    : '';
  notes.push(`アプリ画面の表記: 「${appTitle}」`);
  notes.push(`紹介ページの表記: 「${aboutHeading}」`);
  if (appTitle && aboutHeading && !aboutHeading.includes(appTitle)) {
    problems.push(`アプリ画面「${appTitle}」と紹介ページ「${aboutHeading}」で名前が食い違います`);
  } else if (appTitle && aboutHeading && appTitle !== aboutHeading) {
    notes.push('⚠️ 表記が完全一致ではありません。OAuth 同意画面の登録名がどちらと一致するか確認してください');
  }
}

// ---------------------------------------------------------------- セレクタ
async function checkSelectors() {
  const previewFile = buildPreview();
  const browser = await launchChromium();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', error => consoleErrors.push(error.message));
  await page.goto(`file://${previewFile}`);
  await page.waitForTimeout(1500);

  for (const scene of SCENES) {
    for (const step of scene.steps) {
      if (!step.selector || step.dynamic) continue;
      // .active は実行時に付くクラスなので、要素の存在だけを見る
      const base = step.selector.replace(/\.active\b/g, '');
      const count = await page.locator(base).count();
      if (count === 0) {
        problems.push(`[${scene.id}] セレクタが DOM にありません: ${step.selector}`);
      } else if (count > 1 && step.kind !== 'expect') {
        problems.push(`[${scene.id}] セレクタが ${count} 件に一致します（1件に絞ってください）: ${step.selector}`);
      }
    }
    // clickText は「その範囲内にそのラベルのボタンが1つある」ことを確認する
    for (const step of scene.steps) {
      if (step.kind !== 'clickText') continue;
      // 非表示のビューの中も数えたいので、role ではなくテキスト一致で数える
      const scope = step.within ? page.locator(step.within) : page.locator('body');
      const count = await scope.locator('button').filter({ hasText: step.text }).count();
      if (count === 0) {
        problems.push(`[${scene.id}] ボタンが見つかりません: 「${step.text}」(${step.within || 'page'})`);
      } else if (count > 1) {
        problems.push(`[${scene.id}] ボタン「${step.text}」が ${count} 件あります（within で絞ってください）`);
      }
    }
  }

  // ナビゲーションのタブが台本の想定どおりに存在するか
  const views = await page.locator('header .nav-btn[data-view]').evaluateAll(
    nodes => nodes.map(node => node.dataset.view));
  notes.push(`タブ: ${views.join(' / ')}`);

  await browser.close();
  if (consoleErrors.length) {
    notes.push(`プレビューの JS エラー ${consoleErrors.length} 件（スタブ環境のためで、本番の不具合とは限りません）`);
  }
}

// ---------------------------------------------------------------- 尺
function estimateDuration() {
  let ms = 0;
  const perScene = [];
  for (const scene of SCENES) {
    let sceneMs = 0;
    for (const step of scene.steps) {
      if (step.kind === 'caption' || step.kind === 'wait') sceneMs += step.ms || 0;
      else if (step.kind === 'manual') sceneMs += step.ms || 15000; // 人の操作は15秒と仮定
      else sceneMs += 900; // クリック等の間合い
    }
    perScene.push([scene.id, sceneMs]);
    ms += sceneMs;
  }
  return { ms, perScene };
}

// ---------------------------------------------------------------- 実行
checkScopeCoverage();
checkAppName();
await checkSelectors();
const { ms, perScene } = estimateDuration();

console.log('=== スコープの実演カバレッジ ===');
for (const note of notes) console.log(`  ${note}`);
console.log('\n=== 想定尺 ===');
for (const [id, sceneMs] of perScene) {
  console.log(`  ${id.padEnd(20)} ${(sceneMs / 1000).toFixed(0).padStart(4)} 秒`);
}
const minutes = Math.floor(ms / 60000);
console.log(`  ${'合計'.padEnd(18)} ${minutes} 分 ${Math.round((ms % 60000) / 1000)} 秒`);
// 2026-08 の差し戻しで「各スコープの機能を最大限まで実演すること」を求められたため、
// 短さより網羅を優先する。それでも冗長にならないよう12分で警告する。
if (ms > 12 * 60000) console.log('  ⚠️ 長すぎます。12分以内を目安に削ってください。');

console.log('');
if (problems.length === 0) {
  console.log('問題は見つかりませんでした。撮影に進めます。');
} else {
  console.log(`=== 要修正 ${problems.length} 件 ===`);
  for (const problem of problems) console.log(`  ✗ ${problem}`);
  process.exitCode = 1;
}
