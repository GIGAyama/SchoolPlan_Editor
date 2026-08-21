/**
 * @fileoverview Google Classroomへの時間割、学級通信のPDF投稿など連携機能
 */

/**
 * データベースから次の登校日の予定を読み取り、Google Classroomにお知らせとして投稿します。
 * 本日が登校日のときのみ実行し、休みを挟む場合は休み直前の登校日に休み明けの予定を投稿します
 * （例：金曜日に翌週月曜日の予定を投稿）。
 */
function postScheduleToClassroom() {
  try {
    postScheduleToClassroom_core_();
  } catch (error) {
    logError("postScheduleToClassroom", error);
  }
}

/**
 * [Webアプリ API] 「明日（次の登校日）の予定」をClassroomへ投稿します。
 * メニュー版（postScheduleToClassroom）と同一ロジックを用い、UIに依存せず結果を返します。
 * アプリのボタンからの手動投稿のため、本日が登校日でなくても（土日・休み中でも）投稿できます。
 *
 * situationText は、教員が画面で確認・修正した「今日の様子」の本文です。
 * 省略された場合は予定だけを投稿します（引数なしで呼ばれても従来どおり動きます）。
 * AIが作った下書きをそのまま渡してはいけません。必ず人が読んだ後の文章を渡してください。
 * @param {string} [situationText] 教員が確認済みの「今日の様子」本文
 * @returns {{success: boolean, posted: boolean, message: string}}
 */
function postScheduleToClassroomFromWeb(situationText) {
  try {
    validateParams_({ situationText }, {
      situationText: { type: 'string', maxLength: 2000 }
    });
    return postScheduleToClassroom_core_({ manual: true, situationText: situationText });
  } catch (error) {
    logError("postScheduleToClassroomFromWeb", error);
    return { success: false, posted: false, message: describeAuthError_(error, 'Google Classroom 連携') };
  }
}

/**
 * [Webアプリ API] 本日の学習予定から「今日の様子」の下書きを作ります。**投稿はしません。**
 *
 * 教員がこの下書きを画面で読んで直し、postScheduleToClassroomFromWeb へ渡す、という
 * 2段構えにするための関数です（16_UnitRecompose.gs の propose→apply と同じ考え方）。
 * 下書きを作れない場合（本日が登校日でない／APIキー未設定／生成失敗）も success:true で返し、
 * 予定だけの投稿を妨げません。呼び出し側は available を見て判断してください。
 * @returns {{success: boolean, available: boolean, draft: string, dateLabel: string,
 *            reason: string, message: string}}
 */
function proposeTodaySituationFromWeb() {
  const unavailable = (reason, message) => ({
    success: true, available: false, draft: '', dateLabel: '', reason: reason, message: message
  });
  try {
    const ss = getSs_();
    const databaseSheet = getDbSheet_(ss);
    if (!databaseSheet) throw new Error("データベースシートが見つかりません");

    const dbCols = getDbColumns();
    const dbData = databaseSheet.getDataRange().getValues();

    const today = new Date();
    const daysOfWeek = ["日", "月", "火", "水", "木", "金", "土"];
    const todayKey = Utilities.formatDate(today, "JST", "yyyyMMdd");
    const dow = parseInt(Utilities.formatDate(today, "JST", "u"), 10) % 7;
    const dateLabel = `${Utilities.formatDate(today, "JST", "yyyy/MM/dd")}（${daysOfWeek[dow]}）`;

    const todayRowData = findTodayRowWithPeriod1_(dbData, dbCols, todayKey);
    if (!todayRowData) {
      return unavailable('no-lesson', '本日は授業の予定が入っていないため、下書きは作れませんでした。');
    }

    const lessonContext = buildLessonContext_(todayRowData, dbCols);
    if (!lessonContext) {
      return unavailable('no-lesson', '本日の学習内容が入力されていないため、下書きは作れませんでした。');
    }

    if (!getSetting(SP_KEY_GEMINI_API_KEY)) {
      return unavailable('no-api-key', 'Gemini APIキーが未設定のため、下書きは作れませんでした。');
    }

    const draft = generateTodaySituationDraft_(dateLabel, lessonContext);
    if (!draft) {
      return unavailable('generation-failed', 'AIが下書きを作れませんでした。ご自分で入力するか、予定だけ投稿してください。');
    }

    return {
      success: true, available: true, draft: draft, dateLabel: dateLabel,
      reason: '', message: ''
    };
  } catch (e) {
    // ここで例外を投げると、予定だけを投稿する導線まで巻き添えで止まる。
    logError('proposeTodaySituationFromWeb', e);
    return unavailable('generation-failed', '下書きを作れませんでした。予定だけの投稿はできます。');
  }
}

