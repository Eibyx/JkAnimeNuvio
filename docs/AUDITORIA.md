# Auditoría técnica de JKAnimeNuvio (base: v0.2.1, `main` @ 0f106cc)

Fecha: 2026-10-13. Alcance: `lib/identification`, `lib/jkanime`, `lib/providers`, `lib/stremio`,
`lib/utils`, `scripts`, `test`.

Este documento es el **diagnóstico previo** a los cambios de la rama
`improvement/resolver-reliability`. Cada hallazgo indica la evidencia, el nivel de riesgo, si está
**confirmado** (reproducido o demostrado por el código) o es una **hipótesis**, y la corrección
propuesta. Las correcciones aplicadas se describen en el CHANGELOG y en el PR.

## Cómo se obtuvo la evidencia

| Fuente | Qué aporta | Limitación |
|---|---|---|
| Lectura del código (líneas citadas) | Comportamiento exacto | — |
| Reproducciones con la red simulada de las pruebas (`test-support/helpers.js`) | Resultado de la identificación con datos controlados | Las páginas de JKAnime de la red simulada son sintéticas |
| Respuestas reales de Kitsu, AniList, yuna, ani.zip y Cinemeta (2026-10-13) | Títulos, años y enlaces reales de los casos de prueba | Pueden cambiar con el tiempo |
| HTML real de JKAnime archivado en web.archive.org (jun.–oct. 2026) | Estructura real de búsqueda, ficha y episodio | JKAnime responde con un desafío de Cloudflare desde este entorno; no se probó contra el sitio en vivo |
| Código de referencia de mediaflow-proxy (`filemoon.py`) | Formato del cifrado de Filemoon | No se pudo descargar una respuesta real de Filemoon |

Los parsers actuales (`parseSearch`, `parseAnimePage`, `parseEpisodePage`) **funcionan** con el HTML
real archivado: búsqueda de *black clover* (2 resultados), ficha de *Black Clover (TV)* (Serie, 2017,
170 episodios) y episodio 1 de *Gensou Suikoden* (10 servidores, 2 reproductores propios).

## Resumen

| ID | Área | Hallazgo | Riesgo | Estado |
|---|---|---|---|---|
| S1 | HTTP | Las redirecciones se siguen antes de validarlas (SSRF ciego) | Alto | Confirmado (código + especificación fetch) |
| S2 | HTTP | `safeUrl` acepta IPv6 con IPv4 incrustada (`[::ffff:127.0.0.1]`, `[::ffff:a9fe:a9fe]`, NAT64) | Alto | Confirmado (reproducido) |
| S3 | HTTP | Un nombre de host que resuelve a una IP privada no se rechaza (rebinding DNS) | Medio | Confirmado (código) |
| S4 | HTTP | La respuesta se lee entera antes de comprobar el tamaño | Medio | Confirmado (código) |
| S5 | HTTP | El tiempo límite de extracción no cancela las peticiones en curso | Bajo | Confirmado (código) |
| S6 | Registros | Los errores registran URLs completas de reproductores (con parámetros firmados) | Bajo | Confirmado (código) |
| I1 | Identificación | Títulos largos: solo se buscan los títulos completos (90–140 caracteres) | Alto | Confirmado (reproducido) |
| I2 | Identificación | Año desconocido en JKAnime = entrada aceptada (temporada 1) | Alto | Confirmado (reproducido: *remake*) |
| I3 | Identificación | Enlace entre bases aceptado si a una de ellas le falta el año | Medio | Confirmado (código) |
| I4 | Identificación | Títulos de AniList de otra temporada del mismo año se usan como si fueran de la temporada pedida | Medio | Confirmado (datos reales de *Koori no Jouheki*) |
| I5 | Identificación | Variantes de romanización (`Jyouheki`/`Jouheki`, `Ojou-sama`/`Ojousama`) no se buscan | Medio | Confirmado (reproducido) |
| I6 | Identificación | Todas las consultas a JKAnime se lanzan a la vez, sin parada temprana ni límite global | Medio | Confirmado (código) |
| I7 | Identificación | Entradas OVA/especial de Kitsu/AniList se tratan como serie | Bajo | Confirmado (código) |
| I8 | Identificación | Episodio mayor que el total conocido de la entrada no se rechaza antes de consultar JKAnime | Bajo | Confirmado (código) |
| J1 | JKAnime | Una búsqueda vacía (o HTML irreconocible) se guarda 1 hora | Medio | Confirmado (reproducido) |
| J2 | JKAnime | No se distingue «sin resultados» de «HTML cambiado» | Medio | Confirmado (código) |
| J3 | JKAnime | HTTP 419 en `/ajax/episodes/{id}/1` | Bajo | Causa muy probable identificada; corrección sin verificar en vivo |
| J4 | JKAnime | Fichas «Por estrenar» (sin año ni episodios) | Bajo | Confirmado (HTML real de *Ao Ashi Season 2*) |
| J5 | Caché | Fichas en emisión guardadas 6 horas | Bajo | Confirmado (código) |
| C1 | Caché | Respuestas con enlaces firmados guardadas 10 min sin mirar su caducidad | Medio | Confirmado (código) |
| E1 | Extractores | Clasificación de errores insuficiente (todo 404 = «eliminado») | Bajo | Confirmado (código) |
| E2 | Extractores | Filemoon `Invalid key length` | Bajo | Causa confirmada por la referencia; formato real sin verificar |
| T1 | Pruebas | Sin pruebas de seguridad HTTP, de títulos largos, de remakes ni de variantes de romanización | Medio | Confirmado |
| N1 | Node.js | CI y `engines` en Node 20, fuera de soporte desde abril de 2026 | Medio | Confirmado |

