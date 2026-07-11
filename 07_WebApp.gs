/**
 * @fileoverview Webアプリケーションのエントリポイントとデータ送受信API (Phase 3)
 * 
 * 重要: Webアプリコンテキスト（doGet経由）では SpreadsheetApp.getActiveSpreadsheet() が
 * null を返すため、全API関数では getSs_() ヘルパー経由でスプレッドシートを取得する。
 */

/** Webアプリ・スプレッドシート両コンテキストで安全にSSを取得するヘルパー */
function getSs_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;
  // Webアプリコンテキスト: スクリプトがバインドされたスプレッドシートを PropertiesService 経由で取得
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  throw new Error('スプレッドシートが取得できません。設定ダッシュボードから SPREADSHEET_ID を設定してください。');
}

/**
 * WebアプリのエントリポイントSPAのメインHTMLを返します。
 * 初回アクセス時に SPREADSHEET_ID をスクリプトプロパティへ自動保存する。
 */
function doGet(e) {
  // バインドスクリプトの場合、初回にスプレッドシートIDを記録
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) {
      PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
    }
  } catch(e) {}
  return HtmlService.createTemplateFromFile('App')
    .evaluate()
    .setTitle('週案エディタ')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setFaviconUrl('https://drive.google.com/uc?id=1zNSkBUKrzxX4TDeDpcXZ-jKtDtv0c4Yn&.png');
}

/**
 * HTMLファイルの内容を <include> で読み込むためのユーティリティ関数
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}


// ===================================================
// ===== 週案・データ取得 API =====
// ===================================================

/**
 * 指定された週（月曜日の日付文字列 "yyyy/MM/dd"）の週案データをDBから取得します。
 * @param {string} mondayDateStr "yyyy/MM/dd" 形式の月曜日の日付
 * @returns {Object} { dates: string[], rows: Object[], found: number }
 */
function getWeeklyPlanData(mondayDateStr) {
  try {
    validateParams_({ mondayDateStr }, {
      mondayDateStr: { type: 'string', required: true, pattern: /^\d{4}\/\d{1,2}\/\d{1,2}$/ }
    });
    const ss = getSs_();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');

    const dbCols = getDbColumns();
    const dbData = dbSheet.getDataRange().getValues();

    // 月曜日を起点に月～日の7日間を準備
    const monday = parseDate_(mondayDateStr);
    const weekDates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return d;
    });

    // DB全行をMapに変換 (key: "yyyy/MM/dd") および該当週の週番号を取得
    const dbMap = new Map();
    let weekNum = '?';

    for (const row of dbData) {
      if (row[dbCols.DATE - 1] instanceof Date) {
        const dateStr = formatDate(row[dbCols.DATE - 1]);
        dbMap.set(dateStr, row);
        // 今回リクエストされた月曜日のデータをもとに週番号を取得
        if (dateStr === formatDate(monday)) {
          weekNum = row[dbCols.WEEK_NUM - 1] || '?';
        }
      }
    }

    const DAY_LABELS = ['月', '火', '水', '木', '金', '土', '日'];
    const days = weekDates.map((date, i) => {
      const dateStr = formatDate(date);
      const row = dbMap.get(dateStr);
      return {
        date: dateStr,
        dayLabel: DAY_LABELS[i],
        event: row ? (row[dbCols.EVENT - 1] || '') : '',
        morning: row ? (row[dbCols.MORNING - 1] || '') : '',
        periods: row
          ? [1, 2, 3, 4, 5, 6].map(n => ({
              subject: row[dbCols['PERIOD' + n] - 1] || '',
              unit: row[dbCols['UNIT' + n] - 1] || '',
              content: row[dbCols['CONTENT' + n] - 1] || ''
            }))
          : [1, 2, 3, 4, 5, 6].map(() => ({ subject: '', unit: '', content: '' })),
        recess1: row ? (row[dbCols.RECESS1 - 1] || '') : '',
        recess2: row ? (row[dbCols.RECESS2 - 1] || '') : '',
        afterschool: row ? (row[dbCols.AFTERSCHOOL - 1] || '') : '',
        homework: row ? (row[dbCols.HOMEWORK - 1] || '') : '',
        items: row ? (row[dbCols.ITEMS - 1] || '') : '',
        found: !!row
      };
    });

    // 楽観ロック用リビジョン（この週の現在のDB内容のハッシュ）。保存時に競合検知に用いる。
    const weekDateStrs = weekDates.map(d => formatDate(d));
    const revision = computeWeekRevision_(dbData, dbCols, weekDateStrs);

    return { success: true, days, mondayDateStr, weekNum, revision };
  } catch (e) {
    logError('getWeeklyPlanData', e);
    return { success: false, error: e.message };
  }
}


/**
 * 週番号からその週の月曜日の日付文字列を取得します。
 * @param {number|string} weekNum 週番号
 * @returns {string|null} "yyyy/MM/dd" 形式の月曜日の日付文字列（見つからなければ null）
 */
function getMondayStrByWeekNumber(weekNum) {
  try {
    const ss = getSs_();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');

    const dbCols = getDbColumns();
    const dbData = dbSheet.getDataRange().getValues();
    dbData.shift(); // ヘッダー行を除外

    for (const row of dbData) {
      if (row[dbCols.WEEK_NUM - 1] == weekNum) {
        const dateObj = row[dbCols.DATE - 1];
        if (dateObj instanceof Date) {
          const m = getMondayOfWeek(dateObj);
          return Utilities.formatDate(m, Session.getScriptTimeZone(), 'yyyy/MM/dd');
        }
      }
    }
    return null; // 見つからなかった場合
  } catch (e) {
    logError('getMondayStrByWeekNumber', e);
    throw e;
  }
}

/**
 * Webアプリから受け取った週案データをDBに一括保存します。
 * @param {string} mondayDateStr "yyyy/MM/dd" 形式の月曜日の日付
 * @param {Object[]} days 保存するデータの配列（getWeeklyPlanDataと同じ形式）
 * @param {string} [baseRevision] 読み込み時に受け取ったリビジョン。指定時は楽観ロックで競合を検知する。
 * @returns {Object} { success: boolean, message?: string, revision?: string, conflict?: boolean, error?: string }
 */
