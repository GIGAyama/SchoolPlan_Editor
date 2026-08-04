#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { formatQualityReport, loadQualityConfig, runQualityChecks, walkProjectFiles } from './lib/project-quality.mjs';
import { runGigaV5Checks } from './lib/giga-v5-checks.mjs';

const rootDir = path.resolve(process.cwd());
let report;
try {
  // 共通の品質ゲート（正本。他リポジトリと同じものを丸ごと差し替えで受けられるようにしておく）
  report = runQualityChecks(rootDir);

  // GIGA Standard v5 Part I の検査は分けてある（scripts/lib/giga-v5-checks.mjs）
  const config = loadQualityConfig(rootDir);
  const files = walkProjectFiles(rootDir, config.ignoreDirectories);
  const gigaIssues = runGigaV5Checks(rootDir, files, config.giga || {});

  report.issues = report.issues
    .concat(gigaIssues)
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
      return `${a.file || ''}:${a.line || 0}:${a.code}`.localeCompare(`${b.file || ''}:${b.line || 0}:${b.code}`);
    });
  report.errors = report.issues.filter(item => item.severity === 'error');
  report.warnings = report.issues.filter(item => item.severity === 'warning');
} catch (error) {
  console.error(`Quality checker failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(2);
}

if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else console.log(formatQualityReport(report));

if (report.errors.length > 0) process.exit(1);
