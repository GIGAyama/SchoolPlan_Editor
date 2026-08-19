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

test('紐付け先が開けないときは「未紐付け」と区別して選び直しを促す', () => {
  // drive.file へ移行した直後、既存の先生は自分のDBを一度選び直す必要がある。
  // ここを「初めて使う人」と同じ画面にすると、既定ボタンの「新しく作成する」を
  // 押してしまい、これまでの週案が消えたように見える。
  const tenant = fs.readFileSync('11_Tenant.gs', 'utf8');
  const status = tenant.slice(tenant.indexOf('function getTenantStatus'),
    tenant.indexOf('function linkMyDatabase'));
  assert.match(status, /needsReauthorize\s*=\s*true/,
    '開けなかったことを needsReauthorize で伝えていない');
  assert.match(status, /needsReauthorize:\s*needsReauthorize/,
    'needsReauthorize を戻り値に含めていない');

  const core = fs.readFileSync('App_Js_01_Core.html', 'utf8');
  assert.match(core, /status\.needsReauthorize/, 'フロントが needsReauthorize を見ていない');
  assert.match(core, /function showReauthorizeChoice/, '選び直し専用の画面がない');

  const dialog = core.slice(core.indexOf('function showReauthorizeChoice'),
    core.indexOf('/** 新規作成フロー'));
  // 「データは消えていない」ことと、新規作成の危険を必ず伝える
  assert.match(dialog, /これまでのデータは消えていません/);
  assert.match(dialog, /空のデータベース/);
  // 新規作成は二段階の確認を挟む
  assert.match(dialog, /本当に新しく作りますか/);
});

test('ピッカーは App ID を渡す（drive.file の per-file 権限に必要）', () => {
  // setAppId が無いと、ピッカーで選んでも「どのアプリに権限を与えるか」が定まらず、
  // 選んだ直後のサーバー側アクセスが 403 になる。
  const pdf = fs.readFileSync('03_PdfProcessing.gs', 'utf8');
  assert.match(pdf, /appId:\s*getPickerAppId_\(\)/,
    'getPickerAuthInfo が appId を返していない');
  assert.match(pdf, /function getPickerAppId_\(\)/);
  // クライアントIDの先頭がプロジェクト番号
  assert.match(pdf, /oauth2\/v3\/tokeninfo/);

  for (const file of ['App_Js_08_Events.html', 'App_Js_10_Settings.html']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /setAppId\(appId\)/, `${file} のピッカーが setAppId を呼んでいない`);
  }
});

test('ファイルのコピー漏れを起動時に名指しで知らせる', () => {
  // 手で配置する運用なので、増えたファイルの貼り忘れが起きる。そのとき
  // 「〇〇 is not defined」だけが出ると原因に辿り着けない。
  const utils = fs.readFileSync('99_Utils.gs', 'utf8');
  const check = utils.slice(utils.indexOf('function checkDeploymentIntegrity_'),
    utils.indexOf('// ===== クリーニング・保守関連 ====='));

  // 名指しするファイルは、実在していなければ意味がない
  const named = [...check.matchAll(/missing\.push\('([^']+)'\)/g)].map(m => m[1]);
  assert.ok(named.length >= 3, '必須ファイルの確認が少なすぎます');
  for (const file of named) {
    assert.ok(fs.existsSync(file), `存在しないファイルを名指ししています: ${file}`);
  }
  // 移行の要である Sheets ファサードは必ず見る
  assert.ok(named.includes('18_SheetsApi.gs'));

  // 起動時に一番はじめに呼ばれる経路で止める
  const tenant = fs.readFileSync('11_Tenant.gs', 'utf8');
  assert.match(tenant, /checkDeploymentIntegrity_\(\)/);
  assert.match(tenant, /deploymentError/);
  const core = fs.readFileSync('App_Js_01_Core.html', 'utf8');
  assert.match(core, /status\.deploymentError/);
  assert.match(core, /function showDeploymentError/);
});

test('API がオンになっていないエラーを、権限の問題と取り違えないように言い換える', () => {
  // 組み込みサービスを使っていた頃は API の有効化が要らなかったため、
  // REST へ移した初回デプロイで必ずここに引っかかる。Google の英文だけだと
  // スコープや権限の問題と紛らわしい。
  const utils = fs.readFileSync('99_Utils.gs', 'utf8');
  assert.match(utils, /function describeApiDisabledError_\(/);
  assert.match(utils, /has not been used in project/);
  assert.match(utils, /it is disabled/);
  // 「権限ではなくプロジェクト側の設定」だと明示する
  assert.match(utils, /権限の問題ではなく/);

  for (const [file, apiName] of [['18_SheetsApi.gs', 'Google Sheets API'],
                                 ['17_DriveApi.gs', 'Google Drive API']]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(source.includes(`describeApiDisabledError_('${apiName}'`),
      `${file} が API 無効化の案内を使っていない`);
  }

  // 有効化が要る API は手順書にも載っている必要がある
  const setup = fs.readFileSync('docs/C1_GCP_PROJECT_SETUP.md', 'utf8');
  for (const api of ['Google Sheets API', 'Google Drive API', 'Google Picker API']) {
    assert.ok(setup.includes(api), `C1 に ${api} の有効化手順がありません`);
  }
});
