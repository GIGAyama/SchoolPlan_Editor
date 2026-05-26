/**
 * @fileoverview Google Classroomへの時間割、学級通信のPDF投稿など連携機能
 */

/** 
 * クラスルーム投稿用トリガーを設定します（時間指定）。
 */
function setTriggers() {
  const ui = SpreadsheetApp.getUi();
  const functionNameToTrigger = "postScheduleToClassroom";
  const response = ui.prompt('トリガー時間設定', `「${functionNameToTrigger}」を実行する時間を0～23時の整数で入力してください (例: 15):`, ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() == ui.Button.OK) {
    const hour = parseInt(response.getResponseText(), 10);
    if (!isNaN(hour) && hour >= 0 && hour <= 23) {
      try {
        deleteTriggers_(functionNameToTrigger);
        ScriptApp.newTrigger(functionNameToTrigger).timeBased().everyDays(1).atHour(hour).create();
        logInfo(`トリガー作成: ${functionNameToTrigger} 毎日${hour}時`);
        ui.alert(`トリガー設定を完了しました。\n毎日${hour}時に投稿が実行されます。`);
      } catch (e) {
        logError("setTriggers", e);
        ui.alert(`トリガー設定エラー: ${e.message}\n(権限が不足している可能性があります)`);
      }
    } else {
      ui.alert(`入力が無効です。「${response.getResponseText()}」。0から23の整数で入力してください。`);
    }
  } else {
    ui.alert('トリガー設定をキャンセルしました。');
  }
}

/**
 * アカウント連携クラス一覧を取得して表示します。
 */
function listCoursesToSheet() {
  try {
    let courses = [];
    let pageToken = null;
    do {
      const response = Classroom.Courses.list({ pageSize: 100, courseStates: ['ACTIVE'], pageToken: pageToken });
      if (response.courses) {
        courses = courses.concat(response.courses);
      }
      pageToken = response.nextPageToken;
    } while (pageToken);

    if (courses.length === 0) {
      SpreadsheetApp.getUi().alert("有効なクラスが見つかりませんでした。");
    } else {
      const names = courses.map(c => c.name);
      logInfo('クラス一覧: ' + names.join(', '));
      SpreadsheetApp.getUi().alert('クラス一覧の取得が完了しました。\n' + names.join('\n'));
    }
  } catch (e) {
    logError("listCoursesToSheet", e);
    SpreadsheetApp.getUi().alert(`クラス一覧取得エラー: ${e.message}\n（APIの有効化や権限を確認してください）`);
  }
}

/**
 * データベースから次の登校日の予定を読み取り、Google Classroomにお知らせとして投稿します。
 * 本日が登校日のときのみ実行し、休みを挟む場合は休み直前の登校日に休み明けの予定を投稿します
 * （例：金曜日に翌週月曜日の予定を投稿）。
 */
function postScheduleToClassroom() {
  try {
    const ss = typeof getSs_ === 'function' ? getSs_() : SpreadsheetApp.getActiveSpreadsheet();
    const databaseSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!databaseSheet) throw new Error("データベースシートが見つかりません");

    const courseName = getCourseNameSafe_();
    const courseId = getCourseIdByName(courseName);
    if (!courseId) throw new Error(`クラス「${courseName}」見つからず`);

    const dbCols = getDbColumns();
    const dbData = databaseSheet.getDataRange().getValues();

    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();

    // 本日が登校日（1校時に予定あり）かを判定する。
    // 休み中は投稿しない。休みに入る前の最終登校日に、休み明けの予定を投稿済みのため、
    // ここで投稿すると同じ予定が重複して投稿されてしまう。
    const isTodaySchoolDay = dbData.some(row =>
      row[dbCols.DATE - 1] instanceof Date && isSameDate(row[dbCols.DATE - 1], today) && row[dbCols.PERIOD1 - 1]);

    if (!isTodaySchoolDay) {
      Logger.log(`本日は登校日ではないためスキップ`);
      return;
    }

    // 本日より後で、1校時に予定が入っている最も近い登校日を探す。
    // これにより休みを挟む場合でも、休み直前の登校日に次の登校日分が投稿される
    // （例：金曜日に翌週月曜日の予定を投稿）。
    let foundRowData = null;
    let foundDateStart = null;
    dbData.forEach(row => {
      const cellDate = row[dbCols.DATE - 1];
      if (!(cellDate instanceof Date) || !row[dbCols.PERIOD1 - 1]) return;
      const cellStart = new Date(cellDate.getFullYear(), cellDate.getMonth(), cellDate.getDate()).getTime();
      if (cellStart > todayStart && (foundDateStart === null || cellStart < foundDateStart)) {
        foundDateStart = cellStart;
        foundRowData = row;
      }
    });

    if (!foundRowData) {
      Logger.log(`次の登校日の予定が見つからずスキップ`);
      return;
    }

    const targetDate = foundRowData[dbCols.DATE - 1];
    const daysOfWeek = ["日", "月", "火", "水", "木", "金", "土"];
    const formattedDateString = `${Utilities.formatDate(targetDate, "JST", "yyyy/MM/dd")}（${daysOfWeek[targetDate.getDay()]}）`;

    const schedule = {
      "朝学習": foundRowData[dbCols.MORNING - 1] || '',
      "1校時": foundRowData[dbCols.PERIOD1 - 1] || '', "単元1": foundRowData[dbCols.UNIT1 - 1] || '',
      "2校時": foundRowData[dbCols.PERIOD2 - 1] || '', "単元2": foundRowData[dbCols.UNIT2 - 1] || '',
      "3校時": foundRowData[dbCols.PERIOD3 - 1] || '', "単元3": foundRowData[dbCols.UNIT3 - 1] || '',
      "4校時": foundRowData[dbCols.PERIOD4 - 1] || '', "単元4": foundRowData[dbCols.UNIT4 - 1] || '',
      "5校時": foundRowData[dbCols.PERIOD5 - 1] || '', "単元5": foundRowData[dbCols.UNIT5 - 1] || '',
      "6校時": foundRowData[dbCols.PERIOD6 - 1] || '', "単元6": foundRowData[dbCols.UNIT6 - 1] || '',
      "宿題": foundRowData[dbCols.HOMEWORK - 1] || '', "持ち物": foundRowData[dbCols.ITEMS - 1] || ''
    };

    let postText = `${formattedDateString} の予定\n\n`;
    if (schedule["朝学習"]) postText += `朝学習：${schedule["朝学習"]}\n`;
    if (schedule["1校時"]) postText += `１時間目：${schedule["1校時"]} 「${schedule["単元1"] || ''}」\n`;
    if (schedule["2校時"]) postText += `２時間目：${schedule["2校時"]} 「${schedule["単元2"] || ''}」\n`;
    if (schedule["3校時"]) postText += `３時間目：${schedule["3校時"]} 「${schedule["単元3"] || ''}」\n`;
    if (schedule["4校時"]) postText += `４時間目：${schedule["4校時"]} 「${schedule["単元4"] || ''}」\n`;
    if (schedule["5校時"]) postText += `５時間目：${schedule["5校時"]} 「${schedule["単元5"] || ''}」\n`;
    if (schedule["6校時"]) postText += `６時間目：${schedule["6校時"]} 「${schedule["単元6"] || ''}」\n`;
    if (schedule["宿題"]) postText += `\n課題：\n${schedule["宿題"]}\n`;
    if (schedule["持ち物"]) postText += `\n持ち物：\n${schedule["持ち物"]}\n`;

    Classroom.Courses.Announcements.create({ text: postText.trim() }, courseId);
    logInfo(`クラス「${courseName}」へ予定投稿完了`);
  } catch (error) {
    logError("postScheduleToClassroom", error);
  }
}

