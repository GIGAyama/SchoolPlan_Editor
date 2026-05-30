/**
 * @fileoverview 固定時間割一括転記・長期休業排除処理など、データベースシート関連処理
 */

/** 
 * 指定週の月～金に固定時間割をデータベースに転記します（上書き）。
 */
function transferWeeklyTimetable(targetDate) {
  const ss = typeof getSs_ === 'function' ? getSs_() : SpreadsheetApp.getActiveSpreadsheet();
  const shData = ss.getSheetByName(SHEET_NAME_DATABASE);
  if (!shData) throw new Error("データベースシートが見つかりません");

  const timetableData = getTimetableData_();
  const firstDayOfWeek = getMondayOfWeek(targetDate);
  
  const dbCols = getDbColumns();
  
  const searchTime = firstDayOfWeek.getTime();
  const dbData = shData.getDataRange().getValues();
  let targetRowIndex = -1;
  for (let i = 1; i < dbData.length; i++) {
    if (dbData[i][dbCols.DATE - 1] instanceof Date && dbData[i][dbCols.DATE - 1].getTime() === searchTime) {
      targetRowIndex = i + 1; // 1-based row
      break;
    }
  }

  if (targetRowIndex === -1) {
    Logger.log(`転記週 月曜(${formatDate(firstDayOfWeek)}) DBに見つからず`);
    return;
  }

  const numRowsToProcess = 5;
  const startCol = dbCols.TIME; 
  const numCols = shData.getLastColumn() - startCol + 1;
  const targetRange = shData.getRange(targetRowIndex, startCol, numRowsToProcess, Math.max(1, numCols));
  const targetValues = targetRange.getValues();
  let dataUpdated = false;

  for (let i = 0; i < timetableData.length && i < numRowsToProcess; i++) {
    const dayTimetable = timetableData[i];
    const targetRow = targetValues[i];

    const time_idx = dbCols.TIME - startCol;          
    const morning_idx = dbCols.MORNING - startCol;    
    const p1_idx = dbCols.PERIOD1 - startCol;         
    const p2_idx = dbCols.PERIOD2 - startCol;         
    const p3_idx = dbCols.PERIOD3 - startCol;         
    const p4_idx = dbCols.PERIOD4 - startCol;         
    const p5_idx = dbCols.PERIOD5 - startCol;         
    const p6_idx = dbCols.PERIOD6 - startCol;         

    // Expand array if needed
    while(targetRow.length <= Math.max(time_idx, morning_idx, p1_idx, p2_idx, p3_idx, p4_idx, p5_idx, p6_idx)) {
        targetRow.push("");
    }

    if (targetRow[time_idx] !== dayTimetable[0]) { targetRow[time_idx] = dayTimetable[0]; dataUpdated = true; }
    if (targetRow[morning_idx] !== dayTimetable[1]) { targetRow[morning_idx] = dayTimetable[1]; dataUpdated = true; }
    if (targetRow[p1_idx] !== dayTimetable[2]) { targetRow[p1_idx] = dayTimetable[2]; dataUpdated = true; }
    if (targetRow[p2_idx] !== dayTimetable[3]) { targetRow[p2_idx] = dayTimetable[3]; dataUpdated = true; }
    if (targetRow[p3_idx] !== dayTimetable[4]) { targetRow[p3_idx] = dayTimetable[4]; dataUpdated = true; }
    if (targetRow[p4_idx] !== dayTimetable[5]) { targetRow[p4_idx] = dayTimetable[5]; dataUpdated = true; }
    if (targetRow[p5_idx] !== dayTimetable[6]) { targetRow[p5_idx] = dayTimetable[6]; dataUpdated = true; }
    if (targetRow[p6_idx] !== dayTimetable[7]) { targetRow[p6_idx] = dayTimetable[7]; dataUpdated = true; }
  }

  if (dataUpdated) {
    targetRange.setValues(targetValues);
    Logger.log(`${formatDate(firstDayOfWeek)} 週 固定時間割転記(上書き)完了`);
  } else {
    Logger.log(`${formatDate(firstDayOfWeek)} 週 更新不要`);
  }
}


/** 
 * 長期休業期間を除外して、年間の固定時間割をデータベースに一括転記します。 
 */
