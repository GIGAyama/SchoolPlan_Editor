/**
 * @fileoverview 基本機能・メニュー関連のメインファイル
 */

/** 
 * スプレッドシートを開いた時にカスタムメニューを追加します。
 */
function onOpen() {
  // Webアプリ用にSPREADSHEET_IDをスクリプトプロパティに自動保存
  try {
    const ssId = SpreadsheetApp.getActiveSpreadsheet().getId();
    PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ssId);
  } catch(e) {}

  // 祝日データの定期取得（プロパティ未設定 or 月1回更新）
  try { fetchAndStoreHolidays(); } catch(e) {}

  const ui = SpreadsheetApp.getUi();
  const menu = ui.createMenu('週案ツール');
  
  menu.addItem('データベース：今日の行を表示', 'TodaysRow')
    .addSeparator()
    .addSubMenu(ui.createMenu('クラスルーム連携')
      .addItem('明日の予定を投稿', 'postScheduleToClassroom')
      .addItem('学級通信を投稿', 'autoPostToClassroom'))
    .addSeparator()
    .addSubMenu(ui.createMenu('その他')
      .addItem('指導計画PDFの読み込み', 'createUnitMasterFromPdfs_UI')
      .addItem('行事予定PDFをフォルダから読込', 'importEventsFromFolder_UI')
      .addSeparator()
      .addItem('登校前タスク列を追加', 'ensurePreClassColumn_UI')
      .addItem('データベースの入力内容をクリア', 'clearDatabaseDataWithConfirmation')
      .addItem('（PDF読込処理を強制停止）', 'resetAllPdfProcessing_UI')
      .addItem('クラス一覧を取得', 'listCoursesToSheet')
      .addItem('DB列等のキャッシュをクリア', 'clearDbColumnsCache')
      .addSeparator()
      .addItem('シート保護を実行', 'protectSheets'));

  menu.addToUi();
}

/** 
 * データベースシートの今日の行を選択します。
 */
function TodaysRow() {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_DATABASE);
    if (!sheet) throw new Error(`シート「${SHEET_NAME_DATABASE}」が見つかりません。`);
    
    const dbCols = getDbColumns();
    const today = new Date();
    // ヘッダー行をスキップしてD列以降のデータを避けるため、日付列だけ取得して高速化する
    const dateValues = sheet.getRange(2, dbCols.DATE, Math.max(1, sheet.getLastRow() - 1)).getValues();
    
    for (let i = 0; i < dateValues.length; i++) {
      const cellValue = dateValues[i][0];
      if (cellValue instanceof Date && isSameDate(cellValue, today)) {
        sheet.setActiveRange(sheet.getRange(i + 2, 1, 1, sheet.getLastColumn()));
        return;
      }
    }
    SpreadsheetApp.getUi().alert("データベースシートに今日の日付が見つかりませんでした。");
  } catch (e) {
    logError("TodaysRow", e);
    SpreadsheetApp.getUi().alert(`エラー: ${e.message}`);
  }
}

