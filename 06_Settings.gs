/**
 * @fileoverview 設定ダッシュボードのバックエンドAPI
 *
 * すべての設定はスクリプトプロパティに保存・読み取りされます。
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

    const getVal = (spKey) => {
      return props.getProperty(spKey) || '';
    };

    const apiKey = getVal(SP_KEY_GEMINI_API_KEY);

    return {
      courseName       : getVal(SP_KEY_COURSE_NAME),
      postHour         : getVal(SP_KEY_POST_HOUR),
      pdfFolderId      : getVal(SP_KEY_PDF_FOLDER_ID),
      eventPdfFolderId : getVal(SP_KEY_EVENT_PDF_FOLDER_ID),
      // APIキーは冒頭4文字だけ見せてマスク（セキュリティのため）
      geminiApiKey     : apiKey ? apiKey.substring(0, 4) + '••••••••••••••••••••' : '',
      geminiModelName  : props.getProperty(SP_KEY_GEMINI_MODEL_NAME) || 'gemini-1.5-flash',
      grade            : props.getProperty(SCRIPT_PROP_GRADE) || '3',
      moduleEnabled    : props.getProperty('moduleEnabled') === 'true'
    };
  } catch(e) {
    logError('getAppSettings', e);
    throw new Error(e.message);
  }
}

/**
 * [Web API] Webアプリから受け取った設定を保存します。
 * @param {Object} settings HTMLからの設定オブジェクト
 */
function saveAppSettings(settings) {
  try {
    const props = PropertiesService.getScriptProperties();

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
    props.setProperties(propsToSave, false);

    // モジュール学習設定
    props.setProperty('moduleEnabled', settings.moduleEnabled ? 'true' : 'false');

    // 自動投稿トリガーを時刻設定に基づいて更新（時刻が指定されている場合のみ）
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
// ====================================================

/**
 * 設定値をスクリプトプロパティから取得します。
 * @param {string} spKey スクリプトプロパティのキー
 * @returns {string} 設定値
 */
function getSetting(spKey) {
  const props = PropertiesService.getScriptProperties();
  return props.getProperty(spKey) || '';
}

/**
 * Gemini API キーを安全に取得します。
 * @returns {string} APIキー
 */
function getApiKeySafe_() {
  const key = getSetting(SP_KEY_GEMINI_API_KEY);
  if (!key) throw new Error('Gemini APIキーが設定されていません。設定ダッシュボードから設定してください。');
  return key;
}

/**
 * Classroom 連携用のコース名を安全に取得します。
 * @returns {string} コース名
 */
function getCourseNameSafe_() {
  const name = getSetting(SP_KEY_COURSE_NAME);
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
