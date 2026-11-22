// 単元タブと学級通信の「行を指す操作」が、行番号のずれで別の行を相手にしないことの確認。
//
// 単元タブは行をシートの行番号で指す。行番号は、別の行を足したり消したりした瞬間に
// 1つずつずれる。実際に、3時間目と4時間目を続けて消すと、確認の画面には
// 「4時間目を移動します」と出ているのに、消えたのは5時間目だった（1件目の削除で
// 行が繰り上がったあとも、画面は読み直しが終わるまで古い番号を送ってくるため）。
//
// 本物の .gs を通しで動かして確かめる（tests/helpers/gas-runtime.mjs）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWorld, callFunction, createTeacher } from './helpers/gas-runtime.mjs';

const TEACHER = 'teacher-a@example.com';

/** 「ごんぎつね」8時間ぶんの単元マスタを持つ先生を用意する。 */
function setup() {
  const world = createWorld({ scriptProps: { sp_sharedDeployment: 'true' } });
  world.now = Date.parse('2026-11-18T10:30:00+09:00');
  const teacher = createTeacher(world, TEACHER);
  const master = teacher.sheet('単元マスタ');
  for (let hour = 1; hour <= 8; hour++) {
    master.grid.push(['国語', 'ごんぎつね', 8, hour, `ごんぎつね ${hour}時間目の学習活動`]);
  }
  const call = (name, args) => {
    const res = callFunction(world, TEACHER, name, args);
    assert.equal(res.ok, true, `${name}: ${res.error}`);
    assert.deepEqual(res.leakedLocks, [], `${name} がロックを持ったまま終わっています`);
    return res.value;
  };
  /** 画面が持っている一覧（getUnitMasterData の rows）を取る。 */
  const list = () => call('getUnitMasterData').rows;
  const expectedOf = row => ({ subject: row.subject, unitName: row.unitName, hourNum: row.hourNum, activity: row.activity });
  const hours = () => master.grid.slice(1).map(r => r[3]);
  return { world, teacher, master, call, list, expectedOf, hours };
}

test('続けて2行消しても、画面で指した行が消える', () => {
  const t = setup();
  const shown = t.list();                       // 画面に出ている一覧（読み直す前のもの）
  const third = shown.find(r => r.hourNum === 3);
  const fourth = shown.find(r => r.hourNum === 4);

  assert.equal(t.call('trashUnitMasterRowFromWeb', [third.rowIndex, t.expectedOf(third)]).success, true);
  // 一覧を読み直す前に、次の行を消す。行番号は古いまま（4時間目はもう1行上にいる）
  const second = t.call('trashUnitMasterRowFromWeb', [fourth.rowIndex, t.expectedOf(fourth)]);
  assert.equal(second.success, true, second.error);

  assert.deepEqual(t.hours(), [1, 2, 5, 6, 7, 8], '3時間目と4時間目が消え、5時間目は残る');

  const trashed = t.call('listTrashFromWeb', [50]).items.map(item => item.label);
  assert.deepEqual(trashed.slice().sort(),
    ['国語 / ごんぎつね / 3時間目', '国語 / ごんぎつね / 4時間目'],
    'ごみ箱に控えた中身と、実際に消えた行がそろっている');
});

test('指した行が見つからなければ、何も消さずに読み直しを求める', () => {
  const t = setup();
  const before = JSON.stringify(t.master.grid);
  const res = t.call('trashUnitMasterRowFromWeb',
    [4, { subject: '国語', unitName: 'ごんぎつね', hourNum: 3, activity: '別の画面で書き換えられた内容' }]);
  assert.equal(res.success, false);
  assert.equal(res.stale, true, '一覧が古いことを画面に伝える');
  assert.equal(JSON.stringify(t.master.grid), before, '行が消えている');
  assert.equal(t.call('listTrashFromWeb', [50]).items.length, 0);
});

