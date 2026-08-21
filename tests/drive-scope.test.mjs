import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// drive.file スコープ運用の再発防止（静的検査）。
//
// Apps Script 組み込みの DriveApp は drive.file では動かず、実行時に
// 「指定された権限では DriveApp.xxx を呼び出すことができません。
//   必要な権限: https://www.googleapis.com/auth/drive」
// で失敗する。過去に学級通信の保存・Classroom投稿がこれで壊れていたため、
// DriveApp が再び混入しないことをテストで固定する。

const gsFiles = fs.readdirSync('.')
  .filter(name => name.endsWith('.gs'))
  .sort();

const manifest = JSON.parse(fs.readFileSync('appsscript.json', 'utf8'));

test('Drive 操作に DriveApp を使っていない（drive.file で動かないため）', () => {
  const offenders = [];
  for (const file of gsFiles) {
    // 17_DriveApi.gs は「なぜ DriveApp を使わないか」の説明で名前に触れる
    if (file === '17_DriveApi.gs') continue;
    const source = fs.readFileSync(file, 'utf8');
    source.split('\n').forEach((line, index) => {
      // コメント行での言及は許す（方針の説明のため）
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (/\bDriveApp\s*\./.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    `DriveApp は drive.file では動きません。17_DriveApi.gs のラッパーを使ってください:\n${offenders.join('\n')}`);
});

test('スプレッドシート操作に SpreadsheetApp を使っていない（spreadsheets スコープを要求するため）', () => {
  // SpreadsheetApp は drive.file では動かず、sensitive な spreadsheets スコープを要求する。
  // Google の審査で「drive.file で足りるのでは」と差し戻された経緯があるので、
  // 18_SheetsApi.gs の REST ファサード以外で復活しないよう固定する。
  const offenders = [];
  for (const file of gsFiles) {
    // 18_SheetsApi.gs は「なぜ SpreadsheetApp を使わないか」の説明で名前に触れる
    if (file === '18_SheetsApi.gs') continue;
    const source = fs.readFileSync(file, 'utf8');
    source.split('\n').forEach((line, index) => {
      // コメント行での言及は許す（方針の説明のため）
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (/\bSpreadsheetApp\s*\./.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    `SpreadsheetApp は drive.file では動きません。18_SheetsApi.gs のファサードを使ってください:\n${offenders.join('\n')}`);
});

test('Sheets ラッパーは OAuth トークン付きで REST API v4 を呼ぶ', () => {
  const api = fs.readFileSync('18_SheetsApi.gs', 'utf8');
  assert.match(api, /https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets/);
  assert.match(api, /ScriptApp\.getOAuthToken\(\)/);
  // 2xx 以外を握りつぶすと、権限不足が「成功」に見えてしまう
  assert.match(api, /muteHttpExceptions:\s*true/);
  // 「API がオンになっていない」は権限の問題と紛らわしいので言い換えて投げる
  assert.match(api, /throw new Error\(describeApiDisabledError_\('Google Sheets API'/);
});

test('マニフェストがフル drive スコープを要求していない', () => {
  const scopes = manifest.oauthScopes || [];
  assert.ok(scopes.includes('https://www.googleapis.com/auth/drive.file'),
    'drive.file が要求されていません');
  for (const forbidden of [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/drive.readonly',
    // spreadsheets は sensitive。Sheets REST API v4 は drive.file を受け付けるので要らない。
    'https://www.googleapis.com/auth/spreadsheets'
  ]) {
    assert.ok(!scopes.includes(forbidden), `${forbidden} を要求してはいけません`);
  }
});

test('Drive ラッパーは OAuth トークン付きで REST API v3 を呼ぶ', () => {
  const api = fs.readFileSync('17_DriveApi.gs', 'utf8');
  assert.match(api, /https:\/\/www\.googleapis\.com\/drive\/v3/);
  assert.match(api, /https:\/\/www\.googleapis\.com\/upload\/drive\/v3/);
  assert.match(api, /ScriptApp\.getOAuthToken\(\)/);
  // 2xx 以外を握りつぶすと、権限不足が「成功」に見えてしまう
  assert.match(api, /muteHttpExceptions:\s*true/);
  assert.match(api, /throw new Error\(describeApiDisabledError_\('Google Drive API'/);
});

test('バイナリのアップロードを文字列連結で組み立てていない', () => {
  const api = fs.readFileSync('17_DriveApi.gs', 'utf8');
  const createFile = api.slice(
    api.indexOf('function driveCreateFile_'),
    api.indexOf('function driveCreateConverted_'))
    // 「なぜ multipart を避けるか」の説明はコメントに書いてあるので、コードだけを見る
    .split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  // multipart を文字列で組むと PDF などのバイナリが壊れる。media アップロードを使う
  assert.match(createFile, /uploadType=media/);
  assert.doesNotMatch(createFile, /multipart/);
  assert.match(createFile, /getBytes\(\)/);
});

test('appsscript.json とドキュメントのスコープ一覧が一致している', () => {
  const scopes = (manifest.oauthScopes || [])
    .map(scope => scope.replace('https://www.googleapis.com/auth/', ''));
  for (const page of ['docs/about.html', 'docs/privacy-policy.html']) {
    const html = fs.readFileSync(path.join(page), 'utf8');
    for (const scope of scopes) {
      assert.ok(html.includes(`<code>${scope}</code>`),
        `${page} に ${scope} の説明がありません`);
    }
    // 要求していないスコープを載せたままにしない
    for (const stale of ['script.container.ui', 'drive.readonly', 'spreadsheets']) {
      if (scopes.includes(stale)) continue;
      assert.ok(!html.includes(`<code>${stale}</code>`),
        `${page} に、要求していない ${stale} が残っています`);
    }
  }
});

// --- Drive ファイルを全世界に公開しないこと（docs/LEGAL_RISK_AUDIT_JP.md の A-1）---
//
// 学級通信には児童の氏名や写真が入る。以前は Classroom へ添付するファイルを
// 「リンクを知っている全員が閲覧可（type: 'anyone'）」にしていたため、URLが出回れば
// 誰でも開ける状態だった。しかも共有を解除する導線がアプリに無い。
// 「児童が開けない」と相談されたときに anyone へ戻す修正が入りやすい場所なので、
// 静的検査で塞いでおく。

/** コメント行を落として、コードだけを見る（方針をコメントに書くのは許す）。 */
const codeOnly = (text) => text
  .split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

test('Drive ファイルを「リンクを知っている全員」に公開していない', () => {
  for (const file of gsFiles) {
    const code = codeOnly(fs.readFileSync(file, 'utf8'));
    assert.doesNotMatch(code, /type:\s*['"]anyone['"]/,
      `${file}: 全世界公開の共有が入っています。クラスの参加者へ限定してください。`);
    assert.doesNotMatch(code, /allowFileDiscovery/,
      `${file}: 検索可能な公開共有が入っています。`);
  }
});

test('公開共有のヘルパーがリポジトリに残っていない', () => {
  // 未使用のまま残すと「便利なヘルパー」として再び呼ばれる
  for (const file of gsFiles) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /driveShareAnyoneWithLink_/,
      `${file}: 公開共有のヘルパーが残っています。`);
  }
});

test('共有はクラスの参加者グループに限定し、通知メールを送らない', () => {
  const api = fs.readFileSync('17_DriveApi.gs', 'utf8');
  assert.match(api, /function driveShareReaderWithGroup_/);
  const share = codeOnly(api.slice(api.indexOf('function driveShareReaderWithGroup_')));
  assert.match(share, /type:\s*['"]group['"]/);
  assert.match(share, /role:\s*['"]reader['"]/);
  // コースのグループはメールを受け取る用途のものではない
  assert.match(share, /sendNotificationEmail=false/);
});

test('共有に失敗しても Classroom への投稿は続く', () => {
  // 共有で例外が飛んで投稿ごと落ちると、先生から見れば「投稿できなくなった」に見える。
  const classroom = fs.readFileSync('05_Classroom.gs', 'utf8');
  const helper = classroom.slice(classroom.indexOf('function shareFileWithCourse_'));
  const body = helper.slice(0, helper.indexOf('\nfunction ', 1));

  assert.match(body, /catch\s*\(/, '共有の失敗を捕まえていません');
  assert.doesNotMatch(codeOnly(body), /throw\b/, '共有の失敗で例外を投げています');
  assert.match(body, /Classroom\.Courses\.get/, 'コースのグループを引いていません');
});

test('Classroom へ添付する経路が共有を通っている', () => {
  const attachSites = [
    ['07_WebApp.gs', 'function postNewsletterToClassroomFromWeb']
  ];
  for (const [file, marker] of attachSites) {
    const source = fs.readFileSync(file, 'utf8');
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `${file}: ${marker} が見つかりません`);
    const next = source.indexOf('\nfunction ', start + 1);
    const body = source.slice(start, next === -1 ? source.length : next);
    assert.match(body, /materials:\s*\[\{\s*driveFile/, `${file}: 添付の形が変わっています`);
    assert.match(body, /shareFileWithCourse_\(/,
      `${file}: 添付するファイルの共有を通していません`);
  }
});

test('公開前提のダウンロードURLを組み立てていない', () => {
  for (const file of gsFiles) {
    assert.doesNotMatch(codeOnly(fs.readFileSync(file, 'utf8')), /uc\?export=download/,
      `${file}: 公開ファイル前提のURLを組み立てています。`);
  }
});
