# Sports Site Watchdog

A scheduled, read-only browser monitor for:

- https://didbenplay.com/
- https://didhamzaplay.com/
- https://didalexwin.com/

## What v0.1 checks

- HTTP response and final URL
- Page title and primary heading
- Expected player/site identity
- Non-empty rendered page content
- Browser uncaught errors and console errors
- First-party failed requests and HTTP 5xx responses
- Diagnostic screenshots and a JSON report

Every failed site check opens (or updates) one GitHub issue. When a later check passes, the corresponding alert issue is closed.

## Important limitations

This is the first monitoring layer, not the complete match-aware AI repair agent.

It does **not yet** verify match scores, lineups, red cards, odds correctness, Supabase freshness, or Vercel runtime logs. It does not modify site repositories or deploy changes.

Those checks will be added after v0.1 is running reliably, using the existing site data and protected diagnostics rather than triggering expensive provider refreshes.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npx playwright install chromium
npm test
```

## GitHub Actions

The workflow runs every five minutes and can also be started manually from the Actions tab.

It uses the built-in `GITHUB_TOKEN` to create/update/close monitoring issues. No API keys or site secrets are required for v0.1.

Required repository Actions permissions: **Read and write permissions** for issues. The workflow also declares `issues: write`.

## Interpreting alerts

A site check can fail because of a site outage, rendering problem, unexpected page change, or browser-side error. An alert is a signal to investigate, not proof that the underlying football/tennis data is wrong.

External provider request failures are recorded as warnings where possible; first-party failures are treated as check failures.

## Next development stages

1. Add player-specific match lifecycle checks (pre-match, live, post-match).
2. Read existing Vercel runtime error clusters and safe Supabase freshness diagnostics.
3. Add AI-assisted diagnosis and repair proposals on a separate branch.
4. Run tests and preview deployments; require approval before production deployment.
