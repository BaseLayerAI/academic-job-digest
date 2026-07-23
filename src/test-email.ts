// Send a test digest using existing rows in DB. Pulls a balanced cross-section
// across all sites so the preview reflects daily-cron variety.
import pg from "pg";
import { sendDigest } from "./email.js";
import { fetchPI, fetchPINetworking, resolvePIWeb } from "./pi.js";
import { ensureSchema } from "./db.js";
import type { Job } from "./types.js";

await ensureSchema();

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") || process.env.DATABASE_URL?.includes("supabase")
    ? { rejectUnauthorized: false }
    : undefined,
});

const PER_SITE = parseInt(process.env.TEST_PER_SITE || "8", 10);
const to = process.env.TEST_TO;
if (!to) {
  console.error("TEST_TO not set — refusing to guess a recipient.");
  console.error("Usage: TEST_TO=you@example.com npm run test-email");
  process.exit(1);
}

// Use a window function to take top N per site by posted_at then first_seen.
const { rows } = await pool.query<{
  site: string;
  external_id: string;
  title: string;
  location: string | null;
  url: string | null;
  posted_at: Date | null;
  first_seen: Date;
  employment_type: string | null;
  salary_min: string | null;
  salary_max: string | null;
  department: string | null;
  summary: string | null;
  qualifications: string | null;
  pi_name: string | null;
  pi_research: string | null;
  pi_experience: string | null;
  pi_location: string | null;
  pi_networking: string | null;
  pi_contact_path: string | null;
}>(
  `WITH ranked AS (
     SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY site
              ORDER BY posted_at DESC NULLS LAST, first_seen DESC
            ) AS rn
       FROM jobs
   )
   SELECT site, external_id, title, location, url, posted_at, first_seen,
          employment_type, salary_min, salary_max, department,
          summary, qualifications, pi_name, pi_research,
          pi_experience, pi_location, pi_networking, pi_contact_path
     FROM ranked
    WHERE rn <= $1`,
  [PER_SITE]
);

const jobs: Job[] = rows.map((r) => ({
  site: r.site,
  externalId: r.external_id,
  title: r.title,
  location: r.location || "",
  url: r.url || "",
  postedAt: r.posted_at ? r.posted_at.toISOString() : undefined,
  employmentType: r.employment_type || undefined,
  salaryMin: r.salary_min ? Number(r.salary_min) : undefined,
  salaryMax: r.salary_max ? Number(r.salary_max) : undefined,
  department: r.department || undefined,
  summary: r.summary || undefined,
  qualifications: r.qualifications || undefined,
  piName: r.pi_name || undefined,
  piResearch: r.pi_research || undefined,
  piExperience: r.pi_experience || undefined,
  piLocation: r.pi_location || undefined,
  piNetworking: r.pi_networking || undefined,
  piContactPath: r.pi_contact_path || undefined,
}));

// Enrich PI info for any rows missing it — mirrors the daily-cron pipeline:
// posting-extract → web-resolve fallback → networking intel. Concurrency 4. Persist.
const missing = jobs.filter((j) => !j.piName || !j.piNetworking);
console.log(`enriching PI for ${missing.length}/${jobs.length} rows`);
const CONCURRENCY = 4;
let idx = 0;
async function worker() {
  while (idx < missing.length) {
    const j = missing[idx++];
    if (!j.piName) {
      const pi = await fetchPI(j);
      if (pi.piName) { j.piName = pi.piName; j.piSource = "posting"; j.piConfidence = "high"; }
      if (pi.piResearch) j.piResearch = pi.piResearch;
      if (!j.piName) {
        const web = await resolvePIWeb(j);
        if (web.piName) {
          j.piName = web.piName;
          if (web.piResearch) j.piResearch = web.piResearch;
          j.piSource = "web";
          j.piConfidence = web.piConfidence ?? "medium";
          if (web.piContactPath) j.piContactPath = web.piContactPath;
        } else j.piSource = "none";
      }
    }
    if (j.piName && !j.piNetworking) {
      const net = await fetchPINetworking(j, j.piName);
      if (net.piExperience) j.piExperience = net.piExperience;
      if (net.piLocation) j.piLocation = net.piLocation;
      if (net.piNetworking) j.piNetworking = net.piNetworking;
      if (net.piContactPath && !j.piContactPath) j.piContactPath = net.piContactPath;
    }
    await pool.query(
      `UPDATE jobs SET pi_name = COALESCE($3, pi_name), pi_research = COALESCE($4, pi_research),
                       pi_experience = COALESCE($5, pi_experience), pi_location = COALESCE($6, pi_location),
                       pi_networking = COALESCE($7, pi_networking), pi_source = COALESCE($8, pi_source),
                       pi_confidence = COALESCE($9, pi_confidence), pi_contact_path = COALESCE($10, pi_contact_path)
        WHERE site = $1 AND external_id = $2`,
      [j.site, j.externalId, j.piName || null, j.piResearch || null, j.piExperience || null,
       j.piLocation || null, j.piNetworking || null, j.piSource || null, j.piConfidence || null,
       j.piContactPath || null]
    );
    console.log(`  [${j.site}] ${j.title.slice(0,50)} → PI=${j.piName || "(none)"} src=${j.piSource || "?"}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

// NEW = never been emailed yet (last_emailed_at IS NULL)
const newRowsQ = await pool.query<{ site: string; external_id: string }>(
  `SELECT site, external_id FROM jobs WHERE last_emailed_at IS NULL`
);
const newIds = new Set<string>(newRowsQ.rows.map((r) => `${r.site}|${r.external_id}`));

const counts: Record<string, number> = {};
for (const j of jobs) counts[j.site] = (counts[j.site] || 0) + 1;
console.log(`sending ${jobs.length} jobs to ${to} (${newIds.size} flagged NEW)`);
console.table(counts);
await sendDigest(jobs, to, { newIds });
await pool.end();
