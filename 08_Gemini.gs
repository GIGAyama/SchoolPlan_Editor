/**
 * @fileoverview Gemini API連携を利用したタスク（TODO）自動抽出機能
 */

/**
 * 設定値に基づいたGemini APIのエンドポイントURLを構築します。
 * @returns {string} Gemini API URL
 */
function getGeminiApiUrl_() {
  const modelName = getGeminiModelNameSafe_();
  return `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
}

/**
 * Gemini API へ generateContent リクエストを送信し、レスポンスJSONを返す共通ヘルパー。
 * HTTPエラー（429/401/403等）のハンドリングを一元化します。
 * @param {Object} payload リクエストボディ
 * @param {string} logLabel エラーログ用のラベル
 * @returns {Object} パース済みのレスポンスJSON
 */
function callGeminiEndpoint_(payload, logLabel) {
  const apiKey = getApiKeySafe_();

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(`${getGeminiApiUrl_()}?key=${apiKey}`, options);
  const responseCode = response.getResponseCode();
  const responseText = response.getContentText();

  if (responseCode !== 200) {
    const errDetail = (() => {
      try { return JSON.parse(responseText).error?.message || responseText; } catch(e) { return responseText; }
    })();
    logError(`${logLabel} (HTTP ${responseCode})`, new Error(errDetail));
    if (responseCode === 429) {
      throw new Error('AI APIのリクエスト制限に達しました。しばらく待ってから再度お試しください。');
    } else if (responseCode === 401 || responseCode === 403) {
      throw new Error('AI APIキーが無効です。設定画面でAPIキーを確認してください。');
    }
    throw new Error(`AI APIとの通信に失敗しました。（HTTP ${responseCode}）`);
  }

  return JSON.parse(responseText);
}

/**
 * Gemini APIを呼び出してJSON形式のタスク配列を取得する共通ラッパー
 * @param {string} prompt
 * @returns {Object[]} 抽出されたタスクの配列 { task, resource, dueDate, source }
 */
function callGeminiAPI_(prompt) {
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

  const json = callGeminiEndpoint_(payload, 'Gemini API Error');

  if (json.candidates && json.candidates.length > 0) {
    const textObj = json.candidates[0].content.parts[0].text;
    try {
      return JSON.parse(textObj);
    } catch (e) {
      logError('Gemini Parse Error', e);
      throw new Error('AIの出力をJSONとして解析できませんでした。再度お試しください。');
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
        if (cols.MORNING && row[cols.MORNING - 1]) scheduleText += `- 朝学習: ${row[cols.MORNING - 1]}\n`;
        
        // 1〜6校時
        const periods = [cols.PERIOD1, cols.PERIOD2, cols.PERIOD3, cols.PERIOD4, cols.PERIOD5, cols.PERIOD6];
        periods.forEach((pCol, idx) => {
          const subject = row[pCol - 1];
          const content = row[pCol - 1 + 2]; // 2つ右が学習内容
          if (subject && content) {
            scheduleText += `- ${idx + 1}校時 [${subject}] 内容: ${content}\n`;
          }
        });

        if (cols.AFTERSCHOOL && row[cols.AFTERSCHOOL - 1]) scheduleText += `- 放課後: ${row[cols.AFTERSCHOOL - 1]}\n`;
      }
    }

    if (!scheduleText) {
      throw new Error('指定期間のスケジュールデータがありません。');
    }

    // セキュリティ: スケジュールテキストの長さを制限（プロンプトインジェクション対策）
    if (scheduleText.length > 10000) {
      scheduleText = scheduleText.substring(0, 10000) + '\n...(以降省略)';
    }

    const systemPrompt = `
あなたは有能な小学校教員のサポートAIです。
以下の【スケジュール情報】を読み取り、教員が事前に準備・対応すべき【タスク（準備・連絡・調整など）】を洗い出してください。

【抽出対象】
1. 行事関連（遠足・運動会・授業参観・避難訓練・集会・校外学習・入学式・卒業式 等）:
   - 会場設営、事前配布物の印刷・配付、保護者への連絡、持ち物の確認指示、服装指示
   - 係分担の確認・指示、写真撮影の手配、時程変更の周知 等
2. 授業関連:
   - 実験器具・教材の準備、特別な印刷物(ワークシート等)、ICT機器の手配
   - 外部講師との事前調整、校外学習の下見 等
3. 朝学習・放課後:
   - テスト実施に伴う印刷、特別プログラムの準備 等

【除外対象】
- 通常の授業で特別な準備が不要なもの(国語の音読、算数の練習問題 等)

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
 * Gemini APIを呼び出してフリーテキスト（非JSON）を取得する汎用ラッパー
 * @param {string} prompt
 * @returns {string} 生成されたテキスト
 */
function callGeminiAPIText_(prompt) {
  const payload = {
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature: 0.7
    }
  };

  const json = callGeminiEndpoint_(payload, 'Gemini API Text Error');

  if (json.candidates && json.candidates.length > 0) {
    return json.candidates[0].content.parts[0].text || '';
  }

  return '';
}

