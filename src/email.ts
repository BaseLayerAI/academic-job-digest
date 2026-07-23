import { Resend } from "resend";
import type { Job } from "./types.js";
import { INSTITUTION_BY_SITE } from "./pi.js";
import { INTERESTS, APPLICATIONS, relatedThemes } from "./profile.js";

// Display name for the digest (email titles, subjects, footers).
const DIGEST_NAME = process.env.DIGEST_NAME || "Job digest";

// Whole-word match (case-insensitive on already-lowercased hay). Avoids substring
// false positives like 't cell' in 'patient cell' or 'stress' in 'distress'.
function wordMatch(hay: string, term: string): boolean {
  const t = term.toLowerCase().trim();
  if (!t) return false;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${esc}\\b`).test(hay);
}

const SITE_LABEL: Record<string, string> = {
  weillCornell: "Weill Cornell",
  columbia: "Columbia",
  nyuLangone: "NYU Langone",
  mountSinai: "Mount Sinai",
  einstein: "Einstein",
  northwestern: "Northwestern",
};

const SITE_LIST = Object.values(SITE_LABEL).join(" · ");
const N_SITES = Object.keys(SITE_LABEL).length;

// Boost a job by how well it matches the candidate's past application history (PIs, institutions,
// departments, research themes). Returns a capped score + human-readable reasons.
export function interestScore(j: Job): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let s = 0;
  const hay = `${j.title} ${j.department ?? ""} ${j.piResearch ?? ""} ${j.summary ?? ""}`.toLowerCase();
  const inst = INSTITUTION_BY_SITE[j.site];

  // Same PI as a past application. Match against the full application record (which
  // carries the institution applied to) to avoid common-surname collisions and
  // false "you previously applied" claims. Only assert a confident match when the
  // institution agrees; otherwise note the surname overlap softly.
  if (j.piName) {
    const surname = j.piName.split(/\s+/).pop() ?? "";
    const last = surname.toLowerCase();
    const rec =
      last.length > 2
        ? APPLICATIONS.find((a) => a.pi.toLowerCase().split(/[\s/]+/).includes(last))
        : undefined;
    if (rec) {
      if (inst && rec.institution === inst) {
        s += 6;
        reasons.push(`You previously applied to Dr. ${surname}`);
      } else {
        s += 3;
        reasons.push(`Same surname as a PI you applied to (${surname})`);
      }
    }
  }
  // Institution the candidate has targeted before.
  if (inst && INTERESTS.institutions.includes(inst)) {
    s += 2;
    reasons.push(`You've targeted ${SITE_LABEL[j.site] || inst} before`);
  }
  // Department match (whole-word, so "Surgery" doesn't match "Neurosurgery").
  if (j.department) {
    const d = j.department.toLowerCase();
    if (INTERESTS.departments.some((x) => wordMatch(d, x))) {
      s += 2;
      reasons.push(`Matches a department you've applied to (${j.department})`);
    }
  }
  // Research theme — direct whole-word match, else a related-term (softer) match.
  for (const theme of INTERESTS.researchThemes) {
    if (wordMatch(hay, theme)) {
      s += 3;
      reasons.push(`Aligns with your interest in ${theme}`);
      break;
    }
    if (relatedThemes(theme).some((rt) => wordMatch(hay, rt))) {
      s += 1;
      reasons.push(`Related to your interest in ${theme}`);
      break;
    }
  }
  return { score: Math.min(s, 10), reasons: reasons.slice(0, 2) };
}

