/**
 * @fileoverview システム全体で使用する定数、設定値定義
 */

// --- シート名 ---
const SHEET_NAME_DATABASE = "データベース";
const SHEET_NAME_NEWSLETTER = "学級通信";
const SHEET_NAME_NEWSLETTER_DATA = "学級通信データ";
const SHEET_NAME_UNIT_MASTER = "単元マスタ";
const SHEET_NAME_LOG = "ログ";
const SHEET_NAME_TASK = "タスク";

// === スクリプトプロパティ & トリガー管理用 ===
// 担当学年
const SCRIPT_PROP_GRADE = 'targetGrade';

// 指導計画PDF用
const SCRIPT_PROP_PDF_QUEUE = 'pdfProcessingQueue';
const SCRIPT_PROP_PDF_TOTAL = 'pdfTotalCount';
const TRIGGER_FUNCTION_NAME = 'createUnitMasterFromPdfs';

// 行事予定PDF用
const SCRIPT_PROP_EVENT_PDF_QUEUE = 'eventPdfProcessingQueue';
const SCRIPT_PROP_EVENT_PDF_TOTAL = 'eventPdfTotalCount';
const SCRIPT_PROP_EVENT_PDF_YEAR = 'eventPdfProcessingYear';
const TRIGGER_FUNCTION_NAME_EVENT = 'processNextEventPdf';  


// === 複数学級モード（専科教員向け・設定でON/OFF） ===
// 有効にすると学級ごとに専用のデータベースシートを持ち、切り替えて使用できます。
// 無効（デフォルト）の場合は従来どおり単一の「データベース」シートを使用します。
const SCRIPT_PROP_MULTICLASS_ENABLED = 'sp_multiClassEnabled';
const SCRIPT_PROP_CLASS_LIST = 'sp_classList';          // JSON: [{name, sheetName, grade, standardHours}]
const SCRIPT_PROP_ACTIVE_CLASS = 'sp_activeClassSheet'; // アクティブ学級のシート名

/**
 * 複数学級モードが有効かを返します。
 * @returns {boolean}
 */
function isMultiClassEnabled_() {
  return PropertiesService.getScriptProperties().getProperty(SCRIPT_PROP_MULTICLASS_ENABLED) === 'true';
}

/**
 * 登録されている学級リストを返します（モード無効時は空配列）。
 * @returns {Array<{name: string, sheetName: string, grade: string|number, standardHours: ?Array}>}
 */
