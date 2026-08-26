import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 固定時間割の転記で「変更前の時間割が入る」不具合の回帰防止(静的検査)。
// 原因は2つあり、どちらも再発すると気づきにくい:
//   1) 転記でサーバーの週が書き換わるのに、クライアントの週キャッシュを捨てていなかった
//      → doLoadWeeklyPlan() が転記前の週を先に描き、それを保存すると転記結果が消える
//   2) 転記が書き込むのは「保存済みの固定時間割」で、エディタに表示中の内容ではない
//      → 保存し忘れ・別端末での変更に気づけず、1つ前の時間割が書き込まれる

const read = file => fs.readFileSync(file, 'utf8');

const core = read('App_Js_01_Core.html');
const settings = read('App_Js_10_Settings.html');
const multiClass = read('App_Js_14_MultiClass.html');
const plan = read('App_Js_02_Plan.html');
const pdfImport = read('App_Js_07_PdfImport.html');
const reflection = read('App_Js_04_Reflection.html');
const app = read('App.html');

/** ソースから関数 1 つ分の本文を取り出す（次の同インデントの宣言まで）。 */
function fnBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n {4}(?:(?:async )?function |var |const |\/\/ =====)/);
  return rest.slice(0, next === -1 ? undefined : next);
}

test('週キャッシュの破棄は共通関数に集約されている', () => {
  const body = fnBody(multiClass, 'p2InvalidateWeekCache');
  assert.match(body, /STATE\.performance\.weekCache = \{\}/);
  // 週の内容が変われば単元進捗も変わる（同じ時間を二重に入力しないため）
  assert.match(body, /STATE\.unitProgress = null/);
  // サーバ側を書き換えた直後の読み直しなので、手元の編集より読み直しを優先する
  assert.match(body, /reloadCurrentWeek[\s\S]*doLoadWeeklyPlan\(\{ force: true \}\)/);
  // 生の代入が散らばると「呼び忘れ」に気づけない。定義箇所以外には残さない
  for (const [name, source] of Object.entries({ plan, settings, pdfImport, core })) {
    assert.doesNotMatch(source, /STATE\.performance\.weekCache = \{\}/,
      `${name}: 週キャッシュの破棄は p2InvalidateWeekCache() を使うこと`);
  }
});

test('画面を経由せずDBを書き換える操作は必ず週キャッシュを捨てる', () => {
  // 固定時間割の転記（今の週 / 年間一括）
  assert.match(fnBody(settings, 'applyTimetableToCurrentWeek'), /p2InvalidateWeekCache\(\)/);
  assert.match(fnBody(settings, 'runBulkTransfer'), /p2InvalidateWeekCache\(true\)/);
  // 一括自動入力・単元のずらし（従来からの経路）
  const clears = plan.match(/p2InvalidateWeekCache\(\)/g) || [];
  assert.ok(clears.length >= 2, `expected weekCache clears in plan, got ${clears.length}`);
  // 行事PDFの反映は年間の複数週へ書き込む
  assert.match(pdfImport, /p2InvalidateWeekCache\(\)/);
});

test('転記は保存済みの内容を書くことをユーザーに示す', () => {
  const confirm = fnBody(settings, 'confirmTimetableBeforeTransfer');
  // 未保存のまま転記すると1つ前の時間割が書き込まれるため、必ず知らせる
  assert.match(confirm, /hasUnsavedTimetableChanges\(\)/);
  assert.match(confirm, /保存してから転記/);
  assert.match(confirm, /saveTimetableOnce\(\)/);
  // エディタの表示ではなく、サーバーの保存済み内容を取り直して見せる
  assert.match(confirm, /fetchSavedTimetable\(\)/);
  assert.match(confirm, /renderTimetablePreviewHtml\(timetable\)/);
  // 空のまま転記すると対象週の教科が消える
  assert.match(confirm, /isTimetableEmpty\(timetable\)/);
  assert.match(confirm, /すべて空になります/);
  // 転記の両経路がこの確認を通る
  assert.match(fnBody(settings, 'applyTimetableToCurrentWeek'), /confirmTimetableBeforeTransfer\(/);
  assert.match(fnBody(settings, 'runBulkTransfer'), /confirmTimetableBeforeTransfer\(/);
});

test('空きコマは「付けるだけ」だと、転記の前に伝える', () => {
  // 固定時間割で空きを外しても、すでに転記した週の空きは解除されない。
  // この非対称は「手で設定した空きを転記で消さない」ための仕様だが、
  // 黙っていると「反映されない不具合」に見えるので必ず知らせる。
  const preview = fnBody(settings, 'renderTimetablePreviewHtml');
  assert.match(preview, /freePeriods/, 'プレビュー表に空きコマを出すこと');
  assert.match(preview, /消しません/, '既存の学習内容を消さないと伝えること');
  assert.match(preview, /解除されません/, '外しても消えないことを伝えること');
  // 転記の両経路がこのプレビューを通るので、告知も両方に出る
  assert.match(fnBody(settings, 'confirmTimetableBeforeTransfer'), /renderTimetablePreviewHtml\(timetable\)/);
});

test('固定時間割エディタの未保存を検出できる', () => {
  assert.match(core, /timetableSaved: null,/);
  const dirty = fnBody(settings, 'hasUnsavedTimetableChanges');
  assert.match(dirty, /STATE\.timetableSaved/);
  assert.match(dirty, /gatherTimetableData\(\)/);
  // 基準は「描画直後」と「保存成功時」に更新する
  assert.match(fnBody(settings, 'renderTimetableEditor'), /STATE\.timetableSaved = JSON\.stringify\(gatherTimetableData\(\)\)/);
  assert.match(fnBody(settings, 'saveTimetableOnce'), /STATE\.timetableSaved = JSON\.stringify\(data\)/);
});

test('古い固定時間割を表示したまま保存し直さない', () => {
  // 設定タブを開くたびにサーバーへ同期する。ただし入力途中は消さない
  assert.match(core, /if \(!STATE\.timetableLoaded \|\| !hasUnsavedTimetableChanges\(\)\) loadTimetableEditor\(\);/);
  // 離脱時にも未保存を知らせる
  assert.match(core, /hasUnsavedChanges\(\) \|\| hasUnsavedTimetableChanges\(\)/);
  // 「再読み込み」は未保存の入力を黙って捨てない
  assert.match(app, /onclick="reloadTimetableEditor\(\)"/);
  assert.match(fnBody(settings, 'reloadTimetableEditor'), /hasUnsavedTimetableChanges\(\)[\s\S]*Swal\.fire/);
});

test('振り返りの保存結果が週キャッシュにも反映される', () => {
  // 反映しないと、週を移動して戻ったときに保存前の状態へ表示が巻き戻る
  assert.match(fnBody(reflection, 'applyReflectionLocal'), /p2UpdateCurrentWeekCache\(\)/);
});
