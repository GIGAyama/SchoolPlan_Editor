import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { bootClient } from './helpers/webapp-sandbox.mjs';

// 教科セルは "国語2/3 行事1/3" のように、1コマを複数教科で分け合って書ける。
// この文字列をそのまま教科名として単元マスタを引くと当然どこにも当たらず、
// 単元ピッカーは「単元マスタデータが見つかりません」で止まり、自動入力は
// 学習内容を入れずに飛ばしていた。分け合いのセルでも、書かれている教科名から
// 正しい教科の単元マスタを引けることを、サーバ・クライアントの両側で固定する。

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

function loadContext() {
  const context = vm.createContext({ console });
  for (const file of ['00_config.gs', '99_Utils.gs', '04_AutoFill.gs', '14_UnitProgress.gs']) {
    vm.runInContext(read(file), context, { filename: file });
  }
  // Date は vm 側の realm で作らないと、instanceof Date の判定を通らない。
  vm.runInContext('globalThis.__mkDate = (y, m, d) => new Date(y, m, d);', context);
  return context;
}

const host = (arr) => [...arr];

const MASTER = [
  ['教科', '単元名', '総時間数', '何時間目', '学習活動'],
  ['国語', 'ごんぎつね', 3, 1, 'ごん1'],
  ['国語', 'ごんぎつね', 3, 2, 'ごん2'],
  ['国語', 'ごんぎつね', 3, 3, 'ごん3'],
  ['国語', '大造じいさん', 2, 1, '大造1'],
  ['図工', '版画', 2, 1, '版画1']
];

// ===== 教科セルの分解 =====

test('教科セルの教科名を、分数の大きい順に取り出す', () => {
  const context = loadContext();
  assert.deepEqual(host(context.listSubjectNamesInCell_('国語2/3 行事1/3')), ['国語', '行事']);
  // 書かれた順ではなく分数の大きい順。1コマの主たる教科が先頭に来る
  assert.deepEqual(host(context.listSubjectNamesInCell_('行事1/3 国語2/3')), ['国語', '行事']);
  // 全角スペース区切り・分数なしの単一教科も同じ入口で扱える
  assert.deepEqual(host(context.listSubjectNamesInCell_('国語1/2　算数1/2')), ['国語', '算数']);
  assert.deepEqual(host(context.listSubjectNamesInCell_('国語')), ['国語']);
  assert.deepEqual(host(context.listSubjectNamesInCell_('')), []);
});

test('分け合いのセルから、単元マスタに載っている教科を選ぶ', () => {
  const context = loadContext();
  const hasMaster = (key) => key === '国語' || key === '図画工作';

  assert.equal(context.resolveMasterSubjectName_('国語2/3 行事1/3', hasMaster), '国語');
  // 分数が大きくても単元マスタに無い教科（行事）は選ばない
  assert.equal(context.resolveMasterSubjectName_('行事2/3 国語1/3', hasMaster), '国語');
  // 図工/図画工作の表記ゆれも同一教科として拾う
  assert.equal(context.resolveMasterSubjectName_('図工1/2 行事1/2', hasMaster), '図工');
  // 単一教科のセルは、これまでどおりそのまま
  assert.equal(context.resolveMasterSubjectName_('国語', hasMaster), '国語');
  // どの教科もマスタに無ければセルの値のまま返す（「見つかりません」の文言を変えない）
  assert.equal(context.resolveMasterSubjectName_('行事2/3 総合1/3', hasMaster), '行事2/3 総合1/3');
});

test('数字を含む教科名を分解して壊さない', () => {
  const context = loadContext();
  // "3年体育" を分数付き複数教科として読むと "年体育" になってしまう。
  // セルの文字列そのものを先に試すことで、そういう教科名を守る。
  assert.equal(context.resolveMasterSubjectName_('3年体育', (key) => key === '3年体育'), '3年体育');
});

test('教科セルにその教科が入っているかを、分け合いも含めて判定する', () => {
  const context = loadContext();
  assert.equal(context.subjectCellHasSubject_('国語2/3 行事1/3', '国語'), true);
  assert.equal(context.subjectCellHasSubject_('国語2/3 行事1/3', '行事'), true);
  assert.equal(context.subjectCellHasSubject_('国語2/3 行事1/3', '算数'), false);
  assert.equal(context.subjectCellHasSubject_('図画工作', '図工'), true, '表記ゆれは同一教科');
});

// ===== 単元マスタの引き当て =====

test('分け合いのコマでも、教科名から学習内容を取れる', () => {
  const context = loadContext();
  assert.equal(context.findActivityFromMaster_(MASTER, '国語2/3 行事1/3', 'ごんぎつね', 2), 'ごん2');
  assert.equal(context.findActivityFromMaster_(MASTER, '行事1/3 図工2/3', '版画', 1), '版画1');
  // 単一教科のときの挙動は変わらない
  assert.equal(context.findActivityFromMaster_(MASTER, '国語', 'ごんぎつね', 1), 'ごん1');
});

test('分け合いのコマでも、単元マスタの単元情報を引ける', () => {
  const context = loadContext();
  const masterIndex = context.buildMasterIndex_(MASTER);
  const unit = context.getMasterUnit_(masterIndex, '国語2/3 行事1/3', 'ごんぎつね');
  assert.ok(unit, '国語の単元マスタから引けている');
  assert.equal(unit.declaredTotal, 3);
  assert.equal(context.findActivitySmart_(masterIndex, '国語2/3 行事1/3', 'ごんぎつね', 3), 'ごん3');
});

