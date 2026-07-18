/**
 * @fileoverview 単元マスタを利用した週案の自動入力・進捗管理機能
 *
 * 自動入力は「指導履歴（指導済みの単元・時数）」と「単元マスタ」を突き合わせる
 * スマートエンジン方式で動作します。
 *  - 指導済みの時数は再割り当てされません（次の未指導時数から継続）。
 *  - 単元マスタの設定時間数と実際の指導時数が食い違う場合は、大きい方を
 *    実効総時数として扱い、超過して指導した単元は指導済みとして次へ進みます。
 *  - 検出した不一致は warnings として呼び出し元に返します。
 */

/**
 * 単元セルのテキスト（例: "物語の世界 2/5"）から単元名と進捗（現在時数/総時数）を解析します。
 * @param {*} unitText 単元セルの値
 * @returns {{unitName: string, currentHour: number, totalHours: number}|null} 解析できなければ null
 */
function parseUnitProgress_(unitText) {
  if (!unitText || typeof unitText !== 'string') return null;
  const match = unitText.match(/(.+?)\s*(\d+)\/(\d+)/);
  if (!match) return null;
  return {
    unitName: match[1].trim(),
    currentHour: parseInt(match[2], 10),
    totalHours: parseInt(match[3], 10)
  };
}

/**
 * 「単元マスタ」の中から、指定された教科・単元名・時間に対応する学習活動を探し出します。
 */
function findActivityFromMaster_(masterData, subject, unitName, hourNum) {
  for (let i = 1; i < masterData.length; i++) {
    const row = masterData[i];
    if (isSameSubject_(row[MASTER_COL_SUBJECT - 1], subject) && row[MASTER_COL_UNIT_NAME - 1] === unitName && row[MASTER_COL_HOUR_NUM - 1] == hourNum) {
      return row[MASTER_COL_ACTIVITY - 1];
    }
  }
  if (unitName.includes("のまとめ")) return "めあて：単元の学習を振り返ろう\n・学習内容の要点を確認する\n・まとめテストやふり返りカードに取り組む";
  return "（単元マスタに該当する活動が見つかりませんでした）";
}

/**
 * 前週の同じ曜日・同じ校時スロットから、そのスロットが使っていた単元情報を取得します。
 * これにより、同一教科で複数単元を並行して進める運用に対応できます。
 * @param {Array} dbData データベースの全行データ
 * @param {string} subject 教科名
 * @param {number} dayOfWeek 曜日インデックス (0=月, 1=火, ..., 6=日)
 * @param {number} periodIndex 校時インデックス (0-5)
 * @param {Date} weekStartDate 対象週の月曜日
 * @returns {Object|null} {unitName, currentHour, totalHours} or null
 */
function findLastLessonForSlot_(dbData, subject, dayOfWeek, periodIndex, weekStartDate) {
  const dbCols = getDbColumns();
  const searchEndDate = new Date(weekStartDate);
  searchEndDate.setDate(searchEndDate.getDate() - 1);

  const fourWeeksAgo = new Date(weekStartDate);
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

  // 校時→DB列マッピング
  const periodKeys = ['PERIOD1', 'PERIOD2', 'PERIOD3', 'PERIOD4', 'PERIOD5', 'PERIOD6'];
  const unitKeys = ['UNIT1', 'UNIT2', 'UNIT3', 'UNIT4', 'UNIT5', 'UNIT6'];
  const pColIdx = dbCols[periodKeys[periodIndex]];
  const uColIdx = dbCols[unitKeys[periodIndex]];
  if (!pColIdx || !uColIdx) return null;

  for (let i = dbData.length - 1; i >= 1; i--) {
    const row = dbData[i];
    const rowDate = row[dbCols.DATE - 1];
    if (!(rowDate instanceof Date) || rowDate > searchEndDate) continue;
    if (rowDate < fourWeeksAgo) break;

    // 曜日チェック (JS: 0=日,1=月,...,6=土 → 0=月,...,6=日)
    const jsDow = rowDate.getDay();
    const ourDow = jsDow === 0 ? 6 : jsDow - 1;
    if (ourDow !== dayOfWeek) continue;

    // 同じスロットに同じ教科があるか（図工/図画工作などの表記ゆれも同一視）
    if (isSameSubject_(row[pColIdx - 1], subject)) {
      const parsed = parseUnitProgress_(row[uColIdx - 1]);
      if (parsed) return parsed;
    }
  }
  return null;
}

// ===================================================
// ===== スマート自動入力エンジン =====
// ===================================================

/**
 * 警告メッセージを重複なく追加します（最大30件）。
 */
function addWarning_(warnings, message) {
  if (!warnings) return;
  if (warnings.indexOf(message) === -1 && warnings.length < 30) warnings.push(message);
}

/**
 * 単元マスタを教科別にインデックス化します。
 * 総時数列の設定値と実際の時数行の数が食い違っていても、両方を保持して
 * 実効総時数（大きい方）の判断に使えるようにします。
 * @param {Array} masterData 単元マスタの全行データ
 * @returns {Object} subjectKey(正規化教科名) -> { units: [unit], byName: {unitName: unit} }
 *   unit = { name, declaredTotal, maxHourRow, activities: {hourNum: activity}, order }
 */
