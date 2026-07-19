# B1: Drive 利用の棚卸し（`drive` → `drive.file` 化 可否レポート）

> 目的: `appsscript.json` の `.../auth/drive`（フルスコープ）を `.../auth/drive.file`（アプリが作成・ユーザーが選択したファイルのみ）に縮小できるか判断するための調査。**コード変更は含みません。** B2 以降の改修方針の前提資料です。

## 現状スコープ（`appsscript.json`）

| スコープ | 用途 |
|----------|------|
| `spreadsheets` | 各ユーザーのDB（スプレッドシート）読み書き |
| **`drive`（フル）** | 本レポートの対象。PDFフォルダ列挙・ファイル作成/共有・テンプレ複製 等 |
| `script.container.ui` | メニュー等 |
| `script.scriptapp` | トリガー管理 |
| `script.external_request` | Gemini API 等の外部リクエスト |
| `script.send_mail` | タスクリマインダー |
| `userinfo.email` | ログインユーザー識別（マルチテナント） |
| `classroom.courses.readonly` / `classroom.announcements` | Classroom 連携 |

## `drive.file` の性質（判定基準）

`drive.file` でアプリがアクセスできるのは次のファイル/フォルダのみ:
1. **アプリ自身が作成**したファイル/フォルダ（`createFile` / `createFolder` / `SpreadsheetApp.create`）
2. **ユーザーが Google Picker で明示的に選択**したファイル（選択時に per-file 権限が付与される）

→ **任意のフォルダIDを指定した列挙・検索（`getFolderById(id).getFilesByType()` 等）は不可。** これが本アプリ最大の論点。

## 利用箇所の棚卸し（全数）

| # | 箇所 | 処理 | 種別 | `drive.file`で足りるか | 必要な対応 |
|---|------|------|------|:---:|------|
| A1 | `03_PdfProcessing.gs:518-519` `getPdfFileListForWebApp` | フォルダID内のPDF列挙 | フォルダ列挙 | ❌ | Picker移行 or `drive.readonly` |
| A2 | `03_PdfProcessing.gs:556-589` `getEventPdfLibraryForWebApp` | ルート+サブフォルダ列挙（学校別グループ） | フォルダ列挙 | ❌ | 再設計（app管理フォルダ）or `drive.readonly` |
| A3 | `03_PdfProcessing.gs:22-23, 282-283` 旧UI一括取込 | フォルダ内PDF列挙 | フォルダ列挙 | ❌ | Picker移行（またはメニュー廃止） |
| B1 | `03_PdfProcessing.gs:617-625` `uploadEventSchedulePdf` | 指定フォルダ/サブフォルダにPDF保存 | 任意フォルダ書込 | △ | app管理フォルダへ再設計 or Pickerでフォルダ選択 |
| C1 | `03_PdfProcessing.gs:113,149,336,773` | キュー内 `fileId` を `getFileById` で読取 | ファイルID読取 | △ | **Picker由来のIDなら可**／フォルダ列挙由来なら不可 |
| D1 | `07_WebApp.gs:844-863` 週案PDF出力 | export→rootに`createFile`→`setSharing`→`downloadUrl` | app作成ファイル | ✅ | 改修不要 |
| D2 | `07_WebApp.gs:909-922` Classroom用PDF | export→`createFile`→`setSharing`、`getFileById`(自作) | app作成ファイル | ✅ | 改修不要 |
| D3 | `05_Classroom.gs:420-426` 学級通信シート投稿 | export→rootに`createFile`、旧ファイル`setTrashed` | app作成ファイル | ✅ | 改修不要 |
| D4 | `07_WebApp.gs:1082` PDF削除 | 自作ファイル `setTrashed` | app作成ファイル | ✅ | 改修不要 |
| E1 | `07_WebApp.gs:946-973` `getOrCreateNwFolder_` | 学級通信データフォルダ作成/検索、JSON保存 | app管理フォルダ | ✅※ | 原則不要（※移行注記あり） |
| E2 | `07_WebApp.gs:1054` 学級通信データ読取 | 自作JSONを`getFileById` | app作成ファイル | ✅ | 改修不要 |
| F1 | `11_Tenant.gs:336` `createMyDatabase` テンプレ複製 | 他人所有テンプレを`getFileById().makeCopy()` | 他人所有ファイル | ❌ | A4のプログラム構築へ一本化（テンプレ方式は非推奨化） |
| G1 | `07_WebApp.gs:1225` `protection.addEditor` | シート保護の編集者付与 | Drive非依存 | ✅ | 対象外（Spreadsheet権限） |
| G2 | `03_PdfProcessing.gs:1204` `getPickerAuthInfo` | Picker用に`getOAuthToken()`返却 | Picker基盤 | ✅ | 対象外（B3で最小化検討） |

