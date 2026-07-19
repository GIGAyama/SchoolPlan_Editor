/**
 * @fileoverview マルチテナント基盤：ログインユーザーごとに自分のスプレッドシート(DB)を
 * 紐付け／新規作成するための解決ロジックとオンボーディングAPI。
 *
 * 設計方針:
 *  - 各ユーザーの対象スプレッドシートIDは UserProperties に保存する（Googleアカウント単位で分離）。
 *  - Web App を「アクセスしているユーザーとして実行」でデプロイすると、UserProperties は
 *    自動的にユーザーごとに分かれ、各自のDrive上のスプレッドシートを本人所有で扱える。
 *    → 共通URLからログインするだけで、各自のDBに紐付く／新規作成できる構成の土台。
 *  - 後方互換: バインド型／既存デプロイでは従来どおり ScriptProperties の 'SPREADSHEET_ID'
 *    にフォールバックするため、本モジュール導入後も既存環境の動作は変わらない。
 */

// UserProperties: このユーザーの対象スプレッドシートID
const UP_KEY_SPREADSHEET_ID = 'up_spreadsheetId';
// ScriptProperties: 従来のグローバル紐付けキー（後方互換）。01_Main.gs / doGet が記録する。
const SP_KEY_LEGACY_SPREADSHEET_ID = 'SPREADSHEET_ID';
// ScriptProperties: 新規DB作成時に複製するテンプレートのスプレッドシートID（配布元が設定）
const SP_KEY_DB_TEMPLATE_ID = 'sp_dbTemplateId';

/**
 * このユーザー個別の対象スプレッドシートIDを取得します（未設定なら空文字）。
 * @returns {string}
 */
function getUserSpreadsheetId_() {
  try {
    return PropertiesService.getUserProperties().getProperty(UP_KEY_SPREADSHEET_ID) || '';
  } catch (e) {
    return '';
  }
}

/**
 * このユーザー個別の対象スプレッドシートIDを保存します。
 * @param {string} id スプレッドシートID
 */
function setUserSpreadsheetId_(id) {
  PropertiesService.getUserProperties().setProperty(UP_KEY_SPREADSHEET_ID, String(id));
}

/**
 * このユーザー個別の対象スプレッドシートIDを削除します（データ自体は削除しません）。
 */
function clearUserSpreadsheetId_() {
  try {
    PropertiesService.getUserProperties().deleteProperty(UP_KEY_SPREADSHEET_ID);
  } catch (e) { /* 未設定時は無視 */ }
}

/**
 * 従来のグローバル紐付けID（ScriptProperties）を取得します（後方互換）。
 * @returns {string}
 */
function getLegacySpreadsheetId_() {
  try {
    return PropertiesService.getScriptProperties().getProperty(SP_KEY_LEGACY_SPREADSHEET_ID) || '';
  } catch (e) {
    return '';
  }
}

/**
 * このユーザーが使用すべきスプレッドシートIDを解決します。
 * 優先順位: ユーザー個別(UserProperties) → 従来のグローバル(ScriptProperties)。
 * どちらも無ければ空文字（オンボーディング未完了）を返します。
 * @returns {string}
 */
function resolveSpreadsheetId_() {
  return getUserSpreadsheetId_() || getLegacySpreadsheetId_();
}

/**
 * スプレッドシートのURLまたは生IDから、スプレッドシートIDを取り出します。
 * @param {string} input URL もしくは ID
 * @returns {string} 抽出したID（取り出せない場合は空文字）
 */
function extractSpreadsheetId_(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9\-_]+)/);
  if (m) return m[1];
  // URLでない生IDとみなせる形式か
  if (/^[a-zA-Z0-9\-_]{20,}$/.test(s)) return s;
  return '';
}

/**
 * [Web API] 現在のユーザーのテナント状態を返します。
 * フロントは初期化時にこれを見て、オンボーディング画面と通常アプリのどちらを出すか判断します。
 * @returns {Object} { success, linked, spreadsheetId, spreadsheetName, email, canCreate }
 */
