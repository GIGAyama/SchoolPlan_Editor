/**
 * @fileoverview Phase 3: データ保全・復元・監査・安全なマイグレーション
 *
 * 設計原則:
 * - 既存の週案・シート列を勝手に移動しない
 * - 破壊的操作の前に復元可能な状態を残す
 * - 機密情報を監査ログやバックアップ設定へ保存しない
 * - OAuthスコープを追加せず、drive.file の範囲だけで動作する（spreadsheets は要求しない）
 */

const P3_SCHEMA_VERSION_ = 4;
const P3_META_SHEET_ = '_週案_メタ';
const P3_AUDIT_SHEET_ = '_週案_監査ログ';
const P3_SNAPSHOT_SHEET_ = '_週案_復元ポイント';
const P3_TRASH_SHEET_ = '_週案_ごみ箱';

const P3_BACKUP_RETENTION_DAYS_ = 30;
// バックアップは別スプレッドシートとしてマイドライブ直下に並ぶため、世代数を絞って
// ドライブが散らからないようにする。これを超えた分は作成・一覧表示のたびに掃除される。
const P3_BACKUP_MAX_COUNT_ = 4;
const P3_SNAPSHOT_RETENTION_DAYS_ = 90;
const P3_SNAPSHOT_MAX_COUNT_ = 300;
const P3_AUTO_SNAPSHOT_INTERVAL_MINUTES_ = 30;
const P3_AUTO_SNAPSHOT_MAX_PER_SCOPE_ = 10;
const P3_TRASH_RETENTION_DAYS_ = 30;
const P3_CHUNK_SIZE_ = 42000;

const P3_META_HEADERS_ = ['Key', 'Value', 'UpdatedAt'];
const P3_AUDIT_HEADERS_ = [
  'AuditID', 'At', 'Actor', 'Action', 'EntityType', 'EntityId',
  'Summary', 'BeforeJson', 'AfterJson', 'CorrelationId'
];
const P3_SNAPSHOT_HEADERS_ = [
  'SnapshotID', 'CreatedAt', 'Actor', 'Type', 'Scope', 'Label', 'ExpiresAt',
  'ChunkIndex', 'ChunkCount', 'Payload'
];
// Payload を除いた見出しの数。一覧・期限切れ判定・件数制限はこの範囲しか見ない。
// Payload まで読むと、保持上限（90日/300件）に達したシートでは1回の保存で
// 数MBを運ぶことになる。中身が要るのは p3ReadSnapshot_ だけ。
const P3_SNAPSHOT_META_WIDTH_ = P3_SNAPSHOT_HEADERS_.length - 1;
const P3_TRASH_HEADERS_ = [
  'TrashID', 'DeletedAt', 'ExpiresAt', 'Actor', 'EntityType', 'EntityId',
  'Label', 'Payload'
];

// 内部シートのうち日付を入れる列（1始まり）。
//
// REST は日付を数値として書くので、表示形式を付けないと「46253.5」のように見える。
// 以前は追記のたびに付け直していたが、それだけで1回の通信になっていた。
// 列構成は決まっているので、シートを作るときに列まるごとへ付けておき、
// 追記時は「もう付いている」と伝えるだけにする（appendRows の knownDateColumns）。
const P3_META_DATE_COLUMNS_ = [3];        // UpdatedAt
const P3_AUDIT_DATE_COLUMNS_ = [2];       // At
const P3_SNAPSHOT_DATE_COLUMNS_ = [2, 7]; // CreatedAt / ExpiresAt
const P3_TRASH_DATE_COLUMNS_ = [2, 3];    // DeletedAt / ExpiresAt

function p3NowIso_() {
  return new Date().toISOString();
}

function p3TodayKey_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Tokyo', 'yyyy-MM-dd');
}

