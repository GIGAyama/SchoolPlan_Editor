/**
 * @fileoverview 共通利用される便利関数（日付処理、API呼び出し、ログ出力関連）
 */

// ============================================================
// ===== 入力バリデーション =====
// ============================================================

/**
 * 日付文字列が "yyyy/MM/dd" 形式であることを検証します。
 * @param {string} dateStr
 * @returns {boolean}
 */
function isValidDateStr_(dateStr) {
  if (typeof dateStr !== 'string') return false;
  return /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(dateStr);
}

/**
 * 日付文字列が "yyyy-MM-dd" 形式であることを検証します。
 * @param {string} dateStr
 * @returns {boolean}
 */
function isValidIsoDateStr_(dateStr) {
  if (typeof dateStr !== 'string') return false;
  return /^\d{4}-\d{1,2}-\d{1,2}$/.test(dateStr);
}

/**
 * API入力パラメータのバリデーション。不正な場合はエラーをスローします。
 * @param {Object} params 検証するパラメータオブジェクト
 * @param {Object} rules バリデーションルール { paramName: { type, required, pattern, maxLength } }
 */
function validateParams_(params, rules) {
  for (const [name, rule] of Object.entries(rules)) {
    const value = params[name];

    if (rule.required && (value === undefined || value === null || value === '')) {
      throw new Error(`パラメータ「${name}」は必須です。`);
    }

    if (value === undefined || value === null || value === '') continue;

    if (rule.type && typeof value !== rule.type) {
      throw new Error(`パラメータ「${name}」の型が不正です。（期待: ${rule.type}、実際: ${typeof value}）`);
    }

    if (rule.pattern && typeof value === 'string' && !rule.pattern.test(value)) {
      throw new Error(`パラメータ「${name}」の形式が不正です。`);
    }

    if (rule.maxLength && typeof value === 'string' && value.length > rule.maxLength) {
      throw new Error(`パラメータ「${name}」が長すぎます。（上限: ${rule.maxLength}文字）`);
    }

    if (rule.isArray && !Array.isArray(value)) {
      throw new Error(`パラメータ「${name}」は配列である必要があります。`);
    }

    if (rule.min !== undefined && typeof value === 'number' && value < rule.min) {
      throw new Error(`パラメータ「${name}」は${rule.min}以上である必要があります。`);
    }

    if (rule.max !== undefined && typeof value === 'number' && value > rule.max) {
      throw new Error(`パラメータ「${name}」は${rule.max}以下である必要があります。`);
    }
  }
}

// ============================================================
// ===== 日付処理ヘルパー関数 =====
// ============================================================

/** 
 * 二つの日付が、年月日すべて同じ日であるかを判定します。 
 */
function isSameDate(date1, date2) { 
  if (!(date1 instanceof Date) || !(date2 instanceof Date)) return false;
  return date1.getFullYear() === date2.getFullYear() && 
         date1.getMonth() === date2.getMonth() && 
         date1.getDate() === date2.getDate(); 
}

/** 
 * ある日付が、指定された開始日と終了日の範囲内に含まれているかを判定します。 
 */
function isDateInRange(date, startDate, endDate) { 
  if (!(date instanceof Date) || !(startDate instanceof Date) || !(endDate instanceof Date)) return false;
  const d = new Date(date); 
  d.setHours(0, 0, 0, 0); 
  return d.getTime() >= startDate.getTime() && d.getTime() <= endDate.getTime(); 
}

/** 
 * 日付を「yyyy/MM/dd」形式の文字列に変換します。 
 */
function formatDate(date) { 
  if (!(date instanceof Date)) return ""; 
  return Utilities.formatDate(date, "JST", "yyyy/MM/dd"); 
}

/** 
 * 指定された日付が含まれる週の、月曜日の日付を算出します。 
 */
function getMondayOfWeek(date) { 
  if (!(date instanceof Date)) return null;
  const d = new Date(date); 
  d.setHours(0, 0, 0, 0); 
  const day = d.getDay(); 
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); 
  return new Date(d.setDate(diff)); 
}

