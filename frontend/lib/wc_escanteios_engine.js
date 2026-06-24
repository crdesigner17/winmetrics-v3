/**
 * WinMetrics V3 — Motor WC Escanteios (Copa do Mundo 2026)
 * ─────────────────────────────────────────────────────────────────────────────
 * Calcula previsões de mercados de escanteios EXCLUSIVAMENTE para jogos da
 * Copa do Mundo. Substitui completamente a lógica padrão para esses jogos.
 *
 * Mercados:
 *   Over 7.5 | Over 8.5 | Over 9.5 | Over 10.5 | Under 10.5 | Under 11.5
 *
 * Pesos (100 pts total):
 *   Média total escanteios       — 15
 *   Escanteios a favor           — 12
 *   Escanteios contra            — 10
 *   Frequência Over últimos 10   — 12
 *   Frequência Over últimos 5    — 10
 *   Volume ofensivo              — 10
 *   Finalizações                 —  8
 *   Posse ofensiva               —  8
 *   Necessidade de vitória       —  8
 *   Necessidade de saldo         —  5
 *   Diferença técnica            —  4
 *   EV                           —  6
 *   Odds (validação)             —  2
 *   Total: 100
 *
 * Usado por: generate_predictions.js → grava em wc_escanteios_snapshots
 */

'use strict';

const { getTeamPower }                           = require('../data/wc_team_power.js');
const { getFifaRank, calculateFifaRankingScore } = require('../data/wc_fifa_ranking.js');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────────────────

const MARKETS = ['over75', 'over85', 'over95', 'over105', 'under105', 'under115'];

const MARKET_LABELS = {
  over75:   'Over 7.5 Escanteios',
  over85:   'Over 8.5 Escanteios',
  over95:   'Over 9.5 Escanteios',
  over105:  'Over 10.5 Escanteios',
  under105: 'Under 10.5 Escanteios',
  under115: 'Under 11.5 Escanteios',
};

const MIN_ODD = {
  over75:   1.25,
  over85:   1.40,
  over95:   1.60,
  over105:  1.80,
  under105: 1.35,
  under115: 1.25,
};

const MIN_PROB = {
  over75:   75,
  over85:   70,
  over95:   65,
  over105:  60,
  under105: 70,
  under115: 75,
};

// Thresholds de confiança (todos usam o padrão geral)
const CONFIDENCE_THRESHOLDS = {
  elite:    85,
  alta:     75,
  moderada: 65,
};