function buildMasterIndex_(masterData) {
  const subjects = {};
  for (let i = 1; i < masterData.length; i++) {
    const row = masterData[i];
    const subjectRaw = row[MASTER_COL_SUBJECT - 1];
    const unitName = row[MASTER_COL_UNIT_NAME - 1];
    if (!subjectRaw || !unitName) continue;

    const key = normalizeSubjectName_(subjectRaw);
    if (!subjects[key]) subjects[key] = { units: [], byName: {} };
    const s = subjects[key];

    let unit = s.byName[unitName];
    if (!unit) {
      unit = { name: unitName, declaredTotal: 0, maxHourRow: 0, activities: {}, order: s.units.length };
      s.byName[unitName] = unit;
      s.units.push(unit);
    }

    const declared = parseInt(row[MASTER_COL_TOTAL_HOURS - 1], 10);
    if (!isNaN(declared) && declared > unit.declaredTotal) unit.declaredTotal = declared;

    const hourNum = parseInt(row[MASTER_COL_HOUR_NUM - 1], 10);
    if (!isNaN(hourNum) && hourNum > 0) {
      if (hourNum > unit.maxHourRow) unit.maxHourRow = hourNum;
      if (row[MASTER_COL_ACTIVITY - 1] && !unit.activities[hourNum]) {
        unit.activities[hourNum] = row[MASTER_COL_ACTIVITY - 1];
      }
    }
  }
  return subjects;
}

/**
 * マスタインデックスから教科・単元名で単元情報を取得します（表記ゆれ吸収）。
 */
function getMasterUnit_(masterIndex, subject, unitName) {
  const s = masterIndex[normalizeSubjectName_(subject)];
  return (s && s.byName[unitName]) || null;
}

/**
 * DBの過去記録から「どの単元の何時間目まで指導済みか」を教科別に集計します。
 * @param {Array} dbData データベースの全行データ
 * @param {Object} dbCols 列マップ
 * @param {Date} beforeDate この日付より前（同日は含まない）の記録を指導済みとして集計
 * @returns {Object} subjectKey -> { units: {unitName: {maxHour, cellTotalMax, taught: {hour:true}}}, lastUnitName, lastTime }
 */
function buildTaughtHistory_(dbData, dbCols, beforeDate) {
  const history = {};
  const limit = beforeDate.getTime();

  for (let i = 1; i < dbData.length; i++) {
    const row = dbData[i];
    const rowDate = row[dbCols.DATE - 1];
    if (!(rowDate instanceof Date) || rowDate.getTime() >= limit) continue;

    for (let n = 1; n <= 6; n++) {
      const pCol = dbCols['PERIOD' + n];
      const uCol = dbCols['UNIT' + n];
      if (!pCol || !uCol) continue;
      const subject = row[pCol - 1];
      if (!subject || typeof subject !== 'string') continue;

      const parsed = parseUnitProgress_(row[uCol - 1]);
      if (!parsed) continue;

      const key = normalizeSubjectName_(subject);
      if (!history[key]) history[key] = { units: {}, lastUnitName: null, lastTime: 0 };
      const h = history[key];

      let u = h.units[parsed.unitName];
      if (!u) u = h.units[parsed.unitName] = { maxHour: 0, cellTotalMax: 0, taught: {} };
      u.taught[parsed.currentHour] = true;
      if (parsed.currentHour > u.maxHour) u.maxHour = parsed.currentHour;
      if (parsed.totalHours > u.cellTotalMax) u.cellTotalMax = parsed.totalHours;

      if (rowDate.getTime() >= h.lastTime) {
        h.lastTime = rowDate.getTime();
        h.lastUnitName = parsed.unitName;
      }
    }
  }
  return history;
}

/**
 * 進捗トラッカーを作成します。
 * 指導済み履歴（history）と、今回の処理中に割り当てた計画（planned）を合算して
 * 「次に指導すべき時数」「単元が消化済みか」を判断します。
 */
function createProgressTracker_(masterIndex, history) {
  const planned = {};        // subjectKey -> { unitName: { maxHour, hours: {h:true} } }
  const lastPlannedUnit = {}; // subjectKey -> unitName

  function historyUnit_(subjectKey, unitName) {
    const h = history[subjectKey];
    return (h && h.units[unitName]) || null;
  }
  function plannedUnit_(subjectKey, unitName) {
    const p = planned[subjectKey];
    return (p && p[unitName]) || null;
  }

  /**
   * 実効総時数: マスタ設定時数・マスタの時数行の最大・週案上で観測した総時数・
   * 実際に指導済みの最大時数のうち、最も大きいものを採用します。
   * これにより「設定時間数と実際の指導時数が合わない」場合も破綻せず継続できます。
   */
  function effectiveTotal(subjectKey, unitName, fallbackTotal) {
    const sm = masterIndex[subjectKey];
    const mu = sm ? sm.byName[unitName] : null;
    const hu = historyUnit_(subjectKey, unitName);
    let total = 0;
    if (mu) total = Math.max(mu.declaredTotal || 0, mu.maxHourRow || 0);
    if (hu) total = Math.max(total, hu.cellTotalMax || 0, hu.maxHour || 0);
    if (!total && fallbackTotal) total = fallbackTotal;
    return total;
  }

  function maxProgress(subjectKey, unitName) {
    const hu = historyUnit_(subjectKey, unitName);
    const pu = plannedUnit_(subjectKey, unitName);
    return Math.max(hu ? hu.maxHour : 0, pu ? pu.maxHour : 0);
  }

  function nextHour(subjectKey, unitName) {
    return maxProgress(subjectKey, unitName) + 1;
  }

  function isFinished(subjectKey, unitName, fallbackTotal) {
    const total = effectiveTotal(subjectKey, unitName, fallbackTotal);
    return total > 0 && maxProgress(subjectKey, unitName) >= total;
  }

  function markPlanned(subjectKey, unitName, hour) {
    if (!planned[subjectKey]) planned[subjectKey] = {};
    let pu = planned[subjectKey][unitName];
    if (!pu) pu = planned[subjectKey][unitName] = { maxHour: 0, hours: {} };
    pu.hours[hour] = true;
    if (hour > pu.maxHour) pu.maxHour = hour;
    lastPlannedUnit[subjectKey] = unitName;
  }

  /** 直近に扱った単元名（今回の計画 > 過去履歴 の優先順）を返します。 */
  function getLastUnit(subjectKey) {
    if (lastPlannedUnit[subjectKey]) return lastPlannedUnit[subjectKey];
    const h = history[subjectKey];
    return h ? h.lastUnitName : null;
  }

  return {
    effectiveTotal: effectiveTotal,
    maxProgress: maxProgress,
    nextHour: nextHour,
    isFinished: isFinished,
    markPlanned: markPlanned,
    getLastUnit: getLastUnit
  };
}

