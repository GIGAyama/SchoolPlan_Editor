import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// デプロイ設定の取り違えを検知できているかの検査（docs/LEGAL_RISK_AUDIT_JP.md の C-2）。
//
// ウェブアプリを「自分（オーナー）として実行」で公開すると、全員がオーナーの権限で動き、
// UserProperties もオーナーのものになる。結果、全員が同じ1つのデータベースを共有し、
// 他学級の児童に関する記述が相互に見える状態になる。
// README と docs/D1 で警告しているだけでは、間違えたことに気づけない。
//
// 同時に、**誤検知で締め出さないこと**も同じくらい大事。別ドメインの利用者や
// 権限未付与では getActiveUser() が空を返すので、そこで止めると
// 正しく設定できている先生までアプリを開けなくなる。

const SOURCE = fs.readFileSync('07_WebApp.gs', 'utf8');

/** 07_WebApp.gs を偽の GAS 環境で読み込み、判定関数を取り出す。 */
function loadGuard(effectiveEmail, activeEmail, options = {}) {
  const globals = {
    Session: {
      getEffectiveUser: () => {
        if (options.throwOnEffective) throw new Error('権限がありません');
        return { getEmail: () => effectiveEmail };
      },
      getActiveUser: () => {
        if (options.throwOnActive) throw new Error('権限がありません');
        return { getEmail: () => activeEmail };
      }
    },
    HtmlService: {
      createHtmlOutput: (html) => {
        const out = {
          html,
          setTitle: () => out,
          setXFrameOptionsMode: () => out,
          addMetaTag: () => out
        };
        return out;
      },
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' }
    }
  };
  const names = Object.keys(globals);
  const factory = new Function(...names, `
    ${SOURCE}
    return { describeWrongExecuteAsDeployment_, renderDeploymentErrorPage_, escapeHtmlForPage_ };
  `);
  return factory(...names.map(name => globals[name]));
}

test('正しく設定されていれば通す（実行者とアクセス者が同じ）', () => {
  const api = loadGuard('sensei@example.ed.jp', 'sensei@example.ed.jp');
  assert.equal(api.describeWrongExecuteAsDeployment_(), '');
});

test('「自分として実行」になっていれば止める', () => {
  const api = loadGuard('owner@example.com', 'sensei@example.ed.jp');
  const msg = api.describeWrongExecuteAsDeployment_();
  assert.notEqual(msg, '', '取り違えを見逃しています');
  assert.match(msg, /sensei@example\.ed\.jp/);
  assert.match(msg, /owner@example\.com/);
});

test('判定できないときは止めない（誤検知で締め出さない）', () => {
  // 別ドメインの利用者などでは getActiveUser() が空文字を返す
  assert.equal(loadGuard('owner@example.com', '').describeWrongExecuteAsDeployment_(), '');
  assert.equal(loadGuard('', 'sensei@example.ed.jp').describeWrongExecuteAsDeployment_(), '');
  assert.equal(loadGuard('', '').describeWrongExecuteAsDeployment_(), '');
});

test('権限不足で例外になっても止めない', () => {
  assert.equal(
    loadGuard('a@example.com', 'b@example.com', { throwOnActive: true })
      .describeWrongExecuteAsDeployment_(), '');
  assert.equal(
    loadGuard('a@example.com', 'b@example.com', { throwOnEffective: true })
      .describeWrongExecuteAsDeployment_(), '');
});

test('案内ページは直し方を示し、週案の画面は出さない', () => {
  const api = loadGuard('owner@example.com', 'sensei@example.ed.jp');
  const page = api.renderDeploymentErrorPage_(api.describeWrongExecuteAsDeployment_()).html;

  assert.match(page, /ウェブアプリケーションにアクセスしているユーザー/, '直し方が書かれていません');
  assert.match(page, /デプロイを管理/);
  assert.match(page, /データが混ざります/, 'なぜ止めているのかが書かれていません');
  assert.doesNotMatch(page, /include\(/, '週案の画面を組み立ててしまっています');
});

test('案内ページに差し込む文字列をエスケープしている', () => {
  // メールアドレスを画面に出すため、細工された値でタグが差し込まれないようにする
  const api = loadGuard('a@example.com', 'b@example.com');
  const escaped = api.escapeHtmlForPage_('<script>alert(1)</script>&"\'');
  assert.doesNotMatch(escaped, /<script>/);
  assert.match(escaped, /&lt;script&gt;/);
  assert.match(escaped, /&amp;/);
});

test('doGet は週案の画面を作る前に判定している', () => {
  // 判定より先に画面を組み立てると、その時点で他の先生のデータへ触れうる。
  const doGet = SOURCE.slice(SOURCE.indexOf('function doGet(e)'));
  const body = doGet.slice(0, doGet.indexOf('\nfunction ', 1));

  const guardAt = body.indexOf('describeWrongExecuteAsDeployment_');
  const renderAt = body.indexOf('createTemplateFromFile');
  assert.ok(guardAt !== -1, 'doGet が判定を呼んでいません');
  assert.ok(guardAt < renderAt, '画面の組み立てより後に判定しています');
});
