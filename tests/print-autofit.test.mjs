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
  assert.match(print, /pickFitScale_\(measureAt, avail, AUTOFIT_MIN_SCALE,/);
  assert.doesNotMatch(print, /var scale = avail \/ natural/,
    '測った幅と当てる幅がズレる割り算一発の縮小が残っている');
  assert.match(print, /var AUTOFIT_MAX_SCALE = 2;/, '拡大の上限は2倍');
});

test('余りを測るため、拡大するページだけ高さを auto にする', () => {
  // height:100% のままだと scrollHeight が最低でもページ高さを返し、余りが測れない
  assert.match(print, /fit\.style\.height = canGrow \? 'auto' : '100%'/);
});
