/**
 * @fileoverview 単元の時数再構成（B）と年間再配分（C）。
 *
 * 方針は既存の applyAiOptimization_（04_AutoFill.gs）と揃えている:
 *  - まず機械的に決められることは機械的に決める
 *  - AIの出力は必ずルールで検証し、1つでも違反したら提案全体を破棄する
 *  - 書き込みは必ず人がプレビューで確認してから
 *
 * さらに単元マスタ固有の制約として、**週案で既に指導済み・入力済みの時数は
 * AIに渡さず、書き換えの対象にもしない**（サーバー側でそのまま前置きして再結合する）。
 *
 * トップレベルでGAS APIを呼ばない（テストで vm.runInContext に読み込めるようにするため）。
 */

/** 学習活動テキストの長さの許容範囲。短すぎ・長すぎはAIの失敗とみなす。 */
const P5_ACTIVITY_MIN_ = 10;
const P5_ACTIVITY_MAX_ = 600;
/** 1単元に許す時数の上限（極端な提案を弾くための安全弁）。 */
const P5_UNIT_HOURS_MAX_ = 60;

// ===================================================
// ===== AI出力の検証（純粋関数・テスト対象） =====
// ===================================================

/**
 * 単元再構成のAI出力を検証します。1つでも違反があれば提案全体を破棄します。
 *
 * @param {Array} items AIが返した配列
 * @param {number} startHour 生成させた最初の時間目（= ロック数 + 1）
 * @param {number} endHour 生成させた最後の時間目（= 目標時数）
 * @returns {{ok: boolean, error?: string, hours?: Array<{hour:number, activity:string}>}}
 */
function validateRecomposition_(items, startHour, endHour) {
  const expected = endHour - startHour + 1;
  if (!Array.isArray(items)) return { ok: false, error: 'AIの出力が配列ではありません。' };
  if (items.length !== expected) {
    return { ok: false, error: '必要な時間数（' + expected + '件）と異なる' + items.length + '件が返されました。' };
  }

  const seen = {};
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it !== 'object') return { ok: false, error: '不正な要素が含まれています。' };

    const hour = parseInt(it.hour, 10);
    if (isNaN(hour) || hour < startHour || hour > endHour) {
      return { ok: false, error: '範囲外の時間目（' + it.hour + '）が含まれています。' };
    }
    if (seen[hour]) return { ok: false, error: '時間目が重複しています（' + hour + '時間目）。' };
    seen[hour] = true;

    let activity = (it.activity === null || it.activity === undefined) ? '' : String(it.activity);
    // 改行を統一し、改行・タブ以外の制御文字は取り除く
    activity = activity.replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    const trimmed = activity.trim();
    if (trimmed.length < P5_ACTIVITY_MIN_) {
      return { ok: false, error: hour + '時間目の学習活動が短すぎます。' };
    }
    if (trimmed.length > P5_ACTIVITY_MAX_) {
      return { ok: false, error: hour + '時間目の学習活動が長すぎます。' };
    }
    // 既存の「見つかりませんでした」系プレースホルダをAIが真似て返すことがある
    if (trimmed.indexOf('（単元マスタに') !== -1 || trimmed.indexOf('※単元マスタに') !== -1) {
      return { ok: false, error: hour + '時間目の内容が不正です（プレースホルダが含まれています）。' };
    }
    out.push({ hour: hour, activity: trimmed });
  }

  // 欠番が無いことを確認（重複が無く件数が一致していれば理論上は埋まるが、明示的に検査する）
  for (let h = startHour; h <= endHour; h++) {
    if (!seen[h]) return { ok: false, error: h + '時間目が欠けています。' };
  }

  out.sort(function (a, b) { return a.hour - b.hour; });
  return { ok: true, hours: out };
}

/**
 * 年間再配分のAI出力を検証します。
 * 合計が目標から ±2 以内のズレなら決定的に補正し、それを超えるなら破棄します。
 *
 * @param {Array} items AIが返した配列 [{unitName, proposedTotal, reason}]
 * @param {Array<{unitName:string, currentTotal:number, minHours:number}>} remainingUnits
 * @param {number} targetTotal 目標の合計時数
 * @returns {{ok: boolean, error?: string, allocation?: Array}}
 */
