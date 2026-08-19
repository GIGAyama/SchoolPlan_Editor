import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 閲覧モードのセル操作(右クリックメニュー・D&D)の自動保存の回帰防止。
//
// 「この日の全コマをクリア」を曜日ごとに続けて使うと、月・火・水と消したあたりで
// 消したはずのコマが復活していた。保存はGASの往復に数秒かかるため、先に飛ばした
// 保存の応答(=保存した時点の内容)が後から返り、その内容で手元を上書きしていたのが原因。
// ここでは実際のクライアントコードを読み込み、応答が遅れる状況を再現して検証する。

const read = file => fs.readFileSync(file, 'utf8');

/** include ファイルの <script> ブロックを連結して取り出す。 */
function scriptBody(file) {
  const src = read(file);
  const blocks = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(blocks.length > 0, `${file}: <script> block not found`);
  return blocks.join('\n');
}

/** setTimeout を手で進められる時計に差し替える(GASの往復待ちを再現するため)。 */
function makeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, delay) {
      const id = ++seq;
      timers.set(id, { at: now + (delay || 0), fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    /** 期限の来たタイマーを実行する。ms 省略時は残り全部を順に消化する。 */
    advance(ms) {
      const until = ms === undefined ? Infinity : now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) {
          if (t.at > until) continue;
          if (!next || t.at < next.t.at || (t.at === next.t.at && id < next.id)) next = { id, t };
        }
        if (!next) break;
        timers.delete(next.id);
        now = Math.max(now, next.t.at);
        next.t.fn();
      }
      if (ms !== undefined) now = until;
    },
    get pending() { return timers.size; }
  };
}

/** 週データを1つ作る。全曜日・全校時に内容が入った状態から始める。 */
function makeDays() {
  return Array.from({ length: 7 }, (_, d) => ({
    date: `2026/8/${17 + d}`,
    dayLabel: '月火水木金土日'[d],
    found: true,
    event: '', preclass: '', morning: '', recess1: '', recess2: '',
    afterschool: '', homework: '', items: '',
    // 教科名は「単一教科名」でなければ保存時の検証に弾かれるため数字を入れない
    periods: Array.from({ length: 6 }, (_, p) => ({
      subject: `教科${'月火水木金土日'[d]}${'一二三四五六'[p]}`,
      unit: `単元${d}${p}`, content: `内容${d}${p}`
    }))
  }));
}

const clone = v => JSON.parse(JSON.stringify(v));

/**
 * 実物のクライアントコードを読み込んだサンドボックスを用意する。
 * DOM とサーバ呼び出しだけを差し替え、保存まわりのロジックはそのまま動かす。
 */