/**
 * 指導履歴と単元マスタの間の時数不一致を検出し、警告として追加します。
 */
function collectMismatchWarnings_(masterIndex, history, warnings) {
  Object.keys(history).forEach(function (subjectKey) {
    const h = history[subjectKey];
    const sm = masterIndex[subjectKey];
    if (!sm) return;
    Object.keys(h.units).forEach(function (unitName) {
      const hu = h.units[unitName];
      const mu = sm.byName[unitName];
      if (!mu) return;
      const masterTotal = Math.max(mu.declaredTotal || 0, mu.maxHourRow || 0);
      if (!masterTotal) return;
      if (hu.maxHour > masterTotal) {
        addWarning_(warnings, subjectKey + '「' + unitName + '」: 単元マスタの設定は全' + masterTotal + '時間ですが、' + hu.maxHour + '時間目まで指導済みです。指導済みの単元として扱い、次の単元へ進みます。');
      } else if (hu.cellTotalMax && hu.cellTotalMax !== masterTotal && hu.maxHour < Math.max(hu.cellTotalMax, masterTotal)) {
        addWarning_(warnings, subjectKey + '「' + unitName + '」: 週案上の総時数（' + hu.cellTotalMax + '時間）と単元マスタの設定（' + masterTotal + '時間）が一致しません。大きい方の' + Math.max(hu.cellTotalMax, masterTotal) + '時間として継続します。');
      }
    });
  });
}

/**
 * 次に指導すべき単元・時数を決定します。
 *  - 指導済みの時数はスキップし、次の未指導時数から継続します。
 *  - 基準単元が消化済みなら、単元マスタの並び順で次の未消化単元へ進みます
 *    （途中で指導済みの単元はスキップ）。
 *  - 全単元が指導済みの場合は null を返します（セルを上書きしません）。
 * @param {string} subject 教科名（表示用の生の名前）
 * @param {string|null} baseUnitName 基準単元名（スロット記憶や直近の単元）
 * @param {Object} masterIndex buildMasterIndex_ の結果
 * @param {Object} tracker createProgressTracker_ の結果
 * @param {Array|null} warnings 警告蓄積用配列
 * @returns {{unitName: string, currentHour: number, totalHours: number}|null}
 */
function determineNextLessonSmart_(subject, baseUnitName, masterIndex, tracker, warnings) {
  const subjectKey = normalizeSubjectName_(subject);
  const subjectMaster = masterIndex[subjectKey];

  // Step 1: 基準単元が未消化ならそのまま継続
  if (baseUnitName && !tracker.isFinished(subjectKey, baseUnitName)) {
    const total = tracker.effectiveTotal(subjectKey, baseUnitName);
    if (total > 0) {
      const hour = tracker.nextHour(subjectKey, baseUnitName);
      return { unitName: baseUnitName, currentHour: hour, totalHours: Math.max(total, hour) };
    }
  }

  if (!subjectMaster || subjectMaster.units.length === 0) {
    addWarning_(warnings, '単元マスタに教科「' + subject + '」のデータが見つからないため、自動入力をスキップしました。');
    return null;
  }

  // Step 2: 基準単元の次の位置から未消化の単元を探す（末尾に達したら先頭に戻って探索）
  let startOrder = 0;
  if (baseUnitName && subjectMaster.byName[baseUnitName]) {
    startOrder = subjectMaster.byName[baseUnitName].order + 1;
  }
  const unitCount = subjectMaster.units.length;
  for (let i = 0; i < unitCount; i++) {
    const unit = subjectMaster.units[(startOrder + i) % unitCount];
    if (tracker.isFinished(subjectKey, unit.name)) continue;

    const effTotal = tracker.effectiveTotal(subjectKey, unit.name);
    const hour = tracker.nextHour(subjectKey, unit.name);
    if (hour > 1) {
      addWarning_(warnings, subject + '「' + unit.name + '」は' + (hour - 1) + '時間目まで指導済みのため、' + hour + '時間目から続けて入力します。');
    }
    return { unitName: unit.name, currentHour: hour, totalHours: Math.max(effTotal, hour) };
  }

  addWarning_(warnings, '教科「' + subject + '」は単元マスタ上のすべての単元が指導済みのため、自動入力をスキップしました。');
  return null;
}