// Higher = more interest. Tune freely.
export function scoreJob(j: Job): number {
  const t = j.title.toLowerCase();
  let s = 0;
  // strong matches: classic entry research roles
  if (/\b(clinical research coordinator|crc)\b/.test(t)) s += 8;
  if (/\bresearch (assistant|coordinator|technician|associate|scholar|scientist i\b)/.test(t)) s += 7;
  if (/\bpostbac|post[-\s]?bac\b/.test(t)) s += 6;
  if (/\bclinical research\b/.test(t)) s += 4;
  if (/\b(study coordinator|study coord)\b/.test(t)) s += 4;
  if (/\b(lab|laboratory) (technician|tech|assistant)\b/.test(t)) s += 4;
  if (/\b(bioinformatics|biostatistics|genomics|genetic)\b/.test(t)) s += 2;
  // any research mention
  if (/\bresearch\b/.test(t)) s += 2;
  // entry-level signals
  if (/\b(assistant|coordinator|technician|trainee|intern|fellow|aide|scribe|apprentice)\b/.test(t)) s += 1;
  if (/\b(i|1)\b(?!\w)/.test(t)) s += 1;
  // weaker / questionable
  if (/\b(nurse|imaging|radiology|pharmacist|nutritionist)\b/.test(t)) s -= 3;
  if (/\b(specialist)\b/.test(t) && !/\bresearch\b/.test(t)) s -= 2;
  // recency
  if (j.postedAt) {
    const days = (Date.now() - new Date(j.postedAt).getTime()) / 86_400_000;
    if (days <= 3) s += 4;
    else if (days <= 7) s += 2;
    else if (days <= 14) s += 1;
  }
  return s;
}

function esc(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return d.toISOString().slice(0, 10);
}

