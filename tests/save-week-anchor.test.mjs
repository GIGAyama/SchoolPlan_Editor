import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bootClient, makeDays } from './helpers/webapp-sandbox.mjs';

// 「保存しようとしている内容が、どの週のものか」を取り違えないことの検査。
//
// 実際に起きた不具合:
//   編集モードのまま次の週へ移動すると、
//     保存失敗: 2026/08/31 の週に含まれない日付が送られました（2026/08/24 〜 2026/08/30）
//   と出て保存できず、画面は移動元の週のまま固まる。再読み込みするまで直らない。
//
// 原因は STATE.mondayStr を2つの意味に使っていたこと。
//   (1) これから表示したい週（週移動が真っ先に書き換える）
//   (2) いま画面に出ているデータの週（保存が送り先として使う）
// 週移動が (1) のために書き換えた値を、保存が (2) だと思って使っていた。
//
// 画面に出ているデータの週は STATE.weekData.mondayDateStr（サーバ応答に入っている）。
// 保存はこちらを送ること。

/** 指定した週を表示している状態を作る。 */
function showWeek(sandbox, mondayStr, days) {
  sandbox.run(`
    STATE.mondayStr = ${JSON.stringify(mondayStr)};
    STATE.weekData = {
      success: true,
      mondayDateStr: ${JSON.stringify(mondayStr)},
      days: ${JSON.stringify(days)},
      revision: 'rev-1',
      weekNum: 20
    };
    STATE.editBaseline = null;
  `);
}

/** 編集モードに入り、未保存の変更を1つ作る（変更が無ければ自動保存は走らない）。 */
function enterEditWithChange(sandbox) {
  sandbox.run(`
    STATE.editMode = true;
    STATE.editBaseline = JSON.parse(JSON.stringify(STATE.weekData.days));
    STATE.weekData.days[0].event = '変更しました';
  `);
}

const WEEK_AUG24 = makeDays({ month: 8, firstDay: 24 });

for (const protectedOverrides of [false, true]) {
  const label = protectedOverrides ? '保護版' : '通常版';

  test(`${label}: 編集中に週を移動しても、保存先は画面に出ている週になる`, () => {
    const app = bootClient({ protectedOverrides });
    showWeek(app, '2026/08/24', WEEK_AUG24);
    enterEditWithChange(app);

    // 次の週へ移動する。編集中で未保存の変更があるので、移動の前に自動保存が走る。
    app.run('navigateWeek(1);');
    app.clock.advance();

    const saves = app.inflight.filter(c => /^saveWeeklyPlanData/.test(c.name));
    assert.equal(saves.length, 1, '移動前の自動保存が走っていません');

    const sentMonday = saves[0].args[0];
    const sentDates = saves[0].args[1].map(d => d.date);

    assert.equal(sentMonday, '2026/08/24',
      `画面に出ている週（2026/08/24）ではなく ${sentMonday} を送っています。`
      + 'サーバ側で「その週に含まれない日付」として弾かれます。');
    assert.ok(sentDates.every(d => d >= '2026/08/24' && d <= '2026/08/30'),
      `送った日付が別の週のものです: ${sentDates.join(', ')}`);
  });

  test(`${label}: 日付ジャンプでも保存先は画面に出ている週になる`, () => {
    const app = bootClient({ protectedOverrides });
    showWeek(app, '2026/08/24', WEEK_AUG24);
    enterEditWithChange(app);

    app.run('jumpToDate("2026-09-09");');
    app.clock.advance();

    const saves = app.inflight.filter(c => /^saveWeeklyPlanData/.test(c.name));
    assert.equal(saves.length, 1);
    assert.equal(saves[0].args[0], '2026/08/24',
      'ジャンプ先の週を送っています');
  });

  test(`${label}: 手動保存も画面に出ている週へ送る`, () => {
    const app = bootClient({ protectedOverrides });
    showWeek(app, '2026/08/24', WEEK_AUG24);
    enterEditWithChange(app);

    // 週移動の途中でずれた状態（表示は 8/24 のまま、移動先だけ進んでいる）を作る
    app.run('STATE.mondayStr = "2026/08/31";');
    app.run('saveWeeklyPlan();');
    app.clock.advance();

    const saves = app.inflight.filter(c => /^saveWeeklyPlanData/.test(c.name));
    assert.equal(saves.length, 1);
    assert.equal(saves[0].args[0], '2026/08/24',
      '画面に出ているデータと違う週へ保存しようとしています');
  });
}

test('保存が成功したあとは、目的の週へ移動できる', () => {
  const app = bootClient({ protectedOverrides: true });
  showWeek(app, '2026/08/24', WEEK_AUG24);
  enterEditWithChange(app);

  app.run('navigateWeek(1);');
  app.clock.advance();

  const save = app.inflight.find(c => /^saveWeeklyPlanData/.test(c.name));
  assert.ok(save, '自動保存が走っていません');

  // サーバが保存に成功したことにする
  save.handlers.ok({
    success: true, revision: 'rev-2', message: '保存しました',
    days: WEEK_AUG24, mondayDateStr: '2026/08/24'
  });
  app.clock.advance();

  const loads = app.inflight.filter(c => c.name === 'getWeeklyPlanDataV2');
  assert.ok(loads.length >= 1, '保存後に移動先の週を読みに行っていません');
  assert.equal(loads[loads.length - 1].args[0], '2026/08/31',
    '移動先の週を読みに行っていません');
});

test('週の取り違えを防ぐ拠り所が、サーバ応答に入っている', () => {
  // STATE.weekData.mondayDateStr はサーバの応答に由来する。
  // ここが返らなくなると、保存の送り先の拠り所が無くなる。
  const source = fs.readFileSync(new URL('../12_Performance.gs', import.meta.url), 'utf8');
  assert.match(source, /mondayDateStr,/,
    'getWeeklyPlanDataV2 が mondayDateStr を返さなくなっています');
});
