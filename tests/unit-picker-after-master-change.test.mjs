import test from 'node:test';
import assert from 'node:assert/strict';

import { bootClient, setWeek, makeDays } from './helpers/webapp-sandbox.mjs';

// 単元を「終了にする」と、単元マスタが変わるので invalidateMasterData() が
// STATE.masterData を空にしてから取り直す。届くまでの間に単元ピッカーを開くと
// マスタが空に見えて「単元マスタデータが見つかりません」になっていた
// （終了にした直後の開き直しで必ず起き、ページを再読み込みするまで直らないように見えた）。
// ピッカーは、マスタが届くのを待ってから開くこと。

const MASTER = {
  success: true,
  subjects: ['国語'],
  masterMap: {
    国語: [
      { unitName: 'ごんぎつね', totalHours: 2 },
      { unitName: '大造じいさん', totalHours: 2 }
    ]
  }
};

const PROGRESS = {
  success: true,
  subjects: {
    国語: {
      subjectLabel: '国語',
      nextUnitName: '大造じいさん',
      units: [
        {
          unitName: 'ごんぎつね', order: 0, declaredTotal: 2, masterRowHours: 3,
          effectiveTotal: 2, taughtHour: 2, plannedHour: 2, nextHour: 2,
          status: 'done', isNext: false, overTaught: false, totalMismatch: false
        },
        {
          unitName: '大造じいさん', order: 1, declaredTotal: 2, masterRowHours: 2,
          effectiveTotal: 2, taughtHour: 0, plannedHour: 0, nextHour: 1,
          status: 'untaught', isNext: true, overTaught: false, totalMismatch: false
        }
      ],
      orphans: []
    }
  },
  warnings: []
};

const SUBJECT_INPUT = '[data-field="subject"][data-day="0"][data-period="0"]';

/** 編集モードで、月曜1校時の教科欄に「国語」が入っている画面を用意する。 */
function boot() {
  const h = bootClient({
    gridInputs: true,
    extraFiles: ['App_Js_16_UnitProgress.html'],
    serverMethods: ['getUnitMasterForSuggest', 'getUnitProgressIndexFromWeb',
      'closeUnitsAtTaughtHours', 'reopenClosedUnits']
  });
  setWeek(h, '2026/08/17', makeDays());
  h.run(`STATE.masterData = ${JSON.stringify(MASTER)};`);
  h.STATE.editMode = true;
  h.gridInput(SUBJECT_INPUT).value = '国語';
  h.run('__fires = []; Swal.fire = function (o) { __fires.push(o && o.title); return Promise.resolve({}); };');
  return h;
}

const pickerTitles = (h) => JSON.parse(h.run('JSON.stringify(__fires)'));
const notFoundToasts = (h) => h.toasts.filter(([, msg]) => /見つかりません/.test(String(msg)));

/** 指定の名前で積まれた google.script.run の呼び出しを、古い順に1つ取り出す。 */
function take(h, name) {
  const i = h.inflight.findIndex(c => c.name === name);
  assert.ok(i !== -1, `${name} が呼ばれていない（呼ばれたもの: ${h.inflight.map(c => c.name).join(', ')}）`);
  return h.inflight.splice(i, 1)[0];
}

/** 「ごんぎつね」を終了にした、というサーバの返事までを進める。 */
function closeGongitsune(h) {
  h.run(`postUnitClosure(0, 0, '国語', [${JSON.stringify(PROGRESS.subjects.国語.units[0])}], 'close');`);
  take(h, 'closeUnitsAtTaughtHours').handlers.ok({
    success: true, changedCount: 1, message: '「ごんぎつね」を終了にしました。'
  });
}

test('終了にした直後に開き直しても「見つかりません」にならず、マスタが届いてから開く', () => {
  const h = boot();
  closeGongitsune(h);

  // マスタの取り直しが飛んでいるだけで、まだ何も言わない
  assert.equal(h.STATE.masterData, null);
  assert.deepEqual(notFoundToasts(h), []);
  assert.deepEqual(pickerTitles(h), []);

  take(h, 'getUnitMasterForSuggest').handlers.ok(MASTER);
  take(h, 'getUnitProgressIndexFromWeb').handlers.ok(PROGRESS);

  assert.deepEqual(notFoundToasts(h), []);
  assert.deepEqual(pickerTitles(h), ['「国語」の単元を選択']);
});

test('取り直しの最中に自分で単元ピッカーを開いても、届いてから1回だけ開く', () => {
  const h = boot();
  h.run('invalidateMasterData();');

  // 届く前に2回押す（反応が無いので押し直した、を再現）
  h.run('openUnitPicker(0, 0); openUnitPicker(0, 0);');
  assert.deepEqual(notFoundToasts(h), []);
  assert.equal(h.inflight.filter(c => c.name === 'getUnitMasterForSuggest').length, 1,
    '取り直しを二重に頼まない');

  take(h, 'getUnitMasterForSuggest').handlers.ok(MASTER);
  take(h, 'getUnitProgressIndexFromWeb').handlers.ok(PROGRESS);
  assert.deepEqual(pickerTitles(h), ['「国語」の単元を選択']);
});

test('取り直しを頼み直したら、先に頼んだ古い応答では上書きしない', () => {
  const h = boot();
  h.run('invalidateMasterData();');
  const stale = take(h, 'getUnitMasterForSuggest');
  h.run('invalidateMasterData();');
  const fresh = take(h, 'getUnitMasterForSuggest');

  stale.handlers.ok({ success: true, subjects: ['国語'], masterMap: { 国語: [{ unitName: '古い単元', totalHours: 1 }] } });
  assert.equal(h.STATE.masterData, null, '古い応答はまだ届いていないものとして扱う');

  fresh.handlers.ok(MASTER);
  assert.equal(h.STATE.masterData.masterMap.国語[0].unitName, 'ごんぎつね');
});

test('マスタを読めなかったときは読めなかったと言い、次に押したときに読み直す', () => {
  const h = boot();
  h.run('invalidateMasterData();');
  h.run('openUnitPicker(0, 0);');

  take(h, 'getUnitMasterForSuggest').handlers.ok({ success: false, error: 'サーバ側の都合' });
  assert.deepEqual(notFoundToasts(h), []);
  assert.ok(h.toasts.some(([type, msg]) => type === 'error' && /読み込めませんでした/.test(msg)));
  assert.deepEqual(pickerTitles(h), []);

  // 押し直せば、そのまま放置せず取りに行く
  h.run('openUnitPicker(0, 0);');
  take(h, 'getUnitMasterForSuggest').handlers.ok(MASTER);
  take(h, 'getUnitProgressIndexFromWeb').handlers.ok(PROGRESS);
  assert.deepEqual(pickerTitles(h), ['「国語」の単元を選択']);
});

test('待っている間に編集を終えていたら、ピッカーは開かない', () => {
  const h = boot();
  h.run('invalidateMasterData();');
  h.run('openUnitPicker(0, 0);');
  h.STATE.editMode = false;

  take(h, 'getUnitMasterForSuggest').handlers.ok(MASTER);
  assert.deepEqual(pickerTitles(h), []);
  assert.equal(h.inflight.filter(c => c.name === 'getUnitProgressIndexFromWeb').length, 0);
});
