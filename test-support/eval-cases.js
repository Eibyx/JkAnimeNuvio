/**
 * Identification cases for scripts/evaluate.js (old vs new code) on the
 * offline fake network. Metadata answers are real fixtures; JKAnime entries
 * are the real titles where known (see test/cases.test.js) and plausible
 * spellings otherwise. expect: "slug#episode", or null when the right
 * answer is "no stream". family: slug prefix of the show, to tell a season
 * confusion from an unrelated false positive.
 */
const { DEFAULT_ANIME } = require("./helpers")

const KOORI = {
  "koori-no-jouheki": { title: "Koori no Jouheki", alt: "The Ramparts of Ice", type: "Serie", emitted: "Jueves, 02 de Abril de 2026", episodes: 14, status: "Concluido" },
  "koori-no-jouheki-2nd-season": { title: "Koori no Jouheki 2nd Season", type: "Serie", emitted: "Jueves, 01 de Octubre de 2026", episodes: 2, status: "En emision" },
}
const KOORI_S1 = { "koori-no-jouheki": KOORI["koori-no-jouheki"] }
const KOORI_CINEMETA = { "series/tt39123061": require("../test/fixtures/cinemeta-koori.json") }
const RICH = { type: "Serie", emitted: "Sábado, 04 de Julio de 2026", episodes: 12, status: "Concluido" }
const withAnime = (extra) => ({ ...DEFAULT_ANIME, ...extra })
const FRUITS = {
  "fruits-basket": { title: "Fruits Basket", type: "Serie", emitted: "", episodes: 26, status: "Concluido" },
  "fruits-basket-2019": { title: "Fruits Basket (2019)", type: "Serie", emitted: "Abr 6 de 2019", episodes: 25, status: "Concluido" },
}
const kitsuEntry = (id, e) => ({ key: `kitsu:${id}`, value: { source: "kitsu", id: String(id), ...e } })

