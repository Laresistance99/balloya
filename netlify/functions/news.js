import { getStore } from "@netlify/blobs";

const STORE = "balloya-live";
const KEY = "news";

// The articles that were hardcoded on the page before the archive existed.
// Seeded once so nothing is lost; all older than 72h, so they land in the archive.
const SEED = [
  { tag: "Arsenal · Coventry City", headline: "Mesterne startet solid",
    body: "Arsenal innledet tittelforsvaret med en overbevisende 3\u20130-seier over nyopprykkede Coventry City, tilbake i toppdivisjonen for f\u00f8rste gang p\u00e5 25 \u00e5r under Frank Lampard. Til tross for den suverene starten er det fortsatt litt usikkerhet rundt en skade i Arsenal-troppen.",
    publishedAt: Date.UTC(2026, 7, 21, 21, 0) },
  { tag: "Hull City · Manchester United", headline: "Dr\u00f8mmestart for Hull",
    body: "Hull City feiret gjenkomsten til Premier League med en 2\u20130-seier over Manchester United. United-manager Michael Carrick beskrev tapet som sv\u00e6rt skuffende og pekte p\u00e5 at laget m\u00e5 reise seg raskt.",
    publishedAt: Date.UTC(2026, 7, 22, 13, 30) },
  { tag: "Brentford · Tottenham", headline: "Sangar\u00e9 imponerte fra start",
    body: "Tottenham reiste hjem med et 0\u20133-tap fra Brentford og er fortsatt preget av skadeproblemer i troppen. P\u00e5 den andre siden imponerte Brentfords rekordsignering Mamadou Sangar\u00e9, involvert i det f\u00f8rste m\u00e5let p\u00e5 sin debut.",
    publishedAt: Date.UTC(2026, 7, 22, 18, 30) },
  { tag: "Newcastle · Liverpool", headline: "Ny \u00e6ra uten Salah",
    body: "Liverpool m\u00e5tte klare seg uten Mohamed Salah, Andy Robertson og Ibrahima Konat\u00e9, som alle forlot klubben i sommer, og hentet et 2\u20132-poeng hos Newcastle. Ogs\u00e5 Newcastle har solgt flere sentrale spillere denne sommeren, men holdt unna mot serieforsvarerne.",
    publishedAt: Date.UTC(2026, 7, 23, 17, 30) },
  { tag: "Manchester City · Bournemouth", headline: "City slet, men vant",
    body: "Manchester City vant 2\u20131 over Bournemouth, som er inne i en ny \u00e6ra under Marco Rose etter Andoni Iraolas exit. Bournemouth har historisk slitt p\u00e5 Etihad Stadium, og tapte nok en gang p\u00e5 bortebane mot City.",
    publishedAt: Date.UTC(2026, 7, 23, 15, 0) },
  { tag: "Ipswich Town · Sunderland", headline: "Angulo med kampredning",
    body: "Ipswich Town slo Sunderland 2\u20131 i en duell mellom to nyopprykkede lag, avgjort av et spektakul\u00e6rt frispark fra Nilson Angulo. Sunderland, under ny manager Gary O'Neil etter en sterk avslutning p\u00e5 forrige sesong, m\u00e5tte se seg sl\u00e5tt.",
    publishedAt: Date.UTC(2026, 7, 22, 16, 0) },
  { tag: "Everton · Crystal Palace", headline: "Ny bane, ny sesong",
    body: "Everton \u00e5pnet sesongen med en 2\u20130-seier over Crystal Palace p\u00e5 Hill Dickinson Stadium. Palace, n\u00e5 under ny manager etter Oliver Glasners avgang, jakter fortsatt sin f\u00f8rste seier i den nye \u00e6raen.",
    publishedAt: Date.UTC(2026, 7, 22, 16, 0) },
  { tag: "Brighton · Aston Villa", headline: "M\u00e5lfest p\u00e5 Amex",
    body: "Brighton & Hove Albion knuste Aston Villa 4\u20130 hjemme \u2013 et av helgens klareste resultater og en sterk \u00e5pning for s\u00f8rkystklubben.",
    publishedAt: Date.UTC(2026, 7, 23, 15, 0) },
  { tag: "Leeds United · Nottingham Forest", headline: "Leeds med borteseier",
    body: "Leeds United tok med seg alle tre poeng fra Nottingham Forest etter en 1\u20130-seier, en solid \u00e5pning for opprykkslaget denne sesongen.",
    publishedAt: Date.UTC(2026, 7, 22, 16, 0) },
  { tag: "Fulham · Chelsea", headline: "Arbeloas f\u00f8rste hjemmekamp",
    body: "Runde 1 ble avsluttet mandag kveld da tidligere Real Madrid-back \u00c1lvaro Arbeloa ledet Fulham for f\u00f8rste gang p\u00e5 hjemmebane. Chelsea vant 3\u20132 p\u00e5 Craven Cottage.",
    publishedAt: Date.UTC(2026, 7, 24, 21, 0) },
];

