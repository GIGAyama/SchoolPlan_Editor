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
  // マルチテナントで他人のデータを参照しないよう UserCache を使う
  assert.match(source, /CacheService\.getUserCache\(\)/);
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
