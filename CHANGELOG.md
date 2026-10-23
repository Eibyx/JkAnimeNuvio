# Historial de versiones

## ☁️ JKAnimeNuvio v0.4.1 — Despliegue en el plan gratuito de Render

Koyeb cerró su plan gratuito a usuarios nuevos y Hugging Face cobra por los Spaces con Docker
(octubre de 2026). La guía de la nube pasa a **[Render](README.md#render)**, cuyo plan gratuito
admite servicios Docker. Sin variables nuevas, el comportamiento local no cambia.

### ☁️ Render

- **`render.yaml`** (*Blueprint*): servicio web Docker en el plan `free`, rama `main`, health
  check `/health`, redespliegue con cada commit (`autoDeployTrigger: commit`, el sustituto
  actual de `autoDeploy`), `ADDON_TOKEN` generado por Render, claves de TMDB/TVDB opcionales
  (`sync: false`) y los valores recomendados para 0,1 vCPU / 512 MB.
- Botón **Deploy to Render** y guía paso a paso desde el teléfono en el README: dónde ver el
  token, cómo poner las claves, URL `https://<app>.onrender.com/<TOKEN>/manifest.json`,
  comprobaciones tras desplegar y qué hacer si JKAnime bloquea la IP (Termux, o Termux con
  `cloudflared tunnel`).
- Cómo evitar que el plan gratuito duerma el servicio (15 min sin tráfico) con
  [cron-job.org](https://cron-job.org/) visitando `/health` cada 10 minutos.
- `Dockerfile`: puerto por defecto 10000 (el de Render) en lugar de 8000; Render define `PORT`
  al ejecutar y el `HEALTHCHECK` lo lee de `process.env.PORT`.

### 🐛 Correcciones

- **`ADDON_TOKEN` generado por Render rechazado:** `generateValue` produce base64 estándar
  (con `+`, `/` y `=`) y la validación solo admitía letras, números y `- _ . ~`, así que el
  servidor se negaba a arrancar. Ahora el token se acepta tal cual (un `/` interno ocupa varios
  segmentos de la ruta) o codificado con `%`, siempre con comparación en tiempo constante.

### ✅ Comprobado

- 170 pruebas automatizadas, incluidas las cabeceras del proxy de Render (`X-Forwarded-Proto`,
  `X-Forwarded-For` con la IP del cliente primero): página `/` en HTTPS, IP real en `/status` y
  límite por IP independiente para cada cliente.
- El `Dockerfile` se comprobó reproduciendo su contenido (dependencias de producción, arranque
  en el puerto 10000, `HEALTHCHECK`, apagado con `SIGTERM`), no con `docker build`.

## ☁️ JKAnimeNuvio v0.4.0 — Instancia personal en la nube (Koyeb)

Ahora puedes desplegar **tu propia instancia** en Koyeb (sustituido por Render en v0.4.1) (plan gratuito:
0,1 vCPU, 512 MB) además de usarla en Termux o en tu computadora. Sigue sin existir un servidor
público. **Todo lo nuevo es opcional:** sin las variables nuevas, el addon se comporta igual que
en v0.3.0. Hallazgos de la auditoría previa en
[`docs/AUDITORIA.md`](docs/AUDITORIA.md#nube).

### ☁️ Despliegue

- **`Dockerfile`** de producción (`node:22-alpine`, `npm ci --omit=dev`, usuario sin
  privilegios, `NODE_ENV=production`, `HEALTHCHECK` a `/health`) y **`.dockerignore`** (sin
  `.env`, pruebas, documentación ni `.git`).
- **Apagado limpio** con `SIGTERM`/`SIGINT`: termina las peticiones en curso y sale con código 0
  (máximo `SHUTDOWN_TIMEOUT_MS`, 10 s). Antes, como proceso principal de un contenedor, el
  servidor ignoraba `SIGTERM` hasta que la plataforma lo mataba.
- La página `/` muestra la dirección **HTTPS** correcta detrás de un proxy
  (`X-Forwarded-Proto`/`X-Forwarded-Host`) o la de `PUBLIC_URL`.
- `/health` responde al instante sin consultar servicios externos ni pedir token.

### 🔒 Seguridad en Internet

- **`ADDON_TOKEN`:** el manifiesto, los streams (también con configuración, como
  `numbering=tmdb&mapping=absolute`), la página de instalación y `/status` solo responden bajo
  `/{ADDON_TOKEN}/…`; sin el token, `404`. Comparación en tiempo constante; el token nunca
  aparece en los registros.
- **`RATE_LIMIT_PER_MIN`:** límite sencillo de peticiones por IP (en memoria), con `429` y
  `Retry-After`. **`TRUST_PROXY`** para usar la IP real del cliente detrás de Koyeb.
- CORS sigue abierto, como exige el protocolo de addons de Stremio.

### 📈 Recursos (0,1 vCPU / 512 MB)

- **Cachés en memoria con expulsión LRU:** primero las entradas caducadas y luego las menos
  usadas. `CACHE_MAX_ENTRIES` reduce el máximo de todas.
- Valores recomendados para Koyeb documentados en el README (`JK_CONCURRENCY=2`,
  `HTTP_MAX_CONCURRENCY=8`, `HTTP_MAX_PER_HOST=3`, `CACHE_MAX_ENTRIES=300`). Los valores por
  defecto no cambian.
- **`/status`** (`STATUS_ENABLED=true`, bajo el token): versión, tiempo en marcha, memoria,
  tamaño de las cachés, proveedores configurados y el **último resultado de JKAnime** (`OK`,
  `BLOCKED` o error), para saber al momento si Cloudflare bloquea la IP del servidor. Sin claves,
  sin token y sin enlaces.

### 🐛 Correcciones

- Una URL con un escape `%` inválido (p. ej. `/%E0%A4%A/manifest.json`) devolvía la página de
  error de Express con el **stack trace y rutas internas** del servidor. Ahora responde
  `{"error":"bad request"}` (400) sin detalles, en cualquier entorno.
- La caché expulsaba por orden de inserción (la entrada más usada podía salir la primera) y no
  retiraba antes las caducadas.

### ⚠️ Limitaciones

- **Cloudflare puede bloquear la IP de Koyeb.** El addon lo informa (`/status`, registros) y
  **no intenta eludirlo**.
- `TRUST_PROXY=true` toma la primera IP de `X-Forwarded-For`, que un cliente puede falsear para
  esquivar el límite por IP. La protección real es el token.
- El `Dockerfile` se comprobó reproduciendo su contenido (dependencias de producción, arranque,
  `HEALTHCHECK`, apagado), no con `docker build` en esta versión.

## 🎌 JKAnimeNuvio v0.3.0 — Identificación inteligente, seguridad y confiabilidad

Actualización centrada en **encontrar el anime correcto** (también con títulos japoneses muy
largos o escritos de otra forma), en **no equivocarse nunca de anime ni de temporada**, y en la
seguridad y estabilidad del servidor. Diagnóstico técnico completo en
[`docs/AUDITORIA.md`](docs/AUDITORIA.md); comparación con v0.2.1 en
[`docs/EVALUACION.md`](docs/EVALUACION.md).

> **Regla de diseño:** es preferible no mostrar ningún stream que reproducir un episodio de otro
> anime. En algunos casos dudosos, v0.3.0 devuelve una lista vacía donde v0.2.1 adivinaba.

> [!IMPORTANT]
> **Requiere Node.js 22 o superior.** Node.js 20 llegó al fin de su soporte (30-04-2026) y deja de
> estar soportado por JKAnimeNuvio.

### 🔍 Identificación

- **Búsqueda progresiva por etapas**, que se detiene en cuanto una entrada de JKAnime queda
  verificada: títulos propios → títulos alternativos verificados → variantes de romanización →
  fragmentos distintivos. Límites configurables: `JK_MAX_QUERIES`, `JK_SEARCH_CONCURRENCY`,
  `JK_SEARCH_BUDGET_MS`.
- **Títulos japoneses largos.** Consultas abreviadas generadas por reglas generales, sin listas
  fijas por anime. Para *Rich Girl Caretaker* (`kitsu:50761`): `rich girl caretaker`,
  `saijo no osewa`, `saijo no osewa takane no hanadarake` y `takane no hanadarake`.
- **Títulos alternativos:** el título alternativo de la ficha de JKAnime y los títulos abreviados
  de Kitsu se usan como evidencia y como búsquedas alternativas.
- **Identificación cruzada** entre Kitsu, AniList, MAL, yuna, ani.zip, Cinemeta, TMDB y TVDB con
  niveles de evidencia: *confirmado*, *probable* o *contradictorio* (rechazado). La falta de año
  ya no cuenta como coincidencia.
- **Validación más estricta de temporadas:** las entradas de AniList de otra temporada del mismo
  año (p. ej. *Koori no Jouheki*, primavera y otoño de 2026) ya no aportan títulos; `2nd Cour`,
  `Part 2`, OVAs, especiales y películas se distinguen siempre.
- **Prevención de coincidencias incorrectas:** sin año visible en la ficha de JKAnime, la entrada
  no se acepta; el año entre paréntesis del título (`Fruits Basket (2019)`) distingue los
  *remakes*; una coincidencia solo por el nombre principal exige el año exacto, el mismo formato y
  temporada y un único candidato; un subtítulo distinto (otro arco) nunca coincide; un episodio
  fuera del total conocido se rechaza (`EPISODE_NOT_FOUND`).
- **Diferencias de romanización:** `Jyouheki`/`Jouheki`/`Joheki`, `Ojou-sama`/`Ojousama` y
  `wo`/`o` se reconocen como el mismo título.

### ▶️ Reproducción

- **Errores aislados por servidor** y clasificados con códigos estables (`HTTP_404`, `HTTP_419`,
  `HTTP_429`, `HTTP_5XX`, `TIMEOUT`, `BLOCKED`, `PARSER_CHANGED`, `UNSUPPORTED_FORMAT`,
  `INVALID_MEDIA_URL`, `NO_MEDIA`, `EXTRACTOR_ERROR`). Un 404 ya no se presenta como «vídeo
  eliminado».
- **Cancelación real** de las peticiones de un servidor que supera su tiempo límite, y de toda la
  petición de Nuvio a los 25 s.
- **Enlaces temporales:** la caché nunca supera la caducidad que declaran los enlaces firmados
  (`expires`, `X-Amz-*`, `s`+`e`). Comprobación ligera opcional con `STREAM_PROBE=true`.
- **Filemoon:** el descifrado elige AES-128/192/256-GCM según la longitud de la clave, como la
  implementación de referencia (causa del error `Invalid key length`). Un formato distinto queda
  aislado en ese servidor como `UNSUPPORTED_FORMAT`.
- **Solicitudes a JKAnime:** una página irreconocible se detecta como `PARSER_CHANGED` (antes se
  guardaba una hora como «sin resultados»); caché según contenido (búsqueda 1 h, sin resultados
  10 min, ficha en emisión 30 min, finalizada 6 h); estado «Por estrenar»; límite global de
  peticiones simultáneas (`JK_CONCURRENCY`); la búsqueda se detiene en el primer desafío de
  Cloudflare (nunca se intenta eludir). El recuento de episodios reenvía la cookie de sesión de la
  ficha (posible corrección del HTTP 419, **sin verificar**).

### 🔒 Seguridad

- **Validación de URLs y redirecciones:** cada redirección se valida antes de conectarse; las
  credenciales y cookies no pasan a otro origen.
- **Direcciones privadas:** se rechazan IPs internas y especiales, incluidas IPv4 incrustadas en
  IPv6 (`[::ffff:127.0.0.1]`, NAT64, 6to4) y nombres que resuelven a direcciones internas.
  *Limitación residual documentada:* `fetch` vuelve a resolver el nombre al conectar, así que un
  servidor DNS hostil que cambie su respuesta en milisegundos (*DNS rebinding*) no queda
  totalmente excluido.
- **Límites de concurrencia** por servidor y en total.
- **Tamaño de respuesta** limitado a 5 MB, leído como flujo.
- **Credenciales y enlaces firmados** fuera de los registros (solo origen y ruta).

### 🩺 Herramientas

- **`npm run diagnose -- <id>`:** diagnóstico detallado de identificación y extracción (fuentes,
  búsquedas, candidatos con el motivo de aceptación o rechazo, servidores, tiempos y estado
  final), sin claves ni enlaces firmados.
- **Banco de evaluación** `scripts/evaluate.js`: compara la identificación de dos versiones del
  código. Resultado frente a v0.2.1, en red simulada: 24/24 casos correctos (antes 17/24) y 0
  falsos positivos (antes 3).
- **145 pruebas automatizadas** (87 en v0.2.1): seguridad HTTP, HTML real de JKAnime archivado,
  matriz de casos con datos reales y casos negativos.

### 🟩 Compatibilidad

- **Node.js 22 o superior.** Node.js 20 deja de estar soportado.
- GitHub Actions prueba Node.js **22 y 24** (`actions/checkout@v7`, `actions/setup-node@v7`).
- Android (Termux), Windows, Linux y macOS según la guía del README. Las pruebas reales se han
  hecho en Android con Termux y Nuvio.

### ✅ Comprobado por el desarrollador (Android + Termux + Nuvio)

| Anime | Resultado |
|---|---|
| *Rich Girl Caretaker* T1E1, `kitsu:50761:1` | Identificado (coincidencia exacta con JKAnime), 6 enlaces, **reproducción real confirmada** en el reproductor de Nuvio |
| *Ao Ashi* T2E1, `kitsu:49883:1` | Identificado como `ao-ashi-season-2`, episodio 1, con identificación cruzada Kitsu/AniList; 8 enlaces obtenidos (reproducción no verificada en esta prueba) |

Estas comprobaciones y las pruebas automatizadas demuestran los casos comprobados, **no** que todos
los animes ni todos los servidores funcionen.

### ⚠️ Limitaciones conocidas

- **Cloudflare** puede bloquear JKAnime desde VPN, proxies o servidores en la nube.
- **HTTP 419** en el recuento de episodios: corrección aplicada sin verificar; no impide encontrar
  episodios.
- **Filemoon:** formato real actual sin verificar; si cambia, solo falla ese servidor.
- **DNS rebinding:** riesgo residual descrito arriba.
- Los enlaces de vídeo **caducan**; JKAnime y los servidores **cambian su HTML** con frecuencia.
- Más estricto: algunos animes cuya ficha no muestra el año pueden quedar sin streams.

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
