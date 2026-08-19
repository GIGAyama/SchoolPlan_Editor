import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// プライバシーポリシーの記載が、実装より安全側に振れていないかの検査
// （docs/LEGAL_RISK_AUDIT_JP.md の B-1〜B-4）。
//
// 表示と実態の食い違いは、利用者に誤った安全性の認識を与える。しかもポリシーは
// コードと違って動かして確かめられないので、黙ってずれていく。
// 「実装がこうである以上、ポリシーにはこう書いてあるはず」という対応をここで固定する。

const policy = fs.readFileSync('docs/privacy-policy.html', 'utf8');
const about = fs.readFileSync('docs/about.html', 'utf8');

test('B-1 例外ログがスクリプト所有者に見えることを開示している', () => {
  // appsscript.json が Stackdriver への例外ログを有効にしている以上、
  // 「運用者へ送信する仕組みそのものが存在しない」とは言い切れない。
  const manifest = JSON.parse(fs.readFileSync('appsscript.json', 'utf8'));
  assert.equal(manifest.exceptionLogging, 'STACKDRIVER',
    'ログ方針が変わりました。ポリシーの記述も見直してください。');

  assert.match(policy, /実行ログ/, '例外ログについての記載がありません');
  assert.match(policy, /スクリプトの所有者/);
  assert.doesNotMatch(policy, /運用者へデータを送信する仕組みそのものが存在しません/,
    '実装より安全側に振れた断定が残っています');
  assert.match(about, /実行ログ/, 'about ページの記述が追いついていません');
});

test('B-1 ログの書き込み失敗時に、本文を Stackdriver へ出していない', () => {
  const utils = fs.readFileSync('99_Utils.gs', 'utf8');
  const start = utils.indexOf('function writeToLog_');
  const body = utils.slice(start, utils.indexOf('\nfunction ', start + 1));

  // console.error は Stackdriver に出る＝スクリプト所有者が読める
  const consoleLines = body.split('\n').filter(l => l.includes('console.error'));
  assert.ok(consoleLines.length > 0, 'ログ失敗時の記録が無くなっています');
  for (const line of consoleLines) {
    assert.doesNotMatch(line, /\$\{message\}/,
      'ログ本文をそのまま Stackdriver へ出しています（所有者に読まれます）');
  }
});

test('B-2 学級通信の下書きをブラウザに保存することを開示している', () => {
  assert.match(policy, /学級通信エディタ/, '下書き保存についての記載がありません');
  assert.match(policy, /写真は保存しません/);
});

test('B-2 実装は写真を localStorage に入れていない', () => {
  const nw = fs.readFileSync('App_Js_06_Newsletter.html', 'utf8');
  const start = nw.indexOf('NW.autoSave = function');
  const body = nw.slice(start, nw.indexOf('NW.autoRestore', start));

  assert.match(body, /stripImagesForLocalSave_/,
    '写真を落とさずに保存しています');
  // かつては「容量が足りないときだけ落とす」作りだった
  assert.doesNotMatch(body, /b\.src\.length > 1000/,
    '容量超過時にだけ画像を落とす作りに戻っています');
});

test('B-3 音声入力の外部送信を開示している', () => {
  const reflection = fs.readFileSync('App_Js_04_Reflection.html', 'utf8');
  assert.match(reflection, /webkitSpeechRecognition/, '前提が変わっています');

  assert.match(policy, /Web Speech API/, '音声入力の送信先が書かれていません');
  assert.match(policy, /音声はブラウザ|音声認識サービス/);
  // 画面でも伝えていること
  assert.match(reflection, /音声認識サービスへ送られて文字になります/,
    '録音開始時の案内がありません');
});

test('B-4 「学習に使われない」を条件付きの記述にしている', () => {
  // 無料ティアのキーでも動く以上、断定はできない
  assert.match(policy, /有料ティアかどうかを判定できません/,
    '判定できないことが書かれていません');
  assert.match(policy, /有料ティアのキーを設定している限り/,
    '条件付きの記述になっていません');
});

test('外部送信先の一覧が、実装で実際に通信している先と対応している', () => {
  // .gs が外部へ出す先（Google の API を除く）
  const gsSources = fs.readdirSync('.').filter(f => f.endsWith('.gs'))
    .map(f => fs.readFileSync(f, 'utf8')).join('\n');

  // 内閣府の祝日CSV は取得しているので、ポリシーにも載っているはず
  assert.match(gsSources, /www8\.cao\.go\.jp/);
  assert.match(policy, /国民の祝日/);

  // Gemini 以外の生成AI・第三者サービスを新たに呼び始めていないこと
  assert.doesNotMatch(gsSources, /api\.openai\.com|api\.anthropic\.com|qrserver/,
    'ポリシーに書かれていない外部サービスを呼んでいます');
});
