# C5: OAuth 審査用 デモ動画の撮影台本

> **この手順でやること**：Google の OAuth 審査（C4）に提出する**デモ動画**を撮影します。
> この文書は「そのまま読み上げて撮れば審査要件を満たす」ことを目指した台本です。
> **かかる時間の目安**：準備30分／撮影・録り直し込みで60〜90分／YouTube 公開10分
> **前提**：C1〜C3 が終わり、標準 GCP プロジェクトに紐づいた Web アプリがデプロイ済みであること

> 🤖 **この台本は自動で流せます。** [`tools/demo-video/`](../tools/demo-video/README.md) に、
> 本台本どおりにブラウザを操作して録画し、実測タイミングの英語字幕（`.srt`）まで書き出す
> スクリプトがあります。Google のログイン・同意画面・Gmail・Classroom だけは
> 自動化せず一時停止するので、そこだけ手で操作します。
>
> ```bash
> npm run demo:verify   # 撮影前チェック（Google に一切アクセスしません）
> npm run demo:dry      # 段取りの確認
> npm run demo:record   # 撮影
> ```

---

> ⚠️ **2026-08 の差し戻しを受けて改訂しました。**
> Google からは「**スコープごとに、機能の全体像（maximum extent）を実演すること**」と
> 「**書き込み・削除の権限は、変更が利用者の Google アカウント側に反映されるところまで映すこと**」を求められています。
> 対応の全体像は [C6: 審査差し戻しへの回答](C6_VERIFICATION_RESPONSE.md) にまとめてあります。

---

## 0. まず結論：この動画で証明すべきこと

審査担当者は動画だけを見て「このアプリは、申請したスコープを、申請どおりの目的で使っているか」を判断します。
必要なのは次の 2 つです。

1. **要求スコープ 1 つにつき、それを使っている機能を「できることの全体」まで実演する**
   （1 画面だけ映して終わりにしない。読み取り・書き込み・削除がある機能はすべて見せる）
2. **書き込み・削除については、その結果が利用者の Google アカウント側に現れるところまで映す**
   （例：メールなら Gmail の受信トレイ、シートなら実際のスプレッドシート、トリガーならアプリ内の自動実行一覧）

本アプリの要求スコープと、動画で対応させるシーンは次のとおりです。

| # | スコープ | 種別 | 動画で証明するシーン |
|---|----------|------|----------------------|
| 1 | `userinfo.email` | sensitive | シーン7（リマインダーがログイン中の本人宛に届く）／シーン3（「設定」タブの「使用中のデータベース」に表示されるログイン中アカウント） |
| 2 | `drive.file` | sensitive | シーン4（週案データベースの読み書き＝入力・時数集計・タスクの追加と削除、**すべてスプレッドシート側で確認**）／シーン6（学級通信の PDF 出力） |
| 3 | `script.send_mail` | sensitive | シーン7（「今すぐテスト送信」→ **Gmail の受信トレイで実物と宛先を確認**） |
| 4 | `classroom.courses.readonly` | sensitive | シーン8前半（クラス一覧の読み込み） |
| 5 | `classroom.announcements` | sensitive | シーン8後半（Classroom へ投稿 → Classroom 側のストリームで確認） |
| 6 | `script.external_request` | 非 sensitive | シーン5（Gemini 生成＋**送信先の全列挙**：Gemini API／Drive REST API／Sheets REST API／内閣府の祝日 CSV） |
| 7 | `script.scriptapp` | 非 sensitive | シーン7-2（設定タブ「自動実行（トリガー）の状況」で**登録と解除がアカウントに反映される**ところ） |

> 💡 **`spreadsheets` は要求しなくなりました。** 週案データベースはアプリ自身が作るスプレッドシートなので、
> Sheets REST API v4 を `drive.file` で呼べば足ります（[B5](B5_SHEETS_SCOPE_AUDIT.md)）。
> 動画でもこの点を明言してください。差し戻しの4件目への回答そのものになります。

> ⚠️ **6・7 は sensitive ではありませんが、2026-08 の差し戻しで名指しされました。**
> 「同意画面に出るから十分」ではなく、**専用のシーンで実演**してください（シーン5・シーン7-2）。
> **どのシーンも 1 つでも欠けると差し戻しの原因**になります。

