/**
 * OAuth 審査用デモ動画のシーン定義（docs/C5_DEMO_VIDEO_SCRIPT.md の実行可能版）
 *
 * ここが台本の「正本」です。record-demo.mjs がこの定義どおりにブラウザを操作し、
 * caption ステップの実時刻から英語字幕（.srt）を自動生成します。
 *
 * ステップの種類:
 *   caption   画面下部に英語字幕を出す（字幕の1キューになる）。ms は表示時間
 *   goto      URL へ移動
 *   click     セレクタをクリック
 *   clickText ラベル文字列でボタンをクリック（within で範囲を絞る）
 *   fill      セレクタへ入力（1文字ずつ打つので画面で読める）
 *   select    セレクタで選択肢を選ぶ
 *   dblclick  セレクタをダブルクリック（週案セルの編集モード）
 *   highlight セレクタを枠線で強調して視線を誘導する
 *   expect    セレクタが表示されるまで待つ（出なければ失敗として記録）
 *   wait      指定ミリ秒だけ止まる
 *   manual    人の操作を待つ（Google ログイン・ピッカー・ダイアログなど）
 *   note      操作しないが記録に残すメモ（撮影後の確認用）
 *
 * セレクタに dynamic: true を付けたステップは、
 * verify-scenes.mjs のオフライン検証（JSで動的生成される要素）から除外されます。
 *
 * 📌 SweetAlert のダイアログ・Google ピッカー・Drive・Gmail・Classroom は
 *    自動操作せず manual で止めます。撮影者が手で操作し、Enter で再開します。
 */

/**
 * 週案グリッドのセル。App_Js_02_Plan.html の renderGrid が付ける data 属性に合わせる。
 * day=0 が月曜、key は行定義のキー（period0 が1校時）。
 */
const planCell = (day, key) => `#weekGrid .grid-cell[data-day="${day}"][data-key="${key}"]`;

