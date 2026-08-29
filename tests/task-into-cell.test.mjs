import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bootClient, setWeek, makeDays } from './helpers/webapp-sandbox.mjs';

// 週案の右のサイドパネルまわりの回帰防止。
//   1. タスクカードから、週案のセルへ直接タスクを書き込めること（編集モードのみ）
//   2. サイドパネルを「今週のタスク」と「行事予定PDF」で切り替えられること
// 1 の書き込み先はセルの入力欄。閲覧モードは読むだけなので、書き込まずに案内を出す
// （書き込めてしまうと、そのまま保存されずに消える）。

const read = file => fs.readFileSync(file, 'utf8');

const core = read('App_Js_01_Core.html');
const plan = read('App_Js_02_Plan.html');
const events = read('App_Js_08_Events.html');
const task = read('App_Js_11_Task.html');
const css = read('App_Css.html');
const app = read('App.html');

/** plan から関数 1 つ分の本文を取り出す（次の同インデントの宣言まで）。 */
function fnBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n {4}(?:function |var |const |\/\*\*|\/\/ =====|document\.)/);
  return rest.slice(0, next === -1 ? undefined : next);
}

/**
 * タスクを入れられる状態のサンドボックスを起動する。
 * 書き込み先はセルの入力欄なので、セレクタごとに同じ要素を返す DOM で動かす。
 */
function bootWithTasks(tasks, opts = {}) {
  const h = bootClient({ gridInputs: true });
  // タスク一覧のビュー更新は App_Js_11_Task 側。ここでは呼ばれたことだけ数える。
  h.run('var __taskViewRefreshes = 0; refreshTaskViews = function () { __taskViewRefreshes++; };');
  setWeek(h, '2026/08/17', makeDays());
  h.STATE.allTaskData = tasks;
  h.STATE.taskDataLoaded = true;
  if (opts.viewMode !== true) h.run('setEditMode(true)');
  return h;
}

/** 編集モードのセルの入力欄の中身。書き込み先はここ（週データではない）。 */
function cellValue(h, dayIdx, rowKey) {
  const m = /^period([0-5])$/.exec(rowKey);
  const selector = m
    ? `[data-field="content"][data-day="${dayIdx}"][data-period="${m[1]}"]`
    : `[data-field="${rowKey}"][data-day="${dayIdx}"]:not([data-period])`;
  return h.gridInput(selector).value;
}

const TASK = { id: 't1', content: '算数のプリントを印刷する', resource: 'プリント20枚', status: '未着手', dueDate: '2026-08-19' };

test('コマへ入れると、学習内容の入力欄の末尾にタスクが書かれる', () => {
  const h = bootWithTasks([{ ...TASK }]);
  const ok = h.run(`insertTasksIntoCell(1, 'period2', [STATE.allTaskData[0]])`);
  assert.equal(ok, true);
  assert.equal(cellValue(h, 1, 'period2'), '☐算数のプリントを印刷する\n・プリント20枚');
  // 教科・単元は触らない（コマの中身を壊さない）
  assert.match(h.STATE.weekData.days[1].periods[2].subject, /^教科火/);
});

test('すでに書かれている内容は消さず、そのあとに足す', () => {
  const h = bootWithTasks([{ ...TASK }]);
  h.gridInput('[data-field="morning"][data-day="0"]:not([data-period])').value = '朝読書';
  h.run(`insertTasksIntoCell(0, 'morning', [STATE.allTaskData[0]])`);
  assert.equal(cellValue(h, 0, 'morning'),
    '朝読書\n☐算数のプリントを印刷する\n・プリント20枚');
});

test('空き時間のコマでは、区切りより後ろ（タスク欄）に入る', () => {
  const h = bootWithTasks([{ ...TASK }]);
  const divider = h.run('FREE_TASK_DIVIDER');
  h.gridInput('[data-field="content"][data-day="2"][data-period="0"]').value = '自習\n' + divider + '\n';
  h.run(`insertTasksIntoCell(2, 'period0', [STATE.allTaskData[0]])`);
  const content = cellValue(h, 2, 'period0');
  assert.ok(content.indexOf(divider) < content.indexOf('☐算数のプリントを印刷する'),
    '空き時間のタスクは区切りより後ろに入ること');
});