function validateReallocation_(items, remainingUnits, targetTotal) {
  if (!Array.isArray(items)) return { ok: false, error: 'AIの出力が配列ではありません。' };
  if (items.length !== remainingUnits.length) {
    return { ok: false, error: '対象単元数（' + remainingUnits.length + '）と異なる' + items.length + '件が返されました。' };
  }

  const byName = {};
  remainingUnits.forEach(function (u) { byName[u.unitName] = u; });

  const seen = {};
  const alloc = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || !it.unitName) return { ok: false, error: '単元名の無い要素が含まれています。' };
    const name = String(it.unitName).trim();
    const src = byName[name];
    if (!src) return { ok: false, error: '対象外の単元「' + name + '」が含まれています。' };
    if (seen[name]) return { ok: false, error: '単元「' + name + '」が重複しています。' };
    seen[name] = true;

    const total = parseInt(it.proposedTotal, 10);
    if (isNaN(total)) return { ok: false, error: '単元「' + name + '」の時数が数値ではありません。' };
    if (total < src.minHours) {
      return { ok: false, error: '単元「' + name + '」は既に' + src.minHours + '時間まで指導・入力済みのため、それを下回れません。' };
    }
    const cap = Math.min(Math.max(src.currentTotal * 2, src.minHours), P5_UNIT_HOURS_MAX_);
    if (total > cap) {
      return { ok: false, error: '単元「' + name + '」の時数（' + total + '）が大きすぎます。' };
    }
    alloc.push({
      unitName: name,
      currentTotal: src.currentTotal,
      proposedTotal: total,
      minHours: src.minHours,
      reason: it.reason ? String(it.reason).substring(0, 60) : ''
    });
  }

  let sum = alloc.reduce(function (a, x) { return a + x.proposedTotal; }, 0);
  const diff = targetTotal - sum;
  if (Math.abs(diff) > 2) {
    return { ok: false, error: '合計が目標（' + targetTotal + '時間）と' + Math.abs(diff) + '時間ずれています。' };
  }
  if (diff !== 0) {
    // ±2以内のズレは決定的に補正する（時数の大きい単元から順に1時間ずつ）
    const order = alloc.slice().sort(function (a, b) {
      return b.proposedTotal - a.proposedTotal || (a.unitName < b.unitName ? -1 : 1);
    });
    let remain = diff;
    for (let pass = 0; pass < 3 && remain !== 0; pass++) {
      for (let i = 0; i < order.length && remain !== 0; i++) {
        const step = remain > 0 ? 1 : -1;
        const next = order[i].proposedTotal + step;
        if (next < order[i].minHours) continue;
        if (next > P5_UNIT_HOURS_MAX_) continue;
        order[i].proposedTotal = next;
        remain -= step;
      }
    }
    if (remain !== 0) return { ok: false, error: '合計を目標時数に合わせられませんでした。' };
  }

  alloc.forEach(function (x) { x.delta = x.proposedTotal - x.currentTotal; });
  return { ok: true, allocation: alloc };
}

/**
 * 目標合計に向けた比例配分のルールベース案を作ります（AIが失敗しても必ずこれを返せる）。
 * @param {Array<{unitName:string, currentTotal:number, minHours:number}>} remainingUnits
 * @param {number} targetTotal
 * @returns {Array<{unitName, currentTotal, proposedTotal, minHours, delta, reason}>}
 */
