import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 週案印刷の「用紙に合わせた文字サイズの自動調整」の約束を固定する。
//
// 印刷は非表示 iframe の中で実測してから window.print() する仕組みで、
// 実測部分は本物のブラウザレイアウトが要るため Node では再現できない。
// そこで「どの倍率を選ぶか」の判断だけを純粋関数 pickFitScale_ に切り出してあり、
// ここでは測定関数を差し替えてその判断を検証する。
// 残り（UIとページ側の印付け）は静的検査で固定する。

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const print = read('App_Js_03_Print.html');

/**
 * HTML内JSから関数1つ分を、波括弧の対応を数えて切り出す。
 * このファイルの対象は本文に文字列リテラルの波括弧を含まないので、単純な数え上げで足りる。
 */
function extractFn(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`function ${name} is unbalanced`);
}

const pickFitScale_ = new Function(`${extractFn(print, 'pickFitScale_')}\nreturn pickFitScale_;`)();

const AVAIL = 1000;
// 幅が変わっても高さが変わらない測定（素直なモデル）
const flat = h => () => h;

// ===== 倍率の選び方 =====

test('ちょうど収まる分量なら等倍のまま', () => {
  const s = pickFitScale_(flat(AVAIL), AVAIL, 0.2, 2);
  assert.ok(s > 0.99 && s <= 1, `等倍付近になるはず: ${s}`);
});

test('倍の分量なら半分に縮める', () => {
  const s = pickFitScale_(flat(AVAIL * 2), AVAIL, 0.2, 2);
  assert.ok(Math.abs(s - 0.5) < 0.01, `0.5 付近になるはず: ${s}`);
});

test('分量が少ない週は上限まで拡大する', () => {
  // 上限が無いと、予定の少ない週で文字だけが極端に大きくなる
  const s = pickFitScale_(flat(AVAIL / 4), AVAIL, 0.2, 2);
  assert.equal(s, 2);
});

test('拡大を許さないページ（上限1）は、余っていても等倍のまま', () => {
  // 標準2ページ目はフリースペースが余りを引き受けるので拡大させない
  const s = pickFitScale_(flat(AVAIL / 4), AVAIL, 0.2, 1);
  assert.equal(s, 1);
});

test('幅が狭まると高くなる実際のレイアウトでも、選んだ倍率で必ず収まる', () => {
  // 拡大＝レイアウト幅が狭まる＝折り返しが増えて高くなる。
  // この効き方を無視して割り算一発で倍率を出すと、収まらない倍率を選んでしまう。
  for (const grow of [0.1, 0.25, 0.5]) {
    for (const base of [400, 900, 1200, 2500]) {
      const measure = s => base * (1 + grow * (s - 1));
      const s = pickFitScale_(measure, AVAIL, 0.2, 2);
      assert.ok(measure(s) * s <= AVAIL + 1e-6,
        `はみ出す倍率を選んでいる: base=${base} grow=${grow} s=${s}`);
    }
  }
});

test('収まる範囲では、用紙をほぼ使い切るところまで攻める', () => {
  // 「縮めすぎて紙の下が大きく余る」という以前の出方に戻らないことの歯止め
  for (const base of [400, 900, 1200, 2500]) {
    const measure = s => base * (1 + 0.25 * (s - 1));
    const s = pickFitScale_(measure, AVAIL, 0.2, 2);
    if (s < 2) {
      assert.ok(measure(s) * s >= AVAIL * 0.99,
        `用紙が余りすぎている: base=${base} s=${s} 実効高さ=${measure(s) * s}`);
    }
  }
});

test('下限でも収まらないほど詰まっている週は、下限で妥協する', () => {
  const s = pickFitScale_(flat(AVAIL * 100), AVAIL, 0.2, 2);
  assert.equal(s, 0.2);
});

test('測定できないときは等倍にして素通しする', () => {
  // 測定失敗でページが消えるより、そのまま印刷されるほうがまし
  assert.equal(pickFitScale_(flat(500), 0, 0.2, 2), 1, '印刷領域の高さが0');
  assert.equal(pickFitScale_(flat(0), AVAIL, 0.2, 2), 1, '高さ0が返る');
  assert.equal(pickFitScale_(flat(NaN), AVAIL, 0.2, 2), 1, '高さがNaN');
  // 上限では測れて下限で測れなくなる場合も、下限まで縮めずに素通しする
  const flaky = s => (s > 1 ? AVAIL * 2 : NaN);
  assert.equal(pickFitScale_(flaky, AVAIL, 0.2, 2), 1, '途中から測定不能');
});

