import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Webアプリのクライアントコードを、実物のまま Node 上で動かすための足場。
// DOM と google.script.run と setTimeout だけを差し替え、
// 週データの読み書き・履歴・保存のロジックはソースそのものを実行する。

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

/** include ファイルの <script> ブロックを連結して取り出す。 */
export function scriptBody(file) {
  const blocks = [...read(file).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(blocks.length > 0, `${file}: <script> block not found`);
  return blocks.join('\n');
}

/** setTimeout を手で進められる時計に差し替える(GASの往復待ちを再現するため)。 */
export function makeClock() {
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

export const clone = v => JSON.parse(JSON.stringify(v));

/** 週データを1つ作る。全曜日・全校時に内容が入った状態から始める。 */
export function makeDays(opts = {}) {
  const tag = opts.tag || '';
  const month = opts.month || 8;
  const firstDay = opts.firstDay || 17;
  return Array.from({ length: 7 }, (_, d) => ({
    date: `2026/${month < 10 ? '0' + month : month}/${firstDay + d}`,
    dayLabel: '月火水木金土日'[d],
    found: true,
    event: '', preclass: '', morning: '', recess1: '', recess2: '',
    afterschool: '', homework: '', items: '',
    // 教科名は「単一教科名」でなければ保存時の検証に弾かれるため数字を入れない
    periods: Array.from({ length: 6 }, (_, p) => ({
      subject: `${tag}教科${'月火水木金土日'[d]}${'一二三四五六'[p]}`,
      unit: `${tag}単元${d}${p}`, content: ''
    }))
  }));
}

/**
 * クライアントを起動したサンドボックスを返します。
 * @param {Object} [options] options.protectedOverrides=true で App_Js_15 の保護版を有効にする
 */
export function bootClient(options = {}) {
  const clock = makeClock();
  const toasts = [];
  const renders = [];
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
    navigator: {},
    localStorage: { getItem: () => null, setItem: noop },
    Swal: { fire: () => Promise.resolve({}), close: noop, getHtmlContainer: () => elementStub },
    document: {
      addEventListener: noop, body: elementStub, activeElement: null,
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
          const methods = ['saveWeeklyPlanDataV2', 'saveWeeklyPlanDataProtected',
            'getWeeklyPlanDataV2', 'switchActiveClassFromWeb'];
          methods.forEach(name => {
            api[name] = (...args) => { inflight.push({ name, args, handlers }); };
          });
          return api;
        })({})
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  const files = ['App_Js_01_Core.html', 'App_Js_02_Plan.html', 'App_Js_14_MultiClass.html'];
  // 本番では App_Js_15 の保護版が最終実装になる。
  if (options.protectedOverrides) files.push('App_Js_15_DataProtection_Overrides.html');
  for (const file of files) vm.runInContext(scriptBody(file), context, { filename: file });
  if (options.protectedOverrides) {
    vm.runInContext('p3InjectProtectionCard = function () {}; p3LoadProtectionStatus = function () {};', context);
    vm.runInContext('p3InstallProtectedOverrides();', context);
  }

  sandbox.__toasts = toasts;
  sandbox.__renders = renders;
  // DOM を触る部分だけ差し替える。保存・履歴・取り込みのロジックは実物のまま動かす。
  vm.runInContext(`
    showToast = function (type, msg) { __toasts.push([type, msg]); };
    renderWeekGrid = function (days) { __renders.push(JSON.parse(JSON.stringify(days))); };
    rerenderGridPreservingFocus = function () { renderWeekGrid(STATE.weekData.days); };
    collectCurrentEditData = function () { return STATE.weekData ? STATE.weekData.days : null; };
    updateWeekHeader = function () {};
    renderWeeklyTaskPanel = function () {};
    updateEditUI = function () { syncEditBaseline(); };
    loadHoursSummary = function () {};
    renderClassSwitcher = function () {};
    refreshReflectionBadge = function () {};
    loadAnnualHoursView = function () {};
    loadStandardHours = function () {};
    loadSystemSettings = function () {};
    goToToday = function () {};
  `, context);

  const run = code => vm.runInContext(code, context);
  const STATE = run('STATE');

  return { STATE, clock, inflight, toasts, renders, run, context };
}

/** 表示中の週を1つ設定します（サーバから読み込んだ直後の状態）。 */
export function setWeek(harness, mondayStr, days, revision) {
  harness.run(`p2ApplyWeekData(${JSON.stringify({
    success: true, mondayDateStr: mondayStr, days, revision: revision || 'r1', weekNum: 1
  })})`);
  harness.STATE.mondayStr = mondayStr;
}
