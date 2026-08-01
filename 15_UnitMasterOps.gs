/**
 * @fileoverview 単元マスタの「単元単位」の読み書きと整合性検査・修復。
 *
 * 単元マスタは 1行 = 1単元の1時間分 という持ち方で、総時間数は同じ単元の全行に
 * 重複して入る。単元IDは無く、同一性は (教科, 単元名) の文字列一致で決まり、
 * シート上の行の並び順がそのまま年間指導計画の指導順になる。
 *
 * このため単元を書き換えるときは「その単元の行だけを、位置を保ったまま」
 * 差し替える必要がある。既存の applyExtractedUnitsFromWeb は教科単位で全削除して
 * シート末尾に追記するため並び順が壊れ、この用途には使えない。
 *
 * トップレベルでGAS APIを呼ばない（テストで vm.runInContext に読み込めるようにするため）。
 */

/** 単元マスタの列数（教科・単元名・総時間数・何時間目・学習活動）。 */
const P4_MASTER_WIDTH_ = 5;

// ===================================================
// ===== 整合性の解析（純粋関数・テスト対象） =====
// ===================================================

/**
 * 単元マスタの全行を単元ごとにまとめ、不整合を検出します。
 * GAS API を呼ばないため、テストから直接実行できます。
 *
 * @param {Array<Array>} masterData 単元マスタの全行（1行目はヘッダー）
 * @param {Object} plannedHistory buildTaughtHistory_ の結果（週案全体を対象にしたもの）
 * @param {Array<{subject: string, hours: number}>} standardHours 教科別の年間標準時数
 * @returns {Object} { units, subjectTotals, orphanUnits, summary }
 */
