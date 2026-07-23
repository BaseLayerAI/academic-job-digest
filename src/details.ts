import type { BrowserContext } from "playwright";
import type { Job } from "./types.js";
import { summarize, topBullets } from "./parse.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

type Details = Partial<
  Pick<Job, "summary" | "qualifications" | "salaryMin" | "salaryMax" | "department" | "employmentType">
>;

export async function fetchDetails(ctx: BrowserContext, job: Job): Promise<Details | null> {
  // These sites carry summaries straight from the scrape (Sinai/Einstein via their JSON
  // API, Columbia from the SPA), or have no per-job GET URL (northwestern's url is the
  // shared search page), so a detail fetch is useless.
  if (
    job.site === "mountSinai" ||
    job.site === "columbia" ||
    job.site === "northwestern" ||
    job.site === "einstein"
  )
    return null;
  if (!job.url) return null;
  let html: string | null = null;
  try {
    const resp = await ctx.request.get(job.url, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
      timeout: 20_000,
    });
    if (!resp.ok()) return null;
    html = await resp.text();
  } catch {
    return null;
  }
  if (!html) return null;
  if (job.site === "weillCornell") return parseWeill(html);
  if (job.site === "nyuLangone") return parseNYU(html);
  return null;
}

function splitH2Sections(html: string): Record<string, string> {
  // Returns map of H2 section name → inner HTML following it.
  const out: Record<string, string> = {};
  const re = /<H2[^>]*>([^<]+)<\/H2>([\s\S]*?)(?=<H2|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const name = m[1].trim();
    out[name] = m[2];
  }
  return out;
}

function parseWeill(html: string): Details {
  const out: Details = {};
  const flat = html.replace(/&nbsp;/g, " ");

  const sal = flat.match(/Salary Range:\s*\$?\s*([\d,.]+)\s*-\s*\$?\s*([\d,.]+)/i);
  if (sal) {
    const min = Number(sal[1].replace(/,/g, ""));
    const max = Number(sal[2].replace(/,/g, ""));
    const hoursMatch = flat.match(/Weekly Hours:\s*([\d.]+)/i);
    const hrs = hoursMatch ? parseFloat(hoursMatch[1]) : 35;
    if (min < 200) {
      out.salaryMin = Math.round(min * hrs * 52);
      out.salaryMax = Math.round(max * hrs * 52);
    } else {
      out.salaryMin = min;
      out.salaryMax = max;
    }
  }
  const org = flat.match(/Org Unit:\s*([^<\n]{2,80})/i);
  if (org) out.department = org[1].trim();

  const sections = splitH2Sections(flat);
  const pick = (...names: string[]) => {
    for (const n of names) {
      const k = Object.keys(sections).find((kk) => kk.toLowerCase() === n.toLowerCase());
      if (k && sections[k]) return sections[k];
    }
    return undefined;
  };

  const summarySrc = pick("Position Summary", "Job Description", "Overview", "About the Role");
  const responsibilities = pick("Job Responsibilities", "Responsibilities", "Duties");
  const merged = [summarySrc, responsibilities].filter(Boolean).join(" ");
  out.summary = summarize(merged || flat, 380);

  const qualsCombined = [
    pick("Qualifications", "Minimum Qualifications", "Required"),
    pick("Education"),
    pick("Experience"),
    pick("Knowledge, Skills and Abilities", "Skills"),
  ]
    .filter(Boolean)
    .join(" \n ");
  out.qualifications = topBullets(qualsCombined, 3);

  return out;
}

function parseNYU(html: string): Details {
  const out: Details = {};
  // Sections marked as <p><strong>SECTION:</strong>...</p>
  // Split on these markers.
  const grab = (label: string): string | undefined => {
    const re = new RegExp(
      `<strong>\\s*${label}\\s*:?\\s*<\\/strong>([\\s\\S]*?)(?=<strong>|<\\/article|<\\/section|<h[123])`,
      "i"
    );
    const m = html.match(re);
    return m ? m[1] : undefined;
  };
  const resp = grab("Job Responsibilities") || grab("Responsibilities");
  const addl = grab("Additional Position Specific Responsibilities");
  out.summary = summarize([resp, addl].filter(Boolean).join(" "), 380);

  const minQ = grab("Minimum Qualifications");
  const prefQ = grab("Preferred Qualifications");
  out.qualifications = topBullets([minQ, prefQ].filter(Boolean).join(" "), 3);

  const dept = html.match(/Research\s*--?>\s*([^<\n]{3,80})/);
  if (dept) out.department = `Research / ${dept[1].trim()}`;
  const et = html.match(/\b(Full[-\s]?Time\/Regular|Part[-\s]?Time\/Regular|Full[-\s]?Time|Part[-\s]?Time|Per[-\s]?Diem)\b/i);
  if (et) out.employmentType = et[1].trim();
  return out;
}
