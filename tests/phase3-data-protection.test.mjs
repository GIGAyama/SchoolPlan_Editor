import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const backend = [
  '13_DataProtection.gs',
  '13_DataProtection_Snapshots.gs',
  '13_DataProtection_Backups.gs',
  '13_DataProtection_Trash.gs',
  '13_DataProtection_Operations.gs',
  '12_Performance.gs'
].map(file => fs.readFileSync(file, 'utf8')).join('\n');
const webApp = fs.readFileSync('07_WebApp.gs', 'utf8');

const frontend = [
  'App_Js_09_Utils.html',
  'App_Js_15_DataProtection_Core.html',
  'App_Js_15_DataProtection_Manage.html',
  'App_Js_15_DataProtection_Overrides.html'
].map(file => fs.readFileSync(file, 'utf8')).join('\n');
const manifest = fs.readFileSync('appsscript.json', 'utf8');

function between(text, start, end) {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0, `missing start marker: ${start}`);
  assert.ok(b > a, `missing end marker: ${end}`);
  return text.slice(a, b);
}

test('schema migrations are versioned and forward-only', () => {
  assert.match(backend, /const P3_SCHEMA_VERSION_ = 4/);
  assert.match(backend, /p3MigrationV1_/);
  assert.match(backend, /p3MigrationV2_/);
  assert.match(backend, /p3MigrationV3_/);
  assert.match(backend, /p3MigrationV4_/);
  assert.match(backend, /version > P3_SCHEMA_VERSION_/);
});

test('the user lock is not acquired twice inside one execution', () => {
  // p3MaybeCreateDailyBackup_ → p3CreateFullBackup_ → p3RunMigrations_ とネストするため、
  // 再入時は取得済みロックを使い回す必要がある。
  const helper = between(backend, 'function p3WithUserLock_', 'function p3MigrationV1_');
  assert.match(helper, /p3UserLockDepth_ > 0/);
  assert.match(helper, /tryLock/);
  const migrations = between(backend, 'function p3RunMigrations_', 'function ensureDataProtectionReady_');
  assert.match(migrations, /p3WithUserLock_/);
  assert.doesNotMatch(migrations, /LockService\.getUserLock/);
});

test('audit payloads redact secrets before persistence', () => {
  assert.match(backend, /api\.\?key\|token\|secret\|password\|authorization\|credential/i);
  assert.match(backend, /\[REDACTED\]/);
  assert.match(backend, /function p3RecordAudit_/);
});

test('weekly save creates a restore point inside the lock before writing', () => {
  // 保護はクライアントのオーバーライドではなくV2保存自身が行う。
  // 不変条件: ロック取得 → 保存前スナップショット → 週の行書込 → 監査ログ。
  const fn = between(backend, 'function saveWeeklyPlanDataV2', 'function getDbSchemaDiagnosticsFromWeb');
  const lockAt = fn.indexOf('waitLock');
  const snapshotAt = fn.indexOf('p3CreateSnapshot_(');
  const writeAt = fn.indexOf('p2WriteChangedWeekRows_(dbSheet');
  assert.ok(lockAt >= 0 && snapshotAt > lockAt && writeAt > snapshotAt);
  assert.match(fn, /WEEK_SAVE/);
});

