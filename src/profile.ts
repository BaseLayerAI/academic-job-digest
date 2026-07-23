// Candidate profile loader. All personal data lives in profile.json (gitignored) —
// copy profile.example.json and fill it in. The daily scrape runs fine without a
// profile: PI extraction still works, but profile-driven enrichment (networking
// intel, interest-history scoring) is disabled instead of crashing.
//
// Sources, in priority order:
//   1. PROFILE_JSON env var — the raw JSON inline (handy on Railway, where the
//      gitignored file isn't in the build context).
//   2. PROFILE_PATH env var (default ./profile.json) — a JSON file on disk.
import { existsSync, readFileSync } from "node:fs";

export type RoleType =
  | "clinical-research-coordinator"
  | "research-assistant"
  | "lab-associate"
  | "postbac"
  | "other";

// One past application from the candidate's history.
export type ApplicationRecord = {
  pi: string;              // PI / lab head the application targeted ("Dear Dr. X" → "X")
  institution: string;     // canonical institution name (must match INSTITUTION_BY_SITE values to score)
  department?: string;
  researchArea: string;    // one phrase describing that lab/role's focus
  roleType?: RoleType;
  angles: string[];        // concrete, real hooks used in that application (reusable for outreach)
};

export type Interests = {
  institutions: string[];    // institutions the candidate has targeted before
  departments: string[];     // departments applied to (whole-word matched)
  researchThemes: string[];  // research themes of interest (whole-word matched)
  // Softer secondary terms per theme, used when the theme itself doesn't appear
  // verbatim in a posting. Keyed by theme (lowercase).
  relatedThemes?: Record<string, string[]>;
};

export type Profile = {
  name: string;  // used verbatim in LLM prompts
  bio: string;   // candidate background, embedded in the networking prompt
  interests?: Partial<Interests>;
  applications?: ApplicationRecord[];
};

function loadProfile(): Profile | null {
  const path = process.env.PROFILE_PATH || "profile.json";
  try {
    const raw = process.env.PROFILE_JSON ?? (existsSync(path) ? readFileSync(path, "utf8") : null);
    if (raw == null) {
      console.warn(
        `[profile] ${path} not found and PROFILE_JSON unset — running without a candidate profile. ` +
          `Networking enrichment and interest scoring are disabled. Copy profile.example.json to profile.json to enable them.`
      );
      return null;
    }
    const p = JSON.parse(raw) as Profile;
    if (!p.name || !p.bio) throw new Error(`profile must include "name" and "bio"`);
    return p;
  } catch (e) {
    console.warn(`[profile] failed to load profile: ${(e as Error).message} — profile enrichment disabled`);
    return null;
  }
}

export const PROFILE: Profile | null = loadProfile();
export const APPLICATIONS: ApplicationRecord[] = PROFILE?.applications ?? [];
export const INTERESTS: Interests = {
  institutions: PROFILE?.interests?.institutions ?? [],
  departments: PROFILE?.interests?.departments ?? [],
  researchThemes: PROFILE?.interests?.researchThemes ?? [],
  relatedThemes: PROFILE?.interests?.relatedThemes ?? {},
};

// Softer related terms for a research theme (see Interests.relatedThemes).
export function relatedThemes(theme: string): string[] {
  const map = INTERESTS.relatedThemes ?? {};
  return map[theme] ?? map[theme.toLowerCase()] ?? [];
}
