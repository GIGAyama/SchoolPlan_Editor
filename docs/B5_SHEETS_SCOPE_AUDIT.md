# B5: `spreadsheets` → `drive.file` 化 可否レポート

> 目的: `appsscript.json` の `.../auth/spreadsheets` を落とし、**`drive.file` だけで**
> データベース（スプレッドシート）を読み書きできるかを判断するための調査。
> **本体の移行は含みません。** §5 のフェーズ1（取得口の集約）だけ済ませてあり、
> 残りは本レポートの手順に沿って別 PR で進めます。
>
> 背景: 2026-08 の OAuth 審査差し戻しで、Google から
> 「`spreadsheets` は `drive.file` で足りるのではないか」と指摘されました（[C6](C6_VERIFICATION_RESPONSE.md) §4）。

---

## 結論

### `drive.file` 化は **可能**。ただし `SpreadsheetApp` を捨て、Sheets REST API v4 に載せ替える必要がある。

これは Drive で通った道（[B1](B1_DRIVE_SCOPE_AUDIT.md)）とまったく同じ構図です。

| | Drive（対応済み） | Sheets（本レポート） |
|---|---|---|
| 組み込みサービス | `DriveApp` | `SpreadsheetApp` |
| それが要求するスコープ | `drive`（フル） | `spreadsheets` |
| REST API が受け付けるスコープ | Drive API v3 は `drive.file` 可 | **Sheets API v4 も `drive.file` 可** |
| 採った解決策 | `17_DriveApi.gs`（`UrlFetchApp` + `ScriptApp.getOAuthToken()`） | 同じ方式で `18_SheetsApi.gs` を作る |

**「`SpreadsheetApp` が使えなくなるから無理」という理由は使えません。**
Google は差し戻しメールで明示しています。

> UI preferences or **client library limitations alone are not valid policy exceptions** from these requirements.

つまり Option 2（`Unable to use narrower scopes`）で通す根拠が本アプリにはありません。
**Option 1（`Confirming narrower scopes`）を選び、移行するのが唯一の現実的な道**です。

---

## 1. 技術的な前提

### 1-1. Sheets API v4 は `drive.file` を受け付ける

`spreadsheets.get` / `spreadsheets.create` / `spreadsheets.batchUpdate` /
`spreadsheets.values.get` / `values.update` / `values.batchUpdate` / `values.append` / `values.clear`
のいずれも、認可スコープとして次の3つを認めています。

- `https://www.googleapis.com/auth/drive`
- **`https://www.googleapis.com/auth/drive.file`**
- `https://www.googleapis.com/auth/spreadsheets`

### 1-2. `drive.file` の適用範囲に、本アプリの DB は収まる

`drive.file` で触れるのは「アプリが作ったファイル」と「利用者がピッカーで選んだファイル」だけです。

- **新規利用者**: DB は `createMyDatabase()` が**アプリ自身で作成**します（`11_Tenant.gs`）。→ そのまま対象内。
- **既存利用者**: `spreadsheets` スコープの時代に作られた DB は、`drive.file` 移行後に
  「アプリ作成物」と認識されない可能性があります。→ **Google ピッカーで一度選び直してもらう**導線が必要です。
  ピッカーの実装（`getPickerAuthInfo` / `App_Js_07_PdfImport.html`）は既にあるので、
  DB 紐付け画面（`linkMyDatabase`）に転用できます。

> ⚠️ ここは **実機検証必須**です。「フル `drive` で作られた既存ファイルが、`drive.file` 移行後に
> ピッカー選択で per-file 権限を得られるか」は、Drive の E1（学級通信フォルダ）で同じ論点が残っています（[B1](B1_DRIVE_SCOPE_AUDIT.md) 補足）。

---

## 2. 利用箇所の棚卸し

### 2-1. スプレッドシートの取得口（ここが最重要）

| 呼び出し | 件数 | 備考 |
|----------|:---:|------|
| `SpreadsheetApp.getActiveSpreadsheet()` | 39 | 内訳は下表（ほかにコメント中の言及が 1 件） |
| `SpreadsheetApp.openById()` | 3 | `getSs_()` と `11_Tenant.gs`（紐付け・状態確認） |
| `SpreadsheetApp.create()` | 2 | DB 新規作成 |
| `SpreadsheetApp.flush()` | 13 | REST では不要（呼び出しごとに確定するため） |

`getActiveSpreadsheet()` の 39 件を分類すると、実際に手当てが要るのは一部だけです。

| 内訳 | 件数 | 扱い |
|------|:---:|------|
| `typeof getSs_ === 'function' ? getSs_() : SpreadsheetApp.getActiveSpreadsheet()` という防御的な三項 | 21 | **実質すでに `getSs_()` 経由。**`.gs` は同一グローバルスコープを共有するので `getSs_` が未定義になることはなく、フォールバック側は死にコード。→ **フェーズ1で `getSs_()` に単純化済み** |
| `toast()` / `getUi()` を伴う、コンテナバインド専用の経路（`onOpen`・`_UI` 系・`setupTriggerCleaner`） | 16 | 移行対象外（§2-3） |
| `getSs_()` 本体と `doGet` のバインド判定 | 2 | **意図的にそのまま。**「バインドされているか」を見る箇所なので `getSs_()` に置き換えてはいけない |

