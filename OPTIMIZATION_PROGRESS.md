# コード最適化 進捗・引き継ぎメモ

## 【最新セッション】全体レビューによるバグ修正 7件（branch: claude/app-review-optimization-io12ss）

全 .gs / .html を通読し、実バグのみを修正。全変更ファイル node --check 済み。

1. **[FE/重要] 閲覧モードのセル操作が保存されず消える** — D&Dのコマ入替・ペースト・クリア・
   右クリック一括クリア・Undo/Redo は `STATE.weekData.days`（保存済みベースライン）を直接書き換えるため、
   サーバーへ保存されず週を移動すると変更が静かに失われていた → 操作後600msデバウンスで
   `saveWeeklyPlanData` を自動実行する `persistViewMutation()` を追加（楽観ロック・競合ダイアログ対応。
   編集モード中は既存の保存フローに任せるため何もしない）。
2. **[FE] クエリ付きURLのリンク化が途中で切れる**（`linkify`）— escHtml後の `&amp;` をURL文字として
   除外していたため `?a=1&b=2` 形式のURL（YouTube等）が `&` で切れていた → `(?:&amp;|[^\s<&])+` に修正。
3. **[FE] 週案印刷のセル値が未エスケープ** — `<` `>` を含む入力が印刷HTMLを壊し、数値のみのセルは
   `.replace` で例外になり印刷自体が失敗しうる → 印刷HTML生成（標準/コンパクト/週末/時数表/Todo）の
   全セル出力を `escHtml()` 経由に統一。
4. **[FE] 単元マスタピッカーのホバー色が効かない** — 未定義変数 `var(--bg-hover)` をフォールバック無しで
   使用 → `var(--bg-hover, var(--surface-hover))` に修正。
5. **[FE] 「以降を一括自動入力」ボタンが初回ロード時だけ非表示** — `updateEditUI()` は閲覧モードでも
   表示する仕様（display:flex）なのに、初期HTMLが display:none のため編集モードを一度通るまで
   出現しなかった → 初期スタイルを display:flex に統一。
6. **[FE] 設定画面「一覧取得」ボタンが暗黙のグローバル `event` 依存** — `fetchSettingCourseList(this)`
   でボタン要素を明示的に渡す形に修正（App.html + App_Js.html）。
7. **[BE] 行事予定PDF処理の年度が文字列だと過去月まで処理対象になる**（03_PdfProcessing.gs
   `startEventPdfProcessingFromWebApp`）— `fiscalYear + 1` が文字列連結（"2025"+1→"20251"）になり
   1〜3月の年判定が壊れる → `parseInt` で正規化し NaN はエラーに（現行フロントは数値を渡すため防御的修正）。

### 追加改善（同ブランチ）
- **ローディング表示のビューポート中央固定**（`.loading-state` を position:fixed 化・spinner の margin auto・
  週案ロード時の残留 inline 幅リセット）。縦横どちらの画面でも常に画面中央に表示。
- **タブレット（タッチ）操作対応**: 閲覧モードのセルを「同一セル2連タップ（ダブルクリック）」で
  編集モード開始＋該当入力欄へフォーカス（Enterキーと同じ経路 `startEditAtSelectedCell()` を共用）。
  校時セルの「長押し」でコンテキストメニュー（コピー/ペースト/クリア）を表示（右クリック代替。
  スクロールと区別するため指の移動でキャンセル、メニュー表示直後のクリック抑止付き）。
  CSS: セルに `touch-action: manipulation`（ダブルタップズーム無効化）、タッチ端末かつ閲覧モード時のみ
  `user-select:none`（長押しのテキスト選択と競合回避）。ショートカットヘルプにタッチ操作の行を追加。

### 要GAS/ブラウザ検証
- タブレット実機: セル2連タップで編集開始＆キーボード表示 / コマ長押しでメニュー / スクロールが誤発火しないか。
- 閲覧モードでコマをD&D入替 → 週を移動して戻り、入替が保持されているか（自動保存）。
- セルにYouTube等の `&` 入りURLを入れてリンク全体がクリック可能か。
- 週案印刷（標準/コンパクト）が従来どおりの見た目か（エスケープ追加による差異がないか）。
- 閲覧モードのツールバーに「以降を一括自動入力」が最初から表示されるか。