## Seguridad HTTP (`lib/utils/http.js`)

### S1. Redirecciones validadas después de seguirlas — riesgo alto, confirmado

```js
// lib/utils/http.js:93-98
const resp = await fetchImpl(url.href, { ..., redirect: "follow", ... })
// A redirect can only land somewhere safe.
if (resp.url && !safeUrl(resp.url)) throw new HttpError(`Redirected to unsafe URL: ...`)
```

Con `redirect: "follow"`, `fetch` conecta con **cada** salto antes de devolver la respuesta. La
comprobación de la línea 98 solo impide leer el cuerpo final: la petición a
`http://127.0.0.1:…` o a `http://169.254.169.254/…` ya se ha enviado. Las URLs de los servidores de
vídeo vienen de páginas extraídas (datos de terceros), así que un servidor malicioso puede redirigir
al addon hacia la red local del usuario (router, Termux, otros servicios).

**Corrección:** `redirect: "manual"`, un máximo de 5 saltos, y validación completa (URL + DNS) de cada
`Location` **antes** de conectarse. En una redirección a otro origen se descartan `Authorization`,
`Cookie` y `Referer` de origen cruzado; 301/302/303 pasan a `GET` sin cuerpo.

### S2. IPv6 con IPv4 incrustada — riesgo alto, confirmado

`new URL("http://[::ffff:127.0.0.1]/").hostname` es `[::ffff:7f00:1]`: la forma hexadecimal. La
comprobación (`/^::ffff:(\d+\.\d+\.\d+\.\d+)$/`, línea 66) solo reconoce la forma con puntos, así que
`safeUrl` devuelve la URL como segura. Reproducido:

```
safeUrl("http://[::ffff:127.0.0.1]/")  -> aceptada   (localhost)
safeUrl("http://[::ffff:a9fe:a9fe]/")  -> aceptada   (169.254.169.254, metadatos de nube)
safeUrl("http://[64:ff9b::7f00:1]/")   -> aceptada   (NAT64 de 127.0.0.1)
safeUrl("http://[::7f00:1]/")          -> aceptada   (IPv4-compatible)
```

Tampoco se rechazan `198.18.0.0/15`, `192.0.0.0/24`, `192.0.2.0/24`, `198.51.100.0/24`,
`203.0.113.0/24`, `fec0::/10`, `2001:db8::/32` ni multicast IPv6 (`ff00::/8`).

