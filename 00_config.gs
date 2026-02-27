/**
 * @fileoverview しすステム全体で使用する定数、設定値定義
 */

// --- シート名 ---
const SHEET_NAME_SETTINGS = "初期設定";
const SHEET_NAME_DATABASE = "データベース";
// const SHEET_NAME_INPUT = "週案入力用"; // Phase 5で廃止
const SHEET_NAME_NEWSLETTER = "学級通信";
const SHEET_NAME_UNIT_MASTER = "単元マスタ";
const SHEET_NAME_LOG = "ログ";
const SHEET_NAME_TASK = "タスク"; // Phase 6 追加

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

// --- 固定時間割転記関連 定数 ---
const SETTINGS_RANGE_TIMETABLE = "B22:I26";

// --- 「初期設定」シートのセル定義 ---
const SETTINGS_CELL_COURSE_NAME = "B7";
const SETTINGS_CELL_EVENT_PDF_FOLDER_ID = "B8";
const SETTINGS_CELL_PDF_FOLDER_ID = "B9";
const SETTINGS_CELL_GEMINI_API_KEY = "B10";
const SETTINGS_CELL_STATUS = "B11"; // ステータス表示用セル
const SETTINGS_RANGE_COURSE_LIST_OUTPUT = "B29";

/**
 * データベースシートの列インデックスを動的に取得します（ヘッダー行に基づく）。
 * 戻り値は1始まりの列インデックスのオブジェクトです。
 */
function getDbColumns() {
  const cache = CacheService.getScriptCache();
  const cachedCols = cache.get('dbColumnsMap_v3');
  if (cachedCols) {
    return JSON.parse(cachedCols);
  }

  const ss = typeof getSs_ === 'function' ? getSs_() : SpreadsheetApp.getActiveSpreadsheet();
  const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
  if (!dbSheet) throw new Error(`シート「${SHEET_NAME_DATABASE}」が見つかりません。`);

  const headers = dbSheet.getRange(1, 1, 1, dbSheet.getLastColumn()).getValues()[0];
  const colMap = {};

  const headerKeys = {
    "第何週": "WEEK_NUM", "週番号": "WEEK_NUM",
    "日付": "DATE", "曜日": "DAY_OF_WEEK", "時程": "TIME", 
    "行事": "EVENT", "朝学習": "MORNING", 
    "1校時": "PERIOD1", "単元1": "UNIT1", "単元名1": "UNIT1", "学習内容1": "CONTENT1", "内容1": "CONTENT1", 
    "2校時": "PERIOD2", "単元2": "UNIT2", "単元名2": "UNIT2", "学習内容2": "CONTENT2", "内容2": "CONTENT2", 
    "3校時": "PERIOD3", "単元3": "UNIT3", "単元名3": "UNIT3", "学習内容3": "CONTENT3", "内容3": "CONTENT3", 
    "4校時": "PERIOD4", "単元4": "UNIT4", "単元名4": "UNIT4", "学習内容4": "CONTENT4", "内容4": "CONTENT4", 
    "5校時": "PERIOD5", "単元5": "UNIT5", "単元名5": "UNIT5", "学習内容5": "CONTENT5", "内容5": "CONTENT5", "内容５": "CONTENT5", 
    "6校時": "PERIOD6", "単元6": "UNIT6", "単元名6": "UNIT6", "学習内容6": "CONTENT6", "内容6": "CONTENT6", 
    "宿題": "HOMEWORK", "課題": "HOMEWORK", "持ち物": "ITEMS", "中休み": "RECESS1", 
    "昼休み": "RECESS2", "放課後": "AFTERSCHOOL"
  };

  headers.forEach((header, index) => {
    const cleanHeader = header.toString().trim();
    const key = headerKeys[cleanHeader];
    if (key && !colMap[key]) {
      colMap[key] = index + 1;
    }
  });

  if (!colMap.DATE) throw new Error("データベースシートに「日付」という名前のヘッダー列が見つかりません。");

  cache.put('dbColumnsMap_v3', JSON.stringify(colMap), 3600);
  return colMap;
}

/**
 * データベースの列構成を変更した際にキャッシュをクリアする関数です。
 */
function clearDbColumnsCache() {
  CacheService.getScriptCache().remove('dbColumnsMap_v3');
  logInfo("データベースの列構成キャッシュをクリアしました。");
}



// --- 単元マスタシート列定義 (1始まり) ---
const MASTER_COL_SUBJECT = 1; 
const MASTER_COL_UNIT_NAME = 2; 
const MASTER_COL_TOTAL_HOURS = 3; 
const MASTER_COL_HOUR_NUM = 4; 
const MASTER_COL_ACTIVITY = 5;
