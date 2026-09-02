// Se ejecuta una vez por día vía GitHub Actions, después de fetch-stats.mjs.
// Si la cuenta todavía no está conectada a la API de TikTok (falta
// .tiktok-refresh.enc), no hace nada y termina bien — así no rompe el resto
// del dashboard mientras Ariel no haya hecho el login inicial.
//
// Si está conectada: renueva el access_token, trae la lista de videos
// propios con vistas/me gusta/comentarios/compartidos reales, actualiza
// data.json (me.videos y el "Video top" automático), y vuelve a guardar el
// refresh_token cifrado por si TikTok lo rotó.

import { readFile, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { encryptSecret, decryptSecret } from "./tiktok-crypto.mjs";

const DATA_PATH = new URL("./data.json", import.meta.url);
const ENC_PATH = new URL("./.tiktok-refresh.enc", import.meta.url);

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const PASSPHRASE = process.env.TIKTOK_ENC_PASSPHRASE;

async function fileExists(url) {
  try {
    await access(url, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    client_key: CLIENT_KEY,
    client_secret: CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body,
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`No se pudo renovar el token: ${JSON.stringify(json)}`);
  }
  return json; // { access_token, refresh_token, expires_in, ... }
}

async function fetchVideos(accessToken) {
  const fields = "id,title,cover_image_url,share_url,view_count,like_count,comment_count,share_count,create_time";
  const videos = [];
  let cursor = 0;
  let hasMore = true;

  while (hasMore && videos.length < 40) {
    const res = await fetch(`https://open.tiktokapis.com/v2/video/list/?fields=${fields}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ max_count: 20, cursor }),
    });
    const json = await res.json();
    if (!res.ok || json.error?.code !== "ok") {
      throw new Error(`video.list falló: ${JSON.stringify(json)}`);
    }
    const data = json.data || {};
    videos.push(...(data.videos || []));
    hasMore = !!data.has_more;
    cursor = data.cursor || 0;
  }

  return videos;
}

async function main() {
  if (!(await fileExists(ENC_PATH))) {
    console.log("TikTok API todavía no está conectada (no existe .tiktok-refresh.enc) — se omite este paso.");
    return;
  }
  if (!CLIENT_KEY || !CLIENT_SECRET || !PASSPHRASE) {
    console.warn("Faltan secrets de TikTok (CLIENT_KEY/CLIENT_SECRET/ENC_PASSPHRASE) — se omite este paso.");
    return;
  }

  const encrypted = (await readFile(ENC_PATH, "utf8")).trim();
  const storedRefreshToken = decryptSecret(encrypted, PASSPHRASE);

  let tokenInfo;
  try {
    tokenInfo = await refreshAccessToken(storedRefreshToken);
  } catch (err) {
    console.warn(`No se pudo renovar el token de TikTok: ${err.message} (se mantienen los últimos datos de video conocidos)`);
    return;
  }

  // TikTok puede devolver un refresh_token nuevo — si es así hay que
  // guardar ESE, porque el anterior deja de servir.
  const newRefreshToken = tokenInfo.refresh_token || storedRefreshToken;
  await writeFile(ENC_PATH, encryptSecret(newRefreshToken, PASSPHRASE) + "\n");

  let videos;
  try {
    videos = await fetchVideos(tokenInfo.access_token);
  } catch (err) {
    console.warn(`No se pudo traer la lista de videos: ${err.message} (se mantienen los últimos datos conocidos)`);
    return;
  }

  if (!videos.length) {
    console.log("La cuenta no tiene videos públicos o la API no devolvió ninguno.");
    return;
  }

  videos.sort((a, b) => (b.view_count || 0) - (a.view_count || 0));

  const data = JSON.parse(await readFile(DATA_PATH, "utf8"));
  data.me.videos = videos.slice(0, 10).map((v) => ({
    id: v.id,
    title: v.title || v.video_description || "",
    cover: v.cover_image_url,
    url: v.share_url,
    views: v.view_count || 0,
    likes: v.like_count || 0,
    comments: v.comment_count || 0,
    shares: v.share_count || 0,
    created: v.create_time ? new Date(v.create_time * 1000).toISOString().slice(0, 10) : null,
  }));

  const top = data.me.videos[0];
  data.me.top_video_views = top.views;
  data.me.top_video_label = top.title || data.me.top_video_label;
  data.me.top_video_auto = true; // marca que ya no es un pick manual

  await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log(`OK — ${data.me.videos.length} videos actualizados. Top: "${top.title}" con ${top.views} vistas.`);
}

main().catch((err) => {
  console.error("Error general en fetch-tiktok-videos.mjs:", err);
  // no cortamos el workflow entero por esto: seguimos con exit 0
});
