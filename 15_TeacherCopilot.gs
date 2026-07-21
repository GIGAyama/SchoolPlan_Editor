/**
 * @fileoverview Phase 5: 教師向けAIコパイロットの対話・提案基盤。
 *
 * 安全原則:
 * - AIは提案のみを生成し、明示確認なしにデータを書き換えない。
 * - 生の会話、プロンプト、回答はスプレッドシートへ保存しない。
 * - 児童・保護者情報を含み得る自由記述は利用者が選択した場合だけ送信する。
 * - AIへ渡すアプリ内データは必要最小限に整形・短縮する。
 * - データブロック内の命令はプロンプトとして扱わない。
 */

const P5_COPILOT_VERSION_ = 5;
const P5_PROPOSAL_TTL_SECONDS_ = 1800;
const P5_MAX_QUESTION_LENGTH_ = 4000;
const P5_MAX_CONVERSATION_CHARS_ = 7000;
const P5_MAX_PROPOSALS_ = 8;

const P5_MODES_ = [
  { id: 'dailyBrief', label: '今日のブリーフ', description: '今日・今週の予定と未完了タスクから、優先順位と注意点を整理します。', icon: 'wb_sunny' },
  { id: 'weeklyPlan', label: '週案レビュー', description: '週案の抜け・偏り・準備事項を点検し、修正候補を提案します。', icon: 'calendar_view_week' },
  { id: 'lessonDesign', label: '授業デザイン', description: '単元、時数、学習内容を踏まえて授業案や問いを考えます。', icon: 'school' },
  { id: 'workload', label: '校務整理', description: 'タスクの優先順位、まとめ方、期限のリスクを整理します。', icon: 'task_alt' },
  { id: 'reflectionCoach', label: '振り返り支援', description: '日々の振り返りから成果・課題・次の一手を言語化します。', icon: 'rate_review' },
  { id: 'communication', label: '保護者連絡', description: '週案に基づくお知らせや学級通信の下書きを提案します。', icon: 'campaign' },
  { id: 'report', label: '報告文作成', description: '管理職や学年会向けの簡潔な進捗・課題報告を作成します。', icon: 'summarize' },
  { id: 'riskCheck', label: 'リスク点検', description: '行事、準備、時数、期限、連絡の見落とし候補を点検します。', icon: 'policy' }
];

function p5Mode_(modeId) {
  return P5_MODES_.find(mode => mode.id === modeId) || P5_MODES_[0];
}

function p5Text_(value, maxLength) {
  const text = value === null || value === undefined ? '' : String(value);
  const limit = maxLength || 1000;
  return text.length > limit ? text.substring(0, limit) + '…' : text;
}

function p5CleanUserText_(value, maxLength) {
  return p5Text_(value, maxLength)
    .replace(/\u0000/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .trim();
}

function p5RedactDirectIdentifiers_(value) {
  return p5Text_(value, 12000)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[メールアドレス]')
    .replace(/(?:\+?81[-\s]?)?0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}/g, '[電話番号]')
    .replace(/\b\d{10,16}\b/g, '[識別番号]');
}

function p5DetectPrivacyWarnings_(text) {
  const warnings = [];
  const value = String(text || '');
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)) warnings.push('メールアドレスらしき文字列を検出しました。AI送信時は伏せ字にします。');
  if (/(?:\+?81[-\s]?)?0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}/.test(value)) warnings.push('電話番号らしき文字列を検出しました。AI送信時は伏せ字にします。');
  if (/診断|障害|服薬|投薬|家庭環境|虐待|不登校|個別の指導計画/.test(value)) warnings.push('要配慮情報を含む可能性があります。個人を特定できる表現を避けてください。');
  return warnings;
}

function p5ApiConfigured_() {
  try {
    return !!getApiKeySafe_();
  } catch (e) {
    return false;
  }
}

function p5RateLimit_() {
  const cache = CacheService.getUserCache();
  const now = Date.now();
  const last = parseInt(cache.get('p5:last-request') || '0', 10);
  if (last && now - last < 2500) {
    throw new Error('AIへの連続送信を抑制しています。少し待ってから再度お試しください。');
  }
  const hourKey = 'p5:hour:' + Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Tokyo', 'yyyyMMddHH');
  const count = parseInt(cache.get(hourKey) || '0', 10);
  if (count >= 40) throw new Error('この1時間のAI利用上限に達しました。時間を置いてから再度お試しください。');
  cache.put('p5:last-request', String(now), 60);
  cache.put(hourKey, String(count + 1), 3600);
}