/** 
 * データベースシートの中から、指定された日付が入力されている行の番号を探し出します。 
 */
function findRowIndexByDate(sheet, dateToSearch) {
  const dbCols = getDbColumns();
  const searchTime = getMondayOfWeek(dateToSearch).getTime();
  const dateColumnValues = sheet.getRange(2, dbCols.DATE, Math.max(1, sheet.getLastRow() - 1), 1).getValues();
  for (let i = 0; i < dateColumnValues.length; i++) {
    if (dateColumnValues[i][0] instanceof Date) {
      const cellTime = new Date(dateColumnValues[i][0]).getTime();
      if (cellTime === searchTime) return i + 2; // +2 for 1-based index and skipping header
    }
  }
  return -1;
}

// ============================================================
// ===== 外部連携 API・トリガー関連 =====
// ============================================================

/** 
 * Gemini APIキーを取得します。
 * Phase 3 移行完了後はスクリプトプロパティのみを参照します。
 * 後方互換のためこの関数名は維持し、getApiKeySafe_() に委譲します。
 */
function getApiKey_() {
  return getApiKeySafe_();
}

/**
 * 途切れたJSON配列テキストを修復し、最後の完全なオブジェクトまでを救出します。
 * @param {string} text 途切れたJSONテキスト
 * @returns {Object[]|null} 修復されたJSON配列、または修復不能の場合null
 */
function repairTruncatedJsonArray_(text) {
  try {
    const patterns = ['},\n  {', '},\n{', '}, {', '},  {', '},\n    {'];
    let bestCut = -1;
    for (const pat of patterns) {
      const idx = text.lastIndexOf(pat);
      if (idx > bestCut) bestCut = idx;
    }
    if (bestCut !== -1) {
      const attempt = text.substring(0, bestCut + 1) + "\n]";
      return JSON.parse(attempt);
    }
  } catch (e) {
    // 修復失敗
  }
  return null;
}

/**
 * Gemini API への1回の呼び出しを行い、結果と途切れ情報を返します。
 * @param {string} prompt プロンプト
 * @param {string} apiKey APIキー
 * @param {Blob[]} blobs 添付ファイル
 * @returns {{ data: Object, isTruncated: boolean }}
 */
