# C5: OAuth 審査用 デモ動画の撮影台本

> **この手順でやること**：Google の OAuth 審査（C4）に提出する**デモ動画**を撮影します。
> この文書は「そのまま読み上げて撮れば審査要件を満たす」ことを目指した台本です。
> **かかる時間の目安**：準備30分／撮影・録り直し込みで90〜120分／YouTube 公開10分
> **前提**：C1〜C3 が終わり、標準 GCP プロジェクトに紐づいた Web アプリがデプロイ済みであること

> 🤖 **この台本は自動で流せます。** [`tools/demo-video/`](../tools/demo-video/README.md) に、
> 本台本どおりにブラウザを操作して録画し、実測タイミングの英語字幕（`.srt`）まで書き出す
> スクリプトがあります。Google のログイン・同意画面・ピッカー・Drive・Gmail・Classroom は
> 自動化せず一時停止するので、そこだけ手で操作します。
>
> ```bash
> npm run demo:verify   # 撮影前チェック（Google に一切アクセスしません）
> npm run demo:dry      # 段取りの確認
> npm run demo:record   # 撮影
> ```
>
> **台本の正本は [`tools/demo-video/scenes.mjs`](../tools/demo-video/scenes.mjs) です。**
> この文書とシーン定義は同じ内容を指しており、`npm test` の
> `tests/oauth-verification.test.mjs` が食い違いを検出します。

---

> ⚠️ **2026-08 の差し戻しを受けて全面改訂しました（2回目）。**
> Google からは「**スコープごとに、機能の全体像（maximum extent）を実演すること**」
> 「**書き込み・削除の権限は、変更が利用者の Google アカウント側に反映されるところまで映すこと**」
> 「**ホームページとプライバシーポリシーは、所有を確認できるドメインに置くこと**」を求められています。
> 対応の全体像は [C6: 審査差し戻しへの回答](C6_VERIFICATION_RESPONSE.md) にまとめてあります。

---

## 0. まず結論：この動画で証明すべきこと

審査担当者は動画だけを見て「このアプリは、申請したスコープを、申請どおりの目的で使っているか」を判断します。
必要なのは次の 3 つです。

1. **要求スコープ 1 つにつき、それを使っている機能を「できることの全体」まで実演する**
   （1 画面だけ映して終わりにしない。読み取り・書き込み・削除がある機能はすべて見せる）
2. **書き込み・削除については、その結果が利用者の Google アカウント側に現れるところまで映す**
   （スプレッドシート本体／Drive のファイル一覧と**ごみ箱**／Gmail の受信トレイ／Classroom のストリーム／アプリ内の自動実行一覧）
3. **ホームページとポリシーが、自分が所有するドメインで配信されている**ことをアドレスバーで見せる

本アプリの要求スコープと、動画で対応させるシーンは次のとおりです（`appsscript.json` の 7 個）。

| # | スコープ | 種別 | 動画で証明するシーン |
|---|----------|------|----------------------|
| 1 | `userinfo.email` | sensitive | シーン4末尾（設定タブ「使用中のデータベース」にログイン中アカウントが出る）／シーン8（リマインダーが本人宛に届く） |
| 2 | `drive.file` | sensitive | シーン4（週案 DB の入力・集計・タスクの追加と削除＝**スプレッドシート側で確認**）／シーン5（**Google ピッカー**で選んだファイルだけに権限が付く）／シーン6（アプリが作るファイルと、削除の**Drive ごみ箱への反映**） |
| 3 | `script.external_request` | 非 sensitive | シーン7（Gemini 生成＋モデル一覧取得＋**送信先の全列挙**） |
| 4 | `script.send_mail` | sensitive | シーン8（「今すぐテスト送信」→ **Gmail の受信トレイで実物と宛先を確認**） |
| 5 | `classroom.courses.readonly` | sensitive | シーン9前半（クラス一覧の読み込み） |
| 6 | `classroom.announcements` | sensitive | シーン9後半（**本文だけの投稿**と**Drive のファイルを添付した投稿**の2種類 → Classroom 側で確認） |
| 7 | `script.scriptapp` | 非 sensitive | シーン10（設定タブ「自動実行（トリガー）の状況」で**登録と解除がアカウントに反映される**ところ） |