function buildReallocationBaseline_(remainingUnits, targetTotal) {
  const minSum = remainingUnits.reduce(function (a, u) { return a + u.minHours; }, 0);
  const target = Math.max(targetTotal, minSum);
  const currentSum = remainingUnits.reduce(function (a, u) { return a + u.currentTotal; }, 0);

  const out = remainingUnits.map(function (u) {
    const scaled = currentSum > 0 ? Math.round(u.currentTotal * target / currentSum) : u.minHours;
    return {
      unitName: u.unitName,
      currentTotal: u.currentTotal,
      minHours: u.minHours,
      proposedTotal: Math.max(scaled, u.minHours, 1),
      reason: ''
    };
  });

  // 端数を決定的に吸収する
  let sum = out.reduce(function (a, x) { return a + x.proposedTotal; }, 0);
  const order = out.slice().sort(function (a, b) {
    return b.proposedTotal - a.proposedTotal || (a.unitName < b.unitName ? -1 : 1);
  });
  let guard = 0;
  while (sum !== target && guard++ < 500) {
    const step = sum < target ? 1 : -1;
    let moved = false;
    for (let i = 0; i < order.length; i++) {
      const next = order[i].proposedTotal + step;
      if (next < order[i].minHours || next > P5_UNIT_HOURS_MAX_) continue;
      order[i].proposedTotal = next;
      sum += step;
      moved = true;
      if (sum === target) break;
    }
    if (!moved) break;
  }

  out.forEach(function (x) { x.delta = x.proposedTotal - x.currentTotal; });
  return out;
}

// ===================================================
// ===== 単元の時数再構成（B） =====
// ===================================================

/** 単元マスタと週案から、対象単元の現状（行・ロック時数）を取り出す内部ヘルパー。 */
function p5LoadUnitContext_(subject, unitName) {
  const ss = getSs_();
  const sheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
  if (!sheet || sheet.getLastRow() < 2) throw new Error('単元マスタにデータがありません。');

  const all = sheet.getRange(1, 1, sheet.getLastRow(), P4_MASTER_WIDTH_).getValues();
  const name = String(unitName).trim();
  const rows = [];
  const sheetRows = [];
  for (let i = 1; i < all.length; i++) {
    if (isSameSubject_(all[i][MASTER_COL_SUBJECT - 1], subject)
      && String(all[i][MASTER_COL_UNIT_NAME - 1]).trim() === name) {
      rows.push(all[i]);
      sheetRows.push(i + 1);
    }
  }
  if (rows.length === 0) throw new Error('単元「' + name + '」が単元マスタに見つかりません。');

  const contiguous = sheetRows.every(function (r, i) { return i === 0 || r === sheetRows[i - 1] + 1; });
  if (!contiguous) {
    throw new Error('単元「' + name + '」の行がシート上で連続していません。'
      + '「整合性チェック」で修復してから再度お試しください。');
  }

  // 何時間目の昇順に整えたうえで学習活動を取り出す
  const ordered = rows.map(function (r, i) {
    const h = parseInt(r[MASTER_COL_HOUR_NUM - 1], 10);
    return { hour: isNaN(h) ? Number.MAX_SAFE_INTEGER : h, idx: i, activity: String(r[MASTER_COL_ACTIVITY - 1] || '') };
  }).sort(function (a, b) { return a.hour !== b.hour ? a.hour - b.hour : a.idx - b.idx; });

  const declared = rows.map(function (r) { return parseInt(r[MASTER_COL_TOTAL_HOURS - 1], 10); })
    .filter(function (v) { return !isNaN(v) && v > 0; });

  // 週案で既に指導済み・入力済みの時数はロックして書き換えない
  const planned = p4PlannedHistory_(ss);
  const ph = planned[normalizeSubjectName_(subject)] && planned[normalizeSubjectName_(subject)].units[name];
  const lockedCount = Math.min(ph ? ph.maxHour : 0, ordered.length);

  return {
    subjectLabel: rows[0][MASTER_COL_SUBJECT - 1],
    unitName: name,
    firstRow: sheetRows[0],
    rowCount: rows.length,
    currentTotal: Math.max(declared.length ? Math.max.apply(null, declared) : 0, rows.length),
    activities: ordered.map(function (x) { return x.activity; }),
    lockedCount: lockedCount,
    plannedHour: ph ? ph.maxHour : 0
  };
}