// 予定投稿の重複防止用ログ（スクリプトプロパティ）と保持期間
const SP_KEY_POSTED_SCHEDULE_LOG = 'sp_postedScheduleLog';
const POSTED_SCHEDULE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14日

/**
 * 指定の識別子が保持期間内に投稿済みかを判定します。
 * 判定に失敗した場合は false を返し、投稿を妨げません（フェイルオープン）。
 * @param {string} fingerprint コースID＋対象日の識別子
 * @returns {boolean}
 */
function hasRecentlyPostedSchedule_(fingerprint) {
  try {
    const raw = tGetProp_(SP_KEY_POSTED_SCHEDULE_LOG);
    if (!raw) return false;
    const log = JSON.parse(raw);
    const ts = log[fingerprint];
    return !!ts && (Date.now() - ts) < POSTED_SCHEDULE_TTL_MS;
  } catch (e) {
    return false;
  }
}

/**
 * 投稿済みの識別子を記録し、保持期間を過ぎた古いエントリを掃除します。
 * @param {string} fingerprint コースID＋対象日の識別子
 */
function recordPostedSchedule_(fingerprint) {
  try {
    let log = {};
    try { log = JSON.parse(tGetProp_(SP_KEY_POSTED_SCHEDULE_LOG) || '{}'); } catch (e) {}
    const now = Date.now();
    log[fingerprint] = now;
    Object.keys(log).forEach(k => { if (now - log[k] >= POSTED_SCHEDULE_TTL_MS) delete log[k]; });
    tSetProp_(SP_KEY_POSTED_SCHEDULE_LOG, JSON.stringify(log));
  } catch (e) {
    logError('recordPostedSchedule_', e);
  }
}

/**
 * 次の登校日の予定をClassroomへ投稿するコアロジック。
 * UI非依存。スキップ時/投稿時を表す結果オブジェクトを返し、異常時は例外を送出します。
 * @param {{manual?: boolean, situationText?: string}} [options]
 *   manual=true のとき手動投稿として扱い、本日が登校日でなくても投稿する。
 *   自動投稿（既定）では、休み中の重複投稿を防ぐため本日が登校日のときのみ投稿する。
 *   situationText は教員が確認・修正済みの「今日の様子」本文。渡された文字列をそのまま
 *   末尾に載せるだけで、この関数がAIを呼ぶことはない。自動投稿では常に未指定になる。
 * @returns {{success: boolean, posted: boolean, message: string}}
 */
