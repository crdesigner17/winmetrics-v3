/**
 * WinMetrics V3 — enrichFromWorldCup()
 * ─────────────────────────────────────────────────────────────────────────────
 * Enriquece o objeto `raw` do PackBallMapper com dados históricos da Copa do
 * Mundo (Fjelstul DB 1930–2022) para jogos com league_id = 1 (FIFA World Cup).
 *
 * Só preenche campos que estiverem null — nunca sobrescreve dados da API.
 *
 * Estratégia de lookup (fallback em cascata):
 *   1. Home team  → busca stats do time da casa
 *   2. Away team  → busca stats do time visitante
 *   3. Média H+A  → campos combinados (ex: avg_cards, over15_g)
 *
 * Campos preenchidos:
 *   over15_g, over25_g         → média dos dois times
 *   btts_h, btts_a             → btts_avg de cada time
 *   over05_ht                  → média dos dois times
 *   avg_cards, over25_cards,   → média dos dois times
 *   over35_cards
 *   ppg_h, ppg_a               → ppg de cada time
 *   avg_sc_h, avg_sc_a         → avg_gf de cada time (score médio)
 *
 * Uso no generate_predictions.js:
 *   // Após: const raw = PackBallMapper.mapFixtureToPackBall(apiData);
 *   const raw = await enrichFromWorldCup(raw, supabase, LOG);
 *   // Antes: const result = PredictionEngine.processFixture(raw);
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const WC_LEAGUE_ID = 1;

/**
 * enrichFromWorldCup(raw, supabase, LOG)
 *
 * @param {object} raw       — objeto PackBall mapeado (será mutado in-place)
 * @param {object} supabase  — cliente Supabase já inicializado
 * @param {object} [LOG]     — logger opcional ({ info, dim, warn })
 * @returns {object}         — raw enriquecido (mesma referência)
 */
async function enrichFromWorldCup(raw, supabase, LOG = {}) {
  const log = {
    info: LOG.info || (() => {}),
    dim:  LOG.dim  || (() => {}),
    warn: LOG.warn || (() => {}),
  };

  // Só enriquece jogos da Copa do Mundo
  if (Number(raw.league_id) !== WC_LEAGUE_ID) return raw;

  const homeTeam = raw.home_team;
  const awayTeam = raw.away_team;

  if (!homeTeam || !awayTeam) return raw;
  if (!supabase?.from) {
    log.dim('enrichFromWorldCup: Supabase nao configurado; enriquecimento WC ignorado.');
    return raw;
  }

  // Busca os dois times em uma única query
  const { data: rows, error } = await supabase
    .from('wc_team_enrichment')
    .select('*')
    .in('api_team_name', [homeTeam, awayTeam]);

  if (error) {
    log.warn(`enrichFromWorldCup: erro ao consultar Supabase — ${error.message}`);
    return raw;
  }

  if (!rows || rows.length === 0) {
    log.dim(`enrichFromWorldCup: sem dados para "${homeTeam}" e "${awayTeam}"`);
    return raw;
  }

  const homeData = rows.find(r => r.api_team_name === homeTeam) || null;
  const awayData = rows.find(r => r.api_team_name === awayTeam) || null;

  const foundTeams = rows.map(r => `${r.api_team_name}(last_wc=${r.last_wc})`).join(', ');
  log.info(`enrichFromWorldCup: dados WC encontrados — ${foundTeams}`);

  // ── Helper: preenche campo raw apenas se null ─────────────────
  const fill = (field, value) => {
    if (raw[field] === null || raw[field] === undefined) {
      raw[field] = value;
    }
  };

  // ── Campos que usam média H+A ─────────────────────────────────
  const avg2 = (fieldH, fieldA) => {
    const h = homeData?.[fieldH] ?? null;
    const a = awayData?.[fieldA] ?? null;
    if (h !== null && a !== null) return Math.round(((h + a) / 2) * 10) / 10;
    return h ?? a ?? null;
  };

  // ── Preenche campos null no raw ───────────────────────────────

  // Gols
  fill('over15_g',   avg2('over15_g', 'over15_g'));
  fill('over25_g',   avg2('over25_g', 'over25_g'));

  // BTTS por time
  if (homeData) fill('btts_h', homeData.btts_avg);
  if (awayData) fill('btts_a', awayData.btts_avg);

  // Over 0.5 HT
  fill('over05_ht', avg2('over05_ht', 'over05_ht'));

  // Cartões
  fill('avg_cards',    avg2('avg_cards',    'avg_cards'));
  fill('over25_cards', avg2('over25_cards', 'over25_cards'));
  fill('over35_cards', avg2('over35_cards', 'over35_cards'));

  // PPG
  if (homeData) fill('ppg_h', homeData.ppg);
  if (awayData) fill('ppg_a', awayData.ppg);

  // Score médio (avg_sc = avg_gf no Fjelstul)
  if (homeData) fill('avg_sc_h', homeData.avg_gf);
  if (awayData) fill('avg_sc_a', awayData.avg_gf);

  // Log do que foi preenchido
  const filled = [
    'over15_g','over25_g','btts_h','btts_a','over05_ht',
    'avg_cards','over25_cards','over35_cards','ppg_h','ppg_a',
    'avg_sc_h','avg_sc_a',
  ].filter(f => raw[f] !== null && raw[f] !== undefined);

  log.dim(`enrichFromWorldCup: ${filled.length} campos preenchidos — ${filled.join(', ')}`);

  return raw;
}

module.exports = { enrichFromWorldCup };


