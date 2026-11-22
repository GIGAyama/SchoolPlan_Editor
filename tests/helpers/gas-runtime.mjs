// リポジトリの .gs を、実物のまま Node の上で動かすためのテスト用の足場。
//
// GAS では google.script.run の呼び出し1回が1回の実行で、トップレベルの変数は
// そのたびに作り直される。ここでも callFunction() のたびに vm のコンテキストを
// 作り直し、全 .gs を読みこんでから目的の関数を呼ぶ。差し替えるのは GAS のサービス
// （UrlFetchApp・PropertiesService・CacheService・LockService・Session ほか）だけで、
// アプリのコードには手を入れない。
//
// 実行をまたいで残るもの（スプレッドシート・利用者ごとのプロパティとキャッシュ・
// スクリプト全体のキャッシュ・トリガー）は createWorld() が返す world に持つ。
// 利用者を変えて呼べば、1つのURLを何人もの先生が使う形（共有デプロイ）を再現できる。
//
// Google 側の応答は fake-google.mjs が受け持つ。

// GAS のスクリプトは appsscript.json の timeZone（Asia/Tokyo）で動く。`new Date(2026, 3, 6)` は
// 日本時間の 0 時になり、カレンダーの日付や「今日」の判定はそれを前提に書かれている。
// CI は UTC で走るので、何もしないと日付が 9 時間ずれたまま（シートには 46111.375 のような
// 端数つきの日付が入ったまま）「通って」しまう。Date を使う前に、ここで合わせる。
// node --test はファイルごとに別プロセスで走るので、ほかのテストには影響しない。
process.env.TZ = 'Asia/Tokyo';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { FakeGoogle } from './fake-google.mjs';

import { fileURLToPath } from 'node:url';

/** リポジトリの直下（.gs と App*.html のある場所） */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GS_FILES = fs.readdirSync(ROOT).filter((f) => f.endsWith('.gs')).sort();
const SCRIPTS = GS_FILES.map((f) => new vm.Script(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f }));

const TZ_OFFSET = { JST: 9, 'Asia/Tokyo': 9, GMT: 0, UTC: 0 };
const pad = (n, w = 2) => String(n).padStart(w, '0');
const DAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Utilities.formatDate の必要な範囲（SimpleDateFormat の一部） */
export function formatDate(date, tz, pattern) {
  const off = TZ_OFFSET[tz] !== undefined ? TZ_OFFSET[tz] : 9;
  const d = new Date(new Date(date).getTime() + off * 3600000);
  const map = {
    yyyy: d.getUTCFullYear(), yy: pad(d.getUTCFullYear() % 100), MM: pad(d.getUTCMonth() + 1), M: d.getUTCMonth() + 1,
    dd: pad(d.getUTCDate()), d: d.getUTCDate(), HH: pad(d.getUTCHours()), H: d.getUTCHours(), mm: pad(d.getUTCMinutes()),
    ss: pad(d.getUTCSeconds()), SSS: pad(d.getUTCMilliseconds(), 3), u: d.getUTCDay() === 0 ? 7 : d.getUTCDay(),
    E: DAY_EN[d.getUTCDay()], EEE: DAY_EN[d.getUTCDay()], Z: (off >= 0 ? '+' : '-') + pad(Math.abs(off)) + '00',
  };
  return String(pattern).replace(/'([^']*)'|yyyy|yy|MM|M|dd|d|HH|H|mm|ss|SSS|EEE|E|u|Z/g, (tok, lit) => (lit !== undefined ? lit : String(map[tok])));
}

function makeBlob(data, contentType, name) {
  const buf = Buffer.isBuffer(data) ? data : (typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data || []));
  const blob = {
    getBytes: () => Array.from(buf), getDataAsString: () => buf.toString('utf8'), getContentType: () => contentType || 'application/octet-stream',
    getName: () => name || '', setName: (n) => { name = n; return blob; }, copyBlob: () => makeBlob(buf, contentType, name),
    getAs: () => blob, __buf: buf,
  };
  return blob;
}

/** 実行をまたいで残るもの（Google 側の状態） */
export function createWorld(options = {}) {
  return {
    google: options.google || new FakeGoogle(),
    scriptProps: options.scriptProps || {},
    userProps: new Map(),      // email -> {}
    userCache: new Map(),      // email -> Map
    scriptCache: new Map(),
    triggers: [],              // { id, handler, email, kind }
    mails: [],
    announcements: [],
    courses: new Map(),        // email -> [{id,name,section}]
    logs: [],                  // Logger.log / console
    // ロックの持ち主。script はスクリプト全体で1本、user は利用者ごとに1本（GAS の仕様どおり）。
    // 値は「持っている実行」の番号。テストから文字列を入れると「ほかの実行が握っている」状態を作れる。
    locks: { script: null, user: new Map() },
    lockLog: [],               // { exec, email, kind: 'script'|'user', op: 'acquire'|'reenter'|'busy'|'release', at }
    execSeq: 0,
    executions: [],            // { fn, email, fetches, ok, error }
    now: null,                 // 固定したいときの「いま」(ms)
  };
}

