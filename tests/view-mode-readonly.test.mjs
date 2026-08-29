import test from 'node:test';
import assert from 'node:assert/strict';

import { bootClient, makeDays, setWeek, clone } from './helpers/webapp-sandbox.mjs';

// 閲覧モードが本当に「読むだけ」になっていることの回帰防止。
//
// もともと週案は、閲覧モードでもコマの入れ替え・クリア・ペースト・元に戻すができ、
// そのための自動保存（persistViewMutation）が編集モードの保存とは別に走っていた。
// 保存の真実が「編集モードの入力欄」と「閲覧モードの days 直接書き換え」の2つに
// 分かれていたため、モードの切り替えのたびに突き合わせが要り、その取りこぼしで
// 「ツールバーは閲覧モードなのにグリッドは編集用の入力欄のまま」という状態が
// 生まれていた。そこへ打った文字はどの保存経路にも拾われず消えていた。
//
// 書き換えは編集モードだけと決め、閲覧モードからは経路ごと無くした。
// ここでは実物のクライアントコードを読み込んで、その線引きを確かめる。

/** 週データを書き換えるセル操作。閲覧モードではどれも効いてはいけない。 */
const CELL_OPS = [
  "handleContextAction('clearDay', 0, 0)",
  "handleContextAction('clearPeriod', 0, 0)",
  'clearCellData()',
  'pasteCellData()',
  'undo()',
  'redo()',
  "handleDrop({ preventDefault: function () {} })",
];

/** 閲覧モードで、月曜1校時を選んだ状態のクライアントを用意する。 */
function bootViewMode(options) {
  const c = bootClient(options);
  setWeek(c, '2026/08/17', makeDays());
  // コマを1つコピーしておく（ペーストが「貼るものが無い」で素通りしないように）
  c.run('setEditMode(true); selectCell(0, 3, "period0"); copyCellData(); exitEditMode();');
  c.run('selectCell(0, 3, "period0")');
  assert.equal(c.STATE.editMode, false);
  return c;
}