---

## 1. Google が動画に求める形式要件（チェックリスト）

撮影前にこの 10 項目を確認してください。差し戻しの大半はここです。

- [ ] **YouTube に「限定公開（Unlisted）」でアップロードする**。「非公開（Private）」だと審査担当が見られず、その時点で差し戻しになります。
- [ ] **言語は英語**。日本語で操作する画面を撮るのは問題ありませんが、**ナレーションか字幕のどちらかは英語**にします（本台本は英語字幕テキストを用意しています）。
- [ ] **同意画面（OAuth consent screen）の言語設定を English にする**。同意画面の左下に言語切替があります。
- [ ] **録画は「ウィンドウ」ではなく「ディスプレイ全体」を対象にすること**。同意画面は**別ウィンドウのポップアップ**で開くため、ウィンドウ単位の録画ではこの最重要シーンがまるごと欠落します（実際にこれで1本撮り直しになっています）。
- [ ] **同意画面を表示しているとき、ブラウザのアドレスバーが映っていること**。URL に含まれる `client_id=...` が読み取れる必要があります。ウィンドウは最大化し、URL が省略表示されないようにしてください。
- [ ] **アドレスバーの `client_id` が、審査申請に使う OAuth クライアント ID と一致していること**。テスト用に別クライアントで撮ると差し戻されます。
- [ ] **同意画面に表示されるスコープが、申請するスコープと完全に一致していること**。
- [ ] **同意画面に表示されるアプリ名が、申請するアプリ名・動画内のアプリ名と一致していること**。
- [ ] **OAuth の同意フローは、カットせず一続きで撮ること**。ログイン → アカウント選択 → スコープ同意 → アプリ画面までを途切れさせません。
- [ ] **本番デプロイ済みのアプリで撮ること**。ローカルのモックや開発版では認められません。
- [ ] **解像度は 1080p 以上**。同意画面の文字と URL が読めることが必須条件です。

---

## 2. 撮影前の準備

### 2-1. アカウントの承認をいったん取り消す（最重要）

一度アプリを承認済みのアカウントでは、**同意画面がもう出ません**。撮影前に必ず取り消します。

1. https://myaccount.google.com/permissions を開く
2. 一覧からこのアプリ（同意画面で設定したアプリ名）を選ぶ
3. 「アクセス権を削除」をクリック

> 💡 撮り直すたびにこの操作が必要です。シーン3だけ撮り直す場合も毎回行ってください。

### 2-1-2. アプリ名の表記をそろえる

**同意画面のアプリ名と、動画に映るアプリ名が違うと差し戻されます。** 現状はこうなっています。

| どこ | 表記 |
|---|---|
| アプリ画面のヘッダー（`App.html`） | 週案エディタ |
| 紹介ページ（`docs/about.html`） | 週案エディタ（School Plan Note） |

シーン1で紹介ページ、シーン3以降でアプリ画面が映るので、**両方の表記を含む名前**
（例：`週案エディタ（School Plan Note）`）を OAuth 同意画面のアプリ名に登録しておくのが安全です。
`npm run demo:verify` を実行すると、この表記ゆれを毎回確認できます。

### 2-2. デモ用データを用意する（個人情報を映さない）

動画は Google の審査担当が視聴します。**実在する児童・保護者・教職員の情報は絶対に映さない**でください。

- [ ] 撮影用に**ダミーの学級**（例：`3年1組`／児童名はすべて架空）を作る
- [ ] 週案・学級通信のデモ内容は架空のものにする
- [ ] Classroom も**撮影用のテストクラス**を作り、実クラスには投稿しない
- [ ] ブラウザのブックマークバー、他タブのタイトル、通知ポップアップを隠す（**新しいプロフィール／シークレットウィンドウ**での撮影を推奨。ただしシークレットでは拡張機能が無効になる点に注意）
- [ ] メールの受信箱を映すシーンでは、**他のメールが映らないよう検索で絞り込んでおく**

### 2-3. 画面と録画の設定

