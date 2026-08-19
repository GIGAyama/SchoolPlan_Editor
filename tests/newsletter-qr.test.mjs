import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 学級通信のQRコードを、外部サービスへURLを送らずに手元で作れているかの検査。
//
// 以前は先生が入れたURLを api.qrserver.com（ドイツ goqr.me）へ送って画像を作らせ、
// その外部URLを通信に埋め込んでいた。QRに貼るのは保護者アンケートのフォームや
// 写真フォルダなど、URL自体が鍵になっているものが多い
// （docs/LEGAL_RISK_AUDIT_JP.md の A-2）。
//
// 静的検査だけだと「外部URLは消えたが、QRが出ない」状態を見逃すので、
// 出荷するコードそのもの（Vendor_Qrcode.html と NW.qrDataUrl_）を実際に動かして確かめる。

const newsletter = fs.readFileSync('App_Js_06_Newsletter.html', 'utf8');
const vendorQr = fs.readFileSync('Vendor_Qrcode.html', 'utf8');
const appHtml = fs.readFileSync('App.html', 'utf8');

/** コメント行を落として、コードだけを見る（「なぜやめたか」の説明はコメントに残す）。 */
const codeOnly = (text) => text
  .split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

// ---------------------------------------------------------------- 実際に動かす

/**
 * 出荷する Vendor_Qrcode.html の <script> と、App_Js_06_Newsletter.html の
 * NW.qrDataUrl_ だけを取り出して動かす。
 * 通信も DOM も要らない関数なので、この2つだけで完結する。
 */
function loadQrHelper() {
  const script = vendorQr.replace(/^[\s\S]*?<script>/, '').replace(/<\/script>[\s\S]*$/, '');

  const start = newsletter.indexOf('NW.qrDataUrl_ = function');
  assert.notEqual(start, -1, 'NW.qrDataUrl_ が見つかりません');
  const end = newsletter.indexOf('\n    };', start);
  assert.notEqual(end, -1, 'NW.qrDataUrl_ の終わりが見つかりません');
  const helper = newsletter.slice(start, end + '\n    };'.length);

  const sandbox = { NW: {} };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'Vendor_Qrcode.html' });
  vm.runInContext(helper, sandbox, { filename: 'App_Js_06_Newsletter.html' });
  return sandbox;
}

test('同梱したライブラリは <script> で読むとグローバル qrcode を生やす', () => {
  const sandbox = loadQrHelper();
  assert.equal(typeof sandbox.qrcode, 'function',
    'ブラウザに <script> で読ませてもグローバルが生えない形になっています');
});

test('QRコードが data URI として手元で作れる', () => {
  const { NW } = loadQrHelper();

  const uri = NW.qrDataUrl_('https://forms.gle/abcDEF123', 200);
  assert.match(uri, /^data:image\/gif;base64,/, 'data URI になっていません');
  assert.ok(uri.length > 500, '中身が小さすぎます（生成に失敗している可能性）');
  // 外部への参照が混ざっていないこと
  assert.doesNotMatch(uri, /https?:/);
});

test('日本語を含むURLや長いURLでも作れる', () => {
  const { NW } = loadQrHelper();

  for (const url of [
    'https://example.com/日本語/テスト?q=あいうえお',
    'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'https://example.com/' + 'a'.repeat(300)
  ]) {
    const uri = NW.qrDataUrl_(url, 200);
    assert.match(uri, /^data:image\/gif;base64,/, `作れませんでした: ${url.slice(0, 40)}`);
  }
});

test('指定したサイズ以上の大きさで作る（拡大でぼやけて読めなくならないように）', () => {
  const { NW, qrcode } = loadQrHelper();

  for (const size of [150, 200, 300]) {
    const uri = NW.qrDataUrl_('https://example.com/test', size);
    // 同じ条件で組み直して、実際のピクセル数を確かめる
    const qr = qrcode(0, 'M');
    qr.addData('https://example.com/test');
    qr.make();
    const modules = qr.getModuleCount() + 8; // 静粛域 4 モジュール × 2
    const cell = Math.max(1, Math.ceil(size / modules));
    assert.ok(modules * cell >= size,
      `${size}px の指定に対して ${modules * cell}px しか作れていません`);
    assert.match(uri, /^data:image\/gif;base64,/);
  }
});

test('作れないときは例外ではなく空文字を返す（編集画面を巻き添えにしない）', () => {
  const { NW } = loadQrHelper();

  assert.equal(NW.qrDataUrl_('', 200), '');
  assert.equal(NW.qrDataUrl_(null, 200), '');
  assert.equal(NW.qrDataUrl_(undefined, 200), '');

  // ライブラリが読めなかった状況を作る
  const broken = { NW: {}, qrcode: undefined };
  vm.createContext(broken);
  const start = newsletter.indexOf('NW.qrDataUrl_ = function');
  const end = newsletter.indexOf('\n    };', start);
  vm.runInContext(newsletter.slice(start, end + 7), broken);
  assert.equal(broken.NW.qrDataUrl_('https://example.com', 200), '',
    'ライブラリが無いときに例外を投げています');
});

// ---------------------------------------------------------------- 静的検査

test('外部のQR生成サービスを呼んでいない', () => {
  for (const file of fs.readdirSync('.').filter(f => f.endsWith('.html'))) {
    assert.doesNotMatch(codeOnly(fs.readFileSync(file, 'utf8')), /qrserver|api\.qrserver\.com/,
      `${file}: 外部のQR生成サービスへURLを送っています。NW.qrDataUrl_ を使ってください。`);
  }
});

test('QRを出す2つの経路が、どちらも手元生成を通っている', () => {
  // 画面の描画（renderContent）と、Classroom へ送るHTML（buildClassroomHTML）の両方。
  // 印刷は renderContent の DOM をクローンするので、自動で追随する。
  const render = newsletter.slice(newsletter.indexOf('NW.renderContent = function'));
  const renderQr = render.slice(render.indexOf("case 'qrcode':"));
  assert.match(renderQr.slice(0, 600), /NW\.qrDataUrl_\(/);

  const build = newsletter.slice(newsletter.indexOf('NW.buildClassroomHTML = function'));
  const buildQr = build.slice(build.indexOf("case 'qrcode':"));
  assert.match(buildQr.slice(0, 600), /NW\.qrDataUrl_\(/);
});

test('同梱したライブラリが App.html から読み込まれている', () => {
  assert.match(appHtml, /include\('Vendor_Qrcode'\)/);
  // App_Js_06 より前に読み込まれていること（実行時にグローバルが要る）
  assert.ok(appHtml.indexOf("include('Vendor_Qrcode')") < appHtml.indexOf("include('App_Js_06_Newsletter')"),
    'Vendor_Qrcode の読み込みが App_Js_06_Newsletter より後になっています');
});

test('同梱物にMITの著作権表示が残っている', () => {
  // MIT は「著作権表示と許諾表示を複製物に含めること」を条件にしている。
  // 焼き込みの過程で落とすとライセンス違反になる（同じ失敗が SweetAlert2 で起きている）。
  assert.match(vendorQr, /Copyright \(c\) 2009 Kazuhiko Arase/);
  assert.match(vendorQr, /Licensed under the MIT license/);
});

test('package.json と生成物が揃っている', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.ok(pkg.devDependencies['qrcode-generator'], 'devDependencies に入っていません');
  assert.ok(pkg.scripts['build:vendor:qrcode'], '生成しなおす手段がありません');

  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  assert.ok(lock.packages['node_modules/qrcode-generator'],
    'package-lock.json が更新されていません（CI の npm ci が落ちます）');
});
