# C1: 標準 Google Cloud プロジェクトの作成・紐付け手順

> 目的: Apps Script プロジェクトを**標準（standard）GCP プロジェクト**に紐付け、OAuth 同意画面・スコープ制限・ログ（Cloud Logging / Error Reporting）を Google Cloud Console で扱える状態にする。
>
> 前提: 本手順は配布元（アプリ運用者）が一度だけ実施します。以降の C2（同意画面）・C4（検証申請）・B4方式A（別OAuth2）の土台になります。

## なぜ標準 GCP プロジェクトが必要か

- Apps Script は既定で「デフォルト GCP プロジェクト」を使いますが、これは**同意画面の編集・外部公開・検証申請・独自 OAuth クライアント作成ができません**。
- 共通URLで不特定多数（複数校）へ配布するには、External 同意画面（C2）と検証（C4）が必要 → **標準 GCP プロジェクトへの紐付けが必須**です。

## 手順

### 1. 標準 GCP プロジェクトを用意
1. [Google Cloud Console](https://console.cloud.google.com/) を開く（配布元の Google アカウントで）。
2. 上部のプロジェクト選択 →「新しいプロジェクト」。
   - プロジェクト名: 例）`schoolplan-editor`
   - 組織/場所: 学校ドメイン運用なら該当組織を、個人運用なら「組織なし」。
3. 作成後、**プロジェクト番号**を控える（「プロジェクトの設定」やダッシュボードに表示）。

### 2. 必要な API を有効化
「API とサービス」→「ライブラリ」で以下を有効化:
- **Google Classroom API**（Classroom 連携を使う場合）
- **Google Drive API**（Picker・Drive REST 呼び出し用）
- **Google Picker API**（PDF の Picker 選択用）
- **Apps Script API**（clasp 運用時）

> スプレッドシート操作（`SpreadsheetApp`）は追加の API 有効化なしで動作します。

### 3. Apps Script プロジェクトに GCP プロジェクトを紐付け
1. Apps Script エディタを開く → 左メニュー「プロジェクトの設定（⚙）」。
2. 「Google Cloud Platform (GCP) プロジェクト」→「プロジェクトを変更」。
3. 手順1で控えた**プロジェクト番号**を入力して設定。
   - ※紐付けには、その GCP プロジェクトの権限（編集者以上）が必要です。

### 4. Cloud Logging / Error Reporting を有効化
1. `appsscript.json` の `exceptionLogging` が `"STACKDRIVER"` であることを確認（本リポジトリは設定済み）。
2. Cloud Console →「ログ エクスプローラ」でスクリプト実行ログが見えることを確認。
3. 「Error Reporting」で例外が集約表示されることを確認（Phase E2 の監査ログ設計で活用）。

### 5. 動作確認（受け入れ基準）
- [ ] Cloud Console で本プロジェクトの**同意画面設定ページが開ける**（C2 の前提）。
- [ ] 「認証情報」で **OAuth クライアント/API キー制限**が編集できる。
- [ ] Apps Script 実行のログが **Cloud Logging** に出る。
- [ ] Error Reporting に例外が表示される。

## 次のステップ
- **C2**: OAuth 同意画面（External）の構成。
- **C4**: Google 検証申請（`drive.file` 中心・Classroom 用途説明）。
- **B4 方式A**: Classroom/メールの遅延承認（別 OAuth2 クライアントを本プロジェクトで発行）。

## 参考
- Apps Script × 標準 GCP プロジェクト: https://developers.google.com/apps-script/guides/cloud-platform-projects
- 同意画面: https://support.google.com/cloud/answer/10311615
