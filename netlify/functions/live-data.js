const LEAGUE_ID = 39; // Premier League in API-Football
const SEASON = 2026;  // 2026-27 season
const API_BASE = "https://v3.football.api-sports.io";

function statusIsLive(short) {
  return ["1H", "HT", "2H", "ET", "P", "LIVE", "BT"].includes(short);
}

async function apiFetch(path, key) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { "x-apisports-key": key } });
  const json = await res.json();
  if (!res.ok) throw new Error(`API-Football error ${res.status}: ${JSON.stringify(json.errors || json)}`);
  return json;
}

export default async (req, context) => {
  const apiKey = Netlify.env.get("API_FOOTBALL_KEY");

  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Mangler API_FOOTBALL_KEY som miljovariabel" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    const today = new Date();
    const from = new Date(today.getTime() - 10 * 86400000).toISOString().slice(0, 10);
    const to = new Date(today.getTime() + 10 * 86400000).toISOString().slice(0, 10);

    const [standingsJson, fixturesJson] = await Promise.all([
      apiFetch(`/standings?league=${LEAGUE_ID}&season=${SEASON}`, apiKey),
      apiFetch(`/fixtures?league=${LEAGUE_ID}&season=${SEASON}&from=${from}&to=${to}`, apiKey),
    ]);

    const debug = {
      standingsErrors: standingsJson.errors,
      standingsResultsCount: standingsJson.results,
      fixturesErrors: fixturesJson.errors,
      fixturesResultsCount: fixturesJson.results,
    };

    const standingsResp = standingsJson.response;
    const fixturesResp = fixturesJson.response;

    const fixtures = fixturesResp || [];
    const liveOnes = fixtures.filter((f) => statusIsLive(f.fixture.status.short));
    const finishedToday = fixtures.filter((f) => f.fixture.status.short === "FT");

    const eventTargets = [...liveOnes, ...finishedToday].slice(0, 12);
    const scorersById = {};
    await Promise.all(
      eventTargets.map(async (f) => {
        try {
          const events = await apiFetch(`/fixtures/events?fixture=${f.fixture.id}`, apiKey);
          scorersById[f.fixture.id] = (events || [])
            .filter((e) => e.type === "Goal" && e.detail !== "Missed Penalty")
            .map((e) => ({
              team: e.team.id === f.teams.home.id ? "home" : "away",
              name: e.player?.name || "Ukjent",
              minute: e.time.elapsed + (e.time.extra ? "+" + e.time.extra : ""),
            }));
        } catch (e) {
          // one fixture failing shouldn't break the rest
        }
      })
    );

    const standings = (standingsResp?.[0]?.league?.standings?.[0] || []).map((s) => ({
      rank: s.rank,
      team: s.team.name,
      played: s.all.played,
      win: s.all.win,
      draw: s.all.draw,
      lose: s.all.lose,
      points: s.points,
    }));

    const results = fixtures
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

    const upcoming = fixtures
      .filter((f) => f.fixture.status.short === "NS")
      .map((f) => ({ id: f.fixture.id, date: f.fixture.date, home: f.teams.home.name, away: f.teams.away.name }))
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(0, 10);

    const cacheSeconds = liveOnes.length > 0 ? 150 : 1200;

    return new Response(
      JSON.stringify({ standings, results, fixtures: upcoming, updated: new Date().toISOString(), debug }),
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