**`07_WebApp.gs` の `getSs_()` が唯一の正しい取得口**です。
Web アプリ実行時は `getActiveSpreadsheet()` が `null` を返すため、
新しく書くコードは必ず `getSs_()` を通します。

### 2-2. 使っている Sheet / Range の API

実際に呼ばれているメソッドは、次の範囲に収まります（`.sort()` は全 23 件が `Array.prototype.sort` で、`Range.sort()` は不使用）。

| 分類 | 使っているメソッド | 概算件数 |
|------|--------------------|:---:|
| 読み取り | `getRange` / `getValues` / `getValue` / `getDataRange` / `getLastRow` / `getLastColumn` | 約 275 |
| 書き込み | `setValues` / `setValue` / `appendRow` / `clearContent` | 約 46 |
| シート操作 | `getSheetByName` / `getSheets` / `insertSheet` / `deleteSheet` / `setName` / `copyTo` | 約 60 |
| 行操作 | `deleteRow` / `deleteRows` / `insertRowsAfter` | 約 16 |
| 書式 | `setFontWeight` / `setFontColor` / `setBackground` / `setNumberFormat` / `setColumnWidth` / `setFrozenRows` | 約 24 |
| 保護 | `protect()` / `addEditor()` | 3 |

**合計およそ 470 箇所・22 ファイル**に散っています。
→ **呼び出し側を書き換える案は非現実的**です（§3 の結論に直結）。

### 2-3. コンテナバインド専用の遺物（移行しなくてよいもの）

| 呼び出し | 件数 | 判断 |
|----------|:---:|------|
| `SpreadsheetApp.getUi()` | 16 | **移行不要。** カスタムメニュー（`onOpen`）とダイアログ用で、スタンドアロン配布（[D1](.)）では動きません |
| `.toast()` | 14 | 同上 |
| `onEdit(e)` | 1 | 単純トリガーで、バインド型でしか発火しません |

配布形態はスタンドアロンで、[C5](C5_DEMO_VIDEO_SCRIPT.md) でも「カスタムメニューは映さない」と明記しています。
これらは **移行対象から外し、`_UI` 系関数ごと整理する**のが筋です（別課題として切り出し可）。

---

## 3. 移行方針

### 3-1. 採用案：`SpreadsheetApp` 互換のファサードを REST で作る

呼び出しが約 470 箇所ある以上、**呼び出し側を書き換えないで済む形**にするのが唯一現実的です。
`18_SheetsApi.gs`（仮）に、アプリが実際に使う API だけを備えた薄いファサードを実装し、
`getSs_()` がそれを返すようにします。

```
getSs_()  →  sheetsOpen_(id)            // Spreadsheet 相当
                .getSheetByName(name)   // Sheet 相当
                  .getRange(a1)         // Range 相当
                    .getValues()        // values.get
                    .setValues(v)       // values.update
```

`17_DriveApi.gs` で `driveOpenFile_()` が `getId()` / `getName()` / `getBlob()` だけを備えた
読み取り用オブジェクトを返しているのと、まったく同じ考え方です。

### 3-2. `SpreadsheetApp` → Sheets REST v4 の対応

| 現在の呼び出し | REST での実現 |
|----------------|----------------|
| `openById(id)` | `spreadsheets.get?fields=properties,sheets.properties`（メタだけ先読み） |
| `create(name)` | `spreadsheets.create` |
| `getSheetByName` / `getSheets` / `getName` | 上で取得した `sheets[].properties` から解決（追加の通信なし） |
| `getRange(a1).getValues()` | `values.get?range=A1記法` |
| `getDataRange().getValues()` | `values.get`（シート名のみ指定） |
| `getLastRow()` / `getLastColumn()` | `values.get` の結果長、または `gridProperties`。**意味が微妙に違う**ので §4 参照 |
| `setValues()` / `setValue()` | `values.update`（複数まとめるなら `values.batchUpdate`） |
| `appendRow()` | `values.append` |
| `clearContent()` | `values.clear` |
| `insertSheet` / `deleteSheet` / `setName` | `batchUpdate`: `addSheet` / `deleteSheet` / `updateSheetProperties` |
| `deleteRow(s)` / `insertRowsAfter` | `batchUpdate`: `deleteDimension` / `insertDimension` |
| `setColumnWidth` / `setFrozenRows` | `batchUpdate`: `updateDimensionProperties` / `updateSheetProperties` |
| `setFontWeight` / `setFontColor` / `setBackground` / `setNumberFormat` | `batchUpdate`: `repeatCell`（`userEnteredFormat`） |
| `copyTo` | `batchUpdate`: `duplicateSheet`（別ファイルへなら `sheets.copyTo`） |
| `protect()` + `addEditor()` | `batchUpdate`: `addProtectedRange`（`editors.users`） |
| `flush()` | 不要（削除する） |
| `getUi()` / `toast()` | 移行しない（§2-3） |