test('入れただけでは保存を送らない（保存は「保存する」を押したとき）', () => {
  const h = bootWithTasks([{ ...TASK }]);
  h.run(`insertTasksIntoCell(3, 'afterschool', [STATE.allTaskData[0]])`);
  h.clock.advance();
  const saves = h.inflight.filter(c => /^saveWeeklyPlanData/.test(c.name));
  assert.equal(saves.length, 0, '入力欄へ書いただけで保存を飛ばさないこと');
  assert.equal(h.clock.pending, 0, '遅延保存のタイマーも仕掛けないこと');
});

test('閲覧モードでは書き込まず、編集モードへの入り方を知らせる', () => {
  const h = bootWithTasks([{ ...TASK }], { viewMode: true });
  const before = JSON.stringify(h.STATE.weekData.days);
  const ok = h.run(`insertTasksIntoCell(1, 'period2', [STATE.allTaskData[0]])`);
  assert.equal(ok, false);
  assert.equal(cellValue(h, 1, 'period2'), '', '入力欄にも書かないこと');
  assert.equal(JSON.stringify(h.STATE.weekData.days), before, '週データも触らないこと');
  assert.ok(h.toasts.some(([type, msg]) => type === 'info' && /閲覧モード/.test(msg)));
  // タスクのステータスも動かさない（入れていないのに進行中になってしまう）
  assert.equal(h.STATE.allTaskData[0].status, '未着手');
});

test('未着手のタスクは、入れた時点で進行中になる', () => {
  const h = bootWithTasks([{ ...TASK }]);
  h.run(`insertTasksIntoCell(0, 'preclass', [STATE.allTaskData[0]])`);
  assert.equal(h.STATE.allTaskData[0].status, '進行中');
  const sent = h.inflight.filter(c => c.name === 'updateTaskStatusFromWebApp');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].args, ['t1', '進行中']);
});

test('進行中のタスクは、入れてもステータスを触らない', () => {
  const h = bootWithTasks([{ ...TASK, status: '進行中' }]);
  h.run(`insertTasksIntoCell(0, 'preclass', [STATE.allTaskData[0]])`);
  assert.equal(h.STATE.allTaskData[0].status, '進行中');
  assert.equal(h.inflight.filter(c => c.name === 'updateTaskStatusFromWebApp').length, 0);
});

test('週のデータが無いときは、書き込まずに知らせる', () => {
  const h = bootWithTasks([{ ...TASK }]);
  h.STATE.weekData = null;
  const ok = h.run(`insertTasksIntoCell(0, 'morning', [STATE.allTaskData[0]])`);
  assert.equal(ok, false);
  assert.ok(h.toasts.some(([type]) => type === 'error'));
});

test('運んできたカードは、落としたセルへ入る', () => {
  const h = bootWithTasks([{ ...TASK }]);
  h.STATE.dragTaskId = 't1';
  h.run(`dropTaskOnCell_({ dataset: { day: '4', row: '10', key: 'period5' } })`);
  assert.equal(cellValue(h, 4, 'period5'), '☐算数のプリントを印刷する\n・プリント20枚');
  // 運び終えたら、次のドラッグに持ち越さない
  assert.equal(h.STATE.dragTaskId, null);
  // どこへ入れたかが分かるように、そのセルを選んでおく
  const sel = h.STATE.selectedCell;
  assert.equal(sel.day, 4);
  assert.equal(sel.row, 10);
  assert.equal(sel.key, 'period5');
});

test('セルを選ばずにボタンを押したら、先に選ぶよう知らせる', () => {
  const h = bootWithTasks([{ ...TASK }]);
  h.STATE.selectedCell = null;
  h.run(`insertTaskIntoSelectedCell('t1')`);
  assert.ok(h.toasts.some(([type]) => type === 'warning'));
  assert.equal(cellValue(h, 0, 'morning'), '');
});

// ===== 静的検査: 画面まわりの配線 =====