> 💡 **`spreadsheets` は要求しなくなりました。** 週案データベースはアプリ自身が作るスプレッドシートなので、
> Sheets REST API v4 を `drive.file` で呼べば足ります（[B5](B5_SHEETS_SCOPE_AUDIT.md)）。
> 動画でもこの点を明言してください。差し戻しの「最小スコープ」への回答そのものになります。

> ⚠️ **3・7 は sensitive ではありませんが、差し戻しで名指しされました。**
> 「同意画面に出るから十分」ではなく、**専用のシーンで実演**してください（シーン7・シーン10）。
> **どのシーンも 1 つでも欠けると差し戻しの原因**になります。

### 前回から増えたシーン（ここが今回の改訂点）

| シーン | なぜ増やしたか |
|---|---|
| **シーン5：Google ピッカー** | `drive.file` の per-file モデルを、Google が推奨する導線そのもの（ピッカー）で見せるため。「アプリが作ったファイルしか触れない」だけでなく「利用者が選んだファイルだけが見える」ことまで示す |
| **シーン6：Drive のファイルとごみ箱** | 「書き込み・削除がアカウント側に反映される」ことの証明を、スプレッドシート内部だけでなく**Drive のファイル一覧とごみ箱**でも示すため |
| **シーン9の投稿2種類** | `classroom.announcements` の全体像は「本文だけの投稿」と「Drive のファイルを添付した投稿」の2つ。片方だけだと追加質問が来る |
| **シーン10の一覧の中身** | トリガーは5種類（リマインダー／Classroom 自動投稿／指導計画 PDF／行事予定 PDF／不要トリガーの整理）。一覧に何が並ぶのかを字幕で説明する |

---

## 1. Google が動画に求める形式要件（チェックリスト）

撮影前にこの 11 項目を確認してください。差し戻しの大半はここです。

- [ ] **YouTube に「限定公開（Unlisted）」でアップロードする**。「非公開（Private）」だと審査担当が見られず、その時点で差し戻しになります。
- [ ] **言語は英語**。日本語で操作する画面を撮るのは問題ありませんが、**ナレーションか字幕のどちらかは英語**にします（本台本は英語字幕テキストを用意しています）。
- [ ] **同意画面（OAuth consent screen）の言語設定を English にする**。同意画面の左下に言語切替があります。
- [ ] **録画は「ウィンドウ」ではなく「ディスプレイ全体」を対象にすること**。同意画面は**別ウィンドウのポップアップ**で開くため、ウィンドウ単位の録画ではこの最重要シーンがまるごと欠落します（実際にこれで1本撮り直しになっています）。
- [ ] **同意画面を表示しているとき、ブラウザのアドレスバーが映っていること**。URL に含まれる `client_id=...` が読み取れる必要があります。
- [ ] **アドレスバーの `client_id` が、審査申請に使う OAuth クライアント ID と一致していること**。
- [ ] **同意画面に表示されるスコープが、申請するスコープと完全に一致していること**（7個）。
- [ ] **同意画面に表示されるアプリ名が、申請するアプリ名・動画内のアプリ名と一致していること**。
- [ ] **OAuth の同意フローは、カットせず一続きで撮ること**。
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
> なお、承認を取り消すと `drive.file` の per-file 権限も失われます。撮影用アカウントで
> 初回起動からやり直すか、シーン5のピッカーでデータベースを選び直してください
> （この「選び直し」自体が `drive.file` の良い実演になります）。

### 2-1-2. アプリ名の表記をそろえる

**同意画面のアプリ名と、動画に映るアプリ名が違うと差し戻されます。** 現状はこうなっています。

| どこ | 表記 |
|---|---|
| アプリ画面のヘッダー（`App.html`） | 週案エディタ |
| 紹介ページ（`docs/about.html`） | 週案エディタ（School Plan Note） |
| リマインダーメールの署名（`07_WebApp.gs`） | 週案エディタ（School Plan Note） |

