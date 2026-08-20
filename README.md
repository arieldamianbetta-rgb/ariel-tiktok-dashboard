# Dashboard TikTok — Ariel Betta

Página instalable en el celu que muestra tus seguidores, me gusta, y una
comparación con 4 cuentas del nicho. Se actualiza sola una vez por día
mediante un GitHub Action (un robot que corre en los servidores de GitHub,
sin depender de que tengas la compu prendida).

## Qué hace cada archivo

- `index.html` — la app en sí (lee `data.json` y dibuja el dashboard).
- `data.json` — los números. Lo reescribe el robot todos los días.
- `manifest.json` + `icons/` + `sw.js` — lo que permite "instalar" la página
  como ícono en el celu.
- `.github/workflows/update-dashboard.yml` — la configuración del robot
  (a qué hora corre).
- `scripts/fetch-stats.mjs` — el código que el robot ejecuta para leer los
  números públicos de cada cuenta de TikTok.

## Configuración inicial (una sola vez)

1. **Subir todos estos archivos** a la raíz de tu repositorio en GitHub,
   manteniendo la estructura de carpetas (`icons/`, `scripts/`,
   `.github/workflows/`).
2. **Settings → Actions → General → Workflow permissions** → elegir
   **"Read and write permissions"** → Save. (Sin esto el robot no puede
   guardar los cambios; falla con error de permisos.)
3. **Settings → Pages** → Source: `Deploy from a branch` → Branch: `main` →
   `/ (root)` → Save. Ahí te va a aparecer la URL pública (algo como
   `https://tu-usuario.github.io/tu-repo/`).
4. Abrí esa URL desde el navegador de tu celu → menú del navegador →
   **"Agregar a pantalla de inicio"** (Chrome/Android) o **"Compartir" →
   "Agregar a la pantalla de inicio"** (Safari/iPhone). Te queda un ícono
   como una app más.

## Cómo correr el robot manualmente (para probarlo ya, sin esperar al día siguiente)

En GitHub: pestaña **Actions** → click en "Actualizar dashboard de TikTok" →
botón **"Run workflow"**. Tarda menos de un minuto.

## Si un día una cuenta no se actualiza

El robot no rompe todo el dashboard si TikTok le bloquea una cuenta puntual:
esa cuenta queda con el último número bueno conocido y aparece marcada con
⚠ en el dashboard. Avisame y lo reviso.

## Cambiar las cuentas de competencia más adelante

Editar el array `competitors` en `data.json` (agregar/sacar cuentas con su
`handle` y `label`) y la lista `targets` se arma sola a partir de eso en el
próximo corrido del robot — no hace falta tocar el script.
