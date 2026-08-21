// 週案の読み書きが Sheets API を何往復するかを見張るテスト。
//
// GAS の遅さは、ほぼそのまま「UrlFetch を何回するか」で決まる。ところが往復の回数は
// コードを読んでも見えにくい。18_SheetsApi.gs のファサードは呼び出し側から見ると
// ただのメソッド呼び出しだが、その裏で通信が起きたり起きなかったりするためである。
//
// 実際に、次の2つがどちらも静かに入り込んでいた。
//   - 保存のたびに保全用シート4枚へ「見出しの確認と装飾」を投げ直していた（約28往復）
//   - 監査ログへの追記が getLastRow() 経由でシート全体を読んでいた
//     （保持期限が無いシートなので、使い込むほど重くなり、やがて UrlFetch の
//       応答上限 50MB に達して保存そのものが失敗する）
//
// そこで、本物の .gs をそのまま動かし、GAS のサービスだけ差し替えて往復を数える。
// 「何回までなら許す」を書いておけば、同じ壊れ方が二度目は気づかれずに入らない。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const GS_FILES = fs.readdirSync('.').filter(f => f.endsWith('.gs')).sort();
const SOURCES = GS_FILES.map(f => ({ name: f, code: fs.readFileSync(f, 'utf8') }));

const HEADERS = ['第何週', '日付', '曜日', '時程', '行事', '登校前', '朝学習',
  '1校時', '単元1', '学習内容1', '2校時', '単元2', '学習内容2', '中休み',
  '3校時', '単元3', '学習内容3', '4校時', '単元4', '学習内容4', '昼休み',
  '5校時', '単元5', '学習内容5', '6校時', '単元6', '学習内容6',
  '放課後', '宿題', '持ち物', '振り返り', '振り返り状態'];

const SHEETS_EPOCH = Date.UTC(1899, 11, 30);
const MONDAY = '2026/06/01';

/** 1年分の「データベース」シートを持つ疑似スプレッドシートを作る。 */
function createWorkbook() {
  const grid = [HEADERS.slice()];
  let day = Date.UTC(2026, 3, 6); // 2026/04/06 (月)
  for (let i = 0; i < 370; i++) {
    const row = new Array(HEADERS.length).fill('');
    row[0] = Math.floor(i / 7) + 1;
    row[1] = (day - SHEETS_EPOCH) / 86400000;
    row[2] = '日月火水木金土'[new Date(day).getUTCDay()];
    [7, 10, 14, 17, 21, 24].forEach((base, p) => {
      row[base] = '国語';
      row[base + 1] = '単元' + (p + 1);
      row[base + 2] = '学習内容のテキスト' + (p + 1);
    });
    grid.push(row);
    day += 86400000;
  }
  return { 'データベース': grid };
}

/**
 * Sheets REST API の代わりに応答し、往復を記録する。
 * @param {Object} sheets シート名 → 二次元配列
 * @param {Array} log 記録先
 */
function createTransport(sheets, log) {
  const display = g => g.map(r => r.map(v => (v === null || v === undefined ? '' : String(v))));
  const sheetNameIn = url => decodeURIComponent(url).match(/\/values\/'?([^'!?:]+)/)[1];

  return function fetch(url, options) {
    const opt = options || {};
    const method = (opt.method || 'get').toLowerCase();
    const text = decodeURIComponent(String(url));
    let body;
    let kind;

    if (text.includes(':append')) {
      kind = 'append';
      const name = sheetNameIn(url);
      const grid = sheets[name] || (sheets[name] = []);
      const values = JSON.parse(opt.payload || '{}').values || [];
      const start = grid.length + 1;
      values.forEach((row, i) => { grid[start - 1 + i] = row.slice(); });
      body = { updates: { updatedRange: `'${name}'!A${start}:J${start + values.length - 1}` } };
    } else if (text.includes('includeGridData=true')) {
      kind = 'numberFormat';
      const rowData = (sheets['データベース'] || []).slice(0, 200).map(row => ({
        values: row.map((_, i) => (i === 1 ? { effectiveFormat: { numberFormat: { type: 'DATE' } } } : {}))
      }));
      body = { sheets: [{ data: [{ rowData }] }] };
    } else if (text.includes('/values/')) {
      const name = sheetNameIn(url);
      const grid = sheets[name] || [];
      if (method === 'put' || method === 'post') {
        kind = 'write';
        // 書いた内容はシートに残す。残さないと、保全用シートの見出しや
        // スキーマ版がいつまでも空のままになり、実際には起きない処理まで走ってしまう。
        const cell = text.match(/!([A-Z]+)(\d+)/);
        const values = JSON.parse(opt.payload || '{}').values || [];
        if (cell && values.length) {
          let column = 0;
          for (const ch of cell[1]) column = column * 26 + (ch.charCodeAt(0) - 64);
          const firstRow = parseInt(cell[2], 10);
          const target = sheets[name] || (sheets[name] = []);
          values.forEach((row, r) => {
            const index = firstRow - 1 + r;
            while (target.length <= index) target.push([]);
            row.forEach((value, c) => {
              while (target[index].length < column - 1 + c) target[index].push('');
              target[index][column - 1 + c] = value;
            });
          });
        }
        body = { updatedCells: 1 };
      } else {
        kind = 'read:' + name;
        const formatted = text.includes('FORMATTED_VALUE') && !text.includes('UNFORMATTED_VALUE');
        body = { values: formatted ? display(grid) : grid };
      }
    } else if (text.includes(':batchUpdate')) {
      kind = 'batchUpdate';
      const requests = JSON.parse(opt.payload || '{}').requests || [];
      body = {
        replies: requests.map(request => {
          if (!request.addSheet) return {};
          const title = (request.addSheet.properties || {}).title || ('シート' + Object.keys(sheets).length);
          if (!sheets[title]) sheets[title] = [];
          const index = Object.keys(sheets).indexOf(title);
          return {
            addSheet: {
              properties: {
                sheetId: index, title, index, hidden: false,
                gridProperties: { rowCount: Math.max(1, sheets[title].length), columnCount: 40 }
              }
            }
          };
        })
      };
    } else {
      kind = 'meta';
      body = {
        spreadsheetId: 'ss-1',
        properties: { title: 'DB', timeZone: 'Asia/Tokyo' },
        sheets: Object.keys(sheets).map((title, index) => ({
          properties: {
            sheetId: index, title, index, hidden: false,
            gridProperties: { rowCount: Math.max(1, sheets[title].length), columnCount: HEADERS.length }
          }
        }))
      };
    }

    const payload = JSON.stringify(body);
    log.push({ kind, method, bytes: Buffer.byteLength(payload) });
    return { getResponseCode: () => 200, getContentText: () => payload };
  };
}

