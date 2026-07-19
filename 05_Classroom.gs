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
    postScheduleToClassroom_core_();
  } catch (error) {
    logError("postScheduleToClassroom", error);
  }
}

/**
 * [Webアプリ API] 「明日（次の登校日）の予定」をClassroomへ投稿します。
 * メニュー版（postScheduleToClassroom）と同一ロジックを用い、UIに依存せず結果を返します。
 * アプリのボタンからの手動投稿のため、本日が登校日でなくても（土日・休み中でも）投稿できます。
 * @returns {{success: boolean, posted: boolean, message: string}}
 */
function postScheduleToClassroomFromWeb() {
  try {
    return postScheduleToClassroom_core_({ manual: true });
  } catch (error) {
    logError("postScheduleToClassroomFromWeb", error);
    return { success: false, posted: false, message: describeAuthError_(error, 'Google Classroom 連携') };
  }
}

// 予定投稿の重複防止用ログ（スクリプトプロパティ）と保持期間
const SP_KEY_POSTED_SCHEDULE_LOG = 'sp_postedScheduleLog';
const POSTED_SCHEDULE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14日

/**
 * 指定の識別子が保持期間内に投稿済みかを判定します。
 * 判定に失敗した場合は false を返し、投稿を妨げません（フェイルオープン）。
 * @param {string} fingerprint コースID＋対象日の識別子
 * @returns {boolean}
 */
function hasRecentlyPostedSchedule_(fingerprint) {
  try {
    const raw = tGetProp_(SP_KEY_POSTED_SCHEDULE_LOG);
    if (!raw) return false;
    const log = JSON.parse(raw);
    const ts = log[fingerprint];
    return !!ts && (Date.now() - ts) < POSTED_SCHEDULE_TTL_MS;
  } catch (e) {
    return false;
  }
}

/**
 * 投稿済みの識別子を記録し、保持期間を過ぎた古いエントリを掃除します。
 * @param {string} fingerprint コースID＋対象日の識別子
 */
function recordPostedSchedule_(fingerprint) {
  try {
    let log = {};
    try { log = JSON.parse(tGetProp_(SP_KEY_POSTED_SCHEDULE_LOG) || '{}'); } catch (e) {}
    const now = Date.now();
    log[fingerprint] = now;
    Object.keys(log).forEach(k => { if (now - log[k] >= POSTED_SCHEDULE_TTL_MS) delete log[k]; });
    tSetProp_(SP_KEY_POSTED_SCHEDULE_LOG, JSON.stringify(log));
  } catch (e) {
    logError('recordPostedSchedule_', e);
  }
}

/**
 * 次の登校日の予定をClassroomへ投稿するコアロジック。
 * UI非依存。スキップ時/投稿時を表す結果オブジェクトを返し、異常時は例外を送出します。
 * @param {{manual?: boolean}} [options] manual=true のとき手動投稿として扱い、本日が登校日でなくても投稿する。
 *   自動投稿（既定）では、休み中の重複投稿を防ぐため本日が登校日のときのみ投稿する。
 * @returns {{success: boolean, posted: boolean, message: string}}
 */
