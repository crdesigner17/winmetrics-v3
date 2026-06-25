/**
 * WinMetrics V3 — World Cup Boost
 * ─────────────────────────────────────────────────────────────────────────────
 * Camada adicional especializada em Copa do Mundo.
 * Aplicada SOMENTE quando: raw.league_name === "World: World Cup"
 *
 * NÃO altera:
 *   - prediction_engine principal
 *   - filtros oficiais
 *   - pesos de outras ligas
 *   - classificação A+/A/B/C/D
 *   - snapshots existentes
 *   - banco de dados
 *   - pipeline de outras competições
 *
 * Fórmula do score final:
 *   world_cup_final_score = (0.70 × official_score) + (0.30 × world_cup_score)
 *   Cap: máximo +10 pontos sobre o score oficial. Nunca ultrapassa 100.
 *
 * Mercados beneficiados (aplicação do boost):
 *   over15, over25, btts, under35, under45 — boost integral
 *   esc75, esc85, cards25, cards35         — boost reduzido (×0.5)
 *
 * Uso em generate_predictions.js:
 *   const { applyWorldCupBoost } = require('../lib/world_cup_boost.js');
 *   // Após result = PredictionEngine.processFixture(raw):
 *   if (raw.league_name === 'World: World Cup') {
 *     applyWorldCupBoost(result, raw, LOG);
 *   }
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CONDIÇÃO OBRIGATÓRIA — único valor aceito
// ─────────────────────────────────────────────────────────────────────────────
const WC_LEAGUE_NAME = 'World: World Cup';

// ─────────────────────────────────────────────────────────────────────────────
// 1. RANKING FIFA (Copa do Mundo 2026 — Junho 2026)
// Fonte: ranking FIFA aproximado para a competição
// Posição → strength score
// ─────────────────────────────────────────────────────────────────────────────
const FIFA_RANKS = {
  // Grupo A
  'Brazil':        1,
  'Germany':       4,
  'Japan':        22,
  'Australia':    24,
  // Grupo B
  'Argentina':     2,
  'France':        3,
  'Croatia':       9,
  'Morocco':      14,
  // Grupo C
  'Spain':         7,
  'Portugal':      6,
  'Netherlands':   8,
  'Ecuador':      42,
  // Grupo D
  'England':       5,
  'Colombia':     11,
  'Senegal':      18,
  'Bolivia':      85,
  // Grupo E
  'Mexico':       16,
  'Uruguay':      17,
  'Belgium':      13,
  'Panama':       53,
  // Grupo F
  'United States':23,
  'Serbia':       25,
  'Poland':       27,
  'South Korea':  24,
  // Grupo G
  'Switzerland':  19,
  'Denmark':      21,
  'Cameroon':     36,
  'Guatemala':    82,
  // Grupo H
  'Chile':        30,
  'Nigeria':      35,
  'Peru':         37,
  'New Zealand':  97,
  // Grupo I
  'Canada':       41,
  'Honduras':     73,
  'Algeria':      32,
  'Uzbekistan':   70,
  // Grupo J
  'Italy':        10,
  'Iran':         22,
  'Costa Rica':   54,
  'Curaçao':     101,
  // Grupo K
  'Saudi Arabia': 56,
  'Qatar':        37,
  'Venezuela':    50,
  'Trinidad and Tobago': 98,
  // Grupo L
  'South Africa': 65,
  'Tunisia':      33,
  'China':        87,
  'Haiti':       107,
  // Aliases comuns da API-Football
  'Korea Republic':    24,
  'Korea DPR':        110,
  'USA':               23,
  'United States of America': 23,
  'Ivory Coast':       45,
  "Côte d'Ivoire":     45,
  'DR Congo':          55,
  'Congo DR':          55,
  'Czech Republic':    40,
  'Czechia':           40,
  'Türkiye':           29,
  'Turkey':            29,
  'Iran':              22,
  'IR Iran':           22,
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. VALOR DE MERCADO (ranking aproximado por valor de elenco)
// Top 5 = 100 | Top 10 = 95 | Top 20 = 90 | Restante = 80
// ─────────────────────────────────────────────────────────────────────────────
const MARKET_VALUE_TIER = {
  // Top 5 mais valiosos
  'France':       1,
  'England':      2,
  'Brazil':       3,
  'Germany':      4,
  'Spain':        5,
  // Top 10
  'Portugal':     6,
  'Netherlands':  7,
  'Argentina':    8,
  'Belgium':      9,
  'Italy':       10,
  // Top 20
  'Croatia':     11,
  'Uruguay':     12,
  'Mexico':      13,
  'United States':14,
  'USA':         14,
  'Colombia':    15,
  'Denmark':     16,
  'Switzerland': 17,
  'Serbia':      18,
  'Poland':      19,
  'Japan':       20,
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. HISTÓRICO — Títulos mundiais
// ─────────────────────────────────────────────────────────────────────────────
const WC_TITLES = {
  'Brazil':     5,
  'Germany':    4,
  'Italy':      4,
  'Argentina':  3,
  'France':     2,
  'Uruguay':    2,
  'Spain':      1,
  'England':    1,
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS INTERNOS
// ─────────────────────────────────────────────────────────────────────────────

function clamp(v, min = 0, max = 100) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  return Math.max(min, Math.min(max, Number(v)));
}

function avg(...values) {
  const valid = values.filter(v => v !== null && v !== undefined && Number.isFinite(Number(v)));
  if (!valid.length) return null;
  return valid.reduce((s, v) => s + Number(v), 0) / valid.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÃO 1 — calculateFifaStrength
// ─────────────────────────────────────────────────────────────────────────────
function calculateFifaStrength(teamName) {
  const rank = FIFA_RANKS[teamName];
  if (!rank) return 70; // desconhecido → score neutro

  if (rank <= 5)  return 100;
  if (rank <= 10) return 95;
  if (rank <= 20) return 90;
  if (rank <= 40) return 80;
  if (rank <= 60) return 70;
  if (rank <= 80) return 60;
  return 50;
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÃO 2 — calculateRankingGap
// ─────────────────────────────────────────────────────────────────────────────
function calculateRankingGap(homeTeam, awayTeam) {
  const rankH = FIFA_RANKS[homeTeam];
  const rankA = FIFA_RANKS[awayTeam];

  if (!rankH || !rankA) return 60; // desconhecido → gap médio

  const gap = Math.abs(rankH - rankA);

  if (gap >= 60) return 100;
  if (gap >= 40) return 90;
  if (gap >= 20) return 80;
  if (gap >= 10) return 70;
  return 50;
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÃO 3 — calculateMarketValue
// ─────────────────────────────────────────────────────────────────────────────
function calculateMarketValue(teamName) {
  const tier = MARKET_VALUE_TIER[teamName];
  if (!tier) return 80; // desconhecido → base

  if (tier <= 5)  return 100;
  if (tier <= 10) return 95;
  if (tier <= 20) return 90;
  return 80;
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÃO 4 — calculateHistoryScore
// ─────────────────────────────────────────────────────────────────────────────
function calculateHistoryScore(teamName) {
  const titles = WC_TITLES[teamName] || 0;
  const MAX_TITLES = 5; // Brasil — máximo histórico
  // Escala 0-100, com base nos títulos. Sem títulos = 40 (base neutra baixa).
  if (titles === 0) return 40;
  return Math.min(100, 40 + (titles / MAX_TITLES) * 60);
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÃO 5 — calculateFormScore
// Usa dados do raw (ppg_h, ppg_a, avg_sc_h, avg_sc_a) — já preenchidos
// pelo enrichFromWorldCup ou pela API-Football
// ─────────────────────────────────────────────────────────────────────────────
function calculateFormScore(raw) {
  const ppgH  = clamp(raw.ppg_h,    0, 3);
  const ppgA  = clamp(raw.ppg_a,    0, 3);
  const scH   = clamp(raw.avg_sc_h, 0, 5);
  const scA   = clamp(raw.avg_sc_a, 0, 5);

  // PPG: normaliza 0-3 → 0-100
  const normPpgH = ppgH  !== null ? (ppgH  / 3) * 100 : null;
  const normPpgA = ppgA  !== null ? (ppgA  / 3) * 100 : null;
  // Gols médios: normaliza 0-3 → 0-100 (capped)
  const normScH  = scH   !== null ? Math.min((scH  / 3) * 100, 100) : null;
  const normScA  = scA   !== null ? Math.min((scA  / 3) * 100, 100) : null;

  const combined = avg(normPpgH, normPpgA, normScH, normScA);
  return combined !== null ? clamp(combined) : 65; // fallback neutro
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÃO 6 — calculateOffensivePower
// Usa over15_g, over25_g, exg_h, exg_a do raw
// ─────────────────────────────────────────────────────────────────────────────
function calculateOffensivePower(raw) {
  // over15_g, over25_g: já em % (0-100)
  const o15 = clamp(raw.over15_g !== null ? raw.over15_g * 100 : null);
  const o25 = clamp(raw.over25_g !== null ? raw.over25_g * 100 : null);

  // xG: normaliza 0-4 → 0-100
  const xgH = raw.exg_h !== null && raw.exg_h !== undefined
    ? clamp((Number(raw.exg_h) / 4) * 100)
    : null;
  const xgA = raw.exg_a !== null && raw.exg_a !== undefined
    ? clamp((Number(raw.exg_a) / 4) * 100)
    : null;
  const xgAvg = avg(xgH, xgA);

  const combined = avg(o15, o25, xgAvg);
  return combined !== null ? clamp(combined) : 65;
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÃO 7 — calculateDefensivePower
// Usa under35_g (proxy under 3.5), btts_h, btts_a do raw
// Defensive power é INVERSO — menos gols sofridos = maior score
// ─────────────────────────────────────────────────────────────────────────────
function calculateDefensivePower(raw) {
  // under35 implica jogos com poucas quedas — proxy de defesa sólida
  const u35 = clamp(raw.under35_g !== null && raw.under35_g !== undefined
    ? raw.under35_g * 100 : null);

  // BTTS baixo = defesas sólidas (inverso do btts médio)
  const bttsH = raw.btts_h !== null && raw.btts_h !== undefined ? Number(raw.btts_h) : null;
  const bttsA = raw.btts_a !== null && raw.btts_a !== undefined ? Number(raw.btts_a) : null;
  const bttsAvg = avg(bttsH, bttsA);
  // Inverte: btts 0.3 → defensive 70, btts 0.8 → defensive 20
  const defensiveBtts = bttsAvg !== null
    ? clamp((1 - bttsAvg) * 100)
    : null;

  const combined = avg(u35, defensiveBtts);
  return combined !== null ? clamp(combined) : 60;
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÃO 8 — calculateWorldCupScore
// Combina todos os fatores com os pesos definidos
// ─────────────────────────────────────────────────────────────────────────────
function calculateWorldCupScore(raw) {
  const homeTeam = raw.home_team || '';
  const awayTeam = raw.away_team || '';

  // Scores individuais
  const fifaStrengthH    = calculateFifaStrength(homeTeam);
  const fifaStrengthA    = calculateFifaStrength(awayTeam);
  const fifa_strength_score = avg(fifaStrengthH, fifaStrengthA);

  const ranking_gap_score  = calculateRankingGap(homeTeam, awayTeam);

  const mvH = calculateMarketValue(homeTeam);
  const mvA = calculateMarketValue(awayTeam);
  const market_value_score = avg(mvH, mvA);

  const histH = calculateHistoryScore(homeTeam);
  const histA = calculateHistoryScore(awayTeam);
  const history_score = avg(histH, histA);

  const form_score             = calculateFormScore(raw);
  const offensive_power_score  = calculateOffensivePower(raw);
  const defensive_power_score  = calculateDefensivePower(raw);

  // Composição final do world_cup_score com pesos definidos
  //   20% forma + 20% ofensivo + 15% defensivo + 15% FIFA strength
  //   15% ranking gap + 10% market value + 5% histórico
  const world_cup_score = clamp(
    (form_score             * 0.20) +
    (offensive_power_score  * 0.20) +
    (defensive_power_score  * 0.15) +
    (fifa_strength_score    * 0.15) +
    (ranking_gap_score      * 0.15) +
    (market_value_score     * 0.10) +
    (history_score          * 0.05)
  );

  return {
    fifa_strength_score:   Math.round(fifa_strength_score),
    ranking_gap_score:     Math.round(ranking_gap_score),
    market_value_score:    Math.round(market_value_score),
    history_score:         Math.round(history_score),
    form_score:            Math.round(form_score),
    offensive_power_score: Math.round(offensive_power_score),
    defensive_power_score: Math.round(defensive_power_score),
    world_cup_score:       Math.round(world_cup_score),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÃO PRINCIPAL — applyWorldCupBoost
// Chamada SOMENTE quando raw.league_name === 'World: World Cup'
// Modifica result.scores in-place, recalcula best_score se afetado
// ─────────────────────────────────────────────────────────────────────────────

// ── Prioridade: GOLS é o foco da Copa do Mundo ───────────────────────────────
// Over 1.5 e Over 2.5 → boost máximo + cap maior (+15)
// Under 3.5, Under 4.5, BTTS → boost alto + cap normal (+10)
// Escanteios e Cartões → sem boost (não são o foco da Copa)
const BOOST_GOALS_PRIMARY   = new Set(['over15', 'over25']);           // máximo
const BOOST_GOALS_SECONDARY = new Set(['under35', 'under45', 'btts']); // alto
const BOOST_MARKETS_NONE    = new Set(['esc75', 'esc85', 'cards25', 'cards35']); // zero
const MAX_BOOST_GOALS       = 15; // cap gols primários: até +15 pontos
const MAX_BOOST_POINTS      = 10; // cap demais mercados: até +10 pontos

function applyWorldCupBoost(result, raw, LOG = {}) {
  const log = {
    info: LOG.info || (() => {}),
    dim:  LOG.dim  || (() => {}),
    warn: LOG.warn || (() => {}),
  };

  // ── GUARDA DE SEGURANÇA: só Copa do Mundo ───────────────────────────────
  // Aceita as 3 variações de nome que a API-Football pode retornar:
  //   'FIFA World Cup' (padrão atual), 'World Cup', 'World: World Cup' (legado)
  const WC_LEAGUE_NAMES_ALL = ['World: World Cup', 'FIFA World Cup', 'World Cup'];
  if (!WC_LEAGUE_NAMES_ALL.includes(raw.league_name)) return result;

  // ── Calcula o world_cup_score ───────────────────────────────────────────
  const wcMetrics = calculateWorldCupScore(raw);
  const { world_cup_score } = wcMetrics;

  log.info(`  [WC Boost] ${raw.home_team} x ${raw.away_team}`);
  log.dim(`  [WC Boost] fifa_strength=${wcMetrics.fifa_strength_score} ranking_gap=${wcMetrics.ranking_gap_score} form=${wcMetrics.form_score} ofensivo=${wcMetrics.offensive_power_score} defensivo=${wcMetrics.defensive_power_score} wc_score=${world_cup_score}`);

  // ── Aplica boost em cada mercado elegível ───────────────────────────────
  const boostedScores = {};

  for (const [mkt, originalScore] of Object.entries(result.scores || {})) {
    if (originalScore === null || originalScore === undefined) {
      boostedScores[mkt] = originalScore;
      continue;
    }

    // Escanteios e cartões: sem boost na Copa — não são o foco
    if (BOOST_MARKETS_NONE.has(mkt)) {
      boostedScores[mkt] = originalScore;
      continue;
    }

    // Define fator e cap por categoria
    let boostFactor = 0;
    let maxBoostCap = MAX_BOOST_POINTS;

    if (BOOST_GOALS_PRIMARY.has(mkt)) {
      boostFactor = 1.0;           // Over 1.5 e Over 2.5 → boost máximo
      maxBoostCap = MAX_BOOST_GOALS; // cap maior: +15
    } else if (BOOST_GOALS_SECONDARY.has(mkt)) {
      boostFactor = 0.8;           // Under 3.5, Under 4.5, BTTS → boost alto
      maxBoostCap = MAX_BOOST_POINTS; // cap normal: +10
    } else {
      boostedScores[mkt] = originalScore;
      continue;
    }

    // Fórmula: calcula quanto o wc_score adiciona ao original
    // O boost só é aplicado se for positivo — nunca derruba o score oficial
    const wcContribution = (world_cup_score - originalScore) * 0.30 * boostFactor;
    if (wcContribution <= 0) {
      boostedScores[mkt] = originalScore; // wc_score abaixo do original → mantém
      continue;
    }

    // Cap: não pode aumentar mais que maxBoostCap sobre o original
    const maxAllowed = Math.min(originalScore + maxBoostCap, 100);
    const finalScore = Math.round(Math.min(originalScore + wcContribution, maxAllowed) * 10) / 10;

    boostedScores[mkt] = finalScore;

    if (finalScore !== originalScore) {
      log.dim(`  [WC Boost] ${mkt}: ${originalScore} → ${finalScore} (+${(finalScore - originalScore).toFixed(1)})`);
    }
  }

  // ── Aplica scores boosted no result ────────────────────────────────────
  result.scores = { ...result.scores, ...boostedScores };

  // ── Recalcula best_score se o best_mkt foi afetado ─────────────────────
  if (result.best_mkt) {
    const mktKey = marketNameToKey(result.best_mkt);
    if (mktKey && boostedScores[mktKey] !== undefined) {
      const oldBestScore = result.best_score;
      result.best_score  = boostedScores[mktKey];
      if (result.best_score !== oldBestScore) {
        log.dim(`  [WC Boost] best_score: ${oldBestScore} → ${result.best_score} (${result.best_mkt})`);
      }
    }
  }

  // ── Anexa metadados do boost no result (auditoria, não vai para banco) ──
  result.world_cup_boost = {
    applied:               true,
    ...wcMetrics,
    max_boost_cap:         MAX_BOOST_POINTS,
  };

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — converte nome de mercado do result para chave de scores
// ─────────────────────────────────────────────────────────────────────────────
function marketNameToKey(marketName) {
  const m = String(marketName).toLowerCase().trim();
  if (m === 'over 1.5' || m === 'over 1.5 gols') return 'over15';
  if (m === 'over 2.5' || m === 'over 2.5 gols') return 'over25';
  if (m === 'btts'     || m === 'ambas marcam')   return 'btts';
  if (m === 'under 3.5' || m === 'under 3.5 gols') return 'under35';
  if (m === 'under 4.5' || m === 'under 4.5 gols') return 'under45';
  if (m === 'esc 7.5'  || m === 'over 7.5 escanteios') return 'esc75';
  if (m === 'esc 8.5'  || m === 'over 8.5 escanteios') return 'esc85';
  if (m === 'cart 2.5' || m === 'over 2.5 cartão')     return 'cards25';
  if (m === 'cart 3.5' || m === 'over 3.5 cartão')     return 'cards35';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// VALIDAÇÃO — exemplo de uso e saída esperada
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exemplos esperados (para validação manual):
 *
 * Brasil x Haiti
 *   FIFA ranks: 1 vs 107 → gap=106 → ranking_gap_score=100
 *   fifa_strength: (100+50)/2=75
 *   market_value: (100+80)/2=90
 *   history: (100+40)/2=70
 *   world_cup_score ≈ 83
 *   Over 1.5 original=78 → blended=(0.7×78)+(0.3×83)=79.5 → cap=88 → final=79.5
 *
 * Alemanha x Curaçao
 *   FIFA ranks: 4 vs 101 → gap=97 → ranking_gap_score=100
 *   world_cup_score ≈ 86
 *   Over 1.5 original=72 → blended=(0.7×72)+(0.3×86)=76.2 → cap=82 → final=76.2
 *
 * Espanha x Cabo Verde
 *   FIFA ranks: 7 vs ~100 → gap≈93 → ranking_gap_score=100
 *   world_cup_score ≈ 82
 *   Over 1.5 original=69 → blended=(0.7×69)+(0.3×82)=72.9 → cap=79 → final=72.9
 */

module.exports = {
  applyWorldCupBoost,
  // Exporta funções individuais para testes unitários
  calculateFifaStrength,
  calculateRankingGap,
  calculateMarketValue,
  calculateHistoryScore,
  calculateFormScore,
  calculateOffensivePower,
  calculateDefensivePower,
  calculateWorldCupScore,
  WC_LEAGUE_NAME,
};
