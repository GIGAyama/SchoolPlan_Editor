function p3ClearDatabaseInputsByHeader_() {
  const ss = getSs_();
  const sheet = getDbSheet_(ss);
  if (!sheet) throw new Error('データベースシートが見つかりません。');
  const cols = getDbColumns();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { cleared: false, clearedColumns: 0, message: 'クリア対象のデータがありません。' };

  // 列順を仮定せず、論理見出しごとの物理列だけをクリアする。振り返りは保全のため残す。
  const keys = ['TIME'].concat(P2_WEEK_READ_KEYS_);
  const columns = [...new Set(keys.map(key => cols[key]).filter(Boolean))].sort((a, b) => a - b);
  columns.forEach(column => sheet.getRange(2, column, lastRow - 1, 1).clearContent());
  SpreadsheetApp.flush();
  return {
    cleared: columns.length > 0,
    clearedColumns: columns.length,
    message: '「' + sheet.getName() + '」の入力内容をクリアしました。'
  };
}

function clearDatabaseDataProtectedFromWeb() {
  try {
    ensureDataProtectionReady_();
    const backup = p3CreateFullBackup_('データベースクリア直前');
    const before = getDbSchemaDiagnosticsFromWeb();
    const result = p3ClearDatabaseInputsByHeader_();
    p3RecordAudit_(
      'DATABASE_CLEAR',
      'database',
      getDbSheet_(getSs_()).getName(),
      'データベース入力内容をクリア',
      { diagnostics: before, backupId: backup.id },
      result,
      'clear_' + Utilities.getUuid()
    );
    return {
      success: true,
      message: result.message + ' 完全バックアップを作成済みです。',
      backup
    };
  } catch (e) {
    logError('clearDatabaseDataProtectedFromWeb', e);
    return { success: false, error: e.message };
  }
}

function deleteClassProtectedFromWeb(sheetName) {
  try {
    ensureDataProtectionReady_();
    const backup = p3CreateFullBackup_('学級削除直前: ' + sheetName);
    const result = deleteClassFromWeb(sheetName);
    if (!result || !result.success) {
      return result || { success: false, error: '学級削除に失敗しました。' };
    }
    p3RecordAudit_(
      'CLASS_DELETE',
      'class',
      sheetName,
      '学級を削除（完全バックアップ作成済み）',
      { sheetName, backupId: backup.id },
      result,
      'class_delete_' + Utilities.getUuid()
    );
    result.backup = backup;
    return result;
  } catch (e) {
    logError('deleteClassProtectedFromWeb', e);
    return { success: false, error: e.message };
  }
}

function listAuditLogFromWeb(limit) {
  try {
    ensureDataProtectionReady_();
    const ss = getSs_();
    const sheet = p3EnsureInternalSheets_(ss).audit;
    if (sheet.getLastRow() < 2) return { success: true, items: [] };
    const max = Math.max(1, Math.min(parseInt(limit, 10) || 100, 300));
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, P3_AUDIT_HEADERS_.length).getValues();
    const items = values.slice(-max).reverse().map(row => ({
      id: String(row[0] || ''),
      at: row[1] instanceof Date ? Utilities.formatDate(row[1], 'JST', 'yyyy/MM/dd HH:mm:ss') : String(row[1] || ''),
      actor: String(row[2] || ''),
      action: String(row[3] || ''),
      entityType: String(row[4] || ''),
      entityId: String(row[5] || ''),
      summary: String(row[6] || ''),
      correlationId: String(row[9] || '')
    }));
    return { success: true, items };
  } catch (e) {
    logError('listAuditLogFromWeb', e);
    return { success: false, error: e.message };
  }
}

