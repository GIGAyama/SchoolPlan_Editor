/**
 * @fileoverview 行事予定PDF・指導計画PDFを読み取り、非同期処理・APIを利用してスプレッドシートに反映する処理群
 */

/** 
 * 行事予定PDFをフォルダから読み込みます（UI起点）。
 */
function importEventsFromFolder_UI() {
  const ui = SpreadsheetApp.getUi();
  try {
    // 設定はスクリプトプロパティ経由で取得
    const folderId = getSetting(SP_KEY_EVENT_PDF_FOLDER_ID);
    if (!folderId) throw new Error(`行事予定PDFフォルダIDが未設定です。設定ダッシュボードから設定してください。`);

    const yearResponse = ui.prompt('年度の入力', '処理対象の年度（4月始まり）を西暦で入力してください。\n例: 2025', ui.ButtonSet.OK_CANCEL);
    if (yearResponse.getSelectedButton() !== ui.Button.OK || !yearResponse.getResponseText()) {
      ui.alert('処理をキャンセルしました。');
      return;
    }
    const fiscalYear = parseInt(yearResponse.getResponseText().trim(), 10);

    const folder = DriveApp.getFolderById(folderId);
    const files = folder.getFilesByType(MimeType.PDF);
    const fileIds = [];
    while (files.hasNext()) {
      fileIds.push(files.next().getId());
    }
    if (fileIds.length === 0) {
      throw new Error(`指定されたフォルダ「${folder.getName()}」にPDFファイルが見つかりませんでした。`);
    }

    const today = new Date();
    const firstDayOfCurrentMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    
    const allMonths = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3]; // 年度内の全ての月
    const monthsToProcess = allMonths.filter(month => {
      const yearForMonth = (month >= 4) ? fiscalYear : fiscalYear + 1;
      const firstDayOfMonth = new Date(yearForMonth, month - 1, 1);
      return firstDayOfMonth >= firstDayOfCurrentMonth;
    });

    if (monthsToProcess.length === 0) {
      ui.alert('処理対象となる月（今月以降）がありませんでした。');
      return;
    }
    
    const processingQueue = [];
    fileIds.forEach(fileId => {
      monthsToProcess.forEach(month => {
        processingQueue.push({ fileId: fileId, month: month });
      });
    });

    const confirmResponse = ui.alert('処理の開始', 
      `${fileIds.length} 個のPDFファイルから、**${monthsToProcess.join('月, ')}月**の予定を読み込みます。（合計 ${processingQueue.length} タスク）\n` +
      `処理はバックグラウンドで自動的に中断・再開されます。\n\n` +
      `実行しますか？`, 
      ui.ButtonSet.YES_NO);
    if (confirmResponse !== ui.Button.YES) {
      ui.alert('処理をキャンセルしました。');
      return;
    }

    resetEventPdfProcessing(); 

    const properties = PropertiesService.getScriptProperties();
    properties.setProperty(SCRIPT_PROP_EVENT_PDF_QUEUE, JSON.stringify(processingQueue));
    properties.setProperty(SCRIPT_PROP_EVENT_PDF_TOTAL, processingQueue.length);
    properties.setProperty(SCRIPT_PROP_EVENT_PDF_YEAR, fiscalYear.toString());

    ss.toast(`行事予定PDFの読み込みを開始しました。(0/${processingQueue.length})`, '処理開始', -1);
    
    ScriptApp.newTrigger(TRIGGER_FUNCTION_NAME_EVENT).timeBased().after(1000).create();

  } catch (e) {
    logError("importEventsFromFolder_UI", e);
    ui.alert(`エラーが発生しました。\n\n詳細: ${e.message}\n\n「ログ」シートもご確認ください。`);
  }
}

/** 
 *  [トリガー] 行事予定PDF処理
 */
