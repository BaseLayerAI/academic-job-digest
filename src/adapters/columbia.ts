import type { Adapter, Job } from "../types.js";
import { parseEmploymentType } from "../parse.js";

// Columbia's Interfolio-backed faculty search exposes a Drupal JSON feed of every posting.
// The previous adapter rendered the Angular SPA and waited on `.result-item`; that silently
// stopped updating on the headless cron (~2026-07-01) while the HTTP-API adapters kept
// working — render-dependent scrapes are the ones that fail under the datacenter/headless
// cron. This fetches the JSON directly (one GET), which is what the reliable adapters do.
const SITE = "columbia";
const API = "https://academic.careers.columbia.edu/json/cu_faculty_search/extended";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

type CuJob = {
  id: number;
  name: string;
  unit_name?: string;
  position_type_name?: string;
  open?: boolean;
  archived?: boolean;
  private_flag?: boolean;
  sortable_date?: string; // YYYYMMDD
};

function toISO(yyyymmdd?: string): string | undefined {
  if (!yyyymmdd || !/^\d{8}$/.test(yyyymmdd)) return undefined;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

export const adapter: Adapter = {
  site: SITE,
  startUrl: "https://academic.careers.columbia.edu/#!?keywords=research",
  async scrape(page) {
    // The JSON feed 403s a raw request context (bot protection), but is fine same-origin
    // from a loaded browser page. So load the app first — that clears any JS challenge and
    // sets the session cookies — then fetch the feed via page.evaluate. This still avoids
    // the fragile Angular `.result-item` render the old adapter depended on.
    await page.goto(this.startUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const grab = () =>
      page.evaluate(async (u) => {
        const r = await fetch(u, { headers: { accept: "application/json" } });
        if (!r.ok) return { status: r.status, results: null as CuJob[] | null };
        const j = (await r.json()) as { results?: CuJob[] };
        return { status: 200, results: j.results || [] };
      }, API);
    let out = await grab();
    if (!out.results) {
      await page.waitForTimeout(4000); // give a challenge a moment to clear, retry once
      out = await grab();
    }
    if (!out.results) throw new Error(`columbia json ${out.status}`);
    const body = { results: out.results } as { results?: CuJob[] };

    // "Officer of Research" is Columbia's research-staff category (postdocs, research
    // scientists, research staff) — the relevant pool for a researcher. Skip
    // closed/archived/private and the instruction/library/K-12 categories. Location codes
    // in the feed aren't resolvable to names without the SPA's bundle; Columbia postings
    // are all NYC, so we label them "New York, NY" and surface unit_name as the department.
    const all = new Map<string, Job>();
    for (const r of body.results || []) {
      if (!r.open || r.archived || r.private_flag) continue;
      if (r.position_type_name !== "Officer of Research") continue;
      if (!r.name) continue;
      const id = String(r.id);
      if (all.has(id)) continue;
      all.set(id, {
        site: SITE,
        externalId: id,
        title: r.name,
        location: "New York, NY",
        url: "https://academic.careers.columbia.edu/#!?keywords=research",
        department: r.unit_name || undefined,
        postedAt: toISO(r.sortable_date),
        employmentType: parseEmploymentType(r.name),
      });
    }
    return [...all.values()];
  },
};
