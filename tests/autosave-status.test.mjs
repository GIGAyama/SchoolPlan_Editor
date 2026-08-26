import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 週案の自動保存まわりの回帰防止。
//
// 1) 保存中であることが画面に出ているか
//    手動保存は「保存する」ボタンが「保存中...」に変わるので分かるが、自動保存
//    （週移動前・閲覧モードのセル操作）はボタンを通らない。GASの往復は数秒かかる
//    ため、そのあいだ何も起きていないように見えていた。
//
// 2) 中身の変わらない保存を送っていないか
//    空のコマを「クリア」する、元に戻す→やり直す、コマを動かして元へ戻す——
//    どれも保存すべき差が無いのに往復1回ぶん（＋保存ロック1回ぶん）使っていた。
//
// 実物のクライアントコードを読み込み、DOM とサーバ呼び出しだけ差し替えて確かめる。

const read = file => fs.readFileSync(file, 'utf8');

/** include ファイルの <script> ブロックを連結して取り出す。 */
function scriptBody(file) {
  const src = read(file);
  const blocks = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(blocks.length > 0, `${file}: <script> block not found`);
  return blocks.join('\n');
}

/** setTimeout を手で進められる時計に差し替える（GASの往復待ちを再現するため）。 */
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
    }
  };
}

function makeDays() {
  return Array.from({ length: 7 }, (_, d) => ({
    date: `2026/8/${17 + d}`,
    dayLabel: '月火水木金土日'[d],
    found: true,
    event: '', preclass: '', morning: '', recess1: '', recess2: '',
    afterschool: '', homework: '', items: '',
    periods: Array.from({ length: 6 }, (_, p) => ({
      subject: `教科${'月火水木金土日'[d]}${'一二三四五六'[p]}`,
      unit: `単元${d}${p}`, content: `内容${d}${p}`
    }))
  }));
}

const clone = v => JSON.parse(JSON.stringify(v));

/**
 * 実物のクライアントコードを読み込んだサンドボックスを用意する。
 * getElementById は同じ id に同じ要素を返す（保存の表示を読み取るため）。
 */
