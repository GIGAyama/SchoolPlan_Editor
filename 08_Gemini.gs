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
  // 通信の作法（ヘッダでキーを渡す・429/5xx の再試行・Retry-After の尊重）は
  // 正本 Gemini.gs（GigaGemini）に集約した。ここはこのアプリ固有の値を渡すだけ。
  try {
    return GigaGemini.callRaw({
      apiKey: getApiKeySafe_(),
      payload: payload,
      url: getGeminiApiUrl_(),
      maxAttempts: 4,
      log: logInfo,
      logLabel: logLabel,
    });
  } catch (e) {
    // 文言はこれまでどおり（設定画面の案内と対応しているため変えない）
    const msg = String(e && e.message || e);
    logError(`${logLabel}`, e);
    if (msg.indexOf('AI_BUSY') === 0) {
      throw new Error('AI APIのリクエスト制限に達しました。しばらく待ってから再度お試しください。');
    }
    if (msg.indexOf('APIキー') !== -1) {
      throw new Error('AI APIキーが無効です。設定画面でAPIキーを確認してください。');
    }
    throw new Error('AI APIとの通信に失敗しました。');
  }
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
 * 任意の itemSchema で JSON 配列を返させる汎用ラッパー。
 * 単元の時数再構成・年間再配分など、配列を1本だけ受け取りたい用途で使います。
 * （既存の callGeminiAPI_ / callGeminiUnitAllocation_ はスキーマ固定のため統合しません）
 *
 * @param {string} prompt
 * @param {Object} itemSchema 配列要素のスキーマ（type: "OBJECT" ...）
 * @param {string} description 配列自体の説明
 * @param {string} logLabel エラーログ用ラベル
 * @param {number} [temperature] 既定 0.2
 * @returns {Array} パース済みの配列（取得できなければ空配列）
 */
