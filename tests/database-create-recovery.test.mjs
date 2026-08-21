import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bootClient } from './helpers/webapp-sandbox.mjs';

// データベース作成中に通信が切れたときの後始末の検査。
//
// 実際に起きた不具合:
//   初回起動でデータベースを作ろうとしたら
//     networkerror: 次の原因のため接続できませんでした: HTTP 0
//   と出た。再読み込みしたら作成できていた。
//
// 起きていること:
//   作成は、スプレッドシートを作って必要なシートと1年分のカレンダーを組み立てるので
//   時間がかかる。その間に画面との通信が切れても、**サーバ側の処理は最後まで走り切る**。
//   つまりデータベースはたいてい出来上がっている。それを「失敗しました」と見せて
//   作成画面へ戻すと、先生はもう一度「作成する」を押し、
//   **2つ目のスプレッドシートができて1つ目が迷子になる。**

const TENANT = fs.readFileSync(new URL('../11_Tenant.gs', import.meta.url), 'utf8');

/** Swal を記録用に差し替えた画面を用意する。 */
function boot({ settings = false } = {}) {
  const harness = bootClient(settings ? { extraFiles: ['App_Js_10_Settings.html'] } : {});
  harness.context.__swal = [];
  harness.context.__calls = [];
  // 入力ダイアログは「作成する」を押した状態にしておく。
  harness.run(`
    Swal = {
      fire: function (o) { __swal.push(o); return Promise.resolve({ isConfirmed: true, value: 'テストDB' }); },
      showLoading: function () {}, close: function () {}
    };
    startAppInit = function () { __calls.push('startAppInit'); };
    reopenOnboarding = function () { __calls.push('reopenOnboarding'); };
    reloadApp = function () { __calls.push('reloadApp'); };
  `);
  return harness;
}

/** Swal の .then() などのマイクロタスクを消化する。 */
const flush = () => new Promise(resolve => setImmediate(resolve));

/** 直近の google.script.run 呼び出しを取り出す。 */
const last = (harness) => harness.inflight[harness.inflight.length - 1];

/** 待ち時間を進めながら、getTenantStatus の問い合わせに答え続ける。 */
async function answerStatusPolls(harness, replies) {
  for (const reply of replies) {
    harness.clock.advance();
    const call = last(harness);
    assert.equal(call.name, 'getTenantStatus', '状態を聞き直していません');
    call.handlers.ok(reply);
    await flush();
  }
}

const LINKED = (id) => ({ success: true, linked: true, spreadsheetId: id, spreadsheetName: '週案DB' });
const UNLINKED = { success: true, linked: false, spreadsheetId: '', spreadsheetName: '' };

// -------------------------------------------------- 初回作成（オンボーディング）

test('初回作成では、すでにあれば作り直さないよう頼む', async () => {
  const h = boot();
  h.run('onboardingCreate()');
  await flush();

  const call = last(h);
  assert.equal(call.name, 'createMyDatabase');
  assert.equal(call.args[1] && call.args[1].onlyIfUnlinked, true,
    'サーバ側に「すでにあれば作らない」と伝えていません。'
    + '通信が切れたあと押し直すと2つ目ができます。');
});

test('通信が切れても、いきなり失敗と見せずに作成できたか確かめる', async () => {
  const h = boot();
  h.run('onboardingCreate()');
  await flush();
  last(h).handlers.fail(new Error('networkerror: 次の原因のため接続できませんでした: HTTP 0'));
  await flush();

  assert.deepEqual(h.context.__calls, [],
    '確かめずに作成画面へ戻しています。先生はもう一度押して2つ目を作ります。');

  h.clock.advance();
  assert.equal(last(h).name, 'getTenantStatus', '状態を聞き直していません');
});

test('実は出来ていたら、そのまま開始する（作り直させない）', async () => {
  const h = boot();
  h.run('onboardingCreate()');
  await flush();
  last(h).handlers.fail(new Error('HTTP 0'));
  await flush();

  await answerStatusPolls(h, [LINKED('ss-new')]);

  assert.deepEqual(h.context.__calls, ['startAppInit']);
  assert.equal(h.inflight.filter(c => c.name === 'createMyDatabase').length, 1,
    '2回目の作成を投げています');
  assert.match(JSON.stringify(h.context.__swal), /作成できていました/);
});