**Corrección:** analizar IPv6 a 16 bytes y comprobar los rangos especiales, incluidas las formas
IPv4-mapped, IPv4-compatible, NAT64 (`64:ff9b::/96`) y 6to4 (`2002::/16`) con la IPv4 incrustada.

### S3. Rebinding DNS — riesgo medio, confirmado por el código

`safeUrl` solo mira el texto del host. `http://interno.ejemplo.com/` que resuelve a `192.168.1.1`
pasa la comprobación.

**Corrección:** resolver el nombre (`dns.lookup`, todas las direcciones) antes de cada conexión y
rechazar el destino si **alguna** dirección es privada o especial. **Riesgo residual documentado:**
`fetch` vuelve a resolver el nombre al conectar (ventana TOCTOU de milisegundos). Eliminarla exige
fijar la IP en el conector (dependencia `undici` o un cliente `node:https` propio); se descartó por
ahora porque cambiar el cliente HTTP puede alterar cómo responde Cloudflare a JKAnime y no se puede
probar desde este entorno.

### S4. Tamaño de respuesta comprobado tras leerla entera — riesgo medio, confirmado

```js
// lib/utils/http.js:99-100
const text = await resp.text()
if (text.length > MAX_BODY_BYTES) throw ...
```

Una respuesta de varios GB se carga en memoria antes de rechazarla (en Android, el proceso de Termux
puede morir). Además `text.length` cuenta caracteres, no bytes.

**Corrección:** rechazar por `Content-Length` y leer el cuerpo como flujo, cortando al superar el
límite.

### S5. Tiempo límite que no cancela — riesgo bajo, confirmado

`withTimeout` (`lib/stremio/streams.js:78`) y la carrera de `lib/app.js` (25 s) solo dejan de
esperar: las peticiones siguen en curso hasta su propio tiempo límite. El `AbortSignal.timeout`
de `request` no cubre la lectura del cuerpo de forma explícita.

**Corrección:** un `AbortController` por petición que cubre conexión **y** lectura, y una señal de
cancelación por extractor que se propaga a todas sus peticiones.

### S6. Registros — riesgo bajo, confirmado

`redactUrl` oculta `api_key`, `token`, `pin`… pero los errores de los extractores incluyen la URL
completa del reproductor (p. ej. `jkplayer/um?e=…&t=…`, parámetros firmados) y se escriben en el
registro (`lib/stremio/streams.js`).

**Corrección:** los mensajes de error muestran solo origen y ruta (`?…` en lugar de la consulta). Las
URLs multimedia nunca se registran.

## Identificación (`lib/identification`)

### I1. Títulos largos — riesgo alto, confirmado (reproducido)

`buildQueries` (`resolver.js:58-69`) produce el título base y el título completo. Para
`kitsu:50761` (*Rich Girl Caretaker*) solo genera:

```
"rich girl caretaker im secretly the caregiver of the most popular girl in this rich kid school"
"saijo no osewa takane no hanadarake na meimonkou de gakuin ichi no ojousama seikatsu nouryoku ..."
```

Un buscador de títulos como el de JKAnime difícilmente encuentra algo con 15–20 palabras. Y si
JKAnime usa un título corto, la puntuación lo descarta:

| Título en JKAnime (hipótesis) | Puntuación contra el título inglés | contra el romaji |
|---|---|---|
| `Saijo no Osewa` | 0,06 | 0,17 |
| `Rich Girl Caretaker` | 0,32 | 0,10 |
| Romaji completo con `Ojou-sama` y `o` | 0,22 | **0,98** |

No se pudo comprobar cómo titula JKAnime este anime (Cloudflare y sin copia archivada): el
diseño debe funcionar con cualquiera de las tres variantes.

**Corrección:** generación de consultas por reglas (no por anime): título principal antes de `:`,
fragmentos distintivos (primeras palabras de cada segmento largo), combinación de segmentos,
variantes de romanización. Búsqueda por etapas con parada temprana. Coincidencia **parcial**
(segmento principal) solo con año exacto verificado en la ficha de JKAnime, mismo formato, misma
temporada y candidato único.