function propsApi(store) {
  return {
    getProperty: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setProperty: (k, v) => { store[k] = String(v); },
    setProperties: (obj, deleteOthers) => { if (deleteOthers) Object.keys(store).forEach((k) => delete store[k]); Object.entries(obj).forEach(([k, v]) => { store[k] = String(v); }); },
    deleteProperty: (k) => { delete store[k]; },
    deleteAllProperties: () => { Object.keys(store).forEach((k) => delete store[k]); },
    getProperties: () => ({ ...store }),
    getKeys: () => Object.keys(store),
  };
}
function cacheApi(map) {
  return {
    get: (k) => { const e = map.get(k); if (!e) return null; if (e.until < Date.now()) { map.delete(k); return null; } return e.v; },
    put: (k, v, sec) => { if (String(v).length > 100000) throw new Error('Argument too large: value'); map.set(k, { v: String(v), until: Date.now() + (sec || 600) * 1000 }); },
    remove: (k) => { map.delete(k); },
    removeAll: (keys) => { keys.forEach((k) => map.delete(k)); },
    getAll: (keys) => { const o = {}; keys.forEach((k) => { const e = map.get(k); if (e && e.until >= Date.now()) o[k] = e.v; }); return o; },
    putAll: (obj, sec) => { Object.entries(obj).forEach(([k, v]) => map.set(k, { v: String(v), until: Date.now() + (sec || 600) * 1000 })); },
  };
}