function processBulkTransferWithExclusion(dates) {
  try {
    const exclusionPeriodsInput = [
      { name: "夏休み", startStr: dates.summerStart, endStr: dates.summerEnd },
      { name: "冬休み", startStr: dates.winterStart, endStr: dates.winterEnd },
      { name: "春休み", startStr: dates.springStart, endStr: dates.springEnd }
    ];
    const validExclusionPeriods = exclusionPeriodsInput
      .filter(p => p.startStr && p.endStr)
      .map(p => {
        const start = new Date(p.startStr.replace(/-/g, '/'));
        const end = new Date(p.endStr.replace(/-/g, '/'));
        if (start) start.setHours(0,0,0,0);
        if (end) end.setHours(0,0,0,0);
        return { name: p.name, start: start, end: end };
      }).filter(p =>
        p.start instanceof Date && !isNaN(p.start.getTime()) &&
        p.end instanceof Date && !isNaN(p.end.getTime()) &&
        p.start.getTime() <= p.end.getTime()
      );

    validExclusionPeriods.forEach(p => Logger.log(`有効な除外期間: ${p.name} ${formatDate(p.start)} ～ ${formatDate(p.end)}`));

    const ss = typeof getSs_ === 'function' ? getSs_() : SpreadsheetApp.getActiveSpreadsheet();
    const shData = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!shData) throw new Error(`シート「${SHEET_NAME_DATABASE}」が見つかりません`);
    
    const dbCols = getDbColumns();
    const dateColumnValues = shData.getRange(1, dbCols.DATE, shData.getLastRow(), 1).getValues();
    let lastRowWithDate = 0;
    for (let i = dateColumnValues.length - 1; i >= 0; i--) {
      if (dateColumnValues[i][0] instanceof Date) {
        lastRowWithDate = i + 1;
        break;
      }
    }
    if (lastRowWithDate < 2) return "DBに有効な日付データがありません";
    
    const lastDbDate = new Date(shData.getRange(lastRowWithDate, dbCols.DATE).getValue());
    lastDbDate.setHours(0,0,0,0);

    const today = new Date();
    const dayOfWeek = today.getDay();
    const daysUntilNextMonday = (dayOfWeek === 0) ? 1 : (8 - dayOfWeek);
    let currentDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + daysUntilNextMonday);
    currentDate.setHours(0,0,0,0);

    let skippedDayCount = 0;

    const masterDbData = shData.getDataRange().getValues();
    const timetableData = getTimetableData_();

    let isDbModified = false;

    while (currentDate <= lastDbDate) {
      const currentDayOfWeek = currentDate.getDay();
      if (currentDayOfWeek >= 1 && currentDayOfWeek <= 5) {
        const isExcluded = validExclusionPeriods.some(p => isDateInRange(currentDate, p.start, p.end));
        if (!isExcluded && currentDayOfWeek === 1) {
          try {
             const firstDayOfWeek = getMondayOfWeek(currentDate);
             const searchTime = firstDayOfWeek.getTime();
             let targetRowIndex = -1;
             for (let i = 1; i < masterDbData.length; i++) {
               if (masterDbData[i][dbCols.DATE - 1] instanceof Date && masterDbData[i][dbCols.DATE - 1].getTime() === searchTime) {
                 targetRowIndex = i;
                 break;
               }
             }

             if (targetRowIndex !== -1) {
                const numRowsToProcess = 5;
                for (let i = 0; i < timetableData.length && i < numRowsToProcess; i++) {
                  if (targetRowIndex + i >= masterDbData.length) break;
                  
                  const dayTimetable = timetableData[i];
                  const dbr = masterDbData[targetRowIndex + i];

                  const fields = [
                    { idx: dbCols.TIME - 1, val: dayTimetable[0] },
                    { idx: dbCols.MORNING - 1, val: dayTimetable[1] },
                    { idx: dbCols.PERIOD1 - 1, val: dayTimetable[2] },
                    { idx: dbCols.PERIOD2 - 1, val: dayTimetable[3] },
                    { idx: dbCols.PERIOD3 - 1, val: dayTimetable[4] },
                    { idx: dbCols.PERIOD4 - 1, val: dayTimetable[5] },
                    { idx: dbCols.PERIOD5 - 1, val: dayTimetable[6] },
                    { idx: dbCols.PERIOD6 - 1, val: dayTimetable[7] },
                  ];

                  fields.forEach(f => {
                     while(dbr.length <= f.idx) dbr.push("");
                     if(dbr[f.idx] !== f.val) {
                         dbr[f.idx] = f.val;
                         isDbModified = true;
                     }
                  });
                }
             }
          } catch (e) {
            logError(`一括転記中のエラー (${formatDate(currentDate)})`, e);
          }
        } else if (isExcluded) {
          skippedDayCount++;
        }
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }

    if(isDbModified){
        shData.getRange(1, 1, masterDbData.length, masterDbData[0].length).setValues(masterDbData);
    }

    const skipMessage = skippedDayCount > 0 ? ` (${skippedDayCount}日分スキップ)` : "";
    return `一括転記が完了しました${skipMessage}`;
  } catch (e) {
    logError("processBulkTransferWithExclusion", e);
    throw new Error(`一括転記処理中にエラーが発生しました: ${e.message}`);
  }
}

/** 
 * 長期休業期間のデフォルト日付を取得します (HTML側から呼び出される)。
 */
