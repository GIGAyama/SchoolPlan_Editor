import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 監査で修正した不具合の再発防止(静的検査)。
// 対象: V1残骸の削除・保護バイパス経路の封鎖・キャッシュ無効化・クライアント小修正。

const read = file => fs.readFileSync(file, 'utf8');

const core = read('App_Js_01_Core.html');
const plan = read('App_Js_02_Plan.html');
const multiClass = read('App_Js_14_MultiClass.html');
const utils = read('App_Js_09_Utils.html');

test('V1 week-plan client endpoints are gone', () => {
  // V1のdoLoadWeeklyPlanはレースガードが無く、週移動連打で古い応答が新しい週を上書きした
  assert.doesNotMatch(core, /\.getWeeklyPlanData\(/);
  assert.doesNotMatch(core, /\[DEBUG\]/);
  // V1保存はスナップショット無し・数式列破壊のV1サーバーAPIを呼んでいた
  assert.doesNotMatch(plan, /\.saveWeeklyPlanData\(/);
});

test('shared save-state variables remain declared in App_Js_02_Plan', () => {
  // App_Js_14(V2)と App_Js_15(保護版)の保存実装がこれらを参照する
  assert.match(plan, /var _autoSaving = false;/);
  assert.match(plan, /var _viewSaveTimer = null;/);
});

test('batch autofill and shift lessons use the protected save and clear the week cache', () => {
  assert.match(plan, /'batch-autofill'/);
  assert.match(plan, /'shift-lessons'/);
  // 複数週を書き換える処理の後は他週のクライアントキャッシュを破棄する
  // (破棄は p2InvalidateWeekCache に集約してある。App_Js_14_MultiClass 参照)
  const clears = plan.match(/p2InvalidateWeekCache\(\)/g) || [];
  assert.ok(clears.length >= 2, `expected weekCache clears after batch operations, got ${clears.length}`);
});

test('only the guarded loadMasterData implementation remains', () => {
  assert.doesNotMatch(core, /function loadMasterData/);
  assert.match(multiClass, /function loadMasterData/);
});

test('unit master mutations invalidate the week-plan suggestion cache', () => {
  // loadMasterData は STATE.masterData が残っていると何もしないため、
  // 変更後は invalidateMasterData で確実に再取得する
  assert.match(multiClass, /function invalidateMasterData/);
  const unitMaster = read('App_Js_12_UnitMaster.html');
  const calls = unitMaster.match(/invalidateMasterData\(\)/g) || [];
  assert.ok(calls.length >= 3, `expected invalidateMasterData after each unit-master mutation, got ${calls.length}`);
  assert.match(read('App_Js_07_PdfImport.html'), /invalidateMasterData/);
  assert.match(read('App_Js_15_DataProtection_Overrides.html'), /invalidateMasterData/);
});

test('V2 bootstrap syncs settings state (grade / tenant info)', () => {
  const bootstrap = multiClass.slice(multiClass.indexOf('.getAppBootstrapV2') - 3000, multiClass.indexOf('.getAppBootstrapV2'));
  assert.match(bootstrap, /loadSettingsView/);
});

test('deferred bootstrap failure retries instead of leaving the task panel empty', () => {
  assert.match(multiClass, /deferredRetries/);
  assert.match(multiClass, /p2ShowDeferredRetryUI/);
});

test('warning toasts render with the warning icon', () => {
  assert.match(utils, /warning: 'warning'/);
});

test('print options are persistent and the todo list is toggleable and capped', () => {
  const print = read('App_Js_03_Print.html');
  assert.match(print, /weeklyPrintOpts/);
  assert.match(print, /id="po_todo"/);
  assert.match(print, /TODO_PRINT_MAX = 14/);
  assert.match(print, /他' \+ todoOverflow \+ '件/);
});

test('hours tab has a refresh action', () => {
  assert.match(read('App_Js_05_Hours.html'), /function refreshHoursView/);
  assert.match(read('App.html'), /refreshHoursView\(\)/);
});

test('small client fixes stay in place', () => {
  // 設定保存後の再読込は「読み込み中」トーストを出さない
  const settings = read('App_Js_10_Settings.html');
  assert.match(settings, /loadSystemSettings\(\{ silent: true \}\)/);
  // 学級切替は自動保存前にセレクト表示を現在の学級へ戻す
  const switcher = multiClass.slice(multiClass.indexOf('function onClassSwitcherChange'), multiClass.indexOf('function switchMultiClass'));
  assert.match(switcher, /renderClassSwitcher\(\);/);
  // 学級通信の redo は編集中の内容を保存してから履歴を進める
  const newsletter = read('App_Js_06_Newsletter.html');
  const redo = newsletter.slice(newsletter.indexOf('NW.redo ='), newsletter.indexOf('NW._restoreHistory ='));
  assert.match(redo, /NW\.saveEditable\(\)/);
  // 週データが不完全でも印刷・タスクパネルが例外で止まらない
  const print = read('App_Js_03_Print.html');
  assert.match(print, /days\[0\]\.date && days\[6\] && days\[6\]\.date/);
  assert.match(read('App_Js_11_Task.html'), /days\.length < 7/);
});

test('SweetAlert2 dialogs and toasts stack above every in-app overlay', () => {
  // PDFプレビュー(.pdf-preview-overlay: z-index 1200)の上で確認ダイアログを出すと、
  // SweetAlert2デフォルト(1060)のままでは後ろに隠れて操作できなかった
  const css = read('App_Css.html');
  const swalMatch = css.match(/\.swal2-container\s*\{[^}]*?z-index:\s*(\d+)/);
  assert.ok(swalMatch, 'expected a .swal2-container z-index override in App_Css.html');
  const swalZ = parseInt(swalMatch[1], 10);
  const allZ = [...css.matchAll(/z-index:\s*(\d+)/g)].map(m => parseInt(m[1], 10));
  const maxZ = Math.max(...allZ);
  assert.equal(swalZ, maxZ, `.swal2-container (${swalZ}) must be the highest z-index in App_Css.html (max: ${maxZ})`);
  assert.equal(allZ.filter(z => z === maxZ).length, 1,
    'no other element may share the top z-index with .swal2-container');
});

// ===== 保存の競合(楽観ロック)の誤検知対策 =====
// 単独利用でも「保存の競合」が頻発していた。原因は2つ:
//   1) 保存応答のリビジョンをメモリ上の行から算出していた。スプレッドシートは
//      setValues 時に値を解釈し直す("1/3"→日付、"007"→7 など)ため、クライアントの
//      リビジョンがシート実データと恒久的にずれ、以降の保存が毎回競合になった。
//   2) 手動保存と画面切替の自動保存が同時に飛び、後着が保存前のリビジョンを送っていた。

test('save response revision is computed from the sheet after the write', () => {
  const perf = read('12_Performance.gs');
  const fn = perf.slice(perf.indexOf('function saveWeeklyPlanDataV2'), perf.indexOf('function getDbSchemaDiagnosticsFromWeb'));
  const writeAt = fn.indexOf('p2WriteChangedWeekRows_(dbSheet');
  const flushAt = fn.indexOf('SpreadsheetApp.flush()', writeAt);
  const rereadAt = fn.indexOf('p2ReadRowsForDates_(dbSheet', writeAt);
  const revisionAt = fn.indexOf('const newRevision =');
  assert.ok(writeAt >= 0 && flushAt > writeAt && rereadAt > writeAt,
    'the week rows must be re-read from the sheet after writing');
  assert.ok(revisionAt > rereadAt, 'newRevision must be derived from the re-read rows');
  assert.match(fn.slice(revisionAt, revisionAt + 160), /afterState/);
  // 正規化後の値をクライアントへ返し、手元のデータをシートに揃える
  assert.match(fn, /days: savedDays/);
});

test('a revision mismatch is only a conflict when it would overwrite changes', () => {
  const perf = read('12_Performance.gs');
  const fn = perf.slice(perf.indexOf('function saveWeeklyPlanDataV2'), perf.indexOf('function getDbSchemaDiagnosticsFromWeb'));
  assert.match(fn, /currentRevision !== baseRevision && uniqueChangedRows\.length > 0/);
  // 競合応答には差分提示・上書き再送のための現在値を含める
  assert.match(fn, /current: \{ mondayDateStr, revision: currentRevision, days: beforeDays \}/);
  // 判定は変更適用後に行うが、書き込みより前であること
  assert.ok(fn.indexOf('conflict: true') < fn.indexOf('p2WriteChangedWeekRows_(dbSheet'));
});

test('every client save path goes through the serialization gate', () => {
  assert.match(plan, /function beginSaveRequest/);
  assert.match(plan, /function endSaveRequest/);
  assert.match(plan, /function whenSaveIdle/);
  assert.match(plan, /function adoptSavedWeekDays/);
  for (const [name, source] of [['App_Js_14_MultiClass', multiClass],
                                ['App_Js_15_DataProtection_Overrides', read('App_Js_15_DataProtection_Overrides.html')]]) {
    const begins = source.match(/beginSaveRequest\(\)/g) || [];
    const ends = source.match(/endSaveRequest\(\)/g) || [];
    assert.ok(begins.length >= 3, `${name}: expected the gate on manual/auto/view saves, got ${begins.length}`);
    // 成功・失敗の両ハンドラで解放する(3経路×2)
    assert.ok(ends.length >= 6, `${name}: expected endSaveRequest in both handlers, got ${ends.length}`);
    assert.match(source, /adoptSavedWeekDays\(result, days/);
  }
  // 「保存してから実行」系も同じゲートを通す
  assert.match(plan, /function saveCurrentWeekOnce/);
  assert.match(plan, /await saveCurrentWeekOnce\('batch-autofill'\)/);
  assert.match(plan, /await saveCurrentWeekOnce\('shift-lessons'\)/);
});

test('the conflict dialog shows what differs and offers a non-destructive choice', () => {
  assert.match(plan, /function handleSaveConflict\(result, attemptedDays, overwrite\)/);
  assert.match(plan, /function summarizeWeekDiff/);
  const dialog = plan.slice(plan.indexOf('function handleSaveConflict'), plan.indexOf('// ====='  , plan.indexOf('function handleSaveConflict')));
  assert.match(dialog, /denyButtonText: 'この内容で上書き'/);
  assert.match(dialog, /cancelButtonText: '編集を続ける'/);
});