test('サーバがまだ組み立て中でも、少し待って聞き直す', async () => {
  const h = boot();
  h.run('onboardingCreate()');
  await flush();
  last(h).handlers.fail(new Error('HTTP 0'));
  await flush();

  // 1回目・2回目はまだ出来ていない。3回目で出来上がる。
  await answerStatusPolls(h, [UNLINKED, UNLINKED, LINKED('ss-new')]);

  assert.deepEqual(h.context.__calls, ['startAppInit'],
    '1回聞いただけであきらめています。組み立てには時間がかかります。');
});

test('本当に出来ていなければ、作成画面へ戻す', async () => {
  const h = boot();
  h.run('onboardingCreate()');
  await flush();
  last(h).handlers.fail(new Error('HTTP 0'));
  await flush();

  await answerStatusPolls(h, [UNLINKED, UNLINKED, UNLINKED]);

  assert.deepEqual(h.context.__calls, ['reopenOnboarding']);
  assert.match(JSON.stringify(h.context.__swal), /作成できませんでした/);
});

test('状態の問い合わせ自体が失敗しても、あきらめずに次を試す', async () => {
  const h = boot();
  h.run('onboardingCreate()');
  await flush();
  last(h).handlers.fail(new Error('HTTP 0'));
  await flush();

  h.clock.advance();
  last(h).handlers.fail(new Error('HTTP 0')); // 回線がまだ不安定
  await flush();

  await answerStatusPolls(h, [LINKED('ss-new')]);
  assert.deepEqual(h.context.__calls, ['startAppInit']);
});

// -------------------------------------------------- 設定画面からの「もう1つ作る」

test('設定画面では、押す前と紐付け先が変わったかで判断する', async () => {
  // 設定画面の作成は「意図して2つ目を作る」操作なので、押す前から紐付いている。
  // 「紐付いているか」だけを見ると、何も作られていなくても成功に見えてしまう。
  const h = boot({ settings: true });
  h.run('TENANT_CURRENT_SPREADSHEET_ID = "ss-old";');
  h.run('createMyDatabaseUI()');
  await flush();
  last(h).handlers.fail(new Error('HTTP 0'));
  await flush();

  await answerStatusPolls(h, [LINKED('ss-old'), LINKED('ss-old'), LINKED('ss-old')]);

  assert.deepEqual(h.context.__calls, [],
    '作られていないのに「出来ていました」として再読み込みしています。');
  assert.match(JSON.stringify(h.context.__swal), /作成できませんでした/);
});

test('設定画面でも、実は出来ていたら再読み込みで切り替える', async () => {
  const h = boot({ settings: true });
  h.run('TENANT_CURRENT_SPREADSHEET_ID = "ss-old";');
  h.run('createMyDatabaseUI()');
  await flush();
  last(h).handlers.fail(new Error('HTTP 0'));
  await flush();

  await answerStatusPolls(h, [LINKED('ss-new')]);

  assert.deepEqual(h.context.__calls, ['reloadApp']);
  assert.equal(h.inflight.filter(c => c.name === 'createMyDatabase').length, 1);
});

test('設定画面であきらめるときは、押し直す前に確かめてもらう', async () => {
  const h = boot({ settings: true });
  h.run('TENANT_CURRENT_SPREADSHEET_ID = "ss-old";');
  h.run('createMyDatabaseUI()');
  await flush();
  last(h).handlers.fail(new Error('HTTP 0'));
  await flush();
  await answerStatusPolls(h, [LINKED('ss-old'), LINKED('ss-old'), LINKED('ss-old')]);

  // ここで押し直すと、間に合っていた場合に3つ目ができる。
  assert.match(JSON.stringify(h.context.__swal), /使用中のデータベース/);
});

// -------------------------------------------------- サーバ側の歯止め

