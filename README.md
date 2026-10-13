# JKAnimeNuvio

Addon **solo de streams** que usa el protocolo de addons de Stremio para servir enlaces
directos (MP4 o HLS) de episodios de [JKAnime](https://jkanime.net). Está pensado para
[Nuvio](https://github.com/tapframe/NuvioStreaming), pero cualquier cliente compatible con
Stremio puede usarlo.

No está afiliado a JKAnime. Deriva de
[animeflv-stremio-addon](https://github.com/Pigamer37/animeflv-stremio-addon) (MIT).

## Qué hace (y qué no)

- Expone únicamente el recurso `stream`. No hay `catalog` ni `meta`: los metadatos los
  aporta el addon que ya uses (Cinemeta, TMDB, Kitsu…).
- Usa JKAnime como única fuente de vídeo. TMDB, TVDB, AniList, Kitsu, Cinemeta y las bases de
  relaciones (yuna, ani.zip) se consultan solo para **identificar** el anime y el episodio
  que pide el cliente.
- Devuelve solo URLs `http(s)` directas a `.mp4` o `.m3u8` (más Pixeldrain y Streamtape,
  que sirven el archivo sin extensión). Nunca devuelve `externalUrl` ni páginas embed.

## Instalación

```bash
npm ci
npm test
cp .env.example .env   # opcional: añade tus credenciales de TMDB/TVDB
PORT=3000 npm start
```

Instala en Nuvio o Stremio con `https://<tu-servidor>/manifest.json`.

### Android con Termux

1. Instala [Termux](https://f-droid.org/packages/com.termux/) desde F-Droid.
2. En Termux:
   ```bash
   pkg update && pkg install nodejs-lts git
   git clone -b feature/jkanime-stream-only https://github.com/Eibyx/JkAnimeNuvio.git
   cd JkAnimeNuvio
   npm ci --omit=dev
   cp .env.example .env
   nano .env          # TMDB_API_READ_TOKEN, TVDB_API_KEY…
   npm start
   ```
3. En Nuvio instala `http://127.0.0.1:3000/manifest.json`. El servidor corre en el mismo
   teléfono, así que no hay que exponer ningún puerto.
4. Para mantenerlo activo con la pantalla apagada, ejecuta `termux-wake-lock` y desactiva
   la optimización de batería de Termux.
5. Comprobación real: `npm run live-check -- tt42938834:1:1 anilist:187316:1`. Muestra qué
   proveedores están configurados (nunca sus valores), la identidad encontrada con sus
   evidencias y los streams.

`.env` está en `.gitignore`: no lo subas a GitHub. Las credenciales solo viajan a sus APIs
y se ocultan (`***`) en mensajes de error y logs.

## Variables de entorno

Todas son opcionales. Consulta [`.env.example`](.env.example).

| Variable | Uso |
|---|---|
| `TMDB_API_READ_TOKEN` | TMDB, token de lectura (Bearer). Preferido. |
| `TMDB_API_KEY` | TMDB, clave v3 (si no hay token). |
| `TVDB_API_KEY` | TheTVDB API v4. |
| `TVDB_SUBSCRIBER_PIN` | PIN de suscriptor, solo para claves de usuario de TVDB. |
| `METADATA_PROVIDER` | `auto` (TMDB → TVDB, más Cinemeta), o `tmdb`, `tvdb`, `cinemeta`. |
| `CINEMETA_ENABLED` | `false` desactiva Cinemeta; la numeración por defecto pasa a ser TMDB/TVDB. |
| `RELATIONS_ENABLED` | `false` desactiva yuna y ani.zip. |
| `*_TIMEOUT_MS` | Límite de tiempo por proveedor. |

Un proveedor sin credenciales, caído o que responde 401 se omite; los demás siguen
funcionando.

## IDs admitidos

| ID | Ejemplo | Numeración por defecto |
|---|---|---|
| IMDb | `tt7441658:2:1` | `auto`: Cinemeta si conoce la serie; si no, TMDB; si no, TVDB |
| TMDB | `tmdb:73223:2:1` | TMDB (requiere credencial de TMDB) |
| TVDB | `tvdb:482279:1:1` | TVDB, orden por defecto (requiere `TVDB_API_KEY`) |
| Kitsu / MAL / AniList | `kitsu:13209:5`, `mal:61140:1`, `anilist:187316:1` | Episodio de esa entrada |
| Película IMDb/TMDB | `tt…`, `tmdb:…` (tipo `movie`) | — |

### Elegir la numeración explícitamente

El proveedor que identifica la serie **no** decide la numeración. Se elige en la URL del
manifiesto. Cada combinación tiene su propio `id`, así que puede instalarse junto a la
normal:

| URL | Significado |
|---|---|
| `/manifest.json` | `numbering=auto`, `mapping=auto` (comportamiento de v0.1) |
| `/numbering=tmdb/manifest.json` | Temporadas de TMDB |
| `/numbering=tvdb/manifest.json` | Orden por defecto de TVDB |
| `/numbering=tvdb-absolute/manifest.json` | También `tvdb-official`, `-dvd`, `-alternate`, `-regional` |
| `/mapping=season/manifest.json` | Solo entradas independientes por temporada (estilo AniList) |
| `/mapping=absolute/manifest.json` | Solo numeración continua en la entrada principal de JKAnime |

Se combinan: `/numbering=tmdb&mapping=absolute/manifest.json`.

## Cómo se identifica el episodio

1. **Identidad** (`lib/identity.js`). Para IMDb se consultan TMDB (`/find`) y Cinemeta en
   paralelo, y TVDB (`/search/remoteid`) solo si TMDB no da una respuesta fiable (o si se
   pide numeración TVDB). Solo cuenta el índice de IMDb **del propio proveedor**:
   - Si un proveedor devuelve otro IMDb id, o varias series, su respuesta se descarta.
   - Si dos proveedores se contradicen (ids distintos, o nombres y años distintos), se
     descarta el de menor prioridad (TMDB > TVDB > Cinemeta).
2. **Correspondencias con AniList.** yuna y ani.zip **proponen** ids a partir de los de
   TMDB/TVDB. Una propuesta solo se acepta si la entrada de AniList tiene un formato
   compatible (TV/ONA para series, MOVIE para películas), su título coincide y, además,
   coincide el año o lo confirma una segunda base de datos. Ejemplo real: las dos bases
   asignan Black Clover a AniList 87528 (un especial de 2016); el addon lo rechaza.
3. **Títulos.** Nombres de los proveedores (canónicos), títulos alternativos y traducidos
   de TMDB/TVDB, y títulos y sinónimos de AniList de la entrada emitida el mismo año que la
   temporada pedida. Los títulos japoneses nativos se usan para buscar en AniList.
4. **JKAnime.** Igual que en v0.1: se puntúan los títulos, se verifica el año en la ficha y,
   si hay ambigüedad, no se devuelve nada. Hay numeración continua de respaldo.
5. **Página del episodio.** Debe coincidir el número de episodio.

Si Cinemeta **falla** (no si simplemente desconoce la serie), `auto` no cambia en silencio
a TMDB: devuelve vacío durante un minuto. Las identidades se guardan en caché 6 h (24 h las
correspondencias) y solo 60 s si algún proveedor falló.

### Gensou Suikoden (`tt42938834`), datos reales del 13‑10‑2026

| Fuente | Resultado |
|---|---|
| Cinemeta | `{}`: no la conoce |
| TheTVDB 482279 (`/series/gensou-suikoden`) | Enlaza `imdb.com/title/tt42938834`; títulos "Suikoden: The Anime", "Gensou Suikoden" |
| TMDB 285710 ("Suikoden: The Anime", 2026) | La página pública no muestra enlace a IMDb |
| yuna (AniList 187316) | imdb tt42938834, tmdb 285710, tvdb 482279 |
| ani.zip (AniList 187316) | tmdb 285710, tvdb 460979 (404 en TVDB: dato obsoleto), sin imdb |
| AniList 187316 | "Gensou Suikoden", TV, otoño 2026, sinónimo "Suikoden: The Anime" |

Sin credenciales, `tt42938834` no se puede identificar (ningún servicio público permite
buscar por IMDb), y el addon no adivina. Con `TVDB_API_KEY`, TVDB resuelve el IMDb id a la
serie 482279. Con `TMDB_*` se consulta TMDB primero; si TMDB llegara a enlazar el IMDb id,
TVDB ni se consultaría. No se ha añadido ninguna correspondencia manual.

### Black Clover (`tt7441658`)

Datos reales de Cinemeta: T1 = 170 episodios (2017‑2021), T2 = 13 episodios desde el
03‑10‑2026, T0 = 19 especiales. TMDB divide los 170 en 4 temporadas (51/51/52/16).

| Petición | Resultado |
|---|---|
| `tt7441658:1:1` … `:1:170` | `black-clover-tv` ep. 1…170 |
| `tt7441658:2:1` (`auto`, Cinemeta; también con TMDB/TVDB configurados) | entrada de la 2.ª temporada (2026), ep. 1 |
| `tt7441658:2:1` sin entrada 2026 en JKAnime | vacío (171 > 170) |
| `tt7441658:2:1` con `numbering=tmdb` o `numbering=tvdb` | `black-clover-tv` ep. 52 |
| `tt7441658:1:52` con `numbering=tvdb-absolute` | `black-clover-tv` ep. 52 |
| `tt7441658:0:N` | vacío |

## Servidores

Servidor propio de JKAnime (`jkplayer`), YourUpload, MP4Upload, Streamwish, Vidhide o
Filelions, VOE, Filemoon, Mixdrop, Streamtape, Pixeldrain y OK.ru. Los demás (Mega,
Doodstream…) se omiten. Cada stream incluye `behaviorHints.proxyHeaders.request` con
`Referer` y `User-Agent`, y `notWebReady: true`.

Las URLs de los embeds proceden de HTML de terceros. Por eso solo se aceptan destinos
`http(s)` públicos: se rechazan localhost, IPs privadas y credenciales en la URL.

## Pruebas

- `npm test`: pruebas **sin red** (`node:test`).
  - **Reales** (copias recortadas del 13‑10‑2026): Cinemeta, búsquedas de AniList, yuna y
    ani.zip.
  - **Sintéticas**: TMDB y TVDB (sin credenciales en este entorno; siguen la forma de sus
    APIs públicas con los ids y títulos reales), y el HTML de JKAnime y de los servidores.
  - Las credenciales de prueba son ficticias.
- `npm run live-check [-- ids…]`: comprobación **real** contra los proveedores y JKAnime.

## Despliegue

`.github/workflows/deploy.yml` solo se ejecuta manualmente (`workflow_dispatch`). Al hacer
push o merge a `main` no se despliega nada.
