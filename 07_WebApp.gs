/**
 * @fileoverview Webアプリケーションのエントリポイントとデータ送受信API (Phase 3)
 * 
 * 重要: Webアプリコンテキスト（doGet経由）では SpreadsheetApp.getActiveSpreadsheet() が
 * null を返すため、全API関数では getSs_() ヘルパー経由でスプレッドシートを取得する。
 */

/** Webアプリ・スプレッドシート両コンテキストで安全にSSを取得するヘルパー */
function getSs_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;
  // Webアプリコンテキスト: スクリプトがバインドされたスプレッドシートを PropertiesService 経由で取得
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  throw new Error('スプレッドシートが取得できません。設定ダッシュボードから SPREADSHEET_ID を設定してください。');
}

/**
 * WebアプリのエントリポイントSPAのメインHTMLを返します。
 * 初回アクセス時に SPREADSHEET_ID をスクリプトプロパティへ自動保存する。
 */
function doGet(e) {
  // バインドスクリプトの場合、初回にスプレッドシートIDを記録
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) {
      PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
    }
  } catch(e) {}
  return HtmlService.createTemplateFromFile('App')
    .evaluate()
    .setTitle('週案エディタ')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

/**
 * HTMLファイルの内容を <include> で読み込むためのユーティリティ関数
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}


// ===================================================
// ===== 週案・データ取得 API =====
// ===================================================

/**
 * 指定された週（月曜日の日付文字列 "yyyy/MM/dd"）の週案データをDBから取得します。
 * @param {string} mondayDateStr "yyyy/MM/dd" 形式の月曜日の日付
 * @returns {Object} { dates: string[], rows: Object[], found: number }
 */
function getWeeklyPlanData(mondayDateStr) {
  try {
    const ss = getSs_();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');

    const dbCols = getDbColumns();
    const dbData = dbSheet.getDataRange().getValues();

    // 月曜日を起点に月～日の7日間を準備
    const monday = parseDate_(mondayDateStr);
    const weekDates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return d;
    });

    // DB全行をMapに変換 (key: "yyyy/MM/dd") および該当週の週番号を取得
    const dbMap = new Map();
    let weekNum = '?';

    for (const row of dbData) {
      if (row[dbCols.DATE - 1] instanceof Date) {
        const dateStr = formatDate(row[dbCols.DATE - 1]);
        dbMap.set(dateStr, row);
        // 今回リクエストされた月曜日のデータをもとに週番号を取得
        if (dateStr === formatDate(monday)) {
          weekNum = row[dbCols.WEEK_NUM - 1] || '?';
        }
      }
    }

    const DAY_LABELS = ['月', '火', '水', '木', '金', '土', '日'];
    const days = weekDates.map((date, i) => {
      const dateStr = formatDate(date);
      const row = dbMap.get(dateStr);
      return {
        date: dateStr,
        dayLabel: DAY_LABELS[i],
        event: row ? (row[dbCols.EVENT - 1] || '') : '',
        morning: row ? (row[dbCols.MORNING - 1] || '') : '',
        periods: row ? [
          { subject: row[dbCols.PERIOD1 - 1] || '', unit: row[dbCols.UNIT1 - 1] || '', content: row[dbCols.CONTENT1 - 1] || '' },
          { subject: row[dbCols.PERIOD2 - 1] || '', unit: row[dbCols.UNIT2 - 1] || '', content: row[dbCols.CONTENT2 - 1] || '' },
          { subject: row[dbCols.PERIOD3 - 1] || '', unit: row[dbCols.UNIT3 - 1] || '', content: row[dbCols.CONTENT3 - 1] || '' },
          { subject: row[dbCols.PERIOD4 - 1] || '', unit: row[dbCols.UNIT4 - 1] || '', content: row[dbCols.CONTENT4 - 1] || '' },
          { subject: row[dbCols.PERIOD5 - 1] || '', unit: row[dbCols.UNIT5 - 1] || '', content: row[dbCols.CONTENT5 - 1] || '' },
          { subject: row[dbCols.PERIOD6 - 1] || '', unit: row[dbCols.UNIT6 - 1] || '', content: row[dbCols.CONTENT6 - 1] || '' },
        ] : Array(6).fill({ subject: '', unit: '', content: '' }),
        recess1: row ? (row[dbCols.RECESS1 - 1] || '') : '',
        recess2: row ? (row[dbCols.RECESS2 - 1] || '') : '',
        afterschool: row ? (row[dbCols.AFTERSCHOOL - 1] || '') : '',
        homework: row ? (row[dbCols.HOMEWORK - 1] || '') : '',
        items: row ? (row[dbCols.ITEMS - 1] || '') : '',
        found: !!row
      };
    });

    return { 
      success: true, days, mondayDateStr, weekNum,
      _debug: {
        dbColsDATE: dbCols.DATE,
        dbColsWEEK: dbCols.WEEK_NUM,
        dbMapSize: dbMap.size,
        sampleDates: Array.from(dbMap.keys()).slice(0, 5),
        searchDate: formatDate(monday),
        totalRows: dbData.length
      }
    };
  } catch (e) {
    logError('getWeeklyPlanData', e);
    return { success: false, error: e.message };
  }
}


/**
 * 週番号からその週の月曜日の日付文字列を取得します。
 * @param {number|string} weekNum 週番号
 * @returns {string|null} "yyyy/MM/dd" 形式の月曜日の日付文字列（見つからなければ null）
 */
