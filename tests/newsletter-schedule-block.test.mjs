import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 学級通信の時間割ブロックの約束を固定する。
//
// 表を組むのは DOM とアプリ状態が要る NW.renderScheduleHTML なので Node では動かせない。
// そこで「日付をどう書くか」「大きさをどう決めるか」の判断だけを純粋関数に切り出してあり、
// ここではその判断を検証する。残り（行の出し分けと操作パネル）は静的検査で固定する。

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const nl = read('App_Js_06_Newsletter.html');
const css = read('App_Css.html');

/** HTML内JSから関数1つ分を、波括弧の対応を数えて切り出す（print-autofit.test.mjs と同じ手） */
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

/** `var NAME = [...];` を切り出す */
function extractArray(source, name) {
  const start = source.indexOf(`var ${name} = [`);
  assert.notEqual(start, -1, `var ${name} not found`);
  const end = source.indexOf('];', start);
  assert.notEqual(end, -1, `var ${name} is unbalanced`);
  return source.slice(start, end + 2);
}

const sizes = extractArray(nl, 'SCHED_DATE_SIZES');
const schedDateLabel_ = new Function(`${extractFn(nl, 'schedDateLabel_')}\nreturn schedDateLabel_;`)();
const schedDateStyle_ = new Function(
  `${sizes}\n${extractFn(nl, 'schedDateStyle_')}\nreturn schedDateStyle_;`)();

// ===== 日付の書き方 =====

test('月日の頭の0を落として「9/14」の形にする', () => {
  // 週案は "YYYY/MM/DD" で持っている。通信の見出しに "09/14" は要らない
  assert.equal(schedDateLabel_('2026/09/14'), '9/14');
  assert.equal(schedDateLabel_('2026/09/04'), '9/4');
  assert.equal(schedDateLabel_('2026/10/14'), '10/14');
});

test('想定外の形は捨てずに素通しする', () => {
  // 日付が入っていない週・手で書き替えられたデータでも、表そのものは出す
  assert.equal(schedDateLabel_(''), '');
  assert.equal(schedDateLabel_('bogus'), 'bogus');
  assert.equal(schedDateLabel_(null), '');
  assert.equal(schedDateLabel_(undefined), '');
});

// ===== 日付の大きさ =====

test('既定は従来より大きい。小さすぎて読めないという声への答え', () => {
  const before = 0.65 * 16; // 旧 .nw-sched-date の font-size（10.4px 相当）
  const px = parseFloat(schedDateStyle_('m').match(/font-size:(\d+)px/)[1]);
  assert.ok(px > before, `既定(${px}px)は旧 ${before}px より大きいはず`);
});

test('小・中・大・特大の順に大きくなる', () => {
  const px = k => parseFloat(schedDateStyle_(k).match(/font-size:(\d+)px/)[1]);
  assert.ok(px('s') < px('m') && px('m') < px('l') && px('l') < px('xl'),
    `単調に大きくなるはず: ${['s', 'm', 'l', 'xl'].map(px).join(',')}`);
});

test('知らない値は既定の「中」に落とす（古い保存データで表が壊れない）', () => {
  assert.equal(schedDateStyle_('huge'), schedDateStyle_('m'));
  assert.equal(schedDateStyle_(undefined), schedDateStyle_('m'));
});

test('大きさは inline style で入る。CSSを連れていけない Classroom 書き出しでも効く', () => {
  // buildClassroomHTML は renderScheduleHTML の出力をそのまま使う（スタイルシートは付かない）
  assert.match(nl, /nw-sched-date" style="' \+ dateStyle \+ '"/,
    '日付の span に inline style を載せていない');
  assert.ok(/font-size:' \+ hit\.px \+ 'px;/.test(nl), 'schedDateStyle_ が px を返していない');
});

// ===== 行事の出し分け =====

