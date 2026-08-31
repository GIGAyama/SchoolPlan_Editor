import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

/**
 * 単元進捗・整合性・AI検証のロジックを実際に動かすためのコンテキスト。
 * これらの .gs はトップレベルでGAS APIを呼ばないため、そのまま読み込める。
 */
function loadContext(extraFiles = []) {
  const context = vm.createContext({ console });
  const files = [
    '00_config.gs', '99_Utils.gs', '04_AutoFill.gs',
    '14_UnitProgress.gs', '15_UnitMasterOps.gs', '16_UnitRecompose.gs',
    ...extraFiles
  ];
  for (const file of files) {
    vm.runInContext(read(file), context, { filename: file });
  }
  // Date は必ず vm 側の realm で生成する。ホスト側の Date は vm 内の
  // `instanceof Date` を通らず、buildTaughtHistory_ が黙って空を返す。
  vm.runInContext('globalThis.__mkDate = (y, m, d) => new Date(y, m, d);', context);
  return context;
}

/**
 * vm から返る配列はホスト側の Array とコンストラクタが異なるため、
 * assert.deepEqual がそのままでは通らない。比較前にホスト側の配列へ移す。
 */
const host = (arr) => [...arr];

const DB_COLS = { DATE: 1, PERIOD1: 2, UNIT1: 3 };

const MASTER = [
  ['教科', '単元名', '総時間数', '何時間目'],
  ['国語', 'ごんぎつね', 3, 1],
  ['国語', 'ごんぎつね', 3, 2],
  ['国語', 'ごんぎつね', 3, 3],
  ['国語', '大造じいさん', 2, 1],
  ['国語', '大造じいさん', 2, 2],
  ['国語', 'たずねびと', 4, 1],
  ['図工', '版画', 2, 1],
  ['図工', '版画', 2, 2]
];

function buildDb(mk) {
  return [
    ['日付', '1校時', '単元1'],
    [mk(2026, 3, 10), '国語', 'ごんぎつね 1/3'],
    [mk(2026, 3, 11), '国語', 'ごんぎつね 2/3'],
    [mk(2026, 3, 12), '国語', 'ごんぎつね 3/3'],
    [mk(2026, 3, 13), '国語', '大造じいさん 1/2'],
    // 週案では「図画工作」、単元マスタでは「図工」— 表記ゆれを吸収できるか
    [mk(2026, 3, 20), '図画工作', '版画 1/2'],
    // 単元マスタに存在しない単元（改名・手入力で発生する）
    [mk(2026, 3, 21), '国語', '幻の単元 1/2']
  ];
}

function progressFor(context) {
  const mk = context.__mkDate;
  return context.buildUnitProgressPayload_(
    MASTER, buildDb(mk), DB_COLS, mk(2026, 3, 15), mk(9999, 0, 1)
  );
}

// ===== 単元進捗インデックス =====

test('全時数を指導した単元は指導済みになる', () => {
  const out = progressFor(loadContext());
  const unit = out.subjects['国語'].units.find((u) => u.unitName === 'ごんぎつね');
  assert.equal(unit.status, 'done');
  assert.equal(unit.taughtHour, 3);
  assert.equal(unit.effectiveTotal, 3);
});

test('途中まで指導した単元は次の時間目を返し「次はここから」になる', () => {
  const out = progressFor(loadContext());
  const unit = out.subjects['国語'].units.find((u) => u.unitName === '大造じいさん');
  assert.equal(unit.status, 'inProgress');
  assert.equal(unit.nextHour, 2);
  assert.equal(unit.isNext, true);
  assert.equal(out.subjects['国語'].nextUnitName, '大造じいさん');
});

test('未着手の単元は untaught で1時間目から始まる', () => {
  const out = progressFor(loadContext());
  const unit = out.subjects['国語'].units.find((u) => u.unitName === 'たずねびと');
  assert.equal(unit.status, 'untaught');
  assert.equal(unit.nextHour, 1);
  assert.equal(unit.isNext, false);
});

test('図工と図画工作の表記ゆれを同一教科として扱い、シート上の表記を保つ', () => {
  const out = progressFor(loadContext());
  const subject = out.subjects['図画工作'];
  assert.ok(subject, '正規化した教科名でキーが作られる');
  assert.equal(subject.subjectLabel, '図工', 'ラベルはシート上の生表記');
  const unit = subject.units.find((u) => u.unitName === '版画');
  assert.equal(unit.plannedHour, 1);
});

test('実施済みと割当済みを区別する（未来の予定は実施済みに数えない）', () => {
  const out = progressFor(loadContext());
  // 版画は 2026/4/20 の予定。基準日 2026/4/15 より後なので未実施。
  const unit = out.subjects['図画工作'].units.find((u) => u.unitName === '版画');
  assert.equal(unit.plannedHour, 1, '週案には入力済み');
  assert.equal(unit.taughtHour, 0, 'まだ実施はしていない');
});

test('週案にあるが単元マスタに無い単元を孤立単元として拾う', () => {
  const out = progressFor(loadContext());
  const orphans = out.subjects['国語'].orphans;
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].unitName, '幻の単元');
});

// ===== 整合性チェック =====

function analyze(context, master, planned = {}) {
  return context.analyzeUnitConsistency_(master, planned, [{ subject: '国語', hours: 10 }]);
}

test('整合している単元は不整合として報告しない', () => {
  const context = loadContext();
  const result = analyze(context, [
    ['教科', '単元名', '総時間数', '何時間目', '活動'],
    ['国語', '正常', 2, 1, 'a'],
    ['国語', '正常', 2, 2, 'b']
  ]);
  assert.deepEqual(host(result.units[0].issues), []);
  assert.equal(result.units[0].repairable, false);
  assert.equal(result.summary.issueCount, 0);
});

