import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// OAuth 審査（2026-08 の差し戻し）で Google に約束した内容を固定する静的検査。
// docs/C6_VERIFICATION_RESPONSE.md の返信文と、実際の成果物がずれないようにする。
//
// ここが落ちたら「返信済みの内容と実装が食い違っている」ということなので、
// テストを直す前に C6 を読み直すこと。

const privacy = fs.readFileSync('docs/privacy-policy.html', 'utf8');
const appHtml = fs.readFileSync('App.html', 'utf8');
const wizard = fs.readFileSync('App_Js_13_SystemTools.html', 'utf8');

test('プライバシーポリシーに英文の Limited Use 宣言がある', () => {
  // 審査担当が探すのはこの一文。日本語だけでは「見当たらない」と判断されうる。
  assert.match(privacy, /Google API Services User Data Policy/);
  assert.match(privacy, /including the Limited Use requirements/);
});

test('プライバシーポリシーが AI 学習への転用を明確に否定している', () => {
  assert.match(privacy, /foundational or generalized AI\/ML models/);
  assert.match(privacy, /汎用的な AI／機械学習モデルの作成・学習・改善/);
});

test('プライバシーポリシーが AI 連携の内訳（提供者・ティア・経路）を申告している', () => {
  assert.ok(privacy.includes('id="s4-ai"'), 'AI 連携の節にアンカー #s4-ai がありません');
  assert.match(privacy, /Gemini API/);
  assert.match(privacy, /有料ティア/);
  // 「第三者 AI なし・アグリゲータなし・自己ホストなし」の3点は個別に聞かれている
  for (const item of ['第三者 AI 提供者', 'アグリゲータ', '自己ホスト']) {
    assert.ok(privacy.includes(item), `AI 連携の申告に「${item}」の記載がありません`);
  }
});

test('プライバシーポリシーが機微なデータの保護措置を具体的に書いている', () => {
  assert.match(privacy, /安全管理措置（機微なデータの保護）/);
  for (const measure of ['TLS', '保存時の暗号化', '利用者ごとの分離', '最小権限', 'インシデント']) {
    assert.ok(privacy.includes(measure), `保護措置に「${measure}」の記載がありません`);
  }
});

test('アプリ内で有料ティアの Gemini API キーを求めている', () => {
  // ポリシーに「設定画面でも明示している」と書いた以上、実装側にも必ず残す
  assert.ok(appHtml.includes('id="geminiTierNotice"'),
    '設定タブに有料ティアの注意書き（#geminiTierNotice）がありません');
  assert.match(appHtml, /有料ティア/);
  assert.match(wizard, /有料ティア/);
  assert.ok(!/で無料で取得できます/.test(wizard),
    '初期設定ウィザードに「無料で取得できます」が残っています（有料ティア必須の案内と矛盾します）');
});

test('自動実行（トリガー）の一覧と解除がアプリから使える', () => {
  // script.scriptapp の source account impact を動画で見せるための画面。
  // これが消えると C5 のシーン7-2 が撮れなくなる。
  const webApp = fs.readFileSync('07_WebApp.gs', 'utf8');
  assert.match(webApp, /function getMyTriggersForWebApp\(\)/);
  assert.match(webApp, /function deleteMyTriggerForWebApp\(/);
  assert.ok(appHtml.includes('id="triggerList"'), '設定タブに自動実行の一覧がありません');
});
