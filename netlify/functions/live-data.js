import { getStore } from "@netlify/blobs";

const SEASON = 2026;  // 2026-27 season
const API_BASE = "https://v3.football.api-sports.io";
const MANUAL_TTL_MS = 24 * 60 * 60 * 1000;

// scope: 'all'      -> every match in the competition (English cups: we want all rounds)
//        'english'  -> only matches involving a Premier League club (European competitions)
const COMPETITIONS = [
  { id: 39,  code: "PL",  name: "Premier League",    group: "liga",   standings: true,  scope: "all" },
  { id: 45,  code: "FA",  name: "FA-cupen",          group: "cup",    standings: false, scope: "all" },
  { id: 48,  code: "EFL", name: "Ligacupen",         group: "cup",    standings: false, scope: "all" },
  { id: 2,   code: "CL",  name: "Champions League",  group: "europa", standings: true,  scope: "english" },
  { id: 3,   code: "EL",  name: "Europa League",     group: "europa", standings: true,  scope: "english" },
  { id: 848, code: "CN",  name: "Conference League", group: "europa", standings: true,  scope: "english" },
];

function slug(a, b) {
  const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  return `${norm(a)}-${norm(b)}`;
}

function statusIsLive(short) {
  return ["1H", "HT", "2H", "ET", "P", "LIVE", "BT"].includes(short);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiFetch(path, key) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { "x-apisports-key": key } });
  const json = await res.json();
  if (!res.ok) throw new Error(`API-Football error ${res.status}: ${JSON.stringify(json.errors || json)}`);
  return json;
}

async function paced(tasks, batchSize = 4, gapMs = 260) {
  const out = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    out.push(...(await Promise.all(batch.map((t) => t().catch(() => null)))));
    if (i + batchSize < tasks.length) await sleep(gapMs);
  }
  return out;
}

// "Regular Season - 3" -> "Runde 3"; "Round of 16" -> "8-delsfinale", etc.
function prettyRound(raw) {
  if (!raw) return "";
  const r = String(raw);
  const num = (r.match(/-\s*(\d+)\s*$/) || [])[1];
  if (/Regular Season/i.test(r)) return num ? `Runde ${num}` : "Serierunde";
  if (/Group Stage|League Stage/i.test(r)) return num ? `Ligafase ${num}` : "Ligafase";
  if (/Preliminary/i.test(r)) return "Kvalifisering";
  if (/Qualifying/i.test(r)) return num ? `Kvalifisering ${num}` : "Kvalifisering";
  if (/Play-?offs?/i.test(r)) return "Playoff";
  if (/Knockout Round Play-?offs?/i.test(r)) return "Playoff til 16-delsfinale";
  if (/Round of 32/i.test(r)) return "16-delsfinale";
  if (/Round of 16/i.test(r)) return "8-delsfinale";
  if (/Quarter-?finals?/i.test(r)) return "Kvartfinale";
  if (/Semi-?finals?/i.test(r)) return "Semifinale";
  if (/3rd Place|Third Place/i.test(r)) return "Bronsefinale";
  if (/Final/i.test(r)) return "Finale";
  const ord = (r.match(/(\d+)(?:st|nd|rd|th)\s+Round/i) || [])[1];
  if (ord) return `${ord}. runde`;
  return r;
}

function isQualifyingRound(raw) {
  return /Qualifying|Preliminary/i.test(String(raw || ""));
}

