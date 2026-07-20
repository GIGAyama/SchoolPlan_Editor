# B3: トークン露出・iframe 埋め込みの厳格化（調査と対応）

> 対象: `03_PdfProcessing.gs` の `getPickerAuthInfo`（`ScriptApp.getOAuthToken()` のフロント返却）と、
> `07_WebApp.gs` の `doGet` における `setXFrameOptionsMode(ALLOWALL)`。

## 1. Picker 用 OAuth トークンの露出

### 現状
`getPickerAuthInfo()` は `ScriptApp.getOAuthToken()` をフロントに返し、`google.picker.PickerBuilder().setOAuthToken()` に渡しています。

### 評価
- **トークンのフロント返却は Google Picker の仕様上避けられません**（Picker はクライアントで OAuth トークンを要求します）。
- ただし **B2 でスコープを `drive.file` に最小化**したため、このトークンで到達できるのは
  「アプリが作成・ユーザーが Picker で選択したファイル」のみです。フル `drive` スコープ時代のような
  「ユーザーの全 Drive にアクセスできるトークン」ではなくなり、**露出範囲は大幅に縮小**しています。
- トークンは短命（実行コンテキストの有効期限内）で、Picker を開くその場だけで使用し、保存しません。
- 返却情報はトークンのみ（Developer Key 等は付与しない）に最小化しています。

### 対応
- コード上の追加最小化余地は小さいため、`getPickerAuthInfo` に上記の設計意図をコメントで明文化（実装済み）。
- **本質的な最小化は B2（`drive.file`）で達成済み**、と位置づけます。

## 2. iframe 埋め込み（X-Frame-Options）

### 現状
`doGet` は `setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)` を設定しています。
GitHub Pages の PWA シェル（`docs/index.html`）が exec URL を `<iframe id="appFrame">` で埋め込むためです。

### 調査結果（GAS の制約）
Apps Script の `HtmlService.XFrameOptionsMode` は **2値のみ**です。

| 値 | 挙動 | PWA シェル埋め込み |
|----|------|:---:|
| `DEFAULT` | `X-Frame-Options` を設定し、**google 系ドメインからのみ**フレーム可 | ❌ 不可（GitHub Pages から埋め込めない） |
| `ALLOWALL` | フレーム制限を外し、**任意オリジン**から埋め込み可 | ✅ 可 |

- **特定オリジン（GitHub Pages ドメイン）に限定する選択肢は存在しません。** サブドメイン限定・オリジン許可リストも不可。
- したがって、PWA シェルで exec URL を iframe 埋め込みする現行構成では **`ALLOWALL` が必須**です。

### リスクと緩和
`ALLOWALL` は任意サイトが本アプリを iframe 埋め込みできる状態ですが、実害は以下の理由で限定的です。

1. **アプリ本体は GAS のサンドボックス iframe 内（`*.googleusercontent.com`）で実行**されます。外側の埋め込みページ（別オリジン）からは、
   同一オリジンポリシーにより **DOM・`google.script.run` ブリッジ・Picker トークンを読み取れません**。
2. サーバー側 API はすべて **アクセスユーザーとして実行**され、認可済みユーザー本人のデータのみを扱います（マルチテナント分離）。
   埋め込み元が第三者でも、操作はログイン中ユーザー自身の権限に閉じます。
3. 残るリスクは **クリックジャッキング**（正規UIに見せかけた誘導クリック）ですが、機微操作（DB切替・紐付け解除）は
   確認ダイアログ（SweetAlert）を挟むため、単純なワンクリック誘導は成立しにくい構成です。

### 選択肢（今後）
- **(推奨・現状維持)** `ALLOWALL` を維持し、上記の GAS 制約を明文化する（実装済みコメント＋本書）。
- **(代替)** PWA シェルを「iframe 埋め込み」ではなく「exec URL を新規タブ/リダイレクトで開く」構成に変更すれば `DEFAULT` を使えます。
  ただしアプリ内蔵感（アドレスバー非表示・単一画面）が損なわれ、PWA の体験が変わるため **D2（PWA シェル）と併せて別途検討**とします。
- **(補助)** クライアント側で「想定外オリジンからの埋め込み警告」を出す soft ガードは、クロスオリジンで
  `window.top.location` を読めないため確実な判定ができず、正規の GitHub Pages 埋め込みを誤ブロックする恐れがあるため**見送り**。
- **(実装済み)** 逆向きの「肯定シグナル」による表示失敗の検知は導入済み。App 本体（`App.html`）が読み込まれた時点で
  `window.top.postMessage({ type: 'schoolPlanNote:ready' }, '*')` を送り、PWA シェル（`docs/index.html`）がこれを受信できれば
  「iframe 内にアプリ本体が表示できた」と判断する。一定時間（既定20秒）受信できない場合は、**組織（学校）アカウント等で
  iframe 内に表示できず Google のエラー画面（404）が出た**とみなし、シェルが「新しいタブ/トップレベル遷移で開く」案内へ自動で切り替える。
  クロスオリジンで受信内容を読み取れない従来の制約を、`postMessage` の肯定シグナルで回避している。

## 結論
- **トークン露出**: B2 の `drive.file` 化により本質的に最小化済み。Picker 仕様上のトークン返却は残るが、影響範囲は限定的。コメントで明文化。
- **iframe 埋め込み**: GAS の仕様上、特定オリジン限定は不可能。PWA シェル運用では `ALLOWALL` が必須で、サンドボックス実行とマルチテナント分離により実害は限定的。制約と緩和策を明文化。
- より厳格化するなら、PWA シェルの非iframe化（`DEFAULT` 利用）を D2 で検討する。
