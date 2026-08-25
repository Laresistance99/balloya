import { getStore } from "@netlify/blobs";

const LEAGUE_ID = 39; // Premier League in API-Football
const SEASON = 2026;  // 2026-27 season
const API_BASE = "https://v3.football.api-sports.io";
const MANUAL_TTL_MS = 24 * 60 * 60 * 1000; // manual entries stop overriding after 24h

const EURO_COMPETITIONS = [
  { id: 2, code: "CL", name: "Champions League" },
  { id: 3, code: "EL", name: "Europa League" },
  { id: 848, code: "CN", name: "Conference League" },
];

function slug(a, b) {
  const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  return `${norm(a)}-${norm(b)}`;
}

function statusIsLive(short) {
  return ["1H", "HT", "2H", "ET", "P", "LIVE", "BT"].includes(short);
}

async function apiFetch(path, key) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { "x-apisports-key": key } });
  const json = await res.json();
  if (!res.ok) throw new Error(`API-Football error ${res.status}: ${JSON.stringify(json.errors || json)}`);
  return json;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchScorers(fixtureList, apiKey) {
  const liveOnes = fixtureList.filter((f) => statusIsLive(f.fixture.status.short));
  const finished = fixtureList.filter((f) => f.fixture.status.short === "FT");
  const targets = [...liveOnes, ...finished].slice(0, 10);
  const scorersById = {};
  for (const f of targets) {
    try {
      const eventsJson = await apiFetch(`/fixtures/events?fixture=${f.fixture.id}`, apiKey);
      const events = eventsJson.response;
      scorersById[f.fixture.id] = (events || [])
        .filter((e) => e.type === "Goal" && e.detail !== "Missed Penalty")
        .map((e) => ({
          team: e.team.id === f.teams.home.id ? "home" : "away",
          name: e.player?.name || "Ukjent",
          minute: e.time.elapsed + (e.time.extra ? "+" + e.time.extra : ""),
        }));
    } catch (e) {
      // one fixture's events failing shouldn't break the rest
    }
    await sleep(220); // stay comfortably under 5 requests/second
  }
  return scorersById;
}

function applyManualOverlay(list, manualStore) {
  const now = Date.now();
  return list.map((entry) => {
    const manual = manualStore[slug(entry.home, entry.away)];
    if (manual && now - manual.updatedAt < MANUAL_TTL_MS) {
      return {
        ...entry,
        homeGoals: manual.homeGoals,
        awayGoals: manual.awayGoals,
        scorers: manual.scorers && manual.scorers.length ? manual.scorers : entry.scorers,
        status: manual.finished ? "FT" : "LIVE",
        manual: true,
      };
    }
    return entry;
  });
}

