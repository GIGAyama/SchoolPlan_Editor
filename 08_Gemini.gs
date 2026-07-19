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

  const url = `${getGeminiApiUrl_()}?key=${apiKey}`;
  const MAX_ATTEMPTS = 4;      // 初回 + 最大3回の再試行
  const BASE_DELAY_MS = 1000;  // 指数バックオフの基準（1秒→2秒→4秒）

  let lastCode = 0;
  let lastDetail = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();

    if (responseCode === 200) {
      return JSON.parse(responseText);
    }

    lastCode = responseCode;
    lastDetail = (() => {
      try { return JSON.parse(responseText).error?.message || responseText; } catch(e) { return responseText; }
    })();

    // 429（レート制限）と 5xx（サーバ側一時障害）のみ再試行対象。
    // 401/403/400 等のクライアント起因エラーは再試行しても無駄なので即終了する。
    const isRetryable = (responseCode === 429 || responseCode >= 500);
    if (!isRetryable || attempt === MAX_ATTEMPTS - 1) {
      break;
    }

    // 指数バックオフ。Retry-After ヘッダがあればそれを尊重する（上限16秒）。
    const headers = response.getHeaders() || {};
    const retryAfter = parseInt(headers['Retry-After'] || headers['retry-after'], 10);
    const waitMs = (!isNaN(retryAfter) && retryAfter > 0)
      ? Math.min(retryAfter * 1000, 16000)
      : BASE_DELAY_MS * Math.pow(2, attempt);
    logInfo(`${logLabel}: HTTP ${responseCode} のため ${waitMs}ms 後に再試行します（${attempt + 1}/${MAX_ATTEMPTS - 1}）`);
    Utilities.sleep(waitMs);
  }

  logError(`${logLabel} (HTTP ${lastCode})`, new Error(lastDetail));
  if (lastCode === 429) {
    throw new Error('AI APIのリクエスト制限に達しました。しばらく待ってから再度お試しください。');
  } else if (lastCode === 401 || lastCode === 403) {
    throw new Error('AI APIキーが無効です。設定画面でAPIキーを確認してください。');
  }
  throw new Error(`AI APIとの通信に失敗しました。（HTTP ${lastCode}）`);
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
            source: { type: "STRING", description: "発生源（授業名や会議名などを短く）" },
            priority: { type: "STRING", enum: ["高", "中", "低"], description: "重要度・緊急度から判断した優先度。行事や保護者連絡など影響が大きいものは「高」" }
          },
          required: ["task", "resource", "dueDate", "source", "priority"]
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
      // 出力が途切れている場合に備え、最後の完全なオブジェクトまでを救出する
      const repaired = repairTruncatedJsonArray_(textObj);
      if (repaired !== null) {
        logInfo(`Gemini出力が途切れていたため修復しました（${repaired.length}件を救出）。`);
        return repaired;
      }
      logError('Gemini Parse Error', e);
      throw new Error('AIの出力をJSONとして解析できませんでした。再度お試しください。');
    }
  }

  return [];
}

/**
 * 指定期間の週案・行事データを、AI解析用のテキストに整形して返します。
 * 該当データが1件も無い場合は空文字を返します（呼び出し側で扱いを決めます）。
 * タスク抽出（週案モード）と、PDFモードで既存の予定を併用する際に共用します。
 * @param {string} startDateStr "YYYY-MM-DD"
 * @param {string} endDateStr "YYYY-MM-DD"
 * @returns {string} 整形済みのスケジュールテキスト
 */
function buildScheduleContextText_(startDateStr, endDateStr) {
  const ss = typeof getSs_ === 'function' ? getSs_() : SpreadsheetApp.getActiveSpreadsheet();
  const dbSheet = getDbSheet_(ss);
  if (!dbSheet) throw new Error('データベースシートが見つかりません');

  // 指定期間のデータを取得（日付、行事、各教科・活動内容）
  const dbData = dbSheet.getDataRange().getValues();
  const cols = getDbColumns();
  const startDate = new Date(startDateStr);
  const endDate = new Date(endDateStr);
  startDate.setHours(0, 0, 0, 0);
  endDate.setHours(23, 59, 59, 999);

  let scheduleText = "";

  for (let i = 1; i < dbData.length; i++) {
    const row = dbData[i];
    const d = row[cols.DATE - 1];
    if (d instanceof Date && d >= startDate && d <= endDate) {
      const dateStr = Utilities.formatDate(d, 'JST', 'yyyy-MM-dd');
      scheduleText += `\n【${dateStr}】\n`;
      if (row[cols.EVENT - 1]) scheduleText += `- 行事: ${row[cols.EVENT - 1]}\n`;
      if (cols.MORNING && row[cols.MORNING - 1]) scheduleText += `- 朝学習: ${row[cols.MORNING - 1]}\n`;

      // 1〜6校時（学習内容は列マップから取得し、シートの列順に依存しない）
      for (let n = 1; n <= 6; n++) {
        const pCol = cols['PERIOD' + n];
        const cCol = cols['CONTENT' + n];
        if (!pCol || !cCol) continue;
        const subject = row[pCol - 1];
        const content = row[cCol - 1];
        if (subject && content) {
          scheduleText += `- ${n}校時 [${subject}] 内容: ${content}\n`;
        }
      }

      if (cols.AFTERSCHOOL && row[cols.AFTERSCHOOL - 1]) scheduleText += `- 放課後: ${row[cols.AFTERSCHOOL - 1]}\n`;
    }
  }

  return scheduleText;
}