function getMondayStrByWeekNumber(weekNum) {
  try {
    const ss = getSs_();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');

    const dbCols = getDbColumns();
    const dbData = dbSheet.getDataRange().getValues();
    const headers = dbData.shift();

    for (const row of dbData) {
      if (row[dbCols.WEEK_NUM - 1] == weekNum) {
        const dateObj = row[dbCols.DATE - 1];
        if (dateObj instanceof Date) {
          const m = getMondayOfWeek(dateObj);
          return Utilities.formatDate(m, Session.getScriptTimeZone(), 'yyyy/MM/dd');
        }
      }
    }
    return null; // 見つからなかった場合
  } catch (e) {
    logError('getMondayStrByWeekNumber', e);
    throw e;
  }
}

/**
 * Webアプリから受け取った週案データをDBに一括保存します。
 * @param {string} mondayDateStr "yyyy/MM/dd" 形式の月曜日の日付
 * @param {Object[]} days 保存するデータの配列（getWeeklyPlanDataと同じ形式）
 * @returns {Object} { success: boolean, message: string }
 */
function saveWeeklyPlanData(mondayDateStr, days) {
  try {
    const ss = getSs_();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');

    const dbCols = getDbColumns();
    const dbData = dbSheet.getDataRange().getValues();

    // DB全行をMapに変換 (key: "yyyy/MM/dd", value: array index)
    const dbDateIndexMap = new Map();
    for (let i = 0; i < dbData.length; i++) {
      if (dbData[i][dbCols.DATE - 1] instanceof Date) {
        dbDateIndexMap.set(formatDate(dbData[i][dbCols.DATE - 1]), i);
      }
    }

    const maxCol = Math.max(...Object.values(dbCols));
    dbData.forEach(row => { while (row.length < maxCol) row.push(''); });

    let updatedCount = 0;
    const notFoundDates = [];

    for (const day of days) {
      if (!day.found && !day.periods.some(p => p.subject)) continue; // 空の日はスキップ

      if (dbDateIndexMap.has(day.date)) {
        const rowIdx = dbDateIndexMap.get(day.date);
        const row = dbData[rowIdx];

        row[dbCols.EVENT - 1]      = day.event || '';
        row[dbCols.MORNING - 1]    = day.morning || '';
        row[dbCols.PERIOD1 - 1]    = day.periods[0]?.subject || '';
        row[dbCols.UNIT1 - 1]      = day.periods[0]?.unit || '';
        row[dbCols.CONTENT1 - 1]   = day.periods[0]?.content || '';
        row[dbCols.PERIOD2 - 1]    = day.periods[1]?.subject || '';
        row[dbCols.UNIT2 - 1]      = day.periods[1]?.unit || '';
        row[dbCols.CONTENT2 - 1]   = day.periods[1]?.content || '';
        row[dbCols.RECESS1 - 1]    = day.recess1 || '';
        row[dbCols.PERIOD3 - 1]    = day.periods[2]?.subject || '';
        row[dbCols.UNIT3 - 1]      = day.periods[2]?.unit || '';
        row[dbCols.CONTENT3 - 1]   = day.periods[2]?.content || '';
        row[dbCols.PERIOD4 - 1]    = day.periods[3]?.subject || '';
        row[dbCols.UNIT4 - 1]      = day.periods[3]?.unit || '';
        row[dbCols.CONTENT4 - 1]   = day.periods[3]?.content || '';
        row[dbCols.RECESS2 - 1]    = day.recess2 || '';
        row[dbCols.PERIOD5 - 1]    = day.periods[4]?.subject || '';
        row[dbCols.UNIT5 - 1]      = day.periods[4]?.unit || '';
        row[dbCols.CONTENT5 - 1]   = day.periods[4]?.content || '';
        row[dbCols.PERIOD6 - 1]    = day.periods[5]?.subject || '';
        row[dbCols.UNIT6 - 1]      = day.periods[5]?.unit || '';
        row[dbCols.CONTENT6 - 1]   = day.periods[5]?.content || '';
        row[dbCols.AFTERSCHOOL - 1] = day.afterschool || '';
        row[dbCols.HOMEWORK - 1]   = day.homework || '';
        row[dbCols.ITEMS - 1]      = day.items || '';

        updatedCount++;
      } else {
        notFoundDates.push(day.date);
      }
    }

    dbSheet.getRange(1, 1, dbData.length, dbData[0].length).setValues(dbData);

    const msg = notFoundDates.length > 0
      ? `${updatedCount}日分を保存しました（DB未登録日: ${notFoundDates.join(', ')}）`
      : `${updatedCount}日分を保存しました`;

    return { success: true, message: msg, updatedCount };
  } catch (e) {
    logError('saveWeeklyPlanData', e);
    return { success: false, error: e.message };
  }
}

/**
 * 単元マスタから教科一覧と単元リストを取得します（サジェスト用）。
 * @returns {Object} { subjects: string[], masterMap: Object }
 */
function getUnitMasterForSuggest() {
  try {
    const ss = getSs_();
    const masterSheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
    if (!masterSheet) return { success: true, subjects: [], masterMap: {} };

    const data = masterSheet.getDataRange().getValues();
    const subjects = [...new Set(data.slice(1).map(r => r[MASTER_COL_SUBJECT - 1]).filter(Boolean))];
    const masterMap = {};
    for (const row of data.slice(1)) {
      const subject = row[MASTER_COL_SUBJECT - 1];
      const unit = row[MASTER_COL_UNIT_NAME - 1];
      if (subject && unit) {
        if (!masterMap[subject]) masterMap[subject] = new Set();
        masterMap[subject].add(unit);
      }
    }
    // Setを配列に変換
    for (const key in masterMap) masterMap[key] = [...masterMap[key]];

    return { success: true, subjects, masterMap };
  } catch (e) {
    logError('getUnitMasterForSuggest', e);
    return { success: false, error: e.message };
  }
}

