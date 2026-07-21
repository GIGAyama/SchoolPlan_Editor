function p3AppendTrash_(entityType, entityId, label, payload) {
  const ss = getSs_();
  const sheet = p3EnsureInternalSheets_(ss).trash;
  const deletedAt = new Date();
  const expiresAt = new Date(deletedAt.getTime() + P3_TRASH_RETENTION_DAYS_ * 86400000);
  const trashId = 'trash_' + Utilities.getUuid();
  const json = JSON.stringify(p3Redact_(payload));
  if (json.length > P3_CHUNK_SIZE_) throw new Error('削除対象が大きすぎるため、ごみ箱へ移動できません。');
  sheet.appendRow([
    trashId,
    deletedAt,
    expiresAt,
    p3Actor_(),
    entityType,
    String(entityId || ''),
    String(label || '').substring(0, 500),
    json
  ]);
  return trashId;
}

function p3CleanupExpiredTrash_(ss) {
  const sheet = p3EnsureInternalSheets_(ss).trash;
  if (sheet.getLastRow() < 2) return 0;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, P3_TRASH_HEADERS_.length).getValues();
  const now = Date.now();
  let removed = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    const expires = values[i][2] instanceof Date ? values[i][2].getTime() : new Date(values[i][2]).getTime();
    if (expires && expires < now) {
      sheet.deleteRow(i + 2);
      removed++;
    }
  }
  return removed;
}

function listTrashFromWeb(limit) {
  try {
    ensureDataProtectionReady_();
    const ss = getSs_();
    p3CleanupExpiredTrash_(ss);
    const sheet = p3EnsureInternalSheets_(ss).trash;
    if (sheet.getLastRow() < 2) return { success: true, items: [] };
    const max = Math.max(1, Math.min(parseInt(limit, 10) || 100, 300));
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, P3_TRASH_HEADERS_.length).getValues();
    const items = values.map(row => ({
      id: String(row[0]),
      deletedAt: row[1] instanceof Date ? Utilities.formatDate(row[1], 'JST', 'yyyy/MM/dd HH:mm:ss') : String(row[1]),
      expiresAt: row[2] instanceof Date ? Utilities.formatDate(row[2], 'JST', 'yyyy/MM/dd') : String(row[2]),
      actor: String(row[3] || ''),
      entityType: String(row[4] || ''),
      entityId: String(row[5] || ''),
      label: String(row[6] || '')
    })).reverse().slice(0, max);
    return { success: true, items };
  } catch (e) {
    logError('listTrashFromWeb', e);
    return { success: false, error: e.message };
  }
}

function p3FindTrashRow_(trashId) {
  const ss = getSs_();
  const sheet = p3EnsureInternalSheets_(ss).trash;
  if (sheet.getLastRow() < 2) return null;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, P3_TRASH_HEADERS_.length).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(trashId)) {
      return { sheet, sheetRow: i + 2, row: values[i], payload: JSON.parse(String(values[i][7] || '{}')) };
    }
  }
  return null;
}

function trashTaskFromWebApp(taskId) {
  try {
    ensureDataProtectionReady_();
    validateParams_({ taskId }, { taskId: { type: 'string', required: true, maxLength: 100 } });
    const ss = getSs_();
    const sheet = initTaskSheet_(ss);
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (!isSameTaskId_(data[i][0], taskId)) continue;
      const row = data[i].slice(0, 8);
      while (row.length < 8) row.push('');
      const task = {
        id: String(row[0]),
        content: row[1] || '',
        resource: row[2] || '',
        dueDate: row[3] instanceof Date ? Utilities.formatDate(row[3], 'JST', 'yyyy-MM-dd') : row[3] || '',
        source: row[4] || '',
        status: row[5] || '未着手',
        priority: row[6] || '中',
        memo: row[7] || '',
        originalRow: i + 1
      };
      const trashId = p3AppendTrash_('task', task.id, task.content, task);
      sheet.deleteRow(i + 1);
      SpreadsheetApp.flush();
      p3RecordAudit_('TRASH', 'task', task.id, 'タスクをごみ箱へ移動', task, { trashId }, trashId);
      return { success: true, trashId, message: 'タスクをごみ箱へ移動しました。30日以内は復元できます。' };
    }
    return { success: false, error: '対象のタスクが見つかりませんでした。' };
  } catch (e) {
    logError('trashTaskFromWebApp', e);
    return { success: false, error: e.message };
  }
}

function trashUnitMasterRowFromWeb(rowIndex) {
  try {
    ensureDataProtectionReady_();
    const index = parseInt(rowIndex, 10);
    if (!Number.isFinite(index) || index < 2) throw new Error('行番号が不正です。');
    const ss = getSs_();
    const sheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
    if (!sheet || index > sheet.getLastRow()) throw new Error('対象行が見つかりません。');
    const row = sheet.getRange(index, 1, 1, 5).getValues()[0];
    const payload = {
      originalRow: index,
      values: row,
      subject: row[0] || '',
      unitName: row[1] || '',
      hourNum: row[3] || ''
    };
    const label = [payload.subject, payload.unitName, payload.hourNum ? payload.hourNum + '時間目' : '']
      .filter(Boolean).join(' / ');
    const trashId = p3AppendTrash_('unitMaster', String(index), label, payload);
    sheet.deleteRow(index);
    SpreadsheetApp.flush();
    p3RecordAudit_('TRASH', 'unitMaster', String(index), '単元マスタ行をごみ箱へ移動', payload, { trashId }, trashId);
    return { success: true, trashId, message: '単元マスタ行をごみ箱へ移動しました。' };
  } catch (e) {
    logError('trashUnitMasterRowFromWeb', e);
    return { success: false, error: e.message };
  }
}

