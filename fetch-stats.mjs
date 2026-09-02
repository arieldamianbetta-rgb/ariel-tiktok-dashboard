// Se ejecuta una vez por día vía GitHub Actions.
// Lee data.json, intenta refrescar los números públicos (seguidores / me gusta)
// de cada cuenta de TikTok leyendo el HTML público del perfil, y vuelve a
// escribir data.json. Si una cuenta falla (TikTok bloquea, cambia de formato,
// etc.) se deja el último valor bueno conocido y se marca ok:false, en vez de
// romper todo el dashboard.

import { readFile, writeFile } from "node:fs/promises";

const DATA_PATH = new URL("./data.json", import.meta.url);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchStats(handle) {
  const url = `https://www.tiktok.com/@${handle}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} para @${handle}`);
  const html = await res.text();

  const match = html.match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!match) throw new Error(`No se encontró el bloque de datos para @${handle}`);

  const json = JSON.parse(match[1]);
  const userDetail = json?.__DEFAULT_SCOPE__?.["webapp.user-detail"];
  const stats = userDetail?.userInfo?.stats;
  if (!stats || typeof stats.followerCount !== "number") {
    throw new Error(`Estructura de datos inesperada para @${handle}`);
  }

  return {
    followers: stats.followerCount,
    hearts: stats.heartCount ?? stats.heart ?? 0,
  };
}

function todayInArgentina() {
  // YYYY-MM-DD en huso horario de Argentina (UTC-3, sin horario de verano)
  const now = new Date();
  const arg = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return arg.toISOString().slice(0, 10);
}

async function main() {
  const data = JSON.parse(await readFile(DATA_PATH, "utf8"));

  const targets = [
    { ref: data.me, handle: data.me.handle },
    ...data.competitors.map((c) => ({ ref: c, handle: c.handle })),
  ];

  let anyOk = false;

  for (const { ref, handle } of targets) {
    try {
      const stats = await fetchStats(handle);
      ref.followers = stats.followers;
      ref.hearts = stats.hearts;
      ref.ok = true;
      anyOk = true;
      console.log(`OK  @${handle} -> ${stats.followers} seguidores, ${stats.hearts} me gusta`);
    } catch (err) {
      ref.ok = false;
      console.warn(`FAIL @${handle}: ${err.message} (se mantiene el último valor conocido)`);
    }
    // pausa corta entre requests para no golpear TikTok todas juntas
    await new Promise((r) => setTimeout(r, 1500));
  }

  if (anyOk) {
    data.updated_at = new Date().toISOString();
  }

  // actualizar historial de seguidores propios (una entrada por día)
  // guardamos también hearts para poder calcular la tendencia de "me gusta
  // por seguidor" (engagement) — las entradas viejas no lo tienen, no pasa nada,
  // el dashboard arranca a mostrar la tendencia apenas haya dos días con el dato
  const today = todayInArgentina();
  const history = Array.isArray(data.history) ? data.history : [];
  const last = history[history.length - 1];
  if (last && last.date === today) {
    last.followers = data.me.followers;
    last.hearts = data.me.hearts;
  } else {
    history.push({ date: today, followers: data.me.followers, hearts: data.me.hearts });
  }
  data.history = history.slice(-60); // guardamos hasta 60 días

  await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log("data.json actualizado.");
}

main().catch((err) => {
  console.error("Error general del script:", err);
  process.exit(1);
});
