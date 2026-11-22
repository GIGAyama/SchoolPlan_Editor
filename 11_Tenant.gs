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
// ScriptProperties: 1つのURLを多数の先生に配る運用かどうか（配布元が 'true' を設定）
const SP_KEY_SHARED_DEPLOYMENT = 'sp_sharedDeployment';

// ===================================================
// ===== テナント（ユーザー別）プロパティ・アクセサ =====
// ===================================================
// 個人設定は UserProperties（Googleアカウント単位）に保存する。
// 読み取りは UserProperties を優先し、無ければ ScriptProperties へフォールバックする。
// これにより従来のバインド型（設定が ScriptProperties にある）から移行しても
// 設定が失われず、ユーザーが保存し直すと自然に UserProperties へ移る。

// --- プロパティの読み取りを、1回の実行の中でまとめる -----------------------
//
// PropertiesService の getProperty は、GAS では**1回ごとに Google への
// リモート呼び出し**になる。実測では、週案の保存1回で 44 回呼んでいた。
// 1回あたり数十msなので、これだけで数秒になる（保存時間の半分が Sheets API の
// 外にあった、その正体）。
//
// getProperties() なら1回で全部返るので、実行の最初に一度だけ取って覚えておく。
// 実行が終われば消えるため、他の実行や他の利用者に漏れることはない。
// 書き込みは本体と覚えている内容の両方へ反映する。
let T_USER_PROPS_ = null;
let T_SCRIPT_PROPS_ = null;

/** この実行での UserProperties の内容（初回だけ取りに行く）。 */
function tUserProps_() {
  if (T_USER_PROPS_) return T_USER_PROPS_;
  try {
    T_USER_PROPS_ = PropertiesService.getUserProperties().getProperties() || {};
  } catch (e) {
    T_USER_PROPS_ = {};
  }
  return T_USER_PROPS_;
}

/** この実行での ScriptProperties の内容（初回だけ取りに行く）。 */
function tScriptProps_() {
  if (T_SCRIPT_PROPS_) return T_SCRIPT_PROPS_;
  try {
    T_SCRIPT_PROPS_ = PropertiesService.getScriptProperties().getProperties() || {};
  } catch (e) {
    T_SCRIPT_PROPS_ = {};
  }
  return T_SCRIPT_PROPS_;
}

/** 覚えている内容を捨てます（テスト・障害時の保険）。 */
function tResetPropsCache_() {
  T_USER_PROPS_ = null;
  T_SCRIPT_PROPS_ = null;
  tResetCacheMemo_();
}

// --- キャッシュの読み取りも、1回の実行の中でまとめる -----------------------
//
// CacheService も PropertiesService と同じく、1回ごとに Google へのリモート呼び出しに
// なる。週案の保存1回で8回読んでいたが、見ている鍵は4種類しかなく、同じ鍵を何度も
// 取りに行っていた（`p2Calendar` は4回、`p3SheetsVerified` は2回）。
//
// 1回の実行の中では、自分が書き換えないかぎり内容は変わらない。他の実行が書き換えても、
// 次の実行で読み直せば追いつく。だから最初の1回だけ取りに行き、あとは覚えているものを返す。
// 書き込みと削除は、本体と覚えている内容の両方へ反映する。
let T_USER_CACHE_MEMO_ = {};

/** 覚えているキャッシュの内容を捨てます。 */
function tResetCacheMemo_() {
  T_USER_CACHE_MEMO_ = {};
}

/**
 * 利用者キャッシュを1件読みます（未設定なら null）。
 * @param {string} key
 * @returns {?string}
 */
function tCacheGet_(key) {
  if (Object.prototype.hasOwnProperty.call(T_USER_CACHE_MEMO_, key)) {
    return T_USER_CACHE_MEMO_[key];
  }
  let value = null;
  try {
    value = CacheService.getUserCache().get(key);
  } catch (e) {
    value = null;
  }
  T_USER_CACHE_MEMO_[key] = (value === undefined ? null : value);
  return T_USER_CACHE_MEMO_[key];
}

/**
 * 利用者キャッシュへ1件書きます（キャッシュが使えなくても処理は続けます）。
 * @param {string} key
 * @param {string} value
 * @param {number} seconds 保持秒数
 */
function tCachePut_(key, value, seconds) {
  try {
    CacheService.getUserCache().put(key, value, seconds);
  } catch (e) { /* キャッシュは無くても動く */ }
  T_USER_CACHE_MEMO_[key] = value;
}

