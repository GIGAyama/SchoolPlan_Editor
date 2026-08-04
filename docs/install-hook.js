/*
 * インストールの合図（beforeinstallprompt）を、いちばん先に受け取るための小さな入口。
 *
 * Chrome は条件がそろうと即座に beforeinstallprompt を出すため、
 * ページ末尾のスクリプトで待っていると、通信の速い端末では取りこぼす。
 * 取りこぼすと「アプリを入れる」ボタンが出ないまま、押しても何も起きない状態になる。
 *
 * <head> の先頭で同期読み込みすること。
 * インラインに書かないのは、あとから CSP（script-src 'self'）を入れたときに
 * 動かなくなるのを避けるため。
 */
(function () {
  window.__pwaInstallPrompt = null;

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    window.__pwaInstallPrompt = e;
    window.dispatchEvent(new Event('pwa-install-available'));
  });

  window.addEventListener('appinstalled', function () {
    window.__pwaInstallPrompt = null;
    window.dispatchEvent(new Event('pwa-installed'));
  });
})();
