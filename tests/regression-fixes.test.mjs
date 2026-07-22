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
  const clears = plan.match(/STATE\.performance\.weekCache = \{\}/g) || [];
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