/**
 * 学習活動をマスタインデックスから取得します。
 * 実際の指導時数がマスタの時数行を超えた場合は、直近の時数の活動を代用して
 * 「活動が見つからない」状態を避けます。
 */
function findActivitySmart_(masterIndex, subject, unitName, hourNum) {
  const mu = getMasterUnit_(masterIndex, subject, unitName);
  if (mu) {
    if (mu.activities[hourNum]) return mu.activities[hourNum];
    for (let h = hourNum - 1; h >= 1; h--) {
      if (mu.activities[h]) {
        return mu.activities[h] + '\n※単元マスタに' + hourNum + '時間目の活動がないため、' + h + '時間目の活動を表示しています。';
      }
    }
  }
  if (unitName && String(unitName).includes('のまとめ')) {
    return "めあて：単元の学習を振り返ろう\n・学習内容の要点を確認する\n・まとめテストやふり返りカードに取り組む";
  }
  return "（単元マスタに該当する活動が見つかりませんでした）";
}

// ===================================================
// ===== Webアプリ用 API =====
// ===================================================

/**
 * [Webアプリ API] フロントエンドから送信された週案データ(days)を受け取り、
 * 単元マスタと指導履歴に基づいて「単元名」と「学習内容」を自動入力して返します。
 * @param {string} mondayStr "yyyy/MM/dd"
 * @param {Array} days フロントエンドで編集中の週データ配列
 * @param {Object} [options] { fillMode: 'all'|'empty', useAI: boolean }
 *   fillMode 'empty': 入力済みのコマは変更せず、空欄のコマだけを入力します。
 *   useAI: Gemini による配置最適化を行います（結果はルール検証され、不正な提案は破棄）。
 * @returns {Object} { success, days, warnings, aiApplied }
 */
function calculateAutoFillForWebApp(mondayStr, days, options) {
  try {
    options = options || {};
    const fillMode = (options.fillMode === 'empty') ? 'empty' : 'all';

    const ss = getSs_();
    const dbSheet = getDbSheet_(ss);
    const masterSheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
    if (!dbSheet || !masterSheet) throw new Error("必要なシートが見つかりません。");

    const dbData = dbSheet.getDataRange().getValues();
    const masterData = masterSheet.getDataRange().getValues();
    const dbCols = getDbColumns();
    const weekStartDate = parseDate_(mondayStr);

    const masterIndex = buildMasterIndex_(masterData);
    const history = buildTaughtHistory_(dbData, dbCols, weekStartDate);
    const tracker = createProgressTracker_(masterIndex, history);
    const warnings = [];
    collectMismatchWarnings_(masterIndex, history, warnings);

    // 「空欄のみ」モード: 手入力済みセルの進捗を先に登録し、重複割り当てを防ぐ
    const presetMarks = [];
    if (fillMode === 'empty') {
      days.forEach(function (day) {
        if (!day || !day.periods || day.found === false) return;
        day.periods.forEach(function (p) {
          if (!p || !p.subject || String(p.subject).includes('行事')) return;
          if (!String(p.unit || '').trim() && !String(p.content || '').trim()) return;
          const parsed = parseUnitProgress_(p.unit);
          if (parsed) {
            const key = normalizeSubjectName_(p.subject);
            tracker.markPlanned(key, parsed.unitName, parsed.currentHour);
            presetMarks.push({ subjectKey: key, unitName: parsed.unitName, hour: parsed.currentHour });
          }
        });
      });
    }

    const slotPlans = []; // AI最適化用に、割り当てたコマを時系列順で記録

    days.forEach(function (day, dayIdx) {
      if (!day.periods || !day.date || day.found === false) return;

      day.periods.forEach(function (p, pIdx) {
        const subject = p.subject;
        if (!subject || subject.includes("行事")) return;
        if (fillMode === 'empty' && (String(p.unit || '').trim() || String(p.content || '').trim())) return;

        const subjectKey = normalizeSubjectName_(subject);
        try {
          // 基準単元: 前週の同じ曜日・校時のスロット記憶 → なければ直近に扱った単元
          const slotLesson = findLastLessonForSlot_(dbData, subject, dayIdx, pIdx, weekStartDate);
          const baseUnitName = slotLesson ? slotLesson.unitName : tracker.getLastUnit(subjectKey);

          const nextLesson = determineNextLessonSmart_(subject, baseUnitName, masterIndex, tracker, warnings);
          if (nextLesson) {
            tracker.markPlanned(subjectKey, nextLesson.unitName, nextLesson.currentHour);
            p.unit = nextLesson.unitName + ' ' + nextLesson.currentHour + '/' + nextLesson.totalHours;
            p.content = findActivitySmart_(masterIndex, subject, nextLesson.unitName, nextLesson.currentHour);
            slotPlans.push({
              dayIdx: dayIdx, pIdx: pIdx, subject: subject, subjectKey: subjectKey,
              unitName: nextLesson.unitName, hour: nextLesson.currentHour, total: nextLesson.totalHours
            });
          }
        } catch (e) {
          logError('[AutoFill] ' + day.date + ' ' + (pIdx + 1) + '校時 ' + subject + ' の処理エラー', e);
        }
      });
    });

    let aiApplied = 0;
    if (options.useAI && slotPlans.length > 0) {
      try {
        aiApplied = applyAiOptimization_(days, slotPlans, presetMarks, masterIndex, history, warnings);
      } catch (e) {
        logError('calculateAutoFillForWebApp AI最適化', e);
        addWarning_(warnings, 'AIによる最適化に失敗したため、単元マスタによる標準の割り当てを使用しました。（' + e.message + '）');
      }
    }

    return { success: true, days: days, warnings: warnings, aiApplied: aiApplied };
  } catch(e) {
    logError("calculateAutoFillForWebApp", e);
    return { success: false, error: e.message };
  }
}

