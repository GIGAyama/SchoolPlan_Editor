#!/usr/bin/env node
/**
 * 撮影済みの動画に合わせた字幕（.srt）を、キュー定義から組み立てます。
 *
 *   node tools/demo-video/build-srt.mjs
 *   → docs/video/demo_en.srt
 *
 * 入力は docs/video/demo_en_cues.json（`m:ss` の開始・終了と英文）。
 * 撮り直したら、この JSON の時刻を実際の映像に合わせて直してから再実行します。
 *
 *   node tools/demo-video/build-srt.mjs --from-scenes
 *   → 台本（scenes.mjs）の字幕で demo_en_cues.json を作り直す
 *
 * 台本を書き換えたら --from-scenes でキューを作り直し、撮影後に実際の時刻へ直します
 * （時刻は台本の想定尺から置いた**仮の値**です。そのまま提出しないこと）。
 *
 * `record-demo.mjs` で撮った場合は実測タイミングの .srt がそのまま出るので、
 * こちらは「手で撮った動画にあとから字幕を合わせる」ときに使います。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { buildSrt } from './srt.mjs';
import { SCENES } from './scenes.mjs';

const CUES_FILE = path.join(ROOT, 'docs', 'video', 'demo_en_cues.json');
const OUT_FILE = path.join(ROOT, 'docs', 'video', 'demo_en.srt');

/** "m:ss" または "h:mm:ss"（小数秒も可）をミリ秒にする */
function toMs(value) {
  const parts = String(value).split(':').map(Number);
  if (parts.some(Number.isNaN)) throw new Error(`時刻の書式が不正です: ${value}`);
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Math.round(seconds * 1000);
}

/** ミリ秒を "m:ss" に戻す（キュー定義は人が直すので読みやすい表記にする） */
function toClock(ms) {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * 台本の caption ステップから、キュー定義の下書きを作る。
 * 時刻は想定尺の積み上げなので、撮影後に実測へ直す前提。
 */
function cuesFromScenes() {
  const cues = [];
  let cursor = 2000; // 冒頭の間
  for (const scene of SCENES) {
    for (const step of scene.steps) {
      if (step.kind === 'caption') {
        cues.push({ start: toClock(cursor), end: toClock(cursor + step.ms), text: step.text });
        cursor += step.ms;
      } else if (step.kind === 'wait') cursor += step.ms || 0;
      else if (step.kind === 'manual') cursor += step.ms || 15000;
      else cursor += 900;
    }
  }
  return cues;
}

if (process.argv.includes('--from-scenes')) {
  const cues = cuesFromScenes();
  fs.writeFileSync(CUES_FILE, JSON.stringify({
    recording: '未撮影（台本 scenes.mjs の想定尺から起こした仮の時刻）',
    note: '撮影後、実際の映像に合わせて start / end を直してから `node tools/demo-video/build-srt.mjs` を実行する。'
      + ' record-demo.mjs で撮った場合は実測タイミングの .srt が dist/demo-video/ に出るので、このファイルは不要。',
    cues
  }, null, 2) + '\n', 'utf8');
  console.log(`キュー定義を台本から作り直しました: ${path.relative(ROOT, CUES_FILE)}（${cues.length} 件・時刻は仮）`);
}

const source = JSON.parse(fs.readFileSync(CUES_FILE, 'utf8'));
const cues = source.cues.map((cue, index) => {
  const startMs = toMs(cue.start);
  const endMs = toMs(cue.end);
  if (endMs <= startMs) throw new Error(`${index + 1} 番目のキューの終了が開始より前です: ${cue.start} → ${cue.end}`);
  return { startMs, endMs, text: cue.text };
});

// 重なっていると字幕が二重に出る
for (let index = 1; index < cues.length; index += 1) {
  if (cues[index].startMs < cues[index - 1].endMs) {
    throw new Error(`${index} 番目と ${index + 1} 番目のキューが重なっています`);
  }
}

fs.writeFileSync(OUT_FILE, buildSrt(cues), 'utf8');

const totalMs = cues[cues.length - 1].endMs;
console.log(`字幕を書き出しました: ${path.relative(ROOT, OUT_FILE)}`);
console.log(`  キュー ${cues.length} 件 / 最後の字幕は ${Math.floor(totalMs / 60000)}分${Math.round((totalMs % 60000) / 1000)}秒`);
console.log(`  対象の録画: ${source.recording}`);
