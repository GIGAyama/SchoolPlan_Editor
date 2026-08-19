#!/usr/bin/env node
/**
 * 外部CDNから読んでいた「実行コード」を、GASが配れる形（.html）へ焼き込む生成スクリプト。
 *
 * なぜ必要か
 *   学校のネットワークは cdn.jsdelivr.net / fonts.googleapis.com を塞いでいることがある。
 *   塞がれると次のことが起きる（実測で確認した）。
 *     - Bootstrap CSS が当たらず、レイアウトが崩れる
 *     - SweetAlert2 が読めず、確認ダイアログを開く操作が ReferenceError で止まる
 *     - Material Symbols が届かず、アイコンが "calendar_month" のような英単語として表示される
 *   原因はアプリの外（ネットワーク）にあるため、先生が調べても分からない。
 *
 * 生成物（手で編集しないこと）
 *   Vendor_Bootstrap.html   Bootstrap 5 の CSS
 *   Vendor_Icons.html       Material Symbols（使っているアイコンだけに絞ったサブセット）
 *                           + Bootstrap Icons（使っている8個だけ）
 *   Vendor_Sweetalert.html  SweetAlert2 の CSS と JS
 *   Vendor_Qrcode.html      QRコード生成（学級通信のQRを外部へ送らずに作るため）
 *
 * 原本
 *   node_modules 配下の各パッケージ（package.json で版を固定している）と、
 *   リポジトリ内で実際に使われているアイコン名。
 *
 * ライセンス表示は必ず一緒に焼き込む（banner 参照）。同じ内容を
 * THIRD_PARTY_NOTICES.md にもまとめてある。
 *
 * 使い方
 *   npm install && npm run build:vendor          … 全部を作り直す
 *   npm install && npm run build:vendor -- icons … 対象を選ぶ（icons/bootstrap/sweetalert/qrcode）
 *   フォントのサブセットには Python の fonttools が要る（無い場合は full を埋め込まず中止する）。
 *   fonttools を入れずに他の生成物だけ作りたいときは、対象を選んで実行すること。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NM = join(ROOT, 'node_modules');
/**
 * 生成物の先頭に置くコメント。
 *
 * ライセンス表示を必ず一緒に焼き込む。MIT は「著作権表示と許諾表示を、複製物または
 * 重要な部分すべてに含めること」を条件にしており、Apache-2.0 はライセンス全文の同梱と
 * 改変の明示を求める。ここを手作業に任せると次のビルドでまた落ちるため、
 * スクリプト側で必ず付ける（実際、SweetAlert2 は焼き込みの過程で表示が完全に消えていた。
 * docs/LEGAL_RISK_AUDIT_JP.md の D-1）。
 *
 * @param {string} src 原本の npm パス
 * @param {{pkg?: string, notice?: string, modified?: string}} [license]
 *   pkg      … node_modules 配下のパッケージ名。LICENSE を読んで丸ごと焼き込む
 *   notice   … LICENSE ファイルを持たないパッケージ用の、手書きの著作権・許諾表示
 *   modified … 改変している場合にその内容（Apache-2.0 が求める「改変の明示」）
 */
const banner = (src, license) => {
  let text = '<!-- このファイルは tools/build-vendor.mjs が生成しています。手で編集しないでください。\n'
    + `     原本: ${src}\n`;
  if (license && license.modified) {
    text += `\n     【改変】${license.modified}\n`;
  }
  const body = license && (license.notice
    || (license.pkg ? readFileSync(join(NM, license.pkg, 'LICENSE'), 'utf8') : ''));
  if (body) {
    // コメントを閉じてしまう "--" がライセンス本文に混ざっても壊れないようにする
    text += '\n     --- ライセンス ---\n'
      + body.trim().split('\n').map(line => '     ' + line.replace(/--/g, '- -')).join('\n')
      + '\n';
  }
  return text + '-->\n';
};

