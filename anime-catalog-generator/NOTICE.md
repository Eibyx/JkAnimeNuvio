# Atribuciones y licencias de terceros

Este proyecto **no redistribuye** los datasets de terceros: los descarga en tiempo de ejecución desde
sus publicaciones oficiales. Los fixtures de `tests/fixtures/` contienen extractos muy pequeños
(unas decenas de registros) usados exclusivamente para pruebas reproducibles.

| Proyecto | Uso | Licencia |
| --- | --- | --- |
| [anibridge/anibridge-mappings](https://github.com/anibridge/anibridge-mappings) | Fuente principal de mappings (release `v3`, `mappings.json`, schema 3.x) | MIT, © 2026 AniBridge |
| [Kometa-Team/Anime-IDs](https://github.com/Kometa-Team/Anime-IDs) | Segunda fuente (`anime_ids.json`, indexado por AniDB) | MIT, © 2026 meisnate12 |
| [Kometa-Team/Kometa](https://github.com/Kometa-Team/Kometa) | Referencia para el cliente de MDBList (`modules/mdblist.py`: endpoints, formato de payload, reintentos de creación de lista). Lógica adaptada, sin su sincronización destructiva. | MIT, © 2026 meisnate12 |
| [Fribb/anime-lists](https://github.com/Fribb/anime-lists) | Tercera fuente (`anime-list-full.json`) | Sin licencia declarada en el repositorio: se consume como dato público en tiempo de ejecución |
| [Anime-Lists/anime-lists](https://github.com/Anime-Lists/anime-lists) | Respaldo opcional (`anime-list-master.xml`), desactivado por defecto | Sin licencia declarada: se consume como dato público en tiempo de ejecución |
| [manami-project/anime-offline-database](https://github.com/manami-project/anime-offline-database), [notseteve/AnimeAggregations](https://github.com/notseteve/AnimeAggregations), [varoOP/shinkro-mapping](https://github.com/varoOP/shinkro-mapping) | No se descargan directamente: ya están incorporados en AniBridge (y parcialmente en Kometa/Fribb). Se registran como *procedencia* para no contar sus datos como confirmaciones independientes. | Ver cada proyecto |

APIs utilizadas: [AniList GraphQL](https://docs.anilist.co/), [Jikan v4](https://docs.api.jikan.moe/),
[TMDB API v3](https://developer.themoviedb.org/), [MDBList API](https://api.mdblist.com/docs/),
[TheTVDB v4](https://thetvdb.github.io/v4-api/) (opcional).
Este producto usa la API de TMDB pero no está respaldado ni certificado por TMDB.