function newId() {
  return "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Stable ids, deliberately not newId(). The seed is rebuilt on every request
// that finds no blob, so an edit issued against one response has to match the
// same article in the next one.
function seedItems() {
  return SEED.map((s, i) => ({ id: `seed-${i + 1}`, ...s }));
}

// Swallowing a read error here would make a transient Blobs failure look
// exactly like an uninitialised store, and we would overwrite real articles
// with SEED. So errors propagate: only a blob confirmed absent gets seeded.
async function loadItems(store) {
  let items;
  try {
    items = await store.get(KEY, { type: "json" });
  } catch (err) {
    throw new Error(`Kunne ikke lese nyhetsarkivet: ${err.message || err}`);
  }

  // A missing key reads back as null. An empty array is a real, deliberate
  // state — every article deleted — and must not bring the seed back.
  //
  // The seed is returned but never written here: reads stay read-only. Two
  // cold requests therefore cannot race to create the blob, and a slow one
  // cannot land its seed on top of an article published in the meantime.
  // The blob is created by the first admin write, which persists the seed
  // together with that change.
  if (items === null || items === undefined) return seedItems();

  if (!Array.isArray(items)) {
    throw new Error("Nyhetsarkivet har uventet format");
  }
  return items;
}

async function handle(req, store) {
  if (req.method === "GET") {
    const items = await loadItems(store);
    const sorted = [...items].sort((a, b) => b.publishedAt - a.publishedAt);
    return new Response(JSON.stringify({ items: sorted }), {
      headers: {
        "content-type": "application/json",
        // Short cache: news changes on your schedule, not the API's.
        "cache-control": "public, max-age=60, stale-while-revalidate=300",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Bruk GET eller POST" }), { status: 405 });
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

  const items = await loadItems(store);
  const action = body.action || "create";

  if (action === "create") {
    const { tag, headline, text, publishedAt } = body;
    if (!headline || !text) {
      return new Response(JSON.stringify({ error: "Overskrift og tekst m\u00e5 fylles ut" }), { status: 400 });
    }
    const item = {
      id: newId(),
      tag: (tag || "").trim(),
      headline: headline.trim(),
      body: text.trim(),
      publishedAt: publishedAt ? new Date(publishedAt).getTime() : Date.now(),
    };
    items.push(item);
    await store.setJSON(KEY, items);
    return new Response(JSON.stringify({ ok: true, item }), { headers: { "content-type": "application/json" } });
  }

  if (action === "update") {
    const idx = items.findIndex((i) => i.id === body.id);
    if (idx === -1) return new Response(JSON.stringify({ error: "Fant ikke saken" }), { status: 404 });
    items[idx] = {
      ...items[idx],
      tag: body.tag !== undefined ? String(body.tag).trim() : items[idx].tag,
      headline: body.headline !== undefined ? String(body.headline).trim() : items[idx].headline,
      body: body.text !== undefined ? String(body.text).trim() : items[idx].body,
      publishedAt: body.publishedAt ? new Date(body.publishedAt).getTime() : items[idx].publishedAt,
    };
    await store.setJSON(KEY, items);
    return new Response(JSON.stringify({ ok: true, item: items[idx] }), { headers: { "content-type": "application/json" } });
  }

  if (action === "delete") {
    const next = items.filter((i) => i.id !== body.id);
    const removed = next.length !== items.length;
    await store.setJSON(KEY, next);
    return new Response(JSON.stringify({ ok: true, removed }), { headers: { "content-type": "application/json" } });
  }

  return new Response(JSON.stringify({ error: "Ukjent handling" }), { status: 400 });
}

export default async (req, context) => {
  const store = getStore(STORE);
  try {
    return await handle(req, store);
  } catch (err) {
    // Never cached: a storage blip must not linger as a stored failure.
    return new Response(JSON.stringify({ error: String(err.message || err) }), {
      status: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
};

export const config = { path: "/api/news" };
