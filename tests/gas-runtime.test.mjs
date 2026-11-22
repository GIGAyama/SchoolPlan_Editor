// テスト用の足場（tests/helpers/gas-runtime.mjs / fake-google.mjs）が、
// 本物の .gs を通しで動かせていることの確認。
//
// ここが通らないと、この足場に乗っているほかのテストは「何も確かめていない」のに
// 緑になりうる。足場そのものを先に確かめておく。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, callFunction, createTeacher, withRuntime } from './helpers/gas-runtime.mjs';

const TEACHER = 'teacher-a@example.com';

test('新しい先生がデータベースを作り、今週の週案を読み書きできる', () => {
  const world = createWorld({ scriptProps: { sp_sharedDeployment: 'true' } });
  world.now = Date.parse('2026-11-18T10:30:00+09:00');

  const before = callFunction(world, TEACHER, 'getTenantStatus');
  assert.equal(before.value.linked, false, 'まだ自分のデータベースを持っていないはず');

  const teacher = createTeacher(world, TEACHER);
  assert.equal(callFunction(world, TEACHER, 'getTenantStatus').value.linked, true);
  assert.equal(teacher.sheet('データベース').grid.length, 371, '見出し＋370日ぶんのカレンダー');

  const week = callFunction(world, TEACHER, 'getWeeklyPlanDataV2', ['2026/11/16']).value;
  assert.equal(week.success, true, week.error);
  assert.equal(week.days.length, 7);
  assert.equal(week.days[2].date, '2026/11/18');

  week.days[2].periods[0] = { subject: '国語', unit: 'ごんぎつね 3/12', content: '場面の様子を読み取る' };
  const saved = callFunction(world, TEACHER, 'saveWeeklyPlanDataProtected',
    ['2026/11/16', week.days, week.revision, 'web', null]).value;
  assert.equal(saved.success, true, saved.error);

  const again = callFunction(world, TEACHER, 'getWeeklyPlanDataV2', ['2026/11/16']).value;
  assert.deepEqual(again.days[2].periods[0],
    { subject: '国語', unit: 'ごんぎつね 3/12', content: '場面の様子を読み取る' });
  assert.equal(again.revision, saved.revision, '保存の応答と、読み直したリビジョンがそろう');
});

test('足場は日本時間で動く（GAS のスクリプトのタイムゾーンと同じ）', () => {
  // ずれていると、日付の列に端数つきの値（9時間ぶん）が入ったまま通ってしまう。
  assert.equal(new Date(2026, 0, 1).getTimezoneOffset(), -540,
    'タイムゾーンを Asia/Tokyo にできていません（TZ=Asia/Tokyo を付けて実行してください）');
  const world = createWorld({ scriptProps: { sp_sharedDeployment: 'true' } });
  world.now = Date.parse('2026-11-18T10:30:00+09:00');
  const teacher = createTeacher(world, TEACHER);
  const firstDate = teacher.sheet('データベース').grid[1][1];
  assert.equal(firstDate, Math.round(firstDate), '日付の列に時刻の端数が入っている');
});

test('末尾が _ の関数は google.script.run から呼べない（本物と同じ）', () => {
  const world = createWorld();
  const res = callFunction(world, TEACHER, 'getSs_');
  assert.equal(res.ok, false);
  assert.match(res.error, /見つかりません/);
});

test('実行が変わるとトップレベルの変数は作り直される', () => {
  const world = createWorld({ scriptProps: { sp_sharedDeployment: 'true' } });
  createTeacher(world, TEACHER);
  // 18_SheetsApi.gs の通信回数は実行ごとに 0 から数え直す
  const first = withRuntime(world, TEACHER, (app) => { app.getSs_().getSheets(); return app.sheetsFetchStats_().fetches; });
  const second = withRuntime(world, TEACHER, (app) => app.sheetsFetchStats_().fetches);
  assert.ok(first >= 0);
  assert.equal(second, 0);
});

test('利用者が違えば、プロパティもキャッシュもデータベースも別になる', () => {
  const world = createWorld({ scriptProps: { sp_sharedDeployment: 'true' } });
  const a = createTeacher(world, 'a@example.com');
  const b = createTeacher(world, 'b@example.com');
  assert.notEqual(a.spreadsheetId, b.spreadsheetId);
  assert.equal(callFunction(world, 'a@example.com', 'getTenantStatus').value.spreadsheetId, a.spreadsheetId);
  assert.equal(callFunction(world, 'b@example.com', 'getTenantStatus').value.spreadsheetId, b.spreadsheetId);
});

test('ロックは GAS と同じ決まりで動く（スクリプト全体で1本／利用者ごとに1本）', () => {
  const world = createWorld();
  withRuntime(world, 'a@example.com', (app) => {
    const script = app.LockService.getScriptLock();
    assert.equal(script.tryLock(1000), true);
    assert.equal(script.tryLock(1000), true, '同じ実行の取り直しは成功する');
    // 別の利用者の実行から見ると、スクリプト全体のロックは塞がっている
    withRuntime(world, 'b@example.com', (other) => {
      assert.equal(other.LockService.getScriptLock().tryLock(1000), false);
      assert.equal(other.LockService.getUserLock().tryLock(1000), true, '利用者ごとのロックは別の人と競合しない');
    });
    script.releaseLock();
    assert.equal(script.hasLock(), false, '取り直した回数に関係なく、1回の解放で手放す');
  });
  // 手放し忘れても、実行が終われば解放される
  withRuntime(world, 'a@example.com', (app) => { app.LockService.getScriptLock().waitLock(1000); });
  assert.equal(world.locks.script, null);
});

test('書き込みの読み替え（USER_ENTERED）を近似している', () => {
  const world = createWorld();
  const google = world.google;
  assert.equal(google.interpretUserEntered('9:00').value, 0.375);
  assert.equal(typeof google.interpretUserEntered('10/15').value, 'number');
  assert.equal(google.interpretUserEntered('007').value, 7);
  assert.equal(google.interpretUserEntered('=1+2').value, 3);
  assert.equal(google.interpretUserEntered('+αのプリント').value, '#NAME?');
  assert.equal(google.interpretUserEntered('国語1/3行事2/3').value, '国語1/3行事2/3', '文が混じれば読み替えない');
  assert.equal(google.interpretUserEntered('- 体育着').value, '- 体育着');
});
