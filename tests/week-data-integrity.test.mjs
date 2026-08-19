import test from 'node:test';
import assert from 'node:assert/strict';
import { bootClient, setWeek, makeDays, clone } from './helpers/webapp-sandbox.mjs';

// 週データの読み書きで「別のデータが混ざる」「入力が消える」経路の回帰防止。
//
// このアプリはスプレッドシートが唯一の保存先で、画面の状態がそのまま保存される。
// そのため、画面上のデータが別の週・別の学級のものに入れ替わると、
// そのまま保存されて利用者のデータが失われる。

const subjectsOf = days => days.map(d => d.periods[0].subject).join(',');

for (const variant of [
  { label: 'V2保存', options: {} },
  { label: '保護版保存', options: { protectedOverrides: true } }
]) {

  test(`週を移動したあとの「元に戻す」が前の週の内容を持ち込まない（${variant.label}）`, () => {
    const c = bootClient(variant.options);
    setWeek(c, '2026/08/17', makeDays({ tag: 'A', month: 8, firstDay: 17 }));

    // 8月の週でセル操作 → 履歴が積まれる
    c.run(`handleContextAction('clearDay', 0, 0)`);
    c.clock.advance();
    assert.ok(c.STATE.undoStack.length > 0);

    // 9月の週へ移動
    setWeek(c, '2026/09/14', makeDays({ tag: 'B', month: 9, firstDay: 14 }), 'r9');
    assert.equal(c.STATE.undoStack.length, 0, '別の週へ移ったら履歴は捨てること');

    const before = subjectsOf(c.STATE.weekData.days);
    c.run(`undo()`);
    assert.equal(subjectsOf(c.STATE.weekData.days), before,
      '前の週の内容が9月の週に入ってはいけない');
    assert.equal(c.STATE.weekData.days[0].date, '2026/09/14');
    // vm 側の配列はホスト側へ移してから比べる
    assert.deepEqual([...c.toasts[c.toasts.length - 1]], ['info', '元に戻せる操作がありません']);
  });

  test(`学級を切り替えたあとの「元に戻す」が前の学級の内容を持ち込まない（${variant.label}）`, () => {
    const c = bootClient(variant.options);
    c.STATE.multiClass = { enabled: true, activeSheet: '1組', classes: [] };
    setWeek(c, '2026/08/17', makeDays({ tag: '1組' }));
    c.run(`handleContextAction('clearDay', 0, 0)`);
    c.clock.advance();
    assert.ok(c.STATE.undoStack.length > 0);

    // 同じ週のまま2組へ。日付が一致するため、履歴を使うと本当に書き込めてしまう。
    c.STATE.multiClass.activeSheet = '2組';
    setWeek(c, '2026/08/17', makeDays({ tag: '2組' }), 'r2');
    assert.equal(c.STATE.undoStack.length, 0, '別の学級へ移ったら履歴は捨てること');

    c.run(`undo()`);
    assert.match(subjectsOf(c.STATE.weekData.days), /2組/);
    assert.doesNotMatch(subjectsOf(c.STATE.weekData.days), /1組/);
  });

  test(`編集中の未保存入力を、あとから届いた読み込み結果で消さない（${variant.label}）`, () => {
    const c = bootClient(variant.options);
    setWeek(c, '2026/08/17', makeDays({ tag: 'A' }));

    // 編集モードに入り、入力を変える（collectCurrentEditData は days を返すスタブなので
    // days を直接書き換えることが「入力欄をいじった」ことに相当する）
    c.run(`STATE.editMode = true; updateEditUI();`);
    c.STATE.weekData.days[0].periods[0].subject = '入力中';
    assert.equal(c.run(`hasUnsavedChanges()`), true);

    // 同じ週の読み込み結果が遅れて届く（キャッシュ表示 → サーバ応答の二段階描画）
    const rendersBefore = c.renders.length;
    const fresh = makeDays({ tag: 'A' });
    c.run(`p2ApplyWeekData(${JSON.stringify({ success: true, mondayDateStr: '2026/08/17', days: fresh, revision: 'r2' })})`);

    assert.equal(c.STATE.weekData.days[0].periods[0].subject, '入力中',
      '編集中の入力が読み込み結果で消えてはいけない');
    assert.equal(c.renders.length, rendersBefore, '編集中のグリッドを描き直さないこと');
  });

  test(`サーバ側を書き換えた直後の読み直しは手元の編集より優先される（${variant.label}）`, () => {
    const c = bootClient(variant.options);
    setWeek(c, '2026/08/17', makeDays({ tag: 'A' }));
    c.run(`STATE.editMode = true; updateEditUI();`);
    c.STATE.weekData.days[0].periods[0].subject = '入力中';

    // 固定時間割の転記・復元・DBクリアの直後は、手元の内容はもう意味を持たない
    const fresh = makeDays({ tag: '転記後' });
    c.run(`p2DiscardLocalEdits(); p2ApplyWeekData(${JSON.stringify({
      success: true, mondayDateStr: '2026/08/17', days: fresh, revision: 'r2'
    })}, { force: true })`);

    assert.match(c.STATE.weekData.days[0].periods[0].subject, /転記後/);
    assert.equal(c.STATE.editMode, false);
  });

  test(`週移動・学級切替の前に、待たせてある保存を先に送る（${variant.label}）`, () => {
    const c = bootClient(variant.options);
    setWeek(c, '2026/08/17', makeDays({ tag: 'A' }));

    // セル操作 → 保存はディレイ待ち（まだ送信していない）
    c.run(`handleContextAction('clearDay', 0, 0)`);
    assert.equal(c.inflight.length, 0);
    assert.equal(c.run(`hasPendingViewSave()`), true, '未送信の変更として数えること');

    // 画面切替・学級切替の共通入口を通ると、先に送られる
    c.run(`autoSaveAndThen(function () {})`);
    assert.equal(c.inflight.length, 1, '切替の前に保存を送ること');
    assert.equal(c.inflight[0].args[0], '2026/08/17');
  });

  test(`表示していない週の保存でも、その週のキャッシュが最新になる（${variant.label}）`, () => {
    const c = bootClient(variant.options);
    setWeek(c, '2026/08/17', makeDays({ tag: 'A' }));

    c.run(`handleContextAction('clearDay', 0, 0)`);
    c.clock.advance(450);
    assert.equal(c.inflight.length, 1);

    // 応答を待つあいだに別の週へ移動
    setWeek(c, '2026/09/14', makeDays({ tag: 'B', month: 9, firstDay: 14 }), 'r9');

    // 移動元の週の保存が完了する
    const call = c.inflight.shift();
    call.handlers.ok({ success: true, message: 'saved', revision: 'r2', days: clone(call.args[1]) });
    c.clock.advance();

    // 戻ったときに保存前の内容が出ないこと
    const cached = c.run(`p2GetCachedWeek('2026/08/17')`);
    assert.ok(cached, '移動元の週のキャッシュが残っていること');
    const cleared = cached.days[0].periods.every(p => !p.subject);
    assert.ok(cleared, 'キャッシュが保存後の内容になっていること');
    assert.equal(cached.revision, 'r2', 'キャッシュのリビジョンも更新すること');
  });

  test(`保存要求には表示中の学級シート名を添える（${variant.label}）`, () => {
    const c = bootClient(variant.options);
    c.STATE.multiClass = { enabled: true, activeSheet: '1組', classes: [] };
    setWeek(c, '2026/08/17', makeDays({ tag: '1組' }));

    c.run(`handleContextAction('clearDay', 0, 0)`);
    c.clock.advance(450);
    assert.equal(c.inflight.length, 1);
    // サーバ側は「いまアクティブな学級」へ書くため、意図した学級名を照合させる
    assert.ok(c.inflight[0].args.indexOf('1組') >= 0,
      `保存要求に学級シート名が含まれること: ${JSON.stringify(c.inflight[0].args.slice(3))}`);
  });
}

test('複数学級モードが無効なら学級名は送らない（既定シートしか無いため）', () => {
  const c = bootClient();
  setWeek(c, '2026/08/17', makeDays());
  assert.equal(c.run(`expectedClassSheetName()`), '');
});