/** 1回の実行ぶんの GAS 環境を作る */
export function createRuntime(world, email) {
  if (!world.userProps.has(email)) world.userProps.set(email, {});
  if (!world.userCache.has(email)) world.userCache.set(email, new Map());
  const google = world.google;
  const execId = ++world.execSeq;
  /**
   * LockService のロック。GAS と同じく、
   *   - 同じ実行がもう持っていれば、取り直しは何もせず成功する
   *   - releaseLock() は、取った回数に関係なく1回で手放す（入れ子で呼ぶと外側のぶんも外れる）
   *   - ほかの実行が持っているあいだは tryLock が false、waitLock が例外
   */
  const lockApi = (kind) => () => {
    const holder = () => (kind === 'script' ? world.locks.script : (world.locks.user.get(email) || null));
    const setHolder = (v) => { if (kind === 'script') world.locks.script = v; else if (v === null) world.locks.user.delete(email); else world.locks.user.set(email, v); };
    // at は「それまでに Google へ何回通信したか」。ロックの外で書いていないかを確かめるのに使う
    const note = (op) => world.lockLog.push({ exec: execId, email, kind, op, at: world.google.log.length });
    const acquire = () => {
      const h = holder();
      if (h === execId) { note('reenter'); return true; }
      if (h !== null) { note('busy'); return false; }
      setHolder(execId); note('acquire'); return true;
    };
    return {
      tryLock: () => acquire(),
      waitLock: () => { if (!acquire()) throw new Error('Exception: Lock timeout: another process was holding the lock for too long.'); },
      releaseLock: () => { if (holder() === execId) { setHolder(null); note('release'); } },
      hasLock: () => holder() === execId,
    };
  };
  const RealDate = Date;
  const FixedDate = world.now === null ? RealDate : class extends RealDate {
    constructor(...a) { if (a.length === 0) super(world.now); else super(...a); }
    static now() { return world.now; }
  };

  const triggerBuilder = (handler) => {
    const t = { id: 'trg_' + crypto.randomUUID().slice(0, 8), handler, email, kind: 'CLOCK', spec: {} };
    const b = {
      timeBased: () => b, everyDays: (n) => { t.spec.everyDays = n; return b; }, atHour: (h) => { t.spec.atHour = h; return b; },
      everyMinutes: (n) => { t.spec.everyMinutes = n; return b; }, everyHours: (n) => { t.spec.everyHours = n; return b; },
      after: (ms) => { t.spec.after = ms; return b; }, at: (d) => { t.spec.at = d; return b; }, nearMinute: () => b, inTimezone: () => b,
      onWeekDay: () => b, everyWeeks: () => b, onMonthDay: () => b,
      create: () => { world.triggers.push(t); return wrapTrigger(t); },
    };
    return b;
  };
  const wrapTrigger = (t) => ({ getHandlerFunction: () => t.handler, getUniqueId: () => t.id, getEventType: () => 'CLOCK', getTriggerSource: () => 'CLOCK', __t: t });

  const ctx = {
    console: { log: (...a) => world.logs.push(['log', a.join(' ')]), error: (...a) => world.logs.push(['error', a.join(' ')]), warn: (...a) => world.logs.push(['warn', a.join(' ')]), info: () => {} },
    JSON, Math, Date: FixedDate, String, Number, Boolean, Array, Object, Map, Set, RegExp, Error, TypeError, RangeError, Symbol, Promise,
    isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI, Intl, WeakMap,
    UrlFetchApp: {
      fetch: (url, opt) => google.fetch(url, opt),
      fetchAll: (reqs) => reqs.map((r) => (typeof r === 'string' ? google.fetch(r, {}) : google.fetch(r.url, r))),
    },
    ScriptApp: {
      getOAuthToken: () => 'fake-oauth-token-of-' + email,
      getProjectTriggers: () => world.triggers.filter((t) => t.email === email).map(wrapTrigger),
      deleteTrigger: (tr) => { world.triggers = world.triggers.filter((t) => t.id !== tr.getUniqueId()); },
      newTrigger: triggerBuilder,
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/FAKE/exec' }),
      getScriptId: () => 'FAKE_SCRIPT_ID',
      AuthMode: {}, EventType: { CLOCK: 'CLOCK' }, WeekDay: {},
    },
    PropertiesService: {
      getUserProperties: () => propsApi(world.userProps.get(email)),
      getScriptProperties: () => propsApi(world.scriptProps),
      getDocumentProperties: () => null,
    },
    CacheService: { getUserCache: () => cacheApi(world.userCache.get(email)), getScriptCache: () => cacheApi(world.scriptCache), getDocumentCache: () => null },
    LockService: { getScriptLock: lockApi('script'), getUserLock: lockApi('user'), getDocumentLock: () => null },
    Session: {
      getScriptTimeZone: () => 'Asia/Tokyo',
      getEffectiveUser: () => ({ getEmail: () => email }),
      getActiveUser: () => ({ getEmail: () => email }),
      getActiveUserLocale: () => 'ja', getTemporaryActiveUserKey: () => 'tmpkey-' + email,
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate,
      sleep: () => {},
      base64Encode: (data) => (typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)).toString('base64'),
      base64Decode: (s) => Array.from(Buffer.from(String(s), 'base64')),
      base64EncodeWebSafe: (data) => (typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)).toString('base64url'),
      newBlob: makeBlob,
      DigestAlgorithm: { MD5: 'md5', SHA_256: 'sha256', SHA_1: 'sha1' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, text) => Array.from(crypto.createHash(alg).update(String(text), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      parseCsv: (csv) => String(csv).split(/\r?\n/).filter(Boolean).map((l) => l.split(',')),
      jsonStringify: JSON.stringify, jsonParse: JSON.parse,
    },
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
      createHtmlOutput: (html) => ({ __html: html, setTitle() { return this; }, setXFrameOptionsMode() { return this; }, addMetaTag() { return this; }, getContent() { return html; } }),
      createHtmlOutputFromFile: (name) => ({ getContent: () => fs.readFileSync(path.join(ROOT, name + '.html'), 'utf8') }),
      createTemplateFromFile: (name) => ({ evaluate: () => ({ __template: name, setTitle() { return this; }, setXFrameOptionsMode() { return this; }, addMetaTag() { return this; }, setFaviconUrl() { return this; } }) }),
    },
    MailApp: { sendEmail: (...a) => { world.mails.push({ from: email, args: a }); }, getRemainingDailyQuota: () => 100 },
    Classroom: {
      Courses: {
        list: () => ({ courses: world.courses.get(email) || [] }),
        get: (id) => { const c = (world.courses.get(email) || []).find((x) => x.id === id); if (!c) throw new Error('GoogleJsonResponseException: API call to classroom.courses.get failed with error: The caller does not have permission'); return c; },
        Announcements: {
          create: (announcement, courseId) => {
            const mine = (world.courses.get(email) || []).some((x) => x.id === courseId);
            if (!mine) throw new Error('GoogleJsonResponseException: API call to classroom.courses.announcements.create failed with error: The caller does not have permission');
            world.announcements.push({ by: email, courseId, announcement, at: new FixedDate().toISOString() });
            return { id: 'ann_' + world.announcements.length };
          },
        },
      },
    },
    Logger: { log: (...a) => world.logs.push(['Logger', a.join(' ')]) },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const s of SCRIPTS) s.runInContext(ctx);
  // 実行が終わったら GAS はロックを自動で手放す。callFunction / fireTrigger が最後に呼ぶ。
  Object.defineProperty(ctx, '__endExecution', { enumerable: false, value: () => {
    const leaked = [];
    if (world.locks.script === execId) { world.locks.script = null; leaked.push('script'); }
    if (world.locks.user.get(email) === execId) { world.locks.user.delete(email); leaked.push('user'); }
    return leaked;
  } });
  Object.defineProperty(ctx, '__execId', { enumerable: false, value: execId });
  return ctx;
}

