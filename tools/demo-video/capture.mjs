/**
 * 画面録画（ffmpeg）。
 *
 * Playwright 内蔵の recordVideo は「ページの中身」しか録らないため、
 * **アドレスバーが映りません**。OAuth 同意画面の `client_id=` が読めることは
 * 審査の必須要件なので、ここでは OS の画面録画（ffmpeg）を使います。
 *
 * ffmpeg は各自で入れてください（macOS: `brew install ffmpeg` /
 * Windows: winget または公式ビルド / Linux: apt install ffmpeg）。
 */
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

/** ffmpeg が使えるか。使えなければ null */
export function findFfmpeg() {
  const binary = process.env.DEMO_FFMPEG || 'ffmpeg';
  const probe = spawnSync(binary, ['-version'], { stdio: 'ignore' });
  return probe.status === 0 ? binary : null;
}

/** プラットフォームごとの入力指定を組み立てる */
function inputArgs({ width, height, display, avfoundationInput }) {
  switch (process.platform) {
    case 'darwin':
      // 画面インデックスは `ffmpeg -f avfoundation -list_devices true -i ""` で確認できる
      return ['-f', 'avfoundation', '-capture_cursor', '1', '-framerate', '30',
        '-i', avfoundationInput || '1:none'];
    case 'win32':
      return ['-f', 'gdigrab', '-framerate', '30', '-i', 'desktop'];
    default:
      return ['-f', 'x11grab', '-framerate', '30',
        '-video_size', `${width}x${height}`, '-i', `${display || process.env.DISPLAY || ':0'}+0,0`];
  }
}

/**
 * 録画を開始する。戻り値の stop() で終了を待つ。
 * @returns {{stop:()=>Promise<void>}}
 */
export function startCapture(outFile, options = {}) {
  const binary = options.ffmpeg || findFfmpeg();
  if (!binary) throw new Error('ffmpeg が見つかりません');

  const args = [
    '-y',
    ...inputArgs({ width: options.width || 1920, height: options.height || 1080, ...options }),
    // 提出先（YouTube）で確実に再生できる素直な設定にする
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    outFile,
  ];

  const child = spawn(binary, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  const exited = new Promise(resolve => child.on('close', code => resolve(code)));
  let stopped = false;

  return {
    args,
    async stop() {
      if (stopped) return;
      stopped = true;
      // 'q' で正常終了させると、途中のフレームまで正しく muxing される
      try { child.stdin.write('q'); child.stdin.end(); } catch { /* すでに終了 */ }
      const code = await Promise.race([
        exited,
        new Promise(resolve => setTimeout(() => { child.kill('SIGINT'); resolve(null); }, 5000)),
      ]);
      if (code !== 0 && code !== null) {
        console.error(`ffmpeg が異常終了しました (code=${code})\n${stderr.slice(-2000)}`);
      }
    },
  };
}
