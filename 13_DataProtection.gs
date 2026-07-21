/**
 * @fileoverview Phase 3: データ保全・復元・監査・安全なマイグレーション
 *
 * 設計原則:
 * - 既存の週案・シート列を勝手に移動しない
 * - 破壊的操作の前に復元可能な状態を残す
 * - 機密情報を監査ログやバックアップ設定へ保存しない
 * - OAuthスコープを追加せず、spreadsheets + drive.file の範囲で動作する
 */

const P3_SCHEMA_VERSION_ = 3;
const P3_META_SHEET_ = '_週案_メタ';
const P3_AUDIT_SHEET_ = '_週案_監査ログ';
const P3_SNAPSHOT_SHEET_ = '_週案_復元ポイント';
const P3_TRASH_SHEET_ = '_週案_ごみ箱';

const P3_BACKUP_RETENTION_DAYS_ = 30;
const P3_BACKUP_MAX_COUNT_ = 10;
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
const P3_TRASH_HEADERS_ = [
  'TrashID', 'DeletedAt', 'ExpiresAt', 'Actor', 'EntityType', 'EntityId',
  'Label', 'Payload'
];

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

function p3EnsureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name, ss.getSheets().length);

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
  p3HideInternalSheet_(sheet);
  return sheet;
}

function p3EnsureInternalSheets_(ss) {
  return {
    meta: p3EnsureSheet_(ss, P3_META_SHEET_, P3_META_HEADERS_),
    audit: p3EnsureSheet_(ss, P3_AUDIT_SHEET_, P3_AUDIT_HEADERS_),
    snapshots: p3EnsureSheet_(ss, P3_SNAPSHOT_SHEET_, P3_SNAPSHOT_HEADERS_),
    trash: p3EnsureSheet_(ss, P3_TRASH_SHEET_, P3_TRASH_HEADERS_)
  };
}

function p3MetaGet_(ss, key) {
  const sheet = p3EnsureInternalSheets_(ss).meta;
  if (sheet.getLastRow() < 2) return '';
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getDisplayValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === key) return values[i][1] || '';
  }
  return '';
}

function p3MetaSet_(ss, key, value) {
  const sheet = p3EnsureInternalSheets_(ss).meta;
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const keys = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
    for (let i = 0; i < keys.length; i++) {
      if (keys[i][0] === key) {
        sheet.getRange(i + 2, 2, 1, 2).setValues([[String(value), new Date()]]);
        return;
      }
    }
  }
  sheet.appendRow([key, String(value), new Date()]);
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
      p3Json_(beforeValue, 20000),
      p3Json_(afterValue, 20000),
      correlationId || ''
    ]);
  } catch (e) {
    console.error('監査ログの記録に失敗: ' + e.message);
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

function p3RunMigrations_(ss) {
  const lock = LockService.getUserLock();
  let locked = false;
  try {
    lock.waitLock(10000);
    locked = true;
    let version = p3GetSchemaVersion_(ss);
    if (version > P3_SCHEMA_VERSION_) {
      throw new Error('このデータベースは現在のアプリより新しいスキーマです。アプリを最新版へ更新してください。');
    }

    const migrations = [
      { version: 1, name: '保全用内部シート作成', run: p3MigrationV1_ },
      { version: 2, name: '保持期間設定', run: p3MigrationV2_ },
      { version: 3, name: '日次バックアップ方式設定', run: p3MigrationV3_ }
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
  } finally {
    if (locked) lock.releaseLock();
  }
}

function ensureDataProtectionReady_() {
  const ss = getSs_();
  const result = p3RunMigrations_(ss);
  p3CleanupExpiredTrash_(ss);
  p3CleanupSnapshots_(ss);
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

/** Phase 3 client moduleを遅延取得するための内部API。 */
function getDataProtectionClientModule() {
  return [
    'App_Js_15_DataProtection_Core',
    'App_Js_15_DataProtection_Manage',
    'App_Js_15_DataProtection_Overrides'
  ].map(name => HtmlService.createHtmlOutputFromFile(name).getContent());
}
