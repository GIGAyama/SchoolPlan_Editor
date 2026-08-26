import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 空きコマ（別教員担当）まわりの約束を固定する(静的検査)。
//
// 空きコマの状態は専用の列ではなく、「学習内容」セルの中に埋め込んだ区切りマーカーで
// 表している。この表現はクライアント(App_Js_02_Plan.html)とサーバ(00_config.gs)の
// 両方に必要だが、GAS では .gs から HTML の include を読む手段が無いため、
// 定数を1か所に寄せられない。ズレると「転記した空きコマを画面が認識しない」という、
// 原因が極めて追いにくい壊れ方をするので、ここで一致を強制する。

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

const plan = read('App_Js_02_Plan.html');
const print = read('App_Js_03_Print.html');
const settings = read('App_Js_10_Settings.html');
const css = read('App_Css.html');
const app = read('App.html');
const config = read('00_config.gs');
const webapp = read('07_WebApp.gs');
const utils = read('99_Utils.gs');
const autofill = read('04_AutoFill.gs');

/**
 * HTML内JSから関数 1 つ分の本文を取り出す（次の同インデントの宣言まで）。
 * このリポジトリの他のテスト（timetable-transfer.test.mjs）と同じ流儀。
 */
function fnBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n {4}(?:(?:async )?function |var |const |\/\/ =====)/);
  return rest.slice(0, next === -1 ? undefined : next);
}

/**
 * .gs から関数 1 つ分の本文を取り出す。
 * .gs のトップレベル関数は字下げ0なので、閉じ括弧が行頭に来るところまでを本文とする
 * （fnBody の「次の同インデントの宣言まで」は、try 内の4字下げに引っかかって使えない）。
 */
function gsFnBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found in .gs`);
  const rest = source.slice(start);
  const end = rest.indexOf('\n}');
  assert.notEqual(end, -1, `function ${name} の終わりが見つからない`);
  return rest.slice(0, end);
}

// ===== 区切りマーカーの二重定義 =====

test('空きコマのマーカーは、クライアントとサーバで同じ文字列', () => {
  const client = /var FREE_TASK_DIVIDER = '([^']+)';/.exec(plan);
  const server = /const FREE_TASK_DIVIDER_ = '([^']+)';/.exec(config);
  assert.ok(client, 'App_Js_02_Plan.html に FREE_TASK_DIVIDER が無い');
  assert.ok(server, '00_config.gs に FREE_TASK_DIVIDER_ が無い');
  assert.equal(server[1], client[1],
    'クライアントとサーバでマーカーが違う。転記した空きコマを画面が認識できなくなる');
});

test('マーカーの文字が、見た目の似た別の文字に置き換わっていない', () => {
  // ─ は U+2500 BOX DRAWINGS LIGHT HORIZONTAL。エディタの自動整形や全角変換で
  // ー(U+30FC) や —(U+2014) に化けると、既存データの空きコマが静かに全部無効になる。
  const client = /var FREE_TASK_DIVIDER = '([^']+)';/.exec(plan)[1];
  assert.deepEqual([...client].map(c => c.codePointAt(0)),
    [0x2500, 0x2500, 0x2500, 0x20, 0x30BF, 0x30B9, 0x30AF, 0x20, 0x2500, 0x2500, 0x2500]);
});

test('マーカーの直書きは、定数の定義箇所だけ', () => {
  // 第3の定義が生えると、上の一致チェックをすり抜けてズレる
  const files = {
    'App_Js_02_Plan.html': 1, '00_config.gs': 1,
    'App_Js_03_Print.html': 0, 'App_Js_10_Settings.html': 0,
    '02_Database.gs': 0, '07_WebApp.gs': 0, '99_Utils.gs': 0, '04_AutoFill.gs': 0
  };
  for (const [file, expected] of Object.entries(files)) {
    const hits = (read(file).match(/─── タスク ───/g) || []).length;
    assert.equal(hits, expected, `${file}: マーカーは定数だけで持つこと`);
  }
});

// ===== 印刷 =====

test('印刷は、空きコマの区切りマーカーを紙に出さない', () => {
  const body = fnBody(print, 'buildPrintStyles_');
  assert.ok(body, 'buildPrintStyles_ が見つからない');
  // renderPeriod は printWeeklyPlanExec 内のローカル関数なので、宣言ごと切り出す
  const rp = print.slice(print.indexOf('var renderPeriod = function'));
  assert.match(rp, /isFreeContent\(/, '空きコマの判定をしていない');
  assert.match(rp, /splitFreeContent\(/, '授業内容とタスクに分けていない');
});

test('印刷は、教科名が空の空きコマでも帯を出す', () => {
  // バッジ文字を出さない以上、帯の色が唯一の手がかり。帯が出ないと
  // 「何も予定が無いコマ」と紙の上で見分けられなくなる
  const rp = print.slice(print.indexOf('var renderPeriod = function'));
  assert.match(rp, /if \(p\.subject \|\| free\)/);
  assert.match(rp, /&nbsp;/, '空の div は高さ0になるので中身が要る');
});

test('印刷の空きコマは、通常の教科名の帯と違う色', () => {
  const styles = fnBody(print, 'buildPrintStyles_');
  const normal = /\.subject \{[^}]*background-color: (#[0-9a-f]{6})/i.exec(styles);
  const free = /\.subject\.subject-free \{[^}]*background-color: (#[0-9a-f]{6})/i.exec(styles);
  assert.ok(normal, '通常の .subject に背景色が無い');
  assert.ok(free, '.subject.subject-free が定義されていない');
  assert.notEqual(free[1].toLowerCase(), normal[1].toLowerCase(),
    '空きコマの帯が通常の帯と同じ色では、一目で分からない');
});

test('印刷に足したフォントサイズは em 指定', () => {
  // 印刷ダイアログのフォントサイズスライダーは body の font-size を動かす。
  // px 直書きだとスライダーが効かず、空きコマのタスクだけ大きさが取り残される
  const styles = fnBody(print, 'buildPrintStyles_');
  const freeRules = styles.split('\n').filter(l => /\.freetask/.test(l));
  assert.ok(freeRules.length >= 2, '.freetask / .freetask-label が無い');
  for (const rule of freeRules) {
    assert.doesNotMatch(rule, /font-size: \d+px/, 'font-size は em で指定すること: ' + rule.trim());
  }
});

test('印刷のコマ描画は1つで、標準とコンパクトの両方に効く', () => {
  // レイアウトごとに描画が分かれると、片方だけ直す事故が起きる
  assert.match(print, /buildCompactPageHtml_\(opts, days, weekNum, renderDateHeader, renderPeriod\)/);
});

// ===== 固定時間割エディタ =====

test('固定時間割エディタは、校時ごとに空きを設定できる', () => {
  assert.match(fnBody(settings, 'renderTimetableEditor'), /makeFreeToggle\(/);
  // 収集に含めることで、空きの切り替えも未保存として検知される
  assert.match(fnBody(settings, 'gatherTimetableData'), /freePeriods/);
});

test('エディタのチェックボックスは、表の input 指定に潰されない', () => {
  // .tt-editor-table input { width: 100% } がチェックボックスにも効いてしまう
  assert.match(css, /\.tt-editor-table \.tt-free-toggle input\[type="checkbox"\][^}]*width: auto/);
});

test('空きを外しても既存の週から消えないことを、設定前と転記前に伝える', () => {
  // この非対称は仕様。伝えないと「反映されない不具合」に見える
  assert.match(app, /解除されません/, 'エディタの説明文に告知が無い');
  const preview = fnBody(settings, 'renderTimetablePreviewHtml');
  assert.match(preview, /freePeriods/, 'プレビュー表に空きが出ていない');
  assert.match(preview, /解除されません/, '転記の確認に告知が無い');
});

// ===== サーバ =====

test('固定時間割は、読み書きの両方でスキーマをそろえる', () => {
  // 古い保存データには freePeriods が無い。片方だけ通すと、いつか読み手が落ちる
  assert.match(gsFnBody(webapp, 'getTimetableForEditor'), /normalizeTimetableData_\(/);
  assert.match(gsFnBody(webapp, 'saveTimetableFromEditor'), /normalizeTimetableData_\(/);
  assert.match(gsFnBody(webapp, 'normalizeTimetableData_'), /free\[p\] === true/,
    '真偽値へ正規化すること（壊れた値で保存内容を汚さない）');
});

test('空きコマの指定は、時間割本体とは別の関数で取る', () => {
  // getTimetableData_() の 5行×8列は DB_TIMETABLE_WRITE_KEYS_ と1対1で対応する契約。
  // 暗黙の9列目を足すと、後から読む人が必ず踏む
  assert.match(utils, /function getTimetableFreeData_\(\)/);
  assert.match(gsFnBody(utils, 'getTimetableData_'), /return parsed\.map/);
  assert.doesNotMatch(gsFnBody(utils, 'getTimetableData_'), /freePeriods/);
});

test('自動入力は、空きコマの印を消さない', () => {
  // 固定時間割から空きコマが毎週入るようになると週に何コマもあるのが普通になり、
  // ここを抜くと一括自動入力の1回で全部消える
  assert.match(gsFnBody(autofill, 'calculateAutoFillForWebApp'), /isFreeContent_\(p\.content\)/);
  assert.match(gsFnBody(autofill, 'batchAutoFillFromWeek'), /isFreeContent_\(row\[pc\.content - 1\]\)/);
});