function p3Actor_() {
  try {
    return Session.getActiveUser().getEmail()
      || Session.getEffectiveUser().getEmail()
      || 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

function p3HideInternalSheet_(sheet) {
  try {
    if (!sheet.isSheetHidden()) sheet.hideSheet();
  } catch (e) {
    // 少なくとも1枚は表示シートが必要なため、非表示化できない場合は継続する。
  }
}

/**
 * 保全用の内部シートを用意します。
 *
 * @param {Object} ss スプレッドシート
 * @param {string} name シート名
 * @param {string[]} headers 見出し行
 * @param {Object} [options] `options.trustExisting` を立てると、既にあるシートは
 *   見出しの確認も装飾もせずそのまま返します。見出しを1行読むだけでもシート全体の
 *   取得になるため、監査ログのように増え続けるシートでは、この確認が保存のたびに
 *   重くのしかかります。確認そのものは `p3EnsureInternalSheets_` が定期的に行います。
 *   `options.dateColumns` には日付を入れる列（1始まり）を渡します。
 * @returns {Object} Sheet 相当のオブジェクト
 */
function p3EnsureSheet_(ss, name, headers, options) {
  let sheet = ss.getSheetByName(name);
  const created = !sheet;
  if (!sheet) sheet = ss.insertSheet(name, ss.getSheets().length);

  // 作ったばかりのシートは、見出しも装飾もこれから付ける必要があるので素通ししない。
  if (!created && options && options.trustExisting) return sheet;

  const requiredWidth = headers.length;
  if (sheet.getMaxColumns() < requiredWidth) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), requiredWidth - sheet.getMaxColumns());
  }

  const existing = sheet.getRange(1, 1, 1, requiredWidth).getDisplayValues()[0];
  const isEmpty = existing.every(v => !String(v || '').trim());
  if (isEmpty) {
    sheet.getRange(1, 1, 1, requiredWidth).setValues([headers]);
  } else {
    const currentHeaders = sheet.getRange(1, 1, 1, Math.max(requiredWidth, sheet.getLastColumn()))
      .getDisplayValues()[0];
    headers.forEach((header, index) => {
      if (!currentHeaders[index]) sheet.getRange(1, index + 1).setValue(header);
    });
  }

  sheet.getRange(1, 1, 1, requiredWidth)
    .setFontWeight('bold')
    .setBackground('#263238')
    .setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  // 日付列は、ここで列まるごとに表示形式を付けておく。
  // 追記のたびに付け直すと、そのぶん通信が増えるため。
  ((options && options.dateColumns) || []).forEach(column => {
    sheet.getRange(2, column, Math.max(1, sheet.getMaxRows() - 1), 1)
      .setNumberFormat('yyyy/MM/dd HH:mm:ss');
  });
  p3HideInternalSheet_(sheet);
  return sheet;
}

// p3EnsureSheet_ はシートごとに読取+装飾書込を伴うため、1回のリクエスト内で
// 何度も呼ばれる保存・監査・ごみ箱操作の負荷を実行内メモ化で抑える。
let p3SheetsMemo_ = null;

/** 内部シートの構成を確認し直す間隔（秒）。 */
const P3_SHEETS_VERIFY_INTERVAL_SECONDS_ = 21600; // 6時間

/**
 * 内部シートの構成を「今回は確認しなくてよい」かどうかを返します。
 *
 * 実行内メモ化（`p3SheetsMemo_`）は1回の実行の中でしか効きません。週案の保存は
 * 1回ごとが別の実行なので、確認の一式（見出しの読取と装飾4回の書込）が保存のたびに
 * まるごと走っていました。内部シートを書き換えるのはアプリ自身だけなので、
 * 確認は起動時と6時間ごとで足ります。
 *
 * 見つからないシートは、確認を省いた回でも `p3EnsureSheet_` が作り直します。
 * ここで省くのは「既にあるシートの見出しと見た目の点検」だけです。
 * @param {string} spreadsheetId
 * @returns {{trusted: boolean, remember: function()}}
 */
function p3SheetsVerification_(spreadsheetId) {
  const key = 'p3SheetsVerified::' + spreadsheetId + '::v' + P3_SCHEMA_VERSION_;
  // 保存の中でここは2回通る。tCacheGet_ は1回の実行で一度しか取りに行かない。
  const trusted = !!tCacheGet_(key);
  return {
    trusted: trusted,
    remember: function () {
      tCachePut_(key, '1', P3_SHEETS_VERIFY_INTERVAL_SECONDS_);
    }
  };
}

