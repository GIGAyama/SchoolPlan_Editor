import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 18_SheetsApi.gs（Sheets REST ファサード）を、偽の Sheets API に対して実際に動かす。
//
// GAS 実環境が無いところで確かめられる最大限をここでやる。とくに
//   - 日付セルが Date に戻ること（戻らないと週案の行照合が全滅する）
//   - 要求したサイズの矩形が返ること（`values.get` は末尾の空セルを詰めてくる）
//   - getLastRow がデータの最終行であること
//   - 書き込んだあとの読みでシートを読み直すこと（"1/3" → 日付 のような解釈し直しに追随する）
//   - 追記のたびにシート全体を読み直さないこと（ログ出力が重くならないように）
// を見る。

const SOURCE = fs.readFileSync('18_SheetsApi.gs', 'utf8');

/**
 * 偽の Sheets API。値・シート構成・表示形式をメモリに持ち、
 * ファサードが投げてくる URL に応じて応答する。
 */
function createFakeSheets(options = {}) {
  const state = {
    id: 'ss-1',
    timeZone: 'Asia/Tokyo',
    sheets: [{
      sheetId: 100, title: 'データベース', index: 0, hidden: false,
      gridProperties: { rowCount: 1000, columnCount: 26 }
    }],
    // 値は「シート名 → 二次元配列」。末尾の空セルは応答時に詰める。
    values: { 'データベース': options.values || [] },
    // 日付として表示する列（1始まり）
    dateColumns: options.dateColumns || [],
    // 書き込み時にスプレッドシートが値を解釈し直す挙動を模す
    normalize: options.normalize || ((v) => v),
    // 当てられた表示形式（repeatCell）の記録
    formats: [],
    requests: []
  };

  /** 末尾の空セル・空行を詰める（本物の values.get と同じ振る舞い） */
  function trim(grid) {
    const rows = grid.map(row => {
      const copy = row.slice();
      while (copy.length && (copy[copy.length - 1] === '' || copy[copy.length - 1] === undefined)) copy.pop();
      return copy;
    });
    while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
    return rows;
  }

  function parseA1(rangeText) {
    const [rawTitle, body] = rangeText.split('!');
    const title = rawTitle.replace(/^'|'$/g, '').replace(/''/g, "'");
    if (!body) return { title, row: 1, column: 1, numRows: null, numColumns: null };
    // A1 / A1:E1 / A2:E（末尾を開ける）に対応する
    const cell = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d*))?$/.exec(body);
    const toNumber = (letters) => letters.split('')
      .reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0);
    const column = toNumber(cell[1]);
    const row = parseInt(cell[2], 10);
    return {
      title, row, column,
      // 末尾を開けた指定は「行数の指定なし」として扱う
      numRows: cell[4] ? parseInt(cell[4], 10) - row + 1 : (cell[3] ? null : 1),
      numColumns: cell[3] ? toNumber(cell[3]) - column + 1 : 1
    };
  }

  function respond(code, body) {
    return {
      getResponseCode: () => code,
      getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body))
    };
  }

  function fetch(url, options) {
    state.requests.push({ url, method: (options && options.method) || 'get' });
    const [path, query] = url.split('?');
    const params = new URLSearchParams(query || '');
    const payload = options && options.payload ? JSON.parse(options.payload) : null;

    // 新規作成
    if (path === 'https://sheets.googleapis.com/v4/spreadsheets') {
      return respond(200, { spreadsheetId: 'ss-new' });
    }

    const rest = path.replace('https://sheets.googleapis.com/v4/spreadsheets/', '');

    // batchUpdate
    if (rest === `${state.id}:batchUpdate`) {
      const replies = payload.requests.map(request => {
        if (request.addSheet) {
          const properties = Object.assign(
            { sheetId: 200 + state.sheets.length, title: 'シート' + (state.sheets.length + 1),
              index: state.sheets.length, hidden: false,
              gridProperties: { rowCount: 1000, columnCount: 26 } },
            request.addSheet.properties);
          state.sheets.push(properties);
          state.values[properties.title] = [];
          return { addSheet: { properties } };
        }
        if (request.updateSheetProperties) {
          const properties = request.updateSheetProperties.properties;
          const sheet = state.sheets.filter(s => s.sheetId === properties.sheetId)[0];
          if (properties.title) {
            state.values[properties.title] = state.values[sheet.title];
            delete state.values[sheet.title];
            sheet.title = properties.title;
          }
          if (properties.hidden !== undefined) sheet.hidden = properties.hidden;
          return {};
        }
        if (request.deleteDimension) {
          const range = request.deleteDimension.range;
          const sheet = state.sheets.filter(s => s.sheetId === range.sheetId)[0];
          state.values[sheet.title].splice(range.startIndex, range.endIndex - range.startIndex);
          return {};
        }
        if (request.repeatCell) {
          const format = request.repeatCell.cell
            && request.repeatCell.cell.userEnteredFormat
            && request.repeatCell.cell.userEnteredFormat.numberFormat;
          if (format && (format.type === 'DATE' || format.type === 'DATE_TIME')) {
            // 表示形式が日付になった列を覚える（以後の読みで Date に戻る）
            const column = request.repeatCell.range.startColumnIndex + 1;
            if (state.dateColumns.indexOf(column) < 0) state.dateColumns.push(column);
          }
          state.formats.push(request.repeatCell);
          return {};
        }
        if (request.insertDimension) {
          const range = request.insertDimension.range;
          const sheet = state.sheets.filter(s => s.sheetId === range.sheetId)[0];
          const blanks = Array.from({ length: range.endIndex - range.startIndex }, () => []);
          state.values[sheet.title].splice(range.startIndex, 0, ...blanks);
          return {};
        }
        return {};
      });
      return respond(200, { replies });
    }

    // 値の消去
    if (rest.endsWith(':clear')) {
      const rangeText = decodeURIComponent(rest.replace(`${state.id}/values/`, '').replace(/:clear$/, ''));
      const target = parseA1(rangeText);
      const grid = state.values[target.title];
      for (let r = 0; r < target.numRows; r++) {
        if (!grid[target.row - 1 + r]) continue;
        for (let c = 0; c < target.numColumns; c++) grid[target.row - 1 + r][target.column - 1 + c] = '';
      }
      return respond(200, {});
    }

    // 末尾への追記（values.append）。本物と同じく、書く先はサーバ側が決めて応答で返す。
    if (rest.startsWith(`${state.id}/values/`) && rest.endsWith(':append')) {
      const rangeText = decodeURIComponent(rest.replace(`${state.id}/values/`, '').replace(/:append$/, ''));
      const title = rangeText.split('!')[0].replace(/^'|'$/g, '').replace(/''/g, "'");
      const grid = state.values[title];
      const startRow = trim(grid || []).length + 1;
      payload.values.forEach((row, r) => {
        const rowIndex = startRow - 1 + r;
        while (grid.length <= rowIndex) grid.push([]);
        grid[rowIndex] = row.map((value, c) => state.normalize(value, c + 1));
      });
      const endRow = startRow + payload.values.length - 1;
      const width = Math.max(1, ...payload.values.map(row => row.length));
      const letter = (n) => {
        let out = '';
        while (n > 0) { const rem = (n - 1) % 26; out = String.fromCharCode(65 + rem) + out; n = Math.floor((n - 1) / 26); }
        return out;
      };
      return respond(200, {
        updates: { updatedRange: `${rangeText.split('!')[0]}!A${startRow}:${letter(width)}${endRow}` }
      });
    }

    // 値の書き込み
    if (rest.startsWith(`${state.id}/values/`) && options && options.method === 'put') {
      const rangeText = decodeURIComponent(rest.replace(`${state.id}/values/`, ''));
      const target = parseA1(rangeText);
      const grid = state.values[target.title];
      payload.values.forEach((row, r) => {
        const rowIndex = target.row - 1 + r;
        while (grid.length <= rowIndex) grid.push([]);
        row.forEach((value, c) => {
          const columnIndex = target.column - 1 + c;
          while (grid[rowIndex].length < columnIndex) grid[rowIndex].push('');
          grid[rowIndex][columnIndex] = state.normalize(value, columnIndex + 1);
        });
      });
      return respond(200, { updatedCells: payload.values.length });
    }

    // 値の読み取り
    if (rest.startsWith(`${state.id}/values/`)) {
      const rangeText = decodeURIComponent(rest.replace(`${state.id}/values/`, ''));
      const target = parseA1(rangeText);
      const whole = state.values[target.title] || [];
      // 範囲を指定されたらその矩形だけを返す（本物と同じく、末尾の空セルは詰める）
      const picked = (target.numRows === null && target.numColumns === null)
        ? whole
        : whole
          .slice(target.row - 1, target.row - 1 + target.numRows)
          .map(row => row.slice(target.column - 1, target.column - 1 + target.numColumns));
      const grid = trim(picked.map(row => (row || []).slice()));
      if (params.get('valueRenderOption') === 'FORMATTED_VALUE') {
        return respond(200, { values: grid.map(row => row.map(v => String(v))) });
      }
      return respond(200, { values: grid });
    }

    // 表示形式（日付列の判定に使う）
    if (params.get('includeGridData') === 'true') {
      const rowData = [{
        values: Array.from({ length: 26 }, (unused, index) => ({
          effectiveFormat: {
            numberFormat: { type: state.dateColumns.indexOf(index + 1) >= 0 ? 'DATE' : 'NUMBER' }
          }
        }))
      }];
      return respond(200, { sheets: [{ data: [{ rowData }] }] });
    }

    // シート構成
    if (rest === state.id) {
      return respond(200, {
        spreadsheetId: state.id,
        properties: { title: '週案データベース', timeZone: state.timeZone },
        sheets: state.sheets.map(properties => ({ properties }))
      });
    }

    return respond(404, { error: { message: 'not found: ' + url } });
  }

  return { state, fetch };
}

