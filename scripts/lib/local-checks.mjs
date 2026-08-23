/**
 * このリポジトリだけの検査。
 *
 * 共通の検査は正本（GIGAyama.github.io/standards/lib/giga-v5-checks.mjs）が
 * 受け持つ。ここに残すのは、正本に対応するものが無いものだけである。
 *
 * 移行のとき（2026-08-23）にフォーク32件を正本38件へ1つずつ突き合わせた。
 * 名前が変わっただけのものと、正本で1つにまとまったものを除くと、
 * 行き先が無いのは下の7件だった。
 *
 * このリポジトリは GitHub Pages を docs/ から配る。公開されるページが2枚ある:
 *   docs/index.html … アプリの入口（PWA のシェル。GAS 本体を iframe で開く）
 *   docs/about.html … 紹介ページ
 * 正本は入口1枚を見る作りなので、紹介ページの検査はここに残す。
 *
 * ⚠️ 検査そのものが壊れていないかは check-project.mjs --self-test が確かめる。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (root, rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null);
/** HTML コメントを落とす。注意書きの語に反応させないため */
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ');

/**
 * 見る HTML の一覧。
 * GAS 本体（App*.html。CSS も .html に入っている）と、配る docs/ の両方。
 * Vendor_*.html は取り込んだ配布物なので外す（直せないものを咎めても仕方がない）。
 */
const htmlFiles = (root) => {
  const at = (dir) => {
    const abs = dir ? join(root, dir) : root;
    if (!existsSync(abs)) return [];
    return readdirSync(abs)
      .filter((f) => f.endsWith('.html') && !f.startsWith('Vendor_'))
      .map((f) => (dir ? `${dir}/${f}` : f));
  };
  return [...at(''), ...at('docs')];
};

export function runLocalChecks(root) {
  const out = [];
  const add = (id, ok, detail, severity = 'P1') => out.push({ id, ok, detail, severity });

  // 正本の E_SW_* はどれも sw.js の中身を読むので、無ければそちらも落ちる。
  // ただし「なぜ落ちたか」が読み取りにくいので、在ることを名指しで見る。
  const hasSw = existsSync(join(root, 'docs/sw.js'));
  add('E_SW_EXISTS', hasSw, hasSw ? 'docs/sw.js' : 'docs/sw.js が無い');

  // 正本の E_INSTALL_HOOK は「入口で読み込んでいるか」を見る。実体の有無は見ない。
  const hasHook = existsSync(join(root, 'docs/install-hook.js'));
  add('E3_INSTALL_HOOK_FILE', hasHook, hasHook ? '' : 'docs/install-hook.js が無い');

  const shell = read(root, 'docs/index.html');
  if (shell) {
    // beforeinstallprompt をインラインで受けると、CSP を締めたときに動かなくなる。
    // ⚠️ 「beforeinstallprompt が無い Safari では…」という注意書きに反応しないよう、
    //    コメントを落としてから、実際に登録している箇所だけを見る。
    const inline = [...shell.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    const inlineHook = inline.some((m) => /addEventListener\s*\(\s*['"]beforeinstallprompt['"]/.test(m[1]));
    add('INSTALL_HOOK_INLINE', !inlineHook,
      inlineHook ? 'beforeinstallprompt をインラインで受けています。<head> 先頭の外部ファイルにしてください（§3-2）' : '');
  }

  // position:fixed/absolute を left:50% + translateX(-50%) で中央に置きながら
  // 幅を決めていないと、使える幅が画面の半分になり、文章が1文字ずつ改行される。
  // 実際に「ホーム画面に追加」の案内が縦一列の帯になり、読めなくなった。
  // 見た目では気づきにくい（要素は出ているし、色も形も正しい）ので検査で押さえる。
  {
    const squeezed = [];
    for (const rel of htmlFiles(root)) {
      const src = read(root, rel);
      if (!src) continue;
      for (const m of stripHtmlComments(src).matchAll(/\{[^{}]*\}/g)) {
        const block = m[0];
        if (!/position\s*:\s*(fixed|absolute)/.test(block)) continue;
        if (!/(?:^|[;{\s])left\s*:\s*50%/.test(block)) continue;
        if (!/transform\s*:[^;]*translateX\(\s*-\s*50%/.test(block)) continue;
        // width か right が決まっていれば潰れない（max-width は幅を決めないので除く）
        if (/(?:^|[;{\s])(?:width|inline-size|right)\s*:/.test(block)) continue;
        squeezed.push(rel);
      }
    }
    add('FIXED_CENTER_SQUEEZE', squeezed.length === 0,
      squeezed.length === 0 ? '' : `幅を決めずに中央寄せしている規則があります: ${[...new Set(squeezed)].join(', ')}`);
  }

  // 紹介ページ（about.html）。ポータルや OAuth の「アプリのホームページ」欄から
  // 先生が最初に開くのはこのページなので、ここを取りちがえると導線が丸ごと消える。
  const about = read(root, 'docs/about.html');
  if (about) {
    const src = stripHtmlComments(about);
    const hasManifest = /<link\b[^>]*rel\s*=\s*["']manifest["']/i.test(src);
    add('LANDING_MANIFEST', hasManifest,
      hasManifest ? '' : '紹介ページに manifest がありません。iOS の「ホーム画面に追加」がアプリではなくこのページのブックマークを作ります（§3-2）');

    const hasHookTag = /<script[^>]+src=["'][^"']*install-hook\.js["']/.test(src);
    add('LANDING_INSTALL_HOOK', hasHookTag,
      hasHookTag ? '' : '紹介ページが install-hook.js を読み込んでいません。インストールの合図を取りこぼします（§3-2）');

    const hasAppleIcon = /rel\s*=\s*["']apple-touch-icon["']/i.test(src);
    add('LANDING_APPLE_ICON', hasAppleIcon,
      hasAppleIcon ? '' : '紹介ページに apple-touch-icon がありません。iOS のアイコンがページの縮小画像になります（§3-2）', 'P2');

    // apple-mobile-web-app-capable は、manifest を読まない古い iOS では
    // 「いま開いているページを枠なしで開く」指定になる。紹介ページに書くと、
    // ホーム画面のアイコンが紹介ページの行き止まりになる。
    const standalone = /name\s*=\s*["']apple-mobile-web-app-capable["']/i.test(src);
    add('LANDING_STANDALONE_META', !standalone,
      standalone ? '紹介ページに apple-mobile-web-app-capable があります。古い iOS では紹介ページ自体が枠なしで開く行き止まりになります（§3-2）' : '');
  }

  return out;
}
