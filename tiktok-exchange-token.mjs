// Se corre UNA sola vez a mano (workflow "Conectar cuenta de TikTok"),
// disparado con el código que TikTok te da después de loguearte en
// tiktok-login.html. Canjea ese código por un access_token + refresh_token
// y guarda el refresh_token cifrado en el repo (.tiktok-refresh.enc) para
// que fetch-tiktok-videos.mjs lo use todos los días sin que tengas que
// volver a loguearte (el refresh_token dura 365 días).

import { writeFile } from "node:fs/promises";
import { encryptSecret } from "./tiktok-crypto.mjs";

const CODE = process.env.TIKTOK_AUTH_CODE;
const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const PASSPHRASE = process.env.TIKTOK_ENC_PASSPHRASE;
const REDIRECT_URI = "https://arieldamianbetta-rgb.github.io/ariel-tiktok-dashboard/tiktok-callback.html";
const ENC_PATH = new URL("./.tiktok-refresh.enc", import.meta.url);

function requireEnv(name, value) {
  if (!value) {
    console.error(`Falta el secret ${name}. Cargalo en GitHub → Settings → Secrets and variables → Actions.`);
    process.exit(1);
  }
}

async function main() {
  requireEnv("TIKTOK_AUTH_CODE (input del workflow)", CODE);
  requireEnv("TIKTOK_CLIENT_KEY", CLIENT_KEY);
  requireEnv("TIKTOK_CLIENT_SECRET", CLIENT_SECRET);
  requireEnv("TIKTOK_ENC_PASSPHRASE", PASSPHRASE);

  const body = new URLSearchParams({
    client_key: CLIENT_KEY,
    client_secret: CLIENT_SECRET,
    code: CODE,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    },
    body,
  });

  const json = await res.json();

  if (!res.ok || !json.refresh_token) {
    console.error("TikTok no devolvió un token válido. Respuesta:", JSON.stringify(json, null, 2));
    console.error("Tips: el código vale pocos minutos y se usa una sola vez — si ya lo usaste o pasó el tiempo, generá uno nuevo desde tiktok-login.html.");
    process.exit(1);
  }

  const encrypted = encryptSecret(json.refresh_token, PASSPHRASE);
  await writeFile(ENC_PATH, encrypted + "\n");

  console.log("Conexión con TikTok exitosa.");
  console.log(`open_id: ${json.open_id || "(no informado)"}`);
  console.log(`access_token expira en: ${json.expires_in}s — refresh_token expira en: ${json.refresh_expires_in ?? "365 días (por defecto)"}s`);
  console.log(".tiktok-refresh.enc actualizado — hace falta commitearlo (lo hace el propio workflow).");
}

main().catch((err) => {
  console.error("Error general:", err);
  process.exit(1);
});