/** 18_SheetsApi.gs を偽の GAS 環境で読み込み、必要な関数を取り出す。 */
function loadFacade(fake) {
  const globals = {
    UrlFetchApp: { fetch: fake.fetch },
    ScriptApp: { getOAuthToken: () => 'test-token' },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: {
      // ファサードが使うのは 'Z'（タイムゾーンのオフセット）だけ
      formatDate: () => '+0900',
      sleep: () => {},
      getUuid: () => 'uuid'
    },
    logInfo: () => {}
  };
  const names = Object.keys(globals);
  const factory = new Function(...names, `
    ${SOURCE}
    return { sheetsOpenById_, sheetsCreate_, sheetsParseA1_, sheetsColumnLetter_,
             sheetsSerialToDate_, sheetsDateToSerial_, sheetsParseColor_, sheetsQuoteTitle_,
             sheetsExportSheetAsPdf_ };
  `);
  return factory(...names.map(name => globals[name]));
}

// ---------------------------------------------------------------- 座標・色

test('A1 記法を矩形に直せる', () => {
  const api = loadFacade(createFakeSheets());
  assert.deepEqual(api.sheetsParseA1_('A1'), { row: 1, column: 1, numRows: 1, numColumns: 1 });
  assert.deepEqual(api.sheetsParseA1_('A1:E1'), { row: 1, column: 1, numRows: 1, numColumns: 5 });
  assert.deepEqual(api.sheetsParseA1_('B2:C4'), { row: 2, column: 2, numRows: 3, numColumns: 2 });
  // 行が省略された指定（列まるごと）は、行数を呼び出し側でシートの大きさに合わせる
  assert.deepEqual(api.sheetsParseA1_('A:A'), { row: 1, column: 1, numRows: null, numColumns: 1 });
});

