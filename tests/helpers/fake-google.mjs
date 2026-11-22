// Google の API を、メモリの上で代わりに応えるテスト用の足場。
//
// このアプリは SpreadsheetApp / DriveApp を使わず、Sheets REST v4 と Drive REST v3 を
// UrlFetchApp で直接呼ぶ（drive.file スコープを保つため。18_SheetsApi.gs / 17_DriveApi.gs）。
// つまり「UrlFetchApp.fetch の応答」さえ差し替えれば、リポジトリの .gs をそのまま
// Node の上で動かせる。gas-runtime.mjs と組にして使う。
//
// 応えるもの:
//   - Sheets: 構成の取得・値の読み書き・追記・消去・batchGet・batchUpdate・copyTo・新規作成
//   - Drive : アップロード・取得・一覧・名前変更／ごみ箱・複製・共有
//   - Gemini: generateContent とモデル一覧（応答は geminiResponder で決める）
//   - 祝日 CSV、tokeninfo
//
// ⚠️ USER_ENTERED の読み替え（"9:00" → 0.375、"10/15" → 日付 など）は、Google の実装を
//    **近似**したものです。公式の説明（「画面に打ちこんだときと同じ規則で解釈する」）に
//    沿って、よくある形だけを再現しています。ここで通ることは「アプリの側の経路が
//    正しい」ことの確認であって、本物のシートの挙動の証明ではありません。

export const SHEETS_EPOCH = Date.UTC(1899, 11, 30);
const JST = 9 * 3600 * 1000;

export function serialFromYmd(y, m, d) { return (Date.UTC(y, m - 1, d) - SHEETS_EPOCH) / 86400000; }
export function ymdFromSerial(serial) {
  const t = new Date(SHEETS_EPOCH + Math.round(serial * 86400000));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(),
    hh: t.getUTCHours(), mm: t.getUTCMinutes(), ss: t.getUTCSeconds() };
}
const pad = (n) => String(n).padStart(2, '0');

