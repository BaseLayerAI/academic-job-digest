import pg from "pg";
import type { Job } from "./types.js";

const { Pool } = pg;

const SCHEMA = process.env.DB_SCHEMA || "public";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_URL?.includes("supabase") ||
    process.env.DATABASE_URL?.includes("railway") ||
    process.env.PGSSL === "1"
      ? { rejectUnauthorized: false }
      : undefined,
});

pool.on("connect", (client) => {
  client.query(`SET search_path TO ${SCHEMA}, public`).catch(() => {});
});

// Railway private networking (postgres.railway.internal) can take several seconds to come
// up when a one-shot cron container cold-starts, so the first DB connect frequently throws
// ETIMEDOUT. With restartPolicyType=NEVER there is no auto-retry, so a single blip kills the
// whole daily run (and the sheet never syncs — this is what crashed the 2026-07-20 cron).
// Retry the initial connect with backoff before touching the schema.
async function waitForDb(attempts = 8, delayMs = 4000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query("SELECT 1");
      if (i > 1) console.log(`[db] connected on attempt ${i}`);
      return;
    } catch (e) {
      if (i === attempts) throw e;
      console.warn(`[db] connect attempt ${i}/${attempts} failed (${(e as Error).message}); retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export async function ensureSchema(): Promise<void> {
  await waitForDb();
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await pool.query(`SET search_path TO ${SCHEMA}, public`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.jobs (
      site         TEXT NOT NULL,
      external_id  TEXT NOT NULL,
      title        TEXT NOT NULL,
      location     TEXT,
      url          TEXT,
      posted_at    TIMESTAMPTZ,
      first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (site, external_id)
    );
    CREATE INDEX IF NOT EXISTS jobs_first_seen_idx ON ${SCHEMA}.jobs (first_seen DESC);
    ALTER TABLE ${SCHEMA}.jobs ADD COLUMN IF NOT EXISTS employment_type TEXT;
    ALTER TABLE ${SCHEMA}.jobs ADD COLUMN IF NOT EXISTS salary_min NUMERIC;
    ALTER TABLE ${SCHEMA}.jobs ADD COLUMN IF NOT EXISTS salary_max NUMERIC;
    ALTER TABLE ${SCHEMA}.jobs ADD COLUMN IF NOT EXISTS department TEXT;
    ALTER TABLE ${SCHEMA}.jobs ADD COLUMN IF NOT EXISTS last_emailed_at TIMESTAMPTZ;
    ALTER TABLE ${SCHEMA}.jobs ADD COLUMN IF NOT EXISTS summary TEXT;
    ALTER TABLE ${SCHEMA}.jobs ADD COLUMN IF NOT EXISTS qualifications TEXT;
    ALTER TABLE ${SCHEMA}.jobs ADD COLUMN IF NOT EXISTS pi_name TEXT;
    ALTER TABLE ${SCHEMA}.jobs ADD COLUMN IF NOT EXISTS pi_research TEXT;
    ALTER TABLE ${SCHEMA}.jobs ADD COLUMN IF NOT EXISTS pi_experience TEXT;
    ALTER TABLE ${SCHEMA}.jobs ADD COLUMN IF NOT EXISTS pi_location TEXT;
    ALTER TABLE ${SCHEMA}.jobs ADD COLUMN IF NOT EXISTS pi_networking TEXT;
    ALTER TABLE ${SCHEMA}.jobs ADD COLUMN IF NOT EXISTS pi_source TEXT;
    ALTER TABLE ${SCHEMA}.jobs ADD COLUMN IF NOT EXISTS pi_confidence TEXT;
    ALTER TABLE ${SCHEMA}.jobs ADD COLUMN IF NOT EXISTS pi_contact_path TEXT;
  `);
}

