# C6: 審査差し戻し（2026-08）への回答

> **この文書でやること**：Google の Third-Party Data Safety Team から届いた差し戻しメールに、
> 何をどう直して返信するかをまとめます。**返信は 1 通で全項目に答える**のが原則です。
> **前提**：[C4](C4_GOOGLE_VERIFICATION.md) で申請済み／[C5](C5_DEMO_VIDEO_SCRIPT.md) の動画を提出済み

---

## 0. 差し戻しの内訳と対応状況

Google が指摘したのは、独立した **4 件**です。1 件でも欠けると審査は再開しません。

| # | Google の指摘 | 対応 | 状態 |
|---|---------------|------|:---:|
| 1 | デモ動画が、次の 4 スコープの**機能の全体像**を示していない<br>`script.send_mail` / `spreadsheets` / `script.external_request` / `script.scriptapp`<br>書き込み・削除は**利用者のアカウント側への反映**まで映すこと | [C5](C5_DEMO_VIDEO_SCRIPT.md) の台本を改訂（シーン4・5・7 を拡張、シーン7-2 を新設）。<br>`script.scriptapp` の反映を見せるため、アプリに**「自動実行（トリガー）の状況」画面を新設** | 台本✅／**撮影は未** |
| 2 | AI／ML 連携の申告と Limited Use 対応 | プライバシーポリシー §4 に AI 提供者・ティア・送信データを明記。<br>§5 に**英文の Limited Use 宣言**を掲載。<br>アプリの設定画面と初期設定ウィザードに**有料ティア必須**の明示を追加 | ✅ |
| 3 | プライバシーポリシーに、機微なデータの**保護措置**の記載がない | §7 を「安全管理措置（機微なデータの保護）」として全面的に書き直し、11 項目の具体策を表で明記 | ✅ |
| 4 | `spreadsheets` は `drive.file` で足りるのではないか（最小スコープ） | **Option 1（移行）を実施済み。**Sheets REST API v4 + `drive.file` へ移行し、`appsscript.json` から `spreadsheets` を削除（[B5](B5_SHEETS_SCOPE_AUDIT.md)） | コード✅／**実機確認とConsole側の削除は未** |

---

## 1. 指摘1：デモ動画の撮り直し

### Google が求めていること

> In-App Functionality: Demonstrate the **full operational functionality** of every requested scope.
> Source Account Impact: For **write or delete** permissions, show the changes triggered in the app
> **reflected in the user's Google account**.

つまり「そのスコープを使う画面が1回映っている」では足りず、
**できることの全体**と、**その結果がアカウント側に現れるところ**まで求められています。

### 4 スコープごとの、映すべき「全体像」と「アカウント側の反映」

| スコープ | 実演する機能の全体 | アカウント側で見せるもの |
|----------|--------------------|--------------------------|
| `spreadsheets` | 週案の入力（書き込み）／時数集計（読み取り）／タスクの追加・削除 | **スプレッドシート本体**を開き、週案シート・タスクシート・ごみ箱シートで増減を確認 |
| `script.send_mail` | リマインダーの有効化・時刻設定・テスト送信 | **Gmail の受信トレイ**で実物を開き、宛先（To）＝ログイン中の本人であることを確認 |
| `script.external_request` | Gemini による生成／Drive REST API の呼び出し／祝日 CSV の取得（送信先の全列挙） | 生成結果の挿入、設定画面の**有料ティア必須の注意書き** |
| `script.scriptapp` | リマインダーの時限トリガー作成／バックグラウンド処理用トリガー／解除 | 設定タブの**「自動実行（トリガー）の状況」**で、登録された行が増え、解除で消えることを確認 |

### そのために入れたコード変更

`script.scriptapp` だけは、これまで**アカウント側の反映を映す手段がありませんでした**
（Web アプリの利用者はスクリプトのトリガー画面を開けないため）。そこで:

- `07_WebApp.gs`：`getMyTriggersForWebApp()` / `deleteMyTriggerForWebApp()` を追加
  （`ScriptApp.getProjectTriggers()` は実行中の利用者本人のトリガーだけを返します）
- `App.html` / `App_Js_10_Settings.html`：設定タブに「自動実行（トリガー）の状況」カードを追加

審査対応であると同時に、「自分のアカウントに何が登録されたのか分からない」状態を解消する
**透明性の機能**でもあります。

### 撮影の手順

```bash
npm run demo:verify   # 台本のセレクタ・スコープ網羅・尺を事前チェック
npm run demo:dry      # 段取りの確認
npm run demo:record   # 撮影
```

詳細な台本と提出前チェックリストは [C5](C5_DEMO_VIDEO_SCRIPT.md) にあります。
**撮影前に承認を取り消す**（<https://myaccount.google.com/permissions>）のを忘れないでください。

