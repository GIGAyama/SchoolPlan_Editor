/**
 * @fileoverview 日次振り返り（日報）と週まとめ（管理職報告）機能
 *
 * データベースシートの以下の列を利用します。
 *  - 「振り返り」（例: AA列）: その日の教育活動に対する成果・課題・予定との変更点のテキスト。
 *      ※週まとめは、同一週番号の「日曜日」の行のこのセルに保存します。
 *  - 「振り返り状態」: ""(未記入) / "保留"(あとで書く) / "完了"。無ければ末尾に自動追加します。
 *
 * その週の授業がある全ての日の振り返りが「完了」になったタイミングで、
 * Gemini により週の報告文を自動生成し、その週の日曜日の振り返りセルへ保存します。
 */

// --- 振り返り状態の定数 ---
const REFLECTION_STATUS_DONE = '完了';
const REFLECTION_STATUS_HOLD = '保留';

// 日曜日に授業があった週で、日次振り返りと週まとめを同一セルに共存させるための見出しマーカー
const WEEK_SUMMARY_MARKER = '【週まとめ】';

/**
 * データベースシートに振り返り関連の列（振り返り・振り返り状態）が
 * 存在することを保証します。無ければ末尾に追加し、列キャッシュをクリアします。
 * @returns {Object} 最新の列マップ（getDbColumns() と同形式）
 */
function ensureReflectionColumns_() {
  let cols = getDbColumns();
  if (cols.REFLECTION && cols.REFLECTION_STATUS) return cols;

  const ss = getSs_();
  const sheet = ss.getSheetByName(SHEET_NAME_DATABASE);
  if (!sheet) throw new Error(`シート「${SHEET_NAME_DATABASE}」が見つかりません。`);

  const headersToAdd = [];
  if (!cols.REFLECTION) headersToAdd.push('振り返り');
  if (!cols.REFLECTION_STATUS) headersToAdd.push('振り返り状態');

  if (headersToAdd.length > 0) {
    const startCol = sheet.getLastColumn() + 1;
    sheet.getRange(1, startCol, 1, headersToAdd.length).setValues([headersToAdd]);
    clearDbColumnsCache();
    logInfo('データベースに振り返り用の列を追加しました: ' + headersToAdd.join('・'));
  }
  return getDbColumns();
}

/**
 * DB行に授業（1〜6校時のいずれか）が入力されているかを判定します。
 * @param {Array} row データベースの1行分
 * @param {Object} cols 列マップ
 * @returns {boolean}
 */
function rowHasLessons_(row, cols) {
  for (let n = 1; n <= 6; n++) {
    const c = cols['PERIOD' + n];
    if (c && String(row[c - 1] || '').trim() !== '') return true;
  }
  return false;
}

/**
 * 指定日のDB行インデックス（dbData内の0始まり）を返します。見つからなければ -1。
 */
function findDbRowIndexByDateStr_(dbData, cols, dateStr) {
  for (let i = 1; i < dbData.length; i++) {
    const d = dbData[i][cols.DATE - 1];
    if (d instanceof Date && formatDate(d) === dateStr) return i;
  }
  return -1;
}

/**
 * 指定週（月曜起点）と同一週番号の「日曜日」の行インデックスを返します。
 * 週まとめの保存先セル（日曜日の振り返り列）の特定に使用します。
 * 週番号＋曜日で照合し、見つからない場合は日付（月曜+6日）で照合します。
 * @returns {number} dbData内の0始まりインデックス。見つからなければ -1。
 */
