// 週案に打った文字が、スプレッドシートに解釈し直されずに、打ったとおりに残ることの確認。
//
// Sheets API の valueInputOption=USER_ENTERED は、文字列を「画面で打ったのと同じ規則」で
// 解釈し直す（公式の説明どおり）。以前は週案の書き込みもすべてこれだったため、
// 先生が行事の欄に `9:00` とだけ打つと時刻（0.375）に、`10/15` や `4-2` は日付の
// シリアル値に、`+αのプリント` は数式のエラーに変わって保存されていた。
// 保存の応答で画面もその値にそろうので、先生には「打ったものが別の数字に化けた」と見える。
//
// 本物の .gs を通しで動かす（tests/helpers/gas-runtime.mjs）。Google 側の読み替えは
// tests/helpers/fake-google.mjs が近似している。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, callFunction, createTeacher, serialFromYmd } from './helpers/gas-runtime.mjs';

const TEACHER = 'teacher-a@example.com';
const MONDAY = '2026/11/16';

function setup() {
  const world = createWorld({ scriptProps: { sp_sharedDeployment: 'true' } });
  world.now = Date.parse('2026-11-18T10:30:00+09:00');
  const teacher = createTeacher(world, TEACHER);
  const call = (name, args) => {
    const res = callFunction(world, TEACHER, name, args);
    assert.equal(res.ok, true, `${name}: ${res.error}`);
    return res.value;
  };
  const load = (monday = MONDAY) => {
    const week = call('getWeeklyPlanDataV2', [monday]);
    assert.equal(week.success, true, week.error);
    return week;
  };
  const save = (week, monday = MONDAY) => {
    const saved = call('saveWeeklyPlanDataProtected', [monday, week.days, week.revision, 'web', null]);
    assert.equal(saved.success, true, saved.error);
    return saved;
  };
  /** そのシートの、指定した日付の行を返す（見出しの名前で列を引く）。 */
  const rowOf = (sheetName, y, m, d) => {
    const sheet = teacher.sheet(sheetName);
    const head = sheet.grid[0];
    const row = sheet.grid.find(r => r[head.indexOf('日付')] === serialFromYmd(y, m, d));
    assert.ok(row, `${sheetName} に ${y}/${m}/${d} の行がありません`);
    return name => row[head.indexOf(name)];
  };
  return { world, teacher, call, load, save, rowOf };
}

/** 先生が打ちそうで、スプレッドシートが別のものに読み替える値。 */
const AMBIGUOUS = {
  event: '9:00', preclass: '10/15', morning: '007', recess1: '50%', recess2: 'TRUE',
  afterschool: '0', homework: '=1+2', items: '+αのプリント',
};
const AMBIGUOUS_CELLS = ['4-2', '2026/11/30', '1/3', '12,000', '1E3', "'かぎで始まる"];

test('紛らわしい値も、打ったとおりに保存され、画面にもそのまま戻る', () => {
  const t = setup();
  const week = t.load();
  Object.assign(week.days[2], AMBIGUOUS);
  AMBIGUOUS_CELLS.forEach((text, i) => {
    week.days[2].periods[i] = { subject: '国語', unit: text, content: text };
  });

  const saved = t.save(week);
  const again = t.load();
  for (const source of [saved.days[2], again.days[2]]) {
    for (const [field, typed] of Object.entries(AMBIGUOUS)) {
      assert.equal(source[field], typed, `${field} に打った「${typed}」が変わっている`);
    }
    AMBIGUOUS_CELLS.forEach((text, i) => {
      assert.equal(source.periods[i].unit, text, `単元に打った「${text}」が変わっている`);
      assert.equal(source.periods[i].content, text, `学習内容に打った「${text}」が変わっている`);
    });
  }

  // シートの中身も、数や日付ではなく文字のまま
  const cell = t.rowOf('データベース', 2026, 11, 18);
  assert.equal(cell('行事'), '9:00');
  assert.equal(cell('登校前'), '10/15');
  assert.equal(cell('宿題'), '=1+2');
  assert.equal(cell('放課後'), '0');
  assert.equal(cell('単元1'), '4-2');
});

test('保存し直しても「変更なし」になる（読み替えで毎回ずれない）', () => {
  const t = setup();
  const week = t.load();
  week.days[2].items = '20';
  week.days[2].homework = '007';
  t.save(week);

  const again = t.load();
  const second = t.save(again);
  assert.equal(second.updatedCount, 0, '何も変えていないのに、変更として書いている');
});

