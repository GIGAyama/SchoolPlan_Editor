/**
 * @fileoverview Drive REST API (v3) の薄いラッパー。
 *
 * ## なぜ DriveApp を使わないのか
 *
 * Apps Script 組み込みの `DriveApp` は **`drive.file` スコープでは動きません**。
 * `DriveApp.createFile` / `getFileById` / `getFilesByName` などを呼ぶと、
 * 実行時に次のエラーになります。
 *
 *   「指定された権限では DriveApp.createFile を呼び出すことができません。
 *     必要な権限: https://www.googleapis.com/auth/drive」
 *
 * つまり DriveApp を使う限り、Drive 全体へのアクセス権を要求することになります。
 * 本アプリは「アプリが作ったファイルと、先生がピッカーで選んだファイルだけ」を
 * 扱う方針（`drive.file`）なので、Drive 操作はすべて REST API v3 を
 * `UrlFetchApp` + `ScriptApp.getOAuthToken()` で直接呼びます。
 * REST API v3 は `drive.file` を正しく解釈し、アプリ所有／ユーザーが選択した
 * ファイルだけを対象にします。
 *
 * この方針は 00_config.gs のスコープ方針および docs/B1_DRIVE_SCOPE_AUDIT.md と対応します。
 */

/** Drive REST API のベース URL */
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

/**
 * Drive API を呼び出します。2xx 以外は例外にします。
 * @param {string} url 完全な URL
 * @param {Object} [options] UrlFetchApp のオプション（headers は上書きされます）
 * @param {boolean} [raw] true なら HTTPResponse をそのまま返す（バイナリ取得用）
 * @returns {Object|GoogleAppsScript.URL_Fetch.HTTPResponse}
 */
function driveFetch_(url, options, raw) {
  const opts = options || {};
  const headers = Object.assign({}, opts.headers || {}, {
    Authorization: 'Bearer ' + ScriptApp.getOAuthToken()
  });
  const response = UrlFetchApp.fetch(url, Object.assign({}, opts, {
    headers: headers,
    muteHttpExceptions: true
  }));
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    let message = response.getContentText();
    try {
      const parsed = JSON.parse(message);
      if (parsed && parsed.error && parsed.error.message) message = parsed.error.message;
    } catch (ignore) { /* JSON でなければ本文をそのまま使う */ }
    // 「API がオンになっていない」は権限の問題と紛らわしいので言い換える
    throw new Error(describeApiDisabledError_('Google Drive API', code, message));
  }
  if (raw) return response;
  const text = response.getContentText();
  return text ? JSON.parse(text) : {};
}

/**
 * ファイルを新規作成します（マイドライブ直下・アプリ所有）。
 *
 * 本文の送信は `uploadType=media` で行い、名前はそのあとに PATCH で設定します。
 * multipart で送るとバイナリを文字列連結することになり PDF が壊れるためです。
 *
 * @param {string} name ファイル名
 * @param {GoogleAppsScript.Base.Blob|string} content Blob または文字列
 * @param {string} [mimeType] content が文字列のときの MIME タイプ
 * @returns {{id: string, name: string}}
 */
function driveCreateFile_(name, content, mimeType) {
  const blob = (typeof content === 'string')
    ? Utilities.newBlob(content, mimeType || 'text/plain', name)
    : content;

  const created = driveFetch_(`${DRIVE_UPLOAD_BASE}/files?uploadType=media&fields=id`, {
    method: 'post',
    contentType: blob.getContentType() || mimeType || 'application/octet-stream',
    payload: blob.getBytes()
  });

  // uploadType=media では名前を指定できないため、作成後に付け直す
  const named = driveFetch_(`${DRIVE_API_BASE}/files/${created.id}?fields=id,name`, {
    method: 'patch',
    contentType: 'application/json',
    payload: JSON.stringify({ name: name })
  });
  return named;
}

/**
 * HTML などを Google ドキュメント形式に変換してアップロードします。
 * 変換は作成時のメタデータで指定する必要があるため multipart を使います
 * （本文がテキストなので文字列連結で問題ありません）。
 *
 * @param {string} name ファイル名
 * @param {string} content 本文（テキスト）
 * @param {string} sourceContentType 例 'text/html'
 * @param {string} targetMimeType 例 'application/vnd.google-apps.document'
 * @returns {{id: string, name: string}}
 */