function saveWeeklyPlanData(mondayDateStr, days, baseRevision) {
  // 同時保存による全シート書き戻しの競合（他の週の変更の消失等）を防ぐため直列化する
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (lockErr) {
    return { success: false, error: '他の保存処理が進行中です。少し待ってから再度お試しください。' };
  }
  try {
    validateParams_({ mondayDateStr, days }, {
      mondayDateStr: { type: 'string', required: true, pattern: /^\d{4}\/\d{1,2}\/\d{1,2}$/ },
      days: { required: true, isArray: true }
    });

    // 教科セルの検証: 「教科名+分数」形式は分数の合計が必ず1でなければならない
    const subjectErrors = validateDaysSubjects_(days);
    if (subjectErrors.length > 0) {
      return {
        success: false,
        error: '教科名の入力に誤りがあるため保存できません。\n' + subjectErrors.join('\n')
      };
    }

    const ss = getSs_();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');

    const dbCols = getDbColumns();
    const dbData = dbSheet.getDataRange().getValues();

    // 該当週の7日分の日付文字列（リビジョン算出・後段の戻り値に使用）
    const monday = parseDate_(mondayDateStr);
    const weekDateStrs = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return formatDate(d);
    });

    // 楽観ロック: クライアントが読み込んだ後に他の端末やAI処理で更新されていないか確認する。
    // baseRevision 未指定（旧クライアント）の場合は従来通り無条件保存する（後方互換）。
    if (baseRevision) {
      const currentRevision = computeWeekRevision_(dbData, dbCols, weekDateStrs);
      if (currentRevision !== baseRevision) {
        return {
          success: false,
          conflict: true,
          error: 'この週は他の端末またはAI処理によって更新されています。最新を読み込み直してから保存してください。'
        };
      }
    }

    // DB全行をMapに変換 (key: "yyyy/MM/dd", value: array index)
    const dbDateIndexMap = new Map();
    for (let i = 0; i < dbData.length; i++) {
      if (dbData[i][dbCols.DATE - 1] instanceof Date) {
        dbDateIndexMap.set(formatDate(dbData[i][dbCols.DATE - 1]), i);
      }
    }

    const maxCol = Math.max(...Object.values(dbCols));
    dbData.forEach(row => { while (row.length < maxCol) row.push(''); });

    let updatedCount = 0;
    const notFoundDates = [];

    for (const day of days) {
      if (!day.found && !day.periods.some(p => p.subject)) continue; // 空の日はスキップ

      if (dbDateIndexMap.has(day.date)) {
        const rowIdx = dbDateIndexMap.get(day.date);
        const row = dbData[rowIdx];

        row[dbCols.EVENT - 1]      = day.event || '';
        row[dbCols.MORNING - 1]    = day.morning || '';
        row[dbCols.PERIOD1 - 1]    = day.periods[0]?.subject || '';
        row[dbCols.UNIT1 - 1]      = day.periods[0]?.unit || '';
        row[dbCols.CONTENT1 - 1]   = day.periods[0]?.content || '';
        row[dbCols.PERIOD2 - 1]    = day.periods[1]?.subject || '';
        row[dbCols.UNIT2 - 1]      = day.periods[1]?.unit || '';
        row[dbCols.CONTENT2 - 1]   = day.periods[1]?.content || '';
        row[dbCols.RECESS1 - 1]    = day.recess1 || '';
        row[dbCols.PERIOD3 - 1]    = day.periods[2]?.subject || '';
        row[dbCols.UNIT3 - 1]      = day.periods[2]?.unit || '';
        row[dbCols.CONTENT3 - 1]   = day.periods[2]?.content || '';
        row[dbCols.PERIOD4 - 1]    = day.periods[3]?.subject || '';
        row[dbCols.UNIT4 - 1]      = day.periods[3]?.unit || '';
        row[dbCols.CONTENT4 - 1]   = day.periods[3]?.content || '';
        row[dbCols.RECESS2 - 1]    = day.recess2 || '';
        row[dbCols.PERIOD5 - 1]    = day.periods[4]?.subject || '';
        row[dbCols.UNIT5 - 1]      = day.periods[4]?.unit || '';
        row[dbCols.CONTENT5 - 1]   = day.periods[4]?.content || '';
        row[dbCols.PERIOD6 - 1]    = day.periods[5]?.subject || '';
        row[dbCols.UNIT6 - 1]      = day.periods[5]?.unit || '';
        row[dbCols.CONTENT6 - 1]   = day.periods[5]?.content || '';
        row[dbCols.AFTERSCHOOL - 1] = day.afterschool || '';
        row[dbCols.HOMEWORK - 1]   = day.homework || '';
        row[dbCols.ITEMS - 1]      = day.items || '';

        updatedCount++;
      } else {
        notFoundDates.push(day.date);
      }
    }

    // パフォーマンス: 実際に更新があった場合のみDB書き込み
    if (updatedCount > 0) {
      dbSheet.getRange(1, 1, dbData.length, dbData[0].length).setValues(dbData);
    }

    const msg = notFoundDates.length > 0
      ? `${updatedCount}日分を保存しました（DB未登録日: ${notFoundDates.join(', ')}）`
      : `${updatedCount}日分を保存しました`;

    // 書き込み後の新リビジョンを返し、クライアントが次回保存の基準を更新できるようにする
    const newRevision = computeWeekRevision_(dbData, dbCols, weekDateStrs);
    return { success: true, message: msg, updatedCount, revision: newRevision };
  } catch (e) {
    logError('saveWeeklyPlanData', e);
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 単元マスタから教科一覧と単元リストを取得します（サジェスト用）。
 * @returns {Object} { subjects: string[], masterMap: Object }
 */
function getUnitMasterForSuggest() {
  try {
    const ss = getSs_();
    const masterSheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
    if (!masterSheet) return { success: true, subjects: [], masterMap: {} };

    const data = masterSheet.getDataRange().getValues();
    const subjects = [...new Set(data.slice(1).map(r => r[MASTER_COL_SUBJECT - 1]).filter(Boolean))];
    const masterMap = {};
    for (const row of data.slice(1)) {
      const subject = row[MASTER_COL_SUBJECT - 1];
      const unit = row[MASTER_COL_UNIT_NAME - 1];
      const totalHours = row[MASTER_COL_TOTAL_HOURS - 1];
      if (subject && unit) {
        if (!masterMap[subject]) masterMap[subject] = [];
        // 同一単元が未登録の場合のみ追加
        if (!masterMap[subject].some(u => u.unitName === unit)) {
          masterMap[subject].push({ unitName: unit, totalHours: totalHours || 1 });
        }
      }
    }

    return { success: true, subjects, masterMap };
  } catch (e) {
    logError('getUnitMasterForSuggest', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 指定された教科・単元名・時間目の学習活動を返します。
 * 手動編集時の単元マスタピッカーで使用されます。
 */
function getActivityFromMaster(subject, unitName, hourNum) {
  try {
    const ss = getSs_();
    const masterSheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
    if (!masterSheet) return { success: false, error: '単元マスタシートが見つかりません。' };

    const masterData = masterSheet.getDataRange().getValues();
    const activity = findActivityFromMaster_(masterData, subject, unitName, hourNum);
    return { success: true, activity: activity };
  } catch (e) {
    logError('getActivityFromMaster', e);
    return { success: false, error: e.message };
  }
}

/**
 * 月別・教科別の実施時数を集計して返します。
 * @param {number} year 対象年（西暦）
 * @param {number} month 対象月（1〜12）
 * @returns {Object} 教科別時数オブジェクト
 */
function getMonthlyHoursData(year, month) {
  try {
    validateParams_({ year, month }, {
      year: { type: 'number', required: true, min: 2000, max: 2100 },
      month: { type: 'number', required: true, min: 1, max: 12 }
    });
    const ss = getSs_();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');

    const dbCols = getDbColumns();
    const dbData = dbSheet.getDataRange().getValues();

    const hoursBySubject = {};
    const periodCols = [dbCols.PERIOD1, dbCols.PERIOD2, dbCols.PERIOD3, dbCols.PERIOD4, dbCols.PERIOD5, dbCols.PERIOD6].filter(c => c);

    for (const row of dbData.slice(1)) {
      const date = row[dbCols.DATE - 1];
      if (!(date instanceof Date)) continue;
      if (date.getFullYear() !== year || date.getMonth() + 1 !== month) continue;

      for (const col of periodCols) {
        // 「国語1/3行事2/3」のような分数付き入力も他の集計APIと同様に分解して加算する
        const parsed = parseSubjectHours_(row[col - 1]);
        for (const { subject, fraction } of parsed) {
          hoursBySubject[subject] = (hoursBySubject[subject] || 0) + fraction;
        }
      }
    }

    // 他の集計APIと同じ教科名集約（学活→特活、図書・書写→国語 等）を適用
    aggregateSubjectCounts_(hoursBySubject);

    return { success: true, year, month, hoursBySubject };
  } catch (e) {
    logError('getMonthlyHoursData', e);
    return { success: false, error: e.message };
  }
}

/**
 * 年間（4月〜翌年3月）の教科別・月別実施時数を集計して返します。
 * @param {number} academicYear 対象年度（例: 2024 なら 2024年4月〜2025年3月）
 * @returns {Object} 教科別・月別時数オブジェクト
 */
function getAnnualHoursData(academicYear) {
  try {
    const ss = getSs_();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');

    const dbCols = getDbColumns();
    const dbData = dbSheet.getDataRange().getValues();

    // hoursData: { "国語": { "4": 15.333, "5": 20, ... }, "算数": ... }
    const hoursData = {};

    const periodCols = [dbCols.PERIOD1, dbCols.PERIOD2, dbCols.PERIOD3, dbCols.PERIOD4, dbCols.PERIOD5, dbCols.PERIOD6].filter(c => c);

    for (const row of dbData.slice(1)) {
      const date = row[dbCols.DATE - 1];
      if (!(date instanceof Date)) continue;
      
      const year = date.getFullYear();
      const month = date.getMonth() + 1;
      
      let rowAcademicYear = year;
      if (month <= 3) rowAcademicYear -= 1;
      
      if (rowAcademicYear !== academicYear) continue;

      for (const col of periodCols) {
        const parsed = parseSubjectHours_(row[col - 1]);
        for (const { subject, fraction } of parsed) {
          if (!hoursData[subject]) hoursData[subject] = {};
          if (!hoursData[subject][month]) hoursData[subject][month] = 0;
          hoursData[subject][month] += fraction;
        }
      }
    }

    // 表示用の教科名集約: 学活→特活、図書・書写→国語に合算
    aggregateHoursData_(hoursData);

    return { success: true, academicYear, hoursData };
  } catch (e) {
    logError('getAnnualHoursData', e);
    return { success: false, error: e.message };
  }
}

// ===================================================
// ===== ユーティリティ =====
// ===================================================

/**
 * "yyyy/MM/dd" 形式の文字列をDateオブジェクトに変換します。
 * @param {string} dateStr
 * @returns {Date}
 * @throws {Error} 形式が不正な場合
 */
function parseDate_(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(dateStr)) {
    throw new Error(`日付形式が不正です: "${dateStr}"（yyyy/MM/dd形式を使用してください）`);
  }
  const parts = dateStr.split('/');
  const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  if (isNaN(d.getTime())) {
    throw new Error(`無効な日付です: "${dateStr}"`);
  }
  return d;
}

/**
 * 教科セルの値を解析し、教科ごとの分数を正確な有理数（分子/分母）として返します。
 * 対応形式:
 *  - 単一教科: "国語"（分数なし = 1時間）
 *  - 教科名+分数: "国語1/3行事2/3", "理科 1/2 図工 1/2"
 *  - 教科名+小数: "国語0.5社会0.5"（内部では 5/10 のような分数として扱う）
 * @param {*} cellValue セルの教科名テキスト
 * @returns {{entries: Array<{subject: string, fraction: number, num: number, den: number, explicit: boolean}>, unparsedText: string}}
 *   entries: 解析結果（explicit は分数が明示されていたか）
 *   unparsedText: 解析できなかった非空白文字（例: "国語 2" の "2"）。不正入力の検知に使用。
 */
function parseSubjectCell_(cellValue) {
  const result = { entries: [], unparsedText: '' };
  if (cellValue === null || cellValue === undefined) return result;
  const normalized = cellValue.toString().trim().replace(/　/g, ' ');
  if (!normalized) return result;

  const regex = /([^\s\d\/\.]+)(?:[\s]*(\d+\/\d+|\d+\.\d+))?/g;
  let match;
  let lastIndex = 0;
  let unparsed = '';
  while ((match = regex.exec(normalized)) !== null) {
    if (match.index > lastIndex) unparsed += normalized.slice(lastIndex, match.index);
    lastIndex = regex.lastIndex;

    const subject = match[1].trim();
    if (!subject) continue;
    let num = 1, den = 1, explicit = false;
    if (match[2]) {
      explicit = true;
      if (match[2].includes('/')) {
        const parts = match[2].split('/');
        num = parseInt(parts[0], 10);
        den = parseInt(parts[1], 10);
      } else {
        // 小数を正確な分数に変換（例: "0.5" → 5/10）
        const decParts = match[2].split('.');
        den = Math.pow(10, decParts[1].length);
        num = parseInt(decParts[0], 10) * den + parseInt(decParts[1], 10);
      }
    }
    result.entries.push({ subject, fraction: den === 0 ? NaN : num / den, num, den, explicit });
  }
  if (lastIndex < normalized.length) unparsed += normalized.slice(lastIndex);
  result.unparsedText = unparsed.replace(/\s/g, '');
  return result;
}

/**
 * 教科セルの値（例: "国語", "国語1/3行事2/3"）を解析し、
 * [{subject, fraction}] の配列を返します。
 * getAnnualHoursData と getHoursSummary で共通利用されます。
 * 分母0などの不正な分数は集計を汚染しないよう除外します。
 * @param {string} cellValue セルの教科名テキスト
 * @returns {Array<{subject: string, fraction: number}>}
 */
function parseSubjectHours_(cellValue) {
  return parseSubjectCell_(cellValue).entries
    .filter(e => isFinite(e.fraction))
    .map(e => ({ subject: e.subject, fraction: e.fraction }));
}

/**
 * 分数を約分して "n/d" 形式（整数なら整数）の文字列にします。
 */
function formatRational_(num, den) {
  const gcd = function (a, b) { return b === 0 ? a : gcd(b, a % b); };
  const g = gcd(Math.abs(num), Math.abs(den)) || 1;
  num /= g; den /= g;
  return den === 1 ? String(num) : num + '/' + den;
}

/**
 * 教科セルの入力値を検証します。
 * ルール:
 *  - 空欄 → 有効
 *  - 単一の教科名のみ（分数なし） → 有効
 *  - 「教科名+分数」形式 → 全ての教科に分数が付いており、かつ分数の合計が正確に1であること
 * 分数の合計判定は浮動小数点誤差を避けるため有理数演算で行います。
 * @param {*} cellValue セルの教科名テキスト
 * @returns {{valid: boolean, message?: string}}
 */
function validateSubjectCellValue_(cellValue) {
  const parsed = parseSubjectCell_(cellValue);
  const entries = parsed.entries;
  if (parsed.unparsedText) {
    return { valid: false, message: '解釈できない文字「' + parsed.unparsedText + '」が含まれています。「国語」または「国語1/3行事2/3」の形式で入力してください。' };
  }
  if (entries.length === 0) return { valid: true };
  // 単一教科名のみ（分数なし）は1時間として有効
  if (entries.length === 1 && !entries[0].explicit) return { valid: true };

  // ここからは「教科名+分数」形式: 全教科に分数が必要
  const noFraction = entries.filter(e => !e.explicit).map(e => e.subject);
  if (noFraction.length > 0) {
    return { valid: false, message: '「' + noFraction.join('」「') + '」に分数がありません。複数教科を入力する場合は各教科に分数を付けてください（例: 国語1/3行事2/3）。' };
  }
  if (entries.some(e => e.den === 0)) {
    return { valid: false, message: '分母が0の分数は入力できません。' };
  }
  // 有理数で正確に合計し、合計が1かどうかを判定
  let num = 0, den = 1;
  for (const e of entries) {
    num = num * e.den + e.num * den;
    den = den * e.den;
  }
  if (num !== den) {
    return { valid: false, message: '分数の合計が1になっていません（合計: ' + formatRational_(num, den) + '）。セル内の分数の合計は必ず1にしてください。' };
  }
  return { valid: true };
}

/**
 * 週案データ（days配列）の全教科セルを検証し、エラーメッセージの配列を返します。
 * @param {Array} days saveWeeklyPlanData に渡される週データ
 * @returns {string[]} エラーメッセージ（問題なければ空配列）
 */
function validateDaysSubjects_(days) {
  const errors = [];
  for (const day of days) {
    if (!day || !Array.isArray(day.periods)) continue;
    day.periods.forEach((p, idx) => {
      const value = p && p.subject;
      if (!value) return;
      const check = validateSubjectCellValue_(value);
      if (!check.valid) {
        errors.push((day.date || '') + ' ' + (idx + 1) + '校時「' + value + '」: ' + check.message);
      }
    });
  }
  return errors;
}

/**
 * 教科名の集約ルール（入力名 → 表示／合算先）。
 * - 学活 → 特活（リネーム）
 * - 図書・書写 → 国語（合算）
 * - 中体育・外体育 → 体育（合算）
 */
const SUBJECT_AGGREGATION_RULES_ = [
  { from: '学活', to: '特活' },
  { from: '図書', to: '国語' },
  { from: '書写', to: '国語' },
  { from: '中体育', to: '体育' },
  { from: '外体育', to: '体育' }
];

/**
 * 教科別データの教科名を SUBJECT_AGGREGATION_RULES_ に従って集約します。
 * @param {Object} data 教科名をキーとするオブジェクト
 * @param {boolean} nested true なら値が { month: hours } のネスト構造、
 *   false なら値が数値（単純カウント）として扱います。
 */
function aggregateSubjects_(data, nested) {
  SUBJECT_AGGREGATION_RULES_.forEach(function(rule) {
    const from = rule.from, to = rule.to;
    if (!data[from]) return;
    if (nested) {
      if (!data[to]) data[to] = {};
      for (const m in data[from]) {
        data[to][m] = (data[to][m] || 0) + data[from][m];
      }
    } else {
      data[to] = (data[to] || 0) + data[from];
    }
    delete data[from];
  });
}

/**
 * 月別時数データ（{ 教科名: { month: hours, ... }, ... }）の教科名を集約します。
 * @param {Object} hoursData
 */
function aggregateHoursData_(hoursData) {
  aggregateSubjects_(hoursData, true);
}

/**
 * 単純カウントオブジェクト（{ 教科名: number, ... }）の教科名を集約します。
 * @param {Object} counts
 */
function aggregateSubjectCounts_(counts) {
  aggregateSubjects_(counts, false);
}

/**
 * 今日が含まれる週の月曜日の日付文字列を返します。
 * @returns {string} "yyyy/MM/dd"
 */
function getTodaysMondayStr() {
  return formatDate(getMondayOfWeek(new Date()));
}


// ===================================================
// ===== PDF帳票生成エンジン API (Phase 3 Step 3) =====
// ===================================================




// ===================================================
// ===== 学級通信ジェネレーター API (Phase 3 Step 3) =====
// ===================================================

/**
 * [Webアプリ API] 指定週のDBデータから学級通信の原稿データを生成して返します。
 * フロントエンドでプレビュー&編集し、`postNewsletterToClassroom()` で投稿します。
 * @param {string} mondayDateStr "yyyy/MM/dd"
 * @returns {Object} 学級通信の構成データ
 */
function getNewsletterData(mondayDateStr) {
  try {
    const result = getWeeklyPlanData(mondayDateStr);
    if (!result.success) return result;

    const days = result.days;
    const monday = parseDate_(mondayDateStr);

    const scheduleSummary = days.slice(0, 5).map(day => {
      const subjects = day.periods.filter(p => p.subject).map(p => p.subject).join('・');
      const event = day.event ? `【${day.event}】` : '';
      return `${day.dayLabel}（${day.date.slice(5)}）${event} ${subjects}`;
    }).join('\n');

    return {
      success: true,
      title: `今週のがんばり & 来週の予定`,
      date: Utilities.formatDate(monday, 'JST', 'yyyy年M月d日'),
      scheduleSummary: scheduleSummary,
      days: days
    };
  } catch (e) {
    logError('getNewsletterData', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 「学級通信」シートをPDF化してDrive保存し、ダウンロードURLを返します。
 * @param {string} mondayDateStr 対象週の月曜日の日付
 * @returns {Object} { success, downloadUrl, viewUrl, fileName }
 */
function generateNewsletterPdf(mondayDateStr) {
  try {
    const ss = getSs_();
    const sheet = ss.getSheetByName(SHEET_NAME_NEWSLETTER);
    if (!sheet) throw new Error(`「${SHEET_NAME_NEWSLETTER}」シートが見つかりません`);

    // DBから当該週の週番号を取得
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');
    const dbCols = getDbColumns();
    const dbData = dbSheet.getDataRange().getValues();
    const monday = parseDate_(mondayDateStr);

    let weekNum = null;
    for (const row of dbData.slice(1)) {
      const date = row[dbCols.DATE - 1];
      if (date instanceof Date && isSameDate(date, monday)) {
        weekNum = row[dbCols.WEEK_NUM - 1];
        break;
      }
    }

    // 学級通信シートのA1に直接書き込む
    if (weekNum !== null && weekNum !== undefined) {
      sheet.getRange('A1').setValue(weekNum);
      SpreadsheetApp.flush();
      Utilities.sleep(3000); // 描画待ち
    } else {
      logInfo('警告: DBに該当日付の週番号が見つかりませんでした。mondayDateStr=' + mondayDateStr);
    }

    const formattedDate = Utilities.formatDate(new Date(), 'JST', 'yyyyMMdd');
    const fileName = `学級通信_${formattedDate}.pdf`;
    const exportUrl = `https://docs.google.com/spreadsheets/d/${ss.getId()}/export?`
      + `exportFormat=pdf&format=pdf&size=A4&portrait=true&fitToPage=true`
      + `&gridlines=false&printtitle=false&sheetnames=false`
      + `&gid=${sheet.getSheetId()}`;

    const blob = UrlFetchApp.fetch(exportUrl, {
      headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() }
    }).getBlob().setName(fileName);

    const folder = DriveApp.getRootFolder();
    const existing = folder.getFilesByName(fileName);
    while (existing.hasNext()) existing.next().setTrashed(true);

    const pdfFile = folder.createFile(blob);
    pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    logInfo(`学級通信PDF生成: ${fileName}`);
    return {
      success: true,
      downloadUrl: pdfFile.getDownloadUrl(),
      viewUrl: `https://drive.google.com/file/d/${pdfFile.getId()}/view`,
      fileName
    };
  } catch (e) {
    logError('generateNewsletterPdf', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 学級通信HTMLをGoogleドキュメントに変換してClassroomへ投稿します。
 * Drive REST API (v3) を UrlFetchApp 経由で呼び出し、
 * HTMLをGoogleドキュメントに変換してそのまま添付します。
 * (Drive Advanced Serviceは不要)
 * @param {string} customMessage Classroomへの付加メッセージ
 * @param {string} htmlContent 学級通信エディタのHTML文字列
 * @returns {Object} { success, message }
 */
function postNewsletterToClassroomFromWeb(customMessage, htmlContent) {
  try {
    const courseName = getCourseNameSafe_();
    const formattedDate = Utilities.formatDate(new Date(), 'JST', 'yyyyMMdd_HHmm');
    const fileName = '学級通信_' + formattedDate;
    const folder = getOrCreateNwFolder_();

    // Drive REST API v3 で HTML → Google Doc 変換アップロード
    const boundary = 'nw_boundary_' + formattedDate;
    const metadata = JSON.stringify({
      name: fileName,
      mimeType: 'application/vnd.google-apps.document',
      parents: [folder.getId()]
    });
    const payload =
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      metadata + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: text/html; charset=UTF-8\r\n\r\n' +
      htmlContent + '\r\n' +
      '--' + boundary + '--';

    const resp = UrlFetchApp.fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() },
        contentType: 'multipart/related; boundary=' + boundary,
        payload: Utilities.newBlob(payload).getBytes(),
        muteHttpExceptions: true
      }
    );
    if (resp.getResponseCode() !== 200) {
      const errBody = JSON.parse(resp.getContentText());
      throw new Error('Drive API: ' + (errBody.error ? errBody.error.message : resp.getContentText()));
    }
    const fileId = JSON.parse(resp.getContentText()).id;
    const classroomFile = DriveApp.getFileById(fileId);

    classroomFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    const courseId = getCourseIdByName(courseName);
    const announcement = {
      text: customMessage || '学級通信をお届けします。',
      materials: [{ driveFile: { driveFile: { id: classroomFile.getId() } } }]
    };
    Classroom.Courses.Announcements.create(announcement, courseId);

    logInfo(`学級通信をClassroom「${courseName}」に投稿完了: ${classroomFile.getName()}`);
    return { success: true, message: `「${courseName}」に学級通信を投稿しました！` };
  } catch (e) {
    logError('postNewsletterToClassroomFromWeb', e);
    return { success: false, error: e.message };
  }
}

// ===================================================
// ===== 学級通信データ 保存/読込 API =====
// ===================================================

/**
 * 学級通信データ保存用フォルダを取得（なければ作成）
 */
function getOrCreateNwFolder_() {
  const folderName = '学級通信データ';
  const iter = DriveApp.getFoldersByName(folderName);
  if (iter.hasNext()) return iter.next();
  return DriveApp.createFolder(folderName);
}

/**
 * [Web API] 学級通信のブロックデータをDrive+シートに保存します。
 * シート列構成: ID | Title | Date | FileId | TargetWeek (5列)
 * @param {string} title タイトル
 * @param {string} mondayStr 対象週
 * @param {string} jsonString ブロックデータJSON
 * @returns {Object} { success, message }
 */
function saveNewsletterData(title, mondayStr, jsonString) {
  try {
    validateParams_({ title, jsonString }, {
      title: { type: 'string', maxLength: 200 },
      jsonString: { type: 'string', required: true, maxLength: 2000000 }
    });
    const ss = getSs_();
    const sheet = ss.getSheetByName(SHEET_NAME_NEWSLETTER_DATA);
    if (!sheet) throw new Error(`「${SHEET_NAME_NEWSLETTER_DATA}」シートが見つかりません`);

    const folder = getOrCreateNwFolder_();
    const fileName = 'nw_' + new Date().getTime() + '.json';
    const file = folder.createFile(fileName, jsonString, 'application/json');

    // 5列構成: ID(タイムスタンプ), Title, Date, FileId, TargetWeek
    sheet.appendRow([
      new Date().getTime(),
      title || '無題',
      new Date(),
      file.getId(),
      mondayStr || ''
    ]);

    logInfo(`学級通信保存: ${title} (${mondayStr})`);
    return { success: true, message: '保存しました' };
  } catch (e) {
    logError('saveNewsletterData', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Web API] 保存済み学級通信の一覧を取得します。
 * シート列構成: A=ID | B=Title | C=Date | D=FileId | E=TargetWeek
 * 旧4列形式 (Title|MondayStr|Date|FileId) にも対応
 * @returns {Object} { success, list: [{rowIndex, title, mondayStr, savedAt, fileId}] }
 */
function getNewsletterSaveList() {
  try {
    const ss = getSs_();
    const sheet = ss.getSheetByName(SHEET_NAME_NEWSLETTER_DATA);
    if (!sheet || sheet.getLastRow() < 2) return { success: true, list: [] };

    const lastCol = Math.min(Math.max(sheet.getLastColumn(), 4), 5);
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).getValues();

    // ヘッダー行で形式を判定
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const firstHeader = String(headers[0] || '').trim().toUpperCase();
    const is5col = (firstHeader === 'ID' || lastCol >= 5);

    const list = data.map(function(row, i) {
      if (is5col) {
        // 新5列形式: ID | Title | Date | FileId | TargetWeek
        return {
          rowIndex: i + 2,
          title: String(row[1] || '無題'),
          mondayStr: String(row[4] || ''),
          savedAt: row[2] ? Utilities.formatDate(new Date(row[2]), 'JST', 'yyyy/MM/dd HH:mm') : '',
          fileId: String(row[3] || '')
        };
      } else {
        // 旧4列形式: Title | MondayStr | Date | FileId
        return {
          rowIndex: i + 2,
          title: String(row[0] || '無題'),
          mondayStr: String(row[1] || ''),
          savedAt: row[2] ? Utilities.formatDate(new Date(row[2]), 'JST', 'yyyy/MM/dd HH:mm') : '',
          fileId: String(row[3] || '')
        };
      }
    }).filter(function(item) {
      // fileIdが空の行は除外
      return item.fileId && item.fileId.length > 5;
    }).reverse();

    return { success: true, list: list };
  } catch (e) {
    logError('getNewsletterSaveList', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Web API] 保存済み学級通信のデータを読み込みます。
 * @param {string} fileId Google DriveのファイルID
 * @returns {Object} { success, data: {blocks, nextId, mondayStr} }
 */
function loadNewsletterData(fileId) {
  try {
    if (!fileId || String(fileId).length < 5) {
      return { success: false, error: 'ファイルIDが無効です' };
    }
    const file = DriveApp.getFileById(String(fileId));
    const json = file.getBlob().getDataAsString();
    const parsed = JSON.parse(json);
    // GASの google.script.run 転送サイズ上限対策:
    // 画像データ(base64)が含まれると巨大になるため、サイズチェック
    const resultStr = JSON.stringify(parsed);
    if (resultStr.length > 500000) {
      // 大きすぎる場合は直接JSONテキストを返し、クライアント側でパース
      return { success: true, jsonString: resultStr };
    }
    return { success: true, data: parsed };
  } catch (e) {
    logError('loadNewsletterData', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Web API] 保存済み学級通信を削除します。
 * @param {number} rowIndex シートの行番号
 * @param {string} fileId Google DriveのファイルID
 * @returns {Object} { success }
 */
function deleteNewsletterData(rowIndex, fileId) {
  try {
    const ss = getSs_();
    const sheet = ss.getSheetByName(SHEET_NAME_NEWSLETTER_DATA);
    if (sheet && rowIndex >= 2) sheet.deleteRow(rowIndex);
    try { DriveApp.getFileById(fileId).setTrashed(true); } catch(ignore) {}
    return { success: true };
  } catch (e) {
    logError('deleteNewsletterData', e);
    return { success: false, error: e.message };
  }
}

// ===================================================
// ===== 固定時間割エディタ API (Phase 4 Step 1-2) =====
// ===================================================

const SP_KEY_TIMETABLE = 'fixedTimetableData';

/**
 * [エディタ API] 固定時間割データを取得します。
 */
function getTimetableForEditor() {
  try {
    const props = PropertiesService.getScriptProperties();
    const savedJson = props.getProperty(SP_KEY_TIMETABLE);

    if (savedJson) {
      return { success: true, data: JSON.parse(savedJson) };
    }

    // デフォルト空データ
    const emptyData = [0, 1, 2, 3, 4].map(d => ({
      day: d, time: '', morning: '', periods: ['', '', '', '', '', '']
    }));
    return { success: true, data: emptyData };
  } catch (e) {
    logError('getTimetableForEditor', e);
    return { success: false, error: e.message };
  }
}

/**
 * [エディタ API] 固定時間割データをスクリプトプロパティに保存します。
 * @param {Array} timetableData - エディタから送られる固定時間割データ (5要素の配列)
 */
function saveTimetableFromEditor(timetableData) {
  try {
    if (!timetableData || !Array.isArray(timetableData) || timetableData.length !== 5) {
      throw new Error('無効な時間割データです。');
    }

    // 教科セルの検証: 転記によってデータベースの教科セルに入るため、ここでも分数合計=1を強制する
    const DAY_LABELS = ['月', '火', '水', '木', '金'];
    const errors = [];
    timetableData.forEach((dayData, d) => {
      const periods = (dayData && Array.isArray(dayData.periods)) ? dayData.periods : [];
      periods.forEach((value, p) => {
        if (!value) return;
        const check = validateSubjectCellValue_(value);
        if (!check.valid) {
          errors.push((DAY_LABELS[d] || d) + '曜 ' + (p + 1) + '校時「' + value + '」: ' + check.message);
        }
      });
    });
    if (errors.length > 0) {
      throw new Error('教科名の入力に誤りがあるため保存できません。\n' + errors.join('\n'));
    }

    PropertiesService.getScriptProperties().setProperty(SP_KEY_TIMETABLE, JSON.stringify(timetableData));

    return { success: true, message: '固定時間割を保存しました。' };
  } catch (e) {
    logError('saveTimetableFromEditor', e);
    return { success: false, error: e.message };
  }
}

/**
 * [エディタ API] 指定された週に固定時間割を転記します。
 * @param {string} mondayStr - 転記先の月曜日の日付文字列
 */
function applyTimetableToWeek(mondayStr) {
  try {
    if (!mondayStr) throw new Error('対象週が指定されていません。');
    const targetDate = new Date(mondayStr.replace(/-/g, '/'));
    transferWeeklyTimetable(targetDate);
    return { success: true, message: mondayStr + ' 週に固定時間割を転記しました。' };
  } catch (e) {
    logError('applyTimetableToWeek', e);
    return { success: false, error: e.message };
  }
}

// ===================================================
// ===== Phase 5: シート削除・保護 =====
// ===================================================

/**
 * 残存シートを保護します。
 * メニューから実行されることを想定しています。
 */
function protectSheets() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert(
    'シート保護の実行',
    '以下のシートを保護します。\n\n' +
    '「データベース」「単元マスタ」「ログ」「学級通信」\n\n' +
    '実行しますか？',
    ui.ButtonSet.YES_NO
  );

  if (response !== ui.Button.YES) {
    ui.alert('キャンセルしました。');
    return;
  }

  const results = protectSheets_core_();
  ui.alert('完了', results.join('\n'), ui.ButtonSet.OK);
  logInfo('シート保護完了:\n' + results.join('\n'));
}

/**
 * 主要シートを保護するコアロジック。UI非依存。処理結果メッセージの配列を返します。
 * @returns {string[]}
 */
function protectSheets_core_() {
  const ss = typeof getSs_ === 'function' ? getSs_() : SpreadsheetApp.getActiveSpreadsheet();
  const results = [];

  const sheetsToProtect = [
    SHEET_NAME_DATABASE, SHEET_NAME_UNIT_MASTER, SHEET_NAME_LOG,
    SHEET_NAME_NEWSLETTER
  ];
  const owner = Session.getEffectiveUser();

  sheetsToProtect.forEach(name => {
    try {
      const sheet = ss.getSheetByName(name);
      if (sheet) {
        sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(p => p.remove());

        const protection = sheet.protect().setDescription(`${name} (自動保護)`);
        protection.addEditor(owner);
        protection.removeEditors(protection.getEditors().filter(u => u.getEmail() !== owner.getEmail()));
        if (protection.canDomainEdit()) {
          protection.setDomainEdit(false);
        }
        results.push(`「${name}」シートを保護しました。`);
        logInfo(`「${name}」シートを保護しました。`);
      } else {
        results.push(`「${name}」シートが見つかりません（スキップ）。`);
      }
    } catch (e) {
      results.push(`「${name}」シートの保護に失敗: ${e.message}`);
      logError(`シート保護失敗 (${name})`, e);
    }
  });

  return results;
}

/**
 * [Webアプリ API] 主要シートを保護します（確認はフロント側で実施・結果を返す）。
 * @returns {{success: boolean, message: string}}
 */
function protectSheetsFromWeb() {
  try {
    const results = protectSheets_core_();
    logInfo('シート保護完了(Web):\n' + results.join('\n'));
    return { success: true, message: results.join('\n') };
  } catch (e) {
    logError("protectSheetsFromWeb", e);
    return { success: false, message: `シート保護エラー: ${e.message}` };
  }
}

/**
 * [Webアプリ API] データベース列構成等のキャッシュをクリアします（結果を返す）。
 * @returns {{success: boolean, message: string}}
 */
function clearDbColumnsCacheFromWeb() {
  try {
    clearDbColumnsCache();
    return { success: true, message: 'DB列等のキャッシュをクリアしました。' };
  } catch (e) {
    logError("clearDbColumnsCacheFromWeb", e);
    return { success: false, message: `キャッシュクリアエラー: ${e.message}` };
  }
}

// ===================================================
// ===== 祝日データ管理 =====
// ===================================================

const SP_KEY_HOLIDAYS = 'holidayDates';

/**
 * 内閣府CSVから祝日データを取得し、スクリプトプロパティに保存します。
 * onOpenトリガーやメニューから呼び出し可能。
 */
function fetchAndStoreHolidays() {
  try {
    const url = 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv';
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      logInfo('祝日CSVの取得に失敗 (HTTP ' + response.getResponseCode() + ')');
      return;
    }
    const csvText = response.getContentText('Shift_JIS');
    const lines = csvText.split('\n');
    const holidays = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const parts = line.split(',');
      if (parts.length >= 2) {
        holidays.push({ date: parts[0].trim(), name: parts[1].trim() });
      }
    }
    PropertiesService.getScriptProperties().setProperty(SP_KEY_HOLIDAYS, JSON.stringify(holidays));
    logInfo('祝日データを更新しました (' + holidays.length + '件)');
  } catch (e) {
    logError('fetchAndStoreHolidays', e);
  }
}

/**
 * [Webアプリ API] 保存済みの祝日データを返します。
 */
function getHolidays() {
  try {
    const json = PropertiesService.getScriptProperties().getProperty(SP_KEY_HOLIDAYS);
    if (json) return { success: true, data: JSON.parse(json) };
    // まだ取得していなければ取得して返す
    fetchAndStoreHolidays();
    const json2 = PropertiesService.getScriptProperties().getProperty(SP_KEY_HOLIDAYS);
    return { success: true, data: json2 ? JSON.parse(json2) : [] };
  } catch (e) {
    logError('getHolidays', e);
    return { success: false, error: e.message };
  }
}

// ===================================================
// ===== 教科別標準時数管理 =====
// ===================================================

const SP_KEY_STANDARD_HOURS = 'standardHoursBySubject';

/**
 * 学年別の標準時数マスタデータを取得します。
 */
function getStandardHoursMaster(grade) {
  const master = {
    1: [
      { subject: '国語', hours: 306 }, { subject: '算数', hours: 136 },
      { subject: '生活', hours: 102 }, { subject: '音楽', hours: 68 },
      { subject: '図画工作', hours: 68 }, { subject: '体育', hours: 102 },
      { subject: '道徳', hours: 34 }, { subject: '特活', hours: 34 }
    ],
    2: [
      { subject: '国語', hours: 315 }, { subject: '算数', hours: 175 },
      { subject: '生活', hours: 105 }, { subject: '音楽', hours: 70 },
      { subject: '図画工作', hours: 70 }, { subject: '体育', hours: 105 },
      { subject: '道徳', hours: 35 }, { subject: '特活', hours: 35 }
    ],
    3: [
      { subject: '国語', hours: 245 }, { subject: '社会', hours: 70 },
      { subject: '算数', hours: 175 }, { subject: '理科', hours: 90 },
      { subject: '音楽', hours: 60 }, { subject: '図画工作', hours: 60 },
      { subject: '体育', hours: 105 }, { subject: '道徳', hours: 35 },
      { subject: '外国語活動', hours: 35 }, { subject: '総合', hours: 70 },
      { subject: '特活', hours: 35 }
    ],
    4: [
      { subject: '国語', hours: 245 }, { subject: '社会', hours: 90 },
      { subject: '算数', hours: 175 }, { subject: '理科', hours: 105 },
      { subject: '音楽', hours: 60 }, { subject: '図画工作', hours: 60 },
      { subject: '体育', hours: 105 }, { subject: '道徳', hours: 35 },
      { subject: '外国語活動', hours: 35 }, { subject: '総合', hours: 70 },
      { subject: '特活', hours: 35 }
    ],
    5: [
      { subject: '国語', hours: 175 }, { subject: '社会', hours: 100 },
      { subject: '算数', hours: 175 }, { subject: '理科', hours: 105 },
      { subject: '音楽', hours: 50 }, { subject: '図画工作', hours: 50 },
      { subject: '家庭', hours: 60 }, { subject: '体育', hours: 90 },
      { subject: '道徳', hours: 35 }, { subject: '外国語', hours: 70 },
      { subject: '総合', hours: 70 }, { subject: '特活', hours: 35 }
    ],
    6: [
      { subject: '国語', hours: 175 }, { subject: '社会', hours: 105 },
      { subject: '算数', hours: 175 }, { subject: '理科', hours: 105 },
      { subject: '音楽', hours: 50 }, { subject: '図画工作', hours: 50 },
      { subject: '家庭', hours: 55 }, { subject: '体育', hours: 90 },
      { subject: '道徳', hours: 35 }, { subject: '外国語', hours: 70 },
      { subject: '総合', hours: 70 }, { subject: '特活', hours: 35 }
    ]
  };
  return master[grade] || master[3];
}

/**
 * [Webアプリ API] 担当学年を設定し、標準時数を初期化します。
 */
function saveGrade(gradeNum) {
  try {
    const props = PropertiesService.getScriptProperties();
    props.setProperty(SCRIPT_PROP_GRADE, gradeNum.toString());
    
    // 学年変更に伴い、標準時数をその学年のマスタで上書きする
    const newStandardHours = getStandardHoursMaster(gradeNum);
    props.setProperty(SP_KEY_STANDARD_HOURS, JSON.stringify(newStandardHours));
    
    return { success: true, message: gradeNum + '年生の設定を適用しました。', data: newStandardHours };
  } catch (e) {
    logError('saveGrade', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 現在の担当学年を取得します。
 */
function getGrade() {
  try {
    const props = PropertiesService.getScriptProperties();
    const grade = props.getProperty(SCRIPT_PROP_GRADE) || "3"; // デフォルト3年
    return { success: true, grade: parseInt(grade, 10) };
  } catch (e) {
    logError('getGrade', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 教科別標準時数データを取得します。
 */
function getStandardHours() {
  try {
    const props = PropertiesService.getScriptProperties();
    const saved = props.getProperty(SP_KEY_STANDARD_HOURS);
    if (saved) return { success: true, data: JSON.parse(saved) };

    const grade = props.getProperty(SCRIPT_PROP_GRADE) || "3";
    const defaults = getStandardHoursMaster(grade);
    
    return { success: true, data: defaults };
  } catch (e) {
    logError('getStandardHours', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 教科別標準時数データを保存します。
 */
function saveStandardHours(data) {
  try {
    if (!data || !Array.isArray(data)) throw new Error('無効なデータ');
    PropertiesService.getScriptProperties().setProperty(SP_KEY_STANDARD_HOURS, JSON.stringify(data));
    return { success: true, message: '標準時数を保存しました。' };
  } catch (e) {
    logError('saveStandardHours', e);
    return { success: false, error: e.message };
  }
}

// ===================================================
// ===== 時数集計 API =====
// ===================================================

/**
 * [Webアプリ API] 指定週までの時数集計を返します。
 * 週案シートのCOUNTIF+QUERY数式を再現（1/3, 2/3対応）。
 * @param {string} mondayStr - 対象週の月曜日
 */
function getHoursSummary(mondayStr) {
  try {
    const ss = getSs_();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');

    const dbCols = getDbColumns();
    const dbData = dbSheet.getDataRange().getValues();

    // モジュール学習設定
    const moduleEnabled = PropertiesService.getScriptProperties().getProperty('moduleEnabled') === 'true';

    // 対象週の月曜日
    const targetMonday = new Date(mondayStr.replace(/-/g, '/'));
    targetMonday.setHours(0,0,0,0);
    const targetFriday = new Date(targetMonday);
    targetFriday.setDate(targetFriday.getDate() + 4);

    // 教科列のインデックス（1校時〜6校時）
    const periodCols = [dbCols.PERIOD1, dbCols.PERIOD2, dbCols.PERIOD3, dbCols.PERIOD4, dbCols.PERIOD5, dbCols.PERIOD6].filter(c => c);

    // 当週と累計を集計
    const weeklyCount = {};
    const cumulativeCount = {};

    for (let i = 1; i < dbData.length; i++) {
      const rowDate = dbData[i][dbCols.DATE - 1];
      if (!(rowDate instanceof Date)) continue;
      const d = new Date(rowDate);
      d.setHours(0,0,0,0);

      // 累計: 最初〜対象週の金曜まで
      const isCumulative = d <= targetFriday;
      // 当週: 月曜〜金曜
      const isThisWeek = d >= targetMonday && d <= targetFriday;

      if (!isCumulative) continue;

      periodCols.forEach(col => {
        const parsed = parseSubjectHours_(dbData[i][col - 1]);
        for (const { subject, fraction } of parsed) {
          if (!cumulativeCount[subject]) cumulativeCount[subject] = 0;
          cumulativeCount[subject] += fraction;

          if (isThisWeek) {
            if (!weeklyCount[subject]) weeklyCount[subject] = 0;
            weeklyCount[subject] += fraction;
          }
        }
      });

      // モジュール学習: 朝学習に教科名が入っていれば 1/3 時間を加算
      if (moduleEnabled && dbCols.MORNING) {
        const morningVal = (dbData[i][dbCols.MORNING - 1] || '').toString().trim();
        if (morningVal && !/^\d/.test(morningVal)) {
          // 分数付き入力（例: "国語1/3行事2/3"）でも先頭の教科名だけを正しく取り出す
          const morningEntries = parseSubjectCell_(morningVal).entries;
          const morningSubject = morningEntries.length > 0 ? morningEntries[0].subject : '';
          if (morningSubject) {
            const moduleFraction = 1 / 3;
            if (!cumulativeCount[morningSubject]) cumulativeCount[morningSubject] = 0;
            cumulativeCount[morningSubject] += moduleFraction;
            if (isThisWeek) {
              if (!weeklyCount[morningSubject]) weeklyCount[morningSubject] = 0;
              weeklyCount[morningSubject] += moduleFraction;
            }
          }
        }
      }
    }

    // 表示用の教科名集約: 学活→特活、図書・書写→国語に合算
    aggregateSubjectCounts_(weeklyCount);
    aggregateSubjectCounts_(cumulativeCount);

    // 標準時数を取得
    const stdResult = getStandardHours();
    const standardHours = (stdResult.success && stdResult.data) ? stdResult.data : [];

    // 結果を構築
    const summary = standardHours.map(sh => {
      const subj = sh.subject;
      const std = sh.hours || 0;
      const weekly = Math.round((weeklyCount[subj] || 0) * 10) / 10;
      const cumulative = Math.round((cumulativeCount[subj] || 0) * 10) / 10;
      const pct = std > 0 ? Math.round(cumulative / std * 100) : 0;
      return { subject: subj, standard: std, weekly: weekly, cumulative: cumulative, percent: pct };
    });

    return { success: true, data: summary };
  } catch (e) {
    logError('getHoursSummary', e);
    return { success: false, error: e.message };
  }
}

// ===================================================
// ===== 年間カレンダー自動生成 API =====
// ===================================================

/**
 * [Webアプリ API] データベースシートの「日付」「曜日」「第何週/週番号」列を1年間分自動生成します
 * 数式依存を排除するための機能です。
 * @param {string|number} year - 対象年度 (例: 2025)
 * @param {string} startMondayStr - 第1週目の月曜日 (YYYY-MM-DD)
 */
function generateAnnualCalendar(year, startMondayStr) {
  try {
    const ss = getSs_();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');

    const dbCols = getDbColumns();
    if (!dbCols.DATE || !dbCols.DAY_OF_WEEK || !dbCols.WEEK_NUM) {
      throw new Error('データベースシートに必要な列（日付、曜日、週番号）が見つかりません');
    }

    // 1行目はヘッダーなので2行目から開始
    const startRow = 2;
    // シートの現在の最終行。カレンダー生成によってこれより伸びる可能性がある
    const lastRow = Math.max(dbSheet.getLastRow(), startRow);
    const lastCol = dbSheet.getLastColumn();

    // 既存データを全取得してマージベースを作成する
    const existingData = dbSheet.getRange(startRow, 1, lastRow - startRow + 1, lastCol).getValues();
    
    // 生成の起点日
    let currentDate = new Date(startMondayStr.replace(/-/g, '/'));
    currentDate.setHours(0, 0, 0, 0);

    const DAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];
    
    // 365日分（余裕を持って370日分）を生成
    const totalDays = 370;
    
    // 更新用の配列（行数は既存データ or 370日の多い方に合わせる）
    const mergeRowCount = Math.max(existingData.length, totalDays);
    const newData = [];

    let currentWeekNum = 1;

    for (let i = 0; i < mergeRowCount; i++) {
      // 既存の行データをベースにする（なければ空配列を作成して幅を合わせる）
      let row = existingData[i] ? [...existingData[i]] : new Array(lastCol).fill('');
      
      if (i < totalDays) {
        // カレンダー生成対象の行
        const d = new Date(currentDate);
        
        // 週番号の計算 (月曜日ごとにカウントアップ)
        if (i > 0 && d.getDay() === 1) {
          currentWeekNum++;
        }

        row[dbCols.DATE - 1] = d; // 日付オブジェクトをそのままセット
        row[dbCols.DAY_OF_WEEK - 1] = DAY_LABELS[d.getDay()]; // 曜日
        row[dbCols.WEEK_NUM - 1] = currentWeekNum; // 第何週

        // 次の日へ
        currentDate.setDate(currentDate.getDate() + 1);
      } else {
        // 370日以降かつ既存行がある場合、カレンダー列はクリアする（あるいは既存を維持する）
        // 古い年度の余分な日付が残らないよう、カレンダー系はクリア
        row[dbCols.DATE - 1] = '';
        row[dbCols.DAY_OF_WEEK - 1] = '';
        row[dbCols.WEEK_NUM - 1] = '';
      }
      newData.push(row);
    }

    // まとめて一括書き込み
    dbSheet.getRange(startRow, 1, newData.length, lastCol).setValues(newData);

    return { success: true, message: `${year}年度のカレンダー（${totalDays}日分）を生成しました。` };
  } catch (e) {
    logError('generateAnnualCalendar', e);
    return { success: false, error: e.message };
  }
}

// ===================================================
// ===== タスク管理（TODO自動抽出） WebApp API (Phase 6)
// ===================================================

/**
 * [Webアプリ API] タスク一覧を取得します
 * @returns {Object} { success: boolean, tasks: Object[] }
 */
function getTasksFromWebApp() {
  try {
    const tasks = getTaskData();
    return { success: true, tasks: tasks };
  } catch (e) {
    logError('getTasksFromWebApp', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 新しいタスク（複数可）を一括保存します
 * @param {Object[]} tasks 保存するタスクの配列
 * @returns {Object} { success: boolean, message: string, savedTasks: Object[] }
 */
function saveTasksFromWebApp(tasks) {
  try {
    // ID未設定のタスクにIDを事前付与（フロントに返却するため）
    var savedTasks = tasks.map(function(t) {
      return {
        id: t.id || 'tsk_' + Utilities.getUuid().split('-')[0],
        content: t.content || '',
        resource: t.resource || '',
        dueDate: t.dueDate || '',
        source: t.source || '',
        status: t.status || '未着手'
      };
    });
    var isSuccess = saveTasksBulk(savedTasks);
    if (isSuccess) {
      return { success: true, message: savedTasks.length + '件のタスクを保存しました', savedTasks: savedTasks };
    } else {
      throw new Error('タスクの保存に失敗しました');
    }
  } catch (e) {
    logError('saveTasksFromWebApp', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] タスクのフィールド（内容・準備物・期日）を更新します
 * @param {string} taskId
 * @param {Object} updates { content, resource, dueDate }
 * @returns {Object} { success: boolean }
 */
function updateTaskFromWebApp(taskId, updates) {
  try {
    validateParams_({ taskId }, {
      taskId: { type: 'string', required: true, maxLength: 100 }
    });
    var isSuccess = updateTask(taskId, updates);
    return { success: isSuccess };
  } catch (e) {
    logError('updateTaskFromWebApp', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] タスクのステータス（未着手/完了）を更新します
 * @param {string} taskId
 * @param {string} newStatus 
 * @returns {Object} { success: boolean }
 */
function updateTaskStatusFromWebApp(taskId, newStatus) {
  try {
    validateParams_({ taskId, newStatus }, {
      taskId: { type: 'string', required: true, maxLength: 100 },
      newStatus: { type: 'string', required: true, pattern: /^(未着手|完了)$/ }
    });
    const isSuccess = updateTaskStatus(taskId, newStatus);
    return { success: isSuccess };
  } catch (e) {
    logError('updateTaskStatusFromWebApp', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] タスクを削除します
 * @param {string} taskId 
 * @returns {Object} { success: boolean }
 */
function deleteTaskFromWebApp(taskId) {
  try {
    validateParams_({ taskId }, {
      taskId: { type: 'string', required: true, maxLength: 100 }
    });
    const isSuccess = deleteTask(taskId);
    return { success: isSuccess };
  } catch (e) {
    logError('deleteTaskFromWebApp', e);
    return { success: false, error: e.message };
  }
}

// ===================================================
// ===== 単元マスタ管理 WebApp API =====
// ===================================================

/**
 * [Webアプリ API] 単元マスタの全データを取得します
 * @returns {Object} { success, rows: [{subject, unitName, totalHours, hourNum, activity, rowIndex}], subjects: string[] }
 */
function getUnitMasterData() {
  try {
    const ss = getSs_();
    const sheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
    if (!sheet) return { success: true, rows: [], subjects: [] };

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, rows: [], subjects: [] };

    const data = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
    const subjectSet = new Set();
    const rows = [];

    for (let i = 0; i < data.length; i++) {
      const r = data[i];
      const subject = r[MASTER_COL_SUBJECT - 1] || '';
      if (subject) subjectSet.add(subject);
      rows.push({
        rowIndex: i + 2, // シート上の実際の行番号(1-based)
        subject: subject,
        unitName: r[MASTER_COL_UNIT_NAME - 1] || '',
        totalHours: r[MASTER_COL_TOTAL_HOURS - 1] || '',
        hourNum: r[MASTER_COL_HOUR_NUM - 1] || '',
        activity: r[MASTER_COL_ACTIVITY - 1] || ''
      });
    }

    return { success: true, rows: rows, subjects: [...subjectSet] };
  } catch (e) {
    logError('getUnitMasterData', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 単元マスタの指定行を更新します
 * @param {number} rowIndex シート上の行番号 (1-based)
 * @param {Object} data {subject, unitName, totalHours, hourNum, activity}
 * @returns {Object} { success: boolean }
 */
function updateUnitMasterRow(rowIndex, data) {
  try {
    validateParams_({ rowIndex }, {
      rowIndex: { type: 'number', required: true, min: 2 }
    });
    const ss = getSs_();
    const sheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
    if (!sheet) throw new Error('単元マスタシートが見つかりません');

    sheet.getRange(rowIndex, 1, 1, 5).setValues([[
      data.subject || '',
      data.unitName || '',
      data.totalHours || '',
      data.hourNum || '',
      data.activity || ''
    ]]);

    return { success: true };
  } catch (e) {
    logError('updateUnitMasterRow', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 単元マスタの指定位置に新しい行を挿入します
 * @param {number} afterRowIndex この行の後に挿入 (1-based)。0の場合はヘッダー直後(2行目)に挿入
 * @param {Object} data {subject, unitName, totalHours, hourNum, activity}
 * @returns {Object} { success: boolean, newRowIndex: number }
 */
function insertUnitMasterRow(afterRowIndex, data) {
  try {
    const ss = getSs_();
    const sheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
    if (!sheet) throw new Error('単元マスタシートが見つかりません');

    const insertAt = afterRowIndex > 0 ? afterRowIndex + 1 : 2;
    sheet.insertRowBefore(insertAt);
    sheet.getRange(insertAt, 1, 1, 5).setValues([[
      data.subject || '',
      data.unitName || '',
      data.totalHours || '',
      data.hourNum || '',
      data.activity || ''
    ]]);

    return { success: true, newRowIndex: insertAt };
  } catch (e) {
    logError('insertUnitMasterRow', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 単元マスタの指定行を削除します
 * @param {number} rowIndex シート上の行番号 (1-based)
 * @returns {Object} { success: boolean }
 */
function deleteUnitMasterRow(rowIndex) {
  try {
    validateParams_({ rowIndex }, {
      rowIndex: { type: 'number', required: true, min: 2 }
    });
    const ss = getSs_();
    const sheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
    if (!sheet) throw new Error('単元マスタシートが見つかりません');
    sheet.deleteRow(rowIndex);
    return { success: true };
  } catch (e) {
    logError('deleteUnitMasterRow', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 単元マスタの複数行を一括更新します
 * @param {Object[]} updates [{rowIndex, data: {subject, unitName, totalHours, hourNum, activity}}]
 * @returns {Object} { success: boolean, count: number }
 */
function batchUpdateUnitMaster(updates) {
  try {
    validateParams_({ updates }, { updates: { required: true, isArray: true } });
    const ss = getSs_();
    const sheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
    if (!sheet) throw new Error('単元マスタシートが見つかりません');

    if (updates.length === 0) return { success: true, count: 0 };

    // パフォーマンス: シート全体を一括読み込み→メモリ上で更新→一括書き込み
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, count: 0 };
    const allData = sheet.getRange(1, 1, lastRow, 5).getValues();

    let count = 0;
    for (const u of updates) {
      if (u.rowIndex >= 2 && u.rowIndex <= lastRow) {
        const rowIdx = u.rowIndex - 1;
        allData[rowIdx] = [
          u.data.subject || '',
          u.data.unitName || '',
          u.data.totalHours || '',
          u.data.hourNum || '',
          u.data.activity || ''
        ];
        count++;
      }
    }

    if (count > 0) {
      sheet.getRange(1, 1, lastRow, 5).setValues(allData);
    }

    return { success: true, count: count };
  } catch (e) {
    logError('batchUpdateUnitMaster', e);
    return { success: false, error: e.message };
  }
}
