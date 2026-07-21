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
    const dayLabels = ['月', '火', '水', '木', '金', '土', '日'];

    const days = weekDateStrs.map((dateStr, index) => {
      const row = rows.rowByDate.get(dateStr);
      return {
        date: dateStr,
        dayLabel: dayLabels[index],
        holiday: holidayMap[dateStr] || '',
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
 * 更新対象の週案列だけを書き戻します。
 * 列順が異なっていても、論理列マップを物理列へ変換して連続範囲ごとに保存します。
 */
function p2WriteChangedWeekRows_(sheet, cols, rowState, changedRowNumbers) {
  if (changedRowNumbers.length === 0) return;

  const writeColumns = P2_WEEK_READ_KEYS_
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
 * 対象週7日分だけを読み書きする週案保存API。
 */
function saveWeeklyPlanDataV2(mondayDateStr, days, baseRevision) {
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
    const dbCols = getDbColumns();
    p2AssertWritableSchema_(dbCols, dbSheet.getName());

    const weekDateStrs = p2WeekDateStrings_(mondayDateStr);
    const rowState = p2ReadRowsForDates_(dbSheet, dbCols, weekDateStrs);
    const currentRows = [...rowState.rowByDate.values()];

    if (baseRevision) {
      const currentRevision = computeWeekRevision_(currentRows, dbCols, weekDateStrs);
      if (currentRevision !== baseRevision) {
        return {
          success: false,
          conflict: true,
          error: 'この週は他の端末またはAI処理によって更新されています。最新を読み込み直してから保存してください。'
        };
      }
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
    p2WriteChangedWeekRows_(dbSheet, dbCols, rowState, uniqueChangedRows);

    const newRevision = computeWeekRevision_([...rowState.rowByDate.values()], dbCols, weekDateStrs);
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
      performance: {
        api: 'v2',
        rowsRead: rowState.rowNumbers.length,
        rowsWritten: uniqueChangedRows.length,
        elapsedMs: Date.now() - startedAt
      }
    };
  } catch (e) {
    logError('saveWeeklyPlanDataV2', e);
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
