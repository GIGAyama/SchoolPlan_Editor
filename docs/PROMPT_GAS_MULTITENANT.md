# GAS × GitHub Pages マルチテナント化 開発プロンプト

本アプリ（School Plan Note）で採用している

> **GitHub Pages の共通URL → GAS Webアプリを iframe で表示 → ログイン中の Google アカウントに応じてデータベース（スプレッドシート）を使い分ける**

というアーキテクチャを、**別の GAS アプリにも適用（一般化）するための開発用プロンプト**です。

現在 GAS で開発中のアプリのソースコード一式と一緒に、下記の「プロンプト本文」を AI コーディングアシスタント（Claude / Gemini / ChatGPT 等）に渡すことで、同じ構成への移行実装を依頼できます。

---

## 使い方

1. `{ }` で囲まれたプレースホルダーを自分のアプリに合わせて書き換える
   | プレースホルダー | 内容 | 例 |
   |---|---|---|
   | `{アプリ名}` | 対象アプリの名前 | 出席管理ノート |
   | `{アプリの概要}` | 何をするアプリか1〜3行 | 児童の出欠を記録し月次集計するアプリ |
   | `{DBシート構成}` | アプリが必要とするシート名と列構成 | 「出席簿」シート: 日付/児童名/出欠/備考 |
   | `{GitHub Pages URL}` | 公開予定の Pages URL | `https://<user>.github.io/<repo>/` |
2. 対象アプリのソースコード（`.gs` / `.html` / `appsscript.json`）が見える状態で、プロンプト本文を貼り付けて実行する
3. 実装完了後、本ドキュメント末尾の「人手で行うデプロイ作業チェックリスト」を実施する

> 参考実装はこのリポジトリ自体です。特に `11_Tenant.gs`（テナント解決・オンボーディングAPI）、`07_WebApp.gs` の `getSs_()` / `doGet()`、`docs/index.html`（PWAシェル）、`docs/config.js` を参照してください。

---

## プロンプト本文（ここからコピー）

````markdown
あなたは Google Apps Script (GAS) と Web フロントエンドに精通したシニアエンジニアです。
現在開発中の GAS Webアプリ「{アプリ名}」を、以下のマルチテナント・アーキテクチャに
移行（一般化）してください。

## 対象アプリ
- 名称: {アプリ名}
- 概要: {アプリの概要}
- データベースとして使うスプレッドシートのシート構成: {DBシート構成}
- 公開予定の GitHub Pages URL: {GitHub Pages URL}

## 目指すアーキテクチャ（3層構成）

1. **配布層: GitHub Pages（PWAシェル）**
   リポジトリの `docs/` フォルダを GitHub Pages で公開し、共通URLとして配布する。
   シェルは GAS Webアプリの exec URL を全画面 iframe で埋め込むだけの静的ページで、
   PWA として端末にインストールできる（manifest + Service Worker）。

2. **アプリ層: GAS スタンドアロン Webアプリ**
   スプレッドシートにバインドしない単体 GAS プロジェクトとしてデプロイする。
   デプロイ設定は必ず「次のユーザーとして実行: **ウェブアプリケーションにアクセスしているユーザー**」
   「アクセスできるユーザー: 全員（Googleアカウント）または同一ドメイン」。
   これにより API 実行・Drive アクセス・プロパティ保存がすべて
   「ログイン中のユーザー本人」の権限とストレージで行われる。

3. **データ層: ユーザーごとのスプレッドシート**
   各ユーザーが使う DB スプレッドシートの ID を `UserProperties` に保存する。
   「アクセスユーザーとして実行」構成では UserProperties が Google アカウント単位で
   自動的に分離されるため、**共通URLにログインするだけで各自の DB に接続される**。

## 実装ステップ

### Step 1: テナント解決モジュール（新規ファイル `Tenant.gs`）

以下の関数群を実装すること。

- 定数:
  - `UP_KEY_SPREADSHEET_ID = 'up_spreadsheetId'`（UserProperties: ユーザー個別のDB ID）
  - `SP_KEY_LEGACY_SPREADSHEET_ID = 'SPREADSHEET_ID'`（ScriptProperties: 旧バインド互換）
  - `SP_KEY_DB_TEMPLATE_ID = 'sp_dbTemplateId'`（ScriptProperties: 配布元が設定するDBテンプレートID）
- `getUserSpreadsheetId_()` / `setUserSpreadsheetId_(id)` / `clearUserSpreadsheetId_()`
  … UserProperties への読み書き（読み取り失敗時は空文字を返し例外を握りつぶす）
- `resolveSpreadsheetId_()` … 優先順位「ユーザー個別 → 旧グローバル」。どちらも無ければ空文字
- `extractSpreadsheetId_(input)` … スプレッドシートの URL / 生ID のどちらを渡されても
  ID を抽出する（`/spreadsheets/d/([a-zA-Z0-9\-_]+)/` にマッチ、または 20 文字以上の英数記号）
