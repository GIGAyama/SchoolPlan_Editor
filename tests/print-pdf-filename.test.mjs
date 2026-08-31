import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 週案を「PDFに保存」したときの既定のファイル名の約束を固定する。
//
// ファイル名はブラウザが印刷文書の題から作る。題を決めるところだけが
// 純粋関数 buildPrintDocTitle_ に切り出してあるので、ここではその判断を検証する。
// 「どの題をブラウザに渡しているか」の配線は静的検査で固定する。

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const print = read('App_Js_03_Print.html');
const shell = read('docs/app-url.js');

/**
 * HTML内JSから関数1つ分を、波括弧の対応を数えて切り出す。
 * このファイルの対象は本文に文字列リテラルの波括弧を含まないので、単純な数え上げで足りる。
 */
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

const buildPrintDocTitle_ = new Function(
  `${extractFn(print, 'buildPrintDocTitle_')}\nreturn buildPrintDocTitle_;`
)();

/** 月曜から日曜までの7日分を 'yyyy/MM/dd' で作る */
const week = (...dates) => dates.map(date => ({ date }));
const AUG31_WEEK = week(
  '2026/08/31', '2026/09/01', '2026/09/02', '2026/09/03',
  '2026/09/04', '2026/09/05', '2026/09/06'
);

// ===== 題の作り方 =====

test('週番号と、その週の初日・最終日が名前に入る', () => {
  assert.equal(buildPrintDocTitle_(23, AUG31_WEEK), '週案第23週(8月31日-9月6日)');
});

test('日付の 0 詰めは落とす（08月31日 とは書かない）', () => {
  const title = buildPrintDocTitle_(23, AUG31_WEEK);
  assert.ok(!title.includes('08月'), `0 詰めが残っている: ${title}`);
  assert.ok(!title.includes('01日'), `0 詰めが残っている: ${title}`);
});

test('週が違えば名前も違う（毎回同じ名前で保存されない）', () => {
  const next = week(
    '2026/09/07', '2026/09/08', '2026/09/09', '2026/09/10',
    '2026/09/11', '2026/09/12', '2026/09/13'
  );
  assert.notEqual(buildPrintDocTitle_(23, AUG31_WEEK), buildPrintDocTitle_(24, next));
});

test('ファイル名に使えない文字を含まない', () => {
  // 「8/31-9/6」のように書くと、ブラウザが機械的に置き換えて読めない名前になる
  const title = buildPrintDocTitle_(23, AUG31_WEEK);
  for (const ch of ['/', '\\', '?', ':', '*', '"', '<', '>', '|']) {
    assert.ok(!title.includes(ch), `使えない文字 ${ch} が入っている: ${title}`);
  }
});

// ===== 欠けているとき =====

test('週番号が分からない週は「第?週」を出さない', () => {
  // '?' はファイル名に使えないので、週番号ごと落として日付だけで名乗る
  assert.equal(buildPrintDocTitle_('?', AUG31_WEEK), '週案(8月31日-9月6日)');
});

test('日付が取れないときは週番号だけで名乗る', () => {
  assert.equal(buildPrintDocTitle_(23, []), '週案第23週');
  assert.equal(buildPrintDocTitle_(23, null), '週案第23週');
  assert.equal(buildPrintDocTitle_(23, [{ date: '' }, {}, null]), '週案第23週');
});

test('何も取れなくても空の名前にはしない', () => {
  assert.equal(buildPrintDocTitle_('', []), '週案');
});

test('1日分しか無いときは範囲にしない', () => {
  assert.equal(buildPrintDocTitle_(23, week('2026/08/31')), '週案第23週(8月31日)');
});

// ===== 配線（静的検査） =====

