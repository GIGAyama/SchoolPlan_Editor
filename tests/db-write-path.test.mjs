import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// データベースシートへの書き込み経路を実際に動かして確かめる。
//
// このアプリはスプレッドシートが唯一の保存先なので、書き込みの誤りは
// そのまま利用者のデータ喪失になる。特に次の3点は静的検査では守れない。
//   1) 数式列（曜日・週番号など）を値で塗り潰さないこと
//   2) 行は必ず日付で引き当てること（行の抜け・並び替えに耐えること）
//   3) 保存先の学級・対象週が食い違う要求を書き込まずに弾くこと

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

/** 呼び出しを記録する簡易スプレッドシートシート。 */
function makeSheet(name, grid) {
  const writes = [];
  const reads = [];
  const sheet = {
    grid,
    writes,
    reads,
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: () => grid.reduce((max, row) => Math.max(max, row.length), 0),
    // シートの大きさ（データのある範囲ではなく、シートそのものの行数・列数）。
    // 実際のシートはデータより広いのが普通なので、少し余らせて返す。
    // 読み過ぎたぶんが空で返っても壊れないことを、これで確かめられる。
    getMaxRows: () => grid.length + 5,
    getMaxColumns: () => grid.reduce((max, row) => Math.max(max, row.length), 0) + 2,
    // 旧実装（シート全体を読んで丸ごと書き戻す）でも動くようにしておく。
    // そうしないと回帰テストが「例外で落ちた」だけになり、何を守っているのか分からなくなる。
    getDataRange() { return sheet.getRange(1, 1, grid.length, sheet.getLastColumn()); },
    getRange(row, col, nRows, nCols) {
      const rows = nRows === undefined ? 1 : nRows;
      const cols = nCols === undefined ? 1 : nCols;
      return {
        getValues() {
          reads.push({ row, col, rows, cols });
          const out = [];
          for (let r = 0; r < rows; r++) {
            const line = [];
            for (let c = 0; c < cols; c++) {
              const cell = (grid[row - 1 + r] || [])[col - 1 + c];
              line.push(cell === undefined ? '' : cell);
            }
            out.push(line);
          }
          return out;
        },
        getDisplayValues() {
          return this.getValues().map(line => line.map(v => (v === null || v === undefined) ? '' : String(v)));
        },
        getValue() { return (grid[row - 1] || [])[col - 1]; },
        getA1Notation() { return `R${row}C${col}:R${row + rows - 1}C${col + cols - 1}`; },
        clearContent() {
          writes.push({ row, col, rows, cols });
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              if (grid[row - 1 + r]) grid[row - 1 + r][col - 1 + c] = '';
            }
          }
          return this;
        },
        setValue(value) { grid[row - 1][col - 1] = value; writes.push({ row, col, rows: 1, cols: 1 }); },
        setValues(values) {
          writes.push({ row, col, rows, cols });
          values.forEach((line, r) => line.forEach((value, c) => {
            while (grid[row - 1 + r].length < col - 1 + c) grid[row - 1 + r].push('');
            grid[row - 1 + r][col - 1 + c] = value;
          }));
        }
      };
    }
  };
  return sheet;
}

const HEADERS = ['第何週', '日付', '曜日', '時程', '行事', '朝学習',
  '1校時', '単元1', '学習内容1', '2校時', '単元2', '学習内容2',
  '3校時', '単元3', '学習内容3', '4校時', '単元4', '学習内容4',
  '5校時', '単元5', '学習内容5', '6校時', '単元6', '学習内容6',
  '中休み', '昼休み', '放課後', '宿題', '持ち物'];

const COL = {};
HEADERS.forEach((h, i) => { COL[h] = i + 1; });

/**
 * 実物の .gs を読み込んだコンテキストを作ります。
 * GAS のサービスは、テストで意味のある範囲だけを差し替えます。
 */
