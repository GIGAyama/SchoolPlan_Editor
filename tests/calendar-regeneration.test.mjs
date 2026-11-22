// 年間カレンダーの作り直し（年度更新）が、入力を別の日付へ付け替えないことの確認。
//
// 以前の「カレンダーを再生成する」は、日付・曜日・週番号の列だけを上から書き直し、
// ほかの列は行の位置のまま残していた。起点が変わると、入力は同じ行に残ったまま日付だけが
// 入れ替わる。前年度の入力を消さずに新年度の起点で作り直すと、前年度の授業や宿題が
// そのまま新年度の日付に出て、新年度の時数にも数えられた。確認の画面には
// 「既存の行事や週案データは消えません」としか出ず、控えも作られなかった。
//
// いまは、入力を日付ごとに引き継ぐ。新しい範囲に入らない日の入力は、件数を見せ、
// 完全バックアップを取ってから外す。本物の .gs を通しで動かして確かめる。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWorld, callFunction, createTeacher } from './helpers/gas-runtime.mjs';

const TEACHER = 'teacher-a@example.com';
const MONDAY = '2026/11/16';

function setup() {
  const world = createWorld({ scriptProps: { sp_sharedDeployment: 'true' } });
  world.now = Date.parse('2026-11-18T10:30:00+09:00');
  const teacher = createTeacher(world, TEACHER);
  const call = (name, args) => {
    const res = callFunction(world, TEACHER, name, args);
    assert.equal(res.ok, true, `${name}: ${res.error}`);
    assert.deepEqual(res.leakedLocks, [], `${name} がロックを持ったまま終わっています`);
    return res.value;
  };
  const load = (monday = MONDAY) => call('getWeeklyPlanDataV2', [monday]);
  /** 火曜と水曜に授業・宿題を入れ、火曜の振り返りも書く。 */
  const fill = (sheetName = null) => {
    const week = load();
    assert.equal(week.success, true, week.error);
    week.days[1].periods[0] = { subject: '算数', unit: '小数のかけ算 3/14', content: '筆算のしかたを考える' };
    week.days[1].homework = '計算ドリル';
    week.days[2].periods[0] = { subject: '国語', unit: 'ごんぎつね 5/12', content: '場面を読む' };
    week.days[2].event = '避難訓練';
    const saved = call('saveWeeklyPlanDataProtected', [MONDAY, week.days, week.revision, 'web', sheetName]);
    assert.equal(saved.success, true, saved.error);
    assert.equal(call('saveDailyReflection', ['2026/11/17', '発問を絞った', '完了']).success, true);
  };
  const backups = () => [...world.google.files.values()].filter(f => /バックアップ/.test(f.name) && !f.trashed);
  return { world, teacher, call, load, fill, backups };
}

test('起点を直しても、入力は同じ日付に残る', () => {
  const t = setup();
  t.fill();
  // 作ったときのカレンダーは 3/30 始まり。1週間あとの 4/6 始まりに直す
  const preview = t.call('previewAnnualCalendarFromWeb', ['2026-04-06']);
  assert.equal(preview.success, true, preview.error);
  assert.equal(preview.droppedDays, 0);
  assert.equal(preview.keptDays, 2, '入力のある火曜・水曜を引き継ぐ');
  assert.equal(preview.sheets[0].currentFrom, '2026/03/30');
  assert.equal(preview.sheets[0].newFrom, '2026/04/06');

  const res = t.call('generateAnnualCalendar', [2026, '2026-04-06']);
  assert.equal(res.success, true, res.error);

  const week = t.load();
  assert.equal(week.days[1].date, '2026/11/17');
  assert.deepEqual(week.days[1].periods[0], { subject: '算数', unit: '小数のかけ算 3/14', content: '筆算のしかたを考える' });
  assert.equal(week.days[1].homework, '計算ドリル');
  assert.equal(week.days[1].reflection, '発問を絞った');
  assert.equal(week.days[2].event, '避難訓練');
  // 1週間後の同じ曜日へずれていない
  const next = t.load('2026/11/23');
  assert.equal(next.days[1].periods[0].subject, '');
  assert.equal(next.days[2].event, '');
});

