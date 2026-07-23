import type { Adapter, Job } from "../types.js";
import { parseEmploymentType } from "../parse.js";

const SITE = "nyuLangone";
const BASE = "https://jobs.silkroad.com/NYULangone/NYULHCareers";

function parseJobs(html: string): Job[] {
  // a.sr-panel anchors: <a class="sr-panel" ... href="...">TITLE \n LOCATION</a>
  const out: Job[] = [];
  const seen = new Set<string>();
  const re = /<a[^>]*class="sr-panel"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1].replace(/&amp;/g, "&");
    const idMatch = href.match(/\/jobs\/(\d+)/);
    if (!idMatch) continue;
    const id = idMatch[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const text = m[2]
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const parts = text.split(/\s{2,}|·/);
    const title = parts[0]?.trim() || text;
    const location = parts.slice(1).join(" ").trim();
    out.push({ site: SITE, externalId: id, title, location, url: href.startsWith("http") ? href : `https://jobs.silkroad.com${href}`, employmentType: parseEmploymentType(title) });
  }
  return out;
}

export const adapter: Adapter = {
  site: SITE,
  startUrl: `${BASE}?SearchString=research`,
  async scrape(page) {
    const ctx = page.context();
    // page 1 to warm cookies + detect totals
    await page.goto(`${BASE}?SearchString=research&page=1`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("a.sr-panel", { timeout: 15_000 });
    const firstHtml = await page.content();
    const totalText = await page.evaluate(() => document.body.innerText);
    const pageMatch = totalText.match(/Page\s+\d+\s+of\s+(\d+)/i);
    const lastPage = pageMatch ? parseInt(pageMatch[1], 10) : 1;

    const all = new Map<string, Job>();
    for (const j of parseJobs(firstHtml)) if (!all.has(j.externalId)) all.set(j.externalId, j);

    const fetchPg = async (pg: number, attempt = 0): Promise<Job[]> => {
      const url = `${BASE}?SearchString=research&page=${pg}`;
      try {
        const resp = await ctx.request.get(url, {
          headers: {
            "user-agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
          },
          timeout: 45_000,
        });
        if (!resp.ok()) return [];
        return parseJobs(await resp.text());
      } catch {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          return fetchPg(pg, attempt + 1);
        }
        console.warn(`[nyuLangone] page ${pg} failed`);
        return [];
      }
    };

    if (lastPage > 1) {
      const pages = Array.from({ length: lastPage - 1 }, (_, i) => i + 2);
      const concurrency = 4;
      for (let i = 0; i < pages.length; i += concurrency) {
        const slice = pages.slice(i, i + concurrency);
        const results = await Promise.all(slice.map((p) => fetchPg(p)));
        for (const batch of results) {
          for (const j of batch) if (!all.has(j.externalId)) all.set(j.externalId, j);
        }
      }
    }
    return [...all.values()];
  },
};