// --- 1. アプリが実際に使っているアイコン名を集める -------------------------
// 静的な <span class="material-symbols-outlined">name</span> だけでなく、
// JS が組み立てる箇所（icon: 'save' など）もあるため、
// 「Material Symbols に存在する名前」と「リポジトリ内の文字列」の積を取る。
function collectIconNames() {
  const dts = join(NM, '@material-symbols/font-400/index.d.ts');
  const known = new Set(readFileSync(dts, 'utf8').match(/"([a-z0-9_]+)"/g).map(s => s.slice(1, -1)));
  const used = new Set();
  const files = readdirSync(ROOT).filter(f => /^App.*\.html$|^LoadingModal\.html$/.test(f));
  for (const f of files) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    // ①タグの中身として直接書かれているもの。
    //    ⚠️ ここで「既知のアイコン名か」で絞ってはいけない。
    //      index.d.ts は現行名の一覧なので、別名（auto_awesome / auto_fix_high など）が
    //      落ちる。実際にそれで3個が英単語のまま表示された。
    //      タグの中身は定義上アイコン名なので、そのまま採る。
    for (const m of text.matchAll(/material-symbols-outlined[^>]*>\s*([a-z0-9_]+)\s*</g)) {
      used.add(m[1]);
    }
    // ②JS の文字列として現れるもの（icon: 'save' / '...'+'check_circle'+'...' など）
    for (const m of text.matchAll(/['"`]([a-z][a-z0-9_]{2,30})['"`]/g)) {
      if (known.has(m[1])) used.add(m[1]);
    }
  }
  // 表示中に差し替わるものの取りこぼしを防ぐため、よく使う対を明示的に足す
  ['check_circle', 'radio_button_unchecked', 'expand_more', 'expand_less', 'close', 'error',
    'warning', 'info', 'chevron_left', 'chevron_right'].forEach(n => used.add(n));
  return [...used].sort();
}

// --- 2. Material Symbols をサブセットして base64 で埋め込む -----------------
function buildIconsHtml(iconNames) {
  const src = join(NM, '@material-symbols/font-400/material-symbols-outlined.woff2');
  const stat = join(tmpdir(), 'ms-static-' + process.pid + '.ttf');
  const tmp = join(tmpdir(), 'ms-subset-' + process.pid + '.woff2');

  // ① 可変フォント（FILL 軸）を FILL=0 に固定する。
  //    gvar/fvar が落ちるぶんだけ小さくなる。塗りつぶし表示は使っていない。
  execFileSync('python3', ['-m', 'fontTools.varLib.instancer', src, 'FILL=0', '-o', stat],
    { stdio: ['ignore', 'ignore', 'inherit'] });

  // ② アイコン名 → 実際に描かれるグリフ名を、合字表を読んで引く。
  //    別名があるため（例：auto_fix_high は auto_fix というグリフに置換される）、
  //    アイコン名をそのままグリフ名だと思って渡すと、合字の行き先が落ちて
  //    画面に英単語が出る。
  const ligScript = join(ROOT, 'tools/ms-ligatures.py');
  const pairs = execFileSync('python3', [ligScript, stat, iconNames.join(',')], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).map(l => l.split('\t'));
  const unresolved = pairs.filter(([, g]) => !g).map(([n]) => n);
  const keepGlyphs = [...new Set(pairs.map(([, g]) => g).filter(Boolean))];
  if (unresolved.length) {
    // 名前を拾い間違えている（JSの文字列がたまたまアイコン名と同じだった等）ことが多い。
    // 落としても画面は壊れないが、見えるようにしておく。
    console.log('  ※ 合字が引けなかった名前（サブセットから除外）:', unresolved.join(', '));
  }

  // ③ 使っているアイコンだけに絞る。
  //    ⚠️ --text= にアイコン名を並べるやり方では小さくならない。
  //      合字は「文字の並び → グリフ」の置換なので、fonttools が閉包を取ると
  //      同じ文字を使う他のアイコン（数千個）まで一緒に残ってしまう。
  //      実測：--text 方式 347.6KB / --glyphs + --no-layout-closure 方式 14.5KB。
  //    合字の入力側に要る英小文字・数字・下線だけを --text で残し、
  //    出力側のグリフを --glyphs で名指しする。
  execFileSync('python3', ['-m', 'fontTools.subset', stat,
    '--glyphs=' + keepGlyphs.join(','),
    '--text=abcdefghijklmnopqrstuvwxyz0123456789_ ',
    '--layout-features=liga,dlig,calt,rlig',
    '--no-layout-closure',
    '--flavor=woff2',
    '--output-file=' + tmp,
    '--no-hinting', '--desubroutinize'], { stdio: ['ignore', 'ignore', 'inherit'] });

  // ④ 出来上がりが正しいかは、フォントの表を読むだけでは分からない。
  //    npm run verify:icons（実ブラウザで1つずつ描かせて幅を測る）で確かめること。
  const b64 = readFileSync(tmp).toString('base64');

  // Bootstrap Icons は使っている分だけ。CSS の :before の符号位置を JSON から引く。
  const biJson = JSON.parse(readFileSync(join(NM, 'bootstrap-icons/font/bootstrap-icons.json'), 'utf8'));
  const biUsed = new Set();
  for (const f of readdirSync(ROOT).filter(f => /\.html$/.test(f))) {
    for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(/\bbi-([a-z0-9-]+)/g)) {
      if (biJson[m[1]] !== undefined) biUsed.add(m[1]);
    }
  }
  const biNames = [...biUsed].sort();
  const biTmp = join(tmpdir(), 'bi-subset-' + process.pid + '.woff2');
  execFileSync('python3', ['-m', 'fontTools.subset',
    join(NM, 'bootstrap-icons/font/fonts/bootstrap-icons.woff2'),
    '--unicodes=' + biNames.map(n => 'U+' + biJson[n].toString(16).toUpperCase()).join(','),
    '--flavor=woff2', '--output-file=' + biTmp, '--no-hinting'],
    { stdio: ['ignore', 'ignore', 'inherit'] });
  const biB64 = readFileSync(biTmp).toString('base64');

  const css = `
/* Material Symbols Outlined（Apache License 2.0 / Google）
   使用中の ${iconNames.length} 個だけを残したサブセット。 */
@font-face {
  font-family: 'Material Symbols Outlined';
  font-style: normal;
  font-weight: 400;
  font-display: block; /* 合字が確定するまで英単語を見せない（"calendar_month" と出るのを防ぐ） */
  src: url(data:font/woff2;base64,${b64}) format('woff2');
}
.material-symbols-outlined {
  font-family: 'Material Symbols Outlined';
  font-weight: normal;
  font-style: normal;
  font-size: 24px;
  line-height: 1;
  letter-spacing: normal;
  text-transform: none;
  display: inline-block;
  white-space: nowrap;
  word-wrap: normal;
  direction: ltr;
  -webkit-font-feature-settings: 'liga';
  -webkit-font-smoothing: antialiased;
  font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
}

/* Bootstrap Icons（MIT / The Bootstrap Authors）使用中の ${biNames.length} 個だけ。 */
@font-face {
  font-family: 'bootstrap-icons';
  font-display: block;
  src: url(data:font/woff2;base64,${biB64}) format('woff2');
}
.bi::before, [class^="bi-"]::before, [class*=" bi-"]::before {
  display: inline-block;
  font-family: 'bootstrap-icons' !important;
  font-style: normal;
  font-weight: normal !important;
  font-variant: normal;
  text-transform: none;
  line-height: 1;
  vertical-align: -.125em;
  -webkit-font-smoothing: antialiased;
}
${biNames.map(n => `.bi-${n}::before { content: "\\${biJson[n].toString(16)}"; }`).join('\n')}
`;
  const iconsLicense = {
    notice: readFileSync(join(NM, '@material-symbols/font-400/LICENSE'), 'utf8')
      + '\n\n========================================\n\nBootstrap Icons\n\n'
      + readFileSync(join(NM, 'bootstrap-icons/LICENSE'), 'utf8'),
    modified: 'Material Symbols … 使用中のアイコンだけを残すサブセット化と、可変軸 FILL の 0 固定。'
      + ' Bootstrap Icons … 使用中の 8 個だけを残すサブセット化。'
  };
  return { html: banner('@material-symbols/font-400, bootstrap-icons（npm）', iconsLicense) + '<style>\n' + css + '\n</style>\n', iconCount: iconNames.length, biNames, woff2Bytes: Buffer.from(b64, 'base64').length, biBytes: Buffer.from(biB64, 'base64').length };
}

