/**
 * @fileoverview 複数学級モード（専科教員・複数学級担当向け）の管理API
 *
 * 学級ごとに専用のデータベースシートを持ち、Webアプリ上で切り替えて使用できます。
 * モードは設定画面からON/OFFでき、OFF（デフォルト）の場合は従来どおり
 * 単一の「データベース」シートを使用し、UI上にも一切表示されません。
 *
 * 共有されるもの（学級ごとに分かれないもの）:
 *   タスク・単元マスタ・学級通信・固定時間割・長期休業設定・Classroom連携設定
 * 学級ごとに分かれるもの:
 *   データベースシート（週案・振り返り）・担当学年・教科別標準時数
 */

/**
 * 現在アクティブな学級のシート名を返します（未設定・不整合時は既定シート）。
 * @returns {string}
 */
function getActiveClassSheetName_() {
  const active = PropertiesService.getScriptProperties().getProperty(SCRIPT_PROP_ACTIVE_CLASS);
  if (active === SHEET_NAME_DATABASE) return SHEET_NAME_DATABASE;
  if (active && getClassList_().some(c => c.sheetName === active)) return active;
  return SHEET_NAME_DATABASE;
}

/**
 * 学級リストをスクリプトプロパティへ保存します。
 * @param {Array} list
 */
function saveClassList_(list) {
  PropertiesService.getScriptProperties().setProperty(SCRIPT_PROP_CLASS_LIST, JSON.stringify(list));
}

/**
 * 現在の担当学年・標準時数を、アクティブ学級のエントリへ書き戻します（切替前のスナップショット）。
 * @param {Array} list 学級リスト（この配列を直接更新します）
 */
function snapshotActiveClassSettings_(list) {
  const props = PropertiesService.getScriptProperties();
  const activeSheet = getActiveClassSheetName_();
  const entry = list.find(c => c.sheetName === activeSheet);
  if (!entry) return;
  entry.grade = props.getProperty(SCRIPT_PROP_GRADE) || entry.grade || '3';
  const sh = props.getProperty(SP_KEY_STANDARD_HOURS);
  if (sh) {
    try { entry.standardHours = JSON.parse(sh); } catch (e) { /* 破損時は既存値を維持 */ }
  }
}

/**
 * 指定学級エントリの担当学年・標準時数をグローバル設定へ適用します（切替後の復元）。
 * @param {Object} entry 学級エントリ
 */
function applyClassSettings_(entry) {
  const props = PropertiesService.getScriptProperties();
  const grade = String(entry.grade || '3');
  props.setProperty(SCRIPT_PROP_GRADE, grade);
  const hours = (entry.standardHours && entry.standardHours.length)
    ? entry.standardHours
    : getStandardHoursMaster(parseInt(grade, 10));
  props.setProperty(SP_KEY_STANDARD_HOURS, JSON.stringify(hours));
}

/**
 * アクティブ学級のエントリを部分更新します（saveGrade / saveStandardHours からのフック用）。
 * @param {Object} patch 更新するフィールド（grade / standardHours）
 */
function updateActiveClassEntry_(patch) {
  try {
    const list = getClassList_();
    const entry = list.find(c => c.sheetName === getActiveClassSheetName_());
    if (!entry) return;
    Object.assign(entry, patch);
    saveClassList_(list);
  } catch (e) {
    logError('updateActiveClassEntry_', e);
  }
}

/**
 * [Web API] 複数学級モードの設定と学級一覧を返します。
 * @returns {Object} { success, enabled, activeSheet, classes: [{name, sheetName, grade, isDefault}] }
 */
function getMultiClassSettings() {
  try {
    const enabled = isMultiClassEnabled_();
    const classes = getClassList_().map(c => ({
      name: c.name,
      sheetName: c.sheetName,
      grade: String(c.grade || '3'),
      isDefault: c.sheetName === SHEET_NAME_DATABASE
    }));
    return {
      success: true,
      enabled: enabled,
      activeSheet: enabled ? getActiveClassSheetName_() : SHEET_NAME_DATABASE,
      classes: classes
    };
  } catch (e) {
    logError('getMultiClassSettings', e);
    return { success: false, error: e.message };
  }
}

/**
 * [Web API] 複数学級モードの有効/無効を切り替えます。
 * 初回有効化時は、既存の「データベース」シートを1つ目の学級として登録します。
 * 無効化時はアクティブ学級を既定シートへ戻します（学級シートやデータは削除しません）。
 * @param {boolean} enabled
 * @returns {Object} getMultiClassSettings() と同形式
 */
