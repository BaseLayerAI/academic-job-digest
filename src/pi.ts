import Anthropic from "@anthropic-ai/sdk";
import type { Job } from "./types.js";
import { PROFILE, APPLICATIONS } from "./profile.js";

const MODEL = "claude-haiku-4-5-20251001";
// Web-research model for PI resolution + networking intel. Sonnet 4.6 cuts cost on
// high-volume daily runs (~40% cheaper than Opus) and still supports the
// web_search_20260209 tool with dynamic filtering. Swap to "claude-opus-4-8" for the
// best synthesis if quality matters more than cost. (Haiku doesn't support this tool.)
const NETWORKING_MODEL = "claude-sonnet-4-6";

// Canonical institution per scraped site. Shared by PI resolution, networking, and
// interest scoring (email.ts) so they all compare against the same strings.
export const INSTITUTION_BY_SITE: Record<string, string> = {
  weillCornell: "Weill Cornell Medicine",
  columbia: "Columbia University Irving Medical Center",
  nyuLangone: "NYU Langone Health",
  mountSinai: "Icahn School of Medicine at Mount Sinai",
  einstein: "Albert Einstein College of Medicine",
  northwestern: "Northwestern University",
};
const institutionOf = (site: string): string => INSTITUTION_BY_SITE[site] || site;

export type PIInfo = { piName?: string; piResearch?: string };

export type PIResolution = {
  piName?: string;
  piResearch?: string;
  piConfidence?: "high" | "medium" | "low";
  piContactPath?: string;
};

export type PINetworking = {
  piExperience?: string;
  piLocation?: string;
  piNetworking?: string;
  piContactPath?: string;
};

const SYSTEM = `You extract Principal Investigator (PI) info for biomedical research job postings.

Given a job posting (title, department, institution, position summary), do BOTH:
1. piName: identify the SPECIFIC PI / lab head for this role. Use ONLY names explicitly named in the posting text (e.g. "Dr. Goosens Lab"), or, if the posting names a specific named lab/center with a well-known single director, give that director's name. If no specific PI can be determined with high confidence, set piName to null. DO NOT guess. Department chairs or generic institutional leaders do NOT count.
2. piResearch: ONLY if piName is non-null, give 1-2 sentences (max 240 chars) describing THAT specific PI's lab research focus. Must be specific to the named PI's work, not a generic department/hospital description. If piName is null, set piResearch to null.

Output STRICT JSON only: {"piName": string|null, "piResearch": string|null}
No prose, no markdown fences.`;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function fetchPI(job: Job): Promise<PIInfo> {
  if (!process.env.ANTHROPIC_API_KEY) return {};
  const institution = institutionOf(job.site);

  const user = [
    `Institution: ${institution}`,
    `Title: ${job.title}`,
    job.department ? `Department: ${job.department}` : "",
    job.location ? `Location: ${job.location}` : "",
    job.url ? `URL: ${job.url}` : "",
    job.summary ? `Position summary: ${job.summary}` : "",
    job.qualifications ? `Qualifications: ${job.qualifications}` : "",
  ].filter(Boolean).join("\n");

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    });
    const block = resp.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return {};
    const text = block.text.trim().replace(/^```(?:json)?|```$/g, "").trim();
    const parsed = JSON.parse(text) as { piName: string | null; piResearch: string | null };
    if (!parsed.piName) return {};
    return {
      piName: parsed.piName,
      piResearch: parsed.piResearch || undefined,
    };
  } catch (e) {
    console.warn("pi fetch failed:", job.site, job.externalId, (e as Error).message);
    return {};
  }
}

// Name used in prompts — taken from the loaded profile; generic fallback keeps
// the non-profile paths (posting extraction, web resolution) working unchanged.
const CANDIDATE = PROFILE?.name ?? "the candidate";

