# Sports Site Watchdog

A scheduled, read-only monitor for:

- https://didbenplay.com/
- https://didhamzaplay.com/
- https://didalexwin.com/

## What v0.3 checks

For each website, the monitor:

- Calls the public health endpoint and checks player identity, response health and data freshness.
- Calls the read-only `/api/watchdog` endpoint and validates match lifecycle and canonical tennis ledger invariants.
- Opens the homepage in Chromium and records HTTP status, title, headings, rendered length, JavaScript errors, first-party failures and screenshots when browser checks fail.
- Captures a sanitised evidence bundle: response status, selected Vercel correlation/cache headers, player and team identifiers, data timestamps, latest result, live state, upcoming fixtures and relevant player-appearance status.
- Labels the data source used by each diagnostics endpoint. For Alex, the snapshot includes the Supabase sync heartbeat source, canonical row-update timestamp, ledger counts and latest canonical match result.
- Produces deterministic investigation leads when a site fails. These identify likely areas such as refresh/ingestion, provider mapping, API/serverless functions, fixture lifecycle or frontend rendering. They are hypotheses, not confirmed root causes.
- When a site fails and the optional `VERCEL_TOKEN` secret is present, queries the Vercel CLI for production error/warning logs from the last hour. Only aggregate metadata is retained: level/status counts, sanitised route counts, deployment/request correlation IDs and timestamps. Raw log messages are excluded from issue text and artifacts.
- Opens one GitHub issue per failing site, including the investigation lead, sanitised evidence and Vercel log summary. It closes the issue after all checks recover.
- Uploads `artifacts/report.json` and screenshots as GitHub Actions artifacts.

## Vercel runtime log integration

The Vercel CLI supports production runtime-log queries and JSON output. To enable collection during incidents, add a repository Actions secret named `VERCEL_TOKEN` with a Vercel token that can read logs for all three projects. The team scope is configured as `dominic-d7cc`.

When a failed site needs investigation and the secret is present, the watchdog invokes the pinned Vercel CLI version `65.12.1` through `npx`. Healthy five-minute runs do not install or invoke it. If the secret is absent or access is denied, monitoring continues normally and records that Vercel logs were unavailable. The token is not printed or stored in artifacts.

The collector requests the previous one hour and runs only for a site with a failed watchdog check. Vercel runtime-log retention depends on the Vercel plan.

## Supabase evidence

The Alex diagnostics endpoint reads the Supabase `eala_stats.updated_at` heartbeat and canonical match ledger. The watchdog records the heartbeat timestamp source, canonical row timestamp, record counts, latest completed result and next-fixture information. It does not use or expose a Supabase `service_role` key, nor does it run arbitrary SQL from GitHub Actions.

This is read-only evidence from the app's existing diagnostics endpoint, not a full database audit. Ben and Hamza's data sources are reported as their respective site diagnostics endpoints; no assumption is made that they use Supabase.

## Security and limitations

The watchdog repository is public. Incident snapshots exclude raw Vercel log messages, secrets, cookies, request bodies and query strings. Only allow-listed response headers and selected public match fields are stored. Vercel log aggregation excludes message text and normalises numeric/UUID URL path segments.

The deterministic assessment is not an AI diagnosis. It cannot prove that a score is factually correct without an independent authoritative source. It does not modify source records, trigger sync jobs, edit site repositories, open repair PRs or deploy code.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npx playwright install chromium
npm test
npm run monitor
```

Local runs produce `artifacts/report.json`. For optional Vercel incident-log collection, set `VERCEL_TOKEN` and `VERCEL_SCOPE`.

## GitHub Actions

The workflow runs every five minutes and can also be started manually. Pull requests run deterministic tests only; scheduled, manual and main-branch push runs perform live monitoring.

It uses the built-in `GITHUB_TOKEN` to create and close monitoring issues. The workflow needs `issues: write` permission. No Supabase secret is required for the currently exposed read-only diagnostic snapshot.