test('総時間数と行数のズレ・時数の重複・行の非連続を検出する', () => {
  const context = loadContext();
  const result = analyze(context, [
    ['教科', '単元名', '総時間数', '何時間目', '活動'],
    ['国語', 'ズレ', 5, 1, 'a'],
    ['国語', 'ズレ', 5, 2, 'b'],
    ['国語', '重複', 3, 1, 'c'],
    ['国語', '重複', 3, 1, 'd'],
    ['国語', '重複', 3, 3, 'e'],
    ['図工', '離れ', 2, 1, 'f'],
    ['国語', '別単元', 1, 1, 'g'],
    ['図工', '離れ', 2, 2, 'h']
  ]);
  const byName = Object.fromEntries(result.units.map((u) => [u.unitName, u]));
  assert.ok(byName['ズレ'].issues.includes('TOTAL_MISMATCH'));
  assert.ok(byName['重複'].issues.includes('HOUR_DUPLICATE'));
  assert.ok(byName['重複'].issues.includes('HOUR_GAP'));
  assert.ok(byName['離れ'].issues.includes('NON_CONTIGUOUS'));
});

test('総時数より行が多いのは不整合にしない（短く閉じた単元を戻さないため）', () => {
  const context = loadContext();
  // 5時間ぶんの指導案を残したまま、総時数だけ 3 にした状態
  const result = analyze(context, [
    ['教科', '単元名', '総時間数', '何時間目', '活動'],
    ['国語', '短く閉じた', 3, 1, 'a'],
    ['国語', '短く閉じた', 3, 2, 'b'],
    ['国語', '短く閉じた', 3, 3, 'c'],
    ['国語', '短く閉じた', 3, 4, 'd'],
    ['国語', '短く閉じた', 3, 5, 'e']
  ]);
  const u = result.units[0];
  assert.equal(host(u.issues).includes('TOTAL_MISMATCH'), false,
    '短く閉じた単元を不整合として扱うと、修復のたびに総時数が行数へ戻されます');
  assert.equal(u.repairable, false);
  // 教科ごとの時数合計も、行数ではなく総時数で数える
  assert.equal(result.subjectTotals[0].unitHoursTotal, 3);
});

test('総時数のぶんだけ行が足りないのは、これまでどおり不整合として拾う', () => {
  const context = loadContext();
  const result = analyze(context, [
    ['教科', '単元名', '総時間数', '何時間目', '活動'],
    ['国語', '行が足りない', 5, 1, 'a'],
    ['国語', '行が足りない', 5, 2, 'b']
  ]);
  assert.ok(host(result.units[0].issues).includes('TOTAL_MISMATCH'));
});

test('週案が総時数を超えて進んでいる単元を検出する', () => {
  const context = loadContext();
  const planned = { '国語': { units: { '超過': { maxHour: 5, cellTotalMax: 5, taught: {} } } } };
  const result = analyze(context, [
    ['教科', '単元名', '総時間数', '何時間目', '活動'],
    ['国語', '超過', 2, 1, 'a'],
    ['国語', '超過', 2, 2, 'b']
  ], planned);
  assert.ok(result.units[0].issues.includes('TAUGHT_EXCEEDS_TOTAL'));
  // 指導済みの5時間を下回らせない
  assert.equal(result.units[0].repairPlan.totalHours, 5);
});

test('教科ごとの単元時数合計を標準時数と突き合わせる', () => {
  const context = loadContext();
  const result = analyze(context, [
    ['教科', '単元名', '総時間数', '何時間目', '活動'],
    ['国語', 'A', 6, 1, 'a'],
    ['国語', 'A', 6, 2, 'b'],
    ['理科', 'B', 1, 1, 'c']
  ]);
  const kokugo = result.subjectTotals.find((t) => t.subjectKey === '国語');
  assert.equal(kokugo.unitHoursTotal, 6);
  assert.equal(kokugo.standardHours, 10);
  assert.equal(kokugo.diff, -4);
  // 標準時数が未設定の教科は差を出さない
  const rika = result.subjectTotals.find((t) => t.subjectKey === '理科');
  assert.equal(rika.standardHours, null);
  assert.equal(rika.diff, null);
});

test('修復は内容を消さずに連番を振り直し、離れた行を集約する', () => {
  const context = loadContext();
  const master = [
    ['教科', '単元名', '総時間数', '何時間目', '活動'],
    ['国語', '重複', 3, 1, 'c'],
    ['国語', '重複', 3, 1, 'd'],
    ['国語', '重複', 3, 3, 'e'],
    ['図工', '離れ', 2, 1, 'f'],
    ['国語', '別単元', 1, 1, 'g'],
    ['図工', '離れ', 2, 2, 'h']
  ];
  const analysis = analyze(context, master);
  const built = context.buildRepairedMasterRows_(master, analysis, [
    { subject: '国語', unitName: '重複' },
    { subject: '図工', unitName: '離れ' }
  ]);

  const dup = host(built.rows).filter((r) => r[1] === '重複');
  assert.deepEqual(dup.map((r) => r[3]), [1, 2, 3], '何時間目が1から連番になる');
  assert.deepEqual(dup.map((r) => r[4]), ['c', 'd', 'e'], '学習活動は失われない');

  const split = host(built.rows).filter((r) => r[1] === '離れ');
  const firstIdx = built.rows.findIndex((r) => r[1] === '離れ');
  assert.equal(split.length, 2);
  assert.equal(built.rows[firstIdx + 1][1], '離れ', '同一単元の行が連続する');

  // 対象外の単元はそのまま残る
  assert.ok(built.rows.some((r) => r[1] === '別単元' && r[4] === 'g'));
});

// ===== AI出力の検証 =====

const VALID_ACTIVITY = 'めあて：まとめよう\n・要点を確認する\n・振り返りを書く';

test('正しい再構成案は受理され、時間目の昇順に整えられる', () => {
  const context = loadContext();
  const verdict = context.validateRecomposition_(
    [{ hour: 4, activity: VALID_ACTIVITY }, { hour: 3, activity: VALID_ACTIVITY }], 3, 4
  );
  assert.equal(verdict.ok, true);
  assert.deepEqual(host(verdict.hours).map((h) => h.hour), [3, 4]);
});

