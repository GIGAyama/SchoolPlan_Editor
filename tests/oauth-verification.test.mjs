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
  const named = [...check.matchAll(/outdated\.push\('([^']+)'\)/g)].map(m => m[1]);
  assert.ok(named.length >= 5, '必須ファイルの確認が少なすぎます');
  for (const file of named) {
    assert.ok(fs.existsSync(file), `存在しないファイルを名指ししています: ${file}`);
  }
  // 移行の要である Sheets ファサードは必ず見る
  assert.ok(named.includes('18_SheetsApi.gs'));
  // 「ファイルはあるが古い」も捕まえる必要がある。07_WebApp.gs の旧 getSs_() は
  // SpreadsheetApp を呼ぶため、古いまま残ると権限エラーになる。
  assert.ok(named.includes('07_WebApp.gs'));
  assert.match(check, /getMyTriggersForWebApp/,
    '「今の版にしか無い」関数で見ていない（getSs_ の有無では古い版を見逃す）');
  assert.match(check, /古いまま/);

  // 起動時に一番はじめに呼ばれる経路で止める
  const tenant = fs.readFileSync('11_Tenant.gs', 'utf8');
  assert.match(tenant, /checkDeploymentIntegrity_\(\)/);
  assert.match(tenant, /deploymentError/);
  const core = fs.readFileSync('App_Js_01_Core.html', 'utf8');
  assert.match(core, /status\.deploymentError/);
  assert.match(core, /function showDeploymentError/);
  // 99_Utils.gs 自体が古いと確認用の関数も無い。そのときも配置の問題として扱う
  assert.match(tenant, /typeof checkDeploymentIntegrity_ !== 'function'/);
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

// ---------------------------------------------------------------------------
// デモ動画の台本（C5 と scenes.mjs）が、いまのアプリとスコープに追いついているか
// ---------------------------------------------------------------------------
// 撮影台本は「文書」だが、審査に出す成果物そのものなので実装と一緒に腐る。
// playwright を入れずに走る範囲だけをここで固定し、詳しい下見は
// `npm run demo:verify`（セレクタの実在確認・尺の見積もり）に任せる。

const { SCENES, SCOPE_COVERAGE } = await import('../tools/demo-video/scenes.mjs');
const c5 = fs.readFileSync('docs/C5_DEMO_VIDEO_SCRIPT.md', 'utf8');
const manifest = JSON.parse(fs.readFileSync('appsscript.json', 'utf8'));

test('要求スコープが、台本のシーンと C5 の両方で実演されている', () => {
  const demonstrated = new Set(SCENES.flatMap(scene => scene.scopes));
  for (const scope of manifest.oauthScopes) {
    const shortName = SCOPE_COVERAGE[scope];
    assert.ok(shortName, `${scope} が SCOPE_COVERAGE に未登録です`);
    assert.ok(demonstrated.has(shortName),
      `${shortName} を実演するシーンが scenes.mjs にありません`);
    assert.ok(c5.includes(shortName), `C5 の台本に ${shortName} の記載がありません`);
  }
  // 逆向き: 使っていないスコープの台本が残っていないか（spreadsheets の再来を防ぐ）
  for (const scope of Object.keys(SCOPE_COVERAGE)) {
    assert.ok(manifest.oauthScopes.includes(scope),
      `${scope} は要求していないのに台本に残っています`);
  }
});

test('C5 とシーン定義のシーン数が一致している', () => {
  const headings = c5.match(/^### シーン/gm) || [];
  assert.equal(headings.length, SCENES.length,
    `C5 のシーン数(${headings.length})と scenes.mjs(${SCENES.length})が食い違っています`);
});

test('差し戻しで名指しされた実演が台本から落ちていない', () => {
  const captions = SCENES.flatMap(scene => scene.steps)
    .filter(step => step.kind === 'caption').map(step => step.text).join('\n');

  // 「アプリが作ったファイル」だけでなく「利用者が選んだファイル」も見せる（Google 推奨の導線）
  assert.match(captions, /Google Picker/,
    'ピッカーを見せるシーンが台本にありません（drive.file の最小スコープ根拠）');
  // 書き込み・削除の source account impact
  assert.match(captions, /Drive trash/, '削除が Drive のごみ箱に映るシーンがありません');
  assert.match(captions, /Gmail inbox/, '受信トレイで実物を見せるシーンがありません');
  assert.match(captions, /not full Drive access/, 'drive.file の明言が台本にありません');
  // ホームページ・ポリシーの配信ドメイン（第三者ホスティングの指摘）
  const cname = fs.readFileSync('docs/CNAME', 'utf8').trim();
  assert.ok(captions.includes(cname), `台本が独自ドメイン ${cname} に触れていません`);
  assert.ok(c5.includes(cname), `C5 が独自ドメイン ${cname} に触れていません`);
});

test('リマインダーメールの署名が紹介ページのアプリ名と一致している', () => {
  // 動画のシーン8でメール本文が映る。ここだけ別名だと「アプリ名が違う」で差し戻される。
  const about = fs.readFileSync('docs/about.html', 'utf8');
  const appName = (about.match(/<h1>([^<]*)<\/h1>/) || [])[1] || '';
  assert.ok(appName, '紹介ページからアプリ名を読み取れません');
  const webApp = fs.readFileSync('07_WebApp.gs', 'utf8');
  const mail = webApp.slice(webApp.indexOf('function sendTaskReminderMail'));
  assert.ok(mail.includes(appName),
    `リマインダーメールの署名が「${appName}」と一致していません`);
});
