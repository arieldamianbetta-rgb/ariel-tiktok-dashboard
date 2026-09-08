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
import webpush from "web-push";

const DATA_PATH = new URL("./data.json", import.meta.url);
const ENC_PATH = new URL("./.tiktok-refresh.enc", import.meta.url);

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const PASSPHRASE = process.env.TIKTOK_ENC_PASSPHRASE;

const PUSH_SUB_PATH = new URL("./push-subscription.json", import.meta.url);
const VAPID_PUBLIC_KEY = "BDD7Q3L2HmFH6ivQMYBNbmHUzDStr0bIUM_MlOZML5cpUZHBlQfEHpquJdgpgsWzfa6gU5YFQR8nNU-QmNOPu04";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = "https://arieldamianbetta-rgb.github.io/ariel-tiktok-dashboard/";

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

function computePostingStreak(rawVideos) {
  const dates = new Set();
  for (const v of rawVideos) {
    if (!v.create_time) continue;
    dates.add(new Date(v.create_time * 1000).toISOString().slice(0, 10));
  }
  if (dates.size === 0) return 0;
  const sorted = Array.from(dates).sort().reverse(); // más reciente primero

  // Si el post más reciente fue ayer (no hoy), la racha sigue viva hasta
  // que termine el día de hoy — no la cortamos solo porque todavía no
  // publicó nada hoy.
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (sorted[0] !== today && sorted[0] !== yesterday) return 0;

  let streak = 1;
  const cursor = new Date(sorted[0] + "T00:00:00Z");
  for (let i = 1; i < sorted.length; i++) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    if (sorted[i] === cursor.toISOString().slice(0, 10)) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

function computeViewPercentile(views, allViews) {
  if (!Array.isArray(allViews) || allViews.length < 2) return null;
  let countBelow = 0;
  for (const v of allViews) {
    if (v < views) countBelow++;
  }
  return Math.round((countBelow / (allViews.length - 1)) * 100);
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

async function sendTrendingNotifications(data, rawVideos, trendingIds) {
  if (trendingIds.size === 0) return;
  if (!(await fileExists(PUSH_SUB_PATH))) return;
  if (!VAPID_PRIVATE_KEY) {
    console.warn("Falta el secret VAPID_PRIVATE_KEY — no se pueden mandar notificaciones push.");
    return;
  }

  const notified = new Set(data.me.notified_trending_ids || []);
  const newlyTrending = rawVideos.filter((v) => trendingIds.has(v.id) && !notified.has(v.id));
  if (newlyTrending.length === 0) return;

  let subscription;
  try {
    subscription = JSON.parse(await readFile(PUSH_SUB_PATH, "utf8"));
  } catch (err) {
    console.warn(`No se pudo leer push-subscription.json: ${err.message}`);
    return;
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  for (const v of newlyTrending) {
    const title = v.title || v.video_description || "Un video tuyo";
    const payload = JSON.stringify({
      title: "🚀 Un video está despegando",
      body: title.slice(0, 120),
      url: v.share_url || VAPID_SUBJECT,
    });
    try {
      await webpush.sendNotification(subscription, payload);
      notified.add(v.id);
      console.log(`Notificación mandada: "${title}"`);
    } catch (err) {
      console.warn(`No se pudo mandar la notificación de "${title}": ${err.message}`);
    }
  }

  data.me.notified_trending_ids = Array.from(notified).slice(-200);
}

function computeWeeklySummary(data, rawVideos) {
  const nowMs = Date.now();
  const weekAgoMs = nowMs - 7 * 86400000;
  const weekVideos = rawVideos.filter((v) => v.create_time && v.create_time * 1000 >= weekAgoMs);

  let topVideo = null;
  for (const v of weekVideos) {
    if (!topVideo || (v.view_count || 0) > (topVideo.view_count || 0)) topVideo = v;
  }

  const hashtagAgg = {};
  for (const v of weekVideos) {
    for (const tag of extractHashtags(v.title)) {
      if (!hashtagAgg[tag]) hashtagAgg[tag] = { tag, count: 0, views: 0 };
      hashtagAgg[tag].count += 1;
      hashtagAgg[tag].views += v.view_count || 0;
    }
  }
  const topHashtagEntry = Object.values(hashtagAgg).sort((a, b) => b.views - a.views)[0] || null;

  const hist = data.history || [];
  let followersDelta = null;
  let heartsDelta = null;
  if (hist.length >= 2) {
    const last = hist[hist.length - 1];
    const base =
      [...hist].reverse().find((h) => new Date(last.date) - new Date(h.date) >= 6 * 86400000) || hist[0];
    followersDelta = last.followers - base.followers;
    heartsDelta = last.hearts - base.hearts;
  }

  return {
    week_ending: new Date(nowMs - ARG_OFFSET_MS).toISOString().slice(0, 10),
    videos_posted: weekVideos.length,
    followers_delta: followersDelta,
    hearts_delta: heartsDelta,
    top_video: topVideo
      ? {
          title: topVideo.title || topVideo.video_description || "",
          views: topVideo.view_count || 0,
          url: topVideo.share_url || null,
        }
      : null,
    top_hashtag: topHashtagEntry ? { tag: topHashtagEntry.tag, views: topHashtagEntry.views } : null,
  };
}

async function sendWeeklySummaryIfDue(data, rawVideos) {
  const nowLocal = new Date(Date.now() - ARG_OFFSET_MS);
  const isMonday = nowLocal.getUTCDay() === 1;
  const todayLocal = nowLocal.toISOString().slice(0, 10);

  data.me.weekly_summary = computeWeeklySummary(data, rawVideos);

  if (!isMonday) return;
  if (data.me.last_weekly_summary_sent === todayLocal) return;
  data.me.last_weekly_summary_sent = todayLocal;

  if (!(await fileExists(PUSH_SUB_PATH)) || !VAPID_PRIVATE_KEY) return;

  let subscription;
  try {
    subscription = JSON.parse(await readFile(PUSH_SUB_PATH, "utf8"));
  } catch (err) {
    console.warn(`No se pudo leer push-subscription.json para el resumen semanal: ${err.message}`);
    return;
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const summary = data.me.weekly_summary;
  const parts = [];
  if (summary.videos_posted) parts.push(`${summary.videos_posted} video(s) posteado(s)`);
  if (summary.followers_delta !== null) {
    parts.push(`${summary.followers_delta >= 0 ? "+" : ""}${summary.followers_delta} seguidores`);
  }
  if (summary.top_video) {
    parts.push(`top: "${summary.top_video.title.slice(0, 40)}" (${summary.top_video.views} vistas)`);
  }

  const payload = JSON.stringify({
    title: "📊 Tu resumen semanal",
    body: parts.length ? parts.join(" · ") : "Pasá por el dashboard para ver cómo te fue esta semana.",
    url: VAPID_SUBJECT,
  });

  try {
    await webpush.sendNotification(subscription, payload);
    console.log("Resumen semanal enviado por push.");
  } catch (err) {
    console.warn(`No se pudo mandar el resumen semanal: ${err.message}`);
  }
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
  await sendTrendingNotifications(data, rawVideos, trendingIds);
  await sendWeeklySummaryIfDue(data, rawVideos);

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

  const allViews = rawVideos.map((v) => v.view_count || 0);
  data.me.videos = mapped.slice(0, 10).map((v) => ({
    ...v,
    trending: trendingIds.has(v.id),
    percentile: computeViewPercentile(v.views, allViews),
  }));
  data.me.posting_streak = computePostingStreak(rawVideos);
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
