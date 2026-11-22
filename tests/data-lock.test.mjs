// 週案の保存などが取るロックの確認。
//
// GAS の LockService.getScriptLock() は、利用者に関係なく**スクリプト全体で1本**である。
// 1つのURLを多数の先生へ配る運用では、全員の保存がその1本に並ぶ。しかも同じロックを、
// 完全バックアップを伴う全消去・年間一括転記・一括自動入力が長く握るので、誰か1人が
// それを実行しているあいだ、ほかの学校の先生の保存まで「他の保存処理が進行中です」で
// 失敗していた。
//
// 自分のデータベースを使う先生は利用者ごとのロック、スクリプトプロパティの1冊を
// 全員で使う旧来の形だけ ScriptLock、という切り分け（11_Tenant.gs の tDataLock_）を、
// 本物の .gs を動かして確かめる。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWorld, callFunction, createTeacher, withRuntime } from './helpers/gas-runtime.mjs';

const MONDAY = '2026/11/16';

function sharedWorld() {
  const world = createWorld({ scriptProps: { sp_sharedDeployment: 'true' } });
  world.now = Date.parse('2026-11-18T10:30:00+09:00');
  return world;
}

/** 今週の水曜1校時を書き換えて保存する。保存の応答と、その実行のロックの記録を返す。 */
function saveOnce(world, email, text) {
  const week = callFunction(world, email, 'getWeeklyPlanDataV2', [MONDAY]).value;
  assert.equal(week.success, true, week.error);
  week.days[2].periods[0] = { subject: '国語', unit: 'ごんぎつね', content: text };
  const mark = world.lockLog.length;
  const res = callFunction(world, email, 'saveWeeklyPlanDataProtected', [MONDAY, week.days, week.revision, 'web', null]);
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.leakedLocks, [], 'ロックを持ったまま実行が終わっています');
  return { result: res.value, locks: world.lockLog.slice(mark), fetchesAtEnd: world.google.log.length };
}

test('自分のデータベースを使う先生の保存は、利用者ごとのロックだけを取る', () => {
  const world = sharedWorld();
  createTeacher(world, 'a@example.com');
  const { result, locks } = saveOnce(world, 'a@example.com', '場面を読む');
  assert.equal(result.success, true, result.error);
  assert.deepEqual([...new Set(locks.map(l => l.kind))], ['user'], 'スクリプト全体のロックに触れている');
});

test('ほかの先生が長い処理をしていても、自分の保存は待たされない', () => {
  const world = sharedWorld();
  createTeacher(world, 'a@example.com');
  createTeacher(world, 'b@example.com');
  // b 先生の実行（全消去の前のバックアップなど）が、自分のロックを握ったままになっている
  world.locks.user.set('b@example.com', 'long-running-execution-of-b');
  // 旧来の形の誰かが、スクリプト全体のロックを握っている
  world.locks.script = 'someone-in-legacy-mode';

  const { result } = saveOnce(world, 'a@example.com', '場面を読む');
  assert.equal(result.success, true, 'ほかの先生の処理のせいで保存できていない: ' + result.error);
});

test('同じ先生の別の保存が進行中なら、これまでどおり待って知らせる', () => {
  const world = sharedWorld();
  createTeacher(world, 'a@example.com');
  world.locks.user.set('a@example.com', 'my-other-tab');
  const { result } = saveOnce(world, 'a@example.com', '場面を読む');
  assert.equal(result.success, false);
  assert.match(result.error, /進行中/);
});

test('保存の中で復元ポイントやマイグレーションが走っても、ロックは最後まで握っている', () => {
  const world = sharedWorld();
  createTeacher(world, 'a@example.com');
  const { result, locks, fetchesAtEnd } = saveOnce(world, 'a@example.com', '場面を読む');
  assert.equal(result.success, true, result.error);
  assert.ok(result.restorePointId, '復元ポイントを作る経路（利用者ロックを取り直す）を通っていない');

  const real = locks.filter(l => l.op === 'acquire' || l.op === 'release');
  assert.deepEqual(real.map(l => l.op), ['acquire', 'release'],
    '入れ子の内側が先に解放している（外側が握っているつもりのまま、守られずに書いている）');
  const release = real[1];
  // 解放のあとで Google へ書きに行っていない
  const after = world.google.log.slice(release.at, fetchesAtEnd).filter(entry => entry.method !== 'get');
  assert.deepEqual(after.map(entry => entry.url), [], 'ロックを放したあとに書き込んでいる');
});

