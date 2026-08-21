#!/usr/bin/env node
/**
 * リポジトリの内容を Apps Script プロジェクトへ反映し、Webアプリを更新します。
 *
 * これまでは GAS エディタへ手でコピーしていました。ファイルは53個あり、
 * 1つ貼り忘れただけで「〇〇 is not defined」になります。ここを自動にします。
 *
 * 使い方:
 *   node scripts/gas-deploy.mjs login    手元のGoogleアカウントで1度だけログインする
 *   node scripts/gas-deploy.mjs status   送るファイルを一覧する（送らない）
 *   node scripts/gas-deploy.mjs backup   いまのGASプロジェクトの中身を控える
 *   node scripts/gas-deploy.mjs push     GASプロジェクトへ反映する
 *   node scripts/gas-deploy.mjs deploy   反映したうえで、既存のデプロイを新版へ更新する
 *
 * 必要な環境変数:
 *   GAS_SCRIPT_ID       スクリプトID（GASエディタのURLに入っている）
 *   GAS_DEPLOYMENT_ID   deploy のときだけ必要。更新するデプロイのID
 *   CLASPRC_JSON        任意。省略すると手元の ~/.clasprc.json を使う
 *
 * 詳しい手順は docs/D5_AUTO_DEPLOY.md にあります。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const rootDir = path.resolve(process.cwd());
const BACKUP_DIR = path.join(rootDir, 'dist', 'gas-before-push');

/** 使い方を示して終わります。 */
function usage(message) {
  console.error(message);
  console.error('');
  console.error('使い方: node scripts/gas-deploy.mjs <status|backup|push|deploy>');
  console.error('詳しくは docs/D5_AUTO_DEPLOY.md を参照してください。');
  process.exit(2);
}

/**
 * clasp の実体（JSファイル）を探します。見つからなければ入れ方を案内します。
 *
 * `require.resolve('@google/clasp/package.json')` は使えません。clasp の
 * `exports` が package.json を公開していないためです。node_modules を上へ辿ります。
 */
function resolveClaspEntry() {
  let dir = rootDir;
  for (;;) {
    const manifestPath = path.join(dir, 'node_modules', '@google', 'clasp', 'package.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.clasp;
      return path.join(path.dirname(manifestPath), bin);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  console.error('clasp が入っていません。次を実行してください:');
  console.error('  npm run gas:install');
  process.exit(2);
}

/**
 * clasp を動かします。
 * シェルを挟まないので、Windowsの `.cmd` やクォートの違いに悩まされません。
 */
function clasp(args, { projectFile, authFile }) {
  const full = [];
  if (projectFile) full.push('--project', projectFile);
  if (authFile) full.push('--auth', authFile);
  full.push(...args);

  const entry = resolveClaspEntry();
  console.log('$ clasp ' + full.join(' '));
  const result = spawnSync(process.execPath, [entry, ...full], {
    stdio: 'inherit',
    cwd: rootDir
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`clasp ${args[0]} が失敗しました（終了コード ${result.status}）。`);
    process.exit(result.status || 1);
  }
}

/**
 * `.clasp.json` を書きます。スクリプトIDが入るためリポジトリには置かず（.gitignore）、
 * 実行のたびに環境変数から作り直します。
 * @param {string} dir 置き場所
 * @param {string} scriptId
 * @param {string} [targetDir] 読み書きの対象。省略するとファイルと同じ場所
 * @returns {string} 書いたファイルのパス
 */
function writeProjectFile(dir, scriptId, targetDir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.clasp.json');
  const project = { scriptId, rootDir: targetDir || '.' };
  fs.writeFileSync(file, JSON.stringify(project, null, 2) + '\n');
  return file;
}

/**
 * 認証情報を用意します。
 * CLASPRC_JSON があれば一時ファイルへ書き、無ければ手元の既定（~/.clasprc.json）に任せます。
 * @returns {?string} 認証ファイルのパス（既定に任せるときは null）
 */
function prepareAuthFile() {
  const raw = process.env.CLASPRC_JSON;
  if (!raw || !raw.trim()) return null;
  try {
    JSON.parse(raw);
  } catch (e) {
    usage('CLASPRC_JSON がJSONとして読めません。clasp login で作られた .clasprc.json の中身を、そのまま入れてください。');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clasp-auth-'));
  const file = path.join(dir, '.clasprc.json');
  // 他の利用者から読めない権限で置く（CIの共有ランナーでも同じ）
  fs.writeFileSync(file, raw, { mode: 0o600 });
  return file;
}

/** 環境変数を1つ読みます。空なら止めます。 */
function requireEnv(name, why) {
  const value = (process.env[name] || '').trim();
  if (!value) usage(`環境変数 ${name} が空です（${why}）。`);
  return value;
}

/**
 * いまGASにある中身を、送る前に控えます。
 *
 * `clasp push` は**GAS側を丸ごと上書き**します。GASエディタで直接直した箇所があると、
 * それは消えます。取り返しがつかないので、送る前に必ず控えを取ります。
 * 控えはリポジトリの外（dist/、.gitignore 済み）へ置きます。
 */
function backup(scriptId, authFile) {
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  // 設定ファイルは控えの外へ置く。控えはそのままCIの成果物として持ち出すので、
  // スクリプトIDを混ぜない。
  const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clasp-backup-'));
  const projectFile = writeProjectFile(settingsDir, scriptId, BACKUP_DIR);
  clasp(['pull'], { projectFile, authFile });
  console.log(`いまのGASプロジェクトを ${path.relative(rootDir, BACKUP_DIR)} に控えました。`);
}

const command = process.argv[2];
if (!command || !['login', 'status', 'backup', 'push', 'deploy'].includes(command)) {
  usage(command ? `知らない指示です: ${command}` : '何をするか指定してください。');
}

// ログインだけは、スクリプトIDも認証ファイルも要らない。
// 手元の既定の置き場所（~/.clasprc.json）へ書かせる。その中身を、あとで
// GitHub の CLASPRC_JSON に登録する（docs/D5_AUTO_DEPLOY.md）。
if (command === 'login') {
  clasp(['login'], {});
  process.exit(0);
}

const scriptId = requireEnv('GAS_SCRIPT_ID', 'GASエディタのURLに入っているスクリプトID');
const authFile = prepareAuthFile();
const projectFile = writeProjectFile(rootDir, scriptId);

if (command === 'status') {
  clasp(['status'], { projectFile, authFile });
} else if (command === 'backup') {
  backup(scriptId, authFile);
} else if (command === 'push') {
  backup(scriptId, authFile);
  clasp(['push', '--force'], { projectFile, authFile });
} else {
  const deploymentId = requireEnv('GAS_DEPLOYMENT_ID',
    'Apps Scriptの「デプロイを管理」に出ているデプロイID。既存のURLを保つために要ります');
  backup(scriptId, authFile);
  clasp(['push', '--force'], { projectFile, authFile });
  // 既存のデプロイを新しいバージョンへ差し替える。新規に作ると **URLが変わり**、
  // 先生が開いているブックマークやPWAが古いままになる。
  const label = (process.env.GAS_DEPLOY_DESCRIPTION || '').trim() || 'auto deploy';
  clasp(['deploy', '--deploymentId', deploymentId, '--description', label], { projectFile, authFile });
  console.log('Webアプリを新しいバージョンへ更新しました（URLは変わりません）。');
}
