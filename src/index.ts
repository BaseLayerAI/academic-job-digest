import { writeFile } from "node:fs/promises";
import { launch } from "./adapters/_base.js";
import type { Adapter, Job } from "./types.js";
import { isEntryLevelResearch } from "./filter.js";
import { ensureSchema, upsertAndDiff, updateDetails, markEmailed, getUnemailed, closeDb } from "./db.js";
import { fetchDetails } from "./details.js";
import { fetchPI, fetchPINetworking, resolvePIWeb } from "./pi.js";
import { sendDigest, sendDbDownAlert } from "./email.js";
import { syncSheet } from "./sheet.js";
import { adapter as weillCornell } from "./adapters/weillCornell.js";
import { adapter as columbia } from "./adapters/columbia.js";
import { adapter as nyuLangone } from "./adapters/nyuLangone.js";
import { adapter as mountSinai } from "./adapters/mountSinai.js";
import { adapter as einstein } from "./adapters/einstein.js";
import { adapter as northwestern } from "./adapters/northwestern.js";

const adapters: Adapter[] = [weillCornell, columbia, nyuLangone, mountSinai, einstein, northwestern];

const args = process.argv.slice(2);
const noFilter = args.includes("--all");
const noDb = args.includes("--no-db") || !process.env.DATABASE_URL;
const seed = process.env.SEED === "1" || args.includes("--seed");
const only = args.filter((a) => !a.startsWith("--"));
const selected = only.length ? adapters.filter((a) => only.includes(a.site)) : adapters;

if (!noDb) {
  // ensureSchema() retries the connect (waitForDb) before giving up. If it still fails the
  // DB is genuinely down — fire an ops alert (see sendDbDownAlert) and abort, rather than
  // crashing silently and letting the digest/sheet go stale for days (cf. 2026-07-18).
  try {
    await ensureSchema();
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`[fatal] DB unreachable after retries — aborting run: ${msg}`);
    await sendDbDownAlert(msg);
    process.exit(1);
  }
}

const { browser, ctx } = await launch();
const summary: Record<string, number | string> = {};
const allJobs: Job[] = [];

await Promise.all(
  selected.map(async (a) => {
    const page = await ctx.newPage();
    const start = Date.now();
    try {
      console.log(`[${a.site}] start`);
      const jobs = await a.scrape(page);
      const filtered = noFilter ? jobs : jobs.filter((j) => isEntryLevelResearch(j.title));
      summary[a.site] = `${filtered.length}/${jobs.length}`;
      allJobs.push(...filtered);
      console.log(
        `[${a.site}] ${filtered.length} kept of ${jobs.length} in ${((Date.now() - start) / 1000).toFixed(1)}s`
      );
    } catch (e) {
      const msg = (e as Error).message;
      summary[a.site] = `ERROR: ${msg}`;
      console.error(`[${a.site}] failed: ${msg}`);
    } finally {
      await page.close();
    }
  })
);
await browser.close();

allJobs.sort((a, b) => {
  if (a.postedAt && b.postedAt) return b.postedAt.localeCompare(a.postedAt);
  if (a.postedAt) return -1;
  if (b.postedAt) return 1;
  return 0;
});

console.log("\n=== summary (kept/total) ===");
console.table(summary);

await writeFile(
  "snapshot.json",
  JSON.stringify({ scrapedAt: new Date().toISOString(), counts: summary, jobs: allJobs }, null, 2)
);

if (noDb) {
  console.log("DB disabled — snapshot.json written, no email");
  process.exit(0);
}

const newJobs = await upsertAndDiff(allJobs);
const newIds = new Set(newJobs.map((j) => `${j.site}|${j.externalId}`));
console.log(`\n=== new since last run: ${newJobs.length} ===`);

// Candidates = brand-new jobs PLUS previously-seen jobs that were never emailed
// (e.g. dropped by the PI gate on an earlier run). Re-surfacing them is what makes
// the gate's "drop & retry" real: their PI gets another resolution attempt today.
// Skipped on --seed (first run swallows everything).
const carryover = seed ? [] : (await getUnemailed()).filter((j) => !newIds.has(`${j.site}|${j.externalId}`));
const candidates = [...newJobs, ...carryover];
if (carryover.length) console.log(`=== carried over (unemailed, retrying): ${carryover.length} ===`);

