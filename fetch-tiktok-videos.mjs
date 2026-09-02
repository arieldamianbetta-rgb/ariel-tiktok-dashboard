// Se ejecuta una vez por día vía GitHub Actions, después de fetch-stats.mjs.
// Si la cuenta todavía no está conectada a la API de TikTok (falta
// .tiktok-refresh.enc), no hace nada y termina bien — así no rompe el resto
// del dashboard mientras Ariel no haya hecho el login inicial.
//
// Si está conectada: renueva el access_token, trae la lista de videos
// propios con vistas/me gusta/comentarios/compartidos reales, los datos
// oficiales de perfil (seguidores/me gusta totales), calcula qué hashtags
// y qué día/franja horaria le funcionan mejor, detecta videos que están
// "despegando" (creciendo más rápido de lo normal en sus primeros días),
// actualiza data.json y vuelve a guardar el refresh_token cifrado por si
// TikTok lo rotó.

import { readFile, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { encryptSecret, decryptSecret } from "./tiktok-crypto.mjs";

const DATA_PATH = new URL("./data.json", import.meta.url);
const ENC_PATH = new URL("./.tiktok-refresh.enc", import.meta.url);

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const PASSPHRASE = process.env.TIKTOK_ENC_PASSPHRASE;

const ARG_OFFSET_MS = 3 * 60 * 60 * 1000; // Argentina es UTC-3 todo el año
const WEEKDAYS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

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

async function fetchUserStats(accessToken) {
  const fields = "follower_count,likes_count,video_count";
  const res = await fetch(`https://open.tiktokapis.com/v2/user/info/?fields=${fields}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json();
  if (!res.ok || json.error?.code !== "ok") {
    throw new Error(`user.info falló: ${JSON.stringify(json)}`);
  }
  return json.data.user; // { follower_count, likes_count, video_count }
}

function extractHashtags(title) {
  const matches = (title || "").match(/#[\p{L}\p{N}_]+/gu) || [];
  return [...new Set(matches.map((h) => h.slice(1).toLowerCase()))];
}

function computeHashtagStats(videos) {
  const agg = {};
  for (const v of videos) {
    const tags = extractHashtags(v.title);
    for (const tag of tags) {
      if (!agg[tag]) agg[tag] = { tag, count: 0, views: 0, likes: 0 };
      agg[tag].count += 1;
      agg[tag].views += v.view_count || 0;
      agg[tag].likes += v.like_count || 0;
    }
  }
  return Object.values(agg)
    .filter((a) => a.count >= 2)
    .map((a) => ({
      tag: a.tag,
      count: a.count,
      avg_views: Math.round(a.views / a.count),
      avg_likes: Math.round(a.likes / a.count),
    }))
    .sort((a, b) => b.avg_views - a.avg_views)
    .slice(0, 6);
}

function computePostingPatterns(videos) {
  const valid = videos.filter((v) => v.create_time);
  if (valid.length < 6) return {};

  const byWeekday = {};
  const byDaypart = {};
  const dayparts = [
    { key: "madrugada", label: "Madrugada (00-06h)", from: 0, to: 6 },
    { key: "manana", label: "Mañana (06-12h)", from: 6, to: 12 },
    { key: "tarde", label: "Tarde (12-18h)", from: 12, to: 18 },
    { key: "noche", label: "Noche (18-24h)", from: 18, to: 24 },
  ];

  for (const v of valid) {
    const local = new Date(v.create_time * 1000 - ARG_OFFSET_MS);
    const weekday = local.getUTCDay();
    const hour = local.getUTCHours();
    const dp = dayparts.find((d) => hour >= d.from && hour < d.to) || dayparts[0];

    if (!byWeekday[weekday]) byWeekday[weekday] = { count: 0, views: 0 };
    byWeekday[weekday].count += 1;
    byWeekday[weekday].views += v.view_count || 0;

    if (!byDaypart[dp.key]) byDaypart[dp.key] = { label: dp.label, count: 0, views: 0 };
    byDaypart[dp.key].count += 1;
    byDaypart[dp.key].views += v.view_count || 0;
  }

  const weekdayEntries = Object.entries(byWeekday).map(([wd, s]) => ({
    label: WEEKDAYS[wd],
    count: s.count,
    avg_views: Math.round(s.views / s.count),
  }));
  const daypartEntries = Object.values(byDaypart).map((s) => ({
    label: s.label,
    count: s.count,
    avg_views: Math.round(s.views / s.count),
  }));

  weekdayEntries.sort((a, b) => b.avg_views - a.avg_views);
  daypartEntries.sort((a, b) => b.avg_views - a.avg_views);

  return {
    best_weekday: weekdayEntries[0] || null,
    best_daypart: daypartEntries[0] || null,
    sample_size: valid.length,
  };
}

function updateVideoHistoryAndTrending(data, rawVideos) {
  const today = new Date().toISOString().slice(0, 10);
  const history = data.me.video_history || {};
  const nowMs = Date.now();
  const seenIds = new Set();
  const trendingIds = new Set();

  for (const v of rawVideos) {
    if (!v.id || !v.create_time) continue;
    seenIds.add(v.id);
    const ageDays = (nowMs - v.create_time * 1000) / 86400000;
    const entries = history[v.id] || [];
    const prevEntry =
      entries.length && entries[entries.length - 1].date !== today
        ? entries[entries.length - 1]
        : entries.length > 1
        ? entries[entries.length - 2]
        : null;

    if (ageDays <= 4 && prevEntry && prevEntry.views > 0) {
      const growth = (v.view_count - prevEntry.views) / prevEntry.views;
      if (growth >= 0.3) trendingIds.add(v.id);
    }

    const already = entries.find((e) => e.date === today);
    if (already) {
      already.views = v.view_count || 0;
    } else {
      entries.push({ date: today, views: v.view_count || 0 });
    }
    history[v.id] = entries.slice(-30);
  }

  for (const id of Object.keys(history)) {
    if (seenIds.has(id)) continue;
    const last = history[id][history[id].length - 1];
    const daysSince = last ? (nowMs - new Date(last.date).getTime()) / 86400000 : 999;
    if (daysSince > 25) delete history[id];
  }

  data.me.video_history = history;
  return trendingIds;
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

  let rawVideos;
  try {
    rawVideos = await fetchVideos(tokenInfo.access_token);
  } catch (err) {
    console.warn(`No se pudo traer la lista de videos: ${err.message} (se mantienen los últimos datos conocidos)`);
    return;
  }

  if (!rawVideos.length) {
    console.log("La cuenta no tiene videos públicos o la API no devolvió ninguno.");
    return;
  }

  rawVideos.sort((a, b) => (b.view_count || 0) - (a.view_count || 0));

  const data = JSON.parse(await readFile(DATA_PATH, "utf8"));

  const trendingIds = updateVideoHistoryAndTrending(data, rawVideos);

  const mapped = rawVideos.map((v) => ({
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

  data.me.videos = mapped.slice(0, 10).map((v) => ({ ...v, trending: trendingIds.has(v.id) }));
  data.me.hashtag_stats = computeHashtagStats(rawVideos);
  data.me.posting_patterns = computePostingPatterns(rawVideos);

  const top = data.me.videos[0];
  data.me.top_video_views = top.views;
  data.me.top_video_label = top.title || data.me.top_video_label;
  data.me.top_video_auto = true; // marca que ya no es un pick manual

  try {
    const userStats = await fetchUserStats(tokenInfo.access_token);
    data.me.followers = userStats.follower_count;
    data.me.hearts = userStats.likes_count;
    data.me.ok = true;
    data.me.stats_source = "api";
  } catch (err) {
    console.warn(`No se pudieron traer las stats oficiales de perfil: ${err.message} (se mantiene el valor scrapeado)`);
  }

  await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log(`OK — ${data.me.videos.length} videos actualizados. Top: "${top.title}" con ${top.views} vistas.`);
}

main().catch((err) => {
  console.error("Error general en fetch-tiktok-videos.mjs:", err);
  // no cortamos el workflow entero por esto: seguimos con exit 0
});