function loadBackend(sheetRows, options = {}) {
  const sheet = makeSheet(options.sheetName || 'データベース', sheetRows);
  const logs = [];
  const context = vm.createContext({
    console,
    Logger: { log: (m) => logs.push(String(m)) },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo', getEffectiveUser: () => ({ getEmail: () => 'x@example.com' }) },
    Utilities: {
      // 日付の整形は Asia/Tokyo 固定でよい（週の行照合のキーになるだけ）
      formatDate: (date, _tz, _fmt) => {
        const y = date.getFullYear();
        const m = date.getMonth() + 1;
        const d = date.getDate();
        return `${y}/${m < 10 ? '0' + m : m}/${d < 10 ? '0' + d : d}`;
      },
      computeDigest: (_alg, text) => Array.from(String(text)).map(ch => ch.charCodeAt(0) % 256),
      DigestAlgorithm: { MD5: 'MD5' },
      Charset: { UTF_8: 'UTF_8' },
      getUuid: () => 'uuid'
    },
    SpreadsheetApp: { flush: () => {}, getActiveSpreadsheet: () => ({ getSheetByName: () => sheet, getId: () => 'ss' }) },
    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, tryLock: () => true, releaseLock: () => {} })
    }
  });
  context.globalThis = context;

  for (const file of ['00_config.gs', '99_Utils.gs', '07_WebApp.gs', '12_Performance.gs',
    '02_Database.gs', '03_PdfProcessing.gs']) {
    vm.runInContext(read(file), context, { filename: file });
  }

  // 実データに触れる入口だけを、このテスト用に固定する
  vm.runInContext(`
    var __sheet = null, __timetable = [], __holidays = {}, __logs = [];
    function getSs_() { return { getSheetByName: function () { return __sheet; }, getId: function () { return 'ss'; } }; }
    function resolveDbSheet_() { return __sheet; }
    function getDbSheet_() { return __sheet; }
    function getClassList_() { return []; }
    function isMultiClassEnabled_() { return false; }
    function getTimetableData_() { return __timetable; }
    function getHolidayMap_() { return __holidays; }
    function writeToLog_(level, message) { __logs.push(level + ': ' + message); }
    function ensureDataProtectionReady_() {}
    function p3ShouldCreateAutoSnapshot_() { return false; }
    function p3WeekScope_(m) { return m; }
    function p3RecordAudit_() {}
    function invalidateUnitProgressCache_() {}
    function tGetProp_() { return ''; }
    var __today = new Date();
    // 「過去の日付は転記しない」判定を固定するため、現在日時だけ差し替える
    Date = (function (RealDate) {
      function FakeDate() {
        if (arguments.length === 0) return new RealDate(__today.getTime());
        return new RealDate(...arguments);
      }
      FakeDate.prototype = RealDate.prototype;
      FakeDate.now = function () { return __today.getTime(); };
      return FakeDate;
    })(Date);
  `, context);
  context.__sheet = sheet;
  if (options.timetable) context.__timetable = options.timetable;

  return { context, sheet, logs, run: (code) => vm.runInContext(code, context) };
}

/** 日付セルは Date で入る（実シートと同じ）。vm 側の realm で作る。 */
function dateCell(context, y, m, d) {
  return vm.runInContext(`new Date(${y}, ${m - 1}, ${d})`, context);
}

/** 月〜金の5日分の行を持つDBを作ります。 */
function makeWeekRows(context, opts = {}) {
  const rows = [HEADERS.slice()];
  const days = opts.days || [17, 18, 19, 20, 21];
  days.forEach((day, i) => {
    const row = new Array(HEADERS.length).fill('');
    row[COL['第何週'] - 1] = '=WEEKNUM()';   // 数式列（値で塗り潰されたら壊れる）
    row[COL['日付'] - 1] = dateCell(context, 2026, 8, day);
    row[COL['曜日'] - 1] = '=TEXT()';        // 数式列
    row[COL['行事'] - 1] = '既存行事' + i;
    rows.push(row);
  });
  return rows;
}

const TIMETABLE = [
  ['A時程', '朝読書', '国語', '算数', '理科', '社会', '体育', '音楽'],
  ['B時程', '朝計算', '算数', '国語', '生活', '図画工作', '体育', '道徳'],
  ['C時程', '朝読書', '理科', '社会', '国語', '算数', '外国語', '学級活動'],
  ['D時程', '朝計算', '社会', '理科', '算数', '国語', '体育', '総合'],
  ['E時程', '朝読書', '音楽', '体育', '国語', '算数', '家庭', '道徳']
];

