#!/usr/bin/env node
/**
 * 【正本】standards/sw/build-sw-static.mjs — 配信物をコミットするアプリ用
 * 各リポジトリへは tools/build-sw.mjs としてコピーする（中身は変えない）。
 * リポジトリ固有の値は sw-build.config.json に置く。
 *
 *   node tools/build-sw.mjs            版を書き換える
 *   node tools/build-sw.mjs --check    書き換えず、ずれていたら落ちる（CI 用）
 *
 * なぜ要るのか:
 *   sw.js の版は手書きの定数だった。app.js や style.css を直しても
 *   キャッシュ名が変わらないので、端末には古い画面が残りつづける。
 *   直したものが端末に届かないと、以降の修正がぜんぶ
 *   「直したはずなのに直っていない」に見える。
 *   版を先読み対象の内容そのものから決めれば、直せば必ず届く。
 *   （2026-08-21、12 リポジトリで同時に上げ忘れる事故が実際に起きた）
 *
 * ついでにもう1つ見る。先読み一覧に並べたファイルが実在するか。
 * cache.addAll は1つでも 404 があると全部失敗する。
 * 綴りを1文字まちがえただけでオフライン対応が丸ごと死ぬので、ここで捕まえる。
 *
 * 前提: sw.js の版の行には、行末に目印コメント __APP_VERSION__ を付ける
 * （正確な形はこのファイル下部の fail メッセージが示す）。
 * 目印があることで「手で上げる値ではない」ことも読み手に伝わる。
 *
 * sw-build.config.json（リポジトリ直下、無ければ既定値）:
 *   {
 *     "swPath": "sw.js",              // 書き換える sw.js の場所
 *     "baseDir": ".",                 // 先読みパス './xxx' の基準ディレクトリ
 *     "versionConst": "APP_VERSION",  // 版の定数名（VERSION / CACHE_VERSION の別名を許す）
 *     "shellConst": "PRECACHE_URLS",  // 先読み一覧の定数名（SHELL / CORE_ASSETS 等）
 *     "neverPrecache": [],            // 一覧に入っていたら落とすファイル（例: 毎週更新のJSON）
 *     "extraHash": []                 // 一覧に無いが版の計算に混ぜたいファイル
 *   }
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  swPath: 'sw.js',
  baseDir: '.',
  versionConst: 'APP_VERSION',
  shellConst: 'PRECACHE_URLS',
  neverPrecache: [],
  extraHash: [],
};

function fail(msg) { console.error('❌ ' + msg); process.exit(1); }
function info(msg) { console.log(msg); }

const config = fs.existsSync('sw-build.config.json')
  ? { ...DEFAULTS, ...JSON.parse(fs.readFileSync('sw-build.config.json', 'utf8')) }
  : DEFAULTS;

const VERSION_LINE = new RegExp(
  `^const ${config.versionConst} = '([^']*)'; /\\* __APP_VERSION__ \\*/$`, 'm');

/** sw.js の先読み一覧を読み、実ファイルのパスに直す。 */
export function shellFilesOf(swSource, baseDir, shellConst) {
  const m = new RegExp(`const ${shellConst}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(swSource);
  if (!m) throw new Error(`sw.js の ${shellConst} 配列を読めませんでした（const ${shellConst} = [...] の形で書いてください）`);

  // コメント内の文字列例を拾わないよう、先にコメントを落とす
  const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  if (body.includes('...')) {
    throw new Error(`${shellConst} にスプレッド（...）があります。ビルド注入型のリポジトリには build-sw-vite.mjs を使ってください`);
  }
  const entries = [...body.matchAll(/['"]([^'"]+)['"]/g)].map((hit) => hit[1]);
  return entries.map((entry) => {
    // './' はディレクトリそのものを指す。実体は index.html。
    const relPath = entry === './' ? './index.html' : entry;
    return { entry, file: path.join(baseDir, relPath.replace(/^\.\//, '')) };
  });
}

/** 先読み対象の中身から版を決める。中身が1バイトでも変われば別の版になる。 */
export function versionOf(files) {
  const hash = crypto.createHash('sha256');
  for (const { entry, file } of files) {
    hash.update(entry);
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return `v${hash.digest('hex').slice(0, 8)}`;
}

function main() {
  const check = process.argv.includes('--check');
  const swPath = config.swPath;
  if (!fs.existsSync(swPath)) fail(`${swPath} がありません`);
  const source = fs.readFileSync(swPath, 'utf8');

  let files;
  try {
    files = shellFilesOf(source, config.baseDir, config.shellConst);
  } catch (error) {
    fail(error.message);
  }

  const missing = files.filter(({ file }) => !fs.existsSync(file));
  if (missing.length > 0) {
    fail(
      `${swPath} の ${config.shellConst} に、存在しないファイルが ${missing.length} 件あります。\n` +
        missing.map(({ entry }) => `  - ${entry}`).join('\n') +
        '\n\ncache.addAll は1つでも欠けると全部失敗します。オフライン対応が丸ごと効かなくなるので、綴りを直してください。'
    );
  }

  for (const banned of config.neverPrecache) {
    if (files.some(({ entry }) => entry.includes(banned))) {
      fail(`${swPath} の ${config.shellConst} に ${banned} が入っています。ここに入れると更新が永久に届かなくなります。`);
    }
  }

  const hashTargets = [
    ...files,
    ...config.extraHash.map((p) => ({ entry: p, file: path.join(config.baseDir, p) })),
  ];
  const missingExtra = hashTargets.filter(({ file }) => !fs.existsSync(file));
  if (missingExtra.length > 0) {
    fail(`extraHash のファイルがありません: ${missingExtra.map((f) => f.entry).join(', ')}`);
  }

  const version = versionOf(hashTargets);
  const current = VERSION_LINE.exec(source);
  if (!current) {
    fail(
      `${swPath} の版の行を読めませんでした。次の形にしてください:\n` +
        `  const ${config.versionConst} = 'v0'; /* __APP_VERSION__ */`
    );
  }

  if (current[1] === version) {
    info(`SW の版は最新です（${version} / 先読み ${files.length} ファイル）`);
    return;
  }

  if (check) {
    fail(
      `${swPath} の ${config.versionConst} が中身と合っていません（いま ${current[1]} / あるべき ${version}）。\n` +
        '`npm run build:sw` を実行してからコミットしてください。\n' +
        'ここがずれたままだと、直した画面が端末に届きません。'
    );
  }

  fs.writeFileSync(
    swPath,
    source.replace(VERSION_LINE, `const ${config.versionConst} = '${version}'; /* __APP_VERSION__ */`),
    'utf8'
  );
  info(`SW の版を更新しました: ${current[1]} → ${version}（先読み ${files.length} ファイル）`);
}

// テストから import されたときは実行しない。
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    fail(error.stack ?? error.message);
  }
}
