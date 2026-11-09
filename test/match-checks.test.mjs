import test from "node:test";
import assert from "node:assert/strict";
import { checkFootballMatchState, checkTennisMatchState } from "../scripts/match-checks.mjs";

const now = Date.parse("2026-11-09T12:00:00.000Z");
const football = (overrides = {}) => ({
  ok: true, player: "Ben Brereton Díaz", dataUpdatedAt: "2026-11-09T11:58:00.000Z",
  latestMatch: { id: 101, date: "2026-11-07T15:00:00.000Z", status: "finished", home_team: { name: "Sheffield United" }, away_team: { name: "Bristol City" }, home_score: 2, away_score: 1 },
  liveMatch: { id: 102, date: "2026-11-09T11:00:00.000Z", status: "2H", home: "Sheffield United", away: "Leeds United", home_score: 1, away_score: 0, current_minute: 67 },
  nextFixtures: [{ id: 103, date: "2026-11-15T15:00:00.000Z", home_team: { name: "Norwich City" }, away_team: { name: "Sheffield United" } }],
  ...overrides
});
const tennis = (overrides = {}) => ({
  ok: true, player: "Alexandra Eala", lastSyncedAt: "2026-11-09T11:55:00.000Z", matchCount: 82, completedSinglesCount: 54,
  latestMatch: { source: "wta", sourceMatchId: "wta-123", state: "completed", tournament: "WTA 125", round: "Q", playedAt: "2026-11-08T08:00:00.000Z", opponent: "Test Opponent", ealaWon: true, score: "6-4 6-3" },
  nextFixture: { source: "wta", sourceMatchId: "wta-124", state: "scheduled", tournament: "WTA 125", round: "R32", scheduledAt: "2026-11-12T08:00:00.000Z", opponent: "Next Opponent", canonicalRole: "next_fixture" },
  ...overrides
});

test("football accepts a coherent latest/live/upcoming lifecycle", () => assert.equal(checkFootballMatchState(football(), { now, expectedPlayer: "Ben Brereton" }).status, "passed"));
test("football rejects a final fixture without a score", () => {
  const s = football({ latestMatch: { ...football().latestMatch, home_score: null, away_score: null } });
  const r = checkFootballMatchState(s, { now });
  assert.equal(r.status, "failed");
  assert.ok(r.failures.some(x => x.includes("final score")));
});
test("football rejects a live fixture without scores", () => {
  const s = football({ liveMatch: { id: 102, date: "2026-11-09T11:00:00.000Z", status: "2H", home: "A", away: "B" } });
  const r = checkFootballMatchState(s, { now });
  assert.ok(r.failures.some(x => x.includes("live football match is missing")));
});
test("football rejects a past fixture left in nextFixtures", () => {
  const s = football({ nextFixtures: [{ id: 103, date: "2026-11-08T00:00:00.000Z", home: "A", away: "B" }] });
  const r = checkFootballMatchState(s, { now });
  assert.ok(r.failures.some(x => x.includes("past kickoff")));
});
test("tennis accepts a canonical completed result and future next fixture", () => assert.equal(checkTennisMatchState(tennis(), { now }).status, "passed"));
test("tennis rejects a completed match without a boolean result", () => {
  const s = tennis({ latestMatch: { ...tennis().latestMatch, ealaWon: null } });
  const r = checkTennisMatchState(s, { now });
  assert.ok(r.failures.some(x => x.includes("no boolean Eala result")));
});
test("tennis rejects an overdue next fixture", () => {
  const s = tennis({ nextFixture: { ...tennis().nextFixture, scheduledAt: "2026-11-07T08:00:00.000Z" } });
  const r = checkTennisMatchState(s, { now });
  assert.ok(r.failures.some(x => x.includes("past its scheduled time")));
});
test("tennis rejects stale canonical match data", () => {
  const s = tennis({ lastSyncedAt: "2026-11-08T20:00:00.000Z" });
  const r = checkTennisMatchState(s, { now, maxDataAgeMinutes: 780 });
  assert.ok(r.failures.some(x => x.includes("minutes old")));
});
