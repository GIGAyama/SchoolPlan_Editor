/**
 * @fileoverview Phase 2: 体感速度・通信効率・週案データ整合性の改善API
 *
 * 既存APIは後方互換のため残し、Webアプリの新しい起動経路からV2 APIを利用します。
 */

const P2_WEEK_READ_KEYS_ = [
  'EVENT', 'PRECLASS', 'MORNING',
  'PERIOD1', 'UNIT1', 'CONTENT1',
  'PERIOD2', 'UNIT2', 'CONTENT2', 'RECESS1',
  'PERIOD3', 'UNIT3', 'CONTENT3',
  'PERIOD4', 'UNIT4', 'CONTENT4', 'RECESS2',
  'PERIOD5', 'UNIT5', 'CONTENT5',
  'PERIOD6', 'UNIT6', 'CONTENT6',
  'AFTERSCHOOL', 'HOMEWORK', 'ITEMS'
];

const P2_REQUIRED_WRITE_KEYS_ = [
  'DATE', 'EVENT', 'MORNING',
  'PERIOD1', 'UNIT1', 'CONTENT1',
  'PERIOD2', 'UNIT2', 'CONTENT2',
  'PERIOD3', 'UNIT3', 'CONTENT3',
  'PERIOD4', 'UNIT4', 'CONTENT4',
  'PERIOD5', 'UNIT5', 'CONTENT5',
  'PERIOD6', 'UNIT6', 'CONTENT6',
  'AFTERSCHOOL', 'HOMEWORK', 'ITEMS'
];

function p2WeekDateStrings_(mondayDateStr) {
  const monday = parseDate_(mondayDateStr);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return formatDate(d);
  });
}

function p2GroupConsecutiveNumbers_(numbers) {
  const sorted = [...new Set((numbers || []).filter(n => Number.isFinite(n)))].sort((a, b) => a - b);
  const groups = [];
  for (const n of sorted) {
    const last = groups[groups.length - 1];
    if (!last || n !== last[last.length - 1] + 1) groups.push([n]);
    else last.push(n);
  }
  return groups;
}

/**
 * 列マップが指す最も右の列（1始まり）を返します。
 * 週案が読み書きするのはこの範囲までなので、行を読む幅にも使います。
 * @param {Object} cols 列マップ
 * @returns {number}
 */
function p2MappedWidth_(cols) {
  return Object.keys(cols || {})
    .reduce((max, key) => Math.max(max, Number(cols[key]) || 0), 1);
}

/**
 * 「日付 → 行番号」の対応を覚えておくためのキー（利用者ごと・シートごと）。
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @returns {string}
 */
function p2CalendarCacheKey_(sheet) {
  return 'p2Calendar::' + sheet.getParent().getId() + '::' + sheet.getName();
}

/**
 * 年間カレンダーの並びを覚えておきます。
 *
 * データベースの日付列は「2行目から1日ずつ連続」で作られます
 * （`initializeNewDatabase_` / `generateAnnualCalendar`）。であれば、
 * 先頭の日付と行番号さえ分かれば、任意の日付の行番号は引き算で出せます。
 * 覚えておけば、週を開くたびに日付列（370行）を読む必要がなくなります。
 *
 * ただし、シート全体が1本の並びになっているとは限りません。`generateAnnualCalendar` は
 * 既存の行数が370行を超えていると**超えた分をそのまま残す**ため、前年度の日付が下に
 * 居座ることがあります。手で行を足した場合も同じです。
 *
 * そこで「いちばん長く続いている範囲」だけを覚えます。シート全体がひと続きで
 * なければ諦める、という作りだと、たった1行の乱れで週の読み込みが常に
 * 日付列の全走査に戻ってしまいます。
 *
 * 覚えた範囲を使うときは、読んだ行の日付を必ず突き合わせます
 * （`p2ReadRowsByRememberedCalendar_`）。覚え違いがあっても、走査し直すだけです。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Array<{dateStr: string, rowNumber: number}>} scanned 走査で分かった対応（行番号昇順）
 */
function p2RememberCalendar_(sheet, scanned) {
  const run = p2LongestCalendarRun_(scanned);
  if (!run) return;
  try {
    tCachePut_(
      p2CalendarCacheKey_(sheet),
      JSON.stringify({ firstDate: run.firstDate, firstRow: run.firstRow, count: run.count }),
      P2_CALENDAR_CACHE_SECONDS_);
  } catch (e) { /* 覚えられなくても、走査すれば同じ結果になる */ }
}

/**
 * 「行番号も日付も1ずつ進む」がいちばん長く続く範囲を返します。
 * 2行に満たなければ null（引き算で行番号を出す意味がないため）。
 * @param {Array<{dateStr: string, rowNumber: number}>} scanned 行番号昇順
 * @returns {?{firstDate: string, firstRow: number, count: number}}
 */
function p2LongestCalendarRun_(scanned) {
  const list = scanned || [];
  if (list.length < 2) return null;

  const followsPrevious = (previous, current) => {
    if (!previous || current.rowNumber !== previous.rowNumber + 1) return false;
    const expected = new Date(parseDate_(previous.dateStr).getTime());
    expected.setDate(expected.getDate() + 1);
    return formatDate(expected) === current.dateStr;
  };

  let best = null;
  let startIndex = 0;
  for (let index = 1; index <= list.length; index++) {
    if (index < list.length && followsPrevious(list[index - 1], list[index])) continue;
    const length = index - startIndex;
    if (length >= 2 && (!best || length > best.count)) {
      best = {
        firstDate: list[startIndex].dateStr,
        firstRow: list[startIndex].rowNumber,
        count: length
      };
    }
    startIndex = index;
  }
  return best;
}