---

## 【前々セッション】全体レビューによるバグ修正 8件（branch: claude/app-review-optimize-t9mci1）

全 .gs / .html を通読し、実バグのみを修正（機能追加・見た目変更なし）。全ファイル node --check 済み。

1. **[FE] PDF読み込みタブ「強制リセット」ボタンが機能しない** — Webから `resetAllPdfProcessing_UI()`
   （`SpreadsheetApp.getUi()` 依存のメニュー専用関数）を呼んでいた → `resetAllPdfProcessingFromWeb()` に変更。
2. **[BE] 長期休業デフォルト日付の年ズレ**（02_Database.gs `getDefaultExclusionDates`）— 冬休み・春休みが
   暦年基準だったため、1〜3月にアクセスすると1年未来の日付になっていた → 年度（4月始まり）基準に統一。
3. **[FE] 週案印刷で改行が消える**（`printWeeklyPlanExec`）— 行事/朝学習/中休み/昼休み/放課後/週末セルが
   `/\\n/g`（リテラル「\n」）を置換していて実際の改行が `<br>` にならなかった → `/\n/g` に修正（7箇所）。
4. **[FE] タスク期日表示の「2026-」ハードコード** — 2026年以外の期日が「2025/07-10」のように崩れた →
   `/^\d{4}-/` で年を除去（一覧・サイドバーの2箇所）。
5. **[FE] タスクの期限切れ誤判定**（`renderTaskList`）— `dueDate`("yyyy-MM-dd") と今日("yyyy/MM/dd") の
   区切り文字違いで同年内の未来の期日まで urgent 表示 → 比較前に形式を統一。
6. **[BE] AIタスク抽出の列決め打ち**（08_Gemini.gs）— 学習内容を「教科列の2つ右」と仮定 →
   `getDbColumns()` の CONTENTn を参照。04_AutoFill.gs の `findLastLesson_`/`findLatestUnitState_` の
   「3列刻み・隣が単元」決め打ちも同様に PERIODn/UNITn 参照へ（標準レイアウトでは挙動不変）。
7. **[BE] 自動投稿時刻を空にしてもトリガーが残る**（06_Settings.gs `saveAppSettings`）— 空文字で保存
   された場合に `postScheduleToClassroom` トリガーを削除するよう修正。
8. **[FE] テキスト入力中の Ctrl+Z 横取り** — 入力欄フォーカス中はアプリのグリッドUndoを発動させず
   ブラウザ標準のテキストUndoに委ねる（未保存入力がグリッド再描画で消えるのを防止）。
   ほか、存在しないサーバー関数 `generateWeeklyPlanPdf` を呼ぶ到達不能コード `downloadWeekPdf` を削除、
   「単元自動入力」ボタンのラベル復元不一致（AI自動入力になっていた）を修正。

### 要GAS/ブラウザ検証
- 強制リセットボタン / 印刷の改行 / タスク期日バッジ / 設定保存（投稿時刻を空にする）/ 単元自動入力。

---

## 【前セッション】全機能のWebボタン化 + UI洗練（要GAS/ブラウザ検証）

### 完了（push済み）
**Phase 1: 旧スプレッドシートメニュー専用機能のWebボタン化**
- 各メニュー関数のコアロジックを `*_core_`（UI非依存・結果オブジェクトを返す）に抽出し、
  Web用ラッパー `*FromWeb` を追加。**既存メニュー経路は維持（挙動不変）**。
  - `postScheduleToClassroomFromWeb`（明日の予定投稿） / `autoPostToClassroomFromWeb`（学級通信投稿）
  - `listCoursesFromWeb`（クラス一覧） / `clearDatabaseDataFromWeb`（DBクリア）
  - `resetAllPdfProcessingFromWeb`（PDF処理停止） / `protectSheetsFromWeb`（シート保護）
  - `clearDbColumnsCacheFromWeb`（キャッシュクリア）
- `createAndSavePDF` を `getSs_()` 経由に修正（Webコンテキストで `getActiveSpreadsheet()` が
  null を返し autoPost が壊れる問題を予防）。