test('年度更新では、確かめるまで何も書かない', () => {
  const t = setup();
  t.fill();
  const before = JSON.stringify(t.teacher.sheet('データベース').grid);

  const res = t.call('generateAnnualCalendar', [2027, '2027-04-05']);
  assert.equal(res.success, false);
  assert.equal(res.needsConfirm, true, '前の年度の入力が外れることを、確かめずに進めている');
  assert.equal(res.droppedDays, 2);
  assert.match(res.error, /2 日ぶん/);
  assert.equal(JSON.stringify(t.teacher.sheet('データベース').grid), before, '確認の前にシートを書き換えている');
  assert.equal(t.backups().length, 0);
});

test('年度更新で、前の年度の入力が新しい年度の日付に付け替わらない', () => {
  const t = setup();
  t.fill();

  const preview = t.call('previewAnnualCalendarFromWeb', ['2027-04-05']);
  assert.equal(preview.droppedDays, 2);
  assert.equal(preview.sheets[0].droppedFrom, '2026/11/17');
  assert.equal(preview.sheets[0].droppedTo, '2026/11/18');
  assert.equal(preview.sheets[0].newFrom, '2027/04/05');

  t.world.now = Date.parse('2027-04-01T09:00:00+09:00');
  const res = t.call('generateAnnualCalendar', [2027, '2027-04-05', { allowDrop: true }]);
  assert.equal(res.success, true, res.error);
  assert.ok(res.backup && res.backup.id, '作り直す前の控えが作られていない');

  // 新しい年度のどの日にも、前の年度の入力は出ない
  const sheet = t.teacher.sheet('データベース');
  const head = sheet.grid[0];
  const leftover = sheet.grid.slice(1).filter(row =>
    ['1校時', '単元1', '学習内容1', '行事', '宿題', '振り返り'].some(name => String(row[head.indexOf(name)] || '') !== ''));
  assert.equal(leftover.length, 0, '前の年度の入力が、新しい年度の行に残っている');

  // 新しい年度の時数に、前の年度の授業が数えられていない
  const hours = t.call('getAnnualHoursData', [2027]);
  assert.equal(hours.success, true, hours.error);
  const counted = Object.values(hours.hoursData || {}).reduce((sum, months) =>
    sum + Object.values(months).reduce((a, b) => a + b, 0), 0);
  assert.equal(counted, 0, '前の年度の授業が、新しい年度の時数に数えられている');

  // 前の年度の記録は、控えのスプレッドシートに残っている
  const backup = t.world.google.spreadsheets.get(res.backup.id);
  const kept = backup.sheets.find(s => s.title === 'データベース').grid;
  assert.ok(kept.some(row => row.includes('小数のかけ算 3/14')), '控えに前の年度の入力が無い');
  assert.ok(kept.some(row => row.includes('発問を絞った')), '控えに振り返りが無い');

  // だれがいつ作り直したかが、監査ログに残る
  const audit = t.call('listAuditLogFromWeb', [20]);
  assert.ok(audit.items.some(item => item.action === 'CALENDAR_REGENERATE'), '監査ログに残っていない');
});

test('年度更新の控えは、ふだんの控えが何度入れ替わっても片づけられない', () => {
  // ふつうの控えは「新しいものから4つまで」。毎日アプリを開くと数日で入れ替わるので、
  // 同じ扱いにすると、前の年度の記録がここにしか無いのに自動で片づけられてしまう。
  const t = setup();
  t.fill();
  t.world.now = Date.parse('2027-04-01T09:00:00+09:00');
  const res = t.call('generateAnnualCalendar', [2027, '2027-04-05', { allowDrop: true }]);
  assert.equal(res.backup.pinned, true);

  // 新年度に入って、毎日アプリを開く（そのたびに日次の控えが作られる）
  for (let day = 0; day < 8; day++) {
    t.world.now = Date.parse('2027-04-06T08:00:00+09:00') + day * 86400000;
    assert.equal(t.call('getDataProtectionStatusFromWeb', [true]).success, true);
  }
  const list = t.call('listBackupsFromWeb').items;
  assert.ok(list.some(item => item.id === res.backup.id && item.pinned), '年度更新の控えが一覧から消えている');
  assert.equal(list.filter(item => !item.pinned).length, 4, 'ふつうの控えは、これまでどおり4つまで');
  assert.equal(t.world.google.files.get(res.backup.id).trashed, false, '年度更新の控えがごみ箱へ移されている');
});

