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

/**
 * ユーザー別プロパティを取得します（UserProperties→ScriptProperties の順、無ければ null）。
 * PropertiesService.getProperty と同じく、未設定時は null を返します。
 * @param {string} key
 * @returns {?string}
 */
function tGetProp_(key) {
  try {
    const v = PropertiesService.getUserProperties().getProperty(key);
    if (v !== null && v !== undefined) return v;
  } catch (e) { /* UserProperties 不可時はフォールバックへ */ }
  // 共有デプロイでは、スクリプト全体の設定へ落ちない（下の isSharedDeployment_ 参照）
  if (isSharedDeployment_()) return null;
  try {
    return PropertiesService.getScriptProperties().getProperty(key);
  } catch (e) {
    return null;
  }
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
    return String(PropertiesService.getScriptProperties()
      .getProperty(SP_KEY_SHARED_DEPLOYMENT) || '').toLowerCase() === 'true';
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
}

/**
 * ユーザー別プロパティを一括保存します。
 * @param {Object} obj キー・値のオブジェクト
 */
function tSetProps_(obj) {
  PropertiesService.getUserProperties().setProperties(obj, false);
}

/**
 * ユーザー別プロパティを1件削除します（未設定時は無視）。
 * @param {string} key
 */
function tDeleteProp_(key) {
  try {
    PropertiesService.getUserProperties().deleteProperty(key);
  } catch (e) { /* 未設定時は無視 */ }
}

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
  // 共有デプロイでは使わない。全員が配布元の1つのDBへ合流してしまうため。
  if (isSharedDeployment_()) return '';
  try {
    const id = PropertiesService.getScriptProperties().getProperty(SP_KEY_LEGACY_SPREADSHEET_ID) || '';
    if (id) {
      // めったに通らない経路なので、通ったことが分かるようにしておく。
      // 「自分のDBを作ったつもりが、別のDBを開いていた」ときの手がかりになる。
      logInfo('スクリプト全体の設定（旧バインド）に記録されたデータベースを使用しています。');
    }
    return id;
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

    const templateConfigured = !!PropertiesService.getScriptProperties().getProperty(SP_KEY_DB_TEMPLATE_ID);

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
  const lock = LockService.getUserLock();
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

    const templateId = PropertiesService.getScriptProperties().getProperty(SP_KEY_DB_TEMPLATE_ID);
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
