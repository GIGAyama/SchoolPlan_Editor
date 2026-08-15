/**
 * 英語字幕のオーバーレイ。
 *
 * ページの中に字幕帯を差し込み、`window.__demoCaption(text)` で書き換えます。
 * 遷移するたびに消えるので、record-demo.mjs は framenavigated のたびに入れ直します。
 *
 * ⚠️ 差し込めるのは自分のアプリのページだけです。Google のログイン画面・同意画面・
 *    Gmail・Classroom には差し込みません（他社サイトの改変になるため）。
 *    それらの区間の字幕は、撮影後に .srt を載せて補います。
 */

export const OVERLAY_ID = '__demo_caption_overlay';

/** ページ内で実行する初期化スクリプト */
export const INSTALL_SCRIPT = `
(() => {
  const ID = '${OVERLAY_ID}';
  if (document.getElementById(ID)) return;
  const bar = document.createElement('div');
  bar.id = ID;
  bar.style.cssText = [
    'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
    'padding:18px 8%', 'box-sizing:border-box',
    'font:600 26px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif',
    'color:#fff', 'text-align:center', 'pointer-events:none',
    'background:linear-gradient(to top,rgba(0,0,0,.82),rgba(0,0,0,0))',
    'text-shadow:0 2px 6px rgba(0,0,0,.9)',
    'opacity:0', 'transition:opacity .18s ease',
  ].join(';');
  const attach = () => (document.body || document.documentElement).appendChild(bar);
  if (document.body) attach(); else document.addEventListener('DOMContentLoaded', attach);

  window.__demoCaption = (text) => {
    bar.textContent = text || '';
    bar.style.opacity = text ? '1' : '0';
  };
  window.__demoHighlight = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return false;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const previous = node.style.outline;
    node.style.outline = '4px solid #ff5722';
    node.style.outlineOffset = '3px';
    setTimeout(() => { node.style.outline = previous; node.style.outlineOffset = ''; }, 2600);
    return true;
  };
})();
`;

/** そのURLに字幕を差し込んでよいか（自分のアプリだけ true） */
export function mayInject(url) {
  if (!url || url === 'about:blank') return false;
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname.endsWith('.github.io')) return true;
    if (hostname === 'script.google.com' && pathname.includes('/macros/')) return true;
    // GAS Web アプリは iframe 内で userscontent へ載るため、そちらも対象
    if (hostname.endsWith('.googleusercontent.com')) return true;
    return false;
  } catch {
    return false;
  }
}
