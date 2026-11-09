import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { checkFootballMatchState, checkTennisMatchState } from "./match-checks.mjs";
import { safeTransport, projectHealthPayload, projectMatchPayload, buildIncidentAnalysis, summariseVercelLogs, classifyVercelError } from "./diagnostics.mjs";

const ROOT = process.cwd();
const CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, "config/sites.json"), "utf8"));
const ARTIFACTS = path.join(ROOT, "artifacts");
const RUN_URL = process.env.GITHUB_RUN_URL || "";
const REPOSITORY = process.env.GITHUB_REPOSITORY || "";
const TOKEN = process.env.WATCHDOG_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";
const VERCEL_TOKEN = process.env.VERCEL_TOKEN || "";
const VERCEL_SCOPE = process.env.VERCEL_SCOPE || CONFIG.vercelTeamSlug || "";
const MAX_AGE_MS = Number(CONFIG.footballDataMaxAgeMinutes || 120) * 60_000;

await fs.mkdir(ARTIFACTS, { recursive: true });

function normalise(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function addFailure(result, message) {
  result.failures.push(message);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "SportsSiteWatchdog/0.1" },
      cache: "no-store",
      signal: controller.signal
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    return { status: response.status, ok: response.ok, body, text: text.slice(0, 2000), transport: safeTransport(response.headers, url) };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkHealth(site) {
  const result = { status: "unknown", url: site.healthUrl, failures: [], warnings: [], details: {} };
  try {
    const response = await fetchJson(site.healthUrl);
    result.details.httpStatus = response.status;
    result.evidence = { transport: response.transport, payload: projectHealthPayload(site, response.body) };
    if (!response.ok && site.sport !== "tennis") {
      addFailure(result, "Health endpoint returned HTTP " + response.status + ".");
      result.details.response = response.body || response.text;
      result.status = "failed";
      return result;
    }
    if (!response.body || typeof response.body !== "object") {
      addFailure(result, "Health endpoint did not return valid JSON.");
      result.status = "failed";
      return result;
    }

    const payload = response.body;
    if (site.sport === "football" && payload.ok !== true) {
      addFailure(result, "Health endpoint reported ok=false.");
    }

    if (site.sport === "football") {
      const data = payload.data;
      if (!data || typeof data !== "object") {
        addFailure(result, "Health endpoint returned no player data.");
      } else {
        result.details.playerName = data.player_name || null;
        result.details.teamName = data.team_name || null;
        result.details.updatedAt = data.updated_at || null;

        if (!normalise(data.player_name).includes(normalise(site.expectedPlayer))) {
          addFailure(result, 'Expected player "' + site.expectedPlayer + '", received "' + (data.player_name || "empty") + '".');
        }

        const updatedMs = Date.parse(data.updated_at || "");
        if (!Number.isFinite(updatedMs)) {
          addFailure(result, "Player data has no valid updated_at timestamp.");
        } else {
          const ageMs = Date.now() - updatedMs;
          result.details.dataAgeMinutes = Math.round(ageMs / 60_000);
          if (ageMs < -5 * 60_000) {
            addFailure(result, "Player data timestamp is more than five minutes in the future.");
          } else if (ageMs > MAX_AGE_MS) {
            addFailure(result, "Player data is stale: " + result.details.dataAgeMinutes + " minutes old (limit " + Math.round(MAX_AGE_MS / 60_000) + " minutes).");
          }
        }
      }
    } else {
      result.details.lastSyncedAt = payload.lastSyncedAt || null;
      result.details.stale = payload.stale ?? null;
      const maxAgeMinutes = Number(site.idleDataMaxAgeMinutes || 780);
      result.details.idleDataMaxAgeMinutes = maxAgeMinutes;
      if (!payload.lastSyncedAt || !Number.isFinite(Date.parse(payload.lastSyncedAt))) {
        addFailure(result, "Alex health endpoint returned no valid lastSyncedAt timestamp.");
      } else {
        const ageMs = Date.now() - Date.parse(payload.lastSyncedAt);
        result.details.dataAgeMinutes = Math.round(ageMs / 60_000);
        if (ageMs < -5 * 60_000) {
          addFailure(result, "Alex data timestamp is more than five minutes in the future.");
        } else if (ageMs > maxAgeMinutes * 60_000) {
          addFailure(result, "Alex tennis data is older than the configured idle-sync tolerance: " + result.details.dataAgeMinutes + " minutes (limit " + maxAgeMinutes + ").");
        } else if (response.status === 503 && payload.stale === true) {
          result.warnings.push(
            "Alex's health endpoint applies a fixed 30-minute stale threshold, but the sync function uses a dynamic cadence of up to 12 hours when idle. The last sync is within the watchdog's configured " + maxAgeMinutes + "-minute idle tolerance. Match-window-specific freshness checks are a later watchdog stage."
          );
        } else if (!response.ok || payload.ok !== true || payload.stale === true) {
          addFailure(result, "Alex health endpoint reports unhealthy tennis data for a reason other than the expected idle-sync threshold.");
        }
      }
    }
  } catch (error) {
    addFailure(result, "Health endpoint request failed: " + (error instanceof Error ? error.message : String(error)));
  }

  result.status = result.failures.length ? "failed" : "passed";
  return result;
}


async function checkMatch(site) {
  const result = {
    status: "unknown",
    url: site.matchUrl,
    failures: [],
    warnings: [],
    details: {}
  };

  if (!site.matchUrl) {
    addFailure(result, "No match diagnostics URL is configured for this site.");
    result.status = "failed";
    return result;
  }

  try {
    const response = await fetchJson(site.matchUrl);
    result.details.httpStatus = response.status;
    result.evidence = { transport: response.transport, payload: projectMatchPayload(site, response.body) };
    if (!response.ok) {
      addFailure(result, "Match diagnostics endpoint returned HTTP " + response.status + ".");
    }
    if (!response.body || typeof response.body !== "object") {
      addFailure(result, "Match diagnostics endpoint did not return valid JSON.");
    } else {
      const options = {
        expectedPlayer: site.expectedPlayer,
        maxDataAgeMinutes: Number(site.matchDataMaxAgeMinutes ??
          (site.sport === "tennis" ? site.idleDataMaxAgeMinutes : CONFIG.footballDataMaxAgeMinutes))
      };
      const checked = site.sport === "tennis"
        ? checkTennisMatchState(response.body, options)
        : checkFootballMatchState(response.body, options);
      result.failures.push(...checked.failures);
      result.warnings.push(...checked.warnings);
      result.details = { ...result.details, ...checked.details };
    }
  } catch (error) {
    addFailure(result, "Match diagnostics request failed: " +
      (error instanceof Error ? error.message : String(error)));
  }

  result.status = result.failures.length ? "failed" : "passed";
  return result;
}

async function checkPage(browser, site) {
  const result = {
    status: "unknown",
    url: site.url,
    failures: [],
    warnings: [],
    details: { consoleErrors: [], pageErrors: [], firstPartyFailures: [], firstParty5xx: [] },
    screenshot: null
  };

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const hostname = new URL(site.url).hostname;

  page.on("console", message => {
    if (message.type() === "error" && result.details.consoleErrors.length < 15) {
      result.details.consoleErrors.push(message.text().slice(0, 500));
    }
  });
  page.on("pageerror", error => result.details.pageErrors.push(error.message.slice(0, 1000)));
  page.on("requestfailed", request => {
    try {
      if (new URL(request.url()).hostname === hostname && result.details.firstPartyFailures.length < 15) {
        result.details.firstPartyFailures.push({
          url: request.url().slice(0, 500),
          error: request.failure()?.errorText || "request failed"
        });
      }
    } catch {}
  });
  page.on("response", response => {
    try {
      if (new URL(response.url()).hostname === hostname && response.status() >= 500 && result.details.firstParty5xx.length < 15) {
        result.details.firstParty5xx.push({ url: response.url().slice(0, 500), status: response.status() });
      }
    } catch {}
  });

  try {
    const response = await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    result.details.httpStatus = response?.status() ?? null;
    result.details.transport = safeTransport(response?.headers() ?? {}, page.url());
    result.details.finalUrl = page.url();
    result.details.title = await page.title().catch(() => "");
    result.details.headings = await page.locator("h1").allTextContents().catch(() => []);
    result.details.bodyTextLength = await page.locator("body").innerText().then(text => text.trim().length).catch(() => 0);

    await page.waitForTimeout(1200);
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const content = normalise(result.details.title + "\n" + result.details.headings.join("\n") + "\n" + bodyText);

    if (!response) addFailure(result, "Browser navigation returned no response.");
    else if (!response.ok()) addFailure(result, "Homepage returned HTTP " + response.status() + ".");

    if (result.details.bodyTextLength < 100) {
      addFailure(result, "Rendered page text is unexpectedly short (" + result.details.bodyTextLength + " characters).");
    }
    if (!content.includes(normalise(site.expectedPlayer))) {
      addFailure(result, 'Expected player identity "' + site.expectedPlayer + '" was not found in the rendered page.');
    }
    if (result.details.pageErrors.length) {
      addFailure(result, "Browser raised " + result.details.pageErrors.length + " uncaught page error(s).");
    }
    if (result.details.firstParty5xx.length) {
      addFailure(result, "First-party website requests returned " + result.details.firstParty5xx.length + " HTTP 5xx response(s).");
    }
    if (result.details.firstPartyFailures.length) {
      result.warnings.push("Browser recorded " + result.details.firstPartyFailures.length + " failed first-party request(s).");
    }
    if (result.details.consoleErrors.length) {
      result.warnings.push("Browser recorded " + result.details.consoleErrors.length + " console error(s); review diagnostics before treating these as defects.");
    }

    if (result.failures.length) {
      const filename = site.key + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".png";
      result.screenshot = "artifacts/" + filename;
      await page.screenshot({ path: path.join(ARTIFACTS, filename), fullPage: true }).catch(() => {
        result.screenshot = null;
      });
    }
  } catch (error) {
    addFailure(result, "Browser check failed: " + (error instanceof Error ? error.message : String(error)));
    const filename = site.key + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".png";
    result.screenshot = "artifacts/" + filename;
    await page.screenshot({ path: path.join(ARTIFACTS, filename), fullPage: true }).catch(() => {
      result.screenshot = null;
    });
  } finally {
    await page.close();
  }

  result.status = result.failures.length ? "failed" : "passed";
  return result;
}

async function findOpenAlert(site) {
  if (!TOKEN || !REPOSITORY) return null;
  const url = "https://api.github.com/repos/" + REPOSITORY + "/issues?state=open&per_page=100";
  const response = await fetch(url, {
    headers: {
      authorization: "Bearer " + TOKEN,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28"
    }
  });
  if (!response.ok) throw new Error("GitHub issue lookup failed: HTTP " + response.status);
  const issues = await response.json();
  return issues.find(issue => !issue.pull_request && issue.title === "[Watchdog] " + site.name + " site check failing") || null;
}

async function updateAlert(site, result) {
  if (!TOKEN || !REPOSITORY) {
    console.log("GitHub issue integration skipped: no GitHub token/repository environment.");
    return;
  }

  const existing = await findOpenAlert(site);
  const analysis = result.analysis || buildIncidentAnalysis(site, result);
  const failures = [
    ...result.health.failures.map(message => "- Health: " + message),
    ...result.match.failures.map(message => "- Match: " + message),
    ...result.page.failures.map(message => "- Browser: " + message)
  ];
  const body = [
    "@DominicFieldiGamingWriter — the Sports Site Watchdog has detected a problem requiring attention.\n\n## Watchdog detected a problem with " + site.name,
    "",
    "- Site: " + site.url,
    "- Detected: " + new Date().toISOString(),
    "- Health check: " + result.health.status,
    "- Match-state check: " + result.match.status,
    "- Browser check: " + result.page.status,
    "",
    "## Findings",
    ...failures,
    "",
    "## Deterministic diagnostic assessment",
    "- Primary area to investigate: " + analysis.primary.area + " (" + analysis.primary.confidence + " confidence)",
    "- Why: " + analysis.primary.reason,
    "- Suggested next check: " + analysis.primary.nextStep,
    "- Assessment: " + analysis.conclusion,
    "",
    "## Request correlation",
    "- Health endpoint: " + JSON.stringify(result.health.evidence?.transport ?? null),
    "- Match endpoint: " + JSON.stringify(result.match.evidence?.transport ?? null),
    "- Homepage: " + JSON.stringify(result.page.details.transport ?? null),
    result.evidence ? "## Sanitised evidence snapshot\n\n```json\n" + JSON.stringify(result.evidence, null, 2) + "\n```" : "",
    result.vercelDiagnostics ? "## Vercel runtime log summary\n\n```json\n" + JSON.stringify(result.vercelDiagnostics, null, 2) + "\n```" : "",
    "",
    result.health.details.dataAgeMinutes != null ? "- Health data age: " + result.health.details.dataAgeMinutes + " minutes" : "",
    Object.keys(result.match.details).length ? "## Match diagnostics\n\n```json\n" + JSON.stringify(result.match.details, null, 2) + "\n```" : "",
    result.page.screenshot ? "- Screenshot: " + result.page.screenshot + " (see the workflow artifact)" : "",
    RUN_URL ? "- Workflow run: " + RUN_URL : "",
    "",
    "This issue is maintained by the Sports Site Watchdog. It does not prove that the underlying match data is factually incorrect."
  ].filter(Boolean).join("\n");

  if (result.status === "failed" && !existing) {
    const response = await fetch("https://api.github.com/repos/" + REPOSITORY + "/issues", {
      method: "POST",
      headers: {
        authorization: "Bearer " + TOKEN,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28"
      },
      body: JSON.stringify({ title: "[Watchdog] " + site.name + " site check failing", body, assignees: ["DominicFieldiGamingWriter"] })
    });
    if (!response.ok) throw new Error("Could not create " + site.name + " alert issue: HTTP " + response.status + " " + await response.text());
    console.log("Opened watchdog alert for " + site.name + ".");
  } else if (result.status === "passed" && existing) {
    const response = await fetch("https://api.github.com/repos/" + REPOSITORY + "/issues/" + existing.number, {
      method: "PATCH",
      headers: {
        authorization: "Bearer " + TOKEN,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28"
      },
      body: JSON.stringify({
        state: "closed",
        state_reason: "completed",
        body: (existing.body || "") + "\n\n---\n\n**Recovered:** all current watchdog checks passed at " + new Date().toISOString() + ".\n\n" + (RUN_URL ? "Recovery run: " + RUN_URL : "")
      })
    });
    if (!response.ok) throw new Error("Could not close recovered " + site.name + " alert: HTTP " + response.status);
    console.log("Closed recovered watchdog alert for " + site.name + ".");
  }
}

function collectVercelDiagnostics(site) {
  if (!VERCEL_TOKEN) return { status: "not_configured", reason: "Add the VERCEL_TOKEN GitHub Actions secret to enable runtime-log collection." };
  if (!site.vercelProjectId || !VERCEL_SCOPE) return { status: "not_configured", reason: "Vercel project ID or team scope is missing from watchdog configuration." };
  const cli = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "vercel.cmd" : "vercel");
  try {
    const output = execFileSync(cli, [
      "logs", "--project", site.vercelProjectId,
      "--environment", "production", "--since", "1h",
      "--level", "error", "--level", "warning",
      "--json", "--limit", "100", "--no-branch",
      "--token", VERCEL_TOKEN, "--scope", VERCEL_SCOPE
    ], { encoding: "utf8", timeout: 25000, maxBuffer: 5 * 1024 * 1024, windowsHide: true });
    return summariseVercelLogs(output);
  } catch (error) {
    return { status: "unavailable", reason: classifyVercelError(error) };
  }
}

