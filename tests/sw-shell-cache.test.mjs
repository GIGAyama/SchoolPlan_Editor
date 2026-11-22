// PWA シェルの Service Worker（docs/sw.js）が、オフライン用の控えに
// 「入口のページそのもの」だけを入れることの確認。
//
// 控え（./index.html）は、圏外でアプリを開いたときに出す画面である。
// 以前は「`/` で終わる URL はぜんぶ入口」と見なし、応答が成功したかも見ていなかった。
// 実ブラウザで確かめると、存在しない `…/manual/` を一度開いただけで、
// 控えが 404 のページ（status 404）に置き換わった。
//
// docs/sw.js を実物のまま読みこみ、ブラウザの部品（self / caches / fetch）だけ差し替える。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SOURCE = fs.readFileSync('docs/sw.js', 'utf8');

/**
 * Service Worker を読みこみ、fetch イベントを1つずつ流せるようにする。
 * @param {Object} [options] scope: 配っている場所（既定は独自ドメインの直下）
 */
function boot(options = {}) {
  const scope = options.scope || 'https://schoolplan-editor.example/';
  const origin = new URL(scope).origin;
  const handlers = {};
  const stored = new Map();          // 控えに入っているもの（キーは絶対 URL）
  const puts = [];                   // cache.put の記録
  let network = () => Promise.reject(new Error('offline'));

  const absolute = (key) => new URL(typeof key === 'string' ? key : key.url, scope).href;
  const cache = {
    put: (key, res) => { puts.push({ key: absolute(key), status: res.status }); stored.set(absolute(key), res); return Promise.resolve(); },
    add: () => Promise.resolve(),
  };
  const sandbox = {
    URL, Promise, console,
    Request: class { constructor(url) { this.url = url; } },
    Response: { error: () => ({ type: 'error', status: 0, ok: false }) },
    self: {
      location: { origin },
      registration: { scope },
      addEventListener: (type, fn) => { handlers[type] = fn; },
      skipWaiting() {}, clients: { claim() {} },
    },
    caches: {
      open: () => Promise.resolve(cache),
      match: (key) => Promise.resolve(stored.get(absolute(key))),
      keys: () => Promise.resolve([]), delete: () => Promise.resolve(true),
    },
    fetch: (request) => network(request),
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'docs/sw.js' });

  const response = (status, extra = {}) => {
    const res = { status, ok: status >= 200 && status < 300, redirected: false, url: '', ...extra };
    res.clone = () => ({ ...res });
    return res;
  };
  /** そのパスを開く（ナビゲーション）。SW が返した応答を返す。 */
  async function navigate(path, reply) {
    network = typeof reply === 'function' ? reply : () => Promise.resolve(reply);
    let answered;
    handlers.fetch({
      request: { url: new URL(path, scope).href, method: 'GET', mode: 'navigate' },
      respondWith: (promise) => { answered = promise; },
    });
    assert.ok(answered, 'ナビゲーションに応えていません');
    const res = await answered;
    await new Promise(resolve => setImmediate(resolve)); // cache.put は応答のあとで走る
    return res;
  }
  const shell = () => stored.get(new URL('./index.html', scope).href);
  return { navigate, response, puts, shell, origin, scope };
}

test('入口を開けたら、その応答を控えにする', async () => {
  const sw = boot();
  await sw.navigate('/', sw.response(200));
  assert.equal(sw.shell().status, 200);
  await sw.navigate('/index.html', sw.response(200));
  assert.equal(sw.puts.length, 2);
});

test('存在しない場所を開いても、控えは 404 のページに置き換わらない', async () => {
  const sw = boot();
  await sw.navigate('/', sw.response(200));
  const res = await sw.navigate('/manual/', sw.response(404));
  assert.equal(res.status, 404, '開いた人には、そのまま 404 を返す');
  assert.equal(sw.shell().status, 200, '控えは入口のまま');
  assert.equal(sw.puts.length, 1);
});

test('入口でないページは、成功していても控えにしない', async () => {
  const sw = boot();
  await sw.navigate('/', sw.response(200));
  for (const path of ['/about.html', '/privacy-policy.html', '/terms.html', '/note/']) {
    await sw.navigate(path, sw.response(200));
  }
  assert.equal(sw.puts.length, 1, '控えに入るのは入口だけ');
});

test('入口がエラーで返ってきたら、それを控えにしない', async () => {
  const sw = boot();
  await sw.navigate('/', sw.response(200));
  await sw.navigate('/', sw.response(404));
  await sw.navigate('/', sw.response(503));
  assert.equal(sw.shell().status, 200);
  assert.equal(sw.puts.length, 1);
});

test('配信元が不調（5xx）のときは、控えの入口を出す', async () => {
  const sw = boot();
  await sw.navigate('/', sw.response(200));
  const res = await sw.navigate('/', sw.response(503));
  assert.equal(res.status, 200, 'エラーのページより、前回の入口のほうが役に立つ');
});

test('控えがまだ無いときに配信元が不調なら、返ってきた応答をそのまま渡す', async () => {
  const sw = boot();
  const res = await sw.navigate('/', sw.response(503));
  assert.equal(res.status, 503);
});

test('よそへ転送された先のページは、控えにしない', async () => {
  const sw = boot();
  await sw.navigate('/', sw.response(200, { redirected: true, url: 'https://portal.example/login' }));
  assert.equal(sw.shell(), undefined);
  await sw.navigate('/', sw.response(200, { url: 'https://filter.example/blocked' }));
  assert.equal(sw.shell(), undefined, '別のオリジンの応答は入口ではない');
});

test('サブディレクトリで配っていても、入口だけを控えにする', async () => {
  const sw = boot({ scope: 'https://someone.github.io/SchoolPlan_Editor/' });
  await sw.navigate('/SchoolPlan_Editor/', sw.response(200));
  assert.equal(sw.puts.length, 1);
  await sw.navigate('/SchoolPlan_Editor/manual/', sw.response(404));
  await sw.navigate('/SchoolPlan_Editor/about.html', sw.response(200));
  assert.equal(sw.puts.length, 1);
  assert.equal(sw.shell().status, 200);
});

test('圏外では控えの入口を出す。控えも無ければ「つながっていません」の画面', async () => {
  const sw = boot();
  await sw.navigate('/', sw.response(200));
  const offline = () => Promise.reject(new TypeError('Failed to fetch'));
  assert.equal((await sw.navigate('/', offline)).status, 200);
  assert.equal((await sw.navigate('/manual/', offline)).status, 200, '圏外では、どこを開いても入口を出す');

  const fresh = boot();
  const res = await fresh.navigate('/', offline);
  assert.equal(res.type, 'error', '控えが何も無ければ、ブラウザのエラーに任せる');
});