// ===== 中身の実際の下端を測る =====

const contentBottomPx_ = new Function(`${extractFn(print, 'contentBottomPx_')}\nreturn contentBottomPx_;`)();

/** getBoundingClientRect を持つ最小限の偽DOM。top を 0 に固定して読みやすくする。 */
function fakeEl(scrollHeight, childBottoms, opts) {
  opts = opts || {};
  return {
    scrollHeight,
    getBoundingClientRect: () => ({ top: opts.top || 0, bottom: (opts.top || 0) + scrollHeight }),
    querySelectorAll: opts.noQuery ? undefined : () => childBottoms.map(b =>
      typeof b === 'object' ? b : ({ getBoundingClientRect: () => ({ top: 0, bottom: b, width: 10, height: 5 }) })),
  };
}

test('overflow:hidden で隠れて scrollHeight に出ない溢れを、子孫の実座標で拾う', () => {
  // これが今回の本丸。.page2-right などの内側で溢れると scrollHeight は増えないので、
  // scrollHeight だけを信じると「収まっている」と誤判定して縮小しそこなう
  assert.equal(contentBottomPx_(fakeEl(1000, [400, 1200, 900])), 1200);
});

test('どの子もはみ出していなければ scrollHeight を返す', () => {
  assert.equal(contentBottomPx_(fakeEl(1000, [400, 900])), 1000);
});

test('要素の上端を原点にした値を返す（ページ内の位置に依らない）', () => {
  assert.equal(contentBottomPx_(fakeEl(1000, [{ getBoundingClientRect: () => ({ top: 50, bottom: 1250, width: 10, height: 5 }) }], { top: 50 })), 1200);
});

test('大きさ0の要素は下端の判定に使わない', () => {
  // 非表示要素は 0 の矩形を返す。これを拾うと原点まわりの値に引きずられる
  const hidden = { getBoundingClientRect: () => ({ top: 0, bottom: 5000, width: 0, height: 0 }) };
  assert.equal(contentBottomPx_(fakeEl(1000, [hidden, 900])), 1000);
});

test('変換が掛かった状態では、倍率を渡して単位を揃える', () => {
  // getBoundingClientRect は変換後、scrollHeight は変換前の値。
  // 揃えないと縮小時に scrollHeight 側が過大に効いて、必要以上に縮めてしまう
  assert.equal(contentBottomPx_(fakeEl(1000, [400]), 0.5), 500);
  assert.equal(contentBottomPx_(fakeEl(1000, [1200]), 0.5), 1200, '子の実座標のほうが下ならそちら');
});

test('測れないときも壊れず、scrollHeight で代替する', () => {
  assert.equal(contentBottomPx_(null), 0);
  assert.equal(contentBottomPx_(fakeEl(800, [], { noQuery: true })), 800);
  const throws = {
    scrollHeight: 700,
    getBoundingClientRect: () => { throw new Error('detached'); },
    querySelectorAll: () => [],
  };
  assert.equal(contentBottomPx_(throws), 700);
  assert.equal(contentBottomPx_(throws, 0.5), 350);
});

// ===== 用紙からはみ出させない仕掛け =====