function callGeminiApiRaw_(prompt, apiKey, blobs = []) {
  const modelName = getGeminiModelNameSafe_();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  const parts = [{ "text": prompt }];
  blobs.forEach(blob => {
    parts.push({ "inline_data": { "mime_type": blob.getContentType(), "data": Utilities.base64Encode(blob.getBytes()) } });
  });
  const payload = { "contents": [{ "parts": parts }], "generationConfig": { "response_mime_type": "application/json", "maxOutputTokens": 65536 } };
  const options = { 'method': 'post', 'contentType': 'application/json', 'payload': JSON.stringify(payload), 'muteHttpExceptions': true };

  const response = UrlFetchApp.fetch(url, options);
  const responseCode = response.getResponseCode();
  const responseBody = response.getContentText();

  if (responseCode === 200) {
    const jsonResponse = JSON.parse(responseBody);
    const finishReason = (jsonResponse.candidates && jsonResponse.candidates[0])
      ? jsonResponse.candidates[0].finishReason : null;
    const isTruncated = (finishReason === 'MAX_TOKENS');

    if (jsonResponse.candidates && jsonResponse.candidates[0] && jsonResponse.candidates[0].content && jsonResponse.candidates[0].content.parts) {
      const text = jsonResponse.candidates[0].content.parts[0].text;
      try {
        return { data: JSON.parse(text), isTruncated };
      } catch (e) {
        // isTruncated でない場合のみエラーログ（途切れの場合は想定内）
        if (!isTruncated) {
          logError("Gemini APIからのJSONレスポンスのパースに失敗しました。", e);
        }
        logInfo(`パースに失敗したテキスト(最初の1000文字): ${text.substring(0, 1000)} ...`);

        // 途切れたJSONの修復を試みる
        logInfo("途切れたJSONの修復と救出を試みます...");
        const repaired = repairTruncatedJsonArray_(text);
        if (repaired !== null) {
          logInfo(`修復に成功しました！${repaired.length}件のデータを救出。`);
          return { data: repaired, isTruncated: true };
        }

        logError("JSONの修復にも失敗しました。", e);
        throw new Error("Gemini APIのレスポンスをJSONとして解析できませんでした。出力が途切れている可能性があります。");
      }
    } else {
      // candidatesが空の場合はsafety filterでブロックされた可能性
      let reason = "不明";
      if (jsonResponse.candidates && jsonResponse.candidates[0] && jsonResponse.candidates[0].finishReason) {
        reason = jsonResponse.candidates[0].finishReason;
      } else if (jsonResponse.promptFeedback && jsonResponse.promptFeedback.blockReason) {
        reason = jsonResponse.promptFeedback.blockReason;
      }
      logError(`Gemini APIからのレスポンス形式が不正です。理由: ${reason}`, new Error(responseBody));
      throw new Error(`Gemini APIから有効なレスポンスが得られませんでした（理由: ${reason}）。PDFの内容を確認してください。`);
    }
  } else {
    const errDetail = (() => {
      try { return JSON.parse(responseBody).error?.message || responseBody.substring(0, 500); } catch(e) { return responseBody.substring(0, 500); }
    })();
    logError(`Gemini API Error (Code: ${responseCode})`, new Error(errDetail));
    if (responseCode === 429) {
      throw new Error('AI APIのリクエスト制限に達しました。しばらく待ってから再度お試しください。');
    } else if (responseCode === 401 || responseCode === 403) {
      throw new Error('AI APIキーが無効または期限切れです。設定画面でAPIキーを確認してください。');
    }
    throw new Error(`Gemini APIとの通信に失敗しました。（HTTP ${responseCode}）`);
  }
}

/**
 * Gemini APIに送信してAIによる分析を依頼します（単発呼び出し・後方互換ラッパー）。
 */
function callGeminiApi_(prompt, apiKey, blobs = []) {
  const { data } = callGeminiApiRaw_(prompt, apiKey, blobs);
  return data;
}

/**
 * 大量データ向けのGemini API呼び出し。出力がトークン上限で途切れた場合、
 * 継続プロンプトを自動生成して残りのデータを取得します。
 * @param {string} basePrompt 最初のプロンプト
 * @param {string} apiKey APIキー
 * @param {Blob[]} blobs 添付ファイル
 * @param {function(Object[]): string} buildContinuationPrompt 取得済みデータから継続用プロンプトを生成する関数
 * @returns {Object[]} 結合されたすべての結果配列
 */
function callGeminiApiChunked_(basePrompt, apiKey, blobs, buildContinuationPrompt) {
  let allResults = [];
  let prompt = basePrompt;
  const MAX_ROUNDS = 10;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { data, isTruncated } = callGeminiApiRaw_(prompt, apiKey, blobs);

    if (data && Array.isArray(data)) {
      allResults = allResults.concat(data);
      logInfo(`API呼び出し ${round + 1}回目: ${data.length}件取得（累計: ${allResults.length}件）`);
    }

    if (!isTruncated) break;

    if (!data || data.length === 0) {
      logInfo("出力が途切れましたが、救出できるデータがありませんでした。処理を終了します。");
      break;
    }

    logInfo(`出力トークン上限に達したため、継続リクエストを送信します（${round + 1}回目完了、累計${allResults.length}件）`);
    prompt = buildContinuationPrompt(allResults);
  }

  return allResults;
}

/**
 * キュー型バックグラウンド処理（PDF読込など）のトリガーを再スケジュールします。
 * 既存トリガーを削除した上で、この実行の経過時間が5分未満なら即時(after 1秒)、
 * 5分以上経過していれば5分間隔に切り替え、実行時間制限による中断からの再開を図ります。
 * @param {string} triggerName 対象のトリガー関数名
 * @param {Date} startTime この実行の開始時刻
 * @param {string} [resumeLogMessage] 5分超過時に出力するログメッセージ
 */
