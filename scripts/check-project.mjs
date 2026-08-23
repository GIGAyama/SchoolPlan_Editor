#!/usr/bin/env node
/*
 * 品質ゲート。
 *
 *   npm run check                               … 検査する
 *   node scripts/check-project.mjs --self-test  … 検査そのものが動くか確かめる
 *   node scripts/check-project.mjs --json       … 機械で読む形で出す
 *
 * ## 構成
 *
 *   scripts/lib/project-quality.mjs … GAS 側の検査（OAuth の権限・postMessage の
 *     宛先・x-frame など）。このリポジトリ固有。
 *   scripts/lib/giga-v5-checks.mjs  … 共通の検査の【正本のコピー】。
 *     GIGAyama.github.io/standards/lib/ からのコピーで、ここでは手を入れない。
 *     直すときは正本を直してから配る（drift ジョブがずれを見張っている）。
 *   scripts/lib/local-checks.mjs    … このリポジトリだけの Part I 検査。
 *     公開ページが2枚（入口 docs/index.html と紹介 docs/about.html）ある作りで、
 *     正本は入口1枚を見るため、紹介ページの検査はこちらに残している。
 *
 * ⚠️ 「0件でした」だけでは、検査が動いているのか何も見ていないのか区別できない。
 *    --self-test は、ファイルを1つずつわざと壊した写しを作り、
 *    対応する検査がちゃんと落ちることを確かめる。
 */
import path from 'node:path';
import process from 'node:process';
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { formatQualityReport, loadQualityConfig, runQualityChecks } from './lib/project-quality.mjs';
import { runGigaChecks } from './lib/giga-v5-checks.mjs';
import { runLocalChecks } from './lib/local-checks.mjs';

const ROOT = path.resolve(process.cwd());

/** 正本とローカルの結果を、このリポジトリの issue の形にそろえる */
function partOneIssues(root) {
  const config = loadQualityConfig(root);
  const canonical = runGigaChecks(root, config.standard || {}).map((r) => ({
    severity: 'error',
    code: r.id,
    // 理由は title の末尾に付く。r.skipped は真偽値なので、そのまま出すと「true」になる
    message: r.skipped ? r.title : ((r.detail || []).join(' / ') || r.title),
    file: null,
    line: null,
    ok: r.ok,
    skipped: !!r.skipped,
  }));
  const local = runLocalChecks(root).map((r) => ({
    severity: r.severity === 'P2' ? 'warning' : 'error',
    code: r.id,
    message: r.detail || r.id,
    file: null,
    line: null,
    ok: r.ok,
    skipped: false,
  }));
  return [...canonical, ...local];
}

/** 落ちたものだけを issue として返す（通ったものは報告に載せない） */
const failedIssues = (root) => partOneIssues(root)
  .filter((i) => !i.ok && !i.skipped)
  .map(({ ok, skipped, ...rest }) => rest);

/*
 * わざと壊す一覧。
 * 「この壊し方をしたら、この検査が落ちるはず」を書いてある。
 * 落ちなければ、その検査は何も見ていない。
 */