// Médias combinadas mínimas por mercado
const MIN_AVG_COMBINED = {
  over75:   8.0,
  over85:   9.0,
  over95:   10.0,
  over105:  11.0,
  under105: null,
  under115: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(v, min = 0, max = 100) {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  return Math.max(min, Math.min(max, v));
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBSCORES (0-100 cada)
// ─────────────────────────────────────────────────────────────────────────────

/** 1. Média total de escanteios combinada — 15 pts */
function scoreAvgTotal(avgCornH, avgCornA) {
  if (avgCornH === null || avgCornA === null) return null;
  const avg = avgCornH + avgCornA;
  // Escala: 0 = 0, 14+ = 100
  return clamp((avg / 14.0) * 100);
}

/** 2. Escanteios a favor (combinado) — 12 pts */
function scoreAFavor(avgCornH, avgCornA) {
  if (avgCornH === null || avgCornA === null) return null;
  const avg = (avgCornH + avgCornA) / 2;
  return clamp((avg / 7.0) * 100);
}

/** 3. Escanteios contra (combinado) — 10 pts */
function scoreContra(avgConcCornH, avgConcCornA) {
  if (avgConcCornH === null || avgConcCornA === null) return null;
  const avg = (avgConcCornH + avgConcCornA) / 2;
  // Mais escanteios sofridos = mais pressão recebida = mais escanteios no total
  return clamp((avg / 6.0) * 100);
}

/** 4. Frequência Over últimos 10 jogos — 12 pts */
function scoreFreq10(freqH10, freqA10) {
  if (freqH10 === null && freqA10 === null) return null;
  const vals = [freqH10, freqA10].filter(v => v !== null);
  return clamp(vals.reduce((s, v) => s + v, 0) / vals.length);
}

/** 5. Frequência Over últimos 5 jogos — 10 pts */
function scoreFreq5(freqH5, freqA5) {
  if (freqH5 === null && freqA5 === null) return null;
  const vals = [freqH5, freqA5].filter(v => v !== null);
  return clamp(vals.reduce((s, v) => s + v, 0) / vals.length);
}

/** 6. Volume ofensivo (ataques) — 10 pts */
function scoreVolumeOfensivo(ppgH, ppgA, avgScH, avgScA) {
  // Proxy: combina PPG e média de gols como indicadores de pressão ofensiva
  if (ppgH === null && ppgA === null) return null;
  const vals = [ppgH, ppgA].filter(v => v !== null);
  const ppgAvg = vals.reduce((s, v) => s + v, 0) / vals.length;
  const ppgScore = clamp((ppgAvg / 3.0) * 100);

  if (avgScH !== null && avgScA !== null) {
    const goalScore = clamp(((avgScH + avgScA) / 4.0) * 100);
    return clamp((ppgScore * 0.6 + goalScore * 0.4));
  }
  return ppgScore;
}

/** 7. Finalizações (proxy via PPG ofensivo) — 8 pts */
function scoreFinalizacoes(ppgH, ppgA) {
  if (ppgH === null && ppgA === null) return null;
  const vals = [ppgH, ppgA].filter(v => v !== null);
  const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
  return clamp((avg / 3.0) * 100);
}

/** 8. Posse ofensiva — 8 pts */
function scorePosseOfensiva(powerH, powerA) {
  // Proxy: quanto maior o valor de elenco, maior a posse ofensiva esperada
  if (!powerH?.marketValueM || !powerA?.marketValueM) return null;
  const total = powerH.marketValueM + powerA.marketValueM;
  // Maior diferença = um time domina = menos escanteios totais
  // Partida equilibrada = mais escanteios (ambos pressionam)
  const balance = 1 - Math.abs(powerH.marketValueM - powerA.marketValueM) / total;
  return clamp(balance * 100);
}

/** 9. Necessidade de vitória — 8 pts */
function scoreNecessidadeVitoria(ctxHome, ctxAway) {
  let score = 40;
  if (ctxHome?.needsWin || ctxAway?.needsWin)           score += 40;
  if (ctxHome?.alreadyQualifiedNoStakes && ctxAway?.alreadyQualifiedNoStakes) score -= 30;
  if (ctxHome?.friendly || ctxAway?.friendly)            score -= 35;
  return clamp(score);
}

/** 10. Necessidade de saldo — 5 pts */
function scoreNecessidadeSaldo(ctxHome, ctxAway) {
  if (ctxHome?.goaldiffNeeded || ctxAway?.goaldiffNeeded) return 90;
  if (ctxHome?.needsWin || ctxAway?.needsWin)             return 60;
  return 35;
}

/** 11. Diferença técnica — 4 pts */
function scoreDiferencaTecnica(rankH, rankA, powerH, powerA) {
  const rankScore = calculateFifaRankingScore(rankH, rankA);
  let techScore = 50;
  if (powerH?.marketValueM && powerA?.marketValueM) {
    const ratio = Math.max(powerH.marketValueM, powerA.marketValueM) /
                  Math.min(powerH.marketValueM, powerA.marketValueM);
    // Jogo equilibrado = mais escanteios (ambos tentam mais)
    // Desequilibrado = favorito controla = menos escanteios
    techScore = clamp(100 - (ratio - 1) * 15);
  }
  return clamp((rankScore * 0.4 + techScore * 0.6));
}

/** EV score — 6 pts */
function scoreEv(prob, odd) {
  if (prob === null || odd === null || odd <= 1) return null;
  const ev = (prob / 100) * odd;
  if (ev >= 1.20) return 100;
  if (ev >= 1.10) return 80;
  if (ev >= 1.05) return 60;
  if (ev >= 1.00) return 30;
  return 0;
}

/** Odd como validação — 2 pts */
function scoreOddValidation(odd, minOdd) {
  if (odd === null || odd <= 1) return null;
  if (odd < minOdd) return 0;
  return clamp((odd / (minOdd * 1.5)) * 70);
}

// ─────────────────────────────────────────────────────────────────────────────
// FREQUÊNCIA ESTIMADA DE ESCANTEIOS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estima frequência Over N escanteios usando média combinada.
 * Aproximação via distribuição Poisson.
 */
function estimateCornerOverFreq(avgTotal, threshold) {
  if (avgTotal === null || avgTotal <= 0) return null;
  // P(X >= threshold+1) usando Poisson com lambda = avgTotal
  let probUnder = 0;
  const lambda = avgTotal;
  for (let k = 0; k <= threshold; k++) {
    probUnder += (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
  }
  return clamp((1 - probUnder) * 100);
}

function estimateCornerUnderFreq(avgTotal, threshold) {
  if (avgTotal === null || avgTotal <= 0) return null;
  // P(X <= threshold)
  let prob = 0;
  const lambda = avgTotal;
  for (let k = 0; k <= threshold; k++) {
    prob += (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
  }
  return clamp(prob * 100);
}

function factorial(n) {
  if (n <= 1) return 1;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// AGREGAÇÃO
// ─────────────────────────────────────────────────────────────────────────────

const WEIGHTS = {
  avgTotal:    15,
  aFavor:      12,
  contra:      10,
  freq10:      12,
  freq5:       10,
  volume:      10,
  finalizacoes: 8,
  posse:        8,
  necessidade:  8,
  saldo:        5,
  tecnica:      4,
  ev:           6,
  odd:          2,
};

function aggregateScore(subscores) {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const s = subscores[key];
    if (s !== null && s !== undefined && !Number.isNaN(s)) {
      weightedSum += s * weight;
      totalWeight += weight;
    }
  }
  if (totalWeight < 20) return null;
  return clamp(weightedSum / totalWeight);
}

/**
 * Ajusta o score base para cada mercado específico.
 */
function adjustScoreForMarket(baseScore, market, avgCornTotal) {
  if (baseScore === null) return null;

  switch (market) {
    case 'over75':
      // Mais fácil — threshold baixo
      return clamp(baseScore * 1.05);

    case 'over85':
      return baseScore;

    case 'over95':
      // Mais exigente
      if (avgCornTotal !== null && avgCornTotal < 9.5) return clamp(baseScore * 0.85);
      return clamp(baseScore * 0.95);

    case 'over105':
      // Muito exigente
      if (avgCornTotal !== null && avgCornTotal < 10.5) return clamp(baseScore * 0.75);
      return clamp(baseScore * 0.90);

    case 'under105':
      // Inverso dos overs — score alto quando média baixa
      if (avgCornTotal !== null) {
        const underBonus = avgCornTotal < 9 ? 20 : avgCornTotal < 10.5 ? 10 : -10;
        return clamp(100 - baseScore * 0.6 + underBonus);
      }
      return clamp(100 - baseScore * 0.65);

    case 'under115':
      // Mais fácil que under 10.5
      if (avgCornTotal !== null) {
        const underBonus = avgCornTotal < 10 ? 20 : avgCornTotal < 11.5 ? 10 : -5;
        return clamp(100 - baseScore * 0.55 + underBonus);
      }
      return clamp(100 - baseScore * 0.60);

    default:
      return baseScore;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROBABILIDADE
// ─────────────────────────────────────────────────────────────────────────────

function scoreToProbability(score, market, avgCornTotal) {
  if (score === null) return 50;

  // Usa Poisson quando temos média disponível — mais preciso
  if (avgCornTotal !== null && avgCornTotal > 0) {
    let poissonProb = null;
    switch (market) {
      case 'over75':   poissonProb = estimateCornerOverFreq(avgCornTotal, 7);  break;
      case 'over85':   poissonProb = estimateCornerOverFreq(avgCornTotal, 8);  break;
      case 'over95':   poissonProb = estimateCornerOverFreq(avgCornTotal, 9);  break;
      case 'over105':  poissonProb = estimateCornerOverFreq(avgCornTotal, 10); break;
      case 'under105': poissonProb = estimateCornerUnderFreq(avgCornTotal, 10); break;
      case 'under115': poissonProb = estimateCornerUnderFreq(avgCornTotal, 11); break;
    }
    if (poissonProb !== null) {
      // Mistura: 50% Poisson + 50% score do motor
      return Math.round(poissonProb * 0.5 + score * 0.5);
    }
  }

  return Math.round(score);
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIANÇA
// ─────────────────────────────────────────────────────────────────────────────

function getConfidence(prob) {
  if (prob >= CONFIDENCE_THRESHOLDS.elite)    return { confidence: 'Elite',     grade: 'A+' };
  if (prob >= CONFIDENCE_THRESHOLDS.alta)     return { confidence: 'Alta',      grade: 'A'  };
  if (prob >= CONFIDENCE_THRESHOLDS.moderada) return { confidence: 'Moderada',  grade: 'B'  };
  return                                             { confidence: 'Arriscado', grade: 'C'  };
}

// ─────────────────────────────────────────────────────────────────────────────
// H2H — média de escanteios
// ─────────────────────────────────────────────────────────────────────────────

function h2hAvgCorners(h2hGames) {
  if (!h2hGames?.length) return null;
  const last10 = h2hGames.slice(-10);
  const totals = last10
    .map(g => num(g?.statistics?.corners_total) ?? num(g?.corners_total))
    .filter(v => v !== null && v >= 0);
  if (!totals.length) return null;
  return totals.reduce((s, v) => s + v, 0) / totals.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÃO PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} input
 * @param {object} input.raw              — objeto mapeado pelo PackBallMapper
 * @param {string} [input.homeFormString] — string de forma bruta
 * @param {string} [input.awayFormString]
 * @param {Array}  [input.h2hGames]       — lista de jogos H2H da API
 * @param {object} [input.manualContext]  — wc_manual_context.json.teams
 * @param {object} [input.odds]           — { over75, over85, over95, over105, under105, under115 }
 *
 * @returns {object} — previsão para todos os mercados de escanteios
 */
function computeWcEscanteios(input = {}) {
  const {
    raw = {},
    homeFormString = null,
    awayFormString = null,
    h2hGames = [],
    manualContext = {},
    odds = {},
  } = input;

  const homeTeam = raw?.home_team || '';
  const awayTeam = raw?.away_team || '';

  const powerHome = getTeamPower(homeTeam);
  const powerAway = getTeamPower(awayTeam);
  const rankHome  = getFifaRank(homeTeam);
  const rankAway  = getFifaRank(awayTeam);

  const ctxHome = manualContext[homeTeam] || {};
  const ctxAway = manualContext[awayTeam] || {};

  // ── Dados brutos ───────────────────────────────────────────────────────────
  // Média total de escanteios (campo combinado do pipeline)
  // O pipeline grava avg_corners (total) e over75_corners (frequência Over 7.5)
  const avgCornTotal = num(raw?.avg_corners)
    ?? num(raw?.avg_corners_total)
    ?? (num(raw?.avg_sc_h) !== null && num(raw?.avg_sc_a) !== null
        ? null // não usa gols como proxy para cantos
        : null);

  // Divide a média total em home/away (estimativa 50/50 quando não há separado)
  const avgCornH = num(raw?.avg_corners_h) ?? num(raw?.avg_corners_home)
    ?? (avgCornTotal !== null ? avgCornTotal / 2 : null);
  const avgCornA = num(raw?.avg_corners_a) ?? num(raw?.avg_corners_away)
    ?? (avgCornTotal !== null ? avgCornTotal / 2 : null);

  // Escanteios contra (proxy: metade da média total)
  const avgConcCornH = num(raw?.avg_corners_conc_h) ?? (avgCornTotal !== null ? avgCornTotal / 2 : null);
  const avgConcCornA = num(raw?.avg_corners_conc_a) ?? (avgCornTotal !== null ? avgCornTotal / 2 : null);

  // Frequência Over 7.5 — campo 'over75_c' do pipeline (0-100)
  const freqOver75 = num(raw?.over75_c)
    ?? num(raw?.over75_corners_pct)
    ?? (avgCornTotal !== null ? estimateCornerOverFreq(avgCornTotal, 7) : null);

  // Frequência Over 8.5 — campo 'over85_c' ou estimativa Poisson
  const freqOver85 = num(raw?.over85_c)
    ?? (avgCornTotal !== null ? estimateCornerOverFreq(avgCornTotal, 8) : null);

  // Usa mesma frequência para home e away (dados combinados)
  const escFreqH75 = freqOver75;
  const escFreqA75 = freqOver75;
  const escFreqH85 = freqOver85;
  const escFreqA85 = freqOver85;

  // Escanteios H2H
  const h2hCorners = h2hAvgCorners(h2hGames);

  // Média final ajustada com H2H (quando disponível)
  const avgCornFinal = avgCornTotal !== null && h2hCorners !== null
    ? avgCornTotal * 0.7 + h2hCorners * 0.3
    : avgCornTotal;

  // PPG e gols para proxies ofensivos
  const ppgH   = num(raw?.ppg_h);
  const ppgA   = num(raw?.ppg_a);
  const avgScH = num(raw?.avg_sc_h);
  const avgScA = num(raw?.avg_sc_a);

  // ── Subscores base ─────────────────────────────────────────────────────────
  const baseSubs = {
    avgTotal:     scoreAvgTotal(avgCornH, avgCornA),
    aFavor:       scoreAFavor(avgCornH, avgCornA),
    contra:       scoreContra(avgConcCornH, avgConcCornA),
    freq10:       scoreFreq10(escFreqH75, escFreqA75), // usa Over 7.5 como proxy freq10
    freq5:        scoreFreq5(escFreqH85, escFreqA85),  // usa Over 8.5 como proxy freq5
    volume:       scoreVolumeOfensivo(ppgH, ppgA, avgScH, avgScA),
    finalizacoes: scoreFinalizacoes(ppgH, ppgA),
    posse:        scorePosseOfensiva(powerHome, powerAway),
    necessidade:  scoreNecessidadeVitoria(ctxHome, ctxAway),
    saldo:        scoreNecessidadeSaldo(ctxHome, ctxAway),
    tecnica:      scoreDiferencaTecnica(rankHome, rankAway, powerHome, powerAway),
    ev:           null, // calculado por mercado
    odd:          null, // calculado por mercado
  };

  const baseScore = aggregateScore(baseSubs);

  // ── Calcular previsão para cada mercado ────────────────────────────────────
  const results = {};

  for (const market of MARKETS) {
    const odd = odds[market] ?? null;

    const adjustedScore = adjustScoreForMarket(baseScore, market, avgCornFinal);

    const evScore  = scoreEv(adjustedScore, odd);
    const oddScore = scoreOddValidation(odd, MIN_ODD[market]);

    let finalScore = adjustedScore;
    if (evScore  !== null) finalScore = finalScore * 0.94 + evScore  * 0.06;
    if (oddScore !== null) finalScore = finalScore * 0.98 + oddScore * 0.02;
    finalScore = clamp(finalScore);

    const prob = scoreToProbability(finalScore, market, avgCornFinal);
    const ev   = odd !== null && odd > 1 ? Math.round((prob / 100) * odd * 100) / 100 : null;

    const { confidence, grade } = getConfidence(prob);

    // Verifica média mínima para mercados Over
    const minAvg    = MIN_AVG_COMBINED[market];
    const meetsAvg  = minAvg === null || (avgCornFinal !== null && avgCornFinal >= minAvg);
    const meetsProb = prob >= MIN_PROB[market];
    const meetsOdd  = odd === null || odd >= MIN_ODD[market];
    const meetsEv   = ev  === null || ev  >= 1.05;
    const recommended = meetsProb && meetsOdd && meetsEv && meetsAvg;

    results[market] = {
      market:      MARKET_LABELS[market],
      marketKey:   market,
      probability: prob,
      odd,
      ev,
      score:       Math.round(finalScore ?? 0),
      confidence,
      grade,
      recommended,
      meetsMinProb: meetsProb,
      meetsMinOdd:  meetsOdd,
      meetsEv,
    };
  }

  // ── Melhor mercado ─────────────────────────────────────────────────────────
  const recommended = MARKETS
    .map(m => results[m])
    .filter(r => r.recommended)
    .sort((a, b) => {
      const evDiff = (b.ev ?? 0) - (a.ev ?? 0);
      if (Math.abs(evDiff) > 0.05) return evDiff;
      return b.probability - a.probability;
    });

  const bestMarket = recommended[0] ?? null;

  return {
    homeTeam,
    awayTeam,
    markets:    results,
    bestMarket: bestMarket?.marketKey ?? null,
    bestLabel:  bestMarket?.market    ?? null,
    _debug: {
      avgCornTotal,
      avgCornFinal,
      h2hCorners,
      baseScore: Math.round(baseScore ?? 0),
    },
  };
}

module.exports = { computeWcEscanteios, MARKETS, MARKET_LABELS };
