/*
 * 紹介ページ（about.html）の「ホーム画面に追加」導線。
 *
 * なぜ要るか：
 *   公開ページ（ポータル・OAuth のホームページ欄からの入口）が、アプリの入口
 *   （index.html）から紹介ページ（about.html）に変わった。紹介ページには
 *   インストールの導線が一つも無かったため、iOS Safari から来た先生には
 *   「アプリとして入れる」道が消えていた。
 *
 * iOS Safari には beforeinstallprompt が無く、追加は「共有 → ホーム画面に追加」
 * の手作業しかない。そして Safari は *いま開いているページ* を追加するため、
 * 紹介ページで追加させてはいけない（アプリではなく紹介ページのブックマークになる）。
 * そこで iOS では手順を見せたうえで、アプリの入口 './?install=1' へ渡す。
 * 入口ページ側はこの印を見て、同じ手順の案内をすぐ開く。
 *
 * Chromium 系（Android / PC）は manifest があれば beforeinstallprompt が出る。
 * 合図は install-hook.js が <head> の先頭で受け取っているので、ここでは結果を見るだけ。
 */
(function () {
  'use strict';

  var installBtn = document.getElementById('installBtn');
  var installLink = document.getElementById('installLink');
  var dialog = document.getElementById('installDialog');
  var closeBtn = document.getElementById('installCloseBtn');
  if (!installBtn || !dialog) return;

  // iPadOS 13 以降の Safari は UA が Mac と同じになるため、
  // タッチ対応（maxTouchPoints）との組み合わせで iPad と判定する。
  var isIosDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // すでにホーム画面から起動している（＝追加済み）かどうか
  var isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true;

  var lastFocused = null;

  // 手順は端末で違う。iOS は「共有 → ホーム画面に追加」、
  // それ以外（Chrome・Edge）は「メニュー → アプリをインストール」。
  // どちらを出すか決めないと、Android の先生に Safari の手順を見せてしまう。
  dialog.setAttribute('data-platform', isIosDevice ? 'ios' : 'other');
  var lead = document.getElementById('installDialogLead');
  if (lead) {
    lead.textContent = isIosDevice
      ? 'iPhone・iPad の Safari では、次の手順でアプリのように全画面で使えるようになります。'
      : '次の手順で、アプリのように全画面で使えるようになります。';
  }

  function openDialog() {
    lastFocused = document.activeElement;
    dialog.setAttribute('data-open', '1');
    // ⚠️ ここでボタンに焦点を当ててはいけない。画面が低いとき
    //    （横向きの iPhone など）はそこまでスクロールしてしまい、
    //    見出しと手順1が画面の外に出たところから始まる。
    //    カード自体に当てて、先頭から読めるようにする。
    var card = dialog.querySelector('.install-card');
    if (card) {
      try { card.focus({ preventScroll: true }); } catch (e) { card.focus(); }
    }
    // preventScroll を解さない環境のために、当てたあとで先頭へ戻す。
    dialog.scrollTop = 0;
  }

  function closeDialog() {
    dialog.removeAttribute('data-open');
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  function showInstallButton(label) {
    installBtn.textContent = label;
    installBtn.style.display = 'inline-block';
  }

  function handleInstallRequest() {
    var prompt = window.__pwaInstallPrompt;
    if (prompt) {
      // Chromium 系：ブラウザ既定のインストール確認を出す。
      window.__pwaInstallPrompt = null;
      installBtn.style.display = 'none';
      prompt.prompt();
      return;
    }
    // iOS Safari、および合図がまだ来ていない環境：手順を見せる。
    openDialog();
  }

  installBtn.addEventListener('click', handleInstallRequest);
  if (installLink) {
    installLink.style.display = 'inline';
    installLink.addEventListener('click', handleInstallRequest);
  }
  if (closeBtn) closeBtn.addEventListener('click', closeDialog);
  dialog.addEventListener('click', function (e) {
    if (e.target === dialog) closeDialog();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.getAttribute('data-open') === '1') closeDialog();
  });

  window.addEventListener('pwa-install-available', function () {
    if (!isStandalone) showInstallButton('アプリを入れる');
  });
  window.addEventListener('pwa-installed', function () {
    installBtn.style.display = 'none';
  });

  if (isStandalone) return;               // すでに入っている人には出さない
  if (isIosDevice) showInstallButton('ホーム画面に追加');
  else if (window.__pwaInstallPrompt) showInstallButton('アプリを入れる');
  // それ以外（合図がまだ来ていない Chromium など）は、合図が来てから出す。
  // 本文中の #installLink は常時置いてあるので、手順そのものはいつでも見られる。
})();
