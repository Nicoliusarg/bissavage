# BiS Auto (todas las clases/spec) — sin servidor

Este paquete te deja publicar **una página estática** que:
- Te deja elegir **clase y spec**.
- Muestra el **BiS por slot** con tooltips/íconos (Wowhead).
- Indica **de dónde sale** cada ítem (Raid / Míticas+ / Crafteo).
- **Se actualiza sola**: un GitHub Action genera `bis-feed.js` cada 6 horas usando Warcraft Logs + Blizzard Journal.

## Archivos
- `index.html` → Página web. Carga `bis-feed.js` si existe; sino, muestra un demo mínimo.
- `scripts/update-bis.js` → Script Node que genera `bis-feed.js` (todas las clases/spec).
- `.github/workflows/update-bis.yml` → Action programado cada 6 h.

## Cómo publicarlo (5 pasos)
1. Creá un **repo en GitHub** y subí estos archivos **tal cual** (mantener las rutas).
2. En el repo, andá a **Settings → Secrets and variables → Actions → New repository secret** y agregá:
   - `WCL_CLIENT_ID` y `WCL_CLIENT_SECRET` (tu app en Warcraft Logs).
   - `BLIZZARD_CLIENT_ID` y `BLIZZARD_CLIENT_SECRET` (Battle.net Game Data API).
3. Editá `.github/workflows/update-bis.yml` y ajustá:
   - `RAID_ZONE_ID` → el ID de la raid vigente en WCL (solo cambia por temporada).
   - (Opcional) `SEASON_LABEL`, `REGION`, `LOCALE`.
4. Activa **GitHub Pages**: Settings → Pages → Source: `Deploy from a branch` → Branch: `main` (root).
5. Esperá a que corra el Action (o dale **Run workflow** manual). Se generará `bis-feed.js` en la raíz. Tu sitio quedará en `https://<usuario>.github.io/<repo>/`.

> **Pro tip:** cuando arranque una nueva temporada/raid, cambiá `RAID_ZONE_ID`. Todo lo demás queda automático.

## ¿Cómo funciona?
- **Warcraft Logs (GraphQL)** → toma los **top parses** por clase/spec (mitico) y cuenta **qué ítems** aparecen más por **slot**.
- **Blizzard Journal API** → mapea cada item a su **origen** (Raid / Dungeon) y marca **Crafteo** por heurística si aplica.
- El Action compila `bis-feed.js` con `window.BIS_FEED = {...}`; `index.html` lo lee como `<script>` estático.

## Personalización
- Cambiá estilos en `index.html` (CSS).
- Si querés forzar algún slot por **sims**, podés post-procesar el JSON antes de escribir `bis-feed.js` en `scripts/update-bis.js`.

¡Listo! Subí esto y tenés tu wowhead-lite que se actualiza solo, con todas las clases y specs.