/**
 * 月別・教科別の実施時数を集計して返します。
 * @param {number} year 対象年（西暦）
 * @param {number} month 対象月（1〜12）
 * @returns {Object} 教科別時数オブジェクト
 */
function getMonthlyHoursData(year, month) {
  try {
    const ss = getSs_();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');

    const dbCols = getDbColumns();
    const dbData = dbSheet.getDataRange().getValues();

    const hoursBySubject = {};
    const periodCols = [dbCols.PERIOD1, dbCols.PERIOD2, dbCols.PERIOD3, dbCols.PERIOD4, dbCols.PERIOD5, dbCols.PERIOD6];

    for (const row of dbData.slice(1)) {
      const date = row[dbCols.DATE - 1];
      if (!(date instanceof Date)) continue;
      if (date.getFullYear() !== year || date.getMonth() + 1 !== month) continue;

      for (const col of periodCols) {
        const subject = row[col - 1];
        if (subject && typeof subject === 'string' && subject.trim()) {
          hoursBySubject[subject] = (hoursBySubject[subject] || 0) + 1;
        }
      }
    }

    return { success: true, year, month, hoursBySubject };
  } catch (e) {
    logError('getMonthlyHoursData', e);
    return { success: false, error: e.message };
  }
}

/**
 * 年間（4月〜翌年3月）の教科別・月別実施時数を集計して返します。
 * @param {number} academicYear 対象年度（例: 2024 なら 2024年4月〜2025年3月）
 * @returns {Object} 教科別・月別時数オブジェクト
 */
function getAnnualHoursData(academicYear) {
  try {
    const ss = getSs_();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');

    const dbCols = getDbColumns();
    const dbData = dbSheet.getDataRange().getValues();

    // hoursData: { "国語": { "4": 15.333, "5": 20, ... }, "算数": ... }
    const hoursData = {};

    const periodCols = [dbCols.PERIOD1, dbCols.PERIOD2, dbCols.PERIOD3, dbCols.PERIOD4, dbCols.PERIOD5, dbCols.PERIOD6].filter(c => c);

    for (const row of dbData.slice(1)) {
      const date = row[dbCols.DATE - 1];
      if (!(date instanceof Date)) continue;
      
      const year = date.getFullYear();
      const month = date.getMonth() + 1;
      
      let rowAcademicYear = year;
      if (month <= 3) rowAcademicYear -= 1;
      
      if (rowAcademicYear !== academicYear) continue;

      for (const col of periodCols) {
        const val = (row[col - 1] || '').toString().trim();
        if (!val) continue;

        // 半角/全角スペースを統一
        const normalized = val.replace(/　/g, ' ');
        
        // 文字列(1文字以上) + スペース(0個以上) + (数値/数値 または 小数)(0個か1個) をすべて抽出
        // 例: "国語1/3", "理科 1/2", "図工 1.5", "社会"
        const regex = /([^\s\d\/\.]+)(?:[\s]*(\d+\/\d+|\d+\.\d+))?/g;
        let match;
        while ((match = regex.exec(normalized)) !== null) {
          if (match[1].trim() === '') continue;
          
          let subject = match[1].trim();
          let fraction = 1;
          
          if (match[2]) {
            if (match[2].includes('/')) {
                const parts = match[2].split('/');
                fraction = parseFloat(parts[0]) / parseFloat(parts[1]);
            } else {
                fraction = parseFloat(match[2]);
            }
          }

          if (!hoursData[subject]) hoursData[subject] = {};
          if (!hoursData[subject][month]) hoursData[subject][month] = 0;
          hoursData[subject][month] += fraction;
        }
      }
    }

    return { success: true, academicYear, hoursData };
  } catch (e) {
    logError('getAnnualHoursData', e);
    return { success: false, error: e.message };
  }
}

// ===================================================
// ===== ユーティリティ =====
// ===================================================

/**
 * "yyyy/MM/dd" 形式の文字列をDateオブジェクトに変換します。
 * @param {string} dateStr
 * @returns {Date}
 */
function parseDate_(dateStr) {
  const parts = dateStr.split('/');
  return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
}

/**
 * 今日が含まれる週の月曜日の日付文字列を返します。
 * @returns {string} "yyyy/MM/dd"
 */
function getTodaysMondayStr() {
  return formatDate(getMondayOfWeek(new Date()));
}


// ===================================================
// ===== PDF帳票生成エンジン API (Phase 3 Step 3) =====
// ===================================================




// ===================================================
// ===== 学級通信ジェネレーター API (Phase 3 Step 3) =====
// ===================================================

/**
 * [Webアプリ API] 指定週のDBデータから学級通信の原稿データを生成して返します。
 * フロントエンドでプレビュー&編集し、`postNewsletterToClassroom()` で投稿します。
 * @param {string} mondayDateStr "yyyy/MM/dd"
 * @returns {Object} 学級通信の構成データ
 */
