// 週案をPDFで保存したときのファイル名が、その週のものになることを実ブラウザで確認する。
//
// ⚠️ ファイル名になるのは、刷る文書の題ではなく **いちばん外側のページの題**。
// このアプリは 入口ページ(docs/index.html) → GAS → アプリ本体 と iframe が三重で、
// いちばん外側は別ドメイン。アプリからは postMessage で頼むほかない。
// そして postMessage はその場では届かないので、頼んだ直後に print() を呼ぶと
// 「まだ替わっていない題」でファイル名が決まる。この取りこぼしは node --test では
// 再現できない（出どころの違う本物のフレームと、本物の処理の順序が要る）。
//
//   node tools/verify-print-title.mjs
// Chromium の場所が既定と違うときは CHROMIUM_PATH で指定する。
//
// 出どころの違うドメインは page.route() で作る。giga-school.com と
// googleusercontent.com の応答を差し替え、本物の app-url.js と
// 本物の印刷モジュールを載せた三重の入れ子を組み立てている。
import fs from 'node:fs';
import { chromium, devices } from 'playwright';

const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const SHELL_JS = read('docs/app-url.js');
const PRINT_SRC = read('App_Js_03_Print.html');
const APP_SRC = read('App.html');

/** HTML内JSから関数1つ分を、波括弧の対応を数えて切り出す */
function fn(name) {
  const a = PRINT_SRC.indexOf('function ' + name + '(');
  if (a < 0) throw new Error('関数が見つからない: ' + name);
  const o = PRINT_SRC.indexOf('{', a);
  let d = 0;
  for (let i = o; i < PRINT_SRC.length; i++) {
    if (PRINT_SRC[i] === '{') d++;
    else if (PRINT_SRC[i] === '}' && --d === 0) return PRINT_SRC.slice(a, i + 1);
  }
  throw new Error('波括弧が閉じていない: ' + name);
}

const CONSTS = (PRINT_SRC.match(/var (?:HOST_TITLE_RESTORE_MS|SHELL_TITLE_ACK_MS) = \d+;/g) || []).join('\n');
const PRINT_JS = [CONSTS, fn('postShellTitle_'), fn('swapHostTitle_'),
  fn('whenShellTitleApplied_'), fn('buildPrintDocTitle_')].join('\n\n');

// App.html の ready ハンドシェイク（shellAck で入口ページの素性を控えるところ）をそのまま使う。
// 書き写すと、本物が変わったときにこの検証だけ古いまま通ってしまう。
const HANDSHAKE = (() => {
  const a = APP_SRC.indexOf("window.top.postMessage({ type: 'schoolPlanNote:ready' }");
  if (a < 0) throw new Error('App.html の ready ハンドシェイクが見つからない');
  const start = APP_SRC.lastIndexOf('(function () {', a);
  const end = APP_SRC.indexOf('})();', a);
  if (start < 0 || end < 0) throw new Error('App.html の ready ハンドシェイクを切り出せない');
  return APP_SRC.slice(start, end + 5);
})();

const SHELL_URL = 'https://schoolplan-editor.giga-school.com/';
const SHELL_TITLE = '週案エディタ - School Plan Note';
const APP_URL = 'https://n-verifyprinttitle-script.googleusercontent.com/exec';
const WEEK = ['2026/08/31', '2026/09/01', '2026/09/02', '2026/09/03', '2026/09/04', '2026/09/05', '2026/09/06'];
const EXPECTED = '週案第23週(8月31日-9月6日)';

// 入口ページ。app-url.js が触る要素をひととおり置いた最小の作り
const IDS = ['loading', 'setup', 'recovery', 'welcome', 'menuBtn', 'menuPanel', 'installBtn',
  'setupError', 'iosGuide', 'iosInstallBanner', 'updateToast'];
const BTN_IDS = ['saveBtn', 'changeUrlBtn', 'reloadBtn', 'recoveryOpenBtn', 'recoveryReloadBtn',
  'recoveryShowBtn', 'welcomeContinueBtn', 'welcomeLoginBtn', 'welcomeShowBtn', 'iosBannerCloseBtn',
  'iosBannerGuideBtn', 'iosGuideCloseBtn', 'updateApplyBtn', 'updateLaterBtn'];
