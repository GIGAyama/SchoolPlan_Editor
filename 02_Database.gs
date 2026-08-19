/**
 * @fileoverview 固定時間割一括転記・長期休業排除処理など、データベースシート関連処理
 */

// 固定時間割が書き込む列。曜日・週番号などの数式列には触れない。
// (以前は読み込んだシート全体を setValues で書き戻していたため、数式列が
//  計算結果の静的な値に置き換わって二度と再計算されなくなっていた)
const DB_TIMETABLE_WRITE_KEYS_ = [
  'TIME', 'MORNING', 'PERIOD1', 'PERIOD2', 'PERIOD3', 'PERIOD4', 'PERIOD5', 'PERIOD6'
];

/**
 * 指定した月曜日の週の「月〜金」について、転記する日付と値の組を作ります。
 * @param {Date} monday 週の月曜日
 * @param {Array[]} timetable getTimetableData_() の戻り値
 * @returns {{dateStr: string, date: Date, values: Array}[]}
 */
function dbTimetableEntriesForWeek_(monday, timetable) {
  const entries = [];
  const dayCount = Math.min(5, timetable.length);
  for (let i = 0; i < dayCount; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    d.setHours(0, 0, 0, 0);
    entries.push({ dateStr: formatDate(d), date: d, values: timetable[i] });
  }
  return entries;
}

/**
 * 固定時間割を、指定した日付へ転記します。
 *
 * 行は必ず日付で引き当てる。以前は「月曜の行から5行連続」という前提で書いていたため、
 * 行の抜け・並び替えがあると別の日付へ転記していた。
 * 書き込むのは時程・朝学習・各校時の列だけで、曜日・週番号などの数式列には触れない。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet データベースシート
 * @param {Object} cols 論理列マップ
 * @param {{dateStr: string, values: Array}[]} entries 転記する日付と値
 * @returns {{updatedRows: number, missingDates: string[]}}
 */
function dbApplyTimetableEntries_(sheet, cols, entries) {
  if (!entries || entries.length === 0) return { updatedRows: 0, missingDates: [] };

  const rowState = p2ReadRowsForDates_(sheet, cols, entries.map(e => e.dateStr));
  const changedRowNumbers = [];
  const missingDates = [];

  entries.forEach(entry => {
    const rowNumber = rowState.rowNumberByDate.get(entry.dateStr);
    const row = rowNumber ? rowState.rowByNumber.get(rowNumber) : null;
    if (!row) { missingDates.push(entry.dateStr); return; }

    let changed = false;
    DB_TIMETABLE_WRITE_KEYS_.forEach((key, index) => {
      if (!cols[key]) return;
      if (p2SetRowValue_(row, cols, key, entry.values[index] || '')) changed = true;
    });
    if (changed) changedRowNumbers.push(rowNumber);
  });

  const uniqueChangedRows = [...new Set(changedRowNumbers)].sort((a, b) => a - b);
  p2WriteChangedWeekRows_(sheet, cols, rowState, uniqueChangedRows, DB_TIMETABLE_WRITE_KEYS_);
  return { updatedRows: uniqueChangedRows.length, missingDates };
}

/**
 * 指定週の月～金に固定時間割をデータベースに転記します（上書き）。
 * 週案の保存と同じ ScriptLock で直列化する（転記中の保存が消えるのを防ぐ）。
 */
function transferWeeklyTimetable(targetDate) {
  const ss = getSs_();
  const shData = getDbSheet_(ss);
  if (!shData) throw new Error("データベースシートが見つかりません");

  const dbCols = getDbColumns();
  const firstDayOfWeek = getMondayOfWeek(targetDate);

  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    lock.waitLock(10000);
    locked = true;
  } catch (lockErr) {
    throw new Error('他の保存処理が進行中です。少し待ってから再度お試しください。');
  }

  try {
    const result = dbApplyTimetableEntries_(
      shData, dbCols, dbTimetableEntriesForWeek_(firstDayOfWeek, getTimetableData_()));
    if (result.missingDates.length > 0) {
      Logger.log(`転記週 ${formatDate(firstDayOfWeek)}: DBに無い日付 ${result.missingDates.join(', ')}`);
    }
    Logger.log(`${formatDate(firstDayOfWeek)} 週 固定時間割転記: ${result.updatedRows}行更新`);
    return result;
  } finally {
    if (locked) lock.releaseLock();
  }
}


