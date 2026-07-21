import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const TEXT_EXTENSIONS = new Set([
  '.css', '.gs', '.html', '.js', '.json', '.md', '.mjs', '.yml', '.yaml'
]);
const CODE_EXTENSIONS = new Set(['.gs', '.html', '.js', '.json', '.mjs', '.yml', '.yaml']);
const RUNTIME_SCRIPT_EXTENSIONS = new Set(['.gs', '.html', '.js']);

export const DEFAULT_CONFIG = Object.freeze({
  entryHtml: 'App.html',
  requiredFiles: ['appsscript.json', 'App.html'],
  ignoreDirectories: ['.git', '.clasp', 'node_modules', 'coverage', 'dist'],
  manifest: { forbiddenOauthScopes: [] },
  securityExceptions: { wildcardPostMessage: [], xFrameAllowAll: [] },
  maintainability: { warningLineCount: 5000, warningByteCount: 400000 }
});

function normalizeRelative(filePath) {
  return filePath.split(path.sep).join('/');
}

function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    manifest: { ...base.manifest, ...(override.manifest || {}) },
    securityExceptions: {
      ...base.securityExceptions,
      ...(override.securityExceptions || {})
    },
    maintainability: {
      ...base.maintainability,
      ...(override.maintainability || {})
    }
  };
}

export function loadQualityConfig(rootDir) {
  const configPath = path.join(rootDir, 'quality.config.json');
  if (!fs.existsSync(configPath)) return structuredClone(DEFAULT_CONFIG);
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return mergeConfig(DEFAULT_CONFIG, parsed);
}

export function walkProjectFiles(rootDir, ignoredDirectories = []) {
  const ignored = new Set(ignoredDirectories);
  const results = [];

  function visit(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.isDirectory() && ignored.has(entry.name)) continue;
      const absolute = path.join(currentDir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else results.push(normalizeRelative(path.relative(rootDir, absolute)));
    }
  }

  visit(rootDir);
  return results.sort();
}

export function extractScriptBlocks(html) {
  const scripts = [];
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = scriptPattern.exec(html)) !== null) {
    const attributes = match[1] || '';
    if (/\bsrc\s*=/.test(attributes)) continue;
    scripts.push(match[2]);
  }
  return scripts;
}

export function findIncludeTargets(source) {
  const targets = [];
  const includePattern = /<\?(?:!=|=)?\s*include\(\s*['"]([^'"]+)['"]\s*\)\s*;?\s*\?>/g;
  let match;
  while ((match = includePattern.exec(source)) !== null) targets.push(match[1]);
  return targets;
}

function includePath(rootDir, target) {
  return path.join(rootDir, target.endsWith('.html') ? target : `${target}.html`);
}

export function resolveHtmlIncludes(rootDir, entryRelativePath, stack = []) {
  const normalizedEntry = normalizeRelative(entryRelativePath);
  if (stack.includes(normalizedEntry)) {
    throw new Error(`HTML include cycle: ${[...stack, normalizedEntry].join(' -> ')}`);
  }

  const absolute = path.join(rootDir, normalizedEntry);
  if (!fs.existsSync(absolute)) throw new Error(`Missing include file: ${normalizedEntry}`);
  const source = fs.readFileSync(absolute, 'utf8');
  const includePattern = /<\?(?:!=|=)?\s*include\(\s*['"]([^'"]+)['"]\s*\)\s*;?\s*\?>/g;

  return source.replace(includePattern, (_full, target) => {
    const targetAbsolute = includePath(rootDir, target);
    const targetRelative = normalizeRelative(path.relative(rootDir, targetAbsolute));
    return resolveHtmlIncludes(rootDir, targetRelative, [...stack, normalizedEntry]);
  });
}

function sanitizeAppsScriptTemplate(source) {
  return source.replace(/<\?[\s\S]*?\?>/g, 'null');
}

