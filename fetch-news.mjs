// Se ejecuta una vez por día vía GitHub Actions, después de fetch-stats.mjs.
// Trae titulares reales (Google News, sin necesitar API key) para cuatro
// temas fijos y los guarda en data.json bajo la clave "news". No arma
// guiones ni elige ángulos — eso lo hace Ariel a mano, o lo pide en el chat.

import { readFile, writeFile } from "node:fs/promises";

const DATA_PATH = new URL("./data.json", import.meta.url);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const TOPICS = [
  { key: "futbol_ar", label: "Fútbol argentino", query: "fútbol argentino primera división" },
  { key: "basquet", label: "Básquet", query: "básquet NBA liga nacional" },
  { key: "curiosidades", label: "Curiosidades de fútbol", query: "curiosidades fútbol datos" },
  { key: "futbol_intl", label: "Fútbol internacional", query: "fútbol internacional Champions League mercado de pases" },
];

const MAX_ITEMS_PER_TOPIC = 6;

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

async function main() {
  const data = JSON.parse(await readFile(DATA_PATH, "utf8"));
  const prevTopics = (data.news && Array.isArray(data.news.topics)) ? data.news.topics : [];

  const resultTopics = [];
  let anyOk = false;

  for (const topic of TOPICS) {
    try {
      const items = await fetchTopic(topic);
      resultTopics.push({ key: topic.key, label: topic.label, items });
      anyOk = true;
      console.log(`OK  ${topic.label} -> ${items.length} titulares`);
    } catch (err) {
      // si falla, mantenemos los titulares del día anterior para ese tema
      // en vez de dejar la sección vacía
      const prev = prevTopics.find((t) => t.key === topic.key);
      resultTopics.push({ key: topic.key, label: topic.label, items: prev ? prev.items : [] });
      console.warn(`FAIL ${topic.label}: ${err.message} (se mantienen los titulares anteriores)`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  data.news = {
    updated_at: anyOk ? new Date().toISOString() : (data.news && data.news.updated_at) || null,
    topics: resultTopics,
  };

  await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log("data.json actualizado con noticias.");
}

main().catch((err) => {
  console.error("Error general del script:", err);
  process.exit(1);
});