function findSundayRowIndexByWeek_(dbData, cols, mondayStr) {
  const mondayIdx = findDbRowIndexByDateStr_(dbData, cols, mondayStr);

  // 週番号 + 曜日「日」で照合
  if (mondayIdx !== -1 && cols.WEEK_NUM && cols.DAY_OF_WEEK) {
    const weekNum = dbData[mondayIdx][cols.WEEK_NUM - 1];
    if (weekNum !== '' && weekNum !== null && weekNum !== undefined) {
      for (let i = 1; i < dbData.length; i++) {
        if (dbData[i][cols.WEEK_NUM - 1] == weekNum &&
            String(dbData[i][cols.DAY_OF_WEEK - 1] || '').trim() === '日') {
          return i;
        }
      }
    }
  }

  // フォールバック: 月曜日 + 6日 の日付で照合
  const monday = parseDate_(mondayStr);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return findDbRowIndexByDateStr_(dbData, cols, formatDate(sunday));
}

/**
 * 日曜日の行の振り返りセルから「週まとめ」部分を取り出します。
 * 日曜日に授業がない週はセル全体が週まとめ、授業がある週は
 * WEEK_SUMMARY_MARKER 以降が週まとめです。
 * @param {Array} sundayRow 日曜日の行データ
 * @param {Object} cols 列マップ
 * @returns {string}
 */
function readWeekSummaryFromRow_(sundayRow, cols) {
  if (!sundayRow || !cols.REFLECTION) return '';
  const text = String(sundayRow[cols.REFLECTION - 1] || '').trim();
  if (!text) return '';
  if (!rowHasLessons_(sundayRow, cols)) return text;
  const m = text.indexOf(WEEK_SUMMARY_MARKER);
  return m >= 0 ? text.substring(m + WEEK_SUMMARY_MARKER.length).trim() : '';
}

/**
 * 週まとめを日曜日の行の振り返りセルへ書き込みます。
 * 日曜日に授業があり日次振り返りが書かれている場合は、それを残したまま
 * WEEK_SUMMARY_MARKER 見出し付きで追記（置換）します。
 * @returns {string} 実際にセルへ書き込んだテキスト
 */
function writeWeekSummaryToSunday_(dbSheet, dbData, cols, sundayIdx, summary) {
  const row = dbData[sundayIdx];
  let cellText = summary;
  if (rowHasLessons_(row, cols)) {
    const existing = String(row[cols.REFLECTION - 1] || '');
    const markerPos = existing.indexOf(WEEK_SUMMARY_MARKER);
    const dailyPart = (markerPos >= 0 ? existing.substring(0, markerPos) : existing).trimEnd();
    cellText = (dailyPart ? dailyPart + '\n\n' : '') + WEEK_SUMMARY_MARKER + '\n' + summary;
  }
  dbData[sundayIdx][cols.REFLECTION - 1] = cellText;
  dbSheet.getRange(sundayIdx + 1, cols.REFLECTION).setValue(cellText);
  return cellText;
}

/**
 * [Webアプリ API] 今日の振り返り状況を返します（自動起動判定・バッジ表示用）。
 * @returns {Object} { success, today, hasLessons, status, reflection, pendingCount }
 */
