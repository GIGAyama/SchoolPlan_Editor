import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 編集モードでもコピー＆ペースト等のセル操作を使えるようにした変更の回帰防止(静的検査)。
// 壊れると「編集中の入力が消える」「古い値がコピーされる」など見つけにくい不具合になるため、
// 要となる呼び出し順・ガードをソース側で固定しておく。

const read = file => fs.readFileSync(file, 'utf8');

const core = read('App_Js_01_Core.html');
const plan = read('App_Js_02_Plan.html');
const css = read('App_Css_04_CellOps.html');
const app = read('App.html');

/** plan から関数 1 つ分の本文を取り出す（次の同インデントの function 宣言まで）。 */
function fnBody(name) {
  const start = plan.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  const rest = plan.slice(start + 1);
  const next = rest.search(/\n {4}(?:function |var |const |\/\/ =====)/);
  return rest.slice(0, next === -1 ? undefined : next);
}

test('編集開始時のスナップショットで未保存判定とキャンセルを行う', () => {
  // 編集モードのセル操作は STATE.weekData.days を書き換えるため、
  // days と比べる未保存判定では「操作したのに変更なし」と誤判定して保存が飛ぶ
  assert.match(core, /editBaseline: null,/);
  assert.doesNotMatch(core, /editBuffer/);
  assert.match(fnBody('hasUnsavedChanges'), /STATE\.editBaseline \|\| STATE\.weekData\.days/);
  assert.match(fnBody('exitEditMode'), /STATE\.weekData\.days = baseline/);
  assert.match(fnBody('syncEditBaseline'), /STATE\.editBaseline = null/);
  // 出入りの全経路が通る updateEditUI でスナップショットを取り／捨てする
  assert.match(fnBody('updateEditUI'), /syncEditBaseline\(\)/);
  // 保存が通ったらスナップショットは捨てる（直後の cancelEdit が巻き戻さないように）
  assert.match(fnBody('adoptSavedWeekDays'), /STATE\.editBaseline = null/);
});

test('セル操作は入力欄の内容を取り込んでから days を読み書きする', () => {
  assert.match(fnBody('syncEditBufferToState'), /STATE\.weekData\.days = current/);
  // 履歴に積む時点で取り込む。取り込まずに積むと入力途中の内容が履歴から抜ける
  assert.match(fnBody('pushUndo'), /syncEditBufferToState\(\)/);
  assert.match(fnBody('copyCellData'), /syncEditBufferToState\(\)/);
  assert.match(fnBody('undo'), /syncEditBufferToState\(\)/);
  assert.match(fnBody('redo'), /syncEditBufferToState\(\)/);
  // D&D は独自に回収せず pushUndo に一本化する
  assert.doesNotMatch(fnBody('handleDrop'), /collectCurrentEditData/);
});

test('sync で days が差し替わるため day は pushUndo の後に取り直す', () => {
  for (const name of ['pasteCellData', 'clearCellData']) {
    const body = fnBody(name);
    const undoAt = body.indexOf('pushUndo()');
    const dayAt = body.indexOf('var day = STATE.weekData.days[s.day]');
    assert.notEqual(undoAt, -1, `${name}: pushUndo not found`);
    assert.notEqual(dayAt, -1, `${name}: day lookup not found`);
    assert.ok(dayAt > undoAt, `${name}: day は pushUndo の後に取り直すこと`);
  }
});

test('セル操作後の再描画は編集中のフォーカスとカーソル位置を保つ', () => {
  assert.match(fnBody('rerenderGridPreservingFocus'), /captureGridFocus\(\)[\s\S]*renderWeekGrid[\s\S]*restoreGridFocus/);
  assert.match(fnBody('restoreGridFocus'), /setSelectionRange/);
  for (const name of ['pasteCellData', 'clearCellData', 'undo', 'redo', 'handleDrop', 'handleContextAction']) {
    assert.match(fnBody(name), /rerenderGridPreservingFocus\(\)/, `${name} が素の renderWeekGrid を呼んでいる`);
  }
});