function p3EnsureInternalSheets_(ss) {
  if (p3SheetsMemo_ && p3SheetsMemo_.id === ss.getId()) return p3SheetsMemo_.sheets;
  const verification = p3SheetsVerification_(ss.getId());
  const options = { trustExisting: verification.trusted };
  const withDates = columns => Object.assign({}, options, { dateColumns: columns });
  const sheets = {
    meta: p3EnsureSheet_(ss, P3_META_SHEET_, P3_META_HEADERS_, withDates(P3_META_DATE_COLUMNS_)),
    audit: p3EnsureSheet_(ss, P3_AUDIT_SHEET_, P3_AUDIT_HEADERS_, withDates(P3_AUDIT_DATE_COLUMNS_)),
    snapshots: p3EnsureSheet_(ss, P3_SNAPSHOT_SHEET_, P3_SNAPSHOT_HEADERS_, withDates(P3_SNAPSHOT_DATE_COLUMNS_)),
    trash: p3EnsureSheet_(ss, P3_TRASH_SHEET_, P3_TRASH_HEADERS_, withDates(P3_TRASH_DATE_COLUMNS_))
  };
  if (!verification.trusted) verification.remember();
  p3SheetsMemo_ = { id: ss.getId(), sheets };
  return sheets;
}

function p3MetaGet_(ss, key) {
  const sheet = p3EnsureInternalSheets_(ss).meta;
  // 末尾を開けて読む。getLastRow() はシート全体の読み込みを伴い、
  // getMaxRows() は追記で伸びた分をすぐには反映しない。
  const values = sheet.getValuesToEnd(2, 1, 2, { formatted: true });
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === key) return values[i][1] || '';
  }
  return '';
}

function p3MetaSet_(ss, key, value) {
  const sheet = p3EnsureInternalSheets_(ss).meta;
  {
    const keys = sheet.getValuesToEnd(2, 1, 1, { formatted: true });
    for (let i = 0; i < keys.length; i++) {
      if (keys[i][0] === key) {
        sheet.getRange(i + 2, 2, 1, 2).setValues([[String(value), new Date()]]);
        return;
      }
    }
  }
  sheet.appendRow([key, String(value), new Date()], { knownDateColumns: P3_META_DATE_COLUMNS_ });
}

function p3GetSchemaVersion_(ss) {
  const raw = p3MetaGet_(ss, 'schemaVersion');
  const version = parseInt(raw, 10);
  return isNaN(version) ? 0 : version;
}

function p3Redact_(value, depth) {
  depth = depth || 0;
  if (depth > 8) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 200).map(v => p3Redact_(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    Object.keys(value).slice(0, 200).forEach(key => {
      if (/api.?key|token|secret|password|authorization|credential/i.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = p3Redact_(value[key], depth + 1);
      }
    });
    return out;
  }
  if (typeof value === 'string') return value.substring(0, 30000);
  return value;
}

function p3Json_(value, maxLength) {
  let text;
  try {
    text = JSON.stringify(p3Redact_(value));
  } catch (e) {
    text = JSON.stringify({ serializationError: e.message });
  }
  const limit = maxLength || 30000;
  return text.length > limit ? text.substring(0, limit) + '…' : text;
}

/** 監査ログの Before/After 1件あたりの上限（文字）。これを超える値は要約に畳む。 */
const P3_AUDIT_VALUE_MAX_ = 512;

/**
 * 監査ログに残す値を、中身ではなく「かたち」に畳みます。
 *
 * 配列は件数だけ、入れ子のオブジェクトは `{…}` にします。
 * revision・snapshotId・trashId のような手がかりはスカラーなのでそのまま残ります。
 * @param {*} value
 * @param {number} [depth]
 * @returns {*}
 */