シーン1で紹介ページ、シーン3以降でアプリ画面、シーン8でメール本文が映るので、
**両方の表記を含む名前**（`週案エディタ（School Plan Note）`）を OAuth 同意画面のアプリ名に
登録しておくのが安全です。`npm run demo:verify` を実行すると、この表記ゆれを毎回確認できます。

### 2-1-3. 公開ページのドメインを確認する

差し戻しで「**所有を確認できない第三者ホスティングに置かないこと**」と指摘された項目です。

- [ ] ホームページ・プライバシーポリシー・利用規約が **`https://schoolplan-editor.giga-school.com/…`**（`docs/CNAME` の独自ドメイン）で開ける
- [ ] `*.github.io` の URL では**開かない**（撮影ツールの既定値も独自ドメインに直してあります）
- [ ] Cloud Console の同意画面に登録した URL も、この独自ドメインになっている
- [ ] そのドメインを Google Search Console で**所有確認済み**にしてある（同意画面のドメイン確認と同じ考え方）

### 2-2. デモ用データを用意する（個人情報を映さない）

動画は Google の審査担当が視聴します。**実在する児童・保護者・教職員の情報は絶対に映さない**でください。

- [ ] 撮影用に**ダミーの学級**（例：`3年1組`／児童名はすべて架空）を作る
- [ ] 週案・学級通信のデモ内容は架空のものにする
- [ ] Classroom も**撮影用のテストクラス**を作り、実クラスには投稿しない
- [ ] シーン5・6で **Google ピッカーと Drive の一覧・ごみ箱**が映ります。撮影用アカウントの Drive に
      実データが無いことを事前に確認する（他人の共有ファイルが「最近使用したアイテム」に出ることがあります）
- [ ] 行事予定 PDF も**ダミーの学校**のものを用意する（シーン5のピッカーで選びます）
- [ ] ブラウザのブックマークバー、他タブのタイトル、通知ポップアップを隠す（**新しいプロフィール**での撮影を推奨）
- [ ] メールの受信箱を映すシーンでは、**他のメールが映らないよう検索で絞り込んでおく**
- [ ] Gemini API キーを設定済みにしておく（**有料ティア**のキー。シーン7で AI 生成を実演します）

### 2-3. 画面と録画の設定

- [ ] ブラウザの表示倍率を **100〜125%**（文字が小さすぎると差し戻し）
- [ ] ウィンドウは最大化。アドレスバーを常時表示
- [ ] 同意画面の言語を English に切り替える（画面左下）
- [ ] 録画ツール（macOS: QuickTime／Windows: Xbox Game Bar／どちらも OBS 可）を 1080p 以上に設定
- [ ] マイクを使わない場合は無音で録り、**編集で英語字幕を載せる**方針にする

---

## 3. 撮影台本

**想定尺：13分30秒前後。**（`npm run demo:verify` が実測見積もりを出します）
網羅性を優先して長くしています。短さより「全スコープの全体像が映っていること」が要件です。
各シーンの「English caption」は、そのまま字幕として画面下部に載せる想定の英文です。
ナレーションする場合も同じ文を読み上げれば要件を満たします。

---

### シーン1：アプリの紹介と、自社ドメインのポリシー（約40秒）

**映すもの**：紹介ページ（`https://schoolplan-editor.giga-school.com/about.html`）、
続けてプライバシーポリシーと利用規約のページ。**アドレスバーを常に映す。**

**操作**：
1. 紹介ページを開き、アプリ名とアドレスバーがはっきり見える状態で3秒以上静止する
2. プライバシーポリシーのリンクを開き、ページ冒頭を数秒表示
3. 利用規約も同様に表示

**English caption**：
> This is School Plan Note, a web application for elementary school teachers in Japan.
> Teachers use it to write weekly lesson plans, manage classroom tasks, and share class newsletters.
> Our homepage is served from schoolplan-editor.giga-school.com, a domain we own and have verified in Search Console.
> The privacy policy is on that same domain — this is the URL submitted in this verification request.
> And these are our terms of service.