function trashNewsletterDataFromWeb(rowIndex, fileId) {
  try {
    ensureDataProtectionReady_();
    const ss = getSs_();
    const sheet = ss.getSheetByName(SHEET_NAME_NEWSLETTER_DATA);
    const index = parseInt(rowIndex, 10);
    if (!sheet || !Number.isFinite(index) || index < 2 || index > sheet.getLastRow()) {
      throw new Error('保存済み学級通信が見つかりません。');
    }
    const width = Math.max(4, Math.min(5, sheet.getLastColumn()));
    const values = sheet.getRange(index, 1, 1, width).getValues()[0];
    const payload = { originalRow: index, width, values, fileId: String(fileId || '') };
    const label = String(values[1] || values[0] || '学級通信');
    const trashId = p3AppendTrash_('newsletter', String(fileId || index), label, payload);
    sheet.deleteRow(index);
    try { if (fileId) DriveApp.getFileById(String(fileId)).setTrashed(true); } catch (e) {}
    p3RecordAudit_('TRASH', 'newsletter', String(fileId || index), '学級通信をごみ箱へ移動', payload, { trashId }, trashId);
    return { success: true, trashId, message: '学級通信をごみ箱へ移動しました。' };
  } catch (e) {
    logError('trashNewsletterDataFromWeb', e);
    return { success: false, error: e.message };
  }
}

function restoreTrashItemFromWeb(trashId) {
  try {
    ensureDataProtectionReady_();
    const found = p3FindTrashRow_(trashId);
    if (!found) throw new Error('ごみ箱の項目が見つかりません。');
    const type = String(found.row[4]);
    const payload = found.payload;
    const ss = getSs_();

    if (type === 'task') {
      const sheet = initTaskSheet_(ss);
      const existingIds = sheet.getLastRow() >= 2
        ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues().map(r => r[0])
        : [];
      let id = String(payload.id || 'tsk_' + Utilities.getUuid().split('-')[0]);
      if (existingIds.some(existing => isSameTaskId_(existing, id))) {
        id = id + '_restored_' + Utilities.formatDate(new Date(), 'JST', 'yyyyMMddHHmmss');
      }
      const row = [
        id, payload.content || '', payload.resource || '', payload.dueDate || '',
        payload.source || '', payload.status || '未着手', payload.priority || '中', payload.memo || ''
      ];
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, 8).setValues([row]);
    } else if (type === 'unitMaster') {
      const sheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
      if (!sheet) throw new Error('単元マスタシートが見つかりません。');
      const appendRow = sheet.getLastRow() + 1;
      const desiredRow = parseInt(payload.originalRow, 10);
      const targetRow = Number.isFinite(desiredRow)
        ? Math.max(2, Math.min(desiredRow, appendRow))
        : appendRow;
      if (targetRow < appendRow) sheet.insertRowBefore(targetRow);
      sheet.getRange(targetRow, 1, 1, 5).setValues([payload.values || ['', '', '', '', '']]);
    } else if (type === 'newsletter') {
      const sheet = ss.getSheetByName(SHEET_NAME_NEWSLETTER_DATA);
      if (!sheet) throw new Error('学級通信データシートが見つかりません。');
      const appendRow = sheet.getLastRow() + 1;
      const desiredRow = parseInt(payload.originalRow, 10);
      const targetRow = Number.isFinite(desiredRow)
        ? Math.max(2, Math.min(desiredRow, appendRow))
        : appendRow;
      if (targetRow < appendRow) sheet.insertRowBefore(targetRow);
      const width = Math.max(4, Math.min(parseInt(payload.width, 10) || 5, Math.max(5, sheet.getLastColumn())));
      const values = Array.isArray(payload.values) ? payload.values.slice(0, width) : [];
      while (values.length < width) values.push('');
      sheet.getRange(targetRow, 1, 1, width).setValues([values]);
      try { if (payload.fileId) DriveApp.getFileById(payload.fileId).setTrashed(false); } catch (e) {}
    } else {
      throw new Error('この項目の復元方式が定義されていません: ' + type);
    }

    found.sheet.deleteRow(found.sheetRow);
    SpreadsheetApp.flush();
    p3RecordAudit_('RESTORE_TRASH', type, String(found.row[5] || ''), 'ごみ箱から復元', { trashId }, payload, trashId);
    return { success: true, entityType: type, message: 'ごみ箱から復元しました。' };
  } catch (e) {
    logError('restoreTrashItemFromWeb', e);
    return { success: false, error: e.message };
  }
}

function purgeTrashItemFromWeb(trashId) {
  try {
    ensureDataProtectionReady_();
    const found = p3FindTrashRow_(trashId);
    if (!found) throw new Error('ごみ箱の項目が見つかりません。');
    found.sheet.deleteRow(found.sheetRow);
    p3RecordAudit_(
      'PURGE_TRASH',
      String(found.row[4] || ''),
      String(found.row[5] || ''),
      'ごみ箱から完全削除',
      { trashId, label: found.row[6] },
      null,
      trashId
    );
    return { success: true, message: '完全に削除しました。' };
  } catch (e) {
    logError('purgeTrashItemFromWeb', e);
    return { success: false, error: e.message };
  }
}
