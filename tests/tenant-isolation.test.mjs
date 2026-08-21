import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 先生どうしのデータが混ざらないことの検査（docs/LEGAL_RISK_AUDIT_JP.md の C-1）。
//
// ScriptProperties はスクリプト全体で1つしかない。1つのURLを多数の先生に配る運用
// （docs/config.js が配布元の /exec を指す形）では、そこに置かれた値が全員に効く。
// まだ自分の設定を持っていない先生が配布元のデータベースへ合流したり、
// 配布元の Gemini API キーで送信したりする経路になる。
//
// 一方、先生が各自でデプロイする従来の使い方では ScriptProperties も各自のものなので、
// フォールバックを一律に消すと、過去にバインド型で使っていた方の設定が失われる。
// そこで既定は従来どおりにして、共有デプロイのときだけ落ちないようにしている。

const SOURCE = fs.readFileSync('11_Tenant.gs', 'utf8');

/** 11_Tenant.gs を偽の GAS 環境で読み込む。 */
function load({ userProps = {}, scriptProps = {} } = {}) {
  const logs = [];
  const globals = {
    PropertiesService: {
      getUserProperties: () => ({
        getProperty: (k) => (k in userProps ? userProps[k] : null),
        // 本物にもある。1回で全部返るので、実装はこちらを使って呼び出し回数を抑える。
        getProperties: () => ({ ...userProps }),
        setProperty: (k, v) => { userProps[k] = v; },
        deleteProperty: (k) => { delete userProps[k]; }
      }),
      getScriptProperties: () => ({
        getProperty: (k) => (k in scriptProps ? scriptProps[k] : null),
        getProperties: () => ({ ...scriptProps })
      })
    },
    logInfo: (m) => logs.push(m),
    logError: () => {}
  };
  const names = Object.keys(globals);
  const factory = new Function(...names, `
    ${SOURCE}
    return { tGetProp_, tSetProp_, isSharedDeployment_,
             resolveSpreadsheetId_, getLegacySpreadsheetId_, getUserSpreadsheetId_ };
  `);
  return { api: factory(...names.map(n => globals[n])), logs, userProps, scriptProps };
}

// ---------------------------------------------------------------- 既定（各自デプロイ）

test('既定では、これまでどおりスクリプト全体の設定へ落ちる', () => {
  // 過去にバインド型で使っていた先生の設定を失わせないための経路
  const { api } = load({ scriptProps: { SPREADSHEET_ID: 'legacy-db', sp_courseName: '3年2組' } });

  assert.equal(api.resolveSpreadsheetId_(), 'legacy-db');
  assert.equal(api.tGetProp_('sp_courseName'), '3年2組');
});

test('自分の設定があれば、そちらが優先される', () => {
  const { api } = load({
    userProps: { up_spreadsheetId: 'my-db', sp_courseName: '4年1組' },
    scriptProps: { SPREADSHEET_ID: 'legacy-db', sp_courseName: '3年2組' }
  });

  assert.equal(api.resolveSpreadsheetId_(), 'my-db');
  assert.equal(api.tGetProp_('sp_courseName'), '4年1組');
});

// ---------------------------------------------------------------- 共有デプロイ

const SHARED = { sp_sharedDeployment: 'true' };

test('共有デプロイでは、配布元のデータベースへ合流しない', () => {
  const { api } = load({
    scriptProps: Object.assign({}, SHARED, { SPREADSHEET_ID: 'distributor-db' })
  });

  assert.equal(api.resolveSpreadsheetId_(), '',
    '自分のDBを持たない先生が、配布元のDBに合流しています');
});

test('共有デプロイでは、配布元の API キーを使わない', () => {
  // credential がスクリプト全体に置かれていると、全員の週案が
  // 配布元のキーで送信され、費用も送信元の帰属も配布元になる
  const { api } = load({
    scriptProps: Object.assign({}, SHARED, { sp_geminiApiKey: 'distributor-key' })
  });

  assert.equal(api.tGetProp_('sp_geminiApiKey'), null,
    '配布元の API キーが利用者に見えています');
});

test('共有デプロイでも、自分の設定は普通に読める', () => {
  const { api } = load({
    userProps: { up_spreadsheetId: 'my-db', sp_geminiApiKey: 'my-key' },
    scriptProps: Object.assign({}, SHARED, { SPREADSHEET_ID: 'distributor-db' })
  });

  assert.equal(api.resolveSpreadsheetId_(), 'my-db');
  assert.equal(api.tGetProp_('sp_geminiApiKey'), 'my-key');
});

test('切り替えは true のときだけ効く', () => {
  for (const value of ['false', '', 'yes', '1', undefined]) {
    const scriptProps = { SPREADSHEET_ID: 'legacy-db' };
    if (value !== undefined) scriptProps.sp_sharedDeployment = value;
    const { api } = load({ scriptProps });
    assert.equal(api.isSharedDeployment_(), false, `${JSON.stringify(value)} で有効になっています`);
    assert.equal(api.resolveSpreadsheetId_(), 'legacy-db');
  }
  // 大文字小文字は問わない
  assert.equal(load({ scriptProps: { sp_sharedDeployment: 'TRUE' } }).api.isSharedDeployment_(), true);
});

// ---------------------------------------------------------------- 気づけるようにする

test('旧バインドの設定を使ったときは記録が残る', () => {
  const { api, logs } = load({ scriptProps: { SPREADSHEET_ID: 'legacy-db' } });
  api.resolveSpreadsheetId_();

  assert.ok(logs.some(m => /旧バインド/.test(m)),
    '「別のDBを開いていた」ときの手がかりが残りません');
});

test('配布者向けの設定は切り替えの影響を受けない', () => {
  // sp_dbTemplateId は ScriptProperties から読む設計。
  // ここを tGetProp_ 経由に変えると、共有デプロイでは null が返り、
  // テンプレート複製が壊れる（tGetProp_ は共有デプロイでスクリプト全体の設定へ落ちない）。
  // 読み方が直接でも tGetScriptProp_（1回で全部読んで覚える版）でも、その性質は変わらない。
  assert.match(SOURCE, /(getScriptProperties\(\)[\s\S]{0,40}|tGetScriptProp_\()SP_KEY_DB_TEMPLATE_ID/,
    'テンプレートIDを ScriptProperties から読んでいません');
  assert.doesNotMatch(SOURCE, /tGetProp_\(\s*SP_KEY_DB_TEMPLATE_ID/,
    'テンプレートIDの読み取りが tGetProp_ 経由に変わっています');
});