function processNextEventPdf() {
  const startTime = new Date();
  const properties = PropertiesService.getScriptProperties();
  
  const queueJson = properties.getProperty(SCRIPT_PROP_EVENT_PDF_QUEUE);
  const year = properties.getProperty(SCRIPT_PROP_EVENT_PDF_YEAR);

  if (!queueJson || !year) {
    SpreadsheetApp.getActiveSpreadsheet().toast("行事予定PDFの読み込みがすべて完了しました。", "処理完了", 10);
    logInfo("すべての行事予定PDFの処理が完了しました。");
    resetEventPdfProcessing();
    return;
  }

  const queue = JSON.parse(queueJson);
  if (queue.length === 0) {
    SpreadsheetApp.getActiveSpreadsheet().toast("行事予定PDFの読み込みがすべて完了しました。", "処理完了", 10);
    logInfo("キューが空です。すべての行事予定PDFの処理が完了しました。");
    resetEventPdfProcessing();
    return;
  }
  
  const task = queue.shift(); 
  const file = DriveApp.getFileById(task.fileId);
  
  const totalTasks = parseInt(properties.getProperty(SCRIPT_PROP_EVENT_PDF_TOTAL), 10);
  const processedCount = totalTasks - queue.length;
  SpreadsheetApp.getActiveSpreadsheet().toast(`行事予定PDF 処理中... (${processedCount}/${totalTasks})\nファイル名: ${file.getName()} (${task.month}月)`, `処理中`, -1);

  try {
    processEventPdf(task.fileId, year, task.month);
  } catch (e) {
    logError(`行事予定PDFの処理中にエラーが発生しました: ${file.getName()} (${task.month}月)`, e);
    SpreadsheetApp.getActiveSpreadsheet().toast(`⚠ エラー: ${file.getName()} (${task.month}月) - ${e.message}`, 'PDF処理エラー', 15);
  }

  properties.setProperty(SCRIPT_PROP_EVENT_PDF_QUEUE, JSON.stringify(queue));

  const executionTime = (new Date() - startTime) / 1000;
  deleteTriggers_(TRIGGER_FUNCTION_NAME_EVENT);

  if (queue.length > 0) {
    if (executionTime < 300) { 
      ScriptApp.newTrigger(TRIGGER_FUNCTION_NAME_EVENT).timeBased().after(1000).create();
    } else {
      logInfo(`時間切れのため行事予定PDFの処理を中断・再開します。残り: ${queue.length} タスク`);
      ScriptApp.newTrigger(TRIGGER_FUNCTION_NAME_EVENT).timeBased().everyMinutes(5).create();
    }
  } else {
    SpreadsheetApp.getActiveSpreadsheet().toast("行事予定PDFの読み込みがすべて完了しました。", "処理完了", 10);
    logInfo("すべての行事予定PDFの処理が完了しました。");
    resetEventPdfProcessing();
  }
}

/** 
 * AIが抽出した行事予定をDBに書き込みます
 */
