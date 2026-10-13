# Historial de versiones

## Sin publicar

### Corregido
- **Títulos escritos de forma distinta en cada base de datos** (por ejemplo, `kitsu:49883:1`,
  *Aoashi 2nd Season*, que JKAnime publica como *Ao Ashi Season 2*):
  - Las peticiones `kitsu:`, `mal:` y `anilist:` reúnen también los títulos de la **misma entrada**
    en AniList y ani.zip. Se enlazan mediante los *mappings* de Kitsu y las bases de relaciones,
    y solo si coinciden el formato y el año.
  - JKAnime se busca también por el **título base** sin marcador de temporada (`ao ashi`).
  - Los títulos que solo difieren en los espacios (`Aoashi` / `Ao Ashi`) se consideran iguales.
  - La temporada y el año se siguen verificando: nunca se sirve la temporada 1 cuando se pide la 2.
- Registros más claros: se indica qué se buscó en JKAnime y cuántos resultados hubo, y los fallos
  de servidores tras identificar el episodio (por ejemplo, HTTP 404 de Streamtape o del
  reproductor de JKAnime: vídeo eliminado) se distinguen de un fallo de identificación.

## 🎌 JKAnimeNuvio v0.2.0 — Primera versión estable

Primera versión estable de **JKAnimeNuvio**, un addon **solo de streams** que ofrece enlaces de
**JKAnime** en Nuvio y en clientes compatibles con el protocolo de addons de Stremio.

> [!IMPORTANT]
> **JKAnimeNuvio es self-hosted.** No existe un servidor público oficial: cada persona ejecuta su
> propia instancia en Android (Termux) o en su computadora (Node.js).
> 📖 Instalación paso a paso: [README](https://github.com/Eibyx/JkAnimeNuvio#readme).

### ✨ Características principales

- 📺 **Addon exclusivamente de streams**: el manifiesto publica solo `stream` (`catalogs: []`),
  sin catálogos ni fichas propias.
- 🎌 **Integración con JKAnime** como única fuente de vídeo (subtitulado y, cuando existe, latino).
- 🔍 **Identificación** mediante IMDb, TMDB, TVDB, AniList, MAL y Kitsu, con Cinemeta como fuente
  opcional.
- 🌸 **Correspondencia inteligente de títulos**: japoneses, ingleses y alternativos. Los
  identificadores solo se relacionan entre sí cuando una segunda fuente lo confirma.
- 📚 **Temporadas y episodios**: numeración automática, de Cinemeta, de TMDB, de TVDB (con sus
  órdenes), absoluta o por temporadas independientes, seleccionable desde la URL del manifiesto.
- ▶️ **Extracción de enlaces MP4 y HLS** directos, con las cabeceras HTTP que necesita cada
  servidor.
- 📱 **Compatible con Nuvio** e **instalable mediante Termux o Node.js** (Windows, Linux y macOS).
- 🔑 **Configuración de API mediante `.env`**: TMDB (token o clave v3) y TVDB (clave y PIN
  opcional). Todas las credenciales son opcionales.
- ⚡ **Caché y manejo de errores**: consultas en paralelo, tiempos límite por fuente y fallos
  aislados. Si hay ambigüedad, el addon prefiere no devolver nada antes que un episodio equivocado.
- 🔒 **Seguridad**: las credenciales se ocultan en errores y registros, y se rechazan los
  destinos de red internos.

### ✅ Compatibilidad verificada por el desarrollador

Probado satisfactoriamente por el desarrollador en **Android (Termux) con Nuvio**:

- **Black Clover** (`tt7441658`) en Nuvio, incluida la temporada de 2026.
- **Gensou Suikoden** (`tt42938834`) en Nuvio, identificado mediante IMDb (y también como
  `anilist:187316`).
- Extracción de **enlaces reales** MP4 y HLS de varios servidores de JKAnime.
- **Reproducción** de los vídeos desde Android.
- Identificación con **credenciales reales** de TMDB y AniList.

Estas comprobaciones no garantizan que todos los animes ni todos los servidores de vídeo funcionen:
JKAnime y sus servidores cambian con frecuencia.

### 🧪 Pruebas

| Tipo | Resultado |
|---|---|
| Pruebas automatizadas (`npm test`, sin conexión) | **76/76** en Node.js 20 y 22 |
| GitHub Actions (CI) | ✅ `test (20)` y `test (22)` en verde |
| `npm audit` | 0 vulnerabilidades conocidas |
| Validación del manifiesto (`stremio-addon-linter`) | 0 errores, 0 advertencias |
| Reproducción real en Android + Nuvio | ✅ Comprobada por el desarrollador (ver arriba) |

Las pruebas automatizadas usan respuestas simuladas: copias reales de Cinemeta, AniList, yuna y
ani.zip, y datos sintéticos para TMDB, TVDB y las páginas de JKAnime. Las comprobaciones de
reproducción son manuales y reales.

### ⚠️ Limitaciones conocidas

- **Filemoon**: su extractor puede fallar ocasionalmente cuando el servicio cambia su reproductor.
  Los demás servidores siguen apareciendo.
- **HTTP 419** en algunas consultas internas de episodios de JKAnime. Solo afecta al recuento de
  episodios; no impide encontrar el episodio.
- **Cloudflare** puede bloquear JKAnime desde VPN, proxies o servidores en la nube. Úsalo desde tu
  conexión doméstica o móvil.
- **Enlaces temporales**: los enlaces de vídeo caducan. Vuelve a abrir el episodio o reinicia el
  addon.
- **Servicios externos**: algunos animes recientes solo se identifican con credenciales de TMDB o
  TVDB, y dependen de que esos servicios respondan.
- **Numeración de temporadas**: Cinemeta, TMDB y TVDB numeran distinto (por ejemplo, Black
  Clover). Si un episodio no coincide, elige otra numeración en la URL del manifiesto.

### 📦 Cambios respecto al proyecto original

JKAnimeNuvio parte de
[animeflv-stremio-addon](https://github.com/Pigamer37/animeflv-stremio-addon) (MIT), de
Pigamer37. Respecto a él:

- Se eliminaron los proveedores AnimeAV1, Henaojara, TioAnime, AnimeJara y AnimeFLV.
- Se eliminaron los catálogos, las fichas públicas y la configuración de despliegue del proyecto
  original.
- Se reescribieron la identificación, la extracción y la estructura del proyecto.
- Se conservan la licencia MIT y los créditos.