for (const variant of [
  { label: 'V2保存', options: {} },
  { label: '保護版保存', options: { protectedOverrides: true } },
]) {

test(`閲覧モードのセル操作は、週データを書き換えず案内だけ出す（${variant.label}）`, () => {
  const c = bootViewMode(variant.options);
  const before = JSON.stringify(c.STATE.weekData.days);
  const seqBefore = c.run('weekDaysMutationSeq()');
  c.toasts.length = 0;

  for (const op of CELL_OPS) c.run(op);
  c.clock.advance();

  assert.equal(JSON.stringify(c.STATE.weekData.days), before, '週データを書き換えてはいけない');
  assert.equal(c.run('weekDaysMutationSeq()'), seqBefore, '書き換えの記録も増えないこと');
  assert.equal(c.inflight.length, 0, '閲覧モードから保存を送ってはいけない');
  assert.equal(c.clock.pending, 0, '遅延保存のタイマーを仕掛けてはいけない');
  assert.ok(c.toasts.some(([type, msg]) => type === 'info' && /閲覧モード/.test(msg)),
    'どうすれば編集できるかを知らせること');
  // 案内を出すだけ。勝手に編集モードへは入らない（それが今回の不具合の温床だった）
  assert.equal(c.STATE.editMode, false);
});

test(`編集モードにすれば、同じセル操作が効いて手動保存に載る（${variant.label}）`, () => {
  const c = bootViewMode(variant.options);
  c.run('setEditMode(true)');
  const seqBefore = c.run('weekDaysMutationSeq()');

  c.run("handleContextAction('clearDay', 0, 0)");
  assert.ok(c.STATE.weekData.days[0].periods.every(p => !p.subject && !p.unit && !p.content),
    '編集モードならクリアが効くこと');
  assert.ok(c.run('weekDaysMutationSeq()') > seqBefore);
  // セル操作だけでは送らない。保存は「保存する」を押したときだけ。
  c.clock.advance();
  assert.equal(c.inflight.length, 0);
  assert.equal(c.clock.pending, 0, '遅延保存のタイマーを仕掛けてはいけない');

  c.run('saveWeeklyPlan()');
  assert.equal(c.inflight.length, 1, '「保存する」で送ること');
  const sent = c.inflight[0].args[1];
  assert.ok(sent[0].periods.every(p => !p.subject), 'クリアした内容が送られること');
});

test(`閲覧モードでは、タスクをセルへ書き込まない（${variant.label}）`, () => {
  const c = bootViewMode(variant.options);
  c.STATE.allTaskData = [{ id: 't1', title: '色鉛筆を用意', status: '未着手' }];
  const before = JSON.stringify(c.STATE.weekData.days);
  c.toasts.length = 0;

  const wrote = c.run("insertTasksIntoCell(0, 'morning', [STATE.allTaskData[0]])");
  assert.equal(wrote, false);
  assert.equal(JSON.stringify(c.STATE.weekData.days), before);
  assert.equal(c.inflight.length, 0);
  assert.ok(c.toasts.some(([type, msg]) => type === 'info' && /閲覧モード/.test(msg)));
});

test(`閲覧モードでは、セル操作メニューを開かない（${variant.label}）`, () => {
  const c = bootViewMode(variant.options);
  let created = 0;
  c.context.document.createElement = () => { created++; return Object.create({}); };
  c.run("showContextMenu({ pageX: 10, pageY: 10 }, 0, 0, 'period0')");
  assert.equal(created, 0, '閲覧モードではメニューを組み立てないこと');
});

test(`編集モードを抜けるときは、ツールバーだけでなくグリッドも描き直す（${variant.label}）`, () => {
  // 報告された不具合そのもの。タブ切替の autoSaveAndThen が「保存するものが無い」で
  // 抜ける経路で、以前は STATE.editMode を落として updateEditUI() を呼ぶだけだった。
  // グリッドは編集用の入力欄を抱えたまま残り、そこへ打った文字は保存されずに消えていた。
  const c = bootViewMode(variant.options);
  c.run('setEditMode(true)');
  const before = c.renders.length;

  c.run('__switched = false; autoSaveAndThen(function () { __switched = true; });');
  c.clock.advance();

  assert.equal(c.run('__switched'), true, '保存するものが無いなら、画面の切り替えは進むこと');
  assert.equal(c.STATE.editMode, false);
  assert.ok(c.renders.length > before, 'モードを落としたのにグリッドを描き直していない');
});

test(`編集モードを抜けると、取り消し履歴も持ち越さない（${variant.label}）`, () => {
  // exitEditMode は days を編集開始時のスナップショットへ巻き戻す。その途中の状態を
  // 指す履歴を残すと、次に編集モードへ入って「元に戻す」を押した瞬間に、
  // 捨てたはずの変更が復活してしまう。
  const c = bootViewMode(variant.options);
  c.run('setEditMode(true)');
  c.run("handleContextAction('clearDay', 0, 0)");
  assert.ok(c.STATE.undoStack.length > 0);

  c.run('exitEditMode()');
  assert.equal(c.STATE.undoStack.length, 0);
  assert.equal(c.STATE.redoStack.length, 0);
  assert.ok(c.STATE.weekData.days[0].periods[0].subject, 'キャンセルで内容が戻ること');
});

}

test('保存の往復中に使ったセル操作が、保存応答の取り込みで消えない', () => {
  // 「保存する」を押したあともグリッドは操作できる。応答（＝保存した時点の内容）で
  // 手元を上書きすると、待つあいだに行ったセル操作がまとめて巻き戻る。
  const c = bootClient({ protectedOverrides: true });
  setWeek(c, '2026/08/17', makeDays());
  c.run('setEditMode(true)');
  const sentDays = clone(c.STATE.weekData.days);

  c.run('saveWeeklyPlan()');
  assert.equal(c.inflight.length, 1);

  // 応答を待つあいだに水曜をクリアする
  c.run("handleContextAction('clearDay', 2, 0)");
  const call = c.inflight.shift();
  call.handlers.ok({ success: true, message: 'saved', revision: 'r2', days: sentDays });
  c.clock.advance();

  assert.ok(c.STATE.weekData.days[2].periods.every(p => !p.subject),
    '保存応答の取り込みでクリアが消えてはいけない');
  // 間に合わなかった分は、そのまま1回だけ保存し直す
  assert.equal(c.inflight.length, 1, '取りこぼした変更を保存し直すこと');
  assert.ok(c.inflight[0].args[1][2].periods.every(p => !p.subject));
});
