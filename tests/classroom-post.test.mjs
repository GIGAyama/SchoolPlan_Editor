import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Classroom への予定投稿を、偽の GAS 環境で実際に動かして検証する。
//
// いちばん守りたいのは「自動投稿がAIを呼ばないこと」。
// かつては予定から Gemini が『実際に授業が行われた前提』の文章を作り、
// 教員の確認を経ないまま保護者へ毎日配信していた（docs/LEGAL_RISK_AUDIT_JP.md の A-3）。
// 見ていない児童の様子が学校名義で届くため取りやめたが、
// 「便利だから」と将来また差し戻されやすい場所なので、呼び出し回数 0 を機械で固定しておく。

const SOURCE = fs.readFileSync('05_Classroom.gs', 'utf8');

// ---------------------------------------------------------------- 偽の GAS 環境

/**
 * new Date() を固定する。
 * 実装が `cellDate instanceof Date` で日付セルを判定するため、
 * テストが作る日付もこの FakeDate で作らないと instanceof が偽になる。
 */
const fakeDateClasses = new Map();
function makeFakeDate(nowIso) {
  // 同じ「現在時刻」なら同じクラスを返す。load() のたびに別クラスを作ると、
  // テストが作った日付が実装側の instanceof を通らなくなる。
  if (!fakeDateClasses.has(nowIso)) {
    const RealDate = Date;
    const fixed = new RealDate(nowIso).getTime();
    fakeDateClasses.set(nowIso, class FakeDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(fixed);
        else super(...args);
      }
    });
  }
  return fakeDateClasses.get(nowIso);
}

/** GAS の Utilities.formatDate のうち、この実装が使う書式だけを再現する（JST 固定）。 */
function formatDate(date, timeZone, format) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = jst.getUTCFullYear();
  const MM = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jst.getUTCDate()).padStart(2, '0');
  if (format === 'yyyyMMdd') return `${yyyy}${MM}${dd}`;
  if (format === 'yyyy/MM/dd') return `${yyyy}/${MM}/${dd}`;
  if (format === 'u') return String(jst.getUTCDay() === 0 ? 7 : jst.getUTCDay()); // 1=月..7=日
  throw new Error(`テストが未対応の書式です: ${format}`);
}

/** データベースの列マップ（1始まり）。実装が参照するキーだけを持つ。 */
const COLS = {
  DATE: 1, EVENT: 2, MORNING: 3,
  PERIOD1: 4, PERIOD2: 5, PERIOD3: 6, PERIOD4: 7, PERIOD5: 8, PERIOD6: 9,
  UNIT1: 10, UNIT2: 11, UNIT3: 12, UNIT4: 13, UNIT5: 14, UNIT6: 15,
  CONTENT1: 16, CONTENT2: 17, CONTENT3: 18, CONTENT4: 19, CONTENT5: 20, CONTENT6: 21,
  HOMEWORK: 22, ITEMS: 23
};
const WIDTH = 23;

/** 1行分の配列を作る。`{ DATE: d, PERIOD1: '国語' }` のような指定で書ける。 */
function row(values) {
  const cells = new Array(WIDTH).fill('');
  for (const [key, value] of Object.entries(values)) cells[COLS[key] - 1] = value;
  return cells;
}

/**
 * 05_Classroom.gs を偽の GAS 環境で読み込み、必要な関数と観測結果を返す。
 * 実行しない関数（PDF投稿など）のグローバルは注入しない。参照されたら落ちて気づける。
 */
