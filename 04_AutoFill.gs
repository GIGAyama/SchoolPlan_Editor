/**
 * @fileoverview 単元マスタを利用した週案の自動入力・進捗管理機能
 */

/** 
 * 「単元マスタ」の中から、指定された教科・単元名・時間に対応する学習活動を探し出します。 
 */
function findActivityFromMaster_(masterData, subject, unitName, hourNum) {
  for (let i = 1; i < masterData.length; i++) {
    const row = masterData[i];
    if (row[MASTER_COL_SUBJECT - 1] === subject && row[MASTER_COL_UNIT_NAME - 1] === unitName && row[MASTER_COL_HOUR_NUM - 1] == hourNum) {
      return row[MASTER_COL_ACTIVITY - 1];
    }
  }
  if (unitName.includes("のまとめ")) return "単元の内容を振り返り、学習の定着を確認する。";
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
      // 6校時から1校時に向かって逆順に教科を検索
      for (let col = dbCols.PERIOD6 - 1; col >= dbCols.PERIOD1 - 1; col -= 3) {
        if (row[col] === subject) {
          const unitText = row[col + 1]; // 単元名のセル
          if (unitText && typeof unitText === 'string') {
            const match = unitText.match(/(.+?)\s*(\d+)\/(\d+)/);
            if (match) {
              return {
                unitName: match[1].trim(),
                currentHour: parseInt(match[2], 10),
                totalHours: parseInt(match[3], 10)
              };
            }
          }
        }
      }
    }
  }

  // 検索範囲内に該当する教科が見つからなかった場合
  return { unitName: null, currentHour: 0, totalHours: 0 };
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
      row[MASTER_COL_SUBJECT - 1] === subject &&
      row[MASTER_COL_UNIT_NAME - 1] === lastLesson.unitName &&
      row[MASTER_COL_HOUR_NUM - 1] == lastLesson.currentHour
    );

    if (lastLessonIndex > -1 && lastLessonIndex + 1 < masterData.length) {
      const potentialNextRow = masterData[lastLessonIndex + 1];
      if (potentialNextRow[MASTER_COL_SUBJECT - 1] === subject) {
        nextLessonRow = potentialNextRow;
      }
    }
  }
  
  if (!nextLessonRow) {
    nextLessonRow = masterData.find(row => row[MASTER_COL_SUBJECT - 1] === subject);
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
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    const masterSheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
    if (!dbSheet || !masterSheet) throw new Error("必要なシートが見つかりません。");

    const dbData = dbSheet.getDataRange().getValues();
    const masterData = masterSheet.getDataRange().getValues();

    const weekStartDate = parseDate_(mondayStr);
    let weeklyProgress = {}; // 1週間の中での教科ごとの進捗を追跡

    days.forEach((day, colIdx) => {
      if (!day.periods || !day.date || day.found === false) return;
      const currentDate = parseDate_(day.date);

      day.periods.forEach((p, pIdx) => {
        const subject = p.subject;
        if (!subject || subject.includes("行事")) return; // 教科が空、または行事の場合はスキップ

        try {
          // 前回までの進捗を取得（同じ週ですでに計算済みならそれを使う）
          const lastLesson = weeklyProgress[subject] || findLastLesson_(dbData, subject, weekStartDate);
          
          // 単元マスタから次の進捗を決定
          const nextLesson = determineNextLesson_(lastLesson, masterData, subject);
          
          if (nextLesson && nextLesson.unitName) {
            // 進捗を更新
            weeklyProgress[subject] = nextLesson;
            
            // 単元名と進捗（◯/◯）を構成
            p.unit = `${nextLesson.unitName} ${nextLesson.currentHour}/${nextLesson.totalHours}`;
            
            // 活動内容を探す
            p.content = findActivityFromMaster_(masterData, subject, nextLesson.unitName, nextLesson.currentHour);
          }
        } catch (e) {
          logError(`[AutoFill] ${formatDate(currentDate)} ${pIdx+1}校時 ${subject} の処理エラー`, e);
        }
      });
    });

    return { success: true, days: days };
  } catch(e) {
    logError("calculateAutoFillForWebApp", e);
    return { success: false, error: e.message };
  }
}