/**
 * [Webアプリ API] 学級通信の本文をGemini AIで自動生成する
 * @param {string} mondayDateStr "YYYY/MM/DD" 形式の月曜日
 * @param {string} genType 生成タイプ (intro, event, study, notice, free)
 * @param {string} extraInstructions 追加指示
 * @returns {Object} { success: boolean, text: string }
 */
function generateNewsletterAI(mondayDateStr, genType, extraInstructions, options) {
  try {
    options = options || {};
    const tone = options.tone || 'warm';
    const length = options.length || 'medium';

    // 週案データを取得してコンテキストに使う
    let scheduleContext = '';
    try {
      const data = getNewsletterData(mondayDateStr);
      if (data.success && data.days) {
        scheduleContext = '\n【今週のスケジュール】\n';
        data.days.forEach(day => {
          scheduleContext += `${day.dayLabel}(${day.date}): `;
          if (day.event) scheduleContext += `行事:${day.event} `;
          day.periods.forEach((p, i) => {
            if (p && p.subject) scheduleContext += `${i+1}時間目:${p.subject} `;
          });
          scheduleContext += '\n';
        });
      }
    } catch(ignore) {}

    const toneDesc = {
      warm: '温かみのある、親しみやすい文体',
      formal: '丁寧で格式のある文体',
      casual: 'カジュアルで気軽な口調',
      energetic: '元気で明るい、活発な文体'
    };

    const lengthDesc = {
      short: '2〜3文の簡潔な文章',
      medium: '3〜5文の標準的な長さの文章',
      long: '5〜8文のしっかりした文章'
    };

    const typePrompts = {
      intro: '学級通信の冒頭に掲載する「今週のあいさつ文・はじめの文」を書いてください。季節感や子どもたちの成長に触れてください。',
      event: '今週の行事やイベントを紹介する文章を書いてください。保護者が読んで楽しめるよう、子どもたちの様子や準備のことにも触れてください。',
      study: '今週の学習内容や授業の様子を保護者に伝える文章を書いてください。子どもたちが頑張っていることや成長したことを具体的に触れてください。',
      notice: '保護者へのお知らせ・連絡事項を書いてください。丁寧だが簡潔な表現で、重要な点が伝わるようにしてください。',
      closing: '学級通信の最後に載せる「結びの文」を書いてください。来週への期待や保護者への感謝を込めてください。',
      safety: '安全に関するお知らせや注意喚起を書いてください。季節に応じた安全指導の内容を含めてください。',
      praise: '子どもたちの頑張りや良い行動を紹介する「キラキラコーナー」の文章を書いてください。具体的なエピソードを交えて褒めてください。',
      free: '学級通信に掲載する文章を書いてください。'
    };

    const prompt = `あなたは小学校の担任教員です。保護者向けの学級通信の本文を日本語で作成してください。
文章のみを出力し、タイトルや装飾、箇条書きは不要です。${toneDesc[tone] || toneDesc.warm}で書いてください。
${lengthDesc[length] || lengthDesc.medium}にしてください。

${typePrompts[genType] || typePrompts.free}
${scheduleContext}
${extraInstructions ? '\n【追加の指示】\n' + extraInstructions : ''}`;

    const text = callGeminiAPIText_(prompt);
    return { success: true, text: text };

  } catch (e) {
    logError('generateNewsletterAI', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 学級通信全体をAIで一括生成する
 * @param {string} mondayDateStr "YYYY/MM/DD" 形式の月曜日
 * @param {string} extraInstructions 追加指示
 * @param {Object} options { tone: string }
 * @returns {Object} { success: boolean, sections: Array }
 */
function generateFullNewsletterAI(mondayDateStr, extraInstructions, options) {
  try {
    options = options || {};
    const tone = options.tone || 'warm';

    let scheduleContext = '';
    try {
      const data = getNewsletterData(mondayDateStr);
      if (data.success && data.days) {
        scheduleContext = '\n【今週のスケジュール】\n';
        data.days.forEach(day => {
          scheduleContext += `${day.dayLabel}(${day.date}): `;
          if (day.event) scheduleContext += `行事:${day.event} `;
          day.periods.forEach((p, i) => {
            if (p && p.subject) scheduleContext += `${i+1}時間目:${p.subject} `;
          });
          scheduleContext += '\n';
        });
      }
    } catch(ignore) {}

    const toneDesc = {
      warm: '温かみのある、親しみやすい文体',
      formal: '丁寧で格式のある文体',
      casual: 'カジュアルで気軽な口調',
      energetic: '元気で明るい、活発な文体'
    };

    const prompt = `あなたは小学校の担任教員です。保護者向けの学級通信に掲載する文章を複数セクションに分けて作成してください。
${toneDesc[tone] || toneDesc.warm}で書いてください。

以下の形式のJSON配列で出力してください。各セクションは type と text を持ちます:
[
  { "type": "heading", "text": "学級通信のタイトル（学級通信 〇〇号 など）" },
  { "type": "intro", "text": "今週のあいさつ文（季節感や子どもたちの様子に触れた2〜3文）" },
  { "type": "study", "text": "今週の学習の様子（3〜4文）" },
  { "type": "notice", "text": "保護者へのお知らせ（2〜3文）" },
  { "type": "closing", "text": "結びの文（1〜2文）" }
]

行事がある場合は study の前に { "type": "event", "text": "行事紹介文" } を追加してください。
JSON配列のみを出力し、それ以外は何も出力しないでください。
${scheduleContext}
${extraInstructions ? '\n【追加の指示】\n' + extraInstructions : ''}`;

    const text = callGeminiAPIText_(prompt);

    // JSONパース
    let sections;
    try {
      // Markdown コードブロックを除去
      const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      sections = JSON.parse(cleaned);
    } catch (pe) {
      logError('generateFullNewsletterAI parse', pe);
      return { success: false, error: 'AI出力のJSON解析に失敗しました。再度お試しください。' };
    }

    if (!Array.isArray(sections) || sections.length === 0) {
      return { success: false, error: 'AIが有効なセクションを生成できませんでした。' };
    }

    return { success: true, sections: sections };

  } catch (e) {
    logError('generateFullNewsletterAI', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 既存テキストをAIでリライトする
 * @param {string} originalText 元のテキスト
 * @param {string} instruction リライト指示（例: "もっと丁寧に", "短くして"）
 * @returns {Object} { success: boolean, text: string }
 */
function rewriteNewsletterText(originalText, instruction) {
  try {
    if (!originalText || originalText.trim() === '') {
      throw new Error('リライトするテキストが空です。');
    }

    const sanitized = originalText.length > 5000 ? originalText.substring(0, 5000) : originalText;

    const prompt = `あなたは小学校の担任教員です。以下の学級通信の文章をリライトしてください。
リライト後の文章のみを出力し、タイトルや装飾は不要です。

【元の文章】
${sanitized}

【リライトの指示】
${instruction || 'より自然で読みやすい文章にしてください。'}`;

    const text = callGeminiAPIText_(prompt);
    return { success: true, text: text };

  } catch (e) {
    logError('rewriteNewsletterText', e);
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

    // セキュリティ: 入力テキストの長さを制限
    const sanitizedText = text.length > 10000 ? text.substring(0, 10000) + '\n...(以降省略)' : text;

    const todayDateStr = Utilities.formatDate(new Date(), 'JST', 'yyyy-MM-dd');

    const systemPrompt = `
あなたは有能な業務アシスタントAIです。（本日の日付: ${todayDateStr}）
以下の【テキスト情報（会議の議事録や打合せメモなど）】を読み取り、教員（ユーザー）が今後行うべき【アクションリスト・準備タスク】を洗い出してください。

【テキスト情報】
${sanitizedText}
`;

    const extractedTasks = callGeminiAPI_(systemPrompt);
    return { success: true, tasks: extractedTasks };

  } catch (e) {
    logError('extractTasksFromText', e);
    return { success: false, error: e.message };
  }
}