// ===================================================
// ===== AIによる配置最適化 =====
// ===================================================

/**
 * ルールベースで割り当てた週の計画を Gemini に渡し、行事や単元の区切りを考慮した
 * 配置調整の提案を受け取って適用します。
 * 提案は教科ごとに厳格に検証し（指導済み時数の再割り当て・時数の飛び・マスタにない
 * 単元はすべて不可）、1つでも不正があればその教科はルールベースの結果を維持します。
 * @returns {number} AIの提案で変更されたコマ数
 */
function applyAiOptimization_(days, slotPlans, presetMarks, masterIndex, history, warnings) {
  slotPlans.forEach(function (sp, idx) { sp.slotId = idx; });

  // 残り単元サマリ用トラッカー（手入力済みの進捗も反映）
  const summaryTracker = createProgressTracker_(masterIndex, history);
  presetMarks.forEach(function (m) { summaryTracker.markPlanned(m.subjectKey, m.unitName, m.hour); });

  const subjectKeys = [];
  slotPlans.forEach(function (sp) {
    if (subjectKeys.indexOf(sp.subjectKey) === -1) subjectKeys.push(sp.subjectKey);
  });

  const slotLines = slotPlans.map(function (sp) {
    const day = days[sp.dayIdx];
    return '- slotId:' + sp.slotId + ' ' + day.date + (day.dayLabel ? '(' + day.dayLabel + ')' : '') + ' ' +
      (sp.pIdx + 1) + '校時 教科:' + sp.subject + ' 現在案:' + sp.unitName + ' ' + sp.hour + '/' + sp.total;
  }).join('\n');

  const remainLines = subjectKeys.map(function (key) {
    const sm = masterIndex[key];
    if (!sm) return '';
    const lines = sm.units.map(function (u) {
      if (summaryTracker.isFinished(key, u.name)) return null;
      const total = summaryTracker.effectiveTotal(key, u.name);
      const next = summaryTracker.nextHour(key, u.name);
      return '  - 「' + u.name + '」次に指導するのは' + next + '時間目（全' + (total || '?') + '時間）';
    }).filter(function (x) { return x; });
    return '■ 教科「' + key + '」の未指導単元（年間指導計画の順）:\n' + (lines.length ? lines.join('\n') : '  （残りなし）');
  }).filter(function (x) { return x; }).join('\n');

  const eventLines = days.filter(function (d) { return d && d.event; })
    .map(function (d) { return '- ' + d.date + ': ' + String(d.event).substring(0, 100); })
    .join('\n');

  const prompt = 'あなたは小学校の週案（週の指導計画）作成を支援するAIです。\n' +
    '機械的に計算した今週の単元割り当て案を確認し、必要な場合のみ、より適切な割り当てに調整してください。\n\n' +
    '【厳守するルール】\n' +
    '1. 各教科について、コマを日付・校時の順に並べたとき、同じ単元の時数は「次に指導するのは○時間目」から1ずつ連続して進めること（飛ばし・重複・逆順は不可）。\n' +
    '2. 指導済みの時数や、【未指導単元リスト】にない単元は割り当てないこと。\n' +
    '3. 単元名は【未指導単元リスト】の表記をそのまま使うこと。\n' +
    '4. 判断に迷う場合は現在案をそのまま維持すること。\n' +
    '5. すべてのslotIdについて1件ずつ出力すること（変更しないコマも現在案のまま出力）。\n\n' +
    '【調整の観点】\n' +
    '- 単元の区切り（最終時数）が行事や週の切れ目と揃うと望ましい。\n' +
    '- 同一教科で複数の単元を並行する場合は、曜日ごとに単元を固定すると時間割が安定する。\n\n' +
    '【今週のコマ一覧】\n' + slotLines + '\n\n' +
    '【未指導単元リスト】\n' + remainLines + '\n' +
    (eventLines ? '\n【今週の行事】\n' + eventLines + '\n' : '');

  const suggestions = callGeminiUnitAllocation_(prompt);
  if (!Array.isArray(suggestions) || suggestions.length === 0) return 0;

  const bySlotId = {};
  suggestions.forEach(function (s) {
    if (s && s.slotId !== undefined && s.slotId !== null) {
      const id = parseInt(s.slotId, 10);
      if (!isNaN(id)) bySlotId[id] = s;
    }
  });

  let applied = 0;
  subjectKeys.forEach(function (key) {
    const plans = slotPlans.filter(function (sp) { return sp.subjectKey === key; });

    // 教科ごとに提案をシミュレーション検証（1つでも不正ならその教科は現状維持）
    const sim = createProgressTracker_(masterIndex, history);
    presetMarks.forEach(function (m) { if (m.subjectKey === key) sim.markPlanned(m.subjectKey, m.unitName, m.hour); });

    const newPlans = [];
    let valid = true;
    for (let i = 0; i < plans.length; i++) {
      const sp = plans[i];
      const sug = bySlotId[sp.slotId];
      if (!sug || !sug.unitName || !sug.hour) { valid = false; break; }

      const unitName = String(sug.unitName).trim();
      const hour = parseInt(sug.hour, 10);
      const sm = masterIndex[key];
      if (!sm || !sm.byName[unitName] || isNaN(hour)) { valid = false; break; }
      if (sim.isFinished(key, unitName) || hour !== sim.nextHour(key, unitName)) { valid = false; break; }

      const total = Math.max(sim.effectiveTotal(key, unitName), hour);
      sim.markPlanned(key, unitName, hour);
      newPlans.push({ sp: sp, unitName: unitName, hour: hour, total: total });
    }
    if (!valid || newPlans.length !== plans.length) return;

    newPlans.forEach(function (np) {
      const p = days[np.sp.dayIdx].periods[np.sp.pIdx];
      const newUnit = np.unitName + ' ' + np.hour + '/' + np.total;
      if (p.unit !== newUnit) {
        p.unit = newUnit;
        p.content = findActivitySmart_(masterIndex, np.sp.subject, np.unitName, np.hour);
        applied++;
      }
    });
  });

  return applied;
}

