import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Sheets API の「1分あたりの読み取り回数」に当たらないための検査。
//
// 実際に起きた不具合:
//   単元マスタを開こうとしたら
//     読込エラー: Google Sheets API (429): Quota exceeded for quota metric 'Read requests'
//   と出た。再読み込みしたら直った。
//
// 原因は2つ。
//   (1) シート構成（どんな名前のシートがあるか）を、画面の操作1つごとに必ず取りに行っていた。
//       google.script.run は呼び出しごとに実行が分かれるため、実行中だけのキャッシュは
//       次の呼び出しに残らない。週移動・時数集計・単元進捗・タスク件数……と
//       画面が裏で何度もサーバを呼ぶので、この1回が積み上がる。
//   (2) 429 のときの待ち時間が 1秒→2秒→4秒 と短く、分単位の枠が明ける前に
//       4回とも失敗していた。先生には英語の原文だけが出ていた。

const SOURCE = fs.readFileSync('18_SheetsApi.gs', 'utf8');
const UTILS = fs.readFileSync('99_Utils.gs', 'utf8');

/** 利用者ごとのキャッシュを模す。実行をまたいでも中身が残ることを再現する。 */
function makeCacheService() {
  const userStore = new Map();
  const scriptStore = new Map();
  const api = (store) => ({
    get: (k) => (store.has(k) ? store.get(k) : null),
    put: (k, v) => { store.set(k, v); },
    remove: (k) => { store.delete(k); }
  });
  return {
    service: { getUserCache: () => api(userStore), getScriptCache: () => api(scriptStore) },
    userStore, scriptStore
  };
}

/**
 * 18_SheetsApi.gs を偽の GAS 環境で読み込む。
 * cacheService を共有すれば「別の実行」を作れる（実行中のキャッシュだけが消える）。
 */
function loadFacade({ cacheService, sheets } = {}) {
  const requests = [];
  const sheetList = sheets || [
    { sheetId: 100, title: 'データベース', index: 0, hidden: false, gridProperties: { rowCount: 100, columnCount: 26 } },
    { sheetId: 101, title: '単元マスタ', index: 1, hidden: false, gridProperties: { rowCount: 100, columnCount: 26 } }
  ];

  const globals = {
    UrlFetchApp: {
      fetch: (url) => {
        requests.push(url);
        if (url.includes(':batchUpdate')) {
          return {
            getResponseCode: () => 200,
            getContentText: () => JSON.stringify({
              replies: [{ addSheet: { properties: { sheetId: 999, title: '3年2組', index: 9, gridProperties: {} } } }]
            }),
            getHeaders: () => ({})
          };
        }
        const body = url.includes('/values/')
          ? { values: [['見出し'], ['国語']] }
          : {
            spreadsheetId: 'ss-1',
            properties: { title: '週案DB', timeZone: 'Asia/Tokyo' },
            sheets: sheetList.map(p => ({ properties: p }))
          };
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify(body),
          getHeaders: () => ({})
        };
      }
    },
    ScriptApp: { getOAuthToken: () => 'token' },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: { formatDate: () => '+0900', sleep: () => {}, getUuid: () => 'uuid' },
    CacheService: (cacheService || makeCacheService()).service,
    logInfo: () => {}
  };
  const names = Object.keys(globals);
  const factory = new Function(...names, `
    ${UTILS.match(/function describeApiDisabledError_[\s\S]*?\n}/)[0]}
    ${SOURCE}
    return { sheetsOpenById_, sheetsResetCache_, sheetsRetryWaitMs_,
             sheetsReadCachedMeta_, sheetsWriteCachedMeta_, sheetsDropCachedMeta_,
             describeApiDisabledError_ };
  `);
  return { api: factory(...names.map(n => globals[n])), requests };
}

/** シート構成を取りに行った回数。 */
const metaCalls = (requests) =>
  requests.filter(u => !u.includes('/values/') && !u.includes(':batchUpdate')).length;

// ---------------------------------------------------------------- 回数を減らす

test('同じ実行の中では、シート構成を1回しか取りに行かない', () => {
  const { api, requests } = loadFacade();
  const ss = api.sheetsOpenById_('ss-1');
  ss.getSheetByName('データベース');
  ss.getSheetByName('単元マスタ');
  ss.getName();
  assert.equal(metaCalls(requests), 1);
});

test('次の実行では、持ち越したシート構成を使って取りに行かない', () => {
  // google.script.run は呼び出しごとに実行が分かれる。ここがこの不具合の要。
  const cache = makeCacheService();

  const first = loadFacade({ cacheService: cache });
  first.api.sheetsOpenById_('ss-1').getSheetByName('単元マスタ');
  assert.equal(metaCalls(first.requests), 1, '1回目は取りに行く');

  const second = loadFacade({ cacheService: cache });
  second.api.sheetsOpenById_('ss-1').getSheetByName('単元マスタ');
  assert.equal(metaCalls(second.requests), 0,
    '2回目も取りに行っています。画面の操作ごとに1回ずつ積み上がり、'
    + '1分あたりの読み取り上限（429）に当たります。');
});