/**
 * 利用者キャッシュから1件消します。
 * @param {string} key
 */
function tCacheRemove_(key) {
  try {
    CacheService.getUserCache().remove(key);
  } catch (e) { /* もともと無ければそれでよい */ }
  T_USER_CACHE_MEMO_[key] = null;
}

/**
 * 利用者キャッシュからまとめて消します。
 * @param {Array<string>} keys
 */
function tCacheRemoveAll_(keys) {
  const list = keys || [];
  try {
    CacheService.getUserCache().removeAll(list);
  } catch (e) { /* もともと無ければそれでよい */ }
  list.forEach(function (key) { T_USER_CACHE_MEMO_[key] = null; });
}

/**
 * 利用者ごとのプロパティを1件読みます（未設定なら null）。
 * @param {string} key
 * @returns {?string}
 */
function tGetUserProp_(key) {
  const value = tUserProps_()[key];
  return value === undefined ? null : value;
}

/**
 * スクリプト全体のプロパティを1件読みます（未設定なら null）。
 * @param {string} key
 * @returns {?string}
 */
function tGetScriptProp_(key) {
  const value = tScriptProps_()[key];
  return value === undefined ? null : value;
}

/**
 * ユーザー別プロパティを取得します（UserProperties→ScriptProperties の順、無ければ null）。
 * PropertiesService.getProperty と同じく、未設定時は null を返します。
 * @param {string} key
 * @returns {?string}
 */
function tGetProp_(key) {
  const own = tGetUserProp_(key);
  if (own !== null) return own;
  // 共有デプロイでは、スクリプト全体の設定へ落ちない（下の isSharedDeployment_ 参照）
  if (isSharedDeployment_()) return null;
  return tGetScriptProp_(key);
}

/**
 * 1つのURLを多数の先生に配る「共有デプロイ」かどうかを返します。
 *
 * ScriptProperties はスクリプト全体で1つしかないため、共有デプロイでは
 * **そこに置かれた値が全員に効いてしまいます**。まだ自分の設定を持っていない先生が、
 * 配布元のデータベースへ合流したり、配布元の Gemini API キーで送信したりする経路になります
 * （docs/LEGAL_RISK_AUDIT_JP.md の C-1）。
 *
 * 既定は false。先生が各自でデプロイする従来の使い方（＝ScriptProperties も各自のもの）と、
 * 過去にバインド型で使っていた方の設定引き継ぎを壊さないためです。
 * 1つのURLを配る運用にするときは、スクリプトプロパティに
 * `sp_sharedDeployment` = `true` を設定してください。
 *
 * なお配布者向けの設定（`sp_dbTemplateId`）は ScriptProperties から直接読んでいるため、
 * この切り替えの影響を受けません。
 * @returns {boolean}
 */
function isSharedDeployment_() {
  try {
    return String(tGetScriptProp_(SP_KEY_SHARED_DEPLOYMENT) || '').toLowerCase() === 'true';
  } catch (e) {
    return false;
  }
}

/**
 * ユーザー別プロパティを1件保存します。
 * @param {string} key
 * @param {string} value
 */
function tSetProp_(key, value) {
  PropertiesService.getUserProperties().setProperty(key, value);
  tUserProps_()[key] = String(value);
}

/**
 * ユーザー別プロパティを一括保存します。
 * @param {Object} obj キー・値のオブジェクト
 */
function tSetProps_(obj) {
  PropertiesService.getUserProperties().setProperties(obj, false);
  const memo = tUserProps_();
  Object.keys(obj || {}).forEach(key => { memo[key] = String(obj[key]); });
}

/**
 * ユーザー別プロパティを1件削除します（未設定時は無視）。
 * @param {string} key
 */
function tDeleteProp_(key) {
  try {
    PropertiesService.getUserProperties().deleteProperty(key);
    delete tUserProps_()[key];
  } catch (e) { /* 未設定時は無視 */ }
}

/**
 * このユーザー個別の対象スプレッドシートIDを取得します（未設定なら空文字）。
 * @returns {string}
 */