test('週案のシートだけを打ったとおりに書き、数や日付を持つシートはこれまでどおり', () => {
  const t = setup();
  const week = t.load();
  week.days[2].event = '9:00';
  const mark = t.world.google.log.length;
  t.save(week);
  const writes = t.world.google.log.slice(mark).filter(entry => entry.method === 'put' && /データベース/.test(entry.url));
  assert.ok(writes.length > 0, '週案のシートへの書き込みが見つからない');
  for (const entry of writes) assert.match(entry.url, /valueInputOption=RAW/, entry.url);

  // 単元マスタは「何時間目」「総時数」が数。画面から文字で届いても、数として入る
  const inserted = t.call('insertUnitMasterRow', [1,
    { subject: '国語', unitName: 'ごんぎつね', totalHours: '8', hourNum: '3', activity: '場面を読む' }]);
  assert.equal(inserted.success, true, inserted.error);
  const master = t.teacher.sheet('単元マスタ').grid[1];
  assert.equal(master[2], 8);
  assert.equal(master[3], 3);
});

test('学級ごとのシートでも、打ったとおりに残る', () => {
  const t = setup();
  assert.equal(t.call('setMultiClassEnabledFromWeb', [true]).success, true);
  const added = t.call('addClassFromWeb', ['5年1組', 5]);
  assert.equal(added.success, true, added.error);
  const sheetName = added.classes.find(c => c.name === '5年1組').sheetName;
  assert.equal(t.call('switchActiveClassFromWeb', [sheetName]).success, true);

  const week = t.load();
  week.days[2].event = '9:00';
  week.days[2].periods[0] = { subject: '音楽', unit: '4-2', content: '10/15' };
  const saved = t.call('saveWeeklyPlanDataProtected', [MONDAY, week.days, week.revision, 'web', sheetName]);
  assert.equal(saved.success, true, saved.error);

  const again = t.load();
  assert.equal(again.days[2].event, '9:00');
  assert.deepEqual(again.days[2].periods[0], { subject: '音楽', unit: '4-2', content: '10/15' });
  assert.equal(t.rowOf(sheetName, 2026, 11, 18)('行事'), '9:00');
});

test('保存のほかの入口（振り返り）から書いた文字も、解釈されない', () => {
  const t = setup();
  const week = t.load();
  week.days[1].periods[0] = { subject: '国語', unit: 'ごんぎつね', content: '場面を読む' };
  t.save(week);

  const text = '+ 発問を絞ったら話し合いが深まった';
  const res = t.call('saveDailyReflection', ['2026/11/17', text, '完了']);
  assert.equal(res.success, true, res.error);
  assert.equal(t.rowOf('データベース', 2026, 11, 17)('振り返り'), text);
  assert.equal(t.load().days[1].reflection, text);
});

test('カレンダーを作り直しても、日付は日付のまま（週を開ける）', () => {
  const t = setup();
  const res = t.call('generateAnnualCalendar', [2026, '2026-04-06']);
  assert.equal(res.success, true, res.error);
  const date = t.rowOf('データベース', 2026, 11, 18)('日付');
  assert.equal(typeof date, 'number', '日付の列が文字になっている（週の行を引けなくなる）');
  const week = t.load();
  assert.deepEqual(week.days.map(day => day.found), [true, true, true, true, true, true, true]);
});

test('前から数や真偽値として入っているセルも、空欄にせず文字で見せる', () => {
  // 以前の書き込み（USER_ENTERED）や、スプレッドシートを直接さわって入った値。
  // 以前は String(value || '') だったので、0 と FALSE が画面で空欄になっていた。
  const t = setup();
  const sheet = t.teacher.sheet('データベース');
  const head = sheet.grid[0];
  const row = sheet.grid.find(r => r[head.indexOf('日付')] === serialFromYmd(2026, 11, 18));
  row[head.indexOf('行事')] = 0;
  row[head.indexOf('朝学習')] = false;
  row[head.indexOf('宿題')] = true;
  row[head.indexOf('持ち物')] = 20;

  const day = t.load().days[2];
  assert.equal(day.event, '0');
  assert.equal(day.morning, 'FALSE');
  assert.equal(day.homework, 'TRUE');
  assert.equal(day.items, '20');
});