function fmtSalary(min?: number, max?: number): string {
  const f = (n: number) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`);
  if (min && max) return `${f(min)}–${f(max)}`;
  if (min) return `${f(min)}+`;
  if (max) return `up to ${f(max)}`;
  return "";
}

function pill(label: string, bg: string, fg: string): string {
  return `<span style="display:inline-block;background:${bg};color:${fg};font-size:11px;font-weight:600;padding:3px 8px;border-radius:12px;margin-right:6px;margin-top:6px;">${esc(label)}</span>`;
}

function renderJobCard(j: Job, score: number, isNew: boolean): string {
  const isTop = score >= 11;
  const isHigh = score >= 7;
  const newBadge = isNew
    ? `<span class="badge" style="display:inline-block;background:#f59e0b;color:#ffffff;font-size:10px;font-weight:700;padding:3px 7px;border-radius:4px;letter-spacing:0.4px;text-transform:uppercase;margin-right:6px;vertical-align:middle;">★ New</span>`
    : "";
  const scoreBadge = isTop
    ? `<span class="badge" style="display:inline-block;background:#16a34a;color:#ffffff;font-size:10px;font-weight:700;padding:3px 7px;border-radius:4px;letter-spacing:0.4px;text-transform:uppercase;margin-right:8px;vertical-align:middle;">Top pick</span>`
    : isHigh
      ? `<span class="badge" style="display:inline-block;background:#2563eb;color:#ffffff;font-size:10px;font-weight:700;padding:3px 7px;border-radius:4px;letter-spacing:0.4px;text-transform:uppercase;margin-right:8px;vertical-align:middle;">High</span>`
      : "";
  const badge = `${newBadge}${scoreBadge}`;
  const date = j.postedAt
    ? `<span style="color:#64748b;font-size:12px;white-space:nowrap;"> · ${esc(fmtDate(j.postedAt))}</span>`
    : "";

  // Skimmable detail block: Department, PI, PI research, Qualifications.
  let detailBlock = "";
  if (j.department) {
    detailBlock += `<div style="margin-top:10px;font-size:12px;line-height:1.4;">
      <span style="display:inline-block;font-size:10px;letter-spacing:0.8px;text-transform:uppercase;color:#64748b;font-weight:700;margin-right:6px;">Dept</span>
      <span style="color:#0f172a;font-weight:600;font-size:13px;">${esc(j.department)}</span>
    </div>`;
  }
  if (j.piName) {
    detailBlock += `<div style="margin-top:6px;font-size:12px;line-height:1.4;">
      <span style="display:inline-block;font-size:10px;letter-spacing:0.8px;text-transform:uppercase;color:#64748b;font-weight:700;margin-right:6px;">PI</span>
      <span style="color:#0f172a;font-weight:600;font-size:13px;">${esc(j.piName)}</span>
    </div>`;
  }
  if (j.piResearch && j.piName) {
    detailBlock += `<div class="summary" style="margin-top:6px;padding:8px 10px;background:#f8fafc;border-left:3px solid #2563eb;color:#334155;font-size:12px;line-height:1.5;">
      <span style="display:block;font-size:10px;letter-spacing:0.8px;text-transform:uppercase;color:#1e40af;font-weight:700;margin-bottom:2px;">Research focus</span>
      ${esc(j.piResearch)}
    </div>`;
  }
  // Networking intel: PI experience, current location, how the candidate can connect.
  if (j.piNetworking && j.piName) {
    const expLine = j.piExperience
      ? `<div style="margin-bottom:6px;"><span style="color:#7c2d12;font-weight:700;">Background:</span> ${esc(j.piExperience)}</div>`
      : "";
    const locLine = j.piLocation
      ? `<div style="margin-bottom:6px;"><span style="color:#7c2d12;font-weight:700;">Now at:</span> ${esc(j.piLocation)}</div>`
      : "";
    const contactLine = j.piContactPath
      ? `<div style="margin-top:6px;"><span style="color:#7c2d12;font-weight:700;">Reach out:</span> ${esc(j.piContactPath)}</div>`
      : "";
    detailBlock += `<div class="summary" style="margin-top:6px;padding:8px 10px;background:#fffbeb;border-left:3px solid #d97706;color:#334155;font-size:12px;line-height:1.5;">
      <span style="display:block;font-size:10px;letter-spacing:0.8px;text-transform:uppercase;color:#b45309;font-weight:700;margin-bottom:4px;">Networking angle</span>
      ${expLine}${locLine}
      <div><span style="color:#7c2d12;font-weight:700;">How to connect:</span> ${esc(j.piNetworking)}</div>
      ${contactLine}
    </div>`;
  }
  // Why this matches the candidate's application history.
  if (j.interestReasons && j.interestReasons.length) {
    const items = j.interestReasons
      .map((r) => `<div style="margin-bottom:3px;">• ${esc(r)}</div>`)
      .join("");
    detailBlock += `<div class="summary" style="margin-top:6px;padding:8px 10px;background:#f0fdf4;border-left:3px solid #16a34a;color:#334155;font-size:12px;line-height:1.5;">
      <span style="display:block;font-size:10px;letter-spacing:0.8px;text-transform:uppercase;color:#15803d;font-weight:700;margin-bottom:4px;">Why this matches your history</span>
      ${items}
    </div>`;
  }
  if (j.qualifications) {
    const bullets = j.qualifications
      .split(/\n\s*•\s*/)
      .map((b) => b.trim())
      .filter(Boolean)
      .slice(0, 3);
    if (bullets.length) {
      const lis = bullets.map((b) => `<li style="margin-bottom:3px;">${esc(b)}</li>`).join("");
      detailBlock += `<ul class="quals" style="margin:8px 0 0;padding-left:18px;color:#334155;font-size:12px;line-height:1.55;">${lis}</ul>`;
    }
  }

  const pills: string[] = [];
  if (j.employmentType) pills.push(pill(j.employmentType, "#dbeafe", "#1e40af"));
  const sal = fmtSalary(j.salaryMin, j.salaryMax);
  if (sal) pills.push(pill(sal, "#dcfce7", "#15803d"));
  const pillRow = pills.length ? `<div style="margin-top:4px;">${pills.join("")}</div>` : "";

  return `
    <tr>
      <td class="card" style="padding:0;border-bottom:1px solid #e2e8f0;">
        <a href="${esc(j.url)}" class="card-link" style="display:block;padding:16px 24px;color:#0f172a;text-decoration:none;">
          <div style="margin-bottom:6px;line-height:1.35;">
            ${badge}<span class="title" style="color:#0f172a;font-weight:600;font-size:16px;">${esc(j.title)}</span>
          </div>
          <div class="meta" style="color:#475569;font-size:13px;line-height:1.5;">
            <span style="font-weight:600;color:#1e40af;">${esc(SITE_LABEL[j.site] || j.site)}</span>
            ${j.location ? `<span style="color:#64748b;"> · ${esc(j.location)}</span>` : ""}
            ${date}
          </div>
          ${pillRow}
          ${detailBlock}
        </a>
      </td>
    </tr>`;
}

function renderEmptyHtml(generatedAt: Date): string {
  const dateStr = generatedAt.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(DIGEST_NAME)}</title></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;border-collapse:separate;">
        <tr><td style="padding:32px 28px;background:linear-gradient(135deg,#1e3a8a 0%,#2563eb 100%);background-color:#1e40af;border-top-left-radius:12px;border-top-right-radius:12px;">
          <div style="font-size:11px;letter-spacing:1.5px;color:#bfdbfe;text-transform:uppercase;font-weight:700;">${esc(dateStr)}</div>
          <h1 style="margin:8px 0 6px 0;font-size:26px;font-weight:800;color:#ffffff;letter-spacing:-0.3px;">No new postings today</h1>
          <div style="color:#dbeafe;font-size:14px;font-weight:500;">Scraper checked all ${N_SITES} sites — nothing new since yesterday.</div>
        </td></tr>
        <tr><td style="padding:32px 28px;text-align:center;color:#475569;font-size:14px;line-height:1.6;">
          <div style="font-size:48px;line-height:1;margin-bottom:12px;">✓</div>
          <div style="font-weight:600;color:#0f172a;font-size:16px;margin-bottom:6px;">All caught up</div>
          <div>Next digest tomorrow. We'll email as soon as new entry-level research roles drop on any of the tracked sites.</div>
        </td></tr>
        <tr><td style="padding:24px 28px;background:linear-gradient(135deg,#1e3a8a 0%,#2563eb 100%);background-color:#1e40af;color:#dbeafe;font-size:12px;line-height:1.6;border-bottom-left-radius:12px;border-bottom-right-radius:12px;">
          <div style="color:#ffffff;font-weight:700;font-size:13px;margin-bottom:4px;">${esc(DIGEST_NAME)} · daily</div>
          <div>${SITE_LIST}</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function renderHtml(opts: {
  topPicks: Array<{ job: Job; score: number; isNew: boolean }>;
  others: Array<{ job: Job; score: number; isNew: boolean }>;
  totalNew: number;
  generatedAt: Date;
}): string {
  const { topPicks, others, totalNew, generatedAt } = opts;
  const dateStr = generatedAt.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  const topRows = topPicks.map(({ job, score, isNew }) => renderJobCard(job, score, isNew)).join("");
  const otherRows = others.map(({ job, score, isNew }) => renderJobCard(job, score, isNew)).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>${esc(DIGEST_NAME)}</title>
  <style>
    body { margin:0; padding:0; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    img { border:0; line-height:100%; outline:none; text-decoration:none; }
    table { border-collapse:collapse; mso-table-lspace:0pt; mso-table-rspace:0pt; }
    a { text-decoration:none; }
    .summary, .quals { word-wrap:break-word; }
    @media only screen and (max-width: 620px) {
      .summary { font-size:12px !important; }
      .quals   { font-size:11px !important; }
      .container { width:100% !important; border-radius:0 !important; }
      .wrap-pad { padding:12px 0 !important; }
      .header-pad { padding:24px 20px !important; }
      .header-title { font-size:22px !important; }
      .header-sub { font-size:13px !important; }
      .section-pad { padding:18px 20px 6px 20px !important; }
      .card { padding:0 !important; }
      .card-link { padding:14px 20px !important; }
      .title { font-size:15px !important; }
      .meta { font-size:12px !important; }
      .footer-pad { padding:20px !important; font-size:11px !important; }
      .badge { font-size:9px !important; padding:2px 6px !important; }
    }
    @media (prefers-color-scheme: dark) {
      .body-bg { background:#0f172a !important; }
      .container { background:#1e293b !important; }
      .title { color:#f1f5f9 !important; }
      .meta { color:#94a3b8 !important; }
      .card { border-bottom-color:#334155 !important; }
    }
  </style>
</head>
<body class="body-bg" style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#ffffff;opacity:0;">
    ${totalNew} new research postings — ${topPicks.length} top picks
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="wrap-pad" style="background:#ffffff;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="container" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;border-collapse:separate;">

        <!-- BLUE HEADER -->
        <tr><td class="header-pad" style="padding:32px 28px;background:linear-gradient(135deg,#1e3a8a 0%,#2563eb 100%);background-color:#1e40af;border-top-left-radius:12px;border-top-right-radius:12px;">
          <div style="font-size:11px;letter-spacing:1.5px;color:#bfdbfe;text-transform:uppercase;font-weight:700;">${esc(dateStr)}</div>
          <h1 class="header-title" style="margin:8px 0 6px 0;font-size:26px;font-weight:800;color:#ffffff;letter-spacing:-0.3px;">New research jobs</h1>
          <div class="header-sub" style="color:#dbeafe;font-size:14px;font-weight:500;">${totalNew} new posting${totalNew === 1 ? "" : "s"} · ${N_SITES} academic medical centers</div>
          ${
            topPicks.length
              ? `<div style="margin-top:14px;display:inline-block;background:rgba(255,255,255,0.18);color:#ffffff;font-size:12px;font-weight:600;padding:6px 12px;border-radius:20px;">★ ${topPicks.length} top pick${topPicks.length === 1 ? "" : "s"}</div>`
              : ""
          }
        </td></tr>

        ${
          topPicks.length
            ? `
        <tr><td class="section-pad" style="padding:22px 28px 8px 28px;">
          <div style="font-size:11px;letter-spacing:1.2px;color:#16a34a;text-transform:uppercase;font-weight:700;">★ Top picks</div>
        </td></tr>
        <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e2e8f0;">${topRows}</table></td></tr>`
            : ""
        }

        ${
          others.length
            ? `
        <tr><td class="section-pad" style="padding:22px 28px 8px 28px;">
          <div style="font-size:11px;letter-spacing:1.2px;color:#475569;text-transform:uppercase;font-weight:700;">Other new postings</div>
        </td></tr>
        <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e2e8f0;">${otherRows}</table></td></tr>`
            : ""
        }

        <!-- BLUE FOOTER -->
        <tr><td class="footer-pad" style="padding:24px 28px;background:linear-gradient(135deg,#1e3a8a 0%,#2563eb 100%);background-color:#1e40af;color:#dbeafe;font-size:12px;line-height:1.6;border-bottom-left-radius:12px;border-bottom-right-radius:12px;">
          <div style="color:#ffffff;font-weight:700;font-size:13px;margin-bottom:4px;">${esc(DIGEST_NAME)} · daily</div>
          <div>${SITE_LIST}</div>
          <div style="margin-top:6px;color:#bfdbfe;font-size:11px;">Entry-level research filter · ranked by title, recency &amp; your application history</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function sendDigest(
  newJobs: Job[],
  overrideTo?: string,
  opts?: { newIds?: Set<string> }
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = overrideTo || process.env.DIGEST_EMAIL;
  const from = process.env.FROM_EMAIL || "onboarding@resend.dev";
  // Offline preview: dump rendered HTML to a file instead of sending.
  const htmlOut = process.env.DIGEST_HTML_OUT;
  if ((!apiKey || !to) && !htmlOut) {
    console.warn("RESEND_API_KEY or recipient not set — skipping email");
    return;
  }

  const deliver = async (subject: string, html: string): Promise<void> => {
    if (htmlOut) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(htmlOut, html);
      console.log("digest html written:", htmlOut);
      return;
    }
    const resend = new Resend(apiKey!);
    const res = await resend.emails.send({ from, to: to!, subject, html });
    if (res.error) console.error("email error:", res.error);
    else console.log("email sent:", res.data?.id, "→", to);
  };

  if (newJobs.length === 0) {
    await deliver(`${DIGEST_NAME} · no new postings today`, renderEmptyHtml(new Date()));
    return;
  }

  // score + sort + balance per site
  const newIds = opts?.newIds ?? new Set(newJobs.map((j) => `${j.site}|${j.externalId}`));
  const scored = newJobs.map((j) => {
    const { score: interest, reasons } = interestScore(j);
    j.interestReasons = reasons;
    return {
      job: j,
      score: scoreJob(j) + interest, // title/recency base + interest-history boost
      isNew: newIds.has(`${j.site}|${j.externalId}`),
    };
  });
  scored.sort((a, b) => b.score - a.score);

  // Cap per-site in Top picks so one site can't dominate. Spill excess to Others.
  const MAX_PER_SITE_TOP = 5;
  const topPerSite = new Map<string, number>();
  const topPicks: typeof scored = [];
  const overflow: typeof scored = [];
  for (const s of scored) {
    if (s.score < 7) continue;
    const n = topPerSite.get(s.job.site) || 0;
    if (n < MAX_PER_SITE_TOP) {
      topPicks.push(s);
      topPerSite.set(s.job.site, n + 1);
    } else {
      overflow.push(s);
    }
  }
  // Interleave top picks across sites (round-robin) so first cards are varied.
  const bySite = new Map<string, typeof scored>();
  for (const s of topPicks) {
    const list = bySite.get(s.job.site) || [];
    list.push(s);
    bySite.set(s.job.site, list);
  }
  const interleaved: typeof scored = [];
  let remaining = true;
  while (remaining) {
    remaining = false;
    for (const list of bySite.values()) {
      const next = list.shift();
      if (next) {
        interleaved.push(next);
        remaining = true;
      }
    }
  }
  const topPicksOut = interleaved;
  const others = [...overflow, ...scored.filter((s) => s.score < 7)];

  const html = renderHtml({
    topPicks: topPicksOut,
    others,
    totalNew: newJobs.length,
    generatedAt: new Date(),
  });

  const nNew = newIds.size;
  const subject = nNew > 0
    ? `${DIGEST_NAME}: ${nNew} new${topPicksOut.length ? ` · ${topPicksOut.length} top picks` : ""}`
    : `${DIGEST_NAME} · ${topPicksOut.length} top picks`;
  await deliver(subject, html);
}

