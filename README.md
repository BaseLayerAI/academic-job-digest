# academic-job-digest

Daily scraper for entry-level research jobs across 6 academic-medical career sites, with LLM-enriched PI intel, Postgres dedupe, and a Resend email digest.

Runs as a Railway cron: `0 13 * * *` (13:00 UTC daily). See [docs/RUNBOOK.md](docs/RUNBOOK.md).

## How it works

```
             ┌ weillCornell ┐
             │ columbia     │   Playwright        Postgres
  cron ────► │ nyuLangone   ├──► scrape ──► filter ──► upsert+diff ──► new/unemailed
  13:00 UTC  │ mountSinai   │   (parallel)  (title      (dedupe)          │
             │ einstein     │               heuristic)                    ▼
             └ northwestern ┘                              detail-page enrich (Playwright)
                                                                          │
                                                                          ▼
                                                     PI enrich (Anthropic API):
                                                     posting-extract → web-search
                                                     resolve → networking intel
                                                                          │
                                                            PI gate (drop & retry)
                                                                          │
                                             ┌────────────────────────────┤
                                             ▼                            ▼
                                      Resend digest email       Google Sheet sync
                                      (ranked, top picks)       (optional webhook)
```

- `src/adapters/*.ts` — one adapter per career site, exports `scrape(page) -> Job[]` (6 adapters: Weill Cornell, Columbia, NYU Langone/SilkRoad, Mount Sinai/Oracle API, Einstein/iCIMS, Northwestern).
- `src/filter.ts` — entry-level-research title heuristic.
- `src/db.ts` — Postgres schema + upsert; returns only rows that are new. Also feeds the sheet.
- `src/pi.ts` — LLM enrichment: extract the PI from the posting; if unnamed, resolve via web search; then research networking angles grounded in the candidate profile.
- `src/profile.ts` — loads the gitignored `profile.json` (candidate name, bio, interests, application history). Without it the digest still runs; networking intel and interest scoring are disabled.
- `src/email.ts` — scoring, ranking, and the Resend digest.
- `src/index.ts` — orchestrates all adapters in parallel, diffs, enriches, gates, emails.

Jobs without a resolvable PI are dropped from the digest but left unmarked, so later runs retry resolution for up to 14 days ("drop & retry" carryover).

## Quickstart

```bash
git clone https://github.com/BaseLayerAI/academic-job-digest
cd academic-job-digest
npm install
npx playwright install chromium
cp .env.example .env            # fill in at least DATABASE_URL, RESEND_API_KEY, DIGEST_EMAIL, ANTHROPIC_API_KEY
cp profile.example.json profile.json   # optional: enables networking intel + interest scoring

npm run scrape                  # full run (omit DATABASE_URL for a DB-less console run)
npm run scrape weillCornell     # one site
npm run scrape -- --all         # skip the entry-level filter
SEED=1 npm run scrape           # first run: populate DB, suppress the (huge) email
```

Preview without sending: `DIGEST_HTML_OUT=digest.html npm run scrape`, or `TEST_TO=you@example.com npm run test-email` to send a cross-section from existing DB rows.

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | for dedupe/email | Postgres connection string (without it: console + snapshot only) |
| `RESEND_API_KEY` | for email | Resend API key |
| `DIGEST_EMAIL` | for email | digest recipient |
| `ANTHROPIC_API_KEY` | effectively yes | PI enrichment. **Silently disables without it** — and the strict PI gate then drops every job from the digest |
| `FROM_EMAIL` | no | sender; must be Resend-verified (dev fallback: `onboarding@resend.dev`) |
| `ALERT_EMAIL` | no | ops alerts (DB-down); falls back to `DIGEST_EMAIL` |
| `DIGEST_NAME` | no | display name in subjects/titles/footers (default `Job digest`) |
| `PROFILE_PATH` / `PROFILE_JSON` | no | candidate profile file path (default `profile.json`) or inline JSON |
| `PI_GATE_STRICT` | no | `1` (default) emails only jobs with a resolved PI; `0` emails all |
| `SEED` | no | `1` = populate DB without emailing (first run) |
| `DIGEST_HTML_OUT` | no | write digest HTML to a file instead of sending |
| `PGSSL` / `DB_SCHEMA` | no | force Postgres TLS / non-default schema |
| `SHEET_WEBHOOK_URL` / `SHEET_SYNC_SECRET` | no | Google Sheet sync via Apps Script (see `scripts/sheet-sync.gs`) |
| `TEST_TO` / `TEST_PER_SITE` | test-email only | recipient / rows per site |

## Deployment (Railway)

```bash
railway init
railway add --plugin postgres     # provisions Postgres, auto-sets DATABASE_URL
railway variables set RESEND_API_KEY=... DIGEST_EMAIL=you@example.com ANTHROPIC_API_KEY=...
railway up                        # Dockerfile build + deploy
SEED=1 railway run npm run scrape # seed the DB once
```

The cron schedule lives in `railway.toml` (`0 13 * * *`). Because `profile.json` is gitignored, supply the profile on Railway via the `PROFILE_JSON` variable (paste the JSON inline).

## Tuning the filter

Edit `src/filter.ts`. Regexes: `INCLUDE` (entry titles), `EXCLUDE` (senior/leadership), `RESEARCH` (must match research-ish), `LEVEL_ONE`/`LEVEL_MID` (roman numerals). Scoring/ranking (recency boosts, top-pick threshold, per-site caps) lives in `src/email.ts`; interest-history boosts come from the `interests` and `applications` blocks of `profile.json`.