function rescheduleQueueTrigger_(triggerName, startTime, resumeLogMessage) {
  deleteTriggers_(triggerName);
  const elapsedMinutes = (new Date() - startTime) / 1000 / 60;
  if (elapsedMinutes < 5) {
    ScriptApp.newTrigger(triggerName).timeBased().after(1000).create();
  } else {
    if (resumeLogMessage) logInfo(resumeLogMessage);
    ScriptApp.newTrigger(triggerName).timeBased().everyMinutes(5).create();
  }
}

/**
 * 指定された名前のトリガーをすべて削除するヘルパー関数です。
 */
function deleteTriggers_(functionName) {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === functionName) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

// ============================================================
// ===== ログ出力関連 =====
// ============================================================

/** 
 * 「ログ」シートに情報（INFO）を記録します。 
 */
function logInfo(message) { writeToLog_("INFO", message); }

/** 
 * 「ログ」シートにエラー（ERROR）を記録します。 
 */
function logError(message, error) {
  const detail = error instanceof Error
    ? `${error.message}\nスタックトレース: ${error.stack || '(なし)'}`
    : String(error);
  writeToLog_("ERROR", `${message}\nエラー詳細: ${detail}`);
}

/** 
 * ログシート書き込みの共通処理 
 */
function writeToLog_(level, message) {
  try {
    const ss = typeof getSs_ === 'function' ? getSs_() : SpreadsheetApp.getActiveSpreadsheet();
    let logSheet = ss.getSheetByName(SHEET_NAME_LOG);
    if (!logSheet) {
      logSheet = ss.insertSheet(SHEET_NAME_LOG, ss.getSheets().length);
      logSheet.getRange("A1:C1").setValues([["日時", "レベル", "メッセージ"]]).setFontWeight("bold");
    }
    // appendRow は直感的ですが、高速化のためgetLastRowを使用（API呼び出しを減らしてもよいが、ログは都度更新が必要）
    logSheet.appendRow([new Date(), level, String(message).substring(0, 30000)]);
  } catch (e) {
    console.error(`ログシートへの書き込みに失敗: ${e.message}`);
    console.error(`元のログ: [${level}] ${message}`);
  }
}

// ============================================================
// ===== クリーニング・保守関連 =====
// ============================================================

/**
 * 孤立した非同期処理トリガーを掃除します（毎晩実行される想定）
 */
function cleanupOrphanedTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  const allowedFunctions = [
    TRIGGER_FUNCTION_NAME,
    TRIGGER_FUNCTION_NAME_EVENT,
    "postScheduleToClassroom",
    "cleanupOrphanedTriggers"
  ];

  let deletedCount = 0;
  triggers.forEach(trigger => {
    const handlerName = trigger.getHandlerFunction();
    if (!allowedFunctions.includes(handlerName)) {
      // 想定外のトリガーがあれば削除
      ScriptApp.deleteTrigger(trigger);
      deletedCount++;
    } else if (handlerName === TRIGGER_FUNCTION_NAME || handlerName === TRIGGER_FUNCTION_NAME_EVENT) {
      // 特定の非同期処理用トリガーが含まれている場合、キューが空なら不要とみなす
      const props = PropertiesService.getScriptProperties();
      const isEvtQueueEmpty = !props.getProperty(SCRIPT_PROP_EVENT_PDF_QUEUE);
      const isPdfQueueEmpty = !props.getProperty(SCRIPT_PROP_PDF_QUEUE);
      
      if (handlerName === TRIGGER_FUNCTION_NAME_EVENT && isEvtQueueEmpty) {
        ScriptApp.deleteTrigger(trigger);
        deletedCount++;
      } else if (handlerName === TRIGGER_FUNCTION_NAME && isPdfQueueEmpty) {
        ScriptApp.deleteTrigger(trigger);
        deletedCount++;
      }
    }
  });

  if (deletedCount > 0) {
    logInfo(`${deletedCount}個の孤立したバックグラウンドトリガーを自動削除しました。`);
  }
}