test('持ち越しは利用者ごとのキャッシュに入れる（他の先生に見せない）', () => {
  // 1つのURLを多数の先生へ配る運用では、スクリプト全体のキャッシュに入れると
  // 他人のシート構成が見えてしまう。
  const cache = makeCacheService();
  loadFacade({ cacheService: cache }).api.sheetsOpenById_('ss-1').getName();

  assert.equal(cache.userStore.size, 1, '利用者ごとのキャッシュに入っていません');
  assert.equal(cache.scriptStore.size, 0, 'スクリプト全体のキャッシュに入れています');
});

// ---------------------------------------------------------------- 古くならないこと

test('シートを増やしたら、持ち越したシート構成は捨てられる', () => {
  const cache = makeCacheService();
  const first = loadFacade({ cacheService: cache });
  const ss = first.api.sheetsOpenById_('ss-1');
  ss.getSheetByName('データベース');
  assert.equal(cache.userStore.size, 1);

  ss.insertSheet('3年2組');
  assert.equal(cache.userStore.size, 0,
    'シート構成を変えたのに持ち越しが残っています。次の実行が古い構成を見ます。');
});

test('アプリの外でシートが増えても、「無い」と言い切らずに取り直す', () => {
  const cache = makeCacheService();
  // 1回目：単元マスタしか無い状態を持ち越す
  const first = loadFacade({
    cacheService: cache,
    sheets: [{ sheetId: 100, title: '単元マスタ', index: 0, hidden: false, gridProperties: {} }]
  });
  first.api.sheetsOpenById_('ss-1').getSheetByName('単元マスタ');

  // 2回目：スプレッドシートを直接開いて先生がシートを足した、という状況
  const second = loadFacade({
    cacheService: cache,
    sheets: [
      { sheetId: 100, title: '単元マスタ', index: 0, hidden: false, gridProperties: {} },
      { sheetId: 101, title: '3年2組', index: 1, hidden: false, gridProperties: {} }
    ]
  });
  const sheet = second.api.sheetsOpenById_('ss-1').getSheetByName('3年2組');

  assert.notEqual(sheet, null,
    '持ち越した古い構成のまま「シートが見つかりません」と答えています');
  assert.equal(metaCalls(second.requests), 1, '取り直しは1回だけであるべきです');
});

test('見つかるときは取り直さない（取り直しが常に走ると意味がない）', () => {
  const cache = makeCacheService();
  loadFacade({ cacheService: cache }).api.sheetsOpenById_('ss-1').getSheetByName('単元マスタ');

  const second = loadFacade({ cacheService: cache });
  second.api.sheetsOpenById_('ss-1').getSheetByName('単元マスタ');
  assert.equal(metaCalls(second.requests), 0);
});

// ---------------------------------------------------------------- 429 の扱い

test('429 のときは、分単位の枠が明けるまで待つ', () => {
  const { api } = loadFacade();
  const noHeaders = { getHeaders: () => ({}) };

  const waits = [0, 1, 2].map(attempt => api.sheetsRetryWaitMs_(429, noHeaders, attempt));
  assert.deepEqual(waits, [5000, 15000, 30000]);
  // 1秒・2秒・4秒では枠が明けないまま4回とも失敗していた
  assert.ok(waits[0] >= 5000, '429 の待ちが短すぎます');

  // 5xx は短い待ちのままでよい（サーバ側の一時的な不調）
  assert.equal(api.sheetsRetryWaitMs_(500, noHeaders, 0), 1000);
});

test('Retry-After があれば、それに従う', () => {
  const { api } = loadFacade();
  assert.equal(api.sheetsRetryWaitMs_(429, { getHeaders: () => ({ 'Retry-After': '10' }) }, 0), 10000);
  // 待ちすぎて実行時間の上限（6分）に当たらないよう頭打ちにする
  assert.equal(api.sheetsRetryWaitMs_(429, { getHeaders: () => ({ 'Retry-After': '600' }) }, 0), 30000);
});

test('429 は「待てば直る」と日本語で伝える', () => {
  const { api } = loadFacade();
  const message = api.describeApiDisabledError_('Google Sheets API', 429,
    "Quota exceeded for quota metric 'Read requests'");

  assert.match(message, /待って/, '何をすればよいかが書かれていません');
  assert.match(message, /データは失われていません/, '不安を残す文面です');
  assert.match(message, /Quota exceeded/, '原因を追うための原文が消えています');
});

test('キャッシュが使えない環境でも動く', () => {
  // CacheService が例外を投げても、取りに行けば動くこと
  const broken = { getUserCache: () => { throw new Error('使えません'); } };
  const requests = [];
  const globals = {
    UrlFetchApp: {
      fetch: (url) => {
        requests.push(url);
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            spreadsheetId: 'ss-1', properties: { title: 'x', timeZone: 'Asia/Tokyo' },
            sheets: [{ properties: { sheetId: 1, title: '単元マスタ', index: 0, gridProperties: {} } }]
          }),
          getHeaders: () => ({})
        };
      }
    },
    ScriptApp: { getOAuthToken: () => 't' },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: { formatDate: () => '+0900', sleep: () => {}, getUuid: () => 'u' },
    CacheService: broken,
    logInfo: () => {}
  };
  const names = Object.keys(globals);
  const factory = new Function(...names, `${SOURCE}\nreturn { sheetsOpenById_ };`);
  const api = factory(...names.map(n => globals[n]));

  assert.doesNotThrow(() => {
    const sheet = api.sheetsOpenById_('ss-1').getSheetByName('単元マスタ');
    assert.notEqual(sheet, null);
  });
});
