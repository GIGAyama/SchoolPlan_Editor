// GASへの反映を自動でやるための検査。
//
// これまでは GAS エディタへ53ファイルを手でコピーしていた。1つ貼り忘れると
// 「〇〇 is not defined」になるだけで、どれが足りないかは分からない。
//
// 自動にするとき、こわいのは次の3つ。ここで固定する。
//   (1) 壊れたものをそのまま反映してしまう（品質ゲートを通す前に触らない）
//   (2) 新しいデプロイを作ってしまい **URLが変わる**（先生のブックマークとPWAが古いまま残る）
//   (3) GASエディタで直接直した箇所を、控えも取らずに上書きしてしまう
//   (4) マニフェストを上書きして、**ウェブアプリでなくなる**

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = process.cwd();
const SCRIPT = path.join(REPO, 'scripts', 'gas-deploy.mjs');
const WORKFLOW = fs.readFileSync('.github/workflows/deploy.yml', 'utf8');

/**
 * 本物の clasp の代わりに「呼ばれた指示を書き残すだけ」のものを置いた作業場所を作る。
 * @returns {{dir: string, calls: function(): Array<string>}}
 */
function createWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-deploy-'));
  const claspDir = path.join(dir, 'node_modules', '@google', 'clasp');
  fs.mkdirSync(claspDir, { recursive: true });
  fs.writeFileSync(path.join(claspDir, 'package.json'),
    JSON.stringify({ name: '@google/clasp', bin: { clasp: 'fake.cjs' } }));
  fs.writeFileSync(path.join(claspDir, 'fake.cjs'),
    'require("fs").appendFileSync(process.env.FAKE_CLASP_LOG, process.argv.slice(2).join(" ") + "\\n");\n');
  const logFile = path.join(dir, 'calls.log');
  fs.writeFileSync(logFile, '');
  return {
    dir,
    logFile,
    calls: () => fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
  };
}

/** 作業場所で gas-deploy.mjs を動かす。 */
function run(workspace, command, env) {
  return spawnSync(process.execPath, [SCRIPT, command], {
    cwd: workspace.dir,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      FAKE_CLASP_LOG: workspace.logFile,
      GAS_SCRIPT_ID: 'script-id-for-test',
      CLASPRC_JSON: ''
    }, env || {})
  });
}

test('反映の前に、いまのGASの中身を控える', () => {
  // clasp push は GAS 側を丸ごと上書きする。GASエディタで直接直した箇所は消える。
  // 取り返しがつかないので、送る前に必ず控えを取る。
  const workspace = createWorkspace();
  const result = run(workspace, 'push');

  assert.equal(result.status, 0, result.stderr);
  const calls = workspace.calls();
  const pullAt = calls.findIndex(line => line.includes(' pull'));
  const pushAt = calls.findIndex(line => line.includes(' push'));
  assert.ok(pullAt >= 0, `控え（pull）を取っていない: ${calls.join(' / ')}`);
  assert.ok(pushAt > pullAt, `控えを取る前に送っている: ${calls.join(' / ')}`);
});

test('控えの中に、スクリプトIDを混ぜない', () => {
  // 控えはCIの成果物としてそのまま持ち出す。設定ファイルが混ざると、
  // リポジトリに置かないと決めたスクリプトIDが一緒に出ていく。
  const workspace = createWorkspace();
  run(workspace, 'backup');

  const stray = path.join(workspace.dir, 'dist', 'gas-before-push', '.clasp.json');
  assert.equal(fs.existsSync(stray), false, '控えの中に .clasp.json が入っている');
});

test('既存のデプロイを差し替える（新しく作らない）', () => {
  // 新規に作るとURLが変わる。先生のブックマークとPWAは古いURLを指したままになり、
  // 「更新したのに直っていない」が起きる。
  const workspace = createWorkspace();
  const result = run(workspace, 'deploy', { GAS_DEPLOYMENT_ID: 'deployment-id-for-test' });

  assert.equal(result.status, 0, result.stderr);
  const deployCall = workspace.calls().find(line => line.includes(' deploy'));
  assert.ok(deployCall, '反映のあとにデプロイしていない');
  assert.match(deployCall, /--deploymentId deployment-id-for-test/,
    'デプロイIDを指定していない（新しいデプロイができ、URLが変わる）');
});