test('列番号を A1 の列名にできる', () => {
  const api = loadFacade(createFakeSheets());
  assert.equal(api.sheetsColumnLetter_(1), 'A');
  assert.equal(api.sheetsColumnLetter_(26), 'Z');
  assert.equal(api.sheetsColumnLetter_(27), 'AA');
  assert.equal(api.sheetsColumnLetter_(52), 'AZ');
});

test('シート名の引用符をエスケープする', () => {
  const api = loadFacade(createFakeSheets());
  assert.equal(api.sheetsQuoteTitle_('データベース'), "'データベース'");
  assert.equal(api.sheetsQuoteTitle_("it's"), "'it''s'");
});

test('色を Sheets API の形式に直せる', () => {
  const api = loadFacade(createFakeSheets());
  assert.deepEqual(api.sheetsParseColor_('#ffffff'), { red: 1, green: 1, blue: 1 });
  assert.deepEqual(api.sheetsParseColor_('white'), { red: 1, green: 1, blue: 1 });
  assert.deepEqual(api.sheetsParseColor_('#000000'), { red: 0, green: 0, blue: 0 });
});

// ---------------------------------------------------------------- 日付

test('シリアル値と Date を往復できる', () => {
  const api = loadFacade(createFakeSheets());
  // 2026/08/19 00:00 (JST) のシリアル値
  const date = api.sheetsSerialToDate_(46253, 'Asia/Tokyo');
  assert.ok(date instanceof Date);
  assert.equal(date.toISOString(), '2026-08-18T15:00:00.000Z'); // JST の 8/19 0:00
  assert.equal(Math.round(api.sheetsDateToSerial_(date, 'Asia/Tokyo')), 46253);
});