function postScheduleToClassroom_core_(options) {
    const isManual = !!(options && options.manual);
    // 教員が画面で確認・修正した「今日の様子」。渡されたものをそのまま載せるだけで、
    // この関数がAIを呼ぶことはない。自動投稿は options を渡さないので常に空になる。
    const situationText = (options && typeof options.situationText === 'string')
      ? options.situationText.trim() : '';
    const ss = getSs_();
    const databaseSheet = getDbSheet_(ss);
    if (!databaseSheet) throw new Error("データベースシートが見つかりません");

    const courseName = getCourseNameSafe_();
    const courseId = getCourseIdByName(courseName);
    if (!courseId) throw new Error(`クラス「${courseName}」見つからず`);

    const dbCols = getDbColumns();
    const dbData = databaseSheet.getDataRange().getValues();

    const today = new Date();
    const daysOfWeek = ["日", "月", "火", "水", "木", "金", "土"];
    // 日付の比較・判定はすべて日本時間（JST）で行う。スプレッドシートやスクリプトの
    // タイムゾーン設定に依存せず、「次の日付」「今日の日付」が日本時間でずれないようにする。
    const jstDateKey_ = (d) => (d instanceof Date) ? Utilities.formatDate(d, "JST", "yyyyMMdd") : '';
    const jstDow_ = (d) => parseInt(Utilities.formatDate(d, "JST", "u"), 10) % 7; // u:1=月..7=日 → %7で日=0
    const jstLabel_ = (d) => `${Utilities.formatDate(d, "JST", "yyyy/MM/dd")}（${daysOfWeek[jstDow_(d)]}）`;
    const todayKey = jstDateKey_(today);

    // 本日（日本時間）が登校日（1校時に予定あり）かを判定する。本日の行データも保持し、
    // 「きょうのかだい」の組み立てに用いる。
    const todayRowData = findTodayRowWithPeriod1_(dbData, dbCols, todayKey);

    // 自動投稿では、休み中は投稿しない。休みに入る前の最終登校日に休み明けの予定を投稿済みのため、
    // ここで投稿すると同じ予定が重複して投稿されてしまう。
    // 一方、アプリのボタンからの手動投稿（isManual）は、土日・休み中でも投稿できるようこの判定をスキップする。
    if (!isManual && !todayRowData) {
      Logger.log(`本日は登校日ではないため自動投稿をスキップ`);
      return { success: true, posted: false, message: '本日は登校日ではないため投稿をスキップしました。' };
    }

    // 本日（日本時間）より後で、1校時に予定が入っている最も近い登校日を探す。
    // これにより休みを挟む場合でも、休み直前の登校日に次の登校日分が投稿される
    // （例：金曜日に翌週月曜日の予定を投稿）。
    let foundRowData = null;
    let foundKey = null;
    dbData.forEach(row => {
      const cellDate = row[dbCols.DATE - 1];
      if (!(cellDate instanceof Date) || !row[dbCols.PERIOD1 - 1]) return;
      const key = jstDateKey_(cellDate); // yyyyMMdd は文字列比較で日付の前後比較が成立する
      if (key > todayKey && (foundKey === null || key < foundKey)) {
        foundKey = key;
        foundRowData = row;
      }
    });

    if (!foundRowData) {
      Logger.log(`次の登校日の予定が見つからずスキップ`);
      return { success: true, posted: false, message: '次の登校日の予定が見つからないため投稿をスキップしました。' };
    }

    const targetDate = foundRowData[dbCols.DATE - 1];
    const formattedDateString = jstLabel_(targetDate);

    // 次の登校日（あした）の行から値を取得するヘルパー。
    const nextCell = (key) => (dbCols[key] ? (foundRowData[dbCols[key] - 1] || '').toString().trim() : '');
    // 本日（きょう）の行から値を取得するヘルパー。本日の行が無い場合は空文字。
    const todayCell = (key) => (dbCols[key] && todayRowData ? (todayRowData[dbCols[key] - 1] || '').toString().trim() : '');

    // 「あしたのよてい📅」: 次の登校日の行事・朝学習・1〜6校時の教科名と単元名
    let postText = `あしたのよてい📅（${formattedDateString}）\n\n`;
    const event = nextCell('EVENT');
    if (event) postText += `行事：${event}\n`;
    const morning = nextCell('MORNING');
    if (morning) postText += `朝学習：${morning}\n`;
    const periodLabels = ['１', '２', '３', '４', '５', '６'];
    for (let n = 1; n <= 6; n++) {
      const subject = nextCell('PERIOD' + n);
      if (!subject) continue;
      const unit = nextCell('UNIT' + n);
      postText += `${periodLabels[n - 1]}時間目：${subject}` + (unit ? `「${unit}」` : '') + `\n`;
    }

    // 「きょうのかだい🏚️」: 本日の行の課題をリストアップ
    const homeworkItems = listifyCellText_(todayCell('HOMEWORK'));
    if (homeworkItems.length) {
      postText += `\nきょうのかだい🏚️\n`;
      homeworkItems.forEach(h => { postText += `・${h}\n`; });
    }

    // 「もちもの✏️」: 次の登校日（あした）の行の持ち物をリストアップ
    const itemList = listifyCellText_(nextCell('ITEMS'));
    if (itemList.length) {
      postText += `\nもちもの✏️\n`;
      itemList.forEach(it => { postText += `・${it}\n`; });
    }

    // 担当学年が1年生の場合は、予定部分の漢字をすべてひらがなに自動変換する（子どもが自分で読めるように）。
    // Gemini未設定・変換失敗時は convertTextToHiragana_ が元の文章を返すため、投稿処理は継続する。
    const grade = parseInt(tGetProp_(SCRIPT_PROP_GRADE), 10);
    if (grade === 1 && typeof convertTextToHiragana_ === 'function') {
      postText = convertTextToHiragana_(postText);
    }

    // 「今日の様子」は、教員が画面で確認・修正した文章だけを追記する。
    // ここでAIに生成させることはしない。自動投稿（時間主導トリガー）は situationText を
    // 渡さないため、このセクションは構造的に付かない。
    // （かつては予定からAIが「実際に行われた前提」の文章を作り、教員の確認を経ずに
    //   保護者へ配信していた。事実と異なる内容が学校名義で届くため取りやめた。）
    // 漢字変換の後に追記するのは従来どおり。このセクションは全学年で漢字のまま（保護者が読む想定）。
    if (situationText) postText += `\n【今日の様子】\n${situationText}\n`;

    // 重複投稿の防止: 「コースID＋対象日」を識別子にする。本文ではなく対象日で判定するのは、
    // 教員が追記する「今日の様子」の有無で本文が変わっても、同じ日の予定を二重に投稿しないため。
    // 自動投稿で同一対象日が投稿済みならスキップ。手動投稿（教員の明示操作）は常に投稿する。
    const fingerprint = `${courseId}|${Utilities.formatDate(targetDate, "JST", "yyyyMMdd")}`;
    if (!isManual && hasRecentlyPostedSchedule_(fingerprint)) {
      Logger.log(`同一対象日の予定が投稿済みのため重複投稿をスキップ: ${formattedDateString}`);
      return { success: true, posted: false, message: `${formattedDateString} の予定は既に投稿済みのためスキップしました。` };
    }

    Classroom.Courses.Announcements.create({ text: postText.trim() }, courseId);
    recordPostedSchedule_(fingerprint);
    logInfo(`クラス「${courseName}」へ予定投稿完了`);
    return { success: true, posted: true, message: `クラス「${courseName}」へ ${formattedDateString} の予定を投稿しました。` };
}