function containsDate(v, depth = 0) {
  if (v instanceof Date || (v && typeof v === 'object' && typeof v.getTime === 'function' && typeof v.toISOString === 'function')) return true;
  if (!v || typeof v !== 'object' || depth > 12) return false;
  return (Array.isArray(v) ? v : Object.values(v)).some((x) => containsDate(x, depth + 1));
}

/**
 * google.script.run 相当: 公開関数を1回の実行として呼ぶ。
 *
 * 本物と同じく、末尾が `_` の関数は呼べない。戻り値は JSON で往復させ、Date が
 * 混じっていたら null にする（google.script.run は Date を運べず、成功ハンドラに
 * null が渡る。気づきにくい壊れ方なので、ここで再現しておく）。
 *
 * @param {Object} world createWorld() の戻り値
 * @param {string} email 呼び出す利用者
 * @param {string} name 関数名
 * @param {Array} [args] 引数
 * @returns {{ok:boolean, value?:*, error?:string, fetches:number, dateInReturn:boolean, leakedLocks:string[]}}
 */
export function callFunction(world, email, name, args) {
  const before = world.google.log.length;
  const out = { ok: true, fetches: 0, dateInReturn: false, leakedLocks: [] };
  let ctx = null;
  try {
    if (name.endsWith('_')) throw new Error(`スクリプト関数が見つかりません: ${name}`);
    ctx = createRuntime(world, email);
    const fn = vm.runInContext(`typeof ${name} === 'function' ? ${name} : undefined`, ctx);
    if (typeof fn !== 'function') throw new Error(`スクリプト関数が見つかりません: ${name}`);
    const result = fn.apply(null, JSON.parse(JSON.stringify(args || [])));
    out.dateInReturn = containsDate(result);
    out.value = out.dateInReturn ? null : (result === undefined ? null : JSON.parse(JSON.stringify(result)));
  } catch (e) {
    out.ok = false;
    out.error = (e && e.message) || String(e);
    out.stack = e && e.stack;
  } finally {
    if (ctx) out.leakedLocks = ctx.__endExecution();
  }
  out.fetches = world.google.log.length - before;
  world.executions.push({ fn: name, email, fetches: out.fetches, ok: out.ok, error: out.error, dateInReturn: out.dateInReturn });
  return out;
}

/**
 * 1回の実行の中で、好きな処理を動かす（末尾が `_` の内部関数を確かめるとき用）。
 * @param {Object} world
 * @param {string} email
 * @param {function(Object): *} body 実行環境（グローバル）を受け取る
 * @returns {*} body の戻り値
 */
export function withRuntime(world, email, body) {
  const ctx = createRuntime(world, email);
  try {
    return body(ctx);
  } finally {
    ctx.__endExecution();
  }
}

/** 時間主導トリガーを1本走らせる（そのトリガーを作った利用者として）。 */
export function fireTrigger(world, trigger) {
  return withRuntime(world, trigger.email, (ctx) => {
    const fn = vm.runInContext(`typeof ${trigger.handler} === 'function' ? ${trigger.handler} : undefined`, ctx);
    if (typeof fn !== 'function') throw new Error('トリガーの関数が見つかりません: ' + trigger.handler);
    return fn({ triggerUid: trigger.id });
  });
}

/**
 * 新しい先生を1人つくり、本物の createMyDatabase() でデータベースを用意する。
 * @param {Object} world
 * @param {string} email
 * @returns {{email: string, spreadsheetId: string, sheet: function(string): Object}}
 *   sheet(名前) は疑似スプレッドシートのシート（grid が二次元配列）を返す
 */
export function createTeacher(world, email) {
  const created = callFunction(world, email, 'createMyDatabase', []);
  if (!created.ok || !created.value || !created.value.success) {
    throw new Error('createMyDatabase に失敗しました: ' + JSON.stringify(created.ok ? created.value : created.error));
  }
  const spreadsheetId = created.value.spreadsheetId;
  const sheet = (title) => {
    const found = world.google.spreadsheets.get(spreadsheetId).sheets.find((x) => x.title === title);
    if (!found) throw new Error('シートがありません: ' + title);
    return found;
  };
  return { email, spreadsheetId, sheet };
}

/** シリアル値（Sheets の日付）を作る。 */
export { serialFromYmd } from './fake-google.mjs';