function colNumber(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** 'シート名'!A1:C3 / A1:C / A:C / 1:200 / シート名 を矩形にする（null は開いた端） */
export function parseRange(rangeText) {
  let text = rangeText;
  let title = null;
  const bang = text.lastIndexOf('!');
  if (bang >= 0) { title = text.slice(0, bang); text = text.slice(bang + 1); }
  else if (!/^[A-Z]*\d*(:[A-Z]*\d*)?$/.test(text)) { title = text; text = ''; }
  if (title !== null) title = title.replace(/^'|'$/g, '').replace(/''/g, "'");
  const rect = { title, r1: 1, c1: 1, r2: null, c2: null };
  if (!text) return rect;
  const [a, b] = text.split(':');
  const one = (s) => { const m = /^([A-Z]*)(\d*)$/.exec(s); return { c: m[1] ? colNumber(m[1]) : null, r: m[2] ? parseInt(m[2], 10) : null }; };
  const p = one(a);
  rect.r1 = p.r || 1; rect.c1 = p.c || 1;
  if (b === undefined) { rect.r2 = p.r || null; rect.c2 = p.c || null; if (p.r && p.c) { rect.r2 = p.r; rect.c2 = p.c; } return rect; }
  const q = one(b);
  rect.r2 = q.r; rect.c2 = q.c;
  return rect;
}

export class FakeGoogle {
  constructor() {
    // id -> { id, title, sheets: [ {sheetId,title,hidden,grid,formats,rowCount,columnCount} ] }
    this.spreadsheets = new Map();
    this.files = new Map();          // id -> { id, name, mimeType, content(Buffer|string), trashed, createdTime }
    this.seq = 1;
    this.log = [];                   // 往復の記録
    this.permissions = [];
    this.geminiCalls = [];
    this.geminiResponder = null;     // (model, body) => string | null
    this.geminiModels = null;        // (apiKey) => モデル一覧。キーごとに違う一覧を返したいとき
    this.failNext = null;            // (url) => {code, body} | null
  }

  newId(prefix) { return `${prefix}_${String(this.seq++).padStart(4, '0')}_fakefakefakefakefakefakefakefake`; }

  createSpreadsheet(title, id) {
    const ss = { id: id || this.newId('ss'), title, sheets: [], nextSheetId: 1 };
    this.addSheet(ss, 'シート1');
    this.spreadsheets.set(ss.id, ss);
    this.files.set(ss.id, { id: ss.id, name: title, mimeType: 'application/vnd.google-apps.spreadsheet', trashed: false, createdTime: new Date().toISOString() });
    return ss;
  }
  addSheet(ss, title, props = {}) {
    const sheet = { sheetId: ss.nextSheetId++, title, hidden: !!props.hidden, grid: [], formats: {},
      rowCount: (props.gridProperties && props.gridProperties.rowCount) || 1000,
      columnCount: (props.gridProperties && props.gridProperties.columnCount) || 26 };
    ss.sheets.push(sheet);
    return sheet;
  }
  sheetByTitle(ss, title) { return ss.sheets.find((s) => s.title === title) || null; }
  sheetProps(ss, sheet) {
    return { sheetId: sheet.sheetId, title: sheet.title, index: ss.sheets.indexOf(sheet), hidden: sheet.hidden,
      gridProperties: { rowCount: Math.max(sheet.rowCount, sheet.grid.length), columnCount: Math.max(sheet.columnCount, ...sheet.grid.map((r) => r.length), 1) } };
  }

  // ---- 値の読み書き ----
  cellFormat(sheet, r, c) { return sheet.formats[`${r},${c}`] || sheet.formats[`col,${c}`] || null; }
  setCellFormat(sheet, r, c, fmt) { sheet.formats[`${r},${c}`] = fmt; }

  /** USER_ENTERED の読み替え（近似）。戻り値 { value, format } */
  interpretUserEntered(input, existingFormat) {
    if (typeof input !== 'string') return { value: input === null || input === undefined ? '' : input };
    if (existingFormat && existingFormat.type === 'TEXT') return { value: input };
    const s = input;
    if (s === '') return { value: '' };
    if (s.charAt(0) === "'") return { value: s.slice(1) };
    if (s.charAt(0) === '=' || /^\+[^\s]/.test(s)) {
      // 数式として解釈される。数どうしの四則（左から順）だけ計算し、ほかはエラー値にする。
      const expr = s.replace(/^=/, '');
      const whole = /^\s*([+-]?\d+(?:\.\d+)?)((?:\s*[-+*/]\s*\d+(?:\.\d+)?)*)\s*$/.exec(expr);
      if (whole) {
        let acc = parseFloat(whole[1]);
        for (const step of whole[2].matchAll(/([-+*/])\s*(\d+(?:\.\d+)?)/g)) {
          const n = parseFloat(step[2]);
          acc = step[1] === '+' ? acc + n : step[1] === '-' ? acc - n : step[1] === '*' ? acc * n : acc / n;
        }
        return { value: acc, formula: s };
      }
      return { value: '#NAME?', formula: s };
    }
    const t = s.trim();
    if (/^(true|false)$/i.test(t)) return { value: /^true$/i.test(t) };
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return { value: parseFloat(t.replace(/,/g, '')) };
    if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return { value: parseFloat(t) };
    if (/^-?\d+(\.\d+)?%$/.test(t)) return { value: parseFloat(t) / 100, format: { type: 'PERCENT' } };
    let m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(t);
    if (m) return { value: serialFromYmd(+m[1], +m[2], +m[3]), format: { type: 'DATE', shown: t.includes('-') ? 'ymd-dash' : 'ymd-slash' } };
    m = /^(\d{1,2})[/-](\d{1,2})$/.exec(t);
    if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) {
      return { value: serialFromYmd(new Date(Date.now() + JST).getUTCFullYear(), +m[1], +m[2]), format: { type: 'DATE', shown: 'md' } };
    }
    m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
    if (m && +m[1] < 24 && +m[2] < 60) return { value: (+m[1] * 3600 + +m[2] * 60 + (+m[3] || 0)) / 86400, format: { type: 'TIME' } };
    return { value: s };
  }

  writeValues(sheet, r1, c1, values, inputOption) {
    values.forEach((row, i) => {
      const r = r1 + i;
      while (sheet.grid.length < r) sheet.grid.push([]);
      const target = sheet.grid[r - 1];
      (row || []).forEach((raw, j) => {
        const c = c1 + j;
        while (target.length < c) target.push('');
        if (raw === null || raw === undefined) return; // null は「触らない」
        if (inputOption === 'USER_ENTERED') {
          const res = this.interpretUserEntered(raw, this.cellFormat(sheet, r, c));
          target[c - 1] = res.value;
          if (res.format) this.setCellFormat(sheet, r, c, res.format);
        } else {
          target[c - 1] = raw;
        }
      });
    });
  }

  readValues(sheet, rect, formatted) {
    const grid = sheet.grid;
    const r2 = rect.r2 === null ? grid.length : Math.min(rect.r2, grid.length);
    const out = [];
    for (let r = rect.r1; r <= r2; r++) {
      const row = grid[r - 1] || [];
      const c2 = rect.c2 === null ? row.length : Math.min(rect.c2, row.length);
      const line = [];
      for (let c = rect.c1; c <= c2; c++) {
        let v = row[c - 1];
        if (v === undefined || v === null) v = '';
        if (formatted) v = this.formatValue(v, this.cellFormat(sheet, r, c));
        line.push(v);
      }
      while (line.length && line[line.length - 1] === '') line.pop();
      out.push(line);
    }
    while (out.length && out[out.length - 1].length === 0) out.pop();
    return out;
  }

  formatValue(v, fmt) {
    if (typeof v === 'number' && fmt && (fmt.type === 'DATE' || fmt.type === 'DATE_TIME')) {
      const p = ymdFromSerial(v);
      // 本物のシートは、入力された形（2026-11-18 / 2026/11/18 / 11/18）に近い表示形式を自動で付ける
      const date = fmt.shown === 'ymd-dash' ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : fmt.shown === 'md' ? `${p.m}/${p.d}` : `${p.y}/${pad(p.m)}/${pad(p.d)}`;
      return fmt.type === 'DATE_TIME' ? `${date} ${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}` : date;
    }
    if (typeof v === 'number' && fmt && fmt.type === 'TIME') { const sec = Math.round(v * 86400); return `${Math.floor(sec / 3600)}:${pad(Math.floor(sec % 3600 / 60))}`; }
    if (typeof v === 'number' && fmt && fmt.type === 'PERCENT') return `${Math.round(v * 10000) / 100}%`;
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  }

  // ---- 入口 ----
  fetch(url, options) {
    const opt = options || {};
    const method = String(opt.method || 'get').toLowerCase();
    const u = String(url);
    const started = Date.now();
    let res;
    try {
      const forced = this.failNext && this.failNext(u, opt);
      if (forced) res = { code: forced.code, body: forced.body };
      else if (u.startsWith('https://sheets.googleapis.com/')) res = this.sheetsApi(u, method, opt);
      else if (u.startsWith('https://www.googleapis.com/upload/drive/') || u.startsWith('https://www.googleapis.com/drive/')) res = this.driveApi(u, method, opt);
      else if (u.startsWith('https://generativelanguage.googleapis.com/')) res = this.geminiApi(u, method, opt);
      else if (u.includes('syukujitsu.csv')) res = { code: 200, text: HOLIDAY_CSV };
      else if (u.includes('oauth2/v3/tokeninfo')) res = { code: 200, body: { aud: '123456789012-abcdef.apps.googleusercontent.com' } };
      else res = { code: 404, body: { error: { message: 'fake-google: unknown endpoint ' + u.slice(0, 120) } } };
    } catch (e) {
      res = { code: 500, body: { error: { message: 'fake-google crashed: ' + (e && e.stack || e) } } };
    }
    const text = res.text !== undefined ? res.text : (res.raw !== undefined ? '' : JSON.stringify(res.body === undefined ? {} : res.body));
    this.log.push({ method, url: decodeURIComponent(u).slice(0, 200), code: res.code, bytes: Buffer.byteLength(text), ms: Date.now() - started });
    const raw = res.raw;
    return {
      getResponseCode: () => res.code,
      getContentText: () => (raw !== undefined ? Buffer.from(raw).toString('utf8') : text),
      getHeaders: () => ({}),
      getBlob: () => ({ getBytes: () => Array.from(raw !== undefined ? Buffer.from(raw) : Buffer.from(text)), getDataAsString: () => (raw !== undefined ? Buffer.from(raw).toString('utf8') : text), getContentType: () => res.contentType || 'application/json' }),
      getContent: () => Array.from(raw !== undefined ? Buffer.from(raw) : Buffer.from(text)),
    };
  }

  // ---- Sheets ----
  sheetsApi(u, method, opt) {
    const base = 'https://sheets.googleapis.com/v4/spreadsheets';
    let rest = u.slice(base.length);
    const [pathPart, queryPart = ''] = rest.split('?');
    const query = new URLSearchParams(queryPart);
    const payload = opt.payload ? JSON.parse(opt.payload) : {};
    const notFound = (what) => ({ code: 404, body: { error: { code: 404, message: `Requested entity was not found. (${what})`, status: 'NOT_FOUND' } } });

    if (pathPart === '' || pathPart === '/') {
      if (method !== 'post') return notFound('root');
      const ss = this.createSpreadsheet((payload.properties && payload.properties.title) || '無題のスプレッドシート');
      return { code: 200, body: { spreadsheetId: ss.id } };
    }
    const m = /^\/([^/:]+)(.*)$/.exec(pathPart);
    const ssId = decodeURIComponent(m[1]);
    const tail = m[2];
    const ss = this.spreadsheets.get(ssId);
    if (!ss || (this.files.get(ssId) || {}).trashed) return notFound('spreadsheet ' + ssId);

    if (tail === '') {
      if (query.get('includeGridData') === 'true') {
        const rect = parseRange(query.get('ranges'));
        const sheet = this.sheetByTitle(ss, rect.title);
        if (!sheet) return { code: 400, body: { error: { message: 'Unable to parse range: ' + query.get('ranges') } } };
        const r2 = Math.min(rect.r2 || sheet.grid.length, sheet.grid.length);
        const rowData = [];
        const width = Math.max(1, ...sheet.grid.map((r) => r.length));
        for (let r = rect.r1; r <= r2; r++) {
          const values = [];
          for (let c = 1; c <= width; c++) {
            const fmt = this.cellFormat(sheet, r, c);
            values.push(fmt ? { effectiveFormat: { numberFormat: { type: fmt.type } } } : {});
          }
          rowData.push({ values });
        }
        return { code: 200, body: { sheets: [{ data: [{ rowData }] }] } };
      }
      return { code: 200, body: { spreadsheetId: ss.id, properties: { title: ss.title, timeZone: 'Asia/Tokyo' },
        sheets: ss.sheets.map((s) => ({ properties: this.sheetProps(ss, s) })) } };
    }
    if (tail === ':batchUpdate') return this.sheetsBatchUpdate(ss, payload.requests || []);
    if (tail === '/values:batchGet') {
      const formatted = query.get('valueRenderOption') === 'FORMATTED_VALUE';
      const valueRanges = [];
      for (const r of query.getAll('ranges')) {
        const rect = parseRange(r);
        const sheet = this.sheetByTitle(ss, rect.title);
        if (!sheet) return { code: 400, body: { error: { message: 'Unable to parse range: ' + r } } };
        valueRanges.push({ range: r, values: this.readValues(sheet, rect, formatted) });
      }
      return { code: 200, body: { valueRanges } };
    }
    let mm = /^\/sheets\/(\d+):copyTo$/.exec(tail);
    if (mm) {
      const src = ss.sheets.find((s) => s.sheetId === +mm[1]);
      const dest = this.spreadsheets.get(payload.destinationSpreadsheetId);
      if (!src || !dest) return notFound('copyTo');
      let title = src.title + ' のコピー';
      while (this.sheetByTitle(dest, title)) title += ' 2';
      const copy = this.addSheet(dest, title);
      copy.grid = src.grid.map((r) => r.slice());
      copy.formats = { ...src.formats };
      copy.rowCount = src.rowCount; copy.columnCount = src.columnCount;
      return { code: 200, body: this.sheetProps(dest, copy) };
    }
    mm = /^\/values\/(.+?)(:append|:clear)?$/.exec(tail);
    if (mm) {
      const rangeText = decodeURIComponent(mm[1]);
      const op = mm[2] || '';
      const rect = parseRange(rangeText);
      const sheet = this.sheetByTitle(ss, rect.title);
      if (!sheet) return { code: 400, body: { error: { message: 'Unable to parse range: ' + rangeText } } };
      if (op === ':append') {
        const start = sheet.grid.length + 1;
        // 本物は「表の末尾」を探す。ここではデータのある最終行の次。
        while (sheet.grid.length && sheet.grid[sheet.grid.length - 1].every((v) => v === '' || v === undefined)) sheet.grid.pop();
        const at = sheet.grid.length + 1;
        this.writeValues(sheet, at, rect.c1 || 1, payload.values || [], query.get('valueInputOption') || 'RAW');
        const n = (payload.values || []).length;
        void start;
        return { code: 200, body: { spreadsheetId: ss.id, updates: { updatedRange: `'${sheet.title}'!A${at}:Z${at + n - 1}`, updatedRows: n } } };
      }
      if (op === ':clear') {
        const r2 = rect.r2 === null ? sheet.grid.length : rect.r2;
        for (let r = rect.r1; r <= r2; r++) {
          const row = sheet.grid[r - 1]; if (!row) continue;
          const c2 = rect.c2 === null ? row.length : rect.c2;
          for (let c = rect.c1; c <= c2; c++) if (c - 1 < row.length) row[c - 1] = '';
        }
        return { code: 200, body: { clearedRange: rangeText } };
      }
      if (method === 'put' || method === 'post') {
        this.writeValues(sheet, rect.r1, rect.c1, payload.values || [], query.get('valueInputOption') || 'RAW');
        const body = { spreadsheetId: ss.id, updatedRange: rangeText, updatedCells: (payload.values || []).reduce((a, r) => a + r.length, 0) };
        if (query.get('includeValuesInResponse') === 'true') {
          const n = (payload.values || []).length;
          const w = Math.max(0, ...(payload.values || []).map((r) => r.length));
          body.updatedData = { range: rangeText, values: this.readValues(sheet, { r1: rect.r1, c1: rect.c1, r2: rect.r1 + n - 1, c2: rect.c1 + w - 1 }, query.get('responseValueRenderOption') === 'FORMATTED_VALUE') };
        }
        return { code: 200, body };
      }
      return { code: 200, body: { range: rangeText, majorDimension: 'ROWS', values: this.readValues(sheet, rect, query.get('valueRenderOption') === 'FORMATTED_VALUE') } };
    }
    return notFound('sheets path ' + tail);
  }

  sheetsBatchUpdate(ss, requests) {
    const replies = [];
    const bySheetId = (id) => ss.sheets.find((s) => s.sheetId === id);
    for (const req of requests) {
      const kind = Object.keys(req)[0];
      const body = req[kind];
      let reply = {};
      if (kind === 'addSheet') {
        const title = (body.properties && body.properties.title) || `シート${ss.sheets.length + 1}`;
        if (this.sheetByTitle(ss, title)) return { code: 400, body: { error: { message: `A sheet with the name "${title}" already exists.` } } };
        const sheet = this.addSheet(ss, title, body.properties || {});
        reply = { addSheet: { properties: this.sheetProps(ss, sheet) } };
      } else if (kind === 'deleteSheet') {
        ss.sheets = ss.sheets.filter((s) => s.sheetId !== body.sheetId);
      } else if (kind === 'updateSheetProperties') {
        const sheet = bySheetId(body.properties.sheetId);
        if (sheet) {
          if (body.fields.includes('title')) sheet.title = body.properties.title;
          if (body.fields.includes('hidden')) sheet.hidden = !!body.properties.hidden;
          if (body.properties.gridProperties) Object.assign(sheet, { rowCount: body.properties.gridProperties.rowCount || sheet.rowCount, columnCount: body.properties.gridProperties.columnCount || sheet.columnCount });
        }
      } else if (kind === 'repeatCell') {
        const rg = body.range || {};
        const sheet = bySheetId(rg.sheetId);
        const nf = body.cell && body.cell.userEnteredFormat && body.cell.userEnteredFormat.numberFormat;
        if (sheet && nf) {
          const r1 = (rg.startRowIndex || 0) + 1, r2 = rg.endRowIndex || Math.max(sheet.grid.length, 400);
          const c1 = (rg.startColumnIndex || 0) + 1, c2 = rg.endColumnIndex || c1;
          for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) this.setCellFormat(sheet, r, c, { type: nf.type, pattern: nf.pattern });
        }
      } else if (kind === 'insertDimension' || kind === 'deleteDimension') {
        const rg = body.range;
        const sheet = bySheetId(rg.sheetId);
        if (sheet) {
          const count = rg.endIndex - rg.startIndex;
          if (rg.dimension === 'ROWS') {
            if (kind === 'insertDimension') sheet.grid.splice(rg.startIndex, 0, ...Array.from({ length: count }, () => []));
            else sheet.grid.splice(rg.startIndex, count);
          } else {
            sheet.grid.forEach((row) => { if (kind === 'insertDimension') row.splice(rg.startIndex, 0, ...new Array(count).fill('')); else row.splice(rg.startIndex, count); });
          }
        }
      } else if (kind === 'appendDimension') {
        const sheet = bySheetId(body.sheetId);
        if (sheet) { if (body.dimension === 'ROWS') sheet.rowCount += body.length; else sheet.columnCount += body.length; }
      } else if (kind === 'sortRange') {
        const rg = body.range; const sheet = bySheetId(rg.sheetId);
        if (sheet) {
          const start = rg.startRowIndex || 0, end = rg.endRowIndex || sheet.grid.length;
          const part = sheet.grid.slice(start, end);
          const specs = body.sortSpecs || [];
          part.sort((a, b) => { for (const sp of specs) { const i = sp.dimensionIndex; const x = a[i] ?? '', y = b[i] ?? ''; if (x < y) return sp.sortOrder === 'DESCENDING' ? 1 : -1; if (x > y) return sp.sortOrder === 'DESCENDING' ? -1 : 1; } return 0; });
          sheet.grid.splice(start, part.length, ...part);
        }
      } else if (kind === 'addProtectedRange') {
        reply = { addProtectedRange: { protectedRange: { protectedRangeId: this.seq++ } } };
      }
      // それ以外（書式・枠線・幅など）は見た目だけなので受け流す
      this.batchKinds = this.batchKinds || {};
      this.batchKinds[kind] = (this.batchKinds[kind] || 0) + 1;
      replies.push(reply);
    }
    return { code: 200, body: { spreadsheetId: ss.id, replies } };
  }

  // ---- Drive ----
  driveApi(u, method, opt) {
    const isUpload = u.startsWith('https://www.googleapis.com/upload/drive/v3');
    const base = isUpload ? 'https://www.googleapis.com/upload/drive/v3' : 'https://www.googleapis.com/drive/v3';
    const [pathPart, queryPart = ''] = u.slice(base.length).split('?');
    const query = new URLSearchParams(queryPart);
    const notFound = (id) => ({ code: 404, body: { error: { code: 404, message: `File not found: ${id}.` } } });
    const meta = (f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, trashed: !!f.trashed, createdTime: f.createdTime, modifiedTime: f.modifiedTime || f.createdTime, size: f.content ? String(Buffer.byteLength(f.content)) : undefined, webViewLink: `https://drive.google.com/file/d/${f.id}/view`, parents: ['root'] });

    if (isUpload && pathPart === '/files' && method === 'post') {
      const id = this.newId('file');
      const file = { id, name: 'Untitled', mimeType: opt.contentType || 'application/octet-stream', trashed: false, createdTime: new Date().toISOString() };
      const payload = opt.payload;
      if (query.get('uploadType') === 'multipart') {
        // 本体は文字列（HTML→ドキュメント変換など）か、バイト列
        const text = typeof payload === 'string' ? payload : Buffer.from(payload && payload.getBytes ? payload.getBytes() : payload || []).toString('utf8');
        const metaMatch = /\{[\s\S]*?\}/.exec(text);
        try { Object.assign(file, JSON.parse(metaMatch[0])); } catch (e) { /* noop */ }
        file.content = text;
      } else {
        file.content = payload && payload.getBytes ? Buffer.from(payload.getBytes()) : (typeof payload === 'string' ? payload : Buffer.from(payload || []));
        if (payload && payload.getContentType && payload.getContentType()) file.mimeType = payload.getContentType();
      }
      this.files.set(id, file);
      return { code: 200, body: { id, name: file.name } };
    }
    if (pathPart === '/files' && method === 'get') {
      const q = query.get('q') || '';
      let list = [...this.files.values()];
      if (/trashed\s*=\s*false/.test(q)) list = list.filter((f) => !f.trashed);
      const nameContains = /name contains '([^']*)'/.exec(q); if (nameContains) list = list.filter((f) => f.name.includes(nameContains[1].replace(/\\'/g, "'")));
      const nameEq = /name\s*=\s*'([^']*)'/.exec(q); if (nameEq) list = list.filter((f) => f.name === nameEq[1]);
      const mime = /mimeType\s*=\s*'([^']*)'/.exec(q); if (mime) list = list.filter((f) => f.mimeType === mime[1]);
      return { code: 200, body: { files: list.map(meta) } };
    }
    let m = /^\/files\/([^/]+)\/copy$/.exec(pathPart);
    if (m && method === 'post') {
      const src = this.files.get(decodeURIComponent(m[1]));
      if (!src || src.trashed) return notFound(m[1]);
      const body = opt.payload ? JSON.parse(opt.payload) : {};
      let id;
      if (this.spreadsheets.has(src.id)) {
        const from = this.spreadsheets.get(src.id);
        const copy = { id: this.newId('ss'), title: body.name || from.title + ' のコピー', nextSheetId: from.nextSheetId,
          sheets: from.sheets.map((s) => ({ ...s, grid: s.grid.map((r) => r.slice()), formats: { ...s.formats } })) };
        this.spreadsheets.set(copy.id, copy);
        id = copy.id;
        this.files.set(id, { id, name: copy.title, mimeType: src.mimeType, trashed: false, createdTime: new Date().toISOString() });
      } else {
        id = this.newId('file');
        this.files.set(id, { ...src, id, name: body.name || src.name, createdTime: new Date().toISOString() });
      }
      return { code: 200, body: { id, name: this.files.get(id).name } };
    }
    m = /^\/files\/([^/]+)\/permissions$/.exec(pathPart);
    if (m && method === 'post') {
      this.permissions.push({ fileId: decodeURIComponent(m[1]), body: JSON.parse(opt.payload || '{}') });
      return { code: 200, body: { id: 'perm_' + this.seq++ } };
    }
    m = /^\/files\/([^/]+)$/.exec(pathPart);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const file = this.files.get(id);
      if (!file) return notFound(id);
      if (method === 'get') {
        if (query.get('alt') === 'media') {
          if (file.trashed) return notFound(id);
          return typeof file.content === 'string' ? { code: 200, text: file.content } : { code: 200, raw: file.content || Buffer.alloc(0), contentType: file.mimeType };
        }
        return { code: 200, body: meta(file) };
      }
      if (method === 'patch') {
        const body = opt.payload ? (typeof opt.payload === 'string' ? JSON.parse(opt.payload) : null) : {};
        if (isUpload) { file.content = typeof opt.payload === 'string' ? opt.payload : Buffer.from(opt.payload.getBytes ? opt.payload.getBytes() : opt.payload); file.modifiedTime = new Date().toISOString(); return { code: 200, body: meta(file) }; }
        if (body) { Object.assign(file, body); if (this.spreadsheets.has(id) && body.name) this.spreadsheets.get(id).title = body.name; }
        file.modifiedTime = new Date().toISOString();
        return { code: 200, body: meta(file) };
      }
      if (method === 'delete') { this.files.delete(id); this.spreadsheets.delete(id); return { code: 204, text: '' }; }
    }
    return { code: 404, body: { error: { message: 'fake-google: unknown drive path ' + method + ' ' + pathPart } } };
  }

  // ---- Gemini ----
  geminiApi(u, method, opt) {
    const key = (opt.headers && (opt.headers['x-goog-api-key'] || opt.headers['X-Goog-Api-Key'])) || new URL(u).searchParams.get('key');
    if (u.includes('/models?')) {
      this.geminiCalls.push({ kind: 'models', key: key || '' });
      if (!key) return { code: 403, body: { error: { message: 'API key missing' } } };
      if (this.geminiModels) return { code: 200, body: { models: this.geminiModels(key) } };
      return { code: 200, body: { models: [
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] }] } };
    }
    const model = (/models\/([^:]+):generateContent/.exec(u) || [])[1];
    const body = opt.payload ? JSON.parse(opt.payload) : {};
    this.geminiCalls.push({ kind: 'generate', model, key: key || '', keyInUrl: /[?&]key=/.test(u), body });
    if (!key) return { code: 400, body: { error: { message: 'API key not valid. Please pass a valid API key.' } } };
    const text = this.geminiResponder ? this.geminiResponder(model, body) : null;
    if (text === null || text === undefined) return { code: 503, body: { error: { message: 'fake-google: no canned Gemini response' } } };
    if (typeof text === 'object') return { code: text.code || 200, body: text.body };
    return { code: 200, body: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100 } } };
  }
}

const HOLIDAY_CSV = [
  '国民の祝日・休日月日,国民の祝日・休日名称',
  '2026/1/1,元日', '2026/1/12,成人の日', '2026/2/11,建国記念の日', '2026/2/23,天皇誕生日', '2026/3/20,春分の日',
  '2026/4/29,昭和の日', '2026/5/3,憲法記念日', '2026/5/4,みどりの日', '2026/5/5,こどもの日', '2026/5/6,休日',
  '2026/7/20,海の日', '2026/8/11,山の日', '2026/9/21,敬老の日', '2026/9/22,休日', '2026/9/23,秋分の日',
  '2026/10/12,スポーツの日', '2026/11/3,文化の日', '2026/11/23,勤労感謝の日',
  '2027/1/1,元日', '2027/1/11,成人の日', '2027/2/11,建国記念の日', '2027/2/23,天皇誕生日', '2027/3/21,春分の日', '2027/3/22,休日',
].join('\r\n');
