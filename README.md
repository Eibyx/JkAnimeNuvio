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
- Usa JKAnime como única fuente de vídeo. Cinemeta, AniList, Kitsu y (opcionalmente)
  TMDB se consultan solo para **identificar** el anime y el episodio que pide el cliente.
- Devuelve solo URLs `http(s)` directas a `.mp4` o `.m3u8` (más Pixeldrain y Streamtape,
  que sirven el archivo sin extensión). Nunca devuelve `externalUrl` ni páginas embed.

## Instalación

```bash
npm ci
npm test
PORT=3000 npm start
```

Instala en Nuvio o Stremio con `https://<tu-servidor>/manifest.json`.

Nuvio, en Android o iOS, necesita una URL accesible desde el dispositivo (HTTPS público o
una IP de tu red local). El servidor debe poder acceder a jkanime.net: JKAnime responde con
un desafío de Cloudflare a muchas IPs de centros de datos, y en ese caso el addon devuelve
`{"streams": []}`.

## IDs admitidos

| ID | Ejemplo | Numeración |
|---|---|---|
| IMDb (Cinemeta) | `tt7441658:2:1` | Temporadas de Cinemeta |
| IMDb con TMDB | `/numbering=tmdb/manifest.json` + `tt7441658:2:1` | Temporadas de TMDB (requiere `TMDB_API_READ_TOKEN`) |
| TMDB | `tmdb:73223:2:1` | Temporadas de TMDB (requiere `TMDB_API_READ_TOKEN`) |
| Kitsu | `kitsu:13209:5` | Episodio de esa entrada de Kitsu |
| MyAnimeList / AniList | `mal:34572:5`, `anilist:97940:5` | Episodio de esa entrada |
| Película IMDb | `tt…` (tipo `movie`) | — |

## Cómo se identifica el episodio

1. **Metadatos del ID.** Se obtienen el nombre y la estructura de temporadas: número de
   episodios y año de inicio de cada temporada.
2. **Títulos alternativos.** AniList aporta los títulos romaji, inglés y sinónimos (solo
   los de alfabeto latino) de la entrada que se emitió el mismo año que la temporada
   pedida. Así se encuentran nombres como "Black Clover 2nd Season" o "Shingeki no Kyojin".
3. **Búsqueda en JKAnime.** Se busca con esos títulos y cada resultado se puntúa con
   coeficiente de Dice sobre el nombre normalizado. Los marcadores de temporada, parte,
   película, OVA o especial deben coincidir. Los números que forman parte del nombre
   ("Kaiju No. 8", "Mob Psycho 100") no se interpretan como temporada.
4. **Verificación.** Se abre la ficha del candidato en JKAnime y se comprueba el año de
   emisión (±1), el tipo y el número de episodios. Si dos candidatos empatan, no se
   devuelve nada.
5. **Numeración continua.** Si JKAnime no tiene una entrada propia para la temporada N,
   se prueba la entrada principal con el número absoluto (suma de las temporadas
   anteriores + episodio), siempre que la ficha tenga suficientes episodios.
6. **Página del episodio.** Si JKAnime redirige a la ficha o muestra otro número de
   episodio, no se devuelve ningún stream.

Las temporadas 0 (especiales y OVAs) no se asignan.

### Black Clover (`tt7441658`)

Datos reales de Cinemeta (13‑10‑2026): T1 = 170 episodios (2017‑2021), T2 = 13 episodios
desde el 03‑10‑2026 y T0 = 19 especiales. TMDB divide los 170 episodios en 4 temporadas
(51/51/52/16).

| Petición | Resultado |
|---|---|
| `tt7441658:1:1` … `:1:170` | `black-clover-tv` ep. 1…170 |
| `tt7441658:2:1` (Cinemeta) | entrada de la 2.ª temporada (2026), ep. 1. **Nunca** `black-clover-tv/1` ni `/171` |
| `tt7441658:2:1` sin entrada 2026 en JKAnime | vacío (171 > 170) |
| `tt7441658:2:1` con `numbering=tmdb` | `black-clover-tv` ep. 52 |
| `tt7441658:0:N` | vacío |

Los slugs exactos de JKAnime (`black-clover-tv`, etc.) **no se han podido comprobar** en
directo; en las pruebas se usan HTML sintéticos.

## Servidores

Servidor propio de JKAnime (`jkplayer`), YourUpload, MP4Upload, Streamwish, Vidhide o
Filelions, VOE, Filemoon, Mixdrop, Streamtape, Pixeldrain y OK.ru. Los demás (Mega,
Doodstream…) se omiten. Cada stream incluye `behaviorHints.proxyHeaders.request` con
`Referer` y `User-Agent`, y `notWebReady: true`.

Las URLs de los embeds proceden de HTML de terceros. Por eso solo se aceptan destinos
`http(s)` públicos: se rechazan localhost, IPs privadas y credenciales en la URL.

## Pruebas

- `npm test`: pruebas **sin red** (`node:test`). Los datos de Cinemeta y AniList son
  copias recortadas de respuestas reales. El HTML de JKAnime y de los servidores es
  **sintético**.
- `npm run live-check [-- tt7441658:2:1 …]`: comprobación **real** contra Cinemeta, AniList
  y JKAnime. Muestra los errores tal cual, por ejemplo el bloqueo de Cloudflare.

## Variables de entorno

Consulta [`.env.example`](.env.example). Ninguna es obligatoria.

## Despliegue

`.github/workflows/deploy.yml` solo se ejecuta manualmente (`workflow_dispatch`). Al hacer
push o merge a `main` no se despliega nada.