export default async (req, context) => {
  const apiKey = Netlify.env.get("API_FOOTBALL_KEY");

  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Mangler API_FOOTBALL_KEY som miljovariabel" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const store = getStore("balloya-live");
  const manualStore = (await store.get("manual", { type: "json" }).catch(() => null)) || {};
  const now = Date.now();
  const hasManualCover = (home, away) => {
    const m = manualStore[slug(home, away)];
    return m && now - m.updatedAt < MANUAL_TTL_MS;
  };

  try {
    const today = new Date();
    const from = new Date(today.getTime() - 10 * 86400000).toISOString().slice(0, 10);
    const to = new Date(today.getTime() + 10 * 86400000).toISOString().slice(0, 10);

    const [standingsJson, fixturesJson] = await Promise.all([
      apiFetch(`/standings?league=${LEAGUE_ID}&season=${SEASON}`, apiKey),
      apiFetch(`/fixtures?league=${LEAGUE_ID}&season=${SEASON}&from=${from}&to=${to}`, apiKey),
    ]);

    const standingsResp = standingsJson.response;
    const fixturesResp = fixturesJson.response;

    const fixtures = fixturesResp || [];
    const englishClubs = new Set(
      (standingsResp?.[0]?.league?.standings?.[0] || []).map((s) => s.team.name)
    );

    // Skip the API scorer lookup entirely for anything already covered manually.
    const fixturesNeedingScorers = fixtures.filter(
      (f) => !hasManualCover(f.teams.home.name, f.teams.away.name)
    );
    const scorersById = await fetchScorers(fixturesNeedingScorers, apiKey);

    const europaResults = [];
    const europaFixtures = [];
    const europaStandings = [];
    const europaDebug = [];

    for (const comp of EURO_COMPETITIONS) {
      try {
        const euroStandingsJson = await apiFetch(`/standings?league=${comp.id}&season=${SEASON}`, apiKey);
        await sleep(220);
        const euroFixturesJson = await apiFetch(`/fixtures?league=${comp.id}&season=${SEASON}&from=${from}&to=${to}`, apiKey);
        await sleep(220);

        const euroFixturesAll = euroFixturesJson.response || [];
        const englishFixtures = euroFixturesAll.filter(
          (f) => englishClubs.has(f.teams.home.name) || englishClubs.has(f.teams.away.name)
        );
        const englishFixturesNeedingScorers = englishFixtures.filter(
          (f) => !hasManualCover(f.teams.home.name, f.teams.away.name)
        );

        const sampleNames = [
          ...new Set(euroFixturesAll.flatMap((f) => [f.teams.home.name, f.teams.away.name])),
        ].slice(0, 20);
        europaDebug.push({
          competition: comp.code,
          totalFixturesInWindow: euroFixturesAll.length,
          matchedEnglishFixtures: englishFixtures.length,
          fixturesError: euroFixturesJson.errors,
          sampleTeamNames: sampleNames,
        });
        const euroScorers = await fetchScorers(englishFixturesNeedingScorers, apiKey);

        for (const f of englishFixtures) {
          const entry = {
            id: f.fixture.id,
            date: f.fixture.date,
            status: f.fixture.status.short,
            home: f.teams.home.name,
            away: f.teams.away.name,
            homeGoals: f.goals.home,
            awayGoals: f.goals.away,
            scorers: euroScorers[f.fixture.id] || [],
            competition: comp.code,
            competitionName: comp.name,
          };
          if (entry.status === "FT" || statusIsLive(entry.status)) europaResults.push(entry);
          else if (entry.status === "NS") europaFixtures.push(entry);
        }

        const standingsRows = euroStandingsJson.response?.[0]?.league?.standings || [];
        for (const group of standingsRows) {
          for (const s of group) {
            if (englishClubs.has(s.team.name)) {
              europaStandings.push({
                team: s.team.name,
                rank: s.rank,
                played: s.all.played,
                points: s.points,
                competition: comp.code,
                competitionName: comp.name,
              });
            }
          }
        }
      } catch (e) {
        europaDebug.push({ competition: comp.code, error: String(e.message || e) });
      }
    }

    const standings = (standingsResp?.[0]?.league?.standings?.[0] || []).map((s) => ({
      rank: s.rank,
      team: s.team.name,
      played: s.all.played,
      win: s.all.win,
      draw: s.all.draw,
      lose: s.all.lose,
      points: s.points,
    }));

    let results = fixtures
      .filter((f) => f.fixture.status.short === "FT" || statusIsLive(f.fixture.status.short))
      .map((f) => ({
        id: f.fixture.id,
        date: f.fixture.date,
        status: f.fixture.status.short,
        home: f.teams.home.name,
        away: f.teams.away.name,
        homeGoals: f.goals.home,
        awayGoals: f.goals.away,
        scorers: scorersById[f.fixture.id] || [],
      }))
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    results = applyManualOverlay(results, manualStore);

    let europaResultsFinal = applyManualOverlay(europaResults, manualStore);
    europaResultsFinal.sort((a, b) => new Date(b.date) - new Date(a.date));
    europaFixtures.sort((a, b) => new Date(a.date) - new Date(b.date));

    const upcoming = fixtures
      .filter((f) => f.fixture.status.short === "NS")
      .map((f) => ({ id: f.fixture.id, date: f.fixture.date, home: f.teams.home.name, away: f.teams.away.name }))
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(0, 10);

    const upcomingTimes = [
      ...fixtures.filter((f) => f.fixture.status.short === "NS").map((f) => new Date(f.fixture.date).getTime()),
      ...europaFixtures.map((f) => new Date(f.date).getTime()),
    ];
    const minutesToNextKickoff = upcomingTimes.length
      ? (Math.min(...upcomingTimes) - now) / 60000
      : Infinity;

    const anyLive =
      results.some((r) => statusIsLive(r.status)) || europaResultsFinal.some((r) => statusIsLive(r.status));

    let cacheSeconds;
    if (anyLive) {
      cacheSeconds = 150;
    } else if (minutesToNextKickoff <= 120) {
      cacheSeconds = 900;
    } else {
      cacheSeconds = 28800;
    }

    return new Response(
      JSON.stringify({
        standings,
        results,
        fixtures: upcoming,
        europa: { standings: europaStandings, results: europaResultsFinal, fixtures: europaFixtures },
        europaDebug,
        updated: new Date().toISOString(),
      }),
      {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${cacheSeconds}, stale-while-revalidate=600, stale-if-error=3600`,
        },
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err.message || err) }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
};

export const config = { path: "/api/live-data" };
