import test from 'node:test';
import assert from 'node:assert/strict';

import { bootClient, setWeek } from './helpers/webapp-sandbox.mjs';

// 単元ピッカーは「保存前」の入力も進捗へ重ねる（App_Js_16_UnitProgress.html）。
// これが壊れると、月曜に1時間目を入れても火曜のピッカーがまた1時間目を案内する。
// 重ね方の規則はサーバの 14_UnitProgress.gs buildUnitProgressPayload_ と同じで、
// 片方だけ直すと保存前と保存後で案内が変わるため、ここで規則ごと固定しておく。

/** サーバの進捗インデックスと同じ形のペイロードを作る（国語＝2単元）。 */
function makeProgress() {
  return {
    success: true,
    subjects: {
      国語: {
        subjectLabel: '国語',
        nextUnitName: 'ごんぎつね',
        units: [
          {
            unitName: 'ごんぎつね', order: 0, declaredTotal: 3, masterRowHours: 3,
            effectiveTotal: 3, taughtHour: 0, plannedHour: 0, nextHour: 1,
            status: 'untaught', isNext: true, overTaught: false, totalMismatch: false
          },
          {
            unitName: '大造じいさん', order: 1, declaredTotal: 2, masterRowHours: 2,
            effectiveTotal: 2, taughtHour: 0, plannedHour: 0, nextHour: 1,
            status: 'untaught', isNext: false, overTaught: false, totalMismatch: false
          }
        ],
        orphans: []
      }
    },
    warnings: []
  };
}

/** 単元セルだけを差し替えた1週間分の週データ。日付は過去なので「実施済み」側に入る。 */
function makeWeek(cells) {
  return Array.from({ length: 7 }, (_, d) => ({
    date: `2026/06/${String(15 + d).padStart(2, '0')}`,
    dayLabel: '月火水木金土日'[d],
    found: true,
    event: '', preclass: '', morning: '', recess1: '', recess2: '',
    afterschool: '', homework: '', items: '',
    periods: Array.from({ length: 6 }, (_, p) => {
      const cell = (cells[d] || {})[p];
      return cell
        ? { subject: cell.subject, unit: cell.unit, content: '' }
        : { subject: '', unit: '', content: '' };
    })
  }));
}

/**
 * 週データを載せた状態で syncUnitProgressWithGrid を通し、結果を素のオブジェクトで返す。
 * vm 側のオブジェクトはホストの assert と相性が悪いので JSON で持ち帰る。
 */
function sync(cells, progress = makeProgress()) {
  const harness = bootClient({ extraFiles: ['App_Js_16_UnitProgress.html'] });
  setWeek(harness, '2026/06/15', makeWeek(cells));
  harness.run(`__progress = ${JSON.stringify(progress)};`);
  return JSON.parse(harness.run('JSON.stringify(syncUnitProgressWithGrid(__progress))'));
}

const unitOf = (progress, name) =>
  progress.subjects.国語.units.find(u => u.unitName === name);

test('月曜に1時間目を入れると、保存しなくても次は2時間目になる', () => {
  const after = sync({ 0: { 0: { subject: '国語', unit: 'ごんぎつね 1/3' } } });
  const unit = unitOf(after, 'ごんぎつね');

  assert.equal(unit.plannedHour, 1);
  assert.equal(unit.taughtHour, 1);
  assert.equal(unit.nextHour, 2);
  assert.equal(unit.status, 'inProgress');
  assert.equal(unit.isNext, true);
  assert.equal(after.subjects.国語.nextUnitName, 'ごんぎつね');
});

test('未来の日付は「入力済み」だけで「実施済み」には数えない', () => {
  const progress = makeProgress();
  const harness = bootClient({ extraFiles: ['App_Js_16_UnitProgress.html'] });
  const days = makeWeek({ 0: { 0: { subject: '国語', unit: 'ごんぎつね 1/3' } } });
  days[0].date = '2999/01/01';
  setWeek(harness, '2999/01/01', days);
  harness.run(`__progress = ${JSON.stringify(progress)};`);
  const after = JSON.parse(harness.run('JSON.stringify(syncUnitProgressWithGrid(__progress))'));

  const unit = unitOf(after, 'ごんぎつね');
  assert.equal(unit.plannedHour, 1);
  assert.equal(unit.taughtHour, 0);
  assert.equal(unit.nextHour, 2);
});

