// Manda una notificación push de prueba usando la suscripción guardada
// en push-subscription.json. Se corre a mano desde el workflow
// "Probar notificación push" para confirmar que la clave privada y la
// suscripción funcionan, sin tener que esperar a un video despegando.

import { readFile } from "node:fs/promises";
import webpush from "web-push";

const VAPID_PUBLIC_KEY = "BDD7Q3L2HmFH6ivQMYBNbmHUzDStr0bIUM_MlOZML5cpUZHBlQfEHpquJdgpgsWzfa6gU5YFQR8nNU-QmNOPu04";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = "https://arieldamianbetta-rgb.github.io/ariel-tiktok-dashboard/";
const SUB_PATH = new URL("./push-subscription.json", import.meta.url);

async function main() {
  if (!VAPID_PRIVATE_KEY) {
    console.error("Falta el secret VAPID_PRIVATE_KEY.");
    process.exit(1);
  }

  const subscription = JSON.parse(await readFile(SUB_PATH, "utf8"));

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const payload = JSON.stringify({
    title: "🔔 Prueba de notificaciones",
    body: "Si ves esto, las notificaciones push están funcionando.",
    url: VAPID_SUBJECT,
  });

  await webpush.sendNotification(subscription, payload);
  console.log("Notificación de prueba enviada.");
}

main().catch((err) => {
  console.error("Error mandando la notificación de prueba:", err);
  process.exit(1);
});
