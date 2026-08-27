const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function main() {
  const url = "https://www.tiktok.com/@ariel_betta45";
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "es-AR,es;q=0.9,en;q=0.8" },
  });
  console.log("HTTP status:", res.status);
  const html = await res.text();
  console.log("HTML length:", html.length);
  const match = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) { console.log("NO se encontro el script de rehidratacion."); return; }
  const json = JSON.parse(match[1]);
  const scope = json.__DEFAULT_SCOPE__ || {};
  console.log("Claves de scope:", Object.keys(scope));
  const userDetail = scope["webapp.user-detail"];
  if (userDetail) {
    console.log("Claves de webapp.user-detail:", Object.keys(userDetail));
    console.log("Claves de userInfo:", Object.keys(userDetail.userInfo || {}));
  }
  function findItemLists(obj, path, depth) {
    if (!obj || typeof obj !== "object" || depth > 6) return;
    if (Array.isArray(obj.itemList) && obj.itemList.length) {
      console.log("itemList en:", path, "cantidad:", obj.itemList.length);
      console.log("keys primer item:", Object.keys(obj.itemList[0]));
      console.log(JSON.stringify(obj.itemList[0]).slice(0, 1500));
    }
    for (const k of Object.keys(obj)) { findItemLists(obj[k], path + "." + k, depth + 1); }
  }
  findItemLists(scope, "scope", 0);
}
main().catch((err) => { console.error("Error:", err.message); process.exit(1); });
