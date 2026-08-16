/**
 * 撮影中に記録した実時刻（timings.json）から英語字幕（.srt）を作る。
 *
 * docs/video/demo_en.srt は台本の想定尺にもとづく暫定タイミングですが、
 * こちらは「実際に何秒で何を映したか」から起こすので打ち直しが要りません。
 */

/** 1ブロックあたりの最低表示時間。これを下回ると読み切れない */
const MIN_BLOCK_MS = 1400;

/** ミリ秒を SRT のタイムコード（00:00:00,000）にする */
export function toTimecode(ms) {
  const total = Math.max(0, Math.round(ms));
  const milli = total % 1000;
  const seconds = Math.floor(total / 1000) % 60;
  const minutes = Math.floor(total / 60000) % 60;
  const hours = Math.floor(total / 3600000);
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(milli, 3)}`;
}

/**
 * 1行が長いと画面からはみ出すので、単語単位で 2 行に折り返す。
 * 長すぎるキューは複数キューに分け、表示時間を按分する。
 */
function wrap(text, maxChars = 46) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) line = word;
    else if (`${line} ${word}`.length <= maxChars) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** 2行ずつのブロックに分ける（1キュー最大2行） */
function toBlocks(text) {
  const lines = wrap(text);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 2) {
    blocks.push(lines.slice(index, index + 2).join('\n'));
  }
  return blocks;
}

/**
 * @param {{startMs:number, endMs:number, text:string}[]} cues
 * @returns {string} SRT 本文
 */
export function buildSrt(cues) {
  const entries = [];
  for (const cue of cues) {
    const blocks = toBlocks(cue.text);
    const span = Math.max(1, cue.endMs - cue.startMs);
    // 文字数で按分するが、「newsletters.」のような短い末尾ブロックが
    // 一瞬で消えないよう、まず最低表示時間を確保してから残りを配分する
    const floor = Math.min(MIN_BLOCK_MS, span / blocks.length);
    const spare = span - floor * blocks.length;
    const total = blocks.reduce((sum, block) => sum + block.length, 0) || 1;
    let cursor = cue.startMs;
    for (const block of blocks) {
      const end = cursor + floor + (spare * block.length) / total;
      entries.push({ startMs: cursor, endMs: end, text: block });
      cursor = end;
    }
  }
  return entries
    .map((entry, index) =>
      `${index + 1}\n${toTimecode(entry.startMs)} --> ${toTimecode(entry.endMs)}\n${entry.text}\n`)
    .join('\n');
}
