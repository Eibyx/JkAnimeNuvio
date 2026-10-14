# Anime Catalog Generator

Genera y mantiene **listas de anime en [MDBList](https://mdblist.com)** a partir del catálogo de
**AniList** (o MyAnimeList vía Jikan), con filtros avanzados, **una sola entrada por serie** (la
temporada original) y conversión fiable de IDs a **TMDB** reutilizando los mappings abiertos de
**AniBridge**, **Kometa Anime-IDs** y **Fribb**.

```bash
anime-catalog create --from 2020 --to 2026 --first-only --min-score 75 --format TV \
  --name "Anime 2020-2026" --apply
```

Ese comando consulta AniList (todas las páginas), filtra, agrupa las temporadas de cada serie,
identifica la serie original, resuelve el TMDB TV/Movie ID con AniBridge → Kometa → Fribb, lo
valida en TMDB, elimina duplicados, crea la lista en MDBList si no existe, añade solo lo que falta
y guarda reportes JSON/CSV/HTML.

También tiene **interfaz gráfica** local (móvil y escritorio) que usa el mismo motor:

```bash
anime-catalog ui          # → http://127.0.0.1:8765 (Chrome en Android, cualquier navegador moderno)
```

Y funciona en **Android con Termux** (`bash install-termux.sh` y `bash start-termux.sh`).

---

## Índice

1. [Qué hace](#1-qué-hace)
2. [Instalación](#2-instalación)
3. [API key de MDBList](#3-api-key-de-mdblist)
4. [Configurar TMDB](#4-configurar-tmdb)
5. [Descargar los mappings](#5-descargar-los-mappings)
6. [Comandos](#6-comandos)
7. [Filtros YAML](#7-filtros-yaml)
8. [Cómo funcionan las temporadas](#8-cómo-funcionan-las-temporadas)
9. [Cómo se detecta el anime original](#9-cómo-se-detecta-el-anime-original)
10. [Cómo se convierten los IDs](#10-cómo-se-convierten-los-ids)
11. [Crear listas](#11-crear-listas)
12. [Sincronizar](#12-sincronizar)
13. [GitHub Actions](#13-github-actions)
14. [Revisar mappings incorrectos](#14-revisar-mappings-incorrectos)
15. [Actualizar datasets](#15-actualizar-datasets)
16. [Solución de problemas](#16-solución-de-problemas)
17. [Limitaciones](#17-limitaciones)
18. [Investigación de fuentes (fase 1)](#18-investigación-de-fuentes-fase-1)
19. [Estado de verificación](#19-estado-de-verificación)
20. [Interfaz gráfica](#20-interfaz-gráfica)
21. [Termux (Android)](#21-termux-android)
22. [Rendimiento medido](#22-rendimiento-medido)
23. [Seguridad de la interfaz](#23-seguridad-de-la-interfaz)

---

## 1. Qué hace

```
AniList / MyAnimeList ──► paginación completa (particionada por años)
        │
        ▼
AnimeFilterEngine ──► años, fechas, temporadas, puntuación, géneros, tags, estudios, formato,
        │             estado, popularidad, episodios, adulto, secuelas, spin-offs, remakes… (AND/OR/NOT)
        ▼
CanonicalAnimeResolver ──► grafo PREQUEL/SEQUEL + misma serie TMDB ⇒ una entrada por programa
        │
        ▼
MappingResolver ──► AniBridge → Kometa → Fribb → Anime-Lists → TMDB /find → búsqueda por título
        │            (índices SQLite directos e inversos, puente AniDB, procedencia, overrides)
        ▼
Validación TMDB ──► existe, tipo, año, título, TVDB/IMDb coherentes
        │
        ▼
DeduplicationEngine ──► clave final ("tv"|"movie", tmdb_id)
        │
        ▼
MDBList ──► crear/buscar lista, leer elementos, diferencias, lotes, reintentos, reanudación
        │
        ▼
Reportes ──► consola, JSON, CSV, HTML (cada decisión con sus evidencias)
```

Estructura:

```
anime-catalog-generator/
├── src/anime_catalog/
│   ├── cli.py                 comandos Typer
│   ├── config.py              entorno + esquema YAML estricto (Pydantic)
│   ├── context.py             construcción de clientes
│   ├── http.py                reintentos, backoff exponencial, Retry-After, redacción de secretos
│   ├── models.py
│   ├── providers/             anilist.py · jikan.py · tmdb.py · tvdb.py
│   ├── mapping/               anibridge.py · kometa.py · fribb.py · anime_lists.py · index.py ·
│   │                          resolver.py · updater.py · titles.py · base.py
│   ├── catalog/               filters.py · canonical.py · relations.py · deduplication.py · pipeline.py
│   ├── integrations/          mdblist.py (cliente) · sync.py (diferencias y modos)
│   ├── storage/               database.py · cache.py · repository.py · overrides.py · state.py
│   ├── reporting/reports.py
│   ├── platform.py            detección de Termux/Android y `anime-catalog doctor`
│   └── web/                   interfaz gráfica: server.py (FastAPI) · services.py · jobs.py ·
│                              security.py · static/ (HTML + CSS + JS sin dependencias)
├── filters/                   perfiles YAML listos para usar
├── tests/                     pruebas offline (+ opcionales reales, de rendimiento y de instalación)
├── scripts/                   build_test_fixtures.py · benchmark_mapping.py
├── install-termux.sh          instalador para Termux
└── start-termux.sh            arranque de la interfaz en Termux
```

Los workflows están en `.github/workflows/anime-catalog-*.yml` en la raíz del repositorio (GitHub
solo los lee ahí).

## 2. Instalación

Requisitos: **Python 3.12 o superior** (Windows, Linux o macOS).

```bash
cd anime-catalog-generator
python -m venv .venv
# Linux/macOS:
source .venv/bin/activate
# Windows (PowerShell):
.venv\Scripts\Activate.ps1

pip install -e ".[dev]"      # instala el comando `anime-catalog`
cp .env.example .env          # y rellena tus claves
anime-catalog --help
```

Dependencias: `httpx`, `typer`, `pydantic`, `PyYAML`, `rich`, `fastapi` y `uvicorn` (sin extras
nativos: nada de `uvicorn[standard]`, `uvloop` ni `httptools`), y `pytest` para desarrollo. La
interfaz no necesita Node.js ni CDN: el frontend son tres archivos estáticos (HTML, CSS, JS).

En Android consulta la sección [Termux](#21-termux-android).

## 3. API key de MDBList

1. Inicia sesión en <https://mdblist.com>.
2. Ve a **Preferences → API Access** y genera la clave.
3. Ponla en `.env` como `MDBLIST_API_KEY=...` (o como secret de GitHub).

Sin clave puedes usar todo en modo simulación (`--dry-run`). La API tiene cuota diaria según tu plan
(1.000 solicitudes/día en el gratuito) y, por ventana de 5 minutos, 1.000 lecturas y 300 escrituras;
el cliente respeta `Retry-After` y agrupa los elementos en lotes de 100 por solicitud.

## 4. Configurar TMDB

Muy recomendable: sin TMDB los IDs no se validan (como mucho quedan en `high_confidence`) y no hay
fallbacks por TVDB/IMDb ni por título.

1. Crea una cuenta en <https://www.themoviedb.org> → **Settings → API**.
2. Copia la **API Key (v3)** en `TMDB_API_KEY` o el **API Read Access Token (v4)** en
   `TMDB_READ_ACCESS_TOKEN` (también se acepta `TMDB_API_READ_TOKEN`).

TVDB (`TVDB_API_KEY`) es opcional y no es necesaria: los TVDB IDs salen de los mappings y se
convierten con `GET /3/find/{id}?external_source=tvdb_id` de TMDB.

## 5. Descargar los mappings

```bash
anime-catalog mappings update        # AniBridge + Kometa + Fribb (≈ 25 MB, unos segundos)
anime-catalog mappings status        # versión, filas indexadas, versión anterior, licencia
anime-catalog mappings update --source anime_lists   # respaldo opcional
```

La primera ejecución de `create`/`sync`/`mapping` descarga automáticamente lo que falte. Las
descargas son condicionales (ETag / Last-Modified): si no cambió nada, no se vuelve a bajar.

## 6. Comandos

| Comando | Para qué |
| --- | --- |
| `anime-catalog create …` | Crea/actualiza una lista (modo `append` por defecto) |
| `anime-catalog sync …` | Igual que `create` pero en modo `sync` |
| `anime-catalog sync-all --dir filters` | Ejecuta todos los perfiles habilitados (GitHub Actions) |
| `anime-catalog mapping --anilist-id 21` | Explica cómo se resuelve un anime |
| `anime-catalog mappings update/status/rollback` | Datasets de mappings |
| `anime-catalog review` | Mappings dudosos; `review set/remove/export/import/list-overrides` |
| `anime-catalog validate filters/*.yaml` | Valida perfiles |
| `anime-catalog runs` | Historial de ejecuciones |
| `anime-catalog state export/import` | Estado persistente (para Actions) |
| `anime-catalog ui` | Interfaz gráfica local en http://127.0.0.1:8765 |
| `anime-catalog doctor` | Diagnóstico: dependencias, SQLite, permisos, plataforma |

Las escrituras en MDBList solo ocurren con **`--apply`** (o `mdblist.dry_run: false` en el YAML).
Por defecto se simula (`DEFAULT_DRY_RUN=true`).

Ejemplos:

```bash
# Década de 2010
anime-catalog create --from 2010 --to 2019 --first-only --name "Anime 2010s" --apply

# 2020-2026
anime-catalog create --from 2020 --to 2026 --first-only --name "Anime 2020s" --apply

# Mejores animes
anime-catalog create --from 2000 --to 2026 --min-score 85 --first-only --name "Top Anime" --apply

# Estudio (búsqueda dinámica en AniList, sin lista cerrada de estudios)
anime-catalog create --studio MAPPA --format TV --first-only --name "MAPPA Anime" --apply

# Tags (relevancia del tag ≥ 60 %, distinta de la puntuación)
anime-catalog create --tag Isekai --min-tag-rank 60 --min-score 70 --name "Isekai Anime" --apply

# Películas (TMDB Movie IDs)
anime-catalog create --from 1990 --to 2026 --format MOVIE --name "Anime Movies" --apply

# Temporada concreta
anime-catalog create --year 2025 --season SPRING --name "Spring Anime 2025" --apply

# Desde YAML (los parámetros de la línea de comandos sobrescriben el YAML)
anime-catalog create --config filters/anime-2020s.yaml --apply
anime-catalog create --config filters/anime-2020s.yaml --dry-run

# Mapping de un anime
anime-catalog mapping --anilist-id 21
```

Salida real de `anime-catalog mapping --anilist-id 21` (sin TMDB key, 2026-10-14):

```
Anime encontrado       ONE PIECE (TV, 1999-10-20) [anilist:21]
Serie canónica         ONE PIECE (TV, 1999-10-20) [anilist:21]
TMDB                   tv:37854
TVDB ID                81797
IMDb ID                tt0388629
AniDB                  69
Fuente del mapping     anibridge
Estado                 high_confidence
Confianza              0.96
Evidencias             elegido tv:37854 por anibridge (directo: anilist:21 -> tmdb_show:37854:s1)
                       fribb coincide (misma procedencia: no cuenta como confirmación independiente)
Datasets               anibridge=3.0.3@2026-10-14T06:58:24Z, kometa=…, fribb=…
```

Resumen de una ejecución real (`create --config filters/anime-2020s.yaml --dry-run`, 2026-10-14):

```
Animes encontrados:                    387
Animes filtrados:                      159
Temporadas agrupadas:                   67
Series/obras canónicas:                159
Mapping anibridge:                     157
Sin mapping:                             1
Pendientes de revisión:                  1
Títulos válidos:                       157
```

Códigos de salida: `0` correcto, `1` error, `2` configuración inválida, `3` sincronización
interrumpida (cuota, red…).

## 7. Filtros YAML

Esquema estricto: un campo desconocido o una combinación incompatible produce un error claro.
Todos los campos son opcionales salvo `catalog.name`.

```yaml
catalog:
  name: "Anime 2020-2026"
  description: "Series de anime estrenadas entre 2020 y 2026"
  enabled: true                       # sync-all lo ejecuta

source:
  primary: anilist                    # anilist | myanimelist | hybrid
  enrich_mal_scores: false            # hybrid: puntuación MAL vía Jikan

filters:
  # --- temporales (se aplican según temporal_mode) ---
  start_year: 2020                    # año final inclusivo
  end_year: 2026
  years: []                           # años sueltos
  decades: []                         # 1990 o "1990s"
  year_ranges: []                     # ["1990-1999", "2020-2026"]  (unión)
  exclude_years: []
  date_from: null                     # 2020-01-01
  date_to: null                       # 2026-12-31
  partial_dates: strict               # strict | overlap   (fechas incompletas, p. ej. solo "2020")
  unknown_dates: exclude              # exclude | include
  include_future: false               # estrenos futuros / NOT_YET_RELEASED
  seasons: []                         # WINTER SPRING SUMMER FALL
  temporal_mode: original_release_year   # | any_season_release_year | entry_release_year
  metadata_scope: canonical           # canonical | any_member | entry (solo con entry_release_year)

  # --- metadatos ---
  formats: [TV]                       # por defecto [TV, MOVIE]
  score:
    provider: anilist                 # anilist (0-100) | myanimelist (0-10)
    field: averageScore               # averageScore | meanScore | score (MAL)
    min: 75
    max: 100
    normalize: false                  # true: min/max en 0-100 también para MAL
    min_votes: null                   # solo MAL (scored_by)
    missing: exclude                  # sin puntuación: exclude | include
  genres:   {include: [], exclude: [], mode: OR}
  tags:     {include: [], exclude: [], min_rank: 0, exclude_min_rank: 0, mode: OR,
             categories_include: [], categories_exclude: [], include_spoilers: true}
  studios:  {include: [], exclude: [], mode: OR, main_only: false, animation_studios_only: false}
  status:   {include: [], exclude: []}   # FINISHED RELEASING NOT_YET_RELEASED CANCELLED HIATUS
  country:  {include: [JP], exclude: []}
  source:   {include: [], exclude: []}   # MANGA LIGHT_NOVEL ORIGINAL …
  popularity: {min: null, max: null}
  favourites: {min: null, max: null}
  episodes:   {min: null, max: null}
  duration:   {min: null, max: null}     # minutos por episodio
  finished_only: false
  airing_only: false
  upcoming_only: false
  include_adult: false
  exclude_sequels: false
  exclude_spinoffs: false
  exclude_side_stories: false
  exclude_compilations: false
  exclude_remakes: false
  exclude_specials: false
  sort: start_date                    # start_date | score | popularity | favourites | title
  order: asc
  limit: null

  # --- expresión booleana opcional (se combina con AND con lo anterior) ---
  expression:
    and:
      - not: {genres: {include: [Horror]}}
      - or:
          - genres: {include: [Fantasy]}
          - tags: {include: [Magic], min_rank: 50}

canonical:
  enabled: true
  first_only: true
  collapse_seasons: true
  preserve_remakes: true
  preserve_spinoffs: true
  preserve_independent_movies: true
  merge_unmapped_sequels: true        # continuación nueva sin mapping ⇒ se agrega a su serie
  complete_shows_from_mappings: true  # índice inverso TMDB→AniList para encontrar la temporada 1

mapping:
  primary: anibridge
  fallbacks: [kometa, fribb, anime_lists, tmdb]
  verify_tmdb: true
  allow_title_search: true
  minimum_confidence: 0.90
  ambiguous_policy: review
  movie_allow_show_mapping: false

duplicates: {enabled: true, dedupe_by_tmdb_id: true, dedupe_by_canonical_anime: true}

mdblist:
  mode: append                        # create | append | sync | replace
  create_if_missing: true
  reuse_existing: true                # en modo create
  list_id: null                       # fija la lista por ID (evita ambigüedad por nombre)
  private: false
  dry_run: true
  batch_size: 100
  allow_removals: false               # sync: quitar lo gestionado que ya no cumple

reports: {json: true, csv: true, html: true, directory: null}
```

Notas:

- **Puntuaciones**: AniList usa 0-100 y MAL 0-10; nunca se mezclan. `--min-score 75` equivale a
  `score: {provider: anilist, field: averageScore, min: 75}`. Con `provider: myanimelist` y fuente
  AniList hay que activar `enrich_mal_scores` (o usar `hybrid`).
- **Tags**: `min_rank` es la relevancia del tag en AniList (porcentaje), no la nota del anime.
- **Estudios**: se comparan por nombre con los que devuelve AniList (sin lista cerrada). Si solo se
  filtra por estudio y sin fechas, se recorren directamente las obras del estudio en AniList.
- **Filtrado en servidor**: solo se envían a AniList los argumentos que no pueden eliminar
  resultados válidos (por ejemplo `genre_in`/`tag_in` de AniList exigen todos los valores, así que
  solo se usan en modo AND). Todo lo demás se filtra localmente.
- Combinaciones rechazadas (ejemplos): `start_year > end_year`, `finished_only` + `airing_only`,
  `metadata_scope: entry` sin `entry_release_year`, puntuación MAL fuera de 0-10, puntuación MAL con
  fuente AniList sin `enrich_mal_scores`, `temporal_mode` que exige agrupación con
  `canonical.enabled: false`.

Perfiles incluidos en `filters/`: `anime-2020s.yaml`, `anime-2010s.yaml`, `anime-movies.yaml`,
`anime-mappa.yaml`, `anime-isekai.yaml`.

## 8. Cómo funcionan las temporadas

AniList y MAL publican cada temporada/parte como una entrada distinta; TMDB suele tener una sola
serie con varias temporadas. Por eso:

- Todas las entradas que pertenecen al **mismo programa de TMDB** forman un grupo.
- El grupo se representa por su **entrada original** (la primera emisión).
- A MDBList solo se envía el **TMDB TV ID de la serie** (el número de temporada del descriptor
  `tmdb_show:X:sN` se usa para interpretar, nunca se envía).

Los tres modos temporales:

| Modo | Qué se compara con el intervalo | Ejemplo 2020-2026 con puntuación ≥ 83 (datos reales de las pruebas) |
| --- | --- | --- |
| `original_release_year` (defecto) | estreno de la serie original | Solo **Jujutsu Kaisen** (2020). AoT (2013) y Demon Slayer (2019) no entran aunque tengan temporadas en 2020+ |
| `any_season_release_year` | cualquier temporada de emisión del grupo | JJK + **Attack on Titan** (Final Season 2020; la serie original tiene 85) |
| `entry_release_year` | cada entrada por separado (y sus metadatos) | JJK + AoT + **Demon Slayer** (su temporada Yuukaku-hen de 2021 tiene 86 aunque la original tiene 82) |

`metadata_scope` decide dónde se evalúan puntuación, géneros, tags, estudios, etc.:
`canonical` (la serie original; por defecto), `any_member` (basta con que una temporada cumpla) o
`entry` (la propia entrada, en `entry_release_year`). Las temporadas pueden tener notas, tags o
estudios distintos (p. ej. AoT Final Season es de MAPPA y la original de Wit Studio).

## 9. Cómo se detecta el anime original

`CanonicalAnimeResolver` (`catalog/canonical.py`):

1. Parte de las entradas encontradas.
2. Recorre las relaciones **PREQUEL** hacia atrás y descarga (por lotes de 50) las temporadas
   anteriores; no descarga las que los mappings ya sitúan en otra serie de TMDB.
3. Usa el **índice inverso** de mappings (`tmdb_show:X:s1 → anilist:…`) para encontrar la
   temporada 1 aunque la cadena de relaciones esté rota.
4. Une dos entradas relacionadas (PREQUEL/SEQUEL) **solo si apuntan a la misma serie** de TMDB
   (o de TVDB si no hay TMDB). Una relación no basta por sí sola: *Naruto* y *Naruto Shippuden*
   tienen series TMDB distintas y quedan separadas.
5. Une grupos que apuntan al mismo TMDB TV ID.
6. Elige como original la entrada de emisión (TV/ONA/TV_SHORT) con el estreno más temprano. Ojo: en
   AniList la OVA *Kuinaki Sentaku* figura como PREQUEL de AoT aunque se estrenó después; por eso
   se decide por fecha y formato, no por la dirección de la relación.

Nunca agrupa por nombre ni por franquicia. Se conservan como obras independientes los
**spin-offs** (*Shingeki! Kyojin Chuugakkou*), **remakes** (*Hunter x Hunter* 1999 y 2011,
*THE ONE PIECE*), **películas** (*Mugen Train*) y precuelas autónomas sin mapping (*MONSTERS*,
ONA de 2024 relacionada con One Piece). Una temporada nueva aún sin mapping se agrega a su serie
solo si es una **continuación** (secuela posterior en formato de emisión) y nunca puede unir dos
series distintas.

Comprobado con datos reales (pruebas y ejecución en vivo): las 7 entradas de *Attack on Titan* →
`anilist:16498` (2013, TMDB 1429); *JJK* → 2020 (TMDB 95479); las 5 de *Demon Slayer* → 2019 (TMDB
85937); *One Piece* → 1999 (TMDB 37854).

## 10. Cómo se convierten los IDs

`MappingResolver` (`mapping/resolver.py`):

1. **Índices locales SQLite** (tabla `mapping_index`) por origen y por destino, construidos al
   descargar los datasets: `anilist`, `mal`, `anidb`, `tmdb_show`, `tmdb_movie`, `tvdb_show`, `imdb`.
   Nunca se recorre un JSON completo por consulta.
2. **Orden de fuentes**: AniBridge → Kometa → Fribb → Anime-Lists. Dentro de cada fuente se usa el
   mejor nivel disponible: **directo** (`anilist:X → tmdb…`) > **inverso** (`tmdb… → anilist:X`,
   porque AniBridge es direccional) > **puente AniDB** (`anilist → anidb → tmdb`).
3. **Tipo**: una película (`MOVIE`) busca `tmdb_movie`; si los mappings solo la ubican como
   especial de una serie, queda **pendiente de revisión** (no se convierte en serie).
4. **Discrepancias**: se comparan dentro del mismo tipo. En los datos reales, de 6.159 entradas con
   serie en AniBridge y Fribb solo 14 discrepan (y 7 de 1.297 películas); esas quedan como
   `conflict` salvo que la validación en TMDB deshaga el empate. Que Fribb ponga una obra como
   especial `s0` de otra serie mientras AniBridge le da serie propia se trata como diferencia de
   representación, no como conflicto.
5. **Procedencia**: Kometa y Fribb derivan de Anime-Lists y manami, que AniBridge ya incorpora; su
   coincidencia suma poco (+0,01) y se marca como «misma procedencia».
6. **Fallbacks**: TVDB/IMDb → `TMDB /find` (si hay varios candidatos: conflicto) y, solo sin
   mappings fiables, búsqueda por título (romaji, inglés, nativo + año + formato) con puntuación;
   nunca se toma el primer resultado y una búsqueda ambigua queda en revisión.
7. **Validación TMDB** (`/3/tv/{id}` o `/3/movie/{id}` con `external_ids` y títulos alternativos):
   existencia, año (±1), título, TVDB/IMDb coherentes, animación/idioma.
8. **Estados**: `confirmed` (≥ 0,97 y validado), `high_confidence` (≥ `minimum_confidence`),
   `needs_review`, `conflict`, `unmapped`, `excluded` (override). Solo los dos primeros se añaden.

Cada título guarda fuente, confianza, evidencias, conflictos, validación y versión de los datasets.

## 11. Crear listas

- Se buscan las listas del usuario (`GET /lists/user`) por nombre exacto.
- Si no existe y `create_if_missing` (o modo `create`), se crea con `POST /lists/user/add`.
- Si hay **varias listas con el mismo nombre**, se detiene y pide `mdblist.list_id`/`--list-id`.
- En modo `create` con lista existente: error, salvo `reuse_existing: true` (por defecto).
- En `--dry-run` no se crea nada; el reporte dice «se creará».

## 12. Sincronizar

Antes de escribir siempre se leen los elementos actuales de la lista y se calcula la diferencia:

| Modo | Añade | Elimina |
| --- | --- | --- |
| `create` / `append` (defecto) | lo que falta | **nunca** |
| `sync` | lo que falta | solo con `allow_removals: true` y solo lo que **esta aplicación** añadió antes (tabla `managed_items`); lo añadido a mano se respeta |
| `replace` | lo que falta | todo lo que sobra; exige `--confirm-replace` tras ver la vista previa |

- Lotes configurables (`batch_size`, 100 por defecto), separados en series y películas.
- Reintentos con backoff exponencial y `Retry-After`; la cuota diaria agotada **no** se reintenta.
- Cada elemento se registra en `sync_items` (pendiente/hecho/no encontrado).
- **Reanudación sin duplicados**: si una ejecución se interrumpe, la siguiente vuelve a leer la lista
  y solo envía lo que falta.
- Si MDBList no encuentra un TMDB ID (`not_found`), se relee la lista para saber cuál fue y se
  reporta.

## 13. GitHub Actions

Workflows en la raíz del repositorio:

- **`anime-catalog-test.yml`**: pruebas en Ubuntu y Windows con Python 3.12 y 3.13.
- **`anime-catalog-update-mappings.yml`**: diario; descarga datasets nuevos (ETag), valida, indexa.
- **`anime-catalog-sync.yml`**: semanal (lunes) para todos los perfiles con `catalog.enabled: true`,
  y manual con `workflow_dispatch`: perfil (`anime-2020s`, … o `all`), modo (`config`, `append`,
  `sync`) y `dry_run`.

Configuración:

1. **Settings → Secrets and variables → Actions → New repository secret**:
   `MDBLIST_API_KEY` y `TMDB_API_KEY` (o `TMDB_READ_ACCESS_TOKEN`); opcional `TVDB_API_KEY`.
2. **Actions → Anime Catalog · sincronizar catálogos → Run workflow** (empieza con `dry_run` activado).

Seguridad y estado:

- Las claves solo se leen de Secrets; los logs ocultan `apikey=…` y los valores de los secretos
  (además, GitHub los enmascara).
- Un único grupo de concurrencia (`anime-catalog-mdblist`) impide dos ejecuciones simultáneas.
- Estado persistente: `anime-catalog state export` → rama **`anime-catalog-state`** (`state.json`):
  elementos gestionados por lista, overrides, cola de revisión e historial. Los datasets y la caché
  de metadatos se guardan con `actions/cache` (se pueden reconstruir si se pierden).
- Los reportes se publican como *artifact* de cada ejecución.

## 14. Revisar mappings incorrectos

```bash
anime-catalog review                       # pendientes (needs_review / conflict / unmapped)
anime-catalog review --status conflict
anime-catalog review set anilist:12345 --tmdb-tv 54321 --note "temporada propia en TMDB"
anime-catalog review set anilist:999 --tmdb-movie 129
anime-catalog review set anilist:888 --exclude --note "recopilatorio"
anime-catalog review set anilist:777 --canonical anilist:21   # pertenece a la serie de One Piece
anime-catalog review remove anilist:12345
anime-catalog review list-overrides
```

Los overrides se guardan en la tabla `overrides` **y** en `overrides.yaml` (versionable en Git; se
importa automáticamente al arrancar). Nunca se tocan al actualizar o revertir datasets. Ver
`overrides.yaml.example`.

## 15. Actualizar datasets

```bash
anime-catalog mappings update                 # comprueba versiones (ETag/Last-Modified)
anime-catalog mappings update --force
anime-catalog mappings rollback --source anibridge
```

Proceso: descarga condicional → comprobación de tamaño → validación del esquema (AniBridge debe
ser `schema_version 3.x`; si llega un 4.x se rechaza) → número mínimo de filas → copia del dataset
anterior a `*.prev` → reconstrucción del índice en una transacción. Si algo falla, se conserva la
versión anterior intacta. Cada ejecución registra la versión de los datasets usada.

## 16. Solución de problemas

| Síntoma | Causa / solución |
| --- | --- |
| `Falta MDBLIST_API_KEY` | Define la variable o usa `--dry-run` |
| `autenticación rechazada (HTTP 401)` | Clave de MDBList o TMDB incorrecta |
| `límite diario de la API de MDBList agotado` | Espera al reinicio (00:00 UTC); la próxima ejecución reanuda sin duplicar |
| `Hay N listas llamadas …` | Indica `mdblist.list_id` o `--list-id` |
| `La lista … ya existe` en modo create | Usa `--mode append` o `reuse_existing: true` |
| Muchos `unmapped` en películas recientes u obscuras | Ningún dataset las cubre todavía; con TMDB key se intenta la búsqueda por título. Revísalas con `anime-catalog review` |
| `needs_review` con «confianza 0.88 < mínimo 0.90» | Solo un respaldo (p. ej. Fribb) tenía el mapping; confírmalo con `review set` o baja `minimum_confidence` |
| AniList lento | AniList limita a 90 solicitudes/min (30/min en modo degradado); el cliente se adapta a `X-RateLimit-*`. Las particiones ya consultadas se reutilizan desde la caché |
| `la fuente anime_lists no está descargada` | Informativo: es un respaldo opcional (`mappings update --source anime_lists`) |
| Ver detalles | `-v/--verbose` y los reportes en `reports/<catálogo>/<ejecución>/` |

## 17. Limitaciones

- **AniList** no devuelve más de 5.000 resultados por consulta y su `pageInfo.total` es ficticio
  (5000) mientras haya más páginas; el cliente divide por años y, si una partición llega al tope,
  la subdivide. Las entradas **sin fecha de inicio** no aparecen en consultas por fecha (solo en
  consultas sin rango, como las de estudio).
- **Jikan/MyAnimeList**: implementado según la documentación de Jikan v4, pero **no se pudo probar
  contra la API real** desde el entorno de desarrollo (conexiones cortadas). La normalización está
  cubierta por pruebas con respuestas de ejemplo. El listado de Jikan no trae relaciones: en modo
  `myanimelist` se pide la ficha completa (`/anime/{id}/full`) de las precuelas, a ~1 solicitud/s.
- **MDBList**: endpoints y formatos verificados contra la especificación OpenAPI oficial
  (`/schema/`, 2026-10-14) y el cliente de Kometa, y probados contra un servidor simulado. **No se
  ha escrito en una cuenta real** (no había clave disponible). La respuesta de altas solo trae
  recuentos (`added/existing/not_found`), por eso se relee la lista cuando hay `not_found`.
- **TMDB**: endpoints oficiales; sin clave disponible en el desarrollo, la validación y los fallbacks
  están probados con un TMDB simulado.
- Los mappings dependen de la calidad de los datasets; las entradas muy recientes u obscuras pueden
  quedar `unmapped` hasta que AniBridge/Fribb las incorporen.
- `exclude_compilations` detecta recopilatorios por la relación `SUMMARY`/`COMPILATION` de AniList,
  que no siempre está informada.
- AniList define WINTER como diciembre-febrero; si una entrada no trae temporada, se deriva del mes
  con esa misma convención.

## 18. Investigación de fuentes (fase 1)

Revisado el 2026-10-14 (clonado y descarga de los artefactos reales):

| Fuente | Último commit / release | Archivo usado | Hallazgos de esquema |
| --- | --- | --- | --- |
| anibridge/anibridge-mappings | commit 2026-10-04; release `v3` regenerado a diario (`generated_on 2026-10-14T06:58:24Z`) | `mappings.json` (14,7 MB) | `provider:id[:scope]`; mappings **direccionales**; `tmdb_show`/`tvdb_show` con `sN`, `anidb` con `R/S/O/C/T/P`; también `tvdb_movie` e `imdb_movie`; rangos de episodios con `|ratio`; 77.722 descriptores de origen |
| Kometa-Team/Anime-IDs | 2026-10-14 (diario) | `anime_ids.json` | Clave AniDB; `tvdb_season` puede ser `-1` (absoluta) o `0`; `mal_id`/`imdb_id` pueden ser cadenas con comas; **hoy no incluye `tmdb_movie_id`/`tmdb_show_id`** aunque el README los documente (el parser los admite si vuelven) |
| Fribb/anime-lists | 2026-10-13 (diario) | `anime-list-full.json` | `themoviedb_id.tv` entero, `themoviedb_id.movie` **lista**; `season.tmdb/tvdb`, `episode_offset`; sin licencia |
| Anime-Lists/anime-lists | activo | `anime-list-master.xml` | `tmdbtv`, `tmdbseason` (`a` = absoluta), `tmdbid` (películas), `tvdbid` puede ser `movie`/`OVA`/`unknown`; redundante con AniBridge/Fribb ⇒ opcional |
| Kometa-Team/Kometa | release 2.5.3 (2026-10-12) | `modules/mdblist.py` | `sync_list()` en modo sync **borra todo lo existente y vuelve a añadir**: no se copia ese comportamiento |
| manami / AnimeAggregations / shinkro | — | no se descargan | ya integrados en AniBridge (y parcialmente en Kometa/Fribb) ⇒ solo se registran como procedencia |

APIs: AniList respondió en vivo con `X-RateLimit-Limit: 30` (modo degradado) y `total: 5000`
ficticio; `genre_in` y `tag_in` exigen todos los valores (comprobado). MDBList publica su OpenAPI
en `https://api.mdblist.com/schema/` (paginación por `cursor`, `Retry-After`, límites por ventana de
5 minutos). TMDB respondió `401` sin clave (endpoint vigente). Jikan no fue accesible desde el
entorno.

## 19. Estado de verificación

**Probado en este entorno (Linux x86_64, Python 3.13)**

- `pytest`: **166 pruebas** (las 125 originales se conservan). Por defecto se ejecutan 162 y pasan
  todas; 4 son opcionales: la instalación completa simulada y el benchmark con datasets reales se
  ejecutaron y pasaron; la prueba en vivo de AniList/AniBridge pasó; la de MDBList en vivo se
  omitió por no haber clave.
  - Motor: canónica con datos reales (One Piece, AoT, JJK, Demon Slayer, HxH), mappings directos,
    MAL, vía AniDB, vía TVDB→TMDB, inversos, ausentes, ambiguos, conflictos; filtros; MDBList
    (crear, existente, duplicados, append, sync, replace, dry-run, 401, 429, cuota diaria,
    respuesta parcial, interrupción y reanudación); datasets (ETag, esquema, truncado, rollback).
  - Interfaz/API (`test_web.py`): página y estáticos sin recursos externos, CSP, Host, Origin,
    CSRF, acceso remoto con token, claves nunca devueltas y `.env` con permisos 600, validación y
    expresión AND/OR/NOT, perfiles, trabajo con progreso por SSE (sin porcentaje inventado),
    resultados paginados, confirmación obligatoria para escribir, sincronización visual sin
    duplicados, elementos no agregados, historial, cancelación (API, gestor y entre lotes de
    MDBList) con reanudación, bloqueo por lista, recuperación tras reinicio, explorador por
    nombre/AniList/MAL/AniDB/TMDB/TVDB/IMDb, detalle con serie canónica y correcciones.
  - Rendimiento (`test_performance.py`) y Termux (`test_termux.py`), ver secciones 21 y 22.
- En vivo (solo lectura): AniList, descarga e indexado de AniBridge/Kometa/Fribb; catálogos
  2020-2026, películas, MAPPA y primavera 2025 por CLI y por la interfaz.
- Interfaz en Chromium (Playwright) a 393×851 (móvil) y 1366×900 (escritorio), claro y oscuro: flujo
  completo inicio → crear → simular (AniList real) → progreso → resultados → explorador → detalle,
  **0 errores de consola**; flujo de escritura contra un MDBList **simulado**: crear lista con
  confirmación, agregar animes a una lista existente, simular, confirmar (el botón queda
  deshabilitado hasta marcar la casilla) y sincronizar 1.159 títulos, ver contenido e historial.
- Instalador de Termux ejecutado de principio a fin en Linux con `pkg` simulado y `$PREFIX` falso
  (entorno virtual, instalación, comando, `.env` 600, `doctor` y prueba HTTP de la interfaz).

**Pendiente de verificar**

- **En un dispositivo Android real con Termux**: instalación de paquetes con `pkg`, compilación
  de `pydantic-core` si no hay paquete precompilado, `termux-wake-lock`, y memoria/CPU/batería
  reales (las cifras de la sección 22 son de un PC x86_64).
- Con tus credenciales: escritura real en MDBList (pruebas E–H), validación real en TMDB y
  GitHub Actions con Secrets.
- Jikan real (fuente `myanimelist`/`hybrid`): no fue accesible desde el entorno de desarrollo.

Pruebas opcionales:

```bash
ANIME_CATALOG_LIVE_TESTS=1 pytest -m live        # APIs reales, solo lectura
ANIME_CATALOG_SLOW=1 pytest tests/test_termux.py # instalación completa simulada
ANIME_CATALOG_BENCHMARK=1 pytest -m benchmark    # benchmark con datasets reales
```

## 20. Interfaz gráfica

```bash
anime-catalog ui                  # http://127.0.0.1:8765
anime-catalog ui --port 9000 --open
```

Aplicación web local, mobile-first (navegación inferior en el móvil, barra lateral en escritorio),
tema claro/oscuro automático o manual, en español. Está conectada al mismo motor que el CLI: no
hay una segunda lógica de filtros ni de mappings.

| Sección | Qué permite |
| --- | --- |
| **Inicio** | Catálogos, animes identificados, series y películas, mappings resueltos y pendientes, duplicados eliminados, última sincronización, estado de los datasets, últimas ejecuciones, trabajos en curso y acceso rápido a crear |
| **Crear** | Formulario completo: fuente (AniList, MyAnimeList, híbrido); años, décadas, años sueltos, fechas exactas y temporadas; agrupar temporadas (activado) con estreno original / cualquier temporada / entrada individual; Average/Mean Score y MAL con escala porcentual; géneros y tags con búsqueda, inclusión/exclusión (NOT) y AND/OR, relevancia del tag; estudios con búsqueda dinámica, principal o participante; formatos; popularidad, episodios, duración, estado, país, fuente de adaptación, adulto, secuelas, spin-offs, remakes…; expresión avanzada AND/OR/NOT en YAML; lista de destino y modo; guardar/cargar/importar/ver perfiles YAML. Botones **Simular** y **Sincronizar con MDBList** |
| **Trabajos** | Progreso en tiempo real por Server-Sent Events: fase, procesados, total (solo si se conoce), porcentaje (solo con total), velocidad, tiempo, errores, títulos pendientes y registro; cancelar; reintentar; resultados paginados con búsqueda (títulos, revisión, excluidos, duplicados); sincronizar desde una simulación |
| **Explorador** | Mapping Explorer por nombre, AniList, MAL, AniDB, TMDB, TVDB o IMDb: título, año, tipo, serie canónica y miembros, identificadores, fuente, confianza, validación, conflictos, candidatos por fuente; cola de revisión y correcciones manuales |
| **Listas** | Mis listas de MDBList, crear lista (con confirmación), ver contenido paginado (distingue lo añadido por la app de lo manual), agregar animes a una lista, historial con elementos no agregados |
| **Ajustes** | Claves de API (se guardan en el backend, nunca se muestran), actualizar datasets, tema, información del sistema |

Comportamiento:

- Toda escritura en MDBList exige **confirmación explícita** en un diálogo; el modo reemplazar
  exige una segunda confirmación con vista previa de las eliminaciones. Nunca hay borrados
  automáticos no autorizados (mismas reglas que el CLI).
- Los trabajos corren en hilos aparte: la interfaz sigue respondiendo mientras se procesa un
  catálogo. No se permiten dos sincronizaciones simultáneas sobre la misma lista (HTTP 409).
- Cancelar detiene el trabajo en un punto seguro (entre páginas, grupos o lotes), nunca a mitad de
  una escritura. Si el servidor se detiene, el trabajo queda «interrumpido» y se puede reintentar
  sin duplicados (cada ejecución recalcula las diferencias con la lista real).
- Las tablas están paginadas en el servidor (25 filas): el navegador nunca recibe miles de filas.
- El borrador del formulario se guarda en el navegador para no perderlo al recargar.

## 21. Termux (Android)

Requisitos: Termux actualizado (se recomienda la versión de F-Droid o GitHub), ≈300 MB libres para
la app y los datos, y ≈1,5 GB adicionales solo si hay que compilar `pydantic-core` con Rust. No
necesita root, Docker ni Node.js.

```bash
pkg install git
git clone https://github.com/eibyx/jkanimenuvio.git
cd jkanimenuvio/anime-catalog-generator
bash install-termux.sh          # o: bash install-termux.sh --dry-run para ver los pasos
bash start-termux.sh            # muestra http://127.0.0.1:8765 → ábrela en Chrome
```

Qué hace el instalador (`install-termux.sh`):

1. Detecta Termux (se niega a ejecutarse en otro sistema salvo `--force`).
2. Instala con `pkg`: `python clang make sqlite openssl libffi` y, si existen, `python-pip
   pkg-config libyaml binutils`.
3. Comprueba Python ≥ 3.12 y SQLite ≥ 3.24.
4. Crea un entorno virtual privado en `~/.anime-catalog/venv` (con `--system-site-packages`
   para reutilizar paquetes de Termux). No actualiza `pip` con `pip` (en Termux lo gestiona `pkg`).
5. **pydantic-core** (la única dependencia con código nativo, en Rust): los wheels `manylinux` de
   PyPI **no sirven** en Termux (usa bionic, no glibc). El instalador prueba primero
   `pkg install python-pydantic-core`; si no está disponible, instala `rust` y lo compila con
   `ANDROID_API_LEVEL=$(getprop ro.build.version.sdk)` (lo exige maturin) y `CARGO_BUILD_JOBS=2`
   para no agotar la memoria. La primera compilación puede tardar 10-30 minutos.
6. Instala la aplicación sin extras nativos (PyYAML usa `libyaml` si está; si no, su versión
   en Python puro).
7. Prepara `~/.anime-catalog` (datos, perfiles, reportes y `.env` con permisos 600) dentro del
   almacenamiento **privado** de Termux: no hace falta `termux-setup-storage` ni permisos de
   almacenamiento.
8. Crea el comando `anime-catalog` en `$PREFIX/bin` y verifica con `anime-catalog doctor` y una
   petición HTTP a la interfaz.

Todos los comandos del CLI siguen disponibles en Termux (`anime-catalog create …`, `mapping`,
`review`, etc.).

**Segundo plano en Android.** Android suspende o mata procesos en segundo plano para ahorrar
batería:

- `start-termux.sh` pide `termux-wake-lock` (la CPU no se duerme mientras corre) y lo libera al
  salir. Mantén la notificación de Termux activa.
- Desactiva la optimización de batería para Termux (Ajustes → Apps → Termux → Batería → Sin
  restricciones), sobre todo en Xiaomi/Huawei/Samsung.
- Android 12+ tiene el «phantom process killer», que limita los procesos hijos. La aplicación es un
  único proceso de Python con hilos, pero si el sistema la cierra, los trabajos aparecen como
  «interrumpidos» y se pueden reintentar sin duplicados.
- Si cambias de app durante mucho tiempo, Chrome puede descargar la pestaña: al volver se
  reconecta sola al progreso (SSE).

Consejos para el móvil: deja que los datasets se descarguen una vez (`anime-catalog mappings
update`, ≈25 MB); prefiere rangos de años concretos; un catálogo de 7 años tarda sobre todo por
el límite de AniList (30-90 peticiones/min), no por el mapping local.

## 22. Rendimiento medido

Mediciones reales con `scripts/benchmark_mapping.py` y los datasets publicados el 2026-10-14
(AniBridge 259.756 filas, Kometa 108.703, Fribb 165.297). **Máquina: contenedor Linux x86_64,
Python 3.13 — no es un móvil**; en Android cabe esperar tiempos varias veces mayores. Cada fase
se mide en un proceso aparte (memoria máxima = `ru_maxrss` del proceso).

| Medida | Antes de optimizar | Después |
| --- | --- | --- |
| Descarga inicial (3 datasets, 24 MB) | — | 1,2 s (0,86 + 0,26 + 0,10) |
| Indexación (validación + SQLite) | 3,89 s · **211 MB** | 2,87 s · **62 MB** |
| Consulta individual (One Piece, en frío) | 1,54 ms | 1,51 ms |
| Consulta individual media (200 al azar, sin caché) | 0,12 ms | 0,14 ms |
| Resolver 100 animes | 0,012 s · 46 MB | 0,010 s · 49 MB |
| Resolver 1.000 animes | 0,114 s · 54 MB | 0,106 s · 66 MB |
| Resolver 5.000 animes | 0,587 s · 91 MB | 0,534 s · 104 MB |
| 5.000 animes, misma ejecución (caché en memoria) | 0,003 s | 0,004 s |
| Arranque del CLI (`--help`) | — | 0,31 s |
| `/api/dashboard` · búsqueda por TMDB ID | ≈100 ms · ≈90 ms | **8,7 ms · 4,3 ms** |
| Servidor web en reposo tras varios trabajos | — | ≈111 MB RSS |

Qué se optimizó y qué se comprobó:

- **Indexación en streaming**: el JSON se recorre entrada a entrada (`raw_decode`) y se inserta
  por lotes en una sola transacción, en lugar de `json.load` + lista de filas. Es la mejora
  principal para Android (−70 % de memoria). Una versión nueva y válida reemplaza la anterior;
  si no es válida, la transacción se revierte.
- **No se reprocesa nada si no cambia**: descarga condicional por ETag/Last-Modified y
  comparación SHA-256; un dataset sin cambios no se vuelve a indexar (prueba: < 1 s).
- **Consultas por lotes**: `prefetch` carga con consultas `IN (...)` las filas de cientos de IDs;
  para 5.000 animes, menos de 120 consultas en lugar de varias por anime (prueba automática).
  Resultado honesto: en SQLite local cada consulta indexada ya cuesta microsegundos, así que el
  tiempo apenas cambia; el beneficio es menos consultas y memoria acotada (bloques de 500).
- **Caché persistente de resoluciones**: solo se usa **cuando hay TMDB**, porque ahí evita llamadas
  de red (prueba: la segunda ejecución hace 0 peticiones a TMDB). Sin TMDB, recalcular desde el
  índice (~0,1 ms) es más barato que leer la caché, y se midió que activarla empeoraba el tiempo.
- **TMDB concurrente y controlado**: prefetch con 4 hilos, intervalo mínimo compartido y caché
  (prueba con 50 ms de latencia simulada: más de 1,6× más rápido que en serie).
- **Conexiones y TLS reutilizados**: un único contexto SSL por proceso; antes cada cliente HTTP
  recargaba el almacén de certificados (≈15 ms, ×2), y eso era casi todo el tiempo de la API.
- SQLite: WAL, caché de páginas de 8 MB, temporales en memoria. Se probó `mmap` y se descartó
  (inflaba la memoria residente, lo que perjudica en Android).
- Clases con `__slots__` y candidatos sin Pydantic (decenas de miles por catálogo).

Reproducir: `python scripts/benchmark_mapping.py --work /tmp/bench --download --json bench.json`.

## 23. Seguridad de la interfaz

- Escucha solo en **127.0.0.1** por defecto. `--host` distinto exige `--allow-remote` **y** un token
  (`ANIME_CATALOG_UI_TOKEN`) que se pide en todas las rutas (cabecera `Authorization: Bearer`, o
  `?token=` la primera vez, que deja una cookie `HttpOnly; SameSite=Strict`).
- Solo se aceptan cabeceras `Host` de loopback (protección frente a DNS rebinding) y, si llega
  `Origin`, debe ser la del propio servidor.
- Toda operación de escritura exige un token **anti-CSRF** aleatorio por arranque, incrustado en la
  página: otra web abierta en el móvil no puede leerlo ni forjar peticiones.
- CSP estricta sin recursos externos (`default-src 'self'`), sin iframes (`frame-ancestors
  'none'`), `nosniff`, `no-referrer`.
- Las claves de MDBList/TMDB **nunca** se envían al navegador: la API solo indica si están
  configuradas. Desde Ajustes se guardan en `~/.anime-catalog/.env` con permisos `600`, dentro del
  almacenamiento privado de Termux (otras apps no pueden leerlo sin root). Los registros ocultan
  `apikey=…` y los valores de las claves.

## Licencia

MIT (ver `LICENSE`). Atribuciones de datasets y código de referencia en `NOTICE.md`.