function processEventPdf(fileId, year, month) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
    const apiKey = getApiKey_();
    const schoolYear = parseInt(year, 10);

    const prompt = `あなたは日本の学校の行事予定を整理する専門家です。
添付されたPDFファイルは、ある学校の ${schoolYear} 年度（ ${schoolYear} 年4月～ ${schoolYear + 1} 年3月）の行事予定表です。
このPDFの中から、「${month}月」に関する予定だけを抽出し、以下のルールに従ってJSON形式の配列で出力してください。
# 抽出ルール
1.  日付の特定:
    - ${month}月の日付と予定のみを抽出してください。他の月の情報は無視してください。
    - ${schoolYear} 年度なので、4月～12月は ${schoolYear} 年、1月～3月は ${schoolYear + 1} 年として日付を生成してください。
    - 最終的な日付は必ず "YYYY-MM-DD" 形式にしてください。
2.  内容の分類:
    - 児童生徒が関わる学校行事（例：始業式, 遠足, 運動会, 委員会, クラブ）は、typeを "event" としてください。
    - 教職員のみが関わる予定（例：会議, 研修, 出張, 初任研, 三部会）は、typeを "meeting" としてください。
3.  複数予定の分割: 1つの日付に複数の予定がある場合は、それぞれ別のオブジェクトとしてください。
# 出力形式 (JSON配列)
[
  { "date": "YYYY-MM-DD", "content": "（${month}月の予定の内容）", "type": "event" },
  { "date": "YYYY-MM-DD", "content": "（${month}月の予定の内容）", "type": "meeting" }
]`;
    const buildContinuation = (collected) => {
      const items = collected.map(e => `${e.date}: ${e.content}`).join(', ');
      return `${prompt}

【重要な追加指示】
前回のリクエストで出力がトークン上限に達し、途中で切れてしまいました。
以下の ${collected.length} 件の予定は既に取得済みです:
${items}

上記の予定は絶対に出力しないでください。まだ出力されていない残りの予定のみを、同じJSON配列形式で出力してください。`;
    };

    const extractedEvents = callGeminiApiChunked_(prompt, apiKey, [blob], buildContinuation);
    if (!extractedEvents || !Array.isArray(extractedEvents)) {
      logError(`PDF「${file.getName()}」の${month}月: Gemini APIから配列形式のレスポンスが得られませんでした。`, new Error(`レスポンス型: ${typeof extractedEvents}`));
      throw new Error(`PDF「${file.getName()}」の${month}月からデータを抽出できませんでした。APIレスポンスが不正です。`);
    }
    if (extractedEvents.length === 0) {
      logInfo(`PDF「${file.getName()}」の${month}月からは、有効な予定が見つかりませんでした。`);
      return "0 件の予定を転記しました。";
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const dbSheet = ss.getSheetByName(SHEET_NAME_DATABASE);
    
    // パフォーマンス改善：DBシートを配列として取得
    const dbCols = getDbColumns();
    const dbData = dbSheet.getDataRange().getValues();
    const dateMap = new Map();
    for(let i = 1; i < dbData.length; i++){
      if(dbData[i][dbCols.DATE - 1] instanceof Date){
        dateMap.set(formatDate(dbData[i][dbCols.DATE - 1]), i); // array index
      }
    }
    
    let updatedCount = 0;
    let pastDateSkippedCount = 0;
    let duplicateSkippedCount = 0; 
    let isDbModified = false;

    extractedEvents.forEach(item => {
      if (!item.date || !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !item.content) return;
      
      const targetDate = new Date(item.date.replace(/-/g, '/'));
      targetDate.setHours(0, 0, 0, 0);
      const targetDateStr = formatDate(targetDate);

      if (dateMap.has(targetDateStr)) {
        if (targetDate >= today) {
          const rowIdx = dateMap.get(targetDateStr);
          let targetCol;
          if (item.type === 'event') {
            targetCol = dbCols.EVENT;
          } else if (item.type === 'meeting') {
            targetCol = dbCols.AFTERSCHOOL;
          }

          if (targetCol) {
             const currentValue = (dbData[rowIdx][targetCol - 1] || "").toString();
             const newContent = item.content.toString().trim();
             if (!currentValue.includes(newContent)) {
                 dbData[rowIdx][targetCol - 1] = currentValue ? `${currentValue}\n${newContent}` : newContent;
                 updatedCount++;
                 isDbModified = true;
             } else {
                 duplicateSkippedCount++;
             }
          }
        } else {
          pastDateSkippedCount++; 
        }
      }
    });

    if(isDbModified){
         dbSheet.getDataRange().setValues(dbData);
    }

    let logMessage = `${updatedCount} 件の予定をPDF「${file.getName()}」(${month}月分)から転記。`;
    if (pastDateSkippedCount > 0) logMessage += ` ${pastDateSkippedCount} 件(過去),`;
    if (duplicateSkippedCount > 0) logMessage += ` ${duplicateSkippedCount} 件(重複)はスキップ。`;
    logInfo(logMessage);
    
    let resultMessage = `${updatedCount} 件の予定を転記しました。`;
    const skippedMessages = [];
    if (pastDateSkippedCount > 0) skippedMessages.push(`${pastDateSkippedCount} 件は過去`);
    if (duplicateSkippedCount > 0) skippedMessages.push(`${duplicateSkippedCount} 件は重複`);
    if (skippedMessages.length > 0) resultMessage += ` (${skippedMessages.join(', ')}のためスキップ)`;
    return resultMessage;
    
  } catch (e) {
    logError(`processEventPdf (${month}月分)`, e);
    throw new Error(e.message);
  }
}

