import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  detectSecretCandidates,
  extractScriptBlocks,
  findIncludeTargets,
  resolveHtmlIncludes,
  runQualityChecks,
  validateManifest
} from '../scripts/lib/project-quality.mjs';

function tempProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schoolplan-quality-'));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, 'utf8');
  }
  return root;
}

function validManifest() {
  return {
    timeZone: 'Asia/Tokyo',
    runtimeVersion: 'V8',
    oauthScopes: ['https://www.googleapis.com/auth/spreadsheets']
  };
}

test('extractScriptBlocks ignores external scripts', () => {
  const html = '<script src="vendor.js"></script><script>const value = 1;</script>';
  assert.deepEqual(extractScriptBlocks(html), ['const value = 1;']);
});

test('findIncludeTargets and resolveHtmlIncludes assemble partials', () => {
  const root = tempProject({
    'App.html': '<main><?!= include("Part"); ?></main>',
    'Part.html': '<script>const ready = true;</script>'
  });
  assert.deepEqual(findIncludeTargets(fs.readFileSync(path.join(root, 'App.html'), 'utf8')), ['Part']);
  assert.match(resolveHtmlIncludes(root, 'App.html'), /const ready = true/);
});

test('validateManifest rejects unsafe structure', () => {
  assert.deepEqual(validateManifest(validManifest()), []);
  const errors = validateManifest({ runtimeVersion: 'DEPRECATED_ES5', timeZone: '', oauthScopes: [] });
  assert.equal(errors.length, 3);
});

test('detectSecretCandidates finds high-confidence credentials', () => {
  const fakeGoogleKey = 'AIza' + 'A'.repeat(35);
  const findings = detectSecretCandidates(`const key = "${fakeGoogleKey}";`);
  assert.equal(findings[0].kind, 'GOOGLE_API_KEY');
});

test('runQualityChecks accepts a minimal valid GAS project', () => {
  const root = tempProject({
    'quality.config.json': JSON.stringify({
      entryHtml: 'App.html',
      requiredFiles: ['appsscript.json', 'App.html'],
      securityExceptions: { wildcardPostMessage: [], xFrameAllowAll: [] }
    }),
    'appsscript.json': JSON.stringify(validManifest()),
    'App.html': '<!doctype html><script>function start() { return true; }</script>',
    'Main.gs': 'function doGet() { return HtmlService.createHtmlOutput("ok"); }'
  });
  const report = runQualityChecks(root);
  assert.deepEqual(report.errors, []);
});

test('runQualityChecks detects missing includes, conflicts, secrets and forbidden scopes', () => {
  const fakeGitHubToken = 'ghp_' + 'a'.repeat(30);
  const root = tempProject({
    'quality.config.json': JSON.stringify({
      entryHtml: 'App.html',
      requiredFiles: ['appsscript.json', 'App.html'],
      manifest: { forbiddenOauthScopes: ['https://www.googleapis.com/auth/drive'] }
    }),
    'appsscript.json': JSON.stringify({
      ...validManifest(),
      oauthScopes: ['https://www.googleapis.com/auth/drive']
    }),
    'App.html': '<?!= include("Missing"); ?><script>const token = "' + fakeGitHubToken + '";</script>',
    'Main.gs': '<<<<<<< HEAD\nfunction broken() {}\n=======\n>>>>>>> branch'
  });
  const codes = new Set(runQualityChecks(root).errors.map(item => item.code));
  assert.ok(codes.has('HTML_INCLUDE_MISSING'));
  assert.ok(codes.has('HTML_ASSEMBLY_FAILED'));
  assert.ok(codes.has('MERGE_CONFLICT_MARKER'));
  assert.ok(codes.has('SECRET_CANDIDATE'));
  assert.ok(codes.has('FORBIDDEN_OAUTH_SCOPE'));
});

test('security exceptions make intentional platform constraints explicit', () => {
  const root = tempProject({
    'quality.config.json': JSON.stringify({
      entryHtml: 'App.html',
      requiredFiles: ['appsscript.json', 'App.html'],
      securityExceptions: {
        wildcardPostMessage: ['App.html'],
        xFrameAllowAll: ['Main.gs']
      }
    }),
    'appsscript.json': JSON.stringify(validManifest()),
    'App.html': '<script>window.parent.postMessage({ ready: true }, "*");</script>',
    'Main.gs': 'function doGet(){ return HtmlService.createHtmlOutput().setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL); }'
  });
  assert.deepEqual(runQualityChecks(root).errors, []);
});