- ユーザー別設定アクセサ `tGetProp_(key)` / `tSetProp_(key, value)` / `tDeleteProp_(key)`
  … **読み取りは UserProperties 優先 → ScriptProperties フォールバック**、書き込みは常に
  UserProperties。既存コードの `ScriptProperties` 直接参照をこのアクセサに置き換えることで、
  旧環境から移行しても設定が失われず、保存し直すと自然にユーザー別へ移る

### Step 2: オンボーディング用 Web API（`Tenant.gs` 内）

フロントから `google.script.run` で呼ぶ 4 つの API を実装すること。
すべて `{ success: boolean, ... }` / `{ success: false, error: string }` 形式で返す。

- `getTenantStatus()` … `resolveSpreadsheetId_()` の結果を `SpreadsheetApp.openById` で
  開けるか検証し、`{ success, linked, spreadsheetId, spreadsheetName, email, canCreate,
  templateConfigured }` を返す。ID が無い/開けない場合は `linked: false`
  （＝フロントはオンボーディング画面を表示）
- `linkMyDatabase(input)` … URL/ID を受け取り、開けることを確認して
  `setUserSpreadsheetId_()` で紐付ける。必須シートの有無を確認し、
  無ければ紐付けは許可しつつ `warning` を返す
- `createMyDatabase(name)` … `LockService.getUserLock()` で多重実行を防ぎつつ、
  - `sp_dbTemplateId` が設定されていれば `DriveApp.getFileById(templateId).makeCopy(title)`
    でユーザー自身の Drive に複製（本人が実行するので**本人所有**になる）
  - 未設定なら `SpreadsheetApp.create(title)` で空シートを作成し、
    `initializeNewDatabase_(ss)` で必須シート（{DBシート構成}）とヘッダーを
    プログラムで構築する
  - 作成した ID を `setUserSpreadsheetId_()` で紐付け、`{ spreadsheetId, url, method }` を返す
- `unlinkMyDatabase()` … 紐付けのみ解除（スプレッドシート自体は削除しない）

### Step 3: 全 API のスプレッドシート取得を一本化

- ヘルパー `getSs_()` を実装:
  1. `SpreadsheetApp.getActiveSpreadsheet()` が取れればそれを返す（バインド互換）
  2. Webアプリ文脈では `resolveSpreadsheetId_()` → `SpreadsheetApp.openById(id)`
  3. どちらも無ければ「DB未設定。初期設定でデータベースを作成/紐付けしてください」と throw
- **既存コード内の `SpreadsheetApp.getActiveSpreadsheet()` / openById の直書きを
  すべて `getSs_()` 経由に置き換える**こと。doGet 経由では
  `getActiveSpreadsheet()` が null になるため、置き換え漏れは実行時エラーになる

### Step 4: `doGet()` と iframe 埋め込み対応

```javascript
function doGet(e) {
  // 旧バインド環境からの移行ブリッジ: バインド先があれば個別紐付けへ引き継ぐ
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) {
      PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
      try { if (!getUserSpreadsheetId_()) setUserSpreadsheetId_(ss.getId()); } catch (e2) {}
    }
  } catch (err) {}
  return HtmlService.createTemplateFromFile('App')
    .evaluate()
    .setTitle('{アプリ名}')
    // GitHub Pages シェルが iframe 埋め込みするため必須。
    // GAS は特定オリジン限定ができないので ALLOWALL 一択（リスクは README に明記する）
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}
```

### Step 5: フロントエンド（GAS 側 HTML）

- 初期化時に `getTenantStatus()` を呼び、`linked: false` なら**オンボーディング画面**を表示:
  - 「新しくデータベースを作成」ボタン → `createMyDatabase()`
  - 「既存のスプレッドシートを紐付け」入力欄 → `linkMyDatabase(url)`
  - 成功したら通常のアプリ画面へ遷移
- PWA シェルとのハンドシェイクを実装（名前空間は `{アプリ名}` に合わせて変更可）:
  - アプリ描画完了時に `window.top.postMessage({ type: 'app:ready' }, '*')` と
    `window.parent.postMessage(...)` の両方を送る
  - シェルからの `{ type: 'app:shellAck' }` を受けたらシェル内動作フラグを立てる
  - 再読み込みが必要な場面では `{ type: 'app:reload' }` を親に送る

### Step 6: GitHub Pages 用 PWA シェル（リポジトリの `docs/` フォルダ）

以下のファイルを作成すること。

- `config.js` … `window.APP_CONFIG = { appUrl: "" }`。
  `appUrl` に exec URL を書けば全ユーザー共通の接続先として固定。
  空なら初回に画面上で URL を入力させ `localStorage` に保存する
