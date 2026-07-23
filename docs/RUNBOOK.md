# Runbook — academic-job-digest

## Where it runs

A Railway cron service built from this repo's `Dockerfile`. `railway.toml` sets
`cronSchedule = "0 13 * * *"` (13:00 UTC daily) with `restartPolicyType = "NEVER"` —
each run is a one-shot container; there is no retry at the platform level.

A Railway Postgres plugin in the same project provides `DATABASE_URL`. All state
lives in that one `jobs` table; the container itself is stateless.

## Trigger mechanism

Railway starts the container on the cron schedule and runs `npx tsx src/index.ts`
(the Dockerfile `CMD`). The run scrapes all adapters in parallel, upserts into
Postgres, enriches new/unemailed jobs (detail pages + LLM PI resolution), sends
the digest via Resend, and pushes the dataset to the Google Sheet webhook.

Manual run: `railway run npm run scrape`, or redeploy-and-run from the dashboard.

## Credentials

| Credential | Used for | Rotation |
|---|---|---|
| `DATABASE_URL` | Postgres dedupe/state | Managed by Railway; rotate by re-provisioning the plugin |
| `RESEND_API_KEY` | digest + alert email | Create a new key in the Resend dashboard, update the Railway variable, delete the old key |
| `ANTHROPIC_API_KEY` | PI enrichment (extraction, web search, networking) | Create a new key in the Anthropic console, update the Railway variable, delete the old key |
| `SHEET_SYNC_SECRET` | authorizes sheet webhook writes | Change `SECRET` in the Apps Script, redeploy the web app, update the Railway variable |
| `PROFILE_JSON` / `profile.json` | candidate profile (personal data, not a secret per se) | Edit and redeploy; never commit it |

## Failure signatures

- **DB unreachable**: the run aborts early and sends a "database unreachable —
  daily scrape aborted" email to `ALERT_EMAIL`. Typical cause: Postgres service
  crashed or private networking was slow to come up (the code already retries the
  initial connect 8 times).
  Recovery: `railway redeploy --service Postgres --yes`, confirm
  "ready to accept connections" in `railway logs -s Postgres`, then re-run the scrape.
- **Digest arrives but is empty every day / jobs vanish**: `ANTHROPIC_API_KEY`
  missing or invalid — PI enrichment silently disables and the strict PI gate
  (`PI_GATE_STRICT=1`, the default) drops every job. Check the run logs for
  `[pi-gate] 0/N have a PI`. Fix the key, or set `PI_GATE_STRICT=0` temporarily.
- **One adapter shows `ERROR:` in the run summary**: the site changed its markup
  or API. The other sites still deliver; fix the adapter in `src/adapters/`.
  Unemailed jobs are carried over and retried for 14 days, so nothing is lost
  while an adapter is down.
- **No email at all, no alert**: check `RESEND_API_KEY` / `DIGEST_EMAIL` are set
  (the run logs `RESEND_API_KEY or recipient not set — skipping email`), and that
  `FROM_EMAIL` is on a Resend-verified domain.

## Recovery steps

1. `railway logs` on the cron service — the summary table at the top of each run
   shows per-site kept/total or the error message.
2. If the DB was down for N days, no data was lost upstream: the next successful
   run re-scrapes live postings, and the 14-day carryover re-surfaces anything
   that was never emailed.
3. To resend today's digest after a partial failure:
   `railway run npm run replay-today -- you@example.com`.
4. First-time (or post-wipe) seeding without a giant email:
   `SEED=1 railway run npm run scrape`.
