// Pull Request の CI が、`npm run quality` と同じ検査を走らせていることの確認。
//
// 手元の入口は `npm run quality`、CI の入口は .github/workflows/quality.yml で、
// 中身は別々に書かれている（CI は検査の結果を成果物として残すため、1つずつ走らせる）。
// 別々に書かれているものは、片方にだけ足されてずれる。実際に
// `node tools/build-sw.mjs --check` は quality にだけあり、CI には無かった。
// その間、docs/ を直して SW の版を刻み忘れた PR は緑のまま通り、main でしか
// 走らない deploy.yml で初めて赤くなっていた（README は「CI が捕まえる」と書いていた）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const workflow = fs.readFileSync('.github/workflows/quality.yml', 'utf8');

/** コメント行を落とす（説明文に書いたコマンドを「走らせている」と数えないため）。 */
const steps = workflow.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');

/** `npm run quality` を、&& で区切った1つずつの検査に分ける。 */
const qualityParts = pkg.scripts.quality.split('&&').map(part => part.trim()).filter(Boolean);

test('npm run quality は、生成物の検査・静的検査・テストを含んでいる', () => {
  assert.ok(qualityParts.includes('node tools/build-sw.mjs --check'), 'SW の版の検査が外れています');
  assert.ok(qualityParts.includes('node tools/build-app-links.mjs --check'), 'リンクの写しの検査が外れています');
  assert.ok(qualityParts.includes('npm run check'));
  assert.ok(qualityParts.includes('npm test'));
});

test('Pull Request の CI は、npm run quality の検査を1つも落としていない', () => {
  for (const part of qualityParts) {
    if (part === 'npm run check') {
      // CI は結果を JSON で残すため、同じ入口を --json つきで直接呼んでいる
      assert.match(steps, /node scripts\/check-project\.mjs/, 'CI が静的検査を走らせていません');
      assert.equal(pkg.scripts.check, 'node scripts/check-project.mjs',
        'npm run check の中身が変わっています。CI 側（quality.yml）も合わせてください');
      continue;
    }
    assert.ok(steps.includes(part),
      `quality.yml が「${part}」を走らせていません。` +
      'npm run quality に足した検査は、CI にも足してください');
  }
});

test('CI は Pull Request でも走る（main に入ってからでは遅い）', () => {
  assert.match(steps, /^on:\s*\n(?:.*\n)*?\s+pull_request:/m);
});
