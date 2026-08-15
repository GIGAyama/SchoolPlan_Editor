# デモ動画の撮影自動化

OAuth 審査用デモ動画（[C5 台本](../../docs/C5_DEMO_VIDEO_SCRIPT.md)）を、
ブラウザ自動操作で撮るための道具です。台本の実行可能版が [`scenes.mjs`](scenes.mjs)、
それを実行するのが [`record-demo.mjs`](record-demo.mjs) です。

## 何が自動で、何が手動か

**自動化するのは、自分のアプリの操作だけです。**

| 区間 | 誰がやるか | 理由 |
|---|---|---|
| 紹介ページ・ポリシーの表示 | 自動 | ただの画面遷移 |
| 週案の入力／学級通信の生成／PDF 出力 | 自動 | 自分のアプリの DOM を叩くだけ |
| リマインダー設定・テスト送信 | 自動 | 同上 |
| Classroom のクラス一覧取得・投稿 | 自動 | 同上 |
| 字幕のタイミング記録・`.srt` 生成 | 自動 | 実時刻から起こす |
| **Google のログイン・同意画面** | **手動** | Google は自動操作のログインを拒否します。また同意は本人が行った本物である必要があります |
| Gmail の受信箱、Classroom のストリーム、スプレッドシートのメニュー | 手動 | 他社（Google）の画面を自動操作しないため |

手動区間ではスクリプトが一時停止し、ターミナルに操作内容を出します。
操作を終えて Enter を押すと、続きが自動で流れます。**録画は止まりません**。

> ⚠️ **モックを録画して提出しないでください。** Google の要件は「本番デプロイ済みのアプリ」です。
> `build-preview.mjs` が作るオフライン版は、セレクタ検証と下見のためだけのものです。

## 使い方

### 1. 準備

```bash
npm install
npx playwright install chromium
# ffmpeg（画面録画に必要。アドレスバーを映すため Playwright 内蔵の録画では代用できません）
#   macOS:   brew install ffmpeg
#   Windows: winget install Gyan.FFmpeg
#   Linux:   sudo apt install ffmpeg
```

撮影用スプレッドシートの URL を渡します（アプリ URL は `docs/config.js` から読まれます）。

```bash
export DEMO_SHEET_URL="https://docs.google.com/spreadsheets/d/…/edit"
# 別のデプロイで撮るなら DEMO_APP_URL、Pages の所有者が違うなら DEMO_PAGES_OWNER も指定
```

### 2. 撮影前チェック（Google に一切アクセスしません）

```bash
npm run demo:verify
```

- 要求スコープ 9 個すべてが、どこかのシーンで実演されるか
- 台本が指すボタン・セレクタが実際に App.html に存在するか
- 想定尺（8分を超えていないか）
- アプリ名の表記ゆれ

### 3. 段取りの確認（ブラウザも開きません）

```bash
npm run demo:dry
```

どの順で何を映すか、手動で何を頼まれるかが時刻つきで並びます。

### 4. 撮影

```bash
# 撮る前に必ず: https://myaccount.google.com/permissions でこのアプリのアクセス権を削除
npm run demo:record
```

出力は `dist/demo-video/` に出ます。

| ファイル | 中身 |
|---|---|
| `raw.mp4` | 画面録画（アドレスバーを含む） |
| `demo_en.srt` | 英語字幕。**実測タイミング**なので打ち直し不要 |
| `timings.json` | 各字幕の開始・終了と、失敗した操作の記録 |

うまくいかなかったシーンだけ撮り直せます。

```bash
node tools/demo-video/record-demo.mjs --scene=classroom
```

### 5. 後処理と提出

[`docs/video/README.md`](../../docs/video/README.md) の手順へ。
`demo_en.srt` は YouTube Studio にそのままアップロードできます。

**提出前に必ず**、同意画面のフレームを静止画で抜いて `client_id=` が読めるか確認してください
（差し戻し理由の筆頭です）。

## オプション

| オプション | 効果 |
|---|---|
| `--dry-run` | ブラウザを開かず段取りだけ表示 |
| `--no-capture` | 録画せず動線だけ確認 |
| `--scene=<id>` | 1シーンだけ撮る（id は `scenes.mjs` を参照） |
| `--overlay` | 英語字幕を画面にも焼き込む（下見向け。既定は `.srt` のみ） |
| `--out=<dir>` | 出力先（既定 `dist/demo-video`） |

`--overlay` は自分のアプリのページにしか効きません。Google の画面（同意・Gmail・Classroom）には
差し込まないので、**全編に字幕を載せたい場合は `.srt` を使ってください**。

## 環境変数

| 変数 | 既定 |
|---|---|
| `DEMO_APP_URL` | `docs/config.js` の `appUrl` |
| `DEMO_SHEET_URL` | （必須。撮影用スプレッドシート） |
| `DEMO_PAGES_OWNER` | `GIGAyama` |
| `DEMO_HOME_URL` / `DEMO_PRIVACY_URL` / `DEMO_TERMS_URL` | GitHub Pages 上の各ページ |
| `DEMO_FFMPEG` | `ffmpeg` |
| `DEMO_CHROMIUM` | Playwright 管理の Chromium |

## ファイル

| ファイル | 役割 |
|---|---|
| `scenes.mjs` | 台本の正本。シーン・操作・英語字幕・スコープ対応 |
| `record-demo.mjs` | 撮影ドライバ |
| `verify-scenes.mjs` | 撮影前チェック |
| `build-preview.mjs` | オフライン下見用 HTML の組み立て（**提出不可**） |
| `capture.mjs` | ffmpeg での画面録画 |
| `overlay.mjs` | 画面内の字幕帯・強調表示 |
| `srt.mjs` | 実測タイミングから `.srt` を起こす |
| `browser.mjs` | Chromium の起動設定 |
| `config.mjs` | URL の解決 |
