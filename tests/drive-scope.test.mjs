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

test('マニフェストがフル drive スコープを要求していない', () => {
  const scopes = manifest.oauthScopes || [];
  assert.ok(scopes.includes('https://www.googleapis.com/auth/drive.file'),
    'drive.file が要求されていません');
  for (const forbidden of [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/drive.readonly'
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
  assert.match(api, /throw new Error\(`Drive API/);
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
    for (const stale of ['script.container.ui', 'drive.readonly']) {
      if (scopes.includes(stale)) continue;
      assert.ok(!html.includes(`<code>${stale}</code>`),
        `${page} に、要求していない ${stale} が残っています`);
    }
  }
});
