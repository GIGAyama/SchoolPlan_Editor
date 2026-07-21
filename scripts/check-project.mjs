#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { formatQualityReport, runQualityChecks } from './lib/project-quality.mjs';

const rootDir = path.resolve(process.cwd());
let report;
try {
  report = runQualityChecks(rootDir);
} catch (error) {
  console.error(`Quality checker failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(2);
}

if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else console.log(formatQualityReport(report));

if (report.errors.length > 0) process.exit(1);
