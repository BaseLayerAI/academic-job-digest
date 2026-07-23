export type Job = {
  site: string;
  externalId: string;
  title: string;
  location: string;
  url: string;
  postedAt?: string;
  employmentType?: string;   // "Full-time" | "Part-time" | "Per Diem" | "Temporary"
  salaryMin?: number;
  salaryMax?: number;
  department?: string;
  summary?: string;        // ~300-char position summary
  qualifications?: string; // top 3 bullets joined by "\n• "
  piName?: string;
  piResearch?: string;
  piExperience?: string;   // PI's career background (web-researched)
  piLocation?: string;     // PI's current institution + city (web-researched)
  piNetworking?: string;   // how the candidate can network to this PI (web-researched)
  // PI provenance — how piName was determined (posting-named vs web-resolved).
  piSource?: "posting" | "web" | "none";
  piConfidence?: "high" | "medium" | "low";
  piContactPath?: string;  // concrete reach-out path: lab site / faculty directory / email pattern / LinkedIn
  // Interest-history match (computed at enrich/render time from the profile — see profile.ts).
  interestReasons?: string[]; // "why this matches your history" bullets
};

import type { Page } from "playwright";

export type Adapter = {
  site: string;
  startUrl: string;
  scrape: (page: Page) => Promise<Job[]>;
};
