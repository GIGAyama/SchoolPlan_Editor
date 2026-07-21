/** @fileoverview Phase 5: AI提案の検証、プレビュー、明示承認後の適用。 */

const P5_WEEK_TEXT_FIELDS_ = ['event', 'preclass', 'morning', 'recess1', 'recess2', 'afterschool', 'homework', 'items'];
const P5_PERIOD_FIELDS_ = ['subject', 'unit', 'content'];

function p5FindWeekForDate_(context, dateStr) {
  const weeks = [context.currentWeek, context.nextWeek].filter(Boolean);
  return weeks.find(week => (week.days || []).some(day => day.date === dateStr)) || null;
}

function p5ReadProposalBefore_(week, dateStr, field, period) {
  const day = week && (week.days || []).find(item => item.date === dateStr);
  if (!day) return '';
  if (P5_WEEK_TEXT_FIELDS_.includes(field)) return String(day[field] || '');
  if (P5_PERIOD_FIELDS_.includes(field)) {
    const p = (day.periods || [])[period - 1] || {};
    return String(p[field] || '');
  }
  return '';
}

function p5CanonicalizeProposal_(item, context) {
  if (!item || !item.actionType || item.actionType === 'none') return null;
  const actionType = String(item.actionType);
  const base = {
    actionType,
    title: p5CleanUserText_(item.title, 180) || 'AIからの提案',
    reason: p5CleanUserText_(item.reason, 800),
    confidence: Math.max(0, Math.min(1, Number(item.confidence || 0))),
    contextFingerprint: context.fingerprint,
    createdAt: new Date().toISOString()
  };

  if (actionType === 'task.create') {
    const content = p5CleanUserText_(item.taskContent || item.value, 500);
    if (!content) return null;
    const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(item.dueDate || '')) ? String(item.dueDate) : '';
    return Object.assign(base, {
      payload: {
        content,
        resource: p5CleanUserText_(item.resource, 500),
        dueDate,
        source: 'AIコパイロット（教師確認済み）',
        priority: ['高', '中', '低'].includes(item.priority) ? item.priority : '中',
        memo: 'AI提案を教師が確認して追加'
      },
      preview: { before: '', after: content, target: dueDate ? '期限 ' + dueDate : '期限未設定' }
    });
  }

  if (actionType === 'weeklyPlan.patch') {
    const targetDate = /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(String(item.targetDate || '')) ? String(item.targetDate) : '';
    const field = String(item.field || '');
    const period = parseInt(item.period || 0, 10);
    const isText = P5_WEEK_TEXT_FIELDS_.includes(field);
    const isPeriod = P5_PERIOD_FIELDS_.includes(field) && period >= 1 && period <= 6;
    const week = p5FindWeekForDate_(context, targetDate);
    if (!targetDate || (!isText && !isPeriod) || !week) return null;
    const value = p5CleanUserText_(item.value, field === 'content' ? 1500 : 600);
    const before = p5ReadProposalBefore_(week, targetDate, field, period);
    return Object.assign(base, {
      payload: {
        mondayDateStr: week.mondayDateStr,
        baseRevision: week.revision,
        targetDate,
        field,
        period: isPeriod ? period : 0,
        value,
        expectedBefore: before
      },
      preview: {
        before,
        after: value,
        target: targetDate + ' ' + (isPeriod ? period + '校時 ' : '') + field
      }
    });
  }

  if (actionType === 'reflection.draft') {
    const draft = p5CleanUserText_(item.draftText || item.value, 5000);
    if (!draft) return null;
    const targetDate = /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(String(item.targetDate || '')) ? String(item.targetDate) : '';
    return Object.assign(base, {
      payload: { targetDate, draftText: draft },
      preview: { before: '', after: draft, target: targetDate ? targetDate + ' の振り返り下書き' : '振り返り下書き' }
    });
  }

  if (actionType === 'newsletter.draft') {
    const draft = p5CleanUserText_(item.draftText || item.value, 8000);
    if (!draft) return null;
    return Object.assign(base, {
      payload: { newsletterType: p5CleanUserText_(item.newsletterType, 80), draftText: draft },
      preview: { before: '', after: draft, target: '学級通信の下書き' }
    });
  }
  return null;
}

function p5PublicProposal_(proposal) {
  return {
    id: proposal.id,
    actionType: proposal.actionType,
    title: proposal.title,
    reason: proposal.reason,
    confidence: proposal.confidence,
    preview: proposal.preview,
    expiresAt: proposal.expiresAt,
    requiresConfirmation: true
  };
}

function p5LoadProposal_(proposalId) {
  if (!/^p5p_[0-9a-f-]{20,}$/i.test(String(proposalId || ''))) throw new Error('提案IDが無効です。');
  const cache = CacheService.getUserCache();
  const raw = cache.get('p5:proposal:' + proposalId);
  if (!raw) throw new Error('この提案は期限切れです。AIへもう一度相談してください。');
  const proposal = JSON.parse(raw);
  if (!proposal || proposal.id !== proposalId) throw new Error('提案データを確認できません。');
  return proposal;
}

function p5CurrentPatchValue_(days, targetDate, field, period) {
  const day = (days || []).find(item => item.date === targetDate);
  if (!day) throw new Error('対象日の週案行が見つかりません。');
  if (P5_WEEK_TEXT_FIELDS_.includes(field)) return String(day[field] || '');
  const p = (day.periods || [])[period - 1];
  if (!p) throw new Error('対象校時が見つかりません。');
  return String(p[field] || '');
}

