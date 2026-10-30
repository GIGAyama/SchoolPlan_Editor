import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 「いつもの学級通信」の形（題字・学級通信の形の表・お知らせ記事）の約束を固定する。
//
// 先生が Google ドキュメントで毎週作ってきた通信（A4 1枚）を読みくらべて決めた形。
// 表を組む NW.renderScheduleHTML は DOM とアプリ状態が要るので、判断だけを
// 純粋関数に切り出してあり、ここではそれを検証する。残りは静的検査で固定する。

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const nl = read('App_Js_06_Newsletter.html');
const css = read('App_Css.html');
const gemini = read('08_Gemini.gs');

/** 関数1つ分を、波括弧の対応を数えて切り出す（newsletter-schedule-block.test.mjs と同じ手） */
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

/** `var NAME = ...;`（1行または `{ ... };` / `[ ... ];` の塊）を切り出す */
function extractVar(source, name) {
  const start = source.indexOf(`var ${name} = `);
  assert.notEqual(start, -1, `var ${name} not found`);
  const head = source.slice(start, start + 200);
  const closer = /= \{\s*$/m.test(head.split('\n')[0]) ? '\n    };' : ';';
  const end = source.indexOf(closer, start);
  return source.slice(start, end + closer.length);
}

const fnFromGs = name => {
  const start = gemini.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  return extractFn(gemini, name);
};

// ===== 文字の大きさ（pt） =====

const ptToPx = new Function(`${extractFn(nl, 'nwPtToPx_')}\nreturn nwPtToPx_;`)();
const pxToPt = new Function(`${extractFn(nl, 'nwPxToPt_')}\nreturn nwPxToPt_;`)();
const ptSizes = new Function(`${extractVar(nl, 'NW_PT_SIZES')}\nreturn NW_PT_SIZES;`)();

test('Googleドキュメントと同じ pt で選べる。0.5pt 刻みの値もある', () => {
  for (const pt of [7.5, 8, 9.5, 10, 10.5, 11, 12, 14]) {
    assert.ok(ptSizes.includes(pt), `${pt}pt が選べない`);
  }
  assert.deepEqual([...ptSizes].sort((a, b) => a - b), ptSizes, '小さい順に並んでいない');
});

test('中身は px のまま持つ。保存済みの通信の大きさが変わらない', () => {
  assert.equal(ptToPx(10), 13.33);
  assert.equal(ptToPx(12), 16);
  assert.equal(pxToPt(12), 9, '以前の既定 12px は 9pt と表示される');
  assert.equal(pxToPt(13.33), 10);
  assert.equal(pxToPt(ptToPx(10.5)), 10.5, '行って戻って同じ値になる');
  assert.equal(pxToPt('bogus'), 12, '読めない値でも壊れない');
});

test('文字の大きさの選択は pt の部品を通す（px の飛び飛びの一覧に戻っていない）', () => {
  assert.doesNotMatch(nl, /\[9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72\]/,
    'テキストの大きさが px の一覧に戻っている');
  assert.match(nl, /NW\.buildPtControl_\(block\.id, 'fontSize', block\.fontSize\)/);
  assert.match(nl, /NW\.buildPtControl_\(block\.id, 'wrapFontSize'/);
  assert.match(nl, /block\.fontSize = parseFloat\(size\);/, '小数の px を切り捨てている');
});

// ===== 余白 =====

test('余白は Google ドキュメントの通信と同じ（上下 12.7mm・左右 16mm）。画面と紙でそろえる', () => {
  assert.match(nl, /@page\{size:A4 portrait;margin:12\.7mm 16mm;\}/, '印刷の余白が違う');
  assert.match(css, /\.nw-a4-page \{[\s\S]*?padding: 12\.7mm 16mm;/, '画面の余白が印刷と違う');
});

// ===== 発行日 =====

const zen = extractFn(nl, 'nwZenkakuDigits_');
const issueDate = new Function(`${extractFn(nl, 'nwIssueDate_')}\nreturn nwIssueDate_;`)();
const wareki = new Function(`${zen}\n${extractFn(nl, 'nwWarekiDate_')}\nreturn nwWarekiDate_;`)();

test('発行日の既定は、対象週の前の金曜日', () => {
  const d = issueDate('2026/10/19');
  assert.deepEqual([d.getFullYear(), d.getMonth() + 1, d.getDate()], [2026, 10, 16]);
  assert.equal(issueDate(''), null);
  assert.equal(issueDate('bogus'), null);
});

test('日付は「令和８年１０月１６日」の形（数字は全角）', () => {
  assert.equal(wareki(new Date(2026, 9, 16)), '令和８年１０月１６日');
  assert.equal(wareki(new Date(2019, 4, 1)), '令和元年５月１日');
  assert.equal(wareki(new Date(2019, 3, 30)), '２０１９年４月３０日', '令和より前は西暦');
  assert.equal(wareki(null), '');
});

test('週を切り替えて描き直しても、自動の発行日を「手で直した日付」と取り違えない', () => {
  const src = nl.slice(nl.indexOf('NW.setMastheadDate_ = function'));
  const body = src.slice(0, src.indexOf('\n    };') + 7);
  const NW = { mondayStr: '2026/10/26' };
  const set = new Function('NW', 'STATE',
    `${zen}\n${extractFn(nl, 'nwIssueDate_')}\n${extractFn(nl, 'nwWarekiDate_')}\n${body}\nreturn NW.setMastheadDate_;`)(NW, {});
  const block = { dateAuto: true, dateText: '' };
  // 前の週（10/19）のときに描いた自動の日付が、画面にそのまま残っている
  set(block, '令和８年１０月１６日', '令和８年１０月１６日');
  assert.equal(block.dateAuto, true, '前の週の自動の日付で固まった');
  set(block, '令和８年１０月２２日', '令和８年１０月１６日');
  assert.deepEqual(block, { dateAuto: false, dateText: '令和８年１０月２２日' }, '手で直した日付を覚えていない');
  set(block, '', null);
  assert.equal(block.dateAuto, true, '空にしたら自動にもどる');
  assert.match(nl, /if \(weekChanged\) \{[\s\S]*?b\.dateAuto = true;/, '週が変わっても手で直した日付が残る');
});

// ===== 学級通信の形の表 =====

const spread = new Function(`${extractFn(nl, 'schedSpreadChars_')}\nreturn schedSpreadChars_;`)();
const closedLabel = new Function(`${extractFn(nl, 'schedClosedLabel_')}\nreturn schedClosedLabel_;`)();

test('休みの名前は1字ずつ、上下のまん中に寄せて縦に配る', () => {
  assert.deepEqual(spread('とみんのひ', 7), ['', 'と', 'み', 'ん', 'の', 'ひ', '']);
  assert.deepEqual(spread('スポーツのひ', 8), ['', 'ス', 'ポ', 'ー', 'ツ', 'の', 'ひ', '']);
  assert.equal(spread('ふりかえきゅうじつ', 8).length, 8, '行の数は変わらない');
});

test('行より字が多ければ、1行に2字以上を入れる（字を落とさない）', () => {
  const out = spread('きんろうかんしゃのひ', 4);
  assert.equal(out.length, 4);
  assert.equal(out.join(''), 'きんろうかんしゃのひ');
});

test('名前が無いときは空の行だけ返す', () => {
  assert.deepEqual(spread('', 3), ['', '', '']);
  assert.deepEqual(spread(' ', 0), []);
});

const P = s => ({ subject: s, unit: '', content: '' });

test('祝日は休みの日として灰色にする', () => {
  assert.equal(closedLabel({ holiday: 'スポーツの日', periods: [] }), 'スポーツの日');
});

test('授業が無く行事だけの日（振替休業日・都民の日など）も休みにする', () => {
  assert.equal(closedLabel({ event: '振替休業日', periods: [P(''), P('')] }), '振替休業日');
});

test('授業のある日は、行事が書いてあっても休みにしない', () => {
  assert.equal(closedLabel({ event: '避難訓練', periods: [P('国語')] }), '');
  assert.equal(closedLabel({ event: '全校朝会', morning: '全校朝会', periods: [] }), '', '朝の活動がある日は登校日');
  assert.equal(closedLabel({ periods: [] }), '', '何も書いていない日は灰色にしない');
});

test('先生が決めた名前が最優先。空にすれば休みにしない', () => {
  assert.equal(closedLabel({ holiday: '敬老の日' }, 'けいろうのひ'), 'けいろうのひ');
  assert.equal(closedLabel({ holiday: '敬老の日' }, ''), '');
});

test('見出しは1行で「10/19(げつ)」。1年以外は「10/19(月)」', () => {
  const build = grade => new Function(
    `var STATE = {grade: ${grade}};\n`
    + `${extractFn(nl, 'schedUsesHiragana_')}\n${extractFn(nl, 'schedDateLabel_')}\n`
    + `${extractVar(nl, 'SCHED_DAY_HIRAGANA')}\n${extractFn(nl, 'schedHeadLabel_')}\nreturn schedHeadLabel_;`)();
  assert.equal(build(1)({ date: '2026/10/19', dayLabel: '月' }), '10/19(げつ)');
  assert.equal(build(1)({ date: '2026/10/21', dayLabel: '水' }), '10/21(すい)');
  assert.equal(build(3)({ date: '2026/10/19', dayLabel: '月' }), '10/19(月)');
});

test('校時の見出しは数字だけにできる。先生の決めた見出しの名前はそのまま出す', () => {
  const env = `var STATE = {grade: 1};\n${extractFn(nl, 'schedUsesHiragana_')}\n`;
  const period = new Function(`${env}${extractFn(nl, 'schedPeriodLabel_')}\nreturn schedPeriodLabel_;`)();
  assert.equal(period(3, true), '3');
  assert.equal(period(3), '3じかんめ', 'アプリの形は今までどおり');
  const row = new Function(`${env}${extractVar(nl, 'SCHED_LABEL_HIRAGANA')}\n${extractFn(nl, 'schedRowLabel_')}\nreturn schedRowLabel_;`)();
  assert.equal(row('宿題', 'かだい'), 'かだい');
  assert.equal(row('宿題'), 'しゅくだい');
  assert.equal(row('朝'), 'あさ');
});

test('学級通信の形の既定は、紙の通信を測った値', () => {
  const defaults = new Function(
    `var SCHED_LETTER_HEADER_COLOR = '#d0e0e3';\n`
    + `${extractVar(nl, 'SCHED_LETTER_SIZES')}\n${extractFn(nl, 'schedLetterDefaults_')}\nreturn schedLetterDefaults_;`)()();
  assert.equal(defaults.tableStyle, 'letter');
  assert.equal(defaults.showMorning, true, 'あさの行を出す');
  assert.equal(defaults.closedDays, true, '休みの日を灰色にする');
  assert.equal(defaults.showEvent, false);
  assert.equal(defaults.showRecess, false);
  assert.deepEqual(defaults.sizes, { subject: 16, sub: 8, list: 7.5, label: 14 }, '教科は紙の通信より少し大きい 16pt');
  assert.equal(defaults.headerColor, '#d0e0e3');
});

test('保存済みの通信は今までの見え方のまま（新しい設定は無いとき「アプリの形」になる）', () => {
  assert.match(nl, /var letter = opts\.tableStyle === 'letter';/);
  assert.match(nl, /tableStyle: 'app',/, '新しく足す表の既定がアプリの形になっていない');
  assert.match(nl, /showMorning: false,/);
  assert.match(nl, /closedDays: false,/);
});

test('学級通信の形の罫線・地の色・大きさは inline で入る（Classroom 書き出しでも同じ形）', () => {
  assert.match(nl, /var letterTd = 'border:1px solid #000;background:#fff;vertical-align:middle;/);
  assert.match(nl, /<span class="nw-sched-sub" style="font-size:' \+ sz\.sub \+ 'px;color:#202124;">'/);
  assert.match(nl, /print-color-adjust:exact;">'\s*\n\s*\+ escHtml\(\(spread\[di\]/, '灰色の列が紙で白くなる');
});

test('週が変わったら、前の週のセルの書き替えは捨てる', () => {
  // 書き替えは「月曜の宿題」のように位置で持っている。週をまたぐと別の日に化ける
  assert.match(nl, /if \(!sameWeek\) \{ b\.cellOverrides = \{\}; weekChanged = true; \}/);
});

// ===== 題字・記事 =====

test('題字の画像は端末に残さない（下書き・テンプレートとも）', () => {
  const strip = nl.slice(nl.indexOf('NW.stripImagesForLocalSave_ = function'), nl.indexOf('NW.autoSave = function'));
  assert.match(strip, /if \(b\.src\) \{ b\.src = '';/, '下書きに画像が残る');
  assert.match(nl, /if \(b\.type === 'masthead'\) \{ b\.src = '';/, 'テンプレートに題字の画像が残る');
  const mem = nl.slice(nl.indexOf('NW.saveMastheadMemory_ = function'), nl.indexOf('NW.loadMastheadMemory_ = function'));
  assert.doesNotMatch(mem, /src/, '覚えておく題字の文字に画像が混ざっている');
});

test('記事の番号は全角の「１．」で、並び順に振る', () => {
  const NW = { blocks: [
    { id: 'a', type: 'article' }, { id: 'x', type: 'text' },
    { id: 'b', type: 'article', numbered: false }, { id: 'c', type: 'article' }] };
  const src = nl.slice(nl.indexOf('NW.articleNumber_ = function'));
  const body = src.slice(0, src.indexOf('\n    };') + 7);
  const fn = new Function('NW', `${zen}\n${body}\nreturn NW.articleNumber_;`)(NW);
  assert.equal(fn('a'), '１．');
  assert.equal(fn('c'), '２．', '番号を付けない記事は数えない');
});

test('「いつもの学級通信」は、紙の通信と同じ並びで組む', () => {
  const src = nl.slice(nl.indexOf('NW.buildLetterLayout_ = function'));
  const body = src.slice(0, src.indexOf('\n    };'));
  const order = [...body.matchAll(/NW\.addBlock\('([a-z]+)'/g)].map(m => m[1]);
  assert.deepEqual(order, ['masthead', 'schedule', 'text', 'divider', 'text', 'article', 'article']);
  assert.match(body, /options: schedLetterDefaults_\(\)/);
  assert.match(body, /fontSize: nwPtToPx_\(12\), bold: true/, '表の下の3行は太字 12pt');
  assert.match(body, /role: 'notice-label'/);
});

test('AI の文章は文字として入れる（HTMLとして解釈しない）', () => {
  assert.match(nl, /title: escHtml\(a\.title \|\| ''\)/);
  assert.match(nl, /content: escHtml\(a\.body \|\| ''\)/);
  assert.doesNotMatch(nl, /content: res\.text\.replace\(/, 'AI の出力をそのまま innerHTML に入れている');
});

// ===== AI のプロンプト（08_Gemini.gs） =====

const normalize = new Function(`${fnFromGs('normalizeNewsletterArticles_')}\nreturn normalizeNewsletterArticles_;`)();
const context = new Function(`${fnFromGs('buildNewsletterScheduleContext_')}\nreturn buildNewsletterScheduleContext_;`)();

test('見出しの頭に AI が付けた番号や記号は落とす（番号は通信側で振る）', () => {
  assert.deepEqual(normalize([{ title: '１．体操服について', body: 'あ' }]), [{ title: '体操服について', body: 'あ' }]);
  assert.deepEqual(normalize([{ title: '2. 持ち物', body: 'い' }]), [{ title: '持ち物', body: 'い' }]);
  assert.deepEqual(normalize([{ title: '■お願い', body: 'う' }]), [{ title: 'お願い', body: 'う' }]);
  assert.deepEqual(normalize([{ title: '', body: '' }, null]), [], '空の記事は捨てる');
  assert.deepEqual(normalize('bogus'), []);
});

test('AI に渡す予定には、朝の活動・単元・宿題・持ち物まで入る。日曜は入れない', () => {
  const days = [
    { dayLabel: '月', date: '2026/10/19', holiday: '', event: '', morning: '読書', homework: 'おんどく\nけいさん', items: 'うわばき',
      periods: [{ subject: '国語', unit: 'くじらぐも' }] },
    { dayLabel: '火', date: '2026/10/20', holiday: 'スポーツの日', event: '', morning: '', homework: '', items: '', periods: [] },
    {}, {}, {}, {},
    { dayLabel: '日', date: '2026/10/25', event: '日曜の行事', periods: [] }
  ];
  const text = context(days);
  assert.match(text, /朝:読書/);
  assert.match(text, /1時間目:国語（くじらぐも）/);
  assert.match(text, /宿題:おんどく、けいさん/, '改行を「、」でつなぐ');
  assert.match(text, /持ち物:うわばき/);
  assert.match(text, /祝日:スポーツの日/);
  assert.doesNotMatch(text, /日曜の行事/);
});

test('記事の書き方は、実際の通信の型（見出し＋本文・あいさつや結びは書かない）', () => {
  const style = gemini.slice(gemini.indexOf('const NEWSLETTER_ARTICLE_STYLE_'), gemini.indexOf("].join('\\n');"));
  assert.match(style, /あいさつ・季節の前置き・結びの言葉は書かない/);
  assert.match(style, /「見出し」と「本文」/);
  assert.match(style, /持ち物・大きさ・記名/);
  assert.match(style, /予定に書かれていない行事・持ち物・日付を作り出さない/);
  assert.match(style, /子どもの名前/);
});

test('まとめ生成は記事だけを返す（題字と表は週案から組む）', () => {
  const full = fnFromGs('generateFullNewsletterAI');
  assert.match(full, /return \{ success: true, articles: articles \};/);
  assert.match(full, /Math\.min\(3, Math\.max\(1,/, '記事の数は1〜3本');
  assert.doesNotMatch(full, /"type": "closing"/, '結びの文を作る型が残っている');
});

// ===== 教科名は太字で1行・左の見出しの列は細く =====

const textEm = new Function(`${extractFn(nl, 'schedTextEm_')}\nreturn schedTextEm_;`)();
const fitPx = new Function(`${extractFn(nl, 'schedTextEm_')}\n${extractFn(nl, 'schedFitPx_')}\nreturn schedFitPx_;`)();

test('字の幅の見積もり：かな・漢字は1字、半角の英数字は0.55字', () => {
  assert.equal(textEm('こくご'), 3);
  assert.equal(textEm('図画工作'), 4);
  assert.ok(Math.abs(textEm('10/19') - 2.75) < 1e-9);
  assert.equal(textEm(''), 0);
});

test('教科名が長くても1行に収まる大きさにする。収まるなら小さくしない', () => {
  assert.equal(fitPx('こくご', 21.33, 110, true), 21.33, '短い教科名はそのまま');
  const px = fitPx('ずがこうさく', 21.33, 110, true);
  assert.ok(px < 21.33, '長い教科名が小さくなっていない');
  assert.ok(textEm('ずがこうさく') * 1.06 * px <= 110, '小さくしても1行に収まらない');
  assert.ok(fitPx('あ'.repeat(40), 21.33, 110, true) >= 6, '小さくしすぎて読めない');
});

test('教科名は太字・折り返しなし。幅は予定の列から決める', () => {
  assert.match(nl, /schedFitPx_\(name, sz\.subject, dayInnerW, true\)/);
  assert.match(nl, /'px;font-weight:700;white-space:nowrap;">' \+ escHtml\(name\)/);
  assert.match(nl, /var dayInnerW = Math\.floor\(\(SCHED_LETTER_TABLE_W - labelColW\) \/ days\.length\) - 8;/);
});

test('左の見出しの列は3字ぶん。長い見出しは字を小さくして収める', () => {
  const width = new Function(`var SCHED_LETTER_LABEL_CHARS = 3;\n${extractFn(nl, 'schedLetterLabelWidth_')}\nreturn schedLetterLabelWidth_;`)();
  const w = width(18.67); // 14pt
  assert.ok(w <= 70, `列が太い: ${w}px`);
  assert.ok(fitPx('しゅくだい', 18.67, w - 8, false) < 18.67, '「しゅくだい」を小さくしていない');
  assert.equal(fitPx('あさ', 18.67, w - 8, false), 18.67, '短い見出しはそのまま');
  // 見出しはどれも labelText を通す
  for (const m of nl.matchAll(/class="nw-sched-label">' \+ ([^+]+?) \+ '<\/td>/g)) {
    assert.match(m[1], /^labelText\(/, `大きさをそろえていない見出しがある: ${m[1]}`);
  }
});

// ===== Classroom へ PDF・画像で投稿 =====

test('PDF は A4 のページに JPEG を1枚ずつ貼った正しい形', () => {
  const pt = 'var NW_A4_PT = { w: 595.28, h: 841.89 };';
  const build = new Function(`${pt}\n${extractFn(nl, 'nwBuildPdf_')}\nreturn nwBuildPdf_;`)();
  const jpeg = Uint8Array.from([0xff, 0xd8, 0x00, 0x0a, 0xff, 0xd9]);
  const pdf = build([{ jpeg, w: 10, h: 14 }, { jpeg, w: 10, h: 14 }]);
  const text = Buffer.from(pdf).toString('latin1');
  assert.match(text, /^%PDF-1\.4/);
  assert.match(text, /\/Count 2/);
  assert.match(text, /\/MediaBox \[0 0 595\.28 841\.89\]/);
  assert.match(text, /\/Filter \/DCTDecode \/Length 6/);
  // xref の位置が、それぞれのオブジェクトの書き出し位置と一致する（ずれると開けない PDF になる）
  const startxref = Number(/startxref\n(\d+)/.exec(text)[1]);
  assert.equal(text.slice(startxref, startxref + 4), 'xref');
  const entries = text.slice(startxref).split('\n').slice(3).filter(l => / 00000 n $/.test(l));
  assert.equal(entries.length, 8, '1 + 1 + 2ページ×3 のオブジェクト');
  entries.forEach((line, i) => {
    const at = Number(line.slice(0, 10));
    assert.equal(text.slice(at, at + String(i + 1).length + 6), `${i + 1} 0 obj`, `${i + 1} 番のオブジェクトの位置がずれている`);
  });
  assert.match(text, /%%EOF\n$/);
});

test('画像にするときも書体は印刷と同じ（body の規則を絵にする div に当てる）', () => {
  assert.match(nl, /replace\(\/\(\^\|\\\}\)\\s\*body\\\{\/g, '\$1body,\.nw-cap-root\{'\)/);
  const cap = nl.slice(nl.indexOf('NW.captureNewsletter_ = function'), nl.indexOf('NW.buildPostFile_ = function'));
  // SVG の名前空間（http://www.w3.org/2000/svg）は URL の形をしているが、取りにいくものではない
  assert.doesNotMatch(cap.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, ''), /https?:\/\/|fetch\(|XMLHttpRequest/,
    '絵にするときに外へ取りにいっている');
});

test('投稿の形は PDF・画像・ドキュメントから選べ、どれも drive.file のまま作る', () => {
  const gs = read('07_WebApp.gs');
  const body = gs.slice(gs.indexOf('function postNewsletterToClassroomFromWeb'));
  const fn = body.slice(0, body.indexOf('\nfunction ', 1));
  assert.match(gs, /pdf: \{ ext: '\.pdf', mime: 'application\/pdf' \}/);
  assert.match(gs, /png: \{ ext: '\.png', mime: 'image\/png' \}/);
  assert.match(fn, /const kind = NEWSLETTER_POST_FORMATS_\[format\] \? format : 'doc';/, '知らない形はドキュメントに落とす');
  assert.match(fn, /driveCreateFile_\(fileName, Utilities\.newBlob\(bytes, mime, fileName\)\)/);
  assert.doesNotMatch(fn, /DriveApp\./, 'DriveApp はフル drive スコープが要る');
  assert.match(nl, /\.postNewsletterToClassroomFromWeb\(message, content, format\);/);
});

// ===== 単元の時数（3/8）を予定表に出さない =====

const stripHours = new Function(`${extractFn(nl, 'schedStripHours_')}\nreturn schedStripHours_;`)();

test('単元の後ろの時数（何時間目/総時数）を落とす', () => {
  assert.equal(stripHours('くじらぐも 3/8'), 'くじらぐも', '自動入力の形');
  assert.equal(stripHours('たしざん 10/12'), 'たしざん');
  assert.equal(stripHours('かずとかんじ３／５'), 'かずとかんじ', '全角の数字と斜線');
  assert.equal(stripHours('うみのかくれんぼ 2/6時間目'), 'うみのかくれんぼ');
  assert.equal(stripHours('きせつとなかよし（1/4）'), 'きせつとなかよし', 'かっこ付き');
});

test('時数でないものは残す（単元名の途中の数字・時数だけのセル）', () => {
  assert.equal(stripHours('1/2成人式の準備'), '1/2成人式の準備', '単元名の途中の分数は消さない');
  assert.equal(stripHours('10よりおおきいかず'), '10よりおおきいかず');
  assert.equal(stripHours('3/8'), '', '時数しか無ければ空になる（教科名だけが出る）');
  assert.equal(stripHours(null), '');
});

test('学級通信の形では時数を出さないのが既定。切り替えは操作パネルから', () => {
  assert.match(nl, /var hideHours = letter \? opts\.hideHours !== false : !!opts\.hideHours;/,
    '保存済みの学級通信の形の表でも、決めていなければ時数を出さない／アプリの形は今までどおり出す');
  assert.match(nl, /hideHours: true\n\s*\};/, '学級通信の形の既定に入っていない');
  assert.ok(nl.includes(String.raw`\'hideHours\',this.checked)"> 時数（3/8）を出さない</label>`), '切り替えが操作パネルに無い');
  // 単元を出す2か所（アプリの形・学級通信の形）とも通している
  assert.equal((nl.match(/var unit = unitText\(per\.unit\);/g) || []).length, 2);
});

// ===== 小さい画面でも紙と同じ見え方・1枚に収まるかの目安 =====

test('狭い画面でもページは 210mm のまま組み、zoom で縮める（幅を 100% にしない）', () => {
  // 幅を 100% にすると紙より狭い幅で組み直され、紙に合わせた字の大きさが表のマスからはみ出す
  assert.doesNotMatch(css, /\.nw-a4-page \{\s*width: 100% !important;/, '狭い画面でページの幅を変えている');
  assert.match(nl, /NW\.fitPage_ = function/);
  assert.match(nl, /var z = Math\.min\(1, Math\.max\(0\.2, avail \/ NW_A4_PX\.w\)\);/, '広げない（縮めるだけ）');
  assert.match(nl, /new ResizeObserver\(function \(\) \{ NW\.fitPage_\(\); \}\)/, '画面の幅が変わったら合わせ直す');
  // 操作の部品は縮めない（指で押せる大きさのまま）
  assert.match(css, /\.nw-a4-page \.nw-block-actions,\s*\n\s*\.nw-a4-page \.nw-schedule-options \{\s*\n\s*zoom: var\(--nw-unzoom, 1\);/);
});

test('編集画面のブロックの余白は印刷と同じ。印は組み方に影響しない outline で出す', () => {
  const block = /\n    \.nw-block \{([\s\S]*?)\n    \}/.exec(css)[1];
  assert.match(block, /padding: 2px;/, '印刷（padding:2px）と違う余白を取っている');
  assert.match(block, /border: 0;/);
  assert.match(nl, /el\.style\.padding = '2px';/, '前提が変わった（印刷の余白）');
  assert.match(css, /\.nw-block\.nw-block-selected \{\s*\n\s*outline-color:/);
  const insert = /\n    \.nw-insert-row \{([\s\S]*?)\n    \}/.exec(css)[1];
  assert.match(insert, /height: 0;/, 'ブロックのあいだの＋が紙に無いすき間を作っている');
});

test('時間割の設定は選んだときだけ、表の下に重ねて出す（ふだんは紙と同じ高さ）', () => {
  assert.match(css, /\.nw-block:not\(\.nw-block-selected\) \.nw-schedule-options \{\s*\n\s*display: none;/);
  assert.match(css, /\.nw-block\.nw-block-selected \.nw-schedule-options \{\s*\n\s*position: absolute;/);
});

const fitResult = new Function(
  `var NW_PAGE1_BOTTOM_PX = (297 - 12.7) * 96 / 25.4;\n${extractFn(nl, 'nwFitResult_')}\nreturn nwFitResult_;`)();

test('1枚に収まるかは、印刷と同じ組み方で測ったブロックの下端で決める', () => {
  const limit = (297 - 12.7) * 96 / 25.4; // 約 1074px
  assert.deepEqual(fitResult([{ id: 'a', bottom: 300 }, { id: 'b', bottom: limit - 1 }]),
    { fits: true, overflowMm: 0, firstOverflowId: '', pages: 1 });
  const over = fitResult([{ id: 'a', bottom: 300 }, { id: 'b', bottom: limit + 200 }, { id: 'c', bottom: limit + 400 }]);
  assert.equal(over.fits, false);
  assert.equal(over.firstOverflowId, 'b', '2枚目に入る最初のブロックに印を付ける');
  assert.equal(over.overflowMm, Math.ceil(400 * 25.4 / 96));
  assert.equal(over.pages, 2);
  assert.equal(fitResult([]).fits, true);
});

test('測るのは印刷と同じ HTML（決め打ちの線を引かない）', () => {
  const check = nl.slice(nl.indexOf('NW.checkFit_ = function'), nl.indexOf('NW.showOverflow_ = function'));
  assert.match(check, /NW\.layoutPrintFrame_\(\)/, '印刷と同じ組み方で測っていない');
  const frame = nl.slice(nl.indexOf('NW.layoutPrintFrame_ = function'), nl.indexOf('var NW_PAGE1_BOTTOM_PX'));
  assert.match(frame, /NW\.buildPrintHTML\(\)/);
  assert.match(frame, /padding:12\.7mm 16mm;/, '紙の余白と同じでない');
  assert.match(nl, /NW\.scheduleFitCheck_\(\);\n    \};/, '描き直したあとに測り直していない');
});

// ===== 学年が遅れて届いても、1年生の表はひらがなになる =====

test('学年が届いたら（変わったら）学級通信を描き直す', () => {
  // 起動のあと学年は遅れて届く。届く前に描いた表は、1年生でも漢字のまま印刷・投稿されていた
  // （スマートフォンは通信が遅く、起きやすかった）
  const fn = nl.slice(nl.indexOf('NW.onGradeKnown_ = function'));
  const body = fn.slice(0, fn.indexOf('\n    };') + 7);
  let rendered = 0;
  const NW = { initialized: true, blocks: [{}], render() { rendered++; NW._gradeAtRender = Number(STATE.grade); } };
  const STATE = { grade: 3 };
  const onGrade = new Function('NW', 'STATE', `${body}\nreturn NW.onGradeKnown_;`)(NW, STATE);
  NW._gradeAtRender = 3;
  onGrade('1');
  assert.equal(rendered, 1, '学年が届いても描き直していない');
  assert.equal(STATE.grade, 1);
  assert.equal(STATE.gradeKnown, true);
  onGrade('1');
  assert.equal(rendered, 1, '学年が同じなのに描き直している');
  STATE.grade = 2; // 設定画面は先に STATE.grade を書き替えてから知らせる
  onGrade('2');
  assert.equal(rendered, 2, '設定画面で学年を変えても描き直していない');
  onGrade('bogus');
  assert.equal(STATE.grade, 2, '読めない学年で上書きした');
});

test('学年を書き替える場所はどれも学級通信へ知らせる', () => {
  for (const file of ['App_Js_05_Hours.html', 'App_Js_10_Settings.html', 'App_Js_13_SystemTools.html']) {
    assert.match(read(file), /NW\.onGradeKnown_\(/, `${file}: 学年が変わっても学級通信へ知らせていない`);
  }
  assert.match(nl, /NW\._gradeAtRender = Number\(STATE\.grade\);/, '描いたときの学年を覚えていない');
  assert.match(nl, /if \(!STATE\.gradeKnown\) \{\s*\n\s*google\.script\.run/, '学級通信を開いたときに学年を取りにいっていない');
});

test('予定と一緒に学年を受け取り、表を組む前に入れる', () => {
  const gs = read('07_WebApp.gs');
  const fn = gs.slice(gs.indexOf('function getNewsletterData'), gs.indexOf('function postNewsletterToClassroomFromWeb'));
  assert.match(fn, /grade: tGetProp_\(SCRIPT_PROP_GRADE\) \|\| '3',/);
  const load = nl.slice(nl.indexOf('NW.loadScheduleData = function'));
  assert.ok(load.indexOf('STATE.gradeKnown = true') < load.indexOf('NW.scheduleData = data;'), '表を組んだあとに学年を入れている');
});

test('学年が文字（"1"）で入っていても1年生として扱う', () => {
  const f = new Function('STATE', `${extractFn(nl, 'schedUsesHiragana_')}\nreturn schedUsesHiragana_;`);
  assert.equal(f({ grade: '1' })(), true);
  assert.equal(f({ grade: 1 })(), true);
  assert.equal(f({ grade: 3 })(), false);
});
