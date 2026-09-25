import { getStore } from "@netlify/blobs";

const SEASON = 2026;  // 2026-27 season
const API_BASE = "https://v3.football.api-sports.io";

// Player leaderboards move only when matches finish, so they are refetched at
// most every six hours. Between refreshes the page is served from Blobs.
const STATS_TTL_MS = 6 * 60 * 60 * 1000;

// Keep these in step with COMPETITIONS in live-data.js.
const COMPETITIONS = [
  { id: 39,  code: "PL" },
  { id: 40,  code: "ELC" },
  { id: 45,  code: "FA" },
  { id: 48,  code: "EFL" },
  { id: 2,   code: "CL" },
  { id: 3,   code: "EL" },
  { id: 848, code: "CN" },
];

// Two lists per competition: the top 20 by goals and the top 20 by assists.
const BOARDS = ["topscorers", "topassists"];

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

function shapePlayer(item) {
  const s = item.statistics?.[0] || {};
  return {
    id: item.player.id,
    name: item.player.name,
    photo: item.player.photo,
    team: s.team?.name || "",
    teamLogo: s.team?.logo || "",
    position: s.games?.position || "",
    apps: s.games?.appearences ?? 0,
    minutes: s.games?.minutes ?? 0,
    goals: s.goals?.total ?? 0,
    assists: s.goals?.assists ?? 0,
    penalties: s.penalty?.scored ?? 0,
    yellow: s.cards?.yellow ?? 0,
    red: s.cards?.red ?? 0,
  };
}

function respond(body, maxAge) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${maxAge}, stale-while-revalidate=600, stale-if-error=3600`,
    },
  });
}

export default async () => {
  const apiKey = Netlify.env.get("API_FOOTBALL_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Mangler API_FOOTBALL_KEY som miljovariabel" }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }

  const store = getStore("balloya-live");
  const cached = await store.get("stats", { type: "json" }).catch(() => null);
  if (cached && Date.now() - cached.fetchedAt < STATS_TTL_MS) return respond(cached, 1800);

  const tasks = [];
  for (const c of COMPETITIONS) {
    for (const board of BOARDS) {
      tasks.push(() => apiFetch(`/players/${board}?league=${c.id}&season=${SEASON}`, apiKey)
        .then((j) => ({ code: c.code, board, list: j.response || [] })));
    }
  }
  const answers = await paced(tasks);

  // A competition is replaced only when both its lists came back. One that
  // failed keeps its previous entry rather than showing half a leaderboard.
  const competitions = { ...(cached?.competitions || {}) };
  let fresh = 0;
  for (const c of COMPETITIONS) {
    const mine = answers.filter((a) => a && a.code === c.code);
    if (mine.length !== BOARDS.length) continue;
    const players = new Map();
    for (const a of mine) {
      for (const item of a.list) {
        if (item?.player?.id != null && !players.has(item.player.id)) players.set(item.player.id, shapePlayer(item));
      }
    }
    competitions[c.code] = { players: [...players.values()] };
    fresh++;
  }

  if (!fresh) {
    if (cached) return respond(cached, 300);
    return new Response(JSON.stringify({ error: "Fikk ikke hentet spillerstatistikk" }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  }

  const payload = { fetchedAt: Date.now(), updated: new Date().toISOString(), competitions };
  await store.setJSON("stats", payload).catch(() => {});
  return respond(payload, 1800);
};

export const config = { path: "/api/stats" };
