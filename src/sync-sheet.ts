// Manual one-off: push the current full job dataset to the master Google Sheet.
// Usage: npm run sync-sheet  (requires SHEET_WEBHOOK_URL in .env)
import { ensureSchema, closeDb } from "./db.js";
import { syncSheet } from "./sheet.js";

if (!process.env.SHEET_WEBHOOK_URL) {
  console.error("SHEET_WEBHOOK_URL not set — nothing to sync. See src/sheet.ts for setup.");
  process.exit(1);
}
await ensureSchema();
await syncSheet();
await closeDb();