test('日付列は Date に戻る（週案の行照合が成り立つ条件）', () => {
  const fake = createFakeSheets({
    values: [
      ['第何週', '日付', '曜日'],
      [1, 46253, '水'],
      [1, 46254, '木']
    ],
    dateColumns: [2]
  });
  const api = loadFacade(fake);
  const sheet = api.sheetsOpenById_('ss-1').getSheetByName('データベース');
  const rows = sheet.getRange(2, 1, 2, 3).getValues();

  assert.ok(rows[0][1] instanceof Date, '日付列が Date になっていない');
  assert.ok(rows[1][1] instanceof Date);
  // 日付以外の数値は数値のまま
  assert.equal(rows[0][0], 1);
  assert.equal(rows[0][2], '水');
});

// ---------------------------------------------------------------- 読み取り

test('getLastRow / getLastColumn はデータのある範囲を返す', () => {
  const fake = createFakeSheets({
    values: [['a', 'b', 'c'], ['d'], ['e', 'f']]
  });
  const api = loadFacade(fake);
  const sheet = api.sheetsOpenById_('ss-1').getSheetByName('データベース');
  assert.equal(sheet.getLastRow(), 3);
  assert.equal(sheet.getLastColumn(), 3);
  // シートの大きさ（1000行）とは別物であること
  assert.equal(sheet.getMaxRows(), 1000);
});

test('要求したサイズの矩形が返る（足りないところは空文字で埋める）', () => {
  const fake = createFakeSheets({ values: [['a', 'b'], ['c']] });
  const api = loadFacade(fake);
  const sheet = api.sheetsOpenById_('ss-1').getSheetByName('データベース');

  const rows = sheet.getRange(1, 1, 3, 4).getValues();
  assert.equal(rows.length, 3);
  rows.forEach(row => assert.equal(row.length, 4));
  assert.deepEqual(rows[0], ['a', 'b', '', '']);
  assert.deepEqual(rows[1], ['c', '', '', '']);
  assert.deepEqual(rows[2], ['', '', '', '']);
});

test('getDataRange はデータのある範囲全体になる', () => {
  const fake = createFakeSheets({ values: [['a', 'b'], ['c', 'd']] });
  const api = loadFacade(fake);
  const sheet = api.sheetsOpenById_('ss-1').getSheetByName('データベース');
  assert.deepEqual(sheet.getDataRange().getValues(), [['a', 'b'], ['c', 'd']]);
});

test('A1 記法の getRange も使える', () => {
  const fake = createFakeSheets({ values: [['a', 'b', 'c', 'd', 'e']] });
  const api = loadFacade(fake);
  const sheet = api.sheetsOpenById_('ss-1').getSheetByName('データベース');
  assert.deepEqual(sheet.getRange('A1:E1').getValues(), [['a', 'b', 'c', 'd', 'e']]);
  assert.equal(sheet.getRange('A1').getValue(), 'a');
});

