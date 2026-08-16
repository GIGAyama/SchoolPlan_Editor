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
 * `record-demo.mjs` で撮った場合は実測タイミングの .srt がそのまま出るので、
 * こちらは「手で撮った動画にあとから字幕を合わせる」ときに使います。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { buildSrt } from './srt.mjs';

const CUES_FILE = path.join(ROOT, 'docs', 'video', 'demo_en_cues.json');
const OUT_FILE = path.join(ROOT, 'docs', 'video', 'demo_en.srt');

/** "m:ss" または "h:mm:ss"（小数秒も可）をミリ秒にする */
function toMs(value) {
  const parts = String(value).split(':').map(Number);
  if (parts.some(Number.isNaN)) throw new Error(`時刻の書式が不正です: ${value}`);
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Math.round(seconds * 1000);
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
