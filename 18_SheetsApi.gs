/**
 * @fileoverview Sheets REST API (v4) の薄いファサード。
 *
 * ## なぜ SpreadsheetApp を使わないのか
 *
 * Apps Script 組み込みの `SpreadsheetApp` は **`spreadsheets` スコープを要求します**。
 * `spreadsheets` は sensitive スコープで、Google の OAuth 審査では
 * 「アプリが作った／利用者が選んだファイルだけを触る `drive.file` で足りるのでは」
 * と指摘されます（2026-08 の差し戻し。docs/C6_VERIFICATION_RESPONSE.md）。
 *
 * Sheets REST API v4 は **`drive.file` を認可スコープとして受け付ける**ので、
 * `UrlFetchApp` + `ScriptApp.getOAuthToken()` で直接呼べば `spreadsheets` は要りません。
 * これは Drive で `DriveApp` を捨てて REST v3 に移した 17_DriveApi.gs と同じ判断です。
 *
 * ## 呼び出し側を書き換えないための「ファサード」
 *
 * `SpreadsheetApp` 由来の呼び出しはアプリ全体で 22 ファイル・約 470 箇所あります。
 * 全部を REST の作法に書き換えるのは現実的でないため、ここでは
 * **`Spreadsheet` / `Sheet` / `Range` と同じ形をしたオブジェクト**を返し、
 * 中身だけ REST に差し替えます。呼び出し側のコードは基本的にそのままです。
 *
 * ## 押さえている挙動の差（詳細は docs/B5_SHEETS_SCOPE_AUDIT.md §4）
 *
 * - **日付**: REST は日付をシリアル値で返すため、そのままでは `instanceof Date` が
 *   偽になり、週案の行照合が全滅します。列の表示形式を一度だけ調べ、日付列だけ
 *   `Date` に戻します。
 * - **矩形**: `values.get` は末尾の空セルを詰めた不揃いな配列を返します。
 *   `SpreadsheetApp` は必ず矩形なので、要求されたサイズに `''` で埋めて返します。
 * - **`getLastRow()`**: 「データのある最終行」であって、シートの行数ではありません。
 *   `values.get` の返り値の長さで求めます。
 * - **書き込み**: `valueInputOption=USER_ENTERED` を使います。`=` 始まりを数式として
 *   解釈するなど、`SpreadsheetApp.setValues()` と同じ振る舞いになります。
 *
 * ## 通信量
 *
 * 素朴に「1 呼び出し = 1 リクエスト」にすると往復が跳ね上がるため、
 * **シート単位の値をこの実行中だけキャッシュ**します。書き込みはキャッシュにも
 * 反映するので、読み直しのための再取得は起きません。
 *
 * ただし**シート全体しか読めない**と、それはそれで高くつきます。週案は年間1枚の
 * シートに全部入っているため、1週（正味 約1.6KB）を出すのに全体（数百KB）を運ぶ
 * ことになっていました。そこで `getRange(...).getValues()` は、**全体を読み込み済み
 * ならそこから切り出し、まだならその範囲だけを取りに行き**ます。
 *
 * 増え続けるシート（監査ログ・復元ポイント）では、これに加えて次の2つが効きます。
 *
 * - **`getLastRow()` / `getLastColumn()` を呼ばない。** 「データのある最終行・列」を
 *   知るにはシート全体が要るため、呼んだ時点で全体読みが走ります。大きさは
 *   `getMaxRows()` / `getMaxColumns()`（シート構成に入っている＝通信なし）で足ります。
 * - **追記は `appendRow` / `appendRows`（`values.append`）を使う。** 末尾はサーバ側が
 *   探すので、読み取りが要りません。
 *
 * 何往復するかは `tests/round-trip-budget.test.mjs` が見張っています。
 */

/** Sheets REST API のベース URL */
const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/**
 * この実行中だけ有効なキャッシュ。
 * スクリプトの実行が終われば消えるので、他の実行や他の利用者に漏れることはありません。
 * @type {Object<string, Object>}
 */
let SHEETS_CACHE_ = {};

/** キャッシュを捨てます（テスト・障害時の保険）。 */
function sheetsResetCache_() {
  SHEETS_CACHE_ = {};
  SHEETS_FETCH_COUNT_ = 0;
  SHEETS_FETCH_MS_ = 0;
}

// --- 通信の実測 -----------------------------------------------------------
//
// GAS の待ち時間は、ほぼ「Sheets API を何回叩いたか」で決まる。ところが
// 実際に何秒かかっているかは、GAS 実環境でしか分からない。
// 何回・何ミリ秒だったかを応答に載せておけば、「往復が重いのか、
// それとも GAS 側の固定費（スクリプトの読み込みなど）が重いのか」を切り分けられる。
// トップレベル変数なので、実行が変われば 0 から数え直しになる。
let SHEETS_FETCH_COUNT_ = 0;
let SHEETS_FETCH_MS_ = 0;

/**
 * この実行で Sheets API を何回叩き、合計何ミリ秒待ったかを返します。
 * @returns {{fetches: number, fetchMs: number}}
 */
function sheetsFetchStats_() {
  return { fetches: SHEETS_FETCH_COUNT_, fetchMs: Math.round(SHEETS_FETCH_MS_) };
}

// --- シート構成の持ち越しキャッシュ ---------------------------------------
//
// シート構成（どんな名前のシートが何番目にあるか）は、画面の操作1つごとに
// 必ず1回取りに行っていた。google.script.run は呼び出しごとに実行が分かれるので、
// 上の SHEETS_CACHE_ は次の呼び出しには残らないためである。
//
// これが「1分あたりの読み取り回数」の上限に効いていた。週の移動・時数の集計・
// 単元の進捗・タスクの件数……と画面が裏で何度もサーバを呼ぶため、
// 短時間に操作すると 429（Quota exceeded）が出る（実際に報告があった）。
//
// シート構成はめったに変わらないので、実行をまたいで持ち越す。
// **利用者ごとのキャッシュに入れる**こと。スクリプト全体のキャッシュに入れると、
// 1つのURLを多数の先生へ配る運用で他人のシート構成が見えてしまう。
const SHEETS_META_CACHE_TTL_SEC = 300; // 5分
const SHEETS_META_CACHE_MAX_BYTES = 90000; // CacheService の上限（100KB）に余裕を持たせる

function sheetsMetaCacheKey_(id) {
  return 'sheetsMeta:' + id;
}

/** 持ち越したシート構成を読みます。無ければ null。 */
function sheetsReadCachedMeta_(id) {
  try {
    const raw = CacheService.getUserCache().get(sheetsMetaCacheKey_(id));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null; // キャッシュが使えなくても、取りに行けば動く
  }
}

/** シート構成を持ち越します。 */
function sheetsWriteCachedMeta_(id, meta) {
  try {
    const text = JSON.stringify(meta);
    if (text.length > SHEETS_META_CACHE_MAX_BYTES) return;
    CacheService.getUserCache().put(sheetsMetaCacheKey_(id), text, SHEETS_META_CACHE_TTL_SEC);
  } catch (e) { /* 入らなくても動作に影響しない */ }
}

/** 持ち越したシート構成を捨てます（構成を変えた後始末）。 */
function sheetsDropCachedMeta_(id) {
  try {
    CacheService.getUserCache().remove(sheetsMetaCacheKey_(id));
  } catch (e) { /* 消せなくても、TTL で消える */ }
}

// ============================================================
// ===== 通信 =====
// ============================================================

