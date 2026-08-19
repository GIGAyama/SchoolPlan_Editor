import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Apps Script はプロジェクト内の .gs を順に読み込む。
// トップレベルの const/let の初期化式から「後ろのファイルの const」を参照すると、
// 読み込み時点ではまだ定義されておらず ReferenceError になる。しかも失敗するのは
// アプリ全体なので、画面は「開けない」だけになり原因が分かりにくい。
//
// 実際に
//   const DB_CLEARABLE_INPUT_KEYS_ = ['TIME'].concat(P2_WEEK_READ_KEYS_);
// （02_Database.gs が 12_Performance.gs の定数を参照）で
// 「P2_WEEK_READ_KEYS_ is not defined」が起き、アプリが開けなくなった。
//
// 関数の中で参照するぶんには、呼ばれる時点で全ファイルが読み込み済みなので安全。

const GS_FILES = fs.readdirSync('.').filter(name => name.endsWith('.gs')).sort();

/** そのファイルのトップレベルで定義されている const/let/var の名前 */
function topLevelNames(source) {
  const names = [];
  for (const line of source.split('\n')) {
    const match = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

test('トップレベルの定数が、後ろのファイルの定数を参照していない', () => {
  // 名前 → 定義しているファイル
  const definedIn = new Map();
  const sources = new Map();
  for (const file of GS_FILES) {
    const source = fs.readFileSync(file, 'utf8');
    sources.set(file, source);
    for (const name of topLevelNames(source)) {
      if (!definedIn.has(name)) definedIn.set(name, file);
    }
  }

  const offenders = [];
  GS_FILES.forEach((file, fileIndex) => {
    sources.get(file).split('\n').forEach((line, lineIndex) => {
      const match = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.*)$/.exec(line);
      if (!match) return;
      const [, declared, expression] = match;
      for (const [name, source] of definedIn) {
        if (source === file || name === declared) continue;
        if (!new RegExp(`\\b${name}\\b`).test(expression)) continue;
        // 自分より後ろのファイルで定義されているものだけが危ない
        if (GS_FILES.indexOf(source) > fileIndex) {
          offenders.push(`${file}:${lineIndex + 1}: ${declared} が ${name}（${source}）を読み込み時に参照しています`);
        }
      }
    });
  });

  assert.deepEqual(offenders, [],
    '読み込み順に依存しています。定数ではなく関数にして、呼ばれた時点で解決してください:\n'
    + offenders.join('\n'));
});

test('配置チェックは、すべての .gs ファイルを見ている', () => {
  // 1ファイルでも欠けたり古かったりすると動かなくなるので、確認漏れを作らない。
  const check = fs.readFileSync('99_Utils.gs', 'utf8');
  const named = new Set([...check.matchAll(/outdated\.push\('([^']+)'\)/g)].map(m => m[1]));
  const missing = GS_FILES.filter(file => !named.has(file));
  assert.deepEqual(missing, [],
    `配置チェック（checkDeploymentIntegrity_）が見ていない .gs があります:\n${missing.join('\n')}`);
});