/**
 * セル内のテキストを、リスト表示用の項目配列に分割します。
 * まず改行で分割し、1項目に収まる場合は読点（、，）やカンマ（,）でも分割します。
 * 空要素は取り除きます。
 * @param {*} value セルの値
 * @returns {string[]} 項目の配列（空のときは空配列）
 */
function listifyCellText_(value) {
  const raw = (value == null ? '' : value).toString().trim();
  if (!raw) return [];
  let parts = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (parts.length <= 1) {
    parts = raw.split(/[、，,]/).map(s => s.trim()).filter(Boolean);
  }
  return parts;
}

/**
 * 本日（日本時間）の行データを探します。1校時に予定が入っている行だけを「登校日」とみなします。
 * 同じ日付の行が複数ある場合は、最後に見つかったものを返します（従来の挙動を維持）。
 *
 * 予定の投稿（postScheduleToClassroom_core_）と「今日の様子」の下書き作成
 * （proposeTodaySituationFromWeb）の両方が本日の行を必要とするため、関数に切り出しています。
 * @param {Array[]} dbData データベースの全行
 * @param {Object} dbCols getDbColumns() の列マップ（1始まり）
 * @param {string} todayKey 本日の日付キー（JSTの yyyyMMdd）
 * @returns {?Array} 本日の行データ。登校日でなければ null
 */
function findTodayRowWithPeriod1_(dbData, dbCols, todayKey) {
  let found = null;
  dbData.forEach(row => {
    const cellDate = row[dbCols.DATE - 1];
    if (!(cellDate instanceof Date)) return;
    if (Utilities.formatDate(cellDate, "JST", "yyyyMMdd") !== todayKey) return;
    if (!row[dbCols.PERIOD1 - 1]) return;
    found = row;
  });
  return found;
}

/**
 * 1日分の行データから、AIに渡す授業内容のコンテキスト文字列を組み立てます。
 * 行事・朝学習・1〜6校時（教科・単元・学習内容）をまとめたテキストを返します。
 * @param {Array} rowData データベースの1行分の配列
 * @param {Object} dbCols getDbColumns() の列マップ（1始まり）
 * @returns {string} 授業内容のコンテキスト（空の場合は空文字）
 */