function analyzeUnitConsistency_(masterData, plannedHistory, standardHours) {
  const units = [];
  const byKey = {};       // subjectKey||unitName -> unit
  const order = [];

  for (let i = 1; i < masterData.length; i++) {
    const row = masterData[i] || [];
    const subjectRaw = row[MASTER_COL_SUBJECT - 1];
    const unitName = row[MASTER_COL_UNIT_NAME - 1];
    if (!subjectRaw || !unitName) continue;

    const subjectKey = normalizeSubjectName_(subjectRaw);
    const name = String(unitName).trim();
    const key = subjectKey + '||' + name;
    let u = byKey[key];
    if (!u) {
      u = byKey[key] = {
        subject: String(subjectRaw).trim(),
        subjectKey: subjectKey,
        unitName: name,
        sheetRows: [],
        declaredValues: [],
        hourNumbers: [],
        issues: []
      };
      order.push(key);
    }
    u.sheetRows.push(i + 1); // シート上の実際の行番号（1始まり・ヘッダーが1行目）
    u.declaredValues.push(parseInt(row[MASTER_COL_TOTAL_HOURS - 1], 10));
    const h = parseInt(row[MASTER_COL_HOUR_NUM - 1], 10);
    u.hourNumbers.push(isNaN(h) ? null : h);
  }

  order.forEach(function (key) {
    const u = byKey[key];
    u.rowCount = u.sheetRows.length;
    u.firstRow = u.sheetRows[0];
    u.lastRow = u.sheetRows[u.sheetRows.length - 1];

    const declared = u.declaredValues.filter(function (v) { return !isNaN(v) && v > 0; });
    u.declaredTotal = declared.length ? Math.max.apply(null, declared) : 0;

    const ph = plannedHistory && plannedHistory[u.subjectKey] && plannedHistory[u.subjectKey].units[u.unitName];
    u.plannedHour = ph ? ph.maxHour : 0;

    // 行がシート上で連続しているか
    const contiguous = u.sheetRows.every(function (r, i) {
      return i === 0 || r === u.sheetRows[i - 1] + 1;
    });
    if (!contiguous) u.issues.push('NON_CONTIGUOUS');

    // 総時間数が行数と食い違う（行を足しても総時間数を増やさない既存UIの副作用）
    if (u.declaredTotal !== u.rowCount) u.issues.push('TOTAL_MISMATCH');

    // 総時間数が行ごとにバラバラ
    const distinct = {};
    u.declaredValues.forEach(function (v) { if (!isNaN(v)) distinct[v] = true; });
    if (Object.keys(distinct).length > 1) u.issues.push('TOTAL_INCONSISTENT');

    // 何時間目が空
    if (u.hourNumbers.some(function (h) { return h === null; })) u.issues.push('MISSING_HOUR');

    // 何時間目の重複・欠番
    const seen = {};
    let dup = false;
    u.hourNumbers.forEach(function (h) {
      if (h === null) return;
      if (seen[h]) dup = true;
      seen[h] = true;
    });
    if (dup) u.issues.push('HOUR_DUPLICATE');
    for (let h = 1; h <= u.rowCount; h++) {
      if (!seen[h]) { u.issues.push('HOUR_GAP'); break; }
    }

    // 週案上で総時数を超えて指導済み（自動修復はしない。警告のみ）
    if (u.plannedHour > Math.max(u.declaredTotal, u.rowCount)) u.issues.push('TAUGHT_EXCEEDS_TOTAL');

    // 修復計画: 内容は消さず、並べ替え・連番振り直し・総時数再設定・不足行の追加だけ行う。
    // 週案で既に指導済みの時数を下回らせない（下回る場合は空活動の行で埋める）。
    const targetRows = Math.max(u.rowCount, u.plannedHour);
    u.repairPlan = {
      totalHours: targetRows,
      renumber: u.issues.indexOf('HOUR_DUPLICATE') !== -1
        || u.issues.indexOf('HOUR_GAP') !== -1
        || u.issues.indexOf('MISSING_HOUR') !== -1,
      fixTotal: u.issues.indexOf('TOTAL_MISMATCH') !== -1
        || u.issues.indexOf('TOTAL_INCONSISTENT') !== -1,
      defragment: u.issues.indexOf('NON_CONTIGUOUS') !== -1,
      padRows: Math.max(0, u.plannedHour - u.rowCount)
    };
    // TAUGHT_EXCEEDS_TOTAL だけの単元も、行を足せば整合させられる
    u.repairable = u.repairPlan.renumber || u.repairPlan.fixTotal
      || u.repairPlan.defragment || u.repairPlan.padRows > 0;

    units.push(u);
  });

  // 教科ごとの単元時数合計と、年間標準時数の突き合わせ
  const stdByKey = {};
  (standardHours || []).forEach(function (s) {
    if (s && s.subject) stdByKey[normalizeSubjectName_(s.subject)] = s.hours || 0;
  });
  const totalsByKey = {};
  units.forEach(function (u) {
    if (!totalsByKey[u.subjectKey]) {
      totalsByKey[u.subjectKey] = { subject: u.subject, subjectKey: u.subjectKey, unitCount: 0, unitHoursTotal: 0 };
    }
    const t = totalsByKey[u.subjectKey];
    t.unitCount++;
    t.unitHoursTotal += Math.max(u.declaredTotal, u.rowCount);
  });
  const subjectTotals = Object.keys(totalsByKey).map(function (k) {
    const t = totalsByKey[k];
    const std = stdByKey[k];
    return {
      subject: t.subject,
      subjectKey: k,
      unitCount: t.unitCount,
      unitHoursTotal: t.unitHoursTotal,
      standardHours: (std === undefined) ? null : std,
      diff: (std === undefined) ? null : (t.unitHoursTotal - std)
    };
  });

  // 週案にあるが単元マスタに無い単元
  const orphanUnits = [];
  Object.keys(plannedHistory || {}).forEach(function (subjectKey) {
    Object.keys(plannedHistory[subjectKey].units).forEach(function (name) {
      if (!byKey[subjectKey + '||' + name]) {
        orphanUnits.push({
          subject: subjectKey,
          unitName: name,
          plannedHour: plannedHistory[subjectKey].units[name].maxHour
        });
      }
    });
  });

  const byType = {};
  units.forEach(function (u) {
    u.issues.forEach(function (t) { byType[t] = (byType[t] || 0) + 1; });
  });

  return {
    units: units,
    subjectTotals: subjectTotals,
    orphanUnits: orphanUnits,
    summary: {
      unitCount: units.length,
      issueCount: units.filter(function (u) { return u.issues.length > 0; }).length,
      byType: byType
    }
  };
}

/**
 * 修復後の単元マスタ全行をメモリ上で組み立てます（純粋関数・テスト対象）。
 * 単元の登場順（最初に現れた行の順）を保ったまま、指定された単元だけを整えます。
 *
 * @param {Array<Array>} masterData 単元マスタの全行（1行目はヘッダー）
 * @param {Object} analysis analyzeUnitConsistency_ の結果
 * @param {Array<{subject: string, unitName: string}>} targets 修復対象
 * @returns {{rows: Array<Array>, repaired: Array<Object>}} rows はヘッダーを除く全データ行
 */
