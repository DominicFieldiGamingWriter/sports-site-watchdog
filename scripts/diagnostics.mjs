const pick = (...values) => values.find(value => value !== undefined && value !== null && value !== "");
const asName = value => typeof value === "string" ? value : value?.name ?? value?.team_name ?? value?.full_name ?? null;

export function safeDiagnosticText(value, maxLength = 400) {
  return String(value ?? "")
    .replace(/https?:\/\/[^\s"'\x60<>]+/gi, url => {
      try { const parsed = new URL(url); return parsed.origin + parsed.pathname; } catch { return "[url]"; }
    })
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|sbp_[A-Za-z0-9_-]{16,}|sb_secret_[A-Za-z0-9_-]{16,})\b/gi, "[REDACTED_SECRET]")
    .replace(/([?&](?:token|key|secret|auth|email)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .slice(0, maxLength);
}

export function safeTransport(headers = {}, url = "") {
  const get = name => headers instanceof Headers ? headers.get(name) : headers[name] ?? headers[name.toLowerCase()];
  const allowed = ["date", "server", "content-type", "cache-control", "retry-after", "x-vercel-id", "x-vercel-cache", "x-matched-path", "x-vercel-deployment-url"];
  const selectedHeaders = {};
  for (const name of allowed) {
    const value = get(name);
    if (value) selectedHeaders[name] = String(value).slice(0, 300);
  }
  let safeUrl = null;
  try { const parsed = new URL(url); safeUrl = parsed.origin + parsed.pathname; } catch {}
  return { url: safeUrl, headers: selectedHeaders };
}

export function projectHealthPayload(site, payload) {
  if (!payload || typeof payload !== "object") return null;
  if (site.sport === "tennis") {
    return { ok: payload.ok ?? null, lastSyncedAt: payload.lastSyncedAt ?? null, stale: payload.stale ?? null };
  }
  const data = payload.data;
  return { ok: payload.ok ?? null, player: data?.player_name ?? null, team: data?.team_name ?? null, dataUpdatedAt: data?.updated_at ?? null };
}

function projectFootballFixture(fixture) {
  if (!fixture || typeof fixture !== "object") return null;
  const home = pick(fixture.home_team, fixture.home, fixture.teams?.home);
  const away = pick(fixture.away_team, fixture.away, fixture.teams?.away);
  return {
    id: pick(fixture.id, fixture.event_id, fixture.fixture_id) ?? null,
    scheduledAt: pick(fixture.date, fixture.event_date, fixture.kickoff_at, fixture.scheduledAt, fixture.scheduled_at) ?? null,
    status: pick(fixture.status, fixture.period, fixture.state) ?? null,
    home: asName(home) ?? fixture.home_team_name ?? fixture.home_name ?? null,
    away: asName(away) ?? fixture.away_team_name ?? fixture.away_name ?? null,
    homeScore: pick(fixture.home_score, fixture.home_team_score, fixture.score?.home) ?? null,
    awayScore: pick(fixture.away_score, fixture.away_team_score, fixture.score?.away) ?? null
  };
}

export function projectMatchPayload(site, payload) {
  if (!payload || typeof payload !== "object") return null;
  if (site.sport === "tennis") {
    return {
      ok: payload.ok ?? null,
      player: payload.player ?? null,
      sync: {
        lastSyncedAt: payload.lastSyncedAt ?? null,
        syncTimestampSource: payload.syncTimestampSource ?? null,
        canonicalDataUpdatedAt: payload.canonicalDataUpdatedAt ?? null,
        dataAgeMinutes: payload.dataAgeMinutes ?? null
      },
      ledger: { matchCount: payload.matchCount ?? null, completedSinglesCount: payload.completedSinglesCount ?? null, pendingSinglesCount: payload.pendingSinglesCount ?? null },
      latestMatch: payload.latestMatch ? {
        source: payload.latestMatch.source ?? null, sourceMatchId: payload.latestMatch.sourceMatchId ?? null,
        state: payload.latestMatch.state ?? null, tournament: payload.latestMatch.tournament ?? null,
        round: payload.latestMatch.round ?? null, playedAt: payload.latestMatch.playedAt ?? null,
        opponent: payload.latestMatch.opponent ?? null,
        ealaWon: typeof payload.latestMatch.ealaWon === "boolean" ? payload.latestMatch.ealaWon : null,
        score: payload.latestMatch.score ?? null
      } : null,
      nextFixture: payload.nextFixture ? {
        source: payload.nextFixture.source ?? null, sourceMatchId: payload.nextFixture.sourceMatchId ?? null,
        state: payload.nextFixture.state ?? null, canonicalRole: payload.nextFixture.canonicalRole ?? null,
        tournament: payload.nextFixture.tournament ?? null, round: payload.nextFixture.round ?? null,
        scheduledAt: payload.nextFixture.scheduledAt ?? null, opponent: payload.nextFixture.opponent ?? null
      } : null,
      nextEventCandidate: payload.nextEventCandidate ? {
        source: payload.nextEventCandidate.source ?? null, state: payload.nextEventCandidate.state ?? null,
        tournament: payload.nextEventCandidate.tournament ?? null, scheduledAt: payload.nextEventCandidate.scheduledAt ?? null,
        opponent: payload.nextEventCandidate.opponent ?? null
      } : null
    };
  }
  return {
    ok: payload.ok ?? null, sport: payload.sport ?? "football", player: payload.player ?? null,
    trackedTeam: payload.trackedTeam ?? null, dataUpdatedAt: payload.dataUpdatedAt ?? null,
    latestMatch: projectFootballFixture(payload.latestMatch), liveMatch: projectFootballFixture(payload.liveMatch),
    nextFixtures: Array.isArray(payload.nextFixtures) ? payload.nextFixtures.slice(0, 10).map(projectFootballFixture) : null,
    appearance: payload.appearance ?? payload.latestPlayerStatus?.appearance ?? null,
    latestPlayerStatus: payload.latestPlayerStatus ?? null, nextMatchStatus: payload.nextMatchStatus ?? null
  };
}

function candidate(area, confidence, reason, nextStep) { return { area, confidence, reason, nextStep }; }

export function buildIncidentAnalysis(site, result) {
  const failures = [
    ...(result.health?.failures ?? []).map(message => ({ source: "health", message })),
    ...(result.match?.failures ?? []).map(message => ({ source: "match", message })),
    ...(result.page?.failures ?? []).map(message => ({ source: "browser", message }))
  ];
  const candidates = [];
  const all = failures.map(item => item.message).join("\n").toLowerCase();
  if (/stale|minutes old|timestamp|dataupdatedat|lastsyncedat|data age/.test(all)) {
    candidates.push(candidate("Data refresh / ingestion", "medium", "The watchdog found a stale, missing or implausible data timestamp.", "Inspect the scheduled refresh, provider response time, sync heartbeat and last successful database write."));
  }
  if (/final score|boolean eala result|completed singles|latest completed|missing.*score|unexpected player|tracked player/.test(all)) {
    candidates.push(candidate("Provider mapping / canonical data", "medium", "A match-state field, player identity or completed-result invariant did not match the expected shape.", "Compare the source-provider response with the normalisation/mapping code and stored canonical match record."));
  }
  if (/http 5|endpoint request failed|did not return valid json|health endpoint|diagnostics endpoint/.test(all)) {
    candidates.push(candidate("Application API / serverless function", "medium", "A health or diagnostics request failed, returned a server error or produced an invalid response.", "Use the Vercel request correlation ID and runtime-log summary to inspect the failing API route and deployment."));
  }
  if (/browser raised|homepage returned|rendered page|page error|first-party website requests/.test(all)) {
    candidates.push(candidate("Frontend rendering / browser runtime", "medium", "The browser check found a navigation, rendering or uncaught JavaScript failure.", "Inspect page errors, first-party failed requests and screenshot, then trace the affected component or data dependency."));
  }
  if (/upcoming fixture|next fixture|nextfixtures|fixture.*ordered|past kickoff/.test(all)) {
    candidates.push(candidate("Fixture selection / lifecycle", "medium", "The next-fixture list contains missing, overdue, duplicated or incorrectly ordered entries.", "Inspect fixture filtering, status transitions, timezone parsing and ordering before changing the display layer."));
  }
  if (candidates.length === 0) candidates.push(candidate("Unclassified", "low", "The failure does not match a current deterministic diagnostic rule.", "Review the structured health, match, browser and platform evidence before choosing a code path."));
  return {
    mode: "deterministic-triage",
    conclusion: "These are investigation leads, not a confirmed root cause. The watchdog has not independently verified the underlying sporting fact.",
    primary: candidates[0], candidates
  };
}

function safeRoute(value) {
  if (!value) return null;
  let route = String(value);
  try {
    if (/^https?:\/\//i.test(route)) route = new URL(route).pathname;
    else route = route.split("?")[0].split("#")[0];
  } catch { route = route.split("?")[0].split("#")[0]; }
  route = route.replace(/\/(?:[0-9]{3,}|[0-9a-f]{8}-[0-9a-f-]{20,})(?=\/|$)/gi, "/:id");
  return route.slice(0, 180) || "/";
}

function parseLogRows(output) {
  const rows = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) rows.push(...parsed);
      else if (Array.isArray(parsed.logs)) rows.push(...parsed.logs);
      else if (Array.isArray(parsed.data)) rows.push(...parsed.data);
      else rows.push(parsed);
    } catch {}
  }
  return rows.filter(row => row && typeof row === "object");
}

