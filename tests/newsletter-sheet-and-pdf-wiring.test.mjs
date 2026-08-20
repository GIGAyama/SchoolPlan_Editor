import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { scriptBody } from './helpers/webapp-sandbox.mjs';

// 動作確認で出た2件の検査。
//
// (1) PDF読み込みのボタンをタップすると、ファイル選択のダイアログが二重に開く。
//     配線（initPdfImportUI）が起動時に2か所から呼ばれ、クリックの受け口が2つ付いていた。
//
// (2) 学級通信を保存しようとすると「学級通信データ」シートが見つからないと出て保存できない。
//     このシートは配布用テンプレートにしか無く、どこにも作る処理が無かった。
//     テンプレートを使わずに組み立てたデータベース（initializeNewDatabase_）には
//     最初から存在しないため、その先生は学級通信を1枚も保存できない。

const WEBAPP = fs.readFileSync(new URL('../07_WebApp.gs', import.meta.url), 'utf8');
const TENANT = fs.readFileSync(new URL('../11_Tenant.gs', import.meta.url), 'utf8');

// ================================================== (1) 二重配線

/** 要素ごとに受け口を覚える、最小限の DOM。 */
function makeDom(clicks) {
  const elements = new Map();
  const make = (id) => ({
    id,
    value: '',
    files: [],
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    // ファイル入力の click()。呼ばれた回数＝ダイアログが開く回数。
    click() { clicks.push(this.id); },
    fire(type, event) { (this.listeners[type] || []).forEach(fn => fn(event || {})); }
  });
  return {
    get: (id) => {
      if (!elements.has(id)) elements.set(id, make(id));
      return elements.get(id);
    }
  };
}

function loadPdfImport() {
  const clicks = [];
  const dom = makeDom(clicks);
  const context = vm.createContext({
    console, JSON, Math, Date, Promise, Array, Object, String, Number, Boolean, RegExp, Error,
    setTimeout: () => {}, google: { script: { run: {} } },
    Swal: { fire: () => Promise.resolve({}) },
    showToast: () => {},
    renderPdfQueue: () => {},
    STATE: {},
    document: { getElementById: (id) => dom.get(id) }
  });
  vm.runInContext(scriptBody('App_Js_07_PdfImport.html'), context,
    { filename: 'App_Js_07_PdfImport.html' });
  // 画面の描画は見ない（DOM を作り込むと、何を確かめているのか分からなくなる）。
  vm.runInContext('renderPdfQueue = function () {};', context);
  return { context, dom, clicks, run: (code) => vm.runInContext(code, context) };
}

test('配線を2回呼んでも、ファイル選択のダイアログは1回しか開かない', () => {
  // 起動時に App_Js_01_Core.html の startAppInit と
  // App_Js_14_MultiClass.html の window.onload の両方から呼ばれる。
  const h = loadPdfImport();
  h.run('initPdfImportUI(); initPdfImportUI();');

  h.dom.get('unitDropZone').fire('click');
  assert.deepEqual(h.clicks, ['unitFileInput'],
    'ファイル選択のダイアログが二重に開きます（指導計画PDF）。');

  h.clicks.length = 0;
  h.dom.get('eventDropZone').fire('click');
  assert.deepEqual(h.clicks, ['eventFileInput'],
    'ファイル選択のダイアログが二重に開きます（行事予定PDF）。');
});

test('キーボード操作でも二重に開かない', () => {
  const h = loadPdfImport();
  h.run('initPdfImportUI(); initPdfImportUI(); initPdfImportUI();');

  h.dom.get('unitDropZone').fire('keydown', { key: 'Enter', preventDefault() {} });
  assert.equal(h.clicks.length, 1);
});

test('ドラッグ＆ドロップやファイル選択の受け口も、1つずつしか付けない', () => {
  const h = loadPdfImport();
  h.run('initPdfImportUI(); initPdfImportUI();');

  const zone = h.dom.get('unitDropZone');
  const input = h.dom.get('unitFileInput');
  assert.equal((zone.listeners.click || []).length, 1, 'クリックの受け口が増えています');
  assert.equal((zone.listeners.drop || []).length, 1, 'ドロップの受け口が増えています');
  assert.equal((input.listeners.change || []).length, 1, 'ファイル選択の受け口が増えています');
});

test('選んだファイルは1件だけ積まれる', () => {
  const h = loadPdfImport();
  h.run('initPdfImportUI(); initPdfImportUI();');

  const input = h.dom.get('unitFileInput');
  input.files = [{ name: 'shidoukeikaku.pdf', size: 1000, type: 'application/pdf' }];
  input.fire('change');

  assert.equal(h.run('PDF_IMPORT.unit.files.length'), 1);
});