> ⚠️ ここで映すアプリ名・URL は、OAuth 同意画面（C2）に登録したものと**一字一句同じ**にしてください。
> **アドレスバーに独自ドメインが読める状態**であることが、ホスティングに関する指摘への回答になります。

---

### シーン2：教員本人のスプレッドシート（約30秒）

**映すもの**：教員本人の Google スプレッドシート（週案データベース）。

**操作**：
1. スプレッドシートを開く（ダミーデータのもの）
2. 週案データが入っていることが分かる状態で数秒静止する
3. Web アプリの URL（`https://script.google.com/macros/s/…/exec`）を開く

**English caption**：
> Each teacher owns a single Google Spreadsheet that stores their own lesson plan data.
> The application creates this spreadsheet itself the first time a teacher signs in. That is why the drive.file scope alone is enough to read and write it.
> It never opens any other spreadsheet in the teacher's Drive, and it never sees another teacher's data.

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
> The application requests seven scopes: per-file Drive access, sending email as the user, creating scheduled triggers, outbound HTTPS requests, Classroom courses read-only, Classroom announcements, and the user's email address.
> Every one of them is demonstrated end to end in the following sections of this video.

> ⚠️ **チェック**：
> - アドレスバーの `client_id=` が読めるか（撮影後に一時停止して必ず確認）
> - 同意画面が English になっているか
> - 表示スコープ数が `appsscript.json` の `oauthScopes`（7個）と対応しているか

---

### シーン4：週案データベースの読み・書き・削除＝`drive.file`（約2分10秒）★書き込み・削除の反映を見せる★

**映すもの**：週案の入力（書き込み）→ 時数集計（読み取り）→ タスクの追加と削除（書き込み・削除）→
**スプレッドシート本体での確認** → 設定タブの「使用中のデータベース」（`userinfo.email`）。

> 📌 このシーンは「セルに1つ入力して終わり」では**足りません**。
> 差し戻しでは「機能の全体像を見せること」と「変更が Google アカウント側に反映されるところまで
> 見せること」を求められています。動画では
> **「アプリが作ったファイルだから `drive.file` で足りる」**と明言してください。

**操作**：
1. 「週案」タブで編集モードにし、セルをダブルクリックして教科・単元・学習活動を入力（**書き込み**）
2. 保存されたことが分かる表示（トースト等）を映す
3. 「時数」タブを開き、集計が表示されるところを映す（**読み取り**：同じシートから計算している）
4. 「タスク」タブでタスクを1件追加して保存（**書き込み**）
5. 続けてそのタスクを削除（**削除**：行は `_週案_ごみ箱` シートへ移る）
6. **スプレッドシート本体を開き、次の3つを順に見せる**（ここが決定打）
   - データベースシート … 手順1で入力したセルが入っている
   - タスクシート … 追加した行と、削除で減った行
   - `_週案_ごみ箱` シート … 削除した行がここへ移っている
7. アプリに戻り、「設定」タブの **「使用中のデータベース」** を映す
   （データベース名・スプレッドシート ID・**ログイン中のメールアドレス**が出る）

**English caption**：
> Teachers enter their weekly lesson plan in this grid.
> What we type here is written into the teacher's own spreadsheet through the Sheets API.
> The same file is read back through the same scope: this annual lesson-hour summary is calculated from the rows stored in it.
> Creating and deleting a task writes to, and removes rows from, the same spreadsheet. Deleted rows are moved to a recycle-bin sheet inside that same file, so nothing is lost by accident.
> Here is the teacher's spreadsheet in their own Google account, showing exactly the changes made in the app a moment ago.
> We do not hold the spreadsheets scope. This file is read and written through drive.file, because the app created it. We cannot open any other spreadsheet.
> This panel shows which account is signed in and which single file is being used. We request the user's email address only to tell one teacher's database from another's — it is never sent anywhere.

---

### シーン5：Google ピッカー＝`drive.file`（約1分20秒）★今回追加★

