import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 同梱している第三者ソフトウェアのライセンス表示の検査（docs/LEGAL_RISK_AUDIT_JP.md の D-1）。
//
// MIT は「著作権表示と許諾表示を、複製物または重要な部分すべてに含めること」を条件にしている。
// これを満たさない複製・公衆送信は、許諾の範囲外＝著作権侵害になり得る。
// 実際、SweetAlert2 は CSS と JS を丸ごと同梱しているのに、焼き込みの過程で
// 表示が完全に消えていた。手作業に頼ると次のビルドでまた落ちるので、
// 生成スクリプト側で必ず付ける形にしたうえで、ここで固定する。

const VENDOR_FILES = fs.readdirSync('.').filter(f => /^Vendor_[A-Za-z0-9_]+\.html$/.test(f));

test('同梱ファイルが実際に存在する（検査が空振りしていない）', () => {
  assert.ok(VENDOR_FILES.length >= 4,
    `Vendor_*.html が ${VENDOR_FILES.length} 個しか見つかりません`);
});

test('どの同梱ファイルにも著作権表示が残っている', () => {
  for (const file of VENDOR_FILES) {
    // 表示は先頭に置く。巨大な base64 の中の偶然の一致を拾わないよう範囲を絞る。
    const head = fs.readFileSync(file, 'utf8').slice(0, 40000);
    assert.match(head, /Copyright/i,
      `${file}: 著作権表示がありません。焼き込みの過程で落ちています。`);
  }
});

test('MIT で同梱しているものには許諾表示の本文がある', () => {
  // 「MIT です」と書くだけでは条件を満たさない。許諾表示そのものが要る。
  const mitFiles = ['Vendor_Sweetalert.html'];
  for (const file of mitFiles) {
    const head = fs.readFileSync(file, 'utf8').slice(0, 40000);
    assert.match(head, /Permission is hereby granted, free of charge/,
      `${file}: MIT の許諾表示が入っていません。`);
    assert.match(head, /The above copyright notice and this permission notice shall be included/,
      `${file}: MIT の「複製物に含めること」の条項が入っていません。`);
  }
});

test('Apache-2.0 のものはライセンス全文と改変の明示がある', () => {
  // Apache-2.0 はライセンス全文の同梱に加えて、改変した旨の明示（第4条b）を求める。
  // Material Symbols はサブセット化と可変軸の固定という改変を加えている。
  const head = fs.readFileSync('Vendor_Icons.html', 'utf8').slice(0, 40000);
  assert.match(head, /Apache License\s*\n\s*Version 2\.0/);
  assert.match(head, /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/);
  assert.match(head, /【改変】/, '改変した旨の明示がありません');
  assert.match(head, /サブセット/);
});

test('ライセンス表示は生成スクリプトが付けている（手作業に戻っていない）', () => {
  // 手で足すと、次に npm run build:vendor を回した人が気づかずに落とす。
  const build = fs.readFileSync('tools/build-vendor.mjs', 'utf8');
  assert.match(build, /const banner = \(src, license\)/,
    'banner がライセンスを受け取る形になっていません');
  assert.match(build, /readFileSync\(join\(NM, license\.pkg, 'LICENSE'\), 'utf8'\)/,
    'node_modules の LICENSE を読んでいません');

  // 各生成物がライセンス情報つきで banner を呼んでいること
  for (const marker of ['{ pkg: \'bootstrap\' }', '{ pkg: \'sweetalert2\' }',
                        'iconsLicense', 'qrcode-generator/dist/qrcode.js']) {
    assert.ok(build.includes(marker), `build-vendor.mjs に ${marker} がありません`);
  }
});

test('THIRD_PARTY_NOTICES.md が同梱物をすべて挙げている', () => {
  const notices = fs.readFileSync('THIRD_PARTY_NOTICES.md', 'utf8');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  // 同梱しているパッケージ（ビルド用のツールである playwright は同梱物ではない）
  const bundled = Object.keys(pkg.devDependencies).filter(name => name !== 'playwright');
  assert.ok(bundled.length >= 5, '同梱パッケージの数え方が変わっています');

  for (const name of bundled) {
    assert.ok(notices.includes(name),
      `THIRD_PARTY_NOTICES.md に ${name} の記載がありません`);
  }

  // 許諾表示の本文が実際に載っていること（一覧表だけでは足りない）
  assert.match(notices, /Permission is hereby granted, free of charge/);
  assert.match(notices, /Apache License/);
  // 改変の明示
  assert.match(notices, /改変/);
});

test('生成物とライセンス表示が同じ版を指している', () => {
  const notices = fs.readFileSync('THIRD_PARTY_NOTICES.md', 'utf8');

  // 実際に配信している版と、表示している版がずれていないこと。
  // Bootstrap は生成物が 5.3.3 のままで package.json（^5.3.8）と食い違っており、
  // 表示側にもその旨を明記してある。ここが黙って直る（＝版が上がる）と、
  // 表示との整合が崩れるので気づけるようにしておく。
  const shipped = /Bootstrap\s+v([0-9.]+)/.exec(fs.readFileSync('Vendor_Bootstrap.html', 'utf8'));
  assert.ok(shipped, 'Vendor_Bootstrap.html から版を読み取れません');
  assert.ok(notices.includes(shipped[1]),
    `配信している Bootstrap ${shipped[1]} が THIRD_PARTY_NOTICES.md に書かれていません`);
});