- App.html: 設定画面に「Classroom手動投稿」2ボタン＋「メンテナンス・ツール」4ボタンを追加。
- App_Js.html: `_callServerAsync`（google.script.run の Promise化）/ `_runToolAction`
  （確認ダイアログ＋ローディング＋トースト共通化）と各ハンドラを追加。
- 全 .gs / App_Js.html を node --check 済み。

**Phase 2: CSS デザイントークン拡充・洗練（追加のみ）**
- `:root` にスペーシング(`--sp-*`)/タイポ(`--fs-*`)/補助色/モーション/フォーカスの
  トークンを追加（**既存トークンの値は不変**）。ダークモード(`prefers-color-scheme`
  自動 + `data-theme` 手動)のトークン上書きブロックを追加。
- **実バグ修正**: `--bg-card` 未定義（575行 `.link-insert-btn` が参照）→ `:root` に
  `--bg-card:#ffffff` 追加で解消。
- 仕上げ層を `</style>` 直前に追加: `:focus-visible` フォーカスリング / カスタム
  スクロールバー / smooth scroll / `prefers-reduced-motion` 配慮。いずれも既存の
  見た目を壊さない純粋な追加。
- ⚠️ **教訓**: 当初コミット(95cdd64)で「重複ボタンコメント126行を削除」を行ったが、
  これはサブエージェントの誤分析（実際には重複コメントは存在しなかった）を実体確認
  せず実行した結果、正常なCSS123行を破壊していた（`.sidebar-task-card`等が欠落、
  brace不整合 -1）。差分検証(difflib)で発覚し、元ファイルから「追加のみ」を再適用して
  修復。**サブエージェントやgrepの結果は必ずRead/diffで実体確認すること**（前任の警告通り）。
- 検証済み: 元ファイル(51b52d5)比で削除・変更行=0（純粋追加）、brace=0、`<style>`1組。

**Phase 1.5: Web文脈で壊れる `getActiveSpreadsheet()` 直呼びの一掃**
- Web公開関数なのに生 `getActiveSpreadsheet()` を使い、Web経由でnull落ちする
  **潜在バグを修正**（`getSs_()` フォールバックに統一）:
  - `getDefaultExclusionDates`（コメントに「HTML側から呼出」と明記されたWeb API）
  - `processBulkTransferWithExclusion` / `transferWeeklyTimetable`（年間一括転記の経路）
  - `writeToLog_`（**重要**: logInfo/logError の実体。Web経由ではログ書込が常に
    失敗しconsole.errorに退避していた → これで正しくログシートに残る）
  - `processEventPdf` / `processSinglePdf`（堅牢性のため統一・トリガー文脈では挙動不変）
- 残す生呼出はメニュー専用関数(`onOpen`/`TodaysRow`/`clearDatabaseDataWithConfirmation`
  /`createUnitMasterFromPdfs_UI`)・`getSs_()`定義本体・`doGet`のID記録のみ（いずれも
  SS文脈が確定しており生で正しい）。toast表示はトリガー専用装飾のため変更せず。
- 全 .gs を node --check 済み。

### ★ユーザーに依頼したい検証（GAS/ブラウザ環境）
1. 設定画面の新ボタン6種が正しく動作するか（特に明日の予定投稿/学級通信投稿/DBクリア）。
2. 新トークン追加後も既存画面の見た目が不変か（特に `.link-insert-btn` の背景が白に
   なって問題ないか）。
3. フォーカスリング/スクロールバーの見た目。

### 未着手（要視覚検証のため本環境では非実施）
- 残り約110箇所のハードコード色のトークン化（1文字で見た目が変わるため要ブラウザ）。
- 巨大関数の分割（`printWeeklyPlanExec` 等）、`subjectToHiragana` の外部化。
- タブ切替トランジション、スケルトンローディング等の体験向上。

---

## 目的
GAS + スプレッドシートDB + Vanilla JS SPA の「週案エディタ」を、**現在の機能を一切変えずに**最適化する。
重視点: 保守性・可読性 / 堅牢性・エラー耐性。範囲: フロント含む全面。
作業ブランチ: `claude/stoic-clarke-5ekDi`（PR #36）。

## 重要な制約・環境の注意
- このGASコードは当環境では**実行・視覚検証できない**（Spreadsheet/Classroom/Gemini API依存）。
  → 変更は「証明可能に等価」なものに限定し、小コミットで積む。
