import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const backend = [
  '13_DataProtection.gs',
  '13_DataProtection_Snapshots.gs',
  '13_DataProtection_Backups.gs',
  '13_DataProtection_Trash.gs',
  '13_DataProtection_Operations.gs'
].map(file => fs.readFileSync(file, 'utf8')).join('\n');

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
  assert.match(backend, /const P3_SCHEMA_VERSION_ = 3/);
  assert.match(backend, /p3MigrationV1_/);
  assert.match(backend, /p3MigrationV2_/);
  assert.match(backend, /p3MigrationV3_/);
  assert.match(backend, /version > P3_SCHEMA_VERSION_/);
});

test('audit payloads redact secrets before persistence', () => {
  assert.match(backend, /api\.\?key\|token\|secret\|password\|authorization\|credential/i);
  assert.match(backend, /\[REDACTED\]/);
  assert.match(backend, /function p3RecordAudit_/);
});

test('weekly protected save creates a restore point before V2 write', () => {
  const fn = between(backend, 'function saveWeeklyPlanDataProtected', 'function p3RestoreReflections_');
  const snapshot = fn.indexOf('p3CreateSnapshot_(');
  const write = fn.indexOf('saveWeeklyPlanDataV2(');
  assert.ok(snapshot >= 0 && write > snapshot);
  assert.match(fn, /WEEK_SAVE/);
});

test('week restore creates a safety restore point before overwriting', () => {
  const fn = between(backend, 'function restoreWeekSnapshotFromWeb', 'function p3GetBackupIndex_');
  assert.ok(fn.indexOf("'自動: 復元直前'") < fn.indexOf('saveWeeklyPlanDataV2('));
  assert.match(fn, /p3RestoreReflections_/);
});

test('full backup copies spreadsheet sheets without requesting broad Drive scope', () => {
  assert.match(backend, /SpreadsheetApp\.create\(backupName\)/);
  assert.match(backend, /sourceSheet\.copyTo\(backup\)/);
  assert.doesNotMatch(manifest, /auth\/drive"/);
  assert.match(manifest, /auth\/drive\.file/);
});

test('daily backup is active-day based and does not create a new trigger', () => {
  const fn = between(backend, 'function p3MaybeCreateDailyBackup_', 'function createFullBackupFromWeb');
  assert.match(fn, /lastDailyBackupDate/);
  assert.match(fn, /p3TodayKey_/);
  assert.doesNotMatch(fn, /newTrigger/);
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
  assert.match(frontend, /clearDatabaseDataProtectedFromWeb/);
  assert.match(frontend, /deleteClassProtectedFromWeb/);
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
