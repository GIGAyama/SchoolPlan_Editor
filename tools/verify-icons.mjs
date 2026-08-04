#!/usr/bin/env node
/**
 * 焼き込んだアイコンフォント（Vendor_Icons.html）を実ブラウザで描かせて確かめる。
 *
 * なぜフォントの表を読むだけでは足りないか：
 *   サブセットの出来を静的に確認したつもりでも、ブラウザでは合字が効かず
 *   "auto_awesome" という英単語が出た（実測）。
 *   絵になっていれば横幅は 1em ちょうど、英単語のままなら数倍に広がる。
 *   その差を測るのがいちばん確実。
 *
 * 使い方: npm run verify:icons
 *   → 合字が効いていないアイコン名を並べ、1つでもあれば終了コード1で終わる。
 */
import { readFileSync, writeFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Vendor_Icons.html から <style> の中身を取り出す
const vendor = readFileSync(join(ROOT, 'Vendor_Icons.html'), 'utf8');
const css = vendor.slice(vendor.indexOf('<style>') + 7, vendor.lastIndexOf('</style>'));

// アプリが使っているアイコン名（build-vendor.mjs と同じ集め方）
const used = new Set();
for (const f of readdirSync(ROOT).filter(f => /^App.*\.html$|^LoadingModal\.html$/.test(f))) {
  const text = readFileSync(join(ROOT, f), 'utf8');
  for (const m of text.matchAll(/material-symbols-outlined[^>]*>\s*([a-z0-9_]+)\s*</g)) {
    used.add(m[1]);
  }
}
const names = [...used].sort();

const html = `<!doctype html><meta charset="utf-8"><style>${css}</style>
<body style="font-size:24px">${names.map(n =>
  `<span class="material-symbols-outlined" data-name="${n}">${n}</span>`).join('')}</body>`;
const dir = mkdtempSync(join(tmpdir(), 'icon-verify-'));
const page = join(dir, 'index.html');
writeFileSync(page, html);

const browser = await chromium.launch();
const p = await (await browser.newContext()).newPage();
await p.goto('file://' + page);
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(300);
const bad = await p.evaluate(() => {
  const out = [];
  document.querySelectorAll('.material-symbols-outlined').forEach(el => {
    const w = el.getBoundingClientRect().width;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    // 絵1文字なら 1em 前後。英単語のままなら何倍にもなる。
    if (w > fs * 1.6) out.push({ name: el.dataset.name, w: Math.round(w), fs });
  });
  return out;
});
await browser.close();

console.log(`アイコン ${names.length} 個を実ブラウザで確認`);
if (bad.length) {
  console.error('合字が効いていないアイコン（画面に英単語が出ます）:');
  bad.forEach(b => console.error(`  ${b.name}  幅 ${b.w}px（1文字なら ${b.fs}px のはず）`));
  process.exit(1);
}
console.log('すべて絵として描かれています（幅 = 1em）。');
