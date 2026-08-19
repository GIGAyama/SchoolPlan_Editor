/**
 * 撮影に使う URL の解決。
 *
 * appUrl は docs/config.js（PWAシェルの設定）から読み取ります。
 * 撮影用に別のデプロイを使いたいときは環境変数で上書きできます。
 *
 *   DEMO_SITE_BASE    公開ページの基点（既定は docs/CNAME の独自ドメイン）
 *   DEMO_APP_URL      GAS Web アプリの /exec URL（同意画面が出るのはここ）
 *   DEMO_HOME_URL     紹介ページ（同意画面のホームページ欄と一致させること）
 *   DEMO_PRIVACY_URL  プライバシーポリシー
 *   DEMO_TERMS_URL    利用規約
 *   DEMO_SHEET_URL    撮影用スプレッドシート（ダミーデータのもの）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** docs/config.js から appUrl を取り出す（JSON ではないので正規表現で読む） */
function readConfiguredAppUrl() {
  const file = path.join(ROOT, 'docs', 'config.js');
  if (!fs.existsSync(file)) return '';
  const matched = fs.readFileSync(file, 'utf8').match(/appUrl:\s*"([^"]*)"/);
  return matched ? matched[1] : '';
}

/**
 * 公開ページの既定値。**必ず自分が所有するドメイン**（docs/CNAME）を使う。
 * 2026-08 の差し戻しで「ホームページとプライバシーポリシーを、所有を確認できない
 * 第三者ホスティングに置かないこと」と指摘されたため、`*.github.io` の既定は使わない。
 * 別ドメインで撮る場合だけ DEMO_SITE_BASE で差し替える。
 */
const siteBase = (process.env.DEMO_SITE_BASE || 'https://schoolplan-editor.giga-school.com')
  .replace(/\/+$/, '');

export function resolveUrls() {
  const appUrl = process.env.DEMO_APP_URL || readConfiguredAppUrl();
  return {
    APP_URL: appUrl,
    HOME_URL: process.env.DEMO_HOME_URL || `${siteBase}/about.html`,
    PRIVACY_URL: process.env.DEMO_PRIVACY_URL || `${siteBase}/privacy-policy.html`,
    TERMS_URL: process.env.DEMO_TERMS_URL || `${siteBase}/terms.html`,
    SHEET_URL: process.env.DEMO_SHEET_URL || '',
  };
}

/**
 * 台本中の {{PLACEHOLDER}} を実 URL に差し替える。
 * 段取り確認（--dry-run）では未設定でも止めず、未設定であることを見せる。
 */
export function expand(value, urls, { allowMissing = false } = {}) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{(\w+)\}\}/g, (whole, key) => {
    const replacement = urls[key];
    if (replacement) return replacement;
    if (allowMissing) return `<未設定: DEMO_${key}>`;
    throw new Error(`URL が未設定です: ${key}（環境変数 DEMO_${key} で指定してください）`);
  });
}

/** 撮影前に URL が揃っているかを確認する。足りないものを配列で返す */
export function missingUrls(urls, { requireSheet = true } = {}) {
  const missing = [];
  if (!urls.APP_URL) missing.push('DEMO_APP_URL（docs/config.js の appUrl も空です）');
  if (requireSheet && !urls.SHEET_URL) missing.push('DEMO_SHEET_URL（撮影用スプレッドシートの URL）');
  return missing;
}
