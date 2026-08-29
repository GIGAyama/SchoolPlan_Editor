import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { bootClient, makeClock, makeDays, scriptBody } from './helpers/webapp-sandbox.mjs';

// トーストの回帰防止。
//
// 実際に起きた不具合: セルの単元を入れた直後、その成功トーストがサーバの往復を終えて
// 遅れて出るころには、先生はもう次のコマのピッカーを開いて検索欄に打ち込んでいる。
// トーストが SweetAlert2 の Swal.mixin({toast:true}) だったため、globalState の
// currentInstance を奪って開いていたピッカーを _destroy() し、その .then() へ
// isDismissed を返していた。呼び出し側は `if (!result.isConfirmed) return;` で
// 黙って抜けるので、エラーも出ずに「入力がなかったこと」になっていた。
//
// 対策としてトーストを SweetAlert2 から切り離した。ここではその性質を固定する。

// ===================================================
// ===== 自前トーストのふるまい =====
// ===================================================

/** トーストの検査に必要なぶんだけの DOM。 */
function makeDom() {
  function makeEl(tag) {
    const el = {
      tagName: tag, children: [], parentNode: null, attributes: {},
      className: '', id: '', textContent: '', handlers: {},
      get isConnected() {
        let node = el;
        while (node.parentNode) node = node.parentNode;
        return node === document.body;
      },
      setAttribute(name, value) { el.attributes[name] = value; },
      appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
      removeChild(child) {
        const i = el.children.indexOf(child);
        if (i !== -1) { el.children.splice(i, 1); child.parentNode = null; }
        return child;
      },
      addEventListener(type, fn) { (el.handlers[type] = el.handlers[type] || []).push(fn); },
      dispatch(type) { (el.handlers[type] || []).forEach(fn => fn()); },
      classList: {
        add(...names) { names.forEach(n => { if (!el.className.split(' ').includes(n)) el.className = (el.className + ' ' + n).trim(); }); },
        remove(...names) { el.className = el.className.split(' ').filter(c => c && !names.includes(c)).join(' '); },
        contains(name) { return el.className.split(' ').includes(name); }
      }
    };
    return el;
  }
  const document = { body: makeEl('body'), createElement: makeEl };
  return document;
}