test('protected and V1 save endpoints delegate to the protected V2 save', () => {
  const protectedFn = between(backend, 'function saveWeeklyPlanDataProtected', 'function p3RestoreReflections_');
  assert.match(protectedFn, /saveWeeklyPlanWeek_\(/);
  assert.doesNotMatch(protectedFn, /p3CreateSnapshot_\(/);

  const v1 = between(webApp, 'function saveWeeklyPlanData(', 'function getUnitMasterForSuggest');
  assert.match(v1, /saveWeeklyPlanDataV2\(/);
  assert.doesNotMatch(v1, /setValues/,
    'V1 must not rewrite the whole sheet (it clobbered formula columns)');
});

test('protected database clear is serialized with weekly saves', () => {
  const fn = between(backend, 'function clearDatabaseDataProtectedFromWeb', 'function deleteClassProtectedFromWeb');
  assert.match(fn, /getScriptLock/);
  assert.match(fn, /waitLock/);
});

test('week snapshots are scoped per class sheet and restores guard the target sheet', () => {
  assert.match(backend, /function p3WeekScope_/);
  assert.match(backend, /function p3SnapshotSheetMismatch_/);
  const preview = between(backend, 'function previewWeekSnapshotFromWeb', 'function restoreWeekSnapshotFromWeb');
  assert.match(preview, /p3SnapshotSheetMismatch_/);
  const restore = between(backend, 'function restoreWeekSnapshotFromWeb', 'function p3GetBackupIndex_');
  assert.match(restore, /p3SnapshotSheetMismatch_/);
  assert.ok(restore.indexOf('p3SnapshotSheetMismatch_') < restore.indexOf('p3CreateSnapshot_('),
    'sheet guard must run before the safety snapshot is created');
});

test('manual restore points are never evicted by the snapshot count cap', () => {
  const cleanup = between(backend, 'function p3CleanupSnapshots_', 'function p3ReadSnapshot_');
  assert.match(cleanup, /手動/);
  assert.match(cleanup, /isManual/);
});

test('week restore creates a safety restore point before overwriting', () => {
  const fn = between(backend, 'function restoreWeekSnapshotFromWeb', 'function p3GetBackupIndex_');
  assert.ok(fn.indexOf("'自動: 復元直前'") < fn.indexOf('saveWeeklyPlanWeek_('));
  assert.match(fn, /p3RestoreReflections_/);
});

test('full backup copies spreadsheet sheets without requesting broad Drive scope', () => {
  // 作成は Sheets REST のファサード経由。SpreadsheetApp を使うと spreadsheets
  // スコープを要求してしまう（18_SheetsApi.gs 冒頭の説明を参照）。
  assert.match(backend, /sheetsCreate_\(backupName\)/);
  assert.match(backend, /sourceSheet\.copyTo\(backup\)/);
  assert.doesNotMatch(manifest, /auth\/drive"/);
  assert.match(manifest, /auth\/drive\.file/);
});

test('daily backup is active-day based and does not create a new trigger', () => {
  const fn = between(backend, 'function p3MaybeCreateDailyBackup_', 'function setDailyBackupEnabledFromWeb');
  assert.match(fn, /lastDailyBackupDate/);
  assert.match(fn, /p3TodayKey_/);
  assert.doesNotMatch(fn, /newTrigger/);
});

test('daily backup serializes check-create-record so concurrent tabs cannot duplicate it', () => {
  const fn = between(backend, 'function p3MaybeCreateDailyBackup_', 'function setDailyBackupEnabledFromWeb');
  const lockAt = fn.indexOf('p3TryWithUserLock_');
  const recheckAt = fn.indexOf("p3MetaGet_(ss, 'lastDailyBackupDate')", lockAt);
  const createAt = fn.indexOf('p3CreateFullBackup_');
  const recordAt = fn.indexOf("p3MetaSet_(ss, 'lastDailyBackupDate'");
  assert.ok(lockAt >= 0, 'daily backup must take a lock');
  assert.ok(recheckAt > lockAt, 'the date must be re-read after the lock is acquired');
  assert.ok(createAt > recheckAt && recordAt > createAt,
    'create and record must both happen inside the lock, after the re-check');
});

test('daily backup can be switched off without disabling destructive-operation backups', () => {
  assert.match(backend, /function p3IsDailyBackupEnabled_/);
  assert.match(backend, /function setDailyBackupEnabledFromWeb/);
  const maybe = between(backend, 'function p3MaybeCreateDailyBackup_', 'function setDailyBackupEnabledFromWeb');
  assert.match(maybe, /p3IsDailyBackupEnabled_/);
  // 全消去・学級削除の直前バックアップは設定に関係なく必ず走る。
  const clear = between(backend, 'function clearDatabaseDataProtectedFromWeb', 'function deleteClassProtectedFromWeb');
  assert.doesNotMatch(clear, /p3IsDailyBackupEnabled_/);
  const deleteClass = between(backend, 'function deleteClassProtectedFromWeb', 'function listAuditLogFromWeb');
  assert.doesNotMatch(deleteClass, /p3IsDailyBackupEnabled_/);
  assert.match(frontend, /setDailyBackupEnabledFromWeb/);
  assert.match(frontend, /p3DailyBackupEnabled/);
});

test('backup generations are capped low enough to keep Drive tidy', () => {
  assert.match(backend, /P3_BACKUP_MAX_COUNT_ = 4/);
  assert.match(backend, /P3_BACKUP_RETENTION_DAYS_ = 30/);
  const cleanup = between(backend, 'function p3CleanupBackups_', 'function p3IsDailyBackupEnabled_');
  assert.match(cleanup, /P3_BACKUP_MAX_COUNT_/);
  // drive.file 運用のため DriveApp ではなく Drive REST API のラッパーでごみ箱へ送る
  assert.match(cleanup, /driveSetTrashed_\([^)]*,\s*true\)/);
});

test('destructive database clear backs up first and clears by logical headers', () => {
  const fn = between(backend, 'function clearDatabaseDataProtectedFromWeb', 'function deleteClassProtectedFromWeb');
  assert.ok(fn.indexOf('p3CreateFullBackup_') < fn.indexOf('p3ClearDatabaseInputsByHeader_'));
  const clearHelper = between(backend, 'function p3ClearDatabaseInputsByHeader_', 'function clearDatabaseDataProtectedFromWeb');
  assert.match(clearHelper, /P2_WEEK_READ_KEYS_/);
  assert.doesNotMatch(clearHelper, /AFTERSCHOOL - .*TIME/);
});

test('class deletion is preceded by a complete backup', () => {
  const fn = between(backend, 'function deleteClassProtectedFromWeb', 'function listAuditLogFromWeb');
  assert.ok(fn.indexOf('p3CreateFullBackup_') < fn.indexOf('deleteClassFromWeb('));
});

test('tasks, unit master rows, and newsletters use a recoverable trash', () => {
  assert.match(backend, /function trashTaskFromWebApp/);
  assert.match(backend, /function trashUnitMasterRowFromWeb/);
  assert.match(backend, /function trashNewsletterDataFromWeb/);
  assert.match(backend, /function restoreTrashItemFromWeb/);
  assert.match(backend, /P3_TRASH_RETENTION_DAYS_ = 30/);
  assert.match(backend, /P3_AUTO_SNAPSHOT_INTERVAL_MINUTES_ = 30/);
  assert.match(backend, /P3_AUTO_SNAPSHOT_MAX_PER_SCOPE_ = 10/);
});

test('frontend routes all week mutations through protected save API', () => {
  const calls = frontend.match(/saveWeeklyPlanDataProtected/g) || [];
  assert.ok(calls.length >= 3, `expected at least 3 protected save routes, got ${calls.length}`);
  assert.match(frontend, /'auto-save'/);
  assert.match(frontend, /'manual-save'/);
  assert.match(frontend, /'view-mutation'/);
});

test('frontend replaces hard deletes with trash or backup-protected operations', () => {
  assert.match(frontend, /trashTaskFromWebApp/);
  assert.match(frontend, /trashUnitMasterRowFromWeb/);
  assert.match(frontend, /trashNewsletterDataFromWeb/);
  assert.match(frontend, /clearDatabaseDataProtectedFromWeb/);
  assert.match(frontend, /deleteClassProtectedFromWeb/);
});

test('protection module is included synchronously after its dependencies', () => {
  const appHtml = fs.readFileSync('App.html', 'utf8');
  const multiClassAt = appHtml.indexOf("include('App_Js_14_MultiClass')");
  const coreAt = appHtml.indexOf("include('App_Js_15_DataProtection_Core')");
  const manageAt = appHtml.indexOf("include('App_Js_15_DataProtection_Manage')");
  const overridesAt = appHtml.indexOf("include('App_Js_15_DataProtection_Overrides')");
  assert.ok(multiClassAt >= 0 && coreAt > multiClassAt && manageAt > coreAt && overridesAt > manageAt,
    'App_Js_15_* must be included synchronously, after App_Js_14_MultiClass');
  // 遅延ローダー方式(起動後250msの無保護ウィンドウの原因)へ戻さないこと
  const utils = fs.readFileSync('App_Js_09_Utils.html', 'utf8');
  assert.doesNotMatch(utils, /getDataProtectionClientModule/);
});

test('clients no longer call the unprotected delete/clear endpoints', () => {
  const clientFiles = fs.readdirSync('.').filter(f => /^App_Js_.*\.html$/.test(f));
  for (const file of clientFiles) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /\.deleteTaskFromWebApp\(/, `${file} must use trashTaskFromWebApp`);
    assert.doesNotMatch(text, /\.clearDatabaseDataFromWeb\(/, `${file} must use clearDatabaseDataProtectedFromWeb`);
    assert.doesNotMatch(text, /\.deleteNewsletterData\(/, `${file} must use trashNewsletterDataFromWeb`);
    assert.doesNotMatch(text, /\.deleteUnitMasterRow\(/, `${file} must use trashUnitMasterRowFromWeb`);
    assert.doesNotMatch(text, /\.deleteClassFromWeb\(/, `${file} must use deleteClassProtectedFromWeb`);
  }
});

test('legacy destructive server endpoints delegate to protected variants', () => {
  const database = fs.readFileSync('02_Database.gs', 'utf8');
  const legacyClear = between(database, 'function clearDatabaseDataFromWeb', 'function initTaskSheet_');
  assert.match(legacyClear, /clearDatabaseDataProtectedFromWeb\(\)/);
  const legacyDelete = between(webApp, 'function deleteTaskFromWebApp', 'const SP_KEY_TASK_REMINDER_ENABLED');
  assert.match(legacyDelete, /trashTaskFromWebApp\(/);
});

test('settings UI exposes backup, restore, trash, audit, migrations, and integrity checks', () => {
  for (const api of [
    'createFullBackupFromWeb',
    'listBackupsFromWeb',
    'listRestorePointsFromWeb',
    'previewWeekSnapshotFromWeb',
    'restoreWeekSnapshotFromWeb',
    'listTrashFromWeb',
    'listAuditLogFromWeb',
    'runDataMigrationsFromWeb',
    'runDataIntegrityCheckFromWeb'
  ]) assert.match(frontend, new RegExp(api));
});

// ---------------------------------------------------------------- 監査ログに残す値

/** 13_DataProtection.gs の純粋な関数だけを取り出して動かす。 */
function loadAuditHelpers() {
  const source = fs.readFileSync('13_DataProtection.gs', 'utf8');
  const factory = new Function(`
    ${source}
    return { p3AuditValue_, p3AuditOutline_, p3Json_, P3_AUDIT_VALUE_MAX_ };
  `);
  return factory();
}

/** 週案1週ぶんに近い大きさのデータを作る。 */
function sampleWeekDays() {
  return Array.from({ length: 7 }, (_, d) => ({
    date: `2026/06/0${d + 1}`,
    event: '行事の説明が入ります',
    periods: Array.from({ length: 6 }, (_, p) => ({
      subject: '国語', unit: '単元' + p, content: '学習内容の説明文がここに入ります'.repeat(3)
    }))
  }));
}

test('監査ログの Before/After は、小さい値ならそのまま残す', () => {
  const { p3AuditValue_ } = loadAuditHelpers();
  assert.deepEqual(p3AuditValue_({ trashId: 'trash_1' }), { trashId: 'trash_1' });
  assert.deepEqual(p3AuditValue_({ version: 4, applied: ['保持期間設定'] }),
    { version: 4, applied: ['保持期間設定'] });
  assert.equal(p3AuditValue_('文字列はそのまま'), '文字列はそのまま');
  assert.equal(p3AuditValue_(null), null);
});

test('監査ログの Before/After は、大きい値を手がかりだけに畳む', () => {
  // 監査ログは「いつ・誰が・何をしたか」の記録で、中身を戻すためのものではない。
  // 戻すのは復元ポイント側の役目なので、snapshotId が残っていればよい。
  const { p3AuditValue_, p3Json_, P3_AUDIT_VALUE_MAX_ } = loadAuditHelpers();
  const before = {
    revision: 'abc123',
    snapshotId: 'snap_1',
    changedDates: '2026/06/01 2026/06/02',
    days: sampleWeekDays()
  };

  const outlined = p3AuditValue_(before);
  assert.equal(outlined.revision, 'abc123');
  assert.equal(outlined.snapshotId, 'snap_1', '復元ポイントIDまで畳んでしまっている');
  assert.equal(outlined.changedDates, '2026/06/01 2026/06/02');
  assert.equal(outlined.days, '[7件]', '週データの中身が残っている');

  // 畳んだうえで、記録する文字数も上限を超えない
  assert.ok(p3Json_(outlined, P3_AUDIT_VALUE_MAX_).length <= P3_AUDIT_VALUE_MAX_ + 1);

  // 畳む前は上限をはるかに超えていたこと（＝この畳みが効いていること）を示す
  assert.ok(p3Json_(before, 1000000).length > P3_AUDIT_VALUE_MAX_ * 4);
});

test('監査ログの要約でも、機密の伏せ字は効いたまま', () => {
  const { p3AuditValue_, p3Json_, P3_AUDIT_VALUE_MAX_ } = loadAuditHelpers();
  const value = { apiKey: 'AIza-本物のキー', days: sampleWeekDays() };
  const json = p3Json_(p3AuditValue_(value), P3_AUDIT_VALUE_MAX_);
  assert.match(json, /REDACTED/);
  assert.doesNotMatch(json, /AIza-本物のキー/);
});

test('週案保存の監査ログは、週データではなく変更した日付を残す', () => {
  const performance = fs.readFileSync('12_Performance.gs', 'utf8');
  const audit = between(performance, "p3RecordAudit_(\n        'WEEK_SAVE'", "'save_' + Utilities.getUuid()");
  assert.match(audit, /snapshotId: restorePointId/, '復元ポイントIDを残していない');
  assert.match(audit, /changedDates/);
  assert.doesNotMatch(audit, /days:/, '週データを監査ログへ渡している');
});
