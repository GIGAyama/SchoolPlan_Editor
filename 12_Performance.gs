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
 * 日付列だけを先に読み、対象日の行だけを取得します。
 * 年間DB全体を全列読み込む従来方式を避けます。
 */
function p2ReadRowsForDates_(sheet, cols, dateStrs) {
  const lastRow = sheet.getLastRow();
  const lastColumn = Math.max(1, sheet.getLastColumn());
  const wanted = new Set(dateStrs);
  const rowNumberByDate = new Map();

  if (lastRow >= 2) {
    const dateValues = sheet.getRange(2, cols.DATE, lastRow - 1, 1).getValues();
    dateValues.forEach((row, index) => {
      const value = row[0];
      if (!(value instanceof Date)) return;
      const dateStr = formatDate(value);
      if (wanted.has(dateStr) && !rowNumberByDate.has(dateStr)) {
        rowNumberByDate.set(dateStr, index + 2);
      }
    });
  }

  const rowNumbers = [...rowNumberByDate.values()].sort((a, b) => a - b);
  const rowByNumber = new Map();
  const rowByDate = new Map();

  for (const group of p2GroupConsecutiveNumbers_(rowNumbers)) {
    const startRow = group[0];
    const values = sheet.getRange(startRow, 1, group.length, lastColumn).getValues();
    values.forEach((row, offset) => rowByNumber.set(startRow + offset, row));
  }

  rowNumberByDate.forEach((rowNumber, dateStr) => {
    const row = rowByNumber.get(rowNumber);
    if (row) rowByDate.set(dateStr, row);
  });

  return { lastColumn, rowNumbers, rowNumberByDate, rowByNumber, rowByDate };
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
      elapsedMs: Date.now() - startedAt
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

    let dbCols;
    try {
      dbCols = ensureReflectionColumns_();
    } catch (colErr) {
      logError('getWeeklyPlanDataV2: 振り返り列の確認', colErr);
      dbCols = getDbColumns();
    }

    const weekDateStrs = p2WeekDateStrings_(mondayDateStr);
    const rows = p2ReadRowsForDates_(dbSheet, dbCols, weekDateStrs);
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
      performance: {
        api: 'v2',
        rowsRead: rows.rowNumbers.length,
        elapsedMs: Date.now() - startedAt
      }
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
  if (changedRowNumbers.length === 0) return;

  const writeColumns = (writeKeys || P2_WEEK_READ_KEYS_)
    .map(key => cols[key])
    .filter(Boolean);
  const columnGroups = p2GroupConsecutiveNumbers_(writeColumns);
  const rowGroups = p2GroupConsecutiveNumbers_(changedRowNumbers);

  for (const rowGroup of rowGroups) {
    for (const columnGroup of columnGroups) {
      const startRow = rowGroup[0];
      const startCol = columnGroup[0];
      const width = columnGroup.length;
      const values = rowGroup.map(rowNumber => {
        const row = rowState.rowByNumber.get(rowNumber);
        return row.slice(startCol - 1, startCol - 1 + width);
      });
      sheet.getRange(startRow, startCol, rowGroup.length, width).setValues(values);
    }
  }
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
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    lock.waitLock(10000);
    locked = true;
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
    const dbCols = getDbColumns();
    p2AssertWritableSchema_(dbCols, dbSheet.getName());

    const weekDateStrs = p2WeekDateStrings_(mondayDateStr);
    const rowState = p2ReadRowsForDates_(dbSheet, dbCols, weekDateStrs);
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

    p2WriteChangedWeekRows_(dbSheet, dbCols, rowState, uniqueChangedRows);

    // 新しいリビジョンは「書き込んだ値」ではなく「シートに実際に入った値」から算出する。
    // スプレッドシートは setValues の際に文字列を解釈し直す("1/3"→日付、"007"→7、
    // "TRUE"→真偽値 など)。メモリ上の行から算出すると、クライアントが持つリビジョンが
    // シートの実データと食い違ったままになり、そのタブでの以降の保存が毎回
    // 「保存の競合」になっていた(単独利用でも頻発する原因)。
    let afterState = rowState;
    if (uniqueChangedRows.length > 0) {
      SpreadsheetApp.flush();
      afterState = p2ReadRowsForDates_(dbSheet, dbCols, weekDateStrs);
      // 単元セルが変わると単元の進捗も変わるため、進捗インデックスのキャッシュを捨てる。
      invalidateUnitProgressCache_();
    }
    const savedDays = p2BuildWeekDays_(afterState, dbCols, weekDateStrs, holidayMap);
    const newRevision = computeWeekRevision_([...afterState.rowByDate.values()], dbCols, weekDateStrs);

    if (uniqueChangedRows.length > 0 && protect) {
      p3RecordAudit_(
        'WEEK_SAVE',
        'week',
        mondayDateStr,
        ((options && options.source) || 'web') + 'から週案を保存 (' + uniqueChangedRows.length + '日)',
        { revision: currentRevision, snapshotId: restorePointId, days: p3ComparableDays_(beforeDays) },
        { revision: newRevision, days: p3ComparableDays_(savedDays) },
        'save_' + Utilities.getUuid()
      );
    }
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
      performance: {
        api: 'v2',
        rowsRead: rowState.rowNumbers.length,
        rowsWritten: uniqueChangedRows.length,
        elapsedMs: Date.now() - startedAt
      }
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