/** 再構成プロンプトを組み立てます。 */
function p5BuildRecomposePrompt_(ctx, subject, targetHours, instruction) {
  const startHour = ctx.lockedCount + 1;
  const count = targetHours - ctx.lockedCount;

  const lockedText = ctx.lockedCount > 0
    ? ctx.activities.slice(0, ctx.lockedCount).map(function (a, i) {
        return (i + 1) + '時間目: ' + a;
      }).join('\n')
    : '（なし）';
  const editableText = ctx.activities.slice(ctx.lockedCount).map(function (a, i) {
    return (ctx.lockedCount + i + 1) + '時間目: ' + a;
  }).join('\n') || '（現在の内容なし）';

  return 'あなたは日本の小学校教育の専門家です。\n'
    + '教科「' + subject + '」の単元「' + ctx.unitName + '」を、全' + targetHours + '時間の構成に再編成してください。\n\n'
    + '【変更してはいけないこと】\n'
    + '- 1〜' + ctx.lockedCount + '時間目はすでに指導済み（または週案に記入済み）です。内容を変更せず、出力にも含めないでください。\n'
    + '- 出力するのは ' + startHour + ' 時間目から ' + targetHours + ' 時間目までの ちょうど ' + count + ' 件です。\n'
    + '- hour は ' + startHour + ' から ' + targetHours + ' まで1ずつ連続する整数で、重複・欠番は不可です。\n'
    + '- 単元名・教科名は変更しないでください。\n\n'
    + '【指導済みの内容（参考・変更不可）】\n' + lockedText + '\n\n'
    + '【現在の未指導部分の内容（これを再構成する）】\n' + editableText + '\n\n'
    + '【ユーザーからの指示】\n' + (instruction ? String(instruction).substring(0, 500) : '（特になし）') + '\n\n'
    + '## activityの記述ルール\n'
    + '週案を見ただけで授業の流れが把握できるよう、改行（\\n）を使って構造的に記載してください。\n'
    + '全体で100〜150文字程度に収め、冗長にならないようにしてください。\n'
    + '（めあて）1行目にその時間のめあてを簡潔に書く\n'
    + '（学習活動）・（中黒）で始まる箇条書きで主な活動を2〜3項目\n'
    + '（準備物）教師の準備物や児童の持ち物がある場合のみ、末尾に▶で記載\n'
    + '記述例: "めあて：物語の場面構成を捉えよう\\n・全文を通読し初発の感想を書く\\n・場面分けをして構成を整理する\\n▶ワークシート"\n\n'
    + '【再構成の方針】\n'
    + '- 元の学習内容の要素を落とさず、時数の増減に合わせて統合・分割してください。\n'
    + '- 減らす場合は近い内容をまとめ、増やす場合は活動を具体化して分けてください。\n'
    + '- 最終時間はまとめ・振り返り・評価にあててください。\n';
}

/**
 * [Webアプリ API] 単元の未指導時数だけをAIで再構成した「案」を返します（書き込みなし）。
 * @param {Object} req { subject, unitName, targetHours, instruction }
 */