function buildRepairedMasterRows_(masterData, analysis, targets) {
  const targetKeys = {};
  (targets || []).forEach(function (t) {
    if (!t || !t.unitName) return;
    targetKeys[normalizeSubjectName_(t.subject) + '||' + String(t.unitName).trim()] = true;
  });

  // 単元ごとに元の行をまとめる（登場順を保持）
  const groups = [];
  const groupByKey = {};
  for (let i = 1; i < masterData.length; i++) {
    const row = masterData[i] || [];
    const subjectRaw = row[MASTER_COL_SUBJECT - 1];
    const unitName = row[MASTER_COL_UNIT_NAME - 1];
    if (!subjectRaw || !unitName) continue;
    const key = normalizeSubjectName_(subjectRaw) + '||' + String(unitName).trim();
    let g = groupByKey[key];
    if (!g) {
      g = groupByKey[key] = { key: key, rows: [] };
      groups.push(g);
    }
    g.rows.push(row.slice(0, P4_MASTER_WIDTH_));
  }

  const analysisByKey = {};
  analysis.units.forEach(function (u) { analysisByKey[u.subjectKey + '||' + u.unitName] = u; });

  const repaired = [];
  const out = [];
  groups.forEach(function (g) {
    if (!targetKeys[g.key]) {
      // 対象外の単元はそのまま
      g.rows.forEach(function (r) { out.push(r); });
      return;
    }
    const u = analysisByKey[g.key];
    if (!u) { g.rows.forEach(function (r) { out.push(r); }); return; }

    // 元の行を「何時間目」の昇順に安定ソート（欠番・重複は元の並びを尊重して詰める）
    const sorted = g.rows.map(function (r, i) {
      const h = parseInt(r[MASTER_COL_HOUR_NUM - 1], 10);
      return { row: r, hour: isNaN(h) ? Number.MAX_SAFE_INTEGER : h, idx: i };
    }).sort(function (a, b) {
      return a.hour !== b.hour ? a.hour - b.hour : a.idx - b.idx;
    }).map(function (x) { return x.row; });

    const targetRows = u.repairPlan.totalHours;
    const subjectLabel = sorted[0][MASTER_COL_SUBJECT - 1];
    const nameLabel = sorted[0][MASTER_COL_UNIT_NAME - 1];

    for (let h = 1; h <= targetRows; h++) {
      const src = sorted[h - 1];
      out.push([
        subjectLabel,
        nameLabel,
        targetRows,
        h,
        src ? src[MASTER_COL_ACTIVITY - 1] : ''   // 不足分は空の学習活動で埋める（内容は消さない）
      ]);
    }
    repaired.push({
      subject: u.subject,
      unitName: u.unitName,
      issues: u.issues.slice(),
      rowsBefore: g.rows.length,
      rowsAfter: targetRows
    });
  });

  return { rows: out, repaired: repaired };
}

// ===================================================
// ===== 単元単位の書き込み（B・Cの中核） =====
// ===================================================

/**
 * 単元マスタの「1単元分の行」だけを、シート上の位置を保ったまま安全に置き換えます。
 *
 * 位置をそのまま使うことが重要で、単元の物理的な並び順が buildMasterIndex_ の
 * unit.order すなわち年間指導計画の指導順になっているためです。
 *
 * @param {string} subject 教科名（表記ゆれ可）
 * @param {string} unitName 単元名
 * @param {Array<{hour: number, activity: string}>} hours 1..N の昇順連番
 * @param {Object} [options] { totalHours, expectedRowCount, expectedFirstRow, auditAction, label }
 * @returns {Object} { firstRow, rowsBefore, rowsAfter, snapshotId }
 */