/**
 * 長期休業期間を除外して、年間の固定時間割をデータベースに一括転記します。
 *
 * 対象は「次の月曜日以降でDBに日付がある週」の月〜金。
 * 書き込むのは時程・朝学習・各校時の列だけで、曜日・週番号などの数式列には触れない。
 * (以前はシート全体を読んで丸ごと setValues で書き戻していたため、数式列が
 *  静的な値に置き換わり、以降の行追加で再計算されなくなっていた)
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

    const ss = getSs_();
    const shData = getDbSheet_(ss);
    if (!shData) throw new Error(`シート「${SHEET_NAME_DATABASE}」が見つかりません`);

    const dbCols = getDbColumns();
    const lastRow = shData.getLastRow();
    if (lastRow < 2) return "DBに有効な日付データがありません";
    const dateColumnValues = shData.getRange(2, dbCols.DATE, lastRow - 1, 1).getValues();
    let lastDbDate = null;
    for (let i = dateColumnValues.length - 1; i >= 0; i--) {
      if (dateColumnValues[i][0] instanceof Date) {
        lastDbDate = new Date(dateColumnValues[i][0]);
        break;
      }
    }
    if (!lastDbDate) return "DBに有効な日付データがありません";
    lastDbDate.setHours(0,0,0,0);

    const today = new Date();
    const dayOfWeek = today.getDay();
    const daysUntilNextMonday = (dayOfWeek === 0) ? 1 : (8 - dayOfWeek);
    const firstMonday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + daysUntilNextMonday);
    firstMonday.setHours(0,0,0,0);

    // 転記する日を先に洗い出す。長期休業にかかる日は1日単位で除外する
    // （行単位で書き込むようになったため、週の途中から始まる休業も正しく除外できる）。
    const timetable = getTimetableData_();
    const entries = [];
    let skippedDayCount = 0;
    for (let monday = new Date(firstMonday); monday <= lastDbDate; monday.setDate(monday.getDate() + 7)) {
      dbTimetableEntriesForWeek_(monday, timetable).forEach(entry => {
        if (entry.date > lastDbDate) return;
        if (validExclusionPeriods.some(p => isDateInRange(entry.date, p.start, p.end))) {
          skippedDayCount++;
          return;
        }
        entries.push(entry);
      });
    }

    if (entries.length === 0) {
      return `一括転記の対象となる日がありませんでした (${skippedDayCount}日分スキップ)`;
    }

    // 週案の保存と同じ ScriptLock で直列化する（転記中の保存が消えるのを防ぐ）
    const lock = LockService.getScriptLock();
    let locked = false;
    try {
      lock.waitLock(30000);
      locked = true;
    } catch (lockErr) {
      throw new Error('他の保存処理が進行中です。少し待ってから再度お試しください。');
    }

    try {
      dbApplyTimetableEntries_(shData, dbCols, entries);
    } finally {
      if (locked) lock.releaseLock();
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
    const ss = getSs_();
    const databaseSheet = getDbSheet_(ss);
    if (!databaseSheet) throw new Error("データベースシートが見つかりません");
    
    // 年度を現在の日付から算出（4月始まり）。冬休み・春休みも年度基準で算出する
    //（1〜3月にアクセスした場合、暦年基準だと1年未来の日付になってしまうため）
    const now = new Date();
    const fiscalYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;

    const summerStart = new Date(fiscalYear, 6, 21);
    const summerEnd = new Date(fiscalYear, 7, 31);
    const winterStart = new Date(fiscalYear, 11, 26);
    const winterEnd = new Date(fiscalYear + 1, 0, 7);
    const springStart = new Date(fiscalYear + 1, 2, 26);
    
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
 * データベースシートの入力内容（時程〜放課後の列、2行目以降）をクリアするコアロジック。
 * UI非依存。
 * @returns {{cleared: boolean, message: string}}
 */
function clearDatabaseData_core_() {
  const ss = getSs_();
  const dbSheet = getDbSheet_(ss);
  if (!dbSheet) throw new Error(`シート「${SHEET_NAME_DATABASE}」が見つかりません。`);
  return clearDatabaseInputsForSheet_(dbSheet, getDbColumns());
}

// クリア対象の入力列。「時程」＋週案の入力列すべて。
// 以前は「時程〜放課後」の連続範囲をまとめて消していたため、
//   ・放課後より右にある宿題・持ち物が消えずに残る
//   ・列順の違うシートでは日付など消してはいけない列まで巻き込む
// という2つの問題があった。列は必ず論理名で指定する。
const DB_CLEARABLE_INPUT_KEYS_ = ['TIME'].concat(P2_WEEK_READ_KEYS_);

