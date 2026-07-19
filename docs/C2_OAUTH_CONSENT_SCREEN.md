# C2: OAuth 同意画面（External）構成手順

> 目的: 共通URLで複数校の教員に配布するため、OAuth 同意画面を **External（外部）** で構成し、必要スコープを登録して公開する。
>
> 前提: C1（標準 GCP プロジェクト紐付け）が完了していること。

## ユーザータイプの選択

| タイプ | 対象 | 検証 |
|--------|------|------|
| **External** | 任意の Google アカウント（複数校配布・共通URL運用） | 公開時に Google 検証が必要（C4） |
| Internal | 同一 Google Workspace 組織内のみ | 検証不要だが組織外は使えない |

- **複数校・共通URL運用 → External** を選択（本ロードマップのゴール）。
- 単一学校（同一ドメイン）限定運用なら Internal も可（検証不要で導入が速い）。

## 手順（External）

### 1. 同意画面の基本情報
Cloud Console →「API とサービス」→「OAuth 同意画面」→ External を選択して作成:
- **アプリ名**: 例）週案エディタ
- **ユーザー サポートメール**: 配布元の連絡先
- **アプリのロゴ**: 任意（検証時に本人確認が入る場合あり）
- **アプリのホームページ**: GitHub Pages のURL（例: `https://<user>.github.io/SchoolPlan_Editor/`）
- **プライバシーポリシー URL**: `https://<user>.github.io/SchoolPlan_Editor/privacy-policy.html`（C3 で用意）
- **利用規約 URL**: `https://<user>.github.io/SchoolPlan_Editor/terms.html`（C3 で用意）
- **承認済みドメイン**: `github.io`（GitHub Pages 運用時）と `google.com`

### 2. スコープの登録
「スコープを追加または削除」で、`appsscript.json` と一致する以下を登録します。

| スコープ | 区分 | 用途説明（検証で問われる） |
|----------|------|--------------------------|
| `.../auth/userinfo.email` | 機微でない | ログインユーザーの識別（マルチテナントのDB分離） |
| `.../auth/spreadsheets` | 機微 | 各ユーザー所有のスプレッドシート（DB）の読み書き |
| `.../auth/drive.file` | **機微でない（推奨）** | アプリが作成・ユーザーが選択したファイルのみ操作 |
| `.../auth/script.send_mail` | 機微 | タスクリマインダーのメール送信 |
| `.../auth/classroom.courses.readonly` | **機微（sensitive）** | 連携クラス一覧の取得 |
| `.../auth/classroom.announcements` | **機微（sensitive）** | 予定・学級通信のお知らせ投稿 |

> **ポイント**: B2 で `drive` フル → **`drive.file`** に最小化済み。`drive.file` は restricted 扱いを避けられ、CASA セキュリティ評価の負担が下がります（C4 参照）。Classroom の 2 スコープは sensitive のため、用途説明とデモ動画が必要になります。

### 3. テストユーザー登録 →（検証後）公開
1. 公開ステータス「テスト」の間は、**テストユーザー**に登録したアカウントのみ利用可能（各校の代表教員などを登録して先行検証）。
2. 準備が整ったら「アプリを公開」→ 公開ステータスを「本番環境」に。
3. sensitive/restricted スコープを含むため、**Google 検証（C4）** の対象になります。検証承認までは「未確認アプリ」警告が出ます（テストユーザーは警告を回避可能）。

## ドメイン限定運用の代替（Internal）
- 同一 Workspace 内のみで使うなら Internal を選択 → 検証不要で即利用可能。
- ただし他校（別ドメイン）の教員は利用できないため、共通URLでの横断配布には不向き。

## 受け入れ基準
- [ ] External 同意画面が作成され、アプリ名・サポートメール・ポリシーURLが登録済み。
- [ ] `appsscript.json` と一致するスコープが登録済み。
- [ ] テストユーザーで実機ログイン→オンボーディング→アプリ利用が通る。
- [ ] （公開する場合）検証申請の準備（C4）へ進める状態。

## 参考
- 同意画面の設定: https://support.google.com/cloud/answer/10311615
- スコープと検証: https://support.google.com/cloud/answer/9110914