/**
 * Sheets API を呼び出します。2xx 以外は例外にします。
 * 429（レート制限）と 5xx は指数バックオフで再試行します。
 * @param {string} url 完全な URL
 * @param {Object} [options] UrlFetchApp のオプション（headers は上書きされます）
 * @returns {Object} パース済みのレスポンス
 */
/**
 * 再試行までの待ち時間を決めます。
 *
 * 429 は「1分あたりの読み取り回数」の上限に当たったもので、**待たないと直りません。**
 * 1秒・2秒・4秒では上限の窓が明けないまま4回とも失敗し、先生には
 * 英語の "Quota exceeded" だけが出ていました（実際にこの報告がありました）。
 * 5xx（サーバ側の一時的な不調）は短い待ちで直ることが多いので、従来どおりにします。
 *
 * Apps Script の実行時間には上限（6分）があるため、待ちは長くしすぎないこと。
 * Retry-After がある場合はそれを尊重します。
 * @param {number} code HTTP ステータス
 * @param {GoogleAppsScript.URL_Fetch.HTTPResponse} response
 * @param {number} attempt 0 始まりの試行回数
 * @returns {number} 待つミリ秒
 */
function sheetsRetryWaitMs_(code, response, attempt) {
  const headers = (response && response.getHeaders && response.getHeaders()) || {};
  const retryAfter = parseInt(headers['Retry-After'] || headers['retry-after'], 10);
  if (!isNaN(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 30000);
  // 429 は分単位の枠が空くまで待つ必要がある（5秒 → 15秒 → 30秒）
  if (code === 429) return [5000, 15000, 30000][Math.min(attempt, 2)];
  return Math.pow(2, attempt) * 1000;
}

function sheetsFetch_(url, options) {
  const opts = options || {};
  const MAX_ATTEMPTS = 4;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    const response = UrlFetchApp.fetch(url, Object.assign({}, opts, {
      headers: Object.assign({}, opts.headers || {}, {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken()
      }),
      muteHttpExceptions: true
    }));
    SHEETS_FETCH_COUNT_++;
    SHEETS_FETCH_MS_ += Date.now() - startedAt;
    const code = response.getResponseCode();

    if (code >= 200 && code < 300) {
      const text = response.getContentText();
      return text ? JSON.parse(text) : {};
    }

    // 429 と 5xx だけ再試行する。権限不足（401/403）は待っても直らない。
    const retryable = (code === 429 || code >= 500);
    if (!retryable || attempt === MAX_ATTEMPTS - 1) {
      let message = response.getContentText();
      try {
        const parsed = JSON.parse(message);
        if (parsed && parsed.error && parsed.error.message) message = parsed.error.message;
      } catch (ignore) { /* JSON でなければ本文をそのまま使う */ }
      // 「API がオンになっていない」「混み合っている」は、権限の問題と紛らわしいので言い換える
      throw new Error(describeApiDisabledError_('Google Sheets API', code, message));
    }
    Utilities.sleep(sheetsRetryWaitMs_(code, response, attempt));
  }
  throw new Error('Sheets API: 再試行の上限に達しました');
}

/**
 * `spreadsheets.batchUpdate` を呼びます。
 * @param {string} spreadsheetId
 * @param {Object[]} requests
 * @returns {Object}
 */