function postScheduleToClassroom_core_(options) {
    const isManual = !!(options && options.manual);
    const ss = typeof getSs_ === 'function' ? getSs_() : SpreadsheetApp.getActiveSpreadsheet();
    const databaseSheet = getDbSheet_(ss);
    if (!databaseSheet) throw new Error("データベースシートが見つかりません");

    const courseName = getCourseNameSafe_();
    const courseId = getCourseIdByName(courseName);
    if (!courseId) throw new Error(`クラス「${courseName}」見つからず`);

    const dbCols = getDbColumns();
    const dbData = databaseSheet.getDataRange().getValues();

    const today = new Date();
    const daysOfWeek = ["日", "月", "火", "水", "木", "金", "土"];
    // 日付の比較・判定はすべて日本時間（JST）で行う。スプレッドシートやスクリプトの
    // タイムゾーン設定に依存せず、「次の日付」「今日の日付」が日本時間でずれないようにする。
    const jstDateKey_ = (d) => (d instanceof Date) ? Utilities.formatDate(d, "JST", "yyyyMMdd") : '';
    const jstDow_ = (d) => parseInt(Utilities.formatDate(d, "JST", "u"), 10) % 7; // u:1=月..7=日 → %7で日=0
    const jstLabel_ = (d) => `${Utilities.formatDate(d, "JST", "yyyy/MM/dd")}（${daysOfWeek[jstDow_(d)]}）`;
    const todayKey = jstDateKey_(today);

    // 本日（日本時間）が登校日（1校時に予定あり）かを判定する。本日の行データも保持し、
    // 「きょうのかだい」「今日の様子」の生成に用いる。
    let todayRowData = null;
    dbData.forEach(row => {
      if (row[dbCols.DATE - 1] instanceof Date && jstDateKey_(row[dbCols.DATE - 1]) === todayKey && row[dbCols.PERIOD1 - 1]) {
        todayRowData = row;
      }
    });

    // 自動投稿では、休み中は投稿しない。休みに入る前の最終登校日に休み明けの予定を投稿済みのため、
    // ここで投稿すると同じ予定が重複して投稿されてしまう。
    // 一方、アプリのボタンからの手動投稿（isManual）は、土日・休み中でも投稿できるようこの判定をスキップする。
    if (!isManual && !todayRowData) {
      Logger.log(`本日は登校日ではないため自動投稿をスキップ`);
      return { success: true, posted: false, message: '本日は登校日ではないため投稿をスキップしました。' };
    }

    // 本日（日本時間）より後で、1校時に予定が入っている最も近い登校日を探す。
    // これにより休みを挟む場合でも、休み直前の登校日に次の登校日分が投稿される
    // （例：金曜日に翌週月曜日の予定を投稿）。
    let foundRowData = null;
    let foundKey = null;
    dbData.forEach(row => {
      const cellDate = row[dbCols.DATE - 1];
      if (!(cellDate instanceof Date) || !row[dbCols.PERIOD1 - 1]) return;
      const key = jstDateKey_(cellDate); // yyyyMMdd は文字列比較で日付の前後比較が成立する
      if (key > todayKey && (foundKey === null || key < foundKey)) {
        foundKey = key;
        foundRowData = row;
      }
    });

    if (!foundRowData) {
      Logger.log(`次の登校日の予定が見つからずスキップ`);
      return { success: true, posted: false, message: '次の登校日の予定が見つからないため投稿をスキップしました。' };
    }

    const targetDate = foundRowData[dbCols.DATE - 1];
    const formattedDateString = jstLabel_(targetDate);

    // 次の登校日（あした）の行から値を取得するヘルパー。
    const nextCell = (key) => (dbCols[key] ? (foundRowData[dbCols[key] - 1] || '').toString().trim() : '');
    // 本日（きょう）の行から値を取得するヘルパー。本日の行が無い場合は空文字。
    const todayCell = (key) => (dbCols[key] && todayRowData ? (todayRowData[dbCols[key] - 1] || '').toString().trim() : '');

    // 「あしたのよてい📅」: 次の登校日の行事・朝学習・1〜6校時の教科名と単元名
    let postText = `あしたのよてい📅（${formattedDateString}）\n\n`;
    const event = nextCell('EVENT');
    if (event) postText += `行事：${event}\n`;
    const morning = nextCell('MORNING');
    if (morning) postText += `朝学習：${morning}\n`;
    const periodLabels = ['１', '２', '３', '４', '５', '６'];
    for (let n = 1; n <= 6; n++) {
      const subject = nextCell('PERIOD' + n);
      if (!subject) continue;
      const unit = nextCell('UNIT' + n);
      postText += `${periodLabels[n - 1]}時間目：${subject}` + (unit ? `「${unit}」` : '') + `\n`;
    }

    // 「きょうのかだい🏚️」: 本日の行の課題をリストアップ
    const homeworkItems = listifyCellText_(todayCell('HOMEWORK'));
    if (homeworkItems.length) {
      postText += `\nきょうのかだい🏚️\n`;
      homeworkItems.forEach(h => { postText += `・${h}\n`; });
    }

    // 「もちもの✏️」: 次の登校日（あした）の行の持ち物をリストアップ
    const itemList = listifyCellText_(nextCell('ITEMS'));
    if (itemList.length) {
      postText += `\nもちもの✏️\n`;
      itemList.forEach(it => { postText += `・${it}\n`; });
    }

    // 担当学年が1年生の場合は、予定部分の漢字をすべてひらがなに自動変換する（子どもが自分で読めるように）。
    // Gemini未設定・変換失敗時は convertTextToHiragana_ が元の文章を返すため、投稿処理は継続する。
    const grade = parseInt(tGetProp_(SCRIPT_PROP_GRADE), 10);
    if (grade === 1 && typeof convertTextToHiragana_ === 'function') {
      postText = convertTextToHiragana_(postText);
    }

    // 「今日の様子」を本日（日本時間）の学習予定からGeminiで自動生成し、保護者向けに追記する。
    // 漢字変換後に追記するため、このセクションは全学年で通常の漢字表記のまま（保護者が読む想定）。
    // Gemini未設定・生成失敗時はこのセクションを省略し、予定の投稿は継続する。
    try {
      const todayLessonContext = buildLessonContext_(todayRowData, dbCols);
      if (todayLessonContext && typeof generateTodaySituationText_ === 'function') {
        const todayLabel = jstLabel_(today);
        const situation = generateTodaySituationText_(todayLabel, todayLessonContext);
        if (situation) postText += `\n【今日の様子】\n${situation}\n`;
      }
    } catch (situationErr) {
      logError("postScheduleToClassroom_core_ (今日の様子)", situationErr);
    }

    // 重複投稿の防止: 「コースID＋対象日」を識別子にする。本文には毎回変動する
    // AI生成「今日の様子」が含まれるため、安定した対象日で判定する。
    // 自動投稿で同一対象日が投稿済みならスキップ。手動投稿（教員の明示操作）は常に投稿する。
    const fingerprint = `${courseId}|${Utilities.formatDate(targetDate, "JST", "yyyyMMdd")}`;
    if (!isManual && hasRecentlyPostedSchedule_(fingerprint)) {
      Logger.log(`同一対象日の予定が投稿済みのため重複投稿をスキップ: ${formattedDateString}`);
      return { success: true, posted: false, message: `${formattedDateString} の予定は既に投稿済みのためスキップしました。` };
    }

    Classroom.Courses.Announcements.create({ text: postText.trim() }, courseId);
    recordPostedSchedule_(fingerprint);
    logInfo(`クラス「${courseName}」へ予定投稿完了`);
    return { success: true, posted: true, message: `クラス「${courseName}」へ ${formattedDateString} の予定を投稿しました。` };
}

