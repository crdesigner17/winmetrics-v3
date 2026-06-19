/**
 * WinMetrics V3 — WC Team Power Table
 * ─────────────────────────────────────────────────────────────────────────────
 * Tabela estática de força das 48 seleções da Copa do Mundo 2026.
 * NÃO existe nenhuma API automatizada para Ranking FIFA, ELO ou Valor de
 * Mercado no pipeline atual do WinMetrics — estes dados são mantidos
 * manualmente aqui.
 *
 * FONTES E DATA DE REFERÊNCIA (não inventado — pesquisado e datado):
 *
 *   fifaRank  — Ranking FIFA oficial de TODAS as 48 seleções classificadas,
 *               divulgado em 11/06/2026 (dia de abertura do torneio).
 *               Fonte: FIFA/Coca-Cola Men's World Ranking via
 *               https://blog.wego.com/fifa-world-cup-rankings/ (atualizado
 *               17/06/2026, cruzado com ESPN e Wikipedia).
 *               → Confiável para TODAS as 48 seleções.
 *
 *   elo       — World Football Elo Rating (eloratings.net). Só temos o
 *               TOP 20 mundial verificado, snapshot de 19/01/2026
 *               (Wikipedia: World_Football_Elo_Ratings). Times fora do
 *               top 20 ficam com elo:null — o motor de scoring PULA o
 *               critério ELO quando algum dos dois lados está null, em vez
 *               de estimar/inventar um valor.
 *               → Atualize este campo manualmente em eloratings.net se quiser
 *                 cobertura completa.
 *
 *   marketValueM — Valor de elenco em € milhões (estilo Transfermarkt).
 *               NÃO temos fonte automatizada nem pesquisada ainda — todos os
 *               valores ficam null até serem preenchidos manualmente.
 *               O motor PULA este critério quando ausente.
 *
 * MANUTENÇÃO:
 *   - Ranking FIFA muda a cada 4-6 semanas (próxima atualização: 20/07/2026).
 *   - Durante a fase de grupos/mata-mata, o ranking oficial NÃO muda — então
 *     esta tabela é válida para todo o torneio 2026.
 *   - Para Elo e Valor de Mercado, edite os campos `elo` / `marketValueM`
 *     manualmente quando tiver os dados.
 *
 * NOMES — usar exatamente como aparecem em fixtures.home_team/away_team
 * (nomenclatura da API-Football). Aliases comuns estão em TEAM_NAME_ALIASES
 * para evitar furo de matching por causa de "USA" vs "United States" etc.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// Fonte: FIFA World Ranking, 11/06/2026 — todos os 48 classificados.
// Fonte ELO: World Football Elo Ratings, top 20 mundial, snapshot 19/01/2026.
const WC_TEAM_POWER = {
  'Argentina':               { fifaRank: 1,  elo: 2113, marketValueM: null },
  'Spain':                   { fifaRank: 2,  elo: 2171, marketValueM: null },
  'France':                  { fifaRank: 3,  elo: 2063, marketValueM: null },
  'England':                 { fifaRank: 4,  elo: 2042, marketValueM: null },
  'Portugal':                { fifaRank: 5,  elo: 1976, marketValueM: null },
  'Brazil':                  { fifaRank: 6,  elo: 1979, marketValueM: null },
  'Morocco':                 { fifaRank: 7,  elo: null, marketValueM: null },
  'Netherlands':             { fifaRank: 8,  elo: 1959, marketValueM: null },
  'Belgium':                 { fifaRank: 9,  elo: 1849, marketValueM: null },
  'Germany':                 { fifaRank: 10, elo: 1910, marketValueM: null },
  'Croatia':                 { fifaRank: 11, elo: 1933, marketValueM: null },
  'Colombia':                { fifaRank: 13, elo: 1998, marketValueM: null },
  'Mexico':                  { fifaRank: 14, elo: null, marketValueM: null },
  'Senegal':                 { fifaRank: 15, elo: 1869, marketValueM: null },
  'Uruguay':                 { fifaRank: 16, elo: 1890, marketValueM: null },
  'USA':                     { fifaRank: 17, elo: null, marketValueM: null },
  'Japan':                   { fifaRank: 18, elo: 1879, marketValueM: null },
  'Switzerland':             { fifaRank: 19, elo: 1897, marketValueM: null },
  'Iran':                    { fifaRank: 20, elo: null, marketValueM: null },
  'Turkey':                  { fifaRank: 22, elo: 1880, marketValueM: null },
  'Ecuador':                 { fifaRank: 23, elo: 1933, marketValueM: null },
  'Austria':                 { fifaRank: 24, elo: null, marketValueM: null },
  'South Korea':             { fifaRank: 25, elo: null, marketValueM: null },
  'Australia':               { fifaRank: 27, elo: null, marketValueM: null },
  'Algeria':                 { fifaRank: 28, elo: null, marketValueM: null },
  'Egypt':                   { fifaRank: 29, elo: null, marketValueM: null },
  'Canada':                  { fifaRank: 30, elo: null, marketValueM: null },
  'Norway':                  { fifaRank: 31, elo: 1922, marketValueM: null },
  'Ivory Coast':             { fifaRank: 33, elo: null, marketValueM: null },
  'Panama':                  { fifaRank: 34, elo: null, marketValueM: null },
  'Sweden':                  { fifaRank: 38, elo: null, marketValueM: null },
  'Czechia':                 { fifaRank: 40, elo: null, marketValueM: null },
  'Paraguay':                { fifaRank: 41, elo: null, marketValueM: null },
  'Scotland':                { fifaRank: 42, elo: null, marketValueM: null },
  'Tunisia':                 { fifaRank: 45, elo: null, marketValueM: null },
  'DR Congo':                { fifaRank: 46, elo: null, marketValueM: null },
  'Uzbekistan':              { fifaRank: 50, elo: null, marketValueM: null },
  'Qatar':                   { fifaRank: 56, elo: null, marketValueM: null },
  'Iraq':                    { fifaRank: 57, elo: null, marketValueM: null },
  'South Africa':            { fifaRank: 60, elo: null, marketValueM: null },
  'Saudi Arabia':            { fifaRank: 61, elo: null, marketValueM: null },
  'Jordan':                  { fifaRank: 63, elo: null, marketValueM: null },
  'Bosnia and Herzegovina':  { fifaRank: 64, elo: null, marketValueM: null },
  'Cape Verde':              { fifaRank: 67, elo: null, marketValueM: null },
  'Ghana':                   { fifaRank: 73, elo: null, marketValueM: null },
  'Curacao':                 { fifaRank: 82, elo: null, marketValueM: null },
  'Haiti':                   { fifaRank: 83, elo: null, marketValueM: null },
  'New Zealand':             { fifaRank: 85, elo: null, marketValueM: null },
};

// Apelidos comuns que a API-Football / fixtures.home_team podem usar e que
// divergem do nome "oficial" usado na tabela acima. Mapeia variante → chave canônica.
const TEAM_NAME_ALIASES = {
  'United States':            'USA',
  'United States of America': 'USA',
  'Korea Republic':           'South Korea',
  'Korea':                    'South Korea',
  'IR Iran':                  'Iran',
  'Türkiye':                  'Turkey',
  'Côte d\'Ivoire':           'Ivory Coast',
  'Cote d\'Ivoire':           'Ivory Coast',
  'Congo DR':                 'DR Congo',
  'Democratic Republic of the Congo': 'DR Congo',
  'Bosnia & Herzegovina':     'Bosnia and Herzegovina',
  'Bosnia-Herzegovina':       'Bosnia and Herzegovina',
  'Czech Republic':           'Czechia',
  'Curaçao':                  'Curacao',
};

/**
 * getTeamPower(teamName)
 * Retorna { fifaRank, elo, marketValueM } para o nome do time, resolvendo
 * apelidos conhecidos. Retorna valores null se o time não estiver na tabela
 * (ex: nome grafado de forma inesperada) — o motor de scoring trata isso
 * pulando os critérios correspondentes, nunca inventando número.
 */
function getTeamPower(teamName) {
  if (!teamName) return { fifaRank: null, elo: null, marketValueM: null };
  const canonical = TEAM_NAME_ALIASES[teamName] || teamName;
  return WC_TEAM_POWER[canonical] || { fifaRank: null, elo: null, marketValueM: null };
}

module.exports = { WC_TEAM_POWER, TEAM_NAME_ALIASES, getTeamPower };
