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
// ===== 教科名の正規化 =====
// ============================================================

/**
 * 教科名の別名（略称・表記ゆれ）→ 正式名のマップ。
 * 「図工」と「図画工作」のような同一教科の表記ゆれを、
 * 時数計算・単元マスタ照合・自動入力・単元シフトなど
 * すべての教科名比較で同一視するために使用します。
 */
const SUBJECT_NAME_ALIASES_ = {
  '図工': '図画工作'
};

/**
 * 教科名を正規化します（前後の空白を除去し、別名を正式名に変換）。
 * @param {*} name 教科名
 * @returns {string} 正規化された教科名
 */
function normalizeSubjectName_(name) {
  const s = (name === null || name === undefined) ? '' : String(name).trim();
  return SUBJECT_NAME_ALIASES_[s] || s;
}

/**
 * 2つの教科名が（表記ゆれを含めて）同一教科かを判定します。
 * @param {*} a 教科名
 * @param {*} b 教科名
 * @returns {boolean}
 */
function isSameSubject_(a, b) {
  return normalizeSubjectName_(a) === normalizeSubjectName_(b);
}

/**
 * 教科セルの値を「教科名＋分数」の並びとして解析します。
 *
 * 教科セルは "国語" のような1教科だけでなく、"国語2/3 行事1/3" のように
 * 1コマを分け合う複数教科を分数付きで書ける。時数集計・入力検証・単元マスタ照合は
 * すべてこの解析結果を通すこと（解析ルールの正本はここ）。
 * クライアント側の parseSubjectCellEntries（App_Js_02_Plan.html）と対で直すこと。
 *
 * @param {*} cellValue 教科セルの値
 * @returns {{entries: Array<{subject: string, fraction: number, num: number, den: number, explicit: boolean}>, unparsedText: string}}
 */