function getUserSpreadsheetId_() {
  try {
    return tGetUserProp_(UP_KEY_SPREADSHEET_ID) || '';
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
  tUserProps_()[UP_KEY_SPREADSHEET_ID] = String(id);
}

/**
 * このユーザー個別の対象スプレッドシートIDを削除します（データ自体は削除しません）。
 */
function clearUserSpreadsheetId_() {
  try {
    PropertiesService.getUserProperties().deleteProperty(UP_KEY_SPREADSHEET_ID);
    delete tUserProps_()[UP_KEY_SPREADSHEET_ID];
  } catch (e) { /* 未設定時は無視 */ }
}

/**
 * 従来のグローバル紐付けID（ScriptProperties）を取得します（後方互換）。
 * @returns {string}
 */
function getLegacySpreadsheetId_() {
  // 共有デプロイでは使わない。全員が配布元の1つのDBへ合流してしまうため。
  if (isSharedDeployment_()) return '';
  try {
    // 「旧バインドで開いている」ことはログに残す価値があるが、ここでは書かない。
    // ここは getSs_() のたびに通り、週案の保存1回で8回来る。ログの追記は1行が
    // Sheets API の往復1回なので、そのまま保存時間になっていた。
    // 起動時に1度だけ呼ばれる getTenantStatus() へ移してある。
    return tGetScriptProp_(SP_KEY_LEGACY_SPREADSHEET_ID) || '';
  } catch (e) {
    return '';
  }
}

// ============================================================
// ===== データのロック =====
// ============================================================
//
// 週案の保存や一括転記は「読んでから書く」ので、同じデータへの書き込みを直列に並べる。
// 以前はどれも LockService.getScriptLock() を使っていた。**ScriptLock は利用者に関係なく
// スクリプト全体で1本**なので、1つのURLを多数の先生へ配る運用（docs/config.js が共通の
// /exec を指す形）では、全員の保存が1列に並ぶ。しかも同じロックを、完全バックアップを
// 伴う全消去・年間一括転記・一括自動入力・PDFの反映が長く握る。誰か1人がそれを実行して
// いるあいだ、ほかの学校の先生の保存までが10秒待って「他の保存処理が進行中です」で
// 失敗していた。守りたいのは「同じスプレッドシートへの書き込み」であって、
// 別の先生の別のスプレッドシートを待たせる理由は無い。
//
// そこで、**自分のデータベース（UserProperties で紐付けたもの）を使っている先生は
// 利用者ごとのロック**を取る。スクリプトプロパティに記録された1冊を全員で使う旧来の形
// （getLegacySpreadsheetId_）だけは、全員が同じ1冊へ書くので ScriptLock のままにする。
//
// 1冊を複数の先生で紐付けて共有している場合、利用者ごとのロックでは互いを待たない。
// 週案の保存はリビジョンの照合（楽観ロック）が守り、書くのも変わった日の行だけなので、
// 同じ週の同じ日を数秒以内に2人が保存したときだけ後勝ちになる（docs/DATA_PATH_AUDIT.md）。

/**
 * ロックを握っている深さ（種類ごと）。
 *
 * GAS のロックは、同じ実行が取り直しても何も起きず、releaseLock() は1回で外れる。
 * 入れ子で取って内側が先に放すと、外側は握っているつもりのまま守られずに走る
 * （保存の中から復元ポイント作成やマイグレーションが呼ばれる形で実際に入れ子になる）。
 * 深さを数え、いちばん外側だけが本当に取って・放す。トップレベル変数なので、
 * 実行が変われば 0 から数え直しになる。
 */
let T_LOCK_DEPTH_ = { user: 0, script: 0 };

/**
 * いまの利用者のデータを直列化するのに使うロックの種類を返します。
 * @returns {string} 'user'（自分のデータベース）または 'script'（全員で1冊を使う旧来の形）
 */
function tDataLockKind_() {
  const own = getUserSpreadsheetId_();
  const shared = getLegacySpreadsheetId_(); // 共有デプロイでは常に空（11_Tenant.gs の isSharedDeployment_）
  // 全員で使う1冊を相手にしているときだけ、全員を並べる。
  // 自分の紐付けがその1冊を指している場合（持ち主が紐付け直した等）も同じ1冊なので含める。
  if (shared && (!own || own === shared)) return 'script';
  return 'user';
}

/**
 * 利用者のデータ（スプレッドシート）への書き込みを直列化するロックを返します。
 * LockService のロックと同じ使い方（waitLock / tryLock / releaseLock）ができ、
 * 入れ子で取っても外側が先に外れません。
 * @returns {{waitLock: function(number), tryLock: function(number): boolean,
 *            releaseLock: function(), hasLock: function(): boolean}}
 */
function tDataLock_() {
  return tReentrantLock_(tDataLockKind_());
}

/**
 * 利用者ごとのロックを返します（入れ子で取っても外側が先に外れません）。
 * データ保全の内部処理（マイグレーション・日次バックアップ）が使います。
 * @returns {Object} tDataLock_ と同じ形
 */
function tUserLock_() {
  return tReentrantLock_('user');
}

/**
 * 入れ子に強いロックを作ります。
 * @param {string} kind 'user' または 'script'
 * @returns {Object}
 */
function tReentrantLock_(kind) {
  let held = false; // この取っ手が握っているか（同じ取っ手で2回数えない）
  const real = function () {
    return kind === 'user' ? LockService.getUserLock() : LockService.getScriptLock();
  };
  return {
    waitLock: function (timeoutMs) {
      if (held) return;
      if (T_LOCK_DEPTH_[kind] === 0) real().waitLock(timeoutMs);
      T_LOCK_DEPTH_[kind]++;
      held = true;
    },
    tryLock: function (timeoutMs) {
      if (held) return true;
      if (T_LOCK_DEPTH_[kind] === 0 && !real().tryLock(timeoutMs)) return false;
      T_LOCK_DEPTH_[kind]++;
      held = true;
      return true;
    },
    releaseLock: function () {
      if (!held) return;
      held = false;
      T_LOCK_DEPTH_[kind]--;
      if (T_LOCK_DEPTH_[kind] === 0) real().releaseLock();
    },
    hasLock: function () { return held; }
  };
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
    // ファイルのコピー漏れは「〇〇 is not defined」としか出ず原因が分からない。
    // 起動時に一番はじめに呼ばれるここで、名指しで知らせる。
    // 99_Utils.gs 自体が古いと、この関数もまだ無い。そのときも配置の問題として扱う。
    if (typeof checkDeploymentIntegrity_ !== 'function') {
      const note = '99_Utils.gs が古いままです。リポジトリの内容で貼り直してください'
        + '（clasp push が確実です）。';
      return { success: false, error: note, deploymentError: note };
    }
    const deployment = checkDeploymentIntegrity_();
    if (!deployment.ok) {
      logError('checkDeploymentIntegrity_', new Error(deployment.message));
      return { success: false, error: deployment.message, deploymentError: deployment.message };
    }

    const id = resolveSpreadsheetId_();
    // 旧バインド（スクリプト全体の設定）で開いていることを、起動時に1行だけ残す。
    // 「自分のDBを作ったつもりが、別のDBを開いていた」ときの手がかりになる。
    if (id && !getUserSpreadsheetId_()) {
      logInfo('スクリプト全体の設定（旧バインド）に記録されたデータベースを使用しています。');
    }
    let linked = false;
    let name = '';
    // 「一度も紐付けていない」のか「紐付け先が開けなくなった」のかを区別する。
    // drive.file へ移行した直後は後者が起きうる（アプリ作成物として認識されず、
    // ピッカーで選び直すまで開けない）。ここを一緒くたにすると、既存の先生に
    // 「新しく作成する」を押させてしまい、これまでのデータが消えたように見える。
    let needsReauthorize = false;
    let openError = '';
    if (id) {
      try {
        const ss = sheetsOpenById_(id);
        name = ss.getName();
        linked = true;
      } catch (openErr) {
        linked = false;
        needsReauthorize = true;
        openError = (openErr && openErr.message) ? openErr.message : String(openErr);
        logInfo('紐付け済みのデータベースを開けませんでした。選び直しが必要です: ' + id
          + ' / ' + openError);
      }
    }
    let email = '';
    try { email = Session.getActiveUser().getEmail() || ''; } catch (e) { /* 権限未付与時は空 */ }

    const templateConfigured = !!tGetScriptProp_(SP_KEY_DB_TEMPLATE_ID);

    return {
      success: true,
      linked: linked,
      // 紐付け先はあるのに開けない状態。フロントは「選び直し」を促す画面を出す。
      needsReauthorize: needsReauthorize,
      // 開けなかった理由。切り分けのため画面の「詳しい情報」に出す。
      openError: openError,
      spreadsheetId: linked ? id : '',
      spreadsheetName: name,
      email: email,
      // テンプレート未設定でも initializeNewDatabase_() でプログラム構築できるため、常に新規作成可能。
      canCreate: true,
      templateConfigured: templateConfigured
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
      ss = sheetsOpenById_(id);
    } catch (openErr) {
      // drive.file 運用では、URL や ID を打ち込む方法で開けるのは
      // 「このアプリが作ったファイル」だけ。それ以外はピッカーで選んでもらう必要がある。
      // 原因の切り分けができるよう、API が返した理由も添える。
      const reason = (openErr && openErr.message) ? openErr.message : String(openErr);
      throw new Error('スプレッドシートを開けませんでした。'
        + '「ドライブから選ぶ」で選び直してください（このアプリは、あなたが選んだファイルだけにアクセスできます）。'
        + '\n\n詳しい情報: ' + reason);
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
 * 新規DBの「データベース」シートの正規ヘッダー（列名）。
 * これらの列名は 00_config.gs の scanDbHeaderForSheet_() が認識する見出しと一致しており、
 * アプリはヘッダー名で列を解決するため、この順序であれば週案・振り返り・時数がすべて動作します。
 */
const DB_CANONICAL_HEADERS = [
  '第何週', '日付', '曜日', '時程', '行事', '登校前', '朝学習',
  '1校時', '単元1', '学習内容1',
  '2校時', '単元2', '学習内容2',
  '中休み',
  '3校時', '単元3', '学習内容3',
  '4校時', '単元4', '学習内容4',
  '昼休み',
  '5校時', '単元5', '学習内容5',
  '6校時', '単元6', '学習内容6',
  '放課後', '宿題', '持ち物', '振り返り', '振り返り状態'
];

/**
 * 現在の年度（4月始まり）の起点となる月曜日を返します。
 * 年間カレンダー生成の既定の開始日として使用します（4月1日を含む週の月曜日）。
 * @returns {Date}
 */
function computeFiscalYearStartMonday_() {
  const now = new Date();
  const fy = (now.getMonth() + 1 >= 4) ? now.getFullYear() : now.getFullYear() - 1;
  const apr1 = new Date(fy, 3, 1); // 4月1日
  const dow = apr1.getDay();       // 0=日 .. 6=土
  const diff = (dow === 0) ? -6 : (1 - dow); // 直前（または当日）の月曜日へ
  const monday = new Date(apr1);
  monday.setDate(apr1.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

/**
 * 空のスプレッドシートに、週案アプリが必要とするシート
 * （データベース／単元マスタ／タスク）をプログラムで構築します。
 * テンプレート未設定でも createMyDatabase() が動くようにするための初期化ロジックです。
 *
 * - 「データベース」: 正規ヘッダー + 現年度から約1年分（370日）の日付/曜日/週番号
 * - 「単元マスタ」: ヘッダーのみ
 * - 「タスク」: 既存の initTaskSheet_() を再利用して作成
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss 初期化対象の（空の）スプレッドシート
 * @returns {GoogleAppsScript.Spreadsheet.Sheet} 作成した「データベース」シート
 */
function initializeNewDatabase_(ss) {
  // 1) 「データベース」シート（新規作成直後の既定シートを流用できる場合は流用）
  let dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
  if (!dbSheet) {
    const first = ss.getSheets()[0];
    if (first && first.getLastRow() === 0 && first.getLastColumn() <= 1) {
      dbSheet = first.setName(SHEET_NAME_DATABASE);
    } else {
      dbSheet = ss.insertSheet(SHEET_NAME_DATABASE, 0);
    }
  }
  const headers = DB_CANONICAL_HEADERS;
  dbSheet.getRange(1, 1, 1, headers.length).setValues([headers])
    .setBackground('#1a73e8').setFontColor('white').setFontWeight('bold');
  dbSheet.setFrozenRows(1);

  // 2) 年間カレンダー（370日分）を 2行目以降に展開
  const DAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];
  const cur = computeFiscalYearStartMonday_();
  const totalDays = 370;
  const rows = [];
  let weekNum = 1;
  for (let i = 0; i < totalDays; i++) {
    if (i > 0 && cur.getDay() === 1) weekNum++;
    const row = new Array(headers.length).fill('');
    row[0] = weekNum;                    // 第何週
    row[1] = new Date(cur);              // 日付
    row[2] = DAY_LABELS[cur.getDay()];   // 曜日
    rows.push(row);
    cur.setDate(cur.getDate() + 1);
  }
  dbSheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  dbSheet.getRange(2, 2, rows.length, 1).setNumberFormat('yyyy/MM/dd'); // 日付列

  // 3) 「単元マスタ」シート
  if (!ss.getSheetByName(SHEET_NAME_UNIT_MASTER)) {
    const um = ss.insertSheet(SHEET_NAME_UNIT_MASTER);
    um.getRange(1, 1, 1, 5)
      .setValues([['教科', '単元名', '総時間数', '何時間目', '時間ごとの学習活動']])
      .setFontWeight('bold');
    um.setFrozenRows(1);
  }

  // 4) 「タスク」シート（既存の初期化関数を再利用）
  try {
    if (typeof initTaskSheet_ === 'function') initTaskSheet_(ss);
  } catch (e) { /* タスクシートは遅延生成でも動くため、失敗しても致命的ではない */ }

  // 5) 「学級通信データ」シート（配布用テンプレートにしか無く、作る処理が抜けていた）
  try {
    if (typeof initNewsletterSheet_ === 'function') initNewsletterSheet_(ss);
  } catch (e) { /* 保存時にも作られるため、失敗しても致命的ではない */ }

  return dbSheet;
}

/**
 * [Web API] このユーザー専用のDBを新規作成し紐付けます。
 * 配布元が ScriptProperties「sp_dbTemplateId」にテンプレートIDを設定している場合はそれを複製し、
 * 未設定の場合は空のスプレッドシートを作成して initializeNewDatabase_() で必要シートを構築します。
 * 初回の作成（オンボーディング）では options.onlyIfUnlinked を渡してください。
 * すでに紐付いている場合は作らずにそれを返します。理由は下のコメントを参照。
 * @param {string} [name] 作成するスプレッドシートの名前
 * @param {Object} [options] { onlyIfUnlinked: boolean }
 * @returns {Object} { success, spreadsheetId, spreadsheetName, url, method } / { success:false, error }
 */
function createMyDatabase(name, options) {
  // 入れ子に強い取っ手で取る。この先で呼ぶ処理（シートの初期化など）が同じ利用者ロックを
  // 取り直しても、ここで握っているぶんが先に外れない。
  const lock = tUserLock_();
  try {
    lock.waitLock(10000);

    // 作成には時間がかかる（1年分のカレンダーを組み立てるため）。その間に画面との通信が
    // 切れると先生には「networkerror ... HTTP 0」とだけ出るが、**サーバ側の処理は
    // 最後まで走り切っているので、データベースはたいてい出来上がっている**。
    // そこでもう一度「作成する」を押されると、2つ目のスプレッドシートができて
    // 1つ目が迷子になる。初回作成のときだけ、ここで作り直しを止める。
    //
    // 設定画面の「新しく作って切り替える」は意図して2つ目を作る操作なので、
    // onlyIfUnlinked を渡さない＝この判定を通らない。
    if (options && options.onlyIfUnlinked) {
      const existingId = getUserSpreadsheetId_();
      if (existingId) {
        logInfo('すでに作成済みのデータベースがあるため、新規作成をやめました: ' + existingId);
        let existingName = '';
        try { existingName = sheetsOpenById_(existingId).getName(); } catch (e) { /* 名前が読めなくても紐付けは有効 */ }
        return {
          success: true,
          spreadsheetId: existingId,
          spreadsheetName: existingName,
          url: 'https://docs.google.com/spreadsheets/d/' + existingId + '/edit',
          method: 'existing',
          alreadyExisted: true
        };
      }
    }

    const templateId = tGetScriptProp_(SP_KEY_DB_TEMPLATE_ID);
    const title = String(name || '').trim()
      || ('週案データベース（' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd') + '）');

    let newId;
    let method;
    if (templateId) {
      // テンプレート複製方式（配布元が検証済みテンプレートを用意している場合）
      try {
        // drive.file 運用のため DriveApp ではなく Drive REST API を使う（17_DriveApi.gs 参照）
        newId = driveCopyFile_(templateId, title).id;
      } catch (copyErr) {
        throw new Error('テンプレートの複製に失敗しました。テンプレートの共有設定（複製可能か）とIDを確認してください: ' + copyErr.message);
      }
      method = 'template';
    } else {
      // プログラム構築方式（テンプレート未設定でも新規作成できる）
      const ss = sheetsCreate_(title);
      initializeNewDatabase_(ss);
      newId = ss.getId();
      method = 'initialized';
    }

    setUserSpreadsheetId_(newId);
    logInfo('新規DBを作成しました (' + method + '): ' + newId);

    return {
      success: true,
      spreadsheetId: newId,
      spreadsheetName: title,
      url: 'https://docs.google.com/spreadsheets/d/' + newId + '/edit',
      method: method
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
