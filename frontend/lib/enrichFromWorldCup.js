/**
 * WinMetrics V3 â€” enrichFromWorldCup()
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * Enriquece o objeto `raw` do PackBallMapper com dados histÃ³ricos da Copa do
 * Mundo (Fjelstul DB 1930â€“2022) para jogos com league_id = 1 (FIFA World Cup).
 *
 * SÃ³ preenche campos que estiverem null â€” nunca sobrescreve dados da API.
 *
 * EstratÃ©gia de lookup (fallback em cascata):
 *   1. Home team  â†’ busca stats do time da casa
 *   2. Away team  â†’ busca stats do time visitante
 *   3. MÃ©dia H+A  â†’ campos combinados (ex: avg_cards, over15_g)
 *
 * Campos preenchidos:
 *   over15_g, over25_g         â†’ mÃ©dia dos dois times
 *   btts_h, btts_a             â†’ btts_avg de cada time
 *   over05_ht                  â†’ mÃ©dia dos dois times
 *   avg_cards, over25_cards,   â†’ mÃ©dia dos dois times
 *   over35_cards
 *   ppg_h, ppg_a               â†’ ppg de cada time
 *   avg_sc_h, avg_sc_a         â†’ avg_gf de cada time (score mÃ©dio)
 *
 * Uso no generate_predictions.js:
 *   // ApÃ³s: const raw = PackBallMapper.mapFixtureToPackBall(apiData);
 *   const raw = await enrichFromWorldCup(raw, supabase, LOG);
 *   // Antes: const result = PredictionEngine.processFixture(raw);
 *
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 */

'use strict';

const WC_LEAGUE_ID = 1;

/**
 * enrichFromWorldCup(raw, supabase, LOG)
 *
 * @param {object} raw       â€” objeto PackBall mapeado (serÃ¡ mutado in-place)
 * @param {object} supabase  â€” cliente Supabase jÃ¡ inicializado
 * @param {object} [LOG]     â€” logger opcional ({ info, dim, warn })
 * @returns {object}         â€” raw enriquecido (mesma referÃªncia)
 */
async function enrichFromWorldCup(raw, supabase, LOG = {}) {
  const log = {
    info: LOG.info || (() => {}),
    dim:  LOG.dim  || (() => {}),
    warn: LOG.warn || (() => {}),
  };

  // SÃ³ enriquece jogos da Copa do Mundo
  if (Number(raw.league_id) !== WC_LEAGUE_ID) return raw;

  const homeTeam = raw.home_team;
  const awayTeam = raw.away_team;

  if (!homeTeam || !awayTeam) return raw;
  if (!supabase?.from) {
    log.dim('enrichFromWorldCup: Supabase nao configurado; enriquecimento WC ignorado.');
    return raw;
  }

  // Busca os dois times em uma Ãºnica query
  const { data: rows, error } = await supabase
    .from('wc_team_enrichment')
    .select('*')
    .in('api_team_name', [homeTeam, awayTeam]);

  if (error) {
    log.warn(`enrichFromWorldCup: erro ao consultar Supabase â€” ${error.message}`);
    return raw;
  }

  if (!rows || rows.length === 0) {
    log.dim(`enrichFromWorldCup: sem dados para "${homeTeam}" e "${awayTeam}"`);
    return raw;
  }

  const homeData = rows.find(r => r.api_team_name === homeTeam) || null;
  const awayData = rows.find(r => r.api_team_name === awayTeam) || null;

  const foundTeams = rows.map(r => `${r.api_team_name}(last_wc=${r.last_wc})`).join(', ');
  log.info(`enrichFromWorldCup: dados WC encontrados â€” ${foundTeams}`);

  // â”€â”€ Helper: preenche campo raw apenas se null â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const fill = (field, value) => {
    if (raw[field] === null || raw[field] === undefined) {
      raw[field] = value;
    }
  };

  // â”€â”€ Campos que usam mÃ©dia H+A â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const avg2 = (fieldH, fieldA) => {
    const h = homeData?.[fieldH] ?? null;
    const a = awayData?.[fieldA] ?? null;
    if (h !== null && a !== null) return Math.round(((h + a) / 2) * 10) / 10;
    return h ?? a ?? null;
  };

  // â”€â”€ Preenche campos null no raw â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // Gols
  fill('over15_g',   avg2('over15_g', 'over15_g'));
  fill('over25_g',   avg2('over25_g', 'over25_g'));

  // BTTS por time
  if (homeData) fill('btts_h', homeData.btts_avg);
  if (awayData) fill('btts_a', awayData.btts_avg);

  // Over 0.5 HT
  fill('over05_ht', avg2('over05_ht', 'over05_ht'));

  // CartÃµes
  fill('avg_cards',    avg2('avg_cards',    'avg_cards'));
  fill('over25_cards', avg2('over25_cards', 'over25_cards'));
  fill('over35_cards', avg2('over35_cards', 'over35_cards'));

  // PPG
  if (homeData) fill('ppg_h', homeData.ppg);
  if (awayData) fill('ppg_a', awayData.ppg);

  // Score mÃ©dio (avg_sc = avg_gf no Fjelstul)
  if (homeData) fill('avg_sc_h', homeData.avg_gf);
  if (awayData) fill('avg_sc_a', awayData.avg_gf);

  // Log do que foi preenchido
  const filled = [
    'over15_g','over25_g','btts_h','btts_a','over05_ht',
    'avg_cards','over25_cards','over35_cards','ppg_h','ppg_a',
    'avg_sc_h','avg_sc_a',
  ].filter(f => raw[f] !== null && raw[f] !== undefined);

  log.dim(`enrichFromWorldCup: ${filled.length} campos preenchidos â€” ${filled.join(', ')}`);

  return raw;
}

module.exports = { enrichFromWorldCup };