/** 覚えている並びから、日付に対応する行番号を出します。分からなければ null。 */
function p2GuessRowNumbers_(sheet, dateStrs) {
  let remembered = null;
  try {
    const raw = tCacheGet_(p2CalendarCacheKey_(sheet));
    remembered = raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
  if (!remembered || !remembered.firstDate || !remembered.firstRow) return null;

  const firstTime = parseDate_(remembered.firstDate).getTime();
  const guessed = new Map();
  for (const dateStr of dateStrs) {
    const offset = Math.round((parseDate_(dateStr).getTime() - firstTime) / 86400000);
    // **1日でも範囲の外に出たら、この週は覚えている並びで扱わない。**
    // 一部だけ返すと、残りの日は「DBに無い日」として扱われ、入力できたはずの日が
    // 保存されないまま「保存しました」になる。覚えている範囲の端の週で起きる。
    if (offset < 0 || offset >= remembered.count) return null;
    guessed.set(dateStr, remembered.firstRow + offset);
  }
  return guessed.size > 0 ? guessed : null;
}

/** 覚えている並びを捨てます（カレンダーを作り直したときなど）。 */
function p2ForgetCalendar_(sheet) {
  try {
    tCacheRemove_(p2CalendarCacheKey_(sheet));
  } catch (e) { /* 消せなくても、次の読み取りで食い違いに気づいて捨て直す */ }
}

/**
 * 覚えている並びで対象週の行を読み、日付が合っているか確かめます。
 *
 * **合っていなければ何も返しません。** 行が動いていた場合に、別の日の行を
 * その週の内容として読み書きしてしまうと取り返しがつかないためです。
 * 呼び出し側は従来どおり日付列を走査し直します。
 *
 * @returns {?Object} 確かめられた rowState。合わなければ null
 */
function p2ReadRowsByRememberedCalendar_(sheet, cols, dateStrs) {
  const guessed = p2GuessRowNumbers_(sheet, dateStrs);
  if (!guessed) return null;

  const lastColumn = p2MappedWidth_(cols);
  const rowNumbers = [...guessed.values()].sort((a, b) => a - b);
  const rowByNumber = new Map();
  for (const group of p2GroupConsecutiveNumbers_(rowNumbers)) {
    const values = sheet.getRange(group[0], 1, group.length, lastColumn)
      .getValues({ dateColumns: [cols.DATE] });
    values.forEach((row, offset) => rowByNumber.set(group[0] + offset, row));
  }

  const rowByDate = new Map();
  for (const [dateStr, rowNumber] of guessed) {
    const row = rowByNumber.get(rowNumber);
    const actual = row ? row[cols.DATE - 1] : null;
    // 覚えていた行に、期待した日付が入っているか
    if (!(actual instanceof Date) || formatDate(actual) !== dateStr) return null;
    rowByDate.set(dateStr, row);
  }

  return { lastColumn, rowNumbers, rowNumberByDate: guessed, rowByNumber, rowByDate };
}

/**
 * 対象週を読むのに要る範囲を、1回の通信でまとめて取っておきます。
 *
 * 見出し行と、対象週の行。行番号は覚えている並びから引けるので、
 * 読む前から分かります。GAS の待ち時間はほぼ往復の回数で決まるため、
 * 分かっているものは先にまとめて取ってしまうのが効きます。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string[]} dateStrs 対象週の日付
 */
function p2PrefetchWeek_(sheet, dateStrs) {
  const width = Math.max(1, sheet.getMaxColumns());
  const specs = [{ row: 1, column: 1, numRows: 1, numColumns: width }];
  const guessed = p2GuessRowNumbers_(sheet, dateStrs);
  if (guessed) {
    for (const group of p2GroupConsecutiveNumbers_([...guessed.values()])) {
      specs.push({ row: group[0], column: 1, numRows: group.length, numColumns: width });
    }
  }
  sheet.prefetchRanges(specs);
}

/**
 * 対象週の行を読みます。
 *
 * 覚えている並びが使えれば日付列（370行）を読まずに済みます。読んだ行の日付が
 * 食い違ったら、覚えていたものを捨てて従来どおり日付列を走査し直します。
 * **食い違ったまま進むことはありません**（別の日の行を読み書きしてしまうため）。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Object} cols 列マップ
 * @param {string[]} dateStrs 対象週の日付
 * @returns {Object} rowState
 */
function p2LoadWeekRows_(sheet, cols, dateStrs) {
  const remembered = p2ReadRowsByRememberedCalendar_(sheet, cols, dateStrs);
  if (remembered) return remembered;
  p2ForgetCalendar_(sheet);
  return p2ReadRowsForDates_(sheet, cols, dateStrs);
}

/**
 * 日付列だけを先に読み、対象日の行だけを取得します。
 * 年間DB全体を全列読み込む従来方式を避けます。
 */
function p2ReadRowsForDates_(sheet, cols, dateStrs) {
  // getLastRow() / getLastColumn() は「データのある最終行・列」なので、
  // 呼ぶとシート全体の読み込みが走る。年間1枚のシートで1週を出すのに
  // 全部を運ぶことになるため、ここでは使わない。
  const lastColumn = p2MappedWidth_(cols);
  const wanted = new Set(dateStrs);
  const rowNumberByDate = new Map();

  // 日付列を末尾まで読む。日付列であることは見出しから分かっているので、
  // 表示形式を調べに行かせない。
  const dateValues = sheet.getValuesToEnd(2, cols.DATE, 1, { dateColumns: [cols.DATE] });
  const allScanned = [];
  dateValues.forEach((row, index) => {
    const value = row[0];
    if (!(value instanceof Date)) return;
    const dateStr = formatDate(value);
    allScanned.push({ dateStr, rowNumber: index + 2 });
    if (wanted.has(dateStr) && !rowNumberByDate.has(dateStr)) {
      rowNumberByDate.set(dateStr, index + 2);
    }
  });

  const rowNumbers = [...rowNumberByDate.values()].sort((a, b) => a - b);
  const rowByNumber = new Map();
  const rowByDate = new Map();

  for (const group of p2GroupConsecutiveNumbers_(rowNumbers)) {
    const startRow = group[0];
    const values = sheet.getRange(startRow, 1, group.length, lastColumn)
      .getValues({ dateColumns: [cols.DATE] });
    values.forEach((row, offset) => rowByNumber.set(startRow + offset, row));
  }

  rowNumberByDate.forEach((rowNumber, dateStr) => {
    const row = rowByNumber.get(rowNumber);
    if (row) rowByDate.set(dateStr, row);
  });

  // 次からは日付列を読まずに済むよう、並びを覚えておく
  p2RememberCalendar_(sheet, allScanned);

  return { lastColumn, rowNumbers, rowNumberByDate, rowByNumber, rowByDate };
}

/**
 * 書き込んだあと、対象の行だけを読み直します。
 *
 * スプレッドシートは書き込んだ値を解釈し直す（"1/3" は日付に、"007" は 7 になる）ため、
 * 保存後のリビジョンは「送った値」ではなく「シートに実際に入った値」から求める必要が
 * あります。日付と行番号の対応はもう分かっているので、日付列は読み直しません。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 対象シート
 * @param {Object} cols 列マップ
 * @param {Object} rowState p2ReadRowsForDates_ の戻り値
 * @returns {Object} 読み直した rowState（同じ形）
 */
function p2RereadRows_(sheet, cols, rowState) {
  const lastColumn = p2MappedWidth_(cols);
  const rowByNumber = new Map();
  for (const group of p2GroupConsecutiveNumbers_(rowState.rowNumbers)) {
    const startRow = group[0];
    const values = sheet.getRange(startRow, 1, group.length, lastColumn)
      .getValues({ dateColumns: [cols.DATE] });
    values.forEach((row, offset) => rowByNumber.set(startRow + offset, row));
  }
  const rowByDate = new Map();
  rowState.rowNumberByDate.forEach((rowNumber, dateStr) => {
    const row = rowByNumber.get(rowNumber);
    if (row) rowByDate.set(dateStr, row);
  });
  return {
    lastColumn,
    rowNumbers: rowState.rowNumbers,
    rowNumberByDate: rowState.rowNumberByDate,
    rowByNumber,
    rowByDate
  };
}

/**
 * 読み込み済みの行状態から週7日分のdayオブジェクトを構築します。
 * getWeeklyPlanDataV2 と保存時のスナップショット用 beforeDays の双方で使用します。
 */
function p2BuildWeekDays_(rowState, dbCols, weekDateStrs, holidayMap) {
  const dayLabels = ['月', '火', '水', '木', '金', '土', '日'];
  const holidays = holidayMap || {};
  return weekDateStrs.map((dateStr, index) => {
    const row = rowState.rowByDate.get(dateStr);
    return {
      date: dateStr,
      dayLabel: dayLabels[index],
      holiday: holidays[dateStr] || '',
      event: String(p2Cell_(row, dbCols, 'EVENT') || ''),
      preclass: String(p2Cell_(row, dbCols, 'PRECLASS') || ''),
      morning: String(p2Cell_(row, dbCols, 'MORNING') || ''),
      periods: [1, 2, 3, 4, 5, 6].map(n => ({
        subject: String(p2Cell_(row, dbCols, 'PERIOD' + n) || ''),
        unit: String(p2Cell_(row, dbCols, 'UNIT' + n) || ''),
        content: String(p2Cell_(row, dbCols, 'CONTENT' + n) || '')
      })),
      recess1: String(p2Cell_(row, dbCols, 'RECESS1') || ''),
      recess2: String(p2Cell_(row, dbCols, 'RECESS2') || ''),
      afterschool: String(p2Cell_(row, dbCols, 'AFTERSCHOOL') || ''),
      homework: String(p2Cell_(row, dbCols, 'HOMEWORK') || ''),
      items: String(p2Cell_(row, dbCols, 'ITEMS') || ''),
      reflection: String(p2Cell_(row, dbCols, 'REFLECTION') || ''),
      reflectionStatus: String(p2Cell_(row, dbCols, 'REFLECTION_STATUS') || '').trim(),
      found: !!row
    };
  });
}

/**
 * 1列分の値を、行番号を指定して書き戻します。連続する行はまとめて1回で書きます。
 *
 * シート全体を読み込んで丸ごと setValues で書き戻すと、曜日・週番号などの数式列が
 * 計算結果の静的な値に置き換わり、以降まったく再計算されなくなる。
 * 読み込んだ値の書き戻しは必ずこの関数（または p2WriteChangedWeekRows_）を通すこと。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 対象シート
 * @param {number} column 1始まりの列番号
 * @param {Map<number, *>} valueByRowNumber 1始まりの行番号 → 書き込む値
 */
function p2WriteColumnValues_(sheet, column, valueByRowNumber) {
  if (!column || !valueByRowNumber || valueByRowNumber.size === 0) return;
  const rowNumbers = [...valueByRowNumber.keys()];
  for (const group of p2GroupConsecutiveNumbers_(rowNumbers)) {
    const values = group.map(rowNumber => [valueByRowNumber.get(rowNumber)]);
    sheet.getRange(group[0], column, group.length, 1).setValues(values);
  }
}

// 読み込む列をまとめる際に、間に挟んでよい不要列の数。
// 校時列は「校時・単元・学習内容」の3列おきに並ぶため、2列までまたげば
// 1〜6校時を1回の読み込みにまとめられる。
const P2_READ_SPAN_MAX_GAP_ = 2;

// 「日付 → 行番号」の対応を覚えておく時間（秒）。
// カレンダーはめったに変わらないが、覚えたまま行が動くと危ないので長すぎないようにする。
// 食い違いは読み取り時に必ず検出されるため、これは安全弁ではなく効き目の調整値。
const P2_CALENDAR_CACHE_SECONDS_ = 21600; // 6時間

/**
 * 連続した番号を、間に許容ギャップを挟んでまとめた範囲に分けます。
 * @param {number[]} numbers
 * @param {number} maxGap 間に挟んでよい番号の数
 * @returns {{start: number, length: number}[]}
 */
function p2MergeNumberSpans_(numbers, maxGap) {
  const sorted = [...new Set((numbers || []).filter(n => Number.isFinite(n)))].sort((a, b) => a - b);
  const spans = [];
  for (const n of sorted) {
    const last = spans[spans.length - 1];
    const lastEnd = last ? last.start + last.length - 1 : null;
    if (last && n - lastEnd <= maxGap + 1) last.length = n - last.start + 1;
    else spans.push({ start: n, length: 1 });
  }
  return spans;
}

/**
 * 全データ行を、指定した論理列だけ読み込みます。
 *
 * 年間集計のように「全行 × 一部の列」が必要な処理向け。シート全体を読むと
 * 学習内容など長い文字列の列まで転送するため、行が増えるほど待ち時間が延びる。
 *
 * 読み込み範囲は少数の連続範囲にまとめる。列ごとに読むと、転送量は減っても
 * 呼び出し回数ぶんの往復が増えて逆に遅くなるため。
 *
 * 戻り値はシート全体を読んだときと同じ形（0番目がヘッダー行、以降がデータ行、
 * 各行は物理列順）にそろえてあり、読み込まなかった列は空文字になる。
 * 呼び出し側の `row[cols.XXX - 1]` はそのまま使える。
 *
 * @param {string[]} keys 読み込む論理列キー
 * @returns {Array[]}
 */
function p2ReadColumnsForAllRows_(sheet, cols, keys) {
  const lastRow = sheet.getLastRow();
  const width = Math.max(1, sheet.getLastColumn());
  const dataRowCount = Math.max(0, lastRow - 1);
  const rows = Array.from({ length: dataRowCount + 1 }, () => new Array(width).fill(''));
  if (dataRowCount === 0) return rows;

  const columns = (keys || []).map(key => cols[key]).filter(Boolean);
  for (const span of p2MergeNumberSpans_(columns, P2_READ_SPAN_MAX_GAP_)) {
    const length = Math.min(span.length, width - span.start + 1);
    if (length <= 0) continue;
    const values = sheet.getRange(2, span.start, dataRowCount, length).getValues();
    values.forEach((line, rowOffset) => line.forEach((value, colOffset) => {
      rows[rowOffset + 1][span.start - 1 + colOffset] = value;
    }));
  }
  return rows;
}

// 単元・学習内容だけを書き換える処理（一括自動入力・単元のずらし）が使う列。
const P2_UNIT_CONTENT_KEYS_ = [
  'UNIT1', 'CONTENT1', 'UNIT2', 'CONTENT2', 'UNIT3', 'CONTENT3',
  'UNIT4', 'CONTENT4', 'UNIT5', 'CONTENT5', 'UNIT6', 'CONTENT6'
];

/**
 * シート全体を読んだ配列から、変更した行の指定列だけを書き戻します。
 *
 * シート全体を丸ごと書き戻すと、曜日・週番号などの数式列が計算結果の静的な値に
 * 置き換わり、さらに書き換えていない列まで「読んだ時点の値」で上書きしてしまう
 * （読み込み中に他から入った変更が消える）。
 *
 * @param {Array[]} dbData シート全体の値（0始まり・先頭がヘッダー行）
 * @param {number[]} changedRowNumbers 1始まりの行番号
 * @param {string[]} writeKeys 書き戻す論理列キー
 */
function p2WriteRowsFromSheetArray_(sheet, cols, dbData, changedRowNumbers, writeKeys) {
  const unique = [...new Set(changedRowNumbers)].sort((a, b) => a - b);
  if (unique.length === 0) return;
  const rowByNumber = new Map();
  unique.forEach(rowNumber => rowByNumber.set(rowNumber, dbData[rowNumber - 1]));
  p2WriteChangedWeekRows_(sheet, cols, { rowByNumber }, unique, writeKeys);
}

function p2Cell_(row, cols, key) {
  const col = cols[key];
  if (!row || !col) return '';
  const value = row[col - 1];
  return value === null || value === undefined ? '' : value;
}

function p2AssertWritableSchema_(cols, sheetName) {
  const missing = P2_REQUIRED_WRITE_KEYS_.filter(key => !cols[key]);
  if (missing.length > 0) {
    throw new Error(
      `シート「${sheetName}」の列構成を確認してください。週案保存に必要な列が見つかりません: ${missing.join(', ')}`
    );
  }
}

/**
 * 起動時の重要データを1回の通信で返します。
 * 初期表示に不要な時数・設定・タスク・振り返りは遅延取得します。
 */
function getAppBootstrapV2() {
  const startedAt = Date.now();
  try {
    const tenant = getTenantStatus();
    if (tenant && tenant.success && tenant.linked === false) {
      return { success: true, tenant, linked: false, elapsedMs: Date.now() - startedAt };
    }

    const mondayStr = getTodaysMondayStr();
    const weeklyPlan = getWeeklyPlanDataV2(mondayStr);
    const masterData = getUnitMasterForSuggest();
    const multiClass = getMultiClassSettings();

    return {
      success: true,
      linked: true,
      tenant,
      mondayStr,
      weeklyPlan,
      masterData,
      multiClass,
      elapsedMs: Date.now() - startedAt,
      // 内訳（Sheets API を何回叩き、合計何ミリ秒待ったか）。
      // elapsedMs との差が GAS 側の処理時間になる。
      performance: Object.assign({ api: 'bootstrap', elapsedMs: Date.now() - startedAt },
        sheetsFetchStats_())
    };
  } catch (e) {
    logError('getAppBootstrapV2', e);
    return { success: false, error: e.message, elapsedMs: Date.now() - startedAt };
  }
}

/**
 * 初期描画後に必要なデータを1回の通信で返します。
 */
function getDeferredBootstrapV2() {
  const startedAt = Date.now();
  const safeCall = function (name, fn) {
    try {
      return fn();
    } catch (e) {
      logError('getDeferredBootstrapV2:' + name, e);
      return { success: false, error: e.message };
    }
  };

  return {
    success: true,
    tasks: safeCall('tasks', () => getTasksFromWebApp()),
    reflection: safeCall('reflection', () => getTodayReflectionStatus()),
    setup: safeCall('setup', () => getSetupStatus()),
    elapsedMs: Date.now() - startedAt
  };
}

/**
 * 対象週7日分だけを読み込む週案取得API。
 */
function getWeeklyPlanDataV2(mondayDateStr) {
  const startedAt = Date.now();
  try {
    validateParams_({ mondayDateStr }, {
      mondayDateStr: { type: 'string', required: true, pattern: /^\d{4}\/\d{1,2}\/\d{1,2}$/ }
    });

    const ss = getSs_();
    const dbSheet = getDbSheet_(ss);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');

    // 見出しと対象週の行を1回でまとめて取る（以降の読み取りは通信なしで済む）
    p2PrefetchWeek_(dbSheet, p2WeekDateStrings_(mondayDateStr));

    let dbCols;
    try {
      dbCols = ensureReflectionColumns_();
    } catch (colErr) {
      logError('getWeeklyPlanDataV2: 振り返り列の確認', colErr);
      dbCols = getDbColumns();
    }

    const weekDateStrs = p2WeekDateStrings_(mondayDateStr);
    const rows = p2LoadWeekRows_(dbSheet, dbCols, weekDateStrs);
    const holidayMap = getHolidayMap_();
    const days = p2BuildWeekDays_(rows, dbCols, weekDateStrs, holidayMap);

    const mondayRow = rows.rowByDate.get(mondayDateStr);
    const weekNum = mondayRow && dbCols.WEEK_NUM ? (mondayRow[dbCols.WEEK_NUM - 1] || '?') : '?';
    const sundayRow = rows.rowByDate.get(weekDateStrs[6]);
    const weekSummary = sundayRow && dbCols.REFLECTION
      ? readWeekSummaryFromRow_(sundayRow, dbCols)
      : '';
    const revision = computeWeekRevision_([...rows.rowByDate.values()], dbCols, weekDateStrs);

    return {
      success: true,
      days,
      mondayDateStr,
      weekNum,
      revision,
      weekSummary,
      performance: Object.assign({
        api: 'v2',
        rowsRead: rows.rowNumbers.length,
        elapsedMs: Date.now() - startedAt
      }, sheetsFetchStats_())
    };
  } catch (e) {
    logError('getWeeklyPlanDataV2', e);
    return { success: false, error: e.message, performance: { api: 'v2', elapsedMs: Date.now() - startedAt } };
  }
}

function p2SetRowValue_(row, cols, key, value) {
  const col = cols[key];
  if (!col) return false;
  const normalized = value === null || value === undefined ? '' : value;
  if (row[col - 1] === normalized) return false;
  row[col - 1] = normalized;
  return true;
}

function p2ApplyDayToRow_(row, cols, day) {
  let changed = false;
  changed = p2SetRowValue_(row, cols, 'EVENT', day.event || '') || changed;
  if (cols.PRECLASS) changed = p2SetRowValue_(row, cols, 'PRECLASS', day.preclass || '') || changed;
  changed = p2SetRowValue_(row, cols, 'MORNING', day.morning || '') || changed;

  for (let n = 1; n <= 6; n++) {
    const period = (day.periods && day.periods[n - 1]) || {};
    changed = p2SetRowValue_(row, cols, 'PERIOD' + n, period.subject || '') || changed;
    changed = p2SetRowValue_(row, cols, 'UNIT' + n, period.unit || '') || changed;
    changed = p2SetRowValue_(row, cols, 'CONTENT' + n, period.content || '') || changed;
  }

  if (cols.RECESS1) changed = p2SetRowValue_(row, cols, 'RECESS1', day.recess1 || '') || changed;
  if (cols.RECESS2) changed = p2SetRowValue_(row, cols, 'RECESS2', day.recess2 || '') || changed;
  changed = p2SetRowValue_(row, cols, 'AFTERSCHOOL', day.afterschool || '') || changed;
  changed = p2SetRowValue_(row, cols, 'HOMEWORK', day.homework || '') || changed;
  changed = p2SetRowValue_(row, cols, 'ITEMS', day.items || '') || changed;
  return changed;
}

/**
 * 更新対象の列だけを書き戻します。
 * 列順が異なっていても、論理列マップを物理列へ変換して連続範囲ごとに保存します。
 * 曜日・週番号などの数式列は書き戻さない（値で塗り潰すと数式が失われる）。
 * @param {string[]} [writeKeys] 書き戻す論理列キー。省略時は週案の入力列すべて。
 */
function p2WriteChangedWeekRows_(sheet, cols, rowState, changedRowNumbers, writeKeys) {
  if (changedRowNumbers.length === 0) return true;

  const writeColumns = (writeKeys || P2_WEEK_READ_KEYS_)
    .map(key => cols[key])
    .filter(Boolean);
  const columnGroups = p2GroupConsecutiveNumbers_(writeColumns);
  const rowGroups = p2GroupConsecutiveNumbers_(changedRowNumbers);

  // 書き込みの応答が「シートに実際に入った値」を返してくれたか。
  // 1か所でも返らなければ、呼び出し側が読み直す（p2RereadRows_）。
  let readBackComplete = true;

  for (const rowGroup of rowGroups) {
    for (const columnGroup of columnGroups) {
      const startRow = rowGroup[0];
      const startCol = columnGroup[0];
      const width = columnGroup.length;
      const values = rowGroup.map(rowNumber => {
        const row = rowState.rowByNumber.get(rowNumber);
        return row.slice(startCol - 1, startCol - 1 + width);
      });
      const written = sheet.getRange(startRow, startCol, rowGroup.length, width)
        .setValuesReadingBack(values);
      if (!written) {
        readBackComplete = false;
        continue;
      }
      // 解釈し直された値を手元の行へ戻す（"007" → 7 のような読み替えに追随する）
      rowGroup.forEach((rowNumber, offset) => {
        const row = rowState.rowByNumber.get(rowNumber);
        if (!row) return;
        (written[offset] || []).forEach((value, index) => {
          row[startCol - 1 + index] = value;
        });
      });
    }
  }
  return readBackComplete;
}

/**
 * [Web API] 対象週7日分だけを書き込む週案保存API。
 *
 * 保存前スナップショットと監査ログは必ず作成される。省略できるのはサーバ内部の
 * 復元処理だけで、その経路はクライアントから呼べない saveWeeklyPlanWeek_ を使う。
 *
 * @param {string} [expectedSheetName] クライアントが書き込むつもりだった学級シート名。
 *   保存先はサーバ側の「アクティブな学級」で決まるため、学級を切り替えた直後に
 *   前の学級の保存が届くと別の学級のシートへ書かれてしまう。食い違いを弾く。
 */
function saveWeeklyPlanDataV2(mondayDateStr, days, baseRevision, expectedSheetName) {
  return saveWeeklyPlanWeek_(mondayDateStr, days, baseRevision, {
    source: 'web',
    expectedSheetName: expectedSheetName
  });
}

/**
 * 週案保存の実装本体。
 *
 * ロック順序の規約: ScriptLock(保存・クリア) → UserLock(migration)。逆順で取らないこと。
 *
 * @param {Object} [options] { protect:false } でスナップショット省略(サーバ内部の復元専用)、
 *   { source } で監査ログの操作元、{ expectedSheetName } で保存先学級の照合。
 *   末尾のアンダースコアによりクライアントからは呼び出せない。
 */
function saveWeeklyPlanWeek_(mondayDateStr, days, baseRevision, options) {
  const startedAt = Date.now();
  // どこで時間を使っているかを段階ごとに測る。
  // 実測では、保存にかかる時間の半分が Sheets API の外だった（GAS 側の処理）。
  // 往復の数だけ見ていても、その半分は説明できない。
  const phase = { lockMs: 0, readMs: 0, protectMs: 0, writeMs: 0, auditMs: 0 };
  const since = (mark) => Date.now() - mark;

  const lockAt = Date.now();
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    lock.waitLock(10000);
    locked = true;
    phase.lockMs = since(lockAt);
  } catch (lockErr) {
    return { success: false, error: '他の保存処理が進行中です。少し待ってから再度お試しください。' };
  }

  try {
    validateParams_({ mondayDateStr, days }, {
      mondayDateStr: { type: 'string', required: true, pattern: /^\d{4}\/\d{1,2}\/\d{1,2}$/ },
      days: { required: true, isArray: true }
    });

    const subjectErrors = validateDaysSubjects_(days);
    if (subjectErrors.length > 0) {
      return { success: false, error: '教科名の入力に誤りがあるため保存できません。\n' + subjectErrors.join('\n') };
    }

    const ss = getSs_();
    const dbSheet = getDbSheet_(ss);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');

    // 保存先の学級が、クライアントが書き込むつもりだった学級と同じか確かめる。
    // 学級を切り替えた直後に前の学級の保存が届くと、別の学級の週案を壊してしまう。
    const expectedSheetName = options && options.expectedSheetName;
    if (expectedSheetName && expectedSheetName !== dbSheet.getName()) {
      return {
        success: false,
        error: `保存先の学級が「${dbSheet.getName()}」に切り替わっているため、`
          + `「${expectedSheetName}」の変更を保存できませんでした。`
          + '元の学級へ戻してから、もう一度保存してください。'
      };
    }
    const readAt = Date.now();
    const weekDateStrs = p2WeekDateStrings_(mondayDateStr);
    // 見出しと対象週の行を1回でまとめて取る（以降の読み取りは通信なしで済む）
    p2PrefetchWeek_(dbSheet, weekDateStrs);

    const dbCols = getDbColumns();
    p2AssertWritableSchema_(dbCols, dbSheet.getName());

    const rowState = p2LoadWeekRows_(dbSheet, dbCols, weekDateStrs);
    phase.readMs = since(readAt);
    const currentRows = [...rowState.rowByDate.values()];
    const currentRevision = computeWeekRevision_(currentRows, dbCols, weekDateStrs);
    const holidayMap = getHolidayMap_();

    // p2ApplyDayToRow_ は rowState の行配列を直接書き換えるため、
    // スナップショット用の保存前状態はここで確定しておく。
    const beforeDays = p2BuildWeekDays_(rowState, dbCols, weekDateStrs, holidayMap);

    // 送られてきた日付が対象週のものか確かめる。画面側の状態がずれて別の週の内容が
    // 届いた場合、そのまま「保存しました」と返すと、実際には保存されていないのに
    // 保存できたように見えてしまう。
    const weekDateSet = new Set(weekDateStrs);
    const foreignDates = (days || [])
      .map(day => (day && day.date) ? String(day.date) : '')
      .filter(date => date && !weekDateSet.has(date));
    if (foreignDates.length > 0) {
      return {
        success: false,
        error: `${mondayDateStr} の週に含まれない日付が送られました（${foreignDates.join(', ')}）。`
          + '画面を再読み込みしてから、もう一度お試しください。'
      };
    }

    const changedRowNumbers = [];
    const notFoundDates = [];

    for (const day of days) {
      if (!day || !day.date) continue;
      if (!day.found && !(day.periods || []).some(p => p && p.subject)) continue;
      const rowNumber = rowState.rowNumberByDate.get(day.date);
      const row = rowNumber ? rowState.rowByNumber.get(rowNumber) : null;
      if (!row) {
        notFoundDates.push(day.date);
        continue;
      }
      if (p2ApplyDayToRow_(row, dbCols, day)) changedRowNumbers.push(rowNumber);
    }

    const uniqueChangedRows = [...new Set(changedRowNumbers)].sort((a, b) => a - b);

    // 楽観ロックの判定は「リビジョンの不一致」ではなく「他者の変更を上書きするか」で行う。
    // 送信内容がシートの現在値と完全に一致するなら書き込む差分が無く、誰の変更も失われない。
    // 同一内容の二重送信(手動保存と画面切替の自動保存が重なる等)を競合として弾かないことで、
    // 実際には競合していない保存が「保存の競合」ダイアログになるのを防ぐ。
    if (baseRevision && currentRevision !== baseRevision && uniqueChangedRows.length > 0) {
      return {
        success: false,
        conflict: true,
        error: 'この週の内容が、いま保存しようとしている編集を始めた時点から変わっています。'
          + '最新を読み込み直してから保存してください。',
        // クライアントが差分提示・上書き再送に使う現在値
        current: { mondayDateStr, revision: currentRevision, days: beforeDays }
      };
    }

    const protect = !(options && options.protect === false);
    let restorePointId = '';

    const protectAt = Date.now();
    if (uniqueChangedRows.length > 0 && protect) {
      try {
        ensureDataProtectionReady_();
        const scope = p3WeekScope_(mondayDateStr);
        if (p3ShouldCreateAutoSnapshot_(scope)) {
          restorePointId = p3CreateSnapshot_('week', scope, '自動: 週案保存前', {
            schemaVersion: P3_SCHEMA_VERSION_,
            spreadsheetId: ss.getId(),
            activeSheet: dbSheet.getName(),
            week: { success: true, days: beforeDays, mondayDateStr, revision: currentRevision }
          });
        }
      } catch (protectErr) {
        throw new Error('保存前の復元ポイントを作成できなかったため保存を中止しました（'
          + protectErr.message + '）。設定画面の「保全基盤を更新」を実行してから再度お試しください。');
      }
    }

    phase.protectMs = since(protectAt);

    const writeAt = Date.now();
    const readBackComplete = p2WriteChangedWeekRows_(dbSheet, dbCols, rowState, uniqueChangedRows);

    // 新しいリビジョンは「書き込んだ値」ではなく「シートに実際に入った値」から算出する。
    // スプレッドシートは setValues の際に文字列を解釈し直す("1/3"→日付、"007"→7、
    // "TRUE"→真偽値 など)。メモリ上の行から算出すると、クライアントが持つリビジョンが
    // シートの実データと食い違ったままになり、そのタブでの以降の保存が毎回
    // 「保存の競合」になっていた(単独利用でも頻発する原因)。
    let afterState = rowState;
    if (uniqueChangedRows.length > 0) {
      // 書き込みの応答が解釈後の値を返していれば、rowState はもう最新。
      // 返らなかったときだけ、対象行を読み直す。
      if (!readBackComplete) afterState = p2RereadRows_(dbSheet, dbCols, rowState);
      // 単元セルが変わると単元の進捗も変わるため、進捗インデックスのキャッシュを捨てる。
      invalidateUnitProgressCache_();
    }
    const savedDays = p2BuildWeekDays_(afterState, dbCols, weekDateStrs, holidayMap);
    const newRevision = computeWeekRevision_([...afterState.rowByDate.values()], dbCols, weekDateStrs);
    phase.writeMs = since(writeAt);

    const auditAt = Date.now();
    if (uniqueChangedRows.length > 0 && protect) {
      // 監査ログには「どの日を変えたか」までを残す。保存前の中身そのものは
      // 復元ポイント（snapshotId）に入っているので、ここへ二重に持たせない。
      const changedRowSet = new Set(uniqueChangedRows);
      const changedDates = weekDateStrs
        .filter(dateStr => changedRowSet.has(rowState.rowNumberByDate.get(dateStr)));
      p3RecordAudit_(
        'WEEK_SAVE',
        'week',
        mondayDateStr,
        ((options && options.source) || 'web') + 'から週案を保存 (' + uniqueChangedRows.length + '日)',
        { revision: currentRevision, snapshotId: restorePointId, changedDates: changedDates.join(' ') },
        { revision: newRevision },
        'save_' + Utilities.getUuid()
      );
    }
    phase.auditMs = since(auditAt);

    const msgBase = uniqueChangedRows.length > 0
      ? `${uniqueChangedRows.length}日分を保存しました`
      : '変更はありませんでした';
    const message = notFoundDates.length > 0
      ? `${msgBase}（DB未登録日: ${notFoundDates.join(', ')}）`
      : msgBase;

    return {
      success: true,
      message,
      updatedCount: uniqueChangedRows.length,
      revision: newRevision,
      // シートに実際に入った値。クライアントはこれで手元のデータを揃え、
      // シート側で正規化された値(例: "007"→7)を持ち続けないようにする。
      days: savedDays,
      restorePointId,
      // fetches / fetchMs は「Sheets API を何回叩き、合計何ミリ秒待ったか」。
      // elapsedMs との差が、GAS 側でかかっている時間になる。
      performance: Object.assign({
        api: 'v2',
        rowsRead: rowState.rowNumbers.length,
        rowsWritten: uniqueChangedRows.length,
        elapsedMs: Date.now() - startedAt
      }, sheetsFetchStats_(), phase)
    };
  } catch (e) {
    logError('saveWeeklyPlanWeek_', e);
    return { success: false, error: e.message, performance: { api: 'v2', elapsedMs: Date.now() - startedAt } };
  } finally {
    if (locked) lock.releaseLock();
  }
}