test('紙の下端ぎりぎりではなく、安全余白の内側に収める', () => {
  // 測ったレイアウトと刷られるレイアウトはずれる。ぴったり100%を狙うと
  // その差の分だけ最下段（時数表の下の行・検印欄）が黙って切り落とされる
  assert.match(print, /var AUTOFIT_SAFETY_MM = 2;/);
  assert.match(print, /var target = Math\.max\(avail - safety/);
  assert.match(print, /pickFitScale_\(measureAt, target,/, '目標高さに安全余白が効いていない');
});

test('スマホ・タブレットでは安全余白を広く取る', () => {
  // 実機の PDF で実測したところ、スマホでは印刷のラスタライズ段でレイアウトが
  // DOM より約2%高くなる（DOM が 1033.4px と申告したページの文字が 1055.3px まで
  // 描かれていた）。アプリからは検知できないので余白で吸収するしかない。
  // 2mm(0.72%) では足りず、時数表の行と検印欄が切り落とされる
  assert.match(print, /var AUTOFIT_SAFETY_MM_MOBILE = 8;/);
  assert.match(print, /isMobilePrint \? AUTOFIT_SAFETY_MM_MOBILE : AUTOFIT_SAFETY_MM/,
    '端末で余白を切り替えていない');
});

test('Chromebook・PC は余白を広げない', () => {
  // userAgentData.mobile は Chromium が持つ真偽値で、Chromebook は false。
  // ここを画面幅やタッチの有無で判定すると、タッチ対応 Chromebook まで巻きこんで
  // 紙を無駄にする
  const body = extractFn(print, 'printWeeklyPlanExec');
  assert.match(body, /navigator\.userAgentData/);
  assert.match(body, /typeof uad\.mobile === 'boolean'/);
  assert.match(body, /Android\|iPhone\|iPad\|iPod\|Mobile/, 'userAgentData 非対応時の判定が無い');
  assert.doesNotMatch(body, /innerWidth|matchMedia|ontouchstart/,
    '画面幅やタッチの有無で判定すると Chromebook を巻きこむ');
});

test('高さの測定は contentBottomPx_ に一本化されている', () => {
  const body = extractFn(print, 'printWeeklyPlanExec');
  assert.match(body, /return contentBottomPx_\(fit\);/, 'measureAt が実際の下端を見ていない');
  assert.doesNotMatch(body, /return el\.scrollHeight;/,
    'scrollHeight だけを見る測定が残っている（内側で隠れた溢れを見落とす）');
});

test('高さが測れないページには手を出さない', () => {
  // 目標が 0 になると、検算が「まだ溢れている」と判断してページを極端に縮めてしまう
  const body = extractFn(print, 'printWeeklyPlanExec');
  assert.match(body, /if \(!\(avail > 0\)\) continue;/);
});

test('倍率を当てたあとに実測で検算し、まだ溢れていれば縮め直す', () => {
  // measureAt の読みが外れても、最後はここで必ず収まる側に寄せる
  const body = extractFn(print, 'printWeeklyPlanExec');
  assert.match(body, /var actual = contentBottomPx_\(fit, scale\);/, '当てた状態で測り直していない');
  assert.match(body, /scale = scale \* \(target \/ actual\)/, '溢れた分だけ縮め直していない');
});

// ===== フォントが効いてから測る =====

test('印刷は書体を外へ取りにいかない', () => {
  // 学校のフィルタが「握ったまま返さない」形で塞ぐと、外部スタイルシートの読み込みが
  // 終わらず印刷プレビューが開かないまま止まる。書体は自己ホストのものを流し込む
  assert.doesNotMatch(print, /fonts\.googleapis\.com/,
    '印刷モジュールが外部から書体を取りにいっている');
  assert.doesNotMatch(print, /@import url\(/, '印刷CSSに @import が残っている');
  assert.match(print, /window\.getSelfHostedFontCss/, '自己ホストの書体CSSを流し込んでいない');
});

test('書体を名指しで読み込んでから測る。読めない環境でも印刷は止めない', () => {
  // @font-face が文書にあっても、実際に使われるまで読み込みは始まらない。
  // fonts.ready だけに任せると「待つものが無い」として即座に解決し、代替書体のまま測ってしまう
  const body = extractFn(print, 'printWeeklyPlanExec');
  assert.match(body, /fdocReady\.fonts\.load\(/, 'fonts.load で名指しの要求をしていない');
  assert.match(body, /\.catch\(function \(\) \{ \/\* 読めなくても代替書体で進む \*\/ \}\)/,
    '書体が読めないときに進めない');
  assert.match(body, /setTimeout\(doPrint, 1500\)/, 'フォント待ちが解決しない環境向けの保険が無い');
});

test('印刷直前にもう一度合わせ直す', () => {
  // 測ったあとにフォントが効いてレイアウトが変わっても、刷られる直前の状態で収め直せる
  const body = extractFn(print, 'printWeeklyPlanExec');
  assert.match(body, /onbeforeprint = function \(\) \{[\s\S]*?fitPagesToPrintArea\(\)/);
});

// ===== 測るときと刷るときでレイアウトを揃える =====

test('印刷文書は文字の自動拡大を切る', () => {
  // スマホの Chrome は viewport 指定の無い文書の文字を自動拡大する。拡大率は
  // レンダリング面の幅で決まるので、画面外 iframe で測ったときと実際に刷るときで
  // 別の倍率が掛かり、印刷時だけ行が伸びて時数表や検印欄が下から押し出される
  assert.match(print, /text-size-adjust: 100%/);
  assert.match(print, /-webkit-text-size-adjust: 100%/, '古い端末向けの接頭辞が無い');
});

test('印刷文書にも viewport を持たせる', () => {
  // 無いとスマホの Chrome が「PC向けページ」と誤認して自動拡大を掛ける
  assert.match(print, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
});

// ===== 印刷オプション =====

test('印刷オプションに自動調整があり、既定でON・他の項目と同じく保存される', () => {
  assert.match(print, /id="po_autoFit"/);
  assert.match(print, /po_\('autoFit', true\)/, '既定ONになっていない');
  assert.match(print, /autoFit: document\.getElementById\('po_autoFit'\)\.checked/,
    'opts に入っていないと weeklyPrintOpts に保存されない');
});

test('自動調整中はフォントサイズスライダーを無効化する', () => {
  // 有効なまま残すと「動かしたのに印刷結果が変わらない」になる
  assert.match(print, /slider\.disabled = auto\.checked/);
});

test('自動調整の基準サイズは固定で、手動時だけスライダー値を使う', () => {
  assert.match(print, /var baseFontSize = opts\.autoFit \? AUTOFIT_BASE_FONT_SIZE : opts\.fontSize/);
  assert.match(print, /font-size: ' \+ baseFontSize \+ 'px/);
  assert.doesNotMatch(print, /font-size: ' \+ opts\.fontSize \+ 'px/,
    'body に opts.fontSize を直接書くと自動調整が効かない');
});

// ===== ページ側の印付け =====

test('拡大するのは、余りを吸収する伸縮要素を持たないページだけ', () => {
  // 標準1ページ目（週案表のみ）とコンパクト1枚が対象。
  // 標準2ページ目は .free-box が余った高さを引き受ける設計なので拡大しない
  const grow = print.match(/<div class="page page-grow">/g) || [];
  const plain = print.match(/<div class="page">/g) || [];
  assert.equal(grow.length, 2, '拡大対象は標準1ページ目とコンパクトの2つ');
  assert.equal(plain.length, 1, '拡大しないページは標準2ページ目の1つだけ');
  const plainAt = print.indexOf('<div class="page">');
  const freeBoxAt = print.indexOf('<div class="free-box">');
  assert.ok(plainAt < freeBoxAt, '拡大しないページが .free-box を持つページであること');
});

test('縮小側の下限は、現実には当たらない安全弁に留める', () => {
  // 「どんな分量でも紙に収める」のが従来からの保証。下限が実用域にあると、
  // 溢れた行が .page の overflow:hidden で黙って切り落とされる
  const min = /var AUTOFIT_MIN_SCALE = ([\d.]+);/.exec(print);
  assert.ok(min, 'AUTOFIT_MIN_SCALE が無い');
  assert.ok(Number(min[1]) <= 0.05, `下限が高すぎる: ${min[1]}`);
});

test('倍率の決定は pickFitScale_ に一本化されている', () => {
  assert.match(print, /pickFitScale_\(measureAt, target, AUTOFIT_MIN_SCALE,/);
  assert.doesNotMatch(print, /var scale = avail \/ natural/,
    '測った幅と当てる幅がズレる割り算一発の縮小が残っている');
  assert.match(print, /var AUTOFIT_MAX_SCALE = 2;/, '拡大の上限は2倍');
});

test('余りを測るため、拡大するページだけ高さを auto にする', () => {
  // height:100% のままだと scrollHeight が最低でもページ高さを返し、余りが測れない
  assert.match(print, /fit\.style\.height = canGrow \? 'auto' : '100%'/);
});
