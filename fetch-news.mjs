// Se ejecuta una vez por día vía GitHub Actions, después de fetch-stats.mjs.
// Trae titulares reales (Google News, sin necesitar API key) para cuatro
// temas fijos y los guarda en data.json bajo la clave "news". No arma
// guiones ni elige ángulos — eso lo hace Ariel a mano, o lo pide en el chat.

import { readFile, writeFile } from "node:fs/promises";

const DATA_PATH = new URL("./data.json", import.meta.url);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// "when:Nd" es un operador que entiende la búsqueda de Google News y filtra
// por antigüedad — lo usamos para que cada tema traiga cosas recientes de
// verdad, en vez de notas viejas que igual matchean las palabras clave.
const TOPICS = [
  { key: "futbol_ar", label: "Fútbol argentino", query: "fútbol argentino primera división when:2d" },
  { key: "basquet", label: "Básquet", query: "básquet argentino NBA when:5d" },
  { key: "curiosidades", label: "Curiosidades de fútbol", query: "curiosidades insólitas anécdotas fútbol when:7d" },
  { key: "futbol_intl", label: "Fútbol internacional", query: "fútbol internacional Champions League mercado de pases when:3d" },
];

const MAX_ITEMS_PER_TOPIC = 6; // cuántas trae de nuevo por corrida
const MAX_STORED_PER_TOPIC = 40; // techo de seguridad acumulado, además de los 3 días
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000; // se borran a los 3 días de haberse guardado

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

function textOf(match) {
  if (!match) return "";
  let t = match[1].trim();
  t = t.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
  return decodeEntities(t);
}

function stripSourceSuffix(title, source) {
  if (source && title.endsWith(" - " + source)) {
    return title.slice(0, title.length - source.length - 3).trim();
  }
  return title;
}

async function fetchTopic(topic) {
  const url =
    "https://news.google.com/rss/search?q=" +
    encodeURIComponent(topic.query) +
    "&hl=es-419&gl=AR&ceid=AR:es-419";

  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "es-AR,es;q=0.9" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();

  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) && items.length < MAX_ITEMS_PER_TOPIC) {
    const block = m[1];
    const rawTitle = textOf(block.match(/<title>([\s\S]*?)<\/title>/));
    const link = textOf(block.match(/<link>([\s\S]*?)<\/link>/));
    const pubDate = textOf(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/));
    const source = textOf(block.match(/<source[^>]*>([\s\S]*?)<\/source>/));
    if (!rawTitle || !link) continue;
    items.push({
      title: stripSourceSuffix(rawTitle, source),
      link,
      source: source || null,
      pubDate: pubDate || null,
    });
  }
  return items;
}

function mergeTopicItems(existingItems, freshItems, nowIso, nowMs) {
  // el reloj de los 3 días arranca la primera vez que vimos cada noticia
  // (fetched_at), no cuando fue publicada — así siempre queda acumulado
  // lo de los últimos días, aunque una nota puntual sea vieja.
  const byLink = new Map();
  for (const it of existingItems) {
    if (it && it.link) byLink.set(it.link, it);
  }
  for (const it of freshItems) {
    if (!byLink.has(it.link)) byLink.set(it.link, { ...it, fetched_at: nowIso });
  }
  let merged = [...byLink.values()].filter((it) => {
    const fetchedAt = it.fetched_at ? new Date(it.fetched_at).getTime() : nowMs;
    return nowMs - fetchedAt < RETENTION_MS;
  });
  merged.sort((a, b) => new Date(b.pubDate || b.fetched_at) - new Date(a.pubDate || a.fetched_at));
  return merged.slice(0, MAX_STORED_PER_TOPIC);
}

async function main() {
  const data = JSON.parse(await readFile(DATA_PATH, "utf8"));
  const prevTopics = (data.news && Array.isArray(data.news.topics)) ? data.news.topics : [];
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const resultTopics = [];
  let anyOk = false;

  for (const topic of TOPICS) {
    const prev = prevTopics.find((t) => t.key === topic.key);
    const existingItems = prev ? prev.items || [] : [];
    try {
      const fresh = await fetchTopic(topic);
      const items = mergeTopicItems(existingItems, fresh, nowIso, nowMs);
      resultTopics.push({ key: topic.key, label: topic.label, items });
      anyOk = true;
      console.log(`OK  ${topic.label} -> ${fresh.length} nuevas, ${items.length} guardadas en total`);
    } catch (err) {
      // si falla la traída de hoy, igual aplicamos el vencimiento de 3 días
      // sobre lo que ya teníamos, en vez de dejarlo intacto para siempre
      const items = mergeTopicItems(existingItems, [], nowIso, nowMs);
      resultTopics.push({ key: topic.key, label: topic.label, items });
      console.warn(`FAIL ${topic.label}: ${err.message} (se mantienen las anteriores no vencidas)`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  data.news = {
    updated_at: anyOk ? nowIso : (data.news && data.news.updated_at) || null,
    topics: resultTopics,
  };

  await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log("data.json actualizado con noticias.");
}

main().catch((err) => {
  console.error("Error general del script:", err);
  process.exit(1);
});
