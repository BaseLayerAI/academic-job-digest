import type { Adapter, Job } from "../types.js";
import { normalizeEmploymentType, summarize, topBullets } from "../parse.js";

const SITE = "mountSinai";
const API = "https://careers.mountsinai.org/api/jobs";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

type SinaiJob = {
  data: {
    slug: string;
    req_id?: string;
    title: string;
    full_location?: string;
    city?: string;
    state?: string;
    post_date?: string;
    create_date?: string;
    employment_type?: string;
    salary_min_value?: number;
    salary_max_value?: number;
    department?: string;
    description?: string;
    qualifications?: string;
    responsibilities?: string;
  };
};

function toJob(j: SinaiJob): Job | null {
  const id = j.data.req_id || j.data.slug;
  if (!id) return null;
  return {
    site: SITE,
    externalId: id,
    title: j.data.title,
    location: j.data.full_location || [j.data.city, j.data.state].filter(Boolean).join(", "),
    url: `https://careers.mountsinai.org/jobs/${j.data.slug}?lang=en-us`,
    postedAt: j.data.post_date || j.data.create_date,
    employmentType: normalizeEmploymentType(j.data.employment_type),
    salaryMin: typeof j.data.salary_min_value === "number" && j.data.salary_min_value > 0 ? j.data.salary_min_value : undefined,
    salaryMax: typeof j.data.salary_max_value === "number" && j.data.salary_max_value > 0 ? j.data.salary_max_value : undefined,
    department: j.data.department || undefined,
    summary: summarize(j.data.responsibilities || j.data.description, 360),
    qualifications: topBullets(j.data.qualifications, 3),
  };
}

export const adapter: Adapter = {
  site: SITE,
  startUrl: `${API}?keywords=research`,
  async scrape(page) {
    const ctx = page.context();
    const fetchPage = async (pg: number) => {
      const url = `${API}?page=${pg}&sortBy=posted_date&descending=true&internal=false&keywords=research`;
      const resp = await ctx.request.get(url, {
        headers: { accept: "application/json", "user-agent": UA },
      });
      if (!resp.ok()) return { jobs: [] as SinaiJob[], total: 0 };
      const body = (await resp.json()) as { jobs: SinaiJob[]; totalCount?: number };
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