test('件数・重複・範囲外・欠番のいずれかがあれば再構成案を破棄する', () => {
  const context = loadContext();
  const cases = [
    [[{ hour: 3, activity: VALID_ACTIVITY }], '件数不足'],
    [[{ hour: 3, activity: VALID_ACTIVITY }, { hour: 3, activity: VALID_ACTIVITY }], '重複'],
    [[{ hour: 1, activity: VALID_ACTIVITY }, { hour: 4, activity: VALID_ACTIVITY }], '範囲外'],
    [null, '配列でない']
  ];
  for (const [items, label] of cases) {
    const verdict = context.validateRecomposition_(items, 3, 4);
    assert.equal(verdict.ok, false, `${label} は破棄されるべき`);
    assert.ok(verdict.error);
  }
});

test('短すぎる内容やプレースホルダ混入の再構成案を破棄する', () => {
  const context = loadContext();
  const short = context.validateRecomposition_(
    [{ hour: 3, activity: '短い' }, { hour: 4, activity: VALID_ACTIVITY }], 3, 4
  );
  assert.equal(short.ok, false);

  const placeholder = context.validateRecomposition_(
    [{ hour: 3, activity: '（単元マスタに該当する活動が見つかりませんでした）' },
     { hour: 4, activity: VALID_ACTIVITY }], 3, 4
  );
  assert.equal(placeholder.ok, false);
});

const REMAINING = [
  { unitName: 'A', currentTotal: 8, minHours: 3 },
  { unitName: 'B', currentTotal: 6, minHours: 1 },
  { unitName: 'C', currentTotal: 4, minHours: 1 }
];

test('合計が目標と一致する再配分案は受理される', () => {
  const context = loadContext();
  const verdict = context.validateReallocation_(
    [{ unitName: 'A', proposedTotal: 7 }, { unitName: 'B', proposedTotal: 5 }, { unitName: 'C', proposedTotal: 4 }],
    REMAINING, 16
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.allocation.reduce((a, x) => a + x.proposedTotal, 0), 16);
  assert.equal(verdict.allocation.find((x) => x.unitName === 'A').delta, -1);
});

test('合計のわずかなズレは決定的に補正し、大きなズレは破棄する', () => {
  const context = loadContext();
  const items = [
    { unitName: 'A', proposedTotal: 7 }, { unitName: 'B', proposedTotal: 5 }, { unitName: 'C', proposedTotal: 4 }
  ];
  const near = context.validateReallocation_(items, REMAINING, 17);
  assert.equal(near.ok, true);
  assert.equal(near.allocation.reduce((a, x) => a + x.proposedTotal, 0), 17);

  const far = context.validateReallocation_(items, REMAINING, 24);
  assert.equal(far.ok, false);
});

test('指導済みを下回る配分や対象外の単元を含む案を破棄する', () => {
  const context = loadContext();
  const below = context.validateReallocation_(
    [{ unitName: 'A', proposedTotal: 2 }, { unitName: 'B', proposedTotal: 5 }, { unitName: 'C', proposedTotal: 4 }],
    REMAINING, 11
  );
  assert.equal(below.ok, false, 'A は3時間まで指導済みなので2時間には減らせない');

  const unknown = context.validateReallocation_(
    [{ unitName: 'X', proposedTotal: 7 }, { unitName: 'B', proposedTotal: 5 }, { unitName: 'C', proposedTotal: 4 }],
    REMAINING, 16
  );
  assert.equal(unknown.ok, false);
});

test('ルールベースの配分案は目標時数ちょうどになり下限を守る', () => {
  const context = loadContext();
  for (const target of [12, 18, 24]) {
    const baseline = context.buildReallocationBaseline_(REMAINING, target);
    assert.equal(baseline.reduce((a, x) => a + x.proposedTotal, 0), target, `目標 ${target}`);
    baseline.forEach((b) => {
      const src = REMAINING.find((u) => u.unitName === b.unitName);
      assert.ok(b.proposedTotal >= src.minHours, `${b.unitName} が下限を下回らない`);
    });
  }
});

// ===== 配線・起動経路の静的検査 =====

test('単元進捗の取得は起動経路から呼ばれない', () => {
  const performance = read('12_Performance.gs');
  const bootstrap = performance.slice(
    performance.indexOf('function getAppBootstrapV2'),
    performance.indexOf('function getWeeklyPlanDataV2')
  );
  assert.doesNotMatch(bootstrap, /getUnitProgressIndexFromWeb/);
});

test('単元サジェストは単元マスタを全列読みしない', () => {
  const webApp = read('07_WebApp.gs');
  const fn = webApp.slice(
    webApp.indexOf('function getUnitMasterForSuggest'),
    webApp.indexOf('function getActivityFromMaster')
  );
  assert.doesNotMatch(fn, /getDataRange\(\)/);
  assert.match(fn, /getRange\(1, 1, lastRow, MASTER_COL_TOTAL_HOURS\)/);
});