凡例: ✅=`drive.file`で成立 / △=条件付き / ❌=`drive.file`では不可

### 補足
- **E1（学級通信データフォルダ）**: `createFolder`/`getFoldersByName` はアプリ作成物のみが対象になるため `drive.file` でも動作します。ただし**現行フル`drive`スコープで作成済みの既存フォルダ**は、`drive.file` 移行後に「アプリ作成物」として認識されない可能性があります。移行時は新フォルダを作り直す（または初回に自動再作成する）フォールバックが必要です。
- **C1（トリガーでの`getFileById`）**: Picker で選択したファイルは per-file 権限が付与され、後続のトリガー実行（アクセスユーザーとして実行）でも `getFileById` で読める想定です。ただし GAS + Picker + `drive.file` のトリガー跨ぎアクセスは**デプロイ後の実機検証が必須**（本環境では確認不可）。

## 結論

### `drive.file` 化は可能。ただし「行事予定ライブラリ（学校別フォルダ表示）」の扱いが分岐点。

**純粋な読み込み用途（指導計画PDF・行事予定PDFの一括取込 = A1/A3/C1）は Picker で完全に `drive.file` 化できます。** 既存の Picker（`MULTISELECT`、`getPickerAuthInfo`、`pickerCallback`）資産があり、Picker選択→同じ解析キュー→`getFileById` の導線がすでに動いているため、「フォルダ設定＋列挙（`addFolderPdfs`）」を Picker 複数選択に置き換えるだけで済みます。

**分岐するのは A2/B1（行事予定タブの「学校ごとにサブフォルダをグループ表示」「サブフォルダへアップロード」）です。** これはフォルダ列挙に本質的に依存するため `drive.file` では再現できません。選択肢:

- **推奨: (a) Picker移行 + app管理フォルダへ再設計**
  - 取込系（指導計画・行事の一括読み込み）は **Picker 複数選択** に統一（A1/A3/C1 を解消）。
  - 行事予定ライブラリ（A2/B1）は、アプリが作成する単一ルートフォルダ配下に集約し、**そのapp作成フォルダ配下のみを列挙**する方式へ再設計（app作成物なので `drive.file` で列挙可）。学校別は「サブフォルダ」ではなくメタデータ（シート管理）で表現する案が親和的。
  - `sp_dbTemplateId` によるテンプレ複製（F1）は `drive.file` 非対応のため、**A4 のプログラム構築（`initializeNewDatabase_`）に一本化**し、テンプレ方式は `drive.file` 運用では非推奨化。
  - 出力・共有（D1〜D4）、学級通信フォルダ（E1/E2）は改修不要。

- **代替: (b) `drive.readonly` を追加してフォルダ列挙を維持**
  - A1/A2/A3 のフォルダ列挙をコード変更なしで維持できるが、`drive.readonly` は sensitive/restricted 寄りで **Google 検証（CASA セキュリティ評価）が重くなる**。B2 以降の審査負荷（Phase C4）とトレードオフ。

### 推奨方針（B2 への引き継ぎ）

1. `appsscript.json`: `auth/drive` → `auth/drive.file` に変更。
2. 取込系フォルダ導線（`addFolderPdfs` / `getPdfFileListForWebApp` / 旧メニュー一括）を **Picker 複数選択へ置換**（B2）。既存 `App_Js_07_PdfImport.html` の Picker を流用。
3. 行事予定ライブラリ（`getEventPdfLibraryForWebApp` / `uploadEventSchedulePdf`）は **app管理フォルダ + シートでの学校メタデータ管理**へ再設計（B2）。移行できない既存フォルダ運用は段階的に非推奨化。
4. テンプレ複製は A4 のプログラム構築へ一本化。
5. `getPickerAuthInfo` のトークン露出最小化・iframe 埋め込み厳格化は B3 で対応。
6. **実機検証必須**: Picker選択ファイルの「トリガー跨ぎ `getFileById`」が `drive.file` で成立するか、`drive.file` 移行後の既存 app フォルダ（E1）の再作成挙動。

> なお `drive.file` 化は再認可（ユーザーの同意し直し）が必要です（B2 の受け入れ基準どおり README に明記予定）。
