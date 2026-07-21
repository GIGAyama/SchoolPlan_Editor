# 品質保証基盤

## 目的

週案エディタの品質ゲートは、既存UIを変えずに、変更による回帰、構文エラー、権限の過剰化、秘密情報の混入をマージ前に検出するための基盤です。GAS実環境でしか確認できない項目を置き換えるものではなく、手動検証へ進む前の高速な第一防衛線として機能します。

## 自動品質ゲート

GitHub Actionsの`Quality Gate`は、Pull Request、`main`へのpush、手動実行で起動します。Node.js 20と22の両方で`npm run quality`を実行します。

### 静的検証

`scripts/check-project.mjs`は次を確認します。

1. 必須ファイルが存在すること。
2. 各GASファイルとGAS全体がJavaScriptとして構文解析できること。
3. 各HTMLのインラインJavaScriptが構文解析できること。
4. `App.html`のincludeを展開したアプリ全体が構文解析できること。
5. include先が実在し、循環参照がないこと。
6. `appsscript.json`がV8、タイムゾーン、OAuthスコープを正しく宣言していること。
7. フルDrive権限など、設定で禁止した広範なOAuthスコープが追加されていないこと。
8. マージ競合マーカーや高確度の秘密情報が残っていないこと。
9. PWA制約上のセキュリティ例外が、承認済みファイル以外へ拡大していないこと。

### 回帰テスト

`tests/project-quality.test.mjs`は品質チェッカーそのものをテストします。検査ツールの変更で品質ゲートが黙って弱くならないよう、正常系と代表的な異常系を固定しています。

## セキュリティ例外の管理

`quality.config.json`は、意図的な例外をコードとは別に記録します。

- `securityExceptions.wildcardPostMessage`
- `securityExceptions.xFrameAllowAll`

例外追加は通常の修正ではありません。GAS/PWAプラットフォーム上の必要性が確認でき、より狭い方法が使えず、緩和策が記録された場合に限ります。

## 品質ゲートが扱わないもの

以下はGAS、Google Workspace、実ブラウザに依存するため、PRテンプレートに沿って手動確認します。

- `google.script.run`の実通信
- スプレッドシートの読込・書込・ロック
- Gemini、Classroom、Drive、Pickerの認証とAPI応答
- トリガー、メール送信、実行時間制限
- 印刷レイアウト
- タッチ操作、レスポンシブ表示、スクリーンリーダー
- 実データを使ったマイグレーションと復元

## 推奨ブランチ保護

リポジトリ設定で次を有効にすると、品質基盤を強制できます。

- `main`への直接pushを禁止
- Pull Requestを必須化
- `Quality Gate / Node 20`と`Quality Gate / Node 22`の成功を必須化
- CODEOWNERSレビューを必須化
- 会話の解決を必須化
- force pushとブランチ削除を禁止

GitHub側のブランチ保護設定はリポジトリ管理者が行います。コードだけでは強制されません。