/** 
 * 指導計画PDFの読込（UI起点）
 */
function createUnitMasterFromPdfs_UI() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert( '指導計画PDFの読み込み', '設定で指定されたフォルダ内のPDFをAIが読み取り、「単元マスタ」シートを作成・更新します。\n' + '処理はバックグラウンドで自動的に中断・再開され、完了まで数分～数十分かかる場合があります。\n\n' + '実行しますか？', ui.ButtonSet.YES_NO );
  if (response == ui.Button.YES) {
    resetUnitMasterProcessing();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    // 設定はスクリプトプロパティ経由で取得
    const folderId = getSetting(SP_KEY_PDF_FOLDER_ID);
    if (!folderId) {
      ui.alert('指導計画PDFフォルダIDが未設定です。設定ダッシュボードから設定してください。');
      return;
    }
    const folder = DriveApp.getFolderById(folderId);
    const files = folder.getFilesByType(MimeType.PDF);
    const fileIds = [];
    while (files.hasNext()) { fileIds.push(files.next().getId()); }
    if (fileIds.length === 0) {
      ui.alert("指定されたフォルダにPDFファイルが見つかりませんでした。");
      return;
    }
    
    const properties = PropertiesService.getScriptProperties();
    properties.setProperty(SCRIPT_PROP_PDF_QUEUE, JSON.stringify(fileIds));
    properties.setProperty(SCRIPT_PROP_PDF_TOTAL, fileIds.length);
    
    let masterSheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
    if (!masterSheet) {
        masterSheet = ss.insertSheet(SHEET_NAME_UNIT_MASTER);
        masterSheet.getRange("A1:E1").setValues([["教科", "単元名", "総時間数", "何時間目", "時間ごとの学習活動"]]).setFontWeight("bold");
    }
    ss.toast(`PDF読み込み処理を開始しました。(0/${fileIds.length})`, '処理開始', -1);
    
    ScriptApp.newTrigger(TRIGGER_FUNCTION_NAME).timeBased().after(1000).create();
  }
}

/** 
 *  [トリガー] 指導計画PDFの処理
 */
function createUnitMasterFromPdfs() {
  const startTime = new Date();
  const properties = PropertiesService.getScriptProperties();
  const queueJson = properties.getProperty(SCRIPT_PROP_PDF_QUEUE);

  if (!queueJson) {
    logInfo("すべてのPDF処理が完了しました。");
    SpreadsheetApp.getActiveSpreadsheet().toast("PDFの読み込みがすべて完了しました。", "処理完了", 10);
    resetUnitMasterProcessing();
    return;
  }
  const fileIds = JSON.parse(queueJson);
  if (fileIds.length === 0) {
    logInfo("キューが空です。すべてのPDF処理が完了しました。");
    SpreadsheetApp.getActiveSpreadsheet().toast("PDFの読み込みがすべて完了しました。", "処理完了", 10);
    resetUnitMasterProcessing();
    return;
  }

  const totalFiles = parseInt(properties.getProperty(SCRIPT_PROP_PDF_TOTAL), 10);
  const fileId = fileIds.shift();
  const file = DriveApp.getFileById(fileId);
  const processedCount = totalFiles - fileIds.length;
  SpreadsheetApp.getActiveSpreadsheet().toast(`PDF処理中... (${processedCount}/${totalFiles}) \nファイル名: ${file.getName()}`, `処理中`, -1);
  
  try {
    processSinglePdf(file);
  } catch (e) {
    logError(`PDF処理中に致命的なエラーが発生しました: ${file.getName()}`, e);
    SpreadsheetApp.getActiveSpreadsheet().toast(`⚠ エラー: ${file.getName()} - ${e.message}`, 'PDF処理エラー', 15);
  }
  properties.setProperty(SCRIPT_PROP_PDF_QUEUE, JSON.stringify(fileIds));
  
  const executionTime = (new Date() - startTime) / 1000 / 60;
  deleteTriggers_(TRIGGER_FUNCTION_NAME);
  
  if (fileIds.length > 0) {
    if (executionTime < 5) {
      ScriptApp.newTrigger(TRIGGER_FUNCTION_NAME).timeBased().after(1000).create();
    } else {
      logInfo(`時間切れのため処理を中断・再開します。残り: ${fileIds.length}件`);
      ScriptApp.newTrigger(TRIGGER_FUNCTION_NAME).timeBased().everyMinutes(5).create();
    }
  } else {
    logInfo("すべてのPDF処理が完了しました。");
    SpreadsheetApp.getActiveSpreadsheet().toast("PDFの読み込みがすべて完了しました。", "処理完了", 10);
    resetUnitMasterProcessing();
  }
}