function proposeUnitRecomposition(req) {
  try {
    req = req || {};
    validateParams_(req, {
      subject: { type: 'string', required: true, maxLength: 50 },
      unitName: { type: 'string', required: true, maxLength: 200 },
      targetHours: { type: 'number', required: true, min: 1, max: P5_UNIT_HOURS_MAX_ }
    });
    const targetHours = parseInt(req.targetHours, 10);
    const ctx = p5LoadUnitContext_(req.subject, req.unitName);

    if (targetHours < ctx.lockedCount) {
      throw new Error('この単元は既に' + ctx.lockedCount + '時間目まで週案に入力されているため、'
        + targetHours + '時間には減らせません。' + ctx.lockedCount + '時間以上を指定してください。');
    }
    if (targetHours === ctx.lockedCount) {
      throw new Error('指定された時数がすべて指導済みのため、再構成する時間がありません。');
    }

    const startHour = ctx.lockedCount + 1;
    const prompt = p5BuildRecomposePrompt_(ctx, req.subject, targetHours, req.instruction);
    const items = callGeminiJsonArray_(
      prompt,
      {
        type: 'OBJECT',
        properties: {
          hour: { type: 'NUMBER', description: '何時間目か（開始時数から1ずつ連番）' },
          activity: { type: 'STRING', description: 'その時間の学習活動。めあて／箇条書き／▶準備物 の形式で100〜150文字' }
        },
        required: ['hour', 'activity']
      },
      '再構成後の未指導時数の学習活動',
      'Gemini Unit Recompose Error'
    );

    // AIの提案は必ず検証し、1つでも違反があれば全体を破棄する
    const verdict = validateRecomposition_(items, startHour, targetHours);
    if (!verdict.ok) {
      return { success: false, error: 'AIの提案が検証に通らなかったため破棄しました（' + verdict.error + '）もう一度お試しください。' };
    }

    const lockedHours = ctx.activities.slice(0, ctx.lockedCount).map(function (a, i) {
      return { hour: i + 1, activity: a };
    });

    const warnings = [];
    try {
      // 単元マスタは全学級で共通のため、複数学級を使っている場合は影響範囲を伝える
      if (isMultiClassEnabled_() && getClassList_().length > 1) {
        warnings.push('単元マスタは全学級で共通です。この変更は他の学級の指導計画にも反映されます。');
      }
    } catch (e) { /* 複数学級が未設定なら警告不要 */ }

    return {
      success: true,
      subject: req.subject,
      subjectLabel: ctx.subjectLabel,
      unitName: ctx.unitName,
      currentTotal: ctx.currentTotal,
      targetHours: targetHours,
      lockedCount: ctx.lockedCount,
      rowCount: ctx.rowCount,
      firstRow: ctx.firstRow,
      lockedHours: lockedHours,
      proposal: verdict.hours,
      warnings: warnings
    };
  } catch (e) {
    logError('proposeUnitRecomposition', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] プレビューで確認・修正済みの構成を単元マスタへ書き戻します。
 * @param {Object} payload { subject, unitName, totalHours, hourlyActivities, expectedLockedCount, expectedRowCount }
 */
function applyUnitRecomposition(payload) {
  try {
    payload = payload || {};
    validateParams_(payload, {
      subject: { type: 'string', required: true, maxLength: 50 },
      unitName: { type: 'string', required: true, maxLength: 200 },
      hourlyActivities: { required: true, isArray: true }
    });
    const hours = payload.hourlyActivities;
    const totalHours = parseInt(payload.totalHours, 10) || hours.length;
    if (hours.length !== totalHours) {
      throw new Error('時間数と学習活動の件数が一致しません。');
    }
    if (totalHours < 1 || totalHours > P5_UNIT_HOURS_MAX_) {
      throw new Error('時間数が範囲外です。');
    }
    // 1..totalHours の連番であること
    for (let i = 0; i < hours.length; i++) {
      if (parseInt(hours[i].hour, 10) !== i + 1) {
        throw new Error('時間目が1から連続していません。');
      }
    }

    // 書き込み直前の再検証: プレビューを開いてから状況が変わっていないか確かめる。
    // ロック済みの時数が増えていたり、行構成が変わっていたら中断する。
    const ctx = p5LoadUnitContext_(payload.subject, payload.unitName);
    if (payload.expectedLockedCount !== undefined && payload.expectedLockedCount !== null
      && parseInt(payload.expectedLockedCount, 10) !== ctx.lockedCount) {
      throw new Error('この単元の指導状況が変わりました（現在' + ctx.lockedCount + '時間目まで入力済み）。'
        + '画面を更新してからやり直してください。');
    }
    if (totalHours < ctx.lockedCount) {
      throw new Error('既に' + ctx.lockedCount + '時間目まで入力済みのため、' + totalHours + '時間には減らせません。');
    }
    // ロック分がシート上の内容と一致していることを確認（プレビューで書き換えられていないか）
    for (let i = 0; i < ctx.lockedCount; i++) {
      if (String(hours[i].activity || '') !== String(ctx.activities[i] || '')) {
        throw new Error('指導済みの時間の内容は変更できません。画面を更新してやり直してください。');
      }
    }

    const result = p4WriteUnitRows_(payload.subject, payload.unitName, hours, {
      totalHours: totalHours,
      expectedRowCount: payload.expectedRowCount,
      auditAction: 'UNIT_RECOMPOSE',
      label: '自動: 単元「' + ctx.unitName + '」再構成前'
    });

    return {
      success: true,
      rowsBefore: result.rowsBefore,
      rowsAfter: result.rowsAfter,
      snapshotId: result.snapshotId,
      message: '単元「' + ctx.unitName + '」を全' + totalHours + '時間に再構成しました。'
    };
  } catch (e) {
    logError('applyUnitRecomposition', e);
    return { success: false, error: e.message };
  }
}