/**
 * 指定したデータベースシートの入力内容をクリアします。
 * 複数学級モードの学級シート作成（コピー後の初期化）でも使用します。
 * 曜日・週番号などの数式列には触れません。
 * @param {GoogleAppsScript.Spreadsheet.Sheet} dbSheet 対象シート
 * @param {Object} dbCols 対象シートの列マップ（getDbColumns() と同形式）
 * @param {boolean} [includeReflection] 振り返り・振り返り状態の列もクリアするか（学級シート作成時のみ true）
 * @returns {{cleared: boolean, message: string}}
 */
function clearDatabaseInputsForSheet_(dbSheet, dbCols, includeReflection) {
  const lastRow = dbSheet.getLastRow();
  if (lastRow < 2) {
    return { cleared: false, message: `「${dbSheet.getName()}」にクリア対象のデータがありません。` };
  }

  const keys = includeReflection
    ? DB_CLEARABLE_INPUT_KEYS_.concat(['REFLECTION', 'REFLECTION_STATUS'])
    : DB_CLEARABLE_INPUT_KEYS_;
  const columns = keys.map(key => dbCols[key]).filter(Boolean);
  const cleared = [];
  for (const group of p2GroupConsecutiveNumbers_(columns)) {
    const range = dbSheet.getRange(2, group[0], lastRow - 1, group.length);
    range.clearContent();
    cleared.push(range.getA1Notation());
  }

  logInfo(`データベースクリア完了 (${dbSheet.getName()}): ${cleared.join(', ')}`);
  return { cleared: true, message: `「${dbSheet.getName()}」の入力内容をクリアしました。` };
}

/**
 * [Webアプリ API] データベースの入力内容をクリアします（確認はフロント側で実施・結果を返す）。
 * @returns {{success: boolean, message: string}}
 */
function clearDatabaseDataFromWeb() {
  // 旧クライアント互換の委譲エンドポイント。バックアップ無しのクリアは
  // 復旧不能なため、完全バックアップ付きの保護版に一本化する。
  return clearDatabaseDataProtectedFromWeb();
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
    const headers = ['TaskID', 'TaskContent', 'Resource', 'DueDate', 'Source', 'Status', 'Priority', 'Memo'];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setBackground('#1a73e8').setFontColor('white').setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 120);
    sheet.setColumnWidth(2, 300);
    sheet.setColumnWidth(3, 200);
    sheet.setColumnWidth(4, 100);
    sheet.setColumnWidth(5, 150);
    sheet.setColumnWidth(6, 80);
    sheet.setColumnWidth(7, 80);
    sheet.setColumnWidth(8, 250);
    logInfo(`「${SHEET_NAME_TASK}」シートを新規作成しました。`);
  } else if (sheet.getLastColumn() < 8) {
    // 旧6列構成（〜Status）のシートに Priority / Memo 列を追加するマイグレーション
    sheet.getRange(1, 7, 1, 2).setValues([['Priority', 'Memo']])
      .setBackground('#1a73e8').setFontColor('white').setFontWeight('bold');
    sheet.setColumnWidth(7, 80);
    sheet.setColumnWidth(8, 250);
    logInfo(`「${SHEET_NAME_TASK}」シートに Priority / Memo 列を追加しました。`);
  }
  return sheet;
}

/**
 * タスク一覧を取得します。
 * @returns {Object[]}
 */