/** 
 * 1つの指導計画PDFファイルを処理して「単元マスタ」に追記します
 */
function processSinglePdf(file) {
  const masterSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_UNIT_MASTER);
  const apiKey = getApiKey_();
  const grade = PropertiesService.getScriptProperties().getProperty(SCRIPT_PROP_GRADE) || '';
  const gradeContext = grade ? `対象学年は${grade}です。` : '';
  const prompt = `あなたは日本の小学校教育の専門家です。添付された年間指導計画のPDFから、以下の情報を抽出し、指定されたJSON形式で出力してください。
このPDFは複数ページにわたる長いものである可能性があります。すべてのページを注意深く読み取り、すべての単元を抽出してください。
${gradeContext}

抽出項目:
1.  **subject**: 教科名（例：国語, 算数）
2.  **unitName**: 単元名や題材名
3.  **totalHours**: その単元に配当されている合計時間数（半角数字）
4.  **hourlyActivities**: その単元の、時間ごとの学習活動のリスト。
    - **hour**: 何時間目かを示す半角数字。
    - **activity**: その時間の学習活動を、以下のルールに従って構造的に記述してください。

## activityの記述ルール
週案を見ただけで授業の流れが把握できるよう、以下の形式で改行（\\n）を使って構造的に記載してください。
ただし、全体で100〜150文字程度に収め、冗長にならないようにしてください。

### 形式
（めあて）1行目にその時間のめあてを簡潔に書く
（学習活動）・（中黒）で始まる箇条書きで主な活動を2〜3項目
（準備物）教師の準備物や児童の持ち物がある場合のみ、末尾に▶で記載

### 記述例
"めあて：物語の場面構成を捉えよう\\n・全文を通読し初発の感想を書く\\n・場面分けをして構成を整理する\\n▶ワークシート"
"めあて：1Lより小さいかさの表し方を考えよう\\n・dLの単位を知り水のかさを量る\\n・dLを使って身の回りの容器のかさを調べる\\n▶1Lます・水筒（児童）"
"めあて：春の生き物を観察しよう\\n・校庭で春の植物や昆虫を観察する\\n・観察カードに記録をまとめる\\n▶観察カード・虫めがね（児童）"

### 注意事項
- PDFに準備物や持ち物の情報がない場合は、あなたの教育の専門知識をもとに、その授業で一般的に必要と考えられるものを補完してください。ただし、特に必要ないと判断した時間には▶行を付けなくて構いません。
- めあては指導要領の目標に沿った具体的な文言にしてください。
- 学習活動は動詞で終わる簡潔な表現にしてください（例：「〜する」「〜を調べる」）。

出力は、必ず単一の有効なJSON配列としてください。途中で途切れたり、フォーマットが崩れたりしないようにしてください。
出力形式（JSON配列）:
[
  {
    "subject": "教科名",
    "unitName": "単元名1",
    "totalHours": 8,
    "hourlyActivities": [
      { "hour": 1, "activity": "めあて：〜\\n・〜\\n・〜\\n▶準備物" },
      { "hour": 2, "activity": "めあて：〜\\n・〜\\n・〜" }
    ]
  }
]`;
  logInfo(`PDF処理中: ${file.getName()}`);
  try {
    const blob = file.getBlob();
    const buildContinuation = (collected) => {
      const names = collected.map(u => `「${u.unitName}」`).join(', ');
      return `${prompt}

【重要な追加指示】
前回のリクエストで出力がトークン上限に達し、途中で切れてしまいました。
以下の ${collected.length} 件の単元は既に取得済みです:
${names}

上記の単元は絶対に出力しないでください。まだ出力されていない残りの単元のみを、同じJSON配列形式で出力してください。`;
    };

    const extractedUnits = callGeminiApiChunked_(prompt, apiKey, [blob], buildContinuation);
    if (!extractedUnits || !Array.isArray(extractedUnits)) {
      throw new Error(`PDF「${file.getName()}」からデータを抽出できませんでした。APIレスポンスが不正です（型: ${typeof extractedUnits}）。`);
    }
    if (extractedUnits.length === 0) {
      logInfo(`PDF「${file.getName()}」から単元情報が見つかりませんでした。`);
      return;
    }

    // --- 教科の重複防止: 同じ教科の既存行を削除してから追記 ---
    const newSubjects = new Set();
    extractedUnits.forEach(unit => {
      if (unit.subject) newSubjects.add(unit.subject);
    });

    if (newSubjects.size > 0 && masterSheet.getLastRow() > 1) {
      const lastRow = masterSheet.getLastRow();
      const numDataRows = lastRow - 1;
      const existingData = masterSheet.getRange(2, 1, numDataRows, 5).getValues();
      const rowsToKeep = existingData.filter(row => !newSubjects.has(row[0]));

      masterSheet.getRange(2, 1, numDataRows, 5).clearContent();
      if (rowsToKeep.length > 0) {
        masterSheet.getRange(2, 1, rowsToKeep.length, 5).setValues(rowsToKeep);
      }

      const removedCount = numDataRows - rowsToKeep.length;
      if (removedCount > 0) {
        logInfo(`単元マスタ: 教科「${[...newSubjects].join(', ')}」の既存 ${removedCount} 行を削除し、新しいデータで置換します。`);
      }
    }
    // --- End: 教科の重複防止 ---

    {
      const allRows = [];
      extractedUnits.forEach(unit => {
        if (unit.hourlyActivities && Array.isArray(unit.hourlyActivities)) {
          unit.hourlyActivities.forEach(activity => {
            allRows.push([
              unit.subject || '',
              unit.unitName || '',
              unit.totalHours || '',
              activity.hour || '',
              activity.activity || ''
            ]);
          });
        }
        if (unit.unitName && unit.totalHours > 0) {
            allRows.push([
                unit.subject || '',
                `${unit.unitName} のまとめ`,
                1,
                1,
                "めあて：単元の学習を振り返ろう\n・学習内容の要点を確認する\n・まとめテストやふり返りカードに取り組む"
            ]);
        }
      });
      if (allRows.length > 0) {
        masterSheet.getRange(masterSheet.getLastRow() + 1, 1, allRows.length, allRows[0].length).setValues(allRows);
      }
    }
  } catch (e) {
    logError(`PDF解析エラー: ${file.getName()}`, e);
    throw new Error(`${file.getName()}: ${e.message}`);
  }
}

