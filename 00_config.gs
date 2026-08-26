/**
 * @fileoverview システム全体で使用する定数、設定値定義
 */

// === PWA シェル（入口ページ）の URL ===
//
// iOS Safari の「ホーム画面に追加」は、*いま開いているページ* を登録する。
// この Web アプリ（script.google.com の /exec）を追加しても、アプリにはならない。
// アイコンが付かず（タイトルの一文字が出るだけ）、開いても Safari のアドレスバーと
// 「このアプリケーションは Google ではなく他のユーザーが作成したものです」の表示が
// 残ったままになる。
//
// これは GAS 側では直せない。/exec の外枠は Google が出しているページで、
// apple-touch-icon も manifest も差し込めないためである
// （HtmlService で触れるのは title・viewport・favicon だけ）。
// したがって、シェルの外で開かれたときは入口ページへ戻ってもらうしかない。
//
// 実際に起きた経路：ログインのために「新しいタブで開く」を押した先生が、
// そのタブのまま使い続け、そこからホーム画面に追加してしまう。
//
// フォークして使う場合は、自分の GitHub Pages の URL に書き換えること。
// 空文字にすると案内を出さない（PWA シェルを使わない運用向け）。
const PWA_SHELL_URL = 'https://schoolplan-editor.giga-school.com/';

// --- シート名 ---
const SHEET_NAME_DATABASE = "データベース";
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
// Drive 操作は DriveApp を使わず、Drive REST API v3 のラッパー（17_DriveApi.gs）を通す。
// DriveApp は組み込みサービスの都合でフル drive スコープを要求し、drive.file では動かない。
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
  ss = ss || getSs_();
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
 * シート名でのフィルタリングに使用します。
 * @param {string} sheetName
 * @returns {boolean}
 */
function isDbSheetName_(sheetName) {
  if (sheetName === SHEET_NAME_DATABASE) return true;
  if (!isMultiClassEnabled_()) return false;
  return getClassList_().some(c => c.sheetName === sheetName);
}

// ===== 空き時間（別教員担当）の表現 =====
// 空き時間の状態は専用の列ではなく、「学習内容」セルの中に区切りマーカーとして
// 埋め込まれている。マーカーより前が授業内容、後ろがタスク。
//
// この文字列は、すでに利用者のスプレッドシートに保存されている。変更すると
// 過去に設定したすべての空きコマが空きコマでなくなるため、絶対に変えないこと。
// クライアント側の正本は App_Js_02_Plan.html の FREE_TASK_DIVIDER。
// 両者が一致していることは tests/free-slot.test.mjs で固定している。
const FREE_TASK_DIVIDER_ = '─── タスク ───';

/** 学習内容が空き時間（区切りマーカーを含む）かどうかを判定します。 */
function isFreeContent_(text) {
  return !!text && String(text).indexOf(FREE_TASK_DIVIDER_) !== -1;
}

/** 空き時間の学習内容を「授業内容」と「タスク」に分割します。 */
function splitFreeContent_(text) {
  const t = String(text || '');
  const idx = t.indexOf(FREE_TASK_DIVIDER_);
  if (idx === -1) return { subjectPart: t, taskPart: '' };
  return {
    subjectPart: t.slice(0, idx).replace(/\n+$/, ''),
    taskPart: t.slice(idx + FREE_TASK_DIVIDER_.length).replace(/^\n+/, '')
  };
}

/**
 * 学習内容の末尾に空き時間の印を付けます。既存の内容は消さず、授業内容として残します。
 * すでに空き時間なら何もしないので、何度転記しても印は増えません。
 * （組み立てた文字列どうしを比べる実装だと、シート側の末尾改行の扱い次第で
 *   毎回「変更あり」となり印が増殖するため、マーカーの有無だけで判定する）
 */
function markFreeContent_(text) {
  const t = (text === null || text === undefined) ? '' : String(text);
  if (isFreeContent_(t)) return t;
  const existing = t.replace(/\s+$/, '');
  return (existing ? existing + '\n' : '') + FREE_TASK_DIVIDER_ + '\n';
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
  // 幅は getMaxColumns()（シート構成に入っている＝通信なし）から取る。
  // getLastColumn() は「データのある最終列」なのでシート全体の読み込みを伴い、
  // 見出し1行を読むためだけに年間データを丸ごと運ぶことになる。
  // 見出しの無い列は buildDbColumnMapFromHeaders_ が読み飛ばす。
  const width = Math.max(1, dbSheet.getMaxColumns());
  // 対象行の読み取りと同じ形式（UNFORMATTED）で取る。形式がそろっていれば
  // 見出しと対象行を1回の batchGet にまとめられる（18_SheetsApi.gs の prefetchRanges）。
  // 見出しは文字列なので、表示文字列との違いは出ない。日付列の調査もさせない。
  const headers = dbSheet.getRange(1, 1, 1, width).getValues({ dateColumns: [] })[0];
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
  tCacheRemoveAll_(keys);
  logInfo('データベースの列構成キャッシュをクリアしました。');
}



// --- 単元マスタシート列定義 (1始まり) ---
const MASTER_COL_SUBJECT = 1;
const MASTER_COL_UNIT_NAME = 2;
const MASTER_COL_TOTAL_HOURS = 3;
const MASTER_COL_HOUR_NUM = 4;
const MASTER_COL_ACTIVITY = 5;
