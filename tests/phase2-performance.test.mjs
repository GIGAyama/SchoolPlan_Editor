import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  assert.match(source, /getRange\(2, cols\.DATE/);
});

test('client bootstrap uses one critical request and V2 week APIs', async () => {
  const source = await readFile(new URL('../App_Js_14_MultiClass.html', import.meta.url), 'utf8');

  assert.match(source, /\.getAppBootstrapV2\(\)/);
  assert.match(source, /\.getDeferredBootstrapV2\(\)/);
  assert.match(source, /\.getWeeklyPlanDataV2\(mondayStr\)/);
  assert.match(source, /\.saveWeeklyPlanDataV2\(/);
  assert.match(source, /weekRequestSeq/);
});
