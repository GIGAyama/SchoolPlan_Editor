import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function loadConfigContext() {
  const source = await readFile(new URL('../00_config.gs', import.meta.url), 'utf8');
  const context = vm.createContext({ console });
  vm.runInContext(source, context, { filename: '00_config.gs' });
  return context;
}

test('legacy shuffled database headers map to their physical columns', async () => {
  const context = await loadConfigContext();
  const headers = [
    '日付', '曜日', '宿題', '1校時', '学習内容1', '単元名1',
    '行事', '朝学習', '持ち物', '放課後', '第何週'
  ];
  const columns = context.buildDbColumnMapFromHeaders_(headers, 'データベース');

  assert.equal(columns.DATE, 1);
  assert.equal(columns.HOMEWORK, 3);
  assert.equal(columns.PERIOD1, 4);
  assert.equal(columns.CONTENT1, 5);
  assert.equal(columns.UNIT1, 6);
  assert.equal(columns.EVENT, 7);
  assert.equal(columns.ITEMS, 9);
  assert.equal(columns.WEEK_NUM, 11);
});

test('full-width numbers and legacy hour labels are normalized', async () => {
  const context = await loadConfigContext();
  const headers = ['日付', '１時間目', '単元名１', '学習内容１', '内容５'];
  const columns = context.buildDbColumnMapFromHeaders_(headers, '旧週案');

  assert.equal(columns.PERIOD1, 2);
  assert.equal(columns.UNIT1, 3);
  assert.equal(columns.CONTENT1, 4);
  assert.equal(columns.CONTENT5, 5);
});

test('database column mapping no longer reads a script-wide shared cache', async () => {
  const source = await readFile(new URL('../00_config.gs', import.meta.url), 'utf8');
  const getColumnsBody = source.match(/function getDbColumns\(\)[\s\S]*?\n}/)?.[0] || '';

  assert.match(getColumnsBody, /scanDbHeaderForSheet_/);
  assert.doesNotMatch(getColumnsBody, /getScriptCache\(\)\.get/);
  assert.doesNotMatch(getColumnsBody, /dbSheet\.getName\(\).*cache/i);
});

test('weekly V2 transport reads targeted rows instead of the full database range', async () => {
  const source = await readFile(new URL('../12_Performance.gs', import.meta.url), 'utf8');

  assert.match(source, /function getWeeklyPlanDataV2/);
  assert.match(source, /function saveWeeklyPlanDataV2/);
  assert.match(source, /p2ReadRowsForDates_/);
  assert.doesNotMatch(source, /getDataRange\(\)/);
  // 日付列は「2行目から末尾まで」を狙って読む（シート全体ではなく）
  assert.match(source, /getValuesToEnd\(2, cols\.DATE/);
});

test('client bootstrap uses one critical request and V2 week APIs', async () => {
  const source = await readFile(new URL('../App_Js_14_MultiClass.html', import.meta.url), 'utf8');

  assert.match(source, /\.getAppBootstrapV2\(\)/);
  assert.match(source, /\.getDeferredBootstrapV2\(\)/);
  assert.match(source, /\.getWeeklyPlanDataV2\(mondayStr\)/);
  assert.match(source, /\.saveWeeklyPlanDataV2\(/);
  assert.match(source, /weekRequestSeq/);
});

test('サーバを呼ぶ週案の経路は、すべて所要時間を記録する', async () => {
  // 二度やらかした落とし穴。
  //   1度目: App_Js_15_DataProtection_Overrides.html が window.saveWeeklyPlan などを
  //          丸ごと差し替えるため、元の関数だけに計測を入れても何も出なかった。
  //   2度目: 検査を2ファイルに絞っていたため、App_Js_02_Plan.html の保存経路を見落とした。
  //          しかも「件数が合っていればよい」判定だったので、別の場所で数が合うと通ってしまった。
  //
  // そこで、フロントエンド全ファイルを対象に、**google.script.run の連鎖1本ずつ**を見る。
  const files = (await readdir(new URL('../', import.meta.url)))
    .filter(name => /^App_Js_.*\.html$/.test(name));
  assert.ok(files.length > 0, 'フロントエンドのファイルが見つからない');

  const WEEK_APIS = /\.(saveWeeklyPlanDataProtected|saveWeeklyPlanDataV2|getWeeklyPlanDataV2|getAppBootstrapV2)\(/;
  const missing = [];

  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    // google.script.run で分ける。分けたひと切れが「1回の呼び出しの連鎖」にあたる。
    source.split('google.script.run').slice(1).forEach((chain, index) => {
      if (!WEEK_APIS.test(chain)) return;
      if (chain.indexOf('p2LogTiming(') >= 0) return;
      missing.push(`${file} の ${index + 1} 本目`);
    });
  }

  assert.deepEqual(missing, [],
    '所要時間を記録していないサーバ呼び出しがある: ' + missing.join(' / '));
});

test('計測は往復回数と待ち時間まで返す', async () => {
  // 「往復が重いのか、GAS 側の固定費が重いのか」を切り分けるために要る。
  const facade = await readFile(new URL('../18_SheetsApi.gs', import.meta.url), 'utf8');
  assert.match(facade, /function sheetsFetchStats_/);
  assert.match(facade, /SHEETS_FETCH_COUNT_\+\+/);

  const performance = await readFile(new URL('../12_Performance.gs', import.meta.url), 'utf8');
  // 読み込み・保存・起動のいずれもが内訳を返すこと
  assert.equal((performance.match(/sheetsFetchStats_\(\)/g) || []).length, 3);
});