function shapeMatch(f, comp, scorers) {
  return {
    id: f.fixture.id,
    date: f.fixture.date,
    status: f.fixture.status.short,
    round: prettyRound(f.league?.round),
    home: f.teams.home.name,
    away: f.teams.away.name,
    homeGoals: f.goals.home,
    awayGoals: f.goals.away,
    scorers: scorers || [],
    competition: comp.code,
    competitionName: comp.name,
    group: comp.group,
  };
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
      status: 500, headers: { "content-type": "application/json" },
    });
  }

  const store = getStore("balloya-live");
  const [manualStore, scorerArchive] = await Promise.all([
    store.get("manual", { type: "json" }).catch(() => null).then((v) => v || {}),
    store.get("scorers", { type: "json" }).catch(() => null).then((v) => v || {}),
  ]);

  const now = Date.now();
  const hasManualCover = (home, away) => {
    const m = manualStore[slug(home, away)];
    return m && now - m.updatedAt < MANUAL_TTL_MS;
  };

  try {
    // Full season per competition in one call each — gives us the whole history,
    // so a club's cup or European run stays visible after they're knocked out.
    const seasonTasks = COMPETITIONS.map(
      (c) => () => apiFetch(`/fixtures?league=${c.id}&season=${SEASON}`, apiKey).then((j) => ({ comp: c, json: j }))
    );
    const standingsTasks = COMPETITIONS.filter((c) => c.standings).map(
      (c) => () => apiFetch(`/standings?league=${c.id}&season=${SEASON}`, apiKey).then((j) => ({ comp: c, json: j }))
    );

    const [seasonResults, standingsResults] = await Promise.all([
      paced(seasonTasks),
      paced(standingsTasks),
    ]);

    const plTable = standingsResults.find((r) => r && r.comp.code === "PL")
      ?.json?.response?.[0]?.league?.standings?.[0] || [];
    const englishClubs = new Set(plTable.map((s) => s.team.name));

    const allResultsRaw = [];
    const allFixturesRaw = [];
    const participation = {}; // which competitions a PL club actually appears in

    for (const entry of seasonResults) {
      if (!entry) continue;
      const { comp, json } = entry;
      const list = json.response || [];

      for (const f of list) {
        const involvesEnglish = englishClubs.has(f.teams.home.name) || englishClubs.has(f.teams.away.name);

        if (comp.scope === "english" && !involvesEnglish) continue;
        // English cups: keep every round of the main competition, skip the huge qualifying rounds.
        if (comp.scope === "all" && comp.group === "cup" && isQualifyingRound(f.league?.round)) continue;

        if (involvesEnglish) {
          if (!participation[comp.code]) participation[comp.code] = new Set();
          if (englishClubs.has(f.teams.home.name)) participation[comp.code].add(f.teams.home.name);
          if (englishClubs.has(f.teams.away.name)) participation[comp.code].add(f.teams.away.name);
        }

        const st = f.fixture.status.short;
        if (st === "FT" || st === "AET" || st === "PEN" || statusIsLive(st)) allResultsRaw.push({ f, comp });
        else if (st === "NS" || st === "TBD") allFixturesRaw.push({ f, comp });
      }
    }

    allResultsRaw.sort((a, b) => new Date(b.f.fixture.date) - new Date(a.f.fixture.date));
    allFixturesRaw.sort((a, b) => new Date(a.f.fixture.date) - new Date(b.f.fixture.date));

    // Scorers accumulate in storage across the season, so old matches keep their
    // goalscorers without ever being re-fetched. Only new matches cost a request.
    const needScorers = allResultsRaw
      .filter(({ f }) => !scorerArchive[f.fixture.id] && !hasManualCover(f.teams.home.name, f.teams.away.name))
      .sort((a, b) => {
        const aLive = statusIsLive(a.f.fixture.status.short) ? 0 : 1;
        const bLive = statusIsLive(b.f.fixture.status.short) ? 0 : 1;
        if (aLive !== bLive) return aLive - bLive;
        return new Date(b.f.fixture.date) - new Date(a.f.fixture.date);
      })
      .slice(0, 16);

    // Live matches change, so their cached entry is always refreshed.
    const liveIds = new Set(allResultsRaw.filter(({ f }) => statusIsLive(f.fixture.status.short)).map(({ f }) => f.fixture.id));
    const refreshLive = allResultsRaw.filter(({ f }) => liveIds.has(f.fixture.id)).slice(0, 8);
    const scorerTargets = [...new Map([...needScorers, ...refreshLive].map((t) => [t.f.fixture.id, t])).values()];

    const scorerJsons = await paced(
      scorerTargets.map(({ f }) => () => apiFetch(`/fixtures/events?fixture=${f.fixture.id}`, apiKey).then((j) => ({ id: f.fixture.id, json: j })))
    );

    let archiveChanged = false;
    for (const entry of scorerJsons) {
      if (!entry) continue;
      const target = scorerTargets.find((t) => t.f.fixture.id === entry.id);
      if (!target) continue;
      scorerArchive[entry.id] = (entry.json.response || [])
        .filter((e) => e.type === "Goal" && e.detail !== "Missed Penalty")
        .map((e) => ({
          team: e.team.id === target.f.teams.home.id ? "home" : "away",
          name: e.player?.name || "Ukjent",
          minute: e.time.elapsed + (e.time.extra ? "+" + e.time.extra : ""),
        }));
      archiveChanged = true;
    }
    if (archiveChanged) await store.setJSON("scorers", scorerArchive).catch(() => {});

    let results = allResultsRaw.map(({ f, comp }) => shapeMatch(f, comp, scorerArchive[f.fixture.id]));
    results = applyManualOverlay(results, manualStore);
    const fixtures = allFixturesRaw.map(({ f, comp }) => shapeMatch(f, comp, []));

    const standings = plTable.map((s) => ({
      rank: s.rank, team: s.team.name, played: s.all.played,
      win: s.all.win, draw: s.all.draw, lose: s.all.lose, points: s.points,
    }));

    const euroStandings = [];
    for (const r of standingsResults) {
      if (!r || r.comp.code === "PL") continue;
      for (const g of (r.json?.response?.[0]?.league?.standings || [])) {
        for (const s of g) {
          if (englishClubs.has(s.team.name)) {
            euroStandings.push({
              team: s.team.name, rank: s.rank, played: s.all.played, points: s.points,
              competition: r.comp.code, competitionName: r.comp.name, group: r.comp.group,
            });
          }
        }
      }
    }

    const today = new Date();
    const playedCounts = standings.map((s) => s.played);
    const minPlayed = playedCounts.length ? Math.min(...playedCounts) : 0;
    const maxPlayed = playedCounts.length ? Math.max(...playedCounts) : 0;
    const plToday = fixtures.filter((f) => f.competition === "PL" && new Date(f.date).toDateString() === today.toDateString());
    const plLive = results.filter((r) => r.competition === "PL" && statusIsLive(r.status));
    const roundInfo = {
      minPlayed, maxPlayed,
      complete: minPlayed === maxPlayed,
      liveCount: plLive.length,
      nextToday: plToday.length ? { home: plToday[0].home, away: plToday[0].away, date: plToday[0].date } : null,
    };

    const competitions = COMPETITIONS.map((c) => ({
      code: c.code, name: c.name, group: c.group,
      teams: [...(participation[c.code] || [])].sort(),
    }));

    const anyLive = results.some((r) => statusIsLive(r.status));
    const upcomingTimes = fixtures.map((f) => new Date(f.date).getTime()).filter((t) => t > now);
    const minutesToNextKickoff = upcomingTimes.length ? (Math.min(...upcomingTimes) - now) / 60000 : Infinity;

    let cacheSeconds;
    if (anyLive) cacheSeconds = 150;
    else if (minutesToNextKickoff <= 120) cacheSeconds = 900;
    else cacheSeconds = 28800;

    return new Response(
      JSON.stringify({ standings, results, fixtures, euroStandings, competitions, roundInfo, updated: new Date().toISOString() }),
      {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${cacheSeconds}, stale-while-revalidate=600, stale-if-error=3600`,
        },
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err.message || err) }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  }
};

export const config = { path: "/api/live-data" };