test('固定時間割の転記は数式列を値で塗り潰さない', () => {
  const boot = loadBackend([], { timetable: TIMETABLE });
  const rows = makeWeekRows(boot.context);
  boot.sheet.grid.length = 0;
  rows.forEach(r => boot.sheet.grid.push(r));

  boot.run(`transferWeeklyTimetable(new Date(2026, 7, 17))`);

  // 各校時・時程・朝学習は転記される
  assert.equal(boot.sheet.grid[1][COL['時程'] - 1], 'A時程');
  assert.equal(boot.sheet.grid[1][COL['朝学習'] - 1], '朝読書');
  assert.equal(boot.sheet.grid[1][COL['1校時'] - 1], '国語');
  assert.equal(boot.sheet.grid[5][COL['6校時'] - 1], '道徳');
  // 数式列と、時間割が扱わない列はそのまま
  assert.equal(boot.sheet.grid[1][COL['第何週'] - 1], '=WEEKNUM()');
  assert.equal(boot.sheet.grid[1][COL['曜日'] - 1], '=TEXT()');
  assert.equal(boot.sheet.grid[1][COL['行事'] - 1], '既存行事0');

  // 書き込み範囲そのものが数式列を含まないこと（値が同じでも書けば数式は消える）
  const formulaCols = [COL['第何週'], COL['曜日'], COL['行事']];
  boot.sheet.writes.forEach(w => {
    for (const col of formulaCols) {
      assert.ok(col < w.col || col >= w.col + w.cols,
        `列 ${col} は書き込み範囲(${w.col}〜${w.col + w.cols - 1})に含めないこと`);
    }
  });
});

test('固定時間割の転記は行の並びではなく日付で書き込む', () => {
  const boot = loadBackend([], { timetable: TIMETABLE });
  const rows = [HEADERS.slice()];
  // 水曜(19日)の行が無く、さらに日付順にも並んでいないDB
  [21, 17, 20, 18].forEach(day => {
    const row = new Array(HEADERS.length).fill('');
    row[COL['日付'] - 1] = dateCell(boot.context, 2026, 8, day);
    rows.push(row);
  });
  boot.sheet.grid.length = 0;
  rows.forEach(r => boot.sheet.grid.push(r));

  const result = boot.run(`transferWeeklyTimetable(new Date(2026, 7, 17))`);

  // 行の位置ではなく日付に対応した時間割が入ること
  const byDate = {};
  boot.sheet.grid.slice(1).forEach(row => {
    byDate[row[COL['日付'] - 1].getDate()] = row[COL['時程'] - 1];
  });
  assert.deepEqual(byDate, { 17: 'A時程', 18: 'B時程', 20: 'D時程', 21: 'E時程' });
  assert.deepEqual([...result.missingDates], ['2026/08/19'], 'DBに無い日は報告すること');
});

test('週案の保存は対象週に含まれない日付を書き込まずに弾く', () => {
  const boot = loadBackend([]);
  const rows = makeWeekRows(boot.context);
  boot.sheet.grid.length = 0;
  rows.forEach(r => boot.sheet.grid.push(r));

  // 別の週の日付が混ざった保存要求（履歴の持ち越しなどで起こりうる）
  const result = boot.run(`saveWeeklyPlanWeek_('2026/08/17', [
    { date: '2026/08/17', found: true, event: 'これは今週', periods: [] },
    { date: '2026/09/17', found: true, event: 'これは別の週', periods: [] }
  ], null, {})`);

  assert.equal(result.success, false);
  assert.match(result.error, /2026\/09\/17/);
  assert.equal(boot.sheet.grid[1][COL['行事'] - 1], '既存行事0', '弾いた要求は一切書き込まないこと');
});

test('週案の保存は保存先の学級が切り替わっていたら書き込まずに弾く', () => {
  const boot = loadBackend([], { sheetName: '2組' });
  const rows = makeWeekRows(boot.context);
  boot.sheet.grid.length = 0;
  rows.forEach(r => boot.sheet.grid.push(r));

  const result = boot.run(`saveWeeklyPlanWeek_('2026/08/17', [
    { date: '2026/08/17', found: true, event: '1組の内容', periods: [] }
  ], null, { expectedSheetName: '1組' })`);

  assert.equal(result.success, false);
  assert.match(result.error, /2組/);
  assert.match(result.error, /1組/);
  assert.equal(boot.sheet.grid[1][COL['行事'] - 1], '既存行事0', '別の学級のシートへ書き込まないこと');
});

test('保存先の学級が一致していれば通常どおり保存する', () => {
  const boot = loadBackend([], { sheetName: '1組' });
  const rows = makeWeekRows(boot.context);
  boot.sheet.grid.length = 0;
  rows.forEach(r => boot.sheet.grid.push(r));

  const result = boot.run(`saveWeeklyPlanWeek_('2026/08/17', [
    { date: '2026/08/17', found: true, event: '運動会', periods: [] }
  ], null, { expectedSheetName: '1組' })`);

  assert.equal(result.success, true);
  assert.equal(boot.sheet.grid[1][COL['行事'] - 1], '運動会');
  // 数式列は保存でも触らない
  assert.equal(boot.sheet.grid[1][COL['第何週'] - 1], '=WEEKNUM()');
  assert.equal(boot.sheet.grid[1][COL['曜日'] - 1], '=TEXT()');
});