const browser = await chromium.launch({ headless: true });
const report = {
  version: "0.3.0",
  diagnosticMode: "evidence-first read-only",
  checkedAt: new Date().toISOString(),
  runUrl: RUN_URL || null,
  sites: []
};

try {
  for (const site of CONFIG.sites) {
    console.log("Checking " + site.name + "...");
    const health = await checkHealth(site);
    const match = await checkMatch(site);
    const page = await checkPage(browser, site);
    const result = {
      key: site.key,
      name: site.name,
      status: health.failures.length || match.failures.length || page.failures.length ? "failed" : "passed",
      health,
      match,
      page,
      evidence: {
        dataBackend: site.dataBackend || "site diagnostic endpoint",
        capturedAt: new Date().toISOString(),
        health: health.evidence || null,
        match: match.evidence || null,
        browser: {
          httpStatus: page.details.httpStatus ?? null,
          title: page.details.title ?? null,
          headings: page.details.headings ?? [],
          pageErrors: page.details.pageErrors ?? [],
          firstPartyFailures: page.details.firstPartyFailures ?? [],
          firstParty5xx: page.details.firstParty5xx ?? [],
          transport: page.details.transport ?? null
        }
      }
    };
    result.analysis = buildIncidentAnalysis(site, result);
    if (result.status === "failed") result.vercelDiagnostics = collectVercelDiagnostics(site);
    report.sites.push(result);
    await updateAlert(site, result);
    console.log(site.name + ": " + result.status);
  }
} finally {
  await browser.close();
}

await fs.writeFile(path.join(ARTIFACTS, "report.json"), JSON.stringify(report, null, 2) + "\n");

const failed = report.sites.filter(site => site.status === "failed");
console.log("\nWatchdog result: " + (report.sites.length - failed.length) + "/" + report.sites.length + " sites passed.");
if (failed.length) {
  console.error("Failures: " + failed.map(site => site.name).join(", "));
  process.exitCode = 1;
}