function getTenantStatus() {
  try {
    const id = resolveSpreadsheetId_();
    let linked = false;
    let name = '';
    if (id) {
      try {
        const ss = SpreadsheetApp.openById(id);
        name = ss.getName();
        linked = true;
      } catch (openErr) {
        // アクセス権が無い／削除された等でIDが無効。オンボーディングを促す。
        linked = false;
      }
    }
    let email = '';
    try { email = Session.getActiveUser().getEmail() || ''; } catch (e) { /* 権限未付与時は空 */ }

    const templateConfigured = !!PropertiesService.getScriptProperties().getProperty(SP_KEY_DB_TEMPLATE_ID);

    return {
      success: true,
      linked: linked,
      spreadsheetId: linked ? id : '',
      spreadsheetName: name,
      email: email,
      canCreate: templateConfigured
    };
  } catch (e) {
    logError('getTenantStatus', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Web API] 既存のスプレッドシートを、このユーザーのDBとして紐付けます。
 * @param {string} input スプレッドシートのURLまたはID
 * @returns {Object} { success, spreadsheetId, spreadsheetName, hasDatabaseSheet, warning } / { success:false, error }
 */
function linkMyDatabase(input) {
  try {
    const id = extractSpreadsheetId_(input);
    if (!id) throw new Error('スプレッドシートのURLまたはIDが正しくありません。');

    let ss;
    try {
      ss = SpreadsheetApp.openById(id);
    } catch (openErr) {
      throw new Error('スプレッドシートを開けませんでした。URLが正しいか、このGoogleアカウントにアクセス権があるかを確認してください。');
    }

    // 「データベース」シートの有無を確認（無くても紐付けは許可するが警告を返す）
    const hasDb = !!ss.getSheetByName(SHEET_NAME_DATABASE);
    setUserSpreadsheetId_(id);
    logInfo('スプレッドシートを紐付けました: ' + id);

    return {
      success: true,
      spreadsheetId: id,
      spreadsheetName: ss.getName(),
      hasDatabaseSheet: hasDb,
      warning: hasDb ? '' : ('「' + SHEET_NAME_DATABASE + '」シートが見つかりません。テンプレートから作成したスプレッドシートを指定してください。')
    };
  } catch (e) {
    logError('linkMyDatabase', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Web API] テンプレートを複製して、このユーザー専用のDBを新規作成し紐付けます。
 * 配布元が ScriptProperties「sp_dbTemplateId」にテンプレートのスプレッドシートIDを設定し、
 * かつテンプレートが（利用者から）複製可能な共有設定である必要があります。
 * @param {string} [name] 作成するスプレッドシートの名前
 * @returns {Object} { success, spreadsheetId, spreadsheetName, url } / { success:false, error }
 */
function createMyDatabase(name) {
  const lock = LockService.getUserLock();
  try {
    lock.waitLock(10000);

    const templateId = PropertiesService.getScriptProperties().getProperty(SP_KEY_DB_TEMPLATE_ID);
    if (!templateId) {
      throw new Error('DBテンプレートが未設定です。配布元がスクリプトプロパティ「' + SP_KEY_DB_TEMPLATE_ID + '」にテンプレートのスプレッドシートIDを設定してください。');
    }

    const title = String(name || '').trim()
      || ('週案データベース（' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd') + '）');

    let copy;
    try {
      copy = DriveApp.getFileById(templateId).makeCopy(title);
    } catch (copyErr) {
      throw new Error('テンプレートの複製に失敗しました。テンプレートの共有設定（複製可能か）とIDを確認してください: ' + copyErr.message);
    }

    const newId = copy.getId();
    setUserSpreadsheetId_(newId);
    logInfo('テンプレートから新規DBを作成しました: ' + newId);

    return {
      success: true,
      spreadsheetId: newId,
      spreadsheetName: title,
      url: 'https://docs.google.com/spreadsheets/d/' + newId + '/edit'
    };
  } catch (e) {
    logError('createMyDatabase', e);
    return { success: false, error: e.message };
  } finally {
    try { lock.releaseLock(); } catch (e) { /* ロック未取得時は無視 */ }
  }
}

/**
 * [Web API] このユーザーのDB紐付けを解除します（スプレッドシート自体は削除しません）。
 * @returns {Object} { success } / { success:false, error }
 */
function unlinkMyDatabase() {
  try {
    clearUserSpreadsheetId_();
    logInfo('スプレッドシートの紐付けを解除しました。');
    return { success: true };
  } catch (e) {
    logError('unlinkMyDatabase', e);
    return { success: false, error: e.message };
  }
}
