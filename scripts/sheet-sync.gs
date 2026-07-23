/**
 * academic-job-digest master sheet sync — Google Apps Script (bound to your Sheet).
 *
 * Writes a multi-tab tracker: a "Summary" rollup plus one detail tab per institution.
 *
 * Setup:
 *   1. Open your blank Google Sheet → Extensions ▸ Apps Script.
 *   2. Replace the default Code.gs with this file's contents.
 *   3. Set SECRET below to a random string.
 *   4. Deploy ▸ New deployment ▸ type "Web app":
 *        - Execute as: Me
 *        - Who has access: Anyone
 *      Copy the Web app URL (ends in /exec).
 *   5. In the project .env (and Railway): SHEET_WEBHOOK_URL=<that URL>
 *      and SHEET_SYNC_SECRET=<the same SECRET>.
 *   6. Run `npm run sync-sheet` to populate it now; the daily cron refreshes it after.
 *
 * If you edit this file later, redeploy: Deploy ▸ Manage deployments ▸ (edit) ▸
 * Version: New version. The /exec URL stays the same.
 *
 * The endpoint is "Anyone" so the cron can reach it; the shared SECRET gates writes.
 */
var SECRET = 'CHANGE_ME_to_a_random_string';

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (SECRET && body.secret !== SECRET) {
      return json_({ ok: false, error: 'forbidden' });
    }

    var tabs = body.sheets || [];
    // Back-compat with the old single-tab payload ({ columns, rows }).
    if (!tabs.length && body.columns) {
      tabs = [{ name: 'Jobs', columns: body.columns, rows: body.rows || [] }];
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var written = [];
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      var cols = t.columns || [];
      var rows = t.rows || [];
      var sh = ss.getSheetByName(t.name) || ss.insertSheet(t.name);
      sh.clear();
      if (cols.length) {
        var values = [cols].concat(rows);
        sh.getRange(1, 1, values.length, cols.length).setValues(values);
        sh.setFrozenRows(1);
        sh.getRange(1, 1, 1, cols.length).setFontWeight('bold');
        if (rows.length) {
          sh.getRange(2, 1, rows.length, cols.length).setVerticalAlignment('top');
        }
        // Best-effort tidy sizing; ignore if the API rate-limits on big sheets.
        try { sh.autoResizeColumns(1, cols.length); } catch (ignore) {}
      }
      written.push(t.name);
    }

    // Order tabs: Summary first, then institutions in payload order.
    for (var j = tabs.length - 1; j >= 0; j--) {
      var s = ss.getSheetByName(tabs[j].name);
      if (s) { ss.setActiveSheet(s); ss.moveActiveSheet(1); }
    }
    var summary = ss.getSheetByName('Summary');
    if (summary) { ss.setActiveSheet(summary); ss.moveActiveSheet(1); }

    // Drop the default empty "Sheet1" once real tabs exist.
    var def = ss.getSheetByName('Sheet1');
    if (def && written.indexOf('Sheet1') === -1 && ss.getSheets().length > 1 && def.getLastRow() === 0) {
      ss.deleteSheet(def);
    }

    return json_({ ok: true, tabs: written });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
