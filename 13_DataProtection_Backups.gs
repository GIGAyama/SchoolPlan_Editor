function p3GetBackupIndex_(ss) {
  const raw = p3MetaGet_(ss, 'backupIndex');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function p3SetBackupIndex_(ss, list) {
  p3MetaSet_(ss, 'backupIndex', JSON.stringify(list || []));
}

function p3SanitizeFileName_(name) {
  return String(name || '週案エディタ').replace(/[\\/:*?"<>|]/g, '_').substring(0, 100);
}

function p3CreateFullBackup_(reason) {
  const source = getSs_();
  p3RunMigrations_(source);
  const now = new Date();
  const stamp = Utilities.formatDate(now, 'JST', 'yyyyMMdd_HHmmss');
  const backupName = p3SanitizeFileName_(source.getName()) + '_バックアップ_' + stamp;
  const backup = SpreadsheetApp.create(backupName);
  const defaultSheet = backup.getSheets()[0];
  // コピー元に「シート1 / Sheet1」があっても名前衝突しないよう、一時シートを先に退避名へ変更する。
  defaultSheet.setName('__p3_backup_temp_' + Utilities.getUuid().split('-')[0]);

  source.getSheets().forEach(sourceSheet => {
    const copied = sourceSheet.copyTo(backup);
    copied.setName(sourceSheet.getName());
    if (sourceSheet.isSheetHidden()) p3HideInternalSheet_(copied);
  });

  if (backup.getSheets().length > 1) backup.deleteSheet(defaultSheet);
  SpreadsheetApp.flush();

  const item = {
    id: backup.getId(),
    name: backupName,
    url: backup.getUrl(),
    createdAt: now.toISOString(),
    reason: String(reason || 'manual').substring(0, 200)
  };
  const list = p3GetBackupIndex_(source);
  list.unshift(item);
  p3SetBackupIndex_(source, list);
  p3MetaSet_(source, 'lastBackupAt', item.createdAt);
  p3MetaSet_(source, 'lastBackupId', item.id);
  p3CleanupBackups_(source);

  p3RecordAudit_(
    'FULL_BACKUP_CREATE',
    'spreadsheet',
    source.getId(),
    '完全バックアップを作成: ' + item.reason,
    null,
    { backupId: item.id, backupName: item.name },
    'backup_' + Utilities.getUuid()
  );
  return item;
}

function p3CleanupBackups_(ss) {
  const now = Date.now();
  const threshold = now - P3_BACKUP_RETENTION_DAYS_ * 86400000;
  const list = p3GetBackupIndex_(ss)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const keep = [];
  const remove = [];
  list.forEach((item, index) => {
    const created = new Date(item.createdAt).getTime();
    if (index < P3_BACKUP_MAX_COUNT_ && created >= threshold) keep.push(item);
    else remove.push(item);
  });

  remove.forEach(item => {
    try { DriveApp.getFileById(item.id).setTrashed(true); } catch (e) {}
  });
  p3SetBackupIndex_(ss, keep);
  return remove.length;
}

/** 未設定は有効扱い。明示的に '0' を保存したときだけ日次バックアップを止める。 */
function p3IsDailyBackupEnabled_(ss) {
  return p3MetaGet_(ss, 'dailyBackupEnabled') !== '0';
}

function p3MaybeCreateDailyBackup_() {
  const ss = getSs_();
  if (!p3IsDailyBackupEnabled_(ss)) return { created: false, backup: null, reason: 'disabled' };
  const lastDaily = p3MetaGet_(ss, 'lastDailyBackupDate');
  const today = p3TodayKey_();
  if (lastDaily === today) return { created: false, backup: null, reason: 'already' };

  // 複数タブ・複数端末から同時にアプリを開くと「本日分の有無を確認 → 作成 → 日付を記録」
  // の間に別実行が割り込み、同じ日のバックアップが重複して作られていた。ロックで囲って
  // 直列化する。取得できなければ別実行が本日分を作成中なので、待たずに諦めてよい。
  return p3TryWithUserLock_(20000, () => {
    // ロック待ちの間に別実行が作り終えている場合があるため、取得後に読み直す。
    if (p3MetaGet_(ss, 'lastDailyBackupDate') === today) {
      return { created: false, backup: null, reason: 'already' };
    }
    const backup = p3CreateFullBackup_('1日1回の自動バックアップ');
    p3MetaSet_(ss, 'lastDailyBackupDate', today);
    return { created: true, backup, reason: 'created' };
  }, { created: false, backup: null, reason: 'busy' });
}

function setDailyBackupEnabledFromWeb(enabled) {
  try {
    ensureDataProtectionReady_();
    const ss = getSs_();
    const before = p3IsDailyBackupEnabled_(ss);
    const after = !!enabled;
    p3MetaSet_(ss, 'dailyBackupEnabled', after ? '1' : '0');
    p3RecordAudit_(
      'DAILY_BACKUP_SETTING', 'database', ss.getId(),
      after ? '1日1回の自動バックアップを有効化' : '1日1回の自動バックアップを無効化',
      { dailyBackupEnabled: before }, { dailyBackupEnabled: after },
      'setting_' + Utilities.getUuid()
    );
    return {
      success: true,
      enabled: after,
      message: after
        ? '1日1回の自動バックアップを有効にしました。'
        : '1日1回の自動バックアップを無効にしました。手動バックアップと、全消去・学級削除の直前バックアップは引き続き作成されます。'
    };
  } catch (e) {
    logError('setDailyBackupEnabledFromWeb', e);
    return { success: false, error: e.message };
  }
}

function createFullBackupFromWeb(label) {
  try {
    ensureDataProtectionReady_();
    const backup = p3CreateFullBackup_(label || '手動バックアップ');
    return { success: true, backup, message: '完全バックアップを作成しました。' };
  } catch (e) {
    logError('createFullBackupFromWeb', e);
    return { success: false, error: describeAuthError_(e, 'データバックアップ') };
  }
}

function listBackupsFromWeb() {
  try {
    ensureDataProtectionReady_();
    const ss = getSs_();
    p3CleanupBackups_(ss);
    return { success: true, items: p3GetBackupIndex_(ss) };
  } catch (e) {
    logError('listBackupsFromWeb', e);
    return { success: false, error: e.message };
  }
}