function sheetsBatchUpdate_(spreadsheetId, requests) {
  return sheetsFetch_(`${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ requests: requests })
  });
}

// ============================================================
// ===== A1 記法・座標 =====
// ============================================================

/**
 * A1 記法で使えるようにシート名を引用符で囲みます。
 * 名前に `'` を含む場合は `''` にエスケープします。
 * @param {string} title
 * @returns {string}
 */
function sheetsQuoteTitle_(title) {
  return "'" + String(title).replace(/'/g, "''") + "'";
}

/**
 * 列番号（1始まり）を A1 記法の列名にします。27 → 'AA'
 * @param {number} column
 * @returns {string}
 */
function sheetsColumnLetter_(column) {
  let letter = '';
  let n = column;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

/**
 * A1 記法（`A1` / `A1:E1` / `A:A`）を 1 始まりの矩形に直します。
 * 行や列が省略されている場合は null を入れ、呼び出し側でシートの大きさに合わせます。
 * @param {string} a1
 * @returns {{row: number, column: number, numRows: (number|null), numColumns: (number|null)}}
 */
function sheetsParseA1_(a1) {
  const text = String(a1).replace(/^.*!/, '').trim();
  const parts = text.split(':');
  const parse = (token) => {
    const m = /^\$?([A-Za-z]*)\$?(\d*)$/.exec(token.trim());
    if (!m) throw new Error(`A1 記法として読めません: ${a1}`);
    const letters = m[1].toUpperCase();
    let column = 0;
    for (let i = 0; i < letters.length; i++) column = column * 26 + (letters.charCodeAt(i) - 64);
    return { column: column || null, row: m[2] ? parseInt(m[2], 10) : null };
  };

  const start = parse(parts[0]);
  const end = parts.length > 1 ? parse(parts[1]) : start;
  const row = start.row || 1;
  const column = start.column || 1;
  return {
    row: row,
    column: column,
    numRows: end.row ? (end.row - row + 1) : null,
    numColumns: end.column ? (end.column - column + 1) : null
  };
}

/**
 * `values.append` の応答が返す `updatedRange`（例: `'ログ'!A123:C123`）から、
 * 実際に書かれた行番号を取り出します。読めなければ 0 を返します。
 * @param {string} updatedRange
 * @returns {number} 1始まりの行番号。不明なら 0
 */
function sheetsAppendedRowNumber_(updatedRange) {
  if (!updatedRange) return 0;
  try {
    return sheetsParseA1_(updatedRange).row || 0;
  } catch (e) {
    return 0;
  }
}

/**
 * 追記した行の日付セルに表示形式を付けます。
 *
 * REST は数値を書くだけなので、付けないと日時が「46253.5」のような数値で表示されます。
 * どの列が日付かを調べる `dateColumns()` はシートの書式を取りに行くため、
 * **既に読み込んである時だけ**参照します。追記のために読み取りを増やしては本末転倒なので、
 * 分からないときは付ける側に倒します（同じ書式を上書きするだけで害はありません）。
 *
 * @param {Object} sheet Sheet 相当のオブジェクト
 * @param {Object} api シート内部API（`sheetsMakeSheet_` が返す第2の顔）
 * @param {number} rowNumber 1始まりの行番号
 * @param {number} numRows 追記した行数
 * @param {Object<number, string>} offsets 0始まりの列オフセット → 表示形式
 * @param {number[]} [declaredDateColumns] 既に日付の表示形式が付いている列（1始まり）
 */
function sheetsApplyAppendedDateFormats_(sheet, api, rowNumber, numRows, offsets, declaredDateColumns) {
  const targets = Object.keys(offsets || {});
  if (targets.length === 0) return;

  const known = (api.peekDateColumns && api.peekDateColumns()) || {};
  (declaredDateColumns || []).forEach(column => { known[Number(column)] = true; });
  const requests = targets
    .filter(offset => !known[Number(offset) + 1])
    .map(offset => ({
      repeatCell: {
        range: {
          sheetId: sheet.getSheetId(),
          startRowIndex: rowNumber - 1, endRowIndex: rowNumber - 1 + Math.max(1, numRows),
          startColumnIndex: Number(offset), endColumnIndex: Number(offset) + 1
        },
        cell: {
          userEnteredFormat: {
            numberFormat: {
              type: offsets[offset].indexOf('H') >= 0 ? 'DATE_TIME' : 'DATE',
              pattern: offsets[offset]
            }
          }
        },
        fields: 'userEnteredFormat.numberFormat'
      }
    }));
  if (requests.length === 0) return;

  sheetsBatchUpdate_(api.spreadsheetId, requests);
  // どの列を Date に戻すかが変わったので、判定をやり直させる
  api.invalidateDateColumns();
}

// ============================================================
// ===== 日付（シリアル値 ⇄ Date） =====
// ============================================================

/** 1970-01-01 のシリアル値。Sheets の基準日は 1899-12-30。 */
const SHEETS_EPOCH_SERIAL_ = 25569;

/**
 * 指定のタイムゾーンでの UTC オフセット（ミリ秒）を返します。
 * @param {Date} date
 * @param {string} timeZone
 * @returns {number}
 */
function sheetsTimeZoneOffset_(date, timeZone) {
  const z = Utilities.formatDate(date, timeZone, 'Z'); // 例: '+0900'
  const sign = z.charAt(0) === '-' ? -1 : 1;
  const hours = parseInt(z.substr(1, 2), 10);
  const minutes = parseInt(z.substr(3, 2), 10);
  return sign * ((hours * 60 + minutes) * 60 * 1000);
}

/**
 * Sheets のシリアル値を Date に戻します。
 * シリアル値は「スプレッドシートのタイムゾーンでの壁時計」なので、
 * そのタイムゾーンで同じ日時に見える瞬間を作ります。
 * @param {number} serial
 * @param {string} timeZone
 * @returns {Date}
 */
function sheetsSerialToDate_(serial, timeZone) {
  const wallClockMs = Math.round((serial - SHEETS_EPOCH_SERIAL_) * 86400000);
  const offset = sheetsTimeZoneOffset_(new Date(wallClockMs), timeZone);
  let result = new Date(wallClockMs - offset);
  // 夏時間の境界をまたいだときのために一度だけ測り直す（Asia/Tokyo では起きない）
  const corrected = sheetsTimeZoneOffset_(result, timeZone);
  if (corrected !== offset) result = new Date(wallClockMs - corrected);
  return result;
}

/**
 * Date を Sheets のシリアル値にします。
 * 数値として書き込むので、表示形式さえ日付なら日付として表示されます。
 * 文字列で書くとスプレッドシートのロケール解釈に左右されるため、この方式を採ります。
 * @param {Date} date
 * @param {string} timeZone
 * @returns {number}
 */
function sheetsDateToSerial_(date, timeZone) {
  const offset = sheetsTimeZoneOffset_(date, timeZone);
  return (date.getTime() + offset) / 86400000 + SHEETS_EPOCH_SERIAL_;
}

// ============================================================
// ===== 色 =====
// ============================================================

/** 名前付きの色。アプリ内で使っているものだけ。 */
const SHEETS_NAMED_COLORS_ = {
  white: '#ffffff',
  black: '#000000',
  red: '#ff0000'
};

/**
 * `#rrggbb` や `white` を Sheets API の Color にします。
 * @param {string} color
 * @returns {{red: number, green: number, blue: number}}
 */
function sheetsParseColor_(color) {
  let hex = String(color || '').trim().toLowerCase();
  if (SHEETS_NAMED_COLORS_[hex]) hex = SHEETS_NAMED_COLORS_[hex];
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/.test(hex)) return { red: 0, green: 0, blue: 0 };
  return {
    red: parseInt(hex.substr(0, 2), 16) / 255,
    green: parseInt(hex.substr(2, 2), 16) / 255,
    blue: parseInt(hex.substr(4, 2), 16) / 255
  };
}

// ============================================================
// ===== PDF 書き出し =====
// ============================================================

/**
 * シートを PDF にして Blob で返します。
 *
 * 用紙サイズや余白を指定できるのは `docs.google.com/.../export` の方だけなので、まずそちらを試します。
 * ただしこのエンドポイントの認可は Drive 側の権限で決まり、`drive.file` だけのトークンで
 * 通るかは環境に依存します。断られたときは Drive API v3 の export に切り替えます
 * （こちらは `drive.file` で確実に通りますが、レイアウトの指定はできません）。
 *
 * @param {string} spreadsheetId
 * @param {number} sheetId 出力するシートの gid
 * @param {string} fileName 付けたいファイル名
 * @returns {GoogleAppsScript.Base.Blob}
 */
function sheetsExportSheetAsPdf_(spreadsheetId, sheetId, fileName) {
  const token = ScriptApp.getOAuthToken();
  const layoutUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/export?`
    + 'exportFormat=pdf&format=pdf&size=A4&portrait=true&fitToPage=true'
    + `&gridlines=false&printtitle=false&sheetnames=false&gid=${sheetId}`;

  const response = UrlFetchApp.fetch(layoutUrl, {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  if (code >= 200 && code < 300) {
    return response.getBlob().setName(fileName);
  }

  if (code !== 401 && code !== 403) {
    throw new Error(`PDF の書き出しに失敗しました (${code}): ${response.getContentText()}`);
  }

  // 権限で断られた場合のみ、Drive API v3 の export に切り替える。
  // シート単位の指定はできないため、スプレッドシート全体が1つの PDF になる。
  logInfo('レイアウト指定つきの PDF 書き出しが権限で断られたため、Drive API の書き出しに切り替えます。');
  // 17_DriveApi.gs の DRIVE_API_BASE と同じ URL。ファイル間の初期化順に左右されないよう直接書く。
  const fallbackUrl = 'https://www.googleapis.com/drive/v3/files/'
    + encodeURIComponent(spreadsheetId) + '/export?mimeType=application%2Fpdf';
  const fallback = UrlFetchApp.fetch(fallbackUrl, {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  const fallbackCode = fallback.getResponseCode();
  if (fallbackCode < 200 || fallbackCode >= 300) {
    throw new Error(`PDF の書き出しに失敗しました (${fallbackCode}): ${fallback.getContentText()}`);
  }
  return fallback.getBlob().setName(fileName);
}

// ============================================================
// ===== Spreadsheet =====
// ============================================================

/**
 * スプレッドシートを開きます（`SpreadsheetApp.openById()` の置き換え）。
 * @param {string} spreadsheetId
 * @returns {Object} Spreadsheet 相当のオブジェクト
 */
function sheetsOpenById_(spreadsheetId) {
  const id = String(spreadsheetId);
  // metaFromCache … シート構成を持ち越しキャッシュから読んだか（古い可能性があるか）
  if (!SHEETS_CACHE_[id]) SHEETS_CACHE_[id] = { meta: null, metaFromCache: false, grids: {} };
  const state = SHEETS_CACHE_[id];

  /** シート構成をサーバから取り直します。 */
  function loadMeta() {
    const fields = encodeURIComponent(
      'spreadsheetId,properties(title,timeZone),sheets.properties(sheetId,title,index,hidden,gridProperties)');
    state.meta = sheetsFetch_(`${SHEETS_API_BASE}/${encodeURIComponent(id)}?fields=${fields}`);
    state.metaFromCache = false;
    sheetsWriteCachedMeta_(id, state.meta);
    return state.meta;
  }
  function meta() {
    if (state.meta) return state.meta;
    const cached = sheetsReadCachedMeta_(id);
    if (cached) {
      state.meta = cached;
      state.metaFromCache = true;
      return state.meta;
    }
    return loadMeta();
  }
  function timeZone() {
    return (meta().properties && meta().properties.timeZone) || Session.getScriptTimeZone() || 'Asia/Tokyo';
  }
  /** 構成が変わったので、次に触ったときに取り直させます。 */
  function invalidateMeta() {
    state.meta = null;
    state.metaFromCache = false;
    sheetsDropCachedMeta_(id);
  }
  /**
   * 持ち越したシート構成が古いせいで「見つからない」と誤判定していないか確かめます。
   *
   * アプリの外（スプレッドシートを直接開いて）シートを足したり名前を変えたりすると、
   * 持ち越した構成は古くなります。**「無い」と答える前に一度だけ取り直す**ことで、
   * 古いまま「シートが見つかりません」と言い切ってしまうのを防ぎます。
   * @returns {boolean} 取り直したなら true
   */
  function refreshIfStale() {
    if (!state.metaFromCache) return false;
    sheetsDropCachedMeta_(id);
    loadMeta();
    return true;
  }

  const spreadsheet = {
    /** @returns {string} */
    getId: function () { return id; },
    /** @returns {string} */
    getName: function () { return (meta().properties && meta().properties.title) || ''; },
    /** @returns {string} */
    getUrl: function () { return `https://docs.google.com/spreadsheets/d/${id}/edit`; },
    /** @returns {string} スプレッドシートのタイムゾーン */
    getSpreadsheetTimeZone: function () { return timeZone(); },

    /** シート構成を次に触ったときに取り直させます（構成を変えた後始末）。 */
    refresh_: function () { invalidateMeta(); },

    /**
     * @param {string} name
     * @returns {Object|null} Sheet 相当のオブジェクト
     */
    getSheetByName: function (name) {
      const pick = () => (meta().sheets || []).filter(s => s.properties.title === name)[0];
      let found = pick();
      // 見つからないときだけ、持ち越した構成が古い可能性を潰してから答える
      if (!found && refreshIfStale()) found = pick();
      return found ? sheetsMakeSheet_(spreadsheet, state, found.properties, invalidateMeta) : null;
    },

    /** @returns {Object[]} 並び順どおりの Sheet 相当のオブジェクト */
    getSheets: function () {
      return (meta().sheets || [])
        .slice()
        .sort((a, b) => (a.properties.index || 0) - (b.properties.index || 0))
        .map(s => sheetsMakeSheet_(spreadsheet, state, s.properties, invalidateMeta));
    },

    /**
     * シートを追加します。
     * @param {string} [name] 省略時は Sheets 側の既定名
     * @param {number} [index] 0 始まりの挿入位置
     * @returns {Object} Sheet 相当のオブジェクト
     */
    insertSheet: function (name, index) {
      const properties = {};
      if (name) properties.title = name;
      if (typeof index === 'number') properties.index = index;
      const result = sheetsBatchUpdate_(id, [{ addSheet: { properties: properties } }]);
      invalidateMeta();
      const added = result.replies[0].addSheet.properties;
      return sheetsMakeSheet_(spreadsheet, state, added, invalidateMeta);
    },

    /**
     * シートを削除します。
     * @param {Object} sheet Sheet 相当のオブジェクト
     */
    deleteSheet: function (sheet) {
      sheetsBatchUpdate_(id, [{ deleteSheet: { sheetId: sheet.getSheetId() } }]);
      delete state.grids[sheet.getName()];
      invalidateMeta();
    }
  };
  return spreadsheet;
}

/**
 * スプレッドシートを新規作成します（`SpreadsheetApp.create()` の置き換え）。
 * @param {string} title
 * @returns {Object} Spreadsheet 相当のオブジェクト
 */
function sheetsCreate_(title) {
  const created = sheetsFetch_(`${SHEETS_API_BASE}?fields=spreadsheetId`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ properties: { title: String(title) } })
  });
  return sheetsOpenById_(created.spreadsheetId);
}