test('クライアントから呼べる保存APIは保護を無効化できない', () => {
  // saveWeeklyPlanDataV2 / saveWeeklyPlanDataProtected は google.script.run から直接
  // 呼べる。ここが options をそのまま受け取ると { protect:false } を渡すだけで
  // 保存前スナップショットを飛ばせてしまう。
  const perf = read('12_Performance.gs');
  const snapshots = read('13_DataProtection_Snapshots.gs');
  assert.match(perf, /function saveWeeklyPlanDataV2\(mondayDateStr, days, baseRevision, expectedSheetName\)/);
  assert.match(snapshots,
    /function saveWeeklyPlanDataProtected\(mondayDateStr, days, baseRevision, source, expectedSheetName\)/);
  // 保護を省略できるのは、クライアントから呼べない実装本体だけ
  assert.match(perf, /function saveWeeklyPlanWeek_\(mondayDateStr, days, baseRevision, options\)/);
  assert.doesNotMatch(perf, /function saveWeeklyPlanDataV2\([^)]*options\)/);
});

test('行事予定PDFの反映は行事・放課後の列だけを書く', () => {
  const boot = loadBackend([]);
  const rows = makeWeekRows(boot.context);
  boot.sheet.grid.length = 0;
  rows.forEach(r => boot.sheet.grid.push(r));
  boot.run(`__today = new Date(2026, 7, 1)`);

  const result = boot.run(`applyExtractedEventsFromWeb([
    { date: '2026-08-17', content: '始業式', type: 'event' },
    { date: '2026-08-17', content: '学年会', type: 'meeting' },
    { date: '2026-08-18', content: '避難訓練', type: 'event' },
    { date: '2026-09-30', content: 'DBに無い日', type: 'event' }
  ])`);

  assert.equal(result.success, true);
  assert.equal(result.updated, 3);
  assert.equal(result.notInDb, 1);
  assert.equal(boot.sheet.grid[1][COL['行事'] - 1], '既存行事0\n始業式');
  assert.equal(boot.sheet.grid[1][COL['放課後'] - 1], '学年会');
  assert.equal(boot.sheet.grid[2][COL['行事'] - 1], '既存行事1\n避難訓練');
  // 数式列は書き込み範囲にも入れない
  boot.sheet.writes.forEach(w => {
    for (const col of [COL['第何週'], COL['曜日'], COL['日付']]) {
      assert.ok(col < w.col || col >= w.col + w.cols,
        `列 ${col} は書き込み範囲(${w.col}〜${w.col + w.cols - 1})に含めないこと`);
    }
  });
});

test('同じセルへ複数件の予定を反映しても取りこぼさない', () => {
  const boot = loadBackend([]);
  const rows = makeWeekRows(boot.context);
  boot.sheet.grid.length = 0;
  rows.forEach(r => boot.sheet.grid.push(r));
  boot.run(`__today = new Date(2026, 7, 1)`);

  boot.run(`applyExtractedEventsFromWeb([
    { date: '2026-08-17', content: '朝会', type: 'event' },
    { date: '2026-08-17', content: '委員会', type: 'event' },
    { date: '2026-08-17', content: '朝会', type: 'event' }
  ])`);

  assert.equal(boot.sheet.grid[1][COL['行事'] - 1], '既存行事0\n朝会\n委員会',
    '同一セルへの追記がまとめて反映され、重複は弾かれること');
});