/**
 * [Webアプリ API] スケジュール（週案）からタスクを抽出
 * @param {string} startDateStr "YYYY-MM-DD"
 * @param {string} endDateStr "YYYY-MM-DD"
 * @returns {Object} { success: boolean, tasks: Object[] }
 */
function extractTasksFromSchedule_WebApp(startDateStr, endDateStr) {
  try {
    let scheduleText = buildScheduleContextText_(startDateStr, endDateStr);

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
 * [内部] 与えられた文章中の漢字をすべてひらがなに変換します（小学1年生が自分で読めるように）。
 * Gemini を利用。APIキー未設定や変換失敗時は、投稿を止めないよう元の文章をそのまま返します。
 * カタカナ・数字・記号・絵文字・改行・「」などの構造は保持し、漢字のみを読み仮名に置き換えます。
 * @param {string} text 変換対象の文章
 * @returns {string} ひらがな変換後の文章（失敗時は元の文章）
 */
function convertTextToHiragana_(text) {
  try {
    if (!text || !text.trim()) return text;

    const prompt = `次の文章を、小学1年生が一人で読めるように、漢字の部分だけをすべてひらがなに変換してください。

【ルール】
- 漢字は、その文脈に合った正しい読み方のひらがなに置き換えてください。
- カタカナ・数字・アルファベット・記号・絵文字・改行・「」（かぎかっこ）・／などはそのまま残してください。
- 語順や内容、レイアウトは一切変えないでください。
- 変換後の文章だけを出力し、説明・注釈・前置きは一切付けないでください。

【文章】
${text}`;

    const converted = callGeminiAPIText_(prompt);
    return (converted && converted.trim()) ? converted.trim() : text;
  } catch (e) {
    logError('convertTextToHiragana_', e);
    return text; // 失敗時は元の文章を返し、投稿処理を継続させる
  }
}

/**
 * [内部] 本日（投稿する日）の学習予定をもとに、保護者向けの「今日の様子」文章を生成します。
 * Gemini を利用。APIキー未設定や生成失敗時は空文字を返し、呼び出し側でセクションを省略できるようにします。
 * @param {string} dateLabel 例 "2026/05/27（火）"
 * @param {string} lessonContext 本日の授業内容のテキスト（buildLessonContext_ の戻り値）
 * @returns {string} 生成された文章（失敗時は空文字）
 */
function generateTodaySituationText_(dateLabel, lessonContext) {
  try {
    if (!lessonContext || !lessonContext.trim()) return '';

    // セキュリティ: 入力長を制限（プロンプトインジェクション・過大入力対策）
    const sanitized = lessonContext.length > 3000 ? lessonContext.substring(0, 3000) : lessonContext;

    const prompt = `あなたは小学校の担任教員です。
本日（${dateLabel}）に行った授業の予定をもとに、保護者向けに「今日の様子」を伝える短い文章を作成してください。

【条件】
- 授業が実際に行われたという前提で、子どもたちが頑張っていた様子や学びの様子を、温かく具体的に書いてください。
- 3〜4文程度の自然な日本語の文章にしてください。
- 箇条書き・見出し・絵文字は使わず、文章のみを出力してください。
- 保護者が読んで安心でき、子どもの学校での様子が想像できるようにしてください。
- 予定にない出来事を断定的に作り込みすぎないよう、自然な範囲で書いてください。

【本日の授業予定】
${sanitized}`;

    const text = callGeminiAPIText_(prompt);
    return (text || '').trim();
  } catch (e) {
    logError('generateTodaySituationText_', e);
    return ''; // 失敗時は空文字を返し、予定の投稿は継続させる
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

/**
 * PDF（行事の実施案・実施要項等）からタスクを抽出するためのプロンプトを構築します。
 * PDF解析は callGeminiApiRaw_ を利用し responseSchema を適用しないため、
 * 出力するJSONの形式をプロンプト内で明示します（週案・フリーテキストの抽出項目と揃えます）。
 * @param {string} todayDateStr 本日の日付 "yyyy-MM-dd"
 * @param {string} contextText 併用する既存情報（週案の予定・議事録メモ等）。無ければ空文字
 * @returns {string}
 */
function buildTaskPdfPrompt_(todayDateStr, contextText) {
  const contextBlock = (contextText && contextText.trim())
    ? `
【併せて参照する既存の情報（入力済みの予定や議事録メモなど）】
以下はユーザーが既に把握している予定・メモです。PDFの内容と照らし合わせ、関連するタスクは期日や準備物をより具体化してください。明らかに重複するタスクは1つにまとめてください。
${contextText}
`
    : '';

  return `あなたは有能な小学校教員のサポートAIです。（本日の日付: ${todayDateStr}）
添付されたPDFファイルは、学校行事の「実施案」や「実施要項」などの資料です。
このPDFを丁寧に読み取り、担当教員が事前に準備・対応すべき【タスク（準備・連絡・調整など）】を洗い出してください。
${contextBlock}
【抽出の観点】
- 会場設営、印刷・配布物、保護者への連絡・通知、持ち物や服装の指示、係分担の確認・指示
- 教材・器具・ICT機器の準備、外部との事前調整、下見、時程・しおりの作成 等
- 提出物や締切、準備の期限が読み取れる場合は、それを踏まえてタスク化してください。

【期日(dueDate)のルール】
- PDFや併用情報から具体的な日付が特定できる場合は "YYYY-MM-DD" 形式で設定してください。
- 「◯日前まで」等の相対的な締切は、行事日から逆算して具体的な日付にしてください。
- 特定できない場合は空文字にしてください。

【出力形式】
必ず以下の項目を持つオブジェクトのJSON配列のみを出力してください。前後に説明文やコードブロック(\`\`\`)は付けないでください。
[
  {
    "task": "タスクの具体的な内容",
    "resource": "必要な準備物・リソース・補足（無ければ空文字）",
    "dueDate": "YYYY-MM-DD形式の期日（特定できなければ空文字）",
    "source": "発生源（行事名など。例: 運動会実施案）",
    "priority": "高・中・低 のいずれか（保護者連絡や大きな行事など影響が大きいものは高）"
  }
]`;
}

/**
 * [Webアプリ API] PDF（行事の実施案等）からタスクを抽出します。
 * 既存の週案（スケジュール）やフリーテキストの情報と組み合わせて解析することもできます。
 * 抽出結果は書き込まず、プレビュー用の配列として返します（週案・テキストモードと同一の形式）。
 * @param {{fileId?: string, base64?: string, name?: string}} fileRef PDFの参照（Drive fileId またはアップロードbase64）
 * @param {{scheduleStart?: string, scheduleEnd?: string, extraText?: string}} [options] 併用する既存情報
 * @returns {Object} { success: boolean, fileName?: string, tasks?: Object[], error?: string }
 */
function extractTasksFromPdf_WebApp(fileRef, options) {
  try {
    options = options || {};
    const { blob, name } = getPdfBlobFromRef_(fileRef);
    const apiKey = getApiKey_();
    const todayDateStr = Utilities.formatDate(new Date(), 'JST', 'yyyy-MM-dd');

    // ===== 既存ロジック（週案の予定・フリーテキスト）との組み合わせ =====
    let contextText = '';
    if (options.scheduleStart && options.scheduleEnd) {
      try {
        const scheduleText = buildScheduleContextText_(options.scheduleStart, options.scheduleEnd);
        if (scheduleText) contextText += `\n[入力済みの予定]\n${scheduleText}`;
      } catch (ctxErr) {
        // 予定の取得に失敗してもPDF解析自体は継続する
        logInfo(`タスクPDF抽出: 予定コンテキストの取得をスキップしました（${ctxErr.message}）`);
      }
    }
    if (options.extraText && String(options.extraText).trim()) {
      let extra = String(options.extraText).trim();
      // セキュリティ: 併用テキストの長さを制限
      if (extra.length > 5000) extra = extra.substring(0, 5000) + '\n...(以降省略)';
      contextText += `\n[メモ・議事録など]\n${extra}`;
    }
    if (contextText.length > 10000) {
      contextText = contextText.substring(0, 10000) + '\n...(以降省略)';
    }

    const prompt = buildTaskPdfPrompt_(todayDateStr, contextText);

    const buildContinuation = (collected) => {
      const items = collected.map(t => `「${t.task}」`).join(', ');
      return `${prompt}

【重要な追加指示】
前回のリクエストで出力がトークン上限に達し、途中で切れてしまいました。
以下の ${collected.length} 件のタスクは既に取得済みです:
${items}

上記のタスクは絶対に出力しないでください。まだ出力されていない残りのタスクのみを、同じJSON配列形式で出力してください。`;
    };

    const extracted = callGeminiApiChunked_(prompt, apiKey, [blob], buildContinuation);
    if (!extracted || !Array.isArray(extracted)) {
      throw new Error(`PDF「${name}」からタスクを抽出できませんでした。APIレスポンスが不正です。`);
    }

    // 週案・テキストモードと同じ {task, resource, dueDate, source, priority} 形式に正規化
    const tasks = [];
    extracted.forEach(item => {
      if (!item || !item.task) return;
      const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(item.dueDate || '') ? item.dueDate : '';
      const priority = ['高', '中', '低'].indexOf(item.priority) >= 0 ? item.priority : '中';
      tasks.push({
        task: String(item.task).trim(),
        resource: String(item.resource || '').trim(),
        dueDate: dueDate,
        source: String(item.source || name).trim(),
        priority: priority
      });
    });

    logInfo(`タスクPDF抽出: PDF「${name}」から ${tasks.length} 件のタスクを抽出しました。`);
    return { success: true, fileName: name, tasks: tasks };

  } catch (e) {
    logError('extractTasksFromPdf', e);
    return { success: false, error: e.message };
  }
}