- `.gs`の構文チェックは `cp x.gs /tmp/x.js && node --check /tmp/x.js`（.gsは直接check不可）。
- Bashは**絶対パス**を使う（`cd`はsandbox制限）。
- **このセッション中、Bash出力層が断続的に壊れた**（awk/grepの結果に `...`/`TRUNCATED` 等の
  ハルシネーションが混入）。信頼できたのは **Readツール / md5sum**。
  awk/grepの結果は鵜呑みにせず Read で実体確認すること。Editの厳密一致が最後の安全網。

## 完了済みコミット（push済み・PR #36）— ここまでが確実な成果
1. `0d76619` 教科集約2関数→ルール表駆動 `aggregateSubjects_` に統合 /
   Gemini送信・エラー処理を `callGeminiEndpoint_`(08_Gemini.gs) に一元化 /
   `getMondayStrByWeekNumber` 未使用変数削除 / 誤字修正(00_config.gs「しすステム」)
2. `b0a2095` 6校時の列マッピング手書き展開をループ化（04_AutoFill.gs `batchAutoFillFromWeek`、
   07_WebApp.gs `getWeeklyPlanData`。空配列ブランチは参照共有を避け各校時を独立生成）
3. `0ed00c2` PDFキュー処理のトリガー再スケジュールを `rescheduleQueueTrigger_`(99_Utils.gs) に共通化 /
   行事PDFキュー構築を `buildEventPdfQueue_`(03) に抽出 / Classroom投稿(05)のループ化 /
   **バグ修正**: `importEventsFromFolder_UI` の未定義変数 `ss` 参照を
   `SpreadsheetApp.getActiveSpreadsheet().toast` に修正（メニューからの行事PDF読込が例外で開始不可だった）
4. `b1aac6e` 単元進捗テキスト解析を `parseUnitProgress_`(04_AutoFill.gs) に集約（3関数の重複正規表現）

> 唯一の挙動変化はコミット3のバグ修正（壊れていた経路が直る方向）。他はすべて入出力等価。
> 全ファイル node --check 済み。

## ユーザーに依頼済みのGAS環境での確認項目
時数集計 / AIタスク抽出・学級通信AI生成 / 明日の予定Classroom投稿の文面 /
PDF読込(メニュー&Web) / 単元自動入力

## CSSについての確定事実（App_Css.html, 2711行, md5 78d0a24…）
- `:root` は **3〜22行の1個だけ**（「重複:root」は存在しない。過去のサブエージェント分析および
  本セッション中の一時的な誤報は誤り。実体未確認のまま報告しないこと）。
- **本物の軽微バグ**: `--bg-card` は `:root` に未定義だが、575行 `.link-insert-btn` で
  `background: var(--bg-card);`（フォールバック無し）が使われている。現状この背景宣言は無効。
  → 修正するなら `:root` に `--bg-card: #ffffff;` 追加 か、575行を `var(--bg-card, #fff)` に。
  ただし現状の見た目（透明かも）が変わる可能性があり「見た目不変」を保証できない。
  **ブラウザで確認できる体制で扱うこと。**
- 未検証の指摘（Readで実体確認してから判断）: kbd ルールが662行付近と1494行付近の2箇所、
  `.grid-cell` 関連ルールが413/586/659/2646行付近に分散。重複か役割分担か未確定。
- 視覚検証不能のため、CSSは「証明可能に無害」と確信できる変更のみ。変数化・!important削減・
  色/フォント統合はユーザーがテスト可能な環境で行うべき（1文字で見た目が変わる）。

## Phase 5 着手済み（push済み）
5. `(次コミット)` **散在グローバルの STATE 集約 第1弾**（App_Js.html）。
   遅延ロード制御フラグ／キャッシュ 8個を `STATE` のフィールドへ移動し、全参照を
   `STATE.X` に置換: `timetableLoaded` `vacationDatesLoaded` `stdHoursLoaded`
   `umDataLoaded` `isSystemSettingsLoaded` `geminiModelsCache` `taskDataLoaded` `taskLoading`。
   - 手順: ①`var`宣言削除 → ②全参照を `STATE.X` に一括置換（8識別子は互いに非部分文字列、
     他HTMLからの参照なしを確認）→ ③STATE定義に8フィールド追加（置換後に追加し二重前置を回避）。
   - 検証: 裸の参照はSTATE定義8行のみ／残存`var`宣言ゼロ／`node --check` OK（6068行）。
   - **等価性**: 各読み書きが同名 `STATE.X` になり初期値も一致。STATEは先頭`const`で全関数から
     到達可能、使用は全て onload 以降のため初期化順も問題なし＝入出力等価。

