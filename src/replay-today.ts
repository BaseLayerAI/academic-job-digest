import pg from "pg";
import { sendDigest } from "./email.js";
import type { Job } from "./types.js";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const to = process.argv[2] || process.env.DIGEST_EMAIL;
if (!to) {
  console.error("No recipient — pass one as an argument or set DIGEST_EMAIL.");
  console.error("Usage: npm run replay-today -- you@example.com");
  process.exit(1);
}

const { rows } = await pool.query<{
  site: string;
  external_id: string;
  title: string;
  location: string | null;
  url: string | null;
  posted_at: Date | null;
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
  `SELECT site, external_id, title, location, url, posted_at,
          employment_type, salary_min, salary_max, department,
          summary, qualifications, pi_name, pi_research,
          pi_experience, pi_location, pi_networking, pi_contact_path
     FROM jobs
    WHERE last_emailed_at::date = CURRENT_DATE
    ORDER BY posted_at DESC NULLS LAST`
);

console.log(`found ${rows.length} jobs emailed today`);

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

const newIds = new Set(jobs.map((j) => `${j.site}|${j.externalId}`));
await sendDigest(jobs, to, { newIds });
await pool.end();