- [ ] ブラウザの表示倍率を **100〜125%**（文字が小さすぎると差し戻し）
- [ ] ウィンドウは最大化。アドレスバーを常時表示
- [ ] 同意画面の言語を English に切り替える（画面左下）
- [ ] 録画ツール（macOS: QuickTime／Windows: Xbox Game Bar／どちらも OBS 可）を 1080p 以上に設定
- [ ] マイクを使わない場合は無音で録り、**編集で英語字幕を載せる**方針にする

---

## 3. 撮影台本

**想定尺：9〜10分。**（2026-08 の差し戻しを受け、網羅性を優先して長くしています。`npm run demo:verify` が実測見積もりを出します） 各シーンの「English caption」は、そのまま字幕として画面下部に載せる想定の英文です。
ナレーションする場合も同じ文を読み上げれば要件を満たします。

---

### シーン1：アプリの紹介（約30秒）

**映すもの**：紹介ページ（`https://schoolplan-editor.giga-school.com/about.html`）、続けてプライバシーポリシーと利用規約のページ。

**操作**：
1. 紹介ページを開き、アプリ名がはっきり見える状態で数秒静止する
2. プライバシーポリシーのリンクをクリックし、ページ冒頭を数秒表示
3. 利用規約も同様に表示

**English caption**：
> This is School Plan Note, a web application for elementary school teachers in Japan.
> Teachers use it to write their weekly lesson plans, manage classroom tasks, and share class newsletters.
> This is our homepage, our privacy policy, and our terms of service — the same URLs submitted in this verification request.

> ⚠️ ここで映すアプリ名・URL は、OAuth 同意画面（C2）に登録したものと**一字一句同じ**にしてください。

---

### シーン2：教員本人のスプレッドシート（約30秒）

**映すもの**：教員本人の Google スプレッドシート（週案データベース）。

**操作**：
1. スプレッドシートを開く（ダミーデータのもの）
2. 週案データが入っていることが分かる状態で数秒静止する
3. Web アプリの URL（`https://script.google.com/macros/s/…/exec`）を開く

**English caption**：
> Each teacher owns a single Google Spreadsheet that stores their own lesson plan data.
> The application is a standalone web app. It reads and writes only this one spreadsheet, which the teacher selects.
> Opening the web application starts the OAuth flow.

> 📌 **カスタムメニュー「週案ツール」は映しません。** 配布形態はスタンドアロン（[D1](D1_STANDALONE_DEPLOY.md)）で、
> `onOpen()` はコンテナバインド型でしか動かないためメニューは存在しません。
> これに伴い `script.container.ui` スコープは要求していません（`appsscript.json`）。

---

### シーン3：OAuth 同意画面（約1分）★最重要★

**映すもの**：Google のログイン → アカウント選択 → **同意画面（全スコープが見える状態）** → アプリ初期画面。

**操作**：
1. **ここからシーン終わりまでカットしない**
2. アカウント選択画面でデモ用アカウントを選ぶ
3. 同意画面が出たら、**アドレスバーを一度はっきり映す**（3秒以上静止）
4. スコープ一覧を**ゆっくりスクロール**し、全項目が読めるようにする（早送り禁止）
5. 「続行 / Continue」を押し、アプリの週案画面が表示されるまで撮り続ける

**English caption**（同意画面が出ている間に順に表示）：
> This is the OAuth consent screen for our application.
> The address bar shows the client ID of the OAuth client submitted for verification.
> The application requests the following scopes: per-file Drive access, Classroom courses read-only, Classroom announcements, sending email on the user's behalf, and the user's email address.
> Each of these scopes is demonstrated in the following sections of this video.

> ⚠️ **チェック**：
> - アドレスバーの `client_id=` が読めるか（撮影後に一時停止して必ず確認）
> - 同意画面が English になっているか
> - 表示スコープ数が `appsscript.json` の `oauthScopes`（7個）と対応しているか

---

### シーン4：データベースの読み書き＝`drive.file`（約1分45秒）★書き込み・削除の反映を見せる★

**映すもの**：週案の入力（書き込み）→ 時数集計（読み取り）→ タスクの追加と削除（書き込み・削除）→ **スプレッドシート本体での確認**。