function load(options = {}) {
  const FakeDate = makeFakeDate(options.now || '2026-06-17T01:00:00Z'); // JST 6/17(水) 10:00
  const dbRows = options.rows || [];
  const props = Object.assign({}, options.props);

  // 観測用
  const announcements = [];
  const aiCalls = [];

  const globals = {
    Date: FakeDate,
    Utilities: { formatDate },
    Logger: { log: () => {} },
    CacheService: {
      getScriptCache: () => ({ get: () => null, put: () => {} })
    },
    Classroom: {
      Courses: {
        // getCourseIdByName は 05_Classroom.gs 内で定義されているため差し替えできない。
        // 実装どおり一覧から名前で引かせる。
        list: () => ({ courses: [{ id: 'course-1', name: '3年2組' }] }),
        Announcements: {
          create: (announcement, courseId) => {
            announcements.push({ announcement, courseId });
            return { id: 'a1' };
          }
        }
      }
    },
    getSs_: () => ({}),
    getDbSheet_: () => {
      if (options.brokenDb) throw new Error('データベースが壊れています');
      return { getDataRange: () => ({ getValues: () => dbRows }) };
    },
    getDbColumns: () => COLS,
    getCourseNameSafe_: () => '3年2組',
    tGetProp_: (key) => (key in props ? props[key] : null),
    tSetProp_: (key, value) => { props[key] = value; },
    SCRIPT_PROP_GRADE: 'sp_grade',
    // 1年生向けのひらがな化。作用範囲を測れるよう、先頭に印を付けて返す。
    convertTextToHiragana_: (text) => 'HIRA:' + text,
    // AI下書き生成。呼ばれたら記録する（自動投稿では 0 回であるべき）。
    generateTodaySituationDraft_: (...args) => {
      aiCalls.push(args);
      return options.draft === undefined ? 'AIが書いた下書き' : options.draft;
    },
    SP_KEY_GEMINI_API_KEY: 'sp_geminiApiKey',
    getSetting: (key) => (key in props ? props[key] : ''),
    logInfo: () => {},
    logError: () => {},
    describeAuthError_: (e) => (e && e.message) ? e.message : String(e),
    validateParams_: () => {}
  };

  const names = Object.keys(globals);
  const factory = new Function(...names, `
    ${SOURCE}
    return { postScheduleToClassroom, postScheduleToClassroomFromWeb, postScheduleToClassroom_core_,
             proposeTodaySituationFromWeb,
             findTodayRowWithPeriod1_, buildLessonContext_, listifyCellText_ };
  `);
  const api = factory(...names.map(name => globals[name]));
  return { api, announcements, aiCalls, props, FakeDate };
}

/** 「本日=6/17(水)が登校日、翌日=6/18(木)にも予定あり」という標準のDBを作る。 */
function standardRows(FakeDate) {
  return [
    row({ DATE: 'ヘッダ' }),
    row({
      DATE: new FakeDate('2026-06-17T00:00:00+09:00'),
      PERIOD1: '国語', UNIT1: 'まいごのかぎ', CONTENT1: '全文を読む',
      PERIOD2: '算数',
      EVENT: '授業参観', MORNING: '読書',
      HOMEWORK: '音読\n漢字ドリル14'
    }),
    row({
      DATE: new FakeDate('2026-06-18T00:00:00+09:00'),
      PERIOD1: '体育', UNIT1: '水泳運動',
      PERIOD2: '社会',
      ITEMS: '水泳セット、ぼうし'
    })
  ];
}

// ---------------------------------------------------------------- 中核の回帰テスト

test('自動投稿はAIの下書き生成を一度も呼ばない', () => {
  const { api, aiCalls, announcements } = (() => {
    const first = load();
    return load({ rows: standardRows(first.FakeDate) });
  })();

  const result = api.postScheduleToClassroom_core_();

  assert.equal(result.posted, true);
  assert.equal(aiCalls.length, 0, '自動投稿からAIが呼ばれています');
  assert.equal(announcements.length, 1);
  assert.doesNotMatch(announcements[0].announcement.text, /【今日の様子】/);
});

test('自動投稿の本文は予定・課題・持ち物だけで構成される', () => {
  const seed = load();
  const { api, announcements } = load({ rows: standardRows(seed.FakeDate) });

  api.postScheduleToClassroom_core_();
  const text = announcements[0].announcement.text;

  assert.match(text, /あしたのよてい/);
  assert.match(text, /2026\/06\/18（木）/);
  assert.match(text, /１時間目：体育「水泳運動」/);
  assert.match(text, /きょうのかだい/);
  assert.match(text, /・音読/);
  assert.match(text, /・漢字ドリル14/);
  assert.match(text, /もちもの/);
  assert.match(text, /・水泳セット/);
});