test('行事は行ごと消せる。既定は出す（今までの通信の見え方を変えない）', () => {
  assert.match(nl, /showEvent: true/, '既定で行事を出す設定になっていない');
  assert.match(nl, /if \(opts\.showEvent !== false\) \{/,
    '行事行が showEvent で囲まれていない（消しても行だけ空で残ってしまう）');
});

test('行事の表示切り替えが操作パネルに在る', () => {
  assert.ok(nl.includes(String.raw`\'showEvent\',this.checked)"> 行事</label>`),
    '行事のチェックボックスが操作パネルに無い');
});

test('日付の大きさの選択が操作パネルに在る', () => {
  assert.match(nl, /NW\.setSchedDateSize\(/, '日付サイズの選択が操作パネルに無い');
  assert.match(nl, /NW\.setSchedDateSize = function/, 'NW.setSchedDateSize が定義されていない');
});

test('印刷CSSにも日付のクラスが在る（画面と紙で見え方をそろえる）', () => {
  assert.match(nl, /\.nw-sched-date\{font-size:/, '印刷CSSに .nw-sched-date が無い');
  assert.match(css, /\.nw-sched-date \{/, '画面CSSに .nw-sched-date が無い');
});

// ===== 行の並び =====

test('行は週案の時程どおりに並ぶ。休み時間が表の下にまとまらない', () => {
  // 以前は校時をまとめて出したあとに休み時間を並べていたので、
  // 中休みと昼休みが表のいちばん下に来て、時程として読めなかった。
  const order = nl.slice(nl.indexOf('NW.renderScheduleHTML = function'));
  const seq = [...order.matchAll(/periodRow\((\d)\)|simpleRow\('([^']+)'/g)]
    .map(m => m[1] !== undefined ? `${Number(m[1]) + 1}校時` : m[2]);
  assert.deepEqual(seq.slice(0, 9),
    ['1校時', '2校時', '中休み', '3校時', '4校時', '昼休み', '5校時', '6校時', '放課後'],
    '時程の並びになっていない');
});

test('休み時間は校時を隠しても本来の位置に残る（時程そのものは変わらない）', () => {
  // 校時を隠すのは「その行を通信に出さない」という意味で、時程が動くわけではない
  assert.match(nl, /function periodRow\(pp\) \{\s*\n\s*if \(hiddenP\.indexOf\(pp \+ 1\) >= 0\) return '';/,
    '校時の出し分けが periodRow の中に無い');
  assert.doesNotMatch(nl, /if \(opts\.showRecess\) html \+= simpleRow\('中休み', 'recess1'\) \+ simpleRow\('昼休み'/,
    '中休みと昼休みが続けて出力されている（校時のあいだに挟まっていない）');
});

// ===== 曜日と日付の上下 =====

test('日付と曜日の上下を入れ替えられる。既定は曜日が上（今までどおり）', () => {
  assert.match(nl, /dateFirst: false/, '既定が「曜日が上」になっていない');
  assert.match(nl, /var top = opts\.dateFirst \? dateHtml\(day\) : escHtml\(day\.dayLabel\);/);
  assert.match(nl, /var bottom = opts\.dateFirst \? escHtml\(day\.dayLabel\) : dateHtml\(day\);/);
  assert.ok(nl.includes(String.raw`\'dateFirst\',this.checked)"> 日付を上に`),
    '入れ替えのチェックボックスが操作パネルに無い');
});

// ===== 見出しの色 =====

const schedHeaderTextColor_ = new Function(
  `${extractFn(nl, 'schedHeaderTextColor_')}\nreturn schedHeaderTextColor_;`)();

test('見出しの色は選べる。既定は今までの青のまま', () => {
  assert.match(nl, /var SCHED_HEADER_COLOR_DEFAULT = '#1a73e8';/);
  assert.match(nl, /NW\.setSchedHeaderColor = function/, '色を変える口が無い');
  assert.match(nl, /type="color" class="nw-sched-color"/, '色ピッカーが操作パネルに無い');
});

test('文字色は帯の明るさから決める。薄い色を選んでも読めなくならない', () => {
  // 白固定にすると、先生が薄い色を選んだ瞬間に見出しが読めなくなる
  assert.equal(schedHeaderTextColor_('#1a73e8'), '#ffffff', '既定の青は白文字のまま');
  assert.equal(schedHeaderTextColor_('#2e7d32'), '#ffffff');
  assert.equal(schedHeaderTextColor_('#ffe082'), '#202124', '薄い色には濃い文字を載せる');
  assert.equal(schedHeaderTextColor_('#ffffff'), '#202124');
  assert.equal(schedHeaderTextColor_('#000000'), '#ffffff');
  assert.equal(schedHeaderTextColor_('bogus'), '#ffffff', '読めない値でも壊れない');
});

test('選んだ色は紙にも出る（「背景のグラフィック」を切っていても）', () => {
  // 色を選べるのに紙で白くなるなら意味が無い
  assert.match(nl, /-webkit-print-color-adjust:exact;print-color-adjust:exact;/,
    '見出し帯に print-color-adjust が付いていない');
});

// ===== ひらがな表記の学年（1年）での見出し =====

const extractObj = (source, name) => {
  const start = source.indexOf(`var ${name} = {`);
  assert.notEqual(start, -1, `var ${name} not found`);
  const end = source.indexOf('\n    };', start);
  assert.notEqual(end, -1, `var ${name} is unbalanced`);
  return source.slice(start, end + 7);
};

const hiraMap = new Function(
  `${extractObj(nl, 'SCHED_LABEL_HIRAGANA')}\nreturn SCHED_LABEL_HIRAGANA;`)();
const subjMap = new Function(
  `${extractObj(nl, 'SUBJECT_HIRAGANA_MAP')}\nreturn SUBJECT_HIRAGANA_MAP;`)();
const labelColW = new Function(
  `${/var SCHED_LABEL_COL_W = \{[^}]*\};/.exec(nl)[0]}\nreturn SCHED_LABEL_COL_W;`)();

test('ひらがなにするかの判断は1か所。教科と見出しがちぐはぐにならない', () => {
  // 教科だけひらがなで「1校時」「持ち物」が漢字のままだと、子どもは読めない行が混ざる
  assert.match(nl, /function schedUsesHiragana_\(\)/);
  assert.match(nl, /if \(!schedUsesHiragana_\(\) \|\| !name\) return name;/,
    '教科名の判断が schedUsesHiragana_ を通っていない');
  assert.doesNotMatch(nl, /STATE\.grade !== 1/,
    '学年の判断が2か所に分かれている');
});

test('表の左端の見出しがひらがなになる', () => {
  assert.deepEqual(hiraMap, {
    '行事': 'ぎょうじ',
    '中休み': 'なかやすみ',
    '昼休み': 'ひるやすみ',
    '放課後': 'ほうかご',
    '宿題': 'しゅくだい',
    '持ち物': 'もちもの'
  });
  // 表に出す見出しはすべて変換を通す
  for (const m of nl.matchAll(/class="nw-sched-label">' \+ ([^+]+?) \+ '<\/td>/g)) {
    assert.match(m[1], /schedRowLabel_|schedPeriodLabel_/,
      `変換を通していない見出しがある: ${m[1]}`);
  }
});

test('校時は「1じかんめ」。子どもが使う言い方にそろえる', () => {
  const f = new Function(
    `var STATE = {grade: 1};\n${extractFn(nl, 'schedUsesHiragana_')}\n${extractFn(nl, 'schedPeriodLabel_')}\nreturn schedPeriodLabel_;`)();
  assert.equal(f(1), '1じかんめ');
  const g = new Function(
    `var STATE = {grade: 3};\n${extractFn(nl, 'schedUsesHiragana_')}\n${extractFn(nl, 'schedPeriodLabel_')}\nreturn schedPeriodLabel_;`)();
  assert.equal(g(1), '1校時', '1年以外は今までどおり「校時」');
});

test('ひらがなの見出しが列からはみ出さない幅を取ってある', () => {
  // 見出しは折り返さない（.nw-sched-label は white-space:nowrap）。
  // 幅が足りないと、列をはみ出したまま紙にも出る。
  const longest = Math.max(
    ...Object.values(hiraMap).map(v => v.length),
    ('6じかんめ').length);
  // 0.72rem = 11.52px。かなはほぼ全角なので 1 文字 ≒ 字送り 1em で見積もる
  const needed = longest * 11.52 + 8; // + セル左右の padding 4px ずつ
  assert.ok(labelColW.hiragana >= needed,
    `ひらがなの見出し列が狭い: ${labelColW.hiragana}px < ${Math.ceil(needed)}px`);
  assert.equal(labelColW.kanji, 52, '漢字のときの幅は今までどおり');
});

test('幅は inline style で入る（CSSを連れていけない Classroom 書き出しでも効く）', () => {
  assert.match(nl, /nw-sched-label-col" style="width:' \+ labelColW \+ 'px;/);
});

// ===== 教科名の変換もれ =====

test('時数画面の既定教科がすべてひらがなに変換できる', () => {
  // ここに無い教科は漢字のまま出て、1年生の通信に読めない行が混ざる
  const hours = read('App_Js_05_Hours.html');
  const defaults = /var defaultSubjects = \[([^\]]*)\]/.exec(hours);
  assert.ok(defaults, 'defaultSubjects が見つからない');
  const names = [...defaults[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  const missing = names.filter(n => !subjMap[n]);
  assert.deepEqual(missing, [], `ひらがなの読みが無い教科: ${missing.join('、')}`);
});

test('集約ルールに出てくる教科名もひらがなにできる（中体育・外体育など）', () => {
  const webapp = read('07_WebApp.gs');
  const rules = /const SUBJECT_AGGREGATION_RULES_ = \[([\s\S]*?)\];/.exec(webapp);
  assert.ok(rules, 'SUBJECT_AGGREGATION_RULES_ が見つからない');
  const names = [...rules[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  const missing = [...new Set(names)].filter(n => !subjMap[n]);
  assert.deepEqual(missing, [], `ひらがなの読みが無い教科: ${missing.join('、')}`);
  // 体育館（なか）と校庭（そと）の書き分けは潰さない
  assert.equal(subjMap['中体育'], 'なかたいいく');
  assert.equal(subjMap['外体育'], 'そとたいいく');
  assert.notEqual(subjMap['中体育'], subjMap['外体育']);
});

// ===== 宿題・持ち物の箇条書き =====

const schedListCell_ = new Function(
  `var escHtml = function (s) { return String(s == null ? '' : s)
     .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
   ${extractFn(nl, 'schedListCell_')}\nreturn schedListCell_;`)();

const lines = html => [...html.matchAll(/>・([^<]*)</g)].map(m => m[1]);

test('宿題と持ち物は1件1行の箇条書きになる', () => {
  // 週案の入力欄は3行のテキストエリアで、先生は1件ずつ改行して書く。
  // escHtml しただけだと改行が潰れて「れんらくちょううわばき」と繋がって出る。
  assert.deepEqual(lines(schedListCell_('連絡帳\n上履き\n雑巾')), ['連絡帳', '上履き', '雑巾']);
  assert.deepEqual(lines(schedListCell_('連絡帳\r\n上履き')), ['連絡帳', '上履き'],
    'Windows 由来の改行(CRLF)でも分かれること');
});

test('空の行は落とす。中身が無いセルは空のまま', () => {
  assert.deepEqual(lines(schedListCell_('連絡帳\n\n  \n上履き')), ['連絡帳', '上履き']);
  assert.equal(schedListCell_(''), '');
  assert.equal(schedListCell_('  \n \n'), '');
  assert.equal(schedListCell_(null), '');
  assert.equal(schedListCell_(undefined), '');
});

test('先生がすでに付けた中黒やハイフンを二重にしない', () => {
  assert.deepEqual(lines(schedListCell_('・連絡帳\n- 上履き\n※ 雑巾')), ['連絡帳', '上履き', '雑巾']);
});

test('セルの中身はエスケープする', () => {
  assert.doesNotMatch(schedListCell_('<script>x</script>'), /<script>/);
});

test('左詰めとぶら下げインデントは inline style で入る', () => {
  // CSS を連れていけない Classroom 書き出しでも箇条書きの形を保つため。
  // td 側は既定が中央ぞろえ（.nw-schedule-block td { text-align: center }）なので、
  // セルにも左詰めを当てないと箇条書きが中央に寄る。
  assert.match(schedListCell_('あ'), /text-indent:-0\.9em;/);
  assert.match(nl, /\(asList \? ' style="text-align:left;"' : ''\)/,
    'セルに左詰めを当てていない');
});

test('箇条書きにするのは宿題と持ち物だけ。ほかの行は今までどおり', () => {
  const fields = new Function(
    `${/var SCHED_LIST_FIELDS = \[[^\]]*\];/.exec(nl)[0]}\nreturn SCHED_LIST_FIELDS;`)();
  assert.deepEqual(fields, ['homework', 'items']);
});

test('宿題と持ち物は複数行で編集できる（1行の入力欄だと改行が落ちる）', () => {
  // <input> に改行入りの値を入れると、開いた時点で改行が消えて箇条書きが潰れる
  assert.match(nl, /input: asList \? 'textarea' : 'text',/);
  assert.match(nl, /var asList = SCHED_LIST_FIELDS\.indexOf\(rowType\) >= 0;/);
});

// ===== プレビューのページ分けの目安 =====

test('あてにならないページ分けの目安は出さない', () => {
  // 267mm 決め打ちで線を引いていたが、実際の改ページ位置とは合わない。
  // 合わない目安は、無いより読み手を惑わせる。
  const css = read('App_Css.html');
  assert.doesNotMatch(nl, /renderPageBreaks/, 'ページ分けの目安を描く処理が残っている');
  assert.doesNotMatch(nl, /nw-page-break-marker/, '目安の要素が残っている');
  assert.doesNotMatch(css, /nw-page-break-marker/, '目安のCSSが残っている');
});