> 📌 このシーンは「セルに1つ入力して終わり」では**足りません**。
> 2026-08 の差し戻しでは、当時要求していた `spreadsheets` が名指しされ、「機能の全体像を見せること」と
> 「変更が Google アカウント側に反映されるところまで見せること」を求められています。
> その後 `spreadsheets` は外し、**このデータベースも `drive.file` だけで読み書き**するようになりました。
> 動画では「アプリが作ったファイルだから `drive.file` で足りる」と明言してください。

**操作**：
1. 「週案」タブでセルをダブルクリックして編集し、教科・単元・学習活動を入力（**書き込み**）
2. 保存されたことが分かる表示（トースト等）を映す
3. 「時数」タブを開き、集計が表示されるところを映す（**読み取り**：同じシートから計算している）
4. 「タスク」タブでタスクを1件追加して保存（**書き込み**）
5. 続けてそのタスクを削除（**削除**：行はごみ箱シートへ移る）
6. **スプレッドシート本体を開き、次の3つを順に見せる**（ここが決定打）
   - 週案シート … 手順1で入力したセルが入っている
   - タスクシート … 追加した行と、削除で減った行
   - ごみ箱シート … 削除した行がここへ移っている

**English caption**：
> Teachers enter their weekly lesson plan in this grid.
> The data is written to the teacher's own spreadsheet, shown here.
> The same file is read back through the same scope: this annual lesson-hour summary is calculated from the rows stored in it.
> Creating and deleting a task writes to, and removes rows from, the same spreadsheet. Deleted rows are moved to a recycle-bin sheet inside the same file.
> Here is the teacher's spreadsheet in their own Google account, showing exactly the changes made in the app a moment ago.
> We hold no `spreadsheets` scope. This file is read and written through the `drive.file` scope, because the app created it.
> We cannot open any other spreadsheet.

> 💡 シーン2で「このスプレッドシートは**アプリ自身が初回に作る**」と述べておくのが効きます。
> 「だから `drive.file` で足りる」という結論に自然につながります。

---

### シーン5：AI 支援と外部通信の全体＝`script.external_request`（約1分15秒）

**映すもの**：「学級通信」タブで Gemini による本文生成。

**操作**：
1. 「学級通信」タブを開く
2. AI 生成ボタンを押し、生成された文章が挿入されるまで映す

**追加の操作**：
3. 「設定」タブを開き、**Gemini API 設定の注意書き（有料ティア必須）**を映す
4. 外部通信の送信先が次の3つだけであることを字幕で明示する
   - Gemini API（AI 機能）
   - Google Drive REST API / Google Sheets REST API（アプリが作った・利用者が選んだファイルの操作。
     `DriveApp` と `SpreadsheetApp` を使わず `drive.file` だけで動かすため）
   - 内閣府「国民の祝日」CSV（公開データの取得のみ。利用者データは送らない）

**English caption**：
> The app calls the Gemini API to draft the class newsletter from the teacher's lesson plan.
> This external HTTPS request requires the `script.external_request` scope.
> The API key is supplied and stored by each teacher in their own Apps Script user properties. We never receive it.
> This is every outbound request the app makes: the Gemini API for the AI features, the Google Drive and Google Sheets REST APIs to handle the files it creates, and a public holiday calendar file published by the Japanese government.
> We require a paid-tier Gemini key, shown in this notice, because free-tier content may be used to improve Google's models — which our Limited Use commitment does not allow.

---

### シーン6：PDF 出力＝`drive.file`（約45秒）

**映すもの**：学級通信の PDF 出力と、生成された PDF が Drive にできる様子。

**操作**：
1. 学級通信の PDF 出力を実行
2. 生成された PDF をプレビュー表示
3. **Drive を開き、アプリが作成したファイルだけがあることを見せる**

**English caption**：
> The newsletter is exported as a PDF file.
> We request the `drive.file` scope, not full Drive access.
> This means the app can only see and manage files it creates itself, such as this PDF — it cannot read any of the teacher's other Drive files.

> 💡 `drive.file` に絞っていることは審査上の強いアピール材料です。**必ず口頭（字幕）で「not full Drive access」と明言**してください。

---

### シーン7：メールリマインダー＝`script.send_mail` + `userinfo.email`（約1分5秒）

**映すもの**：「タスク」タブのリマインダー設定 → テスト送信 → 受信箱。