test('手動投稿では、渡された「今日の様子」だけが本文末尾に載る', () => {
  const seed = load();
  const { api, announcements, aiCalls } = load({ rows: standardRows(seed.FakeDate) });

  const result = api.postScheduleToClassroom_core_({
    manual: true,
    situationText: '国語では場面の様子を読み取りました。'
  });

  assert.equal(result.posted, true);
  assert.equal(aiCalls.length, 0, '渡された文章を載せるだけで、AIを呼んではいけません');
  assert.match(announcements[0].announcement.text,
    /【今日の様子】\n国語では場面の様子を読み取りました。/);
});

test('「今日の様子」が空・未指定ならセクションごと付かない', () => {
  const seed = load();
  for (const options of [{ manual: true }, { manual: true, situationText: '' },
                         { manual: true, situationText: '   ' }]) {
    const { api, announcements } = load({ rows: standardRows(seed.FakeDate) });
    api.postScheduleToClassroom_core_(options);
    assert.doesNotMatch(announcements[0].announcement.text, /【今日の様子】/,
      `situationText=${JSON.stringify(options.situationText)} でセクションが付きました`);
  }
});

test('1年生のひらがな化は予定だけに効き、「今日の様子」は漢字のまま残る', () => {
  const seed = load();
  const { api, announcements } = load({
    rows: standardRows(seed.FakeDate),
    props: { sp_grade: '1' }
  });

  api.postScheduleToClassroom_core_({ manual: true, situationText: '漢字のままの文章' });
  const text = announcements[0].announcement.text;

  // ひらがな化スタブは先頭に印を付ける。印より後ろ＝変換の外側に「今日の様子」が来ること。
  assert.match(text, /^HIRA:/);
  const situationIndex = text.indexOf('【今日の様子】');
  assert.ok(situationIndex > 0, '「今日の様子」が本文にありません');
  assert.ok(situationIndex > text.indexOf('あしたのよてい'),
    'ひらがな化の対象範囲に「今日の様子」が入っています');
  assert.match(text, /【今日の様子】\n漢字のままの文章/);
});

// ---------------------------------------------------------------- 既存の分岐が壊れていないこと

test('自動投稿は、本日が登校日でなければ投稿しない（手動なら投稿する）', () => {
  const seed = load();
  const rowsWithoutToday = [
    row({ DATE: 'ヘッダ' }),
    row({ DATE: new seed.FakeDate('2026-06-18T00:00:00+09:00'), PERIOD1: '体育' })
  ];

  const auto = load({ rows: rowsWithoutToday });
  const autoResult = auto.api.postScheduleToClassroom_core_();
  assert.equal(autoResult.posted, false);
  assert.equal(auto.announcements.length, 0);

  const manual = load({ rows: rowsWithoutToday });
  const manualResult = manual.api.postScheduleToClassroom_core_({ manual: true });
  assert.equal(manualResult.posted, true);
  assert.equal(manual.announcements.length, 1);
});

test('自動投稿の重複ガードは効き、手動投稿では効かない', () => {
  const seed = load();
  const posted = JSON.stringify({ 'course-1|20260618': Date.now() });

  const auto = load({ rows: standardRows(seed.FakeDate), props: { sp_postedScheduleLog: posted } });
  assert.equal(auto.api.postScheduleToClassroom_core_().posted, false);
  assert.equal(auto.announcements.length, 0);

  const manual = load({ rows: standardRows(seed.FakeDate), props: { sp_postedScheduleLog: posted } });
  assert.equal(manual.api.postScheduleToClassroom_core_({ manual: true }).posted, true);
  assert.equal(manual.announcements.length, 1);
});

test('トリガーの入口は引数なしで core を呼ぶ（＝自動投稿に「今日の様子」が混ざらない）', () => {
  const seed = load();
  const { api, announcements, aiCalls } = load({ rows: standardRows(seed.FakeDate) });

  api.postScheduleToClassroom();

  assert.equal(aiCalls.length, 0);
  assert.equal(announcements.length, 1);
  assert.doesNotMatch(announcements[0].announcement.text, /【今日の様子】/);
});

test('Webアプリ API は引数なしで呼ばれても従来どおり投稿できる', () => {
  const seed = load();
  const { api, announcements } = load({ rows: standardRows(seed.FakeDate) });

  const result = api.postScheduleToClassroomFromWeb();

  assert.equal(result.posted, true);
  assert.doesNotMatch(announcements[0].announcement.text, /【今日の様子】/);
});