function p3IntegrityCheck_() {
  const ss = getSs_();
  const dbSheet = getDbSheet_(ss);
  if (!dbSheet) throw new Error('データベースシートが見つかりません。');
  const schema = getDbSchemaDiagnosticsFromWeb();
  const cols = getDbColumns();
  const lastRow = dbSheet.getLastRow();
  const report = {
    checkedAt: p3NowIso_(),
    spreadsheetId: ss.getId(),
    databaseSheet: dbSheet.getName(),
    schema,
    duplicateDates: [],
    invalidDateRows: [],
    duplicateTaskIds: [],
    warnings: []
  };

  if (lastRow >= 2) {
    const dates = dbSheet.getRange(2, cols.DATE, lastRow - 1, 1).getValues();
    const seen = {};
    dates.forEach((row, index) => {
      const value = row[0];
      const sheetRow = index + 2;
      if (value === '' || value === null) return;
      if (!(value instanceof Date) || isNaN(value.getTime())) {
        report.invalidDateRows.push(sheetRow);
        return;
      }
      const key = formatDate(value);
      if (seen[key]) report.duplicateDates.push({ date: key, rows: [seen[key], sheetRow] });
      else seen[key] = sheetRow;
    });
  }

  const taskSheet = ss.getSheetByName(SHEET_NAME_TASK);
  if (taskSheet && taskSheet.getLastRow() >= 2) {
    const ids = taskSheet.getRange(2, 1, taskSheet.getLastRow() - 1, 1).getDisplayValues();
    const seen = {};
    ids.forEach((row, index) => {
      const id = String(row[0] || '').trim();
      if (!id) return;
      const sheetRow = index + 2;
      if (seen[id]) report.duplicateTaskIds.push({ id, rows: [seen[id], sheetRow] });
      else seen[id] = sheetRow;
    });
  }

  if (!schema.success || !schema.safeToWrite) report.warnings.push('週案保存に必要な列が不足しています。');
  if (schema.duplicates && schema.duplicates.length) report.warnings.push('重複する見出しがあります。');
  if (report.duplicateDates.length) report.warnings.push('日付の重複があります。');
  if (report.invalidDateRows.length) report.warnings.push('日付として認識できない行があります。');
  if (report.duplicateTaskIds.length) report.warnings.push('TaskIDの重複があります。');

  report.healthy = report.warnings.length === 0;
  p3MetaSet_(ss, 'lastIntegrityCheckAt', report.checkedAt);
  p3MetaSet_(ss, 'lastIntegrityCheckResult', report.healthy ? 'healthy' : 'warning');
  p3RecordAudit_(
    'INTEGRITY_CHECK',
    'database',
    ss.getId(),
    report.healthy ? 'データ健全性チェック: 正常' : 'データ健全性チェック: 要確認',
    null,
    report,
    'check_' + Utilities.getUuid()
  );
  return report;
}

function runDataIntegrityCheckFromWeb() {
  try {
    ensureDataProtectionReady_();
    return { success: true, report: p3IntegrityCheck_() };
  } catch (e) {
    logError('runDataIntegrityCheckFromWeb', e);
    return { success: false, error: e.message };
  }
}

function getDataProtectionStatusFromWeb(runDailyBackup) {
  try {
    const migration = ensureDataProtectionReady_();
    let daily = { created: false, backup: null };
    let dailyError = '';
    if (runDailyBackup) {
      try {
        daily = p3MaybeCreateDailyBackup_();
      } catch (e) {
        dailyError = describeAuthError_(e, '自動バックアップ');
        logError('p3MaybeCreateDailyBackup_', e);
      }
    }

    const ss = getSs_();
    const sheets = p3EnsureInternalSheets_(ss);
    const backups = p3GetBackupIndex_(ss);
    let snapshotCount = 0;
    if (sheets.snapshots.getLastRow() >= 2) {
      const snapshotIds = sheets.snapshots
        .getRange(2, 1, sheets.snapshots.getLastRow() - 1, 1)
        .getDisplayValues()
        .map(row => row[0])
        .filter(Boolean);
      snapshotCount = new Set(snapshotIds).size;
    }
    const trashCount = Math.max(0, sheets.trash.getLastRow() - 1);
    const auditCount = Math.max(0, sheets.audit.getLastRow() - 1);
    const warnings = [];
    const schemaDiagnostics = getDbSchemaDiagnosticsFromWeb();

    if (dailyError) warnings.push(dailyError);
    if (!backups.length) warnings.push('完全バックアップがまだありません。');
    if (!schemaDiagnostics.success || !schemaDiagnostics.safeToWrite) {
      warnings.push('データベースの列構成に問題があります。');
    }

    return {
      success: true,
      schemaVersion: migration.version,
      currentSchemaVersion: P3_SCHEMA_VERSION_,
      protectionMode: '初回起動時の日次バックアップ + 30分間隔の週復元ポイント',
      lastBackupAt: p3MetaGet_(ss, 'lastBackupAt'),
      lastDailyBackupDate: p3MetaGet_(ss, 'lastDailyBackupDate'),
      backups: backups.slice(0, 20),
      counts: {
        backup: backups.length,
        restorePoints: snapshotCount,
        trash: trashCount,
        audit: auditCount
      },
      dailyBackup: daily,
      schemaDiagnostics,
      warnings,
      healthy: warnings.length === 0
    };
  } catch (e) {
    logError('getDataProtectionStatusFromWeb', e);
    return { success: false, error: e.message };
  }
}