const shellHtml = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<title>${SHELL_TITLE}</title></head><body>
${IDS.map(id => `<div id="${id}"></div>`).join('')}
${BTN_IDS.map(id => `<button id="${id}"></button>`).join('')}
<a id="newTabLink"></a><a id="recoveryNewTabBtn"></a><input id="urlInput">
<iframe id="appFrame" src="${APP_URL}"></iframe>
<script>
  // 題がいつ替わったかを控える。「印刷が始まる時点で替わっていたか」はこれで測る
  window.__titleLog = [];
  var desc = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
  Object.defineProperty(document, 'title', {
    get: function () { return desc.get.call(document); },
    set: function (v) { window.__titleLog.push({ title: v, at: Date.now() }); desc.set.call(document, v); }
  });
</script>
<script src="app-url.js"></script></body></html>`;

const appHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>週案エディタ</title></head><body>
<script>${HANDSHAKE}<\/script>
<script>
${PRINT_JS}
// 印刷の実物と同じ順で呼ぶ（printWeeklyPlanExec の doPrint と同じ流れ）。
// print() そのものは測れないので、呼ばれた時刻を控えるだけの形に差し替える。
window.__printedAt = null;
window.__restore = null;
window.__docTitle = '';
window.runPrint = function () {
  var days = ${JSON.stringify(WEEK)}.map(function (date) { return { date: date }; });
  window.__docTitle = buildPrintDocTitle_(23, days);
  var startPrint = function () { window.__printedAt = Date.now(); };
  window.__restore = swapHostTitle_(window.__docTitle);
  whenShellTitleApplied_(SHELL_TITLE_ACK_MS, startPrint);
};
<\/script></body></html>`;

const exe = process.env.CHROMIUM_PATH || undefined;

async function run(label, contextOpts) {
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const context = await browser.newContext(contextOpts);
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url === SHELL_URL) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: shellHtml });
      if (url.endsWith('/app-url.js')) return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: SHELL_JS });
      if (url.startsWith(APP_URL)) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: appHtml });
      return route.fulfill({ status: 404, body: '' });
    });
    const page = await context.newPage();
    await page.goto(SHELL_URL);
    const app = page.frames().find(f => f.url().startsWith(APP_URL));
    if (!app) return { label, error: 'アプリ本体のフレームが立ち上がらない' };

    // 入口ページからの応答（shellAck）で送り元を控えられているか
    try {
      await app.waitForFunction('typeof window.__shellOrigin === "string"', null, { timeout: 5000 });
    } catch (e) {
      return { label, error: 'shellAck が届かず、入口ページの素性を控えられていない' };
    }

    await app.evaluate('window.runPrint()');
    await app.waitForFunction('window.__printedAt !== null', null, { timeout: 5000 });

    const printedAt = await app.evaluate('window.__printedAt');
    const docTitle = await app.evaluate('window.__docTitle');
    const log = await page.evaluate('window.__titleLog');
    const atPrint = log.filter(e => e.at <= printedAt).pop();

    // 印刷後（afterprint 相当）に元へ戻るか
    await app.evaluate('window.__restore()');
    let restored = true;
    try {
      await page.waitForFunction(`document.title === ${JSON.stringify(SHELL_TITLE)}`, null, { timeout: 3000 });
    } catch (e) { restored = false; }

    return { label, docTitle, atPrint: atPrint ? atPrint.title : null, restored };
  } finally {
    await browser.close();
  }
}

const CASES = [
  ['パソコン', {}],
  ['スマホ (Android)', devices['Pixel 7']],
  ['スマホ (iPhone)', devices['iPhone 14']],
  ['タブレット (iPad)', devices['iPad (gen 7)']],
];

let bad = 0;
for (const [label, opts] of CASES) {
  const r = await run(label, opts);
  const ok = !r.error && r.atPrint === EXPECTED && r.docTitle === EXPECTED && r.restored;
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : 'NG  '} ${label}`);
  if (r.error) {
    console.log(`      ${r.error}`);
  } else {
    console.log(`      印刷が始まる時点の題: ${r.atPrint === null ? '(替わっていない)' : r.atPrint}`);
    if (r.atPrint !== EXPECTED) console.log(`      期待する題          : ${EXPECTED}`);
    if (!r.restored) console.log(`      印刷後に元の題へ戻っていない`);
  }
}
console.log(bad === 0
  ? '\n全部の端末で「入口ページの題を当ててから刷る」順になっている'
  : `\n${bad} 件が期待どおりでない`);
process.exit(bad ? 1 : 0);