### I2. Año desconocido aceptado — riesgo alto, confirmado (reproducido)

```js
// resolver.js:120-121
if (requireYear && year && !info.year) continue          // solo temporadas > 1
if (year && info.year && Math.abs(info.year - year) > 1) continue
```

Para temporada 1 y para `kitsu:`/`mal:`/`anilist:`, si la ficha de JKAnime no muestra el año, la
entrada se acepta por título. Reproducido con un *remake*: una petición de *Fruits Basket* (2019)
devuelve la entrada `fruits-basket` (2001) cuando su ficha no muestra el año. Ocurre en la práctica:
la ficha real de *Ao Ashi Season 2* «Por estrenar» no tenía `Emitido` (HTML archivado del 16-09-2026).
Además, `Fruits Basket (2019)` puntúa 0,83 contra `Fruits Basket` y se descarta: el año entre
paréntesis se trata como parte del nombre.

**Corrección:** sin año verificado en JKAnime, la entrada no se acepta cuando la petición tiene año
(se registra «año no verificable»). Un año entre paréntesis en el título de JKAnime se compara con el
pedido y se retira del nombre antes de puntuar.

### I3. Enlaces entre bases sin año — riesgo medio, confirmado

```js
// resolver.js:241
const sameYear = !entry.startYear || !other.startYear || Math.abs(other.startYear - entry.startYear) <= 1
```

La ausencia de año en una de las dos entradas cuenta como coincidencia. Un enlace erróneo de una sola
base hacia otra temporada sin fecha (habitual en anuncios) añadiría sus títulos.

**Corrección:** niveles de evidencia. *Confirmado*: formato y año coinciden. *Probable*: falta un año,
pero los títulos coinciden y el enlace lo declaran al menos dos fuentes independientes. *Contradictorio*
(formato o año distintos, o marcadores de temporada distintos): rechazado. Solo se usan confirmados y
probables.

### I4. Títulos de otra temporada del mismo año — riesgo medio, confirmado con datos reales

*Koori no Jouheki* (AniList 186497, primavera 2026) y *Koori no Jouheki 2nd Season* (AniList 213805,
otoño 2026) comparten IMDb `tt39123061`, TMDB `283428` y TVDB `459627` según yuna. Cinemeta lo
publica como una serie con T1 (14 episodios, desde 2026-04-02) y T2 (desde 2026-10-01). Ambas
entradas de AniList tienen año 2026, así que `anilistFor(2026)` aporta los títulos de las dos
temporadas, y un título sin marcador (`Koori no Jouheki`) se etiqueta como «temporada pedida»
(`parseTitle(t).season ?? season`): para T2 hace puntuar 1 a la entrada de T1. Hoy termina en
«ambiguo» (no sirve nada), pero por azar del orden y no por diseño.

**Corrección:** cada entrada de AniList se asigna a una temporada por sus marcadores; una entrada
sin marcador no se usa para una temporada > 1 si otra entrada del mismo año lleva ese marcador.

### I5. Variantes de romanización — riesgo medio, confirmado

Cinemeta escribe `Koori no Jyouheki`, ani.zip `Koori no Jyōheki`, Kitsu/AniList y JKAnime
`Koori no Jouheki`. Con la búsqueda literal, `tt39123061:1:1` y `:2:1` no encuentran nada (reproducido).
Igual con `Ojou-sama`/`Ojousama` y `wo`/`o`.

**Corrección:** igualdad por plegado de romanización (`jy→j`, vocales largas `ou/oo→o`, `uu→u`,
`ō→o`) al comparar, y como consultas de variante en una etapa posterior.

### I6. Consultas sin etapas ni límites — riesgo medio, confirmado

`searchCandidates` lanza todas las consultas a la vez (`resolver.js:72`, hasta 6). Con varias
peticiones simultáneas no hay límite global hacia JKAnime.