---

## 2. 指摘2：AI／ML 連携の申告と Limited Use

### 事実関係（返信で申告する内容）

| 質問されたこと | 本アプリの答え |
|----------------|----------------|
| 第三者 AI 提供者の一覧とプラン | **なし。**連携する生成AI は Google 自身の Gemini API（Google AI for Developers）1 つだけ |
| アグリゲータ・ゲートウェイ・モデルハブ | **なし。**Gemini API のエンドポイントを直接呼びます |
| 自己ホスト／オフラインモデル | **なし** |
| 学習を止める設定 | **有料ティア（課金を有効にした）API キーの利用を必須**にしています |

### なぜ「有料ティア必須」が要点なのか

Gemini API の**無料ティアでは、送信内容が Google のモデル改善（機械学習）に利用される場合があります**。
本アプリは週案の記述（児童生徒に関する記述を含み得る）や PDF を送るため、無料ティアのままでは
Workspace API の Limited Use 要件と両立しません。API キーは利用者が用意する方式なので、
**アプリ側では「有料ティアを使うこと」を明示して運用**します。

### 入れた変更

- `docs/privacy-policy.html` §4：AI 提供者・ティア・送信するデータ／しないデータを表で明記
- `docs/privacy-policy.html` §5：**英文の Limited Use compliance statement** を掲載（審査担当が読む箇所）
- `App.html`（設定タブ）：Gemini API 設定に**有料ティア必須の注意書き**を常時表示
- `App_Js_13_SystemTools.html`（初期設定ウィザード）：「無料で取得できます」という案内を、
  有料ティアを促す文面へ修正

---

## 3. 指摘3：プライバシーポリシーの保護措置

§7 を「**安全管理措置（機微なデータの保護）**」として書き直しました。

1. まず**何を機微として扱うか**を定義（週案の記述・Classroom のクラス情報・メールアドレス・API キー・OAuth トークン）
2. そのうえで **11 項目**の具体策を表で明記
   （保存場所の限定／通信の暗号化／保存時の暗号化／利用者ごとの分離／認証情報の扱い／
   OAuth トークンの扱い／最小権限／第三者提供の否定／保持期間／削除と権限取り消し／
   脆弱性対応／インシデント時の対応）

> 📌 返信では「§7 を追加した」ではなく、**URL とアンカー**（`privacy-policy.html#s7`）を示してください。

---

## 4. 指摘4：`spreadsheets` を `drive.file` にできるか　★移行済み★

> 📋 **全数の棚卸しと移行結果 → [B5: `spreadsheets` → `drive.file` 化 可否レポート](B5_SHEETS_SCOPE_AUDIT.md)**
> 使っている Sheet / Range の API はすべて Sheets REST API v4 に対応があり、
> 「実現できない」項目はありませんでした。**Option 1（移行）を採り、実施済みです。**
> `appsscript.json` から `spreadsheets` は外れています（**Cloud Console 側の削除は人手で必要**）。

### Google の提案

> Based on the information you provided, we believe the **drive.file** scope may be a better fit.

そして Google は釘を刺しています。

> **UI preferences or client library limitations alone are not valid policy exceptions.**

### 技術的な事実

- **Sheets API v4 は `drive.file` を受け付けます。**
  `spreadsheets.get` / `values.update` / `batchUpdate` などの認可スコープには
  `drive`・`drive.file`・`spreadsheets` が並んでいます。
- 一方、**Apps Script 組み込みの `SpreadsheetApp` は `spreadsheets` スコープを要求します。**
  これは Drive で経験した「`DriveApp` はフル `drive` を要求する」問題（[B1](B1_DRIVE_SCOPE_AUDIT.md)）と同じ構図で、
  解決策も同じ、**REST API を `UrlFetchApp` + `ScriptApp.getOAuthToken()` で直接呼ぶ**ことです。
- 本アプリのデータベースは**アプリ自身が作成するスプレッドシート**なので、`drive.file` の適用範囲に入ります。
  既存利用者の DB は、Google ピッカーで一度選び直せば per-file 権限が付きます（ピッカーの実装は既にあります）。

**したがって「`drive.file` では実現できない」とは言えません。**
`SpreadsheetApp` が使えなくなるという理由は、Google が明示的に否定した
「client library limitations」に該当し、Option 2 の正当化としては通らない可能性が高いです。

### 選択肢と判断

| | 内容 | 返信文 | 判断 |
|---|------|--------|------|
| **Option 1** | `spreadsheets` を外し、Sheets REST API v4 + `drive.file` へ移行 | "Confirming narrower scopes" | **採用** |
| Option 2 | `spreadsheets` の維持を主張 | "Unable to use narrower scopes" + 理由 | 見送り。正当化の根拠が `SpreadsheetApp` の制約しかなく、Google が明示的に否定した client library limitation にあたるため |