function getDefaultExclusionDates() {
  try {
    const ss = typeof getSs_ === 'function' ? getSs_() : SpreadsheetApp.getActiveSpreadsheet();
    const databaseSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!databaseSheet) throw new Error("データベースシートが見つかりません");
    
    // 年度を現在の日付から算出（4月始まり）
    const now = new Date();
    const summerYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    
    const currentYear = new Date().getFullYear();
    const summerStart = new Date(summerYear, 6, 21);
    const summerEnd = new Date(summerYear, 7, 31);
    const winterStart = new Date(currentYear, 11, 26);
    const winterEnd = new Date(currentYear + 1, 0, 7);
    const springStart = new Date(currentYear + 1, 2, 26);
    
    let springEnd = new Date(springStart);
    
    const dbCols = getDbColumns();
    const dateColumnValues = databaseSheet.getRange(2, dbCols.DATE, Math.max(1, databaseSheet.getLastRow()-1), 1).getValues();
    let lastRowWithDate = 0;
    for (let i = dateColumnValues.length - 1; i >= 0; i--) {
      if (dateColumnValues[i][0] instanceof Date) {
        lastRowWithDate = i + 2;
        break;
      }
    }

    if (lastRowWithDate >= 2) {
      const lastDateValue = databaseSheet.getRange(lastRowWithDate, dbCols.DATE).getValue();
      if (lastDateValue instanceof Date) {
        springEnd = new Date(lastDateValue);
      }
    }

    const formatDateForInput = (date) => {
        if (!(date instanceof Date) || isNaN(date.getTime())) return "";
        return Utilities.formatDate(date, "JST", "yyyy-MM-dd");
    };

    return {
      summerStart: formatDateForInput(summerStart), summerEnd: formatDateForInput(summerEnd),
      winterStart: formatDateForInput(winterStart), winterEnd: formatDateForInput(winterEnd),
      springStart: formatDateForInput(springStart), springEnd: formatDateForInput(springEnd)
    };
  } catch (e) {
     logError("getDefaultExclusionDates", e);
     return { summerStart: '', summerEnd: '', winterStart: '', winterEnd: '', springStart: '', springEnd: '' };
  }
}


/** 
 * データベースシートのデータ範囲をクリアします（確認付き）。
 */
function clearDatabaseDataWithConfirmation() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);

  if (!dbSheet) {
    ui.alert(`エラー: シート「${SHEET_NAME_DATABASE}」が見つかりません。`);
    return;
  }

  const dbCols = getDbColumns();
  const confirmationMessage = `「${SHEET_NAME_DATABASE}」シートの入力内容（D2以降）を全てクリアします。\n元に戻せません。よろしいですか？`;
  const response = ui.alert('データクリア確認', confirmationMessage, ui.ButtonSet.YES_NO);

  if (response == ui.Button.YES) {
    try {
      const r = clearDatabaseData_core_();
      Browser.msgBox(r.message, Browser.Buttons.OK);
    } catch (e) {
      logError("clearDatabaseDataWithConfirmation", e);
      Browser.msgBox(`クリアエラー: ${e.message}`, Browser.Buttons.OK);
    }
  }
}

/**
 * データベースシートの入力内容（時程〜放課後の列、2行目以降）をクリアするコアロジック。
 * UI非依存。
 * @returns {{cleared: boolean, message: string}}
 */
function clearDatabaseData_core_() {
  const ss = typeof getSs_ === 'function' ? getSs_() : SpreadsheetApp.getActiveSpreadsheet();
  const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
  if (!dbSheet) throw new Error(`シート「${SHEET_NAME_DATABASE}」が見つかりません。`);

  const dbCols = getDbColumns();
  const lastRow = dbSheet.getLastRow();
  if (lastRow < 2) {
    return { cleared: false, message: `「${SHEET_NAME_DATABASE}」にクリア対象のデータがありません。` };
  }
  const rangeToClear = dbSheet.getRange(2, dbCols.TIME, lastRow - 1, dbCols.AFTERSCHOOL - dbCols.TIME + 1);
  rangeToClear.clearContent();
  logInfo(`データベースクリア完了: ${rangeToClear.getA1Notation()}`);
  return { cleared: true, message: 'データベースの入力内容をクリアしました。' };
}

/**
 * [Webアプリ API] データベースの入力内容をクリアします（確認はフロント側で実施・結果を返す）。
 * @returns {{success: boolean, message: string}}
 */
function clearDatabaseDataFromWeb() {
  try {
    const r = clearDatabaseData_core_();
    return { success: true, message: r.message };
  } catch (e) {
    logError("clearDatabaseDataFromWeb", e);
    return { success: false, message: `クリアエラー: ${e.message}` };
  }
}

// ===================================================
// ===== タスク管理（TODO自動抽出）DB API (Phase 6) =====
// ===================================================

