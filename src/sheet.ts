// Push the full job dataset to a Google Sheet via a bound Apps Script web app.
// No Google credentials stored — the script runs as you; we just POST JSON to its URL.
//
// Setup (one time):
//   1. Create a blank Google Sheet.
//   2. Extensions ▸ Apps Script, paste the code from scripts/sheet-sync.gs, and set
//      SECRET to a random string.
//   3. Deploy ▸ New deployment ▸ Web app ▸ Execute as: Me ▸ Who has access: Anyone.
//   4. Copy the /exec URL into SHEET_WEBHOOK_URL, and the same secret into SHEET_SYNC_SECRET.
import { getSheetData } from "./db.js";

export async function syncSheet(): Promise<void> {
  const url = process.env.SHEET_WEBHOOK_URL;
  if (!url) return; // sheet sync not configured — skip silently
  const { sheets } = await getSheetData();
  const totalRows = sheets.reduce((n, s) => n + s.rows.length, 0);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: process.env.SHEET_SYNC_SECRET || "", sheets }),
      redirect: "follow", // Apps Script 302-redirects POSTs to googleusercontent.com
    });
    const text = (await res.text()).slice(0, 200);
    if (!res.ok) {
      console.error(`[sheet] sync failed: ${res.status} ${text}`);
      return;
    }
    console.log(`[sheet] synced ${sheets.length} tabs / ${totalRows} rows → ${text}`);
  } catch (e) {
    console.error("[sheet] sync error:", (e as Error).message);
  }
}
