/* eBay Notifier v12.0 — 販売通知 + 在庫シート連携 + 失敗時再配信 */
/*
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  初回セットアップ手順
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  1. USER_EMAIL を自分のライセンスメールアドレスに変更
 *  2. 「デプロイ」→「新しいデプロイ」→ ウェブアプリとして公開
 *  3. スクリプトプロパティに SPREADSHEET_ID を設定
 *  4. アプリの設定画面で GAS URL を入力して保存
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

// ==========================================
// 1. 初期設定（★ 要変更）
// ==========================================
// ご自身のメールアドレス（ライセンス認証に使用しているものをご入力ください）
var USER_EMAIL = 'your-email@example.com';

// Cloud Run の URL（変更不要）
var CLOUD_RUN_URL = 'https://hub-server-56741205878.asia-northeast1.run.app';

function getSheet() {
  var props = PropertiesService.getScriptProperties();
  var spreadsheetId = props.getProperty('SPREADSHEET_ID');
  if (!spreadsheetId) throw new Error('SPREADSHEET_ID が未設定です');
  return SpreadsheetApp.openById(spreadsheetId).getSheets()[0];
}

// ==========================================
// 2. メイン受信処理（doPost）
// ==========================================
function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var payload = null;

  if (e.postData && e.postData.contents) {
    try { payload = JSON.parse(e.postData.contents); } catch (x) { payload = null; }
  }

  // -----------------------------------------------
  // A. LINE Bot → ユーザーIDを返信
  // -----------------------------------------------
  if (payload && payload.events) {
    return handleLineReply(payload.events);
  }

  // -----------------------------------------------
  // B. アプリから在庫データ同期 → シートに書き込み
  // -----------------------------------------------
  if (payload && payload.action === 'sync_inventory') {
    writeToSheet(payload);
    return ContentService.createTextOutput(
      JSON.stringify({ status: 'success' })
    ).setMimeType(ContentService.MimeType.JSON);
  }

  // -----------------------------------------------
  // C. アプリから設定保存 → 認証情報を記録
  // -----------------------------------------------
  if (payload && payload.action === 'update_settings') {
    var rawIds = (payload.lineUserId || '').trim();
    props.setProperties({
      'LINE_ACCESS_TOKEN': (payload.lineAccessToken || '').trim(),
      'LINE_USER_ID': rawIds,
      'SPREADSHEET_ID': (payload.spreadsheetId || '').trim(),
      'EBAY_AUTH_TOKEN': (payload.apiAuthToken || '').trim()
    });
    return ContentService.createTextOutput(
      JSON.stringify({ status: 'success' })
    ).setMimeType(ContentService.MimeType.JSON);
  }

  // -----------------------------------------------
  // D. eBay販売通知 → Cloud Run に転送
  // -----------------------------------------------
  try {
    var hubResponse = UrlFetchApp.fetch(CLOUD_RUN_URL + '/api/ebay-webhook', {
      method: 'post',
      contentType: 'text/xml',
      payload: e.postData.contents,
      headers: { 'x-user-id': USER_EMAIL },
      muteHttpExceptions: true
    });
    var hubStatus = hubResponse.getResponseCode();
    if (hubStatus < 200 || hubStatus >= 300) {
      throw new Error(
        '通知処理サーバーがHTTP ' + hubStatus + 'を返しました: '
        + hubResponse.getContentText().slice(0, 300)
      );
    }
    var responseBody = hubResponse.getContentText();
    if (payload && payload.action === 'sellcon_notification_probe') {
      return ContentService.createTextOutput(responseBody)
        .setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(
      JSON.stringify({
        status: 'accepted',
        gasVersion: '12.0',
        retrySafe: true,
        gasForwardingContract: 'retry-safe-v12'
      })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    console.error('通知処理サーバーへの送信に失敗: ' + err);
    // 失敗を成功扱いするとeBay側が再配信できないため、必ず例外を返す。
    throw err;
  }
}

// ==========================================
// 3. LINE ユーザーID確認
//    Botに話しかけるとIDが返ってきます
// ==========================================
function handleLineReply(events) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('LINE_ACCESS_TOKEN');
  for (var i = 0; i < events.length; i++) {
    var event = events[i];
    if (event.type === 'message' && event.source.userId) {
      UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        method: 'post',
        payload: JSON.stringify({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: 'あなたのユーザーID:\n' + event.source.userId
          }]
        })
      });
    }
  }
  return ContentService.createTextOutput('ok');
}

// ==========================================
// 4. 在庫データをスプレッドシートに保存
//    アプリの「シート同期」ボタンで実行されます
// ==========================================
function writeToSheet(data) {
  var sheet = getSheet();
  var items = data.items || [];
  if (items.length === 0) return;

  // Sell Conの現行Slim Schema（A-G）を維持する。
  // A=ItemID, B=商品名, C=仕入れ先URL, D=在庫状況,
  // E=eBay状況, F=仕入れ値, G=純利益
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 7).setValues([
      ['ItemID', 'タイトル', 'URL', '在庫状況', '販売状況', '仕入れ値', '純利益']
    ]);
  }

  // 既存データを取得してItemIDでマップ化
  var lastRow = sheet.getLastRow();
  var existingMap = {};
  var existingRows = {};
  if (lastRow >= 2) {
    var existing = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
    for (var i = 0; i < existing.length; i++) {
      var id = String(existing[i][0]).trim();
      if (id) {
        existingMap[id] = i + 2;
        existingRows[id] = existing[i];
      }
    }
  }

  // 各アイテムを更新 or 追加。payloadに無い列は既存値を保持する。
  for (var j = 0; j < items.length; j++) {
    var item = items[j];
    var itemId = String(item.itemId || '').trim();
    if (!itemId) continue;

    var current = existingRows[itemId] || ['', '', '', '', '', '', ''];
    var itemName = item.itemName !== undefined ? item.itemName : current[1];
    var supplierUrl = item.supplierUrl !== undefined ? item.supplierUrl : current[2];
    var stockStatus = item.stockStatus !== undefined ? item.stockStatus : current[3];
    var ebayStatus = item.ebayStatus !== undefined ? item.ebayStatus : current[4];
    var supplierPrice = item.supplierPrice !== undefined ? item.supplierPrice : current[5];
    var netProfit = item.netProfit !== undefined ? item.netProfit : current[6];
    var rowData = [
      itemId,
      itemName || '',
      supplierUrl,
      stockStatus || '',
      ebayStatus || '',
      supplierPrice === null ? '' : supplierPrice,
      netProfit === null ? '' : netProfit
    ];

    if (existingMap[itemId]) {
      sheet.getRange(existingMap[itemId], 1, 1, 7).setValues([rowData]);
    } else {
      sheet.appendRow(rowData);
      existingMap[itemId] = sheet.getLastRow();
      existingRows[itemId] = rowData;
    }
  }
}