function bootClient(options) {
  const useProtected = !!(options && options.protectedOverrides);
  const clock = makeClock();
  const toasts = [];
  const renders = [];
  // サーバ(スプレッドシート)側の状態。保存された内容と、そこから決まるリビジョン。
  // normalize は、スプレッドシートが保存値を解釈し直す場合("007"→7 など)の再現用。
  const server = { days: makeDays(), revision: 1, normalize: null };
  // 送信済みで未応答の保存要求。テストが好きな順番・タイミングで返せるようにしておく。
  const inflight = [];

  const noop = () => {};
  const elementStub = {
    style: {}, classList: { add: noop, remove: noop, toggle: noop },
    setAttribute: noop, removeAttribute: noop, appendChild: noop, remove: noop,
    addEventListener: noop, focus: noop, blur: noop, contains: () => false,
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    value: '', dataset: {}, innerHTML: '', textContent: ''
  };

  const sandbox = {
    console,
    JSON, Math, Date, Promise, Array, Object, String, Number, Boolean, RegExp, Error, Set, Map,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    requestAnimationFrame: noop, addEventListener: noop, removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
    navigator: {},
    localStorage: { getItem: () => null, setItem: noop },
    Swal: { fire: () => Promise.resolve({}), close: noop, getHtmlContainer: () => elementStub },
    document: {
      addEventListener: noop, body: elementStub, activeElement: null,
      // ボタンやラベルの参照は素通りさせる（UIの更新はテスト対象ではない）
      getElementById: () => Object.create(elementStub),
      querySelector: () => Object.create(elementStub),
      querySelectorAll: () => [],
      createElement: () => Object.create(elementStub)
    },
    google: {
      script: {
        run: (function makeRunner(handlers) {
          const api = {
            withSuccessHandler(fn) { return makeRunner({ ...handlers, ok: fn }); },
            withFailureHandler(fn) { return makeRunner({ ...handlers, fail: fn }); }
          };
          for (const name of ['saveWeeklyPlanDataV2', 'saveWeeklyPlanDataProtected']) {
            api[name] = (mondayStr, days, baseRevision) => {
              inflight.push({ mondayStr, days: clone(days), baseRevision, handlers });
            };
          }
          return api;
        })({})
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  const files = ['App_Js_01_Core.html', 'App_Js_02_Plan.html', 'App_Js_14_MultiClass.html'];
  // 本番では App_Js_15 の保護版が最終実装になる。両方を同じ筋書きで確かめる。
  if (useProtected) files.push('App_Js_15_DataProtection_Overrides.html');
  for (const file of files) {
    vm.runInContext(scriptBody(file), context, { filename: file });
  }
  if (useProtected) {
    vm.runInContext('p3InjectProtectionCard = function () {}; p3LoadProtectionStatus = function () {};', context);
    vm.runInContext('p3InstallProtectedOverrides();', context);
  }

  // DOM を触る部分だけ差し替える。保存・履歴・取り込みのロジックは実物のまま動かす。
  vm.runInContext(`
    showToast = function (type, msg) { __toasts.push([type, msg]); };
    renderWeekGrid = function (days) { __renders.push(JSON.parse(JSON.stringify(days))); };
    rerenderGridPreservingFocus = function () { renderWeekGrid(STATE.weekData.days); };
    collectCurrentEditData = function () { return STATE.weekData ? STATE.weekData.days : null; };
    updateWeekHeader = function () {};
    renderWeeklyTaskPanel = function () {};
  `, context);
  sandbox.__toasts = toasts;
  sandbox.__renders = renders;

  const run = code => vm.runInContext(code, context);
  // STATE / GRID_ROWS は const 宣言なのでグローバルオブジェクト経由では取れない
  const STATE = run('STATE');
  STATE.mondayStr = '2026/8/17';
  STATE.editMode = false;
  STATE.weekData = { success: true, mondayDateStr: '2026/8/17', days: clone(server.days), revision: server.revision };

  /** 送信済みの保存要求を1件、サーバに適用して応答を返す。 */
  function respondOne(index) {
    const call = inflight.splice(index === undefined ? 0 : index, 1)[0];
    assert.ok(call, 'no in-flight save to respond to');
    const changed = JSON.stringify(call.days) !== JSON.stringify(server.days);
    if (changed && call.baseRevision !== server.revision) {
      call.handlers.ok({ success: false, conflict: true, error: 'conflict',
        current: { mondayDateStr: call.mondayStr, revision: server.revision, days: clone(server.days) } });
      return;
    }
    if (changed) {
      server.days = clone(call.days);
      if (server.normalize) server.normalize(server.days);
      server.revision += 1;
    }
    call.handlers.ok({ success: true, message: 'saved', revision: server.revision, days: clone(server.days) });
  }

  return { STATE, clock, server, inflight, toasts, renders, respondOne, run };
}

/** 教科が全部空になっている曜日の番号。 */
const clearedDays = days => days
  .map((d, i) => (d.periods.every(p => !p.subject && !p.unit && !p.content) ? i : -1))
  .filter(i => i >= 0);

for (const variant of [
  { label: 'V2保存', options: {} },
  { label: '保護版保存', options: { protectedOverrides: true } }
]) {
test(`曜日ごとの「この日の全コマをクリア」を連続で使っても消したコマが復活しない（${variant.label}）`, () => {
  const c = bootClient(variant.options);

  // 月曜をクリア → 遅延保存が飛ぶ（応答はまだ返さない = GASの往復待ち）
  c.run(`handleContextAction('clearDay', 0, 0)`);
  c.clock.advance(450);
  assert.equal(c.inflight.length, 1, '月曜の保存が送信されていること');

  // 応答を待つあいだに火・水をクリア。進行中の保存があるので待たされる。
  c.run(`handleContextAction('clearDay', 1, 0)`);
  c.clock.advance(450);
  c.run(`handleContextAction('clearDay', 2, 0)`);
  c.clock.advance(450);
  assert.equal(c.inflight.length, 1, '保存は1件ずつ直列に送ること');

  // ここで月曜だけを保存した応答が返る（サーバは火・水がまだ埋まった状態を返す）
  c.respondOne();
  assert.deepEqual(clearedDays(c.STATE.weekData.days), [0, 1, 2],
    '応答の取り込みで火・水のクリアが巻き戻ってはいけない');

  // 待たされていた保存が走り、木曜のクリアも重ねる
  c.clock.advance(0);
  assert.equal(c.inflight.length, 1);
  c.run(`handleContextAction('clearDay', 3, 0)`);
  c.clock.advance(450);
  c.respondOne();
  c.clock.advance();
  while (c.inflight.length) { c.respondOne(); c.clock.advance(); }

  assert.deepEqual(clearedDays(c.STATE.weekData.days), [0, 1, 2, 3],
    '画面上の週データに4日分のクリアが残ること');
  assert.deepEqual(clearedDays(c.server.days), [0, 1, 2, 3],
    'サーバにも4日分のクリアが保存されること');
  // 巻き戻った内容を描き直していないこと（描画があるなら常にクリア済みの側）
  for (const snapshot of c.renders) {
    assert.ok(clearedDays(snapshot).length >= 1, 'クリア前の内容で再描画してはいけない');
  }
});
}

test('待たされる保存は週ごとに1件だけで、待機中の変更もまとめて送られる', () => {
  const c = bootClient();

  c.run(`handleContextAction('clearDay', 0, 0)`);
  c.clock.advance(450);
  assert.equal(c.inflight.length, 1);

  // 進行中の保存の裏で3回操作しても、待たせる保存は1件に畳まれる
  c.run(`handleContextAction('clearDay', 1, 0)`);
  c.clock.advance(450);
  c.run(`handleContextAction('clearDay', 2, 0)`);
  c.clock.advance(450);
  c.run(`handleContextAction('clearPeriod', 4, 5)`);
  c.clock.advance(450);

  c.respondOne();
  c.clock.advance();
  assert.equal(c.inflight.length, 1, '待たせた保存は1件だけ');
  // その1件が、待機中に増えた変更をすべて含んでいること
  assert.deepEqual(clearedDays(c.inflight[0].days), [0, 1, 2]);
  assert.ok(c.inflight[0].days.every(d => !d.periods[5].subject), '6校時の全曜日クリアも含むこと');

  c.respondOne();
  c.clock.advance();
  assert.equal(c.inflight.length, 0, '同じ内容の保存が積み上がらないこと');
});

test('取り込みは保存要求を出したあとに書き換えていない時だけ行う', () => {
  const c = bootClient();
  const days = c.STATE.weekData.days;

  // 書き換えていなければ、サーバが正規化した値を取り込む
  c.run(`markWeekDaysMutated()`);
  const seq = c.run(`weekDaysMutationSeq()`);
  const normalizedDays = clone(days);
  normalizedDays[0].periods[0].subject = '正規化後';
  let adopted = c.run('adoptSavedWeekDays')({ days: normalizedDays }, days, c.STATE.weekData, seq);
  assert.equal(adopted, true);
  assert.equal(c.STATE.weekData.days[0].periods[0].subject, '正規化後');

  // 書き換えたあとなら取り込まない（手元の新しい内容を残す）
  c.run(`markWeekDaysMutated()`);
  const stale = clone(c.STATE.weekData.days);
  stale[1].periods[0].subject = '古い値';
  adopted = c.run('adoptSavedWeekDays')({ days: stale }, stale, c.STATE.weekData, seq);
  assert.equal(adopted, false);
  assert.notEqual(c.STATE.weekData.days[1].periods[0].subject, '古い値');
});

test('セル操作は手元の週データを書き換えたことを記録する', () => {
  const c = bootClient();
  const before = c.run(`weekDaysMutationSeq()`);
  c.run(`handleContextAction('clearDay', 0, 0)`);
  assert.ok(c.run(`weekDaysMutationSeq()`) > before, 'clearDay が記録されること');

  const afterClear = c.run(`weekDaysMutationSeq()`);
  c.run(`undo()`);
  assert.ok(c.run(`weekDaysMutationSeq()`) > afterClear, 'undo が記録されること');

  const afterUndo = c.run(`weekDaysMutationSeq()`);
  c.run(`redo()`);
  assert.ok(c.run(`weekDaysMutationSeq()`) > afterUndo, 'redo が記録されること');
});

for (const variant of [
  { label: 'V2保存', options: {} },
  { label: '保護版保存', options: { protectedOverrides: true } }
]) {
test(`保存中に使った右クリックメニューのクリアが保存応答で消えない（${variant.label}）`, () => {
  const c = bootClient(variant.options);
  c.run(`STATE.editMode = true; STATE.editBaseline = JSON.parse(JSON.stringify(STATE.weekData.days));`);

  // 「保存する」を押す（ボタンは無効化されるがグリッドはまだ操作できる）
  c.run(`saveWeeklyPlan()`);
  assert.equal(c.inflight.length, 1);

  // 応答を待つあいだに「この日の全コマをクリア」を使う
  c.run(`handleContextAction('clearDay', 2, 0)`);
  c.respondOne();
  c.clock.advance();

  assert.ok(clearedDays(c.STATE.weekData.days).includes(2),
    '保存応答の取り込みでクリアが消えてはいけない');
  // 閲覧モードへ戻ったあと、間に合わなかった分が保存し直される
  while (c.inflight.length) { c.respondOne(); c.clock.advance(); }
  assert.ok(clearedDays(c.server.days).includes(2), 'クリアがサーバにも保存されること');
});
}

test('編集モードに入ったあとは閲覧モードの保存応答で画面を書き換えない', () => {
  const c = bootClient();
  // シート側で値が解釈し直された（応答が手元と違う内容で返る）状況にする
  c.server.normalize = days => { days[6].periods[0].subject = '正規化後'; };

  c.run(`handleContextAction('clearDay', 0, 0)`);
  c.clock.advance(450);
  assert.equal(c.inflight.length, 1);

  // 応答を待つあいだに編集モードへ。入力欄の内容が最新なので取り込んではいけない。
  c.run(`STATE.editMode = true; STATE.editBaseline = 'edit-start';`);
  const rendersBefore = c.renders.length;
  c.respondOne();
  c.clock.advance();
  assert.equal(c.renders.length, rendersBefore, '編集中のグリッドを描き直さないこと');
  assert.notEqual(c.STATE.weekData.days[6].periods[0].subject, '正規化後',
    '編集中の内容をサーバの値で置き換えないこと');
  assert.equal(c.STATE.editBaseline, 'edit-start', '編集開始時のスナップショットを壊さないこと');
});