test('同じ中身の行が2つあり、行番号も合わないときは、どちらも消さない', () => {
  const t = setup();
  t.master.grid.push(['国語', 'ごんぎつね', 8, 3, 'ごんぎつね 3時間目の学習活動']); // 3時間目が重複している
  const shown = t.list();
  const third = shown.find(r => r.hourNum === 3);
  const before = JSON.stringify(t.master.grid);
  // 行番号がずれた状態（先頭に1行足された等）を作る
  t.master.grid.splice(1, 0, ['算数', '面積', 5, 1, '面積の導入']);
  const res = t.call('trashUnitMasterRowFromWeb', [third.rowIndex, t.expectedOf(third)]);
  assert.equal(res.stale, true);
  assert.equal(t.master.grid.length, JSON.parse(before).length + 1, '行が消えている');
});

test('行番号が合っていれば、同じ中身の行がほかにあっても、その行を消す', () => {
  const t = setup();
  t.master.grid.push(['国語', 'ごんぎつね', 8, 3, 'ごんぎつね 3時間目の学習活動']);
  const third = t.list().find(r => r.hourNum === 3); // 先に出てくるほう（4行目）
  assert.equal(t.call('trashUnitMasterRowFromWeb', [third.rowIndex, t.expectedOf(third)]).success, true);
  assert.deepEqual(t.hours(), [1, 2, 4, 5, 6, 7, 8, 3]);
});

test('中身を送ってこない古い画面からは、これまでどおり行番号で動く', () => {
  const t = setup();
  assert.equal(t.call('trashUnitMasterRowFromWeb', [4]).success, true);
  assert.deepEqual(t.hours(), [1, 2, 4, 5, 6, 7, 8]);
});

test('行の編集も、ずれた先の行ではなく画面で指した行に入る', () => {
  const t = setup();
  const shown = t.list();
  const fifth = shown.find(r => r.hourNum === 5);
  // 別の画面で、上の行が1つ消された
  t.master.grid.splice(2, 1);

  const res = t.call('updateUnitMasterRow', [fifth.rowIndex,
    { subject: '国語', unitName: 'ごんぎつね', totalHours: 8, hourNum: 5, activity: '書き直した学習活動' },
    t.expectedOf(fifth)]);
  assert.equal(res.success, true, res.error);
  assert.equal(res.rowIndex, fifth.rowIndex - 1, '実際に書いた行番号を返す');

  const activities = Object.fromEntries(t.master.grid.slice(1).map(r => [r[3], r[4]]));
  assert.equal(activities[5], '書き直した学習活動');
  assert.equal(activities[6], 'ごんぎつね 6時間目の学習活動', 'ずれた先（6時間目）を書き換えていない');
});

test('行の追加は、ずれていても画面で指した行のすぐ後ろに入る', () => {
  const t = setup();
  const second = t.list().find(r => r.hourNum === 2);
  t.master.grid.splice(1, 0, ['算数', '面積', 5, 1, '面積の導入']); // 先頭に1行足された

  const res = t.call('insertUnitMasterRow', [second.rowIndex,
    { subject: '国語', unitName: 'ごんぎつね', totalHours: 8, hourNum: 2.5, activity: '足した行' },
    t.expectedOf(second)]);
  assert.equal(res.success, true, res.error);
  const order = t.master.grid.slice(1).map(r => r[4]);
  assert.equal(order[order.indexOf('ごんぎつね 2時間目の学習活動') + 1], '足した行');
});