/**
 * 保守セットアップ用のクリーナー設定関数
 */
function setupTriggerCleaner() {
  deleteTriggers_("cleanupOrphanedTriggers");
  ScriptApp.newTrigger("cleanupOrphanedTriggers").timeBased().everyDays(1).atHour(2).create();
  logInfo("毎晩深夜2時の孤立トリガー自動掃除機能をセットアップしました。");
  SpreadsheetApp.getActiveSpreadsheet().toast('保守用機能（毎晩のトリガー掃除）を登録しました', 'セットアップ完了', 5);
}

// ============================================================
// ===== UI/UX コンポーネント・フィードバック関連 =====
// ============================================================

/**
 * リッチなローディングモーダルを表示しつつ、裏側で指定した関数を実行します。
 * モーダル表示中はUIがロックされ、関数完了後に自動的に閉じます。
 * 
 * @param {string} title モーダルの見出し文字
 * @param {string} message モーダルの説明文字
 * @param {string} functionNameGAS 実行したいGASの関数名文字列
 */
function showProcessingModal(title, message, functionNameGAS) {
  const template = HtmlService.createTemplateFromFile('LoadingModal');
  template.title = title || '処理中...';
  template.message = message || 'しばらくお待ちください。';
  template.functionName = functionNameGAS || 'null';
  
  const htmlOutput = template.evaluate()
      .setWidth(450)
      .setHeight(280);
      
  SpreadsheetApp.getUi().showModalDialog(htmlOutput, '進捗状況');
}

/**
 * モーダル内のJavaScriptから呼び出される中継関数。
 * 対象の関数をホワイトリストで制限し安全に実行します。
 */
function executeServerFunctionForModal(functionName) {
  // セキュリティ: 実行可能な関数をホワイトリストで明示的に制限
  const ALLOWED_MODAL_FUNCTIONS = {
    'createUnitMasterFromPdfs': createUnitMasterFromPdfs,
    'processNextEventPdf': processNextEventPdf,
    'processBulkTransferWithExclusion': processBulkTransferWithExclusion,
    'postScheduleToClassroom': postScheduleToClassroom,
    'autoPostToClassroom': autoPostToClassroom,
  };

  try {
    const fn = ALLOWED_MODAL_FUNCTIONS[functionName];
    if (typeof fn === 'function') {
      return fn();
    } else {
      throw new Error(`関数名「${functionName}」は実行が許可されていません。`);
    }
  } catch (e) {
    logError(`executeServerFunctionForModal(${functionName})`, e);
    throw new Error(e.message);
  }
}

/**
 * 固定時間割データを2次元配列（5行×8列）で返します。
 * スクリプトプロパティから取得します。未設定の場合は空データを返します。
 * 戻り値: [[時程, 朝学習, 1校時, 2校時, 3校時, 4校時, 5校時, 6校時], ...] (月〜金の5行)
 */
function getTimetableData_() {
  const savedJson = PropertiesService.getScriptProperties().getProperty('fixedTimetableData');
  if (savedJson) {
    try {
      const parsed = JSON.parse(savedJson);
      return parsed.map(d => [
        d.time || '', d.morning || '',
        (d.periods && d.periods[0]) || '', (d.periods && d.periods[1]) || '',
        (d.periods && d.periods[2]) || '', (d.periods && d.periods[3]) || '',
        (d.periods && d.periods[4]) || '', (d.periods && d.periods[5]) || ''
      ]);
    } catch(e) {
      logInfo('固定時間割のプロパティ解析に失敗: ' + e.message);
    }
  }

  return [['','','','','','','',''],['','','','','','','',''],['','','','','','','',''],['','','','','','','',''],['','','','','','','','']];
}