- `index.html` … 静的シェル。要件:
  - `config.js` → `localStorage` の順で exec URL を解決し、全画面 `<iframe>` に読み込む
    （`allow="clipboard-read; clipboard-write; fullscreen"` を付与）
  - `message` イベントで `app:ready` を待つハンドシェイク。届いたら iframe を表示し、
    `localStorage` に「一度表示に成功した」フラグを保存。`shellAck` を返信する
  - タイムアウトまでに ready が来ない場合（未ログインだと Google のログイン画面は
    iframe 内に表示できないため空白になる）は**ログイン案内画面**を表示:
    「Googleでログインして始める」→ exec URL を**別タブ**で開かせ、
    タブに戻ってきたら（`visibilitychange`）iframe を貼り直して自動再試行
  - `app:reload` 受信時は iframe の src を貼り直す
- `manifest.webmanifest` … name / icons / `display: "standalone"` / start_url
- `sw.js` … シェル資産（index.html, config.js, manifest, アイコン）のみをキャッシュする
  最小の Service Worker。**GAS 側は絶対にキャッシュしない**

## 制約・注意事項（必ず守ること）

1. **個人ごとに変わる設定（APIキー、担当情報、個人フラグ等）は必ず `tSetProp_`
   （UserProperties）に保存**する。ScriptProperties に置くと全ユーザーに共有されてしまう。
   ScriptProperties に置いてよいのは `sp_dbTemplateId` のような配布元の共有設定のみ
2. 時間主導トリガーを使う処理の状態管理も UserProperties に置き、
   複数ユーザーの同時実行で競合しないようにする
3. OAuth スコープは最小化する（Drive を使うなら可能な限り `drive.file`）。
   `appsscript.json` の `oauthScopes` を明示的に管理する
4. 後方互換を壊さない: バインド型で使っている既存ユーザーは、この移行後も
   そのまま動くこと（`getSs_()` と `tGetProp_` のフォールバックがその保証）
5. すべての Web API は例外を握りつぶさず `{ success: false, error }` で返し、
   フロントでユーザーに日本語のエラーメッセージを表示する
6. `createMyDatabase` のテンプレートは「リンクを知っている全員が閲覧可（＝複製可）」で
   共有されている前提。複製失敗時は共有設定を確認するようエラーメッセージで案内する

## 完了条件（受け入れチェックリスト）

- [ ] スタンドアロン + 「アクセスユーザーとして実行」でデプロイした exec URL に
      アカウントAでアクセス → オンボーディング → 新規作成 → アプリが動作する
- [ ] 同じ URL にアカウントBでアクセスすると、Aとは独立したオンボーディングが表示され、
      Bの Drive に B所有の DB が作成される
- [ ] A/B それぞれの設定変更が相手に影響しない（UserProperties 分離の確認）
- [ ] GitHub Pages のシェル URL から開いても同様に動作し、未ログイン時は
      ログイン案内 → 別タブでログイン → 戻ると自動表示、の動線が機能する
- [ ] 旧来のバインド型デプロイでも従来どおり動作する（後方互換）
- [ ] ScriptProperties に個人設定が残っていない
````

## （コピーここまで）

---

## 人手で行うデプロイ作業チェックリスト

プロンプトによる実装が完了したあと、以下は人間側の作業です。

1. **GAS のデプロイ**
   - スタンドアロンプロジェクトとして「デプロイ」>「新しいデプロイ」>「ウェブアプリ」
   - 次のユーザーとして実行: **ウェブアプリケーションにアクセスしているユーザー**
   - アクセスできるユーザー: 全員（Googleアカウント）／同一ドメイン（配布範囲に応じて）
2. **（任意）DBテンプレートの登録**
   - 完成済みテンプレートのスプレッドシートを「リンクを知っている全員が閲覧可」で共有
   - GAS「プロジェクトの設定」>「スクリプト プロパティ」に `sp_dbTemplateId` = テンプレートID
3. **GitHub Pages の有効化**
   - リポジトリの Settings > Pages > Source: Deploy from a branch / Branch: `main`, フォルダ: `/docs`
4. **接続先の固定**
   - `docs/config.js` の `appUrl` に手順1で発行された exec URL を記載してコミット
5. **動作確認**
   - プロンプト本文末尾の「完了条件」をアカウント2つ（A/B）で実施

## セキュリティ上の留意点

- `XFrameOptionsMode.ALLOWALL` は「どのサイトからでも iframe 埋め込み可能」を意味します。
  クリックジャッキング等の緩和策・検討経緯は [`B3_TOKEN_IFRAME_HARDENING.md`](B3_TOKEN_IFRAME_HARDENING.md) を参照してください。
- 一般公開（Googleアカウントの全員）で配布する場合、OAuth 同意画面・検証の対応が必要になることがあります。
  [`C2_OAUTH_CONSENT_SCREEN.md`](C2_OAUTH_CONSENT_SCREEN.md) / [`C4_GOOGLE_VERIFICATION.md`](C4_GOOGLE_VERIFICATION.md) を参照してください。
