// 1つのURLを何人もの先生が使う形（共有デプロイ）で、Classroom 連携が
// ほかの先生の情報を拾わないことの確認。
//
// 以前は、クラスID を ScriptCache（スクリプト全体で1つ）に「クラス名」だけを鍵にして
// 入れていた。どの学校にもある「4年2組」のような名前では、あとから投稿した先生に
// 先に投稿した先生のクラスIDが返り、投稿は「権限がありません」で失敗していた。
// 毎日の自動投稿は時間主導トリガーで走るので、失敗しても先生の画面には何も出ない。
//
// 本物の .gs を通しで動かして確かめる（tests/helpers/gas-runtime.mjs）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWorld, callFunction, createTeacher, fireTrigger } from './helpers/gas-runtime.mjs';

const TUESDAY_AFTERNOON = Date.parse('2026-11-17T15:30:00+09:00');

/** 先生を1人つくり、今週の火・水に授業を入れておく（「あしたの予定」を投稿できる状態）。 */
function teacherWithLessons(world, email, courses, courseName) {
  const teacher = createTeacher(world, email);
  const week = callFunction(world, email, 'getWeeklyPlanDataV2', ['2026/11/16']).value;
  assert.equal(week.success, true, week.error);
  [1, 2].forEach(day => {
    week.days[day].periods[0] = { subject: '国語', unit: 'ごんぎつね', content: '場面を読む' };
    week.days[day].homework = '音読';
  });
  const saved = callFunction(world, email, 'saveWeeklyPlanDataProtected',
    ['2026/11/16', week.days, week.revision, 'web', null]).value;
  assert.equal(saved.success, true, saved.error);
  world.courses.set(email, courses);
  if (courseName) world.userProps.get(email).sp_courseName = courseName;
  return teacher;
}

function sharedWorld() {
  const world = createWorld({ scriptProps: { sp_sharedDeployment: 'true' } });
  world.now = TUESDAY_AFTERNOON;
  return world;
}

test('同じ名前のクラスを持つ2人の先生が、それぞれ自分のクラスへ投稿できる', () => {
  const world = sharedWorld();
  const a = teacherWithLessons(world, 'a@school-a.example', [{ id: 'COURSE-OF-A', name: '4年2組' }], '4年2組');
  const b = teacherWithLessons(world, 'b@school-b.example', [{ id: 'COURSE-OF-B', name: '4年2組' }], '4年2組');

  const first = callFunction(world, a.email, 'postScheduleToClassroomFromWeb', ['']).value;
  assert.equal(first.success, true, first.message);
  const second = callFunction(world, b.email, 'postScheduleToClassroomFromWeb', ['']).value;
  assert.equal(second.success, true, second.message);

  assert.deepEqual(world.announcements.map(x => `${x.by}→${x.courseId}`),
    ['a@school-a.example→COURSE-OF-A', 'b@school-b.example→COURSE-OF-B']);
});

test('同じ名前の有効なクラスが2つあるときは、新しく作られたほうへ投稿する', () => {
  const world = sharedWorld();
  const teacher = teacherWithLessons(world, 'a@school-a.example', [
    { id: 'LAST-YEAR', name: '4年2組', creationTime: '2025-04-03T01:00:00Z' },
    { id: 'THIS-YEAR', name: '4年2組', creationTime: '2026-04-02T01:00:00Z' },
    { id: 'OTHER', name: '4年1組', creationTime: '2026-04-05T01:00:00Z' },
  ], '4年2組');
  const res = callFunction(world, teacher.email, 'postScheduleToClassroomFromWeb', ['']).value;
  assert.equal(res.success, true, res.message);
  assert.equal(world.announcements[0].courseId, 'THIS-YEAR');
});

