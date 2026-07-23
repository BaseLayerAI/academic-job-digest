import { chromium, type Browser, type BrowserContext } from "playwright";

export async function launch(): Promise<{ browser: Browser; ctx: BrowserContext }> {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    viewport: { width: 1400, height: 900 },
  });
  return { browser, ctx };
}
