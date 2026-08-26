import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 教科サジェストの出る位置の回帰防止（静的検査）。
// 箱は .grid-cell の中に置いた position:absolute なので、top を 100% にすると
// セルの外（次の行のセルの上）に出る。打っている教科欄と 60px 以上離れて選びにくいので、
// 教科欄の下端に合わせて出す。ここが戻ると、見た目は動くのに選びにくいだけの状態になる。

const read = file => fs.readFileSync(file, 'utf8');

const plan = read('App_Js_02_Plan.html');
const css = read('App_Css.html');

/** plan から関数 1 つ分の本文を取り出す（次の同インデントの宣言まで）。 */
function fnBody(name) {
  const start = plan.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  const rest = plan.slice(start + 1);
  const next = rest.search(/\n {4}(?:function |var |const |\/\*\*|\/\/ =====)/);
  return rest.slice(0, next === -1 ? undefined : next);
}

test('候補を出したら、そのつど位置を決め直す', () => {
  const body = fnBody('onSubjectInput');
  const shown = body.indexOf("box.style.display = 'block'");
  const placed = body.indexOf('positionSuggestBox(input, box)');
  assert.notEqual(shown, -1, '候補を出す行が見つからない');
  assert.notEqual(placed, -1, '位置を決める呼び出しが無い');
  // 中身を入れて表示してから測る。先に測ると高さが 0 で、上下の判定が狂う
  assert.ok(placed > shown, 'positionSuggestBox は表示のあとに呼ぶこと');
});

test('教科欄の下端に合わせて出す', () => {
  const body = fnBody('positionSuggestBox');
  assert.match(body, /input\.offsetTop \+ input\.offsetHeight/);
  assert.doesNotMatch(body, /'100%'/);
});

test('下に入りきらない行だけ、教科欄の上に出す', () => {
  const body = fnBody('positionSuggestBox');
  // 枠（週案グリッドの外枠）からはみ出すかどうかで決める
  assert.match(body, /\.week-grid-wrapper/);
  assert.match(body, /boxRect\.bottom > wrapRect\.bottom/);
  // 上にも入らないときは下のままにする（上に出すと画面の外へ消えるため）
  assert.match(body, /noRoomBelow && roomAbove/);
  assert.match(body, /classList\.add\('suggest-box-above'\)/);
  // 開くたびに付け外しする。前回上に出したままだと角の丸みが残る
  assert.match(body, /classList\.remove\('suggest-box-above'\)/);
});

test('上に出したときは角の丸みも上下を入れ替える', () => {
  assert.match(css, /\.suggest-box\.suggest-box-above \{[^}]*border-radius: var\(--radius-sm\) var\(--radius-sm\) 0 0;/);
});
