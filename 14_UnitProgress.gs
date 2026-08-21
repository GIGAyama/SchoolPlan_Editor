/**
 * @fileoverview 単元の進捗インデックス（週案の単元ピッカー用）とそのキャッシュ層。
 *
 * 「どの単元を何時間目まで指導したか」の判定ロジックは 04_AutoFill.gs に既にあるため
 * （buildMasterIndex_ / buildTaughtHistory_ / createProgressTracker_）、本ファイルは
 * それらを組み合わせて画面表示用の形に整えるだけで、進捗ロジックを新規に持たない。
 *
 * 設計上の注意:
 *  - このAPIは起動時（getAppBootstrapV2 / getDeferredBootstrapV2）から呼ばない。
 *    単元ピッカーを開いたとき／編集モードに入ったときの遅延取得専用。
 *  - キャッシュは UserCache（利用者ごと）。スクリプト共有キャッシュはマルチテナントで
 *    他人のデータを参照する事故につながるため使わない（00_config.gs の列マップの教訓）。
 *  - トップレベルでGAS APIを呼ばない（テストで vm.runInContext に読み込めるようにするため）。
 */

const UP_CACHE_PREFIX_ = 'unitProgress_v1::';
const UP_CACHE_TTL_SEC_ = 300;
/** CacheService の1エントリ上限は100KB。余裕を見てこれを超えるならキャッシュしない。 */
const UP_CACHE_MAX_BYTES_ = 90000;

/** 進捗判定の「これ以降は存在しない」を表す番兵日付。週案全体を対象にするために使う。 */
function upFarFuture_() {
  return new Date(9999, 0, 1);
}

/** 今日の0時。これを締切に渡すと「今日まで（当日を含む）」の指導実績になる。 */
function upTomorrowMidnight_() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d;
}

/**
 * キャッシュキー。スプレッドシートIDとDBシート名の両方を含める。
 *  - スプレッドシートID: 1利用者が複数のDBを紐付け直しても混ざらないように
 *  - DBシート名: 単元マスタは全学級共通だが週案は学級ごとなので進捗も学級ごとに変わる
 */
function upCacheKey_(spreadsheetId, dbSheetName) {
  return UP_CACHE_PREFIX_ + spreadsheetId + '::' + dbSheetName;
}

/**
 * 単元進捗キャッシュを破棄します。単元マスタ・週案のいずれかを書き換えたら必ず呼びます。
 * 単元マスタは全学級共通のため、全学級分のキーをまとめて削除します。
 * キャッシュ操作の失敗が本処理を巻き込まないよう、例外は握りつぶします。
 */
function invalidateUnitProgressCache_() {
  try {
    const ss = getSs_();
    if (!ss) return;
    const id = ss.getId();
    const names = [SHEET_NAME_DATABASE];
    try {
      getClassList_().forEach(function (c) {
        if (c && c.sheetName && names.indexOf(c.sheetName) === -1) names.push(c.sheetName);
      });
    } catch (e) { /* 複数学級が未設定でも既定シート分は消す */ }
    tCacheRemoveAll_(names.map(function (n) { return upCacheKey_(id, n); }));
  } catch (e) {
    // キャッシュ破棄の失敗は致命的ではない（TTLで最大5分後に自然回復する）
  }
}

// ===================================================
// ===== 進捗インデックスの構築（純粋関数・テスト対象） =====
// ===================================================

/**
 * 単元マスタと週案から、教科別・単元別の進捗インデックスを組み立てます。
 * GAS API を一切呼ばないため、テストから直接実行できます。
 *
 * @param {Array<Array>} masterData 単元マスタの全行（1行目はヘッダー）
 * @param {Array<Array>} dbData データベースシートの全行（1行目はヘッダー）
 * @param {Object} dbCols 列マップ（getDbColumns() の結果）
 * @param {Date} tomorrowMidnight 「今日まで」を表す締切（翌日0時）
 * @param {Date} farFuture 「週案全体」を表す番兵日付
 * @returns {Object} { subjects, warnings }
 */
