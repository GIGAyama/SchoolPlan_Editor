import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 学級通信の時間割ブロックの約束を固定する。
//
// 表を組むのは DOM とアプリ状態が要る NW.renderScheduleHTML なので Node では動かせない。
// そこで「日付をどう書くか」「大きさをどう決めるか」の判断だけを純粋関数に切り出してあり、
// ここではその判断を検証する。残り（行の出し分けと操作パネル）は静的検査で固定する。

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const nl = read('App_Js_06_Newsletter.html');
const css = read('App_Css.html');

/** HTML内JSから関数1つ分を、波括弧の対応を数えて切り出す（print-autofit.test.mjs と同じ手） */
function extractFn(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`function ${name} is unbalanced`);
}

/** `var NAME = [...];` を切り出す */
function extractArray(source, name) {
  const start = source.indexOf(`var ${name} = [`);
  assert.notEqual(start, -1, `var ${name} not found`);
  const end = source.indexOf('];', start);
  assert.notEqual(end, -1, `var ${name} is unbalanced`);
  return source.slice(start, end + 2);
}

const sizes = extractArray(nl, 'SCHED_DATE_SIZES');
const schedDateLabel_ = new Function(`${extractFn(nl, 'schedDateLabel_')}\nreturn schedDateLabel_;`)();
const schedDateStyle_ = new Function(
  `${sizes}\n${extractFn(nl, 'schedDateStyle_')}\nreturn schedDateStyle_;`)();

// ===== 日付の書き方 =====

test('月日の頭の0を落として「9/14」の形にする', () => {
  // 週案は "YYYY/MM/DD" で持っている。通信の見出しに "09/14" は要らない
  assert.equal(schedDateLabel_('2026/09/14'), '9/14');
  assert.equal(schedDateLabel_('2026/09/04'), '9/4');
  assert.equal(schedDateLabel_('2026/10/14'), '10/14');
});

test('想定外の形は捨てずに素通しする', () => {
  // 日付が入っていない週・手で書き替えられたデータでも、表そのものは出す
  assert.equal(schedDateLabel_(''), '');
  assert.equal(schedDateLabel_('bogus'), 'bogus');
  assert.equal(schedDateLabel_(null), '');
  assert.equal(schedDateLabel_(undefined), '');
});

// ===== 日付の大きさ =====

test('既定は従来より大きい。小さすぎて読めないという声への答え', () => {
  const before = 0.65 * 16; // 旧 .nw-sched-date の font-size（10.4px 相当）
  const px = parseFloat(schedDateStyle_('m').match(/font-size:(\d+)px/)[1]);
  assert.ok(px > before, `既定(${px}px)は旧 ${before}px より大きいはず`);
});

test('小・中・大・特大の順に大きくなる', () => {
  const px = k => parseFloat(schedDateStyle_(k).match(/font-size:(\d+)px/)[1]);
  assert.ok(px('s') < px('m') && px('m') < px('l') && px('l') < px('xl'),
    `単調に大きくなるはず: ${['s', 'm', 'l', 'xl'].map(px).join(',')}`);
});

test('知らない値は既定の「中」に落とす（古い保存データで表が壊れない）', () => {
  assert.equal(schedDateStyle_('huge'), schedDateStyle_('m'));
  assert.equal(schedDateStyle_(undefined), schedDateStyle_('m'));
});

test('大きさは inline style で入る。CSSを連れていけない Classroom 書き出しでも効く', () => {
  // buildClassroomHTML は renderScheduleHTML の出力をそのまま使う（スタイルシートは付かない）
  assert.match(nl, /nw-sched-date" style="' \+ dateStyle \+ '"/,
    '日付の span に inline style を載せていない');
  assert.ok(/font-size:' \+ hit\.px \+ 'px;/.test(nl), 'schedDateStyle_ が px を返していない');
});

// ===== 行事の出し分け =====

test('行事は行ごと消せる。既定は出す（今までの通信の見え方を変えない）', () => {
  assert.match(nl, /showEvent: true/, '既定で行事を出す設定になっていない');
  assert.match(nl, /if \(opts\.showEvent !== false\) \{/,
    '行事行が showEvent で囲まれていない（消しても行だけ空で残ってしまう）');
});

test('行事の表示切り替えが操作パネルに在る', () => {
  assert.ok(nl.includes(String.raw`\'showEvent\',this.checked)"> 行事</label>`),
    '行事のチェックボックスが操作パネルに無い');
});

test('日付の大きさの選択が操作パネルに在る', () => {
  assert.match(nl, /NW\.setSchedDateSize\(/, '日付サイズの選択が操作パネルに無い');
  assert.match(nl, /NW\.setSchedDateSize = function/, 'NW.setSchedDateSize が定義されていない');
});

test('印刷CSSにも日付のクラスが在る（画面と紙で見え方をそろえる）', () => {
  assert.match(nl, /\.nw-sched-date\{font-size:/, '印刷CSSに .nw-sched-date が無い');
  assert.match(css, /\.nw-sched-date \{/, '画面CSSに .nw-sched-date が無い');
});
