function p3SplitChunks_(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += P3_CHUNK_SIZE_) {
    chunks.push(text.substring(i, i + P3_CHUNK_SIZE_));
  }
  return chunks.length ? chunks : [''];
}

function p3ListSnapshotFirstRows_(ss) {
  const sheet = p3EnsureInternalSheets_(ss).snapshots;
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, P3_SNAPSHOT_HEADERS_.length).getValues()
    .map((row, index) => ({ row, sheetRow: index + 2 }))
    .filter(item => Number(item.row[7]) === 1);
}

// 週スナップショットの scope は「学級シート名::週の月曜日」。学級を含めないと、
// 同じ週に複数学級を保存したとき他学級のスナップショットで作成が抑止されたり、
// prune が他学級の復元ポイントを消してしまう。
function p3WeekScope_(mondayDateStr) {
  const sheet = getDbSheet_(getSs_());
  return (sheet ? sheet.getName() : 'default') + '::' + mondayDateStr;
}

// 旧形式 scope(週のみ)と新形式(シート名::週)の両方から週の月曜日を取り出す。
function p3ScopeMonday_(scope) {
  return String(scope || '').split('::').pop();
}

// 復元ポイント一覧向けの表示用 scope。既定シートなら週のみ、学級シートなら「週(学級)」。
// 単元マスタの復元ポイント（unit::教科::単元名 / sheet::単元マスタ）も読める形にする。
function p3ScopeDisplay_(scope) {
  const raw = String(scope || '');
  if (raw.indexOf('unit::') === 0) {
    const parts = raw.split('::');
    return parts.length >= 3 ? parts[1] + ' / ' + parts.slice(2).join('::') : raw;
  }
  if (raw.indexOf('sheet::') === 0) return raw.substring('sheet::'.length) + ' 全体';
  const idx = raw.lastIndexOf('::');
  if (idx < 0) return raw;
  const sheetName = raw.substring(0, idx);
  const monday = raw.substring(idx + 2);
  return sheetName === SHEET_NAME_DATABASE ? monday : monday + '（' + sheetName + '）';
}

// 復元ポイントが現在のアクティブ学級シートのものかを確認する。
// 別学級のものならエラーメッセージ、判定可能で一致なら null を返す。
// activeSheet を持たない旧形式スナップショットは従来どおり許可する。
function p3SnapshotSheetMismatch_(snapshot) {
  const stored = snapshot && snapshot.payload ? String(snapshot.payload.activeSheet || '') : '';
  if (!stored) return null;
  const current = getDbSheet_(getSs_());
  const currentName = current ? current.getName() : '';
  if (stored === currentName) return null;
  return 'この復元ポイントは学級シート「' + stored + '」のものです。学級を切り替えてから復元してください。';
}

function p3ShouldCreateAutoSnapshot_(scope) {
  const ss = getSs_();
  const rows = p3ListSnapshotFirstRows_(ss)
    .filter(item => String(item.row[3]) === 'week'
      && String(item.row[4]) === String(scope)
      && String(item.row[5]).indexOf('自動: 週案保存前') === 0)
    .sort((a, b) => new Date(b.row[1]).getTime() - new Date(a.row[1]).getTime());
  if (!rows.length) return true;
  const latestAt = new Date(rows[0].row[1]).getTime();
  return !latestAt || Date.now() - latestAt >= P3_AUTO_SNAPSHOT_INTERVAL_MINUTES_ * 60000;
}

function p3CleanupAutoSnapshotsForScope_(ss, scope) {
  const sheet = p3EnsureInternalSheets_(ss).snapshots;
  const firstRows = p3ListSnapshotFirstRows_(ss)
    .filter(item => String(item.row[3]) === 'week'
      && String(item.row[4]) === String(scope)
      && String(item.row[5]).indexOf('自動: 週案保存前') === 0)
    .sort((a, b) => new Date(b.row[1]).getTime() - new Date(a.row[1]).getTime());
  const removeIds = new Set(firstRows.slice(P3_AUTO_SNAPSHOT_MAX_PER_SCOPE_).map(item => String(item.row[0])));
  if (!removeIds.size || sheet.getLastRow() < 2) return 0;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues();
  for (let i = values.length - 1; i >= 0; i--) {
    if (removeIds.has(String(values[i][0]))) sheet.deleteRow(i + 2);
  }
  return removeIds.size;
}