/** 
 * すべてのPDF処理を強制停止(UI起点)
 */
function resetAllPdfProcessing_UI() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert(
    '処理の強制停止',
    '実行中のすべてのPDF読み込み処理（指導計画・行事予定）を停止し、待機状態を解除します。\nよろしいですか？',
    ui.ButtonSet.YES_NO);
  
  if (response == ui.Button.YES) {
    resetUnitMasterProcessing();
    resetEventPdfProcessing();

    ui.alert('すべてのPDF読み込み処理を停止しました。');
  }
}

function resetUnitMasterProcessing() {
  PropertiesService.getScriptProperties().deleteProperty(SCRIPT_PROP_PDF_QUEUE);
  PropertiesService.getScriptProperties().deleteProperty(SCRIPT_PROP_PDF_TOTAL);
  deleteTriggers_(TRIGGER_FUNCTION_NAME);
  logInfo("指導計画PDF処理のキューとトリガーをリセットしました。");
}

function resetEventPdfProcessing() {
  const properties = PropertiesService.getScriptProperties();
  properties.deleteProperty(SCRIPT_PROP_EVENT_PDF_QUEUE);
  properties.deleteProperty(SCRIPT_PROP_EVENT_PDF_TOTAL);
  properties.deleteProperty(SCRIPT_PROP_EVENT_PDF_YEAR);
  deleteTriggers_(TRIGGER_FUNCTION_NAME_EVENT);
  logInfo("行事予定PDF処理のキューとトリガーをリセットしました。");
}