test('保存済みの学級通信も、続けて消して別の通信を巻きこまない', () => {
  const t = setup();
  for (const title of ['第10号', '第11号', '第12号']) {
    assert.equal(t.call('saveNewsletterData', [title, '2026/11/16', JSON.stringify({ blocks: [{ id: 'b1', type: 'text', content: title }] })]).success, true);
  }
  const shown = t.call('getNewsletterSaveList').list;      // 画面に出ている一覧
  const byTitle = Object.fromEntries(shown.map(item => [item.title, item]));
  const files = t.world.google.files;

  assert.equal(t.call('trashNewsletterDataFromWeb', [byTitle['第10号'].rowIndex, byTitle['第10号'].fileId]).success, true);
  // 一覧を開き直さずに、次の通信を消す（行番号は古いまま）
  assert.equal(t.call('trashNewsletterDataFromWeb', [byTitle['第11号'].rowIndex, byTitle['第11号'].fileId]).success, true);

  const left = t.call('getNewsletterSaveList').list;
  assert.deepEqual(left.map(item => item.title), ['第12号'], '一覧に残るのは消していない通信だけ');
  assert.equal(files.get(byTitle['第10号'].fileId).trashed, true);
  assert.equal(files.get(byTitle['第11号'].fileId).trashed, true);
  assert.equal(files.get(byTitle['第12号'].fileId).trashed, false, '消していない通信の本体がごみ箱に入っている');
  assert.equal(t.call('loadNewsletterData', [byTitle['第12号'].fileId]).success, true, '残った通信を開ける');
});

test('一覧に無い学級通信を消そうとしても、ほかの通信は消えない', () => {
  const t = setup();
  t.call('saveNewsletterData', ['第10号', '2026/11/16', JSON.stringify({ blocks: [] })]);
  const res = t.call('trashNewsletterDataFromWeb', [2, 'file-that-is-not-in-the-list']);
  assert.equal(res.success, false);
  assert.equal(res.stale, true);
  assert.equal(t.call('getNewsletterSaveList').list.length, 1);
});

test('同じ先生の別の操作が進行中なら、英語のエラーではなく、待つように伝える', () => {
  const t = setup();
  const third = t.list().find(r => r.hourNum === 3);
  t.world.locks.user.set(TEACHER, 'my-other-tab');
  const res = t.call('trashUnitMasterRowFromWeb', [third.rowIndex, t.expectedOf(third)]);
  assert.equal(res.success, false);
  assert.match(res.error, /少し待ってから/);
  assert.doesNotMatch(res.error, /Lock timeout/);
  assert.deepEqual(t.hours(), [1, 2, 3, 4, 5, 6, 7, 8], '行が消えている');
});

test('ごみ箱を通らない古い削除の入口は、ごみ箱へ移す入口に任せている', () => {
  const t = setup();
  assert.equal(t.call('deleteUnitMasterRow', [4]).success, true);
  t.call('saveNewsletterData', ['第10号', '2026/11/16', JSON.stringify({ blocks: [] })]);
  const item = t.call('getNewsletterSaveList').list[0];
  assert.equal(t.call('deleteNewsletterData', [item.rowIndex, item.fileId]).success, true);
  const types = t.call('listTrashFromWeb', [50]).items.map(i => i.entityType).sort();
  assert.deepEqual(types, ['newsletter', 'unitMaster'], 'どちらも30日のあいだ戻せる');
});

test('単元タブは、前の操作を反映し終えるまで次の行の操作を受けつけない', () => {
  // 画面側の守り。サーバの照合と二重にしてある。
  const client = fs.readFileSync('App_Js_12_UnitMaster.html', 'utf8');
  const overrides = fs.readFileSync('App_Js_15_DataProtection_Overrides.html', 'utf8');
  for (const [name, source] of [['saveUmEdit', client], ['showAddUnitMasterRow', client], ['insertUmRowAfter', client]]) {
    const body = source.slice(source.indexOf('function ' + name + '('));
    const end = body.indexOf('\n    }\n');
    assert.match(body.slice(0, end), /umBeginRowOperation\(\)/, `${name} が操作の停止を通っていません`);
  }
  const del = overrides.slice(overrides.indexOf('window.deleteUmRow'));
  assert.match(del.slice(0, del.indexOf('};')), /umBeginRowOperation\(\)[\s\S]*trashUnitMasterRowFromWeb\(rowIndex, umExpectedOf\(targetRow\)\)/);
  // 読み直しが終わったら（成功でも失敗でも）停止を解く
  const load = client.slice(client.indexOf('function loadUnitMasterData()'), client.indexOf('function getFilteredUmRows()'));
  assert.equal((load.match(/umSetBusy\(false\)/g) || []).length, 2);
});
