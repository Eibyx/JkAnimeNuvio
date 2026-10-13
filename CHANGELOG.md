# Historial de versiones

## 🎌 JKAnimeNuvio v0.2.1 — Mejoras de identificación y compatibilidad

Actualización de **JKAnimeNuvio v0.2.0** centrada en reconocer animes cuyos títulos se escriben
de forma distinta en cada base de datos. No cambia la instalación ni la configuración: basta con
actualizar (ver *Cómo actualizar JKAnimeNuvio* en el README).

### ✨ Mejoras

- **Identificación universal de títulos.** Un mismo anime puede llamarse *Aoashi 2nd Season* en
  Kitsu, *Aoashi Season 2* en AniList, *Ao Ashi S2* en ani.zip y *Ao Ashi Season 2* en JKAnime.
  JKAnimeNuvio ahora reconoce estas variantes sin ninguna correspondencia fija para un anime
  concreto.
- **Integración mejorada entre Kitsu, AniList y ani.zip.** Las peticiones `kitsu:`, `mal:` y
  `anilist:` reúnen los títulos de la **misma entrada** en las tres fuentes:
  - Se enlazan mediante los *mappings* de Kitsu, yuna y ani.zip.
  - Las bases de relaciones también se consultan por el id de AniList.
- **Búsqueda mediante títulos alternativos.** JKAnime se busca primero por el título base, sin
  marcador de temporada (por ejemplo, `ao ashi`), y después por los títulos completos.
- **Normalización de espacios.** Los títulos que solo difieren en los espacios (`Aoashi` / `Ao Ashi`,
  `Dragonball` / `Dragon Ball`) se consideran iguales. Es una igualdad exacta y no rebaja el umbral
  de coincidencia.
- **Mejor reconocimiento de temporadas.** `2nd Season`, `Season 2`, `S2` y `2` se tratan como la
  misma temporada, y la temporada 1 nunca se sirve cuando se pide la 2.
- **Validación del año de emisión.** Una entrada enlazada desde otra base de datos solo se usa si
  coinciden su formato y su año de inicio. La entrada de JKAnime se sigue verificando por año.
- **Mensajes más claros para enlaces eliminados.**
  - Tras identificar el episodio, cada servidor sin enlace muestra el motivo: vídeo eliminado
    (HTTP 404), bloqueo, tiempo agotado…
  - Una línea resume cuántos servidores dieron enlace.
  - El registro indica qué se buscó en JKAnime y cuántos resultados hubo.
- **Nuevas pruebas de regresión** (87 en total), con respuestas reales de Kitsu, AniList, yuna y
  ani.zip:
  - `kitsu:49883`, `anilist:191788` y `mal:61603` resuelven a `ao-ashi-season-2`, episodios 1 y 2.
  - Nunca se consulta la temporada de 2022, y un episodio que aún no existe devuelve una lista vacía.

### ✅ Comprobado por el desarrollador (Android + Termux + Nuvio)

| Anime | Resultado | Enlaces en Nuvio |
|---|---|---|
| Ao Ashi T2E1, `kitsu:49883` | Identificado: `ao-ashi-season-2`, episodio 1 | 8 |
| Ao Ashi T2E1, `anilist:191788` | Identificado | 8 |
| Black Clover T2E1 | Correcto | 7 |
| Gensou Suikoden T1E1 | Correcto | 7 |

Para Ao Ashi T2E1 aparecen enlaces de JKAnime (HLS), Streamwish (HLS), Vidhide (HLS), VOE (HLS y MP4),
Mixdrop (MP4), MP4Upload (MP4) y Streamtape (MP4).

### ⚠️ Limitaciones conocidas

- **Filemoon: `Invalid key length`.** El extractor descifra la respuesta de Filemoon con AES-256-GCM,
  que exige una clave de 32 bytes. Cuando Filemoon envía una clave de otra longitud, ese servidor no
  da enlace. Los demás servidores no se ven afectados.
  - *Propuesta para una versión futura:* elegir AES-128/192/256-GCM según la longitud de la clave
    (16, 24 o 32 bytes) y descartar el resto, con una prueba para cada caso.
- **JKAnime AJAX: HTTP 419.** La consulta interna que cuenta los episodios envía el token CSRF, pero
  no la cookie de sesión de la ficha del anime, y JKAnime la rechaza. Solo se usa cuando la ficha no
  muestra el total de episodios y **no impide encontrar el episodio**.
  - *Propuesta para una versión futura:* reutilizar la cookie de sesión de la ficha en esa consulta,
    o eliminar la consulta si la ficha siempre muestra el total.
- Siguen vigentes las limitaciones de v0.2.0:
  - Posibles bloqueos de Cloudflare.
  - Enlaces temporales que caducan.
  - Dependencia de servicios externos para identificar.
  - Diferencias entre numeraciones de temporadas.

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