### 何をしたか（[B5](B5_SHEETS_SCOPE_AUDIT.md) §5 に詳細）

呼び出しは 22 ファイル・約 470 箇所に散っていたため、**呼び出し側は書き換えず、
`SpreadsheetApp` 互換のファサードを REST で作りました**（`17_DriveApi.gs` と同じ設計）。

- `18_SheetsApi.gs` … Sheets REST API v4 のファサード。`getSs_()` がこれを返します。
- コンテナバインド専用の遺物（`onOpen`・カスタムメニュー・`_UI` 系・`onEdit`・`toast`）を削除。
- シート保護は `protectWholeSheet()` に集約（`batchUpdate` 1 回で付け替え）。
- `flush()` は REST では不要なので 13 箇所とも削除。
- 既存 DB のために、**Google ピッカーで選び直す導線**を追加（`drive.file` は per-file 権限のため）。
- `tests/drive-scope.test.mjs` が `SpreadsheetApp` と `spreadsheets` の復活を弾き、
  `tests/sheets-api.test.mjs` が偽の Sheets API に対してファサードの挙動を固定。

> ⚠️ Google は「**今の時点で承認済みスコープを外すな**」と書いています。
> `spreadsheets` は未承認だったので外して問題ありませんが、
> **"Confirming narrower scopes" と返信するのは、実機で動作を確認してから**にしてください。

---

## 5. 返信メールのドラフト（英語）

> 📌 送る前に、`{{ }}` を実際の値に置き換えてください。
> 指摘4 は Option 1（移行済み）で確定しているので、下の本文はその前提で書いてあります。

