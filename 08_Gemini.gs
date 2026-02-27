/**
 * @fileoverview Gemini API連携を利用したタスク（TODO）自動抽出機能
 */

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

/**
 * Gemini APIを呼び出してJSON形式のタスク配列を取得する共通ラッパー
 * @param {string} prompt 
 * @returns {Object[]} 抽出されたタスクの配列 { task, resource, dueDate, source }
 */
function callGeminiAPI_(prompt) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('sp_geminiApiKey');
  if (!apiKey) {
    throw new Error('sp_geminiApiKeyが設定されていません。設定画面からGemini APIキーを登録してください。');
  }

  const payload = {
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature: 0.1, // タスク抽出なので低めの温度設定（事実ベース）
      responseMimeType: "application/json",
      // JSONスキーマを直接指定してGeminiの出力を固定する (Gemini 1.5 Pro/Flash等で有効)
      responseSchema: {
        type: "ARRAY",
        description: "抽出されたタスクのリスト",
        items: {
          type: "OBJECT",
          properties: {
            task: { type: "STRING", description: "タスクの具体的な内容" },
            resource: { type: "STRING", description: "必要なリソースや補足情報、準備物" },
            dueDate: { type: "STRING", description: "期限設定（YYYY-MM-DD形式）。特定できない場合は空文字" },
            source: { type: "STRING", description: "発生源（授業名や会議名などを短く）" }
          },
          required: ["task", "resource", "dueDate", "source"]
        }
      }
    }
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(`${GEMINI_API_URL}?key=${apiKey}`, options);
  const json = JSON.parse(response.getContentText());

  if (response.getResponseCode() !== 200) {
    logError('Gemini API Error', new Error(response.getContentText()));
    throw new Error('AIサーバとの通信でエラーが発生しました。');
  }

  if (json.candidates && json.candidates.length > 0) {
    const textObj = json.candidates[0].content.parts[0].text;
    try {
      return JSON.parse(textObj);
    } catch (e) {
      logError('Gemini Parse Error', e);
      throw new Error('AIのJSON出力をパースできませんでした。');
    }
  }

  return [];
}

/**
 * [Webアプリ API] スケジュール（週案）からタスクを抽出
 * @param {string} startDateStr "YYYY-MM-DD"
 * @param {string} endDateStr "YYYY-MM-DD"
 * @returns {Object} { success: boolean, tasks: Object[] }
 */
function extractTasksFromSchedule_WebApp(startDateStr, endDateStr) {
  try {
    const ss = typeof getSs_ === 'function' ? getSs_() : SpreadsheetApp.getActiveSpreadsheet();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');

    // 指定期間のデータを取得（日付、行事、各教科・活動内容）
    const dbData = dbSheet.getDataRange().getValues();
    const cols = getDbColumns();
    const startDate = new Date(startDateStr);
    const endDate = new Date(endDateStr);
    startDate.setHours(0,0,0,0);
    endDate.setHours(23,59,59,999);

    let scheduleText = "";

    for (let i = 1; i < dbData.length; i++) {
      const row = dbData[i];
      const d = row[cols.DATE - 1];
      if (d instanceof Date && d >= startDate && d <= endDate) {
        const dateStr = Utilities.formatDate(d, 'JST', 'yyyy-MM-dd');
        scheduleText += `\n【${dateStr}】\n`;
        if (row[cols.EVENT - 1]) scheduleText += `- 行事: ${row[cols.EVENT - 1]}\n`;
        
        // 1〜6校時
        const periods = [cols.PERIOD1, cols.PERIOD2, cols.PERIOD3, cols.PERIOD4, cols.PERIOD5, cols.PERIOD6];
        periods.forEach((pCol, idx) => {
          const subject = row[pCol - 1];
          const content = row[pCol - 1 + 2]; // 2つ右が学習内容
          if (subject && content) {
            scheduleText += `- ${idx + 1}校時 [${subject}] 内容: ${content}\n`;
          }
        });
      }
    }

    if (!scheduleText) {
      throw new Error('指定期間のスケジュールデータがありません。');
    }

    const systemPrompt = `
あなたは有能な小学校教員のサポートAIです。
以下の【スケジュール情報】を読み取り、教員が事前に準備・対応すべき【タスク（準備・連絡・調整など）】を洗い出してください。
通常の授業（国語の音読など特別な準備が不要なもの）はタスク化しなくて構いません。
実験器具、特別な印刷物、事前の機材準備、特別な行事対応などを抽出してください。

【スケジュール情報】
${scheduleText}
`;

    const extractedTasks = callGeminiAPI_(systemPrompt);
    return { success: true, tasks: extractedTasks };

  } catch (e) {
    logError('extractTasksFromSchedule', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] フリーテキスト（議事録等）からタスクを抽出
 * @param {string} text 議事録などのテキスト
 * @returns {Object} { success: boolean, tasks: Object[] }
 */
function extractTasksFromText_WebApp(text) {
  try {
    if (!text || text.trim() === '') {
      throw new Error('解析するテキストが空です。');
    }

    const todayDateStr = Utilities.formatDate(new Date(), 'JST', 'yyyy-MM-dd');
    
    const systemPrompt = `
あなたは有能な業務アシスタントAIです。（本日の日付: ${todayDateStr}）
以下の【テキスト情報（会議の議事録や打合せメモなど）】を読み取り、教員（ユーザー）が今後行うべき【アクションリスト・準備タスク】を洗い出してください。

【テキスト情報】
${text}
`;

    const extractedTasks = callGeminiAPI_(systemPrompt);
    return { success: true, tasks: extractedTasks };

  } catch (e) {
    logError('extractTasksFromText', e);
    return { success: false, error: e.message };
  }
}
