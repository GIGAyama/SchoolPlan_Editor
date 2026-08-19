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
 * 指定したグループに「閲覧可」を付与します。
 *
 * Classroom に添付したファイルを、そのクラスの参加者だけが開けるようにするために使います。
 * 宛先には Classroom がコースごとに維持しているグループ（courseGroupEmail）を渡します。
 *
 * **「リンクを知っている全員（type: 'anyone'）」は使わないこと。**
 * 学級通信には児童の氏名や写真が入るため、URLが出回れば誰でも開ける状態になる。
 * 以前はそうしていたが、印刷用にPDFを作っただけでも全世界公開になっていた
 * （docs/LEGAL_RISK_AUDIT_JP.md の A-1）。範囲を広げる必要が出た場合でも、
 * anyone ではなく type:'domain' でドメインを限定すること。
 *
 * 通知メールは送らない。コースのグループはメールを受け取る用途のものではなく、
 * 権限を付けるたびに参加者へメールが飛ぶのは意図しない挙動になる。
 * @param {string} fileId
 * @param {string} groupEmail 権限を与えるグループのメールアドレス
 */
function driveShareReaderWithGroup_(fileId, groupEmail) {
  driveFetch_(
    `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/permissions`
    + `?fields=id&sendNotificationEmail=false`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ role: 'reader', type: 'group', emailAddress: groupEmail })
    });
}

// このアプリが作ったファイルの控え（用途名 → 直近のファイルID）。
// 利用者ごとに分けるため UserProperties に置く。
const UP_KEY_APP_CREATED_FILES = 'up_appCreatedFileIds';

/**
 * このアプリが作り直したファイルについて、前回のものをごみ箱へ送り、今回のものを控えます。
 *
 * 以前は「同じ名前のファイルを探して全部ごみ箱へ」という作り方だった。
 * `drive.file` では見えるのが「アプリが作った／利用者が選んだファイル」に限られるため、
 * 先生の無関係なファイルまで消える心配は無い。ただし**利用者がピッカーで選んだファイル**
 * （行事予定のPDFなど）は見える範囲に入るので、名前がたまたま一致すれば対象になり得る。
 * 消えるのが児童の情報を含む成果物である以上、範囲は狭いほうがよい。
 * 名前ではなく、自分が作ったファイルのIDだけを対象にする
 * （docs/LEGAL_RISK_AUDIT_JP.md の C-3）。
 *
 * 控えが無いとき（この修正より前に作られたファイル）は、何も消さない。
 * 消し損ねて同名ファイルが並ぶほうが、他人のファイルを消すよりずっとましなので。
 * 失敗しても処理は続けます。
 * @param {string} slot 用途を表す名前（例: '学級通信PDF'）。ファイル名そのものでなくてよい
 * @param {string} newFileId 今回作ったファイルのID
 */
function driveReplacePreviousAppFile_(slot, newFileId) {
  let map = {};
  try {
    map = JSON.parse(tGetProp_(UP_KEY_APP_CREATED_FILES) || '{}');
  } catch (e) {
    map = {};
  }

  const previousId = map[slot];
  if (previousId && previousId !== newFileId) {
    try {
      driveSetTrashed_(previousId, true);
    } catch (e) {
      // 利用者が自分で消していた場合など。控えは更新して先へ進む。
      logInfo(`前回のファイルを整理できませんでした（${slot}）: ${e.message}`);
    }
  }

  try {
    map[slot] = newFileId;
    tSetProp_(UP_KEY_APP_CREATED_FILES, JSON.stringify(map));
  } catch (e) {
    logInfo(`作成したファイルの控えを保存できませんでした（${slot}）: ${e.message}`);
  }
}