/**
 * Gemini に単元割り当ての最適化を依頼し、JSON配列を取得します。
 * @param {string} prompt
 * @returns {Array<{slotId: number, unitName: string, hour: number}>}
 */
function callGeminiUnitAllocation_(prompt) {
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
      responseSchema: {
        type: "ARRAY",
        description: "全コマの単元割り当て",
        items: {
          type: "OBJECT",
          properties: {
            slotId: { type: "NUMBER", description: "コマ一覧のslotId" },
            unitName: { type: "STRING", description: "割り当てる単元名（未指導単元リストの表記そのまま）" },
            hour: { type: "NUMBER", description: "その単元の何時間目か" }
          },
          required: ["slotId", "unitName", "hour"]
        }
      }
    }
  };

  const json = callGeminiEndpoint_(payload, 'Gemini AutoFill Error');
  if (json.candidates && json.candidates.length > 0) {
    const text = json.candidates[0].content.parts[0].text;
    try {
      return JSON.parse(text);
    } catch (e) {
      const repaired = repairTruncatedJsonArray_(text);
      if (repaired !== null) return repaired;
      throw new Error('AIの出力をJSONとして解析できませんでした。');
    }
  }
  return [];
}

// ===================================================
// ===== 一括自動入力（拡張Auto-Fill） =====
// ===================================================

/**
 * [Webアプリ API] 指定週の翌週以降のすべての週について、
 * 単元マスタと指導履歴に基づいて「単元名」と「学習内容」を一括で自動入力し直します。
 * 教科名（時間割）は変更しません。指導済みの単元・時数は再割り当てされず、
 * 全単元を消化済みの教科はスキップされます。
 *
 * @param {string} baseMondayStr 基準となる週の月曜日 "yyyy/MM/dd"
 * @returns {Object} { success, message, updatedCells, warnings }
 */