6. `(次コミット)` **散在グローバルの STATE 集約 第2弾**（App_Js.html）。
   作業データ／編集状態 7個を `STATE` へ移動・全参照を `STATE.X` 化:
   `pickerApiLoaded` `currentPickerType` `stdHoursData` `allTaskData`
   `aiPreviewTasks` `umAllRows` `umEditingRowIndex`。
   - 第1弾と同手順（宣言削除→一括置換→STATE定義追加）。7識別子は互いに非部分文字列、
     他HTML参照なしを確認。検証: 裸の参照はSTATE定義7行のみ／残存宣言ゼロ／`node --check` OK。
   - 注意点: `STATE.tasks = allTaskData`（同一配列の別名同期）は前置後も保たれ等価。
     ※`allTaskData` と `STATE.tasks` は重複気味だが、統合は挙動分析を要するため今回は前置のみで温存。

7. `(次コミット)` **共通失敗ハンドラ `_onCommError` の抽出**（App_Js.html）。
   本体が完全に `showToast('error', '通信エラー: ' + e.message);` の1文のみの
   `withFailureHandler` を20箇所、共通関数に置換（1行版8＋複数行版12）。
   - **`_serverCall` 全ラッパー化は中止**: 呼出57箇所はハンドラが多行インライン＋入れ子＋
     メソッド名が末尾にあり、テスト不能環境での全構造反転はリスク過大と判断（ユーザー合意済み）。
     代わりに「構造を反転させない」失敗ハンドラ重複抽出のみ実施。
   - 安全性: 完全一致 replace_all のため、固有処理付き（ボタン再有効化/`console.error`/
     `resolve(false)`/`loadTasks()`等）の12箇所は自動的に非一致で温存。インライン→
     スコープ捕捉のない同一本体の名前付き関数＝完全等価。`node --check` OK。

## 残作業（未着手）
### Phase 5 続き: フロント App_Js.html（6069行、要GAS検証）
- モジュールレベルの可変グローバルは STATE に集約済み
  （残る `^    var/let` は設定定数 `NW_*`/`SUBJECT_HIRAGANA_MAP`/`DAY_NAMES`、
   ライブラリ singleton `SwalToast`、モジュール `NW` のみ＝集約不要）。
- 失敗ハンドラの定型（通信エラー）は `_onCommError` に集約済み。
- 次の候補（いずれも要GAS検証・要慎重。構造反転を伴う変換は避ける方針）:
  - ボタン無効化/再有効化の重複 → `_withButtonState(btn, asyncFn)`（要・各ボタンの文言保持）
  - 巨大関数の分割: `printWeeklyPlanExec()`(約434行), `renderWeekGrid()`
  - `allTaskData`/`STATE.tasks` の重複解消（挙動確認後）
  - `_onCommError` 以外の準定型失敗ハンドラ（'エラー: '/'通信エラー'+復旧処理付き）の整理は
    挙動が絡むため要慎重
- `google.script.run` 呼び出し約57箇所 → `_serverCall(fn, handlers)` ラッパー化
- ボタン無効化/再有効化の重複 → `_withButtonState(btn, asyncFn)`
- 巨大関数の分割: `printWeeklyPlanExec()`(約434行), `renderWeekGrid()`
- タスク描画の共通化（一覧 / サイドバー）
- `linkify()`/`escHtml()` の堅牢性 — 挙動が変わりうるので要テスト・慎重に
- 学級通信 `NW` モジュール(約1600行)は既にオブジェクト化済み

### Phase 6: CSS（残り）— 上記の制約に従い慎重に

## 次の一手の推奨
ユーザーがGAS環境でPhase1〜4の動作確認をできてから、App_Js.html の
グローバル変数 `STATE` 統合（最も安全で効果大）を小コミットで開始する。
Bash出力が不安定なため、編集対象は必ず Read で実体確認してから Edit すること。