// ---------------------------------------------------------------- 下書きAPI（投稿しない）

const WITH_KEY = { sp_geminiApiKey: 'test-key' };

test('下書きAPIは下書きを返すだけで、投稿はしない', () => {
  const seed = load();
  const { api, announcements, aiCalls } = load({
    rows: standardRows(seed.FakeDate), props: Object.assign({}, WITH_KEY)
  });

  const res = api.proposeTodaySituationFromWeb();

  assert.equal(res.success, true);
  assert.equal(res.available, true);
  assert.equal(res.draft, 'AIが書いた下書き');
  assert.equal(res.dateLabel, '2026/06/17（水）');
  assert.equal(aiCalls.length, 1);
  assert.equal(announcements.length, 0, '下書きAPIが投稿してしまっています');
});

test('下書きを作れないときも success:true で返し、予定だけの投稿を妨げない', () => {
  const seed = load();
  const rows = standardRows(seed.FakeDate);

  // APIキー未設定
  const noKey = load({ rows });
  const a = noKey.api.proposeTodaySituationFromWeb();
  assert.equal(a.success, true);
  assert.equal(a.available, false);
  assert.equal(a.reason, 'no-api-key');
  assert.equal(noKey.aiCalls.length, 0, 'キーが無いのにAIを呼んでいます');

  // 本日が登校日でない
  const noLesson = load({
    rows: [row({ DATE: new seed.FakeDate('2026-06-18T00:00:00+09:00'), PERIOD1: '体育' })],
    props: Object.assign({}, WITH_KEY)
  });
  const b = noLesson.api.proposeTodaySituationFromWeb();
  assert.equal(b.success, true);
  assert.equal(b.available, false);
  assert.equal(b.reason, 'no-lesson');

  // AIが空を返した
  const failed = load({ rows, props: Object.assign({}, WITH_KEY), draft: '' });
  const c = failed.api.proposeTodaySituationFromWeb();
  assert.equal(c.success, true);
  assert.equal(c.available, false);
  assert.equal(c.reason, 'generation-failed');
  assert.ok(c.message.length > 0);
});

test('下書きAPIは例外を投げない（予定だけの投稿を巻き添えにしない）', () => {
  const { api } = load({ brokenDb: true, props: Object.assign({}, WITH_KEY) });

  let res;
  assert.doesNotThrow(() => { res = api.proposeTodaySituationFromWeb(); });
  assert.equal(res.success, true);
  assert.equal(res.available, false);
  assert.equal(res.reason, 'generation-failed');
});

// ---------------------------------------------------------------- 純関数

test('findTodayRowWithPeriod1_ は1校時が空の日を登校日とみなさない', () => {
  const seed = load();
  const { api, FakeDate } = seed;
  const target = new FakeDate('2026-06-17T00:00:00+09:00');

  const rows = [
    row({ DATE: target, EVENT: '振替休日' }),                 // 1校時が空
    row({ DATE: new FakeDate('2026-06-18T00:00:00+09:00'), PERIOD1: '体育' })
  ];
  assert.equal(api.findTodayRowWithPeriod1_(rows, COLS, '20260617'), null);

  const withLesson = [row({ DATE: target, PERIOD1: '国語' })];
  assert.notEqual(api.findTodayRowWithPeriod1_(withLesson, COLS, '20260617'), null);

  // 日付でない値（ヘッダ行など）が混ざっても落ちない
  assert.equal(api.findTodayRowWithPeriod1_([row({ DATE: '日付' })], COLS, '20260617'), null);
});

test('buildLessonContext_ は予定の記述だけを組み立てる', () => {
  const { api } = load();
  const ctx = api.buildLessonContext_(row({
    EVENT: '授業参観', MORNING: '読書',
    PERIOD1: '国語', UNIT1: 'まいごのかぎ', CONTENT1: '全文を読む',
    PERIOD3: '体育'
  }), COLS);

  assert.match(ctx, /行事: 授業参観/);
  assert.match(ctx, /朝学習: 読書/);
  assert.match(ctx, /1時間目: 国語 「まいごのかぎ」 全文を読む/);
  assert.match(ctx, /3時間目: 体育/);
  assert.doesNotMatch(ctx, /2時間目/, '空の校時は出力しません');
  assert.equal(api.buildLessonContext_(null, COLS), '');
});

