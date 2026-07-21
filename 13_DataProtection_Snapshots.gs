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

  const keepIds = new Set(firstRows.slice(0, P3_SNAPSHOT_MAX_COUNT_).map(item => String(item.row[0])));
  const expiredIds = new Set();
  firstRows.forEach(item => {
    const expires = item.row[6] instanceof Date ? item.row[6].getTime() : new Date(item.row[6]).getTime();
    if ((expires && expires < now) || !keepIds.has(String(item.row[0]))) {
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
        scope: String(row[4] || ''),
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
      mondayDateStr,
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

function p3ComparableDays_(days) {
  return (days || []).map(day => ({
    date: day.date || '',
    event: day.event || '',
    preclass: day.preclass || '',
    morning: day.morning || '',
    periods: (day.periods || []).map(period => ({
      subject: period && period.subject || '',
      unit: period && period.unit || '',
      content: period && period.content || ''
    })),
    recess1: day.recess1 || '',
    recess2: day.recess2 || '',
    afterschool: day.afterschool || '',
    homework: day.homework || '',
    items: day.items || ''
  }));
}

function saveWeeklyPlanDataProtected(mondayDateStr, days, baseRevision, source) {
  const correlationId = 'save_' + Utilities.getUuid();
  try {
    ensureDataProtectionReady_();
    const before = getWeeklyPlanDataV2(mondayDateStr);
    if (!before || !before.success) {
      throw new Error((before && before.error) || '保存前の週案を取得できませんでした');
    }

    const changed = JSON.stringify(p3ComparableDays_(before.days))
      !== JSON.stringify(p3ComparableDays_(days));

    let snapshotId = '';
    if (changed && p3ShouldCreateAutoSnapshot_(mondayDateStr)) {
      snapshotId = p3CreateSnapshot_(
        'week',
        mondayDateStr,
        '自動: 週案保存前',
        {
          schemaVersion: P3_SCHEMA_VERSION_,
          spreadsheetId: getSs_().getId(),
          activeSheet: getDbSheet_(getSs_()).getName(),
          week: before
        }
      );
    }

    const result = saveWeeklyPlanDataV2(mondayDateStr, days, baseRevision);
    if (result && result.success && result.updatedCount > 0) {
      p3RecordAudit_(
        'WEEK_SAVE',
        'week',
        mondayDateStr,
        (source || 'web') + 'から週案を保存 (' + result.updatedCount + '日)',
        { revision: before.revision, snapshotId, days: p3ComparableDays_(before.days) },
        { revision: result.revision, days: p3ComparableDays_(days) },
        correlationId
      );
    }
    if (result && result.success) result.restorePointId = snapshotId;
    return result;
  } catch (e) {
    logError('saveWeeklyPlanDataProtected', e);
    return { success: false, error: e.message };
  }
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
    const target = snapshot.payload.week;
    const mondayDateStr = target.mondayDateStr || snapshot.scope;
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

    const week = snapshot.payload.week;
    const mondayDateStr = week.mondayDateStr || snapshot.scope;
    const current = getWeeklyPlanDataV2(mondayDateStr);
    if (!current || !current.success) throw new Error((current && current.error) || '現在の週案を取得できません');

    const safetySnapshotId = p3CreateSnapshot_(
      'week',
      mondayDateStr,
      '自動: 復元直前',
      {
        schemaVersion: P3_SCHEMA_VERSION_,
        spreadsheetId: getSs_().getId(),
        activeSheet: getDbSheet_(getSs_()).getName(),
        week: current
      }
    );

    const result = saveWeeklyPlanDataV2(mondayDateStr, week.days || [], current.revision);
    if (!result || !result.success) {
      throw new Error((result && result.error) || '週案の復元に失敗しました');
    }
    p3RestoreReflections_(mondayDateStr, week.days || []);
    SpreadsheetApp.flush();

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