// --- 3. Bootstrap CSS ------------------------------------------------------
function buildBootstrapHtml() {
  const css = readFileSync(join(NM, 'bootstrap/dist/css/bootstrap.min.css'), 'utf8')
    // 配布物に含まれる sourceMappingURL は、CDN を塞がれた環境で404を出すだけなので落とす
    .replace(/\/\*# sourceMappingURL=.*?\*\//g, '');
  return banner('bootstrap/dist/css/bootstrap.min.css（npm）', { pkg: 'bootstrap' })
    + '<style>\n' + css + '\n</style>\n';
}

// --- 4. SweetAlert2 --------------------------------------------------------
function buildSweetalertHtml() {
  const css = readFileSync(join(NM, 'sweetalert2/dist/sweetalert2.min.css'), 'utf8')
    .replace(/\/\*# sourceMappingURL=.*?\*\//g, '');
  const js = readFileSync(join(NM, 'sweetalert2/dist/sweetalert2.min.js'), 'utf8')
    .replace(/\/\/# sourceMappingURL=.*$/gm, '');
  return banner('sweetalert2/dist（npm）', { pkg: 'sweetalert2' })
    + '<style>\n' + css + '\n</style>\n<script>\n' + js + '\n</script>\n';
}

// --- 5. QRコード生成 -------------------------------------------------------
// 学級通信のQRは、以前は外部サービス（api.qrserver.com）へ先生が入れたURLを送って
// 画像を作らせていた。QRに貼るのは保護者アンケートのフォームなど、URL自体が鍵に
// なっているものが多いため、送信そのものをやめてブラウザ内で作る
// （docs/LEGAL_RISK_AUDIT_JP.md の A-2）。
// 同期APIであることが選定理由。NW.renderContent は同期関数なので、非同期の生成では描画順が崩れる。
function buildQrcodeHtml() {
  // ブラウザで <script> として読むとグローバル `qrcode` が生える（末尾のUMD判定は
  // define も exports も無い環境では何もしない）。原本の先頭に MIT の著作権表示が
  // 入っているので、そのまま焼き込めばライセンス条件を満たす。
  const js = readFileSync(join(NM, 'qrcode-generator/dist/qrcode.js'), 'utf8')
    .replace(/\/\/# sourceMappingURL=.*$/gm, '');
  // このパッケージは LICENSE ファイルを持たないが、原本の先頭に著作権表示と許諾表示が
  // 入っているので、そのまま焼き込めば MIT の条件を満たす。
  return banner('qrcode-generator/dist/qrcode.js（npm）',
    { notice: '著作権表示と MIT ライセンスの本文は、下の原本の先頭にそのまま含まれています。' })
    + '<script>\n' + js + '\n</script>\n';
}

// --- 実行 ------------------------------------------------------------------
// 引数で作るものを選べる。指定が無ければ従来どおり全部作る。
//   node tools/build-vendor.mjs            … 全部
//   node tools/build-vendor.mjs qrcode     … Vendor_Qrcode.html だけ
// アイコンのサブセットには Python の fonttools が要るため、それを持っていない環境でも
// 他の生成物だけは作れるようにしてある。
const targets = process.argv.slice(2);
const wants = (name) => targets.length === 0 || targets.includes(name);

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const size = (f) => readFileSync(join(ROOT, f)).length;

if (wants('icons')) {
  const icons = collectIconNames();
  const iconsOut = buildIconsHtml(icons);
  writeFileSync(join(ROOT, 'Vendor_Icons.html'), iconsOut.html);
  console.log('Material Symbols:', iconsOut.iconCount, '個 →', kb(iconsOut.woff2Bytes), '(元 488.7 KB)');
  console.log('Bootstrap Icons :', iconsOut.biNames.length, '個 →', kb(iconsOut.biBytes));
  console.log('Vendor_Icons.html     ', kb(size('Vendor_Icons.html')));
}
if (wants('bootstrap')) {
  writeFileSync(join(ROOT, 'Vendor_Bootstrap.html'), buildBootstrapHtml());
  console.log('Vendor_Bootstrap.html ', kb(size('Vendor_Bootstrap.html')));
}
if (wants('sweetalert')) {
  writeFileSync(join(ROOT, 'Vendor_Sweetalert.html'), buildSweetalertHtml());
  console.log('Vendor_Sweetalert.html', kb(size('Vendor_Sweetalert.html')));
}
if (wants('qrcode')) {
  writeFileSync(join(ROOT, 'Vendor_Qrcode.html'), buildQrcodeHtml());
  console.log('Vendor_Qrcode.html    ', kb(size('Vendor_Qrcode.html')));
}