const NETWORKING_SYSTEM = `You are a networking strategist helping a specific job candidate, ${CANDIDATE}, connect with the Principal Investigator (PI) / lab head behind a research job posting they are considering.

${CANDIDATE}'s background:
${PROFILE?.bio ?? ""}

You are given a named PI and their institution. Use the web_search tool to research THAT specific person (confirm you have the right individual — match name + institution + field). Then output THREE things grounded in real, verifiable findings:

1. piExperience: 1-2 sentences on the PI's career background — training (PhD/postdoc, where), prior institutions, and current title/role. Facts only, from what you find.
2. piLocation: the PI's current institution and city (e.g. "Icahn School of Medicine at Mount Sinai — New York, NY"). If they have moved, give the current one.
3. piNetworking: 2-3 SPECIFIC, actionable ways THIS candidate can connect with THIS PI. Ground each in a real overlap between the candidate's background and the PI's work. You are given "real past angles" in the user message — these are authentic hooks the candidate has actually used; prefer grounding suggestions in those over inventing new ones. Reference a concrete recent paper or project the candidate could mention, an alumni or collaborator link drawn from the candidate's background, a conference or seminar where they'd both plausibly appear, or a warm-intro path through a named collaborator. Be concrete (name the paper, the link, the hook). Avoid generic advice like "send a polite email."
4. piContactPath: the single most concrete way ${CANDIDATE} can actually reach this PI today — a lab website contact page, a faculty-directory URL, the institutional email pattern (e.g. "firstname.lastname@mssm.edu"), or a LinkedIn profile. Real/verifiable only.

Rules:
- Use ONLY facts you verify via web_search. Do not invent affiliations, papers, connections, or contact details.
- If you cannot confidently identify this PI as a real, specific person, set ALL fields to null.
- Keep each field under ~320 chars.

After your research, output STRICT JSON only as your final message — no prose, no markdown fences:
{"piExperience": string|null, "piLocation": string|null, "piNetworking": string|null, "piContactPath": string|null}`;

// Scan from `start` for a complete JSON object, counting braces while respecting
// string literals and escapes (so braces inside values — e.g. "{first}.{last}@x.edu"
// — don't truncate the match). Returns the {...} span or null.
function balancedObjectAt(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Pull the last JSON object containing the given key out of a web_search transcript
// (which may contain other braces / prose). Robust to braces inside string values.
function extractJsonByKey<T = Record<string, string | null>>(text: string, key: string): T | null {
  const needle = `"${key}"`;
  for (let pos = text.lastIndexOf(needle); pos !== -1; pos = text.lastIndexOf(needle, pos - 1)) {
    const open = text.lastIndexOf("{", pos);
    if (open === -1) break;
    const raw = balancedObjectAt(text, open);
    if (raw) {
      try {
        return JSON.parse(raw) as T;
      } catch {
        // keep searching earlier occurrences
      }
    }
    if (pos === 0) break;
  }
  return null;
}

export async function fetchPINetworking(job: Job, piName: string): Promise<PINetworking> {
  // Networking intel is grounded in the candidate profile — skip when none is loaded.
  if (!process.env.ANTHROPIC_API_KEY || !PROFILE) return {};
  const institution = institutionOf(job.site);
  const angles = relevantAngles(job, piName);

  const user = [
    `PI: ${piName}`,
    `Institution: ${institution}`,
    job.department ? `Department: ${job.department}` : "",
    job.piResearch ? `Known research focus: ${job.piResearch}` : "",
    `Job title ${CANDIDATE} is considering: ${job.title}`,
    angles.length
      ? `${CANDIDATE}'s real past application angles relevant to this PI/area (use these as authentic hooks; do not invent new ones):\n- ${angles.join("\n- ")}`
      : "",
    `Research this PI and produce the networking JSON for ${CANDIDATE}.`,
  ].filter(Boolean).join("\n");

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];

  try {
    let resp;
    // Server-side web_search runs its own loop; continue on pause_turn.
    for (let i = 0; i < 4; i++) {
      resp = await client.messages.create({
        model: NETWORKING_MODEL,
        max_tokens: 2000,
        system: [{ type: "text", text: NETWORKING_SYSTEM, cache_control: { type: "ephemeral" } }],
        tools: [{ type: "web_search_20260209", name: "web_search" }],
        messages,
      });
      if (resp.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: resp.content });
    }
    if (!resp) return {};
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const parsed = extractJsonByKey<{
      piExperience: string | null;
      piLocation: string | null;
      piNetworking: string | null;
      piContactPath: string | null;
    }>(text, "piNetworking");
    if (!parsed || !parsed.piNetworking) return {};
    return {
      piExperience: parsed.piExperience || undefined,
      piLocation: parsed.piLocation || undefined,
      piNetworking: parsed.piNetworking || undefined,
      piContactPath: parsed.piContactPath || undefined,
    };
  } catch (e) {
    console.warn("pi networking fetch failed:", job.site, job.externalId, (e as Error).message);
    return {};
  }
}