/**
 * GAS の1回の実行を模したサンドボックス。
 * 実行ごとにトップレベル変数が初期化される点まで合わせるため、毎回作り直す。
 */
function createRuntime(world) {
  const properties = store => ({
    getProperty: key => (store[key] === undefined ? null : store[key]),
    setProperty: (key, value) => { store[key] = String(value); },
    setProperties: obj => { Object.assign(store, obj); },
    deleteProperty: key => { delete store[key]; },
    getProperties: () => ({ ...store })
  });
  const cache = () => ({
    get: key => (world.cache[key] === undefined ? null : world.cache[key]),
    put: (key, value) => { world.cache[key] = value; },
    remove: key => { delete world.cache[key]; },
    removeAll: keys => keys.forEach(key => delete world.cache[key])
  });
  const noLock = { waitLock: () => {}, releaseLock: () => {}, tryLock: () => true };

  const context = {
    console, JSON, Math, Date, String, Number, Boolean, Array, Object, Map, Set, RegExp, Error,
    isNaN, parseInt, parseFloat,
    UrlFetchApp: { fetch: createTransport(world.sheets, world.log) },
    ScriptApp: { getOAuthToken: () => 'token', getProjectTriggers: () => [], deleteTrigger: () => {} },
    PropertiesService: {
      getUserProperties: () => properties(world.userProps),
      getScriptProperties: () => properties(world.scriptProps)
    },
    CacheService: { getScriptCache: cache, getUserCache: cache },
    LockService: { getScriptLock: () => noLock, getUserLock: () => noLock },
    Session: {
      getScriptTimeZone: () => 'Asia/Tokyo',
      getEffectiveUser: () => ({ getEmail: () => 'teacher@example.com' }),
      getActiveUser: () => ({ getEmail: () => 'teacher@example.com' })
    },
    Utilities: {
      getUuid: () => 'uuid-' + (world.uuid++),
      formatDate: (date, tz, pattern) => {
        const d = new Date(date);
        const pad = n => String(n).padStart(2, '0');
        return pattern === 'yyyy/MM/dd'
          ? `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
          : d.toISOString();
      },
      sleep: () => {},
      DigestAlgorithm: { MD5: 'MD5' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest: (algorithm, text) => {
        let hash = 0;
        const s = String(text);
        for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
        return Array.from({ length: 16 }, (_, i) => ((hash >> (i % 4 * 8)) & 0xff) - 128);
      }
    },
    HtmlService: { createHtmlOutput: () => ({}), XFrameOptionsMode: {} },
    MailApp: { sendEmail: () => {} },
    Logger: { log: () => {} }
  };
  context.globalThis = context;
  vm.createContext(context);
  for (const source of SOURCES) vm.runInContext(source.code, context, { filename: source.name });
  // ログシートへの追記はこのテストの対象外（別の往復になるので黙らせる）
  context.logInfo = () => {};
  context.logError = () => {};
  return context;
}

/** 疑似スプレッドシートと、実行をまたいで残るもの（プロパティ・キャッシュ）を用意する。 */
function createWorld() {
  return {
    sheets: createWorkbook(),
    log: [],
    cache: {},
    uuid: 0,
    userProps: {},
    scriptProps: {
      SPREADSHEET_ID: 'ss-1',
      holidayDates: '[]',
      holidayDatesUpdatedAt: new Date().toISOString()
    }
  };
}

/** 1回の実行として関数を動かし、その間の往復だけを返す。 */
function measure(world, run) {
  world.log.length = 0;
  const result = run(createRuntime(world));
  return { result, calls: world.log.slice() };
}

/** 週案の1コマを書き換えて保存する（読み込み→編集→保存で1回の操作）。 */
function saveOneCell(world, text) {
  return measure(world, app => {
    const week = app.getWeeklyPlanDataV2(MONDAY);
    assert.ok(week.success, '週案を読み込めていない: ' + week.error);
    const days = JSON.parse(JSON.stringify(week.days));
    days[1].periods[1].content = text;
    const saved = app.saveWeeklyPlanWeek_(MONDAY, days, week.revision, { source: 'web' });
    assert.ok(saved.success, '保存できていない: ' + saved.error);
    assert.equal(saved.updatedCount, 1, '1日分だけ保存されるはず');
    return saved;
  });
}

/** 監査ログに、実際に近い大きさの行をためる。 */
function fillAuditLog(world, rows) {
  const sheet = world.sheets['_週案_監査ログ'];
  assert.ok(sheet, '監査ログのシートがまだ無い');
  const filler = 'あ'.repeat(3000);
  while (sheet.length - 1 < rows) {
    sheet.push(['aud_' + sheet.length, new Date(), 'teacher@example.com', 'WEEK_SAVE',
      'week', MONDAY, 'webから週案を保存', filler, filler, 'save_x']);
  }
}

/** 保全用シートを作らせる（作成は最初の1回だけの費用なので、計測から外す）。 */
function warmUp(world) {
  saveOneCell(world, 'ウォームアップ');
}

test('週案の読み込みは、往復を使いすぎない', () => {
  const world = createWorld();
  const { calls } = measure(world, app => app.getWeeklyPlanDataV2(MONDAY));
  assert.ok(calls.length <= 6, `読み込みで ${calls.length} 往復している`);
});

test('週案の保存は、往復を使いすぎない', () => {
  const world = createWorld();
  warmUp(world);
  const { calls } = saveOneCell(world, '編集した学習内容');
  assert.ok(calls.length <= 14, `保存で ${calls.length} 往復している`);
});

test('保存のとき、監査ログのシートを読まない', () => {
  // 読むと、増え続けるシート全体を毎回取ることになる。
  const world = createWorld();
  warmUp(world);
  const { calls } = saveOneCell(world, '編集した学習内容');

  const auditReads = calls.filter(c => c.kind === 'read:_週案_監査ログ');
  assert.equal(auditReads.length, 0, '監査ログを読んでいる（values.append を使うこと）');

  const appends = calls.filter(c => c.kind === 'append');
  assert.equal(appends.length, 1, '監査ログへの追記が values.append になっていない');
});

test('監査ログがたまっても、保存の重さが変わらない', () => {
  // ここが本丸。以前は監査ログが増えるほど保存が重くなり、
  // やがて UrlFetch の応答上限（50MB）で保存そのものが失敗していた。
  const world = createWorld();
  warmUp(world);

  const light = saveOneCell(world, '監査ログが少ないときの編集');

  fillAuditLog(world, 400); // 1行あたり約6KB → 2MB以上
  const heavy = saveOneCell(world, '監査ログがたまったあとの編集');

  assert.equal(heavy.calls.length, light.calls.length,
    '監査ログの量で往復回数が変わっている');

  const bytesOf = run => run.calls.reduce((sum, c) => sum + c.bytes, 0);
  assert.ok(bytesOf(heavy) <= bytesOf(light) * 1.1,
    `監査ログの量で受信量が増えている（${Math.round(bytesOf(light) / 1024)}KB → ${Math.round(bytesOf(heavy) / 1024)}KB）`);
});

test('監査ログの1行は、週データを丸ごと抱え込まない', () => {
  const world = createWorld();
  warmUp(world);
  saveOneCell(world, '編集した学習内容');

  const rows = (world.sheets['_週案_監査ログ'] || []).filter(row => String(row[3]) === 'WEEK_SAVE');
  assert.ok(rows.length > 0, '週案保存の監査記録が無い');

  const latest = rows[rows.length - 1];
  const before = String(latest[7] || '');
  const after = String(latest[8] || '');
  assert.ok(before.length <= 600, `Before が大きすぎる（${before.length}文字）`);
  assert.ok(after.length <= 600, `After が大きすぎる（${after.length}文字）`);
  assert.match(before, /snapshotId/, '復元ポイントIDが残っていない');
  assert.doesNotMatch(before, /学習内容のテキスト/, '週データの中身が監査ログに入っている');
});
