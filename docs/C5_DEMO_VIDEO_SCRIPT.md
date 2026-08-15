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

## 0. まず結論：この動画で証明すべきこと

審査担当者は動画だけを見て「このアプリは、申請したスコープを、申請どおりの目的で使っているか」を判断します。
つまり **要求スコープ 1 つにつき、それを使っている画面が最低 1 回映っている**必要があります。

本アプリの要求スコープと、動画で対応させるシーンは次のとおりです。

| # | スコープ | 種別 | 動画で証明するシーン |
|---|----------|------|----------------------|
| 1 | `userinfo.email` | sensitive | シーン7（リマインダーがログイン中の本人宛に届く）／シーン3（「設定」タブの「使用中のデータベース」に表示されるログイン中アカウント） |
| 2 | `spreadsheets` | sensitive | シーン4（週案グリッドの入力 → 本人所有スプレッドシートに保存されるところ） |
| 3 | `drive.file` | sensitive | シーン6（学級通信のPDF出力 → アプリが作成したファイルだけが Drive にできる） |
| 4 | `script.send_mail` | sensitive | シーン7（「今すぐテスト送信」→ 受信箱で確認） |
| 5 | `classroom.courses.readonly` | sensitive | シーン8前半（クラス一覧の読み込み） |
| 6 | `classroom.announcements` | sensitive | シーン8後半（Classroom へ投稿 → Classroom 側のストリームで確認） |
| 7 | `script.external_request` | 非 sensitive | シーン5（Gemini による学級通信生成／祝日データ取得） |
| 8 | `script.container.ui` | 非 sensitive | シーン2（スプレッドシートのカスタムメニュー「週案ツール」） |
| 9 | `script.scriptapp` | 非 sensitive | シーン7（リマインダー時刻の設定＝時限トリガー作成） |

> ⚠️ **8・9 は sensitive ではありませんが、同意画面には表示されます。**
> 同意画面を映すシーン3で自然に映るので、個別シーンを削っても構いません。
> 逆に **1〜6 のシーンは 1 つでも欠けると差し戻しの原因**になります。

---

## 1. Google が動画に求める形式要件（チェックリスト）

撮影前にこの 10 項目を確認してください。差し戻しの大半はここです。

- [ ] **YouTube に「限定公開（Unlisted）」でアップロードする**。「非公開（Private）」だと審査担当が見られず、その時点で差し戻しになります。
- [ ] **言語は英語**。日本語で操作する画面を撮るのは問題ありませんが、**ナレーションか字幕のどちらかは英語**にします（本台本は英語字幕テキストを用意しています）。
- [ ] **同意画面（OAuth consent screen）の言語設定を English にする**。同意画面の左下に言語切替があります。
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

**想定尺：6〜8分。** 各シーンの「English caption」は、そのまま字幕として画面下部に載せる想定の英文です。
ナレーションする場合も同じ文を読み上げれば要件を満たします。

---

### シーン1：アプリの紹介（0:00〜0:40）

**映すもの**：GitHub Pages の紹介ページ（`https://<ユーザー名>.github.io/SchoolPlan_Editor/`）、続けてプライバシーポリシーと利用規約のページ。

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

### シーン2：スプレッドシートとカスタムメニュー（0:40〜1:10）

**映すもの**：教員本人の Google スプレッドシート（週案データベース）と、カスタムメニュー「週案ツール」。

**操作**：
1. スプレッドシートを開く（ダミーデータのもの）
2. メニューバーの「週案ツール」をクリックしてメニューを開く
3. メニューから Web アプリを開く導線をクリック（または Web アプリの URL を直接開く）

**English caption**：
> Each teacher owns a single Google Spreadsheet that stores their own lesson plan data.
> The add-on menu is provided by the `script.container.ui` scope.
> Opening the web application starts the OAuth flow.

---

### シーン3：OAuth 同意画面（1:10〜2:10）★最重要★

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
> The application requests the following scopes: Google Sheets, Drive file access, Classroom courses read-only, Classroom announcements, sending email on the user's behalf, and the user's email address.
> Each of these scopes is demonstrated in the following sections of this video.

> ⚠️ **チェック**：
> - アドレスバーの `client_id=` が読めるか（撮影後に一時停止して必ず確認）
> - 同意画面が English になっているか
> - 表示スコープ数が `appsscript.json` の `oauthScopes`（9個）と対応しているか

---

### シーン4：週案の入力＝`spreadsheets`（2:10〜3:00）

**映すもの**：「週案」タブのグリッド入力と、それがスプレッドシートに保存される様子。

**操作**：
1. 週案グリッドのセルをダブルクリックして編集し、教科・単元・学習活動を入力
2. 保存されたことが分かる表示（トースト等）を映す
3. **スプレッドシートのタブに切り替え、同じ内容が書き込まれているのを見せる**（これが決定打）

**English caption**：
> Teachers enter their weekly lesson plan in this grid.
> The data is written to the teacher's own spreadsheet, shown here.
> We use the `spreadsheets` scope only to read and write this single database file, which is owned by the teacher.
> We never access any other spreadsheet.

---

### シーン5：AI 支援＝`script.external_request`（3:00〜3:40）

**映すもの**：「学級通信」タブで Gemini による本文生成。

**操作**：
1. 「学級通信」タブを開く
2. AI 生成ボタンを押し、生成された文章が挿入されるまで映す

**English caption**：
> The app calls the Gemini API to draft the class newsletter from the teacher's lesson plan.
> This external HTTPS request requires the `script.external_request` scope.
> The API key is stored per user in Apps Script properties and is never shared.

---

### シーン6：PDF 出力＝`drive.file`（3:40〜4:20）

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

### シーン7：メールリマインダー＝`script.send_mail` + `userinfo.email` + `script.scriptapp`（4:20〜5:20）

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

---

### シーン8：Classroom 連携＝`classroom.courses.readonly` + `classroom.announcements`（5:20〜6:40）★2つ目の山場★

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

### シーン9：まとめ（6:40〜7:10）

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
- [ ] シーン4〜8で **sensitive スコープ 6 個すべて**が実演されている
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