**対応表に「実現できない」項目はありません。**

### 3-3. 性能をどう保つか

`SpreadsheetApp` も内部は RPC ですが、ランタイム側でまとめてくれます。
ファサードで素朴に 1 呼び出し = 1 リクエストにすると、週案の描画で往復が跳ね上がります。対策:

1. **メタは 1 回だけ取る** … `spreadsheets.get` の結果（シート名・ID・グリッド寸法）を実行中キャッシュに持つ
2. **読みはまとめる** … 同一実行内の複数レンジは `values.batchGet` に集約する
3. **書きはまとめる** … `values.batchUpdate` / `batchUpdate` に集約し、確定は 1 回にする
4. 既存の V2 API（`12_Performance.gs`）は、もともと「週単位でまとめて読む」設計なので相性が良い

---

## 4. 落とし穴（実装時に必ず踏むもの）

- **`getLastRow()` の意味が違う**
  `SpreadsheetApp` の `getLastRow()` は「データのある最終行」です。
  `gridProperties.rowCount` は「シートの行数」なので**別物**。`values.get` の返り値の長さで代替します。
  約 75 箇所で使われているので、ここを取り違えると広範囲に壊れます。
- **`values.get` は末尾の空行・空列を返さない**
  行ごとに長さが不揃いな二次元配列が返ります。`SpreadsheetApp` は矩形で返すので、
  **ファサード側で矩形に整形（パディング）**しないと、既存コードの `row[COL_X]` が `undefined` になります。
- **日付・数値の型**
  `values.get` は既定で文字列寄りに返ります（`valueRenderOption` / `dateTimeRenderOption` の指定が要る）。
  週案は日付列を `Date` として扱う箇所があるため、**取得オプションと変換方針を決めてから着手**します。
- **数式**
  `getValues` は計算後の値、`getFormulas` は数式。`valueRenderOption=FORMULA` で切り替えます。
  年間カレンダー生成が数式を書くため、上書きで数式を壊さないよう注意が必要です。
- **API クォータ**
  Sheets API は 1 分あたりの読み書き回数に上限があります。まとめ読み・まとめ書きを徹底しないと、
  PDF 一括取り込みのようなループ処理で 429 に当たります（`17_DriveApi.gs` 同様に再試行を入れる）。
- **既存 DB の再認可**
  `drive.file` へ移行すると、利用者には**同意し直し**が発生します。加えて既存 DB は
  ピッカーで選び直してもらう必要が出る可能性があります（§1-2）。**移行時の案内文が必須**です。

---

## 5. 進め方（フェーズ分け）

1. **下ごしらえ**（✅ 実施済み） … 防御的な三項 21 箇所を `getSs_()` に単純化しました。
   死にコードを畳むだけで挙動は変わりません。
2. **コンテナバインドの遺物を整理** … `onOpen` / `getUi` / `toast` / `onEdit` と `_UI` 系関数を切り離す。
3. **`18_SheetsApi.gs` を実装** … §3-2 の対応表の範囲でファサードを作る。まずは読み取り系だけ。
4. **`getSs_()` をファサードに切り替え** … 読み取り経路から段階的に。フラグで旧経路へ戻せるようにしておく。
5. **書き込み・書式・保護を移す** … 影響範囲が大きい順に、実機で確認しながら。
6. **静的検査を追加** … `tests/drive-scope.test.mjs` と同じ要領で、`SpreadsheetApp` の再混入を防ぐ。
7. **スコープを外す** … 動作確認後に `appsscript.json` と Cloud Console から `spreadsheets` を落とす。
8. **動画を撮り直す** … 同意画面のスコープが変わるため、[C5](C5_DEMO_VIDEO_SCRIPT.md) の撮影が再度必要です。

> ⚠️ **7 を先にやらないこと。** スコープを落としてから移行すると、その間アプリが全面的に動かなくなります。

---

## 6. Google への返信タイミング

差し戻しメールは「対応したら返信せよ」という体裁ですが、移行には相応の時間がかかります。
審査を止めないため、次のどちらかを選びます。

- **(a) 先に返信する**（推奨）
  指摘 1〜3（動画・AI 連携・保護措置）の対応を済ませて返信し、指摘 4 については
  「`drive.file` へ移行する方針で、実装中である」と伝えます。返信文の骨子は [C6](C6_VERIFICATION_RESPONSE.md) §5 にあります。
  ただし **"Confirming narrower scopes" は、実際に外してから**送ってください（未完了で送ると次の差し戻しになります）。
- **(b) 移行を終えてから、まとめて返信する**
  一度で終わる可能性は高いですが、その間 Google 側は「返信待ち」のまま止まります。

---

## 次にやること
- フェーズ 1（`getSs_()` への集約）から着手します。
- 移行の全体像と返信文は [C6: 審査差し戻しへの回答](C6_VERIFICATION_RESPONSE.md) にまとめてあります。