function batchAutoFillFromWeek(baseMondayStr) {
  try {
    const ss = getSs_();
    const dbSheet = getDbSheet_(ss);
    const masterSheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
    if (!dbSheet || !masterSheet) throw new Error("必要なシートが見つかりません。");

    const dbData = dbSheet.getDataRange().getValues();
    const masterData = masterSheet.getDataRange().getValues();
    const dbCols = getDbColumns();

    // 基準週の翌週月曜を計算
    const baseMonday = parseDate_(baseMondayStr);
    const nextMonday = new Date(baseMonday);
    nextMonday.setDate(nextMonday.getDate() + 7);

    const masterIndex = buildMasterIndex_(masterData);
    const history = buildTaughtHistory_(dbData, dbCols, nextMonday);
    const tracker = createProgressTracker_(masterIndex, history);
    const warnings = [];
    collectMismatchWarnings_(masterIndex, history, warnings);

    // スロット記憶: 各(曜日, 校時, 教科)がどの単元を使っているか
    const slotUnitMap = {};

    // DB列マッピング（6校時分）。校時/単元/学習内容の3列が揃っているものだけを対象にする。
    const periodCols = [];
    for (let n = 1; n <= 6; n++) {
      const subj = dbCols['PERIOD' + n], unit = dbCols['UNIT' + n], content = dbCols['CONTENT' + n];
      if (subj && unit && content) {
        periodCols.push({ subj: subj, unit: unit, content: content, idx: n - 1 });
      }
    }

    let updatedCells = 0;
    let isModified = false;

    // 翌週月曜以降の全DB行を前方走査
    for (let i = 1; i < dbData.length; i++) {
      const row = dbData[i];
      const rowDate = row[dbCols.DATE - 1];

      if (!(rowDate instanceof Date) || rowDate < nextMonday) continue;

      // 曜日を算出 (0=月, ..., 6=日)
      const jsDow = rowDate.getDay();
      const dayOfWeek = jsDow === 0 ? 6 : jsDow - 1;

      for (const pc of periodCols) {
        const subject = row[pc.subj - 1];
        if (!subject || typeof subject !== 'string' || subject.includes('行事')) continue;
        const subjectKey = normalizeSubjectName_(subject);

        try {
          const slotKey = dayOfWeek + '::' + pc.idx + '::' + subjectKey;

          // 基準単元: スロット記憶 → 前週までの同スロット履歴 → 直近に扱った単元
          let baseUnitName;
          if (Object.prototype.hasOwnProperty.call(slotUnitMap, slotKey)) {
            baseUnitName = slotUnitMap[slotKey];
          } else {
            const slotLesson = findLastLessonForSlot_(dbData, subject, dayOfWeek, pc.idx, nextMonday);
            baseUnitName = slotLesson ? slotLesson.unitName : tracker.getLastUnit(subjectKey);
          }

          const nextLesson = determineNextLessonSmart_(subject, baseUnitName, masterIndex, tracker, warnings);
          if (!nextLesson) continue; // 全単元指導済み等 → セルは変更しない

          tracker.markPlanned(subjectKey, nextLesson.unitName, nextLesson.currentHour);
          slotUnitMap[slotKey] = nextLesson.unitName;

          const newUnit = nextLesson.unitName + ' ' + nextLesson.currentHour + '/' + nextLesson.totalHours;
          const newContent = findActivitySmart_(masterIndex, subject, nextLesson.unitName, nextLesson.currentHour);

          if (row[pc.unit - 1] !== newUnit || row[pc.content - 1] !== newContent) {
            row[pc.unit - 1] = newUnit;
            row[pc.content - 1] = newContent;
            isModified = true;
            updatedCells++;
          }
        } catch (e) {
          Logger.log('[batchAutoFill] ' + formatDate(rowDate) + ' ' + subject + ': ' + e.message);
        }
      }
    }

    // 変更があればDB一括書き戻し
    if (isModified) {
      dbSheet.getRange(1, 1, dbData.length, dbData[0].length).setValues(dbData);
    }

    return {
      success: true,
      message: updatedCells + 'コマの単元・学習内容を更新しました',
      updatedCells: updatedCells,
      warnings: warnings
    };
  } catch (e) {
    logError('batchAutoFillFromWeek', e);
    return { success: false, error: e.message };
  }
}

// ===================================================
// ===== 教科単位の単元シフト（前後ずらし） =====
// ===================================================

/**
 * [Webアプリ API] 指定した「教科」の、指定した「期間（開始日〜終了日）」内のコマだけを対象に、
 * 入力済みの「単元名」「学習内容」をまとめて前後にずらします。
 *
 * これにより「授業が予定通り進まず、その教科の予定を1時間ずつ後ろにずらしたい」といった
 * 局所的な調整を、他教科に影響を与えずに一括で行えます。
 *
 * - 対象セルは「期間内」かつ「校時の教科名が subject と一致」するコマのみ。
 * - 値（単元名/学習内容）はペアで移動します。
 * - options.renumber を指定すると、移動後に進捗番号（例: 2/5）を期間開始日までの
 *   指導履歴と単元マスタに合わせて振り直し、学習内容もマスタから再取得します。
 *   （時数の重複・飛びを自動で解消できます）
 * - 期間の端からあふれたコマ（移動先が期間外になる分）は切り捨てられ、件数を警告として返します。
 *
 * @param {string} subject 対象教科名（例: "国語"）
 * @param {string} startDateStr 開始日 "yyyy/MM/dd" または "yyyy-MM-dd"
 * @param {string} endDateStr 終了日 "yyyy/MM/dd" または "yyyy-MM-dd"
 * @param {string} direction 'back' = 後ろ（遅らせる） / 'forward' = 前（前倒し）
 * @param {number} count ずらすコマ数（省略時1）
 * @param {Object} [options] { renumber: boolean }
 * @returns {Object} { success, message, shifted, discarded, direction, renumbered }
 */