function bootToast() {
  const clock = makeClock();
  const document = makeDom();
  const swalFires = [];
  const sandbox = {
    console, JSON, Math, Array, Object, String, Number, Boolean, RegExp, Error,
    // 残り時間の計算（hover での一時停止）が Date.now() を見るので、時計に合わせる
    Date: { now: () => clock.now },
    document,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    Swal: { fire: (...args) => { swalFires.push(args); return Promise.resolve({}); }, mixin: () => { throw new Error('Swal.mixin を使ってはいけない'); } }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(scriptBody('App_Js_09_Utils.html'), context, { filename: 'App_Js_09_Utils.html' });

  const stack = () => document.body.children.find(c => c.id === 'toastStack');
  // 消える動きのあいだ（180ms）はまだ DOM に残るので、見えているものだけ数える
  const items = () => (stack() ? stack().children : []).filter(el => !el.classList.contains('toast-leave'));
  return {
    clock, document, swalFires, stack, items,
    show: (type, message) => vm.runInContext(`showToast(${JSON.stringify(type)}, ${JSON.stringify(message)})`, context),
    texts: () => items().map(el => el.children.find(c => c.classList.contains('toast-text')).textContent)
  };
}

test('トーストは SweetAlert2 を経由しない（開いているダイアログを壊さない）', () => {
  const t = bootToast();
  t.show('success', '保存しました');
  assert.equal(t.swalFires.length, 0,
    'Swal.fire を呼ぶと globalState の currentInstance を奪い、開いているピッカーが黙って閉じます');
  assert.equal(t.items().length, 1);
});

test('読み上げに割り込まない置き場所に出す', () => {
  const t = bootToast();
  t.show('info', 'こんにちは');
  assert.equal(t.stack().attributes['aria-live'], 'polite');
  // エラーだけは role="alert"、それ以外は status
  assert.equal(t.items()[0].attributes.role, 'status');
  t.show('error', 'まずいです');
  assert.equal(t.items()[1].attributes.role, 'alert');
});

test('本文は HTML として解釈しない（サーバのエラー文がそのまま来る）', () => {
  const t = bootToast();
  t.show('error', '通信エラー: <img src=x onerror=alert(1)>');
  const body = t.items()[0].children.find(c => c.className.includes('toast-text'));
  assert.equal(body.textContent, '通信エラー: <img src=x onerror=alert(1)>');
});

test('3件を超えたら古いものから消える（上書きではなく積む）', () => {
  const t = bootToast();
  ['1件目', '2件目', '3件目', '4件目'].forEach(m => t.show('info', m));
  assert.deepEqual(t.texts(), ['2件目', '3件目', '4件目']);
});

test('同じ知らせの連打は1件にまとまり、表示時間だけ延びる', () => {
  const t = bootToast();
  t.show('info', '読み込んでいます');
  t.clock.advance(3000);
  t.show('info', '読み込んでいます');
  assert.equal(t.items().length, 1, '同じ文言が積み上がっています');

  // 1回目から 3.5 秒経っても、2回目で延びているのでまだ消えない
  t.clock.advance(1000);
  assert.equal(t.items().length, 1);
  t.clock.advance(2600);
  assert.equal(t.items().length, 0);
});

test('放っておけば消え、クリックでも消える', () => {
  const t = bootToast();
  t.show('success', 'あとで消えます');
  t.clock.advance(3500);
  t.clock.advance(200);          // 消える動きのぶん
  assert.equal(t.items().length, 0);

  t.show('success', 'すぐ消します');
  t.items()[0].dispatch('click');
  t.clock.advance(200);
  assert.equal(t.items().length, 0);
});

test('マウスを乗せているあいだは消えない', () => {
  const t = bootToast();
  t.show('info', '読んでいる最中です');
  t.clock.advance(1000);
  t.items()[0].dispatch('mouseenter');
  t.clock.advance(10000);
  assert.equal(t.items().length, 1, 'hover 中に消えました');
  t.items()[0].dispatch('mouseleave');
  t.clock.advance(2600);
  assert.equal(t.items().length, 0);
});

// ===================================================
// ===== 自動保存の往復中に打った文字を捨てない =====
// ===================================================

const WEEK = makeDays({ month: 8, firstDay: 24 });

/** 編集モードに入り、「いまグリッドに入っている値」を手元で差し替えられるようにする。 */
function bootEditing(protectedOverrides) {
  const app = bootClient({ protectedOverrides });
  app.run(`
    STATE.mondayStr = '2026/08/24';
    STATE.weekData = { success: true, mondayDateStr: '2026/08/24',
      days: ${JSON.stringify(WEEK)}, revision: 'rev-1', weekNum: 20 };
    STATE.editMode = true;
    STATE.editBaseline = JSON.parse(JSON.stringify(STATE.weekData.days));
    // グリッドの入力欄は DOM にしか無いので、その代わりに __live を見せる
    __live = JSON.parse(JSON.stringify(STATE.weekData.days));
    __live[0].event = '打ちかけの文字';
    collectCurrentEditData = function () { return JSON.parse(JSON.stringify(__live)); };
    __done = false;
  `);
  return app;
}

const saveCalls = app => app.inflight.filter(c => /^saveWeeklyPlanData/.test(c.name));

/** 進行中の保存に「送った内容がそのまま入った」成功応答を返す。 */
function respondSave(app, index) {
  const call = saveCalls(app)[index];
  call.handlers.ok({ success: true, days: call.args[1], revision: 'rev-' + (index + 2), message: '保存しました' });
  app.clock.advance();
}

for (const protectedOverrides of [false, true]) {
  const label = protectedOverrides ? '保護版' : '通常版';

  test(`${label}: 自動保存の往復中に打った文字は、もう一度保存してから週を移る`, () => {
    const app = bootEditing(protectedOverrides);
    app.run('autoSaveAndThen(function () { __done = true; });');
    app.clock.advance();
    assert.equal(saveCalls(app).length, 1);

    // 応答を待つあいだに続きを打つ
    app.run("__live[0].event = '打ちかけの文字と、そのあとの続き';");
    respondSave(app, 0);

    assert.equal(saveCalls(app).length, 2, '往復中に打った文字が保存されずに捨てられます');
    assert.equal(app.run('__done'), false, '保存し切る前に次の処理へ進んでいます');
    assert.equal(saveCalls(app)[1].args[1][0].event, '打ちかけの文字と、そのあとの続き');

    respondSave(app, 1);
    assert.equal(app.run('__done'), true);
    assert.equal(saveCalls(app).length, 2, '再保存が繰り返されています');
    assert.equal(app.run('STATE.editMode'), false);
  });

  test(`${label}: 往復中に何も打っていなければ、保存は1回だけ`, () => {
    const app = bootEditing(protectedOverrides);
    app.run('autoSaveAndThen(function () { __done = true; });');
    app.clock.advance();
    respondSave(app, 0);

    assert.equal(saveCalls(app).length, 1);
    assert.equal(app.run('__done'), true);
  });
}

// ===================================================
// ===== 減らしたトーストが戻っていないこと =====
// ===================================================

const read = file => fs.readFileSync(file, 'utf8');

test('結果が画面に見えている成功通知は出さない', () => {
  const plan = read('App_Js_02_Plan.html');
  const core = read('App_Js_01_Core.html');
  const overrides = read('App_Js_15_DataProtection_Overrides.html');
  const multi = read('App_Js_14_MultiClass.html');

  // 単元を入れたことはセルを見れば分かる。しかもこれは往復のあとに遅れて出るため、
  // 次のコマの操作に割り込む（この不具合の発端）
  assert.doesNotMatch(plan, /を入力しました。'\)/);
  assert.doesNotMatch(plan, /コマをペーストしました|コマを入れ替えました|🗑 クリアしました/);
  assert.doesNotMatch(plan, /↩ 元に戻しました|↪ やり直しました/);
  assert.doesNotMatch(plan, /空き時間の設定を解除しました|この時間を空き時間に設定しました/);
  assert.doesNotMatch(core, /の週を表示しました/);
  // 保存中はボタン自身が「保存中...」に変わるので、トーストは重複
  assert.doesNotMatch(overrides, /showToast\('info', '自動保存中|showToast\('info', '保存中\.\.\./);
  assert.doesNotMatch(multi, /showToast\('info', '自動保存中|showToast\('info', '保存中\.\.\./);

  // 逆に、画面に何も変化が出ないものは残す
  assert.match(plan, /コマをコピーしました/);
  assert.match(plan, /元に戻せる操作がありません/);
  assert.match(overrides, /自動保存失敗/);
  // 中止したのが「保存」だけでなく「画面の切り替え」でもあることを言葉にする
  assert.match(overrides, /教科名の入力に誤りがあるため自動保存できず、画面の切り替えを中止しました/);
});

test('単元の学習活動は、往復中に書き足された内容を上書きしない', () => {
  const plan = read('App_Js_02_Plan.html');
  assert.match(plan, /contentEl\.value === contentBefore/);
});