**映すもの**：設定タブ「使用中のデータベース」の**「別のシートに切替」** → Google ピッカー、
続けて「行事予定」タブの**「PDFを追加」** → PDF だけを出す複数選択ピッカー。

> 📌 Google 自身が「`drive.file` + Google Picker」を推奨しています。
> **その導線が実際にアプリに載っていること**を見せるシーンです。
> 「アプリが作ったファイルしか触れない」だけでなく、
> 「**利用者が選んだファイルだけが見えるようになる**」ところまで示します。

**操作**：
1. 「設定」タブの「使用中のデータベース」で「別のシートに切替」を押す
2. 「ドライブから選ぶ」を選び、**ピッカーにスプレッドシートだけが並ぶ**ところを3秒以上映す
3. **いま使っているデータベースと同じシート**を選ぶ（安全。別のシートを選ぶと切り替わります）
   - 不安ならキャンセルでも構いません。**ピッカーが開いたこと**が要点です
4. 「行事予定」タブを開き、「PDFを追加」を押す
5. ピッカーが **PDF に絞り込まれ、複数選択できる**ことを映す
6. 撮影用の行事予定 PDF を1〜2件選び、一覧に並んでプレビューされるところまで映す

**English caption**：
> A teacher who already has a lesson plan file can point the app at it. This is the only way the app can reach a file it did not create.
> This is the Google Picker. The teacher chooses one file, and only that file becomes visible to the application. Everything else in their Drive stays out of reach — the app has no way to list or open it.
> The school calendar feature works the same way. Teachers pick the PDF files they want the app to use.
> The picker is filtered to PDF files and allows multiple selection. The app stores only a reference to the files the teacher selected, and can read those files and nothing else.

> 💡 ピッカーには Cloud プロジェクト番号（App ID）を渡しています。これが無いと
> 「選んでもサーバー側から開けない」状態になります（`setAppId`）。実装の詳細は
> [B1](B1_DRIVE_SCOPE_AUDIT.md)・[B5](B5_SHEETS_SCOPE_AUDIT.md) を参照。

---

### シーン6：アプリが作るファイルと、削除の Drive への反映＝`drive.file`（約1分50秒）★今回追加★

**映すもの**：学級通信の保存（Drive にファイルが作られる）→ 削除（**Drive のごみ箱へ入る**）→
完全バックアップ（**新しいスプレッドシートが Drive にできる**）→ Drive の一覧とごみ箱。

**操作**：
1. 「学級通信」タブで内容を1件「保存」する（Drive にアプリ所有のファイルが作られる）
2. 「ファイル → 開く」で保存済み一覧を出し、いま保存したものを**削除**する
3. 「設定」タブの **「データ保全・復元」** カードで「**今すぐ完全バックアップ**」を押す
4. 「バックアップ一覧」を開き、作られたバックアップが並ぶところを映す
5. **Drive（`https://drive.google.com/drive/recent`）を開く**
   … 週案データベース・学級通信のファイル・バックアップが並ぶ（＝アプリが作ったものだけ）
6. **Drive のごみ箱（`https://drive.google.com/drive/trash`）を開く**
   … 手順2で削除した学級通信ファイルが入っている

**English caption**：
> The newsletter editor stores each saved newsletter as a file the app creates in the teacher's Drive.
> Deleting it from the app moves that Drive file to the trash of the teacher's own account.
> A backup copies the whole database into a new spreadsheet, again created by the app. Backups older than the retention limit are moved to the trash automatically.
> Here is the teacher's Drive. These are the files the application created: the lesson plan database, the newsletter files, and the backup we just made.
> And here is the Drive trash, showing the newsletter file we deleted a moment ago. Every write and every delete is visible in the user's own account.
> We request drive.file, not full Drive access. The app can only see files it created itself or files the teacher picked.

> 💡 `drive.file` に絞っていることは審査上の強いアピール材料です。**必ず字幕で「not full Drive access」と明言**してください。

---

### シーン7：外部通信の全体像＝`script.external_request`（約1分30秒）