/**
 * セル内のテキストを、リスト表示用の項目配列に分割します。
 * まず改行で分割し、1項目に収まる場合は読点（、，）やカンマ（,）でも分割します。
 * 空要素は取り除きます。
 * @param {*} value セルの値
 * @returns {string[]} 項目の配列（空のときは空配列）
 */
function listifyCellText_(value) {
  const raw = (value == null ? '' : value).toString().trim();
  if (!raw) return [];
  let parts = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (parts.length <= 1) {
    parts = raw.split(/[、，,]/).map(s => s.trim()).filter(Boolean);
  }
  return parts;
}

/**
 * 1日分の行データから、AIに渡す授業内容のコンテキスト文字列を組み立てます。
 * 行事・朝学習・1〜6校時（教科・単元・学習内容）をまとめたテキストを返します。
 * @param {Array} rowData データベースの1行分の配列
 * @param {Object} dbCols getDbColumns() の列マップ（1始まり）
 * @returns {string} 授業内容のコンテキスト（空の場合は空文字）
 */
function buildLessonContext_(rowData, dbCols) {
  if (!rowData) return '';
  const cell = (key) => (dbCols[key] ? (rowData[dbCols[key] - 1] || '').toString().trim() : '');

  let ctx = '';
  const event = cell('EVENT');
  if (event) ctx += `行事: ${event}\n`;
  const morning = cell('MORNING');
  if (morning) ctx += `朝学習: ${morning}\n`;

  for (let n = 1; n <= 6; n++) {
    const subject = cell('PERIOD' + n);
    if (!subject) continue;
    const unit = cell('UNIT' + n);
    const content = cell('CONTENT' + n);
    let line = `${n}時間目: ${subject}`;
    if (unit) line += ` 「${unit}」`;
    if (content) line += ` ${content}`;
    ctx += line + '\n';
  }
  return ctx.trim();
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
    autoPostToClassroom_core_();
  } catch (error) {
    logError("autoPostToClassroom", error);
  }
}