function p4WriteUnitRows_(subject, unitName, hours, options) {
  options = options || {};
  ensureDataProtectionReady_();

  return p3WithUserLock_(20000, function () {
    const ss = getSs_();
    const sheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
    if (!sheet) throw new Error('単元マスタシートが見つかりません。');
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) throw new Error('単元マスタにデータがありません。');

    const all = sheet.getRange(1, 1, lastRow, P4_MASTER_WIDTH_).getValues();
    const name = String(unitName).trim();
    const sheetRows = [];
    for (let i = 1; i < all.length; i++) {
      if (isSameSubject_(all[i][MASTER_COL_SUBJECT - 1], subject)
        && String(all[i][MASTER_COL_UNIT_NAME - 1]).trim() === name) {
        sheetRows.push(i + 1);
      }
    }
    if (sheetRows.length === 0) {
      throw new Error('単元「' + name + '」が単元マスタに見つかりません。');
    }

    // 連続性ゲート: 行が飛び飛びだと位置を保った差し替えができない。
    // 並べ替えを行うのは整合性チェックの修復だけ、という役割分担にしている。
    const contiguous = sheetRows.every(function (r, i) {
      return i === 0 || r === sheetRows[i - 1] + 1;
    });
    if (!contiguous) {
      throw new Error('単元「' + name + '」の行がシート上で連続していません。'
        + '「整合性チェック」で修復してから再度お試しください。');
    }

    const firstRow = sheetRows[0];
    const rowsBefore = sheetRows.length;

    // 楽観ガード: プレビューを開いてから他の操作で行構成が変わっていたら中断する
    if (options.expectedRowCount !== undefined && options.expectedRowCount !== null
      && parseInt(options.expectedRowCount, 10) !== rowsBefore) {
      throw new Error('単元マスタが他の操作で変更されています。画面を更新してからやり直してください。');
    }
    if (options.expectedFirstRow !== undefined && options.expectedFirstRow !== null
      && parseInt(options.expectedFirstRow, 10) !== firstRow) {
      throw new Error('単元マスタが他の操作で変更されています。画面を更新してからやり直してください。');
    }

    const rowsAfter = hours.length;
    if (rowsAfter < 1) throw new Error('時間数は1以上である必要があります。');

    const currentValues = all.slice(firstRow - 1, firstRow - 1 + rowsBefore);
    const snapshotId = p3CreateSnapshot_(
      'unitMaster',
      'unit::' + normalizeSubjectName_(subject) + '::' + name,
      options.label || ('自動: 単元「' + name + '」変更前'),
      {
        schemaVersion: P3_SCHEMA_VERSION_,
        spreadsheetId: ss.getId(),
        subject: subject,
        unitName: name,
        firstRow: firstRow,
        rows: currentValues
      }
    );

    // 教科名・単元名はシート上の既存表記をそのまま引き継ぐ。
    // （利用者が「図工」と書いているのを「図画工作」に勝手に直さない）
    const subjectLabel = currentValues[0][MASTER_COL_SUBJECT - 1];
    const nameLabel = currentValues[0][MASTER_COL_UNIT_NAME - 1];
    const totalHours = parseInt(options.totalHours, 10) || rowsAfter;
    const newRows = hours.map(function (h, i) {
      return [subjectLabel, nameLabel, totalHours, i + 1, String(h.activity || '')];
    });

    // 構造変更は1回だけ（行ごとの deleteRow ループは遅く、途中で失敗すると壊れる）
    if (rowsAfter > rowsBefore) {
      sheet.insertRowsAfter(firstRow + rowsBefore - 1, rowsAfter - rowsBefore);
    } else if (rowsAfter < rowsBefore) {
      sheet.deleteRows(firstRow + rowsAfter, rowsBefore - rowsAfter);
    }
    sheet.getRange(firstRow, 1, rowsAfter, P4_MASTER_WIDTH_).setValues(newRows);
    SpreadsheetApp.flush();

    p3RecordAudit_(
      options.auditAction || 'UNIT_REWRITE',
      'unitMaster',
      subject + '/' + name,
      '単元「' + name + '」を' + rowsBefore + '行から' + rowsAfter + '行に変更',
      { rows: currentValues },
      { rows: newRows, snapshotId: snapshotId },
      'unit_' + Utilities.getUuid()
    );
    invalidateUnitProgressCache_();

    return { firstRow: firstRow, rowsBefore: rowsBefore, rowsAfter: rowsAfter, snapshotId: snapshotId };
  });
}

// ===================================================
// ===== Webアプリ API =====
// ===================================================

/**
 * シートの行数が足りなければ末尾に追加します。
 * 行を切り詰めたシートで setValues が範囲外にならないようにするためのガード。
 */
function p4EnsureRowCapacity_(sheet, neededRows) {
  const max = sheet.getMaxRows();
  if (neededRows > max) sheet.insertRowsAfter(max, neededRows - max);
}