> 📌 リマインダー設定があるのは **「タスク」タブ**です（「設定」タブではありません）。
> 画面最下部の「リマインダー（毎朝メール通知）」までスクロールします。

**操作**：
1. 「タスク」タブ →「リマインダー（毎朝メール通知）」を開く
2. 「リマインダーを有効にする」をチェックし、送信時刻を選ぶ（＝時限トリガーの作成）
3. 「今すぐテスト送信」をクリック
4. **Gmail に切り替え、届いたリマインダーメールを開いて見せる**
5. 宛先が**ログイン中のアカウント自身**であることを映す

**English caption**：
> Teachers can enable a daily reminder for their unfinished tasks.
> Setting the delivery time creates a time-based trigger, which requires the `script.scriptapp` scope.
> The `script.send_mail` scope is used to send this reminder, and `userinfo.email` is used to identify the signed-in teacher so the reminder is sent to that same teacher only.
> As you can see, the email is delivered to the account that is signed in. We never email anyone else.

> ⚠️ 宛先欄が読める状態で映してください。「本人宛にしか送らない」ことの証明になります。
> Gmail では **受信トレイに届いた状態 → メールを開く → 宛先（To）→ 本文** の順に、それぞれ3秒以上静止します。
> 「送信した」ではなく「**送信先アカウントに届いた**」ところまでが求められています。

**English caption（Gmail を映しているとき）**：
> Here is the message in the signed-in teacher's own Gmail inbox. The To field is that same teacher.
> The app has no recipient list, no other addresses, and cannot read any mail — it only sends this one reminder.

---

### シーン7-2：自動実行の登録と解除＝`script.scriptapp`（約1分）★2026-08 の差し戻しで追加★

**映すもの**：「設定」タブの **「自動実行（トリガー）の状況」** カード。

> 📌 このカードは、`script.scriptapp` で作られたトリガーが
> 「いま自分の Google アカウントに何個登録されているか」を見せ、その場で解除もできる画面です。
> 書き込み系スコープに求められる **source account impact**（アカウント側への反映）を、
> この一覧の増減で示します。

**操作**：
1. 「設定」タブを開き、「自動実行（トリガー）の状況」までスクロールする
2. シーン7で有効化したリマインダーが**一覧に現れている**ことを映す（3秒以上静止）
3. 「解除」を押し、確認ダイアログで解除する
4. **一覧からその行が消える**ところを映す（削除がアカウントに反映された証明）

**English caption**：
> The `script.scriptapp` scope is used to schedule work in the teacher's own account. This panel lists every trigger the app has created there.
> The daily reminder we just enabled now appears here as a scheduled trigger, together with the nightly job that cleans up triggers which are no longer needed.
> Deleting it here removes the trigger from the teacher's account immediately, as the list confirms. Teachers can see and remove every scheduled job the app created.

> 💡 PDF の取り込みを実演した直後にこの画面を開くと、**バックグラウンド処理用の一時トリガー**も一覧に出ます。
> 時間に余裕があれば、その様子（処理が終わると自動で消える）も撮っておくと説得力が上がります。

---

### シーン8：Classroom 連携＝`classroom.courses.readonly` + `classroom.announcements`（約1分25秒）★2つ目の山場★

**映すもの**：「設定」タブの Google Classroom 連携 → クラス一覧の取得 → 投稿 → Classroom 側での確認。

**操作**：
1. 「設定」タブの「Google Classroom」欄を開く
2. クラス一覧を読み込む（**ドロップダウンにクラス名が並ぶところをはっきり映す**）
3. 撮影用テストクラスを選択して保存
4. 「明日の予定を投稿」をクリック（または「学級通信」タブの「Classroom投稿」）
5. 成功メッセージを映す
6. **Google Classroom を開き、ストリームに投稿されたお知らせを見せる**

**English caption**（前半・クラス一覧のとき）：
> The teacher links the app to their own Google Classroom course.
> We use `classroom.courses.readonly` only to list the active courses the teacher already teaches, so they can choose one from this dropdown.
> We do not read student data, rosters, coursework, or grades.

