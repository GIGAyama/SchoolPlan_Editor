/**
 * @fileoverview 初期設定ダッシュボード (Phase 3 Step 1)
 * 
 * このファイルは「初期設定シート」への直接依存を段階的に排除し、
 * スクリプトプロパティ（セキュアな領域）を設定の主要保存先とするための
 * バックエンドAPIを提供します。
 * 
 * ★ 移行戦略：
 * 　保存時はスクリプトプロパティと「初期設定」シートの両方に書き込みます。
 * 　これにより、他シートからのセル参照（INDIRECT等）を壊さずに、
 * 　最終的に「初期設定」シートを完全に削除するための移行期間を設けます。
 */

// スクリプトプロパティのキー定義
const SP_KEY_COURSE_NAME        = 'sp_courseName';
const SP_KEY_POST_HOUR          = 'sp_postHour';
const SP_KEY_PDF_FOLDER_ID      = 'sp_pdfFolderId';
const SP_KEY_EVENT_PDF_FOLDER_ID = 'sp_eventPdfFolderId';
const SP_KEY_GEMINI_API_KEY     = 'sp_geminiApiKey';
const SP_KEY_GEMINI_MODEL_NAME  = 'sp_geminiModelName';



/**
 * [Web API] 現在のすべての設定値を取得してWebアプリへ返します。
 * APIキーはマスク表示にします。
 * @returns {Object} 設定値オブジェクト
 */
function getAppSettings() {
  try {
    const props = PropertiesService.getScriptProperties();

    // スクリプトプロパティを優先。なければ初期設定シートにフォールバック（移行期間中の互換性維持）
    const getVal = (spKey, sheetCell) => {
      const spVal = props.getProperty(spKey);
      if (spVal) return spVal;
      // シートからはフォールバックとして読み取る（Phase 3 移行期間のみ）
      try {
        const ss = SpreadsheetApp.getActiveSpreadsheet();
        const settingSheet = ss.getSheetByName(SHEET_NAME_SETTINGS);
        if (settingSheet && sheetCell) return settingSheet.getRange(sheetCell).getValue().toString();
      } catch(e) {}
      return '';
    };

    const apiKey = getVal(SP_KEY_GEMINI_API_KEY, SETTINGS_CELL_GEMINI_API_KEY);

    return {
      courseName       : getVal(SP_KEY_COURSE_NAME, SETTINGS_CELL_COURSE_NAME),
      postHour         : getVal(SP_KEY_POST_HOUR, null),
      pdfFolderId      : getVal(SP_KEY_PDF_FOLDER_ID, SETTINGS_CELL_PDF_FOLDER_ID),
      eventPdfFolderId : getVal(SP_KEY_EVENT_PDF_FOLDER_ID, SETTINGS_CELL_EVENT_PDF_FOLDER_ID),
      // APIキーは冒頭4文字だけ見せてマスク（セキュリティのため）
      geminiApiKey     : apiKey ? apiKey.substring(0, 4) + '••••••••••••••••••••' : '',
      geminiModelName  : props.getProperty(SP_KEY_GEMINI_MODEL_NAME) || 'gemini-1.5-flash', // デフォルト
      grade            : props.getProperty(SCRIPT_PROP_GRADE) || '3'
    };
  } catch(e) {
    logError('getAppSettings', e);
    throw new Error(e.message);
  }
}

/**
 * [Web API] Webアプリから受け取った設定を保存します。
 * スクリプトプロパティと「初期設定」シートの両方に同期書き込みします。
 * @param {Object} settings HTMLからの設定オブジェクト
 */