const BREAKS = [
  { id: 'B_CSP', file: 'docs/index.html', apply: (s) => s.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';") },
  { id: 'B_NO_INLINE_SCRIPT', file: 'docs/index.html', apply: (s) => s.replace('</body>', '<script>window.x = 1;</script>\n</body>') },
  { id: 'B_NO_CDN_CODE', file: 'docs/index.html', apply: (s) => s.replace('</head>', '  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>\n</head>') },
  { id: 'D_VIEWPORT', file: 'docs/index.html', apply: (s) => s.replace(', viewport-fit=cover', '') },
  { id: 'D_VIEWPORT', file: 'docs/index.html', apply: (s) => s.replace('initial-scale=1.0', 'initial-scale=1.0, user-scalable=no') },
  { id: 'E_INSTALL_HOOK', file: 'docs/index.html', apply: (s) => s.replace('<script src="install-hook.js"></script>', '') },
  { id: 'E3_INSTALL_HOOK_FILE', file: 'docs/install-hook.js', remove: true },
  { id: 'INSTALL_HOOK_INLINE', file: 'docs/index.html', apply: (s) => s.replace('</body>', "<script>addEventListener('beforeinstallprompt', () => {});</script>\n</body>") },
  { id: 'D_REDUCED_MOTION', file: 'docs/index.html', apply: (s) => s.replaceAll('prefers-reduced-motion', 'prefers-REMOVED') },
  { id: 'D_REDUCED_MOTION', file: 'docs/index.html', apply: (s) => s.replace('animation-duration: .01ms !important;', 'animation-duration: 0s !important;') },
  { id: 'D_FLUID_TYPE', file: 'docs/index.html', apply: (s) => s.replace(/clamp\([^)]*\)/g, '18px') },
  { id: 'D_SAFE_AREA', file: 'docs/index.html', apply: (s) => s.replaceAll('safe-area-inset', 'REMOVED-inset') },
  { id: 'D_FORCED_COLORS', file: 'docs/index.html', apply: (s) => s.replaceAll('forced-colors', 'REMOVED-colors') },
  { id: 'D_DVH', file: 'docs/index.html', apply: (s) => s.replace('</style>', '.__selftest { height: 100vh; }\n</style>') },
  { id: 'FIXED_CENTER_SQUEEZE', file: 'docs/index.html', apply: (s) => s.replace('</style>', '.__selftest { position: fixed; left: 50%; transform: translateX(-50%); }\n</style>') },
  { id: 'E_SW_EXISTS', file: 'docs/sw.js', remove: true },
  { id: 'E_SW_CACHE_SCOPE', file: 'docs/sw.js', apply: (s) => s.replace(/\.startsWith\(/, ' !== String(') },
  { id: 'E_SW_NO_LOCALSTORAGE', file: 'docs/sw.js', apply: (s) => `${s}\nself.addEventListener('sync', () => { localStorage.setItem('x', 1); });\n` },
  { id: 'E_SW_VERSION_GENERATED', file: 'docs/sw.js', apply: (s) => s.replace(/const APP_VERSION = '[^']*'; \/\* __APP_VERSION__ \*\//, "const APP_VERSION = 'v4';") },
  { id: 'E_OFFLINE_HTML', file: 'docs/offline.html', remove: true },
  { id: 'E_CNAME', file: 'docs/CNAME', apply: (s) => `${s}\nextra.example.com\n` },
  { id: 'LANDING_MANIFEST', file: 'docs/about.html', apply: (s) => s.replace(/<link\b[^>]*rel\s*=\s*["']manifest["'][^>]*>/i, '') },
  { id: 'LANDING_INSTALL_HOOK', file: 'docs/about.html', apply: (s) => s.replace(/<script[^>]+src=["'][^"']*install-hook\.js["'][^>]*><\/script>/, '') },
  { id: 'LANDING_STANDALONE_META', file: 'docs/about.html', apply: (s) => s.replace('</head>', '<meta name="apple-mobile-web-app-capable" content="yes">\n</head>') },
  { id: 'A_LICENSE', file: 'LICENSE', remove: true },
  { id: 'A_DEPENDABOT', file: '.github/dependabot.yml', remove: true },
  { id: 'A_DOCS', file: 'MANUAL.md', remove: true },
];

function selfTest() {
  console.log('== 品質ゲートの自己確認 ==');
  console.log('ファイルをわざと壊した写しを作り、対応する検査が落ちることを確かめます。\n');

  const base = failedIssues(ROOT);
  if (base.length) {
    console.log('⚠️ もとの状態で落ちている検査があります。先にそちらを直してください。');
    for (const i of base) console.log(`   ❌ ${i.code} ${i.message}`);
    return 1;
  }

  let bad = 0;
  for (const brk of BREAKS) {
    const dir = mkdtempSync(path.join(tmpdir(), 'giga-selftest-'));
    try {
      cpSync(ROOT, dir, { recursive: true, filter: (src) => !/node_modules|\.git$|\.git\/|\.clasp/.test(src) });
      const target = path.join(dir, brk.file);
      if (brk.remove) {
        rmSync(target, { force: true });
      } else {
        const before = readFileSync(target, 'utf8');
        const after = brk.apply(before);
        if (after === before) {
          console.log(`⚠️ ${brk.id.padEnd(28)} 壊し方が当たっていません（対象の文字列が見つからない）`);
          bad++;
          continue;
        }
        writeFileSync(target, after);
      }
      const all = partOneIssues(dir);
      const hit = all.find((i) => i.code === brk.id);
      if (!hit) { console.log(`⚠️ ${brk.id.padEnd(28)} そんな検査がありません`); bad++; }
      else if (hit.ok) { console.log(`❌ ${brk.id.padEnd(28)} 壊したのに落ちませんでした（この検査は何も見ていない）`); bad++; }
      else console.log(`✅ ${brk.id.padEnd(28)} 壊したら落ちた`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(`\n${BREAKS.length - bad} / ${BREAKS.length} 件の検査が、壊したときに落ちることを確認しました。`);
  return bad === 0 ? 0 : 1;
}

if (process.argv.includes('--self-test')) process.exit(selfTest());

let report;
try {
  // GAS 側の検査（このリポジトリ固有）
  report = runQualityChecks(ROOT);

  // Part I の検査（正本のコピー＋このリポジトリだけのもの）
  report.issues = report.issues
    .concat(failedIssues(ROOT))
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
      return `${a.file || ''}:${a.line || 0}:${a.code}`.localeCompare(`${b.file || ''}:${b.line || 0}:${b.code}`);
    });
  report.errors = report.issues.filter((item) => item.severity === 'error');
  report.warnings = report.issues.filter((item) => item.severity === 'warning');
} catch (error) {
  console.error(`Quality checker failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(2);
}

if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else console.log(formatQualityReport(report));

if (report.errors.length > 0) process.exit(1);
