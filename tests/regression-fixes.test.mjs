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