// ===================================================
// ===== Webアプリ用データ連携 API (Phase 4 Step 2) =====
// ===================================================

/**
 * [Webアプリ API] 指定されたタイプ（'unit' または 'event'）のフォルダ内のPDF一覧を取得します。
 */
function getPdfFileListForWebApp(type) {
  try {
    const spKey = type === 'unit' ? SP_KEY_PDF_FOLDER_ID : SP_KEY_EVENT_PDF_FOLDER_ID;
    const folderId = getSetting(spKey);
    if (!folderId) {
      throw new Error(`フォルダIDが未設定です。ダッシュボードの「Google Drive フォルダ設定」をご確認ください。`);
    }

    const folder = DriveApp.getFolderById(folderId);
    const files = folder.getFilesByType(MimeType.PDF);
    const result = [];
    while (files.hasNext()) {
      const f = files.next();
      result.push({
        id: f.getId(),
        name: f.getName(),
        dateCreated: f.getDateCreated().getTime()
      });
    }
    // 作成日の新しい順にソート
    result.sort((a, b) => b.dateCreated - a.dateCreated);
    return { success: true, files: result };
  } catch (e) {
    logError("getPdfFileListForWebApp", e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 選択された行事予定PDFの読み込み処理を開始します。
 */
function startEventPdfProcessingFromWebApp(fileIds, fiscalYear) {
  try {
    if (!fileIds || fileIds.length === 0) throw new Error("ファイルが選択されていません。");
    if (!fiscalYear) throw new Error("対象年度が指定されていません。");

    resetEventPdfProcessing(); 

    const today = new Date();
    const firstDayOfCurrentMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    
    const allMonths = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3]; // 年度内の全ての月
    const monthsToProcess = allMonths.filter(month => {
      const yearForMonth = (month >= 4) ? fiscalYear : fiscalYear + 1;
      const firstDayOfMonth = new Date(yearForMonth, month - 1, 1);
      return firstDayOfMonth >= firstDayOfCurrentMonth;
    });

    if (monthsToProcess.length === 0) {
      throw new Error('処理対象となる月（今月以降）がありませんでした。');
    }
    
    const processingQueue = [];
    fileIds.forEach(fileId => {
      monthsToProcess.forEach(month => {
        processingQueue.push({ fileId: fileId, month: month });
      });
    });

    const properties = PropertiesService.getScriptProperties();
    properties.setProperty(SCRIPT_PROP_EVENT_PDF_QUEUE, JSON.stringify(processingQueue));
    properties.setProperty(SCRIPT_PROP_EVENT_PDF_TOTAL, processingQueue.length.toString());
    properties.setProperty(SCRIPT_PROP_EVENT_PDF_YEAR, fiscalYear.toString());

    ScriptApp.newTrigger(TRIGGER_FUNCTION_NAME_EVENT)
      .timeBased()
      .after(1000)
      .create();

    return { 
      success: true, 
      message: `${fileIds.length} 個のPDFファイルを利用し、${monthsToProcess.join('月, ')}月の予定を読み込むバッチ処理を開始しました。（合計 ${processingQueue.length} タスク）` 
    };
  } catch(e) {
    logError("startEventPdfProcessingFromWebApp", e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] 選択された指導計画PDFの読み込み処理を開始します。
 */
function startUnitMasterProcessingFromWebApp(fileIds) {
  try {
    if (!fileIds || fileIds.length === 0) throw new Error("ファイルが選択されていません。");

    resetUnitMasterProcessing();

    const properties = PropertiesService.getScriptProperties();
    properties.setProperty(SCRIPT_PROP_PDF_QUEUE, JSON.stringify(fileIds));
    properties.setProperty(SCRIPT_PROP_PDF_TOTAL, fileIds.length.toString());

    const ss = getSs_();
    let masterSheet = ss.getSheetByName(SHEET_NAME_UNIT_MASTER);
    if (!masterSheet) {
        masterSheet = ss.insertSheet(SHEET_NAME_UNIT_MASTER);
        masterSheet.getRange("A1:E1").setValues([["教科", "単元名", "総時間数", "何時間目", "時間ごとの学習活動"]]).setFontWeight("bold");
    }

    ScriptApp.newTrigger(TRIGGER_FUNCTION_NAME)
      .timeBased()
      .after(1000)
      .create();

    return { 
      success: true, 
      message: `${fileIds.length} 個の指導計画PDFファイルを利用し、単元マスタを更新するバッチ処理を開始しました。` 
    };
  } catch(e) {
    logError("startUnitMasterProcessingFromWebApp", e);
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] バッチ処理の現在のステータスを取得します。
 */
function getPdfProcessingStatusForWebApp() {
  try {
    const props = PropertiesService.getScriptProperties();
    
    const eventQueueStr = props.getProperty(SCRIPT_PROP_EVENT_PDF_QUEUE);
    const eventTotalStr = props.getProperty(SCRIPT_PROP_EVENT_PDF_TOTAL);
    let eventStatus = { isRunning: false, remaining: 0, total: 0 };
    if (eventQueueStr) {
      const q = JSON.parse(eventQueueStr);
      eventStatus.isRunning = true;
      eventStatus.remaining = q.length;
      eventStatus.total = parseInt(eventTotalStr || '0', 10);
    }

    const unitQueueStr = props.getProperty(SCRIPT_PROP_PDF_QUEUE);
    const unitTotalStr = props.getProperty(SCRIPT_PROP_PDF_TOTAL);
    let unitStatus = { isRunning: false, remaining: 0, total: 0 };
    if (unitQueueStr) {
      const q = JSON.parse(unitQueueStr);
      unitStatus.isRunning = true;
      unitStatus.remaining = q.length;
      unitStatus.total = parseInt(unitTotalStr || '0', 10);
    }

    return { success: true, eventStatus, unitStatus };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

/**
 * [Webアプリ API] Google Picker を使用するための認証情報（OAuthトークン、必要ならAPIキー）を返します。
 * OAuth 2.0 クライアントのAPIキーまたは設定シート上の情報を利用可能にすることもできます。
 * ここでは最もシンプルに OAuthToken のみを渡し、フロントから Developer Key なし（トークンのみ）で Picker を開く構成を推奨します。
 * （※API Keyなしでも動作する場合があります）
 */
function getPickerAuthInfo() {
  try {
    return {
      success: true,
      token: ScriptApp.getOAuthToken()
    };
  } catch(e) {
    logError("getPickerAuthInfo", e);
    return { success: false, error: e.message };
  }
}