// ============================================================
// ===== Sheet =====
// ============================================================

/**
 * Sheet 相当のオブジェクトを作ります。
 * @param {Object} spreadsheet 親の Spreadsheet 相当オブジェクト
 * @param {Object} state キャッシュ
 * @param {Object} properties Sheets API の SheetProperties
 * @param {function()} invalidateMeta 構成変更を親に知らせる
 * @returns {Object}
 */
function sheetsMakeSheet_(spreadsheet, state, properties, invalidateMeta) {
  const spreadsheetId = spreadsheet.getId();
  let props = properties;

  /** このシートのキャッシュ（値・表示文字列・日付列）。 */
  function grid() {
    if (!state.grids[props.title]) state.grids[props.title] = {};
    return state.grids[props.title];
  }

  /** シート全体を読み直します。 */
  function loadValues() {
    const range = encodeURIComponent(sheetsQuoteTitle_(props.title));
    const result = sheetsFetch_(
      `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${range}` +
      '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER');
    const g = grid();
    g.values = result.values || [];
    delete g.dirty;
    return g.values;
  }

  /**
   * 値のキャッシュ。書き込み後も読み直しません。
   * 行数・列数を数えるだけの用途（`getLastRow()` など）と、書き込みの反映先に使います。
   */
  function valuesCached() {
    const g = grid();
    return g.values || loadValues();
  }

  /**
   * セルの中身を読むためのキャッシュ。
   *
   * 書き込み後に一度だけシートを読み直すのが肝心です。スプレッドシートは
   * 書き込んだ値を解釈し直すため（"1/3" は日付に、"007" は 7 になる）、
   * 送った値をそのまま返すと、クライアントの持つ内容と実データが恒久的にずれ、
   * 保存のたびに「競合」と誤判定されます（tests/regression-fixes.test.mjs）。
   */
  function values() {
    const g = grid();
    if (!g.values) return loadValues();
    if (g.dirty) return loadValues();
    return g.values;
  }

  /**
   * 範囲だけを読みます。
   *
   * シート全体を読み込み済みならそこから切り出し、まだならその範囲だけを取りに行きます。
   * 週案は年間1枚のシートに全部入っているため、1週を出すのに全体を取ると、
   * 実データの100倍以上を運ぶことになります（1週の正味は約1.6KB）。
   *
   * 返す配列は**シート全体と同じ座標**に値を置きます。こうしておくと、
   * 切り出し側（`sheetsMakeRange_` の `slice`）が全体キャッシュのときと同じコードで済みます。
   *
   * @param {number} row 1始まり
   * @param {number} column 1始まり
   * @param {number} numRows
   * @param {number} numColumns
   * @param {boolean} formatted 画面に見えている文字列で欲しいか
   * @returns {Array[]} シート全体と同じ座標の疎な二次元配列
   */
  function window_(row, column, numRows, numColumns, formatted) {
    const g = grid();
    // 全体を持っているならそれが最も安い（書き込み後は読み直しが要るので dirty は除く）
    const whole = formatted ? g.display : (g.dirty ? null : g.values);
    if (whole) return whole;

    if (!g.windows) g.windows = {};
    const key = `${formatted ? 'd' : 'v'}:${row}:${column}:${numRows}:${numColumns}`;
    if (g.windows[key]) return g.windows[key];

    const lastColumnLetter = sheetsColumnLetter_(column + numColumns - 1);
    const a1 = `${sheetsQuoteTitle_(props.title)}!` +
      `${sheetsColumnLetter_(column)}${row}:${lastColumnLetter}${row + numRows - 1}`;
    const query = formatted
      ? '?valueRenderOption=FORMATTED_VALUE'
      : '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';
    const result = sheetsFetch_(
      `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1)}${query}`);

    // 取れた値を、シート全体での座標へ置き直す
    const placed = [];
    (result.values || []).forEach((line, offset) => {
      const target = [];
      line.forEach((value, index) => { target[column - 1 + index] = value; });
      placed[row - 1 + offset] = target;
    });
    g.windows[key] = placed;
    return placed;
  }

  /** 書き込んだので、範囲だけ読んで持っていた分は捨てる。 */
  function dropWindows() {
    delete grid().windows;
  }

  /**
   * 末尾を開けた範囲（`A2:C`）を読み、範囲キャッシュへ入れます。
   *
   * `getMaxRows()` は**シートの宣言上の行数**で、追記で伸びた分がすぐには
   * 反映されません。「データのある行を全部」読みたいときにこれを当てにすると、
   * 直前に足した行を取りこぼします（実際、スキーマ版が読めなくなりました）。
   * 末尾を開けて要求すれば、Sheets 側がデータのある行だけを返してくれます。
   *
   * @param {number} startRow 1始まり
   * @param {number} column 1始まり
   * @param {number} numColumns
   * @param {boolean} formatted 画面に見えている文字列で欲しいか
   * @returns {number} 返ってきた行数（0 ならデータなし）
   */
  function windowToEnd_(startRow, column, numColumns, formatted) {
    const g = grid();
    const whole = formatted ? g.display : (g.dirty ? null : g.values);
    if (whole) return Math.max(0, whole.length - startRow + 1);

    const a1 = `${sheetsQuoteTitle_(props.title)}!` +
      `${sheetsColumnLetter_(column)}${startRow}:${sheetsColumnLetter_(column + numColumns - 1)}`;
    const query = formatted
      ? '?valueRenderOption=FORMATTED_VALUE'
      : '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';
    const result = sheetsFetch_(
      `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1)}${query}`);

    const lines = result.values || [];
    if (lines.length === 0) return 0;

    const placed = [];
    lines.forEach((line, offset) => {
      const target = [];
      line.forEach((value, index) => { target[column - 1 + index] = value; });
      placed[startRow - 1 + offset] = target;
    });
    if (!g.windows) g.windows = {};
    // 続く getRange(...).getValues() がこのキャッシュに当たるようにする
    g.windows[`${formatted ? 'd' : 'v'}:${startRow}:${column}:${lines.length}:${numColumns}`] = placed;
    return lines.length;
  }

  /** 表示文字列のキャッシュ。`getDisplayValues()` でしか使わないので遅延取得。 */
  function displayValues() {
    const g = grid();
    if (!g.display) {
      const range = encodeURIComponent(sheetsQuoteTitle_(props.title));
      const result = sheetsFetch_(
        `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${range}` +
        '?valueRenderOption=FORMATTED_VALUE');
      g.display = result.values || [];
    }
    return g.display;
  }

  /**
   * 日付として表示されている列（1始まり）の集合。
   * REST はシリアル値しか返さないため、どの列を Date に戻すかをここで決めます。
   * 表示形式は列ごとにそろっている前提で、先頭 200 行を1回だけ調べます。
   */
  function dateColumns() {
    const g = grid();
    if (!g.dateColumns) {
      const set = {};
      let failure = '';
      try {
        const range = encodeURIComponent(sheetsQuoteTitle_(props.title) + '!1:200');
        const fields = encodeURIComponent(
          'sheets(data(rowData(values(effectiveFormat(numberFormat(type))))))');
        const result = sheetsFetch_(
          `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}` +
          `?ranges=${range}&includeGridData=true&fields=${fields}`);
        const rowData = (((result.sheets || [])[0] || {}).data || [])[0];
        ((rowData && rowData.rowData) || []).forEach(row => {
          (row.values || []).forEach((cell, index) => {
            const type = cell && cell.effectiveFormat && cell.effectiveFormat.numberFormat
              && cell.effectiveFormat.numberFormat.type;
            if (type === 'DATE' || type === 'DATE_TIME') set[index + 1] = true;
          });
        });
      } catch (e) {
        // 表示形式が取れなくても、日付以外の読み書きは動かしたい
        failure = e.message;
      }
      // ログ出力より先に覚えさせる。logInfo はログシートへの追記を通じて
      // ここへ戻ってくるので、未確定のままログを出すと無限に再入する。
      g.dateColumns = set;
      if (failure) {
        logInfo(`表示形式の取得に失敗したため日付列の判定を省略します: ${props.title} (${failure})`);
      }
    }
    return g.dateColumns;
  }

  /** 値を書き換えたので、読み直しに備えて表示文字列だけ捨てる。 */
  function invalidateDisplay() {
    delete grid().display;
    dropWindows();
  }
  /** 数式を書いた等、キャッシュでは追随できないときに全部捨てる。 */
  function invalidateValues() {
    delete grid().values;
    delete grid().display;
    dropWindows();
  }

  /** 表示形式を変えたので、日付列の判定をやり直させる。 */
  function invalidateDateColumns() {
    delete grid().dateColumns;
  }

  /**
   * 行・列を足し引きしたぶん、覚えているシートの大きさを直します。
   * @param {string} key 'rowCount' か 'columnCount'
   * @param {number} delta
   */
  function growGrid_(key, delta) {
    const gridProperties = Object.assign({}, props.gridProperties || {});
    gridProperties[key] = Math.max(0, (gridProperties[key] || 0) + delta);
    props = Object.assign({}, props, { gridProperties: gridProperties });
  }

  const sheet = {
    /** @returns {string} */
    getName: function () { return props.title; },
    /** @returns {number} */
    getSheetId: function () { return props.sheetId; },
    /** @returns {Object} 親の Spreadsheet 相当オブジェクト */
    getParent: function () { return spreadsheet; },
    /** @returns {number} シートの行数（データの最終行ではない） */
    getMaxRows: function () { return (props.gridProperties && props.gridProperties.rowCount) || 0; },
    /** @returns {number} シートの列数（データの最終列ではない） */
    getMaxColumns: function () { return (props.gridProperties && props.gridProperties.columnCount) || 0; },
    /** @returns {boolean} */
    isSheetHidden: function () { return !!props.hidden; },

    // 行数・列数は書き込み後もキャッシュから数えられる（解釈し直しで行は増減しない）。
    // ログ追記のように「最終行を見て1行足す」処理が読み直しを繰り返さないようにするため。

    /** @returns {number} データのある最終行。空なら 0 */
    getLastRow: function () { return valuesCached().length; },

    /** @returns {number} データのある最終列。空なら 0 */
    getLastColumn: function () {
      return valuesCached().reduce((max, row) => Math.max(max, row.length), 0);
    },

    /**
     * `getRange(a1)` / `getRange(row, column)` /
     * `getRange(row, column, numRows)` / `getRange(row, column, numRows, numColumns)`
     * @returns {Object} Range 相当のオブジェクト
     */
    getRange: function (a, b, c, d) {
      if (typeof a === 'string') {
        const parsed = sheetsParseA1_(a);
        return sheetsMakeRange_(sheet, api, parsed.row, parsed.column,
          parsed.numRows || Math.max(1, sheet.getLastRow() - parsed.row + 1),
          parsed.numColumns || Math.max(1, sheet.getLastColumn() - parsed.column + 1));
      }
      return sheetsMakeRange_(sheet, api, a, b, c === undefined ? 1 : c, d === undefined ? 1 : d);
    },

    /** @returns {Object} データのある範囲。空なら A1 の1セル */
    getDataRange: function () {
      return sheetsMakeRange_(sheet, api, 1, 1,
        Math.max(1, sheet.getLastRow()), Math.max(1, sheet.getLastColumn()));
    },

    /**
     * 最終行の次に1行足します。
     *
     * `getLastRow()` を使うと、書き足すだけなのにシート全体を読むことになります。
     * 監査ログのように増え続けるシートでは、これが追記のたびに重くなり、
     * やがて UrlFetch の応答上限（50MB）に達して追記そのものが失敗します。
     * Sheets の `values.append` は末尾をサーバ側で探すため、読み取りが要りません。
     *
     * @param {Array} row
     */
    /**
     * 末尾を開けて読みます（`A2:C`）。データのある行だけが返るので、
     * シートの行数を知る必要がありません。追記で伸びた分も取りこぼしません。
     * @param {number} startRow 1始まり
     * @param {number} column 1始まり
     * @param {number} numColumns
     * @param {Object} [options] `options.formatted` で表示文字列、
     *   `options.dateColumns` で日付として読む列（1始まり）
     * @returns {Array[]} 矩形の二次元配列（データが無ければ空配列）
     */
    getValuesToEnd: function (startRow, column, numColumns, options) {
      const formatted = !!(options && options.formatted);
      const rows = windowToEnd_(startRow, column, numColumns, formatted);
      if (rows <= 0) return [];
      const range = sheet.getRange(startRow, column, rows, numColumns);
      return formatted ? range.getDisplayValues() : range.getValues(options);
    },

    appendRow: function (row, options) { return sheet.appendRows([row], options); },

    /**
     * 最終行の次に複数行をまとめて足します（1回の通信で書きます）。
     * @param {Array[]} rows
     * @param {Object} [options] `options.knownDateColumns` に「既に日付の表示形式が
     *   付いている列」（1始まり）を渡すと、その列には表示形式を当て直しません。
     *   当て直しは1回ぶんの通信になるため、列構成が決まっているシート
     *   （保全用の内部シートなど）では作成時に付けておき、ここで渡します。
     */
    appendRows: function (rows, options) {
      const lines = (rows || []).filter(Boolean);
      if (lines.length === 0) return sheet;
      const timeZone = spreadsheet.getSpreadsheetTimeZone();
      // Date を書いた列を覚えておく。表示形式は書いたあとに付ける（setValues と同じ理由）。
      const dateColumnOffsets = {};
      const payload = lines.map(line => line.map((v, c) => {
        if (v instanceof Date) {
          dateColumnOffsets[c] = (v.getHours() || v.getMinutes() || v.getSeconds())
            ? 'yyyy/MM/dd HH:mm:ss' : 'yyyy/MM/dd';
          return sheetsDateToSerial_(v, timeZone);
        }
        return v === undefined || v === null ? '' : v;
      }));

      const result = sheetsFetch_(
        `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/` +
        `${encodeURIComponent(sheetsQuoteTitle_(props.title))}:append` +
        '?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS', {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify({ values: payload })
        });

      // 実際に書かれた行は応答が教えてくれる（'ログ'!A123:C123 の形）。
      const updatedRange = (result && result.updates && result.updates.updatedRange) || '';
      const appendedRow = sheetsAppendedRowNumber_(updatedRange);

      // 追記した行ぶんだけキャッシュを伸ばす。ここで valuesCached() を呼ぶと
      // 全体読みが走ってしまうので、既に読み込んである時だけ手を入れる。
      const g = grid();
      if (g.values && appendedRow) {
        payload.forEach((line, offset) => {
          const index = appendedRow - 1 + offset;
          while (g.values.length <= index) g.values.push([]);
          g.values[index] = line.slice();
        });
        g.dirty = true;
      }
      delete g.display;
      dropWindows();

      // 追記でシートが伸びていることがある。覚えている行数を実態に合わせる。
      if (appendedRow) {
        const reached = appendedRow + payload.length - 1;
        if (reached > sheet.getMaxRows()) {
          growGrid_('rowCount', reached - sheet.getMaxRows());
        }
      }

      if (appendedRow) {
        const declared = (options && options.knownDateColumns) || null;
        sheetsApplyAppendedDateFormats_(
          sheet, api, appendedRow, payload.length, dateColumnOffsets, declared);
      }
      return sheet;
    },

    /**
     * @param {number} position 削除する行（1始まり）
     */
    deleteRow: function (position) { sheet.deleteRows(position, 1); },

    /**
     * @param {number} position 削除を始める行（1始まり）
     * @param {number} howMany 行数
     */
    deleteRows: function (position, howMany) {
      sheetsBatchUpdate_(spreadsheetId, [{
        deleteDimension: {
          range: {
            sheetId: props.sheetId, dimension: 'ROWS',
            startIndex: position - 1, endIndex: position - 1 + howMany
          }
        }
      }]);
      invalidateValues();
      invalidateMeta();
      growGrid_('rowCount', -howMany);
      return sheet;
    },

    /**
     * @param {number} beforePosition この行の前に1行入れる（1始まり）
     */
    insertRowBefore: function (beforePosition) {
      return sheet.insertRows_(beforePosition - 1, 1);
    },

    /**
     * @param {number} afterPosition この行の後に入れる（1始まり）
     * @param {number} [howMany]
     */
    insertRowsAfter: function (afterPosition, howMany) {
      return sheet.insertRows_(afterPosition, howMany === undefined ? 1 : howMany);
    },

    /**
     * 行を挿入します（内部用）。
     * @param {number} startIndex 0 始まりの挿入位置
     * @param {number} howMany
     */
    insertRows_: function (startIndex, howMany) {
      sheetsBatchUpdate_(spreadsheetId, [{
        insertDimension: {
          range: {
            sheetId: props.sheetId, dimension: 'ROWS',
            startIndex: startIndex, endIndex: startIndex + howMany
          },
          inheritFromBefore: startIndex > 0
        }
      }]);
      invalidateValues();
      invalidateMeta();
      growGrid_('rowCount', howMany);
      return sheet;
    },

    /**
     * @param {number} afterPosition この列の後に入れる（1始まり）
     */
    insertColumnAfter: function (afterPosition) {
      return sheet.insertColumnsAfter(afterPosition, 1);
    },

    /**
     * @param {number} afterPosition この列の後に入れる（1始まり）
     * @param {number} howMany
     */
    insertColumnsAfter: function (afterPosition, howMany) {
      sheetsBatchUpdate_(spreadsheetId, [{
        insertDimension: {
          range: {
            sheetId: props.sheetId, dimension: 'COLUMNS',
            startIndex: afterPosition, endIndex: afterPosition + howMany
          },
          inheritFromBefore: afterPosition > 0
        }
      }]);
      invalidateValues();
      invalidateMeta();
      growGrid_('columnCount', howMany);
      return sheet;
    },

    /**
     * @param {number} columnPosition 1始まり
     * @param {number} width ピクセル
     */
    setColumnWidth: function (columnPosition, width) {
      sheetsBatchUpdate_(spreadsheetId, [{
        updateDimensionProperties: {
          range: {
            sheetId: props.sheetId, dimension: 'COLUMNS',
            startIndex: columnPosition - 1, endIndex: columnPosition
          },
          properties: { pixelSize: width },
          fields: 'pixelSize'
        }
      }]);
      return sheet;
    },

    /**
     * @param {number} howMany 固定する行数
     */
    setFrozenRows: function (howMany) {
      sheetsBatchUpdate_(spreadsheetId, [{
        updateSheetProperties: {
          properties: { sheetId: props.sheetId, gridProperties: { frozenRowCount: howMany } },
          fields: 'gridProperties.frozenRowCount'
        }
      }]);
      return sheet;
    },

    /**
     * @param {string} name 新しいシート名
     */
    setName: function (name) {
      sheetsBatchUpdate_(spreadsheetId, [{
        updateSheetProperties: {
          properties: { sheetId: props.sheetId, title: name },
          fields: 'title'
        }
      }]);
      const oldTitle = props.title;
      if (state.grids[oldTitle]) {
        state.grids[name] = state.grids[oldTitle];
        delete state.grids[oldTitle];
      }
      props = Object.assign({}, props, { title: name });
      invalidateMeta();
      return sheet;
    },

    /** シートを隠します。 */
    hideSheet: function () {
      sheetsBatchUpdate_(spreadsheetId, [{
        updateSheetProperties: {
          properties: { sheetId: props.sheetId, hidden: true },
          fields: 'hidden'
        }
      }]);
      props = Object.assign({}, props, { hidden: true });
      invalidateMeta();
      return sheet;
    },

    /**
     * シートを別（または同じ）スプレッドシートへ複製します。
     * @param {Object} destination Spreadsheet 相当のオブジェクト
     * @returns {Object} 複製された Sheet 相当のオブジェクト
     */
    copyTo: function (destination) {
      const copied = sheetsFetch_(
        `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/sheets/${props.sheetId}:copyTo`, {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify({ destinationSpreadsheetId: destination.getId() })
        });
      // コピー先の構成が変わったので、そちら側のシート一覧を取り直させる
      destination.refresh_();
      return destination.getSheets().filter(s => s.getSheetId() === copied.sheetId)[0];
    },

    /**
     * シート全体を保護し、編集できる人を所有者だけにします。
     *
     * `SpreadsheetApp` の `protect()` / `addEditor()` / `removeEditors()` /
     * `setDomainEdit()` を連ねる書き方を、REST では 1 回の batchUpdate にまとめられるため、
     * 呼び出し側ごとこの 1 メソッドに置き換えています。
     * @param {string} description 保護の説明
     * @param {string} ownerEmail 編集を許す唯一のアカウント
     */
    protectWholeSheet: function (description, ownerEmail) {
      const existing = (sheetsProtectedRangesBySheet_(spreadsheetId)[props.sheetId] || []);
      const requests = existing.map(id => ({ deleteProtectedRange: { protectedRangeId: id } }));
      requests.push({
        addProtectedRange: {
          protectedRange: {
            range: { sheetId: props.sheetId },
            description: description,
            warningOnly: false,
            editors: { users: [ownerEmail], domainUsersCanEdit: false }
          }
        }
      });
      sheetsBatchUpdate_(spreadsheetId, requests);
      return sheet;
    }
  };

  // getRange から参照するための自己参照。ファサード内でだけ使う。
  const api = { values: values, valuesCached: valuesCached,
    displayValues: displayValues, dateColumns: dateColumns,
    invalidateDisplay: invalidateDisplay, invalidateValues: invalidateValues,
    invalidateDateColumns: invalidateDateColumns,
    // 日付列の判定を「取りに行かずに、分かっていれば返す」。
    // 追記のためだけに書式を取りに行くのを避けるために使う。
    peekDateColumns: function () { return grid().dateColumns || null; },
    // 全体の値も「取りに行かずに、あれば返す」。書き込み後のキャッシュ更新で使う。
    peekValues: function () { return grid().values || null; },
    window: window_, dropWindows: dropWindows,
    markDirty: function () { grid().dirty = true; },
    spreadsheetId: spreadsheetId, spreadsheet: spreadsheet,
    title: function () { return props.title; } };

  return sheet;
}

