import type { Adapter, Job } from "../types.js";
import type { Page } from "playwright";
import { parseEmploymentType } from "../parse.js";

const SITE = "northwestern";
// PeopleSoft Fluid candidate gateway ("Explore Jobs"). Stateful, POST-back driven —
// there is no clean per-job GET URL, so every card links back to this search page.
const URL =
  "https://careers.northwestern.edu/psc/hrnu_er/EMPLOYEE/HRMS/c/HRS_HRAM_FL.HRS_CG_SEARCH_FL.GBL?Page=HRS_APP_SCHJOB_FL&Action=U";

// Facets to apply, matched by *label text* — never by index. PeopleSoft re-renders the
// whole facet panel on every post-back and the `PTS_SELECT$N` indices shuffle each time,
// so the only stable handle is the visible label ("Staff (296)", "Research (126)"). The
// `\(\d` anchor keeps "Research (126)" from also matching "Research Operations (4)" etc.
const FACET_STAFF = "^Staff \\(\\d";
const FACET_RESEARCH = "^Research \\(\\d+\\)$";

const ROW_SEL = "li[id^='HRS_AGNT_RSLT_I$'][id*='_row_']";

function toISO(mdy: string): string | undefined {
  // "07/16/2026" -> "2026-07-16" so it sorts lexicographically alongside other sites.
  const m = mdy.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return undefined;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

const countText = (page: Page) =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll("span,div,h2,h3")].find(
      (e) => /jobs? found/i.test(e.textContent || "") && (e.textContent || "").length < 40
    );
    return el ? (el.textContent || "").trim() : "";
  });

const rowCount = (page: Page, sel: string) =>
  page.evaluate((s) => document.querySelectorAll(s).length, sel);

// Tick a facet by label text and wait for the "N jobs found" count to change (which is
// how we know the post-back landed). Falls back to expanding any collapsed "More" facet
// groups once, in case the value we want is hidden behind a Less/More toggle.
async function applyFacet(page: Page, labelRe: string): Promise<void> {
  const before = await countText(page);

  const click = () =>
    page.evaluate((reSrc) => {
      const rx = new RegExp(reSrc);
      const lbl = [...document.querySelectorAll("label[id^='PTS_SELECT_LBL$']")].find((l) =>
        rx.test((l.textContent || "").trim())
      );
      const forId = lbl?.getAttribute("for");
      const inp = forId ? document.getElementById(forId) : null;
      if (!inp) return false;
      (inp as HTMLElement).click(); // fires inline onclick -> submitAction_win0 post-back
      return true;
    }, labelRe);

  let ok = await click();
  if (!ok) {
    // Expand every collapsed facet group, then retry once.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("[onclick*='PTS_MORE']")) (el as HTMLElement).click();
    });
    await page.waitForTimeout(1500);
    ok = await click();
  }
  if (!ok) throw new Error(`facet label not found: ${labelRe}`);

  await page
    .waitForFunction(
      (prev) => {
        const el = [...document.querySelectorAll("span,div,h2,h3")].find(
          (e) => /jobs? found/i.test(e.textContent || "") && (e.textContent || "").length < 40
        );
        return !!el && (el.textContent || "").trim() !== prev;
      },
      before,
      { timeout: 30_000 }
    )
    .catch(() => {}); // tolerate no-op (e.g. count unchanged) — verified again below
  await page.waitForTimeout(600);
}

export const adapter: Adapter = {
  site: SITE,
  startUrl: URL,
  async scrape(page) {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForSelector(ROW_SEL, { timeout: 60_000, state: "attached" });

    // Job Opening = Staff, then Job Category = Research. Order matters only in that each
    // click is a full post-back; we re-resolve labels every time.
    await applyFacet(page, FACET_STAFF);
    await applyFacet(page, FACET_RESEARCH);

    // Assert both filters actually stuck — otherwise we'd silently email the wrong set.
    const applied = await page.evaluate(() =>
      [...document.querySelectorAll("input[id^='PTS_SELECT$']:checked")].map((i) => {
        const l = document.querySelector(`label[for='${(i.id || "").replace(/\$/g, "\\$")}']`);
        return l ? (l.textContent || "").trim() : "";
      })
    );
    const hasStaff = applied.some((l) => /^Staff \(/.test(l));
    const hasResearch = applied.some((l) => /^Research \(\d+\)$/.test(l));
    if (!hasStaff || !hasResearch)
      throw new Error(`facets not applied (staff=${hasStaff} research=${hasResearch}): ${applied.join(", ")}`);

    // The results grid renders 50 rows at a time; the "more" affordance fires an ICAction
    // (HRS_AGNT_RSLT_I$hdown$0) that appends the next 50. Loop until it stops growing.
    for (let i = 0; i < 40; i++) {
      const n = await rowCount(page, ROW_SEL);
      const fired = await page.evaluate((sel) => {
        if (!document.querySelector("[onclick*='HRS_AGNT_RSLT_I$hdown']")) return false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).submitAction_win0((document as any).win0, "HRS_AGNT_RSLT_I$hdown$0");
        return document.querySelectorAll(sel).length; // return prior count marker
      }, ROW_SEL);
      if (fired === false) break;
      await page
        .waitForFunction((prev) => document.querySelectorAll(prev.sel).length > prev.n, { n, sel: ROW_SEL }, { timeout: 20_000 })
        .catch(() => {});
      if ((await rowCount(page, ROW_SEL)) <= n) break;
    }

    // Inline every field read (no nested named helper) — esbuild/tsx would otherwise wrap
    // a `const val = () => …` with a `__name(...)` call that doesn't exist in the browser.
    const raw = await page.$$eval(
      ROW_SEL,
      (rows, site) =>
        rows.map((r) => ({
          site,
          externalId: (
            r.querySelector("span[id^='HRS_APP_JBSCH_I_HRS_JOB_OPENING_ID']")?.textContent || ""
          ).trim(),
          title: (r.querySelector("span[id^='SCH_JOB_TITLE']")?.textContent || "").trim(),
          location: (r.querySelector("span[id^='LOCATION']")?.textContent || "").trim(),
          department: (
            r.querySelector("span[id^='HRS_APP_JBSCH_I_HRS_DEPT_DESCR']")?.textContent || ""
          ).trim(),
          posted: (r.querySelector("span[id^='SCH_OPENED']")?.textContent || "").trim(),
        })),
      SITE
    );

    const all = new Map<string, Job>();
    for (const j of raw) {
      if (!j.externalId || !j.title) continue;
      if (all.has(j.externalId)) continue;
      all.set(j.externalId, {
        site: SITE,
        externalId: j.externalId,
        title: j.title,
        location: j.location,
        url: URL,
        department: j.department || undefined,
        postedAt: toISO(j.posted),
        employmentType: parseEmploymentType(j.title),
      });
    }
    return [...all.values()];
  },
};