test('分け合いのコマでも、次に指導する単元を決められる', () => {
  const context = loadContext();
  const masterIndex = context.buildMasterIndex_(MASTER);
  const tracker = context.createProgressTracker_(masterIndex, {});
  const next = context.determineNextLessonSmart_('国語2/3 行事1/3', null, masterIndex, tracker, []);
  assert.ok(next, '「単元マスタに教科が見つからない」で飛ばされない');
  assert.equal(next.unitName, 'ごんぎつね');
  assert.equal(next.currentHour, 1);
});

// ===== 指導履歴 =====

const DB_COLS = { DATE: 1, PERIOD1: 2, UNIT1: 3 };

function buildDb(mk) {
  return [
    ['日付', '1校時', '単元1'],
    [mk(2026, 3, 10), '国語', 'ごんぎつね 1/3'],
    // 行事と分け合ったコマ。国語の指導履歴として数えたい
    [mk(2026, 3, 11), '国語2/3 行事1/3', 'ごんぎつね 2/3']
  ];
}

test('分け合いのコマの指導履歴を、その教科の履歴として数える', () => {
  const context = loadContext();
  const mk = context.__mkDate;
  const masterIndex = context.buildMasterIndex_(MASTER);
  const history = context.buildTaughtHistory_(buildDb(mk), DB_COLS, mk(2026, 3, 20), masterIndex);

  assert.ok(history['国語'], '教科セルの文字列そのものではなく国語のキーに入る');
  assert.equal(history['国語'].units['ごんぎつね'].maxHour, 2);
  assert.equal(history['国語2/3 行事1/3'], undefined);
});

test('単元マスタを渡さない指導履歴は、これまでどおり教科セルの文字列で数える', () => {
  const context = loadContext();
  const mk = context.__mkDate;
  const history = context.buildTaughtHistory_(buildDb(mk), DB_COLS, mk(2026, 3, 20));
  assert.equal(history['国語'].units['ごんぎつね'].maxHour, 1);
});

test('分け合いのコマを、前週の同じスロットの単元として拾う', () => {
  const context = loadContext();
  const mk = context.__mkDate;
  // findLastLessonForSlot_ は列マップをシートから引くので、テスト用の列だけ差し替える
  vm.runInContext(`getDbColumns = () => (${JSON.stringify(DB_COLS)});`, context);
  // 2026/4/11 は土曜（曜日インデックス5）。その翌々日の月曜を基準の週頭にする
  const found = context.findLastLessonForSlot_(buildDb(mk), '国語', 5, 0, mk(2026, 3, 13));
  assert.ok(found, '教科セルが分け合いでも同じスロットの国語として見つかる');
  assert.equal(found.unitName, 'ごんぎつね');
  assert.equal(found.currentHour, 2);
});

test('単元進捗インデックスが、分け合いのコマを教科の進捗に数える', () => {
  const context = loadContext();
  const mk = context.__mkDate;
  const out = context.buildUnitProgressPayload_(
    MASTER, buildDb(mk), DB_COLS, mk(2026, 3, 20), mk(9999, 0, 1)
  );
  const unit = out.subjects['国語'].units.find((u) => u.unitName === 'ごんぎつね');
  assert.equal(unit.taughtHour, 2);
  assert.equal(unit.nextHour, 3);
  assert.equal(host(out.subjects['国語'].orphans).length, 0);
});

// ===== クライアント（単元ピッカー） =====

function bootWithMaster() {
  const harness = bootClient({ extraFiles: ['App_Js_16_UnitProgress.html'] });
  harness.run(`STATE.masterData = {
    subjects: ['国語', '図工'],
    masterMap: {
      '国語': [{ unitName: 'ごんぎつね', totalHours: 3 }],
      '図工': [{ unitName: '版画', totalHours: 2 }]
    }
  };`);
  return harness;
}

test('画面側も、分け合いの教科セルから単元マスタの教科を決められる', () => {
  const harness = bootWithMaster();
  const resolve = (cell) => harness.run(`resolveMasterSubject(STATE.masterData.masterMap, ${JSON.stringify(cell)})`);

  assert.equal(resolve('国語2/3 行事1/3'), '国語');
  assert.equal(resolve('行事2/3 国語1/3'), '国語', '単元マスタに無い行事は選ばない');
  assert.equal(resolve('図画工作1/2 行事1/2'), '図画工作', '表記ゆれも同一教科として引く');
  assert.equal(resolve('国語'), '国語');
  assert.equal(resolve('行事'), '行事', 'どの教科もマスタに無ければセルの値のまま');
});

test('画面側の単元リスト取得が、分け合いの教科セルでも単元を返す', () => {
  const harness = bootWithMaster();
  const units = harness.run(`(function () {
    var map = STATE.masterData.masterMap;
    return JSON.stringify(lookupMasterMapUnits(map, resolveMasterSubject(map, '国語2/3 行事1/3')));
  })()`);
  assert.deepEqual(JSON.parse(units), [{ unitName: 'ごんぎつね', totalHours: 3 }]);
});

test('教科名の分解ルールがサーバとクライアントで揃っている', () => {
  const harness = bootWithMaster();
  const context = loadContext();
  for (const cell of ['国語2/3 行事1/3', '行事1/3 国語2/3', '国語1/2　算数1/2', '国語', '']) {
    const client = JSON.parse(harness.run(`JSON.stringify(listSubjectNamesInCell(${JSON.stringify(cell)}))`));
    assert.deepEqual(client, host(context.listSubjectNamesInCell_(cell)), cell);
  }
});
