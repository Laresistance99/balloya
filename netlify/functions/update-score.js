import { getStore } from "@netlify/blobs";

function slug(a, b) {
  const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  return `${norm(a)}-${norm(b)}`;
}

export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Bruk POST" }), { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Ugyldig data" }), { status: 400 });
  }

  const expected = Netlify.env.get("ADMIN_PASSWORD");
  if (!expected || body.password !== expected) {
    return new Response(JSON.stringify({ error: "Feil passord" }), { status: 401 });
  }

  const { home, away, homeGoals, awayGoals, scorers, finished, competition, competitionName } = body;
  if (!home || !away) {
    return new Response(JSON.stringify({ error: "Mangler lagnavn" }), { status: 400 });
  }

  const store = getStore("balloya-live");
  const manualStore = (await store.get("manual", { type: "json" }).catch(() => null)) || {};

  const key = slug(home, away);
  manualStore[key] = {
    home,
    away,
    homeGoals: Number(homeGoals) || 0,
    awayGoals: Number(awayGoals) || 0,
    scorers: Array.isArray(scorers) ? scorers : [],
    finished: !!finished,
    competition: competition || "PL",
    competitionName: competitionName || "Premier League",
    updatedAt: Date.now(),
  };

  await store.setJSON("manual", manualStore);

  return new Response(JSON.stringify({ ok: true, key }), {
    headers: { "content-type": "application/json" },
  });
};

export const config = { path: "/api/update-score" };