function bootClient(options) {
  const useProtected = !!(options && options.protectedOverrides);
  const clock = makeClock();
  const toasts = [];
  const server = { days: makeDays(), revision: 1 };
  const inflight = [];

  const noop = () => {};
  const elementStub = {
    classList: { add: noop, remove: noop, toggle: noop },
    setAttribute: noop, removeAttribute: noop, appendChild: noop, remove: noop,
    addEventListener: noop, focus: noop, blur: noop, contains: () => false,
    querySelectorAll: () => [], closest: () => null
  };

  /** 使い捨ての要素。style / textContent / className を持つ。 */
  function makeElement() {
    const node = Object.create(elementStub);
    node.style = {};
    node.dataset = {};
    node.value = '';
    node.innerHTML = '';
    node.textContent = '';
    node.className = '';
    const children = {};
    node.querySelector = selector => {
      if (!children[selector]) children[selector] = makeElement();
      return children[selector];
    };
    return node;
  }

  const byId = {};
  const element = id => (byId[id] || (byId[id] = makeElement()));

  const sandbox = {
    console,
    JSON, Math, Date, Promise, Array, Object, String, Number, Boolean, RegExp, Error, Set, Map,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    requestAnimationFrame: noop, addEventListener: noop, removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
    navigator: {},
    localStorage: { getItem: () => null, setItem: noop },
    Swal: { fire: () => Promise.resolve({}), close: noop, getHtmlContainer: () => makeElement() },
    document: {
      addEventListener: noop, body: makeElement(), activeElement: null,
      getElementById: element,
      querySelector: () => makeElement(),
      querySelectorAll: () => [],
      createElement: () => makeElement()
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
  if (useProtected) files.push('App_Js_15_DataProtection_Overrides.html');
  for (const file of files) vm.runInContext(scriptBody(file), context, { filename: file });
  if (useProtected) {
    vm.runInContext('p3InjectProtectionCard = function () {}; p3LoadProtectionStatus = function () {};', context);
    vm.runInContext('p3InstallProtectedOverrides();', context);
  }

  vm.runInContext(`
    showToast = function (type, msg) { __toasts.push([type, msg]); };
    renderWeekGrid = function () {};
    rerenderGridPreservingFocus = function () {};
    collectCurrentEditData = function () { return STATE.weekData ? STATE.weekData.days : null; };
    updateWeekHeader = function () {};
    renderWeeklyTaskPanel = function () {};
  `, context);
  sandbox.__toasts = toasts;

  const run = code => vm.runInContext(code, context);
  const STATE = run('STATE');
  STATE.mondayStr = '2026/8/17';
  STATE.editMode = false;
  STATE.weekData = {
    success: true, mondayDateStr: '2026/8/17', days: clone(server.days), revision: server.revision
  };

  /** 送信済みの保存要求を1件、サーバへ適用して応答を返す。 */
  function respondOne(index) {
    const call = inflight.splice(index === undefined ? 0 : index, 1)[0];
    assert.ok(call, 'no in-flight save to respond to');
    if (JSON.stringify(call.days) !== JSON.stringify(server.days)) {
      server.days = clone(call.days);
      server.revision += 1;
    }
    call.handlers.ok({ success: true, message: 'saved', revision: server.revision, days: clone(server.days) });
  }

  /** 保存要求を1件、失敗として返す。 */
  function failOne() {
    const call = inflight.shift();
    assert.ok(call, 'no in-flight save to fail');
    call.handlers.ok({ success: false, error: 'サーバ側の都合' });
  }

  /** 画面に出ている保存の表示。出ていなければ null。 */
  function saveStatus() {
    const el = element('saveStatus');
    if (el.style.display === 'none' || !el.style.display) return null;
    return { className: el.className, text: element('saveStatusText').textContent };
  }

  return { STATE, clock, server, inflight, toasts, respondOne, failOne, saveStatus, run };
}

for (const variant of [
  { label: 'V2保存', options: {} },
  { label: '保護版保存', options: { protectedOverrides: true } }
]) {

test(`閲覧モードの自動保存でも「保存中」が画面に出る（${variant.label}）`, () => {
  const c = bootClient(variant.options);
  assert.equal(c.saveStatus(), null, '何もしていないうちは出さない');

  // セル操作をした時点から出す。実際に送るまでのディレイ待ちも、
  // 利用者から見れば「操作したのにまだ保存されていない」時間である。
  c.run(`handleContextAction('clearDay', 0, 0)`);
  assert.equal(c.saveStatus().text, '保存中...', 'ディレイ待ちのあいだも保存中と出すこと');
  assert.match(c.saveStatus().className, /is-saving/);

  c.clock.advance(450);
  assert.equal(c.inflight.length, 1);
  assert.equal(c.saveStatus().text, '保存中...', '送信中も保存中と出したままにすること');

  c.respondOne();
  c.clock.advance(0);
  assert.equal(c.saveStatus().text, '保存しました');
  assert.match(c.saveStatus().className, /is-saved/);

  // 成功の表示は残し続けない
  c.clock.advance(3000);
  assert.equal(c.saveStatus(), null, '成功の表示は少ししたら消すこと');
});

test(`自動保存に失敗したら、その表示が消えずに残る（${variant.label}）`, () => {
  const c = bootClient(variant.options);
  c.run(`handleContextAction('clearDay', 0, 0)`);
  c.clock.advance(450);
  c.failOne();
  c.clock.advance(10000);
  assert.ok(c.saveStatus(), '失敗の表示は消さないこと（気づかないまま離れてしまう）');
  assert.match(c.saveStatus().className, /is-error/);
});

test(`手動保存でも同じ表示が出る（${variant.label}）`, () => {
  const c = bootClient(variant.options);
  c.STATE.editMode = true;
  c.STATE.weekData.days[0].event = '運動会';
  c.run('saveWeeklyPlan()');
  assert.equal(c.saveStatus().text, '保存中...');
  c.respondOne();
  c.clock.advance(0);
  assert.equal(c.saveStatus().text, '保存しました');
});

test(`中身が変わらない自動保存は送らない（${variant.label}）`, () => {
  const c = bootClient(variant.options);

  // まず1回保存して、サーバの持っている内容を控えさせる
  c.run(`handleContextAction('clearDay', 0, 0)`);
  c.clock.advance(450);
  c.respondOne();
  c.clock.advance();
  assert.equal(c.inflight.length, 0);

  // すでに空の月曜をもう一度クリアしても、送る差が無いので往復させない
  c.run(`handleContextAction('clearDay', 0, 0)`);
  c.clock.advance(450);
  assert.equal(c.inflight.length, 0, '同じ内容の保存で往復してはいけない');
  assert.equal(c.saveStatus().text, '保存しました', '保存済みであることは画面に出すこと');

  // 元に戻して、やり直す。差し引き変わっていないので送らない
  c.run('undo(); redo();');
  c.clock.advance(450);
  assert.equal(c.inflight.length, 0, '元に戻して やり直せば内容は同じ。往復してはいけない');

  // 本当に変わったときは、もちろん送る
  c.run(`handleContextAction('clearDay', 1, 0)`);
  c.clock.advance(450);
  assert.equal(c.inflight.length, 1, '内容が変わったら保存すること');
  c.respondOne();
  c.clock.advance();

  // 元に戻すとサーバの内容と食い違う。これも、もちろん送る
  c.run('undo()');
  c.clock.advance(450);
  assert.equal(c.inflight.length, 1, '元に戻した内容は保存すること');
});

test(`保存が失敗したあとは、同じ内容でも省略せずに送り直す（${variant.label}）`, () => {
  const c = bootClient(variant.options);

  c.run(`handleContextAction('clearDay', 0, 0)`);
  c.clock.advance(450);
  c.respondOne();
  c.clock.advance();

  // 控えを持っている状態で、次の保存が失敗する
  c.run(`handleContextAction('clearDay', 1, 0)`);
  c.clock.advance(450);
  c.failOne();
  c.clock.advance();

  // 失敗した内容は手元にしか無い。省略してはいけない。
  c.run(`handleContextAction('clearDay', 1, 0)`);
  c.clock.advance(450);
  assert.equal(c.inflight.length, 1, '保存できていない内容を「同じだから」と省いてはいけない');
});

}