function p3CreateSnapshot_(type, scope, label, payload) {
  const ss = getSs_();
  const sheet = p3EnsureInternalSheets_(ss).snapshots;
  const snapshotId = 'snap_' + Utilities.getUuid();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + P3_SNAPSHOT_RETENTION_DAYS_ * 86400000);
  const chunks = p3SplitChunks_(JSON.stringify(p3Redact_(payload)));
  const rows = chunks.map((chunk, index) => [
    snapshotId,
    createdAt,
    p3Actor_(),
    type,
    scope,
    String(label || '').substring(0, 500),
    expiresAt,
    index + 1,
    chunks.length,
    chunk
  ]);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, P3_SNAPSHOT_HEADERS_.length).setValues(rows);
  p3CleanupSnapshots_(ss);
  if (type === 'week' && String(label || '').indexOf('自動: 週案保存前') === 0) {
    p3CleanupAutoSnapshotsForScope_(ss, scope);
  }
  return snapshotId;
}

function p3CleanupSnapshots_(ss) {
  const sheet = p3EnsureInternalSheets_(ss).snapshots;
  if (sheet.getLastRow() < 2) return 0;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, P3_SNAPSHOT_HEADERS_.length).getValues();
  const now = Date.now();
  const firstRows = values
    .map((row, index) => ({ row, sheetRow: index + 2 }))
    .filter(item => Number(item.row[7]) === 1)
    .sort((a, b) => new Date(b.row[1]).getTime() - new Date(a.row[1]).getTime());

  // 「手動」で始まる復元ポイントは件数上限による自動削除の対象にしない
  // (自動スナップショットの大量発生でユーザーの手動復元ポイントが消えるのを防ぐ)。
  // 期限切れ削除は種別を問わず行う。
  //
  // 件数上限は種別ごとに数える。単元マスタの復元ポイントが増えても週案の
  // 復元ポイントを押し出さないようにするため。
  const keepIds = new Set();
  const autoByType = {};
  firstRows.forEach(item => {
    if (String(item.row[5]).indexOf('手動') === 0) return;
    const type = String(item.row[3] || '');
    (autoByType[type] = autoByType[type] || []).push(item);
  });
  Object.keys(autoByType).forEach(type => {
    autoByType[type].slice(0, P3_SNAPSHOT_MAX_COUNT_)
      .forEach(item => keepIds.add(String(item.row[0])));
  });
  const expiredIds = new Set();
  firstRows.forEach(item => {
    const isManual = String(item.row[5]).indexOf('手動') === 0;
    const expires = item.row[6] instanceof Date ? item.row[6].getTime() : new Date(item.row[6]).getTime();
    if ((expires && expires < now) || (!isManual && !keepIds.has(String(item.row[0])))) {
      expiredIds.add(String(item.row[0]));
    }
  });
  if (expiredIds.size === 0) return 0;

  for (let i = values.length - 1; i >= 0; i--) {
    if (expiredIds.has(String(values[i][0]))) sheet.deleteRow(i + 2);
  }
  return expiredIds.size;
}

function p3ReadSnapshot_(snapshotId) {
  const ss = getSs_();
  const sheet = p3EnsureInternalSheets_(ss).snapshots;
  if (sheet.getLastRow() < 2) return null;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, P3_SNAPSHOT_HEADERS_.length).getValues();
  const rows = values.filter(row => String(row[0]) === String(snapshotId))
    .sort((a, b) => Number(a[7]) - Number(b[7]));
  if (!rows.length) return null;
  const payloadText = rows.map(row => String(row[9] || '')).join('');
  return {
    id: snapshotId,
    createdAt: rows[0][1],
    actor: rows[0][2],
    type: rows[0][3],
    scope: rows[0][4],
    label: rows[0][5],
    expiresAt: rows[0][6],
    payload: JSON.parse(payloadText)
  };
}