test('自動投稿ができなかったことは、次にアプリを開いたときに分かる', () => {
  const world = sharedWorld();
  // クラス名は設定してあるが、そのクラスが Classroom に無い（アーカイブした等）
  const teacher = teacherWithLessons(world, 'a@school-a.example', [], '4年2組');
  const trigger = { email: teacher.email, handler: 'postScheduleToClassroom', id: 'trg-1' };

  fireTrigger(world, trigger);
  assert.equal(world.announcements.length, 0);

  const boot = callFunction(world, teacher.email, 'getDeferredBootstrapV2').value;
  assert.ok(boot.autoPost && boot.autoPost.failure, '起動時の応答に「できなかった」が入っていない');
  assert.equal(boot.autoPost.failure.acknowledged, false);
  assert.match(boot.autoPost.failure.message, /4年2組/);
  assert.equal(callFunction(world, teacher.email, 'getAppSettings').value.autoPost.failure.ok, false,
    '設定タブでも同じ内容を見られる');

  // 見送り（登校日でない）では、「できなかった」の知らせを消さない。
  // 金曜の失敗が土日の見送りで上書きされると、月曜に開いた先生には伝わらない。
  world.now = Date.parse('2026-11-21T16:00:00+09:00'); // 土曜
  fireTrigger(world, trigger);
  let status = callFunction(world, teacher.email, 'getDeferredBootstrapV2').value.autoPost;
  assert.ok(status.failure, '見送りで知らせが消えている');
  assert.equal(status.lastRun.posted, false);

  // 先生が確認したら、起動時の知らせは出さない（設定タブには残る）
  assert.equal(callFunction(world, teacher.email, 'acknowledgeAutoPostFailureFromWeb').value.success, true);
  status = callFunction(world, teacher.email, 'getDeferredBootstrapV2').value.autoPost;
  assert.equal(status.failure.acknowledged, true);

  // 次に投稿できたら、知らせは片づく
  world.now = TUESDAY_AFTERNOON;
  world.courses.set(teacher.email, [{ id: 'COURSE-OF-A', name: '4年2組' }]);
  fireTrigger(world, trigger);
  assert.equal(world.announcements.length, 1);
  status = callFunction(world, teacher.email, 'getDeferredBootstrapV2').value.autoPost;
  assert.equal(status.failure, null);
  assert.equal(status.lastRun.posted, true);
});

test('自動投稿の結果は、ほかの先生には見えない', () => {
  const world = sharedWorld();
  const a = teacherWithLessons(world, 'a@school-a.example', [], '4年2組');
  const b = teacherWithLessons(world, 'b@school-b.example', [{ id: 'COURSE-OF-B', name: '4年2組' }], '4年2組');
  fireTrigger(world, { email: a.email, handler: 'postScheduleToClassroom', id: 'trg-a' });
  assert.ok(callFunction(world, a.email, 'getDeferredBootstrapV2').value.autoPost.failure);
  assert.equal(callFunction(world, b.email, 'getDeferredBootstrapV2').value.autoPost.failure, null);
});

test('Gemini のモデル一覧は、自分の API キーで取ったものが返る', () => {
  const world = sharedWorld();
  const a = createTeacher(world, 'a@school-a.example');
  const b = createTeacher(world, 'b@school-b.example');
  world.userProps.get(a.email).sp_geminiApiKey = 'KEY-OF-A';
  world.userProps.get(b.email).sp_geminiApiKey = 'KEY-OF-B';
  world.google.geminiModels = key => [{
    name: 'models/for-' + key, displayName: key, supportedGenerationMethods: ['generateContent']
  }];

  const first = callFunction(world, a.email, 'getAvailableGeminiModels').value;
  const second = callFunction(world, b.email, 'getAvailableGeminiModels').value;
  assert.deepEqual(first.models.map(m => m.name), ['for-KEY-OF-A']);
  assert.deepEqual(second.models.map(m => m.name), ['for-KEY-OF-B'],
    'ほかの先生のキーで取った一覧が返っている');

  // 同じ先生の2回目は、覚えていた一覧を使う（問い合わせを増やさない）
  const before = world.google.geminiCalls.length;
  callFunction(world, a.email, 'getAvailableGeminiModels');
  assert.equal(world.google.geminiCalls.length, before);
});

test('どの .gs も、スクリプト全体のキャッシュに値を置かない', () => {
  // ScriptCache はスクリプト全体で1つ。共有デプロイでは全員に見える。
  // 旧版のキャッシュを片づける remove / removeAll だけは残してよい。
  for (const file of fs.readdirSync('.').filter(f => f.endsWith('.gs'))) {
    const source = fs.readFileSync(file, 'utf8');
    const uses = [...source.matchAll(/getScriptCache\(\)(\s*\.\s*(\w+))?/g)];
    for (const use of uses) {
      assert.ok(use[2] === 'remove' || use[2] === 'removeAll',
        `${file}: スクリプト全体のキャッシュを使っています（getScriptCache()${use[1] || ''}）。` +
        '利用者ごとのキャッシュ（tCacheGet_ / tCachePut_）を使ってください');
    }
  }
});