/**
 * タスクシートを初期化し、存在しない場合は作成します。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss 
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function initTaskSheet_(ss) {
  let sheet = ss.getSheetByName(SHEET_NAME_TASK);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME_TASK);
    const headers = ['TaskID', 'TaskContent', 'Resource', 'DueDate', 'Source', 'Status'];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setBackground('#1a73e8').setFontColor('white').setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 120);
    sheet.setColumnWidth(2, 300);
    sheet.setColumnWidth(3, 200);
    sheet.setColumnWidth(4, 100);
    sheet.setColumnWidth(5, 150);
    sheet.setColumnWidth(6, 80);
    logInfo(`「${SHEET_NAME_TASK}」シートを新規作成しました。`);
  }
  return sheet;
}

/**
 * タスク一覧を取得します。
 * @returns {Object[]}
 */
function getTaskData() {
  try {
    const ss = typeof getSs_ === 'function' ? getSs_() : SpreadsheetApp.getActiveSpreadsheet();
    const sheet = initTaskSheet_(ss);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    const data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
    return data.map(row => ({
      id: row[0],
      content: row[1],
      resource: row[2],
      dueDate: row[3] instanceof Date ? Utilities.formatDate(row[3], "JST", "yyyy-MM-dd") : row[3],
      source: row[4],
      status: row[5]
    })).filter(t => t.id); // IDが空の行は除外
  } catch (e) {
    logError('getTaskData', e);
    return [];
  }
}

/**
 * 新しいタスク（複数可）をDBに一括保存します。
 * @param {Object[]} tasks 
 * @returns {boolean}
 */
function saveTasksBulk(tasks) {
  try {
    if (!tasks || !Array.isArray(tasks) || tasks.length === 0) return true;

    // バリデーション: 各タスクの内容を検証
    tasks.forEach((t, i) => {
      if (!t.content || String(t.content).trim() === '') {
        throw new Error(`タスク${i + 1}の内容が空です。`);
      }
      if (t.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(t.dueDate) && t.dueDate !== '') {
        throw new Error(`タスク${i + 1}の期限日の形式が不正です。（YYYY-MM-DD形式で入力してください）`);
      }
    });

    const ss = typeof getSs_ === 'function' ? getSs_() : SpreadsheetApp.getActiveSpreadsheet();
    const sheet = initTaskSheet_(ss);

    const newRows = tasks.map(t => [
      t.id || 'tsk_' + Utilities.getUuid().split('-')[0],
      String(t.content).substring(0, 5000),
      String(t.resource || '').substring(0, 2000),
      t.dueDate || '',
      String(t.source || '').substring(0, 500),
      t.status || '未着手'
    ]);
    
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, 6).setValues(newRows);
    return true;
  } catch (e) {
    logError('saveTasksBulk', e);
    return false;
  }
}

/**
 * 特定のタスクのフィールドを更新します。
 * @param {string} taskId
 * @param {Object} updates { content, resource, dueDate } 更新するフィールド
 * @returns {boolean}
 */
function updateTask(taskId, updates) {
  try {
    const ss = typeof getSs_ === 'function' ? getSs_() : SpreadsheetApp.getActiveSpreadsheet();
    const sheet = initTaskSheet_(ss);
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === taskId) {
        // パフォーマンス: 変更対象を1回のバッチ書き込みで更新
        const row = data[i];
        if (updates.content !== undefined) row[1] = updates.content;
        if (updates.resource !== undefined) row[2] = updates.resource;
        if (updates.dueDate !== undefined) row[3] = updates.dueDate;
        sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
        return true;
      }
    }
    return false;
  } catch (e) {
    logError('updateTask', e);
    return false;
  }
}

/**
 * 特定のタスクのステータスを更新します。
 * @param {string} taskId
 * @param {string} newStatus "未着手" または "完了"
 * @returns {boolean}
 */
function updateTaskStatus(taskId, newStatus) {
  try {
    const ss = typeof getSs_ === 'function' ? getSs_() : SpreadsheetApp.getActiveSpreadsheet();
    const sheet = initTaskSheet_(ss);
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === taskId) {
        sheet.getRange(i + 1, 6).setValue(newStatus);
        return true;
      }
    }
    return false;
  } catch (e) {
    logError('updateTaskStatus', e);
    return false;
  }
}

/**
 * 特定のタスクを削除します。
 * @param {string} taskId 
 * @returns {boolean}
 */
function deleteTask(taskId) {
  try {
    const ss = typeof getSs_ === 'function' ? getSs_() : SpreadsheetApp.getActiveSpreadsheet();
    const sheet = initTaskSheet_(ss);
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === taskId) {
        sheet.deleteRow(i + 1);
        return true;
      }
    }
    return false;
  } catch (e) {
    logError('deleteTask', e);
    return false;
  }
}