test('スクリプトプロパティの1冊を全員で使う旧来の形では、スクリプト全体のロックで並べる', () => {
  // 共有デプロイの印を付けていない＝先生が自分でデプロイして使う形。
  const world = createWorld();
  world.now = Date.parse('2026-11-18T10:30:00+09:00');
  const owner = createTeacher(world, 'owner@example.com');
  world.scriptProps.SPREADSHEET_ID = owner.spreadsheetId;

  // 同じデプロイを開いた別の先生は、自分の紐付けを持たず、全員の1冊へ書く
  const { result, locks } = saveOnce(world, 'colleague@example.com', '場面を読む');
  assert.equal(result.success, true, result.error);
  assert.ok(locks.some(l => l.kind === 'script' && l.op === 'acquire'),
    '全員が同じ1冊へ書く形なのに、スクリプト全体のロックで並べていない');
});

test('全員で使う1冊を自分でも紐付けている先生は、ほかの先生と同じロックに並ぶ', () => {
  const world = createWorld();
  world.now = Date.parse('2026-11-18T10:30:00+09:00');
  const owner = createTeacher(world, 'owner@example.com');   // 持ち主は自分の紐付けを持つ
  world.scriptProps.SPREADSHEET_ID = owner.spreadsheetId;    // 同じ1冊を、全員の既定にもしている
  const { result, locks } = saveOnce(world, 'owner@example.com', '場面を読む');
  assert.equal(result.success, true, result.error);
  assert.ok(locks.some(l => l.kind === 'script' && l.op === 'acquire'),
    '同じ1冊へ書く同僚（スクリプト全体のロック）と並んでいない');
});

test('データベースをまだ持っていない先生は、スクリプト全体のロックに触れない', () => {
  const world = sharedWorld();
  const res = callFunction(world, 'newcomer@example.com', 'applyTimetableToWeek', [MONDAY]);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.value.success, false, 'データベースが無いので転記はできない');
  assert.ok(world.lockLog.every(l => l.kind === 'user'), 'ほかの先生を待たせるロックを取っている');
});

test('入れ子に強い取っ手は、いちばん外側だけが本当に取って・放す', () => {
  const world = sharedWorld();
  createTeacher(world, 'a@example.com');
  withRuntime(world, 'a@example.com', (app) => {
    const raw = app.LockService.getUserLock();
    const outer = app.tDataLock_();
    outer.waitLock(1000);
    assert.equal(raw.hasLock(), true);

    const inner = app.tUserLock_();
    assert.equal(inner.tryLock(1000), true);
    inner.releaseLock();
    assert.equal(raw.hasLock(), true, '内側の解放で、外側のぶんまで外れている');
    inner.releaseLock(); // 2回呼んでも数えすぎない
    assert.equal(raw.hasLock(), true);

    outer.releaseLock();
    assert.equal(raw.hasLock(), false);
  });
});

test('全消去・一括転記・学級の操作も、ロックを残さずに終わる', () => {
  const world = sharedWorld();
  createTeacher(world, 'a@example.com');
  for (const [name, args] of [
    ['applyTimetableToWeek', [MONDAY]],
    ['setMultiClassEnabledFromWeb', [true]],
    ['addClassFromWeb', ['5年1組', 5]],
    ['clearDatabaseDataProtectedFromWeb', []],
  ]) {
    const mark = world.lockLog.length;
    const res = callFunction(world, 'a@example.com', name, args);
    assert.equal(res.ok, true, `${name}: ${res.error}`);
    assert.deepEqual(res.leakedLocks, [], `${name} がロックを持ったまま終わっています`);
    assert.ok(world.lockLog.slice(mark).every(l => l.kind === 'user'), `${name} がスクリプト全体のロックに触れています`);
  }
});

test('どの .gs も、LockService を直接は呼ばない（取っ手を通す）', () => {
  // 直接呼ぶと、入れ子で先に外れる・全員を1列に並べる、のどちらかを踏み直す。
  for (const file of fs.readdirSync('.').filter(f => f.endsWith('.gs'))) {
    const source = fs.readFileSync(file, 'utf8')
      .split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    const direct = (source.match(/LockService\.get(?:Script|User|Document)Lock\(\)/g) || []).length;
    if (file === '11_Tenant.gs') {
      assert.equal(direct, 2, '11_Tenant.gs で LockService を呼ぶのは tReentrantLock_ の1か所（2種類）だけのはず');
    } else {
      assert.equal(direct, 0, `${file}: LockService を直接呼んでいます。tDataLock_() か tUserLock_() を使ってください`);
    }
  }
});