function shiftSubjectLessons(subject, startDateStr, endDateStr, direction, count, options) {
  const lock = LockService.getScriptLock();
  try {
    options = options || {};
    if (!subject || typeof subject !== 'string' || !subject.trim()) {
      throw new Error('教科名が指定されていません。');
    }
    subject = subject.trim();

    const dir = (direction === 'forward') ? 'forward' : 'back';
    let shiftCount = parseInt(count, 10);
    if (!shiftCount || shiftCount < 1) shiftCount = 1;

    const startDate = parseDate_(startDateStr);
    const endDate = parseDate_(endDateStr);
    if (!(startDate instanceof Date) || isNaN(startDate.getTime())) throw new Error('開始日の形式が不正です。');
    if (!(endDate instanceof Date) || isNaN(endDate.getTime())) throw new Error('終了日の形式が不正です。');
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);
    if (startDate.getTime() > endDate.getTime()) throw new Error('開始日が終了日より後になっています。');

    if (!lock.tryLock(15000)) {
      throw new Error('他の処理が実行中のため、しばらくしてから再度お試しください。');
    }

    const ss = getSs_();
    const dbSheet = getDbSheet_(ss);
    if (!dbSheet) throw new Error('必要なシートが見つかりません。');

    const dbData = dbSheet.getDataRange().getValues();
    const dbCols = getDbColumns();

    // 校時/単元/学習内容の3列が揃っているものだけを対象にする
    const periodCols = [];
    for (let n = 1; n <= 6; n++) {
      const subj = dbCols['PERIOD' + n], unit = dbCols['UNIT' + n], content = dbCols['CONTENT' + n];
      if (subj && unit && content) {
        periodCols.push({ subj: subj - 1, unit: unit - 1, content: content - 1 });
      }
    }

    // 対象セルを時系列順（行＝日付昇順 → 校時昇順）に収集
    const refs = [];
    for (let i = 1; i < dbData.length; i++) {
      const row = dbData[i];
      const rowDate = row[dbCols.DATE - 1];
      if (!(rowDate instanceof Date)) continue;
      const t = rowDate.getTime();
      if (t < startDate.getTime() || t > endDate.getTime()) continue;

      for (const pc of periodCols) {
        // 「図工」と「図画工作」のような表記ゆれも同一教科としてシフト対象にする
        if (isSameSubject_(row[pc.subj], subject)) {
          refs.push({
            rowIdx: i,
            uIdx: pc.unit,
            cIdx: pc.content,
            unit: row[pc.unit],
            content: row[pc.content]
          });
        }
      }
    }

    const n = refs.length;
    if (n === 0) {
      return { success: true, shifted: 0, discarded: 0, direction: dir,
               message: `指定期間内に「${subject}」のコマが見つかりませんでした。` };
    }

    const oldVals = refs.map(r => ({ unit: r.unit, content: r.content }));
    const blank = { unit: '', content: '' };
    const isFilled = v => (v && ((String(v.unit || '').trim() !== '') || (String(v.content || '').trim() !== '')));

    const newVals = new Array(n);
    let discarded = 0;
    if (dir === 'back') {
      // 後ろ（遅らせる）: 各コマを後方へ。先頭側が空く。末尾からあふれた分を切り捨て。
      for (let i = 0; i < n; i++) {
        newVals[i] = (i - shiftCount >= 0) ? oldVals[i - shiftCount] : blank;
      }
      for (let i = Math.max(0, n - shiftCount); i < n; i++) {
        if (isFilled(oldVals[i])) discarded++;
      }
    } else {
      // 前（前倒し）: 各コマを前方へ。末尾側が空く。先頭からあふれた分を切り捨て。
      for (let i = 0; i < n; i++) {
        newVals[i] = (i + shiftCount < n) ? oldVals[i + shiftCount] : blank;
      }
      for (let i = 0; i < Math.min(n, shiftCount); i++) {
        if (isFilled(oldVals[i])) discarded++;
      }
    }

    // 進捗番号の振り直し: 期間開始日までの指導履歴を起点に、移動後のコマを
    // 時系列順に連番へ振り直す。総時数は単元マスタとの実効値で更新し、
    // 学習内容もマスタに該当時数の活動があれば差し替える。
    let renumbered = false;
    if (options.renumber) {
      const masterSheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
      const masterIndex = masterSheet ? buildMasterIndex_(masterSheet.getDataRange().getValues()) : {};
      const history = buildTaughtHistory_(dbData, dbCols, startDate);
      const tracker = createProgressTracker_(masterIndex, history);
      const subjectKey = normalizeSubjectName_(subject);

      for (let i = 0; i < n; i++) {
        const v = newVals[i];
        if (!v) continue;
        const parsed = parseUnitProgress_(v.unit);
        if (!parsed) continue;

        const hour = tracker.nextHour(subjectKey, parsed.unitName);
        const total = tracker.effectiveTotal(subjectKey, parsed.unitName, parsed.totalHours);
        tracker.markPlanned(subjectKey, parsed.unitName, hour);

        const dispTotal = Math.max(total || parsed.totalHours || hour, hour);
        const mu = getMasterUnit_(masterIndex, subject, parsed.unitName);
        const newContent = (mu && mu.activities[hour]) ? mu.activities[hour] : v.content;

        if (v.unit !== (parsed.unitName + ' ' + hour + '/' + dispTotal) || v.content !== newContent) {
          renumbered = true;
        }
        newVals[i] = { unit: parsed.unitName + ' ' + hour + '/' + dispTotal, content: newContent };
      }
    }

    // DBへ反映
    let changed = false;
    for (let i = 0; i < n; i++) {
      const r = refs[i];
      const nv = newVals[i];
      if (dbData[r.rowIdx][r.uIdx] !== nv.unit) { dbData[r.rowIdx][r.uIdx] = nv.unit; changed = true; }
      if (dbData[r.rowIdx][r.cIdx] !== nv.content) { dbData[r.rowIdx][r.cIdx] = nv.content; changed = true; }
    }

    if (changed) {
      dbSheet.getRange(1, 1, dbData.length, dbData[0].length).setValues(dbData);
      SpreadsheetApp.flush();
    }

    const dirLabel = (dir === 'back') ? '後ろ' : '前';
    let message = `「${subject}」の${n}コマを${shiftCount}コマ分${dirLabel}にずらしました。`;
    if (renumbered) {
      message += '進捗番号と学習内容を指導履歴・単元マスタに合わせて再計算しました。';
    }
    if (discarded > 0) {
      message += `（期間の端からあふれた${discarded}コマ分の入力は切り捨てられました）`;
    }

    return { success: true, shifted: n, discarded: discarded, direction: dir, renumbered: renumbered, message: message };
  } catch (e) {
    logError('shiftSubjectLessons', e);
    return { success: false, error: e.message };
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}