function getTodayReflectionStatus() {
  try {
    const cols = ensureReflectionColumns_();
    const ss = getSs_();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');
    const dbData = dbSheet.getDataRange().getValues();

    const todayStr = formatDate(new Date());
    let hasLessons = false;
    let status = '';
    let reflection = '';
    let pendingCount = 0;

    for (let i = 1; i < dbData.length; i++) {
      const row = dbData[i];
      const d = row[cols.DATE - 1];
      if (!(d instanceof Date)) continue;
      const ds = formatDate(d);
      if (ds > todayStr) continue;
      if (!rowHasLessons_(row, cols)) continue;

      const st = String(row[cols.REFLECTION_STATUS - 1] || '').trim();
      if (st !== REFLECTION_STATUS_DONE) pendingCount++;
      if (ds === todayStr) {
        hasLessons = true;
        status = st;
        reflection = String(row[cols.REFLECTION - 1] || '');
      }
    }

    return { success: true, today: todayStr, hasLessons, status, reflection, pendingCount };
  } catch (e) {
    logError('getTodayReflectionStatus', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 指定日の振り返りコンテキスト（当日の計画＋既存の振り返り）を返します。
 * 振り返りウィザードの参照表示に使用します。
 * @param {string} dateStr "yyyy/MM/dd"
 */
function getReflectionContext(dateStr) {
  try {
    validateParams_({ dateStr }, {
      dateStr: { type: 'string', required: true, pattern: /^\d{4}\/\d{1,2}\/\d{1,2}$/ }
    });
    const cols = ensureReflectionColumns_();
    const ss = getSs_();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');
    const dbData = dbSheet.getDataRange().getValues();

    const idx = findDbRowIndexByDateStr_(dbData, cols, dateStr);
    if (idx === -1) return { success: false, error: `DBに ${dateStr} の行が見つかりません` };
    const row = dbData[idx];

    const periods = [1, 2, 3, 4, 5, 6].map(n => ({
      subject: String(row[cols['PERIOD' + n] - 1] || ''),
      unit: cols['UNIT' + n] ? String(row[cols['UNIT' + n] - 1] || '') : '',
      content: cols['CONTENT' + n] ? String(row[cols['CONTENT' + n] - 1] || '') : ''
    }));

    // 日曜日に授業がある場合、セル内の週まとめ部分は編集対象から除外して日次部分のみ返す
    let reflection = String(row[cols.REFLECTION - 1] || '');
    if (rowHasLessons_(row, cols)) {
      const markerPos = reflection.indexOf(WEEK_SUMMARY_MARKER);
      if (markerPos >= 0) reflection = reflection.substring(0, markerPos).trimEnd();
    }

    return {
      success: true,
      date: dateStr,
      dayLabel: cols.DAY_OF_WEEK ? String(row[cols.DAY_OF_WEEK - 1] || '') : '',
      weekNum: cols.WEEK_NUM ? (row[cols.WEEK_NUM - 1] || '') : '',
      event: cols.EVENT ? String(row[cols.EVENT - 1] || '') : '',
      morning: cols.MORNING ? String(row[cols.MORNING - 1] || '') : '',
      hasLessons: rowHasLessons_(row, cols),
      periods: periods,
      reflection: reflection,
      status: String(row[cols.REFLECTION_STATUS - 1] || '').trim()
    };
  } catch (e) {
    logError('getReflectionContext', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 授業があるのに振り返りが「完了」になっていない日（今日以前）の一覧を返します。
 * 保留された振り返りに任意のタイミングで取り組むための一覧です。
 * @returns {Object} { success, list: [{date, dayLabel, weekNum, event, subjects, status}] }
 */
function getPendingReflections() {
  try {
    const cols = ensureReflectionColumns_();
    const ss = getSs_();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');
    const dbData = dbSheet.getDataRange().getValues();

    const todayStr = formatDate(new Date());
    const list = [];

    for (let i = 1; i < dbData.length; i++) {
      const row = dbData[i];
      const d = row[cols.DATE - 1];
      if (!(d instanceof Date)) continue;
      const ds = formatDate(d);
      if (ds > todayStr) continue;
      if (!rowHasLessons_(row, cols)) continue;

      const st = String(row[cols.REFLECTION_STATUS - 1] || '').trim();
      if (st === REFLECTION_STATUS_DONE) continue;

      const subjects = [];
      for (let n = 1; n <= 6; n++) {
        const v = String(row[cols['PERIOD' + n] - 1] || '').trim();
        if (v) subjects.push(v);
      }
      list.push({
        date: ds,
        dayLabel: cols.DAY_OF_WEEK ? String(row[cols.DAY_OF_WEEK - 1] || '') : '',
        weekNum: cols.WEEK_NUM ? (row[cols.WEEK_NUM - 1] || '') : '',
        event: cols.EVENT ? String(row[cols.EVENT - 1] || '') : '',
        subjects: subjects.join('・'),
        status: st
      });
    }

    // 新しい日付が上に来るように降順で返す（直近の書き忘れから対応できるように）
    list.sort((a, b) => b.date.localeCompare(a.date));
    return { success: true, list: list.slice(0, 60) };
  } catch (e) {
    logError('getPendingReflections', e);
    return { success: false, error: e.message };
  }
}

/**
 * 指定週（月曜起点）の「授業がある日」がすべて振り返り完了かを、メモリ上のdbDataから判定します。
 * @returns {{complete: boolean, totalLessonDays: number, doneDays: number}}
 */
function computeWeekReflectionProgress_(dbData, cols, mondayStr) {
  const monday = parseDate_(mondayStr);
  let total = 0, done = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const idx = findDbRowIndexByDateStr_(dbData, cols, formatDate(d));
    if (idx === -1) continue;
    const row = dbData[idx];
    if (!rowHasLessons_(row, cols)) continue;
    total++;
    if (String(row[cols.REFLECTION_STATUS - 1] || '').trim() === REFLECTION_STATUS_DONE) done++;
  }
  return { complete: total > 0 && done === total, totalLessonDays: total, doneDays: done };
}

/**
 * [Webアプリ API] 日次振り返りを保存します。
 * status に「完了」を指定した保存で週の全授業日の振り返りが揃った場合、
 * 週まとめ（AI週報）を自動生成して同一週番号の日曜日の振り返りセルに保存します
 * （既に週まとめがある場合は上書きしません）。
 * @param {string} dateStr "yyyy/MM/dd"
 * @param {string} reflectionText 振り返り本文
 * @param {string} status "完了" または "保留"
 * @returns {Object} { success, weekComplete, mondayStr, summaryGenerated, summary, summaryError }
 */
function saveDailyReflection(dateStr, reflectionText, status) {
  try {
    validateParams_({ dateStr, reflectionText }, {
      dateStr: { type: 'string', required: true, pattern: /^\d{4}\/\d{1,2}\/\d{1,2}$/ },
      reflectionText: { type: 'string', maxLength: 10000 }
    });
    if (status !== REFLECTION_STATUS_DONE && status !== REFLECTION_STATUS_HOLD) {
      throw new Error('振り返り状態は「完了」または「保留」を指定してください。');
    }

    const cols = ensureReflectionColumns_();
    const ss = getSs_();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');
    const dbData = dbSheet.getDataRange().getValues();

    const idx = findDbRowIndexByDateStr_(dbData, cols, dateStr);
    if (idx === -1) throw new Error(`DBに ${dateStr} の行が見つかりません`);

    // 日曜日（週まとめ保存先）の日次振り返りを更新する場合、セル内の週まとめ部分は保持する
    let text = String(reflectionText || '');
    const existingCell = String(dbData[idx][cols.REFLECTION - 1] || '');
    const markerPos = existingCell.indexOf(WEEK_SUMMARY_MARKER);
    if (markerPos >= 0 && rowHasLessons_(dbData[idx], cols)) {
      const summaryPart = existingCell.substring(markerPos);
      text = text.trimEnd() + (text.trim() ? '\n\n' : '') + summaryPart;
    }

    const sheetRow = idx + 1;
    dbSheet.getRange(sheetRow, cols.REFLECTION).setValue(text);
    dbSheet.getRange(sheetRow, cols.REFLECTION_STATUS).setValue(status);

    // メモリ上のデータも更新して週完了判定に使う
    dbData[idx][cols.REFLECTION - 1] = text;
    dbData[idx][cols.REFLECTION_STATUS - 1] = status;

    const result = { success: true, status: status, weekComplete: false, summaryGenerated: false, summary: '' };
    if (status !== REFLECTION_STATUS_DONE) return result;

    // 週完了チェック → 週まとめの自動生成
    const mondayStr = formatDate(getMondayOfWeek(parseDate_(dateStr)));
    result.mondayStr = mondayStr;
    const progress = computeWeekReflectionProgress_(dbData, cols, mondayStr);
    result.weekComplete = progress.complete;
    if (!progress.complete) return result;

    const sundayIdx = findSundayRowIndexByWeek_(dbData, cols, mondayStr);
    const existingSummary = sundayIdx !== -1 ? readWeekSummaryFromRow_(dbData[sundayIdx], cols) : '';
    if (existingSummary) {
      // 既に週まとめがある場合は自動生成で上書きしない（手動編集の保護）
      result.summary = existingSummary;
      return result;
    }

    try {
      result.summary = generateWeeklySummaryCore_(dbData, cols, mondayStr);
      result.summaryGenerated = true;
    } catch (genErr) {
      logError('週まとめ自動生成', genErr);
      result.summaryError = genErr.message;
    }
    return result;
  } catch (e) {
    logError('saveDailyReflection', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 指定日の振り返りを「保留」にします（あとで書く）。本文は変更しません。
 * @param {string} dateStr "yyyy/MM/dd"
 */
function deferReflection(dateStr) {
  try {
    validateParams_({ dateStr }, {
      dateStr: { type: 'string', required: true, pattern: /^\d{4}\/\d{1,2}\/\d{1,2}$/ }
    });
    const cols = ensureReflectionColumns_();
    const ss = getSs_();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');
    const dbData = dbSheet.getDataRange().getValues();

    const idx = findDbRowIndexByDateStr_(dbData, cols, dateStr);
    if (idx === -1) throw new Error(`DBに ${dateStr} の行が見つかりません`);

    dbSheet.getRange(idx + 1, cols.REFLECTION_STATUS).setValue(REFLECTION_STATUS_HOLD);
    return { success: true };
  } catch (e) {
    logError('deferReflection', e);
    return { success: false, error: e.message };
  }
}

/**
 * 週の計画＋日々の振り返りから、管理職報告用の週まとめ文をGeminiで生成し、
 * 同一週番号の日曜日の行の振り返りセルへ保存します。
 * @param {Array[]} dbData データベース全行
 * @param {Object} cols 列マップ
 * @param {string} mondayStr "yyyy/MM/dd"
 * @returns {string} 生成された週まとめ文
 */
function generateWeeklySummaryCore_(dbData, cols, mondayStr) {
  const monday = parseDate_(mondayStr);
  const sundayIdx = findSundayRowIndexByWeek_(dbData, cols, mondayStr);
  if (sundayIdx === -1) throw new Error(`週まとめの保存先（${mondayStr} 週の日曜日の行）がDBに見つかりません`);

  const DAY_LABELS = ['月', '火', '水', '木', '金', '土', '日'];
  let contextText = '';
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const ds = formatDate(d);
    const idx = findDbRowIndexByDateStr_(dbData, cols, ds);
    if (idx === -1) continue;
    const row = dbData[idx];
    if (!rowHasLessons_(row, cols)) continue;

    contextText += `\n■ ${ds}（${DAY_LABELS[i]}）\n`;
    const eventVal = cols.EVENT ? String(row[cols.EVENT - 1] || '').trim() : '';
    if (eventVal) contextText += `- 行事: ${eventVal}\n`;
    for (let n = 1; n <= 6; n++) {
      const subject = String(row[cols['PERIOD' + n] - 1] || '').trim();
      if (!subject) continue;
      const content = cols['CONTENT' + n] ? String(row[cols['CONTENT' + n] - 1] || '').trim() : '';
      contextText += `- ${n}校時 [${subject}]${content ? ' ' + content : ''}\n`;
    }
    // 日曜日のセルに既存の週まとめが含まれる場合はプロンプトに混入させない
    let reflection = String(row[cols.REFLECTION - 1] || '').trim();
    const markerPos = reflection.indexOf(WEEK_SUMMARY_MARKER);
    if (markerPos >= 0) reflection = reflection.substring(0, markerPos).trimEnd();
    if (reflection) contextText += `【この日の振り返り】\n${reflection}\n`;
  }

  if (!contextText) throw new Error('この週には授業データがありません。');

  // セキュリティ: 入力長を制限（過大入力対策）
  if (contextText.length > 15000) {
    contextText = contextText.substring(0, 15000) + '\n...(以降省略)';
  }

  const mondayIdx = findDbRowIndexByDateStr_(dbData, cols, mondayStr);
  const weekNum = (mondayIdx !== -1 && cols.WEEK_NUM) ? (dbData[mondayIdx][cols.WEEK_NUM - 1] || '?') : '?';
  const prompt = `あなたは小学校の担任教員です。以下の【今週の計画と日々の振り返り】をもとに、管理職（校長・副校長）へ提出する第${weekNum}週の週報（週のまとめ）を日本語で作成してください。

【条件】
- 「今週の概況」「成果」「課題と改善」「予定からの変更点」の4項目を、この順に【】付きの見出しで出力してください。
- 各項目は1〜3文、全体で400字以内で、網羅的かつ簡潔にまとめてください。
- 日々の振り返りに書かれている事実のみを使い、書かれていない出来事を創作しないでください。
- 変更点がない場合、「予定からの変更点」は「特になし（計画どおり実施）」としてください。
- 見出しと本文のみを出力し、Markdown記法（*や#）は使わないでください。箇条書きが必要な場合は「・」を使ってください。

【今週の計画と日々の振り返り】
${contextText}`;

  const summary = (callGeminiAPIText_(prompt) || '').trim();
  if (!summary) throw new Error('AIが週まとめを生成できませんでした。');

  const ss = getSs_();
  const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
  writeWeekSummaryToSunday_(dbSheet, dbData, cols, sundayIdx, summary);
  logInfo(`週まとめを生成し、日曜日の振り返りセルへ保存しました（${mondayStr} 週）`);
  return summary;
}

/**
 * [Webアプリ API] 指定週の週まとめをAIで生成（再生成）します。
 * @param {string} mondayStr "yyyy/MM/dd" 週の月曜日
 * @param {boolean} force true の場合、振り返りが揃っていなくても生成する
 * @returns {Object} { success, summary, incomplete?, progress? }
 */
function generateWeeklySummary(mondayStr, force) {
  try {
    validateParams_({ mondayStr }, {
      mondayStr: { type: 'string', required: true, pattern: /^\d{4}\/\d{1,2}\/\d{1,2}$/ }
    });
    const cols = ensureReflectionColumns_();
    const ss = getSs_();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');
    const dbData = dbSheet.getDataRange().getValues();

    const progress = computeWeekReflectionProgress_(dbData, cols, mondayStr);
    if (!progress.complete && !force) {
      return {
        success: false,
        incomplete: true,
        progress: progress,
        error: `この週は振り返りが完了していません（${progress.doneDays}/${progress.totalLessonDays}日）。`
      };
    }

    const summary = generateWeeklySummaryCore_(dbData, cols, mondayStr);
    return { success: true, summary: summary };
  } catch (e) {
    logError('generateWeeklySummary', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 週まとめのテキストを手動保存します（AI生成結果の編集用）。
 * 同一週番号の日曜日の行の振り返りセルへ保存します。
 * @param {string} mondayStr "yyyy/MM/dd" 週の月曜日
 * @param {string} text 週まとめ本文
 */
function saveWeeklySummary(mondayStr, text) {
  try {
    validateParams_({ mondayStr, text }, {
      mondayStr: { type: 'string', required: true, pattern: /^\d{4}\/\d{1,2}\/\d{1,2}$/ },
      text: { type: 'string', maxLength: 10000 }
    });
    const cols = ensureReflectionColumns_();
    const ss = getSs_();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');
    const dbData = dbSheet.getDataRange().getValues();

    const sundayIdx = findSundayRowIndexByWeek_(dbData, cols, mondayStr);
    if (sundayIdx === -1) throw new Error(`週まとめの保存先（${mondayStr} 週の日曜日の行）がDBに見つかりません`);

    writeWeekSummaryToSunday_(dbSheet, dbData, cols, sundayIdx, String(text || ''));
    return { success: true };
  } catch (e) {
    logError('saveWeeklySummary', e);
    return { success: false, error: e.message };
  }
}