// Enrich detail-page data for candidates that still lack a summary (new jobs, plus any
// carryover that never got enriched). Sinai/Columbia summaries come from the scrape.
const enrichables = candidates.filter(
  (j) =>
    !j.summary &&
    j.site !== "mountSinai" &&
    j.site !== "columbia" &&
    j.site !== "northwestern" &&
    j.site !== "einstein"
);
if (enrichables.length > 0) {
  const { browser: b2, ctx: c2 } = await (await import("./adapters/_base.js")).launch();
  const start = Date.now();
  const CONCURRENCY = 5;
  for (let i = 0; i < enrichables.length; i += CONCURRENCY) {
    const chunk = enrichables.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map((j) => fetchDetails(c2, j).then((d) => ({ j, d }))));
    for (const { j, d } of results) if (d) Object.assign(j, d);
  }
  await b2.close();
  console.log(`[details] enriched ${enrichables.length} in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  await updateDetails(enrichables);
}

if (candidates.length > 0) {
  const piStart = Date.now();
  const PI_CONCURRENCY = 4;
  let piIdx = 0;
  const piWorker = async () => {
    while (piIdx < candidates.length) {
      const j = candidates[piIdx++];
      // Resolve a PI only if we don't have one yet (carryover may already have it).
      if (!j.piName) {
        const pi = await fetchPI(j);
        if (pi.piName) {
          j.piName = pi.piName;
          j.piSource = "posting";
          j.piConfidence = "high";
        }
        if (pi.piResearch) j.piResearch = pi.piResearch;
        // No PI named in the posting → try to resolve the hiring lab head via web search.
        if (!j.piName) {
          const web = await resolvePIWeb(j);
          if (web.piName) {
            j.piName = web.piName;
            if (web.piResearch) j.piResearch = web.piResearch;
            j.piSource = "web";
            j.piConfidence = web.piConfidence ?? "medium";
            if (web.piContactPath) j.piContactPath = web.piContactPath;
          } else {
            j.piSource = "none";
          }
        }
      }
      // Web-research networking intel once we have a PI and don't already have it.
      if (j.piName && !j.piNetworking) {
        const net = await fetchPINetworking(j, j.piName);
        if (net.piExperience) j.piExperience = net.piExperience;
        if (net.piLocation) j.piLocation = net.piLocation;
        if (net.piNetworking) j.piNetworking = net.piNetworking;
        if (net.piContactPath && !j.piContactPath) j.piContactPath = net.piContactPath;
      }
    }
  };
  await Promise.all(Array.from({ length: PI_CONCURRENCY }, () => piWorker()));
  await updateDetails(candidates);
  console.log(`[pi] enriched ${candidates.length} in ${((Date.now() - piStart) / 1000).toFixed(1)}s`);
}

for (const j of candidates.slice(0, 30)) {
  console.log(`[${j.site}] ${j.title} — ${j.location} ${j.url}`);
}
if (candidates.length > 30) console.log(`... +${candidates.length - 30} more`);

// PI validation gate: every emailed job must have a PI to reach out to. Jobs without
// a resolvable PI are dropped from the digest AND left unmarked, so a later run
// re-attempts resolution (drop & retry — see carryover above). PI_GATE_STRICT=0 emails all.
const STRICT = process.env.PI_GATE_STRICT !== "0";
const hasPI = (j: Job) => Boolean(j.piName && j.piName.trim());
const emailable = STRICT ? candidates.filter(hasPI) : candidates;
const dropped = candidates.filter((j) => !hasPI(j));
console.log(`[pi-gate] ${emailable.length}/${candidates.length} have a PI (strict=${STRICT}); dropped ${dropped.length}`);
if (dropped.length > 0) {
  const bySite: Record<string, number> = {};
  for (const j of dropped) bySite[j.site] = (bySite[j.site] || 0) + 1;
  console.table(bySite);
}

if (seed) {
  console.log("SEED=1 — skipping email on first run");
  await markEmailed(newJobs);
} else {
  // newIds → only brand-new jobs get the "★ New" badge; carryover renders without it.
  await sendDigest(emailable, undefined, { newIds });
  // Drop & retry: only mark the jobs we actually emailed. Dropped jobs stay unmarked
  // so a later run (via getUnemailed carryover) re-attempts PI resolution.
  if (emailable.length > 0) await markEmailed(emailable);
}

// Refresh the master Google Sheet with the full job dataset (no-op if unconfigured).
await syncSheet();

await closeDb();
