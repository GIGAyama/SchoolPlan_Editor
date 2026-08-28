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
/** スナップショット保存時の1ページあたりの行数（p3Redact_ の配列上限に合わせる）。 */
const P4_SNAPSHOT_PAGE_SIZE_ = 200;

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

    const ph = plannedHistory && plannedHistory[u.subjectKey]
      && plannedHistory[u.subjectKey].units[normalizeUnitName_(u.unitName)];
    u.plannedHour = ph ? ph.maxHour : 0;

    // 行がシート上で連続しているか
    const contiguous = u.sheetRows.every(function (r, i) {
      return i === 0 || r === u.sheetRows[i - 1] + 1;
    });
    if (!contiguous) u.issues.push('NON_CONTIGUOUS');

    // 総時間数のぶんだけ行が無い（行を足しても総時間数を増やさない既存UIの副作用）。
    // 逆に「総時間数 < 行数」は不整合ではない。5時間で組んだ単元を3時間で終えたとき、
    // 4・5時間目の指導案は来年のために残したまま総時数だけ 3 にする、という状態がある。
    // ここを一律に不整合として扱っていたころは、修復のたびに総時数が行数へ戻されて
    // 短く閉じた単元がいつまでも未消化のまま残っていた。
    if (u.declaredTotal > u.rowCount) u.issues.push('TOTAL_MISMATCH');

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
    // 実効時数の決め方（04_AutoFill.gs の effectiveTotal）に合わせる
    t.unitHoursTotal += (u.declaredTotal > 0 ? u.declaredTotal : u.rowCount);
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

  // 週案にあるが単元マスタに無い単元。
  // byKey はシートの表記そのままを鍵にしているので、突き合わせ用の鍵を別に作る
  // （週案側は表記がゆれていても同じ単元として数えたい）。
  const masterNameKeys = {};
  units.forEach(function (u) {
    masterNameKeys[u.subjectKey + '||' + normalizeUnitName_(u.unitName)] = true;
  });
  const orphanUnits = [];
  Object.keys(plannedHistory || {}).forEach(function (subjectKey) {
    Object.keys(plannedHistory[subjectKey].units).forEach(function (nameKey) {
      if (!masterNameKeys[subjectKey + '||' + nameKey]) {
        const pu = plannedHistory[subjectKey].units[nameKey];
        orphanUnits.push({
          subject: subjectKey,
          unitName: pu.displayName || nameKey,
          plannedHour: pu.maxHour
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

  // 単元ごとに元の行をまとめる（登場順を保持）。
  // 教科名または単元名が空の行（区切りの空行・書きかけの行）は、どの単元にも属さないが
  // 呼び出し元がこの結果でシート全体を書き直すため、取りこぼすと消えてしまう。
  // 単独の行としてその場の順序のまま持ち回る。
  const groups = [];
  const groupByKey = {};
  for (let i = 1; i < masterData.length; i++) {
    const row = masterData[i] || [];
    const values = row.slice(0, P4_MASTER_WIDTH_);
    const subjectRaw = row[MASTER_COL_SUBJECT - 1];
    const unitName = row[MASTER_COL_UNIT_NAME - 1];
    if (!subjectRaw || !unitName) {
      // 完全に空の行は復元する意味がないので落とす（シートの余白行）
      const hasContent = values.some(function (v) { return String(v === undefined || v === null ? '' : v).trim() !== ''; });
      if (hasContent) groups.push({ passthrough: values });
      continue;
    }
    const key = normalizeSubjectName_(subjectRaw) + '||' + String(unitName).trim();
    let g = groupByKey[key];
    if (!g) {
      g = groupByKey[key] = { key: key, rows: [] };
      groups.push(g);
    }
    g.rows.push(values);
  }

  const analysisByKey = {};
  analysis.units.forEach(function (u) { analysisByKey[u.subjectKey + '||' + u.unitName] = u; });

  const repaired = [];
  const out = [];
  groups.forEach(function (g) {
    if (g.passthrough) {
      // どの単元にも属さない行はそのまま残す
      out.push(g.passthrough);
      return;
    }
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
        // 通常は数十行だが、こちらも200行で切り詰められないようページに分ける
        rowPages: p4PageRows_(currentValues)
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
 * スナップショット保存用に行を200行ごとのページへ分割します。
 *
 * p3Redact_（13_DataProtection.gs）はあらゆる配列を先頭200要素で切り詰めるため、
 * 数百行になる単元マスタをそのまま渡すと201行目以降が黙って失われ、
 * その復元ポイントから戻したときに実データが消えます。
 * ページに分ければ「ページ数200 × 1ページ200行」まで保持できます。
 */
function p4PageRows_(rows) {
  const pages = [];
  for (let i = 0; i < rows.length; i += P4_SNAPSHOT_PAGE_SIZE_) {
    pages.push(rows.slice(i, i + P4_SNAPSHOT_PAGE_SIZE_));
  }
  return pages;
}

/** ページ分割された行を元の1次元配列へ戻します。 */
function p4UnpageRows_(payload) {
  if (payload && Array.isArray(payload.rowPages)) {
    return payload.rowPages.reduce(function (acc, page) { return acc.concat(page); }, []);
  }
  // 旧形式（rows を直接持つスナップショット）との互換
  return (payload && Array.isArray(payload.rows)) ? payload.rows : [];
}

/**
 * シートの行数が足りなければ末尾に追加します。
 * 行を切り詰めたシートで setValues が範囲外にならないようにするためのガード。
 */
function p4EnsureRowCapacity_(sheet, neededRows) {
  const max = sheet.getMaxRows();
  if (neededRows > max) sheet.insertRowsAfter(max, neededRows - max);
}

/**
 * 週案全体を対象にした指導履歴を返す内部ヘルパー。
 * @param {Spreadsheet} ss
 * @param {Object} [masterIndex] buildMasterIndex_ の結果。渡すと "国語2/3 行事1/3" のような
 *   分け合いの教科セルも、単元マスタのある教科の履歴として集計します。
 */
function p4PlannedHistory_(ss, masterIndex) {
  const dbSheet = getDbSheet_(ss);
  if (!dbSheet) return {};
  return buildTaughtHistory_(dbSheet.getDataRange().getValues(), getDbColumns(), upFarFuture_(), masterIndex);
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

    const analysis = analyzeUnitConsistency_(
      masterData, p4PlannedHistory_(ss, buildMasterIndex_(masterData)), standardHours);
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
      const analysis = analyzeUnitConsistency_(
        masterData, p4PlannedHistory_(ss, buildMasterIndex_(masterData)), standardHours);

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
          // p3Redact_ が配列を200要素で切り詰めるため、行をそのまま渡すと
          // 201行目以降が保存されず、復元時に消えてしまう。
          // 200行ごとのページに分けて全行を保持する。
          rowPages: p4PageRows_(masterData.slice(1))
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

/**
 * [Webアプリ API] 単元を「ここまでで終了」にします。
 *
 * 5時間で組んだ単元を3時間で終えることは実際よくあります。これまでは終わりに
 * する手立てが無く、その単元がいつまでも未消化として残り、自動入力が何度も
 * そこへ戻ってきていました。
 *
 * ここでは単元マスタの**総時間数の列だけ**を、週案に入っている時数へ書き換えます。
 *  - 行は消しません。余った時間の学習活動は来年のためにそのまま残ります
 *    （実効時数は 04_AutoFill.gs の effectiveTotal が総時数を正として決めるため、
 *     行が余っていても「終了」として扱われます）
 *  - 何時間目まで入っているかはクライアントの言い値を使わず、ここで数え直します
 *  - 未来の週に入っている分も含めて数えるので、入力済みのコマが総時数を超えて
 *    宙に浮くことはありません
 *  - 単元マスタは全学級で共通なので、この操作は全学級に効きます
 *
 * @param {string} subject 教科名
 * @param {string} unitName 単元名（表記のゆれは normalizeUnitName_ が吸収します）
 * @returns {Object} { success, changed, unitName, totalHours, previousTotal, snapshotId, message }
 */
function closeUnitAtTaughtHours(subject, unitName) {
  try {
    validateParams_(
      { subject, unitName },
      { subject: { required: true, type: 'string' }, unitName: { required: true, type: 'string' } }
    );
    ensureDataProtectionReady_();

    return p3WithUserLock_(20000, function () {
      const ss = getSs_();
      const sheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
      if (!sheet || sheet.getLastRow() < 2) throw new Error('単元マスタにデータがありません。');

      const subjectKey = normalizeSubjectName_(subject);
      const nameKey = normalizeUnitName_(unitName);

      const lastRow = sheet.getLastRow();
      const all = sheet.getRange(1, 1, lastRow, P4_MASTER_WIDTH_).getValues();

      const history = p4PlannedHistory_(ss, buildMasterIndex_(all));
      const hu = history[subjectKey] && history[subjectKey].units[nameKey];
      const hours = hu ? (hu.maxHour || 0) : 0;
      if (hours <= 0) {
        return {
          success: false,
          error: 'この単元はまだ週案に入っていないため、終了にできません。'
            + '（総時数を変えたいときは「単元」タブで直してください）'
        };
      }

      const rowNumbers = [];
      let unitLabel = String(unitName).trim();
      let previousTotal = 0;
      for (let i = 1; i < all.length; i++) {
        if (!isSameSubject_(all[i][MASTER_COL_SUBJECT - 1], subject)) continue;
        if (normalizeUnitName_(all[i][MASTER_COL_UNIT_NAME - 1]) !== nameKey) continue;
        rowNumbers.push(i + 1);
        unitLabel = String(all[i][MASTER_COL_UNIT_NAME - 1]).trim();
        const declared = parseInt(all[i][MASTER_COL_TOTAL_HOURS - 1], 10);
        if (!isNaN(declared) && declared > previousTotal) previousTotal = declared;
      }
      if (rowNumbers.length === 0) {
        throw new Error('単元「' + unitName + '」が単元マスタに見つかりません。');
      }

      const alreadyClosed = rowNumbers.every(function (rn) {
        return parseInt(all[rn - 1][MASTER_COL_TOTAL_HOURS - 1], 10) === hours;
      });
      if (alreadyClosed) {
        return {
          success: true, changed: false, unitName: unitLabel,
          totalHours: hours, previousTotal: previousTotal,
          message: '「' + unitLabel + '」はすでに全' + hours + '時間になっています。'
        };
      }

      const snapshotId = p3CreateSnapshot_(
        'unitMaster',
        'sheet::' + SHEET_NAME_UNIT_MASTER,
        '自動: 単元を終了にする前',
        {
          schemaVersion: P3_SCHEMA_VERSION_,
          spreadsheetId: ss.getId(),
          scopeType: 'sheet',
          rowPages: p4PageRows_(all.slice(1))
        }
      );

      // 総時数の列だけを1回で書き戻す（他の単元の行は読んだ値をそのまま置く）
      const totals = all.slice(1).map(function (r) { return [r[MASTER_COL_TOTAL_HOURS - 1]]; });
      rowNumbers.forEach(function (rn) { totals[rn - 2] = [hours]; });
      sheet.getRange(2, MASTER_COL_TOTAL_HOURS, totals.length, 1).setValues(totals);

      p3RecordAudit_(
        'UNIT_MASTER_CLOSE',
        'unitMaster',
        SHEET_NAME_UNIT_MASTER,
        '「' + unitLabel + '」を全' + hours + '時間として終了',
        { totalHours: previousTotal, rowCount: rowNumbers.length },
        { totalHours: hours, snapshotId: snapshotId },
        'close_' + Utilities.getUuid()
      );
      invalidateUnitProgressCache_();

      return {
        success: true, changed: true, unitName: unitLabel,
        totalHours: hours, previousTotal: previousTotal, snapshotId: snapshotId,
        message: '「' + unitLabel + '」を全' + hours + '時間として終了にしました。'
      };
    });
  } catch (e) {
    logError('closeUnitAtTaughtHours', e);
    return { success: false, error: e.message };
  }
}