export async function updateDetails(jobs: Job[]): Promise<void> {
  if (jobs.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const j of jobs) {
      await client.query(
        `UPDATE ${SCHEMA}.jobs
            SET summary        = COALESCE($3, summary),
                qualifications = COALESCE($4, qualifications),
                salary_min     = COALESCE($5, salary_min),
                salary_max     = COALESCE($6, salary_max),
                department     = COALESCE($7, department),
                employment_type = COALESCE($8, employment_type),
                pi_name        = COALESCE($9, pi_name),
                pi_research    = COALESCE($10, pi_research),
                pi_experience  = COALESCE($11, pi_experience),
                pi_location    = COALESCE($12, pi_location),
                pi_networking  = COALESCE($13, pi_networking),
                pi_source      = COALESCE($14, pi_source),
                pi_confidence  = COALESCE($15, pi_confidence),
                pi_contact_path = COALESCE($16, pi_contact_path)
          WHERE site = $1 AND external_id = $2`,
        [
          j.site,
          j.externalId,
          j.summary || null,
          j.qualifications || null,
          j.salaryMin ?? null,
          j.salaryMax ?? null,
          j.department || null,
          j.employmentType || null,
          j.piName || null,
          j.piResearch || null,
          j.piExperience || null,
          j.piLocation || null,
          j.piNetworking || null,
          j.piSource || null,
          j.piConfidence || null,
          j.piContactPath || null,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function markEmailed(jobs: Job[]): Promise<void> {
  if (jobs.length === 0) return;
  const params: unknown[] = [];
  const tuples: string[] = [];
  jobs.forEach((j, i) => {
    tuples.push(`($${i * 2 + 1}, $${i * 2 + 2})`);
    params.push(j.site, j.externalId);
  });
  await pool.query(
    `UPDATE ${SCHEMA}.jobs SET last_emailed_at = now()
       WHERE (site, external_id) IN (VALUES ${tuples.join(",")})`,
    params
  );
}

export async function upsertAndDiff(jobs: Job[]): Promise<Job[]> {
  if (jobs.length === 0) return [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const newRows: Job[] = [];
    for (const j of jobs) {
      const r = await client.query(
        `INSERT INTO ${SCHEMA}.jobs
           (site, external_id, title, location, url, posted_at,
            employment_type, salary_min, salary_max, department,
            summary, qualifications)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (site, external_id) DO UPDATE
           SET last_seen = now(),
               title = EXCLUDED.title,
               location = EXCLUDED.location,
               url = EXCLUDED.url,
               employment_type = COALESCE(EXCLUDED.employment_type, ${SCHEMA}.jobs.employment_type),
               salary_min = COALESCE(EXCLUDED.salary_min, ${SCHEMA}.jobs.salary_min),
               salary_max = COALESCE(EXCLUDED.salary_max, ${SCHEMA}.jobs.salary_max),
               department = COALESCE(EXCLUDED.department, ${SCHEMA}.jobs.department),
               summary = COALESCE(EXCLUDED.summary, ${SCHEMA}.jobs.summary),
               qualifications = COALESCE(EXCLUDED.qualifications, ${SCHEMA}.jobs.qualifications)
         RETURNING (xmax = 0) AS inserted`,
        [
          j.site,
          j.externalId,
          j.title,
          j.location,
          j.url,
          j.postedAt || null,
          j.employmentType || null,
          j.salaryMin ?? null,
          j.salaryMax ?? null,
          j.department || null,
          j.summary || null,
          j.qualifications || null,
        ]
      );
      if (r.rows[0]?.inserted) newRows.push(j);
    }
    await client.query("COMMIT");
    return newRows;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Jobs that have never been emailed (last_emailed_at IS NULL), within a recency window
// so the PI gate's drop-and-retry doesn't reprocess stale postings forever. These are
// re-surfaced as candidates each run to re-attempt PI resolution. Excludes brand-new
// rows from this run only by caller-side dedup (they're already in upsertAndDiff's output).
export async function getUnemailed(maxAgeDays = 14): Promise<Job[]> {
  const { rows } = await pool.query<{
    site: string; external_id: string; title: string; location: string | null; url: string | null;
    posted_at: Date | null; employment_type: string | null; salary_min: string | null;
    salary_max: string | null; department: string | null; summary: string | null;
    qualifications: string | null; pi_name: string | null; pi_research: string | null;
    pi_experience: string | null; pi_location: string | null; pi_networking: string | null;
    pi_source: string | null; pi_confidence: string | null; pi_contact_path: string | null;
  }>(
    `SELECT site, external_id, title, location, url, posted_at, employment_type,
            salary_min, salary_max, department, summary, qualifications,
            pi_name, pi_research, pi_experience, pi_location, pi_networking,
            pi_source, pi_confidence, pi_contact_path
       FROM ${SCHEMA}.jobs
      WHERE last_emailed_at IS NULL
        AND first_seen > now() - ($1 || ' days')::interval
      ORDER BY posted_at DESC NULLS LAST`,
    [String(maxAgeDays)]
  );
  return rows.map((r) => ({
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
    piSource: (r.pi_source as Job["piSource"]) || undefined,
    piConfidence: (r.pi_confidence as Job["piConfidence"]) || undefined,
    piContactPath: r.pi_contact_path || undefined,
  }));
}

// Institution display + tab order for the master Google Sheet. Sites with no rows yet
// (e.g. northwestern before its first DB run) are skipped automatically.
const SITE_ORDER: [string, string][] = [
  ["weillCornell", "Weill Cornell"],
  ["columbia", "Columbia"],
  ["nyuLangone", "NYU Langone"],
  ["mountSinai", "Mount Sinai"],
  ["einstein", "Einstein"],
  ["northwestern", "Northwestern"],
];

export type SheetTab = { name: string; columns: string[]; rows: (string | number)[][] };

// Multi-tab dataset for the master Google Sheet: a Summary rollup plus one detail tab
// per institution. "Active" = seen in that site's most recent successful scrape
// (last_seen within 12h of the site's max last_seen), which keeps jobs from a site that
// errored on the latest run from all flipping to Closed. "Days Active" spans from the
// posting date (or first_seen) up to today for active jobs, or to last_seen for closed.
export async function getSheetData(): Promise<{ sheets: SheetTab[] }> {
  const { rows } = await pool.query<{
    site: string; title: string; department: string | null; location: string | null;
    posted_at: Date | null; first_seen: Date; last_seen: Date;
    salary_min: string | null; salary_max: string | null; employment_type: string | null;
    pi_name: string | null; pi_contact_path: string | null; url: string | null;
    active: boolean; days_active: number; new7: boolean;
  }>(
    `WITH m AS (SELECT site, max(last_seen) AS ms FROM ${SCHEMA}.jobs GROUP BY site)
     SELECT j.site, j.title, j.department, j.location, j.posted_at, j.first_seen, j.last_seen,
            j.salary_min, j.salary_max, j.employment_type, j.pi_name, j.pi_contact_path, j.url,
            (j.last_seen >= m.ms - interval '12 hours') AS active,
            GREATEST(0, floor(EXTRACT(epoch FROM (
              (CASE WHEN j.last_seen >= m.ms - interval '12 hours' THEN now() ELSE j.last_seen END)
              - COALESCE(j.posted_at, j.first_seen)
            )) / 86400))::int AS days_active,
            (j.first_seen > now() - interval '7 days') AS new7
       FROM ${SCHEMA}.jobs j JOIN m USING (site)
      ORDER BY active DESC, posted_at DESC NULLS LAST, first_seen DESC`
  );

  const d = (x: Date | null): string => (x ? new Date(x).toISOString().slice(0, 10) : "");
  const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
  const salary = (mn: string | null, mx: string | null): string => {
    const a = mn ? Number(mn) : 0;
    const b = mx ? Number(mx) : 0;
    if (a && b) return `${money(a)}–${money(b)}`;
    if (a) return `${money(a)}+`;
    if (b) return `up to ${money(b)}`;
    return "";
  };

  const sheets: SheetTab[] = [];

  // Summary tab (built first, rendered first).
  const summaryRows: (string | number)[][] = [];
  let tTotal = 0, tActive = 0, tClosed = 0, tNew = 0;
  for (const [site, label] of SITE_ORDER) {
    const g = rows.filter((r) => r.site === site);
    if (g.length === 0) continue;
    const active = g.filter((r) => r.active);
    const closed = g.length - active.length;
    const new7 = g.filter((r) => r.new7).length;
    const avgDays = active.length
      ? Math.round((active.reduce((s, r) => s + r.days_active, 0) / active.length) * 10) / 10
      : 0;
    const lastScraped = g.reduce((mx, r) => (r.last_seen > mx ? r.last_seen : mx), g[0].last_seen);
    summaryRows.push([label, g.length, active.length, closed, new7, avgDays, d(lastScraped)]);
    tTotal += g.length; tActive += active.length; tClosed += closed; tNew += new7;
  }
  summaryRows.push(["TOTAL", tTotal, tActive, tClosed, tNew, "", ""]);
  sheets.push({
    name: "Summary",
    columns: ["Institution", "Total", "Active", "Closed", "New (7d)", "Avg Days Active", "Last Scraped"],
    rows: summaryRows,
  });

  // One detail tab per institution.
  const detailCols = [
    "Title", "Department", "Location", "Posted", "Days Active", "Status",
    "Employment", "Salary", "PI", "PI Contact", "First Seen", "Last Seen", "URL",
  ];
  for (const [site, label] of SITE_ORDER) {
    const g = rows.filter((r) => r.site === site);
    if (g.length === 0) continue;
    sheets.push({
      name: label,
      columns: detailCols,
      rows: g.map((r) => [
        r.title, r.department || "", r.location || "", d(r.posted_at), r.days_active,
        r.active ? "Active" : "Closed", r.employment_type || "", salary(r.salary_min, r.salary_max),
        r.pi_name || "", r.pi_contact_path || "", d(r.first_seen), d(r.last_seen), r.url || "",
      ]),
    });
  }

  return { sheets };
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