function getTeacherCopilotBootstrap(mondayDateStr) {
  try {
    const monday = /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(String(mondayDateStr || ''))
      ? String(mondayDateStr)
      : getTodaysMondayStr();
    const gradeResult = typeof getGrade === 'function' ? getGrade() : { success: false };
    return {
      success: true,
      version: P5_COPILOT_VERSION_,
      configured: p5ApiConfigured_(),
      model: typeof getGeminiModelNameSafe_ === 'function' ? getGeminiModelNameSafe_() : '',
      mondayDateStr: monday,
      grade: gradeResult && gradeResult.success ? gradeResult.grade : null,
      modes: P5_MODES_,
      defaultMode: 'dailyBrief',
      defaultScope: {
        currentWeek: true,
        nextWeek: true,
        tasks: true,
        hours: true,
        unitMaster: false,
        reflections: false
      },
      privacy: {
        rawConversationPersisted: false,
        proposalTtlMinutes: Math.floor(P5_PROPOSAL_TTL_SECONDS_ / 60),
        reflectionsOptIn: true,
        directIdentifiersRedacted: true
      }
    };
  } catch (e) {
    logError('getTeacherCopilotBootstrap', e);
    return { success: false, error: e.message };
  }
}

function p5StructuredSchema_() {
  return {
    type: 'OBJECT',
    properties: {
      answer: { type: 'STRING', description: '教師への回答本文。日本語のプレーンテキスト。' },
      overview: { type: 'STRING', description: '回答を一文で要約した見出し。' },
      evidence: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            source: { type: 'STRING', description: '根拠となるsourceId。' },
            label: { type: 'STRING', description: '根拠の短い名称。' },
            detail: { type: 'STRING', description: '根拠の内容。' }
          },
          required: ['source', 'label', 'detail']
        }
      },
      risks: { type: 'ARRAY', items: { type: 'STRING' } },
      questions: { type: 'ARRAY', items: { type: 'STRING' } },
      proposals: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            actionType: { type: 'STRING', enum: ['none', 'task.create', 'weeklyPlan.patch', 'reflection.draft', 'newsletter.draft'] },
            title: { type: 'STRING' },
            reason: { type: 'STRING' },
            confidence: { type: 'NUMBER' },
            targetDate: { type: 'STRING', description: 'YYYY/MM/DD。対象がない場合は空文字。' },
            field: { type: 'STRING', description: '週案フィールド。event,preclass,morning,recess1,recess2,afterschool,homework,items,subject,unit,content。' },
            period: { type: 'INTEGER', description: '校時1〜6。不要なら0。' },
            value: { type: 'STRING' },
            taskContent: { type: 'STRING' },
            resource: { type: 'STRING' },
            dueDate: { type: 'STRING', description: 'YYYY-MM-DD。不要なら空文字。' },
            priority: { type: 'STRING', enum: ['高', '中', '低'] },
            draftText: { type: 'STRING' },
            newsletterType: { type: 'STRING' }
          },
          required: ['actionType', 'title', 'reason', 'confidence']
        }
      }
    },
    required: ['answer', 'overview', 'evidence', 'risks', 'questions', 'proposals']
  };
}

function p5CallCopilotModel_(prompt) {
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.25,
      maxOutputTokens: 5000,
      responseMimeType: 'application/json',
      responseSchema: p5StructuredSchema_()
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
    ]
  };
  const json = callGeminiEndpoint_(payload, 'Teacher Copilot');
  const candidate = json && json.candidates && json.candidates[0];
  const text = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0]
    ? candidate.content.parts[0].text
    : '';
  if (!text) throw new Error('AIから回答を取得できませんでした。');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('AI回答の構造を解析できませんでした。もう一度お試しください。');
  }
}

function p5NormalizeConversation_(conversation) {
  if (!Array.isArray(conversation)) return [];
  const normalized = [];
  let total = 0;
  conversation.slice(-6).forEach(item => {
    const role = item && item.role === 'assistant' ? 'assistant' : 'user';
    const text = p5RedactDirectIdentifiers_(p5CleanUserText_(item && item.text, 1800));
    if (!text || total >= P5_MAX_CONVERSATION_CHARS_) return;
    const clipped = p5Text_(text, Math.min(1800, P5_MAX_CONVERSATION_CHARS_ - total));
    normalized.push({ role, text: clipped });
    total += clipped.length;
  });
  return normalized;
}