test('デプロイIDが無ければ、何もせずに止まる', () => {
  const workspace = createWorkspace();
  const result = run(workspace, 'deploy', { GAS_DEPLOYMENT_ID: '' });

  assert.notEqual(result.status, 0, 'デプロイIDが無いのに進んでいる');
  assert.deepEqual(workspace.calls(), [], '止まる前にGASを触っている');
  assert.match(result.stderr, /GAS_DEPLOYMENT_ID/);
});

test('スクリプトIDが無ければ、何もせずに止まる', () => {
  const workspace = createWorkspace();
  const result = run(workspace, 'push', { GAS_SCRIPT_ID: '' });

  assert.notEqual(result.status, 0);
  assert.deepEqual(workspace.calls(), [], '止まる前にGASを触っている');
});

test('品質ゲートを通してから、はじめてGASを触る', () => {
  const qualityAt = WORKFLOW.indexOf('npm run quality');
  const deployAt = WORKFLOW.indexOf('gas-deploy.mjs deploy');
  assert.ok(qualityAt >= 0, 'デプロイの手順に品質ゲートが無い');
  assert.ok(deployAt > qualityAt, '品質ゲートより先にGASを触っている');

  const scripts = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts;
  assert.match(scripts.deploy, /npm run quality &&/,
    'npm run deploy が品質ゲートを通っていない');
});

test('反映は直列にする', () => {
  // 2つ同時に走ると、あとから始まったほうが古いコードで上書きしうる。
  assert.match(WORKFLOW, /concurrency:[\s\S]{0,200}cancel-in-progress:\s*false/,
    '同時実行の制御が無い、または走っているものを途中で切っている');
});

test('送るのはGASプロジェクトの中身だけ', () => {
  // テスト・ドキュメント・node_modules を送ると、容量も反映時間も無駄に増える。
  // 「まず全部を除外してから、必要なものだけ戻す」形を崩さない。
  const lines = fs.readFileSync('.claspignore', 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  assert.equal(lines[0], '**/**', '先頭で全部を除外していない');
  const allowed = lines.slice(1);
  assert.ok(allowed.length > 0, '何も送らない設定になっている');
  for (const line of allowed) {
    assert.ok(line.startsWith('!'), `除外を戻す行ではないものがある: ${line}`);
    assert.ok(!line.includes('/'),
      `リポジトリ直下より深いものを送ろうとしている: ${line}`);
  }
  for (const name of ['appsscript.json', '*.gs', '*.html']) {
    assert.ok(allowed.includes('!' + name), `${name} を送る設定が無い`);
  }
});

test('スクリプトIDはリポジトリに置かない', () => {
  const ignored = fs.readFileSync('.gitignore', 'utf8').split('\n').map(l => l.trim());
  assert.ok(ignored.includes('.clasp.json'), '.clasp.json が追跡対象になっている');
  assert.ok(ignored.includes('.clasprc.json'), '.clasprc.json が追跡対象になっている');
  assert.equal(fs.existsSync('.clasp.json') && !ignored.includes('.clasp.json'), false);
});

test('マニフェストが、ウェブアプリとしての入り口を宣言している', () => {
  // Apps Script は「このデプロイがウェブアプリか、ライブラリか」を appsscript.json で決める。
  // clasp push はGAS側のマニフェストを丸ごと上書きするので、ここに webapp が無いと
  // **デプロイからウェブアプリの入り口が消える**。実際に一度そうなった。
  // エディタから手でデプロイしていたころは、エディタがこれを書いてくれていた。
  const manifest = JSON.parse(fs.readFileSync('appsscript.json', 'utf8'));

  assert.ok(manifest.webapp,
    'appsscript.json に webapp がない（反映するとウェブアプリでなくなる）');

  // 「自分（オーナー）として実行」にすると、全員がオーナーの権限で動き、
  // UserProperties もオーナーのものになる。結果、**全員が同じ1つのデータベースを共有**し、
  // 他学級の児童に関する記述が相互に見える（docs/LEGAL_RISK_AUDIT_JP.md の C-2）。
  assert.equal(manifest.webapp.executeAs, 'USER_ACCESSING',
    'アクセスしているユーザーとして実行する設定になっていない');

  // ANYONE_ANONYMOUS はログイン不要になる。このアプリは Session.getActiveUser() で
  // 利用者を見分け、その人のDriveのデータを扱うため、ログインが要る。
  assert.ok(['ANYONE', 'DOMAIN'].includes(manifest.webapp.access),
    `アクセス範囲が想定外: ${manifest.webapp.access}（ANYONE か DOMAIN のこと）`);
});
