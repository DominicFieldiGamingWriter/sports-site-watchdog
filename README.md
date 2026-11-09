# Sports Site Watchdog

A scheduled, read-only monitor for:

- https://didbenplay.com/
- https://didhamzaplay.com/
- https://didalexwin.com/

## What v0.2 checks

For each website, the monitor:

- Calls the site's public health endpoint and checks valid, healthy JSON.
- Checks the expected player identity and the age of the underlying data.
- Calls the read-only `/api/watchdog` match diagnostics endpoint.
- Checks Ben/Hamza's latest, live and upcoming football fixtures for IDs, dates, team names, final/live score consistency, duplicate lifecycle states and stale fixtures left in the upcoming list.
- Checks Alex's canonical tennis ledger for data freshness, completed singles results, result booleans, source labels, and next-fixture state/date consistency.
- Opens the homepage in Chromium and checks the HTTP response, title, rendered content and expected player identity.
- Captures uncaught browser errors, first-party HTTP 5xx responses and failed first-party requests.
- Saves a JSON report and screenshots when browser checks fail.

The football diagnostics endpoints expose the public match state already used by each site's page. Alex's diagnostics endpoint reads the canonical tennis ledger. These endpoints are read-only and do not trigger refresh jobs or change site data.

Every failed site check opens one GitHub issue for that site. The issue remains open while the site continues failing and is closed when all checks recover. Alerts include match-state findings and a compact diagnostic summary. Browser screenshots and the JSON report are uploaded as a workflow artifact.

## Scope and limitations

Match-aware checks validate the structure, lifecycle and freshness of the data currently stored by each site. They do **not** independently verify match scores against a second live sports-data provider. They also do not yet inspect Vercel runtime-error clusters, run broader Supabase table diagnostics, verify every lineup/substitution/red-card detail, or compare WTA and Bornan source records independently.

A warning means the watchdog found something worth reviewing but does not yet treat it as a confirmed fault. An alert is evidence that a defined check failed, not proof that the underlying sporting fact is wrong.

The monitor is read-only. It does not trigger football/WTA refresh jobs, modify the three site repositories, push code or deploy changes.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npx playwright install chromium
npm test
npm run monitor
```

Local runs produce `artifacts/report.json`. GitHub issue alerts are enabled automatically inside GitHub Actions; local runs need `WATCHDOG_GITHUB_TOKEN` and `GITHUB_REPOSITORY` environment variables for issue integration.

## GitHub Actions

The workflow runs every five minutes and can also be started manually from the Actions tab. GitHub may delay scheduled runs during busy periods.

Pull requests run the deterministic match-lifecycle test suite. The monitoring job runs only on scheduled, manual and main-branch push events, not on pull requests.

It uses the built-in `GITHUB_TOKEN` to create and close monitoring issues. No API keys or site secrets are required for v0.2.

The workflow declares `issues: write` permission. If repository settings override workflow token permissions, enable read/write permissions for Actions.

## Interpreting alerts

An alert means one or more defined checks failed. It is a signal to investigate, not proof that the underlying match information is factually incorrect.

Console errors and failed first-party requests are captured as warnings unless they meet a defined failure condition. External provider failures are not automatically treated as website defects.