// ---------------------------------------------------------------- 書き込み

test('書き込んだあとの読みは、シートが解釈し直した値になる', () => {
  // スプレッドシートは "1/3" を日付に、"007" を 7 に変える。
  // 送った値をそのまま返すと、保存のたびに「競合」と誤判定される。
  const fake = createFakeSheets({
    values: [['', '']],
    normalize: (value) => (value === '007' ? 7 : value)
  });
  const api = loadFacade(fake);
  const sheet = api.sheetsOpenById_('ss-1').getSheetByName('データベース');

  sheet.getRange(1, 1, 1, 2).setValues([['007', 'そのまま']]);
  const readBack = sheet.getRange(1, 1, 1, 2).getValues();

  assert.equal(readBack[0][0], 7, 'シートが解釈し直した値を読めていない');
  assert.equal(readBack[0][1], 'そのまま');
});

test('追記はシート全体を読み直さない（ログ出力が重くならないように）', () => {
  const fake = createFakeSheets({ values: [['見出し']] });
  const api = loadFacade(fake);
  const sheet = api.sheetsOpenById_('ss-1').getSheetByName('データベース');

  const countReads = () => fake.state.requests
    .filter(r => r.method === 'get' && r.url.indexOf('/values/') >= 0).length;

  sheet.appendRow(['1行目']);
  const afterFirst = countReads();
  sheet.appendRow(['2行目']);
  sheet.appendRow(['3行目']);

  assert.equal(countReads(), afterFirst, '追記のたびにシートを読み直している');
  assert.equal(sheet.getLastRow(), 4);
});

test('追記は values.append を使い、シートを一度も読まない', () => {
  // 監査ログのように増え続けるシートでは、追記のたびに全体を読むと重くなり、
  // やがて UrlFetch の応答上限（50MB）に達して追記そのものが失敗する。
  const fake = createFakeSheets({ values: [['見出し'], ['既存1'], ['既存2']] });
  const api = loadFacade(fake);
  const sheet = api.sheetsOpenById_('ss-1').getSheetByName('データベース');

  fake.state.requests.length = 0;
  sheet.appendRow(['追記した行']);

  const reads = fake.state.requests.filter(r => r.method === 'get' && r.url.indexOf('/values/') >= 0);
  assert.equal(reads.length, 0, '追記のためにシートを読んでいる');

  const appended = fake.state.requests.filter(r => r.url.indexOf(':append') >= 0);
  assert.equal(appended.length, 1, 'values.append が使われていない');

  // 既存行の下に入っていること
  assert.deepEqual(sheet.getRange(4, 1).getValues(), [['追記した行']]);
  assert.equal(sheet.getLastRow(), 4);
});

test('Date を書くとシリアル値として送られる', () => {
  const fake = createFakeSheets({ values: [['']], dateColumns: [1] });
  const api = loadFacade(fake);
  const sheet = api.sheetsOpenById_('ss-1').getSheetByName('データベース');

  sheet.getRange(1, 1).setValue(new Date('2026-08-18T15:00:00.000Z')); // JST 8/19 0:00
  const sent = fake.state.requests.filter(r => r.method === 'put').pop();
  assert.ok(sent, '書き込みが飛んでいない');

  // 書いた値を読み戻すと Date に戻る
  const readBack = sheet.getRange(1, 1).getValue();
  assert.ok(readBack instanceof Date);
  assert.equal(readBack.toISOString(), '2026-08-18T15:00:00.000Z');
});

test('clearContent は値だけを消す', () => {
  const fake = createFakeSheets({ values: [['a', 'b'], ['c', 'd']] });
  const api = loadFacade(fake);
  const sheet = api.sheetsOpenById_('ss-1').getSheetByName('データベース');

  sheet.getRange(1, 1, 2, 1).clearContent();
  assert.deepEqual(sheet.getRange(1, 1, 2, 2).getValues(), [['', 'b'], ['', 'd']]);
});

// ---------------------------------------------------------------- 行・シート操作