/** 11_Tenant.gs の createMyDatabase を偽の GAS 環境で動かす。 */
function loadCreateMyDatabase({ linkedId = '' } = {}) {
  const created = [];
  const userProps = new Map();
  if (linkedId) userProps.set('up_spreadsheetId', linkedId);

  const globals = {
    LockService: { getUserLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => null, getProperties: () => ({}) }),
      getUserProperties: () => ({
        getProperty: (k) => (userProps.has(k) ? userProps.get(k) : null),
        // 本物にもある。1回で全部返るので、実装はこちらを使って呼び出し回数を抑える。
        getProperties: () => Object.fromEntries(userProps),
        setProperty: (k, v) => { userProps.set(k, v); },
        deleteProperty: (k) => { userProps.delete(k); }
      })
    },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: { formatDate: () => '2026/08/20' },
    sheetsCreate_: (title) => {
      created.push(title);
      return { getId: () => 'ss-created-' + created.length, getName: () => title };
    },
    sheetsOpenById_: (id) => ({ getName: () => '既存の週案DB(' + id + ')' }),
    initializeNewDatabase_: () => {},
    driveCopyFile_: () => { throw new Error('テンプレートは使わない'); },
    logInfo: () => {},
    logError: () => {},
    UP_KEY_SPREADSHEET_ID: 'up_spreadsheetId',
    SP_KEY_DB_TEMPLATE_ID: 'sp_dbTemplateId'
  };
  const names = Object.keys(globals);
  const body = [
    // プロパティの読みは、実行の最初に一度だけ取って覚える仕組みを通る
    'let T_USER_PROPS_ = null;',
    'let T_SCRIPT_PROPS_ = null;',
    TENANT.match(/function tUserProps_[\s\S]*?\n}/)[0],
    TENANT.match(/function tScriptProps_[\s\S]*?\n}/)[0],
    TENANT.match(/function tGetUserProp_[\s\S]*?\n}/)[0],
    TENANT.match(/function tGetScriptProp_[\s\S]*?\n}/)[0],
    TENANT.match(/function getUserSpreadsheetId_[\s\S]*?\n}/)[0],
    TENANT.match(/function setUserSpreadsheetId_[\s\S]*?\n}/)[0],
    TENANT.match(/function createMyDatabase\(name, options\)[\s\S]*?\n}/)[0]
  ].join('\n');
  const factory = new Function(...names, `${body}\nreturn { createMyDatabase: createMyDatabase, created: ${JSON.stringify([])} };`);
  const api = factory(...names.map(n => globals[n]));
  return { createMyDatabase: api.createMyDatabase, created, userProps };
}

test('すでに紐付いていれば、初回作成の頼みでは作らない', () => {
  const { createMyDatabase, created } = loadCreateMyDatabase({ linkedId: 'ss-old' });
  const r = createMyDatabase('週案DB', { onlyIfUnlinked: true });

  assert.equal(r.success, true);
  assert.equal(r.spreadsheetId, 'ss-old');
  assert.equal(r.alreadyExisted, true, '画面に「作成できていました」と伝えられません');
  assert.deepEqual(created, [],
    '2つ目のスプレッドシートを作っています。1つ目が迷子になります。');
});

test('紐付いていなければ、これまでどおり作る', () => {
  const { createMyDatabase, created } = loadCreateMyDatabase();
  const r = createMyDatabase('週案DB', { onlyIfUnlinked: true });

  assert.equal(r.success, true);
  assert.equal(r.method, 'initialized');
  assert.deepEqual(created, ['週案DB']);
});

test('設定画面からの「もう1つ作る」は、紐付いていても作る', () => {
  // ここで止めてしまうと、年度が変わったときに新しいDBを作れなくなる。
  const { createMyDatabase, created, userProps } = loadCreateMyDatabase({ linkedId: 'ss-old' });
  const r = createMyDatabase('新年度の週案DB');

  assert.equal(r.success, true);
  assert.deepEqual(created, ['新年度の週案DB']);
  assert.equal(userProps.get('up_spreadsheetId'), r.spreadsheetId, '切り替わっていません');
});
