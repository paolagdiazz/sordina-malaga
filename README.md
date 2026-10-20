# Sordina · urban noise live

Mobile web app: real-time noise map, sensor details, profiles, quiet routes and
"Measure here" with anonymous submission.

## Link: `https://sordina-malaga.onrender.com`


## Structure

- `server.js`: API (`/api/ingest`, `/api/registros`, `/api/agregados`, `/api/ruta`, `/api/buscar`, `/api/lugares`) and static files.
- `scripts/build-data.js`: converts `data/campana_completa_geo.csv` into `public/data/sensores.json` (`npm run datos`).
- `public/js/config.js`: thresholds by profile with their source, color scale, engine parameters and measurement settings.
- `public/js/sim.js`: deterministic real-time engine. `public/js/measure.js`: sound meter (Web Audio).
- `public/vendor/`: MapLibre GL JS 4.7.1 and typefaces, served from the server itself (no third-party CDNs).

## Privacy

- The database only has the `submissions(cell, time, db, quality, token)` table and a street name cache.
- No access logs are written. Rate limiting uses an HMAC of the IP with a salt that changes every
  10 minutes and lives only in memory.
- Audio never leaves the browser. Exact position either: only the identifier of a ~150 m cell.

---
---

# Sordina · ruido urbano en directo

App web móvil: mapa de ruido «en directo», detalle de sensores, perfiles, rutas tranquilas y
«Medir aquí» con envío anónimo.

## Enlace: `https://sordina-malaga.onrender.com`


## Estructura

- `server.js`: API (`/api/ingest`, `/api/registros`, `/api/agregados`, `/api/ruta`, `/api/buscar`, `/api/lugares`) y archivos estáticos.
- `scripts/build-data.js`: convierte `data/campana_completa_geo.csv` en `public/data/sensores.json` (`npm run datos`).
- `public/js/config.js`: umbrales por perfil con su fuente, escala de color, parámetros del motor y de la medición.
- `public/js/sim.js`: motor «en directo» determinista. `public/js/measure.js`: sonómetro (Web Audio).
- `public/vendor/`: MapLibre GL JS 4.7.1 y tipografías, servidos desde el propio servidor (sin CDN de terceros).

## Privacidad

- La base de datos solo tiene la tabla `aportes(celda, hora, db, calidad, token)` y una caché de nombres de calle.
- No se escriben registros de acceso. La limitación de tasa usa un HMAC de la IP con una sal que cambia cada
  10 min y vive solo en memoria.
- El audio nunca sale del navegador. La posición exacta tampoco: solo el identificador de la celda de ~150 m.
