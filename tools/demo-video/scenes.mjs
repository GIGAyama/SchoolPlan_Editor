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
 *   fill      セレクタへ入力（1文字ずつ打つので画面で読める）
 *   dblclick  セレクタをダブルクリック（週案セルの編集モード）
 *   highlight セレクタを枠線で強調して視線を誘導する
 *   expect    セレクタが表示されるまで待つ（出なければ失敗として記録）
 *   wait      指定ミリ秒だけ止まる
 *   manual    人の操作を待つ（Google ログインなど自動化できない箇所）
 *   note      操作しないが記録に残すメモ（撮影後の確認用）
 *
 * セレクタに dynamic: true を付けたステップは、
 * verify-scenes.mjs のオフライン検証（JSで動的生成される要素）から除外されます。
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
    title: 'アプリ紹介・ポリシー',
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
      { kind: 'goto', url: '{{PRIVACY_URL}}' },
      {
        kind: 'caption',
        ms: 6000,
        text: 'This is our privacy policy — the same URL submitted in this verification request.',
      },
      { kind: 'goto', url: '{{TERMS_URL}}' },
      { kind: 'caption', ms: 5000, text: 'And these are our terms of service.' },
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
        text: 'The application requests the following scopes: per-file Drive access, Classroom courses read-only, Classroom announcements, sending email on the user’s behalf, and the user’s email address.',
      },
      {
        kind: 'caption',
        ms: 6000,
        text: 'Each of these scopes is demonstrated in the following sections of this video.',
      },
      { kind: 'expect', selector: '#view-plan.active' },
    ],
  },

  // ---------------------------------------------------------------- シーン4
  {
    id: 'spreadsheets',
    title: '週案の入力（データベースの読み書き） = drive.file',
    scopes: ['drive.file'],
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
        kind: 'caption',
        ms: 8000,
        text: 'The data is written to the teacher’s own spreadsheet, shown here.',
      },
      { kind: 'wait', ms: 2500 },
      { kind: 'highlight', selector: '#tenantDbName', optional: true },

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
          '続けて、そのタスクを削除してください（行がごみ箱シートへ移ります）。',
          '終わったら Enter を押してください。',
        ].join('\n'),
        ms: 0,
      },
      {
        kind: 'caption',
        ms: 10000,
        text: 'Creating and deleting a task writes to, and removes rows from, the same spreadsheet. Deleted rows are moved to a recycle-bin sheet inside the same file.',
      },

      { kind: 'goto', url: '{{SHEET_URL}}' },
      {
        kind: 'caption',
        ms: 11000,
        text: 'Here is the teacher’s spreadsheet in their own Google account, showing exactly the changes made in the app a moment ago.',
      },
      {
        kind: 'manual',
        prompt: [
          'スプレッドシート側で次を順に見せてください（source account impact の証明）。',
          '  1. 週案シート … いま入力したセルが書き込まれている',
          '  2. タスクシート … 追加した行と、削除で減った行',
          '  3. ごみ箱シート … 削除した行がここへ移っている',
          'シート下部のタブを切り替えながら、各3秒以上静止します。終わったら Enter。',
        ].join('\n'),
        ms: 0,
      },
      {
        kind: 'caption',
        ms: 11000,
        text: 'We hold no spreadsheets scope. This file is read and written through the drive.file scope, because the app created it. We cannot open any other spreadsheet.',
      },
      { kind: 'wait', ms: 3000 },
      { kind: 'goto', url: '{{APP_URL}}' },
      { kind: 'expect', selector: '#view-plan.active' },
    ],
  },

  // ---------------------------------------------------------------- シーン5
  {
    id: 'external-request',
    title: 'Gemini による生成 = script.external_request',
    scopes: ['script.external_request'],
    steps: [
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
        ms: 8000,
        text: 'This external HTTPS request requires the script.external_request scope.',
      },
      {
        kind: 'manual',
        prompt: 'AI一括生成のダイアログを進め、本文が挿入されるまで待ってから Enter を押してください。',
        ms: 0,
      },
      {
        kind: 'caption',
        ms: 9000,
        text: 'The API key is supplied and stored by each teacher in their own Apps Script user properties. We never receive it.',
      },

      // 送信先を網羅して示す。「外部通信＝Gemini だけ」ではないことを先に明かしておく。
      { kind: 'goto', url: '{{APP_URL}}' },
      { kind: 'click', selector: 'header .nav-btn[data-view="settings"]' },
      { kind: 'expect', selector: '#view-settings.active' },
      { kind: 'highlight', selector: '#geminiTierNotice' },
      {
        kind: 'caption',
        ms: 12000,
        text: 'This is every outbound request the app makes: the Gemini API for the AI features, the Google Drive and Google Sheets REST APIs to handle the files it creates, and a public holiday calendar file published by the Japanese government.',
      },
      {
        kind: 'caption',
        ms: 11000,
        text: 'We require a paid-tier Gemini key, shown in this notice, because free-tier content may be used to improve Google’s models — which our Limited Use commitment does not allow.',
      },
      { kind: 'wait', ms: 3000 },
      {
        kind: 'note',
        text: '祝日CSVの取得（年間カレンダー生成）を撮る場合はここで実演する。デモ用DBでのみ行うこと',
      },
    ],
  },

  // ---------------------------------------------------------------- シーン6
  {
    id: 'drive-file',
    title: '学級通信の PDF 出力 = drive.file',
    scopes: ['drive.file'],
    steps: [
      {
        kind: 'caption',
        ms: 5000,
        text: 'The newsletter is exported as a PDF file.',
      },
      { kind: 'click', selector: '.nw-header-actions .btn-primary' },
      {
        kind: 'manual',
        prompt: 'PDF が生成され、プレビューが表示されるまで待ってから Enter を押してください。',
        ms: 0,
      },
      {
        kind: 'caption',
        ms: 7000,
        text: 'We request the drive.file scope, not full Drive access.',
      },
      { kind: 'goto', url: 'https://drive.google.com/drive/recent' },
      {
        kind: 'caption',
        ms: 11000,
        text: 'This means the app can only see and manage files it creates itself, such as this PDF — it cannot read any of the teacher’s other Drive files.',
      },
      { kind: 'wait', ms: 4000 },
      { kind: 'goto', url: '{{APP_URL}}' },
      { kind: 'expect', selector: '#view-plan.active' },
    ],
  },

  // ---------------------------------------------------------------- シーン7
  {
    id: 'mail-reminder',
    title: 'メールリマインダー = script.send_mail + userinfo.email + script.scriptapp',
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
        text: 'The script.send_mail scope is used to send this reminder, and userinfo.email is used to identify the signed-in teacher so the reminder is sent to that same teacher only.',
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
        ms: 0,
      },
      {
        kind: 'caption',
        ms: 12000,
        text: 'Here is the message in the signed-in teacher’s own Gmail inbox. The To field is that same teacher. The app has no recipient list, no other addresses, and cannot read any mail — it only sends this one reminder.',
      },
    ],
  },

  // ---------------------------------------------------------------- シーン7-2
  // script.scriptapp は「トリガーが実際にアカウントへ登録される」ところまで見せる。
  // 設定タブの「自動実行（トリガー）の状況」が、その source account impact にあたる。
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
        text: 'The script.scriptapp scope is used to schedule work in the teacher’s own account. This panel lists every trigger the app has created there.',
      },
      { kind: 'wait', ms: 3000 },
      {
        kind: 'caption',
        ms: 10000,
        text: 'The daily reminder we just enabled now appears here as a scheduled trigger, together with the nightly job that cleans up triggers which are no longer needed.',
      },
      { kind: 'wait', ms: 3000 },
      {
        kind: 'manual',
        prompt: [
          '「解除」を押し、確認ダイアログで解除してください。',
          '一覧からその自動実行が消えることを見せます（削除がアカウント側に反映される証明）。',
          '終わったら Enter。',
        ].join('\n'),
        ms: 0,
      },
      {
        kind: 'caption',
        ms: 11000,
        text: 'Deleting it here removes the trigger from the teacher’s account immediately, as the list confirms. Teachers can see and remove every scheduled job the app created.',
      },
      {
        kind: 'note',
        text: 'PDF取り込みを実演した直後にこの画面を開くと、バックグラウンド用の一時トリガーも一覧に出る（時間があれば撮る）',
      },
    ],
  },

  // ---------------------------------------------------------------- シーン8
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
        ms: 0,
      },
      { kind: 'clickText', text: '明日の予定を投稿', within: '#view-settings' },
      {
        kind: 'caption',
        ms: 9000,
        text: 'When the teacher clicks this button, the app posts the schedule to the selected course as an announcement.',
      },
      {
        kind: 'caption',
        ms: 6000,
        text: 'This is what the classroom.announcements scope is used for.',
      },
      { kind: 'goto', url: 'https://classroom.google.com/' },
      {
        kind: 'manual',
        prompt: '撮影用テストクラスを開き、ストリームに投稿されたお知らせを表示してください。',
        ms: 0,
      },
      {
        kind: 'caption',
        ms: 11000,
        text: 'Here is the announcement in Google Classroom. The teacher always initiates the post — the app never posts without an explicit action by the teacher.',
      },
    ],
  },

  // ---------------------------------------------------------------- シーン9
  {
    id: 'summary',
    title: 'まとめ',
    scopes: [],
    steps: [
      { kind: 'goto', url: '{{APP_URL}}' },
      { kind: 'expect', selector: '#view-plan.active' },
      {
        kind: 'caption',
        ms: 15000,
        text: 'To summarize: School Plan Note stores each teacher’s lesson plan in their own spreadsheet, exports newsletters as PDF files it creates itself, sends reminders only to the signed-in teacher, and posts announcements to the teacher’s own Classroom course when the teacher chooses to.',
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