test('年間集計は必要な列だけを読み、結果は全列を読んだ場合と一致する', () => {
  const boot = loadBackend([]);
  // 1年分の行を作り、学習内容には長い文字列を入れておく（読まない列）
  const rows = [HEADERS.slice()];
  const monday = new Date(2026, 3, 6); // 2026/04/06 (月)
  for (let i = 0; i < 200; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const row = new Array(HEADERS.length).fill('');
    row[COL['日付'] - 1] = dateCell(boot.context, d.getFullYear(), d.getMonth() + 1, d.getDate());
    row[COL['1校時'] - 1] = '国語';
    row[COL['2校時'] - 1] = '算数1/2理科1/2';
    row[COL['学習内容1'] - 1] = 'x'.repeat(400);
    rows.push(row);
  }
  boot.sheet.grid.length = 0;
  rows.forEach(r => boot.sheet.grid.push(r));

  const cols = boot.run(`getDbColumns()`);
  const full = boot.sheet.getRange(1, 1, boot.sheet.grid.length, boot.sheet.getLastColumn()).getValues();
  boot.sheet.reads.length = 0;
  const targeted = boot.run(`p2ReadColumnsForAllRows_(__sheet, getDbColumns(),
    ['DATE', 'PERIOD1', 'PERIOD2', 'PERIOD3', 'PERIOD4', 'PERIOD5', 'PERIOD6', 'MORNING'])`);

  assert.equal(targeted.length, full.length, '行数はシート全体と同じであること');
  for (let i = 1; i < full.length; i++) {
    for (const key of ['DATE', 'PERIOD1', 'PERIOD2', 'PERIOD6', 'MORNING']) {
      const col = cols[key];
      assert.deepEqual(targeted[i][col - 1], full[i][col - 1], `${key} の値が一致すること`);
    }
  }
  // 末尾の重い列（宿題・持ち物・振り返り）までは読まない
  assert.equal(targeted[1][COL['宿題'] - 1], '');
  // 列ごとに読むと往復が増えて逆に遅くなる。読み込みは少数の連続範囲にまとめる
  assert.ok(boot.sheet.reads.length <= 3,
    `読み込みは少数の範囲にまとめること (実際: ${boot.sheet.reads.length}回)`);
  const readCells = boot.sheet.reads.reduce((sum, r) => sum + r.rows * r.cols, 0);
  const fullCells = (boot.sheet.grid.length - 1) * boot.sheet.getLastColumn();
  assert.ok(readCells < fullCells, `シート全体より少ないセル数で済むこと (${readCells} < ${fullCells})`);
});

test('必要な列だけの読み込みでも時数集計の結果は変わらない', () => {
  const boot = loadBackend([]);
  const rows = [HEADERS.slice()];
  [6, 7, 8, 9, 10].forEach(day => {
    const row = new Array(HEADERS.length).fill('');
    row[COL['日付'] - 1] = dateCell(boot.context, 2026, 4, day);
    row[COL['1校時'] - 1] = '国語';
    row[COL['2校時'] - 1] = '算数1/2理科1/2';
    row[COL['学習内容1'] - 1] = '読まなくてよい長い内容';
    rows.push(row);
  });
  boot.sheet.grid.length = 0;
  rows.forEach(r => boot.sheet.grid.push(r));

  boot.run(`
    function getStandardHours() {
      return { success: true, data: [
        { subject: '国語', hours: 175 }, { subject: '算数', hours: 175 }, { subject: '理科', hours: 105 }
      ] };
    }
    function getModuleCountableSubjects_() { return null; }
    function getModuleSubjectFromMorningCell_() { return ''; }
  `);
  const summary = boot.run(`getHoursSummary('2026/04/06')`);
  assert.equal(summary.success, true);
  const weekly = {};
  [...summary.data].forEach(row => { weekly[row.subject] = row.weekly; });
  // 月〜金の5日 × 1校時「国語」= 5、2校時は 算数1/2・理科1/2 が5日分
  assert.equal(weekly['国語'], 5);
  assert.equal(weekly['算数'], 2.5);
  assert.equal(weekly['理科'], 2.5);
});

test('DBクリアは入力列を残さず消し、日付・数式列は消さない', () => {
  const boot = loadBackend([]);
  const rows = makeWeekRows(boot.context);
  // 入力列に一通り値を入れておく
  for (let r = 1; r < rows.length; r++) {
    ['時程', '朝学習', '1校時', '単元1', '学習内容1', '6校時', '中休み', '昼休み',
      '放課後', '宿題', '持ち物'].forEach(name => { rows[r][COL[name] - 1] = name + 'の値'; });
  }
  boot.sheet.grid.length = 0;
  rows.forEach(r => boot.sheet.grid.push(r));

  const cleared = boot.run(`clearDatabaseInputsForSheet_(__sheet, getDbColumns())`);
  assert.equal(cleared.cleared, true);

  const row = boot.sheet.grid[1];
  // 放課後より右にある宿題・持ち物も消えること（以前は消え残っていた）
  ['時程', '朝学習', '1校時', '単元1', '学習内容1', '6校時', '中休み', '昼休み',
    '放課後', '宿題', '持ち物', '行事'].forEach(name => {
    assert.equal(row[COL[name] - 1], '', `${name} が消えていること`);
  });
  // 日付と数式列は残ること
  // vm 側の Date はホストの instanceof を通らないため、振る舞いで確かめる
  assert.equal(typeof row[COL['日付'] - 1].getDate, 'function', '日付は消さないこと');
  assert.equal(row[COL['第何週'] - 1], '=WEEKNUM()');
  assert.equal(row[COL['曜日'] - 1], '=TEXT()');
});