// Pick the candidate's most relevant real past angles for this PI/job, drawn from their
// application history. Weighted: same target PI surname >> overlapping research area > same department.
function relevantAngles(job: Job, piName: string): string[] {
  const last = piName.split(/\s+/).pop()?.toLowerCase() ?? "";
  const hay = `${job.title} ${job.department ?? ""} ${job.piResearch ?? ""}`.toLowerCase();
  const dept = (job.department ?? "").toLowerCase();
  const ranked = APPLICATIONS
    .map((a) => {
      let w = 0;
      if (last && a.pi.toLowerCase().split(/[\s/]+/).includes(last)) w += 5;
      const areaHead = a.researchArea.toLowerCase().split(/[,;]/)[0].trim();
      if (areaHead && hay.includes(areaHead)) w += 3;
      // Bidirectional: live departments are verbose ("Research / Psychiatry",
      // "Org Unit: Department of Neurology") while stored ones are short ("Psychiatry").
      const norm = (x: string) => x.toLowerCase().replace(/^(research \/|org unit:|department of)\s*/i, "").trim();
      const ad = a.department ? norm(a.department) : "";
      const ld = norm(dept);
      if (ad && ld && (ad.includes(ld) || ld.includes(ad))) w += 1;
      return { a, w };
    })
    .filter((x) => x.w > 0)
    .sort((x, y) => y.w - x.w);
  // Distinct angles, most relevant first; cap to keep the prompt tight.
  return [...new Set(ranked.flatMap((x) => x.a.angles))].slice(0, 4);
}

const RESOLVE_SYSTEM = `You identify the Principal Investigator (PI) / lab head behind a biomedical research job posting that does NOT explicitly name one. The candidate wants a specific person to direct outreach to.

You are given a job: institution, title, department, and any summary/qualifications. Use the web_search tool to find the most plausible specific person responsible for this role. In priority order:
1. A named lab whose research matches the posting, in that department at that institution — give its PI.
2. A center / program / study director whose work matches the role.
3. The named hiring contact or research manager for the posting, if findable.

Set piConfidence:
- "high": the department/role maps to a single clearly-named lab head you verified.
- "medium": inferred from a department + research-focus match (a strong best guess).
- Never output a person below medium confidence — return null instead. NEVER fabricate a name.

Also produce:
- piResearch: 1-2 sentences (max 240 chars) on that person's/lab's research focus, from what you find.
- piContactPath: the single most concrete way to reach them — lab contact page, faculty-directory URL, institutional email pattern (e.g. "firstname.lastname@mssm.edu"), or LinkedIn. Real/verifiable only.

If no specific person can be identified with at least medium confidence, set ALL fields to null.

After your research, output STRICT JSON only as your final message — no prose, no markdown fences:
{"piName": string|null, "piResearch": string|null, "piConfidence": "high"|"medium"|"low"|null, "piContactPath": string|null}`;

// Web-search resolution for jobs whose posting names no PI. Mirrors the fetchPINetworking
// machinery (Opus + web_search, pause_turn continuation). Conservative: returns {} unless a
// person can be identified with >= medium confidence.
export async function resolvePIWeb(job: Job): Promise<PIResolution> {
  if (!process.env.ANTHROPIC_API_KEY) return {};
  const institution = institutionOf(job.site);

  const user = [
    `Institution: ${institution}`,
    `Title: ${job.title}`,
    job.department ? `Department: ${job.department}` : "",
    job.location ? `Location: ${job.location}` : "",
    job.url ? `URL: ${job.url}` : "",
    job.summary ? `Position summary: ${job.summary}` : "",
    job.qualifications ? `Qualifications: ${job.qualifications}` : "",
    `Find the specific PI / lab head / study director / hiring contact for this role.`,
  ].filter(Boolean).join("\n");

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];

  try {
    let resp;
    for (let i = 0; i < 4; i++) {
      resp = await client.messages.create({
        model: NETWORKING_MODEL,
        max_tokens: 2000,
        system: [{ type: "text", text: RESOLVE_SYSTEM, cache_control: { type: "ephemeral" } }],
        tools: [{ type: "web_search_20260209", name: "web_search" }],
        messages,
      });
      if (resp.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: resp.content });
    }
    if (!resp) return {};
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const parsed = extractJsonByKey<{
      piName: string | null;
      piResearch: string | null;
      piConfidence: "high" | "medium" | "low" | null;
      piContactPath: string | null;
    }>(text, "piName");
    if (!parsed || !parsed.piName || parsed.piConfidence === "low") return {};
    return {
      piName: parsed.piName,
      piResearch: parsed.piResearch || undefined,
      piConfidence: parsed.piConfidence || "medium",
      piContactPath: parsed.piContactPath || undefined,
    };
  } catch (e) {
    console.warn("pi resolve failed:", job.site, job.externalId, (e as Error).message);
    return {};
  }
}