function listRestorePointsFromWeb(limit) {
  try {
    ensureDataProtectionReady_();
    const ss = getSs_();
    const sheet = p3EnsureInternalSheets_(ss).snapshots;
    if (sheet.getLastRow() < 2) return { success: true, items: [] };
    const max = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, P3_SNAPSHOT_HEADERS_.length).getValues();
    const items = values
      .filter(row => Number(row[7]) === 1)
      .map(row => ({
        id: String(row[0]),
        createdAt: row[1] instanceof Date
          ? Utilities.formatDate(row[1], 'JST', 'yyyy/MM/dd HH:mm:ss')
          : String(row[1] || ''),
        type: String(row[3] || ''),
        scope: p3ScopeDisplay_(row[4]),
        label: String(row[5] || ''),
        expiresAt: row[6] instanceof Date
          ? Utilities.formatDate(row[6], 'JST', 'yyyy/MM/dd')
          : String(row[6] || ''),
        actor: String(row[2] || '')
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, max);
    return { success: true, items };
  } catch (e) {
    logError('listRestorePointsFromWeb', e);
    return { success: false, error: e.message };
  }
}

function createWeekRestorePointFromWeb(mondayDateStr, label) {
  try {
    ensureDataProtectionReady_();
    const week = getWeeklyPlanDataV2(mondayDateStr);
    if (!week || !week.success) throw new Error((week && week.error) || '週案を取得できませんでした');
    const id = p3CreateSnapshot_(
      'week',
      p3WeekScope_(mondayDateStr),
      label || '手動復元ポイント',
      {
        schemaVersion: P3_SCHEMA_VERSION_,
        spreadsheetId: getSs_().getId(),
        activeSheet: getDbSheet_(getSs_()).getName(),
        week
      }
    );
    p3RecordAudit_(
      'SNAPSHOT_CREATE',
      'week',
      mondayDateStr,
      '週案の復元ポイントを作成',
      null,
      { snapshotId: id, label: label || '手動復元ポイント' },
      id
    );
    return { success: true, snapshotId: id, message: 'この週の復元ポイントを作成しました。' };
  } catch (e) {
    logError('createWeekRestorePointFromWeb', e);
    return { success: false, error: e.message };
  }
}

function saveWeeklyPlanDataProtected(mondayDateStr, days, baseRevision, source, expectedSheetName) {
  // 保存前スナップショットと監査ログは保存本体で常時実施される。
  // ここは監査ログの操作元と、保存先学級の照合を渡すための入口。
  return saveWeeklyPlanWeek_(mondayDateStr, days, baseRevision, {
    source: source || 'web',
    expectedSheetName: expectedSheetName
  });
}

function p3RestoreReflections_(mondayDateStr, snapshotDays) {
  const ss = getSs_();
  const sheet = getDbSheet_(ss);
  const cols = getDbColumns();
  if (!sheet || (!cols.REFLECTION && !cols.REFLECTION_STATUS)) return;

  const dateStrs = p2WeekDateStrings_(mondayDateStr);
  const rowState = p2ReadRowsForDates_(sheet, cols, dateStrs);
  (snapshotDays || []).forEach(day => {
    const rowNumber = rowState.rowNumberByDate.get(day.date);
    if (!rowNumber) return;
    if (cols.REFLECTION) sheet.getRange(rowNumber, cols.REFLECTION).setValue(day.reflection || '');
    if (cols.REFLECTION_STATUS) {
      sheet.getRange(rowNumber, cols.REFLECTION_STATUS).setValue(day.reflectionStatus || '');
    }
  });
}

function p3SummarizeWeekDiff_(currentDays, targetDays) {
  const fieldLabels = {
    event: '行事', preclass: '登校前', morning: '朝学習', recess1: '中休み',
    recess2: '昼休み', afterschool: '放課後', homework: '宿題', items: '持ち物',
    reflection: '振り返り', reflectionStatus: '振り返り状態'
  };
  const currentByDate = {};
  (currentDays || []).forEach(day => { currentByDate[day.date] = day; });
  const changes = [];
  (targetDays || []).forEach(target => {
    const current = currentByDate[target.date] || {};
    const fields = [];
    Object.keys(fieldLabels).forEach(key => {
      if (String(current[key] || '') !== String(target[key] || '')) fields.push(fieldLabels[key]);
    });
    for (let n = 0; n < 6; n++) {
      const a = (current.periods && current.periods[n]) || {};
      const b = (target.periods && target.periods[n]) || {};
      if (String(a.subject || '') !== String(b.subject || '')
        || String(a.unit || '') !== String(b.unit || '')
        || String(a.content || '') !== String(b.content || '')) {
        fields.push((n + 1) + '校時');
      }
    }
    if (fields.length) changes.push({ date: target.date, dayLabel: target.dayLabel || '', fields });
  });
  return changes;
}

function previewWeekSnapshotFromWeb(snapshotId) {
  try {
    ensureDataProtectionReady_();
    const snapshot = p3ReadSnapshot_(snapshotId);
    if (!snapshot || snapshot.type !== 'week' || !snapshot.payload.week) {
      throw new Error('週案の復元ポイントが見つかりません。');
    }
    const mismatch = p3SnapshotSheetMismatch_(snapshot);
    if (mismatch) throw new Error(mismatch);
    const target = snapshot.payload.week;
    const mondayDateStr = target.mondayDateStr || p3ScopeMonday_(snapshot.scope);
    const current = getWeeklyPlanDataV2(mondayDateStr);
    if (!current || !current.success) throw new Error((current && current.error) || '現在の週案を取得できません');
    const changes = p3SummarizeWeekDiff_(current.days, target.days || []);
    return {
      success: true, snapshotId, mondayDateStr, label: snapshot.label,
      createdAt: snapshot.createdAt instanceof Date
        ? Utilities.formatDate(snapshot.createdAt, 'JST', 'yyyy/MM/dd HH:mm:ss')
        : String(snapshot.createdAt || ''),
      changedDays: changes.length, changes, noChanges: changes.length === 0
    };
  } catch (e) {
    logError('previewWeekSnapshotFromWeb', e);
    return { success: false, error: e.message };
  }
}

function restoreWeekSnapshotFromWeb(snapshotId) {
  const correlationId = 'restore_' + Utilities.getUuid();
  try {
    ensureDataProtectionReady_();
    const snapshot = p3ReadSnapshot_(snapshotId);
    if (!snapshot) throw new Error('復元ポイントが見つかりません。');
    if (snapshot.type !== 'week' || !snapshot.payload.week) {
      throw new Error('この復元ポイントは週案復元に対応していません。');
    }

    const mismatch = p3SnapshotSheetMismatch_(snapshot);
    if (mismatch) throw new Error(mismatch);

    const week = snapshot.payload.week;
    const mondayDateStr = week.mondayDateStr || p3ScopeMonday_(snapshot.scope);
    const current = getWeeklyPlanDataV2(mondayDateStr);
    if (!current || !current.success) throw new Error((current && current.error) || '現在の週案を取得できません');

    const safetySnapshotId = p3CreateSnapshot_(
      'week',
      p3WeekScope_(mondayDateStr),
      '自動: 復元直前',
      {
        schemaVersion: P3_SCHEMA_VERSION_,
        spreadsheetId: getSs_().getId(),
        activeSheet: getDbSheet_(getSs_()).getName(),
        week: current
      }
    );

    // 復元直前スナップショットは上で作成済みのため、保存側の自動スナップショットは省略する
    const result = saveWeeklyPlanWeek_(mondayDateStr, week.days || [], current.revision, { protect: false, source: 'restore' });
    if (!result || !result.success) {
      throw new Error((result && result.error) || '週案の復元に失敗しました');
    }
    p3RestoreReflections_(mondayDateStr, week.days || []);

    p3RecordAudit_(
      'WEEK_RESTORE',
      'week',
      mondayDateStr,
      '復元ポイントから週案を復元',
      { currentRevision: current.revision, safetySnapshotId },
      { restoredSnapshotId: snapshotId, restoredRevision: result.revision },
      correlationId
    );

    return {
      success: true,
      message: '週案を復元しました。復元直前の状態も新しい復元ポイントとして保存されています。',
      mondayDateStr,
      safetySnapshotId,
      result
    };
  } catch (e) {
    logError('restoreWeekSnapshotFromWeb', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 単元マスタの復元ポイントから復元します。
 *
 * 単元単位（unit::教科::単元名）は該当単元の行だけを、
 * シート全体（sheet::単元マスタ）は全データ行を差し戻します。
 * 復元の直前にも安全用スナップショットを作成します。
 */
function restoreUnitMasterSnapshotFromWeb(snapshotId) {
  const correlationId = 'restore_unit_' + Utilities.getUuid();
  try {
    ensureDataProtectionReady_();
    const snapshot = p3ReadSnapshot_(snapshotId);
    if (!snapshot) throw new Error('復元ポイントが見つかりません。');
    if (snapshot.type !== 'unitMaster' || !snapshot.payload) {
      throw new Error('この復元ポイントは単元マスタの復元に対応していません。');
    }
    // rowPages（現行）と rows（旧形式）の両方を受け付ける
    const storedRows = p4UnpageRows_(snapshot.payload);
    if (storedRows.length === 0) {
      throw new Error('この復元ポイントには単元マスタの行が含まれていません。');
    }

    return p3WithUserLock_(20000, function () {
      const ss = getSs_();
      const sheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
      if (!sheet) throw new Error('単元マスタシートが見つかりません。');

      const width = P4_MASTER_WIDTH_;
      const rows = storedRows.map(function (r) {
        const out = [];
        for (let i = 0; i < width; i++) out.push(r[i] === undefined ? '' : r[i]);
        return out;
      });
      const lastRow = sheet.getLastRow();

      if (snapshot.payload.scopeType === 'sheet') {
        // シート全体の差し戻し
        const safetyId = p3CreateSnapshot_(
          'unitMaster', 'sheet::' + SHEET_NAME_UNIT_MASTER, '自動: 復元直前',
          {
            schemaVersion: P3_SCHEMA_VERSION_, spreadsheetId: ss.getId(), scopeType: 'sheet',
            // 復元直前の退避も200行で切り詰められないようページに分ける
            rowPages: p4PageRows_(lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, width).getValues() : [])
          }
        );
        if (rows.length > 0) {
          p4EnsureRowCapacity_(sheet, rows.length + 1);
          sheet.getRange(2, 1, rows.length, width).setValues(rows);
        }
        const excess = (lastRow - 1) - rows.length;
        if (excess > 0) sheet.deleteRows(2 + rows.length, excess);
        invalidateUnitProgressCache_();
        p3RecordAudit_('UNIT_MASTER_RESTORE', 'unitMaster', SHEET_NAME_UNIT_MASTER,
          '単元マスタ全体を復元', { safetySnapshotId: safetyId }, { restoredSnapshotId: snapshotId }, correlationId);
        return { success: true, safetySnapshotId: safetyId, message: '単元マスタを復元しました。' };
      }

      // 単元単位の差し戻し。単元名は変わっていない前提で現在の行を探し直す。
      const subject = String(snapshot.payload.subject || '');
      const unitName = String(snapshot.payload.unitName || '');
      if (!unitName) throw new Error('復元ポイントに単元情報がありません。');

      const hours = rows.map(function (r, i) {
        return { hour: i + 1, activity: r[MASTER_COL_ACTIVITY - 1] };
      });
      const declared = rows.map(function (r) { return parseInt(r[MASTER_COL_TOTAL_HOURS - 1], 10); })
        .filter(function (v) { return !isNaN(v) && v > 0; });

      const result = p4WriteUnitRows_(subject, unitName, hours, {
        totalHours: declared.length ? Math.max.apply(null, declared) : rows.length,
        auditAction: 'UNIT_RESTORE',
        label: '自動: 復元直前'
      });

      p3RecordAudit_('UNIT_MASTER_RESTORE', 'unitMaster', subject + '/' + unitName,
        '単元「' + unitName + '」を復元',
        { safetySnapshotId: result.snapshotId }, { restoredSnapshotId: snapshotId }, correlationId);

      return {
        success: true,
        safetySnapshotId: result.snapshotId,
        message: '単元「' + unitName + '」を復元しました。'
      };
    });
  } catch (e) {
    logError('restoreUnitMasterSnapshotFromWeb', e);
    return { success: false, error: e.message };
  }
}