function p3AuditOutline_(value, depth) {
  depth = depth || 0;
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return '[' + value.length + '件]';
  if (typeof value === 'object') {
    if (depth >= 1) return '{…}';
    const out = {};
    Object.keys(value).slice(0, 30).forEach(key => {
      out[key] = p3AuditOutline_(value[key], depth + 1);
    });
    return out;
  }
  const text = String(value);
  return text.length > 120 ? text.substring(0, 120) + '…' : text;
}

/**
 * 監査ログの Before/After に書く値を決めます。
 *
 * 監査ログは「いつ・誰が・何をしたか」の記録であって、中身を戻すためのものでは
 * ありません。戻すのは復元ポイント・ごみ箱・完全バックアップの役目です
 * （docs/PHASE3_DATA_PROTECTION.md）。
 *
 * 以前は週案1回の保存で、保存前後の週データを丸ごと2つ書いていました。1行あたり
 * 約10KBになるうえ、このシートには保持期限がありません。読み出しているのは
 * `listAuditLogFromWeb` だけで、そこは Before/After を返していないため、
 * **書かれるだけで誰も読まない中身**がシートを太らせ続けていました。
 *
 * そこで、小さい値はそのまま残し、大きい値は手がかり（revision・snapshotId など）と
 * 件数だけに畳みます。復元ポイントIDが残るので、中身が要るときはそちらを辿れます。
 * @param {*} value
 * @returns {*}
 */
function p3AuditValue_(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  // 上限より十分大きい所で切って長さを見る（全体を組み立て直さないため）
  const json = p3Json_(value, P3_AUDIT_VALUE_MAX_ * 4);
  if (json.length <= P3_AUDIT_VALUE_MAX_) return value;
  return p3AuditOutline_(value);
}

function p3RecordAudit_(action, entityType, entityId, summary, beforeValue, afterValue, correlationId) {
  try {
    const ss = getSs_();
    const sheet = p3EnsureInternalSheets_(ss).audit;
    sheet.appendRow([
      'aud_' + Utilities.getUuid(),
      new Date(),
      p3Actor_(),
      String(action || '').substring(0, 80),
      String(entityType || '').substring(0, 80),
      String(entityId || '').substring(0, 500),
      String(summary || '').substring(0, 5000),
      p3Json_(p3AuditValue_(beforeValue), P3_AUDIT_VALUE_MAX_),
      p3Json_(p3AuditValue_(afterValue), P3_AUDIT_VALUE_MAX_),
      correlationId || ''
    ], { knownDateColumns: P3_AUDIT_DATE_COLUMNS_ });
  } catch (e) {
    console.error('監査ログの記録に失敗: ' + e.message);
  }
}

// LockService のロックは実行単位で保持されるため、同一実行内で二重に waitLock すると
// 挙動が保証されない。ネストした取得は「外側が既に保持している」とみなして素通しする。
let p3UserLockDepth_ = 0;

function p3RunHoldingUserLock_(fn) {
  p3UserLockDepth_++;
  try {
    return fn();
  } finally {
    p3UserLockDepth_--;
  }
}

/** ユーザー単位のロックを取得して fn を実行する。取得できなければ例外を投げる。 */
function p3WithUserLock_(timeoutMs, fn) {
  if (p3UserLockDepth_ > 0) return p3RunHoldingUserLock_(fn);
  const lock = LockService.getUserLock();
  lock.waitLock(timeoutMs);
  try {
    return p3RunHoldingUserLock_(fn);
  } finally {
    lock.releaseLock();
  }
}

/** ロックを取れなければ待たずに busyValue を返す。重複実行を捨ててよい処理に使う。 */
function p3TryWithUserLock_(timeoutMs, fn, busyValue) {
  if (p3UserLockDepth_ > 0) return p3RunHoldingUserLock_(fn);
  const lock = LockService.getUserLock();
  if (!lock.tryLock(timeoutMs)) return busyValue;
  try {
    return p3RunHoldingUserLock_(fn);
  } finally {
    lock.releaseLock();
  }
}

function p3MigrationV1_(ss) {
  p3EnsureInternalSheets_(ss);
  p3MetaSet_(ss, 'protectionCreatedAt', p3NowIso_());
}

