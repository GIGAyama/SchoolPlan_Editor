/**
 * GIGA Standard v5 Part I（共通技術仕様）の静的検査。
 *
 * 共通の品質ゲート（scripts/lib/project-quality.mjs＝正本）とは分けてある。
 * 正本は他リポジトリと同じものを丸ごと差し替えで受けられるようにし、
 * Part I の検査だけをこちらに置く。
 *
 * ⚠️ ここに書けるのは「読めば分かること」だけである。
 *   コントラスト・タップ領域・Service Worker の実挙動・アイコンの合字は、
 *   実ブラウザで測らないと分からない（AUDIT.md 参照）。
 *   静的検査が 0 件でも「測った」ことにはならない。
 */
import fs from 'node:fs';
import path from 'node:path';

function normalizeRelative(filePath) {
  return filePath.split(path.sep).join('/');
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function issue(severity, code, message, file = null, line = null) {
  return { severity, code, message, file, line };
}

/**
 * コメントを落とす。
 * 「localStorage は操作しない」といった注意書きに検査が反応してしまうため
 * （実際に誤検知した）、判定はコメントを外してから行う。
 */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}


/**
 * `@supports not (height: 100dvh) { … }` のブロックを、中身ごと取り除く。
 * 対応する閉じ括弧まで数えて外す（正規表現では入れ子を追えない）。
 * 行番号がずれないよう、外した部分は改行だけ残す。
 */
export function stripDvhFallbackBlocks(source) {
  const opener = /@supports\s+not\s*\([^)]*dvh[^)]*\)\s*\{/g;
  let result = source;
  let match;
  while ((match = opener.exec(result)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < result.length && depth > 0) {
      if (result[i] === '{') depth++;
      else if (result[i] === '}') depth--;
      i++;
    }
    const removed = result.slice(match.index, i);
    result = result.slice(0, match.index) + removed.replace(/[^\n]/g, ' ') + result.slice(i);
    opener.lastIndex = i;
  }
  return result;
}

/** 学校のフィルタリングで塞がれると「起動しない」ものを配っている CDN */
const EXECUTABLE_CDN = /(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|cdn\.tailwindcss\.com|esm\.sh|skypack\.dev)/i;

/**
 * @param {string} rootDir
 * @param {string[]} files プロジェクト内の相対パス一覧
 * @param {object} options { repoName, allowedRemoteScripts, htmlEntry, gasEntry }
 */