/**
 * 設定画面・保守用の列構成診断API。
 */
function getDbSchemaDiagnosticsFromWeb() {
  try {
    const ss = getSs_();
    const sheet = getDbSheet_(ss);
    if (!sheet) throw new Error('データベースシートが見つかりません');
    const headers = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getDisplayValues()[0];
    const columns = buildDbColumnMapFromHeaders_(headers, sheet.getName());
    const normalizedToColumns = {};
    headers.forEach((header, index) => {
      const normalized = normalizeDbHeader_(header);
      if (!normalized) return;
      if (!normalizedToColumns[normalized]) normalizedToColumns[normalized] = [];
      normalizedToColumns[normalized].push(index + 1);
    });
    const duplicates = Object.keys(normalizedToColumns)
      .filter(key => normalizedToColumns[key].length > 1)
      .map(key => ({ header: key, columns: normalizedToColumns[key] }));
    const missingWriteKeys = P2_REQUIRED_WRITE_KEYS_.filter(key => !columns[key]);

    return {
      success: true,
      sheetName: sheet.getName(),
      sheetId: sheet.getSheetId(),
      headers,
      columns,
      duplicates,
      missingWriteKeys,
      safeToWrite: missingWriteKeys.length === 0,
      mappingMode: 'live-header-scan'
    };
  } catch (e) {
    logError('getDbSchemaDiagnosticsFromWeb', e);
    return { success: false, error: e.message };
  }
}
