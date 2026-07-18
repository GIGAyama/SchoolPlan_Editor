/**
 * @fileoverview 単元マスタを利用した週案の自動入力・進捗管理機能
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
 * データベースを検索し、指定された教科の最後の授業情報を返します(高速化対応版)
 */
function findLastLesson_(dbData, subject, weekStartDate) {
  const dbCols = getDbColumns();
  const searchEndDate = new Date(weekStartDate);
  searchEndDate.setDate(searchEndDate.getDate() - 1);

  // データベースの最終行から2行目に向かって逆順にループ
  for (let i = dbData.length - 1; i >= 1; i--) {
    const row = dbData[i];
    const rowDate = row[dbCols.DATE - 1];

    if (rowDate instanceof Date && rowDate <= searchEndDate) {
      // 6校時から1校時に向かって逆順に教科を検索（単元名は列マップから取得し、列順に依存しない）
      for (let n = 6; n >= 1; n--) {
        const pCol = dbCols['PERIOD' + n];
        const uCol = dbCols['UNIT' + n];
        if (!pCol || !uCol) continue;
        if (isSameSubject_(row[pCol - 1], subject)) {
          const parsed = parseUnitProgress_(row[uCol - 1]); // 単元名のセル
          if (parsed) return parsed;
        }
      }
    }
  }

  // 検索範囲内に該当する教科が見つからなかった場合
  return { unitName: null, currentHour: 0, totalHours: 0 };
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

/**
 * 特定の単元の最新進捗をDBから取得します。
 * @param {Array} dbData データベースの全行データ
 * @param {string} subject 教科名
 * @param {string} unitName 単元名
 * @param {Date} weekStartDate 対象週の月曜日
 * @returns {Object} {unitName, currentHour, totalHours}
 */
function findLatestUnitState_(dbData, subject, unitName, weekStartDate) {
  const dbCols = getDbColumns();
  const searchEndDate = new Date(weekStartDate);
  searchEndDate.setDate(searchEndDate.getDate() - 1);

  for (let i = dbData.length - 1; i >= 1; i--) {
    const row = dbData[i];
    const rowDate = row[dbCols.DATE - 1];
    if (!(rowDate instanceof Date) || rowDate > searchEndDate) continue;

    for (let n = 6; n >= 1; n--) {
      const pCol = dbCols['PERIOD' + n];
      const uCol = dbCols['UNIT' + n];
      if (!pCol || !uCol) continue;
      if (isSameSubject_(row[pCol - 1], subject)) {
        const parsed = parseUnitProgress_(row[uCol - 1]);
        if (parsed && parsed.unitName === unitName) {
          return { unitName: unitName, currentHour: parsed.currentHour, totalHours: parsed.totalHours };
        }
      }
    }
  }
  return { unitName: unitName, currentHour: 0, totalHours: 0 };
}

/**
 * 前回の授業情報と単元マスタを基に、次の授業情報を決定します。
 */
function determineNextLesson_(lastLesson, masterData, subject) {
  // Case 1: The previous lesson's unit is still in progress.
  if (lastLesson.unitName && lastLesson.currentHour < lastLesson.totalHours) {
    return {
      unitName: lastLesson.unitName,
      currentHour: lastLesson.currentHour + 1,
      totalHours: lastLesson.totalHours
    };
  }

  // Case 2: The previous lesson's unit is finished, or there is no history.
  let nextLessonRow;

  if (lastLesson.unitName) {
    const lastLessonIndex = masterData.findIndex(row =>
      isSameSubject_(row[MASTER_COL_SUBJECT - 1], subject) &&
      row[MASTER_COL_UNIT_NAME - 1] === lastLesson.unitName &&
      row[MASTER_COL_HOUR_NUM - 1] == lastLesson.currentHour
    );

    if (lastLessonIndex > -1 && lastLessonIndex + 1 < masterData.length) {
      const potentialNextRow = masterData[lastLessonIndex + 1];
      if (isSameSubject_(potentialNextRow[MASTER_COL_SUBJECT - 1], subject)) {
        nextLessonRow = potentialNextRow;
      }
    }
  }

  if (!nextLessonRow) {
    nextLessonRow = masterData.find(row => isSameSubject_(row[MASTER_COL_SUBJECT - 1], subject));
  }

  if (!nextLessonRow) {
    throw new Error(`単元マスタに教科「${subject}」のデータが見つかりません。`);
  }

  return {
    unitName: nextLessonRow[MASTER_COL_UNIT_NAME - 1],
    currentHour: parseInt(nextLessonRow[MASTER_COL_HOUR_NUM - 1], 10),
    totalHours: parseInt(nextLessonRow[MASTER_COL_TOTAL_HOURS - 1], 10)
  };
}

// ===================================================
// ===== Webアプリ用 API (Phase 4 Step 1) =====
// ===================================================

/**
 * [Webアプリ API] フロントエンドから送信された週案データ(days)を受け取り、
 * 単元マスタと過去のDB記録に基づいて「単元名」と「学習内容」を自動入力して返します。
 * @param {string} mondayStr "yyyy/MM/dd"
 * @param {Array} days フロントエンドで編集中の週データ配列
 * @returns {Object} { success: true, days: updatedDays }
 */
function calculateAutoFillForWebApp(mondayStr, days) {
  try {
    const ss = getSs_();
    const dbSheet = getDbSheet_(ss);
    const masterSheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
    if (!dbSheet || !masterSheet) throw new Error("必要なシートが見つかりません。");

    const dbData = dbSheet.getDataRange().getValues();
    const masterData = masterSheet.getDataRange().getValues();

    const weekStartDate = parseDate_(mondayStr);
    // 教科+単元名 単位で進捗を追跡（並行単元対応）
    const unitProgress = {}; // key: `${subject}::${unitName}` -> {unitName, currentHour, totalHours}

    days.forEach((day, dayIdx) => {
      if (!day.periods || !day.date || day.found === false) return;

      day.periods.forEach((p, pIdx) => {
        const subject = p.subject;
        if (!subject || subject.includes("行事")) return;
        // 進捗キーは正規化名で統一（「図工」と「図画工作」が混在しても同じ教科として進行）
        const subjectKey = normalizeSubjectName_(subject);

        try {
          // Step 1: スロット記憶方式 — 前週の同じ曜日・校時から使用単元を特定
          const slotLesson = findLastLessonForSlot_(dbData, subject, dayIdx, pIdx, weekStartDate);

          let lastLesson;
          if (slotLesson) {
            // このスロットに前週の単元がある → その単元の最新進捗を使う
            const progressKey = `${subjectKey}::${slotLesson.unitName}`;
            if (unitProgress[progressKey]) {
              lastLesson = unitProgress[progressKey];
            } else {
              lastLesson = findLatestUnitState_(dbData, subject, slotLesson.unitName, weekStartDate);
            }
          } else {
            // スロット履歴なし → 従来方式（教科の最終授業から逐次進行）でフォールバック
            lastLesson = findLastLesson_(dbData, subject, weekStartDate);
            // 既に他のスロットが追跡中の単元なら、その進捗を使う
            const fallbackKey = lastLesson.unitName ? `${subjectKey}::${lastLesson.unitName}` : null;
            if (fallbackKey && unitProgress[fallbackKey]) {
              lastLesson = unitProgress[fallbackKey];
            }
          }

          // Step 2: 単元マスタから次の時数を決定
          const nextLesson = determineNextLesson_(lastLesson, masterData, subject);

          if (nextLesson && nextLesson.unitName) {
            // 教科+単元名 単位で進捗を更新
            const progressKey = `${subjectKey}::${nextLesson.unitName}`;
            unitProgress[progressKey] = nextLesson;

            p.unit = `${nextLesson.unitName} ${nextLesson.currentHour}/${nextLesson.totalHours}`;
            p.content = findActivityFromMaster_(masterData, subject, nextLesson.unitName, nextLesson.currentHour);
          }
        } catch (e) {
          logError(`[AutoFill] ${day.date} ${pIdx+1}校時 ${subject} の処理エラー`, e);
        }
      });
    });

    return { success: true, days: days };
  } catch(e) {
    logError("calculateAutoFillForWebApp", e);
    return { success: false, error: e.message };
  }
}

// ===================================================
// ===== 一括自動入力（拡張Auto-Fill） =====
// ===================================================

/**
 * [Webアプリ API] 指定週の翌週以降のすべての週について、
 * 単元マスタに基づいて「単元名」と「学習内容」を一括で自動入力し直します。
 * 教科名（時間割）は変更しません。
 *
 * @param {string} baseMondayStr 基準となる週の月曜日 "yyyy/MM/dd"
 * @returns {Object} { success: boolean, message: string, updatedCells: number }
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

    // 教科+単元名 単位で進捗を追跡（並行単元対応）
    const unitProgress = {}; // key: `${subject}::${unitName}` -> {unitName, currentHour, totalHours}
    // スロット記憶: 各(曜日, 校時)がどの単元を使っているか
    const slotUnitMap = {}; // key: `${dayOfWeek}::${periodIndex}` -> unitName
    // 初期化済み教科の追跡
    const initializedSubjects = new Set();

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
        // 進捗キーは正規化名で統一（「図工」と「図画工作」が混在しても同じ教科として進行）
        const subjectKey = normalizeSubjectName_(subject);

        try {
          const slotKey = `${dayOfWeek}::${pc.idx}`;

          // Step 1: スロット記憶方式でこのスロットの単元を特定
          let lastLesson;
          const rememberedUnit = slotUnitMap[slotKey];

          if (rememberedUnit) {
            // このスロットに記憶された単元がある
            const progressKey = `${subjectKey}::${rememberedUnit}`;
            lastLesson = unitProgress[progressKey] || findLatestUnitState_(dbData, subject, rememberedUnit, nextMonday);
          } else if (!initializedSubjects.has(subjectKey)) {
            // 初遭遇の教科 — スロットベースの初期化を試みる
            const slotLesson = findLastLessonForSlot_(dbData, subject, dayOfWeek, pc.idx, nextMonday);
            if (slotLesson) {
              const progressKey = `${subjectKey}::${slotLesson.unitName}`;
              lastLesson = unitProgress[progressKey] || findLatestUnitState_(dbData, subject, slotLesson.unitName, nextMonday);
            } else {
              lastLesson = findLastLesson_(dbData, subject, nextMonday);
              const fallbackKey = lastLesson.unitName ? `${subjectKey}::${lastLesson.unitName}` : null;
              if (fallbackKey && unitProgress[fallbackKey]) {
                lastLesson = unitProgress[fallbackKey];
              }
            }
          } else {
            // 教科は初期化済みだがこのスロットは未設定 — フォールバック
            lastLesson = findLastLesson_(dbData, subject, nextMonday);
            const fallbackKey = lastLesson.unitName ? `${subjectKey}::${lastLesson.unitName}` : null;
            if (fallbackKey && unitProgress[fallbackKey]) {
              lastLesson = unitProgress[fallbackKey];
            }
          }

          initializedSubjects.add(subjectKey);

          // Step 2: 次の時数を決定
          const nextLesson = determineNextLesson_(lastLesson, masterData, subject);

          if (nextLesson && nextLesson.unitName) {
            const newUnit = nextLesson.unitName + ' ' + nextLesson.currentHour + '/' + nextLesson.totalHours;
            const newContent = findActivityFromMaster_(masterData, subject, nextLesson.unitName, nextLesson.currentHour);

            if (row[pc.unit - 1] !== newUnit || row[pc.content - 1] !== newContent) {
              row[pc.unit - 1] = newUnit;
              row[pc.content - 1] = newContent;
              isModified = true;
              updatedCells++;
            }

            // 進捗とスロット記憶を更新
            const progressKey = `${subjectKey}::${nextLesson.unitName}`;
            unitProgress[progressKey] = nextLesson;
            slotUnitMap[slotKey] = nextLesson.unitName;
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
      updatedCells: updatedCells
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
 * 単元マスタには依存せず、すでに入力されている値（文字列）をそのまま移動します。
 * これにより「授業が予定通り進まず、その教科の予定を1時間ずつ後ろにずらしたい」といった
 * 局所的な調整を、他教科に影響を与えずに一括で行えます。
 *
 * - 対象セルは「期間内」かつ「校時の教科名が subject と一致」するコマのみ。
 * - 値（単元名/学習内容）はペアで移動し、進捗番号（例: 2/5）は振り直さずそのまま移動します。
 * - 期間の端からあふれたコマ（移動先が期間外になる分）は切り捨てられ、件数を警告として返します。
 *
 * @param {string} subject 対象教科名（例: "国語"）
 * @param {string} startDateStr 開始日 "yyyy/MM/dd" または "yyyy-MM-dd"
 * @param {string} endDateStr 終了日 "yyyy/MM/dd" または "yyyy-MM-dd"
 * @param {string} direction 'back' = 後ろ（遅らせる） / 'forward' = 前（前倒し）
 * @param {number} count ずらすコマ数（省略時1）
 * @returns {Object} { success, message, shifted, discarded, direction }
 */
function shiftSubjectLessons(subject, startDateStr, endDateStr, direction, count) {
  const lock = LockService.getScriptLock();
  try {
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
    if (discarded > 0) {
      message += `（期間の端からあふれた${discarded}コマ分の入力は切り捨てられました）`;
    }

    return { success: true, shifted: n, discarded: discarded, direction: dir, message: message };
  } catch (e) {
    logError('shiftSubjectLessons', e);
    return { success: false, error: e.message };
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}