test('書き込み先は入力欄だけ（週データを直接触らない）', () => {
  const body = fnBody(plan, 'insertTasksIntoCell');
  // 入力欄の値が「本当の値」。days を書き換えると、打っている途中の文字が消える
  assert.match(body, /el\.value = appendTaskText_\(el\.value, addText\)/);
  assert.match(body, /autoResizeTextarea\(el\)/);
  assert.doesNotMatch(body, /STATE\.weekData\.days\[dayIdx\]\s*=|day\[rowKey\] =/);
  // 閲覧モードの分岐（days を直接書いて自動保存する道）は無くした
  assert.doesNotMatch(body, /persistViewMutation|pushUndo/);
  assert.match(body, /if \(!requireEditMode\(\)\) return false;/);
});

test('タスクカードは、つかんで週案セルへ運べる', () => {
  // カードは描き直されるので、個々ではなく document 側で一度だけ受ける
  assert.match(task, /draggable="true"\s*\n\s*data-task-id=/);
  assert.match(task, /document\.addEventListener\('dragstart'/);
  assert.match(task, /STATE\.dragTaskId = card\.getAttribute\('data-task-id'\)/);
  // タッチ端末にはドラッグが無いので、選択中のセルへ入れるボタンも要る
  assert.match(task, /insertTaskIntoSelectedCell\('\$\{escHtmlAttr\(t\.id\)\}'\)/);
  // アイコンは焼き込んだサブセットに入っているものだけ使う（無いと英単語がそのまま出る）
  assert.match(task, /class="material-symbols-outlined">note_add</);
  // 運び終わり（ドロップしなかったときも含む）に必ず持ち越しを消す
  assert.match(task, /document\.addEventListener\('dragend'/);
  assert.match(task, /STATE\.dragTaskId = null/);
});

test('どの行のセルでもタスクを受け取れる', () => {
  // 受け取り側は全部の行に付ける。コマの持ち出し(dragstart)だけが校時セル限定
  const render = fnBody(plan, 'renderWeekGrid');
  const accept = render.indexOf("cell.addEventListener('drop', handleDrop)");
  const multi = render.indexOf('if (rowDef.multi) {');
  assert.notEqual(accept, -1);
  assert.ok(accept < multi, 'ドロップの受け取りは rowDef.multi の分岐より前に付けること');
  // コマの入れ替えは、これまで通りコマ同士だけ
  assert.match(fnBody(plan, 'handleDragOver'), /if \(!STATE\.dragSource\) return;/);
  assert.match(fnBody(plan, 'handleDrop'), /if \(STATE\.dragTaskId\) \{/);
  assert.match(css, /\.grid-cell\.drag-over-task \{/);
});

test('サイドパネルは、今週のタスクと行事予定PDFを切り替えられる', () => {
  assert.match(app, /onclick="setPlanSidebarPane\('task'\)"/);
  assert.match(app, /onclick="setPlanSidebarPane\('event'\)"/);
  assert.match(app, /id="sidebarEventPdf"/);
  assert.match(app, /id="planEventPdfSelect"/);

  const body = fnBody(core, 'setPlanSidebarPane');
  // 選んだ側は次に開いたときも残す
  assert.match(body, /localStorage\.setItem\('planSidebarPane', pane\)/);
  // タブを押したのに収納されたままだと、何も起きていないように見える
  assert.match(body, /sidebar\.classList\.remove\('collapsed'\)/);
  assert.match(body, /ensurePlanEventPdfReady\(\)/);
  // 起動時に前回の選択を復元する
  assert.match(fnBody(core, 'restoreTaskSidebarState'), /setPlanSidebarPane\(/);
});

test('行事予定PDFは、行事予定タブと同じ一覧から選ぶ', () => {
  // 一覧を取り直したら、サイドパネル側も描き直す（片方だけ古いままにしない）
  assert.match(fnBody(events, 'loadEventPdfLibrary'), /renderPlanEventPdfPanel\(\)/);
  const body = fnBody(events, 'renderPlanEventPdfPanel');
  assert.match(body, /planEventPdfFiles_\(\)/);
  // 前に開いていたPDFが今もあればそれを開く
  assert.match(body, /localStorage\.getItem\('planEventPdfId'\)/);
  // 同じPDFを出し直すと、開いていたページまで戻ってしまう
  assert.match(fnBody(events, 'showPlanEventPdf_'), /body\.querySelector\('iframe'\)/);
});
