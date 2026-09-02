// Utilidades chiquitas para guardar el refresh_token de TikTok cifrado
// dentro del propio repo (en vez de como GitHub Secret, porque este token
// rota y GitHub no deja reescribir Secrets desde un Action sin credenciales
// extra). Se cifra con AES-256-GCM usando una passphrase que vive en el
// secret TIKTOK_ENC_PASSPHRASE — esa sí es fija y nunca se commitea.

import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "node:crypto";

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, 32);
}

export function encryptSecret(plainText, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, ciphertext]).toString("base64");
}

export function decryptSecret(payloadBase64, passphrase) {
  const raw = Buffer.from(payloadBase64.trim(), "base64");
  const salt = raw.subarray(0, 16);
  const iv = raw.subarray(16, 28);
  const authTag = raw.subarray(28, 44);
  const ciphertext = raw.subarray(44);
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}