function driveCreateConverted_(name, content, sourceContentType, targetMimeType) {
  const boundary = 'nw_boundary_' + Utilities.getUuid();
  const metadata = JSON.stringify({ name: name, mimeType: targetMimeType });
  const payload =
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    metadata + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: ' + sourceContentType + '; charset=UTF-8\r\n\r\n' +
    content + '\r\n' +
    '--' + boundary + '--';

  return driveFetch_(`${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name`, {
    method: 'post',
    contentType: 'multipart/related; boundary=' + boundary,
    payload: Utilities.newBlob(payload).getBytes()
  });
}

/**
 * 名前でファイルを検索します。
 * `drive.file` では**アプリが作った／ユーザーが選んだファイルだけ**が対象になるため、
 * 先生の他のファイルが引っかかることはありません。
 * @param {string} name ファイル名（完全一致）
 * @returns {{id: string, name: string}[]}
 */
function driveFindByName_(name) {
  const query = encodeURIComponent(`name = '${String(name).replace(/'/g, "\\'")}' and trashed = false`);
  const result = driveFetch_(`${DRIVE_API_BASE}/files?q=${query}&fields=files(id,name)&pageSize=100`);
  return result.files || [];
}

/**
 * ファイルのメタデータを取得します。
 * @param {string} fileId
 * @param {string} [fields] 例 'id,name,webViewLink,webContentLink'
 * @returns {Object}
 */
function driveGetMeta_(fileId, fields) {
  const query = fields ? `?fields=${encodeURIComponent(fields)}` : '';
  return driveFetch_(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}${query}`);
}

/**
 * ファイルの中身を Blob で取得します。
 * @param {string} fileId
 * @returns {GoogleAppsScript.Base.Blob}
 */
function driveGetBlob_(fileId) {
  const response = driveFetch_(
    `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`, {}, true);
  return response.getBlob();
}

/**
 * `DriveApp.getFileById()` の置き換え。
 * 既存の呼び出し側が使う `getId()` / `getName()` / `getBlob()` だけを備えた
 * 読み取り用のオブジェクトを返します。本文は必要になったときに1度だけ取得します。
 * @param {string} fileId
 * @returns {{getId:function():string, getName:function():string,
 *            getMimeType:function():string, getBlob:function():GoogleAppsScript.Base.Blob}}
 */
function driveOpenFile_(fileId) {
  const meta = driveGetMeta_(fileId, 'id,name,mimeType');
  let blob = null;
  return {
    getId: function () { return meta.id; },
    getName: function () { return meta.name; },
    getMimeType: function () { return meta.mimeType; },
    getBlob: function () {
      if (!blob) blob = driveGetBlob_(meta.id).setName(meta.name);
      return blob;
    }
  };
}

/**
 * フォルダ直下の PDF を列挙します。
 * `drive.file` では、そのフォルダを先生がピッカーで選んでいる場合にだけ中身が見えます。
 * @param {string} folderId
 * @returns {{id: string, name: string}[]}
 */
function driveListPdfsInFolder_(folderId) {
  const query = encodeURIComponent(
    `'${String(folderId).replace(/'/g, "\\'")}' in parents and mimeType = 'application/pdf' and trashed = false`);
  const result = driveFetch_(`${DRIVE_API_BASE}/files?q=${query}&fields=files(id,name)&pageSize=200`);
  return result.files || [];
}

/**
 * ファイルをごみ箱へ移動／復元します。
 * @param {string} fileId
 * @param {boolean} trashed true でごみ箱へ、false で復元
 */
function driveSetTrashed_(fileId, trashed) {
  driveFetch_(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=id`, {
    method: 'patch',
    contentType: 'application/json',
    payload: JSON.stringify({ trashed: !!trashed })
  });
}

/**
 * ファイルを複製します。
 * @param {string} fileId 複製元
 * @param {string} name 複製後の名前
 * @returns {{id: string, name: string}}
 */
function driveCopyFile_(fileId, name) {
  return driveFetch_(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/copy?fields=id,name`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ name: name })
  });
}

/**
 * 「リンクを知っている全員が閲覧可」を付与します。
 * Classroom に添付したファイルを児童・保護者が開けるようにするために使います。
 * @param {string} fileId
 */
function driveShareAnyoneWithLink_(fileId) {
  driveFetch_(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/permissions?fields=id`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ role: 'reader', type: 'anyone' })
  });
}

/**
 * 同じ名前の古いファイルをごみ箱へ送ります（作り直し前の後始末）。
 * 失敗しても処理は続けます。
 * @param {string} name
 */
function driveTrashByName_(name) {
  try {
    driveFindByName_(name).forEach(function (file) {
      try { driveSetTrashed_(file.id, true); } catch (ignore) { /* 個別の失敗は無視 */ }
    });
  } catch (e) {
    logInfo(`古いファイルの整理をスキップしました: ${name} (${e.message})`);
  }
}