// Ops alert: the daily scrape aborted because Postgres was unreachable. Goes to ALERT_EMAIL
// (the operator) — NOT DIGEST_EMAIL — so a multi-day DB outage surfaces the same day
// instead of the digest silently going stale.
// Best-effort and self-contained: never throws, so it can't mask the original DB error.
export async function sendDbDownAlert(errMsg: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL || process.env.DIGEST_EMAIL;
  const from = process.env.FROM_EMAIL || "onboarding@resend.dev";
  if (!apiKey || !to) {
    console.warn("[alert] RESEND_API_KEY or ALERT_EMAIL/DIGEST_EMAIL unset — cannot send DB-down alert");
    return;
  }
  const when = new Date().toISOString();
  const subject = `⚠️ ${DIGEST_NAME}: database unreachable — daily scrape aborted`;
  const html =
    `<p><b>The daily scrape could not reach Postgres and aborted.</b></p>` +
    `<p>Nothing was scraped, emailed, or synced to the sheet on this run.</p>` +
    `<p><b>Error:</b> <code>${esc(errMsg)}</code><br><b>When:</b> ${when}</p>` +
    `<p><b>Likely fix</b> — Railway Postgres crashed / unclean shutdown:<br>` +
    `<code>railway redeploy --service Postgres --yes</code> (data persists on the volume),<br>` +
    `then <code>railway logs -s Postgres | tail</code> and look for "ready to accept connections".</p>`;
  try {
    const resend = new Resend(apiKey);
    const res = await resend.emails.send({ from, to, subject, html });
    if (res.error) console.error("[alert] email error:", res.error);
    else console.log("[alert] DB-down alert sent:", res.data?.id, "→", to);
  } catch (e) {
    console.error("[alert] failed to send DB-down alert:", (e as Error).message);
  }
}