function buildUnitProgressPayload_(masterData, dbData, dbCols, tomorrowMidnight, farFuture) {
  const masterIndex = buildMasterIndex_(masterData);

  // buildMasterIndex_ は正規化した教科名でキーを作るため、画面表示用に
  // シート上の生表記（図工 / 図画工作 のどちらでユーザーが書いたか）を別途拾っておく。
  const subjectLabels = {};
  for (let i = 1; i < masterData.length; i++) {
    const raw = masterData[i] && masterData[i][MASTER_COL_SUBJECT - 1];
    if (!raw) continue;
    const key = normalizeSubjectName_(raw);
    if (!subjectLabels[key]) subjectLabels[key] = String(raw).trim();
  }

  // 実施済み（今日まで）と、週案上の割当済み（未来の予定も含む）を分けて集計する。
  // 「もう全部埋まっている」の判定は割当済み基準、表示文言は実施済み基準を使う。
  const taughtHistory = buildTaughtHistory_(dbData, dbCols, tomorrowMidnight);
  const plannedHistory = buildTaughtHistory_(dbData, dbCols, farFuture);
  const tracker = createProgressTracker_(masterIndex, plannedHistory);

  const warnings = [];
  collectMismatchWarnings_(masterIndex, plannedHistory, warnings);

  const subjects = {};
  Object.keys(masterIndex).forEach(function (subjectKey) {
    const sm = masterIndex[subjectKey];
    const units = [];
    let nextUnitName = null;

    sm.units.forEach(function (u) {
      const effectiveTotal = tracker.effectiveTotal(subjectKey, u.name);
      const plannedHour = tracker.maxProgress(subjectKey, u.name);
      const th = taughtHistory[subjectKey] && taughtHistory[subjectKey].units[u.name];
      const taughtHour = th ? th.maxHour : 0;
      const done = tracker.isFinished(subjectKey, u.name);
      const masterTotal = Math.max(u.declaredTotal || 0, u.maxHourRow || 0);

      const unit = {
        unitName: u.name,
        order: u.order,
        declaredTotal: u.declaredTotal || 0,
        masterRowHours: u.maxHourRow || 0,
        effectiveTotal: effectiveTotal,
        taughtHour: taughtHour,
        plannedHour: plannedHour,
        // 「次に指導する時間目」。指導済みの単元には次の時間が存在しないため、
        // 総時数を超えないよう丸める（丸めないと単元ピッカーが 4/3 のような
        // マスタに無い時数をセルへ書き込んでしまう）。
        nextHour: done ? Math.max(Math.min(plannedHour, effectiveTotal), 1) : plannedHour + 1,
        status: done ? 'done' : (plannedHour > 0 ? 'inProgress' : 'untaught'),
        isNext: false,
        overTaught: !!(masterTotal && plannedHour > masterTotal),
        totalMismatch: !!(u.declaredTotal && u.maxHourRow && u.declaredTotal !== u.maxHourRow)
      };
      units.push(unit);

      // 「次に指導する単元」= マスタ順で最初の未消化単元。着手済みを優先する。
      if (!done && nextUnitName === null) nextUnitName = u.name;
    });

    // 着手済み（指導中）の単元があればそちらを優先して「次はここから」にする
    const inProgress = units.filter(function (x) { return x.status === 'inProgress'; });
    if (inProgress.length > 0) nextUnitName = inProgress[0].unitName;

    units.forEach(function (x) { x.isNext = (x.unitName === nextUnitName); });

    // 週案にはあるが単元マスタに無い単元（改名・自由入力で発生する）
    const orphans = [];
    const ph = plannedHistory[subjectKey];
    if (ph) {
      Object.keys(ph.units).forEach(function (name) {
        if (!sm.byName[name]) {
          orphans.push({ unitName: name, plannedHour: ph.units[name].maxHour });
        }
      });
    }

    subjects[subjectKey] = {
      subjectLabel: subjectLabels[subjectKey] || subjectKey,
      nextUnitName: nextUnitName,
      units: units,
      orphans: orphans
    };
  });

  // 単元マスタに教科ごと存在しないが週案に登場する教科も拾う（全て孤立扱い）
  Object.keys(plannedHistory).forEach(function (subjectKey) {
    if (subjects[subjectKey]) return;
    const orphans = Object.keys(plannedHistory[subjectKey].units).map(function (name) {
      return { unitName: name, plannedHour: plannedHistory[subjectKey].units[name].maxHour };
    });
    subjects[subjectKey] = {
      subjectLabel: subjectLabels[subjectKey] || subjectKey,
      nextUnitName: null, units: [], orphans: orphans
    };
  });

  return { subjects: subjects, warnings: warnings };
}

// ===================================================
// ===== Webアプリ API =====
// ===================================================

/**
 * [Webアプリ API] 全教科の単元進捗インデックスを返します。
 *
 * 起動経路（getAppBootstrapV2 / getDeferredBootstrapV2）からは呼ばないこと。
 * 単元ピッカーを開いたとき・編集モードに入ったときの遅延取得専用です。
 *
 * @param {boolean} [forceRefresh] true ならキャッシュを無視して再計算します
 * @returns {Object} { success, asOf, cached, subjects, warnings }
 */
function getUnitProgressIndexFromWeb(forceRefresh) {
  try {
    const ss = getSs_();
    const dbSheet = getDbSheet_(ss);
    if (!dbSheet) throw new Error('データベースシートが見つかりません');
    const cacheKey = upCacheKey_(ss.getId(), dbSheet.getName());

    if (!forceRefresh) {
      try {
        const hit = tCacheGet_(cacheKey);
        if (hit) {
          const parsed = JSON.parse(hit);
          parsed.cached = true;
          return parsed;
        }
      } catch (e) { /* キャッシュ破損時は再計算にフォールバック */ }
    }

    const masterSheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
    // 進捗判定に学習活動の本文は不要なので、最も重い5列目は読まない。
    let masterData = [];
    if (masterSheet && masterSheet.getLastRow() >= 2) {
      masterData = masterSheet.getRange(1, 1, masterSheet.getLastRow(), MASTER_COL_HOUR_NUM).getValues();
    }
    const dbCols = getDbColumns();
    const dbData = dbSheet.getDataRange().getValues();

    const built = buildUnitProgressPayload_(
      masterData, dbData, dbCols, upTomorrowMidnight_(), upFarFuture_()
    );

    const payload = {
      success: true,
      asOf: formatDate(new Date()),
      cached: false,
      subjects: built.subjects,
      warnings: built.warnings
    };

    try {
      const json = JSON.stringify(payload);
      // CacheService の1エントリ上限は100KB。巨大なマスタでは諦めて毎回再計算する。
      if (json.length < UP_CACHE_MAX_BYTES_) tCachePut_(cacheKey, json, UP_CACHE_TTL_SEC_);
    } catch (e) { /* キャッシュ書き込み失敗は無視 */ }

    return payload;
  } catch (e) {
    logError('getUnitProgressIndexFromWeb', e);
    return { success: false, error: e.message };
  }
}