test('入力の無いデータベースは、控えを作らずにすぐ作り直せる', () => {
  const t = setup();
  const res = t.call('generateAnnualCalendar', [2027, '2027-04-05']);
  assert.equal(res.success, true, res.error);
  assert.equal(res.backup, null);
  assert.equal(t.backups().length, 0);
  const week = t.load('2027/04/05');
  assert.deepEqual(week.days.map(day => day.found), [true, true, true, true, true, true, true]);
  assert.equal(week.days[0].date, '2027/04/05');
});

test('日付は正しく並び、週番号は月曜ごとに進む', () => {
  const t = setup();
  t.call('generateAnnualCalendar', [2027, '2027-04-05']);
  const sheet = t.teacher.sheet('データベース');
  const head = sheet.grid[0];
  const rows = sheet.grid.slice(1, 371);
  assert.equal(rows.length, 370);
  const dates = rows.map(row => row[head.indexOf('日付')]);
  assert.ok(dates.every((d, i) => i === 0 || d === dates[i - 1] + 1), '日付が1日ずつ並んでいない');
  assert.deepEqual(rows.slice(0, 8).map(row => row[head.indexOf('曜日')]), ['月', '火', '水', '木', '金', '土', '日', '月']);
  assert.deepEqual(rows.slice(0, 8).map(row => row[head.indexOf('第何週')]), [1, 1, 1, 1, 1, 1, 1, 2]);
});

test('複数学級では、すべての学級のシートを同じカレンダーに作り直せる', () => {
  const t = setup();
  t.fill();
  assert.equal(t.call('setMultiClassEnabledFromWeb', [true]).success, true);
  const added = t.call('addClassFromWeb', ['5年1組', 5]);
  const classSheet = added.classes.find(c => c.name === '5年1組').sheetName;
  assert.equal(t.call('switchActiveClassFromWeb', [classSheet]).success, true);
  t.fill(classSheet);

  const preview = t.call('previewAnnualCalendarFromWeb', ['2027-04-05', { allClasses: true }]);
  assert.equal(preview.multiClass, true);
  assert.deepEqual(preview.sheets.map(s => s.sheetName).sort(), ['データベース', classSheet].sort());
  assert.equal(preview.droppedDays, 4, '2枚のシートに2日ぶんずつ');

  const res = t.call('generateAnnualCalendar', [2027, '2027-04-05', { allowDrop: true, allClasses: true }]);
  assert.equal(res.success, true, res.error);
  for (const name of ['データベース', classSheet]) {
    const sheet = t.teacher.sheet(name);
    const head = sheet.grid[0];
    const first = sheet.grid[1][head.indexOf('日付')];
    const second = sheet.grid[2][head.indexOf('日付')];
    assert.equal(second - first, 1);
    assert.ok(!sheet.grid.some(row => row.includes('小数のかけ算 3/14')), `${name} に前の年度の入力が残っている`);
  }
});

test('作り直しは、週案の保存と同じロックで並ぶ', () => {
  const t = setup();
  t.fill();
  // 同じ先生の別の画面で、保存が進行中
  t.world.locks.user.set(TEACHER, 'my-other-tab');
  const res = t.call('generateAnnualCalendar', [2026, '2026-04-06']);
  assert.equal(res.success, false);
  assert.match(res.error, /進行中/);
});

test('設定タブは、開いた日の年度を入れ、起きることを確かめてから作り直す', () => {
  const html = fs.readFileSync('App.html', 'utf8');
  const input = html.slice(html.indexOf('id="sysCalYear"') - 200, html.indexOf('id="sysCalYear"') + 300);
  assert.doesNotMatch(input, /value="20\d\d"/, '対象年度に、古い年が書いたままになっている');

  const settings = fs.readFileSync('App_Js_10_Settings.html', 'utf8');
  const confirm = settings.slice(settings.indexOf('async function confirmGenerateCalendar()'),
    settings.indexOf('// ===== 使用中のデータベース'));
  const previewAt = confirm.indexOf("'previewAnnualCalendarFromWeb'");
  const generateAt = confirm.indexOf("'generateAnnualCalendar'");
  assert.ok(previewAt > 0 && generateAt > previewAt, '作り直す前に、何が起きるかを確かめていない');
  // 説明のコメントは除き、画面に出る文だけを見る
  const shown = settings.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  assert.doesNotMatch(shown, /既存の行事や週案データは消えません/, '実際と合わない言い切りが残っている');
  assert.match(shown, /週案から外れます/);
});
