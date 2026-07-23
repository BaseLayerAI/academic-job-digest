// DEV-ONLY one-time generator for the "applications" block of profile.json.
// NOT part of the daily cron.
//
// Usage:
//   1. Put the candidate's cover-letter corpus (.pdf/.docx) into ./cover-letters/ (any nesting).
//   2. `npm run extract-interests` (set ANTHROPIC_API_KEY in .env for auto-structuring).
//   3. Review the printed JSON and paste it into profile.json's "applications" array,
//      then update "interests" (researchThemes/institutions/departments) to match.
//
// Text extraction shells out to `pdftotext` (poppler) and `textutil` (macOS) — both are
// dev-machine tools, deliberately kept out of the production dependency set.
import { readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { execFileSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { PROFILE, type RoleType } from "./profile.js";

const DIR = process.argv[2] || "cover-letters";
const MODEL = "claude-haiku-4-5-20251001";
const CANDIDATE = PROFILE?.name ?? "the candidate";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if ([".pdf", ".docx"].includes(extname(p).toLowerCase())) out.push(p);
  }
  return out;
}

function extractText(path: string): string {
  try {
    if (extname(path).toLowerCase() === ".pdf") {
      return execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8", maxBuffer: 1 << 24 });
    }
    return execFileSync("textutil", ["-convert", "txt", "-stdout", path], { encoding: "utf8", maxBuffer: 1 << 24 });
  } catch (e) {
    console.error(`! could not extract ${path}: ${(e as Error).message}`);
    return "";
  }
}

// Best-effort hints from the filename; the model (or a human) refines them.
function institutionHint(file: string): string {
  const f = file.toLowerCase();
  if (f.includes("nyu")) return "NYU Langone Health";
  if (f.includes("cornell")) return "Weill Cornell Medicine";
  if (f.includes("columbia")) return "Columbia University Irving Medical Center";
  if (f.includes("sinai")) return "Icahn School of Medicine at Mount Sinai";
  if (f.includes("special surgery") || f.includes("hss")) return "Hospital for Special Surgery";
  return "";
}

const SYSTEM = `You extract structured facts from one of ${CANDIDATE}'s research-job cover letters.
Output STRICT JSON only (no prose, no fences):
{"pi": string, "institution": string, "department": string|null, "researchArea": string, "roleType": "clinical-research-coordinator"|"research-assistant"|"lab-associate"|"postbac"|"other", "angles": string[]}
- pi: the PI/lab head the letter addressed ("Dear Dr. X" → "X"), or the program/committee if unnamed.
- institution: canonical name if identifiable, else "".
- researchArea: 1 phrase describing the lab/role's focus, in the letter's framing.
- angles: 3-4 of the candidate's concrete real hooks/experiences from THIS letter (reusable for outreach).`;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function extractJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

const files = walk(DIR);
console.error(`found ${files.length} cover letters in ${DIR}/`);

type Rec = {
  pi: string; institution: string; department?: string;
  researchArea: string; roleType: RoleType; angles: string[]; sourceFile: string;
};
const records: Rec[] = [];

for (const path of files) {
  const file = basename(path);
  const text = extractText(path).replace(/\s+\n/g, "\n").trim();
  if (!text) continue;

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 600,
        system: SYSTEM,
        messages: [{ role: "user", content: `Filename: ${file}\nInstitution hint: ${institutionHint(file) || "(none)"}\n\nLetter:\n${text.slice(0, 6000)}` }],
      });
      const block = resp.content.find((b) => b.type === "text");
      const parsed = block && block.type === "text" ? extractJson(block.text) : null;
      if (parsed) {
        records.push({
          pi: String(parsed.pi ?? "").trim(),
          institution: String(parsed.institution || institutionHint(file)).trim(),
          department: parsed.department ? String(parsed.department) : undefined,
          researchArea: String(parsed.researchArea ?? "").trim(),
          roleType: (parsed.roleType as RoleType) ?? "other",
          angles: Array.isArray(parsed.angles) ? parsed.angles.map(String) : [],
          sourceFile: file,
        });
        console.error(`  ✓ ${file} → ${parsed.pi}`);
        continue;
      }
    } catch (e) {
      console.error(`  ! LLM failed on ${file}: ${(e as Error).message}`);
    }
  }
  // No key (or LLM failed): emit a stub for manual authoring, with text as a comment.
  records.push({
    pi: "TODO",
    institution: institutionHint(file),
    researchArea: `TODO — see letter preview:\n  ${text.slice(0, 400).replace(/\n/g, "\n  ")}`,
    roleType: "other",
    angles: [],
    sourceFile: file,
  });
  console.error(`  · ${file} (stub — no LLM)`);
}

// Print ready-to-review JSON to stdout (paste into profile.json "applications").
console.error(`--- generated ${records.length} application records (review before pasting into profile.json) ---`);
console.log(JSON.stringify(records, null, 2));
