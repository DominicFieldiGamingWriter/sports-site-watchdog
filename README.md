# Sports Site Watchdog

A scheduled, read-only monitor for:

- https://didbenplay.com/
- https://didhamzaplay.com/
- https://didalexwin.com/

## What v0.1 checks

For each website, the monitor:

- Calls the site's existing public health endpoint.
- Checks that the health endpoint returns valid, healthy JSON.
- Checks the expected player identity.
- Checks Ben/Hamza's Supabase-backed `updated_at` timestamp (maximum age: 120 minutes).
- Checks Alex's existing health endpoint and allows up to 13 hours of idle data age, matching the function's 12-hour idle cadence plus a 1-hour scheduling margin. Its existing endpoint has a fixed 30-minute stale threshold, which is stricter than the actual idle sync schedule.
- Opens the homepage in Chromium and checks the HTTP response, title, rendered content and expected player identity.
- Captures uncaught browser errors, first-party HTTP 5xx responses and failed first-party requests.
- Saves a JSON report and screenshots when browser checks fail.

Every failed site check opens one GitHub issue for that site. The issue remains open while the site continues failing and is closed when checks recover. Browser screenshots and the JSON report are uploaded as a workflow artifact.

## Important limitations

This is the first monitoring layer, not yet the complete match-aware AI repair agent.

It does **not yet** verify whether match scores, lineups, red cards, substitutions, odds or tournament progression are factually correct. It does not yet inspect Vercel runtime error clusters or perform broader direct Supabase table diagnostics. Alex's idle-data tolerance is a temporary schedule-aware rule; match-window-specific tennis freshness checks still need to be added.

The monitor does not trigger football/WTA refresh jobs, modify the three site repositories, push code or deploy changes. It uses existing health endpoints and rendered pages to avoid consuming additional sports-data API quota.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npx playwright install chromium
npm run monitor
```

Local runs produce `artifacts/report.json`. GitHub issue alerts are enabled automatically inside GitHub Actions; local runs need `WATCHDOG_GITHUB_TOKEN` and `GITHUB_REPOSITORY` environment variables for issue integration.

## GitHub Actions

The workflow runs every five minutes and can also be started manually from the Actions tab. GitHub may delay scheduled runs during busy periods.

It uses the built-in `GITHUB_TOKEN` to create and close monitoring issues. No API keys or site secrets are required for v0.1.

The workflow declares `issues: write` permission. If repository settings override workflow token permissions, enable read/write permissions for Actions.

## Interpreting alerts

An alert means one or more defined checks failed. It is a signal to investigate, not proof that the underlying match information is factually wrong.

Console errors and failed first-party requests are captured as warnings unless they meet a defined failure condition. External provider failures are not automatically treated as website defects.

## Next development stages

1. Add match lifecycle tests for pre-match, live and post-match states.
2. Add safe Vercel runtime-error diagnostics and broader Supabase freshness checks.
3. Add AI-assisted diagnosis and repair proposals on a separate branch.
4. Run tests and Vercel preview deployments; require approval before production deployment.