function getClassList_() {
  try {
    const json = PropertiesService.getScriptProperties().getProperty(SCRIPT_PROP_CLASS_LIST);
    const list = json ? JSON.parse(json) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

/**
 * 現在使用すべきデータベースシートを解決して返します。
 * 複数学級モードが有効ならアクティブ学級のシート、
 * 無効（またはアクティブシートが見つからない場合）は既定の「データベース」シートを返します。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [ss]
 * @returns {GoogleAppsScript.Spreadsheet.Sheet|null}
 */
function resolveDbSheet_(ss) {
  ss = ss || (typeof getSs_ === 'function' ? getSs_() : SpreadsheetApp.getActiveSpreadsheet());
  if (isMultiClassEnabled_()) {
    const active = PropertiesService.getScriptProperties().getProperty(SCRIPT_PROP_ACTIVE_CLASS);
    if (active && active !== SHEET_NAME_DATABASE) {
      const sheet = ss.getSheetByName(active);
      if (sheet) return sheet;
    }
  }
  return ss.getSheetByName(SHEET_NAME_DATABASE);
}

/**
 * アクティブなデータベースシートを返します（resolveDbSheet_ の別名）。
 * 既存コードの `ss.getSheetByName(SHEET_NAME_DATABASE)` の置き換え先です。
 * 見つからない場合は null を返します（呼び出し元の既存の null チェックを活かすため）。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [ss]
 * @returns {GoogleAppsScript.Spreadsheet.Sheet|null}
 */
function getDbSheet_(ss) {
  return resolveDbSheet_(ss);
}

/**
 * 指定シート名がデータベースシート（既定または登録学級のいずれか）かを判定します。
 * onEdit などシート名でのフィルタリングに使用します。
 * @param {string} sheetName
 * @returns {boolean}
 */
function isDbSheetName_(sheetName) {
  if (sheetName === SHEET_NAME_DATABASE) return true;
  if (!isMultiClassEnabled_()) return false;
  return getClassList_().some(c => c.sheetName === sheetName);
}

/**
 * データベースシートの列インデックスを動的に取得します（ヘッダー行に基づく）。
 * 戻り値は1始まりの列インデックスのオブジェクトです。
 * 複数学級モードではアクティブ学級のシートを対象とし、キャッシュはシート別に保持します。
 */
function getDbColumns() {
  const dbSheet = resolveDbSheet_();
  if (!dbSheet) throw new Error(`シート「${SHEET_NAME_DATABASE}」が見つかりません。`);

  const cacheKey = 'dbColumnsMap_v4::' + dbSheet.getName();
  const cache = CacheService.getScriptCache();
  const cachedCols = cache.get(cacheKey);
  if (cachedCols) {
    return JSON.parse(cachedCols);
  }

  const colMap = scanDbHeaderForSheet_(dbSheet);

  cache.put(cacheKey, JSON.stringify(colMap), 3600);
  return colMap;
}

/**
 * 指定したデータベースシートのヘッダー行から列マップを構築します（キャッシュなし）。
 * getDbColumns() の実体で、複数学級モードの学級シート作成時にも直接使用します。
 * @param {GoogleAppsScript.Spreadsheet.Sheet} dbSheet 対象シート
 * @returns {Object} 1始まりの列インデックスのマップ
 */
function scanDbHeaderForSheet_(dbSheet) {
  const headers = dbSheet.getRange(1, 1, 1, dbSheet.getLastColumn()).getValues()[0];
  const colMap = {};

  const headerKeys = {
    "第何週": "WEEK_NUM", "週番号": "WEEK_NUM",
    "日付": "DATE", "曜日": "DAY_OF_WEEK", "時程": "TIME", 
    "行事": "EVENT",
    "登校前タスク": "PRECLASS", "登校前": "PRECLASS", "始業前": "PRECLASS", "登校前業務": "PRECLASS", "出勤後タスク": "PRECLASS",
    "朝学習": "MORNING",
    "1校時": "PERIOD1", "単元1": "UNIT1", "単元名1": "UNIT1", "学習内容1": "CONTENT1", "内容1": "CONTENT1", 
    "2校時": "PERIOD2", "単元2": "UNIT2", "単元名2": "UNIT2", "学習内容2": "CONTENT2", "内容2": "CONTENT2", 
    "3校時": "PERIOD3", "単元3": "UNIT3", "単元名3": "UNIT3", "学習内容3": "CONTENT3", "内容3": "CONTENT3", 
    "4校時": "PERIOD4", "単元4": "UNIT4", "単元名4": "UNIT4", "学習内容4": "CONTENT4", "内容4": "CONTENT4", 
    "5校時": "PERIOD5", "単元5": "UNIT5", "単元名5": "UNIT5", "学習内容5": "CONTENT5", "内容5": "CONTENT5", "内容５": "CONTENT5", 
    "6校時": "PERIOD6", "単元6": "UNIT6", "単元名6": "UNIT6", "学習内容6": "CONTENT6", "内容6": "CONTENT6", 
    "宿題": "HOMEWORK", "課題": "HOMEWORK", "持ち物": "ITEMS", "中休み": "RECESS1",
    "昼休み": "RECESS2", "放課後": "AFTERSCHOOL",
    "振り返り": "REFLECTION", "ふり返り": "REFLECTION", "振返り": "REFLECTION",
    "振り返り状態": "REFLECTION_STATUS"
  };

  headers.forEach((header, index) => {
    const cleanHeader = header.toString().trim();
    const key = headerKeys[cleanHeader];
    if (key && !colMap[key]) {
      colMap[key] = index + 1;
    }
  });

  if (!colMap.DATE) throw new Error(`シート「${dbSheet.getName()}」に「日付」という名前のヘッダー列が見つかりません。`);

  return colMap;
}

/**
 * データベースの列構成を変更した際にキャッシュをクリアする関数です。
 * 複数学級モードでは全学級シート分のキャッシュをクリアします。
 */
function clearDbColumnsCache() {
  const cache = CacheService.getScriptCache();
  const names = [SHEET_NAME_DATABASE].concat(getClassList_().map(c => c.sheetName));
  cache.removeAll(names.map(n => 'dbColumnsMap_v4::' + n));
  cache.remove('dbColumnsMap_v4'); // 旧形式キーの掃除（後方互換）
  logInfo("データベースの列構成キャッシュをクリアしました。");
}



// --- 単元マスタシート列定義 (1始まり) ---
const MASTER_COL_SUBJECT = 1; 
const MASTER_COL_UNIT_NAME = 2; 
const MASTER_COL_TOTAL_HOURS = 3; 
const MASTER_COL_HOUR_NUM = 4; 
const MASTER_COL_ACTIVITY = 5;