/**
 * [Webアプリ API] 「学級通信」シートをPDF化しClassroomへ投稿します（UI非依存・結果を返す）。
 * @returns {{success: boolean, message: string}}
 */
function autoPostToClassroomFromWeb() {
  try {
    const r = autoPostToClassroom_core_();
    return { success: true, message: r.message };
  } catch (error) {
    logError("autoPostToClassroomFromWeb", error);
    return { success: false, message: error.message };
  }
}

/**
 * 「学級通信」シートをPDF化してClassroomへ投稿するコアロジック。
 * @returns {{message: string}}
 */
function autoPostToClassroom_core_() {
    // 設定はスクリプトプロパティ経由で取得
    const classroomName = getCourseNameSafe_();
    const pdfFile = createAndSavePDF(SHEET_NAME_NEWSLETTER);
    if (!pdfFile) throw new Error("PDF作成/保存失敗");
    postToClassroomStream(classroomName, pdfFile);
    logInfo(`「${SHEET_NAME_NEWSLETTER}」PDFをクラス「${classroomName}」に投稿完了`);
    return { message: `「${SHEET_NAME_NEWSLETTER}」のPDFをクラス「${classroomName}」へ投稿しました。` };
}

/**
 * [Webアプリ API] 連携可能なClassroomクラスの一覧を取得します（UI非依存・結果を返す）。
 * メニュー版 listCoursesToSheet のWeb対応版。
 * @returns {{success: boolean, message: string, courses: string[]}}
 */
function listCoursesFromWeb() {
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

    const names = courses.map(c => c.name);
    logInfo('クラス一覧(Web): ' + names.join(', '));
    return {
      success: true,
      courses: names,
      message: names.length ? `${names.length}件のクラスを取得しました。` : '有効なクラスが見つかりませんでした。'
    };
  } catch (e) {
    logError("listCoursesFromWeb", e);
    return { success: false, courses: [], message: `クラス一覧取得エラー: ${e.message}` };
  }
}

/** 
 * 指定されたシートをPDFとしてGoogleドライブに保存します。 
 */
function createAndSavePDF(sheetName) {
  try {
    const ss = typeof getSs_ === 'function' ? getSs_() : SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) throw new Error(`シート「${sheetName}」見つからず`);
    const formattedDate = Utilities.formatDate(new Date(), "JST", "yyyyMMdd");
    const pdfFileName = `${sheetName}_${formattedDate}.pdf`;
    const url = `https://docs.google.com/spreadsheets/d/${ss.getId()}/export?` +
      `exportFormat=pdf&format=pdf&size=A4&portrait=true&fitToPage=true&gridlines=false&gid=${sheet.getSheetId()}`;
    const blob = UrlFetchApp.fetch(url, { headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() } }).getBlob().setName(pdfFileName);
    // drive.file 運用: getRootFolder() ではなくトップレベルの DriveApp API を使う
    // （createFile は My Drive 直下にアプリ所有ファイルを作成、検索はアプリ作成物のみが対象）。
    const existingFiles = DriveApp.getFilesByName(pdfFileName);
    while (existingFiles.hasNext()) { existingFiles.next().setTrashed(true); }
    const file = DriveApp.createFile(blob);
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
