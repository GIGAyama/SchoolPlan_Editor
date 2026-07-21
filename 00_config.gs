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

// drive.file 運用: 行事予定PDFはDriveフォルダに保存せず、Googleピッカーで選んだ
// ファイルの「参照（ID・ファイル名・学校名）」のみをプロパティに保存する。
// フォルダ作成（DriveApp.createFolder）はフル drive スコープを要求するため行わない。
// 閲覧はユーザー自身のブラウザセッションでDriveプレビューを埋め込んで行う。
const UP_KEY_EVENT_PDF_REFS = 'up_eventPdfRefs'; // Properties: 行事予定PDF参照リスト(JSON)


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
  return tGetProp_(SCRIPT_PROP_MULTICLASS_ENABLED) === 'true';
}

/**
 * 登録されている学級リストを返します（モード無効時は空配列）。
 * @returns {Array<{name: string, sheetName: string, grade: string|number, standardHours: ?Array}>}
 */
function getClassList_() {
  try {
    const json = tGetProp_(SCRIPT_PROP_CLASS_LIST);
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
    const active = tGetProp_(SCRIPT_PROP_ACTIVE_CLASS);
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

// データベースの見出しは、旧版・学校ごとの既存シートで表記や列順が異なる。
// NFKC正規化後の見出しを論理キーへ変換し、物理列順から完全に独立させる。
const DB_HEADER_KEY_MAP_ = {
  '第何週': 'WEEK_NUM', '週番号': 'WEEK_NUM',
  '日付': 'DATE', '曜日': 'DAY_OF_WEEK', '時程': 'TIME',
  '行事': 'EVENT',
  '登校前タスク': 'PRECLASS', '登校前': 'PRECLASS', '始業前': 'PRECLASS',
  '登校前業務': 'PRECLASS', '出勤後タスク': 'PRECLASS',
  '朝学習': 'MORNING',
  '宿題': 'HOMEWORK', '課題': 'HOMEWORK', '持ち物': 'ITEMS',
  '中休み': 'RECESS1', '昼休み': 'RECESS2', '放課後': 'AFTERSCHOOL',
  '振り返り': 'REFLECTION', 'ふり返り': 'REFLECTION', '振返り': 'REFLECTION',
  '振り返り状態': 'REFLECTION_STATUS'
};

for (let n = 1; n <= 6; n++) {
  DB_HEADER_KEY_MAP_[n + '校時'] = 'PERIOD' + n;
  DB_HEADER_KEY_MAP_[n + '時間目'] = 'PERIOD' + n;
  DB_HEADER_KEY_MAP_['単元' + n] = 'UNIT' + n;
  DB_HEADER_KEY_MAP_['単元名' + n] = 'UNIT' + n;
  DB_HEADER_KEY_MAP_[n + '校時単元'] = 'UNIT' + n;
  DB_HEADER_KEY_MAP_[n + '時間目単元'] = 'UNIT' + n;
  DB_HEADER_KEY_MAP_['学習内容' + n] = 'CONTENT' + n;
  DB_HEADER_KEY_MAP_['内容' + n] = 'CONTENT' + n;
  DB_HEADER_KEY_MAP_[n + '校時内容'] = 'CONTENT' + n;
  DB_HEADER_KEY_MAP_[n + '時間目内容'] = 'CONTENT' + n;
}

/**
 * ヘッダー表記を比較用に正規化します。
 * 全角数字・全角空白・余分な空白を吸収します。
 * @param {*} header
 * @returns {string}
 */
function normalizeDbHeader_(header) {
  const raw = header === null || header === undefined ? '' : String(header);
  return raw.normalize('NFKC').replace(/\s+/g, '').trim();
}

/**
 * ヘッダー配列から1始まりの列マップを構築する純粋関数です。
 * 同じ論理項目の見出しが複数ある場合は、既存互換のため左側を採用します。
 * @param {Array<*>} headers
 * @param {string} [sheetName]
 * @returns {Object}
 */
function buildDbColumnMapFromHeaders_(headers, sheetName) {
  const colMap = {};
  (headers || []).forEach((header, index) => {
    const cleanHeader = normalizeDbHeader_(header);
    const key = DB_HEADER_KEY_MAP_[cleanHeader];
    if (key && !colMap[key]) colMap[key] = index + 1;
  });

  if (!colMap.DATE) {
    throw new Error(`シート「${sheetName || SHEET_NAME_DATABASE}」に「日付」という名前のヘッダー列が見つかりません。`);
  }
  return colMap;
}

/**
 * データベースシートの列インデックスを、現在のヘッダー行から毎回取得します。
 *
 * 以前は ScriptCache をシート名だけで共有していたため、マルチテナント環境で
 * 列順の異なる別ユーザーの「データベース」シートの列マップが混入し、週案が
 * 別の欄へ表示・保存される可能性がありました。ヘッダー1行の読取は軽量なため、
 * 正確性を優先してキャッシュせず、その実シートの見出しを唯一の情報源とします。
 * @returns {Object} 1始まりの列インデックスのマップ
 */
function getDbColumns() {
  const dbSheet = resolveDbSheet_();
  if (!dbSheet) throw new Error(`シート「${SHEET_NAME_DATABASE}」が見つかりません。`);
  return scanDbHeaderForSheet_(dbSheet);
}

/**
 * 指定したデータベースシートのヘッダー行から列マップを構築します。
 * @param {GoogleAppsScript.Spreadsheet.Sheet} dbSheet 対象シート
 * @returns {Object} 1始まりの列インデックスのマップ
 */
function scanDbHeaderForSheet_(dbSheet) {
  const lastColumn = Math.max(1, dbSheet.getLastColumn());
  const headers = dbSheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  return buildDbColumnMapFromHeaders_(headers, dbSheet.getName());
}

/**
 * 旧版が作成した列マップキャッシュを削除します。
 * 現行版は列マップをキャッシュしませんが、アップデート直後に誤った旧キャッシュを
 * 残さないため、メンテナンス操作との後方互換として維持します。
 */
function clearDbColumnsCache() {
  const names = [SHEET_NAME_DATABASE].concat(getClassList_().map(c => c.sheetName));
  const keys = [];
  ['v1', 'v2', 'v3', 'v4', 'v5'].forEach(version => {
    names.forEach(name => keys.push('dbColumnsMap_' + version + '::' + name));
  });
  keys.push('dbColumnsMap_v4');
  try { CacheService.getScriptCache().removeAll(keys); } catch (e) {}
  try { CacheService.getUserCache().removeAll(keys); } catch (e) {}
  logInfo('データベースの列構成キャッシュをクリアしました。');
}



// --- 単元マスタシート列定義 (1始まり) ---
const MASTER_COL_SUBJECT = 1;
const MASTER_COL_UNIT_NAME = 2;
const MASTER_COL_TOTAL_HOURS = 3;
const MASTER_COL_HOUR_NUM = 4;
const MASTER_COL_ACTIVITY = 5;