export function summariseVercelLogs(output) {
  const rows = parseLogRows(output);
  const levels = {}, statuses = {}, routes = {};
  const recent = [];
  for (const row of rows) {
    const level = String(pick(row.level, row.type, "unknown")).toLowerCase();
    const statusValue = pick(row.statusCode, row.status_code, row.status, row.response?.statusCode);
    const statusCode = Number(statusValue);
    const route = safeRoute(pick(row.route, row.requestPath, row.path, row.request?.path));
    levels[level] = (levels[level] ?? 0) + 1;
    if (Number.isFinite(statusCode)) statuses[String(statusCode)] = (statuses[String(statusCode)] ?? 0) + 1;
    if (route) routes[route] = (routes[route] ?? 0) + 1;
    recent.push({
      timestamp: pick(row.timestamp, row.createdAt, row.created_at) ?? null,
      level, statusCode: Number.isFinite(statusCode) ? statusCode : null, route,
      deploymentId: pick(row.deploymentId, row.deployment_id) ?? null,
      requestId: pick(row.requestId, row.request_id) ?? null,
      region: pick(row.region, row.executionRegion) ?? null
    });
  }
  recent.sort((a, b) => String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")));
  const topRoutes = Object.entries(routes).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([route, count]) => ({ route, count }));
  return { status: "collected", window: "last 1 hour", totalEntries: rows.length, byLevel: levels, byStatusCode: statuses, topRoutes, recent: recent.slice(0, 10) };
}

export function classifyVercelError(error) {
  const message = String(error?.stderr ?? error?.message ?? "").toLowerCase();
  if (/unauthori[sz]ed|invalid token|authentication/.test(message)) return "Vercel token was rejected or lacks permission to read project logs.";
  if (/not found|does not exist|unknown project/.test(message)) return "Vercel project could not be found in the selected team.";
  if (/timed out|timeout/.test(message)) return "Vercel log query timed out.";
  return "Vercel runtime logs could not be retrieved. Check the token, team scope and Vercel CLI access.";
}
