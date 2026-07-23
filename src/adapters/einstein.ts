import type { Adapter, Job } from "../types.js";
import { normalizeEmploymentType, summarize, topBullets } from "../parse.js";

// Einstein migrated off iCIMS (mid-2026) to the Jibe/Montefiore platform, which serves
// the same JSON job API shape as Mount Sinai. The old careers-einstein.icims.com URL now
// 302-redirects here, which is why the previous DOM scraper silently returned 0 jobs.
const SITE = "einstein";
const API = "https://careers.einsteinmed.edu/api/jobs";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

type JibeJob = {
  data: {
    slug?: string;
    req_id?: string;
    title: string;
    full_location?: string;
    city?: string;
    state?: string;
    posted_date?: string;
    create_date?: string;
    tags1?: string[]; // employee classification (e.g. "Exempt")
    tags2?: string[]; // position type (e.g. "Regular Full-Time")
    tags3?: string[]; // department (e.g. "Office of Human Affairs")
    salary_min_value?: number;
    salary_max_value?: number;
    department?: string;
    description?: string;
    qualifications?: string;
    responsibilities?: string;
  };
};

function toJob(j: JibeJob): Job | null {
  const d = j.data;
  const id = d.req_id || d.slug;
  if (!id) return null;
  return {
    site: SITE,
    externalId: id,
    title: d.title,
    location: d.full_location || [d.city, d.state].filter(Boolean).join(", "),
    url: `https://careers.einsteinmed.edu/jobs/${d.slug || id}?lang=en-us`,
    postedAt: d.posted_date || d.create_date,
    employmentType: normalizeEmploymentType(d.tags2?.[0]),
    salaryMin:
      typeof d.salary_min_value === "number" && d.salary_min_value > 0 ? d.salary_min_value : undefined,
    salaryMax:
      typeof d.salary_max_value === "number" && d.salary_max_value > 0 ? d.salary_max_value : undefined,
    department: d.department || d.tags3?.[0] || undefined,
    summary: summarize(d.responsibilities || d.description, 360),
    qualifications: topBullets(d.qualifications, 3),
  };
}

export const adapter: Adapter = {
  site: SITE,
  startUrl: `${API}?keyword=research`,
  async scrape(page) {
    const ctx = page.context();
    const fetchPage = async (pg: number) => {
      const url = `${API}?keyword=research&page=${pg}&sortBy=posted_date&descending=true&internal=false`;
      const resp = await ctx.request.get(url, {
        headers: { accept: "application/json", "user-agent": UA },
      });
      if (!resp.ok()) return { jobs: [] as JibeJob[], total: 0 };
      const body = (await resp.json()) as { jobs: JibeJob[]; totalCount?: number };
      return { jobs: body.jobs || [], total: body.totalCount ?? 0 };
    };

    const first = await fetchPage(1);
    const all = new Map<string, Job>();
    for (const j of first.jobs) {
      const job = toJob(j);
      if (job && !all.has(job.externalId)) all.set(job.externalId, job);
    }
    const perPage = first.jobs.length || 10;
    const lastPage = first.total ? Math.ceil(first.total / perPage) : 1;

    if (lastPage > 1) {
      const pages = Array.from({ length: lastPage - 1 }, (_, i) => i + 2);
      const concurrency = 10;
      for (let i = 0; i < pages.length; i += concurrency) {
        const slice = pages.slice(i, i + concurrency);
        const results = await Promise.all(slice.map(fetchPage));
        for (const r of results) {
          for (const j of r.jobs) {
            const job = toJob(j);
            if (job && !all.has(job.externalId)) all.set(job.externalId, job);
          }
        }
      }
    }
    return [...all.values()];
  },
};
