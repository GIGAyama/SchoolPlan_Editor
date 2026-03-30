/**
 * @fileoverview 共通利用される便利関数（日付処理、API呼び出し、ログ出力関連）
 */

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
 * 指定された指示（プロンプト）とファイル情報を、Gemini APIに送信してAIによる分析を依頼します。 
 */
function callGeminiApi_(prompt, apiKey, blobs = []) {
  const modelName = getGeminiModelNameSafe_();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  const parts = [{ "text": prompt }];
  blobs.forEach(blob => {
    parts.push({ "inline_data": { "mime_type": blob.getContentType(), "data": Utilities.base64Encode(blob.getBytes()) } });
  });
  const payload = { "contents": [{ "parts": parts }], "generationConfig": { "response_mime_type": "application/json", "maxOutputTokens": 8192 } };
  const options = { 'method': 'post', 'contentType': 'application/json', 'payload': JSON.stringify(payload), 'muteHttpExceptions': true };
  
  const response = UrlFetchApp.fetch(url, options);
  const responseCode = response.getResponseCode();
  const responseBody = response.getContentText();
  
  if (responseCode === 200) {
    const jsonResponse = JSON.parse(responseBody);
    if (jsonResponse.candidates && jsonResponse.candidates[0] && jsonResponse.candidates[0].content && jsonResponse.candidates[0].content.parts) {
      const text = jsonResponse.candidates[0].content.parts[0].text;
      try {
        return JSON.parse(text);
      } catch (e) {
        logError("Gemini APIからのJSONレスポンスのパースに失敗しました。", e);
        logInfo(`パースに失敗したテキスト(最初の1000文字): ${text.substring(0, 1000)} ...`);

        // トークン上限などでJSONが途切れた場合のための超簡易修復フォールバック
        // （完全なオブジェクト配列であること前提で、最後の要素を削って配列を閉じる）
        try {
            logInfo("途切れたJSONの修復と救出を試みます...");
            let attempt = text;
            // 最後のオブジェクトの区切り `, {` まで削る
            let lastObjStart = attempt.lastIndexOf(', {');
            if (lastObjStart === -1) lastObjStart = attempt.lastIndexOf(',\n{');
            if (lastObjStart !== -1) {
                attempt = attempt.substring(0, lastObjStart) + "\n]";
                const parsed = JSON.parse(attempt);
                logInfo("修復に成功しました！一部の末尾データは破棄されました。");
                return parsed;
            }
        } catch(e2) {
            logError("JSONの修復にも失敗しました。", e2);
        }
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
    logError(`Gemini API Error (Code: ${responseCode})`, new Error(responseBody));
    throw new Error(`Gemini APIとの通信に失敗しました。レスポンスコード: ${responseCode}`);
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
  const errorMessage = `${message}\nエラー詳細: ${error.message}\nスタックトレース: ${error.stack}`;
  writeToLog_("ERROR", errorMessage);
}

/** 
 * ログシート書き込みの共通処理 
 */
function writeToLog_(level, message) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
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
 * 対象の関数を安全に実行するためのラッパーです。
 */
function executeServerFunctionForModal(functionName) {
  try {
    const fn = this[functionName];
    if (typeof fn === 'function') {
      return fn(); // ここで同期実行される間、モーダルは表示され続ける
    } else {
      throw new Error(`関数名「${functionName}」が見つかりません。`);
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