**Corrección:** etapas (títulos de confianza → alternativos → variantes → fragmentos), parada
temprana cuando hay una entrada verificada, límites configurables (`JK_MAX_QUERIES`,
`JK_SEARCH_CONCURRENCY`, `JK_SEARCH_BUDGET_MS`) y un limitador global de concurrencia hacia JKAnime
(`JK_CONCURRENCY`).

### I7. OVA/especiales — riesgo bajo, confirmado

`resolveAnimeDb` usa `expectKind = "movie"` solo para `MOVIE`; una entrada `OVA`/`SPECIAL` busca una
serie. **Corrección:** las entradas OVA/especial solo aceptan fichas OVA/Especial de JKAnime.

### I8. Episodios inexistentes — riesgo bajo, confirmado

`kitsu:ID:99` con 24 episodios conocidos consulta JKAnime igualmente (después `getEpisode` lo detecta
por la redirección). **Corrección:** rechazo inmediato `EPISODE_NOT_FOUND` si el número supera el
total conocido de la entrada (Kitsu/AniList), o el de una ficha finalizada de JKAnime.

## JKAnime (`lib/jkanime/site.js`)

### J1/J2. Búsquedas vacías y HTML irreconocible — riesgo medio, confirmado

`searchCache` guarda cualquier resultado 1 hora (`site.js:14`), también `[]`. Reproducido: dos
búsquedas sin resultados = una sola petición durante una hora. Si JKAnime cambia el HTML,
`parseSearch` devuelve `[]` y el fallo se oculta como «no existe» durante una hora.

El HTML real de búsqueda contiene `Resultados del busqueda` y `row page_directorio`; la ficha,
`anime__details__content`; el episodio, `var servers`/`video[n]`.

**Corrección:** una página sin esos marcadores lanza `PARSER_CHANGED` (no se guarda). Resultado vacío
válido: 10 minutos. Con resultados: 1 hora.

### J3. HTTP 419 — causa muy probable identificada, sin verificar en vivo

El HTML real muestra un sitio Laravel (`meta csrf-token`, `laravel-echo`) cuyo propio JavaScript
pagina con `POST /ajax/episodes/{id}/{pag}` y `data: {_token: token}`. En Laravel, HTTP 419 es
*TokenMismatch*: el token CSRF está ligado a la **cookie de sesión** que el navegador envía
automáticamente. El addon envía el token sin esa cookie. No es un mecanismo antibots: es la sesión
normal del sitio.

**Corrección propuesta (aplicada, sin verificar contra JKAnime):** reutilizar en esa misma consulta
las cookies que la ficha acaba de establecer (`Set-Cookie`), solo hacia el mismo host y sin guardarlas.
Si JKAnime sigue respondiendo 419, el comportamiento es el actual: el recuento de episodios queda
desconocido y la búsqueda del episodio no se ve afectada.

### J4. Fichas «Por estrenar» — riesgo bajo, confirmado

La ficha real archivada de *Ao Ashi Season 2* mostraba `Episodios: 0`, sin `Emitido` y
`Estado: Por estrenar` (clase `enemision notyet`). **Corrección:** estado `upcoming`, sin episodios.

### J5. Caché de fichas en emisión — riesgo bajo, confirmado

Fichas guardadas 6 horas aunque estén en emisión (el total de episodios cambia).
**Corrección:** 30 minutos en emisión o por estrenar; 6 horas finalizadas.

## Caché de respuestas (`lib/app.js`)

### C1. Enlaces firmados — riesgo medio, confirmado

Las respuestas con enlaces se guardan 10 minutos (`app.js:11`) y se anuncian con `cacheMaxAge: 600`
sin mirar la caducidad. Formatos verificables habituales: `expires=<unix>`, `X-Amz-Date` +
`X-Amz-Expires`, y la pareja `s=<inicio unix>&e=<segundos>` de los reproductores tipo Streamwish.
**Corrección:** la vida de la respuesta en caché se limita a la caducidad más próxima de sus enlaces,
menos un margen; si no se puede determinar, se mantienen los 10 minutos actuales.