**English caption**（後半・投稿のとき）：
> When the teacher clicks this button, the app posts the schedule to the selected course as an announcement.
> This is what the `classroom.announcements` scope is used for.
> Here is the announcement in Google Classroom. The teacher always initiates the post — the app never posts without an explicit action by the teacher.

> ⚠️ **これが審査で最も見られるシーンです。** 「一覧取得」と「投稿」は必ず**両方**映してください。
> 片方だけだと、もう一方のスコープについて追加質問のメールが来ます。

---

### シーン9：まとめ（約30秒）

**映すもの**：アプリのトップ画面に戻る。

**English caption**：
> To summarize: School Plan Note stores each teacher's lesson plan in their own spreadsheet, exports newsletters as PDF files it creates itself, sends reminders only to the signed-in teacher, and posts announcements to the teacher's own Classroom course when the teacher chooses to.
> All requested scopes are used only for these purposes, as described in our privacy policy.
> Thank you for reviewing our application.

---

## 4. 撮影後：確認と公開

### 4-1. 提出前の最終確認

- [ ] シーン3で**アドレスバーの `client_id` が一時停止して読める**
- [ ] 同意画面が **English** で表示されている
- [ ] 同意画面のアプリ名が申請するアプリ名と一致
- [ ] シーン4〜8で **要求スコープ 7 個すべて**が実演されている（`script.external_request` と `script.scriptapp` も専用シーンで）
- [ ] **書き込み・削除の反映**が、それぞれ Google アカウント側で映っている
      （スプレッドシート本体／Gmail の受信トレイ／Classroom のストリーム／Drive のファイル／自動実行の一覧）
- [ ] 実在の児童・保護者・教職員の氏名、写真、メールアドレスが**一切映っていない**
- [ ] API キー、OAuth トークン、スプレッドシート ID などの秘密情報が映っていない
- [ ] 英語字幕またはナレーションが全編に入っている
- [ ] 1080p 以上で書き出した

### 4-2. YouTube へアップロード

1. YouTube にアップロードし、公開設定を **「限定公開（Unlisted）」** にする
   - **「非公開（Private）」は不可**（審査担当が視聴できません）
2. タイトルはアプリ名を入れる（例：`School Plan Note — OAuth Verification Demo`）
3. **シークレットウィンドウでその URL を開き、ログインなしで再生できることを確認する**
4. C4 の申請フォームに、この URL を貼る

> 📝 **運用メモ**：スコープを追加・変更したら、動画も撮り直しが必要です。
> 撮影日・使用したクライアント ID・動画 URL を記録に残しておくと、再申請時に楽になります。

---

## 5. よくある差し戻し理由と対策

| 差し戻しの理由 | 対策 |
|----------------|------|
| 同意画面の `client_id` が読めない | ウィンドウを最大化し、アドレスバーを 3 秒以上静止して映す |
| 動画が「非公開」で視聴できない | 「限定公開（Unlisted）」に変更する |
| 日本語のみで内容が分からない | 英語字幕を全編に入れる。同意画面も English に切り替える |
| 申請スコープの一部が実演されていない | 本書の「§0 スコープ対応表」で 1〜6 をすべて消し込む |
| 同意画面のアプリ名と動画内のアプリ名が違う | C2 の設定と紹介ページの表記を統一する |
| 「なぜ Classroom の投稿権限が必要か」が伝わらない | シーン8で「教員が明示的にボタンを押したときだけ投稿する」と字幕で明言する |
| Drive 全体にアクセスしていると誤解される | シーン6で「`drive.file`, not full Drive access」と明言する |
| 開発版・ローカル環境で撮影している | 本番デプロイ済み Web アプリで撮り直す |

---

## 次にやること
- 撮影が終わったら **[C4: Google の審査を申し込む](C4_GOOGLE_VERIFICATION.md)** に戻り、動画 URL を添えて申請します。

---
<details>
<summary>もっと詳しく（公式ドキュメント）</summary>

- デモ動画の要件: https://support.google.com/cloud/answer/13804565
- 確認（verification）の要件: https://support.google.com/cloud/answer/13464321
- 審査の申し込み: https://support.google.com/cloud/answer/13461325
- OAuth アプリの確認について: https://support.google.com/cloud/answer/9110914
</details>
