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
    // 個人設定はユーザー別プロパティから読む（tGetProp_: UserProperties→ScriptPropertiesの順）
    const getVal = (spKey) => {
      return tGetProp_(spKey) || '';
    };

    const apiKey = getVal(SP_KEY_GEMINI_API_KEY);

    return {
      courseName       : getVal(SP_KEY_COURSE_NAME),
      postHour         : getVal(SP_KEY_POST_HOUR),
      // APIキーは先頭2文字＋末尾2文字のみ表示し中央をマスク（肩越しの覗き見対策）。
      // マスク文字「•」を含むため、保存時に既存キーが保持される（saveAppSettings 参照）。
      geminiApiKey     : apiKey
        ? (apiKey.length > 8
            ? apiKey.slice(0, 2) + '••••••••••••••••' + apiKey.slice(-2)
            : '••••••••')
        : '',
      geminiModelName  : getVal(SP_KEY_GEMINI_MODEL_NAME) || 'gemini-2.5-flash',
      grade            : getVal(SCRIPT_PROP_GRADE) || '3',
      moduleEnabled    : tGetProp_('moduleEnabled') === 'true'
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
    if (!settings || typeof settings !== 'object') {
      throw new Error('設定データが不正です。');
    }

    // 投稿時刻のバリデーション
    if (settings.postHour !== undefined && settings.postHour !== '') {
      const hour = parseInt(settings.postHour, 10);
      if (isNaN(hour) || hour < 0 || hour > 23 || !Number.isInteger(hour)) {
        throw new Error('投稿時刻は0〜23の整数で指定してください。');
      }
    }

    const propsToSave = {
      [SP_KEY_COURSE_NAME]         : settings.courseName       || '',
      [SP_KEY_POST_HOUR]           : settings.postHour         || '',
      [SP_KEY_GEMINI_MODEL_NAME]   : settings.geminiModelName  || 'gemini-2.5-flash',
    };

    // APIキーはマスク文字（「•」）が含まれる場合は既存値を保持、新しい値なら上書き
    const newApiKey = settings.geminiApiKey || '';
    if (newApiKey && !newApiKey.includes('•')) {
      propsToSave[SP_KEY_GEMINI_API_KEY] = newApiKey;
    }
    // 個人設定はユーザー別プロパティへ保存
    tSetProps_(propsToSave);

    // モジュール学習設定
    tSetProp_('moduleEnabled', settings.moduleEnabled ? 'true' : 'false');

    // 自動投稿トリガーを時刻設定に基づいて更新
    const postHour = parseInt(settings.postHour, 10);
    if (!isNaN(postHour) && postHour >= 0 && postHour <= 23) {
      deleteTriggers_('postScheduleToClassroom');
      ScriptApp.newTrigger('postScheduleToClassroom').timeBased().everyDays(1).atHour(postHour).create();
      logInfo(`自動投稿トリガーを設定: 毎日${postHour}時`);
    } else if (settings.postHour === '') {
      // 時刻を空にして保存した場合は自動投稿を停止する（従来は古いトリガーが残り続けていた）
      deleteTriggers_('postScheduleToClassroom');
      logInfo('自動投稿時刻が未設定のため、自動投稿トリガーを解除しました');
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
    throw new Error(describeAuthError_(e, 'Google Classroom 連携'));
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
  // 個人設定はユーザー別プロパティから読む（UserProperties→ScriptPropertiesの順）
  return tGetProp_(spKey) || '';
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
 * @returns {string} モデル名（デフォルト 'gemini-2.5-flash'）
 */
function getGeminiModelNameSafe_() {
  return getSetting(SP_KEY_GEMINI_MODEL_NAME) || 'gemini-2.5-flash';
}

/**
 * [Web API] Gemini APIから利用可能なモデル一覧を取得します。
 * generateContent をサポートするモデルのみ返します。
 * @returns {Object} { success: boolean, models: Array<{name: string, displayName: string}>, error?: string }
 */
function getAvailableGeminiModels() {
  try {
    const apiKey = getSetting(SP_KEY_GEMINI_API_KEY);
    if (!apiKey) {
      return { success: false, models: [], error: 'Gemini APIキーが設定されていません。' };
    }

    // パフォーマンス: モデル一覧を1時間キャッシュ
    const cache = CacheService.getScriptCache();
    const cachedModels = cache.get('geminiModelList');
    if (cachedModels) {
      return { success: true, models: JSON.parse(cachedModels) };
    }

    const allModels = [];
    let pageToken = '';
    do {
      let url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + apiKey + '&pageSize=100';
      if (pageToken) {
        url += '&pageToken=' + pageToken;
      }
      const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      const code = response.getResponseCode();
      if (code !== 200) {
        const errBody = JSON.parse(response.getContentText());
        const errMsg = (errBody.error && errBody.error.message) || 'HTTP ' + code;
        return { success: false, models: [], error: 'モデル一覧の取得に失敗しました: ' + errMsg };
      }
      const data = JSON.parse(response.getContentText());
      if (data.models) {
        allModels.push(...data.models);
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);

    // generateContent をサポートするモデルだけに絞る
    const filtered = allModels
      .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
      .map(m => ({
        name: m.name.replace('models/', ''),
        displayName: m.displayName || m.name.replace('models/', '')
      }));

    // 1時間キャッシュ（CacheServiceの最大6時間だが、1時間で十分）
    cache.put('geminiModelList', JSON.stringify(filtered), 3600);
    return { success: true, models: filtered };
  } catch (e) {
    logError('getAvailableGeminiModels', e);
    return { success: false, models: [], error: e.message };
  }
}

// ====================================================
// ===== 初期設定ウィザード API =====
// ====================================================

// ウィザード完了フラグのスクリプトプロパティキー
const SP_KEY_SETUP_WIZARD_DONE = 'sp_setupWizardDone';

/**
 * [Web API] 初期設定の進捗状況を返します。
 * 初回起動時にウィザードを自動表示するかどうかの判定と、
 * ウィザード内の「設定済み」チェック表示に使用します。
 * @returns {Object} 各設定項目の設定済みフラグ
 */
function getSetupStatus() {
  try {
    // データベースシートに日付行（年間カレンダー）が構築済みかを確認
    let hasCalendar = false;
    try {
      const ss = getSs_();
      const dbSheet = getDbSheet_(ss);
      if (dbSheet && dbSheet.getLastRow() > 1) {
        const dbCols = getDbColumns();
        const rowsToCheck = Math.min(30, dbSheet.getLastRow() - 1);
        const vals = dbSheet.getRange(2, dbCols.DATE, rowsToCheck, 1).getValues();
        hasCalendar = vals.some(r => r[0] instanceof Date);
      }
    } catch (e) {
      // データベースシート未整備の場合は未構築として扱う
    }

    return {
      success: true,
      wizardDone: tGetProp_(SP_KEY_SETUP_WIZARD_DONE) === 'true',
      hasApiKey: !!tGetProp_(SP_KEY_GEMINI_API_KEY),
      hasGrade: !!tGetProp_(SCRIPT_PROP_GRADE),
      hasCourseName: !!tGetProp_(SP_KEY_COURSE_NAME),
      hasCalendar: hasCalendar
    };
  } catch (e) {
    logError('getSetupStatus', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Web API] 初期設定ウィザードを完了（今後自動表示しない）としてマークします。
 */
function markSetupWizardDone() {
  try {
    tSetProp_(SP_KEY_SETUP_WIZARD_DONE, 'true');
    return { success: true };
  } catch (e) {
    logError('markSetupWizardDone', e);
    return { success: false, error: e.message };
  }
}