function p3MigrationV2_(ss) {
  p3MetaSet_(ss, 'backupRetentionDays', P3_BACKUP_RETENTION_DAYS_);
  p3MetaSet_(ss, 'snapshotRetentionDays', P3_SNAPSHOT_RETENTION_DAYS_);
  p3MetaSet_(ss, 'trashRetentionDays', P3_TRASH_RETENTION_DAYS_);
}

function p3MigrationV3_(ss) {
  p3MetaSet_(ss, 'protectionMode', 'active-open-daily-backup');
  p3MetaSet_(ss, 'lastIntegrityCheckAt', '');
}

function p3MigrationV4_(ss) {
  p3MetaSet_(ss, 'backupMaxCount', P3_BACKUP_MAX_COUNT_);
  // 既存ユーザーの挙動を変えないよう、日次バックアップは有効のまま引き継ぐ。
  if (p3MetaGet_(ss, 'dailyBackupEnabled') === '') p3MetaSet_(ss, 'dailyBackupEnabled', '1');
}

function p3RunMigrations_(ss) {
  return p3WithUserLock_(10000, () => {
    let version = p3GetSchemaVersion_(ss);
    if (version > P3_SCHEMA_VERSION_) {
      throw new Error('このデータベースは現在のアプリより新しいスキーマです。アプリを最新版へ更新してください。');
    }

    const migrations = [
      { version: 1, name: '保全用内部シート作成', run: p3MigrationV1_ },
      { version: 2, name: '保持期間設定', run: p3MigrationV2_ },
      { version: 3, name: '日次バックアップ方式設定', run: p3MigrationV3_ },
      { version: 4, name: 'バックアップ世代数と自動作成の切替設定', run: p3MigrationV4_ }
    ];

    const applied = [];
    migrations.forEach(migration => {
      if (version >= migration.version) return;
      migration.run(ss);
      version = migration.version;
      p3MetaSet_(ss, 'schemaVersion', version);
      applied.push(migration.name);
    });

    if (applied.length > 0) {
      p3RecordAudit_(
        'SCHEMA_MIGRATION', 'database', ss.getId(),
        'データ保全スキーマを更新: ' + applied.join(' / '),
        null, { version, applied }, 'mig_' + Utilities.getUuid()
      );
    }
    return { success: true, version, applied };
  });
}

function ensureDataProtectionReady_() {
  const ss = getSs_();
  const verification = p3SheetsVerification_(ss.getId());

  // スキーマ版の確認は、内部シートの点検と同じ枠（6時間）で行う。
  //
  // 確認そのものはメタシートを1回読むだけだが、週案の自動保存は450msの間隔で
  // 走るため、そのたびに1往復を足すと保存時間のうち無視できない割合になる。
  // 内部シートを書き換えるのはアプリ自身だけなので、点検と同じ頻度で足りる。
  //
  // 「アプリより新しいスキーマなら止める」という守りは、確認する回に働く。
  // 点検を省いた回にすり抜けうるのは、点検そのものと同じ最大6時間の窓であり、
  // 新しく増える危険ではない。
  if (verification.trusted) {
    return { success: true, version: P3_SCHEMA_VERSION_, applied: [] };
  }

  const result = p3RunMigrations_(ss);
  // 期限切れ掃除は全行走査+deleteRowループを伴うため、毎回ではなく
  // ユーザー・スプレッドシート単位で6時間に1回に間引く(掃除失敗は本処理を妨げない)。
  try {
    const cacheKey = 'p3CleanupDone::' + ss.getId();
    if (!tCacheGet_(cacheKey)) {
      p3CleanupExpiredTrash_(ss);
      p3CleanupSnapshots_(ss);
      tCachePut_(cacheKey, '1', 21600);
    }
  } catch (e) {
    logError('ensureDataProtectionReady_:cleanup', e);
  }
  return result;
}

function runDataMigrationsFromWeb() {
  try {
    return p3RunMigrations_(getSs_());
  } catch (e) {
    logError('runDataMigrationsFromWeb', e);
    return { success: false, error: e.message };
  }
}