export const SCENES = [
  // ---------------------------------------------------------------- シーン1
  {
    id: 'intro',
    title: 'アプリ紹介・自社ドメインのポリシー',
    scopes: [],
    steps: [
      { kind: 'goto', url: '{{HOME_URL}}' },
      {
        kind: 'caption',
        ms: 7000,
        text: 'This is School Plan Note, a web application for elementary school teachers in Japan.',
      },
      {
        kind: 'caption',
        ms: 7000,
        text: 'Teachers use it to write weekly lesson plans, manage classroom tasks, and share class newsletters.',
      },
      // 2026-08 の差し戻しで「ホームページとポリシーは自分が所有するドメインに置くこと」を
      // 求められたため、アドレスバーに自社ドメインが映る状態で読み上げる。
      {
        kind: 'caption',
        ms: 8000,
        text: 'Our homepage is served from schoolplan-editor.giga-school.com, a domain we own and have verified in Search Console.',
      },
      { kind: 'goto', url: '{{PRIVACY_URL}}' },
      {
        kind: 'caption',
        ms: 7000,
        text: 'The privacy policy is on that same domain — this is the URL submitted in this verification request.',
      },
      { kind: 'goto', url: '{{TERMS_URL}}' },
      { kind: 'caption', ms: 5000, text: 'And these are our terms of service.' },
      {
        kind: 'note',
        text: 'アドレスバーに giga-school.com が読める状態で3秒以上静止すること（ホスティング先の指摘への回答）',
      },
    ],
  },

  // ---------------------------------------------------------------- シーン2
  {
    id: 'database',
    title: '教員本人のスプレッドシート',
    scopes: [],
    steps: [
      { kind: 'goto', url: '{{SHEET_URL}}' },
      {
        kind: 'caption',
        ms: 8000,
        text: 'Each teacher owns a single Google Spreadsheet that stores their own lesson plan data.',
      },
      {
        kind: 'caption',
        ms: 9000,
        text: 'The application creates this spreadsheet itself the first time a teacher signs in. That is why the drive.file scope alone is enough to read and write it.',
      },
      {
        kind: 'caption',
        ms: 8000,
        text: 'It never opens any other spreadsheet in the teacher’s Drive, and it never sees another teacher’s data.',
      },
      { kind: 'wait', ms: 3000 },
    ],
  },

  // ---------------------------------------------------------------- シーン3
  {
    id: 'consent',
    title: 'OAuth 同意画面（最重要・カット禁止）',
    scopes: ['ALL'],
    manualOnly: true,
    steps: [
      { kind: 'goto', url: '{{APP_URL}}' },
      {
        kind: 'caption',
        ms: 6000,
        text: 'Opening the web application starts the OAuth flow.',
      },
      {
        kind: 'manual',
        prompt: [
          'ここから先は自動化しません（Google が自動操作のログインを拒否するため）。',
          '',
          '⚠️ 「REVIEW PERMISSIONS」を押すと同意画面は【別ウィンドウのポップアップ】で開きます。',
          '   ウィンドウ単位の画面録画だと、この最重要シーンがまるごと欠落します。',
          '   録画が【ディスプレイ全体】になっていることを、ここで必ず確認してください。',
          '',
          '次の順に、カットせず一続きで操作してください:',
          '  1. REVIEW PERMISSIONS → デモ用アカウントを選択',
          '  2. 同意画面が出たら、ポップアップのアドレスバーの client_id= が',
          '     読める状態で3秒以上静止（ポップアップを最大化するとなお良い）',
          '  3. スコープ一覧をゆっくりスクロールし、全項目を読めるようにする',
          '  4. 「続行 / Continue」を押し、週案画面が表示されるまで待つ',
          '完了したらこのターミナルで Enter を押してください。',
        ].join('\n'),
        ms: 0,
      },
      {
        kind: 'caption',
        ms: 6000,
        text: 'This is the OAuth consent screen for our application.',
      },
      {
        kind: 'caption',
        ms: 7000,
        text: 'The address bar shows the client ID of the OAuth client submitted for verification.',
      },
      {
        kind: 'caption',
        ms: 11000,
        text: 'The application requests seven scopes: per-file Drive access, sending email as the user, creating scheduled triggers, outbound HTTPS requests, Classroom courses read-only, Classroom announcements, and the user’s email address.',
      },
      {
        kind: 'caption',
        ms: 7000,
        text: 'Every one of them is demonstrated end to end in the following sections of this video.',
      },
      { kind: 'expect', selector: '#view-plan.active' },
    ],
  },

  // ---------------------------------------------------------------- シーン4
  {
    id: 'plan-data',
    title: '週案データベースの読み・書き・削除 = drive.file',
    scopes: ['drive.file', 'userinfo.email'],
    steps: [
      { kind: 'click', selector: 'header .nav-btn[data-view="plan"]' },
      { kind: 'expect', selector: '#view-plan.active' },
      {
        kind: 'caption',
        ms: 6000,
        text: 'Teachers enter their weekly lesson plan in this grid.',
      },
      { kind: 'highlight', selector: '#weekGrid' },
      { kind: 'click', selector: '#editToggleBtn' },
      { kind: 'wait', ms: 800 },
      { kind: 'dblclick', selector: planCell(0, 'period0'), dynamic: true },
      { kind: 'wait', ms: 600 },
      {
        kind: 'manual',
        prompt: [
          'セルに教科・単元・学習活動を入力し、保存されたことが分かるまで待ってください（書き込み）。',
          '終わったら Enter。',
        ].join('\n'),
        ms: 12000,
      },
      {
        kind: 'caption',
        ms: 8000,
        text: 'What we type here is written into the teacher’s own spreadsheet through the Sheets API.',
      },

      // 読み取り側も見せる。集計画面は同じスプレッドシートを読んで作られる。
      { kind: 'click', selector: 'header .nav-btn[data-view="hours"]' },
      { kind: 'expect', selector: '#view-hours.active' },
      {
        kind: 'caption',
        ms: 9000,
        text: 'The same file is read back through the same scope: this annual lesson-hour summary is calculated from the rows stored in it.',
      },
      { kind: 'wait', ms: 2500 },

      // 書き込み・削除まで含めて、実際にシート側が変わることを見せる（source account impact）
      { kind: 'click', selector: 'header .nav-btn[data-view="task"]' },
      { kind: 'expect', selector: '#view-task.active' },
      {
        kind: 'manual',
        prompt: [
          'タスクを1件追加し、保存してください（新しい行がシートに書き込まれます）。',
          '続けて、そのタスクを削除してください（行が「_週案_ごみ箱」シートへ移ります）。',
          '終わったら Enter を押してください。',
        ].join('\n'),
        ms: 16000,
      },
      {
        kind: 'caption',
        ms: 10000,
        text: 'Creating and deleting a task writes to, and removes rows from, the same spreadsheet. Deleted rows are moved to a recycle-bin sheet inside that same file, so nothing is lost by accident.',
      },

      { kind: 'goto', url: '{{SHEET_URL}}' },
      {
        kind: 'caption',
        ms: 10000,
        text: 'Here is the teacher’s spreadsheet in their own Google account, showing exactly the changes made in the app a moment ago.',
      },
      {
        kind: 'manual',
        prompt: [
          'スプレッドシート側で次を順に見せてください（source account impact の証明）。',
          '  1. データベースシート … いま入力したセルが書き込まれている',
          '  2. タスクシート … 追加した行と、削除で減った行',
          '  3. 「_週案_ごみ箱」シート … 削除した行がここへ移っている',
          'シート下部のタブを切り替えながら、各3秒以上静止します。終わったら Enter。',
        ].join('\n'),
        ms: 16000,
      },
      {
        kind: 'caption',
        ms: 10000,
        text: 'We do not hold the spreadsheets scope. This file is read and written through drive.file, because the app created it. We cannot open any other spreadsheet.',
      },
      { kind: 'wait', ms: 2000 },

      // ログイン中のアカウントを画面に出す（userinfo.email の用途）
      { kind: 'goto', url: '{{APP_URL}}' },
      { kind: 'click', selector: 'header .nav-btn[data-view="settings"]' },
      { kind: 'expect', selector: '#view-settings.active' },
      { kind: 'highlight', selector: '#tenantDbSection' },
      {
        kind: 'caption',
        ms: 11000,
        text: 'This panel shows which account is signed in and which single file is being used. We request the user’s email address only to tell one teacher’s database from another’s — it is never sent anywhere.',
      },
      { kind: 'wait', ms: 2500 },
    ],
  },

  // ---------------------------------------------------------------- シーン5
  // drive.file の per-file モデルそのものを見せる。Google が推奨する
  // Google Picker の導線が実際にアプリに載っていることを示す。
  {
    id: 'picker',
    title: 'Google ピッカーで選んだファイルだけに権限が付く = drive.file',
    scopes: ['drive.file'],
    steps: [
      { kind: 'expect', selector: '#view-settings.active' },
      { kind: 'highlight', selector: '#tenantDbSection' },
      {
        kind: 'caption',
        ms: 9000,
        text: 'A teacher who already has a lesson plan file can point the app at it. This is the only way the app can reach a file it did not create.',
      },
      { kind: 'clickText', text: '別のシートに切替', within: '#view-settings' },
      {
        kind: 'manual',
        prompt: [
          '「ドライブから選ぶ」を選び、Google ピッカーを開いてください。',
          '  1. ピッカーにスプレッドシートだけが並ぶところを3秒以上映す',
          '  2. いま使っているデータベースと同じシートを選ぶ（安全。別のシートを選ぶと切り替わります）',
          '     ※ 不安なら「キャンセル」でも構いません。ピッカーが開いたことが要点です。',
          '終わったら Enter。',
        ].join('\n'),
        ms: 15000,
      },
      {
        kind: 'caption',
        ms: 12000,
        text: 'This is the Google Picker. The teacher chooses one file, and only that file becomes visible to the application. Everything else in their Drive stays out of reach — the app has no way to list or open it.',
      },

      // もう一つのピッカー導線（複数選択）
      { kind: 'goto', url: '{{APP_URL}}' },
      { kind: 'click', selector: 'header .nav-btn[data-view="events"]' },
      { kind: 'expect', selector: '#view-events.active' },
      {
        kind: 'caption',
        ms: 8000,
        text: 'The school calendar feature works the same way. Teachers pick the PDF files they want the app to use.',
      },
      { kind: 'clickText', text: 'PDFを追加', within: '#view-events' },
      {
        kind: 'manual',
        prompt: [
          'ピッカーで撮影用の行事予定 PDF を1〜2件選んでください（複数選択できることも映す）。',
          '選んだ PDF が一覧に並び、プレビューが表示されるところまで見せます。終わったら Enter。',
        ].join('\n'),
        ms: 16000,
      },
      {
        kind: 'caption',
        ms: 11000,
        text: 'The picker is filtered to PDF files and allows multiple selection. The app stores only a reference to the files the teacher selected, and can read those files and nothing else.',
      },
      { kind: 'wait', ms: 2500 },
    ],
  },

  // ---------------------------------------------------------------- シーン6
  {
    id: 'drive-files',
    title: 'アプリが作るファイルと、削除のドライブ側への反映 = drive.file',
    scopes: ['drive.file'],
    steps: [
      { kind: 'goto', url: '{{APP_URL}}' },
      { kind: 'click', selector: 'header .nav-btn[data-view="newsletter"]' },
      { kind: 'expect', selector: '#view-newsletter.active' },
      {
        kind: 'caption',
        ms: 8000,
        text: 'The newsletter editor stores each saved newsletter as a file the app creates in the teacher’s Drive.',
      },
      {
        kind: 'manual',
        prompt: [
          '学級通信を1件「保存」してください（Drive にアプリ所有の JSON ファイルが作られます）。',
          '続けて「ファイル → 開く」で保存済み一覧を出し、いま保存したものを削除してください。',
          '（削除するとシートの行がごみ箱シートへ移り、Drive のファイルもごみ箱へ入ります）',
          '終わったら Enter。',
        ].join('\n'),
        ms: 18000,
      },
      {
        kind: 'caption',
        ms: 10000,
        text: 'Deleting it from the app moves that Drive file to the trash of the teacher’s own account.',
      },

      // 完全バックアップ（アプリが新しいスプレッドシートをドライブに作る）
      { kind: 'click', selector: 'header .nav-btn[data-view="settings"]' },
      { kind: 'expect', selector: '#view-settings.active' },
      {
        kind: 'manual',
        prompt: [
          '設定タブの「データ保全・復元」カードまでスクロールし、',
          '「今すぐ完全バックアップ」を押してください（Drive に新しいスプレッドシートが作られます）。',
          '完了メッセージと「バックアップ一覧」を開いて見せてから Enter。',
        ].join('\n'),
        ms: 18000,
      },
      {
        kind: 'caption',
        ms: 11000,
        text: 'A backup copies the whole database into a new spreadsheet, again created by the app. Backups older than the retention limit are moved to the trash automatically.',
      },

      // ドライブ側で「作られた」「捨てられた」の両方を確認する
      { kind: 'goto', url: 'https://drive.google.com/drive/recent' },
      {
        kind: 'caption',
        ms: 11000,
        text: 'Here is the teacher’s Drive. These are the files the application created: the lesson plan database, the newsletter files, and the backup we just made.',
      },
      { kind: 'wait', ms: 3000 },
      { kind: 'goto', url: 'https://drive.google.com/drive/trash' },
      {
        kind: 'caption',
        ms: 11000,
        text: 'And here is the Drive trash, showing the newsletter file we deleted a moment ago. Every write and every delete is visible in the user’s own account.',
      },
      { kind: 'wait', ms: 3000 },
      {
        kind: 'caption',
        ms: 9000,
        text: 'We request drive.file, not full Drive access. The app can only see files it created itself or files the teacher picked.',
      },
      {
        kind: 'note',
        text: 'Drive の一覧に他人の実データが映らないよう、撮影用アカウントで撮ること',
      },
    ],
  },

  // ---------------------------------------------------------------- シーン7
  {
    id: 'external-request',
    title: '外部通信の全体像 = script.external_request',
    scopes: ['script.external_request'],
    steps: [
      { kind: 'goto', url: '{{APP_URL}}' },
      { kind: 'click', selector: 'header .nav-btn[data-view="newsletter"]' },
      { kind: 'expect', selector: '#view-newsletter.active' },
      { kind: 'wait', ms: 1000 },
      {
        kind: 'caption',
        ms: 8000,
        text: 'The app calls the Gemini API to draft the class newsletter from the teacher’s lesson plan.',
      },
      { kind: 'click', selector: '.nw-palette-btn-ai-full' },
      {
        kind: 'caption',
        ms: 7000,
        text: 'This outbound HTTPS request is what the script.external_request scope is for.',
      },
      {
        kind: 'manual',
        prompt: 'AI一括生成のダイアログを進め、本文が挿入されるまで待ってから Enter を押してください。',
        ms: 18000,
      },
      {
        kind: 'caption',
        ms: 10000,
        text: 'The same scope powers the other AI features: extracting tasks and school events from a PDF, drafting the weekly reflection, and laying out teaching units.',
      },

      // 送信先を網羅して示す。「外部通信＝Gemini だけ」ではないことを明かしておく。
      { kind: 'click', selector: 'header .nav-btn[data-view="settings"]' },
      { kind: 'expect', selector: '#view-settings.active' },
      { kind: 'highlight', selector: '#sysGeminiModelName' },
      {
        kind: 'caption',
        ms: 9000,
        text: 'This model list is itself an outbound request: the app asks the Gemini API which models the teacher’s own key can use.',
      },
      { kind: 'highlight', selector: '#geminiTierNotice' },
      {
        kind: 'caption',
        ms: 11000,
        text: 'The API key is supplied and stored by each teacher in their own Apps Script user properties. We never receive it, and we require a paid-tier key, because free-tier content may be used to improve Google’s models.',
      },
      {
        kind: 'caption',
        ms: 14000,
        text: 'This is every host the app contacts: the Gemini API, the Google Drive and Google Sheets REST APIs, Google’s tokeninfo endpoint to identify our own Cloud project for the file picker, and a public holiday calendar published by the Japanese Cabinet Office. No user data is sent to that last one, and there is no server of ours anywhere in this list.',
      },
      { kind: 'wait', ms: 2500 },
      {
        kind: 'note',
        text: 'Drive/Sheets を REST で呼ぶのは drive.file だけで動かすため（DriveApp / SpreadsheetApp を使わない）。字幕で必ず触れる',
      },
    ],
  },

  // ---------------------------------------------------------------- シーン8
  {
    id: 'mail-reminder',
    title: 'メールリマインダー = script.send_mail + userinfo.email',
    scopes: ['script.send_mail', 'userinfo.email', 'script.scriptapp'],
    steps: [
      // リマインダー設定は「タスク」タブにある（「設定」タブではない）
      { kind: 'click', selector: 'header .nav-btn[data-view="task"]' },
      { kind: 'expect', selector: '#view-task.active' },
      {
        kind: 'caption',
        ms: 7000,
        text: 'Teachers can enable a daily reminder for their unfinished tasks.',
      },
      { kind: 'highlight', selector: '#chkTaskReminderEnabled' },
      { kind: 'click', selector: '#chkTaskReminderEnabled' },
      { kind: 'select', selector: '#taskReminderHour', value: '7' },
      {
        kind: 'caption',
        ms: 9000,
        text: 'Setting the delivery time creates a time-based trigger, which requires the script.scriptapp scope.',
      },
      { kind: 'clickText', text: '設定を保存', within: '#view-task' },
      { kind: 'expect', selector: '#taskReminderStatus' },
      { kind: 'wait', ms: 1500 },
      { kind: 'clickText', text: '今すぐテスト送信', within: '#view-task' },
      {
        kind: 'caption',
        ms: 13000,
        text: 'The script.send_mail scope sends that reminder, and userinfo.email identifies the signed-in teacher so the message goes to that same teacher and no one else.',
      },
      {
        kind: 'manual',
        prompt: [
          'Gmail を開き、届いたリマインダーメールを表示してください。',
          '  1. 受信トレイに届いていること',
          '  2. メールを開き、宛先（To）がログイン中のアカウント自身であること',
          '  3. 本文が「自分の未完了タスク」であること',
          'をそれぞれ3秒以上静止して見せます。終わったら Enter。',
          '（他のメールが映らないよう、あらかじめ検索で絞り込んでおいてください）',
        ].join('\n'),
        ms: 18000,
      },
      {
        kind: 'caption',
        ms: 13000,
        text: 'Here is the message in the signed-in teacher’s own Gmail inbox. The To field is that same teacher. This reminder is the only email the app can send: there is no recipient list and no other template, and the app cannot read any mail.',
      },
    ],
  },

  // ---------------------------------------------------------------- シーン9
  {
    id: 'classroom',
    title: 'Classroom 連携 = classroom.courses.readonly + classroom.announcements',
    scopes: ['classroom.courses.readonly', 'classroom.announcements'],
    steps: [
      { kind: 'goto', url: '{{APP_URL}}' },
      { kind: 'click', selector: 'header .nav-btn[data-view="settings"]' },
      { kind: 'expect', selector: '#view-settings.active' },
      { kind: 'highlight', selector: '#sysCourseName' },
      {
        kind: 'caption',
        ms: 7000,
        text: 'The teacher links the app to their own Google Classroom course.',
      },
      { kind: 'clickText', text: '一覧取得', within: '#view-settings' },
      { kind: 'expect', selector: '#sysCourseSelect' },
      { kind: 'wait', ms: 2000 },
      { kind: 'highlight', selector: '#sysCourseSelect' },
      {
        kind: 'caption',
        ms: 12000,
        text: 'We use classroom.courses.readonly only to list the active courses the teacher already teaches, so they can choose one from this dropdown. We do not read student data, rosters, coursework, or grades.',
      },
      {
        kind: 'manual',
        prompt: 'ドロップダウンから撮影用テストクラスを選択してください（クラス名が一覧に並んでいるところをはっきり映すこと）。',
        ms: 10000,
      },

      // 投稿その1: 明日の予定（本文だけのお知らせ）
      { kind: 'clickText', text: '明日の予定を投稿', within: '#view-settings' },
      {
        kind: 'caption',
        ms: 9000,
        text: 'The teacher can post tomorrow’s schedule to the selected course as an announcement.',
      },
      {
        kind: 'manual',
        prompt: '確認ダイアログを「投稿する」で進め、成功メッセージが出るまで待ってから Enter。',
        ms: 9000,
      },

      // 投稿その2: 学級通信（Drive のファイルを添付するお知らせ）
      { kind: 'clickText', text: '学級通信シートを投稿', within: '#view-settings' },
      {
        kind: 'caption',
        ms: 11000,
        text: 'The second kind of post attaches a file: the newsletter is exported as a PDF that the app creates in the teacher’s Drive, and that file is attached to the announcement.',
      },
      {
        kind: 'manual',
        prompt: '確認ダイアログを「投稿する」で進め、成功メッセージが出るまで待ってから Enter。',
        ms: 9000,
      },

      // 予約投稿（scriptapp と組み合わせた自動投稿）
      { kind: 'highlight', selector: '#sysPostHour' },
      {
        kind: 'caption',
        ms: 11000,
        text: 'A teacher who wants this every day can set a posting time here. That schedule is a trigger in their own account, and it posts only to the course they selected. Leaving the field empty removes it.',
      },

      { kind: 'goto', url: 'https://classroom.google.com/' },
      {
        kind: 'manual',
        prompt: [
          '撮影用テストクラスを開き、ストリームに投稿された2件のお知らせを表示してください。',
          '  1. 「明日の予定」のお知らせ',
          '  2. 学級通信の PDF が添付されたお知らせ（添付を開いて中身も見せると強い）',
          '終わったら Enter。',
        ].join('\n'),
        ms: 20000,
      },
      {
        kind: 'caption',
        ms: 12000,
        text: 'Here are both announcements in Google Classroom, in the teacher’s own course. The app posts only to the course the teacher chose, and only when the teacher asks for it or schedules it themselves.',
      },
      {
        kind: 'note',
        text: '実在クラスには絶対に投稿しない。撮影用テストクラスを使うこと',
      },
    ],
  },

  // ---------------------------------------------------------------- シーン10
  // script.scriptapp は「トリガーが実際にアカウントへ登録される」ところまで見せる。
  // シーン8・9 で作った2つのトリガーがここに並ぶ順番にしてある。
  {
    id: 'script-triggers',
    title: '自動実行の登録と解除 = script.scriptapp',
    scopes: ['script.scriptapp'],
    steps: [
      { kind: 'goto', url: '{{APP_URL}}' },
      { kind: 'click', selector: 'header .nav-btn[data-view="settings"]' },
      { kind: 'expect', selector: '#view-settings.active' },
      { kind: 'highlight', selector: '#triggerList' },
      {
        kind: 'caption',
        ms: 11000,
        text: 'The script.scriptapp scope schedules work in the teacher’s own account. This panel lists every trigger the app has created there.',
      },
      { kind: 'wait', ms: 3000 },
      {
        kind: 'caption',
        ms: 14000,
        text: 'The daily reminder and the Classroom posting time we just set now appear here, next to the nightly job that cleans up triggers which are no longer needed. Importing a PDF adds a short-lived trigger to this list too, and it removes itself when the import finishes.',
      },
      { kind: 'wait', ms: 3000 },
      {
        kind: 'manual',
        prompt: [
          '「解除」を押し、確認ダイアログで解除してください。',
          '一覧からその自動実行が消えることを見せます（削除がアカウント側に反映される証明）。',
          '終わったら Enter。',
        ].join('\n'),
        ms: 12000,
      },
      {
        kind: 'caption',
        ms: 12000,
        text: 'Deleting it here removes the trigger from the teacher’s account immediately, as the list confirms. Teachers can see and remove every scheduled job the app created, and the app creates none that are not listed.',
      },
      {
        kind: 'note',
        text: 'PDF取り込みを実演した直後にこの画面を開くと、バックグラウンド用の一時トリガーも一覧に出る（時間があれば撮る）',
      },
    ],
  },

  // ---------------------------------------------------------------- シーン11
  {
    id: 'summary',
    title: 'まとめ',
    scopes: [],
    steps: [
      { kind: 'goto', url: '{{APP_URL}}' },
      { kind: 'expect', selector: '#view-plan.active' },
      {
        kind: 'caption',
        ms: 16000,
        text: 'To summarize: School Plan Note keeps each teacher’s lesson plan in one spreadsheet it created, creates and deletes only its own files in Drive or the ones the teacher picked, sends a reminder to the signed-in teacher alone, schedules that work in the teacher’s own account where they can remove it, and posts to the teacher’s own Classroom course when they ask.',
      },
      {
        kind: 'caption',
        ms: 8000,
        text: 'All requested scopes are used only for these purposes, as described in our privacy policy.',
      },
      { kind: 'caption', ms: 4000, text: 'Thank you for reviewing our application.' },
    ],
  },
];

/** appsscript.json の oauthScopes と、それを実演するシーンの対応表 */
export const SCOPE_COVERAGE = {
  'https://www.googleapis.com/auth/drive.file': 'drive.file',
  'https://www.googleapis.com/auth/script.scriptapp': 'script.scriptapp',
  'https://www.googleapis.com/auth/script.external_request': 'script.external_request',
  'https://www.googleapis.com/auth/script.send_mail': 'script.send_mail',
  'https://www.googleapis.com/auth/userinfo.email': 'userinfo.email',
  'https://www.googleapis.com/auth/classroom.courses.readonly': 'classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.announcements': 'classroom.announcements',
};