**映すもの**：「学級通信」タブで Gemini による本文生成 → 設定タブの Gemini 設定（モデル一覧・有料ティアの注意書き）。

**操作**：
1. 「学級通信」タブを開き、AI 一括生成を実行して本文が挿入されるまで映す
2. 「設定」タブを開き、**「使用モデル名」のドロップダウン**を映す
   （この一覧自体が Gemini API への問い合わせで作られる＝外部通信）
3. **Gemini API 設定の注意書き（有料ティア必須）**を映す
4. 外部通信の送信先が次の**5つだけ**であることを字幕で明示する
   - Gemini API（AI 機能。学級通信・タスク抽出・振り返りの要約・単元の配当・PDF 解析）
   - Google Drive REST API（アプリが作った／利用者が選んだファイルの操作）
   - Google Sheets REST API（週案データベースの読み書き）
     ※ Drive・Sheets を REST で呼ぶのは、`DriveApp` / `SpreadsheetApp` を使わず `drive.file` だけで動かすため
   - Google の `tokeninfo` エンドポイント（ピッカーに渡す自社 Cloud プロジェクト番号の取得）
   - 内閣府「国民の祝日」CSV（公開データの取得のみ。利用者データは送らない）

**English caption**：
> The app calls the Gemini API to draft the class newsletter from the teacher's lesson plan.
> This outbound HTTPS request is what the script.external_request scope is for.
> The same scope powers the other AI features: extracting tasks and school events from a PDF, drafting the weekly reflection, and laying out teaching units.
> This model list is itself an outbound request: the app asks the Gemini API which models the teacher's own key can use.
> The API key is supplied and stored by each teacher in their own Apps Script user properties. We never receive it, and we require a paid-tier key, because free-tier content may be used to improve Google's models.
> This is every host the app contacts: the Gemini API, the Google Drive and Google Sheets REST APIs, Google's tokeninfo endpoint to identify our own Cloud project for the file picker, and a public holiday calendar published by the Japanese Cabinet Office. No user data is sent to that last one, and there is no server of ours anywhere in this list.

---

### シーン8：メールリマインダー＝`script.send_mail` + `userinfo.email`（約1分10秒）

**映すもの**：「タスク」タブのリマインダー設定 → テスト送信 → 受信箱。

> 📌 リマインダー設定があるのは **「タスク」タブ**です（「設定」タブではありません）。
> 画面最下部の「リマインダー（毎朝メール通知）」までスクロールします。

**操作**：
1. 「タスク」タブ →「リマインダー（毎朝メール通知）」を開く
2. 「リマインダーを有効にする」をチェックし、送信時刻を選ぶ（＝時限トリガーの作成）
3. 「設定を保存」→「今すぐテスト送信」をクリック
4. **Gmail に切り替え、届いたリマインダーメールを開いて見せる**
5. 宛先が**ログイン中のアカウント自身**であることを映す

**English caption**：
> Teachers can enable a daily reminder for their unfinished tasks.
> Setting the delivery time creates a time-based trigger, which requires the script.scriptapp scope.
> The script.send_mail scope sends that reminder, and userinfo.email identifies the signed-in teacher so the message goes to that same teacher and no one else.
> Here is the message in the signed-in teacher's own Gmail inbox. The To field is that same teacher. This reminder is the only email the app can send: there is no recipient list and no other template, and the app cannot read any mail.

> ⚠️ 宛先欄が読める状態で映してください。「本人宛にしか送らない」ことの証明になります。
> Gmail では **受信トレイに届いた状態 → メールを開く → 宛先（To）→ 本文** の順に、それぞれ3秒以上静止します。
> 「送信した」ではなく「**送信先アカウントに届いた**」ところまでが求められています。
> メール本文の署名は「週案エディタ（School Plan Note）」です（同意画面のアプリ名とそろえてあります）。

---

### シーン9：Classroom 連携＝`classroom.courses.readonly` + `classroom.announcements`（約2分）★山場★

**映すもの**：「設定」タブの Google Classroom 連携 → クラス一覧の取得 → **2種類の投稿** → Classroom 側での確認。

