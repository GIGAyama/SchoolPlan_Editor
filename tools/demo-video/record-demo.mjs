#!/usr/bin/env node
/**
 * OAuth 審査用デモ動画の撮影ドライバ。
 *
 * scenes.mjs の台本どおりにブラウザを操作し、画面を録画し、
 * 実際の時刻から英語字幕（.srt）を書き出します。
 *
 *   node tools/demo-video/record-demo.mjs                 本番撮影
 *   node tools/demo-video/record-demo.mjs --dry-run       操作せず段取りだけ表示
 *   node tools/demo-video/record-demo.mjs --scene=classroom  1シーンだけ撮り直す
 *   node tools/demo-video/record-demo.mjs --no-capture    録画せず動線だけ確認
 *
 * 事前に必要なもの:
 *   - ffmpeg（画面録画。アドレスバーを映すために必須）
 *   - 撮影用の Google アカウントで、https://myaccount.google.com/permissions から
 *     このアプリのアクセス権を削除しておくこと（でないと同意画面が出ません）
 *   - 環境変数 DEMO_SHEET_URL（撮影用スプレッドシート）
 *
 * 自動化しないところ:
 *   Google のログイン・同意・Gmail・Classroom の操作は人が行います。
 *   Google は自動操作のログインを拒否しますし、同意は本人が行った本物である
 *   必要があるためです。該当箇所で一時停止し、Enter で再開します。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import process from 'node:process';
import { launchChromium } from './browser.mjs';
import { expand, missingUrls, resolveUrls, ROOT } from './config.mjs';
import { SCENES } from './scenes.mjs';
import { findFfmpeg, startCapture } from './capture.mjs';
import { INSTALL_SCRIPT, mayInject } from './overlay.mjs';
import { buildSrt } from './srt.mjs';

const argv = process.argv.slice(2);
const hasFlag = name => argv.includes(`--${name}`);
const getOption = name => {
  const found = argv.find(item => item.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : '';
};

const DRY_RUN = hasFlag('dry-run');
// 字幕は原則 .srt で載せる（YouTube にそのまま上げられる）。
// --overlay を付けたときだけ、画面にも英文を焼き込む。
const OVERLAY = hasFlag('overlay');
const NO_CAPTURE = hasFlag('no-capture') || DRY_RUN;
const ONLY_SCENE = getOption('scene');
const OUT_DIR = path.join(ROOT, getOption('out') || 'dist/demo-video');
const WIDTH = 1920;
const HEIGHT = 1080;

const urls = resolveUrls();
const scenes = ONLY_SCENE ? SCENES.filter(scene => scene.id === ONLY_SCENE) : SCENES;
if (scenes.length === 0) {
  console.error(`--scene=${ONLY_SCENE} に一致するシーンがありません`);
  process.exit(1);
}

const missing = missingUrls(urls, { requireSheet: scenes.some(s => s.steps.some(step => String(step.url).includes('SHEET'))) });
if (missing.length && !DRY_RUN) {
  console.error('撮影に必要な URL が足りません:');
  for (const item of missing) console.error(`  - ${item}`);
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const cues = [];
const failures = [];
let started = 0;
// --dry-run では実時間が進まないので、台本上の想定尺を積み上げて代わりに使う
let virtualMs = 0;
const elapsed = () => (DRY_RUN ? virtualMs : Date.now() - started);
const advance = ms => { virtualMs += ms; };

// ---------------------------------------------------------------- ページ操作

/**
 * GAS の Web アプリは、ユーザーの HTML をサンドボックス iframe の中に描画します。
 * そのため #view-plan などは常に「入れ子のフレーム」の側にあります。
 * ここでアプリ本体が居るフレームを探します。
 */
async function appFrame(page) {
  for (const frame of page.frames()) {
    if (await frame.locator('#app').count().catch(() => 0)) return frame;
  }
  return page.mainFrame();
}

async function withOverlay(page, fn) {
  if (!mayInject(page.url())) return null;
  try {
    return await fn();
  } catch {
    return null; // 遷移中などで差し込めなくても撮影は続ける
  }
}

async function installOverlay(page) {
  await withOverlay(page, () => page.evaluate(INSTALL_SCRIPT));
}

async function showCaption(page, text) {
  if (!OVERLAY) return; // 既定では .srt にだけ残し、映像には焼き込まない
  await withOverlay(page, () => page.evaluate(t => window.__demoCaption?.(t), text));
}