function p5NormalizeResponse_(raw, context, sessionId) {
  raw = raw || {};
  const validSourceIds = {};
  (context.sources || []).forEach(source => { validSourceIds[source.id] = source; });

  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : []).slice(0, 12).map(item => {
    const sourceId = validSourceIds[item && item.source] ? item.source : 'teacher_question';
    return {
      source: sourceId,
      label: p5CleanUserText_(item && item.label, 120),
      detail: p5CleanUserText_(item && item.detail, 500)
    };
  });

  const proposals = [];
  (Array.isArray(raw.proposals) ? raw.proposals : []).slice(0, P5_MAX_PROPOSALS_).forEach(item => {
    const proposal = p5CanonicalizeProposal_(item, context);
    if (!proposal) return;
    proposal.id = 'p5p_' + Utilities.getUuid();
    proposal.sessionId = sessionId;
    proposal.expiresAt = new Date(Date.now() + P5_PROPOSAL_TTL_SECONDS_ * 1000).toISOString();
    CacheService.getUserCache().put('p5:proposal:' + proposal.id, JSON.stringify(proposal), P5_PROPOSAL_TTL_SECONDS_);
    proposals.push(p5PublicProposal_(proposal));
  });

  return {
    answer: p5CleanUserText_(raw.answer, 12000) || '回答を生成できませんでした。',
    overview: p5CleanUserText_(raw.overview, 240),
    evidence,
    risks: (Array.isArray(raw.risks) ? raw.risks : []).slice(0, 10).map(v => p5CleanUserText_(v, 500)).filter(Boolean),
    questions: (Array.isArray(raw.questions) ? raw.questions : []).slice(0, 6).map(v => p5CleanUserText_(v, 500)).filter(Boolean),
    proposals
  };
}

function runTeacherCopilot(request) {
  const startedAt = Date.now();
  const sessionId = 'p5s_' + Utilities.getUuid();
  try {
    if (!p5ApiConfigured_()) throw new Error('Gemini APIキーが設定されていません。設定画面でAPIキーを登録してください。');
    p5RateLimit_();
    request = request || {};
    const questionOriginal = p5CleanUserText_(request.question, P5_MAX_QUESTION_LENGTH_);
    if (!questionOriginal) throw new Error('相談内容を入力してください。');
    const mode = p5Mode_(p5CleanUserText_(request.mode, 40));
    const privacyWarnings = p5DetectPrivacyWarnings_(questionOriginal);
    const question = p5RedactDirectIdentifiers_(questionOriginal);
    const conversation = p5NormalizeConversation_(request.conversation);
    const context = p5BuildCopilotContext_({
      mondayDateStr: request.mondayDateStr,
      scope: request.scope || {},
      mode: mode.id
    });
    const prompt = p5BuildCopilotPrompt_(mode, question, conversation, context);
    const raw = p5CallCopilotModel_(prompt);
    const response = p5NormalizeResponse_(raw, context, sessionId);

    if (typeof p3RecordAudit_ === 'function') {
      p3RecordAudit_(
        'AI_COPILOT_RUN', 'ai_session', sessionId,
        '教師向けAIコパイロットを実行',
        null,
        {
          mode: mode.id,
          sourceIds: context.sources.map(source => source.id),
          proposalCount: response.proposals.length,
          durationMs: Date.now() - startedAt
        },
        sessionId
      );
    }

    return {
      success: true,
      sessionId,
      mode: mode.id,
      response,
      sources: context.sources,
      privacyWarnings,
      contextFingerprint: context.fingerprint,
      durationMs: Date.now() - startedAt,
      expiresInMinutes: Math.floor(P5_PROPOSAL_TTL_SECONDS_ / 60)
    };
  } catch (e) {
    logError('runTeacherCopilot', e);
    if (typeof p3RecordAudit_ === 'function') {
      p3RecordAudit_('AI_COPILOT_ERROR', 'ai_session', sessionId, '教師向けAIコパイロットでエラー', null, { errorType: e.name || 'Error' }, sessionId);
    }
    return { success: false, error: e.message, sessionId };
  }
}