// この検査は不具合そのものではなく、直し方を縛るためのもの。
// 「呼ばれたら即座に配線済みにする」直し方だと、画面の組み立て前に呼ばれた場合に
// 二度と配線されず、ドロップゾーンが無反応になる。
test('要素がまだ無いときは、あとで配線し直せる', () => {
  const clicks = [];
  const context = vm.createContext({
    console, JSON, Math, Date, Promise, Array, Object, String, Number, Boolean, RegExp, Error,
    setTimeout: () => {}, google: { script: { run: {} } },
    Swal: { fire: () => Promise.resolve({}) },
    showToast: () => {}, renderPdfQueue: () => {},
    STATE: {},
    document: { getElementById: () => null }
  });
  vm.runInContext(scriptBody('App_Js_07_PdfImport.html'), context);
  vm.runInContext('initPdfImportUI();', context);
  assert.equal(context.STATE.pdfImportUIReady, undefined,
    '要素が無いのに配線済みとして扱っています。二度と配線されません。');

  const dom = makeDom(clicks);
  context.document.getElementById = (id) => dom.get(id);
  vm.runInContext('initPdfImportUI();', context);
  dom.get('unitDropZone').fire('click');
  assert.deepEqual(clicks, ['unitFileInput']);
});

// ================================================== (2) 学級通信データシート

/** 学級通信の保存まわりを偽の GAS 環境で動かす。 */
function loadNewsletterApi({ sheets = [] } = {}) {
  const inserted = [];
  const rows = [];
  const makeSheet = (name) => ({
    name,
    getRange: () => ({
      setValues: () => makeSheet(name).getRange(),
      setBackground: function () { return this; },
      setFontColor: function () { return this; },
      setFontWeight: function () { return this; }
    }),
    setFrozenRows: () => {},
    appendRow: (row) => { rows.push(row); }
  });
  const existing = new Map(sheets.map(n => [n, makeSheet(n)]));

  const globals = {
    SHEET_NAME_NEWSLETTER_DATA: '学級通信データ',
    getSs_: () => ({
      getSheetByName: (n) => existing.get(n) || null,
      insertSheet: (n) => { inserted.push(n); const s = makeSheet(n); existing.set(n, s); return s; }
    }),
    driveCreateFile_: (name) => ({ id: 'file-' + name }),
    validateParams_: () => {},
    logInfo: () => {},
    logError: () => {},
    Date
  };
  const names = Object.keys(globals);
  const body = [
    WEBAPP.match(/function initNewsletterSheet_[\s\S]*?\n}/)[0],
    WEBAPP.match(/function saveNewsletterData[\s\S]*?\n}/)[0]
  ].join('\n');
  const factory = new Function(...names,
    `${body}\nreturn { initNewsletterSheet_, saveNewsletterData };`);
  return { api: factory(...names.map(n => globals[n])), inserted, rows };
}

test('「学級通信データ」シートが無くても、保存できる', () => {
  // テンプレートを使わずに組み立てたデータベースには、このシートが無い。
  const { api, inserted, rows } = loadNewsletterApi({ sheets: ['データベース', '単元マスタ'] });
  const r = api.saveNewsletterData('9月号', '2026/09/07', '{"blocks":[]}');

  assert.equal(r.success, true, r.error);
  assert.deepEqual(inserted, ['学級通信データ'], 'シートを作っていません');
  assert.equal(rows.length, 1, '保存した行がありません');
});

test('すでにシートがあれば、作り直さない', () => {
  const { api, inserted, rows } = loadNewsletterApi({ sheets: ['学級通信データ'] });
  api.saveNewsletterData('9月号', '2026/09/07', '{}');

  assert.deepEqual(inserted, [], '既存のシートを作り直しています');
  assert.equal(rows.length, 1);
});

test('保存する行は5列（ID・題名・日付・ファイルID・対象週）', () => {
  const { api, rows } = loadNewsletterApi({ sheets: [] });
  api.saveNewsletterData('9月号', '2026/09/07', '{}');

  assert.equal(rows[0].length, 5);
  assert.equal(rows[0][1], '9月号');
  assert.equal(rows[0][4], '2026/09/07');
});

test('新しく作るデータベースにも、はじめから用意する', () => {
  const source = TENANT.match(/function initializeNewDatabase_[\s\S]*?\n}\n/)[0];
  assert.match(source, /initNewsletterSheet_/,
    '新規データベースの組み立てに「学級通信データ」シートが含まれていません。'
    + '保存時に作られるとはいえ、最初から揃っているべきです。');
});