function log(scene, message) {
  const seconds = (elapsed() / 1000).toFixed(1).padStart(6);
  console.log(`[${seconds}s] ${scene.id.padEnd(18)} ${message}`);
}

// ---------------------------------------------------------------- ステップ

async function runStep(page, scene, step) {
  switch (step.kind) {
    case 'goto': {
      const url = expand(step.url, urls, { allowMissing: DRY_RUN });
      log(scene, `移動: ${url}`);
      if (DRY_RUN) return advance(1500);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1500);
      await installOverlay(page);
      return;
    }
    case 'caption': {
      log(scene, `字幕: ${step.text.slice(0, 60)}…`);
      const startMs = elapsed();
      if (DRY_RUN) advance(step.ms);
      else {
        await showCaption(page, step.text);
        await page.waitForTimeout(step.ms);
        await showCaption(page, '');
      }
      cues.push({ startMs, endMs: elapsed(), text: step.text });
      return;
    }
    case 'wait':
      if (DRY_RUN) advance(step.ms);
      else await page.waitForTimeout(step.ms);
      return;
    case 'note':
      log(scene, `メモ: ${step.text}`);
      return;
    case 'manual': {
      log(scene, '⏸ 人の操作を待ちます');
      console.log(`\n${'─'.repeat(64)}\n${step.prompt}\n${'─'.repeat(64)}`);
      if (DRY_RUN) return advance(step.ms || 15000);
      await rl.question('終わったら Enter を押してください > ');
      await installOverlay(page);
      return;
    }
    case 'expect': {
      log(scene, `待機: ${step.selector}`);
      if (DRY_RUN) return advance(900);
      const frame = await appFrame(page);
      try {
        await frame.locator(step.selector).first().waitFor({ state: 'visible', timeout: 30000 });
      } catch {
        failures.push(`[${scene.id}] ${step.selector} が表示されませんでした`);
        console.error(`  ✗ ${step.selector} が出ません。画面を確認してください。`);
        await rl.question('  続行するなら Enter（中断は Ctrl+C）> ');
      }
      return;
    }
    case 'highlight': {
      if (DRY_RUN) return advance(900);
      const ok = await withOverlay(page, () =>
        page.evaluate(selector => window.__demoHighlight?.(selector), step.selector));
      if (!ok && !step.optional) {
        // オーバーレイを差し込めない場合でも、スクロールだけはしておく
        const frame = await appFrame(page);
        await frame.locator(step.selector).first().scrollIntoViewIfNeeded().catch(() => {});
      }
      await page.waitForTimeout(1200);
      return;
    }
    case 'click':
    case 'dblclick': {
      log(scene, `${step.kind}: ${step.selector}`);
      if (DRY_RUN) return advance(900);
      const frame = await appFrame(page);
      const target = frame.locator(step.selector).first();
      try {
        await target.waitFor({ state: 'visible', timeout: 15000 });
        if (step.kind === 'click') await target.click();
        else await target.dblclick();
      } catch (error) {
        failures.push(`[${scene.id}] ${step.kind} 失敗: ${step.selector}`);
        console.error(`  ✗ ${step.selector} を操作できません: ${error.message.split('\n')[0]}`);
        await rl.question('  手で操作してから Enter（中断は Ctrl+C）> ');
      }
      await page.waitForTimeout(900);
      return;
    }
    case 'clickText': {
      log(scene, `クリック: 「${step.text}」`);
      if (DRY_RUN) return advance(900);
      const frame = await appFrame(page);
      const scope = step.within ? frame.locator(step.within) : frame.locator('body');
      const target = scope.locator('button').filter({ hasText: step.text }).first();
      try {
        await target.click({ timeout: 15000 });
      } catch (error) {
        failures.push(`[${scene.id}] ボタン「${step.text}」を押せませんでした`);
        console.error(`  ✗ 「${step.text}」を押せません: ${error.message.split('\n')[0]}`);
        await rl.question('  手で操作してから Enter（中断は Ctrl+C）> ');
      }
      await page.waitForTimeout(900);
      return;
    }
    case 'fill': {
      log(scene, `入力: ${step.selector}`);
      if (DRY_RUN) return advance(900);
      const frame = await appFrame(page);
      // 一気に入れると画面で読めないので、ゆっくり打つ
      await frame.locator(step.selector).first().pressSequentially(step.value, { delay: 90 })
        .catch(() => failures.push(`[${scene.id}] 入力できません: ${step.selector}`));
      await page.waitForTimeout(600);
      return;
    }
    case 'select': {
      log(scene, `選択: ${step.selector} = ${step.value}`);
      if (DRY_RUN) return advance(900);
      const frame = await appFrame(page);
      await frame.locator(step.selector).first().selectOption(step.value)
        .catch(() => failures.push(`[${scene.id}] 選択できません: ${step.selector}`));
      await page.waitForTimeout(600);
      return;
    }
    default:
      throw new Error(`未知のステップ種別: ${step.kind}`);
  }
}

