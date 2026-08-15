/**
 * Chromium の起動をまとめる。
 *
 * 通常は Playwright が管理する Chromium（`npx playwright install chromium`）を使いますが、
 * すでに用意された Chromium を使いたい環境のために実行ファイルを差し替えられるようにしています。
 *
 *   DEMO_CHROMIUM  Chromium の実行ファイルパス
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

/** 環境に用意済みの Chromium を探す。見つからなければ Playwright 管理のものを使う */
export function resolveExecutablePath() {
  if (process.env.DEMO_CHROMIUM) return process.env.DEMO_CHROMIUM;
  const shared = process.env.PLAYWRIGHT_BROWSERS_PATH
    ? path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium')
    : '';
  if (shared && fs.existsSync(shared)) return shared;
  return undefined;
}

/**
 * @param {{headless?:boolean, width?:number, height?:number}} options
 */
export async function launchChromium({ headless = true, width = 1920, height = 1080 } = {}) {
  const executablePath = resolveExecutablePath();
  return chromium.launch({
    headless,
    executablePath,
    args: headless
      ? []
      : [
          // 撮影ウィンドウは画面左上に固定し、毎回同じ座標に映るようにする
          `--window-size=${width},${height}`,
          '--window-position=0,0',
          // 撮影に映り込むと差し戻しの元になるものを消す
          '--disable-infobars',
          '--hide-crash-restore-bubble',
          '--no-default-browser-check',
          '--no-first-run',
          '--disable-features=Translate,MediaRouter',
        ],
  });
}