function getNewsletterData(mondayDateStr) {
  try {
    const result = getWeeklyPlanData(mondayDateStr);
    if (!result.success) return result;

    const days = result.days;
    const monday = parseDate_(mondayDateStr);

    const scheduleSummary = days.slice(0, 5).map(day => {
      const subjects = day.periods.filter(p => p.subject).map(p => p.subject).join('・');
      const event = day.event ? `【${day.event}】` : '';
      return `${day.dayLabel}（${day.date.slice(5)}）${event} ${subjects}`;
    }).join('\n');

    return {
      success: true,
      title: `今週のがんばり & 来週の予定`,
      date: Utilities.formatDate(monday, 'JST', 'yyyy年M月d日'),
      scheduleSummary: scheduleSummary,
      days: days
    };
  } catch (e) {
    logError('getNewsletterData', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 「学級通信」シートをPDF化してDrive保存し、ダウンロードURLを返します。
 * @param {string} mondayDateStr 対象週の月曜日の日付
 * @returns {Object} { success, downloadUrl, viewUrl, fileName }
 */
function generateNewsletterPdf(mondayDateStr) {
  try {
    const ss = getSs_();
    const sheet = ss.getSheetByName(SHEET_NAME_NEWSLETTER);
    if (!sheet) throw new Error(`「${SHEET_NAME_NEWSLETTER}」シートが見つかりません`);

    // DBから当該週の週番号を取得
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');
    const dbCols = getDbColumns();
    const dbData = dbSheet.getDataRange().getValues();
    const monday = parseDate_(mondayDateStr);

    let weekNum = null;
    for (const row of dbData.slice(1)) {
      const date = row[dbCols.DATE - 1];
      if (date instanceof Date && isSameDate(date, monday)) {
        weekNum = row[dbCols.WEEK_NUM - 1];
        break;
      }
    }

    // 学級通信シートのA1に直接書き込む
    if (weekNum !== null && weekNum !== undefined) {
      sheet.getRange('A1').setValue(weekNum);
      SpreadsheetApp.flush();
      Utilities.sleep(3000); // 描画待ち
    } else {
      logInfo('警告: DBに該当日付の週番号が見つかりませんでした。mondayDateStr=' + mondayDateStr);
    }

    const formattedDate = Utilities.formatDate(new Date(), 'JST', 'yyyyMMdd');
    const fileName = `学級通信_${formattedDate}.pdf`;
    const exportUrl = `https://docs.google.com/spreadsheets/d/${ss.getId()}/export?`
      + `exportFormat=pdf&format=pdf&size=A4&portrait=true&fitToPage=true`
      + `&gridlines=false&printtitle=false&sheetnames=false`
      + `&gid=${sheet.getSheetId()}`;

    const blob = UrlFetchApp.fetch(exportUrl, {
      headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() }
    }).getBlob().setName(fileName);

    const folder = DriveApp.getRootFolder();
    const existing = folder.getFilesByName(fileName);
    while (existing.hasNext()) existing.next().setTrashed(true);

    const pdfFile = folder.createFile(blob);
    pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    logInfo(`学級通信PDF生成: ${fileName}`);
    return {
      success: true,
      downloadUrl: pdfFile.getDownloadUrl(),
      viewUrl: `https://drive.google.com/file/d/${pdfFile.getId()}/view`,
      fileName
    };
  } catch (e) {
    logError('generateNewsletterPdf', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 学級通信HTMLをPDFに変換してClassroomへ投稿します。
 * エディタのHTMLを直接受け取り、Drive経由でPDF化してClassroomに投稿します。
 * @param {string} customMessage Classroomへの付加メッセージ
 * @param {string} htmlContent 学級通信エディタのHTML文字列
 * @returns {Object} { success, message }
 */
function postNewsletterToClassroomFromWeb(customMessage, htmlContent) {
  try {
    const courseName = getCourseNameSafe_();
    const formattedDate = Utilities.formatDate(new Date(), 'JST', 'yyyyMMdd_HHmm');
    const fileName = '学級通信_' + formattedDate;
    const folder = getOrCreateNwFolder_();

    let classroomFile;
    try {
      // HTML → Google Doc → PDF (Drive Advanced Serviceが必要)
      const htmlBlob = Utilities.newBlob(htmlContent, 'text/html', fileName + '.html');
      const inserted = Drive.Files.insert(
        { title: fileName, mimeType: 'application/vnd.google-apps.document' },
        htmlBlob
      );
      const pdfBlob = DriveApp.getFileById(inserted.id).getAs('application/pdf');
      pdfBlob.setName(fileName + '.pdf');
      classroomFile = folder.createFile(pdfBlob);
      // 変換用の中間ファイル（Googleドキュメント）を削除
      DriveApp.getFileById(inserted.id).setTrashed(true);
    } catch (convErr) {
      // フォールバック: Drive Advanced Serviceが無効な場合はHTMLファイルをそのまま投稿
      logError('postNewsletterToClassroomFromWeb (HTML→PDF変換失敗、HTMLで代替)', convErr);
      const htmlBlob = Utilities.newBlob(htmlContent, 'text/html', fileName + '.html');
      classroomFile = folder.createFile(htmlBlob);
    }

    classroomFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    const courseId = getCourseIdByName(courseName);
    const announcement = {
      text: customMessage || '学級通信をお届けします。',
      materials: [{ driveFile: { driveFile: { id: classroomFile.getId() } } }]
    };
    Classroom.Courses.Announcements.create(announcement, courseId);

    logInfo(`学級通信をClassroom「${courseName}」に投稿完了: ${classroomFile.getName()}`);
    return { success: true, message: `「${courseName}」に学級通信を投稿しました！` };
  } catch (e) {
    logError('postNewsletterToClassroomFromWeb', e);
    return { success: false, error: e.message };
  }
}

// ===================================================
// ===== 学級通信データ 保存/読込 API =====
// ===================================================

/**
 * 学級通信データ保存用フォルダを取得（なければ作成）
 */
function getOrCreateNwFolder_() {
  const folderName = '学級通信データ';
  const iter = DriveApp.getFoldersByName(folderName);
  if (iter.hasNext()) return iter.next();
  return DriveApp.createFolder(folderName);
}

/**
 * [Web API] 学級通信のブロックデータをDrive+シートに保存します。
 * @param {string} title タイトル
 * @param {string} mondayStr 対象週
 * @param {string} jsonString ブロックデータJSON
 * @returns {Object} { success, message }
 */
function saveNewsletterData(title, mondayStr, jsonString) {
  try {
    const ss = getSs_();
    const sheet = ss.getSheetByName(SHEET_NAME_NEWSLETTER_DATA);
    if (!sheet) throw new Error(`「${SHEET_NAME_NEWSLETTER_DATA}」シートが見つかりません`);

    const folder = getOrCreateNwFolder_();
    const fileName = 'nw_' + new Date().getTime() + '.json';
    const file = folder.createFile(fileName, jsonString, 'application/json');

    sheet.appendRow([
      title || '無題',
      mondayStr || '',
      new Date(),
      file.getId()
    ]);

    logInfo(`学級通信保存: ${title} (${mondayStr})`);
    return { success: true, message: '保存しました' };
  } catch (e) {
    logError('saveNewsletterData', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Web API] 保存済み学級通信の一覧を取得します。
 * @returns {Object} { success, list: [{rowIndex, title, mondayStr, savedAt, fileId}] }
 */
function getNewsletterSaveList() {
  try {
    const ss = getSs_();
    const sheet = ss.getSheetByName(SHEET_NAME_NEWSLETTER_DATA);
    if (!sheet || sheet.getLastRow() < 2) return { success: true, list: [] };

    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues();
    const list = data.map(function(row, i) {
      return {
        rowIndex: i + 2,
        title: row[0] || '無題',
        mondayStr: row[1] || '',
        savedAt: row[2] ? Utilities.formatDate(new Date(row[2]), 'JST', 'yyyy/MM/dd HH:mm') : '',
        fileId: row[3] || ''
      };
    }).reverse();

    return { success: true, list: list };
  } catch (e) {
    logError('getNewsletterSaveList', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Web API] 保存済み学級通信のデータを読み込みます。
 * @param {string} fileId Google DriveのファイルID
 * @returns {Object} { success, data: {blocks, nextId, mondayStr} }
 */
function loadNewsletterData(fileId) {
  try {
    const file = DriveApp.getFileById(fileId);
    const json = file.getBlob().getDataAsString();
    return { success: true, data: JSON.parse(json) };
  } catch (e) {
    logError('loadNewsletterData', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Web API] 保存済み学級通信を削除します。
 * @param {number} rowIndex シートの行番号
 * @param {string} fileId Google DriveのファイルID
 * @returns {Object} { success }
 */
function deleteNewsletterData(rowIndex, fileId) {
  try {
    const ss = getSs_();
    const sheet = ss.getSheetByName(SHEET_NAME_NEWSLETTER_DATA);
    if (sheet && rowIndex >= 2) sheet.deleteRow(rowIndex);
    try { DriveApp.getFileById(fileId).setTrashed(true); } catch(ignore) {}
    return { success: true };
  } catch (e) {
    logError('deleteNewsletterData', e);
    return { success: false, error: e.message };
  }
}

// ===================================================
// ===== 固定時間割エディタ API (Phase 4 Step 1-2) =====
// ===================================================

const SP_KEY_TIMETABLE = 'fixedTimetableData';

/**
 * [エディタ API] 固定時間割データを取得します。
 */
function getTimetableForEditor() {
  try {
    const props = PropertiesService.getScriptProperties();
    const savedJson = props.getProperty(SP_KEY_TIMETABLE);

    if (savedJson) {
      return { success: true, data: JSON.parse(savedJson) };
    }

    // デフォルト空データ
    const emptyData = [0, 1, 2, 3, 4].map(d => ({
      day: d, time: '', morning: '', periods: ['', '', '', '', '', '']
    }));
    return { success: true, data: emptyData };
  } catch (e) {
    logError('getTimetableForEditor', e);
    return { success: false, error: e.message };
  }
}

/**
 * [エディタ API] 固定時間割データをスクリプトプロパティに保存します。
 * @param {Array} timetableData - エディタから送られる固定時間割データ (5要素の配列)
 */
function saveTimetableFromEditor(timetableData) {
  try {
    if (!timetableData || !Array.isArray(timetableData) || timetableData.length !== 5) {
      throw new Error('無効な時間割データです。');
    }
    PropertiesService.getScriptProperties().setProperty(SP_KEY_TIMETABLE, JSON.stringify(timetableData));

    return { success: true, message: '固定時間割を保存しました。' };
  } catch (e) {
    logError('saveTimetableFromEditor', e);
    return { success: false, error: e.message };
  }
}

/**
 * [エディタ API] 指定された週に固定時間割を転記します。
 * @param {string} mondayStr - 転記先の月曜日の日付文字列
 */
function applyTimetableToWeek(mondayStr) {
  try {
    if (!mondayStr) throw new Error('対象週が指定されていません。');
    const targetDate = new Date(mondayStr.replace(/-/g, '/'));
    transferWeeklyTimetable(targetDate);
    return { success: true, message: mondayStr + ' 週に固定時間割を転記しました。' };
  } catch (e) {
    logError('applyTimetableToWeek', e);
    return { success: false, error: e.message };
  }
}

// ===================================================
// ===== Phase 5: シート削除・保護 =====
// ===================================================

/**
 * 残存シートを保護します。
 * メニューから実行されることを想定しています。
 */
function protectSheets() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert(
    'シート保護の実行',
    '以下のシートを保護します。\n\n' +
    '「データベース」「単元マスタ」「ログ」「学級通信」\n\n' +
    '実行しますか？',
    ui.ButtonSet.YES_NO
  );

  if (response !== ui.Button.YES) {
    ui.alert('キャンセルしました。');
    return;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const results = [];

  const sheetsToProtect = [
    SHEET_NAME_DATABASE, SHEET_NAME_UNIT_MASTER, SHEET_NAME_LOG,
    SHEET_NAME_NEWSLETTER
  ];
  const owner = Session.getEffectiveUser();

  sheetsToProtect.forEach(name => {
    try {
      const sheet = ss.getSheetByName(name);
      if (sheet) {
        sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(p => p.remove());

        const protection = sheet.protect().setDescription(`${name} (自動保護)`);
        protection.addEditor(owner);
        protection.removeEditors(protection.getEditors().filter(u => u.getEmail() !== owner.getEmail()));
        if (protection.canDomainEdit()) {
          protection.setDomainEdit(false);
        }
        results.push(`「${name}」シートを保護しました。`);
        logInfo(`「${name}」シートを保護しました。`);
      } else {
        results.push(`「${name}」シートが見つかりません（スキップ）。`);
      }
    } catch (e) {
      results.push(`「${name}」シートの保護に失敗: ${e.message}`);
      logError(`シート保護失敗 (${name})`, e);
    }
  });

  ui.alert('完了', results.join('\n'), ui.ButtonSet.OK);
  logInfo('シート保護完了:\n' + results.join('\n'));
}

// ===================================================
// ===== 祝日データ管理 =====
// ===================================================

const SP_KEY_HOLIDAYS = 'holidayDates';

/**
 * 内閣府CSVから祝日データを取得し、スクリプトプロパティに保存します。
 * onOpenトリガーやメニューから呼び出し可能。
 */
function fetchAndStoreHolidays() {
  try {
    const url = 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv';
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      logInfo('祝日CSVの取得に失敗 (HTTP ' + response.getResponseCode() + ')');
      return;
    }
    const csvText = response.getContentText('Shift_JIS');
    const lines = csvText.split('\n');
    const holidays = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const parts = line.split(',');
      if (parts.length >= 2) {
        holidays.push({ date: parts[0].trim(), name: parts[1].trim() });
      }
    }
    PropertiesService.getScriptProperties().setProperty(SP_KEY_HOLIDAYS, JSON.stringify(holidays));
    logInfo('祝日データを更新しました (' + holidays.length + '件)');
  } catch (e) {
    logError('fetchAndStoreHolidays', e);
  }
}

/**
 * [Webアプリ API] 保存済みの祝日データを返します。
 */
function getHolidays() {
  try {
    const json = PropertiesService.getScriptProperties().getProperty(SP_KEY_HOLIDAYS);
    if (json) return { success: true, data: JSON.parse(json) };
    // まだ取得していなければ取得して返す
    fetchAndStoreHolidays();
    const json2 = PropertiesService.getScriptProperties().getProperty(SP_KEY_HOLIDAYS);
    return { success: true, data: json2 ? JSON.parse(json2) : [] };
  } catch (e) {
    logError('getHolidays', e);
    return { success: false, error: e.message };
  }
}

// ===================================================
// ===== 教科別標準時数管理 =====
// ===================================================

const SP_KEY_STANDARD_HOURS = 'standardHoursBySubject';

/**
 * 学年別の標準時数マスタデータを取得します。
 */
function getStandardHoursMaster(grade) {
  const master = {
    1: [
      { subject: '国語', hours: 306 }, { subject: '算数', hours: 136 },
      { subject: '生活', hours: 102 }, { subject: '音楽', hours: 68 },
      { subject: '図画工作', hours: 68 }, { subject: '体育', hours: 102 },
      { subject: '道徳', hours: 34 }, { subject: '特活', hours: 34 }
    ],
    2: [
      { subject: '国語', hours: 315 }, { subject: '算数', hours: 175 },
      { subject: '生活', hours: 105 }, { subject: '音楽', hours: 70 },
      { subject: '図画工作', hours: 70 }, { subject: '体育', hours: 105 },
      { subject: '道徳', hours: 35 }, { subject: '特活', hours: 35 }
    ],
    3: [
      { subject: '国語', hours: 245 }, { subject: '社会', hours: 70 },
      { subject: '算数', hours: 175 }, { subject: '理科', hours: 90 },
      { subject: '音楽', hours: 60 }, { subject: '図画工作', hours: 60 },
      { subject: '体育', hours: 105 }, { subject: '道徳', hours: 35 },
      { subject: '外国語活動', hours: 35 }, { subject: '総合', hours: 70 },
      { subject: '特活', hours: 35 }
    ],
    4: [
      { subject: '国語', hours: 245 }, { subject: '社会', hours: 90 },
      { subject: '算数', hours: 175 }, { subject: '理科', hours: 105 },
      { subject: '音楽', hours: 60 }, { subject: '図画工作', hours: 60 },
      { subject: '体育', hours: 105 }, { subject: '道徳', hours: 35 },
      { subject: '外国語活動', hours: 35 }, { subject: '総合', hours: 70 },
      { subject: '特活', hours: 35 }
    ],
    5: [
      { subject: '国語', hours: 175 }, { subject: '社会', hours: 100 },
      { subject: '算数', hours: 175 }, { subject: '理科', hours: 105 },
      { subject: '音楽', hours: 50 }, { subject: '図画工作', hours: 50 },
      { subject: '家庭', hours: 60 }, { subject: '体育', hours: 90 },
      { subject: '道徳', hours: 35 }, { subject: '外国語', hours: 70 },
      { subject: '総合', hours: 70 }, { subject: '特活', hours: 35 }
    ],
    6: [
      { subject: '国語', hours: 175 }, { subject: '社会', hours: 105 },
      { subject: '算数', hours: 175 }, { subject: '理科', hours: 105 },
      { subject: '音楽', hours: 50 }, { subject: '図画工作', hours: 50 },
      { subject: '家庭', hours: 55 }, { subject: '体育', hours: 90 },
      { subject: '道徳', hours: 35 }, { subject: '外国語', hours: 70 },
      { subject: '総合', hours: 70 }, { subject: '特活', hours: 35 }
    ]
  };
  return master[grade] || master[3];
}

/**
 * [Webアプリ API] 担当学年を設定し、標準時数を初期化します。
 */
function saveGrade(gradeNum) {
  try {
    const props = PropertiesService.getScriptProperties();
    props.setProperty(SCRIPT_PROP_GRADE, gradeNum.toString());
    
    // 学年変更に伴い、標準時数をその学年のマスタで上書きする
    const newStandardHours = getStandardHoursMaster(gradeNum);
    props.setProperty(SP_KEY_STANDARD_HOURS, JSON.stringify(newStandardHours));
    
    return { success: true, message: gradeNum + '年生の設定を適用しました。', data: newStandardHours };
  } catch (e) {
    logError('saveGrade', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 現在の担当学年を取得します。
 */
function getGrade() {
  try {
    const props = PropertiesService.getScriptProperties();
    const grade = props.getProperty(SCRIPT_PROP_GRADE) || "3"; // デフォルト3年
    return { success: true, grade: parseInt(grade, 10) };
  } catch (e) {
    logError('getGrade', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 教科別標準時数データを取得します。
 */
function getStandardHours() {
  try {
    const props = PropertiesService.getScriptProperties();
    const saved = props.getProperty(SP_KEY_STANDARD_HOURS);
    if (saved) return { success: true, data: JSON.parse(saved) };

    const grade = props.getProperty(SCRIPT_PROP_GRADE) || "3";
    const defaults = getStandardHoursMaster(grade);
    
    return { success: true, data: defaults };
  } catch (e) {
    logError('getStandardHours', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 教科別標準時数データを保存します。
 */
function saveStandardHours(data) {
  try {
    if (!data || !Array.isArray(data)) throw new Error('無効なデータ');
    PropertiesService.getScriptProperties().setProperty(SP_KEY_STANDARD_HOURS, JSON.stringify(data));
    return { success: true, message: '標準時数を保存しました。' };
  } catch (e) {
    logError('saveStandardHours', e);
    return { success: false, error: e.message };
  }
}

// ===================================================
// ===== 時数集計 API =====
// ===================================================

/**
 * [Webアプリ API] 指定週までの時数集計を返します。
 * 週案シートのCOUNTIF+QUERY数式を再現（1/3, 2/3対応）。
 * @param {string} mondayStr - 対象週の月曜日
 */
function getHoursSummary(mondayStr) {
  try {
    const ss = getSs_();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');

    const dbCols = getDbColumns();
    const dbData = dbSheet.getDataRange().getValues();

    // 対象週の月曜日
    const targetMonday = new Date(mondayStr.replace(/-/g, '/'));
    targetMonday.setHours(0,0,0,0);
    const targetFriday = new Date(targetMonday);
    targetFriday.setDate(targetFriday.getDate() + 4);

    // 教科列のインデックス（1校時〜6校時）
    const periodCols = [dbCols.PERIOD1, dbCols.PERIOD2, dbCols.PERIOD3, dbCols.PERIOD4, dbCols.PERIOD5, dbCols.PERIOD6].filter(c => c);

    // 当週と累計を集計
    const weeklyCount = {};
    const cumulativeCount = {};

    for (let i = 1; i < dbData.length; i++) {
      const rowDate = dbData[i][dbCols.DATE - 1];
      if (!(rowDate instanceof Date)) continue;
      const d = new Date(rowDate);
      d.setHours(0,0,0,0);

      // 累計: 最初〜対象週の金曜まで
      const isCumulative = d <= targetFriday;
      // 当週: 月曜〜金曜
      const isThisWeek = d >= targetMonday && d <= targetFriday;

      if (!isCumulative) continue;

      periodCols.forEach(col => {
        const val = (dbData[i][col - 1] || '').toString().trim();
        if (!val) return;

        // 半角/全角スペースを統一
        const normalized = val.replace(/　/g, ' ');
        
        // 文字列(1文字以上) + スペース(0個以上) + (数値/数値 または 小数)(0個か1個) をすべて抽出
        const regex = /([^\s\d\/\.]+)(?:[\s]*(\d+\/\d+|\d+\.\d+))?/g;
        let match;
        while ((match = regex.exec(normalized)) !== null) {
          if (match[1].trim() === '') continue;
          
          let subject = match[1].trim();
          let fraction = 1;
          
          if (match[2]) {
            if (match[2].includes('/')) {
                const parts = match[2].split('/');
                fraction = parseFloat(parts[0]) / parseFloat(parts[1]);
            } else {
                fraction = parseFloat(match[2]);
            }
          }

        if (!cumulativeCount[subject]) cumulativeCount[subject] = 0;
        cumulativeCount[subject] += fraction;

        if (isThisWeek) {
          if (!weeklyCount[subject]) weeklyCount[subject] = 0;
          weeklyCount[subject] += fraction;
        }
        }
      });
    }

    // 標準時数を取得
    const stdResult = getStandardHours();
    const standardHours = (stdResult.success && stdResult.data) ? stdResult.data : [];

    // 結果を構築
    const summary = standardHours.map(sh => {
      const subj = sh.subject;
      const std = sh.hours || 0;
      const weekly = Math.round((weeklyCount[subj] || 0) * 10) / 10;
      const cumulative = Math.round((cumulativeCount[subj] || 0) * 10) / 10;
      const pct = std > 0 ? Math.round(cumulative / std * 100) : 0;
      return { subject: subj, standard: std, weekly: weekly, cumulative: cumulative, percent: pct };
    });

    return { success: true, data: summary };
  } catch (e) {
    logError('getHoursSummary', e);
    return { success: false, error: e.message };
  }
}

// ===================================================
// ===== 年間カレンダー自動生成 API =====
// ===================================================

/**
 * [Webアプリ API] データベースシートの「日付」「曜日」「第何週/週番号」列を1年間分自動生成します
 * 数式依存を排除するための機能です。
 * @param {string|number} year - 対象年度 (例: 2025)
 * @param {string} startMondayStr - 第1週目の月曜日 (YYYY-MM-DD)
 */
function generateAnnualCalendar(year, startMondayStr) {
  try {
    const ss = getSs_();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');

    const dbCols = getDbColumns();
    if (!dbCols.DATE || !dbCols.DAY_OF_WEEK || !dbCols.WEEK_NUM) {
      throw new Error('データベースシートに必要な列（日付、曜日、週番号）が見つかりません');
    }

    // 1行目はヘッダーなので2行目から開始
    const startRow = 2;
    // シートの現在の最終行。カレンダー生成によってこれより伸びる可能性がある
    const lastRow = Math.max(dbSheet.getLastRow(), startRow);
    const lastCol = dbSheet.getLastColumn();

    // 既存データを全取得してマージベースを作成する
    const existingData = dbSheet.getRange(startRow, 1, lastRow - startRow + 1, lastCol).getValues();
    
    // 生成の起点日
    let currentDate = new Date(startMondayStr.replace(/-/g, '/'));
    currentDate.setHours(0, 0, 0, 0);

    const DAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];
    
    // 365日分（余裕を持って370日分）を生成
    const totalDays = 370;
    
    // 更新用の配列（行数は既存データ or 370日の多い方に合わせる）
    const mergeRowCount = Math.max(existingData.length, totalDays);
    const newData = [];

    let currentWeekNum = 1;

    for (let i = 0; i < mergeRowCount; i++) {
      // 既存の行データをベースにする（なければ空配列を作成して幅を合わせる）
      let row = existingData[i] ? [...existingData[i]] : new Array(lastCol).fill('');
      
      if (i < totalDays) {
        // カレンダー生成対象の行
        const d = new Date(currentDate);
        
        // 週番号の計算 (月曜日ごとにカウントアップ)
        if (i > 0 && d.getDay() === 1) {
          currentWeekNum++;
        }

        row[dbCols.DATE - 1] = d; // 日付オブジェクトをそのままセット
        row[dbCols.DAY_OF_WEEK - 1] = DAY_LABELS[d.getDay()]; // 曜日
        row[dbCols.WEEK_NUM - 1] = currentWeekNum; // 第何週

        // 次の日へ
        currentDate.setDate(currentDate.getDate() + 1);
      } else {
        // 370日以降かつ既存行がある場合、カレンダー列はクリアする（あるいは既存を維持する）
        // 古い年度の余分な日付が残らないよう、カレンダー系はクリア
        row[dbCols.DATE - 1] = '';
        row[dbCols.DAY_OF_WEEK - 1] = '';
        row[dbCols.WEEK_NUM - 1] = '';
      }
      newData.push(row);
    }

    // まとめて一括書き込み
    dbSheet.getRange(startRow, 1, newData.length, lastCol).setValues(newData);

    return { success: true, message: `${year}年度のカレンダー（${totalDays}日分）を生成しました。` };
  } catch (e) {
    logError('generateAnnualCalendar', e);
    return { success: false, error: e.message };
  }
}

// ===================================================
// ===== タスク管理（TODO自動抽出） WebApp API (Phase 6)
// ===================================================

/**
 * [Webアプリ API] タスク一覧を取得します
 * @returns {Object} { success: boolean, tasks: Object[] }
 */
function getTasksFromWebApp() {
  try {
    const tasks = getTaskData();
    return { success: true, tasks: tasks };
  } catch (e) {
    logError('getTasksFromWebApp', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 新しいタスク（複数可）を一括保存します
 * @param {Object[]} tasks 保存するタスクの配列
 * @returns {Object} { success: boolean, message: string }
 */
function saveTasksFromWebApp(tasks) {
  try {
    const isSuccess = saveTasksBulk(tasks);
    if (isSuccess) {
      return { success: true, message: `${tasks.length}件のタスクを保存しました` };
    } else {
      throw new Error('タスクの保存に失敗しました');
    }
  } catch (e) {
    logError('saveTasksFromWebApp', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] タスクのステータス（未着手/完了）を更新します
 * @param {string} taskId
 * @param {string} newStatus 
 * @returns {Object} { success: boolean }
 */
function updateTaskStatusFromWebApp(taskId, newStatus) {
  try {
    const isSuccess = updateTaskStatus(taskId, newStatus);
    return { success: isSuccess };
  } catch (e) {
    logError('updateTaskStatusFromWebApp', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] タスクを削除します
 * @param {string} taskId 
 * @returns {Object} { success: boolean }
 */
function deleteTaskFromWebApp(taskId) {
  try {
    const isSuccess = deleteTask(taskId);
    return { success: isSuccess };
  } catch (e) {
    logError('deleteTaskFromWebApp', e);
    return { success: false, error: e.message };
  }
}