function syntaxError(source, filename) {
  try {
    new vm.Script(sanitizeAppsScriptTemplate(source), { filename });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['appsscript.json must contain a JSON object.'];
  }
  if (manifest.runtimeVersion !== 'V8') errors.push('runtimeVersion must be "V8".');
  if (typeof manifest.timeZone !== 'string' || manifest.timeZone.trim() === '') {
    errors.push('timeZone must be a non-empty string.');
  }
  if (!Array.isArray(manifest.oauthScopes) || manifest.oauthScopes.length === 0) {
    errors.push('oauthScopes must be a non-empty array.');
  } else {
    const duplicates = manifest.oauthScopes.filter((scope, index, scopes) => scopes.indexOf(scope) !== index);
    if (duplicates.length > 0) errors.push(`oauthScopes contains duplicates: ${[...new Set(duplicates)].join(', ')}`);
    for (const scope of manifest.oauthScopes) {
      if (typeof scope !== 'string' || !scope.startsWith('https://www.googleapis.com/auth/')) {
        errors.push(`Invalid OAuth scope: ${String(scope)}`);
      }
    }
  }
  return errors;
}

export function detectSecretCandidates(source) {
  const patterns = [
    ['GOOGLE_API_KEY', /AIza[0-9A-Za-z_-]{35}/g],
    ['GITHUB_TOKEN', /(?:ghp|github_pat)_[0-9A-Za-z_]{20,}/g],
    ['OPENAI_API_KEY', /sk-[0-9A-Za-z_-]{32,}/g],
    ['PRIVATE_KEY', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g]
  ];
  const findings = [];
  for (const [kind, pattern] of patterns) {
    for (const match of source.matchAll(pattern)) findings.push({ kind, index: match.index ?? 0 });
  }
  return findings;
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function issue(severity, code, message, file = null, line = null) {
  return { severity, code, message, file, line };
}

export function runQualityChecks(rootDir, suppliedConfig = null) {
  const config = suppliedConfig ? mergeConfig(DEFAULT_CONFIG, suppliedConfig) : loadQualityConfig(rootDir);
  const files = walkProjectFiles(rootDir, config.ignoreDirectories);
  const issues = [];
  const fileSet = new Set(files);

  for (const required of config.requiredFiles) {
    if (!fileSet.has(normalizeRelative(required))) {
      issues.push(issue('error', 'REQUIRED_FILE_MISSING', `Required file is missing: ${required}`, required));
    }
  }

  const textFiles = files.filter(file => TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()));
  const htmlFiles = files.filter(file => path.extname(file).toLowerCase() === '.html');
  const gsFiles = files.filter(file => path.extname(file).toLowerCase() === '.gs');

  for (const file of textFiles) {
    const absolute = path.join(rootDir, file);
    const source = fs.readFileSync(absolute, 'utf8');

    const conflictPattern = /^(<<<<<<<|=======|>>>>>>>)(?:\s|$)/gm;
    for (const match of source.matchAll(conflictPattern)) {
      issues.push(issue('error', 'MERGE_CONFLICT_MARKER', 'Unresolved merge conflict marker.', file, lineNumberAt(source, match.index ?? 0)));
    }

    if (CODE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      for (const finding of detectSecretCandidates(source)) {
        issues.push(issue('error', 'SECRET_CANDIDATE', `Possible committed secret (${finding.kind}).`, file, lineNumberAt(source, finding.index)));
      }
    }

    const lineCount = source.split('\n').length;
    const byteCount = Buffer.byteLength(source, 'utf8');
    if (lineCount > config.maintainability.warningLineCount) {
      issues.push(issue('warning', 'LARGE_FILE_LINES', `${lineCount} lines exceeds the maintainability warning threshold.`, file));
    }
    if (byteCount > config.maintainability.warningByteCount) {
      issues.push(issue('warning', 'LARGE_FILE_BYTES', `${byteCount} bytes exceeds the maintainability warning threshold.`, file));
    }
  }

  for (const file of htmlFiles) {
    const source = fs.readFileSync(path.join(rootDir, file), 'utf8');
    for (const target of findIncludeTargets(source)) {
      const targetFile = normalizeRelative(path.relative(rootDir, includePath(rootDir, target)));
      if (!fileSet.has(targetFile)) {
        issues.push(issue('error', 'HTML_INCLUDE_MISSING', `include('${target}') does not resolve to ${targetFile}.`, file));
      }
    }
    extractScriptBlocks(source).forEach((script, index) => {
      const error = syntaxError(script, `${file}#script-${index + 1}`);
      if (error) issues.push(issue('error', 'HTML_SCRIPT_SYNTAX', error, file));
    });
  }

  const gsSources = [];
  for (const file of gsFiles) {
    const source = fs.readFileSync(path.join(rootDir, file), 'utf8');
    gsSources.push(`\n// ===== ${file} =====\n${source}`);
    const error = syntaxError(source, file);
    if (error) issues.push(issue('error', 'GAS_SYNTAX', error, file));
  }
  if (gsSources.length > 0) {
    const combinedError = syntaxError(gsSources.join('\n'), 'all-gas-files.gs');
    if (combinedError) issues.push(issue('error', 'GAS_GLOBAL_SYNTAX', combinedError));
  }

  const entryPath = normalizeRelative(config.entryHtml);
  if (fileSet.has(entryPath)) {
    try {
      const rendered = resolveHtmlIncludes(rootDir, entryPath);
      const combinedScripts = extractScriptBlocks(rendered).join('\n;\n');
      const error = syntaxError(combinedScripts, `${entryPath}#assembled`);
      if (error) issues.push(issue('error', 'ASSEMBLED_APP_SYNTAX', error, entryPath));
    } catch (error) {
      issues.push(issue('error', 'HTML_ASSEMBLY_FAILED', error instanceof Error ? error.message : String(error), entryPath));
    }
  }

  const manifestPath = path.join(rootDir, 'appsscript.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      for (const message of validateManifest(manifest)) {
        issues.push(issue('error', 'MANIFEST_INVALID', message, 'appsscript.json'));
      }
      const forbidden = new Set(config.manifest.forbiddenOauthScopes || []);
      for (const scope of manifest.oauthScopes || []) {
        if (forbidden.has(scope)) {
          issues.push(issue('error', 'FORBIDDEN_OAUTH_SCOPE', `Broad OAuth scope is forbidden by quality.config.json: ${scope}`, 'appsscript.json'));
        }
      }
    } catch (error) {
      issues.push(issue('error', 'MANIFEST_JSON', error instanceof Error ? error.message : String(error), 'appsscript.json'));
    }
  }

  const wildcardAllowed = new Set((config.securityExceptions.wildcardPostMessage || []).map(normalizeRelative));
  const allowAllAllowed = new Set((config.securityExceptions.xFrameAllowAll || []).map(normalizeRelative));
  for (const file of textFiles.filter(file => RUNTIME_SCRIPT_EXTENSIONS.has(path.extname(file).toLowerCase()))) {
    const source = fs.readFileSync(path.join(rootDir, file), 'utf8');
    if (/\.postMessage\s*\([\s\S]{0,400}?,\s*['"]\*['"]\s*\)/m.test(source) && !wildcardAllowed.has(file)) {
      issues.push(issue('error', 'WILDCARD_POSTMESSAGE', 'Wildcard postMessage target must be explicitly allowlisted.', file));
    }
    if (/XFrameOptionsMode\.ALLOWALL/.test(source) && !allowAllAllowed.has(file)) {
      issues.push(issue('error', 'XFRAME_ALLOWALL', 'XFrameOptionsMode.ALLOWALL must be explicitly allowlisted.', file));
    }
  }

  issues.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    return `${a.file || ''}:${a.line || 0}:${a.code}`.localeCompare(`${b.file || ''}:${b.line || 0}:${b.code}`);
  });

  return {
    rootDir,
    checkedFiles: files.length,
    errors: issues.filter(item => item.severity === 'error'),
    warnings: issues.filter(item => item.severity === 'warning'),
    issues
  };
}

export function formatQualityReport(report) {
  const lines = [];
  for (const item of report.issues) {
    const location = item.file ? `${item.file}${item.line ? `:${item.line}` : ''}` : 'project';
    lines.push(`${item.severity === 'error' ? 'ERROR' : 'WARN '} [${item.code}] ${location} — ${item.message}`);
  }
  if (report.issues.length === 0) lines.push('No quality issues found.');
  lines.push('');
  lines.push(`Checked ${report.checkedFiles} files: ${report.errors.length} error(s), ${report.warnings.length} warning(s).`);
  return lines.join('\n');
}