test('行の削除・挿入がシートに反映される', () => {
  const fake = createFakeSheets({ values: [['1'], ['2'], ['3']] });
  const api = loadFacade(fake);
  const sheet = api.sheetsOpenById_('ss-1').getSheetByName('データベース');

  sheet.deleteRow(2);
  assert.deepEqual(sheet.getRange(1, 1, 2, 1).getValues(), [['1'], ['3']]);

  sheet.insertRowBefore(1);
  assert.deepEqual(sheet.getRange(1, 1, 3, 1).getValues(), [[''], ['1'], ['3']]);
});

test('シートの追加・改名・取得ができる', () => {
  const fake = createFakeSheets();
  const api = loadFacade(fake);
  const spreadsheet = api.sheetsOpenById_('ss-1');

  const added = spreadsheet.insertSheet('単元マスタ');
  assert.equal(added.getName(), '単元マスタ');
  assert.ok(spreadsheet.getSheetByName('単元マスタ'));

  added.setName('単元マスタ2');
  assert.equal(added.getName(), '単元マスタ2');
  assert.ok(spreadsheet.getSheetByName('単元マスタ2'));
  assert.equal(spreadsheet.getSheetByName('単元マスタ'), null);
});

test('スプレッドシートの基本情報を返す', () => {
  const api = loadFacade(createFakeSheets());
  const spreadsheet = api.sheetsOpenById_('ss-1');
  assert.equal(spreadsheet.getId(), 'ss-1');
  assert.equal(spreadsheet.getName(), '週案データベース');
  assert.match(spreadsheet.getUrl(), /^https:\/\/docs\.google\.com\/spreadsheets\/d\/ss-1\/edit$/);
  assert.equal(spreadsheet.getSheets().length, 1);
});

test('新規作成は Sheets API の spreadsheets.create を叩く', () => {
  const fake = createFakeSheets();
  const api = loadFacade(fake);
  const created = api.sheetsCreate_('新しいDB');
  assert.equal(created.getId(), 'ss-new');
  const request = fake.state.requests.filter(r => r.method === 'post')[0];
  assert.equal(request.url, 'https://sheets.googleapis.com/v4/spreadsheets?fields=spreadsheetId');
});

test('日付を書いた列には日付の表示形式が付く', () => {
  // SpreadsheetApp は Date を書くとセルの表示形式も日付にする。REST は数値を書くだけなので、
  // 付け直さないとログの日時が「46253.5」のような数値で表示されてしまう。
  const fake = createFakeSheets({ values: [['見出し', '', '']] });
  const api = loadFacade(fake);
  const sheet = api.sheetsOpenById_('ss-1').getSheetByName('データベース');

  sheet.appendRow([new Date('2026-08-18T15:00:00.000Z'), 'INFO', 'メッセージ']);

  const applied = fake.state.formats.filter(f =>
    f.cell.userEnteredFormat.numberFormat.type === 'DATE'
    || f.cell.userEnteredFormat.numberFormat.type === 'DATE_TIME');
  assert.equal(applied.length, 1, '日付の表示形式が当てられていない');
  assert.equal(applied[0].range.startColumnIndex, 0, '日付を書いた列に当てていない');

  // 表示形式が付いたので、読み戻すと Date になる
  assert.ok(sheet.getRange(2, 1).getValue() instanceof Date);
});

test('日付列だと分かっていれば、表示形式を当て直さない', () => {
  // 「分かっている」＝そのシートの書式を既に読んである状態。書き込みのためだけに
  // 調べには行かない（シートの書式を200行ぶん取る往復が、書き込みのたびに増えるため）。
  const fake = createFakeSheets({ values: [['', '']], dateColumns: [1] });
  const api = loadFacade(fake);
  const sheet = api.sheetsOpenById_('ss-1').getSheetByName('データベース');

  sheet.getRange(1, 1).getValues(); // ここで日付列が分かる
  fake.state.formats.length = 0;

  sheet.getRange(1, 1).setValue(new Date('2026-08-18T15:00:00.000Z'));
  assert.equal(fake.state.formats.length, 0, '不要な書式設定を送っている');
});