function parseSubjectCellEntries_(cellValue) {
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
 * 教科セルに書かれている教科名を、分数の大きい順（同率ならセルに書かれた順）で返します。
 * 例: "国語2/3 行事1/3" → ['国語', '行事'] ／ "行事1/3 国語2/3" → ['国語', '行事']
 * @param {*} cellValue 教科セルの値
 * @returns {string[]} 教科名（セルの表記のまま。重複は正規化して除く）
 */
function listSubjectNamesInCell_(cellValue) {
  const entries = parseSubjectCellEntries_(cellValue).entries;
  const seen = {};
  const names = [];
  entries.forEach(function (e, idx) {
    const key = normalizeSubjectName_(e.subject);
    if (!key || seen[key]) return;
    seen[key] = true;
    names.push({ name: e.subject, fraction: isFinite(e.fraction) ? e.fraction : 0, idx: idx });
  });
  names.sort(function (a, b) {
    if (b.fraction !== a.fraction) return b.fraction - a.fraction;
    return a.idx - b.idx;
  });
  return names.map(function (n) { return n.name; });
}

/**
 * 教科セルの値から「単元マスタを引くための教科名」を1つ決めます。
 *
 * 1コマを分け合う教科セル（"国語2/3 行事1/3"）をそのまま教科名として単元マスタを
 * 引くと、当然どの教科にも当たらず、単元ピッカーも自動入力も学習内容を出せなかった。
 * セル全体で当たらないときは、書かれている教科名を分数の大きい順に試し、
 * 単元マスタに載っている教科を採用する。
 *
 * セルの文字列そのものを先に試すのは、"3年体育" のように数字を含む教科名を
 * 分解して壊さないため。どれにも当たらなければ従来どおりセルの値をそのまま返す
 * （呼び出し側の「見つからない」メッセージは今までと同じ文言になる）。
 *
 * @param {*} cellValue 教科セルの値
 * @param {function(string):boolean} [hasSubject] 正規化済み教科名を受け取り、
 *   単元マスタにその教科があるかを返す関数。省略時は分数の大きい教科を返します。
 * @returns {string} 教科名（セルの表記のまま。空セルなら ''）
 */
function resolveMasterSubjectName_(cellValue, hasSubject) {
  const raw = (cellValue === null || cellValue === undefined) ? '' : String(cellValue).trim();
  if (!raw) return '';
  if (typeof hasSubject !== 'function') {
    const names = listSubjectNamesInCell_(raw);
    return names.length > 1 ? names[0] : raw;
  }
  if (hasSubject(normalizeSubjectName_(raw))) return raw;
  const names = listSubjectNamesInCell_(raw);
  for (let i = 0; i < names.length; i++) {
    if (hasSubject(normalizeSubjectName_(names[i]))) return names[i];
  }
  return raw;
}

/**
 * 教科セルに、その教科が入っているかを判定します。
 * "国語2/3 行事1/3" のセルは「国語のコマ」でもあるので、単元シフトや
 * スロット記憶の突き合わせでは単純な一致ではなくこちらを使います。
 * @param {*} cellValue 教科セルの値
 * @param {*} subject 探す教科名
 * @returns {boolean}
 */
function subjectCellHasSubject_(cellValue, subject) {
  if (isSameSubject_(cellValue, subject)) return true;
  const names = listSubjectNamesInCell_(cellValue);
  if (names.length <= 1) return false;
  return names.some(function (n) { return isSameSubject_(n, subject); });
}

/**
 * 単元名を突き合わせるためのキーを作ります。**表示にはそのまま使わないこと。**
 *
 * 週案の単元セルは自由入力なので、単元マスタと同じ単元でも「全角スペースが入った」
 * 「ー が － になった」程度のゆれで別の単元として数えられ、マスタ側の単元が
 * いつまでも未指導のまま残っていた。突き合わせのときだけここを通す。
 *
 * 画面やセルへ書く名前は、単元マスタに書かれている表記をそのまま持ち回ること
 * （教科名の normalizeSubjectName_ / subjectLabels と同じ考え方）。
 *
 * @param {*} name 単元名
 * @returns {string} 突き合わせ用のキー
 */
function normalizeUnitName_(name) {
  let s = (name === null || name === undefined) ? '' : String(name);
  // 全角英数・全角記号・半角カナを揃える（（）や ～ もここで半角側へ寄る）
  if (typeof s.normalize === 'function') s = s.normalize('NFKC');
  s = s.toLowerCase();
  s = s.replace(/[\s\u3000]/g, '');              // 空白は位置を問わず落とす
  s = s.replace(/[\u301c]/g, '~');                // 波ダッシュ（NFKC では変わらない）
  s = s.replace(/[-\u2010\u2013\u2014\u2015\u2212]/g, 'ー'); // ハイフン類は長音記号へ寄せる
  s = s.replace(/[「」『』"']/g, '');               // かぎ括弧・引用符の有無は区別しない
  s = s.replace(/[・]/g, '');                      // 中黒の有無も区別しない
  return s;
}

/**
 * 2つの単元名が（表記ゆれを含めて）同じ単元を指すかを判定します。
 * @param {*} a 単元名
 * @param {*} b 単元名
 * @returns {boolean}
 */
function isSameUnitName_(a, b) {
  return normalizeUnitName_(a) === normalizeUnitName_(b);
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
  // 週案の行照合はすべてこの関数の出力をキーに行う。タイムゾーンを "JST" 固定に
  // すると、非JSTタイムゾーンのスプレッドシートを紐付けたユーザーで日付が±1日
  // ずれて週の行が見つからなくなるため、スクリプトのタイムゾーンに追従させる。
  return Utilities.formatDate(date, Session.getScriptTimeZone() || "Asia/Tokyo", "yyyy/MM/dd");
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
 * 指定週（7日分）の保存対象セル値からリビジョン（MD5ハッシュ）を計算します。
 * getWeeklyPlanData と saveWeeklyPlanData が同一ロジックで算出し、楽観ロックの基準に用います。
 * クライアントは値を解釈せずトークンとして往復させるため、表示整形の差異に影響されません。
 * @param {Array[]} dbData データベースシートの全行データ（getValuesの結果）
 * @param {Object} dbCols getDbColumns() の列マップ（1始まり）
 * @param {string[]} weekDateStrs "yyyy/MM/dd" 形式の7日分の日付文字列
 * @returns {string} リビジョン（16進ハッシュ）
 */
function computeWeekRevision_(dbData, dbCols, weekDateStrs) {
  const FIELDS = ['EVENT', 'PRECLASS', 'MORNING', 'PERIOD1', 'UNIT1', 'CONTENT1', 'PERIOD2', 'UNIT2', 'CONTENT2', 'RECESS1',
    'PERIOD3', 'UNIT3', 'CONTENT3', 'PERIOD4', 'UNIT4', 'CONTENT4', 'RECESS2', 'PERIOD5', 'UNIT5', 'CONTENT5',
    'PERIOD6', 'UNIT6', 'CONTENT6', 'AFTERSCHOOL', 'HOMEWORK', 'ITEMS'];
  const rowByDate = new Map();
  for (const row of dbData) {
    if (row[dbCols.DATE - 1] instanceof Date) {
      rowByDate.set(formatDate(row[dbCols.DATE - 1]), row);
    }
  }
  const parts = [];
  for (const ds of weekDateStrs) {
    const row = rowByDate.get(ds);
    parts.push(ds);
    for (const f of FIELDS) {
      const col = dbCols[f];
      const v = (col && row) ? row[col - 1] : '';
      parts.push(v == null ? '' : String(v));
    }
  }
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, parts.join(''), Utilities.Charset.UTF_8);
  return digest.map(b => {
    const h = (b < 0 ? b + 256 : b).toString(16);
    return h.length === 1 ? '0' + h : h;
  }).join('');
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
  // API キーは URL クエリに入れない（アクセスログやプロキシに残る）。ヘッダで渡す。
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
  const parts = [{ "text": prompt }];
  blobs.forEach(blob => {
    parts.push({ "inline_data": { "mime_type": blob.getContentType(), "data": Utilities.base64Encode(blob.getBytes()) } });
  });
  const payload = { "contents": [{ "parts": parts }], "generationConfig": { "response_mime_type": "application/json", "maxOutputTokens": 65536 } };
  // 通信の作法（再試行・Retry-After の尊重）は正本 Gemini.gs に集約した。
  // 後段の「途切れた JSON の修復」はこのアプリ固有なのでここに残す。
  let responseCode = 0;
  let responseBody = '';
  try {
    const jsonResponse0 = GigaGemini.callRaw({
      apiKey: apiKey, payload: payload, url: url,
      maxAttempts: 4, log: logInfo, logLabel: 'Gemini API(PDF)',
    });
    responseCode = 200;
    responseBody = JSON.stringify(jsonResponse0);
  } catch (e) {
    logError('Gemini API(PDF) の呼び出しに失敗しました。', e);
    return { data: null, isTruncated: false };
  }

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
 * 認可（権限）不足に起因するエラーかを判定し、機能名を添えた分かりやすい案内文を返します。
 * Incremental Authorization はGASビルトインでは実現できないため（docs/B4_INCREMENTAL_AUTH.md 参照）、
 * 重い機能（Classroom / メール）を使う導線で本ヘルパーを用い、未承認時は再認可を促す案内に置き換えます。
 * 権限起因でなければ元のメッセージをそのまま返します。
 * @param {Error|string} e 発生したエラー
 * @param {string} feature 機能名（例: 'Google Classroom 連携'）
 * @returns {string} ユーザー向けメッセージ
 */
function describeAuthError_(e, feature) {
  const msg = (e && e.message) ? e.message : String(e);
  const authLike = /authoriz|permission|scope|has not been granted|PERMISSION_DENIED|権限|認可|承認|アクセスが拒否/i.test(msg);
  if (authLike) {
    return (feature || 'この機能') + 'の利用に必要な権限が付与されていません。'
      + 'アプリを開き直して表示される権限リクエストを承認してから、もう一度お試しください。'
      + '（詳細: ' + msg + '）';
  }
  return msg;
}

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
 * ログを書いている最中かどうか。
 *
 * ログの書き込みは getSs_() を通り、その先（旧バインドの通知など）から
 * また logInfo が呼ばれる。放っておくとここへ戻ってきて再帰する。
 * ログ追記は1回が Sheets API の往復1回なので、回数はそのまま保存時間になる。
 * 書いている最中に出た内側のログは捨てる。
 */
let LOG_WRITING_ = false;

/** 
 * ログシート書き込みの共通処理 
 */
function writeToLog_(level, message) {
  if (LOG_WRITING_) return;
  LOG_WRITING_ = true;
  try {
    const ss = getSs_();
    let logSheet = ss.getSheetByName(SHEET_NAME_LOG);
    if (!logSheet) {
      logSheet = ss.insertSheet(SHEET_NAME_LOG, ss.getSheets().length);
      logSheet.getRange("A1:C1").setValues([["日時", "レベル", "メッセージ"]]).setFontWeight("bold");
    }
    // appendRow は直感的ですが、高速化のためgetLastRowを使用（API呼び出しを減らしてもよいが、ログは都度更新が必要）
    logSheet.appendRow([new Date(), level, String(message).substring(0, 30000)]);
  } catch (e) {
    // ここへ落ちたときの出力先は Stackdriver（Cloud Logging）で、
    // スクリプトの所有者が閲覧できる。1つのURLを多数の先生へ配る運用では、
    // 所有者＝配布者なので、本文を出すと週案の記述が配布者側へ渡ることになる。
    // 何が起きたかを追うには「どのログが書けなかったか」の種別で足りるため、本文は出さない
    // （docs/LEGAL_RISK_AUDIT_JP.md の B-1）。
    console.error(`ログシートへの書き込みに失敗しました（レベル: ${level}）: ${e.message}`);
  } finally {
    LOG_WRITING_ = false;
  }
}

/**
 * Google API のエラー本文から「Cloud プロジェクトで API がオンになっていない」を
 * 見分け、何をすればよいかを日本語で添えます。
 *
 * 組み込みサービス（SpreadsheetApp / DriveApp）を使っていた頃は、Apps Script が
 * 裏で処理していたためプロジェクト側の有効化が要りませんでした。REST を直接
 * 呼ぶようになったので、初回デプロイでここに引っかかります。Google が返す英文
 * だけだと権限やスコープの問題と紛らわしいので、言い換えて案内します。
 *
 * @param {string} apiName 画面に出す API 名（例: 'Google Sheets API'）
 * @param {number} code HTTP ステータス
 * @param {string} message API が返した本文
 * @returns {string} 利用者・管理者向けのメッセージ
 */
function describeApiDisabledError_(apiName, code, message) {
  const text = String(message || '');

  // 429（レート制限）は、待てば直る一時的なもの。原文は英語で
  // 「Quota exceeded for quota metric 'Read requests' ...」とだけ出るため、
  // 先生には「壊れた」ようにしか見えない。何をすればよいかを日本語で先に書く。
  if (code === 429) {
    return `${apiName} への読み書きが一時的に混み合っています（短時間に多く操作したときに出ます）。`
      + '**1分ほど待ってから、もう一度お試しください。** データは失われていません。'
      + `\n\n元のメッセージ: ${text}`;
  }

  const disabled = code === 403
    && (/has not been used in project/i.test(text) || /it is disabled/i.test(text));
  if (!disabled) return `${apiName} (${code}): ${text}`;

  return `${apiName} が Google Cloud プロジェクトでオンになっていません。`
    + 'Cloud Console の「API とサービス」→「ライブラリ」で ' + apiName + ' を有効にしてから、'
    + '数分待って開き直してください。'
    + '（これは権限の問題ではなく、プロジェクト側の設定です。利用者に求める権限は増えません）'
    + `\n\n元のメッセージ: ${text}`;
}

// ============================================================
// ===== デプロイの取りこぼし検出 =====
// ============================================================

/**
 * GAS プロジェクトに必要なファイルがそろっているかを確かめます。
 *
 * このアプリはファイルを手で（または clasp で）コピーして配置するため、
 * **新しく増えたファイルのコピー漏れ**が起きます。漏れたまま動かすと
 * 「sheetsOpenById_ is not defined」のような、原因の見当がつかない
 * エラーだけが出て止まります。何が足りないのかを名指しで返します。
 *
 * 消したはずのファイルが残っている場合も見つけます。古い版の関数が
 * 残っていると、消したはずの挙動が生き返るためです。
 *
 * @returns {{ok: boolean, missing: string[], stale: string[], message: string}}
 */
function checkDeploymentIntegrity_() {
  // **今の版にしか無い**関数・定数の有無で見る。
  // 「ファイルが無い」だけでなく「古い版のまま残っている」も同じように引っかかる。
  // 実際、07_WebApp.gs だけ古いと、旧 getSs_() が SpreadsheetApp を呼んで
  // 「指定された権限では SpreadsheetApp.getActiveSpreadsheet を呼び出すことができません」
  // になる。関数の有無だけ見ていると、これを見逃す。
  // typeof は未定義の識別子でも例外にならないので、そのまま並べてよい。
  // 各ファイルの「今の版にしか無い」関数・定数を1つずつ見る。
  // typeof は未定義の識別子でも例外にならないので、そのまま並べてよい。
  // 新しい .gs を足したらここにも足すこと（tests/load-order.test.mjs が漏れを弾く）。
  const outdated = [];
  if (typeof getDbColumns !== 'function') outdated.push('00_config.gs');
  if (typeof getTaskData !== 'function') outdated.push('02_Database.gs');
  if (typeof getPickerAppId_ !== 'function') outdated.push('03_PdfProcessing.gs');
  if (typeof buildMasterIndex_ !== 'function') outdated.push('04_AutoFill.gs');
  if (typeof getCourseIdByName !== 'function') outdated.push('05_Classroom.gs');
  if (typeof SP_KEY_PICKER_APP_ID === 'undefined') outdated.push('06_Settings.gs');
  if (typeof getMyTriggersForWebApp !== 'function') outdated.push('07_WebApp.gs');
  if (typeof getGeminiApiUrl_ !== 'function') outdated.push('08_Gemini.gs');
  if (typeof saveWeeklySummary !== 'function') outdated.push('09_Reflection.gs');
  if (typeof addClassFromWeb !== 'function') outdated.push('10_MultiClass.gs');
  if (typeof resolveSpreadsheetId_ !== 'function') outdated.push('11_Tenant.gs');
  if (typeof P2_WEEK_READ_KEYS_ === 'undefined') outdated.push('12_Performance.gs');
  if (typeof p3MetaGet_ !== 'function') outdated.push('13_DataProtection.gs');
  if (typeof p3GetBackupIndex_ !== 'function') outdated.push('13_DataProtection_Backups.gs');
  if (typeof p3IntegrityCheck_ !== 'function') outdated.push('13_DataProtection_Operations.gs');
  if (typeof p3ScopeMonday_ !== 'function') outdated.push('13_DataProtection_Snapshots.gs');
  if (typeof p3AppendTrash_ !== 'function') outdated.push('13_DataProtection_Trash.gs');
  if (typeof UP_CACHE_PREFIX_ === 'undefined') outdated.push('14_UnitProgress.gs');
  if (typeof p4WriteUnitRows_ !== 'function') outdated.push('15_UnitMasterOps.gs');
  if (typeof p5LoadUnitContext_ !== 'function') outdated.push('16_UnitRecompose.gs');
  if (typeof driveCreateFile_ !== 'function') outdated.push('17_DriveApi.gs');
  if (typeof sheetsOpenById_ !== 'function') outdated.push('18_SheetsApi.gs');
  if (typeof describeApiDisabledError_ !== 'function') outdated.push('99_Utils.gs');
  // 正本コピー（GIGAyama.github.io/standards/gas/Gemini.gs）。
  // 貼り忘れると AI 機能が丸ごと動かないので、ここでも見る。
  if (typeof GigaGemini === 'undefined') outdated.push('Gemini.gs');

  // 削除済みのファイルが残っていないか（それぞれのファイルにしか無かった関数で見る）
  const stale = [];
  if (typeof onOpen === 'function') stale.push('01_Main.gs');
  if (typeof executeServerFunctionForModal === 'function') stale.push('LoadingModal.html の中継関数');

  const notes = [];
  if (outdated.length) {
    notes.push('次のファイルが入っていないか、古いままです: ' + outdated.join(' / '));
  }
  if (stale.length) {
    notes.push('削除されたはずの次のファイルが残っています: ' + stale.join(' / '));
  }

  const message = notes.length
    ? (notes.join(' / ')
      + '。リポジトリの内容で貼り直してください（clasp push が確実です）。'
      + '一部だけ貼り替えると、古い版が残って原因の分かりにくいエラーになります。')
    : '';

  return {
    ok: outdated.length === 0 && stale.length === 0,
    outdated: outdated,
    stale: stale,
    message: message
  };
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
    "sendTaskReminderMail",
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
      const isEvtQueueEmpty = !tGetProp_(SCRIPT_PROP_EVENT_PDF_QUEUE);
      const isPdfQueueEmpty = !tGetProp_(SCRIPT_PROP_PDF_QUEUE);
      
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
}

// ============================================================
// ===== UI/UX コンポーネント・フィードバック関連 =====
// ============================================================

/**
 * 固定時間割データを2次元配列（5行×8列）で返します。
 * スクリプトプロパティから取得します。未設定の場合は空データを返します。
 * 戻り値: [[時程, 朝学習, 1校時, 2校時, 3校時, 4校時, 5校時, 6校時], ...] (月〜金の5行)
 */
function getTimetableData_() {
  const savedJson = tGetProp_('fixedTimetableData'); // 個人設定（UserProperties→ScriptProperties）
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

/**
 * 固定時間割の「空きコマ（別教員担当）」指定を2次元配列（5行×6列）で返します。
 * 戻り値: [[月1校時, ..., 月6校時], ...] (月〜金の5行)。
 * 古い保存データ（freePeriods を持たない）は全 false になります。
 *
 * getTimetableData_() の戻り値（5行×8列）に足さずに別の関数にしているのは、
 * あちらが DB_TIMETABLE_WRITE_KEYS_ の並びと1対1で対応する契約になっているため。
 * 暗黙の9列目を紛れ込ませると、後から読む人が必ず踏む。
 */
function getTimetableFreeData_() {
  const empty = () => [0,1,2,3,4].map(() => [false, false, false, false, false, false]);
  const savedJson = tGetProp_('fixedTimetableData'); // 個人設定（UserProperties→ScriptProperties）
  if (!savedJson) return empty();
  try {
    const parsed = JSON.parse(savedJson);
    return [0,1,2,3,4].map(d => {
      const free = (parsed[d] && parsed[d].freePeriods) || [];
      return [0,1,2,3,4,5].map(p => free[p] === true);
    });
  } catch (e) {
    logInfo('固定時間割(空きコマ)のプロパティ解析に失敗: ' + e.message);
    return empty();
  }
}
