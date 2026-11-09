import test from "node:test";
import assert from "node:assert/strict";
import { safeTransport, projectHealthPayload, projectMatchPayload, buildIncidentAnalysis, summariseVercelLogs, classifyVercelError } from "../scripts/diagnostics.mjs";

test("transport evidence keeps correlation headers and removes query strings", () => {
  const result = safeTransport({ "x-vercel-id": "sin1::abc", "content-type": "application/json", "set-cookie": "secret=value" }, "https://example.com/api/watchdog?token=private");
  assert.equal(result.url, "https://example.com/api/watchdog");
  assert.equal(result.headers["x-vercel-id"], "sin1::abc");
  assert.equal(result.headers["set-cookie"], undefined);
});

test("health projection keeps only whitelisted Supabase heartbeat fields", () => {
  assert.deepEqual(projectHealthPayload({ sport: "tennis" }, { ok: false, lastSyncedAt: "2026-11-09T10:00:00Z", stale: true, privateValue: "must not escape" }), {
    ok: false, lastSyncedAt: "2026-11-09T10:00:00Z", stale: true
  });
});

test("tennis match projection captures canonical ledger and sync provenance", () => {
  const result = projectMatchPayload({ sport: "tennis" }, {
    ok: true, player: "Alexandra Eala", lastSyncedAt: "2026-11-09T10:00:00Z",
    syncTimestampSource: "eala_stats.updated_at", canonicalDataUpdatedAt: "2026-11-09T09:59:00Z",
    matchCount: 477, completedSinglesCount: 364, pendingSinglesCount: 2,
    latestMatch: { source: "wta", state: "completed", ealaWon: true, score: "6-4 6-3" },
    unapprovedField: "must not escape"
  });
  assert.equal(result.sync.syncTimestampSource, "eala_stats.updated_at");
  assert.equal(result.ledger.matchCount, 477);
  assert.equal(result.latestMatch.ealaWon, true);
  assert.equal(result.unapprovedField, undefined);
});

test("football match projection normalises team names and fixture scores", () => {
  const result = projectMatchPayload({ sport: "football" }, {
    ok: true, player: "Ben Brereton",
    latestMatch: { id: 44, date: "2026-11-07T15:00:00Z", status: "finished", home: { name: "Charlton" }, away: { name: "Sheffield United" }, home_score: 2, away_score: 1 },
    nextFixtures: [{ id: 45, date: "2026-11-14T15:00:00Z", home: "Sheffield United", away: "Watford" }]
  });
  assert.equal(result.latestMatch.home, "Charlton");
  assert.equal(result.latestMatch.homeScore, 2);
  assert.equal(result.nextFixtures[0].away, "Watford");
});

test("incident analysis proposes focused leads without claiming root cause", () => {
  const result = buildIncidentAnalysis({ name: "Ben" }, {
    health: { failures: [] },
    match: { failures: ["Latest match is marked completed but its final score is missing or invalid."] },
    page: { failures: [] }
  });
  assert.equal(result.primary.area, "Provider mapping / canonical data");
  assert.match(result.conclusion, /not a confirmed root cause/);
});

test("Vercel log summariser groups logs and strips query strings and numeric IDs", () => {
  const input = [
    JSON.stringify({ level: "error", statusCode: 500, route: "/api/watchdog", requestPath: "/api/watchdog?token=secret", deploymentId: "dpl_abc", requestId: "req_abc", timestamp: "2026-11-09T10:00:00Z" }),
    JSON.stringify({ level: "warning", statusCode: 503, path: "/api/player/12345?email=user@example.com", timestamp: "2026-11-09T10:01:00Z", message: "not copied" })
  ].join("\n");
  const result = summariseVercelLogs(input);
  assert.equal(result.totalEntries, 2);
  assert.equal(result.byLevel.error, 1);
  assert.equal(result.byStatusCode["503"], 1);
  assert.equal(result.topRoutes.find(x => x.route === "/api/player/:id").count, 1);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(JSON.stringify(result).includes("user@example.com"), false);
});

test("Vercel error messages are converted to safe operator guidance", () => {
  assert.match(classifyVercelError({ stderr: "unauthorized invalid token" }), /token was rejected/);
});

test("diagnostic text redacts credentials, emails and URL query values", () => {
  const result = safeDiagnosticText("Bearer abc.def?token=leak user@example.com https://site.test/api?key=secret");
  assert.equal(result.includes("abc.def"), false);
  assert.equal(result.includes("user@example.com"), false);
  assert.equal(result.includes("key=secret"), false);
});