test('日付列か分からないときは、調べに行かずに表示形式を付ける', () => {
  const fake = createFakeSheets({ values: [['', '']] });
  const api = loadFacade(fake);
  const sheet = api.sheetsOpenById_('ss-1').getSheetByName('データベース');

  sheet.getRange(1, 1).setValue(new Date('2026-08-18T15:00:00.000Z'));

  const probes = fake.state.requests.filter(r => r.url.indexOf('includeGridData') >= 0);
  assert.equal(probes.length, 0, '書き込みのために書式を調べに行っている');
  assert.equal(fake.state.formats.length, 1, '日付の表示形式が付いていない');
});

// ---------------------------------------------------------------- PDF 書き出し

test('PDF 書き出しは、権限で断られたら Drive API に切り替える', () => {
  // レイアウト指定つきの export は Drive 側の権限で決まり、drive.file だけのトークンで
  // 通るかは環境に依存する。断られたまま失敗させず、Drive API の書き出しへ移る。
  const calls = [];
  const globals = {
    UrlFetchApp: {
      fetch: (url) => {
        calls.push(url);
        const denied = url.indexOf('docs.google.com') >= 0;
        return {
          getResponseCode: () => (denied ? 403 : 200),
          getContentText: () => (denied ? 'forbidden' : ''),
          getBlob: () => ({ setName: (name) => ({ name }) })
        };
      }
    },
    ScriptApp: { getOAuthToken: () => 'test-token' },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: { formatDate: () => '+0900', sleep: () => {}, getUuid: () => 'uuid' },
    logInfo: () => {}
  };
  const names = Object.keys(globals);
  const api = new Function(...names, `${SOURCE}\nreturn { sheetsExportSheetAsPdf_ };`)(
    ...names.map(name => globals[name]));

  const blob = api.sheetsExportSheetAsPdf_('ss-1', 123, '学級通信.pdf');
  assert.equal(blob.name, '学級通信.pdf');
  assert.equal(calls.length, 2, 'フォールバックしていない');
  assert.match(calls[0], /docs\.google\.com/);
  assert.match(calls[1], /www\.googleapis\.com\/drive\/v3\/files\/ss-1\/export/);
});

// ---------------------------------------------------------------- 網羅性

test('呼び出し側が使うメソッドは、すべてファサードに実装されている', () => {
  // 実装漏れは本番でしか出ない TypeError になる。呼び出し側で
  // sheet / range / ss らしき変数に対して呼ばれているメソッドを拾い、
  // ファサードの実装と突き合わせて漏れを防ぐ。
  const implemented = new Set(
    [...SOURCE.matchAll(/^\s{4}([a-zA-Z_][a-zA-Z0-9_]*): function/gm)].map(m => m[1]));

  // 変数名がたまたま一致するだけの、スプレッドシートと関係ない呼び出し
  const unrelated = new Set([
    'forEach', 'map', 'filter', 'push', 'join', 'indexOf', 'slice', 'split', 'sort',
    'includes', 'find', 'some', 'every', 'reduce', 'concat', 'trim', 'replace',
    'toString', 'substring', 'has', 'get', 'set', 'add', 'keys', 'values',
    'findIndex', 'shift', 'pop', 'splice', 'reverse', 'fill', 'unshift', 'match',
    'toLowerCase', 'toUpperCase', 'padStart', 'lastIndexOf', 'trimEnd', 'normalize', 'entries'
  ]);

  // 「Session」のような無関係な識別子を拾わないよう、ss は語全体で一致させる
  const pattern = /\b(\w*(?:[Ss]heet|[Rr]ange)\w*|ss)\s*\.\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  const missing = [];
  for (const file of fs.readdirSync('.').filter(n => n.endsWith('.gs')).sort()) {
    if (file === '18_SheetsApi.gs') continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      for (const m of line.matchAll(pattern)) {
        const method = m[2];
        if (implemented.has(method) || unrelated.has(method)) continue;
        missing.push(`${file}:${index + 1}: ${m[1]}.${method}()`);
      }
    });
  }
  assert.deepEqual(missing, [],
    `ファサードに無いメソッドが呼ばれています。18_SheetsApi.gs に足してください:\n${missing.join('\n')}`);
});