function setMultiClassEnabledFromWeb(enabled) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const props = PropertiesService.getScriptProperties();

    if (enabled) {
      let list = getClassList_();
      if (!list.some(c => c.sheetName === SHEET_NAME_DATABASE)) {
        // 既存環境の設定をそのまま1つ目の学級として引き継ぐ
        let standardHours = null;
        try {
          const sh = props.getProperty(SP_KEY_STANDARD_HOURS);
          if (sh) standardHours = JSON.parse(sh);
        } catch (e) { /* 破損時はnullのまま（マスタから補完される） */ }
        list.unshift({
          name: '学級1',
          sheetName: SHEET_NAME_DATABASE,
          grade: props.getProperty(SCRIPT_PROP_GRADE) || '3',
          standardHours: standardHours
        });
        saveClassList_(list);
      }
      props.setProperty(SCRIPT_PROP_MULTICLASS_ENABLED, 'true');
      if (!props.getProperty(SCRIPT_PROP_ACTIVE_CLASS)) {
        props.setProperty(SCRIPT_PROP_ACTIVE_CLASS, SHEET_NAME_DATABASE);
      }
      logInfo('複数学級モードを有効にしました。');
    } else {
      // 現在の学年・標準時数をアクティブ学級に保存してから、既定シートの設定へ戻す
      const list = getClassList_();
      snapshotActiveClassSettings_(list);
      saveClassList_(list);
      const baseEntry = list.find(c => c.sheetName === SHEET_NAME_DATABASE);
      if (baseEntry) applyClassSettings_(baseEntry);
      props.setProperty(SCRIPT_PROP_ACTIVE_CLASS, SHEET_NAME_DATABASE);
      props.setProperty(SCRIPT_PROP_MULTICLASS_ENABLED, 'false');
      logInfo('複数学級モードを無効にしました（学級シートは残っています）。');
    }
    return getMultiClassSettings();
  } catch (e) {
    logError('setMultiClassEnabledFromWeb', e);
    return { success: false, error: e.message };
  } finally {
    try { lock.releaseLock(); } catch (e) { }
  }
}

/**
 * [Web API] 学級を追加します。
 * 既定の「データベース」シートをコピーして学級用シートを作成し、
 * 入力内容（時程〜放課後・振り返り）をクリアします。年間カレンダー（日付・曜日・週番号）は引き継がれます。
 * @param {string} name 学級名（例: "3年1組"）
 * @param {string|number} grade 担当学年 (1〜6)
 * @returns {Object} getMultiClassSettings() と同形式
 */
function addClassFromWeb(name, grade) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    if (!isMultiClassEnabled_()) throw new Error('複数学級モードが有効になっていません。');

    validateParams_({ name }, {
      name: { type: 'string', required: true, maxLength: 30 }
    });
    const cleanName = String(name).trim();
    if (!cleanName) throw new Error('学級名を入力してください。');
    const gradeNum = parseInt(grade, 10);
    if (isNaN(gradeNum) || gradeNum < 1 || gradeNum > 6) throw new Error('学年は1〜6で指定してください。');

    const list = getClassList_();
    if (list.some(c => c.name === cleanName)) throw new Error(`学級「${cleanName}」は既に登録されています。`);

    // シート名に使えない文字を除去して一意なシート名を作る
    const safeName = cleanName.replace(/[\[\]\*\/\\\?:']/g, '');
    const sheetName = SHEET_NAME_DATABASE + '_' + (safeName || ('学級' + (list.length + 1)));

    const ss = getSs_();
    if (ss.getSheetByName(sheetName)) throw new Error(`シート「${sheetName}」は既に存在します。シート名を変えるか、既存シートを削除してください。`);

    const baseSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    if (!baseSheet) throw new Error(`シート「${SHEET_NAME_DATABASE}」が見つかりません。`);

    // 既定シートをコピー（ヘッダー構成と年間カレンダーを引き継ぐ）→ 入力内容をクリア
    const newSheet = baseSheet.copyTo(ss).setName(sheetName);
    const newCols = scanDbHeaderForSheet_(newSheet);
    clearDatabaseInputsForSheet_(newSheet, newCols, true);

    list.push({
      name: cleanName,
      sheetName: sheetName,
      grade: String(gradeNum),
      standardHours: getStandardHoursMaster(gradeNum)
    });
    saveClassList_(list);
    logInfo(`学級「${cleanName}」を追加しました（シート: ${sheetName}）。`);
    return getMultiClassSettings();
  } catch (e) {
    logError('addClassFromWeb', e);
    return { success: false, error: e.message };
  } finally {
    try { lock.releaseLock(); } catch (e) { }
  }
}