function saveAppSettings(settings) {
  try {
    const props = PropertiesService.getScriptProperties();

    // 1. スクリプトプロパティへ保存（主要保存先）
    const propsToSave = {
      [SP_KEY_COURSE_NAME]         : settings.courseName       || '',
      [SP_KEY_POST_HOUR]           : settings.postHour         || '',
      [SP_KEY_PDF_FOLDER_ID]       : settings.pdfFolderId      || '',
      [SP_KEY_EVENT_PDF_FOLDER_ID] : settings.eventPdfFolderId || '',
      [SP_KEY_GEMINI_MODEL_NAME]   : settings.geminiModelName  || 'gemini-1.5-flash',
    };

    // APIキーはマスク文字（「•」）が含まれる場合は既存値を保持、新しい値なら上書き
    const newApiKey = settings.geminiApiKey || '';
    if (newApiKey && !newApiKey.includes('•')) {
      propsToSave[SP_KEY_GEMINI_API_KEY] = newApiKey;
    }
    props.setProperties(propsToSave, false); // falseにすると既存プロパティを消さない

    // 2. 「初期設定」シートへのバックシンク（シートが残存する場合のみ。Phase 5以降はskip）
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const settingSheet = ss.getSheetByName(SHEET_NAME_SETTINGS);
      if (settingSheet) {
        settingSheet.getRange(SETTINGS_CELL_COURSE_NAME).setValue(settings.courseName || '');
        settingSheet.getRange(SETTINGS_CELL_PDF_FOLDER_ID).setValue(settings.pdfFolderId || '');
        settingSheet.getRange(SETTINGS_CELL_EVENT_PDF_FOLDER_ID).setValue(settings.eventPdfFolderId || '');
        if (newApiKey && !newApiKey.includes('•')) {
          settingSheet.getRange(SETTINGS_CELL_GEMINI_API_KEY).setValue(newApiKey);
        }
      }
    } catch(syncErr) {
      logInfo('初期設定シートへの同期はスキップ: ' + syncErr.message);
    }

    // 3. 自動投稿トリガーを時刻設定に基づいて更新（時刻が指定されている場合のみ）
    const postHour = parseInt(settings.postHour, 10);
    if (!isNaN(postHour) && postHour >= 0 && postHour <= 23) {
      deleteTriggers_('postScheduleToClassroom');
      ScriptApp.newTrigger('postScheduleToClassroom').timeBased().everyDays(1).atHour(postHour).create();
      logInfo(`自動投稿トリガーを設定: 毎日${postHour}時`);
    }

    logInfo('Webアプリから設定を保存しました。');
    return { success: true, message: '設定を保存しました。' };
  } catch(e) {
    logError('saveAppSettings', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Dashboard API] Classroom のコース一覧を取得してダッシュボードへ返します。
 * @returns {string[]} コース名の配列
 */
function getCourseListForDashboard() {
  try {
    let courses = [];
    let pageToken = null;
    do {
      const response = Classroom.Courses.list({ pageSize: 100, courseStates: ['ACTIVE'], pageToken: pageToken });
      if (response.courses) {
        courses = courses.concat(response.courses.map(c => c.name));
      }
      pageToken = response.nextPageToken;
    } while (pageToken);

    return courses;
  } catch(e) {
    logError('getCourseListForDashboard', e);
    throw new Error(e.message);
  }
}

// ====================================================
// ===== スクリプトプロパティからの設定読み取り API =====
// ===== （既存の初期設定シート読み取りロジックの置き換え）
// ====================================================

/**
 * 設定値を安全に取得します。
 * スクリプトプロパティを優先し、見つからない場合は「初期設定」シートにフォールバックします（移行期間中のみ）。
 * @param {string} spKey スクリプトプロパティのキー
 * @param {string} [sheetCell] フォールバック用のシートセルアドレス（例："B7"）
 * @returns {string} 設定値
 */
function getSetting(spKey, sheetCell) {
  const props = PropertiesService.getScriptProperties();
  const spVal = props.getProperty(spKey);
  if (spVal) return spVal;

  // フォールバック（移行期間中のみ）
  if (sheetCell) {
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const settingSheet = ss.getSheetByName(SHEET_NAME_SETTINGS);
      if (settingSheet) return settingSheet.getRange(sheetCell).getValue().toString();
    } catch(e) {}
  }
  return '';
}

/**
 * Gemini API キーを安全に取得します（既存 getApiKey_() の置き換え）。
 * @returns {string} APIキー
 */
function getApiKeySafe_() {
  const key = getSetting(SP_KEY_GEMINI_API_KEY, SETTINGS_CELL_GEMINI_API_KEY);
  if (!key) throw new Error('Gemini APIキーが設定されていません。「週案ツール」→「初期設定・その他」→「設定ダッシュボードを開く」から設定してください。');
  return key;
}

/**
 * Classroom 連携用のコース名を安全に取得します。
 * @returns {string} コース名
 */
function getCourseNameSafe_() {
  const name = getSetting(SP_KEY_COURSE_NAME, SETTINGS_CELL_COURSE_NAME);
  if (!name) throw new Error('連携クラス名が設定されていません。設定ダッシュボードから設定してください。');
  return name;
}

/**
 * Gemini APIのモデル名を安全に取得します。
 * @returns {string} モデル名（デフォルト 'gemini-1.5-flash'）
 */
function getGeminiModelNameSafe_() {
  const props = PropertiesService.getScriptProperties();
  const modelName = props.getProperty(SP_KEY_GEMINI_MODEL_NAME);
  return modelName || 'gemini-1.5-flash';
}