function callGeminiJsonArray_(prompt, itemSchema, description, logLabel, temperature) {
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: (temperature === undefined || temperature === null) ? 0.2 : temperature,
      responseMimeType: "application/json",
      responseSchema: {
        type: "ARRAY",
        description: description || '',
        items: itemSchema
      }
    }
  };

  const json = callGeminiEndpoint_(payload, logLabel || 'Gemini JSON Array Error');
  if (json.candidates && json.candidates.length > 0) {
    const text = json.candidates[0].content.parts[0].text;
    try {
      return JSON.parse(text);
    } catch (e) {
      // 出力がトークン上限で途切れた場合に備え、最後の完全な要素までを救出する
      const repaired = repairTruncatedJsonArray_(text);
      if (repaired !== null) return repaired;
      logError((logLabel || 'Gemini JSON Array') + ' Parse Error', e);
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
  const ss = getSs_();
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
 * 週案の予定・フリーテキスト・PDFを組み合わせてタスクを抽出するためのプロンプトを構築します。
 * @param {string} todayDateStr 本日の日付 "yyyy-MM-dd"
 * @param {string} scheduleText 週案・行事予定の整形済みテキスト（無ければ空文字）
 * @param {string} freeText 議事録・メモ等のフリーテキスト（無ければ空文字）
 * @param {boolean} hasPdf 添付PDFがあるか
 * @returns {string}
 */
function buildCombinedTaskPrompt_(todayDateStr, scheduleText, freeText, hasPdf) {
  const blocks = [];
  if (hasPdf) {
    blocks.push('添付されたPDFファイル（学校行事の実施案・実施要項や配布資料など）を丁寧に読み取ってください。');
  }
  if (scheduleText && scheduleText.trim()) {
    blocks.push(`【スケジュール情報（入力済みの週案・行事予定）】\n${scheduleText}`);
  }
  if (freeText && freeText.trim()) {
    blocks.push(`【テキスト情報（会議の議事録や打合せメモなど）】\n${freeText}`);
  }
  const sourceBlock = blocks.join('\n\n');

  return `あなたは有能な小学校教員のサポートAIです。（本日の日付: ${todayDateStr}）
以下の情報源を総合的に読み取り、教員（ユーザー）が事前に準備・対応すべき【タスク（準備・連絡・調整など）】を洗い出してください。
複数の情報源に同じ内容が現れる場合は1つのタスクにまとめ、期日や準備物をできるだけ具体化してください。

${sourceBlock}

【抽出の観点】
- 行事関連: 会場設営、印刷・配布物、保護者への連絡・通知、持ち物や服装の指示、係分担の確認・指示、写真撮影の手配、時程変更の周知 等
- 授業関連: 実験器具・教材の準備、特別な印刷物(ワークシート等)、ICT機器の手配、外部講師との事前調整、校外学習の下見 等
- 朝学習・放課後: テスト実施に伴う印刷、特別プログラムの準備 等
- 提出物や締切、準備の期限が読み取れる場合は、それを踏まえてタスク化してください。

【除外対象】
- 通常の授業で特別な準備が不要なもの(国語の音読、算数の練習問題 等)

【期日(dueDate)のルール】
- 具体的な日付が特定できる場合は "YYYY-MM-DD" 形式で設定してください。
- 「◯日前まで」等の相対的な締切は、行事日から逆算して具体的な日付にしてください。
- 特定できない場合は空文字にしてください。

【出力形式】
必ず以下の項目を持つオブジェクトのJSON配列のみを出力してください。前後に説明文やコードブロック(\`\`\`)は付けないでください。
[
  {
    "task": "タスクの具体的な内容",
    "resource": "必要な準備物・リソース・補足（無ければ空文字）",
    "dueDate": "YYYY-MM-DD形式の期日（特定できなければ空文字）",
    "source": "発生源（行事名・会議名など。例: 運動会実施案）",
    "priority": "高・中・低 のいずれか（保護者連絡や大きな行事など影響が大きいものは高）"
  }
]`;
}

/**
 * [Webアプリ API] 週案の予定・フリーテキスト・PDF(複数)を自由に組み合わせてタスクを抽出します。
 * いずれか1つ以上の情報源があれば実行でき、抽出結果はプレビュー用の配列として返します（書き込みは行いません）。
 * @param {{scheduleStart?: string, scheduleEnd?: string, freeText?: string, pdfs?: Array<{base64: string, name?: string}>}} params
 * @returns {Object} { success: boolean, tasks?: Object[], error?: string }
 */
function extractTasksCombined_WebApp(params) {
  try {
    params = params || {};
    const apiKey = getApiKey_();
    const todayDateStr = Utilities.formatDate(new Date(), 'JST', 'yyyy-MM-dd');

    // --- スケジュール（週案・行事予定） ---
    let scheduleText = '';
    if (params.scheduleStart && params.scheduleEnd) {
      if (params.scheduleStart > params.scheduleEnd) {
        throw new Error('抽出期間の開始日は終了日より前にしてください。');
      }
      try {
        scheduleText = buildScheduleContextText_(params.scheduleStart, params.scheduleEnd) || '';
      } catch (ctxErr) {
        // 予定の取得に失敗しても他の情報源での抽出は継続する
        logInfo(`タスク抽出: 予定コンテキストの取得をスキップしました（${ctxErr.message}）`);
      }
    }
    if (scheduleText.length > 10000) {
      scheduleText = scheduleText.substring(0, 10000) + '\n...(以降省略)';
    }

    // --- フリーテキスト ---
    let freeText = String(params.freeText || '').trim();
    if (freeText.length > 10000) {
      freeText = freeText.substring(0, 10000) + '\n...(以降省略)';
    }

    // --- PDF（複数） ---
    const pdfs = Array.isArray(params.pdfs) ? params.pdfs : [];
    const blobs = [];
    pdfs.forEach((p, i) => {
      if (!p || !p.base64) return;
      const bytes = Utilities.base64Decode(p.base64);
      if (bytes.length > 15 * 1024 * 1024) {
        throw new Error(`「${p.name || ('PDF' + (i + 1))}」は15MBを超えています。`);
      }
      blobs.push(Utilities.newBlob(bytes, MimeType.PDF, p.name || `file${i + 1}.pdf`));
    });

    // 少なくとも1つの情報源が必要
    if (!scheduleText && !freeText && blobs.length === 0) {
      throw new Error('抽出する情報源がありません。予定・テキスト・PDFのいずれかを指定してください。');
    }

    const prompt = buildCombinedTaskPrompt_(todayDateStr, scheduleText, freeText, blobs.length > 0);

    const buildContinuation = (collected) => {
      const items = collected.map(t => `「${t.task}」`).join(', ');
      return `${prompt}

【重要な追加指示】
前回のリクエストで出力がトークン上限に達し、途中で切れてしまいました。
以下の ${collected.length} 件のタスクは既に取得済みです:
${items}

上記のタスクは絶対に出力しないでください。まだ出力されていない残りのタスクのみを、同じJSON配列形式で出力してください。`;
    };

    const extracted = callGeminiApiChunked_(prompt, apiKey, blobs, buildContinuation);
    if (!extracted || !Array.isArray(extracted)) {
      throw new Error('タスクを抽出できませんでした。APIレスポンスが不正です。');
    }

    // プレビュー用の {task, resource, dueDate, source, priority} 形式に正規化
    const tasks = [];
    extracted.forEach(item => {
      if (!item || !item.task) return;
      const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(item.dueDate || '') ? item.dueDate : '';
      const priority = ['高', '中', '低'].indexOf(item.priority) >= 0 ? item.priority : '中';
      tasks.push({
        task: String(item.task).trim(),
        resource: String(item.resource || '').trim(),
        dueDate: dueDate,
        source: String(item.source || '').trim(),
        priority: priority
      });
    });

    logInfo(`タスク抽出（統合）: ${tasks.length} 件を抽出しました。`);
    return { success: true, tasks: tasks };
  } catch (e) {
    logError('extractTasksCombined', e);
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
 * 学級通信の「お知らせ」記事の書き方。
 *
 * 先生が Google ドキュメントで出してきた通信（A4 1枚。週予定の表の下に
 * 「お知らせ」が 1〜2 本）を読みくらべて、共通していた型を言葉にしたもの。
 * 以前の生成は「季節のあいさつ→学習の様子→お知らせ→結び」という読み物の型で、
 * 実際の通信とは形が違い、毎回ほとんど書き直しになっていた。
 *
 * ⚠️ 実例の文をそのまま写していない。児童名・学校名・学級名を
 *    プロンプトに入れないため（Zero-PII）。
 */
const NEWSLETTER_ARTICLE_STYLE_ = [
  '・読み手は保護者。です・ます調の丁寧語で書く。あいさつ・季節の前置き・結びの言葉は書かない。',
  '・1本の記事は「見出し」と「本文」でできている。',
  '・見出しは25字以内で、何の話か一目で分かるようにする。「〜について」「〜のお願い」「〜が始まります」「〜を持ち帰ります」「〜をがんばっています！」のような形で終える。日時が要になる話は「９月３０日（木）１時間目の〜について」のように日時から書きはじめてよい。',
  '・本文は2〜5文（100〜220字）。(1)何のための学習・行事か → (2)家庭にしてほしいこと（持ち物・大きさ・記名・持たせる日） → (3)お願いの一言、の順に書く。',
  '・お願いは「〜をお願いします」「〜持たせていただきますようお願いします」「〜していただけると助かります」のように、やわらかく、しかし具体的に書く。',
  '・日付は「１４日（月）」「９月３０日（木）」の形にする（数字は全角、曜日は（ ）に入れる）。いくつかの持ち物を並べるときは「①手鏡　②コップ」のように丸数字でつなぐ。',
  '・子どもの名前・個人が分かる話・成績には触れない。予定に書かれていない行事・持ち物・日付を作り出さない。',
  '・箇条書き・絵文字・【】や★などの飾りは使わない。'
].join('\n');

const NEWSLETTER_TONE_DESC_ = {
  warm: '丁寧語のまま、温かみと親しみのある書き方',
  formal: '丁寧で改まった書き方',
  casual: '丁寧語のまま、やわらかく気軽に読める書き方',
  energetic: '丁寧語のまま、明るく前向きな書き方'
};

// 記事 1 本の形。見出しと本文を分けて受け取り、通信の「１．見出し」＋本文の形に組む
const NEWSLETTER_ARTICLE_SCHEMA_ = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING', description: '記事の見出し（番号は付けない）' },
    body: { type: 'STRING', description: '記事の本文（です・ます調、2〜5文）' }
  },
  required: ['title', 'body']
};

/**
 * 週案の 1 週間を、AI に渡す予定の文に直す。
 * 朝の活動・単元・宿題・持ち物まで入れる。お知らせの話題はたいてい
 * 「持ち物」「行事」「新しい単元の始まり」から生まれるため。
 * 日曜は通信に載らないので渡さない。
 * @param {Object[]} days getNewsletterData().days
 * @returns {string}
 */
function buildNewsletterScheduleContext_(days) {
  const oneLine = v => String(v == null ? '' : v).replace(/\s*[\r\n]+\s*/g, '、').trim();
  let text = '\n【この週の予定（週案より）】\n';
  (days || []).slice(0, 6).forEach(day => {
    const parts = [];
    if (day.holiday) parts.push(`祝日:${oneLine(day.holiday)}`);
    if (day.event) parts.push(`行事:${oneLine(day.event)}`);
    if (day.morning) parts.push(`朝:${oneLine(day.morning)}`);
    (day.periods || []).forEach((p, i) => {
      if (p && p.subject) parts.push(`${i + 1}時間目:${oneLine(p.subject)}${p.unit ? '（' + oneLine(p.unit) + '）' : ''}`);
    });
    if (day.homework) parts.push(`宿題:${oneLine(day.homework)}`);
    if (day.items) parts.push(`持ち物:${oneLine(day.items)}`);
    text += `${day.dayLabel}(${day.date}): ${parts.join(' ') || '予定なし'}\n`;
  });
  return text;
}

/** 週案を読んで予定の文にする。読めなくても生成そのものは止めない */
function newsletterScheduleContextFor_(mondayDateStr) {
  try {
    const data = getNewsletterData(mondayDateStr);
    if (data.success && data.days) return buildNewsletterScheduleContext_(data.days);
  } catch (ignore) { }
  return '';
}

/**
 * AI が返した記事の配列を、通信に載せられる形にそろえる。
 * 見出しの頭に AI が付けがちな「１．」「1.」「■」は落とす（番号は通信側で振る）。
 * @param {Array} items [{ title, body }]
 * @returns {Array} [{ title, body }]（空のものは除く）
 */
function normalizeNewsletterArticles_(items) {
  return (Array.isArray(items) ? items : [])
    .map(it => ({
      title: String((it && it.title) || '')
        .replace(/^\s*(?:[0-9０-９]+\s*[.．、)）]|[■□●○◆◇・★☆]+)\s*/, '')
        .trim(),
      body: String((it && it.body) || '').trim()
    }))
    .filter(it => it.title || it.body);
}

/**
 * [Webアプリ API] 学級通信の本文をGemini AIで自動生成する
 * @param {string} mondayDateStr "YYYY/MM/DD" 形式の月曜日
 * @param {string} genType 生成タイプ (article, intro, event, study, notice, closing, safety, praise, free)
 * @param {string} extraInstructions 追加指示
 * @param {Object} options { tone, length }
 * @returns {Object} article のときは { success, title, text }、ほかは { success, text }
 */
function generateNewsletterAI(mondayDateStr, genType, extraInstructions, options) {
  try {
    options = options || {};
    const tone = options.tone || 'warm';
    const length = options.length || 'medium';
    const scheduleContext = newsletterScheduleContextFor_(mondayDateStr);
    const extra = extraInstructions ? '\n【先生からの指示（いちばん優先する）】\n' + extraInstructions : '';

    // お知らせ記事 1 本。見出しと本文を分けて返す
    if (genType === 'article') {
      const prompt = `あなたは小学校の担任教員です。保護者向けの学級通信に載せる「お知らせ」の記事を1本書いてください。
${NEWSLETTER_TONE_DESC_[tone] || NEWSLETTER_TONE_DESC_.warm}で書いてください。

【書き方】
${NEWSLETTER_ARTICLE_STYLE_}

先生の指示があればその話題で書く。無ければ、予定の中から家庭の準備や協力がいちばん要るものを1つ選ぶ。
${scheduleContext}${extra}`;
      const articles = normalizeNewsletterArticles_(callGeminiJsonArray_(
        prompt, NEWSLETTER_ARTICLE_SCHEMA_, '学級通信のお知らせ記事（1本）', 'Gemini Newsletter Article Error', 0.6));
      if (!articles.length) return { success: false, error: 'AIが記事を生成できませんでした。再度お試しください。' };
      return { success: true, title: articles[0].title, text: articles[0].body };
    }

    const lengthDesc = {
      short: '2〜3文の簡潔な文章',
      medium: '3〜5文の標準的な長さの文章',
      long: '5〜8文のしっかりした文章'
    };

    const typePrompts = {
      intro: '学級通信の冒頭に掲載する「今週のあいさつ文・はじめの文」を書いてください。季節感や子どもたちの成長に触れてください。',
      event: '今週の行事やイベントを紹介する文章を書いてください。保護者が読んで楽しめるよう、子どもたちの様子や準備のことにも触れてください。',
      study: '今週の学習内容や授業の様子を保護者に伝える文章を書いてください。子どもたちが頑張っていることや成長したことを具体的に触れてください。',
      notice: '保護者へのお知らせ・連絡事項を書いてください。何のためか、家庭で何を準備してほしいか（持ち物・期日）を具体的に、丁寧だが簡潔に書いてください。',
      closing: '学級通信の最後に載せる「結びの文」を書いてください。来週への期待や保護者への感謝を込めてください。',
      safety: '安全に関するお知らせや注意喚起を書いてください。季節に応じた安全指導の内容を含めてください。',
      praise: '子どもたちの頑張りや良い行動を紹介する「キラキラコーナー」の文章を書いてください。具体的な場面を交えて褒めてください。子どもの名前は書かないでください。',
      free: '学級通信に掲載する文章を書いてください。'
    };

    const prompt = `あなたは小学校の担任教員です。保護者向けの学級通信の本文を日本語で作成してください。
文章のみを出力し、タイトルや装飾、箇条書きは不要です。${NEWSLETTER_TONE_DESC_[tone] || NEWSLETTER_TONE_DESC_.warm}で書いてください。
${lengthDesc[length] || lengthDesc.medium}にしてください。
予定に書かれていない行事・持ち物・日付を作り出さないでください。子どもの名前は書かないでください。

${typePrompts[genType] || typePrompts.free}
${scheduleContext}${extra}`;

    const text = callGeminiAPIText_(prompt);
    return { success: true, text: text };

  } catch (e) {
    logError('generateNewsletterAI', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 学級通信の「お知らせ」記事をまとめて生成する。
 *
 * 以前は「タイトル・あいさつ・学習の様子・お知らせ・結び」を作っていたが、
 * 先生が実際に出している通信は「週予定の表＋お知らせ 1〜2 本」の形で、
 * あいさつや結びは書いていない。表は週案から組むので、AI には記事だけを書かせる。
 *
 * @param {string} mondayDateStr "YYYY/MM/DD" 形式の月曜日
 * @param {string} extraInstructions 追加指示
 * @param {Object} options { tone: string, count: number(1〜3) }
 * @returns {Object} { success, articles: [{ title, body }] }
 */
function generateFullNewsletterAI(mondayDateStr, extraInstructions, options) {
  try {
    options = options || {};
    const tone = options.tone || 'warm';
    const count = Math.min(3, Math.max(1, parseInt(options.count, 10) || 2));
    const scheduleContext = newsletterScheduleContextFor_(mondayDateStr);

    const prompt = `あなたは小学校の担任教員です。保護者向けの学級通信の「お知らせ」欄に載せる記事を${count}本書いてください。
${NEWSLETTER_TONE_DESC_[tone] || NEWSLETTER_TONE_DESC_.warm}で書いてください。

【書き方】
${NEWSLETTER_ARTICLE_STYLE_}

【話題の選び方】
・予定の中から、家庭の準備や協力が要るもの（持ち物・服装・行事・提出物・新しい単元や教科書の切り替わり）を優先する。
・その次に、子どもたちががんばっている学習や行事の練習の様子を選ぶ。
・同じ話題を2本に分けない。家庭にしてほしいことがある記事を先に並べる。
${scheduleContext}${extraInstructions ? '\n【先生からの指示（いちばん優先する）】\n' + extraInstructions : ''}`;

    const articles = normalizeNewsletterArticles_(callGeminiJsonArray_(
      prompt, NEWSLETTER_ARTICLE_SCHEMA_, `学級通信のお知らせ記事（${count}本）`,
      'Gemini Newsletter Articles Error', 0.6)).slice(0, count);

    if (articles.length === 0) {
      return { success: false, error: 'AIが記事を生成できませんでした。再度お試しください。' };
    }
    return { success: true, articles: articles };

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
保護者向けの丁寧語（です・ます）のままにし、元の文章に無い日付・持ち物・子どもの名前を足さないでください。

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
 * [内部] 本日の学習予定をもとに、「今日の様子」の**下書き**を作ります。
 *
 * ここで返るのは下書きであって、事実の記録ではありません。AIに渡しているのは「予定」だけで、
 * 授業が実際に行われたかどうか、児童がどう反応したかは分かりません。
 * **この戻り値を、教員が読んで直す工程を経ずに Classroom へ投稿してはいけません。**
 * （かつては予定から「実際に行われた前提」の文章を作り、確認なしで保護者へ自動配信していました。
 *   見ていない児童の様子が学校名義で届くため取りやめています。docs/LEGAL_RISK_AUDIT_JP.md の A-3）
 *
 * Gemini を利用。APIキー未設定や生成失敗時は空文字を返し、呼び出し側が「下書きなし」として
 * 扱えるようにします（予定だけの投稿は妨げません）。
 * @param {string} dateLabel 例 "2026/05/27（火）"
 * @param {string} lessonContext 本日の授業内容のテキスト（buildLessonContext_ の戻り値）
 * @returns {string} 生成された下書き（失敗時は空文字）
 */
function generateTodaySituationDraft_(dateLabel, lessonContext) {
  try {
    if (!lessonContext || !lessonContext.trim()) return '';

    // セキュリティ: 入力長を制限（プロンプトインジェクション・過大入力対策）
    const sanitized = lessonContext.length > 3000 ? lessonContext.substring(0, 3000) : lessonContext;

    const prompt = `あなたは小学校の担任教員を手伝うアシスタントです。
${dateLabel}の学習予定をもとに、保護者向けの「今日の様子」の下書きを作成してください。
これは下書きであり、担任が必ず読んで加筆・修正してから使います。

【前提】
- 以下に示すのは「予定」です。授業が実際に行われたかどうかは分かりません。

【条件】
- 事実として使ってよいのは、下の予定に書かれた教科・単元・学習内容だけです。
- 予定に書かれていない出来事を書かないでください。特に、児童の反応・発言・様子・成果
  （例：「発表しました」「盛り上がりました」「全員できました」）は書かないでください。
- 特定の児童・班・座席に触れないでください。
- 実施したと断定せず、その日に扱う学習内容の紹介にとどめてください。
- 3〜4文程度の自然な日本語の文章にしてください。
- 箇条書き・見出し・絵文字は使わず、文章のみを出力してください。前置きや説明は付けないでください。

【学習予定】
${sanitized}`;

    const text = callGeminiAPIText_(prompt);
    return (text || '').trim();
  } catch (e) {
    logError('generateTodaySituationDraft_', e);
    return ''; // 失敗時は空文字を返し、予定だけの投稿は続けられるようにする
  }
}

// タスク抽出（週案・テキスト・PDF）は extractTasksCombined_WebApp に統合しました（本ファイル上部）。