test('最終時間まで入れると指導済みになり、次の単元が先頭に来る', () => {
  const after = sync({
    0: { 0: { subject: '国語', unit: 'ごんぎつね 1/3' } },
    1: { 0: { subject: '国語', unit: 'ごんぎつね 2/3' } },
    2: { 0: { subject: '国語', unit: 'ごんぎつね 3/3' } }
  });

  const done = unitOf(after, 'ごんぎつね');
  assert.equal(done.status, 'done');
  // 指導済みの単元は総時数を超える時間目を案内しない
  assert.equal(done.nextHour, 3);
  assert.equal(done.isNext, false);

  const next = unitOf(after, '大造じいさん');
  assert.equal(next.isNext, true);
  assert.equal(next.nextHour, 1);
  assert.equal(after.subjects.国語.nextUnitName, '大造じいさん');
});

test('着手済みの単元があれば、マスタ順より優先して「次はここから」になる', () => {
  const after = sync({
    0: { 0: { subject: '国語', unit: 'ごんぎつね 1/3' } },
    1: { 0: { subject: '国語', unit: 'ごんぎつね 2/3' } },
    2: { 0: { subject: '国語', unit: 'ごんぎつね 3/3' } },
    3: { 0: { subject: '国語', unit: '大造じいさん 1/2' } }
  });
  assert.equal(after.subjects.国語.nextUnitName, '大造じいさん');
  assert.equal(unitOf(after, '大造じいさん').nextHour, 2);
});

test('保存済みの進捗と同じ入力を重ねても二重に数えない（冪等）', () => {
  // サーバがすでに 2/3 まで数えている週を、そのまま重ねる
  const progress = makeProgress();
  const unit = progress.subjects.国語.units[0];
  unit.plannedHour = 2;
  unit.taughtHour = 2;
  unit.nextHour = 3;
  unit.status = 'inProgress';

  const cells = {
    0: { 0: { subject: '国語', unit: 'ごんぎつね 1/3' } },
    1: { 0: { subject: '国語', unit: 'ごんぎつね 2/3' } }
  };
  const once = sync(cells, progress);
  const twice = sync(cells, JSON.parse(JSON.stringify(once)));
  assert.deepEqual(unitOf(twice, 'ごんぎつね'), unitOf(once, 'ごんぎつね'));
  assert.equal(unitOf(once, 'ごんぎつね').plannedHour, 2);
  assert.equal(unitOf(once, 'ごんぎつね').nextHour, 3);
});

test('教科名の表記ゆれ（図工／図画工作）でも同じ単元として重なる', () => {
  const progress = {
    success: true,
    subjects: {
      図画工作: {
        subjectLabel: '図画工作',
        nextUnitName: '版画',
        units: [{
          unitName: '版画', order: 0, declaredTotal: 2, masterRowHours: 2,
          effectiveTotal: 2, taughtHour: 0, plannedHour: 0, nextHour: 1,
          status: 'untaught', isNext: true, overTaught: false, totalMismatch: false
        }],
        orphans: []
      }
    },
    warnings: []
  };
  const after = sync({ 0: { 0: { subject: '図工', unit: '版画 1/2' } } }, progress);
  assert.equal(after.subjects.図画工作.units[0].nextHour, 2);
});

test('マスタに無い単元は孤立として拾い、マスタの単元を壊さない', () => {
  const after = sync({ 0: { 0: { subject: '国語', unit: '自作の単元 2/4' } } });

  assert.deepEqual(after.subjects.国語.orphans, [{ unitName: '自作の単元', plannedHour: 2 }]);
  assert.equal(unitOf(after, 'ごんぎつね').plannedHour, 0);
  assert.equal(unitOf(after, 'ごんぎつね').isNext, true);
});

test('総時数を超えた入力でも案内が破綻せず、超過として印が付く', () => {
  const after = sync({
    0: { 0: { subject: '国語', unit: 'ごんぎつね 4/3' } }
  });
  const unit = unitOf(after, 'ごんぎつね');
  assert.equal(unit.effectiveTotal, 4);
  assert.equal(unit.status, 'done');
  assert.equal(unit.nextHour, 4);
  assert.equal(unit.overTaught, true);
});

test('単元セルが空・書式外の週では進捗をまったく変えない', () => {
  const before = makeProgress();
  const after = sync({ 0: { 0: { subject: '国語', unit: 'ごんぎつね（ふりかえり）' } } }, makeProgress());
  assert.deepEqual(after.subjects, before.subjects);
});

test('進捗の重ね合わせを openUnitPicker が通っている', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('App_Js_16_UnitProgress.html', 'utf8');
  assert.match(src, /findProgressSubject\(syncUnitProgressWithGrid\(progress\), subject\)/);
  // 追加のサーバ往復を入れない（forceRefresh 付きの取得を増やさない）
  assert.doesNotMatch(src, /loadUnitProgress\([^)]*,\s*true\s*\)/);
});