function buildLessonContext_(rowData, dbCols) {
  if (!rowData) return '';
  const cell = (key) => (dbCols[key] ? (rowData[dbCols[key] - 1] || '').toString().trim() : '');

  let ctx = '';
  const event = cell('EVENT');
  if (event) ctx += `行事: ${event}\n`;
  const morning = cell('MORNING');
  if (morning) ctx += `朝学習: ${morning}\n`;

  for (let n = 1; n <= 6; n++) {
    const subject = cell('PERIOD' + n);
    if (!subject) continue;
    const unit = cell('UNIT' + n);
    const content = cell('CONTENT' + n);
    let line = `${n}時間目: ${subject}`;
    if (unit) line += ` 「${unit}」`;
    if (content) line += ` ${content}`;
    ctx += line + '\n';
  }
  return ctx.trim();
}

/**
 * 指定されたクラス名から、Google ClassroomのコースIDを探し出します。
 */
function getCourseIdByName(courseName) {
  try {
    const cache = CacheService.getScriptCache();
    const cacheKey = `courseId_${courseName}`;
    const cachedId = cache.get(cacheKey);
    if (cachedId) return cachedId;

    let pageToken = null;
    do {
      const response = Classroom.Courses.list({ pageSize: 100, courseStates: ['ACTIVE'], pageToken: pageToken });
      if (response.courses) {
        const course = response.courses.find(c => c.name === courseName);
        if (course) {
          cache.put(cacheKey, course.id, 21600); // 6時間キャッシュ
          return course.id;
        }
      }
      pageToken = response.nextPageToken;
    } while (pageToken);
    throw new Error(`クラス「${courseName}」が見つかりません`);
  } catch (e) {
    logError("getCourseIdByName", e);
    throw e;
  }
}

function listCoursesFromWeb() {
  try {
    let courses = [];
    let pageToken = null;
    do {
      const response = Classroom.Courses.list({ pageSize: 100, courseStates: ['ACTIVE'], pageToken: pageToken });
      if (response.courses) {
        courses = courses.concat(response.courses);
      }
      pageToken = response.nextPageToken;
    } while (pageToken);

    const names = courses.map(c => c.name);
    logInfo('クラス一覧(Web): ' + names.join(', '));
    return {
      success: true,
      courses: names,
      message: names.length ? `${names.length}件のクラスを取得しました。` : '有効なクラスが見つかりませんでした。'
    };
  } catch (e) {
    logError("listCoursesFromWeb", e);
    return { success: false, courses: [], message: `クラス一覧取得エラー: ${e.message}` };
  }
}

/**
 * Classroom へ添付するファイルを、そのクラスの参加者だけが開けるように共有します。
 *
 * Classroom はコースごとに参加者のグループ（courseGroupEmail）を維持しているので、
 * そこへ閲覧権限を与える。「リンクを知っている全員」にはしない（17_DriveApi.gs 参照）。
 * 追加の権限は要らない（コースの取得は classroom.courses.readonly、権限付与は
 * 自分が作ったファイルなので drive.file の範囲）ため、先生に再承認を求めずに済む。
 *
 * **共有に失敗しても投稿は続ける。** 投稿そのものが止まるほうが困るため、
 * ここでは例外を投げず、教員へ伝える注意文を返して呼び出し側に判断させる。
 * @param {string} fileId 共有するファイルのID
 * @param {string} courseId 対象コースのID
 * @returns {string} 教員へ伝える注意文（うまくいったときは空文字）
 */
function shareFileWithCourse_(fileId, courseId) {
  const manualHint = '児童が開けない場合は、Google ドライブでこのファイルをクラスへ共有してください。';
  try {
    const course = Classroom.Courses.get(courseId);
    const groupEmail = course && course.courseGroupEmail;
    if (!groupEmail) {
      // 個人アカウント運用の Classroom などでは、コースのグループが無いことがある。
      logInfo(`コース ${courseId} に共有用グループが無いため、共有設定は変更しませんでした。`);
      return `このクラスには共有用のグループが無いため、ファイルの共有設定は変更していません。${manualHint}`;
    }
    driveShareReaderWithGroup_(fileId, groupEmail);
    logInfo(`ファイル ${fileId} をクラスの参加者（${groupEmail}）へ共有しました。`);
    return '';
  } catch (e) {
    logError('shareFileWithCourse_', e);
    return `ファイルの共有設定を変更できませんでした。${manualHint}`;
  }
}
