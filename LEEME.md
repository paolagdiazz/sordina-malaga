# Sordina · ruido urbano en directo (Málaga) — MVP

App web móvil: mapa de ruido «en directo», detalle de sensores, perfiles, rutas tranquilas y
«Medir aquí» con envío anónimo. Un único servidor Node sin dependencias (SQLite incluido en Node).

## Ponerla en marcha en tu PC (5 minutos, enlace HTTPS público temporal)

1. Instala Node.js 22 o superior y el túnel de Cloudflare (PowerShell):
   ```
   winget install OpenJS.NodeJS.LTS
   winget install --id Cloudflare.cloudflared
   ```
   Cierra y vuelve a abrir PowerShell.
2. Arranca la app:
   ```
   cd $HOME\Desktop\LD\sordina-app
   node server.js
   ```
   Comprueba que http://localhost:3000 abre el mapa.
3. En otra ventana de PowerShell, abre el túnel:
   ```
   cloudflared tunnel --url http://localhost:3000
   ```
   Aparecerá una dirección `https://algo-aleatorio.trycloudflare.com`. Ábrela en el iPhone (Safari)
   y en el Android (Chrome). Funciona mientras el PC y las dos ventanas sigan abiertos.

## Publicarla de forma permanente (Render, gratis)

1. Crea un repositorio en GitHub y sube el contenido de esta carpeta (todo salvo `node_modules`
   si existiera; en GitHub: «Add file › Upload files» y arrastra los archivos y carpetas).
2. En https://render.com: «New › Blueprint», elige el repositorio y pulsa «Apply».
   El archivo `render.yaml` ya lo configura todo (Node 22, sin paso de compilación).
3. Tendrás un enlace `https://sordina-malaga.onrender.com` (o parecido).

Notas del plan gratuito: el servicio se duerme tras 15 min sin visitas (la primera carga tarda
~1 min) y el disco se borra en cada reinicio. Para esta demo da igual, porque los datos se purgan
a las 24 h de todas formas.

## Variables de entorno (opcionales)

| Variable | Por defecto | Qué hace |
|---|---|---|
| `PORT` | 3000 | Puerto HTTP |
| `MIN_APORTES` | 2 | Aportaciones mínimas por celda y ventana para fiabilidad normal |
| `RETENCION_HORAS` | 24 | Purga de registros |
| `LIMITE_TASA` | 30 | Envíos por cliente cada 10 min (en memoria, sin guardar IP) |
| `GEOCODIFICAR` | 1 | Nombres de calle con Nominatim al arrancar (`0` para desactivar) |
| `OSRM_URL` / `OSRM_BICI_URL` | routing.openstreetmap.de | Servidores de rutas a pie / en bici |

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
