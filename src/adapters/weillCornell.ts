import type { Adapter, Job } from "../types.js";
import { parseEmploymentType } from "../parse.js";

const SITE = "weillCornell";
const BASE =
  "https://jobs.weill.cornell.edu/NY/search/?createNewAlert=false&q=research+&locationsearch=";

export const adapter: Adapter = {
  site: SITE,
  startUrl: BASE,
  async scrape(page) {
    const all = new Map<string, Job>();
    // page size is 5; total ~71. walk startrow.
    for (let start = 0; start < 200; start += 5) {
      const url = `${BASE}&startrow=${start}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      try {
        await page.waitForSelector("li.job-tile", { timeout: 20_000, state: "attached" });
      } catch {
        break;
      }
      const batch: Job[] = await page.$$eval("li.job-tile", (els, site) =>
        els.map((el) => {
          const a = el.querySelector("a.jobTitle-link") as HTMLAnchorElement | null;
          const title = a?.textContent?.trim() ?? "";
          const href = a?.href ?? "";
          const idMatch = el.className.match(/job-id-(\d+)/);
          const externalId = idMatch ? idMatch[1] : href;
          const text = (el.textContent || "").replace(/\s+/g, " ");
          const locMatch = text.match(/Location\s+([^]+?)\s+Requisition ID/);
          const location = locMatch ? locMatch[1].trim() : "";
          return { site, externalId, title, location, url: href, employmentType: undefined as string | undefined };
        }),
        SITE
      );
      let added = 0;
      for (const j of batch) {
        if (!j.title) continue;
        if (!all.has(j.externalId)) {
          j.employmentType = parseEmploymentType(j.title);
          all.set(j.externalId, j);
          added++;
        }
      }
      if (added === 0) break;
    }
    return [...all.values()];
  },
};