module.exports = [
  { name: "Ao Ashi T1", id: "kitsu:44629:1", expect: "ao-ashi#1", family: "ao-ashi" },
  { name: "Ao Ashi T1 E25 (no existe)", id: "kitsu:44629:25", expect: null, family: "ao-ashi" },
  { name: "Ao Ashi T2E1", id: "kitsu:49883:1", expect: "ao-ashi-season-2#1", family: "ao-ashi" },
  { name: "Ao Ashi T2E2", id: "kitsu:49883:2", expect: "ao-ashi-season-2#2", family: "ao-ashi" },
  { name: "Ao Ashi T2E1 (AniList)", id: "anilist:191788:1", expect: "ao-ashi-season-2#1", family: "ao-ashi" },
  { name: "Ao Ashi T2 sin entrada T2", id: "kitsu:49883:1", expect: null, family: "ao-ashi", net: { anime: Object.fromEntries(Object.entries(DEFAULT_ANIME).filter(([k]) => k !== "ao-ashi-season-2")) } },
  { name: "Rich Girl Caretaker («Saijo no Osewa»)", id: "kitsu:50761:1", expect: "saijo-no-osewa#1", net: { anime: withAnime({ "saijo-no-osewa": { ...RICH, title: "Saijo no Osewa" } }) } },
  { name: "Rich Girl Caretaker («Rich Girl Caretaker»)", id: "kitsu:50761:1", expect: "rich-girl-caretaker#1", net: { anime: withAnime({ "rich-girl-caretaker": { ...RICH, title: "Rich Girl Caretaker" } }) } },
  { name: "Rich Girl Caretaker (romaji completo)", id: "kitsu:50761:1", expect: "saijo-no-osewa-takane#1", net: { anime: withAnime({ "saijo-no-osewa-takane": { ...RICH, title: "Saijo no Osewa: Takane no Hana-darake na Meimonkou de, Gakuin Ichi no Ojou-sama (Seikatsu Nouryoku Kaimu) o Kagenagara Osewa Suru Koto ni Narimashita" } }) } },
  { name: "«Saijo no Osewa» de otro año", id: "kitsu:50761:1", expect: null, net: { anime: withAnime({ "saijo-no-osewa": { ...RICH, title: "Saijo no Osewa", emitted: "Abr 3 de 2025" } }) } },
  { name: "Koori no Jouheki T2 (Kitsu)", id: "kitsu:50827:1", expect: "koori-no-jouheki-2nd-season#1", family: "koori-no-jouheki", net: { anime: withAnime(KOORI) } },
  { name: "Koori no Jouheki T2 sin entrada T2", id: "kitsu:50827:1", expect: null, family: "koori-no-jouheki", net: { anime: withAnime(KOORI_S1) } },
  { name: "Koori no Jouheki T1 (IMDb, «Jyouheki»)", id: "tt39123061:1:1", expect: "koori-no-jouheki#1", family: "koori-no-jouheki", net: { anime: withAnime(KOORI), cinemeta: KOORI_CINEMETA } },
  { name: "Koori no Jouheki T2 (IMDb)", id: "tt39123061:2:1", expect: "koori-no-jouheki-2nd-season#1", family: "koori-no-jouheki", net: { anime: withAnime(KOORI), cinemeta: KOORI_CINEMETA } },
  { name: "Koori no Jouheki T2 (IMDb) sin entrada T2", id: "tt39123061:2:1", expect: null, family: "koori-no-jouheki", net: { anime: withAnime(KOORI_S1), cinemeta: KOORI_CINEMETA } },
  { name: "Black Clover T1E1", id: "tt7441658:1:1", expect: "black-clover-tv#1", family: "black-clover" },
  { name: "Black Clover T1E170", id: "tt7441658:1:170", expect: "black-clover-tv#170", family: "black-clover" },
  { name: "Black Clover T2E1", id: "tt7441658:2:1", expect: "black-clover-2nd-season#1", family: "black-clover" },
  { name: "Gensou Suikoden (AniList)", id: "anilist:187316:1", expect: "gensou-suikoden#1" },
  { name: "Remake 2019, ficha 2001 sin año", id: "kitsu:900:1", expect: "fruits-basket-2019#1", family: "fruits-basket", net: { anime: withAnime(FRUITS) }, entry: kitsuEntry(900, { format: "TV", episodes: 25, startYear: 2019, titles: ["Fruits Basket"] }) },
  { name: "Remake: solo la ficha sin año", id: "kitsu:900:1", expect: null, family: "fruits-basket", net: { anime: withAnime({ "fruits-basket": FRUITS["fruits-basket"] }) }, entry: kitsuEntry(900, { format: "TV", episodes: 25, startYear: 2019, titles: ["Fruits Basket"] }) },
  { name: "Títulos muy parecidos", id: "kitsu:904:1", expect: null, net: { anime: withAnime({ "ore-no-imouto": { title: "Ore no Imouto", type: "Serie", emitted: "Oct 3 de 2010", episodes: 12, status: "Concluido" } }) }, entry: kitsuEntry(904, { format: "TV", episodes: 12, startYear: 2010, titles: ["Ore no Imouto ga Konna ni Kawaii Wake ga Nai"] }) },
  { name: "Primer cour (12) en entrada continua (25)", id: "kitsu:905:1", expect: "spy-x-family#1", net: { anime: withAnime({ "spy-x-family": { title: "Spy x Family", type: "Serie", emitted: "Abr 9 de 2022", episodes: 25, status: "Concluido" } }) }, entry: kitsuEntry(905, { format: "TV", episodes: 12, startYear: 2022, titles: ["Spy x Family"] }) },
  { name: "Otra parte de la franquicia (coincidencia parcial)", id: "kitsu:906:1", expect: null, net: { anime: withAnime({ "jojo-no-kimyou-na-bouken-stardust-crusaders": { title: "JoJo no Kimyou na Bouken: Stardust Crusaders", type: "Serie", emitted: "Abr 5 de 2014", episodes: 48, status: "Concluido" } }) }, entry: kitsuEntry(906, { format: "TV", episodes: 24, startYear: 2014, titles: ["JoJo no Kimyou na Bouken: Egypt-hen"] }) },
]
