# Evaluación de la identificación: v0.2.1 frente a esta rama

Generado con `node scripts/evaluate.js --old <copia de main en 0f106cc>` (2026-10-13).

> [!IMPORTANT]
> **Red simulada.** Las respuestas de Kitsu, AniList, yuna, ani.zip y Cinemeta son copias reales;
> las de JKAnime son los títulos reales donde se conocen (*Ao Ashi*, *Ao Ashi Season 2*, *Koori no
> Jouheki*, *Black Clover (TV)*) y variantes plausibles donde no (*Rich Girl Caretaker*, segunda
> temporada de *Koori no Jouheki*). El buscador simulado es literal (todas las palabras deben
> aparecer en el título), el caso más exigente. Estas cifras miden la lógica de identificación,
> **no** confirman cómo responde JKAnime hoy ni la reproducción en Nuvio.

- *old*: `main` (v0.2.1). *new*: esta rama.
- «MISMA SERIE, ENTRADA O EPISODIO EQUIVOCADO»: se habría servido otra temporada, el original en
  lugar del *remake*, o un episodio que no existe. En v0.2.1, el caso `kitsu:44629:25` se habría
  detenido después en la página del episodio (JKAnime redirige), pero el resolvedor ya lo daba por
  bueno.
- Las peticiones y búsquedas son las de toda la batería.

| Caso | Esperado | old | new |
|---|---|---|---|
| Ao Ashi T1 (`kitsu:44629:1`) | ao-ashi#1 | OK | OK |
| Ao Ashi T1 E25 (no existe) (`kitsu:44629:25`) | ninguno | MISMA SERIE, ENTRADA O EPISODIO EQUIVOCADO → ao-ashi#25 | OK |
| Ao Ashi T2E1 (`kitsu:49883:1`) | ao-ashi-season-2#1 | OK | OK |
| Ao Ashi T2E2 (`kitsu:49883:2`) | ao-ashi-season-2#2 | OK | OK |
| Ao Ashi T2E1 (AniList) (`anilist:191788:1`) | ao-ashi-season-2#1 | OK | OK |
| Ao Ashi T2 sin entrada T2 (`kitsu:49883:1`) | ninguno | OK | OK |
| Rich Girl Caretaker («Saijo no Osewa») (`kitsu:50761:1`) | saijo-no-osewa#1 | SIN RESULTADO | OK |
| Rich Girl Caretaker («Rich Girl Caretaker») (`kitsu:50761:1`) | rich-girl-caretaker#1 | SIN RESULTADO | OK |
| Rich Girl Caretaker (romaji completo) (`kitsu:50761:1`) | saijo-no-osewa-takane#1 | OK | OK |
| «Saijo no Osewa» de otro año (`kitsu:50761:1`) | ninguno | OK | OK |
| Koori no Jouheki T2 (Kitsu) (`kitsu:50827:1`) | koori-no-jouheki-2nd-season#1 | OK | OK |
| Koori no Jouheki T2 sin entrada T2 (`kitsu:50827:1`) | ninguno | OK | OK |
| Koori no Jouheki T1 (IMDb, «Jyouheki») (`tt39123061:1:1`) | koori-no-jouheki#1 | SIN RESULTADO | OK |
| Koori no Jouheki T2 (IMDb) (`tt39123061:2:1`) | koori-no-jouheki-2nd-season#1 | SIN RESULTADO | OK |
| Koori no Jouheki T2 (IMDb) sin entrada T2 (`tt39123061:2:1`) | ninguno | OK | OK |
| Black Clover T1E1 (`tt7441658:1:1`) | black-clover-tv#1 | OK | OK |
| Black Clover T1E170 (`tt7441658:1:170`) | black-clover-tv#170 | OK | OK |
| Black Clover T2E1 (`tt7441658:2:1`) | black-clover-2nd-season#1 | OK | OK |
| Gensou Suikoden (AniList) (`anilist:187316:1`) | gensou-suikoden#1 | OK | OK |
| Remake 2019, ficha 2001 sin año (`kitsu:900:1`) | fruits-basket-2019#1 | MISMA SERIE, ENTRADA O EPISODIO EQUIVOCADO → fruits-basket#1 | OK |
| Remake: solo la ficha sin año (`kitsu:900:1`) | ninguno | MISMA SERIE, ENTRADA O EPISODIO EQUIVOCADO → fruits-basket#1 | OK |
| Títulos muy parecidos (`kitsu:904:1`) | ninguno | OK | OK |
| Primer cour (12) en entrada continua (25) (`kitsu:905:1`) | spy-x-family#1 | OK | OK |
| Otra parte de la franquicia (coincidencia parcial) (`kitsu:906:1`) | ninguno | OK | OK |

| Métrica | old | new |
|---|---|---|
| Correctos | 17 | 24 |
| Sin resultado (esperado uno) | 4 | 0 |
| Falsos positivos | 3 | 0 |
| …de ellos, misma serie con entrada/episodio equivocado | 3 | 0 |
| Búsquedas en JKAnime | 70 | 81 |
| Peticiones a JKAnime | 84 | 101 |
| Peticiones totales | 206 | 223 |
| Tiempo total (ms, red simulada) | 113.4 | 129.9 |

## Lectura

- **Exactitud:** 24/24 casos correctos frente a 17/24; **0 falsos positivos** frente a 3.
- **Coste:** unas pocas búsquedas más en los casos difíciles (fragmentos y variantes), siempre
  con el límite `JK_MAX_QUERIES` (8 por petición) y deteniéndose en cuanto una entrada queda
  verificada (Black Clover: 1 búsqueda).
- **Pendiente de verificar en real:** cómo titula JKAnime *Rich Girl Caretaker* y la segunda
  temporada de *Koori no Jouheki*; usa `npm run diagnose -- kitsu:50761:1` y
  `npm run diagnose -- kitsu:50827:1` desde Termux.