**操作**：
1. 「設定」タブの「Google Classroom」欄を開く
2. 「一覧取得」でクラス一覧を読み込む（**ドロップダウンにクラス名が並ぶところをはっきり映す**）
3. 撮影用テストクラスを選択する
4. **「明日の予定を投稿」**をクリック（本文だけのお知らせ）→ 成功メッセージを映す
5. 「学級通信」タブの**「Classroom投稿」**をクリック（**Drive に文書を作り、それを添付したお知らせ**）→ 成功メッセージを映す
6. 「明日の予定 自動投稿時刻（時）」の欄を映す（時刻を入れると毎日の自動投稿トリガーが作られる）
7. **Google Classroom を開き、ストリームの2件のお知らせを見せる**（添付 PDF も開く）

**English caption**（前半・クラス一覧のとき）：
> The teacher links the app to their own Google Classroom course.
> We use classroom.courses.readonly only to list the active courses the teacher already teaches, so they can choose one from this dropdown. We do not read student data, rosters, coursework, or grades.

**English caption**（後半・投稿のとき）：
> The teacher can post tomorrow's schedule to the selected course as an announcement.
> The second kind of post attaches a file: the newsletter is exported as a PDF that the app creates in the teacher's Drive, and that file is attached to the announcement.
> A teacher who wants this every day can set a posting time here. That schedule is a trigger in their own account, and it posts only to the course they selected. Leaving the field empty removes it.
> Here are both announcements in Google Classroom, in the teacher's own course. The app posts only to the course the teacher chose, and only when the teacher asks for it or schedules it themselves.

> ⚠️ **これが審査で最も見られるシーンです。** 「一覧取得」と「投稿」は必ず**両方**、
> 投稿は**本文だけのものと添付つきのものの両方**を映してください。片方だけだと追加質問のメールが来ます。
> 「自動投稿は利用者が時刻を設定したときだけ動く」ことも明言します（勝手に投稿しない、という説明の正確さが要ります）。

---

### シーン10：自動実行の登録と解除＝`script.scriptapp`（約1分）

**映すもの**：「設定」タブの **「自動実行（トリガー）の状況」** カード。

> 📌 このカードは、`script.scriptapp` で作られたトリガーが
> 「いま自分の Google アカウントに何個登録されているか」を見せ、その場で解除もできる画面です。
> 書き込み系スコープに求められる **source account impact**（アカウント側への反映）を、
> この一覧の増減で示します。シーン8・9 で2つ登録したので、ここに並んでいるはずです。

**アプリが作るトリガーは次の5種類**（一覧に出る名前）：

| 名前 | いつ作られるか |
|---|---|
| タスクのリマインダーメール | 利用者がリマインダーを有効にしたとき（シーン8） |
| Classroom への予定の自動投稿 | 利用者が投稿時刻を設定したとき（シーン9） |
| 指導計画 PDF の読み取り（バックグラウンド） | PDF 取り込み中だけ。終わると自動で消える |
| 行事予定 PDF の読み取り（バックグラウンド） | 同上 |
| 不要な自動実行の自動整理 | 毎晩1回。役目を終えたトリガーを片づける |

**操作**：
1. 「設定」タブを開き、「自動実行（トリガー）の状況」までスクロールする
2. シーン8・9で作られた2つが**一覧に現れている**ことを映す（3秒以上静止）
3. 「解除」を押し、確認ダイアログで解除する
4. **一覧からその行が消える**ところを映す（削除がアカウントに反映された証明）

**English caption**：
> The script.scriptapp scope schedules work in the teacher's own account. This panel lists every trigger the app has created there.
> The daily reminder and the Classroom posting time we just set now appear here, next to the nightly job that cleans up triggers which are no longer needed. Importing a PDF adds a short-lived trigger to this list too, and it removes itself when the import finishes.
> Deleting it here removes the trigger from the teacher's account immediately, as the list confirms. Teachers can see and remove every scheduled job the app created, and the app creates none that are not listed.