export function runGigaV5Checks(rootDir, files, options = {}) {
  const {
    repoName = path.basename(rootDir),
    allowedRemoteScripts = [],
    docsDir = 'docs'
  } = options;

  const issues = [];
  const fileSet = new Set(files.map(normalizeRelative));
  const read = (file) => fs.readFileSync(path.join(rootDir, file), 'utf8');
  // Vendor_*.html は外部ライブラリを焼き込んだ生成物。
  // 中身は他人が書いた CSS/JS なので、表示の作法（dvh など）の検査対象にはしない。
  // ただし「CDN から読んでいないか」は、自分で書いたファイルの話なので別途見る。
  const isGenerated = (f) => /(^|\/)Vendor_[A-Za-z0-9_]+\.html$/.test(f);
  const htmlFiles = files.filter(f => f.toLowerCase().endsWith('.html') && !isGenerated(f));
  const gsFiles = files.filter(f => f.toLowerCase().endsWith('.gs'));
  const allowed = allowedRemoteScripts.map(s => new RegExp(s, 'i'));

  // ---- A. 法務・配布 ----
  for (const required of ['LICENSE', '.gitignore', '.github/dependabot.yml']) {
    if (!fileSet.has(required)) {
      issues.push(issue('error', 'GIGA_LEGAL_FILE_MISSING', `${required} がありません（Part II Phase 6）。`, required));
    }
  }

  // ---- B. 依存（起動しない事故を止める） ----
  for (const file of htmlFiles) {
    const source = read(file);
    const body = stripComments(source);

    if (/@babel\/standalone|babel\.min\.js/i.test(body)) {
      issues.push(issue('error', 'GIGA_BROWSER_BABEL',
        'ブラウザへ Babel を送っています。ビルド時に1回だけコンパイルしてください（§6）。', file));
    }
    if (/cdn\.tailwindcss\.com/i.test(body)) {
      issues.push(issue('error', 'GIGA_TAILWIND_CDN',
        'Tailwind をブラウザ内で生成しています。使うクラスだけの CSS を先に作ってください（§6）。', file));
    }

    // <script src> と <link rel=stylesheet> は、届かないと起動・表示が壊れる＝実行コード扱い
    const remotePattern = /<(script|link)\b[^>]*?(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = remotePattern.exec(body)) !== null) {
      const [tag, , url] = [match[1].toLowerCase(), match[2], match[2]];
      if (!/^https?:\/\//i.test(url)) continue;
      if (tag === 'link' && !/stylesheet/i.test(match[0])) continue;
      if (allowed.some(re => re.test(url))) continue;
      // Google Fonts は「字の形が変わるだけ」で動作に影響しないため対象外（§2-7）
      if (/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(url)) continue;
      if (EXECUTABLE_CDN.test(url)) {
        issues.push(issue('error', 'GIGA_CDN_EXECUTABLE',
          `外部CDNから実行コードを読んでいます（塞がれると起動しません）: ${url}`,
          file, lineNumberAt(body, match.index)));
      }
    }
  }

  // ---- C. 表示 ----
  const viewportTargets = [];
  for (const file of htmlFiles.concat(gsFiles)) {
    const source = read(file);
    if (/name=["']viewport["']|addMetaTag\(\s*['"]viewport['"]/.test(source)) viewportTargets.push([file, source]);
  }
  for (const [file, source] of viewportTargets) {
    const metas = [...source.matchAll(/(?:content\s*=\s*|addMetaTag\(\s*['"]viewport['"]\s*,\s*)['"]([^'"]*width=device-width[^'"]*)['"]/g)];
    for (const meta of metas) {
      const content = meta[1];
      if (!/viewport-fit\s*=\s*cover/.test(content)) {
        issues.push(issue('error', 'GIGA_VIEWPORT_FIT',
          'viewport に viewport-fit=cover がありません（GAS は code.gs 側にも要ります・§2-1）。',
          file, lineNumberAt(source, meta.index ?? 0)));
      }
      if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/.test(content)) {
        issues.push(issue('error', 'GIGA_NO_ZOOM',
          '拡大を禁止しています。見えづらい人が拡大できなくなります（§2-1）。',
          file, lineNumberAt(source, meta.index ?? 0)));
      }
    }
  }

  for (const file of htmlFiles.concat(files.filter(f => f.endsWith('.css')))) {
    const source = read(file);
    const body = stripComments(source);
    // @supports not (…dvh…) { … } の中の 100vh は、正しいフォールバックなので対象外。
    // 「近くに dvh があるか」で見分けようとすると、隣に書いた別の 100vh を見逃す（実際に見逃した）。
    // ブロックごと外してから探す。
    const withoutFallback = stripDvhFallbackBlocks(body);
    for (const match of withoutFallback.matchAll(/(?:height|min-height|max-height)\s*:\s*100vh/g)) {
      issues.push(issue('error', 'GIGA_VIEWPORT_100VH',
        '100vh を単独で使っています。dvh を使ってください（§2-2）。',
        file, lineNumberAt(withoutFallback, match.index ?? 0)));
    }
    // ふりがなの色の決め打ち（§4）。色のついた面の上で読めなくなる。
    for (const match of body.matchAll(/(^|[^-\w])rt\s*\{[^}]*color\s*:\s*(#[0-9a-f]{3,8}|rgb)/gim)) {
      issues.push(issue('error', 'GIGA_RT_COLOR',
        'rt（ふりがな）の色を決め打ちしています。色のついた面では継がせてください（§4）。',
        file, lineNumberAt(body, match.index ?? 0)));
    }
    // 中央寄せの決まり文句 left:50% + translateX(-50%) は、幅を決めないと文字を潰す（§2-6）
    //
    // position:fixed/absolute で width が auto のとき、使える幅は「包む枠 − left」で決まる。
    // left:50% だと画面の半分しか使えず、そこへ収めようとして日本語が
    // 1文字ずつ改行される。transform は見た目をずらすだけで、この計算には効かない。
    // 実際に「ホーム画面に追加」の案内が縦一列の帯になり、読めなくなっていた。
    // 見た目では気づきにくい（要素は出ているし、色も形も正しい）ので検査で押さえる。
    // left と right の両方を決めて margin:auto で寄せるか、width を決めれば直る。
    for (const match of withoutFallback.matchAll(/\{[^{}]*\}/g)) {
      const block = match[0];
      if (!/position\s*:\s*(fixed|absolute)/.test(block)) continue;
      if (!/(?:^|[;{\s])left\s*:\s*50%/.test(block)) continue;
      if (!/transform\s*:[^;]*translateX\(\s*-\s*50%/.test(block)) continue;
      // width か right が決まっていれば潰れない（max-width は幅を決めないので除く）
      if (/(?:^|[;{\s])(?:width|inline-size|right)\s*:/.test(block)) continue;
      issues.push(issue('error', 'GIGA_FIXED_CENTER_SQUEEZE',
        'position:fixed/absolute を left:50% + translateX(-50%) で中央に置きながら、幅を決めていません。'
        + '使える幅が画面の半分になり、文章が1文字ずつ改行されます。'
        + 'left と right の両方を決めて margin:auto で寄せてください（§2-6）。',
        file, lineNumberAt(withoutFallback, match.index ?? 0)));
    }
    // prefers-reduced-motion で 0 にすると fill-mode: forwards が壊れ、中身が消える
    for (const match of body.matchAll(/prefers-reduced-motion[\s\S]{0,400}?animation-duration\s*:\s*0m?s/g)) {
      issues.push(issue('error', 'GIGA_REDUCED_MOTION_ZERO',
        'animation-duration を 0 にすると fill-mode: forwards が壊れ、要素が消えます。.01ms にしてください（§2-10）。',
        file, lineNumberAt(body, match.index ?? 0)));
    }
  }

  // ---- D. PWA ----
  const swFiles = files.filter(f => /(^|\/)sw\.js$/.test(f));
  for (const file of swFiles) {
    const source = read(file);
    const body = stripComments(source);

    // 「消す式」を正規表現で追うと (k) => caches.delete(k) を見落とす。
    // 見るべきは「startsWith などで自アプリ分に絞っているか」。
    if (/caches\.keys\s*\(/.test(body) && !/startsWith\s*\(/.test(body)) {
      issues.push(issue('error', 'GIGA_SW_CACHE_WIPE',
        'caches.keys() を自アプリの接頭辞で絞っていません。同居する他アプリのキャッシュまで消えます（§3-3）。', file));
    }
    if (/localStorage/.test(body)) {
      issues.push(issue('error', 'GIGA_SW_LOCALSTORAGE',
        'Service Worker は localStorage を操作しません（§3-3）。', file));
    }
    const install = body.match(/addEventListener\s*\(\s*['"]install['"][\s\S]{0,1200}?\n\}\s*\)\s*;/);
    if (install && /skipWaiting/.test(install[0])) {
      issues.push(issue('error', 'GIGA_SW_SKIP_WAITING',
        'install の中で skipWaiting しています。入力中に画面が入れ替わります（§3-3）。', file));
    }
    // 版が自動生成のままか。
    // 手書きの版は「上げるのは人の仕事」で、上げ忘れても検査は何も言えない。
    // 2026-08-21 に12リポジトリで同時に上げ忘れる事故が起きたのがその形。
    // 上げ忘れると古いシェルのキャッシュが掃除されず、直した内容が
    // 先生の端末に届かないまま「直したはずなのに直らない」が続く。
    // ⚠️ body ではなく source を見る。目印はコメントなので stripComments に消される
    if (!/const APP_VERSION = '[^']*'; \/\* __APP_VERSION__ \*\//.test(source)) {
      issues.push(issue('error', 'GIGA_SW_VERSION_GENERATED',
        "SW の版が手書きに戻っています。const APP_VERSION = 'v0'; /* __APP_VERSION__ */ の形にして、"
        + '版は tools/build-sw.mjs に作らせてください（§3-3）。', file));
    } else if (!fileSet.has('tools/build-sw.mjs')) {
      // ⚠️ fs を直に見ない。この検査器は渡されたファイル一覧で判断する作りで、
      //    実ファイルを見ると合成の木でテストできなくなる
      issues.push(issue('error', 'GIGA_SW_VERSION_GENERATED',
        'tools/build-sw.mjs がありません。版の自動生成が外れています（§3-3）。', file));
    }

    if (!/message[\s\S]{0,200}SKIP_WAITING/.test(body)) {
      issues.push(issue('warning', 'GIGA_SW_NO_UPDATE_CHANNEL',
        '更新を利用者の操作で切り替える口（SKIP_WAITING メッセージ）がありません（§3-3）。', file));
    }
    const dir = path.posix.dirname(file);
    if (!fileSet.has(path.posix.join(dir, 'offline.html'))) {
      issues.push(issue('error', 'GIGA_OFFLINE_HTML_MISSING',
        '圏外のときに出す offline.html がありません（§3-4）。', file));
    }
  }

  const manifestFile = files.find(f => f.endsWith('manifest.webmanifest'));
  if (manifestFile) {
    try {
      const manifest = JSON.parse(read(manifestFile));
      // 正しい値は「どこで配信するか」で変わる。
      //
      // 独自ドメイン（CNAME あり）だと、アプリはサブドメインの直下に置かれる。
      //   https://schoolplan-editor.giga-school.com/
      // ここで scope を /SchoolPlan_Editor/ のままにすると、scope がページの URL を
      // 含まなくなり、manifest ごと無視されて **PWA としてインストールできなくなる**。
      //
      // CNAME が無ければ従来どおり共有オリジンのサブディレクトリ配信なので、
      //   https://（ID）.github.io/SchoolPlan_Editor/
      // リポジトリ名の絶対パスでないと、同居する別アプリと取り違えられる。
      //
      // 相対パス（'./'）はどちらの配信でも正しく解決されるため、常に許容する。
      const manifestDir = path.posix.dirname(manifestFile);
      const hasCname = fileSet.has(path.posix.join(manifestDir, 'CNAME'));
      const expected = hasCname ? "相対パス（'./'）かサブドメイン直下（'/'）" : `リポジトリ名の絶対パス（/${repoName}/）`;
      for (const key of ['id', 'scope', 'start_url']) {
        const value = manifest[key];
        const ok = typeof value === 'string' && (
          value.startsWith('./')
          || (hasCname ? /^\/(\?|#|$)/.test(value) : value.startsWith('/') && value.includes(repoName))
        );
        if (!ok) {
          issues.push(issue('error', 'GIGA_MANIFEST_PATH',
            `manifest の ${key} は ${expected} にしてください。` +
            (hasCname
              ? 'CNAME があるためアプリはサブドメイン直下で配信されます。'
              + 'リポジトリ名の絶対パスだと scope がページの URL を含まず、インストールできません（§3-1）。'
              : '同一オリジンに複数アプリが同居しているため、別アプリと取り違えられます（§3-1）。'),
            manifestFile));
        }
      }
    } catch (error) {
      issues.push(issue('error', 'GIGA_MANIFEST_JSON', String(error), manifestFile));
    }
  }

  // 独自ドメインの CNAME（§3-1）
  //
  // ⚠️ BOM を必ず見ること。Windows のメモ帳や PowerShell の `>` リダイレクトで書くと
  //    先頭に U+FEFF が入る。目では見えないのに GitHub Pages はドメイン名の一部として
  //    読むため、ホスト名として不正になり **カスタムドメインが有効にならない**。
  //    DNS も Pages の設定も正しいのに「なぜか繋がらない」という、いちばん探しにくい壊れ方をする。
  //    実際にこれで全リポジトリのカスタムドメインが止まった。
  for (const cnameFile of files.filter(f => /(^|\/)CNAME$/.test(f))) {
    const raw = read(cnameFile);
    if (raw.charCodeAt(0) === 0xFEFF) {
      issues.push(issue('error', 'GIGA_CNAME_BOM',
        'CNAME の先頭に BOM が入っています。目に見えませんが、GitHub Pages はこれをドメイン名の一部として読むため、'
        + 'カスタムドメインが有効になりません。BOM なし UTF-8 で保存し直してください（§3-1）。', cnameFile));
      continue;
    }
    // CNAME に書けるのは 1 行・1 ホスト名だけ。空行やコメントも置けない。
    const lines = raw.split('\n').filter(line => line.trim() !== '');
    if (lines.length !== 1) {
      issues.push(issue('error', 'GIGA_CNAME_FORMAT',
        `CNAME に書けるのはドメイン名 1 行だけです（${lines.length} 行あります・§3-1）。`, cnameFile));
      continue;
    }
    const host = lines[0].trim();
    if (!/^(?!-)[a-z0-9-]+(\.(?!-)[a-z0-9-]+)+$/.test(host)) {
      issues.push(issue('error', 'GIGA_CNAME_FORMAT',
        `CNAME の「${host}」はホスト名として正しくありません。`
        + 'スキーム（https://）・末尾のスラッシュ・大文字・空白は入れられません（§3-1）。', cnameFile));
    }
  }

  // beforeinstallprompt は <head> の先頭・外部ファイルで受ける（§3-2）
  const shellIndex = path.posix.join(docsDir, 'index.html');
  if (fileSet.has(shellIndex)) {
    const source = read(shellIndex);
    const inlineScripts = [...source.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    // ⚠️ 「beforeinstallprompt が無い Safari では…」という注意書きに反応してしまうため、
    //    コメントを落としたうえで、実際に登録している箇所だけを見る。
    if (inlineScripts.some(m => /addEventListener\s*\(\s*['"]beforeinstallprompt['"]/.test(stripComments(m[1])))) {
      issues.push(issue('error', 'GIGA_INSTALL_HOOK_INLINE',
        'beforeinstallprompt をインラインで受けています。<head> 先頭の外部ファイルにしてください（§3-2）。', shellIndex));
    }
    if (!/<script[^>]+src=["'][^"']*install-hook\.js["']/.test(source)) {
      issues.push(issue('error', 'GIGA_INSTALL_HOOK_MISSING',
        'install-hook.js を <head> の先頭で読み込んでいません。合図を取りこぼします（§3-2）。', shellIndex));
    }
    // Service Worker の登録は「もう load が済んでいる」場合を見ないと、黙って登録されない
    if (/serviceWorker\.register/.test(source) && !/readyState/.test(source)) {
      issues.push(issue('error', 'GIGA_SW_REGISTER_READYSTATE',
        'Service Worker の登録に readyState の分岐がありません。load 済みだと登録されません（§3-6）。', shellIndex));
    }
    // 画像はガタつき（CLS）を防ぐため width/height を書く
    for (const match of source.matchAll(/<img\b[^>]*>/gi)) {
      if (!/\bwidth=/.test(match[0]) || !/\bheight=/.test(match[0])) {
        issues.push(issue('warning', 'GIGA_IMG_SIZE',
          '<img> に width/height がありません（読み込み中に画面がガタつきます・§2-6）。',
          shellIndex, lineNumberAt(source, match.index ?? 0)));
      }
    }
  }

  // 公開ページ（紹介ページ）にもインストールの導線を残す（§3-2）
  //
  // ポータルや OAuth の「アプリのホームページ」欄からの入口が、アプリ本体
  // （index.html）ではなく紹介ページ（about.html）になった。先生が最初に開くのが
  // このページなのに manifest が無いと、iOS Safari の「ホーム画面に追加」は
  // *紹介ページのブックマーク* を作る。アイコンはページの縮小画像、開いても
  // Safari の中の紹介ページで、アプリにはならない。Chromium 系でも manifest が
  // 無ければ beforeinstallprompt が出ないため、インストールの導線がまるごと消える。
  // 公開ページを差し替えるたびに同じ事故が起きるので、検査で押さえる。
  const landingPage = path.posix.join(docsDir, 'about.html');
  if (fileSet.has(landingPage)) {
    // コメントは落として見る。「なぜ書かないか」の注意書きに反応してしまうし、
    // コメントアウトされた <link> を「ある」と数えてもいけない。
    const source = stripComments(read(landingPage));
    if (!/<link\b[^>]*rel\s*=\s*["']manifest["']/i.test(source)) {
      issues.push(issue('error', 'GIGA_LANDING_NO_MANIFEST',
        '公開ページ（紹介ページ）に manifest がありません。iOS Safari の「ホーム画面に追加」が'
        + 'アプリではなくこのページのブックマークを作ります（§3-2）。', landingPage));
    }
    if (!/<script[^>]+src=["'][^"']*install-hook\.js["']/.test(source)) {
      issues.push(issue('error', 'GIGA_LANDING_NO_INSTALL_HOOK',
        '公開ページ（紹介ページ）が install-hook.js を読み込んでいません。'
        + 'Chromium 系のインストールの合図を取りこぼします（§3-2）。', landingPage));
    }
    if (!/rel\s*=\s*["']apple-touch-icon["']/i.test(source)) {
      issues.push(issue('warning', 'GIGA_LANDING_NO_APPLE_ICON',
        '公開ページ（紹介ページ）に apple-touch-icon がありません。'
        + 'iOS でホーム画面に載るアイコンがページの縮小画像になります（§3-2）。', landingPage));
    }
    // apple-mobile-web-app-capable は、manifest を読まない古い iOS では
    // 「いま開いているページを枠なしで開く」指定になる。紹介ページに書くと、
    // ホーム画面のアイコンが紹介ページの行き止まりになる。
    if (/name\s*=\s*["']apple-mobile-web-app-capable["']/i.test(source)) {
      issues.push(issue('error', 'GIGA_LANDING_STANDALONE_META',
        '公開ページ（紹介ページ）に apple-mobile-web-app-capable があります。'
        + '古い iOS では紹介ページ自体が枠なしで開く行き止まりになります。'
        + 'アプリの入口（index.html）へ案内してください（§3-2）。', landingPage));
    }
  }

  return issues;
}