/**
 * シート全体の保護 ID を sheetId ごとに集めます。
 * @returns {Object<number, number[]>}
 */
function sheetsProtectedRangesBySheet_(spreadsheetId) {
  const fields = encodeURIComponent('sheets(properties(sheetId),protectedRanges(protectedRangeId,range))');
  const result = sheetsFetch_(`${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}?fields=${fields}`);
  const map = {};
  (result.sheets || []).forEach(s => {
    const sheetId = s.properties.sheetId;
    map[sheetId] = (s.protectedRanges || [])
      // range に行・列の指定が無いものが「シート全体の保護」
      .filter(p => !p.range || (p.range.startRowIndex === undefined && p.range.startColumnIndex === undefined))
      .map(p => p.protectedRangeId);
  });
  return map;
}

// ============================================================
// ===== Range =====
// ============================================================

/**
 * Range 相当のオブジェクトを作ります。
 * @param {Object} sheet Sheet 相当のオブジェクト
 * @param {Object} api シート内部の道具立て
 * @param {number} row 1始まり
 * @param {number} column 1始まり
 * @param {number} numRows
 * @param {number} numColumns
 * @returns {Object}
 */
function sheetsMakeRange_(sheet, api, row, column, numRows, numColumns) {
  const spreadsheetId = api.spreadsheetId;

  /** この範囲の A1 記法（シート名つき）。 */
  function a1(withSheet) {
    const from = sheetsColumnLetter_(column) + row;
    const to = sheetsColumnLetter_(column + numColumns - 1) + (row + numRows - 1);
    const body = numRows === 1 && numColumns === 1 ? from : `${from}:${to}`;
    return withSheet ? `${sheetsQuoteTitle_(api.title())}!${body}` : body;
  }

  /**
   * この範囲を矩形で切り出します。
   * `SpreadsheetApp` は必ず矩形を返すので、足りないところは '' で埋めます。
   * @param {Array[]} source シート全体と同じ座標の二次元配列
   * @param {boolean} convertDates シリアル値を Date に戻すか
   * @param {number[]} [knownDateColumns] 日付として読む列（1始まり）。
   *   渡されたときはシートの表示形式を調べません（その調査は往復1回ぶん高いため）。
   */
  function slice(source, convertDates, knownDateColumns) {
    let dateCols = null;
    if (convertDates) {
      if (knownDateColumns) {
        dateCols = {};
        knownDateColumns.forEach(c => { dateCols[c] = true; });
      } else {
        dateCols = api.dateColumns();
      }
    }
    const timeZone = api.spreadsheet.getSpreadsheetTimeZone();
    const out = [];
    for (let r = 0; r < numRows; r++) {
      const sourceRow = source[row - 1 + r] || [];
      const outRow = [];
      for (let c = 0; c < numColumns; c++) {
        let value = sourceRow[column - 1 + c];
        if (value === undefined || value === null) value = '';
        if (convertDates && typeof value === 'number' && dateCols[column + c]) {
          value = sheetsSerialToDate_(value, timeZone);
        }
        outRow.push(value);
      }
      out.push(outRow);
    }
    return out;
  }

  const range = {
    /** @returns {number} */
    getRow: function () { return row; },
    /** @returns {number} */
    getColumn: function () { return column; },
    /** @returns {number} */
    getNumRows: function () { return numRows; },
    /** @returns {number} */
    getNumColumns: function () { return numColumns; },
    /** @returns {string} */
    getA1Notation: function () { return a1(false); },
    /** @returns {Object} */
    getSheet: function () { return sheet; },

    /**
     * @param {Object} [options] `options.dateColumns` に日付として読む列（1始まり）を
     *   渡すと、シートの表示形式を調べずに済みます（その調査は往復1回ぶん高い）。
     * @returns {Array[]} 日付セルは Date に戻した二次元配列
     */
    getValues: function (options) {
      const known = options && options.dateColumns;
      return slice(api.window(row, column, numRows, numColumns, false), true, known);
    },

    /** @returns {*} 左上のセルの値 */
    getValue: function () { return range.getValues()[0][0]; },

    /** @returns {string[][]} 画面に見えているとおりの文字列 */
    getDisplayValues: function () {
      return slice(api.window(row, column, numRows, numColumns, true), false);
    },

    /**
     * 値を書き込みます。`SpreadsheetApp` と同じく `=` 始まりは数式になります。
     * @param {Array[]} values
     */
    setValues: function (values) {
      const timeZone = api.spreadsheet.getSpreadsheetTimeZone();
      let hasFormula = false;
      // Date を書いた列を覚えておく。書式が日付でない列は、書いたあとに付ける（下記）。
      const dateColumnOffsets = {};
      const payload = values.map(r => r.map((v, c) => {
        if (v instanceof Date) {
          if (dateColumnOffsets[c] === undefined) {
            dateColumnOffsets[c] = (v.getHours() || v.getMinutes() || v.getSeconds())
              ? 'yyyy/MM/dd HH:mm:ss' : 'yyyy/MM/dd';
          }
          return sheetsDateToSerial_(v, timeZone);
        }
        if (typeof v === 'string' && v.charAt(0) === '=') hasFormula = true;
        return v === undefined || v === null ? '' : v;
      }));

      sheetsFetch_(
        `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1(true))}` +
        '?valueInputOption=USER_ENTERED', {
          method: 'put',
          contentType: 'application/json',
          payload: JSON.stringify({ values: payload })
        });

      applyDateFormats(dateColumnOffsets);

      if (hasFormula) {
        // 数式の計算結果はキャッシュでは分からないので、まるごと読み直させる
        api.invalidateValues();
      } else {
        patchCache(values);
        api.invalidateDisplay();
      }
      return range;
    },

    /**
     * @param {*} value 単一の値
     */
    setValue: function (value) {
      const filled = [];
      for (let r = 0; r < numRows; r++) {
        filled.push(new Array(numColumns).fill(value));
      }
      return range.setValues(filled);
    },

    /** 値だけを消します（書式は残します）。 */
    clearContent: function () {
      sheetsFetch_(
        `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/` +
        `${encodeURIComponent(a1(true))}:clear`, {
          method: 'post',
          contentType: 'application/json',
          payload: '{}'
        });
      const blank = [];
      for (let r = 0; r < numRows; r++) blank.push(new Array(numColumns).fill(''));
      patchCache(blank);
      api.invalidateDisplay();
      return range;
    },

    /**
     * @param {string} color `#rrggbb` または既知の色名
     */
    setBackground: function (color) {
      return format({ backgroundColor: sheetsParseColor_(color) }, 'userEnteredFormat.backgroundColor');
    },

    /**
     * @param {string} color
     */
    setFontColor: function (color) {
      return format({ textFormat: { foregroundColor: sheetsParseColor_(color) } },
        'userEnteredFormat.textFormat.foregroundColor');
    },

    /**
     * @param {string} weight 'bold' または 'normal'
     */
    setFontWeight: function (weight) {
      return format({ textFormat: { bold: String(weight).toLowerCase() === 'bold' } },
        'userEnteredFormat.textFormat.bold');
    },

    /**
     * @param {string} pattern 例 'yyyy/MM/dd'
     */
    setNumberFormat: function (pattern) {
      // 'yyyy/MM/dd' のような日付書式か、そうでないかだけ見分ければ足りる
      const isDate = /[yMdHms]/.test(String(pattern)) && !/^[#0.,%]+$/.test(String(pattern));
      const type = isDate ? (/[Hms]/.test(String(pattern)) ? 'DATE_TIME' : 'DATE') : 'NUMBER';
      const result = format({ numberFormat: { type: type, pattern: pattern } },
        'userEnteredFormat.numberFormat');
      // どの列を Date に戻すかが変わるので、判定をやり直させる
      api.invalidateDateColumns();
      return result;
    }
  };

  /**
   * 書式を一括で当てます。
   * @param {Object} cellFormat userEnteredFormat の一部
   * @param {string} fields フィールドマスク
   */
  function format(cellFormat, fields) {
    sheetsBatchUpdate_(spreadsheetId, [{
      repeatCell: {
        range: {
          sheetId: sheet.getSheetId(),
          startRowIndex: row - 1, endRowIndex: row - 1 + numRows,
          startColumnIndex: column - 1, endColumnIndex: column - 1 + numColumns
        },
        cell: { userEnteredFormat: cellFormat },
        fields: fields
      }
    }]);
    return range;
  }

  /**
   * 日付を書いた列に、まだ日付の表示形式が付いていなければ付けます。
   *
   * `SpreadsheetApp` は Date を書くとセルの表示形式も日付にしてくれますが、
   * REST は数値を書くだけなので、そのままだとログの日時が「46253.5」のような
   * 数値で表示されてしまいます。書いた直後に付け直して見た目をそろえます。
   * @param {Object<number, string>} offsets 範囲内の列オフセット → 表示形式
   */
  function applyDateFormats(offsets) {
    const targets = Object.keys(offsets);
    if (targets.length === 0) return;

    // 日付列かどうかは、既に分かっているときだけ参照します。
    // 調べに行くと、シートの書式を200行ぶん取る往復（数十KB）が書き込みのたびに増えます。
    // 分からないときは付ける側に倒します（同じ書式を上書きするだけで害はありません）。
    const known = api.peekDateColumns() || {};
    const requests = targets
      .filter(offset => !known[column + Number(offset)])
      .map(offset => ({
        repeatCell: {
          range: {
            sheetId: sheet.getSheetId(),
            startRowIndex: row - 1, endRowIndex: row - 1 + numRows,
            startColumnIndex: column - 1 + Number(offset),
            endColumnIndex: column + Number(offset)
          },
          cell: {
            userEnteredFormat: {
              numberFormat: {
                type: offsets[offset].indexOf('H') >= 0 ? 'DATE_TIME' : 'DATE',
                pattern: offsets[offset]
              }
            }
          },
          fields: 'userEnteredFormat.numberFormat'
        }
      }));
    if (requests.length === 0) return;

    sheetsBatchUpdate_(spreadsheetId, requests);
    // どの列を Date に戻すかが変わったので、判定をやり直させる
    api.invalidateDateColumns();
  }

  /**
   * 書き込んだ内容をキャッシュにも反映し、「次に中身を読むときは読み直す」印をつけます。
   *
   * 反映するのは行数・列数を正しく保つためで、値そのものは信用しません。
   * スプレッドシートが書き込んだ値を解釈し直す（"1/3" → 日付）ので、
   * 中身を読むときは必ずシートから取り直します。
   * @param {Array[]} values
   */
  function patchCache(values) {
    // 書いたので、範囲だけ読んで持っていた分は当てにならない。
    api.dropWindows();
    // まだシート全体を読んでいないなら、ここで読みに行かない。
    // 書き込みのたびに全体を取ることになり、範囲読みにした意味が無くなる。
    const grid = api.peekValues();
    if (!grid) return;
    for (let r = 0; r < values.length; r++) {
      const targetRow = row - 1 + r;
      while (grid.length <= targetRow) grid.push([]);
      const line = grid[targetRow];
      for (let c = 0; c < values[r].length; c++) {
        const targetColumn = column - 1 + c;
        while (line.length < targetColumn) line.push('');
        let value = values[r][c];
        line[targetColumn] = (value === undefined || value === null) ? '' : value;
      }
    }
    api.markDirty();
  }

  return range;
}