```text
Subject: Re: [OAuth Verification] School Plan Note — updated demo video and policy

Hello,

Thank you for the detailed review. We have addressed every point below.

--------------------------------------------------------------------
1) New demonstration video
--------------------------------------------------------------------
New video (unlisted): {{YOUTUBE_URL}}

The video now demonstrates the full operational functionality of every
requested scope, and for every write or delete operation it also shows the
resulting change inside the user's own Google account:

- drive.file ({{TIMESTAMP}}): entering a weekly lesson plan (write), the
  annual lesson-hour summary calculated from the same file (read), and
  adding and deleting a task (write/delete). We then open the teacher's own
  spreadsheet and show the new cell, the added row, and the deleted row that
  was moved to the recycle-bin sheet inside the same file. The same scope
  covers the PDFs the app exports, shown later in the video. The app can
  reach only the files it created or the teacher picked.
- script.send_mail ({{TIMESTAMP}}): enabling the daily task reminder,
  choosing the delivery time, and sending a test message. We then open the
  signed-in teacher's Gmail inbox and show the delivered message and its
  To: field, which is the signed-in account itself. The app has no other
  recipients and cannot read mail.
- script.external_request ({{TIMESTAMP}}): generating a class newsletter
  with the Gemini API. We enumerate every outbound request the app makes:
  the Gemini API, the Google Drive REST API v3 (we call Drive over REST so
  that drive.file is sufficient), and a public holiday CSV published by the
  Japanese Cabinet Office. No other host is contacted.
- script.scriptapp ({{TIMESTAMP}}): the app creates time-based triggers for
  the daily reminder and for background PDF parsing. We added an in-app
  panel, "Scheduled automation", that lists every trigger the app has created
  in the signed-in user's account. The video shows the reminder trigger
  appearing in that list after it is enabled, and disappearing from the list
  after the user deletes it, so the effect on the source account is visible.

Our application is not an integration platform; each scope maps to one
teacher-facing feature, as shown above.

--------------------------------------------------------------------
2) AI / ML integrations
--------------------------------------------------------------------
- Third-party AI providers: none. The only AI service the application
  integrates with is Google's own Gemini API (Google AI for Developers).
- Aggregators, gateways, or model hubs: none. We call the Gemini API
  endpoint directly from Google Apps Script.
- Self-hosted or offline models: none.
- Plan / tier: each teacher supplies their own API key. Our application
  requires a paid-tier key (a key from a project with billing enabled),
  because free-tier content may be used by Google to improve its models.
  This requirement is stated in the app itself (in the Gemini settings card
  and in the first-run setup wizard) and in our privacy policy.

We do not use, transfer, or sell any raw, aggregated, anonymized, or derived
Google Workspace API user data to develop, train, or improve foundational or
generalized AI/ML models, and we do not transfer such data to any service
that would do so.

The Limited Use compliance statement is published here:
{{PRIVACY_URL}}#s5

--------------------------------------------------------------------
3) Privacy policy — protection of sensitive data
--------------------------------------------------------------------
We rewrote the security section of our privacy policy so that it states the
specific protections applied to sensitive data:

{{PRIVACY_URL}}#s7

It first defines what we treat as sensitive (lesson plan text that may refer
to pupils, Classroom course information, the signed-in user's email address,
the user's Gemini API key, and OAuth tokens), and then lists the concrete
measures: data is stored only inside the user's own Google account and never
on any server of ours; TLS for all traffic; Google's default encryption at
rest; per-user isolation because the web app executes as the accessing user;
API keys kept in per-user Apps Script properties, masked in the UI and never
logged; OAuth tokens never persisted; least-privilege scopes enforced by an
automated test in our repository; retention limits with automatic deletion;
user-controlled deletion and revocation; and our vulnerability reporting and
incident handling process.

The scope descriptions in section 2 of the same policy match the scopes
configured in the Cloud Console exactly.

--------------------------------------------------------------------
4) Minimum scope — spreadsheets
--------------------------------------------------------------------
Confirming narrower scopes.

We have removed https://www.googleapis.com/auth/spreadsheets from both our
codebase and our Cloud Console configuration. The application now reads and
writes its database spreadsheet through the Sheets API v4 using only the
drive.file scope. The database is a spreadsheet the application creates
itself on first run, so it falls within drive.file; teachers who already had
one select it once through the Google Picker, which grants per-file access.

This mirrors what we had already done for Drive: we call the Drive REST API
v3 directly instead of the built-in DriveApp service, precisely so that
drive.file is sufficient. We have now applied the same approach to Sheets,
because the built-in SpreadsheetApp service is what required the broader
scope. Our repository has automated tests that fail the build if either
built-in service, or the spreadsheets scope, is reintroduced.

The consent screen now shows seven scopes, and the new demonstration video
was recorded against that configuration.

--------------------------------------------------------------------
5) Test credentials and navigation
--------------------------------------------------------------------
The application has no local login and no paywall: the only authentication
is Google Sign-In, and any Google account can use it. There is no phone
verification, no credit card, and no invitation step. A reviewer can use
their own test account:

1. Open {{APP_URL}} and sign in with any Google account.
2. Approve the OAuth consent screen.
3. On first run the app creates a spreadsheet named
   "{{DB_NAME}}" in that account's Drive; this is the only file it uses.
4. "Weekly plan" tab: double-click any cell to enter a lesson (drive.file,
   write). "Hours" tab: the summary is read back from the same file.
5. "Tasks" tab: add a task, then delete it (drive.file, write/delete).
   At the bottom of the same tab, enable "Reminder" and press "Send a test
   message now" (script.send_mail, script.scriptapp).
6. "Settings" tab: "Scheduled automation" lists the triggers created in the
   account and lets you delete them (script.scriptapp).
7. "Newsletter" tab: the AI draft button calls the Gemini API
   (script.external_request). This step needs a Gemini API key entered in
   Settings; if you prefer, we can supply a key for the review — please let
   us know and we will send it through a channel you specify.
8. "Settings" tab, Google Classroom section: choose one of your own courses
   and post (classroom.courses.readonly, classroom.announcements).

Publishing status remains "In production".

Please let us know if anything else is needed.

Best regards,
GIGAyama
{{CONTACT_EMAIL}}
```

---

## 6. Cloud Console 側でやること

- [ ] OAuth 同意画面の**プライバシーポリシー URL** が `privacy-policy.html` を指している
- [ ] 登録スコープと `appsscript.json` の `oauthScopes` が一致している
- [ ] **`spreadsheets` を登録スコープから外す**（リポジトリ側は削除済み。Console 側は人手）
- [ ] 公開ステータスは **In production** のまま（テストに戻さない）
- [ ] 変更を保存して送信し、そのうえで**メールに直接返信**する

---

## 7. 送信前チェック ✅

- [ ] 新しい動画を YouTube に**限定公開**でアップし、シークレットウィンドウで再生確認した
- [ ] 動画に、4 スコープすべての「全体像」と「アカウント側の反映」が映っている
- [ ] `npm run demo:verify` が問題なしで通った
- [ ] プライバシーポリシーを公開し、`#s5` と `#s7` のアンカーが実際に飛ぶことを確認した
- [ ] `drive.file` だけで週案が動くことを**実機で確認した**（[B5](B5_SHEETS_SCOPE_AUDIT.md) §6 のチェックリスト）
- [ ] 返信は**元のメールへの直接返信**（新規メールにしない）

---

## 次にやること
- 承認されたら [C4](C4_GOOGLE_VERIFICATION.md) の「申請したあと」に戻り、記録を残します。