/**
 * [Web API] 学級を削除します（既定の「データベース」シートの学級は削除不可）。
 * 学級シートも同時に削除されます。アクティブ学級を削除した場合は既定学級へ切り替わります。
 * @param {string} sheetName 削除する学級のシート名
 * @returns {Object} getMultiClassSettings() と同形式
 */
function deleteClassFromWeb(sheetName) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    if (!isMultiClassEnabled_()) throw new Error('複数学級モードが有効になっていません。');
    if (sheetName === SHEET_NAME_DATABASE) throw new Error('既定の学級（データベースシート）は削除できません。');

    const list = getClassList_();
    const idx = list.findIndex(c => c.sheetName === sheetName);
    if (idx === -1) throw new Error('指定された学級が見つかりません。');

    const props = PropertiesService.getScriptProperties();
    // アクティブ学級を削除する場合は先に既定学級へ切り替える
    if (getActiveClassSheetName_() === sheetName) {
      const baseEntry = list.find(c => c.sheetName === SHEET_NAME_DATABASE);
      if (baseEntry) applyClassSettings_(baseEntry);
      props.setProperty(SCRIPT_PROP_ACTIVE_CLASS, SHEET_NAME_DATABASE);
    }

    const removed = list.splice(idx, 1)[0];
    saveClassList_(list);

    const ss = getSs_();
    const sheet = ss.getSheetByName(sheetName);
    if (sheet) ss.deleteSheet(sheet);

    // 削除したシートの列キャッシュを掃除
    CacheService.getScriptCache().remove('dbColumnsMap_v4::' + sheetName);
    logInfo(`学級「${removed.name}」を削除しました（シート: ${sheetName}）。`);
    return getMultiClassSettings();
  } catch (e) {
    logError('deleteClassFromWeb', e);
    return { success: false, error: e.message };
  } finally {
    try { lock.releaseLock(); } catch (e) { }
  }
}

/**
 * [Web API] アクティブ学級を切り替えます。
 * 現在の担当学年・標準時数を切替前の学級に保存し、切替先の学級の設定を適用します。
 * @param {string} sheetName 切り替え先の学級のシート名
 * @returns {Object} getMultiClassSettings() と同形式
 */
function switchActiveClassFromWeb(sheetName) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    if (!isMultiClassEnabled_()) throw new Error('複数学級モードが有効になっていません。');

    const list = getClassList_();
    const target = list.find(c => c.sheetName === sheetName);
    if (!target) throw new Error('指定された学級が見つかりません。');

    const ss = getSs_();
    if (!ss.getSheetByName(sheetName)) {
      throw new Error(`学級シート「${sheetName}」が見つかりません。シートが削除されている可能性があります。`);
    }

    // 現在の学年・標準時数を切替前の学級へ保存してから、切替先の設定を適用
    snapshotActiveClassSettings_(list);
    PropertiesService.getScriptProperties().setProperty(SCRIPT_PROP_ACTIVE_CLASS, sheetName);
    applyClassSettings_(target);
    saveClassList_(list);

    logInfo(`アクティブ学級を「${target.name}」に切り替えました。`);
    return getMultiClassSettings();
  } catch (e) {
    logError('switchActiveClassFromWeb', e);
    return { success: false, error: e.message };
  } finally {
    try { lock.releaseLock(); } catch (e) { }
  }
}

/**
 * [Web API] 学級の表示名を変更します（シート名は変更しません）。
 * @param {string} sheetName 対象学級のシート名
 * @param {string} newName 新しい学級名
 * @returns {Object} getMultiClassSettings() と同形式
 */
function renameClassFromWeb(sheetName, newName) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    if (!isMultiClassEnabled_()) throw new Error('複数学級モードが有効になっていません。');

    validateParams_({ newName }, {
      newName: { type: 'string', required: true, maxLength: 30 }
    });
    const cleanName = String(newName).trim();
    if (!cleanName) throw new Error('学級名を入力してください。');

    const list = getClassList_();
    const entry = list.find(c => c.sheetName === sheetName);
    if (!entry) throw new Error('指定された学級が見つかりません。');
    if (list.some(c => c.sheetName !== sheetName && c.name === cleanName)) {
      throw new Error(`学級「${cleanName}」は既に登録されています。`);
    }

    entry.name = cleanName;
    saveClassList_(list);
    return getMultiClassSettings();
  } catch (e) {
    logError('renameClassFromWeb', e);
    return { success: false, error: e.message };
  } finally {
    try { lock.releaseLock(); } catch (e) { }
  }
}