// ---------------------------------------------------------------- 実行

fs.mkdirSync(OUT_DIR, { recursive: true });
const videoFile = path.join(OUT_DIR, ONLY_SCENE ? `raw_${ONLY_SCENE}.mp4` : 'raw.mp4');

let capture = null;
if (!NO_CAPTURE) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    console.error('ffmpeg が見つかりません。画面録画なしで進めるには --no-capture を付けてください。');
    console.error('  macOS: brew install ffmpeg / Windows: winget install Gyan.FFmpeg / Linux: apt install ffmpeg');
    process.exit(1);
  }
}

console.log('=== 撮影前の確認 ===');
console.log('  [ ] 録画を【ディスプレイ全体】にした（同意画面は別ウィンドウで開くため、');
console.log('      ウィンドウ単位の録画では最重要シーンが丸ごと欠落します）');
console.log('  [ ] https://myaccount.google.com/permissions でこのアプリのアクセス権を削除した');
console.log('  [ ] 同意画面の表示言語を English に切り替えられる状態にした');
console.log('  [ ] 実在の児童・保護者の情報が入っていない撮影用データに切り替えた');
console.log('  [ ] 通知・ブックマークバー・他タブを隠した');
console.log(`  アプリ: ${urls.APP_URL || '(未設定)'}`);
if (!DRY_RUN) await rl.question('\n準備ができたら Enter で撮影を始めます > ');

const browser = await launchChromium({ headless: DRY_RUN, width: WIDTH, height: HEIGHT });
const context = await browser.newContext({ viewport: null, locale: 'en-US' });
const page = await context.newPage();
// 遷移のたびにオーバーレイが消えるので入れ直す
page.on('framenavigated', frame => {
  if (frame === page.mainFrame()) installOverlay(page).catch(() => {});
});

if (capture === null && !NO_CAPTURE) {
  capture = startCapture(videoFile, { width: WIDTH, height: HEIGHT });
  console.log(`録画開始: ${path.relative(ROOT, videoFile)}`);
}
started = Date.now();

try {
  for (const scene of scenes) {
    console.log(`\n### ${scene.id} — ${scene.title}`);
    for (const step of scene.steps) {
      await runStep(page, scene, step);
    }
  }
} finally {
  const totalMs = elapsed();
  if (capture) await capture.stop();
  await browser.close().catch(() => {});
  rl.close();

  const timingsFile = path.join(OUT_DIR, ONLY_SCENE ? `timings_${ONLY_SCENE}.json` : 'timings.json');
  fs.writeFileSync(timingsFile, JSON.stringify({ totalMs, cues, failures }, null, 2), 'utf8');

  const srtFile = path.join(OUT_DIR, ONLY_SCENE ? `demo_en_${ONLY_SCENE}.srt` : 'demo_en.srt');
  fs.writeFileSync(srtFile, buildSrt(cues), 'utf8');

  console.log(`\n収録時間: ${Math.floor(totalMs / 60000)} 分 ${Math.round((totalMs % 60000) / 1000)} 秒`);
  console.log(`字幕: ${path.relative(ROOT, srtFile)}（実測タイミング）`);
  console.log(`記録: ${path.relative(ROOT, timingsFile)}`);
  if (!NO_CAPTURE) console.log(`映像: ${path.relative(ROOT, videoFile)}`);

  if (failures.length) {
    console.log(`\n⚠️ うまくいかなかった操作 ${failures.length} 件:`);
    for (const failure of failures) console.log(`  - ${failure}`);
    console.log('該当シーンは --scene=<id> で撮り直せます。');
  }
  console.log('\n次にやること: docs/video/README.md の「後処理でできること」→ 提出前の client_id 確認');
}
