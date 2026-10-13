<div align="center">

# 🎌 JKAnimeNuvio

**Anime en español de JKAnime, directo en Nuvio. En tu propio dispositivo.**

[![Versión](https://img.shields.io/badge/versi%C3%B3n-0.2.1-blue)](#actualizar)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/en/download)
[![Licencia: MIT](https://img.shields.io/badge/licencia-MIT-green)](LICENSE)
[![Pruebas](https://github.com/Eibyx/JkAnimeNuvio/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Eibyx/JkAnimeNuvio/actions/workflows/ci.yml)

Addon **solo de streams** para [Nuvio](https://github.com/tapframe/NuvioStreaming) y cualquier
cliente compatible con el protocolo de addons de [Stremio](https://www.stremio.com/).
Basado en [animeflv-stremio-addon](https://github.com/Pigamer37/animeflv-stremio-addon), de Pigamer37.

</div>

> [!IMPORTANT]
> **JKAnimeNuvio es self-hosted.** No existe un servidor público: cada persona lo ejecuta en su
> propio teléfono Android (con Termux) o en su computadora, y lo instala en Nuvio desde ahí.

---

## 📑 Índice

1. [¿Qué es JKAnimeNuvio?](#que-es)
2. [Características](#caracteristicas)
3. [¿Qué necesitas para utilizar JKAnimeNuvio?](#requisitos)
4. [Instalación en Android con Termux](#android-termux)
5. [Instalación en Windows, Linux y macOS](#pc)
6. [Configurar TMDB y TVDB](#configurar-api)
7. [Cómo utilizar JKAnimeNuvio en Nuvio](#usar-en-nuvio)
8. [Configuración de temporadas](#temporadas)
9. [Cómo actualizar JKAnimeNuvio](#actualizar)
10. [Problemas frecuentes y soluciones](#problemas)
11. [Pruebas y verificación](#pruebas)
12. [Preguntas frecuentes](#faq)
13. [Para desarrolladores](#desarrolladores)
14. [Créditos, licencia y avisos](#creditos)

---

<a id="que-es"></a>

## 🌟 ¿Qué es JKAnimeNuvio?

JKAnimeNuvio es un pequeño servidor que se ejecuta en tu dispositivo. Cuando abres un episodio
de anime en Nuvio, Nuvio le pregunta: *"¿tienes enlaces para este episodio?"*. JKAnimeNuvio
busca ese anime en **JKAnime**, obtiene los enlaces de vídeo y se los devuelve a Nuvio para
que los reproduzca.

```text
Nuvio  ──(episodio: Black Clover T1 E5)──▶  JKAnimeNuvio (en tu dispositivo)
                                              │ 1. Identifica el anime (IMDb, TMDB, TVDB, AniList…)
                                              │ 2. Lo busca en JKAnime
                                              │ 3. Extrae los enlaces MP4 / HLS
Nuvio  ◀──────────(lista de enlaces)──────────┘
```

**Lo que hace:**

- ✅ Ofrece **solo streams** (enlaces de reproducción).
- ✅ Usa **JKAnime como única fuente de vídeo**.

**Lo que no hace:**

- ❌ **No** crea catálogos ni fichas de anime. Las portadas, sinopsis y listas de episodios las
  sigue mostrando el addon de metadatos que ya uses en Nuvio (por ejemplo Cinemeta o TMDB).
- ❌ **No** aloja vídeos ni sube nada a Internet: solo responde a tu propio Nuvio.

---

<a id="caracteristicas"></a>

## ✨ Características

| | Función | Qué significa para ti |
|---|---|---|
| 🎌 | **Búsqueda solo en JKAnime** | Todos los enlaces vienen de JKAnime, en español (subtitulado y, cuando existe, latino). |
| ▶️ | **Enlaces MP4 y HLS directos** | Nuvio recibe enlaces de vídeo reproducibles, nunca páginas web ni reproductores externos. |
| 📺 | **Compatible con Nuvio** | Manifiesto del protocolo Stremio con un único recurso: `stream`. |
| 🔍 | **Identificación por IMDb, TMDB, TVDB, AniList, MAL y Kitsu** | Funciona con los identificadores que usan Nuvio y los addons de metadatos habituales. |
| 🌸 | **Títulos japoneses, ingleses y alternativos** | Encuentra "Shingeki no Kyojin" aunque Nuvio pida "Attack on Titan", y "Gensou Suikoden" aunque pida "Suikoden: The Anime". |
| 🧩 | **Títulos larguísimos y variantes de escritura** | Busca por fragmentos distintivos ("Saijo no Osewa" para un título de 20 palabras) y reconoce romanizaciones distintas ("Jyouheki"/"Jouheki"), sin listas fijas por anime. |
| 🩺 | **Modo diagnóstico** | `npm run diagnose -- ID` explica cada paso: qué se buscó, qué se descartó y por qué. |
| 📚 | **Temporadas y episodios inteligentes** | Distingue temporadas, películas, OVAs y especiales, y comprueba el año de emisión antes de elegir. |
| 🔄 | **Numeración continua o independiente** | Adapta "Temporada 2, episodio 1" al episodio correcto de JKAnime (ver [Configuración de temporadas](#temporadas)). |
| ⚡ | **Caché y consultas en paralelo** | Responde más rápido al repetir episodios y consulta varias fuentes a la vez. |
| 🛡️ | **Validación y manejo de errores** | Si una fuente falla o hay dudas, devuelve una lista vacía en lugar de un episodio equivocado. |
| 🔒 | **Credenciales y red protegidas** | Tus claves de TMDB/TVDB nunca aparecen en respuestas ni en registros, y el addon nunca se conecta a tu red local aunque un servidor de vídeo lo intente. |

### 🎬 Servidores de reproducción

JKAnime ofrece cada episodio en varios servidores. JKAnimeNuvio intenta extraer un enlace
directo de los siguientes:

| Servidor | Formato habitual | Estado |
|---|---|---|
| Reproductor propio de JKAnime | HLS / MP4 | Implementado |
| YourUpload | MP4 | Implementado |
| MP4Upload | MP4 | Implementado |
| Streamwish | HLS | Implementado |
| Vidhide / Filelions | HLS | Implementado |
| VOE | HLS / MP4 | Implementado |
| Filemoon | HLS | Implementado |
| Mixdrop | MP4 | Implementado |
| Streamtape | MP4 | Implementado |
| Pixeldrain | MP4 | Implementado |
| OK.ru | HLS | Implementado |
| Mega, Doodstream y otros | — | No compatibles: se omiten |

> [!NOTE]
> "Implementado" significa que el extractor existe y supera las pruebas automatizadas con
> páginas de ejemplo. En uso real, JKAnimeNuvio ya devolvió varios enlaces MP4 y HLS de
> distintos servidores. Sin embargo, **no se ha verificado servidor por servidor**. Los
> servidores de vídeo cambian sus páginas con frecuencia, así que cualquiera puede dejar de
> funcionar sin aviso; los demás siguen funcionando.

---

<a id="requisitos"></a>

## 📋 ¿Qué necesitas para utilizar JKAnimeNuvio?

| Requisito | ¿Obligatorio? | Detalles |
|---|---|---|
| 📱 Android con **Termux**, o una computadora con Windows, Linux o macOS | Sí | Es donde se ejecutará el servidor. |
| 🟩 **Node.js 22 o superior** (LTS 22 o 24) | Sí | El entorno que ejecuta JKAnimeNuvio. Node.js 20 ya no tiene soporte. |
| 🌿 **Git** | Sí | Para descargar y actualizar el proyecto. |
| 🌐 **Conexión a Internet** | Sí | Una conexión doméstica o móvil normal. Las VPN y los servidores en la nube suelen estar bloqueados por JKAnime (Cloudflare). |
| 📺 **Nuvio** u otro cliente compatible con addons de Stremio | Sí | Donde verás el anime. |
| 🔑 Credenciales de **TMDB** | Opcional, recomendado | Gratis. Mejora la identificación. |
| 🔑 Credenciales de **TVDB** | Opcional, recomendado | Necesarias para animes muy recientes (ver abajo). |

<a id="para-que-credenciales"></a>

### 🔑 ¿Para qué sirven las credenciales de TMDB y TVDB?

JKAnimeNuvio **funciona sin ellas**, pero con menos alcance:

| Sin credenciales | Con TMDB y/o TVDB |
|---|---|
| ✅ Animes que Cinemeta conoce (la mayoría de los ya emitidos) | ✅ Todo lo anterior |
| ✅ Identificadores de AniList, MAL y Kitsu | ✅ **Animes recientes que Cinemeta todavía no tiene** (por ejemplo, Gensou Suikoden, `tt42938834`) |
| ❌ Identificadores `tmdb:` y `tvdb:` | ✅ Identificadores `tmdb:` y `tvdb:` |
| ❌ Numeración de temporadas de TMDB o TVDB | ✅ Numeración elegible: TMDB, TVDB, absoluta… |

**Dónde obtenerlas** (ambas requieren crear una cuenta):

- **TMDB:** <https://www.themoviedb.org/settings/api>
- **TVDB:** <https://thetvdb.com/api-information>

> [!TIP]
> **TMDB te da dos credenciales distintas** en la misma página. Solo necesitas **una**:
>
> | Credencial de TMDB | Aspecto | Variable | Recomendación |
> |---|---|---|---|
> | **API Read Access Token** | Texto muy largo que empieza por `eyJ…` | `TMDB_API_READ_TOKEN` | ⭐ Recomendada |
> | **API Key** (v3) | 32 caracteres hexadecimales | `TMDB_API_KEY` | Alternativa |
>
> Si pones las dos, se usa el token.

---

<a id="android-termux"></a>

## 📱 Instalación en Android con Termux

Esta guía está pensada para hacerlo **todo en el mismo teléfono** donde usas Nuvio. Solo tienes
que copiar y pegar los comandos en Termux, uno por uno.

### Paso 1 · Descargar Termux de forma segura

Descarga Termux desde **F-Droid**:

👉 <https://f-droid.org/packages/com.termux/>

Otra fuente oficial son las versiones publicadas en GitHub:
<https://github.com/termux/termux-app/releases>.

> [!WARNING]
> Evita APKs de páginas desconocidas. Si tienes una versión antigua de Termux instalada desde
> otro sitio, desinstálala antes: las versiones de distintas fuentes no son compatibles entre sí.

### Paso 2 · Actualizar los paquetes

Abre Termux y ejecuta:

```bash
pkg update && pkg upgrade -y
```

Si te pregunta algo durante la actualización, pulsa **Enter** para aceptar la opción por
defecto.

### Paso 3 · Instalar Git y Node.js

```bash
pkg install -y git nodejs-lts nano curl
```

Comprueba las versiones. Node.js debe ser **22 o superior** (`nodejs-lts` instala una versión LTS actual):

```bash
node -v
git --version
```

### Paso 4 · Descargar (clonar) JKAnimeNuvio

```bash
cd ~
git clone https://github.com/Eibyx/JkAnimeNuvio.git
```

> [!NOTE]
> Esto descarga la rama `main`, que contiene la última versión publicada. Puedes ver todas las
> versiones en [Releases](https://github.com/Eibyx/JkAnimeNuvio/releases).

### Paso 5 · Entrar en la carpeta

```bash
cd ~/JkAnimeNuvio
```

### Paso 6 · Instalar las dependencias

```bash
npm ci --omit=dev
```

Tarda menos de un minuto. Al final debe aparecer `found 0 vulnerabilities` o un mensaje similar.

### Paso 7 · Crear y configurar el archivo `.env`

El archivo `.env` guarda tu configuración privada (por ejemplo, tus claves de TMDB y TVDB).

```bash
cp .env.example .env
nano .env
```

Dentro del editor:

1. Muévete con las flechas del teclado de Termux.
2. Pega tus credenciales después del `=`, sin espacios ni comillas. Por ejemplo:
   `TVDB_API_KEY=abcd1234-ejemplo`.
3. Guarda con **Ctrl + O** y luego **Enter**.
4. Sal con **Ctrl + X**.

Si no tienes credenciales todavía, puedes dejar todo vacío: JKAnimeNuvio funcionará igualmente
(ver [qué cambia](#para-que-credenciales)).

### Paso 8 · Iniciar JKAnimeNuvio

```bash
npm start
```

Verás:

```text
JKAnimeNuvio listening on http://0.0.0.0:3000/manifest.json
```

**Deja esta pantalla abierta**: mientras Termux muestre esto, el addon está funcionando.

### Paso 9 · Comprobar que funciona

Abre una **segunda sesión** de Termux: desliza desde el borde izquierdo de la pantalla y toca
**NEW SESSION**. Después ejecuta:

```bash
curl http://127.0.0.1:3000/health
```

Debe responder `{"ok":true}`.

También puedes abrir esta dirección en el navegador del teléfono:
**<http://127.0.0.1:3000/manifest.json>**. Deberías ver un texto que empieza por
`{"id":"com.eibyx.jkanimenuvio",…`.

### Paso 10 · Instalarlo en Nuvio

Sigue la sección [Cómo utilizar JKAnimeNuvio en Nuvio](#usar-en-nuvio)
usando esta dirección:

```text
http://127.0.0.1:3000/manifest.json
```

<a id="mantener-servidor"></a>

### 🔋 Mantener el servidor funcionando

Android cierra las aplicaciones en segundo plano para ahorrar batería. Para evitarlo:

1. **Bloquea la suspensión** de Termux mientras usas el addon:
   ```bash
   termux-wake-lock
   ```
   Aparecerá una notificación de Termux con el bloqueo activo. Para liberarlo:
   `termux-wake-unlock`.
2. **Desactiva la optimización de batería** para Termux en los ajustes de Android. El nombre
   exacto de la opción depende del fabricante (suele estar en *Aplicaciones → Termux →
   Batería*).
3. **No cierres** Termux desde la lista de aplicaciones recientes.

> [!NOTE]
> Algunas versiones de Android (12 o superior) pueden cerrar procesos en segundo plano aunque
> hagas todo lo anterior. JKAnimeNuvio no puede evitarlo.

**¿Qué pasa si Android cierra Termux?** El servidor se detiene y Nuvio dejará de recibir
enlaces de JKAnimeNuvio (no verás errores, solo ninguna opción de JKAnime). No se pierde
ninguna configuración. Vuelve a abrir Termux y ejecuta:

```bash
cd ~/JkAnimeNuvio && npm start
```

**¿Cómo detenerlo?** En la sesión donde se está ejecutando, pulsa **Ctrl + C** (en Termux, la
tecla **CTRL** de la barra superior y luego **c**).

---

<a id="pc"></a>

## 💻 Instalación en Windows, Linux y macOS

En una computadora, el proceso es el mismo que en Android: instalar Node.js y Git, descargar el
proyecto, configurar `.env` e iniciar. Los comandos cambian según el sistema.

<details>
<summary><b>🪟 Windows (PowerShell)</b></summary>

1. **Instala Node.js (LTS) y Git.** La forma más sencilla es abrir **PowerShell** y ejecutar:
   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install Git.Git
   ```
   También puedes usar los instaladores de <https://nodejs.org/en/download> y
   <https://git-scm.com/downloads>.

   **Cierra y vuelve a abrir PowerShell** para que reconozca los nuevos programas.
2. **Comprueba las versiones** (Node.js 22 o superior):
   ```powershell
   node -v
   git --version
   ```
3. **Descarga el proyecto e instala las dependencias:**
   ```powershell
   cd $HOME
   git clone https://github.com/Eibyx/JkAnimeNuvio.git
   cd JkAnimeNuvio
   npm ci --omit=dev
   ```
4. **Crea y edita la configuración:**
   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```
   Escribe tus credenciales después del `=` y guarda el archivo.
5. **Inicia el addon:**
   ```powershell
   npm start
   ```
   Si Windows pregunta si permite que Node.js acceda a la red, acepta **solo para redes
   privadas**. Esto hace falta si quieres usarlo desde otro dispositivo.
6. **Comprueba** que funciona abriendo <http://127.0.0.1:3000/manifest.json> en el navegador.

> [!TIP]
> Si PowerShell muestra *"la ejecución de scripts está deshabilitada en este sistema"* al usar
> `npm`, escribe `npm.cmd` en su lugar (por ejemplo, `npm.cmd start`), o permite los scripts
> locales para tu usuario:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`
> ([más información](https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_execution_policies)).

</details>

<details>
<summary><b>🐧 Linux</b></summary>

1. **Instala Node.js 22+ y Git** con el gestor de tu distribución (si tu distribución trae una
   versión anterior, usa <https://nodejs.org/en/download>):
   ```bash
   # Debian / Ubuntu
   sudo apt update && sudo apt install -y git nodejs npm
   # Fedora
   sudo dnf install -y git nodejs npm
   # Arch
   sudo pacman -S --needed git nodejs npm
   ```
   Comprueba la versión con `node -v`. Si es **menor que 22** (frecuente en Debian/Ubuntu),
   instala una versión actual con [nvm](https://github.com/nvm-sh/nvm) o desde
   <https://nodejs.org/en/download>.
2. **Descarga el proyecto, configúralo e inícialo:**
   ```bash
   cd ~
   git clone https://github.com/Eibyx/JkAnimeNuvio.git
   cd JkAnimeNuvio
   npm ci --omit=dev
   cp .env.example .env
   nano .env
   npm start
   ```
3. **Comprueba** que funciona: `curl http://127.0.0.1:3000/health` debe responder `{"ok":true}`.

</details>

<details>
<summary><b>🍎 macOS</b></summary>

1. **Instala Node.js 22+ y Git.** Con [Homebrew](https://brew.sh/):
   ```bash
   brew install node git
   ```
   También puedes usar el instalador de <https://nodejs.org/en/download>. macOS te ofrecerá
   instalar Git la primera vez que lo uses.
2. **Descarga el proyecto, configúralo e inícialo:**
   ```bash
   cd ~
   git clone https://github.com/Eibyx/JkAnimeNuvio.git
   cd JkAnimeNuvio
   npm ci --omit=dev
   cp .env.example .env
   open -e .env
   npm start
   ```
   `open -e` abre `.env` en TextEdit. Guarda los cambios antes de ejecutar `npm start`.
3. **Comprueba** que funciona: `curl http://127.0.0.1:3000/health` debe responder `{"ok":true}`.

</details>

En cualquier sistema, el servidor se detiene con **Ctrl + C**.

---

<a id="configurar-api"></a>

## 🔑 Configurar TMDB y TVDB

### Obtener las credenciales

**TMDB (The Movie Database)**

1. Crea una cuenta gratuita en <https://www.themoviedb.org/>.
2. Entra en <https://www.themoviedb.org/settings/api> y solicita acceso a la API (uso
   personal).
3. Copia el **API Read Access Token** (recomendado) o la **API Key**.

**TVDB (TheTVDB)**

1. Crea una cuenta en <https://thetvdb.com/>.
2. Consulta las condiciones y obtén tu clave en <https://thetvdb.com/api-information>.
3. Copia tu **API Key**. Según el tipo de clave que te asigne TVDB, también puede pedirte tu
   **PIN de suscriptor**.

### Colocarlas en `.env`

Abre `.env` (ver los pasos de instalación) y rellena lo que tengas. Ejemplo con **valores
ficticios**:

```ini
PORT=3000

TMDB_API_READ_TOKEN=eyJhbGciOiJIUzI1NiJ9.ejemplo-ficticio
TMDB_API_KEY=

TVDB_API_KEY=00000000-0000-0000-0000-000000000000
TVDB_SUBSCRIBER_PIN=

METADATA_PROVIDER=auto
CINEMETA_ENABLED=true
RELATIONS_ENABLED=true
```

Después de cambiar `.env`, **reinicia** JKAnimeNuvio (Ctrl + C y `npm start`).

### Todas las variables

| Variable | Por defecto | Para qué sirve |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor local. |
| `TMDB_API_READ_TOKEN` | *(vacío)* | Token de lectura de TMDB. Recomendado. |
| `TMDB_API_KEY` | *(vacío)* | API Key v3 de TMDB. Solo se usa si no hay token. |
| `TVDB_API_KEY` | *(vacío)* | Clave de la API v4 de TheTVDB. |
| `TVDB_SUBSCRIBER_PIN` | *(vacío)* | PIN de suscriptor de TVDB, solo si tu tipo de clave lo exige. |
| `METADATA_PROVIDER` | `auto` | `auto` usa TMDB, luego TVDB, más Cinemeta. Con `tmdb`, `tvdb` o `cinemeta` se limita a ese proveedor. |
| `CINEMETA_ENABLED` | `true` | `false` desactiva Cinemeta. ⚠️ Cambia la numeración por defecto (ver [temporadas](#temporadas)). |
| `RELATIONS_ENABLED` | `true` | `false` desactiva las bases de relaciones yuna y ani.zip. |
| `HOST` | `0.0.0.0` | Interfaz de red. Con `127.0.0.1`, solo este mismo dispositivo puede conectarse. |
| `JKANIME_BASE` | `https://jkanime.net` | Dirección de JKAnime. |
| `CINEMETA_BASE` | `https://v3-cinemeta.strem.io` | Dirección de Cinemeta (solo para identificar). |
| `HTTP_TIMEOUT_MS`, `TMDB_TIMEOUT_MS`, `TVDB_TIMEOUT_MS`, `CINEMETA_TIMEOUT_MS`, `ANILIST_TIMEOUT_MS`, `KITSU_TIMEOUT_MS`, `RELATIONS_TIMEOUT_MS` | 6000 a 10000 | Tiempo máximo de espera por fuente, en milisegundos. |
| `EXTRACT_TIMEOUT_MS` | `12000` | Tiempo máximo por servidor de vídeo. |
| `STREAM_TIMEOUT_MS` | `25000` | Tiempo máximo total por petición de Nuvio. |
| `JK_MAX_QUERIES` | `8` | Búsquedas máximas en JKAnime por petición. |
| `JK_SEARCH_CONCURRENCY` | `2` | Búsquedas simultáneas en JKAnime dentro de una petición. |
| `JK_SEARCH_BUDGET_MS` | `10000` | Tiempo máximo dedicado a buscar; pasado ese tiempo no se lanzan más etapas. |
| `JK_CONCURRENCY` | `3` | Peticiones simultáneas a JKAnime en total (todas las peticiones de Nuvio). |
| `HTTP_MAX_PER_HOST`, `HTTP_MAX_CONCURRENCY` | `4`, `16` | Peticiones simultáneas por servidor y en total. |
| `STREAM_PROBE` | `false` | `true` comprueba cada enlace antes de mostrarlo (lista HLS o 1 byte del MP4). Más lento. |

Si una credencial falta, es incorrecta o el servicio no responde, ese proveedor se omite y los
demás siguen funcionando.

> [!CAUTION]
> **Tus credenciales son privadas.**
> - Nunca subas `.env` a GitHub. Ya está excluido en `.gitignore`; no lo fuerces con `git add -f`.
> - No las muestres en capturas de pantalla ni en vídeos.
> - No las pegues en issues, foros ni chats.
>
> JKAnimeNuvio las oculta (`***`) en sus mensajes de error y registros, y `npm run live-check`
> solo indica si están "configured" o "not set". Si alguna se filtra, **revócala** desde la web
> de TMDB o TVDB y crea otra.

---

<a id="usar-en-nuvio"></a>

## ▶️ Cómo utilizar JKAnimeNuvio en Nuvio

### 1. Inicia el servidor

En Termux o en tu computadora:

```bash
cd ~/JkAnimeNuvio
npm start
```

<a id="direccion"></a>

### 2. Elige la dirección correcta

| Dónde está el servidor | Dirección para Nuvio |
|---|---|
| **En el mismo teléfono** que Nuvio (Termux) | `http://127.0.0.1:3000/manifest.json` |
| En **otro dispositivo de la misma red Wi‑Fi** (una computadora u otro teléfono) | `http://IP-DEL-SERVIDOR:3000/manifest.json` (por ejemplo, `http://192.168.1.50:3000/manifest.json`) |

> [!IMPORTANT]
> `127.0.0.1` significa *"este mismo dispositivo"*. Solo funciona si Nuvio y JKAnimeNuvio se
> ejecutan en el mismo aparato. Desde otro dispositivo hay que usar la IP local del servidor.

**Cómo encontrar la IP local del dispositivo donde corre el servidor:**

| Sistema | Cómo |
|---|---|
| Android | *Ajustes → Wi‑Fi →* toca tu red → **Dirección IP** (la ubicación exacta varía según el fabricante). |
| Windows | `ipconfig`, en la línea **Dirección IPv4** de tu adaptador Wi‑Fi o Ethernet. |
| macOS | `ipconfig getifaddr en0` |
| Linux | `hostname -I` (la primera dirección). |

### 3. Comprueba el manifiesto en el navegador

Antes de ir a Nuvio, abre la dirección elegida en el **navegador del dispositivo donde está
Nuvio**. Debes ver un texto que empieza por `{"id":"com.eibyx.jkanimenuvio",…` y contiene
`"resources":[{"name":"stream"`. Si no carga, revisa
[Manifiesto inaccesible desde otro dispositivo](#manifiesto-inaccesible).

### 4. Instálalo en Nuvio

En Nuvio, abre la **configuración de addons** y usa la opción para **añadir un addon mediante
URL**. Pega la dirección del manifiesto y confirma la instalación. Los nombres exactos de los
menús pueden variar entre versiones de Nuvio.

### 5. Úsalo

1. Abre un anime en Nuvio. La ficha la proporciona tu addon de metadatos, por ejemplo Cinemeta.
2. Elige un episodio.
3. En la lista de fuentes aparecerán las opciones **JKAnime**, una por servidor:
   - `SUB`: japonés con subtítulos en español.
   - `LAT`: doblaje latino, cuando existe.

> [!NOTE]
> JKAnimeNuvio **no añade catálogos** a la pantalla de inicio de Nuvio. Es normal: solo aporta
> enlaces cuando abres un episodio.

**¿Y en Stremio?** En Stremio de escritorio, pega la URL del manifiesto en la barra de búsqueda
de addons. Algunos clientes exigen HTTPS para direcciones que no sean `127.0.0.1`; este proyecto
no incluye HTTPS.

---

<a id="temporadas"></a>

## 📚 Configuración de temporadas

No todos los servicios numeran igual los episodios. Black Clover es el ejemplo perfecto (datos
reales, octubre de 2026):

| Servicio | Cómo organiza Black Clover |
|---|---|
| **Cinemeta** | Temporada 1 = episodios 1‑170 (2017‑2021) · Temporada 2 = nueva temporada de 2026 |
| **TMDB** | Divide esos 170 episodios en 4 temporadas: 51 + 51 + 52 + 16 |
| **JKAnime** | `Black Clover (TV)` con 170 episodios seguidos, y la temporada de 2026 como entrada aparte |

Así, "Temporada 2, Episodio 1" significa cosas distintas: para Cinemeta es el estreno de 2026; para
TMDB es el episodio 52. JKAnimeNuvio permite elegir qué numeración usa tu Nuvio.

### Modalidades disponibles

| Modalidad | Qué hace | Cuándo usarla |
|---|---|---|
| **Automática** (por defecto) | Usa la numeración de Cinemeta si conoce la serie; si no, la de TMDB y, si tampoco, la de TVDB. | La mayoría de los casos. |
| **Cinemeta** | Siempre la de Cinemeta. | Si tu Nuvio muestra las temporadas como Cinemeta. |
| **TMDB** | Temporadas de TMDB. | Si tu Nuvio muestra Black Clover en 4 temporadas (51/51/52/16) y los episodios no coinciden. Requiere credencial de TMDB. |
| **TVDB** | Temporadas de TVDB, en el orden que elijas. | Si tu cliente usa TVDB. Requiere `TVDB_API_KEY`. |
| **Numeración absoluta** | Convierte siempre "temporada + episodio" en un número continuo dentro de la entrada principal de JKAnime. | Series que JKAnime publica como una sola lista larga. |
| **Temporadas independientes** | Solo busca una entrada propia de JKAnime para cada temporada, sin recurrir a la numeración continua. | Series que JKAnime publica temporada por temporada (estilo AniList). |

En la modalidad automática, JKAnimeNuvio busca primero una entrada propia de esa temporada en
JKAnime. Si no la encuentra, prueba con la numeración continua. Los especiales (temporada 0) no
se asignan nunca.

### Cómo elegirla: la URL del manifiesto

Cada modalidad se instala con una URL distinta. Cada variante tiene su propio identificador, así
que puedes instalar varias a la vez y comparar:

| URL del manifiesto | Numeración |
|---|---|
| `http://127.0.0.1:3000/manifest.json` | Automática |
| `http://127.0.0.1:3000/numbering=cinemeta/manifest.json` | Cinemeta |
| `http://127.0.0.1:3000/numbering=tmdb/manifest.json` | TMDB |
| `http://127.0.0.1:3000/numbering=tvdb/manifest.json` | TVDB, orden por defecto |
| `http://127.0.0.1:3000/numbering=tvdb-absolute/manifest.json` | TVDB, orden absoluto. También: `tvdb-official`, `tvdb-dvd`, `tvdb-alternate`, `tvdb-regional` |
| `http://127.0.0.1:3000/mapping=absolute/manifest.json` | Numeración absoluta |
| `http://127.0.0.1:3000/mapping=season/manifest.json` | Temporadas independientes |
| `http://127.0.0.1:3000/numbering=tmdb&mapping=absolute/manifest.json` | Combinación: TMDB + absoluta |

### Black Clover con cada modalidad

| Modalidad | Nuvio pide… | JKAnimeNuvio entrega… |
|---|---|---|
| Automática | T1 E5 | `Black Clover (TV)`, episodio 5 |
| Automática | T1 E170 | `Black Clover (TV)`, episodio 170 |
| Automática | T2 E1 | La **temporada de 2026**, episodio 1 |
| TMDB | T2 E1 | `Black Clover (TV)`, **episodio 52** (51 de la T1 + 1) |
| TMDB | T4 E16 | `Black Clover (TV)`, episodio 170 |
| TVDB absoluto | T1 E52 | `Black Clover (TV)`, episodio 52 |
| TVDB absoluto | T2 E1 | Nada: esa numeración no tiene temporada 2 |
| Temporadas independientes, sin la entrada de 2026 en JKAnime | T2 E1 | Nada (no recurre al episodio 171) |
| Cualquiera | T0 E1 (especial) | Nada |

> [!TIP]
> Los identificadores `tmdb:` y `tvdb:` usan automáticamente la numeración de su propio servicio.

---

<a id="actualizar"></a>

## 🔄 Cómo actualizar JKAnimeNuvio

1. **Detén** el servidor con **Ctrl + C**.
2. **Descarga** la nueva versión e **instala** las dependencias:
   ```bash
   cd ~/JkAnimeNuvio
   git pull
   npm ci --omit=dev
   ```
   En Windows, usa `cd $HOME\JkAnimeNuvio` en PowerShell. Los demás comandos son iguales.
3. **Revisa si hay variables nuevas.** Este comando lista las variables de `.env.example` que
   faltan en tu `.env`, **sin mostrar tus claves**:
   ```bash
   for v in $(grep -oE '^[A-Z_]+=' .env.example | tr -d '='); do grep -q "^$v=" .env || echo "Falta: $v"; done
   ```
   Si no aparece nada, no hay que cambiar nada. En Windows, abre ambos archivos con
   `notepad .env.example` y `notepad .env` y compáralos a ojo.
4. **Reinicia:**
   ```bash
   npm start
   ```

**Tu archivo `.env` se conserva**: Git lo ignora, así que `git pull` nunca lo modifica ni lo
borra.

> [!TIP]
> - Si `git pull` dice que tienes **cambios locales**, guárdalos aparte con `git stash`, vuelve a
>   ejecutar `git pull` y, si los necesitas, recupéralos con `git stash pop`.
> - Si instalaste una versión de prueba desde la rama `feature/jkanime-stream-only`, cambia a
>   `main` una sola vez: `git fetch origin && git checkout main && git pull`.

---

<a id="problemas"></a>

## 🛠️ Problemas frecuentes y soluciones

> [!TIP]
> **Lo primero: mira la pantalla donde ejecutaste `npm start`.** Cada petición de Nuvio deja una
> línea:
>
> - `[stream] series tt7441658:1:5 -> black-clover-tv ep 5 (season/cinemeta)`: **episodio
>   identificado**.
> - `[streams] black-clover-tv ep 5: 4 links from 6 servers (sin enlace: …)`: cuántos servidores
>   dieron un enlace reproducible. Los que fallan aquí **no** son un fallo de identificación.
> - `[stream] series …: no streams (motivo)`: no se pudo identificar o no hubo enlaces; el motivo
>   explica qué falló.
> - `[resolver] … confirmed at stage "alternatives" after 5 queries`: con qué búsqueda se
>   verificó la entrada de JKAnime.

**La herramienta más útil es el modo diagnóstico**, que explica paso a paso un episodio concreto
(el ID aparece en la línea `[stream]`):

```bash
npm run diagnose -- kitsu:50761:1
```

```text
[IDENTITY] OK "Rich Girl Caretaker: …" (2026) TV, 12 episodes via kitsu
[LINK] kitsu:50761 -> anilist:201514 (kitsu-mappings+yuna): CONFIRMED format+year 2026
[SEARCH] fragments    "saijo no osewa" -> 1 results
[CANDIDATE] OK   saijo-no-osewa "Saijo no Osewa" score=1 partial
[MATCH] saijo-no-osewa episode 1 (kitsu, evidence probable)
[SERVER] OK   Streamwish SUB: 1 link(s) hls (812 ms)
[SERVER] FAIL Streamtape SUB: HTTP_404 (403 ms)
[STREAMS] PARTIAL 6 links; 1 of 8 servers failed (the episode itself is fine)
[STATUS] SUCCESS — streams found
```

*(Ejemplo ilustrativo.)* Muestra las fuentes de identificación, cada búsqueda en JKAnime con su
número de resultados, cada candidato con el motivo por el que se aceptó o rechazó, cada servidor
con su resultado y el tiempo por etapa. **Nunca muestra tus claves ni los enlaces de vídeo
firmados** (solo el servidor y el formato), así que puedes compartir su salida al pedir ayuda.
Opciones: `--numbering tvdb`, `--mapping absolute`, `--type movie`, `--json`, `--verbose`.

| `[STATUS]` | Qué significa |
|---|---|
| `SUCCESS` | Hay enlaces. |
| `NO_STREAMS` | El episodio existe, pero ningún servidor dio un enlace directo. |
| `ANIME_NOT_FOUND` | Ninguna entrada de JKAnime se pudo verificar (título, año, formato y temporada). |
| `AMBIGUOUS` | Varias entradas encajan igual de bien: por seguridad no se sirve ninguna. |
| `EPISODE_NOT_FOUND` | El anime está, pero ese episodio no (aún no publicado o fuera del total). |
| `BLOCKED` | JKAnime respondió con un desafío de Cloudflare (ver más abajo). |
| `PARSER_CHANGED` | Una página de JKAnime ya no tiene la estructura esperada: hay que actualizar el addon. |
| `IDENTITY_FAILED` | Ningún proveedor reconoce el ID (p. ej., falta `TVDB_API_KEY`). |

Otros comandos útiles (cámbialos por la IP o el episodio que corresponda):

```bash
curl http://127.0.0.1:3000/health                                  # ¿está vivo el servidor?
curl http://127.0.0.1:3000/manifest.json                           # ¿responde el manifiesto?
curl http://127.0.0.1:3000/stream/series/tt7441658:1:1.json         # ¿hay streams para un episodio?
npm run live-check -- tt7441658:1:1                                 # verificación real (muestra enlaces)
```

<details>
<summary><b>❌ <code>Error: listen EADDRINUSE: address already in use 0.0.0.0:3000</code></b></summary>

El puerto 3000 ya está ocupado, normalmente por **otra copia de JKAnimeNuvio** que sigue
abierta.

- **Termux / Linux / macOS:** detén la otra copia con
  ```bash
  pkill -f "node index.js"
  ```
  O inicia en otro puerto: `PORT=3001 npm start`. Recuerda usar `:3001` en la URL de Nuvio.
- **Linux / macOS:** para ver qué programa ocupa el puerto, usa `lsof -i :3000`.
- **Windows (PowerShell):**
  ```powershell
  netstat -ano | findstr :3000
  taskkill /PID NUMERO_DE_PID /F
  ```
  O usa otro puerto: `$env:PORT = "3001"; npm start`.

</details>

<details>
<summary><b>📭 Nuvio no muestra ningún stream de JKAnime</b></summary>

1. ¿Está el servidor encendido? Ejecuta `curl http://127.0.0.1:3000/health`.
2. ¿El addon aparece instalado en Nuvio con la URL correcta (IP y puerto)?
3. Mira el **motivo** en la línea `no streams (…)` y búscalo en este apartado.
4. Ejecuta `npm run diagnose -- ID` (el ID aparece en esa misma línea).

Causas habituales:
- JKAnime no tiene ese anime o ese episodio todavía.
- La numeración no coincide; prueba otra [modalidad de temporadas](#temporadas).
- Ningún servidor de vídeo funcionó en ese momento.

> Un resultado vacío se guarda **1 o 2 minutos** para no saturar JKAnime, y una búsqueda sin
> resultados, 10 minutos. Espera un poco antes de reintentar. Para saber el motivo exacto, usa
> `npm run diagnose -- ID`.

</details>

<details>
<summary><b>🔍 <code>no metadata provider recognises {"imdb":"tt…"}</code>: IMDb no reconocido</b></summary>

Ninguna fuente activa conoce ese ID de IMDb. Es habitual en **animes recientes** que Cinemeta
todavía no tiene. Por ejemplo, Gensou Suikoden (`tt42938834`): Cinemeta responde vacío, pero
TVDB sí lo conoce.

- Configura `TVDB_API_KEY`, y si es posible también TMDB, en `.env`, y reinicia.
- El paréntesis `(enabled: …)` del mensaje indica qué fuentes estaban activas.
- JKAnimeNuvio **nunca adivina** un anime sin una correspondencia verificable: prefiere no
  devolver nada a mostrar el anime equivocado.

</details>

<details>
<summary><b>🔑 Errores de autenticación de TMDB o TVDB</b></summary>

Verás líneas como:

```text
[metadata] TMDB tt…: authentication failed (check credentials)
[metadata] TVDB tt…: authentication failed (check credentials)
```

- Revisa `.env`: el valor completo, sin espacios ni comillas y en la variable correcta. El token
  largo de TMDB va en `TMDB_API_READ_TOKEN`; la clave corta, en `TMDB_API_KEY`.
- Si tu clave de TVDB requiere PIN, rellena `TVDB_SUBSCRIBER_PIN`.
- **Reinicia** después de editar `.env`.
- Ejecuta `npm run live-check` y comprueba que la variable aparece como `configured`.

Mientras tanto, las demás fuentes siguen funcionando.

</details>

<details>
<summary><b>☁️ <code>BlockedError: Blocked by an anti-bot challenge (Cloudflare)</code></b></summary>

JKAnime está detrás de Cloudflare, que bloquea muchas conexiones de **VPN, proxies y servidores
en la nube**.

- Ejecuta JKAnimeNuvio desde tu conexión normal de casa o desde los datos móviles, sin VPN.
- JKAnimeNuvio **no intenta saltarse** esta protección. Si tu conexión está bloqueada, no podrá
  obtener enlaces desde ella.

</details>

<details>
<summary><b>🎞️ Un servidor de vídeo dejó de funcionar (por ejemplo, Filemoon)</b></summary>

Los servidores de vídeo cambian sus páginas con frecuencia. Cuando un servidor no da enlace,
verás una línea con el motivo, por ejemplo:

```text
[streams] ao-ashi-season-2 ep 1 · Streamtape: HTTP_404 — HTTP 404: el servidor no encontró el vídeo o la página (eliminado o ruta cambiada)
[streams] ao-ashi-season-2 ep 1 · Filemoon: UNSUPPORTED_FORMAT — formato del servidor no compatible con este extractor
```

y ese servidor simplemente no aparece en la lista. Los demás siguen apareciendo. **El anime sí se
identificó**: estos códigos nunca son un fallo de identificación.

| Código | Qué significa |
|---|---|
| `HTTP_404` | El servidor no encontró el vídeo **o** la página (puede estar eliminado o haber cambiado de dirección). |
| `HTTP_410` | El servidor indica que el vídeo ya no existe. |
| `HTTP_419` / `HTTP_429` | Sesión rechazada / demasiadas peticiones. Suele ser temporal. |
| `HTTP_5XX` | Error interno del servidor de vídeo. |
| `TIMEOUT` | Sin respuesta a tiempo (`EXTRACT_TIMEOUT_MS`); la petición se cancela. |
| `BLOCKED` | Desafío anti-bots (Cloudflare). |
| `PARSER_CHANGED` | La página cargó pero no tiene el formato esperado: el reproductor cambió. |
| `UNSUPPORTED_FORMAT` | El servidor responde en un formato que el extractor no implementa. |
| `INVALID_MEDIA_URL` | Se obtuvo algo, pero no es un MP4/HLS directo. |
| `NO_MEDIA` | El servidor dice que el vídeo no está disponible. |
| `EXTRACTOR_ERROR` | Error inesperado del extractor. |

- **Filemoon** obtiene el vídeo desde la propia API de su reproductor (cifrado AES-GCM). Desde
  esta versión se elige AES-128, 192 o 256 según la longitud de la clave, como la implementación
  de referencia; antes solo se aceptaba AES-256 y aparecía `Invalid key length`. Si Filemoon usa
  otro formato, verás `UNSUPPORTED_FORMAT` solo en ese servidor.
- Si un servidor falla siempre, abre un *issue* en GitHub con el nombre del servidor y el
  episodio. **No** incluyas tus credenciales ni tu archivo `.env`.

</details>

<details>
<summary><b>⏱️ El vídeo empieza y luego falla, o el enlace "caducó"</b></summary>

Los enlaces de los servidores de vídeo son **temporales**.

- JKAnimeNuvio guarda la lista de enlaces **10 minutos como máximo**, y menos cuando un enlace
  declara que caduca antes (parámetros `expires`, `X-Amz-Expires` o `s`+`e`): nunca se sirve de
  la caché un enlace a punto de caducar. Nuvio puede guardar la lista en su propia caché.
- Si un enlace caducó, **cierra y vuelve a abrir el episodio** pasados unos minutos, o
  **reinicia JKAnimeNuvio** (Ctrl + C y `npm start`) para vaciar su caché.
- Prueba otro servidor de la lista.

</details>

<details>
<summary><b>🔢 <code>HTTP 419</code> de JKAnime en los registros</b></summary>

Verás una línea como `[jkanime] episode count unavailable for SLUG: HTTP_419`.

JKAnime es una aplicación Laravel: esa consulta interna (la que su propia web usa para paginar los
episodios) exige el token de la ficha **y** la cookie de sesión que la acompaña; sin ella responde
419. Desde esta versión, JKAnimeNuvio reenvía en esa consulta las cookies que la ficha acaba de
fijar, como haría el navegador (sin guardarlas). **Esta corrección no se ha podido comprobar contra
JKAnime**: si el 419 persiste, el efecto es el de antes.

Solo se usa para **contar los episodios** cuando la ficha no muestra el total. **No impide
encontrar episodios.** No necesitas hacer nada.

</details>

<details>
<summary><b>📦 Problemas al instalar las dependencias (<code>npm ci</code>)</b></summary>

- **Node.js demasiado antiguo:** `node -v` debe mostrar v22 o superior.
- **Termux:** ejecuta `pkg update && pkg upgrade -y` y vuelve a intentarlo.
- **Instalación a medias:** borra la carpeta de dependencias y repite:
  - Termux, Linux y macOS: `rm -rf node_modules && npm ci --omit=dev`
  - Windows: `Remove-Item -Recurse -Force node_modules; npm ci --omit=dev`
- **Windows:** si ves *"la ejecución de scripts está deshabilitada"*, consulta la
  [nota de Windows](#pc).
- **Errores de red:** revisa tu conexión. Las descargas vienen de `registry.npmjs.org`.

</details>

<details>
<summary><b>📱 Android cierra Termux</b></summary>

Usa `termux-wake-lock`, desactiva la optimización de batería de Termux y no lo cierres desde
aplicaciones recientes (ver [Mantener el servidor funcionando](#mantener-servidor)).
Si aun así se cierra, vuelve a iniciar con `cd ~/JkAnimeNuvio && npm start`.

</details>

<a id="manifiesto-inaccesible"></a>

<details>
<summary><b>🌐 Manifiesto inaccesible desde otro dispositivo</b></summary>

- Usa la **IP local** del servidor, **no** `127.0.0.1`.
- Ambos dispositivos deben estar en **la misma red Wi‑Fi**. Las redes de invitados suelen
  aislar los dispositivos entre sí.
- **Windows:** permite Node.js en el Firewall de Windows para redes privadas.
- **Linux:** si usas un cortafuegos (`ufw`, `firewalld`), abre el puerto 3000.
- No pongas `HOST=127.0.0.1` en `.env`: así solo acepta conexiones del mismo dispositivo.
- Prueba primero en el navegador del otro dispositivo: `http://IP:3000/health`.

</details>

---

<a id="pruebas"></a>

## 🧪 Pruebas y verificación

JKAnimeNuvio incluye dos tipos de comprobaciones. **No son lo mismo**:

| | `npm test` | `npm run live-check` |
|---|---|---|
| **Tipo** | 🧪 Pruebas **simuladas** | 🌐 Verificación **real** |
| **Usa Internet** | No | Sí: JKAnime, TMDB, TVDB, AniList… |
| **Necesita credenciales** | No (usa claves ficticias) | Usa las de tu `.env` (si las hay) |
| **Para qué sirve** | Comprobar que el código funciona como se espera | Comprobar que **tu instalación** encuentra anime y enlaces reales |

### Pruebas automatizadas (simuladas)

```bash
npm test
```

Ejecuta 145 pruebas en unos segundos, sin conexión. Entre otros casos, cubren:
- Una matriz de identificación: Ao Ashi T1 y T2, Rich Girl Caretaker, Koori no Jouheki T1 y T2,
  Black Clover, Gensou Suikoden, remakes, títulos muy parecidos, OVAs, películas y episodios
  inexistentes.
- Seguridad HTTP: redirecciones hacia la red interna, IPv6 especiales, DNS, respuestas enormes,
  tiempos límite y registros sin credenciales.
- El HTML real de JKAnime (búsqueda, ficha y episodio, archivados en 2026).
- Errores de autenticación, fuentes caídas y formato de los streams para Nuvio.

Todas deben terminar en `fail 0`. Se ejecutan también automáticamente en GitHub Actions con
Node.js 22 y 24.

Los datos de prueba combinan:
- **Copias reales** de respuestas de Cinemeta, AniList, Kitsu, yuna y ani.zip, y páginas reales de
  JKAnime archivadas en web.archive.org.
- **Datos sintéticos**, claramente marcados, para TMDB, TVDB, el resto de páginas de JKAnime y los
  servidores de vídeo. **Que una prueba simulada pase no confirma cómo responde JKAnime hoy.**

Banco de evaluación (compara la identificación de dos versiones del código en la red simulada):

```bash
git worktree add ../jk-old main && (cd ../jk-old && npm ci)
node scripts/evaluate.js --old ../jk-old
```

Resultados en [`docs/EVALUACION.md`](docs/EVALUACION.md).

### Verificación real

```bash
npm run live-check
```

Por defecto comprueba Black Clover (T1 E1 y T2 E1) y Gensou Suikoden por IMDb y por AniList.
Puedes indicar otros IDs:

```bash
npm run live-check -- tt7441658:1:1 tt42938834:1:1 anilist:187316:1
```

Qué verás:
- `Providers: TMDB_API_READ_TOKEN=configured TVDB_API_KEY=not set …`: qué credenciales están
  activas, **nunca sus valores**.
- `OK   identity: {…}`: cómo se identificó el anime y con qué evidencias.
- `OK   resolve: {"slug":"black-clover-tv","episode":1,…}`: la entrada y el episodio de JKAnime
  elegidos.
- `OK   streams: […]`: los enlaces encontrados, uno por servidor.
- `FAIL …`: qué falló y por qué.

> [!WARNING]
> `live-check` muestra enlaces de vídeo reales y temporales. No es necesario compartir su salida
> completa al pedir ayuda: basta con las líneas `FAIL`.

| Ejemplo | Resultado esperado |
|---|---|
| `tt7441658:1:1` | `black-clover-tv`, episodio 1 |
| `tt7441658:2:1` | La entrada de la temporada 2026 de Black Clover, episodio 1 |
| `anilist:187316:1` | `gensou-suikoden`, episodio 1 |
| `tt42938834:1:1` | `gensou-suikoden`, episodio 1 **con `TVDB_API_KEY`**. Sin credenciales: *"no metadata provider recognises"* |

---

<a id="faq"></a>

## ❓ Preguntas frecuentes

<details>
<summary><b>¿JKAnimeNuvio es gratuito?</b></summary>

Sí. Es software libre con licencia MIT. Las credenciales de TMDB son gratuitas para uso
personal; las condiciones de TVDB dependen del tipo de clave (consulta su
[página de la API](https://thetvdb.com/api-information)).
</details>

<details>
<summary><b>¿Necesito una computadora?</b></summary>

No. Puedes hacerlo todo desde el teléfono Android con Termux.
</details>

<details>
<summary><b>¿Puedo utilizarlo solamente con Android?</b></summary>

Sí. La forma más sencilla es ejecutar el servidor en Termux y usar Nuvio en el mismo teléfono con
`http://127.0.0.1:3000/manifest.json`.
</details>

<details>
<summary><b>¿Necesito TMDB y TVDB?</b></summary>

No son obligatorias, pero sí recomendables. Sin ellas funciona con los animes que Cinemeta conoce
y con IDs de AniList, MAL y Kitsu. Para animes muy recientes (que Cinemeta aún no tiene) y para
elegir la numeración de TMDB o TVDB, sí las necesitas. Ver
[¿Para qué sirven?](#para-que-credenciales).
</details>

<details>
<summary><b>¿Por qué algunos animes no aparecen?</b></summary>

Puede deberse a cuatro motivos:
- JKAnime no lo tiene.
- Ninguna fuente pudo identificarlo con seguridad.
- La numeración de temporadas no coincide.
- Hay dudas entre dos entradas parecidas.

En todos los casos JKAnimeNuvio prefiere no mostrar nada antes que un anime equivocado.
Diagnóstico: [Nuvio no muestra ningún stream](#problemas).
</details>

<details>
<summary><b>¿Por qué algunos servidores no reproducen?</b></summary>

Cada servidor de vídeo funciona a su manera y cambia con frecuencia. Además, los enlaces son
temporales. Si uno falla, prueba otro de la lista o vuelve a abrir el episodio pasados unos
minutos.
</details>

<details>
<summary><b>¿Necesito mantener Termux abierto?</b></summary>

Sí. JKAnimeNuvio solo funciona mientras el servidor se está ejecutando. Puedes salir de Termux a
Nuvio sin problema, pero si Android cierra Termux, el addon deja de responder hasta que lo
vuelvas a iniciar.
</details>

<details>
<summary><b>¿Puedo utilizarlo desde otro dispositivo?</b></summary>

Sí, dentro de tu misma red Wi‑Fi, usando la IP local del dispositivo donde corre el servidor
(ver [Elige la dirección correcta](#direccion)). No lo expongas a Internet:
no tiene contraseña ni HTTPS.
</details>

<details>
<summary><b>¿Puedo instalarlo en Stremio?</b></summary>

Usa el mismo protocolo de addons, así que debería funcionar en clientes compatibles. En Stremio
de escritorio, pega la URL del manifiesto en la búsqueda de addons. Algunos clientes exigen HTTPS
para direcciones que no sean `127.0.0.1`. El proyecto está pensado y probado principalmente para
Nuvio.
</details>

<details>
<summary><b>¿Por qué no aparecen catálogos de JKAnime?</b></summary>

Es intencionado: JKAnimeNuvio es **solo de streams**. Las fichas, portadas y listas de episodios
las aporta tu addon de metadatos (Cinemeta, TMDB…), y JKAnimeNuvio solo añade los enlaces de
reproducción.
</details>

---

<a id="desarrolladores"></a>

## 🧑‍💻 Para desarrolladores

<details>
<summary><b>Rutas HTTP, estructura y reglas de identificación</b></summary>

**Rutas**

| Ruta | Respuesta |
|---|---|
| `GET /manifest.json`, `GET /{config}/manifest.json` | Manifiesto (`resources: [stream]`, `catalogs: []`) |
| `GET /stream/{type}/{id}.json` (opcionalmente con `{config}/` delante) | `{ "streams": [...] }` |
| `GET /health` | `{ "ok": true }` |
| `GET /` | Página con la URL de instalación |

**IDs admitidos:** `tt…:T:E`, `tmdb:ID:T:E`, `tvdb:ID:T:E`, `kitsu:ID:E`, `mal:ID:E`,
`anilist:ID:E`, y películas `tt…` / `tmdb:ID`.

**Estructura**

```text
index.js                        Arranque: lee .env e inicia el servidor
lib/
├── app.js                      Servidor HTTP (Express): rutas, CORS y caché de respuestas
├── stremio/                    Protocolo de addons de Stremio
│   ├── manifest.js             Manifiesto stream-only (resources: [stream], catalogs: [])
│   └── streams.js              Objetos stream (MP4/HLS, cabeceras, orden, sin duplicados)
├── identification/             Identificación de anime
│   ├── identity.js             Identidad desde TMDB / TVDB / Cinemeta + verificación de AniList
│   ├── resolver.js             ID → entrada y episodio de JKAnime (temporadas y numeraciones)
│   ├── queries.js              Plan de búsqueda por etapas (títulos, alternativos, variantes, fragmentos)
│   ├── titles.js               Normalización, romanización, marcadores de temporada y año
│   └── episodes.js             IDs de Stremio y numeración absoluta
├── providers/                  Proveedores de metadatos internos (solo para identificar)
│   └── tmdb, tvdb, anilist, kitsu, cinemeta, relations (yuna, ani.zip), common
├── jkanime/                    JKAnime: única fuente de vídeo
│   ├── site.js                 Búsqueda, ficha y página de episodio
│   └── extractors.js           Servidores de vídeo → enlaces MP4/HLS
└── utils/
    ├── cache.js                Caché TTL con deduplicación y duración según el contenido
    ├── http.js                 HTTP seguro: redirecciones validadas, DNS, tamaño, timeouts, límites
    ├── ip.js                   Rangos IP internos y especiales (IPv4/IPv6)
    ├── errors.js               Códigos de error comunes
    ├── expiry.js               Caducidad declarada de enlaces firmados
    ├── context.js              Cancelación y traza por petición (AsyncLocalStorage)
    └── limiter.js              Límite de concurrencia
test/                           Pruebas (node:test) y datos de prueba (fixtures/)
test-support/                   Red simulada (helpers.js) y casos del banco de evaluación
scripts/diagnose.js             Diagnóstico paso a paso de un ID (npm run diagnose)
scripts/evaluate.js             Banco de evaluación: código antiguo frente al nuevo
scripts/live-check.js           Verificación real contra los servicios
docs/AUDITORIA.md               Auditoría técnica (hallazgos, evidencia, riesgo)
```

**Reglas de identificación**

- Solo cuenta el índice de IMDb **del propio proveedor**: `/find` de TMDB, remote ids de TVDB y
  Cinemeta. Primero se consulta TMDB; TVDB, si TMDB no da una respuesta fiable.
- Si dos proveedores se contradicen, se descarta el de menor prioridad
  (TMDB > TVDB > Cinemeta). Si un proveedor devuelve varios resultados, se ignora.
- Las bases de relaciones (yuna, ani.zip) solo **proponen** ids. Un enlace con AniList se acepta
  si cumple tres condiciones:
  1. formato compatible;
  2. título coincidente;
  3. año coincidente, o confirmación de una segunda base.

  Caso real: ambas bases asignan Black Clover (`tt7441658`) a AniList 87528, un especial de
  2016. El addon lo rechaza.
- Para `kitsu:`/`mal:`/`anilist:`, cada enlace con otra base tiene un nivel de evidencia:
  **confirmado** (formato y año coinciden), **probable** (falta un año, pero los títulos coinciden
  y lo declaran dos fuentes), **contradictorio** (formato, año o temporada distintos; rechazado).
  **La falta de año nunca cuenta como coincidencia.**
- La búsqueda en JKAnime va por etapas y se detiene en cuanto una entrada queda verificada:
  títulos propios → alternativos verificados → variantes de romanización (`Jyouheki`/`Jouheki`)
  → fragmentos distintivos de los títulos largos (`saijo no osewa`, `rich girl caretaker`).
- Una entrada de JKAnime se acepta solo si el título completo coincide (con sus marcadores de
  temporada, parte y formato) **y** el año de su ficha coincide. Si solo coincide el nombre
  principal, además debe coincidir el año exacto, el formato y ser el único candidato. Sin año
  en la ficha, no se acepta. Un año entre paréntesis en el título (`Fruits Basket (2019)`)
  distingue los remakes.
- Ante ambigüedad, el resultado es `streams: []`: **es preferible no mostrar nada que reproducir
  un episodio de otro anime.**

</details>

---

<a id="creditos"></a>

## 🙏 Créditos, licencia y avisos

### Créditos

- **Proyecto original:**
  [animeflv-stremio-addon](https://github.com/Pigamer37/animeflv-stremio-addon), de
  **Pigamer37 (Lucas Gómez, KB)**. JKAnimeNuvio parte de su código y conserva su licencia MIT.
- **Código adaptado a través del proyecto original:**
  - [mediaflow-proxy](https://github.com/mhdzumair/mediaflow-proxy): extracción de Filemoon,
    Mixdrop, OK.ru y Streamwish.
  - [anime1v-api](https://github.com/FxxMorgan/anime1v-api): patrones de VOE y Vidhide.
  - [animeflv-api](https://github.com/ahmedrangel/animeflv-api): lectura de páginas de episodio.
  - [Streamtape-Video-Downloader](https://github.com/ChristopherProject/Streamtape-Video-Downloader).
- **Fuentes de identificación:** [TMDB](https://www.themoviedb.org/),
  [TheTVDB](https://thetvdb.com/), [AniList](https://anilist.co),
  [MyAnimeList](https://myanimelist.net), [Kitsu](https://kitsu.io), Cinemeta, yuna (relations.yuna.moe) y ani.zip.
- **Mantenimiento de JKAnimeNuvio:** [Eibyx](https://github.com/Eibyx).

### Licencia

Distribuido bajo la [licencia MIT](LICENSE). El aviso de copyright original
(*Copyright (c) 2024 Lucas Gómez (KB)*) se conserva en el archivo `LICENSE`, como exige la
licencia.

### Avisos

> [!NOTE]
> - **JKAnimeNuvio no está afiliado** con JKAnime, Nuvio, Stremio, TMDB, TheTVDB, AniList,
>   MyAnimeList ni Kitsu, ni ha sido aprobado o respaldado por ninguno de ellos.
> - *This product uses the TMDB API but is not endorsed or certified by TMDB.*
> - Los metadatos de TVDB son proporcionados por TheTVDB. Consulta sus
>   [condiciones de uso](https://thetvdb.com/api-information).
> - JKAnimeNuvio **no aloja ni distribuye vídeos**: solo localiza enlaces que JKAnime ya publica.
>   Cada usuario es responsable de cumplir la legislación de su país.
> - El proyecto es **self-hosted** por diseño: no existe ni se ofrece un servidor público.