test('編集モードでも選択セルが入力欄のフォーカスに追従する', () => {
  // selectCell は編集モードでフォーカスを奪ってはいけない（入力が中断される）
  assert.match(fnBody('selectCell'), /opts && opts\.keepFocus/);
  assert.match(plan, /addEventListener\('focusin'/);
  assert.match(plan, /selectCellFromElement/);
});

test('編集モードの文字操作を奪わない', () => {
  // 文字を選択している間は、ブラウザ標準のコピー／右クリックメニューを優先する
  assert.match(plan, /if \(isEdit && hasTextSelection\(e\.target\)\) return;/);
  // セル内のリンクの右クリックはブラウザ標準（新しいタブで開く等）に任せる
  assert.match(plan, /e\.target\.closest\('a'\)\) return;/);
  assert.match(plan, /isGridInput\(e\.target\) && !hasTextSelection\(e\.target\)/);
  // 長押しは編集モードでは取り付けない（文字選択・標準の貼り付けに使う）
  assert.match(plan, /if \(rowDef\.multi && !isEdit\) \{\s*\n\s*attachTouchLongPress/);
});

test('コピーしたコマの貼り付けだけがセル単位のペーストになる', () => {
  assert.match(fnBody('copyCellData'), /STATE\.clipboardText = plainText/);
  assert.match(fnBody('isCellClipboardText'), /text === STATE\.clipboardText/);
  // 種類違いは静かに文字の貼り付けへ引き返す
  assert.match(plan, /pasteCellData\(\{ silent: true \}\)/);
  assert.match(fnBody('pasteCellData'), /opts && opts\.silent/);
});

test('セル操作メニューは両モード・校時以外の行からも開ける', () => {
  // 校時セル限定だったコンテキストメニューを全セルへ広げる
  assert.doesNotMatch(plan, /if \(rowDef\.multi\) \{\s*\n\s*cell\.addEventListener\('contextmenu'/);
  const menu = fnBody('showContextMenu');
  assert.match(menu, /ctxItem\('copy'/);
  assert.match(menu, /ctxItem\('paste'/);
  // 校時限定の操作は校時セルだけに出す
  assert.match(menu, /if \(isPeriod\) \{[\s\S]*clearDay[\s\S]*clearPeriod/);
  // 入力欄では Ctrl+Z が文字取り消しに使われるため、取り消しの入口をメニューにも置く
  assert.match(menu, /ctxItem\('undo'/);
  assert.match(menu, /ctxItem\('redo'/);
  assert.match(fnBody('handleContextAction'), /case 'undo':/);
  // 校時限定の操作を校時以外のセルで実行させない
  assert.match(fnBody('handleContextAction'), /case 'clearDay':\s*\n\s*if \(!isPeriod\) break;/);
});

test('編集モードのタッチ操作用に選択セルのハンドルを1つだけ出す', () => {
  const handle = fnBody('updateCellActionHandle');
  assert.match(handle, /if \(!STATE\.editMode \|\| !cell\) return;/);
  assert.match(handle, /cellActionHandle/);
  // 入力中のフォーカスとカーソル位置を奪わない
  assert.match(handle, /mousedown[\s\S]*preventDefault/);
  // 既存のセル内ボタン（リンク挿入・タスク選択）と重ならない位置に置く
  assert.match(handle, /link-insert-btn/);
  assert.match(handle, /field-task-btn/);
  // 再描画でセルごと作り直されるため付け直す
  assert.match(fnBody('renderWeekGrid'), /refreshCellActionHandle\(\)/);
  assert.match(css, /\.cell-action-handle \{/);
  // App_Css.html は保守性の警告閾値(5000行)に達しているので追加分は別ファイルに置く
  assert.match(read('App.html'), /include\('App_Css_04_CellOps'\)/);
  // 編集モードの選択セルは背景を塗らない（入力文字が読みにくくなる）
  assert.match(css, /\.edit-mode \.grid-cell\.selected \{[\s\S]*background: white !important;/);
});

test('編集モードの操作ヒントと使い方の説明が実装と揃っている', () => {
  assert.match(app, /id="modeHint"/);
  assert.match(css, /\.mode-hint \{/);
  const help = fnBody('showShortcutHelp');
  assert.match(help, /文字を選択していない時にコマ全体のコピー/);
  assert.match(help, /セル操作メニュー（編集モード）/);
});