test('印刷文書の <title> は buildPrintDocTitle_ が作ったものを使う', () => {
  assert.match(print, /var docTitle = buildPrintDocTitle_\(weekNum, days\);/);
  assert.match(print, /<title>' \+ escHtml\(docTitle\)/);
  // 週番号だけの古い題が残っていないこと
  assert.ok(!print.includes('<title>週案_第'), '古い固定の題が残っている');
});

test('外側のページの題も刷るあいだだけ差し替え、印刷後に必ず戻す', () => {
  // Chrome は iframe ではなく外側の題をファイル名に使う
  assert.match(print, /restoreHostTitle = swapHostTitle_\(docTitle\);/);
  const afterPrint = print.slice(print.indexOf('onafterprint'));
  assert.ok(afterPrint.includes('restoreHostTitle();'), '印刷後に題を戻していない');
  // afterprint が来ない環境でも戻るように、時間切れの戻しがあること
  assert.match(print, /setTimeout\(restore, HOST_TITLE_RESTORE_MS\);/);
});

test('入口ページ（シェル）にも題を送り、戻すときは null を送る', () => {
  // アプリ本体は三重の iframe の内側にいる。ファイル名になるのはいちばん外側の
  // ページの題なので、そこへ送らないと週の名前は付かない
  const swap = extractFn(print, 'swapHostTitle_');
  assert.ok(swap.includes('postShellTitle_(newTitle);'), 'シェルへ題を送っていない');
  assert.ok(swap.includes('postShellTitle_(null);'), 'シェルへ戻す合図を送っていない');
  assert.match(print, /type: 'schoolPlanNote:printTitle'/);
  // 宛先は shellAck で分かった相手だけ。'*'（誰にでも届く）では送らない
  const post = extractFn(print, 'postShellTitle_');
  assert.ok(post.includes('window.__shellOrigin'), '宛先をシェルの素性から取っていない');
  assert.ok(!/postMessage\([^)]*'\*'/.test(post), "宛先に '*' を使っている");
  assert.match(read('App.html'), /window\.__shellOrigin = e\.origin;/);
});

// ===== 入口ページ側（docs/app-url.js）の受け取り =====

const readPrintTitleMessage = new Function(
  `${extractFn(shell, 'readPrintTitleMessage')}\nreturn readPrintTitleMessage;`
)();

const APP_ORIGIN = 'https://n-abc123def-script.googleusercontent.com';
const msg = title => ({ type: 'schoolPlanNote:printTitle', title });

test('アプリ本体から届いた正しい形の題は受けつける', () => {
  assert.equal(
    readPrintTitleMessage(APP_ORIGIN, msg('週案第23週(8月31日-9月6日)')),
    '週案第23週(8月31日-9月6日)'
  );
  assert.equal(readPrintTitleMessage('https://script.google.com', msg('週案第2週(4月1日-4月7日)')),
    '週案第2週(4月1日-4月7日)');
  // 週番号や日付が欠けた縮退形も、こちらが作りうる形なので受けつける
  assert.equal(readPrintTitleMessage(APP_ORIGIN, msg('週案第23週')), '週案第23週');
  assert.equal(readPrintTitleMessage(APP_ORIGIN, msg('週案(8月31日)')), '週案(8月31日)');
  assert.equal(readPrintTitleMessage(APP_ORIGIN, msg('週案')), '週案');
});

test('title が null なら「元に戻す」と読む', () => {
  assert.equal(readPrintTitleMessage(APP_ORIGIN, msg(null)), null);
  assert.equal(readPrintTitleMessage(APP_ORIGIN, { type: 'schoolPlanNote:printTitle' }), null);
});

test('よそから届いた便りは受けつけない', () => {
  // 題を書き替えられるだけとはいえ、素性の分からない相手には従わない
  for (const origin of [
    'https://evil.example.com',
    'https://googleusercontent.com.evil.example.com',
    'http://localhost:8080',
    'null',
    ''
  ]) {
    assert.equal(readPrintTitleMessage(origin, msg('週案第23週(8月31日-9月6日)')), undefined,
      `受けつけてはいけない送り元: ${origin}`);
  }
});

test('こちらが作らない形の題は受けつけない', () => {
  for (const bad of [
    '週案エディタ - School Plan Note',
    '<script>alert(1)</script>',
    '週案第23週(8/31-9/6)',
    '週案第9999週',
    '週案第23週(8月31日-9月6日) ほか',
    123,
    { toString: () => '週案' }
  ]) {
    assert.equal(readPrintTitleMessage(APP_ORIGIN, msg(bad)), undefined,
      `受けつけてはいけない題: ${String(bad)}`);
  }
});

test('別の種類の便りには手を出さない', () => {
  assert.equal(readPrintTitleMessage(APP_ORIGIN, { type: 'schoolPlanNote:ready' }), undefined);
  assert.equal(readPrintTitleMessage(APP_ORIGIN, null), undefined);
});

test('シェルは受け取った題を当て、時間切れで必ず元へ戻す', () => {
  assert.match(shell, /var SHELL_TITLE = document\.title;/);
  assert.match(shell, /document\.title = SHELL_TITLE;/);
  assert.match(shell, /PRINT_TITLE_RESTORE_MS/);
  // ready ハンドシェイクより先に見て、印刷の便りをそちらへ流さないこと
  const handler = shell.slice(shell.indexOf("addEventListener('message'"));
  assert.ok(
    handler.indexOf('readPrintTitleMessage') < handler.indexOf("'schoolPlanNote:ready'"),
    '印刷の便りが ready の判定より後になっている'
  );
});
