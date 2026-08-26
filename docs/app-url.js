/*
 * 入口ページの立ち上げ処理。
 *
 * ここはかつて docs/index.html の中に <script> で直に書いてあった（405行）。
 * 外に出した理由:
 *   インラインの <script> があると、CSP の script-src に 'unsafe-inline' を
 *   入れるほかなくなる。それを入れると CSP を入れた意味がほとんど無くなるので、
 *   このページには CSP そのものが無かった。外部ファイルにすれば
 *   script-src 'self' で閉じられる（2026-08-23）。
 *
 * やっていること:
 *   ・アプリ本体（GAS の /exec）の URL を決める（config.js → 保存値 → 手入力）
 *   ・iframe に読ませ、表示できたら記録する
 *   ・出せないときは、初回か再訪かで案内を出し分ける
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'schoolPlanNote.appUrl';
    // このブラウザで一度でもアプリ本体を iframe 内に表示できたかを記録するキー。
    // 初回（＝未ログイン・未認可の可能性が高い）と再訪を区別し、案内を出し分けるために使う。
    var EVER_READY_KEY = 'schoolPlanNote.everReady';
    var loading = document.getElementById('loading');
    var setup = document.getElementById('setup');
    var recovery = document.getElementById('recovery');
    var welcome = document.getElementById('welcome');
    var frame = document.getElementById('appFrame');
    var menuBtn = document.getElementById('menuBtn');
    var menuPanel = document.getElementById('menuPanel');
    var installBtn = document.getElementById('installBtn');
    var deferredPrompt = null;
    // アプリ本体が iframe 内で読み込めたかの状態管理
    var appReady = false;      // App 側からの ready ハンドシェイクを受信したか
    var launchTimer = null;    // 一定時間 ready が来なければ案内へ切り替えるタイマー
    var currentUrl = '';       // 現在起動中の exec URL
    // このブラウザで過去に一度でも表示できたか（初回ログイン導線を出すか判断する）。
    var everReady = false;
    try { everReady = localStorage.getItem(EVER_READY_KEY) === '1'; } catch (e) { }
    // 再訪ユーザー: ready が来なければ「表示できなかった」とみなして案内へ切り替えるまでの待ち時間。
    // 開けるユーザーは本体HTML読込時に即 ready が届くため通常は発火しないが、
    // 低速回線やGASのコールドスタートで読込自体が遅い場合の誤発火を避けるため長めに取る。
    var LAUNCH_TIMEOUT_MS = 20000;
    // 初回ユーザー: 未ログインだと Google のログイン画面が iframe 内に表示できず空白のままになる。
    // 20秒も空白で待たせず、早めに親切なログイン案内（#welcome）へ切り替える。
    // 既にログイン済みの初回ユーザーは ready が即届くため、この案内は表示されない。
    var FIRST_RUN_HINT_MS = 4000;

    // GASのWebアプリURLのみ許可（通常アカウント / Google Workspace ドメイン両対応）
    function isValidGasUrl(url) {
        try {
            var u = new URL(url);
            return u.origin === 'https://script.google.com' &&
                /^\/(a\/macros\/[^/]+|macros)\/s\/[\w-]+\/exec$/.test(u.pathname);
        } catch (e) {
            return false;
        }
    }

    function getAppUrl() {
        var conf = (window.SCHOOL_PLAN_NOTE_CONFIG || {}).appUrl || '';
        if (isValidGasUrl(conf)) return conf;
        var saved = '';
        try { saved = localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { }
        return isValidGasUrl(saved) ? saved : '';
    }

    function showSetup(message) {
        if (launchTimer) { clearTimeout(launchTimer); launchTimer = null; }
        loading.style.display = 'none';
        frame.style.display = 'none';
        recovery.style.display = 'none';
        welcome.style.display = 'none';
        menuBtn.style.display = 'none';
        setup.style.display = 'flex';
        var err = document.getElementById('setupError');
        if (message) {
            err.textContent = message;
            err.style.display = 'block';
        } else {
            err.style.display = 'none';
        }
    }

    // アプリ本体（iframe）を表示する
    function showFrame() {
        if (launchTimer) { clearTimeout(launchTimer); launchTimer = null; }
        loading.style.display = 'none';
        setup.style.display = 'none';
        recovery.style.display = 'none';
        welcome.style.display = 'none';
        frame.style.display = 'block';
        // ⚠️ flex にすること。ボタンの中身は SVG で、CSS 側は
        //    flex の中央そろえで位置を決めている。block に戻すと
        //    アイコンが左上に寄る。
        menuBtn.style.display = 'flex';
    }

    // iframe内に表示できなかったときの案内を表示する。
    // iframe自体はDOMに残すため、遅れて ready が届けば showFrame() で自動復帰できる。
    function showRecovery() {
        loading.style.display = 'none';
        setup.style.display = 'none';
        welcome.style.display = 'none';
        frame.style.display = 'none';
        menuBtn.style.display = 'none';
        recovery.style.display = 'flex';
    }

    // 初回ユーザー向けのログイン案内を表示する。
    // iframe自体はDOMに残すため、ログイン後に ready が届けば showFrame() で自動復帰できる。
    function showWelcome() {
        if (launchTimer) { clearTimeout(launchTimer); launchTimer = null; }
        loading.style.display = 'none';
        setup.style.display = 'none';
        recovery.style.display = 'none';
        frame.style.display = 'none';
        menuBtn.style.display = 'none';
        welcome.style.display = 'flex';
    }

    // App本体（07_WebApp.gs / App.html）から届く ready ハンドシェイクを受信。
    // これが届けば、iframe内にアプリ本体が正しく表示できたと判断できる。
    // 組織アカウント等でGoogleのエラー画面が表示された場合は届かない。
    window.addEventListener('message', function (e) {
        var data = e && e.data;
        if (!data) return;
        if (data.type === 'schoolPlanNote:ready') {
            appReady = true;
            // このブラウザで表示できたことを記録し、次回以降は初回ログイン案内を出さない。
            everReady = true;
            try { localStorage.setItem(EVER_READY_KEY, '1'); } catch (e2) { }
            // アプリ本体へ「PWAシェル内で動作している」ことを伝える。
            // これを受けた App 側は、再読み込み時に location.reload()（GASサンドボックス内では
            // 白画面化する）ではなく、シェルへ reload を依頼できるようになる。
            try {
                if (e.source) e.source.postMessage({ type: 'schoolPlanNote:shellAck' }, '*');
            } catch (e2) { }
            showFrame();
        } else if (data.type === 'schoolPlanNote:reload') {
            // アプリ本体からの再読み込み依頼。iframe を貼り直すことで、
            // GASサンドボックス内 location.reload() による白画面化を回避する。
            if (currentUrl) launchApp(currentUrl);
        }
    });

    function launchApp(url) {
        currentUrl = url;
        appReady = false;
        setup.style.display = 'none';
        recovery.style.display = 'none';
        welcome.style.display = 'none';
        frame.style.display = 'none';
        menuBtn.style.display = 'none';
        loading.style.display = 'flex';
        document.getElementById('newTabLink').href = url;
        document.getElementById('recoveryNewTabBtn').href = url;
        frame.src = url;
        // 一定時間内に ready ハンドシェイクが来なければ、iframe内に表示できなかったとみなし案内へ切り替える。
        // - 初回（everReady=false）: 未ログインの可能性が高いので、早めに親切なログイン案内へ。
        // - 再訪（everReady=true）: 通常は即表示できるため、コールドスタート等の誤発火を避けて長めに待ち、
        //   それでも来なければ（組織アカウントのiframeブロック等）復旧案内へ。
        if (launchTimer) clearTimeout(launchTimer);
        launchTimer = setTimeout(function () {
            launchTimer = null;
            if (appReady) return;
            if (everReady) showRecovery();
            else showWelcome();
        }, everReady ? LAUNCH_TIMEOUT_MS : FIRST_RUN_HINT_MS);
    }

    // --- セットアップ画面 ---
    document.getElementById('saveBtn').addEventListener('click', function () {
        var url = document.getElementById('urlInput').value.trim();
        if (!isValidGasUrl(url)) {
            showSetup('URLの形式が正しくありません。https://script.google.com/macros/s/～/exec の形式で入力してください。');
            return;
        }
        try { localStorage.setItem(STORAGE_KEY, url); } catch (e) { }
        launchApp(url);
    });

    // --- フローティングメニュー ---
    menuBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        menuPanel.style.display = menuPanel.style.display === 'flex' ? 'none' : 'flex';
    });
    document.addEventListener('click', function () {
        menuPanel.style.display = 'none';
    });
    menuPanel.addEventListener('click', function (e) {
        e.stopPropagation();
    });
    document.getElementById('reloadBtn').addEventListener('click', function () {
        location.reload();
    });
    document.getElementById('changeUrlBtn').addEventListener('click', function () {
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) { }
        menuPanel.style.display = 'none';
        var current = getAppUrl();
        if (current) {
            // config.js で固定されている場合は変更できない旨を表示
            showSetup('接続先URLは config.js で固定されています。変更するには docs/config.js を編集してください。');
            document.getElementById('urlInput').value = current;
        } else {
            showSetup();
        }
    });

    // --- 表示できなかったときの案内（組織アカウント等）---
    // 「アプリを開く」：この画面ごと exec URL へ遷移する（トップレベル遷移なので
    // 組織アカウントでも第一者コンテキストでログイン・表示でき、404にならない）。
    document.getElementById('recoveryOpenBtn').addEventListener('click', function () {
        if (currentUrl) window.location.href = currentUrl;
    });
    // 「この画面のまま表示する」：万一 ready が届かなかっただけの正常表示に備えた保険。
    document.getElementById('recoveryShowBtn').addEventListener('click', function () {
        showFrame();
    });
    document.getElementById('recoveryReloadBtn').addEventListener('click', function () {
        location.reload();
    });

    // --- 初回起動時のログイン案内 ---
    // 「Googleでログインして始める」：新しいタブで exec URL を開く（トップレベル遷移なので
    // 組織アカウントでも第一者コンテキストでログイン・認可でき、iframe内の空白を回避できる）。
    // このタブは iframe を読み込んだまま残し、タブに戻ってきた時点で自動的に再試行する。
    document.getElementById('welcomeLoginBtn').addEventListener('click', function () {
        if (currentUrl) window.open(currentUrl, '_blank', 'noopener');
    });
    // 「ログインが済んだので開く」：iframe を貼り直して再表示を試みる。
    document.getElementById('welcomeContinueBtn').addEventListener('click', function () {
        if (currentUrl) launchApp(currentUrl);
    });
    // 「それでも表示されないとき」：従来の復旧案内（新しいタブで開く等）へ。
    document.getElementById('welcomeShowBtn').addEventListener('click', function () {
        showRecovery();
    });

    // ログイン用の別タブから戻ってきたら、まだ表示できていなければ自動で再試行する。
    // これにより「ログイン → タブに戻る → 自動で週案が表示される」という流れになる。
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' &&
            !appReady && welcome.style.display === 'flex' && currentUrl) {
            launchApp(currentUrl);
        }
    });

    // --- インストール導線 ---
    // Chrome/Edge 系: beforeinstallprompt イベントで表示されるネイティブのプロンプトを使う。
    // iOS/iPadOS の Safari: beforeinstallprompt が存在しないため、
    // 「共有 → ホーム画面に追加」の手順ガイド（#iosGuide）を表示して案内する。
    var iosGuide = document.getElementById('iosGuide');
    var iosBanner = document.getElementById('iosInstallBanner');
    // 案内バナーを一度閉じたら再表示しないためのキー
    var IOS_HINT_KEY = 'schoolPlanNote.iosInstallHintDismissed';

    // iPadOS 13以降の Safari は UA が Mac と同じになるため、
    // タッチ対応（maxTouchPoints）との組み合わせで iPad と判定する。
    var isIosDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    // すでにホーム画面から起動している（＝インストール済み）かどうか
    var isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
        window.navigator.standalone === true;

    function showIosGuide() {
        menuPanel.style.display = 'none';
        iosGuide.style.display = 'flex';
    }

    function dismissIosBanner() {
        iosBanner.style.display = 'none';
        try { localStorage.setItem(IOS_HINT_KEY, '1'); } catch (e) { }
    }

    // 合図は install-hook.js が <head> の先頭ですでに受け取っている。
    // ここではその結果を見るだけにする（このスクリプトが動く頃には
    // イベントが済んでいることがあり、ここで待つと取りこぼす）。
    function reflectInstallAvailability() {
        deferredPrompt = window.__pwaInstallPrompt;
        if (deferredPrompt) installBtn.style.display = 'block';
    }
    window.addEventListener('pwa-install-available', reflectInstallAvailability);
    reflectInstallAvailability();

    installBtn.addEventListener('click', function () {
        menuPanel.style.display = 'none';
        if (deferredPrompt) {
            deferredPrompt.prompt();
            deferredPrompt = null;
            window.__pwaInstallPrompt = null;
            installBtn.style.display = 'none';
            return;
        }
        if (isIosDevice) showIosGuide();
    });
    window.addEventListener('pwa-installed', function () {
        installBtn.style.display = 'none';
    });

    if (isIosDevice && !isStandalone) {
        // ログイン用タブを追加してしまう失敗を防ぐ注意書きを出す。
        var iosHints = document.querySelectorAll('.ios-only-hint');
        for (var i = 0; i < iosHints.length; i++) iosHints[i].style.display = 'block';
        // Safari では beforeinstallprompt が発火しないので、メニューに常時表示する
        installBtn.textContent = 'ホーム画面に追加（インストール）';
        installBtn.style.display = 'block';
        // 初回のみ、画面下部に案内バナーを表示する
        var hintDismissed = false;
        try { hintDismissed = localStorage.getItem(IOS_HINT_KEY) === '1'; } catch (e) { }
        if (!hintDismissed) iosBanner.style.display = 'flex';
    }

    document.getElementById('iosGuideCloseBtn').addEventListener('click', function () {
        iosGuide.style.display = 'none';
    });
    iosGuide.addEventListener('click', function (e) {
        if (e.target === iosGuide) iosGuide.style.display = 'none';
    });
    document.getElementById('iosBannerGuideBtn').addEventListener('click', function () {
        dismissIosBanner();
        showIosGuide();
    });
    document.getElementById('iosBannerCloseBtn').addEventListener('click', dismissIosBanner);

    // 紹介ページ（about.html）の「ホーム画面に追加」から渡されてきたとき。
    //
    // なぜ紹介ページで完結させないか：
    //   iOS Safari の「ホーム画面に追加」は *いま開いているページ* を登録する。
    //   紹介ページで追加させると、ホーム画面に載るのはアプリではなく
    //   紹介ページのブックマークになる。manifest と apple-touch-icon、
    //   apple-mobile-web-app-capable を持つこの入口ページで追加してもらう。
    if (/[?&]install=1(?:&|$)/.test(location.search)) {
        // ⚠️ 先に印を消すこと。付いたまま「ホーム画面に追加」されると、
        //    manifest を読まない古い iOS ではその URL がそのまま登録され、
        //    アプリを開くたびに案内が出続ける。
        try {
            history.replaceState(null, '', location.pathname + location.hash);
        } catch (e) { }
        if (!isStandalone) {
            if (isIosDevice) showIosGuide();
            else if (deferredPrompt) menuPanel.style.display = 'flex';
        }
    }

    // --- Service Worker 登録と、更新のお知らせ ---
    if ('serviceWorker' in navigator) {
        // ⚠️ load イベントを待つだけにすると、すでに読み込みが終わっている場合に
        //    リスナーが二度と呼ばれず、Service Worker が登録されないままになる。
        //    「もう済んでいるか」を必ず見る。
        var startSw = function () {
            navigator.serviceWorker.register('sw.js')
                .then(watchForUpdate)
                .catch(function (err) {
                    console.warn('Service Worker registration failed:', err);
                });
        };
        if (document.readyState === 'complete') startSw();
        else window.addEventListener('load', startSw, { once: true });
    }

    // 新しい版が待機したら、画面の下に知らせる。押されるまで切り替えない。
    // 先生が週案を入力している最中に勝手に入れ替わると、打ちかけの内容が消える。
    var userAskedUpdate = false;
    var reloadingForUpdate = false;

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('controllerchange', function () {
            // ⚠️ controllerchange は初回訪問でも飛んでくる（activate の clients.claim() のため）。
            //    そのまま受けると、初めて開いた人が必ず1回リロードされる。
            //    見るのは「利用者が押したかどうか」だけ。
            if (!userAskedUpdate || reloadingForUpdate) return;
            reloadingForUpdate = true;
            location.reload();
        });
    }

    function showUpdateToast(worker) {
        if (document.getElementById('updateToast')) return;
        var bar = document.createElement('div');
        bar.id = 'updateToast';
        bar.setAttribute('role', 'status');
        bar.className = 'no-print';
        bar.innerHTML = '<span>あたらしい版があります。</span>' +
            '<button type="button" id="updateApplyBtn">最新にする</button>' +
            '<button type="button" id="updateLaterBtn" aria-label="このお知らせを閉じる">あとで</button>';
        document.body.appendChild(bar);
        document.getElementById('updateApplyBtn').addEventListener('click', function () {
            userAskedUpdate = true;
            bar.remove();
            worker.postMessage({ type: 'SKIP_WAITING' });
        });
        document.getElementById('updateLaterBtn').addEventListener('click', function () {
            bar.remove();
        });
    }

    function watchForUpdate(registration) {
        if (!registration) return;
        registration.addEventListener('updatefound', function () {
            var sw = registration.installing;
            if (!sw) return;
            sw.addEventListener('statechange', function () {
                // controller が居る＝初回インストールではなく更新。
                // 初回で知らせると「入れた直後に更新があります」と出て混乱する。
                if (sw.state === 'installed' && navigator.serviceWorker.controller) {
                    showUpdateToast(sw);
                }
            });
        });
        // 前回の訪問中にすでに待機していた場合も拾う
        if (registration.waiting && navigator.serviceWorker.controller) {
            showUpdateToast(registration.waiting);
        }
    }

    // --- 起動 ---
    var appUrl = getAppUrl();
    if (appUrl) {
        launchApp(appUrl);
    } else {
        showSetup();
    }
})();