function p5ApplyPatchToDays_(days, payload) {
  const clone = JSON.parse(JSON.stringify(days || []));
  const day = clone.find(item => item.date === payload.targetDate);
  if (!day) throw new Error('対象日の週案行が見つかりません。');
  if (P5_WEEK_TEXT_FIELDS_.includes(payload.field)) {
    day[payload.field] = payload.value;
  } else if (P5_PERIOD_FIELDS_.includes(payload.field)) {
    if (!Array.isArray(day.periods) || !day.periods[payload.period - 1]) throw new Error('対象校時が見つかりません。');
    day.periods[payload.period - 1][payload.field] = payload.value;
  } else {
    throw new Error('変更対象フィールドが許可されていません。');
  }
  return clone;
}

function p5ApplyTaskProposal_(proposal) {
  const task = proposal.payload;
  const existingResult = getTasksFromWebApp();
  const existing = existingResult && existingResult.success && Array.isArray(existingResult.tasks) ? existingResult.tasks : [];
  const normalized = task.content.replace(/\s+/g, '').toLowerCase();
  const duplicate = existing.some(item =>
    String(item.status || '') !== '完了' &&
    String(item.content || '').replace(/\s+/g, '').toLowerCase() === normalized &&
    String(item.dueDate || '') === String(task.dueDate || '')
  );
  if (duplicate) throw new Error('同じ内容・期日の未完了タスクが既にあります。');
  const result = saveTasksFromWebApp([task]);
  if (!result || !result.success) throw new Error((result && result.error) || 'タスクを追加できませんでした。');
  return { message: 'タスクを追加しました。', refresh: ['tasks'], result: { savedCount: (result.savedTasks || []).length } };
}

function p5ApplyWeeklyPatchProposal_(proposal) {
  const payload = proposal.payload;
  const current = typeof getWeeklyPlanDataV2 === 'function'
    ? getWeeklyPlanDataV2(payload.mondayDateStr)
    : getWeeklyPlanData(payload.mondayDateStr);
  if (!current || !current.success) throw new Error((current && current.error) || '最新の週案を取得できませんでした。');
  if (payload.baseRevision && current.revision !== payload.baseRevision) {
    throw new Error('AI提案の作成後に週案が更新されています。最新データで相談し直してください。');
  }
  const currentValue = p5CurrentPatchValue_(current.days, payload.targetDate, payload.field, payload.period);
  if (currentValue !== String(payload.expectedBefore || '')) {
    throw new Error('対象セルの内容が提案時から変わっています。上書きせず処理を停止しました。');
  }
  const patched = p5ApplyPatchToDays_(current.days, payload);
  const saved = typeof saveWeeklyPlanDataV2 === 'function'
    ? saveWeeklyPlanDataV2(payload.mondayDateStr, patched, current.revision)
    : saveWeeklyPlanData(payload.mondayDateStr, patched, current.revision);
  if (!saved || !saved.success) {
    if (saved && saved.conflict) throw new Error('保存直前に別の更新がありました。最新データで相談し直してください。');
    throw new Error((saved && saved.error) || '週案へ反映できませんでした。');
  }
  return { message: '週案の提案を1件反映しました。', refresh: ['weeklyPlan'], result: { revision: saved.revision || '' } };
}

function applyTeacherCopilotProposal(proposalId, confirmation) {
  const correlationId = 'p5a_' + Utilities.getUuid();
  try {
    if (!confirmation || confirmation.confirmed !== true) throw new Error('教師による明示確認が必要です。');
    const proposal = p5LoadProposal_(proposalId);
    let applied;
    if (proposal.actionType === 'task.create') applied = p5ApplyTaskProposal_(proposal);
    else if (proposal.actionType === 'weeklyPlan.patch') applied = p5ApplyWeeklyPatchProposal_(proposal);
    else if (proposal.actionType === 'reflection.draft') {
      applied = { message: '振り返りの下書きを準備しました。内容を確認してから利用してください。', refresh: [], clientAction: { type: 'draft', target: 'reflection', data: proposal.payload } };
    } else if (proposal.actionType === 'newsletter.draft') {
      applied = { message: '学級通信の下書きを準備しました。内容を確認してから利用してください。', refresh: [], clientAction: { type: 'draft', target: 'newsletter', data: proposal.payload } };
    } else {
      throw new Error('この提案形式には対応していません。');
    }

    CacheService.getUserCache().remove('p5:proposal:' + proposalId);
    if (typeof p3RecordAudit_ === 'function') {
      p3RecordAudit_(
        'AI_PROPOSAL_APPLY', 'ai_proposal', proposalId,
        'AI提案を教師の明示確認後に適用',
        null,
        { actionType: proposal.actionType, target: proposal.preview && proposal.preview.target },
        correlationId
      );
    }
    return { success: true, proposalId, actionType: proposal.actionType, message: applied.message, refresh: applied.refresh || [], clientAction: applied.clientAction || null, result: applied.result || null };
  } catch (e) {
    logError('applyTeacherCopilotProposal', e);
    if (typeof p3RecordAudit_ === 'function') {
      p3RecordAudit_('AI_PROPOSAL_APPLY_ERROR', 'ai_proposal', String(proposalId || ''), 'AI提案の適用を停止', null, { errorType: e.name || 'Error' }, correlationId);
    }
    return { success: false, error: e.message, proposalId };
  }
}

function rejectTeacherCopilotProposal(proposalId) {
  try {
    const proposal = p5LoadProposal_(proposalId);
    CacheService.getUserCache().remove('p5:proposal:' + proposalId);
    if (typeof p3RecordAudit_ === 'function') {
      p3RecordAudit_('AI_PROPOSAL_REJECT', 'ai_proposal', proposalId, 'AI提案を教師が却下', null, { actionType: proposal.actionType }, proposal.sessionId || '');
    }
    return { success: true, proposalId };
  } catch (e) {
    return { success: false, error: e.message, proposalId };
  }
}
