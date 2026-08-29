import test from 'node:test';
import assert from 'node:assert/strict';
import { bootClient, setWeek, makeDays, clone } from './helpers/webapp-sandbox.mjs';

// 週データの読み書きで「別のデータが混ざる」「入力が消える」経路の回帰防止。
//
// このアプリはスプレッドシートが唯一の保存先で、画面の状態がそのまま保存される。
// そのため、画面上のデータが別の週・別の学級のものに入れ替わると、
// そのまま保存されて利用者のデータが失われる。
//
// 週データを書き換えるのは編集モードだけ（閲覧モードは読むだけ）なので、
// ここでの筋書きも編集モードから始める。

const subjectsOf = days => days.map(d => d.periods[0].subject).join(',');

/** 送信済みの保存を1件、成功として返す。 */
function respondSave(c, revision) {
  const call = c.inflight.shift();
  assert.ok(call && /^saveWeeklyPlanData/.test(call.name), '保存が送られていること');
  call.handlers.ok({
    success: true, message: 'saved', revision: revision || 'r2', days: clone(call.args[1])
  });
  c.clock.advance();
  return call;
}

for (const variant of [
  { label: 'V2保存', options: {} },
  { label: '保護版保存', options: { protectedOverrides: true } }
]) {

  test(`週を移動したあとの「元に戻す」が前の週の内容を持ち込まない（${variant.label}）`, () => {
    const c = bootClient(variant.options);
    setWeek(c, '2026/08/17', makeDays({ tag: 'A', month: 8, firstDay: 17 }));

    // 8月の週でセル操作 → 履歴が積まれる
    c.run('setEditMode(true)');
    c.run(`handleContextAction('clearDay', 0, 0)`);
    assert.ok(c.STATE.undoStack.length > 0);

    // 週を移動する。編集モードなら、まず自動保存を挟んでから移る。
    c.run('__moved = false; autoSaveAndThen(function () { __moved = true; });');
    respondSave(c);
    assert.equal(c.run('__moved'), true, '保存が通ったら移動へ進むこと');
    assert.equal(c.STATE.editMode, false, '保存できたら閲覧モードへ戻すこと');
    assert.equal(c.STATE.undoStack.length, 0, '編集モードを抜けたら履歴は捨てること');

    // 9月の週へ
    setWeek(c, '2026/09/14', makeDays({ tag: 'B', month: 9, firstDay: 14 }), 'r9');

    const before = subjectsOf(c.STATE.weekData.days);
    c.run('setEditMode(true); undo();');
    assert.equal(subjectsOf(c.STATE.weekData.days), before,
      '前の週の内容が9月の週に入ってはいけない');
    assert.equal(c.STATE.weekData.days[0].date, '2026/09/14');
    // vm 側の配列はホスト側へ移してから比べる
    assert.deepEqual([...c.toasts[c.toasts.length - 1]], ['info', '元に戻せる操作がありません']);
  });

  test(`学級を切り替えたあとの「元に戻す」が前の学級の内容を持ち込まない（${variant.label}）`, () => {
    const c = bootClient(variant.options);
    c.STATE.multiClass = { enabled: true, activeSheet: '1組', classes: [] };
    setWeek(c, '2026/08/17', makeDays({ tag: '甲組' }));
    c.run('setEditMode(true)');
    c.run(`handleContextAction('clearDay', 0, 0)`);
    assert.ok(c.STATE.undoStack.length > 0);

    c.run('__moved = false; autoSaveAndThen(function () { __moved = true; });');
    respondSave(c);
    assert.equal(c.run('__moved'), true);

    // 同じ週のまま2組へ。日付が一致するため、履歴を使うと本当に書き込めてしまう。
    // （教科名は「数字を含まない単一の教科名」でないと保存時の検証に弾かれるので、
    //   学級の目印には数字を使わない）
    c.STATE.multiClass.activeSheet = '2組';
    setWeek(c, '2026/08/17', makeDays({ tag: '乙組' }), 'r2');
    assert.equal(c.STATE.undoStack.length, 0, '別の学級へ移ったら履歴は捨てること');

    c.run('setEditMode(true); undo();');
    assert.match(subjectsOf(c.STATE.weekData.days), /乙組/);
    assert.doesNotMatch(subjectsOf(c.STATE.weekData.days), /甲組/);
  });

  test(`編集中の未保存入力を、あとから届いた読み込み結果で消さない（${variant.label}）`, () => {
    const c = bootClient(variant.options);
    setWeek(c, '2026/08/17', makeDays({ tag: 'A' }));

    // 編集モードに入り、入力を変える（collectCurrentEditData は days から作るスタブなので
    // days を直接書き換えることが「入力欄をいじった」ことに相当する）
    c.run('setEditMode(true)');
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

  test(`閲覧モードには手元だけの変更が無いので、読み込み結果をそのまま反映する（${variant.label}）`, () => {
    // 閲覧モードを読み取り専用にしたことで得られた性質。以前は閲覧モードのセル操作が
    // STATE.weekData.days にしか無く、あとから届く読み込み応答と重なると
    //   1) 動かしたコマが消える
    //   2) 手元のリビジョンが保存前へ巻き戻り、以降の保存が競合で弾かれ続ける
    // という壊れ方をしたため、週ごとに「未確定」を控える仕掛けが要っていた。
    // いまは書き換えが編集モードにしか無いので、その仕掛けごと不要になった。
    const c = bootClient(variant.options);
    setWeek(c, '2026/08/17', makeDays({ tag: 'A' }), 'r1');
    assert.equal(c.STATE.editMode, false);

    // 閲覧モードでセル操作を試みても、週データは変わらない
    c.run(`handleContextAction('clearDay', 0, 0)`);
    assert.match(subjectsOf(c.STATE.weekData.days), /A教科/);
    c.clock.advance();
    assert.equal(c.inflight.length, 0, '閲覧モードから保存を送らないこと');

    // だから、あとから届いた読み込み応答はためらわず当てられる
    c.run(`p2ApplyWeekData(${JSON.stringify({
      success: true, mondayDateStr: '2026/08/17', days: makeDays({ tag: '他端末' }), revision: 'r3'
    })})`);
    assert.match(subjectsOf(c.STATE.weekData.days), /他端末/);
    assert.equal(c.STATE.weekData.revision, 'r3');
  });

  test(`サーバ側を書き換えた直後の読み直しは手元の編集より優先される（${variant.label}）`, () => {
    const c = bootClient(variant.options);
    setWeek(c, '2026/08/17', makeDays({ tag: 'A' }));
    c.run('setEditMode(true)');
    c.STATE.weekData.days[0].periods[0].subject = '入力中';

    // 固定時間割の転記・復元・DBクリアの直後は、手元の内容はもう意味を持たない
    const fresh = makeDays({ tag: '転記後' });
    c.run(`p2DiscardLocalEdits(); p2ApplyWeekData(${JSON.stringify({
      success: true, mondayDateStr: '2026/08/17', days: fresh, revision: 'r2'
    })}, { force: true })`);

    assert.match(c.STATE.weekData.days[0].periods[0].subject, /転記後/);
    assert.equal(c.STATE.editMode, false);
  });

  test(`画面切替の前に、編集中の未保存を送る（${variant.label}）`, () => {
    const c = bootClient(variant.options);
    setWeek(c, '2026/08/17', makeDays({ tag: 'A' }));

    c.run('setEditMode(true)');
    c.run(`handleContextAction('clearDay', 0, 0)`);
    assert.equal(c.inflight.length, 0, 'セル操作だけでは送らないこと');

    // 画面切替・週移動・学級切替の共通入口を通ると、先に送られる
    c.run(`autoSaveAndThen(function () {})`);
    assert.equal(c.inflight.length, 1, '切替の前に保存を送ること');
    assert.equal(c.inflight[0].args[0], '2026/08/17');
  });

  test(`保存が通ったら、その週のキャッシュも保存後の内容になる（${variant.label}）`, () => {
    const c = bootClient(variant.options);
    setWeek(c, '2026/08/17', makeDays({ tag: 'A' }));

    c.run('setEditMode(true)');
    c.run(`handleContextAction('clearDay', 0, 0)`);
    c.run('saveWeeklyPlan()');
    respondSave(c, 'r2');

    // 週を移動して戻ったときに、保存前の内容が出ないこと
    const cached = c.run(`p2GetCachedWeek('2026/08/17')`);
    assert.ok(cached, 'その週のキャッシュが残っていること');
    assert.ok(cached.days[0].periods.every(p => !p.subject),
      'キャッシュが保存後の内容になっていること');
    assert.equal(cached.revision, 'r2', 'キャッシュのリビジョンも更新すること');
  });

  test(`週移動の読み込み中に保存が通っても、移動元の内容が移動先の週にならない（${variant.label}）`, () => {
    const c = bootClient(variant.options);
    setWeek(c, '2026/08/17', makeDays({ tag: 'A' }), 'r1');

    c.run('setEditMode(true)');
    c.run(`handleContextAction('clearDay', 0, 0)`);
    c.run('saveWeeklyPlan()');
    assert.equal(c.inflight.length, 1);

    // 翌週へ移動する。読み込みが終わるまで、画面に出ているのは移動元の週のまま。
    c.STATE.mondayStr = '2026/08/24';
    respondSave(c, 'r2');

    assert.equal(c.STATE.weekData.mondayDateStr, '2026/08/17',
      '画面に出ているデータの週を、移動先の週で上書きしてはいけない');
    assert.equal(c.run(`displayedWeekMondayStr()`), '2026/08/17',
      '次の保存の送り先を取り違えないこと');
    assert.equal(c.run(`p2GetCachedWeek('2026/08/24')`), null,
      '移動元の内容を移動先の週としてキャッシュしないこと');
  });

  test(`保存を送っている間は、週の読み込みを待たせる（${variant.label}）`, () => {
    const c = bootClient(variant.options);
    setWeek(c, '2026/08/17', makeDays({ tag: 'A' }), 'r1');

    // 編集したまま週を移動する（移動の前に自動保存が走る）
    c.run('setEditMode(true)');
    c.run(`handleContextAction('clearDay', 0, 0)`);
    c.run(`navigateWeek(1)`);
    c.clock.advance();

    assert.equal(c.inflight.filter(x => /^saveWeeklyPlanData/.test(x.name)).length, 1,
      '移動の前に、編集中の内容を送ること');
    assert.equal(c.inflight.filter(x => x.name === 'getWeeklyPlanDataV2').length, 0,
      '保存がシートへ入る前に読み込むと、変更が消えた内容をキャッシュに残してしまう');

    respondSave(c, 'r2');

    const loads = c.inflight.filter(x => x.name === 'getWeeklyPlanDataV2');
    assert.equal(loads.length, 1, '保存が済んでから読み込むこと');
    assert.equal(loads[0].args[0], '2026/08/24');
  });

  test(`保存要求には表示中の学級シート名を添える（${variant.label}）`, () => {
    const c = bootClient(variant.options);
    c.STATE.multiClass = { enabled: true, activeSheet: '1組', classes: [] };
    setWeek(c, '2026/08/17', makeDays({ tag: '甲組' }));

    c.run('setEditMode(true)');
    c.run(`handleContextAction('clearDay', 0, 0)`);
    c.run('saveWeeklyPlan()');
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