function getTaskData() {
  try {
    const ss = getSs_();
    const sheet = initTaskSheet_(ss);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    const data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
    return data.map(row => ({
      id: row[0],
      content: row[1],
      resource: row[2],
      dueDate: row[3] instanceof Date ? Utilities.formatDate(row[3], "JST", "yyyy-MM-dd") : row[3],
      source: row[4],
      status: row[5] || '未着手',
      priority: row[6] || '中',
      memo: row[7] || ''
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
 *
 * 既知事項: タスク系の書込(saveTasksBulk/updateTaskStatus/deleteTask/ごみ箱移動)は
 * ロック無しの read-modify-write のため、同一ユーザーが複数端末から同時に操作すると
 * 行ズレの可能性がある。単一操作者前提の運用では実害が小さいため現状は許容している。
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

    const ss = getSs_();
    const sheet = initTaskSheet_(ss);

    const newRows = tasks.map(t => [
      t.id || 'tsk_' + Utilities.getUuid().split('-')[0],
      String(t.content).substring(0, 5000),
      String(t.resource || '').substring(0, 2000),
      t.dueDate || '',
      String(t.source || '').substring(0, 500),
      t.status || '未着手',
      ['高', '中', '低'].indexOf(t.priority) >= 0 ? t.priority : '中',
      String(t.memo || '').substring(0, 5000)
    ]);

    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, 8).setValues(newRows);
    return true;
  } catch (e) {
    logError('saveTasksBulk', e);
    return false;
  }
}

/**
 * TaskID同士を型に依存せず比較します。
 * getValues() はセルの内容によっては TaskID を数値などの非文字列として返すため、
 * クライアントから渡される文字列の taskId と厳密等価（===）で比較すると
 * 一致せず、更新・削除が無言で失敗する。前後空白を除いた文字列同士で比較する。
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function isSameTaskId_(a, b) {
  return String(a).trim() === String(b).trim();
}

/**
 * 特定のタスクのフィールドを更新します。
 * @param {string} taskId
 * @param {Object} updates { content, resource, dueDate, priority, memo } 更新するフィールド
 * @returns {boolean}
 */
function updateTask(taskId, updates) {
  try {
    const ss = getSs_();
    const sheet = initTaskSheet_(ss);
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      if (isSameTaskId_(data[i][0], taskId)) {
        // パフォーマンス: 変更対象を1回のバッチ書き込みで更新
        const row = data[i];
        while (row.length < 8) row.push('');
        if (updates.content !== undefined) row[1] = updates.content;
        if (updates.resource !== undefined) row[2] = updates.resource;
        if (updates.dueDate !== undefined) row[3] = updates.dueDate;
        if (updates.priority !== undefined && ['高', '中', '低'].indexOf(updates.priority) >= 0) row[6] = updates.priority;
        if (updates.memo !== undefined) row[7] = updates.memo;
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
 * @param {string} newStatus "未着手" / "進行中" / "完了"
 * @returns {boolean}
 */
function updateTaskStatus(taskId, newStatus) {
  try {
    const ss = getSs_();
    const sheet = initTaskSheet_(ss);
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      if (isSameTaskId_(data[i][0], taskId)) {
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
    const ss = getSs_();
    const sheet = initTaskSheet_(ss);
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      if (isSameTaskId_(data[i][0], taskId)) {
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

/**
 * データベースシートに「登校前タスク」列（出勤後・児童登校前に行うタスク用）を
 * 「行事」列の直後に挿入します。既に存在する場合は何もしません。
 * 既存のスプレッドシートへ後付けで列を追加するためのユーティリティです。
 * @returns {{ inserted: boolean, message: string }}
 */
function ensurePreClassColumn() {
  const ss = getSs_();
  const dbSheet = getDbSheet_(ss);
  if (!dbSheet) throw new Error(`シート「${SHEET_NAME_DATABASE}」が見つかりません。`);

  const headers = dbSheet.getRange(1, 1, 1, dbSheet.getLastColumn()).getValues()[0];

  // 既に登校前タスク列が存在するか判定（getDbColumns と同じエイリアスで判定）
  const preClassAliases = ['登校前タスク', '登校前', '始業前', '登校前業務', '出勤後タスク'];
  const hasPreClass = headers.some(h => preClassAliases.indexOf(h.toString().trim()) >= 0);
  if (hasPreClass) {
    return { inserted: false, message: '登校前タスク列は既に存在します。' };
  }

  // 「行事」列を探す。見つかればその直後、なければ「朝学習」の直前、どちらも無ければ末尾に追加。
  let eventIdx = headers.findIndex(h => h.toString().trim() === '行事');
  let insertAfter;
  if (eventIdx >= 0) {
    insertAfter = eventIdx + 1; // 1始まりの列番号（行事列の位置）
  } else {
    const morningIdx = headers.findIndex(h => h.toString().trim() === '朝学習');
    if (morningIdx >= 0) {
      insertAfter = morningIdx; // 朝学習の直前に挿入するため、その1つ前の後ろへ
    } else {
      insertAfter = headers.length; // 末尾
    }
  }

  dbSheet.insertColumnAfter(insertAfter);
  const newColIndex = insertAfter + 1;
  dbSheet.getRange(1, newColIndex).setValue('登校前タスク');

  // 列構成が変わったのでキャッシュをクリア
  clearDbColumnsCache();

  return { inserted: true, message: '「登校前タスク」列を行事列の直後に追加しました。' };
}