test('listifyCellText_ は改行と読点で項目に分ける', () => {
  const { api } = load();
  assert.deepEqual(api.listifyCellText_('音読\n漢字ドリル14'), ['音読', '漢字ドリル14']);
  assert.deepEqual(api.listifyCellText_('水泳セット、ぼうし'), ['水泳セット', 'ぼうし']);
  assert.deepEqual(api.listifyCellText_(''), []);
});

// ---------------------------------------------------------------- 静的検査

/** 指定した関数の本文（次のトップレベル関数の手前まで）を切り出す。 */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} が見つかりません`);
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test('投稿の経路にAI下書き生成が入っていない', () => {
  // 呼び出し（identifier + 開き括弧）だけを見る。コメントでの言及は残してよい。
  const stripComments = (text) => text.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  const CALL = /generateTodaySituation\w*\s*\(/;

  assert.doesNotMatch(stripComments(functionBody(SOURCE, 'postScheduleToClassroom_core_')), CALL,
    '投稿の本体にAI生成が戻っています。下書きは教員が確認する画面から取得してください。');
  assert.doesNotMatch(stripComments(functionBody(SOURCE, 'postScheduleToClassroomFromWeb')), CALL);
  assert.doesNotMatch(stripComments(functionBody(SOURCE, 'postScheduleToClassroom')), CALL);

  // 呼んでよいのは「投稿しない」下書きAPIだけ。
  const proposeBody = functionBody(SOURCE, 'proposeTodaySituationFromWeb');
  assert.match(proposeBody, CALL);
  assert.doesNotMatch(proposeBody, /Announcements\.create/,
    '下書きAPIが投稿してしまっています');
});

test('時間主導トリガーの入口は core を引数なしで呼ぶ', () => {
  // ここに options を渡す実装に変わると、自動投稿に「今日の様子」が混ざる余地が生まれる。
  assert.match(functionBody(SOURCE, 'postScheduleToClassroom'),
    /postScheduleToClassroom_core_\(\s*\)/);
});

test('画面側は「下書きを見せてから投稿」の2段構えになっている', () => {
  const tools = fs.readFileSync('App_Js_13_SystemTools.html', 'utf8');
  const app = fs.readFileSync('App.html', 'utf8');

  assert.match(app, /postScheduleWithSituationWeb\(this\)/, '確認つき投稿のボタンがありません');

  const flow = tools.slice(tools.indexOf('function postScheduleWithSituationWeb'));
  const body = flow.slice(0, flow.indexOf('\n    function ', 1));

  assert.match(body, /_callServerAsync\('proposeTodaySituationFromWeb'\)/,
    '下書きAPIを呼んでいません');
  assert.match(body, /swalSituation/, '確認・修正用のテキスト欄がありません');
  // 下書きは HTML 文字列ではなく値として入れる（生成結果に < が混ざっても壊れない／差し込まれない）
  assert.match(body, /didOpen[\s\S]*?el\.value = res\.draft/);
  assert.doesNotMatch(body, /html:[^\n]*res\.draft/,
    '下書きをHTMLに埋め込んでいます。textarea の value に入れてください。');
  // 投稿は必ず確認（isConfirmed）か「様子なし」（isDenied）を経由する
  assert.match(body, /result\.isConfirmed/);
  assert.match(body, /result\.isDenied/);

  const postCalls = body.match(/postScheduleToClassroomFromWeb/g) || [];
  assert.equal(postCalls.length, 2,
    '投稿の呼び出しは「確認して投稿」と「様子なしで投稿」の2つだけであるべきです');
});

test('AI下書きのプロンプトが「実施した前提」で書かせていない', () => {
  const gemini = fs.readFileSync('08_Gemini.gs', 'utf8');
  const body = functionBody(gemini, 'generateTodaySituationDraft_');

  assert.doesNotMatch(body, /実際に行われたという前提/,
    'AIに「授業が実際に行われた前提」で書かせる指示が戻っています');
  assert.match(body, /予定に書かれていない出来事を書かないでください/);
  assert.match(body, /授業が実際に行われたかどうかは分かりません/);
});