test('進捗キャッシュのキーはスプレッドシートIDとDBシート名を含む', () => {
  const source = read('14_UnitProgress.gs');
  assert.match(source, /function upCacheKey_\(spreadsheetId, dbSheetName\)/);
  assert.match(source, /UP_CACHE_PREFIX_ \+ spreadsheetId \+ '::' \+ dbSheetName/);
  // マルチテナントで他人のデータを参照しないよう UserCache を使う。
  // 読み書きは 11_Tenant.gs の tCacheGet_ / tCachePut_ / tCacheRemoveAll_ を通す
  // （UserCache の薄い包みで、1回の実行の中で同じ鍵を何度も取りに行かない）。
  assert.match(source, /tCache(Get|Put|RemoveAll)_\(/);
  assert.doesNotMatch(source, /CacheService\.getScriptCache\(\)/);
});

test('週案と単元マスタを変更する経路が進捗キャッシュを破棄する', () => {
  for (const file of [
    '12_Performance.gs', '07_WebApp.gs', '03_PdfProcessing.gs',
    '04_AutoFill.gs', '13_DataProtection_Trash.gs'
  ]) {
    assert.match(read(file), /invalidateUnitProgressCache_\(\)/, `${file} が破棄を呼ぶ`);
  }
});

test('単元単位の書き込みはロック・スナップショット・監査・キャッシュ破棄を伴う', () => {
  const source = read('15_UnitMasterOps.gs');
  const writer = source.slice(source.indexOf('function p4WriteUnitRows_'));
  assert.match(writer, /p3WithUserLock_/);
  assert.match(writer, /p3CreateSnapshot_\(\s*'unitMaster'/);
  assert.match(writer, /p3RecordAudit_/);
  assert.match(writer, /invalidateUnitProgressCache_/);
  // 行が連続していない単元は書き換えを拒否する
  assert.match(writer, /連続していません/);
});

test('提案系APIはシートに書き込まない', () => {
  const source = read('16_UnitRecompose.gs');
  for (const name of ['function proposeUnitRecomposition', 'function proposeAnnualReallocation']) {
    const start = source.indexOf(name);
    const body = source.slice(start, source.indexOf('\n}', start));
    assert.doesNotMatch(body, /setValues|deleteRows|insertRows/, `${name} は読み取り専用`);
  }
});

test('AI呼び出しは共通トランスポートと構造化出力を使う', () => {
  const source = read('16_UnitRecompose.gs');
  assert.doesNotMatch(source, /UrlFetchApp\.fetch/);
  assert.match(source, /callGeminiJsonArray_/);
  const gemini = read('08_Gemini.gs');
  const helper = gemini.slice(gemini.indexOf('function callGeminiJsonArray_'));
  assert.match(helper, /responseMimeType: "application\/json"/);
  assert.match(helper, /responseSchema/);
  assert.match(helper, /callGeminiEndpoint_/);
  assert.match(helper, /repairTruncatedJsonArray_/);
});

test('新しいフロントエンドのパーシャルが App.html に取り込まれている', () => {
  const app = read('App.html');
  for (const name of [
    'App_Css_02_UnitPlanning', 'App_Js_16_UnitProgress',
    'App_Js_17_UnitMasterAI', 'App_Js_18_UnitMasterCheck'
  ]) {
    assert.match(app, new RegExp(`include\\('${name}'\\)`), `${name} が include されている`);
  }
  // 進捗つきピッカーは 02_Plan のフォールバックを使うため後に読み込む必要がある
  assert.ok(
    app.indexOf("include('App_Js_16_UnitProgress')") > app.indexOf("include('App_Js_02_Plan')"),
    '進捗ピッカーは 02_Plan より後'
  );
  // 再構成UIは PDF取込のプレビューを借りるため後に読み込む必要がある
  assert.ok(
    app.indexOf("include('App_Js_17_UnitMasterAI')") > app.indexOf("include('App_Js_07_PdfImport')"),
    '再構成UIは 07_PdfImport より後'
  );
});

test('単元ピッカーは進捗を使い、失敗時は従来版に戻る', () => {
  const picker = read('App_Js_16_UnitProgress.html');
  assert.match(picker, /getUnitProgressIndexFromWeb/);
  assert.match(picker, /openUnitPickerBasic\(dayIdx, pIdx\)/);
  // 時間目の既定値は「次に指導する時間目」
  assert.match(picker, /openHourPicker\(dayIdx, pIdx, subject, u\.unitName, u\.effectiveTotal, u\.nextHour\)/);

  const plan = read('App_Js_02_Plan.html');
  assert.match(plan, /function openUnitPickerBasic\(/, 'フォールバック用の基本版が残っている');
  assert.doesNotMatch(plan, /function openUnitPicker\(/, '進捗版と名前が衝突しない');
  assert.match(plan, /inputValue: String\(defaultHour\)/);
});

test('新しいUIは単元マスタ変更後にサジェストのキャッシュを捨てる', () => {
  for (const file of ['App_Js_17_UnitMasterAI.html', 'App_Js_18_UnitMasterCheck.html']) {
    assert.match(read(file), /invalidateMasterData/, `${file}`);
  }
  // 単元マスタの変更で進捗キャッシュも捨てる
  assert.match(read('App_Js_14_MultiClass.html'), /STATE\.unitProgress = null/);
});

// ===== レビューで見つかった不具合の回帰テスト =====

test('指導済みの単元は総時数を超える時間目を「次」として返さない', () => {
  const context = loadContext();
  const mk = context.__mkDate;
  const master = [
    ['教科', '単元名', '総時間数', '何時間目'],
    ['国語', '完了', 3, 1], ['国語', '完了', 3, 2], ['国語', '完了', 3, 3],
    ['国語', '超過', 10, 1]
  ];
  const db = [
    ['日付', '1校時', '単元1'],
    [mk(2026, 3, 10), '国語', '完了 1/3'],
    [mk(2026, 3, 11), '国語', '完了 2/3'],
    [mk(2026, 3, 12), '国語', '完了 3/3'],
    [mk(2026, 3, 13), '国語', '超過 12/10']
  ];
  const out = context.buildUnitProgressPayload_(master, db, DB_COLS, mk(2026, 3, 20), mk(9999, 0, 1));
  const units = Object.fromEntries(out.subjects['国語'].units.map((u) => [u.unitName, u]));

  // 3時間の単元を3時間指導した状態で 4/3 を書き込ませない
  assert.equal(units['完了'].status, 'done');
  assert.ok(units['完了'].nextHour <= units['完了'].effectiveTotal,
    `nextHour(${units['完了'].nextHour}) が総時数(${units['完了'].effectiveTotal}) を超えない`);

  // 総時数を超えて指導済みでも、選択肢の上限と一致する
  assert.ok(units['超過'].nextHour <= units['超過'].effectiveTotal);
});

test('単元ピッカーが表示する分母とセルに書く分母が一致する', () => {
  const plan = read('App_Js_02_Plan.html');
  const fn = plan.slice(plan.indexOf('function openHourPicker'), plan.indexOf('// ===== 空き時間'));
  // 選択肢のラベルもセルへの書き込みも maxHour を使う
  assert.match(fn, /options\[h\] = h \+ '\/' \+ maxHour/);
  assert.match(fn, /unitEl\.value = unitName \+ ' ' \+ hourNum \+ '\/' \+ maxHour/);
  assert.doesNotMatch(fn, /hourNum \+ '\/' \+ totalHours/,
    '表示と書き込みで分母が食い違わない');
});

test('スナップショットは200行を超える単元マスタを取りこぼさない', () => {
  const context = loadContext();
  // p3Redact_ が配列を200要素で切り詰める挙動を再現する
  const redact = (v) => (Array.isArray(v) ? v.slice(0, 200).map(redact) : v);
  const rows = Array.from({ length: 900 }, (_, i) => ['国語', 'U' + i, 1, 1, 'act' + i]);

  const paged = context.p4PageRows_(rows);
  const restored = context.p4UnpageRows_({ rowPages: redact(paged) });
  assert.equal(restored.length, 900, '切り詰め後も全行が復元できる');
  assert.equal(restored[899][1], 'U899');

  // 旧形式（rows を直接持つ）スナップショットも読める
  assert.equal(context.p4UnpageRows_({ rows: [['a']] }).length, 1);

  // 保存側がページ形式を使っている
  assert.match(read('15_UnitMasterOps.gs'), /rowPages: p4PageRows_/);
  assert.match(read('13_DataProtection_Snapshots.gs'), /rowPages: p4PageRows_/);
});

test('修復は単元に属さない書きかけの行を消さない', () => {
  const context = loadContext();
  const master = [
    ['教科', '単元名', '総時間数', '何時間目', '活動'],
    ['国語', 'ごんぎつね', 3, 1, 'a'],
    ['国語', 'ごんぎつね', 3, 1, 'b'],
    ['国語', 'ごんぎつね', 3, 3, 'c'],
    ['', '', '', '', ''],
    ['国語', '', 3, 1, '書きかけの行'],
    ['', 'メモ', '', '', 'あとで整理する'],
    ['算数', 'たし算', 1, 1, 'd']
  ];
  const analysis = context.analyzeUnitConsistency_(master, {}, []);
  const built = context.buildRepairedMasterRows_(master, analysis, [{ subject: '国語', unitName: 'ごんぎつね' }]);
  const rows = host(built.rows);

  assert.ok(rows.some((r) => r[4] === '書きかけの行'), '単元名が空の行が残る');
  assert.ok(rows.some((r) => r[4] === 'あとで整理する'), '教科名が空の行が残る');
  assert.ok(rows.some((r) => r[1] === 'たし算'), '対象外の単元が残る');
  // 内容の無い余白行だけは落とす
  assert.ok(!rows.some((r) => r.every((c) => String(c).trim() === '')));
});

test('年間再配分の目標時数が実施済み時数を二重に差し引かない', () => {
  const source = read('16_UnitRecompose.gs');
  const fn = source.slice(source.indexOf('function proposeAnnualReallocation'));
  // 指導済み単元の時数(lockedTotal)を引く。simRow.done を引くと、指導中の単元で
  // 実施した分が currentTotal 側にも含まれるため二重に差し引かれる。
  assert.match(fn, /simRow\.standard - lockedTotal/);
  assert.doesNotMatch(fn, /simRow\.standard - simRow\.done/);
});

test('週案の保存でクライアントの進捗キャッシュも捨てる', () => {
  const multiClass = read('App_Js_14_MultiClass.html');
  const fn = multiClass.slice(
    multiClass.indexOf('function p2UpdateCurrentWeekCache'),
    multiClass.indexOf('function autoSaveAndThen')
  );
  // 全ての保存経路が通る合流点でキャッシュを捨てる
  assert.match(fn, /STATE\.unitProgress = null/);
});

test('単元マスタの復元ポイントは復元でき、週案の復元経路とは分かれている', () => {
  const snapshots = read('13_DataProtection_Snapshots.gs');
  // 週案の復元は書き込み前に種別を弾く
  const weekRestore = snapshots.slice(snapshots.indexOf('function restoreWeekSnapshotFromWeb'));
  assert.match(weekRestore, /snapshot\.type !== 'week'/);
  // 単元マスタ専用の復元経路がある
  assert.match(snapshots, /function restoreUnitMasterSnapshotFromWeb/);
  const unitRestore = snapshots.slice(snapshots.indexOf('function restoreUnitMasterSnapshotFromWeb'));
  assert.match(unitRestore, /snapshot\.type !== 'unitMaster'/);
  assert.match(unitRestore, /p3WithUserLock_/);
  assert.match(unitRestore, /invalidateUnitProgressCache_|p4WriteUnitRows_/);
  // 単元マスタの scope も一覧で読める形にする
  assert.match(snapshots, /raw\.indexOf\('unit::'\) === 0/);
  // 件数上限は種別ごとに数え、単元の復元ポイントが週案のものを追い出さない
  assert.match(snapshots, /件数上限は種別ごとに数える/);

  const ui = read('App_Js_15_DataProtection_Core.html');
  assert.match(ui, /p3RestoreUnitMasterUI/);
  assert.match(ui, /restoreUnitMasterSnapshotFromWeb/);
});

test('新しいUIは単元マスタ行を直接削除しない', () => {
  for (const file of [
    'App_Js_16_UnitProgress.html', 'App_Js_17_UnitMasterAI.html', 'App_Js_18_UnitMasterCheck.html'
  ]) {
    assert.doesNotMatch(read(file), /\.deleteUnitMasterRow\(/, `${file}`);
  }
});

// ===================================================
// ===== 終わった単元を、終わったことにできるか =====
// ===================================================
//
// 実際に困っていたこと:
//  (A) 週案の単元名を少し変えて入力してしまうと、マスタ側の単元がいつまでも
//      「未指導」のまま残り、自動入力が何度もそこへ戻ってきた
//  (B) 5時間の単元を3時間で切り上げても終わりにできず、総時数を手で減らしても
//      行数と週案の分母（n/5）に押し戻されて効かなかった

/** 単元マスタ・週案をその場で組み立てて、進捗インデックスを作る。 */
function payloadFor(context, master, dbRows) {
  const mk = context.__mkDate;
  const db = [['日付', '1校時', '単元1']].concat(dbRows.map(r => [mk(...r[0]), r[1], r[2]]));
  return context.buildUnitProgressPayload_(master, db, DB_COLS, mk(2026, 3, 15), mk(9999, 0, 1));
}

const findUnit = (payload, subject, name) =>
  host(payload.subjects[subject].units).find(u => u.unitName === name);

test('単元名の表記ゆれ（空白・全角半角・記号）は同じ単元として数える', () => {
  const context = loadContext();
  const master = [
    ['教科', '単元名', '総時間数', '何時間目'],
    ['国語', 'ごんぎつね', 3, 1],
    ['国語', 'ごんぎつね', 3, 2],
    ['国語', 'ごんぎつね', 3, 3]
  ];
  const payload = payloadFor(context, master, [
    [[2026, 3, 10], '国語', 'ごんぎつね　1/3'],      // 全角スペース
    [[2026, 3, 11], '国語', '「ごんぎつね」 2/3']     // かぎ括弧つき
  ]);

  const unit = findUnit(payload, '国語', 'ごんぎつね');
  assert.equal(unit.plannedHour, 2, '表記のゆれで別の単元として数えられています');
  assert.equal(unit.nextHour, 3);
  assert.equal(host(payload.subjects.国語.orphans).length, 0,
    'ゆれただけの単元がマスタに無い単元として扱われています');
});

test('本当に別の名前で書いた分は、これまでどおり孤立として拾う', () => {
  const context = loadContext();
  const payload = progressFor(context);
  const orphans = host(payload.subjects.国語.orphans);
  assert.equal(orphans.length, 1);
  // 正規化したキーではなく、週案に書かれていた表記を見せる
  assert.equal(orphans[0].unitName, '幻の単元');
  assert.equal(orphans[0].plannedHour, 1);
});

test('マスタの総時数を減らせば、行が余っていても終わりにできる', () => {
  const context = loadContext();
  // 5時間ぶんの行を残したまま、総時数だけ 3 にした状態（＝「ここまでで終了」の結果）
  const master = [
    ['教科', '単元名', '総時間数', '何時間目'],
    ['国語', 'ごんぎつね', 3, 1],
    ['国語', 'ごんぎつね', 3, 2],
    ['国語', 'ごんぎつね', 3, 3],
    ['国語', 'ごんぎつね', 3, 4],
    ['国語', 'ごんぎつね', 3, 5],
    ['国語', '大造じいさん', 2, 1],
    ['国語', '大造じいさん', 2, 2]
  ];
  // 週案には 1/5, 2/5, 3/5 が残っている（分母は昔のまま）
  const payload = payloadFor(context, master, [
    [[2026, 3, 10], '国語', 'ごんぎつね 1/5'],
    [[2026, 3, 11], '国語', 'ごんぎつね 2/5'],
    [[2026, 3, 12], '国語', 'ごんぎつね 3/5']
  ]);

  const closed = findUnit(payload, '国語', 'ごんぎつね');
  assert.equal(closed.effectiveTotal, 3,
    '週案の分母やマスタの行数に押し戻されています（総時数を正にできていません）');
  assert.equal(closed.status, 'done');
  assert.equal(closed.isNext, false);

  // 次の単元へ進む
  assert.equal(payload.subjects.国語.nextUnitName, '大造じいさん');
  assert.equal(findUnit(payload, '国語', '大造じいさん').nextHour, 1);
});

test('総時数を超えて指導した単元は、これまでどおり実績まで伸ばす', () => {
  const context = loadContext();
  const master = [
    ['教科', '単元名', '総時間数', '何時間目'],
    ['国語', 'ごんぎつね', 3, 1],
    ['国語', 'ごんぎつね', 3, 2],
    ['国語', 'ごんぎつね', 3, 3]
  ];
  const payload = payloadFor(context, master, [
    [[2026, 3, 10], '国語', 'ごんぎつね 4/3'],
    [[2026, 3, 11], '国語', 'ごんぎつね 5/3']
  ]);
  const unit = findUnit(payload, '国語', 'ごんぎつね');
  assert.equal(unit.effectiveTotal, 5);
  assert.equal(unit.status, 'done');
  assert.equal(unit.overTaught, true);
});

test('総時数が未設定なら、行数・週案の分母で補う（従来どおり）', () => {
  const context = loadContext();
  const master = [
    ['教科', '単元名', '総時間数', '何時間目'],
    ['国語', 'てがみ', '', 1],
    ['国語', 'てがみ', '', 2],
    ['国語', 'てがみ', '', 3]
  ];
  const payload = payloadFor(context, master, [[[2026, 3, 10], '国語', 'てがみ 1/3']]);
  const unit = findUnit(payload, '国語', 'てがみ');
  assert.equal(unit.effectiveTotal, 3, '行数で補えていません');
  assert.equal(unit.status, 'inProgress');
  assert.equal(unit.nextHour, 2);
});

test('自動入力は、終了にした単元を飛ばして次の単元へ進む', () => {
  const context = loadContext();
  const mk = context.__mkDate;
  const master = [
    ['教科', '単元名', '総時間数', '何時間目'],
    ['国語', 'ごんぎつね', 3, 1],
    ['国語', 'ごんぎつね', 3, 2],
    ['国語', 'ごんぎつね', 3, 3],
    ['国語', 'ごんぎつね', 3, 4],
    ['国語', 'ごんぎつね', 3, 5],
    ['国語', '大造じいさん', 2, 1],
    ['国語', '大造じいさん', 2, 2]
  ];
  const db = [
    ['日付', '1校時', '単元1'],
    [mk(2026, 3, 10), '国語', 'ごんぎつね 1/5'],
    [mk(2026, 3, 11), '国語', 'ごんぎつね 2/5'],
    [mk(2026, 3, 12), '国語', 'ごんぎつね 3/5']
  ];
  const masterIndex = context.buildMasterIndex_(master);
  const history = context.buildTaughtHistory_(db, DB_COLS, mk(9999, 0, 1));
  const tracker = context.createProgressTracker_(masterIndex, history);

  const next = context.determineNextLessonSmart_('国語', 'ごんぎつね', masterIndex, tracker, []);
  assert.equal(next.unitName, '大造じいさん');
  assert.equal(next.currentHour, 1);
  assert.equal(next.totalHours, 2);
});

test('基準単元の表記がゆれていても、書き戻すのは単元マスタの表記', () => {
  const context = loadContext();
  const mk = context.__mkDate;
  const master = [
    ['教科', '単元名', '総時間数', '何時間目'],
    ['国語', 'ごんぎつね', 3, 1],
    ['国語', 'ごんぎつね', 3, 2],
    ['国語', 'ごんぎつね', 3, 3]
  ];
  const db = [
    ['日付', '1校時', '単元1'],
    [mk(2026, 3, 10), '国語', 'ごん　ぎつね 1/3']
  ];
  const masterIndex = context.buildMasterIndex_(master);
  const tracker = context.createProgressTracker_(
    masterIndex, context.buildTaughtHistory_(db, DB_COLS, mk(9999, 0, 1))
  );

  const next = context.determineNextLessonSmart_('国語', 'ごん　ぎつね', masterIndex, tracker, []);
  assert.equal(next.unitName, 'ごんぎつね', '週案側のゆれた表記が書き戻されています');
  assert.equal(next.currentHour, 2, 'ゆれのせいで1時間目からやり直しになっています');
});

test('短く閉じた単元に「行が足りない」の印を付けない', () => {
  const context = loadContext();
  // 総時数 3・行は5本（＝「ここまでで終了」を押したあとの形）
  const master = [
    ['教科', '単元名', '総時間数', '何時間目'],
    ['国語', '短く閉じた', 3, 1],
    ['国語', '短く閉じた', 3, 2],
    ['国語', '短く閉じた', 3, 3],
    ['国語', '短く閉じた', 3, 4],
    ['国語', '短く閉じた', 3, 5]
  ];
  const closed = findUnit(payloadFor(context, master, []), '国語', '短く閉じた');
  assert.equal(closed.totalMismatch, false);

  // 逆に、総時数のぶんだけ行が無いときは印を付ける
  const short = [
    ['教科', '単元名', '総時間数', '何時間目'],
    ['国語', '行が足りない', 5, 1],
    ['国語', '行が足りない', 5, 2]
  ];
  assert.equal(findUnit(payloadFor(context, short, []), '国語', '行が足りない').totalMismatch, true);
});

// ===== 「指導しない（総時数 0）」の単元 =====
//
// 週案の単元ピッカーから「まとめて終了にする」で未指導の単元を終了にすると、
// 単元マスタの総時数へ 0 が入る。これは「今年はこの単元を指導しない」の印で、
// 空欄（＝まだ決めていない）とは別物として扱う。ここを取り違えると、
// 終了にしたはずの単元へ自動入力が何度でも戻ってくる。

const SKIP_MASTER = [
  ['教科', '単元名', '総時間数', '何時間目'],
  ['国語', 'やらない単元', 0, 1],
  ['国語', 'やらない単元', 0, 2],
  ['国語', 'つぎの単元', 2, 1],
  ['国語', 'つぎの単元', 2, 2],
  // 総時数が空欄。これは「未設定」なので、これまでどおり行数で補う
  ['国語', '総時数なし', '', 1],
  ['国語', '総時数なし', '', 2]
];

test('総時数 0 の単元は、1時間も入っていなくても指導済みとして扱う', () => {
  const context = loadContext();
  const unit = findUnit(payloadFor(context, SKIP_MASTER, []), '国語', 'やらない単元');
  assert.equal(unit.skipped, true);
  assert.equal(unit.status, 'done');
  assert.equal(unit.effectiveTotal, 0, '行数（2）で埋め戻すと、また未消化に戻ります');
  assert.equal(unit.isNext, false);
});

test('総時数が空欄の単元は「指導しない」ではない（これまでどおり行数で補う）', () => {
  const context = loadContext();
  const unit = findUnit(payloadFor(context, SKIP_MASTER, []), '国語', '総時数なし');
  assert.equal(unit.skipped, false);
  assert.equal(unit.status, 'untaught');
  assert.equal(unit.effectiveTotal, 2);
});

test('「次はここから」は、指導しない単元を飛ばして次の単元を指す', () => {
  const context = loadContext();
  const payload = payloadFor(context, SKIP_MASTER, []);
  assert.equal(payload.subjects['国語'].nextUnitName, 'つぎの単元');
});

test('自動入力は、指導しない単元へ戻らない', () => {
  const context = loadContext();
  const masterIndex = context.buildMasterIndex_(SKIP_MASTER);
  const tracker = context.createProgressTracker_(masterIndex, {});
  const next = context.determineNextLessonSmart_('国語', null, masterIndex, tracker, []);
  assert.equal(next.unitName, 'つぎの単元');
  assert.equal(next.currentHour, 1);
});

test('一部の行にだけ 0 が入っている単元は「指導しない」と読まない', () => {
  const context = loadContext();
  // 打ち間違い・書きかけを「指導しない」と取り違えると、単元が黙って消える
  const master = [
    ['教科', '単元名', '総時間数', '何時間目'],
    ['国語', '書きかけ', 0, 1],
    ['国語', '書きかけ', 3, 2],
    ['国語', '書きかけ', 3, 3]
  ];
  const unit = findUnit(payloadFor(context, master, []), '国語', '書きかけ');
  assert.equal(unit.skipped, false);
  assert.equal(unit.effectiveTotal, 3);
  assert.equal(unit.status, 'untaught');
});

test('指導しない単元に週案の記入があれば、直し方を添えて知らせる', () => {
  const context = loadContext();
  const payload = payloadFor(context, SKIP_MASTER, [
    [[2026, 3, 10], '国語', 'やらない単元 1/2']
  ]);
  const warning = host(payload.warnings).find(w => w.includes('やらない単元'));
  assert.ok(warning, '週案に入っているのに何も言わないと、消えたように見えます');
  assert.ok(warning.includes('総時数を戻して'), '直し方が書かれていません');
});

test('指導しない単元は、教科の単元時数計に数えない', () => {
  const context = loadContext();
  const result = analyze(context, [
    ['教科', '単元名', '総時間数', '何時間目', '活動'],
    ['国語', 'やる', 3, 1, 'a'],
    ['国語', 'やる', 3, 2, 'b'],
    ['国語', 'やる', 3, 3, 'c'],
    ['国語', 'やらない', 0, 1, 'd'],
    ['国語', 'やらない', 0, 2, 'e']
  ]);
  const byName = Object.fromEntries(result.units.map((u) => [u.unitName, u]));
  assert.equal(byName['やらない'].skipped, true);
  assert.deepEqual(host(byName['やらない'].issues), [], '0 は不整合ではありません');
  assert.equal(result.subjectTotals[0].unitHoursTotal, 3,
    '行数で数えると年間の合計が実態より膨らみます');
});

test('修復しても「指導しない」の印は消えず、行も消えない', () => {
  const context = loadContext();
  // 何時間目が重複している＝修復の対象。総時数は 0 のまま残さなければならない
  const master = [
    ['教科', '単元名', '総時間数', '何時間目', '活動'],
    ['国語', 'やらない', 0, 1, 'a'],
    ['国語', 'やらない', 0, 1, 'b']
  ];
  const analysis = analyze(context, master);
  assert.equal(analysis.units[0].repairPlan.totalHours, 2, '行は2本のまま');
  assert.equal(analysis.units[0].repairPlan.declaredTotal, 0, '総時数は 0 のまま');

  const built = context.buildRepairedMasterRows_(master, analysis, [
    { subject: '国語', unitName: 'やらない' }
  ]);
  const rows = host(built.rows).filter((r) => r[1] === 'やらない');
  assert.equal(rows.length, 2, '総時数 0 を行数と読むと、単元の行がまるごと消えます');
  assert.deepEqual(rows.map((r) => r[2]), [0, 0]);
  assert.deepEqual(rows.map((r) => r[3]), [1, 2]);
  assert.deepEqual(rows.map((r) => r[4]), ['a', 'b'], '学習活動は失われない');
});

// ===== まとめて終了にする／指導を再開する =====

const CLOSE_MASTER = [
  ['教科', '単元名', '総時間数', '何時間目', '活動'],
  ['国語', '指導中', 5, 1, 'a'],
  ['国語', '指導中', 5, 2, 'b'],
  ['国語', '指導中', 5, 3, 'c'],
  ['国語', '指導中', 5, 4, 'd'],
  ['国語', '指導中', 5, 5, 'e'],
  ['国語', '未指導', 2, 1, 'f'],
  ['国語', '未指導', 2, 2, 'g'],
  ['国語', 'やらない', 0, 1, 'h'],
  ['国語', 'やらない', 0, 2, 'i']
];

const CLOSE_PLANNED = {
  '国語': { units: { '指導中': { displayName: '指導中', maxHour: 3, cellTotalMax: 5, taught: {} } } }
};

const planClosures = (context, names, mode) =>
  context.p4PlanUnitClosures_(CLOSE_MASTER, CLOSE_PLANNED, '国語', names, mode);

test('指導途中の単元は週案に入っている時数で、未指導の単元は0時間で終了になる', () => {
  const context = loadContext();
  const plan = planClosures(context, ['指導中', '未指導']);
  const byName = Object.fromEntries(host(plan.items).map((x) => [x.unitName, x]));

  assert.equal(byName['指導中'].totalHours, 3, '週案は3時間目まで');
  assert.equal(byName['指導中'].previousTotal, 5);
  assert.equal(byName['指導中'].changed, true);
  assert.deepEqual(host(byName['指導中'].rowNumbers), [2, 3, 4, 5, 6], '同じ単元の行すべてを直す');

  assert.equal(byName['未指導'].totalHours, 0, '1時間も入っていない単元は「指導しない」');
  assert.equal(byName['未指導'].changed, true);
  assert.equal(plan.changedCount, 2);
});

test('終了にする時数は、クライアントの言い値ではなく週案から数え直す', () => {
  const context = loadContext();
  // 週案に何も入っていない状態で「指導中」を渡しても、3時間にはならない
  const plan = context.p4PlanUnitClosures_(CLOSE_MASTER, {}, '国語', ['指導中']);
  assert.equal(host(plan.items)[0].totalHours, 0);
});

test('すでにその時数になっている単元は書き換えない', () => {
  const context = loadContext();
  const plan = planClosures(context, ['やらない']);
  assert.equal(host(plan.items)[0].changed, false);
  assert.equal(plan.changedCount, 0);
});

test('同じ単元を2回渡しても1回だけ扱い、マスタに無い単元は理由を返す', () => {
  const context = loadContext();
  const plan = planClosures(context, ['未指導', '未指導', '幻の単元']);
  assert.equal(plan.items.length, 2);
  const missing = host(plan.items).find((x) => x.error);
  assert.ok(missing.error.includes('幻の単元'));
  assert.equal(missing.changed, false);
  assert.equal(plan.changedCount, 1);
});

test('単元名の表記がゆれていても同じ単元として終了にする', () => {
  const context = loadContext();
  const plan = planClosures(context, ['　未 指導 ']);
  assert.equal(host(plan.items)[0].unitName, '未指導', 'マスタの表記を返す');
  assert.equal(host(plan.items)[0].changed, true);
});

test('指導を再開すると、総時数が行数へ戻る', () => {
  const context = loadContext();
  const plan = planClosures(context, ['やらない'], 'reopen');
  const item = host(plan.items)[0];
  assert.equal(item.totalHours, 2);
  assert.equal(item.changed, true);
});

test('「指導しない」になっていない単元は再開の対象にしない', () => {
  const context = loadContext();
  const plan = planClosures(context, ['指導中'], 'reopen');
  const item = host(plan.items)[0];
  assert.equal(item.changed, false);
  assert.ok(item.error.includes('指導しない'));
});

test('まとめて終了にした結果は、件数の分かる知らせにまとまる', () => {
  const context = loadContext();
  const one = context.p4DescribeUnitClosures_(planClosures(context, ['指導中']).items, 'close');
  assert.ok(one.includes('「指導中」'), one);
  assert.ok(one.includes('全3時間'), one);

  const many = context.p4DescribeUnitClosures_(planClosures(context, ['指導中', '未指導']).items, 'close');
  assert.ok(many.includes('2単元'), many);

  const none = context.p4DescribeUnitClosures_(planClosures(context, ['やらない']).items, 'close');
  assert.ok(none.includes('すでに'), none);

  const reopened = context.p4DescribeUnitClosures_(planClosures(context, ['やらない'], 'reopen').items, 'reopen');
  assert.ok(reopened.includes('指導を再開'), reopened);
});