/** 週案全体を対象にした指導履歴を返す内部ヘルパー。 */
function p4PlannedHistory_(ss) {
  const dbSheet = getDbSheet_(ss);
  if (!dbSheet) return {};
  return buildTaughtHistory_(dbSheet.getDataRange().getValues(), getDbColumns(), upFarFuture_());
}

/**
 * [Webアプリ API] 単元マスタの整合性を検査します（書き込みは行いません）。
 * @returns {Object} { success, checkedAt, units, subjectTotals, orphanUnits, summary }
 */
function checkUnitMasterConsistency() {
  try {
    const ss = getSs_();
    const sheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
    if (!sheet || sheet.getLastRow() < 2) {
      return {
        success: true, checkedAt: formatDate(new Date()),
        units: [], subjectTotals: [], orphanUnits: [],
        summary: { unitCount: 0, issueCount: 0, byType: {} }
      };
    }
    const masterData = sheet.getRange(1, 1, sheet.getLastRow(), P4_MASTER_WIDTH_).getValues();
    const stdResult = getStandardHours();
    const standardHours = (stdResult && stdResult.success && stdResult.data) ? stdResult.data : [];

    const analysis = analyzeUnitConsistency_(masterData, p4PlannedHistory_(ss), standardHours);
    analysis.success = true;
    analysis.checkedAt = formatDate(new Date());
    return analysis;
  } catch (e) {
    logError('checkUnitMasterConsistency', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 指定した単元の不整合を修復します（AIは使いません）。
 * 内容は消さず、並べ替え・連番の振り直し・総時数の再設定・不足行の追加のみ行います。
 * @param {Array<{subject: string, unitName: string}>} targets
 * @returns {Object} { success, repaired, snapshotId, message }
 */
function repairUnitMasterConsistency(targets) {
  try {
    validateParams_({ targets }, { targets: { required: true, isArray: true } });
    if (targets.length === 0) return { success: true, repaired: [], message: '対象がありません。' };
    ensureDataProtectionReady_();

    return p3WithUserLock_(20000, function () {
      const ss = getSs_();
      const sheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
      if (!sheet || sheet.getLastRow() < 2) throw new Error('単元マスタにデータがありません。');

      const lastRow = sheet.getLastRow();
      const masterData = sheet.getRange(1, 1, lastRow, P4_MASTER_WIDTH_).getValues();
      const stdResult = getStandardHours();
      const standardHours = (stdResult && stdResult.success && stdResult.data) ? stdResult.data : [];
      const analysis = analyzeUnitConsistency_(masterData, p4PlannedHistory_(ss), standardHours);

      const built = buildRepairedMasterRows_(masterData, analysis, targets);
      if (built.repaired.length === 0) {
        return { success: true, repaired: [], message: '修復が必要な単元はありませんでした。' };
      }

      // 修復は行の並べ替えを伴うため、シート全体のスナップショットを取る
      const snapshotId = p3CreateSnapshot_(
        'unitMaster',
        'sheet::' + SHEET_NAME_UNIT_MASTER,
        '自動: 単元マスタ修復前',
        {
          schemaVersion: P3_SCHEMA_VERSION_,
          spreadsheetId: ss.getId(),
          scopeType: 'sheet',
          rows: masterData.slice(1)
        }
      );

      const rows = built.rows;
      if (rows.length > 0) {
        // 不足行の追加で行数が増える場合、シートの行数が足りないと
        // getRange が範囲外になるため先に広げておく。
        p4EnsureRowCapacity_(sheet, rows.length + 1);
        sheet.getRange(2, 1, rows.length, P4_MASTER_WIDTH_).setValues(rows);
      }
      // 行数が減った場合は末尾の余りを1回で消す
      const excess = (lastRow - 1) - rows.length;
      if (excess > 0) sheet.deleteRows(2 + rows.length, excess);
      SpreadsheetApp.flush();

      p3RecordAudit_(
        'UNIT_MASTER_REPAIR',
        'unitMaster',
        SHEET_NAME_UNIT_MASTER,
        built.repaired.length + '単元の不整合を修復',
        { rowCount: lastRow - 1 },
        { rowCount: rows.length, repaired: built.repaired, snapshotId: snapshotId },
        'repair_' + Utilities.getUuid()
      );
      invalidateUnitProgressCache_();

      return {
        success: true,
        repaired: built.repaired,
        snapshotId: snapshotId,
        message: built.repaired.length + '単元を修復しました。'
      };
    });
  } catch (e) {
    logError('repairUnitMasterConsistency', e);
    return { success: false, error: e.message };
  }
}