## Extractores (`lib/jkanime/extractors.js`, `lib/stremio/streams.js`)

### E1. Clasificación de errores — riesgo bajo, confirmado

`classifyFailure` (`streams.js:17`) trata todo 404 como «vídeo eliminado». Un 404 también puede ser
una ruta de API cambiada. **Corrección:** códigos `HTTP_404`, `HTTP_419`, `HTTP_429`, `HTTP_5XX`,
`TIMEOUT`, `BLOCKED`, `PARSER_CHANGED`, `UNSUPPORTED_FORMAT`, `INVALID_MEDIA_URL`, `EXTRACTOR_ERROR`,
con textos que no presuponen la causa.

### E2. Filemoon `Invalid key length` — causa confirmada por la referencia

El extractor fija `aes-256-gcm` (`extractors.js:187`), que exige 32 bytes. La implementación de
referencia (mediaflow-proxy, `filemoon.py`) usa `AESGCM(key)` de `cryptography`, que **elige
AES-128/192/256 según la longitud de la clave** (16, 24 o 32 bytes). La traducción a Node perdió esa
selección. **Corrección:** seleccionar el algoritmo por longitud (16/24/32), igual que la referencia;
cualquier otra longitud → `UNSUPPORTED_FORMAT` aislado en ese servidor. No se truncan claves ni se
prueban otros algoritmos. No se pudo obtener una respuesta real de Filemoon para confirmar la longitud
que envía hoy.

## Pruebas y entorno

- **T1.** No hay pruebas de: redirecciones, IPv6 especiales, DNS, tamaño de respuesta, títulos
  largos, remakes, romanización, búsqueda vacía frente a HTML cambiado, caducidad de enlaces.
- **N1.** Node 20 llegó a fin de soporte (EOL) el 30-04-2026. `npm test` pasa 87/87 en Node 24.21.0
  (LTS) y en Node 22 (LTS), comprobado localmente.

## Hipótesis pendientes (no confirmadas)

- Cómo titula JKAnime *Rich Girl Caretaker* y *Koori no Jouheki 2nd Season*: sin acceso en vivo ni
  copia archivada. Las pruebas cubren las variantes plausibles y lo indican.
- Que la cookie de sesión resuelva el 419 (ver J3).
- Longitud real de la clave de Filemoon hoy (ver E2).
- Si el buscador de JKAnime tolera variantes (sin acentos, guiones): la red simulada es literal, el
  caso más exigente.

## Estado tras los cambios de esta rama

| ID | Estado | Dónde |
|---|---|---|
| S1–S4, S6 | Corregido, con pruebas | `lib/utils/http.js`, `lib/utils/ip.js`, `test/http.test.js` |
| S3 | Corregido; riesgo residual TOCTOU documentado | `assertPublicHost` |
| S5 | Corregido (cancelación real por servidor) | `lib/stremio/streams.js`, `lib/utils/context.js` |
| I1, I5, I6 | Corregido | `lib/identification/queries.js`, `resolver.js` (`findEntry`) |
| I2, I3, I4, I7, I8 | Corregido | `resolver.js` (`verifyCandidate`, `linkEvidence`, `entriesForSeason`) |
| J1, J2, J4, J5 | Corregido, probado con HTML real archivado | `lib/jkanime/site.js`, `test/jkanime.test.js` |
| J3 | Corrección aplicada **sin verificar** contra JKAnime | `sessionCookies` en `site.js` |
| C1 | Corregido | `lib/utils/expiry.js`, `lib/app.js` |
| E1 | Corregido | `lib/utils/errors.js`, `lib/stremio/streams.js` |
| E2 | Corregido según la referencia; formato real **sin verificar** | `decryptFilemoon` |
| T1 | 87 → 141 pruebas | `test/` |
| N1 | Node 22/24 en CI; `engines >=22` | `.github/workflows/ci.yml`, `package.json` |

Comparación de la identificación antes y después: [`EVALUACION.md`](EVALUACION.md).
