const FINAL = new Set(["finished", "finish", "complete", "completed", "fulltime", "ft", "ended"]);
const LIVE = new Set(["live", "inplay", "inprogress", "1h", "1sthalf", "firsthalf", "ht", "halftime", "2h", "2ndhalf", "secondhalf", "et", "extratime", "overtime", "pens", "penalties", "penaltyshootout"]);
const token = value => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
const time = value => typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
const matchTime = f => time(f?.date ?? f?.event_date ?? f?.kickoff_at ?? f?.scheduledAt ?? f?.scheduled_at ?? f?.playedAt ?? f?.played_at ?? f?.time?.kickoff_at ?? f?.time?.start_time);
const status = f => token(f?.status ?? f?.time?.status ?? f?.state);
const team = (f, side) => {
  const v = f?.[side + "_team"] ?? f?.[side] ?? f?.teams?.[side] ?? f?.participants?.[side];
  return String((typeof v === "string" ? v : v?.name ?? v?.team_name ?? v?.full_name) ?? f?.[side + "_team_name"] ?? f?.[side + "_name"] ?? "").trim();
};
const score = (f, side) => {
  const v = f?.[side + "_score"] ?? f?.score?.[side] ?? f?.scores?.[side] ?? f?.[side + "_team_score"];
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const fail = (r, message) => r.failures.push(message);
const warn = (r, message) => r.warnings.push(message);
const done = r => ({ ...r, status: r.failures.length ? "failed" : "passed" });

export function checkFootballMatchState(s, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAge = Number(options.maxDataAgeMinutes ?? 120);
  const r = { status: "unknown", failures: [], warnings: [], details: {} };
  if (!s || typeof s !== "object") { fail(r, "Match diagnostics did not return a JSON object."); return done(r); }
  if (s.ok !== true) fail(r, "Football match diagnostics reported ok=false.");
  const player = String(s.player ?? "").trim();
  r.details.player = player || null;
  if (!player) fail(r, "Football diagnostics did not identify the tracked player.");
  else if (options.expectedPlayer && !player.toLowerCase().includes(String(options.expectedPlayer).toLowerCase())) fail(r, "Football diagnostics identified an unexpected player: " + player + ".");
  const updated = time(s.dataUpdatedAt);
  if (!Number.isFinite(updated)) fail(r, "Football diagnostics returned no valid dataUpdatedAt timestamp.");
  else {
    const age = Math.round((now - updated) / 60000);
    r.details.dataAgeMinutes = age;
    if (age < -5) fail(r, "Football dataUpdatedAt is more than five minutes in the future.");
    else if (age > maxAge) fail(r, "Football match data is " + age + " minutes old (limit " + maxAge + ").");
  }

  const latest = s.latestMatch;
  if (!latest || typeof latest !== "object") fail(r, "No latest completed football match is available.");
  else {
    const id = latest.id ?? latest.event_id ?? latest.fixture_id ?? null;
    const at = matchTime(latest), st = status(latest), home = team(latest, "home"), away = team(latest, "away");
    const hs = score(latest, "home"), as = score(latest, "away");
    r.details.latestMatch = { id, date: Number.isFinite(at) ? new Date(at).toISOString() : null, status: st || null, home, away, score: hs !== null && as !== null ? hs + "-" + as : null };
    if (id === null || id === "") fail(r, "Latest football match has no fixture ID.");
    if (!Number.isFinite(at)) fail(r, "Latest football match has no valid date.");
    if (!home || !away) fail(r, "Latest football match is missing a home or away team name.");
    if (FINAL.has(st) && (hs === null || as === null)) fail(r, "Latest match is marked completed but its final score is missing or invalid.");
    else if (!FINAL.has(st)) warn(r, "Latest stored match status is not a recognised final status: " + (st || "empty") + ".");
  }

  const live = s.liveMatch;
  if (live !== null && live !== undefined) {
    if (typeof live !== "object") fail(r, "Live match is present but is not a fixture object.");
    else {
      const id = live.id ?? live.event_id ?? live.fixture_id ?? null;
      const at = matchTime(live), st = status(live), home = team(live, "home"), away = team(live, "away");
      const hs = score(live, "home"), as = score(live, "away");
      r.details.liveMatch = { id, date: Number.isFinite(at) ? new Date(at).toISOString() : null, status: st || null, home, away, score: hs !== null && as !== null ? hs + "-" + as : null, minute: live.current_minute ?? live.minute ?? live.time?.minute ?? null };
      if (id === null || id === "") fail(r, "Live football match has no fixture ID.");
      if (!Number.isFinite(at)) fail(r, "Live football match has no valid kickoff date.");
      if (!home || !away) fail(r, "Live football match is missing team names.");
      if (FINAL.has(st)) fail(r, "A completed fixture is still exposed as the live match.");
      if (hs === null || as === null) fail(r, "Live football match is missing a valid home or away score.");
      if (st && !LIVE.has(st)) warn(r, "Live-match field contains an unfamiliar status token: " + st + ".");
      if (latest && id !== null && String(id) === String(latest.id ?? latest.event_id ?? latest.fixture_id ?? "")) fail(r, "The same fixture is exposed as both the live match and latest completed match.");
    }
  } else r.details.liveMatch = null;

  if (!Array.isArray(s.nextFixtures)) fail(r, "Football diagnostics did not return a nextFixtures array.");
  else {
    let previous = -Infinity;
    r.details.nextFixtures = [];
    for (const [i, f] of s.nextFixtures.entries()) {
      if (!f || typeof f !== "object") { fail(r, "Upcoming fixture at position " + (i + 1) + " is not an object."); continue; }
      const id = f.id ?? f.event_id ?? f.fixture_id ?? null, at = matchTime(f), home = team(f, "home"), away = team(f, "away");
      if (id === null || id === "") fail(r, "Upcoming fixture at position " + (i + 1) + " has no fixture ID.");
      if (!Number.isFinite(at)) fail(r, "Upcoming fixture at position " + (i + 1) + " has no valid date.");
      else {
        if (at < now - 6 * 60 * 60 * 1000) fail(r, "Upcoming fixture " + (id ?? i + 1) + " is more than six hours past kickoff but remains in nextFixtures.");
        if (at < previous) fail(r, "Upcoming fixtures are not ordered by kickoff time.");
        previous = at;
      }
      if (!home || !away) fail(r, "Upcoming fixture at position " + (i + 1) + " is missing team names.");
      r.details.nextFixtures.push({ id, date: Number.isFinite(at) ? new Date(at).toISOString() : null, home, away });
      const liveId = live?.id ?? live?.event_id ?? live?.fixture_id ?? null;
      if (liveId !== null && id !== null && String(liveId) === String(id)) fail(r, "A fixture appears in both liveMatch and nextFixtures.");
    }
  }
  return done(r);
}

export function checkTennisMatchState(s, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAge = Number(options.maxDataAgeMinutes ?? 780);
  const r = { status: "unknown", failures: [], warnings: [], details: {} };
  if (!s || typeof s !== "object") { fail(r, "Tennis match diagnostics did not return a JSON object."); return done(r); }
  if (s.ok !== true) fail(r, "Tennis match diagnostics reported ok=false.");
  const player = String(s.player ?? "").trim();
  r.details.player = player || null;
  if (!player) fail(r, "Tennis diagnostics did not identify the tracked player.");
  else if (options.expectedPlayer && !player.toLowerCase().includes(String(options.expectedPlayer).toLowerCase())) fail(r, "Tennis diagnostics identified an unexpected player: " + player + ".");
  const synced = time(s.lastSyncedAt);
  if (!Number.isFinite(synced)) fail(r, "Tennis diagnostics returned no valid lastSyncedAt timestamp.");
  else {
    const age = Math.round((now - synced) / 60000);
    r.details.dataAgeMinutes = age;
    if (age < -5) fail(r, "Tennis canonical data timestamp is more than five minutes in the future.");
    else if (age > maxAge) fail(r, "Tennis canonical data is " + age + " minutes old (limit " + maxAge + ").");
  }
  const total = Number(s.matchCount), completed = Number(s.completedSinglesCount);
  r.details.matchCount = Number.isFinite(total) ? total : null;
  r.details.completedSinglesCount = Number.isFinite(completed) ? completed : null;
  if (!Number.isFinite(total) || total < 1) fail(r, "Canonical tennis ledger contains no match records.");
  if (!Number.isFinite(completed) || completed < 1) fail(r, "Canonical tennis ledger contains no completed singles matches.");
  if (Number.isFinite(total) && Number.isFinite(completed) && completed > total) fail(r, "Completed singles count exceeds the total canonical match count.");

  const latest = s.latestMatch;
  if (!latest || typeof latest !== "object") fail(r, "No latest completed singles match is available.");
  else {
    const at = time(latest.playedAt ?? latest.scheduledAt);
    r.details.latestMatch = { source: latest.source ?? null, sourceMatchId: latest.sourceMatchId ?? null, state: latest.state ?? null, tournament: latest.tournament ?? null, round: latest.round ?? null, date: Number.isFinite(at) ? new Date(at).toISOString() : null, opponent: latest.opponent ?? null, ealaWon: typeof latest.ealaWon === "boolean" ? latest.ealaWon : null, score: latest.score ?? null };
    if (latest.state !== "completed") fail(r, "Latest singles match is not marked completed in the canonical ledger.");
    if (typeof latest.ealaWon !== "boolean") fail(r, "Latest completed singles match has no boolean Eala result.");
    if (!Number.isFinite(at)) fail(r, "Latest completed singles match has no valid played/scheduled timestamp.");
    else if (at > now + 24 * 60 * 60 * 1000) fail(r, "Latest completed singles match is dated more than 24 hours in the future.");
    if (!String(latest.tournament ?? "").trim()) fail(r, "Latest completed singles match has no tournament name.");
    if (!String(latest.opponent ?? "").trim()) warn(r, "Latest completed singles match has no opponent name.");
    if (latest.score && !/^\d+(?:-\d+)?(?:\s+\d+(?:-\d+)?)*$/.test(String(latest.score).trim())) warn(r, "Latest singles score has an unfamiliar format; review it rather than treating it as a confirmed error.");
    if (latest.source && !["wta", "bornan"].includes(token(latest.source))) warn(r, "Latest singles result came from an unfamiliar source label: " + latest.source + ".");
  }

  const next = s.nextFixture ?? null;
  if (next) {
    const at = time(next.scheduledAt);
    r.details.nextFixture = { source: next.source ?? null, sourceMatchId: next.sourceMatchId ?? null, state: next.state ?? null, canonicalRole: next.canonicalRole ?? null, tournament: next.tournament ?? null, round: next.round ?? null, scheduledAt: Number.isFinite(at) ? new Date(at).toISOString() : null, opponent: next.opponent ?? null };
    if (!["event_only", "scheduled", "confirmed"].includes(token(next.state))) fail(r, "Next tennis fixture has an unexpected state: " + (next.state ?? "empty") + ".");
    if (next.canonicalRole !== "next_fixture") warn(r, "Tennis nextFixture is not tagged with canonical_role=next_fixture.");
    if (Number.isFinite(at) && at < now - 24 * 60 * 60 * 1000) fail(r, "Next tennis fixture is more than 24 hours past its scheduled time.");
    if (!Number.isFinite(at)) warn(r, "Next tennis fixture has no exact scheduled time; it may represent a tournament-level placeholder.");
    if (latest && Number.isFinite(at)) {
      const latestAt = time(latest.playedAt ?? latest.scheduledAt);
      if (Number.isFinite(latestAt) && at < latestAt - 6 * 60 * 60 * 1000) fail(r, "Next tennis fixture is scheduled before the latest completed singles match.");
    }
  } else {
    r.details.nextFixture = null;
    warn(r, "No exact next tennis fixture is currently present in the canonical ledger.");
    if (s.nextEventCandidate) r.details.nextEventCandidate = { state: s.nextEventCandidate.state ?? null, tournament: s.nextEventCandidate.tournament ?? null, scheduledAt: s.nextEventCandidate.scheduledAt ?? null, opponent: s.nextEventCandidate.opponent ?? null };
  }
  return done(r);
}