/** 
 * 指定されたクラス名から、Google ClassroomのコースIDを探し出します。 
 */
function getCourseIdByName(courseName) {
  try {
    const cache = CacheService.getScriptCache();
    const cacheKey = `courseId_${courseName}`;
    const cachedId = cache.get(cacheKey);
    if (cachedId) return cachedId;

    let pageToken = null;
    do {
      const response = Classroom.Courses.list({ pageSize: 100, courseStates: ['ACTIVE'], pageToken: pageToken });
      if (response.courses) {
        const course = response.courses.find(c => c.name === courseName);
        if (course) {
          cache.put(cacheKey, course.id, 21600); // 6時間キャッシュ
          return course.id;
        }
      }
      pageToken = response.nextPageToken;
    } while (pageToken);
    throw new Error(`クラス「${courseName}」が見つかりません`);
  } catch (e) {
    logError("getCourseIdByName", e);
    throw e;
  }
}

/** 
 * 「学級通信」シートをPDF化し、Google Classroomに投稿する一連の処理を実行します。 
 */
function autoPostToClassroom() {
  try {
    // 設定はスクリプトプロパティ経由で取得
    const classroomName = getCourseNameSafe_();
    const pdfFile = createAndSavePDF(SHEET_NAME_NEWSLETTER);
    if (!pdfFile) throw new Error("PDF作成/保存失敗");
    postToClassroomStream(classroomName, pdfFile);
    logInfo(`「${SHEET_NAME_NEWSLETTER}」PDFをクラス「${classroomName}」に投稿完了`);
  } catch (error) {
    logError("autoPostToClassroom", error);
  }
}

/** 
 * 指定されたシートをPDFとしてGoogleドライブに保存します。 
 */
function createAndSavePDF(sheetName) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) throw new Error(`シート「${sheetName}」見つからず`);
    const formattedDate = Utilities.formatDate(new Date(), "JST", "yyyyMMdd");
    const pdfFileName = `${sheetName}_${formattedDate}.pdf`;
    const url = `https://docs.google.com/spreadsheets/d/${ss.getId()}/export?` +
      `exportFormat=pdf&format=pdf&size=A4&portrait=true&fitToPage=true&gridlines=false&gid=${sheet.getSheetId()}`;
    const blob = UrlFetchApp.fetch(url, { headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() } }).getBlob().setName(pdfFileName);
    const folder = DriveApp.getRootFolder(); // TODO: 必要に応じて保存先フォルダを変更可能にする
    const existingFiles = folder.getFilesByName(pdfFileName);
    while (existingFiles.hasNext()) { existingFiles.next().setTrashed(true); }
    const file = folder.createFile(blob);
    logInfo(`PDF「${pdfFileName}」保存完了 (ID: ${file.getId()})`);
    return file;
  } catch (e) {
    logError(`createAndSavePDF (${sheetName})`, e);
    return null;
  }
}

/** 
 * 指定されたPDFファイルを、Google Classroomのストリームに投稿します。 
 */
function postToClassroomStream(classroomName, pdfFile) {
  try {
    const courseId = getCourseIdByName(classroomName);
    const announcement = { text: '学級通信', materials: [{ driveFile: { driveFile: { id: pdfFile.getId() } } }] };
    Classroom.Courses.Announcements.create(announcement, courseId);
    logInfo(`PDF(${pdfFile.getName()})をクラス「${classroomName}」に投稿`);
  } catch (e) {
    logError("postToClassroomStream", e);
    throw e;
  }
}