> 💡 「PDF読み込み」タブで取り込みを実演した直後にこの画面を開くと、**バックグラウンド処理用の
> 一時トリガー**も一覧に出ます。時間に余裕があれば、その様子（処理が終わると自動で消える）も
> 撮っておくと説得力が上がります。

---

### シーン11：まとめ（約30秒）

**映すもの**：アプリのトップ画面に戻る。

**English caption**：
> To summarize: School Plan Note keeps each teacher's lesson plan in one spreadsheet it created, creates and deletes only its own files in Drive or the ones the teacher picked, sends a reminder to the signed-in teacher alone, schedules that work in the teacher's own account where they can remove it, and posts to the teacher's own Classroom course when they ask.
> All requested scopes are used only for these purposes, as described in our privacy policy.
> Thank you for reviewing our application.

---

## 4. 撮影後：確認と公開

### 4-1. 提出前の最終確認

- [ ] シーン1で**アドレスバーの独自ドメイン**が読める（第三者ホスティングの指摘への回答）
- [ ] シーン3で**アドレスバーの `client_id` が一時停止して読める**
- [ ] 同意画面が **English** で表示されている
- [ ] 同意画面のアプリ名が申請するアプリ名と一致
- [ ] シーン4〜10で **要求スコープ 7 個すべて**が実演されている
      （`script.external_request` と `script.scriptapp` も専用シーンで）
- [ ] **書き込み・削除の反映**が、それぞれ Google アカウント側で映っている
      （スプレッドシート本体と `_週案_ごみ箱` シート／**Drive のファイル一覧とごみ箱**／
      Gmail の受信トレイ／Classroom のストリーム／自動実行の一覧）
- [ ] `drive.file` について、**アプリが作ったファイル**と**ピッカーで選んだファイル**の
      両方が映っている（シーン4・6 と シーン5）
- [ ] `classroom.announcements` について、**本文だけの投稿**と**添付つきの投稿**の両方が映っている
- [ ] 実在の児童・保護者・教職員の氏名、写真、メールアドレスが**一切映っていない**
- [ ] Drive の一覧・ごみ箱に、撮影用以外のファイルが映っていない
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
| 申請スコープの一部が実演されていない | 本書の「§0 スコープ対応表」で 1〜7 をすべて消し込む |
| 機能の「全体像」が示されていない | 読み取り・書き込み・削除を1シーンにまとめて実演する（シーン4・6・9） |
| 書き込み・削除がアカウントに反映される様子がない | スプレッドシート本体／Drive の一覧とごみ箱／Gmail／Classroom／自動実行一覧を必ず映す |
| ホームページ・ポリシーが第三者ホスティング | 独自ドメイン（`docs/CNAME`）で配信し、アドレスバーに映す |
| 同意画面のアプリ名と動画内のアプリ名が違う | C2 の設定・紹介ページ・リマインダーメールの署名をそろえる |
| 「なぜ Classroom の投稿権限が必要か」が伝わらない | シーン9で「教員が押したときか、教員が設定した時刻にだけ投稿する」と明言する |
| Drive 全体にアクセスしていると誤解される | シーン5・6で「`drive.file`, not full Drive access」とピッカーを明示する |
| 開発版・ローカル環境で撮影している | 本番デプロイ済み Web アプリで撮り直す |

---

## 次にやること
- 撮影が終わったら **[C4: Google の審査を申し込む](C4_GOOGLE_VERIFICATION.md)** に戻り、動画 URL を添えて申請します。
- 返信メールの文面は **[C6: 審査差し戻しへの回答](C6_VERIFICATION_RESPONSE.md) §5** にあります。

---
<details>
<summary>もっと詳しく（公式ドキュメント）</summary>

- デモ動画の要件: https://support.google.com/cloud/answer/13804565
- 確認（verification）の要件: https://support.google.com/cloud/answer/13464321
- 審査の申し込み: https://support.google.com/cloud/answer/13461325
- OAuth アプリの確認について: https://support.google.com/cloud/answer/9110914
- `drive.file` と Google Picker: https://developers.google.com/drive/picker/guides/overview
</details>
