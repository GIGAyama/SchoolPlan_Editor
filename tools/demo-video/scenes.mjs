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
    id: 'container-ui',
    title: 'スプレッドシートとカスタムメニュー',
    scopes: ['script.container.ui'],
    steps: [
      { kind: 'goto', url: '{{SHEET_URL}}' },
      {
        kind: 'caption',
        ms: 8000,
        text: 'Each teacher owns a single Google Spreadsheet that stores their own lesson plan data.',
      },
      {
        kind: 'manual',
        prompt: 'スプレッドシートのメニュー「週案ツール」を開いて、項目が見える状態で3秒静止してください。',
        ms: 12000,
      },
      {
        kind: 'caption',
        ms: 6000,
        text: 'The add-on menu is provided by the script.container.ui scope.',
      },
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
          '次の順に、カットせず一続きで操作してください:',
          '  1. デモ用アカウントでログイン',
          '  2. 同意画面が出たら、アドレスバーの client_id= が読める状態で3秒以上静止',
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
        text: 'The application requests the following scopes: Google Sheets, Drive file access, Classroom courses read-only, Classroom announcements, sending email on the user’s behalf, and the user’s email address.',
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
    title: '週案の入力 = spreadsheets',
    scopes: ['spreadsheets'],
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
      { kind: 'goto', url: '{{SHEET_URL}}' },
      {
        kind: 'caption',
        ms: 10000,
        text: 'We use the spreadsheets scope only to read and write this single database file, which is owned by the teacher. We never access any other spreadsheet.',
      },
      {
        kind: 'note',
        text: '同じ内容がシート側に書き込まれていることを画面で確認できるまで静止する',
      },
      { kind: 'wait', ms: 4000 },
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
        ms: 8000,
        text: 'The API key is stored per user in Apps Script properties and is never shared.',
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
          '宛先が「ログイン中のアカウント自身」であることが読める状態で静止します。',
          '（他のメールが映らないよう、あらかじめ検索で絞り込んでおいてください）',
        ].join('\n'),
        ms: 0,
      },
      {
        kind: 'caption',
        ms: 8000,
        text: 'As you can see, the email is delivered to the account that is signed in. We never email anyone else.',
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
  'https://www.googleapis.com/auth/spreadsheets': 'spreadsheets',
  'https://www.googleapis.com/auth/drive.file': 'drive.file',
  'https://www.googleapis.com/auth/script.container.ui': 'script.container.ui',
  'https://www.googleapis.com/auth/script.scriptapp': 'script.scriptapp',
  'https://www.googleapis.com/auth/script.external_request': 'script.external_request',
  'https://www.googleapis.com/auth/script.send_mail': 'script.send_mail',
  'https://www.googleapis.com/auth/userinfo.email': 'userinfo.email',
  'https://www.googleapis.com/auth/classroom.courses.readonly': 'classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.announcements': 'classroom.announcements',
};
